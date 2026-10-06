# artifact-migration-tools

The canonical, standalone source for the `start-migration` and `migrate-artifact`
skills and the one migration engine that implements them.

See the [migration command reference](docs/command-reference.md) for every
supported client, skill selection, invocation syntax, and Ponytail behavior.

## Supported targets

| Target | migrate-artifact | start-migration |
| --- | --- | --- |
| Claude Code | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` |
| Codex | `Use the migrate-artifact skill for src/shared/button.ts` | `Start migration auth using the start-migration skill` |
| OpenCode | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` |
| GitHub Copilot | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` |

`migrate-artifact` migrates one artifact into an existing target application.
`start-migration` starts a complete feature/module migration workflow.
GitHub Copilot slash prompts run in a supported IDE's agent chat.

`migrate-artifact` supports `--ponytail full` (Review evidence before `COMPLETE`)
and `--ponytail full-audit` (Review and Audit evidence in Review → Audit →
pre-commit review order). The command reference above has the details.

Release provenance is toolkit-owned: each bundle records this repository's
commit, version, and content hash in `release-manifest.json` and
`packages/migration-engine/build-identity.json`.

## Architecture

Core functionality must be self-contained and infrastructure-independent.
External services or privileged infrastructure may only provide optional
enhancements and must never be required for normal migration creation,
decision completion, format activation, testing, installation, or release.

New modules default to **format 19** (supported: 19); new standalone and
delegated artifacts default to **format 14** (supported: 14). Existing Module 18
and Artifact 13 records retain their historical semantics and explicit upgrades.

The built-in, versioned `STANDARD_LOCAL` policy records explicit operator
`APPROVE` / `REJECT` decisions as **AGENT_RELAYED**, directly in the hash-chained
ledger. The installed toolkit, repository runtime and current provider/terminal
are sufficient: no signer, protected policy, activation manifest, service,
hardware authenticator or network is required for standard decisions.

Optional protected high-assurance policy can require **HUMAN_ATTESTED** through
the retained WebAuthn signer and protected activation/store. That requirement
fails closed when unavailable, without a relayed fallback. Standard relayed
decisions never claim cryptographic human attestation.

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
pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit \
  --skill start-migration

pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit \
  --skill migrate-artifact
```

### What selects the runtime

**The installed skill's exact identity decides which toolkit release runs.**
Each installed skill carries a `release-identity.json` stating
`{name, version, skill, computedHash, source}` — plus `commit` and
`contentHash` when the skill itself came out of a release artifact. `version`
selects a candidate release; `computedHash` is the canonical digest of the
skill's own semantics (`SKILL.md`, `references/**`, `scripts/runtime.mjs`) and
is what *proves* the candidate carries them.

A release is acceptable only when all of these hold:

1. its manifest names `artifact-migration-tools`;
2. its `toolkit.version` equals the skill's `version`;
3. its `skills.skills[<skill>].computedHash` equals the skill's `computedHash`;
4. for `source: "release"`, its `toolkit.commit` and `toolkit.contentHash`
   equal the skill's.

**Matching SemVer is never sufficient on its own.** Installing a skill from a
repository checkout copies whatever is on that branch under an
already-published version string, so version equality proves nothing about
bytes. Rule 3 is mandatory in every case, and the only way to select a release
without it is an explicit `--version`, which is reported as
`skillIdentity: "unverified"`.

Because `skills add` is the sole owner of skill installation, that one action
also governs the engine, the MCP registration and every absolute runtime path —
verifiably, and with no second command to remember.

### Local first, offline first

The preflight consults four **local** sources before any network call, each
verified against its pinned `release-manifest.json` and then filtered by the
predicate above: the current receipt, the releases the receipt still retains for
rollback, sibling provider receipts in the same consumer, and the release store.
The predicate is fully checkable offline, so a mismatch never needs the network
to be *detected* — only to be fixed.

- A receipt that satisfies the installed skill is reused with **zero** network
  requests (`bootstrapped: false`, `network: false`). This is the steady state.
- A different required identity that exists in any local source converges
  **offline** (`network: false`).
- Only when the exact required release exists nowhere locally is the network
  used, and then only as the exact tag `v<version>`. The preflight never
  resolves `releases/latest`, and never installs a release other than the one
  the installed skill requires.

Resolution verifies the asset digest, the tag's single commit, the release
manifest, `SHA256SUMS`, every file and the toolkit identity before anything is
installed, and the exact release is retained outside the consumer repository.

### When the preflight refuses

Every refusal is typed, names both sides, and leaves the receipt, the release
store, the provider configuration and the MCP registration byte-identical. The
code is printed on stderr as JSON alongside the message.

| Code | Meaning |
| --- | --- |
| `SKILL_IDENTITY_MISSING` | The skill carries no usable `release-identity.json`, so no release can be proven to contain its semantics. |
| `SKILL_IDENTITY_LEGACY` | The stamp predates exact identity binding and states no `computedHash`. |
| `SKILL_IDENTITY_UNRELEASED` | The release at the required version proves a different digest for this skill — the skill's bytes were never published under that version. |
| `RELEASE_NOT_PUBLISHED` | No immutable release carries the required version. Never falls back to `latest` or to a previous version. |
| `RUNTIME_UPDATE_REQUIRED_OFFLINE` | The installed runtime does not satisfy the installed skill, the exact target is not available locally, and the network is unreachable. |
| `SKILL_SET_INCOHERENT` | Two installed skills require different releases of one provider's runtime. Refused rather than rewriting the runtime on alternating invocations. |

Every one of these is cleared by a first-class command, never by editing or
deleting a file: `skills add` for each skill, one connected run, or an explicit
`--version`. **Receipts under `.artifact-migration-tools/` are never meant to be
hand-edited or deleted**, and a hand-edited one is rejected rather than trusted.
An interrupted installation also recovers on its own: the install lock records
its owner, and a lock whose owner is provably dead on the same host is reclaimed
once and the installation re-verified from scratch. Anything ambiguous — a live
owner, another host, unreadable contents — still fails closed.

`.artifact-migration-tools/<provider>.json` records exactly this and nothing
else: installed-runtime state, the runtime-side skill identity, provider/MCP
ownership, rollback history, an optional rollback pin, and the skill
requirements already satisfied.

### Explicit selection and rollback

`--version X.Y.Z` on the installed preflight, and
`ARTIFACT_MIGRATION_TOOLS_VERSION=X.Y.Z`, are **one-invocation** admin/CI/
development overrides. They select that exact immutable release, deliberately
bypass the identity proof, report `selection: "explicit"` with
`skillIdentity: "unverified"`, and **persist nothing** — the next ordinary
invocation converges back to what the installed skill requires. A CI job that
wants a fixed version passes it on every run.

The explicit provider installer documented below remains available for local
bundles, updates and rollback; it is not the normal skill-install UX. Its
`rollback` is the **only** action that persists intent: it records
`pinned {version, by: "rollback", at, againstSkill}`, holds across ordinary
invocations while reporting `selection: "pinned"` every time, and is superseded
automatically when `skills add` changes an installed skill's `computedHash`.
That is also how a pin is cleared — there is no JSON to edit.

Nothing here depends on Docker, a virtual machine, a privileged service, an
external signer, a hardware authenticator or always-on network access. A
verified local runtime that satisfies its skill works offline indefinitely.

### Development checkout

A bare repository checkout has no installed skill stamp beside
`scripts/runtime-bootstrap.mjs`, so `ensure` with no arguments fails closed with
`SKILL_IDENTITY_MISSING` rather than resolving an arbitrary release. The two
supported paths are `--version X.Y.Z`, or the local-bundle installer
`node providers/<provider>/install.mjs install --bundle <path>`. The same
applies while editing a skill: until those bytes are published, the preflight
refuses to pair them with an older release (`SKILL_IDENTITY_UNRELEASED`), and
`--version` is the documented way through.

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

Toolkit version and migration format version are independent. Formats 4–19
(module) and 13–14 (artifact) are properties of the record; the toolkit version is
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
