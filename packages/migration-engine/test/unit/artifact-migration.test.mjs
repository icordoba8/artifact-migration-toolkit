import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire as requireFrom } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  FINAL_GATES,
  MIGRATION_OUTCOMES,
  parserResolutionError,
  runDiscoveryScan,
} from "../../src/core.mjs";
import { artifactPrerequisiteWork } from "../../src/resumable-migration.mjs";
import { runRecordDecisionCli } from "../../src/record-decision.mjs";
import { lockPathFor } from "../../src/module-lock.mjs";
import {
  artifactArgumentsFor,
  artifactCommandFor,
  artifactEvidenceDigest,
  artifactIdFor,
  artifactRoot,
  getArtifactStatus,
  architectureFindings,
  hasCodeValidationCheck,
  legacyDependencies,
  checkpointArtifacts,
  progressState,
  readArtifactState,
  runArtifact,
  structuralUnits,
  targetTypeScript,
  validateArtifactComplete,
} from "../../src/artifact/artifact-migration.mjs";
import { artifactDirective, parseArtifactArguments } from "../../src/artifact/run-artifact.mjs";

const execFileAsync = promisify(execFile);
const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/artifact",
);
const digest = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");
const exists = (file) => access(file).then(() => true, () => false);
const typescriptCheck = (status = "PASS", project = "tsconfig.json") => ({
  validator: { kind: "TYPESCRIPT", project },
  status,
});
const nodeCheck = (file, status = "PASS") => ({
  validator: { kind: "NODE_CHECK", file },
  status,
});

const writeJson = async (root, relative, value) => {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-migration-"));
  const sourceRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  await mkdir(path.join(sourceRoot, "widget"), { recursive: true });
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceRoot, "widget/source.ts"), "export const source = true;\n"),
    writeFile(path.join(sourceRoot, "widget/theme.css"), ":root { --accent: red; }\n"),
    writeFile(path.join(sourceRoot, "widget/consumer-a.ts"), "export const a = 'theme';\n"),
    writeFile(path.join(sourceRoot, "widget/consumer-b.ts"), "export const b = 'theme';\n"),
    writeFile(path.join(sourceRoot, "widget/local.css"), ".widget { color: red; }\n"),
    writeFile(path.join(targetRoot, "src/widget.ts"), "export const widget = 'native';\n"),
    writeFile(path.join(targetRoot, "src/widget.js"), "export const widget = 'native';\n"),
    writeFile(path.join(targetRoot, "src/theme.ts"), "export const theme = 'target';\n"),
    writeFile(path.join(targetRoot, "src/placeholder.ts"), "export {};\n"),
    writeFile(
      path.join(targetRoot, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, skipLibCheck: true, target: "ES2022" }, include: ["src/**/*.ts", "src/**/*.tsx"] }, null, 2)}\n`,
    ),
  ]);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Artifact Test",
      "-c",
      "user.email=artifact@example.test",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  const options = {
    source: "widget",
    type: "component",
    target: "src/widget.ts",
    sourceRoot,
    targetRoot,
  };
  const id = artifactIdFor({ source: options.source, type: options.type });
  return {
    root,
    sourceRoot,
    targetRoot,
    options,
    id,
    artifactRoot: artifactRoot(targetRoot, id),
    // win32 keeps a handle on a directory briefly after a child process that
    // used it as cwd exits, so a fixture that spawned one needs a short retry.
    cleanup: async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await rm(root, { recursive: true, force: true });
        } catch (error) {
          if (attempt >= 10 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    },
  };
};

// The unconditional structural census of the fixture's five source files. A
// script unit is keyed `<file>#<binding>`; a non-script file is its own unit.
const FIXTURE_CENSUS = [
  "widget/consumer-a.ts#a",
  "widget/consumer-b.ts#b",
  "widget/local.css",
  "widget/source.ts#source",
  "widget/theme.css",
];

// Every census unit, with per-unit disposition overrides. The census is
// unconditional now, so a test that cares about one unit still documents all.
const censusUnits = (overrides = {}) =>
  FIXTURE_CENSUS.map((unitPath) => ({
    path: unitPath,
    disposition: "MIGRATED_BEHAVIOR",
    ref: "B-1",
    ...overrides[unitPath],
  }));

const stateOf = (fixture) => readArtifactState(fixture.targetRoot, fixture.id);
const sourceEvidence = async (fixture, relative = "widget/source.ts") => ({
  path: relative,
  sha256: await digest(path.join(fixture.sourceRoot, relative)),
  status: "VERIFIED",
});
const targetEvidence = async (fixture, relative = fixture.options.target) => ({
  path: relative,
  sha256: await digest(path.join(fixture.targetRoot, relative)),
  status: "VERIFIED",
});

const bootstrap = async (fixture, extra = {}) => {
  const result = await runArtifact({ ...fixture.options, ...extra });
  assert.equal(result.outcome, "CONTINUE");
  assert.equal((await stateOf(fixture)).currentStep, "DISCOVER_LEGACY");
};

const sourceInventory = async (fixture, { ui = false, pendingDecision = false, runtimeStates = ["DEFAULT"] } = {}) => {
  const state = await stateOf(fixture);
  return {
    version: 1,
    artifactId: fixture.id,
    hasVisibleUi: ui,
    sourceFiles: state.bindings.source.entries
      .filter((entry) => entry.kind === "FILE")
      .map((entry) => entry.path),
    behaviors: [
      {
        id: "B-1",
        description: "The artifact retains its observable behavior.",
        visible: ui,
        evidence: [await sourceEvidence(fixture)],
        ...(ui ? { runtimeStates } : {}),
      },
    ],
    globalContracts: [
      {
        id: "GC-1",
        kind: "GLOBAL_THEME",
        sourcePath: "widget/theme.css",
        consumers: ["widget/consumer-a.ts", "widget/consumer-b.ts"],
      },
    ],
    featureLocalVisuals: [
      {
        id: "FV-1",
        path: "widget/local.css",
        evidence: [await sourceEvidence(fixture, "widget/local.css")],
      },
    ],
    operatorDecisions: pendingDecision
      ? [{ id: "DEC-1", subject: "Exclude unsupported legacy decoration" }]
      : [],
  };
};

const authorSource = async (fixture, options) => {
  const document = await sourceInventory(fixture, options);
  await writeJson(fixture.artifactRoot, "inventories/source.json", document);
  return document;
};

const advanceDiscovery = async (fixture, options) => {
  const source = await authorSource(fixture, options);
  assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
  await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
    version: 1,
    sourceFiles: source.sourceFiles,
    units: options?.units ?? FIXTURE_CENSUS.map((path_) => ({
      path: path_,
      disposition: "MIGRATED_BEHAVIOR",
      ref: "B-1",
    })),
    requirements: options?.requirements ?? [],
  });
  assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
  assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
};

const targetInventory = async (fixture, resolution) => {
  if (resolution === "MIGRATE_NEW") {
    return {
      version: 1,
      artifactId: fixture.id,
      resolution,
      targetFiles: [],
      targetNative: [],
      evidence: [],
    };
  }
  const evidence = await targetEvidence(fixture);
  return {
    version: 1,
    artifactId: fixture.id,
    resolution,
    targetFiles: [fixture.options.target],
    targetNative: [
      {
        id: "TN-1",
        path: fixture.options.target,
        description: "Existing target-native artifact behavior.",
        evidence: [evidence],
      },
    ],
    evidence: resolution === "TARGET_REUSE" ? [{ behaviorId: "B-1", ...evidence }] : [],
  };
};

const advanceAssessment = async (fixture, resolution) => {
  const document = await targetInventory(fixture, resolution);
  await writeJson(fixture.artifactRoot, "inventories/target.json", document);
  const result = await runArtifact(fixture.options);
  assert.equal(result.outcome, "CONTINUE", result.reason);
  const state = await stateOf(fixture);
  assert.equal(state.currentStep, "BUILD_BASELINE");
  assert.equal(state.resolution, resolution);
};

const baselineDocuments = async (fixture, resolution, { final = false } = {}) => {
  const target = await targetInventory(fixture, resolution);
  const evidence = await targetEvidence(fixture);
  return {
    parity: {
      version: 1,
      rows: [
        {
          id: "P-1",
          behaviorId: "B-1",
          resolution,
          status: resolution === "TARGET_REUSE" || final ? "VERIFIED" : "PLANNED",
          targetEvidence: resolution === "TARGET_REUSE" || final ? [evidence] : [],
        },
      ],
    },
    native: {
      version: 1,
      rows: target.targetNative.map((row) => ({
        id: row.id,
        path: row.path,
        description: row.description,
        status:
          resolution === "TARGET_REUSE"
            ? "VERIFIED"
            : final
              ? "PRESERVED"
              : "PLANNED",
        evidence: final || resolution === "TARGET_REUSE" ? [evidence] : [],
      })),
    },
    design: {
      version: 1,
      rows: (await stateOf(fixture)).hasVisibleUi
        ? [
            {
              id: "DS-1",
              behaviorId: "B-1",
              scope: "FEATURE_LOCAL",
              targetComponent: "TargetWidget",
              requiredComponent: "TargetWidget",
              status: final ? "COMPLIANT" : "PLANNED",
              evidence: final ? [evidence] : [],
              decisionId: null,
            },
          ]
        : [],
    },
    global: {
      version: 1,
      rows: [
        {
          id: "GM-1",
          sourceContractId: "GC-1",
          kind: "GLOBAL_THEME",
          targetPath: "src/theme.ts",
          consumers: ["widget/consumer-a.ts", "widget/consumer-b.ts"],
          status: final ? "VERIFIED" : "PLANNED",
          evidence: final ? [await targetEvidence(fixture, "src/theme.ts")] : [],
        },
      ],
    },
  };
};

const writeBaseline = async (fixture, resolution, options) => {
  const documents = await baselineDocuments(fixture, resolution, options);
  await Promise.all([
    writeJson(fixture.artifactRoot, "matrices/parity.json", documents.parity),
    writeJson(fixture.artifactRoot, "matrices/target-native.json", documents.native),
    writeJson(fixture.artifactRoot, "matrices/design-system.json", documents.design),
    writeJson(fixture.artifactRoot, "matrices/global-contract.json", documents.global),
  ]);
  return documents;
};

const advanceBaseline = async (fixture, resolution) => {
  await writeBaseline(fixture, resolution);
  const result = await runArtifact(fixture.options);
  assert.equal(result.outcome, "CONTINUE", result.reason);
  assert.equal((await stateOf(fixture)).currentStep, "PLAN");
};

const advancePlan = async (fixture, resolution) => {
  await writeJson(fixture.artifactRoot, "slices/index.json", {
    version: 1,
    slices: [
      {
        id: "slice-1",
        behaviorIds: ["B-1"],
        dependsOn: [],
        kind: { TARGET_REUSE: "REUSE", TARGET_EXTEND: "EXTEND", MIGRATE_NEW: "NEW" }[resolution],
      },
    ],
  });
  const result = await runArtifact(fixture.options);
  assert.equal(result.outcome, "CONTINUE", result.reason);
  const state = await stateOf(fixture);
  assert.equal(state.currentStep, "IMPLEMENT_SLICES");
  assert.equal(state.activeSlice, "slice-1");
};

const advanceImplementation = async (fixture, resolution) => {
  if (resolution !== "TARGET_REUSE") {
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      `export const widget = '${resolution}';\n`,
    );
  }
  const changedFiles =
    resolution === "TARGET_REUSE"
      ? []
      : [
          {
            path: fixture.options.target,
            sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
          },
        ];
  await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
    version: 1,
    sliceId: "slice-1",
    status: "COMPLETE",
    changedFiles,
    checks: [typescriptCheck()],
    preservedTargetNativeIds: resolution === "TARGET_EXTEND" ? ["TN-1"] : [],
  });
  const result = await runArtifact(fixture.options);
  assert.equal(result.outcome, "CONTINUE", result.reason);
  assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
};

const verificationDocument = async (fixture, { ui = false, sessionId = "session-a" } = {}) => {
  const state = await stateOf(fixture);
  const target = await targetEvidence(fixture);
  const runtimeEvidence = [];
  if (ui) {
    const snapshotPath = "evidence/slice-1/ui/default.md";
    const screenshotPath = "evidence/slice-1/ui/default.png";
    const snapshot = await writeJson(fixture.artifactRoot, snapshotPath, { role: "button", name: "Save" });
    const screenshot = path.join(fixture.artifactRoot, screenshotPath);
    await mkdir(path.dirname(screenshot), { recursive: true });
    await writeFile(screenshot, Buffer.from([137, 80, 78, 71]));
    runtimeEvidence.push({
      behaviorId: "B-1",
      origin: "TARGET",
      state: "DEFAULT",
      route: "/widget",
      viewport: { width: 1280, height: 720 },
      actions: [
        {
          kind: "click",
          target: "Save",
          expected: "The widget saves.",
          actual: "The widget saved.",
          status: "PASS",
        },
      ],
      artifacts: [
        { kind: "ACCESSIBILITY_SNAPSHOT", path: snapshotPath, sha256: await digest(snapshot) },
        { kind: "SCREENSHOT", path: screenshotPath, sha256: await digest(screenshot) },
      ],
      boundTo: {
        sourceDigest: state.bindings.source.digest,
        targetDigest: state.bindings.target.digest,
        sliceDigest: await digest(path.join(fixture.artifactRoot, "slices/slice-1.json")),
      },
      provider: "playwright",
      sessionId,
    });
  }
  return {
    version: 1,
    sliceId: "slice-1",
    status: "PASS",
    checks: [{ behaviorId: "B-1", status: "PASS", evidence: [target] }],
    runtimeEvidence,
  };
};

const advanceVerification = async (fixture, options) => {
  const document = await verificationDocument(fixture, options);
  await writeJson(fixture.artifactRoot, "evidence/slice-1/result.json", document);
  const result = await runArtifact(fixture.options);
  assert.equal(result.outcome, "CONTINUE", result.reason);
  assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");
  return document;
};

const gatesDocument = async (fixture, { ui = false, requirementElements = [] } = {}) => {
  const state = await stateOf(fixture);
  const evidence = {
    path: fixture.options.target,
    sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
    boundTo: {
      sourceDigest: state.bindings.source.digest,
      targetDigest: state.bindings.target.digest,
    },
  };
  const uiEvidence = [];
  if (ui) {
    const result = JSON.parse(
      await readFile(path.join(fixture.artifactRoot, "evidence/slice-1/result.json"), "utf8"),
    );
    uiEvidence.push({
      sliceId: "slice-1",
      path: "evidence/slice-1/result.json",
      sha256: artifactEvidenceDigest(result),
      boundTo: evidence.boundTo,
    });
  }
  return {
    version: 1,
    gates: FINAL_GATES.map((name) => ({ name, status: "PASS", evidence: [evidence] })),
    uiEvidence,
    requirementEvidence: requirementElements.map((element) => ({ element, ...evidence })),
  };
};

const driveToBuild = async (fixture, resolution, options = {}) => {
  await bootstrap(fixture, options.bootstrap);
  await advanceDiscovery(fixture, options);
  await advanceAssessment(fixture, resolution);
};

const driveToComplete = async (fixture, resolution = "TARGET_EXTEND", options = {}) => {
  await driveToBuild(fixture, resolution, options);
  await advanceBaseline(fixture, resolution);
  await advancePlan(fixture, resolution);
  await advanceImplementation(fixture, resolution);
  await advanceVerification(fixture, { ui: false });
  await writeBaseline(fixture, resolution, { final: true });
  await writeJson(
    fixture.artifactRoot,
    "gates.json",
    await gatesDocument(fixture, { requirementElements: options.requirementElements ?? [] }),
  );
  const result = await runArtifact(fixture.options);
  assert.equal(result.outcome, "COMPLETE", result.reason);
  return result;
};

test("E/F: completed standalone artifacts are reused by multiple parents without mutation", async () => {
  const fixture = await createFixture();
  try {
    await driveToComplete(fixture);
    const row = {
      id: "CAP-S",
      classification: "SHARED_PREREQUISITE",
      targetOwner: "src",
      artifactMigration: {
        source: fixture.options.source,
        type: fixture.options.type,
        target: fixture.options.target,
      },
    };
    const slices = [{ id: "shared", capabilityIds: [row.id], dependencies: [] }];
    const before = await Promise.all(
      ["state.json", "integrity.json", "history/history.ndjson"].map((relative) =>
        readFile(path.join(fixture.artifactRoot, relative), "utf8"),
      ),
    );
    for (const legacyModule of ["feature-a", "feature-b"]) {
      const work = await artifactPrerequisiteWork(
        { formatVersion: 13, legacyModule, activeSlice: "shared" },
        { legacyRoot: fixture.sourceRoot, targetRoot: fixture.targetRoot },
        { capabilityRows: [row], slices },
      );
      assert.deepEqual(work, { outcome: "COMPLETE" });
    }
    const after = await Promise.all(
      ["state.json", "integrity.json", "history/history.ndjson"].map((relative) =>
        readFile(path.join(fixture.artifactRoot, relative), "utf8"),
      ),
    );
    assert.deepEqual(after, before);
  } finally {
    await fixture.cleanup();
  }
});

// Builds one runtime-evidence record backed by real capture files under the
// active slice's evidence/ui directory. `key` names distinct capture files so
// byte-identical images across slots live in separate files.
const uiRecord = async (fixture, { origin, state, key, screenshotBytes = [137, 80, 78, 71] }) => {
  const st = await stateOf(fixture);
  const snapshotPath = `evidence/slice-1/ui/${key}.md`;
  const screenshotPath = `evidence/slice-1/ui/${key}.png`;
  const snapshot = await writeJson(fixture.artifactRoot, snapshotPath, { role: "button", name: key });
  const screenshot = path.join(fixture.artifactRoot, screenshotPath);
  await mkdir(path.dirname(screenshot), { recursive: true });
  await writeFile(screenshot, Buffer.from(screenshotBytes));
  return {
    behaviorId: "B-1",
    origin,
    state,
    route: "/widget",
    viewport: { width: 1280, height: 720 },
    actions: [{ kind: "click", target: "Save", expected: "saved", actual: "saved", status: "PASS" }],
    artifacts: [
      { kind: "ACCESSIBILITY_SNAPSHOT", path: snapshotPath, sha256: await digest(snapshot) },
      { kind: "SCREENSHOT", path: screenshotPath, sha256: await digest(screenshot) },
    ],
    boundTo: {
      sourceDigest: st.bindings.source.digest,
      targetDigest: st.bindings.target.digest,
      sliceDigest: await digest(path.join(fixture.artifactRoot, "slices/slice-1.json")),
    },
    provider: "playwright",
  };
};

// Drives a UI artifact to VERIFY_SLICES with the given declared runtime states,
// leaving the caller to author evidence/slice-1/result.json.
const driveUiToVerify = async (fixture, runtimeStates = ["DEFAULT"]) => {
  await driveToBuild(fixture, "TARGET_EXTEND", { ui: true, runtimeStates });
  await advanceBaseline(fixture, "TARGET_EXTEND");
  await advancePlan(fixture, "TARGET_EXTEND");
  await advanceImplementation(fixture, "TARGET_EXTEND");
};

const runVerification = async (fixture, runtimeEvidence) => {
  await writeJson(fixture.artifactRoot, "evidence/slice-1/result.json", {
    version: 1,
    sliceId: "slice-1",
    status: "PASS",
    checks: [{ behaviorId: "B-1", status: "PASS", evidence: [await targetEvidence(fixture)] }],
    runtimeEvidence,
  });
  return runArtifact(fixture.options);
};

test("the CLI bootstraps directly with no registry, parent, or module state", async () => {
  const fixture = await createFixture();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "run-artifact.mjs"),
        "widget",
        "--type",
        "component",
        "--target",
        "src/widget.ts",
        "--source-root",
        fixture.sourceRoot,
        "--target-root",
        fixture.targetRoot,
        "--json",
      ],
      { encoding: "utf8", cwd: fixture.root },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.outcome, "CONTINUE");
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVER_LEGACY");
    assert.equal(
      await exists(path.join(fixture.targetRoot, ".agents/knowledge/migrations/modules")),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("TARGET_REUSE requires verified evidence; EXTEND and NEW persist independently", async () => {
  for (const resolution of ["TARGET_REUSE", "TARGET_EXTEND", "MIGRATE_NEW"]) {
    const fixture = await createFixture();
    try {
      if (resolution === "MIGRATE_NEW") fixture.options.target = "src/new-widget.ts";
      await bootstrap(fixture);
      await advanceDiscovery(fixture);
      const inventory = await targetInventory(fixture, resolution);
      if (resolution === "TARGET_REUSE") {
        inventory.evidence = [];
        await writeJson(fixture.artifactRoot, "inventories/target.json", inventory);
        const refused = await runArtifact(fixture.options);
        assert.equal(refused.outcome, "CONTINUE");
        assert.match(refused.reason, /TARGET_REUSE verified behavior evidence/);
        inventory.evidence = [{ behaviorId: "B-1", ...(await targetEvidence(fixture)) }];
      }
      await writeJson(fixture.artifactRoot, "inventories/target.json", inventory);
      assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
      assert.equal((await stateOf(fixture)).resolution, resolution);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("resume is exact and an unauthored checkpoint appends no history", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    const before = await stateOf(fixture);
    const historyFile = path.join(fixture.artifactRoot, "history/history.ndjson");
    const history = await readFile(historyFile, "utf8");
    for (let index = 0; index < 2; index += 1) {
      const result = await runArtifact(fixture.options);
      assert.equal(result.outcome, "CONTINUE");
      assert.equal(result.request.checkpoint, "DISCOVER_LEGACY");
    }
    assert.deepEqual(await stateOf(fixture), before);
    assert.equal(await readFile(historyFile, "utf8"), history);
  } finally {
    await fixture.cleanup();
  }
});

test("relevant source/target drift is typed STALE/BLOCKED while provider drift is ignored", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    await mkdir(path.join(fixture.targetRoot, ".opencode"), { recursive: true });
    await writeFile(path.join(fixture.targetRoot, ".opencode/session.json"), "{}\n");
    assert.equal((await getArtifactStatus(fixture.options)).status, "ACTIVE");

    await writeFile(path.join(fixture.targetRoot, "src/widget.ts"), "export const widget = 'drift';\n");
    const targetStale = await getArtifactStatus(fixture.options);
    assert.equal(targetStale.status, "STALE");
    assert.equal(targetStale.outcome, "BLOCKED");
  } finally {
    await fixture.cleanup();
  }

  const sourceFixture = await createFixture();
  try {
    await bootstrap(sourceFixture);
    await writeFile(path.join(sourceFixture.sourceRoot, "widget/source.ts"), "export const source = false;\n");
    const sourceStale = await getArtifactStatus(sourceFixture.options);
    assert.equal(sourceStale.status, "STALE");
    assert.ok(sourceStale.stale.sourceDrift.includes("widget/source.ts"));
  } finally {
    await fixture.cleanup();
  }
});

test("global themes cover every consumer and feature-local visuals stay excluded", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    const documents = await writeBaseline(fixture, "TARGET_EXTEND");
    documents.global.rows[0].consumers = ["widget/consumer-a.ts"];
    await writeJson(fixture.artifactRoot, "matrices/global-contract.json", documents.global);
    const incomplete = await runArtifact(fixture.options);
    assert.match(incomplete.reason, /consumers must be exactly/);
    assert.equal((await stateOf(fixture)).currentStep, "BUILD_BASELINE");

    documents.global.rows = [
      {
        ...documents.global.rows[0],
        sourceContractId: "FV-1",
        consumers: ["widget/consumer-a.ts", "widget/consumer-b.ts"],
      },
    ];
    await writeJson(fixture.artifactRoot, "matrices/global-contract.json", documents.global);
    const local = await runArtifact(fixture.options);
    assert.match(local.reason, /Feature-local visual 'FV-1' cannot enter/);

    await writeBaseline(fixture, "TARGET_EXTEND");
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
  } finally {
    await fixture.cleanup();
  }
});

test("visible UI requires Playwright evidence at VERIFY and fresh references at FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND", { ui: true });
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await advanceImplementation(fixture, "TARGET_EXTEND");

    await writeJson(
      fixture.artifactRoot,
      "evidence/slice-1/result.json",
      await verificationDocument(fixture, { ui: false }),
    );
    const noRuntime = await runArtifact(fixture.options);
    assert.equal(noRuntime.outcome, "CONTINUE");
    assert.match(noRuntime.reason, /TARGET runtime coverage/);

    await advanceVerification(fixture, { ui: true });
    await writeBaseline(fixture, "TARGET_EXTEND", { final: true });

    const resultPath = path.join(fixture.artifactRoot, "evidence/slice-1/result.json");
    const evidence = JSON.parse(await readFile(resultPath, "utf8"));
    evidence.runtimeEvidence[0].provider = "playwright-mcp-v2";
    evidence.runtimeEvidence[0].sessionId = "replacement-session";
    await writeJson(fixture.artifactRoot, "evidence/slice-1/result.json", evidence);
    assert.equal((await getArtifactStatus(fixture.options)).status, "ACTIVE");

    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));
    const noFinalUi = await runArtifact(fixture.options);
    assert.equal(noFinalUi.outcome, "CONTINUE");
    assert.match(noFinalUi.reason, /final UI evidence slices/);

    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture, { ui: true }));
    const completed = await runArtifact(fixture.options);
    assert.equal(completed.outcome, "COMPLETE", completed.reason);
    assert.deepEqual(await validateArtifactComplete(fixture.options), {
      valid: true,
      complete: true,
      artifactId: fixture.id,
      resolution: "TARGET_EXTEND",
      status: "COMPLETE",
      statePath: path.join(fixture.artifactRoot, "state.json"),
    });
  } finally {
    await fixture.cleanup();
  }
});

test("completed artifact does not bypass freshness validation and returns STALE", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND", { ui: true });
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await advanceImplementation(fixture, "TARGET_EXTEND");
    await advanceVerification(fixture, { ui: true });
    await writeBaseline(fixture, "TARGET_EXTEND", { final: true });
    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture, { ui: true }));
    const completed = await runArtifact(fixture.options);
    assert.equal(completed.outcome, "COMPLETE", completed.reason);

    // Mutate target
    await writeFile(path.join(fixture.targetRoot, "src/widget.ts"), "export const widget = 'drift';\n");

    const staleStatus = await getArtifactStatus(fixture.options);
    assert.equal(staleStatus.status, "STALE");

    await assert.rejects(
      validateArtifactComplete(fixture.options),
      /stale/i
    );

    const staleRun = await runArtifact(fixture.options);
    assert.equal(staleRun.status, "STALE");
    assert.equal(staleRun.outcome, "BLOCKED");
    assert.match(staleRun.reason, /Previously completed output is stale/i);

    // Recovery restores completion
    await writeFile(path.join(fixture.targetRoot, "src/widget.ts"), "export const widget = 'TARGET_EXTEND';\n");
    const restoredRun = await runArtifact(fixture.options);
    assert.equal(restoredRun.outcome, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

test("TARGET_EXTEND immutable target-native rows survive implementation", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await advanceImplementation(fixture, "TARGET_EXTEND");
    const native = JSON.parse(
      await readFile(path.join(fixture.artifactRoot, "matrices/target-native.json"), "utf8"),
    );
    native.rows[0].path = "src/replaced.ts";
    await writeJson(fixture.artifactRoot, "matrices/target-native.json", native);
    const status = await getArtifactStatus(fixture.options);
    assert.equal(status.status, "BLOCKED");
    assert.match(status.reason, /Completed artifact changed/);
  } finally {
    await fixture.cleanup();
  }
});

test("HISTORICAL_ARTIFACT_FORMATS no longer exists and format 11 is refused", async () => {
  const api = await import("../../src/artifact/artifact-migration.mjs");
  assert.equal("HISTORICAL_ARTIFACT_FORMATS" in api, false);
  const fixture = await createFixture();
  try {
    await assert.rejects(
      runArtifact({ ...fixture.options, formatVersion: 11 }),
      /Unsupported artifact migration format 11/,
    );
    assert.equal(
      await exists(path.join(fixture.artifactRoot, "state.json")),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("pending operator decisions block advance and no approval API exists on the engine", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    await authorSource(fixture, { pendingDecision: true });
    const stateBefore = await stateOf(fixture);
    const historyFile = path.join(fixture.artifactRoot, "history/history.ndjson");
    const historyBefore = await readFile(historyFile, "utf8");
    const result = await runArtifact(fixture.options);
    assert.equal(result.outcome, "OPERATOR_DECISION");
    assert.equal(result.pendingDecisions.length, 1);
    assert.equal(result.pendingDecisions[0].id, "DEC-1");
    assert.match(result.pendingDecisions[0].candidateId, /^APP-/);
    assert.match(result.pendingDecisions[0].command, /--artifact .* --approve APP-/);
    assert.deepEqual(await stateOf(fixture), stateBefore);
    assert.equal(await readFile(historyFile, "utf8"), historyBefore);
    const api = await import("../../src/artifact/artifact-migration.mjs");
    assert.equal(
      Object.keys(api).some((name) => /^approve|recordDecision/i.test(name)),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an agent cannot mint its own artifact approval; a real ledger approval advances", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    await authorSource(fixture, { pendingDecision: true });
    const pending = await runArtifact(fixture.options);
    assert.equal(pending.outcome, "OPERATOR_DECISION");
    const appId = pending.pendingDecisions[0].candidateId;

    const sourcePath = path.join(fixture.artifactRoot, "inventories/source.json");
    const forged = JSON.parse(await readFile(sourcePath, "utf8"));
    forged.operatorDecisions[0].decisionId = "DEC-001";
    await writeJson(fixture.artifactRoot, "inventories/source.json", forged);
    assert.equal((await runArtifact(fixture.options)).outcome, "OPERATOR_DECISION");

    const clean = JSON.parse(await readFile(sourcePath, "utf8"));
    delete clean.operatorDecisions[0].decisionId;
    await writeJson(fixture.artifactRoot, "inventories/source.json", clean);
    const stdout = { write: () => {} };
    const recorded = await runRecordDecisionCli(
      [
        "--artifact",
        fixture.options.source,
        "--type",
        fixture.options.type,
        "--source-root",
        fixture.sourceRoot,
        "--target-root",
        fixture.targetRoot,
        "--approve",
        appId,
      ],
      { stdout, ask: async ({ challenge }) => challenge },
    );
    assert.ok(recorded.decision, "a ledger decision was recorded");

    const approved = JSON.parse(await readFile(sourcePath, "utf8"));
    approved.operatorDecisions[0].decisionId = recorded.decision.id;
    await writeJson(fixture.artifactRoot, "inventories/source.json", approved);
    const advanced = await runArtifact(fixture.options);
    assert.equal(advanced.outcome, "CONTINUE", advanced.reason);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
  } finally {
    await fixture.cleanup();
  }
});

test("an artifact approval without a TTY or ask is refused before anything is read", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    await authorSource(fixture, { pendingDecision: true });
    const stdout = { write: () => {} };
    const result = await runRecordDecisionCli(
      [
        "--artifact",
        fixture.options.source,
        "--type",
        fixture.options.type,
        "--source-root",
        fixture.sourceRoot,
        "--target-root",
        fixture.targetRoot,
        "--approve",
        "APP-anything",
      ],
      { stdin: { isTTY: false }, stdout, ask: null },
    );
    assert.equal(result.blocked, true);
    assert.equal(
      await exists(path.join(fixture.artifactRoot, "decisions/operator-decisions.ndjson")),
      false,
    );
    process.exitCode = 0;
  } finally {
    await fixture.cleanup();
  }
});

test("step mode binds confirmation and strict documents refuse unknown keys", async () => {
  const fixture = await createFixture();
  try {
    const preview = await runArtifact({ ...fixture.options, mode: "step" });
    assert.equal(preview.outcome, "AWAITING_CONFIRMATION");
    assert.equal(await exists(path.join(fixture.artifactRoot, "state.json")), false);
    assert.equal(
      (
        await runArtifact({
          ...fixture.options,
          mode: "step",
          confirmationId: preview.confirmationId,
        })
      ).outcome,
      "CONTINUE",
    );
    const document = await sourceInventory(fixture);
    document.unexpected = true;
    await writeJson(fixture.artifactRoot, "inventories/source.json", document);
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /unknown key\(s\): unexpected/);
  } finally {
    await fixture.cleanup();
  }
});

test("case-equivalent paths produce one artifact identity on win32", async () => {
  const canonicalId = artifactIdFor({ source: "widget/source.ts", type: "component" });
  const variantId = artifactIdFor({ source: "Widget/Source.ts", type: "component" });
  if (process.platform === "win32") {
    assert.equal(variantId, canonicalId);
  } else {
    assert.notEqual(variantId, canonicalId);
  }
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    const variant = process.platform === "win32" ? "Widget" : "widget";
    const status = await getArtifactStatus({ ...fixture.options, source: variant });
    assert.equal(status.status, "ACTIVE");
    assert.equal(status.artifactId, fixture.id);
  } finally {
    await fixture.cleanup();
  }
});

test("a completed artifact with a different target binding is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveToComplete(fixture, "TARGET_EXTEND");
    const ok = await validateArtifactComplete(fixture.options);
    assert.equal(ok.complete, true);
    await assert.rejects(
      validateArtifactComplete({ ...fixture.options, target: "src/theme.ts" }),
      /target conflicts with persisted state/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent bootstrap yields one record and no crash", async () => {
  const fixture = await createFixture();
  try {
    const [a, b] = await Promise.all([
      runArtifact(fixture.options),
      runArtifact(fixture.options),
    ]);
    assert.equal(a.outcome, "CONTINUE");
    assert.equal(b.outcome, "CONTINUE");
    const history = await readFile(
      path.join(fixture.artifactRoot, "history/history.ndjson"),
      "utf8",
    );
    const events = history.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === "BOOTSTRAPPED").length, 1);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVER_LEGACY");
  } finally {
    await fixture.cleanup();
  }
});

test("a pending recoverable transaction reports ACTIVE from --status and is recovered by the next run", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    const state = JSON.parse(
      await readFile(path.join(fixture.artifactRoot, "state.json"), "utf8"),
    );
    const events = (
      await readFile(path.join(fixture.artifactRoot, "history/history.ndjson"), "utf8")
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    await writeJson(fixture.artifactRoot, "transaction.json", {
      version: 1,
      state,
      event: events.at(-1),
    });
    const status = await getArtifactStatus(fixture.options);
    assert.equal(status.status, "ACTIVE");
    assert.equal(status.outcome, "CONTINUE");
    assert.match(status.reason, /recovered automatically/);
    const mismatch = await getArtifactStatus({
      ...fixture.options,
      target: "src/theme.ts",
    });
    assert.equal(mismatch.status, "BLOCKED");
    assert.match(mismatch.reason, /target conflicts with persisted state/);
    assert.equal(
      await exists(path.join(fixture.artifactRoot, "transaction.json")),
      true,
    );
    const result = await runArtifact(fixture.options);
    assert.equal(result.outcome, "CONTINUE");
    assert.equal(
      await exists(path.join(fixture.artifactRoot, "transaction.json")),
      false,
    );
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVER_LEGACY");
  } finally {
    await fixture.cleanup();
  }
});

test("artifact progress always shows 9 checkpoints regardless of formatVersion", async () => {
  const fixture = await createFixture();
  try {
    const result = await runArtifact(fixture.options);
    assert.equal(result.progress.checkpoints.length, 9);
    assert.deepEqual(
      result.progress.checkpoints.map((row) => row.name),
      [
        "RESOLVE",
        "DISCOVER_LEGACY",
        "DISCOVERY_COMPLETENESS",
        "ASSESS_TARGET",
        "BUILD_BASELINE",
        "PLAN",
        "IMPLEMENT_SLICES",
        "VERIFY_SLICES",
        "FINALIZE",
      ],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("every emitted nextCommand parses to the same artifact binding", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    const state = await stateOf(fixture);
    const binding = {
      artifactType: state.artifactType,
      source: state.source,
      target: state.target,
    };
    assert.equal(state.nextCommand, artifactCommandFor(binding));
    const parsed = parseArtifactArguments(artifactArgumentsFor(binding));
    assert.equal(parsed.type, state.artifactType);
    assert.equal(parsed.source, state.source.path);
    assert.equal(parsed.target, state.target.path);
    assert.equal(parsed.sourceRoot, state.source.root);
    assert.equal(parsed.targetRoot, state.target.root);
    assert.equal(
      artifactIdFor({ source: parsed.source, type: parsed.type }),
      state.artifactId,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("checkpointArtifacts and progress artifacts agree at every checkpoint", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    const state = await stateOf(fixture);
    const progress = progressState(state);
    for (const step of Object.keys(progress.artifacts.steps)) {
      assert.deepEqual(
        progress.artifacts.steps[step],
        checkpointArtifacts({ ...state, currentStep: step }),
        step,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("valid TARGET_REUSE completes with evidence on the bound file", async () => {
  const fixture = await createFixture();
  try {
    await driveToComplete(fixture, "TARGET_REUSE");
    const done = await validateArtifactComplete(fixture.options);
    assert.equal(done.resolution, "TARGET_REUSE");
  } finally {
    await fixture.cleanup();
  }
});

test("forged TARGET_REUSE against an unrelated file is refused at ASSESS_TARGET", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    await advanceDiscovery(fixture);
    const evidence = await targetEvidence(fixture, "src/placeholder.ts");
    await writeJson(fixture.artifactRoot, "inventories/target.json", {
      version: 1,
      artifactId: fixture.id,
      resolution: "TARGET_REUSE",
      targetFiles: ["src/placeholder.ts"],
      targetNative: [
        { id: "TN-1", path: "src/placeholder.ts", description: "Unrelated file.", evidence: [evidence] },
      ],
      evidence: [{ behaviorId: "B-1", ...evidence }],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /must include the bound target 'src\/widget\.ts'/);
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("TARGET_REUSE evidence on a sibling file cannot stand in for the bound target", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    await advanceDiscovery(fixture);
    // The bound target is declared, so the membership check passes. Every
    // behavior is still proven against an unrelated file.
    const unrelated = await targetEvidence(fixture, "src/placeholder.ts");
    await writeJson(fixture.artifactRoot, "inventories/target.json", {
      version: 1,
      artifactId: fixture.id,
      resolution: "TARGET_REUSE",
      targetFiles: [fixture.options.target, "src/placeholder.ts"],
      targetNative: [
        { id: "TN-1", path: "src/placeholder.ts", description: "Unrelated file.", evidence: [unrelated] },
      ],
      evidence: [{ behaviorId: "B-1", ...unrelated }],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(
      refused.reason,
      /TARGET_REUSE behavior 'B-1' has no evidence on the bound target 'src\/widget\.ts'/,
    );
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");

    // The same document with the behavior proven on the bound target advances.
    const bound = await targetEvidence(fixture);
    await writeJson(fixture.artifactRoot, "inventories/target.json", {
      version: 1,
      artifactId: fixture.id,
      resolution: "TARGET_REUSE",
      targetFiles: [fixture.options.target, "src/placeholder.ts"],
      targetNative: [
        { id: "TN-1", path: fixture.options.target, description: "The bound target.", evidence: [bound] },
      ],
      evidence: [{ behaviorId: "B-1", ...bound }],
    });
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    assert.equal((await stateOf(fixture)).currentStep, "BUILD_BASELINE");
  } finally {
    await fixture.cleanup();
  }
});

test("a TARGET_NATIVE_EQUIVALENT unit naming no real targetNative row is refused", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    // Nonempty is all DISCOVERY_COMPLETENESS can check: target.json does not
    // exist yet. ASSESS_TARGET is where the id becomes decidable.
    await advanceDiscovery(fixture, {
      units: censusUnits({
        "widget/theme.css": { disposition: "TARGET_NATIVE_EQUIVALENT", ref: "TN-FAKE" },
      }),
    });
    await writeJson(
      fixture.artifactRoot,
      "inventories/target.json",
      await targetInventory(fixture, "TARGET_EXTEND"),
    );
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(
      refused.reason,
      /names target-native 'TN-FAKE', which is not a declared targetNative row/,
    );
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }

  // 'TN-1' is a real row in the target inventory, so the same claim settles.
  // completeness.json is pinned once DISCOVERY_COMPLETENESS completes, so this
  // half needs its own record rather than a rewrite.
  const honest = await createFixture();
  try {
    await bootstrap(honest);
    await advanceDiscovery(honest, {
      units: censusUnits({
        "widget/theme.css": { disposition: "TARGET_NATIVE_EQUIVALENT", ref: "TN-1" },
      }),
    });
    await writeJson(
      honest.artifactRoot,
      "inventories/target.json",
      await targetInventory(honest, "TARGET_EXTEND"),
    );
    assert.equal((await runArtifact(honest.options)).outcome, "CONTINUE");
    assert.equal((await stateOf(honest)).currentStep, "BUILD_BASELINE");
  } finally {
    await honest.cleanup();
  }
});

test("the Playwright gate cannot be downgraded: visible UI with no runtime evidence is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT"]);
    const refused = await runVerification(fixture, []);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /TARGET runtime coverage/);
    assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("an invented runtime state is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT"]);
    const refused = await runVerification(fixture, [
      await uiRecord(fixture, { origin: "TARGET", state: "NONSENSE", key: "t-default" }),
    ]);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /is not supported/);
  } finally {
    await fixture.cleanup();
  }
});

test("a state the behavior does not declare is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT"]);
    const refused = await runVerification(fixture, [
      await uiRecord(fixture, { origin: "TARGET", state: "EMPTY", key: "t-empty" }),
    ]);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /is not declared by behavior 'B-1'/);
  } finally {
    await fixture.cleanup();
  }
});

test("a missing required TARGET state is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT", "EMPTY"]);
    const refused = await runVerification(fixture, [
      await uiRecord(fixture, { origin: "TARGET", state: "DEFAULT", key: "t-default" }),
    ]);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /TARGET runtime coverage/);
  } finally {
    await fixture.cleanup();
  }
});

test("a missing origin is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT"]);
    const record = await uiRecord(fixture, { origin: "TARGET", state: "DEFAULT", key: "t-default" });
    delete record.origin;
    const refused = await runVerification(fixture, [record]);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /missing key\(s\): origin/);
  } finally {
    await fixture.cleanup();
  }
});

test("identical captures across origins and across distinct declared states are legal", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT", "EMPTY"]);
    const image = [137, 80, 78, 71, 13, 10, 26, 10];
    const accepted = await runVerification(fixture, [
      await uiRecord(fixture, { origin: "LEGACY", state: "DEFAULT", key: "l-default", screenshotBytes: image }),
      await uiRecord(fixture, { origin: "TARGET", state: "DEFAULT", key: "t-default", screenshotBytes: image }),
      await uiRecord(fixture, { origin: "TARGET", state: "EMPTY", key: "t-empty", screenshotBytes: image }),
    ]);
    assert.equal(accepted.outcome, "CONTINUE", accepted.reason);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");
  } finally {
    await fixture.cleanup();
  }
});

test("a logical evidence slot cannot be captured twice", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT"]);
    const refused = await runVerification(fixture, [
      await uiRecord(fixture, { origin: "TARGET", state: "DEFAULT", key: "t-default-a" }),
      await uiRecord(fixture, { origin: "TARGET", state: "DEFAULT", key: "t-default-b" }),
    ]);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /logical slot 'TARGET::B-1::DEFAULT' is captured more than once/);
  } finally {
    await fixture.cleanup();
  }
});

test("a capture file reused across logical slots is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveUiToVerify(fixture, ["DEFAULT", "EMPTY"]);
    const shared = await uiRecord(fixture, { origin: "TARGET", state: "DEFAULT", key: "shared" });
    const reuse = await uiRecord(fixture, { origin: "TARGET", state: "EMPTY", key: "other" });
    reuse.artifacts = shared.artifacts;
    const refused = await runVerification(fixture, [shared, reuse]);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /reused across logical observations/);
  } finally {
    await fixture.cleanup();
  }
});

test("a global contract cannot be reduced to its first consumer's behavior", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      path.join(fixture.sourceRoot, "widget/tokens.ts"),
      [
        "export const tokens = createTheme({",
        "  palette: { mode: 'light' },",
        "  components: { MuiDrawer: {}, MuiDataGrid: {} },",
        "});",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["add", "-A"], { cwd: fixture.root });
    await execFileAsync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "-m", "tokens"],
      { cwd: fixture.root },
    );
    await bootstrap(fixture);
    const state = await stateOf(fixture);
    const sourceFiles = state.bindings.source.entries
      .filter((entry) => entry.kind === "FILE")
      .map((entry) => entry.path);
    await writeJson(fixture.artifactRoot, "inventories/source.json", {
      version: 1,
      artifactId: fixture.id,
      hasVisibleUi: false,
      sourceFiles,
      behaviors: [
        { id: "B-1", description: "Theme retains behavior.", visible: false, evidence: [await sourceEvidence(fixture)] },
      ],
      globalContracts: [
        { id: "GC-1", kind: "GLOBAL_THEME", sourcePath: "widget/tokens.ts", consumers: ["widget/consumer-a.ts"] },
      ],
      featureLocalVisuals: [],
      operatorDecisions: [],
    });
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles,
      units: [{ path: "tokens.palette", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" }],
      requirements: [],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /discovery completeness\.units/);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
  } finally {
    await fixture.cleanup();
  }
});

// Regression A: /migrate-artifact cannot return "nothing to migrate" without
// creating/resuming artifact state and reaching engine-controlled checkpoints.
test("runArtifact always enters the engine and never returns a provider short-circuit", async () => {
  const fixture = await createFixture();
  try {
    const result = await runArtifact(fixture.options);
    assert.equal(result.outcome, "CONTINUE");
    const state = await stateOf(fixture);
    assert.equal(state.currentStep, "DISCOVER_LEGACY");
    assert.ok(state.completedSteps.includes("RESOLVE"));
    assert.ok(state.pendingSteps.includes("DISCOVERY_COMPLETENESS"));
  } finally {
    await fixture.cleanup();
  }
});

// Regression B: a generic createTheme-style exported object with nested
// `components` produces its bounded structural units.
test("structuralUnits discovers components from createTheme(arrowFn({...}))", async () => {
  const parser = (() => {
    try {
      return createRequire(import.meta.url)("ts-discovery-compiler");
    } catch {
      return null;
    }
  })();
  if (!parser) return;
  const source = [
    "import { createTheme } from '@mui/material/styles';",
    "const getDesignTokens = (mode) => ({",
    "  palette: { mode },",
    "  components: {",
    "    MuiDrawer: { styleOverrides: { root: {} } },",
    "    MuiList: { styleOverrides: { root: {} } },",
    "    MuiChip: { styleOverrides: { root: {} } },",
    "    MuiDataGrid: { styleOverrides: { root: {} } },",
    "    MuiTablePagination: { styleOverrides: { actions: {} } },",
    "  },",
    "});",
    "export const createAppTheme = (dark) => createTheme(getDesignTokens(dark ? 'dark' : 'light'));",
    "",
  ].join("\n");
  const units = structuralUnits(parser, "theme.ts", source);
  const paths = units.map((u) => u.path);
  assert.ok(paths.includes("createAppTheme"), `expected createAppTheme in ${paths}`);
  assert.ok(paths.includes("createAppTheme.palette"), `expected palette in ${paths}`);
  assert.ok(paths.includes("createAppTheme.components"), `expected components in ${paths}`);
  assert.ok(paths.includes("createAppTheme.components.MuiDrawer"), `expected MuiDrawer in ${paths}`);
  assert.ok(paths.includes("createAppTheme.components.MuiList"), `expected MuiList in ${paths}`);
  assert.ok(paths.includes("createAppTheme.components.MuiChip"), `expected MuiChip in ${paths}`);
  assert.ok(paths.includes("createAppTheme.components.MuiDataGrid"), `expected MuiDataGrid in ${paths}`);
  assert.ok(paths.includes("createAppTheme.components.MuiTablePagination"), `expected MuiTablePagination in ${paths}`);
});

// Regression B2: ConditionalExpression — both branches must be discovered,
// not only the first resolved one.
test("structuralUnits discovers components from both ternary branches", async () => {
  const parser = (() => {
    try {
      return createRequire(import.meta.url)("ts-discovery-compiler");
    } catch {
      return null;
    }
  })();
  if (!parser) return;
  const source = [
    "const config = isDark",
    "  ? { components: { MuiDrawer: { styleOverrides: {} } } }",
    "  : { components: { MuiDataGrid: { styleOverrides: {} } } };",
    "export default config;",
    "",
  ].join("\n");
  const units = structuralUnits(parser, "config.ts", source);
  const paths = units.map((u) => u.path);
  assert.ok(paths.includes("config"), `expected config in ${paths}`);
  assert.ok(paths.includes("config.components"), `expected config.components in ${paths}`);
  assert.ok(paths.includes("config.components.MuiDrawer"), `expected MuiDrawer in ${paths}`);
  assert.ok(paths.includes("config.components.MuiDataGrid"), `expected MuiDataGrid in ${paths}`);
});

// Regression C: missing dispositions for discovered structural units prevent
// DISCOVERY_COMPLETENESS / FINALIZE.
test("completeness with an undeclared structural unit is refused", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      path.join(fixture.sourceRoot, "widget/tokens.ts"),
      [
        "export const tokens = {",
        "  components: { MuiDrawer: {}, MuiList: {} },",
        "};",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["add", "-A"], { cwd: fixture.root });
    await execFileAsync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "-m", "tokens"],
      { cwd: fixture.root },
    );
    await bootstrap(fixture);
    const state = await stateOf(fixture);
    const sourceFiles = state.bindings.source.entries
      .filter((entry) => entry.kind === "FILE")
      .map((entry) => entry.path);
    await writeJson(fixture.artifactRoot, "inventories/source.json", {
      version: 1,
      artifactId: fixture.id,
      hasVisibleUi: false,
      sourceFiles,
      behaviors: [
        { id: "B-1", description: "Theme retains behavior.", visible: false, evidence: [await sourceEvidence(fixture)] },
      ],
      globalContracts: [
        { id: "GC-1", kind: "GLOBAL_THEME", sourcePath: "widget/tokens.ts", consumers: ["widget/consumer-a.ts"] },
      ],
      featureLocalVisuals: [],
      operatorDecisions: [],
    });
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
    // Only declare MuiDrawer, omit MuiList — completeness must refuse.
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles,
      units: [
        { path: "tokens", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" },
        { path: "tokens.components", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" },
        { path: "tokens.components.MuiDrawer", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" },
      ],
      requirements: [],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /discovery completeness\.units/);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
  } finally {
    await fixture.cleanup();
  }
});

// Regression D: target comments such as "port later with each slice" cannot
// by themselves prove TARGET_REUSE/TARGET_EXTEND.
test("target comments alone cannot prove resolution at ASSESS_TARGET", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    await advanceDiscovery(fixture);
    // Write a target inventory with resolution claim but no real evidence.
    await writeJson(fixture.artifactRoot, "inventories/target.json", {
      version: 1,
      artifactId: fixture.id,
      resolution: "TARGET_REUSE",
      targetFiles: [fixture.options.target],
      targetNative: [
        {
          id: "TN-1",
          path: fixture.options.target,
          description: "Existing target with a comment saying port later.",
          evidence: [],
        },
      ],
      evidence: [],
    });
    const result = await runArtifact(fixture.options);
    // Must NOT advance — evidence is required, a comment is not evidence.
    assert.equal(result.outcome, "CONTINUE");
    assert.ok(
      result.reason.includes("evidence") || result.reason.includes("TARGET_REUSE"),
      `expected evidence-related refusal, got: ${result.reason}`,
    );
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// Regression E: design-system reached COMPLETE with 27/27 VERIFIED and all
// gates PASS while theme.ts had three TypeScript errors caused by a missing
// @mui/x-data-grid dependency. IMPLEMENT_SLICES that change executable code
// without an applicable executed code check must be blocked.
test("code-changing IMPLEMENT_SLICES without a validation check is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const theme = 'design-system';\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        {
          path: fixture.options.target,
          sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
        },
      ],
      checks: [{ command: "echo all checks pass", status: "PASS" }],
      preservedTargetNativeIds: ["TN-1"],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");

    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        {
          path: fixture.options.target,
          sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
        },
      ],
      checks: [typescriptCheck()],
      preservedTargetNativeIds: ["TN-1"],
    });
    const accepted = await runArtifact(fixture.options);
    assert.equal(accepted.outcome, "CONTINUE", accepted.reason);
    assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("non-code IMPLEMENT_SLICES without a validation check is allowed", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    const mdPath = "src/readme.md";
    await writeFile(path.join(fixture.targetRoot, mdPath), "# Docs\n");
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [{ path: mdPath, sha256: await digest(path.join(fixture.targetRoot, mdPath)) }],
      checks: [{ command: "cat src/readme.md", status: "PASS" }],
      preservedTargetNativeIds: ["TN-1"],
    });
    const accepted = await runArtifact(fixture.options);
    assert.equal(accepted.outcome, "CONTINUE", accepted.reason);
    assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Regression F: echo/printf/cat commands that contain validation keywords
// must not pass the code-validation gate.
test("echo tsc passed is refused as a fake validation command", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const x = 1;\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [{ command: "echo tsc passed", status: "PASS" }],
      preservedTargetNativeIds: ["TN-1"],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Regression G: an explicitly failed validation command must block advancement.
test("a check with status FAIL is refused even if the command is valid", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const x = 1;\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [typescriptCheck("FAIL")],
      preservedTargetNativeIds: ["TN-1"],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /did not PASS/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("a validation command that actually fails is refused despite claimed PASS", async () => {
  const fixture = await createFixture();
  try {
    fixture.options.target = "src/widget.js";
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(path.join(fixture.targetRoot, fixture.options.target), "function {\n");
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [nodeCheck("src/widget.js")],
      preservedTargetNativeIds: ["TN-1"],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Regression H: a command targeting a file not in changedFiles is unrelated
// and must not satisfy the gate.
test("node --check targeting an unrelated file is refused", async () => {
  const fixture = await createFixture();
  try {
    fixture.options.target = "src/widget.js";
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const x = 1;\n",
    );
    await writeFile(path.join(fixture.targetRoot, "src/unrelated.js"), "export {};\n");
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [nodeCheck("src/unrelated.js")],
      preservedTargetNativeIds: ["TN-1"],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Regression I: formatting-only prettier commands must not satisfy the gate.
test("prettier --check is refused as a formatting-only command", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const x = 1;\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [{ command: "prettier --check src/widget.ts", status: "PASS" }],
      preservedTargetNativeIds: ["TN-1"],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Regression J: node --check on a changed JS file must remain accepted.
test("node --check on a changed JS file is accepted", async () => {
  const fixture = await createFixture();
  try {
    fixture.options.target = "src/widget.js";
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const x = 1;\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [nodeCheck("src/widget.js")],
      preservedTargetNativeIds: ["TN-1"],
    });
    const accepted = await runArtifact(fixture.options);
    assert.equal(accepted.outcome, "CONTINUE", accepted.reason);
    assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Regression K: the real design-system false-COMPLETE shape. A project-wide
// tsc command recorded as PASS must still execute and catch a missing module
// diagnostic in the changed theme artifact.
test("design-system missing-dependency false-COMPLETE is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    // Simulate theme.ts importing the missing @mui/x-data-grid dependency.
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "import type { GridColDef } from '@mui/x-data-grid';\nexport const columns: GridColDef[] = [];\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [typescriptCheck()],
      preservedTargetNativeIds: ["TN-1"],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Regression L: changed-artifact diagnostics vs unrelated pre-existing
// diagnostics. A project-wide tsc failure is tolerated only when every
// diagnostic names a file outside changedFiles.
test("project-wide validator with errors in unrelated files is accepted", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const widget = 'clean';\n",
    );
    // A project-wide tsc result may fail globally while still proving the
    // changed artifact clean when every emitted diagnostic is unrelated.
    await writeFile(
      path.join(fixture.targetRoot, "src/unrelated-bad.ts"),
      "import { Missing } from '@nonexistent';\nexport const x: Missing = {};\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
      ],
      checks: [typescriptCheck()],
      preservedTargetNativeIds: ["TN-1"],
    });
    const accepted = await runArtifact(fixture.options);
    assert.equal(accepted.outcome, "CONTINUE", accepted.reason);
    assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

const authorValidCodeChange = async (fixture, checks) => {
  await driveToBuild(fixture, "TARGET_EXTEND");
  await advanceBaseline(fixture, "TARGET_EXTEND");
  await advancePlan(fixture, "TARGET_EXTEND");
  await writeFile(path.join(fixture.targetRoot, fixture.options.target), "export const widget = 'changed';\n");
  await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
    version: 1,
    sliceId: "slice-1",
    status: "COMPLETE",
    changedFiles: [
      { path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) },
    ],
    checks,
    preservedTargetNativeIds: ["TN-1"],
  });
};

test("a no-op TypeScript command cannot claim validator coverage", async () => {
  const fixture = await createFixture();
  try {
    await authorValidCodeChange(fixture, [{ command: "tsc --showConfig", status: "PASS" }]);
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("a TypeScript project does not cover an excluded changed file", async () => {
  const fixture = await createFixture();
  try {
    await authorValidCodeChange(fixture, [typescriptCheck()]);
    await writeFile(
      path.join(fixture.targetRoot, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { noEmit: true }, files: ["src/placeholder.ts"] }, null, 2)}\n`,
    );
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("a no-op package script cannot claim validator coverage", async () => {
  const fixture = await createFixture();
  try {
    await authorValidCodeChange(fixture, [{ command: "pnpm typecheck", status: "PASS" }]);
    await writeFile(
      path.join(fixture.targetRoot, "package.json"),
      `${JSON.stringify({ scripts: { typecheck: "echo tsc passed" } }, null, 2)}\n`,
    );
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /trusted validator evidence/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("finalization reports shared imports that resolve transitively into the legacy tree", async () => {
  const fixture = await createFixture();
  try {
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await advanceImplementation(fixture, "TARGET_EXTEND");
    await advanceVerification(fixture, { ui: false });
    await writeBaseline(fixture, "TARGET_EXTEND", { final: true });

    await mkdir(path.join(fixture.sourceRoot, "shared"), { recursive: true });
    await mkdir(path.join(fixture.targetRoot, "src/shared/components/barrel"), { recursive: true });
    await writeFile(
      path.join(fixture.sourceRoot, "shared/legacy-button.tsx"),
      "export const LegacyButton = () => null;\n",
    );
    await writeFile(
      path.join(fixture.targetRoot, "src/shared/components/barrel/index.ts"),
      "export { LegacyButton } from '@legacy/shared/legacy-button';\n",
    );
    await writeFile(
      path.join(fixture.targetRoot, "src/shared/components/form.tsx"),
      "export { LegacyButton } from './barrel';\n",
    );
    await writeFile(
      path.join(fixture.targetRoot, "src/shared/components/direct.tsx"),
      "import { LegacyButton } from '../../../../legacy/shared/legacy-button';\nexport { LegacyButton };\n",
    );
    await writeFile(
      path.join(fixture.targetRoot, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", module: "ESNext", moduleResolution: "Bundler", noEmit: true, paths: { "@legacy/*": ["../legacy/*"] } }, include: ["src/**/*.ts", "src/**/*.tsx"] }, null, 2)}\n`,
    );

    const { findings } = await legacyDependencies(fixture.targetRoot, fixture.sourceRoot);
    assert.ok(findings.some((finding) => finding.file === "src/shared/components/direct.tsx"));
    assert.ok(findings.some((finding) => finding.file === "src/shared/components/form.tsx"));
    assert.ok(findings.some((finding) => finding.chain.length === 2));

    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /src\/shared\/components\/form\.tsx -> shared\/legacy-button\.tsx/);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Audit 2026-08-28 regressions. Each test below is the executable proof named
// in that audit's "Distance to 10/10" table.
// ---------------------------------------------------------------------------

const commitAll = (fixture, message) =>
  execFileAsync("git", ["add", "-A"], { cwd: fixture.root }).then(() =>
    execFileAsync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "-m", message],
      { cwd: fixture.root },
    ),
  );

// Builds the audit's §4 reference differential in the fixture: the artifact
// requires one code file and one stylesheet from outside its own boundary.
const withOutOfBoundaryRequirements = async (fixture) => {
  await mkdir(path.join(fixture.sourceRoot, "shared"), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, "shared/format.ts"), "export const fmt = (value) => value;\n");
  await writeFile(path.join(fixture.sourceRoot, "shared/badge.css"), ".badge { color: blue; }\n");
  await writeFile(
    path.join(fixture.sourceRoot, "widget/badge.ts"),
    "import { fmt } from '../shared/format';\nimport '../shared/badge.css';\nexport const badge = () => fmt('x');\n",
  );
  await commitAll(fixture, "out-of-boundary requirements");
};

const BADGE_CENSUS = [
  "widget/badge.ts#badge",
  "widget/consumer-a.ts#a",
  "widget/consumer-b.ts#b",
  "widget/local.css",
  "widget/source.ts#source",
  "widget/theme.css",
];

// Audit F-1/F-3, proof 1: a transitive code requirement and a non-code
// requirement outside the bound path used to be *inexpressible*, so both were
// dropped while the workflow reported COMPLETE. Now the requirement graph is
// traversed and neither can pass without a disposition.
test("out-of-boundary code and non-code requirements cannot be silently dropped", async () => {
  const fixture = await createFixture();
  try {
    await withOutOfBoundaryRequirements(fixture);
    await bootstrap(fixture);
    const source = await authorSource(fixture);
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    const units = BADGE_CENSUS.map((unitPath) => ({
      path: unitPath,
      disposition: "MIGRATED_BEHAVIOR",
      ref: "B-1",
    }));
    // Exactly what the audited engine accepted: a complete census, and not one
    // word about what the artifact reaches into.
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      units,
      requirements: [],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /discovery completeness\.requirements/);
    assert.match(refused.reason, /shared\/format\.ts/);
    assert.match(refused.reason, /shared\/badge\.css/);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    // Dropping only the stylesheet is still a drop.
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      units,
      requirements: [{ element: "shared/format.ts", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" }],
    });
    const partial = await runArtifact(fixture.options);
    assert.equal(partial.outcome, "CONTINUE");
    assert.match(partial.reason, /shared\/badge\.css/);

    // Disposing both advances; nothing was lost and nothing was invented.
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      units,
      requirements: [
        { element: "shared/badge.css", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" },
        { element: "shared/format.ts", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" },
      ],
    });
    const advanced = await runArtifact(fixture.options);
    assert.equal(advanced.outcome, "CONTINUE", advanced.reason);
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F-2, proof 2: the census used to disable itself whenever the authoring
// agent declared no global contracts, and `units` was then not even an accepted
// key. It is unconditional now, and it censuses the artifact's own files.
test("the structural census is unconditional and covers the artifact's own files", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    // No global contracts at all: the audited engine skipped the whole census.
    const source = { ...(await sourceInventory(fixture)), globalContracts: [] };
    await writeJson(fixture.artifactRoot, "inventories/source.json", source);
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      requirements: [],
    });
    const missing = await runArtifact(fixture.options);
    assert.equal(missing.outcome, "CONTINUE");
    assert.match(missing.reason, /missing key\(s\): units/);

    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      units: [{ path: "widget/source.ts#source", disposition: "MIGRATED_BEHAVIOR", ref: "B-1" }],
      requirements: [],
    });
    const partial = await runArtifact(fixture.options);
    assert.equal(partial.outcome, "CONTINUE");
    assert.match(partial.reason, /discovery completeness\.units/);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F-4, proof 3: all seven canonical gates were satisfiable by one
// unrelated pre-existing file, because gate evidence was a bare hash with no
// relation to the migration.
test("final gate evidence citing an unrelated file is refused", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await driveToBuild(fixture, resolution);
    await advanceBaseline(fixture, resolution);
    await advancePlan(fixture, resolution);
    await advanceImplementation(fixture, resolution);
    await advanceVerification(fixture, { ui: false });
    await writeBaseline(fixture, resolution, { final: true });

    const state = await stateOf(fixture);
    await writeFile(path.join(fixture.targetRoot, "src/unrelated.ts"), "export const unrelated = 1;\n");
    const forged = {
      path: "src/unrelated.ts",
      sha256: await digest(path.join(fixture.targetRoot, "src/unrelated.ts")),
      boundTo: {
        sourceDigest: state.bindings.source.digest,
        targetDigest: state.bindings.target.digest,
      },
    };
    await writeJson(fixture.artifactRoot, "gates.json", {
      version: 1,
      gates: FINAL_GATES.map((name) => ({ name, status: "PASS", evidence: [forged] })),
      uiEvidence: [],
      requirementEvidence: [],
    });
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /src\/unrelated\.ts.*not one of this migration/s);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");

    // The migration's own changed file is accepted, so the gate is bound rather
    // than merely stricter.
    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));
    assert.equal((await runArtifact(fixture.options)).outcome, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F-4 / MR-2 / MR-3, proof 4: the gates named after the repository's
// mandatory architecture rules now assert those rules against the files this
// migration changed.
test("ARCHITECTURE_IMPLEMENTATION_GATE and PRECOMMIT_GATE assert the mandatory rules", async () => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "artifact-architecture-"));
  try {
    await mkdir(path.join(targetRoot, "src/features/orders/components"), { recursive: true });
    await mkdir(path.join(targetRoot, "src/features/billing/domain"), { recursive: true });
    await writeFile(path.join(targetRoot, "src/features/billing/domain/invoice.ts"), "export const invoice = 1;\n");
    await writeFile(
      path.join(targetRoot, "src/features/orders/components/list.tsx"),
      [
        "import { invoice } from '../../billing/domain/invoice';",
        "export const List = () => <div title=\"Pedidos\">Listado de pedidos{invoice}</div>;",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(targetRoot, "src/features/orders/orders.query-keys.ts"), "export const keys = [];\n");
    await writeFile(path.join(targetRoot, "src/features/orders/components/list.test.ts"), "export const t = 1;\n");
    await writeFile(
      path.join(targetRoot, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*"] }, null, 2)}\n`,
    );

    const changed = [
      "src/features/orders/components/list.tsx",
      "src/features/orders/components/list.test.ts",
      "src/features/orders/orders.query-keys.ts",
    ];
    const { implementation, precommit } = await architectureFindings(targetRoot, changed);
    // MR-2: the touched feature has neither layer.
    assert.ok(implementation.some((row) => /orders\/domain\/ layer \(MR-2\)/.test(row)));
    assert.ok(implementation.some((row) => /orders\/application\/ layer \(MR-2\)/.test(row)));
    // MR-4: the query keys are not at the canonical path.
    assert.ok(implementation.some((row) => /MR-4/.test(row)));
    // MR-7: a deep import into another feature's internals.
    assert.ok(implementation.some((row) => /deep into feature 'billing'.*MR-7/.test(row)));
    // MR-3: hardcoded visible text, both as a JSX child and as a title prop.
    assert.ok(precommit.some((row) => row.includes("Listado de pedidos") && row.includes("MR-3")));
    assert.ok(precommit.some((row) => /title=.*Pedidos/.test(row) && row.includes("MR-3")));
    // MR-6: a test co-located under src/.
    assert.ok(precommit.some((row) => /MR-6/.test(row)));

    // A compliant change produces nothing.
    await mkdir(path.join(targetRoot, "src/features/orders/domain"), { recursive: true });
    await mkdir(path.join(targetRoot, "src/features/orders/application"), { recursive: true });
    await mkdir(path.join(targetRoot, "src/features/orders/infrastructure"), { recursive: true });
    await writeFile(
      path.join(targetRoot, "src/features/orders/infrastructure/orders.query-keys.ts"),
      "export const keys = [];\n",
    );
    await writeFile(
      path.join(targetRoot, "src/features/orders/components/clean.tsx"),
      "export const Clean = ({ t }) => <div>{t('orders.title')}</div>;\n",
    );
    const clean = await architectureFindings(targetRoot, [
      "src/features/orders/components/clean.tsx",
      "src/features/orders/infrastructure/orders.query-keys.ts",
    ]);
    assert.deepEqual(clean, { implementation: [], precommit: [] });
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

// Audit F-4, proof 4 end to end: a gate whose rule is violated cannot PASS,
// even with correctly bound evidence.
test("a violated architecture rule fails its own gate at FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await driveToBuild(fixture, resolution);
    await advanceBaseline(fixture, resolution);
    await advancePlan(fixture, resolution);
    // The slice writes into a feature that has neither of the two mandated
    // layers, which MR-2 forbids.
    const changedPath = "src/features/orders/components/list.ts";
    await mkdir(path.join(fixture.targetRoot, "src/features/orders/components"), { recursive: true });
    await writeFile(path.join(fixture.targetRoot, changedPath), "export const list = [];\n");
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const widget = 'TARGET_EXTEND';\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        {
          path: fixture.options.target,
          sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
        },
        { path: changedPath, sha256: await digest(path.join(fixture.targetRoot, changedPath)) },
      ],
      checks: [typescriptCheck()],
      preservedTargetNativeIds: ["TN-1"],
    });
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    await advanceVerification(fixture, { ui: false });
    await writeBaseline(fixture, resolution, { final: true });
    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));

    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /ARCHITECTURE_IMPLEMENTATION_GATE' cannot PASS.*MR-2/s);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F-6, proof 5: one catch converted every engine fault into "not authored
// yet", so a corrupt target tsconfig produced `CONTINUE` and an automated
// driver looped forever.
test("an engine fault is BLOCKED and stops the loop, not CONTINUE", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await driveToBuild(fixture, resolution);
    await advanceBaseline(fixture, resolution);
    await advancePlan(fixture, resolution);
    await advanceImplementation(fixture, resolution);
    await advanceVerification(fixture, { ui: false });
    await writeBaseline(fixture, resolution, { final: true });
    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));
    await writeFile(path.join(fixture.targetRoot, "tsconfig.json"), "{ not json at all\n");

    const blocked = await runArtifact(fixture.options);
    assert.equal(blocked.outcome, "BLOCKED");
    assert.match(blocked.reason, /Cannot load the target TypeScript project/);
    const status = await getArtifactStatus(fixture.options);
    assert.equal(status.outcome, "BLOCKED");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "run-artifact.mjs"),
        ...artifactArgumentsFor({
          artifactType: fixture.options.type,
          source: { root: fixture.sourceRoot, path: fixture.options.source },
          target: { root: fixture.targetRoot, path: fixture.options.target },
        }),
      ],
      { cwd: fixture.targetRoot },
    ).catch((error) => ({ stdout: error.stdout ?? "" }));
    assert.match(stdout, /loop: STOP reason=BLOCKED/);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F-7, proof 6: the legacy-dependency gate had 1/8 recall. It was pinned
// to `src/shared`, to static top-level imports, to tsconfig-included files, and
// returned nothing at all under the SKILL's own default single-root invocation.
test("the legacy-dependency gate reaches every target root, import form, and root layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-legacy-"));
  try {
    const sourceRoot = path.join(root, "legacy");
    const targetRoot = path.join(root, "target");
    await mkdir(path.join(sourceRoot, "legacy-widget"), { recursive: true });
    await writeFile(path.join(sourceRoot, "legacy-widget/button.ts"), "export const Button = 1;\n");
    for (const directory of ["src/shared", "src/features/orders", "src/app", "src/infrastructure", "src/excluded"]) {
      await mkdir(path.join(targetRoot, directory), { recursive: true });
    }
    // An alias keeps every probe's specifier identical regardless of depth.
    const tsconfig = {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        allowJs: true,
        paths: { "@legacy/*": ["../legacy/*"] },
      },
      include: ["src/shared/**/*", "src/features/**/*", "src/app/**/*", "src/infrastructure/**/*"],
    };
    await writeFile(path.join(targetRoot, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
    const legacyImport = "'@legacy/legacy-widget/button'";
    await Promise.all([
      // probes 1-3: every target source root, not just src/shared
      writeFile(path.join(targetRoot, "src/shared/static.ts"), `export { Button } from ${legacyImport};\n`),
      writeFile(path.join(targetRoot, "src/features/orders/static.ts"), `export { Button } from ${legacyImport};\n`),
      writeFile(path.join(targetRoot, "src/app/static.ts"), `export { Button } from ${legacyImport};\n`),
      writeFile(path.join(targetRoot, "src/infrastructure/static.ts"), `export { Button } from ${legacyImport};\n`),
      // probes 5-6: dynamic import() and require()
      writeFile(path.join(targetRoot, "src/shared/dynamic.ts"), `export const load = () => import(${legacyImport});\n`),
      writeFile(path.join(targetRoot, "src/shared/required.ts"), `export const Button = require(${legacyImport});\n`),
      // probe 7: a file the tsconfig does not include still ships, and still leaks
      writeFile(path.join(targetRoot, "src/excluded/static.ts"), `export { Button } from ${legacyImport};\n`),
    ]);

    const separateRoots = await legacyDependencies(targetRoot, sourceRoot);
    const leaking = new Set(separateRoots.findings.map((finding) => finding.file));
    for (const file of [
      "src/shared/static.ts",
      "src/features/orders/static.ts",
      "src/app/static.ts",
      "src/infrastructure/static.ts",
      "src/shared/dynamic.ts",
      "src/shared/required.ts",
      "src/excluded/static.ts",
    ]) {
      assert.ok(leaking.has(file), `expected a finding for ${file}`);
    }
    // probe 8: no src/shared directory present at all, and the gate still works
    await rm(path.join(targetRoot, "src/shared"), { recursive: true, force: true });
    const withoutShared = await legacyDependencies(targetRoot, sourceRoot);
    assert.ok(withoutShared.findings.some((finding) => finding.file === "src/app/static.ts"));

    // probe 4: sourceRoot === targetRoot, the SKILL's documented default. The
    // legacy scope is the artifact's own bound paths, so this is decidable.
    const inPlace = path.join(root, "inplace");
    await mkdir(path.join(inPlace, "src/legacy-widget"), { recursive: true });
    await mkdir(path.join(inPlace, "src/features/orders"), { recursive: true });
    await writeFile(path.join(inPlace, "src/legacy-widget/button.ts"), "export const Button = 1;\n");
    await writeFile(
      path.join(inPlace, "src/features/orders/list.ts"),
      "export { Button } from '../../legacy-widget/button';\n",
    );
    await writeFile(
      path.join(inPlace, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*"] }, null, 2)}\n`,
    );
    const single = await legacyDependencies(inPlace, inPlace, ["src/legacy-widget"]);
    assert.deepEqual(
      single.findings.map((finding) => `${finding.file} -> ${finding.legacyPath}`),
      ["src/features/orders/list.ts -> src/legacy-widget/button.ts"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Audit fixture P: an unresolvable dynamic reference in a changed file used to
// be invisible; the contract requires it to be blocked or surfaced.
test("an undecidable dynamic reference in a changed file is surfaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-undecidable-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/loader.ts"),
      "const part = 'a';\nexport const load = () => import(`./parts/${part}`);\n",
    );
    await writeFile(
      path.join(root, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*"] }, null, 2)}\n`,
    );
    const { undecidable } = await legacyDependencies(root, root, ["src/legacy-widget"], {
      changedFiles: ["src/loader.ts"],
    });
    assert.equal(undecidable.length, 1);
    assert.equal(undecidable[0].file, "src/loader.ts");
    assert.match(undecidable[0].expression, /import\(/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Audit F-11, proof 7: `--status` -- which SKILL.md mandates running first --
// reported an orphan transaction as ACTIVE / "recovered automatically", while
// the next run threw.
test("an orphan transaction reports BLOCKED from --status and from run alike", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    const state = await stateOf(fixture);
    const orphan = {
      version: 1,
      state,
      event: {
        seq: 99,
        at: state.updatedAt,
        event: "ADVANCED",
        from: "DISCOVER_LEGACY",
        to: "DISCOVERY_COMPLETENESS",
        slice: null,
        revision: state.revision,
        prevDigest: null,
        digest: createHash("sha256").update("orphan").digest("hex"),
      },
    };
    await writeJson(fixture.artifactRoot, "transaction.json", orphan);
    const status = await getArtifactStatus(fixture.options);
    assert.equal(status.status, "BLOCKED");
    assert.equal(status.outcome, "BLOCKED");
    assert.match(status.reason, /cannot be appended in sequence/);
    // --status stays a pure structural check (unchanged): the event's position
    // is wrong regardless of any preimage, so it reports the same message as
    // before. `run` now attempts legacy (version 1) recovery first, and this
    // journal's `state` is byte-identical to the still-current state.json --
    // exactly the "no preimage survived" case P1 #4 fails closed on, with a
    // more actionable reason than a bare sequence-position mismatch.
    const run = await runArtifact(fixture.options);
    assert.equal(run.outcome, "BLOCKED");
    assert.match(run.reason, /no reconstructible predecessor/);
  } finally {
    await fixture.cleanup();
  }
});

// Audit MR-5: the design-system matrix carried `targetComponent` and
// `requiredComponent` as free strings validated only for non-emptiness, so
// "reuse the shared primitive before writing a new one" was unenforced.
test("shipping a component other than the required primitive needs a recorded exception", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await driveToBuild(fixture, resolution, { ui: true });
    const documents = await baselineDocuments(fixture, resolution);
    documents.design.rows[0].targetComponent = "HandRolledWidget";
    documents.design.rows[0].requiredComponent = "SharedDataTable";
    await Promise.all([
      writeJson(fixture.artifactRoot, "matrices/parity.json", documents.parity),
      writeJson(fixture.artifactRoot, "matrices/target-native.json", documents.native),
      writeJson(fixture.artifactRoot, "matrices/design-system.json", documents.design),
      writeJson(fixture.artifactRoot, "matrices/global-contract.json", documents.global),
    ]);
    const refused = await runArtifact(fixture.options);
    assert.equal(refused.outcome, "CONTINUE");
    assert.match(refused.reason, /ships 'HandRolledWidget' instead of the required 'SharedDataTable'/);
    assert.equal((await stateOf(fixture)).currentStep, "BUILD_BASELINE");
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2026-08-29 production-readiness audit remediation.
//
// The audited engine ran the shared discovery scanner and then threw part of
// its answer away: `sourceRequirements` projected only `supporting`,
// `unresolved` and `findings`, so a required external package, a runtime URL
// and the boundary support around them disappeared before the completeness
// gate could ask for a disposition. That one lossy projection produced the
// audit's fixture X: `requirements: []` advanced, verification reported
// `PASS`, and the migration reached `COMPLETE` with a required dependency
// silently missing.
// ---------------------------------------------------------------------------

// The audit's fixture X plus the non-code and runtime surface it could not
// reach: an external package, a shared module, a stylesheet, the asset that
// stylesheet loads, a JSON data file, a runtime URL, and an ancillary test file
// inside the bound artifact.
const EXTERNAL_REQUIREMENT = "EXTERNAL external-package";
const PRESERVED_REQUIREMENTS = [
  "RUNTIME_URL widget/source.ts:5 https://cdn.example.test/widget.js",
  "shared/badge.css",
  "shared/format.ts",
  "shared/icon.svg",
  "shared/settings.json",
];
const GRAPH_REQUIREMENTS = [EXTERNAL_REQUIREMENT, ...PRESERVED_REQUIREMENTS];
// The ancillary test file inside the bound artifact censuses like any other
// script: its exported binding, plus the re-exported shape the parser could not
// resolve. Both are structural units and neither is droppable.
const GRAPH_CENSUS = [
  ...FIXTURE_CENSUS,
  "widget/source.test.ts#t",
  "widget/source.test.ts#t.<unresolved>",
].sort();

const graphRequirementRows = (overrides = {}) =>
  GRAPH_REQUIREMENTS.map((element) => ({
    element,
    ...(element === EXTERNAL_REQUIREMENT
      ? { disposition: "EXTERNAL_DEPENDENCY", ref: "external-package" }
      : { disposition: "MIGRATED_BEHAVIOR", ref: "B-1" }),
    ...overrides[element],
  }));

const graphCensusUnits = () =>
  GRAPH_CENSUS.map((unitPath) => ({
    path: unitPath,
    disposition: "MIGRATED_BEHAVIOR",
    ref: "B-1",
  }));

const targetPackageJson = (fixture, extra = {}) =>
  writeFile(
    path.join(fixture.targetRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "target",
        version: "1.0.0",
        dependencies: { "external-package": "^1.0.0" },
        ...extra,
      },
      null,
      2,
    )}\n`,
  );

const withCompleteRequirementGraph = async (fixture, { declareExternal = true } = {}) => {
  await mkdir(path.join(fixture.sourceRoot, "shared"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(fixture.sourceRoot, "shared/format.ts"),
      "export const fmt = (value) => value;\n",
    ),
    writeFile(
      path.join(fixture.sourceRoot, "shared/badge.css"),
      ".badge { background: url('./icon.svg'); }\n",
    ),
    writeFile(path.join(fixture.sourceRoot, "shared/icon.svg"), "<svg></svg>\n"),
    writeFile(path.join(fixture.sourceRoot, "shared/settings.json"), '{ "locale": "es-ES" }\n'),
    // The runtime URL must stay on line 5: the requirement token carries it.
    writeFile(
      path.join(fixture.sourceRoot, "widget/source.ts"),
      [
        "import { x } from 'external-package';",
        "import { fmt } from '../shared/format';",
        "import '../shared/badge.css';",
        "import settings from '../shared/settings.json';",
        "const remote = new URL('https://cdn.example.test/widget.js');",
        "export const source = [x, fmt, settings, remote];",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(fixture.sourceRoot, "widget/source.test.ts"),
      "import { source } from './source';\nexport const t = source;\n",
    ),
  ]);
  if (declareExternal) await targetPackageJson(fixture);
  await commitAll(fixture, "complete requirement graph");
};

// Drives the requirement-graph fixture through DISCOVERY_COMPLETENESS.
const advanceGraphDiscovery = async (fixture, requirements = graphRequirementRows()) => {
  const source = await authorSource(fixture);
  assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
  await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
    version: 1,
    sourceFiles: source.sourceFiles,
    units: graphCensusUnits(),
    requirements,
  });
  return runArtifact(fixture.options);
};

// Audit F-01 / fixture X: reproduced exactly, and now stopped where the audit
// says it must stop -- at DISCOVERY_COMPLETENESS, by name.
test("a required external package holds DISCOVERY_COMPLETENESS instead of vanishing", async () => {
  const fixture = await createFixture();
  try {
    await withCompleteRequirementGraph(fixture);
    await bootstrap(fixture);

    // Exactly the document the audited engine accepted.
    const dropped = await advanceGraphDiscovery(fixture, []);
    assert.equal(dropped.outcome, "CONTINUE");
    assert.match(dropped.reason, /discovery completeness\.requirements/);
    assert.match(dropped.reason, /EXTERNAL external-package/);
    assert.match(dropped.reason, /RUNTIME_URL widget\/source\.ts:5/);
    assert.match(dropped.reason, /shared\/icon\.svg/);
    assert.match(dropped.reason, /shared\/settings\.json/);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    // The audit reproduced this through the CLI, so the CLI must hold too:
    // `CONTINUE` here means "author the missing dispositions", not "advance".
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "run-artifact.mjs"),
        ...artifactArgumentsFor({
          artifactType: fixture.options.type,
          source: { root: fixture.sourceRoot, path: fixture.options.source },
          target: { root: fixture.targetRoot, path: fixture.options.target },
        }),
      ],
      { cwd: fixture.targetRoot, encoding: "utf8" },
    ).catch((error) => ({ stdout: error.stdout ?? "" }));
    assert.match(stdout, /EXTERNAL external-package/);
    assert.match(stdout, /inventories\/completeness\.json/);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    // Every local element disposed, the external one still omitted: still held.
    const externalOnly = await advanceGraphDiscovery(
      fixture,
      graphRequirementRows().filter((row) => row.element !== EXTERNAL_REQUIREMENT),
    );
    assert.equal(externalOnly.outcome, "CONTINUE");
    assert.match(externalOnly.reason, /missing: EXTERNAL external-package/);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    // An external package is not something this artifact owns, so a disposition
    // that names an in-artifact row cannot settle it.
    const misfiled = await advanceGraphDiscovery(
      fixture,
      graphRequirementRows({
        [EXTERNAL_REQUIREMENT]: { disposition: "MIGRATED_BEHAVIOR", ref: "B-1" },
      }),
    );
    assert.equal(misfiled.outcome, "CONTINUE");
    assert.match(misfiled.reason, /is an external package/);

    // Naming the wrong package is refused too.
    const wrongPackage = await advanceGraphDiscovery(
      fixture,
      graphRequirementRows({
        [EXTERNAL_REQUIREMENT]: { disposition: "EXTERNAL_DEPENDENCY", ref: "other-package" },
      }),
    );
    assert.equal(wrongPackage.outcome, "CONTINUE");
    assert.match(wrongPackage.reason, /must name the required package 'external-package'/);

    const advanced = await advanceGraphDiscovery(fixture);
    assert.equal(advanced.outcome, "CONTINUE", advanced.reason);
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// EXTERNAL_DEPENDENCY is a claim about the target, so it is proved against the
// target's own manifest rather than believed.
test("EXTERNAL_DEPENDENCY is refused unless the target really declares the package", async () => {
  const fixture = await createFixture();
  try {
    await withCompleteRequirementGraph(fixture, { declareExternal: false });
    await bootstrap(fixture);

    const noManifest = await advanceGraphDiscovery(fixture);
    assert.equal(noManifest.outcome, "CONTINUE");
    assert.match(noManifest.reason, /no package\.json to prove it/);

    await targetPackageJson(fixture, { dependencies: { "other-package": "^1.0.0" } });
    const undeclared = await advanceGraphDiscovery(fixture);
    assert.equal(undeclared.outcome, "CONTINUE");
    assert.match(undeclared.reason, /declares no such dependency/);

    await targetPackageJson(fixture);
    const advanced = await advanceGraphDiscovery(fixture);
    assert.equal(advanced.outcome, "CONTINUE", advanced.reason);
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// Parity with the reference engine, asserted rather than assumed: the audit's
// root cause was the artifact projection quietly seeing less than the scanner.
test("the artifact requirement projection loses nothing the reference scan found", async () => {
  const fixture = await createFixture();
  try {
    await withCompleteRequirementGraph(fixture);
    const scan = await runDiscoveryScan({
      legacyRoot: fixture.sourceRoot,
      moduleRoots: ["widget"],
      typescript: requireFrom(path.join(scriptsRoot, "artifact-migration.mjs"))("ts-discovery-compiler"),
    });
    assert.deepEqual(scan.external, ["external-package"]);
    assert.equal(scan.runtimeUrls.length, 1);

    await bootstrap(fixture);
    const held = await advanceGraphDiscovery(fixture, []);
    // Every relevant scanner output reaches the artifact's requirement universe.
    for (const element of [
      ...scan.supporting,
      ...scan.external.map((spec) => `EXTERNAL ${spec}`),
      ...scan.runtimeUrls.map((row) => `RUNTIME_URL ${row.file}:${row.line} ${row.spec}`),
    ]) {
      assert.ok(held.reason.includes(element), `the requirement graph dropped '${element}'`);
    }
  } finally {
    await fixture.cleanup();
  }
});

// D7: an ancillary (test-only) file inside the bound artifact is censused like
// any other structural unit and cannot be omitted.
test("ancillary test files inside the artifact are censused, not skipped", async () => {
  const fixture = await createFixture();
  try {
    await withCompleteRequirementGraph(fixture);
    await bootstrap(fixture);
    const source = await authorSource(fixture);
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    assert.ok(source.sourceFiles.includes("widget/source.test.ts"));
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      units: graphCensusUnits().filter((unit) => unit.path !== "widget/source.test.ts#t"),
      requirements: graphRequirementRows(),
    });
    const held = await runArtifact(fixture.options);
    assert.equal(held.outcome, "CONTINUE");
    assert.match(held.reason, /discovery completeness\.units/);
    assert.match(held.reason, /widget\/source\.test\.ts#t/);
  } finally {
    await fixture.cleanup();
  }
});

const graphOptions = (extra = {}) => ({
  units: graphCensusUnits(),
  requirements: graphRequirementRows(),
  requirementElements: PRESERVED_REQUIREMENTS,
  ...extra,
});

// Drives the requirement-graph fixture to FINALIZE with a valid baseline, so a
// test only has to author gates.json.
const driveGraphToFinalize = async (fixture, resolution = "TARGET_EXTEND") => {
  await withCompleteRequirementGraph(fixture);
  await driveToBuild(fixture, resolution, graphOptions());
  await advanceBaseline(fixture, resolution);
  await advancePlan(fixture, resolution);
  await advanceImplementation(fixture, resolution);
  await advanceVerification(fixture, { ui: false });
  await writeBaseline(fixture, resolution, { final: true });
};

// Audit F-03 / N1-N3, N5, T2, Q3, Q5: discovery disposed a stylesheet, an
// asset, a JSON data file and a runtime URL, and then nothing downstream ever
// asked what happened to them. Preservation is now proved against real target
// files this migration produced, or FINALIZE does not pass.
test("style, asset, data and runtime requirements need real preservation evidence at FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    await driveGraphToFinalize(fixture);

    // Exactly the audited shape: seven green gates, nothing about the five
    // requirements the completeness gate said were migrated.
    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));
    const unproven = await runArtifact(fixture.options);
    assert.equal(unproven.outcome, "CONTINUE");
    assert.match(unproven.reason, /final gates\.requirementEvidence/);
    for (const element of PRESERVED_REQUIREMENTS) {
      assert.ok(unproven.reason.includes(element), `${element} was not demanded`);
    }
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");

    // Half the graph proven is not the graph proven.
    await writeJson(
      fixture.artifactRoot,
      "gates.json",
      await gatesDocument(fixture, { requirementElements: ["shared/format.ts"] }),
    );
    const partial = await runArtifact(fixture.options);
    assert.equal(partial.outcome, "CONTINUE");
    assert.match(partial.reason, /shared\/badge\.css/);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");

    // A hash of a pre-existing file this migration never touched proves nothing.
    const laundered = await gatesDocument(fixture, {
      requirementElements: PRESERVED_REQUIREMENTS,
    });
    laundered.requirementEvidence[0] = {
      ...laundered.requirementEvidence[0],
      path: "src/placeholder.ts",
      sha256: await digest(path.join(fixture.targetRoot, "src/placeholder.ts")),
    };
    await writeJson(fixture.artifactRoot, "gates.json", laundered);
    const unrelated = await runArtifact(fixture.options);
    assert.equal(unrelated.outcome, "CONTINUE");
    assert.match(unrelated.reason, /not one of this migration's changed or declared target files/);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");

    await writeJson(
      fixture.artifactRoot,
      "gates.json",
      await gatesDocument(fixture, { requirementElements: PRESERVED_REQUIREMENTS }),
    );
    const complete = await runArtifact(fixture.options);
    assert.equal(complete.outcome, "COMPLETE", complete.reason);
    assert.deepEqual(await validateArtifactComplete(fixture.options), {
      valid: true,
      complete: true,
      artifactId: fixture.id,
      resolution: "TARGET_EXTEND",
      status: "COMPLETE",
      statePath: path.join(fixture.artifactRoot, "state.json"),
    });
  } finally {
    await fixture.cleanup();
  }
});

// Audit N5/Q2: the external requirement is re-proved at FINALIZE, so a target
// dependency dropped after DISCOVERY_COMPLETENESS cannot ride an old approval
// into a COMPLETE record -- nor stay COMPLETE once it is gone.
test("referenced runtime capture files are revalidated at FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    await withCompleteRequirementGraph(fixture);
    await driveToBuild(fixture, "TARGET_EXTEND", graphOptions({ ui: true }));
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await advancePlan(fixture, "TARGET_EXTEND");
    await advanceImplementation(fixture, "TARGET_EXTEND");
    await advanceVerification(fixture, { ui: true });
    await writeBaseline(fixture, "TARGET_EXTEND", { final: true });

    const gates = await gatesDocument(fixture, { ui: true, requirementElements: PRESERVED_REQUIREMENTS });
    await writeJson(fixture.artifactRoot, "gates.json", gates);

    const screenshotPath = path.join(fixture.artifactRoot, "evidence/slice-1/ui/default.png");
    const originalBytes = await readFile(screenshotPath);

    // referenced screenshot bytes changed -> FAIL
    await writeFile(screenshotPath, Buffer.from([137, 80, 78, 72]));
    let result = await runArtifact(fixture.options);
    assert.equal(result.outcome, "CONTINUE");
    assert.match(result.reason, /runtime artifact hash does not match/);

    // referenced screenshot deleted -> FAIL
    await rm(screenshotPath);
    result = await runArtifact(fixture.options);
    assert.equal(result.outcome, "CONTINUE");
    assert.match(result.reason, /ENOENT|no such file/);

    // unrelated/unreferenced file changed -> PASS (will test intact after)
    await writeFile(path.join(fixture.artifactRoot, "evidence/slice-1/ui/unrelated.png"), Buffer.from([1, 2, 3]));

    // original referenced screenshot restored -> PASS (intact referenced screenshot -> PASS)
    await writeFile(screenshotPath, originalBytes);
    result = await runArtifact(fixture.options);
    assert.equal(result.outcome, "COMPLETE", result.reason);

  } finally {
    await fixture.cleanup();
  }
});

test("an external dependency that disappears blocks FINALIZE and invalidates COMPLETE", async () => {
  const fixture = await createFixture();
  try {
    await driveGraphToFinalize(fixture);
    await writeJson(
      fixture.artifactRoot,
      "gates.json",
      await gatesDocument(fixture, { requirementElements: PRESERVED_REQUIREMENTS }),
    );

    await targetPackageJson(fixture, { dependencies: {} });
    const dropped = await runArtifact(fixture.options);
    assert.equal(dropped.outcome, "CONTINUE");
    assert.match(dropped.reason, /declares no such dependency/);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");

    await targetPackageJson(fixture);
    assert.equal((await runArtifact(fixture.options)).outcome, "COMPLETE");

    await targetPackageJson(fixture, { dependencies: {} });
    await assert.rejects(
      validateArtifactComplete(fixture.options),
      /declares no such dependency/,
    );
  } finally {
    await fixture.cleanup();
  }
});

// Audit Q4: a generic `{command, status:"PASS"}` row was believed. When the
// command names one of the target's own package scripts it is executable, so
// it is executed.
const withTargetScripts = (fixture, scripts) =>
  writeFile(
    path.join(fixture.targetRoot, "package.json"),
    `${JSON.stringify({ name: "target", version: "1.0.0", scripts }, null, 2)}\n`,
  );

test("an applicable generic build/test check is executed, not trusted", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await withTargetScripts(fixture, {
      "verify:ok": "node -e \"process.exit(0)\"",
      "verify:bad": "node -e \"process.exit(3)\"",
    });
    await driveToBuild(fixture, resolution);
    await advanceBaseline(fixture, resolution);
    await advancePlan(fixture, resolution);
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const widget = 'TARGET_EXTEND';\n",
    );
    const changedFiles = [
      {
        path: fixture.options.target,
        sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
      },
    ];
    const implementation = (command) => ({
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles,
      checks: [typescriptCheck(), { command, status: "PASS" }],
      preservedTargetNativeIds: ["TN-1"],
    });

    await writeJson(fixture.artifactRoot, "slices/slice-1.json", implementation("npm run verify:bad"));
    const failed = await runArtifact(fixture.options);
    assert.equal(failed.outcome, "CONTINUE");
    assert.match(failed.reason, /declares PASS but 'npm run verify:bad' exited 3/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");

    // A prose claim that names no runnable script stays a claim: it never
    // established code coverage and this change does not make it do so.
    await writeJson(
      fixture.artifactRoot,
      "slices/slice-1.json",
      implementation("Reviewed the diff by hand."),
    );
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F5, resource exhaustion: a check whose output overruns the engine's
// buffer is the engine failing to run it at all. It used to be folded into
// "exit 1" and then into "not covered yet" -- a CONTINUE an automated driver
// would retry forever.
test("a check that exhausts the output buffer is BLOCKED, not silently downgraded", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await writeFile(
      path.join(fixture.targetRoot, "flood.js"),
      "process.stdout.write('x'.repeat(11_000_000));\n",
    );
    await withTargetScripts(fixture, { "verify:flood": "node flood.js" });
    await driveToBuild(fixture, resolution);
    await advanceBaseline(fixture, resolution);
    await advancePlan(fixture, resolution);
    await writeFile(
      path.join(fixture.targetRoot, fixture.options.target),
      "export const widget = 'TARGET_EXTEND';\n",
    );
    await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
      version: 1,
      sliceId: "slice-1",
      status: "COMPLETE",
      changedFiles: [
        {
          path: fixture.options.target,
          sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
        },
      ],
      checks: [typescriptCheck(), { command: "npm run verify:flood", status: "PASS" }],
      preservedTargetNativeIds: ["TN-1"],
    });
    const blocked = await runArtifact(fixture.options);
    assert.equal(blocked.outcome, "BLOCKED");
    assert.match(blocked.reason, /Cannot execute 'npm run verify:flood'/);
    // P1 #6: `--status` is read-only, so it defers the target package script
    // rather than running it, and names the deferral instead of reporting a
    // fault it never triggered. Only the explicit `run` above sees the fault.
    const status = await getArtifactStatus(fixture.options);
    assert.equal(status.outcome, "CONTINUE");
    assert.ok(status.validation.result.deferredExecution.includes("npm run verify:flood"));
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F5, resolved-but-unreadable dependency: the scanner keeps the node when
// the bytes stop being readable, so without a readability check the disposition
// settled something the engine could no longer see.
test("a resolved but unreadable requirement is BLOCKED, not disposed on faith", async () => {
  const fixture = await createFixture();
  try {
    await withCompleteRequirementGraph(fixture);
    await bootstrap(fixture);
    const source = await authorSource(fixture);
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      units: graphCensusUnits(),
      requirements: graphRequirementRows(),
    });

    // The file the requirement names is still resolvable, but its bytes are not.
    const unreadable = path.join(fixture.sourceRoot, "shared/format.ts");
    await rm(unreadable);
    await mkdir(unreadable, { recursive: true });
    const blocked = await runArtifact(fixture.options);
    assert.equal(blocked.outcome, "BLOCKED");
    assert.match(blocked.reason, /Cannot read required source element 'shared\/format\.ts'/);
    assert.equal((await getArtifactStatus(fixture.options)).outcome, "BLOCKED");
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    // Recoverable: restore the bytes and the same document advances.
    await rm(unreadable, { recursive: true });
    await writeFile(unreadable, "export const fmt = (value) => value;\n");
    const advanced = await runArtifact(fixture.options);
    assert.equal(advanced.outcome, "CONTINUE", advanced.reason);
    assert.equal((await stateOf(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F5, unwritable record: the two-phase journal is written before the
// state and integrity anchors, so a write that cannot land must leave a
// recoverable record and say so -- never a half-advanced one reported as
// healthy.
test("an unwritable record fails loudly and replays once the obstruction is gone", async () => {
  const fixture = await createFixture();
  const history = path.join(fixture.artifactRoot, "history/history.ndjson");
  try {
    await bootstrap(fixture);
    await authorSource(fixture);
    // The append-only history is written after the transaction journal and
    // before the state and integrity anchors: a commit that cannot land there
    // is exactly the mid-write resource failure the audit found untested.
    await chmod(history, 0o444);

    await assert.rejects(runArtifact(fixture.options));
    assert.ok(await exists(path.join(fixture.artifactRoot, "transaction.json")));

    // Both read paths agree the record is pending recovery, not healthy.
    const pending = await getArtifactStatus(fixture.options);
    assert.equal(pending.status, "ACTIVE");
    assert.match(pending.reason, /recovered automatically/);
    const stillBlocked = await runArtifact(fixture.options);
    assert.equal(stillBlocked.outcome, "BLOCKED");

    await chmod(history, 0o644);
    const recovered = await runArtifact(fixture.options);
    assert.equal(recovered.outcome, "CONTINUE", recovered.reason);
    assert.equal((await stateOf(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
    assert.equal(await exists(path.join(fixture.artifactRoot, "transaction.json")), false);
  } finally {
    await chmod(history, 0o644).catch(() => undefined);
    await fixture.cleanup();
  }
});

// Audit F4: an actual SIGINT to a real CLI process mid-checkpoint. The record
// must never be left in a state the next run cannot describe or resume, and the
// lock the killed process held must not strand the migration.
test("an actual SIGINT mid-checkpoint leaves a resumable record", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await driveToBuild(fixture, resolution);
    await advanceBaseline(fixture, resolution);
    await advancePlan(fixture, resolution);
    await advanceImplementation(fixture, resolution);
    await advanceVerification(fixture, { ui: false });
    await writeBaseline(fixture, resolution, { final: true });
    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));

    const before = await readFile(path.join(fixture.artifactRoot, "history/history.ndjson"), "utf8");
    const child = spawn(
      process.execPath,
      [
        path.join(scriptsRoot, "run-artifact.mjs"),
        ...artifactArgumentsFor({
          artifactType: fixture.options.type,
          source: { root: fixture.sourceRoot, path: fixture.options.source },
          target: { root: fixture.targetRoot, path: fixture.options.target },
        }),
      ],
      { cwd: fixture.targetRoot, stdio: "ignore" },
    );
    // Attached synchronously with the spawn: a listener added after an await
    // misses an `exit` that already fired, and the test then waits forever.
    let settled = null;
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    exited.then(
      (outcome) => { settled = outcome; },
      (error) => { settled = { error }; },
    );

    // Deterministic checkpoint evidence, not a sleep: the run holds the
    // record's module lock for the whole mutating checkpoint, and the lock
    // file names its holder's pid. The record is parked at FINALIZE with every
    // prior checkpoint complete, so "this child owns the lock" means "this
    // child is inside the FINALIZE checkpoint" -- validating gates, running the
    // TypeScript validator and walking the target tree -- not idle.
    // ponytail: a 2ms poll, not an fs.watch. Ceiling: a FINALIZE that both
    // starts and finishes inside one poll interval would be reported as an
    // early exit rather than silently passing. Upgrade path: watch the lock
    // directory if that ever fires.
    const lockFile = lockPathFor(fixture.targetRoot, `artifact-${fixture.id}`);
    const checkpointDeadline = Date.now() + 60_000;
    let holder = null;
    while (Date.now() < checkpointDeadline) {
      // The lock is created empty and written a moment later, so a probe that
      // lands in between reads "" -- not an owner, just not one yet.
      holder = await readFile(lockFile, "utf8")
        .then((bytes) => JSON.parse(bytes))
        .catch(() => null);
      if (holder?.pid === child.pid) break;
      holder = null;
      // Only an exit observed after a failed probe proves it never got there.
      if (settled) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    if (!holder) {
      child.kill("SIGKILL");
      assert.fail(
        settled
          ? `the CLI exited (${JSON.stringify(settled)}) before it reached the FINALIZE checkpoint, so no signal was ever delivered mid-checkpoint`
          : "the CLI never reached the FINALIZE checkpoint within 60s",
      );
    }

    child.kill("SIGINT");
    let terminationTimer;
    const outcome = await Promise.race([
      exited,
      new Promise((_, reject) => {
        terminationTimer = setTimeout(
          () => reject(new Error("the CLI did not terminate within 30s of SIGINT")),
          30_000,
        );
      }),
    ]).finally(() => clearTimeout(terminationTimer));
    // Killed by the signal, or exited non-zero handling it -- never a clean 0.
    assert.notEqual(outcome.code, 0, `SIGINT mid-checkpoint exited cleanly: ${JSON.stringify(outcome)}`);

    // Whatever the signal interrupted, the record still describes itself.
    const status = await getArtifactStatus(fixture.options);
    assert.ok(["ACTIVE", "COMPLETE"].includes(status.status), status.reason);
    const history = await readFile(path.join(fixture.artifactRoot, "history/history.ndjson"), "utf8");
    assert.ok(history.startsWith(before), "history is append-only across an interruption");

    // And it resumes: the lock the killed process held is reclaimed, and the
    // checkpoint completes.
    if (status.status !== "COMPLETE") {
      const resumed = await runArtifact(fixture.options);
      assert.equal(resumed.outcome, "COMPLETE", resumed.reason);
    }
    assert.equal((await stateOf(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

// Audit F2/F6: the only file the engine ever removes is its own transaction
// journal, and nothing it is handed can make it write into a provider,
// generated or dependency tree -- those are excluded from the target binding,
// so drift inside one would be invisible to every later freshness check.
test("the engine writes only inside its own record and refuses provider paths", async () => {
  const fixture = await createFixture();
  try {
    const resolution = "TARGET_EXTEND";
    await mkdir(path.join(fixture.targetRoot, ".claude"), { recursive: true });
    await writeFile(path.join(fixture.targetRoot, ".claude/settings.json"), "{}\n");
    const sentinel = path.join(fixture.targetRoot, "src/placeholder.ts");
    const sentinelBefore = await readFile(sentinel, "utf8");

    await driveToBuild(fixture, resolution);
    await advanceBaseline(fixture, resolution);
    await advancePlan(fixture, resolution);
    for (const provider of [".claude/settings.json", ".agents/knowledge/migrations/x.ts", "node_modules/pkg/index.js"]) {
      await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
        version: 1,
        sliceId: "slice-1",
        status: "COMPLETE",
        changedFiles: [{ path: provider, sha256: "0".repeat(64) }],
        checks: [typescriptCheck()],
        preservedTargetNativeIds: ["TN-1"],
      });
      const refused = await runArtifact(fixture.options);
      assert.equal(refused.outcome, "CONTINUE");
      assert.match(refused.reason, /provider\/generated path that this migration must never write/);
    }

    await advanceImplementation(fixture, resolution);
    await advanceVerification(fixture, { ui: false });
    await writeBaseline(fixture, resolution, { final: true });
    await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));
    assert.equal((await runArtifact(fixture.options)).outcome, "COMPLETE");

    assert.equal(await readFile(sentinel, "utf8"), sentinelBefore);
    assert.equal(await readFile(path.join(fixture.targetRoot, ".claude/settings.json"), "utf8"), "{}\n");
    // The transaction journal is the one thing a run removes, and only its own.
    assert.equal(await exists(path.join(fixture.artifactRoot, "transaction.json")), false);
    for (const kept of ["state.json", "integrity.json", "history/history.ndjson", "inventories/source.json"]) {
      assert.ok(await exists(path.join(fixture.artifactRoot, kept)), kept);
    }
  } finally {
    await fixture.cleanup();
  }
});

// Audit A4/A5: the skill recorded no execution-time or scan evidence at all, so
// "how much repeated work did this cost" could only be timed from outside.
test("every run and status reports scan, parse and time metrics", async () => {
  const fixture = await createFixture();
  try {
    await bootstrap(fixture);
    const source = await authorSource(fixture);
    const advanced = await runArtifact(fixture.options);
    assert.equal(advanced.outcome, "CONTINUE");
    assert.ok(Number.isInteger(advanced.metrics.durationMs) && advanced.metrics.durationMs >= 0);
    assert.equal(advanced.metrics.discoveryScans, 0);

    // DISCOVERY_COMPLETENESS is the checkpoint that scans; one run, one scan.
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: source.sourceFiles,
      units: censusUnits(),
      requirements: [],
    });
    const scanning = await runArtifact(fixture.options);
    assert.equal(scanning.outcome, "CONTINUE", scanning.reason);
    assert.equal(scanning.metrics.discoveryScans, 1);
    assert.ok(scanning.metrics.filesParsed > 0);

    const status = await getArtifactStatus(fixture.options);
    assert.ok(status.metrics.durationMs >= 0);
    assert.ok(Number.isInteger(status.metrics.filesParsed));
  } finally {
    await fixture.cleanup();
  }
});

test("migrate-artifact discovery succeeds when the application uses typescript 7.0.2", async () => {
  const fixture = await createFixture();
  try {
    const fakeTsPath = path.join(fixture.targetRoot, "node_modules", "typescript");
    await mkdir(path.join(fakeTsPath, "bin"), { recursive: true });

    await writeJson(fixture.targetRoot, "package.json", {
      name: "target-app",
      devDependencies: { typescript: "7.0.2" }
    });

    await writeFile(path.join(fakeTsPath, "bin", "tsc"), "#!/usr/bin/env node\nprocess.exit(0);");
    await chmod(path.join(fakeTsPath, "bin", "tsc"), 0o755);

    await writeFile(
      path.join(fakeTsPath, "index.js"),
      `module.exports = {
        sys: {
          readFile: require("fs").readFileSync,
          fileExists: require("fs").existsSync,
          readDirectory: require("fs").readdirSync,
          directoryExists: require("fs").existsSync,
        },
        readConfigFile: (file) => ({
          config: JSON.parse(require("fs").readFileSync(file, "utf8"))
        }),
        parseJsonConfigFileContent: (config, sys, basePath) => ({
          options: config.compilerOptions || {},
          errors: []
        }),
        createSourceFile: () => { throw new Error("AST API removed in TS 7.0!"); },
        ScriptTarget: { Latest: 99 },
        isStringLiteralLike: () => false,
        isCallExpression: () => false,
        isImportDeclaration: () => false,
        isExportDeclaration: () => false,
        isImportEqualsDeclaration: () => false,
        isExternalModuleReference: () => false
      };`
    );
    await writeJson(fakeTsPath, "package.json", { name: "typescript", version: "7.0.2", main: "index.js" });

    const bootstrapResult = await runArtifact(fixture.options);
    assert.equal(bootstrapResult.outcome, "CONTINUE");

    await advanceDiscovery(fixture);

    const state = await readArtifactState(fixture.targetRoot, fixture.id);
    assert.equal(state.currentStep, "ASSESS_TARGET");

  } finally {
    await fixture.cleanup();
  }
});


// --- P1 #6: read-only status must never execute target-controlled code -------
//
// `--status` reached the same `validateCheckpoint` the write path uses, so a
// checkpoint whose validators run things -- the target's own package scripts
// through a shell, the target's `tsc` binary, `node --check` -- ran them to
// answer a read-only question. Everything armed below is controlled by the
// migration target, not by this engine.

// A target that executes on contact: a package script and a `tsc` shim that
// each leave a marker line behind the moment anything runs them.
const armExecutionTripwire = async (fixture) => {
  const marker = path.join(fixture.root, "target-code-executed.txt");
  await writeJson(fixture.targetRoot, "package.json", {
    name: "target",
    version: "1.0.0",
    scripts: { verify: `node -e "require('node:fs').appendFileSync(process.env.P16_MARKER, 'package-script\\n')"` },
    devDependencies: { typescript: "5.9.3" },
  });
  // The TARGET's own compiler, which is what type-checks the target. It used to
  // be armed under the engine's `ts-discovery-compiler` alias, because both jobs
  // shared one pinned binary; the target is now checked with the compiler it
  // actually declares, so the tripwire is armed where a real target's is.
  const shim = path.join(fixture.targetRoot, "node_modules", "typescript");
  await mkdir(path.join(shim, "bin"), { recursive: true });
  await writeJson(shim, "package.json", {
    name: "typescript",
    version: "5.9.3",
    main: "index.js",
    bin: { tsc: "./bin/tsc" },
  });
  await writeFile(path.join(shim, "index.js"), "module.exports = {};\n");
  await writeFile(
    path.join(shim, "bin", "tsc"),
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.P16_MARKER, "tsc-binary\\n");\nprocess.exit(0);\n`,
  );
  await chmod(path.join(shim, "bin", "tsc"), 0o755);
  process.env.P16_MARKER = marker;
  return {
    marker,
    fired: async () =>
      (await exists(marker)) ? (await readFile(marker, "utf8")).trim().split("\n").sort() : [],
  };
};

// Drive to IMPLEMENT_SLICES and author a slice whose checks are both executable:
// one generic package script, one TypeScript validator.
const armedImplementation = async (fixture) => {
  const resolution = "TARGET_EXTEND";
  const tripwire = await armExecutionTripwire(fixture);
  await driveToBuild(fixture, resolution);
  await advanceBaseline(fixture, resolution);
  await advancePlan(fixture, resolution);
  await writeFile(
    path.join(fixture.targetRoot, fixture.options.target),
    "export const widget = 'TARGET_EXTEND';\n",
  );
  await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
    version: 1,
    sliceId: "slice-1",
    status: "COMPLETE",
    changedFiles: [
      {
        path: fixture.options.target,
        sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
      },
    ],
    checks: [{ command: "npm run verify", status: "PASS" }, typescriptCheck()],
    preservedTargetNativeIds: ["TN-1"],
  });
  return tripwire;
};

const recordBytes = async (fixture) => {
  const read = async (relative) => {
    const file = path.join(fixture.artifactRoot, relative);
    return (await exists(file)) ? await readFile(file, "utf8") : null;
  };
  return {
    state: await read("state.json"),
    history: await read("history/history.ndjson"),
    integrity: await read("integrity.json"),
    transaction: await read("transaction.json"),
  };
};

test("P1 #6: --status executes no target-controlled code and mutates no record", async () => {
  const fixture = await createFixture();
  try {
    const tripwire = await armedImplementation(fixture);
    const before = await recordBytes(fixture);
    assert.deepEqual(await tripwire.fired(), [], "precondition: nothing executed while authoring");

    const status = await getArtifactStatus(fixture.options);

    // Zero target-code execution, proven by the target's own artifacts.
    assert.deepEqual(
      await tripwire.fired(),
      [],
      "--status ran the target's package script and/or compiler binary",
    );
    // Proven again by the engine's own counters: no child process, no preview.
    assert.equal(status.metrics.validatorRuns, 0);
    assert.equal(status.metrics.previewAdvanceCalls, 0);

    // Zero side effects on the authoritative record.
    assert.deepEqual(await recordBytes(fixture), before);
    assert.equal(before.transaction, null);

    // Still honest: the checkpoint is reported, and the checks it did not run
    // are named rather than silently claimed as passing.
    assert.equal(status.status, "ACTIVE");
    assert.equal(status.outcome, "CONTINUE");
    assert.equal(status.state.currentStep, "IMPLEMENT_SLICES");
    assert.equal(status.validation.executed, false);
    assert.deepEqual(status.validation.result.deferredExecution, ["npm run verify", "TYPESCRIPT"]);

    // The explicit run still executes what status refused to, and advances.
    const advanced = await runArtifact(fixture.options);
    assert.equal(advanced.outcome, "CONTINUE", advanced.reason);
    assert.deepEqual(await tripwire.fired(), ["package-script", "tsc-binary"]);
    assert.equal((await stateOf(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("P1 #6: stale and valid --status verdicts stay correct without executing anything", async () => {
  const fixture = await createFixture();
  try {
    const tripwire = await armedImplementation(fixture);

    const valid = await getArtifactStatus(fixture.options);
    assert.equal(valid.status, "ACTIVE");
    assert.equal(valid.outcome, "CONTINUE");
    assert.equal(valid.stale, undefined);

    // P1 #2: undeclared target drift is still STALE/BLOCKED, reached from bytes
    // on disk alone.
    await writeFile(
      path.join(fixture.targetRoot, "src/theme.ts"),
      "export const theme = 'drifted';\n",
    );
    const stale = await getArtifactStatus(fixture.options);
    assert.equal(stale.status, "STALE");
    assert.equal(stale.outcome, "BLOCKED");
    assert.ok(stale.stale.targetDrift.includes("src/theme.ts"));

    // Provider-path noise is still ignored, also without executing.
    await mkdir(path.join(fixture.targetRoot, ".opencode"), { recursive: true });
    await writeFile(path.join(fixture.targetRoot, ".opencode/session.json"), "{}\n");
    assert.equal((await getArtifactStatus(fixture.options)).status, "STALE");

    assert.deepEqual(await tripwire.fired(), []);
  } finally {
    await fixture.cleanup();
  }
});

test("P1 #6: a failing target check --status cannot see still blocks the explicit run", async () => {
  const fixture = await createFixture();
  try {
    const tripwire = await armedImplementation(fixture);
    await writeJson(fixture.targetRoot, "package.json", {
      name: "target",
      version: "1.0.0",
      scripts: { verify: `node -e "process.exit(3)"` },
    });

    // Status defers it and says so, rather than trusting or running it.
    const status = await getArtifactStatus(fixture.options);
    assert.equal(status.outcome, "CONTINUE");
    assert.ok(status.validation.result.deferredExecution.includes("npm run verify"));
    assert.deepEqual(await tripwire.fired(), []);

    // The explicit path runs it and refuses to advance on its verdict.
    const run = await runArtifact(fixture.options);
    assert.equal(run.outcome, "CONTINUE");
    assert.match(run.reason, /declares PASS but 'npm run verify' exited 3/);
    assert.equal((await stateOf(fixture)).currentStep, "IMPLEMENT_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("P1 #6: the execution choke point fails closed for a read-only capability", async () => {
  const fixture = await createFixture();
  try {
    // The backstop, independent of any validator's cooperation: a child process
    // requested without an execution capability faults instead of spawning.
    await assert.rejects(
      () =>
        hasCodeValidationCheck([typescriptCheck()], ["src/widget.ts"], fixture.targetRoot, {
          execution: false,
        }),
      (error) =>
        error.engineFault === true && /must not run target-controlled code/.test(error.message),
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- R-W1-b / R-W1-c: the target is type-checked by the TARGET's compiler ---

// Parsing a tsconfig and type-checking a project are two jobs with opposite
// version requirements. They used to share one pinned 5.9.3 binary, so a
// TypeScript 7 project was checked by a compiler it does not use: diagnostics it
// does not have were reported and ones it does have were missed, and the verdict
// then fed the artifact code-validation gate with nothing recording which
// compiler produced it.
const installFakeTargetCompiler = async (targetRoot, version) => {
  const packageRoot = path.join(targetRoot, "node_modules/typescript");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "typescript", version, bin: { tsc: "./bin/tsc" } }, null, 2)}\n`,
  );
  // Exits 0 and prints a marker, so the evidence proves which binary ran.
  await writeFile(
    path.join(packageRoot, "bin/tsc"),
    "#!/usr/bin/env node\nprocess.stdout.write('target-compiler-ran\\n');\n",
  );
  await writeJson(targetRoot, "package.json", {
    name: "fixture-target",
    devDependencies: { typescript: version },
  });
};

test("R-W1-b: a target that declares its own TypeScript is checked with it, and the evidence says so", async () => {
  const fixture = await createFixture();
  try {
    await installFakeTargetCompiler(fixture.targetRoot, "9.9.9-fixture");

    const identity = targetTypeScript(fixture.targetRoot).identity;
    assert.equal(identity.origin, "TARGET");
    assert.equal(identity.specifier, "typescript");
    assert.equal(identity.version, "9.9.9-fixture");
    assert.ok(
      identity.bin.startsWith(path.join(fixture.targetRoot, "node_modules")),
      "the binary must come from the target, not from the engine",
    );

    // End to end: the recorded validator evidence carries the same identity, so
    // a FINALIZE gate that consumed this verdict is readable as such later.
    const { evidence } = await hasCodeValidationCheck(
      [typescriptCheck()],
      ["src/widget.ts"],
      fixture.targetRoot,
      { execution: true },
    );
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].validatorKind, "TYPESCRIPT");
    assert.equal(evidence[0].compiler.origin, "TARGET");
    assert.equal(evidence[0].compiler.version, "9.9.9-fixture");
    assert.equal(evidence[0].command.args[0], identity.bin);
  } finally {
    await fixture.cleanup();
  }
});

test("R-W1-c: a target with no TypeScript falls back and stamps PINNED_FALLBACK", async () => {
  const fixture = await createFixture();
  try {
    // The base fixture target declares no manifest and no compiler at all.
    const identity = targetTypeScript(fixture.targetRoot).identity;
    assert.equal(identity.origin, "PINNED_FALLBACK");
    assert.equal(identity.specifier, "ts-discovery-compiler");
    assert.equal(identity.version, "5.9.3");

    const { evidence } = await hasCodeValidationCheck(
      [typescriptCheck()],
      ["src/widget.ts"],
      fixture.targetRoot,
      { execution: true },
    );
    assert.equal(evidence[0].compiler.origin, "PINNED_FALLBACK");
    assert.equal(evidence[0].compiler.version, "5.9.3");
  } finally {
    await fixture.cleanup();
  }
});

test("R-W1-c: a target that declares TypeScript but has not installed it does not claim TARGET", async () => {
  const fixture = await createFixture();
  try {
    // Declaration is not resolution. A manifest entry with no package on disk
    // must not be reported as the compiler that produced the verdict.
    await writeJson(fixture.targetRoot, "package.json", {
      name: "fixture-target",
      devDependencies: { typescript: "^5.9.3" },
    });
    assert.equal(
      targetTypeScript(fixture.targetRoot).identity.origin,
      "PINNED_FALLBACK",
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- R-W1-a / R-W1-d: the engine owns its parser -----------------------------

test("R-W1-a: the structural parser resolves from the skill's own dependency, not the host manifest", async () => {
  const engineRoot = path.resolve(scriptsRoot, "../..");
  const manifest = JSON.parse(
    await readFile(path.join(engineRoot, "package.json"), "utf8"),
  );
  assert.equal(
    manifest.dependencies["ts-discovery-compiler"],
    "npm:typescript@5.9.3",
    "the engine must declare its own pinned parser",
  );

  // The proof that matters off this workstation. Node consults the skill's own
  // node_modules before anything above it, so an installed entry there means a
  // host that never declares the alias -- which is every real target repository
  // -- still resolves the parser. `require.resolve` reports the realpath, and
  // pnpm's store lives at the workspace root, so the ownership assertion is
  // about the *search path*, not about where the bytes physically sit.
  const require = requireFrom(path.join(scriptsRoot, "artifact-migration.mjs"));
  const skillModules = path.join(engineRoot, "node_modules");
  const searchPaths = require.resolve.paths("ts-discovery-compiler") ?? [];
  assert.equal(
    searchPaths[searchPaths.indexOf(skillModules)],
    skillModules,
    "the skill's own node_modules must be on the resolution path",
  );
  assert.ok(
    searchPaths.indexOf(skillModules) <
      (searchPaths.indexOf(path.join(repositoryRootOf(engineRoot), "node_modules")) === -1
        ? Number.MAX_SAFE_INTEGER
        : searchPaths.indexOf(path.join(repositoryRootOf(engineRoot), "node_modules"))),
    "the skill's dependency must win over the host's",
  );
  assert.ok(
    await exists(path.join(skillModules, "ts-discovery-compiler/package.json")),
    "the skill's pinned parser must actually be installed under the skill",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(skillModules, "ts-discovery-compiler/package.json"),
        "utf8",
      ),
    ).version,
    "5.9.3",
  );
});

// `packages/migration-engine` -> the repository root that contains `packages`.
const repositoryRootOf = (engineRoot) => path.resolve(engineRoot, "../..");

test("R-W1-d: an unresolvable parser names the dependency, the manifest, the searched root and the install command", () => {
  const message = parserResolutionError(
    new Error("Cannot find module 'ts-discovery-compiler'"),
    // The suite no longer sits beside the source it tests, so the raising
    // module's own URL is passed explicitly rather than taken from this file.
    pathToFileURL(path.join(scriptsRoot, "artifact-migration.mjs")).href,
    "migrate-artifact",
  ).message;
  assert.match(message, /ts-discovery-compiler/);
  assert.match(message, /npm:typescript@5\.9\.3/);
  assert.match(message, /packages\/migration-engine\/package\.json/);
  assert.match(message, /pnpm install --frozen-lockfile/);
  assert.ok(message.includes(scriptsRoot), "must name the directory searched");
  assert.match(message, /Nothing was changed\./);
});

// --- W7: one policy module, two front ends ----------------------------------

test("R-W7-a: a CONTINUE with no next command is FAILED, never `loop: STOP reason=CONTINUE`", () => {
  // `reason=CONTINUE` is not a member of the closed stop set. A provider obeying
  // the directive literally -- which the protocol requires -- met an unknown
  // token at the one place it is forbidden to improvise.
  const directive = artifactDirective(
    { outcome: "CONTINUE", progress: { nextWork: {} } },
    "widget",
    undefined,
  );
  assert.equal(directive, "loop: STOP reason=FAILED\n");
  assert.doesNotMatch(directive, /reason=CONTINUE/);

  // A real continuation still continues, and names the artifact's own command.
  assert.equal(
    artifactDirective(
      { outcome: "CONTINUE", progress: { nextWork: { command: "/migrate-artifact widget" } } },
      "widget",
      undefined,
    ),
    "loop: CONTINUE next=/migrate-artifact widget\n",
  );
});

test("R-W7-b: every directive the artifact CLI can emit parses against MIGRATION_OUTCOMES", () => {
  const stopReasons = new Set();
  for (const outcome of MIGRATION_OUTCOMES) {
    for (const nextWork of [{}, { command: "/migrate-artifact widget" }]) {
      const line = artifactDirective({ outcome, progress: { nextWork } }, "widget", undefined);
      assert.match(line, /^loop: (CONTINUE next=\S.*|STOP reason=[A-Z_]+)\n$/);
      const stop = line.match(/^loop: STOP reason=([A-Z_]+)\n$/);
      if (stop) stopReasons.add(stop[1]);
    }
  }
  // Every emitted stop reason is a member of the closed set, and `CONTINUE`
  // never appears as one.
  for (const reason of stopReasons) {
    assert.ok(MIGRATION_OUTCOMES.includes(reason), `${reason} is not an outcome`);
  }
  assert.equal(stopReasons.has("CONTINUE"), false);
});

test("R-W7-c: --mode step emits no directive from the artifact front end either", () => {
  for (const outcome of MIGRATION_OUTCOMES) {
    assert.equal(
      artifactDirective({ outcome, progress: { nextWork: { command: "x" } } }, "widget", "step"),
      "",
    );
  }
});

test("R-W7-d: the artifact front ends carry no second copy of a shared rule", async () => {
  const sources = await Promise.all(
    ["run-artifact.mjs", "artifact-migration.mjs"].map(async (file) => [
      file,
      await readFile(path.join(scriptsRoot, file), "utf8"),
    ]),
  );
  for (const [file, source] of sources) {
    // Strip comments: the boundary is documented in prose in both files, and
    // documenting a rule is not carrying a copy of it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(code, /"loop: |`loop: /, `${file} renders its own loop directive`);
    assert.doesNotMatch(
      code,
      /\[\s*"auto"\s*,\s*"step"\s*\]/,
      `${file} carries its own MIGRATION_MODES literal`,
    );
    for (const outcome of MIGRATION_OUTCOMES) {
      assert.doesNotMatch(
        code,
        new RegExp(`outcome\\s*[=!]==?\\s*"${outcome}"[\\s\\S]{0,40}exitCode`),
        `${file} maps ${outcome} to an exit code itself`,
      );
    }
  }

  // The consent regex is gone: "what counts as approval" has one answer, and it
  // is not a pattern match in a CLI.
  const cli = sources.find(([file]) => file === "run-artifact.mjs")[1];
  assert.doesNotMatch(cli, /yes\|y\|si/i, "the artifact CLI decides consent by regex");
  assert.doesNotMatch(cli, /createInterface/, "the artifact CLI prompts interactively");

  // And the option rules really come from the shared module: the artifact
  // branch produces the same refusals `discover` and `run` produce.
  assert.throws(
    () => parseArtifactArguments(["widget", "--mode", "turbo"]),
    /--mode accepts 'auto' or 'step'\./,
  );
  assert.throws(
    () => parseArtifactArguments(["widget", "--status", "--mode", "auto"]),
    /--status is read-only/,
  );
  assert.throws(() => parseArtifactArguments([]), /Usage: run-artifact\.mjs/);
});

const writeFigmaContext = async (fixture, fidelity = "COMPLETE") => {
  const base = "inventories/figma/12-34";
  const files = {
    metadata: await writeJson(fixture.artifactRoot, `${base}/metadata.xml`, {
      xml: '<frame id="12:34" name="Dialog" width="1280" height="720"></frame>',
    }),
    design: await writeJson(fixture.artifactRoot, `${base}/design-context.json`, { component: "Dialog" }),
    variables: await writeJson(fixture.artifactRoot, `${base}/variables.json`, { spacing: 8 }),
  };
  // Metadata is the one Figma output whose contract is verbatim XML, not JSON.
  await writeFile(files.metadata, '<frame id="12:34" name="Dialog" width="1280" height="720"></frame>');
  const screenshot = path.join(fixture.artifactRoot, `${base}/screenshot.png`);
  await writeFile(screenshot, Buffer.from([137, 80, 78, 71]));
  const reference = async (file) => ({
    reference: path.relative(fixture.artifactRoot, file).replaceAll("\\", "/"),
    hash: `sha256:${await digest(file)}`,
  });
  await writeJson(fixture.artifactRoot, "inventories/figma-context.json", {
    frames: [
      {
        fileKey: "File123",
        nodeId: "12:34",
        name: "Dialog",
        type: "FRAME",
        viewport: { width: 1280, height: 720 },
        states: ["default"],
        extraction: {
          retrievedAt: "2026-09-21T00:00:00.000Z",
          fidelity,
          limitations: fidelity === "COMPLETE" ? [] : ["get_design_context was truncated"],
        },
        sources: {
          metadata: await reference(files.metadata),
          designContext: [await reference(files.design)],
          variableDefs: await reference(files.variables),
          screenshot: await reference(screenshot),
        },
      },
    ],
  });
};

const writeVisualAcceptance = (fixture) =>
  writeJson(fixture.artifactRoot, "matrices/visual-acceptance.json", {
    rows: [
      {
        id: "VA-1",
        uiBehaviorId: "B-1",
        state: "DEFAULT",
        figmaNodeId: "12:34",
        figmaState: "default",
        viewport: { width: 1280, height: 720 },
        tolerance: { px: 8, ratio: 0.02 },
        expect: {
          dialogWidth: { locator: "[role=dialog]", kind: "px", value: 360 },
        },
      },
    ],
    unbacked: [],
  });

test("Figma parity: CLI validation, persisted canonical sources, shared evidence contract, and deterministic visual verdict", async () => {
  const parsed = parseArtifactArguments([
    "widget",
    "--design-source",
    "figma-mcp",
    "--figma",
    "https://figma.com/design/File123/Dialog?node-id=12-34&token=discarded",
    "--figma",
    "https://www.figma.com/design/File123/Dialog?node-id=12-34",
  ]);
  assert.equal(parsed.designSource, "figma-mcp");
  assert.equal(parsed.figma.length, 2);
  assert.throws(
    () => parseArtifactArguments(["widget", "--design-source", "sketch"]),
    /--design-source accepts target-system or figma-mcp/,
  );

  const fixture = await createFixture();
  const options = {
    ...fixture.options,
    designSource: parsed.designSource,
    figma: parsed.figma,
  };
  try {
    await bootstrap(fixture, options);
    let state = await stateOf(fixture);
    assert.equal(state.designSource, "figma-mcp");
    assert.deepEqual(state.figmaSources, [
      {
        fileKey: "File123",
        nodeId: "12:34",
        kind: "design",
        raw: "https://www.figma.com/design/File123?node-id=12-34",
      },
    ]);
    await advanceDiscovery(fixture, { ui: true });
    await writeJson(fixture.artifactRoot, "inventories/target.json", await targetInventory(fixture, "TARGET_REUSE"));
    const missing = await runArtifact(fixture.options);
    assert.match(missing.reason, /figma-context\.json does not exist/);

    await writeFigmaContext(fixture);
    const assessed = await runArtifact(fixture.options);
    assert.equal(assessed.outcome, "CONTINUE", assessed.reason);
    assert.equal((await stateOf(fixture)).currentStep, "BUILD_BASELINE");
    await writeBaseline(fixture, "TARGET_REUSE");
    await writeVisualAcceptance(fixture);
    const baseline = await runArtifact(fixture.options);
    assert.equal(baseline.outcome, "CONTINUE", baseline.reason);
    await advancePlan(fixture, "TARGET_REUSE");
    await advanceImplementation(fixture, "TARGET_REUSE");

    const measurementPath = "evidence/slice-1/ui/measurements.json";
    const measurement = await writeJson(fixture.artifactRoot, measurementPath, {
      viewport: { width: 1280, height: 720 },
      values: { dialogWidth: 230 },
    });
    const verification = await verificationDocument(fixture, { ui: true });
    state = await stateOf(fixture);
    Object.assign(verification.runtimeEvidence[0], {
      figmaNodeId: "12:34",
      measurements: { path: measurementPath, sha256: await digest(measurement) },
    });
    verification.runtimeEvidence[0].boundTo.figmaContextDigest =
      state.artifactHashes["inventories/figma-context.json"];
    await writeJson(fixture.artifactRoot, "evidence/slice-1/result.json", verification);
    const failed = await runArtifact(fixture.options);
    assert.match(failed.reason, /VISUAL_ACCEPTANCE_FAIL.*expected 360px/);

    await writeJson(fixture.artifactRoot, measurementPath, {
      viewport: { width: 1280, height: 720 },
      values: { dialogWidth: 360 },
    });
    verification.runtimeEvidence[0].measurements.sha256 = await digest(measurement);
    await writeJson(fixture.artifactRoot, "evidence/slice-1/result.json", verification);
    const passed = await runArtifact(fixture.options);
    assert.equal(passed.outcome, "CONTINUE", passed.reason);
    assert.equal((await stateOf(fixture)).currentStep, "FINALIZE");
  } finally {
    await fixture.cleanup();
  }
});

test("Figma parity: DEGRADED frames cannot back acceptance and pinned evidence rejects tampering", async () => {
  const fixture = await createFixture();
  const options = {
    ...fixture.options,
    designSource: "figma-mcp",
    figma: ["https://www.figma.com/design/File123?node-id=12-34"],
  };
  try {
    await bootstrap(fixture, options);
    await advanceDiscovery(fixture, { ui: true });
    await writeJson(fixture.artifactRoot, "inventories/target.json", await targetInventory(fixture, "TARGET_REUSE"));
    await writeFigmaContext(fixture, "DEGRADED");
    assert.equal((await runArtifact(fixture.options)).outcome, "CONTINUE");
    await writeBaseline(fixture, "TARGET_REUSE");
    await writeVisualAcceptance(fixture);
    const degraded = await runArtifact(fixture.options);
    assert.match(degraded.reason, /extraction is DEGRADED/);

    const screenshot = path.join(fixture.artifactRoot, "inventories/figma/12-34/screenshot.png");
    await writeFile(screenshot, Buffer.from([137, 80, 78, 72]));
    const tampered = await getArtifactStatus(fixture.options);
    assert.notEqual(tampered.validation?.ready, true);
    assert.match(
      tampered.reason ?? tampered.validation?.reason,
      /no longer matches its recorded hash|Pinned artifact changed/,
    );
  } finally {
    await fixture.cleanup();
  }
});
