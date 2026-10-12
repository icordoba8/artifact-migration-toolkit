/**
 * Lifecycle: artifact bootstrap, format upgrade, the run loop and the manual
 * toolkit-identity change. Moved verbatim from `artifact/artifact-migration.mjs`
 * (Track A8).
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_FORMAT_INCREMENTS,
  INTEGRITY_FILE,
  MIGRATION_STEPS,
  sameToolkitIdentity,
  STATE_FILE,
  TRANSACTION_FILE,
  usesArtifactDirectLedger,
} from "../formats/index.mjs";
import { withModuleLock } from "./lock.mjs";
import { resolveArtifact } from "../census/index.mjs";
import { activeToolkitIdentity } from "../toolkit-identity.mjs";
import { jsonBytes } from "../shared/index.mjs";
import { fileExists as exists, integrityFor } from "../store/index.mjs";
import { approveWithOperator, artifactApprover, recorderFor } from "./approval.mjs";
import { previewAdvance, requestFor } from "./artifact-checkpoints.mjs";
import {
  artifactCommandFor,
  artifactIdentityCommand,
  assertArtifactToolkitIdentity,
  assertInvocationMatches,
  bootstrapEventInput,
  eventFor,
  initialArtifactState,
  locate,
  readArtifactState,
  readHistory,
  TRANSACTION_VERSION,
} from "./artifact-record.mjs";
import {
  blockedArtifactResult,
  outcomeResult,
  previewArtifact,
  startMetrics,
  stateFileExists,
} from "./artifact-status.mjs";
import {
  buildAdvanceTransaction,
  pristineFormatUpgrade,
  recoverTransaction,
  writeTransaction,
} from "./artifact-transaction.mjs";
import { exitCodeFor, MIGRATION_MODES } from "./policy.mjs";

// The runtime half of the artifact format-upgrade registry (baseline §4.1):
// how each `ARTIFACT_FORMAT_INCREMENTS` row (formats) runs, keyed by `from`.
const ARTIFACT_FORMAT_UPGRADE_HANDLERS = {
  13: {
    domain: () => "TRANSFORM",
    plan: (options) => previewArtifactFormatUpgrade(options),
    commit: (options) => upgradeArtifactFormat(options),
  },
};

export const ARTIFACT_FORMAT_UPGRADERS = Object.freeze(
  ARTIFACT_FORMAT_INCREMENTS.map((row) =>
    Object.freeze({ ...row, ...ARTIFACT_FORMAT_UPGRADE_HANDLERS[row.from] }),
  ),
);

const createArtifactRecord = async (resolved, options, confirmExecution) => {
  const preview = await previewArtifact(options);
  if (confirmExecution !== preview.confirmationId) {
    throw new Error("Artifact bootstrap confirmation is missing or stale.");
  }
  const timestamp = new Date().toISOString();
  const state = initialArtifactState(resolved, preview.sourceBinding, preview.targetBinding, timestamp);
  await mkdir(resolved.root, { recursive: true });
  const history = await readHistory(resolved.root);
  const event = eventFor(history, state, bootstrapEventInput());
  const transaction = {
    version: TRANSACTION_VERSION,
    previousState: null,
    previousIntegrity: null,
    input: {
      kind: "BOOTSTRAP",
      artifactType: resolved.artifactType,
      source: resolved.source,
      ...(resolved.sourcePaths.length > 1 ? { sourcePaths: resolved.sourcePaths } : {}),
      target: resolved.target,
      ...(usesArtifactDirectLedger(resolved.formatVersion) ? { formatVersion: 14 } : {}),
      designSource: resolved.designSource,
      figmaSources: resolved.figmaSources,
      ...(resolved.ponytail ? { ponytail: resolved.ponytail } : {}),
    },
    state,
    event,
  };
  return writeTransaction(resolved.target.root, resolved.root, transaction);
};

export const bootstrapArtifact = async ({ confirmExecution, ...options } = {}) => {
  const resolved = await resolveArtifact(options);
  return withModuleLock(resolved.target.root, `artifact-${resolved.id}`, async () => {
    await recoverTransaction(resolved.target.root, resolved.root);
    if (await stateFileExists(resolved.root)) throw new Error(`Artifact migration '${resolved.id}' already exists.`);
    return createArtifactRecord(resolved, options, confirmExecution);
  });
};

export const previewArtifactFormatUpgrade = async (options = {}) => {
  const location = locate(options);
  if (await exists(path.join(location.root, TRANSACTION_FILE))) {
    throw Object.assign(new Error("LEGACY_COMPATIBILITY_ACTION_REQUIRED: Artifact has a pending journal."), {
      code: "LEGACY_COMPATIBILITY_ACTION_REQUIRED",
    });
  }
  const state = await readArtifactState(location.targetRoot, location.id);
  assertInvocationMatches(state, options);
  const history = await readHistory(location.root);
  const pristine = await pristineFormatUpgrade(location.root, state, history);
  if (await readFile(path.join(location.root, STATE_FILE), "utf8") !== jsonBytes(state) ||
      await readFile(path.join(location.root, INTEGRITY_FILE), "utf8") !== jsonBytes(pristine.previousIntegrity)) {
    throw Object.assign(new Error("LEGACY_COMPATIBILITY_ACTION_REQUIRED: Bootstrap bytes are not canonical."), {
      code: "LEGACY_COMPATIBILITY_ACTION_REQUIRED",
    });
  }
  return {
    artifactId: state.artifactId,
    from: 13,
    to: 14,
    requiresConfirmation: true,
    confirmationId: pristine.confirmationId,
  };
};

export const upgradeArtifactFormat = async ({ confirmationId, ...options } = {}) => {
  const location = locate(options);
  return withModuleLock(location.targetRoot, `artifact-${location.id}`, async () => {
    const preview = await previewArtifactFormatUpgrade(options);
    if (confirmationId !== preview.confirmationId) {
      throw new Error("Artifact format upgrade confirmation is missing or stale.");
    }
    const previousState = await readArtifactState(location.targetRoot, location.id);
    const history = await readHistory(location.root);
    const state = {
      ...previousState,
      formatVersion: 14,
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    const event = eventFor(history, state, {
      event: "FORMAT_UPGRADED", from: "DISCOVER_LEGACY", to: "DISCOVER_LEGACY", slice: null,
    });
    return writeTransaction(location.targetRoot, location.root, {
      version: TRANSACTION_VERSION,
      previousState,
      previousIntegrity: integrityFor(previousState, history.content),
      input: { kind: "FORMAT_UPGRADE", from: 13, to: 14, confirmationId },
      state,
      event,
    });
  });
};

const runArtifactIteration = async (options = {}) => {
  startMetrics();
  const mode = options.mode ?? "auto";
  // The mode vocabulary has one definition site, in the shared policy module.
  if (!MIGRATION_MODES.includes(mode)) {
    throw new Error(`--mode accepts ${MIGRATION_MODES.map((value) => `'${value}'`).join(" or ")}.`);
  }
  const location = locate(options);
  if (options.upgradeFormat !== undefined) {
    if (options.upgradeFormat !== 14 || options.pilotFormat !== undefined) {
      throw new Error("Only an explicit 13 -> 14 format upgrade is supported.");
    }
    const preview = await previewArtifactFormatUpgrade(options);
    const state = await readArtifactState(location.targetRoot, location.id);
    if (options.confirmationId !== preview.confirmationId) {
      return outcomeResult(state, "AWAITING_CONFIRMATION", "Artifact format upgrade confirmation is pending; nothing was written.", mode, {
        preview, confirmationId: preview.confirmationId,
      });
    }
    const upgraded = await upgradeArtifactFormat(options);
    return outcomeResult(upgraded, "FORMAT_UPGRADED", null, mode);
  }
  if ((mode === "step" || options.pilotFormat === 14) && !(await stateFileExists(location.root))) {
    const preview = await previewArtifact(options);
    if (options.confirmationId !== preview.confirmationId) {
      const synthetic = {
        artifactId: preview.artifactId,
        target: preview.target,
        formatVersion: preview.formatVersion,
        status: "ACTIVE",
        currentStep: "RESOLVE",
        activeSlice: null,
        completedSteps: [],
        completedSlices: [],
        pendingSlices: [],
        revision: 0,
        nextAction: "Confirm standalone artifact bootstrap.",
        nextCommand: artifactCommandFor(preview),
      };
      return outcomeResult(synthetic, "AWAITING_CONFIRMATION", "Bootstrap confirmation is pending; nothing was written.", mode, {
        confirmationId: preview.confirmationId,
        preview,
      });
    }
  }
  return withModuleLock(location.targetRoot, `artifact-${location.id}`, async () => {
    try {
      await recoverTransaction(location.targetRoot, location.root);
    } catch (error) {
      // An unreplayable transaction is a blocked record, and `--status` says so
      // too. Throwing here made the two paths disagree about the same journal.
      const state = await readArtifactState(location.targetRoot, location.id).catch(() => null);
      if (state) return blockedArtifactResult(state, error.message, mode);
      return {
        artifactId: location.id,
        outcome: "BLOCKED",
        reason: error.message,
        exitCode: exitCodeFor("BLOCKED"),
        root: location.root,
      };
    }
    if (!(await stateFileExists(location.root))) {
      const resolved = await resolveArtifact(options);
      const preview = await previewArtifact(options);
      const state = await createArtifactRecord(
        resolved,
        options,
        mode === "auto" && options.pilotFormat !== 14 ? preview.confirmationId : options.confirmationId,
      );
      return outcomeResult(state, "CONTINUE", null, mode);
    }
    const state = await readArtifactState(location.targetRoot, location.id);
    try {
      assertInvocationMatches(state, options);
      assertArtifactToolkitIdentity(state, location.id, "Advancing this artifact migration");
    } catch (error) {
      if (!error.toolkitIdentity && !error.message.startsWith("Invocation ")) throw error;
      const nextCommand = error.toolkitIdentity
        ? activeToolkitIdentity()
          ? artifactIdentityCommand(state, state.toolkitIdentity ? "update" : "adopt")
          : null
        : artifactCommandFor(state);
      return blockedArtifactResult(state, `${error.message}${nextCommand ? ` Next action: ${nextCommand}` : ""}`, mode, nextCommand);
    }
    const preview = await previewAdvance(location.root, state, options);
    if (preview.outcome === "COMPLETE") return outcomeResult(state, "COMPLETE", preview.reason, mode);
    if (preview.outcome === "OPERATOR_DECISION") {
      return outcomeResult(state, "OPERATOR_DECISION", preview.reason, mode, {
        pendingDecisions: preview.validation.pendingDecisions,
        decisionReferences: preview.validation.decisionReferences,
        operatorApproval: preview.validation.operatorApproval,
        ...(preview.validation.decisionProjection ? { decisionProjection: preview.validation.decisionProjection } : {}),
      });
    }
    if (preview.outcome === "BLOCKED") return outcomeResult(state, "BLOCKED", preview.reason, mode,
      preview.validation?.decisionProjection ? { decisionProjection: preview.validation.decisionProjection } : {},
      preview.fresh?.stale ? "STALE" : state.status);
    if (!preview.validation.ready) {
      return outcomeResult(state, "CONTINUE", preview.reason, mode, {
        request: requestFor(state, preview.reason),
        pendingDecisions: preview.validation.pendingDecisions,
        decisionReferences: preview.validation.decisionReferences,
        citations: preview.validation.citations,
        ...(preview.validation.decisionProjection ? { decisionProjection: preview.validation.decisionProjection } : {}),
      });
    }
    if (mode === "step" && options.confirmationId !== preview.confirmationId) {
      return outcomeResult(state, "AWAITING_CONFIRMATION", "Checkpoint confirmation is pending; nothing was written.", mode, {
        confirmationId: preview.confirmationId,
        request: requestFor(state, "Checkpoint artifacts validate."),
        ...(preview.validation.decisionProjection ? { decisionProjection: preview.validation.decisionProjection } : {}),
      });
    }
    if (mode !== "auto" && options.confirmationId !== preview.confirmationId) {
      return outcomeResult(state, "BLOCKED", "Checkpoint confirmation is stale.", mode);
    }
    const transaction = await buildAdvanceTransaction(location.root, state, preview, options.slice);
    const persisted = await writeTransaction(location.targetRoot, location.root, transaction);
    return outcomeResult(
      persisted,
      persisted.status === "COMPLETE" ? "COMPLETE" : "CONTINUE",
      persisted.status === "COMPLETE" ? "Artifact migration reached COMPLETE." : null,
      mode,
    );
  });
};

/**
 * How many times one `runArtifact` call may clear decisions and retry. An upper
 * bound, never a budget: the loop already exits the moment a pass records
 * nothing, and no run can raise decisions at more checkpoints than the record
 * has. Written as the step count so it cannot fall behind a new checkpoint.
 */
const CHECKPOINT_DECISION_PASSES = MIGRATION_STEPS.length;

export const runArtifact = async (
  options = {},
  { recordTrustedDecision, stdout } = {},
) => {
  let result = await runArtifactIteration(options);
  const recorder = recorderFor({ recordTrustedDecision, mode: options.mode,
    directLedger: Boolean(result.decisionProjection), stdout });
  const approver = recorder
    ? artifactApprover(recorder, {
        source: options.source,
        type: options.type ?? "artifact",
        sourceRoot: options.sourceRoot,
        targetRoot: options.targetRoot,
      })
    : null;
  // A human answers one act and the iteration ends; `AUTO` keeps going, because
  // clearing the decisions at DISCOVER_LEGACY only to stop at the ones
  // BUILD_BASELINE raises is the same stop one checkpoint later. Bounded by the
  // checkpoints themselves: each pass must record at least one decision or the
  // loop ends, so it can neither spin nor outlive the record's own lifecycle.
  const passes = approver?.channel === "AUTO" ? CHECKPOINT_DECISION_PASSES : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    if (result.outcome !== "OPERATOR_DECISION") return result;
    const candidates = result.operatorApproval?.candidates ?? [];
    if (!approver || candidates.length === 0) return result;
    const recorded = await approveWithOperator(candidates, approver, null, []);
    if (recorded.length === 0) return result;
    result = await runArtifactIteration(options);
  }
  return result;
};

/**
 * Adopt, update or roll back the toolkit identity of one artifact record.
 *
 * Runs the record's own transaction machinery -- journal, atomic state and
 * integrity writes, hash-chained history append -- as a third transaction kind,
 * so an interrupted adoption is recovered by exactly the same `recoverTransaction`
 * path as an interrupted advance, and then stops. It moves no step, slice, pin
 * or binding and writes no decision.
 */
export const changeArtifactToolkitIdentity = async (options = {}) => {
  const mode = options.mode ?? "adopt";
  if (!["adopt", "update", "rollback"].includes(mode)) {
    throw new Error(`Unknown toolkit identity mode '${mode}'.`);
  }
  const active = activeToolkitIdentity();
  if (!active) {
    throw new Error(
      "The running engine is a source checkout with no build-identity.json and has no identity to stamp. Install a released toolkit bundle and run this against that installation. Nothing was written.",
    );
  }
  const location = locate(options);
  return withModuleLock(location.targetRoot, `artifact-${location.id}`, async () => {
    await recoverTransaction(location.targetRoot, location.root);
    // Full read validation: strict state shape, integrity anchor, hash-chained
    // history and its identity replay, plus every pin.
    const state = await readArtifactState(location.targetRoot, location.id);
    const previous = state.toolkitIdentity ?? null;
    if (mode === "adopt" && previous !== null && !sameToolkitIdentity(previous, active)) {
      throw new Error(
        "This artifact record already pins a toolkit identity. Adoption is for an unstamped record; use update. Nothing was written.",
      );
    }
    if (mode !== "adopt" && previous === null) {
      throw new Error(
        "This artifact record carries no toolkit identity, so there is nothing to update or roll back. Adopt one first. Nothing was written.",
      );
    }
    // Idempotent, therefore replayable: rerunning a command that already
    // succeeded is a no-op, not a second history event.
    if (sameToolkitIdentity(previous, active)) {
      return { artifactId: location.id, changed: false, previous, next: active, root: location.root };
    }
    const history = await readHistory(location.root);
    const proposed = {
      ...state,
      toolkitIdentity: active,
      revision: state.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const transaction = {
      version: TRANSACTION_VERSION,
      previousState: state,
      previousIntegrity: integrityFor(state, history.content),
      input: { kind: "TOOLKIT_IDENTITY", previous, next: active },
      state: proposed,
      event: eventFor(history, proposed, {
        event: previous === null ? "TOOLKIT_IDENTITY_ADOPTED" : "TOOLKIT_IDENTITY_CHANGED",
        from: state.currentStep,
        to: state.currentStep,
        slice: state.activeSlice,
        previous,
        next: active,
      }),
    };
    const persisted = await writeTransaction(location.targetRoot, location.root, transaction);
    return { artifactId: location.id, changed: true, previous, next: active, root: location.root, state: persisted };
  });
};
