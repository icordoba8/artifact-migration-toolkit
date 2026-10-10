// PROPOSAL ownership map. Every top-level function/class -> exactly one module.
// usage: node assign.mjs <decls.tsv>  -> prints file\tline\tE/I\tname\tmodule ; exits 1 on missing/duplicate/unknown.
import { readFileSync } from "node:fs";
const RM = "resumable-migration.mjs", AM = "artifact/artifact-migration.mjs";
const LEAF = "unassigned:leaf";
// [file, module, names]; "*" = every remaining function in that file
const T = [
  // VALUES (constants, aliases): derived once by name rule / majority of referrers / file default, then frozen here.
  [AM, "census", `COMPLETENESS_DISPOSITIONS EXTERNAL_ELEMENT CODE_FILE_EXTENSIONS TARGET_COMPILER_SPECIFIERS metrics STRUCTURAL_SCRIPT_EXTENSIONS TEST_UNDER_SRC FEATURE_INDEX UI_TEXT_PROPS PROVIDER_PATHS SCANNER_REQUIREMENT_KEYS`, "value"],
  [AM, "formats", `ARTIFACT_CONTRACT_VERSION ARTIFACT_FORMAT_VERSION ARTIFACT_FORMAT_SUPPORTED ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS ARTIFACT_WORKFLOW_VERSION ARTIFACT_RESOLUTIONS ARTIFACT_FORMAT_UPGRADE_FLOOR FEATURE_FILE QUERY_KEYS_FILE STATE_FILE INTEGRITY_FILE HISTORY_FILE TRANSACTION_FILE KNOWN_STATE_KEYS OPTIONAL_STATE_KEYS`, "value"],
  [AM, "lifecycle", `PRESERVED_DISPOSITIONS ARTIFACT_FORMAT_UPGRADERS EXECUTION_CAPABILITY READ_ONLY_CAPABILITY TRANSACTION_VERSION EMPTY_HISTORY CHECKPOINT_DECISION_PASSES`, "value"],
  [AM, "slices", `JS_FILE_EXTENSIONS execFileAsync MANIFEST_DEPENDENCY_FIELDS PACKAGE_MANAGERS SCRIPT_NAME RESOLUTION_KIND`, "value"],
  [AM, "store", `STATE_ROOT HISTORY_EVENT_KEYS`, "value"],
  ["cli/run-migration.mjs", "transport", `TERMINAL_VALIDATION_REFUSALS`, "value"],
  ["cli/toolkit-identity.mjs", "transport", `COMMANDS`, "value"],
  ["discovery-scan.mjs", "census", `execFileAsync CENSUS_ALGORITHM_VERSION SUPPORTED_ALGORITHM_VERSIONS SCRIPT_EXTENSIONS STYLE_EXTENSIONS ASSET_EXTENSIONS DATA_EXTENSIONS DOC_EXTENSIONS PROBE_EXTENSIONS VISUAL_KINDS PRODUCTION_REACHABILITY REACHABILITY_VALUES NEXT_APP_FILES NEXT_ROOT_FILES TEST_PATTERN CENSUS_COMMAND SCRIPT_UNIT_EXTENSIONS STRUCTURAL_MAX_DEPTH CSS_IMPORT CSS_URL FINDING_KINDS UNPROVEN_MODULE_EDGES`, "value"],
  ["engine-paths.mjs", "formats", `engineScriptsRoot engineSkillRoot`, "value"],
  ["mcp-server.mjs", "decisions", `CONFIRMATION_SCHEMA ELICITATION_TIMEOUT_MS`, "value"],
  ["mcp-server.mjs", "transport", `SERVER_NAME PROTOCOL_VERSIONS JSON_RPC_PARSE_ERROR JSON_RPC_INVALID_REQUEST JSON_RPC_METHOD_NOT_FOUND JSON_RPC_INTERNAL_ERROR INPUT_SCHEMA RUN_INPUT_SCHEMA RELAY_TOOL RELAY_INPUT_SCHEMA ARTIFACT_INPUT_SCHEMA REFUSED_TOOLS APPROVAL_SHAPED_KEY TOOLS PROGRESS_TOOLS TOOLS_BY_NAME toolCalls`, "value"],
  ["migration-policy.mjs", "lifecycle", `MIGRATION_OUTCOMES`, "value"],
  ["migration-policy.mjs", "transport", `MIGRATION_MODES MODE_MESSAGE DISCOVER_USAGE ARTIFACT_USAGE RUN_USAGE RUN_REFUSED_OPTIONS EXIT_CODES`, "value"],
  ["migration-utils.mjs", "formats", `DESIGN_SOURCES FIGMA_FILE_KEY FIGMA_NODE_ID`, "value"],
  ["migration-utils.mjs", "transport", `MINIMUM_NODE_MAJOR`, "value"],
  ["migration-utils.mjs", LEAF, `execFileAsync SAFE_NAME PONYTAIL_TARGETS TEXT_IDENTITY_EXTENSIONS CONTENT_IDENTITY_TEXT CONTENT_IDENTITY_BYTES IDENTITY_SCHEMES TAGGED_IDENTITY PREFIXED_DIGEST BARE_DIGEST CR LF TAB DEL`, "value"],
  ["module-lock.mjs", "lifecycle", `LOCK_ROOT`, "value"],
  ["operation-sequence.mjs", "decisions", `OPERATION_SEQUENCE_KIND AMEND_SLICE`, "value"],
  ["operator-approval.mjs", "decisions", `AUTO_REASON autoDecisionRecorder`, "value"],
  ["operator-signer-service.mjs", "formats", `SERVICE_CONFIG_FILE`, "value"],
  ["operator-signer.mjs", "decisions", `PRODUCTION_ATTESTED_WRITES ACTIVATION_KEYS HTML_ESCAPES SECURITY_HEADERS APP_JS ENROLL_JS SESSION_MS BODY_LIMIT`, "value"],
  ["operator-signer.mjs", "formats", `ACTIVATION_MANIFEST_FILE STORE_FILE`, "value"],
  ["operator-webauthn.mjs", "decisions", `ASSERTION_PROTOCOL CHALLENGE_DOMAIN VERIFICATION_VERSION MAX_CHALLENGE_LIFETIME_MS COSE_ES256 ATTESTED_ARTIFACT_KINDS RECORD_KEYS PAYLOAD_KEYS BINDING_KEYS DIGEST PROOF_KEYS`, "value"],
  ["operator-webauthn.mjs", LEAF, `BASE64URL`, "value"],
  ["record-decision.mjs", "decisions", `DECISION_KINDS APPROVAL_CHANNELS APPROVAL_EVIDENCE_PHRASES rationaleDigestOf SIGNER_UNAVAILABLE REVIEW_EFFECTS PROJECTION_PRECEDENCE BOUND_TO_FIELDS`, "value"],
  [RM, "census", `TARGET_STATES UI_KINDS UI_MISMATCH_DISPOSITIONS UI_INTERACTIVE_KINDS UI_CONDITIONAL_KINDS UI_RUNTIME_STATES CLASSIFICATION_SCOPES DISPOSITIONS DECISION_BACKED_DISPOSITIONS AGENT_DISMISSIBLE`, "value"],
  [RM, "decisions", `LATE_DECISION_KINDS DECISION_GROUP_KIND DECISION_MODULE_BINDING DECISION_PRINCIPALS DECISION_RESULTS DECISION_V2_FIELDS DEFAULT_DECISION_POLICY_ID JUDGMENT_KINDS STANDARD_LOCAL DEFAULT_DECISION_POLICY_DIGEST LEGACY_DECISION_POLICY_ID LEGACY_DECISION_POLICY_DIGEST attestationVerifierScope consumedDecisionStore readMigrationContext SEQUENCE_AUTHORIZATION`, "value"],
  [RM, "formats", `MAX_SLICE_REWORKS UI_OBSERVATIONS_ADOPTION_ROOT RESUMABLE_CONTRACT_VERSION MIGRATION_FORMAT_VERSION WORKFLOW_VERSION EARLIEST_SUPPORTED_FORMAT DISCOVERY_COMPLETENESS_FORMAT CAPABILITY_OWNERSHIP_FORMAT UI_VERIFICATION_FORMAT ARTIFACT_DELEGATION_FORMAT DESIGN_SOURCE_FORMAT MULTI_SOURCE_FORMAT SLICE_REWORK_FORMAT VISUAL_ACCEPTANCE_FORMAT REQUIRED_OBSERVATIONS_FORMAT DIRECT_LEDGER_DECISIONS_FORMAT MIGRATION_FORMAT_SUPPORTED FORMAT_ACTIVE_FOR_NEW_MIGRATIONS FORMAT_UPGRADE_FLOOR UI_OBSERVATIONS_CANDIDATE_FILE SELF_HEALING_FORMAT_VERSIONS NON_PROMOTING_FORMAT_VERSIONS FORMAT_FEATURES SUPPORTED_FORMAT_VERSIONS ANCHORED_FORMAT_VERSION UPGRADABLE_CONTRACT_VERSION UPGRADABLE_FORMAT_VERSION MIGRATION_STEPS LEGACY_MIGRATION_STEPS TARGET_ADOPTION_MODES UI_PROOF_FORMAT DISCOVERY_SCAN_FILE MODULE_CLASSIFICATION_FILE DECISIONS_FILE AUTO_DECISIONS_FILE CAPABILITY_OWNERSHIP_FILE UI_REMEDIATION_FILE FIGMA_CONTEXT_FILE VISUAL_ACCEPTANCE_FILE FIGMA_CONTEXT_ADOPTION_FILE LEGACY_RUNTIME_CONTEXT_FILE   TARGET_BASELINE_FILE STEP_FILES KNOWN_STATE_KEYS INTEGRITY_FILE initialArtifacts PROTECTED_DECISION_POLICY_FILE LEGACY_COMPATIBILITY_ACTION_REQUIRED TOOLKIT_IDENTITY_SCRIPT DIRECT_LEDGER_PINNED_ARTIFACTS`, "value"],
  [RM, "lifecycle", ` DEFAULT_MODE FINAL_GATES TERMINAL_PARITY PARITY_STATUSES SLICE_EARNED_PARITY BEHAVIOR_DISPOSITIONS CAPABILITY_DISPOSITIONS SHARED_CONSUMER_THRESHOLD ADOPTION_ROOT STEP_DEPENDENCIES OPEN_SPEC_REQUIREMENT OPEN_SPEC_SCENARIO initialJsonArtifacts LEGACY_REVISION_LINE LEGACY_REVISION_SCOPE_LINE ADVANCE_JOURNAL PATH_CLAIM EVIDENCE_CATEGORIES EVIDENCE_KINDS EVIDENCE_STATUSES DECISION_PROJECTION_STATES PONYTAIL_GATE_EVIDENCE FORMAT_UPGRADERS CHECKPOINT_STATES STOPPING_OUTCOMES CHECKPOINT_MARKERS`, "value"],
  [RM, "slices", `TERMINAL_DESIGN_SYSTEM NON_TERMINAL_CAPABILITIES TARGET_DIRTY_SCOPE anchoredOwnershipCache REWORK_ROOT  REWORK_PATH DRIFT_OWNERSHIP_STEPS DRIFT_CLASSES UNDERIVABLE_OWNERSHIP_REASON SLICE_AMENDMENT_ROOT ENGINE_SKILL_ROOT TEST_LEVEL_SUFFIX`, "value"],
  [RM, "store", `REOPEN_ROOT BASELINE_ROWS_PIN IMMUTABLE_BEHAVIOR_ROW_FIELDS DISCOVERY_PIN IMMUTABLE_STEP_ARTIFACTS DERIVED_PINS HISTORY_HASH_DOMAIN`, "value"],
  [RM, "transport", `BLOCKED_EXIT_CODE`, "value"],
  [RM, "visual", `AUTHORITY_CONTEXT_FILES VISUAL_AUTHORITIES UI_UNREQUIRED_DISPOSITIONS UI_VIEWPORT_STATES UI_SECRET_KEY_PATTERN UI_SECRET_VALUE_PATTERN LEGACY_RUNTIME_EVIDENCE_ROOT TARGET_EVIDENCE_ROOT LEGACY_AUTHORITY_ROLE TARGET_VERIFICATION_ROLE OBSERVATION_EXPECTED OBSERVATION_FIELDS FIGMA_NODE_ID FIGMA_SOURCE_KINDS VISUAL_UNBACKED_KIND MAX_TOLERANCE_PX MAX_TOLERANCE_RATIO PROVISIONAL_VISUAL_DIFF_THRESHOLDS`, "value"],
  ["toolkit-identity.mjs", "formats", `TOOLKIT_IDENTITY_KEYS BUILD_IDENTITY_FILE TOOLKIT_NAME SEMVER COMMIT_SHA CONTENT_HASH cached TOOLKIT_IDENTITY_EVENTS`, "value"],
  ["upgrades/upgrade-migration.mjs", "lifecycle", `contractPath TRANSACTION_STATES writeJournal`, "value"],
  ["upgrades/upgrade-v4-to-v5.mjs", "formats", `V5_CONTRACT_VERSION V5_FORMAT_VERSION V5_WORKFLOW_VERSION SOURCE_CONTRACT_VERSION SOURCE_FORMAT_VERSION V5_STEPS STEP_FILES IMMUTABLE_STEP_ARTIFACTS TRACE_MATRICES STATE_FILE GATES_FILE HISTORY_FILE SLICE_INDEX_FILE BRIEF_FILE INTEGRITY_FILE`, "value"],
  ["visual-evidence.mjs", "visual", `require HARDENED_VISUAL_VERSION FIXED_VISUAL_TOLERANCE REQUIRED_FACTS REQUIRED_FACT_KINDS REQUIRED_FACT_NAMES COLOR_FACTS LENGTH_FACTS GEOMETRY_FACTS FONT_WEIGHTS STROKE_SIDES STROKE_FIELDS SHADOW_FIELDS XML_ENTITIES FIGMA_PROVENANCE_KINDS CONTAINER_TEXT_TYPES STRUCTURED_PROVENANCE_RANKS METADATA_PROPERTIES LITERAL_PREFIXES STRUCTURAL_PROPERTIES STRUCTURED_REQUIRED`, "value"],
  [RM, "formats", `requirementsSourceFor  validateOpenSpecAuthorityShape stepsFor usesDiscoveryCompleteness usesCapabilityOwnership usesUiVerification usesArtifactDelegation usesDesignSource usesMultiSource
    usesSliceRework usesVisualAcceptance usesRequiredObservations usesDirectLedgerDecisions isUiObservationsAdoption 
    usesSourceAttribution assertDiscoveryCompletenessFormat stampedFormatVersion formatIsSupported formatIsPromoting upgradeCommandFor
    compatibilityBlocker  assertLegacyRevisionShape validateTargetAdoptionShape validateStateShape
    LegacyCompatibilityActionRequired  toolkitAdoptCommand assertRecordToolkitIdentity 
    renderToolkitAdoption assertToolkitIdentityNotMismatched   
       assertDirectLedgerEligible directLedgerAdoptionPreview
    directLedgerAdoptionDigest    assertNoPendingFormatUpgrade `],
  [RM, "store", `fileExists readJson hashFile fileIdentity fileIdentityMatches pinnedSourcePath hashPinnedArtifact isBytePinned pinnedArtifactMatches
    digestArtifactHashes historyAnchorOf historyAnchorNow renderIntegrity decisionsAnchorNow autoDecisionsAnchorNow renderIntegrityNow readIntegrity
    assertIntegrityAnchor assertDecisionsAppendOnly assertHistoryAppendOnly assertUnanchoredHistoryTail resolveStepPins 
    contentIdentityMatchesSource migrationRoot statePathFor renderState stateMappingMismatch readState assertStateGraph historyDigest keyOrder
    canonicalHistoryJson hashHistoryEvent prepareHistoryEvent appendHistory assertHistoryAppendable sealHistoryTail appendHistoryOnce
    readHistoryEvents completedArtifactHashes validateCompletedHashes readContext readOptionalJson removeEmptyParents`],
  [RM, "lifecycle", `combinedUiAdoptionPlan visualContractAdoptionPlan uiObservationsAdoptionPlan previewUiObservationsAdoption pendingFormatUpgrade legacyChecklistBlocker autoAdoptToolkitIdentity changeModuleToolkitIdentity adoptVisualContractUnderLock adoptUiObservations adoptDirectLedgerDecisions commitNoOpFormatUpgrade commitFormatUpgrade artifactEngine  briefDigestFor parseOpenSpec  loadOpenSpecAuthority validateOpenSpecProposal
     assertCurrentOpenSpecAuthority activeArtifact expectedNextCheckpoint checkpointArtifacts checkpointAction
    authoringRequest confirmationIdFor resumeGuidance renderStep stepTemplates createResolveStep readAdvanceJournal assertRecovered
    recoverMigrationRecord recoverPendingAdvance assertStepDocumentComplete evidencePathClaim resolveEvidencePath assertEvidenceResolves
    assertOpenSpecIds assertEvidenceChecklist assertCommandResults artifactBindingFor validateArtifactDelegationRow validateCapabilityOwnership
    validateAdoptedRow validateBaseline artifactOptions artifactPrerequisiteWork assertArtifactPrerequisites delegatedChangedFilesSatisfiedByChild
    assertPostAnchorEvidence assertEvidenceReference assertEvidenceEntry pinnedInputTimestamps validateGates assertBriefUnchanged validateStep
    previewMigrationExecution assertExecutionConfirmation assertBoundInputsUnchanged initJournalFor ownerMatches writeOwner cleanupInitialization
    rollbackInitialization recoverInitialization commitInitialization bootstrapMigration reopenCompletePlan reopenAttemptsOf reopenCompleteUnderLock
    bootstrapUnderLock getMigrationStatus validateResumableMigration previewAdvance renderAdvancePreview migrationProgress renderProgress
    renderProgressBlock renderProgressChecklist previewProgress advanceMigration advanceUnderLock`],
  [RM, "decisions", `isAutoAuthority decisionKindAllowed assertLateDecisionsAreAppendable decisionLineDigest decisionRationaleDigest lifecycleBinding
    edgeDecisionSubject candidateHash candidateDigestOf createDecisionCandidate createNewFormatDecisionCandidate decisionGroupMemberFact groupMembersOf
    groupCandidateInput decisionGroupFor createNewFormatDecisionGroup resolveGroupDecision decisionAppliesToCandidate rawDecisionLedgerDigest
    rawDecisionLedgerBytes decisionChannelOf  canonicalPolicy policyPrincipal principalSatisfiesRequirement validateProtectedDecisionPolicy
    trustedPolicyFor resolveRequiredPrincipal resolveHistoricalRequiredPrincipal decisionLineProblem attestedLineProblem verifyAttestedLine
    decisionPrincipalOf readDecisionLedger readOperatorDecisions readAutoDecisions readRecordedDecisions requireDecision consumedDecisionIdentity
    recordConsumedDecision applicableDecisionOutcome resolveApplicableDecision groupAuthorityFor requireModuleDecision projectModuleDecision
    moduleDecisionCandidate moduleEdgeTargetsFrom assertDirectLedgerClassificationSchema pendingVisualUnbackedCandidates pendingTargetDriftCandidates
    brandSequenceAuthorization sequenceAuthorizationEvidence`],
  [RM, "slices", `rootRelativePath targetRelativePath legacyRelativePath anySliceVerified portableRoot baselineDirtyEntries renderTargetBaseline validateTargetBaselineShape targetBaselineDrift
    readTargetBaseline assertSliceStateConsistent traceLists assertCoversPlanned validatePlan assertCapabilityPlan governingReopen verifiedReopenRecord
    resolveReopenAnchor repoRelative anchoredReopenOwnership resolveAnchoredOwnership validateImplementedSlice resolveChangedFile
    implementationDigests reworkLimitBlocker reworkPathParts reworkAttemptsOf preservedEvidencePath validateFailedSliceResult validateVerifiedSlice
    assertNoUnresolvedVerification assertGatesCoverSliceScenarios plannedTargetOwners withinPlannedScope canonicalClaim claimedTargetPaths
    classifyTargetDrift targetRelative eventNamesSlice sliceAmendmentFor unlistedSliceFiles unclaimedTargetDrift assertNoUnclaimedTargetDrift
    inspectSliceArtifacts reconcileSliceState repairSliceState reworkSliceUnderLock amendSliceUnderLock`],
  [RM, "census", `legacySourcesOf isBrownfield assertLegacySourcesUnchanged assertLegacyDiscoveryChecklist assertTargetAssessmentChecklist
    validateLegacyInventory legacySourceBinding assertRecordedScannerVersion readCanonicalModuleBoundary moduleRootPath moduleRootSource
    assertSourcedModuleRoots sourceOfEvidence assertLegacyEvidenceWithinBoundary validateDiscoveryCompleteness assertAdoptedTargetEvidence
    validateTargetInventory featureLocalPrefix isUnderFeature assertLegacyEvidenceAttributes assertDiscoveryUnchanged targetFeatureDirectory
    brownfieldTargetBlocker reopenDiscoveryUnderLock previewDiscoveryScan`],
  [RM, "visual", `usesVisualContract visualAuthorityOf assertNoUiSecret uiBehaviorIsRequired hardenedVisual frameKeyOf  assertCaptureRole assertTargetEvidencePath
     pinsAuthorityContext designSourceExplicit figmaSourceKey assertDesignSourceUnchanged assertRequiredObservations
    validateUiRuntimeEvidence sliceLacksUiProofV1 completedSlicesLackingUiProofV1 withUiProofReopenHint figmaNodeKey figmaMetadataAncestry
    visualContractDigest visualUnbackedCandidate backedRowFor validateFigmaContext resolveStructuredFigmaFrame resolveFigmaFacts
    validateLegacyRuntimeContext assertVisualCaptureBlock compareVisualEvidence validateVisualAcceptance compareVisualFact assertVisualAcceptance
    assertNoNavigationRepairNeeded reopenUiEligible reopenUiIneligible reopenUiNotApplicable reopenUiUnderLock`],
  [RM, "transport", `renderLoopDirective`],
  [RM, LEAF, `sha256Json hashContent recordRelative isPlainObject assertPlainObject assertArray assertNonEmpty assertBoolean assertUniqueIds isWithin now commonAncestor
       assertIsoTimestamp withoutExtension sameFile`],

  [AM, "formats", `validateBinding artifactFormatUpgrade artifactFormatAdmissible  
     validateState replayToolkitIdentity  assertArtifactToolkitIdentity
    `],
  [AM, "store", `fileHash secureHash    readHistory historyPrefixContent historyEventExtraKeys integrityFor
    ledgerPrefixesFor validateIntegrity revalidatePins pinDigest immutableProjection writeTransaction stateFileExists readJsonAt readArtifactState
    semanticEvidence artifactEvidenceDigest artifactRoot`],
  [AM, "lifecycle", `proveToolkitIdentityTransaction proveFormatUpgradeTransaction pristineFormatUpgrade previewArtifactFormatUpgrade upgradeArtifactFormat changeArtifactToolkitIdentity engineFault startMetrics artifactMetrics asEngineFault validateTransactionInput assertTransactionReplayable
    assertKnownRecoveryPhase proveBootstrapTransaction proveAdvanceTransaction reconstructLegacyTransaction finishTransaction
    assertTransactionBoundToRecord recoverTransaction buildAdvanceTransaction previewArtifact createArtifactRecord bootstrapArtifact
    initialArtifactState bootstrapEventInput eventFor consumedAtCheckpoint validateBaseline validateGateEvidence ponytailTime
    validatePonytailEvidence validateFinal checkpointArtifacts validateCheckpoint runCheckpointValidation freshness progressState requestFor
    outcomeResult blockedArtifactResult locate assertInvocationMatches getArtifactStatus readArtifactStatus pinsFor pathsAfterCheckpoint nextState
    previewAdvance runArtifactIteration runArtifact validateArtifactComplete`],
  [AM, "census", `loadStructuralParser structuralParser targetTypeScript resolveCompilerBinary commandFile hasExecutableCodeFiles targetProject
    moduleSpecifiersIn targetCodeFiles legacyDependencies hardcodedUiText architectureFindings assertDirectory isExcluded scopedManifest
    captureBinding sourcePathAtRoot targetPathsFor sourcePathForId bindingInput  resolveArtifact artifactIdFor validateEvidenceFile
    validateSourceEvidenceFile validateSourceInventory dispositionValidator packageNameOf validateExternalRequirements sourceRequirements
    validateCompleteness validateTargetInventory`],
  [AM, "slices", `assertMayExecute execute pathKey executeTypeScriptValidation executeNodeCheckValidation executeValidator hasCodeValidationCheck
    targetManifest assertTargetProvides packageScriptOf executeGenericCheck validatePlan validateImplementation validateBoundTo validateVerification
    migrationChangedFiles diffEntries implementationCoversDrift`],
  [AM, "visual", `strictVisualState artifactVisualAuthority artifactUiInventory artifactVisualAcceptance validateArtifactVisualEvidence`],
  [AM, "decisions", `artifactDecisionBoundTo artifactDecisionCandidate artifactCandidateEvidence projectArtifactDecision consumedFrom
    verifyConsumedHistory reconcileArtifactDecisions artifactOperatorDecisions artifactVisualDecisions`],
  [AM, "transport", `artifactArgumentsFor artifactCommandFor artifactIdentityCommand`],
  [AM, LEAF, `jsonBytesEqual jsonBytes canonical portable sha256 samePath isWithin exists plainObject exactObject arrayOf nonEmpty boolean versionOne unique sameMembers normalizeRelative`],

  ["migration-utils.mjs", "formats", `assertFigmaSource resolveDesignSource`],
  ["migration-utils.mjs", "store", `atomicWrite resolveRegistryRoot validateRegistry registryIdentity readProjectConfiguration canonical gitTopLevel
    legacyInstalledProjectRoot projectRootFor readStateRegistry stateRegistryFromCwd stateRegistryFromCandidate stateRegistryFromWorkspace mismatch
    resolveRegistryPath previewProjectRegistryBinding persistProjectRegistryBinding readRegistry resolveModule nextRegistryDocument
    previewRegistryUpdate renderRegistryPreview registryJournalPathFor recoverRegistryJournal updateRegistry   
          fileContentIdentity
    fileContentIdentityMatches`],
  ["migration-utils.mjs", "lifecycle", `pendingTransactions assertNoPendingTransaction`],
  ["migration-utils.mjs", "visual", ` `],
  ["migration-utils.mjs", "census", `resolveLegacySources`],
  ["migration-utils.mjs", "transport", `doctorCheck existingKnowledgeRoot runDoctor`],
  ["migration-utils.mjs", LEAF, `contentIdentityMatches contentIdentity isContentIdentity parseContentIdentity isTextIdentityEligible isTextContent expandLf foldCrlf sha256Hex portablePath comparablePath samePath isPonytailTarget assertPonytailTarget assertSafeName assertPlainObject isWithin
    assertSecurePath assertProjectRootContainment gitRevision dirtyManifest committedChangesSince headRevision fileAtRevision isAncestorCommit
    commitsTouchingSince commitsIntroducingBlob`],

  ["discovery-scan.mjs", LEAF, `portable isWithin`],
  ["discovery-scan.mjs", "census", "*"],
  ["visual-evidence.mjs", LEAF, `sha256`],
  ["visual-evidence.mjs", "visual", "*"],
  ["toolkit-identity.mjs", "formats", "*"],
  ["format-upgrade.mjs", "formats", "*"],
  ["module-lock.mjs", "lifecycle", "*"],
  ["engine-paths.mjs", "transport", "*"],
  ["operation-sequence.mjs", "decisions", "*"],
  ["operator-approval.mjs", "decisions", "*"],
  ["operator-signer.mjs", "decisions", "*"],
  ["operator-signer-service.mjs", "decisions", "*"],
  ["operator-webauthn.mjs", LEAF, `exactKeys nonEmpty b64 base64url sha256Digest`],
  ["operator-webauthn.mjs", "decisions", "*"],
  ["migration-policy.mjs", "decisions", `maySelfConfirm`],
  ["migration-policy.mjs", "lifecycle", `nextOutcome`],
  ["migration-policy.mjs", "transport", "*"],
  ["record-decision.mjs", "transport", `parseDecisionArguments runRecordDecisionCli runArtifactDecisionCli`],
  ["record-decision.mjs", "store", `appendDurably`],
  ["record-decision.mjs", "decisions", "*"],
  ["upgrades/upgrade-migration.mjs", "transport", `parseUpgradeArguments runUpgradeCli`],
  ["upgrades/upgrade-migration.mjs", "lifecycle", `previewRollback previewUpgrade resolveContext restorableUpgrade executeUpgrade executeRollback lockPathFor acquireLock readJournal recoverTransaction recoverUpgrade`],
  ["upgrades/upgrade-migration.mjs", "store", `writeTree commitReplacement readTree manifestOf sameManifest exists assertNoSymlink`],
  ["upgrades/upgrade-migration.mjs", LEAF, `sha256`],
  ["upgrades/upgrade-migration.mjs", "formats", "*"],
  
  ["upgrades/upgrade-v4-to-v5.mjs", LEAF, `sha256 isPlainObject`],
  ["upgrades/upgrade-v4-to-v5.mjs", "formats", "*"],
  ["cli/run-migration.mjs", "decisions", `pendingApprovals decisionCandidates operatorApproval`],
  ["cli/run-migration.mjs", "transport", "*"],
  ["mcp-server.mjs", "decisions", `trustedDecisionRecorder`],
  ["mcp-server.mjs", "transport", "*"],
  ["cli/advance-migration.mjs", "transport", "*"], ["cli/discover-module.mjs", "transport", "*"], ["cli/toolkit-identity.mjs", "transport", "*"],
  ["cli/update-migration-registry.mjs", "transport", "*"], ["cli/validate-migration.mjs", "transport", "*"], ["artifact/run-artifact.mjs", "transport", "*"],
];
const isFnKind = (k) => k === "fn" || k === "class";
const decls = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => l.split("\t"))
  .filter(([, , , kind]) => isFnKind(kind) || kind === "value");
const out = new Map(); let bad = 0;
for (const [file, mod, names, kind = "fn"] of T) {
  const pool = decls.filter((d) => d[0] === file && (kind === "value" ? d[3] === "value" : isFnKind(d[3])));
  const list = names === "*" ? pool.filter((d) => !out.has(`${file}\t${d[4]}`)).map((d) => d[4]) : names.trim().split(/\s+/).filter(Boolean);
  for (const n of list) {
    const key = `${file}\t${n}`;
    if (!pool.some((d) => d[4] === n)) { console.error(`UNKNOWN ${key}`); bad++; continue; }
    if (out.has(key)) { console.error(`DUPLICATE ${key} ${out.get(key)} ${mod}`); bad++; continue; }
    out.set(key, mod);
  }
}
for (const d of decls) if (!out.has(`${d[0]}\t${d[4]}`)) { console.error(`MISSING ${d[0]}:${d[1]} ${d[4]}`); bad++; }
for (const d of decls) console.log([d[0], d[1], d[2], d[4], out.get(`${d[0]}\t${d[4]}`) ?? "?", d[5], d[3]].join("\t"));
process.exitCode = bad ? 1 : 0;
