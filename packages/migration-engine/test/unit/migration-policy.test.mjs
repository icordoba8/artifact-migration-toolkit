/**
 * Plan 02 §11. Every rule this suite covers was, before the plan, either
 * duplicated across CLI wrappers or enforced by the absence of a branch. The
 * point of each test is the same: the verdict the wrappers produce today, still
 * produced, from one place.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  activeArtifact,
  authoringRequest,
  checkpointArtifacts,
  exitCodeFor,
  isAutoAuthority,
  MIGRATION_OUTCOMES,
  MIGRATION_STEPS,
  maySelfConfirm,
  nextOutcome,
  renderLoopDirective,
  assertOptionCombination,
} from "../../src/core.mjs";

const parsed = (values = {}, positionals = ["auth"]) => ({ positionals, values });

const refusal = (command, values, positionals) => {
  try {
    assertOptionCombination(command, parsed(values, positionals));
  } catch (error) {
    return error.message;
  }
  return null;
};

// -- §11.1 combination refusals: four combination rules, two shape checks, and
// the two step-name checks, each asserting the exact message the wrapper threw.

test("--mode accepts only auto or step", () => {
  assert.equal(
    refusal("discover", { mode: "turbo" }),
    "--mode accepts 'auto' or 'step'.",
  );
  assert.equal(
    refusal("advance", { mode: "turbo" }),
    "--mode accepts 'auto' or 'step'.",
  );
  assert.equal(refusal("discover", { mode: "auto" }), null);
  assert.equal(refusal("discover", { mode: "step" }), null);
});

test("discover takes exactly one positional", () => {
  const usage = refusal("discover", {}, []);
  assert.match(usage, /^Usage: discover-module\.mjs <module> /);
  assert.equal(refusal("discover", {}, ["auth", "extra"]), usage);
  assert.equal(refusal("discover", {}, ["auth"]), null);
});

test("--status refuses every other option", () => {
  const message = "--status is read-only and cannot be combined with other options.";
  for (const option of [
    "target",
    "brief",
    "ponytail",
    "refresh",
    "reopen-discovery",
    "reopen-ui",
    "scan",
    "confirm-execution",
    "confirm-mismatch",
    "openspec-proposal-stdin",
    "mock",
    "registry",
    "slice",
  ]) {
    assert.equal(
      refusal("discover", { status: true, [option]: "x" }),
      message,
      option,
    );
  }
  assert.equal(refusal("discover", { status: true, mode: "auto" }), message);
  assert.equal(refusal("discover", { status: true }), null);
});

test("--scan refuses every mutating option", () => {
  const message = "--scan is read-only and cannot be combined with a mutating option.";
  for (const option of [
    "refresh",
    "reopen-discovery",
    "reopen-ui",
    "confirm-execution",
    "confirm-mismatch",
    "brief",
    "openspec-proposal-stdin",
    "slice",
  ]) {
    assert.equal(refusal("discover", { scan: true, [option]: "x" }), message, option);
  }
  // `--scan` stays legal beside the read-only options.
  assert.equal(refusal("discover", { scan: true, registry: "r", mock: true }), null);
});

test("--reopen-discovery and --refresh are exclusive transitions", () => {
  assert.equal(
    refusal("discover", { "reopen-discovery": true, refresh: true }),
    "--reopen-discovery, --reopen-ui, --rework-slice, --adopt-visual-contract, and --refresh are different transitions; use exactly one.",
  );
  assert.equal(refusal("discover", { "reopen-discovery": true }), null);
});

// Posture change, recorded deliberately: these four transitions used to *throw*
// under `--mode auto`, on the theory that automation may never take them. The
// theory the toolkit now holds is that AUTO is a principal rather than an
// exemption -- it takes them on its own declared authority, every gate they
// pass still runs, and the act is recorded as AUTO's. What must never happen is
// an agent taking them while wearing an operator's name, and that is proven
// separately (`record-decision.test.mjs`, `run-migration.test.mjs`).
test("--refresh is a transition either principal may take", () => {
  for (const mode of ["auto", "step", undefined]) {
    assert.equal(refusal("discover", { mode, refresh: true }), null, String(mode));
  }
});

test("--reopen-ui is exclusive, in every mode", () => {
  for (const mode of ["auto", "step", undefined]) {
    assert.equal(refusal("discover", { mode, "reopen-ui": "slice-a" }), null, String(mode));
  }
  assert.equal(
    refusal("discover", { "reopen-ui": "slice-a", refresh: true }),
    "--reopen-discovery, --reopen-ui, --rework-slice, --adopt-visual-contract, and --refresh are different transitions; use exactly one.",
  );
});

test("every former auto-refusal is gone, and only the auto-refusals", () => {
  // The exact set `assertOptionCombination` used to throw on. None of them may
  // refuse for the mode any more; all of them must still refuse for the reasons
  // that have nothing to do with who is running.
  for (const option of [
    { refresh: true },
    { "reopen-ui": "slice-a" },
    { "rework-slice": "S1", "confirm-rework": true },
    { "reopen-complete": "S1", "reopen-reason": "a".repeat(20), "reopen-evidence": "e.md", "confirm-reopen": true },
    { "adopt-visual-contract": true, "confirm-adopt-visual-contract": true },
    { "amend-slice": "S1", "add-file": ["a.tsx"] },
  ]) {
    const auto = refusal("discover", { ...option, mode: "auto" });
    const step = refusal("discover", { ...option, mode: "step" });
    assert.equal(auto, step, JSON.stringify(option));
    if (auto !== null) assert.doesNotMatch(auto, /--mode auto/, JSON.stringify(option));
  }
});

test("--adopt-visual-contract is operator-only, typed, exclusive, and never run or self-confirmed", () => {
  const adopt = { "adopt-visual-contract": true, "confirm-adopt-visual-contract": true };
  assert.equal(refusal("discover", adopt), null);
  assert.match(
    refusal("discover", { "adopt-visual-contract": true }),
    /must be given together/,
  );
  assert.match(
    refusal("discover", { "confirm-adopt-visual-contract": true }),
    /must be given together/,
  );
  // No longer mode-refused; see the posture note above.
  assert.equal(refusal("discover", { ...adopt, mode: "auto" }), null);
  assert.match(refusal("discover", { ...adopt, refresh: true }), /different transitions/);
  assert.match(refusal("discover", { ...adopt, status: true }), /--status is read-only/);
  assert.match(refusal("discover", { ...adopt, scan: true }), /--scan is read-only/);
  assert.match(
    refusal("run", { "adopt-visual-contract": true }),
    /--adopt-visual-contract is not accepted by run-migration\.mjs/,
  );
  // Self-confirmation follows the one policy and nothing else: `auto` confirms
  // its own preview here as everywhere, `step` does not.
  for (const [mode, expected] of [
    [undefined, true],
    ["auto", true],
    ["step", false],
  ]) {
    assert.equal(maySelfConfirm({ command: "discover", mode }), expected, String(mode));
  }
});

test("advance and validate refuse an unknown step name identically", () => {
  for (const command of ["advance", "validate"]) {
    assert.equal(
      refusal(command, { step: "NOT_A_STEP" }),
      "Unknown migration step 'NOT_A_STEP'.",
      command,
    );
    for (const step of MIGRATION_STEPS) {
      assert.equal(refusal(command, { step }), null, `${command} ${step}`);
    }
  }
});

// `run` was this test's stand-in for "unknown" until `03` D3-4 made it a real
// command with its own case. The property is unchanged and so is the assertion;
// only the name that stands for a command nobody has defined.
test("an unknown command is refused rather than silently allowed", () => {
  assert.throws(
    () => assertOptionCombination("nonesuch", parsed()),
    /Unknown command 'nonesuch' for option validation\./,
  );
});

// -- §11.2 self-confirmation is one policy, and the policy is the principal.
//
// This used to hold a hand-written oracle reproducing a per-flag denylist --
// `mode !== "step" && !refresh && state !== "NOT_STARTED"` -- which is exactly
// the shape that guaranteed each new transition defaulted to operator-required.
// There is nothing left to reproduce: the answer is `isAutoAuthority(mode)`,
// for every command and every transition, and the test says so.

test("maySelfConfirm is isAutoAuthority, for every command and every input", () => {
  for (const command of ["discover", "advance", "registry"]) {
    for (const mode of [undefined, "auto", "step"]) {
      const expected = isAutoAuthority(mode);
      assert.equal(maySelfConfirm({ command, mode }), expected, `${command} ${mode}`);
      // No transition flag, and no preview state, may move the answer: that
      // sensitivity is what the denylist was, and it is gone.
      for (const extra of [
        { refresh: true },
        { reopenUi: true },
        { reopenComplete: true },
        { reworkSlice: "S1" },
        { adoptVisualContract: true },
        { amendSlice: "S1" },
        { preview: { state: "NOT_STARTED" } },
        { preview: { state: "COMPLETE" } },
      ]) {
        assert.equal(
          maySelfConfirm({ command, mode, ...extra }),
          expected,
          `${command} ${mode} ${JSON.stringify(extra)}`,
        );
      }
    }
  }
});

test("isAutoAuthority defaults on and is false only for step", () => {
  assert.equal(isAutoAuthority(undefined), true);
  assert.equal(isAutoAuthority("auto"), true);
  assert.equal(isAutoAuthority("step"), false);
});

// -- §11.3 registration answers to the same policy as everything else.
//
// It used to be the one hard-coded `false`, which made an unattended bootstrap
// stop at the most mechanical transition the toolkit has.

test("registration self-confirms under auto and stops under step", () => {
  assert.equal(maySelfConfirm({ command: "registry", mode: "auto" }), true);
  assert.equal(maySelfConfirm({ command: "registry" }), true);
  assert.equal(maySelfConfirm({ command: "registry", mode: "step" }), false);
});

test("an unknown command may not self-confirm by default", () => {
  assert.throws(
    () => maySelfConfirm({ command: "run", mode: "auto", preview: {} }),
    /Unknown command 'run' for self-confirmation\./,
  );
});

// -- §11.4 the exit-code mapping is total over the closed set and only it.

test("exitCodeFor is total over the six outcomes", () => {
  assert.deepEqual(MIGRATION_OUTCOMES, [
    "CONTINUE",
    "AWAITING_CONFIRMATION",
    "COMPLETE",
    "OPERATOR_DECISION",
    "BLOCKED",
    "FAILED",
  ]);
  assert.deepEqual(
    MIGRATION_OUTCOMES.map(exitCodeFor),
    [0, 0, 0, 2, 2, 1],
  );
  for (const outcome of MIGRATION_OUTCOMES) {
    assert.equal(typeof exitCodeFor(outcome), "number", outcome);
  }
});

test("an unrecognized outcome throws instead of defaulting", () => {
  for (const outcome of [
    "AUTHORING_REQUIRED",
    "STOP_REFRESH_REQUIRED",
    "STOP_RECOVERY_REQUIRED",
    "constructor",
    "toString",
    undefined,
    null,
    "",
  ]) {
    assert.throws(() => exitCodeFor(outcome), /Unknown migration outcome/, String(outcome));
  }
});

// -- §11.5 authoringRequest is a composition of the readers it names.

const stateAt = (currentStep, extra = {}) => ({
  currentStep,
  activeSlice: null,
  formatVersion: 11,
  pendingSlices: [],
  artifacts: {
    steps: {
      RESOLVE: "steps/01-resolve.md",
      DISCOVER_LEGACY: "steps/02-discover-legacy.md",
      DISCOVERY_COMPLETENESS: "steps/02a-discovery-completeness.md",
      ASSESS_TARGET: "steps/03-assess-target.md",
      BUILD_BASELINE: "steps/04-build-baseline.md",
      PLAN: "steps/05-plan.md",
      IMPLEMENT_SLICES: "steps/06-implement-slices.md",
      VERIFY_SLICES: "steps/07-verify-slices.md",
      FINALIZE: "steps/08-finalize.md",
    },
  },
  ...extra,
});

test("authoringRequest composes the existing readers at every checkpoint", () => {
  const states = [
    ...MIGRATION_STEPS.map((step) => stateAt(step)),
    stateAt("COMPLETE"),
    stateAt("IMPLEMENT_SLICES", { activeSlice: "auth-001", pendingSlices: ["auth-001"] }),
    stateAt("VERIFY_SLICES", { activeSlice: "auth-001", pendingSlices: ["auth-001"] }),
  ];
  for (const state of states) {
    const request = authoringRequest(state);
    assert.deepEqual(request.artifacts, checkpointArtifacts(state), state.currentStep);
    assert.equal(request.primaryArtifact, activeArtifact(state), state.currentStep);
    assert.equal(request.step, state.currentStep);
    assert.equal(request.slice, state.activeSlice ?? null);
    assert.equal(
      request.schemaRef,
      `references/migration-contract.md#${state.currentStep}`,
    );
    assert.equal(typeof request.summary, "string");
    assert.ok(request.summary.length > 0, state.currentStep);
  }
});

test("a pre-10 record is described with its own eight-step lifecycle", () => {
  assert.deepEqual(authoringRequest(stateAt("BUILD_BASELINE", { formatVersion: 9 })).lifecycle, [
    "RESOLVE",
    "DISCOVER_LEGACY",
    "ASSESS_TARGET",
    "BUILD_BASELINE",
    "PLAN",
    "IMPLEMENT_SLICES",
    "VERIFY_SLICES",
    "FINALIZE",
  ]);
  assert.deepEqual(
    authoringRequest(stateAt("BUILD_BASELINE")).lifecycle,
    MIGRATION_STEPS,
  );
  // Composed on read: mutating the returned lifecycle cannot reach the core.
  const request = authoringRequest(stateAt("PLAN"));
  request.lifecycle.push("NOPE");
  assert.deepEqual(authoringRequest(stateAt("PLAN")).lifecycle, MIGRATION_STEPS);
});

// -- §11.6 the typed outcome, and the bytes it renders to.

const directiveBefore = ({ moduleName, mode, stop }) =>
  mode === "step"
    ? ""
    : stop
      ? `loop: STOP reason=${stop}\n`
      : `loop: CONTINUE next=/start-migration ${moduleName}\n`;

test("nextOutcome types the four continuations the wrappers produce", () => {
  const blocked = { requiresConfirmation: false, blockers: ["nope"] };
  assert.equal(nextOutcome({ preview: blocked }).outcome, "BLOCKED");
  assert.equal(nextOutcome({ preview: blocked }).reason, "nope");
  assert.equal(nextOutcome({ preview: blocked }).next, null);

  const awaiting = { requiresConfirmation: true, blockers: [] };
  assert.equal(nextOutcome({ preview: awaiting }).outcome, "AWAITING_CONFIRMATION");
  assert.equal(nextOutcome({ preview: awaiting }).next, null);

  const advanced = nextOutcome({
    preview: awaiting,
    result: { state: { currentStep: "PLAN" } },
  });
  assert.equal(advanced.outcome, "CONTINUE");
  assert.equal(advanced.next, "PLAN");

  const completed = nextOutcome({
    preview: awaiting,
    result: { state: { currentStep: "COMPLETE" } },
  });
  assert.equal(completed.outcome, "COMPLETE");
  assert.equal(completed.next, null);
});

test("renderLoopDirective is byte-identical to the pre-change implementation", () => {
  const cases = [
    { outcome: "CONTINUE", stop: null },
    { outcome: "AWAITING_CONFIRMATION", stop: "AWAITING_CONFIRMATION" },
    { outcome: "COMPLETE", stop: "COMPLETE" },
    { outcome: "BLOCKED", stop: "BLOCKED" },
    { outcome: "OPERATOR_DECISION", stop: "OPERATOR_DECISION" },
    { outcome: "FAILED", stop: "FAILED" },
  ];
  for (const mode of [undefined, "auto", "step"]) {
    for (const { outcome, stop } of cases) {
      assert.equal(
        renderLoopDirective({ moduleName: "auth", mode, outcome }),
        directiveBefore({ moduleName: "auth", mode, stop }),
        `${mode} ${outcome}`,
      );
    }
  }
  // The three strings any code emits today, spelled out.
  assert.equal(
    renderLoopDirective({ moduleName: "auth", mode: "auto", outcome: "CONTINUE" }),
    "loop: CONTINUE next=/start-migration auth\n",
  );
  assert.equal(
    renderLoopDirective({ moduleName: "auth", outcome: "AWAITING_CONFIRMATION" }),
    "loop: STOP reason=AWAITING_CONFIRMATION\n",
  );
  assert.equal(
    renderLoopDirective({ moduleName: "auth", outcome: "BLOCKED" }),
    "loop: STOP reason=BLOCKED\n",
  );
  assert.equal(
    renderLoopDirective({ moduleName: "auth", mode: "step", outcome: "BLOCKED" }),
    "",
  );
});

// -- design source gating: the CLI-shape rules for --design-source/--figma -----

test("--design-source rejects an unknown value on discover and run", () => {
  assert.equal(
    refusal("discover", { "design-source": "sketch" }),
    "--design-source accepts target-system or figma-mcp.",
  );
  assert.equal(
    refusal("run", { "design-source": "sketch" }),
    "--design-source accepts target-system or figma-mcp.",
  );
});

test("--status refuses --design-source and --figma", () => {
  assert.match(
    refusal("discover", { status: true, "design-source": "figma-mcp" }),
    /--status is read-only/,
  );
  assert.match(
    refusal("discover", { status: true, figma: ["https://figma.com/design/K/F"] }),
    /--status is read-only/,
  );
});

test("--scan refuses --design-source and --figma", () => {
  assert.match(
    refusal("discover", { scan: true, "design-source": "figma-mcp" }),
    /--scan is read-only/,
  );
  assert.match(
    refusal("discover", { scan: true, figma: ["https://figma.com/design/K/F"] }),
    /--scan is read-only/,
  );
});

test("run and discover accept a valid design source as a bootstrap input", () => {
  assert.doesNotThrow(() =>
    assertOptionCombination("run", parsed({ "design-source": "figma-mcp" })),
  );
  assert.doesNotThrow(() =>
    assertOptionCombination(
      "discover",
      parsed({ "design-source": "figma-mcp", figma: ["https://figma.com/design/K/F"] }),
    ),
  );
});
