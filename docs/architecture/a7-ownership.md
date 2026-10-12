# Track A7 ownership record: `transport/` and the install boundary

BASE `f342b6f`. Plan: `docs/phase0-architecture-baseline.md` §2 (R7), §4 option (b), §5 (F1–F3, I1, Fix A/B, DR23, DR27), §8 A7, Appendix C (transport rows). The 108 transport rows of `owners-b.tsv` (97 declarations and the 11 `<module-init>` entry blocks) were reconciled against BASE:
- All 108 rows were still in their Phase 0 files. Line numbers had moved, because A1–A6 had cut the domain code out around them.
- Three Phase 0 transport findings were already closed on BASE, by the core-first transport phase (`e0d6358`):
  - **F2 / DR27:** `scripts/runtime-bootstrap.mjs` inlines the realpath-aware `isMainModule`.
  - **F3, Fix A, Fix B:** `providers/install-support.mjs` has typed conflict refusals and receipt-less adoption of its own registration.
  - **I1:** `run --json` keeps human output off stdout.

  A7 reimplements none of them, and does not use the parked installer branch.
- A3 had already reclassified six owners-b decisions rows in the CLI and MCP files as transport adapters: `pendingApprovals`, `decisionCandidates` and `operatorApproval` in the run driver; `CONFIRMATION_SCHEMA`, `ELICITATION_TIMEOUT_MS` and `trustedDecisionRecorder` in the MCP server. They move with their files. None of them decides anything (see "MCP and CLI authorization").

**Scope.** A7 is a partial extraction of the transport rows, by design:
- 88 of the 108 rows now live in `transport/`:
  - every row of the seven CLI files and of the MCP server;
  - 12 of the 15 `migration-policy.mjs` rows (the argv refusals);
  - the upgrade CLI (`parseUpgradeArguments`, `runUpgradeCli`);
  - all 11 entry blocks, which are now one `startCommand`.
- The other 20 rows stay where lower modules or an installed contract need them. They are listed under "Remaining seams".
- No decision, signer, lifecycle or format rule moved into `transport/`.

**Method.** The extraction preserves behavior.
- Whole-file `git mv` for the eight pure transport files:
  - `cli/{discover-module,advance-migration,run-migration,validate-migration,update-migration-registry,toolkit-identity}.mjs` → `transport/{discover,advance,run,validate,registry,toolkit-identity}.mjs`;
  - `artifact/run-artifact.mjs` → `transport/artifact.mjs`;
  - `mcp-server.mjs` → `transport/mcp.mjs`.

  Their diffs are only these: the shebang and the entry block removed, the `isMainModule` import removed, and import specifiers pointed at the defining modules instead of `core.mjs` and `migration-policy.mjs`. No function body changed. Two header comments that named `migration-policy.mjs` as the definition site were corrected, and so was the matching comment in `run-migration.test.mjs`.
- The three mixed bin files were split so that the domain module has no top-level side effect (R7):
  - `record-decision.mjs` → `decision-recorder.mjs`;
  - `upgrades/upgrade-migration.mjs` → `upgrades/upgrade-coordinator.mjs`, with its CLI in `transport/upgrade.mjs`;
  - `operator-signer-service.mjs` → `operator-signer-host.mjs`.
- `migration-policy.mjs` was split: the argv half is `transport/arguments.mjs`, and the mode and outcome half is `lifecycle-policy.mjs`. The cut is verbatim.
- Every original path is now a facade (below).
- Evidence that the extraction preserves behavior:
  - **Exports:** all 61 BASE engine files export the same names, function arities and values. A fresh-process import of every file compared this against a BASE snapshot.
  - **Types:** `tsc --checkJs --noUnusedLocals` diagnostics equal BASE's once file paths are ignored. The only differences are "cannot find name `process`" lines: the eleven entry blocks' `process` references are now in `transport/entry.mjs`. The analysis runs without `@types/node`. There is no new unused or unresolved name.
  - **Bytes:** a parity probe ran the BASE tree and the A7 tree side by side (51 cases), comparing stdout, stderr and exit status:
    - every bin with no arguments, unknown options, invalid `--mode`/`--ponytail`/`--step`, conflicting modes, `--json`, `--status`, `--doctor`, the no-TTY `--approve` and relay refusals;
    - one MCP session: initialize, a notification, `tools/list`, a malformed frame, an unknown method, a missing module, an approval-shaped argument, an unknown approval tool, a stale relay, two read tools, and a request with no `jsonrpc`;
    - the signer service without its protected configuration.

    All 51 are byte-identical. The one difference is a `durationMs` metric.
  - **Golden:** `pnpm rehearse` matches the 20-step trace.
  - **Negatives:** `pnpm rehearse:negative` refuses all four corruptions.

## Files

| File | Holds |
|---|---|
| `transport/index.mjs` | The one public entry. It only re-exports. |
| `transport/entry.mjs` | Process startup. `startCommand(moduleUrl, run, onFailure)` runs `run(process.argv.slice(2))` only when `isMainModule(moduleUrl)` (the realpath-aware engine guard, not reimplemented). `reportFailure(exitCode)` puts the message on stderr and sets the exit code; it writes nothing to stdout. |
| `transport/arguments.mjs` | The argv refusals, in their BASE order: `assertOptionCombination`, the usage strings, `MODE_MESSAGE`, `RUN_REFUSED_OPTIONS`, `assertMode`, `assertStepName`, `assertDesignSource` and the flag predicates. |
| `transport/discover.mjs` | The `discover` command: argv, `--doctor`/`--status`/`--scan`, the execution preview (`renderExecutionPreview`), the slice amendment rendering, two-phase confirmation, directives and exit codes. |
| `transport/advance.mjs` | The `advance` command. |
| `transport/run.mjs` | The one-iteration driver `runMigration`: argv, `--json` framing, authoring requests, the progress block, the decision offer adapters, and delegation to discover, advance and artifact. |
| `transport/validate.mjs`, `transport/registry.mjs`, `transport/toolkit-identity.mjs` | The validate, registry and toolkit-identity commands. |
| `transport/artifact.mjs` | The `migrate-artifact` command: argv, rendering, `artifactDirective`. |
| `transport/mcp.mjs` | The MCP server: JSON-RPC framing over stdio, protocol versions, `initialize`, tool schemas and descriptors, the refused-tool table, the approval-shaped-argument guard, sessions, elicitation, the progress tools, and response and error shapes. |
| `transport/upgrade.mjs` | The `upgrade` command: argv, preview and stop lines. |

Below transport, new files from the splits:

| File | Holds | Layer |
|---|---|---|
| `lifecycle-policy.mjs` | `MIGRATION_MODES`, `isAutoAuthority` (re-export), `maySelfConfirm`, `MIGRATION_OUTCOMES`, `EXIT_CODES`/`exitCodeFor`, `nextOutcome` | lifecycle and decisions policy (A8) |
| `decision-recorder.mjs` | The whole former `record-decision.mjs`, minus its entry block | decisions seams (A3), lifecycle (A8) |
| `upgrades/upgrade-coordinator.mjs` | The v4→v5 transaction: preview, execute, rollback, recover | lifecycle (A8) |
| `operator-signer-host.mjs` | `runSignerService`, `SERVICE_CONFIG_FILE` | signer host |

Inside `transport/`, the files import each other acyclically: `run` imports `discover`, `advance`, `artifact` and `arguments`; `mcp` imports `run` and `artifact`; `validate`, `discover`, `advance` and `artifact` import `arguments`. `transport/` imports downward only, to the lifecycle files, `decision-recorder.mjs`, `operator-approval.mjs`, `migration-utils.mjs`, `engine-paths.mjs`, `toolkit-identity.mjs`, the artifact engine and the `decisions`, `store` and `formats` entries. It never imports a facade or `core.mjs`.

## Public API

`transport/index.mjs` exports 28 names:
- **Startup:** `startCommand`, `reportFailure`.
- **Argv:** `assertOptionCombination`.
- **Commands:**
  - discover: `normalizePonytailArgument`, `parseDiscoverArguments`, `renderExecutionPreview`, `runDiscoverCli`;
  - advance: `parseAdvanceArguments`, `runAdvanceCli`;
  - run: `decisionCandidates`, `parseRunArguments`, `renderAuthoringRequest`, `runMigration`;
  - validate: `parseValidateArguments`, `runValidateCli`;
  - registry: `parseRegistryArguments`, `runRegistryCli`;
  - toolkit identity: `parseToolkitIdentityArguments`, `runToolkitIdentityCli`;
  - artifact: `artifactDirective`, `parseArtifactArguments`, `runArtifactCli`;
  - upgrade: `parseUpgradeArguments`, `runUpgradeCli`.
- **MCP:** `approvalShapedArgument`, `createSession`, `handleMessage`, `serve`.

`core.mjs`, the package's `.` export, still exports `assertOptionCombination` and the policy names, as the same bindings.

## Executable entry paths

All ten bins keep their names and installed paths in `packages/migration-engine/package.json`, unchanged. Each target is a facade that:
- keeps its `#!/usr/bin/env node` shebang;
- ends in exactly one `startCommand(import.meta.url, …)`.

| Bin | Path | Implementation |
|---|---|---|
| `artifact-migration-discover` | `src/cli/discover-module.mjs` | `transport/discover.mjs` |
| `artifact-migration-run` | `src/cli/run-migration.mjs` | `transport/run.mjs` |
| `artifact-migration-advance` | `src/cli/advance-migration.mjs` | `transport/advance.mjs` |
| `artifact-migration-validate` | `src/cli/validate-migration.mjs` | `transport/validate.mjs` |
| `artifact-migration-registry` | `src/cli/update-migration-registry.mjs` | `transport/registry.mjs` |
| `artifact-migration-decision` | `src/record-decision.mjs` | `decision-recorder.mjs` (stays below transport, see seams) |
| `artifact-migration-upgrade` | `src/upgrades/upgrade-migration.mjs` | `transport/upgrade.mjs` + `upgrades/upgrade-coordinator.mjs` |
| `artifact-migrate` | `src/artifact/run-artifact.mjs` | `transport/artifact.mjs` |
| `artifact-migration-mcp` | `src/mcp-server.mjs` | `transport/mcp.mjs` |
| `artifact-migration-toolkit` | `src/cli/toolkit-identity.mjs` | `transport/toolkit-identity.mjs` |

`src/operator-signer-service.mjs` is not a bin. It is the path the OS service manager starts, and it keeps exit code 3 on failure (`reportFailure(3)`).

The failure handling of every entry block is unchanged:
- The message goes to stderr, nothing goes to stdout, and the exit code is 1. The MCP server sets `exitCodeFor("FAILED")`, which is 1.
- The run facade keeps its own handler: an argument refusal under `--json` still prints the one `{outcome: "FAILED", reason}` document on stdout.
- `runArtifactCli` defaults its argv to `process.argv.slice(2)`, which is what it now receives explicitly.
- `serve` is called with no argument, as before.

## Compatibility facades

| Path | Re-exports | Imports |
|---|---|---|
| the eight transport paths in the table above | `export *` from their transport file: exactly their BASE names | `transport/entry.mjs`; the run and MCP facades also import `lifecycle-policy.mjs` for `exitCodeFor` |
| `record-decision.mjs` | `export *` from `decision-recorder.mjs` (27 names) | `transport/entry.mjs` |
| `upgrades/upgrade-migration.mjs` | `upgrade-coordinator.mjs` + the two CLI names from `transport/upgrade.mjs` (12 names) | `transport/entry.mjs` |
| `operator-signer-service.mjs` | `export *` from `operator-signer-host.mjs` (2 names) | `transport/entry.mjs` |
| `migration-policy.mjs` | `lifecycle-policy.mjs` + `assertOptionCombination` from `transport/index.mjs` (7 names) | — |

The facades declare nothing. Importing one starts nothing: `isMainModule` is false unless that file is the process entry (A7-ARCH-9). No engine module imports a facade or `core.mjs`, which makes these the top of the engine graph.

Engine importers were redirected to the canonical files:
- `core.mjs`, `operator-approval.mjs`, `operator-signer-host.mjs`, `resumable-migration.mjs` (two lazy imports) and `transport/` now import `decision-recorder.mjs` and `lifecycle-policy.mjs`.
- The artifact engine no longer imports the package aggregator `core.mjs`. It takes the same nine bindings from `shared/`, `store/`, `lifecycle-policy.mjs` and `resumable-migration.mjs`.

**Lazy loading.** These paths are unchanged:
- TypeScript (`SCANNER_URL`, A5);
- pngjs and pixelmatch (`visual-evidence.mjs` resolution base, A6);
- `@simplewebauthn/server` (`decision-recorder.mjs` `webauthnProtocol`, a lazy import);
- the artifact engine in `transport/toolkit-identity.mjs` (`artifactEngine`, a lazy import).

The facades import the one transport file they front, not `transport/index.mjs`, so a bin never loads another command's transport file. No optional dependency became an eager import. A6-ARCH-6 and A5-ARCH-6 still pass with `record-decision.mjs` and `mcp-server.mjs` as facades.

## Dependency inversions

| Was | Now |
|---|---|
| Eleven copies of `if (isMainModule(import.meta.url)) run(argv).catch(…)`. Three of them were in domain files (`record-decision.mjs`, `operator-signer-service.mjs`, `upgrades/upgrade-migration.mjs`), which therefore ran code at import. | One `startCommand` in `transport/entry.mjs`, called only from the facades. The domain files have no top-level statement besides declarations. |
| `migration-policy.mjs` mixed the argv refusals (transport) with the mode, outcome and self-confirmation policy that the lifecycle reads. `resumable-migration.mjs` lazily imported it, which closed a cycle. | The argv half is `transport/arguments.mjs`. The lower half is `lifecycle-policy.mjs`, which the lifecycle imports lazily instead. The facade re-exports both. |
| The artifact engine imported the package aggregator `core.mjs`, so the aggregator sat inside the lifecycle cycle. | Direct imports. `core.mjs` left the cycle, and so did `operation-sequence.mjs`. |
| The transport files imported through `core.mjs`. | They import from the defining modules. `core.mjs` is only a public aggregator. |

Cycles:
- **Static:** none at BASE, none now.
- **Lazy:** BASE had one component, {artifact engine, `core.mjs`, `migration-policy.mjs`, `operation-sequence.mjs`, `operator-approval.mjs`, `record-decision.mjs`, `resumable-migration.mjs`}. It is now {artifact engine, `decision-recorder.mjs`, `lifecycle-policy.mjs`, `operator-approval.mjs`, `resumable-migration.mjs`}, a strict subset. No transport file is on a cycle (A7-ARCH-3).

## MCP and CLI authorization (unchanged)

Decisions stays the one authority owner. What transport may import from it is pinned by A7-ARCH-7, and the list is exact:
- the recorder entry `runRecordDecisionCli` and the relay `relayOperatorDecision`, both in `decision-recorder.mjs`. The recorder compares the answer under the module lock, and the relay records only AGENT_RELAYED;
- the read model `pendingDecisionCandidates`;
- the offer loop `approveWithOperator`, `moduleApprover` and `recorderFor` in `operator-approval.mjs`;
- the renderers `renderDecisionReview` and `reviewReference`.

Transport imports nothing that builds a decision line, appends to a ledger, answers a challenge, takes the module lock, or reaches the signer or WebAuthn.

The MCP surface is unchanged:
- **Tools:** the tool names, schemas, refused-tool table and protocol versions are the same. No tool name approves, confirms or records.
- **Approval-shaped arguments:** exactly one tool argument is approval-shaped, `migration_relay_decision.decision` (`APPROVE`/`REJECT`), and the guard exempts only that tool, as at BASE. Any other approval-shaped key is refused with `JSON_RPC_INVALID_REQUEST` before any core call.
- **Elicitation:** the human answer is still compared by the recorder under the lock. `trustedDecisionRecorder` forwards the bytes the client returned, or `null` on timeout or cancel, and composes nothing.
- **AUTO:** AUTO still writes only the AUTO ledger. Offer and accept stay equal (`autoMayDecide` in decisions).
- **Signer:** signed decisions remain signer-only. `operator-signer-host.mjs` has the same three gates (protected configuration, a dedicated non-root uid, build activation). The companion still receives the engine functions by injection.
- **TTY:** the no-TTY refusal of `--approve` is unchanged: exit 2, and the message goes to fd 1.

## Install boundary and packaging rules

**Decision: no physical extraction.** The installer already has its own boundary, and it is self-contained:
- `providers/install-support.mjs` is shared by the four adapters (`providers/{claude,codex,copilot,opencode}/install.mjs`).
- `scripts/runtime-bootstrap.mjs` is byte-copied to `skills/*/scripts/runtime.mjs`.

Both run inside the verified release, in a repository, a packaged release or an installed consumer. Each imports only `node:` builtins. They reach engine code only by path inside the verified release:
- `install-support` names `packages/migration-engine/src/mcp-server.mjs` as the MCP launch command;
- `runtime-bootstrap` lazily imports `runDoctor` from `packages/migration-engine/src/migration-utils.mjs`.

So `transport/` is not, and must not become, an installer dependency. Moving either file would have broken the byte copies, the generated provider trees and older receipts, and no installer code was duplicated anywhere.

Packaging:
- The release payload is the whole `packages/migration-engine/src` tree (`PAYLOAD_ROOTS` in `scripts/release.mjs`). The new files are therefore in the manifest, `SHA256SUMS` and the content hash with no list to maintain.
- A7-ARCH-8 checks the payload covers every engine file. It also checks that the two installer paths exist and keep their contract.
- The installed-lifecycle and provider suites build, verify and install a real release from this tree, load it, and run it.

The installer invariants are unchanged, because no installer file changed:
- exact release identity, the manifest and `SHA256SUMS`, and the toolkit version and content-hash binding;
- safe path containment, symlink refusal, and provider-owned file accounting;
- the previous receipt, registration ownership (F3 typed refusals, Fix B adoption), and unrelated user configuration;
- atomic updates, interrupted-install recovery, and the lock;
- runtime selection and cache reuse, offline verified reuse, and argv and cwd forwarding;
- parity across the four providers.

`git diff` touches nothing under `providers/`, `skills/` or `scripts/`. `pnpm providers:check` is clean.

## Remaining seams (not moved)

| Row(s) | Stays in | Why |
|---|---|---|
| `isMainModule`, `skillRootFor`, `quoteCommandToken`, `engineArgv`, `engineCommand` | `engine-paths.mjs` (leaf) | Lower modules render operator commands into refusals and candidate rows: decisions seams, slices drift, formats/lifecycle upgrade hints, the artifact engine, and store and census, which may import this leaf (A1, A5). Moving them up would be an upward edge. `startCommand` uses `isMainModule`; it does not reimplement it. |
| `runDoctor`, `doctorCheck`, `MINIMUM_NODE_MAJOR`, `existingKnowledgeRoot` | `migration-utils.mjs` | Installed contract: the runtime bootstrap of every released skill imports `runDoctor` from `src/migration-utils.mjs` in the verified release. That file is lifecycle-level, so it cannot re-export transport. `transport/discover.mjs` calls it for `--doctor`. |
| `BLOCKED_EXIT_CODE`, `renderLoopDirective` | `resumable-migration.mjs` | Exported by the lifecycle monolith since BASE. `BLOCKED_EXIT_CODE` is read by `lifecycle-policy.mjs` `EXIT_CODES` and by the decision seams. Re-homing either means changing that file's exports, which is A8 (lifecycle). |
| `MIGRATION_MODES`, `EXIT_CODES`, `exitCodeFor` | `lifecycle-policy.mjs` | The artifact engine reads them to build its results' `exitCode` and to validate modes. |
| `artifactArgumentsFor`, `artifactCommandFor`, `artifactIdentityCommand` | `artifact/artifact-migration.mjs` | The artifact engine renders `nextCommand` into its state and results and into its refusals, and the lifecycle `artifactBindingFor` reads them lazily. Returning a typed remedy instead changes bytes (Track B, §4.1). |
| `parseDecisionArguments`, `runRecordDecisionCli`, `runArtifactDecisionCli` | `decision-recorder.mjs` | This argv-shaped function is the single in-process recording API, not just a CLI. The lifecycle (artifact engine) records through `operator-approval.mjs` recorders that call it. `relayOperatorDecision`, the AUTO and terminal recorders, and MCP elicitation call it too. Its no-TTY refusal and group-review stop are authority checks. In transport it would put decision authority in transport, behind a lifecycle→transport edge. Only its process entry moved. |
| `operator-approval.mjs` offer loop and recorders | `operator-approval.mjs` | Same reason: the artifact engine imports them. A3 listed them for A7, but they can move only after A8 inverts the recorder: the lifecycle would receive the recorder from transport instead of building a default one. |
| `relayOperatorDecision` | `decision-recorder.mjs` | `runRecordDecisionCli --relay` calls it, so it sits on the recording API. |

## Guarantees and their tests

The table maps each required protection to its tests. Tests are in existing suites unless marked new.

| # | Protection | Tests |
|---|---|---|
| 1 | Direct execution versus import | **new:** A7-ARCH-9 (every facade, `transport/index.mjs` and `core.mjs` imported in a fresh process with stdin open: no output, exit 0), A7-ARCH-6 |
| 2 | All ten bins | bin-mappings "every bin names a module inside the package" (now checks `startCommand(import.meta.url`); **new:** A7-ARCH-6 (exact bin map, shebang, one startup call) |
| 3 | Symlinked executable behavior | bin-mappings "each bin does real work when invoked through its symlink"; runtime-bootstrap "runtime.mjs runs both directly and through a symlinked skill directory"; **new:** A7-ARCH-6 (the same bytes and exit code direct or through the link, and MCP through its link) |
| 4 | Unknown and invalid CLI arguments | migration-policy.test (argv refusal order); mcp-server "CLI and MCP reject invalid mode and Ponytail values consistently"; **new:** A7-ARCH-6 (unknown option on nine bins: stderr only, exit 1) |
| 5 | JSON framing and stdout purity, as at BASE | run-migration "run --json …" tests; mcp-server "a migration_run writes exactly one JSON-RPC response and nothing else", "an argument refusal under --json still prints one JSON document; without it stdout stays empty", "the CLI prints one post-iteration block: stderr under --json, stdout otherwise" |
| 6 | MCP malformed requests | mcp-server "a malformed frame is a parse error and the connection survives", "an unknown tool is a method error…", "a call missing the required module is refused before any core call" |
| 7 | MCP approval-shaped argument refusal | operator-approval-authority (`approvalShapedArgument`); mcp-server "every refused tool returns a method error naming the operator command", "no sequence of tool calls appends to the operator decisions ledger"; **new:** A7-ARCH-7 (`decision` on the relay tool is the only approval-shaped schema key) |
| 8 | MCP session closure | engine-paths "the MCP server starts from an external engine installation"; **new:** A7-ARCH-6 (a closed stdin ends the session, exit 0, one frame) |
| 9 | Authenticated signer boundaries | operator-signer.integration "provider, TTY and MCP surfaces cannot attest…", "companion: HTTPS-only, session-bound…", "module 19: forged, edited, unclaimed and duplicated attested lines are refused" |
| 10 | Registration ownership | provider-installation "without a receipt, its own current or historical registration is adopted", "…a modified, foreign-store or unowned-file registration fails closed and writes nothing", "without a receipt, a foreign .agents/mcp.json start-migration entry is a typed conflict" |
| 11 | User-authored provider configuration | provider-installation "reinstall is an idempotent update that keeps unrelated configuration", "Codex TOML merge preserves unrelated bytes…"; provider-runtime-matrix "OpenCode: … touch no other server", "F: every provider format survives install, self-heal and removal intact" |
| 12 | Manifest tampering | provider-installation "SHA256SUMS disagreeing with the release manifest fails closed", "ownership, checksums, symlinks and config conflicts fail closed"; runtime-bootstrap "tampered release asset is refused…"; provider-runtime-matrix "T13: tampering is refused at every boundary…" |
| 13 | Symlinked installation paths | provider-installation "ownership, checksums, symlinks and config conflicts fail closed"; providers-sync symlink and junction refusals |
| 14 | Interrupted update recovery | provider-installation "provider-owned CLI forwards argv and cwd; interrupted install locks fail closed"; runtime-bootstrap "T12: a provably dead lock owner is reclaimed once…"; format-upgrades and upgrade recovery (`recoverUpgrade`) |
| 15 | Offline runtime reuse | runtime-bootstrap "T8, T8b: offline converges from local history…"; provider-runtime-matrix "D1: three agreeing siblings let a fourth provider install entirely offline"; installed-full-lifecycle "offline installed toolkit bootstraps a fresh consumer and completes migration" |
| 16 | Four-provider parity | provider-progress-parity "every provider receives the same canonical execution contract"; provider-runtime-matrix A/B/G per provider; providers-sync "every canonical file reaches all four provider trees" |
| 17 | Lifecycle outcome and directive rendering | migration-policy "renderLoopDirective is byte-identical…"; mcp-server "the status block names checkpoint, slice and outcome for every outcome"; the 20-step golden trace (`pnpm rehearse`) |
| 18 | Candidate-bound approval | record-decision "a decision applies only to the exact current candidate", "only an explicit v2 APPROVED over the full candidate digest applies"; operator-approval-authority "no fabricated, unbound, stale or mismatched ledger line authorizes…", "the recorder refuses to approve an id that is no longer the current…" |

Architecture checks:
- **`transport.test.mjs` (new):**
  - **A7-ARCH-1:** one entry, which only re-exports.
  - **A7-ARCH-2:** outside `transport/`, only the facades name a specific transport file, and only their own. `core.mjs` uses the entry.
  - **A7-ARCH-3:** nothing below transport names `transport/`, a facade or `core.mjs`, even lazily. Transport names no facade. The static graph is acyclic, and lazy cycles stay within the BASE component.
  - **A7-ARCH-4:** each transport export is declared once, inside `transport/`. The facades declare nothing. Only `transport/entry.mjs` calls `isMainModule`. The split domain files carry no argv code and no process entry.
  - **A7-ARCH-5:** every historical path's export names and arities equal BASE, as the canonical bindings, and `core.mjs` keeps the policy bindings.
  - **A7-ARCH-6:** described in rows 2, 3, 4 and 8 above.
  - **A7-ARCH-7:** the exact authority imports, no store writes, no lock, signer or WebAuthn reach, no approval tool name, and one approval-shaped argument.
  - **A7-ARCH-8:** the installers import only builtins, the bootstrap copies are byte-equal, the two release-relative engine paths exist, and the payload covers `src/`.
  - **A7-ARCH-9:** described in row 1 above.
- **`store-shared.test.mjs`:** the A1-ARCH-3 old-site rule follows the recorder to `decision-recorder.mjs` and the coordinator to `upgrades/upgrade-coordinator.mjs`.
- **`formats.test.mjs`:** the A2-ARCH-3 raw-comparison table names `upgrades/upgrade-coordinator.mjs` (same count).
- **Source guards:** the source-text guards read the transport files that now hold the code, not the facades, so none passes vacuously: `run-migration.test.mjs` and `artifact-delegation.test.mjs` (`transport/run.mjs`, `transport/mcp.mjs`), `auto-authority.test.mjs` (`transport/{discover,advance,registry}.mjs`), `artifact-migration.test.mjs` R-W7-d (`transport/artifact.mjs`), and `operator-signer.integration.spec.mjs` (the facades plus `transport/{mcp,run,advance}.mjs`).

## Deferred (Track B), behavior preserved as-is

- **§4.1 command rendering.** Refusal and remedy text still embeds `engineCommand`/`artifactIdentityCommand` output from lower modules. A typed remedy that transport renders would change bytes.
- **DR23** (the receipt folder name) and any installer rename: untouched. The parked `park/v1.3.20-rename` folder change was deliberately not taken.
- **Recorder inversion (A8).** The lifecycle builds its default recorders (`recorderFor`) over the argv-shaped `runRecordDecisionCli`. After A8 inverts that, the CLI half (`parseDecisionArguments` and the `--list`/`--verify`/`--pending` printing) and `operator-approval.mjs` can move to transport.
- **The `BLOCKED_EXIT_CODE` / `EXIT_CODES` / `renderLoopDirective` placement** waits for A8's lifecycle module.

## Remaining architectural violations

- **Lower modules render commands** through the leaf `engine-paths.mjs`. This is the seam above, not an import of transport.
- **`migration-utils.mjs` still hosts the doctor**, the one transport-labelled function with an installed import path.
- **The lazy lifecycle component** (five files) remains. It is smaller than at BASE and contains no transport file.
