# Artifact Migration Tools — Release Procedure

This repository owns the canonical `skills/**` and
`packages/migration-engine/**` sources. Consumer application gates are outside
this release contract.

Release identity (`scripts/release.mjs`, `build-identity.json`,
`release-manifest.json`) and toolkit-identity stamping landed in Phase 3; see
*Toolkit identity* below.

The CI and release boundary is defined in [CI and Release Architecture](ci-release-hardening.md).
Do not start release preparation from a commit whose Ubuntu CI is red.

The exact candidate SHA must have, before any release command runs:

| Check | Requirement |
| --- | --- |
| `ci / toolkit (ubuntu-latest)` | **SUCCESS** — required, blocking |
| `ci / toolkit (windows-latest)` | **executed and recorded** — advisory, non-blocking |

Windows is temporarily advisory because the repository has no certified green
Windows baseline and never had one; see
[Windows advisory status](ci-release-hardening.md#windows-advisory-status) for
why, the criteria to make it required again, and the bounded stabilization task
that owns the backlog. A known Windows portability failure does not block
publication during that period. Windows is **not** currently supported-green,
and no release note may claim it is.

GitHub required checks enforce the Ubuntu gate before merge; local
`release:check` cannot query or substitute for those checks.

### Release report

Every release report states both platforms, verbatim:

```
UBUNTU CI:  SUCCESS
WINDOWS CI: ADVISORY_FAILURE | SUCCESS
```

On `ADVISORY_FAILURE`, name the first failing step and test — e.g.
`first failure: pnpm engine:test — <suite> / <test name>`. A Windows job that
did not execute is a release blocker, not an advisory failure: rerun it.

## The three runners

| Runner | Command | Owns |
| --- | --- | --- |
| `node --test` | `pnpm engine:test` | the explicitly named engine suites under `packages/migration-engine/test/{unit,integration,external}` |
| `node --test` | `pnpm providers:test` | the explicitly named provider, release, portability and installed acceptance suites under `test/` |
| vitest | `pnpm engine:test:ts` | the TypeScript artifact filesystem/recovery specs under `packages/migration-engine/test/integration/artifact` |

`pnpm test` runs all three. The `node:test` suites drive real file locking,
atomic renames, `git ls-files` and child processes, which a jsdom environment
cannot host — so they stay on Node's runner and are named **explicitly** by their
script. An unnamed suite is an unrun suite. Adding a suite means adding it to a
runner in the same change; `P3-2` asserts every named suite exists and is not
git-ignored, and CI runs all three on both platforms.

The two provider-installation proofs now run in
`test/provider-installation.test.mjs`: R-W9-a starts the rendered installed MCP
entry and checks a retained consumer launcher; R-W9-c reports the installed
registration and retained Playwright/Figma entries without launching them.
The adapter never installs the consumer's browser/design services. The same
suite covers every supported provider/scope, exact pins, CLI/MCP identity,
update refusal, explicit identity update/rollback and ownership-safe removal.
See [Phase 4 acceptance](phase-4-acceptance.md) for the matrix and limitations.

## Release acceptance gate

Development CI runs dependency installation, provider projection, provider and
engine tests, TypeScript tests, and installed behavior on **both** Ubuntu and
Windows for the same commit. Ubuntu's result is the gate; Windows' result is
evidence recorded in the release report. If `MIGRATION_FORMAT_VERSION` or the
approval boundary changed, their owning tests remain part of that CI evidence. A
skill change must include generated provider trees and `skills-lock.json` in
that candidate commit.

After the candidate SHA is green on Ubuntu, prepare the release version and
generated stamps as a new commit, then require CI on that **exact new SHA**:
Ubuntu success, Windows executed and recorded. The previous commit's checks do
not transfer to the version commit.
For the green release SHA, run `pnpm release:check`, `pnpm release:build`,
`pnpm release:verify <staged-dir>`, and one installed smoke against the staged
bundle. These prove clean identity and packaging. Do not rerun the entire
development matrix locally for the same SHA; CI already ran it. Publish only
after the packaging checks pass, then run `pnpm release:record <version>` from
the published asset.

## Format bump

Bumping `MIGRATION_FORMAT_VERSION` requires editing **one constant plus one
table row**. If you find yourself editing a third place, the derivation is
broken — fix the derivation, not the third place.

1. Add the constant and its `usesX(state)` predicate in `resumable-migration.mjs`.
2. Add one row to `FORMAT_FEATURES`, highest-first.
3. If the bump is non-promoting, add it to `NON_PROMOTING_FORMAT_VERSIONS` with
   the reason at its definition.
4. Add one row to the `SKILL.md` compatibility table. `R-W10-a` parses that
   table and compares it against `SUPPORTED_FORMAT_VERSIONS`, so it cannot drift.

Then prove the bump did not disturb the previous format: `R-W10-b`/`R-W10-d`
run a full lifecycle on a prior-format fixture and assert it is stamped at its
own format, gains none of the new vocabulary, and is refused from the new
transition.

**Which kind of bump is it?**

- *Additive and derivable* → self-healing. The feature has a default an older
  record satisfies by omission. No explicit upgrade command. Formats 12–16.
- *New authored artifact, or a new lifecycle step* → non-promoting. The record
  runs the lifecycle it was born under, for its whole life. Formats 10 and 11.

Two different questions live here and must not be conflated: *may this record
run* (`formatIsSupported`) and *may an advance promote its stamp into this
format* (`formatIsPromoting`). Merging them makes every non-promoting format
unexecutable.

Toolkit version and migration format version vary independently. A toolkit
release never implies a format bump, and a format bump never implies a major
toolkit release.

## Approval boundary

Any change to `src/record-decision.mjs`, `src/mcp-server.mjs`'s elicitation
path, or `src/cli/run-migration.mjs`'s approval handling requires the full
`R-W2-*` set plus both integration specs under
`packages/migration-engine/test/integration/`.

Non-negotiable properties, each with an owning test:

- The elicitation schema stays a **required free-text field**, never an enum. An
  enum is answerable from the schema alone and can authorize multiple lines
  without an operator transcribing the challenge.
- `ask` stays an in-process function reference — never an argv option, an
  environment variable, or a tool argument.
- One recorder body serves both ledgers. Two copies of a security boundary is
  one more than can be reviewed at once.
- Refusal by *shape* as well as by name: an approval-shaped argument on any tool
  but `migration_run` is refused.

The confirmation phrase is a transcription barrier against schema-derived
auto-answers, **not** proof of humanity. Do not describe it to an operator as
more than that. The named upgrade path is a detached signature verified against
a key pinned at `RESOLVE`.

## Evidence and drift invariants

Never weaken these without a plan revision:

- Preserved failed attempts under `rework/<slice>-<n>/` are pinned in
  `artifactHashes` and released by **no** later transition, including
  `--refresh`. Deletion refuses as `REWORK_EVIDENCE_MISSING`; mutation refuses
  as a hash mismatch. The two are different forensics and stay distinguishable.
- `COMPLETE` means every modified target byte is attributable to a validated
  slice, an authorized rework, an authorized delegation, an engine-authored
  file, or a ledger-backed operator acceptance.
- Drift acceptance is an operator decision under the standard challenge phrase,
  bound to the path's SHA-256 — never a CLI flag. A flag is what turns a
  security boundary into a formality.

## The v5 upgrade contract is a hashed input

`src/upgrades/upgrade-migration.mjs` hashes `references/v5-contract.md` into
every upgrade transaction's `contractDigest`. That file is therefore **persisted
material, not documentation**: editing a byte changes a digest recorded in
consumer state. `packages/migration-engine/references/v5-contract.md` is the
runtime copy the engine reads; `skills/start-migration/references/v5-contract.md`
is the canonical operator-facing copy. They are asserted byte-identical by
`test/unit/v5-contract-parity.test.mjs`. Change both or neither.

## Versioning

`pnpm skills:lock` → `scripts/skills-lock.mjs` writes each canonical skill's
`release-identity.json` from the root manifest, then recomputes `skills-lock.json`
over each canonical skill directory (path **and** bytes, so a rename moves the
hash), so a downstream target can detect that a skill moved without diffing tens
of thousands of lines. `pnpm providers:test` fails if the committed lock and the
canonical bytes disagree, and `pnpm release:check` blocks if a committed identity
names a version other than the root manifest's. Bumping the toolkit version
therefore means re-running `pnpm skills:lock` and `pnpm providers:sync`, exactly
as a skill edit does.

The engine package release content hash is separate from the skill hashes; a
skill hash does not identify the engine package.

`released-versions.json` records only established published versions and their
payload `contentHash`, outside the payload hash itself. `release:check` and
`release:build` only read it: different payload bytes cannot claim an established
version, even with `--allow-dirty`; identical bytes and unregistered versions
pass this check. Building a candidate never reserves its version.

After external immutable publication, run `pnpm release:record <version>` to
resolve and digest-verify the published asset and read only its manifest through
tar stdout. The recorded hash comes from `release-manifest.json#toolkit`, whose
version, name and commit must match the publication. This is the sole registry
writer: identical records are byte-preserving no-ops; conflicting hashes fail
without mutation. Working-tree bytes are never publication evidence.

### Per-skill release identity

`skills/<name>/release-identity.json` is how an *installed* skill states what it
is, without the engine running. It exists because `skills add <repo>` copies the
committed tree: a stamp rendered only at packaging time would install as a
literal `{{TOOLKIT_VERSION}}`, so the committed copy carries real values —
`name`, `version`, `skill`, and `source: "repository"`.

`commit` and `contentHash` are **absent** from the committed copy, not held as
placeholders. Neither is knowable while writing the file: the commit contains it,
and it is an input to the content hash. `scripts/release.mjs` adds both to the
staged copy and flips `source` to `"release"`, deriving that copy from the
committed one so a packaged skill cannot name a different release than the tree
it came from. That derivation is what keeps the identity acyclic, and `source` is
what tells an operator which of the two they are looking at.

## Toolkit identity

A built toolkit has one immutable identity — `name`, `version`, `commit`,
`contentHash` — written to `build-identity.json` beside the engine's `src/` at
packaging time and never committed. A source checkout has no such file and is
*unidentified*: it may read, validate and report on any record, and may mutate
none. It cannot prove it is the release a stamped record pinned, and it has no
identity to adopt onto an unstamped one.

`pnpm release:build` stages `dist/<name>-<version>/` from the committed tree,
renders the four provider-manifest placeholders, and writes
`release-manifest.json` plus `SHA256SUMS`, then creates the sole bootstrap asset
`dist/artifact-migration-tools-v<version>.tar.gz`. Publish that asset only on a
stable GitHub Release whose immutable flag is enabled; the first-use bootstrap
refuses mutable releases and assets without GitHub's SHA-256 digest.
`pnpm release:verify <dir>` re-hashes
a staged bundle against its own manifest. `pnpm release:check` is the local
identity gate: a clean tree, agreeing versions, fully committed payload. The
required GitHub checks are separate evidence for that exact SHA.

The content hash is **acyclic**. Inputs: canonical skills, engine payload,
lockfile, and the committed provider payload with its placeholders *unrendered*.
Everything identity-bearing is derived afterwards and is never an input, so no
committed file contains the hash it contributes to. `providers:check` is
unaffected: it compares committed generated output, which still carries
placeholders.

### The compatibility contract

| Record | Behavior |
| --- | --- |
| Unstamped, read-only status/validation | reads, reports `UNSTAMPED`, writes nothing |
| Unstamped, mutation under a *released* toolkit | fails closed, naming one adoption command |
| Unstamped, mutation under a source checkout | fails closed — a checkout has no identity to adopt, so it is told to install a release rather than given a command that cannot succeed |
| Stamped, exact match | proceeds |
| Stamped, any field differs | status may report `MISMATCH`; every mutation and approval blocks before a write |
| Explicit update/rollback | a separate locked maintenance operation between two immutable releases |

Adoption, update and rollback run under the **existing** record lock, journal
and integrity transaction, append exactly one `TOOLKIT_IDENTITY_ADOPTED` /
`TOOLKIT_IDENTITY_CHANGED` event, and then **stop** — the lifecycle resumes on
the next invocation. They move no step, slice or pin and touch no decision id,
sequence, rationale digest, decision digest or ledger hash. Identity is anchored
by the append-only history, not by `state.json` alone: replay derives the final
identity from the events and compares it with the persisted field, and the
integrity anchor pins its digest outside `state.json`.

Toolkit SemVer stays independent of every migration version. A toolkit release
never implies a format bump and a format bump never implies a toolkit release;
`test/unit/toolkit-identity.test.mjs` asserts the identity module reads no
migration version constant in either direction.

Owning suites: `packages/migration-engine/test/unit/toolkit-identity.test.mjs`
(identity semantics, adoption, mismatch, update/rollback, lock serialization,
release identity) and
`packages/migration-engine/test/external/format-17-acceptance.test.mjs` (an
installed bundle against a scratch consumer in a path with spaces, containing no
engine source: unstamped resume through adoption, decisions and MCP, plus
upgrade preview/execute, interrupted-upgrade recovery, rollback, and interrupted
artifact journal recovery).

## Sign-off

| Change | Reviewer |
| --- | --- |
| Format bump | Engine owner + one reviewer who did not write it |
| Approval boundary | Engine owner + security review |
| Provider generation / `providers-sync.mjs` | Engine owner |
| Docs, tests, CI only | One reviewer |
