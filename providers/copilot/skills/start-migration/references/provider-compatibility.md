# Provider Compatibility

The canonical source is `skills/`. Run `pnpm providers:sync` after changes and
`pnpm providers:check` to prove the committed trees still match.

| Provider       | Skill output                                | Entry point                                                                 | Invocation                                                              |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Claude Code    | `providers/claude/skills/<name>/SKILL.md`   | the skill itself (`user-invocable: true`)                                    | `/start-migration <module>`                                             |
| Codex          | `providers/codex/skills/<name>/SKILL.md`    | `providers/codex/prompts/<name>.md`                                         | say `start migration <module>` or select the skill from slash completion |
| OpenCode       | `providers/opencode/skills/<name>/SKILL.md` | `providers/opencode/commands/<name>.md`                                     | `/start-migration <module>`                                             |
| GitHub Copilot | `providers/copilot/skills/<name>/SKILL.md`  | `providers/copilot/prompts/<name>.prompt.md`                                | select the agent or `/start-migration <module>` in supported IDE chat    |

All four providers receive a generated skill tree projected from the same
canonical documents. `skills/` is the source the generator reads; it is not a
skill path any provider is configured with. Each adapter installs its generated
tree into the root its own host supports.

Module default/supported = 19; Artifact default/supported = 14, including
delegated children. All four providers use the engine-owned `STANDARD_LOCAL`
policy and candidate-bound review. The operator explicitly selects `APPROVE` or
`REJECT`, relayed as `AGENT_RELAYED` into the direct ledger. Status/pending/run
reread the projection immediately. No ID transcription, challenge phrase,
service, signer, protected policy, authenticator or external network is required.
Use `migration_run` / `artifact_run` with elicitation when the host renders it.
Otherwise a module-19 `OPERATOR_DECISION` carries the review and an opaque
`operatorApproval.reference`: the agent shows the review, the user answers
`APPROVE` or `REJECT` in the conversation, and the agent relays only that next
explicit answer through `migration_relay_decision`, or without MCP through
`artifact-migration-decision <module> --relay <reference> --decision APPROVE|REJECT`,
which calls the same engine function. A missing response,
cancellation, dismissal, timeout or transport failure appends nothing; a stale
reference or a `HUMAN_ATTESTED` requirement is refused; auto-permission, model
reasoning and prior conversation never authorize a decision.

GitHub Copilot CLI reads workspace MCP servers only from `.mcp.json` or
`.github/mcp.json`, and only in a trusted folder; the Copilot adapter registers
in `.vscode/mcp.json` (VS Code). Without a connected server Copilot CLI uses the
CLI fallback above. Its path sandbox also needs the release store
(`%LOCALAPPDATA%\artifact-migration-tools` on Windows,
`~/.local/share/artifact-migration-tools` elsewhere) passed as
`copilot --add-dir <store>`, because the engine runs from there.

The optional protected WebAuthn signer provides `HUMAN_ATTESTED`. An explicit
protected high-assurance policy fails closed without valid signer activation;
`AGENT_RELAYED` never satisfies it or gets relabeled. Artifact 14 covers only
`ARTIFACT_DECISION` and `VISUAL_UNBACKED` (no `GROUP_APPROVAL`;
`EXCEPTION_RECORDED` unchanged). Historical Module ≤18 and Artifact 13 records
retain their citation/challenge flows and explicit upgrade behavior.

Provider wrappers contain no workflow logic. They load the generated skill and
forward invocation text, preventing four copies of the workflow from drifting.
Claude gets no wrapper: its skill is directly user-invocable, so a wrapper would
be a second entry point to the same document.

## What a provider tree contains, and what it must never contain

A provider tree contains `SKILL.md` and the skill's references. That is all.

It contains **no** engine source. The migration engine is one versioned package,
`@artifact-migration-tools/migration-engine`, which every adapter installs or
bundles as a dependency. `providers-sync.mjs` refuses to project an executable
module into a provider tree at all, so the failure mode this replaces — four
provider copies of the state machine, kept in step by hand and by audit — is not
reachable by editing a canonical file.

It also contains no engine test suites and no skill-local `package.json`. The
engine package owns the pinned discovery parser (`ts-discovery-compiler`) and its
own suites; a provider copy of either would advertise a tree that is not there.

Everything except `SKILL.md` is copied byte-for-byte. `SKILL.md` is the only file
permitted to differ, and only by the generated-source banner and the
per-provider frontmatter projection: Claude keeps `user-invocable`,
`disable-model-invocation`, `context` and `agent`; the other three drop them
because their skill formats do not define them.

## Install scopes

`providers/<provider>/adapter.json` records the scopes each host documents.
`null` means the provider documents no such scope, and an installer must refuse
it rather than pick somewhere plausible.

| Provider       | User-scope skill root         | Project-scope skill root | MCP config (user / project)                                 |
| -------------- | ----------------------------- | ------------------------ | ----------------------------------------------------------- |
| Claude Code    | plugin root, host-assigned    | plugin root              | plugin MCP template, host-assigned                          |
| Codex          | `~/.agents/skills`            | `.agents/skills`         | `~/.codex/config.toml` / `.codex/config.toml`                |
| OpenCode       | `~/.config/opencode/skills`   | `.opencode/skills`       | `~/.config/opencode/opencode.json` / `opencode.json`         |
| GitHub Copilot | — (none documented)           | `.github/skills`         | — / `.vscode/mcp.json`                                       |

Two of these are consumer-owned files that carry unrelated entries — Codex's
project `config.toml`, OpenCode's `opencode.json`, Copilot's `.vscode/mcp.json`.
An adapter **merges** its one `start-migration` entry into them and preserves
everything else. Overwriting a host's configuration is not installation.

One installation is authoritative per consumer, and its CLI and its MCP server
must resolve to the same toolkit. User and project scope may coexist on a
machine; one consumer's configuration selects exactly one.

## Provider convergence

All four providers run the identical runtime preflight and differ only in their
install layout and their MCP server shape. So all four derive the **same**
required identity from the installed skill, and all four converge on one
release. No provider-specific selection logic exists.

Candidate runtimes a sibling provider already installed in the same consumer are
filtered by the full acceptance predicate — version *and* the skill's canonical
digest, plus commit and content hash for a released-source skill — never by
version alone.

| Sibling state | Behavior |
| --- | --- |
| Satisfies the required identity | Reused offline; reported as `reusedFrom: <provider>` |
| On another release, whether siblings agree with each other or not | **Not candidates. Ignored, never an error.** The requirement is met from retained releases, the store, or the network |
| Same version, different skill digest | Not a candidate. Version equality is not identity |
| On a newer release than required | Not a candidate. The installed skill is the authority; a provider being ahead does not drag another forward |
| Retains the required release for rollback | A valid candidate, verified identically |
| Carries a rollback pin | Irrelevant. A pin is per-receipt intent and is never inherited across providers |
| Two candidates satisfying the same requirement with different immutable identities | **Fails closed.** Only reachable under tampering or a release-discipline breach |

A successful update converges the receipt, the installed commands, the
provider-owned MCP registration, every absolute engine path and every owned file
under one install lock per consumer root — all of it, or none of it. No
provider-owned path referring to the previous release survives, and unrelated
MCP servers and unrelated provider settings are preserved rather than rewritten.

## MCP registration policy

Every provider MCP template registers one `start-migration` server that launches
the **installed engine package's** MCP entry point. The committed template
carries the placeholder `{{ENGINE_MCP_ENTRY}}`; the adapter renders it to the
real path it resolved at install time.

| Provider       | Template                                      |
| -------------- | --------------------------------------------- |
| Claude Code    | `providers/claude/.mcp.json`                  |
| Codex          | `providers/codex/config.toml`                 |
| OpenCode       | `providers/opencode/opencode.fragment.json`   |
| GitHub Copilot | `providers/copilot/mcp.json`                  |

Two rules follow, and neither is negotiable:

- **No consumer-relative engine path.** A registration may not name a path
  inside the repository being migrated, and may not be derived from the
  operator's working directory. The engine resolves the consumer's registry,
  records, locks and evidence from `cwd`; it never resolves *itself* from there.
- **No mutable selector.** No `latest`, no branch, no bare `PATH` lookup. One
  consumer's provider configuration selects exactly one installed toolkit, so
  the CLI and the MCP server are provably the same implementation.

A provider tree is therefore not a runtime dependency of this repository, and
this repository is not a runtime dependency of a provider tree. Both depend on
one installed engine release.

## Primary references

- Agent Skills specification: <https://agentskills.io/specification>
- Codex skills: <https://learn.chatgpt.com/docs/build-skills>
- Codex AGENTS.md: <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Codex slash commands: <https://learn.chatgpt.com/docs/reference/slash-commands>
- Claude Code skills: <https://code.claude.com/docs/en/skills>
- OpenCode skills: <https://opencode.ai/docs/skills/>
- OpenCode agents: <https://opencode.ai/docs/agents/>
- OpenCode commands: <https://opencode.ai/docs/commands/>
- GitHub Copilot agent skills: <https://docs.github.com/en/copilot/customizing-copilot/extending-copilot-chat-with-agent-skills>
- GitHub Copilot custom agents: <https://docs.github.com/en/copilot/customizing-copilot/custom-agents/configuring-custom-agents>
- GitHub Copilot prompt files: <https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot#enabling-and-using-prompt-files>
