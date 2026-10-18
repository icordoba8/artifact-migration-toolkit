/**
 * Lifecycle: module checkpoint validation -- the step validators, capability
 * ownership and artifact delegation rows, baseline, plan, slice and gate
 * validation, and the census/slices fact seams (`sliceDriftFacts`). Each one
 * composes the lower domains' rules; none is redefined here. Moved verbatim
 * from `resumable-migration.mjs` (Track A8).
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactIdFor,
  assertDiscoveryUnchanged,
  assertLegacyDiscoveryChecklist,
  assertLegacyEvidenceAttributes,
  assertLegacyEvidenceWithinBoundary,
  assertTargetAssessmentChecklist,
  featureLocalPrefix,
  isBrownfield,
  isUnderFeature,
  legacySourceBinding,
  legacySourcesOf,
  readCanonicalModuleBoundary,
  targetFeatureDirectory,
  validateDiscoveryCompleteness,
  validateLegacyInventory as validateLegacyInventoryRules,
  validateTargetInventory,
} from "../census/index.mjs";
import { engineCommand } from "../engine-paths.mjs";
import { assertApiContractPlanned, assertApiResponseEvidence } from "./api-evidence.mjs";
import {
  CAPABILITY_OWNERSHIP_FILE,
  DISCOVERY_SCAN_FILE,
  initialArtifacts,
  LEGACY_COMPATIBILITY_ACTION_REQUIRED,
  MIGRATION_STEPS,
  MODULE_CLASSIFICATION_FILE,
  UI_PROOF_FORMAT,
  usesArtifactDelegation,
  usesCapabilityOwnership,
  usesDirectLedgerDecisions,
  usesDiscoveryCompleteness,
  usesUiCoverage,
  usesSliceRework,
  usesSourceAttribution,
} from "../formats/index.mjs";
import {
  assertArray,
  assertNonEmpty,
  assertPlainObject,
  assertSafeName,
  assertSecurePath,
  assertUniqueIds,
  dirtyManifest,
  gitRevision,
  isLexicallyWithin as isWithin,
} from "../shared/index.mjs";
import {
  assertCommandResults, assertCompletedEvidenceIntact,
  assertEvidenceResolves,
  evidencePathClaim,
  fileExists,
  fileIdentityMatches,
  migrationRoot,
  readJson,
  resolveEvidencePath,
} from "../store/index.mjs";
import {
  assertRequiredAppearance,
  assertRequiredObservations,
  completedSlicesLackingUiProofV1,
  sliceLacksUiProofV1,
  uiBehaviorIsRequired,
  usesVisualContract,
  validateUiRuntimeEvidence,
  validateVisualAcceptance,
  visualAuthorityOf,
} from "../visual/index.mjs";
import {
  anySliceVerified,
  assertGatesCoverSliceScenarios,
  assertNoUnclaimedTargetDrift,
  assertNoUnresolvedVerification,
  assertPostAnchorEvidence,
  assertSharedPrerequisitesBuilt,
  assertSlicePassed,
  completeSliceAmendment,
  draftSliceAmendment,
  implementationDigests,
  inspectSliceArtifacts,
  legacyRelativePath,
  pendingTargetDriftCandidates,
  readTargetBaseline,
  settleFact,
  targetBaselineDrift,
  targetRelativePath,
  TERMINAL_DESIGN_SYSTEM,
  unlistedSliceCandidates,
  validateSliceImplementation,
  validateSlicePlan,
} from "../slices/index.mjs";
import {
  BEHAVIOR_DISPOSITIONS,
  CAPABILITY_DISPOSITIONS,
  PARITY_STATUSES,
  SHARED_CONSUMER_THRESHOLD,
  SLICE_EARNED_PARITY,
  TERMINAL_PARITY,
} from "./checkpoints.mjs";
import { artifactArgumentsFor, artifactCommandFor } from "./artifact-record.mjs";
import { getArtifactStatus, validateArtifactComplete } from "./artifact-status.mjs";
import { validateGates } from "./gates.mjs";
import { assertStepDocumentComplete } from "./record.mjs";
import { validateExternalUiCapabilities } from "./ui-coverage.mjs";
export const validateLegacyInventory = (root, roots, state) =>
  validateLegacyInventoryRules(root, roots, state, { assertRequiredObservations, assertRequiredAppearance });
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
        const { runDiscoveryScan } = await import("../census/index.mjs");
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
  if (usesUiCoverage(state)) await validateExternalUiCapabilities(root, state, roots, rows);
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
  await assertCommandResults(evidence.commands, `${sliceId} evidence commands`, roots);
  await assertApiResponseEvidence({ root, state, roots, sliceId, scenarioIds: implementation.scenarioIds, commands: evidence.commands });
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

// Contract 5 decision 1.4: the brief is immutable once recorded.
export const assertBriefUnchanged = async (root, state) => {
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

export const validateStep = async (root, state, step, sliceId, roots) => {
  if (!MIGRATION_STEPS.includes(step)) {
    throw new Error(`Unknown migration step '${step}'.`);
  }
  await assertStepDocumentComplete(root, step, state, sliceId);
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
  if (["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"].includes(step)) await assertCompletedEvidenceIntact(root, (state.completedSlices ?? []).filter((id) => id !== (sliceId ?? state.activeSlice)), roots);
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
    await assertApiContractPlanned({ root, state, roots, slices });
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
export const sliceAmendmentFor = async (root, state, roots, sliceId, addFiles) => {
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
export const pendingTargetDriftCandidatesCompat = async (root, state, roots) =>
  pendingTargetDriftCandidates(root, state, roots, await sliceDriftFacts(state, roots));
