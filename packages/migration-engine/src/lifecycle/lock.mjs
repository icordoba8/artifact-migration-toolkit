// One shared write-serialization primitive for every mutating migration
// command: initialization, refresh, advance, registry update, upgrade,
// rollback, and recovery. There is deliberately no second lock format and no
// per-command journal dialect -- everything that mutates a module's persisted
// artifacts takes this lock, keyed by target root plus lock name.
//
// The lock is a directory holding exactly one owner entry, `<uuid>.json`. It is
// built complete in a private staging directory and published by one `rename`,
// which cannot land on a published lock (never empty), so the lock never exists
// without its owner. Every removal is keyed by identity, never by the shared
// path: `unlink(<lock>/<uuid>.json)` removes that one owner's entry or nothing,
// and `rmdir` removes only an empty directory, so no waiter, reclaimer or
// release can delete a lock someone else holds. A waiter reclaims a lock only
// when its owner is provably gone: recorded on this host, and no such pid. Age
// is never evidence -- a slow live owner keeps its lock -- and anything that
// proves no owner (a torn entry, a foreign host, extra entries, a symlink)
// fails closed.
//
// ponytail: PID identity, not an OS-held handle. Node cannot portably hold an
// advisory lock that the kernel releases on death (Windows has no flock, and
// an open handle does not block a second `open` here), so identity plus
// identity-keyed removal is the portable equivalent. Ceilings: a recycled PID
// now owned by a live unrelated process keeps a stale lock held until that
// process exits; hosts (or PID namespaces) sharing one hostname and one
// filesystem look like one host; a waiter killed mid-acquire leaves its
// `<name>.lock.<uuid>.tmp` staging directory, which nothing reads. Upgrade
// path: record a process start marker (Linux /proc starttime) to prove PID
// reuse, or an OS-held lock via a native addon.

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_ROOT = ".agents/knowledge/migrations/locks";

export const lockPathFor = (targetRoot, name) =>
  path.join(targetRoot, LOCK_ROOT, `${name}.lock`);

// Referenced on purpose. This timer is the *only* pending work a waiter has
// between polls, so unref-ing it let the event loop drain the instant the
// holder finished its own I/O -- the process exited mid-acquire and the
// waiter's promise never settled. The wait is already bounded by `timeoutMs`,
// so holding the loop open costs nothing a caller did not ask for.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a PID currently exists. `kill(pid, 0)` never signals the process. */
export const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return error.code === "EPERM";
  }
};

// What `rename` of a directory reports while something occupies the lock path
// (EPERM: Windows will not replace an existing directory).
const OCCUPIED = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR", "EPERM"]);
const OWNER_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const UNPROVEN = Object.freeze({ pid: null });

const ignore = (...codes) => (error) => {
  if (!codes.includes(error.code)) throw error;
};
const unlinkEntry = (file) => unlink(file).catch(ignore("ENOENT", "ENOTDIR"));
const rmdirIfEmpty = (dir) =>
  rmdir(dir).catch(ignore("ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"));

const readOwner = async (file) => {
  try {
    const owner = JSON.parse(await readFile(file, "utf8"));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : UNPROVEN;
  } catch {
    // Missing, torn or hand-edited: no provable owner.
    return UNPROVEN;
  }
};

// Regular-file locks from older releases carry no hostname; they are judged on
// this host, as they always were.
const onThisHost = (owner) => (owner.hostname ?? os.hostname()) === os.hostname();
const provablyGone = (owner) =>
  owner.pid !== null && onThisHost(owner) && !processAlive(owner.pid);

/**
 * Frees `lock` when, and only when, its owner is provably gone (or it has none
 * left) and returns null; otherwise returns the owner, UNPROVEN if unknowable.
 */
const reclaimIfGone = async (lock) => {
  const info = await lstat(lock).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isFile()) {
    // A lock file from an older release. This format never writes a file
    // here and `unlink` cannot remove a directory, so this drops only that
    // legacy owner; two current reclaimers of it cannot hurt each other.
    const owner = await readOwner(lock);
    if (!provablyGone(owner)) return owner;
    await unlink(lock).catch(ignore("ENOENT", "EISDIR", "EPERM"));
    return null;
  }
  if (!info.isDirectory()) return UNPROVEN;
  const entries = await readdir(lock).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (entries === null) return null;
  // Released or reclaimed but not yet removed: free, whoever removes it.
  if (entries.length === 0) return rmdirIfEmpty(lock).then(() => null);
  const [entry] = entries;
  if (entries.length !== 1 || !OWNER_ENTRY.test(entry)) return UNPROVEN;
  const owner = await readOwner(path.join(lock, entry));
  if (owner.uuid !== entry.slice(0, -5) || typeof owner.hostname !== "string") {
    return UNPROVEN;
  }
  if (!provablyGone(owner)) return owner;
  // That name is this dead owner's alone: it removes its entry or nothing,
  // even if a replacement owner has taken the lock since we read it.
  await unlinkEntry(path.join(lock, entry));
  await rmdirIfEmpty(lock);
  return null;
};

const lockedError = (name, lock, owner) =>
  new Error(
    !owner || (owner.pid !== null && onThisHost(owner))
      ? `Another migration command holds the lock for '${name}' at ${lock} (pid ${owner?.pid ?? "unknown"}). Wait for it to finish; the lock is reclaimed automatically once that process is gone.`
      : `Another migration command holds the lock for '${name}' at ${lock}, but its owner (${owner.pid === null ? "unreadable" : `pid ${owner.pid} on ${owner.hostname}`}) cannot be proven gone, so it is never reclaimed automatically. Remove it by hand only once no migration command is running.`,
  );

/**
 * @param {string} targetRoot repository that owns the lock directory
 * @param {string} name lock name; use the canonical module name
 * @returns {Promise<() => Promise<void>>} release function
 */
export const acquireModuleLock = async (
  targetRoot,
  name,
  { timeoutMs = 30_000, pollMs = 25 } = {},
) => {
  const lock = lockPathFor(targetRoot, name);
  await mkdir(path.dirname(lock), { recursive: true });
  const identity = {
    pid: process.pid,
    hostname: os.hostname(),
    uuid: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const entry = `${identity.uuid}.json`;
  const staging = `${lock}.${identity.uuid}.tmp`;
  const deadline = Date.now() + timeoutMs;
  let owner = null;
  let held = false;
  try {
    await mkdir(staging);
    const handle = await open(path.join(staging, entry), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    // The deadline is checked once per attempt, before it, so every retry path
    // is bounded -- including a reclaim that keeps "succeeding" because a racer
    // keeps re-creating the lock.
    while (!held) {
      if (Date.now() >= deadline) throw lockedError(name, lock, owner);
      try {
        await rename(staging, lock);
        held = true;
      } catch (error) {
        if (!OCCUPIED.has(error.code)) throw error;
        owner = await reclaimIfGone(lock);
        // ponytail: a freed lock retries immediately -- the normal case wins
        // the very next `rename`. A pathological reclaim loop therefore spins
        // hot, but only until the deadline above. Add a sleep here if that
        // ever shows up in a profile.
        if (owner) await sleep(pollMs);
      }
    }
  } finally {
    if (!held) await rm(staging, { recursive: true, force: true });
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Our entry, then the directory only if that emptied it: a lock anyone
    // else holds by now is untouched either way.
    await unlinkEntry(path.join(lock, entry));
    await rmdirIfEmpty(lock);
  };
};

export const withModuleLock = async (targetRoot, name, run, options) => {
  const release = await acquireModuleLock(targetRoot, name, options);
  try {
    return await run();
  } finally {
    await release();
  }
};

/**
 * Crash-safe journal write: temp file plus rename, so a reader never observes a
 * half-written journal. Shared by the upgrade coordinator and initialization.
 */
export const writeJournalAtomic = async (file, journal) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
};
