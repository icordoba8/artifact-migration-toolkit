// One shared write-serialization primitive for every mutating migration
// command: initialization, refresh, advance, registry update, upgrade,
// rollback, and recovery. There is deliberately no second lock format and no
// per-command journal dialect -- everything that mutates a module's persisted
// artifacts takes this lock, keyed by target root plus lock name.
//
// The lock is a directory holding its owner entry, `<uuid>.json`, and normally
// that owner's liveness token, `<uuid>.fifo`. It is
// built complete in a private staging directory and published by one `rename`,
// which cannot land on a published lock (never empty), so the lock never exists
// without its owner. Every removal is keyed by identity, never by the shared
// path: `unlink(<lock>/<uuid>.json)` removes that one owner's entry or nothing,
// and `rmdir` removes only an empty directory, so no waiter, reclaimer or
// release can delete a lock someone else holds. A waiter reclaims a lock only
// when its owner is provably gone. The proof is the token: the owner holds the
// FIFO's only read end (O_CLOEXEC, so no child it spawns inherits it), the
// kernel closes it the instant the owner dies in any PID namespace, and a
// non-blocking write-open then answers ENXIO. The owner entry binds the FIFO's
// dev/ino, so a missing, replaced or remote FIFO is UNKNOWN, never "gone". An
// owner without a token (no mkfifo: Windows, some mounts; or a lock from before
// tokens) is provably gone only on this host, in this PID realm (see
// `PID_REALM`), when `kill(pid, 0)` answers ESRCH. Age is never evidence --
// a slow live owner keeps its lock -- and anything that proves no owner (a torn,
// oversized or non-regular entry, a symlink, extra entries, a foreign host or
// realm, an unexpected probe error) fails closed. So does a regular-file lock
// left by a protocol-1 release: its writers do not honour this format, so only
// an operator who has stopped them may remove it (docs/lock-protocol-cutover.md).
//
// ponytail: a FIFO token, not an OS lock. Node has no flock and no mkfifo, so the
// FIFO is made by the `mkfifo` utility. Ceilings: where it cannot be made or
// opened (Windows, filesystems without FIFOs) the owner falls back to PID
// identity -- a recycled PID keeps a stale lock held, and a restarted or
// foreign PID namespace needs manual removal; a token on a remote or 9p mount
// does not match its recorded dev/ino from another kernel, so it fails closed;
// any other process holding the token's read end (a stray `cat`) keeps a dead
// owner's lock held until it lets go -- fails closed, never open;
// a waiter killed mid-acquire leaves its `<name>.lock.<uuid>.tmp` staging
// directory, which nothing reads. Upgrade path: an OS-held lock via a native
// addon.

import { execFile } from "node:child_process";
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
import { promisify } from "node:util";

import { mkdirDurably } from "../store/index.mjs";

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
const TOKEN_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.fifo$/;
const MAX_OWNER_BYTES = 1024;
const UNPROVEN = Object.freeze({ pid: null, verdict: "UNKNOWN" });
const LEGACY = Object.freeze({ pid: null, legacy: true });

// Read ends of the tokens this process holds. Referenced until release: a
// FileHandle that is garbage-collected is closed, which would read as "gone".
const heldTokens = new Set();

/**
 * Creates `file` as a FIFO and opens its read end. Returns null -- a token-less
 * owner -- when either step is impossible here; nothing is left behind.
 */
const createToken = async (file) => {
  if (process.platform === "win32") return null;
  let handle;
  try {
    await promisify(execFile)("mkfifo", ["-m", "600", file]);
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    const { dev, ino } = await handle.stat({ bigint: true });
    heldTokens.add(handle);
    return { handle, fifo: { dev: String(dev), ino: String(ino) } };
  } catch {
    await handle?.close().catch(() => undefined);
    await unlinkEntry(file).catch(() => undefined);
    return null;
  }
};

const dropToken = async (token) => {
  if (!token) return;
  heldTokens.delete(token.handle);
  await token.handle.close().catch(() => undefined);
};

/**
 * "GONE" only on ENXIO from a non-blocking write-open of the recorded FIFO --
 * no process holds its read end -- re-checked to be that same FIFO afterwards.
 * An open that succeeds is "ALIVE". Anything else is "UNKNOWN".
 */
const probeToken = async (file, fifo) => {
  const recorded = async () => {
    const info = await lstat(file, { bigint: true }).catch(() => null);
    return Boolean(info?.isFIFO() && String(info.dev) === fifo.dev && String(info.ino) === fifo.ino);
  };
  if (!(await recorded())) return "UNKNOWN";
  try {
    const writer = await open(file, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    await writer.close();
    return "ALIVE";
  } catch (error) {
    return error.code === "ENXIO" && (await recorded()) ? "GONE" : "UNKNOWN";
  }
};

const ignore = (...codes) => (error) => {
  if (!codes.includes(error.code)) throw error;
};
const unlinkEntry = (file) => unlink(file).catch(ignore("ENOENT", "ENOTDIR"));
const rmdirIfEmpty = (dir) =>
  rmdir(dir).catch(ignore("ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"));

const DECIMAL = /^[0-9]{1,20}$/;
const validOwner = (owner, uuid) =>
  owner?.uuid === uuid &&
  Number.isInteger(owner.pid) &&
  owner.pid > 0 &&
  typeof owner.hostname === "string" &&
  owner.hostname !== "" &&
  typeof owner.realm === "string" &&
  (owner.fifo === undefined || owner.fifo === null ||
    (DECIMAL.test(owner.fifo?.dev) && DECIMAL.test(owner.fifo?.ino)));

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

/**
 * GONE, ALIVE, UNKNOWN (a token that is missing, replaced, foreign or
 * unreadable -- or an unreadable owner), or NO_TOKEN: a token-less owner the
 * PID rule cannot reach from here.
 */
const verdictFor = async (lock, owner) => {
  if (owner.pid === null) return "UNKNOWN";
  if (owner.fifo) {
    if (owner.hostname !== os.hostname()) return "UNKNOWN";
    return probeToken(path.join(lock, `${owner.uuid}.fifo`), owner.fifo);
  }
  if (!inThisRealm(owner)) return "NO_TOKEN";
  return processAlive(owner.pid) ? "ALIVE" : "GONE";
};

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
  // Released or reclaimed but not yet removed -- empty, or only a token whose
  // owner entry is already gone: free, whoever removes it.
  if (entries.length === 0) return rmdirIfEmpty(lock).then(() => null);
  if (entries.length === 1 && TOKEN_ENTRY.test(entries[0])) {
    await unlinkEntry(path.join(lock, entries[0]));
    return rmdirIfEmpty(lock).then(() => null);
  }
  const entry = entries.find((name) => OWNER_ENTRY.test(name));
  const uuid = entry?.slice(0, -5);
  if (!entry || !entries.every((name) => name === entry || name === `${uuid}.fifo`)) return UNPROVEN;
  const owner = await readOwner(path.join(lock, entry), uuid);
  const verdict = await verdictFor(lock, owner);
  if (verdict !== "GONE") return { ...owner, verdict };
  // Those names are this dead owner's alone: it removes its entries or
  // nothing, even if a replacement owner has taken the lock since we read it.
  await unlinkEntry(path.join(lock, entry));
  await unlinkEntry(path.join(lock, `${uuid}.fifo`));
  await rmdirIfEmpty(lock);
  return null;
};

/**
 * The refusal names why: LOCK_HELD (a live owner, or a lock that keeps being
 * re-taken), LOCK_OWNER_UNKNOWN (its token or entry proves nothing),
 * LOCK_NO_LIVENESS_TOKEN (a token-less owner outside this PID realm) or
 * LOCK_PROTOCOL_1. Only LOCK_HELD resolves by waiting.
 */
const lockedError = (name, lock, owner) => {
  const who = owner?.pid ? `pid ${owner.pid} on ${owner.hostname} in ${owner.realm}` : "unreadable";
  const manual = "so it is never reclaimed automatically. Remove it by hand only once no migration command is running (docs/lock-protocol-cutover.md).";
  const [code, message] = owner?.legacy
    ? ["LOCK_PROTOCOL_1", `Another migration command holds the lock for '${name}' at ${lock} as a lock file from a protocol-1 release, which is never reclaimed automatically. Stop every migration command on this repository, old releases included, then remove it by hand (docs/lock-protocol-cutover.md).`]
    : owner?.verdict === "UNKNOWN"
      ? ["LOCK_OWNER_UNKNOWN", `Another migration command holds the lock for '${name}' at ${lock}, but its owner (${who}) cannot be proven gone from here: its entry or liveness token is unreadable, missing, replaced or on another host, ${manual}`]
      : owner?.verdict === "NO_TOKEN"
        ? ["LOCK_NO_LIVENESS_TOKEN", `Another migration command holds the lock for '${name}' at ${lock}, but its owner (${who}) recorded no liveness token and runs in another PID realm, so it cannot be proven gone from here, ${manual}`]
        : ["LOCK_HELD", `Another migration command holds the lock for '${name}' at ${lock} (pid ${owner?.pid ?? "unknown"}). Wait for it to finish; the lock is reclaimed automatically once that process is gone.`];
  return Object.assign(new Error(message), { code });
};

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
  await mkdirDurably(path.dirname(lock));
  const identity = {
    pid: process.pid,
    hostname: os.hostname(),
    realm: PID_REALM,
    uuid: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const entry = `${identity.uuid}.json`;
  const tokenEntry = `${identity.uuid}.fifo`;
  const staging = `${lock}.${identity.uuid}.tmp`;
  let owner = null;
  let held = false;
  let token = null;
  try {
    await mkdir(staging);
    token = await createToken(path.join(staging, tokenEntry));
    identity.fifo = token?.fifo ?? null;
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
    if (!held) {
      await dropToken(token);
      await rm(staging, { recursive: true, force: true });
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Our entries, then the directory only if that emptied it: a lock anyone
    // else holds by now is untouched either way. The token is unlinked before
    // its read end closes, so it never reads as a dead owner's.
    await unlinkEntry(path.join(lock, entry));
    await unlinkEntry(path.join(lock, tokenEntry));
    await dropToken(token);
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
