# Track B DR13: one journal protocol

BASE `29b22f5`. Phase 0 finding DR13 (`docs/phase0-architecture-baseline.md`): five journal formats, each with its own recovery dialect. A8 moved all of them into `lifecycle/` unchanged (`docs/architecture/a8-ownership.md`, "Transaction and journal protocols").

DR13 keeps every journal format, file name, stage and writer order. It gives them one recovery protocol with format adapters.

## Where it lives

| File | Holds |
|---|---|
| `lifecycle/journal.mjs` | The protocol: `writeJournalAtomic` (moved from `lock.mjs`), `readJournal`, `removeJournal`, `recoverJournal`, `refuseJournal`, `assertJournalFields`, `assertJournalTargets`, plus the shape checks `assertAdvanceJournal` and `assertUpgradeJournal` |
| `lifecycle/initialization.mjs` | The initialization adapter, moved from `bootstrap.mjs`: `initJournalFor`, the owner marker, cleanup, rollback, `recoverInitialization` |
| `lifecycle/record.mjs` | The advance adapter, `recoverPendingAdvance`, and the state-graph proof it uses |
| `lifecycle/registry.mjs` | The registry adapter, `recoverRegistryJournal` (moved from `store/registry.mjs`) |
| `lifecycle/artifact-transaction.mjs` | The artifact adapter, `recoverTransaction` |
| `lifecycle/contract-upgrade.mjs` | The upgrade adapter, `recoverTransaction` and `recoverUpgrade` |
| `store/files.mjs`, `store/record.mjs` | `removeDurably`, the one durable removal: unlink checked from a trusted root, then the nearest existing directory fsynced (`syncNearestDirectory`). Also `historyTailOf`/`isTornAppendOf`, which recognize a torn `appendHistory` of one event, byte for byte |

Every journal removal goes through `removeDurably`. `FS_WRITERS` (A10-SRC-1) drops from 24 files to 12. In `lifecycle/`, only the lock, initialization (staged trees, owner marker, OpenSpec link and their rollback) and the upgrade's trees still touch the filesystem directly.

## Inventory

| Journal | File | Writers | Stages the writer leaves | Lock | Recovery | Settles by |
|---|---|---|---|---|---|---|
| Module transition | `<record>/advance.journal` | advance, refresh, reopen (discovery, UI, complete), rework, amend, repair, both adoptions, toolkit identity, both format upgrades | journal, (restored files), integrity, state, history, removal | module | `recoverPendingAdvance`, before every lock-held mutation and from `recoverMigrationRecord` | durable removal |
| Module initialization | `init/<module>.journal` | `commitInitialization` | journal, staged tree/OpenSpec/config, OpenSpec link, config rename, root + owner, entries (state last), cleanup, removal | module | `recoverInitialization`, from `bootstrapUnderLock` and `recoverMigrationRecord` | durable removal |
| Registry and binding | `registry.journal.json` | `updateRegistry` | journal, registry, package.json binding, removal | `registry` | `recoverRegistryJournal`, before every registration | durable removal |
| Artifact transaction | `artifacts/<id>/transaction.json` | `writeTransaction` (bootstrap, advance, format upgrade, toolkit identity) | journal, history, state, integrity, removal | artifact | `recoverTransaction`, before every artifact mutation | durable removal |
| Contract upgrade or rollback | `upgrades/<module>/<id>/transaction.json` | `commitReplacement` | PREPARED, LIVE_MOVED, TARGET_COMMITTED, DONE | module | `recoverUpgrade` (`--recover`) | terminal state written and kept |

## The protocol

1. **Read** (`readJournal`). An absent journal is `null`. A journal is trusted only if it is a regular file below its target root, reached through no symlink, and holds one JSON object. Anything else is unreadable. An unreadable journal is never recovered and never removed: recovery throws, and the journal stays byte for byte. `--status` and the artifact run use the same reader, so status never reports a journal as healthy when the run would refuse it.
2. **Validate and bind.** The adapter checks the journal's fields against what its writers have recorded since v1.0.0 (the field sets were checked across git history). It also checks that the journal belongs where it was found: same module, same target, same derived paths.
3. **Classify before writing.** The adapter maps what is on disk to one of the phases its writer can leave. Any other phase is refused (`refuseJournal`: "preserved exactly as found ... Nothing was changed") before anything is written. Every path the repair will touch is also checked first (`assertJournalTargets`). It must be absolute and canonical as written, because a `..` after a symlink would resolve somewhere the lexical check never looked. It must also sit inside its root, with no symlink anywhere below that root.
4. **Repair durably, then prove.** Every repair is a store replace-write, append or durable removal. The adapter then proves the result: the strict state-graph replay plus the anchor, the reproved artifact transition, both registry files at their after bytes, or the live tree's manifest.
5. **Retire.** The journal is removed with `removeDurably` only after the proof. Upgrade journals are kept, with their terminal state, as the upgrade record. A failure at any step leaves the journal in place, so running recovery again is always safe.

## State matrix

Every row not listed is refused before any write.

**Advance journal** (format checked by `assertAdvanceJournal`: one revision step, an event of that step, restores only of record files that are not `integrity.json`, `history/` or the journal, each entry either removing or rewriting).

| `state.revision` | `integrity.json` | history | Action | Outcome |
|---|---|---|---|---|
| from | before or after | ends on a record boundary | Restore entries, then the anchor back to before; strict proof | `DISCARDED_UNCOMMITTED` |
| to | before or after | ends before the event, or in a torn append of exactly this event | Prove the anchor in effect afterwards against this state and history; it may be absent only on a record older than anchors. Write it if the disk still holds the before bytes, seal the tail, append the event once; strict proof | `COMPLETED_HISTORY` |
| to | after | includes the event | Prove the anchor, then the strict proof | `ALREADY_COMPLETE` |
| neither | | | refused | |
| | neither | | refused | |

In every row, the state must already replay from history plus, at most, this journal's one event; otherwise the journal is refused. A `state.json` restore entry must hold the bytes already on disk (the format upgrade's idempotent restore). A file the persisted state pins may only be left as it is or given back bytes that match its pin, and is never removed. Unpinned before-bytes exist only in the journal (operator-only, symlink-checked); that is the format's limit.

**Initialization journal** (`assertInitJournal`: the module, the journal path, the root, the owner marker and every staged path are exactly the ones `commitInitialization` derives; the OpenSpec source is inside the target; the binding is the project's `package.json`, for a project related to the target).

| Root | Owner marker | `state.json` | Action | Outcome |
|---|---|---|---|---|
| absent or empty | none | | Undo the binding if it is at its after bytes, the OpenSpec link if it is the staged inode, staged copies; durable | `ROLLED_BACK` |
| present | this transaction | no | Same, and the root | `ROLLED_BACK` |
| present | this transaction or none | yes | Prove the record reads clean (`readState`), that the OpenSpec source exists and that the registry binding is the one written; then remove staged copies and owner, durably | `COMPLETED` |

The commit point is the rename of `state.json`, the last entry. A failure after it never rolls the record back. That includes a failed directory fsync of that rename, the post-commit hook and cleanup. The journal stays, and recovery finishes the cleanup as `COMPLETED`. The owner marker that authorizes removing the root is itself symlink-checked before it is read.
| present | another transaction | | refused | |
| non-empty | none | no | refused | |

A preview of a record without state reports an interrupted initialization as `pendingTransaction`. `discover-module` then recovers it under the lock through `recoverMigrationRecord`, exactly as it already did for the advance journal.

**Registry journal.** The registry must be inside the target, and the binding must be the `package.json` of a project that contains the registry and is related to the target. The after bytes must be a registry document that validates, and a binding to exactly that registry. Each file must hold its journalled before or after bytes. Recovery then writes the after bytes where needed and proves both files. Any other bytes are refused, with nothing written.

**Artifact transaction.** The phases are unchanged (`assertKnownRecoveryPhase`). The journal is bound to its record, and its kind is dispatched explicitly (BOOTSTRAP, ADVANCE, FORMAT_UPGRADE, TOOLKIT_IDENTITY). An unknown kind is refused before any proof.

**Upgrade journal.** The states and the manifest-driven classification are unchanged. Every upgrade journal found, terminal or not, must have its coordinator's fields, state and kind, this module, and a directory named for its confirmation (`assertUpgradeJournal`). Every journal must also carry its live path and directory, whose last segments are the module and the confirmation. A terminal state therefore cannot hide a malformed or foreign journal, and it still reads after a repository move. A pending journal must name this module's live tree and directory exactly as its writer derived them, and recovery acts on the derived paths. Every writer since v1.0.0 writes both manifests before its first journal write. So without a manifest only a `PREPARED` journal is classified at all, with its intact live tree or immutable snapshot as the record (pinned by P2-4). The rollback tree is restored only when it matches the source manifest. The snapshot is proven against the source manifest before and after it is restored.

## Compatibility and behavior changes

- No journal byte format, file name, stage or write order changed. Historical journals with every field set seen since v1.0.0 are accepted. That includes advance journals without `integrity` and version-1 artifact journals.
- These are stricter than BASE, and each is refused fail-closed with the journal preserved:
  - **Registry.** A registry or binding changed outside the workflow after a crash is refused. BASE dropped the journal and left a half-applied pair.
  - **Registration failure.** A registration that fails after writing its journal now keeps it, and the next registration finishes the pair. BASE removed it in a `finally`.
  - **Forged paths.** Initialization, registry and upgrade journals that name paths their writer never derives are refused. BASE removed or wrote those paths, recursively in the initialization case.
  - **Leftover advance journal.** An advance journal left behind at the persisted revision no longer skips the state-graph replay in `readState`.
  - **Unknown fields and phases.** A journal with an unknown field, a symlinked or non-object journal, or an anchor or state outside the journal's phases is refused.
  - **Restores.** An advance restore that would rewrite or remove a file the persisted state pins, to bytes the state does not pin, is refused. So is a history tail that is not a torn append of the journal's own event; BASE sealed such a tail away.
  - **Committed initialization.** An initialization found committed is retired only after `readState` passes and its binding and OpenSpec source are still the ones it wrote.
  - **Registry after-bytes.** A registry journal whose after bytes are not a valid registry, or not a binding to that registry, is refused.
  - **Upgrade journals.** Every upgrade journal must be well formed, including terminal ones. A rollback tree is never restored without its source manifest.
- Durable removal fsyncs the nearest existing ancestor, so an undo under a directory a crash came before (for example, a rework's new evidence directory) cannot wedge.
- Two recovery wedges are fixed:
  - **Missing `modules/`.** An initialization that died right after its journal write (before `modules/` existed) failed recovery forever on the strict directory fsync. It now fsyncs the nearest existing ancestor.
  - **Killed initialization.** A process killed after an initialization commit (for example, the OpenSpec link) left a preview that refused forever, so recovery was never reached. The preview now reports the pending initialization, and the resume recovers it.

## Tests

- `migration-contract.test.mjs` "DR13: …", 15 tests:
  - every advance crash boundary, in-process and with a real SIGKILL;
  - every initialization commit with a real SIGKILL;
  - a failure after the initialization commit point;
  - forged, unknown-phase, symlinked and non-file journals;
  - restores, history tails and undo targets;
  - undo and removal durability, traced;
  - the initialization, registry and upgrade adapters.
- `artifact-migration.test.mjs` "DR13: …": the artifact journal, through both `--status` and run.
- The DR7 initialization trace tests now expect the durable unlink and its fsync.

Every DR13 safeguard was mutation-checked: removing it makes at least one of these tests fail. One mutation is equivalent: moving the committed cleanup back inside the rollback `try` is caught by the commit-point guard as well.
