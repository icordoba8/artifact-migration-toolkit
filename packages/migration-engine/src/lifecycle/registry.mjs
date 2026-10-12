/**
 * Lifecycle: the pending-transaction scan and the journalled registry update
 * (Track A8, moved verbatim from `migration-utils.mjs`).
 */
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { engineCommand } from "../engine-paths.mjs";
import { withModuleLock, writeJournalAtomic } from "./lock.mjs";
import {
  atomicWrite,
  persistProjectRegistryBinding,
  previewRegistryUpdate,
  recoverRegistryJournal,
  registryJournalPathFor,
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
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const journal = JSON.parse(content);
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
    try {
      // Registry first: a death before the binding write leaves a registry the
      // next invocation's recovery re-binds idempotently, whereas the reverse
      // order would acknowledge a mapping that is not there.
      if (fresh.changed) {
        await atomicWrite(fresh.targetRoot, fresh.registryPath, fresh.content);
      }
      await persistProjectRegistryBinding(fresh.registryBinding);
    } finally {
      await unlink(journalFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { changed: fresh.changed, moduleName, target };
  });
};
