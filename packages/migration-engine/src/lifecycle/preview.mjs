/**
 * Lifecycle: the pre-execution preview (`previewMigrationExecution`) and the
 * confirmation-ID check (`assertExecutionConfirmation`). Moved verbatim from
 * `resumable-migration.mjs` (Track A8).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { assertLegacySourcesUnchanged, brownfieldTargetBlocker } from "../census/index.mjs";
import {
  assertPonytailTarget,
  FIGMA_CONTEXT_ADOPTION_FILE,
  FIGMA_CONTEXT_FILE,
  INTEGRITY_FILE,
  MAX_SLICE_REWORKS,
  MIGRATION_FORMAT_VERSION,
  requirementsSourceFor,
  resolveDesignSource,
  SLICE_REWORK_FORMAT,
  UI_REMEDIATION_FILE,
  upgradeProjection,
  usesSliceRework,
  VISUAL_ACCEPTANCE_FILE,
  VISUAL_ACCEPTANCE_FORMAT,
  WORKFLOW_VERSION,
} from "../formats/index.mjs";
import {
  assertSafeName,
  dirtyManifest,
  gitRevision,
  sha256Hex as hashContent,
} from "../shared/index.mjs";
import {
  fileExists,
  hashFile,
  migrationRoot,
  previewProjectRegistryBinding,
  readJson,
  readOptionalJson,
  REOPEN_ROOT,
  statePathFor,
} from "../store/index.mjs";
import {
  assertDesignSourceUnchanged,
  designSourceExplicit,
  reopenUiEligible,
  reopenUiIneligible,
  visualAuthorityOf,
} from "../visual/index.mjs";
import {
  assertSliceStateConsistent,
  inspectSliceArtifacts,
  portableRoot,
  REWORK_ROOT,
  reworkAttemptsOf,
  reworkLimitBlocker,
  SLICE_AMENDMENT_ROOT,
  TARGET_DIRTY_SCOPE,
} from "../slices/index.mjs";
import { visualContractAdoptionPlan } from "./adoption.mjs";
import {
  activeArtifact,
  ADOPTION_ROOT,
  checkpointAction,
  checkpointArtifacts,
  compatibilityBlocker,
  confirmationIdFor,
  expectedNextCheckpoint,
  legacyChecklistBlocker,
  upgradeCommandFor,
} from "./checkpoints.mjs";
import { readContext } from "./context.mjs";
import { pendingFormatUpgrade } from "./format-upgrade.mjs";
import { initJournalFor } from "./initialization.mjs";
import { readJournal } from "./journal.mjs";
import {
  assertCurrentOpenSpecAuthority,
  loadOpenSpecAuthority,
  validateOpenSpecProposal,
} from "./openspec.mjs";
import { DEFAULT_MODE, isAutoAuthority } from "./policy.mjs";
import { migrationProgress, previewProgress, renderProgress } from "./progress.mjs";
import {
  briefDigestFor,
  IMMUTABLE_STEP_ARTIFACTS,
  readState,
  validateCompletedHashes,
} from "./record.mjs";
import { pendingTransactions } from "./registry.mjs";
import { reopenAttemptsOf, reopenCompletePlan, reopenUiNotApplicable } from "./reopen.mjs";
import { stateMappingMismatch } from "./templates.mjs";
import { assertBriefUnchanged, sliceAmendmentFor } from "./validation.mjs";

export const previewMigrationExecution = async ({
  registryPath,
  projectRoot,
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
  adoptVisualContract = false,
  confirmMismatch = false,
  mock = false,
  slice,
  // Rendered into `progressChecklist` only, which is attached outside the
  // hashed preview object; it can never reach a confirmation ID.
  mode,
} = {}) => {
  if (ponytail !== undefined) assertPonytailTarget(ponytail);
  const design = resolveDesignSource({ designSource, figma });
  for (const sliceId of reopenUi)
    assertSafeName(sliceId, "UI remediation slice");
  for (const sliceId of reopenComplete)
    assertSafeName(sliceId, "Reopened slice");
  if (amendSlice) assertSafeName(amendSlice, "Amended slice");
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
    targetOverride,
    legacy,
  });
  const registryBinding = await previewProjectRegistryBinding(
    registryData,
    projectRoot,
  );
  const bindingFields = {
    projectConfigPath: registryBinding.configPath,
    projectRegistryBinding: registryBinding.binding,
    registryIdentity: registryBinding.identity,
    projectConfigurationHash: createHash("sha256")
      .update(registryBinding.before)
      .update("\0")
      .update(registryBinding.content)
      .digest("hex"),
  };
  const root = migrationRoot(registryData.targetRoot, resolved.canonical);
  const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
  const existingState = await fileExists(statePath);
  const currentLegacyRevision = await gitRevision(registryData.legacyRoot);
  let requirementsAuthority = null;
  let proposedOpenSpec = null;
  let requirementsBlocker = null;
  if (!existingState && openSpecProposal !== undefined) {
    try {
      proposedOpenSpec = validateOpenSpecProposal(
        openSpecProposal,
        resolved.target,
      );
      if (
        await fileExists(
          path.resolve(
            registryData.targetRoot,
            proposedOpenSpec.authority.source,
          ),
        )
      ) {
        throw new Error(
          `OpenSpec source already exists before RESOLVE: ${proposedOpenSpec.authority.source}. Do not overwrite or restore it manually.`,
        );
      }
      requirementsAuthority = proposedOpenSpec.authority;
    } catch (error) {
      requirementsBlocker = error.message;
    }
  } else {
    if (existingState && openSpecProposal !== undefined) {
      throw new Error(
        "An OpenSpec proposal is accepted only while initializing RESOLVE.",
      );
    }
    try {
      requirementsAuthority = await loadOpenSpecAuthority(
        registryData.targetRoot,
        resolved.target,
      );
    } catch (error) {
      requirementsBlocker = existingState
        ? error.message
        : `OpenSpec source '${requirementsSourceFor(resolved.target)}' is validly absent at NOT_STARTED/RESOLVE because RESOLVE creates it. Draft the evidence-based proposal in memory and bootstrap with those bytes on stdin: \`artifact-migration-discover ${resolved.canonical} --target ${resolved.target} --openspec-proposal-stdin\` with the same \`--mode\`; when it prints a confirmation ID, rerun the identical call with \`--confirm-execution <id>\`. \`run\` and MCP never bootstrap.`;
    }
  }

  // Explicit source classification. Contract 5 refuses an older contract and
  // an unfinished upgrade transaction before it inspects anything else.
  const blockedPreview = (message) => ({
    migration: resolved.canonical,
    target: resolved.target,
    state: "INCOMPATIBLE",
    currentCheckpoint: null,
    activeSlice: null,
    action: "None. The persisted migration cannot be executed by contract 5.",
    reason: message,
    artifacts: [],
    expectedNextCheckpoint: null,
    expectedNextArtifact: null,
    currentFormatVersion: MIGRATION_FORMAT_VERSION,
    currentWorkflowVersion: WORKFLOW_VERSION,
    recordedFormatVersion: null,
    recordedWorkflowVersion: null,
    recordedLegacyRevision: null,
    currentLegacyRevision,
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
    revision: 0,
    blockers: [message],
    requiresConfirmation: false,
    statePath,
    openSpecDigest: requirementsAuthority?.digest ?? null,
    openSpecStatus: requirementsAuthority ? "EXISTING" : "MISSING",
    ...bindingFields,
    confirmationId: null,
  });

  // An unfinished upgrade or rollback transaction outranks everything, and it
  // must be checked before the absent-state branch: `commitReplacement` renames
  // the live tree away before it renames the staged tree in, so an interruption
  // in that window leaves no state.json at all. Checking only inside the
  // existing-state branch offered a fresh initialization over an in-flight
  // transaction, destroying the authored evidence the journal still refers to.
  const [pendingTransaction] = await pendingTransactions(
    registryData.targetRoot,
    resolved.canonical,
  );
  if (pendingTransaction) {
    return blockedPreview(
      `An unfinished upgrade transaction exists for '${resolved.canonical}' in state ${pendingTransaction.state}. Run '${upgradeCommandFor(resolved.canonical)} --recover' before any other migration work.`,
    );
  }

  // Uncommitted bytes are part of the authorized snapshot: a commit-only
  // revision cannot see a tracked edit, a new untracked file, a deletion, or a
  // rename, so a confirmation bound to it authorizes a source the execution
  // never reads.
  const legacyDirty = await dirtyManifest(registryData.legacyRoot);
  const targetDirty = await dirtyManifest(
    registryData.targetRoot,
    TARGET_DIRTY_SCOPE,
  );
  const registryDigest = hashContent(registryData.content);
  const briefDigest = brief
    ? await briefDigestFor(registryData.targetRoot, brief)
    : null;
  const boundInputs = {
    legacyRoot: portableRoot(registryData.legacyRoot),
    targetRoot: portableRoot(registryData.targetRoot),
    registryDigest,
    legacyDirtyDigest: legacyDirty.digest,
    targetDirtyDigest: targetDirty.digest,
    briefDigest,
  };

  if (!existingState) {
    // DR13: an interrupted initialization explains whatever it left (a root
    // without state, a committed OpenSpec, a rewritten binding). A preview
    // cannot recover it, so it says so; the resume recovers under the lock.
    if (await readJournal(initJournalFor(registryData.targetRoot, resolved.canonical))) {
      throw Object.assign(
        new Error(
          `Migration '${resolved.canonical}' has an interrupted initialization. Nothing is wrong with the record: resume it with '/start-migration <module>' (or 'discover-module.mjs <module>'), which recovers under the module lock before doing anything else.`,
        ),
        { pendingTransaction: true },
      );
    }
    const legacyBlocker = await legacyChecklistBlocker(
      registryData.targetRoot,
      resolved.canonical,
    );
    const partialInitializationBlocker = (await fileExists(root))
      ? `Migration initialization artifacts already exist without state at '${root}'. Refusing to overwrite or repair them manually.`
      : null;
    const blockers = [
      requirementsBlocker,
      legacyBlocker,
      partialInitializationBlocker,
      await brownfieldTargetBlocker(registryData.targetRoot, {
        adoptTarget,
        targetModule: resolved.target,
      }),
    ].filter(Boolean);
    const preview = {
      migration: resolved.canonical,
      target: resolved.target,
      state: "NOT_STARTED",
      currentCheckpoint: "RESOLVE",
      activeSlice: null,
      action: "Initialize the migration and complete RESOLVE",
      reason: "No persisted migration state exists for this canonical module.",
      artifacts: [
        `.agents/knowledge/migrations/modules/${resolved.canonical}/state.json`,
        `.agents/knowledge/migrations/modules/${resolved.canonical}/steps/*`,
        `.agents/knowledge/migrations/modules/${resolved.canonical}/inventories/*`,
        `.agents/knowledge/migrations/modules/${resolved.canonical}/matrices/*`,
        `.agents/knowledge/migrations/modules/${resolved.canonical}/slices/*`,
        `.agents/knowledge/migrations/modules/${resolved.canonical}/gates.json`,
        `.agents/knowledge/migrations/modules/${resolved.canonical}/history/*`,
        requirementsAuthority?.source ??
          `openspec/specs/${resolved.target}/spec.md`,
      ],
      expectedNextCheckpoint: "DISCOVER_LEGACY",
      expectedNextArtifact: "steps/02-discover-legacy.md",
      currentFormatVersion: MIGRATION_FORMAT_VERSION,
      currentWorkflowVersion: WORKFLOW_VERSION,
      recordedFormatVersion: null,
      recordedWorkflowVersion: null,
      recordedLegacyRevision: null,
      currentLegacyRevision,
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
      revision: 0,
      blockers,
      requiresConfirmation: blockers.length === 0,
      statePath,
      openSpecDigest: requirementsAuthority?.digest ?? null,
      openSpecStatus: proposedOpenSpec
        ? "PROPOSED"
        : requirementsAuthority
          ? "EXISTING"
          : "ABSENT_VALID_AT_RESOLVE",
      ...bindingFields,
    };
    return {
      ...preview,
      openSpecProposal: proposedOpenSpec?.content ?? null,
      registryBinding,
      boundInputs,
      // Bootstrap has no persisted state to describe; the CLI skips printing.
      progress: null,
      progressChecklist: null,
      confirmationId:
        blockers.length === 0
          ? confirmationIdFor({
              ...preview,
              ...boundInputs,
              requirementsAuthority,
              brief: brief ?? null,
              dataSourceMode: mock ? "mock" : "standard",
              ponytail: ponytail ?? null,
              legacySources: resolved.legacySources,
              adoptTarget,
              designSource: design.designSource,
              figmaSources: design.figmaSources,
              refresh,
              confirmMismatch,
              slice: slice ?? null,
            })
          : null,
    };
  }

  const persisted = await readJson(statePath, "Migration state");
  const incompatible = compatibilityBlocker(persisted, resolved.canonical);
  if (incompatible) {
    return {
      ...blockedPreview(incompatible),
      recordedFormatVersion: persisted.formatVersion ?? null,
      recordedWorkflowVersion: persisted.workflowVersion ?? null,
      recordedLegacyRevision: persisted.legacyRevision ?? null,
    };
  }

  const context = await readState(registryData.targetRoot, resolved.canonical);
  const { state } = context;
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
  // Refresh requires an explicit operator decision in every mode.
  if (refresh && !confirmMismatch) {
    throw new Error(
      "Refresh requires explicit mismatch confirmation. Use --refresh --confirm-mismatch only after confirming that the migration no longer matches the legacy behavior.",
    );
  }

  await validateCompletedHashes(root, state);
  // Fix E (candidate change): read-only slice/state consistency check, run
  // alongside the other resume-time revalidations below.
  await assertSliceStateConsistent(root, state);
  // Dispatch order, read-only half. An active format increment outranks every
  // lifecycle branch below, so its preview describes the increment rather than
  // a checkpoint. Nothing is written: the mutating
  // caller commits, and re-classifies under the module lock when it does,
  // because a preview is racy by definition.
  const formatUpgrade = upgradeProjection(
    await pendingFormatUpgrade(root, state, resolved.canonical, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    }),
  );
  // Active only. An owed-but-inactive increment is informational: it names a
  // prerequisite the lifecycle below is what produces, so this invocation falls
  // through to that lifecycle instead of stopping on an upgrade it cannot yet
  // classify. Read-only status is where it is reported.
  if (formatUpgrade?.active) {
    const ready = formatUpgrade.state === "READY";
    const upgradePreview = {
      migration: state.migrationId,
      target: state.targetModule,
      state: "FORMAT_UPGRADE",
      currentCheckpoint: state.currentStep,
      activeSlice: state.activeSlice,
      action: ready
        ? `Commit the ${formatUpgrade.from} -> ${formatUpgrade.to} format upgrade${formatUpgrade.upgrader ? ` (${formatUpgrade.upgrader.id} v${formatUpgrade.upgrader.version}, domain ${formatUpgrade.domain})` : ""}`
        : `None. The ${formatUpgrade.from} -> ${formatUpgrade.to} format upgrade is ${formatUpgrade.state} and the lifecycle is frozen behind it.`,
      reason: formatUpgrade.nextAction,
      artifacts: ready
        ? ["state.json", "history/history.ndjson", INTEGRITY_FILE]
        : [],
      expectedNextCheckpoint: state.currentStep,
      expectedNextArtifact: formatUpgrade.requiredInput?.path ?? null,
      currentFormatVersion: MIGRATION_FORMAT_VERSION,
      currentWorkflowVersion: WORKFLOW_VERSION,
      recordedFormatVersion: state.formatVersion,
      recordedWorkflowVersion: state.workflowVersion,
      recordedLegacyRevision: state.legacyRevision,
      currentLegacyRevision,
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
      revision: state.revision,
      blockers: ready
        ? []
        : formatUpgrade.blockers.length > 0
          ? formatUpgrade.blockers
          : [formatUpgrade.nextAction],
      requiresConfirmation: ready,
      statePath,
      openSpecDigest: requirementsAuthority?.digest ?? null,
      openSpecStatus: requirementsAuthority ? "EXISTING" : "MISSING",
      ...bindingFields,
      formatUpgrade,
    };
    const upgradeProgress = migrationProgress(state, {
      mode: mode ?? DEFAULT_MODE,
      outcome: "FORMAT_UPGRADE",
      reason: formatUpgrade.nextAction,
      formatUpgrade,
    });
    return {
      ...upgradePreview,
      registryBinding,
      boundInputs,
      progress: upgradeProgress,
      progressChecklist: renderProgress(upgradeProgress),
      // Bound to the upgrade's own digest as well as the state bytes, so a
      // candidate rewritten between preview and commit invalidates the
      // confirmation exactly as a moved checkpoint does.
      confirmationId: ready
        ? confirmationIdFor({
            ...upgradePreview,
            ...boundInputs,
            stateHash: await hashFile(statePath),
            formatUpgradeDigest: formatUpgrade.confirmationDigest,
          })
        : null,
    };
  }
  const legacyRevisionChanged =
    state.legacyRevision.revision !== currentLegacyRevision.revision;
  const refreshing = refresh;
  const blockers = requirementsBlocker ? [requirementsBlocker] : [];
  if (!requirementsBlocker) {
    try {
      await assertCurrentOpenSpecAuthority(registryData.targetRoot, state);
    } catch (error) {
      blockers.push(error.message);
    }
  }
  // `--reopen-complete` owns its drift check (`reopenCompletePlan`), where
  // the operator may acknowledge the exact new revision.
  if (
    legacyRevisionChanged &&
    !refreshing &&
    reopenUi.length === 0 &&
    reopenComplete.length === 0
  ) {
    blockers.push(
      `Legacy revision changed from '${state.legacyRevision.revision}' to '${currentLegacyRevision.revision}'. Review the mismatch before using --refresh --confirm-mismatch.`,
    );
  }
  if (state.brief) {
    try {
      await assertBriefUnchanged(root, state);
    } catch (error) {
      blockers.push(error.message);
    }
  }

  let action = checkpointAction(state);
  let reason =
    state.nextAction ??
    `The persisted state selects ${state.currentStep} as the next checkpoint.`;
  let artifacts = checkpointArtifacts(state);
  let expectedCheckpoint = expectedNextCheckpoint(state);
  let expectedArtifact =
    expectedCheckpoint === state.currentStep
      ? activeArtifact(state)
      : expectedCheckpoint === "COMPLETE"
        ? null
        : expectedCheckpoint === "IMPLEMENT_SLICES"
          ? "slices/<next-slice-id>.json"
          : expectedCheckpoint === "VERIFY_SLICES" && state.activeSlice
            ? `evidence/${state.activeSlice}/result.json`
            : state.artifacts.steps[expectedCheckpoint];

  if (reopenDiscovery) {
    if (state.currentStep !== "DISCOVERY_COMPLETENESS") {
      blockers.push(
        `--reopen-discovery is legal only from DISCOVERY_COMPLETENESS; the current checkpoint is '${state.currentStep}'.`,
      );
    }
    action = "Reopen DISCOVER_LEGACY to describe unclassified module files";
    reason =
      "The census found module files the legacy inventory does not describe; inventories/legacy.json is pinned and must be reopened to fix that.";
    artifacts = [
      "state.json",
      "history/history.ndjson",
      "steps/02-discover-legacy.md",
      "inventories/legacy.json",
    ];
    expectedCheckpoint = "DISCOVER_LEGACY";
    expectedArtifact = "steps/02-discover-legacy.md";
  }

  const pendingReverification =
    state.visualContractAdoption?.pendingReverification ?? [];
  if (
    pendingReverification.length > 0 &&
    !pendingReverification.every((sliceId) => reopenUi.includes(sliceId))
  ) {
    blockers.push(
      `The format-${VISUAL_ACCEPTANCE_FORMAT} visual contract was adopted, and slices ${pendingReverification.join(", ")} carry Figma visual evidence that predates it. Reopen them first: --reopen-ui ${pendingReverification.join(",")}.`,
    );
  }

  let visualContractAdoption = null;
  if (adoptVisualContract) {
    const plan = await visualContractAdoptionPlan(root, state, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
    blockers.push(...plan.blockers);
    visualContractAdoption = {
      fromFormat: state.formatVersion,
      toFormat: VISUAL_ACCEPTANCE_FORMAT,
      affectedSlices: plan.affectedSlices,
      evidenceDigest: plan.evidenceDigest,
    };
    action = `Adopt the format-${VISUAL_ACCEPTANCE_FORMAT} Figma visual acceptance contract in place`;
    reason = `Moves this record from format ${state.formatVersion} to ${VISUAL_ACCEPTANCE_FORMAT} with fresh canonical Figma evidence (${FIGMA_CONTEXT_ADOPTION_FILE}) and ${VISUAL_ACCEPTANCE_FILE}. Not a refresh, replan, or restart: no step, slice, approval, or functional evidence changes. Slices to reopen for visual reverification: ${plan.affectedSlices.join(", ") || "none"}.`;
    artifacts = [
      "state.json",
      "history/history.ndjson",
      FIGMA_CONTEXT_FILE,
      FIGMA_CONTEXT_ADOPTION_FILE,
      VISUAL_ACCEPTANCE_FILE,
      `${ADOPTION_ROOT}/figma-context.previous.json`,
      `${ADOPTION_ROOT}/record.json`,
    ];
    expectedCheckpoint = state.currentStep;
    expectedArtifact = null;
  }

  if (reopenUi.length > 0) {
    if (!reopenUiEligible(state)) {
      blockers.push(reopenUiIneligible(state));
    }
    const notApplicable = await reopenUiNotApplicable(root, state, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
    if (notApplicable) blockers.push(notApplicable);
    const planned = (await inspectSliceArtifacts(root)).plannedSlices;
    for (const sliceId of reopenUi) {
      if (!planned.includes(sliceId)) {
        blockers.push(`--reopen-ui names unknown slice '${sliceId}'.`);
      }
    }
    action = "Reopen only the selected slices for visible-UI remediation";
    reason =
      "A completed UI parity audit found missing discovery or runtime evidence; preserve completed non-UI work and reverify only the named slices.";
    artifacts = [
      "state.json",
      "history/history.ndjson",
      UI_REMEDIATION_FILE,
      ...reopenUi.map((sliceId) => `evidence/${sliceId}/result.json`),
      "steps/08-finalize.md",
      "gates.json",
    ];
    expectedCheckpoint = "VERIFY_SLICES";
    expectedArtifact = UI_REMEDIATION_FILE;
  }

  let reopenCompleteBinding = null;
  if (reopenComplete.length > 0) {
    const plan = await reopenCompletePlan(
      root,
      state,
      { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot },
      {
        slices: reopenComplete,
        reason: reopenReason,
        evidence: reopenEvidence,
        legacyRevision: currentLegacyRevision,
        confirmLegacyRevision,
        autoAcknowledge: isAutoAuthority(mode),
      },
    );
    blockers.push(...plan.blockers);
    const attempt = (await reopenAttemptsOf(root)) + 1;
    reopenCompleteBinding = {
      attempt,
      slices: plan.ordered,
      reason: typeof reopenReason === "string" ? reopenReason.trim() : null,
      evidenceReference: plan.claim,
      evidenceHash: plan.evidenceIdentity,
      // Absent without drift, so a no-drift confirmation ID is unchanged.
      ...(plan.legacyDrift ? { legacyRevision: plan.legacyDrift } : {}),
    };
    action = "Invalidate the named slices' finalized verification and reopen the completed migration";
    reason = `Post-finalization evidence (${plan.claim ?? reopenEvidence ?? "none"}) proves part of the finalized contract wrong: ${typeof reopenReason === "string" ? reopenReason.trim() : "no reason given"}. The superseded verification is preserved under ${REOPEN_ROOT}/${attempt}/ and stays pinned for life; every unnamed slice, every inventory and every operator decision keeps its pin.${plan.legacyDrift && plan.acknowledgedBy ? ` ${plan.acknowledgedBy === "AUTO" ? "The AUTO principal acknowledges" : "The operator acknowledges"} the legacy revision change '${plan.legacyDrift.fromLegacyRevision.revision}' -> '${plan.legacyDrift.toLegacyRevision.revision}'; the reopened slices and FINALIZE are reverified against the new revision.` : ""}`;
    artifacts = [
      "state.json",
      "history/history.ndjson",
      `${REOPEN_ROOT}/${attempt}/record.json`,
      ...plan.ordered.map(
        (sliceId) => `${REOPEN_ROOT}/${attempt}/evidence/${sliceId}/result.json`,
      ),
      ...plan.ordered.map((sliceId) => `evidence/${sliceId}/result.json`),
      ...IMMUTABLE_STEP_ARTIFACTS.FINALIZE,
    ];
    expectedCheckpoint = "VERIFY_SLICES";
    expectedArtifact = plan.ordered[0]
      ? `evidence/${plan.ordered[0]}/result.json`
      : null;
  }

  if (reworkSlice) {
    if (!usesSliceRework(state)) {
      blockers.push(
        `--rework-slice needs format ${SLICE_REWORK_FORMAT}; this migration is recorded at format ${state.formatVersion}. A record runs the lifecycle it was born under.`,
      );
    }
    if (state.currentStep !== "VERIFY_SLICES") {
      blockers.push(
        `--rework-slice is legal only at VERIFY_SLICES; the current checkpoint is '${state.currentStep}'.`,
      );
    }
    if (state.activeSlice !== reworkSlice) {
      blockers.push(
        `--rework-slice names '${reworkSlice}', but the active slice is '${state.activeSlice ?? "none"}'.`,
      );
    }
    if (reworkAttemptsOf(state, reworkSlice) >= MAX_SLICE_REWORKS) {
      blockers.push(reworkLimitBlocker(reworkSlice));
    }
    const failing = await readOptionalJson(
      path.join(root, `evidence/${reworkSlice}/result.json`),
      `Evidence for ${reworkSlice}`,
    );
    if (failing?.result !== "FAIL") {
      blockers.push(
        `--rework-slice requires a recorded FAIL for '${reworkSlice}'; evidence/${reworkSlice}/result.json records '${failing?.result ?? "nothing"}'.`,
      );
    } else if (
      !Array.isArray(failing.defects) ||
      failing.defects.length === 0
    ) {
      blockers.push(
        `${reworkSlice} evidence records FAIL with no defects[]; a failure with no named defect is not evidence of anything.`,
      );
    }
    const attempt = reworkAttemptsOf(state, reworkSlice) + 1;
    action = `Preserve the failed verification attempt for '${reworkSlice}' and return it to implementation`;
    reason = `Verification recorded ${failing?.defects?.length ?? 0} defect(s) for slice '${reworkSlice}'. Attempt ${attempt} of ${MAX_SLICE_REWORKS}.`;
    artifacts = [
      "state.json",
      "history/history.ndjson",
      `${REWORK_ROOT}/${reworkSlice}-${attempt}/result.json`,
      `${REWORK_ROOT}/${reworkSlice}-${attempt}/record.json`,
      `slices/${reworkSlice}.json`,
      `evidence/${reworkSlice}/result.json`,
    ];
    expectedCheckpoint = "IMPLEMENT_SLICES";
    expectedArtifact = `slices/${reworkSlice}.json`;
  }

  let sliceAmendment = null;
  if (amendSlice) {
    try {
      const amendmentPreview = await sliceAmendmentFor(
        root,
        state,
        { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot },
        amendSlice,
        addFiles,
      );
      blockers.push(...amendmentPreview.blockers);
      sliceAmendment = amendmentPreview.sliceAmendment;
    } catch (error) {
      blockers.push(error.message);
    }
    action = `Amend reopened slice '${amendSlice}' to claim ${addFiles.length} additional file(s)`;
    reason =
      "The reopened slice's implementation depends on files its pinned record does not list. The prior record is preserved byte-pinned; nothing is failed, reworked or re-planned.";
    artifacts = [
      "state.json",
      "history/history.ndjson",
      INTEGRITY_FILE,
      `slices/${amendSlice}.json`,
      sliceAmendment?.preservesAs ??
        `${SLICE_AMENDMENT_ROOT}/${amendSlice}-<n>/slice.json`,
    ];
    expectedCheckpoint = "VERIFY_SLICES";
    expectedArtifact = state.activeSlice
      ? `evidence/${state.activeSlice}/result.json`
      : null;
  }

  if (refreshing) {
    action = "Refresh legacy evidence and reopen DISCOVER_LEGACY";
    reason = `The user confirmed a legacy mismatch; the recorded revision is '${state.legacyRevision.revision}' and the current revision is '${currentLegacyRevision.revision}'.`;
    artifacts = [
      "steps/01-resolve.md",
      "state.json",
      "history/history.ndjson",
      "downstream artifact validity markers",
    ];
    expectedCheckpoint = "DISCOVER_LEGACY";
    expectedArtifact = "steps/02-discover-legacy.md";
  }

  if (
    slice &&
    state.activeSlice !== slice &&
    !state.pendingSlices.includes(slice)
  ) {
    blockers.push(
      `Slice '${slice}' is not active or pending for this migration.`,
    );
  }

  const preview = {
    // The record key, not the legacy module: at format 15 they differ.
    migration: state.migrationId,
    target: state.targetModule,
    state: state.status,
    currentCheckpoint: state.currentStep,
    activeSlice: state.activeSlice,
    action,
    reason,
    artifacts,
    expectedNextCheckpoint: expectedCheckpoint,
    expectedNextArtifact: expectedArtifact,
    currentFormatVersion: MIGRATION_FORMAT_VERSION,
    currentWorkflowVersion: WORKFLOW_VERSION,
    recordedFormatVersion: state.formatVersion,
    recordedWorkflowVersion: state.workflowVersion,
    recordedLegacyRevision: state.legacyRevision,
    currentLegacyRevision,
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
    revision: state.revision,
    blockers,
    requiresConfirmation: blockers.length === 0,
    statePath,
    openSpecDigest: requirementsAuthority?.digest ?? null,
    openSpecStatus: requirementsAuthority ? "EXISTING" : "MISSING",
    // Present only when an authority is pinned, so a target-system preview --
    // and the confirmation id derived from it -- is byte-identical to before.
    ...(visualAuthorityOf(state)
      ? {
          visualContract: {
            version: VISUAL_ACCEPTANCE_FORMAT,
            authority: {
              designSource: state.designSource,
              contextFile: visualAuthorityOf(state).contextFile,
              digest:
                state.artifactHashes?.[visualAuthorityOf(state).contextFile] ??
                null,
            },
          },
        }
      : {}),
    ...bindingFields,
    // Hashed into the confirmation: the operator approves these exact
    // evidence bytes and this exact set of slices, not "some adoption".
    ...(visualContractAdoption ? { visualContractAdoption } : {}),
    // Same binding: each added file's identity and both slice-record digests.
    ...(sliceAmendment ? { sliceAmendment } : {}),
    // Same binding again: the exact slices, the exact reason, and the exact
    // bytes of the evidence that authorizes invalidating a COMPLETE record.
    ...(reopenCompleteBinding ? { reopenComplete: reopenCompleteBinding } : {}),
  };
  const progress = previewProgress(state, mode, blockers);
  return {
    ...preview,
    registryBinding,
    boundInputs,
    // Both forms, from one computation: the text the CLI relays and the
    // structured projection `runMigration` reports when a blocked preflight
    // stops the iteration before any record was read.
    progress,
    progressChecklist: renderProgress(progress),
    confirmationId:
      blockers.length === 0
        ? confirmationIdFor({
            ...preview,
            ...boundInputs,
            stateHash: await hashFile(statePath),
            requirementsAuthority,
            brief: brief ?? null,
            dataSourceMode: mock ? "mock" : recordedDataSource,
            ponytail: ponytail ?? state.ponytail ?? null,
            designSource: state.designSource ?? "target-system",
            figmaSources: state.figmaSources ?? [],
            refresh,
            reopenDiscovery,
            reopenUi,
            confirmMismatch,
            slice: slice ?? null,
          })
        : null,
  };
};

export const assertExecutionConfirmation = (preview, confirmationId) => {
  if (!preview.requiresConfirmation) {
    throw new Error(
      `Migration execution is blocked: ${preview.blockers.join("; ")}`,
    );
  }
  if (
    typeof confirmationId !== "string" ||
    confirmationId !== preview.confirmationId
  ) {
    throw new Error(
      "Execution confirmation is missing or expired. Show the current pre-execution summary and ask the user to confirm again.",
    );
  }
  return true;
};
