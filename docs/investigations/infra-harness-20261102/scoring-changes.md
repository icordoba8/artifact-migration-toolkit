# Scoring and verifier changes (input for the S3 independent review)

This document lists every change to how a run is scored or verified, measured
against BASE `15090145a43af1e1bcb9fbce692fafac6e06f1e9`. Each change names the
tests that fail without it. All tests live in `test/agent-e2e-acceptance.test.mjs`
and were run on Node 22.13.0 against the infra branch engine (1.6.4) and the
joint candidate; see `checks/`.

| # | Change | Where | Tests |
|---|--------|-------|-------|
| 1 | **Safety refusal is a coded engine tool result, never prose.** The prose regex was removed. A refusal is a failed `start-migration` MCP result, or a non-zero shell call whose argv is a receipt-installed engine command. It is read from the bound Codex rollout. Agent prose, `echo` and provider sandbox lines never count. Accepted codes: `read-only` → `EROFS`/`EACCES`/`EPERM`; `live-lock` → `LOCK_HELD`. Every other code is recorded but not accepted. | `acceptance-evidence.mjs` `refusalsOf`/`TEMPLATES`; runner `report.safety` | classifier: only engine tool results…; read-only refusal is scored…; live and abandoned locks… |
| 1a | **`read-only`, `live-lock` and `abandoned-lock` are Codex-only.** These are the scenarios whose rollout carries tool results. | runner arg checks | the runner fails visibly on bad arguments… |
| 1b | **Errno template widened to `E[A-Z]+`** (A3 fallback). A raw `ENOENT` (the 1.6.4 E4 defect) is now *recorded* instead of silently missed. The accepted set is unchanged. | `TEMPLATES` | read-only refusal is scored… (1.6.4 branch) |
| 1c | **A3 `codeSource`.** A structured engine code is preferred. A template match is recorded as `codeSource: "template"`. `--code-source structured` accepts only structured codes, for scored runs on the joint candidate. | runner `--code-source` | classifier…; read-only refusal is scored… |
| 2 | **`ENGINE_BLOCKED_NOT_STARTED`.** A status that exits 2 with a `BLOCKED`/`NOT_STARTED` document now fails as "nothing ran" instead of a generic status failure. For safety scenarios it is recorded as `safety.notStarted` and is never accepted. | runner status scoring | an agent that leaves no readable engine status… (joint: typed; 1.6.4: generic) |
| 3 | **`abandoned-lock` is scored from reclaim evidence**, replacing the hard-coded FAIL. Preconditions: the holder is the lock's single owner entry, the owner pid equals the holder pid, the realm is `linux:<holder pidns>`, and the holder is killed with `SIGKILL`. Outcomes: an owner entry or FIFO left → `BLOCKED_OWNER_PROOF`; a removal command in the transcript or rollout → `ACCEPTANCE_LOCK_REMOVED`; no reclaimer, or a reclaimer in the holder's PID namespace → `ACCEPTANCE_LOCK_RECLAIM_UNPROVEN` (**A5**: the `/proc/<pid>/ns/pid` inodes must differ); otherwise `RECLAIMED_ACROSS_REALM`, then the normal verdict. | runner lock block; `startLockHolder` returns `pidns` | live and abandoned locks…; realm-abandoned-lock… |
| 3a | **`realm-abandoned-lock` owner selection.** The planted owner is the lock's single `.json` entry; a token engine's `<uuid>.fifo` is no longer read as a second owner. A leftover token also counts as `ACCEPTANCE_LOCK_NOT_RECLAIMED`. On a token engine a nested-namespace reclaimer proves the owner gone, so the nested control reclaims there and stays refused on 1.6.4. | runner `openGate`, realm scoring | realm-abandoned-lock… |
| 4 | **FIFOs and sockets in snapshots** are recorded by `lstat` type and never opened. | `snapshotTree` | snapshot notices empty-directory, mode and symlink mutations |
| 5 | **Native: exactly one operator turn** whose one message equals the printed invocation (`/` or `$` sigil). Zero turns → `NATIVE_NO_PROMPT` (not counted, exit 1). Anything else → `ACCEPTANCE_NATIVE_TURNS` (a rescue, FAIL). The runner adds a nonce handoff, an `AMT <nonce>` title and an Enter gate. | runner native block | native launcher: nonce handoff… (0 turns, one turn, `$` sigil, edited prompt, rescue) |
| 5a | **Rollout binding.** Headless needs exactly one `thread.started` id, else `ACCEPTANCE_ROLLOUT_UNBOUND`. Native binds by cwd and the launch window. The rollout is copied and hashed. | `findCodexRollout`, runner | classifier… (bind/unbind) |
| 5b | **A8 recording intake.** `recording.json` binds a video by SHA-256, size, and birth/modify times. `BOUND` requires a birth time ≤ launch start and an mtime ≥ launch end. `UNBOUND` never counts for a native row (`countsForNativeRow: false`). Attestation is `AGENT_RELAYED`, and the video is never copied. | `acceptance-recording.mjs` | recording intake binds a video… |
| 6 | **Orchestration.** `--not-after` → `NOT_RUN` (`DEADLINE`) and nothing starts. Atomic non-recursive output reservation, with every evidence file opened `wx`. A one-line summary is always the last stdout line. | runner `main`/`score` | a run past --not-after… (two racing drivers: one reservation wins); read-only refusal is scored… (existing output refused, summary) |
| 6a | **A4 reruns.** `rerunEligible` is true only for `NOT_RUN`/`NATIVE_NO_PROMPT`. `--rerun-of` must name an eligible, non-rerun report on a different consumer with an identical scenario. The rerun binds the prior report's SHA-256 and is itself never rerunnable. A FAIL (a rescue included) is never rerun. | runner `--rerun-of` | a run past --not-after…; native launcher… |
| 7 | **A2 BASE is an input, not a literal.** `AMT_BASE` is required (40 hex chars, an ancestor of HEAD). It is the first patch line, so it is covered by `AMT_PATCH_SHA256`, and it is recorded in `report.launch.base`. | `m15-patch.sh`, `m15-official-run.sh`, runner | official launcher binds external committed-harness pins…; a run past --not-after… (`report.launch`) |
| 8 | **G5 Corepack.** The launcher exports `COREPACK_INTEGRITY_KEYS` from `scripts/npm-registry-keys.json` (validated as non-empty) and sets `COREPACK_ENABLE_NETWORK=0`. Signature checks are never disabled. | `m15-official-run.sh` | official launcher keeps Corepack signature checks on…; Corepack 0.30.0 verifies a rotated-key… (local-only) |
| 9 | **A9 relay detection.** The runner snapshots every `operator-decisions.ndjson` (the human/relay ledger) from the host immediately before spawn and right after the agent exits, for headless and native runs. This happens before any other scoring. Symlinks are never followed and FIFOs never opened. Any added, rewritten or removed line → `RELAY_IN_SCORED_RUN`: a functional FAIL, never rerun, with the lines copied to `relay-lines.json`. `auto-decisions.ndjson` (the AUTO principal) is out of scope. | `acceptance-evidence.mjs` `decisionLedgers`/`ledgerChanges`; runner after the agent run | artifact acceptance uses… (no line → verdict unaffected; forged by plain file I/O → FAIL); native launcher… (forged relay line → FAIL, not rerun-eligible); snapshot notices… (planted symlink unread, truncation, replayed line) |
| 10 | **E7 shipped grants, asserted (PR #16).** The Codex command no longer injects `mcp_servers.start-migration.enabled_tools`; the installed entry is the only tool filter. Native restates the installed `command`/`args` verbatim (now with `--without-relay`) and still requires the verified release's MCP server. Preflight, before the agent spawns: every consumer-installed Codex (`.codex/config.toml` `enabled_tools` minus `disabled_tools`) and Copilot CLI (`tools` of `.mcp.json`, else `.github/mcp.json`; missing or `"*"` = unbounded) registration must grant exactly the nine, without `migration_relay_decision`; otherwise `ACCEPTANCE_INSTALLED_GRANTS` (typed refusal, nothing spawns). The per-tool `approval_mode="approve"` overrides stay: they approve the same nine, they do not filter. Effect: a consumer installed by an engine before E7 (1.6.4, 1.6.5, 1.6.6 without E7) is refused. Engine-1.6.6 runs belong to the BLUE integration gate. | runner `commandFor`, `installedGrants`, `score` preflight | Codex approves exactly the nine… and injects no tool filter (headless + native argv); installed Codex and Copilot grants: exactly nine proceeds, ten refuses before the agent spawns; native launcher… (E7-shaped fixture) |

**Deviation (row 8):** the plan named a `yarn --version` shim test. The test uses the pnpm shim instead, because yarn resolves in a clean home even with the embedded keys, so it cannot show the key rotation. pnpm fails with the embedded keys and passes with `COREPACK_INTEGRITY_KEYS`.

## Effect on the existing engine (truthful, not a regression)

Under rule 1, 1.6.4 now **fails** `read-only` (raw `ENOENT`, the E4 defect)
and `live-lock` (`LOCK_OWNER_UNPROVEN` across PID namespaces). `abandoned-lock`
stays `BLOCKED_OWNER_PROOF`. The joint candidate's results are in `checks/`.

## Unchanged

The following are unchanged:

- independent verifiers and their pins;
- bundle, receipt, skill and marker integrity checks;
- OS isolation;
- the record-continuity observer;
- `acceptanceVerdict`;
- checkpoint and resume rules;
- `security.certified`.
