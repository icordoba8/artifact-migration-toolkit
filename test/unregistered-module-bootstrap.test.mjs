import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getMigrationStatus } from "../packages/migration-engine/src/lifecycle/index.mjs";

const cli = fileURLToPath(new URL("../packages/migration-engine/src/cli/discover-module.mjs", import.meta.url));
const spec = [
  "# Partners", "",
  "### Requirement: PARTNERS-REQ-001 Partner lookup",
  "The target MUST return partner records matching the requested identifier.", "",
  "#### Scenario: PARTNERS-SCN-001 Existing partner",
  "A request for a known partner returns the corresponding record.", "",
].join("\n");
const invalid = spec.replace("MUST return", "returns");

test("fresh unregistered module bootstrap refuses invalid OpenSpec without writes and accepts a corrected proposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unregistered bootstrap "));
  const legacy = path.join(root, "legacy");
  const target = path.join(root, "target");
  const registry = path.join(target, ".agents/knowledge/migrations/registry.json");
  const record = path.join(target, ".agents/knowledge/migrations/modules/partners/state.json");
  const authority = path.join(target, "openspec/specs/partners/spec.md");
  try {
    await mkdir(path.join(legacy, "partners"), { recursive: true });
    await mkdir(path.join(target, "src"), { recursive: true });
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(path.join(legacy, "partners/marker.txt"), "partner fixture\n");
    await writeFile(path.join(target, "package.json"), '{"name":"unregistered-consumer","private":true}\n');
    await writeFile(registry, JSON.stringify({
      version: 1,
      projects: {
        legacy: { root: path.relative(path.dirname(registry), legacy) },
        target: { root: path.relative(path.dirname(registry), target) },
      },
      modules: {},
    }, null, 2) + "\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Acceptance Test", "-c",
      "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });

    const before = await getMigrationStatus({ registryPath: registry, moduleName: "partners" });
    assert.equal(before.status, "NOT_STARTED");
    assert.equal(before.initialized, false);
    assert.equal(before.progress, null);
    assert.match(before.progressChecklist, /no persisted record/);
    await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" });

    const run = spawnSync(process.execPath,
      [fileURLToPath(new URL("../packages/migration-engine/src/cli/run-migration.mjs", import.meta.url)),
        "partners", "--registry", registry, "--target", "partners", "--mode", "auto"],
      { cwd: target, encoding: "utf8" });
    assert.match(run.stdout, /artifact-migration-discover partners --target partners --openspec-proposal-stdin/);
    assert.match(run.stdout, /loop: STOP reason=BLOCKED/);
    await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" });

    const invoke = content => spawnSync(process.execPath,
      [cli, "partners", "--registry", registry, "--target", "partners",
        "--mode", "auto", "--openspec-proposal-stdin"],
      { cwd: target, input: content, encoding: "utf8" });
    const invalidRun = invoke(invalid);
    assert.notEqual(invalidRun.status, 0, "invalid OpenSpec was accepted");
    assert.match(invalidRun.stderr + invalidRun.stdout, /must use SHALL or MUST\. Expected form: /);
    await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(authority, "utf8"), { code: "ENOENT" });

    const validRun = invoke(spec);
    assert.equal(validRun.status, 0, validRun.stderr + validRun.stdout);
    const state = JSON.parse(await readFile(record, "utf8"));
    assert.equal(state.targetModule, "partners");
    assert.equal(state.currentStep, "DISCOVER_LEGACY");
    assert.ok(state.completedSteps.includes("RESOLVE"));
    assert.equal(await readFile(authority, "utf8"), spec);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
