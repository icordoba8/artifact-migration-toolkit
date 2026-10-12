/**
 * Lifecycle: the progress projection and its renderers. Moved verbatim from
 * `resumable-migration.mjs` (Track A8).
 */
import { MAX_SLICE_REWORKS, stepsFor } from "../formats/index.mjs";
import { reworkAttemptsOf } from "../slices/index.mjs";
import { activeArtifact } from "./checkpoints.mjs";
import { DEFAULT_MODE } from "./policy.mjs";

/**
 * The canonical progress projection (Plan 09). One deterministic reading of a
 * persisted record, shared by every front end -- Claude Code, Codex, GitHub
 * Copilot, OpenCode -- so that a provider's native task UI and the text
 * fallback can never disagree about what the migration is doing.
 *
 * Derived data only. It reads `state` and the outcome the caller was just
 * handed; it persists nothing, defines no transition, infers nothing from
 * source files, and carries no provider-specific UI field. Delete it and the
 * engine is unchanged.
 *
 * `stepsFor(state)` rather than `MIGRATION_STEPS`: a format-9 record was born
 * under the eight-checkpoint lifecycle and must not be shown a phantom
 * DISCOVERY_COMPLETENESS row it never had.
 *
 * `mode` is null for read-only callers (`--status`), which report `none`
 * rather than naming a mode that was never supplied. `outcome`/`reason` are
 * what `nextOutcome` returned for this iteration; `migration_status` has no
 * iteration and passes neither, so a read-only projection is never BLOCKED on
 * anything but the record's own status.
 */
export const CHECKPOINT_STATES = Object.freeze([
  "COMPLETED",
  "ACTIVE",
  "PENDING",
  "BLOCKED",
]);

/** The outcomes that mean the active checkpoint did not move. */
// A pending format upgrade stops the invocation, so the active checkpoint
// renders BLOCKED through the machinery that already renders every other stop.
const STOPPING_OUTCOMES = new Set([
  "BLOCKED",
  "OPERATOR_DECISION",
  "FAILED",
  "FORMAT_UPGRADE",
]);

export const migrationProgress = (
  state,
  {
    lifecycle = null,
    mode = null,
    outcome = null,
    reason = null,
    uiEvidence = null,
    nextWorkKind = null,
    artifactMigration = null,
    // The §4 projection or null. Passed in by the caller that read it; this
    // function performs no I/O, exactly as with `uiEvidence`.
    formatUpgrade = null,
  } = {},
) => {
  const recordLifecycle = lifecycle ?? stepsFor(state);
  const completedSteps = new Set(state.completedSteps);
  const complete = state.currentStep === "COMPLETE";
  const stopped =
    !complete &&
    (STOPPING_OUTCOMES.has(outcome ?? "") || state.status !== "ACTIVE");
  const checkpoints = recordLifecycle.map((name, index) => ({
    index: index + 1,
    total: recordLifecycle.length,
    name,
    state:
      complete || completedSteps.has(name)
        ? "COMPLETED"
        : name !== state.currentStep
          ? "PENDING"
          : stopped
            ? "BLOCKED"
            : "ACTIVE",
  }));
  const activeCheckpoint = complete ? null : (state.currentStep ?? null);
  // The state's own progression order, never sorted: slice ids are not
  // required to be lexicographic, and sorting would misreport the sequence.
  // `pendingSlices` still contains the active slice, so it is filtered against
  // what has already been placed rather than listed twice under two markers.
  const completedSlices = state.completedSlices ?? [];
  const pendingSlices = state.pendingSlices ?? [];
  const placed = new Set(completedSlices);
  if (state.activeSlice) placed.add(state.activeSlice);
  // A reworked slice is shown with its attempt count, so an operator reading
  // the checklist sees `roles-002 (rework 2/3)` rather than an unexplained
  // repeat of work that already looked finished.
  const withAttempts = (id, sliceState) => {
    const attempt = reworkAttemptsOf(state, id);
    return attempt > 0
      ? { id, state: sliceState, rework: { attempt, limit: MAX_SLICE_REWORKS } }
      : { id, state: sliceState };
  };
  const items = [
    ...completedSlices.map((id) => withAttempts(id, "COMPLETED")),
    ...(state.activeSlice
      ? [withAttempts(state.activeSlice, stopped ? "BLOCKED" : "ACTIVE")]
      : []),
    ...pendingSlices
      .filter((id) => !placed.has(id))
      .map((id) => withAttempts(id, "PENDING")),
  ];
  return {
    module: state.legacyModule,
    target: state.targetModule,
    status: state.status,
    revision: state.revision,
    mode: mode ?? "none",
    checkpoints,
    activeCheckpoint,
    activeSlice: complete ? null : (state.activeSlice ?? null),
    slices: {
      completed: completedSlices.length,
      total: items.length,
      items,
    },
    // Visible-UI verification (format 12) is sub-work inside the existing
    // checkpoints -- DISCOVER_LEGACY inventories it, ASSESS_TARGET and PLAN
    // trace it, VERIFY_SLICES proves it per slice, FINALIZE gates it -- so it
    // is reported beneath them and never promoted to a tenth checkpoint.
    // Passed through from the caller that already read the evidence; this
    // function performs no I/O and computes no availability of its own, so a
    // caller without it (`migration_run`) reports null rather than a guess.
    uiEvidence,
    // Reported above the checkpoints by `renderProgress`; only an active
    // increment freezes the checklist below it.
    formatUpgrade,
    blocker: stopped ? (reason ?? null) : null,
    stopReason: stopped ? (outcome ?? state.status) : null,
    // Where the migration resumes, and -- unless it is stopped -- the command
    // that resumes it. A stop keeps the checkpoint, slice, action and artifact,
    // because an operator clearing a blocker still needs to know where they
    // are; it drops `command`, because there is nothing to run until the
    // blocker is cleared and a command field reads as permission to run it.
    // Same rule the text form states as `next: none until the blocker is
    // cleared`, from this one projection.
    nextWork: complete
      ? null
      : {
          ...(nextWorkKind === "RUN_ARTIFACT"
            ? {
                kind: nextWorkKind,
                checkpoint: state.currentStep,
                slice: state.activeSlice ?? null,
                action: "Run the delegated artifact prerequisite.",
                artifact: artifactMigration?.artifactId ?? null,
                command: artifactMigration?.command ?? null,
                artifactMigration,
              }
            : {
                checkpoint: state.currentStep,
                slice: state.activeSlice ?? null,
                action: state.nextAction ?? null,
                artifact: activeArtifact(state),
                command: state.nextCommand ?? null,
              }),
          ...(stopped ? { command: null } : {}),
        },
  };
};

const CHECKPOINT_MARKERS = {
  COMPLETED: "[x]",
  ACTIVE: "[>]",
  PENDING: "[ ]",
  BLOCKED: "[!]",
};

/**
 * The deterministic progress block the agent relays verbatim, rendered from
 * the projection above and from nothing else -- one source, so a provider that
 * reads `progress` and a provider that reads this text can never drift.
 *
 * Pure by contract: no I/O, no timestamps, no randomness, and ASCII only --
 * the five-tree `--status` parity test compares this byte for byte, and emoji
 * do not survive a Windows terminal.
 */
export const renderProgress = (progress) => {
  const lines = [];
  // The owed increment, stated before the checklist it concerns. Absent -- which
  // is every record at the runtime format -- the block is not rendered and the
  // bytes below are the bytes this function always produced.
  const upgrade = progress.formatUpgrade ?? null;
  if (upgrade) {
    // Two headings, because they are two different facts. An inactive
    // increment is owed and nothing more -- the checklist under it is live, so
    // it must not claim to be frozen, and it names the prerequisite the
    // lifecycle is expected to produce rather than an input to author.
    const inactive = upgrade.active === false;
    lines.push(
      inactive ? "FORMAT UPGRADE PENDING" : "FORMAT UPGRADE REQUIRED",
      `record format: ${upgrade.recordFormat}`,
      `runtime format: ${upgrade.runtimeFormat}`,
      `current upgrade: ${upgrade.from}->${upgrade.to}` +
        (upgrade.upgrader
          ? ` (${upgrade.upgrader.id} v${upgrade.upgrader.version})`
          : " (no registered upgrader)"),
      inactive
        ? `upgrade state: ${upgrade.state}`
        : `upgrade state: ${upgrade.state} (domain: ${upgrade.domain ?? "unclassified"})`,
    );
    if (inactive) {
      lines.push(
        `prerequisite: ${upgrade.prerequisite.kind} ${upgrade.prerequisite.path}`,
        "next action: continue normal migration until the prerequisite is validated/pinned",
      );
    } else {
      lines.push(
        `required input: ${
          upgrade.requiredInput
            ? `${upgrade.requiredInput.kind} ${upgrade.requiredInput.path} (authority: ${upgrade.requiredInput.authority})`
            : "none"
        }`,
      );
      for (const blocker of upgrade.blockers ?? []) {
        lines.push(`upgrade blocker: ${blocker}`);
      }
      lines.push(
        `next action: ${upgrade.nextAction}`,
        "--- normal progress (frozen behind the upgrade) ---",
      );
    }
  }
  lines.push(
    `progress: ${progress.module} -> ${progress.target}` +
      `  status=${progress.status}  revision=${progress.revision}` +
      `  mode=${progress.mode}`,
  );
  for (const checkpoint of progress.checkpoints) {
    const active =
      checkpoint.name === progress.activeCheckpoint && progress.activeSlice
        ? `  active=${progress.activeSlice}`
        : "";
    lines.push(
      `${CHECKPOINT_MARKERS[checkpoint.state]} ${checkpoint.index}/${checkpoint.total} ${checkpoint.name}${active}`,
    );
  }
  if (progress.slices.items.length > 0) {
    lines.push(
      `slices: ${progress.slices.completed}/${progress.slices.total} done`,
    );
    for (const slice of progress.slices.items) {
      // Byte-identical for a slice that was never reworked.
      const rework = slice.rework
        ? ` (rework ${slice.rework.attempt}/${slice.rework.limit})`
        : "";
      lines.push(`  ${CHECKPOINT_MARKERS[slice.state]} ${slice.id}${rework}`);
    }
  }
  if (progress.uiEvidence?.applicable) {
    const ui = progress.uiEvidence;
    lines.push(
      `ui evidence: ${ui.state}  runtime=${ui.runtime}` +
        `  records=${ui.records}  limitations=${ui.limitations}` +
        `  freshness=${ui.freshness}`,
    );
  }
  // Only ever present on a stop, so a CONTINUE iteration renders byte for byte
  // what it rendered before this projection existed.
  if (progress.stopReason) {
    lines.push(`stop reason: ${progress.stopReason}`);
    if (progress.blocker) lines.push(`blocker: ${progress.blocker}`);
  }
  // A stop has no executable next step. Naming the checkpoint here read as
  // work the operator could start, directly under a `[!]` row saying they
  // could not -- the one line in the block that contradicted the rest of it.
  if (progress.nextWork) {
    lines.push(
      progress.stopReason
        ? "next: none until the blocker is cleared"
        : `next: ${progress.nextWork.checkpoint}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

/**
 * What a tool row or terminal shows first, with no agent in between: one status
 * line, `progressChecklist` verbatim, then the loop line. Read from the same
 * projection `renderProgress` reads, so it cannot disagree with the checklist
 * under it; ASCII for the same reason. Empty when there is no progress.
 */
export const renderProgressBlock = (
  { progress, progressChecklist, outcome = null },
  loop = "",
) => {
  if (!progress || !progressChecklist) return "";
  const total = progress.checkpoints.length;
  const active = progress.checkpoints.find(
    ({ name }) => name === progress.activeCheckpoint,
  );
  const slice =
    progress.activeSlice &&
    ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(progress.activeCheckpoint)
      ? ` | slice ${progress.activeSlice} (${progress.slices.completed}/${progress.slices.total} done)`
      : "";
  return (
    `${progress.module} -> ${progress.target}` +
    ` | ${active ? `${active.index}/${total} ${active.name}` : `${total}/${total} COMPLETE`}` +
    `${slice} | ${outcome ?? progress.stopReason ?? progress.status}\n` +
    `${progressChecklist}${loop}`
  );
};

/** The pre-projection entry point, kept verbatim for every existing caller. */
export const renderProgressChecklist = (
  state,
  mode,
  outcome = null,
  reason = null,
  formatUpgrade = null,
) =>
  renderProgress(
    migrationProgress(state, { mode, outcome, reason, formatUpgrade }),
  );

/**
 * The projection a *preview* reports. A preview runs no iteration, so the only
 * outcome it can carry is its own refusal: blockers present means this
 * invocation stops, and the block renders at the checkpoint it happened on
 * rather than as an active row the operator could act on.
 */
export const previewProgress = (state, mode, blockers) =>
  migrationProgress(state, {
    mode: mode ?? DEFAULT_MODE,
    outcome: blockers.length > 0 ? "BLOCKED" : null,
    reason: blockers.length > 0 ? blockers.join("; ") : null,
  });
