# Phase 4 — provider adapters

Phase 4 changes only the standalone toolkit. Consumer cutover, retirement,
tagging, publication, commits and pushes are not part of this change.

## Installation contract

The normal user path is now standard Agent Skills installation followed by the
installed skill's first-use preflight:

```sh
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-tools --skill start-migration
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-tools --skill migrate-artifact
```

Both skills carry byte-identical generated copies of
`scripts/runtime-bootstrap.mjs`, because either skill must remain independently
installable. That preflight owns only immutable GitHub Release resolution and
transport. It uses existing `gh`, token, or Git credential authentication,
verifies the release/tag/asset identity, and delegates the release store,
receipt, MCP merge, adapter doctor and engine doctor to the shared adapter below.
It never opens or writes consumer migration state. A valid receipt short-circuits
before GitHub resolution, so a second invocation is offline.

The following explicit bundle CLI remains the advanced CI/admin surface.

Each provider owns `providers/<provider>/install.mjs`. These generated entry
points share file/config mechanics in `providers/install-support.mjs`; that
module has no standalone CLI and contains no migration rules. Engine commands
and MCP always execute `packages/migration-engine` in the selected release.

Use an explicit local release bundle and the independently obtained SHA-256 of
its `release-manifest.json`. The installer checks every listed file, including
all shipped parser dependency bytes, rejects unlisted engine files and symlinks,
and stages a checksum-named release in an external store. No network install,
branch lookup, version range or ambient engine selection occurs.

```sh
node providers/codex/install.mjs install \
  --scope project --root '/scratch/consumer with spaces' \
  --store '/scratch/installed toolkit releases' \
  --bundle '/scratch/verified release bundle' \
  --pin 'sha256:<release-manifest checksum>'
```

`--root` means the consumer for project scope, the selected home directory for
Codex/OpenCode user scope, and the host-assigned plugin root for Claude. The
store must be outside that root. Copilot intentionally supports repository scope
only. Claude receives a native `.claude-plugin/plugin.json`, skills and `.mcp.json`;
its host can load that plugin root. This does not register or publish a marketplace.

| Provider | Scopes tested | Skills | Wrappers | MCP |
| --- | --- | --- | --- | --- |
| Claude | user/project plugin roots | `skills/` in plugin root | native user-invocable skills | plugin `.mcp.json` |
| Codex | user/project | `.agents/skills` | `.codex/prompts` | `.codex/config.toml` |
| OpenCode | user/project | `.config/opencode/skills` / `.opencode/skills` | corresponding `commands/` | user `opencode.json` / project `opencode.json` |
| Copilot | project | `.github/skills` | `.github/prompts/*.prompt.md` | `.vscode/mcp.json` |

Host layouts follow [Claude plugin documentation](https://code.claude.com/docs/en/plugins-reference),
[Codex MCP configuration](https://developers.openai.com/codex/mcp/),
[OpenCode commands](https://opencode.ai/docs/commands/) and
[VS Code prompt files](https://code.visualstudio.com/docs/agent-customization/prompt-files).

Installed skill commands are rendered to absolute, shell-quoted engine paths.
For an explicit adapter preflight or a CLI call, use the same selection:

```sh
node providers/codex/install.mjs --doctor \
  --scope project --root '/scratch/consumer with spaces' \
  --store '/scratch/installed toolkit releases'

# Run from the consumer cwd; the adapter forwards argv and cwd unchanged.
node /absolute/toolkit/providers/codex/install.mjs exec \
  --scope project --root '/scratch/consumer with spaces' \
  --store '/scratch/installed toolkit releases' \
  -- artifact-migration-toolkit status --module auth
```

Adapter doctor reports provider, scope, exact identity, skill hashes, resolved
engine commands and installed MCP registration without starting MCP services.
The engine's separate `artifact-migration-discover --doctor` remains the runtime
prerequisite check. They answer different questions.

`update` takes the same arguments as `install`, selecting another immutable
bundle. It never changes a migration record. Active records reject the changed
identity until the operator runs the engine's explicit `toolkit update` command.
`rollback` takes the old bundle/checksum and requires that release to appear in
the installation's retained release history; the engine's explicit `toolkit
rollback` operation is then required before resuming. Neither operation rewinds
state, decisions, evidence or lifecycle history.

`remove` requires only scope, root and store. It removes only manifest-owned,
unmodified skill/wrapper/plugin files and its own MCP entry. Prior releases
remain available. Unrelated config entries and unrelated files survive. Modified
owned files, occupied unowned paths, malformed manifests, conflicting MCP
entries and symlink paths block before replacement/removal. JSON config must be
valid JSON (JSONC fails closed); TOML uses one exact marked block and preserves
all other bytes. A root-local exclusive lock serializes writes; an interrupted
installer leaves its lock for operator inspection rather than guessing at recovery.

## Acceptance matrix

`pnpm providers:test` runs the projection tests and the installed acceptance
suite. Each of the seven provider/scope rows above checks:

- one common toolkit identity and the canonical `skills-lock.json` hashes;
- both installed invocation surfaces — the skill and, except on Claude where a
  duplicate wrapper is refused, its wrapper — each naming its skill, carrying
  the exact projected frontmatter and no engine implementation;
- status before mutation, consumer cwd registry/state resolution;
- identical runtime identity reported by CLI and a real MCP stdio process;
- installation, consumer and MCP launch paths containing spaces;
- update mismatch refusal without writes, explicit identity update, rollback
  refusal until explicit identity rollback, then successful checkpoint resume;
- removal preserving unrelated files, consumer records and retained releases.

Additional cases cover retained consumer MCP entries (R-W9-a/R-W9-c), TOML byte
preservation, malformed ownership, symlinks, checksum/config conflicts, CLI argv
forwarding and interrupted-install lock refusal. Generator checks cover the same
projection before installation. No skipped provider installation proofs remain
in the engine contract suite.

The update fixture is a synthetic compatible `1.1.1` identity, not a published
second release. Acceptance builds use the working tree with `force: true`; a
clean committed release and protected tag remain separate release gates.

These are automated filesystem/configuration and real engine/MCP acceptance
checks on this Linux host. They do not claim interactive discovery in all four
native host UIs, a marketplace installation, signing ownership approval, or a
Windows execution result. CI owns Windows execution. Production Claude namespace
and marketplace/signing approval remain release-owner decisions from the plan.

## Remaining Phase 5 work

Phase 5 has not started. It requires an approved cutover window and soak policy,
a clean approved immutable release, switching live consumer entry points and MCP
registrations, explicit identity adoption on active records, retained unrelated
agent generation checks, and successful live resume/soak evidence. Only after
separate retirement approval may dormant consumer engine/skill copies and their
migration-only dependencies/tests be deleted. Keep consumer registry, state,
evidence, OpenSpec authority and unrelated agent infrastructure intact.
