/**
 * Plan 03 §11. `run` is a sequencer, so every test here asks one of two
 * questions: did it perform the sequence, and did it add a rule it was not
 * allowed to add. Nothing asserts a byte the existing wrappers own -- that is
 * `migration-contract.test.mjs`'s job, and it must keep passing unedited.
 *
 * Every fixture is an isolated `mkdtemp` Git repository. Nothing here touches
 * the real repository or any real migration.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertExecutionConfirmation,
  bootstrapMigration,
  checkpointArtifacts,
  decisionLineDigest,
  pendingDecisionCandidates,
  previewAdvance,
  advanceMigration,
  previewMigrationExecution,
  resolveLegacySources,
  resolveRegistryPath,
  stepsFor,
} from "../../src/core.mjs";
import { challengeFor, runRecordDecisionCli } from "../../src/record-decision.mjs";
import { runAdvanceCli } from "../../src/cli/advance-migration.mjs";
import {
  parseDiscoverArguments,
  runDiscoverCli,
} from "../../src/cli/discover-module.mjs";
import {
  decisionCandidates,
  parseRunArguments,
  runMigration,
} from "../../src/cli/run-migration.mjs";

const execFileAsync = promisify(execFile);
const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);

const SPEC = `# Auth

### Requirement: AUTH-REQ-001 Sign in
The target MUST authenticate users.

#### Scenario: AUTH-SCN-001 Success
A valid user signs in.

### Requirement: AUTH-REQ-002 Sign out
The target MUST end a session.

#### Scenario: AUTH-SCN-002 Logout
A signed-in user signs out.
`;

const writeJson = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

/** `relative path -> byte length`, enough to prove "nothing was written". */
const snapshot = async (root, prefix = "") => {
  const out = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(full, key));
    else out[key] = (await readFile(full)).length;
  }
  return out;
};

const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-run-"));
  const legacyRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  const registryPath = path.join(
    targetRoot,
    ".agents/knowledge/migrations/registry.json",
  );
  await mkdir(path.join(legacyRoot, "auth"), { recursive: true });
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"sm-run-fixture","private":true}\n',
  );
  await writeFile(path.join(legacyRoot, "marker.txt"), "legacy\n");
  await writeFile(path.join(legacyRoot, "auth/marker.txt"), "auth\n");
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await writeFile(path.join(targetRoot, "src/placeholder.ts"), "export {};\n");
  await writeJson(registryPath, {
    version: 1,
    projects: {
      legacy: { root: path.relative(path.dirname(registryPath), legacyRoot) },
      target: { root: path.relative(path.dirname(registryPath), targetRoot) },
    },
    modules: { auth: { target: "auth" } },
  });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Run Test",
      "-c",
      "user.email=run@example.test",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return {
    root,
    legacyRoot,
    targetRoot,
    registryPath,
    packagePath: path.join(root, "package.json"),
    migrationRoot: path.join(
      targetRoot,
      ".agents/knowledge/migrations/modules/auth",
    ),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

/** `--registry` is first-setup-only, so it is dropped once a binding exists. */
const resolutionFor = async (fixture) => {
  const project = JSON.parse(await readFile(fixture.packagePath, "utf8"));
  return resolveRegistryPath({
    cliPath: project.config?.startMigration?.registry
      ? undefined
      : fixture.registryPath,
    moduleName: "auth",
    cwd: fixture.root,
    projectRoot: fixture.root,
    environmentPath: undefined,
  });
};

/**
 * `run` never bootstraps (`05` §1.3): a fresh migration is an operator's
 * two-phase `discover-module.mjs` invocation. Fixtures therefore reach their
 * first checkpoint through the core API, and `run` drives it from there.
 */
const initialize = async (fixture) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: SPEC,
  });
  assertExecutionConfirmation(preview, preview.confirmationId);
  return bootstrapMigration({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: preview.openSpecProposal,
    registryBinding: preview.registryBinding,
    boundInputs: preview.boundInputs,
  });
};

const advanceDirect = async (fixture, options = {}) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewAdvance({
    ...resolution,
    moduleName: "auth",
    ...options,
  });
  return advanceMigration({
    ...resolution,
    moduleName: "auth",
    ...options,
    confirmAdvance: preview.confirmationId,
  });
};

const evidenceChecklist = (location, requirementIds = [], scenarioIds = []) => [
  {
    category: "SOURCE",
    kind: "CODE",
    status: "PRESENT",
    location,
    requirementIds,
    scenarioIds,
  },
  {
    category: "RUNTIME_OBSERVATION",
    kind: "OBSERVATION",
    status: "NOT_APPLICABLE",
    reason: "No runtime capture was taken for this fixture.",
    requirementIds: [],
    scenarioIds: [],
  },
  {
    category: "REQUIREMENT_TRACE",
    kind: "DOCS",
    status: "PRESENT",
    location,
    requirementIds,
    scenarioIds,
  },
];

const LEGACY_INVENTORY = {
  version: 1,
  hasVisibleUi: true,
  behaviors: [
    {
      id: "LB-1",
      description: "Sign in",
      evidence: evidenceChecklist(
        "legacy/auth/marker.txt",
        ["AUTH-REQ-001"],
        ["AUTH-SCN-001"],
      ),
    },
  ],
  uiBehaviors: [
    {
      id: "UIB-1",
      behaviorId: "LB-1",
      kind: "CREATE_EDIT_ACTION",
      description: "The sign-in form exposes its primary action.",
      configuration: { showToolbar: false },
      conditional: false,
      interactions: [
        {
          id: "UIX-1",
          action: "Submit the sign-in form.",
          expected: "The primary action submits and the form reports success.",
        },
      ],
      runtimeStates: ["DEFAULT"],
      evidence: evidenceChecklist(
        "legacy/auth/marker.txt",
        ["AUTH-REQ-001"],
        ["AUTH-SCN-001"],
      ),
      requirementIds: ["AUTH-REQ-001"],
      scenarioIds: ["AUTH-SCN-001"],
    },
  ],
  routeFlows: [
    {
      id: "RF-1",
      description: "Login route",
      evidence: evidenceChecklist(
        "legacy/auth/marker.txt",
        ["AUTH-REQ-002"],
        ["AUTH-SCN-002"],
      ),
    },
  ],
  explicitNoRouteFlows: false,
};

const MODULE_CLASSIFICATION = {
  version: 1,
  algorithmVersion: 2,
  moduleRoots: [
    { path: "auth", reason: "The module's own slice.", decisionId: null },
  ],
  declaredEntryPoints: [],
  files: [
    {
      path: "auth/marker.txt",
      scope: "OWNED",
      reachability: "UNREACHABLE",
      reachedFrom: [],
      kind: "OTHER",
      disposition: "BEHAVIOR_BACKED",
      behaviorIds: ["LB-1"],
      routeFlowIds: [],
      rationale: "The fixture's only owned file; LB-1 describes it.",
      evidence: [],
    },
  ],
  supporting: [],
  unresolvedReferences: [],
  findings: [],
};

/** An approval-requiring exclusion, which is what makes a candidate pend. */
const excludedRow = (file, rationale) => ({
  ...MODULE_CLASSIFICATION.files[0],
  path: `auth/${file}`,
  disposition: "EXCLUDED_APPROVED",
  behaviorIds: [],
  rationale,
  evidence: evidenceChecklist(`legacy/auth/${file}`),
});

const EXCLUDED_CLASSIFICATION = {
  ...MODULE_CLASSIFICATION,
  files: [
    excludedRow(
      "marker.txt",
      "Decorative only; the fixture operator must approve exclusion.",
    ),
  ],
};

/** Two approvable candidates, so the pause has a second one to reach. */
const TWO_EXCLUSIONS_CLASSIFICATION = {
  ...MODULE_CLASSIFICATION,
  files: [
    excludedRow(
      "marker.txt",
      "Decorative only; the fixture operator must approve exclusion.",
    ),
    excludedRow("second.txt", "Also decorative; also needs an approval."),
  ],
};

/**
 * An empty rationale is a blocker, and a blocker means agent work: the
 * candidate is derived but is never offered at a challenge prompt.
 */
const NON_APPROVABLE_CLASSIFICATION = {
  ...MODULE_CLASSIFICATION,
  files: [excludedRow("marker.txt", "")],
};

const STEP_DOC = (number, name) => `# ${number}. ${name}

- Status: \`COMPLETE\`

## Result

Authored by the run suite.
`;

const STEP_FILES = {
  DISCOVER_LEGACY: ["02", "discover-legacy", "Discover legacy"],
  DISCOVERY_COMPLETENESS: [
    "02a",
    "discovery-completeness",
    "Discovery completeness",
  ],
};

const completeStepDoc = async (fixture, step) => {
  const [number, file, name] = STEP_FILES[step];
  await writeFile(
    path.join(fixture.migrationRoot, `steps/${number}-${file}.md`),
    STEP_DOC(number, name),
  );
};

const authorDiscoverLegacy = async (fixture) => {
  await completeStepDoc(fixture, "DISCOVER_LEGACY");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/legacy.json"),
    LEGACY_INVENTORY,
  );
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    MODULE_CLASSIFICATION,
  );
};

/** Positions a fixture at DISCOVERY_COMPLETENESS with the checkpoint authored. */
const atDiscoveryCompleteness = async (fixture, classification) => {
  await initialize(fixture);
  await authorDiscoverLegacy(fixture);
  await advanceDirect(fixture);
  await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    classification,
  );
};

const state = (fixture) =>
  readJson(path.join(fixture.migrationRoot, "state.json"));

const historyEvents = async (fixture) =>
  (
    await readFile(
      path.join(fixture.migrationRoot, "history/history.ndjson"),
      "utf8",
    )
  )
    .split("\n")
    .filter((line) => line.trim()).length;

/**
 * Runs an entry point the way an operator's shell would: from the fixture root,
 * with stdout captured. `process.exitCode` is read into the result and then
 * restored, because a blocked run sets it process-wide.
 *
 * `answers` is what `04` §11 calls injecting a TTY flag on the real
 * `process.stdin`/`process.stdout`: with it, both report `isTTY` and each
 * challenge is answered from the queue at the moment it is actually printed.
 * Without it both report no TTY, which is what an agent harness looks like --
 * and is why no test can ever hang at a prompt.
 */
const capture = async (fixture, run, { answers = null } = {}) => {
  const chunks = [];
  const errors = [];
  const pending = answers ? [...answers] : [];
  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  const error = process.stderr.write.bind(process.stderr);
  const previousExitCode = process.exitCode;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const previousStdoutTty = process.stdout.isTTY;
  const input = new PassThrough();
  input.isTTY = Boolean(answers);
  input.setRawMode = () => input;
  Object.defineProperty(process, "stdin", {
    configurable: true,
    get: () => input,
  });
  process.stdout.isTTY = Boolean(answers);
  process.chdir(fixture.root);
  process.stdout.write = (chunk) => {
    const text = String(chunk);
    chunks.push(text);
    if (text.startsWith("Challenge: "))
      input.write(`${pending.shift() ?? ""}\n`);
    return true;
  };
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    const result = await run();
    return {
      result,
      stdout: chunks.join(""),
      stderr: errors.join(""),
      exitCode: process.exitCode,
    };
  } finally {
    process.stdout.write = write;
    process.stderr.write = error;
    Object.defineProperty(process, "stdin", stdinDescriptor);
    if (previousStdoutTty === undefined) delete process.stdout.isTTY;
    else process.stdout.isTTY = previousStdoutTty;
    process.chdir(cwd);
    process.exitCode = previousExitCode;
    input.end();
  }
};

const registryArguments = async (fixture) => {
  const project = JSON.parse(await readFile(fixture.packagePath, "utf8"));
  return project.config?.startMigration?.registry
    ? []
    : ["--registry", fixture.registryPath];
};

const directiveOf = (stdout) => {
  const lines = stdout.split("\n").filter((line) => line.startsWith("loop: "));
  assert.ok(lines.length <= 1, `one directive at most:\n${stdout}`);
  return lines[0] ?? null;
};

const DECISIONS = "decisions/operator-decisions.ndjson";
const AUTO_DECISIONS = "decisions/auto-decisions.ndjson";

/**
 * The human channel, handed to `runMigration` explicitly.
 *
 * `--mode auto` is now a principal in its own right, so the default no longer
 * probes for a terminal -- that is the whole point of the change. A test whose
 * subject *is* the terminal therefore has to say so, and this is exactly the
 * recorder `operator-approval.mjs` builds for `step`: argv only, no `ask`, so
 * `record-decision.mjs` reads the TTY and records `TERMINAL`. Nothing here
 * short-circuits the challenge; `capture` answers the real prompt.
 */
const terminalRecorder = (arguments_) => runRecordDecisionCli(arguments_);

// --- §11.3 one advance per invocation ---------------------------------------

test("one run invocation performs exactly one advance and exits", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await authorDiscoverLegacy(fixture);
    const before = await state(fixture);
    const events = await historyEvents(fixture);

    const run = await capture(fixture, () => runMigration(["auth"]));

    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.exitCode, 0);
    assert.equal(
      directiveOf(run.stdout),
      "loop: CONTINUE next=/start-migration auth",
    );
    const after = await state(fixture);
    assert.equal(after.currentStep, "DISCOVERY_COMPLETENESS");
    assert.equal(after.revision, before.revision + 1);
    assert.equal(await historyEvents(fixture), events + 1);
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.4 authoring request on an unauthored checkpoint ---------------------

test("an unauthored checkpoint yields CONTINUE with an authoring request and no advance", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await state(fixture);
    const events = await historyEvents(fixture);

    const run = await capture(fixture, () => runMigration(["auth"]));

    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.exitCode, 0);
    const after = await state(fixture);
    // The advance never ran: nothing closed a checkpoint and nothing appended.
    assert.equal(after.revision, before.revision);
    assert.equal(after.currentStep, before.currentStep);
    assert.equal(await historyEvents(fixture), events);

    assert.deepEqual(
      run.result.request.artifacts,
      checkpointArtifacts(after),
      run.stdout,
    );
    assert.equal(run.result.request.step, after.currentStep);
    assert.match(run.stdout, /^Author next: /m);
    assert.match(run.stdout, /^Checkpoint: DISCOVER_LEGACY$/m);
    assert.match(run.stdout, /^Schema: references\/migration-contract\.md#/m);
    for (const artifact of run.result.request.artifacts) {
      assert.ok(run.stdout.includes(artifact), artifact);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("--json prints the outcome object instead of the authoring block", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const run = await capture(fixture, () => runMigration(["auth", "--json"]));

    assert.doesNotMatch(run.stdout, /^Author next: /m);
    const printed = run.stdout
      .split("\n")
      .findIndex((line) => line === "{" || line.startsWith("{"));
    assert.ok(printed >= 0, run.stdout);
    assert.equal(
      directiveOf(run.stdout),
      "loop: CONTINUE next=/start-migration auth",
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.5 the emitDirective seam -------------------------------------------

test("emitDirective defaults to today's bytes and subtracts only the loop line", async () => {
  const fixture = await createFixture();
  try {
    // A NOT_STARTED module with no OpenSpec proposal is the discover CLI's
    // blocked path, which is one of the two paths that emit a directive.
    const argv = ["auth", ...(await registryArguments(fixture))];
    const withDirective = await capture(fixture, () => runDiscoverCli(argv));
    const without = await capture(fixture, () =>
      runDiscoverCli(argv, { emitDirective: false }),
    );
    assert.equal(
      directiveOf(withDirective.stdout),
      "loop: STOP reason=BLOCKED",
    );
    assert.equal(directiveOf(without.stdout), null);
    assert.equal(
      withDirective.stdout.replace("loop: STOP reason=BLOCKED\n", ""),
      without.stdout,
    );

    await initialize(fixture);
    // A `--step` that disagrees with `state.currentStep` is the advance CLI's
    // blocked path. `run` never supplies one; this test does, deliberately.
    const advanceArgv = ["auth", "--step", "PLAN"];
    const advanceWith = await capture(fixture, () =>
      runAdvanceCli(advanceArgv),
    );
    const advanceWithout = await capture(fixture, () =>
      runAdvanceCli(advanceArgv, { emitDirective: false }),
    );
    assert.equal(directiveOf(advanceWith.stdout), "loop: STOP reason=BLOCKED");
    assert.equal(directiveOf(advanceWithout.stdout), null);
    assert.equal(
      advanceWith.stdout.replace("loop: STOP reason=BLOCKED\n", ""),
      advanceWithout.stdout,
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.6 step mode through run --------------------------------------------

test("--mode step stops at the confirmation prompt, writes no directive, executes nothing", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await authorDiscoverLegacy(fixture);
    const before = await state(fixture);
    const events = await historyEvents(fixture);

    const run = await capture(fixture, () =>
      runMigration(["auth", "--mode", "step"]),
    );

    assert.equal(run.result.outcome, "AWAITING_CONFIRMATION");
    assert.equal(run.exitCode, 0);
    assert.equal(directiveOf(run.stdout), null);
    assert.match(run.stdout, /Mode: step — awaiting explicit confirmation\. No execution has started\./);
    // The pseudo-interactive question is gone: the process has already exited
    // by the time anyone could answer it.
    assert.doesNotMatch(run.stdout, /Reply Yes or No/);
    const after = await state(fixture);
    assert.equal(after.revision, before.revision);
    assert.equal(after.currentStep, before.currentStep);
    assert.equal(await historyEvents(fixture), events);
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.7 refused flags ----------------------------------------------------

test("run refuses every operator transition by name and touches nothing", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);
    for (const argument of [
      "--refresh",
      "--reopen-discovery",
      "--scan",
      "--status",
      "--confirm-execution=deadbeefdeadbeef",
    ]) {
      const flag = argument.split("=")[0];
      await assert.rejects(
        runMigration(["auth", argument]),
        (error) => {
          assert.equal(
            error.message,
            `${flag} is not accepted by run-migration.mjs; invoke it by name with discover-module.mjs.`,
          );
          return true;
        },
        argument,
      );
    }
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("run still rejects an unknown mode and a missing module", () => {
  assert.throws(
    () => parseRunArguments(["auth", "--mode", "turbo"]),
    /--mode accepts 'auto' or 'step'\./,
  );
  assert.throws(() => parseRunArguments([]), /Usage: run-migration\.mjs /);
  assert.deepEqual(parseRunArguments(["auth", "--ponytail"]), {
    moduleName: "auth",
    mode: undefined,
    slice: undefined,
    json: false,
  });
});

test("run accepts --design-source and repeatable --figma without consuming them", () => {
  // They are bootstrap inputs forwarded verbatim to discover, so parse must
  // accept them (strict parseArgs) while the returned run options are unchanged.
  assert.deepEqual(
    parseRunArguments([
      "auth",
      "--design-source",
      "figma-mcp",
      "--figma",
      "https://www.figma.com/design/K/F?node-id=1-2",
      "--figma",
      "https://www.figma.com/make/M/P",
    ]),
    { moduleName: "auth", mode: undefined, slice: undefined, json: false },
  );
  assert.throws(
    () => parseRunArguments(["auth", "--design-source", "sketch"]),
    /--design-source accepts target-system or figma-mcp\./,
  );
});

// --- §11.8 the candidate narrowing (04 D4-7) --------------------------------

test("the narrowing reads candidates at DISCOVERY_COMPLETENESS and nowhere else", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const { registryPath } = await resolutionFor(fixture);

    const candidates = await decisionCandidates({
      step: "DISCOVERY_COMPLETENESS",
      registryPath,
      moduleName: "auth",
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].approvable, true);
    // Same record, any other checkpoint: the guard short-circuits before the
    // candidate reader, which is what keeps the narrowing at one checkpoint.
    assert.deepEqual(
      await decisionCandidates({
        step: "PLAN",
        registryPath,
        moduleName: "auth",
      }),
      [],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a record with nothing pending derives no candidate", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, MODULE_CLASSIFICATION);
    const { registryPath } = await resolutionFor(fixture);

    assert.deepEqual(
      await decisionCandidates({
        step: "DISCOVERY_COMPLETENESS",
        registryPath,
        moduleName: "auth",
      }),
      [],
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.9 run never approves without a TTY and an exact challenge ----------
//
// `04` §14 replaces `03` §11.9's "run never approves, under any flag
// combination" with this: run never approves without a TTY and an exact
// challenge match. The delegated call is the only writer either way.

test("no run invocation without a TTY ever writes the operator decision ledger", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const ledger = path.join(fixture.migrationRoot, DECISIONS);

    for (const argv of [
      ["auth"],
      ["auth", "--mode", "auto"],
      ["auth", "--mode", "step"],
      ["auth", "--json"],
      ["auth", "--slice", "slice-a"],
    ]) {
      await capture(fixture, () => runMigration(argv));
      assert.equal(await exists(ledger), false, argv.join(" "));
    }
  } finally {
    await fixture.cleanup();
  }
});

// --- 04 §11.3 run forges no TTY ---------------------------------------------

test("run-migration.mjs cannot forge a TTY or hardcode a verdict", async () => {
  const source = await readFile(
    path.join(scriptsRoot, "cli/run-migration.mjs"),
    "utf8",
  );
  // §14: no refusal, no self-confirm expression, and no exit-code literal live
  // here -- each has exactly one definition site in `migration-policy.mjs`.
  assert.doesNotMatch(source, /maySelfConfirm|confirmationId/);
  assert.doesNotMatch(source, /process\.exitCode\s*=\s*\d/);
  // `--step` is never forwarded: the core defaults it from `state.currentStep`.
  assert.doesNotMatch(source, /"--step"/);
  assert.match(source, /exitCodeFor\(/);
  const boundary = await readFile(
    path.join(scriptsRoot, "operator-approval.mjs"),
    "utf8",
  );
  // D4-1: the shared module/artifact boundary is the only place that reaches
  // the recorder, and `run` itself never does.
  assert.equal((source.match(/runRecordDecisionCli\(/g) ?? []).length, 0);
  // Two call sites now, one per principal the boundary can be: the terminal
  // recorder, which passes argv and nothing else, and the AUTO recorder, which
  // passes argv plus a *declared* channel. Neither composes a verdict, and
  // neither is reachable from argv -- `autoApprovalChannel` is an in-process
  // function reference, exactly as `ask` has always been.
  assert.equal((boundary.match(/runRecordDecisionCli\(/g) ?? []).length, 2);
  assert.match(boundary, /runRecordDecisionCli\(arguments_\);/);
  assert.match(boundary, /ask: autoApprovalChannel\(/);
  // The forgery this file must never contain: a fabricated human. No stream
  // override, no injected TTY, and no channel claimed that is not AUTO's own.
  assert.doesNotMatch(source, /\{\s*stdin/);
  assert.doesNotMatch(source, /isTTY:\s*true/);
  assert.doesNotMatch(boundary, /isTTY:\s*true/);
  assert.doesNotMatch(boundary, /"(TERMINAL|ELICITATION)"/);
  // And the AUTO recorder must be unable to reach the human ledger: the only
  // path to a file here is `ledgerFileForChannel`, in record-decision.mjs.
  assert.doesNotMatch(boundary, /operator-decisions\.ndjson/);
});

// --- 04 §11.1, §11.2, §11.5 the pause ---------------------------------------

/** The exact phrases the recorder will challenge with, in the offered order. */
const challengesFor = async (fixture) => {
  const { registryPath } = await resolutionFor(fixture);
  const pending = await pendingDecisionCandidates({
    registryPath,
    moduleName: "auth",
  });
  return [challengeFor(pending.group ?? pending.candidates[0])];
};

const ledgerLines = async (fixture, ledger = DECISIONS) => {
  const file = path.join(fixture.migrationRoot, ledger);
  if (!(await exists(file))) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim());
};

test("an approval records exactly one line and never advances the record", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const before = await state(fixture);
    const events = await historyEvents(fixture);
    const answers = await challengesFor(fixture);
    assert.equal(answers.length, 1);

    const run = await capture(
      fixture,
      () => runMigration(["auth"], { recordTrustedDecision: terminalRecorder }),
      { answers },
    );

    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.exitCode, 0);
    assert.equal(
      directiveOf(run.stdout),
      "loop: CONTINUE next=/start-migration auth",
    );
    assert.equal((await ledgerLines(fixture)).length, 1);
    // A human answered, so the line is in the human record and the AUTO ledger
    // was never created. The two never mix, in either direction.
    assert.deepEqual(await ledgerLines(fixture, AUTO_DECISIONS), []);
    // An approval is half an act: the checkpoint is not closed by it.
    const after = await state(fixture);
    assert.equal(after.revision, before.revision);
    assert.equal(after.currentStep, before.currentStep);
    assert.equal(await historyEvents(fixture), events);
    assert.match(run.stdout, /Recorded DEC-001;/);
    assert.match(run.stdout, /decisionDigest/);
    assert.ok(run.result.request, run.stdout);
  } finally {
    await fixture.cleanup();
  }
});

test("a challenge mismatch writes nothing and stops the loop", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, TWO_EXCLUSIONS_CLASSIFICATION);
    const answers = await challengesFor(fixture);
    assert.equal(answers.length, 1);

    const run = await capture(
      fixture,
      () => runMigration(["auth"], { recordTrustedDecision: terminalRecorder }),
      { answers: ["not the phrase"] },
    );

    assert.equal(run.result.outcome, "OPERATOR_DECISION");
    assert.equal(run.exitCode, 2);
    assert.equal(
      directiveOf(run.stdout),
      "loop: STOP reason=OPERATOR_DECISION",
    );
    assert.deepEqual(await ledgerLines(fixture), []);
    assert.deepEqual(await ledgerLines(fixture, AUTO_DECISIONS), []);
    // The second candidate was never reached: one challenge, the first one.
    // Matched as a substring because a terminal-mode prompt is preceded by
    // cursor escapes on the same line.
    const prompts = run.stdout.match(/Challenge: APPROVE [^\n]*/g) ?? [];
    assert.deepEqual(prompts, [`Challenge: ${answers[0]}`]);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * One iteration takes one approval, whichever channel the human is on.
 *
 * The batch this used to prove is gone: an iteration that approved and kept
 * walking is what turned one auto-answering host into multiple synthetic
 * ledger lines, and the cap is uniform rather than per-channel because a
 * trust rule with a per-channel exemption is the shape of the original bug.
 * So two candidates cost two iterations, and only the one that empties the
 * pending set ends CONTINUE.
 */
test("one group candidate per iteration records both members atomically", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, TWO_EXCLUSIONS_CLASSIFICATION);
    const answers = await challengesFor(fixture);
    assert.equal(answers.length, 1);

    // A correct phrase and a second answer that is never consumed, because the
    // second candidate is never offered inside this iteration.
    const first = await capture(
      fixture,
      () => runMigration(["auth"], { recordTrustedDecision: terminalRecorder }),
      { answers },
    );
    assert.equal(first.result.outcome, "CONTINUE");
    assert.equal(first.exitCode, 0);
    assert.equal(
      directiveOf(first.stdout),
      "loop: CONTINUE next=/start-migration auth",
    );
    assert.equal((await ledgerLines(fixture)).length, 2);
    const prompts = first.stdout.match(/Challenge: APPROVE [^\n]*/g) ?? [];
    assert.deepEqual(prompts, [`Challenge: ${answers[0]}`]);
  } finally {
    await fixture.cleanup();
  }
});

// --- 04 §11.4 the non-interactive path, and who owns it ---------------------
//
// Posture change, recorded deliberately. This used to prove "with no TTY, run
// writes nothing" -- an invariant whose only content was *automation may never
// approve*. It is replaced by the invariant the toolkit now holds, which is
// strictly more specific and strictly more testable:
//
//   - `--mode auto` resolves what it can derive, as itself;
//   - every line it writes says `AUTO`, and lands in the AUTO ledger;
//   - the human operator ledger is untouched -- there is no configuration in
//     which automation appends to it;
//   - no terminal is read, and no second command is handed to anyone.
//
// The "nothing is written" half survives, under the principal that actually
// means it: `--mode step`, below.

test("with no TTY --mode auto resolves every candidate as AUTO and never touches the human ledger", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, TWO_EXCLUSIONS_CLASSIFICATION);

    const run = await capture(fixture, () => runMigration(["auth"]));

    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.exitCode, 0);
    assert.equal(
      directiveOf(run.stdout),
      "loop: CONTINUE next=/start-migration auth",
    );
    // No human was asked, anywhere: no terminal prompt, and no fallback command
    // handed to an operator who is not there.
    assert.doesNotMatch(run.stdout, /Challenge: APPROVE/);
    assert.doesNotMatch(run.stdout, /^Operator approval required/m);

    // The human record does not exist. Not empty -- absent.
    assert.deepEqual(await ledgerLines(fixture), []);

    // Every line is AUTO's, and carries the five things an AUTO decision must
    // record: principal, decision type, evidence, scope, result.
    const auto = (await ledgerLines(fixture, AUTO_DECISIONS)).map((line) =>
      JSON.parse(line),
    );
    assert.equal(auto.length, 2, JSON.stringify(auto, null, 2));
    for (const [index, decision] of auto.entries()) {
      assert.match(decision.id, /^AUTO-\d{3}$/);
      assert.equal(decision.seq, index + 1);
      assert.equal(decision.authorizedBy.principal, "AUTO");
      assert.equal(decision.authorizedBy.channel, "AUTO");
      assert.equal(decision.authorizedBy.decisionType, decision.kind);
      assert.ok(decision.authorizedBy.evidence, "an AUTO line names its evidence");
      assert.ok(decision.authorizedBy.scope.subject.path);
      assert.equal(decision.authorizedBy.result, "APPROVED");
      // Never dressed as a person.
      assert.doesNotMatch(decision.statement, /by operator/);
      assert.match(decision.statement, /by the AUTO principal/);
      // The binding digests are the same ones a human line carries: authority
      // moved, integrity did not.
      assert.ok(decision.boundTo.discoveryDigest);
      assert.ok(decision.candidateId);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("with no TTY --mode step writes nothing and names each candidate's own command", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, TWO_EXCLUSIONS_CLASSIFICATION);
    const { registryPath } = await resolutionFor(fixture);
    const candidates = await decisionCandidates({
      step: "DISCOVERY_COMPLETENESS",
      registryPath,
      moduleName: "auth",
    });
    const before = await snapshot(fixture.root);

    // `step` stops at its own confirmation before the approval path, so the
    // proof that nothing was written is the whole file tree, unchanged.
    const stopped = await capture(fixture, () =>
      runMigration(["auth", "--mode", "step"]),
    );
    assert.equal(stopped.result.outcome, "AWAITING_CONFIRMATION");
    assert.deepEqual(await snapshot(fixture.root), before);
    assert.doesNotMatch(stopped.stdout, /Challenge: APPROVE/);

    // And with a declared no-human channel, the approval path itself refuses:
    // `null` is a positive statement that this process cannot reach a person,
    // and under `step` nothing stands in for one.
    const run = await capture(fixture, () =>
      runMigration(["auth"], { recordTrustedDecision: null, stdout: process.stdout }),
    );
    assert.equal(run.result.outcome, "CONTINUE");
    // Sanity: the candidate commands are real and runnable by a human.
    for (const candidate of candidates) {
      assert.ok(candidate.command.includes("record-decision.mjs"), candidate.command);
    }
  } finally {
    await fixture.cleanup();
  }
});

// --- 04 §11.6 non-approvable candidates are agent work ----------------------

test("a candidate set with blockers takes 4d and prompts for nothing", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, NON_APPROVABLE_CLASSIFICATION);
    const before = await snapshot(fixture.root);

    const run = await capture(fixture, () => runMigration(["auth"]), {
      answers: [],
    });

    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.exitCode, 0);
    assert.ok(run.result.request, run.stdout);
    assert.match(run.result.reason, /no operator-reviewable rationale/);
    assert.doesNotMatch(run.stdout, /Challenge: APPROVE/);
    assert.doesNotMatch(run.stdout, /^Operator approval required/m);
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

// --- 04 §11.7 a failing narrowing degrades, loudly --------------------------

const corruptLedger = async (fixture) => {
  const file = path.join(fixture.migrationRoot, DECISIONS);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ id: "DEC-001", seq: 1, prevDigest: "tampered" })}\n`,
  );
};

test("a broken decision chain degrades to the authoring request, on stderr", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    await corruptLedger(fixture);

    const run = await capture(fixture, () => runMigration(["auth"]), {
      answers: [],
    });

    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.exitCode, 0);
    // The narrowing may add information; it may never be silent.
    assert.ok(run.stderr.trim().length > 0, "the chain error reaches stderr");
    assert.doesNotMatch(run.stdout, /Challenge: APPROVE/);
    assert.doesNotMatch(run.stdout, /^Operator approval required/m);
  } finally {
    await fixture.cleanup();
  }
});

test("a failure at any other checkpoint never reaches the candidate reader", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await corruptLedger(fixture);

    const run = await capture(fixture, () => runMigration(["auth"]), {
      answers: [],
    });

    // DISCOVER_LEGACY is unauthored, so validation fails -- but the guard is on
    // `state.currentStep`, so the corrupted ledger is never read and nothing
    // lands on stderr.
    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.result.request.step, "DISCOVER_LEGACY");
    assert.equal(run.stderr, "");
  } finally {
    await fixture.cleanup();
  }
});

// --- 04 §11.9 a pre-10 record cannot reach the narrowing --------------------

test("a formatVersion 9 record has no DISCOVERY_COMPLETENESS checkpoint to narrow at", () => {
  assert.equal(
    stepsFor({ formatVersion: 9 }).includes("DISCOVERY_COMPLETENESS"),
    false,
  );
  assert.equal(
    stepsFor({ formatVersion: 10 }).includes("DISCOVERY_COMPLETENESS"),
    true,
  );
});

// --- 08 §11 the CLI owns its own human interaction loop ----------------------

/**
 * `08` proof 1 and 2. The whole approval happens inside the one `runMigration`
 * call: the challenge is printed by this process, answered into this process,
 * and the ledger line lands before the same call returns its directive. No
 * second command is named anywhere on stdout, and no child process is spawned
 * -- `capture` replaces `process.stdout.write` in *this* process, so a prompt
 * written by a subprocess could not appear in `run.stdout` at all.
 */
test("a terminal decision is raised, answered, and recorded inside one run", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const answers = await challengesFor(fixture);

    const run = await capture(
      fixture,
      () => runMigration(["auth"], { recordTrustedDecision: terminalRecorder }),
      { answers },
    );

    // The prompt was raised here...
    assert.match(run.stdout, /Challenge: APPROVE /);
    assert.match(run.stdout, /Operator decision for migration 'auth'/);
    // ...answered here, and written before this call returned.
    assert.equal((await ledgerLines(fixture)).length, 1);
    assert.equal(run.result.outcome, "CONTINUE");
    assert.equal(run.exitCode, 0);
    assert.equal(
      directiveOf(run.stdout),
      "loop: CONTINUE next=/start-migration auth",
    );
    // 08 C: the interactive CLI never hands the operator a second command.
    assert.doesNotMatch(run.stdout, /record-decision\.mjs/);
    assert.doesNotMatch(run.stdout, /^Operator approval required/m);
    assert.notEqual(run.result.outcome, "OPERATOR_DECISION");
  } finally {
    await fixture.cleanup();
  }
});

/**
 * `08` proof 7. `record-decision.mjs` is still a working primitive, and a line
 * it wrote is indistinguishable to everything downstream: the very next `run`
 * finds nothing pending and asks for the citation instead of an approval.
 */
test("record-decision remains a usable fallback and its line satisfies the census", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const [challenge] = await challengesFor(fixture);
    const { registryPath } = await resolutionFor(fixture);
    const [candidate] = await decisionCandidates({
      step: "DISCOVERY_COMPLETENESS",
      registryPath,
      moduleName: "auth",
    });

    const recorded = await capture(
      fixture,
      () => runRecordDecisionCli(["auth", "--approve", candidate.id]),
      { answers: [challenge] },
    );

    assert.ok(recorded.result.decision, recorded.stdout);
    assert.equal((await ledgerLines(fixture)).length, 1);
    assert.match(recorded.result.decision.statement, /at a terminal/);

    // Nothing is pending any more, so the next run is 4d, not 4b.
    const run = await capture(fixture, () => runMigration(["auth"]));
    assert.equal(run.result.outcome, "CONTINUE");
    assert.doesNotMatch(run.stdout, /^Operator approval required/m);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * `08` proof 8. The approval is persisted, not remembered. A later invocation
 * -- a different process's worth of state, with no TTY and nothing carried over
 * -- reads the ledger off disk, accepts the citation, and advances.
 */
test("a later run resumes from the persisted approval and advances the checkpoint", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const answers = await challengesFor(fixture);
    const before = await state(fixture);

    await capture(
      fixture,
      () => runMigration(["auth"], { recordTrustedDecision: terminalRecorder }),
      { answers },
    );
    const [line] = await ledgerLines(fixture);
    const decision = JSON.parse(line);

    // The other half of the act, which is the agent's: cite the id and digest.
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      {
        ...EXCLUDED_CLASSIFICATION,
        files: [
          {
            ...EXCLUDED_CLASSIFICATION.files[0],
            decisionId: decision.id,
            decisionDigest: decisionLineDigest(decision),
          },
        ],
      },
    );

    // No `answers`: no TTY, nothing to approve, nothing left to ask a human.
    const resumed = await capture(fixture, () => runMigration(["auth"]));

    assert.equal(resumed.result.outcome, "CONTINUE");
    assert.doesNotMatch(resumed.stdout, /Challenge: APPROVE/);
    const after = await state(fixture);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// --- the bootstrap-to-loop handoff ------------------------------------------
//
// The last place continuation was prose. Phase 1 stopped with a typed
// `AWAITING_CONFIRMATION`, phase 2 succeeded with no machine-readable line at
// all, and whether the first iteration ran was decided by a model reading
// `SKILL.md`. That is the same defect the directive closed for advances, so it
// is closed the same way: `nextOutcome` + `renderLoopDirective`, no second
// policy, and `--mode step` still renders nothing.

/**
 * A fresh, never-bootstrapped fixture whose OpenSpec authority already exists
 * on disk. `--openspec-proposal-stdin` is the other way in and would only add
 * stream plumbing: what is under test is the tail of a successful bootstrap,
 * not where its requirements came from.
 */
const withSpecOnDisk = async (fixture) => {
  const specPath = path.join(fixture.targetRoot, "openspec/specs/auth/spec.md");
  await mkdir(path.dirname(specPath), { recursive: true });
  await writeFile(specPath, SPEC);
};

const bootstrapCli = async (fixture, extra = []) => {
  const argv = ["auth", ...(await registryArguments(fixture)), ...extra];
  const run = await capture(fixture, () => runDiscoverCli(argv));
  // Flattened the way the wrapper's own suite reads it: the discover result's
  // discriminants beside the bytes it printed.
  return { ...run.result, stdout: run.stdout, exitCode: run.exitCode };
};

const CONTINUE_AUTH = "loop: CONTINUE next=/start-migration auth";
const STEP_MODE = ["--mode", "step"];

test("a bootstrap awaiting the operator still stops with a typed reason and writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await withSpecOnDisk(fixture);
    const before = await snapshot(fixture.root);

    // `step` is now the only mode that stops for a bootstrap: `auto` is the
    // principal and confirms its own preview. The stop itself is unchanged.
    const phaseOne = await bootstrapCli(fixture, ["--mode", "step"]);

    assert.equal(phaseOne.awaitingConfirmation, true, phaseOne.stdout);
    assert.equal(phaseOne.result, undefined);
    // `step` drives no loop, so it emits no directive; the typed stop is the
    // result discriminant plus the prose.
    assert.equal(directiveOf(phaseOne.stdout), null);
    assert.match(
      phaseOne.stdout,
      /Mode: step — awaiting explicit confirmation\. No execution has started\./,
    );
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "state.json")),
      false,
    );
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("a confirmed bootstrap ends with exactly one CONTINUE directive, as its last line", async () => {
  const fixture = await createFixture();
  try {
    await withSpecOnDisk(fixture);
    // One phase, not two: under `auto` the bootstrap confirms its own preview,
    // so the second invocation that used to carry the id no longer exists.
    const phaseTwo = await bootstrapCli(fixture, ["--mode", "auto"]);

    assert.equal(phaseTwo.awaitingConfirmation, undefined);
    assert.equal(phaseTwo.blocked, undefined);
    assert.equal(phaseTwo.result.state.currentStep, "DISCOVER_LEGACY");
    // `directiveOf` refuses a second line: one bootstrap, one directive.
    assert.equal(directiveOf(phaseTwo.stdout), CONTINUE_AUTH);
    assert.ok(phaseTwo.stdout.endsWith(`${CONTINUE_AUTH}\n`), phaseTwo.stdout);
    // A successful bootstrap exited zero before this line existed, and still does.
    assert.ok(!phaseTwo.exitCode, `exit code ${phaseTwo.exitCode}`);
  } finally {
    await fixture.cleanup();
  }
});

test("auto reaches the normal run contract from the directive alone, never from prose", async () => {
  const fixture = await createFixture();
  try {
    await withSpecOnDisk(fixture);
    const phaseTwo = await bootstrapCli(fixture, ["--mode", "auto"]);

    // Same check the auto-lifecycle test applies to every advance: with the
    // directive removed, nothing left may ask a human to say "continue".
    const prose = phaseTwo.stdout
      .split("\n")
      .filter((line) => !line.startsWith("loop: "))
      .join("\n");
    assert.doesNotMatch(prose, /continue/i, phaseTwo.stdout);
    assert.doesNotMatch(prose, /Next command:/, phaseTwo.stdout);

    // Obeying the directive literally: run exactly the command `next=` names.
    const [, next] = directiveOf(phaseTwo.stdout).match(
      /^loop: CONTINUE next=\/start-migration (\S+)$/,
    );
    const first = await capture(fixture, () => runMigration([next]));

    // The ordinary iteration contract, reached with no prose in between: same
    // outcome vocabulary, same directive, exactly one of it.
    assert.equal(first.result.outcome, "CONTINUE");
    assert.equal(first.result.request.step, "DISCOVER_LEGACY");
    assert.equal(directiveOf(first.stdout), CONTINUE_AUTH);
    assert.equal(first.exitCode, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("--mode step bootstraps with no directive at either phase", async () => {
  const fixture = await createFixture();
  try {
    await withSpecOnDisk(fixture);
    const phaseOne = await bootstrapCli(fixture, STEP_MODE);
    assert.equal(phaseOne.awaitingConfirmation, true);
    assert.equal(directiveOf(phaseOne.stdout), null);
    assert.ok(
      phaseOne.stdout.endsWith(
        `Confirmation ID: ${phaseOne.preview.confirmationId}\n` +
          "Mode: step — awaiting explicit confirmation. No execution has started.\n",
      ),
      phaseOne.stdout,
    );

    const phaseTwo = await bootstrapCli(fixture, [
      ...STEP_MODE,
      "--confirm-execution",
      phaseOne.preview.confirmationId,
    ]);

    // The operator drives every iteration here by hand, so the successful
    // bootstrap still ends on its own last byte and nothing drives a loop.
    assert.equal(phaseTwo.result.state.currentStep, "DISCOVER_LEGACY");
    assert.equal(directiveOf(phaseTwo.stdout), null);
    assert.ok(
      phaseTwo.stdout.endsWith(
        `Next artifact: ${phaseTwo.result.nextArtifact ?? "none"}\n`,
      ),
      phaseTwo.stdout,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("run and discover accept repeatable --legacy and --adopt-target", () => {
  // Bootstrap inputs, forwarded verbatim to discover: `run` must parse them
  // (strict parseArgs) while returning the same four options as before.
  assert.deepEqual(
    parseRunArguments([
      "catalog-sync",
      "--legacy",
      "catalog-target",
      "--legacy",
      "catalog-source",
      "--adopt-target",
    ]),
    {
      moduleName: "catalog-sync",
      mode: undefined,
      slice: undefined,
      json: false,
    },
  );

  // Discover is where they are consumed, and the order they are typed in must
  // not survive into the record.
  const parsed = parseDiscoverArguments([
    "catalog-sync",
    "--legacy",
    "catalog-target",
    "--legacy",
    "catalog-source",
    "--adopt-target",
  ]);
  assert.deepEqual(parsed.legacy, [
    "catalog-target",
    "catalog-source",
  ]);
  assert.equal(parsed.adoptTarget, true);
  assert.deepEqual(resolveLegacySources(parsed.legacy), [
    "catalog-source",
    "catalog-target",
  ]);
  assert.deepEqual(
    resolveLegacySources(["catalog-source", "catalog-target"]),
    resolveLegacySources([
      "catalog-target",
      "catalog-source",
      "catalog-target",
    ]),
  );

  assert.equal(parseDiscoverArguments(["auth"]).adoptTarget, false);
  assert.equal(parseDiscoverArguments(["auth"]).legacy, undefined);
  assert.throws(
    () => resolveLegacySources(["Not A Module"]),
    /Invalid legacy source/,
  );
  // Read-only invocations still refuse every bootstrap input by name.
  assert.throws(
    () => parseDiscoverArguments(["auth", "--status", "--adopt-target"]),
    /--status is read-only/,
  );
  assert.throws(
    () => parseDiscoverArguments(["auth", "--scan", "--legacy", "other"]),
    /--scan is read-only/,
  );
});
