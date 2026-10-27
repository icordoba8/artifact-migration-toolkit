/**
 * Lifecycle: advance -- `previewAdvance`, `advanceMigration` and
 * `advanceUnderLock`. Moved verbatim from `resumable-migration.mjs` (Track A8).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { legacySourceBinding } from "../census/index.mjs";
import {
  assertNoPendingFormatUpgrade,
  DISCOVERY_SCAN_FILE,
  INTEGRITY_FILE,
  MIGRATION_STEPS,
  stampedFormatVersion,
  STEP_FILES,
  stepsFor,
  usesArtifactDelegation,
  usesCapabilityOwnership,
  usesUiVerification,
} from "../formats/index.mjs";
import { now } from "../shared/index.mjs";
import {
  assertHistoryAppendable,
  atomicWrite,
  fileExists,
  hashFile,
  migrationRoot,
  previewRegistryUpdate,
  renderState,
  statePathFor,
} from "../store/index.mjs";
import { removeJournal, writeJournalAtomic } from "./journal.mjs";
import { withModuleLock } from "./lock.mjs";
import {
  consumedDecisionStore,
  rawDecisionLedgerBytes,
  rawDecisionLedgerDigest,
} from "../decisions/index.mjs";
import { inspectSliceArtifacts, verifiedFileIdentities } from "../slices/index.mjs";
import { activeArtifact, confirmationIdFor, expectedNextCheckpoint } from "./checkpoints.mjs";
import { readContext } from "./context.mjs";
import { assertCurrentOpenSpecAuthority } from "./openspec.mjs";
import { DEFAULT_MODE } from "./policy.mjs";
import { migrationProgress, previewProgress, renderProgress } from "./progress.mjs";
import {
  ADVANCE_JOURNAL,
  appendHistoryOnce,
  BASELINE_ROWS_PIN,
  completedArtifactHashes,
  hashPinnedArtifact,
  readState,
  recoverPendingAdvance,
  renderIntegrityNow,
  validateCompletedHashes,
} from "./record.mjs";
import { updateRegistry } from "./registry.mjs";
import { stateMappingMismatch } from "./templates.mjs";
import { assertRecordToolkitIdentity } from "./toolkit-identity.mjs";
import { artifactPrerequisiteWork, assertBriefUnchanged, validateStep } from "./validation.mjs";

/**
 * Read-only advance preflight. `advance-migration.mjs` used to write state and
 * history with no preview, no confirmation ID, and no lock, which contradicted
 * the public "every mutating invocation is two-phase" guarantee: any caller
 * could durably close a checkpoint without the user approving that exact
 * transition. The ID below binds the state revision, the current artifact
 * hashes, the active slice, and the exact intended next state.
 */
export const previewAdvance = async ({
  registryPath,
  moduleName,
  step,
  slice,
  // As in previewMigrationExecution: checklist only, outside the hashed
  // snapshot, so the confirmation ID is unaffected.
  mode,
} = {}) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  const context = await readState(registryData.targetRoot, resolved.canonical);
  const { state } = context;
  const currentStep = step ?? state.currentStep;
  const activeSlice = slice ?? state.activeSlice;
  const blockers = [];
  if (stateMappingMismatch(state, resolved)) {
    blockers.push("Migration state mapping does not match the registry.");
  }
  if (state.status !== "ACTIVE") {
    blockers.push(`Cannot advance migration with status '${state.status}'.`);
  }
  if (currentStep !== state.currentStep) {
    blockers.push(
      `Cannot advance '${currentStep}'; current step is '${state.currentStep}'.`,
    );
  }
  if (!MIGRATION_STEPS.includes(currentStep)) {
    blockers.push(`Unknown migration step '${currentStep}'.`);
  }
  if (
    ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep) &&
    activeSlice !== state.activeSlice
  ) {
    blockers.push(
      `Slice '${activeSlice ?? "none"}' is not the active slice '${state.activeSlice ?? "none"}'.`,
    );
  }
  const snapshot = {
    migration: state.legacyModule,
    step: currentStep,
    slice: activeSlice ?? null,
    revision: state.revision,
    stateHash: await hashFile(context.statePath),
    artifactHashes: state.artifactHashes,
    // The state hash and the pinned artifacts live in the target; nothing here
    // bound the legacy side, so the sources a checkpoint asserts about could
    // change between the summary the operator confirmed and the write.
    legacySource: await legacySourceBinding(registryData.legacyRoot),
    nextStep: expectedNextCheckpoint(state),
    blockers,
  };
  if (
    blockers.length === 0 &&
    usesArtifactDelegation(state) &&
    ["IMPLEMENT_SLICES", "FINALIZE"].includes(currentStep)
  ) {
    const prerequisite = await artifactPrerequisiteWork(
      state,
      {
        legacyRoot: registryData.legacyRoot,
        targetRoot: registryData.targetRoot,
      },
      { all: currentStep === "FINALIZE" },
    );
    if (prerequisite.outcome !== "COMPLETE") {
      const progress = migrationProgress(state, {
        mode: mode ?? DEFAULT_MODE,
        outcome:
          prerequisite.outcome === "CONTINUE" ? null : prerequisite.outcome,
        reason: prerequisite.reason,
        nextWorkKind: prerequisite.nextWorkKind,
        artifactMigration: prerequisite.artifactMigration,
      });
      return {
        ...snapshot,
        outcome: prerequisite.outcome,
        reason: prerequisite.reason,
        nextWorkKind: prerequisite.nextWorkKind ?? null,
        artifactMigration: prerequisite.artifactMigration,
        pendingDecisions: prerequisite.pendingDecisions ?? [],
        blockers:
          prerequisite.outcome === "BLOCKED" ? [prerequisite.reason] : [],
        requiresConfirmation: false,
        confirmationId: null,
        progress,
        progressChecklist: renderProgress(progress),
      };
    }
  }
  const advanceProgress = previewProgress(state, mode, blockers);
  return {
    ...snapshot,
    statePath: context.statePath,
    progress: advanceProgress,
    progressChecklist: renderProgress(advanceProgress),
    requiresConfirmation: blockers.length === 0,
    confirmationId: blockers.length === 0 ? confirmationIdFor(snapshot) : null,
  };
};

export const renderAdvancePreview = (preview) =>
  `Advance pre-execution summary\n` +
  `Migration: ${preview.migration}\n` +
  `Checkpoint to close: ${preview.step}\n` +
  `Slice: ${preview.slice ?? "none"}\n` +
  `State revision: ${preview.revision}\n` +
  `Expected next checkpoint: ${preview.nextStep}\n` +
  `Blockers: ${preview.blockers.length > 0 ? preview.blockers.join("; ") : "none"}\n`;

export const advanceMigration = async ({
  registryPath,
  projectRoot,
  moduleName,
  mode,
  step,
  slice,
  confirmAdvance,
  hooks,
}) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  const preview = await previewAdvance({
    registryPath,
    moduleName,
    step,
    slice,
    mode,
  });
  if (!preview.requiresConfirmation) {
    throw new Error(preview.blockers.join("; "));
  }
  if (
    typeof confirmAdvance !== "string" ||
    confirmAdvance !== preview.confirmationId
  ) {
    throw new Error(
      "Advance confirmation is missing or expired. Show the current advance pre-execution summary and ask the user to confirm again.",
    );
  }
  const result = await withModuleLock(registryData.targetRoot, resolved.canonical, () =>
    advanceUnderLock({ registryData, resolved, projectRoot, mode, step, slice, preview, hooks }),
  );
  if (!result.registrationPreview || mode !== "auto") return result;
  const { maySelfConfirm } = await import("./policy.mjs");
  if (
    !maySelfConfirm({ command: "registry", mode }) ||
    !maySelfConfirm({ command: "advance", mode })
  ) return result;
  const registration = result.registrationPreview;
  const registered = await updateRegistry({
    registryPath: registration.registryPath,
    projectRoot,
    moduleName: registration.moduleName,
    target: registration.target,
    confirmExecution: registration.confirmationId,
  });
  const continuedPreview = await previewAdvance({
    registryPath, moduleName, step, slice, mode,
  });
  const continued = await advanceMigration({
    registryPath, projectRoot, moduleName, step, slice,
    confirmAdvance: continuedPreview.confirmationId,
    hooks,
  });
  return { ...continued, registration: registered };
};

const advanceUnderLock = async ({
  registryData,
  resolved,
  projectRoot,
  mode,
  step,
  slice,
  preview,
  hooks,
}) => {
  const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
  await recoverPendingAdvance(
    registryData.targetRoot,
    migrationRoot(registryData.targetRoot, resolved.canonical),
    statePath,
  );
  const context = await readState(registryData.targetRoot, resolved.canonical);
  const state = context.state;
  if (stateMappingMismatch(state, resolved)) {
    throw new Error("Migration state mapping does not match the registry.");
  }
  assertRecordToolkitIdentity(state, resolved.canonical, "Advancing this migration");
  // Identity first, then the format upgrade, then the lifecycle. An active
  // increment freezes the checkpoint tuple: no advance shares an invocation
  // with a format upgrade, and this guard is independent of the classifier so a
  // record whose upgrade cannot even be classified still refuses.
  assertNoPendingFormatUpgrade(state, resolved.canonical, "Advancing this migration");
  // Compare-and-swap: the confirmation authorized one exact revision and one
  // exact set of pinned artifacts. Another process that advanced (or a slice
  // that was verified) while this one waited for the lock invalidates it, so a
  // concurrent advance can never silently overwrite a completed transition.
  if (state.revision !== preview.revision) {
    throw new Error(
      `Migration state moved from revision ${preview.revision} to ${state.revision} while this advance was waiting. Nothing was changed; preview again.`,
    );
  }
  if ((await hashFile(statePath)) !== preview.stateHash) {
    throw new Error(
      "Migration state changed while this advance was waiting. Nothing was changed; preview again.",
    );
  }
  await assertCurrentOpenSpecAuthority(registryData.targetRoot, state);
  if (state.status !== "ACTIVE") {
    throw new Error(`Cannot advance migration with status '${state.status}'.`);
  }
  const currentStep = step ?? state.currentStep;
  if (currentStep !== state.currentStep) {
    throw new Error(
      `Cannot advance '${currentStep}'; current step is '${state.currentStep}'.`,
    );
  }
  const activeSlice = slice ?? state.activeSlice;
  if (
    ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep) &&
    !activeSlice
  ) {
    throw new Error(`${currentStep} requires an active slice.`);
  }
  await validateCompletedHashes(context.root, state);
  await assertBriefUnchanged(context.root, state);
  // Everything the checkpoint's own validation resolves is collected here, so
  // the history event records the exact authority this advance consumed rather
  // than whatever the ledger happens to hold when someone reads it later.
  const consumed = new Map();
  const validated = await consumedDecisionStore.run(consumed, () =>
    validateStep(context.root, state, currentStep, activeSlice, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    }),
  );

  // The machine-generated record of what the checkpoint saw, written before
  // its digest is pinned. It is never trusted as input -- every validation
  // recomputes -- but it lets a FINALIZE drift failure name what changed.
  if (currentStep === "DISCOVERY_COMPLETENESS") {
    await atomicWrite(
      registryData.targetRoot,
      path.join(context.root, DISCOVERY_SCAN_FILE),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: now(),
          ...validated.scan,
          decisionLedgerDigest: await rawDecisionLedgerDigest(context.root),
          decisionLedgerBytes: await rawDecisionLedgerBytes(context.root),
        },
        null,
        2,
      )}\n`,
    );
  }

  const completedSteps = new Set(state.completedSteps);
  const pendingSteps = new Set(state.pendingSteps);
  const artifactHashes = {
    ...state.artifactHashes,
    ...(await completedArtifactHashes(
      context.root,
      state,
      currentStep,
      activeSlice,
    )),
  };
  // Format-8 upgrade: BUILD_BASELINE closed under an older format pinned no
  // rows, so this transaction computes the pin from the matrix as it stands
  // and stamps format 8 with it. Nothing before this point could have been
  // held to a pin that never existed.
  if (
    completedSteps.has("BUILD_BASELINE") &&
    !artifactHashes[BASELINE_ROWS_PIN]
  )
    artifactHashes[BASELINE_ROWS_PIN] = await hashPinnedArtifact(
      context.root,
      BASELINE_ROWS_PIN,
    );
  const lifecycle = stepsFor(state);
  let currentStepIndex = lifecycle.indexOf(currentStep);
  let nextStep = lifecycle[currentStepIndex + 1] ?? "COMPLETE";
  let pendingSlices = [...state.pendingSlices];
  let completedSlices = [...state.completedSlices];
  let nextSlice = activeSlice;
  if (currentStep === "BUILD_BASELINE" && !resolved.registered) {
    if (mode !== "auto" && mode !== "step") {
      throw new Error(
        "Baseline is valid, but the migration mapping is not registered. Use --mode auto or the public registry command before advancing.",
      );
    }
    const registration = {
      registryPath: registryData.registryPath,
      projectRoot,
      moduleName: state.migrationId,
      target: state.targetModule,
    };
    const registryPreview = await previewRegistryUpdate(registration);
    return { registrationPreview: registryPreview };
  }
  if (currentStep === "PLAN") {
    const { slices } = validated;
    for (const plannedSlice of slices) {
      const slicePath = path.join(
        context.root,
        `slices/${plannedSlice.id}.json`,
      );
      if (!(await fileExists(slicePath))) {
        await atomicWrite(
          registryData.targetRoot,
          slicePath,
          `${JSON.stringify(
            {
              id: plannedSlice.id,
              implementationStatus: "PENDING",
              requirementIds: plannedSlice.requirementIds,
              scenarioIds: plannedSlice.scenarioIds,
              traceIds: plannedSlice.traceIds,
              ...(usesCapabilityOwnership(state)
                ? { capabilityIds: plannedSlice.capabilityIds }
                : {}),
              changedFiles: [],
              decisions: [],
              checks: [],
            },
            null,
            2,
          )}\n`,
        );
      }
      const evidencePath = path.join(
        context.root,
        `evidence/${plannedSlice.id}/result.json`,
      );
      if (!(await fileExists(evidencePath))) {
        await atomicWrite(
          registryData.targetRoot,
          evidencePath,
          `${JSON.stringify(
            {
              sliceId: plannedSlice.id,
              result: "PENDING",
              requirementIds: plannedSlice.requirementIds,
              scenarioIds: plannedSlice.scenarioIds,
              traceIds: plannedSlice.traceIds,
              ...(usesCapabilityOwnership(state)
                ? { capabilityIds: plannedSlice.capabilityIds }
                : {}),
              commands: [],
              scenarios: [],
              ...(usesUiVerification(state)
                ? { uiEvidence: [], uiEvidenceLimitations: [] }
                : {}),
              residualRisks: [],
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    const inspected = await inspectSliceArtifacts(context.root);
    const verified = new Set(inspected.verifiedSlices);
    completedSlices = inspected.plannedSlices.filter((id) => verified.has(id));
    pendingSlices = inspected.plannedSlices.filter((id) => !verified.has(id));
    nextSlice = pendingSlices[0];
    if (!nextSlice) throw new Error("Plan did not produce a slice.");
    // A slice's on-disk implementationStatus can read COMPLETE (e.g. a
    // verification-only slice authored before this advance) without
    // IMPLEMENT_SLICES ever having been entered as a checkpoint for it --
    // that record alone must never promote currentStep past IMPLEMENT_SLICES.
    // The checkpoint is only genuinely complete once this engine validates and
    // advances through it, which the IMPLEMENT_SLICES branch below does.
    nextStep = "IMPLEMENT_SLICES";
  } else if (currentStep === "IMPLEMENT_SLICES") {
    nextStep = "VERIFY_SLICES";
  } else if (currentStep === "VERIFY_SLICES") {
    const completed = new Set([...completedSlices, activeSlice]);
    const { plannedSlices } = await inspectSliceArtifacts(context.root);
    completedSlices = plannedSlices.filter((id) => completed.has(id));
    pendingSlices = pendingSlices.filter((id) => id !== activeSlice);
    nextSlice = pendingSlices[0] ?? null;
    nextStep = nextSlice ? "IMPLEMENT_SLICES" : "FINALIZE";
  }

  if (!["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep)) {
    completedSteps.add(currentStep);
    pendingSteps.delete(currentStep);
  }
  if (currentStep === "VERIFY_SLICES" && pendingSlices.length === 0) {
    completedSteps.add("IMPLEMENT_SLICES");
    completedSteps.add("VERIFY_SLICES");
    pendingSteps.delete("IMPLEMENT_SLICES");
    pendingSteps.delete("VERIFY_SLICES");
  }

  const isComplete = currentStep === "FINALIZE";
  if (isComplete) {
    completedSteps.add("FINALIZE");
    pendingSteps.delete("FINALIZE");
    nextStep = "COMPLETE";
    nextSlice = null;
  }
  const nextState = {
    ...state,
    // Never promotes a pre-10 record into the 9-step lifecycle: it closed
    // DISCOVER_LEGACY without the new checkpoint and can never satisfy the
    // 9-step prefix rule.
    formatVersion: stampedFormatVersion(state),
    status: isComplete ? "COMPLETE" : "ACTIVE",
    currentStep: nextStep,
    activeSlice:
      nextStep === "IMPLEMENT_SLICES" || nextStep === "VERIFY_SLICES"
        ? nextSlice
        : null,
    completedSteps: lifecycle.filter((item) => completedSteps.has(item)),
    pendingSteps: lifecycle.filter((item) => pendingSteps.has(item)),
    completedSlices,
    pendingSlices,
    invalidatedArtifacts: [],
    evidenceFreshness: "CURRENT",
    nextAction: isComplete
      ? "Migration is ready for commit."
      : nextStep === "IMPLEMENT_SLICES"
        ? `Implement slice ${nextSlice}.`
        : nextStep === "VERIFY_SLICES"
          ? `Verify slice ${nextSlice}.`
          : `Complete ${STEP_FILES[nextStep]}.`,
    // The record key, matching every other `nextCommand` producer: the
    // migration id is the legacy module at format <= 14 and the target module
    // from 15 on, and it is the only name that reopens the record directory.
    // `legacyModule` is `legacySources[0]` at format 15 -- a source that is
    // typically not registered at all, so following it failed outright.
    nextCommand: isComplete ? null : `/start-migration ${state.migrationId}`,
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "STEP_COMPLETED",
    step: currentStep,
    slice: activeSlice ?? null,
    ...(currentStep === "VERIFY_SLICES" && validated?.visualComparison?.length
      ? { visualComparison: validated.visualComparison }
      : {}),
    // M14.1: the bytes this verification ran against, judged again at FINALIZE.
    ...(currentStep === "VERIFY_SLICES"
      ? { verifiedFiles: await verifiedFileIdentities(context.root, activeSlice, registryData) }
      : {}),
    // Format 19 only, and only when this advance actually consumed authority.
    // Ordered by decision id so the event -- and therefore the history chain
    // and the integrity anchor over it -- is byte-stable across replays. A
    // group contributed one identity because the resolver recorded the group
    // entry once, keyed by its id, however many members routed through it.
    ...(consumed.size > 0
      ? {
          consumedDecisions: [...consumed.values()].sort((a, b) =>
            a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0,
          ),
        }
      : {}),
    nextStep,
    nextSlice: nextState.activeSlice,
    revision: nextState.revision,
  };
  // One journalled transition: prove the audit record is writable before any
  // state moves (a broken history/ used to advance the checkpoint and then
  // fail), record the intent, write the integrity anchor, write state, append
  // exactly one event, drop the journal. A death in any gap is completed by
  // `recoverPendingAdvance` on the next command, so state, its integrity
  // anchor, and history can never disagree permanently.
  const integrityPath = path.join(context.root, INTEGRITY_FILE);
  const integrityBefore = (await fileExists(integrityPath))
    ? await readFile(integrityPath, "utf8")
    : null;
  const nextIntegrity = await renderIntegrityNow(context.root, nextState, event);
  await assertHistoryAppendable(registryData.targetRoot, context.root);
  const journalFile = path.join(context.root, ADVANCE_JOURNAL);
  // The four points a crash can land between. `hooks.afterWrite` is the same
  // seam `bootstrapMigration` already exposes as `hooks.afterCommit`, and it
  // exists for one reason: recovery is the least exercised and highest
  // consequence code in the engine, and "kill it and hope you hit the window"
  // is not a test. Absent in every real invocation, so the production path is
  // byte-identical.
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: nextState.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  await hooks?.afterWrite?.("journal");
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await hooks?.afterWrite?.("integrity");
  await atomicWrite(
    registryData.targetRoot,
    context.statePath,
    renderState(nextState),
  );
  await hooks?.afterWrite?.("state");
  await appendHistoryOnce(registryData.targetRoot, context.root, event);
  await hooks?.afterWrite?.("history");
  await removeJournal(journalFile);
  return {
    changed: true,
    state: nextState,
    statePath: context.statePath,
    migrationRoot: context.root,
    completedStep: currentStep,
    completedSlice: currentStep === "VERIFY_SLICES" ? activeSlice : null,
    nextArtifact: activeArtifact(nextState),
  };
};
