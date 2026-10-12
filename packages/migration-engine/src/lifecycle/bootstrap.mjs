/**
 * Lifecycle: bootstrap and initialization -- the initialization journal, its
 * commit, rollback and recovery, `bootstrapMigration` and
 * `bootstrapUnderLock`. Moved verbatim from `resumable-migration.mjs` (Track A8).
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertLegacySourcesUnchanged,
  brownfieldTargetBlocker,
  isBrownfield,
} from "../census/index.mjs";
import {
  assertNoPendingFormatUpgrade,
  assertPonytailTarget,
  FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
  initialArtifacts,
  INTEGRITY_FILE,
  MIGRATION_STEPS,
  resolveDesignSource,
  RESUMABLE_CONTRACT_VERSION,
  stampedFormatVersion,
  STEP_FILES,
  stepsFor,
  TARGET_BASELINE_FILE,
  WORKFLOW_VERSION,
} from "../formats/index.mjs";
import {
  assertSecurePath,
  contentIdentity,
  dirtyManifest,
  gitRevision,
  isResolvedWithin as isWithin,
  now,
  sameFile,
  sha256Hex as hashContent,
} from "../shared/index.mjs";
import {
  assertHistoryAppendable,
  atomicWrite,
  fileExists,
  hashHistoryEvent,
  historyAnchorOf,
  migrationRoot,
  persistProjectRegistryBinding,
  previewProjectRegistryBinding,
  registryIdentity,
  removeEmptyParents,
  renderIntegrity,
  renderState,
  statePathFor,
} from "../store/index.mjs";
import { withModuleLock, writeJournalAtomic } from "./lock.mjs";
import { assertDesignSourceUnchanged, designSourceExplicit } from "../visual/index.mjs";
import { activeToolkitIdentity } from "../toolkit-identity.mjs";
import {
  assertSliceStateConsistent,
  portableRoot,
  renderTargetBaseline,
  reworkPathParts,
  TARGET_DIRTY_SCOPE,
} from "../slices/index.mjs";
import { adoptVisualContractUnderLock } from "./adoption.mjs";
import { activeArtifact, legacyChecklistBlocker, resumeGuidance } from "./checkpoints.mjs";
import { readContext } from "./context.mjs";
import {
  assertCurrentOpenSpecAuthority,
  loadOpenSpecAuthority,
  validateOpenSpecProposal,
} from "./openspec.mjs";
import { isAutoAuthority } from "./policy.mjs";
import { assertExecutionConfirmation, previewMigrationExecution } from "./preview.mjs";
import {
  ADVANCE_JOURNAL,
  appendHistoryOnce,
  briefDigestFor,
  readState,
  recoverPendingAdvance,
  renderIntegrityNow,
  validateCompletedHashes,
} from "./record.mjs";
import { assertNoPendingTransaction } from "./registry.mjs";
import {
  amendSliceUnderLock,
  reopenCompleteUnderLock,
  reopenDiscoveryUnderLock,
  reopenUiUnderLock,
  reworkSliceUnderLock,
} from "./reopen.mjs";
import {
  createResolveStep,
  initialJsonArtifacts,
  LEGACY_REVISION_LINE,
  LEGACY_REVISION_SCOPE_LINE,
  stateMappingMismatch,
  stepTemplates,
} from "./templates.mjs";
import { assertRecordToolkitIdentity } from "./toolkit-identity.mjs";

/**
 * Re-reads every mutable input the confirmation ID was bound to, under the
 * lock, immediately before the first write. A confirmation authorizes one exact
 * set of bytes; if any of them moved between preview and execution the run is
 * refused rather than executed against inputs the user never saw.
 */
const assertBoundInputsUnchanged = async (registryData, boundInputs, brief) => {
  if (!boundInputs) {
    throw new Error(
      "Migration execution requires the boundInputs returned by previewMigrationExecution. Execution is never authorized without the exact inputs the preview showed.",
    );
  }
  const current = {
    legacyRoot: portableRoot(registryData.legacyRoot),
    targetRoot: portableRoot(registryData.targetRoot),
    registryDigest: hashContent(registryData.content),
    legacyDirtyDigest: (await dirtyManifest(registryData.legacyRoot)).digest,
    targetDirtyDigest: (
      await dirtyManifest(registryData.targetRoot, TARGET_DIRTY_SCOPE)
    ).digest,
    briefDigest: brief
      ? await briefDigestFor(registryData.targetRoot, brief)
      : null,
  };
  const labels = {
    legacyRoot: "the resolved legacy root",
    targetRoot: "the resolved target root",
    registryDigest: "the migration registry bytes",
    legacyDirtyDigest: "uncommitted legacy files",
    targetDirtyDigest: "uncommitted target files",
    briefDigest: "the migration brief bytes",
  };
  for (const [key, label] of Object.entries(labels)) {
    if (current[key] !== boundInputs[key]) {
      throw new Error(
        `Migration inputs changed after the confirmation was issued: ${label}. The confirmation is stale; preview again. No file was modified.`,
      );
    }
  }
};

const initJournalFor = (targetRoot, moduleName) =>
  path.join(
    targetRoot,
    ".agents/knowledge/migrations/init",
    `${moduleName}.journal`,
  );

const ownerMatches = async (file, transactionId) =>
  file
    ? (await readFile(file, "utf8").catch(() => null)) === transactionId
    : false;

const writeOwner = async (file, transactionId) => {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(transactionId, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const cleanupInitialization = async (journal) => {
  for (const staged of [
    journal.stagedRoot,
    journal.stagedOpenSpec,
    journal.stagedProjectConfig,
  ]) {
    if (staged) await rm(staged, { recursive: true, force: true });
  }
  if (await ownerMatches(journal.rootOwner, journal.transactionId)) {
    await rm(journal.rootOwner, { force: true });
  }
  await rm(journal.file, { force: true });
};

const rollbackInitialization = async (targetRoot, journal) => {
  if (journal.configPath && journal.configAfter !== undefined) {
    const current = await readFile(journal.configPath, "utf8").catch(
      () => null,
    );
    if (current === journal.configAfter) {
      await atomicWrite(
        journal.projectRoot,
        journal.configPath,
        journal.configBefore,
      );
    }
  }
  if (await ownerMatches(journal.rootOwner, journal.transactionId)) {
    await rm(journal.root, { recursive: true, force: true });
  }
  if (
    journal.openSpecPath &&
    journal.stagedOpenSpec &&
    (await sameFile(journal.openSpecPath, journal.stagedOpenSpec))
  ) {
    await rm(journal.openSpecPath, { force: true });
    await removeEmptyParents(path.dirname(journal.openSpecPath), targetRoot);
  }
  await cleanupInitialization(journal);
  await removeEmptyParents(path.dirname(journal.root), targetRoot);
};

/**
 * Undoes or completes an initialization that died between its three commits
 * (OpenSpec authority, migration tree, project binding). Runs under the module
 * lock before any new initialization work, so an abrupt death never leaves a
 * committed OpenSpec without its migration, a half-staged tree, or a project
 * binding pointing at a migration that does not exist.
 */
const recoverInitialization = async (targetRoot, moduleName) => {
  const journalFile = initJournalFor(targetRoot, moduleName);
  if (!(await fileExists(journalFile))) return null;
  let journal;
  try {
    journal = JSON.parse(await readFile(journalFile, "utf8"));
  } catch {
    throw new Error(
      `Initialization journal is unreadable at ${journalFile}. Preserve it and inspect the transaction before continuing.`,
    );
  }
  journal.file = journalFile;

  if (await fileExists(path.join(journal.root, "state.json"))) {
    await cleanupInitialization(journal);
    return { outcome: "COMPLETED" };
  }
  await rollbackInitialization(targetRoot, journal);
  return { outcome: "ROLLED_BACK" };
};

const commitInitialization = async ({
  targetRoot,
  moduleName,
  root,
  files,
  openSpec,
  registryBinding,
  hooks = {},
}) => {
  if (await fileExists(root)) {
    throw new Error(
      `Migration initialization destination already exists without state: ${root}`,
    );
  }
  const openSpecPath = openSpec
    ? path.resolve(targetRoot, openSpec.authority.source)
    : null;
  if (openSpecPath && (await fileExists(openSpecPath))) {
    throw new Error(
      `OpenSpec source appeared after preview: ${openSpec.authority.source}. Preview again; do not overwrite or restore it manually.`,
    );
  }
  if (
    (await readFile(registryBinding.configPath, "utf8")) !==
    registryBinding.before
  ) {
    throw new Error(
      "Migration registry configuration changed after preview. The confirmation is stale; preview again.",
    );
  }

  const transactionId = randomUUID();
  const stagedRoot = path.join(
    path.dirname(root),
    `.${path.basename(root)}.${transactionId}.init`,
  );
  const stagedOpenSpec = openSpecPath
    ? path.join(
        path.dirname(openSpecPath),
        `.${path.basename(openSpecPath)}.${transactionId}.init`,
      )
    : null;
  const stagedProjectConfig = registryBinding.changed
    ? path.join(
        path.dirname(registryBinding.configPath),
        `.${path.basename(registryBinding.configPath)}.${transactionId}.init`,
      )
    : null;
  const journalFile = initJournalFor(targetRoot, moduleName);
  const rootOwner = path.join(root, ".init-owner");
  const journal = {
    file: journalFile,
    transactionId,
    module: moduleName,
    pid: process.pid,
    startedAt: now(),
    root,
    rootOwner,
    openSpecPath,
    projectRoot: registryBinding.projectRoot,
    configPath: stagedProjectConfig ? registryBinding.configPath : null,
    configBefore: registryBinding.before,
    configAfter: stagedProjectConfig ? registryBinding.content : undefined,
    stagedRoot,
    stagedOpenSpec,
    stagedProjectConfig,
  };

  try {
    await writeJournalAtomic(journalFile, journal);
    for (const [relativePath, content] of Object.entries(files)) {
      await atomicWrite(
        targetRoot,
        path.join(stagedRoot, relativePath),
        content,
      );
    }
    if (stagedOpenSpec) {
      await atomicWrite(targetRoot, stagedOpenSpec, openSpec.content);
    }
    if (stagedProjectConfig) {
      await atomicWrite(
        registryBinding.projectRoot,
        stagedProjectConfig,
        registryBinding.content,
      );
    }

    if (
      (await fileExists(root)) ||
      (openSpecPath && (await fileExists(openSpecPath)))
    ) {
      throw new Error(
        "Migration initialization output changed after preview. The confirmation is stale; preview again.",
      );
    }
    if (
      (await readFile(registryBinding.configPath, "utf8")) !==
      registryBinding.before
    ) {
      throw new Error(
        "Migration registry configuration changed after preview. The confirmation is stale; preview again.",
      );
    }

    if (stagedOpenSpec) {
      await assertSecurePath(targetRoot, openSpecPath);
      await link(stagedOpenSpec, openSpecPath);
      await hooks.afterCommit?.("openspec");
    }
    if (stagedProjectConfig) {
      await assertSecurePath(
        registryBinding.projectRoot,
        registryBinding.configPath,
      );
      await rename(stagedProjectConfig, registryBinding.configPath);
      await hooks.afterCommit?.("project-config");
    }
    await assertSecurePath(targetRoot, root);
    await mkdir(root);
    await writeOwner(rootOwner, transactionId);
    const entries = await readdir(stagedRoot);
    entries.sort((left, right) =>
      left === "state.json" ? 1 : right === "state.json" ? -1 : 0,
    );
    for (const entry of entries) {
      await rename(path.join(stagedRoot, entry), path.join(root, entry));
    }
    await rm(stagedRoot, { recursive: true, force: true });
    await hooks.afterCommit?.("migration");
    await cleanupInitialization(journal);
  } catch (error) {
    await rollbackInitialization(targetRoot, journal);
    throw error;
  }
};

export const bootstrapMigration = async ({
  registryPath,
  projectRoot,
  registryBinding,
  moduleName,
  targetOverride,
  openSpecProposal,
  ponytail,
  brief,
  designSource,
  figma,
  legacy,
  adoptTarget = false,
  refresh = false,
  reopenDiscovery = false,
  reopenUi = [],
  reopenComplete = [],
  reopenReason = null,
  reopenEvidence = null,
  confirmLegacyRevision = null,
  reworkSlice = null,
  amendSlice = null,
  addFiles = [],
  // Branded or absent, never composed: see `sequenceAuthorizationEvidence`.
  authorization = null,
  adoptVisualContract = false,
  confirmExecution,
  confirmMismatch = false,
  mock = false,
  boundInputs,
  hooks = {},
  // No default: `isAutoAuthority` is the single reader of this, and an absent
  // mode means auto there. Defaulting it here would silently disable automatic
  // legacy-drift acknowledgement for every caller that does not name a mode.
  mode,
}) => {
  if (ponytail !== undefined) assertPonytailTarget(ponytail);
  // Adoption changes what a record means, so its challenge is re-derived here
  // from the current evidence instead of trusting whichever caller got this
  // far; the transition recomputes the evidence digest again under the lock.
  const adoptionPreview = adoptVisualContract
    ? await previewMigrationExecution({
        registryPath,
        projectRoot,
        moduleName,
        targetOverride,
        ponytail,
        brief,
        designSource,
        figma,
        legacy,
        adoptVisualContract,
        mock,
      })
    : null;
  if (adoptionPreview) {
    assertExecutionConfirmation(adoptionPreview, confirmExecution);
  }
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
    targetOverride,
    legacy,
  });
  // Guarded before the lock as well as under it: an in-flight upgrade or
  // rollback may have renamed the live tree away, so this is the only check
  // standing between a fresh initialization and an open transaction.
  await assertNoPendingTransaction(registryData.targetRoot, resolved.canonical);
  return withModuleLock(registryData.targetRoot, resolved.canonical, () =>
    bootstrapUnderLock({
      registryData,
      resolved,
      projectRoot,
      registryBinding,
      openSpecProposal,
      ponytail,
      brief,
      designSource,
      figma,
      adoptTarget,
      refresh,
      reopenDiscovery,
      reopenUi,
      reopenComplete,
      reopenReason,
      reopenEvidence,
      confirmLegacyRevision,
      reworkSlice,
      amendSlice,
      addFiles,
      authorization,
      mode,
      adoption: adoptionPreview && {
        confirmationId: confirmExecution,
        ...adoptionPreview.visualContractAdoption,
      },
      confirmMismatch,
      mock,
      boundInputs,
      hooks,
      mode,
    }),
  );
};

/**
 * Everything that reads a precondition and then writes runs here, inside the
 * per-module lock, and re-reads every input the confirmation was bound to
 * immediately before writing. Two confirmed initializations therefore serialize
 * instead of both passing unlocked existence checks and letting the loser's
 * rollback delete the winner's shared OpenSpec.
 */
const bootstrapUnderLock = async ({
  registryData,
  resolved,
  projectRoot,
  registryBinding,
  openSpecProposal,
  ponytail,
  brief,
  designSource,
  figma,
  adoptTarget = false,
  refresh,
  reopenDiscovery,
  reopenUi,
  reopenComplete = [],
  reopenReason = null,
  reopenEvidence = null,
  confirmLegacyRevision = null,
  reworkSlice,
  amendSlice,
  addFiles,
  authorization,
  adoption = null,
  confirmMismatch,
  mock,
  boundInputs,
  hooks,
  mode,
}) => {
  const design = resolveDesignSource({ designSource, figma });
  await assertNoPendingTransaction(registryData.targetRoot, resolved.canonical);
  await recoverInitialization(registryData.targetRoot, resolved.canonical);
  await assertBoundInputsUnchanged(registryData, boundInputs, brief);
  const binding =
    registryBinding ??
    (await previewProjectRegistryBinding(registryData, projectRoot));
  const root = migrationRoot(registryData.targetRoot, resolved.canonical);
  const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
  const existingState = await fileExists(statePath);

  if (existingState) {
    await recoverPendingAdvance(registryData.targetRoot, root, statePath);
    if (openSpecProposal !== undefined && openSpecProposal !== null) {
      throw new Error(
        "An OpenSpec proposal is accepted only while initializing RESOLVE.",
      );
    }
    const { state } = await readState(
      registryData.targetRoot,
      resolved.canonical,
    );
    if (stateMappingMismatch(state, resolved)) {
      throw new Error("Migration state mapping does not match the registry.");
    }
    assertLegacySourcesUnchanged(state, resolved.legacySources);
    const recordedDataSource = state.dataSourceMode;
    if (ponytail !== undefined && state.ponytail !== ponytail) {
      throw new Error(
        `Ponytail target '${ponytail}' conflicts with recorded target '${state.ponytail ?? "none"}'.`,
      );
    }
    if (mock && recordedDataSource !== "mock") {
      throw new Error(
        "Mock data-source mode was not enabled when this migration was created. Start a new migration or continue without --mock.",
      );
    }
    if (designSourceExplicit({ designSource, figma })) {
      assertDesignSourceUnchanged(state, design);
    }
    // The mirror of the preview's rule, re-derived here from fresh reads rather
    // than carried across: the preview is advice, this is the gate.
    if (refresh && !confirmMismatch) {
      throw new Error(
        "Refresh requires explicit mismatch confirmation. Use --refresh --confirm-mismatch only after confirming that the migration no longer matches the legacy behavior.",
      );
    }
    await assertCurrentOpenSpecAuthority(registryData.targetRoot, state);
    const legacyRevision = await gitRevision(registryData.legacyRoot);
    const refreshing = refresh;
    if (
      state.legacyRevision.revision !== legacyRevision.revision &&
      !refreshing &&
      reopenUi.length === 0 &&
      reopenComplete.length === 0
    ) {
      throw new Error(
        `Legacy revision changed from '${state.legacyRevision.revision}' to '${legacyRevision.revision}'. This is repository evidence drift, not a session or model interruption. Review the new legacy evidence and rerun with --refresh --confirm-mismatch.`,
      );
    }
    await validateCompletedHashes(root, state);
    // Fix E (candidate change; see analysis/inventory.md Defect
    // "reconcileSliceState/inspectSliceArtifacts... only wired up inside the
    // one-time v4->v5 upgrade coordinator"): normal resume now runs the same
    // reconciliation logic read-only. If state.json's navigation fields ever
    // disagree with the slice/evidence artifacts, resume blocks with a named
    // reason instead of silently trusting whichever file was touched last. It
    // never auto-repairs here; that stays a one-time upgrade-coordinator
    // operation.
    await assertSliceStateConsistent(root, state);
    // Every branch below this line writes to the record; the plain resume that
    // falls through to `changed: false` does not, and is deliberately left
    // readable on an unstamped or mismatched record.
    if (
      reopenDiscovery ||
      reopenUi.length > 0 ||
      reopenComplete.length > 0 ||
      reworkSlice ||
      adoption ||
      refreshing
    ) {
      assertRecordToolkitIdentity(
        state,
        resolved.canonical,
        refreshing
          ? "Refreshing this migration"
          : adoption
            ? "Adopting the visual contract"
            : "Reopening this migration",
      );
    }
    // Same ordering as `advanceUnderLock`, at the one point every branch below
    // passes through: reopen (discovery/UI/complete), rework, amendment, visual
    // contract adoption and refresh all dispatch from here, and so does the
    // binding write of a plain resume.
    assertNoPendingFormatUpgrade(
      state,
      resolved.canonical,
      "Resuming this migration",
    );
    await persistProjectRegistryBinding(binding);
    if (reopenDiscovery) {
      return reopenDiscoveryUnderLock({
        registryData,
        resolved,
        root,
        statePath,
        state,
      });
    }
    if (reopenUi.length > 0) {
      return reopenUiUnderLock({
        registryData,
        resolved,
        root,
        statePath,
        state,
        slices: reopenUi,
      });
    }
    if (reopenComplete.length > 0) {
      return reopenCompleteUnderLock({
        registryData,
        resolved,
        root,
        statePath,
        state,
        slices: reopenComplete,
        reason: reopenReason,
        evidence: reopenEvidence,
        legacyRevision,
        confirmLegacyRevision,
        autoAcknowledge: isAutoAuthority(mode),
        mode,
      });
    }
    if (amendSlice) {
      return amendSliceUnderLock({
        registryData,
        resolved,
        root,
        statePath,
        state,
        sliceId: amendSlice,
        addFiles,
        authorization,
        hooks,
      });
    }
    if (reworkSlice) {
      return reworkSliceUnderLock({
        registryData,
        resolved,
        root,
        statePath,
        state,
        sliceId: reworkSlice,
      });
    }
    if (adoption) {
      return adoptVisualContractUnderLock({
        registryData,
        resolved,
        root,
        statePath,
        state,
        adoption,
      });
    }
    if (!refreshing) {
      return {
        changed: false,
        statePath,
        migrationRoot: root,
        state,
        nextArtifact: activeArtifact(state),
        ...resumeGuidance(state),
        resolved,
      };
    }
    const resolvePath = path.join(root, STEP_FILES.RESOLVE);
    const resolveBefore = await readFile(resolvePath, "utf8");
    const refreshedResolve = resolveBefore
      .replace(
        LEGACY_REVISION_LINE,
        `- Legacy revision: \`${legacyRevision.revision}\``,
      )
      .replace(
        LEGACY_REVISION_SCOPE_LINE,
        `- Legacy revision scope: \`${legacyRevision.pathScoped ? "path-scoped" : "whole-repo-fallback"}\``,
      );
    const refreshed = {
      ...state,
      formatVersion: stampedFormatVersion(state),
      status: "ACTIVE",
      currentStep: "DISCOVER_LEGACY",
      completedSteps: ["RESOLVE"],
      pendingSteps: stepsFor(state).slice(1),
      activeSlice: null,
      completedSlices: [],
      pendingSlices: [],
      invalidatedArtifacts: Object.values(state.artifacts)
        .flatMap((value) =>
          typeof value === "string" ? [value] : Object.values(value),
        )
        .filter((value) => value !== STEP_FILES.RESOLVE),
      evidenceFreshness: "STALE",
      legacyRevision,
      nextAction: "Rebuild the legacy inventory for the refreshed revision.",
      nextCommand: `/start-migration ${resolved.canonical}`,
      artifactHashes: {
        // Preserved failed attempts survive a refresh. A refresh invalidates
        // what the migration *claims*; it never destroys the record of a
        // failure that actually happened.
        ...Object.fromEntries(
          Object.entries(state.artifactHashes).filter(([relative]) =>
            reworkPathParts(relative),
          ),
        ),
        [STEP_FILES.RESOLVE]: contentIdentity(
          STEP_FILES.RESOLVE,
          refreshedResolve,
        ),
        // The target baseline describes the tree before the migration started;
        // a new legacy revision does not change what was already there, so the
        // pin survives a refresh exactly as the RESOLVE document does.
        ...(isBrownfield(state)
          ? {
              [TARGET_BASELINE_FILE]:
                state.artifactHashes[TARGET_BASELINE_FILE],
            }
          : {}),
      },
      revision: state.revision + 1,
      updatedAt: now(),
    };
    // Refresh is a durable transition, so it uses the same journalled ordering
    // as a checkpoint advance: prove the audit record is writable, record the
    // intent, write state, append the event, drop the journal.
    const refreshEvent = {
      event: "REFRESHED",
      fromLegacyRevision: state.legacyRevision,
      toLegacyRevision: legacyRevision,
      invalidatedFrom: "DISCOVER_LEGACY",
      revision: refreshed.revision,
      // Explicit --refresh --confirm-mismatch is operator authority in either mode.
      principal: "OPERATOR",
    };
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = (await fileExists(integrityPath))
      ? await readFile(integrityPath, "utf8")
      : null;
    const nextIntegrity = await renderIntegrityNow(root, refreshed, refreshEvent);
    await assertHistoryAppendable(registryData.targetRoot, root);
    await writeJournalAtomic(path.join(root, ADVANCE_JOURNAL), {
      fromRevision: state.revision,
      toRevision: refreshed.revision,
      event: refreshEvent,
      startedAt: now(),
      pid: process.pid,
      restore: [{ path: STEP_FILES.RESOLVE, content: resolveBefore }],
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    await atomicWrite(registryData.targetRoot, resolvePath, refreshedResolve);
    await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
    await atomicWrite(
      registryData.targetRoot,
      statePath,
      renderState(refreshed),
    );
    await appendHistoryOnce(registryData.targetRoot, root, refreshEvent);
    await rm(path.join(root, ADVANCE_JOURNAL), { force: true });
    return {
      changed: true,
      reopened: true,
      statePath,
      migrationRoot: root,
      state: refreshed,
      nextArtifact: activeArtifact(refreshed),
      resolved,
    };
  }

  const legacyBlocker = await legacyChecklistBlocker(
    registryData.targetRoot,
    resolved.canonical,
  );
  if (legacyBlocker) throw new Error(legacyBlocker);
  const legacyRevision = await gitRevision(registryData.legacyRoot);
  const proposedOpenSpec =
    openSpecProposal !== undefined && openSpecProposal !== null
      ? validateOpenSpecProposal(openSpecProposal, resolved.target)
      : null;
  const requirementsAuthority = proposedOpenSpec
    ? proposedOpenSpec.authority
    : await loadOpenSpecAuthority(registryData.targetRoot, resolved.target);
  let briefRecord = null;
  let briefContent = null;
  if (brief) {
    const absoluteBrief = path.resolve(registryData.targetRoot, brief);
    if (!isWithin(registryData.targetRoot, absoluteBrief)) {
      throw new Error(
        "Migration brief must remain inside the target repository.",
      );
    }
    briefContent = await readFile(absoluteBrief, "utf8");
    // Contract 5 decision 1.4: the brief is an immutable hashed input.
    briefRecord = {
      path: "brief.md",
      digest: contentIdentity("brief.md", briefContent),
    };
  }

  const brownfieldBlocker = await brownfieldTargetBlocker(
    registryData.targetRoot,
    { adoptTarget, targetModule: resolved.target },
  );
  if (brownfieldBlocker) throw new Error(brownfieldBlocker);
  // With no `--legacy` the bare positional is still the one legacy module, so
  // a single-source record declares exactly what it always did.
  const legacySources =
    resolved.legacySources.length > 0
      ? resolved.legacySources
      : [resolved.legacyModule];
  const targetBaseline = adoptTarget
    ? await renderTargetBaseline(registryData.targetRoot)
    : null;
  const targetAdoption = targetBaseline
    ? {
        mode: "BROWNFIELD",
        baseline: {
          path: TARGET_BASELINE_FILE,
          digest: contentIdentity(TARGET_BASELINE_FILE, targetBaseline),
        },
      }
    : { mode: "GREENFIELD", baseline: null };

  const resolveStep = createResolveStep({
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
    legacyRevision,
    legacyModule: legacySources[0],
    legacySources,
    targetAdoption,
    targetModule: resolved.target,
    ponytail: ponytail ?? null,
    dataSourceMode: mock ? "mock" : "standard",
    designSource: design.designSource,
    figmaSources: design.figmaSources,
    requirementsAuthority,
    brief,
  });
  const createdAt = now();
  const state = {
    contractVersion: RESUMABLE_CONTRACT_VERSION,
    formatVersion: FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
    workflowVersion: WORKFLOW_VERSION,
    migrationId: resolved.canonical,
    legacyModule: legacySources[0],
    targetModule: resolved.target,
    legacySources,
    targetAdoption,
    registry: registryIdentity(
      registryData.targetRoot,
      registryData.registryPath,
    ),
    legacyRevision,
    requirementsAuthority,
    brief: briefRecord,
    ponytail: ponytail ?? null,
    dataSourceMode: mock ? "mock" : "standard",
    designSource: design.designSource,
    ...(design.designSource === "figma-mcp"
      ? { figmaSources: design.figmaSources }
      : {}),
    status: "ACTIVE",
    currentStep: "DISCOVER_LEGACY",
    activeSlice: null,
    completedSteps: ["RESOLVE"],
    pendingSteps: MIGRATION_STEPS.slice(1),
    completedSlices: [],
    pendingSlices: [],
    invalidatedArtifacts: [],
    evidenceFreshness: "CURRENT",
    nextAction:
      "Complete steps/02-discover-legacy.md and inventories/legacy.json.",
    nextCommand: `/start-migration ${resolved.canonical}`,
    artifacts: {
      ...initialArtifacts,
      ...(brief ? { brief: "brief.md" } : {}),
    },
    artifactHashes: {
      [STEP_FILES.RESOLVE]: contentIdentity(STEP_FILES.RESOLVE, resolveStep),
      ...(briefRecord ? { [briefRecord.path]: briefRecord.digest } : {}),
      ...(targetBaseline === null
        ? {}
        : {
            [TARGET_BASELINE_FILE]: contentIdentity(
              TARGET_BASELINE_FILE,
              targetBaseline,
            ),
          }),
    },
    // A record born under a released toolkit is stamped at birth and never
    // needs adoption. Born under a source checkout it is unstamped, which is
    // exactly the state every pre-extraction record is already in.
    ...(activeToolkitIdentity() ? { toolkitIdentity: activeToolkitIdentity() } : {}),
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const createdEvent = {
    at: createdAt,
    event: "CREATED",
    step: "RESOLVE",
    nextStep: "DISCOVER_LEGACY",
    requirementsAuthority,
    ...(activeToolkitIdentity() ? { toolkitIdentity: activeToolkitIdentity() } : {}),
    seq: 1,
    previousHash: null,
  };
  createdEvent.hash = hashHistoryEvent(createdEvent);
  const createdHistory = `${JSON.stringify(createdEvent)}\n`;
  const files = {
    [STEP_FILES.RESOLVE]: resolveStep,
    ...stepTemplates(design),
    ...Object.fromEntries(
      Object.entries(initialJsonArtifacts).map(([relativePath, content]) => [
        relativePath,
        `${JSON.stringify(content, null, 2)}\n`,
      ]),
    ),
    ...(briefContent === null ? {} : { "brief.md": briefContent }),
    ...(targetBaseline === null
      ? {}
      : { [TARGET_BASELINE_FILE]: targetBaseline }),
    "state.json": renderState(state),
    [INTEGRITY_FILE]: renderIntegrity(
      state,
      // Initialization writes state and the CREATED event in one commit, so
      // unlike every later transition the first event is pinned immediately.
      historyAnchorOf(Buffer.from(createdHistory, "utf8")),
      // A brand-new record has no decisions yet, and the empty-file anchor is
      // what `decisionsAnchorNow` would compute for it.
      historyAnchorOf(Buffer.alloc(0)),
      undefined,
      { version: 1, startSeq: 1, legacyPrefixSha256: null, headHash: createdEvent.hash },
    ),
    [initialArtifacts.history]: createdHistory,
  };
  await commitInitialization({
    targetRoot: registryData.targetRoot,
    moduleName: resolved.canonical,
    root,
    files,
    openSpec: proposedOpenSpec,
    registryBinding: binding,
    hooks,
  });
  return {
    changed: true,
    reopened: false,
    statePath,
    migrationRoot: root,
    state,
    nextArtifact: activeArtifact(state),
    resolved,
  };
};
