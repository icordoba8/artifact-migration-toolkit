/**
 * Proves the CI shard plan and the local tiers each run every registered test
 * file exactly once, read from the real workflow and package.json.
 *
 *   node scripts/check-shards.mjs <shard count>
 *
 * CI: shard k runs every `ubuntu` step whose `if` is absent or names k; a
 * `pnpm <script>` step runs that script's files. Across shards 1..N, every
 * `engine:test` and `providers:test` file must run exactly once, and the
 * engine, TypeScript, replay and architecture steps each in exactly one shard.
 * Local: `test:fast` + `test:heavy` must run the same files, each exactly once.
 *
 * ponytail: `if:` conditions are matched as the literal `matrix.shard == k`; any
 * other condition fails the check rather than being guessed at.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

const shards = Number(process.argv[2]);
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const steps = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs.ubuntu.steps;
const testFiles = (command) => command.split(/\s+/).filter((t) => /\.(test|spec)\.mjs$/.test(t));
const errors = [];
const once = (label, files, expected) => {
  const seen = new Map();
  for (const file of files) seen.set(file, (seen.get(file) ?? 0) + 1);
  for (const file of expected) if (seen.get(file) !== 1) errors.push(`${label}: ${file} runs ${seen.get(file) ?? 0} times`);
  for (const file of seen.keys()) if (!expected.includes(file)) errors.push(`${label}: ${file} is not a registered suite`);
};
const registered = [...testFiles(scripts["engine:test"]), ...testFiles(scripts["providers:test"])];

if (scripts[`providers:test:${shards + 1}`] !== undefined) errors.push(`providers:test:${shards + 1} exists beyond ${shards} shards`);

const ran = [];
const singletons = { "engine:test": 0, "engine:test:ts": 0, "rehearse": 0, "rehearse:negative": 0, "architecture:check": 0 };
for (let k = 1; k <= shards; k++) {
  for (const step of steps) {
    if (step.if !== undefined) {
      const m = /^\$\{\{ matrix\.shard == (\d+) \}\}$/.exec(step.if);
      if (!m) { errors.push(`unrecognized step condition: ${step.if}`); continue; }
      if (Number(m[1]) !== k) continue;
    }
    const m = /^pnpm ([\w:.-]+)$/.exec(String(step.run ?? "").trim().replace("${{ matrix.shard }}", String(k)));
    if (!m) continue;
    if (m[1] in singletons) singletons[m[1]]++;
    if (m[1] === "engine:test" || m[1].startsWith("providers:test:")) ran.push(...testFiles(scripts[m[1]] ?? ""));
  }
}
once(`CI shards 1..${shards}`, ran, registered);
for (const [name, count] of Object.entries(singletons)) if (count !== 1) errors.push(`'pnpm ${name}' runs in ${count} shards, not exactly one`);

once("test:fast + test:heavy", testFiles(`${scripts["test:fast"]} ${scripts["test:heavy"]}`), registered);
const ts = `${scripts["test:fast"]} ${scripts["test:heavy"]}`.split("scripts/engine-test-ts.mjs").length - 1;
if (ts !== 1) errors.push(`test:fast + test:heavy run scripts/engine-test-ts.mjs ${ts} times, not once`);

if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}
console.log(`${registered.length} suites: each runs once across ${shards} CI shards and once across test:fast + test:heavy.`);
