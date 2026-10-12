# Track A10 record: tests and the architecture gate

BASE `aaac8d3` (A9 merged; tree `001726b`, the tree that A9 candidate CI run 38279783473 tested green). A10 adds one engine-wide architecture gate, an ownership register, and the test changes below. It changes no production file: `git diff` touches nothing under `packages/migration-engine/src/`, `skills/`, `providers/`, `skills-lock.json` or `released-versions.json`, and no version.

Deliverables:
- `scripts/check-architecture.mjs`, the gate (`pnpm architecture:check`). CI runs it in Ubuntu shard 3.
- `test/architecture.test.mjs`, which proves that every rule can fail (`providers:test:3`).
- `OWNERSHIP.md` at the repository root: one owner per critical guarantee, and the dependency order.
- This record: inventory, enforcement, exceptions, adversarial matrix, baselines, CI, and remaining debt.

## Test inventory at BASE

Counts come from `git ls-tree aaac8d3`. Lines are `wc -l`.

| Area | Files | Lines |
|---|---|---|
| Suites (`*.test.mjs`, `*.spec.mjs`, `*.spec.ts`) | 47 | 51,736 |
| — engine `node:test` suites, `engine:test` | 35 | 46,079 |
| — engine Vitest specs, `engine:test:ts` | 2 | 1,167 |
| — root suites, `providers:test` | 10 | 4,490 |
| Support modules (`test/support/`, `integration/approval.fixture.mjs`, `integration/artifact/support/`) | 19 | 2,287 |
| Fixtures (`test/fixtures/compatibility-record/`) | 4 | 322 |
| Golden trace (`test/golden/installed-full-lifecycle.ndjson`) | 1 | 20 |
| **All test files** | **71** | **54,365** |

Phase 0 estimated about 50,580 test lines. The actual count at BASE is 54,365 in all files, or 51,736 in suites.

Registration at BASE:
- **Registered:** `engine:test` lists all 35 engine `node:test` suites once each. `vitest.config.ts` includes both `*.spec.ts` specs. `providers:test` lists all 10 root suites, and shards 1–3 partition it exactly.
- **Unregistered suites:** none.
- **Duplicated execution:** none. No support or fixture module is registered as a suite.
- **Identity passes:** the unidentified pass of `scripts/engine-test.mjs` runs `toolkit-identity.test.mjs` and `format-17-acceptance.test.mjs` serially, with no identity file. The identified pass then runs the other 33 suites with the real fixture `build-identity.json`. The Vitest run installs the same fixture identity (`support/vitest-identity.ts`). A10 changes neither runner.

Findings:
- **Module internals imported by tests:** none, at BASE or now. Every literal test import into `src/` named either a module `index.mjs` or a file outside the modules.
- **Historical facade imports:** 43 import statements in 25 test and support files took canonical names through the A1–A8 compatibility facades (`resumable-migration.mjs` 21, `artifact/artifact-migration.mjs` 8, `migration-utils.mjs` 5, and 9 others). A10 moved them; see "Test import boundaries".
- **Computed `import()` in tests:** 11 files. The A2–A8 architecture tests load every historical path by name to compare bindings. The installed-path tests load the engine from a built release.
- **Architecture tests at BASE:** A1-ARCH-1..3, A2-ARCH-1..4, A3-ARCH-1..4, A4-ARCH-1..5, A5-ARCH-1..7, A6-ARCH-1..7, A7-ARCH-1..9 and A8-ARCH-1..9, plus the A9 documentation checks in `test/providers-sync.test.mjs` and `test/provider-progress-parity.test.mjs`. All are kept unchanged.
- **Source-text assertions:** 14 suites read engine source (AST or text): the eight module architecture suites, plus `auto-authority`, `artifact-migration`, `discovery-scan`, `migration-contract`, `engine-paths` and `artifact-delegation`. None reads an empty facade. A8 retargeted the old-site guards to `lifecycle/` and `transport/` files, and a grep for facade paths in source reads finds none.
- **Platform skips:** POSIX-only symlink and permission cases (`transport` A7-ARCH-6, `bin-mappings`, `providers-sync` ×2, `runtime-bootstrap`) and one Windows-only case (`runtime-bootstrap` GNU tar). They run on the required Ubuntu shards.
- **Vacuous test:** `mcp-server.test.mjs` "the format-9 auth record is refused by scan and pending_decisions, unchanged" skipped on every run. It read a `sample-target-app/` record that is not in this repository: the 1 skip of BASE shard 3. A10 makes the record itself (see "Missing coverage added").
- **Duplicated helpers:**
  - `readJson`, `writeJson`, `snapshot`, `state` and `historyEvents` are each defined in 5–6 files;
  - `createFixture`, `scratch`, `parse`, `engineFiles` and `declared` in 7.

  They are not merged. Same-named helpers differ in contract: `historyEvents` in `approval.fixture.mjs` counts lines, while the one in `migration-contract` parses events. A shared module would change what each suite asserts.
- **Slow or duplicated setup:**
  - `engine:test` stages a real release build twice in its unidentified pass. That is serial on purpose (one `dist/`).
  - The provider and installed-lifecycle suites build and install real releases per provider and scope.
  - Each runner copies the tree once (`scripts/test-isolation.mjs`).

  No setup is repeated without purpose, so A10 leaves the runners as they are.
- **Test files above 1,000 lines:**

  | File | Lines |
  |---|---|
  | `migration-contract.test.mjs` | 20,831 |
  | `artifact-migration.test.mjs` | 5,792 |
  | `run-migration.test.mjs` | 1,619 |
  | `mcp-server.test.mjs` | 1,447 |
  | `providers-sync.test.mjs` | 1,334 |
  | `discovery-scan.test.mjs` | 1,315 |
  | `operator-approval-authority.integration.spec.mjs` | 1,145 |
  | `record-decision.test.mjs` | 1,068 |
  | `format-17-acceptance.test.mjs` | 1,045 |
  | `journal-recovery.integration.spec.ts` | 1,022 |

  See "Size and runtime baselines".

## Test organization and ownership

| Directory | Holds | Runner |
|---|---|---|
| `packages/migration-engine/test/unit/` | Module suites, the A1–A8 architecture suites (`store-shared`, `formats`, `decisions`, `slices`, `census`, `visual`, `transport`, `lifecycle`), and the lifecycle contract suites | `engine:test` (identified, except `toolkit-identity`) |
| `packages/migration-engine/test/integration/` | Approval authority, signer, delegation, direct ledger. The `artifact/*.spec.ts` specs | `engine:test` / `engine:test:ts` |
| `packages/migration-engine/test/external/` | Installed bins, rendered paths, format-17 acceptance against a staged release, visual authority proof | `engine:test` (`format-17-acceptance` unidentified) |
| `packages/migration-engine/test/support/` | Fixtures and helpers, never run as suites (A10-TEST-2) | — |
| `packages/migration-engine/test/fixtures/` | The committed format compatibility record (`live-history-replay`, `record-decision`) | — |
| `test/` | Provider generation, installation, runtime bootstrap, release discipline, installed lifecycle, rehearse CLI, architecture gate | `providers:test:1..3` |
| `test/golden/` | The 20-step installed-lifecycle trace | `pnpm rehearse`, `pnpm rehearse:negative` |

Ownership of guarantees is in `OWNERSHIP.md`. Each row names one owning module and the tests that attack it. A10-OWN-1 checks that every referenced test exists, is registered, and carries that exact title.

## Architecture enforcement

`scripts/check-architecture.mjs` parses every engine file, provider file and test file with the engine's pinned `ts-discovery-compiler` (TypeScript 5.9.3), which is the parser the A1–A8 tests use. Nothing new is installed. Static imports, re-exports and literal dynamic `import()` are all edges.
- A dynamic import is held to the same rules as a static one.
- A computed `import()` is a violation in engine source.
- In tests, a computed `import()` is allowed only in a listed file.

Each violation prints one line, and the process exits 1:

```
[A10-ARCH-2] transport/run.mjs:1: import -> lifecycle/record.mjs: outside lifecycle/, import lifecycle/index.mjs
```

| Rule | Enforces |
|---|---|
| A10-ARCH-1 | Each of the nine modules has an `index.mjs` that only re-exports its own flat files |
| A10-ARCH-2 | Outside a module, only its `index.mjs` is named (exception EXC-BIN). Every package bin is a known executable facade |
| A10-ARCH-3 | Every engine file has a tier (`TIERS`; unlisted = violation). Edges go strictly down: transport → lifecycle → slices → visual → census → decisions → store → formats → shared, with root files placed between (`OWNERSHIP.md`) |
| A10-ARCH-4 | No static or lazy file cycle (Tarjan over both graphs). No computed engine import |
| A10-ARCH-5 | Facades declare nothing (except EXC-DOCTOR). A module export has one live definition; a same-named declaration elsewhere must be a listed different rule |
| A10-ARCH-6 | Provider trees carry only `install.mjs`, `install-support.mjs` and `runtime.mjs` byte copies of the bootstrap. Installers import only `node:` builtins and `install-support.mjs`. No provider file equals an engine file |
| A10-ARCH-7 | Diagnostics name rule, file:line, edge and remedy (tested through the API and the CLI) |
| A10-SRC-1 | Filesystem mutation primitives are imported only by the 24 pinned files, each with its exact primitives (`FS_WRITERS`) |
| A10-SRC-2 | Only `transport/entry.mjs` calls `isMainModule`. Exactly the 11 installed executables call `startCommand`, once each |
| A10-SIZE-1 | No engine file over 1,000 lines unless pinned, and no pinned file grows |
| A10-TEST-1 | Tests import no module internal and no historical facade (except `FACADE_TESTS`). Computed imports only in `COMPUTED_IMPORT_TESTS` |
| A10-TEST-2 | Every suite is registered exactly once in its runner. No support module is a suite. Unidentified suites are registered. Specs stay under Vitest |
| A10-OWN-1 | `OWNERSHIP.md`: unique guarantees, one existing owner each, at least one adversarial test each. Every test reference here and there resolves |

Every table in the checker is exact: a stale row fails as well as a new edge. Each rule's failure is proved by `test/architecture.test.mjs`, which applies one edit to a copy of the gate's inputs and expects that rule, file and edge (27 cases).

The per-track tests stay where they were. They hold the finer module rules: exact export lists, BASE arities, binding identity, lazy optional dependencies, lock and recorder text, MCP authority. A10 consolidates nothing that they check differently, and removes no assertion.

### Critical source guards

| Guard | Where |
|---|---|
| Filesystem write ownership | A10-SRC-1 (new); A1-ARCH-2 (`shared/` writes nothing, `formats/` touches no file) |
| Lock and journal ownership | A8-ARCH-6, plus A10-SRC-1 for the primitives |
| Format-version predicate ownership | A2-ARCH-3 |
| Decision recording authority, ledger appends | A8-ARCH-7, A3-ARCH-1/2, A6-ARCH-7, A5-ARCH-7 |
| Candidate equality validation | `decisions.test.mjs` "A3: under the lock only the deep-equal reviewed candidate is writable, at the same principal" |
| No transport-level approval bypass | A7-ARCH-7 |
| No domain imports from transport | A10-ARCH-3, A7-ARCH-3 |
| No duplicated command entry logic | A10-SRC-2, A7-ARCH-4 |
| No engine implementation in provider trees | A10-ARCH-6; `providers-sync` "no provider tree carries engine source, engine tests, or a skill package manifest" |

## Boundary exceptions

Each exception is named in the checker, bounded to the files listed, and fails when stale.

| Name | Scope | Contract |
|---|---|---|
| EXC-BIN (`BIN_FRONTS`) | The 9 bins that front a transport command may import `transport/entry.mjs` plus their one command file. `record-decision.mjs` and `operator-signer-service.mjs` may import `transport/entry.mjs` only. | A7: a bin never loads another command's transport file |
| EXC-DOCTOR (`FACADE_DECLARES`) | `migration-utils.mjs` declares `runDoctor`, `doctorCheck`, `MINIMUM_NODE_MAJOR`, `existingKnowledgeRoot` | The installed runtime bootstrap imports `runDoctor` from this path (A7, A8) |
| `SAME_NAME_OTHER_RULE` | 9 names: the frozen v4 upgrader's private v4 vocabulary (6), `confirmationIdFor` (module checkpoint vs format upgrade), `validateLegacyInventory` and `validateTargetInventory` (lifecycle wrappers over census) | A2, A5, A8 |
| `FS_WRITERS` | 24 files: `store/` (4), the `decisions/` ledger append and protected-policy read, 14 `lifecycle/` lock and journal files, two fd-1 `writeSync` sites, the signer and its host | A1, A3, A7, A8 |
| `OVERSIZED_SOURCES` | 7 files, pinned at their BASE length | No-growth policy below |
| `FACADE_TESTS` | `formats.test.mjs` (A2-ARCH-4 bindings); `artifact-migration.test.mjs` and `operator-approval-authority.integration.spec.mjs` (the artifact engine path's own surface: no approve export, no removed constant) | The facade is the subject |
| `COMPUTED_IMPORT_TESTS` | 7 architecture suites; `visual-authority-proof`, `history-crash.mjs`, `migration-contract` and `installed-full-lifecycle`, which load from a built release or a bin path | The loaded path is the subject |
| EXC-BOOTSTRAP | `scripts/runtime-bootstrap.mjs` may make computed `import()` calls (`runDoctor` from the verified release) | A7 install boundary |

There is no allow-all exception.

The package `exports` keeps `./src/*` because installed bins, the runtime bootstrap and older receipts resolve historical paths through it. That is a public installed contract, not a source-boundary exception. The gate governs engine source and tests, not consumers.

## Test import boundaries

All 43 facade imports in 25 test and support files now name the canonical entries. The move was mechanical: an AST script resolved each imported name through the facade's own re-export chain to the module `index.mjs` that exports it, and rewrote the import into one import per entry. Local names are unchanged; the two renamed historical names become `artifactCheckpointArtifacts as checkpointArtifacts`.
- The bindings are the same objects: the A1–A8 COMPAT tests (`A*-ARCH-5`, A2-ARCH-4) assert that facade and entry export the same binding.
- Facade coverage is unchanged, because those tests still load every facade.
- No engine export was added for tests.

What stays, on purpose:
- Installed executables (`cli/*`, `mcp-server.mjs`, `record-decision.mjs`, `artifact/run-artifact.mjs`, `upgrades/upgrade-migration.mjs`), because their path is the subject.
- `core.mjs`, the package's `.` export.
- The live root files: `toolkit-identity.mjs`, `engine-paths.mjs`, `operator-signer.mjs`, `operator-webauthn.mjs`, `operation-sequence.mjs`, `operator-signer-service.mjs`.
- The `FACADE_TESTS` cases above.

AST inspection of internals (the A1–A8 suites, `auto-authority`, `engine-paths` R-1) reads source text. It does not import internals as a runtime API.

## Adversarial coverage matrix

The "Runs in" column names the runner and Ubuntu shard. Every row existed at BASE except row 20's second test, which skipped on every BASE run and runs since A10. Every test ran green in A9 candidate CI run 38279783473 (tree `001726b`), except that skipped case. The A10 candidate run is in the final report. A10-OWN-1 resolves each reference below.

| # | Area | Test | Expected refusal / preserved invariant | Runs in | New in A10 |
|---|---|---|---|---|---|
| 1 | Unsafe write outside owned root | `packages/migration-engine/test/unit/store-shared.test.mjs` › "store: atomicWrite refuses a symlinked path with zero mutation and leaves no temp file behind" | "escapes the target repository"; the victim file is unchanged; no temp file | engine:test (3) | no |
| 2 | Symlink or traversal escape | `packages/migration-engine/test/unit/store-shared.test.mjs` › "store: readTree refuses a symlink anywhere in the tree"; `packages/migration-engine/test/unit/discovery-scan.test.mjs` › "a symlink under an owned root is rejected, not followed"; `packages/migration-engine/test/unit/migration-contract.test.mjs` › "an owner that escapes the target repository is refused" | Refused, not followed | engine:test (3) | no |
| 3 | Corrupted history or integrity digest | `packages/migration-engine/test/unit/store-shared.test.mjs` › "store: the history chain verifies, and a one-byte edit, a reorder or a forged head is refused"; `packages/migration-engine/test/integration/artifact/journal-recovery.integration.spec.ts` › "a truncated history file is refused"; `pnpm rehearse:negative` history-byte | Refused at verification | engine:test, engine:test:ts (3); rehearse:negative (2) | no |
| 4 | Stale confirmation | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "P1-4: swapping the resolved legacy root invalidates the confirmation"; `packages/migration-engine/test/unit/registry-resolution.test.mjs` › "changing the proposed OpenSpec makes the prior confirmation stale" | The old confirmation id no longer matches; nothing executes | engine:test (3) | no |
| 5 | Candidate changed after review | `packages/migration-engine/test/unit/decisions.test.mjs` › "A3: under the lock only the deep-equal reviewed candidate is writable, at the same principal"; `packages/migration-engine/test/integration/operator-signer.integration.spec.mjs` › "module 19: signed REJECTED blocks only that candidate digest and a stale review writes nothing" | No append for a changed candidate | engine:test (3) | no |
| 6 | Forged or mismatched operator principal | `packages/migration-engine/test/integration/operator-approval-authority.integration.spec.mjs` › "no fabricated, unbound, stale or mismatched ledger line authorizes a checkpoint"; `packages/migration-engine/test/integration/operator-signer.integration.spec.mjs` › "module 19: forged, edited, unclaimed and duplicated attested lines are refused on read" | Checkpoint stays blocked; line refused on read | engine:test (3) | no |
| 7 | Approval-shaped MCP bypass | `packages/migration-engine/test/integration/operator-approval-authority.integration.spec.mjs` › "R-W2-e: no argv option, environment variable, or tool argument can produce an approval"; `packages/migration-engine/test/unit/mcp-server.test.mjs` › "no sequence of tool calls appends to the operator decisions ledger" | `JSON_RPC_INVALID_REQUEST` naming the argument and the operator command; ledger unchanged | engine:test (3) | no |
| 8 | Interrupted journal transaction | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "P1-3: an interrupted transition is completed deterministically on the next command"; `packages/migration-engine/test/integration/artifact/journal-recovery.integration.spec.ts` › "recovers an advance interrupted at ${phase}, producing the exact same record" | Deterministic completion to the same bytes | engine:test, engine:test:ts (3) | no |
| 9 | Repeated crash recovery | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "R-W6-e: a crash between the state write and the history append recovers idempotently"; `packages/migration-engine/test/unit/migration-contract.test.mjs` › "FU-4: a crash after the state write recovers forward to exactly one event" | Recovering again appends nothing | engine:test (3) | no |
| 10 | Invalid checkpoint transition | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "P1-1: a hand-edited currentStep contradicts the append-only history"; `packages/migration-engine/test/integration/artifact/journal-recovery.integration.spec.ts` › "a forged event.to that disagrees with the proposed state's currentStep is refused" | Refused against history | engine:test, engine:test:ts (3) | no |
| 11 | Source revision drift | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "external consumer proof refuses changes after the pinned legacy revision"; `packages/migration-engine/test/integration/artifact/journal-recovery.integration.spec.ts` › "a consumed approval never overrides subsequent source drift" | Refused or STALE; the approval does not carry over | engine:test, engine:test:ts (3) | no |
| 12 | Missing structural census element | `packages/migration-engine/test/unit/artifact-migration.test.mjs` › "completeness with an undeclared structural unit is refused" | DISCOVERY_COMPLETENESS refused | engine:test (3) | no |
| 13 | Unclaimed target drift | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "R-W4-a: an unclaimed modified target file blocks FINALIZE by name" | FINALIZE blocked, naming the file | engine:test (3) | no |
| 14 | Stale visual evidence | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "UI-9: changing an owning slice file narrowly stales its UI evidence"; `packages/migration-engine/test/unit/migration-contract.test.mjs` › "visual-17: persisted Figma evidence that changed after it was hashed is stale" | Evidence STALE; it does not back acceptance | engine:test (3) | no |
| 15 | Wrong design-source authority | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "figma-mcp: the design source and its links are fixed for the migration's lifetime"; `packages/migration-engine/test/unit/migration-contract.test.mjs` › "legacy-17: --design-source legacy-runtime refuses --figma links"; `packages/migration-engine/test/unit/visual.test.mjs` › "A6: each design source pins only its own authority context, and target-system pins none" | Refused; the pins stay disjoint | engine:test (3) | no |
| 16 | Corrupted format-upgrade record | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "FU-14: past the boundary, absent or corrupt authority is BLOCKED and still frozen"; `packages/migration-engine/test/integration/artifact/journal-recovery.integration.spec.ts` › "refuses a forged confirmation journal without changing any record bytes" | BLOCKED or refused; record bytes unchanged | engine:test, engine:test:ts (3) | no |
| 17 | Identity mismatch or unverified release | `packages/migration-engine/test/unit/toolkit-identity.test.mjs` › "a different build is refused by every mutating entry point, before any write"; `test/provider-installation.test.mjs` › "SHA256SUMS disagreeing with the release manifest fails closed"; `pnpm rehearse:negative` state-commit, event-identity | Refused before any write | engine:test (3, unidentified pass); providers:test:2; rehearse:negative (2) | no |
| 18 | Provider receipt or configuration tampering | `test/provider-installation.test.mjs` › "ownership, checksums, symlinks and config conflicts fail closed"; `test/provider-installation.test.mjs` › "${provider}: without a receipt, a modified, foreign-store or unowned-file registration fails closed and writes nothing" | Fails closed, writes nothing | providers:test:2 | no |
| 19 | Installed CLI symlink invocation | `packages/migration-engine/test/external/bin-mappings.test.mjs` › "each bin does real work when invoked through its symlink"; `packages/migration-engine/test/unit/transport.test.mjs` › "A7-ARCH-6: all ten bins keep their paths, shebangs and startup, and answer the same through a symlink" | Same output through the symlink (POSIX; Ubuntu runs it) | engine:test (3) | no |
| 20 | Historical format compatibility | `packages/migration-engine/test/unit/migration-contract.test.mjs` › "FU-11: the historical adoption spelling stays valid forever"; `packages/migration-engine/test/unit/mcp-server.test.mjs` › "the format-9 auth record is refused by scan and pending_decisions, unchanged"; `test/provider-installation.test.mjs` › "v1.0.0 stores without a mode or SHA256SUMS remain valid, updatable and removable" | Old spellings stay valid; a pre-10 record is refused through MCP with nothing read or written | engine:test (3); providers:test:2 | **the MCP case now runs** |

### Missing coverage added

- **MCP refusal of a pre-10 record.**
  - Before: the CLI path was covered ("every auxiliary discovery entry point refuses a format-9 record, touching nothing"). The MCP case depended on an absent `sample-target-app/` record and skipped on every run.
  - Now: it builds a format-9 record from a driven fixture with `downgradeToFormat9`, which moved verbatim from `migration-contract.test.mjs` to `test/support/downgrade-format9.mjs`. The assertions are unchanged: both tools are refused with "format-10 operation" and "Nothing was read or written", and the record bytes are unchanged.
- **The architecture gate and its 27 failure cases** (`test/architecture.test.mjs`).

No other matrix row lacked a test. Nothing was invented: each reference above resolves to a registered test with that exact title (A10-OWN-1).

## Golden and negative regression

- `test/golden/installed-full-lifecycle.ndjson` is unchanged and was not regenerated.
- `pnpm rehearse` matches all 20 steps.
- `pnpm rehearse:negative` refuses `history-byte`, `state-commit`, `event-identity` and `state-after-stdout`, each at its verification stage, with the messages pinned in `scripts/rehearse-negative.mjs`.
- No normalization was added, and the clock, UUID, Git and release-identity checks are unchanged.

## Size and runtime baselines

Engine source files above 1,000 lines, pinned at BASE size (A10-SIZE-1, no growth):

| File | Lines | Owner and why it stays |
|---|---|---|
| `census/scan.mjs` | 2,314 | The discovery scanner, one parser pass (A5) |
| `decisions/record.mjs` | 1,642 | Ledger read, validation and append (A3) |
| `lifecycle/validation.mjs` | 1,583 | Module checkpoint validators, incl. A4/A5 seams (A8) |
| `lifecycle/artifact-checkpoints.mjs` | 1,358 | Artifact checkpoint validation and dispatch (A8) |
| `visual/evidence.mjs` | 1,355 | Visual evidence normalization and comparison (A6) |
| `lifecycle/record.mjs` | 1,059 | Pins, anchor, append-only checks, advance journal (A8 store seam) |
| `visual/authority.mjs` | 1,004 | Design-source authority and Figma context (A6) |

Splitting them is a separately reviewed implementation task. The other 112 engine files are under 1,000 lines.

No test file is split. The ten test files over 1,000 lines (inventory above) each carry one contract with shared expensive fixtures. Splitting `migration-contract.test.mjs` would duplicate its `createFixture`/`driveTo` setup across `node --test` processes, and would gain no focused execution that `--test-name-pattern` does not already give.

Local runtimes (WSL2, this tree):

| Command | Time |
|---|---|
| `pnpm engine:test` | 7 m 06 s (35 + 1,009 tests, 0 skipped) |
| `pnpm engine:test:ts` | 33 s (69 tests) |
| `pnpm architecture:check` | about 1 s |
| `test/architecture.test.mjs` | about 18 s |
| `pnpm providers:test` | 25 m 16 s (168 tests: BASE 137 + 31 architecture; 1 Windows-only skip) |
| `pnpm rehearse` | 16.5 s (release build 2.7 s) |

On Ubuntu CI, the full matrix takes about 13 min per shard. No runner changed:
- the two identity passes stay sequential;
- `--test-concurrency=1` stays on the provider and unidentified passes;
- nothing was mocked or skipped.

## CI integration

`.github/workflows/ci.yml` gains one step, "Check the engine architecture", which runs `pnpm architecture:check` in Ubuntu shard 3, before the engine suites. Its tests run in `providers:test:3`, and the shards still partition `providers:test` exactly. Unchanged:
- the provenance job and its tested-tree reuse rules;
- the required check `toolkit (ubuntu-latest)` and the three shard names;
- the golden and negative replay in shard 2;
- the engine and TypeScript suites in shard 3;
- the partition and R-1 scans;
- the disabled Windows job.

## Preserved historical behavior

No production file changed, so no behavior changed. The guards:
- every A1–A9 architecture and documentation test passes unchanged;
- the golden trace and the four negatives;
- `pnpm providers:check`.

`skills/`, `providers/`, `skills-lock.json`, `release-identity.json` and `released-versions.json` are unchanged, and so are both package versions (1.3.19). The A9 skill hashes are untouched. Existing discrepancies stay as tests capture them:
- A9 D1 (Node doctor);
- D2 (schema anchors);
- the Track B items.

## Remaining architectural debt

- **The A8 owners-b seams:** 119 rows homed in `lifecycle/` that another module owns by rule (`docs/architecture/a8-ownership.md`). The gate pins the current direction; it does not claim these seams are gone.
- **Seven oversized source files** (above).
- **Same-name different-rule pairs** (`SAME_NAME_OTHER_RULE`): consolidating them is a behavior review.
- **`FS_WRITERS` outside `store/`:** the decision ledger append (DR7/DR8) and the journals (DR13) are Track B.
- **Track B:** DR1, DR4, DR13, DR18, I3/DR28, I4, I7, I8, P4; A9 D1–D10.
- **Windows CI:** disabled for Track A; re-enabling it is outside A10.
