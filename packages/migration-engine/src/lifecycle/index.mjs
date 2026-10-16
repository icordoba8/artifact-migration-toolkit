/**
 * Lifecycle: the module's one public entry (Track A8, option (b) of
 * docs/phase0-architecture-baseline.md).
 *
 * Lifecycle owns migration orchestration: the module and artifact state
 * machines, checkpoint progression, bootstrap, preview and confirmation, the
 * module lock and every journal (advance, initialization, artifact transaction,
 * registry, contract upgrade), crash recovery, reopening and repair, format
 * upgrade and toolkit-identity transitions, final validation, status and
 * progress, and the one decision recorder that re-derives facts under the lock.
 * It composes slices/, visual/, census/, decisions/, store/, formats/ and
 * shared/ through their entries and never redefines their rules. Transport and
 * the historical paths import this entry; nothing below imports it.
 *
 * Only re-exports. Module and artifact checkpoint readers keep separate names
 * (`checkpointArtifacts`, `artifactCheckpointArtifacts`), because their
 * contracts differ.
 */
export {
  BLOCKED_EXIT_CODE,
  DEFAULT_MODE,
  exitCodeFor,
  isAutoAuthority,
  maySelfConfirm,
  MIGRATION_MODES,
  MIGRATION_OUTCOMES,
  nextOutcome,
  renderLoopDirective,
} from "./policy.mjs";
export {
  acquireModuleLock,
  lockPathFor,
  processAlive,
  withModuleLock,
} from "./lock.mjs";
export { writeJournalAtomic } from "./journal.mjs";
export {
  assertNoPendingTransaction,
  pendingTransactions,
  updateRegistry,
} from "./registry.mjs";
export {
  activeArtifact,
  ADOPTION_ROOT,
  authoringRequest,
  checkpointAction,
  checkpointArtifacts,
  compatibilityBlocker,
  expectedNextCheckpoint,
  FINAL_GATES,
  STEP_DEPENDENCIES,
  upgradeCommandFor,
} from "./checkpoints.mjs";
export {
  BASELINE_ROWS_PIN,
  DISCOVERY_PIN,
  readState,
} from "./record.mjs";
export {
  loadOpenSpecAuthority,
  validateOpenSpecProposal,
} from "./openspec.mjs";
export { previewEvidenceBinding } from "./gates.mjs";
export {
  previewDiscoveryScan,
  readMigrationContext,
  recoverMigrationRecord,
} from "./context.mjs";
export {
  artifactBindingFor,
  artifactPrerequisiteWork,
  assertArtifactPrerequisites,
  DECISION_PROJECTION_STATES,
  pendingTargetDriftCandidatesCompat,
  sliceDriftFacts,
  validateArtifactDelegationRow,
} from "./validation.mjs";
export {
  assertExecutionConfirmation,
  previewMigrationExecution,
} from "./preview.mjs";
export {
  assertRecordToolkitIdentity,
  assertToolkitIdentityNotMismatched,
  autoAdoptToolkitIdentity,
  changeModuleToolkitIdentity,
  toolkitAdoptCommand,
} from "./toolkit-identity.mjs";
export {
  bootstrapMigration,
} from "./bootstrap.mjs";
export {
  repairSliceState,
} from "./reopen.mjs";
export {
  adoptUiObservations,
  previewUiObservationsAdoption,
} from "./adoption.mjs";
export {
  commitFormatUpgrade,
  commitNoOpFormatUpgrade,
  FORMAT_UPGRADERS,
  pendingFormatUpgrade,
} from "./format-upgrade.mjs";
export {
  CHECKPOINT_STATES,
  migrationProgress,
  renderProgress,
  renderProgressBlock,
  renderProgressChecklist,
} from "./progress.mjs";
export {
  getMigrationStatus,
  validateResumableMigration,
} from "./status.mjs";
export {
  advanceMigration,
  previewAdvance,
  renderAdvancePreview,
} from "./advance.mjs";
export {
  executeRollback,
  executeUpgrade,
  previewRollback,
  previewUpgrade,
  recoverTransaction,
  recoverUpgrade,
  TRANSACTION_STATES,
} from "./contract-upgrade.mjs";
export {
  beginAttestedDecision,
  completeAttestedDecision,
  parseDecisionArguments,
  pendingDecisionCandidates,
  projectDecisions,
  recordNewFormatDecisionGroup,
  relayOperatorDecision,
  reviewAttestedCandidate,
  runRecordDecisionCli,
} from "./recorder.mjs";
export {
  approveWithOperator,
  artifactApprover,
  moduleApprover,
  recorderFor,
} from "./approval.mjs";
export {
  artifactArgumentsFor,
  artifactCommandFor,
  assertArtifactToolkitIdentity,
  readArtifactState,
} from "./artifact-record.mjs";
export {
  hasCodeValidationCheck,
} from "./artifact-execution.mjs";
export {
  checkpointArtifacts as artifactCheckpointArtifacts,
  reconcileArtifactDecisions,
} from "./artifact-checkpoints.mjs";
export {
  artifactMetrics,
  artifactOperatorDecisions,
  getArtifactStatus,
  previewArtifact,
  progressState,
  validateArtifactComplete,
} from "./artifact-status.mjs";
export {
  ARTIFACT_FORMAT_UPGRADERS,
  bootstrapArtifact,
  changeArtifactToolkitIdentity,
  previewArtifactFormatUpgrade,
  runArtifact,
  upgradeArtifactFormat,
} from "./artifact-run.mjs";
