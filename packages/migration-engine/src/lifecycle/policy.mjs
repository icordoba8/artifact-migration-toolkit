/**
 * Lifecycle: mode, outcome and exit-code policy (Track A8).
 *
 * Deterministic policy that used to live in the CLI wrappers (Plan 02 D2-4,
 * D2-5). Every function here is pure: no filesystem, no lock, no clock, no
 * randomness, no stdout. That is what makes them safe to call from any front
 * end -- the CLI, the MCP adapter, or a test -- and it is why a wrong verdict
 * can only fail closed: `maySelfConfirm` returning `false` stops for
 * confirmation.
 *
 * Each rule has exactly one definition site. A second front end that wants a
 * different answer has to change it here, in the open, instead of quietly
 * carrying its own copy.
 *
 * Track A8 joined the two halves that A7 left apart: the mode, outcome and
 * self-confirmation policy (formerly `lifecycle-policy.mjs`) and
 * `BLOCKED_EXIT_CODE`, `DEFAULT_MODE`, `isAutoAuthority` and
 * `renderLoopDirective` (formerly `resumable-migration.mjs`). The argv refusals
 * stay transport's, in `transport/arguments.mjs`.
 */

/**
 * Documented process exit code for "blocked, nothing was executed". A blocked
 * invocation used to exit 0, so in CI or any scripted driver a refused
 * migration was indistinguishable from a completed one. 1 stays the generic
 * failure code; 2 means the preflight refused and no file was touched.
 */
export const BLOCKED_EXIT_CODE = 2;

/**
 * What an absent `--mode` means. Both CLIs already treat it as `auto`
 * (`options.mode !== "step"`); naming it keeps the rendered checklist from
 * reporting `mode=none` for a run that is in fact autonomous.
 */
export const DEFAULT_MODE = "auto";

/**
 * The one canonical auto-decision policy, and the only definition of it.
 *
 * `auto` is a *principal*, not an exemption list. A process running under it is
 * the authority for every decision derivable from evidence the engine already
 * holds -- the preflight verdict, the confirmation ID the engine itself minted,
 * the slice plan, the decision ledger, the dirty manifest, the git revision,
 * `build-identity.json`. `step` hands that authority to a human.
 *
 * Nothing about integrity moves with it. Whichever principal answers, the
 * confirmation ID is still re-verified, the ledger line is still appended and
 * chained, and every digest that invalidates a stale decision still invalidates
 * it. This decides *who assents*, never *what is checked*.
 *
 * Track A8: it now lives in the lifecycle policy file with the mode and outcome
 * policy it belongs to. `resumable-migration.mjs`, `lifecycle-policy.mjs` and
 * `migration-policy.mjs` re-export this one binding.
 */
export const isAutoAuthority = (mode) => (mode ?? DEFAULT_MODE) !== "step";

/**
 * The last line of an iteration, and the only thing that decides whether
 * another one runs. The agent obeys it literally instead of inferring
 * continuation from prose -- which is what made autonomy model-volition
 * rather than contract. `STOP` always names a typed reason.
 *
 * A two-branch formatter over the closed outcome set (`02` D2-5): the member
 * *is* the `reason=` token, so `CONTINUE` prints the continue line and every
 * other outcome prints itself. Bytes are unchanged for every input.
 *
 * Empty under `--mode step`: there is no loop to drive there, the operator
 * confirms every iteration by hand, and the two-phase prompt is the last thing
 * that run is allowed to say.
 */
/**
 * The one loop-directive renderer. `next` exists so a second front end can
 * name its own continuation command instead of copying this function -- the
 * artifact CLI carried its own copy and could emit `loop: STOP reason=CONTINUE`,
 * a token outside the closed stop set, at the one place the protocol forbids a
 * provider to improvise. One function, two callers.
 *
 * `outcome` must already be a member of `MIGRATION_OUTCOMES`; `exitCodeFor` is
 * total over that set and throws on anything else, so an invented seventh value
 * cannot reach a directive line.
 */
export const renderLoopDirective = ({
  moduleName,
  mode,
  outcome,
  next = `/start-migration ${moduleName}`,
}) =>
  mode === "step"
    ? ""
    : // A committed increment ends its invocation but not the run: the driver
      // must start a *new* normal invocation with no agent decision in
      // between, which is what CONTINUE means and STOP does not. It continues
      // through the *same* `next` as CONTINUE -- `next=` names a command the
      // front end can actually execute, so a symbolic token there would be a
      // line the driver cannot obey.
      outcome === "CONTINUE" || outcome === "FORMAT_UPGRADED"
      ? `loop: CONTINUE next=${next}\n`
      : `loop: STOP reason=${outcome}\n`;

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
