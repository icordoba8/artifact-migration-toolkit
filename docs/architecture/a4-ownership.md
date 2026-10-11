# Track A4 ownership record: `slices/`

BASE `04e8136`. Plan: `docs/phase0-architecture-baseline.md` §2 (R6), §4 option (b), §8 A4, Appendix C (slices rows). The slices rows of `owners-b.tsv` were reconciled against BASE:
- 84 of the 85 rows were still at their Phase 0 sites. The 85th, `artifact-migration.mjs` `execFileAsync`, moved to `shared/` in A1.
- F6 had added `resumable-migration.mjs` `driftCandidateFacts`, which is slices-owned (A3 record) and moved.

**Scope.** A4 is a partial extraction of the owners-b slices rows, by design:
- 56 of the 84 rows now live in `slices/`, plus `driftCandidateFacts`.
- Two owners-b lifecycle rows are re-homed to slices, because slices is their only caller: `assertPostAnchorEvidence` and `delegatedChangedFilesSatisfiedByChild`.
- Nine new slices functions hold the slice rules split out of orchestration seams.
- The other 28 rows stay outside. All of them are listed under "Not moved" below.

**Method.** The extraction preserves behavior.
- An AST mover cut 70 declarations verbatim, leading comments included. 61 of them are byte-identical at their new site, checked by text comparison against BASE.
- The other 9 changed only in the ways the split required:
  - five functions now take census facts as parameters or were split around a lifecycle call (`validatePlan`, `validateImplementedSlice`, `unlistedSliceFiles`, `sliceAmendmentFor`, `readTargetBaseline`);
  - three drift functions take those facts and a renderer (`classifyTargetDrift`, `pendingTargetDriftCandidates`, `assertNoUnclaimedTargetDrift`);
  - one path constant is resolved from its new directory: `ENGINE_SKILL_ROOT` adds a second `".."`, so its value is unchanged.
- Each split puts the slice rules in `slices/` and leaves the census, visual, lifecycle and transport reads in the existing orchestration seam, which passes them in as data (option (b)).
- Evidence that the extraction preserves behavior:
  - **Types:** `tsc --checkJs --noUnusedLocals` diagnostics equal BASE's once file paths are ignored, apart from two in `slices/drift.mjs`. The `requireModuleDecision` argument diagnostic moved from the lifecycle file with a narrower candidate type. There is one new JSDoc mismatch: `createNewFormatDecisionCandidate` declares `policyKind`, and the inline call (below) passes an object literal where BASE passed an untyped spread. `policyKind` is `undefined` in both.
  - **Exports:** all 51 BASE engine files export the same names, function arities and values. The added names are `resumable-migration.mjs` `sliceDriftFacts` and the store entries below.
  - **Golden:** `pnpm rehearse` matches the 20-step golden trace.
  - **Negatives:** `pnpm rehearse:negative` refuses all four corruptions.

## Files

| File | Holds |
|---|---|
| `slices/index.mjs` | The one public entry. It exports only names that something outside `slices/` uses. |
| `slices/plan.mjs` | Planning and scope checks: `validateSlicePlan` (trace ownership, OpenSpec lineage, required rows, required UI behaviors), `assertCapabilityPlan` (architecture authorities, declared-order dependencies, capability ownership, SHARED_PREREQUISITE ordering), `traceLists`, `assertCoversPlanned`, `NON_TERMINAL_CAPABILITIES`, `TERMINAL_DESIGN_SYSTEM`, `anySliceVerified`. |
| `slices/claims.mjs` | Target-file claims and the target baseline: the claim spellings (`rootRelativePath`, `targetRelativePath`, `legacyRelativePath`, `repoRelative`, `targetRelative`, `canonicalClaim`), `resolveChangedFile`, `implementationDigests`, `plannedTargetOwners`, `withinPlannedScope`, `claimedTargetPaths`; `TARGET_DIRTY_SCOPE`, `renderTargetBaseline`, `validateTargetBaselineShape`, `targetBaselineDrift`, `readTargetBaseline`, `portableRoot`, `baselineDirtyEntries`. From the artifact engine: `migrationChangedFiles`, `diffEntries`, `implementationCoversDrift`. |
| `slices/verification.mjs` | Implementation and verification contracts: `validateSliceImplementation` (record, coverage, verification-only, live/anchored/baseline ownership of every claim), `assertSharedPrerequisitesBuilt`, `assertSlicePassed`, `delegatedChangedFilesSatisfiedByChild`. Reopen ownership: `governingReopen`, `verifiedReopenRecord`, `resolveReopenAnchor`, `anchoredReopenOwnership` (and its cache), `resolveAnchoredOwnership`, `assertPostAnchorEvidence`. FINALIZE: `assertNoUnresolvedVerification`, `assertGatesCoverSliceScenarios`. |
| `slices/rework.mjs` | Rework and preserved attempts: `REWORK_ROOT`, `reworkLimitBlocker`, `reworkPathParts`, `reworkAttemptsOf`, `preservedEvidencePath`, `validateFailedSliceResult`, and `planSliceRework`: the refusals, the preserved bytes and pins, the attempt record and the released state. |
| `slices/drift.mjs` | Drift ownership: `DRIFT_OWNERSHIP_STEPS`, `DRIFT_CLASSES`, `UNDERIVABLE_OWNERSHIP_REASON`, `driftCandidateFacts`, `classifyTargetDrift`, `pendingTargetDriftCandidates`, `unclaimedTargetDrift`, `assertNoUnclaimedTargetDrift`, `unlistedSliceCandidates`, and `settleFact` (below). |
| `slices/amendment.mjs` | Amendment facts and validation: `SLICE_AMENDMENT_ROOT`, `draftSliceAmendment` (lifecycle, history, record and per-file refusals), `completeSliceAmendment` (preservation path, ownership basis, drift class, digests), `ENGINE_SKILL_ROOT`, `TEST_LEVEL_SUFFIX`, `eventNamesSlice`. |
| `slices/state.mjs` | Reconciliation: `inspectSliceArtifacts`, `reconcileSliceState`, `assertSliceStateConsistent`. |

`slices/` imports only `decisions/index.mjs`, `store/index.mjs`, `formats/index.mjs`, `shared/index.mjs` and `node:` builtins. It has no dynamic `import()` and runs nothing at import.

**Re-homed below slices.** These rows are re-homed below slices rather than into it:

| Declarations | Was | Now | Why |
|---|---|---|---|
| `PATH_CLAIM`, `evidencePathClaim`, `resolveEvidencePath`, `assertEvidenceResolves`, `assertEvidenceReference`, `assertCommandResults` | owners-b lifecycle, in `resumable-migration.mjs` | `store/evidence.mjs` | Whether an evidence reference names real bytes, with a matching identity, under the legacy or target root. Census, visual, slices and lifecycle all call these, and they reach only store and shared. Under (b) a primitive that census needs must sit below census. In lifecycle, every caller would be an upward edge, including the 8 slices callers. Moved verbatim. |
| `REOPEN_ROOT` | owners-b store, kept in the lifecycle file by A1 with the pins cluster | `store/record.mjs` | A dependency-free layout constant that the reopen-ownership rules read. The pins cluster itself stays blocked as A1 recorded. |

## Public API

`slices/index.mjs` exports the following, grouped by file:
- **plan:** `anySliceVerified`, `TERMINAL_DESIGN_SYSTEM`, `validateSlicePlan`.
- **claims:** `canonicalClaim`, `diffEntries`, `implementationCoversDrift`, `implementationDigests`, `legacyRelativePath`, `migrationChangedFiles`, `portableRoot`, `readTargetBaseline`, `renderTargetBaseline`, `repoRelative`, `TARGET_DIRTY_SCOPE`, `targetBaselineDrift`, `targetRelative`, `targetRelativePath`.
- **verification:** `assertGatesCoverSliceScenarios`, `assertNoUnresolvedVerification`, `assertPostAnchorEvidence`, `assertSharedPrerequisitesBuilt`, `assertSlicePassed`, `delegatedChangedFilesSatisfiedByChild`, `validateSliceImplementation`.
- **rework:** `planSliceRework`, `REWORK_ROOT`, `reworkAttemptsOf`, `reworkLimitBlocker`, `reworkPathParts`.
- **drift:** `assertNoUnclaimedTargetDrift`, `pendingTargetDriftCandidates`, `settleFact`, `unclaimedTargetDrift`, `unlistedSliceCandidates`.
- **amendment:** `completeSliceAmendment`, `draftSliceAmendment`, `SLICE_AMENDMENT_ROOT`.
- **state:** `assertSliceStateConsistent`, `inspectSliceArtifacts`, `reconcileSliceState`.

`canonicalClaim`, `repoRelative` and `targetRelative` are exported only for the DR4 pin test.

## Dependency inversions

There are three kinds of seam:
- **Fact seams** read census, visual or lifecycle state and pass it to slices as plain data.
- **Text renderers** are pure functions that produce command text. They follow the A2/A3 precedent (`upgradeCommandFor`, `approveCommand`).
- **One pure visual predicate** is injected the same way.

No seam hands slices a function that does I/O, takes a lock, writes or journals.

| Was | Now |
|---|---|
| `validatePlan` read the BUILD_BASELINE matrices (`validateBaseline`, lifecycle), the lifecycle `TERMINAL_PARITY` and the visual `uiBehaviorIsRequired` inside the plan rules. | The seam `validatePlan` (lifecycle file) reads `validateBaseline` first, as before. It then calls `validateSlicePlan(root, state, roots, baseline, { terminalParity, uiBehaviorIsRequired })`. The predicate is pure. |
| `validateImplementedSlice` read the plan, the census `isBrownfield`, and in the middle of its rules ran the lifecycle `assertArtifactPrerequisites`, which lazily loads the artifact engine and reads child status. | The seam reads `validatePlan` and passes `isBrownfield(state)`. It calls `validateSliceImplementation`, which returns the record and the canonical claims. Then, under the same format-11 condition, it runs `assertArtifactPrerequisites` and `assertSharedPrerequisitesBuilt`. The order of checks and errors is unchanged. Precomputing the prerequisites was rejected: `getArtifactStatus` resets the artifact engine's module-global metrics. |
| `unlistedSliceFiles`, `sliceAmendmentFor` called `validateImplementedSlice` (now a seam) and `classifyTargetDrift`. | `unlistedSliceCandidates` returns the record and the in-scope unclaimed paths. The seam keeps the listability loop. `sliceAmendmentFor` is `validatePlan`, then `draftSliceAmendment`, then the implementation revalidation and its refusal, then `completeSliceAmendment`. Each nested revalidation still re-reads the plan, as before. |
| `classifyTargetDrift` read the census `legacySourceBinding` (format 19) and `isBrownfield` (via `readTargetBaseline`), and built its format-19 candidate through the census `moduleDecisionCandidate`. | It takes `{ brownfield, legacySource }`, built by `sliceDriftFacts(state, roots)` in the lifecycle file. Inside `acceptsDrift`, which runs only at format 19, it calls `decisions` `createNewFormatDecisionCandidate({ projectRoot, ...input })`. That is exactly what `moduleDecisionCandidate` returns at format 19. |
| `record-decision.mjs` `derivePendingDecisions` called the lifecycle `pendingTargetDriftCandidates(root, state, roots)`. | It imports `pendingTargetDriftCandidates` from `slices/index.mjs` and passes `await sliceDriftFacts(state, roots)` as the fourth argument. The first three arguments, the facts, the ordering and the error behavior are unchanged. `decisions/` still does not import slices. Candidate identity, grouping and authority stay in `deriveModuleDecisions`. |
| `assertNoUnclaimedTargetDrift`, `validateVerifiedSlice` rendered `engineCommand` (transport) inside the refusal text. | `validateStep` passes `sliceDriftFacts` and `engineCommand`. `validateVerifiedSlice` passes `engineCommand` to `assertSlicePassed`. The bytes are identical. |
| `reworkSliceUnderLock` mixed the rework rules with the journalled transaction. | `planSliceRework` returns `{ writes, reworked, event }`. The seam keeps the integrity render, journal, writes, history append and journal removal, in the same order. `now()` is still called first for the record and then for the state. |
| `validateBaseline` (lifecycle) read the target baseline through the census `isBrownfield`. | It calls `readTargetBaseline(root, isBrownfield(state))`. |

**Settled facts.** The only fact whose read can fail is the legacy binding. The seam reads it eagerly but passes it settled, as `{ value }` or `{ error }` (`settleFact`). Classification raises a failure at the point where it used to read the binding, after the target dirty manifest, baseline, claims and ledger reads. Error precedence is therefore unchanged, and a failure that is never consumed is never an unhandled rejection. The only cost is extra read-only `git` calls on the legacy root, at format 19 when a seam runs and drift is not classified:
- the compat reader before VERIFY_SLICES;
- the IMPLEMENT gate when the slice has no scope;
- an amendment that is blocked before its ownership facts.

**One ordering change, unobservable.** `sliceAmendmentFor` now validates the plan before its three state-only refusals. Before A4 those refusals ran first, but they only push blockers: they cannot throw and they read nothing. When the plan read throws, it throws in both versions.

## Path spellings kept apart (DR4 deferred)

DR4, one canonical claim spelling, is a Track B change. Each variant moved byte-identical and keeps its own rule:

| Variant | Rule (unchanged) |
|---|---|
| `rootRelativePath` (via `targetRelativePath` / `legacyRelativePath`) | Converts `\` to `/`; strips one leading `./`, trailing `/`s and the sibling-root prefix from the common ancestor; resolves against the root and refuses `'<claim>' is outside the <label> repository.`; returns the root-relative path. With no root, it only normalizes the spelling. |
| `targetRelative` | Raw `path.relative(targetRoot, absolute)` with `/` separators. |
| `repoRelative` | Adds `./`, for `git show <rev>:./<path>`. |
| `canonicalClaim` | The first whitespace token. It resolves the token as an existing file directly under the target, or through the evidence bases (legacy, target, common ancestor), and keeps it only inside the target. Otherwise it falls back to the raw token with `\` converted to `/`. |
| `resolveChangedFile`, `plannedTargetOwners`, `preservedEvidencePath`, `resolveAnchoredOwnership` claim set | Each keeps its own normalization (as at BASE). |
| `artifact-migration.mjs` `normalizeRelative` | Stays in `shared/` (A1). |

DR1 containment is unchanged: every moved function keeps the `isWithin` binding its origin file imported (`isResolvedWithin`).

## Guarantees and their one owner

| Guarantee | Public function(s) | Tests |
|---|---|---|
| Every required baseline row and capability belongs to exactly one slice. Dependencies are declared earlier. A SHARED_PREREQUISITE is planned before its consumers. | `validateSlicePlan`, `assertCapabilityPlan` | migration-contract: "one capability may not be claimed by two slices", "a claimed feature with no import of the shared component is refused" |
| A changed-file claim is a real file inside the target, in the live diff or anchored at the reopen. It is not pre-existing baseline work, in any accepted spelling. | `validateSliceImplementation`, `canonicalClaim`, `targetRelativePath` | migration-contract: P1-7 "changed files must exist and stay inside the target repository", "…not actually touched is refused", "pre-existing target work may not be claimed as slice work", "a shared prerequisite is accepted in either accepted path spelling", "a changed file outside the owner is still refused in either spelling", "IMPLEMENT gate: a file a verified slice claims under another spelling is not requested again"; slices.test: both DR4 pin tests |
| A shared prerequisite is built in its declared owner. | `assertSharedPrerequisitesBuilt` | migration-contract: "a FEATURE_LOCAL owner is recognised in either accepted path spelling"; artifact-delegation.test |
| Implementation digests bind UI evidence to the claimed bytes. A claimed file edited after its evidence fails. | `implementationDigests` | visual-evidence and migration-contract UI-binding suites; R2-4 "a claimed file committed after the anchor needs evidence bound to current HEAD" |
| A FAIL never advances. Rework preserves the failed attempt byte-for-byte and pins it before anything is released. Attempts are append-only and limited. | `assertSlicePassed`, `planSliceRework`, `validateFailedSliceResult`, `reworkLimitBlocker` | R-W3-a, R-W3-b, R-W3-e (fourth rework refused), R-W3-g, R-W3-h (mutating or deleting preserved bytes refused) |
| A reworked slice is reverified after its newest rework. No unsuperseded FAIL reaches FINALIZE. | `assertNoUnresolvedVerification` | R-W5-a (both cases), "R-W5-b / R-W3-f" |
| Reopen provenance is tamper-evident. The anchor is unique and reachable, and post-anchor commits need evidence bound to HEAD. | `verifiedReopenRecord`, `resolveReopenAnchor`, `resolveAnchoredOwnership`, `assertPostAnchorEvidence` | R2-1 to R2-5, R1-2 |
| Every modified target byte is claimed, reworked, delegated or accepted, or else FINALIZE refuses by name. Unrelated edits outside the plan's subtrees are reported, never attributed. | `classifyTargetDrift`, `assertNoUnclaimedTargetDrift` | R-W4-a, R-W4-b, R-W4-c, R-W4-e, R-W4-f; "v1.3.17 `<path> <identity>` entry…" |
| F6: the drift facts offered are the facts FINALIZE resolves. AUTO is offered exactly what its gate accepts. The seam and the compat reader agree. | `driftCandidateFacts`, `pendingTargetDriftCandidates` | F6-a, F6-b, F6-c; decisions.test "post-census facts offer only what the writer accepts…"; migration-contract "A4: the decisions seam and the three-argument reader offer the same drift facts…" |
| An amendment is add-only. It is refused for a slice that is not reopened, for engine, outside, workspace or record-authored files, and for an invalid result. The preserved record is append-only. | `draftSliceAmendment`, `completeSliceAmendment` | "amend: one amendment preserves the prior record…", "amend: refuses a slice that is not reopened…", "amend: a transition killed mid-write…" |
| Resume never auto-repairs. Reconciliation reports the repairs it would make. | `reconcileSliceState`, `assertSliceStateConsistent` | "reconcileSliceState never fast-forwards a newly activated slice…"; format-upgrades (upgrade reconciliation) |

**Adversarial coverage.** The table maps each required case to its tests; "new" marks a test this track adds.

| # | Case | Tests |
|---|---|---|
| 1 | Claim-path spellings | "…either accepted path spelling" (×2), "…outside the owner is still refused in either spelling", IMPLEMENT-gate spelling tests; **new:** slices.test "the root-relative claim spelling keeps its rules…", "the changed-file claim spelling resolves real files only…" |
| 2 | Relative paths and root containment | P1-7 "changed files must exist and stay inside the target repository"; **new:** the two pin tests (`../`, absolute and sibling inputs) |
| 3 | Shared, config and test files outside `targetPaths` (P3 as designed) | "a shared prerequisite is accepted…"; amend tests (`OUTSIDE_PLANNED_SCOPE`, `TEST_OF_OWNED_SOURCE` ownership basis) |
| 4 | A claimed file modified after its evidence | R2-4; R-W4-e (accepted path edited after acceptance re-blocks) |
| 5 | Rework of a claimed file | R-W4-b; "v1.3.17 … reworking that file is not drift" |
| 6 | Earlier failed attempts preserved | R-W3-a, R-W3-g, R-W3-h |
| 7 | Rework attempt limit | R-W3-e |
| 8 | Stale or modified slice evidence | "R-W5-b / R-W3-f"; P1-7 falsified output digest and missing output file |
| 9 | Previously pinned evidence | R2-5, R1-2, R2-3 |
| 10 | Unclaimed target drift | R-W4-a, R-W4-f, "IMPLEMENT gate: a path no changedFiles entry can spell…" |
| 11 | Drift candidate identity and F6 parity | F6-a/b/c; **new:** "A4: the decisions seam and the three-argument reader offer the same drift facts; a failed census read refuses only where drift is classified"; **new:** slices.test "a settled census fact keeps its value…" |
| 12 | Slice state reconciliation and repair | "reconcileSliceState never fast-forwards…"; format-upgrades |

Architecture checks:
- `slices.test.mjs`:
  - **A4-ARCH-1:** one public entry, which only re-exports.
  - **A4-ARCH-2:** engine code imports slices names only through `slices/index.mjs`. `upgrades/upgrade-migration.mjs` was rerouted to it.
  - **A4-ARCH-3:** `slices/` files import each other acyclically.
  - **A4-ARCH-4:** one live definition per slices declaration, and none of the 66 moved declarations survives at its old site.
  - **A4-ARCH-5:** the BASE compatibility exports of `core.mjs` and `resumable-migration.mjs` are the slices (or store) binding itself. `pendingTargetDriftCandidates` keeps arity 3 there.
- `store-shared.test.mjs`: A1-ARCH-1 and A1-ARCH-2 now cover `slices/`. Its allowed imports are the decisions, store, formats and shared entries, statically and dynamically. Lower modules still may not import it.

## Compatibility

These modules keep every export name, arity and value they had at BASE: `core.mjs`, `resumable-migration.mjs`, `record-decision.mjs`, `artifact/artifact-migration.mjs` and `upgrades/upgrade-migration.mjs`.
- Moved names are thin re-exports of the slices binding, or of the store binding for `REOPEN_ROOT`.
- `resumable-migration.mjs` `pendingTargetDriftCandidates` keeps its three-argument form as `pendingTargetDriftCandidatesCompat`, a one-line wrapper that reads the census facts.
- One name became public: `resumable-migration.mjs` `sliceDriftFacts`, the census-fact reader that `record-decision.mjs` hands to slices.
- `store/index.mjs` adds the re-homed evidence functions and `REOPEN_ROOT`.

No format version, schema, CLI argument, persisted record, digest, pin, candidate fact or refusal text changed. A1, A2 and A3 guarantees are untouched: decisions imports nothing new.

## Not moved, with the reason and owning phase

| Declarations | Reason | Phase |
|---|---|---|
| `resumable-migration.mjs` `validatePlan`, `validateImplementedSlice`, `unlistedSliceFiles`, `sliceAmendmentFor` | Orchestration seams. Their rules moved (`validateSlicePlan`, `validateSliceImplementation` + `assertSharedPrerequisitesBuilt`, `unlistedSliceCandidates`, `draftSliceAmendment` + `completeSliceAmendment`). What stays reads lifecycle `validateBaseline`, census `isBrownfield`, and the lifecycle `assertArtifactPrerequisites` (artifact engine). | A5 (census facts), A8 (lifecycle) |
| `resumable-migration.mjs` `validateVerifiedSlice` | Orchestration over visual (`validateUiRuntimeEvidence`, `visualAuthorityOf`, the design-system gap), lifecycle (`validateBaseline`) and transport (`engineCommand`). Its slice rules are `assertSlicePassed`, `assertCommandResults` (store) and `assertPostAnchorEvidence`. | A6, A8 |
| `resumable-migration.mjs` `reworkSliceUnderLock`, `amendSliceUnderLock`, `repairSliceState` | Lock, journal and transaction owners: `withModuleLock`, `writeJournalAtomic`, `ADVANCE_JOURNAL`, `renderIntegrityNow`, `appendHistoryOnce`, `activeArtifact`, and the store pins functions (`hashPinnedArtifact`, `pinnedArtifactMatches`, `readState`) that A1 left blocked. The rework rules moved (`planSliceRework`). The amendment rules are `sliceAmendmentFor`'s halves. Repair applies `reconcileSliceState`. | A8 |
| `artifact-migration.mjs` `assertMayExecute`, `execute`, `executeTypeScriptValidation`, `executeNodeCheckValidation`, `executeValidator`, `executeGenericCheck`, `hasCodeValidationCheck`, `packageScriptOf`, `PACKAGE_MANAGERS`, `SCRIPT_NAME`, `JS_FILE_EXTENSIONS`, `pathKey` | Command execution, which stays outside slices. They also read lifecycle `engineFault`/`asEngineFault` and census `metrics`, `commandFile`, `targetTypeScript` and `CODE_FILE_EXTENSIONS`. `pathKey` is also called by census `legacyDependencies`. | A5 / A8 |
| `artifact-migration.mjs` `targetManifest`, `MANIFEST_DEPENDENCY_FIELDS`, `assertTargetProvides` | `targetManifest` reads lifecycle `asEngineFault`. `assertTargetProvides` is called by census `validateExternalRequirements`, so moving it would add a census→slices edge. | A5 |
| `artifact-migration.mjs` `validatePlan`, `validateImplementation`, `validateBoundTo`, `validateVerification`, `RESOLUTION_KIND` | Artifact checkpoint validators. They read lifecycle `validateBaseline`, census `hasExecutableCodeFiles`, `isExcluded`, `validateEvidenceFile` and `UI_RUNTIME_STATES`, visual `artifactVisualAuthority` and `validateArtifactVisualEvidence`, and artifact-engine leaf helpers (`versionOne`) not yet in `shared/`. `RESOLUTION_KIND` is read only by `validatePlan`. | A5, A6 |

Not taken from the owners-b map: `cli/run-migration.mjs` `UNCLAIMED_TARGET_DRIFT` (a transport regex over refusal text) stays with the transport.

## Remaining dependency violations

- **slices/ outgoing:** none. It has no edge to census, visual, lifecycle or transport, statically or dynamically.
- **Into slices from above:** the lifecycle seams listed above, and `record-decision.mjs`. All of them point downward.
- **Into slices from below.** These are still in the monolith. They become violations when their owners are extracted:
  - visual→slices: `validateUiRuntimeEvidence` → `implementationDigests`, and `assertNoNavigationRepairNeeded` → `inspectSliceArtifacts`. A6 must receive both as facts.
  - store→slices: `isBytePinned` and `validateCompletedHashes` → `reworkPathParts`. These are store-owned and A1-blocked. When the pins cluster moves to store, the rework path layout must be supplied, or moved to formats as record-layout vocabulary.
- **Deferred behavior changes, untouched:**
  - DR4: one claim spelling.
  - I8: `traceLists` `capabilityIds`.
  - P4: a PLAN check for UI interactions that cross slices.
  - I7: the shared step-document timing, still `assertStepDocumentComplete` in lifecycle.
  - P3: `withinPlannedScope` and shared, config or test edits outside `targetPaths`, as designed.
