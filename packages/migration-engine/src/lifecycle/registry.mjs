/**
 * Lifecycle: the pending-transaction scan and the journalled registry update
 * (Track A8, moved verbatim from `migration-utils.mjs`), with the registry
 * journal's recovery adapter (Track B DR13, moved from `store/registry.mjs`).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { engineCommand } from "../engine-paths.mjs";
import {
  assertJournalFields,
  assertJournalTargets,
  assertUpgradeJournal,
  readJournal,
  recoverJournal,
  refuseJournal,
  removeJournal,
  writeJournalAtomic,
} from "./journal.mjs";
import { withModuleLock } from "./lock.mjs";
import {
  assertProjectRootContainment,
  isLexicallyWithin,
} from "../shared/index.mjs";
import {
  atomicWrite,
  persistProjectRegistryBinding,
  previewRegistryUpdate,
  registryJournalPathFor,
  validateRegistry,
} from "../store/index.mjs";

/**
 * Unfinished upgrade transactions for one module. A non-DONE journal must stop
 * every normal command until deterministic recovery completes, so this lives
 * beside the shared helpers rather than inside the upgrade coordinator.
 */
export const pendingTransactions = async (targetRoot, moduleName) => {
  const root = path.join(
    targetRoot,
    ".agents/knowledge/migrations/upgrades",
    moduleName,
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const pending = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const file = path.join(directory, "transaction.json");
    const found = await readJournal(file);
    if (!found) continue;
    // DR13: an unreadable journal is never skipped as settled; it blocks.
    if (found.corrupt) {
      throw new Error(
        `Upgrade transaction journal is unreadable at ${file}. Preserve it and inspect the transaction before continuing.`,
      );
    }
    const { journal } = found;
    // DR13: a terminal state is trusted as settled only on a well-formed journal of this module.
    assertUpgradeJournal(file, journal, { targetRoot, moduleName, directory });
    if (journal.state !== "DONE" && journal.state !== "ROLLED_BACK") {
      pending.push({ ...journal, file, directory });
    }
  }
  return pending;
};

export const assertNoPendingTransaction = async (targetRoot, moduleName) => {
  const [pending] = await pendingTransactions(targetRoot, moduleName);
  if (pending) {
    throw new Error(
      `An unfinished upgrade transaction exists for '${moduleName}' in state ${pending.state}. Run '${engineCommand("upgrades/upgrade-migration.mjs", moduleName, "--recover")}' before any other migration work.`,
    );
  }
};

const readOrNull = (file) =>
  readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

/**
 * The registry journal's writes, bound to where its writer could have aimed
 * them: the registry inside this target, and the binding in the package.json of
 * a project that contains that registry and is related to this target.
 */
const registryJournalWrites = (file, journal, targetRoot) => {
  assertJournalFields(file, journal, ["registryPath", "registryBefore", "registryAfter", "configPath", "configBefore", "configAfter", "projectRoot"]);
  const { registryPath, configPath, projectRoot } = journal;
  const text = (value, nullable = false) => typeof value === "string" || (nullable && value === null);
  if (!text(registryPath) || !isLexicallyWithin(targetRoot, registryPath) ||
      !text(journal.registryBefore, true) || !text(journal.registryAfter)) {
    refuseJournal(file, "does not describe a registry write inside this target");
  }
  // The bytes it would write are what `previewRegistryUpdate` produces: a valid registry document.
  try {
    validateRegistry(JSON.parse(journal.registryAfter), registryPath);
  } catch {
    refuseJournal(file, "would write a registry document that does not validate");
  }
  const writes = [{ label: "the registry", root: targetRoot, file: registryPath, before: journal.registryBefore, after: journal.registryAfter }];
  if (configPath === undefined || configPath === null) {
    if (journal.configBefore != null || journal.configAfter != null) refuseJournal(file, "has a binding without its package.json");
    return writes;
  }
  try {
    assertProjectRootContainment(projectRoot, { targetRoot });
  } catch {
    refuseJournal(file, "names a project unrelated to this target");
  }
  // ...and a package.json binding this project to exactly that registry.
  const bound = (() => { try { return JSON.parse(journal.configAfter).config.startMigration.registry; } catch { return undefined; } })();
  if (path.resolve(configPath) !== path.resolve(projectRoot, "package.json") || !isLexicallyWithin(projectRoot, registryPath) ||
      !text(journal.configBefore, true) || typeof bound !== "string" || path.resolve(projectRoot, bound) !== path.resolve(registryPath)) {
    refuseJournal(file, "does not describe this project's registry binding");
  }
  return [...writes, { label: "the project binding", root: projectRoot, file: configPath, before: journal.configBefore, after: journal.configAfter }];
};

/**
 * Finishes a registry+config write pair a previous invocation started but
 * never got to clean up (killed mid-write). Runs under the registry lock,
 * before any new update is computed. Each file must still hold its journalled
 * "before" or "after" bytes -- the only states the writer leaves -- or nothing
 * is written and the journal stays: a change made outside the workflow is
 * never clobbered, and never mistaken for a finished registration (DR13).
 */
const recoverRegistryJournal = (targetRoot) => {
  const file = registryJournalPathFor(targetRoot);
  return recoverJournal(file, {
    unreadable: () =>
      `Registry transaction journal is unreadable at ${file}. Preserve it and inspect the transaction before continuing.`,
    recover: async (journal) => {
      const writes = registryJournalWrites(file, journal, targetRoot);
      await assertJournalTargets(file, writes.map((write) => [write.root, write.file]));
      const current = await Promise.all(writes.map((write) => readOrNull(write.file)));
      writes.forEach((write, at) => {
        if (current[at] !== write.before && current[at] !== write.after) {
          refuseJournal(file, `cannot be finished: ${write.label} at ${write.file} holds neither its journalled before nor after bytes`);
        }
      });
      for (const [at, write] of writes.entries()) {
        if (current[at] !== write.after) await atomicWrite(write.root, write.file, write.after);
      }
      for (const write of writes) {
        if ((await readOrNull(write.file)) !== write.after) refuseJournal(file, `did not finish: ${write.label} changed during recovery`);
      }
      return { outcome: current.every((bytes, at) => bytes === writes[at].after) ? "ALREADY_COMPLETE" : "COMPLETED" };
    },
  });
};

/** @param {{ registryPath?: string, moduleName: string, target: string, aliases?: string[], confirmExecution?: string }} options */
export const updateRegistry = async ({
  registryPath,
  projectRoot,
  moduleName,
  target,
  aliases = [],
  confirmExecution,
}) => {
  const preview = await previewRegistryUpdate({
    registryPath,
    projectRoot,
    moduleName,
    target,
    aliases,
  });
  if (
    typeof confirmExecution !== "string" ||
    confirmExecution !== preview.confirmationId
  ) {
    throw new Error(
      "Registration confirmation is missing or expired. Show the current pre-execution summary and ask the user to confirm again.",
    );
  }
  // The registry is one shared file for every module, so registration takes the
  // target-owned registry lock and recomputes the document from the bytes that
  // are on disk under that lock. Two concurrent registrations of different
  // modules therefore merge; a concurrent registration that contradicts this
  // one fails validation instead of silently overwriting it.
  return withModuleLock(preview.targetRoot, "registry", async () => {
    await recoverRegistryJournal(preview.targetRoot);
    const fresh = await previewRegistryUpdate({
      registryPath,
      projectRoot,
      moduleName,
      target,
      aliases,
    });
    if (
      fresh.existingTarget !== null &&
      fresh.existingTarget !== preview.existingTarget &&
      fresh.existingTarget !== target
    ) {
      throw new Error(
        `Registration is stale: '${moduleName}' now maps to '${fresh.existingTarget}' in the registry. Preview again.`,
      );
    }
    const journalFile = registryJournalPathFor(fresh.targetRoot);
    await writeJournalAtomic(journalFile, {
      registryPath: fresh.registryPath,
      registryBefore: fresh.before,
      registryAfter: fresh.content,
      configPath: fresh.registryBinding.configPath,
      configBefore: fresh.registryBinding.before,
      configAfter: fresh.registryBinding.content,
      projectRoot: fresh.registryBinding.projectRoot,
    });
    // Registry first: a death before the binding write leaves a registry the
    // next invocation's recovery re-binds idempotently, whereas the reverse
    // order would acknowledge a mapping that is not there. A failure keeps the
    // journal for that recovery; only a finished pair retires it (DR13).
    if (fresh.changed) {
      await atomicWrite(fresh.targetRoot, fresh.registryPath, fresh.content);
    }
    await persistProjectRegistryBinding(fresh.registryBinding);
    await removeJournal(journalFile);
    return { changed: fresh.changed, moduleName, target };
  });
};
