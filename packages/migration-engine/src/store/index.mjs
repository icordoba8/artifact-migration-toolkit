/**
 * Store: the module's one public entry (Track A1, docs/phase0-architecture-baseline.md).
 *
 * Store owns how a record is persisted and proven intact: durable writes and
 * appends, the module record's history chain and integrity anchor, registry
 * persistence and journal recovery, the artifact record's pins, and whether an
 * evidence reference names real bytes under the legacy or target root (Track
 * A4: re-homed here from the lifecycle so census, visual and slices can all
 * reach it downward). The
 * record-layout names it persists under (`HISTORY_FILE`, `INTEGRITY_FILE`) are
 * formats vocabulary, re-exported here for compatibility (Track A2). It may
 * import `formats/`, `shared/` and the leaf `engine-paths.mjs`, nothing above
 * it. Importers outside `store/` use this file only.
 *
 * The write variants are kept as they were, deliberately not merged (DR7, DR8
 * are Track B): `atomicWrite` (secure path, fsync, rename), `writeTree` (plain
 * writeFile), `appendDurably` (O_APPEND, file and directory fsync) and
 * `appendHistory` (O_APPEND, no fsync).
 */
export {
  artifactEvidenceDigest,
  artifactRoot,
  fileHash,
  HISTORY_EVENT_KEYS,
  historyPrefixContent,
  integrityFor,
  pinDigest,
  readJsonAt,
  revalidatePins,
  secureHash,
  STATE_ROOT,
} from "./artifact.mjs";
export {
  appendDurably,
  atomicWrite,
  contentIdentityMatchesSource,
  fileContentIdentity,
  fileContentIdentityMatches,
  fileExists,
  fileIdentity,
  fileIdentityMatches,
  hashFile,
  readJson,
  readOptionalJson,
  removeEmptyParents,
} from "./files.mjs";
export {
  assertCommandResults,
  assertEvidenceReference,
  assertEvidenceResolves,
  evidencePathClaim,
  resolveEvidencePath,
} from "./evidence.mjs";
export {
  appendHistory,
  assertHistoryAppendable,
  assertUnanchoredHistoryTail,
  digestArtifactHashes,
  hashHistoryEvent,
  HISTORY_FILE,
  historyAnchorNow,
  historyAnchorOf,
  INTEGRITY_FILE,
  migrationRoot,
  prepareHistoryEvent,
  readHistoryEvents,
  readIntegrity,
  renderIntegrity,
  renderState,
  REOPEN_ROOT,
  sealHistoryTail,
  statePathFor,
} from "./record.mjs";
export {
  persistProjectRegistryBinding,
  previewProjectRegistryBinding,
  previewRegistryUpdate,
  projectRootFor,
  readRegistry,
  recoverRegistryJournal,
  registryIdentity,
  registryJournalPathFor,
  renderRegistryPreview,
  resolveModule,
  resolveRegistryPath,
} from "./registry.mjs";
export {
  assertNoSymlink,
  entryExists,
  manifestOf,
  readTree,
  sameManifest,
  writeTree,
} from "./tree.mjs";
