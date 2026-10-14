/**
 * Lifecycle: the locked-read context (`readContext`, `readMigrationContext`),
 * record recovery, and the discovery-scan preview. Moved verbatim from
 * `resumable-migration.mjs` (Track A8).
 */
import { readCanonicalModuleBoundary, resolveLegacySources } from "../census/index.mjs";
import { assertDiscoveryCompletenessFormat } from "../formats/index.mjs";
import { assertSafeName } from "../shared/index.mjs";
import {
  fileExists,
  migrationRoot,
  readJson,
  readRegistry,
  registryIdentity,
  resolveModule,
  statePathFor,
} from "../store/index.mjs";
import { initJournalFor, recoverInitialization } from "./initialization.mjs";
import { readJournal } from "./journal.mjs";
import { withModuleLock } from "./lock.mjs";
import { validateStateShape } from "./checkpoints.mjs";
import { readState, recoverPendingAdvance } from "./record.mjs";

/**
 * The public recovery entry point. Every mutating command already recovers on
 * its own; this exists because a preview must not mutate, so a record whose
 * integrity anchor is one revision ahead of its state could be *diagnosed* by a
 * read but never repaired by one. DR13: an interrupted initialization is the
 * same case for a record without state -- the preview reports it as pending
 * and this recovers it first, under the same lock.
 */
export const recoverMigrationRecord = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readContext({
    registryPath,
    moduleName,
  });
  const { targetRoot } = registryData;
  const root = migrationRoot(targetRoot, resolved.canonical);
  const statePath = statePathFor(targetRoot, resolved.canonical);
  if (!(await fileExists(statePath)) && !(await readJournal(initJournalFor(targetRoot, resolved.canonical)))) return null;
  return withModuleLock(targetRoot, resolved.canonical, async () => {
    const initialized = await recoverInitialization(targetRoot, resolved.canonical);
    if (!(await fileExists(statePath))) return initialized;
    return (await recoverPendingAdvance(targetRoot, root, statePath)) ?? initialized;
  });
};

export const readContext = async ({
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
