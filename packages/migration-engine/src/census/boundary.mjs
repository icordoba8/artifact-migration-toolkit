import path from "node:path";
import { assertDirectLedgerClassificationSchema } from "../decisions/index.mjs";
import {
  DISCOVERY_SCAN_FILE,
  MODULE_CLASSIFICATION_FILE,
  usesDiscoveryCompleteness,
  usesApiContract,
  usesSourceAttribution,
  usesUiCoverage,
} from "../formats/index.mjs";
import {
  assertArray,
  assertNonEmpty,
  assertPlainObject,
  isLexicallyWithin as isWithin,
  isPlainObject,
} from "../shared/index.mjs";
import { evidencePathClaim, readJson, resolveEvidencePath } from "../store/index.mjs";
import { DiscoveryScannerVersionError, SUPPORTED_ALGORITHM_VERSIONS } from "./scan.mjs";
import { legacySourcesOf } from "./sources.mjs";

export const moduleEdgeTargetsFrom = (classification) =>
  Object.fromEntries(
    assertArray(classification.findings ?? [], "findings")
      .filter((row) => row?.targets !== undefined)
      .map((row, index) => [
        assertNonEmpty(row?.id, `findings[${index}].id`),
        assertArray(row.targets, `findings[${index}].targets`),
      ]),
  );

export const assertRecordedScannerVersion = (value, label, recovery) => {
  if (value === undefined) {
    throw new DiscoveryScannerVersionError(
      "MISSING_DISCOVERY_SCANNER_VERSION",
      `${label} is missing required algorithmVersion. ${recovery}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new DiscoveryScannerVersionError(
      "INVALID_DISCOVERY_SCANNER_VERSION",
      `${label} algorithmVersion must be an integer; received ${JSON.stringify(value)}. ${recovery}`,
    );
  }
  if (!SUPPORTED_ALGORITHM_VERSIONS.has(value)) {
    throw new DiscoveryScannerVersionError(
      "UNSUPPORTED_DISCOVERY_SCANNER_VERSION",
      `${label} recorded algorithm version ${value}; this build supports ${[...SUPPORTED_ALGORITHM_VERSIONS].join(", ")}. ${recovery}`,
    );
  }
  return value;
};

/**
 * The only module-boundary loader used by DISCOVER_LEGACY,
 * DISCOVERY_COMPLETENESS, --scan, pending decisions, and FINALIZE.
 * Classification records the scanner version so an initialized migration
 * keeps the rules it began with. Missing or invalid versions fail before a
 * scan can silently use the current default.
 */
export const readCanonicalModuleBoundary = async (
  root,
  state,
  roots,
  { scan: precomputed } = {},
) => {
  const classification = assertPlainObject(
    await readJson(
      path.join(root, MODULE_CLASSIFICATION_FILE),
      "Module classification",
    ),
    "Module classification",
  );
  const declaredRoots = assertArray(
    classification.moduleRoots,
    "Module classification moduleRoots",
  );
  if (declaredRoots.length === 0) {
    throw new Error(
      "Module classification must declare at least one module root. The census under the declared roots -- not the import graph -- defines the module, so an undeclared module has no boundary to check.",
    );
  }
  assertDirectLedgerClassificationSchema(classification, state);
  const algorithmVersion = assertRecordedScannerVersion(
    classification.algorithmVersion,
    "Module classification",
    `Record one of ${[...SUPPORTED_ALGORITHM_VERSIONS].join(", ")} explicitly before scanning.`,
  );
  if (usesUiCoverage(state) && algorithmVersion < 4) {
    throw new Error("Format 20 requires discovery scanner algorithm 4 to capture framework ancestors and external UI imports.");
  }
  if (usesApiContract(state) && algorithmVersion < 5) {
    throw new Error("Format 21 requires discovery scanner algorithm 5 to derive the legacy API response contract. Record algorithmVersion 5 in the module classification.");
  }
  const { runDiscoveryScan } = await import("./scan.mjs");
  const scan =
    precomputed ??
    (await runDiscoveryScan({
      legacyRoot: roots.legacyRoot,
      moduleRoots: declaredRoots.map((entry, index) =>
        assertNonEmpty(
          isPlainObject(entry) ? entry.path : entry,
          `moduleRoots[${index}].path`,
        ),
      ),
      declaredEntryPoints: assertArray(
        classification.declaredEntryPoints ?? [],
        "declaredEntryPoints",
      ),
      moduleEdgeTargets: moduleEdgeTargetsFrom(classification),
      algorithmVersion,
    }));
  if (scan.algorithmVersion !== algorithmVersion) {
    throw new Error(
      `Discovery scanner returned algorithm ${scan.algorithmVersion}, but the migration records ${algorithmVersion}.`,
    );
  }
  assertSourcedModuleRoots(declaredRoots, state);
  return { classification, declaredRoots, scan };
};

/** The declared path of a root entry, whichever accepted form it was authored in. */
export const moduleRootPath = (entry) =>
  isPlainObject(entry) ? entry.path : typeof entry === "string" ? entry : null;

/**
 * Which source a root belongs to. A single-source record needs no `source`
 * field -- its one declared name is the only possible answer -- so the field
 * is required exactly where attribution has work to do.
 */
export const moduleRootSource = (entry, sources) =>
  (isPlainObject(entry) ? entry.source : null) ??
  (sources.length === 1 ? sources[0] : null);

/**
 * DR28: the one rule for which roots are implicit -- exempt from
 * ROOT_DECLARATION -- read by DISCOVERY_COMPLETENESS and, through the
 * lifecycle, by the decision recorder, so the gate and the offer cannot drift.
 *
 * At most one per declared source, chosen among the canonical scanner roots
 * named after it (and, where attribution applies, declared as its own): the
 * single `.../src/features/<source>` root when exactly one exists (I3: an
 * `src/app/<source>` route no longer wins by sorting first); none when several
 * feature roots compete, so each needs an operator decision; otherwise the
 * alphabetically first match, as before.
 */
export const implicitModuleRoots = (state, declaredRoots, scanRoots) => {
  const sources = legacySourcesOf(state);
  const ownerOf = usesSourceAttribution(state)
    ? new Map(declaredRoots.map((entry) => [moduleRootPath(entry), moduleRootSource(entry, sources)]))
    : null;
  const implicit = new Set();
  for (const name of sources) {
    const named = [...scanRoots]
      .filter((root) => path.posix.basename(root) === name && (!ownerOf || ownerOf.get(root) === name))
      .sort();
    // Scanner roots are normalized, so a suffix after "/" matches exact path
    // components, never a substring.
    const features = named.filter(
      (root) => root === `src/features/${name}` || root.endsWith(`/src/features/${name}`),
    );
    const chosen = features.length === 0 ? named[0] : features.length === 1 ? features[0] : null;
    if (chosen) implicit.add(chosen);
  }
  return implicit;
};

/**
 * The three rules that make `sourceOfEvidence` total and deterministic, applied
 * at DISCOVERY_COMPLETENESS -- the earliest boundary at which roots truthfully
 * exist, and the checkpoint that already pins them immutable. Nothing reads a
 * root's source before this runs.
 *
 * Format <= 14 classifications, whose entries may be bare strings, are
 * untouched: the field is required only where more than one source converges.
 */
export const assertSourcedModuleRoots = (declaredRoots, state) => {
  if (!usesSourceAttribution(state)) return;
  const sources = legacySourcesOf(state);
  const owned = new Map(sources.map((name) => [name, []]));
  for (const [index, entry] of declaredRoots.entries()) {
    const label = `moduleRoots[${index}]`;
    const rootPath = assertNonEmpty(moduleRootPath(entry), `${label}.path`);
    const source = moduleRootSource(entry, sources);
    if (!source) {
      throw new Error(
        `${label} ('${rootPath}') declares no source. Every module root must name one of the declared legacy sources: ${sources.join(", ")}.`,
      );
    }
    if (!owned.has(source)) {
      throw new Error(
        `${label} ('${rootPath}') names source '${source}', which this migration does not declare. Declared sources are ${sources.join(", ")}.`,
      );
    }
    owned.get(source).push(rootPath);
  }
  // A source that discovered nothing is an error, not an empty set silently
  // carried forward into every per-source cardinality rule downstream.
  for (const [source, roots] of owned) {
    if (roots.length === 0) {
      throw new Error(
        `Legacy source '${source}' owns no module root. Every declared source must contribute at least one root, or it is not being migrated at all.`,
      );
    }
  }
  // Disjointness is what guarantees a path matches at most one root, and so is
  // what makes attribution a function rather than a guess.
  const entries = declaredRoots.map((entry, index) => ({
    path: moduleRootPath(entry),
    source: moduleRootSource(entry, sources),
    index,
  }));
  for (const left of entries) {
    for (const right of entries) {
      if (left.index >= right.index || left.source === right.source) continue;
      if (
        left.path === right.path ||
        left.path.startsWith(`${right.path}/`) ||
        right.path.startsWith(`${left.path}/`)
      ) {
        throw new Error(
          `Module roots '${left.path}' (${left.source}) and '${right.path}' (${right.source}) overlap or nest. Roots belonging to different legacy sources must be disjoint, or evidence under them cannot be attributed to one source.`,
        );
      }
    }
  }
  return declaredRoots;
};

/**
 * Attribution as a pure prefix function over the pinned module roots, not a new
 * path syntax. Both sources live in one repository, so a `<source>:<path>`
 * qualifier would resolve against the same root and disambiguate nothing;
 * resolution was never the problem, attribution was.
 *
 * Returns the owning source name, or `null` when the claim sits under no
 * declared root.
 */
export const sourceOfEvidence = (claim, classification, sources = []) => {
  for (const entry of classification?.moduleRoots ?? []) {
    const rootPath = moduleRootPath(entry);
    if (!rootPath) continue;
    if (claim === rootPath || claim.startsWith(`${rootPath}/`)) {
      return moduleRootSource(entry, sources);
    }
  }
  return null;
};

export const assertLegacyEvidenceWithinBoundary = async (inventory, scan, roots) => {
  const relationPaths = scan.boundary
    ? [
        ...scan.boundary.owned,
        ...scan.boundary.supporting,
        ...scan.boundary.inboundConsumers,
        ...scan.boundary.governingFramework,
      ].map((entry) => entry.path)
    : [...scan.census, ...scan.supporting];
  const known = new Set(relationPaths);
  const cited = new Set();
  for (const item of [
    ...(inventory.behaviors ?? []),
    ...(inventory.routeFlows ?? []),
    ...(inventory.uiBehaviors ?? []),
  ]) {
    for (const evidence of item?.evidence ?? []) {
      const claim = evidencePathClaim(
        typeof evidence === "string" ? evidence : evidence?.location,
      );
      if (!claim) continue;
      const absolute = await resolveEvidencePath(claim, roots);
      if (!absolute || !isWithin(roots.legacyRoot, absolute)) continue;
      const relative = path
        .relative(roots.legacyRoot, absolute)
        .split(path.sep)
        .join("/");
      if (!known.has(relative)) cited.add(relative);
    }
  }
  if (cited.size > 0) {
    throw new Error(
      `${cited.size} legacy evidence location(s) sit outside the canonical module boundary: ${[...cited].sort().join(", ")}. Evidence must be OWNED, typed SUPPORTING, an INBOUND_CONSUMER, or GOVERNING_FRAMEWORK; widening ownership to reach it is not allowed.`,
    );
  }
};

/**
 * Every legacy-side claim must land under a declared root, so the engine can
 * answer which source it belongs to. Without this the union cardinality rule
 * and every per-source coverage check are guessing, and evidence that drifted
 * outside the module boundary is indistinguishable from evidence that did not.
 */
export const assertLegacyEvidenceAttributes = async (
  values,
  label,
  { roots, state, classification },
) => {
  const sources = legacySourcesOf(state);
  for (const value of values) {
    const claim = evidencePathClaim(
      typeof value === "string" ? value : value?.location,
    );
    if (!claim) continue;
    const absolute = await resolveEvidencePath(claim, roots);
    if (!absolute || !isWithin(roots.legacyRoot, absolute)) continue;
    const relative = path
      .relative(roots.legacyRoot, absolute)
      .split(path.sep)
      .join("/");
    if (sourceOfEvidence(relative, classification, sources)) continue;
    throw new Error(
      `${label} references '${claim}', which sits under none of the declared module roots (${(classification.moduleRoots ?? []).map((entry) => moduleRootPath(entry)).join(", ")}). Legacy evidence must attribute to exactly one source.`,
    );
  }
  return values;
};

/**
 * The smaller FINALIZE check: not a re-run of the whole checkpoint, just proof
 * that the module is still the module that was classified. A file added to an
 * owned root during implementation is otherwise carried to COMPLETE with no
 * disposition at all -- exactly the hole this checkpoint closes, reopened by
 * the passage of time.
 *
 * Deliberately not an eighth gate: `FINAL_GATES` is exactly seven and
 * `gates.json` requires exactly those, so adding one would rewrite every
 * existing record to duplicate what FUNCTIONAL_PARITY_GATE already reports.
 */
export const assertDiscoveryUnchanged = async (root, state, roots) => {
  if (!usesDiscoveryCompleteness(state)) return;
  // ponytail: an explicit UI remediation binds its own current legacy UI
  // evidence without reopening unrelated completed discovery.
  if (state.artifacts.uiRemediation) return;
  const recorded = await readJson(
    path.join(root, DISCOVERY_SCAN_FILE),
    "Discovery scan",
  );
  const algorithmVersion = assertRecordedScannerVersion(
    recorded.algorithmVersion,
    "DISCOVERY_COMPLETENESS",
    "Reopen discovery to recompute rather than comparing incomparable digests.",
  );
  const { runDiscoveryScan } = await import("./scan.mjs");
  const scan = await runDiscoveryScan({
    legacyRoot: roots.legacyRoot,
    moduleRoots: recorded.moduleRoots,
    declaredEntryPoints:
      (recorded.declaredEntryPoints ??
        (recorded.entryPoints ?? [])
          .filter((entry) => entry.discovery === "DECLARED")
          .map((entry) => entry.path))
        .map((entryPath) => ({
          path: entryPath,
          reason: recorded.entryPoints?.find((entry) => entry.path === entryPath)?.reason,
        })),
    moduleEdgeTargets: Object.fromEntries(
      (recorded.findings ?? [])
        .filter((finding) => Array.isArray(finding.resolvedTargets))
        .map((finding) => [finding.id, finding.resolvedTargets]),
    ),
    algorithmVersion,
  });
  if (scan.discoveryDigest === recorded.discoveryDigest) return;
  const added = scan.census.filter(
    (file) => !(recorded.census ?? []).includes(file),
  );
  const removed = (recorded.census ?? []).filter(
    (file) => !scan.census.includes(file),
  );
  const detail = [
    added.length > 0 ? `added: ${added.join(", ")}` : null,
    removed.length > 0 ? `removed: ${removed.join(", ")}` : null,
    added.length === 0 && removed.length === 0
      ? "the census is unchanged, so an entry point, resolution rule, or unresolved reference moved"
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(
    `The legacy module changed after DISCOVERY_COMPLETENESS closed (${detail}). Recorded digest ${recorded.discoveryDigest}, current ${scan.discoveryDigest}. Reopen discovery so the new facts get a disposition before finalizing.`,
  );
};
