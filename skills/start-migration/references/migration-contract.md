# Migration Contract

Contents: [Registry](#registry) · [Version-5 lifecycle](#version-5-lifecycle-and-v50-workflow-revision)
· [OpenSpec requirements authority](#openspec-requirements-authority) · [State-only contract](#state-only-contract)
· [Pre-execution confirmation contract](#pre-execution-confirmation-contract) · [Step documents](#step-documents)
· [Legacy/target inventories](#legacy-inventory) · [Behavior parity](#behavior-parity) · [Route adaptation](#route-adaptation)
· [Design-system usage](#design-system-usage) · [Target-native behavior](#target-native-behavior)
· [Visible-UI verification](#visible-ui-verification-format-12)
· [Slice index and records](#slice-index-and-records) · [Final gates](#final-gates)
· [Integrity, resumption, and invalidation](#integrity-resumption-and-invalidation)
· [Unsupported contract-2/3 workflows](#unsupported-contract-2-and-contract-3-workflows)

> **Candidate-rebuild note.** Three sections below (state shape, final gates, integrity/resumption)
> tighten enforcement relative to the original contract-5 implementation: gate evidence gains
> required freshness/binding fields, `state.json` rejects unknown top-level keys, revision pinning
> is path-scoped instead of whole-repo, and resume runs a read-only slice-consistency check. These
> close gaps the forensic inventory found (`analysis/inventory.md`, Part B "Defects found") — they
> are not new product features. Because the persisted shape of `gates.json` and `state.json`
> changes, adopting this candidate as the live skill is a **format-affecting change** and needs its
> own upgrade path before replacing the original skill; see the replacement plan in
> `start-migration-evaluation.md`. No such upgrade path is built here.

## Registry

Legacy and target roots may be different subtrees of the **same** Git repository. Nothing requires
a separate checkout — only that the two resolved paths are not byte-identical (checked at
registration). Revision pinning (below) is path-scoped precisely so this topology is safe.

The target-owned `.agents/knowledge/migrations/registry.json` remains version

1. First setup accepts `--registry <path>`. Its validated binding is persisted
   in the canonical project `package.json` as:

```json
{
  "config": {
    "startMigration": {
      "registry": "target/.agents/knowledge/migrations/registry.json"
    }
  }
}
```

The path is workspace-relative with `/` separators whenever the registry is in
the workspace; the registry itself is never copied or moved. Resolution order
is existing migration state, first-setup CLI, project configuration,
`MIGRATION_REGISTRY_PATH` as an optional CI fallback, then an actionable error.
Any conflicting supplied or persisted value fails. Roots inside the registry
may be absolute, relative to the registry, or contain `${NAME}` environment
references. Names use lowercase letters, digits, and single hyphens.

An unregistered migration may be bootstrapped with `--target`. Register its
confirmed mapping only after `BUILD_BASELINE` validates and before advancing to
`PLAN`. Until then, registry/context resolution falls back to that initialized
state for status, scanning, validation, and `record-decision.mjs --pending`;
the absent registry entry is not an error at `DISCOVERY_COMPLETENESS`.

## Version-5 lifecycle and v5.0 workflow revision

`scripts/resumable-migration.mjs` is the single authority for the three version
axes, through `RESUMABLE_CONTRACT_VERSION`, `MIGRATION_FORMAT_VERSION`, and
`WORKFLOW_VERSION`. **SKILL.md carries the one canonical restatement of the
current values** — do not restate the literal numbers here too; if they
change, fix the constants and SKILL.md, and this document stays correct by
reference. `references/v5-contract.md` is the frozen decision record for the
contract-4 → contract-5 upgrade specifically (a historical diff, not a
restatement of current values). `workflowVersion` is release metadata; a
`workflowVersion` difference alone never rewrites persisted data. Technical
interruptions resume the persisted checkpoint or active slice. A legacy
mismatch must be reviewed by the user before using `--refresh
--confirm-mismatch`.

Each active migration owns one directory:

```text
.agents/knowledge/migrations/modules/<module>/
├── state.json
├── brief.md
├── steps/
│   ├── 01-resolve.md
│   ├── 02-discover-legacy.md
│   ├── 02a-discovery-completeness.md
│   ├── 03-assess-target.md
│   ├── 04-build-baseline.md
│   ├── 05-plan.md
│   ├── 06-implement-slices.md
│   ├── 07-verify-slices.md
│   └── 08-finalize.md
├── inventories/
│   ├── legacy.json
│   ├── module-classification.json
│   ├── discovery-scan.json
│   └── target.json
├── decisions/
│   └── operator-decisions.ndjson
├── matrices/
│   ├── behavior-parity.json
│   ├── route-adaptation.json
│   ├── target-native.json
│   ├── design-system-usage.json
│   └── capability-ownership.json
├── slices/
│   ├── index.json
│   └── <slice-id>.json
├── evidence/
│   └── <slice-id>/result.json
├── gates.json
└── history/
    └── history.ndjson
```

`brief.md` exists only when a brief was supplied. `02a-discovery-completeness.md`
is numbered `02a` and not `03` on purpose: renumbering `03`–`08` would invalidate
every pinned path in every record written before format 10.
`decisions/operator-decisions.ndjson` exists only once an operator has recorded
a decision.

## Canonical module-boundary model (format 10)

One versioned resolver computes the boundary during `DISCOVER_LEGACY` and again
from the final editable classification during `DISCOVERY_COMPLETENESS`,
`--scan`, pending-decision derivation, and `FINALIZE`. Every classification and
persisted scan records an explicit supported integer `algorithmVersion` (1 or
2). A missing, non-integer, or unsupported recorded version raises a typed
scanner-version error before rescanning; it never falls through to the current
default. `FINALIZE` always passes the version persisted in the scan.

Boundary relations preserve semantic ownership:

| Relation              | Definition                                                                                                                                                                                           | Requires a disposition                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `OWNED`               | physically under one of the declared module roots, from the census                                                                                                                                   | yes, always                                                 |
| `SUPPORTING`          | outside the roots and required by owned runtime behavior; typed as `MODULE`, `DATA`, `STYLE`, `ASSET`, `I18N_RESOURCE`, `MODULE_RESOURCE`, or `FRAMEWORK_RUNTIME_RESOURCE`, with exact edge evidence | no — recorded with exact `requiredBy`                       |
| `INBOUND_CONSUMER`    | an outside first-party file on a resolved path into an owned file                                                                                                                                    | no; it may be legacy evidence without becoming a dependency |
| `GOVERNING_FRAMEWORK` | a relevant framework convention or shared runtime configuration that governs entry/resource resolution                                                                                               | no; it may be legacy evidence without becoming owned        |

Package/platform dependencies remain `EXTERNAL` specifiers and are never
traversed. A first-party reference whose target cannot be proven is
`UNRESOLVED` and blocks. Shared configuration cannot be added to `moduleRoots`
merely to reach a resource: for example, i18n configuration is
`GOVERNING_FRAMEWORK`, while the exact namespace JSON is typed `SUPPORTING`.

`reachability` — how it is reached. Computed, never authored:
`REACHABLE_FROM_ENTRY` · `REACHABLE_INBOUND_ONLY` · `REACHABLE_TEST_ONLY` ·
`UNREACHABLE`. `UNREACHABLE` is a classification, not an exemption: an owned
file nothing imports is still in the census and still needs a disposition.

A reference is first-party when its specifier is relative, matches a `tsconfig`
alias prefix, or resolves under the legacy root. Any first-party `UNRESOLVED`
blocks the checkpoint; a non-first-party unresolved reference is recorded with a
reason and does not block.

Named imports through supporting barrels traverse only re-exports that can
provide the requested symbol. Unrelated barrel exports and unrelated repository
edges are excluded from both the supporting closure and discovery digest. A
namespace (`*`) demand subsumes every named demand, and semantic widening is
reprocessed regardless of source order. `new URL(expr, import.meta.url)`, safe
immutable aliases, and recursively nested module URL bases are module-resource
edges. Mutable, cyclic, shadowed, or otherwise unproven bases fail closed as
module-resource findings; proven HTTP/runtime calls are recorded in
`runtimeUrls` and are nonblocking.
A non-literal module edge is unresolved until its classification row names at
least one concrete tracked target. Rationale and operator approval are
additional evidence, never a substitute for those targets.

## `inventories/module-classification.json` (authored)

```json
{
  "version": 1,
  "algorithmVersion": 2,
  "moduleRoots": [
    {
      "path": "src/features/auth",
      "reason": "The feature slice being migrated.",
      "decisionId": null
    }
  ],
  "declaredEntryPoints": [
    { "path": "src/proxy.ts", "reason": "Route guard entry." }
  ],
  "files": [
    {
      "path": "src/features/auth/components/login/background.tsx",
      "scope": "OWNED",
      "reachability": "REACHABLE_FROM_ENTRY",
      "reachedFrom": ["src/features/auth/components/login/login-form.tsx"],
      "kind": "COMPONENT",
      "disposition": "EXCLUDED_APPROVED",
      "behaviorIds": [],
      "routeFlowIds": [],
      "rationale": "Decorative full-bleed SVG at zIndex -1.",
      "decisionId": "DEC-001",
      "decisionDigest": "sha256:…",
      "evidence": []
    }
  ],
  "supporting": [
    {
      "relation": "SUPPORTING",
      "type": "I18N_RESOURCE",
      "path": "src/shared/i18n/es-ES/auth.json",
      "requiredBy": ["src/features/auth/hooks/useAuth.ts"]
    }
  ],
  "unresolvedReferences": [
    { "from": "…", "spec": "…", "firstParty": false, "reason": "…" }
  ],
  "findings": [
    {
      "id": "FIND-<stable-hash>",
      "type": "DYNAMIC_NONLITERAL",
      "targets": ["src/features/auth/runtime.ts"],
      "rationale": "Runtime selector mapping.",
      "decisionId": "DEC-001",
      "decisionDigest": "sha256:…"
    }
  ]
}
```

`scope`, `reachability`, `kind`, and `disposition` are closed enums. `reachability`
and `kind` must equal what the scan computes — they are derived, so relabelling a
visible component `UNREACHABLE` is refused rather than believed.
For algorithm 2, every supporting row records `relation: SUPPORTING`, the exact
computed `type`, and the complete sorted `requiredBy` list. Extra shared files
are refused: declaration does not create a dependency.

`disposition`, required for every `OWNED` row:

| Disposition              | Companion requirement                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `BEHAVIOR_BACKED`        | ≥1 `behaviorIds`/`routeFlowIds`, each defined in `inventories/legacy.json` |
| `INFRASTRUCTURE_ONLY`    | `rationale` + a full evidence checklist                                    |
| `NO_OBSERVABLE_BEHAVIOR` | `rationale` + a full evidence checklist                                    |
| `DEAD`                   | a `DEAD_CONFIRMATION` decision + ≥1 `PRESENT` `RUNTIME_OBSERVATION` item   |
| `EXCLUDED_APPROVED`      | an `EXCLUSION` decision whose `rationaleDigest` matches                    |

**Mandatory safeguard.** A production-reachable `COMPONENT`, `STYLE`, or `ASSET`
— anything a user can see — may never be `NO_OBSERVABLE_BEHAVIOR` or
`INFRASTRUCTURE_ONLY`. Agent-authored rationale does not dismiss something on
screen; it is `BEHAVIOR_BACKED` with a real behavior id, or `EXCLUDED_APPROVED`
with an operator decision.

## `inventories/discovery-scan.json` (machine-generated)

Written by the confirmed `DISCOVERY_COMPLETENESS` advance and never trusted as
input: every validation recomputes the scan and compares. It exists so a drift
failure can name what changed. `artifactHashes` pins the derived key
`inventories/discovery-scan.json#discovery`, not the file whose `generatedAt`
moves on every run. A new pin combines the recorded `discoveryDigest` with the
SHA-256 digest of the exact raw `operator-decisions.ndjson` bytes. An existing
format-10 scan without `decisionLedgerDigest` retains its historical
discovery-digest-only pin and remains valid.

Algorithm 2's digest binds: `algorithmVersion`, sorted `moduleRoots`, exact
declared and derived entry points, the four canonical boundary relations and
their evidence, relevant runtime URLs, the resolution rules (TypeScript
version, tsconfig path and digest, `paths`, `baseUrl`, `moduleResolution`,
`module`, `jsx`, probe extensions, census command), the sorted census, only
boundary-relevant edges, stable findings, concrete module-edge targets, and
every relevant unresolved reference. Algorithm 1 retains its original digest
projection byte-for-byte.

Deliberately excluded: per-file content hashes — `legacyRevision` and the dirty
manifest already bind legacy bytes into every confirmation ID and gate
`boundTo`, and duplicating that would double-report one drift — and every
authored classification, since an operator decision binds to this digest and
including the rows it approves would make that binding circular. The
`tsconfigDigest` _is_ included: a `paths` edit changes resolution semantics
without changing one census path.

## `decisions/operator-decisions.ndjson` (operator-only)

One hash-chained JSON object per line, appended with `O_APPEND`:

```json
{
  "id": "DEC-001",
  "seq": 1,
  "prevDigest": "sha256:… | genesis",
  "at": "…",
  "operator": "…",
  "kind": "EXCLUSION | DEAD_CONFIRMATION | EDGE_RESOLUTION | ROOT_DECLARATION",
  "subject": { "type": "FILE", "path": "…" },
  "statement": "…",
  "rationaleDigest": "sha256:<the agent-authored rationale this approves>",
  "candidateId": "APP-<stable-hash>",
  "targets": [],
  "boundTo": {
    "module": "…",
    "legacyRevision": "…",
    "legacyDirtyDigest": "sha256:…",
    "discoveryDigest": "sha256:…",
    "algorithmVersion": 2
  }
}
```

`record-decision.mjs --pending` is read-only and deterministic. It derives
stable candidates from the current classification, canonical boundary, legacy
source binding, scanner version, and existing ledger, including initialized
but not-yet-registered migrations. Each row includes a syntactically complete
`--approve <stable-id>` command. A blocked candidate (for example, a module
edge with no concrete tracked target) is listed but is not approvable. A cited
decision suppresses a candidate only when its candidate id, kind, full subject,
targets, rationale digest, and every applicable binding exactly match. A stale
reference leaves the current candidate visible and approvable without deleting
or rewriting the classification first.

`--approve` checks stdin/stdout TTY authority before registry or state work,
requires the operator to retype `APPROVE <stable-id> <kind> <exact-subject>`,
takes the same exclusive module lock as every other mutation, recomputes the
selected candidate under that lock, and appends only if it remains byte-for-byte
identical and pending. An agent may list candidates but cannot approve one. A
stale id, a generic `y`, an agent-authored line lacking the current
`candidateId`, or an approval with different concrete targets writes nothing.

A row citing an algorithm-2 decision must satisfy all of: the decision exists
and the chain verifies; `candidateId` is the current derived candidate;
`kind`, `subject.type`, `subject.path`, and `targets` match exactly;
`rationaleDigest` equals the digest of that row's own rationale;
`boundTo.module`, `boundTo.algorithmVersion`, and `boundTo.discoveryDigest`
match the current candidate; and `boundTo.legacyRevision`/`legacyDirtyDigest`
equal the legacy tree right now. Existing algorithm-1 decision lines retain their
historical validation. An approval therefore cannot be recycled onto another
file, cannot survive an edited rationale, cannot survive a changed census, and
cannot survive an edit to the approved file's own bytes — the digest
binds the import graph, not the content inside a file, so the source binding is
the half that catches decorative content growing a delete button. The file is
has no standalone `artifactHashes` key while decisions are still being
collected, so each row re-verifies its decision on every validation. Once a new
`DISCOVERY_COMPLETENESS` checkpoint closes, its derived discovery pin also
binds the immutable raw ledger bytes. Existing pins without that field retain
their historical behavior.

## OpenSpec requirements authority

The target capability owns one authoritative requirements source. The default
project-relative path is:

```text
openspec/specs/<target-module>/spec.md
```

Set `MIGRATION_REQUIREMENTS_FILE` to another target-relative path or a pattern
containing `{target}`. Absolute paths and paths that escape the target are invalid.

The source is an output of `RESOLVE`: it is validly absent while no state exists
and the preflight reports `NOT_STARTED`/`RESOLVE`. In that case the agent drafts
the real requirements from legacy evidence in memory and supplies those same
bytes through the helper's internal `--openspec-proposal-stdin` option during
preview and confirmed execution. Preview validates the proposal and includes
its digest in the confirmation snapshot without writing it. Confirmed
initialization creates it with the complete RESOLVE artifact set and registry
binding in one rollback-safe transaction. Do not create a placeholder or
restore the target file manually.

Every `### Requirement:` heading starts with a unique
`<CAPABILITY>-REQ-<NNN>` ID, uses `SHALL` or `MUST`, and owns at least one
`#### Scenario:` heading with a unique `<CAPABILITY>-SCN-<NNN>` ID. Missing,
malformed, duplicate, empty, or changed authority blocks execution before a
migration write.

After initialization, a missing source blocks every status, resume, validation,
or advance operation. Migration state records only the source path, SHA-256 digest, requirement IDs,
and scenario IDs. Inventories, matrices, slices, and evidence reference those
IDs; they never copy authoritative requirement or scenario prose.

## State-only contract

`state.json` stores navigation and integrity state only. It must not contain
inventories, parity rows, plan prose, test output, gate evidence, or historical
documents. **This is schema-enforced**: any top-level key outside the set
documented here is rejected — `state.json` cannot silently accumulate
undocumented data.

Required fields:

```json
{
  "contractVersion": 5,
  "formatVersion": 10,
  "workflowVersion": "5.0",
  "migrationId": "legacy-catalog",
  "legacyModule": "legacy-catalog",
  "targetModule": "catalog",
  "registry": ".agents/knowledge/migrations/registry.json",
  "legacyRevision": { "revision": "<sha>", "pathScoped": true },
  "requirementsAuthority": {
    "kind": "openspec",
    "source": "openspec/specs/catalog/spec.md",
    "digest": "sha256:<digest>",
    "requirementIds": ["CATALOG-REQ-001"],
    "scenarioIds": ["CATALOG-SCN-001"]
  },
  "brief": null,
  "ponytail": null,
  "dataSourceMode": "standard",
  "designSource": "target-system",
  "legacySources": ["legacy-catalog"],
  "targetAdoption": { "mode": "GREENFIELD", "baseline": null },
  "status": "ACTIVE",
  "currentStep": "DISCOVER_LEGACY",
  "activeSlice": null,
  "completedSteps": ["RESOLVE"],
  "pendingSteps": [
    "DISCOVER_LEGACY",
    "DISCOVERY_COMPLETENESS",
    "ASSESS_TARGET",
    "BUILD_BASELINE",
    "PLAN",
    "IMPLEMENT_SLICES",
    "VERIFY_SLICES",
    "FINALIZE"
  ],
  "completedSlices": [],
  "pendingSlices": [],
  "invalidatedArtifacts": [],
  "evidenceFreshness": "CURRENT",
  "nextAction": "Complete the legacy inventory.",
  "nextCommand": "/start-migration legacy-catalog",
  "artifacts": {},
  "artifactHashes": {},
  "revision": 1,
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

`legacyRevision.revision` is computed path-scoped — the last commit that
actually touched files under the legacy root (`git log -1 --format=%H -- .`
from within that root), not the whole repository's HEAD. This is what makes it
safe for legacy and target to share one Git root: a commit landing only in the
target subtree no longer changes what the legacy side considers "current."
`pathScoped` is `false` only in the fallback case — no commit has ever touched
that root yet (e.g. a brand-new directory) — in which case the value falls
back to the whole-repo HEAD and drift detection treats it explicitly as an
unscoped reading rather than silently pretending it is precise.

`registry` is a target-relative, `/`-separated identity. New state records it;
pre-change contract-5 state may omit it and uses the conventional target-owned
registry location. Once recorded, state is authoritative and every CLI,
environment, or project-config mismatch is rejected.

`blockers` and `mappingRegistered` are not persisted by contract 5. Blockers are
computed and reported by the preflight, and registration is derived from the
registry at read time. Persisted `status` is `ACTIVE` or `COMPLETE` only.

`brief` is `null` or `{ "path": "brief.md", "digest": "sha256:<64 hex>" }`. The
brief is an immutable loaded input: a changed `brief.md` reopens the owning
checkpoint exactly as a changed step document does.

There is no automatic format synchronization. A contract-4 migration is refused
with the explicit upgrade command; see `SKILL.md` and `references/v5-contract.md`.

`dataSourceMode` is `standard` or `mock`. It is independent from `ponytail`,
whose only values are `full` and `full-audit`. `full` requires typed Ponytail
review evidence at `SIMPLIFY_ONCE`; `full-audit` additionally requires typed
audit evidence at `PRECOMMIT_GATE`. Mock mode records intent only;
the target project's architecture and configuration conventions determine how
the data source is implemented.

`designSource` is `target-system` (default) or `figma-mcp`, and is a format-14
field: a record created before format 14 omits it and behaves as
`target-system` by omission. It is bootstrap-fixed and immutable for the
migration's lifetime, exactly like `dataSourceMode`; a resume that explicitly
names a different design source is refused. Under `figma-mcp`, Figma is the
visual/UX authority while legacy remains authoritative for behavior, data flow,
routes, and business rules, and the target architecture and design system remain
authoritative for implementation structure. `figmaSources` is then a non-empty
array of normalized link references
`{ "fileKey": "<key>", "nodeId": "<page:node>" | null, "kind": "design" | "make", "raw": "<url>" }`,
deduplicated by `fileKey#nodeId`; it is absent or empty for `target-system`.
The Figma design context itself is the agent-authored
`inventories/figma-context.json`, pinned at `ASSESS_TARGET` into
`artifactHashes["inventories/figma-context.json"]` — the single canonical Figma
snapshot digest. That digest is bound only into visual (`origin: TARGET`) UI
evidence, so a changed design re-opens visual verification alone; it is never
bound into the seven final gates, functional parity, or architectural evidence.
Provenance is all that digest proves. From format 17, a figma-mcp record is also
held to fidelity: see "Figma visual acceptance (format 17)".
`legacySources` and `targetAdoption` are format-15 fields; a record created
before format 15 carries neither, and one that carries them at an older format
is refused.

`legacySources` is `sorted(unique(canonical source names))` with at least one
entry, supplied by repeatable `--legacy <module>`. Sorting is derived, never
operator-controlled, so two operators typing the same sources in different
orders produce byte-identical state. From format 15 the identity rule is
`migrationId === targetModule` — the target is the one thing that stays singular
when N sources converge, so the record directory, the module lock, the OpenSpec
path, and `nextCommand` all key on it. `legacyModule` is retained as
`legacySources[0]` for shape compatibility only: it is alphabetically first and
carries no primacy, and **no format-15 rule may read it as the behavioral
authority** — discovery, attribution, cardinality, matrices, and planning all
consume the full `legacySources` set.

Module roots are a discovery output, not a bootstrap input, so they are not in
`state.json`. Each `inventories/module-classification.json` root entry gains an
optional `source` naming a declared legacy source; the field is required only
where more than one source converges, and it is validated at
`DISCOVERY_COMPLETENESS` — the checkpoint that already pins the roots immutable.
Three rules apply there: every root names a declared source, every declared
source owns at least one root, and roots belonging to different sources are
pairwise disjoint. That disjointness is what makes evidence attribution a
prefix function over the pinned roots rather than a guess; there is no
`<source>:<path>` evidence syntax, because both sources resolve against the same
repository root and a qualifier would disambiguate nothing.

`targetAdoption` is `{ "mode": "GREENFIELD" | "BROWNFIELD", "baseline": ... }`.
`GREENFIELD` is the default and the implicit value of every pre-15 record, and
its `baseline` is `null`. `BROWNFIELD` is declared with `--adopt-target`, is
refused unless `src/features/<targetModule>/` already exists, and carries
`{ "path": "inventories/target-baseline.json", "digest": "sha256:<digest>" }`.
That artifact is written once at `RESOLVE` and pinned into `artifactHashes`:

```json
{
  "version": 1,
  "revision": "<sha>",
  "dirty": [{ "path": "package.json", "digest": "sha256:<digest>" }]
}
```

It records committed history *and* every uncommitted path with its bytes,
because pre-existing work is very often an uncommitted edit that a revision
alone cannot see. A declared `changedFiles` entry that is byte-identical to the
baseline was not changed by the migration and is refused.

Under `BROWNFIELD`, `inventories/target.json` may not record
`implementationState: "ABSENT"` and must cite at least one `SOURCE` evidence
item under `src/features/<targetModule>/`. A behavior-parity row may then be
authored `ADOPTED_VERIFIED` — a sixth terminal parity status meaning *proven by
pre-existing implementation* — only when its `targetState` is
`IMPLEMENTED_UNVERIFIED`, its `targetEvidence` resolves under the target
feature, and its `adoptionEvidence` entries pass the same structured, hash-bound
command-result validation `VERIFY_SLICES` uses plus two fields:

```json
{
  "scenarioIds": ["CATALOG-SCN-001"],
  "testPaths": ["tests/features/catalog/catalog.unit.spec.ts"]
}
```

The union of every entry's `scenarioIds` must equal the row's exactly, every id
must be defined by the OpenSpec authority, and every `testPaths` entry must
resolve under `tests/` and appear literally in the captured output bytes — a
runner that never named the file did not execute it. An adopted row goes stale
only when a path it named changed against the pinned baseline; an unrelated
commit does not reopen it.

`verificationStatus` on a behavior-parity row is a closed enum: `PENDING` plus
the terminal set (`VERIFIED`, `REDESIGNED_VERIFIED`, `EXCLUDED_APPROVED`,
`DEAD_CONFIRMED`, `ADOPTED_VERIFIED`). `VERIFIED` and `REDESIGNED_VERIFIED` are
produced by `VERIFY_SLICES` alone and are refused before any slice has been
verified; "the code already exists" is recorded as `ADOPTED_VERIFIED` with
bound evidence, or not at all. Correspondingly, a slice may record an empty
`changedFiles` when it records passing `commandResults` instead — the
verification-only slice that re-proves an adopted behavior after a visual change
without pretending code was rewritten. Like `delegatedOnly` it is derived, not
declared; there is no slice `kind` field.

The migration engine never calls the Figma MCP: the coding agent fetches and
normalizes the design context, exactly as it drives the Playwright MCP for
runtime UI evidence.

## Canonical progress projection (derived, never persisted)

One deterministic reading of a persisted record, shared by every front end so a
provider's native task UI and the text fallback cannot disagree. It is derived
data: `migrationProgress(state, { mode, outcome, reason })` reads the record and
the outcome the caller was just handed, persists nothing, defines no transition,
infers nothing from source files, and carries no provider-specific UI field.
Deleting it would leave the engine unchanged.

`migration_status` returns it as `progress`, plus the same object rendered by
`renderProgress` as `progressChecklist`. `migration_run` returns both on every
outcome (`null` only when the iteration failed before reading a record).
`--status` and `--json` carry the identical payloads, so the CLI path is read
exactly like the MCP path.

```jsonc
{
  "module": "roles", // state.legacyModule
  "target": "role", // state.targetModule
  "status": "ACTIVE", // state.status, unchanged
  "revision": 20, // state.revision, unchanged
  "mode": "auto", // "none" for read-only callers
  "checkpoints": [
    // stepsFor(state), never reordered
    { "index": 1, "total": 9, "name": "RESOLVE", "state": "COMPLETED" },
  ],
  "activeCheckpoint": "DISCOVERY_COMPLETENESS", // null once COMPLETE
  "activeSlice": null,
  "slices": {
    "completed": 0,
    "total": 0,
    "items": [{ "id": "role-001", "state": "PENDING" }],
  },
  "blocker": null, // the typed reason, only on a stop
  "stopReason": null, // the typed outcome, only on a stop
  "uiEvidence": null, // migration_status only; see below
  "nextWork": {
    // null once COMPLETE
    "checkpoint": "DISCOVERY_COMPLETENESS",
    "slice": null,
    "action": "…",
    "artifact": "…",
    "command": "…",
  },
}
```

Checkpoint and slice `state` is one of `COMPLETED`, `ACTIVE`, `PENDING`,
`BLOCKED`, and nothing else. The active checkpoint is `BLOCKED` rather than
`ACTIVE` whenever the iteration stopped — outcome `BLOCKED`, `OPERATOR_DECISION`
or `FAILED`, or a record whose `status` is not `ACTIVE`. A `COMPLETE` record
reports every checkpoint `COMPLETED`, `activeCheckpoint` and `nextWork` `null`.

The checkpoint list is `stepsFor(state)`, not a constant: a format-9 record was
born under the eight-checkpoint lifecycle and must not be shown a phantom
`DISCOVERY_COMPLETENESS` row it can never close. Presentation reads whatever
`checkpoints[]` holds; adding a checkpoint to `MIGRATION_STEPS` reaches all four
providers with no presentation change, and no adapter may keep its own copy.

`uiEvidence` is the visible-UI verification block (format 12) exactly as
`migration_status` computed it — `{ applicable, state, runtime, records,
limitations, freshness }` — passed through, never recomputed. Visible-UI work is
sub-work inside the existing checkpoints (`DISCOVER_LEGACY` inventories the UI
behaviors, `ASSESS_TARGET` and `PLAN` trace them, `VERIFY_SLICES` proves them
per slice, `FINALIZE` gates them, and `--reopen-ui` reopens a `COMPLETE`
migration at `VERIFY_SLICES`), so it is reported beneath those rows and is never
promoted to an extra checkpoint. `migrationProgress` performs no I/O, so a
caller that has not read the evidence — `migration_run` — reports `null` rather
than a guess. `renderProgress` emits its line only where `applicable` is true,
so a module with no visible UI renders exactly what it rendered before format 12.

FINALIZE's seven `FINAL_GATES` are likewise work inside checkpoint 9 and never
appear as checkpoint rows.

Slice items follow the record's own progression order — completed, then the
active slice, then pending — and are never sorted; slice ids are not required
to be lexicographic. Slices are detail beneath the active checkpoint and never
replace the checkpoint rows.

The projection is a display contract only. It exposes no approval affordance,
and no field on it can close a checkpoint, advance a slice, or approve a
pending decision; see `decisions/operator-decisions.ndjson`.

## Pre-execution confirmation contract

Every invocation except `--status` starts with a read-only preflight. It must
not create directories, scaffold files, modify target code, synchronize
formats, refresh evidence, advance state, append history, or delegate work.

The preflight reports the canonical migration and target, persisted state,
current checkpoint, active slice, exact action, selection reason, involved
artifacts, expected next checkpoint and artifact, recorded/current versions,
and blockers. When executable, it also returns an opaque confirmation ID
derived from that snapshot and the requested options.

For fresh initialization, the snapshot also includes the validated in-memory
OpenSpec authority and digest. A changed proposal therefore makes an earlier
confirmation ID stale.

Under `--mode step`, the user must explicitly approve the displayed action. The
agent then passes the confirmation ID back to the helper through internal
`--confirm-execution <id>`; the helper never prints a question it has already
exited before anyone could answer. Under `--mode auto` (the default) the AUTO
principal supplies that same ID for every transition it can derive from the
preview it just computed — including `--refresh`, `--reopen-ui`,
`--reopen-complete`, `--rework-slice`, `--amend-slice` and
`--adopt-visual-contract` — and records the decision in
`decisions/auto-decisions.ndjson`. The carve-out is a bootstrap
(`NOT_STARTED`): initialization pins the OpenSpec authority for the migration's
whole life and there is no prior record to decide from, so it stays two-phase
under either mode.

Either way the helper recomputes the preflight and rejects a missing or stale
ID. Confirmation is therefore scoped to one action and cannot be reused after
state, revision, legacy commit, checkpoint, slice, or invocation options
change. `--mode` is a property of a single invocation: it is never persisted,
never recorded in `state.json`, and never affects what an ID binds, so a
migration driven autonomously is indistinguishable on disk from one driven by
hand.

`No` cancels without changes. Missing, ambiguous, or conditional replies do not
authorize execution. A blocker produces no confirmation ID. The internal flag
is not part of the user-facing slash-command interface.

Persisted statuses are `ACTIVE` and `COMPLETE`. `BLOCKED` is a preflight report,
never a persisted state. `currentStep` follows the version-scoped lifecycle
(nine checkpoints for format 10, eight for pre-10) or is `COMPLETE`.
Only the helper updates state and hashes after step validation.

Registration uses the same two-phase contract: `update-migration-registry.mjs`
previews the resolved registry, normalized identity, project binding, module,
target, aliases, and resulting change. Its confirmation ID binds both registry
and project-config snapshots. Confirmed execution persists the project binding
and updates the original registry through atomic writes; preview writes
nothing.

Registration is never self-confirmed, in any mode: it persists a binding into
the canonical project's `package.json`, which is a project-level change rather
than a mechanical confirmation. It is therefore a stop condition for an
autonomous loop. An unregistered mapping is detected when `BUILD_BASELINE` is
advanced: the advance fails with exit `1` and "the migration mapping is not
registered", having written nothing — not as a preflight blocker, so the
preview still reports no blockers and still offers an ID.

## Step documents

Every step Markdown file contains:

```md
# NN. Step name

- Status: `PENDING`
- Contract version: `5`
- Format version: `4`
- Purpose: ...
- Dependencies: ...

## Required evidence

- [TODO] ...

## Decisions

- [TODO] ...

## Result

- [TODO] ...
```

Before validation, set the status to `COMPLETE` and replace every `[TODO]` with
concrete evidence. Completing one step never authorizes the next step in the
same session.

## Legacy inventory

`inventories/legacy.json` requires at least one behavior. While
`DISCOVER_LEGACY` is not yet completed (format 6, P1-7), each behavior's and
route flow's `evidence` is a machine-readable checklist, not bare strings: one
item per entry, each with a `category` (`SOURCE`, `RUNTIME_OBSERVATION`,
`REQUIREMENT_TRACE` — every category must appear at least once), a `kind`
(`CODE`, `CONFIG`, `TEST`, `DOCS`, `OBSERVATION`), a `status` (`PRESENT`,
`NOT_APPLICABLE`, `BLOCKED`), a `location` that must resolve under the legacy
or target repository when `status` is `PRESENT` (or a non-empty `reason` when
it isn't), and `requirementIds`/`scenarioIds` that must exist in the OpenSpec
authority when non-empty:

```json
{
  "version": 1,
  "behaviors": [
    {
      "id": "BEH-001",
      "description": "Open Product Catalog and view live tracks.",
      "evidence": [
        {
          "category": "SOURCE",
          "kind": "CODE",
          "status": "PRESENT",
          "location": "legacy/src/path.tsx",
          "requirementIds": ["CATALOG-REQ-001"],
          "scenarioIds": ["CATALOG-SCN-001"]
        },
        {
          "category": "RUNTIME_OBSERVATION",
          "kind": "OBSERVATION",
          "status": "NOT_APPLICABLE",
          "reason": "No runtime capture was taken.",
          "requirementIds": [],
          "scenarioIds": []
        },
        {
          "category": "REQUIREMENT_TRACE",
          "kind": "DOCS",
          "status": "PRESENT",
          "location": "legacy/src/path.tsx",
          "requirementIds": ["CATALOG-REQ-001"],
          "scenarioIds": ["CATALOG-SCN-001"]
        }
      ]
    }
  ],
  "routeFlows": [
    {
      "id": "FLOW-001",
      "description": "Open the independent list, select a track, open detail, and return.",
      "independentListAndDetail": true,
      "listSurface": "/legacy/tracks",
      "detailSurface": "/legacy/tracks/:id",
      "openTransition": "Select a track from the list.",
      "returnTransition": "Back returns to the list state.",
      "evidence": ["… same checklist shape as above …"]
    }
  ],
  "explicitNoRouteFlows": false
}
```

For format 10, the same checkpoint also runs the recorded canonical scanner and
requires every legacy-side evidence location to belong to one of its four
relations. A path merely existing under the legacy root is insufficient, and
shared configuration is not promoted to `OWNED` to make a citation pass.

An empty `routeFlows` array requires `explicitNoRouteFlows: true`. Once
`DISCOVER_LEGACY` is completed, later re-reads (`BUILD_BASELINE`, `PLAN`,
`FINALIZE`) accept the inventory's evidence in whichever shape it was
authored under — a closed checkpoint's evidence is tamper-checked (its hash is
pinned), not re-litigated against a rule that postdates it.

## Target inventory

`inventories/target.json` requires one allowed implementation state, concrete
evidence, navigation surfaces, target-native behavior, and UI component usage.
`evidence` follows the same machine-readable checklist as the legacy
inventory above while `ASSESS_TARGET` is not yet completed:

```json
{
  "version": 1,
  "implementationState": "PARTIAL",
  "evidence": ["… checklist items, same shape as the legacy inventory …"],
  "hasVisibleUi": true,
  "navigationSurfaces": [
    {
      "id": "SURFACE-001",
      "type": "COMBINED_LIST_DETAIL",
      "evidence": "src/features/catalog/components/panel.tsx"
    }
  ],
  "nativeBehaviors": [],
  "uiComponents": [
    {
      "id": "UI-001",
      "requirement": "Product category filter",
      "actualSource": "native select",
      "equivalentAvailable": true,
      "expectedComponent": "@target/ui Select",
      "evidence": "src/features/catalog/components/filters.tsx"
    }
  ]
}
```

Visible UI cannot use an empty component inventory.

## Visible-UI verification (format 12)

Format 12 requires both inventories to declare `hasVisibleUi`. A visible
legacy inventory also defines `uiBehaviors`; each row names its owning behavior,
one supported UI kind, exact configuration, runtime states, checklist evidence,
and OpenSpec requirement/scenario trace. The target inventory records every
observed mismatch in `uiMismatches`.

`hasVisibleUi: false` makes UI runtime evidence `NOT_APPLICABLE`: no
`uiBehaviors`, no visible `uiComponents`, and no Playwright. `hasVisibleUi: true`
makes it required. The two cannot disagree with what discovery found — a visible
inventory with no UI behaviors, and a non-UI inventory with visible components,
are both refused.

A `uiBehaviors` row is an interaction inventory, not a component census:

```json
{
  "id": "UIB-1",
  "behaviorId": "LB-1",
  "kind": "TABLE_LIST",
  "description": "The catalog list presents products without a toolbar.",
  "configuration": {
    "showToolbar": false,
    "showPagination": false,
    "compactMode": true
  },
  "conditional": false,
  "interactions": [
    {
      "id": "UIX-1",
      "action": "Type 'widget' into the search field.",
      "expected": "The list filters to matching rows and reports the count."
    }
  ],
  "runtimeStates": ["DEFAULT", "SEARCH", "EMPTY"],
  "evidence": ["… checklist items …"],
  "requirementIds": ["CAT-REQ-001"],
  "scenarioIds": ["CAT-SCN-001"]
}
```

- `configuration` may not be empty. `showToolbar: false` is the part a target
  silently drops; "a table exists" is not an inventory.
- `interactions` is mandatory for `SEARCH`, `PAGINATION`, `ROW_ACTION`,
  `CREATE_EDIT_ACTION`, and `CONDITIONAL_CONTROL`, and each entry needs an
  `action` and the `expected` result.
- `CONDITIONAL_CONTROL` and `PERMISSION_VISIBILITY` require `conditional: true`
  plus a `precondition`. A conditional control is **not** automatically
  required: it needs runtime evidence only when its disposition is
  `REQUIRED_BEHAVIOR`.

A completed migration may reopen only affected slices with:

```bash
artifact-migration-discover <module> --reopen-ui <slice[,slice...]>
```

`--reopen-ui` is legal only from `COMPLETE` and does not reopen unrelated
slices. Under `--mode step` it is operator-only and two-phase; under `--mode
auto` the AUTO principal decides it on its own evidence and records it in the
auto ledger.
It creates editable `ui-remediation.json`. Each mismatch must use one of
`REQUIRED_BEHAVIOR`, `LEGACY_DEFECT`, `INTENTIONAL_FIX`,
`INTENTIONAL_DESIGN_ADAPTATION`, or `NOT_APPLICABLE`; design adaptations
additionally require an approval and a behavioral-equivalence statement. Every
discovered UI behavior carries exactly one disposition, so an observable
difference with no explicit classification never reaches `FINALIZE`.
`LEGACY_DEFECT` and `NOT_APPLICABLE` drop a behavior out of the required set —
a known legacy defect is never reproduced for visual similarity — and both stay
traceable through the pinned inventory.

### Reopening a `COMPLETE` migration on post-finalization evidence

`--reopen-ui` covers a visible-UI parity audit and `--rework-slice` covers an
*active* slice with a recorded `FAIL`. Neither covers authoritative evidence that
arrives **after** `FINALIZE` and proves part of the finalized contract wrong. For
that, and only that:

```bash
artifact-migration-discover <module> --reopen-complete <slice[,slice...]> \
  --reopen-reason "<why the finalized contract stopped being true>" \
  --reopen-evidence <repository-relative path> --confirm-reopen \
  [--confirm-legacy-revision <current legacy revision>]
```

It is legal only from status `COMPLETE`, refused by `run-migration.mjs`, and
combinable with no other transition. Under `--mode step` it is operator-only,
two-phase and never self-confirmed: all four parts must be typed — which slices,
why, the evidence, and the confirmation — and any one of them alone fails
closed, as does a missing or wrong `--confirm-legacy-revision`. Under `--mode
auto` the AUTO principal supplies the confirmation and reads the current legacy
revision itself; the reason and the evidence still have to exist and still fail
closed if they do not. The reason must be at least 12 characters and the
evidence must be a real persisted file under the legacy or target repository (the
record's own tree counts); the confirmation ID binds the slices, the reason and
that file's exact bytes.

In one journalled transaction, ordered so the previous `COMPLETE`'s proof is kept
before anything is released:

- preserves each named slice's verification byte-for-byte at
  `reopen/<n>/evidence/<slice-id>/result.json` and writes `reopen/<n>/record.json`
  (operator, timestamp, reason, evidence reference and hash, slices, prior
  revision, preserved digests); both stay pinned for life, like a rework attempt;
- only then releases those slices' `evidence/<slice-id>/result.json` pins and the
  `FINALIZE` pins, and rewrites each released result to `PENDING`;
- moves to `VERIFY_SLICES` on the earliest affected slice, with status `ACTIVE`,
  and appends one `COMPLETE_REOPENED` history event carrying the reason.

Nothing else moves. Unnamed slices, every inventory, matrix, plan and operator
decision keep their pins and stay valid; `slices/<slice-id>.json` stays pinned,
because a reopen invalidates a *verification*, not an implementation — a slice
whose implementation is also wrong records `FAIL` with `defects[]` and returns to
implementation through `--rework-slice`. `FINALIZE` re-runs the
unclaimed-target-drift refusal unchanged.

If the legacy revision moved since `COMPLETE`, the reopen is blocked until the
operator also types `--confirm-legacy-revision <sha>` with the exact current
revision; a missing or different SHA, or the flag with no drift, fails closed.
The acknowledged move is bound into the confirmation ID, recorded as
`fromLegacyRevision`/`toLegacyRevision` in `reopen/<n>/record.json` and the
`COMPLETE_REOPENED` event, and becomes the record's `legacyRevision`. Nothing
else is released for it — slice evidence is not revision-bound, and the released
`FINALIZE` gates must be re-proven against the new revision, produced after the
reopen. Without the flag no revision is repinned; a drift the named slices do
not cover still needs `--refresh`. Deleting or altering anything under
`reopen/` is refused with `REOPEN_EVIDENCE_MISSING` or as altered preserved
evidence. A `COMPLETE` record that nobody reopens is never touched by any of this.

A `COMPLETE` figma-mcp record below format 17 adopts the visual contract with:

```bash
artifact-migration-discover <module> --adopt-visual-contract --confirm-adopt-visual-contract
```

It is refused by `run-migration.mjs`. Under `--mode step` it is operator-only,
two-phase and never self-confirmed; under `--mode auto` the AUTO principal
decides it from the evidence below and records it in the auto ledger.
Eligibility: `designSource: figma-mcp`, format below 17, status `COMPLETE`
(so no transition is in flight), no prior `visual-contract-adoption/`, and fresh
evidence at `inventories/figma-context.adopted.json` plus
`matrices/visual-acceptance.json` that validate under the unweakened format-17
rules. The confirmation ID binds a digest of both files and the affected slices.
In one journalled transaction it:

- preserves the prior context as `visual-contract-adoption/figma-context.previous.json`
  and writes `visual-contract-adoption/record.json` (previous and new format,
  confirmation ID, previous context digest, new context, contract and per-source
  Figma hashes, timestamp, operator, affected slices); both stay pinned for life;
- moves the adopted context into `inventories/figma-context.json`, re-pins it,
  and pins `matrices/visual-acceptance.json`;
- stamps `formatVersion: 17` and `visualContractAdoption`
  `{ fromFormat, toFormat, adoptedAt, record, pendingReverification }`, and
  appends one `VISUAL_CONTRACT_ADOPTED` history event.

No step, slice, approval, slice pin, or functional evidence moves. The affected
slices are those whose verified result holds an `origin: TARGET` UI row: each is
bound to the replaced `figmaContextDigest`, so it can no longer verify. A resume
is blocked, and `--reopen-ui` must include all of them, until they are reopened;
they then reverify under format-17 visual acceptance, and FINALIZE re-validates
every other slice unchanged.

### Runtime evidence rows

Verification evidence lives in the affected slice's `result.json`; captures live
beside it under `evidence/<slice-id>/ui/`. `uiEvidence` rows are produced by the
repository's registered Playwright MCP server and bind the runtime observation
to the slice implementation digest, UI contract digest, target, requirements,
data-source mode, behavior, and state:

```json
{
  "provider": "playwright",
  "origin": "TARGET",
  "producer": "playwright-mcp",
  "environment": "chromium 140",
  "route": "/catalog",
  "viewport": { "width": 1280, "height": 720 },
  "executedAt": "2026-08-21T10:00:00.000Z",
  "result": "PASS",
  "uiBehaviorId": "UIB-1",
  "state": "SEARCH",
  "interactions": [
    {
      "id": "UIX-1",
      "expected": "The list filters to matching rows and reports the count.",
      "actual": "The list filtered to 2 rows and reported '2 results'.",
      "outcome": "PASS"
    }
  ],
  "reference": "…/evidence/catalog-001/ui/search.txt",
  "hash": "sha256:…",
  "screenshot": {
    "reference": "…/evidence/catalog-001/ui/search.png",
    "hash": "sha256:…"
  },
  "boundTo": {
    "target": "catalog",
    "requirementsDigest": "sha256:…",
    "dataSourceMode": "standard",
    "sliceId": "catalog-001",
    "implementationDigest": "sha256:…",
    "uiContractDigest": "sha256:…"
  }
}
```

- `origin: "LEGACY"` records the legacy runtime observation. It is not bound to
  `implementationDigest`, because it is observed before the target exists.
- `origin: "TARGET"` is what satisfies a required state. Every required UI
  behavior needs one PASS `TARGET` row per declared runtime state, and every
  declared interaction must be exercised at least once with `outcome: PASS`.
- Under `designSource: figma-mcp`, every `origin: "TARGET"` row additionally
  binds `figmaContextDigest`, a copy of
  `artifactHashes["inventories/figma-context.json"]`, so a changed design
  re-opens the visual rows alone. `LEGACY` rows, functional parity, and the
  seven final gates are never Figma-bound.
- An interaction's `expected` must equal the discovered contract, so the target
  is verified against what discovery found, not against what it happens to do.
- Screenshots are supporting evidence and are never compared pixel for pixel.
  Byte-identical legacy and target captures verify, because perfect visual
  parity is the best outcome a migration can have, not a duplicate. Without a
  Figma visual contract (target-system, or a figma-mcp record below format 17),
  differing captures also verify. A Figma-backed format-17 TARGET row is instead
  accepted only by the measurement comparison below; a visually different
  rendering fails there however its screenshot looks.

#### Figma visual acceptance (format 17)

Applies only to `designSource: figma-mcp` records at format 17 or later.

`inventories/figma-context.json` frames (validated at `ASSESS_TARGET` and again
at every verification):

```json
{
  "fileKey": "ABC123def",
  "nodeId": "30:12",
  "name": "Catalog / narrow",
  "type": "FRAME",
  "viewport": { "width": 360, "height": 800 },
  "states": ["list initial", "item selected"],
  "extraction": { "retrievedAt": "2026-07-01T10:00:00Z", "fidelity": "COMPLETE", "limitations": [] },
  "sources": {
    "metadata": { "reference": "inventories/figma/30-12/metadata.xml", "hash": "sha256:…" },
    "designContext": [{ "reference": "inventories/figma/30-12/design-context.txt", "hash": "sha256:…" }],
    "variableDefs": { "reference": "inventories/figma/30-12/variable-defs.json", "hash": "sha256:…" },
    "screenshot": { "reference": "inventories/figma/30-12/screenshot.png", "hash": "sha256:…" }
  }
}
```

- `nodeId` must be a recorded link's node (or any node of a whole-file link),
  or a concrete descendant of a recorded node link proven by `ancestry`:

  ```json
  "ancestry": {
    "sourceNodeId": "30:2",
    "path": ["30:2", "30:12"],
    "metadata": { "reference": "inventories/figma/30-2/metadata.xml", "hash": "sha256:…" }
  }
  ```

  `metadata` is the verbatim `get_metadata` output of the recorded source node,
  hash-checked on every read. The engine reads the nesting from it: its root
  must be `sourceNodeId`, `nodeId` must be nested under that root at any depth,
  `path` must equal the derived source-to-node chain, and the node's `name` and
  size there must match the frame. `figmaSources` is never extended, and a node
  link is never widened to its whole file. The descendant still carries its own
  complete `sources`.
- Every source is the verbatim MCP output persisted inside the record; its hash
  must match on every read, so changed Figma evidence is stale, not drift.
- The persisted metadata must describe `nodeId`, and its size must equal
  `viewport`.
- `fidelity: DEGRADED` requires `limitations`; such a frame cannot back a
  visual acceptance row.

`matrices/visual-acceptance.json` (authored and pinned at `BUILD_BASELINE`):

```json
{
  "version": 1,
  "rows": [
    {
      "id": "VIS-004",
      "uiBehaviorId": "UIB-4",
      "state": "NARROW",
      "figmaNodeId": "30:12",
      "figmaState": "list initial",
      "viewport": { "width": 360, "height": 800 },
      "expect": {
        "contentWidth": { "kind": "px", "value": 360, "locator": "main" },
        "itemWidth": { "kind": "px", "value": 344, "locator": "getByTestId('list-item').first()" },
        "listItems": { "kind": "count", "min": 1, "locator": "getByTestId('list-item')" },
        "navigation": { "kind": "present", "value": false, "locator": "getByRole('navigation')" },
        "layout": { "kind": "equals", "value": "column", "locator": "list computed flex-direction" }
      },
      "tolerance": { "px": 8, "ratio": 0.02 }
    }
  ],
  "unbacked": [{ "uiBehaviorId": "UIB-3", "state": "ERROR", "reason": "No frame designs the error state.", "decisionId": "DEC-004", "decisionDigest": "sha256:…" }]
}
```

- Every required UI behavior state has exactly one row or one `unbacked` entry.
- A row is the sole authority binding a runtime state to Figma: its
  `uiBehaviorId` + `state` to `figmaNodeId` (a linked node or a proven
  descendant) + `figmaState` (one of that frame's recorded states/variants).
  Nothing is inferred from node or frame names, state text, or viewport. A state
  with a row cannot also be `unbacked`, not even by an operator.
- `unbacked` is never an agent's call: a state with no row must cite a
  `VISUAL_UNBACKED` operator decision
  (`decisionId`, `decisionDigest`) recorded through `record-decision.mjs`
  (`--pending`, then `--approve` at a terminal). `unbacked` is a judgement
  about design that was never supplied, so it is not derivable evidence: the
  AUTO principal cannot approve it either, and an agent can never author a line
  in the human ledger. Its candidate subject is `<uiBehaviorId>::<state>`,
  its rationale the entry's `reason` plus every persisted frame (node, name,
  viewport, states) and every DEGRADED frame's limitations, so the operator
  judges the absence against the evidence (degraded evidence is never absence
  of design), and its
  `boundTo` the `migrationId`, the recorded Figma source ids, the Figma context
  file digest, and the visual contract digest (the matrix without the
  citations). Every read, FINALIZE included, re-derives that candidate, so a
  changed context, contract or reason makes the decision stale.
- A row's `figmaNodeId` is a COMPLETE frame, `figmaState` one of its `states`,
  and `viewport` its exact viewport.
- `tolerance.px` is 0–16 and `tolerance.ratio` 0–0.1; a `px` fact passes when
  `|observed − value| ≤ max(px, ratio × |value|)`. `count` is exact (`value`) or
  a range (`min`, optional `max`); `equals` is JSON equality; `present` is a
  boolean.

A Figma-backed `origin: "TARGET"` UI-evidence row additionally carries
`figmaNodeId`, a `screenshot`, and
`"measurements": { "reference": "…/observations.json", "hash": "sha256:…", "pointer": "mobile" }`.
The referenced runtime file (or its `pointer` key) is
`{ "viewport": { "width": 360, "height": 800 }, "values": { "contentWidth": 360, … } }`.
The engine refuses the row with `VISUAL_ACCEPTANCE_FAIL` when the node or the
declared or measured viewport differs from the contract, when a fact was not
measured, or when any value falls outside tolerance. The engine owns that
verdict; `result: "PASS"` cannot override it. A slice tracing a design-system
row whose `status` is not `COMPLIANT` or `EXCEPTION_APPROVED` cannot verify.
- `reference` (and `screenshot.reference`, when present) must be a persisted
  artifact path that resolves under the legacy or target repository, and `hash`
  must be that file's current SHA-256. Prose such as `"observed in chromium"`
  is refused: a runtime claim that leaves no artifact is not evidence. This is
  stricter than the general evidence rule at the end of this document, and
  applies only to `uiEvidence`.

### Screenshot budget

- one screenshot per `origin` + UI behavior + runtime state, never a second;
- no two captures may share a digest **within the same `origin`**; the same
  digest under `LEGACY` and under `TARGET` is allowed and means visual parity;
- one viewport per slice, unless the UI behavior's kind is `RESPONSIVE` or the
  state is `DESKTOP`/`MOBILE`.

### Runtime availability

Availability is explicit, never an absence. `migration_status` and
`discover-module.mjs --status` both report `uiEvidence.runtime` as one of
`NOT_APPLICABLE`, `REQUIRED`, `AVAILABLE`, or `NOT_AVAILABLE`. When the runtime
cannot be reached, record the reason in `uiEvidenceLimitations`:

```json
{
  "uiBehaviorId": "UIB-1",
  "state": "SEARCH",
  "availability": "NOT_AVAILABLE",
  "reason": "The target dev server is not running in this environment."
}
```

A limitation is not a waiver. Verification still refuses to pass and names the
recorded reason; the operator resolves it through the ordinary blocker contract.

### Safety and invalidation

No `uiEvidence` or limitation may carry credential material: a key that names a
password, secret, token, cookie, authorization, credential, or API key — or a
value shaped like one — is refused before it is persisted. Verification is
read-only; mutation testing uses disposable fixture data.

Evidence stales only on what it is bound to: the slice implementation digest,
the UI contract digest (behavior plus disposition), the requirements digest, the
target, and the data-source mode. Changing provider or session — Claude, Codex,
Copilot, OpenCode — never invalidates it, and an unrelated target file never
stales another slice's evidence. Once an affected slice verifies,
`ui-remediation.json` is pinned with its evidence and remains part of the
immutable set through `FINALIZE` and `COMPLETE`.

## Behavior parity

`matrices/behavior-parity.json` contains one row per legacy behavior:

```json
{
  "version": 1,
  "rows": [
    {
      "id": "PAR-001",
      "behaviorId": "BEH-001",
      "targetState": "PARTIAL",
      "disposition": "UPDATE",
      "sliceId": "catalog-001",
      "implementationStatus": "PENDING",
      "verificationStatus": "PENDING",
      "legacyEvidence": ["legacy/path.tsx"],
      "targetEvidence": ["src/features/catalog/path.tsx"]
    }
  ]
}
```

Final allowed verification states are `VERIFIED`, `REDESIGNED_VERIFIED`,
`EXCLUDED_APPROVED`, and `DEAD_CONFIRMED`.

## Route adaptation

`matrices/route-adaptation.json` contains one row per legacy route flow:

```json
{
  "version": 1,
  "rows": [
    {
      "id": "ROUTE-001",
      "routeFlowId": "FLOW-001",
      "targetAdaptation": "Target-native catalog routes.",
      "preservesIndependentListAndDetail": false,
      "decision": "PENDING",
      "approval": null,
      "acceptanceScenario": null,
      "sliceId": "catalog-001",
      "implementationStatus": "PENDING",
      "verificationStatus": "PENDING",
      "evidence": []
    }
  ]
}
```

When the legacy flow declares `independentListAndDetail: true`, setting
`preservesIndependentListAndDetail: false` requires:

- `decision: REDESIGNED_APPROVED`;
- non-empty explicit `approval`;
- a named `acceptanceScenario`.

Otherwise validation returns `NAVIGATION_FLOW_GAP`.

## Design-system usage

`matrices/design-system-usage.json` maps every target UI component:

```json
{
  "version": 1,
  "rows": [
    {
      "id": "DESIGN-001",
      "componentId": "UI-001",
      "authority": "@target/ui",
      "expectedComponent": "Select",
      "actualComponent": "select",
      "actualSource": "native HTML",
      "status": "DESIGN_SYSTEM_GAP",
      "exceptionApproval": null,
      "sliceId": "catalog-001",
      "verificationStatus": "PENDING",
      "evidence": ["src/features/catalog/components/filters.tsx"]
    }
  ]
}
```

When an equivalent target-required component exists, `actualSource` must match
the exact `authority` source. Otherwise the row must be `DESIGN_SYSTEM_GAP` or
`EXCEPTION_APPROVED`. An exception requires explicit
approval. Finalization requires `COMPLIANT` or `EXCEPTION_APPROVED` plus
`verificationStatus: VERIFIED`.

## Capability ownership

`matrices/capability-ownership.json` (format 11; artifact binding at format 13)
answers the question the four
matrices above never asked. Design-system usage covers a capability that
**exists** in the target and must be reused. This covers one that **does not**:
where does it get built? Without it, an agent migrating a module rebuilt every
shared table, search and form shell inside that module's own feature folder,
and nothing recorded that a choice had been made.

Authored at `BUILD_BASELINE` — the only checkpoint that reads both inventories,
because ownership needs legacy consumer evidence _and_ target existence
evidence. `ASSESS_TARGET` stays observational: `inventories/target.json`
describes what exists, it does not decide future ownership.

```json
{
  "version": 1,
  "architectureAuthorities": ["docs/architecture-standard.md"],
  "authorityGaps": [
    {
      "expected": "target/ARCHITECTURE.md",
      "reason": "Cited by the repository instructions; absent from the tree."
    }
  ],
  "rows": [
    {
      "id": "CAP-001",
      "capability": "Paginated data table with search",
      "classification": "SHARED_PREREQUISITE",
      "requiredDisposition": "CREATE_SHARED",
      "legacyEvidence": ["legacy/src/shared/components/data-table/index.tsx"],
      "targetEvidence": [],
      "consumers": ["users", "partners", "brands"],
      "targetOwner": "src/shared/components/data-table",
      "artifactMigration": {
        "source": "src/shared/components/data-table",
        "type": "component",
        "target": "src/shared/components/data-table"
      },
      "replacedBy": [],
      "rationale": "Consumed by nine legacy feature slices; absent from the target."
    }
  ]
}
```

`classification` → `requiredDisposition` is a strict 1:1 map, validated exactly
like behavior parity's `targetState` → `disposition`:

| `classification`      | `requiredDisposition`  | Companion requirement                                                                                                                                                                                                              |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TARGET_REUSE`        | `REUSE_EXISTING`       | non-empty `targetEvidence` that resolves                                                                                                                                                                                           |
| `SHARED_PREREQUISITE` | `CREATE_SHARED`        | at least two normalized `consumers` other than the migrating module, each present in the pinned discovery supporting census; `targetOwner` **outside** `src/features/<targetModule>/`; format 13 also requires `artifactMigration` |
| `FEATURE_LOCAL`       | `CREATE_FEATURE_LOCAL` | `targetOwner` **inside** `src/features/<targetModule>/`                                                                                                                                                                            |
| `DO_NOT_MIGRATE`      | `NONE`                 | at least one `replacedBy` naming a real baseline row id or an OpenSpec requirement id                                                                                                                                              |

Shared ownership is proven, never assumed: one consumer is feature-local by
definition, so the two-other-consumer rule is what stops blind promotion of
everything into the shared layer. In the other direction, "shared" needs no
invented layer taxonomy — the rule is only _not inside the feature being
migrated_, which every shared, infrastructure or design-system location
satisfies without the contract asserting a convention the target may not have.
At format 13, `artifactMigration` contains exactly `source`, `type`, and
`target`. `source` is legacy-root-relative and must exist, `type` is a safe
lowercase name, and `target` is target-root-relative and equals `targetOwner`
or lies below it. The artifact id is derived from `{source,type}`; no child
lifecycle state is persisted in this matrix.

`architectureAuthorities` entries must resolve like any other evidence, so a
document the repository does not have cannot be cited as if it did. A genuinely
missing authority goes in `authorityGaps` (required array, may be empty).

`DO_NOT_MIGRATE` is the one dismissive classification, and prose never carries
it: it must name the baseline row or requirement that covers the capability
instead. No operator decision is required — every rule here is decidable from
repository evidence, so an autonomous loop is not stopped by one.

The matrix has no mutable field. Slice assignment lives in `slices/index.json`,
not here, so unlike behavior parity it is pinned as a plain file in the
immutable artifact set and needs no derived `#immutable-rows` projection.

## Target-native behavior

`matrices/target-native.json` records behavior that belongs to the target and
must not disappear merely because it has no legacy equivalent. A row that is
not yet `PRESERVED` requires implementation or verification and must be assigned
to exactly one slice's `traceIds`. Finalization requires every row to be
`PRESERVED`.

## Slice index and records

The three identifier lists are disjoint and separately owned:

| Field            | Owner                | Allowed values                                                                   |
| ---------------- | -------------------- | -------------------------------------------------------------------------------- |
| `requirementIds` | OpenSpec authority   | IDs in `requirementsAuthority.requirementIds`                                    |
| `scenarioIds`    | OpenSpec authority   | IDs in `requirementsAuthority.scenarioIds`                                       |
| `traceIds`       | baseline matrices    | `id` of a behavior-parity, route-adaptation, target-native, or design-system row |
| `capabilityIds`  | capability ownership | `id` of a capability-ownership row (format 11)                                   |

`acceptanceScenarios` is authored prose and is never an identifier source.
Every non-terminal baseline row belongs to exactly one slice's `traceIds`,
including every target-native row that is not yet `PRESERVED`, and
`slices/index.json` requires a non-empty `acceptanceScenarios` array:

```json
{
  "version": 1,
  "slices": [
    {
      "id": "shared-001",
      "title": "Create the shared table the catalog depends on",
      "requirementIds": ["CATALOG-REQ-002"],
      "scenarioIds": ["CATALOG-SCN-002"],
      "traceIds": ["PAR-002"],
      "capabilityIds": ["CAP-001"],
      "architectureAuthorities": ["docs/architecture-standard.md"],
      "targetPaths": ["src/shared/components/data-table"],
      "dependencies": [],
      "acceptanceScenarios": ["The shared table paginates and searches."]
    },
    {
      "id": "catalog-001",
      "title": "Restore navigation and design-system compliance",
      "requirementIds": ["CATALOG-REQ-001"],
      "scenarioIds": ["CATALOG-SCN-001"],
      "traceIds": ["PAR-001", "ROUTE-001", "DESIGN-001"],
      "capabilityIds": ["CAP-004"],
      "architectureAuthorities": ["docs/architecture-standard.md"],
      "targetPaths": ["src/features/catalog"],
      "dependencies": ["shared-001"],
      "acceptanceScenarios": [
        "Open list, select entry, view detail, and return."
      ]
    }
  ]
}
```

For format 11, `PLAN` also owns capability scheduling. Every
`SHARED_PREREQUISITE` and `FEATURE_LOCAL` row belongs to exactly one slice's
`capabilityIds`; `TARGET_REUSE` and `DO_NOT_MIGRATE` are terminal and need no
slice. A shared prerequisite does **not** have to be implemented before `PLAN`
closes — it has to be deterministically ordered ahead of the work that needs
it:

- a slice owning at least one `SHARED_PREREQUISITE` is a **prerequisite slice**;
- every other slice must list every prerequisite slice in `dependencies`;
- every `dependencies` entry must be a known slice id, never the slice itself,
  and must be declared **earlier** in `slices`.

`pendingSlices` is derived from declaration order, so requiring dependencies to
be declared first makes declaration order a valid topological order and makes
cycles structurally impossible — no separate scheduler, and no way to run a
feature slice before the shared capability it consumes. `architectureAuthorities`
and `targetPaths` are validated as evidence at the same checkpoint.

At `IMPLEMENT_SLICES`, a slice owning a `SHARED_PREREQUISITE` must record at
least one `changedFiles` entry under that row's `targetOwner`. `PLAN` proves the
capability was scheduled; this proves it landed where the matrix said it would,
rather than being rebuilt inside the feature after all.

`slices/<slice-id>.json` records implementation. Each `changedFiles` entry
must be a real path inside the target repository (P1-7): while the slice is
not yet `IMPLEMENT_SLICES`-complete, it must also be part of the target
repository's current uncommitted diff — a slice may not claim a file it
didn't actually touch:

```json
{
  "id": "catalog-001",
  "implementationStatus": "COMPLETE",
  "requirementIds": ["CATALOG-REQ-001"],
  "scenarioIds": ["CATALOG-SCN-001"],
  "traceIds": ["PAR-001", "ROUTE-001", "DESIGN-001"],
  "changedFiles": ["src/features/catalog/..."],
  "decisions": ["Follow target routing conventions and use @target/ui."],
  "checks": ["pnpm test"]
}
```

`evidence/<slice-id>/result.json` records verification. While the slice is
not yet `VERIFY_SLICES`-complete, each `commands` entry is a structured
record (P1-7), not a bare string: `command`, `exitCode` (must be `0`),
`executedAt` (ISO timestamp), `runner` (tool/environment identity), and
`outputPath`/`outputDigest` naming a real captured-output file under the
legacy or target repository whose current SHA-256 must match `outputDigest`:

```json
{
  "sliceId": "catalog-001",
  "result": "PASS",
  "requirementIds": ["CATALOG-REQ-001"],
  "scenarioIds": ["CATALOG-SCN-001"],
  "traceIds": ["PAR-001", "ROUTE-001", "DESIGN-001"],
  "commands": [
    {
      "command": "pnpm test",
      "exitCode": 0,
      "executedAt": "2026-08-11T00:00:00.000Z",
      "runner": "node v24.0.0",
      "outputPath": ".agents/knowledge/migrations/modules/catalog/evidence/catalog-001/commands/test.txt",
      "outputDigest": "sha256:…"
    }
  ],
  "residualRisks": []
}
```

## Final gates

`gates.json` contains exactly the seven mandatory gates. Every final row must
have `result: PASS`, integer attempts from 1 through 3, and at least one
evidence entry — but "evidence" is a structured, bound, fresh record, not an
arbitrary string. A gate can never `PASS` on evidence that is stale, or that
was produced for a different target, revision, requirements digest, or
execution mode:

```json
{
  "gate": "SIMPLIFY_ONCE",
  "result": "PASS",
  "attempts": 1,
  "evidence": [
    {
      "kind": "review",
      "reference": "docs/ponytail-review.md",
      "producedAt": "2026-08-05T10:00:00Z",
      "producer": "agent-session-4f2c",
      "environment": "local",
      "hash": "sha256:<digest of the referenced artifact, or of the reference string if it isn't a file>",
      "boundTo": {
        "target": "catalog",
        "legacyRevision": "<sha>",
        "targetRevision": "<sha>",
        "requirementsDigest": "sha256:<digest>",
        "dataSourceMode": "standard",
        "legacyDirtyDigest": "<dirtyManifest digest>",
        "targetDirtyDigest": "<dirtyManifest digest>"
      }
    }
  ]
}
```

Every field is required. Validation rejects an evidence entry (and therefore
the gate) when:

- any `boundTo` value doesn't match the migration's _current_ resolved target,
  legacy revision, requirements digest, or data-source mode — evidence from a
  different target, a stale legacy revision, a changed spec, or the other
  execution mode (mock vs. standard) never satisfies a gate;
- `legacyDirtyDigest`/`targetDirtyDigest` don't match the current uncommitted
  legacy/target tree (the same `dirtyManifest` used elsewhere in this
  contract) — nothing is committed before FINALIZE, so `legacyRevision`/
  `targetRevision` alone never move when a dirty file changes; binding the
  dirty manifest too means an uncommitted edit invalidates evidence authored
  before it happened, even when no evidence entry names that file directly;
- `producedAt` predates the thing it's evidence for — evidence timestamped
  before the requirements digest or legacy revision it claims to satisfy was
  even pinned is stale by construction;
- a required field is missing.

Ponytail evidence uses the same structured shape with `kind: "review"` or
`kind: "audit"`. `full` requires that shape on `SIMPLIFY_ONCE`; `full-audit`
also requires it on `PRECOMMIT_GATE`. The type/binding check runs first;
Ponytail's `kind` requirement is layered on top of it, never a substitute for
it.

`FUNCTIONAL_PARITY_GATE` cannot be omitted or made not applicable.

## Content identity for ordinary file pins

Every digest that identifies *a file* — an `artifactHashes` pin, `brief.digest`,
`targetAdoption.baseline.digest`, `requirementsAuthority.digest`, an evidence
entry's `hash`, a command result's `outputDigest` — is a **content identity**,
not a raw hash of whatever bytes the checkout happens to hold. One
implementation owns it: `migration-utils.mjs`, exported through `core.mjs`.

New identities are written tagged:

```text
sha256:text-lf-v1:<64 lowercase hex>   every CRLF pair replaced by LF, then hashed
sha256:bytes-v1:<64 lowercase hex>     the exact bytes, hashed
```

Text classification is deterministic and platform-independent: the file's
extension must be on the frozen v1 allowlist (`.md .mdx .txt .json .yaml .yml
.ts .tsx .mts .cts .js .jsx .mjs .cjs .css .scss .sass .less .html .htm .xml
.svg .csv .log`, case-insensitive) **and** its bytes must be valid UTF-8 with no
binary control byte (C0 other than TAB/LF/CR, or DEL). Anything else — an
unknown extension, invalid UTF-8, UTF-16, real binary — is `bytes-v1`. No OS,
provider, locale, Git setting, or size heuristic participates, so two checkouts
of one blob always classify the same way. Changing these rules requires a new
identity version, never a redefinition of `text-lf-v1`.

Only CRLF/LF placement is folded. A BOM, a lone CR, trailing whitespace, the
presence or absence of a final newline, Unicode representation and JSON
formatting all still change the identity, and content is never parsed and
reserialized to compute one.

### Backward compatibility

The bare `<64 hex>` and `sha256:<64 hex>` spellings stay valid wherever they
were already accepted, and existing pins are never bulk-converted: a successful
read retains the recorded digest in memory and on disk. For an eligible text
file, a recorded untagged digest is compared against exactly three candidates —
the current bytes, those bytes with CRLF replaced by LF, and that result with LF
replaced by CRLF. That accepts an unchanged file, a historical LF pin read on a
CRLF checkout, and a committed CRLF pin read on a Git-normalized LF checkout,
without needing the original blob. Binary and unknown content, and every
byte-sensitive purpose, get exact matching only.

Arbitrary historical mixed-CRLF/LF placement cannot be reconstructed from a hash
after folding. When none of the three candidates matches, the read **fails
closed** with the affected reference; the current file is never trusted, rehashed
as a repair, or guessed at. Recovery needs the original bytes from version
control and an explicit authorized workflow.

A malformed digest, or a tag this engine does not know, matches nothing. A
tagged identity means exactly what its tag says and is never retried under the
other scheme: `bytes-v1` is byte equality, and a `text-lf-v1` tag on ineligible
content — or under a byte-sensitive purpose — is refused rather than downgraded.

When a composite authority or manifest is compared (the OpenSpec authority
object, an implementation digest), each file is verified individually and its
**recorded** identity is
carried into the comparison projection, so a re-spelled checkout produces no
false drift and every `boundTo` digest copied from it stays valid. All other
fields are still compared exactly.

### Raw-byte exceptions

These keep their existing SHA-256 algorithms and are never routed through
content identity. Their bytes are the record, so an EOL difference in one is a
real difference, and they must be transported unchanged:

- the integrity-map/state serialization anchors and the audit history;
- `decisions/operator-decisions.ndjson`, its byte-length anchor, and every
  approval candidate digest (including accepted target-drift path digests);
- raw confirmation inputs — `dirtyManifest` digests, `registryDigest`,
  `briefDigest` and the rest of `boundInputs`, and the artifact confirmation
  preimage;
- transaction and recovery preimages (`stateHash`, journal envelopes);
- preserved evidence under `rework/<slice-id>-<n>/`, `stale-ui-evidence/`,
  `slice-amendments/` and `visual-contract-adoption/`, and the visual-contract
  adoption preimage;
- the derived and semantic projections (`BASELINE_ROWS_PIN`, `DISCOVERY_PIN`,
  `#semantic`, `#immutable`), which are computed from parsed documents rather
  than from file bytes.

Status paths use the same shared matcher through their normal readers. A
legitimate EOL-only change returns the ordinary structured status or progress
result, and status still writes nothing: no pin, state, evidence, lock,
directory, replayed transaction, or Git index write. Genuine failures are
preserved exactly as before.

### Engine compatibility

Tagged identities are written by this engine version onward. Older engine builds
do not parse them, so every provider tree must be on the updated engine before a
record writes one. There is no downgrade path.

## Integrity, resumption, and invalidation

Advancing a step stores SHA-256 hashes of its step file and machine-readable
dependencies in `state.json`. Format 5 also writes `integrity.json`, an anchor
outside `state.json` holding the current revision and a digest of
`artifactHashes`, in the same journalled transaction as the state write. Every
read cross-checks `state.artifactHashes` against this anchor, so pruning or
rewriting a pin inside `state.json` alone — without also forging the
independently-written anchor — is refused. A format-4 tree (created before
this anchor existed) has none yet and is not blocked for it; the next advance
writes one.

Format 9 adds `integrity.history` to that same anchor: the byte length of
`history/history.ndjson` and a SHA-256 of exactly those bytes, as the record
stood when the state was written. Every read requires the current file to
still begin with that pinned prefix, unchanged, so truncating the audit record
or back-dating an event in place is refused instead of reported as no
blockers. Only the newest event is uncovered — it is appended after the state
write on purpose, and the next transition pins it. A tree recorded before
format 9 has no history anchor and is not blocked for it; the next advance
writes one.

`validateStateShape` additionally requires `completedSteps` to be
exactly the `MIGRATION_STEPS` prefix before `currentStep`, checked from the
state shape alone, without reading history.

Resume verifies completed hashes before loading the current artifact — and
also runs a read-only consistency check between
`state.json`'s navigation fields (`currentStep`, `activeSlice`,
`pendingSlices`) and the actual contents of `slices/*.json` and
`evidence/*/result.json`. This runs on every normal resume, not only during
the one-time contract upgrade: if the two ever disagree — for example
`state.json` was hand-edited, which SKILL.md forbids but nothing used to
detect — resume blocks with a named inconsistency instead of silently
trusting `state.json`. It never auto-repairs during normal resume; repairing
navigation state is a one-time upgrade-coordinator operation, not something
that happens quietly in the background of everyday use.

If a completed artifact changes or disappears, the migration cannot advance
using stale downstream evidence. Reopen the responsible checkpoint. Refresh
reopens from `DISCOVER_LEGACY`, preserves authored files, records invalidated
artifacts, and appends a history event.

The immutable artifact set is exactly `steps/01-resolve.md` and `brief.md` when
present, `steps/02-discover-legacy.md` with `inventories/legacy.json`,
`steps/03-assess-target.md` with `inventories/target.json`,
`steps/04-build-baseline.md` with `matrices/capability-ownership.json`
(format 11), `steps/05-plan.md` with `slices/index.json`,
`steps/08-finalize.md` with `gates.json`, and the slice and evidence records of
each completed slice. Format 12 also pins `ui-remediation.json` after a reopened
UI slice verifies. The other four `matrices/*.json` are deliberately
excluded: they record progress that later steps legitimately update, so they
are validated on every step that reads them rather than frozen by hash. The
capability matrix is the exception because it carries no mutable field — slice
assignment lives in `slices/index.json`, not in the matrix.

`history/history.ndjson` is genuinely append-only: each event is written with
an OS-level append (`O_APPEND`), never a read-modify-rewrite of the whole
file, so two writers appending at once cannot silently clobber each other's
line the way a read-then-full-rewrite would. A successful contract-4 upgrade
appends exactly one `UPGRADED_V4_TO_V5` event; a failed one appends none.

## What resume never justifies

Mirrored here from `SKILL.md` because this is the file an agent reads while
authoring, and these are the rules most often broken at exactly that moment.

Persisted state is the source of truth across conversations, models, and
providers. A bare `/start-migration <module>` continues from the saved
artifact. Having been interrupted — by a crash, a session end, a different
model, or an abandoned `--mode auto` loop — is never a reason to:

- add `--refresh` (it invalidates the whole migration for a target-side cause
  it was never meant to address);
- recreate a slice, or re-author one whose record is already pinned;
- overwrite authored evidence, or regenerate it to make a check pass;
- restart discovery;
- hand-edit `state.json` — not its navigation fields, not its artifact hashes;
- truncate or rewrite `history/history.ndjson`, `integrity.json`, or
  `decisions/operator-decisions.ndjson`.

An interrupted checkpoint transition is repaired by the engine, not by hand.
`advance.journal` records the transition that was in flight; the next resume
recovers under the module lock, replaying or rolling back deterministically,
and only then previews. A record whose integrity anchor sits one revision ahead
of its state is a *pending transaction*, not a tampered record, and it says so.

A journal that cannot be parsed is the one case where nothing can be proven —
the from/to revisions are exactly what was lost. It is preserved byte-for-byte
and the command refuses, because deleting it would destroy the only evidence of
what was in flight.

## Slice rework and preserved evidence

At format 16 a slice that fails verification for a real defect has a legal way
back to implementation, and taking it never destroys the evidence that caused
it.

- `evidence/<slice-id>/result.json` is the **mutable current attempt**. It holds
  exactly one result — the newest. It is not the archive.
- `rework/<slice-id>-<n>/` holds every superseded attempt: `result.json` as the
  exact bytes that were recorded, `evidence/**` as copies of every file the
  defects named, and `record.json` with the defect set, the operator, the prior
  digest and the SHA-256 of every preserved file. The digests are metadata
  *about* the preserved bytes; they never stand in for them.
- Every preserved path is pinned in `artifactHashes` and is **never released by
  any later transition**, including `--refresh`.
- A `FAIL` is legal only with a non-empty `defects[]`, each naming
  `{ traceId | scenarioId, observed, expected, evidenceReference, hash }` under
  the same evidence-reference rules the FINALIZE gates use.
- A slice may be reworked at most three times. The fourth is `BLOCKED`.
- A reworked slice's terminal result must carry `producedAt`, and it must be
  later than the newest preserved attempt.
- A missing preserved path refuses with `REWORK_EVIDENCE_MISSING`; an altered
  one refuses as a hash mismatch. Deletion and mutation are different forensics.

## Unclaimed target drift

`COMPLETE` means every modified byte in the target is attributable. At
`VERIFY_SLICES` an unattributable path is reported in the authoring request; at
`FINALIZE` it is a hard refusal naming every path. A modified target path is
one of:

| Class | Disposition |
| --- | --- |
| Under `.agents/knowledge/migrations/` | The engine's own workspace — excluded |
| The record's own authored files (OpenSpec authority, brief) | `ENGINE_AUTHORED` |
| Claimed by a validated slice | Not drift |
| Under a slice with an active rework | `AUTHORIZED_REWORK` |
| Under a delegated `targetOwner` | `AUTHORIZED_DELEGATION` — the child record owns it |
| Accepted by a ledger-backed operator decision bound to its bytes | `OPERATOR_ACCEPTED` |
| Anything else | `UNCLAIMED_TARGET_DRIFT` — blocks `FINALIZE` |

The acceptance is a `TARGET_DRIFT_ACCEPTED` operator decision recorded by
`record-decision.mjs` under the same challenge phrase as every other approval —
never a CLI flag. It binds to the path's SHA-256, so editing the file after
acceptance invalidates the decision and re-blocks.

It is the only decision kind that may be appended after
`DISCOVERY_COMPLETENESS` closes: every other approval binds to facts that
checkpoint already pinned. The ledger pin is a prefix, so the approvals it
covers stay immutable while a late acceptance can still be recorded.

## Unsupported contract-2 and contract-3 workflows

Contract 2 and contract 3 are retired. Their checklists live at
`.agents/knowledge/migrations/modules/<module>.md`. When one exists, the helper
refuses to bootstrap a migration for that module, reports the workflow as
unsupported, and leaves every file at its original path and bytes. Legacy
content is never parsed as active version-4 state, converted, moved, deleted, or
used as completion proof. There is no automatic import path.
