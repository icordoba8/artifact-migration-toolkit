// Track A10: the engine-wide architecture gate (scripts/check-architecture.mjs,
// docs/architecture/a10-tests.md). The real tree passes, and every rule fails on
// a one-edit copy that breaks it, with a diagnostic naming the rule, file and edge.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkArchitecture, format } from "../scripts/check-architecture.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = "packages/migration-engine";
const SRC = `${ENGINE}/src`;

test("A10-ARCH: the repository passes the architecture gate", async () => {
  const { violations, stats } = await checkArchitecture({ root: repo });
  assert.deepEqual(violations.map(format), []);
  // Not vacuous: the scan saw the whole engine, the provider trees and the tests.
  assert.ok(stats.sourceFiles >= 119 && stats.edges >= 600 && stats.providerFiles >= 60 && stats.testFiles >= 60, JSON.stringify(stats));
});

/** One-edit mutations. Each must produce a violation of `rule` at `file` whose subject matches `subject`. */
const append = (file, text) => async (root) => writeFile(path.join(root, file), `${await readFile(path.join(root, file), "utf8")}${text}`);
const prepend = (file, text) => async (root) => writeFile(path.join(root, file), `${text}${await readFile(path.join(root, file), "utf8")}`);
const create = (file, text) => async (root) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};
const scripts = (edit) => async (root) => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  edit(manifest.scripts);
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
};

const CASES = [
  ["A10-ARCH-1", "an entry that declares", append(`${SRC}/lifecycle/index.mjs`, "export const leaked = 1;\n"), "lifecycle/index.mjs", /leaked/],
  ["A10-ARCH-1", "an entry that re-exports another module", append(`${SRC}/slices/index.mjs`, 'export { readJson } from "../store/index.mjs";\n'), "slices/index.mjs", /store/],
  ["A10-ARCH-2", "a module internal named from outside", prepend(`${SRC}/transport/run.mjs`, 'import { readState } from "../lifecycle/record.mjs";\n'), "transport/run.mjs:1", /^import -> lifecycle\/record\.mjs$/],
  ["A10-ARCH-2", "a bin that loads a second command file", prepend(`${SRC}/cli/run-migration.mjs`, 'import "../transport/mcp.mjs";\n'), "cli/run-migration.mjs:1", /transport\/mcp\.mjs/],
  ["A10-ARCH-3", "an upward lazy import (dynamic is not safe)", append(`${SRC}/formats/record.mjs`, 'export const later = () => import("../decisions/index.mjs");\n'), "formats/record.mjs", /^dynamic -> decisions\/index\.mjs$/],
  ["A10-ARCH-3", "a domain module importing transport", append(`${SRC}/store/files.mjs`, 'export { startCommand } from "../transport/index.mjs";\n'), "store/files.mjs", /^export -> transport\/index\.mjs$/],
  ["A10-ARCH-3", "an unclassified engine file", create(`${SRC}/new-helper.mjs`, "export const helper = 1;\n"), "new-helper.mjs", /unclassified/],
  ["A10-ARCH-4", "a lazy cycle inside a module", async (root) => {
    await create(`${SRC}/shared/a10-a.mjs`, 'export const a = () => import("./a10-b.mjs");\n')(root);
    await create(`${SRC}/shared/a10-b.mjs`, 'import "./a10-a.mjs";\n')(root);
  }, "shared/a10-a.mjs", /^lazy cycle/],
  ["A10-ARCH-4", "a computed engine import", append(`${SRC}/census/scan.mjs`, "export const any = (name) => import(name);\n"), "census/scan.mjs", /computed/],
  ["A10-ARCH-5", "a facade that grows an implementation", append(`${SRC}/resumable-migration.mjs`, "export const shadow = () => 1;\n"), "resumable-migration.mjs", /declares shadow/],
  ["A10-ARCH-5", "a second live definition of a module export", append(`${SRC}/lifecycle/policy.mjs`, "const canonicalJson = 1;\n"), "shared/digest.mjs", /canonicalJson also declared in lifecycle\/policy\.mjs/],
  ["A10-ARCH-6", "engine source copied into a provider tree", create("providers/claude/skills/start-migration/scripts/engine.mjs", "export {};\n"), "providers/claude/skills/start-migration/scripts/engine.mjs", /executable/],
  ["A10-ARCH-6", "an installer that imports the engine", prepend("providers/codex/install.mjs", 'import "../../packages/migration-engine/src/core.mjs";\n'), "providers/codex/install.mjs:1", /core\.mjs/],
  ["A10-ARCH-6", "a runtime.mjs that drifts from the bootstrap", append("providers/opencode/skills/migrate-artifact/scripts/runtime.mjs", "// drift\n"), "providers/opencode/skills/migrate-artifact/scripts/runtime.mjs", /^bytes$/],
  ["A10-SRC-1", "a new filesystem writer outside store/", prepend(`${SRC}/transport/run.mjs`, 'import { writeFile } from "node:fs/promises";\n'), "transport/run.mjs", /fs writeFile/],
  ["A10-SRC-1", "a namespace fs import in a domain module", prepend(`${SRC}/visual/proof.mjs`, 'import * as fs from "node:fs";\n'), "visual/proof.mjs", /fs \*/],
  ["A10-SRC-2", "a second process-entry check", append(`${SRC}/lifecycle/policy.mjs`, "if (isMainModule(import.meta.url)) process.exit(0);\n"), "lifecycle/policy.mjs", /isMainModule/],
  ["A10-SIZE-1", "an oversized file that grows", append(`${SRC}/census/scan.mjs`, "\n"), "census/scan.mjs", /2315 lines/],
  ["A10-TEST-1", "a test that imports a module internal", prepend(`${ENGINE}/test/unit/slices.test.mjs`, 'import "../../src/slices/drift.mjs";\n'), `${ENGINE}/test/unit/slices.test.mjs:1`, /slices\/drift\.mjs/],
  ["A10-TEST-1", "a domain test that goes back to a historical facade", prepend(`${ENGINE}/test/unit/slices.test.mjs`, 'import { readState } from "../../src/resumable-migration.mjs";\n'), `${ENGINE}/test/unit/slices.test.mjs:1`, /resumable-migration\.mjs/],
  ["A10-TEST-1", "a computed import in an ordinary test", append(`${ENGINE}/test/unit/content-identity.test.mjs`, "const any = (name) => import(name);\n"), `${ENGINE}/test/unit/content-identity.test.mjs`, /computed/],
  ["A10-TEST-2", "an engine suite dropped from engine:test", scripts((s) => { s["engine:test"] = s["engine:test"].replace(` ${ENGINE}/test/unit/census.test.mjs`, ""); }), `${ENGINE}/test/unit/census.test.mjs`, /engine:test/],
  ["A10-TEST-2", "a support module registered as a suite", scripts((s) => { s["engine:test"] += ` ${ENGINE}/test/support/portability.mjs`; }), `${ENGINE}/test/support/portability.mjs`, /engine:test/],
  ["A10-TEST-2", "a suite registered twice", scripts((s) => { s["engine:test"] += ` ${ENGINE}/test/unit/slices.test.mjs`; }), `${ENGINE}/test/unit/slices.test.mjs`, /engine:test/],
  ["A10-TEST-2", "a root suite missing from providers:test", create("test/a10-orphan.test.mjs", "export {};\n"), "test/a10-orphan.test.mjs", /providers:test/],
  ["A10-OWN-1", "a guarantee with two owners", async (root) => {
    const file = path.join(root, "OWNERSHIP.md");
    const text = await readFile(file, "utf8");
    const row = text.split("\n").find((line) => line.startsWith("| G12 |"));
    await writeFile(file, text.replace(row, `${row}\n${row.replace("| G12 |", "| G99 |").replace("`lifecycle/`", "`store/`")}`));
  }, "OWNERSHIP.md", /^Module locking$/],
  ["A10-OWN-1", "an adversarial reference to a test that does not exist", async (root) => {
    const file = path.join(root, "OWNERSHIP.md");
    await writeFile(file, (await readFile(file, "utf8")).replace('"P1-1: a hand-edited currentStep contradicts the append-only history"', '"P1-1: a hand-edited currentStep is fine"'));
  }, "OWNERSHIP.md", /P1-1: a hand-edited currentStep is fine/],
  ["A10-OWN-1", "an owner that is not a module", async (root) => {
    const file = path.join(root, "OWNERSHIP.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("| G7 | Slice ownership | `slices/` |", "| G7 | Slice ownership | `slicing/` |"));
  }, "OWNERSHIP.md", /^G7 owner/],
];

/** A copy of exactly what the gate reads, with the engine's installed parser. */
const gateCopy = async (t, prefix) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of [`${ENGINE}/package.json`, SRC, `${ENGINE}/test`, "providers", "test", "scripts/runtime-bootstrap.mjs", "scripts/engine-test.mjs", "package.json", "vitest.config.ts", "OWNERSHIP.md", "docs/architecture"]) {
    await cp(path.join(repo, entry), path.join(root, entry), { recursive: true, verbatimSymlinks: true });
  }
  await symlink(path.join(repo, ENGINE, "node_modules"), path.join(root, ENGINE, "node_modules"), "junction");
  return root;
};

test("A10-ARCH: every rule fails on the edit that breaks it, naming rule, file and edge", async (t) => {
  const root = await gateCopy(t, "a10 arch ");
  assert.deepEqual((await checkArchitecture({ root })).violations.map(format), [], "the copy starts clean");

  for (const [rule, name, edit, file, subject] of CASES) {
    await t.test(`${rule}: ${name}`, async () => {
      const scratch = await mkdtemp(path.join(os.tmpdir(), "a10 case "));
      try {
        await cp(root, scratch, { recursive: true, verbatimSymlinks: true });
        await edit(scratch);
        const { violations } = await checkArchitecture({ root: scratch });
        const hit = violations.find((v) => v.rule === rule && (v.file === file || v.file.startsWith(`${file}:`)) && subject.test(v.subject));
        assert.ok(hit, `${rule} at ${file} ~ ${subject}; got:\n${violations.map(format).join("\n")}`);
        // A10-ARCH-7: the line names the rule, the file and the edge, and says what to do.
        assert.match(format(hit), new RegExp(`^\\[${rule}\\] ${hit.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .+: .+$`));
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }
});

test("A10-ARCH-7: the CLI exits 1 and prints one diagnostic per violation", async (t) => {
  const root = await gateCopy(t, "a10 cli ");
  const script = path.join(repo, "scripts/check-architecture.mjs");
  const clean = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^architecture: ok \(/);
  await prepend(`${SRC}/transport/run.mjs`, 'import { readState } from "../lifecycle/record.mjs";\n')(root);
  const broken = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, "");
  assert.match(broken.stderr, /^\[A10-ARCH-2\] transport\/run\.mjs:1: import -> lifecycle\/record\.mjs: outside lifecycle\/, import lifecycle\/index\.mjs$/m);
  assert.match(broken.stderr, /^architecture: 1 violation\(s\)\.$/m);
});
