#!/usr/bin/env node
/**
 * `pnpm rehearse`: an LLM-free, deterministic replay of the installed
 * lifecycle fixture (test/installed-full-lifecycle.test.mjs), compared step by
 * step with test/golden/installed-full-lifecycle.ndjson.
 *
 *   pnpm rehearse            replay and compare; exit 1 on any difference
 *   pnpm rehearse --update   replay and rewrite the golden trace
 *   pnpm rehearse --negative <case>   corrupt what one step reads (NEGATIVE
 *                            below); used only by `pnpm rehearse:negative`
 *
 * Determinism comes from fixed inputs (rehearse-preload.mjs: clock and
 * randomUUID; pinned Git dates; no global/system Git config; an allowlisted
 * environment with a pinned operator, locale and time zone), never from
 * masking. The one exception is closed and enumerated in IDENTITY below: the
 * release identity names the commit under test and the payload hash, so it
 * changes with every commit by construction. Each identity field is first
 * compared with the identity of the release the fixture actually built (passed
 * in from `buildRelease`, never read from the record), each identity-derived
 * digest is verified against the real bytes, and only then is the field
 * replaced by a placeholder; an identity value left anywhere else fails the run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { digestToolkitIdentity } from "../packages/migration-engine/src/toolkit-identity.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = "test/installed-full-lifecycle.test.mjs";
const golden = path.join(repo, "test/golden/installed-full-lifecycle.ndjson");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// ponytail: 16 hex chars per digest keeps a step on one readable line; a
// collision would have to be engineered, not hit by a regression.
const short = (text) => (text === null ? null : sha256(text).slice(0, 16));
const HISTORY_DOMAIN = "artifact-migration-tools/module-history/v1\n";
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

// The closed list. Nothing else is ever normalized.
const IDENTITY = {
  state: ["toolkitIdentity.commit", "toolkitIdentity.contentHash"],
  historyEvent: ["toolkitIdentity.commit", "toolkitIdentity.contentHash", "hash", "previousHash"],
  integrity: ["toolkitIdentitySha256", "history.sha256", "historyChain.headHash"],
  stdout: ["stateHash"],
};
const placeholder = (field) => `<${field}>`;
const normalize = (value, fields) => {
  for (const field of fields) {
    const keys = field.split(".");
    const parent = keys.slice(0, -1).reduce((node, key) => node?.[key], value);
    if (parent?.[keys.at(-1)] != null) parent[keys.at(-1)] = placeholder(field);
  }
  return value;
};
// Re-rendering must reproduce the engine's bytes exactly, so a normalized hash
// still pins formatting, key order and every value outside the closed list.
const parseJson = (text, label) => {
  const value = JSON.parse(text);
  assert.equal(`${JSON.stringify(value, null, 2)}\n`, text, `${label} is not canonical JSON`);
  return value;
};
const parseLines = (text, label) => text.trimEnd().split("\n").map((line, index) => {
  const value = JSON.parse(line);
  assert.equal(JSON.stringify(value), line, `${label} line ${index + 1} is not canonical JSON`);
  return value;
});

/**
 * Verify every identity field against the built release and every
 * identity-derived digest on the real bytes; throw on any mismatch.
 */
const verify = ({ state, history, integrity, release }) => {
  const events = history === null ? [] : parseLines(history.toString("utf8"), "history");
  for (const [index, event] of events.entries()) {
    const { hash, ...payload } = event;
    const ok = event.seq === index + 1 &&
      event.previousHash === (index === 0 ? null : events[index - 1].hash) &&
      hash === `sha256:${sha256(`${HISTORY_DOMAIN}${canonical(payload)}`)}`;
    if (!ok) throw new Error(`rehearse verification: history chain broken at line ${index + 1}`);
  }
  const differs = (what) => { throw new Error(`rehearse verification: ${what} does not match the built release`); };
  if (state !== null && !isDeepStrictEqual(state.toolkitIdentity, release)) differs("state.toolkitIdentity");
  for (const [index, event] of events.entries()) {
    if ("toolkitIdentity" in event && !isDeepStrictEqual(event.toolkitIdentity, release)) {
      differs(`history event ${index + 1} toolkitIdentity`);
    }
  }
  if (integrity === null) return events;
  const anchor = parseJson(integrity, "integrity.json");
  const fail = (what) => { throw new Error(`rehearse verification: integrity ${what} does not match the record`); };
  if (anchor.history && (history === null || sha256(history.subarray(0, anchor.history.bytes)) !== anchor.history.sha256)) fail("history.sha256");
  if (anchor.historyChain && anchor.historyChain.headHash !== events.at(-1)?.hash) fail("historyChain.headHash");
  if (anchor.toolkitIdentitySha256 !== digestToolkitIdentity(release)) differs("integrity.toolkitIdentitySha256");
  return events;
};

// `stateHash` is sha256(state.json) and state.json carries the toolkit
// identity, so it is verified against the real bytes, then replaced.
const STATE_HASH = /("stateHash": ?"|State hash: )([0-9a-f]{64})/g;
const normalizeStdout = (stdout, stateBytes) => stdout.replace(STATE_HASH, (_match, label, hex) => {
  if (stateBytes === null || hex !== sha256(stateBytes)) {
    throw new Error(`rehearse verification: stdout stateHash ${hex} does not match state.json`);
  }
  return `${label}${placeholder(IDENTITY.stdout[0])}`;
});

const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const zeroes = "0".repeat(40);
/**
 * `pnpm rehearse:negative` only: each case corrupts an in-memory copy of what
 * one step read, consistently enough that only the named verification can
 * catch it. The record on disk is never touched.
 */
const NEGATIVE = {
  "history-byte": [5, (raw) => {
    raw.history = Buffer.from(raw.history);
    const at = raw.history.lastIndexOf('"event":"') + '"event":"'.length;
    raw.history[at] ^= 0x20;
  }],
  // The reviewer's probe: a wrong state commit with a matching identity digest.
  "state-commit": [5, (raw) => {
    const state = JSON.parse(raw.state);
    state.toolkitIdentity.commit = zeroes;
    raw.state = pretty(state);
    const anchor = JSON.parse(raw.integrity);
    anchor.toolkitIdentitySha256 = digestToolkitIdentity(state.toolkitIdentity);
    raw.integrity = pretty(anchor);
  }],
  // A wrong event identity with the chain and the integrity anchors rebuilt.
  "event-identity": [5, (raw) => {
    const events = raw.history.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    events.find((event) => event.toolkitIdentity).toolkitIdentity.commit = zeroes;
    for (const [index, event] of events.entries()) {
      event.previousHash = index === 0 ? null : events[index - 1].hash;
      const { hash: _hash, ...payload } = event;
      event.hash = `sha256:${sha256(`${HISTORY_DOMAIN}${canonical(payload)}`)}`;
    }
    raw.history = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const anchor = JSON.parse(raw.integrity);
    anchor.history.sha256 = sha256(raw.history.subarray(0, anchor.history.bytes));
    anchor.historyChain.headHash = events.at(-1).hash;
    raw.integrity = pretty(anchor);
  }],
  // state.json changed after the command printed its stateHash (first at step 12).
  "state-after-stdout": [12, (raw) => {
    const state = JSON.parse(raw.state);
    state.revision += 1;
    raw.state = pretty(state);
  }],
};

let step = 0;
/** Called by the fixture after every engine command when REHEARSE_TRACE is set. */
export const traceStep = async ({ scratch, record, release, name, args, stdout }) => {
  step += 1;
  const read = (relative) => readFile(path.join(record, relative))
    .catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  const raw = {
    state: await read("state.json"),
    operatorDecisions: await read("decisions/operator-decisions.ndjson"),
    autoDecisions: await read("decisions/auto-decisions.ndjson"),
    history: await read("history/history.ndjson"),
    integrity: await read("integrity.json"),
  };
  const [corruptAt, corrupt] = NEGATIVE[process.env.REHEARSE_NEGATIVE] ?? [];
  if (corruptAt === step) corrupt(raw);
  const state = raw.state === null ? null : parseJson(raw.state.toString("utf8"), "state.json");
  const events = verify({ state, history: raw.history, integrity: raw.integrity?.toString("utf8") ?? null, release });
  const scrub = (text) => {
    if (text === null) return null;
    for (const value of [release.commit, release.contentHash]) {
      assert.ok(!text.includes(value), `rehearse: a toolkit identity value outside the closed list:\n${text}`);
    }
    return text.replaceAll(scratch, "<SCRATCH>").replaceAll(repo, "<REPO>")
      .replace(/"pid": ?\d+/g, '"pid":"<PID>"');
  };
  const output = scrub(normalizeStdout(stdout, raw.state));
  // Kept next to the trace so a stdout difference can be read, not only seen.
  await mkdir(`${process.env.REHEARSE_TRACE}.stdout`, { recursive: true });
  await writeFile(path.join(`${process.env.REHEARSE_TRACE}.stdout`, `${String(step).padStart(2, "0")}-${name}.txt`), output);
  const at = stdout.indexOf('{\n  "outcome"');
  const result = at < 0 ? null : JSON.parse(stdout.slice(at, stdout.lastIndexOf("\nloop:")));
  const line = {
    step, command: name, args: args.map((arg) => scrub(arg)),
    outcome: result?.outcome ?? null, checkpoint: state?.currentStep ?? null,
    revision: state?.revision ?? null, reason: scrub(result?.reason ?? null),
    stdout: short(output),
    state: short(scrub(state && `${JSON.stringify(normalize(state, IDENTITY.state), null, 2)}\n`)),
    operatorDecisions: short(scrub(raw.operatorDecisions?.toString("utf8") ?? null)),
    autoDecisions: short(scrub(raw.autoDecisions?.toString("utf8") ?? null)),
    history: short(scrub(raw.history && `${events.map((event) =>
      JSON.stringify(normalize(event, IDENTITY.historyEvent))).join("\n")}\n`)),
    integrity: short(scrub(raw.integrity &&
      `${JSON.stringify(normalize(JSON.parse(raw.integrity), IDENTITY.integrity), null, 2)}\n`)),
  };
  await appendFile(process.env.REHEARSE_TRACE, `${JSON.stringify(line)}\n`);
};

/** Wall-clock costs inside the replay, reported but never compared. */
export const timing = (label, ms) =>
  appendFile(`${process.env.REHEARSE_TRACE}.timings`, `${label}\t${Math.round(ms)}\n`);

const SCRATCH_NAME = "amt-rehearse";
/** The only path rehearse ever deletes: <os.tmpdir()>/amt-rehearse, os.tmpdir() not a filesystem root. */
export const assertScratch = (scratch) => {
  const tmp = path.resolve(os.tmpdir());
  const resolved = path.resolve(scratch);
  if (tmp === path.parse(tmp).root || path.dirname(resolved) !== tmp || path.basename(resolved) !== SCRATCH_NAME) {
    throw new Error(`rehearse: refusing to delete ${resolved}; only ${path.join(tmp, SCRATCH_NAME)} ` +
      "under a non-root os.tmpdir() is allowed");
  }
  return resolved;
};

const diff = (expected, actual) => {
  const out = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
    if (expected[i] === actual[i]) continue;
    const [e, a] = [expected[i], actual[i]].map((line) => (line ? JSON.parse(line) : {}));
    out.push(`step ${i + 1} (${a.command ?? e.command}):`);
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
      if (JSON.stringify(e[key]) !== JSON.stringify(a[key])) {
        out.push(`  ${key}:`, `    - ${JSON.stringify(e[key])}`, `    + ${JSON.stringify(a[key])}`);
      }
    }
  }
  return out;
};

/**
 * The whole CLI contract, matched exactly: no arguments, `--update`, or
 * `--negative <case>`. Anything else throws before scratch or the golden is touched.
 */
export const parseCli = (argv) => {
  if (argv.length === 0) return { update: false, negative: null };
  if (argv.length === 1 && argv[0] === "--update") return { update: true, negative: null };
  if (argv.length === 2 && argv[0] === "--negative" && Object.hasOwn(NEGATIVE, argv[1])) {
    return { update: false, negative: argv[1] };
  }
  throw new Error(`rehearse: unsupported arguments ${JSON.stringify(argv)}; expected none, ` +
    `\`--update\`, or \`--negative <case>\` with <case> one of ${Object.keys(NEGATIVE).join(", ")}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = performance.now();
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const { update, negative } = cli;
  // Fixed so a rerun reuses (and first deletes) only this directory.
  const scratch = assertScratch(path.join(os.tmpdir(), SCRATCH_NAME));
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch);
  const trace = path.join(scratch, "trace.ndjson");
  const preload = pathToFileURL(path.join(repo, "scripts/rehearse-preload.mjs")).href;
  // The fixture gets this environment only, never the inherited one: the
  // operator ledger records USER@HOSTNAME, engine/runtime overrides
  // (MIGRATION_*, ARTIFACT_MIGRATION_TOOLS_*) must stay unset, and every
  // REHEARSE_* entry is set here, never forwarded from the caller's shell.
  const run = spawnSync(process.execPath, ["--test", fixture], {
    cwd: repo, stdio: "inherit", env: {
      PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, REHEARSE_TRACE: trace,
      ...(negative !== null && { REHEARSE_NEGATIVE: negative }),
      NODE_OPTIONS: `--import=${preload}`,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      USER: "rehearse", USERNAME: "rehearse", HOSTNAME: "rehearse-host", COMPUTERNAME: "rehearse-host",
      TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    },
  });
  const timings = await readFile(`${trace}.timings`, "utf8").catch(() => "");
  console.log(`rehearse: ${timings.trim().replaceAll("\t", " ms=").replaceAll("\n", ", ")}` +
    `${timings ? ", " : ""}total ms=${Math.round(performance.now() - started)}`);
  if (run.status !== 0) {
    console.error("rehearse: the lifecycle replay failed (output above)");
    process.exit(1);
  }
  const actual = (await readFile(trace, "utf8")).trimEnd().split("\n");
  if (update) {
    await mkdir(path.dirname(golden), { recursive: true });
    await writeFile(golden, `${actual.join("\n")}\n`);
    console.log(`rehearse: wrote ${actual.length} steps to ${path.relative(repo, golden)}`);
  } else {
    const expected = (await readFile(golden, "utf8")).trimEnd().split("\n");
    const out = diff(expected, actual);
    if (out.length > 0) {
      console.error(`${out.join("\n")}\nrehearse: trace differs from ${path.relative(repo, golden)} ` +
        "(review, then `pnpm rehearse --update` to accept)");
      process.exit(1);
    }
    console.log(`rehearse: ${actual.length} steps match ${path.relative(repo, golden)}`);
  }
}
