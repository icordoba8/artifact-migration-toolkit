/**
 * Lifecycle: the module record -- step pins, the integrity anchor, the
 * append-only ledger and history checks, the advance journal, `readState` and
 * its state-graph validation, and recovery of an interrupted advance. Moved
 * verbatim from `resumable-migration.mjs` (Track A8).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isBrownfield } from "../census/index.mjs";
import {
  AUTO_DECISIONS_FILE,
  CAPABILITY_OWNERSHIP_FILE,
  DECISIONS_FILE,
  digestToolkitIdentity,
  DISCOVERY_SCAN_FILE,
  FIGMA_CONTEXT_FILE,
  initialArtifacts,
  INTEGRITY_FILE,
  isUiObservationsAdoption,
  LEGACY_RUNTIME_CONTEXT_FILE,
  MODULE_CLASSIFICATION_FILE,
  renderToolkitIdentity,
  STEP_FILES,
  stepsFor,
  TARGET_BASELINE_FILE,
  TOOLKIT_IDENTITY_EVENTS,
  toolkitIdentityKey,
  UI_OBSERVATIONS_ADOPTION_ROOT,
  UI_REMEDIATION_FILE,
  usesCapabilityOwnership,
  usesIntegrityAnchor,
  validateToolkitIdentity,
  VISUAL_ACCEPTANCE_FILE,
} from "../formats/index.mjs";
import {
  assertArray,
  assertNonEmpty,
  assertPlainObject,
  contentIdentityMatches,
  isLexicallyWithin as isWithin,
  isPlainObject,
  sha256Hex as hashContent,
} from "../shared/index.mjs";
import {
  appendHistory,
  assertUnanchoredHistoryTail,
  atomicWrite,
  digestArtifactHashes,
  fileExists,
  fileIdentity,
  fileIdentityMatches,
  historyAnchorNow,
  historyAnchorOf,
  historyTailOf,
  isTornAppendOf,
  migrationRoot,
  prepareHistoryEvent,
  readHistoryEvents,
  readIntegrity,
  readJson,
  removeDurably,
  renderIntegrity,
  REOPEN_ROOT,
  sealHistoryTail,
  statePathFor,
} from "../store/index.mjs";
import {
  assertAdvanceJournal,
  assertJournalTargets,
  readJournal,
  recoverJournal,
  refuseJournal,
} from "./journal.mjs";
import { pinsAuthorityContext, usesVisualContract } from "../visual/index.mjs";
import { assertLateDecisionsAreAppendable } from "../decisions/index.mjs";
import { reworkPathParts } from "../slices/index.mjs";
import { ADOPTION_ROOT, slicePhaseOpen, validateStateShape } from "./checkpoints.mjs";
import { assertNoPendingTransaction } from "./registry.mjs";

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

export const IMMUTABLE_STEP_ARTIFACTS = {
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
export const hashPinnedArtifact = async (root, relativePath) => {
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
export const pinnedArtifactMatches = async (root, relativePath, expected) => {
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
export const renderIntegrityNow = async (root, state, event) => {
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
const assertIntegrityAnchor = async (root, state, proposed) => {
  const integrity = proposed ?? (await readIntegrity(root));
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
export const briefDigestFor = async (targetRoot, brief) => {
  const absolute = path.resolve(targetRoot, brief);
  if (!isWithin(targetRoot, absolute)) return "OUTSIDE_TARGET";
  try {
    return `sha256:${hashContent(await readFile(absolute, "utf8"))}`;
  } catch {
    return "MISSING";
  }
};

// The journal that makes one checkpoint transition recoverable across the gap
// between the state write and the history append. It is the only journal in the
// main workflow; initialization uses the same file name under its own root.
export const ADVANCE_JOURNAL = "advance.journal";

/** The DR13 journal reader: `null`, `{ corrupt, file }` or the journal with its `file`. */
export const readAdvanceJournal = async (root) => {
  const found = await readJournal(path.join(root, ADVANCE_JOURNAL));
  return found && (found.corrupt ? found : { ...found.journal, file: found.file });
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
 * @param {null | object} [pendingJournal] the advance journal whose event an
 *   in-flight transition is replayed with; omitted, it is read from disk. Pass
 *   `null` for a strict replay of history alone -- what recovery uses to prove
 *   it actually completed before dropping the journal.
 * @returns {Promise<null | { toRevision: number }>} the in-flight transition
 *   when the state is one journalled event ahead of history.
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

  // A crash between the state write and the history append leaves state one
  // revision ahead of the record, with the journal naming the missing event.
  // That event is replayed too (DR13), so the in-flight state is proven, not
  // merely tolerated.
  let inFlight = false;
  const replayed = function* () {
    yield* events.slice(1);
    if (journal && !journal.corrupt && journal.toRevision === state.revision && revision === state.revision - 1 && isPlainObject(journal.event)) {
      inFlight = true;
      yield journal.event;
    }
  };
  for (const event of replayed()) {
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
  return inFlight ? { toRevision: state.revision } : null;
};

/** Appends `event` unless the recorded revision is already present. */
export const appendHistoryOnce = async (targetRoot, root, event) => {
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
 * Completes or discards an interrupted checkpoint transition. Runs under the
 * module lock at the start of every mutating command, so a new process always
 * finds a consistent state without an operator touching any file. The DR13
 * advance adapter classifies before it writes: the persisted revision is the
 * journal's from- or to-revision, the anchor one of its two recorded bytes,
 * a history tail only a torn append of this event, and the state replays from
 * history plus, at most, this one event. It retires only after the strict proof.
 */
export const recoverPendingAdvance = (targetRoot, root, statePath) => {
  const file = path.join(root, ADVANCE_JOURNAL);
  // An unreadable journal is the one case where nothing can be proven; a
  // *failed* recovery keeps its journal, so this fails and keeps it.
  const unreadable = () =>
    `An interrupted checkpoint transition left an unreadable journal at ${file}. It records a transition that cannot be proven completed or discarded, so it was preserved exactly as found; investigate it before continuing. Nothing was changed.`;
  return recoverJournal(file, { unreadable, recover: async (journal) => {
    assertAdvanceJournal(file, journal);
    const stateBytes = await readFile(statePath, "utf8");
    const state = await readJson(statePath, "Migration state");
    const committed = state.revision === journal.toRevision;
    if (!committed && state.revision !== journal.fromRevision) refuseJournal(file, `is for revision ${journal.fromRevision} -> ${journal.toRevision}, which does not match the persisted revision ${state.revision}`);
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const anchor = (await fileExists(integrityPath)) ? await readFile(integrityPath, "utf8") : null;
    const { integrity, restore = [] } = journal;
    if (integrity && anchor !== integrity.content && anchor !== integrity.before) refuseJournal(file, "cannot be classified: integrity.json is neither its before nor its after anchor");
    // Only the append after the state write can tear history: a tail is this event's, of a committed transition.
    const tail = await historyTailOf(targetRoot, root);
    if (tail.length && !(committed && isTornAppendOf(tail, journal.event))) refuseJournal(file, "cannot be classified: history ends in bytes that are not a torn append of its event");
    await assertStateGraph(root, state, journal);
    if (committed) {
      // The anchor in effect after recovery (the journal's, else the one on disk; absent only before anchors existed) agrees with this state and history before any write.
      const prove = async (proposed) => { if (!isPlainObject(proposed)) return false; await readHistoryEvents(root, proposed, journal); await assertIntegrityAnchor(root, state, proposed); return true; };
      const after = integrity ? integrity.content : anchor;
      if (after === null ? usesIntegrityAnchor(state) : !(await Promise.resolve().then(() => prove(JSON.parse(after))).catch(() => false))) refuseJournal(file, "carries an after-anchor that does not agree with the persisted state and history");
      if (integrity && anchor !== integrity.content) await atomicWrite(targetRoot, integrityPath, integrity.content);
      const appended = await appendHistoryOnce(targetRoot, root, journal.event);
      await assertRecovered(root, state); // History alone now produces exactly this state; the anchor agrees.
      return { outcome: appended ? "COMPLETED_HISTORY" : "ALREADY_COMPLETE" };
    }
    // Nothing durable moved: restore what the transition rewrote ahead of the
    // state write, then the anchor. A file the persisted state pins may only be
    // left as it is or given back its pinned bytes, and state.json only the
    // bytes already there.
    for (const entry of restore) {
      const pin = DERIVED_PINS[entry.path] ? undefined : state.artifactHashes[entry.path];
      const target = path.join(root, entry.path);
      if (entry.path === "state.json" ? entry.content !== stateBytes : pin !== undefined && (entry.remove ||
          (entry.content !== (await readFile(target, "utf8").catch(() => null)) &&
           !contentIdentityMatches(pin, target, Buffer.from(entry.content), { bytes: isBytePinned(entry.path) })))) {
        refuseJournal(file, `would rewrite ${entry.path} to bytes the persisted state does not hold`);
      }
    }
    const undo = !integrity ? restore : [...restore, integrity.before === null
      ? { path: INTEGRITY_FILE, remove: true }
      : { path: INTEGRITY_FILE, content: integrity.before }];
    await assertJournalTargets(file, undo.map((entry) => [targetRoot, path.join(root, entry.path)]));
    for (const entry of undo) {
      const target = path.join(root, entry.path);
      await (entry.remove ? removeDurably(targetRoot, target) : atomicWrite(targetRoot, target, entry.content));
    }
    await assertRecovered(root, state);
    return { outcome: "DISCARDED_UNCOMMITTED" };
  } });
};

export const completedArtifactHashes = async (root, state, step, sliceId) => {
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

export const validateCompletedHashes = async (root, state) => {
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
            : `Completed artifact is missing: ${relativePath}. It was pinned when its checkpoint closed, and every command -- reopen and rework included -- refuses until it is back: restore it (for example from version control).`,
      );
    }
    if (!(await pinnedArtifactMatches(root, relativePath, expected))) {
      throw new Error(
        relativePath === BASELINE_ROWS_PIN
          ? `Behavior parity rows changed after BUILD_BASELINE closed: their immutable fields (${IMMUTABLE_BEHAVIOR_ROW_FIELDS.join(", ")}) no longer match what the checkpoint pinned. Only verificationStatus may move; reopen the responsible checkpoint.`
          : relativePath === DISCOVERY_PIN
            ? `The recorded discovery digest changed after DISCOVERY_COMPLETENESS closed. ${DISCOVERY_SCAN_FILE} is machine-generated and is never edited by hand; restore its bytes (for example from version control) -- every command, --reopen-discovery included, refuses until it matches.`
            : reworkPathParts(relativePath)
              ? `Preserved rework evidence changed after it was pinned: ${relativePath}. The failed verification attempt that authorized a rework is immutable; it was altered rather than deleted. Restore the original bytes.`
              : relativePath.startsWith(`${REOPEN_ROOT}/`)
                ? `Preserved reopen evidence changed after it was pinned: ${relativePath}. The superseded verification a COMPLETE reopen preserved is immutable; it was altered rather than deleted. Restore the original bytes.`
                : `Completed artifact changed after validation: ${relativePath}. It was pinned when its checkpoint closed, and every command -- reopen and rework included -- refuses until it matches again: restore the validated bytes (for example from version control). Completed work is never rewritten to fit later work; the active checkpoint authors only its own artifacts.`,
      );
    }
  }
};

export const assertStepDocumentComplete = async (root, step, state, sliceId) => {
  const relativePath = STEP_FILES[step];
  const content = await readFile(path.join(root, relativePath), "utf8");
  if (!slicePhaseOpen(state, step, sliceId) && !content.includes("- Status: `COMPLETE`")) {
    throw new Error(`${relativePath} must record Status COMPLETE.`);
  }
  if (/\[TODO\]/i.test(content)) {
    throw new Error(`${relativePath} still contains TODO evidence.`);
  }
};
