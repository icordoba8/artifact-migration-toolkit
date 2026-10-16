import { readFile } from "node:fs/promises";
import path from "node:path";
import { UI_RUNTIME_STATES } from "../census/index.mjs";
import {
  REQUIRED_OBSERVATIONS_FORMAT,
  UI_PROOF_FORMAT,
  usesUiCoverage,
  usesRequiredObservations,
  usesUiVerification,
} from "../formats/index.mjs";
import {
  assertArray,
  assertIsoTimestamp,
  assertNonEmpty,
  assertPlainObject,
  isContentIdentity,
  isPlainObject,
  sha256Hex as hashContent,
} from "../shared/index.mjs";
import {
  assertEvidenceReference,
  evidencePathClaim,
  readJson,
  resolveEvidencePath,
} from "../store/index.mjs";
import {
  compareAppearanceCoverage,
  assertVisualAcceptance,
  compareVisualEvidence,
} from "./acceptance.mjs";
import {
  assertVisualCaptureBlock,
  assertCaptureRole,
  LEGACY_AUTHORITY_ROLE,
  assertTargetEvidencePath,
  TARGET_VERIFICATION_ROLE,
  visualAuthorityOf,
} from "./authority.mjs";
import { HARDENED_VISUAL_VERSION } from "./evidence.mjs";
import { OBSERVATION_EXPECTED, uiBehaviorIsRequired } from "./observations.mjs";

/** States that legitimately justify capturing a second viewport. */
const UI_VIEWPORT_STATES = new Set(["DESKTOP", "MOBILE"]);

/**
 * Playwright safety: runtime evidence describes what was observed, never what
 * was used to observe it. Anything that reads like a credential is refused
 * before it can be persisted into a migration artifact.
 */
const UI_SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|cookie|authorization|credential|api[_-]?key)/i;

/**
 * Values are matched on credential *shape*, not on vocabulary: prose is allowed
 * to say "the session token expired", but never to carry the token itself.
 */
const UI_SECRET_VALUE_PATTERN =
  /((^|\s)(bearer|basic)\s+\S|(password|passwd|secret|token|credential|api[_-]?key|authorization)\s*[:=]\s*\S)/i;

/** Refuses to persist credential material inside runtime UI evidence. */
const assertNoUiSecret = (value, label) => {
  const walk = (node, trail) => {
    if (typeof node === "string") {
      if (UI_SECRET_VALUE_PATTERN.test(node)) {
        throw new Error(
          `${label}${trail} must not persist credential material in UI evidence.`,
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, item] of Object.entries(node)) {
      if (UI_SECRET_KEY_PATTERN.test(key)) {
        throw new Error(
          `${label}${trail}.${key} must not persist credential material in UI evidence.`,
        );
      }
      walk(item, `${trail}.${key}`);
    }
  };
  walk(value, "");
  return value;
};

// Track A6: `implementationDigests` is the slices-owned, read-only digest of
// the claimed bytes, passed in by the lifecycle seam and called at the same
// point it always was; visual never imports slices.
export const validateUiRuntimeEvidence = async ({
  evidence,
  implementation,
  baseline,
  sliceId,
  state,
  roots,
  root,
  implementationDigests,
}) => {
  if (!usesUiVerification(state) || !baseline.legacy.hasVisibleUi) return [];
  if (!usesRequiredObservations(state)) {
    throw new Error(
      // No CLI flag is named here any more. At or above the upgrade floor the
      // engine's own FORMAT_UPGRADE target owns the transition and the normal
      // command reports the required input, so this states the frozen fact and
      // leaves the dispatch to the one place that decides it.
      `Visible UI needs format-${REQUIRED_OBSERVATIONS_FORMAT} requiredObservations before VERIFY_SLICES or FINALIZE can PASS; this record is at format ${state.formatVersion}. Rerun '/start-migration ${state.migrationId}' and supply the input its FORMAT UPGRADE REQUIRED report names. TARGET proof cannot supply the contract.`,
    );
  }
  const parityIds = new Set(implementation.traceIds);
  const mismatchByBehavior = new Map(
    baseline.target.uiMismatches.map((row) => [row.uiBehaviorId, row]),
  );
  const required = baseline.legacy.uiBehaviors.filter((uiBehavior) => {
    const parityRow = baseline.behaviorRows.find(
      (row) => row.behaviorId === uiBehavior.behaviorId,
    );
    return (
      parityRow &&
      parityIds.has(parityRow.id) &&
      uiBehaviorIsRequired(uiBehavior, mismatchByBehavior.get(uiBehavior.id))
    );
  });
  const records = assertArray(evidence.uiEvidence, `${sliceId} UI evidence`);
  const limitations = assertArray(
    evidence.uiEvidenceLimitations,
    `${sliceId} UI evidence limitations`,
  );
  for (const [index, limitation] of limitations.entries()) {
    const label = `${sliceId} UI evidence limitations[${index}]`;
    assertPlainObject(limitation, label);
    // A limitation states *why* the runtime could not answer. It is not a
    // waiver: the required-state sweep below still refuses to pass.
    if (limitation.availability !== "NOT_AVAILABLE") {
      throw new Error(`${label}.availability must be 'NOT_AVAILABLE'.`);
    }
    assertNonEmpty(limitation.uiBehaviorId, `${label}.uiBehaviorId`);
    assertNonEmpty(limitation.state, `${label}.state`);
    assertNonEmpty(limitation.reason, `${label}.reason`);
    assertNoUiSecret(limitation, label);
  }
  const implementationBinding = await implementationDigests(
    implementation,
    roots,
  );
  // Screenshot budget: one capture per observed state, never a second copy of
  // the same picture. Bounded by the contract itself, not by a magic number.
  const screenshotSlots = new Set();
  const screenshotHashes = new Set();
  const visualComparison = [];
  const appearanceEvidence = new Map();
  const comparedVisualRows = new Set();
  let baselineViewport = null;
  const exercised = new Set();
  const satisfiedPostActions = new Set();
  for (const [index, record] of records.entries()) {
    const label = `${sliceId} UI evidence[${index}]`;
    assertPlainObject(record, label);
    assertNoUiSecret(record, label);
    if (record.provider !== "playwright") {
      throw new Error(`${label}.provider must be 'playwright'.`);
    }
    const origin = record.origin ?? "TARGET";
    if (origin !== "LEGACY" && origin !== "TARGET") {
      throw new Error(`${label}.origin must be 'LEGACY' or 'TARGET'.`);
    }
    assertNonEmpty(record.producer, `${label}.producer`);
    assertNonEmpty(record.environment, `${label}.environment`);
    assertNonEmpty(record.route, `${label}.route`);
    assertIsoTimestamp(record.executedAt, `${label}.executedAt`);
    if (record.result !== "PASS") {
      throw new Error(`${label}.result must be PASS.`);
    }
    if (!UI_RUNTIME_STATES.has(record.state)) {
      throw new Error(`${label}.state '${record.state}' is not supported.`);
    }
    const uiBehavior = required.find((item) => item.id === record.uiBehaviorId);
    if (!uiBehavior || !uiBehavior.runtimeStates.includes(record.state)) {
      throw new Error(
        `${label} does not name a required state for UI behavior '${record.uiBehaviorId}'.`,
      );
    }
    const appearanceClaim = usesUiCoverage(state)
      ? uiBehavior.requiredAppearance.find((claim) => claim.id === record.appearanceClaimId && claim.state === record.state)
      : null;
    if (usesUiCoverage(state) && !appearanceClaim) {
      throw new Error(`${label}.appearanceClaimId must name a required appearance claim of '${uiBehavior.id}' state '${record.state}'.`);
    }
    const viewport = assertPlainObject(record.viewport, `${label}.viewport`);
    for (const axis of ["width", "height"]) {
      if (!Number.isInteger(viewport[axis]) || viewport[axis] <= 0) {
        throw new Error(
          `${label}.viewport.${axis} must be a positive integer.`,
        );
      }
    }
    // Format 17: a Figma-backed TARGET state is accepted by the engine's own
    // comparison, never by the row's authored `result`.
    const visualRow = origin === "TARGET"
      ? baseline.visualRows?.find((row) => usesUiCoverage(state)
        ? row.id === record.visualRowId
        : row.uiBehaviorId === record.uiBehaviorId && row.state === record.state)
      : undefined;
    if (usesUiCoverage(state) && record.visualRowId &&
      (!visualRow || visualRow.uiBehaviorId !== record.uiBehaviorId || visualRow.state !== record.state)) {
      throw new Error(`${label}.visualRowId does not bind this behavior state to a visual acceptance row.`);
    }
    if (visualRow) {
      comparedVisualRows.add(visualRow.id);
      await assertVisualAcceptance({
        record,
        visualRow,
        label,
        roots,
        authority: visualAuthorityOf(state),
      });
    }
    const viewportKey = `${viewport.width}x${viewport.height}`;
    baselineViewport ??= viewportKey;
    if (
      viewportKey !== baselineViewport &&
      uiBehavior.kind !== "RESPONSIVE" &&
      !UI_VIEWPORT_STATES.has(record.state)
    ) {
      throw new Error(
        `${label}.viewport '${viewportKey}' differs from the slice viewport '${baselineViewport}'. Capture a second viewport only where responsive behavior is the requirement.`,
      );
    }
    const declared = new Map(
      (uiBehavior.interactions ?? []).map((item) => [item.id, item]),
    );
    for (const [position, interaction] of assertArray(
      record.interactions ?? [],
      `${label}.interactions`,
    ).entries()) {
      const item = `${label}.interactions[${position}]`;
      assertPlainObject(interaction, item);
      const contract = declared.get(interaction.id);
      if (!contract) {
        throw new Error(
          `${item}.id '${interaction.id}' is not an interaction '${uiBehavior.id}' declares.`,
        );
      }
      assertNonEmpty(interaction.expected, `${item}.expected`);
      assertNonEmpty(interaction.actual, `${item}.actual`);
      if (interaction.expected !== contract.expected) {
        throw new Error(
          `${item}.expected does not match the discovered contract for '${interaction.id}'.`,
        );
      }
      if (interaction.outcome !== "PASS") {
        throw new Error(
          `${item}.outcome must be PASS inside a PASS record; record the failure as a limitation instead.`,
        );
      }
      if (origin === "TARGET")
        exercised.add(`${uiBehavior.id}::${interaction.id}`);
    }
    const binding = assertPlainObject(record.boundTo, `${label}.boundTo`);
    const expectedUiContractDigest = `sha256:${hashContent(
      JSON.stringify({
        uiBehavior,
        mismatch: mismatchByBehavior.get(uiBehavior.id),
      }),
    )}`;
    for (const [field, expected] of Object.entries({
      target: state.targetModule,
      requirementsDigest: state.requirementsAuthority.digest,
      dataSourceMode: state.dataSourceMode,
      sliceId,
      // Legacy runtime is observed before the target exists, so binding it to
      // the target implementation would stale it on every slice edit.
      // A record written before tagged identities existed is bound to the raw
      // composition; when that is what it recorded and the files still hash to
      // it, that recorded spelling is the comparison projection. Otherwise the
      // EOL-stable composition is.
      ...(origin === "TARGET"
        ? {
            implementationDigest:
              binding.implementationDigest === implementationBinding.legacy
                ? implementationBinding.legacy
                : implementationBinding.current,
          }
        : {}),
      // Only the target (visual) evidence is design-dependent, and only when a
      // visual authority is pinned. Binding the canonical authority digest here
      // -- and nowhere in the seven final gates -- means a changed authority
      // forces re-verification of the visual rows alone, never functional parity.
      ...(origin === "TARGET" && visualAuthorityOf(state)
        ? {
            [visualAuthorityOf(state).boundToDigestField]:
              state.artifactHashes[visualAuthorityOf(state).contextFile],
          }
        : {}),
      uiContractDigest: expectedUiContractDigest,
    })) {
      if (binding[field] !== expected) {
        throw new Error(
          `${label}.boundTo.${field} is stale: recorded '${binding[field]}', current '${expected}'.`,
        );
      }
    }
    assertNonEmpty(record.reference, `${label}.reference`);
    if (!isContentIdentity(record.hash)) {
      throw new Error(`${label}.hash must be a SHA-256 digest.`);
    }
    let targetControls;
    if (origin === "TARGET") {
      assertTargetEvidencePath(record.reference, `${label}.reference`);
      assertCaptureRole(record.capture, TARGET_VERIFICATION_ROLE, label);
    }
    const proofPath = await assertEvidenceReference(
      { reference: record.reference, hash: record.hash },
      label,
      roots,
      { require: true },
    );
    // A hash match only proves the bytes are unchanged, not that they observe
    // a UI. TARGET PASS rows must reference structured Playwright proof whose
    // predicates the engine evaluates itself; authored outcomes are ignored.
    if (origin === "TARGET") {
      const proof = assertPlainObject(
        await readJson(proofPath, `${label}.reference`),
        `${label}.reference`,
      );
      if (proof.proofFormat !== UI_PROOF_FORMAT) {
        throw new Error(
          `${label}.reference is not '${UI_PROOF_FORMAT}' structured proof (proofFormat '${proof.proofFormat}'). A hash-valid file is not a UI observation.`,
        );
      }
      const parityRow = baseline.behaviorRows.find(
        (row) => row.behaviorId === uiBehavior.behaviorId,
      );
      for (const [field, expected] of Object.entries({
        sliceId,
        uiBehaviorId: record.uiBehaviorId,
        state: record.state,
        traceId: parityRow.id,
      })) {
        if (proof[field] !== expected) {
          throw new Error(
            `${label} proof.${field} is '${proof[field]}', expected '${expected}'.`,
          );
        }
      }
      const proofScenarios = assertArray(
        proof.scenarioIds,
        `${label} proof.scenarioIds`,
      );
      const missingScenario = uiBehavior.scenarioIds.find(
        (id) => !proofScenarios.includes(id),
      );
      if (missingScenario) {
        throw new Error(
          `${label} proof.scenarioIds omits '${missingScenario}' of UI behavior '${uiBehavior.id}'.`,
        );
      }
      const assertObservation = (value, at) => {
        const observation = assertPlainObject(value, at);
        assertNonEmpty(observation.url, `${at}.url`);
        const controls = assertArray(observation.controls, `${at}.controls`);
        if (controls.length === 0) {
          throw new Error(`${at}.controls must observe at least one control.`);
        }
        for (const [position, control] of controls.entries()) {
          const where = `${at}.controls[${position}]`;
          assertPlainObject(control, where);
          assertNonEmpty(control.role, `${where}.role`);
          assertNonEmpty(control.name, `${where}.name`);
          assertNonEmpty(control.state, `${where}.state`);
          const assertions = assertArray(
            control.assertions,
            `${where}.assertions`,
          );
          if (assertions.length === 0) {
            throw new Error(`${where}.assertions must not be empty.`);
          }
          for (const [n, assertion] of assertions.entries()) {
            assertPlainObject(assertion, `${where}.assertions[${n}]`);
            const observed = {
              presence: control.present,
              visibility: control.visible,
              text: control.text,
              value: control.value,
              count: control.count,
              url: observation.url,
            };
            if (!Object.hasOwn(observed, assertion.predicate)) {
              throw new Error(
                `${where}.assertions[${n}].predicate '${assertion.predicate}' is not one of ${Object.keys(observed).join(", ")}.`,
              );
            }
            if (
              assertion.expected === undefined ||
              observed[assertion.predicate] !== assertion.expected
            ) {
              throw new Error(
                `${where}.assertions[${n}] ${assertion.predicate} failed: expected '${assertion.expected}', observed '${observed[assertion.predicate]}'.`,
              );
            }
          }
        }
        return controls;
      };
      const controls = assertObservation(
        proof.observation,
        `${label} proof.observation`,
      );
      targetControls = controls;
      if (!controls.some((control) => control.state === record.state)) {
        throw new Error(
          `${label} proof.observation has no control observed in required state '${record.state}'.`,
        );
      }
      const checkRequired = (requiredObservation, snapshot, at, stateSnapshot) => {
        const { predicate, expected } = requiredObservation;
        const field = { presence: "present", visibility: "visible" }[predicate] ?? predicate;
        const controls = predicate === "url"
          ? [snapshot]
          : snapshot.controls.filter(
              (control) =>
                control.role === requiredObservation.role &&
                control.name === requiredObservation.name &&
                (!stateSnapshot || control.state === record.state),
            );
        if (!controls.some((control) =>
          Object.hasOwn(control, field) &&
          OBSERVATION_EXPECTED[predicate](control[field]) &&
          control[field] === expected
        )) {
          throw new Error(`${at} misses required observation '${requiredObservation.id}' (${predicate}: ${JSON.stringify(expected)}).`);
        }
      };
      for (const observation of usesRequiredObservations(state)
        ? uiBehavior.requiredObservations
        : []) {
        if (observation.state === record.state && !observation.afterInteractionId) {
          checkRequired(observation, proof.observation, `${label} proof.observation`, true);
        }
      }
      const proofInteractions = assertArray(
        proof.interactions ?? [],
        `${label} proof.interactions`,
      );
      for (const claimed of record.interactions ?? []) {
        const at = `${label} proof interaction '${claimed.id}'`;
        const observed = proofInteractions.find(
          (item) => item?.id === claimed.id,
        );
        if (!observed) {
          throw new Error(`${at} is missing.`);
        }
        const action = assertPlainObject(observed.action, `${at}.action`);
        assertNonEmpty(action.type, `${at}.action.type`);
        assertNonEmpty(action.target, `${at}.action.target`);
        assertObservation(observed.postAction, `${at}.postAction`);
        for (const observation of usesRequiredObservations(state)
          ? uiBehavior.requiredObservations
          : []) {
          if (observation.state === record.state && observation.afterInteractionId === claimed.id) {
            checkRequired(observation, observed.postAction, `${at}.postAction`, false);
            satisfiedPostActions.add(`${uiBehavior.id}::${observation.id}`);
          }
        }
      }
    }
    let screenshotPath;
    if (record.screenshot) {
      assertPlainObject(record.screenshot, `${label}.screenshot`);
      assertNonEmpty(
        record.screenshot.reference,
        `${label}.screenshot.reference`,
      );
      if (!isContentIdentity(record.screenshot.hash)) {
        throw new Error(`${label}.screenshot.hash must be a SHA-256 digest.`);
      }
      const slot = `${origin}::${record.uiBehaviorId}::${record.state}${usesUiCoverage(state) ? `::${record.appearanceClaimId}` : ""}`;
      if (screenshotSlots.has(slot)) {
        throw new Error(
          `${label}.screenshot exceeds the budget: '${record.uiBehaviorId}' state '${record.state}' is already captured for ${origin}.`,
        );
      }
      screenshotSlots.add(slot);
      // ponytail: scoped by origin. Byte-identical LEGACY and TARGET captures
      // mean perfect visual parity, which is the best possible outcome of a
      // migration -- only a repeated capture inside one origin is a mistake.
      const digestSlot = `${origin}::${record.screenshot.hash}`;
      if (!usesUiCoverage(state) && screenshotHashes.has(digestSlot)) {
        throw new Error(
          `${label}.screenshot duplicates an existing ${origin} capture in this slice.`,
        );
      }
      screenshotHashes.add(digestSlot);
      if (origin === "TARGET") {
        assertTargetEvidencePath(
          record.screenshot.reference,
          `${label}.screenshot.reference`,
        );
      }
      screenshotPath = await assertEvidenceReference(
        {
          reference: record.screenshot.reference,
          hash: record.screenshot.hash,
        },
        `${label}.screenshot`,
        roots,
        { require: true },
      );
    }
    if (usesUiCoverage(state)) {
      if (!screenshotPath) throw new Error(`${label} needs a screenshot for appearance claim '${appearanceClaim.id}'.`);
      assertVisualCaptureBlock({ rootLocator: appearanceClaim.locator }, record.capture, label, true);
      const requiredRole = origin === "TARGET" ? TARGET_VERIFICATION_ROLE : LEGACY_AUTHORITY_ROLE;
      if (record.capture.role !== requiredRole) throw new Error(`VISUAL_CAPTURE_ROLE: ${label}.capture.role must be '${requiredRole}'.`);
      if (origin === "LEGACY" && binding.legacyRevision !== state.legacyRevision?.revision) {
        throw new Error(`${label}.boundTo.legacyRevision does not match the pinned legacy revision.`);
      }
      const snapshot = assertPlainObject(await readJson(proofPath, `${label}.reference`), `${label}.reference`);
      if (snapshot.proofFormat !== UI_PROOF_FORMAT || snapshot.uiBehaviorId !== uiBehavior.id || snapshot.state !== record.state) {
        throw new Error(`${label} is not a bound ${UI_PROOF_FORMAT} proof for this appearance claim.`);
      }
      if (appearanceClaim.afterInteractionId &&
        !record.interactions?.some((item) => item.id === appearanceClaim.afterInteractionId)) {
        throw new Error(`${label} does not exercise the interaction for appearance claim '${appearanceClaim.id}'.`);
      }
      const observation = appearanceClaim.afterInteractionId
        ? snapshot.interactions?.find((item) => item.id === appearanceClaim.afterInteractionId)?.postAction
        : snapshot.observation;
      if (!Array.isArray(observation?.controls) || !observation.controls.some((control) =>
        control.role === appearanceClaim.role && control.name === appearanceClaim.name &&
        control.locator === appearanceClaim.locator && control.visible === true)) {
        throw new Error(`${label} proof does not observe visible appearance claim '${appearanceClaim.id}'.`);
      }
      const key = `${uiBehavior.id}::${record.state}::${appearanceClaim.id}`;
      const pair = appearanceEvidence.get(key) ?? {};
      pair[origin] = { record, snapshot: { ...snapshot, observation }, screenshotPath };
      appearanceEvidence.set(key, pair);
    }
    if (visualRow?.version === HARDENED_VISUAL_VERSION) {
      const frame = visualRow.authorityFrame;
      const authorityName = state.designSource;
      visualComparison.push(await compareVisualEvidence({
        visualRow,
        targetCapture: record.capture,
        authority: authorityName,
        targetReference: record.screenshot.reference,
        readAuthorityPng: () => readFile(path.join(root, frame.sources.screenshot.reference)),
        readTargetPng: () => readFile(screenshotPath),
        readAuthorityControls: async () => {
          const snapshot = await readJson(path.join(root, frame.sources.snapshot.reference), "Legacy authority snapshot");
          return snapshot.observation.controls;
        },
        targetControls,
        nativeRows: baseline.nativeRows,
      }));
    }
  }
  for (const uiBehavior of required) {
    const limitationFor = (runtimeState) => {
      const limitation = limitations.find(
        (item) =>
          item.uiBehaviorId === uiBehavior.id && item.state === runtimeState,
      );
      return limitation?.reason
        ? ` Runtime availability NOT_AVAILABLE: ${limitation.reason}`
        : "";
    };
    for (const runtimeState of uiBehavior.runtimeStates) {
      if (
        !records.some(
          (record) =>
            (record.origin ?? "TARGET") === "TARGET" &&
            record.uiBehaviorId === uiBehavior.id &&
            record.state === runtimeState &&
            record.result === "PASS",
        )
      ) {
        throw new Error(
          `Required UI behavior '${uiBehavior.id}' state '${runtimeState}' lacks Playwright runtime evidence.${limitationFor(runtimeState)}`,
        );
      }
    }
    // A behavior can be "seen" in every state and still never be *used*.
    for (const interaction of uiBehavior.interactions ?? []) {
      if (!exercised.has(`${uiBehavior.id}::${interaction.id}`)) {
        throw new Error(
          `Required UI behavior '${uiBehavior.id}' interaction '${interaction.id}' was never exercised against the target runtime.${limitationFor(uiBehavior.runtimeStates[0])}`,
        );
      }
    }
    if (usesRequiredObservations(state)) {
      for (const observation of uiBehavior.requiredObservations) {
        if (observation.afterInteractionId && !satisfiedPostActions.has(`${uiBehavior.id}::${observation.id}`)) {
          throw new Error(`Required UI behavior '${uiBehavior.id}' state '${observation.state}' misses required postAction observation '${observation.id}' after interaction '${observation.afterInteractionId}'.`);
        }
      }
    }
  }
  if (usesUiCoverage(state)) {
    for (const row of baseline.visualRows ?? []) {
      if (!comparedVisualRows.has(row.id)) throw new Error(`VISUAL_COVERAGE_MISSING: acceptance row '${row.id}' has no bound TARGET capture.`);
    }
    for (const uiBehavior of required) {
      for (const claim of uiBehavior.requiredAppearance) {
        const pair = appearanceEvidence.get(`${uiBehavior.id}::${claim.state}::${claim.id}`);
        if (!pair?.LEGACY || !pair?.TARGET) {
          throw new Error(`VISUAL_COVERAGE_MISSING: '${claim.id}' needs bound LEGACY and TARGET captures of '${claim.locator}'.`);
        }
        const scrollContract = uiBehavior.scrollContracts.find((row) => row.state === claim.state);
        visualComparison.push(await compareAppearanceCoverage({ ...claim, scrollContract }, pair.LEGACY, pair.TARGET));
      }
    }
  }
  return visualComparison;
};

/**
 * Classification only, never a validator: does this slice's recorded TARGET UI
 * evidence reference anything other than `playwright-ui-proof/v1`? Drives the
 * `--reopen-ui` recovery hint and the ACTIVE reopen superset rule.
 */
export const sliceLacksUiProofV1 = async (root, sliceId, roots) => {
  let evidence;
  try {
    evidence = JSON.parse(
      await readFile(path.join(root, `evidence/${sliceId}/result.json`), "utf8"),
    );
  } catch {
    return false;
  }
  if (evidence?.result !== "PASS" || !Array.isArray(evidence.uiEvidence)) {
    return false;
  }
  for (const record of evidence.uiEvidence) {
    if ((record?.origin ?? "TARGET") !== "TARGET") continue;
    const claim = evidencePathClaim(record.reference);
    const resolved = claim && (await resolveEvidencePath(claim, roots));
    try {
      const proof = JSON.parse(await readFile(resolved, "utf8"));
      if (proof?.proofFormat !== UI_PROOF_FORMAT) return true;
    } catch {
      return true;
    }
  }
  return false;
};

export const completedSlicesLackingUiProofV1 = async (root, state, roots) => {
  const lacking = [];
  for (const sliceId of state.completedSlices ?? []) {
    if (await sliceLacksUiProofV1(root, sliceId, roots)) lacking.push(sliceId);
  }
  return lacking;
};

// COMPLETE: a visible-UI parity audit. ACTIVE at VERIFY_SLICES/FINALIZE:
// stale-evidence recovery for completed slices lacking playwright-ui-proof/v1.
export const reopenUiEligible = (state) =>
  state.status === "COMPLETE" ||
  (state.status === "ACTIVE" &&
    ["VERIFY_SLICES", "FINALIZE"].includes(state.currentStep));

export const reopenUiIneligible = (state) =>
  `--reopen-ui is legal only for a COMPLETE migration, or an ACTIVE one at VERIFY_SLICES or FINALIZE; the current status is '${state.status}' at '${state.currentStep}'.`;
