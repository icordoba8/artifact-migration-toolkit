/**
 * Lifecycle: --reopen-discovery, the agent's own way back to DISCOVER_LEGACY.
 * Split from `reopen.mjs` by ownership; the operator transitions stay there.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { INTEGRITY_FILE, stampedFormatVersion, stepsFor } from "../formats/index.mjs";
import { now, portablePath, sha256Hex as hashContent } from "../shared/index.mjs";
import {
  assertHistoryAppendable,
  atomicWrite,
  contentIdentityMatchesSource,
  fileExists,
  readOptionalJson,
  removeDurably,
  removeEmptyParents,
  renderState,
  REOPEN_ROOT,
} from "../store/index.mjs";
import { removeJournal, writeJournalAtomic } from "./journal.mjs";
import { activeArtifact } from "./checkpoints.mjs";
import {
  ADVANCE_JOURNAL,
  appendHistoryOnce,
  IMMUTABLE_STEP_ARTIFACTS,
  isBytePinned,
  pinnedSourcePath,
  renderIntegrityNow,
  resolveStepPins,
} from "./record.mjs";

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
 *
 * A discovery error can also surface later -- an appearance claim whose locator
 * the legacy runtime never shows is refused only when VERIFY_SLICES captures it.
 * Until a slice is verified that is still the agent's own correction: the
 * reopen releases every pin after RESOLVE, exactly like --refresh, but keeps
 * the legacy revision (drift still needs the operator) and first preserves the
 * released bytes under `reopen/discovery-<revision>/`, pinned for good.
 * The active slice's LEGACY claim captures are preserved the same way and then
 * cleared, or recapturing the same claim on the corrected inventory would meet
 * CAPTURE_EXISTS; anything there the engine cannot attribute to its own
 * capture refuses the reopen.
 */
export const reopenDiscoveryBlocker = (state) =>
  state.currentStep === "DISCOVERY_COMPLETENESS" ||
  (state.status === "ACTIVE" &&
    state.completedSteps.includes("DISCOVERY_COMPLETENESS") &&
    state.completedSlices.length === 0)
    ? null
    : `--reopen-discovery is legal from DISCOVERY_COMPLETENESS, or from a later checkpoint before any slice is verified; the record is ${state.status} at '${state.currentStep}' with ${state.completedSlices.length} verified slice(s). Nothing was changed. Invalidating verified work is the operator's --refresh --confirm-mismatch.`;

export const reopenDiscoveryUnderLock = async ({
  registryData,
  resolved,
  root,
  statePath,
  state,
}) => {
  const blocker = reopenDiscoveryBlocker(state);
  if (blocker) throw new Error(blocker);
  if (state.currentStep !== "DISCOVERY_COMPLETENESS") {
    return reopenDiscoveryLate({ registryData, resolved, root, statePath, state });
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
  await removeJournal(path.join(root, ADVANCE_JOURNAL));
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
 * The unverified active slice's engine-written LEGACY captures: its result.json
 * and every proof and screenshot a LEGACY row cites, unchanged. Anything else
 * under ui/legacy, or a row whose file moved or changed, is ambiguous: refused.
 */
const abandonedCaptures = async (root, targetRoot, slice) => {
  if (!slice) return [];
  const resultFile = `evidence/${slice}/result.json`;
  const directory = `evidence/${slice}/ui/legacy`;
  const onDisk = (await readdir(path.join(root, directory)).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).map((name) => `${directory}/${name}`);
  const result = await readOptionalJson(path.join(root, resultFile), `Evidence for ${slice}`);
  const rows = (Array.isArray(result?.uiEvidence) ? result.uiEvidence : []).filter((row) => row?.origin === "LEGACY");
  const ambiguous = (detail) => {
    throw new Error(`--reopen-discovery cannot clear the LEGACY captures of slice '${slice}': ${detail}. Only an unchanged engine capture is cleared. Nothing was changed.`);
  };
  const cited = [];
  for (const row of rows) {
    for (const [file, suffix] of [[row, "proof.json"], [row.screenshot ?? {}, "png"]]) {
      const expected = `${directory}/${row.appearanceClaimId}.${suffix}`;
      if (file.reference !== portablePath(path.relative(targetRoot, path.join(root, expected))) ||
          !(await contentIdentityMatchesSource(file.hash, targetRoot, file.reference))) {
        ambiguous(`the LEGACY row of claim '${row.appearanceClaimId}' does not cite an unchanged ${expected}`);
      }
      cited.push(expected);
    }
  }
  const uncited = onDisk.filter((relative) => !cited.includes(relative));
  if (uncited.length > 0) ambiguous(`'${uncited[0]}' is not cited by a LEGACY row of ${resultFile}`);
  return rows.length > 0 ? [resultFile, ...cited] : [];
};

const reopenDiscoveryLate = async ({ registryData, resolved, root, statePath, state }) => {
  const revision = state.revision + 1;
  const directory = `${REOPEN_ROOT}/discovery-${revision}`;
  if (await fileExists(path.join(root, directory))) {
    throw new Error(`${directory} already exists; a preserved reopen is never overwritten. Nothing was changed.`);
  }
  const cleared = await abandonedCaptures(root, registryData.targetRoot, state.activeSlice);
  const kept = new Set(resolveStepPins(state));
  const released = Object.keys(state.artifactHashes).filter(
    (relative) => !kept.has(relative) && !isBytePinned(relative),
  );
  // Raw bytes of what each released pin was derived from, never re-serialized.
  const writes = [];
  for (const source of new Set([...released.map((relative) => portablePath(path.relative(root, pinnedSourcePath(root, relative)))), ...cleared])) {
    writes.push([`${directory}/${source}`, await readFile(path.join(root, source))]);
  }
  const preserved = {};
  for (const [relative, bytes] of writes) preserved[relative] = hashContent(bytes);
  const artifactHashes = Object.fromEntries(
    Object.entries(state.artifactHashes).filter(([relative]) => !released.includes(relative)),
  );
  Object.assign(artifactHashes, preserved);
  const reopened = {
    ...state,
    formatVersion: stampedFormatVersion(state),
    status: "ACTIVE",
    currentStep: "DISCOVER_LEGACY",
    completedSteps: ["RESOLVE"],
    pendingSteps: stepsFor(state).slice(1),
    activeSlice: null,
    completedSlices: [],
    pendingSlices: [],
    invalidatedArtifacts: released,
    evidenceFreshness: "STALE",
    nextAction: `Correct the legacy inventory, then rebuild every later checkpoint; what was released is preserved under ${directory}/.`,
    nextCommand: `/start-migration ${resolved.canonical}`,
    artifactHashes,
    revision,
    updatedAt: now(),
  };
  const event = {
    event: "REOPENED",
    from: state.currentStep,
    slice: state.activeSlice,
    step: "DISCOVER_LEGACY",
    invalidated: released,
    preserved: Object.keys(preserved).sort(),
    cleared,
    revision,
  };
  const integrityPath = path.join(root, INTEGRITY_FILE);
  const integrityBefore = await readFile(integrityPath, "utf8");
  const nextIntegrity = await renderIntegrityNow(root, reopened, event);
  const journalFile = path.join(root, ADVANCE_JOURNAL);
  await assertHistoryAppendable(registryData.targetRoot, root);
  await writeJournalAtomic(journalFile, {
    fromRevision: state.revision,
    toRevision: revision,
    event,
    startedAt: now(),
    pid: process.pid,
    restore: writes.map(([relative]) => ({ path: relative, remove: true })),
    integrity: { content: nextIntegrity, before: integrityBefore },
  });
  for (const [relative, bytes] of writes) {
    await atomicWrite(registryData.targetRoot, path.join(root, relative), bytes);
  }
  await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
  await atomicWrite(registryData.targetRoot, statePath, renderState(reopened));
  await appendHistoryOnce(registryData.targetRoot, root, event);
  // ponytail: cleared only after the commit, so a crash can never lose the
  // originals; a crash right here leaves them in place (preserved copy pinned)
  // and the recapture still meets CAPTURE_EXISTS. Fold into recovery if seen.
  for (const relative of cleared) await removeDurably(registryData.targetRoot, path.join(root, relative));
  if (cleared.length > 0) await removeEmptyParents(path.join(root, path.dirname(cleared.at(-1))), root);
  await removeJournal(journalFile);
  return { changed: true, reopened: true, statePath, migrationRoot: root, state: reopened, nextArtifact: activeArtifact(reopened), resolved };
};
