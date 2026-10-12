/**
 * Lifecycle: reopening and repair -- discovery reopen, slice rework and
 * amendment, UI-proof reopen, complete-migration reopen, and slice state
 * repair. Moved verbatim from `resumable-migration.mjs` (Track A8).
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertNoPendingFormatUpgrade,
  initialArtifacts,
  INTEGRITY_FILE,
  stampedFormatVersion,
  STEP_FILES,
  stepsFor,
  UI_PROOF_FORMAT,
  UI_REMEDIATION_FILE,
} from "../formats/index.mjs";
import {
  contentIdentity,
  gitRevision,
  headRevision,
  now,
  sha256Hex as hashContent,
} from "../shared/index.mjs";
import {
  assertHistoryAppendable,
  atomicWrite,
  evidencePathClaim,
  fileExists,
  fileIdentity,
  readHistoryEvents,
  readJson,
  renderState,
  REOPEN_ROOT,
  resolveEvidencePath,
} from "../store/index.mjs";
import { withModuleLock, writeJournalAtomic } from "./lock.mjs";
import {
  completedSlicesLackingUiProofV1,
  reopenUiEligible,
  reopenUiIneligible,
} from "../visual/index.mjs";
import { sequenceAuthorizationEvidence } from "../decisions/index.mjs";
import { inspectSliceArtifacts, planSliceRework, reconcileSliceState } from "../slices/index.mjs";
import { activeArtifact } from "./checkpoints.mjs";
import {
  ADVANCE_JOURNAL,
  appendHistoryOnce,
  hashPinnedArtifact,
  IMMUTABLE_STEP_ARTIFACTS,
  pinnedArtifactMatches,
  readAdvanceJournal,
  readState,
  renderIntegrityNow,
} from "./record.mjs";
import { assertRecordToolkitIdentity } from "./toolkit-identity.mjs";
import { sliceAmendmentFor, validateLegacyInventory } from "./validation.mjs";

export const repairSliceState = async (targetRoot, moduleName) =>
  withModuleLock(targetRoot, moduleName, async () => {
    const { state, statePath, root } = await readState(targetRoot, moduleName);
    assertRecordToolkitIdentity(state, moduleName, "Repairing this migration's slice state");
    assertNoPendingFormatUpgrade(
      state,
      moduleName,
      "Repairing this migration's slice state",
    );
    const reconciliation = await reconcileSliceState(root, state);
    const artifactHashes = { ...state.artifactHashes };
    const hashRepairs = [];
    for (const sliceId of reconciliation.state.completedSlices) {
      for (const relative of [
        `slices/${sliceId}.json`,
        `evidence/${sliceId}/result.json`,
      ]) {
        // A pin the shared matcher still accepts is not a corrupted pin, so a
        // checkout that only re-spelled line endings must not be "repaired"
        // into a rewritten record.
        if (
          !(await pinnedArtifactMatches(root, relative, artifactHashes[relative]))
        ) {
          hashRepairs.push(`re-pinned corrected ${relative}`);
          artifactHashes[relative] = await hashPinnedArtifact(root, relative);
        }
      }
    }
    const repairs = [...reconciliation.repairs, ...hashRepairs];
    if (repairs.length === 0) return { changed: false, repairs };
    const repaired = {
      ...reconciliation.state,
      artifactHashes,
      nextAction:
        reconciliation.state.currentStep === "VERIFY_SLICES"
          ? `Verify slice ${reconciliation.state.activeSlice}.`
          : reconciliation.state.currentStep === "IMPLEMENT_SLICES"
            ? `Implement slice ${reconciliation.state.activeSlice}.`
            : `Complete ${STEP_FILES[reconciliation.state.currentStep]}.`,
      revision: state.revision + 1,
      updatedAt: now(),
    };
    const event = {
      event: "SLICE_STATE_RECONCILED",
      currentStep: repaired.currentStep,
      activeSlice: repaired.activeSlice,
      completedSlices: repaired.completedSlices,
      repairs,
      revision: repaired.revision,
    };
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = (await fileExists(integrityPath))
      ? await readFile(integrityPath, "utf8")
      : null;
    const nextIntegrity = await renderIntegrityNow(root, repaired, event);
    await assertHistoryAppendable(targetRoot, root);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: repaired.revision,
      event,
      startedAt: now(),
      pid: process.pid,
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    await atomicWrite(targetRoot, integrityPath, nextIntegrity);
    await atomicWrite(targetRoot, statePath, renderState(repaired));
    await appendHistoryOnce(targetRoot, root, event);
    await rm(journalFile, { force: true });
    return { changed: true, repairs, state: repaired };
  });

/**
 * Reopen DISCOVER_LEGACY from DISCOVERY_COMPLETENESS.
 *
 * The census found a file the inventory never described, so the fix is in
 * `inventories/legacy.json` -- which DISCOVER_LEGACY closed and pinned. This
 * is the only way back to it, and it is legal only from the checkpoint
 * immediately after, so nothing downstream can exist to lose. `--refresh`
 * would also work, but it invalidates the entire migration for what is a
 * one-step correction.
 *
 * Operator decisions are deliberately *not* invalidated: they bind to the
 * discovery digest, so a reopen that changes no fact leaves them valid, and a
 * reopen that changes the facts invalidates them by itself.
 */
export const reopenDiscoveryUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
}) => {
  if (state.currentStep !== "DISCOVERY_COMPLETENESS") {
    throw new Error(
      `--reopen-discovery is legal only from DISCOVERY_COMPLETENESS; the current checkpoint is '${state.currentStep}'. Nothing was changed. Use --refresh --confirm-mismatch to invalidate a migration from a later checkpoint.`,
    );
  }
  const artifactHashes = { ...state.artifactHashes };
  for (const relative of IMMUTABLE_STEP_ARTIFACTS.DISCOVER_LEGACY) {
    delete artifactHashes[relative];
  }
  const reopened = {
    ...state,
    status: "ACTIVE",
    currentStep: "DISCOVER_LEGACY",
    activeSlice: null,
    completedSteps: state.completedSteps.filter(
      (step) => step !== "DISCOVER_LEGACY",
    ),
    pendingSteps: stepsFor(state).filter(
      (step) => step === "DISCOVER_LEGACY" || state.pendingSteps.includes(step),
    ),
    invalidatedArtifacts: [...IMMUTABLE_STEP_ARTIFACTS.DISCOVER_LEGACY],
    evidenceFreshness: "STALE",
    nextAction:
      "Describe the files the census found but the inventory does not, then close DISCOVER_LEGACY again.",
    nextCommand: `/start-migration ${resolved.canonical}`,
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "REOPENED",
    from: "DISCOVERY_COMPLETENESS",
    step: "DISCOVER_LEGACY",
    revision: reopened.revision,
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = (await fileExists(integrityPath))
    ? await readFile(integrityPath, "utf8")
    : null;
  const nextIntegrity = await renderIntegrityNow(root, reopened, event);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(path.join(root, ADVANCE_JOURNAL), {
    fromRevision: state.revision,
    toRevision: reopened.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reopened));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(path.join(root, ADVANCE_JOURNAL), { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reopened,
    nextArtifact: activeArtifact(reopened),
    resolved,
  };
};

/**
 * W3-2. The operator transition. Runs under the module lock, in one journalled
 * transaction, in exactly this order:
 *
 *   1. preserve the failed attempt byte-for-byte, plus every file its defects
 *      name, under `rework/<slice>-<n>/`;
 *   2. pin every preserved path into `artifactHashes` permanently;
 *   3. only then release `slices/<slice>.json` and `evidence/<slice>/result.json`
 *      and move back to IMPLEMENT_SLICES on the same slice.
 *
 * If 1 or 2 fails the transaction aborts and nothing is unpinned.
 */
export const reworkSliceUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  sliceId,
}) => {
  const { writes, reworked, event } = await planSliceRework({
    root,
    state,
    sliceId,
    roots: {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    },
    canonical: resolved.canonical,
  });

  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, reworked, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: reworked.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    // Recovery removes a half-written preserved tree rather than leaving a
    // partial attempt pinned. The current result is untouched until step 3, so
    // there is nothing of the failure to restore.
    restore: writes.map(([relative]) => ({ path: relative, remove: true })),
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  for (const [relative, bytes] of writes) {
    await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
  }
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reworked));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reworked,
    nextArtifact: activeArtifact(reworked),
    resolved,
  };
};

/**
 * `--amend-slice`: add files to a reopened slice's pinned record, in one
 * journalled transaction and in exactly this order -- preserve the prior bytes,
 * write the amended record, re-pin both, append SLICE_SCOPE_AMENDED. No FAIL,
 * no rework attempt, no step or slice movement, no plan change.
 */
export const amendSliceUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  sliceId,
  addFiles,
  authorization = null,
  hooks,
}) => {
  // Refused before a byte moves, and before the amendment is even computed: an
  // unbranded authorization is a caller authoring its own audit field.
  const authorizedBy = sequenceAuthorizationEvidence(authorization);
  // Re-proven under the lock from fresh reads; bootstrapUnderLock has already
  // matched every pin, `slices/<id>.json` included, immediately before this.
  const { blockers, sliceAmendment, priorBytes, amendedBytes } =
    await sliceAmendmentFor(
      root,
      state,
      { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot },
      sliceId,
      addFiles,
    );
  if (blockers.length > 0) {
    throw new Error(`${blockers.join(" ")} Nothing was written.`);
  }
  const recordRelative = `slices/${sliceId}.json`;
  const { preservesAs } = sliceAmendment;
  const amendedState = {
    ...state,
    evidenceFreshness: "STALE",
    nextAction: `Recapture Playwright TARGET UI evidence for ${state.activeSlice}, bound to the amended implementation of '${sliceId}'.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    artifactHashes: {
      ...state.artifactHashes,
      [recordRelative]: contentIdentity(
        path.join(root, recordRelative),
        Buffer.from(amendedBytes, "utf8"),
      ),
      [preservesAs]: hashContent(priorBytes),
    },
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "SLICE_SCOPE_AMENDED",
    step: "VERIFY_SLICES",
    slice: sliceId,
    amendment: sliceAmendment.amendment,
    added: sliceAmendment.add.map((file) => file.path),
    priorSliceDigest: sliceAmendment.sliceRecordDigestBefore,
    sliceDigest: sliceAmendment.sliceRecordDigestAfter,
    implementationDigestBefore: sliceAmendment.implementationDigestBefore,
    implementationDigestAfter: sliceAmendment.implementationDigestAfter,
    preserved: [preservesAs],
    revision: amendedState.revision,
    // Only an operation that actually executed carries this. An approved
    // member that was never reached writes no event at all, so there is no
    // place for it to claim an authorization it did not spend.
    ...(authorizedBy ? { authorizedBy } : {}),
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, amendedState, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: amendedState.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    restore: [
      { path: preservesAs, remove: true },
      { path: recordRelative, content: priorBytes.toString("utf8") },
    ],
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  // The preserved copy lands first, so no reachable state has replaced a
  // record that was not already kept.
  await atomicWrite(registryData.targetRoot, path.join(root, preservesAs), priorBytes);
  await atomicWrite(
    registryData.targetRoot,
    path.join(root, recordRelative),
    amendedBytes,
  );
  await hooks?.afterWrite?.("slice");
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(amendedState));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    amended: true,
    statePath,
    migrationRoot: root,
    state: amendedState,
    nextArtifact: activeArtifact(amendedState),
    resolved,
  };
};

/**
 * There is no visible-UI parity to reopen on a migration that has none.
 *
 * The one UI authority is the record's own validated inventory -- the same read
 * every UI gate uses, so a `ui-remediation.json` that already raised
 * `hasVisibleUi` counts here exactly as it counts there, and no second
 * UI-detection rule enters the engine. An inventory this release cannot read is
 * deliberately not an answer: it leaves the existing behavior alone rather than
 * inventing a refusal out of an unreadable record.
 */
export const reopenUiNotApplicable = async (root, state, roots) => {
  const inventory = await validateLegacyInventory(root, roots, state).then(
    (value) => value,
    () => null,
  );
  return inventory && inventory.hasVisibleUi !== true
    ? "--reopen-ui is not applicable: the pinned legacy inventory declares hasVisibleUi false, so this migration has no visible UI to reverify. Nothing was changed."
    : null;
};

export const reopenUiUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  slices,
}) => {
  if (!reopenUiEligible(state)) {
    throw new Error(reopenUiIneligible(state));
  }
  const notApplicable = await reopenUiNotApplicable(root, state, {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  });
  if (notApplicable) throw new Error(notApplicable);
  const fromActive = state.status === "ACTIVE";
  const plan = await readJson(
    path.join(root, initialArtifacts.slices),
    "Slice index",
  );
  const requested = new Set(slices);
  const ordered = plan.slices
    .map((slice) => slice.id)
    .filter((sliceId) => requested.has(sliceId));
  if (ordered.length !== requested.size || ordered.length === 0) {
    throw new Error("--reopen-ui must name one or more planned slices.");
  }
  const pendingReverification =
    state.visualContractAdoption?.pendingReverification ?? [];
  if (!pendingReverification.every((sliceId) => requested.has(sliceId))) {
    throw new Error(
      `--reopen-ui must include every slice whose Figma visual evidence predates the adopted visual contract: ${pendingReverification.join(", ")}.`,
    );
  }
  if (fromActive) {
    const notCompleted = ordered.filter(
      (sliceId) => !state.completedSlices.includes(sliceId),
    );
    if (notCompleted.length > 0) {
      throw new Error(
        `--reopen-ui on an ACTIVE migration names only completed slices; ${notCompleted.join(", ")} is active or pending and is re-authored in place.`,
      );
    }
    const lacking = await completedSlicesLackingUiProofV1(root, state, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
    const omitted = lacking.filter((sliceId) => !requested.has(sliceId));
    if (omitted.length > 0) {
      throw new Error(
        `--reopen-ui must include every completed slice lacking ${UI_PROOF_FORMAT} UI proof: ${lacking.join(", ")}.`,
      );
    }
    if (await readAdvanceJournal(root)) {
      throw new Error(
        "--reopen-ui is refused while an advance journal is pending; resume the migration first.",
      );
    }
    if (state.activeSlice) {
      const active = await readFile(
        path.join(root, `evidence/${state.activeSlice}/result.json`),
        "utf8",
      ).then(JSON.parse, () => null);
      if (active?.result === "FAIL") {
        throw new Error(
          `--reopen-ui is refused while active slice '${state.activeSlice}' holds an un-reworked FAIL; resolve it with --rework-slice first.`,
        );
      }
    }
  }
  const artifactHashes = { ...state.artifactHashes };
  for (const sliceId of ordered) {
    delete artifactHashes[`evidence/${sliceId}/result.json`];
  }
  for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
    delete artifactHashes[relative];
  }
  // ACTIVE recovery changes only the proof format, never the UI contract, so
  // the remediation file and its pin stay exactly as they are.
  if (!fromActive) delete artifactHashes[UI_REMEDIATION_FILE];

  const remediationPath = path.join(root, UI_REMEDIATION_FILE);
  const remediationBefore = (await fileExists(remediationPath))
    ? await readFile(remediationPath, "utf8")
    : null;
  const remediation = `${JSON.stringify(
    {
      version: 1,
      reason: "Completed migration reopened after a visible-UI parity audit.",
      legacyRevision: await gitRevision(registryData.legacyRoot),
      hasVisibleUi: true,
      uiBehaviors: [],
      uiMismatches: [],
    },
    null,
    2,
  )}\n`;
  const resultRewrites = [];
  for (const sliceId of ordered) {
    const relative = `evidence/${sliceId}/result.json`;
    const absolute = path.join(root, relative);
    const before = await readFile(absolute, "utf8");
    const result = JSON.parse(before);
    resultRewrites.push({
      relative,
      before,
      content: `${JSON.stringify(
        {
          ...result,
          result: "PENDING",
          uiEvidence: [],
          uiEvidenceLimitations: [],
        },
        null,
        2,
      )}\n`,
    });
  }
  const reopened = {
    // Stamp the record's own format, never a literal: format 14 gates
    // `inventories/figma-context.json` membership in the exact-set
    // `artifactHashes` check, so downgrading a figma-mcp record here left the
    // pin present but no longer expected, bricking every later read.
    ...state,
    formatVersion: stampedFormatVersion(state),
    status: "ACTIVE",
    currentStep: "VERIFY_SLICES",
    activeSlice: ordered[0],
    completedSteps: stepsFor(state).slice(
      0,
      stepsFor(state).indexOf("IMPLEMENT_SLICES"),
    ),
    pendingSteps: ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"],
    completedSlices: state.completedSlices.filter(
      (sliceId) => !requested.has(sliceId),
    ),
    pendingSlices: fromActive
      ? plan.slices
          .map((slice) => slice.id)
          .filter(
            (sliceId) =>
              requested.has(sliceId) || state.pendingSlices.includes(sliceId),
          )
      : ordered,
    invalidatedArtifacts: [
      ...(fromActive ? [] : [UI_REMEDIATION_FILE]),
      ...ordered.map((sliceId) => `evidence/${sliceId}/result.json`),
      ...IMMUTABLE_STEP_ARTIFACTS.FINALIZE,
    ],
    evidenceFreshness: "STALE",
    nextAction: fromActive
      ? `Collect ${UI_PROOF_FORMAT} Playwright evidence for ${ordered[0]}.`
      : `Author ${UI_REMEDIATION_FILE}, then collect Playwright evidence for ${ordered[0]}.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    ...(state.visualContractAdoption
      ? {
          visualContractAdoption: {
            ...state.visualContractAdoption,
            pendingReverification: [],
          },
        }
      : {}),
    artifacts: fromActive
      ? state.artifacts
      : { ...state.artifacts, uiRemediation: UI_REMEDIATION_FILE },
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "UI_REMEDIATION_REOPENED",
    from: fromActive ? "ACTIVE" : "COMPLETE",
    step: "VERIFY_SLICES",
    slices: ordered,
    at: reopened.updatedAt,
    revision: reopened.revision,
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, reopened, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: reopened.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    restore: [
      ...(fromActive
        ? []
        : [
            remediationBefore === null
              ? { path: UI_REMEDIATION_FILE, remove: true }
              : { path: UI_REMEDIATION_FILE, content: remediationBefore },
          ]),
      ...resultRewrites.map(({ relative, before }) => ({
        path: relative,
        content: before,
      })),
    ],
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  if (!fromActive) {
    await atomicWrite(registryData.targetRoot, remediationPath, remediation);
  }
  for (const rewrite of resultRewrites) {
    await atomicWrite(
      registryData.targetRoot,
      path.join(root, rewrite.relative),
      rewrite.content,
    );
  }
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reopened));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reopened,
    nextArtifact: fromActive
      ? `evidence/${ordered[0]}/result.json`
      : UI_REMEDIATION_FILE,
    resolved,
  };
};

/* ------------------------------------------------------------------
 * `--reopen-complete`: the only COMPLETE -> reopened transition that is not
 * about visible UI.
 *
 * `--reopen-ui` reopens a COMPLETE record for a parity audit and `--rework-slice`
 * returns an *active* slice with a recorded FAIL to implementation. Neither
 * covers the remaining case: authoritative evidence that appears *after*
 * FINALIZE and proves part of the finalized contract wrong. A note in the record
 * changed no machine state, and COMPLETE stayed COMPLETE over evidence everyone
 * knew was stale.
 *
 * Modelled on both: operator-only, refused under `--mode auto`, refused by
 * `run-migration.mjs`, never self-confirmed, preview-gated, journalled -- and
 * ordered like a rework, which is the whole safety property. The superseded
 * verification is preserved byte-for-byte and permanently pinned BEFORE its
 * mutable pin is released, so there is no reachable state in which the proof
 * the previous COMPLETE rested on has been freed before it was kept.
 *
 * Deliberately narrow. It releases the named slices' evidence and the FINALIZE
 * pins and nothing else: discovery, baseline, plan, operator decisions and every
 * unnamed slice stay pinned and stay valid. Path-scoped legacy drift blocks it
 * unless the operator types the exact current revision with
 * `--confirm-legacy-revision`; the record then moves to that revision, and the
 * move is kept in the reopen record and event. Nothing else is released for it:
 * slice evidence is not revision-bound, and the FINALIZE gates it releases
 * anyway are re-proven against the new revision. And it never edits the
 * target, so FINALIZE re-runs the unclaimed-drift refusal unchanged.
 * ------------------------------------------------------------------ */

/**
 * One definition site for what a reopen is allowed to do, read by the preview
 * (as blockers) and re-derived under the lock (as refusals) from fresh reads.
 */
export const reopenCompletePlan = async (
  root,
  state,
  roots,
  {
    slices,
    reason,
    evidence,
    legacyRevision,
    confirmLegacyRevision = null,
    // `--mode auto`. What `--confirm-legacy-revision` proves is that whoever
    // typed it had read the *current* revision -- and the engine read it, from
    // git, in this call. There is no judgement in retyping a SHA the engine
    // just computed, so AUTO acknowledges it on its own authority and the
    // acknowledgement names AUTO in the reopen record and the history event.
    // Everything the acknowledgement releases is re-proven against the new
    // revision regardless of who acknowledged.
    autoAcknowledge = false,
  },
) => {
  const blockers = [];
  const drifted = state.legacyRevision.revision !== legacyRevision.revision;
  const acknowledged =
    confirmLegacyRevision ??
    (autoAcknowledge && drifted ? legacyRevision.revision : null);
  const acknowledgedBy = !acknowledged
    ? null
    : confirmLegacyRevision
      ? "OPERATOR"
      : "AUTO";
  if (drifted && acknowledged !== legacyRevision.revision) {
    blockers.push(
      confirmLegacyRevision
        ? `--confirm-legacy-revision '${confirmLegacyRevision}' does not match the current legacy revision '${legacyRevision.revision}'. Nothing was acknowledged.`
        : `Legacy revision changed from '${state.legacyRevision.revision}' to '${legacyRevision.revision}'. A COMPLETE reopen may acknowledge it with --confirm-legacy-revision ${legacyRevision.revision}; otherwise review the mismatch before using --refresh --confirm-mismatch.`,
    );
  }
  if (!drifted && confirmLegacyRevision) {
    blockers.push(
      `--confirm-legacy-revision was given, but the legacy revision has not changed from '${state.legacyRevision.revision}'. There is no drift to acknowledge.`,
    );
  }
  if (state.status !== "COMPLETE") {
    blockers.push(
      `--reopen-complete is legal only for a COMPLETE migration; the current status is '${state.status}'. A migration that has not finalized is corrected by advancing it, not by reopening it.`,
    );
  }
  // Explicit operator intent, in the record and not only in a terminal: a
  // reopen that cannot say why it happened is indistinguishable from a
  // hand-edit of a completed record.
  if (typeof reason !== "string" || reason.trim().length < 12) {
    blockers.push(
      "--reopen-complete requires --reopen-reason <text> of at least 12 characters: the reopen event is the permanent record of why a finalized contract stopped being true.",
    );
  }
  const claim = evidencePathClaim(evidence);
  let evidenceIdentity = null;
  if (!claim) {
    blockers.push(
      `--reopen-complete requires --reopen-evidence <path>: a repository-relative path to the authoritative post-finalization evidence. Received '${evidence ?? "nothing"}', which is not a persisted artifact path.`,
    );
  } else {
    const absolute = await resolveEvidencePath(claim, roots);
    if (!absolute) {
      blockers.push(
        `--reopen-evidence names '${claim}', which does not exist under the legacy or target repository. Evidence that a finalized contract is wrong must be a real observation, persisted.`,
      );
    } else {
      evidenceIdentity = await fileIdentity(absolute);
    }
  }
  const planned = (await inspectSliceArtifacts(root)).plannedSlices;
  const requested = new Set(slices);
  const ordered = planned.filter((sliceId) => requested.has(sliceId));
  if (requested.size === 0) {
    blockers.push("--reopen-complete must name one or more planned slices.");
  }
  for (const sliceId of requested) {
    if (!planned.includes(sliceId)) {
      blockers.push(`--reopen-complete names unknown slice '${sliceId}'.`);
    }
  }
  const legacyDrift = drifted
    ? {
        fromLegacyRevision: state.legacyRevision,
        toLegacyRevision: legacyRevision,
        // Who acknowledged, persisted with the drift it acknowledges. A record
        // that moved revisions must say on whose authority, forever.
        acknowledgedBy,
      }
    : null;
  return { blockers, ordered, claim, evidenceIdentity, legacyDrift, acknowledgedBy };
};

/** How many reopens this record has already recorded, read off the audit log. */
export const reopenAttemptsOf = async (root) =>
  (await readHistoryEvents(root)).filter(
    (event) => event.event === "COMPLETE_REOPENED",
  ).length;

export const reopenCompleteUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  slices,
  reason,
  evidence,
  legacyRevision,
  confirmLegacyRevision,
  autoAcknowledge = false,
  // Who decides. Defaults to the operator: an absent mode is never autonomy.
  mode = "step",
}) => {
  const roots = {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  };
  const plan = await reopenCompletePlan(root, state, roots, {
    slices,
    reason,
    evidence,
    legacyRevision,
    confirmLegacyRevision,
    autoAcknowledge,
  });
  if (plan.blockers.length > 0) {
    throw new Error(`${plan.blockers.join(" ")} Nothing was written.`);
  }
  const { ordered, claim, evidenceIdentity, legacyDrift } = plan;
  // HEAD, not `gitRevision`'s path-scoped reading: the anchor must be the
  // commit the reopened slices are proven against and an ancestor of every
  // later HEAD, which only the tip guarantees.
  const authority = mode === "auto" ? "AUTO" : "OPERATOR";
  const targetAnchor = await headRevision(roots.targetRoot);
  const attempt = (await reopenAttemptsOf(root)) + 1;
  const directory = `${REOPEN_ROOT}/${attempt}`;
  if (await fileExists(path.join(root, directory))) {
    throw new Error(
      `${directory} already exists. Reopens are append-only and an attempt number is never reused; nothing was written.`,
    );
  }

  // Every file the transaction writes, built completely before anything lands.
  // Raw bytes, never parse-and-reserialize: key order, whitespace and line
  // endings are part of what the previous COMPLETE actually recorded.
  const writes = [];
  const rewrites = [];
  for (const sliceId of ordered) {
    const relative = `evidence/${sliceId}/result.json`;
    const absolute = path.join(root, relative);
    const before = await readFile(absolute);
    writes.push([`${directory}/${relative}`, before]);
    rewrites.push({
      relative,
      before,
      // The verification is invalidated, not rewritten into a verdict nobody
      // recorded: PENDING is the one value `inspectSliceArtifacts` reads as
      // "not verified", and the superseded PASS survives beside it.
      content: `${JSON.stringify(
        { ...JSON.parse(before.toString("utf8")), result: "PENDING" },
        null,
        2,
      )}\n`,
    });
  }
  const preserved = {};
  for (const [relative, bytes] of writes) preserved[relative] = hashContent(bytes);
  const recordRelative = `${directory}/record.json`;
  const record = `${JSON.stringify(
    {
      version: 1,
      attempt,
      at: now(),
      operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
      reason: reason.trim(),
      evidenceReference: claim,
      evidenceHash: evidenceIdentity,
      slices: ordered,
      // Who decided. AUTO assents by deriving the transition from valid
      // evidence; OPERATOR assents by typing --confirm-reopen. The `operator`
      // field stays the process identity in both cases -- it records where the
      // transition ran, never a human approval AUTO did not obtain.
      authority,
      priorRevision: state.revision,
      priorCompletedAt: state.updatedAt,
      // The committed target state whose preserved PASS is being reopened.
      // Without it a reopened slice has no provenance for work that was already
      // committed at COMPLETE, and `validateImplementedSlice` can only prove
      // ownership from the current uncommitted diff -- which a committed slice
      // is legitimately absent from. Records written before this field exists
      // resolve their anchor from the pinned preserved evidence instead.
      ...(targetAnchor ? { targetAnchor } : {}),
      ...(legacyDrift ?? {}),
      preserved,
    },
    null,
    2,
  )}\n`;
  writes.push([recordRelative, Buffer.from(record, "utf8")]);
  preserved[recordRelative] = hashContent(record);

  const artifactHashes = { ...state.artifactHashes, ...preserved };
  // Released only now, and only after every preserved path is in the pin set.
  for (const sliceId of ordered) {
    delete artifactHashes[`evidence/${sliceId}/result.json`];
  }
  for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
    delete artifactHashes[relative];
  }

  const steps = stepsFor(state);
  const reopened = {
    // Stamped, never a literal, for the same reason `--reopen-ui` stamps:
    // downgrading the record here would leave format-gated pins present but no
    // longer expected, bricking every later read.
    ...state,
    formatVersion: stampedFormatVersion(state),
    status: "ACTIVE",
    currentStep: "VERIFY_SLICES",
    activeSlice: ordered[0],
    completedSteps: steps.slice(0, steps.indexOf("IMPLEMENT_SLICES")),
    pendingSteps: ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"],
    completedSlices: state.completedSlices.filter(
      (sliceId) => !ordered.includes(sliceId),
    ),
    pendingSlices: ordered,
    invalidatedArtifacts: [
      ...ordered.map((sliceId) => `evidence/${sliceId}/result.json`),
      ...IMMUTABLE_STEP_ARTIFACTS.FINALIZE,
    ],
    evidenceFreshness: "STALE",
    nextAction: `Correct and reverify slice '${ordered[0]}' against the evidence recorded in ${recordRelative}. A slice whose implementation is wrong records FAIL with defects[] and returns to implementation with --rework-slice.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    ...(legacyDrift ? { legacyRevision: legacyDrift.toLegacyRevision } : {}),
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "COMPLETE_REOPENED",
    from: "COMPLETE",
    step: "VERIFY_SLICES",
    slices: ordered,
    attempt,
    reason: reason.trim(),
    evidenceReference: claim,
    authority,
    ...(targetAnchor ? { targetAnchor } : {}),
    // Also re-anchors gate-evidence freshness (`pinnedInputTimestamps`).
    ...(legacyDrift ?? {}),
    preserved: Object.keys(preserved).sort(),
    revision: reopened.revision,
  };

  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, reopened, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: reopened.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    // Recovery removes a half-written preserved tree and restores the evidence
    // the previous COMPLETE rested on, so a killed reopen leaves the record
    // exactly as complete as it was.
    restore: [
      ...writes.map(([relative]) => ({ path: relative, remove: true })),
      ...rewrites.map(({ relative, before }) => ({
        path: relative,
        content: before.toString("utf8"),
      })),
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
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reopened));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reopened,
    nextArtifact: activeArtifact(reopened),
    resolved,
  };
};
