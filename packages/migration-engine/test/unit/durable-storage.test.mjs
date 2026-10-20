// Track B DR7 + DR8: the one store-owned replace-write (`atomicWrite`) and the
// one store-owned durable append (`appendDurably`), and the callers that now
// route through them. The filesystem is traced and faulted in-process
// (test/support/fs-trace.mjs), so each crash boundary is hit exactly, without
// timing. What a portable test cannot prove -- that the device honored an
// fsync -- is asserted at its observable boundary: the fsync call was made, on
// the right file, before the operation that depends on it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendApprovedCandidate, createDecisionCandidate } from "../../src/decisions/index.mjs";
import { DECISIONS_FILE } from "../../src/formats/index.mjs";
import { withModuleLock, writeJournalAtomic } from "../../src/lifecycle/index.mjs";
import {
  appendDurably,
  appendHistory,
  atomicWrite,
  copyTree,
  hashHistoryEvent,
  HISTORY_FILE,
  historyTailOf,
  INTEGRITY_FILE,
  isTornAppendOf,
  prepareHistoryEvent,
  readHistoryEvents,
  readTree,
  renameDurably,
  sealHistoryTail,
  writeTree,
} from "../../src/store/index.mjs";
import { ioError, traceFs } from "../support/fs-trace.mjs";

const TEMP = /^\..+\.[0-9a-f-]{36}\.tmp$/;
/** Where every lifecycle journal lives, relative to its target root. */
const MIGRATIONS = ".agents/knowledge/migrations";
const POSIX = process.platform !== "win32";
const ROOT_USER = POSIX && process.getuid() === 0;

const scratch = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dr7-dr8-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

/** Every entry under `root` as sorted portable paths, never descending a symlink. */
const listing = async (root, prefix = "") => {
  const found = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    found.push(relative);
    if (entry.isDirectory()) found.push(...await listing(root, relative));
  }
  return found.sort();
};

/** The mode a plain `writeFile` gives a new file under this process's umask. */
const defaultFileMode = async (root) => {
  const probe = path.join(root, ".mode-probe");
  await writeFile(probe, "");
  const { mode } = await stat(probe);
  await rm(probe);
  return mode & 0o777;
};

/** Index of the first log row matching `op` on `file`, or -1. */
const at = (log, op, file) => log.findIndex(([o, f]) => o === op && f === file);
const temps = (log) => log.filter(([op, file]) => op === "open" && TEMP.test(path.basename(file))).map(([, file]) => file);

/** The replace-write order every DR7 caller now shares, checked on the log. */
const assertReplaceOrder = (log, destination) => {
  const renamed = log.findIndex(([op, file]) => op === "rename" && file === destination);
  assert.ok(renamed >= 0, `no rename onto ${destination}`);
  const temporary = log[renamed][2];
  assert.match(path.basename(temporary), TEMP);
  assert.equal(path.dirname(temporary), path.dirname(destination), "the temp file sits beside its destination");
  const written = log.findIndex(([op, file]) => op === "writeFile" && file === temporary);
  const synced = at(log, "sync", temporary);
  assert.ok(written >= 0 && written < synced && synced < renamed, "temp bytes are written and fsynced before the rename");
  if (POSIX) {
    const directory = log.findIndex(([op, file], index) => index > renamed && op === "sync" && file === path.dirname(destination));
    assert.ok(directory > renamed, "the directory is fsynced after the rename");
  }
};

// --- DR7: one replace-write ---------------------------------------------------

test("DR7: atomicWrite flushes the temp file before the rename and the directory after it", async (t) => {
  const root = await scratch(t);
  const destination = path.join(root, "record/state.json");
  const log = await traceFs(t);
  await atomicWrite(root, destination, "one\n");
  assertReplaceOrder(log, destination);
  log.length = 0;
  await atomicWrite(root, destination, "two\n");
  assertReplaceOrder(log, destination);
  assert.equal(await readFile(destination, "utf8"), "two\n");
  if (POSIX) assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(await listing(root), ["record", "record/state.json"]);
});

test("DR7: an interrupted replace-write leaves the previous bytes and no temp file", async (t) => {
  const root = await scratch(t);
  const destination = path.join(root, "state.json");
  const previous = Buffer.from('{"revision":1}\né\n');
  await writeFile(destination, previous);
  for (const failAt of ["writeFile", "sync", "rename"]) {
    const log = await traceFs(t, async (op, file) => {
      if (op === failAt && (op === "rename" ? true : TEMP.test(path.basename(file)))) throw ioError();
    });
    await assert.rejects(atomicWrite(root, destination, "torn"), { code: "EIO" }, failAt);
    assert.deepEqual(await readFile(destination), previous, failAt);
    assert.deepEqual(await listing(root), ["state.json"], `${failAt}: ${temps(log)}`);
  }
});

test("DR7: atomicWrite refuses symlinks, traversal and a directory destination without mutation", async (t) => {
  const root = await scratch(t);
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await mkdir(repo);
  await mkdir(outside);
  await writeFile(path.join(outside, "victim.json"), "original");
  await symlink(outside, path.join(repo, "linked-dir"));
  await symlink(path.join(outside, "victim.json"), path.join(repo, "linked.json"));
  await mkdir(path.join(repo, "occupied"));
  await assert.rejects(atomicWrite(repo, path.join(repo, "linked-dir/victim.json"), "x"), /Refusing symlink output path/);
  await assert.rejects(atomicWrite(repo, path.join(repo, "linked.json"), "x"), /Refusing symlink output path/);
  await assert.rejects(atomicWrite(repo, path.join(repo, "../escape.json"), "x"), /escapes the target repository/);
  await assert.rejects(atomicWrite(repo, path.join(repo, "occupied"), "x"));
  assert.equal(await readFile(path.join(outside, "victim.json"), "utf8"), "original");
  assert.equal((await lstat(path.join(repo, "linked.json"))).isSymbolicLink(), true);
  assert.deepEqual(await listing(repo), ["linked-dir", "linked.json", "occupied"]);
  assert.deepEqual(await listing(outside), ["victim.json"]);
});

test("DR7: a permission error leaves nothing behind", { skip: !POSIX || ROOT_USER }, async (t) => {
  const root = await scratch(t);
  const locked = path.join(root, MIGRATIONS, "locked");
  await mkdir(locked, { recursive: true });
  await writeFile(path.join(locked, "state.json"), "kept");
  await chmod(locked, 0o500);
  t.after(() => chmod(locked, 0o700).catch(() => {}));
  await assert.rejects(atomicWrite(root, path.join(locked, "state.json"), "x"), { code: "EACCES" });
  await assert.rejects(writeJournalAtomic(path.join(locked, "advance.journal"), { x: 1 }), { code: "EACCES" });
  await chmod(locked, 0o700);
  assert.deepEqual(await listing(locked), ["state.json"]);
  assert.equal(await readFile(path.join(locked, "state.json"), "utf8"), "kept");
});

test("DR7: writeJournalAtomic is the store replace-write, byte for byte", async (t) => {
  const root = await scratch(t);
  const journalFile = path.join(root, MIGRATIONS, "init/auth.journal");
  const journal = { state: "PREPARED", text: "é", nested: { n: 1 } };
  const log = await traceFs(t);
  await writeJournalAtomic(journalFile, journal);
  assertReplaceOrder(log, journalFile);
  assert.equal(await readFile(journalFile, "utf8"), `${JSON.stringify(journal, null, 2)}\n`);
  if (POSIX) assert.equal((await stat(journalFile)).mode & 0o777, 0o600);

  // A journal interrupted before its rename keeps the previous journal intact
  // and leaves no temp file -- recovery reads exactly one complete journal.
  const before = await readFile(journalFile);
  for (const failAt of ["writeFile", "sync", "rename"]) {
    await traceFs(t, async (op, file) => {
      if (op === failAt && (op === "rename" ? file === journalFile : TEMP.test(path.basename(file)))) throw ioError();
    });
    await assert.rejects(writeJournalAtomic(journalFile, { state: "LIVE_MOVED" }), { code: "EIO" }, failAt);
    assert.deepEqual(await readFile(journalFile), before, failAt);
    assert.deepEqual(await listing(path.join(root, MIGRATIONS)), ["init", "init/auth.journal"], failAt);
  }
});

test("DR7: writeJournalAtomic checks the whole path from the target root and refuses any symlink in it", async (t) => {
  const root = await scratch(t);
  const outside = path.join(root, "outside");
  await mkdir(path.join(outside, "knowledge/migrations/init"), { recursive: true });
  await writeFile(path.join(outside, "auth.journal"), "outside");
  const cases = {};
  // A symlinked ancestor far above the journal directory, as well as the
  // journal directory and the journal itself.
  cases.ancestor = path.join(root, "a");
  await mkdir(cases.ancestor);
  await symlink(outside, path.join(cases.ancestor, ".agents"));
  cases.directory = path.join(root, "b");
  await mkdir(path.join(cases.directory, MIGRATIONS), { recursive: true });
  await symlink(outside, path.join(cases.directory, MIGRATIONS, "init"));
  cases.file = path.join(root, "c");
  await mkdir(path.join(cases.file, MIGRATIONS, "init"), { recursive: true });
  await symlink(path.join(outside, "auth.journal"), path.join(cases.file, MIGRATIONS, "init/auth.journal"));
  for (const [label, target] of Object.entries(cases)) {
    await assert.rejects(writeJournalAtomic(path.join(target, MIGRATIONS, "init/auth.journal"), { x: 1 }), /Refusing symlink output path/, label);
  }
  await assert.rejects(writeJournalAtomic(path.join(root, "elsewhere/auth.journal"), { x: 1 }), /outside \.agents\/knowledge\/migrations/);
  assert.deepEqual(await listing(outside), ["auth.journal", "knowledge", "knowledge/migrations", "knowledge/migrations/init"]);
  assert.equal(await readFile(path.join(outside, "auth.journal"), "utf8"), "outside");
  await assert.rejects(readFile(path.join(root, "elsewhere/auth.journal")), { code: "ENOENT" });
});

/** Asserts each directory in `parents` was fsynced after `from` and before `until`. */
const assertSyncedBetween = (log, parents, from, until, label) => {
  for (const parent of parents) {
    assert.ok(log.some(([op, file], index) => index > from && index < until && op === "sync" && file === parent),
      `${label}: ${parent} not fsynced`);
  }
};

test("DR7: a write into new directories makes each new directory entry durable before it returns", { skip: !POSIX }, async (t) => {
  const root = await scratch(t);
  const destination = path.join(root, "a/b/c/state.json");
  let log = await traceFs(t);
  await atomicWrite(root, destination, "{}\n");
  const created = at(log, "mkdir", path.join(root, "a/b/c"));
  const renamed = log.findIndex(([op, file]) => op === "rename" && file === destination);
  assertSyncedBetween(log, [root, path.join(root, "a"), path.join(root, "a/b")], created, renamed, "atomicWrite");

  // On a fresh target the module lock creates .agents/knowledge/migrations/,
  // and the first journal creates its own directory: both chains are durable.
  const fresh = path.join(root, "fresh");
  await mkdir(fresh);
  const chain = [fresh, ".agents", "knowledge", "migrations"].map((_, index, parts) => path.join(...parts.slice(0, index + 1)));
  log = await traceFs(t);
  const journal = path.join(fresh, MIGRATIONS, "init/auth.journal");
  await withModuleLock(fresh, "auth", () => writeJournalAtomic(journal, { state: "PREPARED" }));
  const journaled = log.findIndex(([op, file]) => op === "rename" && file === journal);
  assertSyncedBetween(log, chain, at(log, "mkdir", path.join(fresh, MIGRATIONS, "locks")), journaled, "the lock directory chain");
  assertSyncedBetween(log, [path.join(fresh, MIGRATIONS)], at(log, "mkdir", path.dirname(journal)), journaled, "writeJournalAtomic");

  const ledger = path.join(root, "record/decisions/ledger.ndjson");
  log = await traceFs(t);
  await appendDurably(root, ledger, "x\n");
  assertSyncedBetween(log, [root, path.join(root, "record")], at(log, "mkdir", path.dirname(ledger)), at(log, "open", ledger), "appendDurably");
});

// Each case runs in a child process under a timeout: on Windows the old walk
// never yielded to the event loop, so no in-process timeout could stop it.
test("DR7: mkdirDurably returns once a new chain exists on every platform, and refuses rather than spins on a first directory outside it", async (t) => {
  const root = await scratch(t);
  const files = new URL("../../src/store/files.mjs", import.meta.url).href;
  const child = (script) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });

  // Node on Windows reports the first new directory as `\\?\C:\...`.
  const nested = path.join(root, "a", "b", "c");
  const created = child(`import { mkdirDurably } from ${JSON.stringify(files)}; await mkdirDurably(${JSON.stringify(nested)});`);
  assert.equal(created.signal, null, "mkdirDurably spun on a new chain until the timeout");
  assert.equal(created.status, 0, created.stderr);
  assert.ok((await stat(nested)).isDirectory());

  const foreign = child(`
    import fsp from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const mkdir = fsp.mkdir;
    fsp.mkdir = async (...args) => { await mkdir(...args); return ${JSON.stringify(path.join(root, "elsewhere"))}; };
    syncBuiltinESMExports();
    const { mkdirDurably } = await import(${JSON.stringify(files)});
    await mkdirDurably(${JSON.stringify(path.join(root, "x", "y"))});`);
  assert.equal(foreign.signal, null, "mkdirDurably spun on a foreign first directory until the timeout");
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /mkdir reported '.*elsewhere' as the first directory it created/);
});

test("DR7: renameDurably fsyncs both directories, and copyTree flushes the copy and the entry naming it", { skip: !POSIX }, async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "from/nested"), { recursive: true });
  await writeFile(path.join(root, "from/a.json"), "a");
  await writeFile(path.join(root, "from/nested/b.md"), "\u00e9");
  await chmod(path.join(root, "from/a.json"), 0o640);
  let log = await traceFs(t);
  const to = path.join(root, "new/parent/copy");
  await copyTree(path.join(root, "from"), to);
  assert.deepEqual(await readTree(to), await readTree(path.join(root, "from")));
  assert.equal((await stat(path.join(to, "a.json"))).mode & 0o777, 0o640);
  const copied = at(log, "mkdir", path.dirname(to));
  for (const file of ["a.json", "nested/b.md"]) assert.ok(at(log, "sync", path.join(to, file)) > copied, file);
  assertSyncedBetween(log, [root, path.join(root, "new"), path.dirname(to), to, path.join(to, "nested")], copied, log.length, "copyTree");
  const lastSync = (file) => log.findLastIndex(([op, f]) => op === "sync" && f === file);
  assert.ok(lastSync(path.dirname(to)) > lastSync(to), "the parent is fsynced after the copy itself");

  log = await traceFs(t);
  await mkdir(path.join(root, "elsewhere"));
  await renameDurably(to, path.join(root, "elsewhere/moved"));
  const renamed = at(log, "rename", path.join(root, "elsewhere/moved"));
  assertSyncedBetween(log, [path.join(root, "elsewhere"), path.dirname(to)], renamed, log.length, "renameDurably");
  assert.deepEqual(await readTree(path.join(root, "elsewhere/moved")), await readTree(path.join(root, "from")));
});

test("DR7: writeTree stages a flushed tree with the same bytes and modes, and stays inside its root", async (t) => {
  const root = await scratch(t);
  const staging = path.join(root, "transaction/staging");
  const files = { "state.json": "{}\n", "history/history.ndjson": "{\"a\":1}\n", "a/b/c.md": "é\n" };
  const log = await traceFs(t);
  await writeTree(staging, files);
  assert.deepEqual(await readTree(staging), files);
  for (const relative of Object.keys(files)) {
    const destination = path.join(staging, ...relative.split("/"));
    assertReplaceOrder(log, destination);
  }
  if (POSIX) {
    // Every directory the tree holds is fsynced after the tree's last entry
    // (file rename or directory create) landed, so the caller's journalled
    // rename commits durable entries.
    const lastEntry = log.findLastIndex(([op]) => op === "rename" || op === "mkdir");
    for (const directory of ["", "a", "a/b", "history"]) {
      const absolute = path.join(staging, directory);
      assert.ok(log.findLastIndex(([op, file]) => op === "sync" && file === absolute) > lastEntry, directory || ".");
    }
    const mode = await defaultFileMode(root);
    for (const relative of Object.keys(files)) {
      assert.equal((await stat(path.join(staging, relative))).mode & 0o777, mode, relative);
    }
  }
  assert.equal((await listing(staging)).some((entry) => TEMP.test(path.basename(entry))), false);

  await assert.rejects(writeTree(path.join(root, "second"), { "../escape.md": "x" }), /escapes the target repository/);
  await assert.rejects(readFile(path.join(root, "escape.md")), { code: "ENOENT" });
  await mkdir(path.join(root, "outside"));
  await mkdir(path.join(root, "third"));
  await symlink(path.join(root, "outside"), path.join(root, "third/link"));
  await assert.rejects(writeTree(path.join(root, "third"), { "link/x.md": "x" }), /Refusing symlink output path/);
  assert.deepEqual(await listing(path.join(root, "outside")), []);
});

// --- DR8: one durable append --------------------------------------------------

const O_APPEND_NOFOLLOW = fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0);

/** The durable-append order every DR8 caller now shares, checked on the log. */
const assertAppendOrder = (log, file) => {
  const opened = at(log, "open", file);
  assert.ok(opened >= 0, `${file} was not opened by the store append`);
  const flags = log[opened][2];
  assert.equal(typeof flags, "number");
  assert.equal(flags & O_APPEND_NOFOLLOW, O_APPEND_NOFOLLOW, "O_APPEND | O_NOFOLLOW");
  const written = log.findIndex(([op, f], index) => index > opened && op === "write" && f === file);
  const synced = log.findIndex(([op, f], index) => index > written && op === "sync" && f === file);
  assert.ok(written > opened && synced > written, "the bytes are written, then fsynced");
  if (POSIX) {
    assert.ok(log.findIndex(([op, f], index) => index > synced && op === "sync" && f === path.dirname(file)) > synced,
      "the directory is fsynced after the file");
  }
  assert.equal(log.some(([op, f]) => op === "appendFile" && f === file), false, "no un-synced appendFile");
};

/** A record born chained, then one transition per event, through appendHistory. */
const chain = async (record, [created, ...events]) => {
  await mkdir(path.join(record, path.dirname(HISTORY_FILE)), { recursive: true });
  Object.assign(created, { at: "2026-01-01T00:00:00.000Z", seq: 1, previousHash: null });
  created.hash = hashHistoryEvent(created);
  await writeFile(path.join(record, HISTORY_FILE), `${JSON.stringify(created)}\n`);
  let historyChain = { version: 1, startSeq: 1, legacyPrefixSha256: null, headHash: created.hash };
  for (const event of events) {
    await writeFile(path.join(record, INTEGRITY_FILE), `${JSON.stringify({ historyChain })}\n`);
    historyChain = await prepareHistoryEvent(record, event);
    await writeFile(path.join(record, INTEGRITY_FILE), `${JSON.stringify({ historyChain })}\n`);
    await appendHistory(record, record, event);
  }
};

test("DR8: appendHistory is the store durable append and leaves the anchored prefix byte-identical", async (t) => {
  const record = await scratch(t);
  await chain(record, [{ event: "A", revision: 1 }, { event: "B", revision: 2 }]);
  const historyFile = path.join(record, HISTORY_FILE);
  const prefix = await readFile(historyFile);
  const event = { event: "C", revision: 3 };
  const historyChain = await prepareHistoryEvent(record, event);
  await writeFile(path.join(record, INTEGRITY_FILE), `${JSON.stringify({ historyChain })}\n`);
  const mode = (await stat(historyFile)).mode;
  const log = await traceFs(t);
  await appendHistory(record, record, event);
  assertAppendOrder(log, historyFile);
  assert.equal((await stat(historyFile)).mode, mode, "an append never changes the file mode");
  const after = await readFile(historyFile);
  assert.deepEqual(after.subarray(0, prefix.length), prefix);
  assert.equal(after.subarray(prefix.length).toString("utf8"), `${JSON.stringify(event)}\n`);
  assert.deepEqual((await readHistoryEvents(record)).map(({ seq, event: name }) => [seq, name]), [[1, "A"], [2, "B"], [3, "C"]]);
});

test("DR8: a torn history append is cut by sealHistoryTail, replays once, and never touches the anchored prefix", async (t) => {
  const record = await scratch(t);
  await chain(record, [{ event: "A", revision: 1 }, { event: "B", revision: 2 }]);
  const historyFile = path.join(record, HISTORY_FILE);
  const prefix = await readFile(historyFile);
  const event = { event: "C", revision: 3 };
  const historyChain = await prepareHistoryEvent(record, event);
  await writeFile(path.join(record, INTEGRITY_FILE), `${JSON.stringify({ historyChain })}\n`);
  const pending = structuredClone(event);

  // The process dies after 7 bytes of the line reached the file.
  await traceFs(t, async (op, file, call) => {
    if (op === "write" && file === historyFile) {
      const [bytes, offset = 0] = call.args;
      await call.real.call(call.handle, bytes, offset, 7);
      throw ioError();
    }
  });
  await assert.rejects(appendHistory(record, record, event), { code: "EIO" });
  await traceFs(t);
  assert.equal((await readFile(historyFile)).length, prefix.length + 7);
  await assert.rejects(readHistoryEvents(record), /unterminated/);
  assert.equal(await sealHistoryTail(record, record), "TRUNCATED");
  assert.deepEqual(await readFile(historyFile), prefix);
  await appendHistory(record, record, pending);
  const events = await readHistoryEvents(record);
  assert.deepEqual(events.map(({ event: name }) => name), ["A", "B", "C"]);
  assert.equal(events.filter(({ revision }) => revision === 3).length, 1);

  // A whole event that lost only its newline is kept, not duplicated or cut.
  const whole = await readFile(historyFile);
  await writeFile(historyFile, whole.subarray(0, whole.length - 1));
  assert.equal(await sealHistoryTail(record, record), "TERMINATED");
  assert.deepEqual(await readFile(historyFile), whole);

  // Damage inside the anchored prefix is not a tail: nothing is repaired.
  const damaged = Buffer.from(whole);
  damaged[5] = 0x7b;
  await writeFile(historyFile, damaged);
  assert.equal(await sealHistoryTail(record, record), null);
  assert.deepEqual(await readFile(historyFile), damaged);
  await assert.rejects(readHistoryEvents(record), /malformed|invalid hash/);
});

test("DR7/DR8: a directory fsync failure is never reported as a durable write", { skip: !POSIX }, async (t) => {
  const root = await scratch(t);
  for (const code of ["EIO", "EINVAL", "ENOTSUP"]) {
    await traceFs(t, async (op, file) => { if (op === "sync" && file === path.join(root, "record")) throw ioError(code); });
    await assert.rejects(appendDurably(root, path.join(root, "record/ledger.ndjson"), "x\n"), { code }, `append ${code}`);
    await assert.rejects(atomicWrite(root, path.join(root, "record/state.json"), "{}"), { code }, `replace ${code}`);
  }
});

test("DR8: appendDurably refuses symlinks, traversal and a directory ledger without mutation", async (t) => {
  const root = await scratch(t);
  const outside = path.join(root, "outside");
  const repo = path.join(root, "repo");
  await mkdir(outside);
  await mkdir(path.join(repo, "record"), { recursive: true });
  await writeFile(path.join(outside, "ledger.ndjson"), "kept\n");
  await symlink(outside, path.join(repo, "linked"));
  await symlink(path.join(outside, "ledger.ndjson"), path.join(repo, "record/ledger.ndjson"));
  await mkdir(path.join(repo, "record/dir.ndjson"));
  await assert.rejects(appendDurably(repo, path.join(repo, "linked/ledger.ndjson"), "x\n"), /Refusing symlink output path/);
  await assert.rejects(appendDurably(repo, path.join(repo, "record/ledger.ndjson"), "x\n"), /Refusing symlink output path/);
  await assert.rejects(appendDurably(repo, path.join(root, "escape.ndjson"), "x\n"), /escapes the target repository/);
  await assert.rejects(appendDurably(repo, path.join(repo, "record/dir.ndjson"), "x\n"));
  assert.equal(await readFile(path.join(outside, "ledger.ndjson"), "utf8"), "kept\n");
  assert.deepEqual(await listing(outside), ["ledger.ndjson"]);
  await assert.rejects(readFile(path.join(root, "escape.ndjson")), { code: "ENOENT" });
});

test("DR8: concurrent appends under the module lock keep every record whole, once, in lock order, even across short writes", async (t) => {
  const root = await scratch(t);
  const ledger = path.join(root, "record/ledger.ndjson");
  const order = [];
  const lines = Array.from({ length: 24 }, (_, index) => `${JSON.stringify({ index, pad: "x".repeat(300 + index) })}\n`);
  // The OS may write fewer bytes than asked; every third write here is cut to
  // 7 bytes, and the append must finish the line before the lock is released.
  let writes = 0;
  await traceFs(t, async (op, file, call) => {
    if (op !== "write" || file !== ledger || ++writes % 3 !== 0) return undefined;
    const [bytes, offset] = call.args;
    return { result: await call.real.call(call.handle, bytes, offset, 7) };
  });
  await Promise.all(lines.map((line, index) => withModuleLock(root, "auth", async () => {
    order.push(index);
    await appendDurably(root, ledger, line);
  })));
  assert.ok(writes > lines.length, "short writes were injected");
  // The ordering is the lock's guarantee: outside it a short write could interleave, and every caller appends under it.
  assert.equal(await readFile(ledger, "utf8"), order.map((index) => lines[index]).join(""));
});

test("DR8: the decision ledger append is the store durable append; an interrupted one writes no decision", async (t) => {
  const root = await scratch(t);
  const record = path.join(root, ".agents/knowledge/migrations/modules/auth");
  await mkdir(record, { recursive: true });
  const locked = { recordKind: "artifact", targetRoot: root, root: record, state: {} };
  const candidate = (subjectPath) => createDecisionCandidate({
    kind: "SCOPE", subjectType: "file", subjectPath, rationale: "test", targets: [], boundTo: { source: subjectPath },
  });
  const quiet = { write: () => true };
  const statementFor = (entry) => `APPROVED ${entry.id}.`;
  const ledger = path.join(record, DECISIONS_FILE);
  const log = await traceFs(t);
  await appendApprovedCandidate({ candidate: candidate("a.md"), locked, result: "APPROVED", ask: undefined, stdout: quiet, statementFor });
  assertAppendOrder(log, ledger);
  const first = await readFile(ledger);
  assert.equal(first.toString("utf8").split("\n").filter(Boolean).length, 1);
  if (POSIX) assert.equal((await stat(ledger)).mode & 0o777, 0o600);

  // A crash before the line's first byte lands appends nothing.
  await traceFs(t, async (op, file) => { if (op === "write" && file === ledger) throw ioError(); });
  await assert.rejects(appendApprovedCandidate({ candidate: candidate("b.md"), locked, result: "APPROVED", ask: undefined, stdout: quiet, statementFor }), { code: "EIO" });
  assert.deepEqual(await readFile(ledger), first);
});

test("DR13: a torn history append is recognized byte for byte, even split inside a character", async (t) => {
  const root = await scratch(t);
  const record = path.join(root, MIGRATIONS, "modules/auth");
  await mkdir(path.join(record, "history"), { recursive: true });
  const chained = { event: "REOPENED", reason: "café", revision: 3, seq: 3, hash: `sha256:${"a".repeat(64)}` };
  const line = Buffer.from(JSON.stringify(chained));
  const split = line.indexOf(Buffer.from("é")) + 1;
  await writeFile(path.join(record, HISTORY_FILE), Buffer.concat([Buffer.from("{}\n"), line.subarray(0, split)]));
  const tail = await historyTailOf(root, record);
  assert.deepEqual(tail, line.subarray(0, split));
  assert.equal(isTornAppendOf(tail, chained), true, "a tear inside é is still this event's prefix");
  assert.equal(isTornAppendOf(line, chained), true, "the whole event without its newline");
  assert.equal(isTornAppendOf(Buffer.concat([line, Buffer.from(" ")]), chained), false);
  assert.equal(isTornAppendOf(Buffer.from("garbage"), chained), false);
  assert.equal(isTornAppendOf(line.subarray(0, split), { ...chained, reason: "cafe" }), false);
  // An unchained event carries its append time first; the tail supplies it.
  const plain = { event: "REFRESHED", reason: "naïve", revision: 4 };
  const plainLine = Buffer.from(JSON.stringify({ at: "2026-10-14T20:00:00.000Z", ...plain }));
  assert.equal(isTornAppendOf(plainLine.subarray(0, plainLine.indexOf(Buffer.from("ï")) + 1), plain), true);
  assert.equal(isTornAppendOf(plainLine.subarray(0, 10), plain), true);
  assert.equal(isTornAppendOf(Buffer.from('{"at":"zz'), plain), false);
  await writeFile(path.join(record, HISTORY_FILE), "{}\n");
  assert.equal((await historyTailOf(root, record)).length, 0);
});
