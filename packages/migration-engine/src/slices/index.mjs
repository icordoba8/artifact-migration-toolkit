/**
 * Slices: the module's one public entry (Track A4, option (b) of
 * docs/phase0-architecture-baseline.md).
 *
 * Slices owns what a migration's slices claim and prove about target files:
 * the plan's scope and capability coverage, the claim-path spellings, the
 * target baseline and dirty-state comparison, the implementation and
 * verification contracts, reopen ownership, rework and its preserved attempts,
 * add-only amendments, drift ownership and its decision facts, and the
 * reconciliation of navigation with the slice artifacts. It imports only
 * decisions/, store/, formats/ and shared/. Census, visual and lifecycle facts,
 * the module lock, journals and command rendering stay with their owners and
 * are handed in by the seams in `resumable-migration.mjs` and
 * `record-decision.mjs` (docs/architecture/a4-ownership.md).
 *
 * Ownership compares one canonical target-relative spelling (DR4):
 * `targetRelativePath` for owners and `canonicalClaim` for claims, with
 * `ownsPath` as the one subtree test. `repoRelative` is Git syntax, never an
 * identity.
 */
export {
  anySliceVerified,
  TERMINAL_DESIGN_SYSTEM,
  validateSlicePlan,
} from "./plan.mjs";
export {
  assertExternalUiCapabilityRows,
  canonicalClaim,
  diffEntries,
  implementationCoversDrift,
  implementationDigests,
  legacyRelativePath,
  migrationChangedFiles,
  portableRoot,
  readTargetBaseline,
  renderTargetBaseline,
  repoRelative,
  TARGET_DIRTY_SCOPE,
  targetBaselineDrift,
  targetRelative,
  targetRelativePath,
} from "./claims.mjs";
export {
  assertGatesCoverSliceScenarios,
  assertNoUnresolvedVerification,
  assertPostAnchorEvidence,
  assertSharedPrerequisitesBuilt,
  assertSlicePassed,
  delegatedChangedFilesSatisfiedByChild,
  validateSliceImplementation,
} from "./verification.mjs";
export {
  planSliceRework,
  REWORK_ROOT,
  reworkAttemptsOf,
  reworkLimitBlocker,
  reworkPathParts,
} from "./rework.mjs";
export {
  assertNoUnclaimedTargetDrift,
  pendingTargetDriftCandidates,
  settleFact,
  unclaimedTargetDrift,
  unlistedSliceCandidates,
} from "./drift.mjs";
export {
  completeSliceAmendment,
  draftSliceAmendment,
  SLICE_AMENDMENT_ROOT,
} from "./amendment.mjs";
export { assertVerificationFresh, verifiedFileIdentities } from "./freshness.mjs";
export {
  assertSliceStateConsistent,
  inspectSliceArtifacts,
  reconcileSliceState,
} from "./state.mjs";
