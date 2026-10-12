# Track A5 ownership record: `census/`

BASE `847ee1c`. Plan: `docs/phase0-architecture-baseline.md` §2, §4 option (b), §8 A5, Appendix C (census rows). The census rows of `owners-b.tsv` were reconciled against BASE:
- All 121 rows were still in their Phase 0 files: 41 in `discovery-scan.mjs`, 37 in `resumable-migration.mjs` (35 plus the two option (b) candidate builders `moduleDecisionCandidate` and `moduleEdgeTargetsFrom`), 1 in `migration-utils.mjs` and 42 in `artifact/artifact-migration.mjs`.
- One of them, the scanner's `execFileAsync`, had already moved to `shared/` in A1.

**Scope.** A5 is a partial extraction of the owners-b census rows, by design:
- 107 of the 121 rows now live in `census/`, plus `execFileAsync`, which A1 had already moved.
- Two artifact rows are split. The census rules are in `census/`, and the read of a higher layer stays in the artifact engine.
- Five owners-b lifecycle rows are re-homed to census, because census is their only caller: `assertEvidenceChecklist`, `assertOpenSpecIds` and `EVIDENCE_CATEGORIES`/`EVIDENCE_KINDS`/`EVIDENCE_STATUSES`.
- One leaf row, `versionOne`, is re-homed to `shared/`.
- The other 11 rows stay in orchestration seams. All of them are listed under "Remaining seams" below.

**Method.** The extraction preserves behavior.
- The scanner moved as a whole file: `git mv discovery-scan.mjs census/scan.mjs`. Its diff is the two import specifiers and the parser resolution base (below).
- An AST mover cut 72 declarations verbatim, leading comments included. 68 are byte-identical at their new site, checked by text comparison against BASE.
- The other 4 changed only in the ways the split required:
  - in three of them (`readCanonicalModuleBoundary`, `assertDiscoveryUnchanged`, `validateDiscoveryCompleteness`), the lazy `import("./discovery-scan.mjs")` became `import("./scan.mjs")`;
  - `validateLegacyInventory` takes the visual observation rule as a fourth argument.
- Evidence that the extraction preserves behavior:
  - **Types:** `tsc --checkJs --noUnusedLocals` diagnostics equal BASE's once file paths are ignored. The only additions are six "cannot find module `node:…`" lines, one for each new file that imports a `node:` builtin; the analysis runs without `@types/node`.
  - **Exports:** all 60 BASE engine files export the same names, function arities and values. The only addition is `shared` `versionOne`. Path values differ only because the BASE copy lives elsewhere.
  - **Golden:** `pnpm rehearse` matches the 20-step golden trace.
  - **Negatives:** `pnpm rehearse:negative` refuses all four corruptions.

## Files

| File | Holds |
|---|---|
| `census/index.mjs` | The one public entry. It exports only names that something outside `census/` uses, including every name the scanner's facade re-exports. |
| `census/scan.mjs` | The deterministic discovery scanner, unchanged: A. the `git ls-files --cached --others --exclude-standard` census under the declared roots; B. the TypeScript module-resolution graph, which annotates reachability and SUPPORTING files; C. repository-wide inbound-consumer discovery. Also the Next.js and framework conventions, aliases, barrels, re-exports, dynamic-import findings, `structuralUnits`, `discoveryDigest`, `CENSUS_ALGORITHM_VERSION = 3`, `SUPPORTED_ALGORITHM_VERSIONS = {1, 2, 3}`, `DiscoveryScannerVersionError`, and the lazy pinned parser (`loadTypeScript`, `parserResolutionError`). |
| `census/sources.mjs` | Canonical legacy sources and their binding: `legacySourcesOf`, `resolveLegacySources`, `isBrownfield`, `legacySourceBinding` (revision and dirty-tree binding), `assertLegacySourcesUnchanged`, `featureLocalPrefix`, `isUnderFeature`, `targetFeatureDirectory`, `brownfieldTargetBlocker`. |
| `census/boundary.mjs` | The module boundary: `assertRecordedScannerVersion`, `readCanonicalModuleBoundary` (the only boundary loader), `moduleEdgeTargetsFrom`, `moduleRootPath`, `moduleRootSource`, `assertSourcedModuleRoots`, `sourceOfEvidence`, `assertLegacyEvidenceWithinBoundary`, `assertLegacyEvidenceAttributes`, and `assertDiscoveryUnchanged` (freshness at FINALIZE). |
| `census/inventory.mjs` | The legacy and target inventories: `TARGET_STATES`, the `UI_*` vocabulary, the P1-7 evidence checklist (`EVIDENCE_*`, `assertEvidenceChecklist`, `assertOpenSpecIds`, `assertLegacyDiscoveryChecklist`, `assertTargetAssessmentChecklist`), `validateLegacyInventory`, `assertAdoptedTargetEvidence`, `validateTargetInventory`. |
| `census/completeness.mjs` | DISCOVERY_COMPLETENESS: `CLASSIFICATION_SCOPES`, `DISPOSITIONS`, `DECISION_BACKED_DISPOSITIONS`, `AGENT_DISMISSIBLE`, `moduleDecisionCandidate`, `validateDiscoveryCompleteness`. |
| `census/artifact.mjs` | The artifact engine's census: source binding and artifact identity (`bindingInput`, `sourcePathForId`, `artifactIdFor`, `assertDirectory`, `isExcluded`, `scopedManifest`, `captureBinding`, `sourcePathAtRoot`, `targetPathsFor`, `resolveArtifact`); structural census helpers (`metrics`, `STRUCTURAL_SCRIPT_EXTENSIONS`, `moduleSpecifiersIn`, `targetCodeFiles`, `CODE_FILE_EXTENSIONS`, `hasExecutableCodeFiles`, `commandFile`, `TARGET_COMPILER_SPECIFIERS`, `resolveCompilerBinary`, `TEST_UNDER_SRC`, `FEATURE_INDEX`, `UI_TEXT_PROPS`, `hardcodedUiText`, `PROVIDER_PATHS`); evidence files (`validateEvidenceFile`, `validateSourceEvidenceFile`); the source inventory document (`validateSourceInventoryDocument`, new); the completeness vocabulary (`COMPLETENESS_DISPOSITIONS`, `dispositionValidator`, `EXTERNAL_ELEMENT`, `packageNameOf`, `externalRequirementPackage` (new), `SCANNER_REQUIREMENT_KEYS`). |

Inside `census/`, the files import each other acyclically: `sources` ← `inventory` ← `artifact`, and `sources`, `scan` ← `boundary` ← `completeness`. `census/` imports only `decisions/index.mjs`, `store/index.mjs`, `formats/index.mjs`, `shared/index.mjs`, the leaf `engine-paths.mjs` and `node:` builtins. It runs nothing at import and writes nothing.

## Scanner boundary and lazy loading

- **Installed location.** `discovery-scan.mjs` stays the scanner's public path. It is now a facade that re-exports exactly its 14 BASE names from `census/index.mjs`, as the same bindings. Every engine file imports the census entry instead. The facade is for tests and external callers only (A5-ARCH-2).
- **Pinned parser.** `loadTypeScript` resolves `ts-discovery-compiler` with `createRequire(SCANNER_URL)`, where `SCANNER_URL` is `../discovery-scan.mjs` relative to `census/scan.mjs`. The resolution base, and the directory that `parserResolutionError` names in its refusal, are therefore byte-identical to BASE in a repository checkout and in an installed toolkit. The artifact engine still passes its own `import.meta.url`.
- **Lazy.** No census file loads the compiler at import. Neither do the engine modules that re-export census: `core.mjs`, `resumable-migration.mjs`, `artifact-migration.mjs`, `migration-utils.mjs` and `record-decision.mjs`. The first parse loads it, as before (A5-ARCH-6 checks this in a fresh process).
- **`engine-paths.mjs`.** It names the skill root in the parser refusal. It is a leaf: it imports nothing from the engine, as A1-ARCH-2 asserts. store already had the same exception, so the edge adds no upward dependency and no cycle.
- **Versions.** Algorithm 3 stays current, and 1, 2 and 3 stay supported. The scanner's findings, digest inputs and resolution are unchanged. The Core-first I2 fix (`ownedFramework`) moved with the file and was not re-implemented.

## Dependency inversions

No seam hands census a function that does I/O, takes a lock, writes or journals. The one injected function is a pure validator (A4 precedent: `uiBehaviorIsRequired`).

| Was | Now |
|---|---|
| `validateLegacyInventory` called the visual `assertRequiredObservations` per UI behavior at format 18. | Census `validateLegacyInventory(root, roots, state, { assertRequiredObservations })` calls it at the same point of the same loop. `resumable-migration.mjs` keeps the three-argument `validateLegacyInventory` as a one-line seam that passes visual's validator. Its five callers are unchanged. |
| The artifact engine's `validateSourceInventory` mixed the inventory document rules with the decision projection: the ledger, the DISCOVER_LEGACY history read (`consumedAtCheckpoint`), candidates and projection. | Census `validateSourceInventoryDocument(root, state)` holds the document rules, which ran first at BASE as well. The artifact seam continues with the ledger, history and decisions, in the same order. |
| The artifact engine's `validateExternalRequirements` interleaved the census rules for each row with a read of the target `package.json` (`assertTargetProvides`). | Census `externalRequirementPackage(row, label)` applies one row's rules and returns the package the target must provide. The seam loops and calls `assertTargetProvides` after each row, exactly where BASE did, so error precedence is unchanged. |
| `record-decision.mjs` read `legacySourceBinding` and `legacySourcesOf` from the lifecycle file. | It imports them from `census/index.mjs` (the same bindings). `previewDiscoveryScan` and `sliceDriftFacts` stay lifecycle seams. The A3 offer/write facts, ordering and candidate identity are unchanged. |
| Slices drift facts (A4 `sliceDriftFacts`). | Unchanged. The seam reads census `isBrownfield` and `legacySourceBinding` and passes them settled, as A4 defined. The drift candidate identity, auto-resolvability and the three-argument compat reader are untouched. |

## Remaining seams (not moved)

| Row(s) | Stays in | Why |
|---|---|---|
| `previewDiscoveryScan` | `resumable-migration.mjs` | It reads `readContext` and `readState`, which A1 left blocked in the lifecycle file. Its census part, `readCanonicalModuleBoundary`, moved. It moves when those store reads leave lifecycle. |
| `reopenDiscoveryUnderLock` | `resumable-migration.mjs` | It holds the module lock and journals (`writeJournalAtomic`, `ADVANCE_JOURNAL`, `activeArtifact`). This is lifecycle orchestration until A8. |
| `loadStructuralParser`, `targetTypeScript` | `artifact/artifact-migration.mjs` | Both are bound to `src/artifact/`'s `import.meta.url`: the parser resolution base, the refusal text, and the pinned fallback compiler identity recorded in evidence. Moving them would change installed resolution or bytes. |
| `structuralParser`, `targetProject`, `legacyDependencies`, `architectureFindings`, `sourceRequirements`, `validateCompleteness` | `artifact/artifact-migration.mjs` | They load a compiler through the two functions above. Passing the compiler in would load it eagerly or change error timing. `asEngineFault`, `engineFault` and `pathKey` stay with them. |
| `validateSourceInventory` (decision part), `validateExternalRequirements` (target read), the artifact `validateTargetInventory` | `artifact/artifact-migration.mjs` | Split as above. The artifact `validateTargetInventory` builds on `validateSourceInventory`. It is a different record from the module engine's `validateTargetInventory`, which moved. |

## Guarantees and their owner

| Guarantee | Census function(s) | Tests (unchanged suites unless marked new) |
|---|---|---|
| The census, not the graph, is the inventory: every tracked or untracked, unignored file under a declared root is censused, and none is dropped for being unreachable. | `runDiscoveryScan` | discovery-scan: "a file with no imports and no importers is still in the census", "the census includes untracked-but-unignored files and excludes ignored ones", "a symlink under an owned root is rejected" |
| Resolution follows the legacy project's own config: aliases, barrels, re-exports and literal dynamic imports. A non-literal import blocks. | `runDiscoveryScan`, `structuralUnits` | discovery-scan: "alias -> barrel -> component…", "literal dynamic import and require traverse; a non-literal one blocks", "a re-export names a unit this file cannot census…", "imported re-export emits unresolved binding…" |
| Inbound consumers and governing framework files are discovered without a declaration. That includes Next.js special files and an owned `error` boundary (I2, algorithm 3). | `runDiscoveryScan` | discovery-scan: "an undeclared file that imports into the roots becomes an entry point", "inbound consumers and governing framework files retain distinct evidence relations", "relevant or declared Next.js conventions…", "an owned Next.js error boundary is a framework entry… (I2)", "scanner algorithm dispatch changes behavior…" |
| The discovery digest is deterministic, and it is pinned at DISCOVERY_COMPLETENESS and rechecked at FINALIZE under the recorded algorithm. | `discoveryDigest`, `assertDiscoveryUnchanged`, `assertRecordedScannerVersion` | discovery-scan: digest tests (tsconfig edit, reordering, census file, unrelated edge or barrel); migration-contract: "a hand-edited discovery scan breaks its own pin", "persisted discovery scans retain declared entry reasons through FINALIZE", "a recorded algorithm version this build cannot run…", "a missing recorded scanner version fails as a typed version error…", "a classification must record an explicit valid scanner version…" |
| Every canonical file has a classification and a disposition. A decision-backed disposition needs a real operator decision, and a visual-bearing, production-reachable file is never agent-dismissible. | `validateDiscoveryCompleteness`, `DISPOSITIONS`, `AGENT_DISMISSIBLE` | migration-contract: "EXCLUDED_APPROVED without a real operator decision is refused", "an agent-authored or fake approval line cannot satisfy a stable candidate", "a production-reachable visual asset is never dismissed by rationale alone", "an approval does not survive an edit to the bytes it approved" |
| Roots are sourced per legacy source, and an ambiguous root needs a ROOT_DECLARATION. | `assertSourcedModuleRoots`, `moduleRootSource`, `validateDiscoveryCompleteness` | migration-contract: "DISCOVERY_COMPLETENESS canonicalizes roots per source", "a multi-source ROOT_DECLARATION approved through the recorder…", "the recorder demands no ROOT_DECLARATION for any source's own implicit root"; discovery-scan: "multiple legitimate roots share one owned census" |
| Legacy evidence stays inside the final boundary. Sources are bootstrap-fixed, and dirty legacy bytes are bound. | `assertLegacyEvidenceWithinBoundary`, `assertLegacySourcesUnchanged`, `legacySourceBinding` | migration-contract: "DISCOVERY_COMPLETENESS revalidates legacy evidence against the final editable boundary", "P1-6: dirty legacy bytes, dirty target bytes, and brief bytes are bound", "external consumer proof refuses changes after the pinned legacy revision" |
| The artifact source inventory and completeness are the census. An external requirement is never disposed of inside the artifact. | `validateSourceInventoryDocument`, `dispositionValidator`, `externalRequirementPackage` | artifact-migration: "completeness with an undeclared structural unit is refused", "a required external package holds DISCOVERY_COMPLETENESS…", "EXTERNAL_DEPENDENCY is refused unless the target really declares the package"; **new:** census.test "an external requirement's census rules decide the package…" |
| Census never grants approval: it builds and requires candidates through decisions, and the decisions authority rules (format 19 direct ledger, principals, AUTO limits) stay there. | `moduleDecisionCandidate`, `validateDiscoveryCompleteness` | decisions.test A3 format-19 tests; migration-contract F6-b, "W4-4…"; **new:** A5-ARCH-7 |

**Adversarial coverage.** The table maps each required case to its tests; "new" marks a test this track adds.

| # | Case | Tests |
|---|---|---|
| 1 | Tracked files omitted from declared entries | discovery-scan "a file with no imports and no importers is still in the census" |
| 2 | Untracked files under declared roots | discovery-scan "the census includes untracked-but-unignored files…" |
| 3 | Aliases and barrels | discovery-scan "alias -> barrel -> component…", "an unrelated barrel export neither expands SUPPORTING…" |
| 4 | Inbound consumers outside the roots | discovery-scan "an undeclared file that imports into the roots…", "inbound consumers and governing framework files…" |
| 5 | Framework-discovered entry points | discovery-scan "relevant or declared Next.js conventions…", "a declared framework module edge needs concrete targets…" |
| 6 | Next.js special files, error routes | discovery-scan "an owned Next.js error boundary is a framework entry… (I2)" |
| 7 | Unsupported algorithm version | migration-contract "a recorded algorithm version this build cannot run…", "a classification must record an explicit valid scanner version…" |
| 8 | Missing algorithm version | migration-contract "a missing recorded scanner version fails as a typed version error…" |
| 9 | Tampered or stale discovery digest | migration-contract "a hand-edited discovery scan breaks its own pin", "persisted discovery scans retain declared entry reasons through FINALIZE" (the `added-later` drift) |
| 10 | Legacy bytes changed after binding | migration-contract "P1-6: dirty legacy bytes…", "an approval does not survive an edit to the bytes it approved", "external consumer proof refuses changes after the pinned legacy revision" |
| 11 | Ambiguous or conflicting roots | migration-contract "DISCOVERY_COMPLETENESS canonicalizes roots per source", ROOT_DECLARATION tests; discovery-scan "multiple legitimate roots…", "scanning refuses without a declared module root, and rejects escaping roots" |
| 12 | Undeclared supporting evidence | discovery-scan "the module's out-closure is SUPPORTING with a requiredBy map"; migration-contract "DISCOVERY_COMPLETENESS revalidates legacy evidence…" |
| 13 | Unresolved references | discovery-scan "literal dynamic import… a non-literal one blocks", "an identifier this file cannot resolve is emitted unresolved, never dropped" |
| 14 | Visual-bearing files dismissed | migration-contract "a production-reachable visual asset is never dismissed by rationale alone" |
| 15 | Missing operator decisions | migration-contract "EXCLUDED_APPROVED without a real operator decision is refused"; artifact-migration "pending operator decisions block advance…" |
| 16 | Format-19 direct-ledger authority | decisions.test A3 format-19 tests; migration-contract F6-b; **new:** A5-ARCH-7 |
| 17 | A3 candidate identity | decisions.test, migration-contract "an operator decision approves exactly the file, rationale, and census it was shown"; record-decision.test |
| 18 | A4 drift facts and source binding | migration-contract "A4: the decisions seam and the three-argument reader offer the same drift facts…"; slices.test "a settled census fact…" |
| — | The A5 visual seam | **new:** census.test "the legacy inventory rules apply the injected observation rule once per UI behavior, in order, only from format 18" |

Architecture checks:
- `census.test.mjs`:
  - **A5-ARCH-1:** one public entry, which only re-exports.
  - **A5-ARCH-2:** engine code imports census names only through `census/index.mjs`, and no engine file imports the `discovery-scan.mjs` facade.
  - **A5-ARCH-3:** the files inside `census/` import each other acyclically.
  - **A5-ARCH-4:** each census declaration has one live definition. No moved declaration survives at its old site. Two same-named seams are allowed and named.
  - **A5-ARCH-5:** the BASE compatibility exports of `core.mjs`, `resumable-migration.mjs`, `artifact-migration.mjs`, `migration-utils.mjs` and `discovery-scan.mjs` are the census binding itself.
  - **A5-ARCH-6:** the algorithm versions are pinned. Importing census and every module that re-exports it loads no compiler, and the first parse loads it from the scanner's installed path.
  - **A5-ARCH-7:** census imports from decisions only builders, readers and `requireModuleDecision`, and it writes nothing.
- `store-shared.test.mjs`: A1-ARCH-1 and A1-ARCH-2 now cover `census/`. Its allowed imports are the decisions, store, formats and shared entries plus the leaf `engine-paths.mjs`. Lower modules still may not import it. The A1-ARCH-3 old-site rule follows the scanner to `census/scan.mjs`.
- `formats.test.mjs`: the raw-comparison table moves `resolveArtifact`'s one comparison from `artifact-migration.mjs` (5 → 4) to `census/artifact.mjs` (1). The total is unchanged.

## Compatibility

These modules keep every export name, arity and value they had at BASE: `core.mjs`, `resumable-migration.mjs`, `discovery-scan.mjs`, `artifact/artifact-migration.mjs`, `migration-utils.mjs`, `record-decision.mjs`, `cli/*` and `mcp-server.mjs`. Moved names are thin re-exports of the census binding. No CLI argument, refusal message, record byte or format version changed.

## Deferred (Track B)

- **I3 / DR28.** The implicit module root rule is still two agreeing copies: census `validateDiscoveryCompleteness` (validation) and `decisions/record.mjs` (offer). Merging them is left with I3, which changes the choice.
- **F8.** There is still no repair path for observations after the census.
- **DR1.** `isWithin` keeps its two variants. The scanner keeps `isLexicallyWithin` and the rest of census keeps `isResolvedWithin`, as at BASE.

## Remaining architectural violations

- `previewDiscoveryScan` and `reopenDiscoveryUnderLock`: census rows still in the lifecycle file (above).
- The parser-bound artifact census: nine rows still in `artifact-migration.mjs` (above).
- `slices/` still receives census facts only as data, through `sliceDriftFacts`. Slices may now import `census/index.mjs` directly under (b), but switching is not required here and A5 does not do it.
- Census vocabulary that visual reads (`UI_RUNTIME_STATES`, `UI_KINDS`, …) now lives in census. The visual rules that read it (`validateUiRuntimeEvidence`, `assertRequiredObservations`) are A6.
