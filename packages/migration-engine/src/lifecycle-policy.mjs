/**
 * Deterministic policy that used to live in the CLI wrappers (Plan 02 D2-4,
 * D2-5). Every function here is pure: no filesystem, no lock, no clock, no
 * randomness, no stdout. That is what makes them safe to call from any front
 * end -- the CLI, the MCP adapter, or a test -- and it is why a wrong verdict
 * can only fail closed: `assertOptionCombination` throws, and `maySelfConfirm`
 * returning `false` stops for confirmation.
 *
 * Each rule has exactly one definition site. A second front end that wants a
 * different answer has to change it here, in the open, instead of quietly
 * carrying its own copy.
 *
 * Track A7: this is the mode and outcome half. The argv refusals
 * (`assertOptionCombination`) are transport's, in `transport/arguments.mjs`;
 * `migration-policy.mjs` still exports both halves for compatibility.
 */

import { BLOCKED_EXIT_CODE, isAutoAuthority } from "./resumable-migration.mjs";

// The policy module is where a front end reads the auto-decision policy from;
// its definition site is `resumable-migration.mjs` only because an import cycle
// would form otherwise (see the comment there).
export { isAutoAuthority };

export const MIGRATION_MODES = ["auto", "step"];

/**
 * Whether this invocation may supply the confirmation ID the operator would
 * otherwise type.
 *
 * This was a denylist -- `mode !== "step" && !refresh && !reopenUi && ...` --
 * which meant every transition added later defaulted to operator-required and
 * the only available fix was one more `!flag`. That structure guaranteed the
 * next feature would reintroduce the stop, which is why the point fixes never
 * converged. It is now the policy above and nothing else: under `auto` the
 * process confirms its own preview, in every command, for every transition.
 *
 * A confirmation ID is integrity machinery, not authority machinery. It binds a
 * preview to the bytes it previewed and `assertExecutionConfirmation`
 * re-verifies it on the execution side regardless of who supplied it, so
 * self-confirming can never widen what the transition is allowed to do -- only
 * a preflight that already said yes can be confirmed at all.
 */
export const maySelfConfirm = ({ command, mode } = {}) => {
  if (command !== "registry" && command !== "advance" && command !== "discover") {
    throw new Error(`Unknown command '${command}' for self-confirmation.`);
  }
  return isAutoAuthority(mode);
};

/**
 * The closed outcome set (`03` D3-1, shipped by `02` D2-5). The member *is* the
 * `reason=` token `renderLoopDirective` prints: a second mapping table would be
 * a second place the two can drift.
 */
export const MIGRATION_OUTCOMES = Object.freeze([
  "CONTINUE",
  "AWAITING_CONFIRMATION",
  "COMPLETE",
  "OPERATOR_DECISION",
  "BLOCKED",
  "FAILED",
  // A format increment is owed but cannot commit yet (its declared input is
  // absent, or the upgrader refused it): fail-closed, nothing was written, and
  // the lifecycle stays frozen behind it.
  "FORMAT_UPGRADE",
  // Exactly one adjacent increment committed. A success stop, not a lifecycle
  // step: the next normal invocation decides whether another one is owed.
  "FORMAT_UPGRADED",
]);

const EXIT_CODES = {
  CONTINUE: 0,
  AWAITING_CONFIRMATION: 0,
  COMPLETE: 0,
  FAILED: 1,
  OPERATOR_DECISION: BLOCKED_EXIT_CODE,
  BLOCKED: BLOCKED_EXIT_CODE,
  FORMAT_UPGRADE: BLOCKED_EXIT_CODE,
  FORMAT_UPGRADED: 0,
};

/**
 * Total over `MIGRATION_OUTCOMES`, and only over it. An unrecognized outcome
 * throws instead of defaulting: a front end that invents a seventh value must
 * fail loudly rather than silently exit 0.
 */
export const exitCodeFor = (outcome) => {
  if (!Object.hasOwn(EXIT_CODES, outcome)) {
    throw new Error(`Unknown migration outcome '${outcome}'.`);
  }
  return EXIT_CODES[outcome];
};

/**
 * The typed continuation, read off values the core already returned --
 * `previewMigrationExecution` / `previewAdvance` for `preview`, and
 * `bootstrapMigration` / `advanceMigration` for `result`. Both keep their
 * current return shapes; this is a separate reader, not a changed contract
 * (D2-5).
 *
 * `result` absent means the two-phase prompt was printed and nothing ran.
 * `next` is the checkpoint the record now sits on, or `null` when the loop
 * stops. `OPERATOR_DECISION` is in the enum so `exitCodeFor` is total from the
 * first commit; Plan 03 is its first producer.
 */
export const nextOutcome = ({ preview, result = null } = {}) => {
  // The format upgrade outranks the lifecycle, so it is read before the
  // confirmation question: an owed increment stops the invocation with its own
  // typed reason rather than the generic BLOCKED, and a committed one stops it
  // too -- a rerun of the same normal command decides what is owed next.
  if (result?.upgraded === true) {
    return {
      outcome: "FORMAT_UPGRADED",
      reason: `Format ${result.from} -> ${result.to} committed. Rerun the normal command to continue.`,
      next: null,
    };
  }
  // Active only: an owed-but-inactive increment names a prerequisite the normal
  // lifecycle produces, so it is not a stop and never this invocation's outcome.
  const pendingUpgrade = preview?.formatUpgrade?.active ? preview.formatUpgrade : null;
  if (pendingUpgrade && pendingUpgrade.state !== "READY") {
    return {
      outcome: "FORMAT_UPGRADE",
      reason:
        pendingUpgrade.blockers?.length > 0
          ? pendingUpgrade.blockers.join("; ")
          : pendingUpgrade.nextAction,
      next: null,
    };
  }
  if (!preview?.requiresConfirmation) {
    return {
      outcome: "BLOCKED",
      reason:
        preview?.blockers?.length > 0
          ? preview.blockers.join("; ")
          : "The preflight refused this invocation.",
      next: null,
    };
  }
  if (!result) {
    return {
      outcome: "AWAITING_CONFIRMATION",
      reason: "Two-phase confirmation is pending; no execution has started.",
      next: null,
    };
  }
  const currentStep = result.state?.currentStep ?? null;
  if (currentStep === "COMPLETE") {
    return {
      outcome: "COMPLETE",
      reason: "The migration reached its final checkpoint.",
      next: null,
    };
  }
  return {
    outcome: "CONTINUE",
    reason: null,
    next: currentStep,
  };
};
