import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  assertDiscoveryUnchanged,
  assertLegacyDiscoveryChecklist,
  assertLegacyEvidenceAttributes,
  assertLegacyEvidenceWithinBoundary,
  assertLegacySourcesUnchanged,
  assertTargetAssessmentChecklist,
  brownfieldTargetBlocker,
  CENSUS_ALGORITHM_VERSION,
  featureLocalPrefix,
  isBrownfield,
  isUnderFeature,
  legacySourceBinding,
  legacySourcesOf,
  readCanonicalModuleBoundary,
  resolveLegacySources,
  targetFeatureDirectory,
  validateDiscoveryCompleteness,
  validateLegacyInventory as validateLegacyInventoryRules,
  validateTargetInventory,
} from "./census/index.mjs";
import { engineCommand } from "./engine-paths.mjs";

import {
  assertNoPendingTransaction,
  pendingTransactions,
  updateRegistry,
} from "./migration-utils.mjs";
import {
  assertDirectLedgerEligible,
  assertDiscoveryCompletenessFormat,
  assertNoPendingFormatUpgrade,
  assertPonytailTarget,
  AUTO_DECISIONS_FILE,
  autoAdoptableToolkitTransition,
  CAPABILITY_OWNERSHIP_FILE,
  classifyUpgrade,
  DECISIONS_FILE,
  digestToolkitIdentity,
  DIRECT_LEDGER_DECISIONS_FORMAT,
  directLedgerAdoptionDigest,
  directLedgerAdoptionPreview,
  DISCOVERY_SCAN_FILE,
  FIGMA_CONTEXT_ADOPTION_FILE,
  FIGMA_CONTEXT_FILE,
  FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
  FORMAT_INCREMENTS,
  FORMAT_UPGRADE_FLOOR,
  initialArtifacts,
  INTEGRITY_FILE,
  isUiObservationsAdoption,
  LEGACY_COMPATIBILITY_ACTION_REQUIRED,
  LEGACY_RUNTIME_CONTEXT_FILE,
  MAX_SLICE_REWORKS,
  MIGRATION_FORMAT_SUPPORTED,
  MIGRATION_FORMAT_VERSION,
  MIGRATION_STEPS,
  MODULE_CLASSIFICATION_FILE,
  nextIncrement,
  recordCompatibilityBlocker,
  renderToolkitIdentity,
  REQUIRED_OBSERVATIONS_FORMAT,
  requirementsSourceFor,
  resolveDesignSource,
  RESUMABLE_CONTRACT_VERSION,
  sameToolkitIdentity,
  SLICE_REWORK_FORMAT,
  stampedFormatVersion,
  STEP_FILES,
  stepsFor,
  TARGET_BASELINE_FILE,
  TOOLKIT_IDENTITY_EVENTS,
  toolkitIdentityBlocker,
  toolkitIdentityKey,
  toolkitIdentityStatus,
  UI_OBSERVATIONS_ADOPTION_ROOT,
  UI_OBSERVATIONS_CANDIDATE_FILE,
  UI_PROOF_FORMAT,
  UI_REMEDIATION_FILE,
  UI_VERIFICATION_FORMAT,
  upgradeIsActive,
  upgradeProjection,
  usesArtifactDelegation,
  usesCapabilityOwnership,
  usesDesignSource,
  usesDirectLedgerDecisions,
  usesDiscoveryCompleteness,
  usesIntegrityAnchor,
  usesMultiSource,
  usesRequiredObservations,
  usesSliceRework,
  usesSourceAttribution,
  usesUiVerification,
  usesVisualAcceptance,
  validateOpenSpecAuthorityShape,
  validateRecordStateShape,
  validateToolkitIdentity,
  VISUAL_ACCEPTANCE_FILE,
  VISUAL_ACCEPTANCE_FORMAT,
  WORKFLOW_VERSION,
} from "./formats/index.mjs";
import {
  assertArray,
  assertBoolean,
  assertIsoTimestamp,
  assertNonEmpty,
  assertPlainObject,
  assertSafeName,
  assertSecurePath,
  assertUniqueIds,
  contentIdentity,
  dirtyManifest,
  gitRevision,
  headRevision,
  isContentIdentity,
  isPlainObject,
  isResolvedWithin as isWithin,
  now,
  sameFile,
  sha256Hex as hashContent,
} from "./shared/index.mjs";
import {
  appendHistory,
  assertCommandResults,
  assertEvidenceReference,
  assertEvidenceResolves,
  assertHistoryAppendable,
  assertUnanchoredHistoryTail,
  atomicWrite,
  contentIdentityMatchesSource,
  digestArtifactHashes,
  evidencePathClaim,
  fileExists,
  fileIdentity,
  fileIdentityMatches,
  hashFile,
  hashHistoryEvent,
  historyAnchorNow,
  historyAnchorOf,
  migrationRoot,
  persistProjectRegistryBinding,
  prepareHistoryEvent,
  previewProjectRegistryBinding,
  previewRegistryUpdate,
  readHistoryEvents,
  readIntegrity,
  readJson,
  readOptionalJson,
  readRegistry,
  registryIdentity,
  removeEmptyParents,
  renderIntegrity,
  renderState,
  REOPEN_ROOT,
  resolveEvidencePath,
  resolveModule,
  sealHistoryTail,
  statePathFor,
} from "./store/index.mjs";
import { withModuleLock, writeJournalAtomic } from "./module-lock.mjs";
import {
  assertDesignSourceUnchanged,
  assertRequiredObservations,
  completedSlicesLackingUiProofV1,
  designSourceExplicit,
  FIGMA_SOURCE_KINDS,
  LEGACY_AUTHORITY_ROLE,
  LEGACY_RUNTIME_EVIDENCE_ROOT,
  pinsAuthorityContext,
  reopenUiEligible,
  reopenUiIneligible,
  sliceLacksUiProofV1,
  uiBehaviorIsRequired,
  usesVisualContract,
  validateUiRuntimeEvidence,
  validateVisualAcceptance,
  VISUAL_AUTHORITIES,
  visualAuthorityOf,
} from "./visual/index.mjs";
import { activeToolkitIdentity } from "./toolkit-identity.mjs";
import {
  assertLateDecisionsAreAppendable,
  consumedDecisionStore,
  rawDecisionLedgerBytes,
  rawDecisionLedgerDigest,
  sequenceAuthorizationEvidence,
} from "./decisions/index.mjs";
import {
  anySliceVerified,
  assertGatesCoverSliceScenarios,
  assertNoUnclaimedTargetDrift,
  assertNoUnresolvedVerification,
  assertPostAnchorEvidence,
  assertSharedPrerequisitesBuilt,
  assertSlicePassed,
  assertSliceStateConsistent,
  completeSliceAmendment,
  draftSliceAmendment,
  implementationDigests,
  inspectSliceArtifacts,
  legacyRelativePath,
  pendingTargetDriftCandidates,
  planSliceRework,
  portableRoot,
  readTargetBaseline,
  reconcileSliceState,
  renderTargetBaseline,
  REWORK_ROOT,
  reworkAttemptsOf,
  reworkLimitBlocker,
  reworkPathParts,
  settleFact,
  SLICE_AMENDMENT_ROOT,
  TARGET_DIRTY_SCOPE,
  targetBaselineDrift,
  targetRelativePath,
  TERMINAL_DESIGN_SYSTEM,
  unlistedSliceCandidates,
  validateSliceImplementation,
  validateSlicePlan,
} from "./slices/index.mjs";
// Compatibility re-export (Track A6): these names are visual-owned now.
export {
  assertRequiredObservations,
  compareVisualEvidence,
  compareVisualFact,
  figmaMetadataAncestry,
  LEGACY_AUTHORITY_ROLE,
  LEGACY_RUNTIME_EVIDENCE_ROOT,
  pendingVisualUnbackedCandidates,
  PROVISIONAL_VISUAL_DIFF_THRESHOLDS,
  sliceLacksUiProofV1,
  TARGET_VERIFICATION_ROLE,
  validateFigmaContext,
  validateLegacyRuntimeContext,
  validateVisualAcceptance,
  VISUAL_AUTHORITIES,
  VISUAL_UNBACKED_KIND,
  visualAuthorityOf,
} from "./visual/index.mjs";
// Compatibility re-export (Track A5): these names are census-owned now.
export {
  isBrownfield,
  legacySourceBinding,
  legacySourcesOf,
  readCanonicalModuleBoundary,
  sourceOfEvidence,
  UI_RUNTIME_STATES,
  validateDiscoveryCompleteness,
} from "./census/index.mjs";

// Compatibility re-export (Track A4): store-owned (A1), re-homed in A4.
export { REOPEN_ROOT } from "./store/index.mjs";
// Compatibility re-export (Track A4): these names are slices-owned now.
export {
  delegatedChangedFilesSatisfiedByChild,
  inspectSliceArtifacts,
  reconcileSliceState,
  renderTargetBaseline,
  REWORK_ROOT,
  reworkLimitBlocker,
  reworkPathParts,
  SLICE_AMENDMENT_ROOT,
  TARGET_DIRTY_SCOPE,
  unclaimedTargetDrift,
} from "./slices/index.mjs";

// Compatibility re-export (Track A3): these names are decisions-owned now.
export {
  attestationVerifierScope,
  attestedLineProblem,
  brandSequenceAuthorization,
  candidateDigestOf,
  createDecisionCandidate,
  createNewFormatDecisionCandidate,
  createNewFormatDecisionGroup,
  DECISION_GROUP_KIND,
  DECISION_PRINCIPALS,
  DECISION_RESULTS,
  decisionAppliesToCandidate,
  decisionChannelOf,
  decisionGroupFor,
  decisionKindAllowed,
  decisionLineDigest,
  decisionLineProblem,
  decisionPrincipalOf,
  decisionRationaleDigest,
  DEFAULT_DECISION_POLICY_DIGEST,
  DEFAULT_DECISION_POLICY_ID,
  edgeDecisionSubject,
  LATE_DECISION_KINDS,
  lifecycleBinding,
  principalSatisfiesRequirement,
  projectModuleDecision,
  rawDecisionLedgerBytes,
  rawDecisionLedgerDigest,
  readAutoDecisions,
  readOperatorDecisions,
  readRecordedDecisions,
  resolveApplicableDecision,
  resolveGroupDecision,
  resolveHistoricalRequiredPrincipal,
  resolveRequiredPrincipal,
  sequenceAuthorizationEvidence,
  validateProtectedDecisionPolicy,
} from "./decisions/index.mjs";
// Compatibility re-export (Track A2): these names are formats-owned now.
export {
  ARTIFACT_DELEGATION_FORMAT,
  assertDirectLedgerEligible,
  assertDiscoveryCompletenessFormat,
  assertNoPendingFormatUpgrade,
  AUTO_DECISIONS_FILE,
  CAPABILITY_OWNERSHIP_FILE,
  CAPABILITY_OWNERSHIP_FORMAT,
  DECISIONS_FILE,
  DESIGN_SOURCE_FORMAT,
  DIRECT_LEDGER_DECISIONS_FORMAT,
  DIRECT_LEDGER_PINNED_ARTIFACTS,
  directLedgerAdoptionPreview,
  DISCOVERY_COMPLETENESS_FORMAT,
  DISCOVERY_SCAN_FILE,
  EARLIEST_SUPPORTED_FORMAT,
  FIGMA_CONTEXT_ADOPTION_FILE,
  FIGMA_CONTEXT_FILE,
  FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
  FORMAT_UPGRADE_FLOOR,
  formatIsPromoting,
  formatIsSupported,
  isUiObservationsAdoption,
  LEGACY_COMPATIBILITY_ACTION_REQUIRED,
  LEGACY_MIGRATION_STEPS,
  LEGACY_RUNTIME_CONTEXT_FILE,
  LegacyCompatibilityActionRequired,
  MAX_SLICE_REWORKS,
  MIGRATION_FORMAT_SUPPORTED,
  MIGRATION_FORMAT_VERSION,
  MIGRATION_STEPS,
  MODULE_CLASSIFICATION_FILE,
  MULTI_SOURCE_FORMAT,
  NON_PROMOTING_FORMAT_VERSIONS,
  renderToolkitAdoption,
  REQUIRED_OBSERVATIONS_FORMAT,
  RESUMABLE_CONTRACT_VERSION,
  SLICE_REWORK_FORMAT,
  stampedFormatVersion,
  stepsFor,
  SUPPORTED_FORMAT_VERSIONS,
  TARGET_BASELINE_FILE,
  UI_OBSERVATIONS_ADOPTION_ROOT,
  UI_OBSERVATIONS_CANDIDATE_FILE,
  UI_PROOF_FORMAT,
  UI_REMEDIATION_FILE,
  UI_VERIFICATION_FORMAT,
  UPGRADABLE_CONTRACT_VERSION,
  UPGRADABLE_FORMAT_VERSION,
  usesArtifactDelegation,
  usesCapabilityOwnership,
  usesDesignSource,
  usesDirectLedgerDecisions,
  usesDiscoveryCompleteness,
  usesMultiSource,
  usesRequiredObservations,
  usesSliceRework,
  usesUiVerification,
  usesVisualAcceptance,
  VISUAL_ACCEPTANCE_FILE,
  VISUAL_ACCEPTANCE_FORMAT,
  WORKFLOW_VERSION,
} from "./formats/index.mjs";
// Compatibility re-export (Track A1): the record root now lives in store/.
export { migrationRoot } from "./store/index.mjs";

// Loaded only when a format-13 row delegates work. The artifact engine imports
// this module's facade for shared policy, so a static reverse import would put
// migration-policy in an ESM initialization cycle.
const artifactEngine = () =>
  import("./artifact/artifact-migration.mjs");

/**
 * Documented process exit code for "blocked, nothing was executed". A blocked
 * invocation used to exit 0, so in CI or any scripted driver a refused
 * migration was indistinguishable from a completed one. 1 stays the generic
 * failure code; 2 means the preflight refused and no file was touched.
 */
export const BLOCKED_EXIT_CODE = 2;

/**
 * What an absent `--mode` means. Both CLIs already treat it as `auto`
 * (`options.mode !== "step"`); naming it keeps the rendered checklist from
 * reporting `mode=none` for a run that is in fact autonomous.
 */
export const DEFAULT_MODE = "auto";

/**
 * The one canonical auto-decision policy, and the only definition of it.
 *
 * `auto` is a *principal*, not an exemption list. A process running under it is
 * the authority for every decision derivable from evidence the engine already
 * holds -- the preflight verdict, the confirmation ID the engine itself minted,
 * the slice plan, the decision ledger, the dirty manifest, the git revision,
 * `build-identity.json`. `step` hands that authority to a human.
 *
 * Nothing about integrity moves with it. Whichever principal answers, the
 * confirmation ID is still re-verified, the ledger line is still appended and
 * chained, and every digest that invalidates a stale decision still invalidates
 * it. This decides *who assents*, never *what is checked*.
 *
 * It lives here, beside `DEFAULT_MODE`, rather than in `migration-policy.mjs`
 * where it reads more naturally, because `migration-policy.mjs` imports from
 * this file and the gates that need the policy -- `operator-approval.mjs`,
 * `operation-sequence.mjs`, this module -- would otherwise close an import
 * cycle around it. `migration-policy.mjs` re-exports it, so front ends still
 * read the policy from the policy module.
 */
export const isAutoAuthority = (mode) => (mode ?? DEFAULT_MODE) !== "step";

/**
 * The last line of an iteration, and the only thing that decides whether
 * another one runs. The agent obeys it literally instead of inferring
 * continuation from prose -- which is what made autonomy model-volition
 * rather than contract. `STOP` always names a typed reason.
 *
 * A two-branch formatter over the closed outcome set (`02` D2-5): the member
 * *is* the `reason=` token, so `CONTINUE` prints the continue line and every
 * other outcome prints itself. Bytes are unchanged for every input.
 *
 * Empty under `--mode step`: there is no loop to drive there, the operator
 * confirms every iteration by hand, and the two-phase prompt is the last thing
 * that run is allowed to say.
 */
/**
 * The one loop-directive renderer. `next` exists so a second front end can
 * name its own continuation command instead of copying this function -- the
 * artifact CLI carried its own copy and could emit `loop: STOP reason=CONTINUE`,
 * a token outside the closed stop set, at the one place the protocol forbids a
 * provider to improvise. One function, two callers.
 *
 * `outcome` must already be a member of `MIGRATION_OUTCOMES`; `exitCodeFor` is
 * total over that set and throws on anything else, so an invented seventh value
 * cannot reach a directive line.
 */
export const renderLoopDirective = ({
  moduleName,
  mode,
  outcome,
  next = `/start-migration ${moduleName}`,
}) =>
  mode === "step"
    ? ""
    : // A committed increment ends its invocation but not the run: the driver
      // must start a *new* normal invocation with no agent decision in
      // between, which is what CONTINUE means and STOP does not. It continues
      // through the *same* `next` as CONTINUE -- `next=` names a command the
      // front end can actually execute, so a symbolic token there would be a
      // line the driver cannot obey.
      outcome === "CONTINUE" || outcome === "FORMAT_UPGRADED"
      ? `loop: CONTINUE next=${next}\n`
      : `loop: STOP reason=${outcome}\n`;

export const upgradeCommandFor = (moduleName) =>
  engineCommand("upgrades/upgrade-migration.mjs", moduleName);

// Formats classifies and validates; the one rendered command in its refusal
// is bound here (baseline §4.1), so the bytes are unchanged.
export const compatibilityBlocker = (state, moduleName) =>
  recordCompatibilityBlocker(state, moduleName, upgradeCommandFor);
const validateStateShape = (state, moduleName) =>
  validateRecordStateShape(state, moduleName, upgradeCommandFor);

export const FINAL_GATES = [
  "ARCHITECTURE_PLAN_GATE",
  "TARGETED_VERIFY",
  "FUNCTIONAL_PARITY_GATE",
  "SIMPLIFY_ONCE",
  "ARCHITECTURE_IMPLEMENTATION_GATE",
  "PRECOMMIT_GATE",
  "FINAL_VERIFY",
];

const TERMINAL_PARITY = new Set([
  "VERIFIED",
  "REDESIGNED_VERIFIED",
  "EXCLUDED_APPROVED",
  "DEAD_CONFIRMED",
  // Format 15: proven by a pre-existing target implementation plus a bound,
  // scenario-covering test run (`validateAdoptedRow`). Never authorable without
  // that evidence, which is what separates it from the unearned `VERIFIED` the
  // closed enum below now refuses.
  "ADOPTED_VERIFIED",
]);

/**
 * `verificationStatus` was never enum-checked: any string outside
 * `TERMINAL_PARITY` read as "not terminal" and any string inside it read as
 * proven. `PENDING` is the one documented non-terminal value
 * (`references/migration-contract.md`), so the vocabulary is closed to it plus
 * the terminal set.
 */
const PARITY_STATUSES = new Set(["PENDING", ...TERMINAL_PARITY]);

/**
 * The two statuses only a verified slice can produce. Authoring one before any
 * slice has been verified is "the code already exists" accepted as parity --
 * the row silently leaves planning, implementation, verification, and FINALIZE
 * in a single edit. `ADOPTED_VERIFIED` is the sanctioned way to say that, and
 * it costs real evidence.
 */
const SLICE_EARNED_PARITY = new Set(["VERIFIED", "REDESIGNED_VERIFIED"]);

const BEHAVIOR_DISPOSITIONS = {
  ABSENT: "IMPLEMENT",
  PLACEHOLDER: "UPDATE",
  PARTIAL: "UPDATE",
  INCOMPATIBLE: "REDESIGN_IN_TARGET",
  // One vocabulary at both altitudes: this key used to be
  // `MATCHED_UNVERIFIED`, which meant a row could not carry the `TARGET_STATES`
  // value describing exactly the same judgement. No alias: the old key appears
  // in zero persisted artifacts, so an alias would guard a case that cannot
  // exist.
  IMPLEMENTED_UNVERIFIED: "NO_CHANGE_REQUIRED",
};

/**
 * Capability ownership: the same strict classification-to-disposition mapping
 * `BEHAVIOR_DISPOSITIONS` uses, so a row cannot claim one judgement and record
 * the action of another.
 */
const CAPABILITY_DISPOSITIONS = {
  TARGET_REUSE: "REUSE_EXISTING",
  SHARED_PREREQUISITE: "CREATE_SHARED",
  FEATURE_LOCAL: "CREATE_FEATURE_LOCAL",
  DO_NOT_MIGRATE: "NONE",
};

/** The minimum number of *other* consumers that proves a capability is shared. */
const SHARED_CONSUMER_THRESHOLD = 2;

export const ADOPTION_ROOT = "visual-contract-adoption";

export const STEP_DEPENDENCIES = {
  RESOLVE: ["steps/01-resolve.md"],
  DISCOVER_LEGACY: ["steps/02-discover-legacy.md", "inventories/legacy.json"],
  DISCOVERY_COMPLETENESS: [
    "steps/02a-discovery-completeness.md",
    MODULE_CLASSIFICATION_FILE,
    "inventories/legacy.json",
  ],
  ASSESS_TARGET: ["steps/03-assess-target.md", "inventories/target.json"],
  BUILD_BASELINE: [
    "steps/04-build-baseline.md",
    "matrices/behavior-parity.json",
    "matrices/route-adaptation.json",
    "matrices/target-native.json",
    "matrices/design-system-usage.json",
    CAPABILITY_OWNERSHIP_FILE,
  ],
  PLAN: ["steps/05-plan.md", "slices/index.json"],
  IMPLEMENT_SLICES: ["steps/06-implement-slices.md"],
  VERIFY_SLICES: ["steps/07-verify-slices.md"],
  FINALIZE: ["steps/08-finalize.md", "gates.json"],
};

/**
 * P2-2: `artifactHashes` pinned no `matrices/` entry, so after BUILD_BASELINE
 * closed, a behavior-parity row's `legacyEvidence` could be rewritten to
 * anything and FINALIZE still reported no blockers. Pinning the file itself is
 * wrong -- `verificationStatus` is meant to move as slices get verified -- so
 * this pins a digest of the immutable projection only. It is a derived pin,
 * not a file: it is keyed by a path that cannot exist, and `pinnedSourcePath`
 * maps it back to the matrix it is derived from.
 */
export const BASELINE_ROWS_PIN = "matrices/behavior-parity.json#immutable-rows";
const IMMUTABLE_BEHAVIOR_ROW_FIELDS = [
  "id",
  "behaviorId",
  "targetState",
  "legacyEvidence",
];

/**
 * The discovery digest, pinned the same derived way: the scan file records
 * timestamps and a machine-generated body that is regenerated on every
 * validation, so pinning the file itself would fail on a re-run that found
 * exactly the same facts. Only the digest is authority.
 */
export const DISCOVERY_PIN = `${DISCOVERY_SCAN_FILE}#discovery`;

const IMMUTABLE_STEP_ARTIFACTS = {
  // The target baseline is pinned only for a brownfield record; filtered out
  // otherwise in `completedArtifactHashes`, exactly like the Figma context.
  RESOLVE: ["steps/01-resolve.md", TARGET_BASELINE_FILE],
  DISCOVER_LEGACY: ["steps/02-discover-legacy.md", "inventories/legacy.json"],
  DISCOVERY_COMPLETENESS: [
    "steps/02a-discovery-completeness.md",
    MODULE_CLASSIFICATION_FILE,
    DISCOVERY_PIN,
  ],
  ASSESS_TARGET: [
    "steps/03-assess-target.md",
    "inventories/target.json",
    // Pinned only for a figma-mcp record; filtered out otherwise in
    // `completedArtifactHashes`, exactly like the capability matrix.
    FIGMA_CONTEXT_FILE,
    // The same slot for the other authority: pinned only for a legacy-runtime
    // record, immutable from here on by `validateCompletedHashes`.
    LEGACY_RUNTIME_CONTEXT_FILE,
  ],
  // The capability matrix carries no mutable field -- slice assignment lives in
  // slices/index.json, not here -- so unlike behavior-parity it is pinned as a
  // plain file and needs no derived `#immutable-rows` projection.
  BUILD_BASELINE: [
    "steps/04-build-baseline.md",
    BASELINE_ROWS_PIN,
    CAPABILITY_OWNERSHIP_FILE,
    // Pinned only for a format-17 figma-mcp record.
    VISUAL_ACCEPTANCE_FILE,
  ],
  PLAN: ["steps/05-plan.md", "slices/index.json"],
  IMPLEMENT_SLICES: [],
  VERIFY_SLICES: [],
  FINALIZE: ["steps/08-finalize.md", "gates.json"],
};

/**
 * Derived pins: a key that is not a file, mapped back to the file it is
 * computed from plus the projection that computes it. Everything else is a
 * plain file hash.
 */
const DERIVED_PINS = {
  [BASELINE_ROWS_PIN]: {
    source: "matrices/behavior-parity.json",
    digest: async (root, source) => {
      const matrix = assertPlainObject(
        await readJson(source, "behavior parity"),
        "behavior parity",
      );
      const rows = assertArray(matrix.rows, "behavior parity rows")
        .map((row) =>
          IMMUTABLE_BEHAVIOR_ROW_FIELDS.map((field) => row?.[field] ?? null),
        )
        .sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1));
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    },
  },
  [DISCOVERY_PIN]: {
    source: DISCOVERY_SCAN_FILE,
    digest: async (root, source) => {
      const scan = assertPlainObject(
        await readJson(source, "Discovery scan"),
        "Discovery scan",
      );
      const discoveryDigest = assertNonEmpty(
        scan.discoveryDigest,
        "Discovery scan discoveryDigest",
      );
      // Pins written before raw decision-ledger binding keep their historical
      // bytes. New pins bind the exact NDJSON bytes, including whitespace and
      // the terminal newline, so a semantically equivalent rewrite is still a
      // rewrite of the immutable operator record.
      if (scan.decisionLedgerDigest === undefined) {
        return createHash("sha256").update(discoveryDigest).digest("hex");
      }
      // The pin froze the whole file, which made every classification approval
      // immutable after the census closed -- correct -- but also made it
      // impossible to record any *later* operator act. The lifecycle genuinely
      // has one: an unclaimed-target-drift acceptance can only be known at
      // VERIFY_SLICES or FINALIZE, long after this checkpoint.
      //
      // So the pin now covers the prefix, exactly as the history anchor does,
      // and anything appended past it must be a decision kind that is legal to
      // record late. A classification approval added after the fact is still
      // refused; a drift acceptance is not.
      const ledgerPath = path.join(root, DECISIONS_FILE);
      const bytes = (await fileExists(ledgerPath))
        ? await readFile(ledgerPath)
        : Buffer.alloc(0);
      const pinnedLength = scan.decisionLedgerBytes;
      const actualLedgerDigest = `sha256:${hashContent(bytes)}`;
      if (scan.decisionLedgerDigest !== actualLedgerDigest) {
        if (
          !Number.isInteger(pinnedLength) ||
          bytes.length < pinnedLength ||
          `sha256:${hashContent(bytes.subarray(0, pinnedLength))}` !==
            scan.decisionLedgerDigest
        ) {
          throw new Error(
            `${DECISIONS_FILE} bytes changed after DISCOVERY_COMPLETENESS closed: recorded ${scan.decisionLedgerDigest}, actual ${actualLedgerDigest}. The operator decision record is append-only; an existing approval was rewritten or removed.`,
          );
        }
        assertLateDecisionsAreAppendable(bytes.subarray(pinnedLength));
      }
      return createHash("sha256")
        .update(
          JSON.stringify({
            discoveryDigest,
            decisionLedgerDigest: scan.decisionLedgerDigest,
          }),
        )
        .digest("hex");
    },
  },
};

/** The file a pinned key is derived from; for a real path, itself. */
const pinnedSourcePath = (root, relativePath) =>
  path.join(root, DERIVED_PINS[relativePath]?.source ?? relativePath);

/**
 * Digest of a pinned key. For `BASELINE_ROWS_PIN` that is every
 * behavior-parity row's immutable fields (P2-2), sorted by id -- ids are
 * already unique-validated, so reordering the file carries no meaning and must
 * not break the pin -- with every other field, `verificationStatus` above all,
 * deliberately excluded. For `DISCOVERY_PIN` it is the recorded discovery
 * digest and nothing else.
 */
const hashPinnedArtifact = async (root, relativePath) => {
  const derived = DERIVED_PINS[relativePath];
  if (derived) return derived.digest(root, pinnedSourcePath(root, relativePath));
  return fileIdentity(path.join(root, relativePath), {
    bytes: isBytePinned(relativePath),
  });
};

/**
 * Preserved evidence is the record of something that actually happened, and it
 * stays byte-sensitive: its pin is never satisfied by a re-spelled equivalent,
 * only by the original bytes. `stale-ui-evidence/` and `slice-amendments/` are
 * preserved roots older records already carry; this engine writes neither, and
 * refusing to re-spell them is the whole point of naming them here.
 */
const isBytePinned = (relativePath) =>
  reworkPathParts(relativePath) !== null ||
  relativePath.startsWith(`${REOPEN_ROOT}/`) ||
  relativePath.startsWith(`${ADOPTION_ROOT}/`) ||
  relativePath.startsWith(`${UI_OBSERVATIONS_ADOPTION_ROOT}/`) ||
  relativePath.startsWith("stale-ui-evidence/") ||
  relativePath.startsWith("slice-amendments/");

/**
 * Whether the recorded pin still identifies the artifact. Derived pins keep
 * their own projection and compare exactly; ordinary file pins go through the
 * shared identity matcher, which accepts the legacy untagged spellings and the
 * bounded EOL candidates without rewriting anything.
 */
const pinnedArtifactMatches = async (root, relativePath, expected) => {
  const derived = DERIVED_PINS[relativePath];
  if (derived) {
    return (
      (await derived.digest(root, pinnedSourcePath(root, relativePath))) ===
      expected
    );
  }
  return fileIdentityMatches(expected, path.join(root, relativePath), {
    bytes: isBytePinned(relativePath),
  });
};

/**
 * W6-2. `integrity.json` pinned `artifactHashes` and history but not the
 * decision ledger, so truncating `decisions/operator-decisions.ndjson` removed
 * approvals without tripping anything -- and approvals are the highest-value
 * lines in the record. Same prefix-hash shape as the history anchor, for the
 * same reason: it also catches an interior line rewritten in place, which a
 * length plus a last-line digest would not.
 */
const decisionsAnchorNow = async (root) => {
  const file = path.join(root, DECISIONS_FILE);
  return historyAnchorOf(
    (await fileExists(file)) ? await readFile(file) : Buffer.alloc(0),
  );
};

/**
 * The AUTO ledger gets the identical anchor, because it carries the identical
 * risk: an unattended decision that can be deleted afterwards is not a record
 * of anything. `null` when the file does not exist, so a record that never ran
 * under `--mode auto` writes no field at all.
 */
const autoDecisionsAnchorNow = async (root) => {
  const file = path.join(root, AUTO_DECISIONS_FILE);
  return (await fileExists(file))
    ? historyAnchorOf(await readFile(file))
    : null;
};

/**
 * One definition site for what an integrity anchor covers. Every transition
 * computes every anchor at the same instant -- immediately before the state
 * write and therefore before its own history append -- so a caller cannot
 * accidentally anchor one and forget another.
 */
const renderIntegrityNow = async (root, state, event) => {
  const historyChain = await prepareHistoryEvent(root, event);
  return renderIntegrity(
    state,
    await historyAnchorNow(root),
    await decisionsAnchorNow(root),
    await autoDecisionsAnchorNow(root),
    historyChain,
  );
};

/**
 * Cross-checks `state.artifactHashes` against the anchor written outside it.
 * A format-4 tree (created before this fix) has no anchor yet and is not
 * blocked for it; the next advance writes one. Once an anchor exists, it must
 * agree, so pruning or rewriting a pin in `state.json` alone -- without also
 * forging the independently-written anchor -- is refused.
 */
const assertIntegrityAnchor = async (root, state) => {
  const integrity = await readIntegrity(root);
  if (!integrity) {
    if (usesIntegrityAnchor(state)) {
      throw new Error(
        "Migration integrity.json is missing for a migration recorded at the current format version. Restore it before continuing.",
      );
    }
    return;
  }
  if (integrity.corrupt) {
    throw new Error(
      "Migration integrity.json is not valid JSON. Restore it before continuing.",
    );
  }
  if (integrity.revision !== state.revision) {
    // A journalled transition that died between the integrity write and the
    // state write leaves exactly this disagreement, and `recoverPendingAdvance`
    // repairs it deterministically. Accusing the operator of hand-editing
    // `state.json` was both wrong and a dead end: every read path runs this
    // check, so the record could not be opened by any command, and the one
    // function that could have fixed it was unreachable.
    const journal = await readAdvanceJournal(root);
    if (
      journal &&
      !journal.corrupt &&
      journal.fromRevision === state.revision &&
      journal.toRevision === integrity.revision
    ) {
      throw Object.assign(
        new Error(
          `Migration has an interrupted checkpoint transition from revision ${journal.fromRevision} to ${journal.toRevision}. Nothing is wrong with the record: resume it with '/start-migration <module>' (or 'discover-module.mjs <module>'), which recovers under the module lock before doing anything else.`,
        ),
        { pendingTransaction: true },
      );
    }
    throw new Error(
      `Migration state revision is '${state.revision}', but integrity.json -- written outside state.json in the same transaction -- must pin exactly revision '${integrity.revision}'. state.json was edited outside the workflow; reopen the responsible checkpoint instead.`,
    );
  }
  if (
    digestArtifactHashes(state.artifactHashes) !==
    integrity.artifactHashesSha256
  ) {
    throw new Error(
      "Migration artifactHashes must pin exactly what integrity.json's independently-written anchor recorded. state.json was edited outside the workflow; reopen the responsible checkpoint instead.",
    );
  }
  // Same anchor, same reason: swapping state.json's pinned toolkit identity
  // without also forging the independently-written anchor is refused.
  if (
    (integrity.toolkitIdentitySha256 ?? null) !==
    digestToolkitIdentity(state.toolkitIdentity)
  ) {
    throw new Error(
      "Migration state toolkitIdentity must pin exactly what integrity.json's independently-written anchor recorded. state.json was edited outside the workflow; perform an explicit toolkit identity operation instead.",
    );
  }
  await assertHistoryAppendOnly(root, state, integrity.history);
  await assertDecisionsAppendOnly(root, DECISIONS_FILE, integrity.decisions);
  await assertDecisionsAppendOnly(
    root,
    AUTO_DECISIONS_FILE,
    integrity.autoDecisions,
  );
};

/**
 * W6-2. The decision ledger may only ever have grown since the anchor was
 * written. A record created before the anchor existed carries none and is not
 * blocked for it; the next transition writes one. Once an anchor exists,
 * truncating or rewriting an approval is refused here rather than silently
 * accepted -- `readOperatorDecisions` already re-derives the `prevDigest`
 * chain, but a chain re-derived over a *truncated* file is internally
 * consistent and says nothing about the lines that were removed.
 */
const assertDecisionsAppendOnly = async (root, relativePath, anchor) => {
  if (!anchor) return;
  const file = path.join(root, relativePath);
  const content = (await fileExists(file)) ? await readFile(file) : Buffer.alloc(0);
  if (
    content.length < anchor.bytes ||
    historyAnchorOf(content.subarray(0, anchor.bytes)).sha256 !== anchor.sha256
  ) {
    throw new Error(
      `Migration ${relativePath} must still contain, unchanged, the ${anchor.bytes} bytes integrity.json pinned outside it; the ${relativePath === AUTO_DECISIONS_FILE ? "AUTO" : "operator"} decision ledger is append-only and every checkpoint that cites an approval is anchored to it. It was truncated or rewritten; restore it before continuing.`,
    );
  }
};

/**
 * The audit record may only ever have grown since the anchor was written. A
 * tree recorded before format 9 has no history anchor and is not blocked for
 * it; the next advance writes one.
 */
const assertHistoryAppendOnly = async (root, state, anchor) => {
  if (!anchor) {
    if (usesIntegrityAnchor(state)) {
      throw new Error(
        "Migration integrity.json pins no history anchor for a migration recorded at the current format version. Restore it before continuing.",
      );
    }
    return;
  }
  const file = path.join(root, initialArtifacts.history);
  const content = (await fileExists(file))
    ? await readFile(file)
    : Buffer.alloc(0);
  if (
    content.length < anchor.bytes ||
    historyAnchorOf(content.subarray(0, anchor.bytes)).sha256 !== anchor.sha256
  ) {
    throw new Error(
      `Migration history/history.ndjson must still contain, unchanged, the ${anchor.bytes} bytes integrity.json pinned outside it; it is append-only and is the audit record every other check is anchored to. It was truncated or rewritten; restore it before continuing.`,
    );
  }
  assertUnanchoredHistoryTail(state, content.subarray(anchor.bytes));
};

/**
 * What RESOLVE pins, for whatever this record is: the step document always, and
 * the target baseline when the record adopted an existing implementation.
 */
const resolveStepPins = (state) =>
  IMMUTABLE_STEP_ARTIFACTS.RESOLVE.filter(
    (relative) => relative !== TARGET_BASELINE_FILE || isBrownfield(state),
  );

/** The exact brief bytes the preview authorizes, not just its path. */
const briefDigestFor = async (targetRoot, brief) => {
  const absolute = path.resolve(targetRoot, brief);
  if (!isWithin(targetRoot, absolute)) return "OUTSIDE_TARGET";
  try {
    return `sha256:${hashContent(await readFile(absolute, "utf8"))}`;
  } catch {
    return "MISSING";
  }
};

const OPEN_SPEC_REQUIREMENT =
  /^### Requirement: ([A-Z][A-Z0-9]*-REQ-\d{3,})(?:\s+.+)?$/;
const OPEN_SPEC_SCENARIO =
  /^#### Scenario: ([A-Z][A-Z0-9]*-SCN-\d{3,})(?:\s+.+)?$/;

const parseOpenSpec = (content, source) => {
  const requirementIds = [];
  const scenarioIds = [];
  const seen = new Set();
  let current = null;

  const finishRequirement = () => {
    if (!current) return;
    if (!current.normative) {
      throw new Error(
        `OpenSpec requirement '${current.id}' in ${source} must use SHALL or MUST.`,
      );
    }
    if (current.scenarios === 0) {
      throw new Error(
        `OpenSpec requirement '${current.id}' in ${source} requires a scenario.`,
      );
    }
  };

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("### Requirement:")) {
      finishRequirement();
      const match = line.match(OPEN_SPEC_REQUIREMENT);
      if (!match) {
        throw new Error(
          `OpenSpec requirement headings in ${source} must start with a stable <CAPABILITY>-REQ-<NNN> id.`,
        );
      }
      const id = match[1];
      if (seen.has(id)) throw new Error(`OpenSpec repeats id '${id}'.`);
      seen.add(id);
      requirementIds.push(id);
      current = { id, normative: false, scenarios: 0 };
      continue;
    }
    if (line.startsWith("#### Scenario:")) {
      if (!current) {
        throw new Error(`OpenSpec scenario in ${source} has no requirement.`);
      }
      const match = line.match(OPEN_SPEC_SCENARIO);
      if (!match) {
        throw new Error(
          `OpenSpec scenario headings in ${source} must start with a stable <CAPABILITY>-SCN-<NNN> id.`,
        );
      }
      const id = match[1];
      if (seen.has(id)) throw new Error(`OpenSpec repeats id '${id}'.`);
      seen.add(id);
      scenarioIds.push(id);
      current.scenarios += 1;
      continue;
    }
    if (current && /\b(?:SHALL|MUST)\b/.test(line)) {
      current.normative = true;
    }
  }
  finishRequirement();
  if (requirementIds.length === 0) {
    throw new Error(
      `OpenSpec source ${source} requires at least one requirement.`,
    );
  }
  return { requirementIds, scenarioIds };
};

export const loadOpenSpecAuthority = async (targetRoot, targetModule) => {
  const source = requirementsSourceFor(targetModule);
  const filePath = path.resolve(targetRoot, source);
  if (!isWithin(targetRoot, filePath)) {
    throw new Error("Requirements source escapes the target repository.");
  }
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Required OpenSpec source does not exist: ${source}`);
    }
    throw error;
  }
  return {
    kind: "openspec",
    source,
    digest: contentIdentity(source, content),
    ...parseOpenSpec(content, source),
  };
};

export const validateOpenSpecProposal = (content, targetModule) => {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The in-memory OpenSpec proposal must be non-empty.");
  }
  const source = requirementsSourceFor(targetModule);
  return {
    content,
    authority: {
      kind: "openspec",
      source,
      digest: contentIdentity(source, content),
      ...parseOpenSpec(content, source),
    },
  };
};

const assertCurrentOpenSpecAuthority = async (targetRoot, state) => {
  const recorded = validateOpenSpecAuthorityShape(
    state.requirementsAuthority,
    state.targetModule,
  );
  const current = await loadOpenSpecAuthority(targetRoot, state.targetModule);
  // The digest is a file identity, so a checkout that only re-spelled the
  // spec's line endings is not a changed authority. Verify that one field
  // through the shared matcher and, when it still holds, carry the *recorded*
  // digest into the comparison projection -- every other field is compared
  // exactly as before, and the record on disk is left untouched. This also
  // keeps every `boundTo.requirementsDigest` in existing evidence valid,
  // since it was bound to that recorded spelling.
  const comparable =
    recorded.digest !== current.digest &&
    (await contentIdentityMatchesSource(
      recorded.digest,
      targetRoot,
      current.source,
    ))
      ? { ...current, digest: recorded.digest }
      : current;
  if (JSON.stringify(recorded) !== JSON.stringify(comparable)) {
    throw new Error(
      `OpenSpec authority changed for '${state.targetModule}'. Revalidate requirements before resuming.`,
    );
  }
  return comparable;
};

// A `<module>.md` sibling is a retired contract-2/3 checklist. Contract 2 and 3
// are unsupported: refuse to bootstrap over one and leave the file untouched.
const legacyChecklistBlocker = async (targetRoot, moduleName) =>
  (await fileExists(
    path.join(
      targetRoot,
      ".agents/knowledge/migrations/modules",
      `${moduleName}.md`,
    ),
  ))
    ? `Unsupported legacy migration workflow: '.agents/knowledge/migrations/modules/${moduleName}.md' is a retired contract-2 or contract-3 checklist. Those workflows are never parsed, converted, moved, or deleted. The file was left untouched and no migration was bootstrapped over it.`
    : null;

export const activeArtifact = (state) =>
  state.currentStep === "COMPLETE"
    ? null
    : state.currentStep === "IMPLEMENT_SLICES" && state.activeSlice
      ? `slices/${state.activeSlice}.json`
      : state.currentStep === "VERIFY_SLICES" && state.activeSlice
        ? `evidence/${state.activeSlice}/result.json`
        : state.artifacts.steps[state.currentStep];

export const expectedNextCheckpoint = (state) => {
  if (state.currentStep === "COMPLETE") return "COMPLETE";
  if (state.currentStep === "IMPLEMENT_SLICES") return "VERIFY_SLICES";
  if (state.currentStep === "VERIFY_SLICES") {
    return state.pendingSlices.some((sliceId) => sliceId !== state.activeSlice)
      ? "IMPLEMENT_SLICES"
      : "FINALIZE";
  }
  if (state.currentStep === "FINALIZE") return "COMPLETE";
  const steps = stepsFor(state);
  const index = steps.indexOf(state.currentStep);
  return steps[index + 1] ?? "COMPLETE";
};

export const checkpointArtifacts = (state) => {
  if (state.currentStep === "COMPLETE") {
    return [
      "state.json",
      "steps/08-finalize.md",
      "gates.json",
      "matrices/*.json",
    ];
  }
  if (state.currentStep === "IMPLEMENT_SLICES" && state.activeSlice) {
    return [
      "steps/06-implement-slices.md",
      "steps/05-plan.md",
      "slices/index.json",
      `slices/${state.activeSlice}.json`,
      "assigned target files",
    ];
  }
  if (state.currentStep === "VERIFY_SLICES" && state.activeSlice) {
    return [
      "steps/07-verify-slices.md",
      `slices/${state.activeSlice}.json`,
      `evidence/${state.activeSlice}/result.json`,
      "changed target files and focused tests",
    ];
  }
  return [...(STEP_DEPENDENCIES[state.currentStep] ?? [])];
};

export const checkpointAction = (state) => {
  if (state.currentStep === "COMPLETE") {
    return "Revalidate the completed migration";
  }
  if (state.currentStep === "IMPLEMENT_SLICES" && state.activeSlice) {
    return `Implement slice ${state.activeSlice}`;
  }
  if (state.currentStep === "VERIFY_SLICES" && state.activeSlice) {
    return `Verify slice ${state.activeSlice}`;
  }
  if (state.currentStep === "FINALIZE") {
    return "Finalize the migration and run the seven gates";
  }
  if (state.currentStep === "DISCOVERY_COMPLETENESS") {
    return "Classify every file in the module census";
  }
  return `Execute checkpoint ${state.currentStep}`;
};

/**
 * What the agent is being asked to author at this checkpoint, as a value
 * (`02` D2-6). Composed on read from the navigation readers above and never
 * persisted, so it carries no format of its own and cannot drift from state.
 *
 * `lifecycle` comes from `stepsFor`, so a record born before format 10 is
 * described with its own eight-checkpoint lifecycle rather than the nine this
 * build ships. `state.nextAction` keeps its field and its prose; it is one
 * rendering of this request, no longer the only expression of it.
 */
export const authoringRequest = (state) => ({
  step: state.currentStep,
  slice: state.activeSlice ?? null,
  artifacts: checkpointArtifacts(state),
  primaryArtifact: activeArtifact(state),
  dependencies: [...(STEP_DEPENDENCIES[state.currentStep] ?? [])],
  summary: checkpointAction(state),
  expectedNextCheckpoint: expectedNextCheckpoint(state),
  schemaRef: `references/migration-contract.md#${state.currentStep}`,
  lifecycle: [...stepsFor(state)],
});

const confirmationIdFor = (snapshot) =>
  createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex")
    .slice(0, 16);

const resumeGuidance = (state) => {
  const activeSlice =
    ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE", "COMPLETE"].includes(
      state.currentStep,
    ) && state.activeSlice;
  return {
    resumed: state.status === "ACTIVE",
    resumeMode: activeSlice ? "ACTIVE_SLICE" : "CHECKPOINT",
    resumeReason: activeSlice
      ? `Continue the persisted ${state.currentStep} slice '${activeSlice}'. A session or model interruption does not require --refresh.`
      : `Continue the persisted ${state.currentStep} checkpoint. A session or model interruption does not require --refresh.`,
  };
};

const renderStep = ({
  number,
  name,
  purpose,
  dependencies,
  requirements,
  status = "PENDING",
}) => `# ${number}. ${name}

- Status: \`${status}\`
- Contract version: \`${RESUMABLE_CONTRACT_VERSION}\`
- Format version: \`${MIGRATION_FORMAT_VERSION}\`
- Purpose: ${purpose}
- Dependencies: ${dependencies}

## Required evidence

${requirements.map((requirement) => `- [TODO] ${requirement}`).join("\n")}

## Decisions

- [TODO] Record decisions that affect scope, behavior, routes, architecture, or verification.

## Result

- [TODO] Summarize the validated result of this checkpoint.
`;

const stepTemplates = ({ designSource, figmaSources } = {}) => ({
  "steps/02-discover-legacy.md": renderStep({
    number: "02",
    name: "Discover legacy",
    purpose:
      "Inventory the complete observable legacy behavior and route flow without selecting a target implementation.",
    dependencies: "`steps/01-resolve.md`",
    requirements: [
      "Pages, routes, list/detail surfaces, transitions, back/close flows, redirects, permissions, actions, states, APIs, events, errors, and edge cases.",
      "Every behavior and route-flow has a stable ID and concrete evidence in `inventories/legacy.json`.",
      "Independent list and detail views are recorded as separate surfaces when the legacy flow exposes them independently.",
    ],
  }),
  "steps/02a-discovery-completeness.md": renderStep({
    number: "02a",
    name: "Discovery completeness",
    purpose:
      "Prove that every file the module owns, and every reference it makes, is accounted for -- not just the files the inventory happened to mention.",
    dependencies: "`steps/02-discover-legacy.md`, `inventories/legacy.json`",
    requirements: [
      "`moduleRoots` declares the roots that physically own the module; the census under them is authoritative and no import graph can shrink it.",
      "Every census file has exactly one row in `inventories/module-classification.json` with a closed-enum `disposition`, including files nothing imports.",
      "A production-reachable component, style, image, SVG, or other visual asset is BEHAVIOR_BACKED or approved for exclusion by an operator decision; agent-authored rationale alone never dismisses one.",
      "Every SUPPORTING file outside the roots records `requiredBy`, every unresolved first-party reference is resolved, and every blocking finding carries an EDGE_RESOLUTION decision.",
    ],
  }),
  "steps/03-assess-target.md": renderStep({
    number: "03",
    name: "Assess target",
    purpose:
      "Inspect the existing target independently and classify gaps without assuming that existing code is migrated.",
    dependencies: "`steps/02-discover-legacy.md`, `inventories/legacy.json`",
    requirements: [
      "Target state is ABSENT, PLACEHOLDER, PARTIAL, INCOMPATIBLE, or IMPLEMENTED_UNVERIFIED.",
      "Routes, list/detail surfaces, state ownership, permissions, integrations, UX states, tests, and target-native behavior are inventoried.",
      "Every visible control records the target design-system authority, expected component or pattern, actual source, and any approved exception.",
      // The only checkpoint that reaches the Figma MCP. Written into the
      // artifact itself, not just into SKILL.md, so the obligation is visible
      // to whoever opens the step -- and so it names this record's own links.
      ...(designSource === "figma-mcp"
        ? [
            `Read the \`figmaSources\` recorded in \`state.json\` (${(
              figmaSources ?? []
            )
              .map((source) => `\`${source.raw}\``)
              .join(
                ", ",
              )}) through the Figma MCP, and author \`${FIGMA_CONTEXT_FILE}\` as a JSON object with a non-empty \`frames\` array whose every entry names the \`fileKey\` it was read from. Figma is authoritative for visual/UX intent only; legacy stays authoritative for behavior.`,
            `Every frame records \`nodeId\` (a recorded link, or a concrete descendant of a recorded node link with \`ancestry\` \`{ sourceNodeId, path, metadata }\`: \`path\` from the source to the node and \`metadata\` the verbatim \`get_metadata\` output of the source node persisted as \`{ reference, hash }\`),\`name\`, \`type\`, \`viewport\`, \`states\`, \`extraction\` (\`retrievedAt\`, \`fidelity\` COMPLETE or DEGRADED with its \`limitations\`), and \`sources\`: the verbatim \`get_metadata\`, \`get_design_context\` (split over child nodes when too large), \`get_variable_defs\` and \`get_screenshot\` outputs persisted under \`inventories/figma/\`, each as \`{ reference, hash }\`. Never replace them with a summary.`,
          ]
        : []),
      // The other authority: captured from the running legacy app, never read
      // from legacy source, and pinned here for the migration's whole life.
      ...(designSource === "legacy-runtime"
        ? [
            `Capture every required legacy UI behavior state from the running legacy app and author \`${LEGACY_RUNTIME_CONTEXT_FILE}\` as a JSON object with a non-empty \`frames\` array. Each frame records \`id\` (\`<uiBehaviorId>::<state>\`), \`uiBehaviorId\`, \`state\`, \`states\`, \`viewport\`, \`url\`, \`rootLocator\`, this record's pinned \`legacyRevision\`, \`capture\` (\`role\` \`${LEGACY_AUTHORITY_ROLE}\`, \`mode\` \`element\`, \`deviceScaleFactor\` 1, \`compare\` {width, height}), \`extraction\` (\`retrievedAt\`, \`fidelity\` COMPLETE or DEGRADED with its \`limitations\`), and \`sources\`: the element screenshot, the \`${UI_PROOF_FORMAT}\` accessibility snapshot and the \`{viewport, values}\` measurements, persisted under \`${LEGACY_RUNTIME_EVIDENCE_ROOT}\` as \`{ reference, hash }\`. The legacy runtime is authoritative for visual appearance only; legacy code and UI structure are never an implementation authority.`,
          ]
        : []),
    ],
  }),
  "steps/04-build-baseline.md": renderStep({
    number: "04",
    name: "Build baseline",
    purpose:
      "Freeze the approved functional scope, navigation adaptations, design-system gaps, acceptance criteria, and exclusions.",
    dependencies: "`inventories/legacy.json`, `inventories/target.json`",
    requirements: [
      "Every legacy behavior maps to one row in `matrices/behavior-parity.json`.",
      "Every legacy route flow maps to one row in `matrices/route-adaptation.json`.",
      "Merging independent list and detail surfaces is a gap unless `REDESIGNED_APPROVED` includes approval and acceptance evidence.",
      "Ignoring an available target-required design-system component is a `DESIGN_SYSTEM_GAP` unless an exception is approved.",
      "Every required capability has one row in `matrices/capability-ownership.json` classified `TARGET_REUSE`, `SHARED_PREREQUISITE`, `FEATURE_LOCAL`, or `DO_NOT_MIGRATE`, from legacy evidence, target evidence, and architecture authorities.",
      "A capability is `SHARED_PREREQUISITE` only when at least two consumers other than this module are proven; its `targetOwner` is outside the migrating feature.",
      "A missing architecture authority is recorded in `authorityGaps`, never invented or cited as if present.",
      ...(designSource === "figma-mcp"
        ? [
            `Derive \`${VISUAL_ACCEPTANCE_FILE}\` from \`${FIGMA_CONTEXT_FILE}\`: one row per required UI behavior state, binding \`figmaNodeId\`, \`figmaState\`, the frame \`viewport\`, expected visual facts (\`px\`, \`count\`, \`equals\`, \`present\`), and an explicit \`tolerance\`; the row is the only thing that binds a runtime state to Figma, and nothing is inferred from frame names or states. A state with no row goes under \`unbacked\` with its reason, and stays blocked until an operator approves its VISUAL_UNBACKED candidate (\`record-decision.mjs <module> --pending\`, approved at a terminal) and the entry cites that \`decisionId\` and \`decisionDigest\`. A state with a row can never be unbacked.`,
          ]
        : []),
      ...(designSource === "legacy-runtime"
        ? [
            `Derive \`${VISUAL_ACCEPTANCE_FILE}\` from \`${LEGACY_RUNTIME_CONTEXT_FILE}\`: one row per required UI behavior state, binding \`legacyFrameId\` (the pinned frame's \`id\`), the frame \`viewport\`, expected visual facts (\`px\`, \`count\`, \`equals\`, \`present\`) taken from that frame's pinned measurements, and an explicit \`tolerance\`; the row is the only thing that binds a runtime state to the legacy authority. A state with no row goes under \`unbacked\` with its reason and an approved VISUAL_UNBACKED decision. A state with a row can never be unbacked.`,
          ]
        : []),
    ],
  }),
  "steps/05-plan.md": renderStep({
    number: "05",
    name: "Plan",
    purpose:
      "Divide the approved baseline into bounded, independently implementable and verifiable slices.",
    dependencies: "`steps/04-build-baseline.md` and every baseline matrix",
    requirements: [
      "Every non-terminal behavior, route, navigation, and design-system gap is assigned to exactly one slice.",
      "Each slice lists architecture authorities, target paths, acceptance scenarios, and dependencies in `slices/index.json`.",
      "Every `SHARED_PREREQUISITE` and `FEATURE_LOCAL` capability is assigned to exactly one slice's `capabilityIds`.",
      "A slice building a `SHARED_PREREQUISITE` is declared before, and listed in the `dependencies` of, every slice that follows it.",
      "Legacy visual structure and code are excluded as target implementation authorities.",
    ],
  }),
  "steps/06-implement-slices.md": renderStep({
    number: "06",
    name: "Implement slices",
    purpose:
      "Implement only one active slice per session and record its changed scope.",
    dependencies: "`steps/05-plan.md`, `slices/index.json`",
    requirements: [
      "The active `slices/<slice-id>.json` marks every assigned requirement implemented.",
      "Target-native behavior remains preserved.",
      "The target design system is reused where required, and route adaptations follow target routing conventions.",
    ],
  }),
  "steps/07-verify-slices.md": renderStep({
    number: "07",
    name: "Verify slices",
    purpose:
      "Verify one active slice against its behavior, route, navigation, design-system, and architecture requirements.",
    dependencies:
      "`steps/06-implement-slices.md`, active slice record, and changed target files",
    requirements: [
      "The active `evidence/<slice-id>/result.json` is PASS and covers every requirement assigned to the slice.",
      "Independent list/detail behavior or its approved redesign is exercised, including transition and return behavior.",
      "Design-system evidence proves use of the target-required source or an approved exception.",
    ],
  }),
  "steps/08-finalize.md": renderStep({
    number: "08",
    name: "Finalize",
    purpose:
      "Recheck full functional parity, provenance, all slices, and the seven mandatory gates.",
    dependencies:
      "All slice evidence, matrices, target authorities, and final repository checks",
    requirements: [
      "All in-scope behavior and route rows are verified and all target-native rows are preserved.",
      "Every design-system row is COMPLIANT or EXCEPTION_APPROVED.",
      "All seven rows in `gates.json` are PASS with concrete, fresh, bound evidence.",
      "Final report proves no legacy code, UI structure, design, or architecture was copied.",
    ],
  }),
});

const initialJsonArtifacts = {
  "inventories/legacy.json": {
    version: 1,
    hasVisibleUi: false,
    uiBehaviors: [],
    behaviors: [],
    routeFlows: [],
    explicitNoRouteFlows: false,
  },
  [MODULE_CLASSIFICATION_FILE]: {
    version: 2,
    algorithmVersion: CENSUS_ALGORITHM_VERSION,
    moduleRoots: [],
    declaredEntryPoints: [],
    files: [],
    supporting: [],
    unresolvedReferences: [],
    findings: [],
  },
  "inventories/target.json": {
    version: 1,
    implementationState: "PLACEHOLDER",
    evidence: [],
    hasVisibleUi: false,
    navigationSurfaces: [],
    nativeBehaviors: [],
    uiComponents: [],
    uiMismatches: [],
  },
  "matrices/behavior-parity.json": { version: 1, rows: [] },
  "matrices/route-adaptation.json": { version: 1, rows: [] },
  "matrices/target-native.json": { version: 1, rows: [] },
  "matrices/design-system-usage.json": { version: 1, rows: [] },
  [CAPABILITY_OWNERSHIP_FILE]: {
    version: 1,
    architectureAuthorities: [],
    authorityGaps: [],
    rows: [],
  },
  "slices/index.json": { version: 1, slices: [] },
  "gates.json": {
    version: 1,
    gates: FINAL_GATES.map((gate) => ({
      gate,
      result: "PENDING",
      attempts: 0,
      evidence: [],
    })),
  },
};

const createResolveStep = ({
  legacyRoot,
  targetRoot,
  legacyRevision,
  legacyModule,
  legacySources,
  targetAdoption,
  targetModule,
  ponytail,
  dataSourceMode,
  designSource,
  figmaSources,
  requirementsAuthority,
  brief,
}) => `# 01. Resolve

- Status: \`COMPLETE\`
- Contract version: \`${RESUMABLE_CONTRACT_VERSION}\`
- Format version: \`${MIGRATION_FORMAT_VERSION}\`
- Workflow version: \`${WORKFLOW_VERSION}\`
- Legacy module: \`${legacyModule}\`
- Legacy sources: \`${legacySources.join(", ")}\`
- Target module: \`${targetModule}\`
- Target adoption: \`${targetAdoption.mode}\`
- Legacy root: \`${legacyRoot}\`
- Target root: \`${targetRoot}\`
- Legacy revision: \`${legacyRevision.revision}\`
- Legacy revision scope: \`${legacyRevision.pathScoped ? "path-scoped" : "whole-repo-fallback"}\`
- OpenSpec source: \`${requirementsAuthority.source}\`
- OpenSpec digest: \`${requirementsAuthority.digest}\`
- OpenSpec requirements: \`${requirementsAuthority.requirementIds.join(", ")}\`
- OpenSpec scenarios: \`${requirementsAuthority.scenarioIds.join(", ")}\`
- Ponytail: ${ponytail ? `\`${ponytail}\`` : "`DISABLED`"}
- Data source mode: \`${dataSourceMode}\`
- Design source: \`${designSource ?? "target-system"}\`${
  VISUAL_AUTHORITIES[designSource]
    ? `\n- Visual authority: \`${VISUAL_AUTHORITIES[designSource].contextFile}\``
    : ""
}${
  designSource === "figma-mcp" && Array.isArray(figmaSources)
    ? `\n${figmaSources
        .map(
          (source) =>
            `- Figma source: \`${source.raw}\` (${source.kind} ${source.fileKey}${source.nodeId ? `#${source.nodeId}` : ""})`,
        )
        .join("\n")}`
    : ""
}
- Brief: ${brief ? `\`${brief}\`` : "`NOT_PROVIDED`"}

## Result

Mapping, repository roots, invocation options, and the immutable legacy revision
were resolved. The next session must execute only \`DISCOVER_LEGACY\`.
`;

const LEGACY_REVISION_LINE = /^- Legacy revision: `[^`]+`$/m;
const LEGACY_REVISION_SCOPE_LINE = /^- Legacy revision scope: `[^`]+`$/m;

/**
 * Whether a persisted record is the one this invocation resolved to. The record
 * key is `migrationId`, so the legacy module is only compared where it is still
 * the identity -- at format 15 the bare positional names the target and says
 * nothing about which sources converge on it.
 */
const stateMappingMismatch = (state, resolved) =>
  state.targetModule !== resolved.target ||
  (usesMultiSource(state)
    ? state.migrationId !== resolved.canonical
    : state.legacyModule !== resolved.canonical);

// The journal that makes one checkpoint transition recoverable across the gap
// between the state write and the history append. It is the only journal in the
// main workflow; initialization uses the same file name under its own root.
const ADVANCE_JOURNAL = "advance.journal";

const readAdvanceJournal = async (root) => {
  const file = path.join(root, ADVANCE_JOURNAL);
  if (!(await fileExists(file))) return null;
  try {
    return { ...JSON.parse(await readFile(file, "utf8")), file };
  } catch {
    return { corrupt: true, file };
  }
};

export const readState = async (targetRoot, moduleName) => {
  const statePath = statePathFor(targetRoot, moduleName);
  await assertNoPendingTransaction(targetRoot, moduleName);
  const state = validateStateShape(
    await readJson(statePath, "Migration state"),
    moduleName,
  );
  const root = migrationRoot(targetRoot, moduleName);
  await assertIntegrityAnchor(root, state);
  const pendingWrite = await assertStateGraph(root, state);
  return { state, statePath, root, pendingWrite };
};

/**
 * `history/history.ndjson` is the migration's append-only audit record, and it
 * is the only durable artifact `state.json` cannot rewrite. That makes it the
 * integrity anchor for the navigation fields: this replays it and requires the
 * persisted state to be exactly the state those recorded transitions produce.
 *
 * Without this, `state.json` anchors itself -- `artifactHashes` both declares
 * and enforces which artifacts are immutable, so deleting an entry deletes its
 * own tamper check, and `currentStep` can be hand-edited backwards or forwards
 * around a closed checkpoint. Replaying the history makes every one of those
 * edits contradict a file the engine only ever appends to.
 *
 * @param {null | object} [pendingJournal] the advance journal to tolerate an
 *   in-flight transition against; omitted, it is read from disk. Pass `null`
 *   for a strict replay with no tolerance -- what recovery uses to prove it
 *   actually completed before dropping the journal.
 * @returns {Promise<null | { toRevision: number }>} a tolerated in-flight
 *   transition when a recoverable advance journal is present.
 */
const assertStateGraph = async (root, state, pendingJournal) => {
  const journal =
    pendingJournal === undefined
      ? await readAdvanceJournal(root)
      : pendingJournal;
  const events = await readHistoryEvents(root, await readIntegrity(root), journal);
  if (events.length === 0) {
    throw new Error(
      "Migration history is missing or empty. history/history.ndjson is the append-only audit record that anchors state.json; restore it before continuing.",
    );
  }
  if (events[0].event !== "CREATED" || events[0].step !== "RESOLVE") {
    throw new Error(
      "Migration history does not begin with the CREATED/RESOLVE event. The audit record was truncated or rewritten.",
    );
  }

  let revision = 1;
  // Identity is anchored by the append-only history, not by state.json alone:
  // a record is born with whatever the creating toolkit was (absent for an
  // unidentified source checkout, exactly as before this field existed), and
  // every later change must be an explicit recorded maintenance event.
  let toolkitIdentity =
    events[0].toolkitIdentity === undefined
      ? null
      : validateToolkitIdentity(
          events[0].toolkitIdentity,
          "Migration history CREATED toolkitIdentity",
        );
  let currentStep = events[0].nextStep ?? "DISCOVER_LEGACY";
  let activeSlice = null;
  let completedSteps = new Set(["RESOLVE"]);
  let completedSlices = [];
  let requiredHashes = new Set(resolveStepPins(state));
  // Never reset, never deleted from: a preserved failed attempt outlives every
  // later transition, including a full --refresh.
  const preservedReworkHashes = new Set();
  let uiRemediationReopened = false;
  if (state.brief) requiredHashes.add(state.brief.path);

  for (const event of events.slice(1)) {
    // A contract upgrade is a persisted transition like any other: it bumps the
    // revision and appends exactly one event, but it moves no step and
    // invalidates no artifact. Without this the replay lags one revision behind
    // every upgraded migration and readState rejects it as hand-edited.
    if (event.event === "UPGRADED_V4_TO_V5") {
      revision += 1;
      continue;
    }
    if (event.event === "REFRESHED") {
      revision += 1;
      currentStep = "DISCOVER_LEGACY";
      activeSlice = null;
      completedSteps = new Set(["RESOLVE"]);
      completedSlices = [];
      requiredHashes = new Set(resolveStepPins(state));
      continue;
    }
    // Reopening discovery is legal only from DISCOVERY_COMPLETENESS, so
    // nothing downstream can exist to lose. It drops exactly one step and its
    // pins, which is what makes `inventories/legacy.json` editable again.
    if (event.event === "REOPENED") {
      revision += 1;
      currentStep = "DISCOVER_LEGACY";
      activeSlice = null;
      completedSteps.delete("DISCOVER_LEGACY");
      for (const relative of IMMUTABLE_STEP_ARTIFACTS.DISCOVER_LEGACY) {
        requiredHashes.delete(relative);
      }
      uiRemediationReopened = false;
      continue;
    }
    if (event.event === "UI_REMEDIATION_REOPENED") {
      revision += 1;
      currentStep = "VERIFY_SLICES";
      activeSlice = event.slices[0];
      completedSteps.delete("IMPLEMENT_SLICES");
      completedSteps.delete("VERIFY_SLICES");
      completedSteps.delete("FINALIZE");
      completedSlices = completedSlices.filter(
        (sliceId) => !event.slices.includes(sliceId),
      );
      for (const sliceId of event.slices) {
        requiredHashes.delete(`evidence/${sliceId}/result.json`);
      }
      for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
        requiredHashes.delete(relative);
      }
      // `from: "FINALIZE"`/`"ACTIVE"` is stale-evidence recovery: the UI
      // contract did not change, so any remediation pin stays exactly as it was.
      if (!["FINALIZE", "ACTIVE"].includes(event.from)) {
        requiredHashes.delete(UI_REMEDIATION_FILE);
        uiRemediationReopened = true;
      }
      for (const relative of event.preserved ?? []) {
        preservedReworkHashes.add(relative);
      }
      continue;
    }
    // A COMPLETE record reopened by explicit operator act. Structurally the
    // same release as UI_REMEDIATION_REOPENED -- the named slices' evidence
    // plus the FINALIZE pins, and nothing else -- but it touches no remediation
    // file, and the evidence it supersedes is preserved and permanently pinned
    // like a rework attempt, so the previous COMPLETE's proof survives it.
    if (event.event === "COMPLETE_REOPENED") {
      revision += 1;
      currentStep = "VERIFY_SLICES";
      activeSlice = event.slices[0];
      completedSteps.delete("IMPLEMENT_SLICES");
      completedSteps.delete("VERIFY_SLICES");
      completedSteps.delete("FINALIZE");
      completedSlices = completedSlices.filter(
        (sliceId) => !event.slices.includes(sliceId),
      );
      for (const sliceId of event.slices) {
        requiredHashes.delete(`evidence/${sliceId}/result.json`);
      }
      for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
        requiredHashes.delete(relative);
      }
      for (const relative of event.preserved ?? []) {
        preservedReworkHashes.add(relative);
      }
      continue;
    }
    // W3. A rework returns one slice to implementation. It releases exactly two
    // mutable-current pins and permanently adds the preserved attempt's pins,
    // which are collected separately and unioned back in after the replay so no
    // later event -- including REFRESHED, which resets everything else -- can
    // drop the evidence of a failure that really happened.
    if (event.event === "SLICE_REWORKED") {
      revision += 1;
      currentStep = "IMPLEMENT_SLICES";
      activeSlice = event.slice;
      completedSteps.delete("IMPLEMENT_SLICES");
      completedSteps.delete("VERIFY_SLICES");
      completedSteps.delete("FINALIZE");
      completedSlices = completedSlices.filter(
        (sliceId) => sliceId !== event.slice,
      );
      requiredHashes.delete(`slices/${event.slice}.json`);
      requiredHashes.delete(`evidence/${event.slice}/result.json`);
      for (const relative of event.preserved ?? []) {
        preservedReworkHashes.add(relative);
      }
      continue;
    }
    // An add-only correction of a reopened slice's `changedFiles`, as the
    // deployed engine's `--amend-slice` records it. The slice record stays
    // required (only its value moves, which the integrity anchor covers); the
    // prior bytes join the permanent pin set like a rework's.
    //
    // Not replay-only: `amendSliceUnderLock` in this engine appends the event,
    // so this branch reads back both a live amendment and one already carried
    // by a record written elsewhere.
    if (event.event === "SLICE_SCOPE_AMENDED") {
      revision += 1;
      for (const relative of event.preserved ?? []) {
        preservedReworkHashes.add(relative);
      }
      continue;
    }
    // A format change on a COMPLETE record: no step, slice, or evidence pin
    // moves. The preserved prior context and the adoption record stay pinned
    // for life, like a preserved rework attempt; the visual contract pin itself
    // is already required by BUILD_BASELINE once the record reads as format 17.
    if (event.event === "VISUAL_CONTRACT_ADOPTED") {
      revision += 1;
      for (const relative of event.preserved ?? []) {
        preservedReworkHashes.add(relative);
      }
      continue;
    }
    // One registered format increment, committed on its own. A NO_OP domain
    // moves nothing but the cursor -- no step, slice, pin or artifact -- so the
    // replay bumps the revision and asserts it, exactly like UPGRADED_V4_TO_V5.
    // A TRANSFORM increment carries its domain transition instead, and is read
    // by the branch below: `isUiObservationsAdoption` matches both spellings.
    if (event.event === "FORMAT_UPGRADED" && !isUiObservationsAdoption(event)) {
      revision += 1;
      for (const relative of event.preserved ?? []) {
        preservedReworkHashes.add(relative);
      }
      if (Number.isInteger(event.revision) && event.revision !== revision) {
        throw new Error(
          `Migration history records revision ${event.revision} where the replayed transition sequence produces ${revision}. The audit record was rewritten or an event is missing.`,
        );
      }
      continue;
    }
    // The format-18 acceptance contract adopted in place. The legacy pin stays
    // required (its value moves, which the anchor covers); the prior inventory,
    // results and gates are pinned for life. A reopening adoption releases the
    // named slices' results and the FINALIZE pins exactly like COMPLETE_REOPENED.
    if (isUiObservationsAdoption(event)) {
      revision += 1;
      if (event.step === "VERIFY_SLICES") {
        currentStep = "VERIFY_SLICES";
        activeSlice = event.activeSlice;
        completedSteps.delete("IMPLEMENT_SLICES");
        completedSteps.delete("VERIFY_SLICES");
        completedSteps.delete("FINALIZE");
        completedSlices = completedSlices.filter(
          (sliceId) => !event.slices.includes(sliceId),
        );
        for (const sliceId of event.slices) {
          requiredHashes.delete(`evidence/${sliceId}/result.json`);
        }
        for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
          requiredHashes.delete(relative);
        }
      }
      for (const relative of event.preserved ?? []) {
        preservedReworkHashes.add(relative);
      }
      continue;
    }
    // A toolkit maintenance event. It bumps the revision and moves no step,
    // slice, pin or decision -- the whole transition is "a different build is
    // now permitted to write here". Ordering is enforced by requiring each
    // event's `previous` to be exactly the identity the replay has reached, so
    // a duplicated, reordered or fabricated event cannot line up.
    if (event.event.startsWith("TOOLKIT_IDENTITY_")) {
      if (!TOOLKIT_IDENTITY_EVENTS.includes(event.event)) {
        throw new Error(
          `Migration history contains an unrecognized toolkit identity event '${event.event}'. The audit record was rewritten.`,
        );
      }
      const adopting = event.event === "TOOLKIT_IDENTITY_ADOPTED";
      if (adopting !== (toolkitIdentity === null)) {
        throw new Error(
          adopting
            ? "Migration history adopts a toolkit identity on a record that already carries one. The audit record was rewritten."
            : "Migration history changes a toolkit identity on a record that never adopted one. The audit record was rewritten.",
        );
      }
      if (toolkitIdentityKey(event.previous ?? null) !== toolkitIdentityKey(toolkitIdentity)) {
        throw new Error(
          "Migration history records a toolkit identity change whose previous identity is not the one the replayed history had reached. The audit record was rewritten or an event is missing.",
        );
      }
      toolkitIdentity = validateToolkitIdentity(
        event.next,
        `Migration history ${event.event} next identity`,
      );
      revision += 1;
      if (Number.isInteger(event.revision) && event.revision !== revision) {
        throw new Error(
          `Migration history records revision ${event.revision} where the replayed transition sequence produces ${revision}. The audit record was rewritten or an event is missing.`,
        );
      }
      continue;
    }
    if (event.event === "SLICE_STATE_RECONCILED") {
      revision += 1;
      currentStep = event.currentStep;
      activeSlice = event.activeSlice ?? null;
      completedSlices = event.completedSlices;
      for (const sliceId of completedSlices) {
        requiredHashes.add(`slices/${sliceId}.json`);
        requiredHashes.add(`evidence/${sliceId}/result.json`);
      }
      if (uiRemediationReopened) requiredHashes.add(UI_REMEDIATION_FILE);
      continue;
    }
    if (event.event !== "STEP_COMPLETED") continue;
    revision += 1;
    if (event.step === "IMPLEMENT_SLICES") {
      requiredHashes.add(`slices/${event.slice}.json`);
    } else if (event.step === "VERIFY_SLICES") {
      requiredHashes.add(`slices/${event.slice}.json`);
      requiredHashes.add(`evidence/${event.slice}/result.json`);
      if (uiRemediationReopened) {
        requiredHashes.add(UI_REMEDIATION_FILE);
      }
      completedSlices = [...new Set([...completedSlices, event.slice])];
      if (event.nextStep === "FINALIZE") {
        completedSteps.add("IMPLEMENT_SLICES");
        completedSteps.add("VERIFY_SLICES");
      }
    } else {
      completedSteps.add(event.step);
      for (const relative of IMMUTABLE_STEP_ARTIFACTS[event.step] ?? []) {
        // A checkpoint closed before format 8 pinned no baseline rows; the
        // next advance computes the pin and stamps format 8 together.
        if (
          relative === BASELINE_ROWS_PIN &&
          !usesIntegrityAnchor(state)
        )
          continue;
        // Same shape for the format-11 capability matrix: a record that closed
        // BUILD_BASELINE before it existed pinned nothing and stays at 10.
        if (
          relative === CAPABILITY_OWNERSHIP_FILE &&
          !usesCapabilityOwnership(state)
        )
          continue;
        // The authority context is pinned at ASSESS_TARGET only by the record
        // whose design source owns it; a target-system (or pre-14) record
        // never authored one at all.
        if (!pinsAuthorityContext(state, relative)) continue;
        if (relative === VISUAL_ACCEPTANCE_FILE && !usesVisualContract(state))
          continue;
        requiredHashes.add(relative);
      }
    }
    currentStep = event.nextStep;
    activeSlice = event.nextSlice ?? null;
    if (Number.isInteger(event.revision) && event.revision !== revision) {
      throw new Error(
        `Migration history records revision ${event.revision} where the replayed transition sequence produces ${revision}. The audit record was rewritten or an event is missing.`,
      );
    }
  }

  // A crash between the state write and the history append leaves state one
  // revision ahead of the record, with the journal naming the missing event.
  const inFlight =
    journal &&
    !journal.corrupt &&
    journal.toRevision === state.revision &&
    revision === state.revision - 1;
  if (inFlight) return { toRevision: journal.toRevision };
  if (journal && !journal.corrupt && journal.toRevision === state.revision) {
    // Journal left behind after a fully applied transition; nothing is missing.
    return null;
  }

  const mismatch = (field, expected, actual) => {
    throw new Error(
      `Migration state ${field} is '${actual}', but the append-only history proves '${expected}'. state.json was edited outside the workflow; reopen the responsible checkpoint instead.`,
    );
  };
  if (state.revision !== revision) {
    mismatch("revision", revision, state.revision);
  }
  if (toolkitIdentityKey(state.toolkitIdentity ?? null) !== toolkitIdentityKey(toolkitIdentity)) {
    mismatch(
      "toolkitIdentity",
      renderToolkitIdentity(toolkitIdentity),
      renderToolkitIdentity(state.toolkitIdentity ?? null),
    );
  }
  if (state.currentStep !== currentStep) {
    mismatch("currentStep", currentStep, state.currentStep);
  }
  if ((state.activeSlice ?? null) !== activeSlice) {
    mismatch("activeSlice", activeSlice ?? "none", state.activeSlice ?? "none");
  }
  const expectedSteps = stepsFor(state).filter((step) =>
    completedSteps.has(step),
  );
  if (JSON.stringify(state.completedSteps) !== JSON.stringify(expectedSteps)) {
    mismatch(
      "completedSteps",
      expectedSteps.join(","),
      state.completedSteps.join(","),
    );
  }
  if (
    JSON.stringify([...state.completedSlices].sort()) !==
    JSON.stringify([...completedSlices].sort())
  ) {
    mismatch(
      "completedSlices",
      completedSlices.join(","),
      state.completedSlices.join(","),
    );
  }
  for (const relative of preservedReworkHashes) requiredHashes.add(relative);
  const actualHashes = Object.keys(state.artifactHashes).sort();
  const expectedHashes = [...requiredHashes].sort();
  if (JSON.stringify(actualHashes) !== JSON.stringify(expectedHashes)) {
    throw new Error(
      `Migration artifactHashes must pin exactly [${expectedHashes.join(", ")}] for the transitions recorded in history, but pins [${actualHashes.join(", ")}]. Pruning or adding an entry cannot remove an artifact from the immutable set.`,
    );
  }
  return null;
};

/** Appends `event` unless the recorded revision is already present. */
const appendHistoryOnce = async (targetRoot, root, event) => {
  await sealHistoryTail(targetRoot, root);
  const existing = await readHistoryEvents(root, await readIntegrity(root), await readAdvanceJournal(root));
  if (
    existing.some(
      (recorded) =>
        recorded.event === event.event && recorded.revision === event.revision,
    )
  ) {
    if (event.hash && existing.at(-1)?.hash !== event.hash) {
      throw new Error("Migration history retry disagrees with the journaled event hash; restore the record before continuing.");
    }
    return false;
  }
  await appendHistory(targetRoot, root, event);
  return true;
};

/**
 * The proof recovery must produce before deleting its journal: history, state,
 * integrity and revision all agree with no in-flight tolerance left.
 */
const assertRecovered = async (root, state) => {
  await assertStateGraph(root, state, null);
  await assertIntegrityAnchor(root, state);
};

/**
 * The public recovery entry point. Every mutating command already recovers on
 * its own; this exists because a preview must not mutate, so a record whose
 * integrity anchor is one revision ahead of its state could be *diagnosed* by a
 * read but never repaired by one.
 */
export const recoverMigrationRecord = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  const root = migrationRoot(registryData.targetRoot, resolved.canonical);
  const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
  if (!(await fileExists(statePath))) return null;
  return withModuleLock(registryData.targetRoot, resolved.canonical, () =>
    recoverPendingAdvance(registryData.targetRoot, root, statePath),
  );
};

/**
 * Completes or discards an interrupted checkpoint transition. Runs under the
 * module lock at the start of every mutating command, so a new process always
 * finds a consistent state without an operator touching any file.
 */
const recoverPendingAdvance = async (targetRoot, root, statePath) => {
  const journal = await readAdvanceJournal(root);
  if (!journal) return null;
  // An unreadable journal is the one case where nothing can be proven: the
  // transition's from/to revisions are exactly what was lost, so neither branch
  // below can run and `assertRecovered` has nothing to assert against. Deleting
  // it here destroyed the only artifact that could still reconstruct a missing
  // history event -- the durability guarantee is that a *failed* recovery keeps
  // its journal, so this fails and keeps it, byte for byte.
  if (journal.corrupt) {
    throw new Error(
      `An interrupted checkpoint transition left an unreadable journal at ${journal.file}. It records a transition that cannot be proven completed or discarded, so it was preserved exactly as found; investigate it before continuing. Nothing was changed.`,
    );
  }
  const state = await readJson(statePath, "Migration state");
  const integrityPath = path.join(root, INTEGRITY_FILE);
  if (state.revision === journal.toRevision) {
    // State committed; the integrity anchor and the audit event may still be
    // missing (a death between the two writes is the same tolerated gap as
    // between the state write and the history append).
    if (journal.integrity) {
      const current = (await fileExists(integrityPath))
        ? await readFile(integrityPath, "utf8")
        : null;
      if (current !== journal.integrity.content) {
        await atomicWrite(targetRoot, integrityPath, journal.integrity.content);
      }
    }
    const appended = await appendHistoryOnce(targetRoot, root, journal.event);
    // The journal is the only thing that can retry this, so it is dropped only
    // after the repaired record proves itself: `null` removes the in-flight
    // tolerance, so history must now replay to exactly this state, revision and
    // pin set, and the anchor must agree with both.
    await assertRecovered(root, state);
    await rm(journal.file, { force: true });
    return { outcome: appended ? "COMPLETED_HISTORY" : "ALREADY_COMPLETE" };
  }
  if (state.revision === journal.fromRevision) {
    // Nothing durable moved; restore any artifact the transition had rewritten
    // ahead of the state write so the pinned hashes still match, including the
    // integrity anchor if it was written before the crash.
    for (const entry of journal.restore ?? []) {
      if (entry.remove) {
        await rm(path.join(root, entry.path), { force: true });
      } else {
        await atomicWrite(
          targetRoot,
          path.join(root, entry.path),
          entry.content,
        );
      }
    }
    if (journal.integrity) {
      if (journal.integrity.before === null) {
        await rm(integrityPath, { force: true });
      } else {
        await atomicWrite(targetRoot, integrityPath, journal.integrity.before);
      }
    }
    await assertRecovered(root, state);
    await rm(journal.file, { force: true });
    return { outcome: "DISCARDED_UNCOMMITTED" };
  }
  throw new Error(
    `An interrupted checkpoint transition for revision ${journal.fromRevision} -> ${journal.toRevision} does not match the persisted revision ${state.revision}. Investigate ${journal.file} before continuing; nothing was changed.`,
  );
};

const completedArtifactHashes = async (root, state, step, sliceId) => {
  const relativePaths = (IMMUTABLE_STEP_ARTIFACTS[step] ?? []).filter(
    // A pre-11 record authored no capability matrix and is never promoted into
    // one after BUILD_BASELINE closed, so it must not be pinned to a file it
    // was never held to. An authority context is authored only by the record
    // whose design source owns it, so a target-system record -- or a figma-mcp
    // record faced with the legacy slot -- is never pinned to it either.
    (relative) =>
      (relative !== CAPABILITY_OWNERSHIP_FILE ||
        usesCapabilityOwnership(state)) &&
      pinsAuthorityContext(state, relative) &&
      (relative !== VISUAL_ACCEPTANCE_FILE || usesVisualContract(state)) &&
      (relative !== TARGET_BASELINE_FILE || isBrownfield(state)),
  );
  if (step === "IMPLEMENT_SLICES" && sliceId) {
    relativePaths.push(`slices/${sliceId}.json`);
  }
  if (step === "VERIFY_SLICES" && sliceId) {
    relativePaths.push(
      `slices/${sliceId}.json`,
      `evidence/${sliceId}/result.json`,
    );
    if (state.artifacts.uiRemediation) {
      relativePaths.push(state.artifacts.uiRemediation);
    }
  }
  const result = {};
  for (const relativePath of relativePaths) {
    result[relativePath] = await hashPinnedArtifact(root, relativePath);
  }
  return result;
};

const validateCompletedHashes = async (root, state) => {
  for (const [relativePath, expected] of Object.entries(state.artifactHashes)) {
    const filePath = pinnedSourcePath(root, relativePath);
    if (!(await fileExists(filePath))) {
      // Deletion and mutation are different forensics and must be
      // distinguishable in the refusal. A preserved failed attempt is the
      // record of *why* a slice was reworked; it has no reopen path, because
      // reopening a checkpoint cannot bring back bytes nobody kept.
      const rework = reworkPathParts(relativePath);
      throw new Error(
        rework
          ? `REWORK_EVIDENCE_MISSING: the preserved failed verification attempt for slice '${rework.sliceId}' (attempt ${rework.attempt}) is gone. ${relativePath} was pinned when the rework was authorized and is never released by any later transition. It was deleted, not altered; restore it from version control before continuing.`
          : relativePath.startsWith(`${REOPEN_ROOT}/`)
            ? `REOPEN_EVIDENCE_MISSING: the verification evidence a COMPLETE reopen superseded is gone. ${relativePath} was pinned when the reopen was authorized and is never released by any later transition. It was deleted, not altered; restore it from version control before continuing.`
            : `Completed artifact is missing: ${relativePath}. Reopen the responsible checkpoint.`,
      );
    }
    if (!(await pinnedArtifactMatches(root, relativePath, expected))) {
      throw new Error(
        relativePath === BASELINE_ROWS_PIN
          ? `Behavior parity rows changed after BUILD_BASELINE closed: their immutable fields (${IMMUTABLE_BEHAVIOR_ROW_FIELDS.join(", ")}) no longer match what the checkpoint pinned. Only verificationStatus may move; reopen the responsible checkpoint.`
          : relativePath === DISCOVERY_PIN
            ? `The recorded discovery digest changed after DISCOVERY_COMPLETENESS closed. ${DISCOVERY_SCAN_FILE} is machine-generated and is never edited by hand; rerun the checkpoint with --reopen-discovery.`
            : reworkPathParts(relativePath)
              ? `Preserved rework evidence changed after it was pinned: ${relativePath}. The failed verification attempt that authorized a rework is immutable; it was altered rather than deleted. Restore the original bytes.`
              : relativePath.startsWith(`${REOPEN_ROOT}/`)
                ? `Preserved reopen evidence changed after it was pinned: ${relativePath}. The superseded verification a COMPLETE reopen preserved is immutable; it was altered rather than deleted. Restore the original bytes.`
                : `Completed artifact changed after validation: ${relativePath}. Reopen the responsible checkpoint.`,
      );
    }
  }
};

const assertStepDocumentComplete = async (root, step) => {
  const relativePath = STEP_FILES[step];
  const content = await readFile(path.join(root, relativePath), "utf8");
  if (!content.includes("- Status: `COMPLETE`")) {
    throw new Error(`${relativePath} must record Status COMPLETE.`);
  }
  if (/\[TODO\]/i.test(content)) {
    throw new Error(`${relativePath} still contains TODO evidence.`);
  }
};

// Seam (Track A5): the legacy inventory rules are census's; the format-18
// observation rule they apply per UI behavior is visual's, passed in as data.
const validateLegacyInventory = (root, roots, state) =>
  validateLegacyInventoryRules(root, roots, state, { assertRequiredObservations });

/**
 * The one policy-aware module resolver for format 19, and the only thing that
 * turns a ledger line into authority there.
 *
 * It reads no receipt off the record. The candidate is re-derived from current
 * evidence by the caller and carries its own trusted policy pin and
 * `requiredPrincipal`; this resolves the *unique* applicable APPROVED line for
 * that exact candidate digest out of the verified ledgers.
 *
 * Fail-closed, in this order, because the order is what makes a refusal
 * nameable: an unbound candidate, a receipt field the record must not carry,
 * duplicate or conflicting lines over the same reviewed act, a current
 * REJECTED, a line for a superseded candidate (stale), and finally the full
 * binding predicate -- which is where a weaker principal, a different policy
 * digest and a changed evidence binding are all refused.
 *
 * A grouped member resolves only through its complete group entry: the group
 * line is the authority and the member view is a projection of it, so a line
 * over one member can never stand for the set.
 */
/**
 * The six projected decision states. `AWAITING_HUMAN_DECISION`,
 * `APPROVED_APPLICABLE`, `REJECTED` and `STALE` are per-candidate outcomes of
 * the resolver below; `READY_TO_ADVANCE` is the whole record's decision gate
 * being clear; `LEGACY_COMPATIBILITY_ACTION_REQUIRED` is the typed state a
 * record reaches when its authority is not expressible under this format.
 */
export const DECISION_PROJECTION_STATES = Object.freeze([
  "AWAITING_HUMAN_DECISION",
  "APPROVED_APPLICABLE",
  "REJECTED",
  "STALE",
  "READY_TO_ADVANCE",
  LEGACY_COMPATIBILITY_ACTION_REQUIRED,
]);

export const artifactBindingFor = async (row, roots) => {
  const { artifactArgumentsFor, artifactCommandFor, artifactIdFor } =
    await artifactEngine();
  const binding = assertPlainObject(
    row.artifactMigration,
    `${row.id}.artifactMigration`,
  );
  const keys = Object.keys(binding).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["source", "target", "type"])) {
    throw new Error(
      `${row.id}.artifactMigration must contain exactly source, type, and target.`,
    );
  }
  const source = legacyRelativePath(
    assertNonEmpty(binding.source, `${row.id}.artifactMigration.source`),
    roots,
    `${row.id}.artifactMigration.source`,
  );
  const sourceFile = path.resolve(roots.legacyRoot, source);
  await assertSecurePath(roots.legacyRoot, sourceFile);
  if (!(await fileExists(sourceFile))) {
    throw new Error(
      `${row.id}.artifactMigration.source '${binding.source}' does not exist under the legacy repository.`,
    );
  }
  const type = assertSafeName(binding.type, `${row.id}.artifactMigration.type`);
  const target = targetRelativePath(
    assertNonEmpty(binding.target, `${row.id}.artifactMigration.target`),
    roots,
    `${row.id}.artifactMigration.target`,
  );
  const owner = targetRelativePath(
    assertNonEmpty(row.targetOwner, `${row.id}.targetOwner`),
    roots,
    `${row.id}.targetOwner`,
  );
  if (target !== owner && !target.startsWith(`${owner}/`)) {
    throw new Error(
      `${row.id}.artifactMigration.target '${binding.target}' must equal targetOwner '${row.targetOwner}' or be inside it.`,
    );
  }
  const resolved = {
    artifactId: artifactIdFor({ source, type }),
    source,
    type,
    target,
    sourceRoot: roots.legacyRoot,
    targetRoot: roots.targetRoot,
  };
  return {
    ...resolved,
    arguments: artifactArgumentsFor({
      artifactType: type,
      source: { path: source, root: roots.legacyRoot },
      target: { path: target, root: roots.targetRoot },
    }),
    command: artifactCommandFor({
      artifactType: type,
      source: { path: source, root: roots.legacyRoot },
      target: { path: target, root: roots.targetRoot },
    }),
  };
};

export const validateArtifactDelegationRow = async (row, state, roots) => {
  if (row.classification !== "SHARED_PREREQUISITE") {
    if (row.artifactMigration !== undefined) {
      throw new Error(
        `${row.id}.artifactMigration is only valid for SHARED_PREREQUISITE.`,
      );
    }
    return null;
  }
  if (!usesArtifactDelegation(state)) return null;
  if (row.artifactMigration === undefined) {
    throw new Error(
      `${row.id} is SHARED_PREREQUISITE and format ${state.formatVersion} requires artifactMigration.`,
    );
  }
  return artifactBindingFor(row, roots);
};

/**
 * Format 11. The gap this closes: the contract could say "reuse the target
 * component that exists", but when a required capability was *missing* from the
 * target it asked nothing at all -- so an agent could rebuild a table, a search
 * box, or a form shell inside the feature it happened to be migrating, and
 * nothing recorded that it had chosen. Ownership is now classified with
 * evidence before PLAN can assign it.
 *
 * Deliberately not operator-gated: every rule here is decidable from repository
 * evidence, so `--mode auto` keeps running. The one dismissive classification,
 * DO_NOT_MIGRATE, must name the baseline row or requirement that replaces it
 * rather than argue for itself in prose.
 */
const validateCapabilityOwnership = async (root, state, roots, baselineIds) => {
  const targetModule = state?.targetModule;
  const matrix = assertPlainObject(
    await readJson(
      path.join(root, CAPABILITY_OWNERSHIP_FILE),
      "Capability ownership matrix",
    ),
    "Capability ownership matrix",
  );
  const authorities = assertArray(
    matrix.architectureAuthorities,
    "Capability architectureAuthorities",
  );
  // A cited authority must exist. The alternative -- citing a document the
  // repository does not have -- is how invented conventions get laundered into
  // evidence; a genuinely missing authority belongs in authorityGaps instead.
  await assertEvidenceResolves(
    authorities,
    "Capability architectureAuthorities",
    roots,
  );
  for (const gap of assertArray(
    matrix.authorityGaps,
    "Capability authorityGaps",
  )) {
    assertPlainObject(gap, "Capability authorityGap");
    assertNonEmpty(gap.expected, "Capability authorityGap.expected");
    assertNonEmpty(gap.reason, "Capability authorityGap.reason");
  }
  const rows = assertArray(matrix.rows, "Capability ownership rows");
  if (rows.length === 0) {
    throw new Error(
      "Capability ownership requires at least one row: every capability the module needs is TARGET_REUSE, SHARED_PREREQUISITE, FEATURE_LOCAL, or DO_NOT_MIGRATE.",
    );
  }
  assertUniqueIds(rows, "Capability ownership rows");
  let supportingConsumers;
  let pinnedScan;
  for (const row of rows) {
    assertNonEmpty(row.capability, `${row.id}.capability`);
    assertNonEmpty(row.rationale, `${row.id}.rationale`);
    const expected = CAPABILITY_DISPOSITIONS[row.classification];
    if (!expected) {
      throw new Error(
        `Capability row ${row.id} has invalid classification '${row.classification}'.`,
      );
    }
    if (row.requiredDisposition !== expected) {
      throw new Error(
        `Capability row ${row.id} requires requiredDisposition '${expected}' for '${row.classification}'.`,
      );
    }
    await validateArtifactDelegationRow(row, state, roots);
    const legacyEvidence = assertArray(
      row.legacyEvidence,
      `${row.id}.legacyEvidence`,
    );
    if (legacyEvidence.length === 0) {
      throw new Error(`${row.id} requires legacy evidence.`);
    }
    await assertEvidenceResolves(
      legacyEvidence,
      `${row.id}.legacyEvidence`,
      roots,
    );
    const targetEvidence = assertArray(
      row.targetEvidence,
      `${row.id}.targetEvidence`,
    );
    await assertEvidenceResolves(
      targetEvidence,
      `${row.id}.targetEvidence`,
      roots,
    );
    if (row.classification === "TARGET_REUSE" && targetEvidence.length === 0) {
      throw new Error(
        `${row.id} is TARGET_REUSE but cites no target evidence. Reuse must prove the capability already exists in the target.`,
      );
    }
    const consumers = assertArray(row.consumers, `${row.id}.consumers`).map(
      (consumer, index) =>
        legacyRelativePath(
          assertNonEmpty(consumer, `${row.id}.consumers[${index}]`),
          roots,
          `${row.id}.consumers[${index}]`,
        ),
    );
    if (row.classification === "SHARED_PREREQUISITE") {
      if (!supportingConsumers) {
        const scan = assertPlainObject(
          await readJson(
            path.join(root, DISCOVERY_SCAN_FILE),
            "Discovery scan",
          ),
          "Discovery scan",
        );
        supportingConsumers = new Set(
          assertArray(scan.supporting, "Discovery scan supporting").map(
            (consumer, index) =>
              legacyRelativePath(
                assertNonEmpty(consumer, `Discovery scan supporting[${index}]`),
                roots,
                `Discovery scan supporting[${index}]`,
              ),
          ),
        );
        pinnedScan = scan;
      }
      // The no-blind-promotion rule. One consumer is feature-local by
      // definition; shared ownership is proven by other consumers, not claimed.
      //
      // Every declared source, not just `legacyModule`: at format 15 the other
      // converging sources are being merged into this very target, so counting
      // them as external consumers promotes a capability that all of its
      // consumers end up sharing feature-locally. Format <= 14 resolves to the
      // single `legacyModule` this always subtracted.
      const converging = new Set(
        [targetModule, ...legacySourcesOf(state)].map((name) =>
          legacyRelativePath(name, roots, "converging module"),
        ),
      );
      const external = new Set(
        consumers.filter(
          (consumer) =>
            !converging.has(consumer) &&
            ![...converging].some((name) => consumer.startsWith(`${name}/`)),
        ),
      );
      if (external.size < SHARED_CONSUMER_THRESHOLD) {
        throw new Error(
          `${row.id} is SHARED_PREREQUISITE but names ${external.size} consumer(s) other than '${targetModule}'. Shared ownership requires at least ${SHARED_CONSUMER_THRESHOLD}; otherwise it is FEATURE_LOCAL.`,
        );
      }
      const absent = [...external].filter(
        (consumer) => !supportingConsumers.has(consumer),
      );
      if (absent.length > 0) {
        // shortcut: external import edges must be committed, add a discovery-time global edge pin if dirty consumers must qualify.
        const sources = legacyEvidence.map((claim) =>
          legacyRelativePath(claim, roots, `${row.id}.legacyEvidence`),
        );
        const { runDiscoveryScan } = await import("./census/index.mjs");
        const proof = await runDiscoveryScan({
          legacyRoot: roots.legacyRoot,
          moduleRoots: sources,
          algorithmVersion: pinnedScan.algorithmVersion,
        });
        const dirty = await dirtyManifest(roots.legacyRoot);
        const dirtyPaths = new Set(dirty.entries.map((entry) => entry.path));
        const edges = new Map();
        for (const edge of proof.edges) {
          if (!edges.has(edge.from)) edges.set(edge.from, new Set());
          edges.get(edge.from).add(edge.to);
        }
        const reachesSource = (file) => {
          if (dirtyPaths.has(file)) return false;
          const seen = new Set();
          const pending = [...(edges.get(file) ?? [])];
          while (pending.length > 0) {
            const next = pending.pop();
            if (seen.has(next)) continue;
            if (dirtyPaths.has(next)) continue;
            if (sources.includes(next)) return true;
            seen.add(next);
            pending.push(...(edges.get(next) ?? []));
          }
          return false;
        };
        const pinnedRevision =
          (await gitRevision(roots.legacyRoot)).revision ===
          state.legacyRevision.revision;
        const pinnedResolution =
          JSON.stringify(proof.resolution) ===
          JSON.stringify(pinnedScan.resolution);
        const directories = new Set(
          (await Promise.all(absent.map(async (consumer) =>
            (await lstat(path.join(roots.legacyRoot, consumer)).catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            }))?.isDirectory()
              ? consumer
              : null,
          ))).filter(Boolean),
        );
        const proven = absent.filter((consumer) =>
          pinnedRevision &&
          pinnedResolution &&
          ![...dirtyPaths].some((file) => file === "package.json" || file.endsWith("/package.json")) &&
          directories.has(consumer) &&
          !sources.some((source) => source.startsWith(`${consumer}/`)) &&
          proof.edges.some(({ from }) =>
            (from === consumer || from.startsWith(`${consumer}/`)) &&
            reachesSource(from)
          ),
        );
        if (
          proven.length !== absent.length ||
          [...external].some((consumer) =>
            [...external].some((other) =>
              other !== consumer && consumer.startsWith(`${other}/`)
            )
          )
        ) {
          throw new Error(
            `${row.id} names consumer(s) without pinned legacy import evidence: ${absent.filter((consumer) => !proven.includes(consumer)).join(", ") || absent.join(", ")}. Shared ownership must be proven by repository imports, not free text.`,
          );
        }
      }
    }
    if (
      row.classification === "SHARED_PREREQUISITE" ||
      row.classification === "FEATURE_LOCAL"
    ) {
      const owner = targetRelativePath(
        assertNonEmpty(row.targetOwner, `${row.id}.targetOwner`),
        roots,
        `${row.id}.targetOwner`,
      );
      const underFeature = isUnderFeature(owner, targetModule);
      if (row.classification === "SHARED_PREREQUISITE" && underFeature) {
        throw new Error(
          `${row.id} is SHARED_PREREQUISITE but targetOwner '${row.targetOwner}' is inside '${featureLocalPrefix(targetModule)}'. A proven shared capability may not be rebuilt as a feature-local replacement.`,
        );
      }
      if (row.classification === "FEATURE_LOCAL" && !underFeature) {
        throw new Error(
          `${row.id} is FEATURE_LOCAL but targetOwner '${row.targetOwner}' is outside '${featureLocalPrefix(targetModule)}'.`,
        );
      }
    }
    if (row.classification === "DO_NOT_MIGRATE") {
      const replacedBy = assertArray(row.replacedBy, `${row.id}.replacedBy`);
      if (replacedBy.length === 0) {
        throw new Error(
          `${row.id} is DO_NOT_MIGRATE but names nothing in replacedBy. A dismissal must cite the baseline row or requirement that covers it.`,
        );
      }
      for (const id of replacedBy) {
        if (!baselineIds.has(id)) {
          throw new Error(
            `${row.id}.replacedBy references '${id}', which is not a baseline row or OpenSpec requirement of this migration.`,
          );
        }
      }
    }
  }
  return rows;
};

/**
 * `ADOPTED_VERIFIED`: existing code is a hypothesis, a passing bound test run
 * is the proof. Six conditions, and `assertCommandResults` -- the same
 * structured, hash-bound, exit-0 record VERIFY_SLICES already requires -- is
 * reused verbatim for the fourth.
 *
 * Condition five is the one that matters: a green `pnpm test:run
 * tests/features/unrelated` satisfies `assertCommandResults` while claiming a
 * catalog-sync scenario. The union of the entries' `scenarioIds` must equal the
 * row's exactly, every id must be in the OpenSpec authority, and every declared
 * test path must appear literally in the captured output bytes -- a runner that
 * did not name the file did not run it.
 *
 * ponytail: containment over the hashed output, not a parsed reporter contract,
 * so the engine is not bound to one runner's JSON schema. Ceiling: it proves
 * the file was named in a passing run, not that the run asserted the scenario;
 * scenario-level attribution stays an authored claim reviewed at the
 * checkpoint, the same trust level as every other matrix field. Upgrade path:
 * a machine-readable reporter contract, when one is worth pinning to.
 */
const validateAdoptedRow = async (row, { roots, state, drift }) => {
  const label = `Behavior parity row ${row.id}`;
  if (!isBrownfield(state)) {
    throw new Error(
      `${label} is ADOPTED_VERIFIED, but this migration did not adopt an existing target. Adoption is available only to a record created with --adopt-target.`,
    );
  }
  if (row.targetState !== "IMPLEMENTED_UNVERIFIED") {
    throw new Error(
      `${label} is ADOPTED_VERIFIED with targetState '${row.targetState}'. Only an IMPLEMENTED_UNVERIFIED behavior -- present, complete-looking, unproven -- can be adopted.`,
    );
  }
  const featureDirectory = targetFeatureDirectory(
    roots.targetRoot,
    state.targetModule,
  );
  const targetEvidence = assertArray(
    row.targetEvidence ?? [],
    `${row.id}.targetEvidence`,
  );
  if (targetEvidence.length === 0) {
    throw new Error(`${label} requires target evidence to be adopted.`);
  }
  const dependsOn = [];
  for (const value of targetEvidence) {
    const claim = evidencePathClaim(
      typeof value === "string" ? value : value?.location,
    );
    if (!claim) continue;
    const absolute = await resolveEvidencePath(claim, roots);
    if (!absolute || !isWithin(featureDirectory, absolute)) {
      throw new Error(
        `${row.id}.targetEvidence references '${claim}', which is not under 'src/features/${state.targetModule}/'. An adopted behavior is proven by the implementation that owns it.`,
      );
    }
    dependsOn.push(
      path.relative(roots.targetRoot, absolute).split(path.sep).join("/"),
    );
  }
  const scenarioIds = assertArray(
    row.scenarioIds ?? [],
    `${row.id}.scenarioIds`,
  );
  if (scenarioIds.length === 0) {
    throw new Error(
      `${label} is ADOPTED_VERIFIED but claims no scenarioIds. Adoption is a claim about scenarios; without one there is nothing to have proven.`,
    );
  }
  await assertCommandResults(
    row.adoptionEvidence,
    `${row.id}.adoptionEvidence`,
    roots,
  );
  const covered = new Set();
  for (const [index, entry] of row.adoptionEvidence.entries()) {
    const at = `${row.id}.adoptionEvidence[${index}]`;
    const entryScenarios = assertArray(entry.scenarioIds, `${at}.scenarioIds`);
    const testPaths = assertArray(entry.testPaths, `${at}.testPaths`);
    if (entryScenarios.length === 0 || testPaths.length === 0) {
      throw new Error(
        `${at} must name at least one scenarioId and one testPath. A run that names neither proves nothing about this row.`,
      );
    }
    for (const scenarioId of entryScenarios) {
      if (!scenarioIds.includes(scenarioId)) {
        throw new Error(
          `${at}.scenarioIds names '${scenarioId}', which ${row.id} does not claim.`,
        );
      }
      // The identical membership check `validatePlan` applies to slices.
      if (!state.requirementsAuthority.scenarioIds.includes(scenarioId)) {
        throw new Error(
          `${at}.scenarioIds references '${scenarioId}', which the OpenSpec authority does not define.`,
        );
      }
      covered.add(scenarioId);
    }
    const output = await readFile(
      await resolveEvidencePath(evidencePathClaim(entry.outputPath), roots),
      "utf8",
    );
    for (const testPath of testPaths) {
      assertNonEmpty(testPath, `${at}.testPaths entry`);
      const absolute = path.resolve(roots.targetRoot, testPath);
      if (
        !isWithin(path.join(roots.targetRoot, "tests"), absolute) ||
        !(await fileExists(absolute))
      ) {
        throw new Error(
          `${at}.testPaths lists '${testPath}', which is not an existing file under the target repository's tests/ directory.`,
        );
      }
      if (!output.includes(testPath)) {
        throw new Error(
          `${at}.testPaths lists '${testPath}', which does not appear in the captured output of '${entry.command}'. A run that never named the file did not execute it, so it cannot adopt this row.`,
        );
      }
      dependsOn.push(
        path.relative(roots.targetRoot, absolute).split(path.sep).join("/"),
      );
    }
  }
  // Exact coverage in both directions: a row may not claim a scenario no run
  // covers, and the runs may not carry a scenario the row does not claim (the
  // second half is enforced per entry above).
  const uncovered = scenarioIds.filter((id) => !covered.has(id));
  if (uncovered.length > 0) {
    throw new Error(
      `${label} claims scenario(s) ${uncovered.join(", ")} that no adoption evidence covers.`,
    );
  }
  // An adoption claim is proof about a specific target tree, and goes stale
  // only when a path it named changed. An unrelated commit elsewhere in the
  // repository does not reopen the matrix.
  const stale = [...new Set(dependsOn)].filter((relative) => drift(relative));
  if (stale.length > 0) {
    throw new Error(
      `${label} is ADOPTED_VERIFIED, but ${stale.join(", ")} changed since the target baseline was pinned. Re-prove the row with a verification-only slice.`,
    );
  }
  return row;
};

const validateBaseline = async (root, { final = false, roots, state } = {}) => {
  const legacy = await validateLegacyInventory(root, roots, state);
  const target = await validateTargetInventory(root, roots, legacy, state);
  const behaviorMatrix = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.behaviorParity),
      "Behavior parity matrix",
    ),
    "Behavior parity matrix",
  );
  const behaviorRows = assertArray(behaviorMatrix.rows, "Behavior parity rows");
  assertUniqueIds(behaviorRows, "Behavior parity rows");
  const behaviorIds = new Set(legacy.behaviors.map((row) => row.id));
  const mappedBehaviorIds = new Set(
    behaviorRows.map((row) =>
      assertNonEmpty(row.behaviorId, `${row.id}.behaviorId`),
    ),
  );
  if (
    behaviorIds.size !== mappedBehaviorIds.size ||
    [...behaviorIds].some((id) => !mappedBehaviorIds.has(id))
  ) {
    throw new Error(
      "Behavior parity rows must map every reachable legacy behavior exactly once.",
    );
  }
  // Read once for the whole matrix, and only where they are needed: the pinned
  // roots for attribution, the pinned baseline for adoption staleness.
  const classification = usesSourceAttribution(state)
    ? await readJson(
        path.join(root, MODULE_CLASSIFICATION_FILE),
        "Module classification",
      )
    : null;
  const adoptionBaseline = behaviorRows.some(
    (row) => row.verificationStatus === "ADOPTED_VERIFIED",
  )
    ? await readTargetBaseline(root, isBrownfield(state))
    : null;
  const adoptionDrift = adoptionBaseline
    ? await targetBaselineDrift(roots.targetRoot, adoptionBaseline)
    : null;
  for (const row of behaviorRows) {
    const expectedDisposition = BEHAVIOR_DISPOSITIONS[row.targetState];
    if (!expectedDisposition) {
      throw new Error(
        `Behavior parity row ${row.id} has invalid targetState '${row.targetState}'.`,
      );
    }
    if (row.disposition !== expectedDisposition) {
      throw new Error(
        `Behavior parity row ${row.id} requires disposition '${expectedDisposition}' for '${row.targetState}'.`,
      );
    }
    // `verificationStatus` was the one matrix field with no vocabulary at all:
    // it is excluded from the immutable-row pin so it can move as slices get
    // verified, and nothing ever checked what it moved to.
    if (!PARITY_STATUSES.has(row.verificationStatus)) {
      throw new Error(
        `Behavior parity row ${row.id} has invalid verificationStatus '${row.verificationStatus}'. Valid values are ${[...PARITY_STATUSES].join(", ")}.`,
      );
    }
    // The unearned-VERIFIED hole: authoring a terminal status before any slice
    // has been verified removes the row from planning, implementation,
    // verification, and FINALIZE in one edit, with no evidence required.
    if (
      SLICE_EARNED_PARITY.has(row.verificationStatus) &&
      !anySliceVerified(state)
    ) {
      throw new Error(
        `Behavior parity row ${row.id} is authored '${row.verificationStatus}' before any slice has been verified. VERIFY_SLICES is the only producer of that status; an already-implemented target behavior is recorded ADOPTED_VERIFIED with bound evidence instead.`,
      );
    }
    if (row.verificationStatus === "ADOPTED_VERIFIED") {
      await validateAdoptedRow(row, {
        roots,
        state,
        drift: adoptionDrift,
      });
    }
    if (
      assertArray(row.legacyEvidence, `${row.id}.legacyEvidence`).length === 0
    ) {
      throw new Error(`${row.id} requires legacy evidence.`);
    }
    if (
      row.targetState !== "ABSENT" &&
      assertArray(row.targetEvidence, `${row.id}.targetEvidence`).length === 0
    ) {
      throw new Error(`${row.id} requires current target evidence.`);
    }
    await assertEvidenceResolves(
      row.legacyEvidence,
      `${row.id}.legacyEvidence`,
      roots,
    );
    await assertEvidenceResolves(
      row.targetEvidence ?? [],
      `${row.id}.targetEvidence`,
      roots,
    );
    if (classification) {
      await assertLegacyEvidenceAttributes(
        row.legacyEvidence,
        `${row.id}.legacyEvidence`,
        { roots, state, classification },
      );
    }
  }
  if (
    final &&
    behaviorRows.some((row) => !TERMINAL_PARITY.has(row.verificationStatus))
  ) {
    throw new Error("Behavior parity contains unverified rows.");
  }

  const routeMatrix = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.routeAdaptation),
      "Route adaptation matrix",
    ),
    "Route adaptation matrix",
  );
  const routeRows = assertArray(routeMatrix.rows, "Route adaptation rows");
  assertUniqueIds(routeRows, "Route adaptation rows");
  const routeIds = new Set(legacy.routeFlows.map((row) => row.id));
  const mappedRouteIds = new Set(
    routeRows.map((row) =>
      assertNonEmpty(row.routeFlowId, `${row.id}.routeFlowId`),
    ),
  );
  if (
    routeIds.size !== mappedRouteIds.size ||
    [...routeIds].some((id) => !mappedRouteIds.has(id))
  ) {
    throw new Error(
      "Route adaptation rows must map every reachable legacy route flow exactly once.",
    );
  }
  for (const flow of legacy.routeFlows) {
    const row = routeRows.find(
      (candidate) => candidate.routeFlowId === flow.id,
    );
    if (!row) continue;
    assertNonEmpty(row.targetAdaptation, `${row.id}.targetAdaptation`);
    if (
      flow.independentListAndDetail === true &&
      row.preservesIndependentListAndDetail !== true
    ) {
      if (
        row.decision !== "REDESIGNED_APPROVED" ||
        typeof row.approval !== "string" ||
        row.approval.trim().length === 0 ||
        typeof row.acceptanceScenario !== "string" ||
        row.acceptanceScenario.trim().length === 0
      ) {
        throw new Error(
          `NAVIGATION_FLOW_GAP: ${flow.id} has independent list and detail surfaces, but the target merges them without an approved redesign and acceptance scenario.`,
        );
      }
    }
    if (final && row.verificationStatus !== "VERIFIED") {
      throw new Error(`Route adaptation ${row.id} is not VERIFIED.`);
    }
    if (final && assertArray(row.evidence, `${row.id}.evidence`).length === 0) {
      throw new Error(`Route adaptation ${row.id} requires final evidence.`);
    }
  }

  const nativeMatrix = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.targetNative),
      "Target-native matrix",
    ),
    "Target-native matrix",
  );
  const nativeRows = assertArray(nativeMatrix.rows, "Target-native rows");
  assertUniqueIds(nativeRows, "Target-native rows");
  for (const row of nativeRows) {
    for (const control of assertArray(row.controls ?? [], `Target-native row ${row.id}.controls`)) {
      assertPlainObject(control, `Target-native row ${row.id}.controls[]`);
      assertNonEmpty(control.role, `Target-native row ${row.id}.controls[].role`);
      assertNonEmpty(control.name, `Target-native row ${row.id}.controls[].name`);
    }
  }
  const targetNativeIds = new Set(target.nativeBehaviors.map((row) => row.id));
  const mappedNativeIds = new Set(
    nativeRows.map((row) =>
      assertNonEmpty(row.nativeBehaviorId, `${row.id}.nativeBehaviorId`),
    ),
  );
  if (
    targetNativeIds.size !== mappedNativeIds.size ||
    [...targetNativeIds].some((id) => !mappedNativeIds.has(id))
  ) {
    throw new Error(
      "Target-native rows must map every inventoried target-native behavior exactly once.",
    );
  }
  if (
    final &&
    nativeRows.some((row) => row.verificationStatus !== "PRESERVED")
  ) {
    throw new Error("Target-native behavior contains unpreserved rows.");
  }

  const designMatrix = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.designSystemUsage),
      "Design-system matrix",
    ),
    "Design-system matrix",
  );
  const designRows = assertArray(designMatrix.rows, "Design-system rows");
  assertUniqueIds(designRows, "Design-system rows");
  const componentIds = new Set(target.uiComponents.map((row) => row.id));
  const designComponentIds = new Set(
    designRows.map((row) =>
      assertNonEmpty(row.componentId, `${row.id}.componentId`),
    ),
  );
  if (
    componentIds.size !== designComponentIds.size ||
    [...componentIds].some((id) => !designComponentIds.has(id))
  ) {
    throw new Error(
      "Design-system rows must map every inventoried target UI component exactly once.",
    );
  }
  for (const row of designRows) {
    const component = target.uiComponents.find(
      (candidate) => candidate.id === row.componentId,
    );
    const expectedSource = assertNonEmpty(row.authority, `${row.id}.authority`);
    const actualSource = assertNonEmpty(
      row.actualSource,
      `${row.id}.actualSource`,
    );
    if (
      component?.equivalentAvailable === true &&
      actualSource !== expectedSource &&
      row.status !== "DESIGN_SYSTEM_GAP" &&
      row.status !== "EXCEPTION_APPROVED"
    ) {
      throw new Error(
        `DESIGN_SYSTEM_GAP: ${row.id} must record the noncompliant source as a gap or an approved exception.`,
      );
    }
    if (
      row.status === "EXCEPTION_APPROVED" &&
      (typeof row.exceptionApproval !== "string" ||
        row.exceptionApproval.trim().length === 0)
    ) {
      throw new Error(
        `${row.id} requires explicit design-system exception approval.`,
      );
    }
    if (
      final &&
      (!TERMINAL_DESIGN_SYSTEM.has(row.status) ||
        row.verificationStatus !== "VERIFIED")
    ) {
      throw new Error(
        `Design-system row ${row.id} is not compliant and VERIFIED.`,
      );
    }
  }
  const capabilityRows = usesCapabilityOwnership(state)
    ? await validateCapabilityOwnership(
        root,
        state,
        roots,
        new Set([
          ...behaviorRows.map((row) => row.id),
          ...routeRows.map((row) => row.id),
          ...nativeRows.map((row) => row.id),
          ...designRows.map((row) => row.id),
          ...(state?.requirementsAuthority?.requirementIds ?? []),
        ]),
      )
    : [];
  const visualRows = usesVisualContract(state)
    ? await validateVisualAcceptance(root, state, legacy, target, undefined, {
        projectRoot: roots?.targetRoot,
      })
    : null;
  return {
    legacy,
    target,
    behaviorRows,
    routeRows,
    nativeRows,
    designRows,
    capabilityRows,
    visualRows,
  };
};

// Track A4: the plan rules live in slices/. This seam reads the BUILD_BASELINE
// matrices first, where the rules always did, and supplies the two facts they
// read but slices/ does not own: the lifecycle's terminal parity statuses and
// the visual UI-requirement predicate.
const validatePlan = async (root, state, roots) =>
  validateSlicePlan(root, state, roots, await validateBaseline(root, { roots, state }), {
    terminalParity: TERMINAL_PARITY,
    uiBehaviorIsRequired,
  });

const artifactOptions = (binding) => ({
  id: binding.artifactId,
  source: binding.source,
  type: binding.type,
  target: binding.target,
  sourceRoot: binding.sourceRoot,
  targetRoot: binding.targetRoot,
});

export const artifactPrerequisiteWork = async (
  state,
  roots,
  { capabilityRows, slices, all = false } = {},
) => {
  const { getArtifactStatus, validateArtifactComplete } =
    await artifactEngine();
  if (!usesArtifactDelegation(state)) return { outcome: "COMPLETE" };
  let rows = capabilityRows;
  let planSlices = slices;
  if (!rows || !planSlices) {
    const root = migrationRoot(roots.targetRoot, state.migrationId);
    const plan = await validatePlan(root, state, roots);
    rows = plan.capabilityRows;
    planSlices = plan.slices;
  }
  const active = planSlices.find((slice) => slice.id === state.activeSlice);
  const selectedSlices = all
    ? planSlices
    : planSlices.filter(
        (slice) =>
          slice.id === active?.id ||
          (active?.dependencies ?? []).includes(slice.id),
      );
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const selectedRows = selectedSlices
    .flatMap((slice) => slice.capabilityIds)
    .map((id) => rowsById.get(id))
    .filter((row) => row?.classification === "SHARED_PREREQUISITE");
  for (const row of selectedRows) {
    const binding = await artifactBindingFor(row, roots);
    const status = await getArtifactStatus(artifactOptions(binding));
    if (status.outcome === "BLOCKED" || status.status === "STALE") {
      return {
        outcome: "BLOCKED",
        reason: `Artifact prerequisite '${row.id}' is ${status.status}: ${status.reason}`,
        artifactMigration: binding,
      };
    }
    if (status.status === "COMPLETE") {
      try {
        await validateArtifactComplete(artifactOptions(binding));
      } catch (error) {
        return {
          outcome: "BLOCKED",
          reason: `Artifact prerequisite '${row.id}' is invalid: ${error.message}`,
          artifactMigration: binding,
        };
      }
      continue;
    }
    if (status.validation?.outcome === "OPERATOR_DECISION") {
      return {
        outcome: "OPERATOR_DECISION",
        reason: status.validation.reason,
        pendingDecisions: status.validation.pendingDecisions,
        artifactMigration: binding,
      };
    }
    return {
      outcome: "CONTINUE",
      nextWorkKind: "RUN_ARTIFACT",
      reason: `Artifact prerequisite '${row.id}' is ${status.status}.`,
      artifactMigration: binding,
    };
  }
  return { outcome: "COMPLETE" };
};

export const assertArtifactPrerequisites = async (state, roots, options) => {
  const work = await artifactPrerequisiteWork(state, roots, options);
  if (work.outcome === "COMPLETE") return;
  throw new Error(
    work.reason ?? "A delegated artifact prerequisite is not COMPLETE.",
  );
};

// Track A4: the implementation contract lives in slices/. This seam supplies
// the validated plan and the census fact `isBrownfield`, and keeps the
// lifecycle's artifact-prerequisite check between the claim rules and the
// shared-prerequisite rule, where it always ran.
const validateImplementedSlice = async (root, sliceId, state, roots, recordOverride) => {
  const plan = await validatePlan(root, state, roots);
  const { record, changedTargetPaths } = await validateSliceImplementation(
    root,
    sliceId,
    state,
    roots,
    recordOverride,
    plan,
    isBrownfield(state),
  );
  // Format 11. Without this a slice can claim a SHARED_PREREQUISITE at PLAN and
  // still build it inside the feature: PLAN only proves the capability was
  // scheduled, this proves it landed where the matrix said it would.
  if (usesCapabilityOwnership(state) && roots?.targetRoot) {
    await assertArtifactPrerequisites(state, roots, {
      capabilityRows: plan.capabilityRows,
      slices: plan.slices,
    });
    assertSharedPrerequisitesBuilt(
      sliceId,
      state,
      roots,
      record,
      plan.capabilityRows,
      changedTargetPaths,
    );
  }
  return record;
};

const validateVerifiedSlice = async (root, sliceId, state, roots) => {
  const implementation = await validateImplementedSlice(
    root,
    sliceId,
    state,
    roots,
  );
  const evidence = assertPlainObject(
    await readJson(
      path.join(root, `evidence/${sliceId}/result.json`),
      `Evidence for ${sliceId}`,
    ),
    `Evidence for ${sliceId}`,
  );
  assertSlicePassed(implementation, evidence, sliceId, state, engineCommand);
  await assertCommandResults(
    evidence.commands,
    `${sliceId} evidence commands`,
    roots,
  );
  const baseline = await validateBaseline(root, { roots, state });
  // Format 17: a design-system gap is a visual divergence the slice itself
  // declares, so it cannot sit PENDING inside a visual PASS.
  if (usesVisualContract(state)) {
    const traced = new Set(implementation.traceIds);
    const gap = baseline.designRows.find(
      (row) => traced.has(row.id) && !TERMINAL_DESIGN_SYSTEM.has(row.status),
    );
    if (gap) {
      throw new Error(
        `DESIGN_SYSTEM_GAP: ${sliceId} traces design-system row ${gap.id} with status '${gap.status}', so it cannot verify against ${visualAuthorityOf(state).contextFile}. Make the row COMPLIANT, or record EXCEPTION_APPROVED with its explicit exceptionApproval, before verifying.`,
      );
    }
  }
  const visualComparison = await validateUiRuntimeEvidence({
    evidence,
    implementation,
    baseline,
    sliceId,
    state,
    roots,
    root,
    implementationDigests,
  });
  await assertPostAnchorEvidence(root, sliceId, state, roots, evidence);
  return { visualComparison };
};

/** Same pattern as the visual-contract hint: name the one recovery command. */
const withUiProofReopenHint = async (root, sliceId, state, roots) => {
  try {
    return await validateVerifiedSlice(root, sliceId, state, roots);
  } catch (error) {
    if (
      !(state.completedSlices ?? []).includes(sliceId) ||
      !(await sliceLacksUiProofV1(root, sliceId, roots))
    ) {
      throw error;
    }
    const lacking = await completedSlicesLackingUiProofV1(root, state, roots);
    error.message += ` Completed slices ${lacking.join(", ")} lack ${UI_PROOF_FORMAT} UI proof; recover them with: --reopen-ui ${lacking.join(",")}.`;
    throw error;
  }
};

// Contract 5 decision 1.3: typed Ponytail evidence, never a regex over prose.
const PONYTAIL_GATE_EVIDENCE = {
  full: [["SIMPLIFY_ONCE", "review"]],
  "full-audit": [
    ["SIMPLIFY_ONCE", "review"],
    ["PRECOMMIT_GATE", "audit"],
  ],
};

// Fix B (candidate change; analysis/inventory.md Defect "Gate evidence has no
// freshness, hash, or binding enforcement" / `references/migration-contract.md`
// "Final gates"): each evidence entry is now a structured, bound record
// instead of an arbitrary string. Rejects an entry (and therefore the gate)
// when a required field is missing, when `boundTo` disagrees with the
// migration's current resolved target/legacy revision/target revision/
// requirements digest/data-source mode, or when `producedAt` predates the
// most recently pinned legacy revision or requirements digest -- evidence
// timestamped before the thing it claims to satisfy was even pinned is stale
// by construction.
const assertEvidenceEntry = (entry, label, context) => {
  assertPlainObject(entry, label);
  assertNonEmpty(entry.kind, `${label}.kind`);
  assertNonEmpty(entry.reference, `${label}.reference`);
  assertIsoTimestamp(entry.producedAt, `${label}.producedAt`);
  assertNonEmpty(entry.producer, `${label}.producer`);
  assertNonEmpty(entry.environment, `${label}.environment`);
  if (!isContentIdentity(entry.hash)) {
    throw new Error(
      `${label}.hash must be a SHA-256 digest ('sha256:<64 hex>') of the referenced artifact, or of the reference string if it isn't a file.`,
    );
  }
  const boundTo = assertPlainObject(entry.boundTo, `${label}.boundTo`);
  assertNonEmpty(boundTo.target, `${label}.boundTo.target`);
  assertNonEmpty(boundTo.legacyRevision, `${label}.boundTo.legacyRevision`);
  assertNonEmpty(boundTo.targetRevision, `${label}.boundTo.targetRevision`);
  assertNonEmpty(
    boundTo.requirementsDigest,
    `${label}.boundTo.requirementsDigest`,
  );
  if (!["standard", "mock"].includes(boundTo.dataSourceMode)) {
    throw new Error(
      `${label}.boundTo.dataSourceMode must be 'standard' or 'mock'.`,
    );
  }
  if (boundTo.target !== context.target) {
    throw new Error(
      `${label} is bound to target '${boundTo.target}', which does not match the migration's current target '${context.target}'.`,
    );
  }
  if (boundTo.legacyRevision !== context.legacyRevision) {
    throw new Error(
      `${label} is bound to legacy revision '${boundTo.legacyRevision}', which does not match the current legacy revision '${context.legacyRevision}'. Evidence from a stale legacy revision never satisfies a gate.`,
    );
  }
  if (boundTo.targetRevision !== context.targetRevision) {
    throw new Error(
      `${label} is bound to target revision '${boundTo.targetRevision}', which does not match the current target revision '${context.targetRevision}'. Evidence from a stale target revision never satisfies a gate.`,
    );
  }
  if (boundTo.requirementsDigest !== context.requirementsDigest) {
    throw new Error(
      `${label} is bound to requirements digest '${boundTo.requirementsDigest}', which does not match the current requirements digest '${context.requirementsDigest}'. Evidence from a changed spec never satisfies a gate.`,
    );
  }
  if (boundTo.dataSourceMode !== context.dataSourceMode) {
    throw new Error(
      `${label} is bound to data-source mode '${boundTo.dataSourceMode}', which does not match the migration's current data-source mode '${context.dataSourceMode}'. Mock-mode evidence never satisfies a standard-mode gate, or vice versa.`,
    );
  }
  assertNonEmpty(
    boundTo.legacyDirtyDigest,
    `${label}.boundTo.legacyDirtyDigest`,
  );
  assertNonEmpty(
    boundTo.targetDirtyDigest,
    `${label}.boundTo.targetDirtyDigest`,
  );
  // Nothing is committed before FINALIZE, so `legacyRevision`/`targetRevision`
  // never move while a slice edits a file. Binding the dirty manifest too
  // means any uncommitted change to either tree -- even one no evidence entry
  // ever names -- invalidates evidence authored before it happened.
  if (boundTo.legacyDirtyDigest !== context.legacyDirtyDigest) {
    throw new Error(
      `${label} is bound to legacy dirty-tree digest '${boundTo.legacyDirtyDigest}', which does not match the current uncommitted legacy tree '${context.legacyDirtyDigest}'. Evidence from before an uncommitted legacy change never satisfies a gate.`,
    );
  }
  if (boundTo.targetDirtyDigest !== context.targetDirtyDigest) {
    throw new Error(
      `${label} is bound to target dirty-tree digest '${boundTo.targetDirtyDigest}', which does not match the current uncommitted target tree '${context.targetDirtyDigest}'. Evidence from before an uncommitted target change never satisfies a gate.`,
    );
  }
  if (Date.parse(entry.producedAt) < Date.parse(context.freshSince)) {
    throw new Error(
      `${label}.producedAt (${entry.producedAt}) predates the most recently pinned legacy revision or requirements digest (${context.freshSince}). Evidence timestamped before the thing it claims to satisfy was pinned is stale by construction.`,
    );
  }
  return entry;
};

/** When `legacyRevision`/`requirementsAuthority` were last pinned, for the
 * gate-evidence freshness check. Both are fixed at bootstrap; `legacyRevision`
 * can move forward again via a `REFRESHED` history event. */
const pinnedInputTimestamps = async (root, state) => {
  const events = await readHistoryEvents(root);
  let legacyRevisionPinnedAt = state.createdAt;
  for (const event of events) {
    if (
      // A stale-evidence reopen (`from` FINALIZE/ACTIVE) never re-pins the
      // legacy revision, so it must not age the gate evidence bound to it.
      (event.event === "REFRESHED" ||
        (event.event === "UI_REMEDIATION_REOPENED" &&
          !["FINALIZE", "ACTIVE"].includes(event.from)) ||
        (event.event === "COMPLETE_REOPENED" && event.toLegacyRevision)) &&
      typeof event.at === "string"
    ) {
      if (
        legacyRevisionPinnedAt === undefined ||
        event.at > legacyRevisionPinnedAt
      ) {
        legacyRevisionPinnedAt = event.at;
      }
    }
  }
  return {
    requirementsAuthorityPinnedAt: state.createdAt,
    legacyRevisionPinnedAt,
  };
};

const validateGates = async (root, state, roots) => {
  const document = assertPlainObject(
    await readJson(path.join(root, initialArtifacts.gates), "Final gates"),
    "Final gates",
  );
  const gates = assertArray(document.gates, "Final gates");
  const names = assertUniqueIds(
    gates.map((row) => ({ ...row, id: row.gate })),
    "Final gates",
  );
  if (
    names.size !== FINAL_GATES.length ||
    FINAL_GATES.some((gate) => !names.has(gate))
  ) {
    throw new Error(
      "gates.json must contain exactly the seven mandatory gates.",
    );
  }

  const currentLegacyRevision = await gitRevision(roots.legacyRoot);
  const currentTargetRevision = await gitRevision(roots.targetRoot);
  const currentLegacyDirty = await dirtyManifest(roots.legacyRoot);
  const currentTargetDirty = await dirtyManifest(
    roots.targetRoot,
    TARGET_DIRTY_SCOPE,
  );
  const { requirementsAuthorityPinnedAt, legacyRevisionPinnedAt } =
    await pinnedInputTimestamps(root, state);
  const freshSince =
    requirementsAuthorityPinnedAt > legacyRevisionPinnedAt
      ? requirementsAuthorityPinnedAt
      : legacyRevisionPinnedAt;
  const bindingContext = {
    target: state.targetModule,
    legacyRevision: currentLegacyRevision.revision,
    targetRevision: currentTargetRevision.revision,
    requirementsDigest: state.requirementsAuthority.digest,
    dataSourceMode: state.dataSourceMode,
    legacyDirtyDigest: currentLegacyDirty.digest,
    targetDirtyDigest: currentTargetDirty.digest,
    freshSince,
  };

  for (const gate of gates) {
    if (gate.result !== "PASS") {
      throw new Error(`Gate ${gate.gate} is not PASS.`);
    }
    if (
      !Number.isInteger(gate.attempts) ||
      gate.attempts < 1 ||
      gate.attempts > 3
    ) {
      throw new Error(`${gate.gate} attempts must be between 1 and 3.`);
    }
    const evidence = assertArray(gate.evidence, `${gate.gate}.evidence`);
    if (evidence.length === 0) {
      throw new Error(`${gate.gate} requires concrete evidence.`);
    }
    for (const [index, entry] of evidence.entries()) {
      const label = `${gate.gate}.evidence[${index}]`;
      assertEvidenceEntry(entry, label, bindingContext);
      await assertEvidenceReference(entry, label, roots);
    }
  }
  for (const [gateName, kind] of PONYTAIL_GATE_EVIDENCE[state?.ponytail] ??
    []) {
    const gateRow = gates.find((row) => row.gate === gateName);
    const evidence = gateRow?.ponytailEvidence;
    if (!isPlainObject(evidence)) {
      throw new Error(
        `Ponytail target '${state.ponytail}' requires gate ${gateName} to record a ponytailEvidence object of kind "${kind}".`,
      );
    }
    // The type/binding/freshness check runs first; Ponytail's `kind`
    // requirement is layered on top of it, never a substitute for it.
    assertEvidenceEntry(
      evidence,
      `${gateName}.ponytailEvidence`,
      bindingContext,
    );
    await assertEvidenceReference(
      evidence,
      `${gateName}.ponytailEvidence`,
      roots,
    );
    if (evidence.kind !== kind) {
      throw new Error(
        `Ponytail target '${state.ponytail}' requires gate ${gateName} to record ponytailEvidence of kind "${kind}", found "${evidence.kind}".`,
      );
    }
  }
  return gates;
};

// Contract 5 decision 1.4: the brief is immutable once recorded.
const assertBriefUnchanged = async (root, state) => {
  if (!state.brief) return;
  const filePath = path.join(root, state.brief.path);
  if (!(await fileExists(filePath))) {
    throw new Error(
      `Recorded migration brief is missing: ${state.brief.path}.`,
    );
  }
  if (!(await fileIdentityMatches(state.brief.digest, filePath))) {
    throw new Error(
      `Recorded migration brief changed: ${state.brief.path}. The brief is an immutable loaded input.`,
    );
  }
};

const validateStep = async (root, state, step, sliceId, roots) => {
  if (!MIGRATION_STEPS.includes(step)) {
    throw new Error(`Unknown migration step '${step}'.`);
  }
  await assertStepDocumentComplete(root, step);
  if (step === "DISCOVER_LEGACY") {
    const inventory = await validateLegacyInventory(root, roots, state);
    await assertLegacyDiscoveryChecklist(
      root,
      roots,
      state?.requirementsAuthority,
    );
    if (usesDiscoveryCompleteness(state)) {
      const boundary = await readCanonicalModuleBoundary(root, state, roots);
      await assertLegacyEvidenceWithinBoundary(inventory, boundary.scan, roots);
      return boundary;
    }
  }
  if (step === "DISCOVERY_COMPLETENESS") {
    // Returned so advanceUnderLock writes the same scan it validated instead
    // of running it a second time and pinning a different one.
    return validateDiscoveryCompleteness(root, state, roots);
  }
  if (step === "ASSESS_TARGET") {
    const legacy = await validateLegacyInventory(root, roots, state);
    await validateTargetInventory(root, roots, legacy, state);
    await assertTargetAssessmentChecklist(
      root,
      roots,
      state?.requirementsAuthority,
    );
    // Runs before completedArtifactHashes pins the file, so an absent or
    // unbound authority context fails here instead of as a raw ENOENT out of
    // hashFile -- the fail-closed ordering, now for either authority.
    const authority = visualAuthorityOf(state);
    if (authority) {
      await authority.validateContext(root, state, undefined, legacy);
    }
  }
  if (step === "BUILD_BASELINE") await validateBaseline(root, { roots, state });
  // Returned so advanceMigration reuses this traversal instead of repeating it.
  if (step === "PLAN") return validatePlan(root, state, roots);
  if (step === "IMPLEMENT_SLICES") {
    const implemented = sliceId ?? state.activeSlice;
    await validateImplementedSlice(root, implemented, state, roots);
    if (state.currentStep === step && implemented === state.activeSlice) {
      const unlisted = await unlistedSliceFiles(root, state, roots, implemented);
      if (unlisted.length > 0) {
        throw Object.assign(
          new Error(
            `SLICE_FILES_UNLISTED: ${implemented} leaves ${unlisted.length} changed file(s) inside its scope out of its changedFiles: ${unlisted.join(", ")}. Add them to this slice's changedFiles (or revert them). Nothing was written.`,
          ),
          { unlistedChangedFiles: unlisted },
        );
      }
    }
  }
  if (step === "VERIFY_SLICES") {
    return withUiProofReopenHint(
      root,
      sliceId ?? state.activeSlice,
      state,
      roots,
    );
  }
  if (step === "FINALIZE") {
    if (state.pendingSlices.length > 0) {
      throw new Error("Cannot finalize while slices remain pending.");
    }
    await assertDiscoveryUnchanged(root, state, roots);
    await validateBaseline(root, { final: true, roots, state });
    const { slices, capabilityRows } = await validatePlan(root, state, roots);
    await assertArtifactPrerequisites(state, roots, {
      capabilityRows,
      slices,
      all: true,
    });
    // Absence-of-negative first: an unresolved, unpreserved, mutated or deleted
    // failure must be named as such, before a gate list can report PASS over it.
    await assertNoNavigationRepairNeeded(root, state);
    await assertNoUnresolvedVerification(root, state, slices);
    for (const slice of slices) {
      await withUiProofReopenHint(root, slice.id, state, roots);
    }
    await assertNoUnclaimedTargetDrift(
      root,
      state,
      roots,
      slices,
      await sliceDriftFacts(state, roots),
      engineCommand,
    );
    await validateGates(root, state, roots);
    await assertGatesCoverSliceScenarios(root, state, slices);
  }
};

/**
 * W5-2. `reconcileSliceState` is a *repair*: it rewrites navigation to match
 * evidence and records what it repaired. Repair is right for an interrupted
 * session and wrong for a FINALIZE precondition -- a FINALIZE reached only
 * because navigation was adjusted underneath it has not been proven.
 */
const assertNoNavigationRepairNeeded = async (root, state) => {
  if (!usesSliceRework(state)) return;
  const inspected = await inspectSliceArtifacts(root);
  const repairs = [];
  const verified = new Set(inspected.verifiedSlices);
  const unverified = inspected.plannedSlices.filter(
    (sliceId) => !verified.has(sliceId),
  );
  if (unverified.length > 0) {
    repairs.push(
      `slices ${unverified.join(", ")} are not verified by their own artifacts`,
    );
  }
  const recordedComplete = new Set(state.completedSlices ?? []);
  const disagreeing = inspected.plannedSlices.filter(
    (sliceId) => recordedComplete.has(sliceId) !== verified.has(sliceId),
  );
  if (disagreeing.length > 0) {
    repairs.push(
      `state.completedSlices disagrees with the artifacts for ${disagreeing.join(", ")}`,
    );
  }
  if (repairs.length > 0) {
    throw new Error(
      `FINALIZE refuses to advance on repaired navigation: ${repairs.join("; ")}. Resume may reconcile a record; the transition into FINALIZE may not. Fix the artifacts, then advance.`,
    );
  }
};

/**
 * Track A4: the census facts slices/ drift classification reads -- whether the
 * record adopted an existing target, and the legacy source binding a format-19
 * drift candidate is bound to -- read here and handed over as data. The binding
 * is settled, so a failed read is raised where classification consumes it.
 */
export const sliceDriftFacts = async (state, roots) => ({
  brownfield: isBrownfield(state),
  legacySource:
    usesDirectLedgerDecisions(state) && roots?.targetRoot
      ? await settleFact(legacySourceBinding(roots.legacyRoot))
      : null,
});

/**
 * The IMPLEMENT gate. The paths VERIFY_SLICES would report as unclaimed drift
 * inside the active slice's planned scope -- dirty, listed by no slice, deferred
 * to no later pending slice -- and that this slice could list (its record
 * still validates with the path added). The agent lists them or
 * reverts them; the engine writes nothing and decides nothing. A path the slice
 * cannot list keeps its VERIFY/FINALIZE drift handling.
 */
const unlistedSliceFiles = async (root, state, roots, sliceId) => {
  const found = await unlistedSliceCandidates(
    root,
    state,
    roots,
    sliceId,
    await sliceDriftFacts(state, roots),
  );
  const unlisted = [];
  for (const relative of found?.candidates ?? []) {
    const listable = await validateImplementedSlice(root, sliceId, state, roots, {
      ...found.record,
      changedFiles: [...found.record.changedFiles, relative],
    }).then(() => true, () => false);
    if (listable) unlisted.push(relative);
  }
  return unlisted;
};

/**
 * `--amend-slice`: every fact the preview shows and the locked execution
 * re-proves, from fresh reads. Each refusal is a named blocker; the amendment
 * itself is computed only once none remain. Track A4: the rules are in
 * slices/; this seam supplies the validated plan and the census facts, and
 * revalidates the amended record as an implementation between the two halves.
 */
const sliceAmendmentFor = async (root, state, roots, sliceId, addFiles) => {
  const draft = await draftSliceAmendment(
    root,
    state,
    roots,
    sliceId,
    addFiles,
    await validatePlan(root, state, roots),
  );
  if (!draft.amended) return draft;
  try {
    await validateImplementedSlice(root, sliceId, state, roots, draft.amended);
  } catch (error) {
    draft.refuse(`would leave an invalid slice record: ${error.message}`);
    return draft.blocked();
  }
  return completeSliceAmendment(
    root,
    state,
    roots,
    sliceId,
    draft,
    await sliceDriftFacts(state, roots),
  );
};

// Compatibility (Track A4): the BASE three-argument reader, with the census
// facts read here. `record-decision.mjs` calls slices/ directly.
const pendingTargetDriftCandidatesCompat = async (root, state, roots) =>
  pendingTargetDriftCandidates(root, state, roots, await sliceDriftFacts(state, roots));
export { pendingTargetDriftCandidatesCompat as pendingTargetDriftCandidates };

const readContext = async ({
  registryPath,
  moduleName,
  targetOverride,
  legacy,
}) => {
  const registryData = await readRegistry(registryPath);
  assertSafeName(moduleName);
  const legacySources = resolveLegacySources(legacy);
  let resolved;
  try {
    // With `--legacy` the bare positional *is* the target module (there is no
    // single legacy name left for it to be), so it resolves to itself unless
    // the operator says otherwise.
    resolved = resolveModule(
      registryData,
      moduleName,
      targetOverride ?? (legacySources.length > 0 ? moduleName : undefined),
    );
  } catch (error) {
    if (targetOverride !== undefined || !/not registered/.test(error.message)) {
      throw error;
    }
    const candidatePath = statePathFor(registryData.targetRoot, moduleName);
    if (!(await fileExists(candidatePath))) throw error;
    const state = validateStateShape(
      await readJson(candidatePath, "Migration state"),
    );
    resolved = {
      // The record key, whichever identity rule the record was born under:
      // `migrationId` is the legacy module at format <= 14 and the target
      // module at format >= 15, which is exactly the directory it lives in.
      canonical: state.migrationId,
      target: state.targetModule,
      registered: false,
    };
  }
  resolved.legacySources = legacySources;
  resolved.legacyModule = legacySources[0] ?? resolved.canonical;
  // The record key is `migrationId`, and the two identity rules disagree about
  // what that is: the legacy module for a record born at format <= 14, the
  // target module from format 15 on. An existing legacy-keyed record therefore
  // keeps the directory and lock it was born with, and everything else -- a new
  // record, or an already target-keyed one -- keys on the target.
  if (
    resolved.canonical !== resolved.target &&
    !(await fileExists(
      statePathFor(registryData.targetRoot, resolved.canonical),
    ))
  ) {
    resolved.canonical = resolved.target;
  }
  const candidatePath = statePathFor(
    registryData.targetRoot,
    resolved.canonical,
  );
  if (await fileExists(candidatePath)) {
    const persisted = await readJson(candidatePath, "Migration state");
    if (persisted.registry !== undefined) {
      const current = registryIdentity(
        registryData.targetRoot,
        registryData.registryPath,
      );
      if (persisted.registry !== current) {
        throw new Error(
          `Migration registry binding mismatch: existing migration state records '${persisted.registry}', but the resolved registry identity is '${current}'.`,
        );
      }
    }
  }
  return { registryData, resolved };
};

export const readMigrationContext = readContext;

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
        : `OpenSpec source '${requirementsSourceFor(resolved.target)}' is validly absent at NOT_STARTED/RESOLVE because RESOLVE creates it. Generate the evidence-based proposal in memory and rerun this read-only preview with that proposal.`;
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

export const repairSliceState = async (targetRoot, moduleName) =>
  withModuleLock(targetRoot, moduleName, async () => {
    const { state, statePath, root } = await readState(targetRoot, moduleName);
    assertRecordToolkitIdentity(state, moduleName, "Repairing this migration's slice state");
    assertNoPendingFormatUpgrade(
      state,
      moduleName,
      "Repairing this migration's slice state",
    );
    const reconciliation = await reconcileSliceState(root, state);
    const artifactHashes = { ...state.artifactHashes };
    const hashRepairs = [];
    for (const sliceId of reconciliation.state.completedSlices) {
      for (const relative of [
        `slices/${sliceId}.json`,
        `evidence/${sliceId}/result.json`,
      ]) {
        // A pin the shared matcher still accepts is not a corrupted pin, so a
        // checkout that only re-spelled line endings must not be "repaired"
        // into a rewritten record.
        if (
          !(await pinnedArtifactMatches(root, relative, artifactHashes[relative]))
        ) {
          hashRepairs.push(`re-pinned corrected ${relative}`);
          artifactHashes[relative] = await hashPinnedArtifact(root, relative);
        }
      }
    }
    const repairs = [...reconciliation.repairs, ...hashRepairs];
    if (repairs.length === 0) return { changed: false, repairs };
    const repaired = {
      ...reconciliation.state,
      artifactHashes,
      nextAction:
        reconciliation.state.currentStep === "VERIFY_SLICES"
          ? `Verify slice ${reconciliation.state.activeSlice}.`
          : reconciliation.state.currentStep === "IMPLEMENT_SLICES"
            ? `Implement slice ${reconciliation.state.activeSlice}.`
            : `Complete ${STEP_FILES[reconciliation.state.currentStep]}.`,
      revision: state.revision + 1,
      updatedAt: now(),
    };
    const event = {
      event: "SLICE_STATE_RECONCILED",
      currentStep: repaired.currentStep,
      activeSlice: repaired.activeSlice,
      completedSlices: repaired.completedSlices,
      repairs,
      revision: repaired.revision,
    };
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = (await fileExists(integrityPath))
      ? await readFile(integrityPath, "utf8")
      : null;
    const nextIntegrity = await renderIntegrityNow(root, repaired, event);
    await assertHistoryAppendable(targetRoot, root);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: repaired.revision,
      event,
      startedAt: now(),
      pid: process.pid,
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    await atomicWrite(targetRoot, integrityPath, nextIntegrity);
    await atomicWrite(targetRoot, statePath, renderState(repaired));
    await appendHistoryOnce(targetRoot, root, event);
    await rm(journalFile, { force: true });
    return { changed: true, repairs, state: repaired };
  });

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
 * Reopen DISCOVER_LEGACY from DISCOVERY_COMPLETENESS.
 *
 * The census found a file the inventory never described, so the fix is in
 * `inventories/legacy.json` -- which DISCOVER_LEGACY closed and pinned. This
 * is the only way back to it, and it is legal only from the checkpoint
 * immediately after, so nothing downstream can exist to lose. `--refresh`
 * would also work, but it invalidates the entire migration for what is a
 * one-step correction.
 *
 * Operator decisions are deliberately *not* invalidated: they bind to the
 * discovery digest, so a reopen that changes no fact leaves them valid, and a
 * reopen that changes the facts invalidates them by itself.
 */
const reopenDiscoveryUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
}) => {
  if (state.currentStep !== "DISCOVERY_COMPLETENESS") {
    throw new Error(
      `--reopen-discovery is legal only from DISCOVERY_COMPLETENESS; the current checkpoint is '${state.currentStep}'. Nothing was changed. Use --refresh --confirm-mismatch to invalidate a migration from a later checkpoint.`,
    );
  }
  const artifactHashes = { ...state.artifactHashes };
  for (const relative of IMMUTABLE_STEP_ARTIFACTS.DISCOVER_LEGACY) {
    delete artifactHashes[relative];
  }
  const reopened = {
    ...state,
    status: "ACTIVE",
    currentStep: "DISCOVER_LEGACY",
    activeSlice: null,
    completedSteps: state.completedSteps.filter(
      (step) => step !== "DISCOVER_LEGACY",
    ),
    pendingSteps: stepsFor(state).filter(
      (step) => step === "DISCOVER_LEGACY" || state.pendingSteps.includes(step),
    ),
    invalidatedArtifacts: [...IMMUTABLE_STEP_ARTIFACTS.DISCOVER_LEGACY],
    evidenceFreshness: "STALE",
    nextAction:
      "Describe the files the census found but the inventory does not, then close DISCOVER_LEGACY again.",
    nextCommand: `/start-migration ${resolved.canonical}`,
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "REOPENED",
    from: "DISCOVERY_COMPLETENESS",
    step: "DISCOVER_LEGACY",
    revision: reopened.revision,
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = (await fileExists(integrityPath))
    ? await readFile(integrityPath, "utf8")
    : null;
  const nextIntegrity = await renderIntegrityNow(root, reopened, event);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(path.join(root, ADVANCE_JOURNAL), {
    fromRevision: state.revision,
    toRevision: reopened.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reopened));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(path.join(root, ADVANCE_JOURNAL), { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reopened,
    nextArtifact: activeArtifact(reopened),
    resolved,
  };
};

/**
 * W3-2. The operator transition. Runs under the module lock, in one journalled
 * transaction, in exactly this order:
 *
 *   1. preserve the failed attempt byte-for-byte, plus every file its defects
 *      name, under `rework/<slice>-<n>/`;
 *   2. pin every preserved path into `artifactHashes` permanently;
 *   3. only then release `slices/<slice>.json` and `evidence/<slice>/result.json`
 *      and move back to IMPLEMENT_SLICES on the same slice.
 *
 * If 1 or 2 fails the transaction aborts and nothing is unpinned.
 */
const reworkSliceUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  sliceId,
}) => {
  const { writes, reworked, event } = await planSliceRework({
    root,
    state,
    sliceId,
    roots: {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    },
    canonical: resolved.canonical,
  });

  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, reworked, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: reworked.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    // Recovery removes a half-written preserved tree rather than leaving a
    // partial attempt pinned. The current result is untouched until step 3, so
    // there is nothing of the failure to restore.
    restore: writes.map(([relative]) => ({ path: relative, remove: true })),
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  for (const [relative, bytes] of writes) {
    await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
  }
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reworked));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reworked,
    nextArtifact: activeArtifact(reworked),
    resolved,
  };
};

/**
 * `--amend-slice`: add files to a reopened slice's pinned record, in one
 * journalled transaction and in exactly this order -- preserve the prior bytes,
 * write the amended record, re-pin both, append SLICE_SCOPE_AMENDED. No FAIL,
 * no rework attempt, no step or slice movement, no plan change.
 */
const amendSliceUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  sliceId,
  addFiles,
  authorization = null,
  hooks,
}) => {
  // Refused before a byte moves, and before the amendment is even computed: an
  // unbranded authorization is a caller authoring its own audit field.
  const authorizedBy = sequenceAuthorizationEvidence(authorization);
  // Re-proven under the lock from fresh reads; bootstrapUnderLock has already
  // matched every pin, `slices/<id>.json` included, immediately before this.
  const { blockers, sliceAmendment, priorBytes, amendedBytes } =
    await sliceAmendmentFor(
      root,
      state,
      { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot },
      sliceId,
      addFiles,
    );
  if (blockers.length > 0) {
    throw new Error(`${blockers.join(" ")} Nothing was written.`);
  }
  const recordRelative = `slices/${sliceId}.json`;
  const { preservesAs } = sliceAmendment;
  const amendedState = {
    ...state,
    evidenceFreshness: "STALE",
    nextAction: `Recapture Playwright TARGET UI evidence for ${state.activeSlice}, bound to the amended implementation of '${sliceId}'.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    artifactHashes: {
      ...state.artifactHashes,
      [recordRelative]: contentIdentity(
        path.join(root, recordRelative),
        Buffer.from(amendedBytes, "utf8"),
      ),
      [preservesAs]: hashContent(priorBytes),
    },
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "SLICE_SCOPE_AMENDED",
    step: "VERIFY_SLICES",
    slice: sliceId,
    amendment: sliceAmendment.amendment,
    added: sliceAmendment.add.map((file) => file.path),
    priorSliceDigest: sliceAmendment.sliceRecordDigestBefore,
    sliceDigest: sliceAmendment.sliceRecordDigestAfter,
    implementationDigestBefore: sliceAmendment.implementationDigestBefore,
    implementationDigestAfter: sliceAmendment.implementationDigestAfter,
    preserved: [preservesAs],
    revision: amendedState.revision,
    // Only an operation that actually executed carries this. An approved
    // member that was never reached writes no event at all, so there is no
    // place for it to claim an authorization it did not spend.
    ...(authorizedBy ? { authorizedBy } : {}),
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, amendedState, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: amendedState.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    restore: [
      { path: preservesAs, remove: true },
      { path: recordRelative, content: priorBytes.toString("utf8") },
    ],
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  // The preserved copy lands first, so no reachable state has replaced a
  // record that was not already kept.
  await atomicWrite(registryData.targetRoot, path.join(root, preservesAs), priorBytes);
  await atomicWrite(
    registryData.targetRoot,
    path.join(root, recordRelative),
    amendedBytes,
  );
  await hooks?.afterWrite?.("slice");
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(amendedState));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    amended: true,
    statePath,
    migrationRoot: root,
    state: amendedState,
    nextArtifact: activeArtifact(amendedState),
    resolved,
  };
};

/**
 * `--adopt-visual-contract`: the one way a pre-17 figma-mcp record opts into
 * the format-17 visual contract. Read-only; shared by the preview and the
 * transition so both refuse for the same reasons.
 *
 * Eligible only as a COMPLETE, pre-17, figma-mcp record, so no transition can
 * be in flight and the adoption can never double as a refresh, replan, or
 * reset. Fails closed unless fresh canonical evidence authored at
 * FIGMA_CONTEXT_ADOPTION_FILE and VISUAL_ACCEPTANCE_FILE validate under the
 * unweakened format-17 rules. Nothing is derived from the old context.
 *
 * Affected slices are exactly those whose verified evidence holds a TARGET
 * UI row: each binds the old `figmaContextDigest`, so none can verify under
 * the new pin. A COMPLETE record has no non-terminal design row (FINALIZE
 * refused one), so no other slice can fail format-17 verification.
 */
const visualContractAdoptionPlan = async (root, state, roots, allowActive = false) => {
  const refuse = (message) => ({
    blockers: [message],
    affectedSlices: [],
    evidenceDigest: null,
  });
  if (!(usesDesignSource(state) && state.designSource === "figma-mcp")) {
    return refuse(
      `--adopt-visual-contract applies only to a designSource: figma-mcp migration; this record's design source is '${state.designSource ?? "target-system"}'.`,
    );
  }
  if (usesVisualAcceptance(state)) {
    return refuse(
      `--adopt-visual-contract moves a pre-format-${VISUAL_ACCEPTANCE_FORMAT} record onto the visual contract once; this record is already format ${state.formatVersion}. It is not a refresh, replan, or reset.`,
    );
  }
  if (state.status !== "COMPLETE" && !(allowActive && state.status === "ACTIVE")) {
    return refuse(
      `--adopt-visual-contract is legal only for a COMPLETE migration; the current status is '${state.status}' at '${state.currentStep}'.`,
    );
  }
  if (await fileExists(path.join(root, ADOPTION_ROOT))) {
    return refuse(
      `${ADOPTION_ROOT}/ already exists. A record adopts the visual contract once.`,
    );
  }
  const adopted = { ...state, formatVersion: VISUAL_ACCEPTANCE_FORMAT };
  try {
    const legacy = await validateLegacyInventory(root, roots, adopted);
    const target = await validateTargetInventory(root, roots, legacy, adopted);
    await validateVisualAcceptance(
      root,
      adopted,
      legacy,
      target,
      FIGMA_CONTEXT_ADOPTION_FILE,
    );
  } catch (error) {
    return refuse(
      `Visual contract adoption fails closed: ${error.message} Author fresh format-${VISUAL_ACCEPTANCE_FORMAT} evidence from the Figma MCP at ${FIGMA_CONTEXT_ADOPTION_FILE}, and ${VISUAL_ACCEPTANCE_FILE} from it.`,
    );
  }
  const affectedSlices = [];
  for (const sliceId of [
    ...state.completedSlices,
    ...(allowActive && state.currentStep === "VERIFY_SLICES" && state.activeSlice
      ? [state.activeSlice]
      : []),
  ]) {
    const evidence = await readFile(
      path.join(root, `evidence/${sliceId}/result.json`),
      "utf8",
    ).then(JSON.parse, () => null);
    if (
      (evidence.uiEvidence ?? []).some(
        (record) => (record.origin ?? "TARGET") === "TARGET",
      )
    ) {
      affectedSlices.push(sliceId);
    }
  }
  return {
    blockers: [],
    affectedSlices,
    evidenceDigest: `sha256:${hashContent(
      JSON.stringify([
        await hashFile(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE)),
        await hashFile(path.join(root, VISUAL_ACCEPTANCE_FILE)),
      ]),
    )}`,
  };
};

/**
 * One journalled transaction: preserve the prior context byte-for-byte, swap
 * the fresh evidence in, pin the contract, stamp format 17, and write an
 * immutable adoption record. No step, slice, approval, or evidence pin moves;
 * the affected slices are named and must be reopened with --reopen-ui before
 * the record resumes.
 *
 * ponytail: the record stays COMPLETE until that reopen, guarded by a resume
 * blocker. Ceiling: a reader of `status` alone misses it. Upgrade path: fold
 * the reopen into this transaction.
 */
/** The one command the fail-closed identity message ever names. */
const TOOLKIT_IDENTITY_SCRIPT = "cli/toolkit-identity.mjs";

export const toolkitAdoptCommand = (name, kind = "module") =>
  engineCommand(TOOLKIT_IDENTITY_SCRIPT, "adopt", `--${kind}`, name);

/**
 * The gate. Every module path that is about to write to a record calls this
 * first; no read-only path calls it at all.
 *
 * It is deliberately not folded into `readState`: status, validation and
 * decision *listing* must keep working on an unstamped or mismatched record --
 * refusing to let an operator look at a record is how a fail-closed gate turns
 * into an outage -- while every mutation must stop before the first byte.
 */
export const assertRecordToolkitIdentity = (state, name, action, kind = "module") => {
  const blocker = toolkitIdentityBlocker(
    state.toolkitIdentity ?? null,
    activeToolkitIdentity(),
    { action, adoptCommand: toolkitAdoptCommand(name, kind) },
  );
  if (blocker) throw Object.assign(new Error(blocker), { toolkitIdentity: true });
};

/**
 * Adoption under `--mode auto`, run before the gate rather than instead of it.
 *
 * Which build may write to a record is implementation metadata, not a migration
 * decision -- no contract, format, workflow value or pin depends on it -- and
 * the running toolkit is the authoritative source for its own identity. So
 * "this record pins 1.2.3 and I am 1.2.4" is answerable from evidence already
 * in hand, and making a human type the adopt command added a stop without
 * adding a judgement.
 *
 * It routes through `changeModuleToolkitIdentity`, so an auto adoption is the
 * same journalled transaction as a typed one and leaves the same
 * `TOOLKIT_IDENTITY_ADOPTED`/`TOOLKIT_IDENTITY_CHANGED` history event naming
 * `previous` and `next`. Nothing is adopted silently; it is adopted and
 * recorded.
 *
 * Returns `null` without writing when there is nothing to decide from: under
 * `step` a human owns the call, and a source checkout carries no
 * `build-identity.json`, so it has no identity to prove or stamp. That second
 * case is a genuine external blocker -- the gate below still refuses it, and
 * the remedy is to install a released toolkit.
 */
export const autoAdoptToolkitIdentity = async ({
  registryPath,
  moduleName,
  mode,
  // A bootstrap has no record to stamp yet; `bootstrapMigration` stamps the one
  // it creates. Passed rather than probed so this never swallows a read error
  // that means something else.
  started = true,
}) => {
  if (!started || !isAutoAuthority(mode)) return null;
  const active = activeToolkitIdentity();
  if (!active) return null;
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { state } = await readState(registryData.targetRoot, resolved.canonical);
  // `autoAdoptableToolkitTransition` is the whole decision, and it is narrow:
  // an unstamped record, or a strictly newer release of the same toolkit. A
  // mismatch that is not a forward upgrade -- a downgrade, or the same version
  // built twice -- returns `null` and falls through to the gate below, which
  // refuses it exactly as it always has. AUTO adopts what is verifiable; it
  // never adopts its way past a safety check.
  const transition = autoAdoptableToolkitTransition(state.toolkitIdentity ?? null, active);
  if (!transition) return null;
  return changeModuleToolkitIdentity({ registryPath, moduleName, mode: transition });
};

/**
 * Mismatch-only refusal, for the paths that legitimately operate on a record no
 * identity can have been adopted on yet.
 *
 * The v4->v5 upgrade coordinator is the whole reason this exists: a v4 tree
 * predates the standalone toolkit *and* cannot be opened by `readState`, so
 * demanding adoption first would make it permanently un-upgradable. It may
 * therefore run unstamped -- and the v5 record it produces is unstamped too, so
 * the very next lifecycle mutation still demands explicit adoption. What it may
 * never do is run against a record that pins a *different* build.
 */
export const assertToolkitIdentityNotMismatched = (recorded, action) => {
  if (!recorded) return;
  const blocker = toolkitIdentityBlocker(recorded, activeToolkitIdentity(), {
    action,
    adoptCommand: "",
  });
  if (blocker) throw Object.assign(new Error(blocker), { toolkitIdentity: true });
};

/**
 * Adopt, update or roll back the toolkit identity of one module record.
 *
 * Engine maintenance, not an operator migration decision and not a lifecycle
 * transition: it moves no step, no slice and no pin, creates no decision, and
 * touches no decision id, sequence, rationale digest, decision digest or ledger
 * hash. It runs the same journalled ordering as every other durable transition
 * -- prove history is appendable, record the intent, write the integrity
 * anchor, write state, append exactly one event, drop the journal -- so a death
 * in any gap is finished by `recoverPendingAdvance` on the next command.
 *
 * It then stops. The lifecycle resumes on the next invocation, so an adoption
 * can never be mistaken for, or ride along with, a checkpoint advance.
 */
export const changeModuleToolkitIdentity = async ({
  registryPath,
  moduleName,
  mode = "adopt",
}) => {
  if (!["adopt", "update", "rollback"].includes(mode)) {
    throw new Error(`Unknown toolkit identity mode '${mode}'.`);
  }
  const active = activeToolkitIdentity();
  if (!active) {
    throw new Error(
      "The running engine is a source checkout with no build-identity.json and has no identity to stamp. Install a released toolkit bundle and run this against that installation. Nothing was written.",
    );
  }
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  return withModuleLock(registryData.targetRoot, resolved.canonical, async () => {
    const root = migrationRoot(registryData.targetRoot, resolved.canonical);
    const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
    // An interrupted lifecycle transition is completed before the record is
    // read, exactly as every other locked operation does it. Adoption never
    // stamps a half-written record.
    await recoverPendingAdvance(registryData.targetRoot, root, statePath);
    // Full integrity validation: anchor, append-only history and decision
    // ledger, and the state-graph replay. A record that cannot be proven
    // consistent is not a record an identity may be pinned to.
    const { state } = await readState(registryData.targetRoot, resolved.canonical);
    const previous = state.toolkitIdentity ?? null;
    if (mode === "adopt" && previous !== null && !sameToolkitIdentity(previous, active)) {
      throw new Error(
        `This record already pins toolkit ${renderToolkitIdentity(previous)}. Adoption is for an unstamped record; use update to move it to ${renderToolkitIdentity(active)}. Nothing was written.`,
      );
    }
    if (mode !== "adopt" && previous === null) {
      throw new Error(
        "This record carries no toolkit identity, so there is nothing to update or roll back. Adopt one first. Nothing was written.",
      );
    }
    // Idempotent and therefore replayable: re-running the command that already
    // succeeded is a no-op, not a second history event.
    if (sameToolkitIdentity(previous, active)) {
      return {
        changed: false,
        statePath,
        migrationRoot: root,
        state,
        previous,
        next: active,
        resolved,
      };
    }
    const at = now();
    const stamped = {
      ...state,
      toolkitIdentity: active,
      revision: state.revision + 1,
      updatedAt: at,
    };
    const event = {
      event: previous === null ? "TOOLKIT_IDENTITY_ADOPTED" : "TOOLKIT_IDENTITY_CHANGED",
      previous,
      next: active,
      at,
      revision: stamped.revision,
    };
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = await readFile(integrityPath, "utf8");
    const nextIntegrity = await renderIntegrityNow(root, stamped, event);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await assertHistoryAppendable(registryData.targetRoot, root);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: stamped.revision,
      event,
      startedAt: at,
      pid: process.pid,
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
    await atomicWrite(registryData.targetRoot, statePath, renderState(stamped));
    await appendHistoryOnce(registryData.targetRoot, root, event);
    await rm(journalFile, { force: true });
    return {
      changed: true,
      statePath,
      migrationRoot: root,
      state: stamped,
      previous,
      next: active,
      resolved,
    };
  });
};

const adoptVisualContractUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  adoption,
}) => {
  const plan = await visualContractAdoptionPlan(root, state, {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  });
  if (plan.blockers.length > 0) {
    throw new Error(`${plan.blockers.join(" ")} Nothing was written.`);
  }
  if (plan.evidenceDigest !== adoption.evidenceDigest) {
    throw new Error(
      "The adoption evidence changed after it was confirmed. Nothing was written; show the summary again and reconfirm.",
    );
  }
  const at = now();
  const previousRelative = `${ADOPTION_ROOT}/figma-context.previous.json`;
  const recordRelative = `${ADOPTION_ROOT}/record.json`;
  const previousBytes = await readFile(path.join(root, FIGMA_CONTEXT_FILE));
  const adoptedBytes = await readFile(
    path.join(root, FIGMA_CONTEXT_ADOPTION_FILE),
  );
  // Both become ordinary `artifactHashes` pins below, so they are content
  // identities. `plan.evidenceDigest` above stays a raw-byte confirmation
  // preimage and is deliberately not routed here.
  const figmaContextDigest = contentIdentity(FIGMA_CONTEXT_FILE, adoptedBytes);
  const visualAcceptanceDigest = await fileIdentity(
    path.join(root, VISUAL_ACCEPTANCE_FILE),
  );
  const record = `${JSON.stringify(
    {
      version: 1,
      transition: "VISUAL_CONTRACT_ADOPTED",
      note: "Adoption of the format-17 Figma visual acceptance contract. Not a legacy refresh, replan, or migration restart.",
      migrationId: state.migrationId,
      fromFormat: state.formatVersion,
      toFormat: VISUAL_ACCEPTANCE_FORMAT,
      at,
      operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
      confirmationId: adoption.confirmationId,
      priorRevision: state.revision,
      previous: {
        figmaContext: previousRelative,
        figmaContextDigest: state.artifactHashes[FIGMA_CONTEXT_FILE],
      },
      adopted: {
        evidenceDigest: plan.evidenceDigest,
        figmaContextDigest,
        visualAcceptanceDigest,
        frames: JSON.parse(adoptedBytes.toString("utf8")).frames.map(
          (frame) => ({
            fileKey: frame.fileKey,
            nodeId: frame.nodeId,
            ...(frame.ancestry && {
              ancestry: {
                sourceNodeId: frame.ancestry.sourceNodeId,
                path: frame.ancestry.path,
                metadata: frame.ancestry.metadata.hash,
              },
            }),
            fidelity: frame.extraction.fidelity,
            sources: Object.fromEntries(
              FIGMA_SOURCE_KINDS.map((kind) => [
                kind,
                [frame.sources[kind]].flat().map((entry) => entry.hash),
              ]),
            ),
          }),
        ),
      },
      affectedSlices: plan.affectedSlices,
    },
    null,
    2,
  )}\n`;
  const preserved = {
    [previousRelative]: hashContent(previousBytes),
    [recordRelative]: hashContent(record),
  };
  const adopted = {
    ...state,
    formatVersion: VISUAL_ACCEPTANCE_FORMAT,
    visualContractAdoption: {
      fromFormat: state.formatVersion,
      toFormat: VISUAL_ACCEPTANCE_FORMAT,
      adoptedAt: at,
      record: recordRelative,
      pendingReverification: plan.affectedSlices,
    },
    ...(plan.affectedSlices.length > 0
      ? {
          invalidatedArtifacts: plan.affectedSlices.map(
            (sliceId) => `evidence/${sliceId}/result.json`,
          ),
          evidenceFreshness: "STALE",
          nextAction: `Visual contract adopted. Reopen the slices whose Figma visual evidence predates it: --reopen-ui ${plan.affectedSlices.join(",")}.`,
        }
      : {}),
    artifactHashes: {
      ...state.artifactHashes,
      ...preserved,
      [FIGMA_CONTEXT_FILE]: figmaContextDigest,
      [VISUAL_ACCEPTANCE_FILE]: visualAcceptanceDigest,
    },
    revision: state.revision + 1,
    updatedAt: at,
  };
  const event = {
    event: "VISUAL_CONTRACT_ADOPTED",
    fromFormat: state.formatVersion,
    toFormat: VISUAL_ACCEPTANCE_FORMAT,
    affectedSlices: plan.affectedSlices,
    preserved: Object.keys(preserved).sort(),
    confirmationId: adoption.confirmationId,
    previousFigmaContextDigest: state.artifactHashes[FIGMA_CONTEXT_FILE],
    figmaContextDigest,
    visualAcceptanceDigest,
    at,
    revision: adopted.revision,
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, adopted, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: adopted.revision,
    event,
    startedAt: at,
    pid: process.pid,
    restore: [
      { path: previousRelative, remove: true },
      { path: recordRelative, remove: true },
      { path: FIGMA_CONTEXT_FILE, content: previousBytes.toString("utf8") },
      {
        path: FIGMA_CONTEXT_ADOPTION_FILE,
        content: adoptedBytes.toString("utf8"),
      },
    ],
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  for (const [relative, bytes] of [
    [previousRelative, previousBytes],
    [recordRelative, record],
    [FIGMA_CONTEXT_FILE, adoptedBytes],
  ]) {
    await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
  }
  await rm(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE));
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(adopted));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    adopted: true,
    statePath,
    migrationRoot: root,
    state: adopted,
    nextArtifact: null,
    resolved,
  };
};

/**
 * UI_OBSERVATIONS_ADOPTED: the one way a pre-18 UI record gains the frozen
 * `requiredObservations` acceptance set. Read-only; shared by the preview and
 * the transaction so both refuse for the same reasons.
 *
 * The candidate is a complete `inventories/legacy.json` authored from legacy
 * runtime/source evidence and the pinned OpenSpec authority, and may differ
 * from the pinned inventory only by the added arrays. No TARGET proof is an
 * input. Affected slices are the completed slices, and a VERIFY_SLICES active
 * slice, whose result holds TARGET UI evidence: that evidence binds the old
 * UI-contract digest. They are preserved, then invalidated and requeued at
 * VERIFY_SLICES (the COMPLETE_REOPENED release shape), never reimplemented.
 */
const uiObservationsAdoptionPlan = async (root, state, combined = false) => {
  const refuse = (message) => ({ blockers: [message] });
  const legacyRelative = initialArtifacts.legacyInventory;
  if (usesRequiredObservations(state)) {
    return refuse(
      `This record is already format ${state.formatVersion}; UI_OBSERVATIONS_ADOPTED moves a pre-${REQUIRED_OBSERVATIONS_FORMAT} record once and is not a correction path.`,
    );
  }
  if (!usesUiVerification(state) || !state.artifactHashes?.[legacyRelative]) {
    return refuse(
      `UI_OBSERVATIONS_ADOPTED needs a pinned format-${UI_VERIFICATION_FORMAT}+ legacy inventory; this record has none to adopt into.`,
    );
  }
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) {
    return refuse(
      `UI_OBSERVATIONS_ADOPTED is legal only for an ACTIVE or COMPLETE migration; the current status is '${state.status}'.`,
    );
  }
  // A pre-17 Figma record may reach 18 only through the combined adoption.
  if (state.designSource === "figma-mcp" && !usesVisualAcceptance(state) && !combined) {
    return refuse(
      `A pre-format-${VISUAL_ACCEPTANCE_FORMAT} figma-mcp record would be promoted into the visual contract by format ${REQUIRED_OBSERVATIONS_FORMAT}; adopt the visual contract first (--adopt-visual-contract).`,
    );
  }
  if (await readAdvanceJournal(root)) {
    return refuse("An advance journal is pending; resume the migration first.");
  }
  if (await fileExists(path.join(root, UI_OBSERVATIONS_ADOPTION_ROOT, "record.json"))) {
    return refuse(`${UI_OBSERVATIONS_ADOPTION_ROOT}/record.json already exists. A record adopts once.`);
  }
  const candidatePath = path.join(root, UI_OBSERVATIONS_CANDIDATE_FILE);
  if (!(await fileExists(candidatePath))) {
    return refuse(
      `No legacy authority to adopt: author ${UI_OBSERVATIONS_CANDIDATE_FILE} from legacy runtime/source evidence and the pinned OpenSpec requirements. TARGET proof cannot supply it.`,
    );
  }
  const candidateBytes = await readFile(candidatePath);
  const current = JSON.parse(await readFile(path.join(root, legacyRelative), "utf8"));
  let candidate;
  try {
    candidate = JSON.parse(candidateBytes.toString("utf8"));
    const frozen = (inventory) =>
      JSON.stringify({
        ...inventory,
        uiBehaviors: (inventory.uiBehaviors ?? []).map(
          ({ requiredObservations: _added, ...rest }) => rest,
        ),
      });
    if (frozen(candidate) !== frozen(current)) {
      throw new Error(
        "The candidate may only add requiredObservations; every other field of the pinned legacy inventory is frozen.",
      );
    }
    if (!candidate.hasVisibleUi) {
      throw new Error("A record with no visible UI has no UI adoption obligation.");
    }
    const seen = new Set();
    for (const item of candidate.uiBehaviors) {
      assertRequiredObservations(item, seen);
    }
  } catch (error) {
    return refuse(`UI observation adoption fails closed: ${error.message}`);
  }
  const affected = [];
  for (const sliceId of [...state.completedSlices, state.activeSlice]) {
    if (!sliceId || affected.includes(sliceId)) continue;
    if (sliceId === state.activeSlice && state.currentStep !== "VERIFY_SLICES") continue;
    const evidence = await readFile(
      path.join(root, `evidence/${sliceId}/result.json`),
      "utf8",
    ).then(JSON.parse, () => null);
    if (
      (evidence?.uiEvidence ?? []).some(
        (record) => (record.origin ?? "TARGET") === "TARGET",
      )
    ) {
      affected.push(sliceId);
    }
  }
  const planned = (await inspectSliceArtifacts(root)).plannedSlices;
  const affectedSlices = planned.filter((sliceId) => affected.includes(sliceId));
  const requeued = affectedSlices.filter((sliceId) =>
    state.completedSlices.includes(sliceId),
  );
  if (
    requeued.length > 0 &&
    state.status === "ACTIVE" &&
    !["VERIFY_SLICES", "FINALIZE"].includes(state.currentStep)
  ) {
    return refuse(
      `Completed UI slices ${requeued.join(", ")} must be requeued at VERIFY_SLICES; advance the active slice to VERIFY_SLICES, then adopt.`,
    );
  }
  const reopen =
    affectedSlices.length > 0 &&
    (state.status === "COMPLETE" ||
      state.currentStep === "FINALIZE" ||
      requeued.length > 0);
  return {
    blockers: [],
    candidate: candidateBytes.toString("utf8"),
    candidateBytes,
    candidateDigest: `sha256:${hashContent(candidateBytes)}`,
    previousLegacyDigest: state.artifactHashes[legacyRelative],
    affectedSlices,
    reopen,
    pendingSlices: reopen
      ? planned.filter(
          (sliceId) =>
            affectedSlices.includes(sliceId) ||
            state.pendingSlices.includes(sliceId) ||
            sliceId === state.activeSlice,
        )
      : state.pendingSlices,
  };
};

const combinedUiAdoptionPlan = async (root, state, roots) => {
  const combined = state.designSource === "figma-mcp" && !usesVisualAcceptance(state);
  const observations = await uiObservationsAdoptionPlan(root, state, combined);
  if (!combined || observations.blockers.length > 0) return observations;
  const visual = await visualContractAdoptionPlan(root, state, roots, true);
  if (visual.blockers.length > 0) return { blockers: visual.blockers };
  return {
    ...observations,
    visualEvidenceDigest: visual.evidenceDigest,
    confirmationDigest: `sha256:${hashContent(JSON.stringify([
      observations.candidateDigest,
      visual.evidenceDigest,
    ]))}`,
    affectedSlices: [...new Set([...observations.affectedSlices, ...visual.affectedSlices])],
  };
};

/** The exact candidate bytes and their digest; confirmation must echo the digest. */
export const previewUiObservationsAdoption = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { state } = await readState(registryData.targetRoot, resolved.canonical);
  const { candidateBytes: _bytes, ...plan } = await combinedUiAdoptionPlan(
    migrationRoot(registryData.targetRoot, resolved.canonical),
    state,
    { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot },
  );
  return plan;
};

/**
 * One journalled transaction: preserve the prior inventory, affected results
 * and FINALIZE gates byte-for-byte and pin them for life, swap the candidate
 * in, move the legacy pin, stamp format 18, release only the affected result
 * and gate pins, and append one UI_OBSERVATIONS_ADOPTED event. Nothing is
 * released before its preserved copy is in the pin set.
 */
export const adoptUiObservations = async ({
  registryPath,
  moduleName,
  candidateDigest,
  confirmationDigest,
  // Set only by `commitFormatUpgrade` for the registered adjacent 17 -> 18 row.
  // It changes the history envelope and nothing else: the transaction, the
  // writes, the pins and the preserved bytes are the same ones the pre-floor
  // explicit adoption has always made, because there is only one of them.
  formatUpgrade = null,
}) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  return withModuleLock(registryData.targetRoot, resolved.canonical, async () => {
    const root = migrationRoot(registryData.targetRoot, resolved.canonical);
    const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
    await recoverPendingAdvance(registryData.targetRoot, root, statePath);
    const { state } = await readState(registryData.targetRoot, resolved.canonical);
    assertRecordToolkitIdentity(state, resolved.canonical, "adopt required UI observations");
    const plan = await combinedUiAdoptionPlan(root, state, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
    if (plan.blockers.length > 0) {
      throw new Error(`${plan.blockers.join(" ")} Nothing was written.`);
    }
    if (plan.confirmationDigest) {
      if (plan.confirmationDigest !== confirmationDigest) {
        throw new Error(
          "The adoption inputs changed after preview, or the complete transition was not confirmed. Nothing was written; preview again and confirm its digest.",
        );
      }
    } else if (plan.candidateDigest !== candidateDigest) {
      throw new Error(
        "The candidate changed after it was previewed, or was never previewed. Nothing was written; preview again and confirm its digest.",
      );
    }
    const at = now();
    const legacyRelative = initialArtifacts.legacyInventory;
    const keep = (relative) => `${UI_OBSERVATIONS_ADOPTION_ROOT}/${relative}`;
    const previousLegacy = await readFile(path.join(root, legacyRelative));
    const writes = [[keep(legacyRelative), previousLegacy]];
    const rewrites = [
      { relative: legacyRelative, before: previousLegacy, content: plan.candidateBytes },
    ];
    let figmaContextDigest;
    let visualAcceptanceDigest;
    if (plan.confirmationDigest) {
      const previousContext = await readFile(path.join(root, FIGMA_CONTEXT_FILE));
      const adoptedContext = await readFile(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE));
      writes.push([keep(FIGMA_CONTEXT_FILE), previousContext]);
      rewrites.push({
        relative: FIGMA_CONTEXT_FILE,
        before: previousContext,
        content: adoptedContext,
      });
      figmaContextDigest = contentIdentity(FIGMA_CONTEXT_FILE, adoptedContext);
      visualAcceptanceDigest = await fileIdentity(path.join(root, VISUAL_ACCEPTANCE_FILE));
    }
    for (const sliceId of plan.affectedSlices) {
      const relative = `evidence/${sliceId}/result.json`;
      const before = await readFile(path.join(root, relative));
      writes.push([keep(relative), before]);
      rewrites.push({
        relative,
        before,
        content: `${JSON.stringify(
          {
            ...JSON.parse(before.toString("utf8")),
            result: "PENDING",
            uiEvidence: [],
            uiEvidenceLimitations: [],
          },
          null,
          2,
        )}\n`,
      });
    }
    if (plan.reopen) {
      for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
        if (state.artifactHashes[relative]) {
          writes.push([keep(relative), await readFile(path.join(root, relative))]);
        }
      }
    }
    const preserved = {};
    for (const [relative, bytes] of writes) preserved[relative] = hashContent(bytes);
    const legacyDigest = contentIdentity(legacyRelative, plan.candidateBytes);
    const recordRelative = keep("record.json");
    const record = `${JSON.stringify(
      {
        version: 1,
        transition: "UI_OBSERVATIONS_ADOPTED",
        ...(formatUpgrade ? { upgrader: formatUpgrade.upgrader } : {}),
        note: "Adoption of the format-18 required UI observations contract from legacy authority. Not a refresh, replan, or restart; no TARGET proof was an input.",
        migrationId: state.migrationId,
        fromFormat: state.formatVersion,
        toFormat: REQUIRED_OBSERVATIONS_FORMAT,
        at,
        operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
        priorRevision: state.revision,
        priorStatus: state.status,
        priorStep: state.currentStep,
        candidateDigest: plan.candidateDigest,
        ...(plan.confirmationDigest ? {
          confirmationDigest: plan.confirmationDigest,
          visualEvidenceDigest: plan.visualEvidenceDigest,
          previousFigmaContextDigest: state.artifactHashes[FIGMA_CONTEXT_FILE],
          figmaContextDigest,
          visualAcceptanceDigest,
        } : {}),
        previousLegacyDigest: plan.previousLegacyDigest,
        legacyDigest,
        affectedSlices: plan.affectedSlices,
        preserved: { ...preserved },
      },
      null,
      2,
    )}\n`;
    writes.push([recordRelative, Buffer.from(record, "utf8")]);
    preserved[recordRelative] = hashContent(record);

    const artifactHashes = {
      ...state.artifactHashes,
      ...preserved,
      [legacyRelative]: legacyDigest,
      ...(plan.confirmationDigest ? {
        [FIGMA_CONTEXT_FILE]: figmaContextDigest,
        [VISUAL_ACCEPTANCE_FILE]: visualAcceptanceDigest,
      } : {}),
    };
    if (plan.reopen) {
      for (const sliceId of plan.affectedSlices) {
        delete artifactHashes[`evidence/${sliceId}/result.json`];
      }
      for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
        delete artifactHashes[relative];
      }
    }
    const steps = stepsFor(state);
    const activeSlice = plan.reopen ? plan.pendingSlices[0] : state.activeSlice;
    const adopted = {
      ...state,
      formatVersion: REQUIRED_OBSERVATIONS_FORMAT,
      ...(plan.confirmationDigest ? {
        visualContractAdoption: {
          fromFormat: state.formatVersion,
          toFormat: REQUIRED_OBSERVATIONS_FORMAT,
          adoptedAt: at,
          record: recordRelative,
          pendingReverification: [],
        },
      } : {}),
      ...(plan.reopen
        ? {
            status: "ACTIVE",
            currentStep: "VERIFY_SLICES",
            activeSlice,
            completedSteps: steps.slice(0, steps.indexOf("IMPLEMENT_SLICES")),
            pendingSteps: ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"],
            completedSlices: state.completedSlices.filter(
              (sliceId) => !plan.affectedSlices.includes(sliceId),
            ),
            pendingSlices: plan.pendingSlices,
          }
        : {}),
      ...(plan.affectedSlices.length > 0
        ? {
            invalidatedArtifacts: [
              ...plan.affectedSlices.map((sliceId) => `evidence/${sliceId}/result.json`),
              ...(plan.reopen ? IMMUTABLE_STEP_ARTIFACTS.FINALIZE : []),
            ],
            evidenceFreshness: "STALE",
          }
        : {}),
      nextAction: `Required UI observations adopted. Collect fresh ${UI_PROOF_FORMAT} proof and verify ${activeSlice ?? "the pending UI slices"} under the adopted contract.`,
      nextCommand: `/start-migration ${resolved.canonical}`,
      artifactHashes,
      revision: state.revision + 1,
      updatedAt: at,
    };
    const domainEvent = {
      event: "UI_OBSERVATIONS_ADOPTED",
      from: state.status === "COMPLETE" ? "COMPLETE" : state.currentStep,
      fromFormat: state.formatVersion,
      toFormat: REQUIRED_OBSERVATIONS_FORMAT,
      ...(plan.reopen ? { step: "VERIFY_SLICES", activeSlice } : {}),
      slices: plan.affectedSlices,
      candidateDigest: plan.candidateDigest,
      ...(plan.confirmationDigest ? {
        confirmationDigest: plan.confirmationDigest,
        visualEvidenceDigest: plan.visualEvidenceDigest,
        figmaContextDigest,
        visualAcceptanceDigest,
      } : {}),
      previousLegacyDigest: plan.previousLegacyDigest,
      legacyDigest,
      preserved: Object.keys(preserved).sort(),
      at,
      revision: adopted.revision,
    };
    // One event per transaction, so the canonical `FORMAT_UPGRADED` envelope
    // wraps the domain fields instead of adding a second row. The pre-floor
    // explicit adoption keeps writing the historical spelling: rewriting an
    // append-only log is not an option, so both spellings are read forever
    // (`isUiObservationsAdoption`).
    const event = formatUpgrade
      ? {
          ...domainEvent,
          event: "FORMAT_UPGRADED",
          transition: "UI_OBSERVATIONS_ADOPTED",
          domain: "TRANSFORM",
          upgrader: formatUpgrade.upgrader,
          inputs: [
            {
              kind: formatUpgrade.requiredInput?.kind ?? "candidateFile",
              path: formatUpgrade.requiredInput?.path ?? UI_OBSERVATIONS_CANDIDATE_FILE,
              digest: plan.candidateDigest,
            },
          ],
          priorRevision: state.revision,
          revision: adopted.revision,
          priorStateDigest: `sha256:${hashContent(renderState(state))}`,
          stateDigest: `sha256:${hashContent(renderState(adopted))}`,
          priorStep: state.currentStep,
          activeSlice: activeSlice ?? null,
        }
      : domainEvent;
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = await readFile(integrityPath, "utf8");
    const nextIntegrity = await renderIntegrityNow(root, adopted, event);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await assertHistoryAppendable(registryData.targetRoot, root);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: adopted.revision,
      event,
      startedAt: at,
      pid: process.pid,
      restore: [
        ...writes.map(([relative]) => ({ path: relative, remove: true })),
        ...rewrites.map(({ relative, before }) => ({
          path: relative,
          content: before.toString("utf8"),
        })),
        { path: UI_OBSERVATIONS_CANDIDATE_FILE, content: plan.candidate },
        ...(plan.confirmationDigest ? [{
          path: FIGMA_CONTEXT_ADOPTION_FILE,
          content: (await readFile(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE))).toString("utf8"),
        }] : []),
      ],
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    for (const [relative, bytes] of writes) {
      await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
    }
    for (const rewrite of rewrites) {
      await atomicWrite(
        registryData.targetRoot,
        path.join(root, rewrite.relative),
        rewrite.content,
      );
    }
    await rm(path.join(root, UI_OBSERVATIONS_CANDIDATE_FILE));
    if (plan.confirmationDigest) await rm(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE));
    await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
    await atomicWrite(registryData.targetRoot, statePath, renderState(adopted));
    await appendHistoryOnce(registryData.targetRoot, root, event);
    await rm(journalFile, { force: true });
    return {
      changed: true,
      adopted: true,
      statePath,
      migrationRoot: root,
      state: adopted,
      affectedSlices: plan.affectedSlices,
      nextArtifact: activeArtifact(adopted),
      resolved,
    };
  });
};

// --- Format upgrades: the registry, the cursor, the no-op transaction -------

/**
 * The runtime half of the format-upgrade registry (baseline §4.1): how each
 * increment `FORMAT_INCREMENTS` (formats) declares is run, keyed by its
 * `from`. Which increments exist, what each needs and when it becomes
 * exclusive is pure record vocabulary and lives in formats; the handlers name
 * this engine's transactions, so they live here, beside the code they call.
 * `FORMAT_UPGRADERS` joins the two into the rows every caller has always read.
 *
 * `domain` is not "does this increment apply" -- it always applies. It answers
 * only whether *this record* needs the row's domain work; a `NO_OP` still
 * commits the increment.
 */
const FORMAT_UPGRADE_HANDLERS = {
  [VISUAL_ACCEPTANCE_FORMAT]: {
    // Authority, not a truthiness read: only a legacy inventory that passes the
    // engine's own validator and explicitly declares `hasVisibleUi: false` can
    // make this increment a no-op. Missing, unreadable, malformed or silent
    // about visible UI all throw, and the caller turns that into BLOCKED --
    // an absent authority must never advance the stamp past unperformed work.
    domain: async (state, { root, roots }) =>
      assertBoolean(
        (await validateLegacyInventory(root, roots, state)).hasVisibleUi,
        "Legacy hasVisibleUi",
      )
        ? "TRANSFORM"
        : "NO_OP",
    // Observations only, never the combined plan: a true format-17 record is
    // already under the visual contract, so the combined wrapper degrades to
    // this anyway and stays what it is -- the pre-floor compatibility path.
    plan: (root, state) => uiObservationsAdoptionPlan(root, state, false),
    commit: adoptUiObservations,
  },
  [REQUIRED_OBSERVATIONS_FORMAT]: {
    domain: (state) => {
      assertDirectLedgerEligible(state);
      return "TRANSFORM";
    },
    plan: async (root, state) => ({
      blockers: [],
      candidateDigest: directLedgerAdoptionDigest(state),
      preview: directLedgerAdoptionPreview(state),
    }),
    // Indirected because the row is frozen at module evaluation and the
    // transaction is declared below it.
    commit: (args) => adoptDirectLedgerDecisions(args),
  },
};

export const FORMAT_UPGRADERS = Object.freeze(
  FORMAT_INCREMENTS.map((row) =>
    Object.freeze({ ...row, ...FORMAT_UPGRADE_HANDLERS[row.from] }),
  ),
);

/**
 * The explicit, journalled 18 -> 19 transition. One transaction, the same
 * shape every other stamp move uses: re-read and re-check eligibility and the
 * confirmation digest under the module lock, write the integrity anchor, the
 * state and exactly one history event, drop the journal.
 */
const adoptDirectLedgerDecisions = async ({
  registryPath,
  moduleName,
  candidateDigest,
  formatUpgrade,
  hooks,
}) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  return withModuleLock(registryData.targetRoot, resolved.canonical, async () => {
    const root = migrationRoot(registryData.targetRoot, resolved.canonical);
    const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
    await recoverPendingAdvance(registryData.targetRoot, root, statePath);
    const { state } = await readState(registryData.targetRoot, resolved.canonical);
    assertRecordToolkitIdentity(state, resolved.canonical, "adopt direct ledger decisions");
    // Re-derived under the lock: a preview is advice, and the digest is what
    // makes the operator's confirmation about *this* record at *this* revision.
    assertDirectLedgerEligible(state);
    const expected = directLedgerAdoptionDigest(state);
    if (candidateDigest !== expected) {
      throw new Error(
        `The direct-ledger adoption confirmation does not match this record: confirmed ${candidateDigest ?? "nothing"}, current ${expected}. The record moved after the preview was taken; review it again. Nothing was written.`,
      );
    }
    const at = now();
    const upgraded = {
      ...state,
      formatVersion: DIRECT_LEDGER_DECISIONS_FORMAT,
      revision: state.revision + 1,
      updatedAt: at,
    };
    const event = {
      event: "FORMAT_UPGRADED",
      transition: "DIRECT_LEDGER_DECISIONS_ADOPTED",
      fromFormat: REQUIRED_OBSERVATIONS_FORMAT,
      toFormat: DIRECT_LEDGER_DECISIONS_FORMAT,
      domain: "TRANSFORM",
      upgrader: formatUpgrade?.upgrader ?? {
        id: "DIRECT_LEDGER_DECISIONS_ADOPTED",
        version: 1,
      },
      inputs: [{ kind: "confirmationDigest", path: null, digest: expected }],
      priorRevision: state.revision,
      revision: upgraded.revision,
      priorStateDigest: `sha256:${hashContent(renderState(state))}`,
      stateDigest: `sha256:${hashContent(renderState(upgraded))}`,
      priorStep: state.currentStep,
      activeSlice: state.activeSlice ?? null,
      at,
    };
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = (await fileExists(integrityPath))
      ? await readFile(integrityPath, "utf8")
      : null;
    const nextIntegrity = await renderIntegrityNow(root, upgraded, event);
    await assertHistoryAppendable(registryData.targetRoot, root);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: upgraded.revision,
      event,
      startedAt: at,
      pid: process.pid,
      restore: [{ path: "state.json", content: renderState(state) }],
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    await hooks?.afterWrite?.("journal");
    await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
    await hooks?.afterWrite?.("integrity");
    await atomicWrite(registryData.targetRoot, statePath, renderState(upgraded));
    await hooks?.afterWrite?.("state");
    await appendHistoryOnce(registryData.targetRoot, root, event);
    await hooks?.afterWrite?.("history");
    await rm(journalFile, { force: true });
    return {
      changed: true,
      upgraded: true,
      from: REQUIRED_OBSERVATIONS_FORMAT,
      to: DIRECT_LEDGER_DECISIONS_FORMAT,
      statePath,
      migrationRoot: root,
      state: upgraded,
      resolved,
    };
  });
};

/**
 * The cursor. At or above the floor a record behind the runtime format always
 * owes exactly the next adjacent increment: there is no skip or silent
 * self-heal. An inactive increment leaves old-format lifecycle progress live
 * until its prerequisite is pinned. Below the floor the record owes nothing
 * here and keeps its pre-existing semantics.
 *
 * Derived from `(formatVersion, runtime format, registry, record tree)` and
 * nothing persisted, so status, preview and the transaction all see the same
 * answer and a crash can never leave an "upgrade started" flag behind. Reads
 * only; writes nothing.
 *
 * `identityBlocker` is how a read-only caller keeps the dispatch order it
 * cannot enforce by throwing: identity outranks the format upgrade, so a record
 * pinning a build this engine cannot prove it is reports the identity refusal
 * and nothing about the record is read past the cursor itself.
 */
export const pendingFormatUpgrade = async (
  root,
  state,
  moduleName,
  roots,
  { identityBlocker = null, adoptDirectLedger = false } = {},
) => {
  const recordFormat = state?.formatVersion ?? 1;
  // Creation defaults do not upgrade historical authority. Only explicit
  // adoption raises the existing-record cursor beyond required observations.
  const runtimeFormat = adoptDirectLedger
    ? MIGRATION_FORMAT_SUPPORTED
    : REQUIRED_OBSERVATIONS_FORMAT;
  const increment = nextIncrement(
    FORMAT_UPGRADERS,
    recordFormat,
    runtimeFormat,
    FORMAT_UPGRADE_FLOOR,
  );
  if (!increment) return null;
  const { from, to, row } = increment;
  const cursor = {
    recordFormat,
    runtimeFormat,
    from,
    to,
    // Overridden only by the INACTIVE branch below. Every other result is an
    // exclusive increment: the lifecycle is frozen behind it.
    active: true,
  };
  const rerun = `rerun /start-migration ${moduleName ?? state?.migrationId}`;
  if (identityBlocker) {
    return {
      ...cursor,
      upgrader: row ? { id: row.id, version: row.version } : null,
      state: "BLOCKED",
      domain: null,
      requiredInput: null,
      blockers: [identityBlocker],
      nextAction: `Resolve the toolkit identity refusal above; the ${from} -> ${to} format upgrade is not classified until it is.`,
      confirmationDigest: null,
    };
  }
  if (!row) {
    // Unreachable in a released build -- `assertRegistryCoverage` fails the
    // release first -- so this is the fail-closed floor under that gate.
    return {
      ...cursor,
      upgrader: null,
      state: "BLOCKED",
      domain: null,
      requiredInput: null,
      blockers: [
        `No registered format upgrader for ${from} -> ${to}. This toolkit cannot move the record past format ${from}; nothing was read or written.`,
      ],
      nextAction: `Install a toolkit that registers the ${from} -> ${to} format upgrader.`,
      confirmationDigest: null,
    };
  }
  // The activation boundary, and the last thing decided from persisted state
  // alone. While the row's old-format prerequisite does not exist the increment
  // is owed but not exclusive: the historical lifecycle is what produces that
  // prerequisite, so nothing is classified here -- no `row.domain`, no
  // `row.plan`, no inventory validation -- and nothing is frozen.
  if (!upgradeIsActive(row, state)) {
    const { prerequisite } = row.activation;
    return {
      ...cursor,
      active: false,
      upgrader: { id: row.id, version: row.version },
      state: "INACTIVE",
      domain: null,
      requiredInput: null,
      prerequisite,
      blockers: [],
      nextAction: `Continue the normal migration until ${prerequisite.description} is validated and pinned; the ${from} -> ${to} format upgrade becomes mandatory the moment it is.`,
      confirmationDigest: null,
    };
  }
  // The row classifies from authoritative record material, so a record whose
  // authority cannot be read or does not answer the question is BLOCKED, never
  // NO_OP: "nothing needed doing" is a finding, and an unreadable inventory is
  // the absence of one. Nothing is read or written past this point.
  let domain;
  try {
    domain = await row.domain(state, { root, roots });
  } catch (error) {
    return {
      ...cursor,
      upgrader: { id: row.id, version: row.version },
      state: "BLOCKED",
      domain: null,
      requiredInput: row.requiredInput,
      blockers: [
        `The authoritative legacy inventory could not establish whether this record has visible UI, so the ${from} -> ${to} format upgrade cannot be classified: ${error.message}`,
      ],
      nextAction: `Restore the record's authoritative ${initialArtifacts.legacyInventory}, then ${rerun}.`,
      confirmationDigest: null,
    };
  }
  const inputPresent =
    domain === "NO_OP" ||
    row.requiredInput === null ||
    (await fileExists(path.join(root, row.requiredInput.path)));
  const plan =
    domain === "NO_OP" || !inputPresent ? null : await row.plan(root, state);
  const { state: upgradeState, blockers } = classifyUpgrade({
    domain,
    inputPresent,
    plan,
  });
  return {
    ...cursor,
    upgrader: { id: row.id, version: row.version },
    state: upgradeState,
    domain,
    requiredInput: domain === "NO_OP" ? null : row.requiredInput,
    blockers,
    nextAction:
      upgradeState === "NEEDS_INPUT"
        ? `Author ${row.requiredInput.path} from ${row.requiredInput.authority} authority, then ${rerun}.`
        : upgradeState === "BLOCKED"
          ? `Resolve the refusal above, then ${rerun}.`
          : domain === "NO_OP"
            ? `Commit the no-op format upgrade ${from} -> ${to}: this record needs none of ${row.id}'s domain work.`
            : `Commit the format upgrade ${from} -> ${to} (${row.id} v${row.version}).`,
    confirmationDigest:
      upgradeState === "READY" ? (plan?.candidateDigest ?? null) : null,
  };
};

/**
 * The degenerate case of the advance transaction, and the whole of it: one
 * increment whose domain work this record does not need still commits, in one
 * journalled transaction, or it does not happen at all.
 *
 * It moves the cursor and nothing else. `status`, `currentStep`, `activeSlice`,
 * `completedSteps`, `pendingSteps`, `completedSlices`, `pendingSlices`,
 * `artifactHashes`, the plan, the requirements and every application file are
 * copied through byte-identical; only `formatVersion`, `revision`, `updatedAt`,
 * `integrity.json` and the append-only history move. A skipped increment would
 * leave "nothing needed doing" and "nothing was recorded" indistinguishable,
 * which is exactly what the `domain: "NO_OP"` history line resolves.
 */
export const commitNoOpFormatUpgrade = async ({
  registryPath,
  moduleName,
  hooks,
}) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  return withModuleLock(registryData.targetRoot, resolved.canonical, async () => {
    const root = migrationRoot(registryData.targetRoot, resolved.canonical);
    const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
    await recoverPendingAdvance(registryData.targetRoot, root, statePath);
    const { state } = await readState(registryData.targetRoot, resolved.canonical);
    assertRecordToolkitIdentity(state, resolved.canonical, "upgrade the record format");
    // Re-classified under the lock: a preview is racy by definition, and the
    // classification is what authorizes writing the stamp without doing work.
    const pending = await pendingFormatUpgrade(root, state, resolved.canonical, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
    if (!pending) {
      throw new Error(
        `Migration '${resolved.canonical}' owes no format upgrade at format ${state.formatVersion}. Nothing was written.`,
      );
    }
    if (pending.domain !== "NO_OP" || pending.state !== "READY") {
      throw new Error(
        [
          `The ${pending.from} -> ${pending.to} format upgrade is ${pending.state}/${pending.domain ?? "UNREGISTERED"}, not READY/NO_OP, so it cannot be committed as a no-op.`,
          ...pending.blockers,
          "Nothing was written.",
        ].join(" "),
      );
    }
    const at = now();
    const upgraded = {
      ...state,
      formatVersion: pending.to,
      revision: state.revision + 1,
      updatedAt: at,
    };
    const event = {
      event: "FORMAT_UPGRADED",
      fromFormat: pending.from,
      toFormat: pending.to,
      domain: "NO_OP",
      upgrader: pending.upgrader,
      inputs: [],
      priorRevision: state.revision,
      revision: upgraded.revision,
      priorStateDigest: `sha256:${hashContent(renderState(state))}`,
      stateDigest: `sha256:${hashContent(renderState(upgraded))}`,
      priorStep: state.currentStep,
      activeSlice: state.activeSlice ?? null,
      at,
    };
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = (await fileExists(integrityPath))
      ? await readFile(integrityPath, "utf8")
      : null;
    const nextIntegrity = await renderIntegrityNow(root, upgraded, event);
    await assertHistoryAppendable(registryData.targetRoot, root);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: upgraded.revision,
      event,
      startedAt: at,
      pid: process.pid,
      // Idempotent: the rollback branch only runs when the state write never
      // landed, so this restores the bytes already on disk. It is there so the
      // journal names every file the transaction touches.
      restore: [{ path: "state.json", content: renderState(state) }],
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    await hooks?.afterWrite?.("journal");
    await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
    await hooks?.afterWrite?.("integrity");
    await atomicWrite(registryData.targetRoot, statePath, renderState(upgraded));
    await hooks?.afterWrite?.("state");
    await appendHistoryOnce(registryData.targetRoot, root, event);
    await hooks?.afterWrite?.("history");
    await rm(journalFile, { force: true });
    return {
      changed: true,
      upgraded: true,
      from: pending.from,
      to: pending.to,
      statePath,
      migrationRoot: root,
      state: upgraded,
      resolved,
    };
  });
};

/**
 * Commit the one increment this record owes, whichever domain it is: the single
 * mutating entry point the normal command dispatches to, so no front end has to
 * know which row or which transaction performs the work.
 *
 * It creates no transaction of its own -- the row's `commit` for a TRANSFORM,
 * `commitNoOpFormatUpgrade` for a NO_OP -- and both re-read, re-classify and
 * re-verify under their own module lock, because this classification is taken
 * outside it and is therefore advice.
 */
export const commitFormatUpgrade = async ({
  registryPath,
  moduleName,
  confirmationDigest = null,
  // The explicit module-19 selection, and the only way to reach the 18 -> 19
  // row for an existing record. New creation defaults never raise this cursor.
  adoptDirectLedger = false,
  hooks,
}) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const root = migrationRoot(registryData.targetRoot, resolved.canonical);
  const { state } = await readState(registryData.targetRoot, resolved.canonical);
  const pending = await pendingFormatUpgrade(root, state, resolved.canonical, {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  }, { adoptDirectLedger });
  if (!pending) {
    throw new Error(
      `Migration '${resolved.canonical}' owes no format upgrade at format ${state.formatVersion}. Nothing was written.`,
    );
  }
  if (pending.state !== "READY") {
    throw new Error(
      [
        `The ${pending.from} -> ${pending.to} format upgrade is ${pending.state}, not READY, so it cannot be committed.`,
        ...pending.blockers,
        pending.nextAction,
        "Nothing was written.",
      ].join(" "),
    );
  }
  if (pending.domain === "NO_OP") {
    return commitNoOpFormatUpgrade({ registryPath, moduleName, hooks });
  }
  const row = FORMAT_UPGRADERS.find((entry) => entry.from === pending.from);
  const committed = await row.commit({
    registryPath,
    moduleName,
    candidateDigest: confirmationDigest ?? pending.confirmationDigest,
    // Present only on the registry-driven path, and the only thing that decides
    // which history envelope the shared transaction writes.
    formatUpgrade: {
      from: pending.from,
      to: pending.to,
      upgrader: pending.upgrader,
      requiredInput: pending.requiredInput,
    },
    hooks,
  });
  return { ...committed, upgraded: true, from: pending.from, to: pending.to };
};

/**
 * There is no visible-UI parity to reopen on a migration that has none.
 *
 * The one UI authority is the record's own validated inventory -- the same read
 * every UI gate uses, so a `ui-remediation.json` that already raised
 * `hasVisibleUi` counts here exactly as it counts there, and no second
 * UI-detection rule enters the engine. An inventory this release cannot read is
 * deliberately not an answer: it leaves the existing behavior alone rather than
 * inventing a refusal out of an unreadable record.
 */
const reopenUiNotApplicable = async (root, state, roots) => {
  const inventory = await validateLegacyInventory(root, roots, state).then(
    (value) => value,
    () => null,
  );
  return inventory && inventory.hasVisibleUi !== true
    ? "--reopen-ui is not applicable: the pinned legacy inventory declares hasVisibleUi false, so this migration has no visible UI to reverify. Nothing was changed."
    : null;
};

const reopenUiUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  slices,
}) => {
  if (!reopenUiEligible(state)) {
    throw new Error(reopenUiIneligible(state));
  }
  const notApplicable = await reopenUiNotApplicable(root, state, {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  });
  if (notApplicable) throw new Error(notApplicable);
  const fromActive = state.status === "ACTIVE";
  const plan = await readJson(
    path.join(root, initialArtifacts.slices),
    "Slice index",
  );
  const requested = new Set(slices);
  const ordered = plan.slices
    .map((slice) => slice.id)
    .filter((sliceId) => requested.has(sliceId));
  if (ordered.length !== requested.size || ordered.length === 0) {
    throw new Error("--reopen-ui must name one or more planned slices.");
  }
  const pendingReverification =
    state.visualContractAdoption?.pendingReverification ?? [];
  if (!pendingReverification.every((sliceId) => requested.has(sliceId))) {
    throw new Error(
      `--reopen-ui must include every slice whose Figma visual evidence predates the adopted visual contract: ${pendingReverification.join(", ")}.`,
    );
  }
  if (fromActive) {
    const notCompleted = ordered.filter(
      (sliceId) => !state.completedSlices.includes(sliceId),
    );
    if (notCompleted.length > 0) {
      throw new Error(
        `--reopen-ui on an ACTIVE migration names only completed slices; ${notCompleted.join(", ")} is active or pending and is re-authored in place.`,
      );
    }
    const lacking = await completedSlicesLackingUiProofV1(root, state, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    });
    const omitted = lacking.filter((sliceId) => !requested.has(sliceId));
    if (omitted.length > 0) {
      throw new Error(
        `--reopen-ui must include every completed slice lacking ${UI_PROOF_FORMAT} UI proof: ${lacking.join(", ")}.`,
      );
    }
    if (await readAdvanceJournal(root)) {
      throw new Error(
        "--reopen-ui is refused while an advance journal is pending; resume the migration first.",
      );
    }
    if (state.activeSlice) {
      const active = await readFile(
        path.join(root, `evidence/${state.activeSlice}/result.json`),
        "utf8",
      ).then(JSON.parse, () => null);
      if (active?.result === "FAIL") {
        throw new Error(
          `--reopen-ui is refused while active slice '${state.activeSlice}' holds an un-reworked FAIL; resolve it with --rework-slice first.`,
        );
      }
    }
  }
  const artifactHashes = { ...state.artifactHashes };
  for (const sliceId of ordered) {
    delete artifactHashes[`evidence/${sliceId}/result.json`];
  }
  for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
    delete artifactHashes[relative];
  }
  // ACTIVE recovery changes only the proof format, never the UI contract, so
  // the remediation file and its pin stay exactly as they are.
  if (!fromActive) delete artifactHashes[UI_REMEDIATION_FILE];

  const remediationPath = path.join(root, UI_REMEDIATION_FILE);
  const remediationBefore = (await fileExists(remediationPath))
    ? await readFile(remediationPath, "utf8")
    : null;
  const remediation = `${JSON.stringify(
    {
      version: 1,
      reason: "Completed migration reopened after a visible-UI parity audit.",
      legacyRevision: await gitRevision(registryData.legacyRoot),
      hasVisibleUi: true,
      uiBehaviors: [],
      uiMismatches: [],
    },
    null,
    2,
  )}\n`;
  const resultRewrites = [];
  for (const sliceId of ordered) {
    const relative = `evidence/${sliceId}/result.json`;
    const absolute = path.join(root, relative);
    const before = await readFile(absolute, "utf8");
    const result = JSON.parse(before);
    resultRewrites.push({
      relative,
      before,
      content: `${JSON.stringify(
        {
          ...result,
          result: "PENDING",
          uiEvidence: [],
          uiEvidenceLimitations: [],
        },
        null,
        2,
      )}\n`,
    });
  }
  const reopened = {
    // Stamp the record's own format, never a literal: format 14 gates
    // `inventories/figma-context.json` membership in the exact-set
    // `artifactHashes` check, so downgrading a figma-mcp record here left the
    // pin present but no longer expected, bricking every later read.
    ...state,
    formatVersion: stampedFormatVersion(state),
    status: "ACTIVE",
    currentStep: "VERIFY_SLICES",
    activeSlice: ordered[0],
    completedSteps: stepsFor(state).slice(
      0,
      stepsFor(state).indexOf("IMPLEMENT_SLICES"),
    ),
    pendingSteps: ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"],
    completedSlices: state.completedSlices.filter(
      (sliceId) => !requested.has(sliceId),
    ),
    pendingSlices: fromActive
      ? plan.slices
          .map((slice) => slice.id)
          .filter(
            (sliceId) =>
              requested.has(sliceId) || state.pendingSlices.includes(sliceId),
          )
      : ordered,
    invalidatedArtifacts: [
      ...(fromActive ? [] : [UI_REMEDIATION_FILE]),
      ...ordered.map((sliceId) => `evidence/${sliceId}/result.json`),
      ...IMMUTABLE_STEP_ARTIFACTS.FINALIZE,
    ],
    evidenceFreshness: "STALE",
    nextAction: fromActive
      ? `Collect ${UI_PROOF_FORMAT} Playwright evidence for ${ordered[0]}.`
      : `Author ${UI_REMEDIATION_FILE}, then collect Playwright evidence for ${ordered[0]}.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    ...(state.visualContractAdoption
      ? {
          visualContractAdoption: {
            ...state.visualContractAdoption,
            pendingReverification: [],
          },
        }
      : {}),
    artifacts: fromActive
      ? state.artifacts
      : { ...state.artifacts, uiRemediation: UI_REMEDIATION_FILE },
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "UI_REMEDIATION_REOPENED",
    from: fromActive ? "ACTIVE" : "COMPLETE",
    step: "VERIFY_SLICES",
    slices: ordered,
    at: reopened.updatedAt,
    revision: reopened.revision,
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, reopened, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: reopened.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    restore: [
      ...(fromActive
        ? []
        : [
            remediationBefore === null
              ? { path: UI_REMEDIATION_FILE, remove: true }
              : { path: UI_REMEDIATION_FILE, content: remediationBefore },
          ]),
      ...resultRewrites.map(({ relative, before }) => ({
        path: relative,
        content: before,
      })),
    ],
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  if (!fromActive) {
    await atomicWrite(registryData.targetRoot, remediationPath, remediation);
  }
  for (const rewrite of resultRewrites) {
    await atomicWrite(
      registryData.targetRoot,
      path.join(root, rewrite.relative),
      rewrite.content,
    );
  }
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reopened));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reopened,
    nextArtifact: fromActive
      ? `evidence/${ordered[0]}/result.json`
      : UI_REMEDIATION_FILE,
    resolved,
  };
};

/* ------------------------------------------------------------------
 * `--reopen-complete`: the only COMPLETE -> reopened transition that is not
 * about visible UI.
 *
 * `--reopen-ui` reopens a COMPLETE record for a parity audit and `--rework-slice`
 * returns an *active* slice with a recorded FAIL to implementation. Neither
 * covers the remaining case: authoritative evidence that appears *after*
 * FINALIZE and proves part of the finalized contract wrong. A note in the record
 * changed no machine state, and COMPLETE stayed COMPLETE over evidence everyone
 * knew was stale.
 *
 * Modelled on both: operator-only, refused under `--mode auto`, refused by
 * `run-migration.mjs`, never self-confirmed, preview-gated, journalled -- and
 * ordered like a rework, which is the whole safety property. The superseded
 * verification is preserved byte-for-byte and permanently pinned BEFORE its
 * mutable pin is released, so there is no reachable state in which the proof
 * the previous COMPLETE rested on has been freed before it was kept.
 *
 * Deliberately narrow. It releases the named slices' evidence and the FINALIZE
 * pins and nothing else: discovery, baseline, plan, operator decisions and every
 * unnamed slice stay pinned and stay valid. Path-scoped legacy drift blocks it
 * unless the operator types the exact current revision with
 * `--confirm-legacy-revision`; the record then moves to that revision, and the
 * move is kept in the reopen record and event. Nothing else is released for it:
 * slice evidence is not revision-bound, and the FINALIZE gates it releases
 * anyway are re-proven against the new revision. And it never edits the
 * target, so FINALIZE re-runs the unclaimed-drift refusal unchanged.
 * ------------------------------------------------------------------ */

/**
 * One definition site for what a reopen is allowed to do, read by the preview
 * (as blockers) and re-derived under the lock (as refusals) from fresh reads.
 */
const reopenCompletePlan = async (
  root,
  state,
  roots,
  {
    slices,
    reason,
    evidence,
    legacyRevision,
    confirmLegacyRevision = null,
    // `--mode auto`. What `--confirm-legacy-revision` proves is that whoever
    // typed it had read the *current* revision -- and the engine read it, from
    // git, in this call. There is no judgement in retyping a SHA the engine
    // just computed, so AUTO acknowledges it on its own authority and the
    // acknowledgement names AUTO in the reopen record and the history event.
    // Everything the acknowledgement releases is re-proven against the new
    // revision regardless of who acknowledged.
    autoAcknowledge = false,
  },
) => {
  const blockers = [];
  const drifted = state.legacyRevision.revision !== legacyRevision.revision;
  const acknowledged =
    confirmLegacyRevision ??
    (autoAcknowledge && drifted ? legacyRevision.revision : null);
  const acknowledgedBy = !acknowledged
    ? null
    : confirmLegacyRevision
      ? "OPERATOR"
      : "AUTO";
  if (drifted && acknowledged !== legacyRevision.revision) {
    blockers.push(
      confirmLegacyRevision
        ? `--confirm-legacy-revision '${confirmLegacyRevision}' does not match the current legacy revision '${legacyRevision.revision}'. Nothing was acknowledged.`
        : `Legacy revision changed from '${state.legacyRevision.revision}' to '${legacyRevision.revision}'. A COMPLETE reopen may acknowledge it with --confirm-legacy-revision ${legacyRevision.revision}; otherwise review the mismatch before using --refresh --confirm-mismatch.`,
    );
  }
  if (!drifted && confirmLegacyRevision) {
    blockers.push(
      `--confirm-legacy-revision was given, but the legacy revision has not changed from '${state.legacyRevision.revision}'. There is no drift to acknowledge.`,
    );
  }
  if (state.status !== "COMPLETE") {
    blockers.push(
      `--reopen-complete is legal only for a COMPLETE migration; the current status is '${state.status}'. A migration that has not finalized is corrected by advancing it, not by reopening it.`,
    );
  }
  // Explicit operator intent, in the record and not only in a terminal: a
  // reopen that cannot say why it happened is indistinguishable from a
  // hand-edit of a completed record.
  if (typeof reason !== "string" || reason.trim().length < 12) {
    blockers.push(
      "--reopen-complete requires --reopen-reason <text> of at least 12 characters: the reopen event is the permanent record of why a finalized contract stopped being true.",
    );
  }
  const claim = evidencePathClaim(evidence);
  let evidenceIdentity = null;
  if (!claim) {
    blockers.push(
      `--reopen-complete requires --reopen-evidence <path>: a repository-relative path to the authoritative post-finalization evidence. Received '${evidence ?? "nothing"}', which is not a persisted artifact path.`,
    );
  } else {
    const absolute = await resolveEvidencePath(claim, roots);
    if (!absolute) {
      blockers.push(
        `--reopen-evidence names '${claim}', which does not exist under the legacy or target repository. Evidence that a finalized contract is wrong must be a real observation, persisted.`,
      );
    } else {
      evidenceIdentity = await fileIdentity(absolute);
    }
  }
  const planned = (await inspectSliceArtifacts(root)).plannedSlices;
  const requested = new Set(slices);
  const ordered = planned.filter((sliceId) => requested.has(sliceId));
  if (requested.size === 0) {
    blockers.push("--reopen-complete must name one or more planned slices.");
  }
  for (const sliceId of requested) {
    if (!planned.includes(sliceId)) {
      blockers.push(`--reopen-complete names unknown slice '${sliceId}'.`);
    }
  }
  const legacyDrift = drifted
    ? {
        fromLegacyRevision: state.legacyRevision,
        toLegacyRevision: legacyRevision,
        // Who acknowledged, persisted with the drift it acknowledges. A record
        // that moved revisions must say on whose authority, forever.
        acknowledgedBy,
      }
    : null;
  return { blockers, ordered, claim, evidenceIdentity, legacyDrift, acknowledgedBy };
};

/** How many reopens this record has already recorded, read off the audit log. */
const reopenAttemptsOf = async (root) =>
  (await readHistoryEvents(root)).filter(
    (event) => event.event === "COMPLETE_REOPENED",
  ).length;

const reopenCompleteUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
  slices,
  reason,
  evidence,
  legacyRevision,
  confirmLegacyRevision,
  autoAcknowledge = false,
  // Who decides. Defaults to the operator: an absent mode is never autonomy.
  mode = "step",
}) => {
  const roots = {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  };
  const plan = await reopenCompletePlan(root, state, roots, {
    slices,
    reason,
    evidence,
    legacyRevision,
    confirmLegacyRevision,
    autoAcknowledge,
  });
  if (plan.blockers.length > 0) {
    throw new Error(`${plan.blockers.join(" ")} Nothing was written.`);
  }
  const { ordered, claim, evidenceIdentity, legacyDrift } = plan;
  // HEAD, not `gitRevision`'s path-scoped reading: the anchor must be the
  // commit the reopened slices are proven against and an ancestor of every
  // later HEAD, which only the tip guarantees.
  const authority = mode === "auto" ? "AUTO" : "OPERATOR";
  const targetAnchor = await headRevision(roots.targetRoot);
  const attempt = (await reopenAttemptsOf(root)) + 1;
  const directory = `${REOPEN_ROOT}/${attempt}`;
  if (await fileExists(path.join(root, directory))) {
    throw new Error(
      `${directory} already exists. Reopens are append-only and an attempt number is never reused; nothing was written.`,
    );
  }

  // Every file the transaction writes, built completely before anything lands.
  // Raw bytes, never parse-and-reserialize: key order, whitespace and line
  // endings are part of what the previous COMPLETE actually recorded.
  const writes = [];
  const rewrites = [];
  for (const sliceId of ordered) {
    const relative = `evidence/${sliceId}/result.json`;
    const absolute = path.join(root, relative);
    const before = await readFile(absolute);
    writes.push([`${directory}/${relative}`, before]);
    rewrites.push({
      relative,
      before,
      // The verification is invalidated, not rewritten into a verdict nobody
      // recorded: PENDING is the one value `inspectSliceArtifacts` reads as
      // "not verified", and the superseded PASS survives beside it.
      content: `${JSON.stringify(
        { ...JSON.parse(before.toString("utf8")), result: "PENDING" },
        null,
        2,
      )}\n`,
    });
  }
  const preserved = {};
  for (const [relative, bytes] of writes) preserved[relative] = hashContent(bytes);
  const recordRelative = `${directory}/record.json`;
  const record = `${JSON.stringify(
    {
      version: 1,
      attempt,
      at: now(),
      operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
      reason: reason.trim(),
      evidenceReference: claim,
      evidenceHash: evidenceIdentity,
      slices: ordered,
      // Who decided. AUTO assents by deriving the transition from valid
      // evidence; OPERATOR assents by typing --confirm-reopen. The `operator`
      // field stays the process identity in both cases -- it records where the
      // transition ran, never a human approval AUTO did not obtain.
      authority,
      priorRevision: state.revision,
      priorCompletedAt: state.updatedAt,
      // The committed target state whose preserved PASS is being reopened.
      // Without it a reopened slice has no provenance for work that was already
      // committed at COMPLETE, and `validateImplementedSlice` can only prove
      // ownership from the current uncommitted diff -- which a committed slice
      // is legitimately absent from. Records written before this field exists
      // resolve their anchor from the pinned preserved evidence instead.
      ...(targetAnchor ? { targetAnchor } : {}),
      ...(legacyDrift ?? {}),
      preserved,
    },
    null,
    2,
  )}\n`;
  writes.push([recordRelative, Buffer.from(record, "utf8")]);
  preserved[recordRelative] = hashContent(record);

  const artifactHashes = { ...state.artifactHashes, ...preserved };
  // Released only now, and only after every preserved path is in the pin set.
  for (const sliceId of ordered) {
    delete artifactHashes[`evidence/${sliceId}/result.json`];
  }
  for (const relative of IMMUTABLE_STEP_ARTIFACTS.FINALIZE) {
    delete artifactHashes[relative];
  }

  const steps = stepsFor(state);
  const reopened = {
    // Stamped, never a literal, for the same reason `--reopen-ui` stamps:
    // downgrading the record here would leave format-gated pins present but no
    // longer expected, bricking every later read.
    ...state,
    formatVersion: stampedFormatVersion(state),
    status: "ACTIVE",
    currentStep: "VERIFY_SLICES",
    activeSlice: ordered[0],
    completedSteps: steps.slice(0, steps.indexOf("IMPLEMENT_SLICES")),
    pendingSteps: ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"],
    completedSlices: state.completedSlices.filter(
      (sliceId) => !ordered.includes(sliceId),
    ),
    pendingSlices: ordered,
    invalidatedArtifacts: [
      ...ordered.map((sliceId) => `evidence/${sliceId}/result.json`),
      ...IMMUTABLE_STEP_ARTIFACTS.FINALIZE,
    ],
    evidenceFreshness: "STALE",
    nextAction: `Correct and reverify slice '${ordered[0]}' against the evidence recorded in ${recordRelative}. A slice whose implementation is wrong records FAIL with defects[] and returns to implementation with --rework-slice.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    ...(legacyDrift ? { legacyRevision: legacyDrift.toLegacyRevision } : {}),
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "COMPLETE_REOPENED",
    from: "COMPLETE",
    step: "VERIFY_SLICES",
    slices: ordered,
    attempt,
    reason: reason.trim(),
    evidenceReference: claim,
    authority,
    ...(targetAnchor ? { targetAnchor } : {}),
    // Also re-anchors gate-evidence freshness (`pinnedInputTimestamps`).
    ...(legacyDrift ?? {}),
    preserved: Object.keys(preserved).sort(),
    revision: reopened.revision,
  };

  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, reopened, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: reopened.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    // Recovery removes a half-written preserved tree and restores the evidence
    // the previous COMPLETE rested on, so a killed reopen leaves the record
    // exactly as complete as it was.
    restore: [
      ...writes.map(([relative]) => ({ path: relative, remove: true })),
      ...rewrites.map(({ relative, before }) => ({
        path: relative,
        content: before.toString("utf8"),
      })),
    ],
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  for (const [relative, bytes] of writes) {
    await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
  }
  for (const rewrite of rewrites) {
    await atomicWrite(
      registryData.targetRoot,
      path.join(root, rewrite.relative),
      rewrite.content,
    );
  }
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reopened));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  await rm(journalFile, { force: true });
  return {
    changed: true,
    reopened: true,
    statePath,
    migrationRoot: root,
    state: reopened,
    nextArtifact: activeArtifact(reopened),
    resolved,
  };
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

/**
 * Read-only: recompute the scan and print it, so the census and the graph can
 * be authored against instead of guessed at. Writes nothing -- the persisted
 * `inventories/discovery-scan.json` is written only by the confirmed advance.
 */
export const previewDiscoveryScan = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  // Guarded before the classification is read: `--scan` and the operator
  // recorder both land here, and a pre-10 record must be refused for its
  // format, not for the artifact its lifecycle never had.
  const { state, root } = await readState(
    registryData.targetRoot,
    resolved.canonical,
  );
  assertDiscoveryCompletenessFormat(
    state,
    resolved.canonical,
    "Discovery scan",
  );
  return (
    await readCanonicalModuleBoundary(root, state, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    })
  ).scan;
};

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
  // Imported at call time to keep `record-decision.mjs`'s static import of this
  // module from becoming a cycle, exactly as the artifact reader is.
  //
  // A record with no decision-bearing census -- too early, or a format whose
  // candidates cannot be derived at all -- reports null rather than failing a
  // status read: nothing here may block saying where the record stands.
  const decisions = await import("./record-decision.mjs")
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

/**
 * Read-only advance preflight. `advance-migration.mjs` used to write state and
 * history with no preview, no confirmation ID, and no lock, which contradicted
 * the public "every mutating invocation is two-phase" guarantee: any caller
 * could durably close a checkpoint without the user approving that exact
 * transition. The ID below binds the state revision, the current artifact
 * hashes, the active slice, and the exact intended next state.
 */
export const previewAdvance = async ({
  registryPath,
  moduleName,
  step,
  slice,
  // As in previewMigrationExecution: checklist only, outside the hashed
  // snapshot, so the confirmation ID is unaffected.
  mode,
} = {}) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  const context = await readState(registryData.targetRoot, resolved.canonical);
  const { state } = context;
  const currentStep = step ?? state.currentStep;
  const activeSlice = slice ?? state.activeSlice;
  const blockers = [];
  if (stateMappingMismatch(state, resolved)) {
    blockers.push("Migration state mapping does not match the registry.");
  }
  if (state.status !== "ACTIVE") {
    blockers.push(`Cannot advance migration with status '${state.status}'.`);
  }
  if (currentStep !== state.currentStep) {
    blockers.push(
      `Cannot advance '${currentStep}'; current step is '${state.currentStep}'.`,
    );
  }
  if (!MIGRATION_STEPS.includes(currentStep)) {
    blockers.push(`Unknown migration step '${currentStep}'.`);
  }
  if (
    ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep) &&
    activeSlice !== state.activeSlice
  ) {
    blockers.push(
      `Slice '${activeSlice ?? "none"}' is not the active slice '${state.activeSlice ?? "none"}'.`,
    );
  }
  const snapshot = {
    migration: state.legacyModule,
    step: currentStep,
    slice: activeSlice ?? null,
    revision: state.revision,
    stateHash: await hashFile(context.statePath),
    artifactHashes: state.artifactHashes,
    // The state hash and the pinned artifacts live in the target; nothing here
    // bound the legacy side, so the sources a checkpoint asserts about could
    // change between the summary the operator confirmed and the write.
    legacySource: await legacySourceBinding(registryData.legacyRoot),
    nextStep: expectedNextCheckpoint(state),
    blockers,
  };
  if (
    blockers.length === 0 &&
    usesArtifactDelegation(state) &&
    ["IMPLEMENT_SLICES", "FINALIZE"].includes(currentStep)
  ) {
    const prerequisite = await artifactPrerequisiteWork(
      state,
      {
        legacyRoot: registryData.legacyRoot,
        targetRoot: registryData.targetRoot,
      },
      { all: currentStep === "FINALIZE" },
    );
    if (prerequisite.outcome !== "COMPLETE") {
      const progress = migrationProgress(state, {
        mode: mode ?? DEFAULT_MODE,
        outcome:
          prerequisite.outcome === "CONTINUE" ? null : prerequisite.outcome,
        reason: prerequisite.reason,
        nextWorkKind: prerequisite.nextWorkKind,
        artifactMigration: prerequisite.artifactMigration,
      });
      return {
        ...snapshot,
        outcome: prerequisite.outcome,
        reason: prerequisite.reason,
        nextWorkKind: prerequisite.nextWorkKind ?? null,
        artifactMigration: prerequisite.artifactMigration,
        pendingDecisions: prerequisite.pendingDecisions ?? [],
        blockers:
          prerequisite.outcome === "BLOCKED" ? [prerequisite.reason] : [],
        requiresConfirmation: false,
        confirmationId: null,
        progress,
        progressChecklist: renderProgress(progress),
      };
    }
  }
  const advanceProgress = previewProgress(state, mode, blockers);
  return {
    ...snapshot,
    statePath: context.statePath,
    progress: advanceProgress,
    progressChecklist: renderProgress(advanceProgress),
    requiresConfirmation: blockers.length === 0,
    confirmationId: blockers.length === 0 ? confirmationIdFor(snapshot) : null,
  };
};

export const renderAdvancePreview = (preview) =>
  `Advance pre-execution summary\n` +
  `Migration: ${preview.migration}\n` +
  `Checkpoint to close: ${preview.step}\n` +
  `Slice: ${preview.slice ?? "none"}\n` +
  `State revision: ${preview.revision}\n` +
  `Expected next checkpoint: ${preview.nextStep}\n` +
  `Blockers: ${preview.blockers.length > 0 ? preview.blockers.join("; ") : "none"}\n`;

/**
 * The canonical progress projection (Plan 09). One deterministic reading of a
 * persisted record, shared by every front end -- Claude Code, Codex, GitHub
 * Copilot, OpenCode -- so that a provider's native task UI and the text
 * fallback can never disagree about what the migration is doing.
 *
 * Derived data only. It reads `state` and the outcome the caller was just
 * handed; it persists nothing, defines no transition, infers nothing from
 * source files, and carries no provider-specific UI field. Delete it and the
 * engine is unchanged.
 *
 * `stepsFor(state)` rather than `MIGRATION_STEPS`: a format-9 record was born
 * under the eight-checkpoint lifecycle and must not be shown a phantom
 * DISCOVERY_COMPLETENESS row it never had.
 *
 * `mode` is null for read-only callers (`--status`), which report `none`
 * rather than naming a mode that was never supplied. `outcome`/`reason` are
 * what `nextOutcome` returned for this iteration; `migration_status` has no
 * iteration and passes neither, so a read-only projection is never BLOCKED on
 * anything but the record's own status.
 */
export const CHECKPOINT_STATES = Object.freeze([
  "COMPLETED",
  "ACTIVE",
  "PENDING",
  "BLOCKED",
]);

/** The outcomes that mean the active checkpoint did not move. */
// A pending format upgrade stops the invocation, so the active checkpoint
// renders BLOCKED through the machinery that already renders every other stop.
const STOPPING_OUTCOMES = new Set([
  "BLOCKED",
  "OPERATOR_DECISION",
  "FAILED",
  "FORMAT_UPGRADE",
]);

export const migrationProgress = (
  state,
  {
    lifecycle = null,
    mode = null,
    outcome = null,
    reason = null,
    uiEvidence = null,
    nextWorkKind = null,
    artifactMigration = null,
    // The §4 projection or null. Passed in by the caller that read it; this
    // function performs no I/O, exactly as with `uiEvidence`.
    formatUpgrade = null,
  } = {},
) => {
  const recordLifecycle = lifecycle ?? stepsFor(state);
  const completedSteps = new Set(state.completedSteps);
  const complete = state.currentStep === "COMPLETE";
  const stopped =
    !complete &&
    (STOPPING_OUTCOMES.has(outcome ?? "") || state.status !== "ACTIVE");
  const checkpoints = recordLifecycle.map((name, index) => ({
    index: index + 1,
    total: recordLifecycle.length,
    name,
    state:
      complete || completedSteps.has(name)
        ? "COMPLETED"
        : name !== state.currentStep
          ? "PENDING"
          : stopped
            ? "BLOCKED"
            : "ACTIVE",
  }));
  const activeCheckpoint = complete ? null : (state.currentStep ?? null);
  // The state's own progression order, never sorted: slice ids are not
  // required to be lexicographic, and sorting would misreport the sequence.
  // `pendingSlices` still contains the active slice, so it is filtered against
  // what has already been placed rather than listed twice under two markers.
  const completedSlices = state.completedSlices ?? [];
  const pendingSlices = state.pendingSlices ?? [];
  const placed = new Set(completedSlices);
  if (state.activeSlice) placed.add(state.activeSlice);
  // A reworked slice is shown with its attempt count, so an operator reading
  // the checklist sees `roles-002 (rework 2/3)` rather than an unexplained
  // repeat of work that already looked finished.
  const withAttempts = (id, sliceState) => {
    const attempt = reworkAttemptsOf(state, id);
    return attempt > 0
      ? { id, state: sliceState, rework: { attempt, limit: MAX_SLICE_REWORKS } }
      : { id, state: sliceState };
  };
  const items = [
    ...completedSlices.map((id) => withAttempts(id, "COMPLETED")),
    ...(state.activeSlice
      ? [withAttempts(state.activeSlice, stopped ? "BLOCKED" : "ACTIVE")]
      : []),
    ...pendingSlices
      .filter((id) => !placed.has(id))
      .map((id) => withAttempts(id, "PENDING")),
  ];
  return {
    module: state.legacyModule,
    target: state.targetModule,
    status: state.status,
    revision: state.revision,
    mode: mode ?? "none",
    checkpoints,
    activeCheckpoint,
    activeSlice: complete ? null : (state.activeSlice ?? null),
    slices: {
      completed: completedSlices.length,
      total: items.length,
      items,
    },
    // Visible-UI verification (format 12) is sub-work inside the existing
    // checkpoints -- DISCOVER_LEGACY inventories it, ASSESS_TARGET and PLAN
    // trace it, VERIFY_SLICES proves it per slice, FINALIZE gates it -- so it
    // is reported beneath them and never promoted to a tenth checkpoint.
    // Passed through from the caller that already read the evidence; this
    // function performs no I/O and computes no availability of its own, so a
    // caller without it (`migration_run`) reports null rather than a guess.
    uiEvidence,
    // Reported above the checkpoints by `renderProgress`; only an active
    // increment freezes the checklist below it.
    formatUpgrade,
    blocker: stopped ? (reason ?? null) : null,
    stopReason: stopped ? (outcome ?? state.status) : null,
    // Where the migration resumes, and -- unless it is stopped -- the command
    // that resumes it. A stop keeps the checkpoint, slice, action and artifact,
    // because an operator clearing a blocker still needs to know where they
    // are; it drops `command`, because there is nothing to run until the
    // blocker is cleared and a command field reads as permission to run it.
    // Same rule the text form states as `next: none until the blocker is
    // cleared`, from this one projection.
    nextWork: complete
      ? null
      : {
          ...(nextWorkKind === "RUN_ARTIFACT"
            ? {
                kind: nextWorkKind,
                checkpoint: state.currentStep,
                slice: state.activeSlice ?? null,
                action: "Run the delegated artifact prerequisite.",
                artifact: artifactMigration?.artifactId ?? null,
                command: artifactMigration?.command ?? null,
                artifactMigration,
              }
            : {
                checkpoint: state.currentStep,
                slice: state.activeSlice ?? null,
                action: state.nextAction ?? null,
                artifact: activeArtifact(state),
                command: state.nextCommand ?? null,
              }),
          ...(stopped ? { command: null } : {}),
        },
  };
};

const CHECKPOINT_MARKERS = {
  COMPLETED: "[x]",
  ACTIVE: "[>]",
  PENDING: "[ ]",
  BLOCKED: "[!]",
};

/**
 * The deterministic progress block the agent relays verbatim, rendered from
 * the projection above and from nothing else -- one source, so a provider that
 * reads `progress` and a provider that reads this text can never drift.
 *
 * Pure by contract: no I/O, no timestamps, no randomness, and ASCII only --
 * the five-tree `--status` parity test compares this byte for byte, and emoji
 * do not survive a Windows terminal.
 */
export const renderProgress = (progress) => {
  const lines = [];
  // The owed increment, stated before the checklist it concerns. Absent -- which
  // is every record at the runtime format -- the block is not rendered and the
  // bytes below are the bytes this function always produced.
  const upgrade = progress.formatUpgrade ?? null;
  if (upgrade) {
    // Two headings, because they are two different facts. An inactive
    // increment is owed and nothing more -- the checklist under it is live, so
    // it must not claim to be frozen, and it names the prerequisite the
    // lifecycle is expected to produce rather than an input to author.
    const inactive = upgrade.active === false;
    lines.push(
      inactive ? "FORMAT UPGRADE PENDING" : "FORMAT UPGRADE REQUIRED",
      `record format: ${upgrade.recordFormat}`,
      `runtime format: ${upgrade.runtimeFormat}`,
      `current upgrade: ${upgrade.from}->${upgrade.to}` +
        (upgrade.upgrader
          ? ` (${upgrade.upgrader.id} v${upgrade.upgrader.version})`
          : " (no registered upgrader)"),
      inactive
        ? `upgrade state: ${upgrade.state}`
        : `upgrade state: ${upgrade.state} (domain: ${upgrade.domain ?? "unclassified"})`,
    );
    if (inactive) {
      lines.push(
        `prerequisite: ${upgrade.prerequisite.kind} ${upgrade.prerequisite.path}`,
        "next action: continue normal migration until the prerequisite is validated/pinned",
      );
    } else {
      lines.push(
        `required input: ${
          upgrade.requiredInput
            ? `${upgrade.requiredInput.kind} ${upgrade.requiredInput.path} (authority: ${upgrade.requiredInput.authority})`
            : "none"
        }`,
      );
      for (const blocker of upgrade.blockers ?? []) {
        lines.push(`upgrade blocker: ${blocker}`);
      }
      lines.push(
        `next action: ${upgrade.nextAction}`,
        "--- normal progress (frozen behind the upgrade) ---",
      );
    }
  }
  lines.push(
    `progress: ${progress.module} -> ${progress.target}` +
      `  status=${progress.status}  revision=${progress.revision}` +
      `  mode=${progress.mode}`,
  );
  for (const checkpoint of progress.checkpoints) {
    const active =
      checkpoint.name === progress.activeCheckpoint && progress.activeSlice
        ? `  active=${progress.activeSlice}`
        : "";
    lines.push(
      `${CHECKPOINT_MARKERS[checkpoint.state]} ${checkpoint.index}/${checkpoint.total} ${checkpoint.name}${active}`,
    );
  }
  if (progress.slices.items.length > 0) {
    lines.push(
      `slices: ${progress.slices.completed}/${progress.slices.total} done`,
    );
    for (const slice of progress.slices.items) {
      // Byte-identical for a slice that was never reworked.
      const rework = slice.rework
        ? ` (rework ${slice.rework.attempt}/${slice.rework.limit})`
        : "";
      lines.push(`  ${CHECKPOINT_MARKERS[slice.state]} ${slice.id}${rework}`);
    }
  }
  if (progress.uiEvidence?.applicable) {
    const ui = progress.uiEvidence;
    lines.push(
      `ui evidence: ${ui.state}  runtime=${ui.runtime}` +
        `  records=${ui.records}  limitations=${ui.limitations}` +
        `  freshness=${ui.freshness}`,
    );
  }
  // Only ever present on a stop, so a CONTINUE iteration renders byte for byte
  // what it rendered before this projection existed.
  if (progress.stopReason) {
    lines.push(`stop reason: ${progress.stopReason}`);
    if (progress.blocker) lines.push(`blocker: ${progress.blocker}`);
  }
  // A stop has no executable next step. Naming the checkpoint here read as
  // work the operator could start, directly under a `[!]` row saying they
  // could not -- the one line in the block that contradicted the rest of it.
  if (progress.nextWork) {
    lines.push(
      progress.stopReason
        ? "next: none until the blocker is cleared"
        : `next: ${progress.nextWork.checkpoint}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

/**
 * What a tool row or terminal shows first, with no agent in between: one status
 * line, `progressChecklist` verbatim, then the loop line. Read from the same
 * projection `renderProgress` reads, so it cannot disagree with the checklist
 * under it; ASCII for the same reason. Empty when there is no progress.
 */
export const renderProgressBlock = (
  { progress, progressChecklist, outcome = null },
  loop = "",
) => {
  if (!progress || !progressChecklist) return "";
  const total = progress.checkpoints.length;
  const active = progress.checkpoints.find(
    ({ name }) => name === progress.activeCheckpoint,
  );
  const slice =
    progress.activeSlice &&
    ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(progress.activeCheckpoint)
      ? ` | slice ${progress.activeSlice} (${progress.slices.completed}/${progress.slices.total} done)`
      : "";
  return (
    `${progress.module} -> ${progress.target}` +
    ` | ${active ? `${active.index}/${total} ${active.name}` : `${total}/${total} COMPLETE`}` +
    `${slice} | ${outcome ?? progress.stopReason ?? progress.status}\n` +
    `${progressChecklist}${loop}`
  );
};

/** The pre-projection entry point, kept verbatim for every existing caller. */
export const renderProgressChecklist = (
  state,
  mode,
  outcome = null,
  reason = null,
  formatUpgrade = null,
) =>
  renderProgress(
    migrationProgress(state, { mode, outcome, reason, formatUpgrade }),
  );

/**
 * The projection a *preview* reports. A preview runs no iteration, so the only
 * outcome it can carry is its own refusal: blockers present means this
 * invocation stops, and the block renders at the checkpoint it happened on
 * rather than as an active row the operator could act on.
 */
const previewProgress = (state, mode, blockers) =>
  migrationProgress(state, {
    mode: mode ?? DEFAULT_MODE,
    outcome: blockers.length > 0 ? "BLOCKED" : null,
    reason: blockers.length > 0 ? blockers.join("; ") : null,
  });

export const advanceMigration = async ({
  registryPath,
  projectRoot,
  moduleName,
  mode,
  step,
  slice,
  confirmAdvance,
  hooks,
}) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  const preview = await previewAdvance({
    registryPath,
    moduleName,
    step,
    slice,
    mode,
  });
  if (!preview.requiresConfirmation) {
    throw new Error(preview.blockers.join("; "));
  }
  if (
    typeof confirmAdvance !== "string" ||
    confirmAdvance !== preview.confirmationId
  ) {
    throw new Error(
      "Advance confirmation is missing or expired. Show the current advance pre-execution summary and ask the user to confirm again.",
    );
  }
  const result = await withModuleLock(registryData.targetRoot, resolved.canonical, () =>
    advanceUnderLock({ registryData, resolved, projectRoot, mode, step, slice, preview, hooks }),
  );
  if (!result.registrationPreview || mode !== "auto") return result;
  const { maySelfConfirm } = await import("./migration-policy.mjs");
  if (
    !maySelfConfirm({ command: "registry", mode }) ||
    !maySelfConfirm({ command: "advance", mode })
  ) return result;
  const registration = result.registrationPreview;
  const registered = await updateRegistry({
    registryPath: registration.registryPath,
    projectRoot,
    moduleName: registration.moduleName,
    target: registration.target,
    confirmExecution: registration.confirmationId,
  });
  const continuedPreview = await previewAdvance({
    registryPath, moduleName, step, slice, mode,
  });
  const continued = await advanceMigration({
    registryPath, projectRoot, moduleName, step, slice,
    confirmAdvance: continuedPreview.confirmationId,
    hooks,
  });
  return { ...continued, registration: registered };
};

const advanceUnderLock = async ({
  registryData,
  resolved,
  projectRoot,
  mode,
  step,
  slice,
  preview,
  hooks,
}) => {
  const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
  await recoverPendingAdvance(
    registryData.targetRoot,
    migrationRoot(registryData.targetRoot, resolved.canonical),
    statePath,
  );
  const context = await readState(registryData.targetRoot, resolved.canonical);
  const state = context.state;
  if (stateMappingMismatch(state, resolved)) {
    throw new Error("Migration state mapping does not match the registry.");
  }
  assertRecordToolkitIdentity(state, resolved.canonical, "Advancing this migration");
  // Identity first, then the format upgrade, then the lifecycle. An active
  // increment freezes the checkpoint tuple: no advance shares an invocation
  // with a format upgrade, and this guard is independent of the classifier so a
  // record whose upgrade cannot even be classified still refuses.
  assertNoPendingFormatUpgrade(state, resolved.canonical, "Advancing this migration");
  // Compare-and-swap: the confirmation authorized one exact revision and one
  // exact set of pinned artifacts. Another process that advanced (or a slice
  // that was verified) while this one waited for the lock invalidates it, so a
  // concurrent advance can never silently overwrite a completed transition.
  if (state.revision !== preview.revision) {
    throw new Error(
      `Migration state moved from revision ${preview.revision} to ${state.revision} while this advance was waiting. Nothing was changed; preview again.`,
    );
  }
  if ((await hashFile(statePath)) !== preview.stateHash) {
    throw new Error(
      "Migration state changed while this advance was waiting. Nothing was changed; preview again.",
    );
  }
  await assertCurrentOpenSpecAuthority(registryData.targetRoot, state);
  if (state.status !== "ACTIVE") {
    throw new Error(`Cannot advance migration with status '${state.status}'.`);
  }
  const currentStep = step ?? state.currentStep;
  if (currentStep !== state.currentStep) {
    throw new Error(
      `Cannot advance '${currentStep}'; current step is '${state.currentStep}'.`,
    );
  }
  const activeSlice = slice ?? state.activeSlice;
  if (
    ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep) &&
    !activeSlice
  ) {
    throw new Error(`${currentStep} requires an active slice.`);
  }
  await validateCompletedHashes(context.root, state);
  await assertBriefUnchanged(context.root, state);
  // Everything the checkpoint's own validation resolves is collected here, so
  // the history event records the exact authority this advance consumed rather
  // than whatever the ledger happens to hold when someone reads it later.
  const consumed = new Map();
  const validated = await consumedDecisionStore.run(consumed, () =>
    validateStep(context.root, state, currentStep, activeSlice, {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    }),
  );

  // The machine-generated record of what the checkpoint saw, written before
  // its digest is pinned. It is never trusted as input -- every validation
  // recomputes -- but it lets a FINALIZE drift failure name what changed.
  if (currentStep === "DISCOVERY_COMPLETENESS") {
    await atomicWrite(
      registryData.targetRoot,
      path.join(context.root, DISCOVERY_SCAN_FILE),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: now(),
          ...validated.scan,
          decisionLedgerDigest: await rawDecisionLedgerDigest(context.root),
          decisionLedgerBytes: await rawDecisionLedgerBytes(context.root),
        },
        null,
        2,
      )}\n`,
    );
  }

  const completedSteps = new Set(state.completedSteps);
  const pendingSteps = new Set(state.pendingSteps);
  const artifactHashes = {
    ...state.artifactHashes,
    ...(await completedArtifactHashes(
      context.root,
      state,
      currentStep,
      activeSlice,
    )),
  };
  // Format-8 upgrade: BUILD_BASELINE closed under an older format pinned no
  // rows, so this transaction computes the pin from the matrix as it stands
  // and stamps format 8 with it. Nothing before this point could have been
  // held to a pin that never existed.
  if (
    completedSteps.has("BUILD_BASELINE") &&
    !artifactHashes[BASELINE_ROWS_PIN]
  )
    artifactHashes[BASELINE_ROWS_PIN] = await hashPinnedArtifact(
      context.root,
      BASELINE_ROWS_PIN,
    );
  const lifecycle = stepsFor(state);
  let currentStepIndex = lifecycle.indexOf(currentStep);
  let nextStep = lifecycle[currentStepIndex + 1] ?? "COMPLETE";
  let pendingSlices = [...state.pendingSlices];
  let completedSlices = [...state.completedSlices];
  let nextSlice = activeSlice;
  if (currentStep === "BUILD_BASELINE" && !resolved.registered) {
    if (mode !== "auto" && mode !== "step") {
      throw new Error(
        "Baseline is valid, but the migration mapping is not registered. Use --mode auto or the public registry command before advancing.",
      );
    }
    const registration = {
      registryPath: registryData.registryPath,
      projectRoot,
      moduleName: state.migrationId,
      target: state.targetModule,
    };
    const registryPreview = await previewRegistryUpdate(registration);
    return { registrationPreview: registryPreview };
  }
  if (currentStep === "PLAN") {
    const { slices } = validated;
    for (const plannedSlice of slices) {
      const slicePath = path.join(
        context.root,
        `slices/${plannedSlice.id}.json`,
      );
      if (!(await fileExists(slicePath))) {
        await atomicWrite(
          registryData.targetRoot,
          slicePath,
          `${JSON.stringify(
            {
              id: plannedSlice.id,
              implementationStatus: "PENDING",
              requirementIds: plannedSlice.requirementIds,
              scenarioIds: plannedSlice.scenarioIds,
              traceIds: plannedSlice.traceIds,
              ...(usesCapabilityOwnership(state)
                ? { capabilityIds: plannedSlice.capabilityIds }
                : {}),
              changedFiles: [],
              decisions: [],
              checks: [],
            },
            null,
            2,
          )}\n`,
        );
      }
      const evidencePath = path.join(
        context.root,
        `evidence/${plannedSlice.id}/result.json`,
      );
      if (!(await fileExists(evidencePath))) {
        await atomicWrite(
          registryData.targetRoot,
          evidencePath,
          `${JSON.stringify(
            {
              sliceId: plannedSlice.id,
              result: "PENDING",
              requirementIds: plannedSlice.requirementIds,
              scenarioIds: plannedSlice.scenarioIds,
              traceIds: plannedSlice.traceIds,
              ...(usesCapabilityOwnership(state)
                ? { capabilityIds: plannedSlice.capabilityIds }
                : {}),
              commands: [],
              scenarios: [],
              ...(usesUiVerification(state)
                ? { uiEvidence: [], uiEvidenceLimitations: [] }
                : {}),
              residualRisks: [],
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    const inspected = await inspectSliceArtifacts(context.root);
    const verified = new Set(inspected.verifiedSlices);
    completedSlices = inspected.plannedSlices.filter((id) => verified.has(id));
    pendingSlices = inspected.plannedSlices.filter((id) => !verified.has(id));
    nextSlice = pendingSlices[0];
    if (!nextSlice) throw new Error("Plan did not produce a slice.");
    // A slice's on-disk implementationStatus can read COMPLETE (e.g. a
    // verification-only slice authored before this advance) without
    // IMPLEMENT_SLICES ever having been entered as a checkpoint for it --
    // that record alone must never promote currentStep past IMPLEMENT_SLICES.
    // The checkpoint is only genuinely complete once this engine validates and
    // advances through it, which the IMPLEMENT_SLICES branch below does.
    nextStep = "IMPLEMENT_SLICES";
  } else if (currentStep === "IMPLEMENT_SLICES") {
    nextStep = "VERIFY_SLICES";
  } else if (currentStep === "VERIFY_SLICES") {
    const completed = new Set([...completedSlices, activeSlice]);
    const { plannedSlices } = await inspectSliceArtifacts(context.root);
    completedSlices = plannedSlices.filter((id) => completed.has(id));
    pendingSlices = pendingSlices.filter((id) => id !== activeSlice);
    nextSlice = pendingSlices[0] ?? null;
    nextStep = nextSlice ? "IMPLEMENT_SLICES" : "FINALIZE";
  }

  if (!["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep)) {
    completedSteps.add(currentStep);
    pendingSteps.delete(currentStep);
  }
  if (currentStep === "VERIFY_SLICES" && pendingSlices.length === 0) {
    completedSteps.add("IMPLEMENT_SLICES");
    completedSteps.add("VERIFY_SLICES");
    pendingSteps.delete("IMPLEMENT_SLICES");
    pendingSteps.delete("VERIFY_SLICES");
  }

  const isComplete = currentStep === "FINALIZE";
  if (isComplete) {
    completedSteps.add("FINALIZE");
    pendingSteps.delete("FINALIZE");
    nextStep = "COMPLETE";
    nextSlice = null;
  }
  const nextState = {
    ...state,
    // Never promotes a pre-10 record into the 9-step lifecycle: it closed
    // DISCOVER_LEGACY without the new checkpoint and can never satisfy the
    // 9-step prefix rule.
    formatVersion: stampedFormatVersion(state),
    status: isComplete ? "COMPLETE" : "ACTIVE",
    currentStep: nextStep,
    activeSlice:
      nextStep === "IMPLEMENT_SLICES" || nextStep === "VERIFY_SLICES"
        ? nextSlice
        : null,
    completedSteps: lifecycle.filter((item) => completedSteps.has(item)),
    pendingSteps: lifecycle.filter((item) => pendingSteps.has(item)),
    completedSlices,
    pendingSlices,
    invalidatedArtifacts: [],
    evidenceFreshness: "CURRENT",
    nextAction: isComplete
      ? "Migration is ready for commit."
      : nextStep === "IMPLEMENT_SLICES"
        ? `Implement slice ${nextSlice}.`
        : nextStep === "VERIFY_SLICES"
          ? `Verify slice ${nextSlice}.`
          : `Complete ${STEP_FILES[nextStep]}.`,
    // The record key, matching every other `nextCommand` producer: the
    // migration id is the legacy module at format <= 14 and the target module
    // from 15 on, and it is the only name that reopens the record directory.
    // `legacyModule` is `legacySources[0]` at format 15 -- a source that is
    // typically not registered at all, so following it failed outright.
    nextCommand: isComplete ? null : `/start-migration ${state.migrationId}`,
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "STEP_COMPLETED",
    step: currentStep,
    slice: activeSlice ?? null,
    ...(currentStep === "VERIFY_SLICES" && validated?.visualComparison?.length
      ? { visualComparison: validated.visualComparison }
      : {}),
    // Format 19 only, and only when this advance actually consumed authority.
    // Ordered by decision id so the event -- and therefore the history chain
    // and the integrity anchor over it -- is byte-stable across replays. A
    // group contributed one identity because the resolver recorded the group
    // entry once, keyed by its id, however many members routed through it.
    ...(consumed.size > 0
      ? {
          consumedDecisions: [...consumed.values()].sort((a, b) =>
            a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0,
          ),
        }
      : {}),
    nextStep,
    nextSlice: nextState.activeSlice,
    revision: nextState.revision,
  };
  // One journalled transition: prove the audit record is writable before any
  // state moves (a broken history/ used to advance the checkpoint and then
  // fail), record the intent, write the integrity anchor, write state, append
  // exactly one event, drop the journal. A death in any gap is completed by
  // `recoverPendingAdvance` on the next command, so state, its integrity
  // anchor, and history can never disagree permanently.
  const integrityPath = path.join(context.root, INTEGRITY_FILE);
  const integrityBefore = (await fileExists(integrityPath))
    ? await readFile(integrityPath, "utf8")
    : null;
  const nextIntegrity = await renderIntegrityNow(context.root, nextState, event);
  await assertHistoryAppendable(registryData.targetRoot, context.root);
  const journalFile = path.join(context.root, ADVANCE_JOURNAL);
  // The four points a crash can land between. `hooks.afterWrite` is the same
  // seam `bootstrapMigration` already exposes as `hooks.afterCommit`, and it
  // exists for one reason: recovery is the least exercised and highest
  // consequence code in the engine, and "kill it and hope you hit the window"
  // is not a test. Absent in every real invocation, so the production path is
  // byte-identical.
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: nextState.revision,
    event,
    startedAt: now(),
    pid: process.pid,
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  await hooks?.afterWrite?.("journal");
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await hooks?.afterWrite?.("integrity");
  await atomicWrite(
    registryData.targetRoot,
    context.statePath,
    renderState(nextState),
  );
  await hooks?.afterWrite?.("state");
  await appendHistoryOnce(registryData.targetRoot, context.root, event);
  await hooks?.afterWrite?.("history");
  await rm(journalFile, { force: true });
  return {
    changed: true,
    state: nextState,
    statePath: context.statePath,
    migrationRoot: context.root,
    completedStep: currentStep,
    completedSlice: currentStep === "VERIFY_SLICES" ? activeSlice : null,
    nextArtifact: activeArtifact(nextState),
  };
};
