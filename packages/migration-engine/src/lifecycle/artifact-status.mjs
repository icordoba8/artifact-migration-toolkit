/**
 * Lifecycle: artifact status, preview, metrics, and the decision and
 * completion readers the recorder and the module lifecycle call. Moved verbatim
 * from `artifact/artifact-migration.mjs` (Track A8).
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  artifactFormatUpgrade,
  MIGRATION_STEPS,
  STATE_FILE,
  toolkitIdentityStatus,
  TRANSACTION_FILE,
  usesArtifactDirectLedger,
} from "../formats/index.mjs";
import { captureBinding, metrics, resolveArtifact, validateSourceInventoryDocument, visualApplicability } from "../census/index.mjs";
import { activeToolkitIdentity } from "../toolkit-identity.mjs";
import { assertArray, canonicalJson as canonical, samePath, sha256Hex as sha256 } from "../shared/index.mjs";
import { artifactRoot, fileExists as exists, readOptionalJson, STATE_ROOT } from "../store/index.mjs";
import {
  artifactVisualDecisions,
  checkpointArtifacts,
  freshness,
  reconcileArtifactDecisions,
  validateCheckpoint,
  validateFinal,
  validateSourceInventory,
} from "./artifact-checkpoints.mjs";
import { READ_ONLY_CAPABILITY } from "./artifact-execution.mjs";
import {
  artifactCommandFor,
  assertInvocationMatches,
  locate,
  readArtifactState,
} from "./artifact-record.mjs";
import { assertTransactionReplayable, proveFormatUpgradeTransaction } from "./artifact-transaction.mjs";
import { readJournal } from "./journal.mjs";
import { exitCodeFor, MIGRATION_OUTCOMES } from "./policy.mjs";
import { migrationProgress, renderProgress } from "./progress.mjs";

export const startMetrics = () =>
  Object.assign(metrics, {
    startedAt: Date.now(),
    discoveryScans: 0,
    filesParsed: 0,
    validatorRuns: 0,
    previewAdvanceCalls: 0,
  });

export const artifactMetrics = () => ({
  durationMs: Date.now() - metrics.startedAt,
  discoveryScans: metrics.discoveryScans,
  filesParsed: metrics.filesParsed,
  validatorRuns: metrics.validatorRuns,
  // Proves the invariant externally: normal execution establishes the
  // transition proof exactly once before the journal exists; recovery, with no
  // in-memory proof to reuse, reruns it independently; --status never does.
  previewAdvanceCalls: metrics.previewAdvanceCalls,
});

export const stateFileExists = (root) => exists(path.join(root, STATE_FILE));

export const previewArtifact = async (options = {}) => {
  const location = locate(options);
  if (await stateFileExists(location.root)) {
    if (options.pilotFormat !== undefined) {
      const state = await readArtifactState(location.targetRoot, location.id);
      if (options.pilotFormat !== 14 || !usesArtifactDirectLedger(state.formatVersion)) {
        throw new Error("Pilot format selection cannot change an existing artifact.");
      }
    }
    // The inner reader, not the exported wrapper: a nested status must not
    // reset the counters of the run that asked for it.
    const status = await readArtifactStatus({ ...options, targetRoot: location.targetRoot, id: location.id });
    return {
      action: "RESUME",
      artifactId: location.id,
      root: location.root,
      requiresConfirmation: status.outcome !== "BLOCKED" && status.status !== "COMPLETE",
      confirmationId: null,
      status,
    };
  }
  const resolved = await resolveArtifact(options);
  const [sourceBinding, targetBinding] = await Promise.all([
    captureBinding(resolved.source.root, resolved.sourcePaths, "source"),
    captureBinding(resolved.target.root, resolved.targetPaths, "target"),
  ]);
  const snapshot = {
    action: "BOOTSTRAP",
    artifactId: resolved.id,
    artifactType: resolved.artifactType,
    formatVersion: resolved.formatVersion,
    source: resolved.source,
    target: resolved.target,
    designSource: resolved.designSource,
    figmaSources: resolved.figmaSources,
    ...(resolved.ponytail ? { ponytail: resolved.ponytail } : {}),
    sourceBinding,
    targetBinding,
  };
  return {
    ...snapshot,
    root: resolved.root,
    requiresConfirmation: true,
    confirmationId: sha256(canonical(snapshot)).slice(0, 16),
  };
};

export const progressState = (state, status = state.status) => ({
  formatVersion: state.formatVersion,
  legacyModule: state.artifactId,
  targetModule: state.target.path,
  status,
  currentStep: state.currentStep,
  activeSlice: state.activeSlice,
  completedSteps: state.completedSteps,
  completedSlices: state.completedSlices,
  pendingSlices: state.pendingSlices,
  revision: state.revision,
  nextAction: state.nextAction,
  nextCommand: state.nextCommand,
  artifacts: {
    steps: Object.fromEntries(
      MIGRATION_STEPS.map((step) => [
        step,
        checkpointArtifacts({ ...state, currentStep: step }),
      ]),
    ),
  },
});

export const outcomeResult = (state, outcome, reason, mode, extra = {}, status = state.status) => {
  if (!MIGRATION_OUTCOMES.includes(outcome)) throw new Error(`Unknown migration outcome '${outcome}'.`);
  const progress = migrationProgress(progressState(state, status), {
    lifecycle: MIGRATION_STEPS,
    mode,
    outcome,
    reason,
  });
  return {
    artifactId: state.artifactId,
    status,
    outcome,
    reason,
    exitCode: exitCodeFor(outcome),
    progress,
    progressChecklist: renderProgress(progress),
    metrics: artifactMetrics(),
    ...extra,
  };
};

// M10 D1: every Ponytail evidence entry a COMPLETE result reports carries its
// assurance, AGENT_ASSERTED, so no reader mistakes it for an attested review.
export const ponytailReport = (ponytailEvidence) => (ponytailEvidence?.length ? { ponytailEvidence } : {});

export const blockedArtifactResult = (state, reason, mode, nextCommand) =>
  outcomeResult(
    { ...state, nextAction: reason, nextCommand: nextCommand === undefined ? state.nextCommand : nextCommand },
    "BLOCKED", reason, mode,
    { nextAction: reason, nextCommand: nextCommand === undefined ? state.nextCommand : nextCommand },
    "BLOCKED",
  );

// Every status path -- recoverable transaction, blocked record, stale drift,
// healthy checkpoint -- reports the same scan/time counters, so "how much work
// did this cost" is answerable without timing the process from outside.
export const getArtifactStatus = async (options = {}) => {
  startMetrics();
  const result = await readArtifactStatus(options);
  return { ...result, metrics: artifactMetrics() };
};

const readArtifactStatus = async (options = {}) => {
  const location = locate(options);
  const transactionFile = path.join(location.root, TRANSACTION_FILE);
  const found = await readJournal(transactionFile);
  if (found) {
    // A recoverable two-phase transaction reports honestly as ACTIVE and is
    // replayed by the next run; only a torn or invalid one blocks. No write.
    let transaction;
    let replayable = false;
    try {
      // The DR13 reader, so status never reports healthy a journal run refuses.
      if (found.corrupt) throw new Error(`Artifact transaction journal is unreadable at ${transactionFile}.`);
      transaction = found.journal;
      await assertTransactionReplayable(location.root, transaction);
      // Same read-only proof recovery runs, so status cannot promise a replay run refuses.
      if (transaction.input?.kind === "FORMAT_UPGRADE") await proveFormatUpgradeTransaction(location.root, transaction);
      replayable = true;
      if (transaction.state.artifactId !== location.id) {
        throw new Error("Artifact state identity does not match its directory.");
      }
      assertInvocationMatches(transaction.state, options);
      return {
        artifactId: location.id,
        exists: true,
        status: "ACTIVE",
        outcome: "CONTINUE",
        reason: "A pending artifact transaction will be recovered automatically on the next run.",
        exitCode: exitCodeFor("CONTINUE"),
        root: location.root,
      };
    } catch (error) {
      const state = replayable && transaction?.state?.artifactId === location.id
        ? transaction.state
        : await readArtifactState(location.targetRoot, location.id).catch(() => null);
      if (state) {
        return { ...blockedArtifactResult(state, error.message, null, artifactCommandFor(state)), exists: true, root: location.root };
      }
      return {
        artifactId: location.id,
        exists: true,
        status: "BLOCKED",
        outcome: "BLOCKED",
        reason: error.message,
        exitCode: exitCodeFor("BLOCKED"),
        root: location.root,
      };
    }
  }
  if (!(await stateFileExists(location.root))) {
    return { artifactId: location.id, exists: false, status: "NOT_STARTED", outcome: "CONTINUE", root: location.root };
  }
  let state;
  try {
    state = await readArtifactState(location.targetRoot, location.id);
    assertInvocationMatches(state, options);
  } catch (error) {
    if (state) {
      return { ...blockedArtifactResult(state, error.message, null, artifactCommandFor(state)), exists: true, root: location.root };
    }
    return {
      artifactId: location.id,
      exists: true,
      status: "BLOCKED",
      outcome: "BLOCKED",
      reason: error.message,
      exitCode: exitCodeFor("BLOCKED"),
      root: location.root,
    };
  }
  // READ_ONLY: `--status` answers a question nobody asked to run. It never
  // spawns the target's package scripts, compiler binary or `node --check`, and
  // it never loads target-controlled modules (P1 #6). The structural half of
  // every checkpoint still runs, so stale detection and blocking stay exact.
  const validation = state.status === "COMPLETE" ? null : await validateCheckpoint(location.root, state, READ_ONLY_CAPABILITY);
  // An engine fault blocks `run`, so it must block `--status` too.
  if (validation?.outcome === "BLOCKED") {
    return {
      ...outcomeResult(state, "BLOCKED", validation.reason, null, { exists: true, root: location.root, validation,
        ...(validation.decisionProjection ? { decisionProjection: validation.decisionProjection } : {}) }),
      status: "BLOCKED",
    };
  }
  const fresh = await freshness(location.root, state, validation);
  if (fresh.stale) {
    const reason = `Relevant artifact drift detected (source: ${fresh.sourceDrift.join(", ") || "none"}; target: ${fresh.targetDrift.join(", ") || "none"}).`;
    return {
      ...outcomeResult(state, "BLOCKED", reason, null, { exists: true, root: location.root, stale: fresh }, "STALE"),
      status: "STALE",
    };
  }
  let ponytailEvidence;
  if (state.status === "COMPLETE" && state.ponytail) {
    try {
      ponytailEvidence = (await validateFinal(location.root, state)).ponytail;
    } catch (error) {
      return { ...blockedArtifactResult(state, error.message, null, artifactCommandFor(state)), exists: true, root: location.root };
    }
  }
  const progress = migrationProgress(progressState(state), {
    lifecycle: MIGRATION_STEPS,
    mode: null,
  });
  return {
    artifactId: state.artifactId,
    exists: true,
    status: state.status,
    outcome: state.status === "COMPLETE" ? "COMPLETE" : "CONTINUE",
    state,
    root: location.root,
    validation,
    ...(validation?.decisionProjection ? { decisionProjection: validation.decisionProjection } : {}),
    progress,
    progressChecklist: renderProgress(progress),
    ...ponytailReport(ponytailEvidence),
    visualApplicability: await visualOwnership(location, state),
    // Same protocol as a module migration's `formatUpgrade`, and read-only like
    // the rest of this function: projected from the record's own cursor, never
    // committed here. `null` whenever the record is at the runtime format, which
    // today is every record this engine admits.
    formatUpgrade: artifactFormatUpgrade(state),
    // Read-only reporting, never a write: `UNSTAMPED` is what every record
    // created before the standalone toolkit reports, and status says so without
    // stamping anything.
    toolkitIdentity: state.toolkitIdentity ?? null,
    activeToolkitIdentity: activeToolkitIdentity(),
    toolkitIdentityStatus: toolkitIdentityStatus(
      state.toolkitIdentity ?? null,
      activeToolkitIdentity(),
    ),
  };
};

/**
 * What visual verification this artifact owes, and who owes it. `VISUAL_UI`
 * -- or an accepted `hasVisibleUi: true` over a script the classifier could not
 * prove either way -- owes its own Playwright evidence; `NON_VISUAL` owes none.
 * A bound `VISUAL_DEPENDENCY` file (a stylesheet, an asset) has no UI of its
 * own, so its visual verification is owned by each consumer its global
 * contracts name: an artifact record -- this one included -- that binds that
 * consumer, is COMPLETE and fresh with visible UI, and carries the dependency
 * into a visible behavior -- by binding it, or by disposing it
 * MIGRATED_BEHAVIOR onto a visible behavior. Those rows are reported even when
 * the artifact also renders, so a `SELF` verdict never hides a consumer still
 * owed. Read-only.
 */
const visualOwnership = async (location, state) => {
  const applicability = await visualApplicability(state);
  const dependencies = applicability.files
    .filter((file) => file.classification === "VISUAL_DEPENDENCY").map((file) => file.path);
  // A declared `true` decides only what the classifier could not prove.
  const verification = state.hasVisibleUi === true && !applicability.conclusive ? "SELF"
    : { VISUAL_UI: "SELF", VISUAL_DEPENDENCY: "CONSUMERS", NON_VISUAL: "NOT_APPLICABLE" }[applicability.classification];
  if (dependencies.length === 0) return { ...applicability, verification };
  // Until DISCOVER_LEGACY closes, the source inventory is a draft the agent is
  // still writing: only a document that validates is read, anything else is
  // INVENTORY_INCOMPLETE. Past it the document is pinned, and a malformed one is
  // corruption that must surface, never be skipped.
  let source;
  if (state.currentStep === "DISCOVER_LEGACY" && state.status !== "COMPLETE") {
    source = await validateSourceInventoryDocument(location.root, state).then((result) => result.document, () => null);
    if (!source) return { ...applicability, verification, consumers: [], consumerCoverage: "INVENTORY_INCOMPLETE" };
  } else {
    source = await readOptionalJson(path.join(location.root, "inventories/source.json"), "source inventory");
  }
  // Two contracts on one stylesheet may name the same consumer: one obligation.
  const contracts = source ? assertArray(source.globalContracts, "pinned source inventory.globalContracts") : [];
  const pairs = [...new Map(contracts.filter((contract) => dependencies.includes(contract.sourcePath))
    .flatMap((contract) => assertArray(contract.consumers, `pinned source inventory global contract '${contract.id}' consumers`)
      .map((consumer) => [`${contract.sourcePath}\0${consumer}`, { dependency: contract.sourcePath, consumer }])))
    .values()];
  // No consumer named, nothing to look up: sibling records are never read.
  if (pairs.length === 0) return { ...applicability, verification, consumers: [], consumerCoverage: "NO_CONSUMER" };
  const records = [];
  for (const id of await readdir(path.join(location.targetRoot, STATE_ROOT)).catch(() => [])) {
    const owner = id === state.artifactId ? state : await readArtifactState(location.targetRoot, id).catch(() => null);
    if (owner && samePath(owner.source.root, state.source.root)) records.push(owner);
  }
  const consumers = [];
  for (const { dependency, consumer } of pairs) {
    const owner = records.find((record) => record.bindings.source.entries.some((entry) => entry.path === consumer));
    const root = owner && artifactRoot(location.targetRoot, owner.artifactId);
    const status = !owner ? "UNMIGRATED"
      : owner.status !== "COMPLETE" ? "PENDING"
        : (await freshness(root, owner)).stale ? "STALE"
          : owner.hasVisibleUi && await carriesVisually(root, owner, dependency) ? "VERIFIED" : "UNCOVERED";
    consumers.push({ dependency, consumer, owner: owner?.artifactId ?? null, status });
  }
  return {
    ...applicability,
    verification,
    consumers,
    consumerCoverage: consumers.every((row) => row.status === "VERIFIED") ? "VERIFIED" : "PENDING",
  };
};

const carriesVisually = async (root, owner, dependency) => {
  if (owner.bindings.source.entries.some((entry) => entry.path === dependency)) return true;
  const [source, completeness] = await Promise.all([
    readOptionalJson(path.join(root, "inventories/source.json"), "source inventory"),
    readOptionalJson(path.join(root, "inventories/completeness.json"), "completeness inventory"),
  ]);
  const visible = new Set((source?.behaviors ?? []).filter((row) => row.visible).map((row) => row.id));
  return (completeness?.requirements ?? []).some((row) =>
    row.element === dependency && row.disposition === "MIGRATED_BEHAVIOR" && visible.has(row.ref));
};

export const artifactOperatorDecisions = async (options = {}) => {
  const location = locate(options);
  const state = await readArtifactState(location.targetRoot, location.id);
  assertInvocationMatches(state, options);
  if (usesArtifactDirectLedger(state.formatVersion)) {
    const current = await freshness(location.root, state);
    if (current.stale || current.source.revision !== state.bindings.source.revision ||
        current.source.dirtyDigest !== state.bindings.source.dirtyDigest ||
      current.source.digest !== state.bindings.source.digest ||
      current.target.revision !== state.bindings.target.revision ||
      current.target.dirtyDigest !== state.bindings.target.dirtyDigest ||
      current.target.digest !== state.bindings.target.digest) {
      throw new Error("Artifact decision evidence is stale; no current candidate can be recorded.");
    }
  }
  const source = await validateSourceInventory(location.root, state);
  const sourceDecisions = !usesArtifactDirectLedger(state.formatVersion) || state.currentStep === "DISCOVER_LEGACY"
    ? source.decisions : [];
  const visual = !usesArtifactDirectLedger(state.formatVersion) || state.currentStep === "BUILD_BASELINE"
    ? await artifactVisualDecisions(location.root, state, source) : [];
  const decisions = [...sourceDecisions, ...visual];
  return {
    state,
    root: location.root,
    targetRoot: location.targetRoot,
    id: location.id,
    decisions,
    ...(usesArtifactDirectLedger(state.formatVersion) ? {} : { reconciled: reconcileArtifactDecisions(state, decisions) }),
  };
};

export const validateArtifactComplete = async (options = {}) => {
  const location = locate(options);
  const state = await readArtifactState(location.targetRoot, location.id);
  assertInvocationMatches(state, options);
  if (state.status !== "COMPLETE" || state.currentStep !== "COMPLETE") {
    throw new Error("Artifact migration state is not COMPLETE.");
  }
  const fresh = await freshness(location.root, state);
  if (fresh.stale) throw new Error("Artifact migration is COMPLETE but its source or target evidence is stale.");
  await validateFinal(location.root, state);
  return {
    valid: true,
    complete: true,
    artifactId: state.artifactId,
    resolution: state.resolution,
    status: state.status,
    statePath: path.join(location.root, STATE_FILE),
  };
};
