# Provider setup and first migration

1. [Install and verify the provider](#installation).
2. [Set up local applications](#runtime-configuration) if the migration needs UI evidence.
3. [Start or resume a migration](#migration-examples).

[Configuration templates](#configuration-templates) · [Troubleshooting](#troubleshooting)

## Installation

Use Node.js 22 or newer, pnpm, Git, and a working tar. Have the provider
installation and sign-in ready. Open the consumer Git workspace where you
want the toolkit to register MCP. Use the same host environment for the
provider and engine. UI work also needs Playwright MCP and access to the
running applications. Figma MCP is needed only when you select Figma as the
design source. For runtime identity checks, make `lsof` and `ps` available
on Linux, WSL and macOS, or Windows `netstat` and PowerShell/CIM on Windows.

The install commands select the published [v1.9.0 tag](https://github.com/icordoba8/artifact-migration-toolkit/releases/tag/v1.9.0)
and install both skills. To update, select a newer **published** tag and repeat
the same command for both skills in the existing scope. The Agent Skills CLI
defaults to project scope. Add `--global` for a personal skill install where
supported. A personal skill install still registers the runtime **per
consumer** on first use. See the [Agent Skills CLI directory reference](https://github.com/vercel-labs/skills/blob/main/docs/agents.md).

Invoke a skill or run this from the workspace where you will run the host.
Use the absolute directory of the installed `start-migration` skill and
the provider ID from its install command. `--root .` selects the current
workspace.

```bash
node "/absolute/path/to/start-migration/scripts/runtime.mjs" ensure --provider codex --root .
```

The preflight reports `outcome: OK` on success. It uses the installed
skill's release identity and content hash. It searches verified local releases first and downloads the matching immutable
tag only when needed. It sets `command` to the absolute Node executable and
resolves the MCP entry inside the verified release at
`<store>/<version>-<manifest-sha256>/packages/migration-engine/src/mcp-server.mjs`.
The default store is `%LOCALAPPDATA%\artifact-migration-tools` on Windows
(with the home directory as fallback) and
`${XDG_DATA_HOME:-$HOME/.local/share}/artifact-migration-tools` elsewhere.
Use `ARTIFACT_MIGRATION_TOOLS_STORE` or `--store` only when selecting a
consistent alternate store outside the workspace.

Preflight generates the native MCP registration and retains unrelated
registrations. It updates a shared `.agents/mcp.json` entry when it
recognizes the entry as toolkit-owned. Use the generated registration as
the source of truth. The complete examples show sample absolute paths.
For a manual merge, use the exact paths emitted by **your** preflight and
keep the existing registrations. The operator chooses the
provider, workspace, skill scope and any host trust approvals. The generated
launch fields need no manual input.

### Verify the installation

After setup, reopen the host if it was already running, then verify the server
in the intended workspace and ask it to call `migration_status` with a known
module and the absolute consumer working directory. A structured reply
confirms connectivity, even if the project has no registry yet. Verify that
the host can load both named skills. Preflight returns `commands` (each an
absolute executable followed by its script and any fixed arguments), `mcp`,
and both doctors. For terminal commands below, expand the named command
using that mapping and append the shown arguments. Quote paths containing
spaces and keep the consumer working directory. Use the returned
`artifact-migration-discover --doctor` to check engine prerequisites.

### Claude Code

Install and sign in to Claude Code. Run the project install from the consumer
workspace. Claude Code discovers `.claude/skills/<name>/SKILL.md` there, or
`~/.claude/skills/<name>/SKILL.md` with `--global`. First use registers
`.mcp.json` in the workspace for either skill scope. Approve that project
server when Claude asks. Use `claude mcp list` or `/mcp` to verify it.
Invoke `/start-migration auth` or `/migrate-artifact src/shared/money.ts`.

```bash
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit/tree/v1.9.0/skills --agent claude-code --skill start-migration migrate-artifact --copy --yes
```

```json
{
  "mcpServers": {
    "start-migration": {
      "command": "/usr/bin/node",
      "args": ["/home/dev/.local/share/artifact-migration-tools/1.9.0-11381459ae26c59122034a884eb4ead494356e39ba14fa50fd24e3ed7e24decc/packages/migration-engine/src/mcp-server.mjs"]
    }
  }
}
```

Use separate workspaces for Claude Code and Copilot. Claude's workspace
`.mcp.json` takes precedence over Copilot CLI's `.github/mcp.json` for this
server name. [Claude Code MCP](https://code.claude.com/docs/en/mcp).

### OpenAI Codex

Install and sign in to Codex. Trust the project so Codex loads its
`.codex/config.toml`. Codex discovers `.agents/skills/<name>/SKILL.md` in the
project or under your home directory with `--global`. First use writes the
workspace's `.codex/config.toml` even with personal skills. Use `codex mcp list`
and live `/mcp` to inspect the server and `/skills` to find the installed
skills. Ask `Use the start-migration skill for auth` or
`Use the migrate-artifact skill for src/shared/money.ts`.

```bash
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit/tree/v1.9.0/skills --agent codex --skill start-migration migrate-artifact --copy --yes
```

```toml
# BEGIN artifact-migration-tools
[mcp_servers.start-migration]
command = "/usr/bin/node"
args = ["/home/dev/.local/share/artifact-migration-tools/1.9.0-11381459ae26c59122034a884eb4ead494356e39ba14fa50fd24e3ed7e24decc/packages/migration-engine/src/mcp-server.mjs", "--without-relay"]
enabled_tools = ["artifact_status", "artifact_run", "migration_status", "migration_scan", "migration_evidence_binding", "migration_prefill", "migration_capture", "migration_app_runtime", "migration_pending_decisions", "migration_run"]
# END artifact-migration-tools
```

Codex launches with `--without-relay` and uses the explicit `enabled_tools`
list. Native review can present a candidate when the host supports it. For a
pending relay, use the engine's `artifact-migration-decision <module> --relay <reference> --decision APPROVE|REJECT`
command in the operator's terminal, with the operator's explicit choice.
[Codex MCP](https://developers.openai.com/codex/mcp/).

### OpenCode

Install OpenCode and configure a model provider. The Agent Skills CLI places
the project skill in `.agents/skills/<name>/SKILL.md`, which OpenCode discovers
alongside its native `.opencode/skills/`. With `--global`, the install uses
`~/.config/opencode/skills/<name>/SKILL.md`. First use registers project
`opencode.json`. Verify the connection with `opencode mcp list` and ask the
agent to load each skill by name. With this install, ask
`Use the start-migration skill for auth` or
`Use the migrate-artifact skill for src/shared/money.ts`. The bundle adapter
also installs `/start-migration` and `/migrate-artifact` command wrappers.

```bash
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit/tree/v1.9.0/skills --agent opencode --skill start-migration migrate-artifact --copy --yes
```

```json
{
  "mcp": {
    "servers": {
      "start-migration": {
        "type": "local",
        "command": ["/usr/bin/node", "/home/dev/.local/share/artifact-migration-tools/1.9.0-11381459ae26c59122034a884eb4ead494356e39ba14fa50fd24e3ed7e24decc/packages/migration-engine/src/mcp-server.mjs"],
        "codemode": false
      }
    }
  }
}
```

Use a host that supports `mcp.servers` and `codemode`.
[OpenCode skill discovery](https://opencode.ai/docs/skills/) and [MCP](https://opencode.ai/docs/mcp-servers/).

### GitHub Copilot in VS Code and CLI

Sign in to GitHub Copilot. Use a VS Code Agent session that supports workspace
MCP or an authenticated Copilot CLI. Use the toolkit's project scope for
both clients. The Agent Skills CLI installs project skills under
`.agents/skills/<name>/SKILL.md`, and the bundle adapter uses
`.github/skills/<name>/SKILL.md`. Copilot discovers both. Copilot can discover
personal skills (the Agent Skills CLI uses `~/.copilot/skills/`), while the
toolkit's Copilot adapter only supports project runtime registration.

```bash
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit/tree/v1.9.0/skills --agent github-copilot --skill start-migration migrate-artifact --copy --yes
```

Ask either client `Use the start-migration skill for auth` or
`Use the migrate-artifact skill for src/shared/money.ts`. The bundle adds
`.github/prompts/*.prompt.md` for slash invocation of those names in
supported VS Code agent chat. In VS Code, open **MCP: List Servers** in the
intended session, confirm `start-migration`, and test the status tool. In the Local harness, use the VS Code
workspace registration. For sessions that use the native Copilot harness,
check the selected session's server discovery and test the connected tool. [VS Code MCP controls](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers).

The installer writes `.vscode/mcp.json` for VS Code.

```json
{
  "servers": {
    "start-migration": {
      "type": "stdio",
      "command": "/usr/bin/node",
      "args": ["/home/dev/.local/share/artifact-migration-tools/1.9.0-11381459ae26c59122034a884eb4ead494356e39ba14fa50fd24e3ed7e24decc/packages/migration-engine/src/mcp-server.mjs", "--without-relay"]
    }
  }
}
```

The installer writes `.github/mcp.json` for Copilot CLI.

```json
{
  "mcpServers": {
    "start-migration": {
      "type": "stdio",
      "command": "/usr/bin/node",
      "args": ["/home/dev/.local/share/artifact-migration-tools/1.9.0-11381459ae26c59122034a884eb4ead494356e39ba14fa50fd24e3ed7e24decc/packages/migration-engine/src/mcp-server.mjs", "--without-relay"],
      "tools": ["artifact_status", "artifact_run", "migration_status", "migration_scan", "migration_evidence_binding", "migration_prefill", "migration_capture", "migration_app_runtime", "migration_pending_decisions", "migration_run"],
      "env": { "pnpm_config_pm_on_fail": "error" }
    }
  }
}
```

Trust the consumer folder before the first migration session. Start `copilot`
there interactively and approve the trust prompt, or add the workspace to
`trustedFolders` in `$COPILOT_HOME/config.json` (the default directory is
`~/.copilot`). Workspace trust is an operator choice. Verify with `/mcp show start-migration` in that trusted session.
CLI versions that expose `--trust-folder` also support trusting the
current directory for one new `copilot --trust-folder -p` session. Start
in the consumer, or use `--add-dir` for the consumer only. Both registrations launch `--without-relay`.
Copilot CLI additionally lists the allowed `tools`, while VS Code sees the
tools exposed by the relay-less server. Pending relays use the same
operator-terminal command as Codex. [Copilot CLI MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
and [Copilot skill discovery](https://docs.github.com/en/copilot/concepts/customizations/agent-skills).

### Explicit bundle adapter

For a verified local release bundle, run the provider installer **from the
extracted bundle**. The path below assumes the current directory is that
bundle. Replace paths with the selected root, external store and bundle, and
use the independently verified SHA-256 of `release-manifest.json` as the pin.
The example shows the v1.9.0 pin. Select the matching provider directory for
your host and use its scope and root from the table.
Use the same scope, root and store for `doctor`. To update a bundle-owned
installation, call `update` with the new verified bundle and pin.

```bash
node providers/codex/install.mjs install --scope project --root "/path/to/consumer" --store "/path/to/engine-store" --bundle "/path/to/verified-bundle" --pin "sha256:11381459ae26c59122034a884eb4ead494356e39ba14fa50fd24e3ed7e24decc"
node providers/codex/install.mjs doctor --scope project --root "/path/to/consumer" --store "/path/to/engine-store"
```

| Adapter | Project root and files | User root and files |
| --- | --- | --- |
| `claude` | Host-assigned plugin root with `skills/`, `.claude-plugin/plugin.json` and `.mcp.json` | Same plugin layout in the user-selected plugin root |
| `codex` | Consumer with `.agents/skills/`, `.codex/prompts/` and `.codex/config.toml` | Home with `.agents/skills/`, `.codex/prompts/` and `.codex/config.toml` |
| `opencode` | Consumer with `.opencode/skills/`, `.opencode/commands/` and `opencode.json` | Home with `.config/opencode/skills/`, `.config/opencode/commands/` and `.config/opencode/opencode.json` |
| `copilot` | Consumer with `.github/skills/` and `.github/prompts/`, plus both MCP files above | Project scope required |

Claude can load the adapter's plugin root with `claude --plugin-dir /path/to/plugin`
from the consumer workspace. The separate adapter doctor verifies ownership and resolved paths and can
restore missing owned MCP registrations. Check host connectivity afterward.
See the [bundle installer contract](phase-4-acceptance.md#installation-contract)
and [provider compatibility](../skills/start-migration/references/provider-compatibility.md).

## Runtime configuration

Set up applications when a mutating checkpoint requires runtime evidence.
A saved status lookup, a completed migration, or a module whose closed
discovery found no visible UI needs no application setup.

| Command action | What it does |
| --- | --- |
| `configure` | Reads declared endpoints, proves each running app, and saves verified endpoints if changed. Starts no process and grants no startup or sign-in authority. |
| `prepare` | Creates a missing local template and reports placeholders to complete. A valid existing file returns `CONFIGURED` without application probes. |
| `check` | Reads and validates the file and probes the apps. It writes nothing and starts nothing. A structurally valid file can report `RUNTIME_DOWN`. |
| `ensure` | Reuses proven listeners and starts only authorized apps whose ports are free. A missing file gets the same template as `prepare`. |
| `stop` | Stops only processes recorded as started by `ensure` in this namespace, after checking their identity. Operator-started or foreign listeners stay running. |

### Where to put the file

Use `.artifact-migration-tools/runtime-apps.json` in the consumer root. The
engine walks from the registry's target project up to its Git top level and
chooses the nearest directory containing a provider installer receipt. It
uses the target root if it finds no receipt. The version 2 file serves one
target, and its `TARGET.project` must be in that target root or equal to it.

Keep the file Git-ignored because it can authorize local process startup and
contains machine-specific bindings. Use `git check-ignore .artifact-migration-tools/runtime-apps.json`
from the consumer root. If needed, add `/.artifact-migration-tools/runtime-apps.json`
to the root ignore rules or local Git exclude. A tracked file is refused.
The toolkit creates a local ignore file when absent and preserves existing
ignore rules.

An existing version 1 file in the target root remains readable with its paths
relative to that root. When the target and consumer are the same directory,
both versions work at that one location. If copies exist in both roots,
probes and starts refuse and name both paths. To move a version 1 file when the
roots differ, stop toolkit-owned apps, copy the file to the consumer root as
version 2, rebase each `project`, restore authorization permissions, move the
old copy aside, and run `check`.

### Version 2 fields

| Property | Required | Value |
| --- | --- | --- |
| `version` | Yes | `2` |
| `namespace` | Yes | `win32` for native Windows, `wsl` for WSL, `linux` for native Linux, or `darwin` for macOS. Run the engine, apps and evidence browser in the same environment. |
| `applications` | Yes | `LEGACY` is the source frontend, `TARGET` is the destination frontend, and optional `BACKEND` is a separately probed API or service. |
| `origin` per app | Yes | Exactly `http://localhost:<port>`, `http://127.0.0.1:<port>`, or `http://[::1]:<port>`. Use a TCP port from 1 to 65535 excluding 80. Omit the trailing slash, URL path, query, fragment and credentials. |
| `project` per app | Yes | An existing directory relative to the root holding the configuration, such as `apps/target` or `.`. |
| `identity` per app | Yes | `{"route":"/runtime-id","includes":"example-target"}`. The public path begins with one slash and has no query or fragment. A successful HTTP response must contain the application-specific literal marker. The engine also proves the listener belongs to the configured project. |
| `start` per app | No | `{"manager":"pnpm","script":"dev"}` runs the named script in that project's manifest. Supported managers are `npm`, `pnpm` and `yarn`. Omit `start` for an app you run yourself. With `operator-local`, `{"command":["pnpm","run","dev"]}` also accepts an argument vector. Words cannot contain double quotes, `&\|<>^%!` or line breaks. |
| `startTimeoutMs` per app | No | Integer from 1 to 600000, default 60000. |
| `protectedRoute`, `signInPath` per app | No | App paths. The first probes whether a session is needed. The second identifies the browser sign-in page, and is required with `wait-for-operator`. |
| `onSignIn` per app | No | `record-gap` (default) or, under `operator-local` only, `wait-for-operator`. |
| `trust` | No | `operator-isolated` (default) or `operator-local`. |
| `sessionBroker` | No | Exactly `url` (`http://127.0.0.1:<port>`) and `tokenFile` (absolute path to the operator-provisioned client token). See the [session broker guide](session-broker.md). |

With `operator-isolated`, the operator can authorize a package script by
protecting the configuration with a different OS account and keeping it
read-only to the engine's account. An engine-owned or engine-writable file
cannot grant startup in this mode. Choose `operator-local` only as the
operator of a machine you control and accept that the engine account can
author startup and use a browser session. Git, namespace, app identity and
process ownership checks still apply. Starts use a limited environment.
Startup logs and ownership records are under `.artifact-migration-tools/app-runtime/`.

Identity and protected-route probes use unauthenticated HTTP. `AUTH_REQUIRED`
means the correct app is running and the route needs sign-in. An authorized
existing browser session can be reused. With `wait-for-operator`, log in
yourself in the open browser when asked and reply `continue`. With
`record-gap`, a missing authorized session is a runtime gap. The optional
isolated broker supports operator-provisioned sessions for automated captures.
Keep passwords, cookies and token values out of the configuration, chat and
migration evidence.

### Discover from package.json

`configure` reads the actual manifests at the registry's legacy and target
project roots. Each needs `config.startMigration.runtime.port` (an integer
from 1 to 65535 excluding 80) and `identity.route` and `identity.includes`.
The target can declare `runtime.backendProject`, a directory relative to the
target and inside the consumer root. That project's manifest needs its own
port and identity. The engine uses these declarations and tests the HTTP
response and local listener. Package scripts and arbitrary listening ports
are insufficient evidence.

These complete minimal manifests have illustrative ports and paths. Merge
the `config` fields into your actual manifests and keep their other settings.

#### Legacy frontend at apps/legacy/package.json

```json
{
  "name": "example-legacy",
  "private": true,
  "config": {
    "startMigration": {
      "runtime": {
        "port": 4111,
        "identity": {"route": "/runtime-id", "includes": "example-legacy"}
      }
    }
  }
}
```

#### Target frontend at apps/target/package.json

```json
{
  "name": "example-target",
  "private": true,
  "config": {
    "startMigration": {
      "runtime": {
        "port": 4113,
        "identity": {"route": "/runtime-id", "includes": "example-target"}
      }
    }
  }
}
```

#### Target frontend with a backend declaration

```json
{
  "name": "example-target",
  "private": true,
  "config": {
    "startMigration": {
      "runtime": {
        "port": 4113,
        "identity": {"route": "/runtime-id", "includes": "example-target"},
        "backendProject": "../backend"
      }
    }
  }
}
```

#### Backend at apps/backend/package.json

```json
{
  "name": "example-backend",
  "private": true,
  "config": {
    "startMigration": {
      "runtime": {
        "port": 4112,
        "identity": {"route": "/runtime-id", "includes": "example-backend"}
      }
    }
  }
}
```

Start the declared apps with your normal development commands, then use the
registered module's name. Here and below replace `auth` with your saved module
or canonical target. The commands use the installed preflight's mapping.

```bash
artifact-migration-validate auth --app-runtime configure
artifact-migration-validate auth --app-runtime check
artifact-migration-validate auth --app-runtime ensure
```

Run `ensure` only for runtime work. `configure` writes version 2 only if all
configured apps are `READY` or `AUTH_REQUIRED`, the file and paths pass
validation, and the proposed configuration is new or changed. `CONFIGURED` with
`changed: false` means the file already matches. When both frontend manifests
omit declarations, it returns `DISCOVERY_UNAVAILABLE`. Missing or malformed
declarations in just one required manifest return `CONFIGURATION_MISSING`.
A wrong namespace, wrong or unproven listener, or down app prevents a write.

Discovery uses `localhost` by default. It retains a valid existing loopback
host and preserves compatible operator settings and manually configured
backend entries. It drops an unused generated backend placeholder and
unresolved placeholder startup scripts. It refuses conflicting project
bindings, changes to a session-bound origin, and a change of origin while a
toolkit-owned process is still running there. For a changed existing file, the
reported `rollbackPath` contains its previous bytes. To roll back, stop any
affected toolkit-owned apps, restore those bytes locally with the intended
ownership and permissions, and run `check`.

## Configuration templates

### Generate a template when discovery cannot configure the apps

Use `prepare` when declarations are missing or the apps are down and you
need to fill in or review local settings. It creates the following template
only if the configuration is absent, returning `CONFIGURATION_MISSING` with
`configPath`, `templateCreated` and the `unresolved` field paths.

```bash
artifact-migration-validate auth --app-runtime prepare
```

```json
{
  "version": 2,
  "namespace": "REPLACE_WITH_NAMESPACE",
  "trust": "operator-isolated",
  "applications": {
    "LEGACY": {
      "origin": "REPLACE_WITH_LEGACY_HTTP_ORIGIN",
      "project": "REPLACE_WITH_LEGACY_PROJECT",
      "identity": {
        "route": "REPLACE_WITH_LEGACY_PUBLIC_ROUTE",
        "includes": "REPLACE_WITH_LEGACY_RESPONSE_MARKER"
      },
      "start": {
        "manager": "pnpm",
        "script": "REPLACE_WITH_LEGACY_PACKAGE_SCRIPT"
      }
    },
    "BACKEND": {
      "origin": "REPLACE_WITH_BACKEND_HTTP_ORIGIN",
      "project": "REPLACE_WITH_BACKEND_PROJECT",
      "identity": {
        "route": "REPLACE_WITH_BACKEND_PUBLIC_ROUTE",
        "includes": "REPLACE_WITH_BACKEND_RESPONSE_MARKER"
      },
      "start": {
        "manager": "pnpm",
        "script": "REPLACE_WITH_BACKEND_PACKAGE_SCRIPT"
      }
    },
    "TARGET": {
      "origin": "REPLACE_WITH_TARGET_HTTP_ORIGIN",
      "project": "REPLACE_WITH_TARGET_PROJECT",
      "identity": {
        "route": "REPLACE_WITH_TARGET_PUBLIC_ROUTE",
        "includes": "REPLACE_WITH_TARGET_RESPONSE_MARKER"
      },
      "start": {
        "manager": "pnpm",
        "script": "REPLACE_WITH_TARGET_PACKAGE_SCRIPT"
      }
    }
  }
}
```

Replace every retained `REPLACE_WITH_…` value with a verified local value.
Delete any `start` object for an app that you start separately. Remove the
entire `BACKEND` entry when unused. Keep `LEGACY` and `TARGET`. The operator
completes the file and selects any startup or sign-in authority. Run
`artifact-migration-validate auth --app-runtime check`, correct any refusal,
then resume the same saved migration. Its next invocation reads the existing
checkpoint and calls `ensure` when it needs runtime evidence.

### Ready-to-adapt runtime examples

All ports, directories, routes and markers below are illustrative. Replace
them with your actual app settings and verify that each marker is served
by the named project. Each block is a complete version 2 file.

#### A. Minimal legacy and target

```json
{
  "version": 2,
  "namespace": "linux",
  "applications": {
    "LEGACY": {
      "origin": "http://localhost:4111",
      "project": "apps/legacy",
      "identity": {"route": "/runtime-id", "includes": "example-legacy"}
    },
    "TARGET": {
      "origin": "http://localhost:4113",
      "project": "apps/target",
      "identity": {"route": "/runtime-id", "includes": "example-target"}
    }
  }
}
```

#### B. Legacy, backend and target

```json
{
  "version": 2,
  "namespace": "linux",
  "applications": {
    "LEGACY": {
      "origin": "http://localhost:4111",
      "project": "apps/legacy",
      "identity": {"route": "/runtime-id", "includes": "example-legacy"}
    },
    "BACKEND": {
      "origin": "http://localhost:4112",
      "project": "apps/backend",
      "identity": {"route": "/runtime-id", "includes": "example-backend"}
    },
    "TARGET": {
      "origin": "http://localhost:4113",
      "project": "apps/target",
      "identity": {"route": "/runtime-id", "includes": "example-target"}
    }
  }
}
```

#### C. Applications already running

This setup uses explicit IPv4 addresses and checks whether the target route
requires sign-in. Start the apps yourself before `check` or `ensure`.

```json
{
  "version": 2,
  "namespace": "win32",
  "trust": "operator-isolated",
  "applications": {
    "LEGACY": {
      "origin": "http://127.0.0.1:4111",
      "project": "apps/legacy",
      "identity": {"route": "/runtime-id", "includes": "example-legacy"}
    },
    "TARGET": {
      "origin": "http://127.0.0.1:4113",
      "project": "apps/target",
      "identity": {"route": "/runtime-id", "includes": "example-target"},
      "protectedRoute": "/partners",
      "signInPath": "/sign-in"
    }
  }
}
```

#### D. Authorized package-script startup

The operator of this example machine chose `operator-local`. Each project's
manifest defines a `dev` script that serves its declared port and identity
route. Run `ensure` after `check` validates the settings.

```json
{
  "version": 2,
  "namespace": "linux",
  "trust": "operator-local",
  "applications": {
    "LEGACY": {
      "origin": "http://localhost:4111",
      "project": "apps/legacy",
      "identity": {"route": "/runtime-id", "includes": "example-legacy"},
      "start": {"manager": "pnpm", "script": "dev"}
    },
    "TARGET": {
      "origin": "http://localhost:4113",
      "project": "apps/target",
      "identity": {"route": "/runtime-id", "includes": "example-target"},
      "start": {"manager": "pnpm", "script": "dev"},
      "startTimeoutMs": 90000
    }
  }
}
```

#### E. WSL development environment

Install and run the provider and Node in the WSL distro hosting the apps.
Use the browser in that environment. A forwarded Windows port alone cannot
prove the listener. This example assumes the operator starts the apps.

```json
{
  "version": 2,
  "namespace": "wsl",
  "applications": {
    "LEGACY": {
      "origin": "http://127.0.0.1:4111",
      "project": "apps/legacy",
      "identity": {"route": "/runtime-id", "includes": "example-legacy"}
    },
    "TARGET": {
      "origin": "http://127.0.0.1:4113",
      "project": "apps/target",
      "identity": {"route": "/runtime-id", "includes": "example-target"}
    }
  }
}
```


## Migration examples

The module examples use the sample layout above. Start at the consumer Git
root with a `package.json` there, committed source modules under the legacy
project, and a separate target project. Set up the registry once. In this
layout `apps/target/.agents/knowledge/migrations/registry.json` can contain
the following. The two roots are relative to the registry's directory.

```json
{
  "version": 1,
  "projects": {
    "legacy": { "root": "../../../../legacy" },
    "target": { "root": "../../.." }
  },
  "modules": {}
}
```

For the first module command in an unbound project, append
`--registry apps/target/.agents/knowledge/migrations/registry.json`. A confirmed
bootstrap persists the portable binding in the workspace manifest. With an
existing binding, omit `--registry` and keep the saved registry. The first three examples illustrate independent mappings. Run each against
the intended registry and target.

New modules use format 21. Existing format 19 records stay on their saved
appearance and direct-ledger decision rules. Format 20 also remains resumable.
Standalone artifacts use format 14. See
[format and recovery commands](command-reference.md#advanced-recovery-operations).

The commands below use Claude Code slash syntax. Use the equivalent
skill invocation for your provider above. For **fresh modules**, the
read-only status reports `NOT_STARTED` with a bound registry. The run
preflight reports `BLOCKED` / `NOT_STARTED` until initialization. The skill drafts the OpenSpec proposal and uses the
installed discover/bootstrap operation. Once binding and scope are settled,
AUTO supplies routine execution confirmations. After confirmed bootstrap,
the first actionable run reports `CONTINUE` with the next authoring request
or checkpoint. The skill uses the engine's
registry operation when the validated baseline needs registration. AUTO follows that request and continues within the current
agent turn. `COMPLETE` is a separate outcome after the final gates pass.

Genuine operator actions include supplying an unknown mapping or project
binding, completing runtime authorization or sign-in when required,
explicitly answering candidate reviews, and authorizing recovery when
the engine requires it. `OPERATOR_DECISION` pauses for the current candidate.
`BLOCKED` calls for the stated remedy, and `AWAITING_CONFIRMATION` is the STEP
preview outcome. See [all typed outcomes](command-reference.md#outcomes-and-errors).

### A. Same-name module

```text
/start-migration auth --target auth
```

Start with an unregistered `auth` source. After initialization, `CONTINUE`
selects `/start-migration auth`. The skill runs discovery and implementation
steps from the saved requests and pauses for actual operator decisions or
blockers. An existing matching registry mapping supplies the target, so
`/start-migration auth` alone is sufficient in that case.

### B. Renamed module

```text
/start-migration partners --target partner-registry
```

The source project has a `partners` module and the intended target is
`partner-registry`. After confirmed bootstrap, an actionable AUTO
`CONTINUE` carries the canonical target in its `continuation` object.

```json
{
  "module": "partner-registry",
  "mode": "auto",
  "command": "/start-migration partner-registry"
}
```

The agent follows that continuation without asking the user to retype it.
A later bare invocation uses `/start-migration partner-registry`. An
unregistered legacy spelling can also resolve when exactly one saved
record has it as its sole source. If more than one record matches, the
run reports `FAILED` with the alternatives and the operator selects the
intended canonical target.

### C. Multiple sources into one target

```text
/start-migration partner-registry --legacy partners --legacy suppliers
```

Both source modules must be present under the registered legacy project.
With `--legacy`, the positional name supplies the target. The engine
deduplicates and persists the source set, and `CONTINUE` names
`/start-migration partner-registry`. The agent follows the saved source set
on subsequent iterations. An unregistered source name such as `suppliers`
used alone produces `FAILED` and names the required target. A source of a
multi-source migration does not become an alias. If a registry mapping
conflicts with the request, resolve the reported conflict before proceeding.

### D. Resume an interrupted AUTO run

```text
/start-migration partner-registry
```

Use the canonical target, the same project binding, and the installed
toolkit identity authorized for the record. The skill reads saved status
first. For actionable `CONTINUE` it executes the next request in the same
turn, keeping completed work and evidence. If the engine instead reports
an operator decision, a runtime blocker or a toolkit identity mismatch,
resolve that exact condition and invoke the same target again. If
already `COMPLETE`, the run stops there.

### E. Check saved status

```text
/start-migration partner-registry --status
```

The saved registry binding and target locate the record. The status-only
skill reports the structured status and checkpoint, such as `ACTIVE` at
`DISCOVER_LEGACY` or `COMPLETE`, then stops without advancing or probing
apps. An unbound project reports `BLOCKED` / `NOT_STARTED`. To continue a
saved migration, reuse the canonical target without `--status`. An
unregistered source of a multi-source record or an ambiguous legacy spelling
is refused as described above.

### F. Migrate one artifact

```text
/migrate-artifact src/shared/money.ts --type utility --source-root apps/legacy --target-root apps/target
```

Run from the consumer root with the source file and both directories
present. The skill checks artifact status and uses the target root for
the saved artifact record. This example keeps the same path under the
target. After an actionable `CONTINUE`, the agent follows the artifact's
request and advances through its checkpoints. Review any pending
`OPERATOR_DECISION` and satisfy evidence blockers. Repeat the same
source and roots to resume that artifact, or append `--status` for a
read-only lookup. The artifact has its own identity and reaches
`COMPLETE` through its own gates.

## Troubleshooting

| Symptom or result | What to do |
| --- | --- |
| Host cannot find the skills | Check the selected agent, installed scope and skill directory, then reopen the host in the consumer. Use name-based invocation if you installed skills via the Agent Skills CLI and want a wrapper supplied only by the bundle adapter. |
| Host cannot see MCP | Run the installed preflight, open the workspace where it wrote the configuration, approve the host's workspace or server trust, and restart the host if required. Check its live server status and call the status tool. |
| Install or registration conflict | Check the named path and recorded root/store. Keep unrelated entries and use the original selection. Reuse a single host namespace per installation. A Claude root entry shadows Copilot CLI, so run those adapters in separate consumer workspaces. |
| `SKILL_SET_INCOHERENT`, `SKILL_IDENTITY_UNRELEASED` or `RELEASE_NOT_PUBLISHED` | Install both skills from the same published tag and rerun preflight. For an offline update blockage, reconnect once so the exact release can be verified. See [preflight refusals](../README.md#when-the-preflight-refuses). |
| `DISCOVERY_UNAVAILABLE` | Add verified manifest declarations for the required projects or use `prepare` and complete the local configuration. |
| `CONFIGURATION_MISSING` | Follow `reason`, `configPath` and any `unresolved` entries. Check the file's scope, version, Git tracking, paths, scripts and ownership, then rerun `check`. |
| `WRONG_NAMESPACE` | Run the engine, apps and browser in the file's declared namespace. |
| `WRONG_APP` or `IDENTITY_UNPROVEN` | Check the exact origin and address family, identity route and marker, and process owner or working directory. Use the real listener in this namespace. Leave foreign processes to their operator. |
| `RUNTIME_DOWN` | Start the intended app yourself or use authorized `ensure`. Read the role's `reason`, `startAuthorized` and any startup failure and log path. |
| `AUTH_REQUIRED` | Use an authorized session or follow the chosen sign-in policy. The public identity endpoint must still work without a session. |
| Registry binding or target conflict | Use the persisted registry and exact target. The engine prevents a conflicting registry override and rejects target and alias conflicts. See [registry resolution](../skills/start-migration/references/migration-contract.md#registry). |
