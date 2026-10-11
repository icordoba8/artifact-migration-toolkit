# Track A2 ownership record: `formats/`

BASE `21e9e48`. Plan: `docs/phase0-architecture-baseline.md` §2 (R2, R5), §3 (DR20, DR24), §4 option (b), §4.1, §7, §8 A2, Appendix A. The formats rows of `owners-b.tsv` were reconciled against BASE: one row had drifted (`INTEGRITY_FILE` had moved to `store/` in A1); every other row was still where the map put it.

Behavior-preserving: declarations moved verbatim. The only edits inside moved code:
- `recordCompatibilityBlocker` and `validateRecordStateShape` take the upgrade-command renderer as a third argument. `resumable-migration.mjs` binds `upgradeCommandFor` in `compatibilityBlocker` and `validateStateShape`, so the refusal bytes are unchanged (§4.1: formats renders no command).
- `assertNoPendingFormatUpgrade`, `artifactFormatUpgrade` and `artifactFormatAdmissible` walk the pure increment tables instead of the joined upgrader tables. They have the same rows in the same order, and these functions read only eligibility fields.
- In the artifact engine, `KNOWN_STATE_KEYS` and `OPTIONAL_STATE_KEYS` are renamed `ARTIFACT_*`, because the module record keeps its own `KNOWN_STATE_KEYS` in formats.
- The artifact engine's duplicate `HISTORY_FILE` / `INTEGRITY_FILE` were dropped. They held the same strings as the store copies (DR24).

Consumer edits (DR20): 32 artifact-format checks of `formatVersion === / !== 14` now call `usesArtifactDirectLedger(...)` (28 in `artifact/artifact-migration.mjs`, 4 in `record-decision.mjs`). The 3 `ANCHORED_FORMAT_VERSION` comparisons in `resumable-migration.mjs` now call `usesIntegrityAnchor(state)`. Each predicate reads exactly the operand the comparison read, including an unguarded `state.formatVersion`.

## Files

| File | Holds |
|---|---|
| `formats/index.mjs` | the one public entry |
| `formats/module.mjs` | module contract, format and workflow versions; the ten `uses*` predicates and `usesIntegrityAnchor`; supported, active, floor, non-promoting and self-healing sets; `stampedFormatVersion`, `formatIsSupported`, `formatIsPromoting`; `recordCompatibilityBlocker`; `MIGRATION_STEPS`, `LEGACY_MIGRATION_STEPS`, `stepsFor`, `STEP_FILES`, record file names, `initialArtifacts`; the direct-ledger eligibility window; `FORMAT_INCREMENTS`, `assertNoPendingFormatUpgrade` |
| `formats/state.mjs` | module state shape: `validateRecordStateShape`, `KNOWN_STATE_KEYS`, OpenSpec authority, legacy revision and target adoption shapes |
| `formats/artifact.mjs` | artifact contract, format and workflow versions; `ARTIFACT_FORMAT_INCREMENTS`; admission; `artifactFormatUpgrade`; `usesArtifactDirectLedger`; state keys, `validateState`, `validateBinding`, `replayToolkitIdentity` |
| `formats/upgrade.mjs` | the format-upgrade walk (`nextIncrement`, `upgradeIsActive`, `classifyUpgrade`, `assertRegistryCoverage`, `upgradeProjection`); the upgrade transaction's layout paths, `confirmationIdFor` and the preview renderers |
| `formats/record.mjs` | `HISTORY_FILE`, `INTEGRITY_FILE`, Ponytail target vocabulary |
| `formats/design-source.mjs` | `DESIGN_SOURCES`, Figma link normalization |
| `formats/toolkit-identity.mjs` | toolkit identity shape, key, digest, comparison, events, refusal text and status |

## Guarantees and their one owner

| Guarantee | Public function(s) (`formats/index.mjs`) | Test |
|---|---|---|
| Format feature gates (DR20) | `uses*`, `usesIntegrityAnchor`, `usesArtifactDirectLedger` | formats.test: each format predicate turns on exactly at its format… |
| Historical compatibility and non-promotion | `recordCompatibilityBlocker`, `formatIsSupported`, `formatIsPromoting`, `stampedFormatVersion`, `stepsFor` | formats.test: historical formats keep their lifecycle…; the compatibility classification is formats'…; migration-contract.test |
| Module and artifact state shape | `validateRecordStateShape`, `validateState` | migration-contract.test, artifact-migration.test |
| Upgrade eligibility (which increments exist, input, activation) | `FORMAT_INCREMENTS`, `ARTIFACT_FORMAT_INCREMENTS`, `assertNoPendingFormatUpgrade`, `artifactFormatUpgrade` | formats.test: each engine's upgrader rows are…; the freeze gate and artifact admission…; format-upgrades.test |
| Record-layout names | `HISTORY_FILE`, `INTEGRITY_FILE`, `STEP_FILES`, `*_FILE`, `initialArtifacts` | formats.test: formats owns the record-layout names store persists… |

Mechanical checks:
- `store-shared.test.mjs` A1-ARCH-1/2 now cover `formats/`. It has a single public entry, imports only `shared/`, imports no `node:fs*` at all, and runs nothing at import.
- `formats.test.mjs` A2-ARCH-1: every formats declaration has exactly one live definition. A2-ARCH-2: engine code reaches formats names only through `formats/index.mjs`. A2-ARCH-3: the remaining raw `formatVersion` comparisons outside formats match the table below exactly. A2-ARCH-4: the compatibility exports still exist and are the formats binding itself.

## Upgrade registries (§4.1)

Formats owns the pure half: `FORMAT_INCREMENTS` and `ARTIFACT_FORMAT_INCREMENTS` hold `{from, to, id, version, requiredInput, activation}`. The activation predicate reads persisted pins only.

The lifecycle keeps the runtime half: `FORMAT_UPGRADE_HANDLERS` (`resumable-migration.mjs`) and `ARTIFACT_FORMAT_UPGRADE_HANDLERS` (`artifact/artifact-migration.mjs`) hold `{domain, plan, commit}`. `FORMAT_UPGRADERS` / `ARTIFACT_FORMAT_UPGRADERS` join the two halves by `from`, keeping the same exports, row order and frozen rows. `pendingFormatUpgrade`, `commitFormatUpgrade` and the transactions are unchanged. The release gate (`assertRegistryCoverage`) still runs on the joined rows, and it refuses the pure table alone.

## Record layout: formats owns the names, store owns the behavior

`HISTORY_FILE = "history/history.ndjson"` and `INTEGRITY_FILE = "integrity.json"` are defined in `formats/record.mjs`. Store imports them from `formats/index.mjs` and re-exports them from `store/record.mjs` and `store/index.mjs`, so `store` exports the same names with the same values. The history chain, integrity anchor, appends and durability stay in store.

## Compatibility

`core.mjs`, `resumable-migration.mjs`, `artifact/artifact-migration.mjs`, `migration-utils.mjs`, `format-upgrade.mjs`, `toolkit-identity.mjs`, `upgrades/upgrade-migration.mjs` and `store/` export the same names with the same values they had at BASE (all 38 BASE engine files compared). Moved names are thin re-exports of the formats binding. Engine code imports `formats/index.mjs` directly.

## Not moved, with the reason (reconciled against `owners-b.tsv`)

| Declarations | Reason |
|---|---|
| `resumable-migration.mjs` `upgradeCommandFor`, `toolkitAdoptCommand`, `TOOLKIT_IDENTITY_SCRIPT` | They render a CLI command through `engineCommand` (transport). A typed remedy is the §4.1 Track B transport change. |
| `assertRecordToolkitIdentity`, `assertToolkitIdentityNotMismatched`, `artifact/artifact-migration.mjs` `assertArtifactToolkitIdentity` | They read the running build's identity (`activeToolkitIdentity`, a disk read) and render a command. They call formats' `toolkitIdentityBlocker`. |
| `toolkit-identity.mjs` `activeToolkitIdentity`, `resetActiveToolkitIdentity`, the cache | They read `build-identity.json` from disk (R2). |
| `engine-paths.mjs` `engineScriptsRoot`, `engineSkillRoot` | They are derived from the file's own `import.meta.url`, so moving them would change their value. They are install location, not record vocabulary. |
| `upgrades/upgrade-migration.mjs` `classify` | It reads the frozen v4 → v5 constants. |
| `upgrades/upgrade-v4-to-v5.mjs` (whole file) | Frozen snapshot (Q5). Its own `STATE_FILE`, `HISTORY_FILE`, `INTEGRITY_FILE`, `STEP_FILES` stay and are named exceptions in A2-ARCH-1. |
| artifact `FEATURE_FILE`, `QUERY_KEYS_FILE` | Source-tree regexes of the structural census. These are scanner vocabulary, the same R5 override that gave `NEXT_*_FILES` to census (A5). |
| `PROTECTED_DECISION_POLICY_FILE`, `operator-signer*.mjs` `SERVICE_CONFIG_FILE`, `ACTIVATION_MANIFEST_FILE`, `STORE_FILE` | Host paths of the decision policy and the operator signer, not record layout (decisions, A3). |

Added beyond `owners-b.tsv`: `PONYTAIL_TARGETS` / `assertPonytailTarget` (leaf in the map). Both state validators read them, so leaving them in `migration-utils.mjs` would be a formats → monolith edge.

Same name, different rule (not duplicates): `resumable-migration.mjs` `FIGMA_NODE_ID` is the canonical `<page>:<node>` form (DR25, visual), while formats' is the URL `<page>-<node>` form. `resumable-migration.mjs` `confirmationIdFor` hashes an advance snapshot, while formats' hashes the upgrade preview (DR21).

## Format branching left outside formats/

Raw `formatVersion` comparisons outside formats: 9 remain, pinned by A2-ARCH-3 (60 in the same files at BASE).
- `artifact/artifact-migration.mjs` (5):
  - `resolveArtifact`: creation stamp against `ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS` / `ARTIFACT_FORMAT_SUPPORTED`.
  - `pristineFormatUpgrade`: `!== 13`, the pristine 13 → 14 source check.
  - `validateTransactionInput`: `!== undefined && !== 14`, input admission with its own message.
  - `proveBootstrapTransaction`: persisted format equals the journalled input.
- `upgrades/upgrade-migration.mjs` (2): `classify` (`=== 3`) and `executeUpgrade` (`!== V5_FORMAT_VERSION`), on the frozen v4 → v5 path.
- `upgrades/upgrade-v4-to-v5.mjs` (2): the frozen snapshot.

`formatVersion ?? 1` default reads outside formats: `resumable-migration.mjs` `pendingFormatUpgrade` (the lifecycle's cursor, passed to `nextIncrement`), `upgrade-migration.mjs` `classify`, and the frozen snapshot. BASE had 23.

## Remaining dependency violations

- formats: 0 outgoing edges outside `shared/` (A1-ARCH-2). The §4.1 edges are gone. The registry edges are removed by the split, and the `engineCommand` edges are removed by leaving the three renderers out of formats.
- store → formats is the one new edge, and it points down.
- Unblocked but not moved (store work, outside A2): the A1 store functions blocked only by formats constants (`decisionsAnchorNow`, `autoDecisionsAnchorNow`, `renderIntegrityNow`, `assertDecisionsAppendOnly`, `assertHistoryAppendOnly`) now import those constants from `formats/index.mjs`.
