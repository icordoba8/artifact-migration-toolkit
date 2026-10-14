/**
 * Lifecycle: the one journal protocol (Track B DR13).
 *
 * Five journal formats keep their names, bytes, stages and recovery order:
 *
 * | Journal | File | Owner (adapter) | Lock | Settles by |
 * |---|---|---|---|---|
 * | Module transition (advance, refresh, reopen, rework, amend, repair, adoption, toolkit identity, format upgrade) | `<record>/advance.journal` | `record.mjs` `recoverPendingAdvance` | module | removal |
 * | Module initialization | `init/<module>.journal` | `bootstrap.mjs` `recoverInitialization` | module | removal |
 * | Registry and project binding | `registry.journal.json` | `registry.mjs` `recoverRegistryJournal` | `registry` | removal |
 * | Artifact transaction | `artifacts/<id>/transaction.json` | `artifact-transaction.mjs` `recoverTransaction` | artifact | removal |
 * | Contract upgrade or rollback | `upgrades/<module>/<id>/transaction.json` | `contract-upgrade.mjs` `recoverTransaction` | module | terminal state, kept |
 *
 * What they share is defined here once:
 * - A journal lives below `<target>/.agents/knowledge/migrations/`, and is
 *   written by the store replace-write from that target root.
 * - It is read only as a regular file reached without a symlink, holding one
 *   JSON object. Anything else is unreadable: never recoverable, never removed.
 * - Recovery runs under the owner's lock. The format adapter validates the
 *   journal and binds it to where it was found, classifies what is on disk into
 *   one of the phases its writer can leave, and refuses any other phase before
 *   writing anything. It then repairs durably and proves the result.
 * - The journal is retired only after that proof, by a removal whose directory
 *   is fsynced (the upgrade journal instead keeps its terminal state as the
 *   record). A failed recovery throws with the journal byte-for-byte in place,
 *   so running it again is always safe.
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { HISTORY_FILE, INTEGRITY_FILE, transactionRoot } from "../formats/index.mjs";
import {
  assertProjectRootContainment,
  assertSecurePath,
  isLexicallyWithin,
  isPlainObject,
  normalizeRelative,
} from "../shared/index.mjs";
import { atomicWrite, migrationRoot, removeDurably } from "../store/index.mjs";

// The target root -- the last `.agents/knowledge/migrations` prefix -- is the
// trusted root a journal path is checked from. A journal anywhere else is refused.
const MIGRATIONS_SEGMENT = `${path.sep}${path.join(".agents", "knowledge", "migrations")}${path.sep}`;
const journalTargetRoot = (file) => {
  const absolute = path.resolve(file);
  const at = absolute.lastIndexOf(MIGRATIONS_SEGMENT);
  if (at < 0) throw new Error(`Refusing a journal outside .agents/knowledge/migrations: ${absolute}`);
  return absolute.slice(0, at) || path.parse(absolute).root;
};

/**
 * Crash-safe journal write, so a reader never observes a half-written journal.
 * DR7: the store replace-write, checked from the target root -- no write
 * through a symlink anywhere below it, the temp file removed on failure, new
 * directories and the rename fsynced. Byte format and operator-only mode are
 * unchanged. Shared by every lifecycle journal.
 */
export const writeJournalAtomic = async (file, journal) => {
  await atomicWrite(journalTargetRoot(file), file, `${JSON.stringify(journal, null, 2)}\n`);
};

/** Retires a journal: the store durable removal, checked from the target root. */
export const removeJournal = (file) => removeDurably(journalTargetRoot(file), file);

/**
 * `null` when no journal exists; `{ file, journal }` for a regular file below
 * the target root, reached through no symlink, holding one JSON object; and
 * `{ file, corrupt: true }` for anything else, which no adapter may recover.
 */
export const readJournal = async (file) => {
  try {
    await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const absolute = await assertSecurePath(journalTargetRoot(file), file);
    if (!(await lstat(absolute)).isFile()) return { file, corrupt: true };
    const journal = JSON.parse(await readFile(absolute, "utf8"));
    return isPlainObject(journal) ? { file, journal } : { file, corrupt: true };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // A symlink, an escaping path or bytes that are not JSON carry no code.
    if (error.code) throw error;
    return { file, corrupt: true };
  }
};

/**
 * The recovery protocol every journal follows (see the table above). `recover`
 * is the format adapter: it validates, classifies, repairs durably and proves,
 * throwing -- before any write -- on a phase its writer cannot leave. `keep`
 * leaves the settled journal in place for a format whose journal is its record.
 */
export const recoverJournal = async (file, { unreadable, recover, keep = false }) => {
  const found = await readJournal(file);
  if (!found) return null;
  if (found.corrupt) throw new Error(unreadable(file));
  const result = await recover(found.journal);
  if (!keep) await removeJournal(file);
  return result;
};

/** Refuses with the journal named and preserved; nothing was changed. */
export const refuseJournal = (file, why) => {
  throw new Error(
    `The interrupted transaction journal at ${file} ${why}. It was preserved exactly as found; investigate it before continuing. Nothing was changed.`,
  );
};

/**
 * Every path a recovery will write or remove, checked before the first write:
 * absolute and canonical as written (a `..` after a symlink would otherwise
 * resolve somewhere the lexical check never looked), inside its root, and with
 * no symlink anywhere below it, the entry included -- so a refusal never lands
 * after part of the repair.
 */
export const assertJournalTargets = async (file, targets) => {
  for (const [root, target] of targets) {
    const refuse = () => refuseJournal(file, `reaches ${target} outside its root, through a symlink or by a non-canonical path`);
    if (typeof root !== "string" || typeof target !== "string" || path.resolve(root) !== root || path.resolve(target) !== target) refuse();
    await assertSecurePath(root, target).catch(refuse);
  }
};

export const assertJournalFields = (file, value, allowed) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuseJournal(file, `carries a field its writer never records ('${key}')`);
  }
};

/**
 * The module transition journal, as every writer since v1.0.0 has recorded it:
 * one revision step, its history event, the files to restore if the state
 * write never landed, and the integrity anchor before and after.
 */
export const assertAdvanceJournal = (file, journal) => {
  assertJournalFields(file, journal, ["fromRevision", "toRevision", "event", "startedAt", "pid", "restore", "integrity"]);
  const { fromRevision, toRevision, event, restore = [], integrity } = journal;
  if (!Number.isInteger(fromRevision) || fromRevision < 1 || toRevision !== fromRevision + 1) {
    refuseJournal(file, `does not describe one revision step (${fromRevision} -> ${toRevision})`);
  }
  if (!isPlainObject(event) || typeof event.event !== "string" ||
      (event.revision !== undefined && event.revision !== toRevision)) {
    refuseJournal(file, "does not carry the history event of that step");
  }
  if (!Array.isArray(restore)) refuseJournal(file, "has no list of files to restore");
  for (const entry of restore) {
    if (!isPlainObject(entry)) refuseJournal(file, "has a malformed restore entry");
    assertJournalFields(file, entry, ["path", "remove", "content"]);
    let relative;
    try {
      relative = normalizeRelative(entry.path, "restore path");
    } catch {
      refuseJournal(file, "restores a path outside its record");
    }
    // The anchor, the audit record and the journal itself are never a restore
    // target: the anchor has its own field, and the other two only grow.
    if (relative !== entry.path || relative === "." || relative === INTEGRITY_FILE ||
        relative.startsWith(`${path.posix.dirname(HISTORY_FILE)}/`) || relative === path.basename(file)) {
      refuseJournal(file, `restores a path its writer never touches ('${entry.path}')`);
    }
    if ((entry.remove === true) === (typeof entry.content === "string") ||
        (entry.remove !== undefined && entry.remove !== true)) {
      refuseJournal(file, "has a restore entry that neither removes nor rewrites");
    }
  }
  if (integrity !== undefined && integrity !== null) {
    if (!isPlainObject(integrity)) refuseJournal(file, "has a malformed integrity anchor");
    assertJournalFields(file, integrity, ["content", "before"]);
    if (typeof integrity.content !== "string" || (integrity.before !== null && typeof integrity.before !== "string")) {
      refuseJournal(file, "has a malformed integrity anchor");
    }
  }
};

/** The contract upgrade's journal states, in writer order; the last two are terminal. */
export const UPGRADE_JOURNAL_STATES = ["PREPARED", "LIVE_MOVED", "TARGET_COMMITTED", "DONE", "ROLLED_BACK"];

/**
 * Every upgrade journal found in a module's upgrade root, terminal or not:
 * fields, state and kind its coordinator writes, this module, and a directory
 * named for its confirmation. A pending one must also name, exactly as its
 * writer derived them, this module's live tree -- the path recovery renames
 * into -- and directory. (A terminal journal is a record, so it stays readable
 * after the target repository moves.)
 */
export const assertUpgradeJournal = (file, journal, { targetRoot, moduleName, directory }) => {
  assertJournalFields(file, journal, ["confirmationId", "module", "kind", "restores", "livePath", "directory", "startedAt", "state", "recoveredAt"]);
  const terminal = journal.state === "DONE" || journal.state === "ROLLED_BACK";
  if (!UPGRADE_JOURNAL_STATES.includes(journal.state) || !["UPGRADE", "ROLLBACK"].includes(journal.kind) ||
      journal.module !== moduleName || typeof journal.confirmationId !== "string" ||
      path.resolve(directory) !== transactionRoot(targetRoot, moduleName, journal.confirmationId) ||
      // Every writer records both paths; their last segments survive a repository move.
      typeof journal.livePath !== "string" || path.basename(journal.livePath) !== moduleName ||
      typeof journal.directory !== "string" || path.basename(journal.directory) !== journal.confirmationId ||
      (!terminal && (journal.directory !== path.resolve(directory) || journal.livePath !== migrationRoot(targetRoot, moduleName)))) {
    refuseJournal(file, "does not belong to this module's upgrade directory, or records a state or kind no upgrade writes");
  }
};
