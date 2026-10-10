#!/usr/bin/env node
// `pnpm rehearse:negative`: corrupts one byte of the history the rehearse trace
// reads (REHEARSE_CORRUPT_HISTORY, in-memory copy only) and exits 0 only when
// the replay fails at verification, never at the golden comparison.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(process.execPath, [path.join(repo, "scripts/rehearse.mjs")], {
  cwd: repo, encoding: "utf8", env: { ...process.env, REHEARSE_CORRUPT_HISTORY: "5" },
});
const output = `${run.stdout}${run.stderr}`;
const verified = /rehearse verification: history chain broken at line \d+/.exec(output);
if (run.status === 0 || !verified || output.includes("trace differs from")) {
  console.error(`${output}\nrehearse:negative: expected a failure at verification (history chain broken); ` +
    `got exit ${run.status}`);
  process.exit(1);
}
console.log(`rehearse:negative: corrupted history refused (${verified[0]})`);
