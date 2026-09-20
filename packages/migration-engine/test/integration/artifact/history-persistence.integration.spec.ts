// @vitest-environment node
// Owns filesystem/process crash behavior; P1 #4 owns transition forgery rules.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { authorSource, bootstrap, createFixture, type Fixture } from "./support/fixtures";
const exec = promisify(execFile);
// Resolved from this spec, not from the working directory: the suite must run
// the same way from the repository root and from the package.
const child = fileURLToPath(new URL("./support/history-crash.mjs", import.meta.url));
const files = ["state.json", "integrity.json", "history/history.ndjson", "transaction.json"];
const fixtures: Fixture[] = [];
const backups: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await Promise.all(backups.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const snapshot = async (fixture: Fixture) => Object.fromEntries(await Promise.all(files.map(async (file) => [
  file,
  await readFile(path.join(fixture.artifactRoot, file), "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }),
])));
const run = async (fixture: Fixture, phase = "NONE") => {
  try {
    const result = await exec(process.execPath, [child, JSON.stringify(fixture.options), phase]);
    return JSON.parse(result.stdout);
  } catch (error) {
    if (phase !== "NONE" && (error as { code: number }).code === 86) return null;
    throw error;
  }
};
const phases = [
  "BEFORE_OPEN", "AFTER_OPEN", "PARTIAL_ONE", "PARTIAL_HALF", "PARTIAL_NEWLINE",
  "AFTER_WRITE", "AFTER_SYNC", "BEFORE_RENAME", "AFTER_RENAME",
];
it.each(["bootstrap", "advance"])("recovers %s across every history publication boundary", async (kind) => {
  const fixture = await createFixture();
  fixtures.push(fixture);
  if (kind === "advance") {
    await bootstrap(fixture);
    await authorSource(fixture);
  }
  // Save a real pre-transition fixture, then obtain expected bytes from normal
  // production execution at the same paths/time. Never seed a final state.
  const backup = await mkdtemp(path.join(os.tmpdir(), "history-preimage-"));
  backups.push(backup);
  await cp(fixture.root, path.join(backup, "fixture"), { recursive: true });
  const pre = await snapshot(fixture);
  expect((await run(fixture)).outcome).toBe("CONTINUE");
  const expected = await snapshot(fixture);
  for (const phase of phases) {
    await rm(fixture.root, { recursive: true, force: true });
    await cp(path.join(backup, "fixture"), fixture.root, { recursive: true });
    expect(await run(fixture, phase), phase).toBeNull();
    const interrupted = await snapshot(fixture);
    expect(interrupted["transaction.json"], phase).not.toBeNull();
    expect(interrupted["history/history.ndjson"], phase).toBe(
      phase === "AFTER_RENAME" ? expected["history/history.ndjson"] : pre["history/history.ndjson"],
    );
    // Removing the checkpoint/binding proof must block at every crash phase
    // before even opening an authority file for writing (child exits 87 if so).
    const proofFile = kind === "bootstrap"
      ? path.join(fixture.sourceRoot, "widget/source.ts")
      : path.join(fixture.artifactRoot, "inventories/source.json");
    const proofBytes = await readFile(proofFile);
    await rm(proofFile);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await run(fixture, "DENY_MUTATION")).outcome, phase).toBe("BLOCKED");
      expect(await snapshot(fixture), phase).toEqual(interrupted);
    }
    await writeFile(proofFile, proofBytes);
    // Interrupt recovery itself twice after history publication, before state.
    // The journal stays authoritative and the same event must never be appended twice.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await run(fixture, "RECOVERY_AFTER_HISTORY"), phase).toBeNull();
      expect((await snapshot(fixture))["history/history.ndjson"], phase).toBe(expected["history/history.ndjson"]);
    }
    const result = await run(fixture);
    expect(result.outcome, phase + ": " + result.reason).toBe("CONTINUE");
    expect(await snapshot(fixture), phase).toEqual(expected);
    const transaction = JSON.parse(interrupted["transaction.json"]!);
    const events = expected["history/history.ndjson"]!.trim().split("\n").map((line: string) => JSON.parse(line));
    expect(events.filter((event: { digest: string }) => event.digest === transaction.event.digest), phase).toHaveLength(1);
    expect((await run(fixture)).outcome, phase).toBe("CONTINUE");
    expect(await snapshot(fixture), phase).toEqual(expected);
    expect(interrupted["state.json"], phase).toBe(pre["state.json"]);
    expect(interrupted["integrity.json"], phase).toBe(pre["integrity.json"]);
  }
}, 120_000);


// Damage is introduced only into a transaction left by a real crashed writer.
// No hand-built lifecycle journal or final state is used for these attacks.
it.each(["bootstrap", "advance"])("preserves malformed/ambiguous %s history without compensating writes", async (kind) => {
  const fixture = await createFixture();
  fixtures.push(fixture);
  if (kind === "advance") {
    await bootstrap(fixture);
    await authorSource(fixture);
  }
  expect(await run(fixture, "AFTER_RENAME")).toBeNull();
  const historyFile = path.join(fixture.artifactRoot, "history/history.ndjson");
  const journalFile = path.join(fixture.artifactRoot, "transaction.json");
  const history = await readFile(historyFile, "utf8");
  const journal = await readFile(journalFile, "utf8");
  const transaction = JSON.parse(journal);
  const event = JSON.stringify(transaction.event);
  const prefix = history.slice(0, -(event.length + 1));
  const variants = [
    ["truncated event", prefix + event.slice(0, -12)],
    ["missing newline", prefix + event],
    ["reformatted event", prefix + " " + event + "\n"],
    ["extra blank line", history + "\n"],
    ["unrelated suffix", history + "{}\n"],
    ["stale journal", history + event + "\n"],
    ["forged event", prefix + event.replace("DISCOVER_LEGACY", "ASSESS_TARGET") + "\n"],
    ["damaged prefix", " " + history],
  ];
  for (const [label, damaged] of variants) {
    await writeFile(historyFile, damaged);
    const before = await snapshot(fixture);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await run(fixture, "DENY_MUTATION")).outcome, label).toBe("BLOCKED");
      expect(await snapshot(fixture), label).toEqual(before);
    }
  }
  await writeFile(historyFile, history);
  // Even a valid complete history cannot authorize a forged proposal.
  for (const forged of [
    { ...transaction, extra: true },
    { ...transaction, state: { ...transaction.state, nextAction: "Skip proof" } },
    { ...transaction, state: { ...transaction.state, artifactId: "foreign" } },
  ]) {
    await writeFile(journalFile, JSON.stringify(forged));
    const before = await snapshot(fixture);
    expect((await run(fixture, "DENY_MUTATION")).outcome).toBe("BLOCKED");
    expect(await snapshot(fixture)).toEqual(before);
  }
}, 120_000);
