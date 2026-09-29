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
 */

import {
  BLOCKED_EXIT_CODE,
  isAutoAuthority,
  MIGRATION_STEPS,
} from "./resumable-migration.mjs";

import { DESIGN_SOURCES } from "./migration-utils.mjs";

// The policy module is where a front end reads the auto-decision policy from;
// its definition site is `resumable-migration.mjs` only because an import cycle
// would form otherwise (see the comment there).
export { isAutoAuthority };

export const MIGRATION_MODES = ["auto", "step"];

const MODE_MESSAGE = "--mode accepts 'auto' or 'step'.";

const DISCOVER_USAGE =
  "Usage: discover-module.mjs <module> [--registry <path>] [--target <target>] [--legacy <module>]... [--adopt-target] [--openspec-proposal-stdin] [--mock] [--brief <path>] [--design-source target-system|figma-mcp|legacy-runtime] [--figma <url>]... [--ponytail [full|full-audit]] [--mode auto|step] [--refresh --confirm-mismatch] [--reopen-discovery] [--reopen-ui <slice[,slice...]>] [--reopen-complete <slice[,slice...]> --reopen-reason <text> --reopen-evidence <path> --confirm-reopen [--confirm-legacy-revision <sha>]] [--rework-slice <id> --confirm-rework] [--amend-slice <id> --add-file <path>...] [--adopt-visual-contract --confirm-adopt-visual-contract] [--adopt-ui-observations [--confirm-adopt-ui-observations <digest>] (pre-format-17 records only; at format 17 and above the normal command owns every format upgrade)] [--scan] [--status] [--doctor] [--slice <id>]";

const ARTIFACT_USAGE =
  "Usage: run-artifact.mjs <source> [--source <additional-source>]... [--type <type>] [--target <path>] [--source-root <path>] [--target-root <path>] [--design-source target-system|figma-mcp|legacy-runtime] [--figma <url>]... [--ponytail full|full-audit] [--status] [--mode auto|step] [--slice <id>] [--json]";

const RUN_USAGE =
  "Usage: run-migration.mjs <module> [--registry <path>] [--target <target>] [--legacy <module>]... [--adopt-target] [--mock] [--brief <path>] [--design-source target-system|figma-mcp|legacy-runtime] [--figma <url>]... [--ponytail [full|full-audit]] [--mode auto|step] [--slice <id>] [--json]";

const hasLegacy = (values) =>
  Array.isArray(values.legacy)
    ? values.legacy.length > 0
    : Boolean(values.legacy);

const assertDesignSource = (values) => {
  if (
    values["design-source"] !== undefined &&
    !DESIGN_SOURCES.includes(values["design-source"])
  ) {
    throw new Error(`--design-source accepts ${DESIGN_SOURCES.join(" or ")}.`);
  }
};

const hasFigma = (values) =>
  Array.isArray(values.figma) ? values.figma.length > 0 : Boolean(values.figma);

const hasAddFile = (values) =>
  Array.isArray(values["add-file"])
    ? values["add-file"].length > 0
    : Boolean(values["add-file"]);

/**
 * Every flag `run` refuses is either read-only or an operator transition
 * (`03` D3-4). `run` is the unattended driver, so each has to be typed
 * deliberately at the command that owns it rather than reached by a loop.
 */
const RUN_REFUSED_OPTIONS = [
  "refresh",
  "reopen-discovery",
  "reopen-ui",
  "reopen-complete",
  "rework-slice",
  "amend-slice",
  "add-file",
  "adopt-visual-contract",
  "adopt-ui-observations",
  "confirm-adopt-ui-observations",
  "doctor",
  "scan",
  "status",
  "confirm-execution",
];

const assertMode = (values) => {
  if (values.mode && !MIGRATION_MODES.includes(values.mode)) {
    throw new Error(MODE_MESSAGE);
  }
};

const assertStepName = (values) => {
  if (values.step && !MIGRATION_STEPS.includes(values.step)) {
    throw new Error(`Unknown migration step '${values.step}'.`);
  }
};

/**
 * The argv refusals, in the order each command applied them before this module
 * existed. Order is part of the contract: a doubly-invalid invocation must keep
 * naming the same problem first.
 *
 * `parsed` is the `parseArgs` result -- `{ positionals, values }` -- so the
 * caller hands over exactly what it already has and nothing is retyped.
 */
export const assertOptionCombination = (
  command,
  { positionals = [], values = {} } = {},
) => {
  if (command === "discover") {
    assertMode(values);
    assertDesignSource(values);
    // --doctor is the clean-host preflight: it reads the environment, never the
    // record, so it refuses every other option for the same reason --status
    // does, and it is checked before the positional rule because "can this host
    // run the engine at all" must be answerable before a module is chosen.
    if (values.doctor) {
      if (
        positionals.length > 1 ||
        Object.entries(values).some(
          ([option, value]) => option !== "doctor" && Boolean(value),
        )
      ) {
        throw new Error(
          "--doctor is read-only and cannot be combined with other options.",
        );
      }
      return;
    }
    if (positionals.length !== 1) {
      throw new Error(DISCOVER_USAGE);
    }
    if (
      values.status &&
      (values.doctor ||
        values.target ||
        values.brief ||
        values.ponytail ||
        values["design-source"] ||
        hasFigma(values) ||
        hasLegacy(values) ||
        values["adopt-target"] ||
        values.refresh ||
        values["reopen-discovery"] ||
        values["reopen-ui"] ||
        values["reopen-complete"] ||
        values["reopen-reason"] ||
        values["reopen-evidence"] ||
        values["confirm-reopen"] ||
        values["rework-slice"] ||
        values["confirm-rework"] ||
        values["amend-slice"] ||
        hasAddFile(values) ||
        values["adopt-visual-contract"] ||
        values["confirm-adopt-visual-contract"] ||
        values["adopt-ui-observations"] ||
        values["confirm-adopt-ui-observations"] ||
        values.scan ||
        values["confirm-execution"] ||
        values["confirm-mismatch"] ||
        values["openspec-proposal-stdin"] ||
        values.mock ||
        values.mode ||
        values.registry ||
        values.slice)
    ) {
      throw new Error(
        "--status is read-only and cannot be combined with other options.",
      );
    }
    // --scan recomputes and prints; it must never be the read half of a
    // read-then-write invocation, or the JSON printed stops describing the tree
    // the write acted on.
    if (
      values.scan &&
      (values.doctor ||
        values.refresh ||
        values["reopen-discovery"] ||
        values["reopen-ui"] ||
        values["reopen-complete"] ||
        values["rework-slice"] ||
        values["amend-slice"] ||
        hasAddFile(values) ||
        values["adopt-visual-contract"] ||
        values["adopt-ui-observations"] ||
        values["confirm-adopt-ui-observations"] ||
        values["confirm-execution"] ||
        values["confirm-mismatch"] ||
        values.brief ||
        values["design-source"] ||
        hasFigma(values) ||
        hasLegacy(values) ||
        values["adopt-target"] ||
        values["openspec-proposal-stdin"] ||
        values.slice)
    ) {
      throw new Error(
        "--scan is read-only and cannot be combined with a mutating option.",
      );
    }
    if (
      values["confirm-adopt-ui-observations"] !== undefined && !values["adopt-ui-observations"]
    ) {
      throw new Error("--confirm-adopt-ui-observations requires --adopt-ui-observations.");
    }
    if (
      values["adopt-ui-observations"] &&
      Object.entries(values).some(([option, value]) =>
        !["adopt-ui-observations", "confirm-adopt-ui-observations", "registry"].includes(option) &&
        Boolean(value) && (!Array.isArray(value) || value.length > 0),
      )
    ) {
      throw new Error("--adopt-ui-observations is its own transition; use it with only --registry and optional --confirm-adopt-ui-observations <digest>.");
    }
    if (
      [
        values["reopen-discovery"],
        values["reopen-ui"],
        values["rework-slice"],
        values["adopt-visual-contract"],
        values.refresh,
      ].filter(Boolean).length > 1
    ) {
      throw new Error(
        "--reopen-discovery, --reopen-ui, --rework-slice, --adopt-visual-contract, and --refresh are different transitions; use exactly one.",
      );
    }
    // Adoption changes what a completed record means, so it carries its own
    // typed confirmation on top of the two-phase confirmation ID.
    if (
      values["adopt-visual-contract"] !==
      values["confirm-adopt-visual-contract"]
    ) {
      throw new Error(
        "--adopt-visual-contract and --confirm-adopt-visual-contract must be given together: adoption moves a completed Figma record onto the format-17 visual contract and names the slices to reverify.",
      );
    }
    // Its own message, so the five older transitions keep theirs verbatim.
    if (
      values["reopen-complete"] &&
      (values["reopen-discovery"] ||
        values["reopen-ui"] ||
        values["rework-slice"] ||
        values["confirm-rework"] ||
        values["amend-slice"] ||
        values["adopt-visual-contract"] ||
        values.refresh)
    ) {
      throw new Error(
        "--reopen-complete is its own transition and cannot be combined with --reopen-discovery, --reopen-ui, --rework-slice, --amend-slice, --adopt-visual-contract, or --refresh.",
      );
    }
    // Invalidating a finalized contract is the heaviest operator act the
    // lifecycle has, so all three parts must be typed: which slices, why, and
    // the evidence that proves it. Any one of them alone fails closed.
    // Under `--mode auto` the deciding principal is AUTO, and AUTO assents by
    // deriving the transition, not by typing a flag: requiring a human
    // confirmation there would demand an operator the mode declares absent.
    // Reason and evidence stay mandatory in both modes -- AUTO decides whether
    // supplied evidence authorizes the reopen, it never supplies it.
    if (
      values["reopen-complete"] &&
      !values["confirm-reopen"] &&
      values.mode !== "auto"
    ) {
      throw new Error(
        "--reopen-complete requires --confirm-reopen: it invalidates the finalized verification of a COMPLETE migration.",
      );
    }
    if (values["reopen-complete"] && !values["reopen-reason"]) {
      throw new Error(
        "--reopen-complete requires --reopen-reason <text>: the reopen event is the permanent record of why a finalized contract stopped being true.",
      );
    }
    if (values["reopen-complete"] && !values["reopen-evidence"]) {
      throw new Error(
        "--reopen-complete requires --reopen-evidence <path>: a repository-relative path to the authoritative post-finalization evidence.",
      );
    }
    for (const option of [
      "confirm-reopen",
      "reopen-reason",
      "reopen-evidence",
      "confirm-legacy-revision",
    ]) {
      if (values[option] && !values["reopen-complete"]) {
        throw new Error(`--${option} requires --reopen-complete <slice[,slice...]>.`);
      }
    }
    // Its own message, so the five older transitions keep theirs verbatim.
    if (
      values["amend-slice"] &&
      (values["reopen-discovery"] ||
        values["reopen-ui"] ||
        values["rework-slice"] ||
        values["confirm-rework"] ||
        values["adopt-visual-contract"] ||
        values.refresh)
    ) {
      throw new Error(
        "--amend-slice is its own transition and cannot be combined with --reopen-discovery, --reopen-ui, --rework-slice, --adopt-visual-contract, or --refresh.",
      );
    }
    if (values["amend-slice"] && !hasAddFile(values)) {
      throw new Error(
        "--amend-slice requires at least one --add-file <path>: an amendment only adds files to the slice record.",
      );
    }
    if (hasAddFile(values) && !values["amend-slice"]) {
      throw new Error("--add-file requires --amend-slice <id>.");
    }
    // Preserving a failed attempt and releasing a pinned slice is an operator
    // act, so it carries its own explicit confirmation the way --refresh does.
    // A flag nobody has to type is exactly what turns a boundary into a
    // formality.
    if (values["rework-slice"] && !values["confirm-rework"]) {
      throw new Error(
        "--rework-slice requires --confirm-rework: it preserves the failed verification attempt and returns the slice to implementation.",
      );
    }
    if (values["confirm-rework"] && !values["rework-slice"]) {
      throw new Error("--confirm-rework requires --rework-slice <id>.");
    }
    // `--refresh`, `--reopen-ui`, `--rework-slice`, `--reopen-complete`,
    // `--adopt-visual-contract` and `--amend-slice` used to throw under
    // `--mode auto`. They no longer do. Each one is decided from evidence the
    // engine already holds, and `--mode auto` is an authority
    // (`isAutoAuthority`), not an exemption: the transition still re-verifies
    // its confirmation ID, still writes its ledger line, and still carries the
    // digests that invalidate it if the bytes move. What changed is who
    // assents, not what is checked.
    return;
  }
  if (command === "run") {
    assertMode(values);
    assertDesignSource(values);
    if (positionals.length !== 1) {
      throw new Error(RUN_USAGE);
    }
    const refused = RUN_REFUSED_OPTIONS.find((option) => values[option]);
    if (refused) {
      throw new Error(
        `--${refused} is not accepted by run-migration.mjs; invoke it by name with discover-module.mjs.`,
      );
    }
    return;
  }
  // The standalone artifact front end. It is a second front end onto the same
  // policy, not a second policy: `--mode` and `--status` mean here exactly what
  // they mean for `discover` and `run`, and they are decided in one place.
  if (command === "artifact") {
    assertMode(values);
    assertDesignSource(values);
    if (positionals.length !== 1) {
      throw new Error(ARTIFACT_USAGE);
    }
    if (
      values.status &&
      (values.mode || values.slice || values.ponytail || values["design-source"] || hasFigma(values))
    ) {
      throw new Error(
        "--status is read-only and cannot be combined with --mode, --slice, --ponytail, --design-source, or --figma.",
      );
    }
    return;
  }
  if (command === "advance") {
    assertStepName(values);
    assertMode(values);
    return;
  }
  if (command === "validate") {
    assertStepName(values);
    return;
  }
  throw new Error(`Unknown command '${command}' for option validation.`);
};

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
