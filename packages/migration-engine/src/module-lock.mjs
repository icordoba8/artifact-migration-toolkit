// One shared write-serialization primitive for every mutating migration
// command: initialization, refresh, advance, registry update, upgrade,
// rollback, and recovery. There is deliberately no second lock format and no
// per-command journal dialect -- everything that mutates a module's persisted
// artifacts takes this lock, keyed by target root plus lock name.
//
// The lock is an existence lock whose holder is identified by PID and process
// start marker. Abrupt process death leaves the file behind, so a waiter that
// proves the holder is gone reclaims it through an atomic rename: only one
// racer can win a rename of the same path, so reclamation cannot double-grant.
//
// ponytail: PID identity, not an OS-held handle. Node cannot portably hold an
// advisory lock that the kernel releases on death (Windows has no flock, and
// an open handle does not block a second `open` here), so identity plus atomic
// reclaim is the portable equivalent. Ceiling: a recycled PID belonging to a
// live unrelated process makes a stale lock look held until `staleAfterMs`
// elapses. Upgrade path: an OS-held lock via a native addon, if that ever
// becomes worth a dependency.

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const LOCK_ROOT = ".agents/knowledge/migrations/locks";

export const lockPathFor = (targetRoot, name) =>
  path.join(targetRoot, LOCK_ROOT, `${name}.lock`);

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

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

const readOwner = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // A torn or hand-edited lock file has no provable owner.
    return { pid: null, corrupt: true };
  }
};

/**
 * Atomically drops a lock proven stale. The rename is the arbiter: a second
 * process that already reclaimed and re-created the lock makes this rename
 * fail (or move a file whose owner no longer matches), so it never removes a
 * lock another process legitimately holds.
 */
const reclaimStale = async (file, owner) => {
  const parked = `${file}.${randomUUID()}.stale`;
  try {
    await rename(file, parked);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const parkedOwner = await readOwner(parked);
  await rm(parked, { force: true });
  // If the parked bytes are not the ones we proved stale, another process
  // re-created the lock between our read and our rename; treat it as held.
  return JSON.stringify(parkedOwner) === JSON.stringify(owner);
};

/**
 * @param {string} targetRoot repository that owns the lock directory
 * @param {string} name lock name; use the canonical module name
 * @returns {Promise<() => Promise<void>>} release function
 */
export const acquireModuleLock = async (
  targetRoot,
  name,
  { timeoutMs = 30_000, pollMs = 25, staleAfterMs = 15 * 60_000 } = {},
) => {
  const file = lockPathFor(targetRoot, name);
  await mkdir(path.dirname(file), { recursive: true });
  const identity = {
    pid: process.pid,
    uuid: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + timeoutMs;
  let contender = null;

  // The deadline is checked once per attempt, before it, so every retry path
  // is bounded. A reclaim that "succeeds" while the lock keeps reappearing --
  // a live racer re-creating it, or a reclaim that cannot actually remove the
  // file -- used to `continue` past the deadline check and spin forever.
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Another migration command holds the lock for '${name}' at ${file} (pid ${contender?.pid ?? "unknown"}). Wait for it to finish; the lock is reclaimed automatically once that process is gone.`,
      );
    }
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readOwner(file);
      contender = owner;
      const age = owner?.acquiredAt
        ? Date.now() - Date.parse(owner.acquiredAt)
        : await stat(file)
            .then((entry) => Date.now() - entry.mtimeMs)
            .catch(() => 0);
      const stale =
        owner === null ||
        (owner.corrupt === true && age > staleAfterMs) ||
        (owner.corrupt !== true && !processAlive(owner.pid)) ||
        age > staleAfterMs;
      // ponytail: a successful reclaim retries immediately -- the normal case
      // wins the very next `open`. A pathological reclaim loop therefore spins
      // hot, but only until the deadline above. Add a sleep here if that ever
      // shows up in a profile.
      if (stale && (await reclaimStale(file, owner))) continue;
      await sleep(pollMs);
      continue;
    }
    await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
    await handle.sync().catch(() => undefined);
    await handle.close();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const owner = await readOwner(file);
      // Never remove a lock another process reclaimed from us.
      if (owner?.uuid !== identity.uuid) return;
      await unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    };
  }
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
