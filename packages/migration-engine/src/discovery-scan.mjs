/**
 * Compatibility entry (Track A5): the deterministic discovery scanner lives in
 * `census/scan.mjs` and is reached through `census/index.mjs`. This file keeps
 * the scanner's public import path and its installed location -- the pinned
 * `ts-discovery-compiler` still resolves from this directory.
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
} from "./census/index.mjs";
