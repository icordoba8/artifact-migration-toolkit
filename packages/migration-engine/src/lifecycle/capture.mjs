/**
 * Lifecycle: MC2 legacy-runtime capture. The engine drives the browser and
 * persists what it observed, so an agent never writes a Playwright harness, a
 * measurement generator, frame metadata or a digest by hand.
 *
 * Two destinations, one capture (visual/capture.mjs):
 * - `frame` (designSource legacy-runtime, ASSESS_TARGET): the authority frame
 *   `<uiBehaviorId>::<state>`, its snapshot, screenshot and measurements under
 *   inventories/legacy-runtime/, added to the unpinned legacy-runtime context.
 * - `claim` (format 20, VERIFY_SLICES): the proof and PNG of one pinned
 *   appearance claim under the active slice's evidence/, and its uiEvidence row
 *   in that slice's result.json, for LEGACY or (`role: "TARGET"`) the target.
 *
 * Explicit and writing. The browser runs outside the module lock; the record is
 * re-read under the lock and the write refused if anything it depends on moved.
 * Nothing is overwritten, pinned, approved, advanced or marked PASS, and a
 * refusal at any point leaves no new byte behind. A TARGET row is written only
 * from the target's own capture, and only when it meets every predicate the
 * pinned contract names; legacy evidence never stands in for it.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  initialArtifacts,
  LEGACY_RUNTIME_CONTEXT_FILE,
  usesUiCoverage,
} from "../formats/index.mjs";
import { withUiRemediation } from "../census/index.mjs";
import { assertPlainObject, contentIdentity, isPlainObject, jsonBytes, portablePath } from "../shared/index.mjs";
import { implementationDigests } from "../slices/index.mjs";
import {
  atomicWrite,
  entryExists,
  fileExists,
  fileIdentity,
  readJson,
  removeDurably,
  removeEmptyParents,
} from "../store/index.mjs";
import {
  captureInBrowser,
  captureThroughBroker,
  claimCapturePlan,
  compareScrollContract,
  HARDENED_VISUAL_VERSION,
  LEGACY_RUNTIME_EVIDENCE_ROOT,
  legacyAppearanceRow,
  parseCaptureRequest,
  assertSessionUsable,
  refuseCapture,
  targetAppearanceRow,
  targetProof,
  usesVisualContract,
  validateLegacyRuntimeContext,
  visualAuthorityOf,
} from "../visual/index.mjs";
import { legacyRuntimeOriginOf, sessionBrokerOf } from "./app-runtime.mjs";
import { readContext } from "./context.mjs";
import { withModuleLock } from "./lock.mjs";
import { assertCurrentOpenSpecAuthority } from "./openspec.mjs";
import { DISCOVERY_CLAIMS_FILE, readState } from "./record.mjs";

const refused = (message) => refuseCapture("CAPTURE_REFUSED", message);

const readObject = async (file, label, fallback) =>
  (await fileExists(file)) ? assertPlainObject(await readJson(file, label), label) : fallback;

const absent = async (root, relatives) => {
  for (const relative of relatives) {
    if (await entryExists(path.join(root, relative))) {
      refuseCapture("CAPTURE_EXISTS", `'${relative}' already exists; a capture never replaces evidence. Remove it only if it is an abandoned capture that nothing cites.`);
    }
  }
};

/* ASSESS_TARGET: one authority frame, joined to the unpinned context. */
const framePlan = async ({ state, root, legacy, request }) => {
  if (state.currentStep !== "ASSESS_TARGET" || !usesVisualContract(state) ||
      visualAuthorityOf(state)?.contextFile !== LEGACY_RUNTIME_CONTEXT_FILE) {
    refused(`An authority frame is captured for a designSource legacy-runtime record at ASSESS_TARGET; this record is '${state.designSource ?? "target-system"}' at ${state.currentStep}.`);
  }
  if (state.artifactHashes?.[LEGACY_RUNTIME_CONTEXT_FILE]) {
    refuseCapture("CAPTURE_AUTHORITY_PINNED", `${LEGACY_RUNTIME_CONTEXT_FILE} is pinned; a pinned legacy authority is never refreshed or extended.`);
  }
  const uiBehavior = (legacy.uiBehaviors ?? []).find((item) => item?.id === request.uiBehaviorId);
  if (!uiBehavior?.runtimeStates?.includes(request.state)) {
    refused(`'${request.uiBehaviorId}' state '${request.state}' is not a discovered state of a UI behavior in ${initialArtifacts.legacyInventory}.`);
  }
  const context = await readObject(path.join(root, LEGACY_RUNTIME_CONTEXT_FILE), LEGACY_RUNTIME_CONTEXT_FILE,
    { version: HARDENED_VISUAL_VERSION, frames: [] });
  if (context.version !== HARDENED_VISUAL_VERSION || !Array.isArray(context.frames ?? [])) {
    refused(`${LEGACY_RUNTIME_CONTEXT_FILE} must be a version-${HARDENED_VISUAL_VERSION} context with a "frames" array before a capture can join it.`);
  }
  const key = `${request.uiBehaviorId}::${request.state}`;
  if ((context.frames ?? []).some((frame) => frame?.id === key)) {
    refuseCapture("CAPTURE_EXISTS", `${LEGACY_RUNTIME_CONTEXT_FILE} already records frame '${key}'; a capture never replaces a recorded frame.`);
  }
  const directory = `${LEGACY_RUNTIME_EVIDENCE_ROOT}${request.uiBehaviorId}-${request.state}`;
  await absent(root, [directory]);
  // Format 20 pins the controls a state shows, and every one is observed; a
  // request can add controls, never replace the pinned ones.
  const pinned = (uiBehavior.requiredAppearance ?? [])
    .filter((claim) => claim.state === request.state && !claim.afterInteractionId)
    .map(({ role, name, locator }) => ({ role, name, locator }));
  const controls = [...pinned, ...request.controls.filter((control) => !pinned.some((item) => item.locator === control.locator))];
  if (controls.length === 0) {
    refuseCapture("CAPTURE_REQUEST_INVALID", "controls is required: name each control the state shows as {role, name, locator}; this record pins no format-20 appearance claim to derive them from.");
  }
  return {
    plan: { ...request, controls },
    context,
    key,
    directory,
    // What the write depends on; re-read under the lock.
    fingerprint: JSON.stringify([state.currentStep, state.legacyRevision, state.artifactHashes?.[LEGACY_RUNTIME_CONTEXT_FILE] ?? null]),
  };
};

/* VERIFY_SLICES, format 20: the LEGACY half of one pinned appearance claim. */
const claimPlan = async ({ state, root, legacy, request, roots }) => {
  if (!usesUiCoverage(state) || state.currentStep !== "VERIFY_SLICES" || !state.activeSlice) {
    refused(`An appearance-claim capture needs a format-20 record at VERIFY_SLICES with an active slice; this record is format ${state.formatVersion} at ${state.currentStep}.`);
  }
  const owner = (legacy.uiBehaviors ?? []).find((item) =>
    (item?.requiredAppearance ?? []).some((claim) => claim?.id === request.appearanceClaimId));
  const claim = owner?.requiredAppearance.find((item) => item.id === request.appearanceClaimId);
  if (!claim) refused(`Appearance claim '${request.appearanceClaimId}' is not pinned in ${initialArtifacts.legacyInventory}.`);
  // Only a behavior this slice traces is verified here; any other row would be refused there.
  const slice = state.activeSlice;
  const { traceIds = [] } = await readObject(path.join(root, `slices/${slice}.json`), `Slice ${slice}`, {});
  const parity = await readObject(path.join(root, initialArtifacts.behaviorParity), "Behavior parity matrix", {});
  if (!(parity.rows ?? []).some((row) => row?.behaviorId === owner.behaviorId && traceIds.includes(row.id))) {
    refused(`Claim '${claim.id}' belongs to '${owner.id}', whose behavior '${owner.behaviorId}' is not traced by the active slice '${slice}'.`);
  }
  if (Boolean(claim.afterInteractionId) !== Boolean(request.interaction)) {
    refuseCapture("CAPTURE_REQUEST_INVALID", claim.afterInteractionId
      ? `Claim '${claim.id}' is observed after interaction '${claim.afterInteractionId}'; supply "interaction" {type, target, value?} that performs it. The inventory says what the interaction does, not how to drive it.`
      : `Claim '${claim.id}' is an initial-state claim; "interaction" is not allowed.`);
  }
  const { role } = request;
  const resultFile = `evidence/${slice}/result.json`;
  const result = await readObject(path.join(root, resultFile), `Evidence for ${slice}`, {});
  if (result.uiEvidence !== undefined && !Array.isArray(result.uiEvidence)) refused(`${resultFile} uiEvidence is authored but is not an array.`);
  if ((result.uiEvidence ?? []).some((row) => isPlainObject(row) && (row.origin ?? "TARGET") === role && row.appearanceClaimId === claim.id)) {
    refuseCapture("CAPTURE_EXISTS", `${resultFile} already records the ${role} row of claim '${claim.id}'; the screenshot budget allows one per origin and claim.`);
  }
  const directory = `evidence/${slice}/ui/${role.toLowerCase()}`;
  await absent(root, [`${directory}/${claim.id}.proof.json`, `${directory}/${claim.id}.png`]);
  const target = await withUiRemediation(root, state, await readObject(path.join(root, initialArtifacts.targetInventory), "Target inventory", {}), "uiMismatches");
  const plan = claimCapturePlan(request, owner, claim);
  let bound = {};
  if (role === "TARGET") {
    Object.assign(plan, stateControls(owner, claim, request));
    const implementation = await readObject(path.join(root, `slices/${slice}.json`), `Slice ${slice}`, {});
    bound = {
      implementationDigest: (await implementationDigests({ changedFiles: implementation.changedFiles ?? [] }, roots)).current,
      traceId: parity.rows.find((row) => row?.behaviorId === owner.behaviorId && traceIds.includes(row.id)).id,
    };
  }
  return {
    plan,
    claim,
    uiBehavior: owner,
    mismatch: (target.uiMismatches ?? []).find((row) => row?.uiBehaviorId === owner.id),
    result,
    resultFile,
    directory,
    bound,
    fingerprint: JSON.stringify([state.currentStep, slice, state.legacyRevision, state.completedSlices ?? [], bound.implementationDigest ?? null]),
  };
};

/**
 * The controls VERIFY_SLICES observes for a claim's TARGET half: every pinned
 * claim of its state shown after its interaction, and every initial claim of
 * that state shown before it. Discovery plans and judges a claim the same way,
 * so a state whose claims cannot all hold together is refused there, not at TARGET.
 */
const stateControls = (owner, claim, request) => {
  // Every predicate the contract checks in this proof needs its control observed;
  // a format-20 claim pins each expected-true one, so the claims are the controls.
  const unpinned = (owner.requiredObservations ?? []).find((item) => item.state === claim.state && item.predicate !== "url" && item.expected === false);
  if (unpinned) refuseCapture("CAPTURE_REQUEST_INVALID", `Required observation '${unpinned.id}' expects an absent control, which no pinned claim locates; the engine capture cannot observe it.`);
  // shortcut: expected-false observations are refused above; give them a locator in the contract when a consumer needs one.
  const pinned = (after) => owner.requiredAppearance
    .filter((item) => item.state === claim.state && (item.afterInteractionId ?? null) === after)
    .map(({ role: controlRole, name, locator }) => ({ role: controlRole, name, locator }));
  const extra = (controls) => [...controls, ...(request.controls ?? []).filter((control) => !controls.some((item) => item.locator === control.locator))];
  return {
    controls: extra(pinned(claim.afterInteractionId ?? null)),
    ...(claim.afterInteractionId ? { beforeControls: extra(pinned(null)) } : {}),
  };
};

/**
 * One LEGACY observation of a claim, judged as VERIFY_SLICES will judge its
 * TARGET half: every pinned control of the state shown before and after the
 * interaction, the contract's required observations, then the scroll contract.
 * The discovery run and the DISCOVER_LEGACY gate both call it, so the gate
 * re-derives each verdict from the persisted snapshot.
 */
const judgeClaim = (owner, claim, snapshot) => {
  const { controls, beforeControls } = stateControls(owner, claim, {});
  const after = claim.afterInteractionId ? snapshot?.interactions?.[0]?.postAction : snapshot?.observation;
  const shows = (observation, wanted, label) => {
    const unseen = wanted.filter((want) => !(observation?.controls ?? []).some((control) => control?.role === want.role &&
      control.name === want.name && control.locator === want.locator && control.present === true && control.visible === true));
    if (unseen.length > 0) {
      refuseCapture("CAPTURE_STATE_NOT_REACHED", `${label} does not show ${unseen.map((item) => `${item.role} '${item.name}' at '${item.locator}'`).join(", ")}, which ${initialArtifacts.legacyInventory} pins for state '${claim.state}'; VERIFY_SLICES observes them together, so this contract cannot be met.`);
    }
  };
  shows(after, controls, claim.afterInteractionId ? `After interaction '${claim.afterInteractionId}', the page` : `State '${claim.state}'`);
  if (beforeControls) shows(snapshot.observation, beforeControls, `Before interaction '${claim.afterInteractionId}', the page`);
  targetProof({ snapshot, sliceId: null, traceId: null, uiBehavior: owner });
  const contract = (owner.scrollContracts ?? []).find((row) => row?.state === claim.state);
  if (!contract) refused(`'${owner.id}' has no scrollContracts row for state '${claim.state}'.`);
  compareScrollContract({ observation: after }, { observation: after }, contract, false);
};

const prepare = async ({ targetRoot, moduleName, request, roots }) => {
  const { state, root, pendingWrite } = await readState(targetRoot, moduleName);
  if (pendingWrite) refused("An advance is in flight; recover the record before capturing.");
  if (state.status !== "ACTIVE") refused(`The record is ${state.status}; evidence is captured only for an ACTIVE checkpoint.`);
  await assertCurrentOpenSpecAuthority(targetRoot, state);
  if (request.storageState) {
    // Both sides by realpath: a symlink outside the record may not point into it.
    const session = await realpath(path.resolve(request.storageState)).catch(() => null);
    if (!session || !(await stat(session)).isFile()) refused(`storageState '${request.storageState}' is not a readable file.`);
    if (portablePath(path.relative(await realpath(root), session)).split("/")[0] !== "..") {
      refused("storageState lives inside the migration record; an authorized session file is read, never persisted as evidence.");
    }
    assertSessionUsable(await readJson(session, "storageState").catch(() => refused("storageState is not valid JSON.")), request.origin);
  }
  // The validator's own view: an adopted UI remediation replaces the UI rows.
  // One read: the plans and the identity a discovery check is bound to come from the same bytes.
  const inventoryFile = path.join(root, initialArtifacts.legacyInventory);
  const inventoryBytes = await readFile(inventoryFile).catch((error) => {
    throw error.code === "ENOENT" ? new Error(`Legacy inventory does not exist: ${inventoryFile}`) : error;
  });
  let authored;
  try { authored = JSON.parse(inventoryBytes.toString("utf8")); } catch (error) { throw new Error(`Legacy inventory is invalid JSON: ${error.message}`); }
  const legacy = await withUiRemediation(root, state, assertPlainObject(authored, "Legacy inventory"), "uiBehaviors");
  const inventory = contentIdentity(inventoryFile, inventoryBytes);
  const planned = await ({ frame: framePlan, claim: claimPlan, discovery: discoveryPlan })[request.mode]({ state, root, legacy, request, roots, inventory });
  return { ...planned, state, root, legacy };
};

/* Any checkpoint: each listed claim of the current legacy inventory, planned as VERIFY_SLICES plans its LEGACY half. */
const discoveryPlan = async ({ state, root, legacy, request, roots, inventory }) => {
  const runtime = await discoveryAuthority(roots.targetRoot, request);
  const pinned = new Map();
  for (const owner of legacy.uiBehaviors ?? []) {
    for (const claim of owner?.requiredAppearance ?? []) {
      if (pinned.has(claim?.id)) refused(`Appearance claim '${claim?.id}' is repeated in ${initialArtifacts.legacyInventory}.`);
      pinned.set(claim?.id, { owner, claim });
    }
  }
  const listed = new Set(request.claims.map((item) => item.appearanceClaimId));
  return {
    checks: request.claims.map((item) => {
      const { owner, claim } = pinned.get(item.appearanceClaimId) ?? {};
      if (!claim) return { item, refusal: ["CAPTURE_REFUSED", `Appearance claim '${item.appearanceClaimId}' is not in ${initialArtifacts.legacyInventory}.`] };
      if (Boolean(claim.afterInteractionId) !== Boolean(item.interaction)) {
        return { item, refusal: ["CAPTURE_REQUEST_INVALID", claim.afterInteractionId
          ? `Claim '${claim.id}' is observed after interaction '${claim.afterInteractionId}'; supply "interaction".`
          : `Claim '${claim.id}' is an initial-state claim; "interaction" is not allowed.`] };
      }
      try {
        return { item, claim, owner, plan: { ...claimCapturePlan(item, owner, claim), ...stateControls(owner, claim, item) } };
      } catch (error) {
        return { item, refusal: [error.validationCode ?? "CAPTURE_REFUSED", error.message.replace(/^[A-Z_]+: /, "")] };
      }
    }),
    unchecked: [...pinned.keys()].filter((id) => !listed.has(id)),
    binding: discoveryBinding(state, inventory),
    runtime,
    record: await recordIdentity(root),
  };
};

/**
 * The capture authority a discovery check runs under, validated rather than
 * recorded: a configured runtime contract names the one LEGACY origin a check
 * may observe, and a session check needs that contract. Only the origin is
 * kept; the session itself never leaves the broker or the storageState file.
 */
const discoveryAuthority = async (targetRoot, request) => {
  const origin = await legacyRuntimeOriginOf(targetRoot);
  if (origin === null && request.session) {
    refuseCapture("CAPTURE_AUTHORITY_MISMATCH", "A session check observes the LEGACY application the runtime contract declares, and none is configured; run migration_app_runtime configure first.");
  }
  if (origin !== null && origin !== request.origin) {
    refuseCapture("CAPTURE_AUTHORITY_MISMATCH", `origin '${request.origin}' is not the LEGACY origin '${origin}' the runtime contract declares; a discovery check observes only that application.`);
  }
  return origin;
};

const recordIdentity = async (root) => {
  const file = path.join(root, DISCOVERY_CLAIMS_FILE);
  return (await entryExists(file)) ? fileIdentity(file, { bytes: true }) : null;
};

// A refusal that says nothing about the claim stops the run instead of failing every claim the same way.
const RUN_REFUSALS = new Set(["CAPTURE_BROWSER_UNAVAILABLE", "CAPTURE_AUTH_REQUIRED", "CAPTURE_SESSION_EXPIRED",
  "CAPTURE_SESSION_HOST", "CAPTURE_BROKER_UNAVAILABLE", "CAPTURE_BROKER_NOT_ISOLATED", "CAPTURE_BROKER_FAILED", "CAPTURE_BROKER_INCOMPATIBLE"]);

/**
 * mode "discovery": capture each claim exactly as VERIFY_SLICES captures its
 * LEGACY half, judge it as VERIFY judges its TARGET half (judgeClaim), and
 * report every failing claim in one run. At DISCOVER_LEGACY a complete pass is
 * recorded and a failure recorded as a contradiction; nothing else is written.
 */
const checkClaims = async ({ targetRoot, prepared, parsed, resolved }) => {
  const failed = [];
  const passed = [];
  const observations = [];
  let broker;
  let stopped;
  // ponytail: one browser per claim, serially; reuse one browser if a large inventory makes this slow.
  for (const { item, claim, owner, plan, refusal } of prepared.checks) {
    try {
      if (refusal) refuseCapture(...refusal);
      const captured = await (parsed.session
        ? captureThroughBroker(broker ??= await sessionBrokerOf(targetRoot), plan, "LEGACY", { readOnly: true })
        : captureInBrowser({ ...plan, guard: { allowWrites: false } }));
      const { state, observation, interactions } = captured.snapshot;
      const snapshot = { state, observation, interactions: interactions.map(({ id, postAction }) => ({ id, postAction })) };
      judgeClaim(owner, claim, snapshot);
      passed.push(claim.id);
      observations.push({ appearanceClaimId: claim.id, plan, snapshot });
    } catch (error) {
      if (RUN_REFUSALS.has(error.validationCode)) { stopped = error; break; }
      failed.push({ appearanceClaimId: item.appearanceClaimId, code: error.validationCode ?? error.message.match(/^[A-Z_]+(?=:)/)?.[0] ?? "CAPTURE_FAILED", message: error.message });
    }
  }
  // A run the runtime stopped proves nothing new, except the failures it already saw.
  const complete = !stopped && failed.length === 0 && prepared.unchecked.length === 0;
  const written = await recordDiscoveryCheck({ targetRoot, prepared, parsed, resolved, observations: complete ? observations : null, failed });
  if (stopped) throw stopped;
  return {
    module: resolved.canonical,
    step: prepared.state.currentStep,
    mode: "discovery",
    passed,
    failed,
    unchecked: prepared.unchecked,
    written,
    next: failed.length > 0
      ? `Correct every failed claim in ${initialArtifacts.legacyInventory}, then check again.`
      : prepared.unchecked.length > 0 ? "Check the unchecked claims too; DISCOVER_LEGACY closes only after one run checks every pinned claim."
        : `Every pinned claim resolves as VERIFY_SLICES will capture it; ${DISCOVERY_CLAIMS_FILE} binds this run to the current inventory.`,
  };
};

/** What a discovery check is valid for: this checkpoint revision, these inventory bytes, this legacy authority. */
const discoveryBinding = (state, legacyInventory) => ({
  revision: state.revision,
  legacyInventory,
  legacyRevision: state.legacyRevision?.revision ?? null,
  requirementsAuthority: state.requirementsAuthority ?? null,
});

const currentBinding = async (root, state) =>
  discoveryBinding(state, await fileIdentity(path.join(root, initialArtifacts.legacyInventory)));

/**
 * Publish, under the module lock, what one DISCOVER_LEGACY run proved. The
 * checkpoint, the inventory bytes the plans came from, the runtime authority
 * and the record this run started from are all re-checked first; any move
 * refuses with nothing written. A complete pass replaces the record; a run
 * with a failed claim (or one the runtime stopped after a failure) replaces it
 * with a contradiction, so neither an earlier pass nor a concurrent one that
 * did not see the failure can close discovery. A pass that finds the record or
 * the runtime contract changed since it started is refused and checks again.
 */
const recordDiscoveryCheck = async ({ targetRoot, prepared, parsed, resolved, observations, failed }) => {
  if (prepared.state.currentStep !== "DISCOVER_LEGACY" || (!observations && failed.length === 0)) return [];
  return withModuleLock(targetRoot, resolved.canonical, async () => {
    const { state, root } = await readState(targetRoot, resolved.canonical);
    const binding = await currentBinding(root, state);
    if (JSON.stringify(binding) !== JSON.stringify(prepared.binding)) {
      refuseCapture("CAPTURE_CONFLICT", "The record or its legacy inventory moved while the browser was checking; check again against the current inventory.");
    }
    // A contradiction can only block closure, so only a pass is held to the authority and the record it started from.
    if (observations) {
      const runtime = await discoveryAuthority(targetRoot, parsed).catch(() => undefined); // refused now: never equal to a validated origin or null
      if (runtime !== prepared.runtime) {
        refuseCapture("CAPTURE_CONFLICT", "The runtime contract changed while the browser was checking; check again.");
      }
      if (await recordIdentity(root) !== prepared.record) {
        refuseCapture("CAPTURE_CONFLICT", `Another discovery check published ${DISCOVERY_CLAIMS_FILE} while this one ran; check again.`);
      }
    }
    await replaceDocument(targetRoot, path.join(root, DISCOVERY_CLAIMS_FILE), {
      version: 1,
      producer: "artifact-migration-capture",
      checkedAt: new Date().toISOString(),
      binding,
      capture: { origin: parsed.origin, session: parsed.session === true, storageState: parsed.storageState !== undefined },
      ...(observations
        ? { claims: observations.map(({ appearanceClaimId, plan, snapshot }) => ({
          appearanceClaimId, route: plan.route, viewport: plan.viewport, colorScheme: plan.colorScheme, snapshot })) }
        : { claims: [], contradicted: failed.map(({ appearanceClaimId, code }) => ({ appearanceClaimId, code })) }),
    });
    return [DISCOVERY_CLAIMS_FILE];
  });
};

/** Whether the record holds a complete pass bound to this checkpoint and inventory: the one DISCOVER_LEGACY pins when it closes. */
export const discoveryCheckCurrent = async (root, state) => {
  const record = await readJson(path.join(root, DISCOVERY_CLAIMS_FILE), DISCOVERY_CLAIMS_FILE).catch(() => null);
  return isPlainObject(record) && record.version === 1 && record.contradicted === undefined &&
    JSON.stringify(record.binding) === JSON.stringify(await currentBinding(root, state));
};

const unverified = (code, message, details) => {
  throw Object.assign(new Error(`${code}: ${message} Run migration_capture with mode "discovery" listing every pinned claim, correct each failed claim in ${initialArtifacts.legacyInventory}, then close DISCOVER_LEGACY again. Nothing was written.`),
    { validationCode: code, discoveryClaims: details });
};

/**
 * The DISCOVER_LEGACY closure gate for a format-20 record that pins appearance
 * claims. The pass is never read from the record: each claim's verdict is
 * re-derived by judgeClaim from the snapshot the engine captured, against the
 * claims, required observations and scroll contract of the inventory being closed.
 */
export const assertDiscoveryClaimsVerified = async (root, state, legacy) => {
  if (!usesUiCoverage(state) || state.currentStep !== "DISCOVER_LEGACY") return;
  const expected = new Map();
  for (const owner of legacy?.uiBehaviors ?? []) {
    for (const claim of owner?.requiredAppearance ?? []) {
      if (expected.has(claim?.id)) unverified("DISCOVERY_CLAIMS_INVALID", `Appearance claim '${claim?.id}' is repeated in ${initialArtifacts.legacyInventory}.`, { duplicate: [claim?.id] });
      expected.set(claim?.id, { owner, claim });
    }
  }
  // A non-UI module pins no claim and closes exactly as before.
  if (expected.size === 0) return;
  const all = [...expected.keys()];
  const file = path.join(root, DISCOVERY_CLAIMS_FILE);
  if (!(await fileExists(file))) {
    unverified("DISCOVERY_CLAIMS_UNVERIFIED", `${all.length} pinned appearance claim(s) have no successful discovery check (${DISCOVERY_CLAIMS_FILE} is absent).`, { missing: all });
  }
  const record = await readJson(file, DISCOVERY_CLAIMS_FILE).catch(() => null);
  if (!isPlainObject(record) || record.version !== 1 || !isPlainObject(record.binding) || !Array.isArray(record.claims)) {
    unverified("DISCOVERY_CLAIMS_INVALID", `${DISCOVERY_CLAIMS_FILE} is not an engine discovery check.`, {});
  }
  const binding = await currentBinding(root, state);
  const moved = Object.keys(binding).filter((key) => JSON.stringify(record.binding[key] ?? null) !== JSON.stringify(binding[key]));
  if (moved.length > 0) {
    unverified("DISCOVERY_CLAIMS_STALE", `${DISCOVERY_CLAIMS_FILE} was checked against a different ${moved.join(", ")} than the one being closed.`, { stale: moved });
  }
  if (record.contradicted !== undefined) {
    const ids = Array.isArray(record.contradicted) ? record.contradicted.map((item) => item?.appearanceClaimId) : [];
    unverified("DISCOVERY_CLAIMS_UNVERIFIED", `The latest discovery check failed claim(s) ${ids.join(", ") || "(unreadable)"}.`, { contradicted: ids });
  }
  const seen = new Set();
  const failed = [];
  for (const row of record.claims) {
    const id = row?.appearanceClaimId;
    if (seen.has(id)) unverified("DISCOVERY_CLAIMS_INVALID", `${DISCOVERY_CLAIMS_FILE} lists claim '${id}' more than once.`, { duplicate: [id] });
    seen.add(id);
    const { owner, claim } = expected.get(id) ?? {};
    if (!claim) unverified("DISCOVERY_CLAIMS_STALE", `${DISCOVERY_CLAIMS_FILE} checked claim '${id}', which ${initialArtifacts.legacyInventory} does not pin.`, { unknown: [id] });
    try {
      judgeClaim(owner, claim, row.snapshot);
    } catch (error) {
      failed.push({ appearanceClaimId: id, message: error.message });
    }
  }
  const missing = all.filter((id) => !seen.has(id));
  if (missing.length > 0 || failed.length > 0) {
    unverified("DISCOVERY_CLAIMS_UNVERIFIED", [
      missing.length > 0 && `Unchecked claim(s): ${missing.join(", ")}.`,
      failed.length > 0 && `Failed claim(s): ${failed.map((item) => `${item.appearanceClaimId} (${item.message})`).join("; ")}.`,
    ].filter(Boolean).join(" "), { missing, failed });
  }
};

/** Write files as new, newest last; on any failure remove exactly what this call wrote. */
const publisher = (targetRoot, root) => {
  const written = [];
  return {
    written,
    file: async (relative, bytes) => {
      const absolute = path.join(root, relative);
      if (await entryExists(absolute)) refuseCapture("CAPTURE_EXISTS", `'${relative}' appeared during the capture.`);
      await atomicWrite(targetRoot, absolute, bytes, { mode: 0o644 });
      written.push(absolute);
      return { reference: relative, hash: await fileIdentity(absolute), bytes: Buffer.byteLength(bytes) };
    },
    rollback: async (directory) => {
      for (const absolute of written.reverse()) await removeDurably(targetRoot, absolute).catch(() => undefined);
      await removeEmptyParents(path.join(root, directory), root).catch(() => undefined);
    },
  };
};

const replaceDocument = async (targetRoot, file, document) => {
  const mode = (await stat(file).catch(() => null))?.mode;
  await atomicWrite(targetRoot, file, jsonBytes(document), { mode: mode === undefined ? 0o644 : mode & 0o777 });
};

const writeFrame = async ({ targetRoot, prepared, captured, publish }) => {
  const { plan, state, root, legacy, context, key, directory } = prepared;
  const { values, computed, limitations: valueLimits, tagName } = captured.measured;
  const snapshot = await publish.file(`${directory}/snapshot.json`, jsonBytes(captured.snapshot));
  const screenshot = await publish.file(`${directory}/screenshot.png`, captured.screenshot);
  const measurements = await publish.file(`${directory}/measurements.json`, jsonBytes({
    viewport: plan.viewport,
    values,
    // Non-authoritative diagnostics: where the values were read. The validator reads viewport and values only.
    provenance: {
      element: plan.rootLocator,
      tagName,
      source: "getComputedStyle and getBoundingClientRect of the root element",
      ...(Object.keys(computed).length > 0 ? { computed } : {}),
      counts: plan.counts,
      assets: "img currentSrc, input[type=image] src, svg use/image href, background-image url() of each visible element and its ::before/::after; query strings dropped, data: URIs by sha256",
    },
  }));
  const limitations = [...valueLimits, ...captured.limitations];
  const frame = {
    id: key,
    uiBehaviorId: plan.uiBehaviorId,
    state: plan.state,
    states: [plan.state],
    viewport: plan.viewport,
    url: captured.url,
    rootLocator: plan.rootLocator,
    legacyRevision: state.legacyRevision?.revision,
    capturedAt: captured.executedAt,
    environment: captured.environment,
    capture: captured.capture,
    extraction: { retrievedAt: captured.executedAt, fidelity: limitations.length > 0 ? "DEGRADED" : "COMPLETE", limitations },
    sources: {
      snapshot: { reference: snapshot.reference, hash: snapshot.hash },
      screenshot: { reference: screenshot.reference, hash: screenshot.hash },
      measurements: { reference: measurements.reference, hash: measurements.hash },
    },
  };
  // The validator's own verdict on this frame alone, before it joins the
  // authored context: another frame's gaps must not decide this one.
  const check = await publish.file(`${directory}/.frame-check.json`, jsonBytes({ version: HARDENED_VISUAL_VERSION, frames: [frame] }));
  try {
    await validateLegacyRuntimeContext(root, state, check.reference, legacy);
  } catch (error) {
    refuseCapture("CAPTURE_FRAME_REFUSED", error.message.replaceAll(check.reference, LEGACY_RUNTIME_CONTEXT_FILE));
  } finally {
    await removeDurably(targetRoot, path.join(root, check.reference));
    publish.written.pop();
  }
  await replaceDocument(targetRoot, path.join(root, LEGACY_RUNTIME_CONTEXT_FILE), { ...context, frames: [...(context.frames ?? []), frame] });
  const recorded = new Set([...(context.frames ?? []).map((item) => item?.id), key]);
  const remaining = (legacy.uiBehaviors ?? []).flatMap((item) =>
    (item?.runtimeStates ?? []).map((runtimeState) => `${item.id}::${runtimeState}`)).filter((id) => !recorded.has(id));
  return {
    files: [snapshot, screenshot, measurements],
    record: LEGACY_RUNTIME_CONTEXT_FILE,
    observed: {
      facts: Object.keys(values).length,
      counts: Object.fromEntries(Object.keys(plan.counts).map((name) => [name, values[name]])),
      fidelity: frame.extraction.fidelity,
    },
    limitations,
    unresolved: [
      remaining.length > 0 && { field: "frames[]", count: remaining.length, items: remaining.slice(0, 20), need: "Capture every other discovered state that must be visually backed, or have the operator decide it VISUAL_UNBACKED at BUILD_BASELINE." },
    ].filter(Boolean),
    next: "Close ASSESS_TARGET through migration_run (the context is pinned there); then migration_prefill at BUILD_BASELINE derives the visual-acceptance rows and leaves each target locator to author.",
  };
};

const writeClaim = async ({ targetRoot, prepared, captured, publish }) => {
  const { plan, state, root, claim, uiBehavior, mismatch, result, resultFile, directory, bound } = prepared;
  const target = plan.role === "TARGET";
  const asEvidence = (entry) => ({ ...entry, reference: portablePath(path.relative(targetRoot, path.join(root, entry.reference))) });
  // Built, and refused if the contract fails, before the first byte is written.
  const snapshot = target ? targetProof({ snapshot: captured.snapshot, sliceId: state.activeSlice, traceId: bound.traceId, uiBehavior }) : captured.snapshot;
  const proof = asEvidence(await publish.file(`${directory}/${claim.id}.proof.json`, jsonBytes(snapshot)));
  const screenshot = asEvidence(await publish.file(`${directory}/${claim.id}.png`, captured.screenshot));
  const input = { state, sliceId: state.activeSlice, uiBehavior, mismatch, claim, plan, captured, files: { snapshot: proof, screenshot } };
  const row = target ? targetAppearanceRow({ ...input, implementationDigest: bound.implementationDigest }) : legacyAppearanceRow(input);
  await replaceDocument(targetRoot, path.join(root, resultFile), { ...result, uiEvidence: [...(result.uiEvidence ?? []), row] });
  return {
    files: [proof, screenshot],
    record: `${resultFile} uiEvidence[${(result.uiEvidence ?? []).length}]`,
    observed: { claim: claim.id, afterInteractionId: claim.afterInteractionId ?? null },
    limitations: captured.limitations,
    unresolved: [
      { field: "result", count: 1, need: `PASS only after confirming the ${plan.role} observation shows what the claim states; the capture observed it, it did not judge it.` },
      claim.afterInteractionId && { field: "interactions[].actual, interactions[].outcome", count: 2, need: `What the ${plan.role.toLowerCase()} interaction actually did, and PASS when that matches its expected outcome.` },
      target && visualAuthorityOf(state) && { field: "visualRowId", count: 1, need: "The visual acceptance row this capture answers, when one covers this behavior and state." },
    ].filter(Boolean),
    next: target
      ? `Complete the row, then validate the slice: it re-checks the proof, the bindings and the LEGACY/TARGET pair of claim '${claim.id}'.`
      : `Capture the TARGET row for claim '${claim.id}' with role TARGET at the same locator, compare ${captured.image.width}x${captured.image.height}, matte and color scheme; validation compares the two.`,
  };
};

/**
 * MC2. Capture one legacy-runtime state (or format-20 appearance claim) in a
 * real browser and persist it; return a compact summary, never the evidence.
 */
export const captureLegacyRuntimeEvidence = async ({ registryPath, moduleName, request }) => {
  const parsed = parseCaptureRequest(request);
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { targetRoot } = registryData;
  const input = { targetRoot, moduleName: resolved.canonical, request: parsed, roots: { legacyRoot: registryData.legacyRoot, targetRoot } };
  const before = await prepare(input);
  if (parsed.mode === "discovery") return checkClaims({ targetRoot, prepared: before, parsed, resolved });
  const captured = await (parsed.session
    ? captureThroughBroker(await sessionBrokerOf(targetRoot), before.plan, parsed.role ?? "LEGACY")
    : captureInBrowser(before.plan));
  return withModuleLock(targetRoot, resolved.canonical, async () => {
    const prepared = await prepare(input);
    if (prepared.fingerprint !== before.fingerprint) {
      refuseCapture("CAPTURE_CONFLICT", "The record moved while the browser was capturing; capture again against the current checkpoint.");
    }
    const publish = publisher(targetRoot, prepared.root);
    let outcome;
    try {
      outcome = await (parsed.mode === "frame" ? writeFrame : writeClaim)({ targetRoot, prepared, captured, publish });
    } catch (error) {
      await publish.rollback(prepared.directory);
      throw error;
    }
    const { scroll } = captured.snapshot.interactions[0]?.postAction ?? captured.snapshot.observation;
    return {
      module: resolved.canonical,
      step: prepared.state.currentStep,
      mode: parsed.mode,
      captured: { uiBehaviorId: prepared.plan.uiBehaviorId, state: prepared.plan.state, ...outcome.observed },
      destination: prepared.directory,
      written: [...outcome.files.map(({ reference, bytes, hash }) => ({ path: reference, bytes, hash })), outcome.record],
      browser: { environment: captured.environment, origin: parsed.origin, url: captured.url, viewport: parsed.viewport,
        deviceScaleFactor: 1, colorScheme: parsed.colorScheme, reducedMotion: "reduce", image: `${captured.image.width}x${captured.image.height}` },
      authority: { legacyRevision: prepared.state.legacyRevision?.revision ?? null },
      measured: { controls: prepared.plan.controls.length, scrollOwner: scroll.owner.kind, ancestors: scroll.ancestors.length },
      limitations: outcome.limitations,
      unresolved: outcome.unresolved,
      operations: captured.operations,
      durationMs: captured.durationMs,
      next: outcome.next,
      note: "Captured evidence is observation, not acceptance: nothing was pinned, approved, advanced or marked PASS. Validation decides.",
    };
  });
};
