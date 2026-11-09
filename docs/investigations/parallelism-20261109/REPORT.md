# Parallelism investigation: `start-migration` and `migrate-artifact`

| Item | Value |
| --- | --- |
| BASE (`toolkit/main`, fetched 2026-11-09T21:53Z, checked with `git ls-remote`) | `82ee6be22b97551a1db97342e9942be1eab5c316` |
| Branch | `investigate/parallelism-20261109` (worktree `/home/utmwac/amt-parallelism`) |
| Scope | Investigation only. No engine, skill, adapter, receipt, verifier or state change. No provider invocation, no scored run, no install. |
| Executor | Claude Code, Ponytail `ultra` |

All `file:line` citations refer to BASE unless a ref is named. Labels used here:
**MEASURED** (computed from a cited evidence file), **PROJECTED** (assumptions are
stated), and **UNVERIFIED** (not proven from repository evidence).

---

## 1. Current capabilities

### 1.1 Execution flow (both skills)

| Stage | `start-migration` (module engine) | `migrate-artifact` (artifact engine) |
| --- | --- | --- |
| Entry | `runtime.mjs ensure` preflight (`skills/start-migration/SKILL.md:13-20`), then status first (`:161-171`), then `migration_run` / `artifact-migration-run --json` (`:183-191`) | Same preflight (`skills/migrate-artifact/SKILL.md:12-17`), then `--status` (`:83-89`), then the bare command, with one transition per invocation (`:90-92`) |
| Unit of work | One checkpoint or one slice per iteration (`start-migration/SKILL.md:9-11`, `:301-305`) | One transition per invocation (`migrate-artifact/SKILL.md:91-92`) |
| Lifecycle | `RESOLVE → DISCOVER_LEGACY → DISCOVERY_COMPLETENESS → ASSESS_TARGET → BUILD_BASELINE → PLAN → IMPLEMENT_SLICES ⇄ VERIFY_SLICES → FINALIZE` (`packages/migration-engine/src/formats/module.mjs:518-528`) | `DISCOVER_LEGACY … PLAN → IMPLEMENT_SLICES ⇄ VERIFY_SLICES → FINALIZE`, with one authored artifact set per checkpoint (`lifecycle/artifact-checkpoints.mjs:995-1010`) |
| State | `.agents/knowledge/migrations/modules/<module>/state.json` (`start-migration/SKILL.md:281-282`) | `.agents/knowledge/migrations/artifacts/<id>/state.json` (`migrate-artifact/SKILL.md:133-136`) |
| Registry | One shared `registry.json` plus a `package.json` binding (`lifecycle/registry.mjs:183-224`) | None: the artifact engine never reads the module registry (`migrate-artifact/SKILL.md:135-136`) |
| Journals | Module transition, initialization, registry, artifact transaction, contract upgrade. Each recovers under its owner's lock (`lifecycle/journal.mjs:6-13`, `:19-26`) | Artifact transaction under the artifact lock (`lifecycle/journal.mjs:11`) |
| Locks | Directory lock `<target>/.agents/knowledge/migrations/locks/<name>.lock` (`lifecycle/lock.mjs:50-53`), keyed by canonical module (`lifecycle/advance.mjs:212`) | Lock name `artifact-<id>` (`lifecycle/artifact-run.mjs:102`, `:209`) |
| History | Hash-chained NDJSON, appended with `O_APPEND` (`store/record.mjs:135-143`) | Same shared store |
| Root resolution | Records, locks and journals resolve from the working directory, and the engine resolves from its install path (`start-migration/SKILL.md:138-143`). MCP calls carry `cwd`, "including in isolated worktrees" (`:313-316`) | `cwd` passed on every MCP call (`migrate-artifact/SKILL.md:92-95`) |
| MCP | One stdio server per host session (`providers/codex/config.toml:3-5`, `providers/copilot/mcp.json:2-10`). It answers requests strictly in arrival order (`transport/mcp.mjs:764-767`, `:807-821`) | Same server: `artifact_status`, `artifact_run` (`transport/mcp.mjs:450-461`) |
| Provider adapters | Claude, Codex, Copilot and OpenCode run "one protocol, identical" (`start-migration/SKILL.md:150-152`). Providers never decide progression (`:233-236`) | Same |

### 1.2 Concurrency that exists today (verified)

| # | Capability | Evidence |
| --- | --- | --- |
| C1 | Mutations of **different modules** in one target root take different locks, so they can run at the same time. | Lock key is `<name>.lock` (`lifecycle/lock.mjs:52-53`). Advance locks on `resolved.canonical` (`lifecycle/advance.mjs:212`). Bootstrap and capture do the same (`lifecycle/bootstrap.mjs:377`, `lifecycle/capture.mjs:336`) |
| C2 | Mutations of **different artifacts** can run at the same time. | `artifact-${id}` lock (`lifecycle/artifact-run.mjs:102`, `:137`, `:209`, `:353`) |
| C3 | **Registry** writes from concurrent modules merge under the `registry` lock. | `lifecycle/registry.mjs:183-189`. Test `migration-contract.test.mjs:2167` ("P1-8: concurrent registrations of different modules both persist") and `:2205` |
| C4 | **Same-module** concurrent mutation is serialized, then compare-and-swap rejects the stale writer. | `lifecycle/advance.mjs:267-280`. Tests `migration-contract.test.mjs:1522` (P0-2 bootstrap) and `:1581` (P1-2 advance) |
| C5 | Validating two records in one process is safe for decision attribution. | `AsyncLocalStorage` (`decisions/authority.mjs:306-316`) |
| C6 | Concurrent history appends do not lose lines. | `store/record.mjs:135-143`. Test `durable-storage.test.mjs:480` |
| C7 | Some read-only fan-out already happens inside one call (`Promise.all` over git and file reads). | e.g. `census/artifact.mjs:348`, `lifecycle/gates.mjs:276`, `slices/claims.mjs:65` |
| C8 | Long agent operations may be started in the background and polled. | `start-migration/SKILL.md:956-964` |

### 1.3 What does *not* run concurrently today (verified)

| # | Limitation | Evidence |
| --- | --- | --- |
| N1 | **One active slice per record.** Advance refuses any slice other than `state.activeSlice`. | Module: `lifecycle/advance.mjs:100-107`, `:291-297`. Artifact: `lifecycle/artifact-checkpoints.mjs:1273-1274`. Test `migration-contract.test.mjs:1623-1660` |
| N2 | Slices run in **declaration order**, which is the topological order of the plan. | `slices/plan.mjs:186-196`, `:222-225`. Artifact: `lifecycle/artifact-checkpoints.mjs:582-585`, `:1231-1257` |
| N3 | Resume rejects any state whose `activeSlice`, `pendingSlices` or `completedSlices` disagree with the slice and evidence files. | `slices/state.mjs:15-22`, `:63-131` |
| N4 | The MCP server answers one request at a time per connection. | `transport/mcp.mjs:764-767`, `:818-821` |
| N5 | The skills contain no subagent, parallel-session or fan-out protocol. | Searching `skills/`, `docs/*.md`, `README.md` and `OWNERSHIP.md` for `subagent\|multi-agent\|parallel (session\|agent)\|concurrent (session\|agent\|migration)` returns nothing. The template text says "one active slice per session" (`lifecycle/templates.mjs:144`, `:156`), which the skill defines as one engine iteration (`start-migration/SKILL.md:268-270`) |
| N6 | The artifact census uses a module-level metrics counter that assumes one artifact command per process. | `census/artifact.mjs:94-97` |

---

## 2. Verified limitations and bottlenecks

### 2.1 Running multiple migrations at once

**Concurrent module IDs in the same target tree are not safe in practice, even though the locks allow them.**
The locks are per module (C1). Gate evidence, however, is bound to a digest of
the **whole** uncommitted target tree:

- `gateBindingContext` binds `targetDirtyDigest = dirtyManifest(targetRoot, TARGET_DIRTY_SCOPE)` (`lifecycle/gates.mjs:79-101`). That scope excludes only the migrations directory and `runtime-apps.json` (`slices/claims.mjs:29-36`).
- The engine's own comment states the intent: "any uncommitted change to either tree -- even one no evidence entry ever names -- invalidates evidence authored before it happened" (`lifecycle/gates.mjs:118-123`). FINALIZE checks it (`lifecycle/gates.mjs:206`).
- **Consequence:** while module B's slice is editing any target file, every FINALIZE gate entry that module A has authored goes stale. A cannot pass FINALIZE until B stops writing, so A has to re-author. That costs tokens, but correctness holds because the engine refuses.
- Edits that B makes *inside* A's planned target subtree become `UNCLAIMED_TARGET_DRIFT`, and A's FINALIZE refuses (`slices/drift.mjs:270-299`, `:399-427`). Edits outside A's scope are classified `UNRELATED_USER_CHANGE` and pass (`slices/drift.mjs:273-280`).
- The artifact engine has the same problem. Recording an operator decision requires the whole target `dirtyDigest` to be unchanged (`lifecycle/artifact-status.mjs:385-394`), and that digest is whole-tree minus provider paths (`census/artifact.mjs:238-246`, `:346-356`).

**Concurrent slices of one module are refused by design** (N1–N3). Two agents
driving one record produce one success, and the other gets "state moved … preview
again" (`lifecycle/advance.mjs:271-280`). The IMPLEMENT gate lists every dirty path
in the active slice's planned scope that no slice claims (`lifecycle/validation.mjs:1289-1314`).
A concurrent slice's edits would therefore be pushed into the active slice's
claim. Verification freshness also re-judges any claimed file that changes after
VERIFY (`slices/freshness.mjs:47-83`). The UI capture fingerprint includes
`completedSlices` (`lifecycle/capture.mjs:178`).

**Shared registry:** this is safe (C3). It is a merge point, not a race.

**Locks, including abandoned and cross-namespace locks:**

- A dead owner in the same host and PID namespace is reclaimed automatically (`lifecycle/lock.mjs:13-16`, `:142-147`, `:154-180`).
- An owner from a different PID realm, for example Windows and WSL sharing one checkout or a restarted WSL distro, is **never** reclaimed automatically. A legacy protocol-1 file lock is never reclaimed either (`lifecycle/lock.mjs:77-90`, `:160-162`, `:182-189`). More parallel sessions means more chances to be killed holding a lock.
- Waiters give up after **30 s** by default (`lifecycle/lock.mjs:196-200`, `:228-230`). A slow holder, such as a capture or prefill running under the module lock (`lifecycle/capture.mjs:336`, `lifecycle/prefill.mjs:427`), therefore turns contention into a refusal.
- The `_app-runtime` lock is **one per target root and shared by every module** (`lifecycle/app-runtime.mjs:52`, `:493`, `:525-528`). This is a cross-namespace serialization point for UI migrations.
- The runtime preflight's skill-projection replacement takes no lock: "two concurrent preflights write the same verified bytes" (`skills/start-migration/scripts/runtime.mjs:543-544`). The install lock is per consumer (`:349`).

**Separate git worktrees or clones** give each run its own registry, locks,
journals and records, because everything resolves from `cwd`
(`start-migration/SKILL.md:138-143`, `:313-316`; `lifecycle/lock.mjs:52-53`). Nothing
in the engine couples two worktrees. The remaining couplings are outside the
engine:

- Applications that `migration_app_runtime` starts bind host ports. Each worktree has its own `_app-runtime` lock, so nothing prevents two worktrees from colliding on a port (`lifecycle/app-runtime.mjs:1-19`, `:52`). **UNVERIFIED:** whether the configured ports can differ per worktree.
- The release store is shared across consumers (`runtime.mjs:349`).
- The Playwright MCP browser profile may be shared. **UNVERIFIED** for this toolkit.

### 2.2 Bottlenecks from existing evidence logs (no new runs)

Durations are computed from committed timestamps: the history `at` field and the
watcher `currentStep` lines. The watcher's poll resolution is about 1 s, which is
**UNVERIFIED** (inferred from the timestamp spacing in the logs).

| Run (evidence path) | Total | Pre-bootstrap (preflight, spec draft, bootstrap) | Discovery → PLAN | Slice phase (2 slices) | FINALIZE | After COMPLETE |
| --- | --- | --- | --- | --- | --- | --- |
| m14 baseline: `docs/investigations/m14-start-migration-acceptance/baseline-run/record/history.ndjson` (seq 1–11) | 808.6 s, CREATED→COMPLETE | not in ledger | 412.4 s, including a kill and resume in BUILD_BASELINE (`baseline-run/interrupt.log`) | **285.7 s (35.3 %)**: slice 1 = 74 + 74 s, slice 2 = 85 + 53 s | 110.3 s (13.6 %) | — |
| m14.1 `run-9842054/watch.log` | 840.5 s, sum of sessions | 90.1 s | 401.3 s, including a kill | **188.2 s (22.4 %)**: slice 1 = 46 + 34 s, slice 2 = 78 + 30 s | 80.1 s (9.5 %) | **111.8 s (13.3 %)** |
| m14.1 `run-49a4e1e/watch.log` | 753.0 s, sum of sessions | 91.1 s | kills and an `exit code=1` restart inside BUILD_BASELINE | **213.2 s (28.3 %)**: slice 1 = 59 + 38 s, slice 2 = 85 + 31 s | 108.1 s (14.4 %) | 18.4 s |
| m13.1 artifact: `docs/investigations/m13.1-real-agent-acceptance/record/history/history.ndjson` | 191.1 s, BOOTSTRAPPED→COMPLETED | — | 113 s (seq 2–6) | 57 s, 1 slice | 21 s | — |

All figures in this table are **MEASURED** from the cited files.

Findings:

1. **B1. Agent authoring time dominates, but the split is not measured.** Each checkpoint takes 8–262 s in these logs. No committed evidence records how long engine calls take versus model reasoning. The engine/model split is **UNVERIFIED**, and nothing in this report should be optimized until it is measured (Roadmap I1).
2. **B2. The slice phase is the only part where slice-level parallelism could help.** It is 22–35 % of wall time in the module runs (MEASURED, three runs of one two-slice fixture).
3. **B3. Interruption and recovery are visible costs.** One session ended `exit code=1` at BUILD_BASELINE and the restart came 162 s later (`run-49a4e1e/watch.log`). The baseline's kill and resume added more than 100 s. These costs come from crashes, not from sequencing. MEASURED; the root cause of `exit code=1` is UNVERIFIED.
4. **B4. Post-COMPLETE agent time reached 111.8 s in one run and 18.4 s in another.** This is pure provider time after the engine had finished. MEASURED; the cause is UNVERIFIED because that run has no transcript outline.
5. **B5. Unnecessary sequential dependencies:**
   - Two whole migrations of independent modules are sequential today only by operator habit. The engine supports them in separate worktrees (§2.1).
   - Inside one record, every sequential dependency is load-bearing (N1–N3, §2.1). None was found to be unnecessary under the current gate design.

---

## 3. Subagent feasibility

| Question | Finding |
| --- | --- |
| Can subagents advance a record in parallel? | **No.** Single `activeSlice` and compare-and-swap (N1, C4). Parallel callers get refusals. The record is not corrupted, but the tokens are wasted. |
| Can subagents share the MCP server for speed? | **No speedup.** Requests on a connection are serialized (`transport/mcp.mjs:764-767`). Whether a subagent shares the parent's connection is UNVERIFIED for every provider. |
| Can subagents do read-only work, such as reading legacy sources before the bootstrap spec draft? | Technically yes, because legacy is read-only evidence (`start-migration/SKILL.md:277`). Benefit is small: the pre-bootstrap phase is about 90 s in total (MEASURED, §2.2), and hosts already batch reads. **Rejected:** low benefit. |
| Provider-neutral? | The skills require one identical protocol (`start-migration/SKILL.md:150-152`). Subagent APIs for Codex `exec`, Copilot CLI and OpenCode are **UNVERIFIED** from repository evidence. A subagent-dependent protocol would fork behavior per provider. |
| Claude Code in the harness | The acceptance runner grants `Bash Read Edit Write Glob Grep mcp__start-migration mcp__playwright` and no subagent tool (`scripts/agent-e2e-acceptance.mjs:148-151`). Enabling subagents widens the certified grant. |
| Security invariants: 9 MCP grants and `approval_policy=never` | **These are not on BASE.** They live on unmerged harness refs, for example `toolkit/harness/scorer-fixes-20261104` (`453a3b1c8947b7c6a4a37bf67de40f04b329f278`), `docs/agent-e2e-acceptance.md:156-185`, which is not an ancestor of BASE. At BASE, the shipped Codex and Copilot configs carry no tool filter (`providers/codex/config.toml:3-5`, `providers/copilot/mcp.json:2-10`). The Codex runner at BASE passes `--sandbox workspace-write` and project trust, with no `approval_policy` (`scripts/agent-e2e-acceptance.mjs:155-158`). The BASE server advertises **11** tools, including `migration_app_runtime` (`transport/mcp.mjs:531`) and the relay (`:561`). The nine-grant list on the harness ref omits `migration_app_runtime`. **This is a drift to resolve independently of parallelism.** |
| Sandbox and read-only mounts | OS isolation is applied per agent process: user, mount and PID namespaces with read-only binds and capabilities dropped (`scripts/agent-e2e-acceptance.mjs:92-108`). One isolated agent per worktree keeps that model unchanged. Subagents spawned inside the namespace inherit it (Linux namespace semantics; harness behaviour with subagents is UNVERIFIED). |
| Operator decisions | Only the parent may relay, and only after an explicit APPROVE or REJECT turn (`start-migration/SKILL.md:352-371`). Subagents must never hold that turn. Each parallel worktree has its own decision stream, so the operator's attention becomes the bottleneck. **PROJECTED:** risk grows linearly with the number of parallel sessions. |

**Verdict:** parallel subagents *inside* one migration give no meaningful speedup
and add security surface. **Rejected.** Parallelism belongs one level up: one
isolated agent session per independent migration, each in its own worktree.

---

## 4. Recommended architecture

### 4.1 Stage classification

Every stage is listed for both engines, with the reason.

| Stage | Class | Reason |
| --- | --- | --- |
| Runtime preflight (`runtime.mjs ensure`) | PARALLEL_WITH_GUARD | Concurrent preflights write identical verified bytes with no lock (`runtime.mjs:543-544`). Store fetch and first install are UNVERIFIED under a race. **Guard:** run one preflight before fanning out. |
| `migration_status` / `--status` / `artifact_status` | SAFE_PARALLEL | Read-only: no lock, no write (`start-migration/SKILL.md:711-715`; `migrate-artifact/SKILL.md:83-89`). |
| Pre-bootstrap legacy reading (spec draft) | SAFE_PARALLEL, but **not worth it** | Read-only legacy evidence (`start-migration/SKILL.md:277`). About 90 s in total (MEASURED). |
| RESOLVE / bootstrap (module) | PARALLEL_WITH_GUARD | Different modules: separate locks plus registry merge (C1, C3). **Guard:** separate worktree, because the bootstrap preview binds the whole target dirty digest (`lifecycle/preview.mjs:248-267`). |
| Artifact bootstrap | PARALLEL_WITH_GUARD | Confirmation binds whole-tree `dirtyDigest` (`lifecycle/artifact-status.mjs:84-107`, `census/artifact.mjs:346-356`). **Guard:** separate worktree. |
| DISCOVER_LEGACY, DISCOVERY_COMPLETENESS, ASSESS_TARGET, PLAN (within one record) | MUST_BE_SEQUENTIAL | Each consumes the previous checkpoint's pinned artifacts. `completedSteps` is an in-order prefix (`formats/module.mjs:535-541`). |
| Same checkpoints, different records | PARALLEL_WITH_GUARD | Per-record locks (C1, C2). **Guard:** separate worktree, otherwise whole-tree dirty digests couple the records (§2.1). |
| BUILD_BASELINE with `legacy-runtime` capture / `migration_app_runtime` | PARALLEL_WITH_GUARD across records, MUST_BE_SEQUENTIAL within one | `_app-runtime` lock is per target root (`lifecycle/app-runtime.mjs:52`, `:525-528`). Ports and browser profile are shared host resources (UNVERIFIED). **Guard:** distinct ports per worktree, or serialize UI captures. |
| IMPLEMENT_SLICES / VERIFY_SLICES, same record | MUST_BE_SEQUENTIAL | One `activeSlice` (N1), declaration order (N2), unclaimed-file gate (`lifecycle/validation.mjs:1289-1314`), freshness (`slices/freshness.mjs:47-83`). |
| IMPLEMENT/VERIFY, different records in the same target tree | MUST_BE_SEQUENTIAL in practice | Locks allow it. Whole-tree `targetDirtyDigest` stales the other record's evidence (`lifecycle/gates.mjs:118-123`). |
| IMPLEMENT/VERIFY, different records in different worktrees | SAFE_PARALLEL | No shared engine state across worktrees (§2.1). |
| `migration_prefill` / `migration_capture` | MUST_BE_SEQUENTIAL per record | Under the module lock (`lifecycle/prefill.mjs:427`, `lifecycle/capture.mjs:336`). |
| FINALIZE gates, same record | MUST_BE_SEQUENTIAL | Bound to the whole dirty digest and revisions (`lifecycle/gates.mjs:79-123`). |
| FINALIZE target validation commands run by the agent (test, lint, type-check, build) | PARALLEL_WITH_GUARD | Background work is allowed (`start-migration/SKILL.md:956-964`). The dirty digest ignores git-ignored files (`git status --porcelain=v1 -uall`, `shared/git.mjs:95-98`). **Guard:** commands must write only ignored paths, otherwise evidence goes stale. Benefit is UNVERIFIED because no per-command timings exist. |
| Ponytail review/audit evidence (FINALIZE) | MUST_BE_SEQUENTIAL | It must follow verification and precede the pre-commit review (`migrate-artifact/SKILL.md:70-79`). |
| Operator decisions / relay | MUST_BE_SEQUENTIAL | Explicit human turn and ledger append under lock (`start-migration/SKILL.md:352-371`; `lifecycle/recorder.mjs:390`). |
| Format upgrade | MUST_BE_SEQUENTIAL | Freezes the lifecycle, one increment per invocation (`start-migration/SKILL.md:652-654`, `:698-703`). |
| Registry update | PARALLEL_WITH_GUARD | `registry` lock plus recompute (`lifecycle/registry.mjs:183-189`). **Guard:** none needed in one tree. Across worktrees it is a git merge of `registry.json` and `package.json`. |
| Reopen / rework / amend / toolkit identity / adoption | MUST_BE_SEQUENTIAL per record | Module lock (`lifecycle/reopen.mjs:61`, `lifecycle/toolkit-identity.mjs:168`, `lifecycle/adoption.mjs:497`). |
| Integration of finished worktrees into the shared target | MUST_BE_SEQUENTIAL | Merging moves `targetRevision`, and gate evidence is revision-bound (`lifecycle/gates.mjs:110-111`). Post-merge behaviour of a COMPLETE record's status is **UNVERIFIED**. |

### 4.2 The one change worth making: worktree fan-out across independent migrations

```
operator
  ├─ preflight once (shared runtime)              [sequential]
  ├─ git worktree add wt-A ; git worktree add wt-B [native git, no new code]
  ├─ agent A (own isolation, own MCP server, cwd=wt-A) ─┐   [parallel]
  ├─ agent B (own isolation, own MCP server, cwd=wt-B) ─┘
  └─ merge wt-A, then wt-B, re-run status on each record [sequential]
```

- **No engine change.** The engine already resolves every record, lock and journal from `cwd` (`start-migration/SKILL.md:138-143`, `:313-316`).
- **Guards:**
  1. One module or artifact per worktree, and never the same ID in two worktrees. The engine cannot see across worktrees.
  2. Target subtrees must not overlap (compare the PLAN `targetPaths`, `slices/plan.mjs:209`).
  3. UI migrations get distinct app ports, or their capture stages are serialized.
  4. Run preflight once before fan-out.
  5. Merge sequentially and run `--status` after each merge.
- **Rejected alternatives:**
  - *Parallel slices inside one record.* This needs `activeSlice` to become a set and dirty digests to become per-slice, plus new freshness and drift rules. That is a non-promoting format bump (`start-migration/SKILL.md:586-599`). The MEASURED ceiling is 9.5–17.1 % on the only evidence (§5). High complexity and determinism risk for low benefit.
  - *Subagents per checkpoint.* No engine-level speedup (§3), plus provider divergence and a wider grant.
  - *Concurrent modules in one target tree.* Whole-tree digests force re-authoring (§2.1).
  - *Scoping `targetDirtyDigest` to the module's subtree.* This would weaken "any uncommitted change invalidates evidence" (`lifecycle/gates.mjs:118-123`), which is a correctness invariant. Rejected by the constraints.

---

## 5. Expected gains

| Scenario | Figure | Label | Basis or assumptions |
| --- | --- | --- | --- |
| Single module, current | 753–841 s per two-slice fixture migration | MEASURED | §2.2, m14.1 watch logs |
| Slice phase share | 22.4 %, 28.3 %, 35.3 % | MEASURED | §2.2 |
| Ideal parallel slices (2 independent slices, zero overhead) | −80 s (9.5 %), −97 s (12.9 %), −138 s (17.1 %) | PROJECTED | Wall time drops by (sum − max) of per-slice time. Assumes the two fixture slices are independent (UNVERIFIED; the plan file is not in committed evidence) and no coordination cost. Requires the rejected engine redesign. |
| Worktree fan-out, M independent modules of similar size | Wall time ≈ T_max + merge time. Reduction vs sequential ≈ (M−1)/M: **M = 2 → ~50 %, M = 3 → ~67 %** | PROJECTED | Assumes independent modules, non-overlapping target subtrees, provider quota and rate limits allowing M sessions (UNVERIFIED), merge plus post-merge status negligible (UNVERIFIED), and operator decisions not on the critical path. |
| Removing post-COMPLETE agent time | up to −111.8 s (13.3 %) in one run, −18.4 s in another | MEASURED variance; cause UNVERIFIED | `run-9842054/watch.log` vs `run-49a4e1e/watch.log` |
| FINALIZE command concurrency | unknown | UNVERIFIED | No per-command timings in evidence. FINALIZE is 80–110 s in total (MEASURED), so the ceiling is below that. |

---

## 6. Risks and mitigations

| Risk | Where | Mitigation |
| --- | --- | --- |
| Same module driven from two worktrees produces two divergent records | Locks are per worktree (`lifecycle/lock.mjs:50-53`) | Fan-out guard refuses duplicate IDs (Roadmap I3). |
| Overlapping target subtrees produce merge conflicts or post-merge `UNCLAIMED_TARGET_DRIFT` | `slices/drift.mjs:270-299` | Guard compares PLAN `targetPaths`; overlapping migrations run sequentially. |
| Revision-bound evidence after merge | `lifecycle/gates.mjs:110-111` | Merge only COMPLETE records, then run `--status` per record. Post-merge behaviour is UNVERIFIED and must be proven in I2. |
| `registry.json` / `package.json` binding merge conflict | `lifecycle/registry.mjs:216-224` | Sequential merge. Registry entries are per module, so the conflict is textual. UNVERIFIED; checked in I2. |
| Stale locks from killed parallel sessions | `lifecycle/lock.mjs:13-31` | Same-realm locks reclaim automatically. Never mix Windows and WSL on one worktree (`lifecycle/lock.mjs:77-81`). |
| Port, browser and session-broker contention for UI work | `lifecycle/app-runtime.mjs:52`; `docs/session-broker.md:16` | Distinct ports per worktree, or serialize capture stages. |
| Provider quota or rate limits across M sessions | UNVERIFIED (no repository evidence) | Cap M at 2 until I2 measures it. |
| Operator attention: M concurrent `OPERATOR_DECISION` stops | `start-migration/SKILL.md:352-371` | Accept it. Decisions stay strictly per session, and nothing is batched or auto-approved. |
| Determinism and resume | Per-record journals (`lifecycle/journal.mjs:6-26`), hash-chained history (`store/record.mjs:135-143`), resume consistency check (`slices/state.mjs:15-22`) | Unchanged by fan-out, because every record lives in exactly one worktree. |
| Typed outcome when a compare-and-swap refusal reaches MCP | The thrown "state moved" error (`lifecycle/advance.mjs:271-275`). Mapping to `BLOCKED` or `FAILED` is UNVERIFIED | Not reachable under the I3 guard. Verify only if same-record concurrency is ever proposed. |
| Grant drift: 9 grants vs 11 advertised tools at BASE | `transport/mcp.mjs:450-561` vs `453a3b1:docs/agent-e2e-acceptance.md:164-168` | Separate task. Fan-out does not change the grant set. |

---

## 7. Roadmap (prioritized; engine and infrastructure kept separate)

| ID | Track | Item | Timebox | Validation | Numeric target |
| --- | --- | --- | --- | --- | --- |
| **I1** | Infra | Timing extractor over **existing** evidence: history `at`, watcher logs and stream-json transcripts. It writes a per-checkpoint and per-tool-call table, splitting engine-call time from model time. No new runs. | 4 h | Reproduce §2.2 exactly from the same files | ±1 s of every §2.2 figure. Attribute ≥ 90 % of wall time to engine, tool or model buckets on ≥ 3 existing runs. |
| **I2** | Infra (needs owner authorization: provider invocations) | Two-worktree fan-out dry run on a disposable two-module fixture with independent modules, then sequential merge and `--status` on both records. Functional only, unscored. | 1 day | Same verifier as the sequential baseline. Check history chain, journal absence, lock absence and `--status` after each merge. | **≥ 40 % wall-time reduction** vs the sum of the two sequential runs, at **equal functional PASS (2/2)**, **0** state or journal divergence, **0** leftover locks or journals. |
| **I3** | Infra | Fan-out guard and runbook: refuse a duplicate module or artifact ID, overlapping PLAN `targetPaths`, or a shared app port across worktrees. Run preflight once. Uses `git worktree` only. | 4 h | Three negative cases plus one positive case | **100 %** refusal on the 3 negative cases, **0** false refusals on the positive case. |
| **I4** | Infra | Resolve the grant drift: decide whether `migration_app_runtime` joins the certified grant set, independently of parallelism. | 2 h | Grant probe as in `453a3b1:docs/agent-e2e-acceptance.md:169-173` | Effective grants equal the advertised non-relay set, and the relay is excluded (**0** relay grants). |
| **E1** | Engine (only if I1 shows a target) | Post-COMPLETE and FINALIZE cost review. Act only if I1 attributes ≥ 20 % of FINALIZE to engine calls. | 2 h investigation | I1 table | Decide go or no-go. If go: ≥ 20 % FINALIZE reduction with an identical test suite (0 new failures). |
| **E2** | Engine (deferred, gated) | Parallel slices within a record. **Do not start** unless I1 shows the slice phase above 50 % of wall time on a real migration with ≥ 4 independent slices. | — | — | Gate condition as stated. Otherwise remains rejected. |

---

## 8. Acceptance criteria for adopting the recommendation

1. I1 reproduces every MEASURED figure here within ±1 s.
2. I2 shows ≥ 40 % wall-time reduction for two independent modules, with 2/2 functional PASS, 0 history-chain breaks, 0 leftover journals and 0 leftover locks.
3. I3 refuses 3/3 unsafe fan-outs and accepts 1/1 safe fan-out.
4. No change to engine invariants: the single active slice, the whole-tree dirty-digest binding, the module lock, compare-and-swap and the relay exclusion all stay as at BASE.
5. Each agent keeps its own OS isolation and grant set. No subagent tool is added to the certified grants.

---

## 9. Recommendation

Do not parallelize inside a migration. The engine is built around one active slice
and whole-tree evidence binding, and on the only evidence the slice phase caps
the gain at 9.5–17.1 % (PROJECTED from MEASURED). Parallelize *across* independent
migrations instead: one isolated agent per git worktree, preflight once, and merge
sequentially. That needs no engine change, keeps every correctness and security
invariant, and projects to about 50 % wall-time reduction for two modules. Measure
first (I1), then prove it once (I2) behind a refusal guard (I3).

---

## Appendix A. Ponytail skipped / unchecked / risks

- **Skipped:**
  - Engine redesign for parallel slices (E2, gated).
  - Subagent protocol: rejected for low benefit and wider grants.
  - Per-module dirty-digest scoping: weakens an invariant.
  - FINALIZE command concurrency: not measurable from current evidence.
- **Unchecked (UNVERIFIED):**
  - Engine vs model time split.
  - Watcher poll resolution.
  - m14 fixture slice independence.
  - Subagent support in Codex, Copilot and OpenCode, and whether subagents share the MCP connection.
  - Provider quota under M sessions.
  - Port and Playwright profile sharing across worktrees.
  - Post-merge `--status` of COMPLETE records.
  - Typed outcome of a compare-and-swap refusal over MCP.
  - Cause of `exit code=1` in `run-49a4e1e` and of the 111.8 s post-COMPLETE tail.
- **Risks:**
  - All timings come from **one** small two-slice fixture (`discounts`), so real-module ratios may differ.
  - The 9-grant and `approval_policy=never` invariants are absent from BASE and drift from the BASE tool list (I4).
  - Cross-realm (Windows/WSL) stale locks need manual removal (`lifecycle/lock.mjs:186-188`).
