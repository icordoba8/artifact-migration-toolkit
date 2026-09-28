# Migration command reference

This is the canonical command reference for the two skills in `skills/`.
The provider generator's closed target list is Claude Code, Codex, OpenCode,
and GitHub Copilot. Provider files under `providers/` are generated from the
canonical skills; edit `skills/` or this reference, not those files.

Install each skill independently with `pnpm dlx skills add
https://github.com/icordoba8/artifact-migration-tools --skill <name>`.
Run invocations from the consumer repository. Before status or migration work,
each skill runs its installed `scripts/runtime.mjs ensure --provider
<claude|codex|opencode|copilot> --root <current-working-directory>` preflight.
It supplies pinned absolute engine commands. A failed preflight stops the
invocation. An exact runtime version can be selected with `--version X.Y.Z` or
`ARTIFACT_MIGRATION_TOOLS_VERSION=X.Y.Z`; it does not change a record's pinned
toolkit identity.

## Which Skill Should I Use?

The artifact engine accepts any safe lower-case, hyphenated `--type` name; it
has no closed list of artifact kinds. Choose by migration boundary:

| Migration target | Skill |
| --- | --- |
| Shared or UI component | `migrate-artifact` |
| Static page or placeholder as one bounded source artifact | `migrate-artifact` |
| Layout, shell, or theme | `migrate-artifact` |
| Hook, store, service, adapter, or provider | `migrate-artifact` |
| Type, contract, schema, constants/config, or utility | `migrate-artifact` |
| Route-support artifact, style, asset, data file, or other bounded artifact | `migrate-artifact` |
| Complete feature, module, app, or multi-session migration with a registry, requirements, and slices | `start-migration` |

These are examples of the open-ended artifact contract, not an enum of accepted
`--type` values. A shared prerequisite found during a module migration is
delegated to its own `migrate-artifact` record. A page or route that spans a
complete behavior flow belongs in `start-migration`.

## Skills and related operations

| Name | Purpose and when to use | When not to use | Arguments and relationship |
| --- | --- | --- | --- |
| `migrate-artifact` | Start, inspect, resume, or finalize one standalone, bounded source artifact, including a shared prerequisite delegated by `start-migration`. | A complete feature/module needing registry, requirements, and multiple slices. | `<primary-source> [--source <additional-source>]... [--type <safe-name>] [--target <path>] [--source-root <path>] [--target-root <path>] [--design-source target-system\|figma-mcp] [--figma <url>]... [--ponytail full\|full-audit] [--status] [--mode auto\|step] [--slice <id>] [--json]`. Defaults: type `artifact`, both roots current directory, mode `auto`; Ponytail disabled. `figma-mcp` requires a Figma URL. |
| `start-migration` | Start, inspect, resume, or advance one complete legacy-to-target feature/module/app migration. | A standalone artifact with no parent module record. | `<module> [--registry <path>] [--target <target>] [--legacy <module>]... [--adopt-target] [--mock] [--brief <path>] [--design-source target-system\|figma-mcp] [--figma <url>]... [--ponytail [full\|full-audit]] [--mode auto\|step] [--slice <id>] [--json]`. Omitted mode is `auto`; omitted Ponytail is disabled. Bootstrap/maintenance switches such as `--refresh`, `--reopen-discovery`, and `--reopen-ui` belong to `artifact-migration-discover`, not the normal `artifact-migration-run` loop. |

The canonical skill directory contains exactly these two skills. It does not
ship `ponytail`, `ponytail-audit`, `review-before-commit`,
`review-architecture`, `project-validation-gates`, or separate discovery,
recovery, or review skills. Ponytail and its audit are companion skills when
installed in a host; their invocation and availability are host-specific. The
module workflow requests the target project's architecture review at `PLAN`
and records its verdict at `ARCHITECTURE_PLAN_GATE`; no skill by the name
`review-architecture` is bundled here. Discovery, reopening, recovery,
validation, operator decisions, and final review are engine operations in the
two skills' workflows, not extra provider targets or bundled skills.

### Ponytail and stopping rules

For `start-migration`, `--ponytail full` requests Ponytail Full during
implementation plus Ponytail Review. Bare `--ponytail` means `full`.
`--ponytail full-audit` includes everything in `full`, then Ponytail Audit
before the pre-commit review. These values are part of the migration invocation
and persist in its record. Session-level `/ponytail` mode does not set them,
and the migration flag does not install or load a provider's separate Ponytail
skill. Load/install that skill where the host requires it. The engine validates
the review and audit evidence; the agent performs the work.

At `FINALIZE`, `full` requires fresh, bound `ponytailEvidence` of `kind:
"review"` on `SIMPLIFY_ONCE`; `full-audit` also requires `kind: "audit"` on
`PRECOMMIT_GATE`. Each is a structured evidence entry with a nonempty reference,
timestamp, producer, environment, hash, and binding to the current target,
legacy and target revisions, requirements digest, data-source mode, and dirty
manifests. A changed tree or stale evidence fails validation. The audit sits
after implementation and verification, before the pre-commit gate closes.
Neither option replaces the mandatory seven final gates.

For `migrate-artifact`, pass an explicit value: `--ponytail full` or
`--ponytail full-audit`. Bare `--ponytail` and unsupported values are rejected.
The artifact record persists the option. At `FINALIZE`, `full` requires hashed,
bound Review evidence on `SIMPLIFY_ONCE`; `full-audit` also requires Audit
evidence on `PRECOMMIT_GATE`. Run Audit after verification; the engine requires
Review → Audit → pre-commit review order by checking their timestamps against
`PRECOMMIT_GATE.reviewedAt`. Evidence files live in the artifact record's
`evidence/` directory. No flag leaves the current completion gates unchanged.

Start with read-only status; resume the active checkpoint. `start-migration`
prefers connected `start-migration` MCP (`migration_status`, then
`migration_run` with absolute `cwd`). If MCP is unavailable, use the pinned
absolute `artifact-migration-discover <module> --status` and
`artifact-migration-run <module> ... --json` commands returned by preflight.
`migrate-artifact` uses its returned `artifact-migrate <source> --status`, then
the bare command. Both obey typed outcomes and stop at an operator decision or
blocker. Human approvals require host elicitation or the engine's trusted
terminal decision command; `--mode auto` does not impersonate a human.
Completion means ready for commit; neither skill commits or publishes.

## Supported targets

The matrix contains every target in `scripts/providers-sync.mjs` and every
provider adapter. In each row, `auth` is a sample module and
`src/shared/button.ts` is a sample source path. Replace them with real inputs.
The Ponytail columns show feature commands; artifact forms appear in the
provider examples below.

| Target / Provider | Skill location/discovery | Artifact invocation | Feature invocation | Ponytail Full | Ponytail Full-Audit | Runtime fallback | Supported |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code (`claude`) | Host-assigned plugin `skills/<name>/SKILL.md`, native user-invocable skill | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` | `/start-migration auth --ponytail full` | `/start-migration auth --ponytail full-audit` | Pinned absolute CLI when MCP absent; artifact always uses CLI | Yes |
| Codex (`codex`) | `.agents/skills/<name>/SKILL.md` and `.codex/prompts/<name>.md`; select prompt/skill or address it in chat | `Use the migrate-artifact skill for src/shared/button.ts` | `Start migration auth using the start-migration skill` | `Start migration auth using the start-migration skill with --ponytail full` | `Start migration auth using the start-migration skill with --ponytail full-audit` | Pinned absolute CLI when MCP absent; artifact always uses CLI | Yes |
| OpenCode (`opencode`) | `.opencode/skills/<name>/SKILL.md` and `.opencode/commands/<name>.md` | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` | `/start-migration auth --ponytail full` | `/start-migration auth --ponytail full-audit` | Pinned absolute CLI when MCP absent; artifact always uses CLI | Yes |
| GitHub Copilot (`copilot`) | `.github/skills/<name>/SKILL.md` and `.github/prompts/<name>.prompt.md`; supported IDE agent chat | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` | `/start-migration auth --ponytail full` | `/start-migration auth --ponytail full-audit` | Pinned absolute CLI when MCP absent; artifact always uses CLI | Yes |

## Claude Code

**Discovery:** The adapter installs a plugin at a host-assigned root. It
contains `skills/migrate-artifact/SKILL.md` and
`skills/start-migration/SKILL.md`; `user-invocable: true` exposes the skills
directly, with no prompt wrapper. The plugin `.mcp.json` registers the pinned
engine. User and project plugin roots are supported.

```text
/migrate-artifact src/shared/button.ts
/migrate-artifact src/shared/button.ts --ponytail full
/migrate-artifact src/shared/button.ts --ponytail full-audit
/start-migration auth
/start-migration auth --ponytail full
/start-migration auth --ponytail full-audit
```

**Fallback:** If the MCP server is disconnected, use the absolute
`artifact-migration-discover`/`artifact-migration-run` commands returned by
preflight. Artifacts use the returned `artifact-migrate` CLI. A newly registered
MCP server may require a host restart.

## Codex

**Discovery:** The adapter installs skill files under `.agents/skills` (user
or project scope) and prompt wrappers under `.codex/prompts`. Select the
installed prompt/skill from completion, or address the skill explicitly in
chat. The wrapper forwards its arguments; `.codex/config.toml` registers MCP.

```text
Use the migrate-artifact skill for src/shared/button.ts
Use the migrate-artifact skill for src/shared/button.ts with --ponytail full
Use the migrate-artifact skill for src/shared/button.ts with --ponytail full-audit
Start migration auth using the start-migration skill
Start migration auth using the start-migration skill with --ponytail full
Start migration auth using the start-migration skill with --ponytail full-audit
```

**Fallback:** Use the pinned absolute CLI commands returned by preflight if
MCP is disconnected; `artifact-migrate` is the artifact command. Codex's chat
phrases are agent instructions, not shell commands.

## OpenCode

**Discovery:** The adapter installs user skills under
`~/.config/opencode/skills` and commands under
`~/.config/opencode/commands`, or project skills/commands under
`.opencode/`. The command wrappers forward `$ARGUMENTS`.
`opencode.json` receives the pinned MCP registration.

```text
/migrate-artifact src/shared/button.ts
/migrate-artifact src/shared/button.ts --ponytail full
/migrate-artifact src/shared/button.ts --ponytail full-audit
/start-migration auth
/start-migration auth --ponytail full
/start-migration auth --ponytail full-audit
```

**Fallback:** Use the absolute CLI commands from preflight when MCP is
disconnected; `artifact-migrate` handles artifacts.

## GitHub Copilot

**Discovery:** Repository scope only: `.github/skills/<name>/SKILL.md` and
`.github/prompts/<name>.prompt.md`. Select the prompt in a supported IDE's
agent chat; its appended text is forwarded as skill arguments. The adapter
merges MCP into `.vscode/mcp.json`. No user-global skill scope is documented.

```text
/migrate-artifact src/shared/button.ts
/migrate-artifact src/shared/button.ts --ponytail full
/migrate-artifact src/shared/button.ts --ponytail full-audit
/start-migration auth
/start-migration auth --ponytail full
/start-migration auth --ponytail full-audit
```

**Fallback:** Use the pinned absolute CLI commands when MCP is disconnected;
`artifact-migrate` handles artifacts. Slash prompt syntax depends on a
supported IDE chat.

## Runtime command forms

These commands are returned as absolute paths by the installed runtime
preflight. The bare names here identify the command and argument contract;
do not resolve them from an ambient `PATH` or a development checkout.

```text
artifact-migrate src/shared/button.ts --status
artifact-migrate src/shared/button.ts [--type <safe-name>] [--mode auto|step] [--slice <id>] [--json]
artifact-migrate src/shared/button.ts --ponytail full --json
artifact-migrate src/shared/button.ts --ponytail full-audit --json
artifact-migration-discover auth --status
artifact-migration-run auth --ponytail full --json
artifact-migration-run auth --ponytail full-audit --json
```

The artifact CLI persists the requested Ponytail mode at bootstrap and enforces
its Review or Audit evidence before `COMPLETE`.
