/**
 * Lifecycle: the status projection and the resumable-record validation. Moved
 * verbatim from `resumable-migration.mjs` (Track A8).
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  assertDiscoveryCompletenessFormat,
  initialArtifacts,
  MIGRATION_FORMAT_VERSION,
  toolkitIdentityBlocker,
  toolkitIdentityStatus,
  UI_REMEDIATION_FILE,
  upgradeProjection,
  usesUiVerification,
  VISUAL_ACCEPTANCE_FORMAT,
  WORKFLOW_VERSION,
} from "../formats/index.mjs";
import { gitRevision } from "../shared/index.mjs";
import { fileExists, migrationRoot, readOptionalJson, readRegistry, statePathFor } from "../store/index.mjs";
import { visualAuthorityOf } from "../visual/index.mjs";
import { activeToolkitIdentity } from "../toolkit-identity.mjs";
import { activeArtifact, resumeGuidance } from "./checkpoints.mjs";
import { readContext } from "./context.mjs";
import { pendingFormatUpgrade } from "./format-upgrade.mjs";
import { assertCurrentOpenSpecAuthority } from "./openspec.mjs";
import { migrationProgress, renderProgress } from "./progress.mjs";
import { readState, validateCompletedHashes } from "./record.mjs";
import { toolkitAdoptCommand } from "./toolkit-identity.mjs";
import { assertBriefUnchanged, validateStep } from "./validation.mjs";

/**
 * A status-first invocation before the first bootstrap must be read-only and
 * actionable, not an unregistered-module exception. There is no record yet:
 * progress is deliberately null, and this pre-initialization message is not a
 * fabricated checkpoint projection.
 */
const notStarted = (moduleName, target = null) => {
  const command = `/start-migration ${moduleName} --target <target-module>`;
  return {
    module: moduleName,
    target,
    status: "NOT_STARTED",
    initialized: false,
    currentStep: "NOT_STARTED",
    nextAction: "Inspect the legacy implementation, draft a real OpenSpec proposal with normative MUST or SHALL requirements and scenarios, and bootstrap through the official two-phase discover command.",
    nextCommand: command,
    progress: null,
    progressChecklist:
      `initialization: ${moduleName} -> ${target ?? "(unregistered)"}  status=NOT_STARTED (no persisted record)\n` +
      `next: ${command}\n`,
  };
};

// Artifacts without state are a damaged record, never a fresh module -- the
// same refusal preview gives. An unregistered record is keyed by its module.
const refuseRecordWithoutState = async (targetRoot, recordKey) => {
  const root = migrationRoot(targetRoot, recordKey);
  if (await fileExists(root))
    throw new Error(`Migration initialization artifacts already exist without state at '${root}'. Refusing to overwrite or repair them manually.`);
};

// A legacy name whose migration is recorded under another target is not a fresh
// module: refuse, naming the record's own command. ponytail: one readdir of
// the records directory per unregistered status; index records if it grows.
const refuseLegacyNameOfRecord = async (targetRoot, moduleName, error) => {
  const records = path.dirname(migrationRoot(targetRoot, moduleName));
  const keys = await readdir(records).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
  for (const key of keys) {
    const state = await readOptionalJson(statePathFor(targetRoot, key)).catch(() => null);
    if (state?.legacyModule === moduleName || state?.legacySources?.includes?.(moduleName))
      throw new Error(`${error.message} Its migration is recorded as '${key}': use ${state.nextCommand ?? `/start-migration ${key}`}.`);
  }
};

export const getMigrationStatus = async ({ registryPath, moduleName }) => {
  let registryData;
  let resolved;
  try {
    ({ registryData, resolved } = await readContext({ registryPath, moduleName }));
  } catch (error) {
    if (error.message !== `Module '${moduleName}' is not registered. Supply --target <target-module>.`)
      throw error;
    const { targetRoot } = await readRegistry(registryPath);
    await refuseRecordWithoutState(targetRoot, moduleName);
    await refuseLegacyNameOfRecord(targetRoot, moduleName, error);
    return notStarted(moduleName);
  }
  let context;
  try {
    context = await readState(registryData.targetRoot, resolved.canonical);
  } catch (error) {
    const missing = `Migration state does not exist: ${statePathFor(registryData.targetRoot, resolved.canonical)}`;
    if (error.message !== missing) throw error;
    await refuseRecordWithoutState(registryData.targetRoot, resolved.canonical);
    return notStarted(moduleName, resolved.target);
  }
  await assertCurrentOpenSpecAuthority(registryData.targetRoot, context.state);
  await validateCompletedHashes(context.root, context.state);
  await assertBriefUnchanged(context.root, context.state);
  const currentLegacyRevision = await gitRevision(registryData.legacyRoot);
  let uiEvidence = {
    applicable: false,
    state: "NOT_APPLICABLE",
    runtime: "NOT_APPLICABLE",
  };
  if (usesUiVerification(context.state)) {
    const legacy = await readOptionalJson(
      path.join(context.root, initialArtifacts.legacyInventory),
      "Legacy inventory",
    );
    const remediation = await readOptionalJson(
      path.join(context.root, UI_REMEDIATION_FILE),
      "UI remediation",
    );
    const slices = await readOptionalJson(
      path.join(context.root, initialArtifacts.slices),
      "Slice index",
    );
    let records = 0;
    let limitations = 0;
    for (const slice of slices?.slices ?? []) {
      const result = await readOptionalJson(
        path.join(context.root, `evidence/${slice.id}/result.json`),
        `Evidence for ${slice.id}`,
      );
      records += Array.isArray(result?.uiEvidence)
        ? result.uiEvidence.length
        : 0;
      limitations += Array.isArray(result?.uiEvidenceLimitations)
        ? result.uiEvidenceLimitations.length
        : 0;
    }
    const hasVisibleUi =
      (remediation?.hasVisibleUi ?? legacy?.hasVisibleUi) === true;
    uiEvidence = {
      applicable: hasVisibleUi,
      state: !hasVisibleUi
        ? "NOT_REQUIRED"
        : records > 0
          ? "RECORDED"
          : "MISSING",
      // Runtime availability is explicit, so an offline application is a named
      // state rather than an absence a resuming session has to guess about.
      runtime: !hasVisibleUi
        ? "NOT_APPLICABLE"
        : records > 0
          ? "AVAILABLE"
          : limitations > 0
            ? "NOT_AVAILABLE"
            : "REQUIRED",
      records,
      limitations,
      freshness: context.state.evidenceFreshness,
    };
  }
  // Read-only, and ordered. Identity outranks the format upgrade, so a record
  // pinning a build this engine cannot prove it is reports that refusal and the
  // increment is reported as BLOCKED without the record being read further. An
  // unstamped record is still projected: adoption is a mutating path's problem,
  // and status must say what is owed without stamping anything. Nothing in here
  // writes -- no auto-adoption, no recovery, no commit.
  const identityBlocker = context.state.toolkitIdentity
    ? toolkitIdentityBlocker(
        context.state.toolkitIdentity,
        activeToolkitIdentity(),
        {
          action: "Classifying this record's pending format upgrade",
          adoptCommand: toolkitAdoptCommand(resolved.canonical),
        },
      )
    : null;
  const formatUpgrade = upgradeProjection(
    await pendingFormatUpgrade(
      context.root,
      context.state,
      resolved.canonical,
      { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot },
      { identityBlocker },
    ),
  );
  // The one decision projection, read here rather than re-derived: status used
  // to report no decision state at all, which is why callers went to the ledger
  // or to `run`'s log for it and could see something the gate disagreed with.
  // Imported at call time, as before Track A8 (the recorder now sits below
  // this file, so the import is downward; the call-time load is kept as is).
  //
  // A record with no decision-bearing census -- too early, or a format whose
  // candidates cannot be derived at all -- reports null rather than failing a
  // status read: nothing here may block saying where the record stands.
  const decisions = await import("./recorder.mjs")
    .then((module_) =>
      module_.projectDecisions({ registryPath, moduleName }),
    )
    .catch(() => null);
  const progress = migrationProgress(context.state, {
    mode: null,
    uiEvidence,
    formatUpgrade,
    // Reported either way, but only an *active* increment stops the lifecycle:
    // an INACTIVE one leaves the checklist live, because the checkpoint it names
    // is what produces the prerequisite.
    outcome: formatUpgrade?.active ? "FORMAT_UPGRADE" : null,
  });
  return {
    module: context.state.legacyModule,
    target: context.state.targetModule,
    status: context.state.status,
    contractVersion: context.state.contractVersion,
    formatVersion: context.state.formatVersion,
    currentFormatVersion: MIGRATION_FORMAT_VERSION,
    workflowVersion: context.state.workflowVersion,
    currentWorkflowVersion: WORKFLOW_VERSION,
    requirementsAuthority: context.state.requirementsAuthority,
    dataSourceMode: context.state.dataSourceMode,
    ponytail: context.state.ponytail ?? null,
    designSource: context.state.designSource ?? "target-system",
    figmaSources: context.state.figmaSources ?? [],
    // Which authority this record's visual contract is derived from, and the
    // pinned artifact that is the authority. Null for target-system, which
    // derives no visual contract at all.
    visualContract: visualAuthorityOf(context.state)
      ? {
          version: VISUAL_ACCEPTANCE_FORMAT,
          authority: {
            designSource: context.state.designSource,
            contextFile: visualAuthorityOf(context.state).contextFile,
            digest:
              context.state.artifactHashes?.[
                visualAuthorityOf(context.state).contextFile
              ] ?? null,
          },
        }
      : null,
    currentStep: context.state.currentStep,
    activeSlice: context.state.activeSlice,
    completedSteps: context.state.completedSteps,
    completedSlices: context.state.completedSlices,
    pendingSlices: context.state.pendingSlices,
    nextAction: context.state.nextAction,
    nextCommand: context.state.nextCommand,
    nextArtifact: activeArtifact(context.state),
    // Read-only reporting, never a write: `UNSTAMPED` is what every record
    // created before the standalone toolkit reports, and status must say so
    // without stamping anything. Toolkit SemVer is reported beside, and stays
    // independent of, the format/contract/workflow numbers above.
    toolkitIdentity: context.state.toolkitIdentity ?? null,
    activeToolkitIdentity: activeToolkitIdentity(),
    toolkitIdentityStatus: toolkitIdentityStatus(
      context.state.toolkitIdentity ?? null,
      activeToolkitIdentity(),
    ),
    recordedLegacyRevision: context.state.legacyRevision,
    currentLegacyRevision,
    legacyRevisionChanged:
      context.state.legacyRevision.revision !== currentLegacyRevision.revision,
    uiEvidence,
    // The canonical fresh decision projection -- the same one pending decisions
    // and run read, so the three cannot disagree in one session.
    decisions,
    // The structured contract: the pending increment, or null when the record
    // is at the runtime format or below the upgrade floor.
    formatUpgrade,
    ...resumeGuidance(context.state),
    // The canonical projection, and the same text rendered from it. Both are
    // returned: `progress` is what a provider maps into a native task UI, and
    // `progressChecklist` is the unchanged fallback every existing caller
    // already reads.
    progress,
    progressChecklist: renderProgress(progress),
    statePath: context.statePath,
  };
};

export const validateResumableMigration = async ({
  registryPath,
  moduleName,
  step,
  slice,
  complete = false,
} = {}) => {
  const registryData = await readRegistry(registryPath);
  if (!moduleName) {
    return {
      valid: true,
      modules: Object.keys(registryData.modules).sort(),
    };
  }
  const { resolved } = await readContext({ registryPath, moduleName });
  const context = await readState(registryData.targetRoot, resolved.canonical);
  await assertCurrentOpenSpecAuthority(registryData.targetRoot, context.state);
  await validateCompletedHashes(context.root, context.state);
  await assertBriefUnchanged(context.root, context.state);
  const requestedStep =
    step ?? (complete ? "FINALIZE" : context.state.currentStep);
  if (requestedStep === "DISCOVERY_COMPLETENESS") {
    assertDiscoveryCompletenessFormat(
      context.state,
      resolved.canonical,
      "DISCOVERY_COMPLETENESS validation",
    );
  }
  if (requestedStep === "COMPLETE") {
    if (context.state.status !== "COMPLETE") {
      throw new Error("Migration state is not COMPLETE.");
    }
  } else {
    await validateStep(context.root, context.state, requestedStep, slice, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
  }
  if (complete && context.state.status !== "COMPLETE") {
    throw new Error(
      "Final artifacts pass, but state is not COMPLETE. Advance FINALIZE first.",
    );
  }
  return {
    valid: true,
    module: context.state.legacyModule,
    target: context.state.targetModule,
    contractVersion: context.state.contractVersion,
    formatVersion: context.state.formatVersion,
    workflowVersion: context.state.workflowVersion,
    status: context.state.status,
    step: requestedStep,
    slice: slice ?? context.state.activeSlice,
    complete,
    statePath: context.statePath,
  };
};
