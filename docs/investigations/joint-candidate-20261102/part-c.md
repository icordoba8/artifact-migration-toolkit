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
| 5 | Codex unchanged except identity | Codex layout, `serverFor` and templates untouched; Codex adapter and provider tests pass unchanged | `providers:test` |

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
  distinct code. Codex keeps the relay tool (condition 5); the owner path still
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

## Identity

| Item | Before (2782612, labelled 1.6.5) | After (1.6.6) |
|---|---|---|
| `start-migration` skill computedHash | `20cbc21660deb5d2462d090527db0c4fdc9948c53a839abc48eef4815d546d0c` | `2b8356890afc280983b55ba98b5ed9dc22af845e2883997cbda97fbaa1145ba8` |
| `migrate-artifact` skill computedHash | `b39c1650ce0cdd6485aff02582d27b74ccecabb25e266be4d7244aa442a23510` | unchanged |
| Payload contentHash (`release:check`) | `sha256:e9421f62b6aa2ae3fbdccd5e74bb6ff41e2e16b6c174ac320ff7e7d030335624` | `sha256:4b3fb42fd55eed12670a7a79fdd49e40260665630f673c901df2b0a807ce1d78` |
| `providers/copilot/adapter.json` sha256 | `0f0b1f8c…` | `bfb2a187638ec5efe9403eb6b77a3e51cabaa5c53f496053d6ea4f696a11d484` |
| `providers/copilot/mcp.json` sha256 | `405be9c2…` | `85ba8c892313adebf8a31486dcb9dfafd6c47462cfecd37844f7ee0187cd4265` |

`release:check` ran on the clean committed tree (`versionConflict: null`).
Docs are outside the payload, so this section does not move the contentHash.
1.6.5 remains the superseded untagged candidate (`874806f`).

## Risks

- Downgrade: rolling a 1.6.6 Copilot root back to ≤1.6.5 is refused by the old
  installer ("Installation MCP selection conflict"); fails closed.
- Claude + Copilot in one root: Copilot refuses while Claude's `.mcp.json`
  entry exists; a Claude install after Copilot is not refused by Claude, and
  Copilot's next preflight doctor refuses instead.
