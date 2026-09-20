# Contract v5 (frozen)

This document is the frozen authority for contract version 5 and for the single
approved contract-4 to contract-5 upgrade. Its SHA-256 digest is an input to
every upgrade confirmation ID: editing this file expires all outstanding
confirmations, by design.

Approved 2026-08-03. Version axes selected by this freeze:

| Axis | v4 | v5 |
| --- | ---: | ---: |
| `contractVersion` | `4` | `5` |
| `formatVersion` | `3` | `4` |
| `workflowVersion` | `4.5` | `5.0` |

`formatVersion` moves to `4` because the trace schema, the typed Ponytail
evidence rule, and the persisted state shape all change incompatibly. It is not
`5`: the format number never tracks the workflow number.

`scripts/resumable-migration.mjs` remains the single authority for the three
constants. Every value here restates them.

## 1. Frozen decisions

### 1.1 Step graph

**Selected:** keep the eight v4 step IDs, their order, and their artifact
ownership. No additions, removals, or renames.

| v4 step ID | v5 step ID |
| --- | --- |
| `RESOLVE` | `RESOLVE` |
| `DISCOVER_LEGACY` | `DISCOVER_LEGACY` |
| `ASSESS_TARGET` | `ASSESS_TARGET` |
| `BUILD_BASELINE` | `BUILD_BASELINE` |
| `PLAN` | `PLAN` |
| `IMPLEMENT_SLICES` | `IMPLEMENT_SLICES` |
| `VERIFY_SLICES` | `VERIFY_SLICES` |
| `FINALIZE` | `FINALIZE` |

The mapping is the identity. No rename table is required and none may be
introduced by the upgrader.

- **Persisted fields:** `currentStep`, `completedSteps`, `pendingSteps`.
- **Compatibility:** none of these values change during upgrade.
- **Tests:** identity mapping asserted for every fixture checkpoint.

### 1.2 Trace schema

**Selected:** three disjoint, separately owned ID fields. No overloading.

| Field | Owner | Allowed values |
| --- | --- | --- |
| `requirementIds` | OpenSpec authority | IDs listed in `requirementsAuthority.requirementIds` |
| `scenarioIds` | OpenSpec authority | IDs listed in `requirementsAuthority.scenarioIds` |
| `traceIds` | Baseline matrices | `id` values of behavior-parity, route-adaptation, target-native, and design-system rows |

All four baseline matrices own trace identifiers. A target-native row whose
`verificationStatus` is not yet `PRESERVED` still requires implementation or
verification, so it must belong to exactly one slice's `traceIds`, exactly like
a behavior, route, or design-system row. A row that is already `PRESERVED` is
terminal and needs no slice.

`acceptanceScenarios` is preserved verbatim as authored prose. It is never an
identifier source and is never parsed for IDs.

Contract v4 overloaded `requirementIds` with both OpenSpec IDs and matrix row
IDs. The upgrade splits each v4 `requirementIds` array by exact membership:

1. an ID present in `requirementsAuthority.requirementIds` moves to
   `requirementIds`;
2. an ID present in `requirementsAuthority.scenarioIds` moves to `scenarioIds`;
3. an ID equal to a baseline matrix row `id` moves to `traceIds`;
4. any other ID, or an ID matching more than one of the above, is an
   **ambiguity blocker**. The upgrade stops and produces no confirmation ID.

Membership is exact string equality against the persisted authority and the
persisted matrices. Shape heuristics and prefix guessing are prohibited.

The split applies identically to `slices/index.json`, `slices/<slice-id>.json`,
and `evidence/<slice-id>/result.json`. Relative order within each ID list is
preserved. A v4 array that already carries `scenarioIds` or `traceIds` keys has
those keys merged, and any duplicate across the resulting three lists is an
ambiguity blocker.

- **Persisted fields:** `slices/index.json`, `slices/<slice-id>.json`,
  `evidence/<slice-id>/result.json`.
- **Compatibility:** a v4 plan whose IDs are all resolvable upgrades with
  completion preserved; every other v4 plan blocks.
- **Tests:** clean split; matrix-only slice; OpenSpec-only slice; unknown ID;
  duplicated ID; ID claimed by two owners; pre-existing `traceIds`; a
  target-native row that survives the split and is required by the plan.

### 1.3 Ponytail

**Selected:** enforce documented evidence through a typed field. No regex over
prose.

`gates.json` rows accept an optional `ponytailEvidence` object:

```json
{ "kind": "review", "reference": "docs/ponytail-review-2026-08-03.md" }
```

`kind` is `review` or `audit`. `reference` is a non-empty string.

Enforcement runs only when `FINALIZE` is completed:

- `ponytail: "full"` requires `SIMPLIFY_ONCE` to carry `kind: "review"`;
- `ponytail: "full-audit"` requires that, and additionally `PRECOMMIT_GATE` to
  carry `kind: "audit"`;
- `ponytail: null` requires nothing.

- **Persisted fields:** `gates.json`.
- **Compatibility:** the upgrade never writes `ponytailEvidence`. A v4
  migration with Ponytail enabled and no typed evidence has `FINALIZE`
  reopened; its authored `gates.json` is left untouched.
- **Tests:** each Ponytail mode at `FINALIZE`; missing evidence reopens; wrong
  `kind`; empty `reference`; `ponytail: null` unaffected.

### 1.4 Brief

**Selected:** the brief is an optional immutable loaded input, hashed like any
other immutable artifact.

v5 state carries:

```json
"brief": { "path": "brief.md", "digest": "sha256:<64 hex>" }
```

or `null` when no brief was supplied. `brief.md` joins the immutable artifact
set, so a changed brief reopens the owning checkpoint exactly as a changed step
document does.

- **Persisted fields:** `state.brief`, `artifactHashes["brief.md"]`.
- **Compatibility:** derived from the existing `artifacts.brief` entry and the
  bytes already on disk. A recorded `artifacts.brief` whose file is missing is a
  blocker.
- **Tests:** brief present; brief absent; brief recorded but missing; brief
  modified after upgrade reopens.

### 1.5 Navigation

**Selected:** keep the v4 representation unchanged. `currentStep` and
`activeSlice` are authoritative. `completedSteps`, `pendingSteps`,
`completedSlices`, and `pendingSlices` remain persisted derived fields;
collapsing them is deferred (plan section 16).

`inspectSliceArtifacts` and `reconcileSliceState` are retained active helpers.
The upgrade coordinator calls `reconcileSliceState` read-only to produce
reconciled navigation and passes it into the pure transformation, which
performs no filesystem access.

- **Persisted fields:** `currentStep`, `activeSlice`, `completedSteps`,
  `pendingSteps`, `completedSlices`, `pendingSlices`.
- **Compatibility:** navigation is system-owned (plan section 7) and may be
  reconciled against slice records and PASS evidence during upgrade.
- **Tests:** every checkpoint; active implementation slice; active verification
  slice; reconciliation repairs recorded in the upgrade event.

### 1.6 `BLOCKED`

**Selected:** `BLOCKED` is preflight-only in v5. It is never persisted.

Persisted v5 `status` is `ACTIVE` or `COMPLETE`. The `blockers` array is removed
from persisted state; blockers are computed and reported by the preflight.

A v4 state with `status: "BLOCKED"` or a non-empty `blockers` array is a
**blocker for the upgrade itself**. The upgrade refuses, reports the recorded
blockers, and changes nothing. Resolve the blocker under v4 first.

- **Persisted fields:** `status`; `blockers` removed.
- **Compatibility:** read compatibility only. No transition manufactures an
  unblocked state.
- **Tests:** persisted `BLOCKED` refuses; non-empty `blockers` with `ACTIVE`
  status refuses; `ACTIVE` and `COMPLETE` upgrade normally.

### 1.7 Baseline integrity

**Selected:** matrices are validated mutable progress. The immutable artifact
set is exactly:

| Step | Immutable artifacts |
| --- | --- |
| `RESOLVE` | `steps/01-resolve.md`, `brief.md` when present |
| `DISCOVER_LEGACY` | `steps/02-discover-legacy.md`, `inventories/legacy.json` |
| `ASSESS_TARGET` | `steps/03-assess-target.md`, `inventories/target.json` |
| `BUILD_BASELINE` | `steps/04-build-baseline.md` |
| `PLAN` | `steps/05-plan.md`, `slices/index.json` |
| `IMPLEMENT_SLICES` | `slices/<slice-id>.json` of each completed slice |
| `VERIFY_SLICES` | `slices/<slice-id>.json` and `evidence/<slice-id>/result.json` of each completed slice |
| `FINALIZE` | `steps/08-finalize.md`, `gates.json` |

`matrices/*.json` are deliberately absent as *files*: they record progress that
later steps legitimately update. They are validated on every step that reads
them, not frozen by hash.

`BUILD_BASELINE` does pin one derived entry,
`matrices/behavior-parity.json#immutable-rows` (P2-2): a digest of every
behavior-parity row's `id`, `behaviorId`, `targetState`, and `legacyEvidence`,
with rows ordered by `id`. It is keyed by a path that cannot exist because it
is derived from the matrix, not read from a file. `verificationStatus` and
every other field stay mutable, so a row can still be verified after the
checkpoint closes — but a closed row's identity and legacy evidence cannot be
rewritten.

- **Persisted fields:** `artifactHashes`.
- **Compatibility:** identical to v4 except that `brief.md` is added, plus the
  format-8 baseline row pin. A migration that closed `BUILD_BASELINE` under an
  older format has no pin; its next advance computes one from the matrix as it
  then stands and stamps format 8 in the same transaction.
- **Tests:** each immutable artifact reopens its owner when changed; a changed
  `verificationStatus` does not; a rewritten `legacyEvidence` does.

### 1.8 Registration

**Selected:** keep the post-baseline registration intermission, and give the
registration command the same exact two-phase confirmation as every other
mutating helper.

`update-migration-registry.mjs` gains a read-only preview that prints the
resolved registry path, module, target, aliases, and the resulting change, plus
a confirmation ID bound to that snapshot. It writes only when re-invoked with
`--confirm-execution <id>`.

- **Persisted fields:** the registry document.
- **Compatibility:** advancing `BUILD_BASELINE` still requires a registered
  mapping. The intermission does not move.
- **Tests:** preview writes nothing; confirmation executes; stale confirmation
  rejected after the registry changes; no-op registration reports unchanged.

### 1.9 CLI v5 surface

**Selected:**

| Option | v5 |
| --- | --- |
| `--next` | removed (never had behavior distinct from a bare invocation) |
| `--gate` | removed |
| `--ready` | removed |
| `--sync-formats` | removed with the generic synchronizer |
| `--registry` | accepted only on first setup; confirmed execution persists the binding for every helper |
| `--step` | retained, including the equality guard against `currentStep` |
| `--slice` | retained, read-only and targeted |
| `--confirm-execution` | retained, internal |

- **Persisted fields:** none.
- **Compatibility:** removed options fail argument parsing with a message that
  names the v5 replacement path.
- **Tests:** each removed option rejected; each retained option exercised.

### 1.10 `mappingRegistered`

**Selected:** removed from persisted v5 state and derived from the registry at
read time.

- **Persisted fields:** `mappingRegistered` deleted.
- **Compatibility:** registration status is a property of the registry, not a
  cached snapshot that can disagree with it.
- **Tests:** registered and unregistered modules resolve identically after
  upgrade.

### 1.11 Fresh initialization and OpenSpec ownership

**Selected:** `RESOLVE` owns initial OpenSpec creation. Its configured
`openspec/specs/<target-module>/spec.md` may be absent only while the migration
is `NOT_STARTED` at `RESOLVE`; absence is mandatory-blocking once state exists.

The first preflight keeps an evidence-based proposal in memory, validates its
stable requirement/scenario IDs and normative language, and binds its SHA-256
digest into the execution confirmation. Preview writes nothing. Confirmed
execution transactionally creates the exact proposed bytes together with the
complete migration tree, creation history, and persisted registry binding,
then records `DISCOVER_LEGACY` as current. Failure rolls all initialization
outputs back. Deleted authorities are never manually restored and generic
placeholder requirements are prohibited.

- **Persisted fields:** `requirementsAuthority` plus the OpenSpec source bytes.
- **Compatibility:** existing initialized migrations continue to require an
  exact authority match; only the pre-state `NOT_STARTED` classification
  changes.
- **Tests:** fresh absence, no-write preview, confirmed creation, continuation,
  post-init absence, stale confirmation, and rollback.

## 2. Persisted state: before and after

Removed from v4: `mappingRegistered`, `blockers`.
Added in v5: `brief`.
Changed in v5: the three version fields.

```json
{
  "contractVersion": 5,
  "formatVersion": 4,
  "workflowVersion": "5.0",
  "migrationId": "legacy-catalog",
  "legacyModule": "legacy-catalog",
  "targetModule": "catalog",
  "legacyCommit": "<sha>",
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
  "status": "ACTIVE",
  "currentStep": "IMPLEMENT_SLICES",
  "activeSlice": "catalog-001",
  "completedSteps": ["RESOLVE", "DISCOVER_LEGACY", "ASSESS_TARGET", "BUILD_BASELINE", "PLAN"],
  "pendingSteps": ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"],
  "completedSlices": [],
  "pendingSlices": ["catalog-001"],
  "invalidatedArtifacts": [],
  "evidenceFreshness": "CURRENT",
  "nextAction": "Implement slice catalog-001.",
  "nextCommand": "/start-migration legacy-catalog",
  "artifacts": {},
  "artifactHashes": {},
  "revision": 7,
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

## 3. Slice and evidence records: before and after

v4 `slices/index.json` entry:

```json
{
  "id": "catalog-001",
  "title": "Restore navigation",
  "requirementIds": ["CATALOG-REQ-001", "PAR-001", "ROUTE-001"],
  "acceptanceScenarios": ["Open list, select, return."],
  "targetPaths": ["src/features/catalog"]
}
```

v5 equivalent:

```json
{
  "id": "catalog-001",
  "title": "Restore navigation",
  "requirementIds": ["CATALOG-REQ-001"],
  "scenarioIds": [],
  "traceIds": ["PAR-001", "ROUTE-001"],
  "acceptanceScenarios": ["Open list, select, return."],
  "targetPaths": ["src/features/catalog"]
}
```

Every other key keeps its value unchanged. Key insertion order is preserved for
untouched keys; `scenarioIds` and `traceIds` are written immediately after
`requirementIds`.

## 4. Machine-owned fields inside mixed artifacts

Only these metadata lines of a step document may be rewritten by the upgrade,
matched as whole `- Label: \`value\`` lines by a structural line parser:

- `Contract version`
- `Format version`
- `Workflow version`

`Status`, `Purpose`, `Dependencies`, and every section body are authored and are
never touched. No regular expression is applied to authored prose.

## 5. Incomplete but resumable

A v5 migration distinguishes invalid structure from resumable incompleteness:

1. the target snapshot must be structurally valid before it is committed;
2. a reopened or `PENDING` step may hold a v4-authored artifact that lacks newly
   required v5 semantic content, such as `ponytailEvidence`;
3. strict semantic validation runs when that step is completed, not when the
   snapshot is written;
4. a migration may not remain `COMPLETE` while any v5 requirement is missing —
   the owning step is reopened and the status returns to `ACTIVE`;
5. the missing content is supplied through the normal checkpoint workflow.
   Editing `state.json` by hand is never a remediation path.

## 6. Reopening rules for this upgrade

The upgrade reopens the earliest step whose v5 requirements are unmet:

| Condition | Earliest reopened step |
| --- | --- |
| Ponytail enabled and typed gate evidence missing | `FINALIZE` |
| Nothing unmet | none; every completed step stays complete |

Trace splitting never reopens a step. It relocates identifiers between
contract-declared fields without changing their meaning, so `PLAN`,
`IMPLEMENT_SLICES`, and `VERIFY_SLICES` completion is preserved and the stored
hashes of the rewritten files are recomputed from the transformed bytes.
Authored keys inside those files are unchanged.

When a step is reopened, it and every downstream step return to `pendingSteps`,
their hashes are dropped from `artifactHashes`, and their authored files stay
exactly where they are.

## 7. Snapshot retention

Approved 2026-08-03. Every transaction owns one directory:

```text
.agents/knowledge/migrations/upgrades/<module>/<confirmation-id>/
├── source-manifest.json
├── source-snapshot/
├── target-manifest.json
├── transaction.json
├── staging/          (until DONE)
└── rollback-live/    (until DONE)
```

- `source-snapshot/` and both manifests are retained **indefinitely**, for a
  successful upgrade and for a successful rollback alike. Nothing deletes them.
- There is **no automatic cleanup**. Reclaiming space is a deliberate operator
  action outside this workflow, and never part of a transaction.
- `staging/`, `rollback-live/`, and the per-module `upgrade.lock` are temporary.
  They are removed only once the transaction reaches `DONE` or `ROLLED_BACK`.
- An interrupted transaction is preserved exactly as it stopped — journal,
  staging tree, rollback tree, and snapshot — until `--recover` resolves it.
  No failure path deletes recovery evidence.
- A journal written before its manifests — what a kill between `mkdir` and the
  manifest writes leaves — is recovered as a rollback, never as a raw `ENOENT`:
  `--recover` restores `source-snapshot/` when the live tree is gone, and
  leaves the still-untouched live tree in place when it is not. Rolling back to
  the retained snapshot is the deterministic answer when there is no manifest
  left to compare against.
- The lock is released when the process stops holding it, including after a
  failure, so `--recover` can run. Releasing the lock never removes a journal,
  a staging tree, or a snapshot.

## 8. Refusals

The upgrade produces no confirmation ID and changes nothing when:

- the source is not contract 4 with format 3;
- the persisted state is `BLOCKED` or carries recorded blockers;
- any slice or evidence identifier cannot be assigned to exactly one owner;
- a recorded artifact, brief, or matrix referenced by the state is missing;
- the recorded artifact hashes do not match the bytes on disk;
- the OpenSpec authority, the legacy Git revision, or this contract digest
  differs from the values the preview was computed from;
- a contract-2 or contract-3 checklist exists for the module.
