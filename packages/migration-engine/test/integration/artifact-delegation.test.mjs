import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  artifactBindingFor,
  artifactPrerequisiteWork,
  assertArtifactPrerequisites,
  delegatedChangedFilesSatisfiedByChild,
  validateArtifactDelegationRow,
} from "../../src/resumable-migration.mjs";
import {
  artifactIdFor,
  artifactRoot,
  getArtifactStatus,
  runArtifact,
} from "../../src/artifact/artifact-migration.mjs";
import { runArtifactCli } from "../../src/artifact/run-artifact.mjs";
import { runRecordDecisionCli } from "../../src/record-decision.mjs";

const execFileAsync = promisify(execFile);
const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);
const digest = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-delegation-"));
  const legacyRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  await mkdir(path.join(legacyRoot, "shared"), { recursive: true });
  await mkdir(path.join(targetRoot, "src/shared"), { recursive: true });
  await writeFile(
    path.join(legacyRoot, "shared/widget.ts"),
    "export const widget = true;\n",
  );
  await writeFile(
    path.join(legacyRoot, "shared/other.ts"),
    "export const other = true;\n",
  );
  await writeFile(
    path.join(targetRoot, "src/shared/widget.ts"),
    "export const widget = false;\n",
  );
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Delegation Test",
      "-c",
      "user.email=delegation@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return {
    root,
    legacyRoot,
    targetRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const sharedRow = (extra = {}) => ({
  id: "CAP-S",
  classification: "SHARED_PREREQUISITE",
  targetOwner: "src/shared",
  artifactMigration: {
    source: "shared/widget.ts",
    type: "component",
    target: "src/shared/widget.ts",
  },
  ...extra,
});

const state = (extra = {}) => ({
  formatVersion: 13,
  legacyModule: "auth",
  activeSlice: "shared-a",
  ...extra,
});

const otherSharedRow = (extra = {}) =>
  sharedRow({
    id: "CAP-OTHER",
    artifactMigration: {
      source: "shared/other.ts",
      type: "component",
      target: "src/shared/other.ts",
    },
    ...extra,
  });

const plan = (rows = [sharedRow()], slices = null) => ({
  capabilityRows: rows,
  slices:
    slices ??
    [{ id: "shared-a", capabilityIds: rows.map((row) => row.id) }],
});

const manifest = async (root, prefix = "") => {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await manifest(absolute, relative));
    else result[relative] = await readFile(absolute, "utf8");
  }
  return result;
};

test("format 13 requires artifactMigration on SHARED_PREREQUISITE", async () => {
  const current = await fixture();
  try {
    await assert.rejects(
      validateArtifactDelegationRow(
        { ...sharedRow(), artifactMigration: undefined },
        state(),
        current,
      ),
      /requires artifactMigration/,
    );
  } finally {
    await current.cleanup();
  }
});

test("format 12 does not require artifactMigration", async () => {
  const current = await fixture();
  try {
    assert.equal(
      await validateArtifactDelegationRow(
        { ...sharedRow(), artifactMigration: undefined },
        state({ formatVersion: 12 }),
        current,
      ),
      null,
    );
  } finally {
    await current.cleanup();
  }
});

test("delegated completion replaces changedFiles only for format 13", () => {
  const rows = [sharedRow()];
  assert.equal(
    delegatedChangedFilesSatisfiedByChild(state(), ["CAP-S"], rows),
    true,
  );
  assert.equal(
    delegatedChangedFilesSatisfiedByChild(
      state({ formatVersion: 12 }),
      ["CAP-S"],
      rows,
    ),
    false,
  );
});

test("a target outside targetOwner is refused", async () => {
  const current = await fixture();
  try {
    await assert.rejects(
      artifactBindingFor(
        sharedRow({
          targetOwner: "src/shared/widget",
          artifactMigration: {
            ...sharedRow().artifactMigration,
            target: "src/elsewhere/widget.ts",
          },
        }),
        current,
      ),
      /must equal targetOwner.*or be inside it/,
    );
  } finally {
    await current.cleanup();
  }
});

test("two modules naming the same source and type derive one id", async () => {
  const current = await fixture();
  try {
    const first = await artifactBindingFor(sharedRow(), current);
    const second = await artifactBindingFor(
      { ...sharedRow(), id: "CAP-OTHER" },
      current,
    );
    assert.equal(first.artifactId, second.artifactId);
    assert.equal(
      first.artifactId,
      artifactIdFor({ source: "shared/widget.ts", type: "component" }),
    );
  } finally {
    await current.cleanup();
  }
});

test("a missing prerequisite becomes RUN_ARTIFACT work", async () => {
  const current = await fixture();
  try {
    const work = await artifactPrerequisiteWork(state(), current, plan());
    assert.equal(work.outcome, "CONTINUE");
    assert.equal(work.nextWorkKind, "RUN_ARTIFACT");
    assert.match(work.artifactMigration.command, /--source-root/);
    await assert.rejects(
      assertArtifactPrerequisites(state(), current, plan()),
      /NOT_STARTED/,
    );
  } finally {
    await current.cleanup();
  }
});

test("AUTO runs one child iteration without mutating parent state", async () => {
  const current = await fixture();
  try {
    const parent = state();
    const before = structuredClone(parent);
    const work = await artifactPrerequisiteWork(parent, current, plan());
    const output = [];
    const child = await runArtifactCli(work.artifactMigration.arguments, {
      stdout: { write: (chunk) => (output.push(String(chunk)), true) },
      emitDirective: false,
    });
    assert.equal(child.outcome, "CONTINUE");
    assert.equal(
      (await getArtifactStatus(work.artifactMigration)).status,
      "ACTIVE",
    );
    assert.deepEqual(parent, before);
    assert.doesNotMatch(output.join(""), /loop:/);
  } finally {
    process.exitCode = 0;
    await current.cleanup();
  }
});

test("STEP exposes the child command without creating child state", async () => {
  const current = await fixture();
  try {
    const work = await artifactPrerequisiteWork(state(), current, plan());
    const before = await manifest(current.targetRoot);
    assert.match(work.artifactMigration.command, /^\/migrate-artifact /);
    assert.equal(
      (await getArtifactStatus(work.artifactMigration)).status,
      "NOT_STARTED",
    );
    assert.deepEqual(await manifest(current.targetRoot), before);
    const driver = await readFile(path.join(scriptsRoot, "cli/run-migration.mjs"), "utf8");
    assert.match(
      driver,
      /if \(options\.mode === "step"\)[\s\S]*return finish\("CONTINUE"/,
    );
  } finally {
    await current.cleanup();
  }
});

test("no SHARED_PREREQUISITE means no artifact gate", async () => {
  const current = await fixture();
  try {
    const local = { id: "CAP-L", classification: "FEATURE_LOCAL" };
    assert.deepEqual(
      await artifactPrerequisiteWork(state(), current, plan([local])),
      { outcome: "COMPLETE" },
    );
  } finally {
    await current.cleanup();
  }
});

test("a binding mismatch blocks the parent", async () => {
  const current = await fixture();
  try {
    await runArtifact({
      source: "shared/widget.ts",
      type: "component",
      target: "src/shared/widget.ts",
      sourceRoot: current.legacyRoot,
      targetRoot: current.targetRoot,
    });
    const mismatched = sharedRow({
      artifactMigration: {
        ...sharedRow().artifactMigration,
        target: "src/shared/other.ts",
      },
    });
    const work = await artifactPrerequisiteWork(
      state(),
      current,
      plan([mismatched]),
    );
    assert.equal(work.outcome, "BLOCKED");
    assert.match(work.reason, /target conflicts with persisted state/);
  } finally {
    await current.cleanup();
  }
});

test("a stale child blocks the parent", async () => {
  const current = await fixture();
  try {
    await runArtifact({
      source: "shared/widget.ts",
      type: "component",
      target: "src/shared/widget.ts",
      sourceRoot: current.legacyRoot,
      targetRoot: current.targetRoot,
    });
    await writeFile(
      path.join(current.legacyRoot, "shared/widget.ts"),
      "export const widget = 'drifted';\n",
    );
    const work = await artifactPrerequisiteWork(state(), current, plan());
    assert.equal(work.outcome, "BLOCKED");
    assert.match(work.reason, /STALE|drift/i);
    await assert.rejects(
      assertArtifactPrerequisites(state(), current, plan()),
      /STALE|drift/i,
    );
    await assert.rejects(
      assertArtifactPrerequisites(state(), current, { ...plan(), all: true }),
      /STALE|drift/i,
    );
    const engine = await readFile(
      path.join(scriptsRoot, "resumable-migration.mjs"),
      "utf8",
    );
    assert.equal((engine.match(/await assertArtifactPrerequisites\(/g) ?? []).length, 2);
  } finally {
    await current.cleanup();
  }
});

test("a genuinely blocked child blocks the parent", async () => {
  const current = await fixture();
  try {
    const created = await runArtifact({
      source: "shared/widget.ts",
      type: "component",
      target: "src/shared/widget.ts",
      sourceRoot: current.legacyRoot,
      targetRoot: current.targetRoot,
    });
    await writeFile(
      path.join(artifactRoot(current.targetRoot, created.artifactId), "transaction.json"),
      "not-json\n",
    );
    const work = await artifactPrerequisiteWork(state(), current, plan());
    assert.equal(work.outcome, "BLOCKED");
    assert.match(work.reason, /BLOCKED|JSON/i);
  } finally {
    await current.cleanup();
  }
});

test("two parents reuse one artifact without mutating it", async () => {
  const current = await fixture();
  try {
    await runArtifact({
      source: "shared/widget.ts",
      type: "component",
      target: "src/shared/widget.ts",
      sourceRoot: current.legacyRoot,
      targetRoot: current.targetRoot,
    });
    const before = await manifest(current.targetRoot);
    await artifactPrerequisiteWork(state({ legacyModule: "auth" }), current, plan());
    await artifactPrerequisiteWork(state({ legacyModule: "roles" }), current, plan());
    assert.deepEqual(await manifest(current.targetRoot), before);
  } finally {
    await current.cleanup();
  }
});

test("module-level prerequisite order selects B before A and never nests artifacts", async () => {
  const current = await fixture();
  try {
    const rows = [
      { ...sharedRow(), id: "CAP-B" },
      { ...otherSharedRow(), id: "CAP-A" },
    ];
    const slices = [
      { id: "shared-b", capabilityIds: ["CAP-B"], dependencies: [] },
      { id: "shared-a", capabilityIds: ["CAP-A"], dependencies: ["shared-b"] },
      {
        id: "feature",
        capabilityIds: [],
        dependencies: ["shared-b", "shared-a"],
      },
    ];
    const work = await artifactPrerequisiteWork(
      state({ activeSlice: "shared-a" }),
      current,
      plan(rows, slices),
    );
    assert.equal(work.artifactMigration.artifactId, artifactIdFor({
      source: "shared/widget.ts",
      type: "component",
    }));
    assert.equal("parents" in work.artifactMigration, false);
  } finally {
    await current.cleanup();
  }
});

test("independent prerequisites follow module declaration order without inventing a dependency", async () => {
  const current = await fixture();
  try {
    const rows = [otherSharedRow({ id: "CAP-A" }), sharedRow({ id: "CAP-B" })];
    const slices = [
      { id: "shared-b", capabilityIds: ["CAP-B"], dependencies: [] },
      { id: "shared-a", capabilityIds: ["CAP-A"], dependencies: [] },
      {
        id: "feature",
        capabilityIds: [],
        dependencies: ["shared-a", "shared-b"],
      },
    ];
    const work = await artifactPrerequisiteWork(
      state({ activeSlice: "feature" }),
      current,
      plan(rows, slices),
    );
    assert.equal(work.artifactMigration.source, "shared/widget.ts");
    assert.deepEqual(slices[0].dependencies, []);
    assert.deepEqual(slices[1].dependencies, []);
  } finally {
    await current.cleanup();
  }
});

test("MCP exposes no artifact tool and trusted decisions are transport-bound", async () => {
  const mcp = await readFile(path.join(scriptsRoot, "mcp-server.mjs"), "utf8");
  const driver = await readFile(path.join(scriptsRoot, "cli/run-migration.mjs"), "utf8");
  const artifact = await readFile(
    path.join(scriptsRoot, "artifact/artifact-migration.mjs"),
    "utf8",
  );
  const boundary = await readFile(
    path.join(scriptsRoot, "operator-approval.mjs"),
    "utf8",
  );
  assert.doesNotMatch(mcp, /name:\s*["']artifact_/);
  assert.match(mcp, /recordTrustedDecision/);
  assert.match(driver, /recordTrustedDecision/);
  assert.match(driver, /from "\.\.\/operator-approval\.mjs"/);
  assert.match(artifact, /from "\.\.\/operator-approval\.mjs"/);
  assert.equal((boundary.match(/export const approveWithOperator/g) ?? []).length, 1);
  assert.doesNotMatch(mcp, /approve:\s*\{\s*type:/);
});

test("OPERATOR-CHILD uses the trusted recorder and rejects wrong or replayed challenges", async () => {
  const current = await fixture();
  try {
    const options = {
      source: "shared/widget.ts",
      type: "component",
      target: "src/shared/widget.ts",
      sourceRoot: current.legacyRoot,
      targetRoot: current.targetRoot,
    };
    const bootstrapped = await runArtifact(options);
    const root = artifactRoot(current.targetRoot, bootstrapped.artifactId);
    await writeJson(path.join(root, "inventories/source.json"), {
      version: 1,
      artifactId: bootstrapped.artifactId,
      hasVisibleUi: false,
      sourceFiles: ["shared/widget.ts"],
      behaviors: [
        {
          id: "B-1",
          description: "The shared widget remains available.",
          visible: false,
          evidence: [
            {
              path: "shared/widget.ts",
              sha256: await digest(path.join(current.legacyRoot, "shared/widget.ts")),
              status: "VERIFIED",
            },
          ],
        },
      ],
      globalContracts: [],
      featureLocalVisuals: [],
      operatorDecisions: [
        { id: "OD-1", subject: "Approve the bounded shared-widget decision." },
      ],
    });
    // The human-authority guarantee is a `--mode step` guarantee; AUTO decides
    // on its own ledger. See `test/unit/auto-authority.test.mjs`.
    const pending = await runArtifact({ ...options, mode: "step" });
    assert.equal(pending.outcome, "OPERATOR_DECISION");
    const candidateId = pending.pendingDecisions[0].candidateId;
    const decisionArguments = [
      "--artifact",
      options.source,
      "--type",
      options.type,
      "--source-root",
      options.sourceRoot,
      "--target-root",
      options.targetRoot,
      "--approve",
      candidateId,
    ];
    const ledger = path.join(root, "decisions/operator-decisions.ndjson");

    const unavailable = await runRecordDecisionCli(decisionArguments);
    assert.equal(unavailable.blocked, true);
    await assert.rejects(readFile(ledger, "utf8"), /ENOENT/);
    process.exitCode = 0;

    const wrong = await runRecordDecisionCli(decisionArguments, {
      stdout: { write: () => true },
      ask: async () => "wrong challenge",
    });
    assert.equal(wrong.blocked, true);
    await assert.rejects(readFile(ledger, "utf8"), /ENOENT/);
    process.exitCode = 0;

    const recorded = await runRecordDecisionCli(decisionArguments, {
      stdout: { write: () => true },
      ask: async ({ challenge }) => challenge,
    });
    assert.ok(recorded.decision);
    assert.equal((await readFile(ledger, "utf8")).trim().split("\n").length, 1);
    await assert.rejects(
      runRecordDecisionCli(decisionArguments, {
        stdout: { write: () => true },
        ask: async ({ challenge }) => challenge,
      }),
      /stale or is not pending/,
    );
    assert.equal((await readFile(ledger, "utf8")).trim().split("\n").length, 1);
  } finally {
    process.exitCode = 0;
    await current.cleanup();
  }
});

test("OPERATOR-MCP routes parent and child decisions through one host recorder", async () => {
  const mcp = await readFile(path.join(scriptsRoot, "mcp-server.mjs"), "utf8");
  const driver = await readFile(path.join(scriptsRoot, "cli/run-migration.mjs"), "utf8");
  assert.equal((mcp.match(/recordTrustedDecision:/g) ?? []).length, 1);
  assert.match(mcp, /trustedDecisionRecorder\(session, buffer\)/);
  assert.match(driver, /artifactApprover\(recorder, binding\)/);
  assert.match(driver, /approveWithOperator\([\s\S]*artifactApprover/);
  assert.doesNotMatch(mcp, /artifact.*inputSchema/i);
});
