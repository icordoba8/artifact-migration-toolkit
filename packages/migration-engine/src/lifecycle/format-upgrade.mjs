/**
 * Lifecycle: module format-upgrade orchestration -- the handler registry, the
 * pending-upgrade projection and the journalled commits. The format rules and
 * increments stay in formats/. Moved verbatim from `resumable-migration.mjs`
 * (Track A8).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertDirectLedgerEligible,
  classifyUpgrade,
  DIRECT_LEDGER_DECISIONS_FORMAT,
  directLedgerAdoptionDigest,
  directLedgerAdoptionPreview,
  FORMAT_INCREMENTS,
  FORMAT_UPGRADE_FLOOR,
  initialArtifacts,
  INTEGRITY_FILE,
  MIGRATION_FORMAT_SUPPORTED,
  nextIncrement,
  REQUIRED_OBSERVATIONS_FORMAT,
  UI_COVERAGE_FORMAT,
  upgradeIsActive,
  VISUAL_ACCEPTANCE_FORMAT,
} from "../formats/index.mjs";
import { assertBoolean, now, sha256Hex as hashContent } from "../shared/index.mjs";
import {
  assertHistoryAppendable,
  atomicWrite,
  fileExists,
  migrationRoot,
  renderState,
  statePathFor,
} from "../store/index.mjs";
import { removeJournal, writeJournalAtomic } from "./journal.mjs";
import { withModuleLock } from "./lock.mjs";
import { adoptUiObservations, uiObservationsAdoptionPlan } from "./adoption.mjs";
import { readContext } from "./context.mjs";
import {
  ADVANCE_JOURNAL,
  appendHistoryOnce,
  readState,
  recoverPendingAdvance,
  renderIntegrityNow,
} from "./record.mjs";
import { assertRecordToolkitIdentity } from "./toolkit-identity.mjs";
import { validateLegacyInventory } from "./validation.mjs";

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
  [DIRECT_LEDGER_DECISIONS_FORMAT]: {
    domain: () => {
      throw new Error("Format 20 requires newly authored legacy appearance and scroll coverage. Existing format-19 records retain their pinned contract; start a new migration record for renewed validation.");
    },
    plan: async () => ({ blockers: ["Format 20 cannot be inferred from a format-19 record."], candidateDigest: null }),
    commit: async () => { throw new Error("Format 20 cannot be applied to an existing record."); },
  },
  [UI_COVERAGE_FORMAT]: {
    domain: () => {
      throw new Error("Format 21 holds the OpenSpec, created at RESOLVE, to the source API response contract. Existing format-20 records retain their pinned contract; start a new migration record for renewed validation.");
    },
    plan: async () => ({ blockers: ["Format 21 cannot be inferred from a format-20 record."], candidateDigest: null }),
    commit: async () => { throw new Error("Format 21 cannot be applied to an existing record."); },
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
    await removeJournal(journalFile);
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
    ? DIRECT_LEDGER_DECISIONS_FORMAT
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
    await removeJournal(journalFile);
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
