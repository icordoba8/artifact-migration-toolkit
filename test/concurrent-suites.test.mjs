import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = path.join(root, "packages/migration-engine/build-identity.json");
const scratchRoots = async (tag) => (await readdir(os.tmpdir()))
  .filter((name) => name.startsWith(`migration-tests-${tag}`));
const run = (script, file, tag) => {
  const child = spawn(process.execPath, [path.join(root, script), file], {
    cwd: root, env: { ...process.env, AMT_TEST_ROOT_TAG: tag },
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  return { child, done: new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  }) };
};

test("engine and Vitest overlap without touching source identity", async () => {
  const tag = `${randomUUID()}-`;
  const before = await scratchRoots(tag);
  const node = run("scripts/engine-test.mjs",
    "packages/migration-engine/test/unit/toolkit-identity.test.mjs", tag);
  const ts = run("scripts/engine-test-ts.mjs",
    "packages/migration-engine/test/integration/artifact/history-persistence.integration.spec.ts", tag);
  let sourceIdentitySeen = false;
  const sample = setInterval(async () => {
    if (await access(identity).then(() => true, () => false)) sourceIdentitySeen = true;
  }, 25);
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(node.child.exitCode, null, "engine runner must still be active");
    assert.equal(ts.child.exitCode, null, "Vitest runner must still be active");
    // A `file://` URL, not a path: the ESM loader reads a Windows absolute path
    // as a URL whose scheme is the drive letter, so `D:\...` here fails to
    // resolve before the fixture runs at all. POSIX absolute paths resolve by
    // accident, which is what kept this Windows-only.
    const fixture = spawn(process.execPath, ["--input-type=module", "-e",
      `import { createUnstampedRecord } from ${JSON.stringify(pathToFileURL(path.join(root,
        "packages/migration-engine/test/support/consumer-fixture.mjs")).href)};
       import { readFile } from 'node:fs/promises';
       const record = await createUnstampedRecord();
       try { const state = JSON.parse(await readFile(record.statePath));
         if (state.toolkitIdentity !== undefined) process.exitCode = 1;
       } finally { await record.cleanup(); }`], { cwd: root });
    // Relayed, because a crashed fixture also exits non-zero: without its
    // stderr a failed import is indistinguishable from a stamped record.
    let fixtureOutput = "";
    fixture.stderr.on("data", (data) => { fixtureOutput += data; });
    const fixtureCode = await new Promise((resolve, reject) => {
      fixture.on("error", reject);
      fixture.on("exit", resolve);
    });
    assert.equal(fixtureCode, 0, `source consumer remains UNSTAMPED\n${fixtureOutput}`);
    const [a, b] = await Promise.all([node.done, ts.done]);
    assert.equal(a.code, 0, a.output.slice(-4000));
    assert.equal(b.code, 0, b.output.slice(-4000));
    assert.equal(sourceIdentitySeen, false);
    assert.deepEqual(await scratchRoots(tag), before, "this test's scratch roots are removed");
  } finally {
    clearInterval(sample);
    if (node.child.exitCode === null) node.child.kill();
    if (ts.child.exitCode === null) ts.child.kill();
  }
});
