# Track A8 ownership record: `lifecycle/`

BASE `0a87bbc`. Plan: `docs/phase0-architecture-baseline.md` §4 option (b), §8 A8, Appendix C (lifecycle rows). The 193 lifecycle rows of `owners-b.tsv` were reconciled against BASE:
- 13 of them were no longer at their Phase 0 site. A1, A4 and A5 had already moved them down (the evidence-path cluster to `store/`, `delegatedChangedFilesSatisfiedByChild` and `assertPostAnchorEvidence` to `slices/`, the evidence vocabulary to `census/`).
- Every other lifecycle row now lives in `lifecycle/`, with three exceptions:
  - `engineFault` and `asEngineFault` went to `census/toolchain.mjs` (see "Remaining architectural violations");
  - `artifactEngine`, the lazy-import shim, was deleted, because the cycle it existed for is gone.
- `resumable-migration.mjs`, `artifact/artifact-migration.mjs`, `decision-recorder.mjs`, `operator-approval.mjs`, `lifecycle-policy.mjs`, `module-lock.mjs` and `upgrades/upgrade-coordinator.mjs` declare nothing anymore. `migration-utils.mjs` keeps only the doctor.

**Method.** The extraction preserves behavior.
- **Whole-file `git mv`** for the four files that were already one unit:
  - `decision-recorder.mjs` → `lifecycle/recorder.mjs`;
  - `operator-approval.mjs` → `lifecycle/approval.mjs`;
  - `module-lock.mjs` → `lifecycle/lock.mjs`;
  - `upgrades/upgrade-coordinator.mjs` → `lifecycle/contract-upgrade.mjs`.

  Only import specifiers changed, plus the compatibility re-exports, which moved to the facades.
- **Declaration moves** for the two monoliths:
  - A declaration-level dependency graph over `resumable-migration.mjs`, the artifact engine, the recorder, the offer loop, `lifecycle-policy.mjs` and `migration-utils.mjs` was acyclic. The only cycle was the mutual recursion of `runRecordDecisionCli` and `relayOperatorDecision`, which stay in one file.
  - Every declaration was assigned to a file so that the file graph is a DAG.
  - Each declaration was copied verbatim with its leading comment, in its original order. A declaration that another file needs gained `export`.
  - A check against BASE found 281 declarations byte-identical (ignoring `export`). Nine changed, each on purpose:
    - `artifactBindingFor` and `artifactPrerequisiteWork` no longer `await artifactEngine()`. They import the same five bindings statically.
    - `validateCapabilityOwnership` (census lazy import), `getMigrationStatus` (recorder lazy import), `advanceMigration` (policy lazy import) and `webauthnProtocol` changed only the import specifier.
    - In `deriveArtifactDecisions`, the lazily imported engine namespace became `{ artifactOperatorDecisions, reconcileArtifactDecisions }`.
    - In `loadStructuralParser` and `targetTypeScript`, `import.meta.url` became `ENGINE_URL` (see "Location-sensitive loaders").
- **Evidence that behavior is preserved:**
  - **Exports:** all 61 BASE engine files export the same names, function arities and values. A fresh-process import of every file was compared with a BASE snapshot. The only differences are path-valued roots, which differ because the tree sits in a different directory.
  - **Bindings:** every historical name is the same binding as its `lifecycle/index.mjs` export (A8-ARCH-5).
  - **Types:** `tsc --checkJs --noUnusedLocals` semantic diagnostics equal BASE's. The only additions are "cannot find module `node:*`" lines from the new files' import statements; the analysis runs without `@types/node`. There is no new unused or unresolved name.
  - **Bytes:** A7's parity probe ran the BASE tree and the A8 tree side by side (51 cases), comparing stdout, stderr and exit status:
    - every bin with no arguments and with invalid or refused arguments, `--status`, `--doctor` and `--json`;
    - one MCP session of 13 frames: initialize, `tools/list`, malformed and unknown requests, the status, relay and pending-decision tools, and `artifact_status`;
    - the signer service without its configuration.

    All 51 are byte-identical. The one difference is the `durationMs` metric.
  - **Golden:** `pnpm rehearse` matches the 20-step trace.
  - **Negatives:** `pnpm rehearse:negative` refuses all four corruptions.

## Files

| File | Holds | From |
|---|---|---|
| `lifecycle/index.mjs` | The one public entry. It only re-exports (106 names). | new |
| `lifecycle/policy.mjs` | `BLOCKED_EXIT_CODE`, `DEFAULT_MODE`, `isAutoAuthority`, `renderLoopDirective`, `MIGRATION_MODES`, `maySelfConfirm`, `MIGRATION_OUTCOMES`, `EXIT_CODES`/`exitCodeFor`, `nextOutcome`. A leaf: it imports nothing. | RM + `lifecycle-policy.mjs` |
| `lifecycle/lock.mjs` | The module lock: `lockPathFor`, `acquireModuleLock`, `withModuleLock`, `writeJournalAtomic`, `processAlive` | `module-lock.mjs` (whole) |
| `lifecycle/registry.mjs` | `pendingTransactions`, `assertNoPendingTransaction`, and the journalled `updateRegistry` | `migration-utils.mjs` |
| `lifecycle/checkpoints.mjs` | The module checkpoint vocabulary (`FINAL_GATES`, parity and disposition sets, `STEP_DEPENDENCIES`) and the checkpoint readers (`expectedNextCheckpoint`, `checkpointArtifacts`, `checkpointAction`, `authoringRequest`, `activeArtifact`) | RM |
| `lifecycle/record.mjs` | Step pins, the integrity anchor, the append-only ledger and history checks, `ADVANCE_JOURNAL`, `readState` and `assertStateGraph`, `recoverPendingAdvance`, and the completed-hash checks | RM |
| `lifecycle/openspec.mjs` | OpenSpec lifecycle authority | RM |
| `lifecycle/templates.mjs` | Step templates, initial JSON artifacts, the RESOLVE step | RM |
| `lifecycle/context.mjs` | `readContext`, `readMigrationContext`, `recoverMigrationRecord`, `previewDiscoveryScan` | RM |
| `lifecycle/validation.mjs` | The module checkpoint validators: legacy inventory seam, artifact delegation rows, capability ownership, baseline, plan and slice validation, gates, `validateStep`, `sliceDriftFacts` | RM |
| `lifecycle/preview.mjs` | `previewMigrationExecution`, `assertExecutionConfirmation` | RM |
| `lifecycle/bootstrap.mjs` | The initialization journal (commit, rollback, recovery), `bootstrapMigration`, `bootstrapUnderLock` | RM |
| `lifecycle/reopen.mjs` | Discovery reopen, slice rework and amendment, UI-proof reopen, complete-migration reopen, `repairSliceState` | RM |
| `lifecycle/adoption.mjs` | Visual-contract adoption, required-observation adoption | RM |
| `lifecycle/toolkit-identity.mjs` | The module toolkit-identity gate, automatic adoption, `changeModuleToolkitIdentity` | RM |
| `lifecycle/format-upgrade.mjs` | `FORMAT_UPGRADE_HANDLERS`/`FORMAT_UPGRADERS`, direct-ledger adoption, `pendingFormatUpgrade`, the two commits | RM |
| `lifecycle/progress.mjs` | `CHECKPOINT_STATES`, `migrationProgress` and its renderers | RM |
| `lifecycle/status.mjs` | `getMigrationStatus`, `validateResumableMigration` | RM |
| `lifecycle/advance.mjs` | `previewAdvance`, `renderAdvancePreview`, `advanceMigration`, `advanceUnderLock` | RM |
| `lifecycle/contract-upgrade.mjs` | The v4→v5 contract transaction: preview, execute, rollback, recover | `upgrades/upgrade-coordinator.mjs` (whole) |
| `lifecycle/recorder.mjs` | The one decision recorder | `decision-recorder.mjs` (whole) |
| `lifecycle/approval.mjs` | The offer loop and the terminal and AUTO recorders | `operator-approval.mjs` (whole) |
| `lifecycle/artifact-record.mjs` | Artifact command rendering, history and integrity reads, initial state, invocation binding, the identity gate | AM |
| `lifecycle/artifact-execution.mjs` | Capability-gated execution of target validators | AM |
| `lifecycle/artifact-gates.mjs` | Artifact FINALIZE gate evidence: scope and binding, typed, agent-asserted Ponytail evidence | AM |
| `lifecycle/artifact-checkpoints.mjs` | Artifact checkpoint validation and dispatch, `checkpointArtifacts`, the artifact `previewAdvance`, `nextState` | AM |
| `lifecycle/artifact-transaction.mjs` | The artifact transaction: input validation, replay proofs, recovery phases, finish, recovery, `buildAdvanceTransaction` | AM |
| `lifecycle/artifact-status.mjs` | Metrics, `previewArtifact`, `getArtifactStatus`, `progressState`, and the readers the recorder and the module side call (`artifactOperatorDecisions`, `validateArtifactComplete`) | AM |
| `lifecycle/artifact-run.mjs` | Bootstrap, format upgrade and its handler registry, `runArtifact`, `changeArtifactToolkitIdentity` | AM |
| `census/toolchain.mjs` | The artifact engine's parser-bound structural census: the parser loader, the target compiler and project, `legacyDependencies`, `architectureFindings`, `sourceRequirements`, and the `engineFault`/`asEngineFault` toolchain faults | AM |

RM is `resumable-migration.mjs`; AM is `artifact/artifact-migration.mjs`.

The file graph inside `lifecycle/` runs bottom to top:
`policy`, `lock`, `registry`, `checkpoints`, `openspec`
→ `record` → `templates`, `context`
→ artifact `record` → `execution` → `checkpoints` → `transaction` → `status`
→ `validation`
→ `toolkit-identity` → `adoption`, `reopen`, `format-upgrade`
→ `preview` → `bootstrap`
→ `recorder` → `status`, `approval`
→ `advance`, `artifact-run`, `contract-upgrade`.

Every lifecycle file imports the lower domains through their entries (`shared`, `formats`, `store`, `decisions`, `census`, `visual`, `slices` `index.mjs`). The only other files it imports are the leaves `engine-paths.mjs`, `toolkit-identity.mjs`, `operator-webauthn.mjs` (lazily) and the frozen `upgrades/upgrade-v4-to-v5.mjs`. It never imports `transport/`, a CLI file, `mcp-server.mjs`, `core.mjs`, or a facade (A8-ARCH-3).

## Public API

`lifecycle/index.mjs` exports exactly the names the historical paths take from it, 106 in all (A8-ARCH-1):
- **Policy:** `BLOCKED_EXIT_CODE`, `DEFAULT_MODE`, `exitCodeFor`, `isAutoAuthority`, `maySelfConfirm`, `MIGRATION_MODES`, `MIGRATION_OUTCOMES`, `nextOutcome`, `renderLoopDirective`.
- **Lock and transactions:** `acquireModuleLock`, `lockPathFor`, `processAlive`, `withModuleLock`, `writeJournalAtomic`, `assertNoPendingTransaction`, `pendingTransactions`, `updateRegistry`.
- **Module lifecycle:**
  - checkpoints: `activeArtifact`, `ADOPTION_ROOT`, `authoringRequest`, `checkpointAction`, `checkpointArtifacts`, `compatibilityBlocker`, `expectedNextCheckpoint`, `FINAL_GATES`, `STEP_DEPENDENCIES`, `upgradeCommandFor`;
  - record: `BASELINE_ROWS_PIN`, `DISCOVERY_PIN`, `readState`, `loadOpenSpecAuthority`, `validateOpenSpecProposal`, `previewDiscoveryScan`, `readMigrationContext`, `recoverMigrationRecord`;
  - validation: `artifactBindingFor`, `artifactPrerequisiteWork`, `assertArtifactPrerequisites`, `DECISION_PROJECTION_STATES`, `pendingTargetDriftCandidatesCompat`, `sliceDriftFacts`, `validateArtifactDelegationRow`;
  - transitions: `assertExecutionConfirmation`, `previewMigrationExecution`, `bootstrapMigration`, `repairSliceState`, `adoptUiObservations`, `previewUiObservationsAdoption`, `previewAdvance`, `renderAdvancePreview`, `advanceMigration`;
  - toolkit identity: `assertRecordToolkitIdentity`, `assertToolkitIdentityNotMismatched`, `autoAdoptToolkitIdentity`, `changeModuleToolkitIdentity`, `toolkitAdoptCommand`;
  - format upgrade: `commitFormatUpgrade`, `commitNoOpFormatUpgrade`, `FORMAT_UPGRADERS`, `pendingFormatUpgrade`;
  - status and progress: `CHECKPOINT_STATES`, `migrationProgress`, `renderProgress`, `renderProgressBlock`, `renderProgressChecklist`, `getMigrationStatus`, `validateResumableMigration`.
- **Contract upgrade:** `executeRollback`, `executeUpgrade`, `previewRollback`, `previewUpgrade`, `recoverTransaction`, `recoverUpgrade`, `TRANSACTION_STATES`.
- **Recorder and offer loop:** `beginAttestedDecision`, `completeAttestedDecision`, `parseDecisionArguments`, `pendingDecisionCandidates`, `projectDecisions`, `recordNewFormatDecisionGroup`, `relayOperatorDecision`, `reviewAttestedCandidate`, `runRecordDecisionCli`, `approveWithOperator`, `artifactApprover`, `moduleApprover`, `recorderFor`.
- **Artifact lifecycle:** `artifactArgumentsFor`, `artifactCommandFor`, `assertArtifactToolkitIdentity`, `readArtifactState`, `hasCodeValidationCheck`, `artifactCheckpointArtifacts`, `reconcileArtifactDecisions`, `artifactMetrics`, `artifactOperatorDecisions`, `getArtifactStatus`, `previewArtifact`, `progressState`, `validateArtifactComplete`, `ARTIFACT_FORMAT_UPGRADERS`, `bootstrapArtifact`, `changeArtifactToolkitIdentity`, `previewArtifactFormatUpgrade`, `runArtifact`, `upgradeArtifactFormat`.

Two historical names are shared by two different contracts, so the entry spells them apart:
- The artifact `checkpointArtifacts` is `artifactCheckpointArtifacts`.
- The three-argument `pendingTargetDriftCandidates` compatibility wrapper (A4) is `pendingTargetDriftCandidatesCompat`.

Their historical paths still export the original names, as the same bindings.

## Module and artifact orchestration

The module and artifact lifecycles stay two contracts (A8-ARCH-8):
- **Different checkpoint readers, different files:** `checkpoints.mjs` versus `artifact-checkpoints.mjs`, and module `previewAdvance` in `advance.mjs` versus artifact `previewAdvance` in `artifact-checkpoints.mjs`.
- **What the artifact files read from the module side:** only `FINAL_GATES` (`checkpoints.mjs`), the progress projection (`progress.mjs`), the policy, the lock, and the offer loop.
- **What reaches into the artifact files:**
  - the module delegation validators in `validation.mjs`: `artifactBindingFor` reads `artifactArgumentsFor`/`artifactCommandFor`, and `artifactPrerequisiteWork` reads `getArtifactStatus`/`validateArtifactComplete`;
  - the recorder: `artifactOperatorDecisions`, `reconcileArtifactDecisions`.

  Nothing else does.

Lifecycle composes the domain facts and does not redefine them:
- **Census:** sources, boundary, inventories, completeness and the scan come from `census/index.mjs`. The module legacy-inventory seam still injects visual `assertRequiredObservations` (A5). The parser-bound artifact census is now in `census/toolchain.mjs`.
- **Visual:** evidence, authority, acceptance and UI proof come from `visual/index.mjs`. `validateUiRuntimeEvidence` still receives slices `implementationDigests` as data (A6).
- **Slices:** plan, claims, verification, rework, drift and amendment come from `slices/index.mjs`. Drift facts reach it through `sliceDriftFacts` (A4).
- **Decisions:** candidates, grouping, authority, ledgers and offer/write equivalence come from `decisions/index.mjs`. Lifecycle passes the facts it read under the lock (A3).

No callback that reads facts, takes a lock, or records was added.

## Transaction and journal protocols (unchanged)

The four journals keep their formats, names, stages and recovery order. DR13 (one journal protocol) is Track B.

> Track B DR13 has since given these journals one recovery protocol (`lifecycle/journal.mjs`), moved the initialization adapter to `lifecycle/initialization.mjs` and the registry recovery to `lifecycle/registry.mjs`; formats, names, stages and order are unchanged. See `docs/architecture/dr13-journal-protocol.md`. The table below is the A8 record.

| Protocol | Where now | Journal | Recovery |
|---|---|---|---|
| Module advance, reopen, rework, adoption, identity change, format upgrade | `record.mjs` (`ADVANCE_JOURNAL = "advance.journal"`, `readAdvanceJournal`, `recoverPendingAdvance`), written by `advance`, `reopen`, `adoption`, `toolkit-identity`, `format-upgrade` | `<record>/advance.journal` | `recoverPendingAdvance` before every lock-held mutation; state/history/integrity order unchanged |
| Module initialization | `bootstrap.mjs` (`initJournalFor`, `commitInitialization`, `rollbackInitialization`, `recoverInitialization`) | `.agents/knowledge/migrations/init/<module>.journal` | Rollback or finish under the lock, owner-checked |
| Artifact transaction | `artifact-transaction.mjs` (`validateTransactionInput`, `assertTransactionReplayable`, `assertKnownRecoveryPhase`, `prove*Transaction`, `finishTransaction`, `recoverTransaction`, `buildAdvanceTransaction`), `writeTransaction` | `TRANSACTION_FILE` in the artifact record | Independent replay proof, then finish. `--status` never reproves. |
| Registry | `registry.mjs` (`updateRegistry`) with store's `recoverRegistryJournal`/`registryJournalPathFor` | the registry journal | Before-bytes check |
| Contract upgrade | `contract-upgrade.mjs` (`TRANSACTION_STATES`, `recoverTransaction`, `recoverUpgrade`, `executeRollback`) | `upgrades/<module>/<id>/transaction.json` + `upgrade.lock` | Deterministic restore or finish |

All of them take `lifecycle/lock.mjs`. Outside `lifecycle/`, nothing imports `withModuleLock`, `acquireModuleLock` or `writeJournalAtomic`; only the `core.mjs` aggregator and the `module-lock.mjs` facade re-export them (A8-ARCH-6). The lock path, the stale-owner reclaim and the atomic journal write are the moved file, unchanged. The atomic-write boundaries and history appends are the store primitives, as before.

## Dependency inversions

| Was | Now |
|---|---|
| `resumable-migration.mjs` lazily imported the artifact engine, which imported it back statically (`FINAL_GATES`, `migrationProgress`, `renderProgress`). | `checkpoints.mjs` and `progress.mjs` sit below the artifact files, and the delegation validators sit above them. `artifactEngine()` is gone: its five bindings are plain imports, downward. |
| The recorder statically imported `resumable-migration.mjs` (`readState`, `readMigrationContext`, `previewDiscoveryScan`, `sliceDriftFacts`, `assertRecordToolkitIdentity`, `BLOCKED_EXIT_CODE`). `getMigrationStatus` lazily imported the recorder back, and the recorder lazily imported the artifact engine. | The recorder sits above `record`, `context`, `validation`, `toolkit-identity`, `policy` and the artifact readers, and below `status`, `approval` and `artifact-run`. Its artifact import is static. The `status` → recorder load stays at call time, now pointing downward. |
| `lifecycle-policy.mjs` imported `BLOCKED_EXIT_CODE`/`isAutoAuthority` from `resumable-migration.mjs`, which lazily imported it back. | Both halves are one leaf, `policy.mjs`. The `advanceMigration` → policy load stays at call time, downward. |
| `operator-approval.mjs` imported `isAutoAuthority` from `resumable-migration.mjs`, and the artifact engine imported `operator-approval.mjs`. | `approval.mjs` imports `policy.mjs` and `recorder.mjs`; `artifact-run.mjs` imports `approval.mjs`. |
| `upgrade-v4-to-v5.mjs` took two shared names through `migration-utils.mjs`. | Through `shared/index.mjs` (the same bindings), so the frozen upgrader no longer sits above lifecycle. |

Cycles:
- **Static:** none at BASE, none now.
- **Lazy:** BASE (after A7) had one component, {artifact engine, `decision-recorder.mjs`, `lifecycle-policy.mjs`, `operator-approval.mjs`, `resumable-migration.mjs`}. It is gone, and no lazy cycle remains anywhere in the engine (A8-ARCH-3).
- **The four lazy imports left in `lifecycle/` are pinned:**
  - `advance` → `policy` and `status` → `recorder` are downward, and keep their call-time load and their `.catch`;
  - `validation` → `census/index.mjs` loads the scanner at call time;
  - `recorder` → `operator-webauthn.mjs` keeps `@simplewebauthn/server` unloaded until a signer flow.

  None of them hides an upward edge.

## Recorder and approval boundaries

There is still one recording path. `runRecordDecisionCli` → `withOperatorApproval` (re-derivation under `withModuleLock`, exact candidate equality, challenge check, append) is the moved file, unchanged, and so are the relay, the attested-signer flows and the artifact half. No second recorder exists.

The principals are unchanged:
- **AUTO:** `isAutoAuthority` in `policy.mjs`, `autoDecisionRecorder` in `approval.mjs` with an AUTO-only channel. `autoMayDecide` and the AUTO ledger rules stay in `decisions/`.
- **Human operator:** the TTY/`ask` gate in the recorder.
- **AGENT_RELAYED:** `relayOperatorDecision`.
- **HUMAN_ATTESTED:** the signer-only `beginAttestedDecision`/`completeAttestedDecision`, reached from `operator-signer-host.mjs` through `lifecycle/index.mjs`. The host keeps its three gates.

What the tests pin:
- **A8-ARCH-7:**
  - outside `recorder.mjs`, no lifecycle file imports a ledger write (`appendDurably`, `appendApprovedCandidate`, `appendApprovedGroup`), `buildDecision`, `operatorAnswer`, `relayAnswer` or `lockedApprovalCandidate`;
  - the offer loop reaches the ledger only through its two `runRecordDecisionCli` calls, with no forged TTY or channel;
  - the artifact run loop records only through the offer loop;
  - the recorder and offer-loop API is exactly BASE's.
- **A7-ARCH-7** (retargeted): transport still reaches exactly `pendingDecisionCandidates`, `relayOperatorDecision`, `runRecordDecisionCli` (recorder), `approveWithOperator`, `moduleApprover`, `recorderFor` (offer loop) and `renderDecisionReview`, `reviewReference` (decisions). Each name is attributed through `lifecycle/index.mjs` to its defining file.

**Remaining recorder seam.** These parts are not separated yet:
- **Transport presentation:** `parseDecisionArguments` and the argv-shaped `runRecordDecisionCli`, which write to stdout.
- **Recording authority:** `withOperatorApproval` and the relay.

Both still live in `recorder.mjs`. Splitting them changes the reviewed in-process API, which the offer loop, the relay, MCP elicitation and the signer host all call (A7). Moving the recorder into `lifecycle/` is what resolved the cycle, without moving any authorization rule. Candidate construction, challenges, principal requirements, ledger validation and appends stay in `decisions/`.

## Compatibility and installed paths

| Path | Now | Re-exports |
|---|---|---|
| `resumable-migration.mjs` | facade | the A1–A6 compatibility re-exports, unchanged, plus 54 lifecycle names (`pendingTargetDriftCandidatesCompat as pendingTargetDriftCandidates`) |
| `artifact/artifact-migration.mjs` | facade | its A1–A5 re-exports; `architectureFindings`, `hasExecutableCodeFiles`, `legacyDependencies`, `structuralUnits`, `targetTypeScript` from `census/index.mjs`; 19 lifecycle names (`artifactCheckpointArtifacts as checkpointArtifacts`) |
| `decision-recorder.mjs` | facade | the A3 decisions re-exports plus 9 recorder names |
| `operator-approval.mjs` | facade | `renderCandidateBlock`, `renderGroupBlock` (decisions) plus 4 offer-loop names |
| `lifecycle-policy.mjs`, `module-lock.mjs` | facades | 6 and 5 names |
| `upgrades/upgrade-coordinator.mjs` | facade | `renderRollbackPreview`, `renderUpgradePreview` (formats) plus 8 names |
| `migration-utils.mjs` | doctor + facade | it still declares `runDoctor`, `doctorCheck`, `MINIMUM_NODE_MAJOR`, `existingKnowledgeRoot`; it re-exports `assertNoPendingTransaction`, `pendingTransactions`, `updateRegistry` from lifecycle and keeps its A1/A2/A5 re-exports |
| `upgrades/upgrade-migration.mjs`, `record-decision.mjs`, `migration-policy.mjs`, `core.mjs`, the bin facades | unchanged | they still name the paths above, which are now facades over `lifecycle/index.mjs` |

Every BASE name, arity and value is kept, as the same binding (A8-ARCH-5). Bins, bin paths, provider adapters, `providers/install-support.mjs` and `scripts/runtime-bootstrap.mjs` are unchanged. `git diff` touches nothing under `providers/`, `skills/` or `scripts/`, and `pnpm providers:check` is clean.

**Location-sensitive loaders** (A8-ARCH-9):
- **TypeScript parser:** `census/toolchain.mjs` uses `ENGINE_URL = new URL("../artifact/artifact-migration.mjs", import.meta.url)`. That is the old file's own URL, so `createRequire` resolves `ts-discovery-compiler` from the same directory, and `parserResolutionError` still names that file (the A5 `SCANNER_URL` precedent). The test compares the pinned-fallback compiler with one required from `src/artifact/artifact-migration.mjs`.
- **Contract-upgrade reference:** `lifecycle/` sits at the same depth as `upgrades/`, so `../../references/v5-contract.md` resolves to the same file.
- **`runDoctor`:** the installed runtime still imports it from `src/migration-utils.mjs`, which still declares it.
- **Command rendering:** `engineCommand`, `artifactArgumentsFor`/`artifactCommandFor` and `toolkitAdoptCommand` render the same historical script names, because they name scripts, not their own file.
- **Optional dependencies:** importing `lifecycle/index.mjs`, every facade and `core.mjs` in a fresh process prints nothing. It loads neither the parser, pngjs/pixelmatch, `operator-webauthn.mjs` nor `@simplewebauthn/server`.

## Adversarial test evidence

New tests:
- `test/unit/lifecycle.test.mjs`, A8-ARCH-1 to A8-ARCH-9 (added to `engine:test`);
- `migration-contract` "P0-1: a LIVE_MOVED transaction blocks reopen, rework and repair with zero writes" (case 10).

Everything else is existing coverage, which ran green on this tree.

| # | Case | Tests |
|---|---|---|
| 1 | Crash after journal creation | journal-recovery spec "crash windows: bootstrap/advance/explicit pristine 13 -> 14 upgrade"; migration-contract "P1-11: a kill at every journal/rename boundary leaves a lock a fresh process reclaims" |
| 2 | Interrupted state/history commit | "R-W6-d: a crash between the state write and the integrity write recovers…", "R-W6-e: … the history append recovers idempotently", "a reopen killed between the state write and the history append is completed", "P1-3: an interrupted transition is completed deterministically on the next command" |
| 3 | Recovery repeated twice | "R-W6-e" (recovering twice appends nothing); migration-contract "FU-4: a crash after the state write recovers forward to exactly one event" (recovering again appends nothing); journal-recovery "replays the exact format upgrade once after ${phase}" |
| 4 | Pending journal with invalid state | "an unreadable advance journal is preserved and fails recovery from either position"; journal-recovery "refuses missing, forged and mismatched journal identities before publication" |
| 5 | Stale confirmation ID | "P1-6: changing the brief bytes after preview invalidates the confirmation", "P1-4: swapping the resolved legacy root invalidates the confirmation", "changing the proposed OpenSpec makes the prior confirmation stale", registry-resolution "missing or expired" |
| 6 | Wrong checkpoint transition | migration-contract format-17 freeze ("current step is 'DISCOVERY_COMPLETENESS'" for every later step); "P1-1: a hand-edited currentStep contradicts the append-only history" |
| 7 | Changed bound inputs | "P1-6: execution without the preview's bound inputs is refused", "P1-6: dirty legacy bytes, dirty target bytes, and brief bytes are bound" |
| 8 | Format upgrade interruption | journal-recovery "crash windows: explicit pristine 13 -> 14 upgrade"; "an interrupted adoption is recovered, not half-applied" |
| 9 | Upgrade rollback and recovery | "P0-1: a real v4 upgrade killed at LIVE_MOVED never bootstraps a fresh migration"; "an executed upgrade rolls back to the contract-4 tree only under explicit confirmation" |
| 10 | Reopen during an active transaction | **new** "P0-1: a LIVE_MOVED transaction blocks reopen, rework and repair with zero writes" (refresh, reopen-discovery, reopen-ui, reopen-complete, rework, repair) |
| 11 | Rework with stale evidence | "UI-9: changing an owning slice file narrowly stales its UI evidence", "R-W3-e: a fourth rework is refused, naming the slice" |
| 12 | Toolkit identity mismatch | toolkit-identity "toolkit identity: safe transitions auto-adopt, unsafe ones fail closed"; "A-02 artifact mismatch remains BLOCKED with progress and exact identity recovery command"; "a forged identity in state.json is refused by the integrity anchor and the history" |
| 13 | Artifact versus module state differences | **new** A8-ARCH-8; artifact-delegation "a binding mismatch blocks the parent", "a genuinely blocked child blocks the parent" |
| 14 | AUTO versus operator authority | auto-authority "AUTO is the default principal and `--mode step` is the only way out of it"; "A3: AUTO and a host channel never answer a format-19 review, and a signer requirement is never met locally" |
| 15 | Wrong or stale decision principal | operator-approval-authority "no fabricated, unbound, stale or mismatched ledger line authorizes…"; "the v2 writer produces AGENT_RELAYED only, never HUMAN_ATTESTED or a v2 AUTO line"; operator-signer "module 19: forged, edited, unclaimed and duplicated attested lines are refused" |
| 16 | Wrong or tampered persisted evidence | "store: the history chain verifies, and a one-byte edit, a reorder or a forged head is refused"; "group audit rejects tampering, reordering, and an incomplete append"; "pilot 14 rejects forged visual receipts without bypassing visual checks"; `pnpm rehearse:negative` |
| 17 | Compatibility paths and exports | **new** A8-ARCH-5; A1–A7 COMPAT tests (all green) |
| 18 | Import-time side effects and lazy loading | **new** A8-ARCH-9; A5-ARCH-6, A6-ARCH-6, A7-ARCH-9 |

Test-site edits. The old-site source guards inspect the new implementation, not empty facades:
- **Retargeted:**
  - run-migration (the offer-loop boundary) → `lifecycle/approval.mjs`;
  - engine-paths R-1 → `lifecycle/preview.mjs`;
  - artifact-delegation (prerequisite call count) → `lifecycle/validation.mjs`;
  - artifact-delegation (MCP and the shared recorder) → `lifecycle/artifact-run.mjs` and `lifecycle/approval.mjs`;
  - artifact-migration R-W7-d → the six `lifecycle/artifact-*.mjs` files;
  - formats `SAME_NAME_OTHER_RULE` and `RAW_FORMAT_COMPARISONS` (same counts);
  - census A5-ARCH-4 seams;
  - transport A7-ARCH-4 (split files) and A7-ARCH-7 (authority attribution).
- **Extended:** the store, slices, census and visual MOVED rules (A1-ARCH-3, A4/A5/A6-ARCH-4) now also apply to every `lifecycle/` file.

## Deferred (Track B, not implemented)

- **DR13:** one journal protocol. The journals above keep their formats. Done in Track B (`docs/architecture/dr13-journal-protocol.md`).
- **I7:** step-document timing.
- **I4:** tolerance guidance.
- **DR18/Q6:** design-source reinitialization.
- **DR4:** one claim spelling.
- **I8:** contract schemas.
- **P4:** cross-slice planning.
- **I3/DR28:** implicit-root policy. Two copies remain, in census and `decisions/record.mjs`.

F4 and I6 stay as implemented.

## Remaining architectural violations

These rows of `owners-b.tsv` name an owner other than lifecycle but live in `lifecycle/`. Each was a documented seam of an earlier track and moved with its file, unchanged:
- **store (31):**
  - module pins, anchors and append-only checks, `readState`/`assertStateGraph`, `appendHistoryOnce`, completed-hash checks and `readContext` (`record.mjs`, `context.mjs`);
  - `stateMappingMismatch`;
  - the artifact history and integrity reads, `ledgerPrefixesFor`, `writeTransaction`, `stateFileExists`;
  - `updateRegistry`.

  They read the record under the lifecycle lock and validate it against lifecycle state. Lowering them changes no behavior, but it is a store reassignment, not A8.
- **slices (26):**
  - the artifact validator runners (`artifact-execution.mjs`), kept with the capability that gates them;
  - the artifact plan, implementation and verification validators;
  - the module slice validators;
  - `repairSliceState`, `reworkSliceUnderLock`, `amendSliceUnderLock`;
  - `RESOLUTION_KIND`.

  They are the A4 seams (two `assertArtifactPrerequisites` calls between slice checks, and the lock-held transitions).
- **decisions (31):**
  - the recorder and the offer loop (see "Recorder and approval boundaries");
  - `artifactVisualDecisions`, `reconcileArtifactDecisions`, `artifactOperatorDecisions`, `readMigrationContext`;
  - `isAutoAuthority`/`maySelfConfirm`, which A3 kept out of decisions because they read `DEFAULT_MODE`.
- **transport (11):**
  - `artifactArgumentsFor`, `artifactCommandFor`, `artifactIdentityCommand`: the artifact engine renders them into state and refusals (A7);
  - `MIGRATION_MODES`, `EXIT_CODES`/`exitCodeFor`, `BLOCKED_EXIT_CODE`, `renderLoopDirective`: read by the artifact engine and the decision seams (A7);
  - `parseDecisionArguments`, `runRecordDecisionCli`, `runArtifactDecisionCli`: the recorder API (A7).
- **formats (8):**
  - `upgradeCommandFor`, `compatibilityBlocker`, `validateStateShape`;
  - the toolkit-identity gates and their command rendering.

  They render lifecycle commands into format refusals.
- **census (7) and visual (5):**
  - the artifact source, target and completeness validators, which read the decision ledger and the checkpoint history;
  - the module legacy-inventory wrapper;
  - `reopenDiscoveryUnderLock`, `previewDiscoveryScan`;
  - the UI-proof reopen and the navigation-repair check (A5/A6 seams).
- **The other direction:** `engineFault` and `asEngineFault` (owners-b: lifecycle) live in `census/toolchain.mjs`, because the parser-bound census raises them and census may not import lifecycle.
- **`operation-sequence.mjs`** (owners-b: decisions) stays at `src/`. It sits above lifecycle and imports `lifecycle/index.mjs`. `core.mjs` is its only importer.
- **Facades over facades:** `core.mjs`, `cli/run-migration.mjs`, `mcp-server.mjs`, `migration-policy.mjs`, `record-decision.mjs` and `upgrades/upgrade-migration.mjs` still name the historical paths. They are the top of the graph (A8-ARCH-2 pins the list).

No static or lazy import cycle remains. No lower module names `lifecycle/` or a lifecycle facade.
