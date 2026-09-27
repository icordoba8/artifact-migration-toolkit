---
name: migrate-artifact
description: Start, resume, inspect, or finalize one standalone source artifact migration without a module registry or parent migration state. Use for /migrate-artifact requests involving a component, hook, utility, theme, contract, or other bounded artifact.
user-invocable: true
---

# Migrate Artifact

Run one validated standalone artifact iteration at a time. The persisted record,
not conversation memory or a module migration, owns progress and resume.

Before status or any other migration work, run this installed skill's shared
runtime preflight:

```bash
node <skill-directory>/scripts/runtime.mjs ensure --provider <claude|codex|opencode|copilot> --root <current-working-directory>
```

Use the provider running this invocation. A valid pinned receipt is reused with
no network access; otherwise the preflight installs and verifies the latest
stable immutable GitHub Release in the user release store, registers MCP, runs
the adapter and engine doctors, and returns absolute engine commands. Continue
this invocation with the returned `artifact-migrate` command (a host restart may
be needed before newly registered MCP is visible). Stop on preflight failure;
never use a checkout, branch, mutable `latest` URL, or ambient `PATH` instead.
An exact admin/CI override is available as `--version X.Y.Z` or
`ARTIFACT_MIGRATION_TOOLS_VERSION=X.Y.Z`; changing the provider runtime never
changes a migration record's `toolkitIdentity`.

```bash
artifact-migrate <primary-source> \
  [--source <additional-source>]... \
  [--type <type>] [--target <path>] \
  [--source-root <path>] [--target-root <path>] \
  [--status] [--mode auto|step] [--slice <id>] [--json]
```

`/migrate-artifact <source>` is the provider-facing equivalent. Defaults are
`--type artifact`, both roots at the current directory, and `--mode auto`.
The primary source identifies the artifact. Repeat `--source` for additional
exact files; the source binding contains only those paths. With matching roots
and no remapping, the target binding starts with the same path set. The source
binding remains frozen as legacy provenance while target files change in place.

## Protocol

1. Run `--status` first. If the record exists, resume exactly its active
   checkpoint and slice; do not inspect or recreate completed work. `--status`
   is read-only in both directions: it writes nothing, and it never runs
   target-controlled code — no package script, compiler binary or `node --check`
   — so the executable half of a checkpoint is reported under
   `validation.result.deferredExecution` instead of being run or trusted. The
   bare command runs those checks.
2. Run the bare command and read its typed `outcome`, `request`, and canonical
   `progress`. One invocation performs at most one transition.
3. Author only the paths named by `request.artifacts`, using
   `references/artifact-contract.md`.
4. Repeat only on `CONTINUE`. Stop on `AWAITING_CONFIRMATION`, `COMPLETE`,
   `OPERATOR_DECISION`, `BLOCKED`, or `FAILED`. `CONTINUE` means the next
   artifact is not authored yet; an engine fault is `BLOCKED`, and `--status`
   and the bare command always agree on that.

`DISCOVERY_COMPLETENESS` is where completeness is actually proven. The engine
runs the reference discovery scan scoped to the bound artifact and keeps every
relevant output it returns, so `completeness.json` must dispose of every
structural unit of the artifact's own files *and* every element the artifact
requires from outside its bound path — a shared utility, a stylesheet, an asset,
an i18n namespace, an external package, a runtime URL, or a reference the
scanner could not resolve. Omission is not an option: an undisposed element
holds the checkpoint, and the engine names exactly which ones are missing.

An external package is disposed `EXTERNAL_DEPENDENCY`, which is proved against
the target's own `package.json` rather than asserted. `FINALIZE` then re-proves
it and requires `gates.json` to carry `requirementEvidence`: one hashed,
migration-scoped target file per requirement claimed as carried across. A
stylesheet, asset, data file or runtime URL discovered here and never proved
there does not reach `COMPLETE`.

The standalone record lives at
`.agents/knowledge/migrations/artifacts/<artifact-id>/state.json` under the
target root. It never reads or writes module registry, baseline, parent, or
module state. Existing target behavior is resolved as `TARGET_REUSE`,
`TARGET_EXTEND`, or `MIGRATE_NEW`; reuse requires verified target evidence and
extend keeps every target-native row through finalization.

Visible UI requires hashed Playwright runtime records at `VERIFY_SLICES` and
fresh references to those records at `FINALIZE`. Each visible behavior declares
its required `runtimeStates`, and each runtime record carries an `origin`
(`LEGACY` or `TARGET`); the logical slot `origin::behavior::state` is captured
once. Provider/session labels are metadata, not freshness inputs. This workflow
can report pending operator decisions but intentionally exposes no approval API:
an operator decision is satisfied only by a matching line in the artifact's
append-only ledger, recorded through
`artifact-migration-decision --artifact <source> --type <type> --approve <id>` from a
trusted terminal or host elicitation — never by editing authored JSON.

Do not hand-edit `state.json`, `integrity.json`, or `history/history.ndjson`.

### Toolkit identity maintenance

The record's `toolkitIdentity` is maintained only through the toolkit's own
operator executable. On this axis the target is the artifact:

```bash
artifact-migration-toolkit status|adopt|update|rollback \
  --artifact <source> [--type <type>] [--source-root <path>] [--target-root <path>]
```

Exactly one identity target is accepted per invocation: `--artifact <source>`
here, or `--module <module>` [`--registry <path>`] for a module record.

An identity MISMATCH is reconciled through `artifact-migration-toolkit`, never
by manually editing persisted migration state. `status` is read-only: it writes
nothing, on any record, in any state. `state.json`, `integrity.json` and
`history/history.ndjson` are never hand-edited to reconcile toolkit identity.
`adopt`, `update` and `rollback` advance no checkpoint — resume the lifecycle
with its own command afterwards.

## Responsibility boundary

This engine owns exactly four things: its own lifecycle, its own inventories,
its own gates, and its own format axis (contract 1 / format 13 / workflow 1.0,
deliberately independent of the module engine's).

Everything else is **imported from the module core**
(`@artifact-migration-tools/migration-engine`, whose entry point is `core.mjs`)
and must never be reimplemented here:

| Concern | Owner |
| --- | --- |
| Mode vocabulary and option combinations | `migration-policy.mjs` (`MIGRATION_MODES`, `assertOptionCombination("artifact", …)`) |
| The closed outcome set and exit codes | `migration-policy.mjs` (`MIGRATION_OUTCOMES`, `exitCodeFor`) |
| Loop directives | `resumable-migration.mjs` (`renderLoopDirective`) |
| Two-phase confirmation | the agent, under `start-migration/SKILL.md` — never a regex in a CLI |
| Module locking | `module-lock.mjs` (`withModuleLock`) |
| Safe paths and atomic writes | `migration-utils.mjs` |
| Operator decision recording | `record-decision.mjs` — one gate, two ledgers |
| Progress projection | `resumable-migration.mjs` (`migrationProgress`, `renderProgress`) |
| Format-upgrade primitives | `format-upgrade.mjs` (`nextIncrement`, `classifyUpgrade`, `assertRegistryCoverage`, `upgradeProjection`) |

### Format upgrades on this axis

The artifact engine declares the same format-upgrade contract the module engine
does, on its own axis: `ARTIFACT_FORMAT_UPGRADE_FLOOR = 13`, which is exactly
the current `ARTIFACT_FORMAT_VERSION`. Because the floor *is* the runtime
format, no format is both at or above the floor and behind the runtime, so
`ARTIFACT_FORMAT_UPGRADERS` is legitimately empty and the `formatUpgrade` field
an artifact status returns is always `null` today. **Nothing about artifact behavior changes**: an artifact record at
format 13 performs no upgrade, and there is no historical 12→13 upgrader —
inventing one would claim a path this toolkit has never been able to walk.

The rule is prospective. The first artifact format bump — 13→14 — must ship with
exactly one registered adjacent upgrader, and the engine's own release gate owns
that requirement: `assertRegistryCoverage` fails the release until the row
exists, and no self-healing or promoting declaration buys a pass. Each future
artifact upgrader must explicitly declare `activation: null` when immediately
active, or an activation predicate and old-format prerequisite. An owed but
INACTIVE increment leaves normal lifecycle execution live until its prerequisite
is validated and pinned; an ACTIVE increment freezes it. `requiredInput` names
new material only after activation. The agent still never selects the transition.

A rule with two definition sites has two answers, and the second one is the one
nobody re-reads. This engine once carried its own loop renderer and could emit
`loop: STOP reason=CONTINUE` — a token outside the closed stop set — at the one
place the protocol requires a provider to obey literally. A contract test now
fails the build if any of these literals reappear in the artifact scripts.

The dependency direction is fixed: this engine imports the module core, and the
module core imports this engine lazily (to delegate a `SHARED_PREREQUISITE`) so
the static module graph stays acyclic. Never add a static import in that
direction.

## Provider Short-Circuit Invariant

`/migrate-artifact` MUST always enter the artifact engine/state machine. The
provider must never conclude "migration not needed", "nothing to port",
TARGET_REUSE, or TARGET_EXTEND **before** the engine reaches ASSESS_TARGET.

Provider reasoning or comments in target code are **evidence only**, never
authority for checkpoint progression or migration resolution. Only the engine's
validated inventories (source.json, target.json, completeness.json) and the
operator's ledger-backed decisions control resolution and completion.
