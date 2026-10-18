/**
 * Formats: the module record's contract -- versions, the format predicates,
 * historical compatibility, the lifecycle steps and the record layout. The
 * state-shape validators are `state.mjs`.
 */

import { sha256Json } from "../shared/index.mjs";
import { HISTORY_FILE } from "./record.mjs";
import { renderToolkitIdentity } from "./toolkit-identity.mjs";
import { nextIncrement, upgradeIsActive } from "./upgrade.mjs";

export const RESUMABLE_CONTRACT_VERSION = 5;

export const MIGRATION_FORMAT_VERSION = 21;

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
 * Format 19: a module decision's authority is resolved *directly* from the
 * verified ledger against the current full candidate digest and the trusted
 * policy pin, instead of from a `decisionId`/`decisionDigest` receipt copied
 * into an agent-authored record file. Classification is authored at
 * `version: 2`, which carries proposal, rationale, evidence and targets and
 * explicitly rejects those receipt fields -- a record that both cites a receipt
 * and claims direct authority is ambiguous, and an ambiguous authority is not
 * one.
 *
 * Active for new records. Existing records reach 19 only through explicit
 * pre-pin adoption; ordinary advances never reinterpret historical authority.
 */
export const DIRECT_LEDGER_DECISIONS_FORMAT = 19;

export const usesDirectLedgerDecisions = (state) =>
  (state?.formatVersion ?? 1) >= DIRECT_LEDGER_DECISIONS_FORMAT;

/** Format 20 pins authored appearance claims and measured scroll acceptance. */
export const UI_COVERAGE_FORMAT = 20;

export const usesUiCoverage = (state) =>
  (state?.formatVersion ?? 1) >= UI_COVERAGE_FORMAT;

/**
 * Format 21 pins the legacy API response contract (discovery scanner algorithm
 * 5) and holds the OpenSpec and every slice's evidence to it.
 */
export const API_CONTRACT_FORMAT = 21;

export const usesApiContract = (state) =>
  (state?.formatVersion ?? 1) >= API_CONTRACT_FORMAT;

/**
 * The two independent controls, never inferred from one constant.
 *
 * `MIGRATION_FORMAT_SUPPORTED` is the highest format this engine can read,
 * validate, test and -- when explicitly selected -- move a record to.
 * `FORMAT_ACTIVE_FOR_NEW_MIGRATIONS` is the format ordinary creation stamps.
 * Creation and compatibility are independent of the historical upgrade cursor.
 */
export const MIGRATION_FORMAT_SUPPORTED = API_CONTRACT_FORMAT;

export const FORMAT_ACTIVE_FOR_NEW_MIGRATIONS = MIGRATION_FORMAT_VERSION;

/**
 * The format from which every increment is owned by the upgrade registry
 * (`FORMAT_INCREMENTS`, below): at or above it, `state.formatVersion` is a real
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
export const usesSourceAttribution = (state) =>
  usesMultiSource(state) && (state?.legacySources?.length ?? 0) > 1;

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
export const SELF_HEALING_FORMAT_VERSIONS = new Set(
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
 * Other listed bumps are additive and derivable. Formats 17–21 have separate
 * explicit adoption rules because they add authored evidence or authority.
 */
export const NON_PROMOTING_FORMAT_VERSIONS = Object.freeze([
  DISCOVERY_COMPLETENESS_FORMAT,
  CAPABILITY_OWNERSHIP_FORMAT,
  VISUAL_ACCEPTANCE_FORMAT,
  REQUIRED_OBSERVATIONS_FORMAT,
  // 19 changes where a decision's authority comes from, so promoting a record
  // into it would reinterpret authority it already recorded under citation
  // rules. It is reached only by the explicit, journalled pre-pin adoption.
  DIRECT_LEDGER_DECISIONS_FORMAT,
  UI_COVERAGE_FORMAT,
  API_CONTRACT_FORMAT,
]);

/**
 * W10-2. The format an advance stamps, as a declarative table scanned
 * highest-first instead of an ordered chain of negations. It never promotes an
 * older record into a lifecycle step, an authored artifact, or a vocabulary it
 * never ran. Adding a format is one row here plus one constant above; there is
 * no third place, which is what the negation chain kept growing.
 */
export const FORMAT_FEATURES = [
  [API_CONTRACT_FORMAT, usesApiContract],
  [UI_COVERAGE_FORMAT, usesUiCoverage],
  [DIRECT_LEDGER_DECISIONS_FORMAT, usesDirectLedgerDecisions],
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

export const stampedFormatVersion = (state) => {
  // Lowest unmet feature wins: a record that predates the capability matrix is
  // stamped 10 even though it also predates every later feature.
  const unmet = FORMAT_FEATURES.filter(([, uses]) => !uses(state));
  // The ceiling is the *supported* format, not the active one, so a record
  // already at 19 is re-stamped 19 rather than demoted to 18. An 18 record
  // leaves `usesDirectLedgerDecisions` unmet and is stamped 18, which is what
  // keeps an ordinary advance from promoting it.
  return unmet.length === 0
    ? MIGRATION_FORMAT_SUPPORTED
    : Math.min(...unmet.map(([version]) => version)) - 1;
};

/** The supported formats, for the SKILL.md compatibility table (W10-3). */
export const SUPPORTED_FORMAT_VERSIONS = Object.freeze(
  Array.from(
    { length: MIGRATION_FORMAT_SUPPORTED - EARLIEST_SUPPORTED_FORMAT + 1 },
    (_unused, index) => EARLIEST_SUPPORTED_FORMAT + index,
  ),
);

/** Whether a record at this format still executes under the current contract. */
export const formatIsSupported = (version) =>
  version === MIGRATION_FORMAT_VERSION ||
  version === MIGRATION_FORMAT_SUPPORTED ||
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
export const ANCHORED_FORMAT_VERSION = 9;

/**
 * Whether the record must carry `integrity.json`, its history anchor and the
 * baseline-row pin. Reads `state.formatVersion` unguarded, as every caller
 * did: they all hold a validated state.
 */
export const usesIntegrityAnchor = (state) =>
  (state.formatVersion ?? 1) >= ANCHORED_FORMAT_VERSION;

export const UPGRADABLE_CONTRACT_VERSION = 4;

export const UPGRADABLE_FORMAT_VERSION = 3;

/**
 * Explicit source-version classification. Contract 5 never executes an older
 * contract and never converts one implicitly; it routes the operator to the
 * explicit upgrade command and leaves every file untouched.
 *
 * Formats renders no command (baseline §4.1): the caller passes
 * `upgradeCommandFor`, and `resumable-migration.mjs` binds it, so the refusal
 * bytes are the ones the engine always printed.
 */
export const recordCompatibilityBlocker = (state, moduleName, upgradeCommandFor) => {
  const contractVersion = state.contractVersion;
  const formatVersion = state.formatVersion ?? 1;
  if (
    contractVersion === RESUMABLE_CONTRACT_VERSION &&
    formatIsSupported(formatVersion)
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
    formatVersion > MIGRATION_FORMAT_SUPPORTED
  ) {
    return `Migration '${moduleName}' uses contract ${contractVersion} format ${formatVersion}, which is newer than the supported contract ${RESUMABLE_CONTRACT_VERSION} format ${MIGRATION_FORMAT_SUPPORTED}. Update start-migration before continuing. No file was changed.`;
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

export const UI_PROOF_FORMAT = "playwright-ui-proof/v1";

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

/**
 * Format 15, brownfield only: what the target repository already contained when
 * the record was created, committed *and* uncommitted. A revision alone cannot
 * answer it -- pre-existing work is very often an uncommitted edit, and
 * `validateImplementedSlice` would happily accept one as slice work. Written
 * once at RESOLVE and pinned into `artifactHashes`, so it can never be
 * rewritten later to launder work into or out of the baseline.
 */
export const TARGET_BASELINE_FILE = "inventories/target-baseline.json";

export const STEP_FILES = {
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

export const initialArtifacts = {
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
  history: HISTORY_FILE,
};

/**
 * The typed compatibility state. A module-19 path that meets authority it
 * cannot express -- an artifact-13 citation, a pinned pre-19 decision artifact
 * -- surfaces this instead of reinterpreting the old authority as new, and
 * instead of freezing the record.
 */
export const LEGACY_COMPATIBILITY_ACTION_REQUIRED =
  "LEGACY_COMPATIBILITY_ACTION_REQUIRED";

export class LegacyCompatibilityActionRequired extends Error {
  constructor(message) {
    super(`${LEGACY_COMPATIBILITY_ACTION_REQUIRED}: ${message}`);
    this.name = "LegacyCompatibilityActionRequired";
    this.compatibilityAction = LEGACY_COMPATIBILITY_ACTION_REQUIRED;
  }
}

/**
 * Three attempts, mirroring the gate `attempts` bound. A slice that cannot be
 * verified in three is a planning defect, not an implementation one, and must
 * surface as a blocker naming the slice rather than as a fourth loop.
 */
export const MAX_SLICE_REWORKS = 3;

/** The one line an auto adoption prints, so both CLIs report it identically. */
export const renderToolkitAdoption = (adoption) =>
  adoption?.changed
    ? `Toolkit identity: ${
        adoption.previous ? renderToolkitIdentity(adoption.previous) : "none"
      } -> ${renderToolkitIdentity(adoption.next)} (adopted under --mode auto).\n`
    : "";

/**
 * The pre-pin eligibility window, and the typed refusal outside it.
 *
 * A record whose classification, discovery scan or any decision-bearing
 * artifact is already pinned recorded that authority under citation rules.
 * Moving it to 19 would reinterpret those receipts as direct authority, which
 * is exactly the promotion the compatibility boundary forbids -- so it is
 * refused as a compatibility *action*, not as a failure: the record keeps
 * running under its historical rules, or the operator deliberately starts a
 * new one.
 */
export const DIRECT_LEDGER_PINNED_ARTIFACTS = Object.freeze([
  MODULE_CLASSIFICATION_FILE,
  DISCOVERY_SCAN_FILE,
]);

export const assertDirectLedgerEligible = (state) => {
  if ((state?.formatVersion ?? 1) !== REQUIRED_OBSERVATIONS_FORMAT) {
    throw new LegacyCompatibilityActionRequired(
      `only a format-${REQUIRED_OBSERVATIONS_FORMAT} record can adopt direct ledger decisions; this record is format ${state?.formatVersion ?? 1}.`,
    );
  }
  if (state?.status === "COMPLETE") {
    throw new LegacyCompatibilityActionRequired(
      "this record is COMPLETE. A finished record is historical; its decisions keep the citation semantics they were validated under.",
    );
  }
  const pinned = DIRECT_LEDGER_PINNED_ARTIFACTS.filter(
    (artifact) => state?.artifactHashes?.[artifact],
  );
  if (pinned.length > 0) {
    throw new LegacyCompatibilityActionRequired(
      `${pinned.join(", ")} is already pinned, so this record's decision-bearing artifacts were authored and validated under citation rules. Promoting them to direct ledger authority would reinterpret approvals nobody re-reviewed. Resume under the historical rules, or start a new record to get format ${DIRECT_LEDGER_DECISIONS_FORMAT}.`,
    );
  }
};

/**
 * What the operator confirms, and the digest they confirm it by. Derived from
 * the record as it stands, so a record that moved between preview and commit
 * produces a different digest and the commit refuses.
 */
export const directLedgerAdoptionPreview = (state) => ({
  migrationId: state.migrationId,
  revision: state.revision,
  from: REQUIRED_OBSERVATIONS_FORMAT,
  to: DIRECT_LEDGER_DECISIONS_FORMAT,
  currentStep: state.currentStep,
  effect:
    "Module decisions stop being cited by decisionId/decisionDigest in the record and are resolved directly from the verified ledger against the current candidate digest and the pinned trusted policy. No existing decision is reinterpreted, invented or carried over; classification must be authored at version 2.",
});

export const directLedgerAdoptionDigest = (state) =>
  sha256Json(directLedgerAdoptionPreview(state));

/**
 * The pure half of the module format-upgrade registry (baseline §4.1): one
 * ordered, frozen row per adjacent format increment at or above
 * `FORMAT_UPGRADE_FLOOR` -- which increment exists, the input it asks for, and
 * the activation boundary that makes it exclusive. How a row runs (`domain`,
 * `plan`, `commit`) is the lifecycle's handler map in
 * `resumable-migration.mjs`, which joins both into `FORMAT_UPGRADERS`.
 */
export const FORMAT_INCREMENTS = Object.freeze([
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
  }),
  // 18 -> 19. Registered so `assertRegistryCoverage` is satisfied up to the
  // supported format, and reachable *only* from the explicit adoption path:
  // the ordinary cursor runs at `FORMAT_ACTIVE_FOR_NEW_MIGRATIONS`, so an 18
  // record owes nothing, is never frozen behind this row, and is never
  // promoted by an advance. `assertDirectLedgerEligible` is the pre-pin
  // window; outside it the record stays at 18 and usable.
  Object.freeze({
    from: REQUIRED_OBSERVATIONS_FORMAT,
    to: DIRECT_LEDGER_DECISIONS_FORMAT,
    id: "DIRECT_LEDGER_DECISIONS_ADOPTED",
    version: 1,
    // Nothing is authored. The record's decision-bearing artifacts are not yet
    // pinned -- that is the eligibility window -- so there is nothing to
    // transform, only a stamp to move. What makes it explicit is the
    // confirmation digest, not a file.
    requiredInput: null,
    activation: null,
  }),
  // Authored legacy claims cannot be inferred from a completed format-19
  // inventory. Existing records retain format-19 semantics; new records start
  // at 20. A separate renewed-validation workflow would be needed to adopt.
  Object.freeze({
    from: DIRECT_LEDGER_DECISIONS_FORMAT,
    to: UI_COVERAGE_FORMAT,
    id: "UI_COVERAGE_ADOPTED",
    version: 1,
    requiredInput: null,
    activation: null,
  }),
  // A completed format-20 OpenSpec was never held to the source API contract,
  // and its slices never proved it. Existing records keep format-20 semantics.
  Object.freeze({
    from: UI_COVERAGE_FORMAT,
    to: API_CONTRACT_FORMAT,
    id: "API_CONTRACT_ADOPTED",
    version: 1,
    requiredInput: null,
    activation: null,
  }),
]);

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
    FORMAT_INCREMENTS,
    state?.formatVersion ?? 1,
    REQUIRED_OBSERVATIONS_FORMAT,
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
