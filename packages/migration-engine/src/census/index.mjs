/**
 * Census: the module's one public entry (Track A5, option (b) of
 * docs/phase0-architecture-baseline.md).
 *
 * Census owns what a migration knows about its sources before it claims
 * anything: the canonical legacy sources and their binding, the declared
 * module boundary and its roots, the deterministic discovery scan (census,
 * resolution graph, inbound consumers) and its algorithm versions and digest,
 * the legacy and target inventories, discovery completeness and the
 * classification vocabulary, and the artifact engine's source binding,
 * structural census and source inventory document. It imports only
 * decisions/, store/, formats/, shared/ and the leaf `engine-paths.mjs`.
 * Visual rules, history, the module lock, journals and command rendering stay
 * with their owners (docs/architecture/a5-ownership.md).
 *
 * The scanner's pinned parser is still loaded lazily, on the first scan or
 * parse, never at import.
 */
export {
  CENSUS_ALGORITHM_VERSION,
  CENSUS_COMMAND,
  discoveryDigest,
  DiscoveryScannerVersionError,
  kindOf,
  loadTypeScript,
  parserResolutionError,
  PROBE_EXTENSIONS,
  PRODUCTION_REACHABILITY,
  REACHABILITY_VALUES,
  runDiscoveryScan,
  structuralUnits,
  SUPPORTED_ALGORITHM_VERSIONS,
  VISUAL_KINDS,
} from "./scan.mjs";
export {
  assertLegacySourcesUnchanged,
  brownfieldTargetBlocker,
  featureLocalPrefix,
  isBrownfield,
  isUnderFeature,
  legacySourceBinding,
  legacySourcesOf,
  resolveLegacySources,
  targetFeatureDirectory,
} from "./sources.mjs";
export {
  assertDiscoveryUnchanged,
  assertLegacyEvidenceAttributes,
  assertLegacyEvidenceWithinBoundary,
  readCanonicalModuleBoundary,
  sourceOfEvidence,
} from "./boundary.mjs";
export {
  assertLegacyDiscoveryChecklist,
  assertTargetAssessmentChecklist,
  UI_RUNTIME_STATES,
  validateLegacyInventory,
  validateTargetInventory,
} from "./inventory.mjs";
export {
  validateDiscoveryCompleteness,
} from "./completeness.mjs";
export {
  artifactIdFor,
  captureBinding,
  CODE_FILE_EXTENSIONS,
  commandFile,
  dispositionValidator,
  EXTERNAL_ELEMENT,
  externalRequirementPackage,
  FEATURE_INDEX,
  hardcodedUiText,
  hasExecutableCodeFiles,
  isExcluded,
  metrics,
  moduleSpecifiersIn,
  packageNameOf,
  resolveArtifact,
  resolveCompilerBinary,
  SCANNER_REQUIREMENT_KEYS,
  sourcePathAtRoot,
  sourcePathForId,
  STRUCTURAL_SCRIPT_EXTENSIONS,
  TARGET_COMPILER_SPECIFIERS,
  targetCodeFiles,
  targetPathsFor,
  TEST_UNDER_SRC,
  validateEvidenceFile,
  validateSourceEvidenceFile,
  validateSourceInventoryDocument,
} from "./artifact.mjs";
export {
  architectureFindings,
  asEngineFault,
  engineFault,
  legacyDependencies,
  pathKey,
  sourceRequirements,
  structuralParser,
  targetTypeScript,
} from "./toolchain.mjs";
