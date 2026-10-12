// Track A8 compatibility facade: the artifact lifecycle lives in lifecycle/,
// and its parser-bound structural census in census/toolchain.mjs (whose parser
// still resolves from this file's location). Every BASE export is kept, as the
// same bindings.
// Compatibility re-export (Track A5): these names are census-owned now.
export { artifactIdFor, resolveArtifact } from "../census/index.mjs";
// Compatibility re-export (Track A3): these names are decisions-owned now.
export { artifactDecisionBoundTo, artifactDecisionCandidate } from "../decisions/index.mjs";
// Compatibility re-export (Track A2): these names are formats-owned now.
export {
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
  ARTIFACT_FORMAT_SUPPORTED,
  ARTIFACT_FORMAT_UPGRADE_FLOOR,
  ARTIFACT_FORMAT_VERSION,
  ARTIFACT_RESOLUTIONS,
  ARTIFACT_WORKFLOW_VERSION,
  artifactFormatUpgrade,
} from "../formats/index.mjs";
// Compatibility re-export (Track A1): artifact record persistence lives in store/.
export { artifactEvidenceDigest, artifactRoot } from "../store/index.mjs";
// Track A8: census-owned now (census/toolchain.mjs, or census since A5).
export {
  architectureFindings,
  hasExecutableCodeFiles,
  legacyDependencies,
  structuralUnits,
  targetTypeScript,
} from "../census/index.mjs";
export {
  ARTIFACT_FORMAT_UPGRADERS,
  artifactArgumentsFor,
  artifactCommandFor,
  artifactMetrics,
  artifactOperatorDecisions,
  assertArtifactToolkitIdentity,
  bootstrapArtifact,
  changeArtifactToolkitIdentity,
  artifactCheckpointArtifacts as checkpointArtifacts,
  getArtifactStatus,
  hasCodeValidationCheck,
  previewArtifact,
  previewArtifactFormatUpgrade,
  progressState,
  readArtifactState,
  reconcileArtifactDecisions,
  runArtifact,
  upgradeArtifactFormat,
  validateArtifactComplete,
} from "../lifecycle/index.mjs";
