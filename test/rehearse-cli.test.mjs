import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCli } from "../scripts/rehearse.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts/rehearse.mjs");
const golden = path.join(repo, "test/golden/installed-full-lifecycle.ndjson");
const goldenHash = async () => createHash("sha256").update(await readFile(golden)).digest("hex");

const invalid = [
  ["--negative=bogus"], ["--negative=history-byte"], ["--negative", "bogus"], ["--negative"],
  ["--negative", "history-byte", "--update"], ["--update", "--negative", "history-byte"],
  ["--update=anything"], ["--unknown"], ["-u"], ["--"],
  ["--update", "--update"], ["--negative", "history-byte", "--negative", "history-byte"],
  ["extra"], ["--update", "extra"], ["--negative", "history-byte", "extra"],
  ["--negative", "__proto__"], ["--negative", "toString"],
];

test("rehearse accepts exactly its three documented forms", () => {
  assert.deepEqual(parseCli([]), { update: false, negative: null });
  assert.deepEqual(parseCli(["--update"]), { update: true, negative: null });
  for (const name of ["history-byte", "state-commit", "event-identity", "state-after-stdout"]) {
    assert.deepEqual(parseCli(["--negative", name]), { update: false, negative: name });
  }
  for (const argv of invalid) {
    assert.throws(() => parseCli(argv), /rehearse: unsupported arguments/, JSON.stringify(argv));
  }
});

test("rehearse refuses unsupported arguments before any side effect", async () => {
  const before = await goldenHash();
  for (const argv of invalid) {
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows; scratch would land here.
    const tmp = await mkdtemp(path.join(os.tmpdir(), "rehearse-cli-"));
    try {
      const run = spawnSync(process.execPath, [script, ...argv], {
        cwd: repo, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
      });
      const label = JSON.stringify(argv);
      assert.equal(run.status, 1, `${label}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /rehearse: unsupported arguments/, label);
      assert.doesNotMatch(run.stdout, /steps match|wrote \d+ steps/, label);
      assert.deepEqual(await readdir(tmp), [], `${label} created scratch`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  assert.equal(await goldenHash(), before);
});
