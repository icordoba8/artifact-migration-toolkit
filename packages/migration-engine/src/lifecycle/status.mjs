/**
 * Lifecycle: the status projection and the resumable-record validation. Moved
 * verbatim from `resumable-migration.mjs` (Track A8).
 */
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
import { readOptionalJson, readRegistry } from "../store/index.mjs";
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

export const getMigrationStatus = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  const context = await readState(registryData.targetRoot, resolved.canonical);
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
