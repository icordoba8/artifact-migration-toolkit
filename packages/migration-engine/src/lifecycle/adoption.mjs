/**
 * Lifecycle: visual-contract and required-observation adoption. Moved verbatim
 * from `resumable-migration.mjs` (Track A8).
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { validateTargetInventory } from "../census/index.mjs";
import {
  FIGMA_CONTEXT_ADOPTION_FILE,
  FIGMA_CONTEXT_FILE,
  initialArtifacts,
  INTEGRITY_FILE,
  REQUIRED_OBSERVATIONS_FORMAT,
  stepsFor,
  UI_OBSERVATIONS_ADOPTION_ROOT,
  UI_OBSERVATIONS_CANDIDATE_FILE,
  UI_PROOF_FORMAT,
  UI_VERIFICATION_FORMAT,
  usesDesignSource,
  usesRequiredObservations,
  usesUiVerification,
  usesVisualAcceptance,
  VISUAL_ACCEPTANCE_FILE,
  VISUAL_ACCEPTANCE_FORMAT,
} from "../formats/index.mjs";
import { contentIdentity, now, sha256Hex as hashContent } from "../shared/index.mjs";
import {
  assertHistoryAppendable,
  atomicWrite,
  fileExists,
  fileIdentity,
  hashFile,
  migrationRoot,
  renderState,
  statePathFor,
} from "../store/index.mjs";
import { withModuleLock, writeJournalAtomic } from "./lock.mjs";
import {
  assertRequiredObservations,
  FIGMA_SOURCE_KINDS,
  validateVisualAcceptance,
} from "../visual/index.mjs";
import { inspectSliceArtifacts } from "../slices/index.mjs";
import { activeArtifact, ADOPTION_ROOT } from "./checkpoints.mjs";
import { readContext } from "./context.mjs";
import {
  ADVANCE_JOURNAL,
  appendHistoryOnce,
  IMMUTABLE_STEP_ARTIFACTS,
  readAdvanceJournal,
  readState,
  recoverPendingAdvance,
  renderIntegrityNow,
} from "./record.mjs";
import { assertRecordToolkitIdentity } from "./toolkit-identity.mjs";
import { validateLegacyInventory } from "./validation.mjs";

/**
 * `--adopt-visual-contract`: the one way a pre-17 figma-mcp record opts into
 * the format-17 visual contract. Read-only; shared by the preview and the
 * transition so both refuse for the same reasons.
 *
 * Eligible only as a COMPLETE, pre-17, figma-mcp record, so no transition can
 * be in flight and the adoption can never double as a refresh, replan, or
 * reset. Fails closed unless fresh canonical evidence authored at
 * FIGMA_CONTEXT_ADOPTION_FILE and VISUAL_ACCEPTANCE_FILE validate under the
 * unweakened format-17 rules. Nothing is derived from the old context.
 *
 * Affected slices are exactly those whose verified evidence holds a TARGET
 * UI row: each binds the old `figmaContextDigest`, so none can verify under
 * the new pin. A COMPLETE record has no non-terminal design row (FINALIZE
 * refused one), so no other slice can fail format-17 verification.
 */
export const visualContractAdoptionPlan = async (root, state, roots, allowActive = false) => {
  const refuse = (message) => ({
    blockers: [message],
    affectedSlices: [],
    evidenceDigest: null,
  });
  if (!(usesDesignSource(state) && state.designSource === "figma-mcp")) {
    return refuse(
      `--adopt-visual-contract applies only to a designSource: figma-mcp migration; this record's design source is '${state.designSource ?? "target-system"}'.`,
    );
  }
  if (usesVisualAcceptance(state)) {
    return refuse(
      `--adopt-visual-contract moves a pre-format-${VISUAL_ACCEPTANCE_FORMAT} record onto the visual contract once; this record is already format ${state.formatVersion}. It is not a refresh, replan, or reset.`,
    );
  }
  if (state.status !== "COMPLETE" && !(allowActive && state.status === "ACTIVE")) {
    return refuse(
      `--adopt-visual-contract is legal only for a COMPLETE migration; the current status is '${state.status}' at '${state.currentStep}'.`,
    );
  }
  if (await fileExists(path.join(root, ADOPTION_ROOT))) {
    return refuse(
      `${ADOPTION_ROOT}/ already exists. A record adopts the visual contract once.`,
    );
  }
  const adopted = { ...state, formatVersion: VISUAL_ACCEPTANCE_FORMAT };
  try {
    const legacy = await validateLegacyInventory(root, roots, adopted);
    const target = await validateTargetInventory(root, roots, legacy, adopted);
    await validateVisualAcceptance(
      root,
      adopted,
      legacy,
      target,
      FIGMA_CONTEXT_ADOPTION_FILE,
    );
  } catch (error) {
    return refuse(
      `Visual contract adoption fails closed: ${error.message} Author fresh format-${VISUAL_ACCEPTANCE_FORMAT} evidence from the Figma MCP at ${FIGMA_CONTEXT_ADOPTION_FILE}, and ${VISUAL_ACCEPTANCE_FILE} from it.`,
    );
  }
  const affectedSlices = [];
  for (const sliceId of [
    ...state.completedSlices,
    ...(allowActive && state.currentStep === "VERIFY_SLICES" && state.activeSlice
      ? [state.activeSlice]
      : []),
  ]) {
    const evidence = await readFile(
      path.join(root, `evidence/${sliceId}/result.json`),
      "utf8",
    ).then(JSON.parse, () => null);
    if (
      (evidence.uiEvidence ?? []).some(
        (record) => (record.origin ?? "TARGET") === "TARGET",
      )
    ) {
      affectedSlices.push(sliceId);
    }
  }
  return {
    blockers: [],
    affectedSlices,
    evidenceDigest: `sha256:${hashContent(
      JSON.stringify([
        await hashFile(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE)),
        await hashFile(path.join(root, VISUAL_ACCEPTANCE_FILE)),
      ]),
    )}`,
  };
};

export const adoptVisualContractUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  adoption,
}) => {
  const plan = await visualContractAdoptionPlan(root, state, {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  });
  if (plan.blockers.length > 0) {
    throw new Error(`${plan.blockers.join(" ")} Nothing was written.`);
  }
  if (plan.evidenceDigest !== adoption.evidenceDigest) {
    throw new Error(
      "The adoption evidence changed after it was confirmed. Nothing was written; show the summary again and reconfirm.",
    );
  }
  const at = now();
  const previousRelative = `${ADOPTION_ROOT}/figma-context.previous.json`;
  const recordRelative = `${ADOPTION_ROOT}/record.json`;
  const previousBytes = await readFile(path.join(root, FIGMA_CONTEXT_FILE));
  const adoptedBytes = await readFile(
    path.join(root, FIGMA_CONTEXT_ADOPTION_FILE),
  );
  // Both become ordinary `artifactHashes` pins below, so they are content
  // identities. `plan.evidenceDigest` above stays a raw-byte confirmation
  // preimage and is deliberately not routed here.
  const figmaContextDigest = contentIdentity(FIGMA_CONTEXT_FILE, adoptedBytes);
  const visualAcceptanceDigest = await fileIdentity(
    path.join(root, VISUAL_ACCEPTANCE_FILE),
  );
  const record = `${JSON.stringify(
    {
      version: 1,
      transition: "VISUAL_CONTRACT_ADOPTED",
      note: "Adoption of the format-17 Figma visual acceptance contract. Not a legacy refresh, replan, or migration restart.",
      migrationId: state.migrationId,
      fromFormat: state.formatVersion,
      toFormat: VISUAL_ACCEPTANCE_FORMAT,
      at,
      operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
      confirmationId: adoption.confirmationId,
      priorRevision: state.revision,
      previous: {
        figmaContext: previousRelative,
        figmaContextDigest: state.artifactHashes[FIGMA_CONTEXT_FILE],
      },
      adopted: {
        evidenceDigest: plan.evidenceDigest,
        figmaContextDigest,
        visualAcceptanceDigest,
        frames: JSON.parse(adoptedBytes.toString("utf8")).frames.map(
          (frame) => ({
            fileKey: frame.fileKey,
            nodeId: frame.nodeId,
            ...(frame.ancestry && {
              ancestry: {
                sourceNodeId: frame.ancestry.sourceNodeId,
                path: frame.ancestry.path,
                metadata: frame.ancestry.metadata.hash,
              },
            }),
            fidelity: frame.extraction.fidelity,
            sources: Object.fromEntries(
              FIGMA_SOURCE_KINDS.map((kind) => [
                kind,
                [frame.sources[kind]].flat().map((entry) => entry.hash),
              ]),
            ),
          }),
        ),
      },
      affectedSlices: plan.affectedSlices,
    },
    null,
    2,
  )}\n`;
  const preserved = {
    [previousRelative]: hashContent(previousBytes),
    [recordRelative]: hashContent(record),
  };
  const adopted = {
    ...state,
    formatVersion: VISUAL_ACCEPTANCE_FORMAT,
    visualContractAdoption: {
      fromFormat: state.formatVersion,
      toFormat: VISUAL_ACCEPTANCE_FORMAT,
      adoptedAt: at,
      record: recordRelative,
      pendingReverification: plan.affectedSlices,
    },
    ...(plan.affectedSlices.length > 0
      ? {
          invalidatedArtifacts: plan.affectedSlices.map(
            (sliceId) => `evidence/${sliceId}/result.json`,
          ),
          evidenceFreshness: "STALE",
          nextAction: `Visual contract adopted. Reopen the slices whose Figma visual evidence predates it: --reopen-ui ${plan.affectedSlices.join(",")}.`,
        }
      : {}),
    artifactHashes: {
      ...state.artifactHashes,
      ...preserved,
      [FIGMA_CONTEXT_FILE]: figmaContextDigest,
      [VISUAL_ACCEPTANCE_FILE]: visualAcceptanceDigest,
    },
    revision: state.revision + 1,
    updatedAt: at,
  };
  const event = {
    event: "VISUAL_CONTRACT_ADOPTED",
    fromFormat: state.formatVersion,
    toFormat: VISUAL_ACCEPTANCE_FORMAT,
    affectedSlices: plan.affectedSlices,
    preserved: Object.keys(preserved).sort(),
    confirmationId: adoption.confirmationId,
    previousFigmaContextDigest: state.artifactHashes[FIGMA_CONTEXT_FILE],
    figmaContextDigest,
    visualAcceptanceDigest,
    at,
    revision: adopted.revision,
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, adopted, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: adopted.revision,
    event,
    startedAt: at,
    pid: process.pid,
    restore: [
      { path: previousRelative, remove: true },
      { path: recordRelative, remove: true },
      { path: FIGMA_CONTEXT_FILE, content: previousBytes.toString("utf8") },
      {
        path: FIGMA_CONTEXT_ADOPTION_FILE,
        content: adoptedBytes.toString("utf8"),
      },
    ],
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  for (const [relative, bytes] of [
    [previousRelative, previousBytes],
    [recordRelative, record],
    [FIGMA_CONTEXT_FILE, adoptedBytes],
  ]) {
    await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
  }
  await rm(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE));
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(adopted));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    adopted: true,
    statePath,
    migrationRoot: root,
    state: adopted,
    nextArtifact: null,
    resolved,
  };
};

/**
 * UI_OBSERVATIONS_ADOPTED: the one way a pre-18 UI record gains the frozen
 * `requiredObservations` acceptance set. Read-only; shared by the preview and
 * the transaction so both refuse for the same reasons.
 *
 * The candidate is a complete `inventories/legacy.json` authored from legacy
 * runtime/source evidence and the pinned OpenSpec authority, and may differ
 * from the pinned inventory only by the added arrays. No TARGET proof is an
 * input. Affected slices are the completed slices, and a VERIFY_SLICES active
 * slice, whose result holds TARGET UI evidence: that evidence binds the old
 * UI-contract digest. They are preserved, then invalidated and requeued at
 * VERIFY_SLICES (the COMPLETE_REOPENED release shape), never reimplemented.
 */
export const uiObservationsAdoptionPlan = async (root, state, combined = false) => {
  const refuse = (message) => ({ blockers: [message] });
  const legacyRelative = initialArtifacts.legacyInventory;
  if (usesRequiredObservations(state)) {
    return refuse(
      `This record is already format ${state.formatVersion}; UI_OBSERVATIONS_ADOPTED moves a pre-${REQUIRED_OBSERVATIONS_FORMAT} record once and is not a correction path.`,
    );
  }
  if (!usesUiVerification(state) || !state.artifactHashes?.[legacyRelative]) {
    return refuse(
      `UI_OBSERVATIONS_ADOPTED needs a pinned format-${UI_VERIFICATION_FORMAT}+ legacy inventory; this record has none to adopt into.`,
    );
  }
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) {
    return refuse(
      `UI_OBSERVATIONS_ADOPTED is legal only for an ACTIVE or COMPLETE migration; the current status is '${state.status}'.`,
    );
  }
  // A pre-17 Figma record may reach 18 only through the combined adoption.
  if (state.designSource === "figma-mcp" && !usesVisualAcceptance(state) && !combined) {
    return refuse(
      `A pre-format-${VISUAL_ACCEPTANCE_FORMAT} figma-mcp record would be promoted into the visual contract by format ${REQUIRED_OBSERVATIONS_FORMAT}; adopt the visual contract first (--adopt-visual-contract).`,
    );
  }
  if (await readAdvanceJournal(root)) {
    return refuse("An advance journal is pending; resume the migration first.");
  }
  if (await fileExists(path.join(root, UI_OBSERVATIONS_ADOPTION_ROOT, "record.json"))) {
    return refuse(`${UI_OBSERVATIONS_ADOPTION_ROOT}/record.json already exists. A record adopts once.`);
  }
  const candidatePath = path.join(root, UI_OBSERVATIONS_CANDIDATE_FILE);
  if (!(await fileExists(candidatePath))) {
    return refuse(
      `No legacy authority to adopt: author ${UI_OBSERVATIONS_CANDIDATE_FILE} from legacy runtime/source evidence and the pinned OpenSpec requirements. TARGET proof cannot supply it.`,
    );
  }
  const candidateBytes = await readFile(candidatePath);
  const current = JSON.parse(await readFile(path.join(root, legacyRelative), "utf8"));
  let candidate;
  try {
    candidate = JSON.parse(candidateBytes.toString("utf8"));
    const frozen = (inventory) =>
      JSON.stringify({
        ...inventory,
        uiBehaviors: (inventory.uiBehaviors ?? []).map(
          ({ requiredObservations: _added, ...rest }) => rest,
        ),
      });
    if (frozen(candidate) !== frozen(current)) {
      throw new Error(
        "The candidate may only add requiredObservations; every other field of the pinned legacy inventory is frozen.",
      );
    }
    if (!candidate.hasVisibleUi) {
      throw new Error("A record with no visible UI has no UI adoption obligation.");
    }
    const seen = new Set();
    for (const item of candidate.uiBehaviors) {
      assertRequiredObservations(item, seen);
    }
  } catch (error) {
    return refuse(`UI observation adoption fails closed: ${error.message}`);
  }
  const affected = [];
  for (const sliceId of [...state.completedSlices, state.activeSlice]) {
    if (!sliceId || affected.includes(sliceId)) continue;
    if (sliceId === state.activeSlice && state.currentStep !== "VERIFY_SLICES") continue;
    const evidence = await readFile(
      path.join(root, `evidence/${sliceId}/result.json`),
      "utf8",
    ).then(JSON.parse, () => null);
    if (
      (evidence?.uiEvidence ?? []).some(
        (record) => (record.origin ?? "TARGET") === "TARGET",
      )
    ) {
      affected.push(sliceId);
    }
  }
  const planned = (await inspectSliceArtifacts(root)).plannedSlices;
  const affectedSlices = planned.filter((sliceId) => affected.includes(sliceId));
  const requeued = affectedSlices.filter((sliceId) =>
    state.completedSlices.includes(sliceId),
  );
  if (
    requeued.length > 0 &&
    state.status === "ACTIVE" &&
    !["VERIFY_SLICES", "FINALIZE"].includes(state.currentStep)
  ) {
    return refuse(
      `Completed UI slices ${requeued.join(", ")} must be requeued at VERIFY_SLICES; advance the active slice to VERIFY_SLICES, then adopt.`,
    );
  }
  const reopen =
    affectedSlices.length > 0 &&
    (state.status === "COMPLETE" ||
      state.currentStep === "FINALIZE" ||
      requeued.length > 0);
  return {
    blockers: [],
    candidate: candidateBytes.toString("utf8"),
    candidateBytes,
    candidateDigest: `sha256:${hashContent(candidateBytes)}`,
    previousLegacyDigest: state.artifactHashes[legacyRelative],
    affectedSlices,
    reopen,
    pendingSlices: reopen
      ? planned.filter(
          (sliceId) =>
            affectedSlices.includes(sliceId) ||
            state.pendingSlices.includes(sliceId) ||
            sliceId === state.activeSlice,
        )
      : state.pendingSlices,
  };
};

const combinedUiAdoptionPlan = async (root, state, roots) => {
  const combined = state.designSource === "figma-mcp" && !usesVisualAcceptance(state);
  const observations = await uiObservationsAdoptionPlan(root, state, combined);
  if (!combined || observations.blockers.length > 0) return observations;
  const visual = await visualContractAdoptionPlan(root, state, roots, true);
  if (visual.blockers.length > 0) return { blockers: visual.blockers };
  return {
    ...observations,
    visualEvidenceDigest: visual.evidenceDigest,
    confirmationDigest: `sha256:${hashContent(JSON.stringify([
      observations.candidateDigest,
      visual.evidenceDigest,
    ]))}`,
    affectedSlices: [...new Set([...observations.affectedSlices, ...visual.affectedSlices])],
  };
};

/** The exact candidate bytes and their digest; confirmation must echo the digest. */
export const previewUiObservationsAdoption = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { state } = await readState(registryData.targetRoot, resolved.canonical);
  const { candidateBytes: _bytes, ...plan } = await combinedUiAdoptionPlan(
    migrationRoot(registryData.targetRoot, resolved.canonical),
    state,
    { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot },
  );
  return plan;
};

/**
 * One journalled transaction: preserve the prior inventory, affected results
 * and FINALIZE gates byte-for-byte and pin them for life, swap the candidate
 * in, move the legacy pin, stamp format 18, release only the affected result
 * and gate pins, and append one UI_OBSERVATIONS_ADOPTED event. Nothing is
 * released before its preserved copy is in the pin set.
 */
export const adoptUiObservations = async ({
  registryPath,
  moduleName,
  candidateDigest,
  confirmationDigest,
  // Set only by `commitFormatUpgrade` for the registered adjacent 17 -> 18 row.
  // It changes the history envelope and nothing else: the transaction, the
  // writes, the pins and the preserved bytes are the same ones the pre-floor
  // explicit adoption has always made, because there is only one of them.
  formatUpgrade = null,
}) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  return withModuleLock(registryData.targetRoot, resolved.canonical, async () => {
    const root = migrationRoot(registryData.targetRoot, resolved.canonical);
    const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
    await recoverPendingAdvance(registryData.targetRoot, root, statePath);
    const { state } = await readState(registryData.targetRoot, resolved.canonical);
    assertRecordToolkitIdentity(state, resolved.canonical, "adopt required UI observations");
    const plan = await combinedUiAdoptionPlan(root, state, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
    if (plan.blockers.length > 0) {
      throw new Error(`${plan.blockers.join(" ")} Nothing was written.`);
    }
    if (plan.confirmationDigest) {
      if (plan.confirmationDigest !== confirmationDigest) {
        throw new Error(
          "The adoption inputs changed after preview, or the complete transition was not confirmed. Nothing was written; preview again and confirm its digest.",
        );
      }
    } else if (plan.candidateDigest !== candidateDigest) {
      throw new Error(
        "The candidate changed after it was previewed, or was never previewed. Nothing was written; preview again and confirm its digest.",
      );
    }
    const at = now();
    const legacyRelative = initialArtifacts.legacyInventory;
    const keep = (relative) => `${UI_OBSERVATIONS_ADOPTION_ROOT}/${relative}`;
    const previousLegacy = await readFile(path.join(root, legacyRelative));
    const writes = [[keep(legacyRelative), previousLegacy]];
    const rewrites = [
      { relative: legacyRelative, before: previousLegacy, content: plan.candidateBytes },
    ];
    let figmaContextDigest;
    let visualAcceptanceDigest;
    if (plan.confirmationDigest) {
      const previousContext = await readFile(path.join(root, FIGMA_CONTEXT_FILE));
      const adoptedContext = await readFile(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE));
      writes.push([keep(FIGMA_CONTEXT_FILE), previousContext]);
      rewrites.push({
        relative: FIGMA_CONTEXT_FILE,
        before: previousContext,
        content: adoptedContext,
      });
      figmaContextDigest = contentIdentity(FIGMA_CONTEXT_FILE, adoptedContext);
      visualAcceptanceDigest = await fileIdentity(path.join(root, VISUAL_ACCEPTANCE_FILE));
    }
    for (const sliceId of plan.affectedSlices) {
      const relative = `evidence/${sliceId}/result.json`;
      const before = await readFile(path.join(root, relative));
      writes.push([keep(relative), before]);
      rewrites.push({
        relative,
        before,
        content: `${JSON.stringify(
          {
            ...JSON.parse(before.toString("utf8")),
            result: "PENDING",
            uiEvidence: [],
            uiEvidenceLimitations: [],
          },
          null,
          2,
        )}\n`,
      });
    }
    if (plan.reopen) {
      for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
        if (state.artifactHashes[relative]) {
          writes.push([keep(relative), await readFile(path.join(root, relative))]);
        }
      }
    }
    const preserved = {};
    for (const [relative, bytes] of writes) preserved[relative] = hashContent(bytes);
    const legacyDigest = contentIdentity(legacyRelative, plan.candidateBytes);
    const recordRelative = keep("record.json");
    const record = `${JSON.stringify(
      {
        version: 1,
        transition: "UI_OBSERVATIONS_ADOPTED",
        ...(formatUpgrade ? { upgrader: formatUpgrade.upgrader } : {}),
        note: "Adoption of the format-18 required UI observations contract from legacy authority. Not a refresh, replan, or restart; no TARGET proof was an input.",
        migrationId: state.migrationId,
        fromFormat: state.formatVersion,
        toFormat: REQUIRED_OBSERVATIONS_FORMAT,
        at,
        operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
        priorRevision: state.revision,
        priorStatus: state.status,
        priorStep: state.currentStep,
        candidateDigest: plan.candidateDigest,
        ...(plan.confirmationDigest ? {
          confirmationDigest: plan.confirmationDigest,
          visualEvidenceDigest: plan.visualEvidenceDigest,
          previousFigmaContextDigest: state.artifactHashes[FIGMA_CONTEXT_FILE],
          figmaContextDigest,
          visualAcceptanceDigest,
        } : {}),
        previousLegacyDigest: plan.previousLegacyDigest,
        legacyDigest,
        affectedSlices: plan.affectedSlices,
        preserved: { ...preserved },
      },
      null,
      2,
    )}\n`;
    writes.push([recordRelative, Buffer.from(record, "utf8")]);
    preserved[recordRelative] = hashContent(record);

    const artifactHashes = {
      ...state.artifactHashes,
      ...preserved,
      [legacyRelative]: legacyDigest,
      ...(plan.confirmationDigest ? {
        [FIGMA_CONTEXT_FILE]: figmaContextDigest,
        [VISUAL_ACCEPTANCE_FILE]: visualAcceptanceDigest,
      } : {}),
    };
    if (plan.reopen) {
      for (const sliceId of plan.affectedSlices) {
        delete artifactHashes[`evidence/${sliceId}/result.json`];
      }
      for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
        delete artifactHashes[relative];
      }
    }
    const steps = stepsFor(state);
    const activeSlice = plan.reopen ? plan.pendingSlices[0] : state.activeSlice;
    const adopted = {
      ...state,
      formatVersion: REQUIRED_OBSERVATIONS_FORMAT,
      ...(plan.confirmationDigest ? {
        visualContractAdoption: {
          fromFormat: state.formatVersion,
          toFormat: REQUIRED_OBSERVATIONS_FORMAT,
          adoptedAt: at,
          record: recordRelative,
          pendingReverification: [],
        },
      } : {}),
      ...(plan.reopen
        ? {
            status: "ACTIVE",
            currentStep: "VERIFY_SLICES",
            activeSlice,
            completedSteps: steps.slice(0, steps.indexOf("IMPLEMENT_SLICES")),
            pendingSteps: ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"],
            completedSlices: state.completedSlices.filter(
              (sliceId) => !plan.affectedSlices.includes(sliceId),
            ),
            pendingSlices: plan.pendingSlices,
          }
        : {}),
      ...(plan.affectedSlices.length > 0
        ? {
            invalidatedArtifacts: [
              ...plan.affectedSlices.map((sliceId) => `evidence/${sliceId}/result.json`),
              ...(plan.reopen ? IMMUTABLE_STEP_ARTIFACTS.FINALIZE : []),
            ],
            evidenceFreshness: "STALE",
          }
        : {}),
      nextAction: `Required UI observations adopted. Collect fresh ${UI_PROOF_FORMAT} proof and verify ${activeSlice ?? "the pending UI slices"} under the adopted contract.`,
      nextCommand: `/start-migration ${resolved.canonical}`,
      artifactHashes,
      revision: state.revision + 1,
      updatedAt: at,
    };
    const domainEvent = {
      event: "UI_OBSERVATIONS_ADOPTED",
      from: state.status === "COMPLETE" ? "COMPLETE" : state.currentStep,
      fromFormat: state.formatVersion,
      toFormat: REQUIRED_OBSERVATIONS_FORMAT,
      ...(plan.reopen ? { step: "VERIFY_SLICES", activeSlice } : {}),
      slices: plan.affectedSlices,
      candidateDigest: plan.candidateDigest,
      ...(plan.confirmationDigest ? {
        confirmationDigest: plan.confirmationDigest,
        visualEvidenceDigest: plan.visualEvidenceDigest,
        figmaContextDigest,
        visualAcceptanceDigest,
      } : {}),
      previousLegacyDigest: plan.previousLegacyDigest,
      legacyDigest,
      preserved: Object.keys(preserved).sort(),
      at,
      revision: adopted.revision,
    };
    // One event per transaction, so the canonical `FORMAT_UPGRADED` envelope
    // wraps the domain fields instead of adding a second row. The pre-floor
    // explicit adoption keeps writing the historical spelling: rewriting an
    // append-only log is not an option, so both spellings are read forever
    // (`isUiObservationsAdoption`).
    const event = formatUpgrade
      ? {
          ...domainEvent,
          event: "FORMAT_UPGRADED",
          transition: "UI_OBSERVATIONS_ADOPTED",
          domain: "TRANSFORM",
          upgrader: formatUpgrade.upgrader,
          inputs: [
            {
              kind: formatUpgrade.requiredInput?.kind ?? "candidateFile",
              path: formatUpgrade.requiredInput?.path ?? UI_OBSERVATIONS_CANDIDATE_FILE,
              digest: plan.candidateDigest,
            },
          ],
          priorRevision: state.revision,
          revision: adopted.revision,
          priorStateDigest: `sha256:${hashContent(renderState(state))}`,
          stateDigest: `sha256:${hashContent(renderState(adopted))}`,
          priorStep: state.currentStep,
          activeSlice: activeSlice ?? null,
        }
      : domainEvent;
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = await readFile(integrityPath, "utf8");
    const nextIntegrity = await renderIntegrityNow(root, adopted, event);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await assertHistoryAppendable(registryData.targetRoot, root);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: adopted.revision,
      event,
      startedAt: at,
      pid: process.pid,
      restore: [
        ...writes.map(([relative]) => ({ path: relative, remove: true })),
        ...rewrites.map(({ relative, before }) => ({
          path: relative,
          content: before.toString("utf8"),
        })),
        { path: UI_OBSERVATIONS_CANDIDATE_FILE, content: plan.candidate },
        ...(plan.confirmationDigest ? [{
          path: FIGMA_CONTEXT_ADOPTION_FILE,
          content: (await readFile(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE))).toString("utf8"),
        }] : []),
      ],
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    for (const [relative, bytes] of writes) {
      await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
    }
    for (const rewrite of rewrites) {
      await atomicWrite(
        registryData.targetRoot,
        path.join(root, rewrite.relative),
        rewrite.content,
      );
    }
    await rm(path.join(root, UI_OBSERVATIONS_CANDIDATE_FILE));
    if (plan.confirmationDigest) await rm(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE));
    await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
    await atomicWrite(registryData.targetRoot, statePath, renderState(adopted));
    await appendHistoryOnce(registryData.targetRoot, root, event);
    await rm(journalFile, { force: true });
    return {
      changed: true,
      adopted: true,
      statePath,
      migrationRoot: root,
      state: adopted,
      affectedSlices: plan.affectedSlices,
      nextArtifact: activeArtifact(adopted),
      resolved,
    };
  });
};
