# Joint candidate 20261102: T1 correction (r2) and E5

Design only; T1 is not implemented. The owner's ruling on `04423c9` is the
input. Evidence is in `spikes-t1-r2/` (`$S` = the session scratch directory,
which is never committed; `~` = the user's home directory). Executor:
Copilot CLI 1.0.105 · Claude Opus 5.5, with no fallback.

Disclosures:

- The A.2 load proof made **two trivial model turns** ("Reply OK"): one in
  prompt mode and one in the TUI. Authentication came from the environment.
  No consumer data was sent.
- The first TUI drive accepted Copilot's VS Code shift+enter dialog. That
  created `~/.config/Code/User/keybindings.json`, which had not existed
  before. It was removed and verified absent. Later drives strip `VSCODE_*`
  and `TERM_PROGRAM` and send Esc first.
- The fixture identity was installed for the E5 spikes and removed afterwards.

## 1. Relay exposure → **E5 OPENED** (both providers)

**Finding.** The agent under test has a reachable path to record an
`AGENT_RELAYED` decision under both providers. The MCP grant allowlist hides
only one of four paths:

| Path | How it is reached |
|---|---|
| MCP `migration_relay_decision` | Excluded by the harness's 9 grants; no shipped provider config excludes it (`providers/*` contain no tool filter). |
| CLI `artifact-migration-decision <m> --relay <ref> --decision …` | The installed SKILL.md renders an absolute `node <release>/…/record-decision.mjs` argv, independent of PATH (`providers/install-support.mjs:313-318`). Any agent shell can run it (`lifecycle/recorder.mjs:707-716` → `relayOperatorDecision` `:798`). |
| `node -e` import of the release engine | The same function. |
| Direct ledger append | `AGENT_RELAYED` v2 lines carry no MAC; only their shape is checked (`decisions/record.mjs:290`, `decisions/policy.mjs:250`). Established by code reading, not executed. |

**Proof by provider** (fixture at `OPERATOR_DECISION`, `requiredPrincipal: AGENT_RELAYED`, `spikes-t1-r2/e5-prepare.*`):

- **Copilot.** Copilot CLI has no OS sandbox here (bubblewrap is absent, T2).
  `shell(node)` permission rules match only the command stem
  (P0 `help-permissions.txt`), so they cannot tell the fallback `run` apart
  from `--relay`.
  - The relay CLI run in the host namespace **recorded**
    `AGENT_RELAYED APPROVED DEC-001` (`e5-host-relay.out`).
  - **Reachable and effective.**
- **Codex.** The command runs inside `codex sandbox -P :workspace`
  (CapEff 0, NoNewPrivs 1) and inside the harness userns, where the MCP server
  also lives.
  - Both times it is refused with `Untrusted protected decision policy
    directory: /`, and nothing is written (`e5-sandbox-relay.out`,
    `e5-userns-relay.out`).
  - The cause is that in the userns `/` has uid 65534 (`e5-userns-list.out`),
    and `trustedPolicyFor` (`policy.mjs:128-141`) requires uid 0.
  - **Reachable but incidentally blocked.** The same check blocks *every*
    principal, so no operator decision can be recorded either.

**Affected rows.**

- **19 and 27:** Codex structurally unreachable (fail-closed by accident);
  Copilot agent-forgeable.
- **A3 and I7 (Copilot).**
- Conditionally, the completions after a decision (8/10/11/13) wherever
  they consume an `AGENT_RELAYED` record.

**Historical evidence.**

- R1–R12 rollouts and agent stdout (`m15-certification-run-20261031T2015Z/runs`)
  contain 0 relay invocations, 0 `AGENT_RELAYED` records and 0
  policy-resolution refusals.
- The vault pre-certification rollouts mention the relay only in SKILL.md
  reads.
- **No historical result is tainted.** The claim "no relay grant" at
  `docs/agent-e2e-acceptance.md:159` and `m15-harness-implementation.md:69` was
  never a boundary and must not be cited as one.

**Root-cause boundary (proposed; owner-gated).** Every path, including a
forged ledger line, is evaluated against the decision policy's
`requiredPrincipal`. The boundary therefore belongs there, not in grants:

1. A scored run requires `HUMAN_ATTESTED`, defined by the root-owned protected
   policy `/etc/artifact-migration-tools/decision-policy.json` plus a signer.
   - Every agent path then yields `SIGNER_UNAVAILABLE`. This is already
     tested for MCP and CLI in
     `test/integration/direct-ledger-defaults.integration.spec.mjs:~160-166`.
   - An unsigned `AGENT_RELAYED` line cannot satisfy it (`policy.mjs:73-74`).
2. Engine change: an unverifiable trust root becomes a typed `BLOCKED`
   (`DECISION_POLICY_UNVERIFIABLE`) on every decision path, instead of a raw
   throw. It never falls back to `STANDARD_LOCAL`.

**Blockers.**

- (a) Root-owned `/etc` policy and a signer provisioned on the scoring host:
  infrastructure.
- (b) The Codex userns hides root ownership. Accepting uid 65534 would weaken
  the trust root, so it is **rejected**. Scoring rows 19/27 needs a topology
  that shows real root ownership: harness/infrastructure.
- (c) Copilot scored rows that involve decisions must not run without
  isolation (T2/T3).

**Rejected alternatives.**

- Copilot deny-tool patterns: stem-only, so bypassable.
- Removing the CLI relay: the operator's documented path, and the ledger
  path stays open anyway.
- A mode-bound relay: the agent controls the mode.

## 2. Load proof: Copilot CLI 1.0.105 loads `.github/mcp.json` with exactly 9 tools

**Configuration** (`spikes-t1-r2/t1-consumer-github-mcp.json`):

- `mcpServers.start-migration` with `type: stdio`, an absolute node, the
  9-tool `tools` array and `env.pnpm_config_pm_on_fail=error`.
- A legacy `.vscode/mcp.json` is present.
- `COPILOT_HOME` is isolated.

**Pinned sources.**

- P0 `help-1.0.105/sub-mcp.txt:11`: "Workspace .mcp.json or .github/mcp.json".
- `help.txt:41-43`: `--trust-folder`.
- `help-config.txt:243`: `trustedFolders`.
- `copilot mcp` help: `tools` is required for local servers.

**Results.**

| Mode | Untrusted | Trusted | Evidence |
|---|---|---|---|
| `copilot mcp list --json` | server absent | `source=workspace path=…/.github/mcp.json tools=[9]`; `.vscode/mcp.json` ignored | `t1-mcp-list.txt` |
| Prompt mode (`-p … --trust-folder`) | — | server spawned with `pm_on_fail=error`, `argv=[]`; discover → initialize → tools/list; the server advertises 10; the client registers **exactly 9** `start-migration-<tool>`, with the relay mentioned 0 times | `t1-tap.log`, `t1-logs-prompt.excerpt.log` |
| Native TUI (PTY) | "folder trust unknown; waiting", not spawned | spawned; one turn registers **exactly 9**, relay 0 | `t1-logs-tui*.excerpt.log` |

`/mcp show start-migration` lists the server catalog **(10)**, including the
relay (`t1-tui-mcp-show.screen.txt`). That is the catalog; the model-facing set
is the `tools` allowlist (9).

**New finding: shadowing.** A workspace-root `.mcp.json` with the same server
name wins over `.github/mcp.json`, and its entry has `tools=["*"]`
(`t1-mcp-list.txt`, last block). Claude registers `start-migration` in
`.mcp.json`. A Claude + Copilot install on one root would therefore give
Copilot CLI Claude's entry with all 10 tools. This is handled in §3.

## 3. VS Code compatibility and upgrade

**What each client reads.**

- **VS Code** (docs: *MCP configuration reference*, "Configuration file" and
  "Automatic MCP server discovery"; *Add MCP servers*, "Choose a configuration
  destination"):
  - Reads `.vscode/mcp.json` (`servers`) and the user profile.
  - Reads workspace-root `.mcp.json` only with the experimental
    `chat.mcp.workspaceRootConfig.enabled` setting.
  - Discovers `$COPILOT_HOME/mcp-config.json` by default.
  - It does **not** read `.github/mcp.json`.
  - The VS Code `servers` schema has **no `tools` allowlist**.
- **Copilot CLI** reads `.mcp.json` / `.github/mcp.json` and ignores
  `.vscode/mcp.json` (§2).

So VS Code is kept on `.vscode/mcp.json`, and Copilot CLI gets
`.github/mcp.json`. Each client loads one server.

**Exactly 9 grants in VS Code.** VS Code cannot filter tools from config. The
grant limit must therefore come from the server, so that it also holds when a
client ignores or shadows the allowlist:

- `mcp-server.mjs --without-relay` omits `migration_relay_decision` from
  `tools/list`.
- A call to it is refused through the existing `REFUSED_TOOLS` path
  (`transport/mcp.mjs:182`, `:630`).
- Both Copilot registrations carry it: `.vscode/mcp.json` args and
  `.github/mcp.json` args. The `.github` entry also keeps the 9-tool `tools`
  field, which Copilot requires.
- The one constant `COPILOT_MCP_TOOLS` (design.md T1 step 2) remains the only
  list; a test asserts it equals the server's `--without-relay` list.

**Upgrade from 1.6.x Copilot receipts** (`install-support.mjs`; existing
legacy-candidate, ownership and backup machinery):

| File | Existing state | Action |
|---|---|---|
| `.vscode/mcp.json` | receipt-owned legacy `{type,command,args}` | Rewrite the owned entry in place to the new args (`--without-relay`). Unrelated servers are preserved. |
| `.vscode/mcp.json` | owned entry modified | `INSTALL_REGISTRATION_CONFLICT`, no writes |
| `.github/mcp.json` | absent / other servers | Add `start-migration` (`mcpServers`, 9 `tools`, `env`, `--without-relay`). |
| `.github/mcp.json` | foreign `start-migration` | `INSTALL_REGISTRATION_CONFLICT` |
| `.mcp.json` | `start-migration` present (Claude or foreign) | `INSTALL_REGISTRATION_CONFLICT` for Copilot install, update and doctor, because it would shadow ours with `*`. Fail-closed default; see the owner question. |
| rollback / remove | — | Both files are restored byte for byte from the existing backup set. |

Result per client: VS Code gets 1 server and 9 tools (from the server). Copilot
CLI gets 1 server and 9 tools (from the allowlist and the server).

**Unverified (no VS Code GUI here).** A VS Code *Copilot harness* session both
forwards `.vscode` servers and reads portable files. With the same server name
on both sides, the CLI log shows that it keeps one copy ("dropped the session
server map's copies…", `t1-logs-tui-turn.excerpt.log`). Either copy exposes 9
tools because of `--without-relay`. The T1 implementation must show this
before any VS Code claim.

**Owner question.** Should `--without-relay` also apply to the Claude and
OpenCode registrations? That would make shadowing harmless and allow
Claude + Copilot cohabitation, but it removes the MCP relay for those providers.
The default is no: conflict on cohabitation.

## 4. Folder trust and `--add-dir`

- **Trust is required.** Copilot CLI loads workspace MCP only in a trusted
  folder (§2: untrusted means absent, or "waiting" in the TUI).
- It becomes a **documented user step** in the install guidance:
  - `README.md` *Provider boundary* (`:373`).
  - `provider-compatibility.md:28-33`.
  - The three documented ways to trust the folder:
    - accept the trust prompt on the first TUI launch in the consumer root;
    - add the consumer root to `trustedFolders` in `$COPILOT_HOME/config.json`
      (`help-config.txt:243`);
    - for a single prompt-mode session, use `copilot --trust-folder -p …`
      (`help.txt:41-43`).
  - The payload never writes trust. The harness may only reproduce one of
    these documented steps.
- **`--add-dir`.**
  - The MCP leg needs none. In the spike the server and engine lived outside
    the consumer and the trusted cwd, and were spawned and listed without
    `--add-dir`, because Copilot's path sandbox governs agent file and shell
    tools, not MCP server processes.
  - The current `--add-dir <store>` text (`provider-compatibility.md:31-33`)
    is therefore removed.
  - `--add-dir` is documented only for the consumer workspace, when Copilot
    is started outside it. Per `help.txt:114-116` it also loads that
    directory's `.github/skills` and `.github/agents` as trusted
    configuration, which is why it must not name the store.
  - Without store access, the shell fallback cannot reach the engine. That is
    acceptable once MCP is connected, and it narrows E5's CLI path, but it is
    not a boundary (§1).
- No harness repair is involved.

## Changes to design.md T1 (for the owner)

1. Keep `.vscode/mcp.json`. Add `.github/mcp.json`. Both use `--without-relay`.
2. The `.mcp.json` shadowing check is added to install, update and doctor.
3. Trust and `--add-dir` (consumer only) go into the install guidance; the
   store `--add-dir` is removed.
4. File list: design.md T1 plus `packages/migration-engine/src/transport/mcp.mjs`
   and `src/mcp-server.mjs` (flag), `README.md`, and focused tests for the
   flag, the shadowing conflict and the dual-file upgrade.
5. E5 is a separate owner decision: the principal boundary, the
   `DECISION_POLICY_UNVERIFIABLE` engine type, and the infrastructure
   blockers (a)–(c).
