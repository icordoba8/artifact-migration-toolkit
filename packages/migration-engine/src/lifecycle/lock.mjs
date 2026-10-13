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
// when its owner is provably gone: recorded on this host, in this PID realm
// (see `PID_REALM`), and `kill(pid, 0)` answers ESRCH. Age is never evidence --
// a slow live owner keeps its lock -- and anything that proves no owner (a torn,
// oversized or non-regular entry, a symlink, extra entries, a foreign host or
// realm, an unexpected probe error) fails closed. So does a regular-file lock
// left by a protocol-1 release: its writers do not honour this format, so only
// an operator who has stopped them may remove it (docs/lock-protocol-cutover.md).
//
// ponytail: PID identity, not an OS-held handle. Node cannot portably hold an
// advisory lock that the kernel releases on death (Windows has no flock, and
// an open handle does not block a second `open` here), so identity plus
// identity-keyed removal is the portable equivalent. Ceilings: a recycled PID
// now owned by a live unrelated process keeps a stale lock held until that
// process exits; a restarted PID namespace (a WSL distro after `wsl --shutdown`)
// is a new realm, so its predecessor's dead owners need manual removal; a waiter
// killed mid-acquire leaves its `<name>.lock.<uuid>.tmp` staging directory,
// which nothing reads. Upgrade path: record a process start marker (Linux /proc
// starttime) to prove PID reuse, or an OS-held lock via a native addon.

import { randomUUID } from "node:crypto";
import { constants as fsConstants, readlinkSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
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

/**
 * Whether a PID may exist. `kill(pid, 0)` never signals the process. Only ESRCH
 * proves absence: EPERM is another user's live process, and any other failure
 * proves nothing, so it counts as alive.
 */
export const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

// The space a recorded pid is meaningful in. Hostname alone is not one: Windows
// and every WSL distro on a machine share a hostname and a filesystem, but not
// pids, and Linux containers or distros each have their own pid namespace. So:
// one realm per non-Linux OS, and the pid namespace's inode on Linux. Null when
// unknowable (no /proc), which never proves an owner gone.
const pidRealm = () => {
  if (process.platform !== "linux") return process.platform;
  try {
    return `linux:${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return null;
  }
};
const PID_REALM = pidRealm();

// What `rename` of a directory reports while something occupies the lock path
// (EPERM: Windows will not replace an existing directory).
const OCCUPIED = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR", "EPERM"]);
const OWNER_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const MAX_OWNER_BYTES = 1024;
const UNPROVEN = Object.freeze({ pid: null });
const LEGACY = Object.freeze({ pid: null, legacy: true });

const ignore = (...codes) => (error) => {
  if (!codes.includes(error.code)) throw error;
};
const unlinkEntry = (file) => unlink(file).catch(ignore("ENOENT", "ENOTDIR"));
const rmdirIfEmpty = (dir) =>
  rmdir(dir).catch(ignore("ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"));

const validOwner = (owner, uuid) =>
  owner?.uuid === uuid &&
  Number.isInteger(owner.pid) &&
  owner.pid > 0 &&
  typeof owner.hostname === "string" &&
  owner.hostname !== "" &&
  typeof owner.realm === "string";

/**
 * The owner `file` names, read without following a symlink: it must be a
 * regular file of at most MAX_OWNER_BYTES, and the file opened must be the one
 * vetted (O_NOFOLLOW where the OS has it, and the same dev/ino everywhere, so a
 * swap between the two checks is caught on Windows too). Anything else --
 * missing, torn, hand-edited, foreign -- is UNPROVEN.
 */
const readOwner = async (file, uuid) => {
  let handle;
  try {
    const vetted = await lstat(file);
    if (!vetted.isFile() || vetted.size > MAX_OWNER_BYTES) return UNPROVEN;
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== vetted.dev || opened.ino !== vetted.ino) return UNPROVEN;
    const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_OWNER_BYTES) return UNPROVEN;
    const owner = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    return validOwner(owner, uuid) ? owner : UNPROVEN;
  } catch {
    return UNPROVEN;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const inThisRealm = (owner) =>
  owner.pid !== null &&
  PID_REALM !== null &&
  owner.hostname === os.hostname() &&
  owner.realm === PID_REALM;
const provablyGone = (owner) => inThisRealm(owner) && !processAlive(owner.pid);

/**
 * Frees `lock` when, and only when, its owner is provably gone (or it has none
 * left) and returns null; otherwise returns the owner, UNPROVEN if unknowable
 * and LEGACY for a protocol-1 lock file.
 */
const reclaimIfGone = async (lock) => {
  const info = await lstat(lock).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  // A protocol-1 writer may hold it, and protocol-1 writers do not see this
  // format at all: only an operator who has stopped them can free it.
  if (info.isFile()) return LEGACY;
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
  const owner = await readOwner(path.join(lock, entry), entry.slice(0, -5));
  if (!provablyGone(owner)) return owner;
  // That name is this dead owner's alone: it removes its entry or nothing,
  // even if a replacement owner has taken the lock since we read it.
  await unlinkEntry(path.join(lock, entry));
  await rmdirIfEmpty(lock);
  return null;
};

const lockedError = (name, lock, owner) =>
  new Error(
    owner?.legacy
      ? `Another migration command holds the lock for '${name}' at ${lock} as a lock file from a protocol-1 release, which is never reclaimed automatically. Stop every migration command on this repository, old releases included, then remove it by hand (docs/lock-protocol-cutover.md).`
      : !owner || inThisRealm(owner)
        ? `Another migration command holds the lock for '${name}' at ${lock} (pid ${owner?.pid ?? "unknown"}). Wait for it to finish; the lock is reclaimed automatically once that process is gone.`
        : `Another migration command holds the lock for '${name}' at ${lock}, but its owner (${owner.pid === null ? "unreadable" : `pid ${owner.pid} on ${owner.hostname} in ${owner.realm}`}) cannot be proven gone from here, so it is never reclaimed automatically. Remove it by hand only once no migration command is running (docs/lock-protocol-cutover.md).`,
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
    realm: PID_REALM,
    uuid: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const entry = `${identity.uuid}.json`;
  const staging = `${lock}.${identity.uuid}.tmp`;
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
    // `timeoutMs` bounds the wait for a holder, not staging: a slow fsync above
    // must not spend it. The deadline is checked before every retry, so every
    // retry path is bounded -- including a reclaim that keeps "succeeding"
    // because a racer keeps re-creating the lock. The first attempt always
    // runs, so even a spent budget tries the lock and names its holder.
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; !held; attempt += 1) {
      if (attempt > 0 && Date.now() >= deadline) throw lockedError(name, lock, owner);
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
