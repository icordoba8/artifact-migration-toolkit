# Parallelism investigation: `start-migration` and `migrate-artifact`

| Item | Value |
| --- | --- |
| BASE (`toolkit/main`, fetched 2026-11-09T21:53Z, checked with `git ls-remote`) | `82ee6be22b97551a1db97342e9942be1eab5c316` |
| Branch | `investigate/parallelism-20261109` (worktree `/home/utmwac/amt-parallelism`) |
| Revision | 2. Fixes the independent Codex review (verdict ACCEPT_WITH_FIXES) of rev 1 `2851dcc8daeaabb20a5eaef943547cfa56aeb19b`. Fix log in Appendix B. |
| Scope | Investigation only. No engine, skill, adapter, receipt, verifier or state change. No provider invocation, no scored run, no install. |
| Executor | Claude Code. Rev 1 Ponytail `ultra`; rev 2 Ponytail `full`. |

All `file:line` citations refer to BASE unless a ref is named. Harness-scoped
citations use `453a3b1` = `453a3b1c8947b7c6a4a37bf67de40f04b329f278`. Labels used here:
**MEASURED** (computed from a cited evidence file), **PROJECTED** (assumptions are
stated), and **UNVERIFIED** (not proven from repository evidence). Code constants
(for example a timeout) carry a citation instead of a label. Roadmap timeboxes and
numeric targets are goals, not claims.

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
| MCP | The shipped Codex and Copilot configs register one stdio server, `start-migration` (`providers/codex/config.toml:3-5`, `providers/copilot/mcp.json:2-10`). Whether a host starts one server process per session, or shares one, is **UNVERIFIED**. Within one server, requests on a connection are answered in arrival order (`transport/mcp.mjs:764-767`, `:807-821`), and tool calls are serialized process-wide (`:600-605`) | Same server: `artifact_status`, `artifact_run` (`transport/mcp.mjs:449-472`) |
| Provider adapters | Claude, Codex, Copilot and OpenCode run "one protocol, identical" (`start-migration/SKILL.md:150-152`). Providers never decide progression (`:233-236`) | Same |

### 1.2 Concurrency that exists today (verified)

| # | Capability | Evidence |
| --- | --- | --- |
| C1 | Mutations of **different modules** in one target root take different lock names, so the lock layer does not serialize them. Same-tree coupling still applies (§2.1). | Lock key is `<name>.lock` (`lifecycle/lock.mjs:52-53`). Advance locks on `resolved.canonical` (`lifecycle/advance.mjs:212`). Bootstrap and capture publication do the same (`lifecycle/bootstrap.mjs:377`, `lifecycle/capture.mjs:336`). The different-module concurrency test is registry-level: `migration-contract.test.mjs:2167` |
| C2 | Mutations of **different artifacts** take different lock names. Same-tree coupling (§2.1) and the per-process census counter (N6) still apply. | `artifact-${id}` lock (`lifecycle/artifact-run.mjs:102`, `:137`, `:209`, `:353`) |
| C3 | **Registry** writes from concurrent modules merge under the `registry` lock. | `lifecycle/registry.mjs:183-188`. Different-module test `migration-contract.test.mjs:2167`: every registration that reports success is persisted, and at least one succeeds (`:2191-2199`). Same-module conflict: `:2205` |
| C4 | **Same-module** concurrent mutation is serialized, then compare-and-swap rejects the stale writer. | `lifecycle/advance.mjs:267-280`. Tests `migration-contract.test.mjs:1522` (P0-2 bootstrap) and `:1581` (P1-2 advance) |
| C5 | Validating two records in one process is safe for decision attribution. | `AsyncLocalStorage` (`decisions/authority.mjs:306-316`) |
| C6 | Concurrent history appends do not lose lines. | `store/record.mjs:135-143`. Test `durable-storage.test.mjs:480` |
| C7 | Some read-only fan-out already happens inside one call (`Promise.all` over git and file reads). | e.g. `census/artifact.mjs:348`, `lifecycle/gates.mjs:276`, `slices/claims.mjs:65` |
| C8 | Long agent operations may be started in the background and polled. | `start-migration/SKILL.md:956-964` |

### 1.3 What does *not* run concurrently today (verified)

| # | Limitation | Evidence |
| --- | --- | --- |
| N1 | **One active slice per record.** At IMPLEMENT and VERIFY, a slice other than `state.activeSlice` is refused. | Module: the preview adds the blocker (`lifecycle/advance.mjs:100-107`), and `advanceMigration` throws it (`:194-203`). Artifact: `lifecycle/artifact-checkpoints.mjs:1273-1275`, which exempts PLAN. Test `migration-contract.test.mjs:1623-1660` |
| N2 | Slice order. **Module:** after PLAN the active slice is the first pending planned slice, and each VERIFY moves to the next (`lifecycle/advance.mjs:440-441`, `:453-458`). For capability-ownership formats a dependency must be declared before its dependent, so declaration order is topological (`slices/plan.mjs:186-198`, `:222-225`). **Artifact:** at PLAN the agent may select any plan slice whose dependencies are complete, including a later dependency-free slice, and it becomes first (`lifecycle/artifact-checkpoints.mjs:1226-1237`). After each VERIFY the next pending slice follows in plan order (`:1240-1246`), and IMPLEMENT re-checks dependencies (`:579-586`). | as cited |
| N3 | Resume rejects any state whose `activeSlice`, `pendingSlices` or `completedSlices` disagree with the slice and evidence files. | `slices/state.mjs:15-22`, `:63-131` |
| N4 | The MCP server answers one request at a time per connection, and runs one tool call at a time per process. | `transport/mcp.mjs:764-767`, `:818-821`, `:600-605` |
| N5 | The skills contain no subagent, parallel-session or fan-out protocol. | Searching `skills/`, `docs/*.md`, `README.md` and `OWNERSHIP.md` for `subagent\|multi-agent\|parallel (session\|agent)\|concurrent (session\|agent\|migration)` returns nothing. The template text says "one active slice per session" (`lifecycle/templates.mjs:144`, `:156`), which the skill defines as one engine iteration (`start-migration/SKILL.md:268-270`) |
| N6 | The artifact census uses a module-level metrics counter that assumes one artifact command per process. | `census/artifact.mjs:94-97` |

---

## 2. Verified limitations and bottlenecks

### 2.1 Running multiple migrations at once

**Concurrent module IDs in the same target tree: scoped checkpoint work can
interleave, but tree-wide bindings cannot.** The locks are per module (C1). Two kinds
of check read the target tree.

*Tree-wide bindings* (bootstrap, decisions, FINALIZE):

- Bootstrap: the bootstrap preview binds the whole target dirty digest into its confirmation (`lifecycle/preview.mjs:248-267`, `lifecycle/bootstrap.mjs:125-127`).
- FINALIZE: `gateBindingContext` binds `targetDirtyDigest = dirtyManifest(targetRoot, TARGET_DIRTY_SCOPE)` (`lifecycle/gates.mjs:79-101`). That scope excludes only the migrations directory and `runtime-apps.json` (`slices/claims.mjs:33-36`). The engine's own comment states the intent: "any uncommitted change to either tree -- even one no evidence entry ever names -- invalidates evidence authored before it happened" (`lifecycle/gates.mjs:118-121`). `validateGates` compares every `boundTo` field (`lifecycle/gates.mjs:153-169`) and runs only in the FINALIZE branch (`lifecycle/validation.mjs:1209`, `:1234`; `formats/module.mjs:295-296`).
- Decisions: recording an artifact operator decision requires the whole target `dirtyDigest` to be unchanged (`lifecycle/artifact-status.mjs:385-394`). That digest is whole-tree minus provider paths (`census/artifact.mjs:346-356`). Module decisions bind the legacy dirty digest (`decisions/authority.mjs:265`).

*Scoped checkpoint work* (IMPLEMENT, VERIFY):

- The advance confirmation binds the record's revision, state hash, pinned artifact hashes and legacy source. It does not bind the target dirty digest (`lifecycle/advance.mjs:108-121`).
- The IMPLEMENT gate looks only inside the active slice's planned scope (`lifecycle/validation.mjs:1289-1296`). A slice's declared changed files must each appear in the current diff, which is a per-path membership check (`slices/verification.mjs:338-353`).
- VERIFY_SLICES only reports drift. FINALIZE enforces it (`slices/drift.mjs:392-398`; `DRIFT_OWNERSHIP_STEPS`, `:48`).

**Consequences:**

- While module B edits any target file, every FINALIZE gate entry that module A authored before that edit goes stale. **Same-tree FINALIZE therefore requires a stable tree.** The module lock does not provide one: it serializes only commands that take the same lock name (`lifecycle/lock.mjs:52-53`, `:258-264`) and does not freeze other writers. A has to re-author. That costs tokens, but correctness holds because the engine refuses.
- Edits that B makes *inside* A's planned target subtree are classified `UNCLAIMED_TARGET_DRIFT` (`slices/drift.mjs:316-321`), and A's FINALIZE refuses (`:399-427`, called at `lifecycle/validation.mjs:1226`). Edits outside every subtree A owns are classified `UNRELATED_USER_CHANGE` and pass (`slices/drift.mjs:270-281`).
- Isolated worktrees remain the recommended default (§4.2), because they remove both couplings without relying on a stable-tree discipline.

**Concurrent slices of one module are refused by design** (N1–N3). Two agents
driving one record produce one success, and the other gets "state moved … preview
again" (`lifecycle/advance.mjs:271-280`). The IMPLEMENT gate reports every dirty path
in the active slice's planned scope that no slice lists, that no later pending slice
scopes, and that the active slice could list (`lifecycle/validation.mjs:1289-1314`,
`slices/drift.mjs:282-284`). A concurrent slice's edits would therefore be reported
to the active slice, to be listed or reverted. At FINALIZE (`lifecycle/validation.mjs:1236`),
verification freshness re-judges any claimed file that changed after VERIFY
(`slices/freshness.mjs:47-83`). The UI capture fingerprint includes
`completedSlices` (`lifecycle/capture.mjs:178`).

**Shared registry:** this is safe (C3). It is a merge point, not a race.

**Locks, including abandoned and cross-namespace locks:**

- A waiter reclaims a lock only when all of these hold (`lifecycle/lock.mjs:13-20`, `:154-180`):
  - the lock is a directory holding exactly one entry named `<uuid>.json` (`:163`, `:170-172`);
  - that entry is a regular file, reached without a symlink, of at most 1024 bytes, with valid `uuid`, `pid`, `hostname` and `realm` (`:96`, `:107-113`, `:122-140`);
  - its hostname is this host's and its realm is this process's PID realm, which must be knowable (`:142-146`);
  - `kill(pid, 0)` fails with `ESRCH` (`:63-75`, `:147`).
  Anything else fails closed. A recycled PID now owned by a live unrelated process keeps the lock until that process exits (`:25-27`).
- An owner from a different PID realm, for example Windows and WSL sharing one checkout or a restarted WSL distro, is **never** reclaimed automatically (`lifecycle/lock.mjs:27-29`, `:77-90`). A legacy protocol-1 file lock is never reclaimed either (`:160-162`, `:182-189`). More parallel sessions means more chances to be killed holding a lock.
- Waiters give up after **30 s** by default (`lifecycle/lock.mjs:199`, `:228-230`). A slow holder therefore turns contention into a refusal. Examples are prefill, which runs under the module lock (`lifecycle/prefill.mjs:427`), and capture publication (`lifecycle/capture.mjs:336-340`). The capture's browser work runs outside the lock (`:14-15`, `:333-335`).
- The `_app-runtime` lock is **one per target root and shared by every module** (`lifecycle/app-runtime.mjs:52`). `ensure` and `stop` take it (`:493`, `:525-527`); `check` does not (`:528`). This is a cross-namespace serialization point for UI migrations.
- The runtime preflight's skill-projection replacement takes no lock: "two concurrent preflights write the same verified bytes" (`skills/start-migration/scripts/runtime.mjs:543-544`). The install lock is per consumer root (`:349-350`).

**Separate git worktrees or clones** give each run its own registry, locks,
journals and records, because everything resolves from `cwd`
(`start-migration/SKILL.md:138-143`, `:313-316`; `lifecycle/lock.mjs:52-53`). Nothing
in the engine couples two worktrees while they run. The remaining couplings are
outside the engine:

- Applications that `migration_app_runtime` starts bind host ports. Each worktree has its own `_app-runtime` lock, so nothing prevents two worktrees from colliding on a port (`lifecycle/app-runtime.mjs:1-19`, `:52`). **UNVERIFIED:** whether the configured ports can differ per worktree.
- The release store is shared across consumers (`runtime.mjs:214-217`, `:349-350`). Runtime receipts are per root: `<root>/.artifact-migration-tools/<provider>.json`, refused if written for another root or store (`runtime.mjs:548`, `:610-625`). The adapter doctor also runs per root (`:405-406`).
- The Playwright MCP browser profile may be shared. **UNVERIFIED** for this toolkit.

Integrating a finished worktree back into the shared target is analysed for
**module records only** (§4.1). Relocating an artifact record (reading it from a
different root path after a merge) and validating an artifact record after a merge
are **UNVERIFIED**.

### 2.2 Bottlenecks from existing evidence logs (no new runs)

Durations are computed from committed timestamps: the history `at` field and the
watcher `currentStep`, `start` and `exit` lines. The watcher's poll resolution is
about 1 s, which is **UNVERIFIED** (inferred from the timestamp spacing in the logs).

**Denominator: session-sum.** For the watcher runs, totals and percentages use the
sum of agent session lifetimes, each from its `start` line to its `exit` line. Restart
downtime between sessions is excluded, and so is any phase span that crosses it.
Wall time including downtime is given in brackets for reference. The m14 baseline
ledger has no session boundaries, so its only available span is CREATED→COMPLETE,
which includes its kill-and-resume downtime. That downtime cannot be separated
(`baseline-run/interrupt.log` records the kill, not the resume).

| Run (evidence path) | Total | Pre-bootstrap (preflight, spec draft, bootstrap) | Discovery → PLAN | Slice phase (2 slices) | FINALIZE | After COMPLETE |
| --- | --- | --- | --- | --- | --- | --- |
| m14 baseline: `docs/investigations/m14-start-migration-acceptance/baseline-run/record/history.ndjson` (seq 1–11) | 808.570 s, CREATED→COMPLETE ledger span | not in ledger | 412.517 s (51.0 %), CREATED→seq 6, including a kill and resume in BUILD_BASELINE (`baseline-run/interrupt.log`) | **285.726 s (35.3 %)**: slice 1 = 73.619 + 74.244 s, slice 2 = 85.008 + 52.855 s | 110.327 s (13.6 %) | — |
| m14.1 `run-9842054/watch.log` | 840.538 s session-sum, 2 sessions [872.274 s wall] | 90.089 s (10.7 %) | 370.385 s (44.1 %), including a kill [402.121 s wall] | **188.177 s (22.4 %)**: slice 1 = 46.047 + 34.036 s, slice 2 = 78.064 + 30.030 s | 80.080 s (9.5 %) | **111.807 s (13.3 %)** |
| m14.1 `run-49a4e1e/watch.log` | 753.019 s session-sum, 3 sessions [938.097 s wall] | 91.096 s (12.1 %) | 322.248 s (42.8 %), including a kill and an `exit code=1` restart inside BUILD_BASELINE [507.326 s wall] | **213.205 s (28.3 %)**: slice 1 = 59.053 + 38.040 s, slice 2 = 85.082 + 31.030 s | 108.096 s (14.4 %) | 18.374 s (2.4 %) |
| m13.1 artifact: `docs/investigations/m13.1-real-agent-acceptance/record/history/history.ndjson` | 191.085 s, BOOTSTRAPPED→COMPLETED ledger span | — | 112.549 s (seq 1→6) | 57.289 s, 1 slice | 21.247 s | — |

All figures in this table are **MEASURED** from the cited files. The phases of each
watcher run sum exactly to its session-sum total.

Findings:

1. **B1. Agent authoring time dominates the checkpoints, but the split is not measured.** No committed evidence records how long engine calls take versus model reasoning. The agent/model split is **UNVERIFIED**, and nothing in this report should be optimized until it is measured (Roadmap I1).
2. **B2. The slice phase is the only part where slice-level parallelism could help.** It is 22.4–35.3 % of the total in the module runs (MEASURED, three runs of one two-slice fixture).
3. **B3. Interruption and recovery are visible gaps.** One session ended `exit code=1` at BUILD_BASELINE, and the next session started 162.263 s later (MEASURED gap, `run-49a4e1e/watch.log`). The session-sum basis excludes such gaps. The incremental cost of a crash, meaning re-done work inside the next session, is **UNVERIFIED**, and so is the root cause of `exit code=1`.
4. **B4. Time after COMPLETE was 111.807 s in one run and 18.374 s in another** (MEASURED). This is session time after the engine reported COMPLETE. What the session spent it on is **UNVERIFIED**, because that run has no transcript outline.
5. **B5. Unnecessary sequential dependencies:**
   - Two whole migrations of independent modules are sequential today only by operator habit. The engine supports them in separate worktrees (§2.1).
   - Inside one record, every sequential dependency is load-bearing (N1–N3, §2.1). None was found to be unnecessary under the current gate design.

---

## 3. Subagent feasibility

| Question | Finding |
| --- | --- |
| Can subagents advance a record concurrently? | **No. Rejected.** Single `activeSlice` and compare-and-swap (N1, C4). Concurrent callers get refusals. The record is not corrupted, but the tokens are wasted. This is the only subagent use this report rejects. |
| Can subagents share the MCP server for speed? | **UNVERIFIED.** One connection is serialized, and so are tool calls in one server process (N4). Whether a subagent shares the parent's connection or server process is UNVERIFIED for every provider, so neither a speedup nor its absence is shown. |
| Can subagents do read-only work, such as reading legacy sources before the bootstrap spec draft? | Technically allowed, because legacy is read-only evidence (`start-migration/SKILL.md:277`). The pre-bootstrap phase is 90.089 s and 91.096 s in total (MEASURED, §2.2), and it includes preflight and bootstrap. Any speedup from read-only subagents is **UNVERIFIED**. Not pursued here; not rejected. |
| Provider-neutral? | The skills require one identical protocol (`start-migration/SKILL.md:150-152`). Subagent APIs for Codex `exec`, Copilot CLI and OpenCode are **UNVERIFIED** from repository evidence. A subagent-dependent protocol would fork behavior per provider. |
| Claude Code in the harness | The acceptance runner grants `Bash Read Edit Write Glob Grep mcp__start-migration mcp__playwright` and no subagent tool (`scripts/agent-e2e-acceptance.mjs:148-151`). Enabling subagents widens the certified grant. The grants a subagent would effectively hold are **UNVERIFIED**. |
| Security invariants: 9 MCP grants and `approval_policy=never` | **These are not on BASE.** They live on unmerged harness refs, for example `toolkit/harness/scorer-fixes-20261104` (`453a3b1`), `453a3b1:docs/agent-e2e-acceptance.md:156-185`. That commit is not an ancestor of BASE (`git merge-base --is-ancestor 453a3b1 82ee6be` exits 1). At BASE, the shipped Codex and Copilot configs carry no tool filter (`providers/codex/config.toml:3-5`, `providers/copilot/mcp.json:2-10`). The Codex runner at BASE passes `--sandbox workspace-write` and project trust, with no `approval_policy` (`scripts/agent-e2e-acceptance.mjs:155-158`). The BASE server advertises **11** tools (`transport/mcp.mjs:448-579`), including `migration_app_runtime` (`:531`) and the relay (`:561`). The nine-grant list on the harness ref omits `migration_app_runtime` (`453a3b1:docs/agent-e2e-acceptance.md:164-168`). **This is a drift to resolve independently of parallelism (I4).** |
| Sandbox and read-only mounts | OS isolation is applied per agent process: user, mount and PID namespaces with read-only binds and capabilities dropped (`scripts/agent-e2e-acceptance.mjs:92-108`). One isolated agent per worktree keeps that model unchanged. Subagents spawned inside the namespace inherit it (Linux namespace semantics; harness behaviour with subagents is UNVERIFIED). |
| Operator decisions | The skill tells the agent to show the review, end its turn, and relay only after the user's next message is an explicit APPROVE or REJECT (`start-migration/SKILL.md:352-370`). Whether anything enforces that only the parent session relays, and never a subagent, is **UNVERIFIED**: no such check was found. Each parallel worktree has its own decision stream, so the operator's attention becomes the bottleneck. **PROJECTED:** that load grows linearly with the number of parallel sessions. |

**Verdict:** concurrent record advancement by subagents is **rejected**. Read-only
subagent work is not rejected, but its benefit is UNVERIFIED and it widens the grant.
Parallelism belongs one level up: one isolated agent session per independent
migration, each in its own worktree.

---

## 4. Recommended architecture

### 4.1 Stage classification

Every stage is listed for both engines, with the reason.

| Stage | Class | Reason |
| --- | --- | --- |
| Runtime preflight (`runtime.mjs ensure`) | PARALLEL_WITH_GUARD | The release store is shared (`runtime.mjs:214-217`, `:349-350`), but receipts are keyed per root (`:548`, `:610-625`) and the adapter doctor runs per root (`:405-406`). Store fetch and first install are UNVERIFIED under a race. **Guard:** warm the shared release store once, then run preflight in each worktree root. Keep the normal per-iteration checks. |
| `migration_status` / `--status` / `artifact_status` | SAFE_PARALLEL | Read-only: no lock, no write (`start-migration/SKILL.md:711-715`; `migrate-artifact/SKILL.md:83-89`). |
| Pre-bootstrap legacy reading (spec draft) | SAFE_PARALLEL, benefit UNVERIFIED | Read-only legacy evidence (`start-migration/SKILL.md:277`). The whole pre-bootstrap phase is 90.089–91.096 s (MEASURED). |
| RESOLVE / bootstrap (module) | PARALLEL_WITH_GUARD | Different modules: separate locks plus registry merge (C1, C3). **Guard:** separate worktree, because the bootstrap preview binds the whole target dirty digest (`lifecycle/preview.mjs:248-267`). |
| Artifact bootstrap | PARALLEL_WITH_GUARD | Confirmation binds the whole-tree `dirtyDigest` (`lifecycle/artifact-status.mjs:84-107`, `census/artifact.mjs:346-356`). **Guard:** separate worktree, plus the artifact precondition in §4.2. |
| DISCOVER_LEGACY, DISCOVERY_COMPLETENESS, ASSESS_TARGET, PLAN (within one record) | MUST_BE_SEQUENTIAL | Each consumes the previous checkpoint's pinned artifacts. `completedSteps` is an in-order prefix (`formats/module.mjs:535-541`). |
| Same checkpoints, different records | PARALLEL_WITH_GUARD | Per-record locks (C1, C2). **Guard:** separate worktree by default. In one tree, see the IMPLEMENT/VERIFY and FINALIZE rows. |
| UI and browser work: DISCOVER_LEGACY (read-only Playwright observation), ASSESS_TARGET (`frame` capture), VERIFY_SLICES (`claim` capture), and `migration_app_runtime ensure` before each | PARALLEL_WITH_GUARD across records, MUST_BE_SEQUENTIAL within one | The skill runs the app runtime before the first browser or capture step of each of these stages (`start-migration/SKILL.md:1285-1287`). Capture is legal only at ASSESS_TARGET and VERIFY_SLICES (`:1244-1247`; `lifecycle/capture.mjs:7-12`, `:75-79`, `:118-121`). `_app-runtime` lock is per target root (`lifecycle/app-runtime.mjs:52`, `:525-527`). Ports and the browser profile are shared host resources (UNVERIFIED). **Guard, in every one of these stages:** distinct ports per worktree, or serialize UI and browser work. |
| Capture publication (`migration_capture` write) | MUST_BE_SEQUENTIAL | The record is re-read under the module lock and the write is refused if the fingerprint moved (`lifecycle/capture.mjs:336-340`). |
| Checkpoint commits: the advance's locked state, journal and history write, and any git commit to the target | MUST_BE_SEQUENTIAL | The transition runs under the module lock with compare-and-swap (`lifecycle/advance.mjs:212-214`, `:267-280`). A git commit moves `targetRevision`, which gate evidence binds (`lifecycle/gates.mjs:110-111`). |
| IMPLEMENT_SLICES / VERIFY_SLICES, same record | MUST_BE_SEQUENTIAL | One `activeSlice` (N1), slice order (N2), unlisted-file gate (`lifecycle/validation.mjs:1289-1314`), and FINALIZE freshness (`slices/freshness.mjs:47-83`, run at `lifecycle/validation.mjs:1236`). |
| IMPLEMENT/VERIFY, different records in the same target tree | PARALLEL_WITH_GUARD | These checks are scoped: the advance confirmation does not bind the target dirty digest (`lifecycle/advance.mjs:108-121`), the IMPLEMENT gate reads only the active slice's planned scope (`lifecycle/validation.mjs:1289-1296`), and VERIFY only reports drift (`slices/drift.mjs:392-398`). **Guard:** non-overlapping planned target subtrees. Otherwise the other record's edits become this record's unlisted or unclaimed files (§2.1). |
| IMPLEMENT/VERIFY, different records in different worktrees | SAFE_PARALLEL | No shared engine state across worktrees (§2.1). |
| `migration_prefill` | MUST_BE_SEQUENTIAL per record | Under the module lock (`lifecycle/prefill.mjs:427`). |
| FINALIZE gates, same record | MUST_BE_SEQUENTIAL | Bound to the whole dirty digest and revisions (`lifecycle/gates.mjs:79-101`, `:105-124`). |
| FINALIZE, different records in the same target tree | MUST_BE_SEQUENTIAL in practice | Requires a stable tree. Any other writer stales the whole-tree binding (`lifecycle/gates.mjs:118-121`), and the module lock does not freeze other writers (§2.1). |
| FINALIZE target validation commands run by the agent (test, lint, type-check, build) | PARALLEL_WITH_GUARD | Background work is allowed (`start-migration/SKILL.md:956-964`). The dirty digest ignores git-ignored files (`git status --porcelain=v1 -uall`, `shared/git.mjs:95-98`). **Guard:** run commands concurrently only when they are independent, write disjoint outputs (to ignored paths only, otherwise evidence goes stale), and run on a stable snapshot of the tree. Benefit is UNVERIFIED because no per-command timings exist. |
| Ponytail review/audit evidence (FINALIZE) | MUST_BE_SEQUENTIAL when enabled | Opt-in, disabled when omitted (`start-migration/SKILL.md:518-520`; `migrate-artifact/SKILL.md:70-76`). Module: `full` needs `SIMPLIFY_ONCE` review evidence, and `full-audit` also needs `PRECOMMIT_GATE` audit evidence (`lifecycle/gates.mjs:40-46`). No engine ordering check was found for module records (`git grep -n "must precede" 82ee6be -- packages/migration-engine/src` matches only the artifact check). Artifact `--ponytail full-audit` enforces Review, then Audit, then the artifact pre-commit review (`lifecycle/artifact-checkpoints.mjs:870-873`; `migrate-artifact/SKILL.md:72-73`). |
| Operator decisions / relay | MUST_BE_SEQUENTIAL | Explicit human turn (`start-migration/SKILL.md:352-370`) and ledger append under lock (`lifecycle/recorder.mjs:390`). |
| Format upgrade | MUST_BE_SEQUENTIAL | Freezes the lifecycle, one increment per invocation (`start-migration/SKILL.md:652-654`, `:698-703`). |
| Registry update | PARALLEL_WITH_GUARD | `registry` lock plus recompute (`lifecycle/registry.mjs:183-188`). **Guard:** none needed in one tree. Across worktrees it is a git merge of `registry.json` and `package.json`. |
| Reopen / rework / amend / toolkit identity / adoption | MUST_BE_SEQUENTIAL per record | Module lock (`lifecycle/reopen.mjs:61`, `lifecycle/toolkit-identity.mjs:168`, `lifecycle/adoption.mjs:497`). |
| Integration of finished worktrees into the shared target (module records) | MUST_BE_SEQUENTIAL | Merging moves `targetRevision`, and gate evidence is revision-bound (`lifecycle/gates.mjs:110-111`). Post-merge behaviour of a COMPLETE record's status is **UNVERIFIED**. |
| Integration of finished worktrees (artifact records) | Not classified | Artifact relocation and post-merge validation are **UNVERIFIED** (§2.1). Precondition for artifact fan-out (§4.2). |

### 4.2 The one change worth making: worktree fan-out across independent migrations

```
operator
  ├─ warm the shared release store once                 [sequential]
  ├─ git worktree add wt-A ; git worktree add wt-B       [native git, no new code]
  ├─ preflight in wt-A ; preflight in wt-B               [per root]
  ├─ agent A (own isolation, own MCP server, cwd=wt-A) ─┐   [parallel]
  ├─ agent B (own isolation, own MCP server, cwd=wt-B) ─┘
  └─ merge wt-A, then wt-B, re-run status on each record [sequential]
```

- **No engine change.** The engine already resolves every record, lock and journal from `cwd` (`start-migration/SKILL.md:138-143`, `:313-316`).
- **Guards:**
  1. One module or artifact per worktree, and never the same ID in two worktrees. The engine cannot see across worktrees.
  2. Target subtrees must not overlap (compare the PLAN `targetPaths`, `slices/plan.mjs:209`).
  3. UI migrations get distinct app ports, or their UI and browser work is serialized, in every stage where it runs (§4.1).
  4. Warm the shared release store once, then run preflight in each worktree root, because receipts and provider registration are keyed per root (`runtime.mjs:610-625`, `:405-406`). Keep the normal per-iteration checks.
  5. Merge sequentially and run `--status` after each merge.
  6. **Artifact precondition:** do not fan out artifact records until artifact relocation and post-merge validation are proven (UNVERIFIED today; Roadmap I2).
- **Rejected alternatives:**
  - *Parallel slices inside one record.* This needs `activeSlice` to become a set and dirty digests to become per-slice, plus new freshness and drift rules. That changes the record's state format. Which kind of format change it would be, non-promoting (`start-migration/SKILL.md:586-595`) or an upgrader-owned increment (`:596-599`), is **UNVERIFIED**. The ceiling is 9.5–17.1 % on the only evidence (PROJECTED, §5). High complexity and determinism risk for low benefit.
  - *Subagents advancing a record concurrently.* Refused by the engine (§3).
  - *Concurrent FINALIZE of modules in one target tree.* Whole-tree binding forces re-authoring unless the tree is stable (§2.1).
  - *Scoping `targetDirtyDigest` to the module's subtree.* This would weaken "any uncommitted change invalidates evidence" (`lifecycle/gates.mjs:118-121`), which is a correctness invariant. Rejected by the constraints.

---

## 5. Expected gains

All percentages use the session-sum denominator from §2.2 (ledger span for the baseline).

| Scenario | Figure | Label | Basis or assumptions |
| --- | --- | --- | --- |
| Single module, current | 753.019–840.538 s session-sum per two-slice fixture migration; baseline 808.570 s ledger span | MEASURED | §2.2 |
| Slice phase share | 22.4 %, 28.3 %, 35.3 % | MEASURED | §2.2 |
| Ideal parallel slices (2 independent slices, zero overhead) | −80.083 s (9.5 %, run-9842054), −97.093 s (12.9 %, run-49a4e1e), −137.863 s (17.1 %, baseline) | PROJECTED | Time saved = (sum − max) of the two per-slice durations, divided by that run's total. Assumes the two fixture slices are independent (UNVERIFIED; the plan file is not in committed evidence) and no coordination cost. Requires the rejected engine redesign. |
| Worktree fan-out, M independent modules of similar size | Wall time ≈ T_max + merge time. Reduction vs sequential ≈ (M−1)/M: **M = 2 → ~50 %, M = 3 → ~67 %** | PROJECTED | Assumes independent modules, non-overlapping target subtrees, provider quota and rate limits allowing M sessions (UNVERIFIED), merge plus post-merge status negligible (UNVERIFIED), and operator decisions not on the critical path. |
| Removing time after COMPLETE | up to −111.807 s (13.3 %) in run-9842054, −18.374 s (2.4 %) in run-49a4e1e | PROJECTED (durations MEASURED; attribution UNVERIFIED) | Assumes the whole tail is removable, which is unproven (B4). |
| FINALIZE command concurrency | unknown | UNVERIFIED | No per-command timings in evidence. FINALIZE is 80.080–110.327 s in total (MEASURED), so the PROJECTED ceiling is below that. |

---

## 6. Risks and mitigations

| Risk | Where | Mitigation |
| --- | --- | --- |
| Same module driven from two worktrees produces two divergent records | Locks are per worktree (`lifecycle/lock.mjs:50-53`) | Fan-out guard refuses duplicate IDs (Roadmap I3). |
| Overlapping target subtrees produce merge conflicts or post-merge `UNCLAIMED_TARGET_DRIFT` | `slices/drift.mjs:316-321`, `:399-427` | Guard compares PLAN `targetPaths`; overlapping migrations run sequentially. |
| Revision-bound evidence after merge | `lifecycle/gates.mjs:110-111` | Merge only COMPLETE records, then run `--status` per record. Post-merge behaviour is UNVERIFIED and must be proven in I2. |
| Artifact records moved or merged across worktrees | No evidence (§2.1) | Artifact fan-out waits for the I2 artifact check (§4.2, guard 6). |
| `registry.json` / `package.json` binding merge conflict | `lifecycle/registry.mjs:216-224` | Sequential merge. Registry entries are per module, so the conflict is textual. UNVERIFIED; checked in I2. |
| Stale locks from killed parallel sessions | `lifecycle/lock.mjs:13-20`, `:142-180` | Same-realm locks are reclaimed automatically only under the conditions in §2.1. Never mix Windows and WSL on one worktree (`lifecycle/lock.mjs:77-81`), and expect manual removal after a PID-namespace restart (`:27-29`). |
| Port, browser and capture contention for UI work | `lifecycle/app-runtime.mjs:52`, `:525-527`. The session broker is a loopback service that wraps `captureInBrowser` for both roles (`docs/session-broker.md:3-8`). Whether one broker can serve captures from several worktrees at once is **UNVERIFIED** | Distinct ports per worktree, or serialize UI and browser work. |
| Provider quota or rate limits across M sessions | UNVERIFIED (no repository evidence) | Cap M at 2 until I2 measures it. |
| Operator attention: M concurrent `OPERATOR_DECISION` stops | `start-migration/SKILL.md:352-370` | Accept it. Decisions stay strictly per session, and nothing is batched or auto-approved. |
| Determinism and resume | Per-record journals (`lifecycle/journal.mjs:6-26`), hash-chained history (`store/record.mjs:135-143`), resume consistency check (`slices/state.mjs:15-22`) | Unchanged by fan-out, because every record lives in exactly one worktree. |
| Typed outcome when a compare-and-swap refusal reaches MCP | The thrown "state moved" error (`lifecycle/advance.mjs:271-275`). Mapping to `BLOCKED` or `FAILED` is UNVERIFIED | Not reachable under the I3 guard. Verify only if same-record concurrency is ever proposed. |
| Grant drift: 9 grants vs 11 advertised tools at BASE | `transport/mcp.mjs:448-579` vs `453a3b1:docs/agent-e2e-acceptance.md:164-168` | Owner decision (I4). Fan-out does not change the grant set. |

---

## 7. Roadmap (prioritized; engine and infrastructure kept separate)

| ID | Track | Item | Timebox | Validation | Numeric target |
| --- | --- | --- | --- | --- | --- |
| **I1** | Infra | Timing extractor over **existing** evidence: history `at`, watcher logs and stream-json transcripts. It writes a per-checkpoint table and, where the evidence allows, a per-tool-call table. No new runs. | 4 h | Reproduce §2.2 from the same files on the stated session-sum basis | Reproduce each §2.2 duration within ±1 s and recompute its percentage. **Only if** timestamped tool-call evidence is found for a run: attribute ≥ 90 % of that run's time to engine, tool or model buckets. |
| **I2** | Infra (needs owner authorization: provider invocations) | Two-worktree fan-out dry run on a disposable two-module fixture with independent modules, then sequential merge and `--status` on both records. Separately, one artifact record moved and merged the same way. Functional only, unscored. | 1 day | Same verifier as the sequential baseline. Check history chain, journal absence, lock absence and `--status` after each merge. | **≥ 40 % wall-time reduction** vs the sum of the two sequential runs, at **equal functional PASS (2/2)**, **0** state or journal divergence, **0** leftover locks or journals. Artifact check: `--status` valid after relocation and merge. |
| **I3** | Infra | Fan-out guard and runbook: refuse a duplicate module or artifact ID, overlapping PLAN `targetPaths`, or a shared app port across worktrees. Warm the store once, then preflight per worktree root. Uses `git worktree` only. | 4 h | Three negative cases plus one positive case | **100 %** refusal on the 3 negative cases, **0** false refusals on the positive case. |
| **I4** | Infra | Resolve the grant drift, independently of parallelism. **OWNER DECISION:** (a) 9 tools, excluding `migration_app_runtime`, as on the harness ref; or (b) 10 tools, including it. The relay is excluded under both. | 2 h | Grant probe as in `453a3b1:docs/agent-e2e-acceptance.md:169-173`, validating the two sets separately: the **advertised** set (the server's `tools/list`, 11 at BASE, `transport/mcp.mjs:448-579`) and the **effective** set (installed allowlist ∩ advertised − denylist) | Advertised set equals the recorded expected list. Effective set equals the owner's chosen set exactly (9 or 10). **0** relay grants. |
| **E1** | Engine (only if I1 shows a target) | Post-COMPLETE and FINALIZE cost review. Act only if I1 attributes ≥ 20 % of FINALIZE to engine calls. | 2 h investigation | I1 table | Decide go or no-go. If go: ≥ 20 % FINALIZE reduction with an identical test suite (0 new failures). |
| **E2** | Engine (deferred, gated) | Parallel slices within a record. **Do not start** unless I1 shows the slice phase above 50 % of wall time on a real migration with ≥ 4 independent slices. | — | — | Gate condition as stated. Otherwise remains rejected. |

---

## 8. Acceptance criteria for adopting the recommendation

1. I1 reproduces every MEASURED duration here within ±1 s and recomputes its percentage. The ≥ 90 % attribution target applies only to runs with timestamped tool-call evidence.
2. I2 shows ≥ 40 % wall-time reduction for two independent modules, with 2/2 functional PASS, 0 history-chain breaks, 0 leftover journals and 0 leftover locks. Artifact fan-out additionally needs the I2 artifact relocation and merge check to pass.
3. I3 refuses 3/3 unsafe fan-outs and accepts 1/1 safe fan-out.
4. No change to engine invariants: the single active slice, the whole-tree dirty-digest binding, the module lock, compare-and-swap and the relay exclusion all stay as at BASE.
5. Each agent keeps its own OS isolation and grant set. No subagent tool is added to the certified grants.

---

## 9. Recommendation

Do not run concurrent advancement inside a migration. The engine is built around one
active slice and whole-tree evidence binding, and on the only evidence the slice
phase caps the gain at 9.5–17.1 % (PROJECTED from MEASURED). Parallelize *across*
independent migrations instead: one isolated agent per git worktree, with the shared
release store warmed once, preflight in each worktree root, and a sequential merge.
That needs no engine change, keeps every correctness and security invariant, and
projects to about 50 % wall-time reduction for two modules (PROJECTED). Fan out
module records first; artifact records wait for the relocation and merge check.
Measure first (I1), then prove it once (I2) behind a refusal guard (I3).

---

## Appendix A. Ponytail skipped / unchecked / risks

- **Skipped:**
  - Engine redesign for parallel slices (E2, gated).
  - Concurrent record advancement by subagents: refused by the engine.
  - Per-module dirty-digest scoping: weakens an invariant.
  - FINALIZE command concurrency: not measurable from current evidence.
- **Unchecked (UNVERIFIED):**
  - Agent/model time split, incremental crash cost, and attribution of time after COMPLETE.
  - Watcher poll resolution.
  - m14 fixture slice independence.
  - Subagent support in Codex, Copilot and OpenCode; MCP connection sharing; read-only subagent speedup; effective subagent grants; parent-only relay enforcement.
  - One MCP server process per host session.
  - Provider quota under M sessions.
  - Port, Playwright profile and session-broker sharing across worktrees.
  - Post-merge `--status` of COMPLETE module records; artifact relocation and post-merge validation.
  - State-format class of the parallel-slice redesign.
  - Module-side Ponytail ordering enforcement.
  - Typed outcome of a compare-and-swap refusal over MCP.
  - Cause of `exit code=1` in `run-49a4e1e`.
- **Risks:**
  - All timings come from **one** small two-slice fixture (`discounts`), so real-module ratios may differ.
  - The baseline denominator includes restart downtime that cannot be separated.
  - The 9-grant and `approval_policy=never` invariants are absent from BASE and drift from the BASE tool list (I4, owner decision).
  - Cross-realm (Windows/WSL) stale locks need manual removal (`lifecycle/lock.mjs:186-188`).

---

## Appendix B. Review fix log (rev 2)

| Finding | Status | Evidence |
| --- | --- | --- |
| F1 Preflight | FIXED | Store shared: `runtime.mjs:214-217`, `:349-350`. Receipt per root: `:548`, `:610-625`. Adapter doctor per root: `:405-406`. §4.1, §4.2 guard 4, I3, §9. |
| F2 Same-tree restriction | FIXED | Tree-wide: `lifecycle/preview.mjs:248-267`, `lifecycle/gates.mjs:153-169` via `lifecycle/validation.mjs:1234`, `lifecycle/artifact-status.mjs:385-394`. Scoped: `lifecycle/advance.mjs:108-121`, `lifecycle/validation.mjs:1289-1296`, `slices/drift.mjs:392-398`. The lock covers one name only: `lifecycle/lock.mjs:52-53`, `:258-264`. §2.1, §4.1. |
| F3 Artifacts | FIXED | PLAN selection: `lifecycle/artifact-checkpoints.mjs:1226-1237`, `:1273`. Integration claim scoped to modules (§2.1, §4.1). Artifact relocation and merge marked UNVERIFIED, with a precondition (§4.2 guard 6, I2, §8). |
| F4 Stage labels | FIXED | Capture publication `lifecycle/capture.mjs:336-340`. Checkpoint commits `lifecycle/advance.mjs:212-214`, `lifecycle/gates.mjs:110-111`. UI stages `start-migration/SKILL.md:1244-1247`, `:1285-1287`, `lifecycle/capture.mjs:7-12`. Command guard (§4.1). Ponytail order `lifecycle/artifact-checkpoints.mjs:870-873`, `lifecycle/gates.mjs:40-46`. |
| F5 Subagents | FIXED | Rejection limited to concurrent record advancement (N1, C4). The four UNVERIFIED items are marked in §3. |
| F6 Timings | FIXED | Session-sum denominator stated (§2.2). MEASURED: 370.385 s session-sum and 402.121 s wall from `run-9842054/watch.log` (23:11:52.690Z→23:18:34.811Z, minus the 23:15:18.907Z→23:15:50.643Z gap). 412.517 s = baseline seq 1→6. The phases of each watcher run sum to their session totals. |
| F7 I1 target | FIXED | §7 I1, §8 item 1. |
| F8 I4 | FIXED | §7 I4: owner decision between 9 and 10 tools, with advertised and effective sets validated separately. |
| F9 Citations | FIXED | Rev-1 report lines 31, 40, 51–52, 69, 71, 77, 89, 141, 166, 168, 169, 171, 197, 225 and 226 re-cited at BASE. Test `:2167` cited for the different-module case (C1, C3). Host-registration claim narrowed (§1.1 MCP); broker claim narrowed (§6). PID-reclaim conditions stated (§2.1). Redesign state format marked UNVERIFIED (§4.2). |
