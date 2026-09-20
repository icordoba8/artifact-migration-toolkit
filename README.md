# artifact-migration-tools

The canonical, standalone source for the `start-migration` and `migrate-artifact`
skills and the one migration engine that implements them.

Release provenance is toolkit-owned: each bundle records this repository's
commit, version, and content hash in `release-manifest.json` and
`packages/migration-engine/build-identity.json`.

## Architecture

| Concern | Owner |
| --- | --- |
| Module migration protocol | `skills/start-migration/**` |
| Artifact migration protocol | `skills/migrate-artifact/**` |
| Lifecycle, state, decisions, integrity, resumability, upgrades, evidence, MCP runtime | `packages/migration-engine/**` |
| Registry, records, locks, journals, evidence, project binding | **the consumer repository** |

The engine is provider-neutral and location-independent. It renders every
operator-facing command against its own installed location
(`src/engine-paths.mjs`), so an engine installed outside the repository it
migrates still prints commands that exist and run — including from an
installation path containing spaces.

Nothing under `packages/migration-engine/src/**` imports from `skills/**` or
from a consumer repository. The one runtime asset the engine reads,
`packages/migration-engine/references/v5-contract.md`, lives inside the package
because its bytes are hashed into every upgrade transaction's `contractDigest`.

### Layout

```text
skills/
  start-migration/{SKILL.md,references/}     canonical module protocol
  migrate-artifact/{SKILL.md,references/}    canonical artifact protocol
packages/migration-engine/
  src/                    9 shared modules
  src/cli/                5 command entry points
  src/upgrades/           upgrade preview/execute/recover/rollback + the v4->v5 transform
  src/artifact/           the artifact state machine and its CLI
  references/             v5-contract.md, hashed into contractDigest
  test/unit/              contract, policy, decision, registry, MCP, discovery, artifact
  test/integration/       cross-engine delegation and operator-approval authority
  test/external/          external-installation and rendered-command proofs
providers/
  {claude,codex,opencode,copilot}/   generated skills, wrappers, MCP + adapter manifests
  generated-files.json               the ownership manifest; the only deletable set
scripts/
  providers-sync.mjs      the one generator; `--check` is the verifier
  skills-lock.mjs         path-and-byte hashes for both canonical skills
test/providers-sync.test.mjs  provider projection, ownership, and parity
docs/release.md           release gate, format-bump and approval-boundary rules
```

## Install

Normal users install either skill with the standard Agent Skills CLI:

```bash
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-tools \
  --skill start-migration

pnpm dlx skills add https://github.com/icordoba8/artifact-migration-tools \
  --skill migrate-artifact
```

On first use, the installed skill's small `scripts/runtime.mjs` preflight
resolves the latest stable immutable GitHub Release, verifies its asset digest,
tag commit, manifest, `SHA256SUMS`, files and toolkit identity, then delegates
installation and MCP registration to the release's provider adapter. The exact
release is retained outside the consumer repository. Later invocations validate
and reuse that receipt without network access. `skills add` remains the sole
owner of skill discovery and installation.

For an exact admin/CI selection, invoke the installed preflight with
`--version X.Y.Z` or set `ARTIFACT_MIGRATION_TOOLS_VERSION=X.Y.Z`. The explicit
provider installer documented below remains available for local bundles,
updates and rollback; it is not the normal skill-install UX.

### Development checkout

Requires Node >= 22 and pnpm 11.21.0.

```bash
pnpm install --frozen-lockfile
```

The pinned discovery parser (`ts-discovery-compiler`, an alias for
`typescript@5.9.3`) is declared by `packages/migration-engine/package.json` and
resolves from the package's own `node_modules`, never from the analyzed
project's compiler. The scan runs the classic Node-hosted TypeScript API, which
a TypeScript 7+ project no longer ships, so a target's own compiler cannot stand
in for it.

### Executables

Installing the engine package exposes nine commands, one per existing entry
point. They take exactly the arguments the underlying modules already took.

| Command | Entry module |
| --- | --- |
| `artifact-migration-discover` | `src/cli/discover-module.mjs` |
| `artifact-migration-run` | `src/cli/run-migration.mjs` |
| `artifact-migration-advance` | `src/cli/advance-migration.mjs` |
| `artifact-migration-validate` | `src/cli/validate-migration.mjs` |
| `artifact-migration-registry` | `src/cli/update-migration-registry.mjs` |
| `artifact-migration-decision` | `src/record-decision.mjs` |
| `artifact-migration-upgrade` | `src/upgrades/upgrade-migration.mjs` |
| `artifact-migrate` | `src/artifact/run-artifact.mjs` |
| `artifact-migration-mcp` | `src/mcp-server.mjs` |

There is no dispatcher and no wrapper framework. `node <path-to-module>` remains
equally valid, and is what the engine itself renders in operator-facing output.

## Consumer state stays in the consumer

Run every command from the repository being migrated. The engine resolves the
registry, project binding, records, locks, journals and evidence from the
operator's working directory, never from its own installation ancestor. A
consumer repository needs **no** copy of this engine:

```text
<consumer>/.agents/knowledge/migrations/
  registry.yaml|json
  modules/<module>/{state.json,history.jsonl,decisions.jsonl,evidence/,rework/}
  artifacts/<id>/...
  locks/  init/  upgrades/
```

Those paths are consumer-owned. This toolkit never normalizes, repairs, or
relocates them.

## Pinning

Install one exact version. A mutable branch, a `latest` tag, or an ambiguous
`PATH` lookup makes it impossible to say which implementation wrote a record.
Later phases stamp the resolved toolkit identity (name, version, commit,
content hash) into each record and refuse to mutate a record whose pinned
identity differs from the running toolkit; until then, pin by commit yourself.

Toolkit version and migration format version are independent. Formats 4–17
(module) and 13 (artifact) are properties of the record; the toolkit version is
a property of the implementation.

## Tests

```bash
pnpm engine:test      # 15 node:test suites, named explicitly
pnpm engine:test:ts   # the two TypeScript artifact filesystem/recovery specs
pnpm providers:test   # provider projection, ownership, and parity
pnpm test             # all three
```

Both runners are mandatory, and both are required on Linux **and** Windows: the
engine drives real file locking, atomic renames, `git ls-files`, and child
processes, and Windows has no `flock`.

An unnamed suite is an unrun suite. Adding a suite means adding it to
`engine:test` in the same change.

Proofs owned by a later phase stay inside their own suite rather than in a
separate directory: `test/unit/migration-contract.test.mjs` declares a local
`deferred = (name, fn) => test.skip(...)` helper and reports as
`[deferred to provider installation] …`. Two remain, both about MCP registration
reporting rather than generation — a committed template carries a placeholder, so
there is no launchable entry point to assert against until an adapter renders
one, and the consumer's own Playwright/Figma servers stay the consumer's. The
comment above the helper names each one's owner.

## Provider boundary

Provider adapters (Claude, Codex, OpenCode, GitHub Copilot) install a pinned
toolkit, expose generated skill documents and thin command surfaces, and render
provider-specific MCP launch configuration. **No provider may implement
migration transitions, decisions, validation, record mutation, or recovery.**

```bash
pnpm providers:sync    # regenerate all four trees and the ownership manifest
pnpm providers:check   # verify they regenerate byte-identically; writes nothing
pnpm skills:lock       # recompute skills-lock.json
```

Generated provider trees contain **no engine source**: `providers-sync.mjs`
refuses executable modules other than the byte-identical runtime preflight each
independently installable skill must carry. Each tree holds `SKILL.md`, the
skill's references and preflight, at most one thin wrapper per invocable skill,
one MCP template, and `adapter.json`. Claude gets no wrapper — its skill is
directly user-invocable.

`providers/generated-files.json` is the ownership manifest and the **only** set
of paths a sync may delete. Hand-authored files under `providers/**` survive
synchronization; a stale generated file is removed only if the previous manifest
claimed it.

Each `providers/<provider>/adapter.json` records that adapter's owned files, the
engine package it pins, and the install scopes its host documents — with release
identity left as `{{TOOLKIT_VERSION}}` / `{{TOOLKIT_COMMIT}}` /
`{{TOOLKIT_CONTENT_HASH}}` and the MCP entry point as `{{ENGINE_MCP_ENTRY}}`.
Identity is injected while packaging an already committed tree, so no committed
file carries it, and `providers:check` compares templates rather than rendered
artifacts. A scope recorded as `null` is one the provider does not document; an
installer must refuse it rather than choose somewhere plausible. See
[`skills/start-migration/references/provider-compatibility.md`](skills/start-migration/references/provider-compatibility.md)
for the scope table and the merge rules for consumer-owned host configuration.
