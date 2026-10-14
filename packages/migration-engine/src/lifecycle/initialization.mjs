/**
 * Lifecycle: the module initialization journal -- its path, the root owner
 * marker, the commit cleanup, the rollback, and its recovery adapter on the
 * DR13 journal protocol. `bootstrap.mjs` writes and commits it; `context.mjs`
 * (`recoverMigrationRecord`) and `bootstrap.mjs` recover it under the module
 * lock; `preview.mjs` only detects it. Moved from `bootstrap.mjs` (Track B DR13).
 */
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  assertProjectRootContainment,
  isLexicallyWithin,
  sameFile,
} from "../shared/index.mjs";
import {
  atomicWrite,
  fileExists,
  migrationRoot,
  removeDurably,
  removeEmptyParents,
  syncNearestDirectory,
} from "../store/index.mjs";
import { assertJournalFields, assertJournalTargets, recoverJournal, refuseJournal } from "./journal.mjs";
import { readState } from "./record.mjs";

export const initJournalFor = (targetRoot, moduleName) =>
  path.join(
    targetRoot,
    ".agents/knowledge/migrations/init",
    `${moduleName}.journal`,
  );

const ownerMatches = async (file, transactionId) =>
  file
    ? (await readFile(file, "utf8").catch(() => null)) === transactionId
    : false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stagedBeside = (target, id) => path.join(path.dirname(target), `.${path.basename(target)}.${id}.init`);

/**
 * The initialization journal is bound to this module and this target: every
 * path it names must be exactly the one its writer derives (unchanged since
 * v1.0.0), because rollback removes some of them recursively.
 */
const assertInitJournal = (file, journal, { targetRoot, moduleName }) => {
  assertJournalFields(file, journal, ["file", "transactionId", "module", "pid", "startedAt", "root", "rootOwner", "openSpecPath",
    "projectRoot", "configPath", "configBefore", "configAfter", "stagedRoot", "stagedOpenSpec", "stagedProjectConfig"]);
  const { transactionId: id, root, openSpecPath, configPath, projectRoot } = journal;
  const same = (left, right) => typeof left === "string" && path.resolve(left) === path.resolve(right);
  if (journal.module !== moduleName || !same(journal.file, file) || typeof id !== "string" || !UUID.test(id) ||
      !same(root, migrationRoot(targetRoot, moduleName)) || !same(journal.rootOwner, path.join(root, ".init-owner")) ||
      !same(journal.stagedRoot, stagedBeside(root, id))) {
    refuseJournal(file, "does not belong to this module's initialization");
  }
  if (openSpecPath === null ? journal.stagedOpenSpec !== null
    : typeof openSpecPath !== "string" || !isLexicallyWithin(targetRoot, openSpecPath) ||
      !same(journal.stagedOpenSpec, stagedBeside(openSpecPath, id))) {
    refuseJournal(file, "names an OpenSpec source outside this target");
  }
  try {
    assertProjectRootContainment(projectRoot, { targetRoot });
  } catch {
    refuseJournal(file, "names a project unrelated to this target");
  }
  const config = path.join(projectRoot, "package.json");
  if (typeof journal.configBefore !== "string" || (configPath === null
    ? journal.stagedProjectConfig !== null || journal.configAfter !== undefined
    : !same(configPath, config) || typeof journal.configAfter !== "string" ||
      !same(journal.stagedProjectConfig, stagedBeside(config, id)))) {
    refuseJournal(file, "names a project binding its writer never stages");
  }
};

// Staged copies and this transaction's owner marker go, each removal durable
// before the journal that names them may be retired.
export const cleanupInitialization = async (targetRoot, journal) => {
  for (const staged of [journal.stagedRoot, journal.stagedOpenSpec, journal.stagedProjectConfig]) {
    if (staged) await rm(staged, { recursive: true, force: true }).then(() => syncNearestDirectory(path.dirname(staged)));
  }
  if (await ownerMatches(journal.rootOwner, journal.transactionId)) await removeDurably(targetRoot, journal.rootOwner);
};

export const rollbackInitialization = async (targetRoot, journal) => {
  if (journal.configPath && journal.configAfter !== undefined &&
      (await readFile(journal.configPath, "utf8").catch(() => null)) === journal.configAfter) {
    await atomicWrite(journal.projectRoot, journal.configPath, journal.configBefore);
  }
  if (await ownerMatches(journal.rootOwner, journal.transactionId)) {
    await rm(journal.root, { recursive: true, force: true });
  }
  // Stopped between creating the root and owning it: an empty root holds
  // nothing, so it goes before the journal does (anything else stays).
  await removeEmptyParents(journal.root, path.dirname(journal.root));
  if (
    journal.openSpecPath &&
    journal.stagedOpenSpec &&
    (await sameFile(journal.openSpecPath, journal.stagedOpenSpec))
  ) {
    await rm(journal.openSpecPath, { force: true });
    await removeEmptyParents(path.dirname(journal.openSpecPath), targetRoot);
    await syncNearestDirectory(path.dirname(journal.openSpecPath));
  }
  // The undo is durable before the journal goes (nearest: modules/ may not exist yet).
  await syncNearestDirectory(path.dirname(journal.root));
  await cleanupInitialization(targetRoot, journal);
  await removeEmptyParents(path.dirname(journal.root), targetRoot);
};

/**
 * Undoes or completes an initialization that died between its three commits
 * (OpenSpec authority, migration tree, project binding). Runs under the module
 * lock before any new initialization work, so an abrupt death never leaves a
 * committed OpenSpec without its migration, a half-staged tree, or a project
 * binding pointing at a migration that does not exist. DR13: the journal must
 * name exactly this module's paths, and a root this transaction does not own is
 * refused before anything is undone; the journal is retired only after the undo
 * is durable.
 */
export const recoverInitialization = (targetRoot, moduleName) => {
  const file = initJournalFor(targetRoot, moduleName);
  return recoverJournal(file, {
    unreadable: () => `Initialization journal is unreadable at ${file}. Preserve it and inspect the transaction before continuing.`,
    recover: async (journal) => {
      assertInitJournal(file, journal, { targetRoot, moduleName });
      const { root, stagedRoot, openSpecPath, stagedOpenSpec, projectRoot, configPath, stagedProjectConfig } = journal;
      // The owner marker authorizes a recursive removal: it is read only as itself, never through a link.
      await assertJournalTargets(file, [[targetRoot, root], [targetRoot, journal.rootOwner], [targetRoot, stagedRoot],
        ...(openSpecPath ? [[targetRoot, openSpecPath], [targetRoot, stagedOpenSpec]] : []),
        ...(configPath ? [[projectRoot, configPath], [projectRoot, stagedProjectConfig]] : [])]);
      const owner = await readFile(journal.rootOwner, "utf8").catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
      if (owner !== null && owner !== journal.transactionId) refuseJournal(file, "names a migration root another initialization owns");
      if (await fileExists(path.join(journal.root, "state.json"))) {
        // Committed: proven by the record reading clean, the OpenSpec source it
        // linked and the registry binding it wrote, before the journal goes.
        const binding = (bytes) => { try { return JSON.parse(bytes).config?.startMigration?.registry; } catch { return undefined; } };
        if ((openSpecPath && !(await fileExists(openSpecPath))) ||
            (configPath && binding(await readFile(configPath, "utf8").catch(() => "")) !== binding(journal.configAfter))) {
          refuseJournal(file, "is committed, but its OpenSpec source or registry binding is no longer the one it wrote");
        }
        await readState(targetRoot, moduleName);
        await cleanupInitialization(targetRoot, journal);
        return { outcome: "COMPLETED" };
      }
      // Unowned, a root is empty (death before the owner landed) or someone else's evidence.
      if (owner === null && (await readdir(journal.root).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)))).length) {
        refuseJournal(file, "names a migration root holding files no initialization owns");
      }
      await rollbackInitialization(targetRoot, journal);
      return { outcome: "ROLLED_BACK" };
    },
  });
};
