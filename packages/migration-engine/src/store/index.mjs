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
 * One replace-write and one durable append (Track B DR7, DR8). `atomicWrite`
 * (secure path, exclusive temp file, fsync, rename, directory fsync, temp
 * cleanup) is every whole-file replacement: the lifecycle journals, the upgrade
 * manifests and each file `writeTree` stages. `appendDurably` (secure path,
 * O_APPEND | O_NOFOLLOW, file and directory fsync) is every append-only record:
 * the module history (`appendHistory`) and both decision ledgers. Staged trees
 * (`writeTree`, `copyTree`) are flushed before their caller's journalled rename
 * commits them; the commit and its recovery stay the caller's, made durable
 * with `mkdirDurably`, `renameDurably` and `syncDirectory`.
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
  mkdirDurably,
  readJson,
  readOptionalJson,
  removeDurably,
  removeEmptyParents,
  renameDurably,
  syncDirectory,
  syncNearestDirectory,
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
  historyTailOf,
  INTEGRITY_FILE,
  isTornAppendOf,
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
  registryIdentity,
  registryJournalPathFor,
  renderRegistryPreview,
  validateRegistry,
  resolveModule,
  resolveRegistryPath,
} from "./registry.mjs";
export {
  assertNoSymlink,
  copyTree,
  entryExists,
  manifestOf,
  readTree,
  sameManifest,
  writeTree,
} from "./tree.mjs";
