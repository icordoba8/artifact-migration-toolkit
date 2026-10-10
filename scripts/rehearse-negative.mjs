#!/usr/bin/env node
// `pnpm rehearse:negative`: replays once per case with `--negative <case>`
// (an in-memory corruption of what one step reads, see NEGATIVE in
// rehearse.mjs) and exits 0 only when every case fails at verification with
// its expected message, never at the golden comparison.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  ["history-byte", /rehearse verification: history chain broken at line \d+/],
  ["state-commit", /rehearse verification: state\.toolkitIdentity does not match the built release/],
  ["event-identity", /rehearse verification: history event \d+ toolkitIdentity does not match the built release/],
  ["state-after-stdout", /rehearse verification: stdout stateHash [0-9a-f]{64} does not match state\.json/],
];
for (const [name, expected] of cases) {
  const run = spawnSync(process.execPath, [path.join(repo, "scripts/rehearse.mjs"), "--negative", name],
    { cwd: repo, encoding: "utf8" });
  const output = `${run.stdout}${run.stderr}`;
  const verified = expected.exec(output);
  if (run.status === 0 || !verified || output.includes("trace differs from")) {
    console.error(`${output}\nrehearse:negative: ${name}: expected a failure at verification matching ` +
      `${expected}; got exit ${run.status}`);
    process.exitCode = 1;
  } else {
    console.log(`rehearse:negative: ${name}: refused at verification (${verified[0]})`);
  }
}
