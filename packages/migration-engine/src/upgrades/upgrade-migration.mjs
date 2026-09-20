#!/usr/bin/env node

// Explicit contract-4 to contract-5 upgrade coordinator.
//
// Preview is read-only. Confirmed execution takes an exclusive per-module lock,
// snapshots the source outside the live tree, builds and validates the target
// in memory, stages it on the same filesystem, and commits it through a
// journalled, recoverable replacement. Directory replacement is not atomic on
// every platform, so this is locked, staged, and recoverable, not atomic.

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";

import { acquireModuleLock } from "../module-lock.mjs";
import { writeJournalAtomic } from "../module-lock.mjs";
import {
  assertSafeName,
  gitRevision,
  pendingTransactions,
  readRegistry,
  resolveRegistryPath,
  resolveModule,
} from "../migration-utils.mjs";
import {
  assertToolkitIdentityNotMismatched,
  loadOpenSpecAuthority,
  migrationRoot,
  reconcileSliceState,
} from "../resumable-migration.mjs";
import {
  upgradeV4ToV5,
  V5_CONTRACT_VERSION,
  V5_FORMAT_VERSION,
  V5_WORKFLOW_VERSION,
} from "./upgrade-v4-to-v5.mjs";

const contractPath = fileURLToPath(
  new URL("../../references/v5-contract.md", import.meta.url),
);

export const TRANSACTION_STATES = [
  "PREPARED",
  "LIVE_MOVED",
  "TARGET_COMMITTED",
  "DONE",
  "ROLLED_BACK",
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const upgradesRoot = (targetRoot) =>
  path.join(targetRoot, ".agents/knowledge/migrations/upgrades");

const moduleUpgradeRoot = (targetRoot, moduleName) =>
  path.join(upgradesRoot(targetRoot), moduleName);

const lockPathFor = (targetRoot, moduleName) =>
  path.join(moduleUpgradeRoot(targetRoot, moduleName), "upgrade.lock");

const transactionRoot = (targetRoot, moduleName, confirmationId) =>
  path.join(moduleUpgradeRoot(targetRoot, moduleName), confirmationId);

const exists = async (target) => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const assertNoSymlink = async (target) => {
  const details = await lstat(target);
  if (details.isSymbolicLink()) {
    throw new Error(`Refusing symlinked migration path: ${target}`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Migration path is not a directory: ${target}`);
  }
};

/** Reads a whole tree as UTF-8 text, rejecting symlinks anywhere inside it. */
const readTree = async (root) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symlinked migration file: ${absolute}`);
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    files[relative] = await readFile(absolute, "utf8");
  }
  return files;
};

const manifestOf = (files) =>
  Object.keys(files)
    .sort()
    .map((relative) => {
      const buffer = Buffer.from(files[relative], "utf8");
      return { path: relative, bytes: buffer.byteLength, sha256: sha256(buffer) };
    });

const writeTree = async (root, files) => {
  for (const relative of Object.keys(files).sort()) {
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, files[relative], "utf8");
  }
};

const sameManifest = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

const readJournal = async (file) => JSON.parse(await readFile(file, "utf8"));

// Journal writes are temp-file + rename: a process killed mid-write must never
// leave a torn journal, because the journal is what recovery reads.
const writeJournal = writeJournalAtomic;

// The shared helper is the single implementation; every normal command uses it.
export { pendingTransactions };

/**
 * Deterministic recovery. Restores the original tree or finishes a target that
 * is already proven identical to the staged manifest. It never guesses.
 */
export const recoverTransaction = async (journal) => {
  const { livePath, directory, state } = journal;
  const rollbackPath = path.join(directory, "rollback-live");
  const stagingPath = path.join(directory, "staging");
  const snapshotPath = path.join(directory, "source-snapshot");
  const readManifest = async (name) => {
    try {
      return JSON.parse(await readFile(path.join(directory, name), "utf8"))
        .files;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const targetManifest = await readManifest("target-manifest.json");
  const sourceManifest = await readManifest("source-manifest.json");
  const liveManifest = (await exists(livePath))
    ? manifestOf(await readTree(livePath))
    : null;

  const finish = async (outcome) => {
    await writeJournal(journal.file, {
      ...journal,
      file: undefined,
      state: outcome,
      recoveredAt: new Date().toISOString(),
    });
    return { outcome, from: state };
  };

  if (targetManifest && liveManifest && sameManifest(liveManifest, targetManifest)) {
    await rm(stagingPath, { recursive: true, force: true });
    await rm(rollbackPath, { recursive: true, force: true });
    return finish("DONE");
  }
  if (sourceManifest && liveManifest && sameManifest(liveManifest, sourceManifest)) {
    await rm(stagingPath, { recursive: true, force: true });
    await rm(rollbackPath, { recursive: true, force: true });
    return finish("ROLLED_BACK");
  }
  if (!liveManifest && (await exists(rollbackPath))) {
    const rollbackManifest = manifestOf(await readTree(rollbackPath));
    if (sourceManifest && !sameManifest(rollbackManifest, sourceManifest)) {
      throw new Error(
        `Cannot recover upgrade ${journal.confirmationId}: the preserved rollback tree does not match the recorded source manifest. Restore ${snapshotPath} manually.`,
      );
    }
    await mkdir(path.dirname(livePath), { recursive: true });
    await rename(rollbackPath, livePath);
    await rm(stagingPath, { recursive: true, force: true });
    return finish("ROLLED_BACK");
  }
  // A process killed between `mkdir` and the manifest writes leaves a journal
  // with no manifest to compare against. The retained immutable snapshot is
  // still the deterministic answer, so recovery restores it instead of raising
  // a raw ENOENT and wedging the module with no documented escape.
  if (!liveManifest && (await exists(snapshotPath))) {
    await mkdir(path.dirname(livePath), { recursive: true });
    await cp(snapshotPath, livePath, { recursive: true });
    await rm(stagingPath, { recursive: true, force: true });
    await rm(rollbackPath, { recursive: true, force: true });
    return finish("ROLLED_BACK");
  }
  if (liveManifest && (!targetManifest || !sourceManifest)) {
    // Nothing was moved before the kill: the live tree is still the original.
    await rm(stagingPath, { recursive: true, force: true });
    await rm(rollbackPath, { recursive: true, force: true });
    return finish("ROLLED_BACK");
  }
  throw new Error(
    `Cannot recover upgrade ${journal.confirmationId}: the live tree matches neither the source nor the target manifest, and no rollback tree is present. The immutable snapshot is at ${snapshotPath}.`,
  );
};

const classify = (state) => {
  const formatVersion = state.formatVersion ?? 1;
  if (state.contractVersion === V5_CONTRACT_VERSION) {
    return { supported: false, reason: "ALREADY_V5", formatVersion };
  }
  if (state.contractVersion === 4 && formatVersion === 3) {
    return { supported: true, reason: "UPGRADABLE", formatVersion };
  }
  return { supported: false, reason: "UNSUPPORTED", formatVersion };
};

const resolveContext = async ({ registryPath, moduleName }) => {
  assertSafeName(moduleName);
  const registryData = await readRegistry(registryPath);
  let resolved;
  try {
    resolved = resolveModule(registryData, moduleName);
  } catch (error) {
    // An unregistered migration is still upgradable: fall back to the mapping
    // the persisted state already records.
    if (!/not registered/.test(error.message)) throw error;
    const statePath = path.join(
      migrationRoot(registryData.targetRoot, moduleName),
      "state.json",
    );
    if (!(await exists(statePath))) throw error;
    const state = JSON.parse(await readFile(statePath, "utf8"));
    resolved = {
      canonical: state.legacyModule,
      target: state.targetModule,
      registered: false,
    };
  }
  const livePath = migrationRoot(registryData.targetRoot, resolved.canonical);
  return { registryData, resolved, livePath };
};

/** Read-only. Creates no directory, writes nothing, never delegates. */
export const previewUpgrade = async ({
  registryPath,
  moduleName,
} = {}) => {
  const { registryData, resolved, livePath } = await resolveContext({
    registryPath,
    moduleName,
  });
  const contractDigest = `sha256:${sha256(await readFile(contractPath))}`;
  const base = {
    migration: resolved.canonical,
    target: resolved.target,
    livePath,
    contractDigest,
    sourceVersions: null,
    targetVersions: {
      contractVersion: V5_CONTRACT_VERSION,
      formatVersion: V5_FORMAT_VERSION,
      workflowVersion: V5_WORKFLOW_VERSION,
    },
    affectedFiles: [],
    stepChanges: [],
    reopenedStep: null,
    preservedCompletedSteps: [],
    invalidatedArtifacts: [],
    supersededFiles: [],
    missingV5Content: [],
    supportedDecisions: [],
    blockers: [],
    requiresConfirmation: false,
    confirmationId: null,
  };

  const blocked = (message) => ({ ...base, blockers: [message] });

  // An unfinished transaction outranks every other check: the live tree may not
  // exist at all while one is open.
  const pending = await pendingTransactions(
    registryData.targetRoot,
    resolved.canonical,
  );
  if (pending.length > 0) {
    return blocked(
      `An unfinished upgrade transaction exists for '${resolved.canonical}' in state ${pending[0].state}. Run this command with --recover before any other migration work.`,
    );
  }

  if (!(await exists(livePath))) {
    return blocked(
      `No persisted migration exists for '${resolved.canonical}'. There is nothing to upgrade.`,
    );
  }
  await assertNoSymlink(livePath);

  const files = await readTree(livePath);
  if (!Object.hasOwn(files, "state.json")) {
    return blocked(`No state.json exists under ${livePath}.`);
  }
  let state;
  try {
    state = JSON.parse(files["state.json"]);
  } catch (error) {
    return blocked(`Migration state is invalid JSON: ${error.message}`);
  }
  const compatibility = classify(state);
  const sourceVersions = {
    contractVersion: state.contractVersion ?? null,
    formatVersion: compatibility.formatVersion,
    workflowVersion: state.workflowVersion ?? null,
  };
  if (!compatibility.supported) {
    return {
      ...blocked(
        compatibility.reason === "ALREADY_V5"
          ? `Migration '${resolved.canonical}' already uses contract ${V5_CONTRACT_VERSION}. No upgrade is required.`
          : `Migration '${resolved.canonical}' uses contract ${sourceVersions.contractVersion} format ${sourceVersions.formatVersion}, which is unsupported. Only contract 4 with format 3 can be upgraded. The migration was left untouched.`,
      ),
      sourceVersions,
    };
  }

  const blockers = [];
  let legacyCommit = null;
  try {
    // migration-utils.mjs `gitRevision` returns `{ revision, pathScoped }`
    // (candidate fix: path-scoped instead of whole-repo HEAD). This coordinator
    // only needs the commit string to compare against the v4-era
    // `state.legacyCommit`, so it unwraps `.revision` here and keeps every
    // downstream use of `legacyCommit` as a plain string, matching the
    // original contract-4 field shape being read.
    legacyCommit = (await gitRevision(registryData.legacyRoot)).revision;
    if (state.legacyCommit !== legacyCommit) {
      blockers.push(
        `Legacy revision changed from '${state.legacyCommit}' to '${legacyCommit}'. Resolve the mismatch under contract 4 before upgrading.`,
      );
    }
  } catch (error) {
    blockers.push(error.message);
  }
  let openSpecDigest = null;
  try {
    const authority = await loadOpenSpecAuthority(
      registryData.targetRoot,
      resolved.target,
    );
    openSpecDigest = authority.digest;
    if (
      JSON.stringify(authority) !== JSON.stringify(state.requirementsAuthority)
    ) {
      blockers.push(
        `OpenSpec authority changed for '${resolved.target}'. Revalidate requirements under contract 4 before upgrading.`,
      );
    }
  } catch (error) {
    blockers.push(error.message);
  }

  const navigation = blockers.length === 0
    ? await reconcileSliceState(livePath, state)
    : null;
  const now = new Date().toISOString();
  const transformation = upgradeV4ToV5({
    files,
    navigation: navigation
      ? { ...navigation.state, repairs: navigation.repairs }
      : undefined,
    now,
    contractDigest,
  });
  blockers.push(...transformation.blockers);

  const sourceManifest = manifestOf(files);
  const preview = {
    ...base,
    sourceVersions,
    openSpecDigest,
    legacyCommit,
    sourceManifest,
    affectedFiles: transformation.report?.changedFiles ?? [],
    stepChanges: transformation.report?.stepChanges ?? [],
    reopenedStep: transformation.report?.reopenedStep ?? null,
    preservedCompletedSteps:
      transformation.report?.preservedCompletedSteps ?? [],
    invalidatedArtifacts: transformation.report?.invalidatedArtifacts ?? [],
    supersededFiles: transformation.report?.supersededFiles ?? [],
    missingV5Content: transformation.report?.missingV5Content ?? [],
    navigationRepairs: transformation.report?.navigationRepairs ?? [],
    // The frozen contract resolves ambiguity by refusing, not by decision input.
    supportedDecisions: [],
    blockers,
    requiresConfirmation: blockers.length === 0,
  };
  return {
    ...preview,
    confirmationId:
      blockers.length === 0 ? confirmationIdFor(preview) : null,
  };
};

const confirmationIdFor = (preview) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sourceManifest: preview.sourceManifest,
        sourceVersions: preview.sourceVersions,
        targetVersions: preview.targetVersions,
        contractDigest: preview.contractDigest,
        openSpecDigest: preview.openSpecDigest,
        legacyCommit: preview.legacyCommit,
        decisions: preview.supportedDecisions,
        rendered: renderUpgradePreview(preview),
      }),
    )
    .digest("hex")
    .slice(0, 16);

export const renderUpgradePreview = (preview) =>
  `Upgrade pre-execution summary\n` +
  `Migration: ${preview.migration}\n` +
  `Target: ${preview.target}\n` +
  `Source: contract ${preview.sourceVersions?.contractVersion ?? "none"} format ${preview.sourceVersions?.formatVersion ?? "none"} workflow ${preview.sourceVersions?.workflowVersion ?? "none"}\n` +
  `Target: contract ${preview.targetVersions.contractVersion} format ${preview.targetVersions.formatVersion} workflow ${preview.targetVersions.workflowVersion}\n` +
  `Affected files: ${preview.affectedFiles.length > 0 ? preview.affectedFiles.join(", ") : "none"}\n` +
  `Step changes: ${preview.stepChanges.length > 0 ? preview.stepChanges.join(", ") : "none"}\n` +
  `Earliest reopened step: ${preview.reopenedStep ?? "none"}\n` +
  `Preserved completion: ${preview.preservedCompletedSteps.length > 0 ? preview.preservedCompletedSteps.join(", ") : "none"}\n` +
  `Invalidated trust: ${preview.invalidatedArtifacts.length > 0 ? preview.invalidatedArtifacts.join(", ") : "none"}\n` +
  `Superseded files: ${preview.supersededFiles.length > 0 ? preview.supersededFiles.join(", ") : "none"}\n` +
  `Missing v5 content: ${preview.missingV5Content.length > 0 ? preview.missingV5Content.join("; ") : "none"}\n` +
  `Supported decisions: none. Ambiguity refuses the upgrade instead of guessing.\n` +
  `Blockers: ${preview.blockers.length > 0 ? preview.blockers.join("; ") : "none"}\n`;

/**
 * The journalled, recoverable replacement. Upgrade and rollback share it: only
 * the staged tree and the manifest it must match differ.
 */
const commitReplacement = async ({
  journalFile,
  journal: journalBase,
  livePath,
  stagingPath,
  rollbackPath,
  expectedManifest,
  hooks = {},
}) => {
  const journal = { ...journalBase, state: "PREPARED" };
  const advance = async (state) => {
    journal.state = state;
    await writeJournal(journalFile, journal);
    await hooks.afterJournal?.(state);
  };

  await advance("PREPARED");
  await rename(livePath, rollbackPath);
  await hooks.afterRename?.("LIVE_MOVED");
  await advance("LIVE_MOVED");
  await rename(stagingPath, livePath);
  await hooks.afterRename?.("TARGET_COMMITTED");
  await advance("TARGET_COMMITTED");

  const committed = manifestOf(await readTree(livePath));
  if (!sameManifest(committed, expectedManifest)) {
    throw new Error(
      "The committed tree does not match the target manifest. Run --recover.",
    );
  }
  await advance("DONE");
  // Temporary trees go only after DONE. source-snapshot is the durable copy and
  // is never removed; an interrupted transaction keeps everything for recovery.
  await rm(rollbackPath, { recursive: true, force: true });
};

// One lock primitive for the whole skill. The upgrade coordinator used its own
// bare existence lock, which a killed process left behind forever -- and
// `--recover` acquires the same lock, so the documented recovery command was
// unreachable exactly after the crash it exists to handle. The shared lock
// records process identity and lets a waiter reclaim a lock whose owner is
// provably gone, so a new process recovers without anyone deleting a file.
// Sharing it with the main workflow also makes upgrade and normal migration
// work mutually exclusive, which they always should have been.
const acquireLock = (targetRoot, moduleName) =>
  acquireModuleLock(targetRoot, moduleName);

/**
 * @param {{ registryPath?: string, moduleName: string, confirmUpgrade: string,
 *   hooks?: { afterJournal?: (state: string) => Promise<void>|void,
 *             afterRename?: (step: string) => Promise<void>|void } }} options
 */
export const executeUpgrade = async ({
  registryPath,
  moduleName,
  confirmUpgrade,
  hooks = {},
}) => {
  const { registryData, resolved, livePath } = await resolveContext({
    registryPath,
    moduleName,
  });
  const targetRoot = registryData.targetRoot;
  const release = await acquireLock(targetRoot, resolved.canonical);
  try {
    const pending = await pendingTransactions(targetRoot, resolved.canonical);
    if (pending.length > 0) {
      throw new Error(
        `An unfinished upgrade transaction exists for '${resolved.canonical}' in state ${pending[0].state}. Run --recover before upgrading.`,
      );
    }

    const preview = await previewUpgrade({ registryPath, moduleName });
    if (!preview.requiresConfirmation) {
      throw new Error(`Upgrade is blocked: ${preview.blockers.join("; ")}`);
    }
    if (
      typeof confirmUpgrade !== "string" ||
      confirmUpgrade !== preview.confirmationId
    ) {
      throw new Error(
        "Upgrade confirmation is missing or expired. Show the current preview and ask the user to confirm again.",
      );
    }

    const files = await readTree(livePath);
    // A v4 tree predates toolkit identity and cannot carry one, so this is a
    // mismatch check only: a stamped record may be upgraded exclusively by the
    // build it pins, and an unstamped one stays unstamped until it is adopted.
    assertToolkitIdentityNotMismatched(
      JSON.parse(files["state.json"]).toolkitIdentity ?? null,
      "Upgrading this migration",
    );
    const sourceManifest = manifestOf(files);
    if (!sameManifest(sourceManifest, preview.sourceManifest)) {
      throw new Error(
        "The migration tree changed while the upgrade was being confirmed. Nothing was modified.",
      );
    }
    const navigation = await reconcileSliceState(
      livePath,
      JSON.parse(files["state.json"]),
    );
    const now = new Date().toISOString();
    const transformation = upgradeV4ToV5({
      files,
      navigation: { ...navigation.state, repairs: navigation.repairs },
      now,
      contractDigest: preview.contractDigest,
    });
    if (transformation.blockers.length > 0) {
      throw new Error(`Upgrade is blocked: ${transformation.blockers.join("; ")}`);
    }
    const targetManifest = manifestOf(transformation.target);

    // Snapshot and staging begin only after the in-memory target validates.
    const directory = transactionRoot(
      targetRoot,
      resolved.canonical,
      preview.confirmationId,
    );
    const journalFile = path.join(directory, "transaction.json");
    const stagingPath = path.join(directory, "staging");
    const rollbackPath = path.join(directory, "rollback-live");
    await mkdir(directory, { recursive: true });
    await cp(livePath, path.join(directory, "source-snapshot"), {
      recursive: true,
    });
    const manifestHeader = {
      confirmationId: preview.confirmationId,
      sourceVersions: preview.sourceVersions,
      targetVersions: preview.targetVersions,
      contractDigest: preview.contractDigest,
      openSpecDigest: preview.openSpecDigest,
    };
    await writeFile(
      path.join(directory, "source-manifest.json"),
      `${JSON.stringify({ ...manifestHeader, files: sourceManifest }, null, 2)}\n`,
      "utf8",
    );
    await writeTree(stagingPath, transformation.target);
    const stagedManifest = manifestOf(await readTree(stagingPath));
    if (!sameManifest(stagedManifest, targetManifest)) {
      throw new Error("The staged tree does not match the validated target.");
    }
    await writeFile(
      path.join(directory, "target-manifest.json"),
      `${JSON.stringify({ ...manifestHeader, files: targetManifest }, null, 2)}\n`,
      "utf8",
    );

    await commitReplacement({
      journalFile,
      journal: {
        confirmationId: preview.confirmationId,
        module: resolved.canonical,
        kind: "UPGRADE",
        livePath,
        directory,
        startedAt: now,
      },
      livePath,
      stagingPath,
      rollbackPath,
      expectedManifest: targetManifest,
      hooks,
    });
    const committedState = JSON.parse(
      await readFile(path.join(livePath, "state.json"), "utf8"),
    );
    if (
      committedState.contractVersion !== V5_CONTRACT_VERSION ||
      committedState.formatVersion !== V5_FORMAT_VERSION
    ) {
      throw new Error("The committed tree does not satisfy the target contract.");
    }

    return {
      upgraded: true,
      migration: resolved.canonical,
      confirmationId: preview.confirmationId,
      sourceVersions: preview.sourceVersions,
      targetVersions: preview.targetVersions,
      reopenedStep: preview.reopenedStep,
      missingV5Content: preview.missingV5Content,
      snapshotPath: path.join(directory, "source-snapshot"),
      transactionPath: directory,
      state: committedState,
    };
  } finally {
    await release();
  }
};

/** The finished upgrade whose committed target is the tree currently live. */
const restorableUpgrade = async (targetRoot, moduleName, livePath) => {
  const root = moduleUpgradeRoot(targetRoot, moduleName);
  if (!(await exists(root))) return null;
  const live = manifestOf(await readTree(livePath));
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const journalFile = path.join(directory, "transaction.json");
    if (!(await exists(journalFile))) continue;
    const journal = await readJournal(journalFile);
    if (journal.state !== "DONE" || journal.kind === "ROLLBACK") continue;
    const target = JSON.parse(
      await readFile(path.join(directory, "target-manifest.json"), "utf8"),
    );
    if (sameManifest(target.files, live)) {
      candidates.push({ journal, directory, header: target });
    }
  }
  return candidates.at(-1) ?? null;
};

/** Read-only. An operational restore of a preserved snapshot, not a migrator. */
export const previewRollback = async ({
  registryPath,
  moduleName,
} = {}) => {
  const { registryData, resolved, livePath } = await resolveContext({
    registryPath,
    moduleName,
  });
  const base = {
    migration: resolved.canonical,
    livePath,
    restores: null,
    sourceVersions: null,
    targetVersions: null,
    affectedFiles: [],
    blockers: [],
    requiresConfirmation: false,
    confirmationId: null,
  };
  const blocked = (message) => ({ ...base, blockers: [message] });

  const [pending] = await pendingTransactions(
    registryData.targetRoot,
    resolved.canonical,
  );
  if (pending) {
    return blocked(
      `An unfinished upgrade transaction exists for '${resolved.canonical}' in state ${pending.state}. Run --recover before rolling back.`,
    );
  }
  if (!(await exists(livePath))) {
    return blocked(`No persisted migration exists for '${resolved.canonical}'.`);
  }
  const restorable = await restorableUpgrade(
    registryData.targetRoot,
    resolved.canonical,
    livePath,
  );
  if (!restorable) {
    return blocked(
      `No preserved upgrade snapshot matches the current tree for '${resolved.canonical}'. Rollback restores only a tree this upgrader committed and has not since changed.`,
    );
  }
  const snapshotPath = path.join(restorable.directory, "source-snapshot");
  const snapshot = manifestOf(await readTree(snapshotPath));
  const recordedSource = JSON.parse(
    await readFile(
      path.join(restorable.directory, "source-manifest.json"),
      "utf8",
    ),
  );
  if (!sameManifest(snapshot, recordedSource.files)) {
    return blocked(
      `The preserved snapshot at ${snapshotPath} no longer matches its recorded manifest. Restore it manually.`,
    );
  }
  const preview = {
    ...base,
    restores: restorable.journal.confirmationId,
    snapshotPath,
    // Rollback reverses the direction: the live v5 tree becomes the source.
    sourceVersions: restorable.header.targetVersions,
    targetVersions: restorable.header.sourceVersions,
    affectedFiles: snapshot.map((entry) => entry.path),
    contractDigest: restorable.header.contractDigest,
    blockers: [],
    requiresConfirmation: true,
  };
  return {
    ...preview,
    confirmationId: createHash("sha256")
      .update(
        JSON.stringify({
          restores: preview.restores,
          snapshot,
          live: manifestOf(await readTree(livePath)),
          rendered: renderRollbackPreview(preview),
        }),
      )
      .digest("hex")
      .slice(0, 16),
  };
};

export const renderRollbackPreview = (preview) =>
  `Rollback pre-execution summary\n` +
  `Migration: ${preview.migration}\n` +
  `Restores upgrade: ${preview.restores ?? "none"}\n` +
  `Snapshot: ${preview.snapshotPath ?? "none"}\n` +
  `Current: contract ${preview.sourceVersions?.contractVersion ?? "none"} format ${preview.sourceVersions?.formatVersion ?? "none"}\n` +
  `Restored: contract ${preview.targetVersions?.contractVersion ?? "none"} format ${preview.targetVersions?.formatVersion ?? "none"}\n` +
  `Restored files: ${preview.affectedFiles.length}\n` +
  `Note: this is an operational restore, not a contract-5 to contract-4 migrator. Contract 5 refuses the restored tree until it is upgraded again.\n` +
  `Blockers: ${preview.blockers.length > 0 ? preview.blockers.join("; ") : "none"}\n`;

export const executeRollback = async ({
  registryPath,
  moduleName,
  confirmRollback,
  hooks = {},
}) => {
  const { registryData, resolved, livePath } = await resolveContext({
    registryPath,
    moduleName,
  });
  const release = await acquireLock(registryData.targetRoot, resolved.canonical);
  try {
    const preview = await previewRollback({ registryPath, moduleName });
    if (!preview.requiresConfirmation) {
      throw new Error(`Rollback is blocked: ${preview.blockers.join("; ")}`);
    }
    if (
      typeof confirmRollback !== "string" ||
      confirmRollback !== preview.confirmationId
    ) {
      throw new Error(
        "Rollback confirmation is missing or expired. Show the current preview and ask the user to confirm again.",
      );
    }

    const directory = transactionRoot(
      registryData.targetRoot,
      resolved.canonical,
      preview.confirmationId,
    );
    const stagingPath = path.join(directory, "staging");
    await mkdir(directory, { recursive: true });
    // The current contract-5 tree is snapshotted before anything moves.
    await cp(livePath, path.join(directory, "source-snapshot"), {
      recursive: true,
    });
    const liveTree = await readTree(livePath);
    // Same rule as the upgrade direction: only the pinned build may move a
    // stamped record's tree. Record rollback is not toolkit rollback, and this
    // restores no identity -- the preserved snapshot carries whatever identity
    // it had when it was taken.
    assertToolkitIdentityNotMismatched(
      JSON.parse(liveTree["state.json"]).toolkitIdentity ?? null,
      "Rolling this migration back",
    );
    const liveManifest = manifestOf(liveTree);
    const header = {
      confirmationId: preview.confirmationId,
      restores: preview.restores,
      sourceVersions: preview.sourceVersions,
      targetVersions: preview.targetVersions,
      contractDigest: preview.contractDigest,
    };
    await writeFile(
      path.join(directory, "source-manifest.json"),
      `${JSON.stringify({ ...header, files: liveManifest }, null, 2)}\n`,
      "utf8",
    );
    await cp(preview.snapshotPath, stagingPath, { recursive: true });
    const stagedManifest = manifestOf(await readTree(stagingPath));
    await writeFile(
      path.join(directory, "target-manifest.json"),
      `${JSON.stringify({ ...header, files: stagedManifest }, null, 2)}\n`,
      "utf8",
    );

    await commitReplacement({
      journalFile: path.join(directory, "transaction.json"),
      journal: {
        confirmationId: preview.confirmationId,
        module: resolved.canonical,
        kind: "ROLLBACK",
        restores: preview.restores,
        livePath,
        directory,
        startedAt: new Date().toISOString(),
      },
      livePath,
      stagingPath,
      rollbackPath: path.join(directory, "rollback-live"),
      expectedManifest: stagedManifest,
      hooks,
    });

    return {
      restored: true,
      migration: resolved.canonical,
      restoredUpgrade: preview.restores,
      confirmationId: preview.confirmationId,
      snapshotPath: path.join(directory, "source-snapshot"),
      transactionPath: directory,
    };
  } finally {
    await release();
  }
};

export const recoverUpgrade = async ({
  registryPath,
  moduleName,
} = {}) => {
  const { registryData, resolved } = await resolveContext({
    registryPath,
    moduleName,
  });
  const release = await acquireLock(registryData.targetRoot, resolved.canonical);
  try {
    const pending = await pendingTransactions(
      registryData.targetRoot,
      resolved.canonical,
    );
    if (pending.length === 0) {
      return { recovered: [], clean: true, migration: resolved.canonical };
    }
    const recovered = [];
    for (const journal of pending) {
      recovered.push(await recoverTransaction(journal));
    }
    return { recovered, clean: false, migration: resolved.canonical };
  } finally {
    await release();
  }
};

export const parseUpgradeArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      "confirm-upgrade": { type: "string" },
      "confirm-rollback": { type: "string" },
      recover: { type: "boolean", default: false },
      registry: { type: "string" },
      rollback: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: upgrade-migration.mjs <module> [--registry <path>] [--confirm-upgrade <id> | --rollback [--confirm-rollback <id>] | --recover]",
    );
  }
  const modes = [
    values.recover,
    values.rollback || Boolean(values["confirm-rollback"]),
    Boolean(values["confirm-upgrade"]),
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new Error(
      "Choose one of --confirm-upgrade, --rollback, or --recover.",
    );
  }
  return {
    moduleName: positionals[0],
    confirmUpgrade: values["confirm-upgrade"],
    confirmRollback: values["confirm-rollback"],
    recover: values.recover,
    rollback: values.rollback || Boolean(values["confirm-rollback"]),
    registryOption: values.registry,
  };
};

export const runUpgradeCli = async (arguments_) => {
  const options = parseUpgradeArguments(arguments_);
  Object.assign(
    options,
    await resolveRegistryPath({
      cliPath: options.registryOption,
      moduleName: options.moduleName,
    }),
  );
  if (options.recover) {
    const result = await recoverUpgrade(options);
    process.stdout.write(
      result.clean
        ? `No unfinished upgrade transaction exists for ${result.migration}.\n`
        : `${result.recovered.map((entry) => `Recovered from ${entry.from}: ${entry.outcome}`).join("\n")}\n`,
    );
    return result;
  }
  if (options.rollback) {
    const preview = await previewRollback(options);
    process.stdout.write(renderRollbackPreview(preview));
    if (!preview.requiresConfirmation) {
      process.stdout.write(
        "Rollback: BLOCKED. No file, state, history, snapshot, or archive was modified.\n",
      );
      return { preview, blocked: true };
    }
    if (!options.confirmRollback) {
      process.stdout.write(
        `Confirmation ID: ${preview.confirmationId}\n` +
          "Proceed with this rollback? Reply Yes or No. No execution has started.\n",
      );
      return { preview, awaitingConfirmation: true };
    }
    const result = await executeRollback(options);
    process.stdout.write(
      `Restored ${result.migration} from upgrade ${result.restoredUpgrade}\n` +
        `Snapshot of the replaced tree: ${result.snapshotPath}\n` +
        "Stop: restoration is the only action for this invocation. Contract 5 refuses the restored tree until it is upgraded again.\n",
    );
    return { preview, result };
  }
  const preview = await previewUpgrade(options);
  process.stdout.write(renderUpgradePreview(preview));
  if (!preview.requiresConfirmation) {
    process.stdout.write(
      "Upgrade: BLOCKED. No file, state, history, snapshot, or archive was modified.\n",
    );
    return { preview, blocked: true };
  }
  if (!options.confirmUpgrade) {
    process.stdout.write(
      `Confirmation ID: ${preview.confirmationId}\n` +
        "Proceed with this upgrade? Reply Yes or No. No execution has started.\n",
    );
    return { preview, awaitingConfirmation: true };
  }
  const result = await executeUpgrade(options);
  process.stdout.write(
    `Upgraded ${result.migration} to contract ${result.targetVersions.contractVersion} format ${result.targetVersions.formatVersion}\n` +
      `Reopened step: ${result.reopenedStep ?? "none"}\n` +
      `Snapshot: ${result.snapshotPath}\n` +
      `Stop: the upgrade is the only action for this invocation. Run /start-migration ${result.migration} to continue.\n`,
  );
  return { preview, result };
};

if (isMainModule(import.meta.url)) {
  runUpgradeCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
