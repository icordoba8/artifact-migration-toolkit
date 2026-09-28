# Standalone Artifact Contract

All JSON documents reject unknown keys. Paths are relative to the declared
source root, target root, or artifact record root as stated below. Every
`sha256` is the current file digest. Version is `1` for every authored file.

## Checkpoints

| Checkpoint | Authored file(s) |
| --- | --- |
| `RESOLVE` | Engine bootstrap only |
| `DISCOVER_LEGACY` | `inventories/source.json` |
| `DISCOVERY_COMPLETENESS` | `inventories/completeness.json` |
| `ASSESS_TARGET` | `inventories/target.json` |
| `BUILD_BASELINE` | `matrices/parity.json`, `target-native.json`, `design-system.json`, `global-contract.json` |
| `PLAN` | `slices/index.json` |
| `IMPLEMENT_SLICES` | `slices/<slice>.json` |
| `VERIFY_SLICES` | `evidence/<slice>/result.json` plus its `ui/` files |
| `FINALIZE` | `gates.json` |

## Inventories

`source.json` owns `artifactId`, `hasVisibleUi`, exhaustive `sourceFiles`,
`behaviors`, `globalContracts`, `featureLocalVisuals`, and existing
`operatorDecisions`. Behavior and visual evidence uses
`{path, sha256, status:"VERIFIED"}` against the source root. A visible behavior
also declares its required `runtimeStates` (a subset of the engine's
`UI_RUNTIME_STATES`). A global contract
uses `{id, kind, sourcePath, consumers}`; all consumers must later appear in
the global-contract matrix. Feature-local visual IDs are forbidden there.

Each `operatorDecisions` row is `{id, subject, decisionId?}`. It has no `status`
field: a row is satisfied only when its `decisionId` names a ledger line in
`decisions/operator-decisions.ndjson` whose recomputed candidate matches the
row's subject and the current source binding. Record one with
`record-decision.mjs --artifact <source> --type <type> --approve <candidate-id>`;
editing this JSON never approves anything.

`completeness.json` is `{version, sourceFiles, units, requirements}`. All four
keys are required; `sourceFiles` repeats the source inventory exactly.

`units` is the **structural census**, and it is unconditional — it does not
depend on whether any global contract was declared. The universe is every unit
of every `sourceFiles` entry plus every `globalContracts[].sourcePath`. A script
file's units key as `<file>#<binding>` (a binding name is unique only inside its
own file); any other file is one unit keyed by its path. Every censused unit
must appear exactly once.

`requirements` is the **source requirement graph**: every element the artifact
requires from outside its own bound path, plus every reference the scanner could
not decide. The engine derives it by running the reference discovery scan scoped
to the bound artifact and keeps **every** relevant scanner output -- `supporting`,
`external`, `unresolved`, `findings` and `runtimeUrls` -- so a shared utility, a
stylesheet, an asset, an i18n namespace, an npm package or a runtime URL the
artifact reaches into is named here or the checkpoint does not advance. Each row
is `{element, disposition, ref?, rationale?}`. An `element` is either a
source-relative path or a reference token:

| Element form | Means |
| --- | --- |
| `<source-relative path>` | A resolved file the artifact requires. It must still be a readable regular file, or the checkpoint is `BLOCKED`. |
| `EXTERNAL <spec>` | An external package the artifact imports. |
| `RUNTIME_URL <file>:<line> <spec>` | A URL the artifact loads at runtime. |
| `UNRESOLVED <from>:<line> <spec>` | A first-party reference the scanner could not resolve. |
| `<FINDING_TYPE> <file>:<line> <spec>` | A reference the scanner could not decide. |

Every element must appear exactly once, and the checkpoint names exactly which
elements are missing when one does not.

Both lists use the same nine dispositions: `MIGRATED_BEHAVIOR` and
`FEATURE_LOCAL` name a real behavior/visual id, `TARGET_NATIVE_EQUIVALENT` names
a `targetNative` row that is settled at `ASSESS_TARGET`, `NOT_APPLICABLE`
requires a `rationale`, `EXTERNAL_DEPENDENCY` names the required package, and
`LEGACY_DEFECT`, `INTENTIONAL_FIX`, `INTENTIONAL_DESIGN_ADAPTATION` and
`DO_NOT_MIGRATE` each require a satisfied ledger decision. Nothing is droppable
by omission: a missing unit or requirement holds the checkpoint.

`EXTERNAL_DEPENDENCY` is the only disposition that keeps an `EXTERNAL <spec>`
element, and the only element it may dispose of. The artifact does not carry the
package, so the target must: `ref` is the package name (`@scope/name` for a
subpath import) and the target root's `package.json` must declare it in
`dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies`.
This is re-checked at `FINALIZE`, so a dependency dropped after this checkpoint
cannot ride an old approval into a `COMPLETE` record. An external element may
otherwise only be `NOT_APPLICABLE` or one of the four ledger-backed
dispositions; `MIGRATED_BEHAVIOR`, `FEATURE_LOCAL` and
`TARGET_NATIVE_EQUIVALENT` name things inside this artifact and are refused.

`target.json` owns `artifactId`, `resolution`, `targetFiles`, `targetNative`,
and per-behavior target `evidence`. `TARGET_REUSE` requires verified evidence
for every behavior. `TARGET_EXTEND` requires verified target-native rows.
`MIGRATE_NEW` requires the bound target artifact to be absent unless it is a
bound in-place source path, and has no
target-native rows. For `TARGET_REUSE`/`TARGET_EXTEND`, `targetFiles` must
include the bound target path, and every `targetNative[].path` and every
`evidence[].path` must be one of the declared `targetFiles`: reuse is proven
against the bound artifact, never laundered through an unrelated file.

## Matrices And Slices

Parity rows contain `id`, `behaviorId`, `resolution`, `status`, and
`targetEvidence`. Target-native rows contain `id`, `path`, `description`,
`status`, and `evidence`. Design-system rows contain `id`, `behaviorId`,
`scope`, `targetComponent`, `requiredComponent`, `status`, `evidence`, and
nullable `decisionId`. A row whose `targetComponent` differs from its
`requiredComponent` is writing something new instead of reusing the required
primitive; that is an exception, so the row must be `EXCEPTION_RECORDED` with a
satisfied ledger decision. Global-contract rows contain `id`, `sourceContractId`,
`kind`, `targetPath`, complete `consumers`, `status`, and `evidence`.

The plan is `{version, slices:[{id, behaviorIds, dependsOn, kind}]}`. Kinds are
`REUSE`, `EXTEND`, or `NEW` and must match the chosen resolution. Every behavior
belongs to exactly one slice.

An implementation is
`{version,sliceId,status:"COMPLETE",changedFiles,checks,preservedTargetNativeIds}`.
Changed files are `{path,sha256}` against the target root. Generic checks remain
`{command,status:"PASS"}` but never establish executable-code coverage. A code
validator check is `{validator,status:"PASS"}`, where `validator` is either
`{kind:"TYPESCRIPT",project:"tsconfig.json"}` or
`{kind:"NODE_CHECK",file:"path/to/file.js"}`. Reuse changes no files. Extend
lists every preserved target-native ID.

For executable code (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`), the trusted
runner owns the actual validator command and produces structured evidence with
the validator kind, executed command, exit code, covered changed files, verified
project scope, and diagnostics. TypeScript project membership comes from the
compiler's parsed configuration, so excluded files are not covered. Every
changed code file needs successful evidence. A failed TypeScript project check
is accepted only when every diagnostic names an unrelated file.

A generic `{command,status:"PASS"}` check still cannot claim code coverage, and
it is no longer taken on trust either: when the command names one of the target's
own package scripts (`npm|pnpm|yarn run <script>` declared in the target
`package.json`) the engine runs it in the target root and refuses the checkpoint
unless it exits `0`. A command that names no runnable script stays a prose claim.
Pair either with a trusted validator check when code changed. A check the engine
cannot execute at all -- a spawn failure, a killing signal, output that overruns
the engine's buffer -- is an engine fault and reports `BLOCKED`, never `CONTINUE`.

A changed file may never sit under a provider, generated or dependency path
(`.agents/`, `.claude/`, `.codex/`, `.github/`, `.opencode/`, `node_modules/`,
`dist/`, `.next/`, `coverage/`, build and report output). Those trees are
excluded from the target binding, so drift inside one would be invisible to every
later freshness check.

## Runtime Evidence

A verification result is
`{version,sliceId,status:"PASS",checks,runtimeEvidence}`. Checks cover every
slice behavior and carry verified target evidence. Each visible source behavior
declares its required `runtimeStates[]` (a subset of the module engine's
`UI_RUNTIME_STATES`). For visible behavior, `runtimeEvidence` has one row per
logical observation, whose identity is `origin + behaviorId + state`:

```json
{
  "behaviorId": "B-1",
  "origin": "TARGET",
  "state": "DEFAULT",
  "route": "/example",
  "viewport": { "width": 1280, "height": 720 },
  "actions": [{ "kind": "click", "target": "Save", "expected": "saved", "actual": "saved", "status": "PASS" }],
  "artifacts": [
    { "kind": "ACCESSIBILITY_SNAPSHOT", "path": "evidence/slice/ui/state.md", "sha256": "..." },
    { "kind": "SCREENSHOT", "path": "evidence/slice/ui/state.png", "sha256": "..." }
  ],
  "boundTo": { "sourceDigest": "...", "targetDigest": "...", "sliceDigest": "..." },
  "provider": "playwright",
  "sessionId": "optional metadata"
}
```

`origin` is `LEGACY` or `TARGET`. `state` must be one the behavior declares. The
logical slot `origin::behaviorId::state` is captured at most once per slice, and
every `(visible behavior × declared state)` pair must be captured for `TARGET`.
Byte-identical images across distinct slots (including matching `LEGACY`/`TARGET`
captures) stay legal — a persisted capture file is identified by its path, not
its SHA, so the same capture file may not be reused across two logical slots.

`provider` and `sessionId` are excluded from the semantic evidence hash and do
not decide freshness. File hashes and `boundTo` do.

This artifact record keeps the `ACCESSIBILITY_SNAPSHOT` shape above. The
`playwright-ui-proof/v1` structured proof (state observations, `postAction`
evidence per interaction) and `ACTIVE` `--reopen-ui` recovery apply to module
migrations; see `start-migration/references/migration-contract.md`.

## Finalize

`gates.json` is `{version, gates, uiEvidence, requirementEvidence}` and contains
exactly the canonical seven migration gates, each
`{name,status:"PASS",evidence}`. Gate evidence is a target-root
`{path,sha256,boundTo:{sourceDigest,targetDigest}}`, and its `path` must be one
this migration changed in a slice, declared in `target.json`, or the bound
target itself. A hash of an unrelated pre-existing file proves nothing and is
refused.

For a record created with `--ponytail full`, the `SIMPLIFY_ONCE` gate also
requires `ponytailEvidence` of the form
`{kind:"review",path,sha256,boundTo:{sourceDigest,targetDigest},producedAt}`.
The path must be `.agents/knowledge/migrations/artifacts/<artifact-id>/evidence/ponytail-review.md`
under the target root. `--ponytail full-audit` additionally requires the same
shape with `kind:"audit"` on `PRECOMMIT_GATE`, pointing to
`evidence/ponytail-audit.md` in that artifact record. That gate must also carry
`reviewedAt`. Both timestamps are canonical ISO timestamps. Run the Audit after
verification; the engine requires Review before Audit and Audit before
`reviewedAt`.
The engine checks each evidence file's current hash and source/target binding
before allowing `COMPLETE`. No Ponytail flag adds no Ponytail requirement.

Two gates carry the mandatory architecture rules they are named after, asserted
against this migration's changed files only:

- `ARCHITECTURE_IMPLEMENTATION_GATE` — every touched `src/features/<feature>/`
  has `domain/` and `application/` (MR-2); a changed `*.query-keys.ts` sits at
  `src/features/<feature>/infrastructure/<feature>.query-keys.ts` (MR-4); no
  changed file imports another feature past its `index` (MR-7).
- `PRECOMMIT_GATE` — no changed `.tsx` carries visible text as a JSX text node
  or as a literal `label`/`title`/`placeholder`/`aria-label`/`alt` prop, since
  visible text belongs in an i18n namespace (MR-3); no changed file co-locates a
  `*.test.*`/`*.spec.*` under `src/` (MR-6).

A gate whose rule is violated cannot be declared `PASS`, whatever its evidence.

Finalization also refuses target code that still resolves into the legacy tree,
from anywhere under the target root and through any reference form — static
`import`/`export`, `import =`, dynamic `import()` and `require()` — including
files the target `tsconfig` does not include. When both roots are the same
directory, "legacy" is this artifact's bound source paths plus the requirements
discovered for it. An undecidable dynamic reference in a changed file is
surfaced rather than passed over.

`requirementEvidence` is where the requirement graph is proved to have survived.
Every `requirements` row disposed `MIGRATED_BEHAVIOR`, `FEATURE_LOCAL`,
`INTENTIONAL_FIX` or `INTENTIONAL_DESIGN_ADAPTATION` claims the element was
carried into the target, so each owes exactly one
`{element,path,sha256,boundTo}` row naming a target file this migration changed
or declared -- the same scope and staleness rules as gate evidence. Discovering a
stylesheet, an asset, a data file or a runtime URL and then never proving it
downstream is not completion. The other dispositions owe nothing here:
`TARGET_NATIVE_EQUIVALENT` is proved by its target-native row,
`EXTERNAL_DEPENDENCY` by the target manifest, and the remaining four say the
element is deliberately not carried.

For visible UI, `uiEvidence` contains one row per UI-owning slice:
`{sliceId,path,sha256,boundTo}`. The path is that slice's `result.json`; its
hash is the semantic hash described above. Finalization also requires terminal
parity, preserved target-native rows, design-system compliance (or an already
recorded decision), and complete verified global contracts.

The engine owns `state.json`, `integrity.json`, append-only
`history/history.ndjson`, and transaction recovery. Never author those files.

## Format Axis And Upgrades

The artifact record's format axis is its own: contract `1`, format `13`,
workflow `1.0`, independent of the module engine's numbers.

```text
ARTIFACT_FORMAT_VERSION            = 13
ARTIFACT_FORMAT_UPGRADE_FLOOR      = 13
ARTIFACT_FORMAT_UPGRADERS          = []      (correctly empty)
```

The upgrade floor is declared, not derived, and today it equals the runtime
format. No persisted format can therefore be both at or above the floor and
behind the runtime, so the registry has nothing to hold and the `formatUpgrade`
field an artifact status returns is always `null`. **Format 13 performs no
upgrade.** There is
no historical 12→13 upgrader and none is invented: a record persisted at 12 is
refused exactly as it always has been.

Admission is the only thing the floor changes, and it changes nothing today. A
persisted format is readable when it is the runtime format, or when it sits at or
above the floor, behind the runtime, and every increment from there to the
runtime has a registered upgrader. Anything else — below the floor, newer than
the runtime, or a gap in the path — stays refused with the message it has always
been refused with. With an empty registry that admits nothing new.

The rule is prospective and enforced by the engine, not by convention. The first
artifact bump, 13→14, must ship with exactly one registered adjacent upgrader:
`assertRegistryCoverage({floor, runtimeFormat, registry})` runs from the
format-upgrade suite and from the release gate before staging, and refuses a
runtime format with no registered path from the floor. Declaring the new format
self-healing or promoting buys no pass. When that row exists, an owed increment
must explicitly declare `activation: null` for immediate activation or an
activation predicate with an old-format `prerequisite {kind, path, description}`.
An owed but INACTIVE increment leaves normal lifecycle progress live until that
prerequisite is validated and pinned; an ACTIVE one freezes it. `requiredInput`
is new material for an already-active upgrader. The typed `formatUpgrade`
projection then reports INACTIVE or the active states `NEEDS_INPUT` | `READY` |
`BLOCKED`, with `TRANSFORM` | `NO_OP` domain when classified. An ACTIVE upgrader
commits exactly one increment per invocation through the journal above. The release manifest
records `artifactFormatUpgradeFloor` and `artifactFormatUpgraders` so a bundle's
upgrade path is inspectable from the bundle itself.

## Transaction Journal And Recovery

`transaction.json` is the engine's two-phase commit journal, written before any
authoritative file changes and removed only once the commit is fully applied.
Version 2 is `{version:2, previousState, previousIntegrity, input, state, event}`:

- `state` and `event` are the proposed next state and its history event, exactly
  as version 1 carried them.
- `previousState` is the complete state preimage, retained even after
  `state.json` is replaced; `null` only for a bootstrap transaction.
- `previousIntegrity` is the validated pre-commit integrity anchor (same shape
  as `integrity.json`) binding the exact previous history prefix by byte
  count/hash/event count, without copying that history into the journal;
  `null` only for a bootstrap transaction.
- `input` is a strict discriminated transition input:
  `{kind:"BOOTSTRAP", artifactType, source, target}` carries what the resolver
  and the shared initial-state constructor need; `{kind:"ADVANCE",
  selectedSlice}` carries the selected slice explicitly (`null` off `PLAN`),
  independently of `event.slice`, which keeps its previous-active-slice
  meaning.

Normal execution establishes this proof exactly once, in-memory, before the
journal exists: it runs `previewAdvance` -> `nextState` -> `eventFor` (or the
shared bootstrap constructor plus the `BOOTSTRAPPED`/`NOT_STARTED` event) from
the previous state and input the running command already validated, then
writes the journal with everything already computed. Persisting and finishing
that transaction never reopens the journal or reruns `previewAdvance` -- the
proof is carried forward, not repeated.

Recovery runs in a later process with no in-memory proof, so before touching
any file it independently reconstructs and proves the transition: it rebinds
the retained history prefix by `previousIntegrity`'s recorded byte
count/hash/event count, revalidates the previous state's pinned artifacts,
reruns the exact same `previewAdvance` -> `nextState` -> `eventFor` chain (or
bootstrap constructor) from the persisted `previousState`/`input`, and compares
every field of the result against the journal's proposed `state`/`event`
before appending, writing, or removing anything. `--status` never does any of
this: it only checks the journal's shape and that its event still fits history
positionally, and reports `ACTIVE` (recoverable) or `BLOCKED` (not) without
mutating anything or executing a single validator.

### Crash windows

Let P/N be the previous/expected-next state, H/H+E the previous history / that
history plus the expected event, and I/J the previous/expected-next integrity.

| Durable boundary | On disk | Recovery |
| --- | --- | --- |
| Before journal publication | P, H, I; no journal | Nothing to recover; a new invocation starts a fresh normal run. |
| Journal durable, history not appended | P, H, I, journal | Prove, append E, write N then J, remove journal. |
| History append complete | P, H+E, I, journal | Prove, write N then J, remove journal. |
| State replacement complete | N, H+E, I, journal | Prove; replay from the journal preimage; write J, remove journal. |
| Integrity replacement complete | N, H+E, J, journal | Prove the fully-applied transition; remove journal only. |
| Journal removal complete | N, H+E, J; no journal | Ordinary read; no duplicate event or replay. |

Bootstrap follows the same ordering with P/I absent and H empty. Torn JSON,
partial history appends, impossible phase combinations, missing advance
authority, later revisions, extra history suffixes, conflicting events, and
stale evidence are all `BLOCKED` and left byte-identical -- recovery never
truncates history or rolls back state.

### Legacy (version 1) journals

A version-1 journal (`{version:1, state, event}`) predates the preimage/input
fields and is supported for recovery only where its proof is still
reconstructible:

- **Bootstrap** (`event.from === "NOT_STARTED"`, `event.seq === 1`) is always
  reconstructible: it has no predecessor to lose, so recovery rebuilds it
  through the same shared constructor used above, including an already fully
  applied bootstrap.
- **Advance** is reconstructible only while `state.json` still holds the
  genuine, unreplaced preimage (the selected slice at `PLAN` is recovered
  unambiguously from the proposed state's `activeSlice` and reproved against
  the proposal). Once `state.json` already shows the proposed state, version 1
  has nowhere left to recover the preimage from.
- A non-bootstrap version-1 journal without a reconstructible predecessor stays
  untouched and reports an actionable `BLOCKED` result. This is an explicit
  compatibility limit of the old envelope, not a new lifecycle rule; version-2
  proof is never weakened to accommodate it.

Every new transaction this engine writes is version 2.
