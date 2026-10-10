# Phase 0 — Architecture baseline for `start-migration` (revision 2.1)

**Status:** evidence only, nothing implemented. **Every design item below is a PROPOSAL** unless it is a measurement. Revision 2 closed the gaps in revision 1; its changes are listed in §0. Revision 2.1 changes only measurements: every dataset was regenerated with the corrected Phase 0 analyzers, and §0.1 lists each changed figure with its cause. No proposal changed.
**BASE:** `05e604992f10b239753a74246a9ac5a45d9b2fed` (v1.3.19 record). Re-checked at the start of revision 2: `HEAD`, local `main` and `toolkit/main` were all equal to BASE.
**Branch:** `arch/phase0-docs`, which commits the plan under revision, this file, and `docs/architecture/phase0/` (tools, their tests, and data). The analyzers were last corrected at `2a55280baa1b2bbcd8c20bfc0b0311631f5068e9`; every dataset was regenerated with that version.
**Plan under revision:** `docs/start-migration-architecture-plan.md`, audited at `f0809218274131d06dd363280e6c825178fa38e2` (v1.3.17 record).
**Scope of "engine":** the 27 `*.mjs` files under `packages/migration-engine/src`. Install code (`providers/install-support.mjs`, `scripts/runtime-bootstrap.mjs`) is covered in §5 and Track A7.
**Findings source:** the run log the user supplied (read-only, outside the repo). Findings are cited by ID only.

Every command runs from `docs/architecture/phase0/` and reads git objects, so it reproduces on any checkout:

```sh
cd docs/architecture/phase0
BASE=05e604992f10b239753a74246a9ac5a45d9b2fed
R=$(git rev-parse --show-toplevel)   # repo root
T=tools                              # inventory, callgraph, assign, writesites, modgraph (shared code in analysis.mjs)
# The tools load the engine's pinned typescript@5.9.3 (the ts-discovery-compiler alias) from this checkout,
# so run `pnpm install` once; nothing new is installed. Each tool exits 1 with empty stdout on anything it cannot classify.
```

Regenerate every data file (under a minute). Running the block twice gives byte-identical files.

```sh
node $T/inventory.mjs $R $BASE decls   > data/decls-05e6049.tsv
node $T/inventory.mjs $R $BASE writes  > data/writes-05e6049.tsv
node $T/inventory.mjs $R $BASE imports > data/imports-05e6049.tsv
node $T/inventory.mjs $R $BASE fv      > data/fv-05e6049.tsv
node $T/callgraph.mjs $R $BASE         > data/edges.tsv
node $T/assign.mjs data/decls-05e6049.tsv a > data/owners.tsv     # exits 1 on any missing, duplicate or unknown declaration
node $T/assign.mjs data/decls-05e6049.tsv b > data/owners-b.tsv   # option (b) of §4: the 4 candidate builders move to their fact modules
node $T/writesites.mjs owned data/owners.tsv data/writes-05e6049.tsv > data/writes-owned.tsv
node $T/writesites.mjs wrapper-calls data/owners.tsv data/writes-05e6049.tsv data/edges.tsv > data/wrapper-calls.tsv
node $T/modgraph.mjs data/owners.tsv data/edges.tsv --samples > data/modgraph-a.txt
node $T/modgraph.mjs data/owners-b.tsv data/edges.tsv --layer-order='slices>visual>census>decisions' --samples > data/modgraph-b.txt
```

The tools' own tests: `node --test docs/architecture/phase0/tools/test/` (from the repo root).

---

## 0. What changed since revision 1

| Area | Revision 1 | Revision 2 |
|---|---|---|
| Evidence location | session scratchpad (temporary) | `docs/architecture/phase0/tools` + `data`; all commands run from there |
| Findings | D1–F6 not found | Mapped every finding the supplied log defines: **F1–F6, F8, I1–I8, P1–P4** (§5). **D1, D2 and D3 are not defined in that log** (open question Q4). |
| Coverage | 856 functions and classes | **1,191 declarations: 852 functions, 4 classes and 335 values.** `assign.mjs` fails on a missing or duplicate value; verified with two broken copies, both exit 1. |
| Ownership fixes | `rootRelativePath` / `targetRelativePath` / `legacyRelativePath` were leaf; `recordRelative` was visual | the three path functions → **slices** (DR4 owner); `recordRelative` → **leaf**: callers are 5 slices, 3 lifecycle and 2 visual, and the body is a DR3 copy |
| Purity of formats | 77 outgoing violations, 46 of them to store | **0 edges to store; 3 to lifecycle and 3 to transport, each justified** (§4.1). 14 functions that read disk moved to lifecycle; 22 pure helpers moved down (14 to leaf, 8 to formats); `usesVisualContract` moved to visual. |
| Call graph | no scope resolution | names declared locally inside a declaration no longer count as references to top-level names (this removed a false `assertFigmaSource → canonical` edge). 3,339 → 3,326 edges |
| Layering | siblings forbidden, 235 violating function pairs | options (a), (b) and (c) computed, with values as nodes; **(b) recommended: 132 violations** (§4) |
| New duplicate rule | — | **DR27**: the "was this file run as the command?" guard (finding F2). DR3 gains `recordRelative`. DR17's owner moves to formats. |
| Design source (Q6) | open | two options, each with owner, scope and hours (§6a) |
| Estimates | ≈139 h | **Track A ≈101 h, Track B ≈48 h (up to ≈71 h with the conditional items), release 2 h. Core-first cut ≈27 h** (§8) |

Figures in this table are as of revision 2. §0.1 lists the ones revision 2.1 changed.

### 0.1 Revision 2.1: datasets regenerated with the corrected analyzers

The analyzers now resolve references with the TypeScript checker, and they fail (exit 1, no output) on any construct they cannot classify instead of dropping a row (Appendix E). Every dataset was regenerated at BASE with them. Every revision-2 row is still present (for `edges.tsv`, every caller/callee pair; rows now carry a sixth `via` column), apart from the 6 duplicate `fv` rows below; no edge count changed; the 4 option-(b) moves are the same.

| Figure | Revision 2 | Revision 2.1 | Exact reason |
|---|---|---|---|
| `decls` rows | 1,221 | 1,232 | +11 `<module-init>` rows: each file's top-level statements (the `if (isMainModule(import.meta.url)) …` CLI entry blocks) were not counted before |
| Owned declarations (M3c, §2, Appendix A) | 1,191 | 1,202 | the same 1,191 named declarations, plus the 11 `<module-init>` rows, all owned by transport (§2) |
| transport declaration spans | 2,660 | 2,732 | +72 lines of the 11 entry blocks |
| Primitive fs write calls, monolith / engine (M5) | 39 / 90 | 40 / 96 | +6 calls the earlier scan missed: `open` with numeric `fsConstants` flags at `operator-signer-service.mjs:35`, `operator-signer.mjs:74` and `record-decision.mjs:1391`; `handle.write` at `record-decision.mjs:1394`, `:1396` and `resumable-migration.mjs:3445` (`write` was not in the primitive list) |
| Write calls owned by store / decisions (§2.1) | 20 / 3 | 24 / 5 | the 6 calls above: `appendDurably` ×3 and `sealHistoryTail` are store; `writeOperatorOnly` and `openSignerStore` are decisions |
| Caller/wrapper pairs (M5b) | 66 | 66 | unchanged; every curated wrapper is now proven to reach a write |
| Raw `formatVersion` comparisons (M6c) | 57 | 51 | 6 comparisons were printed twice because both operands matched: `artifact/artifact-migration.mjs:201`, `:205`; `resumable-migration.mjs:651`; `upgrades/upgrade-migration.mjs:625`; `upgrades/upgrade-v4-to-v5.mjs:132`, `:318` |
| `imports` rows | 113 | 113 | unchanged |
| Declaration pairs in `edges.tsv` | 3,326 | 3,370 | +24 pairs from the `<module-init>` rows (each references `isMainModule` and its CLI runner; `cli/run-migration.mjs` and `mcp-server.mjs` also reference `exitCodeFor`); +20 pairs through dynamic `import()` that were not resolved before (member reads, destructuring and `.then` callbacks, at `cli/toolkit-identity.mjs:99`, `:114`; `migration-utils.mjs:1433`; `record-decision.mjs:1364`, `:1373`, `:1377`, `:1383`, `:1457`, `:1514`, `:1543`; `resumable-migration.mjs:5486`, `:5695`, `:6350`, `:7345`, `:11295`, `:15991`). None lost |
| Cross-module pairs (a) / (b) | 1,656 / 1,653 | 1,665 / 1,662 | +9 of the 44 new pairs cross modules: transport→lifecycle 2, transport→census 1, transport→decisions 1 (the signer service's entry block), decisions→leaf 1, **lifecycle→transport 2**, lifecycle→census 1, lifecycle→decisions 1 |
| Violating pairs (a) / (b) / (c) / best order with (a) | 176 / 132 / 133 / 135 | 178 / 134 / 135 / 137 | +2 lifecycle→transport (9 → 11): `resumable-migration.mjs:6349 artifactBindingFor` destructures `artifactArgumentsFor` and `artifactCommandFor` out of the lazy artifact-engine import at `:6350`. Option (b) is still the minimum over all 24 orders |
| Upward violating pairs | 116 | 118 | the same +2 |
| 2-cycles (b) | census↔lifecycle 23/50, decisions↔lifecycle 11/13, decisions↔transport 8/33, lifecycle↔transport 9/43 | 23/51, 11/14, 8/34, 11/45 | the new pairs above. The single SCC is unchanged |
| A8 lifecycle estimate (§8) | 11.4 h | 11.7 h | 9 → 11 outgoing violations at 8 pairs per hour |
| `owners-b.tsv` | an awk edit of `owners.tsv` | `assign.mjs … b` | the same 4 moves, now in the frozen table, so a stale override fails instead of matching nothing |

---

## 1. Re-measured metrics at BASE

Revision 2.1 changed M3c, M5 and M6c (§0.1); every other value is unchanged from revision 1. The commands are rewritten to run from `docs/architecture/phase0/`: `git -C $R` keeps path arguments repo-relative. Each command was first run at the plan's audit SHA (f080921); where it reproduces the plan's number there, the method is the same.

| # | Metric | Plan (f080921) | Same command at f080921 | **BASE** | Command |
|---|---|---|---|---|---|
| M1 | Engine lines | 36,450 | 36,450 ✓ | **36,338** | `git -C $R ls-tree -r --name-only $BASE packages/migration-engine/src \| grep '\.mjs$' \| while read f; do git -C $R show $BASE:$f; done \| wc -l` |
| M2 | `resumable-migration.mjs` lines | 17,057 | 17,057 ✓ | **16,939** | `git -C $R show $BASE:packages/migration-engine/src/resumable-migration.mjs \| wc -l` |
| M3 | Top-level functions in that file | 336 | 336 ✓ | **334** (+1 class) | `node $T/inventory.mjs $R $BASE decls \| awk -F'\t' '$1=="resumable-migration.mjs" && $4=="fn"' \| wc -l` |
| M3b | "Exported" in that file | 185 | 185 ✓ | **185** = 115 functions + 1 class + 69 values | `git -C $R show $BASE:packages/migration-engine/src/resumable-migration.mjs \| grep -c '^export '` |
| M3c | Top-level declarations, whole engine | — | — | **1,191** = 852 functions + 4 classes + 335 values; plus 11 `<module-init>` rows = **1,202** owned | `node $T/inventory.mjs $R $BASE decls \| awk -F'\t' '$4!="reexport" && $4!="module-init"' \| wc -l` and `node $T/inventory.mjs $R $BASE decls \| awk -F'\t' '$4=="module-init"' \| wc -l` |
| M4 | Modules importing the monolith / distinct names | 11 / 71 | 11 / 71 ✓ | **11 / 71** | `node $T/inventory.mjs $R $BASE imports \| awk -F'\t' '$3 ~ /resumable-migration\.mjs$/ && $1!="core.mjs" {print $1}' \| sort -u \| wc -l` and `node $T/inventory.mjs $R $BASE imports \| awk -F'\t' '$3 ~ /resumable-migration\.mjs$/ && $1!="core.mjs" {n=split($4,a,","); for(i=1;i<=n;i++) print a[i]}' \| sort -u \| wc -l` |
| M5 | Primitive fs write calls (AST): monolith / engine | 78 / 117 | not reproducible | **40 / 96** | `node $T/inventory.mjs $R $BASE writes \| awk -F'\t' '$1=="resumable-migration.mjs"' \| wc -l` and `node $T/inventory.mjs $R $BASE writes \| wc -l` |
| M5b | Caller/wrapper pairs into write wrappers | — | — | **66** | `wc -l < data/wrapper-calls.tsv` (built in Appendix B.2) |
| M6 | Supported record formats | 16 (4–19) | ✓ | **16 (4–19)** | `git -C $R show $BASE:packages/migration-engine/src/resumable-migration.mjs \| grep -nE '^export const (EARLIEST_SUPPORTED_FORMAT\|MIGRATION_FORMAT_VERSION) '` |
| M6b | `uses*Format` gate calls | — | 72 | **72** | `git -C $R grep -hE '\buses(DiscoveryCompleteness\|CapabilityOwnership\|UiVerification\|ArtifactDelegation\|DesignSource\|MultiSource\|SliceRework\|VisualAcceptance\|RequiredObservations\|DirectLedgerDecisions)\(' $BASE -- packages/migration-engine/src \| wc -l` |
| M6c | Raw `formatVersion` comparisons (AST) | — | — | **51** | `node $T/inventory.mjs $R $BASE fv \| wc -l` |
| M7 | Growth from v1.0.0 | +40% / +46%, 28 releases | ✓ at v1.3.17 | **engine +40.1%, SKILL.md +46.3%; 30 releases** | `git -C $R show v1.0.0:skills/start-migration/SKILL.md \| wc -l` and the same at `$BASE`; engine = M1 at `v1.0.0`; `git -C $R tag -l 'v*' --sort=creatordate \| sed -n '/v1.0.0/,/v1.3.19/p' \| wc -l` |
| M8 | Instruction words | ~31,000 | 31,247 | **31,300** | `git -C $R ls-tree -r --name-only $BASE skills/start-migration \| grep '\.md$' \| while read f; do git -C $R show $BASE:$f; done \| wc -w` |
| M9 | Test lines / largest file | 50,405 / 20,340 | ✓ | **50,580 / 20,444** | `git -C $R ls-tree -r --name-only $BASE \| grep -E '^(packages/migration-engine/test\|test)/.*\.(mjs\|ts)$' \| while read f; do git -C $R show $BASE:$f; done \| wc -l` |
| M9b | Test files importing the monolith | 21 | 21 ✓ | **21 engine + 1 provider** | `for f in $(git -C $R ls-tree -r --name-only $BASE \| grep -E '^(packages/migration-engine/test\|test)/.*\.(mjs\|ts)$'); do git -C $R show $BASE:$f \| grep -qE "resumable-migration\.mjs['\"]" && echo $f; done \| wc -l` |

Corrections to plan §1 (unchanged from revision 1):
- "185 exported" counts every export statement; exported functions alone are 115.
- The 78 / 117 write sites cannot be reproduced. They are replaced by M5 and M5b.

### 1.1 `/ponytail-audit` result (engine, over-engineering only; finished well inside the 3 h timebox)

1. `delete:` dead declarations: `upgrades/upgrade-migration.mjs:71 lockPathFor`, `:55 TRANSACTION_STATES`, `upgrades/upgrade-v4-to-v5.mjs:75 BRIEF_FILE`, `discovery-scan.mjs:116 REACHABILITY_VALUES`, `record-decision.mjs:107 DECISION_KINDS`, `toolkit-identity.mjs:144 resetActiveToolkitIdentity` (its comment says "test seam", but no test uses it), `artifact/artifact-migration.mjs:2506 bootstrapArtifact`, and `migration-utils.mjs:1688 fileContentIdentity` / `:1697 fileContentIdentityMatches`, which are only re-exported by `core.mjs`. Replacement: nothing.
2. `shrink:` four `isWithin` copies, three `samePath`/`comparablePath` copies, four `portable*` copies, five sha256-hex helpers plus about 30 inline `createHash("sha256")` sites, and five plain-object guards, all collapsed into one leaf module (DR1–DR3, DR5, DR6).
3. `yagni:` wrappers that only delegate: `upgrades/upgrade-migration.mjs:497 acquireLock` (just calls `acquireModuleLock`) and `:136 writeJournal = writeJournalAtomic`. Replacement: call the target directly.
4. `delete:` the second lazy artifact-engine loader, `cli/toolkit-identity.mjs:72`, which duplicates `resumable-migration.mjs:107`.

`net: about −130 lines, −0 deps possible.` No dependency is replaceable: `pixelmatch`, `pngjs`, `@simplewebauthn/server` and the pinned TypeScript are each used for what they do.
The real size problem is structural (§3, §4), not dead code. Deleting all of the above barely changes M1.

---


---

## 2. Ownership map (PROPOSAL)

**Result:** all **1,202** owned declarations, namely the 1,191 top-level declarations (852 functions, 4 classes, 335 values) and 11 `<module-init>` rows, are assigned to exactly one owner, and `assign.mjs` exits 0 under both options. As a negative check, a copy of `assign.mjs` with `LATE_DECISION_KINDS` removed exits 1 (`MISSING`), and a copy that also assigns it to store exits 1 (`DUPLICATE`); both print nothing, under either option. The full list is in Appendix A.

| Owner | Functions/classes | Values | Module-init | Lines (declaration spans) | Option (b) delta |
|---|---|---|---|---|---|
| store | 97 | 9 | — | 2,067 | — |
| formats | 80 | 96 | — | 1,848 | — |
| lifecycle | 155 | 38 | — | 8,798 | — |
| decisions | 150 | 49 | — | 3,993 | −4 functions (the candidate builders) |
| slices | 66 | 18 | — | 2,481 | +1 `pendingTargetDriftCandidates` |
| census | 76 | 43 | — | 4,473 | +2 `moduleDecisionCandidate`, `moduleEdgeTargetsFrom` |
| visual | 93 | 39 | — | 3,566 | +1 `pendingVisualUnbackedCandidates` |
| transport | 69 | 28 | 11 | 2,732 | — |
| **unassigned (leaf)** | 70 | 15 | — | 618 | — |

Leaf holds path, hash, shape, git and content-identity primitives. **Reason it is unassigned:** none of these holds a domain guarantee. PROPOSAL: a leaf `shared/` module below formats (Q3).

### How owners were decided

**Rules carried over from revision 1:**
- **R1.** A function that holds the module lock belongs to the module whose rule it applies.
- **R3.** Candidate builders belong to decisions. Option (b) moves them to the module that owns their facts.
- **R4.** The artifact sub-engine is split by role (Q2).

**Revision 2 changes:**
- **R2 (extended: formats is pure).** formats keeps only pure upcast, validation, vocabulary and plan logic.
  - Every formats function that reads disk, journal, registry or history moved to **lifecycle** (14):
    - `previewArtifactFormatUpgrade`, `pristineFormatUpgrade`, `proveFormatUpgradeTransaction`, `proveToolkitIdentityTransaction`;
    - `legacyChecklistBlocker`, `pendingFormatUpgrade`, `previewUiObservationsAdoption`, `uiObservationsAdoptionPlan`, `visualContractAdoptionPlan`, `combinedUiAdoptionPlan`;
    - `upgrade-migration.mjs` `previewUpgrade`, `previewRollback`, `resolveContext`, `restorableUpgrade`.
  - Pure helpers that had been filed under store or decisions moved to **leaf** (14): content identity (`sha256Hex`, `foldCrlf`, `expandLf`, `isTextContent`, `isTextIdentityEligible`, `parseContentIdentity`, `isContentIdentity`, `contentIdentity`, `contentIdentityMatches`), `hashContent`, `sha256Json`, and the artifact engine's `canonical`, `jsonBytes`, `jsonBytesEqual`.
  - Record vocabulary moved to **formats** (8): `stepsFor`, `validateOpenSpecAuthorityShape`, `requirementsSourceFor` (it reads one env var and does no I/O), `validateBinding`, `resolveDesignSource`, `assertFigmaSource`, and the v4→v5 upgrader's `renderJson` and `digestArtifactHashes`.
  - `usesVisualContract` moved to **visual**: it is keyed on design source, not format version.
- **R5 (values).** Each value was derived once, then the result was frozen in `assign.mjs`. Derivation order:
  1. Name rule: `*FORMAT*`, contract and version constants, and `*_FILE` / `*_FILES` record-layout names → formats, because they are the record model and every higher layer reads them.
  2. Otherwise, the majority owner of the declarations that reference the value (ties go to the lower layer).
  3. Otherwise, the file's dominant owner (9 values).
  4. Explicit overrides, each with its reason:
     - `writeJournal` alias → lifecycle;
     - `FORMAT_UPGRADERS` and `ARTIFACT_FORMAT_UPGRADERS` → lifecycle (dispatch tables of write commands);
     - `MIGRATION_STEPS`, `initialArtifacts`, `TOOLKIT_IDENTITY_EVENTS`, `UI_OBSERVATIONS_ADOPTION_ROOT`, `MAX_SLICE_REWORKS` → formats (record model);
     - `VISUAL_AUTHORITIES` and `AUTHORITY_CONTEXT_FILES` → visual (they dispatch visual validators);
     - `NEXT_APP_FILES` / `NEXT_ROOT_FILES` → census, because the file-name rule does not apply to scanner vocabulary.
- **R6.** `rootRelativePath`, `targetRelativePath` and `legacyRelativePath` → **slices**, which owns the DR4 claims model. `recordRelative` → **leaf**.

**Revision 2.1 change:**
- **R7 (module-init → transport).** A file's top-level statements form one `<module-init>` declaration. At BASE, 11 files have one, and each is exactly a CLI entry block, `if (isMainModule(import.meta.url)) { <runner>(…).catch(…) }`: `artifact/run-artifact.mjs`, `cli/advance-migration.mjs`, `cli/discover-module.mjs`, `cli/run-migration.mjs`, `cli/toolkit-identity.mjs`, `cli/update-migration-registry.mjs`, `cli/validate-migration.mjs`, `mcp-server.mjs`, `operator-signer-service.mjs`, `record-decision.mjs` and `upgrades/upgrade-migration.mjs`. Starting a process from argv is transport's job, so all 11 are owned by transport. `assign.mjs` lists these files explicitly, so top-level statements in any other file make it exit 1 until an owner is chosen.
  - **Edges:** the entry blocks add 24 pairs. Only one crosses a module: `operator-signer-service.mjs <module-init> → runSignerService` (transport→decisions), a downward edge. They add no violation and no cycle.
  - **Implication for extraction:** three files mix a CLI entry with domain code: `record-decision.mjs` (decisions), `operator-signer-service.mjs` (decisions) and `upgrades/upgrade-migration.mjs` (lifecycle, formats and store). In Track A, each entry block moves to transport as a thin executable, and the domain module keeps no top-level side effect. The installed command names do not change.

### 2.1 Write sites

All **96** primitive calls (90 in revision 2; §0.1) and **66** caller/wrapper pairs have an owner (Appendix B).

| Owner of enclosing function | Primitive calls | Wrapper pairs |
|---|---|---|
| store | 24 | 8 |
| lifecycle | 62 | 40 |
| slices | 3 | 9 |
| decisions | 5 | 2 |
| census | 1 | 3 |
| visual | 1 | 3 |
| transport | 0 | 1 |

Revision 2 changed one thing: the `writeJournal` alias is now owned by lifecycle, so its pair moved from "(value)" to lifecycle. Revision 2.1 adds the six calls the earlier scan missed: four in store (`appendDurably` ×3, `sealHistoryTail`) and two in decisions (`writeOperatorOnly`, `openSignerStore`). The wrapper pairs are unchanged.


---

## 3. Duplicate-rule inventory

"Rule" means one guarantee implemented in more than one place. **Track** says whether the copies agree, so merging them preserves behavior (A), or whether they differ, so merging them is a deliberate golden-trace change (B).

| ID | Rule | Copies (file:line) | Agree? | Proposed owner | Track |
|---|---|---|---|---|---|
| DR1 | Path containment `isWithin` | `resumable-migration.mjs:1274`, `artifact/artifact-migration.mjs:1071` (both `path.resolve` first); `migration-utils.mjs:204`, `discovery-scan.mjs:179` (no `resolve`) | **No**: two variants that differ for relative inputs | leaf | B |
| DR2 | Same path (case-folded on win32) | `migration-utils.mjs:36` + `:41`, `artifact/artifact-migration.mjs:1035` | Yes | leaf | A |
| DR3 | Portable separators / record-relative path | `migration-utils.mjs:34`, `discovery-scan.mjs:156`, `artifact/artifact-migration.mjs:1013`, `resumable-migration.mjs:1794` (`portableRoot`, which also resolves), `resumable-migration.mjs:1016 recordRelative` (rev 2: same body as `:10913 targetRelative`) | Yes, except `portableRoot` | leaf | A |
| DR4 | **Canonical target-relative claim spelling (claims model)** | `resumable-migration.mjs:6307 rootRelativePath` (strips `./` and trailing `/`, sibling prefix, containment check) used via `:6331`/`:6340`; `:10913 targetRelative` (raw `path.relative`); `:7553 repoRelative` (**adds** `./`); `:10651 canonicalClaim` fallback (first token, `\`→`/`); `artifact/artifact-migration.mjs:1141 normalizeRelative` | **No**: four spellings | slices | B |
| DR5 | sha256-hex helper | `artifact/artifact-migration.mjs:1014`, `upgrades/upgrade-migration.mjs:63`, `upgrades/upgrade-v4-to-v5.mjs:81`, `visual-evidence.mjs:744`, `migration-utils.mjs:1535 sha256Hex`, `resumable-migration.mjs:1916 hashContent`, `operator-webauthn.mjs:37 sha256Digest`, plus inline `createHash("sha256")` in `resumable-migration.mjs` (1310, 1344, 1363, 1394, 1502, 1532, 2243, 3338, 4257, 4260, 4279, 4519, 4557, 8963, 11480), `migration-utils.mjs` (850, 866, 1025, 1029, 1201), `discovery-scan.mjs` (1308, 1738, 2292), `record-decision.mjs` (1868, 2012), `upgrades/upgrade-migration.mjs` (417, 741), `toolkit-identity.mjs:105`, `operator-webauthn.mjs:88` | Same primitive; the *input* differs per digest | leaf | A |
| DR6 | Plain-object guard | `resumable-migration.mjs:1238` + `:1241`, `migration-utils.mjs:197`, `upgrades/upgrade-v4-to-v5.mjs:97`, `artifact/artifact-migration.mjs:1087` | Yes | leaf | A |
| DR7 | **Atomic replace-write** | `migration-utils.mjs:245 atomicWrite` (secure path, temp file cleaned up on error, fsync, rename); `module-lock.mjs:172 writeJournalAtomic` (no secure-path check, temp file not cleaned up on error); `upgrades/upgrade-migration.mjs:121 writeTree` (plain `writeFile`) + `:453 commitReplacement` (directory rename); `operator-signer-service.mjs:34 writeOperatorOnly` (truncates in place); `resumable-migration.mjs:12612 commitInitialization` (staged-directory rename) | **No** | store | B |
| DR8 | **Append-only ledger/history append** | `record-decision.mjs:1047 appendDecisions` (`appendFile`, no fsync); `record-decision.mjs:1388 appendDurably` (fsync of file and directory); `resumable-migration.mjs:3380 appendHistory` (`appendFile`, no fsync) | **No** | store | B |
| DR9 | "Census closed" predicate | `record-decision.mjs:460`, `:755`, `:1049`, `:1454`; `cli/run-migration.mjs:164` | Yes: same expression on `completedSteps` | decisions | A |
| DR10 | Applying the post-census kind gate (offer vs write) | the predicate itself is single (`resumable-migration.mjs:1413`); it is applied in `record-decision.mjs:488` (derive), `:701`/`:708` (group offer), `:1049` (append), `:1453` (attested append) and `resumable-migration.mjs:1433` (ledger-tail check on read) | Yes today, but 5 call sites have to stay in step | decisions | A |
| DR11 | Decision-ledger byte digest (record time vs recompute time, the v1.3.14 pattern) | `resumable-migration.mjs:4514 rawDecisionLedgerDigest` (written at `:16686`); inline `sha256:${hashContent(bytes)}` at `:1359–1361` (recompute in `DERIVED_PINS`) | Yes today | store | A |
| DR12 | Exclusive-create lock or owner file | `module-lock.mjs:92/119 acquireModuleLock`, `resumable-migration.mjs:12522 writeOwner`, `operator-signer.mjs:74`, `upgrades/upgrade-migration.mjs:497 acquireLock` (delegates) + `:71 lockPathFor` (dead, with a different path) | Mostly | lifecycle | A |
| DR13 | Journal recovery | `resumable-migration.mjs:3506 recoverPendingAdvance`, `:12591 recoverInitialization`; `migration-utils.mjs:1237 recoverRegistryJournal`; `upgrades/upgrade-migration.mjs:145 recoverTransaction`, `:863 recoverUpgrade`; `artifact/artifact-migration.mjs:2368 recoverTransaction` | **No**: five journal formats | lifecycle | B |
| DR14 | Delete the journal after commit | `resumable-migration.mjs` 3540, 3566, 12451, 12553, 12927, 13118, 13227, 13532, 13703, 14148, 14389, 14647, 15003, 15342, 15661, 16929 | Yes | lifecycle | A |
| DR15 | Integrity anchor | `resumable-migration.mjs:1542 renderIntegrity` / `:1609 readIntegrity` / `:1626 assertIntegrityAnchor` / `:1501 digestArtifactHashes`; `artifact/artifact-migration.mjs:1598 integrityFor` / `:1728 validateIntegrity`; `upgrades/upgrade-v4-to-v5.mjs:86 digestArtifactHashes` | No: separate record kinds and a frozen upgrader | store | B (or keep, Q5) |
| DR16 | History chain read and verify | `resumable-migration.mjs:3337 historyDigest` / `:3574 readHistoryEvents`; `artifact/artifact-migration.mjs:1528 readHistory` / `:1748 historyPrefixContent` | No | store | B |
| DR17 | Valid design-source values | `migration-policy.mjs:45 assertDesignSource`; `migration-utils.mjs:148 resolveDesignSource` | Yes (different messages) | **formats** (rev 2: record vocabulary) | A |
| DR18 | **Design source is immutable for the record's lifetime** | `resumable-migration.mjs:2613 designSourceExplicit` + `:2627 assertDesignSourceUnchanged` (compares `figmaSourceKey` = kind#fileKey#nodeId), applied at `:11717` and `:15427`; `artifact/artifact-migration.mjs:4225–4235` (an inline copy that compares `canonical(full objects)`) | **No**: different comparison | visual | B |
| DR19 | Toolkit-identity gate and change | `resumable-migration.mjs:13354 assertRecordToolkitIdentity`, `:13452 changeModuleToolkitIdentity`; `artifact/artifact-migration.mjs:4720 assertArtifactToolkitIdentity`, `:4738 changeArtifactToolkitIdentity`, `:1564 replayToolkitIdentity` | No (per record kind) | formats (gate) / lifecycle (change) | B |
| DR20 | Format feature gate | the 10 predicates at `resumable-migration.mjs:128–249`; raw comparisons at `:642–657`, `:1629`, `:1723`, `:3234`, `:14273`; artifact gates at `artifact/artifact-migration.mjs` 201, 204, 205, 209, 1350, 1634, 1713, 1855, 1918, 1974, 2082, 2158, 2179, 2198, 2384, 2403, 2433, 2495, 2684, 2691, 2696, 2710, 3116, 3124, 3143, 3947, 4007, 4031, 4055, 4078, 4200, 4483, 4802, 4814, 4816, 4825; `formatVersion ?? 1` default written 20 times in the monolith | Yes | formats | A |
| DR21 | Confirmation id (first 16 hex chars of sha256 over JSON) | `resumable-migration.mjs:2242`, `upgrades/upgrade-migration.mjs:416` | Same construction, different input | leaf | A |
| DR22 | Lazy artifact-engine import | `resumable-migration.mjs:107`, `cli/toolkit-identity.mjs:72` | Yes | lifecycle | A |
| DR23 | Consumer receipt-folder name | `providers/install-support.mjs` 290, 394, 452; `scripts/runtime-bootstrap.mjs` 301, 477, 479, 554, 591, 599; plus 10 byte copies of `runtime.mjs` (`skills/*/scripts`, `providers/*/skills/*/scripts`) | Yes | transport/install | A (the park branch changes it) |
| DR24 | Record file-name and key constants | `STATE_FILE` at `artifact/artifact-migration.mjs:943` and `upgrades/upgrade-v4-to-v5.mjs:71`; `HISTORY_FILE` at `:945` / `:73`; `INTEGRITY_FILE` at `:944`, `resumable-migration.mjs:1499`, `upgrade-v4-to-v5.mjs:79`; `STEP_FILES` at `resumable-migration.mjs:1091` / `upgrade-v4-to-v5.mjs:40`; `IMMUTABLE_STEP_ARTIFACTS` at `:1151` / `:52`; `KNOWN_STATE_KEYS` at `resumable-migration.mjs:1192` / `artifact/artifact-migration.mjs:970` | Mixed | store (`KNOWN_STATE_KEYS` → formats) | A, or keep the upgrader frozen (Q5) |
| DR25 | Figma node-id pattern | `migration-utils.mjs:74`, `resumable-migration.mjs:8923` | — | visual | A |
| DR26 | `execFileAsync` | `migration-utils.mjs:25`, `discovery-scan.mjs:47`, `artifact/artifact-migration.mjs:225` | Yes | leaf | A |
| DR27 | "Was this file run as the command?" guard (rev 2, finding F2) | `engine-paths.mjs:38 isMainModule` (resolves the symlink with `realpathSync`; its own comment records the fix of nine fragile guards); `scripts/runtime-bootstrap.mjs:725` (compares `path.resolve(argv[1])` with `import.meta.url` and exits 0 doing nothing behind a symlink), copied byte for byte into 10 `runtime.mjs` files | **No** | transport/install | B |
| DR28 | Implicit module root per declared source (rev 2, finding I3) | `record-decision.mjs:594–600` (offer side); `resumable-migration.mjs:5728–5734` (`validateDiscoveryCompleteness`, the validation side). Both take the alphabetically first root whose basename matches the source name. | Yes | census | A (merge); B for I3 |

Excluded as **same name, different rule**, because they belong to different record kinds: `validateBaseline`, `validatePlan`, `validateTargetInventory`, `checkpointArtifacts`, `previewAdvance` (monolith vs artifact engine), `artifactOptions` (`mcp-server.mjs:173` vs `resumable-migration.mjs:7331`), `canonical` (`migration-utils.mjs:380` vs `artifact/artifact-migration.mjs:1022`), and `directive` (two CLIs).

---


---

## 4. Module dependency graph and layering (PROPOSAL)

**Base direction:** `transport → lifecycle → {middle tier} → store → formats → leaf`. Downward edges may skip layers.
**Nodes:** functions, classes and, new in revision 2, **values**, so a function that reads a constant owned by another module counts.
**Graph:** 3,370 declaration-level caller/callee pairs (2,774 local, 576 through a named import, 20 through a dynamic `import()`). 1,665 pairs cross a module boundary in (a), 1,662 in (b).
**Commands:** see the header. `--layer-order=w>x>y>z` sets the order inside the middle tier (each may call the ones to its right); without it every sibling edge is forbidden. `modgraph.mjs` refuses to run while a `LAYER_ORDER` environment variable is set, so a stale shell cannot change the rules.

### 4.0 Layering options (Q1)

| Option | Ownership | Middle-tier order | Violating pairs | Upward | Sibling | Decisions → siblings |
|---|---|---|---|---|---|---|
| **(a)** siblings forbidden | `owners.tsv` | none | **178** | 118 | 60 | 13 |
| **(b)** candidate builders move to the module that owns their facts; decisions keeps creation, grouping, the offer==accept predicate, relay and authority | `owners-b.tsv` | `slices > visual > census > decisions` | **134** | 118 | 16 | 10 |
| **(c)** best other order, with the (b) ownership | `owners-b.tsv` | `slices > census > visual > decisions` | 135 | 118 | 17 | 10 |
| for reference: best order with (a) ownership | `owners.tsv` | `slices > census > decisions > visual` | 137 | 118 | 19 | 7 |

All 24 orders of the middle tier were computed with the (b) ownership. **(b) is the minimum**; no other order gives fewer violations, so (c) is shown only for comparison.

**Recommendation (PROPOSAL): option (b).**
- It removes 44 violating pairs compared with (a). All of them are sibling edges; the 118 upward edges are the same under every option.
- **decisions remains the single owner of the offer and write predicates.** `decisionKindAllowed`, `decisionAppliesToCandidate`, `createDecisionCandidate`, `createNewFormatDecisionGroup`, `resolveGroupDecision`, the append writers, relay and authority all stay in decisions.
- The fact modules call down into decisions to *create* candidates. decisions never reads a fact module except through its projection.
- **Remaining work:** the 10 decisions → sibling pairs all come from the two projection aggregators. `record-decision.mjs:420 derivePendingDecisions` reads census, slices and visual facts; `artifact/artifact-migration.mjs:3133 artifactVisualDecisions` reads visual facts. In Track A3, both should receive those facts as input from lifecycle. That is a behavior-preserving parameterization.

Pair counts for (a) and (b). The first count of each pair is the first module calling the second; "—" marks a pair that is allowed under that option.

| Edge | (a) | (b) | Edge | (a) | (b) |
|---|---|---|---|---|---|
| slices → lifecycle | 28 | 28 | census → lifecycle | 23 | 23 |
| census → decisions | 13 | — | decisions → lifecycle | 11 | 11 |
| slices → census | 11 | — | visual → lifecycle | 9 | 9 |
| lifecycle → transport | 11 | 11 | store → lifecycle | 9 | 9 |
| decisions → transport | 8 | 8 | slices → visual | 6 | — |
| decisions → visual | 6 | 5 | visual → decisions | 5 | — |
| slices → decisions | 4 | — | decisions → census | 4 | 4 |
| store → visual | 4 | 4 | decisions → slices | 3 | 1 |
| visual → slices | 3 | 3 | store → census | 3 | 3 |
| formats → lifecycle | 3 | 3 | formats → transport | 3 | 3 |
| visual → census | 2 | — | census → slices | 2 | 2 |
| slices → transport | 2 | 2 | store → decisions | 2 | 2 |
| store → slices | 2 | 2 | census → visual | 1 | 1 |

lifecycle → transport rose from 9 to 11 in revision 2.1: `resumable-migration.mjs:6349 artifactBindingFor` destructures the transport functions `artifactArgumentsFor` and `artifactCommandFor` out of the lazy artifact-engine import (`:6350`), which revision 2 did not resolve.

**Cycles.** Under (b) the module graph is still **one strongly connected component**, covering every node except leaf; leaf now calls nothing. The direct 2-cycles are listed below, with the pair count in each direction:
- formats↔lifecycle 3/210, formats↔transport 3/16
- census↔lifecycle 23/51, census↔slices 2/12, census↔store 26/3, census↔decisions 13/4, census↔visual 1/2
- decisions↔store 12/2, decisions↔visual 5/5, decisions↔lifecycle 11/14, decisions↔transport 8/34, decisions↔slices 1/3
- lifecycle↔store 239/9, lifecycle↔transport 11/45, lifecycle↔visual 29/9, lifecycle↔slices 46/28
- slices↔store 55/2, slices↔visual 6/3, store↔visual 4/19

Every violating pair is listed in Appendix C: option (b) in full, option (a) as counts.

### 4.1 Purity of formats (step 4 acceptance)

Outgoing edges from formats under (b): **0 to store, 3 to lifecycle, 3 to transport**, and 0 to the middle tier. Each remaining edge has a justification:

| Edge | Why it remains | How Track A removes it |
|---|---|---|
| `artifact-migration.mjs:162 artifactFormatUpgrade → ARTIFACT_FORMAT_UPGRADERS`, `:200 artifactFormatAdmissible → ARTIFACT_FORMAT_UPGRADERS`, `resumable-migration.mjs:14677 assertNoPendingFormatUpgrade → FORMAT_UPGRADERS` | Each upgrader table mixes *which* format steps exist (formats) with *how* each runs (lifecycle write commands). | A2 splits the tables: formats keeps the eligibility table, lifecycle keeps the handler map. No behavior change. |
| `resumable-migration.mjs:632 upgradeCommandFor`, `:13342 toolkitAdoptCommand`, `artifact-migration.mjs:4720 assertArtifactToolkitIdentity` → `engineCommand` / `artifactIdentityCommand` | Refusal text embeds a rendered CLI command. | Return a typed remedy (`{command, args}`) and let transport render it. That changes message bytes, so it is a golden-trace change (Track B transport) unless the rendering is byte-identical. |


---

## 5. Findings mapped to their owning module

The supplied log defines **F1–F6, F8, I1–I8 and P1–P4**. H, M and W entries are stops, manual continues and workarounds, not findings. **It does not define D1, D2 or D3**, and neither does any other source on this machine, so they stay unmapped (Q4). Owners follow option (b). Track **A** = behavior-preserving; **B** = deliberate golden-trace change; **—** = no change proposed.

| ID | Finding (short) | Code evidence at BASE (file:line) | Owner | Track |
|---|---|---|---|---|
| F1 | Preflight tar fails on Windows when GNU tar is first on PATH | `scripts/runtime-bootstrap.mjs:171–191` (`tarCommand`, `extractArchive`). **Fixed in v1.3.19 = BASE**; the log observes PASS in later runs. | transport (install) | — (closed) |
| F2 | Preflight exits 0 and does nothing when run through the skill's symlinked directory | `scripts/runtime-bootstrap.mjs:725`: `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, copied into 10 `runtime.mjs` files. The engine already fixed the same guard in `packages/migration-engine/src/engine-paths.mjs:38 isMainModule` (`realpathSync`). Duplicate rule **DR27**. | transport (install) | B |
| F3 | A fresh consumer that still has an old toolkit registration cannot install; the refusal is untyped | `providers/install-support.mjs:188`, `:192` (`stale = previous && …`, so with no receipt nothing counts as stale), `:214` (`.agents/mcp.json`: `if (!previous) throw`). **Park fix B** (receipt-less adoption, `park/v1.3.20-rename` `3d63be7…`) addresses it; typed refusal codes are still missing. | transport (install) | B |
| F4 | `SHARED_PREREQUISITE` cannot be satisfied for a real shared component | `packages/migration-engine/src/resumable-migration.mjs:6522–6560` (in `validateCapabilityOwnership` :6444): each consumer must be in the pinned discovery *supporting* census of the migrating module; the contract example lists feature names | lifecycle | B |
| F5 | Legacy-runtime visual authority pinned with a dev overlay; no repair path | `resumable-migration.mjs:9528 validateLegacyRuntimeContext` (no overlay or shell-geometry check before pinning), `:9762–9765` (`PROVISIONAL_VISUAL_DIFF_THRESHOLDS` = 0.0005). **Closed by the user as a product decision** (use `target-system`). | visual | — (closed; B if reopened) |
| F6 | FINALIZE drift is BLOCKED with no relayable review; `autoResolvable` candidates are not auto-resolved | `cli/run-migration.mjs:124–125` (`UNCLAIMED_TARGET_DRIFT` listed as a terminal refusal) and `:407–412` (returns `BLOCKED` before the decision path at `:448`); `record-decision.mjs:467`/`:554` (references are built only for reviewed candidates); `record-decision.mjs:958` (AUTO gate) | decisions | B |
| F8 | Pinned `requiredObservations` do not match the real legacy runtime; no repair after the census | `resumable-migration.mjs:12875` and `:11858` (`--reopen-discovery` allowed only at `DISCOVERY_COMPLETENESS`); observations are validated at DISCOVER_LEGACY by `:3967 validateLegacyInventory` → `:4153 assertRequiredObservations` | census | B (new capability, needs a decision; Q8) |
| I1 | `run --json` prints a human summary to stdout before the JSON | `cli/discover-module.mjs:265` (`stdout.write(renderExecutionPreview(...))`), `:365` (`Resume guidance`); `cli/run-migration.mjs:287–291` (the JSON on the same stdout) | transport | B |
| I2 | A Next.js `error` boundary is scanned as UNREACHABLE | `discovery-scan.mjs:124–131` (`error` **is** in `NEXT_APP_FILES` at BASE); `:1504–1514` (auto-discovery covers only *tracked* script files). **Cause not reproduced at BASE**: the file was probably untracked, or the scan algorithm pinned at an older version. The repro comes first in Track B. | census | B |
| I3 | The canonical feature root needs a ROOT_DECLARATION while the route directory does not | `record-decision.mjs:594–600` and `resumable-migration.mjs:5728–5734`: the implicit root is the alphabetically **first** root whose basename equals the source name, so `src/app/…/<name>` wins over `src/features/<name>`. This is new duplicate rule **DR28**; the two copies agree today. | census | B |
| I4 | Step guidance asks for an explicit `tolerance`; the engine refuses one | `resumable-migration.mjs:2368`, `:2373` (`stepTemplates` text) vs `:9993–9995` (`VISUAL_TOLERANCE_FIXED`) | lifecycle (the text should come from visual's constant) | B |
| I5 | The operator review for a legacy-runtime record says "Figma evidence" | `resumable-migration.mjs:8992–8993` in `visualUnbackedCandidate` (:8983) | visual | B |
| I6 | A missing registry mapping shows up as a terminal `FAILED` in auto mode, and the remedy names an internal script | `resumable-migration.mjs:16727` (in `advanceUnderLock`): "Run update-migration-registry.mjs", whereas the installed executable is `artifact-migration-registry` | lifecycle | B |
| I7 | The shared `steps/06-implement-slices.md` must be COMPLETE before the first slice validates | `resumable-migration.mjs:3719–3723 assertStepDocumentComplete`, called from `:10346 validateStep` | lifecycle | B |
| I8 | `result.json` must carry `capabilityIds`, but the contract schema omits it | `resumable-migration.mjs:7096–7105 traceLists` (requires `capabilityIds` when `usesCapabilityOwnership`). The fix is to the contract text, or make the field optional. | slices | B |
| P1 | Pixel parity is impossible when the target design system replaces a legacy widget | `resumable-migration.mjs:9762–9765` (threshold) plus identical `{role,name}` multisets per frame. Closed together with F5. | visual | — (closed) |
| P2 | The target's own baseline is broken: committed tests import removed code | **No code owner**: this is the state of the consumer repository. Its toolkit-side consequence (a deleted file cannot be claimed or relayed) is covered by F6. | — | — |
| P3 | Required shared, config and test edits fall outside the slice `targetPaths` | `resumable-migration.mjs:10641 withinPlannedScope` and the `changedFiles` claims. The engine behaves as documented and the agent widened the paths at PLAN. | slices | — (as designed) |
| P4 | A slice's UI interactions land on routes owned by a later slice, so verification order and evidence freshness conflict | `resumable-migration.mjs:7121 validatePlan` does not check that a slice's interaction targets fall inside the slice or its `dependencies`; unclaimed files are refused only at FINALIZE (`:11247 assertNoUnclaimedTargetDrift`) | slices | B (new PLAN check, needs a decision; Q8) |
| Fix A | Reinstall runs as an update instead of throwing | `park/v1.3.20-rename`: `providers/install-support.mjs`, the hunk at old line 300 | transport (install) | B |
| Fix B | Receipt-less adoption of a registration identical to what the installer writes; addresses **F3** | the same commit, the hunk at old line 390, plus `moveLegacyFolder` | transport (install) | B |
| Q6 | Design source fixed for the record's lifetime; no supported reinit | `resumable-migration.mjs:2627 assertDesignSourceUnchanged`, applied at `:11717`, `:15427`; the artifact copy at `artifact/artifact-migration.mjs:4225–4235` (DR18). The log's Run 8 restarted the migration by hand, as an authorized shortcut. | visual (comparator) / lifecycle (reinit) | §6a |

New duplicate rule, added to §3:

| ID | Rule | Copies | Agree? | Owner | Track |
|---|---|---|---|---|---|
| DR28 | Implicit module root per declared source | `record-decision.mjs:594–600` (offer side); `resumable-migration.mjs:5728–5734` (`validateDiscoveryCompleteness`, the validation side) | Yes | census | A (merge) + B (I3 changes the choice) |


---

## 6. Golden-trace feasibility

**Does a recordable fixture migration exist? Yes, two of them, both synthetic. There is no recorded real-agent run.**
- `test/installed-full-lifecycle.test.mjs` (308 lines) builds the candidate release offline, installs it through `runtime.mjs ensure`, and authors every checkpoint artifact itself. It drives `artifact-migration-run auth --mode auto` through all 9 checkpoints to `COMPLETE`, including post-census `TARGET_DRIFT_ACCEPTED` relays (lines 231–245) and the IMPLEMENT changed-files path (line 299).
- `packages/migration-engine/test/fixtures/compatibility-record` together with `test/unit/live-history-replay.test.mjs` is a frozen record whose history replays to revision 61 at `COMPLETE` with 56 pins.
- A real-agent run (codex rehearsal on the notes fixture) is not in the repo. The rehearsal scratchpads are wiped, and the record directory alone is not enough to replay one: authored artifacts get overwritten across steps, and target code changes live in git. Recording one would need a wrapper that snapshots the record directory and the target diff before each `advance`.

**Can it replay without an LLM? Yes**, for the synthetic fixture. That is exactly what the test does today. A byte-stable trace needs these handled without an engine change:
- **Clock:** 28 `now()` calls in the monolith and 23 `new Date` / `Date.now` across the engine. No injection seam exists. Use a Node `--import` preload that fixes `Date`.
- **UUIDs:** 5 `randomUUID()` (temp names, transactions). Use the same preload.
- **Git:** fixture commits need `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` pinned so SHAs are stable.
- **Masking:** `process.pid` (15 sites, lock owners) and absolute temp paths in receipts and registry need normalizing.
- **Digests:** history hashes and integrity digests chain over timestamps, so masking alone is not enough. The clock has to be fixed, or every digest masked, which would weaken the trace.
- **Cost:** each run rebuilds the release (`buildRelease` + archive). That is the main input to the ≤ 10-minute budget, and it has not been measured yet.

**Which current defects would the golden trace lock in?** Only what the fixture exercises:
1. The receipt folder `.artifact-migration-tools/` (asserted at `test/installed-full-lifecycle.test.mjs:114`). Park fixes A/B change it, so they become a deliberate trace change in Track B.
2. **Group not offered after the census** (`pending.group === null`, lines 231–236). This locks the current offer predicate (DR10). Any decisions finding that changes group offers will change the trace.
3. Message texts and the outcome sequence, including the `Recorded AGENT_RELAYED APPROVED` wording (line 243).

**Not exercised, so the trace neither locks nor protects them:**
- the claim-spelling divergence (DR4): the fixture only uses `src`;
- non-durable ledger and history appends (DR7, DR8): not observable;
- design-source change (DR18);
- the `isWithin` variants (DR1);
- reinstall and receipt-less adoption (fixes A/B);
- the findings themselves: §5 maps F1–F6, F8, I1–I8 and P1–P4 to their owning module and track (B = a deliberate golden-trace change); D1, D2 and D3 are not defined (Q4).

**Consequence (PROPOSAL):** the golden trace is a regression net for the fixture's happy path, not proof that extraction preserved behavior. Each Track A phase also needs the adversarial fixtures listed in §7.6. The reviewer fixtures from v1.3.16–17 (path spellings, rework of a claimed file, edits after a claim) must be added before the slices phase.

---

## 7. Module quality contract (PROPOSAL; every item enforced in CI)

One script, `scripts/check-architecture.mjs`, built on the same TypeScript AST scan as `tools/` (the pinned `typescript@5.9.3` is already a dependency, so nothing is added). It runs inside the required Ubuntu job.

1. **Single public entry.** Each module is `packages/migration-engine/src/<module>/` with exactly one entry, `index.mjs`. CI fails when any file outside `<module>/` imports a path inside it other than `index.mjs`.
2. **No cross-module internal imports.** The same check, applied to dynamic `import()` too: `resumable-migration.mjs:107` and `cli/toolkit-identity.mjs:72` are dynamic today. `core.mjs` becomes a re-export of the `index.mjs` files only.
3. **Dependency direction.** A rank table lives in `OWNERSHIP.md`. CI fails on any upward or sibling edge between modules. It starts with a committed baseline of the 134 pairs of option (b) in Appendix C. That file may only shrink, and each Track A phase must take its own module's outgoing count to 0.
4. **One owner per guarantee.** `OWNERSHIP.md` has one row per guarantee: guarantee, owning module, public function, and adversarial test id. CI checks that each named module and test exists and that no guarantee appears twice. Mechanical gates back the rows:
   - fs write primitives only in `store/` and the committed allow-list (lock, journal, signer);
   - `formatVersion` and `uses*Format` only in `formats/`;
   - `completedSteps` / `"DISCOVERY_COMPLETENESS"` checks only in `decisions/` and `lifecycle/`;
   - `createHash` only in `shared/` (leaf).
5. **Boundary-only tests.** Test files import only `<module>/index.mjs`, `core.mjs` or a CLI binary. Checked by the same scan over `packages/migration-engine/test` and `test/`. Today 45 files would fail.
6. **One adversarial test per single-owner claim.** Every `OWNERSHIP.md` row names a test that attacks the claim: a write outside store is refused with zero mutation; an offered candidate the writer refuses fails; two path spellings of one claim classify identically. CI fails if the named test is missing or skipped.
7. **File size ceiling: 1,000 lines per source file** (`wc -l` in CI; tests exempt until the tests phase). Why 1,000:
   - 21 of the 27 engine files already fit.
   - The 6 that exceed are exactly the files that mix owners: `resumable-migration.mjs` 16,939, `artifact/artifact-migration.mjs` 4,847, `discovery-scan.mjs` 2,295, `record-decision.mjs` 2,063, `migration-utils.mjs` 1,713, `visual-evidence.mjs` 1,355.
   - A 1,000-line file fits in one agent read (the default window is 2,000 lines) with room for its imports, which suits a 45-minute review.

---


---

## 6a. Fixed design source (Q6): two options, no choice made

Both options **keep the rule that a record's design source never changes in place.** Neither adds an in-place switch.

| | Option 1: keep immutability, merge the comparator | Option 2: keep immutability, add a supported abandon/reinit path |
|---|---|---|
| Owner | **visual** (DR18) | **lifecycle** (record lifecycle command); visual unchanged |
| Scope | Replace the two comparisons with one function: `resumable-migration.mjs:2613 designSourceExplicit` + `:2627 assertDesignSourceUnchanged` (compares `figmaSourceKey` = kind#fileKey#nodeId), and the inline artifact copy at `artifact/artifact-migration.mjs:4225–4235` (compares `canonical(full objects)`). Adversarial tests on both record kinds, using the same Figma link written two ways. | A new journalled command under the module lock that **archives**, never deletes, the record and its OpenSpec spec; records a history event; leaves or clears the registry binding as decided (Q6b); and lets the next bootstrap choose a different design source. Also: a transport flag plus an MCP tool argument, a confirmation digest like the other destructive commands, a SKILL refusal-table row, and adversarial tests (crash mid-archive and recovery; the decision ledgers kept inside the archive; re-bootstrap with a different design source). It is today's manual Run 8 restart made into a command. |
| Golden trace | Changes only the message or the outcome for artifact records whose Figma links differ only in fields outside `figmaSourceKey` | Adds a new path; the existing trace is unchanged |
| Hours | **3 h** (2–4). Basis: two copies, one function, two tests, plus 1.5 h phase overhead counted once in Track B. | **12 h** (10–16). Basis: comparable lock-and-journal commands are `reworkSliceUnderLock` (`resumable-migration.mjs:12951`, 185 lines) and `reopenCompleteUnderLock` (`:15150`, 211 lines), plus flag, MCP, SKILL and test overhead at the same rates. |
| Requirement status | No new requirement (consolidation) | **A new capability.** It needs an explicit product decision. |


---

## 8. Phase list and estimates (PROPOSAL, recomputed)

**Same rates as revision 1:**
- **1.5 h fixed overhead per phase.** Measured: `engine:test` takes 10 min locally, `providers:test` about 35 min under WSL, the Ubuntu CI job about 13 min. Add the golden replay and the commit.
- **Moving code: 1,000 declaration-span lines per hour.** Assumed, not measured.
- **Inverting dependencies: 8 outgoing violating pairs per hour.** Assumed, not measured.
- **Review: 45 min per reviewed unit.**
- Ranges are ±25%.

**Inputs:** option (b) ownership with values as nodes (Appendix A, `data/owners-b.tsv`), and outgoing violations from `data/modgraph-b.txt`.

### Track A: behavior-preserving extraction (golden trace identical)

| Phase | Lines | Outgoing violations | Estimate | Calculation |
|---|---|---|---|---|
| A0 harness | — | — | **5 h** (4–6) | determinism seams (§6) + CI wiring |
| A1 store + leaf `shared/` | 2,067 + 618 | 20 | **6.7 h** (5–8) | 2.7 + 2.5 + 1.5 |
| A2 formats (includes splitting the upgrader tables, §4.1) | 1,848 | 6 | **4.1 h** (3–5) | 1.8 + 0.8 + 1.5 (revision 1: 13 h, cut by step 4) |
| A3 decisions (projection receives facts as input, DR9–DR11) | 3,911 | 29 | **9.0 h** (7–11) | 3.9 + 3.6 + 1.5 |
| A4 slices | 2,511 | 30 | **7.8 h** (6–10) | 2.5 + 3.8 + 1.5 |
| A5 census | 4,486 | 26 | **9.2 h** (7–12) | 4.5 + 3.3 + 1.5 |
| A6 visual | 3,605 | 12 | **6.6 h** (5–8) | 3.6 + 1.5 + 1.5 |
| A7 transport/install | 2,732 + 1,238 (install code) | 0 | **5.4 h** (4–7) | 2.7 + 1.2 + 1.5 |
| A8 lifecycle (residue) | 8,798 | 11 | **11.7 h** (9–15) | 8.8 + 1.4 + 1.5 |
| A9 instructions | — | — | **4.5 h** (3.5–6) | unchanged |
| A10 tests | 50,580 | — | **31 h** (25–40) | unchanged |
| **Track A** | | | **≈ 101 h ≈ 12.6 working days** | revision 1: 112 h |

PROPOSAL on order: option (b) puts decisions at the bottom of the middle tier, so the cheapest bottom-up order is **decisions → census → visual → slices**. The order you specified (decisions → slices → census → visual) also works, because modules not yet extracted stay in the monolith, but slices would then call into the monolith for census and visual facts for two extra phases. The hours are the same either way.

### Track B: one integral fix per owning module (each a reviewed golden-trace change)

| Owner | Fix contents | Estimate | Conditional (needs a decision) |
|---|---|---|---|
| transport (incl. install) | F2 (use the `isMainModule` logic in the bootstrap; DR27), F3 + Fix A + Fix B (rebase the park commit; add typed refusal codes), I1 (`--json` stdout carries JSON only) | **6 h** | — |
| census | I2 (reproduce, then fix), I3 + DR28 (one implicit-root rule, choosing the canonical feature root) | **4 h** | F8 repair path after the census: **+8 h** (Q8) |
| lifecycle | F4, I6, I7, I4, DR13 (one journal protocol) | **13.5 h** (3 + 2 + 2 + 0.5 + 6) | Q6 option 2, abandon/reinit: **+12 h** |
| decisions | F6 (drift candidates offered as relayable reviews; AUTO resolves the `autoResolvable` ones under offer==accept) | **4 h** | — |
| slices | I8 (contract or optional field), DR4 (one claim spelling) | **5 h** (1 + 4) | P4 PLAN check: **+3 h** (Q8) |
| visual | I5, DR18 (= Q6 option 1) | **4 h** (1 + 3) | — |
| store | DR7 / DR8 (one durable append, one atomic write) | **4 h** | — |
| leaf | DR1 (one `isWithin`) | **1 h** | — |
| reviews | 8 × 45 min | **6 h** | — |
| **Track B** | | **≈ 47.5 h ≈ 6 working days** | **up to ≈ 70.5 h ≈ 8.8 days with all three conditionals** |

**Release v1.4.0:** 2 h of agent time, plus the 3-provider real-use gate (1–2 h of your time).

**Program total:** ≈ **150 h ≈ 19 working days** (up to ≈ 173 h ≈ 22 days with the conditionals). The original plan said 22–28 h.

**What exceeds 5 working days:**
- the program as a whole;
- Track A (≈ 12.6 days);
- Track B with its conditionals (≈ 8.8 days);
- A10 tests at its upper bound (40 h = 5 days).

### 8.1 Core-first cut (PROPOSAL)

**Goal:** a real migration reaches COMPLETE with **0 shortcuts**: no workaround, no manual continue caused by the toolkit, and no edited state or config.

**Baseline:** the log's Run 7 (design source `target-system`) reached COMPLETE, but only with these shortcuts:
- W1/W2 (F3);
- a JSON parser (I1);
- an entry-point declaration (I2);
- a capability reclassified (F4);
- a manual registry step (I6);
- orphan tests restored instead of an unrecordable drift decision (F6);
- the preflight invoked through `.agents/` to avoid F2.

| Item | Owner | Hours | Why it is in the cut |
|---|---|---|---|
| A0 harness | — | 5 | Every fix below is a deliberate golden-trace change and needs a trace to change against |
| F2 + F3 + Fix A + Fix B + I1 | transport | 6 | removes W1/W2, the `.agents` invocation and the stdout parser |
| I2 | census | 2 | removes the hand-declared entry point |
| F4 + I6 | lifecycle | 5 | removes the reclassification and the manual registry continue |
| F6 | decisions | 4 | removes the orphan-test restore; drift becomes relayable |
| Reviews (4 units) | — | 3 | |
| Release (patch or minor) | — | 2 | real-use gate on the consumer afterwards (your time) |
| **Core-first total** | | **≈ 27 h ≈ 3.4 working days** (22–34) | |

The fixes go in place, in today's files, with no extraction first.
- **Conditional:** add P4 (+3 h) if the PLAN check is wanted, and F8 (+8 h) if the observations pinned at the census must be repairable. Either one is a new rule (Q8).
- **Left out, and why:**
  - I3 is a doubtful human stop, not a shortcut;
  - I4, I5, I7 and I8 are wording or contract text that forced no workaround;
  - all of Track A except A0;
  - the DR consolidations.
- **Order (PROPOSAL):** core-first runs **before** Track A. The golden trace Track A preserves is then re-recorded after the fixes, so no fix is done twice.


---

## 9. Open questions

- **Q1. Layering:** answered with a recommendation, option (b) (§4.0). Needs your OK.
- **Q2. The artifact sub-engine:** split by role (assumed here), or a 9th module `artifact/`?
- **Q3. The 85 leaf declarations** (70 functions, 15 values): a leaf `shared/` module below formats (assumed here), or put them in store?
- **Q4. D1, D2 and D3 are not defined in the supplied log** or anywhere else on this machine. What are they? Fixes A/B are kept as read in revision 1 (A = reinstall runs as an update; B = receipt-less adoption, which addresses F3).
- **Q5. `upgrades/upgrade-v4-to-v5.mjs`:** keep it as a frozen snapshot, or merge its copies (DR15, DR24)?
- **Q6. Design source:** option 1 (merge the comparator, 3 h) or option 2 (add abandon/reinit, 12 h)? Both keep immutability. **Q6b:** under option 2, should abandon clear the registry binding or keep it?
- **Q7.** Resolved: `docs/` in the repo.
- **Q8. New rules:** F8 (repair pinned observations after the census) and P4 (a PLAN check for interactions that cross slices). Approve or reject each one.


---

## Appendix A — Ownership map: all 1,202 owned declarations

Format: per file, `module (count): name:line`. **Bold** = exported; *italic* = value; `<module-init>` = the file's top-level statements (§2, R7). Source: `data/owners.tsv`, generated by `tools/assign.mjs`. Under option (b), four functions change owner; they are marked ⇢ with their (b) owner.

### `artifact/artifact-migration.mjs`

- **census** (42): loadStructuralParser:87, *COMPLETENESS_DISPOSITIONS*:98, *EXTERNAL_ELEMENT*:124, *CODE_FILE_EXTENSIONS*:223, hasExecutableCodeFiles:226, commandFile:229, *TARGET_COMPILER_SPECIFIERS*:240, resolveCompilerBinary:247, targetTypeScript:267, *metrics*:312, structuralParser:348, *STRUCTURAL_SCRIPT_EXTENSIONS*:355, targetProject:369, moduleSpecifiersIn:394, targetCodeFiles:438, **legacyDependencies**:473, *TEST_UNDER_SRC*:591, *FEATURE_INDEX*:593, *UI_TEXT_PROPS*:595, hardcodedUiText:600, **architectureFindings**:632, *PROVIDER_PATHS*:953, bindingInput:1153, sourcePathForId:1163, **artifactIdFor**:1172, assertDirectory:1233, isExcluded:1243, scopedManifest:1250, captureBinding:1287, sourcePathAtRoot:1304, targetPathsFor:1311, **resolveArtifact**:1314, validateEvidenceFile:2581, validateSourceEvidenceFile:2593, validateSourceInventory:2607, dispositionValidator:2742, packageNameOf:2778, validateExternalRequirements:2789, *SCANNER_REQUIREMENT_KEYS*:2818, sourceRequirements:2835, validateCompleteness:2860, validateTargetInventory:2966
- **decisions** (9): **artifactDecisionBoundTo**:1200, **artifactDecisionCandidate**:1208, artifactCandidateEvidence:1218, projectArtifactDecision:1618, consumedFrom:1622, verifyConsumedHistory:1632, artifactVisualDecisions:3133, **reconcileArtifactDecisions**:3931, **artifactOperatorDecisions**:4798
- **formats** (21): ***ARTIFACT_CONTRACT_VERSION***:126, ***ARTIFACT_FORMAT_VERSION***:127, ***ARTIFACT_FORMAT_SUPPORTED***:128, ***ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS***:129, ***ARTIFACT_WORKFLOW_VERSION***:130, ***ARTIFACT_RESOLUTIONS***:131, ***ARTIFACT_FORMAT_UPGRADE_FLOOR***:145, **artifactFormatUpgrade**:162, artifactFormatAdmissible:200, *FEATURE_FILE*:592, *QUERY_KEYS_FILE*:594, *STATE_FILE*:943, *INTEGRITY_FILE*:944, *HISTORY_FILE*:945, *TRANSACTION_FILE*:946, *KNOWN_STATE_KEYS*:970, *OPTIONAL_STATE_KEYS*:1001, validateBinding:1369, validateState:1388, replayToolkitIdentity:1564, **assertArtifactToolkitIdentity**:4720
- **lifecycle** (58): *PRESERVED_DISPOSITIONS*:115, ***ARTIFACT_FORMAT_UPGRADERS***:146, engineFault:303, startMetrics:320, **artifactMetrics**:329, asEngineFault:340, *EXECUTION_CAPABILITY*:731, *READ_ONLY_CAPABILITY*:732, *TRANSACTION_VERSION*:952, eventFor:1772, consumedAtCheckpoint:1794, initialArtifactState:1806, bootstrapEventInput:1839, *EMPTY_HISTORY*:1847, pristineFormatUpgrade:1849, validateTransactionInput:1905, assertTransactionReplayable:1972, assertKnownRecoveryPhase:2032, proveBootstrapTransaction:2078, proveFormatUpgradeTransaction:2118, proveAdvanceTransaction:2147, reconstructLegacyTransaction:2216, proveToolkitIdentityTransaction:2280, finishTransaction:2316, assertTransactionBoundToRecord:2355, recoverTransaction:2368, buildAdvanceTransaction:2397, **previewArtifact**:2428, createArtifactRecord:2475, **bootstrapArtifact**:2506, **previewArtifactFormatUpgrade**:2515, **upgradeArtifactFormat**:2541, validateBaseline:3211, validateGateEvidence:3698, ponytailTime:3713, validatePonytailEvidence:3721, validateFinal:3744, **checkpointArtifacts**:3892, validateCheckpoint:3923, runCheckpointValidation:4001, freshness:4116, **progressState**:4133, requestFor:4156, outcomeResult:4164, blockedArtifactResult:4185, locate:4193, assertInvocationMatches:4199, **getArtifactStatus**:4242, readArtifactStatus:4248, pinsFor:4374, pathsAfterCheckpoint:4400, nextState:4415, previewAdvance:4471, runArtifactIteration:4540, *CHECKPOINT_DECISION_PASSES*:4673, **runArtifact**:4675, **changeArtifactToolkitIdentity**:4738, **validateArtifactComplete**:4829
- **slices** (24): *JS_FILE_EXTENSIONS*:224, *execFileAsync*:225, assertMayExecute:734, execute:742, pathKey:770, executeTypeScriptValidation:772, executeNodeCheckValidation:820, executeValidator:837, hasCodeValidationCheck:842, targetManifest:865, *MANIFEST_DEPENDENCY_FIELDS*:873, assertTargetProvides:886, *PACKAGE_MANAGERS*:907, *SCRIPT_NAME*:908, packageScriptOf:910, executeGenericCheck:921, *RESOLUTION_KIND*:1007, validatePlan:3350, validateImplementation:3379, validateBoundTo:3473, validateVerification:3581, migrationChangedFiles:3733, diffEntries:4098, implementationCoversDrift:4106
- **store** (20): *STATE_ROOT*:942, fileHash:1015, secureHash:1016, **artifactRoot**:1189, semanticEvidence:1454, **artifactEvidenceDigest**:1459, immutableProjection:1462, pinDigest:1490, *HISTORY_EVENT_KEYS*:1506, historyEventExtraKeys:1517, readHistory:1528, integrityFor:1598, ledgerPrefixesFor:1607, revalidatePins:1722, validateIntegrity:1728, historyPrefixContent:1748, **readArtifactState**:1754, writeTransaction:2345, stateFileExists:2426, readJsonAt:2570
- **transport** (3): **artifactArgumentsFor**:1042, **artifactCommandFor**:1067, artifactIdentityCommand:4712
- **unassigned:leaf** (17): portable:1013, sha256:1014, canonical:1022, jsonBytes:1034, samePath:1035, isWithin:1071, exists:1078, plainObject:1087, exactObject:1094, arrayOf:1108, nonEmpty:1112, boolean:1118, versionOne:1122, unique:1125, sameMembers:1133, normalizeRelative:1141, jsonBytesEqual:2023
- **visual** (5): strictVisualState:3086, artifactVisualAuthority:3097, artifactUiInventory:3105, artifactVisualAcceptance:3115, validateArtifactVisualEvidence:3498

### `artifact/run-artifact.mjs`

- **transport** (5): **parseArtifactArguments**:29, **artifactDirective**:93, render:107, **runArtifactCli**:133, `<module-init>`:180

### `cli/advance-migration.mjs`

- **transport** (4): **parseAdvanceArguments**:27, directive:56, **runAdvanceCli**:65, `<module-init>`:162

### `cli/discover-module.mjs`

- **transport** (8): **normalizePonytailArgument**:36, sliceList:49, **parseDiscoverArguments**:61, **renderExecutionPreview**:143, renderSliceAmendment:164, directive:177, **runDiscoverCli**:197, `<module-init>`:381

### `cli/run-migration.mjs`

- **decisions** (3): pendingApprovals:163, **decisionCandidates**:174, operatorApproval:193
- **transport** (8): **parseRunArguments**:55, discoverArguments:108, advanceArguments:111, *TERMINAL_VALIDATION_REFUSALS*:124, **renderAuthoringRequest**:141, recordedPrefix:235, **runMigration**:244, `<module-init>`:569

### `cli/toolkit-identity.mjs`

- **transport** (6): *COMMANDS*:30, **parseToolkitIdentityArguments**:32, artifactEngine:72, reportChange:74, **runToolkitIdentityCli**:89, `<module-init>`:160

### `cli/update-migration-registry.mjs`

- **transport** (3): **parseRegistryArguments**:16, **runRegistryCli**:47, `<module-init>`:84

### `cli/validate-migration.mjs`

- **transport** (3): **parseValidateArguments**:12, **runValidateCli**:43, `<module-init>`:61

### `discovery-scan.mjs`

- **census** (41): *execFileAsync*:47, ***CENSUS_ALGORITHM_VERSION***:54, ***SUPPORTED_ALGORITHM_VERSIONS***:55, **DiscoveryScannerVersionError**:57, *SCRIPT_EXTENSIONS*:65, *STYLE_EXTENSIONS*:75, *ASSET_EXTENSIONS*:76, *DATA_EXTENSIONS*:93, *DOC_EXTENSIONS*:94, ***PROBE_EXTENSIONS***:97, ***VISUAL_KINDS***:108, ***PRODUCTION_REACHABILITY***:111, ***REACHABILITY_VALUES***:116, *NEXT_APP_FILES*:124, *NEXT_ROOT_FILES*:146, *TEST_PATTERN*:153, extensionOf:158, **kindOf**:160, isScript:172, isStyle:174, isParseable:176, **parserResolutionError**:198, **loadTypeScript**:218, gitList:226, ***CENSUS_COMMAND***:245, normalizeRoot:248, underRoot:264, assertNotSymlink:268, scriptEdges:289, *SCRIPT_UNIT_EXTENSIONS*:927, *STRUCTURAL_MAX_DEPTH*:941, **structuralUnits**:950, scriptExportNames:1137, *CSS_IMPORT*:1195, *CSS_URL*:1196, styleEdges:1198, isFirstPartySpecifier:1228, *FINDING_KINDS*:1235, *UNPROVEN_MODULE_EDGES*:1243, **runDiscoveryScan**:1249, **discoveryDigest**:2275
- **unassigned:leaf** (2): portable:156, isWithin:179

### `engine-paths.mjs`

- **formats** (2): ***engineScriptsRoot***:52, ***engineSkillRoot***:67
- **transport** (5): **isMainModule**:38, **skillRootFor**:55, **quoteCommandToken**:86, **engineArgv**:102, **engineCommand**:128

### `format-upgrade.mjs`

- **formats** (6): **nextIncrement**:25, **upgradeIsActive**:50, validPrerequisite:55, **classifyUpgrade**:72, **assertRegistryCoverage**:85, **upgradeProjection**:172

### `mcp-server.mjs`

- **decisions** (3): *CONFIRMATION_SCHEMA*:299, *ELICITATION_TIMEOUT_MS*:347, trustedDecisionRecorder:349
- **transport** (34): *SERVER_NAME*:63, *PROTOCOL_VERSIONS*:66, *JSON_RPC_PARSE_ERROR*:68, *JSON_RPC_INVALID_REQUEST*:69, *JSON_RPC_METHOD_NOT_FOUND*:70, *JSON_RPC_INTERNAL_ERROR*:71, *INPUT_SCHEMA*:79, *RUN_INPUT_SCHEMA*:103, *RELAY_TOOL*:145, *RELAY_INPUT_SCHEMA*:146, *ARTIFACT_INPUT_SCHEMA*:158, artifactOptions:173, *REFUSED_TOOLS*:183, *APPROVAL_SHAPED_KEY*:220, **approvalShapedArgument**:221, registryFor:228, readOnly:241, runArguments:244, **createSession**:284, runTool:392, *TOOLS*:447, *PROGRESS_TOOLS*:525, *TOOLS_BY_NAME*:527, descriptorOf:529, failure:535, success:541, *toolCalls*:546, callTool:547, callToolInContext:573, **handleMessage**:649, respond:684, answeredId:696, **serve**:718, `<module-init>`:780

### `migration-policy.mjs`

- **decisions** (1): **maySelfConfirm**:394
- **lifecycle** (2): ***MIGRATION_OUTCOMES***:406, **nextOutcome**:457
- **transport** (15): ***MIGRATION_MODES***:27, *MODE_MESSAGE*:29, *DISCOVER_USAGE*:31, *ARTIFACT_USAGE*:34, *RUN_USAGE*:37, hasLegacy:40, assertDesignSource:45, hasFigma:54, hasAddFile:57, *RUN_REFUSED_OPTIONS*:67, assertMode:84, assertStepName:90, **assertOptionCombination**:104, *EXIT_CODES*:422, **exitCodeFor**:438

### `migration-utils.mjs`

- **census** (1): **resolveLegacySources**:191
- **formats** (5): ***DESIGN_SOURCES***:65, *FIGMA_FILE_KEY*:71, *FIGMA_NODE_ID*:74, **assertFigmaSource**:83, **resolveDesignSource**:148
- **lifecycle** (2): **pendingTransactions**:1071, **assertNoPendingTransaction**:1104
- **store** (27): **atomicWrite**:245, resolveRegistryRoot:272, validateRegistry:288, **registryIdentity**:339, readProjectConfiguration:342, canonical:380, gitTopLevel:390, legacyInstalledProjectRoot:431, projectRootFor:451, readStateRegistry:471, stateRegistryFromCwd:513, stateRegistryFromCandidate:524, stateRegistryFromWorkspace:537, mismatch:563, **resolveRegistryPath**:568, **previewProjectRegistryBinding**:645, **persistProjectRegistryBinding**:690, **readRegistry**:702, **resolveModule**:721, nextRegistryDocument:1113, **previewRegistryUpdate**:1167, **renderRegistryPreview**:1216, registryJournalPathFor:1227, recoverRegistryJournal:1237, **updateRegistry**:1272, **fileContentIdentity**:1688, **fileContentIdentityMatches**:1697
- **transport** (4): doctorCheck:1357, *MINIMUM_NODE_MAJOR*:1372, existingKnowledgeRoot:1375, **runDoctor**:1390
- **unassigned:leaf** (41): *execFileAsync*:25, *SAFE_NAME*:26, ***PONYTAIL_TARGETS***:29, portablePath:34, comparablePath:36, samePath:41, isPonytailTarget:44, **assertPonytailTarget**:47, **assertSafeName**:56, assertPlainObject:197, isWithin:204, **assertSecurePath**:215, **gitRevision**:760, **dirtyManifest**:802, **committedChangesSince**:879, **headRevision**:915, **fileAtRevision**:933, **isAncestorCommit**:947, **commitsTouchingSince**:965, **commitsIntroducingBlob**:998, **assertProjectRootContainment**:1048, *TEXT_IDENTITY_EXTENSIONS*:1511, ***CONTENT_IDENTITY_TEXT***:1518, ***CONTENT_IDENTITY_BYTES***:1519, *IDENTITY_SCHEMES*:1521, *TAGGED_IDENTITY*:1526, *PREFIXED_DIGEST*:1527, *BARE_DIGEST*:1528, *CR*:1530, *LF*:1531, *TAB*:1532, *DEL*:1533, sha256Hex:1535, foldCrlf:1538, expandLf:1551, isTextContent:1572, **isTextIdentityEligible**:1591, **parseContentIdentity**:1602, **isContentIdentity**:1619, **contentIdentity**:1629, **contentIdentityMatches**:1657

### `module-lock.mjs`

- **lifecycle** (9): *LOCK_ROOT*:32, **lockPathFor**:34, sleep:42, **processAlive**:45, readOwner:56, reclaimStale:72, **acquireModuleLock**:92, **withModuleLock**:159, **writeJournalAtomic**:172

### `operation-sequence.mjs`

- **decisions** (10): ***OPERATION_SEQUENCE_KIND***:64, ***AMEND_SLICE***:67, nextExpected:75, memberFacts:86, addedFileFact:102, **deriveOperationSequence**:121, **challengeForOperationSequence**:243, **renderOperationSequence**:246, **authorizeOperationSequence**:293, **operationSequenceRunner**:352

### `operator-approval.mjs`

- **decisions** (10): **renderGroupBlock**:7, **renderCandidateBlock**:20, terminalDecisionRecorder:34, *AUTO_REASON*:37, *autoDecisionRecorder*:41, **recorderFor**:57, carryChannel:71, **moduleApprover**:74, **artifactApprover**:79, **approveWithOperator**:107

### `operator-signer-service.mjs`

- **decisions** (2): writeOperatorOnly:34, **runSignerService**:39
- **formats** (1): ***SERVICE_CONFIG_FILE***:32
- **transport** (1): `<module-init>`:73

### `operator-signer.mjs`

- **decisions** (20): ***PRODUCTION_ATTESTED_WRITES***:36, typed:40, **assertSignerOrigin**:43, assertOwnerOnly:52, **openSignerStore**:64, transaction:103, readLedgerNoFollow:110, **createOperatorSigner**:119, *ACTIVATION_KEYS*:335, **checkSignerActivation**:338, **readRootOwnedJson**:361, **readSignerActivation**:379, *HTML_ESCAPES*:391, **inertHtml**:393, *SECURITY_HEADERS*:398, *APP_JS*:410, *ENROLL_JS*:445, *SESSION_MS*:470, *BODY_LIMIT*:471, **startReviewCompanion**:480
- **formats** (2): ***ACTIVATION_MANIFEST_FILE***:37, *STORE_FILE*:38

### `operator-webauthn.mjs`

- **decisions** (21): ***ASSERTION_PROTOCOL***:15, *CHALLENGE_DOMAIN*:16, ***VERIFICATION_VERSION***:17, ***MAX_CHALLENGE_LIFETIME_MS***:18, ***COSE_ES256***:19, ***ATTESTED_ARTIFACT_KINDS***:21, *RECORD_KEYS*:23, *PAYLOAD_KEYS*:27, ***BINDING_KEYS***:32, *DIGEST*:33, *PROOF_KEYS*:35, **groupMembersDigestOf**:49, **assertionPayload**:52, **parseAssertionPayload**:78, **assertionChallenge**:87, **proofFromResponse**:91, **proofProblem**:106, responseFromProof:117, assertEs256:130, **verifyAssertionProof**:142, **verifyEnrollment**:172
- **unassigned:leaf** (6): *BASE64URL*:34, **sha256Digest**:37, **base64url**:39, exactKeys:40, nonEmpty:43, b64:44

### `record-decision.mjs`

- **decisions** (53): ***DECISION_KINDS***:107, **challengeFor**:128, ***APPROVAL_CHANNELS***:143, **channelOf**:145, **autoApprovalChannel**:159, **approvedByPhrase**:167, APPROVAL_EVIDENCE:170, GROUP_APPROVAL_EVIDENCE:178, ***APPROVAL_EVIDENCE_PHRASES***:186, operatorIdentity:260, ***rationaleDigestOf***:268, ***SIGNER_UNAVAILABLE***:271, blockedFor:273, *REVIEW_EFFECTS*:281, **reviewFor**:291, inertText:327, indentReview:331, renderEvidence:332, **renderDecisionReview**:339, **buildDecision**:357, derivePendingDecisions:420, decisionCheckpoint:753, *PROJECTION_PRECEDENCE*:762, decisionProjection:764, **pendingDecisionCandidates**:782, **projectDecisions**:802, moduleRecompute:822, **recordNewFormatDecisionGroup**:849, withOperatorApproval:902, **ledgerFileForChannel**:1044, appendDecisions:1047, **groupFactsDigest**:1075, ledgerHeadFor:1083, autoAuthorization:1102, appendGroupDecisions:1121, appendNewFormatGroupDecision:1179, **assertReviewedCandidateCurrent**:1218, approveDecisionGroup:1226, approveCandidate:1259, webauthnProtocol:1325, refused:1326, attestedRecompute:1328, attestedBinding:1344, **reviewAttestedCandidate**:1411, **beginAttestedDecision**:1420, **completeAttestedDecision**:1437, deriveArtifactDecisions:1510, *BOUND_TO_FIELDS*:1624, **auditDecisionLedger**:1632, groupFindings:1754, verifyRecord:1818, **reviewReference**:2011, **relayOperatorDecision**:2020
- **store** (1): appendDurably:1388
- **transport** (4): **parseDecisionArguments**:191, runArtifactDecisionCli:1547, **runRecordDecisionCli**:1892, `<module-init>`:2058

### `resumable-migration.mjs`

- **census** (35): **legacySourcesOf**:318, **isBrownfield**:326, *TARGET_STATES*:699, *UI_KINDS*:746, *UI_MISMATCH_DISPOSITIONS*:761, *UI_INTERACTIVE_KINDS*:775, *UI_CONDITIONAL_KINDS*:783, ***UI_RUNTIME_STATES***:846, assertLegacySourcesUnchanged:2660, assertLegacyDiscoveryChecklist:3874, assertTargetAssessmentChecklist:3912, validateLegacyInventory:3967, *CLASSIFICATION_SCOPES*:4888, *DISPOSITIONS*:4896, *DECISION_BACKED_DISPOSITIONS*:4904, *AGENT_DISMISSIBLE*:4914, **legacySourceBinding**:4927, assertRecordedScannerVersion:5429, **readCanonicalModuleBoundary**:5458, moduleRootPath:5558, moduleRootSource:5566, assertSourcedModuleRoots:5579, **sourceOfEvidence**:5641, assertLegacyEvidenceWithinBoundary:5652, **validateDiscoveryCompleteness**:5689, assertAdoptedTargetEvidence:6111, validateTargetInventory:6132, featureLocalPrefix:6285, isUnderFeature:6288, assertLegacyEvidenceAttributes:6626, assertDiscoveryUnchanged:11281, targetFeatureDirectory:11337, brownfieldTargetBlocker:11345, reopenDiscoveryUnderLock:12868, **previewDiscoveryScan**:15865
- **decisions** (67): **isAutoAuthority**:584, ***LATE_DECISION_KINDS***:1412, **decisionKindAllowed**:1413, assertLateDecisionsAreAppendable:1416, **decisionLineDigest**:4256, **decisionRationaleDigest**:4259, **lifecycleBinding**:4265, **edgeDecisionSubject**:4275, candidateHash:4278, **candidateDigestOf**:4286, **createDecisionCandidate**:4289, **createNewFormatDecisionCandidate**:4319, decisionGroupMemberFact:4325, ***DECISION_GROUP_KIND***:4334, *DECISION_MODULE_BINDING*:4336, groupMembersOf:4349, groupCandidateInput:4367, **decisionGroupFor**:4388, **createNewFormatDecisionGroup**:4417, **resolveGroupDecision**:4454, **decisionAppliesToCandidate**:4481, **rawDecisionLedgerDigest**:4514, **rawDecisionLedgerBytes**:4523, **decisionChannelOf**:4529, ***DECISION_PRINCIPALS***:4541, ***DECISION_RESULTS***:4546, *DECISION_V2_FIELDS*:4547, ***DEFAULT_DECISION_POLICY_ID***:4550, *JUDGMENT_KINDS*:4552, canonicalPolicy:4558, *STANDARD_LOCAL*:4562, ***DEFAULT_DECISION_POLICY_DIGEST***:4566, *LEGACY_DECISION_POLICY_ID*:4568, *LEGACY_DECISION_POLICY_DIGEST*:4569, policyPrincipal:4572, **principalSatisfiesRequirement**:4575, **validateProtectedDecisionPolicy**:4584, trustedPolicyFor:4632, **resolveRequiredPrincipal**:4666, **resolveHistoricalRequiredPrincipal**:4681, **decisionLineProblem**:4703, ***attestationVerifierScope***:4750, **attestedLineProblem**:4753, verifyAttestedLine:4762, **decisionPrincipalOf**:4778, readDecisionLedger:4796, **readOperatorDecisions**:4858, **readAutoDecisions**:4862, **readRecordedDecisions**:4875, requireDecision:4953, *consumedDecisionStore*:5061, consumedDecisionIdentity:5064, recordConsumedDecision:5074, applicableDecisionOutcome:5149, **resolveApplicableDecision**:5267, groupAuthorityFor:5292, requireModuleDecision:5342, **projectModuleDecision**:5372, moduleDecisionCandidate:5414 ⇢census, moduleEdgeTargetsFrom:5419 ⇢census, assertDirectLedgerClassificationSchema:5526, **pendingVisualUnbackedCandidates**:9021 ⇢visual, **pendingTargetDriftCandidates**:11204 ⇢slices, ***readMigrationContext***:11427, *SEQUENCE_AUTHORIZATION*:12216, **brandSequenceAuthorization**:12218, **sequenceAuthorizationEvidence**:12229
- **formats** (83): ***RESUMABLE_CONTRACT_VERSION***:110, ***MIGRATION_FORMAT_VERSION***:111, ***WORKFLOW_VERSION***:112, ***EARLIEST_SUPPORTED_FORMAT***:118, ***DISCOVERY_COMPLETENESS_FORMAT***:126, **usesDiscoveryCompleteness**:128, ***CAPABILITY_OWNERSHIP_FORMAT***:139, **usesCapabilityOwnership**:141, ***UI_VERIFICATION_FORMAT***:144, **usesUiVerification**:145, ***ARTIFACT_DELEGATION_FORMAT***:148, **usesArtifactDelegation**:149, ***DESIGN_SOURCE_FORMAT***:160, **usesDesignSource**:161, ***MULTI_SOURCE_FORMAT***:173, **usesMultiSource**:174, ***SLICE_REWORK_FORMAT***:196, **usesSliceRework**:197, ***VISUAL_ACCEPTANCE_FORMAT***:221, **usesVisualAcceptance**:222, ***REQUIRED_OBSERVATIONS_FORMAT***:231, **usesRequiredObservations**:232, ***DIRECT_LEDGER_DECISIONS_FORMAT***:248, **usesDirectLedgerDecisions**:249, ***MIGRATION_FORMAT_SUPPORTED***:260, ***FORMAT_ACTIVE_FOR_NEW_MIGRATIONS***:261, ***FORMAT_UPGRADE_FLOOR***:277, **isUiObservationsAdoption**:287, ***UI_OBSERVATIONS_ADOPTION_ROOT***:292, ***UI_OBSERVATIONS_CANDIDATE_FILE***:293, usesSourceAttribution:314, **assertDiscoveryCompletenessFormat**:341, *SELF_HEALING_FORMAT_VERSIONS*:443, ***NON_PROMOTING_FORMAT_VERSIONS***:469, *FORMAT_FEATURES*:487, **stampedFormatVersion**:500, ***SUPPORTED_FORMAT_VERSIONS***:514, **formatIsSupported**:522, **formatIsPromoting**:535, *ANCHORED_FORMAT_VERSION*:546, ***UPGRADABLE_CONTRACT_VERSION***:629, ***UPGRADABLE_FORMAT_VERSION***:630, **upgradeCommandFor**:632, **compatibilityBlocker**:640, ***MIGRATION_STEPS***:664, ***LEGACY_MIGRATION_STEPS***:677, **stepsFor**:686, *TARGET_ADOPTION_MODES*:742, ***UI_PROOF_FORMAT***:844, ***DISCOVERY_SCAN_FILE***:896, ***MODULE_CLASSIFICATION_FILE***:897, ***DECISIONS_FILE***:899, ***AUTO_DECISIONS_FILE***:915, ***CAPABILITY_OWNERSHIP_FILE***:916, ***UI_REMEDIATION_FILE***:917, ***FIGMA_CONTEXT_FILE***:922, ***VISUAL_ACCEPTANCE_FILE***:925, ***FIGMA_CONTEXT_ADOPTION_FILE***:929, ***LEGACY_RUNTIME_CONTEXT_FILE***:934, ***TARGET_BASELINE_FILE***:1089, *STEP_FILES*:1091, *KNOWN_STATE_KEYS*:1192, *INTEGRITY_FILE*:1499, requirementsSourceFor:1990, validateOpenSpecAuthorityShape:2050, *initialArtifacts*:2433, assertLegacyRevisionShape:2560, validateTargetAdoptionShape:2575, validateStateShape:2670, *PROTECTED_DECISION_POLICY_FILE*:4551, ***LEGACY_COMPATIBILITY_ACTION_REQUIRED***:5086, **LegacyCompatibilityActionRequired**:5089, ***MAX_SLICE_REWORKS***:8382, *TOOLKIT_IDENTITY_SCRIPT*:13340, **toolkitAdoptCommand**:13342, **assertRecordToolkitIdentity**:13354, **renderToolkitAdoption**:13411, **assertToolkitIdentityNotMismatched**:13429, ***DIRECT_LEDGER_PINNED_ARTIFACTS***:14267, **assertDirectLedgerEligible**:14272, **directLedgerAdoptionPreview**:14298, directLedgerAdoptionDigest:14308, **assertNoPendingFormatUpgrade**:14677
- **lifecycle** (108): artifactEngine:107, ***DEFAULT_MODE***:561, ***FINAL_GATES***:689, *TERMINAL_PARITY*:707, *PARITY_STATUSES*:726, *SLICE_EARNED_PARITY*:735, *BEHAVIOR_DISPOSITIONS*:860, *CAPABILITY_DISPOSITIONS*:878, *SHARED_CONSUMER_THRESHOLD*:892, ***ADOPTION_ROOT***:1071, ***STEP_DEPENDENCIES***:1103, briefDigestFor:1906, *OPEN_SPEC_REQUIREMENT*:1919, *OPEN_SPEC_SCENARIO*:1921, parseOpenSpec:1924, **loadOpenSpecAuthority**:2011, **validateOpenSpecProposal**:2034, assertCurrentOpenSpecAuthority:2091, legacyChecklistBlocker:2138, **activeArtifact**:2149, **expectedNextCheckpoint**:2158, **checkpointArtifacts**:2172, **checkpointAction**:2201, **authoringRequest**:2230, confirmationIdFor:2242, resumeGuidance:2248, renderStep:2264, stepTemplates:2292, *initialJsonArtifacts*:2450, createResolveStep:2501, *LEGACY_REVISION_LINE*:2557, *LEGACY_REVISION_SCOPE_LINE*:2558, *ADVANCE_JOURNAL*:2903, readAdvanceJournal:2905, assertRecovered:3477, **recoverMigrationRecord**:3488, recoverPendingAdvance:3506, assertStepDocumentComplete:3719, *PATH_CLAIM*:3741, evidencePathClaim:3743, resolveEvidencePath:3761, assertEvidenceResolves:3777, *EVIDENCE_CATEGORIES*:3803, *EVIDENCE_KINDS*:3808, *EVIDENCE_STATUSES*:3809, assertOpenSpecIds:3811, assertEvidenceChecklist:3821, assertCommandResults:3936, ***DECISION_PROJECTION_STATES***:5124, **artifactBindingFor**:6349, **validateArtifactDelegationRow**:6413, validateCapabilityOwnership:6444, validateAdoptedRow:6671, validateBaseline:6794, artifactOptions:7331, **artifactPrerequisiteWork**:7340, **assertArtifactPrerequisites**:7409, **delegatedChangedFilesSatisfiedByChild**:7417, assertPostAnchorEvidence:8599, *PONYTAIL_GATE_EVIDENCE*:8627, assertEvidenceReference:8657, assertEvidenceEntry:8683, pinnedInputTimestamps:8766, validateGates:8793, assertBriefUnchanged:8888, validateStep:10346, **previewMigrationExecution**:11429, **assertExecutionConfirmation**:12178, assertBoundInputsUnchanged:12475, initJournalFor:12510, ownerMatches:12517, writeOwner:12522, cleanupInitialization:12542, rollbackInitialization:12556, recoverInitialization:12591, commitInitialization:12612, **bootstrapMigration**:12749, visualContractAdoptionPlan:13255, **autoAdoptToolkitIdentity**:13385, **changeModuleToolkitIdentity**:13452, adoptVisualContractUnderLock:13545, uiObservationsAdoptionPlan:13728, combinedUiAdoptionPlan:13845, **previewUiObservationsAdoption**:13863, **adoptUiObservations**:13881, ***FORMAT_UPGRADERS***:14175, adoptDirectLedgerDecisions:14317, **pendingFormatUpgrade**:14420, **commitNoOpFormatUpgrade**:14564, **commitFormatUpgrade**:14704, reopenCompletePlan:15050, reopenAttemptsOf:15145, reopenCompleteUnderLock:15150, bootstrapUnderLock:15361, **getMigrationStatus**:15890, **validateResumableMigration**:16073, **previewAdvance**:16139, **renderAdvancePreview**:16239, ***CHECKPOINT_STATES***:16269, *STOPPING_OUTCOMES*:16279, **migrationProgress**:16286, *CHECKPOINT_MARKERS*:16406, **renderProgress**:16422, **renderProgressBlock**:16527, **renderProgressChecklist**:16550, previewProgress:16567, **advanceMigration**:16574, advanceUnderLock:16608
- **slices** (60): anySliceVerified:738, *TERMINAL_DESIGN_SYSTEM*:744, *NON_TERMINAL_CAPABILITIES*:886, ***TARGET_DIRTY_SCOPE***:1790, portableRoot:1794, baselineDirtyEntries:1797, **renderTargetBaseline**:1820, validateTargetBaselineShape:1836, targetBaselineDrift:1864, readTargetBaseline:1898, assertSliceStateConsistent:3710, rootRelativePath:6307, targetRelativePath:6331, legacyRelativePath:6340, traceLists:7096, assertCoversPlanned:7110, validatePlan:7121, assertCapabilityPlan:7252, governingReopen:7438, verifiedReopenRecord:7455, resolveReopenAnchor:7511, repoRelative:7553, *anchoredOwnershipCache*:7566, anchoredReopenOwnership:7568, resolveAnchoredOwnership:7584, validateImplementedSlice:7635, resolveChangedFile:7854, implementationDigests:7864, ***REWORK_ROOT***:8375, **reworkLimitBlocker**:8384, *REWORK_PATH*:8387, **reworkPathParts**:8390, reworkAttemptsOf:8397, preservedEvidencePath:8407, validateFailedSliceResult:8430, validateVerifiedSlice:8468, assertNoUnresolvedVerification:10452, assertGatesCoverSliceScenarios:10547, *DRIFT_OWNERSHIP_STEPS*:10596, *DRIFT_CLASSES*:10598, plannedTargetOwners:10627, withinPlannedScope:10641, canonicalClaim:10651, claimedTargetPaths:10659, *UNDERIVABLE_OWNERSHIP_REASON*:10681, classifyTargetDrift:10684, ***SLICE_AMENDMENT_ROOT***:10903, *ENGINE_SKILL_ROOT*:10906, *TEST_LEVEL_SUFFIX*:10911, targetRelative:10913, eventNamesSlice:10916, sliceAmendmentFor:10925, unlistedSliceFiles:11173, **unclaimedTargetDrift**:11235, assertNoUnclaimedTargetDrift:11247, **inspectSliceArtifacts**:12245, **reconcileSliceState**:12284, **repairSliceState**:12383, reworkSliceUnderLock:12951, amendSliceUnderLock:13136
- **store** (51): ***REOPEN_ROOT***:1080, ***BASELINE_ROWS_PIN***:1135, *IMMUTABLE_BEHAVIOR_ROW_FIELDS*:1136, ***DISCOVERY_PIN***:1149, *IMMUTABLE_STEP_ARTIFACTS*:1151, fileExists:1282, readJson:1292, hashFile:1309, fileIdentity:1320, fileIdentityMatches:1323, *DERIVED_PINS*:1331, pinnedSourcePath:1442, hashPinnedArtifact:1453, isBytePinned:1468, pinnedArtifactMatches:1482, digestArtifactHashes:1501, historyAnchorOf:1530, historyAnchorNow:1535, renderIntegrity:1542, decisionsAnchorNow:1572, autoDecisionsAnchorNow:1585, renderIntegrityNow:1598, readIntegrity:1609, assertIntegrityAnchor:1626, assertDecisionsAppendOnly:1702, assertHistoryAppendOnly:1721, assertUnanchoredHistoryTail:1757, resolveStepPins:1892, contentIdentityMatchesSource:2122, **migrationRoot**:2130, statePathFor:2133, renderState:2262, stateMappingMismatch:2649, **readState**:2915, assertStateGraph:2947, *HISTORY_HASH_DOMAIN*:3336, historyDigest:3337, keyOrder:3339, canonicalHistoryJson:3347, hashHistoryEvent:3355, prepareHistoryEvent:3360, appendHistory:3380, assertHistoryAppendable:3397, sealHistoryTail:3423, appendHistoryOnce:3455, readHistoryEvents:3574, completedArtifactHashes:3634, validateCompletedHashes:3667, readContext:11354, readOptionalJson:12240, removeEmptyParents:12455
- **transport** (2): ***BLOCKED_EXIT_CODE***:554, **renderLoopDirective**:611
- **unassigned:leaf** (15): recordRelative:1016, isPlainObject:1238, assertPlainObject:1241, assertArray:1246, assertNonEmpty:1251, assertBoolean:1258, assertUniqueIds:1263, isWithin:1274, hashContent:1916, now:2128, commonAncestor:3751, sha256Json:4556, assertIsoTimestamp:8635, withoutExtension:10912, sameFile:12532
- **visual** (54): usesVisualContract:299, *UI_UNREQUIRED_DISPOSITIONS*:769, *UI_VIEWPORT_STATES*:788, *UI_SECRET_KEY_PATTERN*:794, *UI_SECRET_VALUE_PATTERN*:800, assertNoUiSecret:804, uiBehaviorIsRequired:839, ***LEGACY_RUNTIME_EVIDENCE_ROOT***:939, *TARGET_EVIDENCE_ROOT*:940, ***LEGACY_AUTHORITY_ROLE***:950, ***TARGET_VERIFICATION_ROLE***:951, hardenedVisual:966, ***VISUAL_AUTHORITIES***:986, frameKeyOf:1012, assertCaptureRole:1032, assertTargetEvidencePath:1041, **visualAuthorityOf**:1054, *AUTHORITY_CONTEXT_FILES*:1057, pinsAuthorityContext:1068, designSourceExplicit:2613, figmaSourceKey:2617, assertDesignSourceUnchanged:2627, *OBSERVATION_EXPECTED*:4135, *OBSERVATION_FIELDS*:4143, **assertRequiredObservations**:4153, validateUiRuntimeEvidence:7883, **sliceLacksUiProofV1**:8538, completedSlicesLackingUiProofV1:8564, withUiProofReopenHint:8573, *FIGMA_NODE_ID*:8923, *FIGMA_SOURCE_KINDS*:8924, figmaNodeKey:8930, **figmaMetadataAncestry**:8938, ***VISUAL_UNBACKED_KIND***:8959, visualContractDigest:8962, visualUnbackedCandidate:8983, backedRowFor:9010, **validateFigmaContext**:9061, resolveStructuredFigmaFrame:9317, resolveFigmaFacts:9398, **validateLegacyRuntimeContext**:9528, *MAX_TOLERANCE_PX*:9759, *MAX_TOLERANCE_RATIO*:9760, ***PROVISIONAL_VISUAL_DIFF_THRESHOLDS***:9763, assertVisualCaptureBlock:9768, **compareVisualEvidence**:9802, **validateVisualAcceptance**:9889, **compareVisualFact**:10233, assertVisualAcceptance:10279, assertNoNavigationRepairNeeded:10514, reopenUiEligible:14758, reopenUiIneligible:14763, reopenUiNotApplicable:14776, reopenUiUnderLock:14786

### `toolkit-identity.mjs`

- **formats** (20): ***TOOLKIT_IDENTITY_KEYS***:37, ***BUILD_IDENTITY_FILE***:40, ***TOOLKIT_NAME***:42, *SEMVER*:48, *COMMIT_SHA*:50, *CONTENT_HASH*:51, **validateToolkitIdentity**:58, **toolkitIdentityKey**:87, **sameToolkitIdentity**:95, **digestToolkitIdentity**:102, **renderToolkitIdentity**:108, *cached*:119, **activeToolkitIdentity**:120, **resetActiveToolkitIdentity**:144, ***TOOLKIT_IDENTITY_EVENTS***:148, **toolkitIdentityBlocker**:163, parseToolkitVersion:190, isNewerToolkitVersion:209, **autoAdoptableToolkitTransition**:240, **toolkitIdentityStatus**:249

### `upgrades/upgrade-migration.mjs`

- **formats** (7): upgradesRoot:65, moduleUpgradeRoot:68, transactionRoot:74, classify:219, confirmationIdFor:416, **renderUpgradePreview**:433, **renderRollbackPreview**:755
- **lifecycle** (14): *contractPath*:51, ***TRANSACTION_STATES***:55, lockPathFor:71, readJournal:132, *writeJournal*:136, **recoverTransaction**:145, resolveContext:230, **previewUpgrade**:257, acquireLock:497, **executeUpgrade**:505, restorableUpgrade:648, **previewRollback**:671, **executeRollback**:766, **recoverUpgrade**:863
- **store** (7): exists:77, assertNoSymlink:87, readTree:98, manifestOf:113, writeTree:121, sameManifest:129, commitReplacement:453
- **transport** (3): **parseUpgradeArguments**:890, **runUpgradeCli**:928, `<module-init>`:995
- **unassigned:leaf** (1): sha256:63

### `upgrades/upgrade-v4-to-v5.mjs`

- **formats** (29): ***V5_CONTRACT_VERSION***:20, ***V5_FORMAT_VERSION***:21, ***V5_WORKFLOW_VERSION***:22, ***SOURCE_CONTRACT_VERSION***:24, ***SOURCE_FORMAT_VERSION***:25, ***V5_STEPS***:29, *STEP_FILES*:40, *IMMUTABLE_STEP_ARTIFACTS*:52, *TRACE_MATRICES*:64, *STATE_FILE*:71, *GATES_FILE*:72, *HISTORY_FILE*:73, *SLICE_INDEX_FILE*:74, *BRIEF_FILE*:75, *INTEGRITY_FILE*:79, renderJson:84, digestArtifactHashes:86, Blocked:100, block:102, parseJson:106, setMetadataLine:118, validateSource:125, traceOwners:195, splitTraceIds:215, withTraceFields:254, ponytailGapFor:276, nextActionFor:304, **validateV5State**:313, **upgradeV4ToV5**:392
- **unassigned:leaf** (2): sha256:81, isPlainObject:97

### `visual-evidence.mjs`

- **unassigned:leaf** (1): sha256:744
- **visual** (73): *require*:25, **decodePng**:27, **resampleTo**:38, **perceptualDelta**:75, **structuralDelta**:97, ***HARDENED_VISUAL_VERSION***:123, ***FIXED_VISUAL_TOLERANCE***:133, ***REQUIRED_FACTS***:150, ***REQUIRED_FACT_KINDS***:171, ***REQUIRED_FACT_NAMES***:176, **missingRequiredGroups**:185, VisualValueError:194, refuse:196, *COLOR_FACTS*:202, *LENGTH_FACTS*:203, ***GEOMETRY_FACTS***:221, *FONT_WEIGHTS*:223, hex2:224, normalizeColor:226, normalizeLength:260, *STROKE_SIDES*:280, *STROKE_FIELDS*:281, *SHADOW_FIELDS*:282, strokeRecord:285, shadowRecord:292, collapseWidths:300, strokeLength:307, strokeStyle:312, strokeRecordFrom:320, **strokeFromComputedStyle**:345, splitTopLevel:390, parseBoxShadow:408, shadowComponentFrom:429, **normalizeVisualValue**:450, *XML_ENTITIES*:542, **xmlAttribute**:545, escapeRegExp:551, ***FIGMA_PROVENANCE_KINDS***:554, dangling:560, **resolveMetadataFact**:569, **resolveMetadataAssets**:591, **resolveVariableDefsFact**:620, **resolveDesignContextFact**:648, **assertProvenancePrecedence**:686, **variableValueSet**:715, **structuredDigest**:747, readStructuredNode:754, freezeEvidence:776, **captureStructuredNode**:786, **structuredEvidenceDigest**:816, rgbaHex:829, paintColor:840, figmaFill:846, **figmaStroke**:865, **figmaShadows**:901, **extractStructuredFacts**:919, *CONTAINER_TEXT_TYPES*:1003, **structuredAssetIdentity**:1006, ***STRUCTURED_PROVENANCE_RANKS***:1028, *METADATA_PROPERTIES*:1033, *LITERAL_PREFIXES*:1034, **extractNodeLiterals**:1045, isCitedLiteral:1065, **resolveVisualProvenance**:1078, *STRUCTURAL_PROPERTIES*:1119, **deriveStructuredAuthority**:1122, **validateStructuredContract**:1210, flattenStroke:1258, compareStrokeFact:1263, **compareStructuredTarget**:1284, *STRUCTURED_REQUIRED*:1305, **structuredCapabilityProfile**:1316, **assertStructuredCaptureScale**:1340

## Appendix B — Filesystem write sites

### B.1 The 96 primitive fs mutation calls

| Site | Enclosing function | Call | Owner | Target-state note |
|---|---|---|---|---|
| `artifact/artifact-migration.mjs:2335` | `finishTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `artifact/artifact-migration.mjs:2398` | `buildAdvanceTransaction` | `mkdir` | lifecycle | **writes record bytes outside store**: route through store |
| `artifact/artifact-migration.mjs:2482` | `createArtifactRecord` | `mkdir` | lifecycle | **writes record bytes outside store**: route through store |
| `migration-utils.mjs:248` | `atomicWrite` | `mkdir` | store |  |
| `migration-utils.mjs:257` | `atomicWrite` | `open` | store |  |
| `migration-utils.mjs:258` | `atomicWrite` | `handle.writeFile` | store |  |
| `migration-utils.mjs:262` | `atomicWrite` | `rename` | store |  |
| `migration-utils.mjs:265` | `atomicWrite` | `unlink` | store |  |
| `migration-utils.mjs:1266` | `recoverRegistryJournal` | `unlink` | store |  |
| `migration-utils.mjs:1337` | `updateRegistry` | `unlink` | store |  |
| `module-lock.mjs:75` | `reclaimStale` | `rename` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:81` | `reclaimStale` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:98` | `acquireModuleLock` | `mkdir` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:119` | `acquireModuleLock` | `open` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:142` | `acquireModuleLock` | `handle.writeFile` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:152` | `acquireModuleLock` | `unlink` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:173` | `writeJournalAtomic` | `mkdir` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:175` | `writeJournalAtomic` | `open` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:177` | `writeJournalAtomic` | `handle.writeFile` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `module-lock.mjs:182` | `writeJournalAtomic` | `rename` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `operator-signer-service.mjs:35` | `writeOperatorOnly` | `open` | decisions | **not in store**: route through store |
| `operator-signer-service.mjs:36` | `writeOperatorOnly` | `handle.writeFile` | decisions | **not in store**: route through store |
| `operator-signer.mjs:74` | `openSignerStore` | `open` | decisions | signer store, exclusive create (DR12), so a store allow-list candidate |
| `record-decision.mjs:1062` | `appendDecisions` | `mkdir` | decisions | **not in store**: route through store |
| `record-decision.mjs:1063` | `appendDecisions` | `appendFile` | decisions | **not in store**: route through store |
| `record-decision.mjs:1390` | `appendDurably` | `mkdir` | store |  |
| `record-decision.mjs:1391` | `appendDurably` | `open` | store |  |
| `record-decision.mjs:1394` | `appendDurably` | `handle.write` | store |  |
| `record-decision.mjs:1396` | `appendDurably` | `handle.write` | store |  |
| `resumable-migration.mjs:3383` | `appendHistory` | `mkdir` | store |  |
| `resumable-migration.mjs:3384` | `appendHistory` | `appendFile` | store |  |
| `resumable-migration.mjs:3400` | `assertHistoryAppendable` | `mkdir` | store |  |
| `resumable-migration.mjs:3401` | `assertHistoryAppendable` | `open` | store |  |
| `resumable-migration.mjs:3443` | `sealHistoryTail` | `open` | store |  |
| `resumable-migration.mjs:3445` | `sealHistoryTail` | `handle.write` | store |  |
| `resumable-migration.mjs:3446` | `sealHistoryTail` | `handle.truncate` | store |  |
| `resumable-migration.mjs:3540` | `recoverPendingAdvance` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:3549` | `recoverPendingAdvance` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:3560` | `recoverPendingAdvance` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:3566` | `recoverPendingAdvance` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12451` | `repairSliceState` | `rm` | slices | **not in store**: route through store |
| `resumable-migration.mjs:12460` | `removeEmptyParents` | `rmdir` | store |  |
| `resumable-migration.mjs:12523` | `writeOwner` | `open` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12525` | `writeOwner` | `handle.writeFile` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12548` | `cleanupInitialization` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12551` | `cleanupInitialization` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12553` | `cleanupInitialization` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12570` | `rollbackInitialization` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12577` | `rollbackInitialization` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:12719` | `commitInitialization` | `link` | lifecycle | **writes record bytes outside store**: route through store |
| `resumable-migration.mjs:12727` | `commitInitialization` | `rename` | lifecycle | **writes record bytes outside store**: route through store |
| `resumable-migration.mjs:12731` | `commitInitialization` | `mkdir` | lifecycle | **writes record bytes outside store**: route through store |
| `resumable-migration.mjs:12738` | `commitInitialization` | `rename` | lifecycle | **writes record bytes outside store**: route through store |
| `resumable-migration.mjs:12740` | `commitInitialization` | `rm` | lifecycle | **writes record bytes outside store**: route through store |
| `resumable-migration.mjs:12927` | `reopenDiscoveryUnderLock` | `rm` | census | **not in store**: route through store |
| `resumable-migration.mjs:13118` | `reworkSliceUnderLock` | `rm` | slices | **not in store**: route through store |
| `resumable-migration.mjs:13227` | `amendSliceUnderLock` | `rm` | slices | **not in store**: route through store |
| `resumable-migration.mjs:13532` | `changeModuleToolkitIdentity` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:13699` | `adoptVisualContractUnderLock` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:13703` | `adoptVisualContractUnderLock` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:14143` | `adoptUiObservations` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:14144` | `adoptUiObservations` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:14148` | `adoptUiObservations` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:14389` | `adoptDirectLedgerDecisions` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:14647` | `commitNoOpFormatUpgrade` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:15003` | `reopenUiUnderLock` | `rm` | visual | **not in store**: route through store |
| `resumable-migration.mjs:15342` | `reopenCompleteUnderLock` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:15661` | `bootstrapUnderLock` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `resumable-migration.mjs:16929` | `advanceUnderLock` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:124` | `writeTree` | `mkdir` | store |  |
| `upgrades/upgrade-migration.mjs:125` | `writeTree` | `writeFile` | store |  |
| `upgrades/upgrade-migration.mjs:176` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:177` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:181` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:182` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:192` | `recoverTransaction` | `mkdir` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:193` | `recoverTransaction` | `rename` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:194` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:202` | `recoverTransaction` | `mkdir` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:203` | `recoverTransaction` | `cp` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:204` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:205` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:210` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:211` | `recoverTransaction` | `rm` | lifecycle | lock / journal / recovery, so a store allow-list candidate |
| `upgrades/upgrade-migration.mjs:470` | `commitReplacement` | `rename` | store |  |
| `upgrades/upgrade-migration.mjs:473` | `commitReplacement` | `rename` | store |  |
| `upgrades/upgrade-migration.mjs:486` | `commitReplacement` | `rm` | store |  |
| `upgrades/upgrade-migration.mjs:577` | `executeUpgrade` | `mkdir` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:578` | `executeUpgrade` | `cp` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:588` | `executeUpgrade` | `writeFile` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:598` | `executeUpgrade` | `writeFile` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:797` | `executeRollback` | `mkdir` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:799` | `executeRollback` | `cp` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:819` | `executeRollback` | `writeFile` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:824` | `executeRollback` | `cp` | lifecycle | **writes record bytes outside store**: route through store |
| `upgrades/upgrade-migration.mjs:826` | `executeRollback` | `writeFile` | lifecycle | **writes record bytes outside store**: route through store |

### B.2 Caller/wrapper pairs (66), by the caller's module

| Caller module | Wrapper | Calling declarations |
|---|---|---|
| census | `appendHistoryOnce` | `resumable-migration.mjs:reopenDiscoveryUnderLock`  |
| census | `atomicWrite` | `resumable-migration.mjs:reopenDiscoveryUnderLock`  |
| census | `writeJournalAtomic` | `resumable-migration.mjs:reopenDiscoveryUnderLock`  |
| decisions | `appendDurably` | `record-decision.mjs:completeAttestedDecision`  |
| decisions | `writeOperatorOnly` | `operator-signer-service.mjs:runSignerService`  |
| lifecycle | `appendHistoryOnce` | `resumable-migration.mjs:recoverPendingAdvance` `resumable-migration.mjs:changeModuleToolkitIdentity` `resumable-migration.mjs:adoptVisualContractUnderLock` `resumable-migration.mjs:adoptUiObservations` `resumable-migration.mjs:adoptDirectLedgerDecisions` `resumable-migration.mjs:commitNoOpFormatUpgrade` `resumable-migration.mjs:reopenCompleteUnderLock` `resumable-migration.mjs:bootstrapUnderLock` `resumable-migration.mjs:advanceUnderLock`  |
| lifecycle | `atomicWrite` | `artifact/artifact-migration.mjs:finishTransaction` `resumable-migration.mjs:recoverPendingAdvance` `resumable-migration.mjs:rollbackInitialization` `resumable-migration.mjs:commitInitialization` `resumable-migration.mjs:changeModuleToolkitIdentity` `resumable-migration.mjs:adoptVisualContractUnderLock` `resumable-migration.mjs:adoptUiObservations` `resumable-migration.mjs:adoptDirectLedgerDecisions` `resumable-migration.mjs:commitNoOpFormatUpgrade` `resumable-migration.mjs:reopenCompleteUnderLock` `resumable-migration.mjs:bootstrapUnderLock` `resumable-migration.mjs:advanceUnderLock`  |
| lifecycle | `commitReplacement` | `upgrades/upgrade-migration.mjs:executeUpgrade` `upgrades/upgrade-migration.mjs:executeRollback`  |
| lifecycle | `persistProjectRegistryBinding` | `resumable-migration.mjs:bootstrapUnderLock`  |
| lifecycle | `writeJournalAtomic` | `resumable-migration.mjs:commitInitialization` `resumable-migration.mjs:changeModuleToolkitIdentity` `resumable-migration.mjs:adoptVisualContractUnderLock` `resumable-migration.mjs:adoptUiObservations` `resumable-migration.mjs:adoptDirectLedgerDecisions` `resumable-migration.mjs:commitNoOpFormatUpgrade` `resumable-migration.mjs:reopenCompleteUnderLock` `resumable-migration.mjs:bootstrapUnderLock` `resumable-migration.mjs:advanceUnderLock` `upgrades/upgrade-migration.mjs:writeJournal`  |
| lifecycle | `writeOwner` | `resumable-migration.mjs:commitInitialization`  |
| lifecycle | `writeTransaction` | `artifact/artifact-migration.mjs:createArtifactRecord` `artifact/artifact-migration.mjs:upgradeArtifactFormat` `artifact/artifact-migration.mjs:runArtifactIteration` `artifact/artifact-migration.mjs:changeArtifactToolkitIdentity`  |
| lifecycle | `writeTree` | `upgrades/upgrade-migration.mjs:executeUpgrade`  |
| slices | `appendHistoryOnce` | `resumable-migration.mjs:repairSliceState` `resumable-migration.mjs:reworkSliceUnderLock` `resumable-migration.mjs:amendSliceUnderLock`  |
| slices | `atomicWrite` | `resumable-migration.mjs:repairSliceState` `resumable-migration.mjs:reworkSliceUnderLock` `resumable-migration.mjs:amendSliceUnderLock`  |
| slices | `writeJournalAtomic` | `resumable-migration.mjs:repairSliceState` `resumable-migration.mjs:reworkSliceUnderLock` `resumable-migration.mjs:amendSliceUnderLock`  |
| store | `appendHistory` | `resumable-migration.mjs:appendHistoryOnce`  |
| store | `atomicWrite` | `artifact/artifact-migration.mjs:writeTransaction` `migration-utils.mjs:persistProjectRegistryBinding` `migration-utils.mjs:recoverRegistryJournal` `migration-utils.mjs:updateRegistry`  |
| store | `persistProjectRegistryBinding` | `migration-utils.mjs:updateRegistry`  |
| store | `sealHistoryTail` | `resumable-migration.mjs:appendHistoryOnce`  |
| store | `writeJournalAtomic` | `migration-utils.mjs:updateRegistry`  |
| transport | `updateRegistry` | `cli/update-migration-registry.mjs:runRegistryCli`  |
| visual | `appendHistoryOnce` | `resumable-migration.mjs:reopenUiUnderLock`  |
| visual | `atomicWrite` | `resumable-migration.mjs:reopenUiUnderLock`  |
| visual | `writeJournalAtomic` | `resumable-migration.mjs:reopenUiUnderLock`  |

## Appendix C — Violating pairs

### C.1 Option (b), recommended: all 134 caller→callee pairs

The callee's file is omitted when it is the caller's file.

#### census->lifecycle (23)

- `artifact/artifact-migration.mjs:architectureFindings -> asEngineFault`
- `artifact/artifact-migration.mjs:legacyDependencies -> asEngineFault`
- `artifact/artifact-migration.mjs:sourceRequirements -> asEngineFault`
- `artifact/artifact-migration.mjs:structuralParser -> asEngineFault`
- `artifact/artifact-migration.mjs:targetProject -> asEngineFault`
- `artifact/artifact-migration.mjs:validateCompleteness -> asEngineFault`
- `artifact/artifact-migration.mjs:validateCompleteness -> engineFault`
- `artifact/artifact-migration.mjs:validateSourceInventory -> consumedAtCheckpoint`
- `resumable-migration.mjs:assertAdoptedTargetEvidence -> evidencePathClaim`
- `resumable-migration.mjs:assertAdoptedTargetEvidence -> resolveEvidencePath`
- `resumable-migration.mjs:assertLegacyDiscoveryChecklist -> assertEvidenceChecklist`
- `resumable-migration.mjs:assertLegacyEvidenceAttributes -> evidencePathClaim`
- `resumable-migration.mjs:assertLegacyEvidenceAttributes -> resolveEvidencePath`
- `resumable-migration.mjs:assertLegacyEvidenceWithinBoundary -> evidencePathClaim`
- `resumable-migration.mjs:assertLegacyEvidenceWithinBoundary -> resolveEvidencePath`
- `resumable-migration.mjs:assertTargetAssessmentChecklist -> assertEvidenceChecklist`
- `resumable-migration.mjs:reopenDiscoveryUnderLock -> module-lock.mjs:writeJournalAtomic`
- `resumable-migration.mjs:reopenDiscoveryUnderLock -> ADVANCE_JOURNAL`
- `resumable-migration.mjs:reopenDiscoveryUnderLock -> activeArtifact`
- `resumable-migration.mjs:validateDiscoveryCompleteness -> assertEvidenceChecklist`
- `resumable-migration.mjs:validateLegacyInventory -> assertEvidenceResolves`
- `resumable-migration.mjs:validateLegacyInventory -> assertOpenSpecIds`
- `resumable-migration.mjs:validateTargetInventory -> assertEvidenceResolves`


#### census->slices (2)

- `artifact/artifact-migration.mjs:legacyDependencies -> pathKey`
- `artifact/artifact-migration.mjs:validateExternalRequirements -> assertTargetProvides`


#### census->visual (1)

- `resumable-migration.mjs:validateLegacyInventory -> assertRequiredObservations`


#### decisions->census (4)

- `artifact/artifact-migration.mjs:artifactOperatorDecisions -> validateSourceInventory`
- `record-decision.mjs:derivePendingDecisions -> resumable-migration.mjs:legacySourceBinding`
- `record-decision.mjs:derivePendingDecisions -> resumable-migration.mjs:legacySourcesOf`
- `record-decision.mjs:derivePendingDecisions -> resumable-migration.mjs:previewDiscoveryScan`


#### decisions->lifecycle (11)

- `artifact/artifact-migration.mjs:artifactOperatorDecisions -> assertInvocationMatches`
- `artifact/artifact-migration.mjs:artifactOperatorDecisions -> freshness`
- `artifact/artifact-migration.mjs:artifactOperatorDecisions -> locate`
- `artifact/artifact-migration.mjs:artifactVisualDecisions -> consumedAtCheckpoint`
- `operation-sequence.mjs:deriveOperationSequence -> resumable-migration.mjs:previewMigrationExecution`
- `operation-sequence.mjs:operationSequenceRunner -> resumable-migration.mjs:assertExecutionConfirmation`
- `operation-sequence.mjs:operationSequenceRunner -> resumable-migration.mjs:bootstrapMigration`
- `operation-sequence.mjs:operationSequenceRunner -> resumable-migration.mjs:previewMigrationExecution`
- `record-decision.mjs:completeAttestedDecision -> module-lock.mjs:withModuleLock`
- `record-decision.mjs:withOperatorApproval -> module-lock.mjs:withModuleLock`
- `resumable-migration.mjs:isAutoAuthority -> DEFAULT_MODE`


#### decisions->slices (1)

- `record-decision.mjs:derivePendingDecisions -> resumable-migration.mjs:pendingTargetDriftCandidates`


#### decisions->transport (8)

- `artifact/artifact-migration.mjs:reconcileArtifactDecisions -> engine-paths.mjs:engineCommand`
- `mcp-server.mjs:trustedDecisionRecorder -> record-decision.mjs:runRecordDecisionCli`
- `operator-approval.mjs:autoDecisionRecorder -> record-decision.mjs:runRecordDecisionCli`
- `operator-approval.mjs:terminalDecisionRecorder -> record-decision.mjs:runRecordDecisionCli`
- `record-decision.mjs:derivePendingDecisions -> engine-paths.mjs:engineCommand`
- `record-decision.mjs:recordNewFormatDecisionGroup -> resumable-migration.mjs:BLOCKED_EXIT_CODE`
- `record-decision.mjs:relayOperatorDecision -> runRecordDecisionCli`
- `record-decision.mjs:withOperatorApproval -> resumable-migration.mjs:BLOCKED_EXIT_CODE`


#### decisions->visual (5)

- `artifact/artifact-migration.mjs:artifactVisualDecisions -> artifactUiInventory`
- `artifact/artifact-migration.mjs:artifactVisualDecisions -> strictVisualState`
- `artifact/artifact-migration.mjs:artifactVisualDecisions -> resumable-migration.mjs:pendingVisualUnbackedCandidates`
- `artifact/artifact-migration.mjs:artifactVisualDecisions -> resumable-migration.mjs:visualAuthorityOf`
- `record-decision.mjs:derivePendingDecisions -> resumable-migration.mjs:pendingVisualUnbackedCandidates`


#### formats->lifecycle (3)

- `artifact/artifact-migration.mjs:artifactFormatAdmissible -> ARTIFACT_FORMAT_UPGRADERS`
- `artifact/artifact-migration.mjs:artifactFormatUpgrade -> ARTIFACT_FORMAT_UPGRADERS`
- `resumable-migration.mjs:assertNoPendingFormatUpgrade -> FORMAT_UPGRADERS`


#### formats->transport (3)

- `artifact/artifact-migration.mjs:assertArtifactToolkitIdentity -> artifactIdentityCommand`
- `resumable-migration.mjs:toolkitAdoptCommand -> engine-paths.mjs:engineCommand`
- `resumable-migration.mjs:upgradeCommandFor -> engine-paths.mjs:engineCommand`


#### lifecycle->transport (11)

- `artifact/artifact-migration.mjs:initialArtifactState -> artifactCommandFor`
- `artifact/artifact-migration.mjs:outcomeResult -> migration-policy.mjs:exitCodeFor`
- `artifact/artifact-migration.mjs:readArtifactStatus -> artifactCommandFor`
- `artifact/artifact-migration.mjs:readArtifactStatus -> migration-policy.mjs:exitCodeFor`
- `artifact/artifact-migration.mjs:runArtifactIteration -> artifactCommandFor`
- `artifact/artifact-migration.mjs:runArtifactIteration -> artifactIdentityCommand`
- `artifact/artifact-migration.mjs:runArtifactIteration -> migration-policy.mjs:MIGRATION_MODES`
- `artifact/artifact-migration.mjs:runArtifactIteration -> migration-policy.mjs:exitCodeFor`
- `migration-utils.mjs:assertNoPendingTransaction -> engine-paths.mjs:engineCommand`
- `resumable-migration.mjs:artifactBindingFor -> artifact/artifact-migration.mjs:artifactArgumentsFor`
- `resumable-migration.mjs:artifactBindingFor -> artifact/artifact-migration.mjs:artifactCommandFor`


#### slices->lifecycle (28)

- `artifact/artifact-migration.mjs:assertMayExecute -> engineFault`
- `artifact/artifact-migration.mjs:execute -> engineFault`
- `artifact/artifact-migration.mjs:executeTypeScriptValidation -> asEngineFault`
- `artifact/artifact-migration.mjs:targetManifest -> asEngineFault`
- `artifact/artifact-migration.mjs:validatePlan -> validateBaseline`
- `resumable-migration.mjs:amendSliceUnderLock -> module-lock.mjs:writeJournalAtomic`
- `resumable-migration.mjs:amendSliceUnderLock -> ADVANCE_JOURNAL`
- `resumable-migration.mjs:amendSliceUnderLock -> activeArtifact`
- `resumable-migration.mjs:assertCapabilityPlan -> assertEvidenceResolves`
- `resumable-migration.mjs:repairSliceState -> module-lock.mjs:withModuleLock`
- `resumable-migration.mjs:repairSliceState -> module-lock.mjs:writeJournalAtomic`
- `resumable-migration.mjs:repairSliceState -> ADVANCE_JOURNAL`
- `resumable-migration.mjs:resolveChangedFile -> resolveEvidencePath`
- `resumable-migration.mjs:reworkSliceUnderLock -> module-lock.mjs:writeJournalAtomic`
- `resumable-migration.mjs:reworkSliceUnderLock -> ADVANCE_JOURNAL`
- `resumable-migration.mjs:reworkSliceUnderLock -> activeArtifact`
- `resumable-migration.mjs:reworkSliceUnderLock -> resolveEvidencePath`
- `resumable-migration.mjs:validateFailedSliceResult -> assertEvidenceReference`
- `resumable-migration.mjs:validateFailedSliceResult -> evidencePathClaim`
- `resumable-migration.mjs:validateImplementedSlice -> assertArtifactPrerequisites`
- `resumable-migration.mjs:validateImplementedSlice -> assertCommandResults`
- `resumable-migration.mjs:validateImplementedSlice -> delegatedChangedFilesSatisfiedByChild`
- `resumable-migration.mjs:validateImplementedSlice -> resolveEvidencePath`
- `resumable-migration.mjs:validatePlan -> TERMINAL_PARITY`
- `resumable-migration.mjs:validatePlan -> validateBaseline`
- `resumable-migration.mjs:validateVerifiedSlice -> assertCommandResults`
- `resumable-migration.mjs:validateVerifiedSlice -> assertPostAnchorEvidence`
- `resumable-migration.mjs:validateVerifiedSlice -> validateBaseline`


#### slices->transport (2)

- `resumable-migration.mjs:assertNoUnclaimedTargetDrift -> engine-paths.mjs:engineCommand`
- `resumable-migration.mjs:validateVerifiedSlice -> engine-paths.mjs:engineCommand`


#### store->census (3)

- `resumable-migration.mjs:completedArtifactHashes -> isBrownfield`
- `resumable-migration.mjs:readContext -> migration-utils.mjs:resolveLegacySources`
- `resumable-migration.mjs:resolveStepPins -> isBrownfield`


#### store->decisions (2)

- `artifact/artifact-migration.mjs:validateIntegrity -> verifyConsumedHistory`
- `resumable-migration.mjs:DERIVED_PINS -> assertLateDecisionsAreAppendable`


#### store->lifecycle (9)

- `artifact/artifact-migration.mjs:writeTransaction -> finishTransaction`
- `migration-utils.mjs:updateRegistry -> module-lock.mjs:withModuleLock`
- `migration-utils.mjs:updateRegistry -> module-lock.mjs:writeJournalAtomic`
- `resumable-migration.mjs:appendHistoryOnce -> readAdvanceJournal`
- `resumable-migration.mjs:assertIntegrityAnchor -> readAdvanceJournal`
- `resumable-migration.mjs:assertStateGraph -> readAdvanceJournal`
- `resumable-migration.mjs:isBytePinned -> ADOPTION_ROOT`
- `resumable-migration.mjs:readState -> migration-utils.mjs:assertNoPendingTransaction`
- `upgrades/upgrade-migration.mjs:commitReplacement -> writeJournal`


#### store->slices (2)

- `resumable-migration.mjs:isBytePinned -> reworkPathParts`
- `resumable-migration.mjs:validateCompletedHashes -> reworkPathParts`


#### store->visual (4)

- `resumable-migration.mjs:assertStateGraph -> pinsAuthorityContext`
- `resumable-migration.mjs:assertStateGraph -> usesVisualContract`
- `resumable-migration.mjs:completedArtifactHashes -> pinsAuthorityContext`
- `resumable-migration.mjs:completedArtifactHashes -> usesVisualContract`


#### visual->lifecycle (9)

- `resumable-migration.mjs:assertVisualAcceptance -> assertEvidenceReference`
- `resumable-migration.mjs:assertVisualAcceptance -> evidencePathClaim`
- `resumable-migration.mjs:assertVisualAcceptance -> resolveEvidencePath`
- `resumable-migration.mjs:reopenUiUnderLock -> module-lock.mjs:writeJournalAtomic`
- `resumable-migration.mjs:reopenUiUnderLock -> ADVANCE_JOURNAL`
- `resumable-migration.mjs:reopenUiUnderLock -> readAdvanceJournal`
- `resumable-migration.mjs:sliceLacksUiProofV1 -> evidencePathClaim`
- `resumable-migration.mjs:sliceLacksUiProofV1 -> resolveEvidencePath`
- `resumable-migration.mjs:validateUiRuntimeEvidence -> assertEvidenceReference`


#### visual->slices (3)

- `resumable-migration.mjs:assertNoNavigationRepairNeeded -> inspectSliceArtifacts`
- `resumable-migration.mjs:validateUiRuntimeEvidence -> implementationDigests`
- `resumable-migration.mjs:withUiProofReopenHint -> validateVerifiedSlice`

### C.2 Option (a): counts per module pair (178 in total). Pairs are in `data/modgraph-a.txt`.

- `census->decisions` 13
- `census->lifecycle` 23
- `census->slices` 2
- `census->visual` 1
- `decisions->census` 4
- `decisions->lifecycle` 11
- `decisions->slices` 3
- `decisions->transport` 8
- `decisions->visual` 6
- `formats->lifecycle` 3
- `formats->transport` 3
- `lifecycle->transport` 11
- `slices->census` 11
- `slices->decisions` 4
- `slices->lifecycle` 28
- `slices->transport` 2
- `slices->visual` 6
- `store->census` 3
- `store->decisions` 2
- `store->lifecycle` 9
- `store->slices` 2
- `store->visual` 4
- `visual->census` 2
- `visual->decisions` 5
- `visual->lifecycle` 9
- `visual->slices` 3

## Appendix D — Data files (`docs/architecture/phase0/data/`)

- `decls-05e6049.tsv`: every top-level declaration (file, line, E/I, kind, name, span); kind is fn, class, value, module-init or reexport.
- `writes-05e6049.tsv`, `imports-05e6049.tsv`, `fv-05e6049.tsv`: raw inventories (`inventory.mjs`).
- `edges.tsv`: declaration reference graph, 3,370 caller/callee pairs (`callgraph.mjs`; column 5 = reference count, column 6 = via: local, import, namespace or dynamic).
- `owners.tsv` / `owners-b.tsv`: owner per declaration for options (a) and (b) (`assign.mjs … a|b`; column 7 = kind).
- `writes-owned.tsv`, `wrapper-calls.tsv`: write sites with owners, and every caller of a curated write wrapper (`writesites.mjs`).
- `modgraph-a.txt` / `modgraph-b.txt`: layer order, module edges, violations, SCCs, 2-cycles, and sample pairs per option (`modgraph.mjs`).

## Appendix E — Tools (`docs/architecture/phase0/tools/`)

Read-only. Each tool reads git objects at a ref, loads the engine's pinned `typescript@5.9.3` from this checkout, and prints nothing unless it succeeds (exit 1 on a problem, 2 on a usage error).
- `analysis.mjs`: shared code: argument and TSV contracts, the module ranks, declaration identity, and one TypeScript program over the engine files at the ref.
- `inventory.mjs <repo> <ref> decls|writes|imports|fv`: AST inventories. `writes` resolves fs bindings by symbol, not by spelling, through imports, re-exports and `const` alias chains; `open` counts only when its flags allow writing; a FileHandle counts its write methods; writes to stdio file descriptors 0–2 are excluded.
- `callgraph.mjs <repo> <ref>`: references between top-level declarations, resolved by the TypeScript checker (lexical scope, aliases, re-export chains such as `core.mjs`), per declarator; top-level statements belong to `<module-init>`; member reads, destructuring and inline `.then` callbacks on a namespace or dynamically imported module are resolved.
- `assign.mjs <decls.tsv> a|b`: the frozen ownership table, for option (a) or (b). Exits 1 on any missing, duplicate or unknown declaration.
- `writesites.mjs owned <owners.tsv> <writes.tsv>` and `writesites.mjs wrapper-calls <owners.tsv> <writes.tsv> <edges.tsv>`: checked joins of write sites with owners, and of callers with the 13 curated write wrappers; fails if a wrapper is missing or reaches no write.
- `modgraph.mjs <owners.tsv> <edges.tsv> [--layer-order=w>x>y>z] [--samples]`: aggregates edges into module edges, marks violations against the layer ranks, and reports SCCs and 2-cycles. Refuses to run while `LAYER_ORDER` is set in the environment.
- `test/`: 62 tests (`node --test docs/architecture/phase0/tools/test/`), including byte-identity and superset checks against BASE.

### E.1 Analysis limitations

- **Fail closed.** A construct a tool cannot classify makes the run fail; it is never dropped silently. This covers default exports, top-level destructuring, syntax errors, unresolved relative specifiers and non-literal `import()` specifiers. In `writes` it also covers: `open` flags that are not literal (numeric values differ by platform); a write primitive or FileHandle used as a value; computed fs access; `require` or `import()` of fs; and a namespace or dynamic import of an engine module that exports an fs write alias or re-exports fs. In `callgraph` it also covers a module namespace, a loader returning one, or an object holding one when any of these: is passed on; is stored anywhere other than a binding or an object literal; is read by computed key; is consumed by a named or parameter-less `.then` callback; is returned from a class member; or is typed by JSDoc in a way that hides the module. None of these occur at BASE: every tool exits 0 there.
- **Not detected by design:** writes made by child processes, writes to non-fs streams (stdout, sockets, HTTP responses), and writes made inside third-party packages or Node built-ins other than fs (for example, the signer store's SQLite writes after `openSignerStore` creates the file).
- **References, not executions:** an edge means the caller's code mentions the callee, whether or not that line runs; `count` is the number of mentions.
- **Frozen ownership:** a new declaration, or top-level statements in a file without a `<module-init>` owner, make `assign.mjs` exit 1 until the table is updated. The layer ranks are fixed in `analysis.mjs`; only the middle-tier order is a parameter.

## Appendix F — Re-run outputs (M1, M4, M6c)

Re-run on 2026-10-10 for revision 2.1, from `docs/architecture/phase0/` with the commands in §1 (`BASE=05e604992f10b239753a74246a9ac5a45d9b2fed`, Node v26.8.2). All three match §1.

```text
$ git -C $R ls-tree -r --name-only $BASE packages/migration-engine/src | grep '\.mjs$' | while read f; do git -C $R show $BASE:$f; done | wc -l
36338
$ node $T/inventory.mjs $R $BASE imports | awk -F'\t' '$3 ~ /resumable-migration\.mjs$/ && $1!="core.mjs" {print $1}' | sort -u | wc -l
11
$ node $T/inventory.mjs $R $BASE imports | awk -F'\t' '$3 ~ /resumable-migration\.mjs$/ && $1!="core.mjs" {n=split($4,a,","); for(i=1;i<=n;i++) print a[i]}' | sort -u | wc -l
71
$ node $T/inventory.mjs $R $BASE fv | wc -l
51
```
