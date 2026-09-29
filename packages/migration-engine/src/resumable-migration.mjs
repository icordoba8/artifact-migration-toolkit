import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CENSUS_ALGORITHM_VERSION,
  DiscoveryScannerVersionError,
  SUPPORTED_ALGORITHM_VERSIONS,
} from "./discovery-scan.mjs";
import { engineCommand } from "./engine-paths.mjs";

import {
  assertNoPendingTransaction,
  assertPonytailTarget,
  assertSafeName,
  assertSecurePath,
  atomicWrite,
  commitsIntroducingBlob,
  commitsTouchingSince,
  committedChangesSince,
  contentIdentity,
  contentIdentityMatches,
  DESIGN_SOURCES,
  dirtyManifest,
  fileAtRevision,
  gitRevision,
  headRevision,
  isAncestorCommit,
  isContentIdentity,
  pendingTransactions,
  persistProjectRegistryBinding,
  previewProjectRegistryBinding,
  readRegistry,
  registryIdentity,
  resolveDesignSource,
  resolveLegacySources,
  resolveModule,
} from "./migration-utils.mjs";
import { withModuleLock, writeJournalAtomic } from "./module-lock.mjs";
import {
  classifyUpgrade,
  nextIncrement,
  upgradeIsActive,
  upgradeProjection,
} from "./format-upgrade.mjs";
import {
  FIGMA_PROVENANCE_KINDS,
  FIXED_VISUAL_TOLERANCE,
  HARDENED_VISUAL_VERSION,
  decodePng,
  perceptualDelta,
  structuralDelta,
  REQUIRED_FACT_KINDS,
  REQUIRED_FACT_NAMES,
  assertProvenancePrecedence,
  missingRequiredGroups,
  normalizeVisualValue,
  resolveDesignContextFact,
  resolveMetadataAssets,
  resolveMetadataFact,
  resolveVariableDefsFact,
  variableValueSet,
  xmlAttribute,
} from "./visual-evidence.mjs";
import {
  activeToolkitIdentity,
  autoAdoptableToolkitTransition,
  digestToolkitIdentity,
  renderToolkitIdentity,
  sameToolkitIdentity,
  TOOLKIT_IDENTITY_EVENTS,
  toolkitIdentityBlocker,
  toolkitIdentityKey,
  toolkitIdentityStatus,
  validateToolkitIdentity,
} from "./toolkit-identity.mjs";

// Loaded only when a format-13 row delegates work. The artifact engine imports
// this module's facade for shared policy, so a static reverse import would put
// migration-policy in an ESM initialization cycle.
const artifactEngine = () =>
  import("./artifact/artifact-migration.mjs");

export const RESUMABLE_CONTRACT_VERSION = 5;
export const MIGRATION_FORMAT_VERSION = 18;
export const WORKFLOW_VERSION = "5.0";

/**
 * The earliest format this contract executes at all. Below it a record is
 * refused with the explicit upgrade command and never converted implicitly.
 */
export const EARLIEST_SUPPORTED_FORMAT = 4;

/**
 * The first format that owns the DISCOVERY_COMPLETENESS checkpoint. A record
 * born under an older format keeps the 8-step lifecycle it was validated
 * against for its whole life; inserting a step into a persisted record would
 * invalidate every `completedSteps` prefix it ever wrote.
 */
export const DISCOVERY_COMPLETENESS_FORMAT = 10;

export const usesDiscoveryCompleteness = (state) =>
  (state?.formatVersion ?? 1) >= DISCOVERY_COMPLETENESS_FORMAT;

/**
 * The first format that owns `matrices/capability-ownership.json`. Unlike the
 * DISCOVERY_COMPLETENESS bump this inserts no checkpoint, so the
 * `completedSteps` prefix invariant is untouched and the transition is
 * self-healing -- but the matrix is authored, not derived, so a record that
 * already closed BUILD_BASELINE can never be promoted into it (see
 * `stampedFormatVersion`).
 */
export const CAPABILITY_OWNERSHIP_FORMAT = 11;

export const usesCapabilityOwnership = (state) =>
  (state?.formatVersion ?? 1) >= CAPABILITY_OWNERSHIP_FORMAT;

export const UI_VERIFICATION_FORMAT = 12;
export const usesUiVerification = (state) =>
  (state?.formatVersion ?? 1) >= UI_VERIFICATION_FORMAT;

export const ARTIFACT_DELEGATION_FORMAT = 13;
export const usesArtifactDelegation = (state) =>
  (state?.formatVersion ?? 1) >= ARTIFACT_DELEGATION_FORMAT;

/**
 * The first format that records a `designSource` (and, when it is `figma-mcp`,
 * a persisted `figmaSources` list plus an agent-authored
 * `inventories/figma-context.json`). Purely additive and self-healing: the
 * default `target-system` requires no new artifact, so a pre-14 record simply
 * behaves as `target-system` by omission and is never promoted (see
 * `stampedFormatVersion`).
 */
export const DESIGN_SOURCE_FORMAT = 14;
export const usesDesignSource = (state) =>
  (state?.formatVersion ?? 1) >= DESIGN_SOURCE_FORMAT;

/**
 * The first format in which N legacy sources converge on one target. Two state
 * keys (`legacySources`, `targetAdoption`), one identity rule change
 * (`migrationId === targetModule`, so the record directory and the module lock
 * key on the one thing that stays singular), and one new immutable RESOLVE
 * artifact for a brownfield target. Additive and self-healing in the same sense
 * as format 14: a pre-15 record keeps `migrationId === legacyModule`, carries
 * neither key, and is never promoted (see `stampedFormatVersion`).
 */
export const MULTI_SOURCE_FORMAT = 15;
export const usesMultiSource = (state) =>
  (state?.formatVersion ?? 1) >= MULTI_SOURCE_FORMAT;

/**
 * The first format that owns controlled same-slice rework at VERIFY_SLICES: a
 * `FAIL` result carrying `defects[]`, the byte-exact preserved attempt under
 * `rework/<slice-id>-<n>/`, the permanent `artifactHashes` pins over it, the
 * `REWORK_EVIDENCE_MISSING` refusal, the per-slice attempt counter, and the
 * FINALIZE terminal-PASS freshness and preservation assertions.
 *
 * Additive and self-healing in the same sense as 12, 13 and 14. A record with
 * zero reworks is indistinguishable from a pre-16 record: it carries no
 * attempt counter and no preserved attempts, so the permanent pins and the
 * `REWORK_EVIDENCE_MISSING` check have nothing to apply to, and FINALIZE must
 * not retroactively demand records that never existed. Nothing about format 16
 * requires an artifact an older record should have authored earlier, so no
 * explicit upgrade command is introduced.
 *
 * The unclaimed-target-drift refusal at FINALIZE rides the same bump, because
 * classifying drift as `AUTHORIZED_REWORK` needs the rework vocabulary to
 * classify against.
 */
export const SLICE_REWORK_FORMAT = 16;
export const usesSliceRework = (state) =>
  (state?.formatVersion ?? 1) >= SLICE_REWORK_FORMAT;

/**
 * The first format in which a figma-mcp record is held to Figma *fidelity*, not
 * only Figma *provenance*. Before it, `figmaContextDigest` proved that runtime
 * evidence was contemporaneous with a pinned design file and nothing about what
 * the rendering looked like. Format 17 adds, for figma-mcp only:
 *
 * - canonical per-frame evidence in `inventories/figma-context.json`: the node
 *   identity, viewport, design states, extraction fidelity, and the verbatim
 *   Figma MCP outputs persisted and hashed inside the record;
 * - `matrices/visual-acceptance.json`, authored at BUILD_BASELINE from that
 *   evidence and pinned: one row per required UI behavior state, with expected
 *   visual facts and explicit tolerances;
 * - an engine-owned comparison of those facts against runtime measurements at
 *   VERIFY_SLICES, and a refusal to verify a slice that traces a
 *   non-terminal design-system row.
 *
 * Non-promoting, like 10 and 11: both artifacts are authored, so a format-16
 * figma-mcp record keeps its provenance-only semantics for its whole life and
 * a completed record is never reinterpreted. A target-system record gains no
 * obligation at all.
 */
export const VISUAL_ACCEPTANCE_FORMAT = 17;
export const usesVisualAcceptance = (state) =>
  (state?.formatVersion ?? 1) >= VISUAL_ACCEPTANCE_FORMAT;

/**
 * Format 18: every legacy `uiBehaviors[]` item carries `requiredObservations[]`,
 * the frozen acceptance set a TARGET proof is measured against. Non-promoting:
 * a missing array is an unadopted contract, never an empty one, so an older UI
 * record reaches 18 only through the explicit UI_OBSERVATIONS_ADOPTED transition.
 */
export const REQUIRED_OBSERVATIONS_FORMAT = 18;
export const usesRequiredObservations = (state) =>
  (state?.formatVersion ?? 1) >= REQUIRED_OBSERVATIONS_FORMAT;
/**
 * The format from which every increment is owned by the upgrade registry
 * (`FORMAT_UPGRADERS`, below): at or above it, `state.formatVersion` is a real
 * cursor that moves one adjacent step per committed transaction and is never
 * walked past. Below it the pre-existing compatibility semantics are untouched
 * -- `compatibilityBlocker`, `SELF_HEALING_FORMAT_VERSIONS`, `FORMAT_FEATURES`
 * and the typed one-shot legacy adoptions.
 *
 * Declared, never derived: formats 10 and 11 are permanently non-promoting by
 * design, so no adjacent upgrader for them can ever exist and a blunt
 * "record < runtime freezes" rule cannot reach back to format 4.
 *
 * It lives beside the format constants rather than beside the registry so
 * `formatIsPromoting` reads it with no temporal-dead-zone question.
 */
export const FORMAT_UPGRADE_FLOOR = VISUAL_ACCEPTANCE_FORMAT;

/**
 * The one reader of the required-observations adoption transition, in both of
 * its spellings: the historical top-level event, written before the format
 * registry existed and by the pre-floor explicit adoption, and the canonical
 * `FORMAT_UPGRADED` envelope the registered adjacent 17 -> 18 row writes with
 * the transition subordinate to it. Append-only history is never rewritten, so
 * both are valid forever and exactly one predicate decides it.
 */
export const isUiObservationsAdoption = (event) =>
  event?.event === "UI_OBSERVATIONS_ADOPTED" ||
  (event?.event === "FORMAT_UPGRADED" &&
    event?.transition === "UI_OBSERVATIONS_ADOPTED");

export const UI_OBSERVATIONS_ADOPTION_ROOT = "ui-observations-adoption";
export const UI_OBSERVATIONS_CANDIDATE_FILE = `${UI_OBSERVATIONS_ADOPTION_ROOT}/candidate/legacy.json`;
/**
 * Whether this record derives a format-17 visual contract at all. True for
 * every record whose design source pins a visual authority (`VISUAL_AUTHORITIES`),
 * false for `target-system`, which designs nothing and is held to nothing.
 */
const usesVisualContract = (state) =>
  usesVisualAcceptance(state) && visualAuthorityOf(state) !== null;

/**
 * Whether evidence has to say *which* source it belongs to. Attribution exists
 * to answer that question, and the question only has content when more than one
 * source converges: a single-source record attributes everything to its one
 * declared name by construction.
 *
 * ponytail: gating on the source count rather than on the format keeps a
 * single-source format-15 record behaviourally identical to a format-14 one,
 * so the format bump alone changes nothing about how evidence is authored.
 * Upgrade path if per-source rules ever apply to a lone source: drop the
 * count test and require `source` on every root.
 */
const usesSourceAttribution = (state) =>
  usesMultiSource(state) && (state?.legacySources?.length ?? 0) > 1;

/** Declared legacy sources, as the one reader every format may call. */
export const legacySourcesOf = (state) =>
  state?.legacySources ?? (state?.legacyModule ? [state.legacyModule] : []);

/**
 * Whether the target was already substantially implemented when the record was
 * created. Every format below 15 is greenfield by omission, exactly as every
 * format below 14 is `target-system` by omission.
 */
export const isBrownfield = (state) =>
  usesMultiSource(state) && state?.targetAdoption?.mode === "BROWNFIELD";

/**
 * The one gate every format-10 discovery operation passes through, wherever it
 * is entered from: `--scan`, `previewDiscoveryScan`, an explicitly requested
 * `DISCOVERY_COMPLETENESS` validation, or the operator recorder. The main
 * preview/advance/FINALIZE paths already branch on the format, but these
 * auxiliary entry points reached the format-10 engine directly, so a pre-10
 * record could run a census it has no checkpoint for and collect decisions its
 * lifecycle never reads.
 *
 * Refuses before anything is read or written, so a rejected operation leaves
 * the migration directory byte-identical.
 */
export const assertDiscoveryCompletenessFormat = (
  state,
  moduleName,
  operation,
) => {
  if (usesDiscoveryCompleteness(state)) return;
  throw new Error(
    `${operation} is a format-${DISCOVERY_COMPLETENESS_FORMAT} operation, but migration '${moduleName}' is format ${state?.formatVersion ?? 1} and has no DISCOVERY_COMPLETENESS checkpoint. Nothing was read or written. Finish this migration on the lifecycle it was validated against, or start a new one to get discovery completeness.`,
  );
};

/**
 * Format 5 adds `integrity.json`, an artifact-hash anchor written outside
 * `state.json` in the same transaction as every advance (P1-1). It changes no
 * `state.json` field, so a format-4 tree stays fully readable and writable:
 * it just has no anchor to check yet. The next advance self-heals it to
 * format 5 by writing one. No explicit upgrade command is required for this
 * transition, unlike the contract-4-to-5 rewrite below.
 *
 * Format 6 requires the P1-7 machine-readable evidence checklist for any
 * DISCOVER_LEGACY/ASSESS_TARGET step not yet completed, and structured
 * changed-file/command-result evidence for any not-yet-completed
 * IMPLEMENT_SLICES/VERIFY_SLICES slice. Already-completed steps and slices
 * are grandfathered under their original shape (see the comment on
 * `assertEvidenceChecklist`), so this is exactly as self-healing as the
 * format-4-to-5 transition: no explicit upgrade command is required, and the
 * pre-existing format-4 records already past DISCOVER_LEGACY/ASSESS_TARGET keep
 * resuming unchanged.
 *
 * Format 7 adds `legacyDirtyDigest`/`targetDirtyDigest` to every gate
 * evidence entry's `boundTo` (P1-10): `legacyRevision`/`targetRevision` alone
 * never move while a slice edits an uncommitted file, so evidence authored
 * before such an edit still looked fresh. `validateGates` only runs while
 * advancing into FINALIZE, so an already-`COMPLETE` migration's `gates.json`
 * is never re-validated and needs no upgrade; a migration still short of
 * FINALIZE just authors the new fields when it gets there, same as format 6.
 *
 * Format 8 pins `BASELINE_ROWS_PIN` at BUILD_BASELINE (P2-2). A migration that
 * closed BUILD_BASELINE under an older format has no such pin, so the next
 * advance computes it from the matrix as it stands then and stamps format 8 in
 * the same transaction; until that advance the pin is not required. That is
 * the versioned upgrade -- the rows an older migration is held to are the rows
 * it had when it upgraded, not rows nobody ever pinned.
 *
 * Format 9 adds `integrity.history`, the append-only anchor for
 * `history.ndjson` (P2-3). An older tree has no anchor, exactly as a format-4
 * tree has no `integrity.json` at all: it is not blocked for the missing
 * anchor, and the next advance writes one covering the record as it then
 * stands.
 *
 * Format 10 inserts the DISCOVERY_COMPLETENESS checkpoint after
 * DISCOVER_LEGACY. This is the one transition that is deliberately *not*
 * self-healing: `completedSteps` must be an in-order prefix of the lifecycle,
 * so a record that already closed DISCOVER_LEGACY under the 8-step list can
 * never satisfy the 9-step prefix without inventing a checkpoint nobody ran.
 * Instead every pre-10 record keeps executing the 8-step lifecycle to
 * completion (`stepsFor`), and an advance stamps 9 rather than 10 for it. Only
 * a migration bootstrapped at format 10 gets the new checkpoint, and only such
 * a record ever runs the scan, the decision reader, or the FINALIZE drift
 * assertion.
 *
 * Format 11 adds `matrices/capability-ownership.json` at BUILD_BASELINE: the
 * decision of *where* a capability missing from the target gets built (shared
 * layer vs. inside the feature). Like format 10 it is deliberately *not*
 * self-healing, for the same reason and a second one. The matrix is authored
 * from legacy and target evidence, so it cannot be computed after the fact the
 * way `BASELINE_ROWS_PIN` could; and promoting a record mid-flight would let
 * BUILD_BASELINE close without the matrix and then have PLAN demand it, since
 * the format is read before the stamp is written. A pre-11 record therefore
 * runs to completion without capability ownership, and only a migration
 * bootstrapped at format 11 ever authors one.
 *
 * Format 12, 13, and 14 are additive in the same way and self-heal likewise.
 *
 * Format 15 is the multi-source/brownfield bump. 14 joins this set in the same
 * indivisible change: `compatibilityBlocker` treats `formatVersion ===
 * MIGRATION_FORMAT_VERSION` as supported, so the moment the constant became 15
 * every existing format-14 record would otherwise fall into the "unsupported and is never
 * converted" branch.
 */
/**
 * W10-1. Derived, not hand-maintained. The literal set had to be edited in
 * lockstep with `MIGRATION_FORMAT_VERSION` and had already been missed once:
 * because `compatibilityBlocker` treats `formatVersion === MIGRATION_FORMAT_VERSION`
 * as supported, the moment the constant moved, the *previous* format fell into
 * the "unsupported and never converted" branch. A hand-maintained set adjacent
 * to a constant that changes is a recurring defect, not a one-off.
 *
 * Every supported format below the current one self-heals, except the two
 * documented non-healing bumps below.
 */
/**
 * Every format below the current one that this contract still executes. Derived
 * from the two constants, so bumping `MIGRATION_FORMAT_VERSION` cannot orphan
 * the format that was current a moment ago.
 *
 * This set answers "may this record run", and nothing else. Whether an advance
 * *promotes* a record's stamp is a different question with a different answer,
 * and it lives in `FORMAT_FEATURES` below. Conflating them would make a
 * non-promoting bump unexecutable: formats 10 and 11 are never promoted into,
 * yet a format-10 record must still run its own lifecycle to completion.
 */
const SELF_HEALING_FORMAT_VERSIONS = new Set(
  Array.from(
    { length: MIGRATION_FORMAT_VERSION - EARLIEST_SUPPORTED_FORMAT },
    (_unused, index) => EARLIEST_SUPPORTED_FORMAT + index,
  ),
);

/**
 * The two bumps an advance never promotes a record into, documented at their
 * definition instead of as an ordered chain of negations.
 *
 * Format 10 inserts the DISCOVERY_COMPLETENESS checkpoint after DISCOVER_LEGACY.
 * `completedSteps` must be an in-order prefix of the lifecycle, so a record that
 * already closed DISCOVER_LEGACY under the 8-step list can never satisfy the
 * 9-step prefix without inventing a checkpoint nobody ran.
 *
 * Format 11 adds `matrices/capability-ownership.json` at BUILD_BASELINE. The
 * matrix is *authored* from legacy and target evidence, so it cannot be
 * computed after the fact; and promoting a record mid-flight would let
 * BUILD_BASELINE close without the matrix and then have PLAN demand it, since
 * the format is read before the stamp is written.
 *
 * Every other bump is additive and derivable, so a record simply behaves as the
 * feature's default by omission and is stamped at the highest format whose
 * vocabulary it actually uses.
 */
export const NON_PROMOTING_FORMAT_VERSIONS = Object.freeze([
  DISCOVERY_COMPLETENESS_FORMAT,
  CAPABILITY_OWNERSHIP_FORMAT,
  VISUAL_ACCEPTANCE_FORMAT,
  REQUIRED_OBSERVATIONS_FORMAT,
]);

/**
 * W10-2. The format an advance stamps, as a declarative table scanned
 * highest-first instead of an ordered chain of negations. It never promotes an
 * older record into a lifecycle step, an authored artifact, or a vocabulary it
 * never ran. Adding a format is one row here plus one constant above; there is
 * no third place, which is what the negation chain kept growing.
 */
const FORMAT_FEATURES = [
  [REQUIRED_OBSERVATIONS_FORMAT, usesRequiredObservations],
  [VISUAL_ACCEPTANCE_FORMAT, usesVisualAcceptance],
  [SLICE_REWORK_FORMAT, usesSliceRework],
  [MULTI_SOURCE_FORMAT, usesMultiSource],
  [DESIGN_SOURCE_FORMAT, usesDesignSource],
  [ARTIFACT_DELEGATION_FORMAT, usesArtifactDelegation],
  [UI_VERIFICATION_FORMAT, usesUiVerification],
  [CAPABILITY_OWNERSHIP_FORMAT, usesCapabilityOwnership],
  [DISCOVERY_COMPLETENESS_FORMAT, usesDiscoveryCompleteness],
];

const stampedFormatVersion = (state) => {
  // Lowest unmet feature wins: a record that predates the capability matrix is
  // stamped 10 even though it also predates every later feature.
  const unmet = FORMAT_FEATURES.filter(([, uses]) => !uses(state));
  return unmet.length === 0
    ? MIGRATION_FORMAT_VERSION
    : Math.min(...unmet.map(([version]) => version)) - 1;
};

/** The supported formats, for the SKILL.md compatibility table (W10-3). */
export const SUPPORTED_FORMAT_VERSIONS = Object.freeze(
  Array.from(
    { length: MIGRATION_FORMAT_VERSION - EARLIEST_SUPPORTED_FORMAT + 1 },
    (_unused, index) => EARLIEST_SUPPORTED_FORMAT + index,
  ),
);

/** Whether a record at this format still executes under the current contract. */
export const formatIsSupported = (version) =>
  version === MIGRATION_FORMAT_VERSION ||
  SELF_HEALING_FORMAT_VERSIONS.has(version);

/**
 * Whether an advance may promote a record's stamp *into* this format.
 *
 * Above the upgrade floor the registry is the sole promoter, so a future
 * developer cannot add a row to `FORMAT_FEATURES` and have an ordinary advance
 * stamp a format whose upgrader was never written. Below the floor this is
 * exactly the table it always was.
 */
export const formatIsPromoting = (version) =>
  !NON_PROMOTING_FORMAT_VERSIONS.includes(version) &&
  version <= FORMAT_UPGRADE_FLOOR;

/**
 * The format at which `integrity.json`, the history anchor, and the
 * baseline-row pin all became mandatory. Frozen at 9 rather than tracking
 * `MIGRATION_FORMAT_VERSION`: bumping the format version must not silently
 * relax an anchor that older records already carry, and for the baseline pin
 * it must not, because `artifactHashes` is compared as an exact set.
 */
const ANCHORED_FORMAT_VERSION = 9;

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

export const UPGRADABLE_CONTRACT_VERSION = 4;
export const UPGRADABLE_FORMAT_VERSION = 3;

export const upgradeCommandFor = (moduleName) =>
  engineCommand("upgrades/upgrade-migration.mjs", moduleName);

/**
 * Explicit source-version classification. Contract 5 never executes an older
 * contract and never converts one implicitly; it routes the operator to the
 * explicit upgrade command and leaves every file untouched.
 */
export const compatibilityBlocker = (state, moduleName) => {
  const contractVersion = state.contractVersion;
  const formatVersion = state.formatVersion ?? 1;
  if (
    contractVersion === RESUMABLE_CONTRACT_VERSION &&
    (formatVersion === MIGRATION_FORMAT_VERSION ||
      SELF_HEALING_FORMAT_VERSIONS.has(formatVersion))
  ) {
    return null;
  }
  if (
    contractVersion === UPGRADABLE_CONTRACT_VERSION &&
    formatVersion === UPGRADABLE_FORMAT_VERSION
  ) {
    return `Migration '${moduleName}' uses contract ${UPGRADABLE_CONTRACT_VERSION} format ${UPGRADABLE_FORMAT_VERSION}. Contract ${RESUMABLE_CONTRACT_VERSION} cannot execute it. Run the explicit upgrade first: ${upgradeCommandFor(moduleName)}`;
  }
  if (
    contractVersion > RESUMABLE_CONTRACT_VERSION ||
    formatVersion > MIGRATION_FORMAT_VERSION
  ) {
    return `Migration '${moduleName}' uses contract ${contractVersion} format ${formatVersion}, which is newer than the supported contract ${RESUMABLE_CONTRACT_VERSION} format ${MIGRATION_FORMAT_VERSION}. Update start-migration before continuing. No file was changed.`;
  }
  return `Migration '${moduleName}' uses contract ${contractVersion} format ${formatVersion}, which is unsupported and is never converted. It was left untouched.`;
};

export const MIGRATION_STEPS = [
  "RESOLVE",
  "DISCOVER_LEGACY",
  "DISCOVERY_COMPLETENESS",
  "ASSESS_TARGET",
  "BUILD_BASELINE",
  "PLAN",
  "IMPLEMENT_SLICES",
  "VERIFY_SLICES",
  "FINALIZE",
];

/** The lifecycle every record born before format 10 was validated against. */
export const LEGACY_MIGRATION_STEPS = MIGRATION_STEPS.filter(
  (step) => step !== "DISCOVERY_COMPLETENESS",
);

/**
 * The single backward-compatibility seam. `completedSteps` is asserted to be an
 * in-order prefix of the lifecycle, so a persisted record must be validated
 * against the list it was born under, not the list this build ships.
 */
export const stepsFor = (state) =>
  usesDiscoveryCompleteness(state) ? MIGRATION_STEPS : LEGACY_MIGRATION_STEPS;

export const FINAL_GATES = [
  "ARCHITECTURE_PLAN_GATE",
  "TARGETED_VERIFY",
  "FUNCTIONAL_PARITY_GATE",
  "SIMPLIFY_ONCE",
  "ARCHITECTURE_IMPLEMENTATION_GATE",
  "PRECOMMIT_GATE",
  "FINAL_VERIFY",
];

const TARGET_STATES = new Set([
  "ABSENT",
  "PLACEHOLDER",
  "PARTIAL",
  "INCOMPATIBLE",
  "IMPLEMENTED_UNVERIFIED",
]);

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

/** Whether any slice has been verified yet, so a row could have earned it. */
const anySliceVerified = (state) =>
  (state?.completedSlices?.length ?? 0) > 0 ||
  ["VERIFY_SLICES", "FINALIZE", "COMPLETE"].includes(state?.currentStep);

const TARGET_ADOPTION_MODES = new Set(["GREENFIELD", "BROWNFIELD"]);

const TERMINAL_DESIGN_SYSTEM = new Set(["COMPLIANT", "EXCEPTION_APPROVED"]);

const UI_KINDS = new Set([
  "INFORMATION_HIERARCHY",
  "TABLE_LIST",
  "SEARCH",
  "PAGINATION",
  "CONDITIONAL_CONTROL",
  "PERMISSION_VISIBILITY",
  "ROW_ACTION",
  "CREATE_EDIT_ACTION",
  "LOADING",
  "EMPTY",
  "ERROR",
  "RESPONSIVE",
  "PRESENTATION",
]);
const UI_MISMATCH_DISPOSITIONS = new Set([
  "REQUIRED_BEHAVIOR",
  "LEGACY_DEFECT",
  "INTENTIONAL_FIX",
  "INTENTIONAL_DESIGN_ADAPTATION",
  "NOT_APPLICABLE",
]);
/** A disposition that drops its UI behavior out of the required-evidence set. */
const UI_UNREQUIRED_DISPOSITIONS = new Set(["LEGACY_DEFECT", "NOT_APPLICABLE"]);
/**
 * Kinds whose whole point is an interaction. A row of one of these kinds has to
 * name the interactions Playwright must exercise; a passive kind (a hierarchy,
 * a loading state) legitimately has none.
 */
const UI_INTERACTIVE_KINDS = new Set([
  "SEARCH",
  "PAGINATION",
  "ROW_ACTION",
  "CREATE_EDIT_ACTION",
  "CONDITIONAL_CONTROL",
]);
/** Kinds that are conditional by definition, so `conditional` is not optional. */
const UI_CONDITIONAL_KINDS = new Set([
  "CONDITIONAL_CONTROL",
  "PERMISSION_VISIBILITY",
]);
/** States that legitimately justify capturing a second viewport. */
const UI_VIEWPORT_STATES = new Set(["DESKTOP", "MOBILE"]);
/**
 * Playwright safety: runtime evidence describes what was observed, never what
 * was used to observe it. Anything that reads like a credential is refused
 * before it can be persisted into a migration artifact.
 */
const UI_SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|cookie|authorization|credential|api[_-]?key)/i;
/**
 * Values are matched on credential *shape*, not on vocabulary: prose is allowed
 * to say "the session token expired", but never to carry the token itself.
 */
const UI_SECRET_VALUE_PATTERN =
  /((^|\s)(bearer|basic)\s+\S|(password|passwd|secret|token|credential|api[_-]?key|authorization)\s*[:=]\s*\S)/i;

/** Refuses to persist credential material inside runtime UI evidence. */
const assertNoUiSecret = (value, label) => {
  const walk = (node, trail) => {
    if (typeof node === "string") {
      if (UI_SECRET_VALUE_PATTERN.test(node)) {
        throw new Error(
          `${label}${trail} must not persist credential material in UI evidence.`,
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, item] of Object.entries(node)) {
      if (UI_SECRET_KEY_PATTERN.test(key)) {
        throw new Error(
          `${label}${trail}.${key} must not persist credential material in UI evidence.`,
        );
      }
      walk(item, `${trail}.${key}`);
    }
  };
  walk(value, "");
  return value;
};

/**
 * Whether a discovered UI behavior needs runtime verification. A legacy defect
 * or a not-applicable difference is never reproduced for visual similarity, and
 * a conditional control is not required merely because it was observed once --
 * it becomes required only when its disposition says the behavior is required.
 * One predicate so PLAN traceability and VERIFY_SLICES evidence agree.
 */
const uiBehaviorIsRequired = (uiBehavior, mismatch) => {
  const disposition = mismatch?.disposition;
  if (UI_UNREQUIRED_DISPOSITIONS.has(disposition)) return false;
  return uiBehavior.conditional !== true || disposition === "REQUIRED_BEHAVIOR";
};
export const UI_PROOF_FORMAT = "playwright-ui-proof/v1";

export const UI_RUNTIME_STATES = new Set([
  "DEFAULT",
  "POPULATED",
  "SEARCH",
  "PAGINATION",
  "EMPTY",
  "ERROR",
  "DESKTOP",
  "MOBILE",
  "MENU",
  "DIALOG",
  "ACTION",
]);

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

/** Rows a slice must own at PLAN. The other two classifications are terminal. */
const NON_TERMINAL_CAPABILITIES = new Set([
  "SHARED_PREREQUISITE",
  "FEATURE_LOCAL",
]);

/** The minimum number of *other* consumers that proves a capability is shared. */
const SHARED_CONSUMER_THRESHOLD = 2;

// `02a` and not `03`: renumbering 03-08 would invalidate every pinned path in
// every existing record. Ugly filename, zero migration cost.
export const DISCOVERY_SCAN_FILE = "inventories/discovery-scan.json";
export const MODULE_CLASSIFICATION_FILE =
  "inventories/module-classification.json";
export const DECISIONS_FILE = "decisions/operator-decisions.ndjson";
/**
 * The AUTO principal's own ledger, and the reason there are two files.
 *
 * `decisions/operator-decisions.ndjson` is the *human* record: every line in it
 * is an act a person performed, at a terminal or through a host they answered.
 * That is the whole value of the file -- "a human approved this" is only worth
 * something if nothing else can write it -- so `--mode auto` does not get to
 * append there, not even with an honest label. It writes here instead.
 *
 * Same line shape, same digest function, same append-only hash chain, its own
 * `integrity.json` anchor, and a distinct `AUTO-` id prefix so a citation can
 * never be mistaken for a human one at a glance or by a reader. Two ledgers,
 * two principals, no forgery surface: `readOperatorDecisions` refuses a line
 * that claims `AUTO`, and `readAutoDecisions` refuses one that does not.
 */
export const AUTO_DECISIONS_FILE = "decisions/auto-decisions.ndjson";
export const CAPABILITY_OWNERSHIP_FILE = "matrices/capability-ownership.json";
export const UI_REMEDIATION_FILE = "ui-remediation.json";
// Agent-authored (never engine-generated): the normalized, Figma-MCP-derived
// design context. Pinned into `artifactHashes` at ASSESS_TARGET, but only when
// `designSource === "figma-mcp"`. Its digest is the single canonical Figma
// snapshot digest bound into visual (TARGET) UI evidence.
export const FIGMA_CONTEXT_FILE = "inventories/figma-context.json";
// Format 17, figma-mcp only: the visual contract derived from the pinned Figma
// evidence. Authored and pinned at BUILD_BASELINE; read at every verification.
export const VISUAL_ACCEPTANCE_FILE = "matrices/visual-acceptance.json";
// `--adopt-visual-contract` only. The pinned context cannot be rewritten in
// place, so fresh format-17 evidence is authored beside it and swapped in by
// the transition, which preserves the old bytes under ADOPTION_ROOT.
export const FIGMA_CONTEXT_ADOPTION_FILE =
  "inventories/figma-context.adopted.json";
// Format 17, legacy-runtime only: the pinned visual authority. Authored and
// pinned at ASSESS_TARGET exactly where the Figma context is, immutable for the
// migration's life, and the origin of every visual fact the contract derives.
export const LEGACY_RUNTIME_CONTEXT_FILE =
  "inventories/legacy-runtime-context.json";
// Where the authority's own captures live. P4: nothing under here may be cited
// as TARGET verification evidence, and nothing under `evidence/` may be cited
// as an authority source. Different root, different checkpoint, different pin.
export const LEGACY_RUNTIME_EVIDENCE_ROOT = "inventories/legacy-runtime/";
const TARGET_EVIDENCE_ROOT = "evidence/";
/**
 * P5. The lifecycle slot a capture was produced for, declared in the record
 * itself rather than only in the engine's head. The authority is captured at
 * ASSESS_TARGET, before the target exists; target verification is captured at
 * VERIFY_SLICES, after it does. A block whose role disagrees with the slot it
 * is cited from is refused -- and note that no rule anywhere compares the two
 * roles' image hashes for *inequality*: byte-identical captures are the correct
 * 1:1 outcome of a migration and must pass.
 */
export const LEGACY_AUTHORITY_ROLE = "LEGACY_AUTHORITY";
export const TARGET_VERIFICATION_ROLE = "TARGET_VERIFICATION";

/**
 * The `version: 2` discriminator, asked of one visual artifact at a time.
 *
 * The artifact declares its own version, because the rules it is held to must
 * not change underneath it: pinning happens after validation, so a state-based
 * answer would say "hardened" at the step that authors the file and "not
 * hardened" at every later re-read of the same bytes.
 *
 * `version: 1` is therefore legal only where it is already history -- a record
 * that pinned this artifact before v2 existed keeps passing exactly as it did.
 * Nothing newly authored may choose it: v1 is compatibility, never a
 * certification path.
 */
const hardenedVisual = (state, relative, document, label) => {
  const version = document?.version;
  if (version === HARDENED_VISUAL_VERSION) return true;
  if (version === 1 && state?.artifactHashes?.[relative]) return false;
  throw new Error(
    `VISUAL_CONTRACT_VERSION: ${label} declares version ${JSON.stringify(version)}. Author it at version ${HARDENED_VISUAL_VERSION}: the hardened visual contract covers the full visual taxonomy, resolves every fact from the pinned authority, and compares at a fixed ±${FIXED_VISUAL_TOLERANCE.px}px. Version 1 remains readable only for records that had already pinned it before version ${HARDENED_VISUAL_VERSION} existed.`,
  );
};

/**
 * The one adapter table that makes the format-17 acceptance pipeline pluggable.
 * Exactly the fields that differ between the two supported origins -- there is
 * no normalized-frame layer beyond them, and no entry for a hypothetical third
 * authority. `validateVisualAcceptance`, `compareVisualFact`,
 * `assertVisualAcceptance`, the pin/replay filters and both front ends stay
 * exactly one implementation each.
 *
 * `validateContext` is wrapped in an arrow because the validators are declared
 * far below this table; the table is only ever read at call time.
 */
export const VISUAL_AUTHORITIES = Object.freeze({
  "figma-mcp": Object.freeze({
    contextFile: FIGMA_CONTEXT_FILE,
    validateContext: (root, state, contextFile) =>
      validateFigmaContext(root, state, contextFile),
    rowFrameKey: "figmaNodeId",
    rowStateKey: "figmaState",
    recordFrameKey: "figmaNodeId",
    normalizeFrameKey: (value) => figmaNodeKey(value),
    boundToDigestField: "figmaContextDigest",
  }),
  "legacy-runtime": Object.freeze({
    contextFile: LEGACY_RUNTIME_CONTEXT_FILE,
    validateContext: (root, state, contextFile, legacy) =>
      validateLegacyRuntimeContext(root, state, contextFile, legacy),
    rowFrameKey: "legacyFrameId",
    // The runtime state a legacy frame shows is the row's own state; there is
    // no second design-side state vocabulary to map through.
    rowStateKey: "state",
    recordFrameKey: "legacyFrameId",
    normalizeFrameKey: (value) => String(value ?? "").trim(),
    boundToDigestField: "visualContextDigest",
  }),
});

/** The authority-neutral frame identity a row or an evidence record binds. */
const frameKeyOf = (authority, source, field) =>
  authority.normalizeFrameKey(source?.[authority[field]]);

/** A record-relative, forward-slash path, for the two P4 root comparisons. */
const recordRelative = (root, absolute) =>
  path.relative(root, absolute).split(path.sep).join("/");

/**
 * P4, target side. A TARGET screenshot, measurement or proof reference may not
 * resolve inside the authority's own capture tree: the authority was pinned at
 * ASSESS_TARGET and citing it here would let the thing being measured *be* the
 * thing it is measured against. Only an independent capture at the slice's own
 * path can be cited. Nothing here compares hashes -- byte-identical authority
 * and target images at disjoint paths are the correct 1:1 outcome and pass.
 */
/**
 * P5. A declared capture role must be the role of the lifecycle slot it is
 * cited from. The block stays optional so no existing record gains an
 * obligation; declaring the *wrong* role is what is refused.
 */
const assertCaptureRole = (capture, expected, label) => {
  const role = capture?.role;
  if (role !== undefined && role !== expected) {
    throw new Error(
      `VISUAL_CAPTURE_ROLE: ${label}.capture.role is '${role}', but this evidence is cited as ${expected}. A capture declares the lifecycle slot it was produced for, and the two slots are never interchangeable.`,
    );
  }
};

const assertTargetEvidencePath = (reference, label) => {
  const spelled = String(reference ?? "").split(path.sep).join("/");
  if (
    spelled === LEGACY_RUNTIME_EVIDENCE_ROOT.slice(0, -1) ||
    spelled.includes(LEGACY_RUNTIME_EVIDENCE_ROOT)
  ) {
    throw new Error(
      `VISUAL_AUTHORITY_SUBSTITUTION: ${label} '${reference}' resolves inside ${LEGACY_RUNTIME_EVIDENCE_ROOT}, the pinned visual authority's own capture tree. Target verification evidence is captured at VERIFY_SLICES under evidence/<slice>/ and never cites the authority it is compared against.`,
    );
  }
};

/** The pinned visual authority of a record, or null for `target-system`. */
export const visualAuthorityOf = (state) =>
  (usesDesignSource(state) && VISUAL_AUTHORITIES[state?.designSource]) || null;

const AUTHORITY_CONTEXT_FILES = new Set(
  Object.values(VISUAL_AUTHORITIES).map((authority) => authority.contextFile),
);

/**
 * The one rule both the pin filter and the history-replay filter read: an
 * authority context is pinned at ASSESS_TARGET only by the record whose design
 * source owns it. A target-system record authored neither, and a figma-mcp
 * record must never be held to the legacy one (or the reverse), or the next
 * resume fails the "pins exactly" assertion.
 */
const pinsAuthorityContext = (state, relative) =>
  !AUTHORITY_CONTEXT_FILES.has(relative) ||
  visualAuthorityOf(state)?.contextFile === relative;
export const ADOPTION_ROOT = "visual-contract-adoption";
/**
 * `--reopen-complete` only. Where a COMPLETE record's superseded verification
 * evidence is preserved, byte-for-byte, before its pin is released:
 * `reopen/<n>/evidence/<slice>/result.json` plus `reopen/<n>/record.json`,
 * which names the operator, the reason and the authoritative post-finalization
 * evidence that proved the finalized contract wrong. Both stay pinned for life,
 * exactly like a preserved rework attempt.
 */
export const REOPEN_ROOT = "reopen";
/**
 * Format 15, brownfield only: what the target repository already contained when
 * the record was created, committed *and* uncommitted. A revision alone cannot
 * answer it -- pre-existing work is very often an uncommitted edit, and
 * `validateImplementedSlice` would happily accept one as slice work. Written
 * once at RESOLVE and pinned into `artifactHashes`, so it can never be
 * rewritten later to launder work into or out of the baseline.
 */
export const TARGET_BASELINE_FILE = "inventories/target-baseline.json";

const STEP_FILES = {
  RESOLVE: "steps/01-resolve.md",
  DISCOVER_LEGACY: "steps/02-discover-legacy.md",
  DISCOVERY_COMPLETENESS: "steps/02a-discovery-completeness.md",
  ASSESS_TARGET: "steps/03-assess-target.md",
  BUILD_BASELINE: "steps/04-build-baseline.md",
  PLAN: "steps/05-plan.md",
  IMPLEMENT_SLICES: "steps/06-implement-slices.md",
  VERIFY_SLICES: "steps/07-verify-slices.md",
  FINALIZE: "steps/08-finalize.md",
};

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

// Fix D (candidate change; analysis/inventory.md Defect "state.json's
// state-only contract is aspirational, not schema-enforced"): the exact set
// of top-level keys `references/migration-contract.md`'s "State-only
// contract" documents. `validateStateShape` rejects anything outside this
// set instead of only checking the shape of fields it recognizes.
const KNOWN_STATE_KEYS = new Set([
  "contractVersion",
  "formatVersion",
  "workflowVersion",
  "migrationId",
  "legacyModule",
  "targetModule",
  "registry",
  "legacyRevision",
  "requirementsAuthority",
  "brief",
  "ponytail",
  "dataSourceMode",
  "designSource",
  "figmaSources",
  "legacySources",
  "targetAdoption",
  // Format 16. Present only once a slice has actually been reworked, so a
  // record with zero reworks is byte-identical to a pre-16 one.
  "sliceReworks",
  // Present only on a pre-17 figma-mcp record that adopted the visual contract.
  "visualContractAdoption",
  "status",
  "currentStep",
  "activeSlice",
  "completedSteps",
  "pendingSteps",
  "completedSlices",
  "pendingSlices",
  "invalidatedArtifacts",
  "evidenceFreshness",
  "nextAction",
  "nextCommand",
  "artifacts",
  "artifactHashes",
  // Which built toolkit is permitted to mutate this record. Implementation
  // metadata, not a format capability: it is absent on every record created
  // before the standalone toolkit existed, and its presence changes no
  // lifecycle, decision, evidence or format meaning. Absent on an unstamped
  // record, so such a record stays byte-identical to what it always was.
  "toolkitIdentity",
  "revision",
  "createdAt",
  "updatedAt",
]);

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const assertPlainObject = (value, label) => {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  return value;
};

const assertArray = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};

const assertNonEmpty = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

const assertBoolean = (value, label) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
};

const assertUniqueIds = (rows, label) => {
  const ids = new Set();
  for (const [index, row] of rows.entries()) {
    assertPlainObject(row, `${label}[${index}]`);
    const id = assertNonEmpty(row.id, `${label}[${index}].id`);
    if (ids.has(id)) throw new Error(`${label} repeats id '${id}'.`);
    ids.add(id);
  }
  return ids;
};

const isWithin = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const fileExists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const readJson = async (filePath, label) => {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${filePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
};

const hashFile = async (filePath) =>
  createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

/**
 * The two ordinary-file-pin primitives. Everything that pins *a file* goes
 * through these; `hashFile` stays exactly where a raw-byte preimage is the
 * point (confirmation snapshots, transaction stateHash, approval candidates,
 * decision subjects, preserved bytes).
 */
const fileIdentity = async (filePath, options) =>
  contentIdentity(filePath, await readFile(filePath), options);

const fileIdentityMatches = async (recorded, filePath, options) =>
  contentIdentityMatches(recorded, filePath, await readFile(filePath), options);

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

/**
 * The only decision kinds a record may gain after DISCOVERY_COMPLETENESS
 * closed. A classification approval added late would be an approval for facts
 * the census already fixed; a drift acceptance is a judgement about bytes that
 * did not exist yet when the census ran.
 */
export const LATE_DECISION_KINDS = new Set(["TARGET_DRIFT_ACCEPTED", "VISUAL_UNBACKED"]);

const assertLateDecisionsAreAppendable = (tail) => {
  const text = tail.toString("utf8");
  const rewritten = () =>
    new Error(
      `${DECISIONS_FILE} bytes changed after DISCOVERY_COMPLETENESS closed. Everything appended past the pinned prefix must be whole ${[...LATE_DECISION_KINDS].join("/")} decision lines; a semantically equivalent rewrite -- reformatting, or a bare newline -- is still a rewrite of the immutable operator record.`,
    );
  // The tail is NDJSON or it is a rewrite. Exactly one trailing newline, no
  // blank lines, nothing that is not a complete decision.
  if (!text.endsWith("\n")) throw rewritten();
  for (const line of text.slice(0, -1).split("\n")) {
    if (!line.trim()) throw rewritten();
    let decision;
    try {
      decision = JSON.parse(line);
    } catch {
      throw rewritten();
    }
    if (!LATE_DECISION_KINDS.has(decision.kind)) {
      throw new Error(
        `${DECISIONS_FILE} gained a '${decision.kind}' decision after DISCOVERY_COMPLETENESS closed. Only ${[...LATE_DECISION_KINDS].join(", ")} may be recorded once the census is fixed; every other approval binds to facts that checkpoint already pinned.`,
      );
    }
  }
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

// P1-1: the integrity anchor for `artifactHashes`, persisted outside
// `state.json` so pinning an artifact and rewriting its pin stop being the
// same edit. Written in the same journalled transaction as every advance
// (and at initialization); never read or written anywhere else.
const INTEGRITY_FILE = "integrity.json";

const digestArtifactHashes = (artifactHashes) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(artifactHashes).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        ),
      ),
    )
    .digest("hex");

/**
 * P2-3: `history.ndjson` declares itself the audit record but nothing pinned
 * its bytes -- truncating it reported no blockers, and because gate-evidence
 * freshness reads each event's `at`, dropping or back-dating events *loosened*
 * the freshness floor. This pins how long the record was and what it hashed to
 * at the moment of the state write, so it can only ever have grown since.
 *
 * The audit asked for a length plus a last-line digest; this hashes the whole
 * pinned prefix instead, which is the same one call and also catches an
 * interior line rewritten in place -- `at` is an ISO timestamp, so back-dating
 * one keeps both the byte length and the last line intact, and the history
 * replay ignores `at` entirely.
 *
 * The byte-prefix anchor still stops before the newest append. historyChain's
 * precommitted headHash covers that event through the journaled transaction.
 */
const historyAnchorOf = (bytes) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const historyAnchorNow = async (root) => {
  const file = path.join(root, initialArtifacts.history);
  return historyAnchorOf(
    (await fileExists(file)) ? await readFile(file) : Buffer.alloc(0),
  );
};

const renderIntegrity = (state, history, decisions, autoDecisions, historyChain) =>
  `${JSON.stringify(
    {
      revision: state.revision,
      artifactHashesSha256: digestArtifactHashes(state.artifactHashes),
      history,
      decisions,
      // Last, and omitted entirely on an unstamped record: JSON.stringify drops
      // an undefined value, so every integrity.json written before toolkit
      // identity existed stays byte-identical and no existing record is
      // retroactively invalidated by this field's introduction.
      toolkitIdentitySha256: digestToolkitIdentity(state.toolkitIdentity) ?? undefined,
      // Last for the same reason, and dropped on a record with no AUTO ledger:
      // a record that never ran under `--mode auto` writes the same bytes it
      // wrote before the AUTO principal existed.
      autoDecisions: autoDecisions ?? undefined,
      historyChain: historyChain ?? undefined,
    },
    null,
    2,
  )}\n`;

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

const readIntegrity = async (root) => {
  const file = path.join(root, INTEGRITY_FILE);
  if (!(await fileExists(file))) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { corrupt: true };
  }
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
    if ((state.formatVersion ?? 1) >= ANCHORED_FORMAT_VERSION) {
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
    if ((state.formatVersion ?? 1) >= ANCHORED_FORMAT_VERSION) {
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
 * W6-1, closing the documented gap in `historyAnchorOf`: the newest event is
 * appended *after* the state write, so exactly one event may legitimately sit
 * beyond the anchor, and it must be the one that moved the record to its
 * current revision. Two of them means a write path bypassed the transaction; a
 * mismatched revision means the tail was appended by something other than the
 * transaction that moved state. Both were undetected.
 *
 * A trailing fragment a killed process left half-written is not a completed
 * event: `sealTornTail` owns that repair, and asserting over it here would turn
 * a recoverable crash into a refusal.
 */
const assertUnanchoredHistoryTail = (state, tail) => {
  const text = tail.toString("utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const events = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return; // a torn line; sealTornTail repairs it before the next append
    }
  }
  if (events.length === 0) return;
  if (events.length > 1) {
    throw new Error(
      `Migration history/history.ndjson has ${events.length} events past the integrity.json anchor, but a transaction pins the anchor before appending exactly one. Events were appended outside the checkpoint transaction; the record is untrusted.`,
    );
  }
  const [tailEvent] = events;
  if (
    Object.hasOwn(tailEvent, "revision") &&
    tailEvent.revision !== state.revision
  ) {
    throw new Error(
      `Migration history/history.ndjson's unanchored trailing event records revision ${tailEvent.revision}, but state.json is at revision ${state.revision}. The tail was appended by something other than the transaction that moved state; restore the record before continuing.`,
    );
  }
};

// The engine's own workspace is excluded from the target dirty manifest: the
// migration tree's authored artifacts are already pinned by `artifactHashes`,
// and the lock/journal files this transaction itself creates live there, so
// including them would invalidate every confirmation the moment it is used.
export const TARGET_DIRTY_SCOPE = {
  exclude: [".agents/knowledge/migrations/"],
};

const portableRoot = (value) => path.resolve(value).split(path.sep).join("/");

/** One digested entry per dirty path, deduplicated (a rename reports both). */
const baselineDirtyEntries = (dirty) => {
  const byPath = new Map();
  for (const entry of dirty.entries) {
    if (byPath.has(entry.path)) continue;
    byPath.set(entry.path, {
      path: entry.path,
      digest: entry.sha256 === null ? null : `sha256:${entry.sha256}`,
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
};

/**
 * The immutable pre-migration picture of the target tree: committed history
 * plus every uncommitted path and its bytes.
 *
 * Per-path digests, not `dirtyManifest`'s aggregate: the aggregate answers "did
 * anything change", and the question `changedFiles` asks is "did *this* file
 * change". Both producers are the pair `legacySourceBinding` already trusts for
 * the legacy side, pointed at the target root.
 */
export const renderTargetBaseline = async (targetRoot) => {
  const [revision, dirty] = await Promise.all([
    gitRevision(targetRoot),
    dirtyManifest(targetRoot, TARGET_DIRTY_SCOPE),
  ]);
  return `${JSON.stringify(
    {
      version: 1,
      revision: revision.revision,
      dirty: baselineDirtyEntries(dirty),
    },
    null,
    2,
  )}\n`;
};

const validateTargetBaselineShape = (baseline) => {
  assertPlainObject(baseline, "Target baseline");
  if (!/^[0-9a-f]{40}$/.test(baseline.revision ?? "")) {
    throw new Error("Target baseline revision must be a full Git SHA-1.");
  }
  for (const [index, entry] of assertArray(
    baseline.dirty,
    "Target baseline dirty",
  ).entries()) {
    const at = `Target baseline dirty[${index}]`;
    assertPlainObject(entry, at);
    assertNonEmpty(entry.path, `${at}.path`);
    if (entry.digest !== null && !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) {
      throw new Error(`${at}.digest must be a SHA-256 digest or null.`);
    }
  }
  return baseline;
};

/**
 * `changed(targetRelativePath)` -- whether this migration, and not whoever was
 * working in the tree before it, is responsible for the file's current bytes.
 *
 * Three cases, and the third is why `revision` is in the baseline at all:
 * currently dirty with the recorded bytes means untouched; recorded dirty but
 * clean now means the pre-existing edit went away; and a file clean at both
 * ends can still have been rewritten by a commit in between.
 */
const targetBaselineDrift = async (targetRoot, baseline) => {
  const [current, dirty] = await Promise.all([
    gitRevision(targetRoot),
    dirtyManifest(targetRoot, TARGET_DIRTY_SCOPE),
  ]);
  const recorded = new Map(
    baseline.dirty.map((entry) => [entry.path, entry.digest]),
  );
  const now = new Map(
    baselineDirtyEntries(dirty).map((entry) => [entry.path, entry.digest]),
  );
  // Skipped entirely in the common case: the engine's working assumption is
  // that nothing is committed before FINALIZE, so the revision usually holds.
  const committed =
    current.revision === baseline.revision
      ? new Set()
      : await committedChangesSince(targetRoot, baseline.revision);
  return (relativePath) =>
    committed.has(relativePath) ||
    (now.has(relativePath)
      ? now.get(relativePath) !== recorded.get(relativePath)
      : recorded.has(relativePath));
};

/**
 * What RESOLVE pins, for whatever this record is: the step document always, and
 * the target baseline when the record adopted an existing implementation.
 */
const resolveStepPins = (state) =>
  IMMUTABLE_STEP_ARTIFACTS.RESOLVE.filter(
    (relative) => relative !== TARGET_BASELINE_FILE || isBrownfield(state),
  );

/** The pinned baseline of a brownfield record, or null for a greenfield one. */
const readTargetBaseline = async (root, state) =>
  isBrownfield(state)
    ? validateTargetBaselineShape(
        await readJson(path.join(root, TARGET_BASELINE_FILE), "Target baseline"),
      )
    : null;

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

const hashContent = (content) =>
  createHash("sha256").update(content).digest("hex");

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

const requirementsSourceFor = (targetModule) => {
  const configured =
    process.env.MIGRATION_REQUIREMENTS_FILE ??
    "openspec/specs/{target}/spec.md";
  const source = configured
    .replaceAll("{target}", targetModule)
    .replaceAll("\\", "/");
  const normalized = path.posix.normalize(source);
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      "MIGRATION_REQUIREMENTS_FILE must be a target-project-relative path.",
    );
  }
  return normalized;
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

const validateOpenSpecAuthorityShape = (authority, targetModule) => {
  assertPlainObject(authority, "requirementsAuthority");
  if (authority.kind !== "openspec") {
    throw new Error("requirementsAuthority.kind must be 'openspec'.");
  }
  const expectedSource = requirementsSourceFor(targetModule);
  if (authority.source !== expectedSource) {
    throw new Error(
      `requirementsAuthority.source must match the configured target-relative source '${expectedSource}'.`,
    );
  }
  if (!isContentIdentity(authority.digest)) {
    throw new Error(
      "requirementsAuthority.digest must be a SHA-256 content identity.",
    );
  }
  for (const [label, pattern] of [
    ["requirementIds", /^[A-Z][A-Z0-9]*-REQ-\d{3,}$/],
    ["scenarioIds", /^[A-Z][A-Z0-9]*-SCN-\d{3,}$/],
  ]) {
    const values = assertArray(
      authority[label],
      `requirementsAuthority.${label}`,
    );
    if (values.length === 0) {
      throw new Error(`requirementsAuthority.${label} cannot be empty.`);
    }
    if (
      values.some(
        (value) => typeof value !== "string" || !pattern.test(value),
      ) ||
      new Set(values).size !== values.length
    ) {
      throw new Error(
        `requirementsAuthority.${label} must contain unique stable IDs.`,
      );
    }
  }
  return authority;
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

/** `fileIdentityMatches` against a target-relative source, or false if absent. */
const contentIdentityMatchesSource = async (recorded, targetRoot, source) => {
  const filePath = path.resolve(targetRoot, source);
  if (!isWithin(targetRoot, filePath)) return false;
  return fileIdentityMatches(recorded, filePath).catch(() => false);
};

const now = () => new Date().toISOString();

export const migrationRoot = (targetRoot, moduleName) =>
  path.join(targetRoot, ".agents/knowledge/migrations/modules", moduleName);

const statePathFor = (targetRoot, moduleName) =>
  path.join(migrationRoot(targetRoot, moduleName), "state.json");

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

const renderState = (state) => `${JSON.stringify(state, null, 2)}\n`;

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

const initialArtifacts = {
  steps: STEP_FILES,
  legacyInventory: "inventories/legacy.json",
  moduleClassification: MODULE_CLASSIFICATION_FILE,
  discoveryScan: DISCOVERY_SCAN_FILE,
  operatorDecisions: DECISIONS_FILE,
  targetInventory: "inventories/target.json",
  behaviorParity: "matrices/behavior-parity.json",
  routeAdaptation: "matrices/route-adaptation.json",
  targetNative: "matrices/target-native.json",
  designSystemUsage: "matrices/design-system-usage.json",
  capabilityOwnership: CAPABILITY_OWNERSHIP_FILE,
  slices: "slices/index.json",
  gates: "gates.json",
  history: "history/history.ndjson",
};

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
    version: 1,
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

const assertLegacyRevisionShape = (legacyRevision) => {
  assertPlainObject(legacyRevision, "legacyRevision");
  if (!/^[0-9a-f]{40}$/.test(legacyRevision.revision ?? "")) {
    throw new Error("legacyRevision.revision must be a full Git SHA-1.");
  }
  assertBoolean(legacyRevision.pathScoped, "legacyRevision.pathScoped");
  return legacyRevision;
};

/**
 * `targetAdoption` copies the `brief` precedent verbatim: the mode plus a
 * `{path, digest}` pair pointing at the artifact that holds the list, because
 * `state.json` is navigation and integrity fields only. A greenfield record
 * carries no baseline; a brownfield one must.
 */
const validateTargetAdoptionShape = (targetAdoption) => {
  assertPlainObject(targetAdoption, "targetAdoption");
  if (!TARGET_ADOPTION_MODES.has(targetAdoption.mode)) {
    throw new Error(
      `Migration state targetAdoption.mode must be ${[...TARGET_ADOPTION_MODES].join(" or ")}.`,
    );
  }
  if (targetAdoption.mode === "GREENFIELD") {
    if (targetAdoption.baseline !== null) {
      throw new Error(
        "Migration state targetAdoption.baseline must be null for a GREENFIELD target.",
      );
    }
    return targetAdoption;
  }
  const baseline = assertPlainObject(
    targetAdoption.baseline,
    "targetAdoption.baseline",
  );
  if (baseline.path !== TARGET_BASELINE_FILE) {
    throw new Error(
      `Migration state targetAdoption.baseline.path must be '${TARGET_BASELINE_FILE}'.`,
    );
  }
  if (!isContentIdentity(baseline.digest)) {
    throw new Error(
      "Migration state targetAdoption.baseline.digest must be a SHA-256 content identity.",
    );
  }
  return targetAdoption;
};

/**
 * Whether the operator explicitly named a design source on this invocation.
 * A plain resume names neither `--design-source` nor `--figma`, so it must not
 * be read as an attempt to switch back to the default -- exactly as omitting
 * `--mock` resumes a mock migration untouched.
 */
const designSourceExplicit = ({ designSource, figma } = {}) =>
  designSource !== undefined ||
  (Array.isArray(figma) ? figma.length > 0 : figma !== undefined);

const figmaSourceKey = (sources) =>
  (sources ?? [])
    .map((source) => `${source.kind}#${source.fileKey}#${source.nodeId ?? ""}`)
    .sort()
    .join(",");

/**
 * The design source is bootstrap-fixed. A resume that explicitly names a
 * different one is refused, mirroring the `--mock` and `--ponytail` conflicts.
 */
const assertDesignSourceUnchanged = (state, design) => {
  const recorded = state.designSource ?? "target-system";
  if (design.designSource !== recorded) {
    throw new Error(
      `Design source '${design.designSource}' conflicts with the recorded design source '${recorded}'. The design source is fixed for the migration's lifetime; start a new migration to change it.`,
    );
  }
  if (
    figmaSourceKey(design.figmaSources) !== figmaSourceKey(state.figmaSources)
  ) {
    throw new Error(
      "Figma sources conflict with the recorded Figma sources. The design source and its links are fixed for the migration's lifetime.",
    );
  }
};

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

/**
 * The sources are bootstrap-fixed, exactly like the design source. Without this
 * a resume that names a different `--legacy` set would be silently ignored and
 * the operator would believe a source had been added.
 */
const assertLegacySourcesUnchanged = (state, legacySources) => {
  if (legacySources.length === 0) return;
  const recorded = legacySourcesOf(state);
  if (JSON.stringify(legacySources) !== JSON.stringify(recorded)) {
    throw new Error(
      `Legacy sources ${JSON.stringify(legacySources)} conflict with the recorded sources ${JSON.stringify(recorded)}. The source set is fixed for the migration's lifetime; start a new migration to change it.`,
    );
  }
};

const validateStateShape = (state, moduleName) => {
  assertPlainObject(state, "Migration state");
  const incompatible = compatibilityBlocker(
    state,
    moduleName ?? state.legacyModule ?? "this module",
  );
  if (incompatible) throw new Error(incompatible);
  // Fix D (candidate change): reject any top-level key outside the documented
  // state-only contract instead of only checking known fields' shapes.
  for (const key of Object.keys(state)) {
    if (!KNOWN_STATE_KEYS.has(key)) {
      throw new Error(
        `Migration state contains an unsupported top-level key '${key}'. state.json must contain only the documented navigation and integrity fields.`,
      );
    }
  }
  if (state.workflowVersion !== WORKFLOW_VERSION) {
    throw new Error(
      `Migration state workflowVersion must be ${WORKFLOW_VERSION}.`,
    );
  }
  assertSafeName(state.migrationId, "migration id");
  assertSafeName(state.legacyModule, "legacy module");
  assertSafeName(state.targetModule, "target module");
  if (
    state.registry !== undefined &&
    (typeof state.registry !== "string" ||
      !state.registry.trim() ||
      path.isAbsolute(state.registry) ||
      state.registry.includes("\\") ||
      state.registry.split(/[\\/]/).includes(".."))
  ) {
    throw new Error(
      "Migration state registry must be a target-relative, separator-independent path.",
    );
  }
  assertLegacyRevisionShape(state.legacyRevision);
  validateOpenSpecAuthorityShape(
    state.requirementsAuthority,
    state.targetModule,
  );
  if (!["standard", "mock"].includes(state.dataSourceMode)) {
    throw new Error("Migration state dataSourceMode must be standard or mock.");
  }
  // Format-gated: a pre-14 record carries no designSource and behaves as
  // target-system by omission. The value, when present, must be a known enum;
  // figmaSources is validated only where it is actually consumed -- a format-14
  // figma-mcp record. An older record that happens to carry the field is inert,
  // because every figma-mcp code path also gates on usesDesignSource(state).
  if (
    state.designSource !== undefined &&
    !DESIGN_SOURCES.includes(state.designSource)
  ) {
    throw new Error(
      `Migration state designSource must be ${DESIGN_SOURCES.join(" or ")}.`,
    );
  }
  if (usesDesignSource(state) && state.designSource === "figma-mcp") {
    const sources = assertArray(state.figmaSources, "figmaSources");
    if (sources.length === 0) {
      throw new Error(
        "Migration state figmaSources must not be empty for a figma-mcp design source.",
      );
    }
    for (const [index, source] of sources.entries()) {
      assertPlainObject(source, `figmaSources[${index}]`);
      assertNonEmpty(source.fileKey, `figmaSources[${index}].fileKey`);
      assertNonEmpty(source.kind, `figmaSources[${index}].kind`);
      assertNonEmpty(source.raw, `figmaSources[${index}].raw`);
      if (
        source.nodeId !== null &&
        (typeof source.nodeId !== "string" || source.nodeId.length === 0)
      ) {
        throw new Error(
          `figmaSources[${index}].nodeId must be a non-empty string or null.`,
        );
      }
    }
  }
  if (state.ponytail !== undefined && state.ponytail !== null) {
    assertPonytailTarget(state.ponytail);
  }
  // Present or absent, never partial: a half-written identity would be a
  // runtime that cannot be compared, which is the one thing this field exists
  // to make impossible.
  if (state.toolkitIdentity !== undefined) {
    validateToolkitIdentity(state.toolkitIdentity, "Migration state toolkitIdentity");
  }
  // Format 15: N sources converge on one target, so the target is the only
  // thing that stays singular and is therefore what the record directory, the
  // lock, the OpenSpec path, and `nextCommand` key on. Format <= 14 keeps the
  // old invariant verbatim.
  if (usesMultiSource(state)) {
    if (state.migrationId !== state.targetModule) {
      throw new Error(
        "Migration id must equal the target module at format 15 and above.",
      );
    }
    const sources = assertArray(state.legacySources, "legacySources");
    if (sources.length === 0) {
      throw new Error("Migration state legacySources must not be empty.");
    }
    sources.forEach((name, index) =>
      assertSafeName(name, `legacySources[${index}]`),
    );
    // Derived, never operator-controlled: two operators typing the same
    // sources in different orders must produce byte-identical state, because
    // state feeds the confirmation-ID snapshot.
    const canonicalOrder = [...new Set(sources)].sort();
    if (JSON.stringify(sources) !== JSON.stringify(canonicalOrder)) {
      throw new Error(
        `Migration state legacySources must be sorted and unique; expected ${JSON.stringify(canonicalOrder)}.`,
      );
    }
    // A shape-compatibility field only. Every format-15 rule reads
    // `legacySources`; `legacySources[0]` is alphabetically first and carries
    // no primacy, so anything treating it as "the" legacy module would migrate
    // whichever source happens to sort first.
    if (state.legacyModule !== sources[0]) {
      throw new Error(
        "Migration state legacyModule must equal legacySources[0] at format 15 and above.",
      );
    }
    validateTargetAdoptionShape(state.targetAdoption);
  } else {
    if (state.migrationId !== state.legacyModule) {
      throw new Error("Migration id must equal the canonical legacy module.");
    }
    for (const key of ["legacySources", "targetAdoption"]) {
      if (state[key] !== undefined) {
        throw new Error(
          `Migration state ${key} requires format ${MULTI_SOURCE_FORMAT}; this record is format ${state.formatVersion ?? 1}.`,
        );
      }
    }
  }
  // Contract 5 decisions 1.6 and 1.10: BLOCKED is preflight-only, and
  // registration is derived from the registry instead of cached in state.
  // (Both are also covered by the unsupported-top-level-key check above; the
  // explicit messages below are kept because they are more actionable.)
  if (Object.hasOwn(state, "blockers")) {
    throw new Error(
      "Contract 5 does not persist blockers. They are reported by the preflight.",
    );
  }
  if (Object.hasOwn(state, "mappingRegistered")) {
    throw new Error(
      "Contract 5 derives registration from the registry and does not persist mappingRegistered.",
    );
  }
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) {
    throw new Error(
      `Invalid migration status '${state.status}'. Contract 5 persists only ACTIVE or COMPLETE.`,
    );
  }
  // Version-scoped: a record born before format 10 has no
  // DISCOVERY_COMPLETENESS step and must never be held to one.
  const lifecycle = stepsFor(state);
  if (
    state.currentStep !== "COMPLETE" &&
    !lifecycle.includes(state.currentStep)
  ) {
    throw new Error(`Invalid current step '${state.currentStep}'.`);
  }
  if (state.brief !== undefined && state.brief !== null) {
    assertPlainObject(state.brief, "brief");
    assertNonEmpty(state.brief.path, "brief.path");
    if (!isContentIdentity(state.brief.digest)) {
      throw new Error(
        "Migration state brief.digest must be a SHA-256 content identity.",
      );
    }
  }
  assertArray(state.completedSteps, "completedSteps");
  // P1-1: completedSteps must be exactly the MIGRATION_STEPS prefix before
  // currentStep -- no gap, duplicate, or reordering -- checked from the state
  // shape alone, without needing history. IMPLEMENT_SLICES and VERIFY_SLICES
  // loop per slice and are recorded together only once every slice is
  // verified, so completedSteps legitimately lags one index behind
  // currentStep while VERIFY_SLICES is in progress.
  {
    const expectedPrefix = lifecycle.slice(0, state.completedSteps.length);
    if (
      JSON.stringify(state.completedSteps) !== JSON.stringify(expectedPrefix)
    ) {
      throw new Error(
        "Migration state completedSteps must be an in-order MIGRATION_STEPS prefix, with no gap, duplicate, or reordering.",
      );
    }
    const currentIndex =
      state.currentStep === "COMPLETE"
        ? lifecycle.length
        : lifecycle.indexOf(state.currentStep);
    const maxCompleted =
      currentIndex - (state.currentStep === "VERIFY_SLICES" ? 1 : 0);
    if (state.completedSteps.length !== maxCompleted) {
      throw new Error(
        `Migration state completedSteps (${state.completedSteps.length} step(s)) is inconsistent with currentStep '${state.currentStep}'; completedSteps must be exactly the MIGRATION_STEPS prefix before currentStep.`,
      );
    }
  }
  assertArray(state.pendingSteps, "pendingSteps");
  assertArray(state.completedSlices, "completedSlices");
  assertArray(state.pendingSlices, "pendingSlices");
  assertArray(state.invalidatedArtifacts, "invalidatedArtifacts");
  assertPlainObject(state.artifacts, "artifacts");
  assertPlainObject(state.artifacts.steps, "artifacts.steps");
  assertPlainObject(state.artifactHashes, "artifactHashes");
  if (state.sliceReworks !== undefined) {
    assertPlainObject(state.sliceReworks, "sliceReworks");
    for (const [sliceId, attempts] of Object.entries(state.sliceReworks)) {
      if (
        !Number.isInteger(attempts) ||
        attempts < 1 ||
        attempts > MAX_SLICE_REWORKS
      ) {
        throw new Error(
          `Migration sliceReworks['${sliceId}'] must be an integer between 1 and ${MAX_SLICE_REWORKS}; received ${JSON.stringify(attempts)}.`,
        );
      }
    }
  }
  if ((state.status === "COMPLETE") !== (state.currentStep === "COMPLETE")) {
    throw new Error(
      "Migration status and current step disagree on completion.",
    );
  }
  return state;
};

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
          (state.formatVersion ?? 1) < ANCHORED_FORMAT_VERSION
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

// Fix C (candidate change; analysis/inventory.md Defect "history/
// history.ndjson is read-modify-atomic-rewrite, not append-only at the
// syscall level"): the original read the whole file, concatenated one line in
// memory, and rewrote it via temp-file+rename, which is not safe against a
// concurrent second writer (last rename wins; a racing append can be lost).
// This appends with a true OS-level append (`O_APPEND`, via the `a` flag),
// never reading or rewriting existing content, so two concurrent writers
// cannot silently clobber each other's line. The NDJSON file remains the one
// module-history record.
const HISTORY_HASH_DOMAIN = "artifact-migration-tools/module-history/v1\n";
const historyDigest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const keyOrder = (left, right) => {
  const a = Array.from(left), b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const diff = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (diff) return diff;
  }
  return a.length - b.length;
};
const canonicalHistoryJson = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalHistoryJson).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort(keyOrder)
    .map((key) => `${JSON.stringify(key)}:${canonicalHistoryJson(value[key])}`).join(",")}}`;
  throw new Error("Migration history event contains a non-JSON value; nothing was written.");
};
const hashHistoryEvent = (event) => {
  const { hash, ...payload } = event;
  return historyDigest(`${HISTORY_HASH_DOMAIN}${canonicalHistoryJson(payload)}`);
};

const prepareHistoryEvent = async (root, event) => {
  if (!isPlainObject(event) || Object.hasOwn(event, "hash")) {
    throw new Error("Migration history event is already chained or invalid; nothing was written.");
  }
  const integrity = await readIntegrity(root);
  const existing = await readHistoryEvents(root, integrity);
  const bytes = await readFile(path.join(root, initialArtifacts.history));
  const legacyPrefixSha256 = integrity?.historyChain
    ? integrity.historyChain.legacyPrefixSha256 : historyDigest(bytes);
  const previousHash = existing.at(-1)?.hash ?? legacyPrefixSha256;
  Object.assign(event, { at: event.at ?? now(), seq: existing.length + 1, previousHash });
  event.hash = hashHistoryEvent(event);
  return {
    version: 1,
    startSeq: integrity?.historyChain?.startSeq ?? event.seq,
    legacyPrefixSha256,
    headHash: event.hash,
  };
};

const appendHistory = async (targetRoot, root, event) => {
  const historyPath = path.join(root, initialArtifacts.history);
  const secureHistoryPath = await assertSecurePath(targetRoot, historyPath);
  await mkdir(path.dirname(secureHistoryPath), { recursive: true });
  await appendFile(
    secureHistoryPath,
    `${JSON.stringify(event.hash ? event : { at: now(), ...event })}\n`,
    { flag: "a", mode: 0o600 },
  );
};

/**
 * Proves the audit record is appendable before any state is written. Without
 * it, a broken `history/` (replaced by a file, read-only, or on a full disk)
 * was only discovered after `state.json` had already moved -- the checkpoint
 * advanced while the transition it represents was never recorded.
 */
const assertHistoryAppendable = async (targetRoot, root) => {
  const historyPath = path.join(root, initialArtifacts.history);
  const securePath = await assertSecurePath(targetRoot, historyPath);
  await mkdir(path.dirname(securePath), { recursive: true });
  const handle = await open(securePath, "a", 0o600);
  await handle.close();
};

/**
 * Seals a trailing line a killed process left half-written, so the next append
 * starts on an event boundary.
 *
 * A pending journal can tolerate an unparseable final fragment, but `O_APPEND`
 * does not: the
 * replacement event would be spliced onto the fragment, and the combined line
 * stays unparseable and is ignored forever -- while recovery deletes the only
 * journal that could have retried. Two shapes are possible, and they are not
 * the same repair: a truncated JSON prefix is not an event and is cut, whereas
 * a complete object whose terminator never landed is an event and only gets
 * its newline. Both are decided from the bytes after the last newline, so the
 * repair is deterministic and never touches an anchored prefix.
 *
 * Runs under the module lock, immediately before every append.
 *
 * @returns {Promise<null | "TERMINATED" | "TRUNCATED">} what the tail needed.
 */
const sealHistoryTail = async (targetRoot, root) => {
  const historyPath = await assertSecurePath(
    targetRoot,
    path.join(root, initialArtifacts.history),
  );
  if (!(await fileExists(historyPath))) return null;
  const content = await readFile(historyPath);
  // Byte offsets, not character offsets: a UTF-8 path in an event would make
  // the two disagree and truncate mid-character.
  const boundary = content.lastIndexOf(0x0a) + 1;
  const tail = content.subarray(boundary).toString("utf8");
  if (tail === "") return null;
  // A strict prefix of `{...}` only parses when it is the whole object, so
  // parsing proves the event's bytes all landed and only the newline is gone.
  let complete = false;
  try {
    complete = isPlainObject(JSON.parse(tail));
  } catch {
    complete = false;
  }
  const handle = await open(historyPath, "r+", 0o600);
  try {
    if (complete) await handle.write("\n", content.length);
    else await handle.truncate(boundary);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return complete ? "TERMINATED" : "TRUNCATED";
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

const readHistoryEvents = async (root, integrity, pendingJournal) => {
  const historyPath = path.join(root, initialArtifacts.history);
  if (!(await fileExists(historyPath))) return [];
  const content = await readFile(historyPath);
  const events = [];
  const ends = [];
  let start = 0;
  for (let end = content.indexOf(0x0a); end !== -1; end = content.indexOf(0x0a, start)) {
    const line = content.subarray(start, end).toString("utf8");
    if (!line.trim()) throw new Error(`Migration history line ${events.length + 1} is blank; restore it before continuing.`);
    try {
      const event = JSON.parse(line);
      if (!isPlainObject(event)) throw new Error("not an event object");
      events.push(event);
    } catch {
      throw new Error(`Migration history line ${events.length + 1} is malformed; restore it before continuing.`);
    }
    start = end + 1;
    ends.push(start);
  }
  if (start < content.length &&
      (!pendingJournal || pendingJournal.corrupt || !isPlainObject(pendingJournal.event))) {
    throw new Error(`Migration history line ${events.length + 1} is unterminated; recover the pending transaction or restore it.`);
  }
  const anchor = integrity === undefined ? (await readIntegrity(root))?.historyChain : integrity?.historyChain;
  if (anchor) {
    const digestShape = /^sha256:[0-9a-f]{64}$/;
    if (anchor.version !== 1 || !Number.isInteger(anchor.startSeq) || anchor.startSeq < 1 ||
        anchor.startSeq > events.length + 1 || !digestShape.test(anchor.headHash) ||
        (anchor.startSeq === 1 ? anchor.legacyPrefixSha256 !== null :
          !digestShape.test(anchor.legacyPrefixSha256))) {
      throw new Error("Migration integrity.json has an invalid historyChain boundary; restore it before continuing.");
    }
    const prefix = content.subarray(0, ends[anchor.startSeq - 2] ?? 0);
    if (anchor.startSeq > 1 && historyDigest(prefix) !== anchor.legacyPrefixSha256) {
      throw new Error("Migration history legacy prefix differs from integrity.json; restore it before continuing.");
    }
    let previousHash = anchor.startSeq === 1 ? null : anchor.legacyPrefixSha256;
    for (let i = anchor.startSeq - 1; i < events.length; i += 1) {
      const event = events[i];
      if (!isPlainObject(event) || event.seq !== i + 1 || event.previousHash !== previousHash ||
          !digestShape.test(event.hash) || hashHistoryEvent(event) !== event.hash) {
        throw new Error(`Migration history line ${i + 1} has an invalid hash, seq, or previousHash; restore it before continuing.`);
      }
      previousHash = event.hash;
    }
    if (previousHash !== anchor.headHash &&
        !(pendingJournal?.event?.hash === anchor.headHash &&
          pendingJournal.event.seq === events.length + 1 &&
          pendingJournal.event.previousHash === previousHash &&
          hashHistoryEvent(pendingJournal.event) === anchor.headHash)) {
      throw new Error("Migration history headHash disagrees with integrity.json; recover the pending journal or restore the record.");
    }
  } else if (events.some((event) => Object.hasOwn(event, "hash") ||
      Object.hasOwn(event, "previousHash") || Object.hasOwn(event, "seq"))) {
    throw new Error("Migration history has chained events without an integrity.json historyChain boundary.");
  }
  return events;
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

// Fix E (candidate change; analysis/inventory.md Defect
// "reconcileSliceState/inspectSliceArtifacts... only wired up inside the
// one-time v4->v5 upgrade coordinator"): resume never revalidated that
// state.json's navigation fields (`currentStep`, `activeSlice`,
// `pendingSlices`) actually agree with what `slices/*.json` and
// `evidence/*/result.json` record. This runs the existing reconciliation
// logic in read-only/verify mode: if it would produce any repair, resume
// throws a named inconsistency instead of silently trusting state.json.
// Normal resume never auto-repairs; that stays a one-time upgrade-coordinator
// operation.
const assertSliceStateConsistent = async (root, state) => {
  const { repairs } = await reconcileSliceState(root, state);
  if (repairs.length > 0) {
    throw new Error(
      `Migration state is inconsistent with slice/evidence artifacts and was not auto-repaired: ${repairs.join("; ")}. Investigate state.json and the slice/evidence records before continuing.`,
    );
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

// Evidence was validated as "a nonempty string", so arbitrary prose and paths
// that never existed reached BUILD_BASELINE and were then hash-pinned as
// authoritative. Hash pinning protects fabricated claims from later change; it
// does not make them true. A reference that *claims* to be a file -- it names a
// path with a file extension -- must resolve to bytes that exist.
//
// ponytail: only path-shaped claims are resolved. Prose evidence stays legal
// (the contract allows it) and line ranges are ignored, so the rule adds no new
// authoring burden and cannot pass a path that is simply not there. Ceiling:
// prose is still unverifiable. Upgrade path: a machine-readable evidence
// checklist with typed locations, which is the full P1-7 repair.
const PATH_CLAIM = /^[^\s]*\/[^\s/]+\.[A-Za-z0-9]+$/;

const evidencePathClaim = (value) => {
  if (typeof value !== "string") return null;
  const [head] = value.trim().split(/\s+/);
  // Strip a trailing `:12`, `:12-40`, or `:12,18-40` locator.
  const candidate = head.replace(/:[0-9][0-9,\-:]*$/, "");
  return PATH_CLAIM.test(candidate) ? candidate : null;
};

const commonAncestor = (left, right) => {
  let current = path.resolve(left);
  while (!isWithin(current, path.resolve(right))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
};

const resolveEvidencePath = async (claim, roots) => {
  if (!roots?.legacyRoot || !roots?.targetRoot) return null;
  const bases = [
    roots.legacyRoot,
    roots.targetRoot,
    commonAncestor(roots.legacyRoot, roots.targetRoot),
  ];
  for (const base of bases) {
    const absolute = path.resolve(base, claim);
    if (isWithin(base, absolute) && (await fileExists(absolute))) {
      return absolute;
    }
  }
  return null;
};

const assertEvidenceResolves = async (values, label, roots) => {
  for (const value of values) {
    const claim = evidencePathClaim(value);
    if (!claim) continue;
    if (!(await resolveEvidencePath(claim, roots))) {
      throw new Error(
        `${label} references '${claim}', which does not exist under the legacy or target repository. Evidence must point at real observations.`,
      );
    }
  }
};

// P1-7 machine-readable evidence checklist. `assertEvidenceResolves` above
// only closes "the path must exist"; `DISCOVERY-TARGET-UNDERVALIDATION` also
// exploited the absence of fixed categories, an evidence kind, and OpenSpec
// requirement/scenario lineage -- arbitrary prose with no structure reached
// BUILD_BASELINE. This is applied only at the DISCOVER_LEGACY/ASSESS_TARGET
// checkpoint gate itself (see `validateStep`), never inside
// `validateLegacyInventory`/`validateTargetInventory`, which stay exactly as
// lenient as before: those are reused every time a later step (BUILD_BASELINE,
// PLAN, FINALIZE) re-reads an already-closed, hash-pinned inventory, and a
// closed checkpoint's conclusions are tamper-checked, not re-litigated under a
// rule that postdates it (same philosophy as the P1-1 `artifactHashes`
// anchor). This keeps the real, already-completed `auth` migration's
// flat-string evidence fully valid forever, while any inventory not yet
// completed must use the checklist from here on.
const EVIDENCE_CATEGORIES = [
  "SOURCE",
  "RUNTIME_OBSERVATION",
  "REQUIREMENT_TRACE",
];
const EVIDENCE_KINDS = ["CODE", "CONFIG", "TEST", "DOCS", "OBSERVATION"];
const EVIDENCE_STATUSES = ["PRESENT", "NOT_APPLICABLE", "BLOCKED"];

const assertOpenSpecIds = (ids, allowed, label) => {
  for (const id of assertArray(ids ?? [], label)) {
    if (allowed && !allowed.includes(id)) {
      throw new Error(
        `${label} references '${id}', which the OpenSpec authority does not define.`,
      );
    }
  }
};

const assertEvidenceChecklist = async (items, label, roots, authority) => {
  const list = assertArray(items, label);
  const seenCategories = new Set();
  for (const [index, item] of list.entries()) {
    const at = `${label}[${index}]`;
    assertPlainObject(item, at);
    if (!EVIDENCE_CATEGORIES.includes(item.category)) {
      throw new Error(
        `${at}.category must be one of ${EVIDENCE_CATEGORIES.join(", ")}.`,
      );
    }
    if (!EVIDENCE_KINDS.includes(item.kind)) {
      throw new Error(
        `${at}.kind must be one of ${EVIDENCE_KINDS.join(", ")}.`,
      );
    }
    if (!EVIDENCE_STATUSES.includes(item.status)) {
      throw new Error(
        `${at}.status must be one of ${EVIDENCE_STATUSES.join(", ")}.`,
      );
    }
    if (item.status === "PRESENT") {
      const claim = evidencePathClaim(item.location);
      if (!claim || !(await resolveEvidencePath(claim, roots))) {
        throw new Error(
          `${at}.location '${item.location}' does not exist under the legacy or target repository.`,
        );
      }
    } else {
      assertNonEmpty(item.reason, `${at}.reason`);
    }
    assertOpenSpecIds(
      item.requirementIds,
      authority?.requirementIds,
      `${at}.requirementIds`,
    );
    assertOpenSpecIds(
      item.scenarioIds,
      authority?.scenarioIds,
      `${at}.scenarioIds`,
    );
    seenCategories.add(item.category);
  }
  const missing = EVIDENCE_CATEGORIES.filter(
    (category) => !seenCategories.has(category),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing required checklist categor${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}. Record an item (PRESENT, or NOT_APPLICABLE/BLOCKED with a reason) for each.`,
    );
  }
};

const assertLegacyDiscoveryChecklist = async (root, roots, authority) => {
  const inventory = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.legacyInventory),
      "Legacy inventory",
    ),
    "Legacy inventory",
  );
  for (const behavior of assertArray(inventory.behaviors, "Legacy behaviors")) {
    await assertEvidenceChecklist(
      behavior.evidence,
      `${behavior.id}.evidence`,
      roots,
      authority,
    );
  }
  for (const flow of assertArray(inventory.routeFlows, "Legacy route flows")) {
    await assertEvidenceChecklist(
      flow.evidence,
      `${flow.id}.evidence`,
      roots,
      authority,
    );
  }
  const remediation = await readOptionalJson(
    path.join(root, UI_REMEDIATION_FILE),
    "UI remediation",
  );
  for (const item of inventory.uiBehaviors ?? remediation?.uiBehaviors ?? []) {
    await assertEvidenceChecklist(
      item.evidence,
      `${item.id}.evidence`,
      roots,
      authority,
    );
  }
};

const assertTargetAssessmentChecklist = async (root, roots, authority) => {
  const inventory = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.targetInventory),
      "Target inventory",
    ),
    "Target inventory",
  );
  await assertEvidenceChecklist(
    inventory.evidence,
    "Target evidence",
    roots,
    authority,
  );
};

// P1-7: VERIFY_SLICES accepted bare, unverifiable command strings. Each
// command result must now be a structured record whose captured output is a
// real, hash-verified file -- the same tamper-evidence pattern as
// `assertEvidenceReference` below for FINALIZE gates.
// ponytail: this proves the *recorded* output wasn't fabricated after the
// fact; it does not re-execute the command itself (no sandboxed trusted
// runner here). Live re-execution belongs with P1-10's FINALIZE evidence
// producers, not this finding -- not implemented, not this finding's scope.
const assertCommandResults = async (commands, label, roots) => {
  const list = assertArray(commands, label);
  if (list.length === 0) {
    throw new Error(`${label} requires at least one executed command result.`);
  }
  for (const [index, entry] of list.entries()) {
    const at = `${label}[${index}]`;
    assertPlainObject(entry, at);
    assertNonEmpty(entry.command, `${at}.command`);
    if (entry.exitCode !== 0) {
      throw new Error(
        `${at} ('${entry.command}') recorded exitCode ${entry.exitCode}; a verification command must exit 0.`,
      );
    }
    assertIsoTimestamp(entry.executedAt, `${at}.executedAt`);
    assertNonEmpty(entry.runner, `${at}.runner`);
    const claim = evidencePathClaim(entry.outputPath);
    const resolved = claim && (await resolveEvidencePath(claim, roots));
    if (!resolved) {
      throw new Error(
        `${at}.outputPath '${entry.outputPath}' does not exist under the legacy or target repository. Record the captured output as a real file.`,
      );
    }
    if (!(await fileIdentityMatches(entry.outputDigest, resolved))) {
      throw new Error(
        `${at}.outputDigest does not match '${entry.outputPath}': recorded ${entry.outputDigest}, actual ${await fileIdentity(resolved)}.`,
      );
    }
  }
};

const validateLegacyInventory = async (root, roots, state) => {
  const persisted = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.legacyInventory),
      "Legacy inventory",
    ),
    "Legacy inventory",
  );
  const remediation = usesUiVerification(state)
    ? await readOptionalJson(
        path.join(root, UI_REMEDIATION_FILE),
        "UI remediation",
      )
    : null;
  const inventory = remediation
    ? {
        ...persisted,
        hasVisibleUi: remediation.hasVisibleUi,
        uiBehaviors: remediation.uiBehaviors,
      }
    : persisted;
  const behaviors = assertArray(inventory.behaviors, "Legacy behaviors");
  if (behaviors.length === 0) {
    throw new Error("Legacy inventory must contain at least one behavior.");
  }
  assertUniqueIds(behaviors, "Legacy behaviors");
  for (const behavior of behaviors) {
    assertNonEmpty(behavior.description, `${behavior.id}.description`);
    if (
      assertArray(behavior.evidence, `${behavior.id}.evidence`).length === 0
    ) {
      throw new Error(`${behavior.id} requires concrete legacy evidence.`);
    }
    await assertEvidenceResolves(
      behavior.evidence,
      `${behavior.id}.evidence`,
      roots,
    );
  }
  const routeFlows = assertArray(inventory.routeFlows, "Legacy route flows");
  assertUniqueIds(routeFlows, "Legacy route flows");
  if (routeFlows.length === 0 && inventory.explicitNoRouteFlows !== true) {
    throw new Error(
      "Legacy route flows are empty without explicitNoRouteFlows=true.",
    );
  }
  for (const flow of routeFlows) {
    assertNonEmpty(flow.description, `${flow.id}.description`);
    assertArray(flow.evidence, `${flow.id}.evidence`);
    await assertEvidenceResolves(flow.evidence, `${flow.id}.evidence`, roots);
    if (flow.independentListAndDetail === true) {
      assertNonEmpty(flow.listSurface, `${flow.id}.listSurface`);
      assertNonEmpty(flow.detailSurface, `${flow.id}.detailSurface`);
      assertNonEmpty(flow.openTransition, `${flow.id}.openTransition`);
      assertNonEmpty(flow.returnTransition, `${flow.id}.returnTransition`);
    }
  }
  if (usesUiVerification(state)) {
    assertBoolean(inventory.hasVisibleUi, "Legacy hasVisibleUi");
    const uiBehaviors = assertArray(
      inventory.uiBehaviors,
      "Legacy UI behaviors",
    );
    assertUniqueIds(uiBehaviors, "Legacy UI behaviors");
    if (inventory.hasVisibleUi !== uiBehaviors.length > 0) {
      throw new Error(
        "Legacy hasVisibleUi must equal whether discovery contains UI behaviors.",
      );
    }
    const behaviorIds = new Set(behaviors.map((behavior) => behavior.id));
    const observationIds = new Set();
    for (const item of uiBehaviors) {
      if (!behaviorIds.has(item.behaviorId)) {
        throw new Error(
          `${item.id}.behaviorId '${item.behaviorId}' is not a discovered legacy behavior.`,
        );
      }
      if (!UI_KINDS.has(item.kind)) {
        throw new Error(`${item.id}.kind '${item.kind}' is not supported.`);
      }
      assertNonEmpty(item.description, `${item.id}.description`);
      // "table exists" is not an inventory. Meaningful configuration
      // (showToolbar: false, compactMode: true, ...) is the part a target
      // implementation can silently drop, so it may not be empty.
      if (
        Object.keys(
          assertPlainObject(item.configuration, `${item.id}.configuration`),
        ).length === 0
      ) {
        throw new Error(
          `${item.id}.configuration must record the observable configuration, not an empty object.`,
        );
      }
      assertBoolean(item.conditional ?? false, `${item.id}.conditional`);
      if (UI_CONDITIONAL_KINDS.has(item.kind) && item.conditional !== true) {
        throw new Error(
          `${item.id}.kind '${item.kind}' is conditional by definition and requires conditional: true.`,
        );
      }
      if (item.conditional === true) {
        assertNonEmpty(item.precondition, `${item.id}.precondition`);
      }
      const interactions = assertArray(
        item.interactions ?? [],
        `${item.id}.interactions`,
      );
      assertUniqueIds(interactions, `${item.id}.interactions`);
      if (interactions.length === 0 && UI_INTERACTIVE_KINDS.has(item.kind)) {
        throw new Error(
          `${item.id}.kind '${item.kind}' requires at least one named interaction to exercise.`,
        );
      }
      for (const interaction of interactions) {
        assertNonEmpty(
          interaction.action,
          `${item.id}.${interaction.id}.action`,
        );
        assertNonEmpty(
          interaction.expected,
          `${item.id}.${interaction.id}.expected`,
        );
      }
      const runtimeStates = assertArray(
        item.runtimeStates,
        `${item.id}.runtimeStates`,
      );
      if (new Set(runtimeStates).size !== runtimeStates.length) {
        throw new Error(
          `${item.id}.runtimeStates must not contain duplicates.`,
        );
      }
      for (const runtimeState of runtimeStates) {
        if (!UI_RUNTIME_STATES.has(runtimeState)) {
          throw new Error(
            `${item.id}.runtimeStates contains unsupported state '${runtimeState}'.`,
          );
        }
      }
      await assertEvidenceResolves(item.evidence, `${item.id}.evidence`, roots);
      assertOpenSpecIds(
        item.requirementIds,
        state.requirementsAuthority.requirementIds,
        `${item.id}.requirementIds`,
      );
      assertOpenSpecIds(
        item.scenarioIds,
        state.requirementsAuthority.scenarioIds,
        `${item.id}.scenarioIds`,
      );
      if (item.requirementIds.length === 0 || item.scenarioIds.length === 0) {
        throw new Error(
          `${item.id} requires OpenSpec requirement and scenario traceability.`,
        );
      }
      if (usesRequiredObservations(state)) {
        assertRequiredObservations(item, observationIds);
      }
    }
  }
  return inventory;
};

/**
 * The format-18 acceptance set of one legacy UI behavior. Control identity is
 * (role, exact accessible name); `url` is page-scoped and has neither. Entries
 * are conjunctive, and every runtime state and declared interaction needs at
 * least one. Shape only: nothing here reads, or may be supplied by, TARGET proof.
 */
const OBSERVATION_EXPECTED = {
  presence: (value) => typeof value === "boolean",
  visibility: (value) => typeof value === "boolean",
  text: (value) => typeof value === "string",
  value: (value) => typeof value === "string",
  count: (value) => Number.isInteger(value) && value >= 0,
  url: (value) => typeof value === "string" && value.length > 0,
};
const OBSERVATION_FIELDS = new Set([
  "id",
  "state",
  "afterInteractionId",
  "role",
  "name",
  "predicate",
  "expected",
]);

export const assertRequiredObservations = (item, seenIds = new Set()) => {
  const label = `${item.id}.requiredObservations`;
  if (item.requiredObservations === undefined) {
    throw new Error(
      `${label} is missing. A format-${REQUIRED_OBSERVATIONS_FORMAT} UI behavior without it is an unadopted contract, never an empty set; author it from legacy evidence and the pinned OpenSpec authority.`,
    );
  }
  const observations = assertArray(item.requiredObservations, label);
  const runtimeStates = item.runtimeStates ?? [];
  const interactionIds = (item.interactions ?? []).map(
    (interaction) => interaction.id,
  );
  for (const [index, observation] of observations.entries()) {
    const at = `${label}[${index}]`;
    assertPlainObject(observation, at);
    const unknown = Object.keys(observation).filter(
      (key) => !OBSERVATION_FIELDS.has(key),
    );
    if (unknown.length > 0) {
      throw new Error(`${at} has unsupported fields: ${unknown.join(", ")}.`);
    }
    assertNonEmpty(observation.id, `${at}.id`);
    if (seenIds.has(observation.id)) {
      throw new Error(`${at}.id '${observation.id}' is not unique across the inventory.`);
    }
    seenIds.add(observation.id);
    if (!runtimeStates.includes(observation.state)) {
      throw new Error(
        `${at}.state '${observation.state}' is not one of ${item.id}.runtimeStates.`,
      );
    }
    if (
      "afterInteractionId" in observation &&
      !interactionIds.includes(observation.afterInteractionId)
    ) {
      throw new Error(
        `${at}.afterInteractionId '${observation.afterInteractionId}' is not an interaction of ${item.id}.`,
      );
    }
    const fits = OBSERVATION_EXPECTED[observation.predicate];
    if (!fits) {
      throw new Error(
        `${at}.predicate '${observation.predicate}' is not one of ${Object.keys(OBSERVATION_EXPECTED).join(", ")}.`,
      );
    }
    if (observation.predicate === "url") {
      if ("role" in observation || "name" in observation) {
        throw new Error(`${at} is a page-scoped url observation and takes no role or name.`);
      }
    } else {
      assertNonEmpty(observation.role, `${at}.role`);
      assertNonEmpty(observation.name, `${at}.name`);
    }
    if (!fits(observation.expected)) {
      throw new Error(
        `${at}.expected does not fit predicate '${observation.predicate}'.`,
      );
    }
  }
  for (const runtimeState of runtimeStates) {
    if (
      !observations.some(
        (observation) =>
          observation.state === runtimeState &&
          !("afterInteractionId" in observation),
      )
    ) {
      throw new Error(
        `${label} has no state observation for runtime state '${runtimeState}'.`,
      );
    }
  }
  for (const interactionId of interactionIds) {
    if (
      !observations.some(
        (observation) => observation.afterInteractionId === interactionId,
      )
    ) {
      throw new Error(
        `${label} has no post-action observation for interaction '${interactionId}'.`,
      );
    }
  }
};

/* ------------------------------------------------------------------ *
 * DISCOVERY_COMPLETENESS
 *
 * DISCOVER_LEGACY runs every check in one direction: declared evidence ->
 * the file exists. Nothing ran the other way, so an unmentioned file was
 * indistinguishable from a nonexistent one, and a file could be discussed in
 * step prose, consciously dropped, and produce zero behaviors, zero parity
 * rows, and zero approvals. This checkpoint runs the missing direction: the
 * file exists -> what does the inventory say about it?
 * ------------------------------------------------------------------ */

/**
 * ponytail: the chain digests the re-serialized object, not the raw line
 * bytes. `JSON.parse` preserves key order and `JSON.stringify` re-emits it, so
 * the round trip is stable for lines this workflow writes. Ceiling: a
 * hand-written line with different key order breaks its own chain, which is
 * the intended outcome anyway. Upgrade path: digest raw line bytes.
 */
export const decisionLineDigest = (decision) =>
  `sha256:${createHash("sha256").update(JSON.stringify(decision)).digest("hex")}`;

export const decisionRationaleDigest = (rationale) =>
  `sha256:${createHash("sha256")
    .update(String(rationale).replace(/\r\n/g, "\n").trim())
    .digest("hex")}`;

/** The record's exact lifecycle position, as one comparable object. */
export const lifecycleBinding = async (state, statePath) => ({
  module: state.migrationId ?? state.targetModule ?? null,
  formatVersion: state.formatVersion ?? null,
  revision: state.revision ?? null,
  stateHash: await hashFile(statePath),
  status: state.status ?? null,
  currentStep: state.currentStep ?? null,
  activeSlice: state.activeSlice ?? null,
});

export const edgeDecisionSubject = (finding) =>
  `${finding.file}:${finding.line}#${finding.id}`;

export const createDecisionCandidate = ({
  kind,
  subjectType,
  subjectPath,
  rationale,
  targets = [],
  boundTo,
}) => {
  const candidate = {
    kind,
    subject: { type: subjectType, path: subjectPath },
    rationaleDigest: decisionRationaleDigest(rationale),
    targets: [...new Set(targets)].sort(),
    boundTo,
  };
  return {
    id: `APP-${createHash("sha256")
      .update(JSON.stringify(candidate))
      .digest("hex")
      .slice(0, 20)}`,
    ...candidate,
    rationale: String(rationale).replace(/\r\n/g, "\n").trim(),
  };
};

const decisionGroupMemberFact = (candidate) => ({
  id: candidate.id,
  kind: candidate.kind,
  subject: candidate.subject,
  rationaleDigest: candidate.rationaleDigest,
  targets: [...(candidate.targets ?? [])],
  pathDigest: candidate.boundTo?.pathDigest ?? null,
});

export const DECISION_GROUP_KIND = "GROUP_APPROVAL";

const DECISION_MODULE_BINDING = [
  "module",
  "legacyRevision",
  "legacyDirtyDigest",
  "discoveryDigest",
  "algorithmVersion",
];

/** One stable candidate representing the first homogeneous approvable group. */
export const decisionGroupFor = (candidates, lifecycle) => {
  const approvable = candidates.filter((candidate) => candidate.approvable);
  const [first] = approvable;
  if (!first) return null;
  const binding = Object.fromEntries(
    DECISION_MODULE_BINDING.map((field) => [field, first.boundTo?.[field]]),
  );
  const members = approvable.filter(
    (candidate) =>
      candidate.kind === first.kind &&
      DECISION_MODULE_BINDING.every(
        (field) => candidate.boundTo?.[field] === binding[field],
      ),
  );
  if (members.length < 2) return null;
  const facts = members.map(decisionGroupMemberFact);
  const group = createDecisionCandidate({
    kind: DECISION_GROUP_KIND,
    subjectType: "DECISION_GROUP",
    subjectPath: `${first.kind}@${String(binding.discoveryDigest).replace(/^sha256:/, "").slice(0, 12)}`,
    rationale: facts
      .map(
        (fact, index) =>
          `${index + 1}. ${fact.id} ${fact.kind} ${fact.subject.path}` +
          (fact.pathDigest ? ` [${fact.pathDigest}]` : ""),
      )
      .join("\n"),
    targets: [],
    boundTo: {
      ...binding,
      groupKind: "DECISION_CANDIDATES",
      lifecycle,
      members: facts,
    },
  });
  return { ...group, approvable: true, blockers: [], groupMembers: members };
};

export const decisionAppliesToCandidate = (decision, candidate) =>
  Boolean(decision && candidate) &&
  decision.candidateId === candidate.id &&
  decision.kind === candidate.kind &&
  decision.subject?.type === candidate.subject.type &&
  decision.subject?.path === candidate.subject.path &&
  JSON.stringify(decision.targets ?? []) ===
    JSON.stringify(candidate.targets) &&
  decision.rationaleDigest === candidate.rationaleDigest &&
  [
    "module",
    "legacyRevision",
    "legacyDirtyDigest",
    "discoveryDigest",
    "algorithmVersion",
  ].every((field) => decision.boundTo?.[field] === candidate.boundTo[field]);

export const rawDecisionLedgerDigest = async (root) => {
  const file = path.join(root, DECISIONS_FILE);
  const bytes = (await fileExists(file))
    ? await readFile(file)
    : Buffer.alloc(0);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};

/** The pinned prefix length, so the pin can be append-only rather than frozen. */
export const rawDecisionLedgerBytes = async (root) => {
  const file = path.join(root, DECISIONS_FILE);
  return (await fileExists(file)) ? (await readFile(file)).length : 0;
};

/** Which principal a recorded line claims. Absent means the original human one. */
export const decisionChannelOf = (decision) =>
  decision?.authorizedBy?.channel ?? "TERMINAL";

/**
 * Reads one decision ledger and verifies its hash chain. Absent file is legal:
 * a module with nothing to approve records nothing.
 *
 * `principal` is the segregation guard, and it is the reason this is one
 * function over two files rather than two functions. A line is only ever read
 * back out of the ledger its principal owns, so appending an `AUTO` line to the
 * human record -- or a forged `TERMINAL` line to the auto record -- does not
 * quietly become authority; it makes the file unreadable and every command that
 * opens the record says so.
 */
const readDecisionLedger = async (root, file, principal) => {
  const absolute = path.join(root, file);
  if (!(await fileExists(absolute))) return { decisions: [], byId: new Map() };
  const decisions = [];
  const lines = (await readFile(absolute, "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let decision;
    try {
      decision = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${file} line ${index + 1} is not valid JSON: ${error.message}. The operator decision record was truncated or rewritten.`,
      );
    }
    const channel = decisionChannelOf(decision);
    if (principal === "AUTO" ? channel !== "AUTO" : channel === "AUTO") {
      throw new Error(
        `${file} line ${index + 1} ('${decision.id ?? "unknown"}') records channel '${channel}', which does not belong in this ledger. ${DECISIONS_FILE} is the human operator record and ${AUTO_DECISIONS_FILE} is the AUTO principal's; a line in the wrong one is a forged principal, not a misfile.`,
      );
    }
    const previous = decisions.at(-1) ?? null;
    const expectedPrev = previous ? decisionLineDigest(previous) : "genesis";
    if (decision.prevDigest !== expectedPrev) {
      throw new Error(
        `${file} line ${index + 1} ('${decision.id ?? "unknown"}') chains to '${decision.prevDigest}', but the preceding line digests to '${expectedPrev}'. A decision was edited, reordered, or removed; the whole record is untrusted.`,
      );
    }
    if (decision.seq !== decisions.length + 1) {
      throw new Error(
        `${file} line ${index + 1} records seq ${decision.seq} at position ${decisions.length + 1}.`,
      );
    }
    decisions.push(decision);
  }
  return {
    decisions,
    byId: new Map(decisions.map((decision) => [decision.id, decision])),
  };
};

/** The human record, and only ever the human record. */
export const readOperatorDecisions = async (root) =>
  readDecisionLedger(root, DECISIONS_FILE, "OPERATOR");

/** The AUTO principal's record, and only ever that. */
export const readAutoDecisions = async (root) =>
  readDecisionLedger(root, AUTO_DECISIONS_FILE, "AUTO");

/**
 * Every recorded decision, whoever made it, for *resolving a citation*.
 *
 * Validation asks "does the id this row cites resolve to a line that binds to
 * this candidate", and that question has the same answer for both principals --
 * the binding digests, the rationale digest and the candidate identity are what
 * make a line authority, and they are checked identically. Which principal
 * decided stays legible in the id prefix and in `authorizedBy.channel`; it is
 * never erased by this union, only looked up through it.
 */
export const readRecordedDecisions = async (root) => {
  const [operator, auto] = await Promise.all([
    readOperatorDecisions(root),
    readAutoDecisions(root),
  ]);
  return {
    operator: operator.decisions,
    auto: auto.decisions,
    decisions: [...operator.decisions, ...auto.decisions],
    byId: new Map([...operator.byId, ...auto.byId]),
  };
};

const CLASSIFICATION_SCOPES = [
  "OWNED",
  "SUPPORTING",
  "INBOUND_CONSUMER",
  "GOVERNING_FRAMEWORK",
  "EXTERNAL",
  "UNRESOLVED",
];
const DISPOSITIONS = [
  "BEHAVIOR_BACKED",
  "INFRASTRUCTURE_ONLY",
  "NO_OBSERVABLE_BEHAVIOR",
  "DEAD",
  "EXCLUDED_APPROVED",
];
/** Dispositions an operator, and only an operator, can grant. */
const DECISION_BACKED_DISPOSITIONS = {
  DEAD: "DEAD_CONFIRMATION",
  EXCLUDED_APPROVED: "EXCLUSION",
};
/**
 * The mandatory safeguard. A user can see these; "no observable behavior" and
 * "infrastructure only" are exactly the claims that made a decorative
 * component vanish from a migration in the first place, and an agent must
 * never be able to make that claim about something on screen by itself.
 */
const AGENT_DISMISSIBLE = new Set([
  "NO_OBSERVABLE_BEHAVIOR",
  "INFRASTRUCTURE_ONLY",
]);

/**
 * The exact legacy bytes an approval or a confirmation was shown.
 *
 * `legacyRevision` alone is a commit, so an uncommitted edit slips underneath
 * it; the dirty manifest alone repeats itself once that edit is committed and
 * the file leaves the dirty set. The pair identifies one working tree, which is
 * what "the source the operator approved" means.
 */
export const legacySourceBinding = async (legacyRoot) => {
  const [revision, dirty] = await Promise.all([
    gitRevision(legacyRoot),
    dirtyManifest(legacyRoot),
  ]);
  return { legacyRevision: revision.revision, legacyDirtyDigest: dirty.digest };
};

/**
 * The one authority every module-side operator approval passes through.
 *
 * A row cites a decision id; the id must resolve to a recorded line, the line
 * must digest to the digest the row pins, and `decisionAppliesToCandidate` --
 * the same predicate `record-decision.mjs` and the artifact engine use -- must
 * bind it to the candidate this validation just derived from the current scan.
 *
 * `candidate` is required, never optional. Every candidate-bound check here used
 * to read `candidate && ...`, and callers supplied one only at scanner version
 * >= 2. `algorithmVersion` is an *agent-authored* field of
 * `module-classification.json`, so writing `1` switched candidate identity,
 * subject type, targets, module and scanner binding off in one edit, and a
 * hand-written ledger line matching only kind, path, rationale and discovery
 * digest became sufficient authority. A candidate is derivable at every
 * supported scanner version, so there is no version at which an authored line
 * may stand on its own -- and no candidate means no authority at all.
 */
const requireDecision = ({ byId, row, label, candidate }) => {
  if (!candidate) {
    throw new Error(
      `${label} requires an operator decision, but no stable candidate could be derived to bind one to. A recorded ledger line is never authority by itself; re-run discovery and approve the current candidate.`,
    );
  }
  const decisionId = assertNonEmpty(row.decisionId, `${label}.decisionId`);
  const decision = byId.get(decisionId);
  if (!decision) {
    throw new Error(
      `${label} cites decision '${decisionId}', which is recorded in neither ${DECISIONS_FILE} nor ${AUTO_DECISIONS_FILE}. Only record-decision.mjs writes either -- a human answering a challenge into the first, the AUTO principal under --mode auto into the second -- and an agent can never author its own approval into either.`,
    );
  }
  if (decision.kind !== candidate.kind) {
    throw new Error(
      `${label} cites '${decisionId}', which is a ${decision.kind} decision; a ${candidate.kind} decision is required.`,
    );
  }
  if (decision.subject?.path !== candidate.subject.path) {
    throw new Error(
      `${label} cites '${decisionId}', which approves '${decision.subject?.path ?? "nothing"}'. An approval cannot be recycled onto '${candidate.subject.path}'.`,
    );
  }
  const expectedDigest = decisionLineDigest(decision);
  if (row.decisionDigest !== expectedDigest) {
    throw new Error(
      `${label}.decisionDigest does not match decision '${decisionId}': recorded ${row.decisionDigest ?? "nothing"}, actual ${expectedDigest}.`,
    );
  }
  if (decision.rationaleDigest !== candidate.rationaleDigest) {
    throw new Error(
      `${label}.rationale changed after decision '${decisionId}' approved it. An approval binds to the exact rationale it was shown; record a new decision or restore the rationale.`,
    );
  }
  if (decision.boundTo?.discoveryDigest !== candidate.boundTo.discoveryDigest) {
    throw new Error(
      `${label} cites '${decisionId}', which was recorded against discovery digest '${decision.boundTo?.discoveryDigest ?? "none"}'; the module now scans to '${candidate.boundTo.discoveryDigest}'. The facts the operator approved changed; record the decision again.`,
    );
  }
  if (
    decision.boundTo?.module !== candidate.boundTo.module ||
    decision.boundTo?.algorithmVersion !== candidate.boundTo.algorithmVersion
  ) {
    throw new Error(
      `${label} cites '${decisionId}', but its module or scanner-version binding does not match candidate '${candidate.id}'.`,
    );
  }
  // The digest binds the graph -- roots, entry points, edges, what is unproven
  // -- and deliberately not the bytes inside a file. So an approval for
  // decorative content used to survive that content growing a delete button, as
  // long as the path and the imports held still. This is the missing half.
  if (
    decision.boundTo?.legacyRevision !== candidate.boundTo.legacyRevision ||
    decision.boundTo?.legacyDirtyDigest !== candidate.boundTo.legacyDirtyDigest
  ) {
    throw new Error(
      `${label} cites '${decisionId}', which was recorded against legacy source ${decision.boundTo?.legacyRevision ?? "none"}/${decision.boundTo?.legacyDirtyDigest ?? "none"}; the legacy tree now reads ${candidate.boundTo.legacyRevision}/${candidate.boundTo.legacyDirtyDigest}. An approval binds to the exact bytes it approved, not just to the shape of the import graph; record the decision again.`,
    );
  }
  // Last, deliberately. `candidateId` hashes everything checked above, so a
  // stale census, an edited rationale and edited legacy bytes would all surface
  // as one indistinguishable "wrong candidate" if this ran first. What reaches
  // it is a line that agrees on every named field and still is not the
  // candidate: an authored id, a fabricated line, a replay from another target.
  if (decision.candidateId !== candidate.id) {
    throw new Error(
      `${label} cites '${decisionId}', but that line does not approve current stable candidate '${candidate.id}'. Agent-authored, fake, and stale approval ids never satisfy a candidate.`,
    );
  }
  if (decision.subject?.type !== candidate.subject.type) {
    throw new Error(
      `${label} cites '${decisionId}', but its subject type does not match candidate '${candidate.id}'.`,
    );
  }
  if (
    JSON.stringify(decision.targets ?? []) !== JSON.stringify(candidate.targets)
  ) {
    throw new Error(
      `${label} cites '${decisionId}', but its concrete targets do not match candidate '${candidate.id}'.`,
    );
  }
  // The checks above are diagnostics: each names one way a line fails to bind.
  // This is the authority. A field added to the binding is enforced here whether
  // or not a message above ever learns to name it.
  if (!decisionAppliesToCandidate(decision, candidate)) {
    throw new Error(
      `${label} cites '${decisionId}', which is not bound to current stable candidate '${candidate.id}'.`,
    );
  }
  return decision;
};

const moduleEdgeTargetsFrom = (classification) =>
  Object.fromEntries(
    assertArray(classification.findings ?? [], "findings")
      .filter((row) => row?.targets !== undefined)
      .map((row, index) => [
        assertNonEmpty(row?.id, `findings[${index}].id`),
        assertArray(row.targets, `findings[${index}].targets`),
      ]),
  );

const assertRecordedScannerVersion = (value, label, recovery) => {
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
  const algorithmVersion = assertRecordedScannerVersion(
    classification.algorithmVersion,
    "Module classification",
    `Record one of ${[...SUPPORTED_ALGORITHM_VERSIONS].join(", ")} explicitly before scanning.`,
  );
  const { runDiscoveryScan } = await import("./discovery-scan.mjs");
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
const moduleRootPath = (entry) =>
  isPlainObject(entry) ? entry.path : typeof entry === "string" ? entry : null;

/**
 * Which source a root belongs to. A single-source record needs no `source`
 * field -- its one declared name is the only possible answer -- so the field
 * is required exactly where attribution has work to do.
 */
const moduleRootSource = (entry, sources) =>
  (isPlainObject(entry) ? entry.source : null) ??
  (sources.length === 1 ? sources[0] : null);

/**
 * The three rules that make `sourceOfEvidence` total and deterministic, applied
 * at DISCOVERY_COMPLETENESS -- the earliest boundary at which roots truthfully
 * exist, and the checkpoint that already pins them immutable. Nothing reads a
 * root's source before this runs.
 *
 * Format <= 14 classifications, whose entries may be bare strings, are
 * untouched: the field is required only where more than one source converges.
 */
const assertSourcedModuleRoots = (declaredRoots, state) => {
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

const assertLegacyEvidenceWithinBoundary = async (inventory, scan, roots) => {
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

export const validateDiscoveryCompleteness = async (
  root,
  state,
  roots,
  { scan: precomputed } = {},
) => {
  const { VISUAL_KINDS, PRODUCTION_REACHABILITY } =
    await import("./discovery-scan.mjs");
  const { classification, declaredRoots, scan } =
    await readCanonicalModuleBoundary(root, state, roots, {
      scan: precomputed,
    });
  const { byId } = await readRecordedDecisions(root);
  // The canonical migration identity, not `state.legacyModule`: the recorder
  // binds every approval to `migrationId`, so validation has to recompute the
  // candidate under the same key or a multi-source record (where `migrationId
  // === targetModule` but `legacyModule === legacySources[0]`) could never
  // match an approved APP id. Identical at format <= 14, where
  // `migrationId === legacyModule`.
  //
  // Every binding an approval is checked against now lives here and nowhere
  // else: `requireDecision` reads the discovery digest and legacy source off
  // the candidate, so validation and the recorder cannot drift apart.
  const candidateBoundTo = {
    module: state.migrationId,
    ...(await legacySourceBinding(roots.legacyRoot)),
    discoveryDigest: scan.discoveryDigest,
    algorithmVersion: scan.algorithmVersion,
  };

  // C9: exactly one root per declared source may be implicit -- the slice that
  // source is named after. Every additional root widens the module's boundary,
  // and widening it is an operator decision, not an agent's.
  //
  // Per source and not per `state.legacyModule`: that field is
  // `legacySources[0]`, alphabetically first and nothing more, so keying on it
  // would demand a ROOT_DECLARATION for every root of every other source purely
  // for being named after the wrong module. A single-source record resolves to
  // exactly the one root it always did.
  const implicitRoots = new Set(
    legacySourcesOf(state)
      .map(
        (name) =>
          [...scan.moduleRoots]
            .filter((value) => path.posix.basename(value) === name)
            .sort()[0],
      )
      .filter(Boolean),
  );
  for (const [index, entry] of declaredRoots.entries()) {
    const label = `moduleRoots[${index}]`;
    const rootPath = assertNonEmpty(
      isPlainObject(entry) ? entry.path : entry,
      `${label}.path`,
    );
    assertNonEmpty(
      isPlainObject(entry) ? entry.reason : null,
      `${label}.reason`,
    );
    if (implicitRoots.has(rootPath)) continue;
    requireDecision({
      byId,
      row: {
        decisionId: entry.decisionId,
        decisionDigest: entry.decisionDigest,
      },
      label,
      // Built exactly as `record-decision.mjs` builds the candidate it
      // challenges on, at every scanner version: same kind, subject type,
      // rationale normalization and binding, so the same id comes out.
      candidate: createDecisionCandidate({
        kind: "ROOT_DECLARATION",
        subjectType: "MODULE_ROOT",
        subjectPath: rootPath,
        rationale: entry.reason ?? "",
        boundTo: candidateBoundTo,
      }),
    });
  }

  const inventory = await readJson(
    path.join(root, initialArtifacts.legacyInventory),
    "Legacy inventory",
  );
  await assertLegacyEvidenceWithinBoundary(inventory, scan, roots);
  const behaviorIds = new Set(
    (inventory.behaviors ?? []).map((behavior) => behavior?.id),
  );
  const flowIds = new Set((inventory.routeFlows ?? []).map((flow) => flow?.id));

  const rows = assertArray(classification.files, "Module classification files");
  const seen = new Map();
  const censusSet = new Set(scan.census);
  const edgeSources = new Map();
  for (const edge of scan.edges) {
    if (!edgeSources.has(edge.to)) edgeSources.set(edge.to, new Set());
    edgeSources.get(edge.to).add(edge.from);
  }

  for (const [index, row] of rows.entries()) {
    const label = `files[${index}]`;
    assertPlainObject(row, label);
    const filePath = assertNonEmpty(row.path, `${label}.path`);
    // C2: a row for a file the census does not contain is either a typo or an
    // attempt to satisfy C1 without touching the real file.
    if (!censusSet.has(filePath)) {
      throw new Error(
        `${label} classifies '${filePath}', which is not in the module census (${scan.census.length} file(s) under ${scan.moduleRoots.join(", ")}). Classify only files the module owns; a file outside the roots belongs in 'supporting'.`,
      );
    }
    if (seen.has(filePath)) {
      throw new Error(
        `Module classification records '${filePath}' twice (${seen.get(filePath)} and ${label}).`,
      );
    }
    seen.set(filePath, label);
    if (row.scope !== "OWNED") {
      throw new Error(
        `${label}.scope must be 'OWNED' for a census file; got '${row.scope}'. Valid scopes are ${CLASSIFICATION_SCOPES.join(", ")}.`,
      );
    }
    // reachability and kind are computed, never authored: otherwise the
    // safeguard below is defeated by relabelling a visible component
    // UNREACHABLE.
    const reachability = scan.reachability[filePath];
    if (row.reachability !== reachability) {
      throw new Error(
        `${label}.reachability records '${row.reachability}', but the scan computes '${reachability}'. Reachability is derived, not declared.`,
      );
    }
    const kind = scan.kinds[filePath];
    if (row.kind !== kind) {
      throw new Error(
        `${label}.kind records '${row.kind}', but '${filePath}' is a ${kind}.`,
      );
    }
    for (const source of assertArray(
      row.reachedFrom ?? [],
      `${label}.reachedFrom`,
    )) {
      if (!edgeSources.get(filePath)?.has(source)) {
        throw new Error(
          `${label}.reachedFrom names '${source}', which does not reference '${filePath}' in the scanned graph.`,
        );
      }
    }
    if (!DISPOSITIONS.includes(row.disposition)) {
      throw new Error(
        `${label}.disposition must be one of ${DISPOSITIONS.join(", ")}; got ${JSON.stringify(row.disposition)}. Prose is not a disposition.`,
      );
    }
    // The mandatory safeguard.
    if (
      VISUAL_KINDS.has(kind) &&
      PRODUCTION_REACHABILITY.has(reachability) &&
      AGENT_DISMISSIBLE.has(row.disposition)
    ) {
      throw new Error(
        `${label} ('${filePath}') is a production-reachable ${kind} classified ${row.disposition} on agent-authored rationale alone. A ${kind} a user can reach is BEHAVIOR_BACKED with a real behavior id, or EXCLUDED_APPROVED with an operator decision recorded at a terminal. Rationale is never enough for something on screen.`,
      );
    }
    if (row.disposition === "BEHAVIOR_BACKED") {
      const cited = [
        ...assertArray(row.behaviorIds ?? [], `${label}.behaviorIds`),
        ...assertArray(row.routeFlowIds ?? [], `${label}.routeFlowIds`),
      ];
      if (cited.length === 0) {
        throw new Error(
          `${label} is BEHAVIOR_BACKED but cites no behaviorIds or routeFlowIds.`,
        );
      }
      for (const id of cited) {
        if (!behaviorIds.has(id) && !flowIds.has(id)) {
          throw new Error(
            `${label} cites '${id}', which ${initialArtifacts.legacyInventory} does not define.`,
          );
        }
      }
      continue;
    }
    assertNonEmpty(row.rationale, `${label}.rationale`);
    await assertEvidenceChecklist(
      row.evidence,
      `${label}.evidence`,
      roots,
      state?.requirementsAuthority,
    );
    const expectedKind = DECISION_BACKED_DISPOSITIONS[row.disposition];
    if (expectedKind) {
      requireDecision({
        byId,
        row,
        label,
        candidate: createDecisionCandidate({
          kind: expectedKind,
          subjectType: "FILE",
          subjectPath: filePath,
          rationale: row.rationale ?? "",
          boundTo: candidateBoundTo,
        }),
      });
    }
    if (
      row.disposition === "DEAD" &&
      !row.evidence.some(
        (item) =>
          item?.category === "RUNTIME_OBSERVATION" &&
          item?.status === "PRESENT",
      )
    ) {
      throw new Error(
        `${label} is DEAD but records no PRESENT RUNTIME_OBSERVATION evidence. "Nothing imports it" is a graph fact, not proof it never runs.`,
      );
    }
  }

  // C1: the decisive check. Every file the census found, whether anything
  // imports it or not, must have been classified.
  const missing = scan.census.filter((filePath) => !seen.has(filePath));
  if (missing.length > 0) {
    throw new Error(
      `Module classification omits ${missing.length} file(s) the census found under ${scan.moduleRoots.join(", ")}: ${missing.join(", ")}. Every owned file needs a disposition, including files nothing imports. An unmentioned file is not an excluded file.`,
    );
  }

  // C4: what the module needs from outside its roots is recorded, so a
  // "supporting" file cannot be quietly relied on and then left behind.
  const supportingRows = new Map();
  for (const [index, row] of assertArray(
    classification.supporting ?? [],
    "Module classification supporting",
  ).entries()) {
    const label = `supporting[${index}]`;
    const filePath = assertNonEmpty(row?.path, `${label}.path`);
    if (supportingRows.has(filePath)) {
      throw new Error(
        `Module classification records supporting file '${filePath}' twice.`,
      );
    }
    supportingRows.set(filePath, { row, label });
  }
  const computedSupporting = new Map(
    (scan.boundary?.supporting ?? []).map((entry) => [entry.path, entry]),
  );
  for (const filePath of scan.supporting) {
    const entry = supportingRows.get(filePath);
    if (!entry) {
      throw new Error(
        `Module classification omits supporting file '${filePath}', which an owned file requires (required by ${(scan.requiredBy[filePath] ?? []).join(", ")}). It sits outside the declared roots, so it needs no disposition -- but it must be recorded.`,
      );
    }
    const declared = assertArray(
      entry.row.requiredBy ?? [],
      `${entry.label}.requiredBy`,
    );
    if (declared.length === 0) {
      throw new Error(
        `${entry.label}.requiredBy must name at least one requiring file.`,
      );
    }
    if (scan.algorithmVersion >= 2) {
      const computed = computedSupporting.get(filePath);
      if ((entry.row.relation ?? entry.row.scope) !== "SUPPORTING") {
        throw new Error(`${entry.label}.relation must be 'SUPPORTING'.`);
      }
      if (entry.row.type !== computed?.type) {
        throw new Error(
          `${entry.label}.type records '${entry.row.type}', but the canonical boundary computes '${computed?.type}'.`,
        );
      }
      if (
        JSON.stringify([...declared].sort()) !==
        JSON.stringify(scan.requiredBy[filePath] ?? [])
      ) {
        throw new Error(
          `${entry.label}.requiredBy must exactly match the canonical boundary evidence for '${filePath}'.`,
        );
      }
    }
    for (const requirer of declared) {
      if (!(scan.requiredBy[filePath] ?? []).includes(requirer)) {
        throw new Error(
          `${entry.label}.requiredBy names '${requirer}', which does not require '${filePath}' in the scanned graph.`,
        );
      }
    }
  }
  for (const [filePath, entry] of supportingRows) {
    if (!scan.supporting.includes(filePath)) {
      throw new Error(
        `${entry.label} classifies '${filePath}' as SUPPORTING, but the canonical boundary has no supporting relation to it. Shared files do not become dependencies by declaration.`,
      );
    }
  }

  // C5: an unresolved first-party reference is a hole in the graph, and a hole
  // in the graph is exactly where a missed file hides.
  if (scan.unresolved.length > 0) {
    throw new Error(
      `${scan.unresolved.length} first-party reference(s) could not be resolved: ${scan.unresolved
        .map((entry) => `${entry.from} -> '${entry.spec}'`)
        .join(
          "; ",
        )}. Fix the specifier, or record why it resolves to nothing first-party.`,
    );
  }
  for (const [index, entry] of assertArray(
    classification.unresolvedReferences ?? [],
    "unresolvedReferences",
  ).entries()) {
    assertPlainObject(entry, `unresolvedReferences[${index}]`);
    assertNonEmpty(entry.reason, `unresolvedReferences[${index}].reason`);
  }

  // C6: an edge whose target cannot be proven is not a resolved edge.
  const findingRows = new Map(
    assertArray(classification.findings ?? [], "findings").map((row, index) => [
      assertNonEmpty(row?.id, `findings[${index}].id`),
      { row, label: `findings[${index}]` },
    ]),
  );
  for (const finding of scan.findings) {
    const entry = findingRows.get(finding.id);
    if (!entry) {
      throw new Error(
        `Unresolved ${finding.type} at ${finding.file}:${finding.line} ('${finding.spec}') has no ${finding.id} row in the classification. The scan cannot prove where this edge lands; resolve it explicitly.`,
      );
    }
    if (finding.type === "I18N_NAMESPACE") {
      if (scan.algorithmVersion >= 2) {
        throw new Error(
          `${finding.id} namespace '${finding.spec}' at ${finding.file}:${finding.line} has no proven runtime resource. Add the tracked namespace mapping to governing i18n configuration; an authored path is not proof.`,
        );
      }
      const resolution = assertNonEmpty(
        entry.row.resolution,
        `${entry.label}.resolution`,
      );
      if (!censusSet.has(resolution) && !scan.supporting.includes(resolution)) {
        throw new Error(
          `${entry.label}.resolution '${resolution}' is neither an owned nor a supporting file. Map the namespace to the resource that actually backs it.`,
        );
      }
      const cited = assertArray(
        entry.row.behaviorIds ?? [],
        `${entry.label}.behaviorIds`,
      );
      if (cited.length === 0) {
        throw new Error(
          `${entry.label} maps namespace '${finding.spec}' to '${resolution}' but cites no behavior. Translated copy is observable behavior.`,
        );
      }
      for (const id of cited) {
        if (!behaviorIds.has(id) && !flowIds.has(id)) {
          throw new Error(
            `${entry.label} cites '${id}', which ${initialArtifacts.legacyInventory} does not define.`,
          );
        }
      }
      continue;
    }
    if (scan.algorithmVersion >= 2) {
      const targets = assertArray(entry.row.targets, `${entry.label}.targets`);
      if (targets.length === 0) {
        throw new Error(
          `${entry.label} must name at least one concrete tracked target for ${finding.type}; prose or approval alone never resolves a module edge.`,
        );
      }
      if (
        JSON.stringify([...targets].sort()) !==
        JSON.stringify(finding.resolvedTargets ?? [])
      ) {
        throw new Error(
          `${entry.label}.targets do not match the scanner's concrete tracked targets for ${finding.id}. Re-run discovery and use its current targets.`,
        );
      }
    }
    requireDecision({
      byId,
      row: {
        decisionId: entry.row.decisionId,
        decisionDigest: entry.row.decisionDigest,
      },
      label: entry.label,
      candidate: createDecisionCandidate({
        kind: "EDGE_RESOLUTION",
        // The pre-2 scanner has no edge identity, so its subject is the file --
        // which is exactly what `record-decision.mjs` challenges on there too.
        subjectType: scan.algorithmVersion >= 2 ? "MODULE_EDGE" : "FILE",
        subjectPath:
          scan.algorithmVersion >= 2
            ? edgeDecisionSubject(finding)
            : finding.file,
        rationale: entry.row.resolution ?? entry.row.rationale ?? "",
        targets: finding.resolvedTargets ?? [],
        boundTo: candidateBoundTo,
      }),
    });
  }
  for (const [findingId, entry] of findingRows) {
    if (!scan.findings.some((finding) => finding.id === findingId)) {
      throw new Error(
        `${entry.label} names stale finding '${findingId}'. Re-run discovery and remove or replace the stale row.`,
      );
    }
  }

  return { classification, scan };
};

/**
 * A brownfield inventory has to have actually looked at the feature. One
 * PRESENT `SOURCE` item under `src/features/<target>/` is the minimum: an
 * inventory of a substantially implemented feature cannot legitimately cite
 * nothing inside it.
 */
const assertAdoptedTargetEvidence = async (evidence, roots, state) => {
  const featureDirectory = targetFeatureDirectory(
    roots.targetRoot,
    state.targetModule,
  );
  for (const item of evidence) {
    const isSource =
      typeof item === "string" ? true : item?.category === "SOURCE";
    if (!isSource) continue;
    const claim = evidencePathClaim(
      typeof item === "string" ? item : item?.location,
    );
    if (!claim) continue;
    const absolute = await resolveEvidencePath(claim, roots);
    if (absolute && isWithin(featureDirectory, absolute)) return evidence;
  }
  throw new Error(
    `Target inventory cites no SOURCE evidence under 'src/features/${state.targetModule}/'. An adopted target must be inventoried from the implementation it claims to adopt.`,
  );
};

const validateTargetInventory = async (root, roots, legacy, state) => {
  const persisted = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.targetInventory),
      "Target inventory",
    ),
    "Target inventory",
  );
  const remediation = usesUiVerification(state)
    ? await readOptionalJson(
        path.join(root, UI_REMEDIATION_FILE),
        "UI remediation",
      )
    : null;
  const inventory = remediation
    ? {
        ...persisted,
        hasVisibleUi: remediation.hasVisibleUi,
        uiMismatches: remediation.uiMismatches,
      }
    : persisted;
  if (!TARGET_STATES.has(inventory.implementationState)) {
    throw new Error(
      `Invalid target implementation state '${inventory.implementationState}'.`,
    );
  }
  if (assertArray(inventory.evidence, "Target evidence").length === 0) {
    throw new Error("Target inventory requires concrete evidence.");
  }
  await assertEvidenceResolves(inventory.evidence, "Target evidence", roots);
  // The five implementation states were validated and then discarded -- no
  // branch read them, so `IMPLEMENTED_UNVERIFIED` had no effect and a false
  // `ABSENT` cost nothing. Under `--adopt-target` they become load-bearing:
  // the record was created *because* the target exists, so an inventory of it
  // may not come back empty or absent.
  if (isBrownfield(state)) {
    if (inventory.implementationState === "ABSENT") {
      throw new Error(
        `Target inventory records ABSENT, but this migration adopted an existing '${state.targetModule}' implementation. Reassess the target, or start a greenfield migration.`,
      );
    }
    await assertAdoptedTargetEvidence(inventory.evidence, roots, state);
  }
  assertBoolean(inventory.hasVisibleUi, "Target hasVisibleUi");
  if (
    usesUiVerification(state) &&
    inventory.hasVisibleUi !== legacy.hasVisibleUi
  ) {
    throw new Error(
      `Target hasVisibleUi must describe the migration delivery (${legacy.hasVisibleUi}), not whether UI existed before implementation.`,
    );
  }
  assertUniqueIds(
    assertArray(inventory.navigationSurfaces, "Target navigation surfaces"),
    "Target navigation surfaces",
  );
  assertUniqueIds(
    assertArray(inventory.nativeBehaviors, "Target-native behaviors"),
    "Target-native behaviors",
  );
  const components = assertArray(
    inventory.uiComponents,
    "Target UI components",
  );
  assertUniqueIds(components, "Target UI components");
  if (inventory.hasVisibleUi && components.length === 0) {
    throw new Error(
      "Visible target UI requires a component and design-system inventory.",
    );
  }
  if (
    usesUiVerification(state) &&
    !inventory.hasVisibleUi &&
    components.length > 0
  ) {
    throw new Error(
      "A non-UI migration cannot inventory user-visible target components.",
    );
  }
  for (const component of components) {
    assertNonEmpty(component.requirement, `${component.id}.requirement`);
    assertNonEmpty(component.actualSource, `${component.id}.actualSource`);
    assertBoolean(
      component.equivalentAvailable,
      `${component.id}.equivalentAvailable`,
    );
    if (component.equivalentAvailable) {
      assertNonEmpty(
        component.expectedComponent,
        `${component.id}.expectedComponent`,
      );
    }
    await assertEvidenceResolves(
      [component.evidence],
      `${component.id}.evidence`,
      roots,
    );
  }
  if (usesUiVerification(state)) {
    const mismatches = assertArray(
      inventory.uiMismatches,
      "Target UI mismatch dispositions",
    );
    assertUniqueIds(mismatches, "Target UI mismatch dispositions");
    const uiBehaviorIds = new Set(legacy.uiBehaviors.map((item) => item.id));
    const mapped = new Set();
    for (const mismatch of mismatches) {
      if (!uiBehaviorIds.has(mismatch.uiBehaviorId)) {
        throw new Error(
          `${mismatch.id}.uiBehaviorId '${mismatch.uiBehaviorId}' is not a discovered UI behavior.`,
        );
      }
      if (mapped.has(mismatch.uiBehaviorId)) {
        throw new Error(
          `UI behavior '${mismatch.uiBehaviorId}' has more than one mismatch disposition.`,
        );
      }
      mapped.add(mismatch.uiBehaviorId);
      if (!UI_MISMATCH_DISPOSITIONS.has(mismatch.disposition)) {
        throw new Error(
          `${mismatch.id}.disposition '${mismatch.disposition}' is not supported.`,
        );
      }
      assertNonEmpty(mismatch.rationale, `${mismatch.id}.rationale`);
      const evidence = assertArray(
        mismatch.evidence,
        `${mismatch.id}.evidence`,
      );
      if (evidence.length === 0) {
        throw new Error(`${mismatch.id} requires explicit mismatch evidence.`);
      }
      await assertEvidenceResolves(evidence, `${mismatch.id}.evidence`, roots);
      if (mismatch.disposition === "INTENTIONAL_DESIGN_ADAPTATION") {
        assertNonEmpty(mismatch.approval, `${mismatch.id}.approval`);
        assertNonEmpty(
          mismatch.behavioralEquivalence,
          `${mismatch.id}.behavioralEquivalence`,
        );
      }
    }
    if (
      mapped.size !== uiBehaviorIds.size ||
      [...uiBehaviorIds].some((id) => !mapped.has(id))
    ) {
      throw new Error(
        "Every discovered UI behavior requires exactly one explicit mismatch disposition.",
      );
    }
  }
  return inventory;
};

/** `src/features/<module>/` -- the one place a SHARED_PREREQUISITE may not live. */
const featureLocalPrefix = (targetModule) => `src/features/${targetModule}/`;

/** Takes an already-canonical target-relative path from `targetRelativePath`. */
const isUnderFeature = (normalized, targetModule) => {
  const prefix = featureLocalPrefix(targetModule);
  return normalized === prefix.slice(0, -1) || normalized.startsWith(prefix);
};

/**
 * The one canonical form ownership comparisons use: target-root-relative,
 * forward slashes. `changedFiles` and every evidence field already accept both
 * `src/x` and `<target-dir>/src/x`, because `resolveEvidencePath` resolves
 * against the common ancestor of the two roots -- so an ownership prefix check
 * that compares raw strings rejects a correctly-built capability over how its
 * path happened to be spelled.
 *
 * Existence-based resolution is deliberately not reused here: `targetOwner`
 * names a directory that does *not* exist yet at BUILD_BASELINE, which is the
 * whole point of a SHARED_PREREQUISITE. So the repository-relative prefix is
 * stripped by path math, and the result is still required to land inside the
 * target root -- which is what rejects `../` traversal and absolute paths.
 */
const rootRelativePath = (claim, root, siblingRoot, label, repositoryLabel) => {
  const normalized = claim.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!root) return normalized.replace(/\/+$/, "");
  let candidate = normalized.replace(/\/+$/, "");
  if (siblingRoot) {
    const prefix = path
      .relative(commonAncestor(siblingRoot, root), root)
      .replaceAll(path.sep, "/");
    if (prefix && !prefix.startsWith("..")) {
      if (candidate === prefix) candidate = "";
      else if (candidate.startsWith(`${prefix}/`)) {
        candidate = candidate.slice(prefix.length + 1);
      }
    }
  }
  const absolute = path.resolve(root, candidate);
  if (!isWithin(root, absolute)) {
    throw new Error(
      `${label} '${claim}' is outside the ${repositoryLabel} repository.`,
    );
  }
  return path.relative(root, absolute).replaceAll(path.sep, "/");
};

const targetRelativePath = (claim, roots, label) =>
  rootRelativePath(
    claim,
    roots?.targetRoot,
    roots?.legacyRoot,
    label,
    "target",
  );

const legacyRelativePath = (claim, roots, label) =>
  rootRelativePath(
    claim,
    roots?.legacyRoot,
    roots?.targetRoot,
    label,
    "legacy",
  );

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
        consumers.filter((consumer) => !converging.has(consumer)),
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
        throw new Error(
          `${row.id} names consumer(s) absent from the pinned discovery supporting census: ${absent.join(", ")}. Shared ownership must be proven by the discovery scan, not free text.`,
        );
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
 * Every legacy-side claim must land under a declared root, so the engine can
 * answer which source it belongs to. Without this the union cardinality rule
 * and every per-source coverage check are guessing, and evidence that drifted
 * outside the module boundary is indistinguishable from evidence that did not.
 */
const assertLegacyEvidenceAttributes = async (
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
    ? await readTargetBaseline(root, state)
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
    ? await validateVisualAcceptance(root, state, legacy, target)
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

// Contract 5 decision 1.2: requirementIds, scenarioIds, and traceIds are
// disjoint and separately owned. acceptanceScenarios stays authored prose.
// Format 11 adds capabilityIds as a fourth separately-owned list; a pre-11
// record has no capability matrix, so the list is absent rather than empty.
const traceLists = (record, label, state) => ({
  requirementIds: assertArray(record.requirementIds, `${label}.requirementIds`),
  scenarioIds: assertArray(record.scenarioIds, `${label}.scenarioIds`),
  traceIds: assertArray(record.traceIds, `${label}.traceIds`),
  ...(usesCapabilityOwnership(state)
    ? {
        capabilityIds: assertArray(
          record.capabilityIds,
          `${label}.capabilityIds`,
        ),
      }
    : {}),
});

const assertCoversPlanned = (planned, actual, label, verb) => {
  for (const field of Object.keys(planned)) {
    const covered = new Set(actual[field]);
    for (const id of planned[field]) {
      if (!covered.has(id)) {
        throw new Error(`${label} did not ${verb} '${id}' from ${field}.`);
      }
    }
  }
};

const validatePlan = async (root, state, roots) => {
  const baseline = await validateBaseline(root, { roots, state });
  const index = assertPlainObject(
    await readJson(path.join(root, initialArtifacts.slices), "Slice index"),
    "Slice index",
  );
  const slices = assertArray(index.slices, "Slices");
  if (slices.length === 0) throw new Error("Plan requires at least one slice.");
  const sliceIds = assertUniqueIds(slices, "Slices");
  const authority = state?.requirementsAuthority;
  for (const slice of slices) {
    assertSafeName(slice.id.toLowerCase(), "slice id");
    const lists = traceLists(slice, slice.id, state);
    if (lists.traceIds.length === 0) {
      throw new Error(
        `${slice.id} must own at least one baseline row in traceIds.`,
      );
    }
    if (
      assertArray(slice.acceptanceScenarios, `${slice.id}.acceptanceScenarios`)
        .length === 0
    ) {
      throw new Error(`${slice.id} requires acceptance scenarios.`);
    }
    if (authority) {
      for (const [field, allowed] of [
        ["requirementIds", authority.requirementIds],
        ["scenarioIds", authority.scenarioIds],
      ]) {
        for (const id of lists[field]) {
          if (!allowed.includes(id)) {
            throw new Error(
              `${slice.id}.${field} references '${id}', which the OpenSpec authority does not define.`,
            );
          }
        }
      }
    }
  }
  const required = [
    ...baseline.behaviorRows
      .filter((row) => !TERMINAL_PARITY.has(row.verificationStatus))
      .map((row) => row.id),
    ...baseline.routeRows
      .filter((row) => row.verificationStatus !== "VERIFIED")
      .map((row) => row.id),
    // A target-native row that is not yet PRESERVED still needs implementation
    // or verification, so it belongs to exactly one slice like any other row.
    ...baseline.nativeRows
      .filter((row) => row.verificationStatus !== "PRESERVED")
      .map((row) => row.id),
    ...baseline.designRows
      .filter(
        (row) =>
          !TERMINAL_DESIGN_SYSTEM.has(row.status) ||
          row.verificationStatus !== "VERIFIED",
      )
      .map((row) => row.id),
  ];
  const ownership = new Map();
  for (const slice of slices) {
    for (const traceId of slice.traceIds) {
      if (ownership.has(traceId)) {
        throw new Error(
          `Baseline row '${traceId}' is assigned to multiple slices.`,
        );
      }
      ownership.set(traceId, slice.id);
    }
  }
  for (const traceId of required) {
    if (!ownership.has(traceId)) {
      throw new Error(
        `Plan does not assign baseline row '${traceId}' to a slice.`,
      );
    }
  }
  if (usesUiVerification(state)) {
    const mismatchByBehavior = new Map(
      baseline.target.uiMismatches.map((row) => [row.uiBehaviorId, row]),
    );
    for (const uiBehavior of baseline.legacy.uiBehaviors) {
      if (
        !uiBehaviorIsRequired(uiBehavior, mismatchByBehavior.get(uiBehavior.id))
      ) {
        continue;
      }
      const parityRow = baseline.behaviorRows.find(
        (row) => row.behaviorId === uiBehavior.behaviorId,
      );
      const ownerId = parityRow && ownership.get(parityRow.id);
      const owner = slices.find((slice) => slice.id === ownerId);
      if (!owner) {
        throw new Error(
          `Required UI behavior '${uiBehavior.id}' does not trace through a behavior-parity row to a slice.`,
        );
      }
      for (const [field, ids] of [
        ["requirementIds", uiBehavior.requirementIds],
        ["scenarioIds", uiBehavior.scenarioIds],
      ]) {
        for (const id of ids) {
          if (!owner[field].includes(id)) {
            throw new Error(
              `Required UI behavior '${uiBehavior.id}' traces to ${owner.id}, but ${owner.id}.${field} omits '${id}'.`,
            );
          }
        }
      }
    }
  }
  await assertCapabilityPlan(slices, baseline.capabilityRows, state, roots);
  return {
    index,
    slices,
    sliceIds,
    capabilityRows: baseline.capabilityRows,
  };
};

/**
 * Format 11. PLAN is where a proven shared prerequisite stops being an
 * observation and becomes a scheduled slice. A SHARED_PREREQUISITE does not
 * have to be *implemented* before PLAN closes -- it has to be deterministically
 * ordered ahead of the feature work that depends on it.
 *
 * Ordering rides on declaration order rather than a new scheduler:
 * `pendingSlices` is derived from `index.slices` order, so requiring every
 * dependency to be declared earlier makes declaration order a valid topological
 * order and makes cycles structurally impossible.
 */
const assertCapabilityPlan = async (slices, capabilityRows, state, roots) => {
  if (!usesCapabilityOwnership(state)) return;
  const declaredAt = new Map(slices.map((slice, index) => [slice.id, index]));
  for (const slice of slices) {
    await assertEvidenceResolves(
      assertArray(
        slice.architectureAuthorities,
        `${slice.id}.architectureAuthorities`,
      ),
      `${slice.id}.architectureAuthorities`,
      roots,
    );
    assertArray(slice.targetPaths, `${slice.id}.targetPaths`);
    for (const dependency of assertArray(
      slice.dependencies,
      `${slice.id}.dependencies`,
    )) {
      if (dependency === slice.id) {
        throw new Error(`${slice.id}.dependencies references itself.`);
      }
      if (!declaredAt.has(dependency)) {
        throw new Error(
          `${slice.id}.dependencies references unknown slice '${dependency}'.`,
        );
      }
      if (declaredAt.get(dependency) > declaredAt.get(slice.id)) {
        throw new Error(
          `${slice.id} depends on '${dependency}', which is declared after it. Slices execute in declaration order, so a dependency must be declared first.`,
        );
      }
    }
  }

  const rowsById = new Map(capabilityRows.map((row) => [row.id, row]));
  const owner = new Map();
  for (const slice of slices) {
    for (const capabilityId of slice.capabilityIds) {
      if (!rowsById.has(capabilityId)) {
        throw new Error(
          `${slice.id}.capabilityIds references '${capabilityId}', which the capability ownership matrix does not define.`,
        );
      }
      if (owner.has(capabilityId)) {
        throw new Error(
          `Capability '${capabilityId}' is assigned to multiple slices.`,
        );
      }
      owner.set(capabilityId, slice.id);
    }
  }
  for (const row of capabilityRows) {
    if (!NON_TERMINAL_CAPABILITIES.has(row.classification)) continue;
    if (!owner.has(row.id)) {
      throw new Error(
        `Plan does not assign capability '${row.id}' (${row.classification}) to a slice. A shared prerequisite must be planned before the feature slices that depend on it.`,
      );
    }
  }

  // Any slice building a proven shared capability is a prerequisite for the
  // rest of the plan. Blunt on purpose: the capability was discovered as a
  // dependency of the module being migrated, so the feature work needs it.
  const prerequisites = slices.filter((slice) =>
    slice.capabilityIds.some(
      (id) => rowsById.get(id)?.classification === "SHARED_PREREQUISITE",
    ),
  );
  for (const slice of slices) {
    if (prerequisites.includes(slice)) continue;
    for (const prerequisite of prerequisites) {
      if (!slice.dependencies.includes(prerequisite.id)) {
        throw new Error(
          `${slice.id} must declare '${prerequisite.id}' in dependencies: it builds a SHARED_PREREQUISITE capability this slice relies on.`,
        );
      }
    }
  }
};

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

export const delegatedChangedFilesSatisfiedByChild = (
  state,
  capabilityIds,
  capabilityRows,
) =>
  usesArtifactDelegation(state) &&
  capabilityIds.length > 0 &&
  capabilityIds.every((capabilityId) => {
    const row = capabilityRows.find(
      (candidate) => candidate.id === capabilityId,
    );
    return (
      row?.classification === "SHARED_PREREQUISITE" &&
      row.artifactMigration !== undefined
    );
  });

/**
 * The reopen attempt that currently governs `sliceId`, or null when the slice
 * is not reopened. Newest attempt wins: a second reopen supersedes the first.
 */
const governingReopen = async (root, sliceId) => {
  const events = await readHistoryEvents(root);
  const reopens = events.filter(
    (event) =>
      event.event === "COMPLETE_REOPENED" &&
      Array.isArray(event.slices) &&
      event.slices.includes(sliceId),
  );
  if (reopens.length === 0) return null;
  return reopens[reopens.length - 1];
};

/**
 * Proves the preserved evidence of a reopen attempt is exactly the bytes the
 * reopen pinned, and returns the record. Tamper is never a soft signal: a
 * preserved tree that no longer hashes to its pin cannot anchor anything.
 */
const verifiedReopenRecord = async (root, attempt, sliceId, state) => {
  const directory = `${REOPEN_ROOT}/${attempt}`;
  const recordRelative = `${directory}/record.json`;
  const absolute = path.join(root, recordRelative);
  if (!(await fileExists(absolute))) {
    throw new Error(
      `${sliceId} was reopened as attempt ${attempt} but ${recordRelative} is missing. The reopen provenance a committed slice is proven against cannot be reconstructed; nothing is accepted on trust.`,
    );
  }
  const bytes = await readFile(absolute);
  const record = assertPlainObject(
    JSON.parse(bytes.toString("utf8")),
    recordRelative,
  );
  const preserved = assertPlainObject(record.preserved, `${recordRelative}.preserved`);
  // The record's own pin is added to the pin set *after* its bytes are
  // serialized, so it lives in the integrity-sealed state, never inside the
  // file. That is the stronger place to check it from: the record cannot
  // restate its own hash, and the state it is checked against is itself sealed.
  const selfPin = state?.artifactHashes?.[recordRelative];
  if (typeof selfPin !== "string" || !selfPin) {
    throw new Error(
      `${recordRelative} is not pinned by the migration state, so the reopen provenance ${sliceId}'s committed ownership rests on cannot be trusted. Nothing is accepted on trust.`,
    );
  }
  if (!(await fileIdentityMatches(selfPin, absolute))) {
    throw new Error(
      `${recordRelative} no longer matches the hash the migration state pinned. Reopen provenance is tamper-evident; a committed ownership claim anchored on an altered record is refused.`,
    );
  }
  for (const [relative, pin] of Object.entries(preserved)) {
    if (relative === recordRelative) continue;
    const preservedPath = path.join(root, relative);
    if (!(await fileExists(preservedPath))) {
      throw new Error(
        `${recordRelative} pins preserved evidence '${relative}', which is missing. The reopened slice's superseded PASS is the anchor's proof and must survive for life.`,
      );
    }
    if (!(await fileIdentityMatches(pin, preservedPath))) {
      throw new Error(
        `Preserved reopen evidence '${relative}' no longer matches the hash ${recordRelative} pinned. Reopen provenance is tamper-evident; a committed ownership claim anchored on altered evidence is refused.`,
      );
    }
  }
  return record;
};

/**
 * The anchor commit a reopened slice's committed work is proven against.
 *
 * New records carry `targetAnchor` outright. Records written before the field
 * existed -- including migrations reopened in the field -- resolve it from the
 * pinned preserved evidence: the unique commit that *introduced* those exact
 * PASS bytes. Merely containing an unchanged blob is not origin, and anything
 * short of exactly one defensible origin fails closed rather than guessing.
 */
const resolveReopenAnchor = async (root, record, sliceId, roots, attempt) => {
  if (typeof record.targetAnchor === "string" && record.targetAnchor) {
    return { revision: record.targetAnchor, resolvedFrom: "RECORD" };
  }
  const recordRelative = `${REOPEN_ROOT}/${attempt}/record.json`;
  const evidenceRelative = `${REOPEN_ROOT}/${attempt}/evidence/${sliceId}/result.json`;
  const pin = record.preserved?.[evidenceRelative];
  if (typeof pin !== "string" || !pin) {
    throw new Error(
      `${recordRelative} carries no targetAnchor and does not pin '${evidenceRelative}', so the committed state ${sliceId} was proven against cannot be established. Reopen provenance is required before a committed ownership claim is accepted.`,
    );
  }
  // The preserved copy is a copy; the pinned bytes originate at the slice's own
  // evidence path, which is what history records.
  const originRelative = repoRelative(
    roots.targetRoot,
    path.join(root, `evidence/${sliceId}/result.json`),
  );
  const origins = await commitsIntroducingBlob(
    roots.targetRoot,
    originRelative,
    pin,
  );
  if (origins.length === 0) {
    throw new Error(
      `${recordRelative} carries no targetAnchor and the preserved PASS for ${sliceId} matches no commit in the target repository's history, so no anchor can be established. The reopened slice's committed ownership cannot be proven and is refused.`,
    );
  }
  if (origins.length > 1) {
    throw new Error(
      `${recordRelative} carries no targetAnchor and the preserved PASS for ${sliceId} originates in ${origins.length} distinct commits (${origins.join(", ")}), so no unique anchor is defensible. Re-reopen the slice to record an explicit anchor rather than accepting an ambiguous one.`,
    );
  }
  return { revision: origins[0], resolvedFrom: "PRESERVED_EVIDENCE" };
};

/**
 * A path under the target root in the form Git resolves against it. The `./`
 * prefix is load-bearing: `git show <rev>:<path>` reads a bare path from the
 * repository root, which is not always the target root, whereas `:./<path>`
 * resolves relative to the `-C` directory.
 */
const repoRelative = (targetRoot, absolute) =>
  `./${path.relative(targetRoot, absolute).replaceAll(path.sep, "/")}`;

/**
 * Committed ownership for a reopened slice: the claims the anchored slice
 * record already made, plus which of them history has moved on from.
 *
 * Returns null when the slice is not reopened, so the live-diff rule stays the
 * only rule for an ordinary active slice.
 */
// Resolved once per slice per anchor state: the resolver shells out to Git
// several times, and both the implementation gate and the verification gate
// need the same answer within one command.
const anchoredOwnershipCache = new Map();

const anchoredReopenOwnership = async (root, sliceId, state, roots) => {
  if (!roots?.targetRoot) return null;
  const head = await headRevision(roots.targetRoot);
  const key = `${root} ${sliceId} ${head}`;
  if (!anchoredOwnershipCache.has(key)) {
    anchoredOwnershipCache.set(
      key,
      resolveAnchoredOwnership(root, sliceId, roots, head, state),
    );
  }
  const resolved = await anchoredOwnershipCache.get(key);
  // Drift is re-derived by whichever gate is running, never carried over.
  if (resolved) resolved.drift = [];
  return resolved;
};

const resolveAnchoredOwnership = async (root, sliceId, roots, head, state) => {
  const reopen = await governingReopen(root, sliceId);
  if (!reopen) return null;
  const attempt = reopen.attempt;
  const record = await verifiedReopenRecord(root, attempt, sliceId, state);
  const anchor = await resolveReopenAnchor(root, record, sliceId, roots, attempt);
  if (!(await isAncestorCommit(roots.targetRoot, anchor.revision, head))) {
    throw new Error(
      `The reopen anchor '${anchor.revision}' for ${sliceId} is not reachable from the target repository's HEAD. History was rewritten or the anchor belongs to another lineage; a committed ownership claim is refused.`,
    );
  }
  // What the slice record claimed in the reopened COMPLETE state is the only
  // committed ownership that exists, and reading it from the working tree on
  // trust would let a claim added after the fact grant itself provenance.
  //
  // The migration record is not part of the target's committed history -- this
  // tool keeps it uncommitted until FINALIZE -- so the anchor commit cannot
  // supply it. The pin does: `slices/<id>.json` was hashed into
  // `artifactHashes` at COMPLETE and a reopen deliberately releases only the
  // slice's evidence and the FINALIZE artifacts, so that pin still describes
  // the record exactly as the reopened COMPLETE recorded it.
  const sliceRelative = `slices/${sliceId}.json`;
  const slicePin = state?.artifactHashes?.[sliceRelative];
  if (typeof slicePin !== "string" || !slicePin) {
    throw new Error(
      `${sliceId} was reopened but ${sliceRelative} is not pinned by the migration state, so what the slice owned in the reopened COMPLETE state cannot be established. The committed ownership claim is refused.`,
    );
  }
  const slicePath = path.join(root, sliceRelative);
  const anchoredBytes = await readFile(slicePath);
  if (!(await fileIdentityMatches(slicePin, slicePath))) {
    throw new Error(
      `${sliceRelative} no longer matches the hash the migration state pinned for the reopened COMPLETE state. A reopened slice may not rewrite what it owned and then claim the rewrite as committed provenance.`,
    );
  }
  let anchoredRecord;
  try {
    anchoredRecord = JSON.parse(anchoredBytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${sliceRelative} is not readable JSON (${error.message}), so ${sliceId}'s committed ownership cannot be established.`,
    );
  }
  const claims = new Set();
  for (const changed of anchoredRecord?.changedFiles ?? []) {
    if (typeof changed !== "string" || !changed.trim()) continue;
    claims.add(changed.trim().split(/\s+/)[0].replaceAll("\\", "/"));
  }
  return { attempt, anchor, head, claims, record };
};

const validateImplementedSlice = async (
  root,
  sliceId,
  state,
  roots,
  // An amendment validates the record it is about to write, not the one on
  // disk: the whole point is to refuse before the prior bytes are replaced.
  recordOverride,
) => {
  const { slices, capabilityRows } = await validatePlan(root, state, roots);
  const planned = slices.find((slice) => slice.id === sliceId);
  if (!planned) throw new Error(`Unknown planned slice '${sliceId}'.`);
  const record = assertPlainObject(
    recordOverride ??
      (await readJson(
        path.join(root, `slices/${sliceId}.json`),
        `Slice ${sliceId}`,
      )),
    `Slice ${sliceId}`,
  );
  if (record.id !== sliceId || record.implementationStatus !== "COMPLETE") {
    throw new Error(`${sliceId} implementation must be COMPLETE.`);
  }
  assertCoversPlanned(
    traceLists(planned, sliceId, state),
    traceLists(record, sliceId, state),
    sliceId,
    "implement",
  );
  const changedFiles = assertArray(
    record.changedFiles,
    `${sliceId}.changedFiles`,
  );
  const delegatedOnly = delegatedChangedFilesSatisfiedByChild(
    state,
    record.capabilityIds,
    capabilityRows,
  );
  // A slice could never be verification-only: proving that already-correct,
  // already-committed code still holds required touching a file. Derived, not
  // declared, exactly like `delegatedOnly` -- no new `kind` field and no third
  // thing to keep consistent with the other two.
  // isBrownfield already implies usesMultiSource -- no separate check needed.
  const verificationOnly =
    isBrownfield(state) &&
    changedFiles.length === 0 &&
    Array.isArray(record.commandResults) &&
    record.commandResults.length > 0;
  if (verificationOnly) {
    await assertCommandResults(
      record.commandResults,
      `${sliceId}.commandResults`,
      roots,
    );
  }
  if (changedFiles.length === 0 && !delegatedOnly && !verificationOnly) {
    throw new Error(
      `${sliceId} must record its changed files, or the command results that re-prove it without any.`,
    );
  }
  // A declared changed file must be a real path inside the target repository:
  // the implementation gate previously accepted any nonempty string, so a slice
  // could claim work it never did, or claim it outside the migration's target.
  //
  // P1-7: existence alone still let a slice claim files it never actually
  // touched. `dirty` is the target repository's real uncommitted diff
  // (reusing the same `dirtyManifest` this tool already trusts for P1-6);
  // every declared changed file must be part of it.
  // The live uncommitted diff is the ownership proof for an ordinary active
  // slice. It cannot be the only one after a COMPLETE reopen: the slice being
  // reopened was finalized, so its legitimate implementation is already
  // committed and is correctly absent from the current diff. A reopened slice
  // therefore proves ownership against its reopen anchor as well -- the
  // committed target state whose preserved PASS is being reopened.
  const anchored = await anchoredReopenOwnership(root, sliceId, state, roots);
  const dirty = roots?.targetRoot
    ? await dirtyManifest(roots.targetRoot)
    : null;
  const dirtyPaths = dirty
    ? new Set(dirty.entries.map((entry) => entry.path))
    : null;
  // Brownfield: the target repository was already dirty when the record was
  // created, and the current diff cannot tell those edits apart from this
  // migration's. The pinned baseline can, per path and per byte, so a file that
  // was already dirty and still reads the same was not changed by this slice.
  const baseline =
    roots?.targetRoot && changedFiles.length > 0
      ? await readTargetBaseline(root, state)
      : null;
  const changedSinceBaseline = baseline
    ? await targetBaselineDrift(roots.targetRoot, baseline)
    : null;
  const reusesExistingUiImplementation =
    usesUiVerification(state) &&
    ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE", "COMPLETE"].includes(
      state.currentStep,
    ) &&
    Boolean(state.artifacts.uiRemediation);
  // The canonical target-relative form of every claim, reused below so an
  // ownership check compares the same shape whichever accepted form was authored.
  const changedTargetPaths = [];
  for (const changed of changedFiles) {
    assertNonEmpty(changed, `${sliceId}.changedFiles entry`);
    if (!roots?.targetRoot) continue;
    const claim = changed.trim().split(/\s+/)[0];
    const direct = path.resolve(roots.targetRoot, claim);
    const resolved =
      isWithin(roots.targetRoot, direct) && (await fileExists(direct))
        ? direct
        : await resolveEvidencePath(claim, roots);
    if (!resolved) {
      throw new Error(
        `${sliceId}.changedFiles lists '${changed}', which does not exist. Record the files the slice actually changed.`,
      );
    }
    if (!isWithin(roots.targetRoot, resolved)) {
      throw new Error(
        `${sliceId}.changedFiles lists '${changed}', which is outside the target repository. A slice may only change target files.`,
      );
    }
    const relative = path
      .relative(roots.targetRoot, resolved)
      .replaceAll(path.sep, "/");
    changedTargetPaths.push(relative);
    // Ownership: a live claim in the current diff, or an anchored claim the
    // committed state already carried. Anchored ownership additionally proves
    // the path existed at the anchor -- a record may not claim provenance for
    // a file the anchored commit never had.
    const liveClaim = dirtyPaths ? dirtyPaths.has(relative) : false;
    const anchoredClaim = Boolean(anchored?.claims.has(relative));
    if (anchoredClaim && !liveClaim) {
      const atAnchor = await fileAtRevision(
        roots.targetRoot,
        anchored.anchor.revision,
        `./${relative}`,
      );
      if (!atAnchor) {
        throw new Error(
          `${sliceId}.changedFiles lists '${changed}', which does not exist at the reopen anchor '${anchored.anchor.revision}'. A reopened slice may only claim files the anchored commit actually carried.`,
        );
      }
      // Historical ownership is not current validity. A path history moved on
      // from after the anchor keeps its claim, but the reopened slice never
      // absorbs authorship of those later commits, and the PASS it is working
      // toward has to rest on evidence bound to the *current* HEAD.
      const after = await commitsTouchingSince(
        roots.targetRoot,
        anchored.anchor.revision,
        `./${relative}`,
      );
      if (after.length > 0) {
        (anchored.drift ??= []).push({ path: relative, commits: after });
      }
    }
    if (
      dirtyPaths &&
      !reusesExistingUiImplementation &&
      !liveClaim &&
      !anchoredClaim
    ) {
      throw new Error(
        anchored
          ? `${sliceId}.changedFiles lists '${changed}', which is neither part of the target repository's current uncommitted diff nor claimed by the slice record at its reopen anchor '${anchored.anchor.revision}'. A reopened slice may only claim work it owns live or owned in the anchored commit.`
          : `${sliceId}.changedFiles lists '${changed}', which is not part of the target repository's current uncommitted diff. Record only files the slice actually modified.`,
      );
    }
    // The baseline rule answers "is this pre-existing work", which an anchored
    // committed claim has already answered from history.
    if (changedSinceBaseline && !anchoredClaim && !changedSinceBaseline(relative)) {
      throw new Error(
        `${sliceId}.changedFiles lists '${changed}', which reads exactly as it did when the target baseline was pinned. Pre-existing work is not this migration's work and may not be claimed as slice work.`,
      );
    }
  }
  // Format 11. Without this a slice can claim a SHARED_PREREQUISITE at PLAN and
  // still build it inside the feature: PLAN only proves the capability was
  // scheduled, this proves it landed where the matrix said it would.
  if (usesCapabilityOwnership(state) && roots?.targetRoot) {
    await assertArtifactPrerequisites(state, roots, {
      capabilityRows,
      slices,
    });
    for (const capabilityId of record.capabilityIds) {
      const row = capabilityRows.find(
        (candidate) => candidate.id === capabilityId,
      );
      if (row?.classification !== "SHARED_PREREQUISITE") continue;
      if (usesArtifactDelegation(state) && row.artifactMigration) continue;
      const owner = targetRelativePath(
        row.targetOwner,
        roots,
        `${capabilityId}.targetOwner`,
      );
      if (
        !changedTargetPaths.some(
          (claim) => claim === owner || claim.startsWith(`${owner}/`),
        )
      ) {
        throw new Error(
          `${sliceId} owns SHARED_PREREQUISITE '${capabilityId}' but changed no file under '${row.targetOwner}'. A shared capability must be built in its declared owner, not inside the feature.`,
        );
      }
    }
  }
  return record;
};

/**
 * The two spellings of one composition. `current` composes file identities;
 * `legacy` composes the raw hashes evidence recorded before tagged identities
 * existed. Both are computed from the same files in the same order, so a
 * record bound to either is still bound to these bytes.
 */
/**
 * The target file one `changedFiles` claim names, or null. Extracted so the
 * amendment resolves a claim exactly as the implementation digest does -- two
 * spellings of "which file is this" is how an amended record ends up disagreeing
 * with the digest that binds it.
 */
const resolveChangedFile = async (changed, roots) => {
  const claim = changed.trim().split(/\s+/)[0];
  const direct = path.resolve(roots.targetRoot, claim);
  const resolved =
    isWithin(roots.targetRoot, direct) && (await fileExists(direct))
      ? direct
      : await resolveEvidencePath(claim, roots);
  return resolved && isWithin(roots.targetRoot, resolved) ? resolved : null;
};

const implementationDigests = async (record, roots) => {
  const identities = [];
  const legacy = [];
  for (const changed of record.changedFiles) {
    const resolved = await resolveChangedFile(changed, roots);
    if (!resolved) {
      throw new Error(`Cannot bind UI evidence to changed file '${changed}'.`);
    }
    const relative = path
      .relative(roots.targetRoot, resolved)
      .replaceAll(path.sep, "/");
    identities.push([relative, await fileIdentity(resolved)]);
    legacy.push([relative, await hashFile(resolved)]);
  }
  const compose = (rows) =>
    `sha256:${hashContent(JSON.stringify(rows.sort(([a], [b]) => a.localeCompare(b))))}`;
  return { current: compose(identities), legacy: compose(legacy) };
};

const validateUiRuntimeEvidence = async ({
  evidence,
  implementation,
  baseline,
  sliceId,
  state,
  roots,
  root,
}) => {
  if (!usesUiVerification(state) || !baseline.legacy.hasVisibleUi) return [];
  if (!usesRequiredObservations(state)) {
    throw new Error(
      // No CLI flag is named here any more. At or above the upgrade floor the
      // engine's own FORMAT_UPGRADE target owns the transition and the normal
      // command reports the required input, so this states the frozen fact and
      // leaves the dispatch to the one place that decides it.
      `Visible UI needs format-${REQUIRED_OBSERVATIONS_FORMAT} requiredObservations before VERIFY_SLICES or FINALIZE can PASS; this record is at format ${state.formatVersion}. Rerun '/start-migration ${state.migrationId}' and supply the input its FORMAT UPGRADE REQUIRED report names. TARGET proof cannot supply the contract.`,
    );
  }
  const parityIds = new Set(implementation.traceIds);
  const mismatchByBehavior = new Map(
    baseline.target.uiMismatches.map((row) => [row.uiBehaviorId, row]),
  );
  const required = baseline.legacy.uiBehaviors.filter((uiBehavior) => {
    const parityRow = baseline.behaviorRows.find(
      (row) => row.behaviorId === uiBehavior.behaviorId,
    );
    return (
      parityRow &&
      parityIds.has(parityRow.id) &&
      uiBehaviorIsRequired(uiBehavior, mismatchByBehavior.get(uiBehavior.id))
    );
  });
  const records = assertArray(evidence.uiEvidence, `${sliceId} UI evidence`);
  const limitations = assertArray(
    evidence.uiEvidenceLimitations,
    `${sliceId} UI evidence limitations`,
  );
  for (const [index, limitation] of limitations.entries()) {
    const label = `${sliceId} UI evidence limitations[${index}]`;
    assertPlainObject(limitation, label);
    // A limitation states *why* the runtime could not answer. It is not a
    // waiver: the required-state sweep below still refuses to pass.
    if (limitation.availability !== "NOT_AVAILABLE") {
      throw new Error(`${label}.availability must be 'NOT_AVAILABLE'.`);
    }
    assertNonEmpty(limitation.uiBehaviorId, `${label}.uiBehaviorId`);
    assertNonEmpty(limitation.state, `${label}.state`);
    assertNonEmpty(limitation.reason, `${label}.reason`);
    assertNoUiSecret(limitation, label);
  }
  const implementationBinding = await implementationDigests(
    implementation,
    roots,
  );
  // Screenshot budget: one capture per observed state, never a second copy of
  // the same picture. Bounded by the contract itself, not by a magic number.
  const screenshotSlots = new Set();
  const screenshotHashes = new Set();
  const visualComparison = [];
  let baselineViewport = null;
  const exercised = new Set();
  const satisfiedPostActions = new Set();
  for (const [index, record] of records.entries()) {
    const label = `${sliceId} UI evidence[${index}]`;
    assertPlainObject(record, label);
    assertNoUiSecret(record, label);
    if (record.provider !== "playwright") {
      throw new Error(`${label}.provider must be 'playwright'.`);
    }
    const origin = record.origin ?? "TARGET";
    if (origin !== "LEGACY" && origin !== "TARGET") {
      throw new Error(`${label}.origin must be 'LEGACY' or 'TARGET'.`);
    }
    assertNonEmpty(record.producer, `${label}.producer`);
    assertNonEmpty(record.environment, `${label}.environment`);
    assertNonEmpty(record.route, `${label}.route`);
    assertIsoTimestamp(record.executedAt, `${label}.executedAt`);
    if (record.result !== "PASS") {
      throw new Error(`${label}.result must be PASS.`);
    }
    if (!UI_RUNTIME_STATES.has(record.state)) {
      throw new Error(`${label}.state '${record.state}' is not supported.`);
    }
    const uiBehavior = required.find((item) => item.id === record.uiBehaviorId);
    if (!uiBehavior || !uiBehavior.runtimeStates.includes(record.state)) {
      throw new Error(
        `${label} does not name a required state for UI behavior '${record.uiBehaviorId}'.`,
      );
    }
    const viewport = assertPlainObject(record.viewport, `${label}.viewport`);
    for (const axis of ["width", "height"]) {
      if (!Number.isInteger(viewport[axis]) || viewport[axis] <= 0) {
        throw new Error(
          `${label}.viewport.${axis} must be a positive integer.`,
        );
      }
    }
    // Format 17: a Figma-backed TARGET state is accepted by the engine's own
    // comparison, never by the row's authored `result`.
    const visualRow =
      origin === "TARGET"
        ? baseline.visualRows?.find(
            (row) =>
              row.uiBehaviorId === record.uiBehaviorId &&
              row.state === record.state,
          )
        : undefined;
    if (visualRow) {
      await assertVisualAcceptance({
        record,
        visualRow,
        label,
        roots,
        authority: visualAuthorityOf(state),
      });
    }
    const viewportKey = `${viewport.width}x${viewport.height}`;
    baselineViewport ??= viewportKey;
    if (
      viewportKey !== baselineViewport &&
      uiBehavior.kind !== "RESPONSIVE" &&
      !UI_VIEWPORT_STATES.has(record.state)
    ) {
      throw new Error(
        `${label}.viewport '${viewportKey}' differs from the slice viewport '${baselineViewport}'. Capture a second viewport only where responsive behavior is the requirement.`,
      );
    }
    const declared = new Map(
      (uiBehavior.interactions ?? []).map((item) => [item.id, item]),
    );
    for (const [position, interaction] of assertArray(
      record.interactions ?? [],
      `${label}.interactions`,
    ).entries()) {
      const item = `${label}.interactions[${position}]`;
      assertPlainObject(interaction, item);
      const contract = declared.get(interaction.id);
      if (!contract) {
        throw new Error(
          `${item}.id '${interaction.id}' is not an interaction '${uiBehavior.id}' declares.`,
        );
      }
      assertNonEmpty(interaction.expected, `${item}.expected`);
      assertNonEmpty(interaction.actual, `${item}.actual`);
      if (interaction.expected !== contract.expected) {
        throw new Error(
          `${item}.expected does not match the discovered contract for '${interaction.id}'.`,
        );
      }
      if (interaction.outcome !== "PASS") {
        throw new Error(
          `${item}.outcome must be PASS inside a PASS record; record the failure as a limitation instead.`,
        );
      }
      if (origin === "TARGET")
        exercised.add(`${uiBehavior.id}::${interaction.id}`);
    }
    const binding = assertPlainObject(record.boundTo, `${label}.boundTo`);
    const expectedUiContractDigest = `sha256:${hashContent(
      JSON.stringify({
        uiBehavior,
        mismatch: mismatchByBehavior.get(uiBehavior.id),
      }),
    )}`;
    for (const [field, expected] of Object.entries({
      target: state.targetModule,
      requirementsDigest: state.requirementsAuthority.digest,
      dataSourceMode: state.dataSourceMode,
      sliceId,
      // Legacy runtime is observed before the target exists, so binding it to
      // the target implementation would stale it on every slice edit.
      // A record written before tagged identities existed is bound to the raw
      // composition; when that is what it recorded and the files still hash to
      // it, that recorded spelling is the comparison projection. Otherwise the
      // EOL-stable composition is.
      ...(origin === "TARGET"
        ? {
            implementationDigest:
              binding.implementationDigest === implementationBinding.legacy
                ? implementationBinding.legacy
                : implementationBinding.current,
          }
        : {}),
      // Only the target (visual) evidence is design-dependent, and only when a
      // visual authority is pinned. Binding the canonical authority digest here
      // -- and nowhere in the seven final gates -- means a changed authority
      // forces re-verification of the visual rows alone, never functional parity.
      ...(origin === "TARGET" && visualAuthorityOf(state)
        ? {
            [visualAuthorityOf(state).boundToDigestField]:
              state.artifactHashes[visualAuthorityOf(state).contextFile],
          }
        : {}),
      uiContractDigest: expectedUiContractDigest,
    })) {
      if (binding[field] !== expected) {
        throw new Error(
          `${label}.boundTo.${field} is stale: recorded '${binding[field]}', current '${expected}'.`,
        );
      }
    }
    assertNonEmpty(record.reference, `${label}.reference`);
    if (!isContentIdentity(record.hash)) {
      throw new Error(`${label}.hash must be a SHA-256 digest.`);
    }
    let targetControls;
    if (origin === "TARGET") {
      assertTargetEvidencePath(record.reference, `${label}.reference`);
      assertCaptureRole(record.capture, TARGET_VERIFICATION_ROLE, label);
    }
    const proofPath = await assertEvidenceReference(
      { reference: record.reference, hash: record.hash },
      label,
      roots,
      { require: true },
    );
    // A hash match only proves the bytes are unchanged, not that they observe
    // a UI. TARGET PASS rows must reference structured Playwright proof whose
    // predicates the engine evaluates itself; authored outcomes are ignored.
    if (origin === "TARGET") {
      const proof = assertPlainObject(
        await readJson(proofPath, `${label}.reference`),
        `${label}.reference`,
      );
      if (proof.proofFormat !== UI_PROOF_FORMAT) {
        throw new Error(
          `${label}.reference is not '${UI_PROOF_FORMAT}' structured proof (proofFormat '${proof.proofFormat}'). A hash-valid file is not a UI observation.`,
        );
      }
      const parityRow = baseline.behaviorRows.find(
        (row) => row.behaviorId === uiBehavior.behaviorId,
      );
      for (const [field, expected] of Object.entries({
        sliceId,
        uiBehaviorId: record.uiBehaviorId,
        state: record.state,
        traceId: parityRow.id,
      })) {
        if (proof[field] !== expected) {
          throw new Error(
            `${label} proof.${field} is '${proof[field]}', expected '${expected}'.`,
          );
        }
      }
      const proofScenarios = assertArray(
        proof.scenarioIds,
        `${label} proof.scenarioIds`,
      );
      const missingScenario = uiBehavior.scenarioIds.find(
        (id) => !proofScenarios.includes(id),
      );
      if (missingScenario) {
        throw new Error(
          `${label} proof.scenarioIds omits '${missingScenario}' of UI behavior '${uiBehavior.id}'.`,
        );
      }
      const assertObservation = (value, at) => {
        const observation = assertPlainObject(value, at);
        assertNonEmpty(observation.url, `${at}.url`);
        const controls = assertArray(observation.controls, `${at}.controls`);
        if (controls.length === 0) {
          throw new Error(`${at}.controls must observe at least one control.`);
        }
        for (const [position, control] of controls.entries()) {
          const where = `${at}.controls[${position}]`;
          assertPlainObject(control, where);
          assertNonEmpty(control.role, `${where}.role`);
          assertNonEmpty(control.name, `${where}.name`);
          assertNonEmpty(control.state, `${where}.state`);
          const assertions = assertArray(
            control.assertions,
            `${where}.assertions`,
          );
          if (assertions.length === 0) {
            throw new Error(`${where}.assertions must not be empty.`);
          }
          for (const [n, assertion] of assertions.entries()) {
            assertPlainObject(assertion, `${where}.assertions[${n}]`);
            const observed = {
              presence: control.present,
              visibility: control.visible,
              text: control.text,
              value: control.value,
              count: control.count,
              url: observation.url,
            };
            if (!Object.hasOwn(observed, assertion.predicate)) {
              throw new Error(
                `${where}.assertions[${n}].predicate '${assertion.predicate}' is not one of ${Object.keys(observed).join(", ")}.`,
              );
            }
            if (
              assertion.expected === undefined ||
              observed[assertion.predicate] !== assertion.expected
            ) {
              throw new Error(
                `${where}.assertions[${n}] ${assertion.predicate} failed: expected '${assertion.expected}', observed '${observed[assertion.predicate]}'.`,
              );
            }
          }
        }
        return controls;
      };
      const controls = assertObservation(
        proof.observation,
        `${label} proof.observation`,
      );
      targetControls = controls;
      if (!controls.some((control) => control.state === record.state)) {
        throw new Error(
          `${label} proof.observation has no control observed in required state '${record.state}'.`,
        );
      }
      const checkRequired = (requiredObservation, snapshot, at, stateSnapshot) => {
        const { predicate, expected } = requiredObservation;
        const field = { presence: "present", visibility: "visible" }[predicate] ?? predicate;
        const controls = predicate === "url"
          ? [snapshot]
          : snapshot.controls.filter(
              (control) =>
                control.role === requiredObservation.role &&
                control.name === requiredObservation.name &&
                (!stateSnapshot || control.state === record.state),
            );
        if (!controls.some((control) =>
          Object.hasOwn(control, field) &&
          OBSERVATION_EXPECTED[predicate](control[field]) &&
          control[field] === expected
        )) {
          throw new Error(`${at} misses required observation '${requiredObservation.id}' (${predicate}: ${JSON.stringify(expected)}).`);
        }
      };
      for (const observation of usesRequiredObservations(state)
        ? uiBehavior.requiredObservations
        : []) {
        if (observation.state === record.state && !observation.afterInteractionId) {
          checkRequired(observation, proof.observation, `${label} proof.observation`, true);
        }
      }
      const proofInteractions = assertArray(
        proof.interactions ?? [],
        `${label} proof.interactions`,
      );
      for (const claimed of record.interactions ?? []) {
        const at = `${label} proof interaction '${claimed.id}'`;
        const observed = proofInteractions.find(
          (item) => item?.id === claimed.id,
        );
        if (!observed) {
          throw new Error(`${at} is missing.`);
        }
        const action = assertPlainObject(observed.action, `${at}.action`);
        assertNonEmpty(action.type, `${at}.action.type`);
        assertNonEmpty(action.target, `${at}.action.target`);
        assertObservation(observed.postAction, `${at}.postAction`);
        for (const observation of usesRequiredObservations(state)
          ? uiBehavior.requiredObservations
          : []) {
          if (observation.state === record.state && observation.afterInteractionId === claimed.id) {
            checkRequired(observation, observed.postAction, `${at}.postAction`, false);
            satisfiedPostActions.add(`${uiBehavior.id}::${observation.id}`);
          }
        }
      }
    }
    let screenshotPath;
    if (record.screenshot) {
      assertPlainObject(record.screenshot, `${label}.screenshot`);
      assertNonEmpty(
        record.screenshot.reference,
        `${label}.screenshot.reference`,
      );
      if (!isContentIdentity(record.screenshot.hash)) {
        throw new Error(`${label}.screenshot.hash must be a SHA-256 digest.`);
      }
      const slot = `${origin}::${record.uiBehaviorId}::${record.state}`;
      if (screenshotSlots.has(slot)) {
        throw new Error(
          `${label}.screenshot exceeds the budget: '${record.uiBehaviorId}' state '${record.state}' is already captured for ${origin}.`,
        );
      }
      screenshotSlots.add(slot);
      // ponytail: scoped by origin. Byte-identical LEGACY and TARGET captures
      // mean perfect visual parity, which is the best possible outcome of a
      // migration -- only a repeated capture inside one origin is a mistake.
      const digestSlot = `${origin}::${record.screenshot.hash}`;
      if (screenshotHashes.has(digestSlot)) {
        throw new Error(
          `${label}.screenshot duplicates an existing ${origin} capture in this slice.`,
        );
      }
      screenshotHashes.add(digestSlot);
      if (origin === "TARGET") {
        assertTargetEvidencePath(
          record.screenshot.reference,
          `${label}.screenshot.reference`,
        );
      }
      screenshotPath = await assertEvidenceReference(
        {
          reference: record.screenshot.reference,
          hash: record.screenshot.hash,
        },
        `${label}.screenshot`,
        roots,
        { require: true },
      );
    }
    if (visualRow?.version === HARDENED_VISUAL_VERSION) {
      const frame = visualRow.authorityFrame;
      const authorityName = state.designSource;
      visualComparison.push(await compareVisualEvidence({
        visualRow,
        targetCapture: record.capture,
        authority: authorityName,
        targetReference: record.screenshot.reference,
        readAuthorityPng: () => readFile(path.join(root, frame.sources.screenshot.reference)),
        readTargetPng: () => readFile(screenshotPath),
        readAuthorityControls: async () => {
          const snapshot = await readJson(path.join(root, frame.sources.snapshot.reference), "Legacy authority snapshot");
          return snapshot.observation.controls;
        },
        targetControls,
        nativeRows: baseline.nativeRows,
      }));
    }
  }
  for (const uiBehavior of required) {
    const limitationFor = (runtimeState) => {
      const limitation = limitations.find(
        (item) =>
          item.uiBehaviorId === uiBehavior.id && item.state === runtimeState,
      );
      return limitation?.reason
        ? ` Runtime availability NOT_AVAILABLE: ${limitation.reason}`
        : "";
    };
    for (const runtimeState of uiBehavior.runtimeStates) {
      if (
        !records.some(
          (record) =>
            (record.origin ?? "TARGET") === "TARGET" &&
            record.uiBehaviorId === uiBehavior.id &&
            record.state === runtimeState &&
            record.result === "PASS",
        )
      ) {
        throw new Error(
          `Required UI behavior '${uiBehavior.id}' state '${runtimeState}' lacks Playwright runtime evidence.${limitationFor(runtimeState)}`,
        );
      }
    }
    // A behavior can be "seen" in every state and still never be *used*.
    for (const interaction of uiBehavior.interactions ?? []) {
      if (!exercised.has(`${uiBehavior.id}::${interaction.id}`)) {
        throw new Error(
          `Required UI behavior '${uiBehavior.id}' interaction '${interaction.id}' was never exercised against the target runtime.${limitationFor(uiBehavior.runtimeStates[0])}`,
        );
      }
    }
    if (usesRequiredObservations(state)) {
      for (const observation of uiBehavior.requiredObservations) {
        if (observation.afterInteractionId && !satisfiedPostActions.has(`${uiBehavior.id}::${observation.id}`)) {
          throw new Error(`Required UI behavior '${uiBehavior.id}' state '${observation.state}' misses required postAction observation '${observation.id}' after interaction '${observation.afterInteractionId}'.`);
        }
      }
    }
  }
  return visualComparison;
};

/* ------------------------------------------------------------------ *
 * W3. Controlled same-slice rework at VERIFY_SLICES (format 16)
 *
 * A slice that fails verification for a real defect had no legal way back to
 * implementation: `FAIL` was unrepresentable, `expectedNextCheckpoint` offered
 * no same-slice return, and `slices/<id>.json` was hash-pinned once
 * IMPLEMENT_SLICES closed. The remaining options were all bad -- author a false
 * PASS, abandon the migration, or `--refresh --confirm-mismatch`, which the
 * protocol explicitly forbids for a target-side cause.
 *
 * Modelled structurally on `--reopen-ui`: operator-only, refused under
 * `--mode auto`, refused by `run-migration.mjs`, preview-gated, journalled, and
 * it writes a record of *why* the reopen happened.
 *
 * The ordering below is the whole safety property. The failed attempt is
 * preserved byte-for-byte and pinned BEFORE the mutable current-result path is
 * released for rewriting, in one transaction, so there is no reachable state in
 * which the evidence that caused a rework has been freed before it was kept.
 * ------------------------------------------------------------------ */

export const REWORK_ROOT = "rework";

/**
 * Three attempts, mirroring the gate `attempts` bound. A slice that cannot be
 * verified in three is a planning defect, not an implementation one, and must
 * surface as a blocker naming the slice rather than as a fourth loop.
 */
export const MAX_SLICE_REWORKS = 3;

export const reworkLimitBlocker = (sliceId) =>
  `Slice '${sliceId}' has already been reworked ${MAX_SLICE_REWORKS} times. A slice that cannot be verified in ${MAX_SLICE_REWORKS} attempts is a planning defect, not an implementation one: reopen PLAN or split the slice rather than attempting it again.`;

const REWORK_PATH = /^rework\/(.+)-(\d+)\/(.+)$/;

/** `rework/<slice-id>-<n>/...` -> its slice and attempt, or null. */
export const reworkPathParts = (relativePath) => {
  const match = REWORK_PATH.exec(relativePath);
  return match
    ? { sliceId: match[1], attempt: Number(match[2]), file: match[3] }
    : null;
};

const reworkAttemptsOf = (state, sliceId) =>
  Number.isInteger(state?.sliceReworks?.[sliceId])
    ? state.sliceReworks[sliceId]
    : 0;

/**
 * Where a defect's evidence is preserved. The claim path is kept intact under
 * `evidence/` so provenance survives and two defects naming different files can
 * never collide.
 */
const preservedEvidencePath = (sliceId, attempt, claim) => {
  const normalized = claim.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.length === 0
  ) {
    throw new Error(
      `A defect evidenceReference must be a repository-relative path; received '${claim}'.`,
    );
  }
  return `${REWORK_ROOT}/${sliceId}-${attempt}/evidence/${normalized}`;
};

/**
 * W3-1. A `FAIL` is only legal when it is as evidenced as a `PASS`: every
 * defect names what was expected, what was observed, the scenario or trace it
 * belongs to, and a real file whose current bytes hash to what it claims --
 * the same `assertEvidenceReference` rule the FINALIZE gates use.
 *
 * `inspectSliceArtifacts` continues to treat only `PASS` as verified, so a
 * `FAIL` never counts toward completion no matter how well evidenced it is.
 */
const validateFailedSliceResult = async (root, sliceId, evidence, roots) => {
  if (evidence.sliceId !== sliceId) {
    throw new Error(
      `Evidence for ${sliceId} records sliceId '${evidence.sliceId}'.`,
    );
  }
  if (evidence.result !== "FAIL") {
    throw new Error(
      `--rework-slice requires a recorded FAIL for '${sliceId}'; evidence/${sliceId}/result.json records '${evidence.result}'. A slice is reworked because verification found a defect, never because the agent wants another attempt.`,
    );
  }
  const defects = assertArray(evidence.defects, `${sliceId} evidence defects`);
  if (defects.length === 0) {
    throw new Error(
      `${sliceId} evidence records FAIL with no defects[]. A failure with no named defect is not evidence of anything; nothing was written.`,
    );
  }
  const claims = [];
  for (const [index, defect] of defects.entries()) {
    const label = `${sliceId} evidence defects[${index}]`;
    assertPlainObject(defect, label);
    if (!defect.traceId && !defect.scenarioId) {
      throw new Error(`${label} requires a traceId or a scenarioId.`);
    }
    assertNonEmpty(defect.observed, `${label}.observed`);
    assertNonEmpty(defect.expected, `${label}.expected`);
    assertNonEmpty(defect.evidenceReference, `${label}.evidenceReference`);
    await assertEvidenceReference(
      { reference: defect.evidenceReference, hash: defect.hash },
      label,
      roots,
      { require: true },
    );
    claims.push(evidencePathClaim(defect.evidenceReference));
  }
  return { defects, claims };
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
  if (evidence.sliceId !== sliceId || evidence.result !== "PASS") {
    // A FAIL is a legal document at format 16, but it never advances a slice.
    // The refusal names the one transition that can act on it, so a real defect
    // has a documented way forward instead of a choice between a false PASS and
    // abandoning the migration.
    throw new Error(
      evidence.sliceId === sliceId &&
      evidence.result === "FAIL" &&
      usesSliceRework(state)
        ? `${sliceId} verification recorded FAIL. A failed slice never advances; return it to implementation with '${engineCommand("cli/discover-module.mjs", "<module>", "--rework-slice", sliceId, "--confirm-rework")}', which preserves this attempt before anything is rewritten.`
        : `${sliceId} verification evidence must be PASS.`,
    );
  }
  assertCoversPlanned(
    traceLists(implementation, sliceId, state),
    traceLists(evidence, `${sliceId} evidence`, state),
    `${sliceId} evidence`,
    "verify",
  );
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
  });
  await assertPostAnchorEvidence(root, sliceId, state, roots, evidence);
  return { visualComparison };
};

/**
 * Classification only, never a validator: does this slice's recorded TARGET UI
 * evidence reference anything other than `playwright-ui-proof/v1`? Drives the
 * `--reopen-ui` recovery hint and the ACTIVE reopen superset rule.
 */
export const sliceLacksUiProofV1 = async (root, sliceId, roots) => {
  let evidence;
  try {
    evidence = JSON.parse(
      await readFile(path.join(root, `evidence/${sliceId}/result.json`), "utf8"),
    );
  } catch {
    return false;
  }
  if (evidence?.result !== "PASS" || !Array.isArray(evidence.uiEvidence)) {
    return false;
  }
  for (const record of evidence.uiEvidence) {
    if ((record?.origin ?? "TARGET") !== "TARGET") continue;
    const claim = evidencePathClaim(record.reference);
    const resolved = claim && (await resolveEvidencePath(claim, roots));
    try {
      const proof = JSON.parse(await readFile(resolved, "utf8"));
      if (proof?.proofFormat !== UI_PROOF_FORMAT) return true;
    } catch {
      return true;
    }
  }
  return false;
};

const completedSlicesLackingUiProofV1 = async (root, state, roots) => {
  const lacking = [];
  for (const sliceId of state.completedSlices ?? []) {
    if (await sliceLacksUiProofV1(root, sliceId, roots)) lacking.push(sliceId);
  }
  return lacking;
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

/**
 * A reopened slice whose anchored files were committed again after the anchor
 * may not PASS on evidence that predates those commits.
 *
 * The anchored claim proves the slice *owned* the path in the committed state;
 * it says nothing about whether the path still does what the slice proved. When
 * history has moved on, the verification must be bound to the current HEAD --
 * missing, stale or non-PASS evidence all fail closed, and the later commits
 * stay attributed to whoever made them.
 */
const assertPostAnchorEvidence = async (root, sliceId, state, roots, evidence) => {
  const anchored = await anchoredReopenOwnership(root, sliceId, state, roots);
  if (!anchored) return;
  const drift = [];
  for (const claim of anchored.claims) {
    const commits = await commitsTouchingSince(
      roots.targetRoot,
      anchored.anchor.revision,
      `./${claim}`,
    );
    if (commits.length > 0) drift.push({ path: claim, commits });
  }
  if (drift.length === 0) return;
  const paths = drift.map((entry) => entry.path).sort();
  const verifiedAt = evidence.verifiedAtRevision;
  if (typeof verifiedAt !== "string" || !verifiedAt) {
    throw new Error(
      `${sliceId} was reopened against anchor '${anchored.anchor.revision}', and ${paths.join(", ")} ${paths.length === 1 ? "has" : "have"} been committed to since. Its evidence must record 'verifiedAtRevision' proving it was produced against the current target HEAD '${anchored.head}' before it can PASS.`,
    );
  }
  if (verifiedAt !== anchored.head) {
    throw new Error(
      `${sliceId} evidence records verifiedAtRevision '${verifiedAt}', but the target repository's HEAD is '${anchored.head}' and ${paths.join(", ")} changed after the reopen anchor '${anchored.anchor.revision}' (${drift.flatMap((entry) => entry.commits).join(", ")}). Stale evidence never proves a reopened slice; reverify against the current HEAD.`,
    );
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

const assertIsoTimestamp = (value, label) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`);
  }
  return value;
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
/**
 * A gate hash was only checked for shape (64 hex characters), so a fabricated
 * digest against a nonexistent file satisfied a PASS gate. When the reference
 * names a real file, the recorded hash must be that file's current digest.
 */
const assertEvidenceReference = async (entry, label, roots, options = {}) => {
  const claim = evidencePathClaim(entry.reference);
  // ponytail: `require` is opt-in so prose references stay legal for the
  // evidence kinds whose contract allows them. UI runtime evidence opts in:
  // its whole purpose is proving a browser ran, so "observed in chromium" is
  // not evidence -- same bar as `assertCommandResults`.
  if (!claim) {
    if (!options.require) return;
    throw new Error(
      `${label}.reference '${entry.reference}' is not a persisted artifact path. Record the captured runtime evidence as a real file under the legacy or target repository.`,
    );
  }
  const resolved = await resolveEvidencePath(claim, roots);
  if (!resolved) {
    throw new Error(
      `${label}.reference names '${claim}', which does not exist under the legacy or target repository.`,
    );
  }
  if (!(await fileIdentityMatches(entry.hash, resolved))) {
    throw new Error(
      `${label}.hash does not match the current bytes of '${claim}'. Recorded ${entry.hash}, actual ${await fileIdentity(resolved)}. Regenerate the evidence against the current tree.`,
    );
  }
  return resolved;
};

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

/**
 * The shape contract behind the Figma pin. Pinning proves only that the bytes
 * never changed after ASSESS_TARGET closed -- `{}` pinned and passed, so the
 * digest bound into every visual TARGET evidence row was cryptographically
 * sound and semantically anchored to nothing. This is the cheapest check that
 * the Figma MCP was actually consulted: frames exist, and every frame names a
 * file the operator authorized at bootstrap.
 *
 * ponytail: structural only -- it cannot prove the frames were not invented.
 * Ceiling: an agent that fabricates a frame naming a recorded fileKey still
 * passes. Upgrade path: have the engine re-read node metadata, which would
 * make it call the Figma MCP and stop being pure.
 *
 * Format 17 narrows that ceiling without a network call: each frame must be a
 * recorded link's node, and must carry the verbatim MCP outputs persisted in
 * the record and hashed, whose metadata has to describe that node at the
 * declared viewport. Re-run at every verification, so a persisted Figma file
 * that changed after it was hashed is stale evidence, not silent drift.
 * Returns the frames keyed by node id (format 17 only).
 */
const FIGMA_NODE_ID = /^[0-9]+:[0-9]+$/;
const FIGMA_SOURCE_KINDS = [
  "metadata",
  "designContext",
  "variableDefs",
  "screenshot",
];
const figmaNodeKey = (value) =>
  typeof value === "string" ? value.trim().replace("-", ":") : "";

/**
 * The node ids from the root of a persisted `get_metadata` output down to
 * `nodeId`, or null when `nodeId` is not nested under that root. Read off the
 * element nesting of the verbatim MCP output, never off an authored claim.
 */
export const figmaMetadataAncestry = (metadata, nodeId) => {
  const stack = [];
  let rootId;
  for (const [tag, closing, selfClosing] of metadata.matchAll(
    /<(\/?)[A-Za-z][\w:.-]*(?:\s+[^\s=>/]+="[^"]*")*\s*(\/?)>/g,
  )) {
    if (closing) {
      stack.pop();
      if (stack.length === 0) return null; // left the root: one tree only
      continue;
    }
    const id = figmaNodeKey(xmlAttribute(tag, "id"));
    rootId ??= id;
    if (stack.length === 0 && id !== rootId) return null;
    if (id === nodeId && stack.length > 0) return [...stack, id];
    if (!selfClosing) stack.push(id);
  }
  return null;
};

/** The operator decision kind that alone can leave a required visual state unbacked. */
export const VISUAL_UNBACKED_KIND = "VISUAL_UNBACKED";

/** The contract digest a VISUAL_UNBACKED decision binds, minus its own citations. */
const visualContractDigest = (matrix) =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        ...matrix,
        unbacked: (matrix.unbacked ?? []).map((item) => {
          if (!isPlainObject(item)) return item;
          const { decisionId, decisionDigest, ...rest } = item;
          return rest;
        }),
      }),
    )
    .digest("hex")}`;

/**
 * One `unbacked` entry as an operator decision candidate. Shared by validation
 * and `record-decision.mjs`, so the candidate the operator approves is exactly
 * the one FINALIZE re-derives. The engine never judges whether a frame designs
 * the state -- that is the operator's call, so the rationale lists every
 * persisted frame, and every DEGRADED limitation, the operator decides against.
 */
const visualUnbackedCandidate = ({ state, frames, matrix, contextDigest, item }) => ({
  candidate: createDecisionCandidate({
      kind: VISUAL_UNBACKED_KIND,
      subjectType: "VISUAL_STATE",
      subjectPath: `${item.uiBehaviorId}::${item.state}`,
      rationale: [
        String(item.reason ?? ""),
        ...[...frames.values()].map((frame) =>
          frame.extraction.fidelity === "COMPLETE"
            ? `Figma evidence: node ${frame.key} '${frame.name}' ${frame.viewport.width}x${frame.viewport.height}, COMPLETE, states: ${frame.states.join(" | ")}`
            : `DEGRADED Figma evidence, fidelity not established: node ${frame.key} '${frame.name}' (${frame.extraction.limitations.join("; ")})`,
        ),
      ].join("\n"),
      boundTo: {
        module: state.migrationId,
        figmaSources: (state.figmaSources ?? [])
          .map((source) => `${source.fileKey}#${source.nodeId ?? "*"}`)
          .sort(),
        // The same slot under both authorities, named by the adapter: what the
        // operator approved is bound to the exact authority bytes it saw.
        [visualAuthorityOf(state).boundToDigestField]: contextDigest,
        visualContractDigest: visualContractDigest(matrix),
      },
    }),
});

/** Whether an explicit backed row already binds this behavior state to Figma. */
const backedRowFor = (matrix, item) =>
  (Array.isArray(matrix.rows) ? matrix.rows : []).find(
    (row) =>
      row?.uiBehaviorId === item.uiBehaviorId && row?.state === item.state,
  );

/**
 * The VISUAL_UNBACKED candidates an operator may approve. Exported for
 * `record-decision.mjs`, which owns every approval; nothing here records.
 * During adoption the fresh context is read as format 17 would read it.
 */
export const pendingVisualUnbackedCandidates = async (root, state, legacy) => {
  const authority = visualAuthorityOf(state);
  if (!authority) return [];
  // `--adopt-visual-contract` is a Figma-only migration path (a pre-17 record
  // adopting format-17 Figma evidence); no legacy-runtime record can predate
  // its own authority, so the adoption file is read only for that origin.
  const adopting =
    !usesVisualAcceptance(state) &&
    authority.contextFile === FIGMA_CONTEXT_FILE &&
    (await fileExists(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE)));
  if (!usesVisualAcceptance(state) && !adopting) return [];
  const contextFile = adopting
    ? FIGMA_CONTEXT_ADOPTION_FILE
    : authority.contextFile;
  const strictState = { ...state, formatVersion: VISUAL_ACCEPTANCE_FORMAT };
  let frames;
  let matrix;
  try {
    frames = await authority.validateContext(
      root,
      strictState,
      contextFile,
      legacy,
    );
    matrix = JSON.parse(
      await readFile(path.join(root, VISUAL_ACCEPTANCE_FILE), "utf8"),
    );
  } catch {
    return []; // nothing valid to decide about yet
  }
  const contextDigest = `sha256:${await hashFile(path.join(root, contextFile))}`;
  return (Array.isArray(matrix?.unbacked) ? matrix.unbacked : [])
    .filter((item) => isPlainObject(item) && !backedRowFor(matrix, item))
    .map(
      (item) =>
        visualUnbackedCandidate({ state, frames, matrix, contextDigest, item })
          .candidate,
    );
};

export const validateFigmaContext = async (
  root,
  state,
  contextFile = FIGMA_CONTEXT_FILE,
) => {
  const strict = usesVisualAcceptance(state);
  const fail = (problem) => {
    throw Object.assign(new Error(
      `${contextFile} ${problem}. This migration records designSource: figma-mcp, so ASSESS_TARGET cannot close without it: read the figmaSources recorded in state.json through the Figma MCP and author ${FIGMA_CONTEXT_FILE} as a JSON object with a non-empty "frames" array whose every entry names the "fileKey" it was read from.${
        strict
          ? ` Format ${VISUAL_ACCEPTANCE_FORMAT} also requires every frame's nodeId, name, type, viewport, states, extraction {retrievedAt, fidelity, limitations}, and sources {metadata, designContext[], variableDefs, screenshot}: the verbatim Figma MCP outputs persisted inside the migration record, each as {reference, hash}.`
          : ""
      }`,
    ), { visualContextFail: true });
  };
  const filePath = path.join(root, contextFile);
  if (!(await fileExists(filePath))) fail("does not exist");
  let context;
  try {
    context = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`is invalid JSON: ${error.message}`);
  }
  if (!isPlainObject(context)) fail("must be a JSON object");
  if (!Array.isArray(context.frames) || context.frames.length === 0) {
    fail('must record a non-empty "frames" array');
  }
  // The contract derived from this authority is hardened, so the authority it
  // is derived from must be: a v2 contract over a v1 context would assert
  // taxonomy facts nothing resolved.
  const hardened =
    strict &&
    hardenedVisual(
      state,
      // During adoption the fresh file is authored beside the pinned one, so
      // the pin that makes v1 legal is the pin of the file being replaced.
      contextFile === FIGMA_CONTEXT_ADOPTION_FILE ? FIGMA_CONTEXT_FILE : contextFile,
      context,
      contextFile,
    );
  const recorded = new Set(
    (state.figmaSources ?? []).map((source) => source.fileKey),
  );
  const frames = new Map();
  for (const [index, frame] of context.frames.entries()) {
    if (!isPlainObject(frame) || typeof frame.fileKey !== "string") {
      fail(`frames[${index}] must name a "fileKey"`);
    }
    const fileKey = frame.fileKey.trim();
    if (fileKey.length === 0) fail(`frames[${index}].fileKey is empty`);
    if (!recorded.has(fileKey)) {
      fail(
        `frames[${index}].fileKey '${fileKey}' is not one of this migration's recorded figmaSources (${[...recorded].join(", ")})`,
      );
    }
    if (!strict) continue;
    const at = `frames[${index}]`;
    const nodeId = figmaNodeKey(frame.nodeId);
    if (!FIGMA_NODE_ID.test(nodeId)) {
      fail(`${at}.nodeId must be a Figma node id such as "12:34"`);
    }
    const verifyPersisted = async (entry, label) => {
      const absolute =
        isPlainObject(entry) && typeof entry.reference === "string"
          ? path.resolve(root, entry.reference)
          : null;
      if (!absolute || !isWithin(root, absolute) || !(await fileExists(absolute))) {
        fail(`${label} must reference a file persisted inside the migration record`);
      }
      // P4: the authority is pinned at ASSESS_TARGET, before any slice exists,
      // so it can never legitimately cite the target's verification tree.
      if (recordRelative(root, absolute).startsWith(TARGET_EVIDENCE_ROOT)) {
        fail(
          `${label} '${entry.reference}' resolves under ${TARGET_EVIDENCE_ROOT}; a pinned visual authority never cites target verification evidence`,
        );
      }
      // A persisted UI binding, so it reads through the shared identity
      // policy: the captured XML and text are text, and a checkout that only
      // re-spelled their line endings has not made the evidence stale. The
      // recorded spelling is left exactly as it was written.
      if (!(await fileIdentityMatches(entry.hash, absolute))) {
        fail(
          `${label} '${entry.reference}' no longer matches its recorded hash; the persisted Figma evidence is stale`,
        );
      }
      return absolute;
    };
    const recordedNodes = (state.figmaSources ?? []).filter(
      (source) => source.fileKey === fileKey,
    );
    // A node link authorizes that node, a whole-file link any node of the file,
    // and a node link also authorizes a descendant whose nesting under it is
    // read from the source's own persisted get_metadata output.
    let ancestryTag = null;
    if (
      !recordedNodes.some(
        (source) =>
          source.nodeId === null || figmaNodeKey(source.nodeId) === nodeId,
      )
    ) {
      const ancestry = frame.ancestry;
      const recordedLinks = `(${(state.figmaSources ?? []).map((source) => `${source.fileKey}#${source.nodeId ?? "*"}`).join(", ")})`;
      if (!isPlainObject(ancestry)) {
        fail(
          `${at}.nodeId '${nodeId}' is not a node of this migration's recorded figmaSources ${recordedLinks}, and records no ancestry proving it descends from one`,
        );
      }
      const sourceNodeId = figmaNodeKey(ancestry.sourceNodeId);
      if (
        !recordedNodes.some(
          (source) => source.nodeId && figmaNodeKey(source.nodeId) === sourceNodeId,
        )
      ) {
        fail(
          `${at}.ancestry.sourceNodeId '${ancestry.sourceNodeId}' is not a recorded node link of file '${fileKey}' ${recordedLinks}`,
        );
      }
      const metadataPath = await verifyPersisted(
        ancestry.metadata,
        `${at}.ancestry.metadata`,
      );
      const sourceMetadata = await readFile(metadataPath, "utf8");
      const derived = figmaMetadataAncestry(sourceMetadata, nodeId);
      if (!derived || derived[0] !== sourceNodeId) {
        fail(
          `${at}.ancestry.metadata (the persisted get_metadata of '${sourceNodeId}') does not nest node '${nodeId}' under '${sourceNodeId}'`,
        );
      }
      if (JSON.stringify((ancestry.path ?? []).map(figmaNodeKey)) !== JSON.stringify(derived)) {
        fail(
          `${at}.ancestry.path ${JSON.stringify(ancestry.path)} is not the ancestry read from its persisted metadata ${JSON.stringify(derived)}`,
        );
      }
      ancestryTag = sourceMetadata.match(
        new RegExp(`<[^>]*\\sid="${nodeId}"[^>]*>`),
      )[0];
      if (xmlAttribute(ancestryTag, "name") !== frame.name) {
        fail(
          `${at}.name '${frame.name}' is not node '${nodeId}' name in its source metadata ('${xmlAttribute(ancestryTag, "name")}')`,
        );
      }
    }
    if (frames.has(nodeId)) fail(`${at}.nodeId '${nodeId}' is recorded twice`);
    for (const field of ["name", "type"]) {
      if (typeof frame[field] !== "string" || frame[field].trim() === "") {
        fail(`${at}.${field} is required`);
      }
    }
    const viewport = frame.viewport;
    if (
      !isPlainObject(viewport) ||
      !["width", "height"].every(
        (axis) => Number.isInteger(viewport[axis]) && viewport[axis] > 0,
      )
    ) {
      fail(`${at}.viewport must record positive integer width and height`);
    }
    if (
      !Array.isArray(frame.states) ||
      frame.states.length === 0 ||
      frame.states.some((item) => typeof item !== "string" || !item.trim())
    ) {
      fail(`${at}.states must list the design states the frame shows`);
    }
    const extraction = frame.extraction;
    if (
      !isPlainObject(extraction) ||
      typeof extraction.retrievedAt !== "string" ||
      Number.isNaN(Date.parse(extraction.retrievedAt)) ||
      !Array.isArray(extraction.limitations) ||
      !(
        (extraction.fidelity === "COMPLETE" &&
          extraction.limitations.length === 0) ||
        (extraction.fidelity === "DEGRADED" &&
          extraction.limitations.length > 0)
      )
    ) {
      fail(
        `${at}.extraction must record an ISO retrievedAt and fidelity COMPLETE with no limitations, or DEGRADED with every limitation`,
      );
    }
    const sources = isPlainObject(frame.sources) ? frame.sources : {};
    const persisted = { designContext: [] };
    for (const kind of FIGMA_SOURCE_KINDS) {
      const entries =
        kind === "designContext" ? sources[kind] : sources[kind] && [sources[kind]];
      if (!Array.isArray(entries) || entries.length === 0) {
        fail(`${at}.sources.${kind} must persist the raw Figma MCP output`);
      }
      for (const entry of entries) {
        const absolute = await verifyPersisted(entry, `${at}.sources.${kind}`);
        if (kind === "designContext") {
          // v2: an entry that does not say which node it describes cannot bind
          // a fact to a node, and an unbound CSS declaration is exactly the
          // "somewhere in the design it says 16px" claim this contract refuses.
          if (hardened && figmaNodeKey(entry.nodeId) === "") {
            fail(
              `${at}.sources.designContext[].nodeId is required: every persisted design context entry must name the node it was read for`,
            );
          }
          persisted.designContext.push({ entry, absolute });
        } else {
          persisted[kind] = { entry, absolute };
        }
      }
    }
    // The viewport is read off the persisted node, never taken on trust.
    const metadata = await readFile(
      path.resolve(root, sources.metadata.reference),
      "utf8",
    );
    const tag = metadata.match(new RegExp(`<[^>]*\\bid="${nodeId}"[^>]*>`))?.[0];
    if (!tag) fail(`${at}.sources.metadata does not describe node '${nodeId}'`);
    const size = (axis) =>
      Math.round(Number(tag.match(new RegExp(`\\b${axis}="([\\d.]+)"`))?.[1]));
    if (size("width") !== viewport.width || size("height") !== viewport.height) {
      fail(
        `${at}.viewport ${viewport.width}x${viewport.height} does not match node '${nodeId}' in its persisted metadata (${size("width")}x${size("height")})`,
      );
    }
    // The descendant's own snapshot and its source's hierarchy must agree.
    if (
      ancestryTag &&
      ["width", "height"].some(
        (axis) =>
          Math.round(Number(xmlAttribute(ancestryTag, axis))) !== viewport[axis],
      )
    ) {
      fail(
        `${at}.ancestry.metadata describes node '${nodeId}' at a size other than its viewport ${viewport.width}x${viewport.height}`,
      );
    }
    const facts = hardened
      ? await resolveFigmaFacts({ frame, nodeId, at, fail, metadata, persisted })
      : {};
    if (hardened) {
      try { assertVisualCaptureBlock(frame, frame.capture, at); }
      catch (error) { fail(error.message); }
    }
    // `key` is the authority-neutral frame identity every shared reader uses;
    // `nodeId` stays exactly what it was for every Figma-only reader.
    frames.set(nodeId, { ...frame, nodeId, key: nodeId, facts });
  }
  return frames;
};

/**
 * v2, figma-mcp: every authored fact re-resolved from the bytes whose hash this
 * validator has just re-verified, and refused when the authored value is not
 * what those bytes say. The frame declares `{value, provenance {kind,
 * reference, nodeId, selector}}`; the engine reads the value back out and
 * compares in the one normalized space, so the authored number is a claim about
 * pinned evidence rather than the evidence itself.
 *
 * `legacy-runtime` needs none of this: its facts are measured, not transcribed,
 * so the capture file *is* the provenance.
 */
const resolveFigmaFacts = async ({ frame, nodeId, at, fail, metadata, persisted }) => {
  const authored = frame.facts;
  if (!isPlainObject(authored) || Object.keys(authored).length === 0) {
    fail(
      `${at}.facts must record the visual facts this node establishes, each as {value, provenance {kind, reference, nodeId, selector}} resolvable from the persisted evidence (${REQUIRED_FACT_NAMES.join(", ")} plus whatever else this node establishes)`,
    );
  }
  let variableDefs;
  try {
    variableDefs = JSON.parse(await readFile(persisted.variableDefs.absolute, "utf8"));
  } catch (error) {
    fail(`${at}.sources.variableDefs is not JSON: ${error.message}`);
  }
  const designContextText = new Map();
  for (const { entry, absolute } of persisted.designContext) {
    designContextText.set(entry.reference, {
      nodeId: figmaNodeKey(entry.nodeId),
      text: await readFile(absolute, "utf8"),
    });
  }
  const facts = {};
  for (const [name, fact] of Object.entries(authored)) {
    const label = `${at}.facts.${name}`;
    if (!isPlainObject(fact)) fail(`${label} must be a JSON object`);
    const provenance = fact.provenance;
    if (!isPlainObject(provenance) || !FIGMA_PROVENANCE_KINDS.includes(provenance.kind)) {
      fail(
        `${label}.provenance.kind must be one of ${FIGMA_PROVENANCE_KINDS.join(", ")}`,
      );
    }
    // Node binding, checked before anything is read: a fact of *this* frame is
    // resolved against *this* node, so a selector aimed elsewhere in the same
    // file cannot be presented as this node's value.
    if (figmaNodeKey(provenance.nodeId) !== nodeId) {
      fail(
        `${label}.provenance.nodeId '${provenance.nodeId}' is not this frame's node '${nodeId}'`,
      );
    }
    if (typeof provenance.selector !== "string" || !provenance.selector.trim()) {
      fail(`${label}.provenance.selector is required`);
    }
    let resolved;
    try {
      if (provenance.kind === "metadata") {
        if (provenance.reference !== persisted.metadata.entry.reference) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' is not this frame's persisted metadata ('${persisted.metadata.entry.reference}')`,
          );
        }
        resolved = normalizeVisualValue(
          name,
          name === "assets"
            ? resolveMetadataAssets(metadata, nodeId, provenance.selector.trim(), label)
            : resolveMetadataFact(metadata, nodeId, provenance.selector.trim(), label),
        );
      } else if (provenance.kind === "variableDefs") {
        if (provenance.reference !== persisted.variableDefs.entry.reference) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' is not this frame's persisted variableDefs ('${persisted.variableDefs.entry.reference}')`,
          );
        }
        resolved = normalizeVisualValue(
          name,
          resolveVariableDefsFact(variableDefs, provenance.selector.trim(), label),
        );
      } else {
        const entry = designContextText.get(provenance.reference);
        if (!entry) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' is not one of this frame's persisted designContext entries`,
          );
        }
        if (entry.nodeId !== nodeId) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' was read for node '${entry.nodeId}', not '${nodeId}'`,
          );
        }
        resolved = resolveDesignContextFact(
          entry.text,
          provenance.selector.trim(),
          name,
          label,
        );
      }
      assertProvenancePrecedence({
        property: name,
        kind: provenance.kind,
        value: resolved,
        variableValues:
          provenance.kind === "designContext"
            ? variableValueSet(variableDefs, name)
            : null,
        label,
      });
      const declared = normalizeVisualValue(name, fact.value);
      if (JSON.stringify(declared) !== JSON.stringify(resolved)) {
        fail(
          `${label}.value ${JSON.stringify(fact.value)} normalizes to ${JSON.stringify(declared)}, but its own ${provenance.kind} provenance resolves to ${JSON.stringify(resolved)}`,
        );
      }
    } catch (error) {
      // A refusal raised by `fail` already carries the context-file preamble;
      // a resolver's own refusal is re-thrown through it, so every message in
      // this validator names the file the operator has to fix.
      if (error.visualContextFail) throw error;
      fail(error.message);
    }
    facts[name] = { value: resolved, provenance };
  }
  const uncovered = REQUIRED_FACT_NAMES.filter((name) => facts[name] === undefined);
  if (uncovered.length > 0) {
    fail(
      `${at}.facts records no ${uncovered.join(", ")}; a node the contract derives from must establish the full visual taxonomy (${REQUIRED_FACT_NAMES.join(", ")})`,
    );
  }
  return facts;
};

/**
 * Format 17, legacy-runtime: the pinned visual authority, validated with
 * `validateFigmaContext`'s own primitives -- containment + `fileIdentityMatches`
 * on every persisted source, the COMPLETE/DEGRADED extraction rule, the
 * positive-integer viewport rule, the duplicate-key rule -- plus the rules that
 * bind it to *this* record's legacy tree rather than to a design file.
 *
 * The authority is captured before the target exists and is pinned at
 * ASSESS_TARGET, which is what makes substitution a recorded act: a frame is
 * bound to the pinned `legacyRevision`, declares `capture.role:
 * "LEGACY_AUTHORITY"`, and may cite nothing under `evidence/` (P4/P5).
 */
export const validateLegacyRuntimeContext = async (
  root,
  state,
  contextFile = LEGACY_RUNTIME_CONTEXT_FILE,
  legacy,
) => {
  const fail = (problem) => {
    throw new Error(
      `${contextFile} ${problem}. This migration records designSource: legacy-runtime, so ASSESS_TARGET cannot close without it: capture every required legacy UI behavior state from the running legacy app and author ${LEGACY_RUNTIME_CONTEXT_FILE} as a JSON object with a non-empty "frames" array, each frame naming its uiBehaviorId, state, viewport, rootLocator, this record's legacyRevision, a capture block {role: "LEGACY_AUTHORITY", mode: "element", compare {width, height}}, and sources {snapshot, screenshot, measurements} persisted under ${LEGACY_RUNTIME_EVIDENCE_ROOT} as {reference, hash}.`,
    );
  };
  const filePath = path.join(root, contextFile);
  if (!(await fileExists(filePath))) fail("does not exist");
  let context;
  try {
    context = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`is invalid JSON: ${error.message}`);
  }
  if (!isPlainObject(context)) fail("must be a JSON object");
  if (!Array.isArray(context.frames) || context.frames.length === 0) {
    fail('must record a non-empty "frames" array');
  }
  const hardened = hardenedVisual(state, contextFile, context, contextFile);
  const inventory =
    legacy ??
    JSON.parse(
      await readFile(path.join(root, "inventories/legacy.json"), "utf8"),
    );
  const discovered = new Map(
    (inventory.uiBehaviors ?? []).map((uiBehavior) => [
      uiBehavior.id,
      uiBehavior.runtimeStates ?? [],
    ]),
  );
  const frames = new Map();
  for (const [index, frame] of context.frames.entries()) {
    const at = `frames[${index}]`;
    if (!isPlainObject(frame)) fail(`${at} must be a JSON object`);
    const uiBehaviorId = frame.uiBehaviorId;
    const runtimeState = frame.state;
    if (!discovered.get(uiBehaviorId)?.includes(runtimeState)) {
      fail(
        `${at} names '${uiBehaviorId}' state '${runtimeState}', which is not a discovered state of a UI behavior in inventories/legacy.json`,
      );
    }
    const key = `${uiBehaviorId}::${runtimeState}`;
    if (frame.id !== key) fail(`${at}.id must be '${key}'`);
    if (frames.has(key)) fail(`${at}.id '${key}' is recorded twice`);
    if (
      !Array.isArray(frame.states) ||
      frame.states.length !== 1 ||
      frame.states[0] !== runtimeState
    ) {
      fail(`${at}.states must be exactly ['${runtimeState}']`);
    }
    // The authority is bound to the pinned legacy tree: a re-capture taken
    // after the legacy source moved cannot pass without an explicit --refresh.
    if (frame.legacyRevision !== state.legacyRevision?.revision) {
      fail(
        `${at}.legacyRevision '${frame.legacyRevision}' is not this record's pinned legacy revision '${state.legacyRevision?.revision}'`,
      );
    }
    if (typeof frame.rootLocator !== "string" || !frame.rootLocator.trim()) {
      fail(
        `${at}.rootLocator must name the element that owns the behavior's surface`,
      );
    }
    const viewport = frame.viewport;
    if (
      !isPlainObject(viewport) ||
      !["width", "height"].every(
        (axis) => Number.isInteger(viewport[axis]) && viewport[axis] > 0,
      )
    ) {
      fail(`${at}.viewport must record positive integer width and height`);
    }
    const capture = frame.capture;
    if (!isPlainObject(capture)) fail(`${at}.capture is required`);
    if (capture.role !== LEGACY_AUTHORITY_ROLE) {
      fail(
        `${at}.capture.role must be '${LEGACY_AUTHORITY_ROLE}'; '${capture.role}' is the role of a different lifecycle slot`,
      );
    }
    if (capture.mode !== "element") {
      fail(
        `${at}.capture.mode must be 'element' (scoped to rootLocator); a full-page capture makes unrelated app chrome dominate the comparison`,
      );
    }
    const compare = capture.compare;
    if (
      !isPlainObject(compare) ||
      !["width", "height"].every(
        (axis) => Number.isInteger(compare[axis]) && compare[axis] > 0,
      )
    ) {
      fail(
        `${at}.capture.compare must declare the positive integer width and height both sides are compared at`,
      );
    }
    if (hardened) {
      try { assertVisualCaptureBlock(frame, capture, at, true); }
      catch (error) { fail(error.message); }
    }
    const extraction = frame.extraction;
    if (
      !isPlainObject(extraction) ||
      typeof extraction.retrievedAt !== "string" ||
      Number.isNaN(Date.parse(extraction.retrievedAt)) ||
      !Array.isArray(extraction.limitations) ||
      !(
        (extraction.fidelity === "COMPLETE" &&
          extraction.limitations.length === 0) ||
        (extraction.fidelity === "DEGRADED" &&
          extraction.limitations.length > 0)
      )
    ) {
      fail(
        `${at}.extraction must record an ISO retrievedAt and fidelity COMPLETE with no limitations, or DEGRADED with every limitation`,
      );
    }
    const sources = isPlainObject(frame.sources) ? frame.sources : {};
    const read = {};
    for (const kind of ["snapshot", "screenshot", "measurements"]) {
      const entry = sources[kind];
      const absolute =
        isPlainObject(entry) && typeof entry.reference === "string"
          ? path.resolve(root, entry.reference)
          : null;
      if (
        !absolute ||
        !isWithin(root, absolute) ||
        !(await fileExists(absolute))
      ) {
        fail(
          `${at}.sources.${kind} must reference a file persisted inside the migration record`,
        );
      }
      // P4: the authority predates every slice, so it can never legitimately
      // live in the target's verification tree. Citing one there would let a
      // post-implementation capture be pinned as the thing it is measured against.
      if (!recordRelative(root, absolute).startsWith(LEGACY_RUNTIME_EVIDENCE_ROOT)) {
        fail(
          `${at}.sources.${kind} '${entry.reference}' does not resolve under ${LEGACY_RUNTIME_EVIDENCE_ROOT}; authority captures and target verification evidence never share a root`,
        );
      }
      if (!(await fileIdentityMatches(entry.hash, absolute))) {
        fail(
          `${at}.sources.${kind} '${entry.reference}' no longer matches its recorded hash; the persisted legacy authority capture is stale`,
        );
      }
      read[kind] = absolute;
    }
    let measurements;
    try {
      measurements = JSON.parse(await readFile(read.measurements, "utf8"));
    } catch (error) {
      fail(`${at}.sources.measurements is not JSON: ${error.message}`);
    }
    if (
      !isPlainObject(measurements) ||
      !isPlainObject(measurements.values) ||
      Object.keys(measurements.values).length === 0
    ) {
      fail(
        `${at}.sources.measurements must parse as {viewport, values} with at least one measured value`,
      );
    }
    if (
      measurements.viewport?.width !== viewport.width ||
      measurements.viewport?.height !== viewport.height
    ) {
      fail(
        `${at}.sources.measurements was captured at viewport ${measurements.viewport?.width}x${measurements.viewport?.height}, the frame declares ${viewport.width}x${viewport.height}`,
      );
    }
    // v2: the frame's facts are *derived* here, from the pinned capture, and
    // never authored. There is no provenance to check because there is no
    // authoring step to distrust -- the measurement file is the provenance.
    // A taxonomy key the capture did not record is a capture defect, refused at
    // ASSESS_TARGET while the capture can still be retaken, rather than
    // discovered at BUILD_BASELINE against an immutable pin. This is also what
    // keeps coverage bounded: the file carries the taxonomy, not a full
    // computed-style dump.
    const missing = hardened
      ? REQUIRED_FACT_NAMES.filter((name) => measurements.values[name] === undefined)
      : [];
    if (missing.length > 0) {
      fail(
        `${at}.sources.measurements records no ${missing.join(", ")}; the pinned authority capture must measure the full visual taxonomy (${REQUIRED_FACT_NAMES.join(", ")}) because the visual contract is derived from it and cannot assert what was never captured`,
      );
    }
    if (hardened && !Object.entries(measurements.values).some(
      ([name, value]) => REQUIRED_FACT_KINDS[name] === undefined && Number.isInteger(value) && value >= 0,
    )) {
      fail(`${at}.sources.measurements has no non-negative integer structure count outside the named taxonomy facts`);
    }
    const facts = {};
    if (hardened) {
      for (const [name, raw] of Object.entries(measurements.values)) {
        try {
          facts[name] = { value: normalizeVisualValue(name, raw) };
        } catch (error) {
          fail(`${at}.sources.measurements ${error.message}`);
        }
      }
    }
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(read.snapshot, "utf8"));
    } catch (error) {
      fail(`${at}.sources.snapshot is not JSON: ${error.message}`);
    }
    if (snapshot?.proofFormat !== UI_PROOF_FORMAT) {
      fail(
        `${at}.sources.snapshot is not '${UI_PROOF_FORMAT}' structured proof (proofFormat '${snapshot?.proofFormat}')`,
      );
    }
    const controls = snapshot?.observation?.controls;
    if (!Array.isArray(controls) || controls.length === 0) {
      fail(
        `${at}.sources.snapshot.observation.controls must observe at least one control`,
      );
    }
    frames.set(key, { ...frame, key, name: key, measurements, facts });
  }
  return frames;
};

// ponytail: tolerance ceilings keep "explicit tolerance" from becoming a
// waiver; they are the calibration knob if a real design needs more slack.
const MAX_TOLERANCE_PX = 16;
const MAX_TOLERANCE_RATIO = 0.1;
// PROVISIONAL: unproven on real migrations. Slice D owns calibration; never
// widen one of these to admit a known divergent layout.
export const PROVISIONAL_VISUAL_DIFF_THRESHOLDS = Object.freeze({
  "legacy-runtime": 0.0005,
  "figma-mcp": 0.05,
});

const assertVisualCaptureBlock = (frame, capture, label, runtime = false) => {
  if (!isPlainObject(capture)) throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture is required`);
  if (capture.mode !== "element" || typeof frame.rootLocator !== "string" || !frame.rootLocator.trim()) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label} requires an element capture scoped to the authority rootLocator`);
  }
  if (capture.rootLocator !== frame.rootLocator) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.rootLocator must equal '${frame.rootLocator}'`);
  }
  if (!Number.isFinite(capture.deviceScaleFactor) || capture.deviceScaleFactor <= 0 ||
      (runtime && capture.deviceScaleFactor !== 1)) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.deviceScaleFactor must be 1 for a runtime element capture`);
  }
  if (!["light", "dark", "no-preference"].includes(capture.colorScheme)) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.colorScheme must be a Playwright color scheme`);
  }
  if (capture.reducedMotion !== "reduce") {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.reducedMotion must be reduce`);
  }
  if (typeof capture.matte !== "string" || !/^#[0-9a-f]{6}$/i.test(capture.matte)) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.matte must be an opaque #RRGGBB color`);
  }
  for (const dimensions of [capture.compare, capture]) {
    const fields = dimensions === capture ? ["imageWidth", "imageHeight"] : ["width", "height"];
    if (!isPlainObject(dimensions) || fields.some((field) => !Number.isInteger(dimensions[field]) || dimensions[field] <= 0)) {
      throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.${dimensions === capture ? "imageWidth/imageHeight" : "compare"} must be positive integers`);
    }
  }
};

/** The one v2 image and control comparison used by both migration engines. */
export const compareVisualEvidence = async ({
  visualRow, targetCapture, authority, targetReference, readAuthorityPng,
  readTargetPng, readAuthorityControls, targetControls, nativeRows = [],
}) => {
  const frame = visualRow.authorityFrame;
  const sourceReference = frame.sources.screenshot.reference;
  assertVisualCaptureBlock(frame, frame.capture, `${visualRow.id} authority`, authority === "legacy-runtime");
  assertVisualCaptureBlock(frame, targetCapture, `${visualRow.id} TARGET`, true);
  for (const field of ["mode", "deviceScaleFactor", "colorScheme", "reducedMotion", "matte"]) {
    if (frame.capture[field] !== targetCapture[field]) {
      throw new Error(`VISUAL_CAPTURE_MISMATCH: ${visualRow.id}.capture.${field} differs between '${sourceReference}' and '${targetReference}'`);
    }
  }
  if (frame.capture.compare.width !== targetCapture.compare.width ||
      frame.capture.compare.height !== targetCapture.compare.height) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${visualRow.id}.capture.compare differs between '${sourceReference}' and '${targetReference}'`);
  }
  const decode = async (read, capture, reference) => {
    let image;
    try {
      image = decodePng(await read());
    } catch (error) {
      throw new Error(`VISUAL_PNG_INVALID: '${reference}' ${error.message}`);
    }
    if (image.width !== capture.imageWidth || image.height !== capture.imageHeight) {
      throw new Error(`VISUAL_CAPTURE_MISMATCH: '${reference}' decoded ${image.width}x${image.height}, recorded ${capture.imageWidth}x${capture.imageHeight}`);
    }
    return image;
  };
  const source = await decode(readAuthorityPng, frame.capture, sourceReference);
  const target = await decode(readTargetPng, targetCapture, targetReference);
  const compare = frame.capture.compare;
  const { diffPixels, diffRatio } = perceptualDelta(source, target, { ...compare, matte: frame.capture.matte });
  const threshold = PROVISIONAL_VISUAL_DIFF_THRESHOLDS[authority];
  if (threshold === undefined) throw new Error(`VISUAL_CAPTURE_MISMATCH: unknown visual authority '${authority}'`);
  if (diffRatio > threshold) {
    throw new Error(`VISUAL_DIVERGENCE: ${visualRow.id} diffPixels ${diffPixels}, diffRatio ${diffRatio}, threshold ${threshold}; authority '${sourceReference}', TARGET '${targetReference}'`);
  }
  let structural = null;
  const extrasAuthorized = [];
  if (authority === "legacy-runtime") {
    const authorityControls = await readAuthorityControls();
    if (!Array.isArray(authorityControls) || !Array.isArray(targetControls) ||
        [...authorityControls, ...targetControls].some((control) =>
          typeof control?.role !== "string" || !control.role.trim() ||
          typeof control?.name !== "string" || !control.name.trim())) {
      throw new Error(`VISUAL_STRUCTURE_DIVERGENCE: ${visualRow.id} requires scoped {role, name} controls on both sides`);
    }
    structural = structuralDelta(authorityControls, targetControls);
    if (structural.missing.length || structural.countDiffs.length) {
      throw new Error(`VISUAL_STRUCTURE_DIVERGENCE: ${visualRow.id} ${JSON.stringify(structural)}`);
    }
    const licenses = nativeRows.flatMap((row) =>
      ["PRESERVED", "VERIFIED"].includes(row.verificationStatus ?? row.status)
        ? (row.controls ?? []).map((control) => ({ ...control, nativeRowId: row.id }))
        : []);
    for (const extra of structural.extra) {
      for (let count = 0; count < extra.count; count++) {
        const index = licenses.findIndex((control) => control.role === extra.role && control.name === extra.name);
        if (index < 0) throw new Error(`VISUAL_STRUCTURE_DIVERGENCE: ${visualRow.id} unauthorized extra ${extra.role} '${extra.name}'`);
        extrasAuthorized.push(licenses.splice(index, 1)[0]);
      }
    }
  }
  return { rowId: visualRow.id, authority, diffPixels, diffRatio, threshold, compare, structural, extrasAuthorized };
};

/**
 * Format 17. The derived visual contract: validated against the pinned visual
 * authority it claims to come from -- Figma or the legacy runtime, read through
 * the one `VISUAL_AUTHORITIES` adapter -- and required to cover every required
 * UI behavior state. A state no COMPLETE frame establishes may be listed under
 * `unbacked` only with a cited VISUAL_UNBACKED operator decision bound to this
 * migration, the state, the authority context digest and the visual contract
 * digest. Only an explicit row binds a state to its authority frame; an
 * explicitly backed state cannot be unbacked, and nothing is inferred from
 * frame names or states.
 */
export const validateVisualAcceptance = async (
  root,
  state,
  legacy,
  target,
  contextFile,
) => {
  const authority = visualAuthorityOf(state);
  const frames = await authority.validateContext(
    root,
    state,
    contextFile,
    legacy,
  );
  const contextDigest = `sha256:${await hashFile(
    path.join(root, contextFile ?? authority.contextFile),
  )}`;
  const decisions = await readRecordedDecisions(root);
  const matrix = assertPlainObject(
    await readJson(
      path.join(root, VISUAL_ACCEPTANCE_FILE),
      "Visual acceptance matrix",
    ),
    "Visual acceptance matrix",
  );
  const rows = assertArray(matrix.rows, "Visual acceptance rows");
  assertUniqueIds(rows, "Visual acceptance rows");
  const hardened = hardenedVisual(
    state,
    VISUAL_ACCEPTANCE_FILE,
    matrix,
    VISUAL_ACCEPTANCE_FILE,
  );
  const normalized = new Map();
  const behaviors = new Map(
    (legacy.uiBehaviors ?? []).map((uiBehavior) => [uiBehavior.id, uiBehavior]),
  );
  const covered = new Set();
  const claim = (item, label) => {
    assertPlainObject(item, label);
    if (!behaviors.get(item.uiBehaviorId)?.runtimeStates.includes(item.state)) {
      throw new Error(
        `${label} does not name a discovered state of UI behavior '${item.uiBehaviorId}'.`,
      );
    }
    const key = `${item.uiBehaviorId}::${item.state}`;
    if (covered.has(key)) {
      throw new Error(`${label} covers '${key}', which is already covered.`);
    }
    covered.add(key);
  };
  for (const row of rows) {
    const label = `Visual acceptance row ${row.id}`;
    claim(row, label);
    const frame = frames.get(frameKeyOf(authority, row, "rowFrameKey"));
    if (!frame) {
      throw new Error(
        `${label}.${authority.rowFrameKey} '${row[authority.rowFrameKey]}' is not a frame in ${authority.contextFile}.`,
      );
    }
    if (frame.extraction.fidelity !== "COMPLETE") {
      throw new Error(
        `${label} binds node '${frame.key}', whose Figma extraction is DEGRADED (${frame.extraction.limitations.join("; ")}). Fidelity cannot be established from it: re-extract the node (split get_design_context over its children) before deriving acceptance from it.`,
      );
    }
    if (!frame.states.includes(row[authority.rowStateKey])) {
      throw new Error(
        `${label}.${authority.rowStateKey} '${row[authority.rowStateKey]}' is not one of node '${frame.key}' states (${frame.states.join(", ")}).`,
      );
    }
    if (
      row.viewport?.width !== frame.viewport.width ||
      row.viewport?.height !== frame.viewport.height
    ) {
      throw new Error(
        `${label}.viewport must be node '${frame.key}' viewport ${frame.viewport.width}x${frame.viewport.height}.`,
      );
    }
    if (hardened) {
      // Fixed, not defaulted: at v2 there is no number to argue about, so
      // authoring one is refused outright rather than capped.
      if (row.tolerance !== undefined) {
        throw new Error(
          `VISUAL_TOLERANCE_FIXED: ${label}.tolerance is authored. Version ${HARDENED_VISUAL_VERSION} compares at a fixed ±${FIXED_VISUAL_TOLERANCE.px}px with no ratio allowance, and a per-row tolerance is a waiver with a number in it. Remove it.`,
        );
      }
    } else {
      const tolerance = assertPlainObject(row.tolerance, `${label}.tolerance`);
      for (const [key, ceiling] of [
        ["px", MAX_TOLERANCE_PX],
        ["ratio", MAX_TOLERANCE_RATIO],
      ]) {
        if (
          typeof tolerance[key] !== "number" ||
          !(tolerance[key] >= 0 && tolerance[key] <= ceiling)
        ) {
          throw new Error(
            `${label}.tolerance.${key} must be an explicit number between 0 and ${ceiling}.`,
          );
        }
      }
    }
    const expect = assertPlainObject(row.expect, `${label}.expect`);
    if (Object.keys(expect).length === 0) {
      throw new Error(`${label}.expect must declare at least one visual fact.`);
    }
    for (const [name, fact] of Object.entries(expect)) {
      const at = `${label}.expect.${name}`;
      assertPlainObject(fact, at);
      assertNonEmpty(fact.locator, `${at}.locator`);
      const valid =
        // v2 lets a `px` fact carry a length *spelling* -- "16px", "50%" --
        // because normalization, not the shape check, is what decides whether
        // a unit is supported. A `rem` therefore refuses with the reason it
        // refuses for, instead of as a malformed fact.
        (fact.kind === "px" &&
          (Number.isFinite(fact.value) ||
            (hardened && typeof fact.value === "string"))) ||
        (fact.kind === "count" &&
          (Number.isInteger(fact.value) ||
            (Number.isInteger(fact.min) &&
              (fact.max === undefined ||
                (Number.isInteger(fact.max) && fact.max >= fact.min))))) ||
        (fact.kind === "equals" && fact.value !== undefined) ||
        (fact.kind === "present" && typeof fact.value === "boolean");
      if (!valid) {
        throw new Error(
          `${at} must be {kind: px, value: number} | {kind: count, value | min[, max]: integer} | {kind: equals, value} | {kind: present, value: boolean}.`,
        );
      }
      // ponytail: a count with no upper bound and a min of 0 accepts every
      // measurement a runtime can produce -- a waiver wearing a row's clothes,
      // the same reason tolerance has ceilings. Give it a max, or a min of 1.
      if (
        fact.kind === "count" &&
        fact.value === undefined &&
        fact.max === undefined &&
        fact.min <= 0
      ) {
        throw new Error(
          `${at} is unfalsifiable: {kind: count, min: ${fact.min}} with no max accepts every measurement. Give it a max, or a min of at least 1.`,
        );
      }
      // v2 closes the remaining half of that hole: `min: 1` with no max still
      // admits 1 and 9000 alike. A count is an exact number or a closed range.
      if (
        hardened &&
        fact.kind === "count" &&
        fact.value === undefined &&
        fact.max === undefined
      ) {
        throw new Error(
          `VISUAL_COUNT_UNBOUNDED: ${at} declares {kind: count, min: ${fact.min}} with no max, which accepts every count at or above ${fact.min}. Version ${HARDENED_VISUAL_VERSION} requires an exact value, or both min and max.`,
        );
      }
      if (hardened && REQUIRED_FACT_KINDS[name] !== undefined && fact.kind !== REQUIRED_FACT_KINDS[name]) {
        throw new Error(
          `${at} declares kind '${fact.kind}'; the taxonomy fixes '${name}' at kind '${REQUIRED_FACT_KINDS[name]}'.`,
        );
      }
    }
    if (hardened) {
      // Coverage: the fixed taxonomy UNION every fact the authority frame
      // established. The union half costs nothing -- those facts already exist
      // -- and the table half is what makes a one-fact PASS unauthorable.
      const groups = missingRequiredGroups(expect);
      if (groups.length > 0) {
        throw new Error(
          `VISUAL_CONTRACT_COVERAGE: ${label}.expect covers none of the required taxonomy group(s) ${groups.join(", ")}. A version ${HARDENED_VISUAL_VERSION} row asserts geometry, spacing, colour, typography, border, shadow, visibility, a bounded structural count and the visible assets; a row that asserts only what happens to match is not a contract.`,
        );
      }
      const authoritative = frame.facts ?? {};
      const unbackedFacts = Object.keys(expect).filter(
        (name) => authoritative[name] === undefined,
      );
      if (unbackedFacts.length > 0) {
        throw new Error(
          `VISUAL_CONTRACT_PROVENANCE: ${label}.expect asserts ${unbackedFacts.join(", ")}, which frame '${frame.key}' does not establish. Every version ${HARDENED_VISUAL_VERSION} fact must come from the pinned authority.`,
        );
      }
      const omitted = Object.keys(authoritative).filter(
        (name) => expect[name] === undefined,
      );
      if (omitted.length > 0) {
        throw new Error(
          `VISUAL_CONTRACT_COVERAGE: ${label}.expect omits ${omitted.join(", ")}, which frame '${frame.key}' establishes. A fact the authority carries cannot be dropped from the contract derived from it.`,
        );
      }
      // The contract value is checked against the authority value in the one
      // normalized space, which is what makes a Figma `#0B5FFF` and a browser
      // `rgb(11, 95, 255)` the same assertion rather than two.
      const expected = {};
      for (const [name, fact] of Object.entries(expect)) {
        const at = `${label}.expect.${name}`;
        let value;
        try {
          value = normalizeVisualValue(name, fact.value ?? fact.min);
        } catch (error) {
          throw new Error(`${at} ${error.message}`);
        }
        const authority = authoritative[name];
        const authorityCount = authority.value;
        const disagrees = fact.kind === "count" && fact.value === undefined
          ? !Number.isInteger(authorityCount) || authorityCount < fact.min || authorityCount > fact.max
          : JSON.stringify(authorityCount) !== JSON.stringify(value);
        if (disagrees) {
          throw new Error(
            `VISUAL_CONTRACT_DIVERGES: ${at} expects ${JSON.stringify(value)}, but frame '${frame.key}' establishes ${JSON.stringify(authority.value)}. The contract is derived from the pinned authority, never authored beside it.`,
          );
        }
        // `normalized` carries the fact's own property name, so the runtime
        // measurement is put in the same space by the one shared function at
        // comparison time -- in both engines, through one `compareVisualFact`.
        expected[name] =
          fact.value === undefined
            ? { ...fact, normalized: name }
            : { ...fact, value, normalized: name };
      }
      normalized.set(row.id, {
        ...row,
        expect: expected,
        tolerance: FIXED_VISUAL_TOLERANCE,
        version: HARDENED_VISUAL_VERSION,
        authorityFrame: frame,
      });
    }
  }
  for (const [index, item] of assertArray(
    matrix.unbacked ?? [],
    "Visual acceptance unbacked",
  ).entries()) {
    const label = `Visual acceptance unbacked[${index}]`;
    assertPlainObject(item, label);
    const backed = backedRowFor(matrix, item);
    if (backed) {
      throw new Error(
        `${label} declares '${item.uiBehaviorId}' state '${item.state}' unbacked, but row ${backed.id} explicitly binds it to Figma node '${backed[authority.rowFrameKey]}' state '${backed[authority.rowStateKey]}'. That row is authoritative; an explicitly backed state cannot be unbacked, not even by an operator.`,
      );
    }
    claim(item, label);
    assertNonEmpty(item.reason, `${label}.reason`);
    // v2, legacy-runtime only. "We captured one of six states and waived the
    // rest" is the shape this closes: if a sibling state of the same behavior
    // was captured, the capture rig demonstrably reaches this behavior, so the
    // only honest reason to leave a sibling unbacked is a recorded extraction
    // limitation on that state's own frame. figma-mcp is deliberately exempt --
    // the engine cannot know whether a design for the state exists at all, so
    // the operator stays the only judge there.
    if (hardened && authority.contextFile === LEGACY_RUNTIME_CONTEXT_FILE) {
      const captured = [...frames.values()].filter(
        (frame) =>
          frame.uiBehaviorId === item.uiBehaviorId && frame.state !== item.state,
      );
      const own = frames.get(`${item.uiBehaviorId}::${item.state}`);
      if (captured.length > 0 && !(own?.extraction?.limitations?.length > 0)) {
        throw new Error(
          `VISUAL_SIBLING_STATE_CAPTURED: ${label} leaves '${item.uiBehaviorId}' state '${item.state}' unbacked, but state(s) ${captured.map((frame) => `'${frame.state}'`).join(", ")} of the same behavior were captured from the running legacy app. Capture this state too, or record its frame in ${LEGACY_RUNTIME_CONTEXT_FILE} with the extraction.limitations that stopped the capture. An operator decision waives a state the rig cannot reach, not one it did not try.`,
        );
      }
    }
    const { candidate } = visualUnbackedCandidate({
      state,
      frames,
      matrix,
      contextDigest,
      item,
    });
    if (typeof item.decisionId !== "string" || !item.decisionId) {
      throw new Error(
        `VISUAL_UNBACKED_REQUIRES_OPERATOR: ${label} leaves '${candidate.subject.path}' without Figma visual acceptance. No agent may waive a visual state: an operator must approve candidate '${candidate.id}' (record-decision.mjs <module> --pending, then --approve at a terminal), and the entry must cite its decisionId and decisionDigest.`,
      );
    }
    requireDecision({ byId: decisions.byId, row: item, label, candidate });
  }
  const mismatchByBehavior = new Map(
    target.uiMismatches.map((row) => [row.uiBehaviorId, row]),
  );
  for (const uiBehavior of behaviors.values()) {
    if (!uiBehaviorIsRequired(uiBehavior, mismatchByBehavior.get(uiBehavior.id)))
      continue;
    for (const runtimeState of uiBehavior.runtimeStates) {
      if (!covered.has(`${uiBehavior.id}::${runtimeState}`)) {
        throw new Error(
          `VISUAL_CONTRACT_GAP: required UI behavior '${uiBehavior.id}' state '${runtimeState}' has no row in ${VISUAL_ACCEPTANCE_FILE}. Bind it explicitly to its Figma node and state, or list it under "unbacked" with its reason and an operator's VISUAL_UNBACKED decision.`,
        );
      }
    }
  }
  // v2 rows are returned normalized and with the fixed tolerance already
  // attached, so every comparison site -- both engines -- gets the hardened
  // semantics without knowing the version exists.
  return rows.map((row) => normalized.get(row.id) ?? row);
};

/** One expected fact against one runtime value; null when it holds. */
export const compareVisualFact = (fact, actual, tolerance) => {
  if (actual === undefined) return "was not measured";
  if (fact.normalized) {
    try {
      actual = normalizeVisualValue(fact.normalized, actual);
    } catch (error) {
      return `was measured as ${JSON.stringify(actual)}, which ${error.message.replace(/^VISUAL_VALUE_UNSUPPORTED: .*? value .*? /, "")}`;
    }
  }
  const observed = JSON.stringify(actual);
  if (fact.kind === "px") {
    // A percentage never became a number, so it is compared as the literal it
    // is; mixing the two would be the silent coercion normalization forbids.
    if (typeof fact.value === "string" || typeof actual === "string") {
      return JSON.stringify(fact.value) === observed
        ? null
        : `expected ${JSON.stringify(fact.value)}, observed ${observed}`;
    }
    const allowed = Math.max(tolerance.px, tolerance.ratio * Math.abs(fact.value));
    return Number.isFinite(actual) && Math.abs(actual - fact.value) <= allowed
      ? null
      : `expected ${fact.value}px ±${allowed}, observed ${observed}`;
  }
  if (fact.kind === "count") {
    const min = fact.value ?? fact.min;
    const max = fact.value ?? fact.max ?? Infinity;
    return Number.isInteger(actual) && actual >= min && actual <= max
      ? null
      : `expected ${min === max ? min : `${min}..${max}`}, observed ${observed}`;
  }
  if (fact.kind === "present") {
    return actual === fact.value
      ? null
      : `expected ${fact.value ? "present" : "absent"}, observed ${actual === true ? "present" : actual === false ? "absent" : observed}`;
  }
  return JSON.stringify(fact.value) === observed
    ? null
    : `expected ${JSON.stringify(fact.value)}, observed ${observed}`;
};

/**
 * Format 17. Compares one Figma-backed TARGET row's runtime measurements with
 * its visual acceptance row. Measurements are read from the persisted runtime
 * observation file the row references -- never from the row's own prose -- and
 * the engine, not the row's `result`, decides.
 */
const assertVisualAcceptance = async ({
  record,
  visualRow,
  label,
  roots,
  authority,
}) => {
  const refuse = (problem) => {
    throw new Error(
      `VISUAL_ACCEPTANCE_FAIL: ${label} (${visualRow.id}, Figma node ${visualRow[authority.rowFrameKey]}) ${problem}. Figma-backed states are accepted by comparing runtime measurements with ${VISUAL_ACCEPTANCE_FILE}; an authored result: "PASS" cannot verify them. Fix the target and re-measure, or record FAIL and rework the slice.`,
    );
  };
  if (
    frameKeyOf(authority, record, "recordFrameKey") !==
    frameKeyOf(authority, visualRow, "rowFrameKey")
  ) {
    refuse(
      `names ${authority.recordFrameKey} '${record[authority.recordFrameKey]}'`,
    );
  }
  const expectedViewport = `${visualRow.viewport.width}x${visualRow.viewport.height}`;
  if (`${record.viewport.width}x${record.viewport.height}` !== expectedViewport) {
    refuse(
      `ran at viewport ${record.viewport.width}x${record.viewport.height}, the contract requires ${expectedViewport}`,
    );
  }
  if (!record.screenshot) refuse("has no runtime screenshot");
  const source = assertPlainObject(record.measurements, `${label}.measurements`);
  assertTargetEvidencePath(source.reference, `${label}.measurements.reference`);
  await assertEvidenceReference(source, `${label}.measurements`, roots, {
    require: true,
  });
  let observation;
  try {
    const file = JSON.parse(
      await readFile(
        await resolveEvidencePath(evidencePathClaim(source.reference), roots),
        "utf8",
      ),
    );
    observation = source.pointer === undefined ? file : file?.[source.pointer];
  } catch (error) {
    refuse(`references measurements that are not JSON (${error.message})`);
  }
  if (!isPlainObject(observation) || !isPlainObject(observation.values)) {
    refuse('references measurements without a "values" object');
  }
  if (
    `${observation.viewport?.width}x${observation.viewport?.height}` !==
    expectedViewport
  ) {
    refuse(
      `was measured by the runtime at viewport ${observation.viewport?.width}x${observation.viewport?.height}, the contract requires ${expectedViewport}`,
    );
  }
  const failures = Object.entries(visualRow.expect).flatMap(([name, fact]) => {
    const miss = compareVisualFact(
      fact,
      observation.values[name],
      visualRow.tolerance,
    );
    return miss ? [`${name} ${miss}`] : [];
  });
  if (failures.length > 0) {
    refuse(`diverges from the design: ${failures.join("; ")}`);
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
    await validateImplementedSlice(
      root,
      sliceId ?? state.activeSlice,
      state,
      roots,
    );
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
    await assertNoUnclaimedTargetDrift(root, state, roots, slices);
    await validateGates(root, state, roots);
    await assertGatesCoverSliceScenarios(root, state, slices);
  }
};

/* ------------------------------------------------------------------ *
 * W5. FINALIZE rejects unresolved verification (format 16)
 *
 * Row terminality across the matrices and gate PASS are both
 * presence-of-positive assertions. Absence-of-negative is a different claim,
 * and only the first survives an artifact the engine did not anticipate.
 * ------------------------------------------------------------------ */

/**
 * The terminal result is identified by *location*, not by content: the
 * current-result path holds exactly one attempt -- the terminal one -- and
 * every superseded attempt lives under `rework/<slice>-<n>/`. A slice with k
 * reworks therefore has exactly k preserved attempts plus one terminal result,
 * and FINALIZE never has to disambiguate two documents that both claim to be
 * the slice's verification.
 */
const assertNoUnresolvedVerification = async (root, state, slices) => {
  if (!usesSliceRework(state)) return;
  const unresolved = [];
  const stale = [];
  for (const slice of slices) {
    const terminal = await readOptionalJson(
      path.join(root, `evidence/${slice.id}/result.json`),
      `Evidence for ${slice.id}`,
    );
    if (terminal?.result !== "PASS") {
      unresolved.push(
        `${slice.id} (terminal result is '${terminal?.result ?? "missing"}')`,
      );
      continue;
    }
    // A preserved FAIL under `rework/` is never itself a blocker -- it is the
    // required immutable record of a *resolved* failure. An unsuperseded one is.
    const attempts = reworkAttemptsOf(state, slice.id);
    if (attempts === 0) continue;
    const newest = await readOptionalJson(
      path.join(root, `${REWORK_ROOT}/${slice.id}-${attempts}/record.json`),
      `Rework record for ${slice.id}`,
    );
    if (!newest) {
      unresolved.push(
        `${slice.id} (rework attempt ${attempts} has no preserved record)`,
      );
      continue;
    }
    // Only a reworked slice owes a timestamp. A slice that never failed is
    // byte-identical to a pre-16 one and is never asked for a field it had no
    // reason to author.
    if (typeof terminal.producedAt !== "string" || Number.isNaN(Date.parse(terminal.producedAt))) {
      stale.push(
        `${slice.id} (terminal PASS carries no producedAt, so it cannot be proven newer than rework attempt ${attempts})`,
      );
      continue;
    }
    if (Date.parse(terminal.producedAt) <= Date.parse(newest.at)) {
      stale.push(
        `${slice.id} (terminal PASS produced ${terminal.producedAt}, newest rework preserved ${newest.at})`,
      );
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved verification blocks FINALIZE for: ${unresolved.join(", ")}. A slice reaches COMPLETE only on a terminal PASS at evidence/<slice-id>/result.json.`,
    );
  }
  if (stale.length > 0) {
    throw new Error(
      `Stale verification blocks FINALIZE for: ${stale.join(", ")}. A reworked slice must be reverified after its newest rework, not before it.`,
    );
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
 * W5-3. A gate that passes while naming no scenario from a slice is a gate that
 * proved nothing about it.
 */
const assertGatesCoverSliceScenarios = async (root, state, slices) => {
  if (!usesSliceRework(state)) return;
  const gates = await readOptionalJson(path.join(root, "gates.json"), "Gates");
  const covered = new Set();
  for (const gate of gates?.gates ?? []) {
    if (!["TARGETED_VERIFY", "FINAL_VERIFY"].includes(gate.id)) continue;
    for (const entry of gate.evidence ?? []) {
      for (const scenarioId of entry.scenarioIds ?? []) covered.add(scenarioId);
    }
  }
  // Only assert when the gates actually declare scenario traceability; a record
  // whose gates predate it is not retroactively held to it.
  if (covered.size === 0) return;
  const missing = [];
  for (const slice of slices) {
    const scenarioIds = slice.scenarioIds ?? [];
    if (scenarioIds.length === 0) continue;
    if (!scenarioIds.some((scenarioId) => covered.has(scenarioId))) {
      missing.push(`${slice.id} (${scenarioIds.join(", ")})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `TARGETED_VERIFY/FINAL_VERIFY evidence names no scenario from: ${missing.join(", ")}. A verification gate that covers no scenario of a slice proved nothing about that slice.`,
    );
  }
};

/* ------------------------------------------------------------------ *
 * W4. One ownership ledger for target bytes (format 16)
 *
 * `validateImplementedSlice` proves every *claimed* file is real, inside the
 * target, currently dirty and different from the pinned baseline. That is a
 * `claimed ⊆ actual` check, and the converse was never run: a target file this
 * migration modified but no slice declares was invisible to every checkpoint
 * and to FINALIZE.
 *
 * Once same-slice rework exists this gets materially worse, because "the tree
 * changed since the last checkpoint" stops being anomalous on its own. So the
 * distinction is decided from records -- never from prose and never from
 * timing.
 * ------------------------------------------------------------------ */

/**
 * W4-3: warn early, block late. Before VERIFY_SLICES no slice has claimed
 * anything, so an unclaimed path carries no information; blocking mid-flight
 * would also make ordinary editing hostile. FINALIZE is where the guarantee has
 * to hold.
 */
const DRIFT_OWNERSHIP_STEPS = new Set(["VERIFY_SLICES", "FINALIZE"]);

const DRIFT_CLASSES = Object.freeze({
  ENGINE_AUTHORED: "ENGINE_AUTHORED",
  AUTHORIZED_REWORK: "AUTHORIZED_REWORK",
  AUTHORIZED_DELEGATION: "AUTHORIZED_DELEGATION",
  OPERATOR_ACCEPTED: "OPERATOR_ACCEPTED",
  // Modified, inside a subtree some planned slice owns, and claimed by none of
  // them. This migration's business, and the only unaccounted class FINALIZE
  // refuses.
  UNCLAIMED_TARGET_DRIFT: "UNCLAIMED_TARGET_DRIFT",
  // Modified, and outside every subtree any planned slice owns.
  //
  // This used to be `UNCLAIMED_TARGET_DRIFT` as well, which made "the migration
  // cannot account for this file" and "somebody edited an unrelated file in
  // this repository" the same refusal. They are not the same fact, and
  // conflating them let an ordinary edit elsewhere in the target -- a README, a
  // sibling feature's work in progress -- hold COMPLETE hostage until a human
  // accepted a file the migration never touched.
  //
  // The engine reports these and does nothing else with them: it does not
  // claim them, accept them, modify them, or count them against the guarantee.
  // The guarantee is about bytes *this migration* changed, and these are not
  // those bytes.
  UNRELATED_USER_CHANGE: "UNRELATED_USER_CHANGE",
});

/**
 * The target subtrees the plan says this migration owns -- `targetOwner` and
 * `targetPaths`, read off the slice plan, never guessed.
 */
const plannedTargetOwners = (slices) =>
  slices
    .flatMap((slice) => [
      slice.targetOwner,
      ...(Array.isArray(slice.targetPaths) ? slice.targetPaths : []),
    ])
    .filter((owner) => typeof owner === "string" && owner)
    .map((owner) => owner.replaceAll("\\", "/").replace(/\/+$/, ""));

/**
 * A plan that declares no owners at all cannot answer the ownership question,
 * so every finding stays unclaimed: *unable to tell* is not *outside*, and only
 * one of those may be waved through.
 */
const withinPlannedScope = (relative, owners) =>
  owners.length === 0 ||
  owners.some((owner) => relative === owner || relative.startsWith(`${owner}/`));

/** Every target path any planned slice claims, in canonical target-relative form. */
const claimedTargetPaths = async (root, slices) => {
  const claimed = new Set();
  for (const slice of slices) {
    const record = await readOptionalJson(
      path.join(root, `slices/${slice.id}.json`),
      `Slice ${slice.id}`,
    );
    for (const changed of record?.changedFiles ?? []) {
      if (typeof changed !== "string") continue;
      const claim = changed.trim().split(/\s+/)[0];
      if (claim) claimed.add(claim.replaceAll("\\", "/"));
    }
  }
  return claimed;
};

/**
 * W4-1/W4-2. The set difference over data the engine already holds -- no new
 * scan, no new cost -- and then a classification, because reporting an
 * unclaimed path without saying whose it is just moves the judgement to prose.
 */
const classifyTargetDrift = async (root, state, roots, slices) => {
  if (!usesSliceRework(state) || !roots?.targetRoot) return [];
  if (!DRIFT_OWNERSHIP_STEPS.has(state.currentStep)) return [];
  const dirty = await dirtyManifest(roots.targetRoot, TARGET_DIRTY_SCOPE);
  const baseline = await readTargetBaseline(root, state);
  const changedSinceBaseline = baseline
    ? await targetBaselineDrift(roots.targetRoot, baseline)
    : null;
  const claimed = await claimedTargetPaths(root, slices);

  // A slice under an active rework legitimately re-touches its own files.
  const reworked = new Set(
    Object.keys(state.sliceReworks ?? {}).filter(
      (sliceId) => reworkAttemptsOf(state, sliceId) > 0,
    ),
  );
  const reworkOwned = new Set();
  for (const sliceId of reworked) {
    const planned = slices.find((slice) => slice.id === sliceId);
    for (const owner of planned?.targetOwner
      ? [planned.targetOwner]
      : []) {
      reworkOwned.add(owner.replaceAll("\\", "/"));
    }
  }
  // A SHARED_PREREQUISITE with a live artifact delegation: the child record
  // owns those bytes and validates them under its own lifecycle.
  const delegatedOwners = slices
    .filter((slice) => slice.artifact || slice.delegatedTo)
    .map((slice) => String(slice.targetOwner ?? "").replaceAll("\\", "/"))
    .filter(Boolean);

  // W4-4/W4-5. The acceptance lives in the append-only operator ledger, never
  // in a CLI flag and never in a state field an agent could author. `boundTo`
  // carries the path's SHA-256, so editing the file after acceptance
  // invalidates the decision the same way a changed candidate invalidates a
  // classification approval.
  const { decisions } = await readRecordedDecisions(root);
  const accepted = new Map(
    decisions
      .filter(
        (decision) =>
          decision.kind === "TARGET_DRIFT_ACCEPTED" &&
          typeof decision.subject?.path === "string",
      )
      .map((decision) => [decision.subject.path, decision.boundTo?.pathDigest]),
  );

  // Target files the *record itself* authored, not any slice: the OpenSpec
  // requirements authority the bootstrap writes, and the brief it was given.
  // They are accounted for by `requirementsAuthority.digest` and the brief pin
  // rather than by a slice, so counting them as unattributable drift would make
  // FINALIZE unreachable for every migration by construction.
  const engineAuthored = new Set(
    [state.requirementsAuthority?.source, state.brief?.path]
      .filter((value) => typeof value === "string" && value)
      .map((value) => value.replaceAll("\\", "/")),
  );

  const owners = plannedTargetOwners(slices);
  // Whether ownership is a question this record can answer at all. With owners,
  // "inside the migration's scope" and "outside it" are both decidable, and a
  // finding that lands inside is deterministic drift the AUTO principal may
  // resolve. With none, neither answer is derivable -- so every finding stays
  // unclaimed *and* stays a human decision. Ambiguity is the one drift case
  // `--mode auto` must not decide, and this is where that is recorded.
  const autoResolvable = owners.length > 0;
  const findings = [];
  for (const entry of dirty.entries) {
    const relative = entry.path.replaceAll("\\", "/");
    if (claimed.has(relative)) continue;
    if (engineAuthored.has(relative)) {
      findings.push({ path: relative, class: DRIFT_CLASSES.ENGINE_AUTHORED });
      continue;
    }
    // Outside every owned subtree: somebody else's edit. Ordered ahead of the
    // rework, delegation and acceptance branches so a path this migration never
    // owned cannot pick up a claim from one of them by accident.
    if (!withinPlannedScope(relative, owners)) {
      findings.push({
        path: relative,
        class: DRIFT_CLASSES.UNRELATED_USER_CHANGE,
        reason:
          "modified outside every target subtree this migration's slice plan owns; preserved and not attributed to this migration",
      });
      continue;
    }
    // Brownfield: already dirty before the migration started and unchanged
    // since is not this migration's doing.
    if (changedSinceBaseline && !changedSinceBaseline(relative)) continue;
    if ([...reworkOwned].some((owner) => relative.startsWith(owner))) {
      findings.push({ path: relative, class: DRIFT_CLASSES.AUTHORIZED_REWORK });
      continue;
    }
    if (delegatedOwners.some((owner) => relative.startsWith(owner))) {
      findings.push({
        path: relative,
        class: DRIFT_CLASSES.AUTHORIZED_DELEGATION,
      });
      continue;
    }
    if (accepted.has(relative)) {
      // W4-5: the acceptance binds to the bytes. Editing the file after
      // acceptance invalidates the decision, exactly as a classification
      // approval stops applying when its candidate changes.
      const current = await hashFile(path.join(roots.targetRoot, relative)).catch(
        () => null,
      );
      if (current && `sha256:${current}` === accepted.get(relative)) {
        findings.push({ path: relative, class: DRIFT_CLASSES.OPERATOR_ACCEPTED });
        continue;
      }
      findings.push({
        path: relative,
        class: DRIFT_CLASSES.UNCLAIMED_TARGET_DRIFT,
        autoResolvable,
        reason:
          "an operator accepted this path, but its bytes changed since; the acceptance no longer applies",
      });
      continue;
    }
    findings.push({
      path: relative,
      class: DRIFT_CLASSES.UNCLAIMED_TARGET_DRIFT,
      autoResolvable,
      ...(autoResolvable
        ? {}
        : {
            reason:
              "the slice plan declares no target owner, so whether this path belongs to the migration cannot be derived; only a human can say",
          }),
    });
  }
  return findings;
};

/* --------------------------------------------------------------------------
 * `--amend-slice`: an add-only correction of a reopened slice's `changedFiles`.
 *
 * A reopen returns a verified slice to VERIFY_SLICES because its UI evidence is
 * stale, not because its implementation was wrong. Sometimes re-verifying it
 * reveals that the implementation always depended on files the pinned record
 * never listed. Failing and reworking the slice would be a lie about what
 * happened; re-planning it would discard verified work. An amendment adds the
 * missing files and nothing else: the prior record is preserved byte-pinned,
 * no step or slice moves, and the plan is untouched.
 * ------------------------------------------------------------------------ */

/** Where `--amend-slice` keeps the slice record it replaces, byte-pinned. */
export const SLICE_AMENDMENT_ROOT = "slice-amendments";

// The running engine's own skill root: its source and tests are never slice work.
const ENGINE_SKILL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const TEST_LEVEL_SUFFIX = /\.(?:unit|integration|component)\.spec(\.[^./]+)$/;
const withoutExtension = (relative) => relative.replace(/\.[^./]+$/, "");
const targetRelative = (roots, absolute) =>
  path.relative(roots.targetRoot, absolute).replaceAll(path.sep, "/");

const eventNamesSlice = (event, sliceId) =>
  event.slice === sliceId ||
  (Array.isArray(event.slices) && event.slices.includes(sliceId));

/**
 * `--amend-slice`: every fact the preview shows and the locked execution
 * re-proves, from fresh reads. Each refusal is a named blocker; the amendment
 * itself is computed only once none remain.
 */
const sliceAmendmentFor = async (root, state, roots, sliceId, addFiles) => {
  const blockers = [];
  const refuse = (message) =>
    blockers.push(`--amend-slice '${sliceId}' ${message}`);
  const blocked = () => ({ blockers, sliceAmendment: null });

  // Lifecycle.
  if (!usesSliceRework(state)) {
    refuse(
      `needs format ${SLICE_REWORK_FORMAT}; this migration is recorded at format ${state.formatVersion}.`,
    );
  }
  if (state.status !== "ACTIVE" || state.currentStep !== "VERIFY_SLICES") {
    refuse(
      `is legal only on an ACTIVE record at VERIFY_SLICES; the record is '${state.status}' at '${state.currentStep}'.`,
    );
  }
  if (!Array.isArray(addFiles) || addFiles.length === 0) {
    refuse("requires at least one --add-file <path>.");
  }
  const { slices, capabilityRows } = await validatePlan(root, state, roots);
  const planned = slices.find((slice) => slice.id === sliceId);
  if (!planned) refuse("names no planned slice.");
  if (state.completedSlices.includes(sliceId)) {
    refuse(
      "is a verified slice that is not reopened; reopen it with --reopen-ui before amending it.",
    );
  } else if (
    state.activeSlice !== sliceId &&
    !state.pendingSlices.includes(sliceId)
  ) {
    refuse("is neither the active nor a pending slice.");
  }
  const events = await readHistoryEvents(root);
  const reopenedAt = events.findLastIndex(
    (event) =>
      event.event === "UI_REMEDIATION_REOPENED" &&
      eventNamesSlice(event, sliceId),
  );
  if (reopenedAt < 0) {
    refuse(
      "is not pending because of a reopen. A first implementation pass or a rework edits the slice record directly; only a slice reopened by --reopen-ui is amended.",
    );
  } else {
    if (
      events
        .slice(reopenedAt + 1)
        .some(
          (event) =>
            ["REFRESHED", "REOPENED"].includes(event.event) ||
            (eventNamesSlice(event, sliceId) &&
              event.event !== "SLICE_SCOPE_AMENDED"),
        )
    ) {
      refuse(
        "was reverified, reworked or reset after its reopen; amend a reopened slice before it is verified again.",
      );
    }
    if (
      !events
        .slice(0, reopenedAt)
        .some(
          (event) =>
            event.event === "STEP_COMPLETED" &&
            event.step === "VERIFY_SLICES" &&
            event.slice === sliceId,
        )
    ) {
      refuse("has no verified PASS in history before its reopen.");
    }
  }
  const recordRelative = `slices/${sliceId}.json`;
  const recordPath = path.join(root, recordRelative);
  const priorBytes = (await fileExists(recordPath))
    ? await readFile(recordPath)
    : null;
  let prior = null;
  try {
    prior = priorBytes ? JSON.parse(priorBytes.toString("utf8")) : null;
  } catch {
    prior = null;
  }
  if (
    !isPlainObject(prior) ||
    prior.implementationStatus !== "COMPLETE" ||
    !Array.isArray(prior.changedFiles)
  ) {
    refuse(`needs a COMPLETE implementation record at ${recordRelative}.`);
    return blocked();
  }
  if (!state.artifactHashes[recordRelative]) {
    refuse(`needs ${recordRelative} pinned; it is not.`);
  }

  // Files.
  const existing = new Set();
  for (const changed of prior.changedFiles) {
    if (typeof changed !== "string") continue;
    const resolved = await resolveChangedFile(changed, roots);
    existing.add(
      resolved
        ? targetRelative(roots, resolved)
        : changed.trim().split(/\s+/)[0],
    );
  }
  const recordAuthored = new Set(
    [state.requirementsAuthority?.source, state.brief?.path]
      .filter((value) => typeof value === "string" && value)
      .map((value) => value.replaceAll("\\", "/")),
  );
  const realTarget = await realpath(roots.targetRoot);
  const engineRoot = await realpath(ENGINE_SKILL_ROOT).catch(
    () => ENGINE_SKILL_ROOT,
  );
  const added = [];
  for (const file of addFiles ?? []) {
    const direct = path.resolve(roots.targetRoot, String(file));
    // Symlinks resolved first, so a link cannot smuggle an outside file in.
    const real = await realpath(direct).catch(() => null);
    if (real && isWithin(engineRoot, real)) {
      refuse(`cannot add '${file}': migration-engine source is never slice work.`);
      continue;
    }
    if (!isWithin(roots.targetRoot, direct) || (real && !isWithin(realTarget, real))) {
      refuse(`cannot add '${file}': it is outside the target repository.`);
      continue;
    }
    if (!real || !(await stat(real)).isFile()) {
      refuse(`cannot add '${file}': it is not an existing regular file.`);
      continue;
    }
    const relative = targetRelative(roots, direct);
    if (TARGET_DIRTY_SCOPE.exclude.some((prefix) => relative.startsWith(prefix))) {
      refuse(`cannot add '${relative}': it is in the migration engine workspace.`);
      continue;
    }
    if (recordAuthored.has(relative)) {
      refuse(
        `cannot add '${relative}': the migration record itself authors it (requirements authority or brief).`,
      );
      continue;
    }
    if (existing.has(relative) || added.includes(relative)) {
      refuse(
        `cannot add '${relative}': it is already in ${sliceId}.changedFiles. An amendment only adds files.`,
      );
      continue;
    }
    added.push(relative);
  }
  if (blockers.length > 0) return blocked();

  // Add-only by construction: the prior list, untouched, then the additions.
  const amended = { ...prior, changedFiles: [...prior.changedFiles, ...added] };
  try {
    await validateImplementedSlice(root, sliceId, state, roots, amended);
  } catch (error) {
    refuse(`would leave an invalid slice record: ${error.message}`);
    return blocked();
  }
  const amendment =
    events.filter(
      (event) =>
        event.event === "SLICE_SCOPE_AMENDED" && event.slice === sliceId,
    ).length + 1;
  const preservesAs = `${SLICE_AMENDMENT_ROOT}/${sliceId}-${amendment}/slice.json`;
  if (await fileExists(path.join(root, preservesAs))) {
    refuse(`cannot preserve to ${preservesAs}: it already exists, and preserved slice records are append-only.`);
    return blocked();
  }

  // Ownership facts for the operator. The engine proves them; it never decides.
  const drift = new Map(
    (await classifyTargetDrift(root, state, roots, slices)).map((finding) => [
      finding.path,
      finding.class,
    ]),
  );
  const otherClaims = [];
  for (const slice of slices) {
    if (slice.id === sliceId) continue;
    otherClaims.push([slice.id, await claimedTargetPaths(root, [slice])]);
  }
  const amendedStems = new Set();
  for (const changed of amended.changedFiles) {
    const resolved =
      typeof changed === "string"
        ? await resolveChangedFile(changed, roots)
        : null;
    if (resolved) amendedStems.add(withoutExtension(targetRelative(roots, resolved)));
  }
  const under = (relative, owner) => {
    try {
      const base = targetRelativePath(String(owner), roots, "Owner");
      return relative === base || relative.startsWith(`${base}/`);
    } catch {
      return false;
    }
  };
  const add = [];
  for (const relative of added) {
    const testedSource =
      relative.startsWith("tests/") && TEST_LEVEL_SUFFIX.test(relative)
        ? `src/${withoutExtension(relative.slice("tests/".length).replace(TEST_LEVEL_SUFFIX, "$1"))}`
        : null;
    const claimedBy = otherClaims
      .filter(([, claims]) => claims.has(relative))
      .map(([id]) => id);
    add.push({
      path: relative,
      identity: await fileIdentity(path.join(roots.targetRoot, relative)),
      ownershipBasis: (planned.targetPaths ?? []).some((owner) =>
        under(relative, owner),
      )
        ? "TARGET_PATH"
        : capabilityRows.some((row) => row.targetOwner && under(relative, row.targetOwner))
          ? "CAPABILITY_OWNER"
          : testedSource && amendedStems.has(testedSource)
            ? "TEST_OF_OWNED_SOURCE"
            : "OUTSIDE_PLANNED_SCOPE",
      claimedBy,
      driftClass:
        drift.get(relative) ?? (claimedBy.length > 0 ? "CLAIMED" : "NOT_DRIFT"),
    });
  }
  const amendedBytes = `${JSON.stringify(amended, null, 2)}\n`;
  return {
    blockers,
    sliceAmendment: {
      slice: sliceId,
      existingChangedFiles: prior.changedFiles,
      add,
      implementationDigestBefore: (await implementationDigests(prior, roots))
        .current,
      implementationDigestAfter: (await implementationDigests(amended, roots))
        .current,
      sliceRecordDigestBefore: `sha256:${hashContent(priorBytes)}`,
      sliceRecordDigestAfter: `sha256:${hashContent(amendedBytes)}`,
      preservesAs,
      amendment,
    },
    priorBytes,
    amendedBytes,
  };
};

/**
 * The drift candidates an operator may accept, derived under the same rules
 * `classifyTargetDrift` applies. Exported for `record-decision.mjs`, which owns
 * every approval; nothing here records anything.
 */
export const pendingTargetDriftCandidates = async (root, state, roots) => {
  // Only where drift is a meaningful question. Before slices exist nothing can
  // have claimed a file yet, so every modified path would read as unclaimed and
  // the operator would be asked to accept the migration's own work.
  if (!DRIFT_OWNERSHIP_STEPS.has(state.currentStep)) return [];
  if (!usesSliceRework(state) || !roots?.targetRoot) return [];
  const plan = await readOptionalJson(
    path.join(root, initialArtifacts.slices),
    "Slice index",
  );
  const slices = Array.isArray(plan?.slices) ? plan.slices : [];
  const unclaimed = unclaimedTargetDrift(
    await classifyTargetDrift(root, state, roots, slices),
  );
  return Promise.all(
    unclaimed.map(async (finding) => ({
      subjectPath: finding.path,
      pathDigest: `sha256:${await hashFile(
        path.join(roots.targetRoot, finding.path),
      ).catch(() => "0".repeat(64))}`,
      // Carried, not recomputed: whether ownership was derivable is a fact
      // about the plan `classifyTargetDrift` already read, and re-deriving it
      // here is how the two answers drift apart.
      autoResolvable: finding.autoResolvable !== false,
      rationale:
        finding.reason ??
        `${finding.path} was modified in the target but is claimed by no validated slice, no authorized rework, and no delegated artifact.`,
    })),
  );
};

export const unclaimedTargetDrift = (findings) =>
  findings.filter(
    (finding) => finding.class === DRIFT_CLASSES.UNCLAIMED_TARGET_DRIFT,
  );

/**
 * W4-3. Blocking mid-flight would make ordinary editing hostile, so
 * VERIFY_SLICES only reports. FINALIZE is the guarantee that matters: COMPLETE
 * must mean every byte this migration changed is accounted for by a validated
 * slice, an authorized rework, an authorized delegation, or a ledger-backed
 * operator acceptance.
 */
const assertNoUnclaimedTargetDrift = async (root, state, roots, slices) => {
  const unclaimed = unclaimedTargetDrift(
    await classifyTargetDrift(root, state, roots, slices),
  );
  if (unclaimed.length === 0) return;
  throw new Error(
    `UNCLAIMED_TARGET_DRIFT: ${unclaimed.length} modified target file(s) are attributable to no validated slice, no authorized rework, no delegated artifact, and no operator acceptance: ${unclaimed
      .map((finding) =>
        finding.reason ? `${finding.path} (${finding.reason})` : finding.path,
      )
      .join(
        ", ",
      )}. Two exits, both legitimate: claim each file in the slice it belongs to with '${engineCommand(
      "cli/discover-module.mjs",
      "<module>",
      "--amend-slice",
      "<slice>",
      "--add-file",
      "<path>",
    )}' -- add-only, at least one --add-file, on a reopened slice -- or record a TARGET_DRIFT_ACCEPTED operator decision for it. COMPLETE must mean every byte this migration changed is accounted for.`,
  );
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
const assertDiscoveryUnchanged = async (root, state, roots) => {
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
  const { runDiscoveryScan } = await import("./discovery-scan.mjs");
  const scan = await runDiscoveryScan({
    legacyRoot: roots.legacyRoot,
    moduleRoots: recorded.moduleRoots,
    declaredEntryPoints:
      recorded.declaredEntryPoints ??
      (recorded.entryPoints ?? [])
        .filter((entry) => entry.discovery === "DECLARED")
        .map((entry) => entry.path),
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

/** Where a target feature slice lives, and the only path adoption asserts on. */
const targetFeatureDirectory = (targetRoot, targetModule) =>
  path.join(targetRoot, "src/features", targetModule);

/**
 * The inverse of the greenfield check, and the guard that would have stopped a
 * record being aimed at a module beside the real one: `--adopt-target` claims
 * the target already exists, so refuse to bootstrap when it does not.
 */
const brownfieldTargetBlocker = async (
  targetRoot,
  { adoptTarget, targetModule },
) =>
  adoptTarget &&
  !(await fileExists(targetFeatureDirectory(targetRoot, targetModule)))
    ? `--adopt-target declares an existing implementation, but 'src/features/${targetModule}/' does not exist in the target repository. Nothing was written.`
    : null;

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
    return {
      ...upgradePreview,
      registryBinding,
      boundInputs,
      progressChecklist: renderProgressChecklist(
        state,
        mode ?? DEFAULT_MODE,
        "FORMAT_UPGRADE",
        formatUpgrade.nextAction,
        formatUpgrade,
      ),
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
  return {
    ...preview,
    registryBinding,
    boundInputs,
    progressChecklist: renderProgressChecklist(state, mode ?? DEFAULT_MODE),
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

/**
 * The brand an operation-sequence authorization carries, and the only channel
 * through which an `authorizedBy` can reach a `SLICE_SCOPE_AMENDED` event.
 *
 * A module-private Symbol is not expressible in argv, in JSON-RPC tool input,
 * in an environment variable, or in anything `--mode auto` computes: every one
 * of those carries strings and plain objects, and a plain object parsed from
 * any of them cannot hold this key. So the only constructor is
 * `brandSequenceAuthorization`, which `operation-sequence.mjs` reaches only
 * after the trusted approval boundary has matched a human-typed phrase against
 * the sequence it freshly derived.
 *
 * `maySelfConfirm` is untouched and still false for `--amend-slice`: this does
 * not make an amendment self-confirmable, it makes *one* human act cover an
 * ordered set of them, each still re-derived and re-proven under the lock.
 *
 * ponytail: an unforgeable in-process reference, not a signature -- the same
 * ceiling as `record-decision.mjs`'s `ask`, and for the same reason. Upgrade
 * path: a detached signature over the sequence facts, verified against a key
 * pinned at RESOLVE.
 */
const SEQUENCE_AUTHORIZATION = Symbol("start-migration/operation-sequence");

export const brandSequenceAuthorization = (evidence) =>
  Object.freeze({ [SEQUENCE_AUTHORIZATION]: Object.freeze({ ...evidence }) });

/**
 * The evidence one executed member records, or a refusal.
 *
 * Absent in, absent out: a single `--amend-slice` confirmed at a terminal is
 * still one operator act and still writes its event, it just has no sequence to
 * cite. Anything else present but unbranded is a caller trying to author the
 * audit field itself, which is exactly what the Symbol exists to refuse.
 */
export const sequenceAuthorizationEvidence = (authorization) => {
  if (authorization === null || authorization === undefined) return null;
  const evidence = authorization[SEQUENCE_AUTHORIZATION];
  if (!evidence) {
    throw new Error(
      "An operation authorization must be branded by the trusted approval boundary; a plain object is not one. Nothing was written.",
    );
  }
  return evidence;
};

const readOptionalJson = async (filePath, label) => {
  if (!(await fileExists(filePath))) return null;
  return readJson(filePath, label);
};

export const inspectSliceArtifacts = async (root) => {
  const index = await readOptionalJson(
    path.join(root, initialArtifacts.slices),
    "Slice index",
  );
  const slices = Array.isArray(index?.slices) ? index.slices : [];
  const plannedSlices = slices
    .map((slice) => slice?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  const implementedSlices = [];
  const verifiedSlices = [];

  for (const sliceId of plannedSlices) {
    const implementation = await readOptionalJson(
      path.join(root, `slices/${sliceId}.json`),
      `Slice ${sliceId}`,
    );
    const evidence = await readOptionalJson(
      path.join(root, `evidence/${sliceId}/result.json`),
      `Evidence for ${sliceId}`,
    );
    if (
      implementation?.id === sliceId &&
      implementation?.implementationStatus === "COMPLETE"
    ) {
      implementedSlices.push(sliceId);
      if (evidence?.sliceId === sliceId && evidence?.result === "PASS") {
        verifiedSlices.push(sliceId);
      }
    }
  }

  return {
    plannedSlices,
    implementedSlices,
    verifiedSlices,
  };
};

export const reconcileSliceState = async (root, state) => {
  const inspected = await inspectSliceArtifacts(root);
  const planReached =
    MIGRATION_STEPS.indexOf(state.currentStep) >=
      MIGRATION_STEPS.indexOf("IMPLEMENT_SLICES") ||
    state.currentStep === "COMPLETE" ||
    state.completedSteps.includes("PLAN");
  if (!planReached || inspected.plannedSlices.length === 0) {
    return {
      state,
      repairs: [],
      inspected,
    };
  }

  const verified = new Set(inspected.verifiedSlices);
  if (state.currentStep === "VERIFY_SLICES" && state.activeSlice) {
    verified.delete(state.activeSlice);
  }
  const implemented = new Set(inspected.implementedSlices);
  const pendingSlices = inspected.plannedSlices.filter(
    (sliceId) => !verified.has(sliceId),
  );
  const repairs = [];
  let currentStep = state.currentStep;
  let activeSlice = state.activeSlice;
  let status = state.status;

  if (pendingSlices.length > 0) {
    const activeIsPending =
      typeof activeSlice === "string" && pendingSlices.includes(activeSlice);
    const nextSlice = activeIsPending ? activeSlice : pendingSlices[0];
    const stateCanKeepActiveSlice =
      activeIsPending &&
      ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep);
    if (!stateCanKeepActiveSlice) {
      activeSlice = nextSlice;
      currentStep = "IMPLEMENT_SLICES";
    } else if (currentStep === "VERIFY_SLICES" && !implemented.has(nextSlice)) {
      currentStep = "IMPLEMENT_SLICES";
    }
    if (status === "COMPLETE") status = "ACTIVE";
  } else if (["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep)) {
    currentStep = "FINALIZE";
    activeSlice = null;
  }

  const completedSlices = inspected.plannedSlices.filter((sliceId) =>
    verified.has(sliceId),
  );
  if (
    JSON.stringify(state.completedSlices) !== JSON.stringify(completedSlices)
  ) {
    repairs.push("reconciled completedSlices with PASS evidence");
  }
  if (JSON.stringify(state.pendingSlices) !== JSON.stringify(pendingSlices)) {
    repairs.push("reconciled pendingSlices with planned slice evidence");
  }
  if (state.currentStep !== currentStep) {
    repairs.push(`repaired currentStep ${state.currentStep} -> ${currentStep}`);
  }
  if (state.activeSlice !== activeSlice) {
    repairs.push(
      `repaired activeSlice ${state.activeSlice ?? "none"} -> ${activeSlice ?? "none"}`,
    );
  }
  if (state.status !== status) {
    repairs.push(`repaired status ${state.status} -> ${status}`);
  }

  const completedSteps = new Set(state.completedSteps);
  const pendingSteps = new Set(state.pendingSteps);
  if (pendingSlices.length > 0) {
    completedSteps.delete("IMPLEMENT_SLICES");
    completedSteps.delete("VERIFY_SLICES");
    completedSteps.delete("FINALIZE");
    pendingSteps.add("IMPLEMENT_SLICES");
    pendingSteps.add("VERIFY_SLICES");
    pendingSteps.add("FINALIZE");
  }

  return {
    state: {
      ...state,
      status,
      currentStep,
      activeSlice,
      completedSteps: MIGRATION_STEPS.filter((step) =>
        completedSteps.has(step),
      ),
      pendingSteps: MIGRATION_STEPS.filter((step) => pendingSteps.has(step)),
      completedSlices,
      pendingSlices,
    },
    repairs,
    inspected,
  };
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

const removeEmptyParents = async (start, boundary) => {
  let current = path.resolve(start);
  const limit = path.resolve(boundary);
  while (current !== limit && isWithin(limit, current)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) return;
      throw error;
    }
    current = path.dirname(current);
  }
};

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

const sameFile = async (left, right) => {
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
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
  const roots = {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  };
  if (!usesSliceRework(state)) {
    throw new Error(
      `--rework-slice needs format ${SLICE_REWORK_FORMAT}; migration '${resolved.canonical}' is recorded at format ${state.formatVersion}. A record runs the lifecycle it was born under.`,
    );
  }
  if (state.currentStep !== "VERIFY_SLICES") {
    throw new Error(
      `--rework-slice is legal only at VERIFY_SLICES; the current checkpoint is '${state.currentStep}'.`,
    );
  }
  if (state.activeSlice !== sliceId) {
    throw new Error(
      `--rework-slice names '${sliceId}', but the active slice is '${state.activeSlice ?? "none"}'. Only the slice currently under verification can be reworked.`,
    );
  }

  const resultRelative = `evidence/${sliceId}/result.json`;
  const resultPath = path.join(root, resultRelative);
  if (!(await fileExists(resultPath))) {
    throw new Error(
      `--rework-slice requires a recorded verification result at ${resultRelative}; none exists. Nothing was written.`,
    );
  }
  // Raw bytes, read once and preserved unchanged. No parse-and-reserialize:
  // key order, whitespace and line endings are part of what was recorded.
  const preservedBytes = await readFile(resultPath);
  const evidence = assertPlainObject(
    JSON.parse(preservedBytes.toString("utf8")),
    `Evidence for ${sliceId}`,
  );
  const { defects, claims } = await validateFailedSliceResult(
    root,
    sliceId,
    evidence,
    roots,
  );

  const attempt = reworkAttemptsOf(state, sliceId) + 1;
  // The preview reports this as a BLOCKED outcome naming the slice; this is the
  // backstop for a caller that reached the lock without one.
  if (attempt > MAX_SLICE_REWORKS) {
    throw new Error(reworkLimitBlocker(sliceId));
  }
  const directory = `${REWORK_ROOT}/${sliceId}-${attempt}`;
  if (await fileExists(path.join(root, directory))) {
    throw new Error(
      `${directory} already exists. Rework attempts are append-only and an attempt number is never reused; nothing was written.`,
    );
  }

  // Every file the transaction writes, built completely before anything lands.
  const writes = [[`${directory}/result.json`, preservedBytes]];
  for (const [index, claim] of claims.entries()) {
    const source = await resolveEvidencePath(claim, roots);
    if (!source) {
      throw new Error(
        `${sliceId} evidence defects[${index}].evidenceReference names '${claim}', which no longer resolves. Nothing was written.`,
      );
    }
    writes.push([
      preservedEvidencePath(sliceId, attempt, claim),
      await readFile(source),
    ]);
  }
  // Bare hex, the same shape every other `artifactHashes` pin uses, so the
  // standard completed-hash validation covers these without a special case.
  const preserved = {};
  for (const [relative, bytes] of writes) {
    preserved[relative] = hashContent(bytes);
  }
  const recordRelative = `${directory}/record.json`;
  const record = `${JSON.stringify(
    {
      version: 1,
      sliceId,
      attempt,
      at: now(),
      operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
      // Metadata *about* the preserved bytes. It never stands in for them.
      priorEvidenceDigest: `sha256:${hashContent(preservedBytes)}`,
      priorRevision: state.revision,
      defects: defects.map((defect) => ({
        traceId: defect.traceId ?? null,
        scenarioId: defect.scenarioId ?? null,
        observed: defect.observed,
        expected: defect.expected,
        evidenceReference: defect.evidenceReference,
        hash: defect.hash,
      })),
      preserved,
    },
    null,
    2,
  )}\n`;
  writes.push([recordRelative, Buffer.from(record, "utf8")]);
  preserved[recordRelative] = hashContent(record);

  const artifactHashes = { ...state.artifactHashes, ...preserved };
  // Released only now, and only after every preserved path is in the pin set.
  delete artifactHashes[`slices/${sliceId}.json`];
  delete artifactHashes[resultRelative];

  const reworked = {
    ...state,
    status: "ACTIVE",
    currentStep: "IMPLEMENT_SLICES",
    activeSlice: sliceId,
    completedSteps: state.completedSteps.filter(
      (step) => !["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"].includes(step),
    ),
    completedSlices: state.completedSlices.filter((id) => id !== sliceId),
    pendingSlices: [...new Set([sliceId, ...state.pendingSlices])],
    sliceReworks: { ...(state.sliceReworks ?? {}), [sliceId]: attempt },
    invalidatedArtifacts: [`slices/${sliceId}.json`, resultRelative],
    evidenceFreshness: "STALE",
    nextAction: `Fix the ${defects.length} recorded defect(s) in slice '${sliceId}', then reverify it. Attempt ${attempt} of ${MAX_SLICE_REWORKS}.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "SLICE_REWORKED",
    from: "VERIFY_SLICES",
    step: "IMPLEMENT_SLICES",
    slice: sliceId,
    attempt,
    defects: defects.length,
    preserved: Object.keys(preserved).sort(),
    revision: reworked.revision,
  };

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

/** The one line an auto adoption prints, so both CLIs report it identically. */
export const renderToolkitAdoption = (adoption) =>
  adoption?.changed
    ? `Toolkit identity: ${
        adoption.previous ? renderToolkitIdentity(adoption.previous) : "none"
      } -> ${renderToolkitIdentity(adoption.next)} (adopted under --mode auto).\n`
    : "";

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
 * One ordered, frozen row per adjacent format increment at or above
 * `FORMAT_UPGRADE_FLOOR`. It lives here, beside the code it names, rather than
 * in a module of its own: a registry module importing this engine while this
 * engine reads the registry is an ESM cycle, and `format-upgrade.mjs` holds
 * everything about the walk that is not engine-specific.
 *
 * `domain` is not "does this increment apply" -- it always applies. It answers
 * only whether *this record* needs the row's domain work; a `NO_OP` still
 * commits the increment.
 */
export const FORMAT_UPGRADERS = Object.freeze([
  Object.freeze({
    from: VISUAL_ACCEPTANCE_FORMAT,
    to: REQUIRED_OBSERVATIONS_FORMAT,
    id: "UI_OBSERVATIONS_ADOPTED",
    version: 1,
    requiredInput: Object.freeze({
      kind: "candidateFile",
      path: UI_OBSERVATIONS_CANDIDATE_FILE,
      authority: "legacy",
      description:
        "A complete inventories/legacy.json authored from legacy runtime/source evidence and the pinned OpenSpec requirements, differing from the pinned inventory only by added requiredObservations. TARGET proof cannot supply it.",
    }),
    // The old-format authority this row consumes, and the boundary that makes
    // it exclusive. Bootstrap writes `inventories/legacy.json` as a scaffold
    // long before DISCOVER_LEGACY validates and pins it, and the scaffold's
    // `hasVisibleUi: false` is not authority about anything -- so activation
    // reads the *pin*, the one artifact of the successful DISCOVER_LEGACY
    // advance, and never the file's contents. Before it exists the record is
    // owed this increment and left to produce the authority; the moment it
    // does, the window closes on itself with no step allow-list anywhere.
    activation: Object.freeze({
      predicate: (state) =>
        Boolean(state?.artifactHashes?.[initialArtifacts.legacyInventory]),
      prerequisite: Object.freeze({
        kind: "pinnedArtifact",
        path: initialArtifacts.legacyInventory,
        description:
          "the validated and pinned authoritative legacy inventory produced by DISCOVER_LEGACY",
      }),
    }),
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
  }),
]);

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
  { identityBlocker = null } = {},
) => {
  const recordFormat = state?.formatVersion ?? 1;
  const increment = nextIncrement(
    FORMAT_UPGRADERS,
    recordFormat,
    MIGRATION_FORMAT_VERSION,
    FORMAT_UPGRADE_FLOOR,
  );
  if (!increment) return null;
  const { from, to, row } = increment;
  const cursor = {
    recordFormat,
    runtimeFormat: MIGRATION_FORMAT_VERSION,
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
 * The freeze, and the second gate under it: while an increment is active, no
 * lifecycle mutation may run. Called from every mutating lifecycle path under
 * its own module lock, after the toolkit-identity gate and before any write.
 *
 * Deliberately independent of the classifier: "is an increment owed and active"
 * is decided from `(formatVersion, runtime format, registry, floor, persisted
 * pins)` alone -- no I/O, no plan, no domain read -- so a record whose upgrade
 * cannot even be classified still freezes, and the guard cannot itself fail
 * open on a bad read.
 *
 * Owed is not enough: an increment whose old-format prerequisite the lifecycle
 * has not produced yet is not exclusive, because freezing there would freeze
 * the very step that produces it. `upgradeIsActive` is fail-closed, so a
 * missing row still refuses.
 */
export const assertNoPendingFormatUpgrade = (state, name, action) => {
  const increment = nextIncrement(
    FORMAT_UPGRADERS,
    state?.formatVersion ?? 1,
    MIGRATION_FORMAT_VERSION,
    FORMAT_UPGRADE_FLOOR,
  );
  if (!increment) return;
  if (!upgradeIsActive(increment.row, state)) return;
  throw Object.assign(
    new Error(
      `${action} is refused while a format upgrade is owed: the record is at format ${increment.from} and this toolkit is at format ${MIGRATION_FORMAT_VERSION}, so the ${increment.from} -> ${increment.to} increment commits first and nothing else may move. Nothing was written. Run '/start-migration ${name ?? state?.migrationId}' and supply whatever the reported FORMAT UPGRADE REQUIRED input names.`,
    ),
    { formatUpgrade: true },
  );
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
  hooks,
}) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const root = migrationRoot(registryData.targetRoot, resolved.canonical);
  const { state } = await readState(registryData.targetRoot, resolved.canonical);
  const pending = await pendingFormatUpgrade(root, state, resolved.canonical, {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  });
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

// COMPLETE: a visible-UI parity audit. ACTIVE at VERIFY_SLICES/FINALIZE:
// stale-evidence recovery for completed slices lacking playwright-ui-proof/v1.
const reopenUiEligible = (state) =>
  state.status === "COMPLETE" ||
  (state.status === "ACTIVE" &&
    ["VERIFY_SLICES", "FINALIZE"].includes(state.currentStep));

const reopenUiIneligible = (state) =>
  `--reopen-ui is legal only for a COMPLETE migration, or an ACTIVE one at VERIFY_SLICES or FINALIZE; the current status is '${state.status}' at '${state.currentStep}'.`;

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
    formatVersion: MIGRATION_FORMAT_VERSION,
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
        progressChecklist: renderProgress(progress),
      };
    }
  }
  return {
    ...snapshot,
    statePath: context.statePath,
    progressChecklist: renderProgressChecklist(state, mode ?? DEFAULT_MODE),
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
    nextWork: complete
      ? null
      : nextWorkKind === "RUN_ARTIFACT"
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
  if (progress.nextWork) lines.push(`next: ${progress.nextWork.checkpoint}`);
  return `${lines.join("\n")}\n`;
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

export const advanceMigration = async ({
  registryPath,
  moduleName,
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
  return withModuleLock(registryData.targetRoot, resolved.canonical, () =>
    advanceUnderLock({ registryData, resolved, step, slice, preview, hooks }),
  );
};

const advanceUnderLock = async ({
  registryData,
  resolved,
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
  const validated = await validateStep(
    context.root,
    state,
    currentStep,
    activeSlice,
    {
      legacyRoot: registryData.legacyRoot,
      targetRoot: registryData.targetRoot,
    },
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
    throw new Error(
      "Baseline is valid, but the migration mapping is not registered. Run update-migration-registry.mjs before advancing.",
    );
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
