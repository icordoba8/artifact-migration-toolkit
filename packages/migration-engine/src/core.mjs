/**
 * The migration core, as one import target (Plan 02 D2-1).
 *
 * Re-exports only. No logic lives here, so this file can never become the place
 * where a mutating path bypasses the module lock. What it does is state the
 * contract: these symbols are the core surface every front end may use -- the
 * CLI (Plan 03), the MCP adapter (Plan 06) -- and anything not listed here is
 * an implementation detail of `resumable-migration.mjs`, `migration-utils.mjs`,
 * `module-lock.mjs`, or `discovery-scan.mjs`.
 *
 * The four modules behind it are not split (D2-1). If a later plan proves a
 * split necessary, this facade is the seam it happens behind and no caller
 * changes.
 */

// -- policy: every deterministic rule the front ends must not own (D2-4, D2-5)
export {
  assertOptionCombination,
  exitCodeFor,
  isAutoAuthority,
  maySelfConfirm,
  MIGRATION_MODES,
  MIGRATION_OUTCOMES,
  nextOutcome,
} from "./migration-policy.mjs";

// -- versions and lifecycle
export {
  ARTIFACT_DELEGATION_FORMAT,
  CAPABILITY_OWNERSHIP_FORMAT,
  DESIGN_SOURCE_FORMAT,
  DIRECT_LEDGER_DECISIONS_FORMAT,
  DISCOVERY_COMPLETENESS_FORMAT,
  FINAL_GATES,
  FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
  LEGACY_MIGRATION_STEPS,
  MIGRATION_FORMAT_SUPPORTED,
  MIGRATION_FORMAT_VERSION,
  MIGRATION_STEPS,
  MULTI_SOURCE_FORMAT,
  RESUMABLE_CONTRACT_VERSION,
  STEP_DEPENDENCIES,
  stepsFor,
  UPGRADABLE_CONTRACT_VERSION,
  UPGRADABLE_FORMAT_VERSION,
  usesCapabilityOwnership,
  usesArtifactDelegation,
  usesDesignSource,
  usesDiscoveryCompleteness,
  usesMultiSource,
  isBrownfield,
  UI_VERIFICATION_FORMAT,
  usesUiVerification,
  UI_RUNTIME_STATES,
  WORKFLOW_VERSION,
} from "./resumable-migration.mjs";

// -- compatibility and process contract
export {
  assertDiscoveryCompletenessFormat,
  BLOCKED_EXIT_CODE,
  compatibilityBlocker,
  DEFAULT_MODE,
  renderLoopDirective,
  upgradeCommandFor,
} from "./resumable-migration.mjs";

// -- artifact and file identity
export {
  BASELINE_ROWS_PIN,
  AUTO_DECISIONS_FILE,
  CAPABILITY_OWNERSHIP_FILE,
  DECISIONS_FILE,
  DISCOVERY_PIN,
  DISCOVERY_SCAN_FILE,
  migrationRoot,
  MODULE_CLASSIFICATION_FILE,
  TARGET_BASELINE_FILE,
  TARGET_DIRTY_SCOPE,
  UI_REMEDIATION_FILE,
} from "./resumable-migration.mjs";

// -- the canonical progress projection every front end renders (Plan 09).
// Derived data: `migrationProgress` reads a record and returns one, and
// `renderProgress` is the text fallback rendered from that same object. A
// provider adapter that wants a native task UI maps the projection; it never
// parses the text and never authors a list of its own.
export {
  CHECKPOINT_STATES,
  migrationProgress,
} from "./resumable-migration.mjs";

// -- reading a record
export {
  activeArtifact,
  authoringRequest,
  checkpointAction,
  checkpointArtifacts,
  expectedNextCheckpoint,
  getMigrationStatus,
  readMigrationContext,
  readState,
} from "./resumable-migration.mjs";

// -- preview and execution: `executeMigration` is `bootstrapMigration` under
// the name that describes what it does (D2-2). Both stay exported, permanently.
export {
  advanceMigration,
  adoptUiObservations,
  artifactBindingFor,
  artifactPrerequisiteWork,
  assertArtifactPrerequisites,
  delegatedChangedFilesSatisfiedByChild,
  validateArtifactDelegationRow,
  assertExecutionConfirmation,
  bootstrapMigration,
  bootstrapMigration as executeMigration,
  previewAdvance,
  previewDiscoveryScan,
  previewMigrationExecution,
  previewUiObservationsAdoption,
  renderAdvancePreview,
  renderProgress,
  renderProgressBlock,
  renderProgressChecklist,
  validateResumableMigration,
} from "./resumable-migration.mjs";

// -- format upgrades: the registry is the sole promoter at or above the floor.
// Read-only projection (`pendingFormatUpgrade`), the freeze guard, and the one
// mutating entry point the normal command dispatches to.
export {
  assertNoPendingFormatUpgrade,
  commitFormatUpgrade,
  commitNoOpFormatUpgrade,
  FORMAT_UPGRADE_FLOOR,
  FORMAT_UPGRADERS,
  isUiObservationsAdoption,
  pendingFormatUpgrade,
} from "./resumable-migration.mjs";

// -- slices
export {
  inspectSliceArtifacts,
  reconcileSliceState,
} from "./resumable-migration.mjs";

// -- operator decisions (read-only; recording one is TTY-gated elsewhere)
export {
  createDecisionCandidate,
  decisionAppliesToCandidate,
  decisionGroupFor,
  decisionLineDigest,
  decisionRationaleDigest,
  edgeDecisionSubject,
  decisionChannelOf,
  rawDecisionLedgerDigest,
  readAutoDecisions,
  readOperatorDecisions,
  readRecordedDecisions,
} from "./resumable-migration.mjs";
export { LATE_DECISION_KINDS } from "./resumable-migration.mjs";

// `03` D3-6: the lock-free, read-only candidate reader `run` narrows
// `OPERATOR_DECISION` with. Reading candidates is not approving one -- the TTY
// gate that governs approval lives in `runRecordDecisionCli` and is untouched.
export { pendingDecisionCandidates } from "./record-decision.mjs";

// The canonical fresh decision projection. One read-only view over current
// candidates, trusted policy, both verified ledgers and checkpoint state --
// status, pending decisions and run all consume this, so a consumer cannot
// construct a second opinion by reading something else.
export { projectDecisions } from "./record-decision.mjs";
export {
  DECISION_PROJECTION_STATES,
  projectModuleDecision,
} from "./resumable-migration.mjs";

// The operation half of the same idea: one human act over an ordered set of
// operator *transitions*, not ledger lines. Only the authorization minted here
// can carry an `authorizedBy` into a SLICE_SCOPE_AMENDED event, and only an
// operation that actually executed writes one.
export {
  AMEND_SLICE,
  authorizeOperationSequence,
  challengeForOperationSequence,
  deriveOperationSequence,
  operationSequenceRunner,
  OPERATION_SEQUENCE_KIND,
  renderOperationSequence,
} from "./operation-sequence.mjs";
export {
  lifecycleBinding,
  sequenceAuthorizationEvidence,
} from "./resumable-migration.mjs";

// -- discovery and legacy binding
export {
  legacySourceBinding,
  readCanonicalModuleBoundary,
  renderTargetBaseline,
  sourceOfEvidence,
  validateDiscoveryCompleteness,
} from "./resumable-migration.mjs";
export {
  parserResolutionError,
  runDiscoveryScan,
  structuralUnits,
} from "./discovery-scan.mjs";

// -- OpenSpec authority
export {
  loadOpenSpecAuthority,
  validateOpenSpecProposal,
} from "./resumable-migration.mjs";

// -- registry: core functions that happen to live in `migration-utils.mjs`
// (D2-3). They contain no argv, stdout, or TTY; the file's name is the only
// thing that ever suggested otherwise.
export {
  assertFigmaSource,
  assertNoPendingTransaction,
  assertProjectRootContainment,
  assertSafeName,
  assertPonytailTarget,
  assertSecurePath,
  atomicWrite,
  committedChangesSince,
  DESIGN_SOURCES,
  dirtyManifest,
  gitRevision,
  PONYTAIL_TARGETS,
  resolveDesignSource,
  resolveLegacySources,
  pendingTransactions,
  persistProjectRegistryBinding,
  previewProjectRegistryBinding,
  previewRegistryUpdate,
  readRegistry,
  registryIdentity,
  renderRegistryPreview,
  resolveModule,
  resolveRegistryPath,
  updateRegistry,
} from "./migration-utils.mjs";

// -- content identity: the one cross-platform policy that decides what an
// ordinary file pin means. Both engines import it from here; neither owns a
// second implementation, and no raw-byte purpose is routed through it.
export {
  CONTENT_IDENTITY_BYTES,
  CONTENT_IDENTITY_TEXT,
  contentIdentity,
  contentIdentityMatches,
  fileContentIdentity,
  fileContentIdentityMatches,
  isContentIdentity,
  isTextIdentityEligible,
  parseContentIdentity,
} from "./migration-utils.mjs";

// -- the exclusive per-module lock every mutating operation runs inside
export { lockPathFor, withModuleLock } from "./module-lock.mjs";

// -- toolkit identity: which built release may mutate a record. Implementation
// metadata on an axis of its own -- nothing here is a migration contract,
// format, workflow or decision value, and no rule in either direction couples
// toolkit SemVer to a migration version number.
export {
  activeToolkitIdentity,
  autoAdoptableToolkitTransition,
  BUILD_IDENTITY_FILE,
  digestToolkitIdentity,
  renderToolkitIdentity,
  sameToolkitIdentity,
  TOOLKIT_IDENTITY_EVENTS,
  TOOLKIT_IDENTITY_KEYS,
  TOOLKIT_NAME,
  toolkitIdentityBlocker,
  toolkitIdentityKey,
  toolkitIdentityStatus,
  validateToolkitIdentity,
} from "./toolkit-identity.mjs";
export {
  assertRecordToolkitIdentity,
  assertToolkitIdentityNotMismatched,
  autoAdoptToolkitIdentity,
  changeModuleToolkitIdentity,
  toolkitAdoptCommand,
} from "./resumable-migration.mjs";

// -- R-1: every command a front end shows an operator is rendered against the
// engine's own installed location, never a consumer-repository-relative guess.
export {
  engineArgv,
  engineCommand,
  engineScriptsRoot,
  engineSkillRoot,
  quoteCommandToken,
  skillRootFor,
} from "./engine-paths.mjs";
