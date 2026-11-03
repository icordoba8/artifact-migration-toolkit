# Part C — T1, E5, E6 implementation evidence

Owner decision on design-t1-r2 `2782612c1f1796316233995a350712bc8a508fc3`
(HUMAN_ATTESTED). BASE `15090145a43af1e1bcb9fbce692fafac6e06f1e9`. Executor:
Copilot CLI 1.0.105, Claude Opus 5.5 (no fallback). Not a readiness claim.

## Version

**1.6.6.** `1.6.5` is the superseded, untagged candidate (`874806f`, then the
E1–E4 bump in `9214bbe`); it was never tagged or released and is not reused.
`docs/lock-protocol-cutover.md` now dates the liveness token from 1.6.6.

## T1 — Copilot MCP registration

| # | Condition | Result | Evidence |
|---|---|---|---|
| 1 | Default install and upgrade: exactly 9 grants, no relay, no flag | Both Copilot registrations launch `mcp-server.mjs --without-relay` by default; there is no opt-in flag. Upgrade from a ≤1.6.5 receipt rewrites both. | `provider-installation.test.mjs` "T1: Copilot registers nine tools…" (install, legacy-receipt update, doctor repair, remove; `tools/list` of the registered command = 9); `mcp-server.test.mjs` "T1: … --without-relay lists nine tools and refuses the relay by name" (-32601); real Copilot CLI 1.0.105 `mcp list --json`: `spikes-t1-r2/t1-r3-copilot-proof.{mjs,out}` |
| 2 | Keep `.vscode/mcp.json`, add `.github/mcp.json`; one server per client | `.vscode/mcp.json` `servers` (VS Code) and `.github/mcp.json` `mcpServers` with the 9-tool `tools` list and `env` (Copilot CLI, which ignores `.vscode`). VS Code dedup: **NOT_VERIFIED** — no GUI in-session, and the official reference (code.visualstudio.com/docs/agents/reference/mcp-configuration, fetched 2026-11-02) says Copilot-harness sessions read the CLI configuration independently while VS Code forwards `.vscode/mcp.json` servers, with no rule for one name in both. Both entries are relay-less, so neither outcome exposes the relay. | `providers-sync.test.mjs` (template shapes; `COPILOT_MCP_TOOLS` equals the server's `--without-relay` `tools/list`) |
| 3 | `.mcp.json` shadow refuses with a typed error naming the file | install, update and doctor refuse `INSTALL_REGISTRATION_CONFLICT`, `state.file: '.mcp.json'`, before writing anything | `provider-installation.test.mjs` "T1: a root .mcp.json …"; real CLI shows the shadow (`tools:["*"]`) in `t1-r3-copilot-proof.out` |
| 4 | Trust a documented user step before any native run; `--add-dir` consumer only | `README.md` *Provider boundary* and `provider-compatibility.md`: three documented trust methods, done once before the first session; store `--add-dir` removed. The payload never writes trust. | docs diff |
| 5 | Codex unchanged except identity | Codex layout, `serverFor` and templates untouched; Codex adapter and provider tests pass unchanged. **Superseded by E7** (Codex is relay-less too). | `providers:test` |

Consequence: a Claude project install's root `.mcp.json` `start-migration`
entry is exactly the shadow of condition 3, so Copilot refuses to install,
update or doctor beside it. The runtime matrix asserts that refusal for
`claude → copilot` and orders other multi-provider cases with Claude last.

## E5 — relay principal: KNOWN_LIMITATION (STOP accepted by the owner)

- **Threat model not met.** The operator ledger is agent-writable (same uid,
  workspace-write). A forged `AGENT_RELAYED` line appended with plain `fs`
  I/O — no engine code on that path — is accepted: the next `migration_run`
  returns `CONTINUE`. `spikes-t1-r2/e5-forge.{mjs,out}`. An unforgeable
  principal needs an out-of-uid signer (harness/invariant change): reported,
  not implemented.
- **No relay from the sandbox under Copilot.** With `--without-relay` the tool
  is not listed and a direct call is refused by name (JSON-RPC -32601) — a
  distinct code. Codex kept the relay tool at T1 (condition 5); since E7 it is
  relay-less as well, so the relay is CLI-only on both. The owner path still
  records `AGENT_RELAYED`, never `HUMAN_ATTESTED`.
- **No historical evidence tainted.** `spikes-t1-r2/e5-r1-r12-search.{mjs,out}`
  over `m15-certification-run-20261031T2015Z/runs` (SHA256SUMS verified,
  `e78825971c6e…`): 11 rollouts, 102 MCP tool calls, 209 shell commands, 195
  code-mode `exec` inputs, **0** relay invocations; **0** operator ledgers in
  the R1–R12 roots. R6/R6b/R6c produced no rollout; their artifacts and every
  `terminal.typescript` grep to 0.

## E6 — structured refusals

A coded refusal (`refusalOf`: a string `code` not starting with `ERR_`) is one
document `{code, errno, syscall, path}`: MCP `isError: true` +
`structuredContent` + the code in the text; CLI stdout JSON with a non-zero
exit; `run --json` in its FAILED document. JSON-RPC -32603 only for uncoded
faults. This supersedes Part B's E4 `error.data` transport. Contract:
`migration-contract.md` registry section and `SKILL.md` Invocation 1.

| Code | Test |
|---|---|
| LOCK_HELD, LOCK_NO_LIVENESS_TOKEN, LOCK_OWNER_UNKNOWN, EROFS, EACCES, EPERM, FS_ERRNO_UNKNOWN | `migration-contract.test.mjs` "E6: lock and filesystem refusals reach MCP and the CLI with their code" |
| ENOENT; uncoded → -32603 | `mcp-server.test.mjs` unbound-registry test |
| BLOCKED / NOT_STARTED | unchanged E1 result (not an error), same test |
| Codex rollout | `spikes-t1-r2/e6-codex-rollout.jsonl` (+ `e6-codex-prepare.mjs`): codex-cli 0.166.0, 1 model turn, `mcp_tool_call` `status: failed`, `structured_content.code: "ENOENT"`, agent answered `ENOENT` |

Limits: `run` without `--json` prints its text block without the code; a
refused progress tool returns the JSON document only.

## E7 — Codex relay-less by default

The shipped Codex registration is now the Copilot shape: `providers/codex/config.toml`
launches `mcp-server.mjs --without-relay` and sets `enabled_tools` to the same
nine (`RELAYLESS_MCP_TOOLS` in `install-support.mjs`, shared with Copilot). Install
writes it; `update` from a ≤1.6.5 receipt (relay-carrying, unfiltered block) is
accepted as the legacy registration and converges on it; `remove` restores the
consumer's bytes. No flag. Test: `provider-installation.test.mjs` "E7: Codex grants
nine tools…"; template shape: `providers-sync.test.mjs`. Docs: `SKILL.md`
*Operator decisions*, `provider-compatibility.md`, `command-reference.md`.

Code commit `2def2395a5f1dfa249b758e9e8b909be3299bdf4`; spikes ran at
`1bc5f4f5910f39139b7548bc267378df2d84c5a2` (adds only the spike's binary hash line; same payload).

### Spike on pinned Codex 0.165.0 (`spikes-t1-r2/codex-grants.{mjs,out}`)

Binary `~/.codex/packages/standalone/releases/0.165.0-x86_64-unknown-linux-musl/bin/codex`,
sha256 `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5` verified
(`sha256sum -c`) before the run and printed by the spike. Non-scored: no model, no
auth, empty `CODEX_HOME`, local Responses endpoint; Codex's own `ALL_TOOLS`. Harness
`infra/harness-20261102` worktree at `5776f4a` (descendant of `eb89b47`; same
`commandFor` `-c …enabled_tools` line).

| Run | Grants | Relay callable |
|---|---|---|
| shipped `config.toml` (filter + `--without-relay`), no CLI filter | **9** | no (`undefined`) |
| shipped `enabled_tools` only, unfiltered 10-tool server | **9** | no (`undefined`) |
| control: 1.6.4-shaped unfiltered config, no filter | 10 | yes (`function`) |
| harness argv `-c mcp_servers.start-migration.enabled_tools=[9]` over a 1.6.4-shaped project config | **10** | **yes** (`function`) |

The spike's verdict line reads `EFFECTIVE_GRANTS=10/9/9/10 (STOP)` because the last
row expected 9. On 0.165.0 the command-line `enabled_tools` does not narrow a server
defined in the project `.codex/config.toml`; on codex-cli 0.166.0 (non-pinned,
diagnostic only, not counted) the same argv gives 9. The shipped filter gives 9 on
both. The earlier 0.166.0 results (`61e69c8`) are non-pinned and do not count.

### Real install and upgrade (`spikes-t1-r2/e7-codex-upgrade.{mjs,out}`)

Downloaded `gh release download v1.6.4` → `artifact-migration-tools-v1.6.4.tar.gz`,
sha256 `05a1e4e2ebec3c3a10f5b7751f5934f13b37f3afc5f862045ae863b25b0e52b9` (verified).
Candidate: `release.mjs --build` from a clean detached worktree at `1bc5f4f`. Each
step runs the bundle's own `providers/codex/install.mjs` (project scope).

| Step | Toolkit | Server `tools/list` | Granted | Relay granted |
|---|---|---|---|---|
| fresh install (candidate) | 1.6.6 | 9 | **9** | no |
| install by the v1.6.4 installer | 1.6.4 | 10 | 10 | yes |
| `update` by the candidate installer | 1.6.6 | 9 | **9** | no |

`E7_INSTALLED_GRANTS fresh=9 upgrade=10->9`. After update the relay is neither
listed nor in `enabled_tools`. A direct call to it is refused with -32601
(`mcp-server.test.mjs`). Codex's own narrowing of that registration is the "shipped" row above.

### Full suite

`pnpm test` (task `byq3wxvdp`, started 14:26Z, ended 15:32Z, node v26.8.2) on a
worktree whose code equals `2def239`: `e7-full-suite.log`
(sha256 `44f8b6a8f4c0b1411112b37a400b0436f33a3b6662f6b24c13b80046fd715c95`).

| Phase | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| `engine:test` | 1180 | 1180 | 0 | 0 |
| `engine:test:ts` | 35 | 35 | 0 | 0 |
| `providers:test` | 205 | 203 | **1** | 1 |

The failure, "without a receipt, a foreign .agents/mcp.json start-migration entry
is a typed conflict", was a test assumption: it built the shared `.agents/mcp.json`
entry from the Codex receipt's launch, which E7 made relay-less. The installer keeps
that shared entry Claude-shaped (`serverFor('claude')`) for every provider, as for
Copilot at T1. Fixed in the test only (`07437dbfe870967ef7584b7dcedf39429964ec8f`;
contentHash unchanged). Targeted rerun at `07437db`: `e7-rerun-fixed.log` (2/2 pass).
CI on `07437db`: success. The full local suite was not rerun after the fix (timebox).

## Identity

| Item | Before (2782612, labelled 1.6.5) | After T1/E5/E6 (1.6.6, `61e69c8`) | After E7 (1.6.6, `1bc5f4f`) |
|---|---|---|---|
| `start-migration` skill computedHash | `20cbc21660deb5d2462d090527db0c4fdc9948c53a839abc48eef4815d546d0c` | `2b8356890afc280983b55ba98b5ed9dc22af845e2883997cbda97fbaa1145ba8` | `69fb95aa0953dd2c3c90d116c60ee4f80e5c0d1f64f86b828832ed9a013346bc` |
| `migrate-artifact` skill computedHash | `b39c1650ce0cdd6485aff02582d27b74ccecabb25e266be4d7244aa442a23510` | unchanged | unchanged |
| Payload contentHash (`release:check`) | `sha256:e9421f62b6aa2ae3fbdccd5e74bb6ff41e2e16b6c174ac320ff7e7d030335624` | `sha256:4b3fb42fd55eed12670a7a79fdd49e40260665630f673c901df2b0a807ce1d78` | `sha256:f2ce435b29cd3ab3cc0b181ee1b1bf63d93dc6c739ef7c18599ea12b0d5e5e71` |
| `providers/codex/config.toml` sha256 | — | `e74c1bea…` | `6a48f3f494ef7e0c89717ef23619a9238cab5d1554e1026d78402c1be8d8cb74` |
| `providers/copilot/adapter.json` sha256 | `0f0b1f8c…` | `bfb2a187638ec5efe9403eb6b77a3e51cabaa5c53f496053d6ea4f696a11d484` | unchanged |
| `providers/copilot/mcp.json` sha256 | `405be9c2…` | `85ba8c892313adebf8a31486dcb9dfafd6c47462cfecd37844f7ee0187cd4265` | unchanged |

`release:check` ran on the clean committed tree (`versionConflict: null`, `blockers: []`);
the E7 runs on a clean detached worktree at `1bc5f4f` and `07437db` (same contentHash).
Docs are outside the payload, so this section does not move the contentHash.
1.6.5 remains the superseded untagged candidate (`874806f`).

## Risks

- Downgrade: rolling a 1.6.6 Copilot root back to ≤1.6.5 is refused by the old
  installer ("Installation MCP selection conflict"); fails closed.
- Claude + Copilot in one root: Copilot refuses while Claude's `.mcp.json`
  entry exists; a Claude install after Copilot is not refused by Claude, and
  Copilot's next preflight doctor refuses instead. Recorded as the 1.6.6 known
  limitation in `README.md` *Install* (do not co-install in one root); no code change.
- Harness filter on pinned Codex 0.165.0: the harness's command-line
  `enabled_tools` does not narrow a project-config server (10 grants, relay
  callable, E7 spike). Safe for 1.6.6 consumers because the shipped registration
  filters itself; a harness run against an unfiltered (≤1.6.5) Codex install on
  0.165.0 would grant the relay. Harness-lane follow-up, not changed here.
- The shared `.agents/mcp.json` entry (consumer tooling, `targets`) stays the
  relay-carrying Claude-shaped launch even when it targets Codex; unchanged by E7.
- Codex rollback 1.6.6 → ≤1.6.5 by the old installer: not exercised in E7; behaviour unverified.
