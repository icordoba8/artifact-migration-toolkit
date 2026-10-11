# Track A1 ownership record: `store/` and `shared/`

BASE `e8ca726`. Plan: `docs/phase0-architecture-baseline.md` §2, §3, §4 option (b), §7, §8 A1.
Behavior-preserving: every declaration moved verbatim. The only edits inside moved code are renames to a module-wide name (`sha256` → `sha256Hex`, `canonical` → `canonicalJson`, `isWithin` → one of the two variants below) and `initialArtifacts.history` → `HISTORY_FILE` (same string).

## Guarantees and their one owner

| Guarantee | Owner | Public function(s) (`<module>/index.mjs`) | Adversarial test (`test/unit/store-shared.test.mjs`) |
|---|---|---|---|
| Replace-write: secure path, temp cleanup, fsync, rename (DR7 variant 1) | store | `atomicWrite` | atomicWrite refuses a symlinked path with zero mutation… |
| Attested ledger append: O_APPEND, file + directory fsync (DR8 variant 2) | store | `appendDurably` | appendDurably appends exact bytes through its crash boundaries… |
| Module history hash chain (seq, previousHash, headHash) | store | `prepareHistoryEvent`, `appendHistory` (DR8 variant 3, no fsync), `readHistoryEvents`, `hashHistoryEvent` | the history chain verifies, and a one-byte edit… |
| Torn history tail repair | store | `sealHistoryTail` | a torn history tail is refused until sealed… |
| Integrity anchor bytes and the unanchored tail | store | `renderIntegrity`, `readIntegrity`, `digestArtifactHashes`, `historyAnchorOf`, `assertUnanchoredHistoryTail` | integrity.json bytes are stable…; past the integrity anchor only the one event… |
| Registry resolution, binding preview/persist, journal recovery | store | `resolveRegistryPath`, `readRegistry`, `previewRegistryUpdate`, `persistProjectRegistryBinding`, `recoverRegistryJournal` | registry journal recovery finishes only a write whose before-bytes still match |
| Upgrade tree snapshot (DR7 variant: plain `writeFile`) | store | `readTree`, `writeTree`, `manifestOf`, `sameManifest`, `assertNoSymlink`, `entryExists` | readTree refuses a symlink anywhere in the tree |
| Artifact record root and pin digests | store | `artifactRoot`, `pinDigest`, `secureHash`, `integrityFor`, `artifactEvidenceDigest` | the semantic artifact pin ignores provider and session… |
| File pins and reads | store | `fileIdentity`, `fileContentIdentity`, `hashFile`, `readJson`, `fileExists` | covered by `content-identity.test.mjs` |
| Path containment, two variants kept (DR1 is Track B) | shared | `isLexicallyWithin`, `isResolvedWithin`, `assertSecurePath` | the two containment checks stay two exports… |
| Path spelling and comparison (DR2, DR3) | shared | `portablePath`, `samePath`, `recordRelative`, `normalizeRelative` | — |
| SHA-256 and canonical JSON (DR5, DR21 primitive) | shared | `sha256Hex`, `sha256Json`, `canonicalJson`, `jsonBytes` | sha256Hex and canonicalJson are the primitives… |
| Content identity policy | shared | `contentIdentity`, `contentIdentityMatches`, `parseContentIdentity` | `content-identity.test.mjs` |
| Shape validators (DR6), safe name, ISO clock | shared | `assertPlainObject`, `isPlainObject`, `assertSafeName`, `exactObject`, `now` | — |
| Read-only git queries, `execFileAsync` (DR26) | shared | `gitRevision`, `dirtyManifest`, `commitsIntroducingBlob`, … | — |

Mechanical checks in the same file: A1-ARCH-1 (outside a module only `index.mjs` is imported, static, re-export and dynamic; it covers `formats/` since A2), A1-ARCH-2 (store imports only `formats/`, `shared/` and `engine-paths.mjs`, which must stay a leaf; formats imports only `shared/` and no `node:fs*`; shared imports no engine module and no fs write API; none has a top-level statement that runs), A1-ARCH-3 (no moved declaration is redeclared at its old site).

Compatibility: `core.mjs`, `migration-utils.mjs`, `resumable-migration.mjs` (`migrationRoot`) and `artifact/artifact-migration.mjs` (`artifactRoot`, `artifactEvidenceDigest`) keep every export name they had at BASE, now as re-exports. Engine files import the module entries directly.

Layout decision, settled in A2 (`a2-ownership.md`): R5 stands. Formats owns the record-layout vocabulary, so `HISTORY_FILE` and `INTEGRITY_FILE` are defined in `formats/record.mjs`. Store owns the persistence, history-chain and integrity behavior over those names. It imports them from `formats/index.mjs` and keeps exporting them from `store/record.mjs` and `store/index.mjs` as compatibility re-exports with the same values. Store may now import `formats/index.mjs` (the one downward edge A2 adds). A1-ARCH-2 allows it and no longer allows `toolkit-identity.mjs`, whose record vocabulary is in formats too.

## Not moved, with the blocker

Store-owned declarations whose move would create an upward edge or a cycle with the monolith, so they wait for the phase that extracts what they need:

| Declarations | Blocked by |
|---|---|
| `resumable-migration.mjs` `decisionsAnchorNow`, `autoDecisionsAnchorNow`, `renderIntegrityNow`, `assertDecisionsAppendOnly`, `assertHistoryAppendOnly` | formats constants: no longer a blocker. They are in `formats/` since A2, and the anchor comparisons call `usesIntegrityAnchor`. The functions themselves have not moved yet (store work, not A2). |
| `assertIntegrityAnchor`, `appendHistoryOnce` | the above plus `readAdvanceJournal` (lifecycle, A8) |
| pins: `DERIVED_PINS`, `pinnedSourcePath`, `hashPinnedArtifact`, `isBytePinned`, `pinnedArtifactMatches`, `resolveStepPins`, `completedArtifactHashes`, `validateCompletedHashes`, and their vocabulary `REOPEN_ROOT`, `BASELINE_ROWS_PIN`, `IMMUTABLE_BEHAVIOR_ROW_FIELDS`, `DISCOVERY_PIN`, `IMMUTABLE_STEP_ARTIFACTS` | `assertLateDecisionsAreAppendable` (decisions), `reworkPathParts` (slices), `ADOPTION_ROOT` (lifecycle), `isBrownfield` (census), step-file constants (formats) |
| `readState`, `assertStateGraph`, `stateMappingMismatch`, `readContext` | formats, visual, census and lifecycle reads |
| `artifact/artifact-migration.mjs` `readHistory`, `historyEventExtraKeys`, `ledgerPrefixesFor`, `validateIntegrity`, `readArtifactState`, `writeTransaction`, `stateFileExists` | artifact formats constants, `verifyConsumedHistory` (decisions), `finishTransaction` (lifecycle) |
| `migration-utils.mjs` `updateRegistry`; `upgrades/upgrade-migration.mjs` `commitReplacement` | they hold the lifecycle-owned module lock / journal (`withModuleLock`, `writeJournalAtomic`, `writeJournal`) |

Leaf declarations left in place on purpose: `PONYTAIL_TARGETS` / `assertPonytailTarget` (product option vocabulary, not domain-neutral), artifact `versionOne` (record vocabulary), the `operator-webauthn.mjs` protocol helpers (lazily loaded decisions file, A3), and `upgrades/upgrade-v4-to-v5.mjs` (frozen upgrader, Q5).

## Filesystem write sites after A1

96 primitive calls, unchanged in number. 20 are now in `store/` (`files.mjs` 10, `record.mjs` 7, `tree.mjs` 2, `registry.mjs` 1). The other 76 are remaining work, not compliant: 4 store-owned (`updateRegistry` 1, `commitReplacement` 3, both above), 62 lifecycle, 5 decisions, 3 slices, 1 census, 1 visual. Reproduce with `node tools/inventory.mjs <repo> <ref> writes` from `docs/architecture/phase0`.
