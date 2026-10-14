# Track A6 ownership record: `visual/`

BASE `7b48165`. Plan: `docs/phase0-architecture-baseline.md` §2, §4 option (b) (`slices > visual > census > decisions > store > formats > shared`), §8 A6, Appendix C (visual rows). The visual rows of `owners-b.tsv` were reconciled against BASE:
- All 133 rows were still in their Phase 0 files: 73 in `visual-evidence.mjs`, 55 in `resumable-migration.mjs` and 5 in `artifact/artifact-migration.mjs`.
- `visual-evidence.mjs`'s `sha256` row (unassigned leaf) had already become `shared` `sha256Hex` in A1.
- `assertRequiredObservations` was already reached by census through the A5 injected seam, and `uiBehaviorIsRequired` by slices through the A4 seam.

**Scope.** A6 is a partial extraction of the owners-b visual rows, by design:
- 128 of the 133 rows now live in `visual/`. That is all 73 `visual-evidence.mjs` rows, 51 of the 55 lifecycle rows and 4 of the 5 artifact rows.
- One artifact row is split: `artifactVisualAcceptance`. Its acceptance rule moved to `visual/` as `validateArtifactVisualAcceptance`, and the read of its decision rows stays in the artifact engine.
- The other 4 lifecycle rows stay in orchestration seams. All of them are listed under "Remaining seams" below.
- No declaration from another owner was re-homed into `visual/`.

**Method.** The extraction preserves behavior.
- The primitives moved as a whole file: `git mv visual-evidence.mjs visual/evidence.mjs`. Its diff is the shared import specifier and the dependency resolution base (below).
- An AST mover cut 55 declarations verbatim, leading comments included: 51 from `resumable-migration.mjs` and 4 from `artifact-migration.mjs`. No BASE comment line was lost (checked by multiset comparison), and 54 of the 55 declarations are byte-identical to BASE apart from an added `export`.
- The only body changes are the ones the seams required:
  - `validateUiRuntimeEvidence` takes the slices `implementationDigests` reader as one more named argument. Its call site, line for line, is unchanged.
  - `export` was added where a sibling or the entry needs the name.
- Evidence that the extraction preserves behavior:
  - **Types:** `tsc --checkJs --noUnusedLocals` diagnostics equal BASE's once file paths are ignored. The only additions are nine "cannot find module `node:…`" lines, one per `node:` import in a new file; the analysis runs without `@types/node`.
  - **Exports:** all 61 BASE engine files outside `cli/` export the same names, function arities and values. Path values differ only because the BASE copy lives elsewhere. `cli/*` exports no visual name.
  - **Golden:** `pnpm rehearse` matches the 20-step golden trace.
  - **Negatives:** `pnpm rehearse:negative` refuses all four corruptions.

## Files

| File | Holds |
|---|---|
| `visual/index.mjs` | The one public entry. It only re-exports: every name the `visual-evidence.mjs` facade re-exports, plus every visual name something outside `visual/` uses. |
| `visual/evidence.mjs` | The hardened v2 primitives, unchanged (formerly `visual-evidence.mjs`): PNG decode (`decodePng`), box resampling (`resampleTo`), alpha matte and antialiasing-excluded pixel deltas (`perceptualDelta`), the control multiset (`structuralDelta`), `HARDENED_VISUAL_VERSION = 2`, `FIXED_VISUAL_TOLERANCE = {px: 1, ratio: 0}`, the `REQUIRED_FACTS` taxonomy, `normalizeVisualValue`, `strokeFromComputedStyle`, the Figma provenance resolvers, `assertProvenancePrecedence`, `variableValueSet`, structured node capture, digests, facts, assets, literals, authority derivation, contract validation, target comparison, the capability profile and `assertStructuredCaptureScale`. |
| `visual/authority.mjs` | Authority selection and context validation: `VISUAL_AUTHORITIES` (`figma-mcp`, `legacy-runtime`), `visualAuthorityOf`, `usesVisualContract`, `AUTHORITY_CONTEXT_FILES`, `pinsAuthorityContext`, the evidence roots (`LEGACY_RUNTIME_EVIDENCE_ROOT`, `TARGET_EVIDENCE_ROOT`), the capture roles (`LEGACY_AUTHORITY_ROLE`, `TARGET_VERIFICATION_ROLE`, `assertCaptureRole`), `assertTargetEvidencePath`, `hardenedVisual`, `frameKeyOf`, the design-source pin (`designSourceExplicit`, `figmaSourceKey`, `designSourceConflict`, `assertDesignSourceUnchanged`), the Figma node identity (`FIGMA_NODE_ID`, `FIGMA_SOURCE_KINDS`, `figmaNodeKey`, `figmaMetadataAncestry`), `validateFigmaContext` with `resolveStructuredFigmaFrame` and `resolveFigmaFacts`, `validateLegacyRuntimeContext`, and `assertVisualCaptureBlock`. |
| `visual/observations.mjs` | The format-18 UI observation contract: `OBSERVATION_EXPECTED`, `OBSERVATION_FIELDS`, `assertRequiredObservations`, and the requiredness predicate `uiBehaviorIsRequired` with `UI_UNREQUIRED_DISPOSITIONS`. |
| `visual/acceptance.mjs` | Format-17 acceptance and comparison: `validateVisualAcceptance`, `compareVisualFact`, `assertVisualAcceptance`, `compareVisualEvidence`, the bounds `MAX_TOLERANCE_PX`/`MAX_TOLERANCE_RATIO` and `PROVISIONAL_VISUAL_DIFF_THRESHOLDS`, and the VISUAL_UNBACKED facts: `VISUAL_UNBACKED_KIND`, `visualContractDigest`, `visualUnbackedCandidate`, `backedRowFor`, `pendingVisualUnbackedCandidates`. |
| `visual/proof.mjs` | Playwright runtime evidence and UI proof eligibility: `validateUiRuntimeEvidence`, the viewport and credential rules (`UI_VIEWPORT_STATES`, `UI_SECRET_*`, `assertNoUiSecret`), the `playwright-ui-proof/v1` classifiers `sliceLacksUiProofV1` and `completedSlicesLackingUiProofV1`, and `--reopen-ui` eligibility (`reopenUiEligible`, `reopenUiIneligible`). |
| `visual/artifact.mjs` | The artifact engine's visual rules: `strictVisualState`, `artifactVisualAuthority`, `artifactUiInventory`, `validateArtifactVisualAcceptance` (new, split) and `validateArtifactVisualEvidence`. |

Inside `visual/`, the files import each other acyclically: `evidence` ← `authority` ← `acceptance` ← `proof`, `observations` ← `acceptance`, `proof`, and `artifact` ← `evidence`, `authority`, `acceptance`. `visual/` imports only `census/index.mjs` (`UI_RUNTIME_STATES`), `decisions/index.mjs`, `store/index.mjs`, `formats/index.mjs`, `shared/index.mjs` and `node:` builtins. It has no dynamic import, runs nothing at import and writes nothing. No module below it imports it.

## Public API

`visual/index.mjs` exports 68 names: the 36 primitives listed for the facade below, plus these 32:
- **Authority:** `VISUAL_AUTHORITIES`, `visualAuthorityOf`, `usesVisualContract`, `pinsAuthorityContext`, `LEGACY_AUTHORITY_ROLE`, `TARGET_VERIFICATION_ROLE`, `LEGACY_RUNTIME_EVIDENCE_ROOT`, `designSourceExplicit`, `designSourceConflict`, `assertDesignSourceUnchanged`, `FIGMA_SOURCE_KINDS`, `figmaMetadataAncestry`, `validateFigmaContext`, `validateLegacyRuntimeContext`.
- **Observations:** `assertRequiredObservations`, `uiBehaviorIsRequired`.
- **Acceptance:** `validateVisualAcceptance`, `compareVisualFact`, `compareVisualEvidence`, `PROVISIONAL_VISUAL_DIFF_THRESHOLDS`, `VISUAL_UNBACKED_KIND`, `pendingVisualUnbackedCandidates`.
- **Proof:** `validateUiRuntimeEvidence`, `sliceLacksUiProofV1`, `completedSlicesLackingUiProofV1`, `reopenUiEligible`, `reopenUiIneligible`.
- **Artifact:** `strictVisualState`, `artifactVisualAuthority`, `artifactUiInventory`, `validateArtifactVisualAcceptance`, `validateArtifactVisualEvidence`.

## Visual authority rules (unchanged)

- **Selection.** The authority is the persisted record's `designSource`, and only from the design-source format (14): `figma-mcp` → `FIGMA_CONTEXT_FILE`, `legacy-runtime` → `LEGACY_RUNTIME_CONTEXT_FILE`, `target-system` → none. No third authority exists.
- **Pinning.** `pinsAuthorityContext` lets a record pin only its own authority context. A figma record is never held to the legacy context, and the reverse. `target-system` pins neither.
- **Design-source pin.** The design source and its Figma links are bootstrap-fixed. A resume that names another source is refused (`assertDesignSourceUnchanged`).
- **No substitution (P4).** An authority source never resolves under `evidence/`. A TARGET reference, screenshot or measurement never resolves under `inventories/legacy-runtime/` (`VISUAL_AUTHORITY_SUBSTITUTION`).
- **Capture roles (P5).** An authority frame declares `LEGACY_AUTHORITY`. A TARGET row that declares a role must declare `TARGET_VERIFICATION` (`VISUAL_CAPTURE_ROLE`). No rule requires authority and target images to differ: byte-identical captures at disjoint paths pass.
- **Binding.** TARGET evidence binds the target implementation digest and the authority's context digest under the adapter's field (`figmaContextDigest` / `visualContextDigest`). Legacy evidence never binds the target implementation.
- **Hardened contract.** v2 requires the full fact taxonomy, provenance resolved from re-hashed persisted MCP output or pinned measurements, and the fixed ±1px tolerance (an authored tolerance is refused). v1 stays readable only where it was already pinned.
- **Verdict.** The engine, never the authored `result`, decides a visual PASS: fact comparison, `perceptualDelta` against `PROVISIONAL_VISUAL_DIFF_THRESHOLDS`, and the accessibility control multiset. Missing measurements or controls fail; they never pass.

## Evidence and provenance contracts (unchanged)

- Verbatim structured-node source bytes and their digests, captured node identity, and metadata ancestry derived from the element nesting of the persisted `get_metadata` output.
- Variable and asset provenance, and precedence that refuses a downgrade to a weaker kind. Unsupported or unresolved properties are `NOT_PROVABLE`, never facts.
- Freshness: persisted Figma or legacy capture bytes that changed after they were hashed are stale. FINALIZE re-reads every pinned byte instead of trusting a recorded comparison.
- Runtime proof: `playwright-ui-proof/v1` structured observations. The engine evaluates the predicates for every required state, interaction and post-action observation, with a one-capture-per-state screenshot budget and credential refusal.

## Dependency inversions

No seam hands visual a function that writes, takes a lock, journals or runs a command. The one injected function is a read-only digest reader.

| Was | Now |
|---|---|
| `validateUiRuntimeEvidence` imported the slices `implementationDigests` (a visual→slices edge in Phase 0). | Visual receives it as the named argument `implementationDigests`. The lifecycle seam `validateVerifiedSlice` passes the slices binding. It is still called once, after the limitations are validated and before the first record, so error precedence is unchanged (new test). |
| The artifact engine's `artifactVisualAcceptance` interleaved the decision-row read (`artifactVisualDecisions`: ledger, BUILD_BASELINE history) with the visual acceptance rule. | Visual `validateArtifactVisualAcceptance(root, state, source, decisions)` holds the rule. The seam reads the rows first, exactly as BASE did, then calls it. Under the format-14 direct ledger an unbacked state passes only when its row projects `APPROVED_APPLICABLE`. |
| `record-decision.mjs` read `pendingVisualUnbackedCandidates` from the lifecycle file. | It imports the same binding from `visual/index.mjs`. The A3 offer/write facts and their order are unchanged. |
| A5: census `validateLegacyInventory` receives the observation rule. | Unchanged. The lifecycle seam passes the visual `assertRequiredObservations` binding at the same point (census.test A5 seam test). |
| A4: slices `validatePlan` receives `uiBehaviorIsRequired`. | Unchanged. The lifecycle seam passes the visual binding. |

## Visual and decisions

Visual derives the unbacked facts and builds the VISUAL_UNBACKED candidate with the decisions builder, exactly as at BASE:
- `createDecisionCandidate` and `createNewFormatDecisionCandidate` are the A3 identity and digest code. Visual has no copy of them.
- Authority is resolved through `requireModuleDecision` (format-19 direct ledger) or `readRecordedDecisions` (the legacy ledger). Both are unchanged.

Nothing in `visual/` records, approves or rejects (A6-ARCH-7):
- **Approval path.** F6 approval and rejection, relay, AUTO versus human, stale-decision refusal and atomic groups all stay in `decisions/` and `record-decision.mjs`.
- **Artifact format 14.** The direct-ledger authority stays in the artifact seam (`artifactVisualDecisions`, `artifactVisualDecisionRows`).

## Compatibility facades and lazy loading

- **`visual-evidence.mjs`** stays the primitives' public path. It is a facade that re-exports exactly its 36 BASE names from `visual/index.mjs`, as the same bindings. Engine code imports `visual/index.mjs` instead; the facade is for tests and external callers (A6-ARCH-2).
- **Dependency resolution.** `visual/evidence.mjs` builds its `require` with `createRequire(new URL("../visual-evidence.mjs", import.meta.url))`. pngjs and pixelmatch therefore resolve from the same base as at BASE, in a checkout and in an installed toolkit, and a missing package names the same require stack.
- **Lazy.** No module loads either package at import. That holds for `visual/` and for every engine module that re-exports it: `core.mjs`, `resumable-migration.mjs`, `artifact-migration.mjs`, `record-decision.mjs` and `mcp-server.mjs`. The first decode loads pngjs and the first diff loads pixelmatch. `VISUAL_PNG_INVALID` is unchanged. A6-ARCH-6 checks this in a fresh process.
- **Scanner.** The A5 parser resolution (`SCANNER_URL`) is untouched. `visual/` imports census only for the `UI_RUNTIME_STATES` vocabulary.
- **Compatibility exports.** `resumable-migration.mjs` keeps its 16 BASE visual exports, and they are now the visual bindings. These modules keep every export name, arity and value they had at BASE: `core.mjs`, `artifact-migration.mjs`, `record-decision.mjs`, `mcp-server.mjs` and `cli/*`. No CLI argument, refusal message, record byte, digest input, evidence path, threshold or format version changed.

## Remaining seams (not moved)

| Row(s) | Stays in | Why |
|---|---|---|
| `reopenUiUnderLock` | `resumable-migration.mjs` | It holds the module lock and journals (`writeJournalAtomic`, `ADVANCE_JOURNAL`, `appendHistoryOnce`, `atomicWrite`, `rm`). This is lifecycle orchestration until A8. Its visual rules are called from visual: eligibility (`reopenUiEligible`/`reopenUiIneligible`) and the completed-slice proof sweep (`completedSlicesLackingUiProofV1`). Three checks remain inline, interleaved with lifecycle reads of the slice plan, the journal and the active slice's evidence: the pending reverification check, the ACTIVE completed-only check and the omitted lacking-slice check. |
| `reopenUiNotApplicable` | `resumable-migration.mjs` | It reads the legacy inventory through the A5 lifecycle seam `validateLegacyInventory`, which composes the census rules with visual's observation rule. Moving it would mean a second composition of that seam in visual. `previewMigrationExecution` and `reopenUiUnderLock` call it. |
| `withUiProofReopenHint` | `resumable-migration.mjs` | It wraps the lifecycle seam `validateVerifiedSlice` and decorates its error. The two classifiers it calls moved. |
| `assertNoNavigationRepairNeeded` | `resumable-migration.mjs` | Owners-b files it as visual, but it is a FINALIZE precondition over slice navigation: it reads `inspectSliceArtifacts` and `completedSlices`, and nothing in it is visual. It goes to slices or lifecycle in A8. It is not moved into visual with the slice facts injected. |
| `artifactVisualAcceptance` (seam), `artifactVisualDecisions` | `artifact/artifact-migration.mjs` | They read the artifact ledger and BUILD_BASELINE history (`consumedAtCheckpoint`, A3 seam). |
| `visualContractAdoptionPlan`, `adoptVisualContractUnderLock`, `uiObservationsAdoptionPlan` | `resumable-migration.mjs` | They are owners-b lifecycle rows: format-upgrade orchestration that calls the visual validators. |

## Guarantees and their tests

The table maps each required adversarial case to its tests. Tests are in existing suites unless marked new.

| # | Case | Tests |
|---|---|---|
| 1 | Target evidence used as source authority | migration-contract "legacy-17: the engine, not the authored result, decides a legacy-backed state" (`VISUAL_AUTHORITY_SUBSTITUTION`), "legacy-17: ASSESS_TARGET refuses an absent, mis-bound or substituted authority"; visual-authority-proof "P4 authority source under evidence/" |
| 2 | Wrong capture role | migration-contract "legacy-17: the engine, not the authored result…" (`VISUAL_CAPTURE_ROLE`); visual-authority-proof "P5 capture.role substitution"; legacy-runtime-authority "every authority defect is refused fail-closed" |
| 3 | Changed authority-context bytes | visual-authority-proof "mutating the pinned authority", "stale authority digest"; migration-contract "visual-17: persisted Figma evidence that changed after it was hashed is stale" |
| 4 | Changed target screenshot or measurements | visual-authority-proof "FINALIZE trusting a recorded comparison"; artifact-migration "structured Figma authority: artifact lifecycle compares child facts, pins evidence and refuses injections" |
| 5 | Missing screenshot or accessibility snapshot | migration-contract "UI-25…", "UI-26: FINALIZE refuses a verified slice whose UI artifact is gone"; artifact-migration "legacy-runtime parity: migrate-artifact pins the same authority…" |
| 6 | Incorrect viewport | migration-contract "visual-17: runtime evidence for the wrong node or viewport is refused", "UI-19…", "visual-17: synthetic narrow-viewport regression…" |
| 7 | Missing UI state or post-action observation | migration-contract "UI-4…", "UI-13…", "UIP-state-binding…", "UI-15: an unavailable runtime is explicit and never becomes a PASS" |
| 8 | Tampered Figma metadata or node identity | migration-contract "visual-17: a frame whose node is not a recorded Figma link is refused", "visual-17: a provenance-only stub or incomplete Figma evidence is refused"; visual-authority-proof "Figma provenance resolving to the wrong node" |
| 9 | Unresolved structured Figma properties | visual-evidence "an unsupported stroke or effect shape is NOT_PROVABLE…", "unsupported structured fill cannot be replaced by a weaker design-context literal", "a node that returned no strokes/effects key proves neither…" |
| 10 | Missing required visual facts | visual-evidence "taxonomy: …"; legacy-runtime-authority "v2: a full taxonomy verifies; anything less does not"; visual-authority-proof "missing taxonomy group (color)" |
| 11 | Raster alpha and antialiasing | visual-evidence "Slice C: PNG decode, 2x box filter, alpha matte, and pixel deltas", "Slice C: antialiasing-only edge pixels are excluded" |
| 12 | Accessibility control count differences | visual-evidence "Slice C: control multiset reports missing, extra, and multiplicity"; visual-authority-proof "unauthorized extra control"; migration-contract "Slice C: structural extras require a terminal target-native row" |
| 13 | Stale implementation-bound evidence | migration-contract "UI-9: changing an owning slice file narrowly stales its UI evidence", "UI-16…"; **new:** visual.test "UI runtime evidence reads the injected implementation digests once…" |
| 14 | Legacy-runtime and Figma authority isolation | migration-contract "legacy-17: the three design sources keep disjoint pins and one state shape"; visual-authority-proof design-source switch refusal; **new:** visual.test "each design source pins only its own authority context…" |
| 15 | Visual unbacked decisions and F6 parity | migration-contract "unbacked-17: …" (3 tests), "adopt-17: an operator-approved unbacked state goes stale…", F6-a/b/c; artifact-migration "pilot 14 derives a policy-bound visual candidate…", "pilot 14 visual projections re-read the ledger…"; record-decision legacy-line tests |
| 16 | Module/artifact visual compatibility | artifact-migration "legacy-runtime parity: migrate-artifact pins the same authority and takes the same visual path", "R-W7-d: the artifact front ends carry no second copy of a shared rule"; visual-evidence "the shared engine semantics are one function for both domains"; **new:** A6-ARCH-4/5 |
| 17 | Incorrect visual reopening eligibility | migration-contract "UI-10b…", "UIP-P2/P3/P4…", the "must include every completed slice lacking…" test; **new:** visual.test "--reopen-ui is eligible only for COMPLETE, or ACTIVE at VERIFY_SLICES or FINALIZE" |
| 18 | Lazy dependency loading | **new:** A6-ARCH-6 |

Architecture checks:
- `visual.test.mjs` (new):
  - **A6-ARCH-1:** one public entry, which only re-exports.
  - **A6-ARCH-2:** engine code takes visual names only through `visual/index.mjs`, and no engine file imports the `visual-evidence.mjs` facade.
  - **A6-ARCH-3:** no upward or dynamic import from `visual/`, an acyclic inside, and no lower module that names `visual/`.
  - **A6-ARCH-4:** one live definition per visual declaration. None of the 55 moved names survives at its old site, and the facade declares nothing.
  - **A6-ARCH-5:** the BASE compatibility exports are the visual bindings, and the facade's export list is exact. The tolerance, the authority table and the hardened version keep their values.
  - **A6-ARCH-6:** lazy pngjs and pixelmatch, from the facade's resolution base.
  - **A6-ARCH-7:** visual imports from decisions only builders, readers and `requireModuleDecision`, imports no filesystem or store write, and exports nothing that approves or records.
- `store-shared.test.mjs`: A1-ARCH-1 and A1-ARCH-2 now cover `visual/`. Its allowed imports are the census, decisions, store, formats and shared entries. The A1-ARCH-3 old-site rule follows the primitives to `visual/evidence.mjs`.
- `formats.test.mjs`: the canonical `FIGMA_NODE_ID` (DR25) is a same-name, different-rule entry for `visual/authority.mjs` now, not `resumable-migration.mjs`.

## Deferred (Track B), behavior preserved as-is

- **Q6.** There is no abandon/reinit.
- **I5.** The VISUAL_UNBACKED rationale still says "Figma evidence" for legacy-runtime records (`visualUnbackedCandidate`).
- **I4.** The BUILD_BASELINE step text still asks for an explicit `tolerance`, which the v2 validator refuses.
- **F5 / P1.** `PROVISIONAL_VISUAL_DIFF_THRESHOLDS`, the fixed ±1px tolerance and the identical-multiset rule are unchanged. These decisions stay closed.

## Design-source immutability (DR18)

DR18 (Track B) gives design-source immutability one rule: visual `designSourceConflict`. It applies when a resume explicitly names a design source (`designSourceExplicit`), to the `resolveDesignSource` result of that invocation.

- The design source must equal the recorded one. A record with no `designSource` is `target-system`.
- The Figma sources must name the same identities. One identity is a link's `kind`, `fileKey` and `nodeId`. They are compared as a sorted list of JSON-encoded triples. Link order and the rendered `raw` link never matter, and no field value can forge a separator. Equivalent spellings of one link, and repeats of it, normalize to one identity before the comparison. A changed kind, file key (a branch link included), node id, a dropped or added source, or another design source is a conflict. A pinned list that is not canonical (a repeated identity) fails closed.
- The module refuses through `assertDesignSourceUnchanged`, with its two messages. The artifact record's `assertInvocationMatches` refuses with its established `Invocation design source conflicts with persisted state.` Both paths run the rule in their read path (preview, status) and their mutation path (bootstrap, run). A plain resume never reaches it.
- Nothing is rewritten. The recorded `figmaSources` keep their bytes and their order.

**Behavior changes.** Each one is covered by a DR18 test.
- An artifact resume that names the recorded links in another order is accepted, as the module's already was. Before DR18 the artifact compared the canonical JSON of the full lists, so it refused a reordered list.
- The module no longer accepts a record whose one `fileKey` spells two identities in the old `kind#fileKey#nodeId,` key syntax.

## Remaining architectural violations

- `reopenUiUnderLock`, `reopenUiNotApplicable`, `withUiProofReopenHint` and `assertNoNavigationRepairNeeded`: owners-b visual rows still in the lifecycle file (above).
- `artifactVisualAcceptance` and `artifactVisualDecisions`: artifact seams that still mix decision reads with a visual call.
- `validateUiRuntimeEvidence` still depends on a slices reader, now as an injected argument instead of an import. The only effect on slices is unchanged A4 data.
- Visual reads persisted evidence (`readFile`, `readJson`, `hashFile`, `secureHash`) directly, as at BASE. It writes nothing.
- `slices/` and `census/` still receive the visual rules `uiBehaviorIsRequired` and `assertRequiredObservations` through lifecycle seams. Slices may import `visual/index.mjs` directly under (b). A6 does not switch it.
