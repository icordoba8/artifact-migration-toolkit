# start-migration — Architecture Improvement Plan

**Status:** proposal, not started.
**Precondition:** Priority 1 (functional skill) must be met first. See Phase 0.
**Window:** 5 working days maximum, with Day 5 as buffer and release.
**Audited baseline:** `f0809218274131d06dd363280e6c825178fa38e2` (v1.3.17 record). Re-measure at the actual start SHA.

---

## 1. Why this plan exists

The audit found one root problem: **rules have no single owner.** Every incident in the last week came from two copies of one rule disagreeing:

| Incident | Duplicated rule |
|---|---|
| FINALIZE digest mismatch (v1.3.14) | record-time vs recompute-time digest input |
| `DEC-003` corrupted the record (v1.3.15) | reader enforced the post-census rule; 4 writers did not |
| Group offered but refused (v1.3.16) | offer predicate vs write predicate |
| Auto-claim failed 2 reviews (v1.3.16–17) | claims, drift, journal and decision rationale each had their own logic |

The audit measured these structural causes:

| Metric | Value |
|---|---|
| Engine size | 36,450 lines; `resumable-migration.mjs` alone is 17,057 lines with 336 functions (185 exported) |
| Coupling | 11 modules import 71 distinct names from that one file |
| Filesystem write sites | 78 in that file; 117 across the engine |
| Format gates | 16 supported formats (4–19), with feature logic branching on `formatVersion` |
| Growth | engine +40% and `SKILL.md` +46% in 19 days, across 28 releases |
| Agent instructions | ~31,000 words in the skill and its references |
| Tests | 50,405 lines; one test file is 20,340 lines; 21 test files import engine internals |

**Decision:** keep one orchestrating skill and refactor the engine into a **modular monolith** in which every guarantee has exactly one owner. Do **not** split the lifecycle into several stateful skills: the checkpoints share invariants, so splitting them would multiply the rule duplication that causes the bugs.

## 2. Target architecture

```
start-migration (one skill; short core loop; references loaded per checkpoint)
engine/
  store/      ONLY writer of state, ledger, history, integrity.
              build bytes -> validate with the SAME loader -> atomic write.
  formats/    upcasts old records to the current model at load time.
              Nothing outside formats/ branches on formatVersion.
  lifecycle/  9-checkpoint state machine, lock, journal, recovery.
  decisions/  candidates, ONE offer==accept predicate, relay, authority.
  slices/     scope, changedFiles, ONE claims model, drift, rework, IMPLEMENT gate.
  census/     discovery scan and digest.
  visual/     UI evidence, visual contract, design sources.
  transport/  MCP + CLI (thin; no business rules).
```

## 3. Non-negotiable rules for every phase

1. **One phase = one objective = one prompt.** No work outside the phase scope. If something else is found, log it in `BACKLOG.md` and keep going.
2. **Behavior-preserving.** No feature is removed, disabled or changed. No new module or artifact format.
3. **Golden trace gate.** Each phase must reproduce the Phase 0 golden trace byte-for-byte (normalized). Any divergence stops the line.
4. **No publishing until Day 5.** Phases merge to `main` with Ubuntu CI green. Users stay on the last functional release (v1.3.18 or later).
5. **Independent review per phase**, scoped to that phase's diff, before the next phase starts.
6. **Timebox per phase is a hard ceiling.** On overrun: stop, report, and decide whether to cut scope. Never extend silently.
7. **Models:** implementation by Claude Code with Claude Opus 5.5 High (`/ponytail full`); review by Codex with GPT-6 Sol High (`$ponytail` lite + `$ponytail-review`).
8. **Frozen refs:** every review uses full 40-char BASE and REVIEW SHAs.

## 4. Schedule and effort

| Day | Phase | Objective | Agent time | Your time |
|---|---|---|---|---|
| — | **0** | Functional baseline + golden trace (Priority 1) | done before Day 1 | real migration |
| 1 | **1** | Deterministic replay harness | 2–3 h | 15 min |
| 1–2 | **2** | `store/`: single writer with validate-before-commit | 4–5 h | 30 min (review) |
| 2–3 | **3** | `decisions/`: one predicate, one relay path | 3–4 h | 30 min |
| 3 | **4** | `slices/`: one claims model and drift classification | 3–4 h | 30 min |
| 4 | **5** | `formats/`: upcast at load, no format branches elsewhere | 3–4 h | 30 min |
| 4 | **6** | Instructions: core `SKILL.md` ≤ 300 lines, references per checkpoint | 2 h | 30 min (weak-model check) |
| 5 | **7** | Tests reorganized by module; CI ≤ 12 min | 2–3 h | 15 min |
| 5 | **8** | Release v1.4.0 + real-use gate on 3 providers | 2 h | 1–2 h |

**Total:** ~22–28 agent hours over 5 days, plus ~4–5 hours of your time.
**Buffer rule:** if Day 3 ends behind schedule, Phases 6 and 7 move to the following week. They are not needed for v1.4.0 to be reliable. Phases 1–5 are the core.

## 5. Phases with acceptance criteria

### Phase 0 — Functional baseline (Priority 1, before Day 1)
- v1.3.18 released and reviewed READY.
- A clean migration of the first real consumer module reaches **COMPLETE** in the real consumer, with 0 manual continues and 0 state edits.
- Capture the **golden trace** from the fixture rehearsal on the same release: the sequence of outcomes and checkpoints, plus a normalized hash of state, ledger and history after each step.

**Accept when:** COMPLETE is reached in real use, and the golden trace is saved in the repo under `test/golden/`.

### Phase 1 — Replay harness (Day 1)
**Objective:** one command (`pnpm rehearse`) that replays a recorded fixture migration without an LLM, by feeding the recorded agent-authored artifacts at each step, and compares the result with the golden trace.
**Accept when:**
- two consecutive runs give identical normalized traces;
- it runs in ≤ 10 minutes locally;
- a deliberately injected one-line engine change makes it fail with a clear diff;
- it runs in CI as part of the required Ubuntu check.

### Phase 2 — `store/` (Days 1–2)
**Objective:** every write of state, ledger, history and integrity goes through `store/`. The store builds the bytes, validates them with the same loader the engine uses on read, and only then writes atomically.
**Accept when:**
- a CI check (grep or lint) shows **zero** filesystem writes outside `store/`, apart from an explicit allow-list (lock files, reports) committed with justification;
- one adversarial test per writer kind proves that an invalid result is refused with zero mutation;
- the golden trace is identical, and the full suites pass with no decrease in test count.

### Phase 3 — `decisions/` (Days 2–3)
**Objective:** candidate building, grouping, the offer predicate, the write predicate, relay and authority live in one module. `status`, `run`, `pending` and every writer call the same predicate.
**Accept when:**
- an equivalence test over every decision kind × (pre-census, post-census) × (single, group) proves that **anything offered is accepted** by the writer, and anything refused is never offered;
- MCP and CLI relay call the same function;
- the golden trace is identical.

### Phase 4 — `slices/` (Day 3)
**Objective:** one claims model (canonical target-relative paths), drift classification, rework, amend and the IMPLEMENT gate in one module. VERIFY_SLICES and FINALIZE use the same classifier.
**Accept when:**
- an equivalence test proves that VERIFY_SLICES and FINALIZE classify every path identically;
- the reviewer fixtures from v1.3.16–17 (path spellings, rework of a claimed file, edits after a claim) pass;
- the golden trace is identical.

### Phase 5 — `formats/` (Day 4)
**Objective:** records of formats 4–19 are upcast to the current model at load. Writers write only the current format.
**Accept when:**
- a CI check shows **no** `formatVersion` comparisons outside `formats/`;
- a compatibility matrix test proves that one fixture record per supported format loads and behaves exactly as at BASE (completes, or is refused with the same message);
- the golden trace is identical.

### Phase 6 — Agent instructions (Day 4)
**Objective:** the core `SKILL.md` holds only the loop contract (runtime preflight as step 0, CONTINUE, decisions, stops) in ≤ 300 lines. Checkpoint details move to references that are loaded only when that checkpoint is active.
**Accept when:**
- `SKILL.md` is ≤ 300 lines and provider parity checks pass;
- a weak-model rehearsal (Haiku in OpenCode or Claude Code) reaches COMPLETE on the fixture with **0 manual continues** in 2 of 2 runs.

### Phase 7 — Tests (Day 5)
**Objective:** split the 20,340-line contract test file by module; convert tests that pin internals into behavior tests at the module or CLI boundary when they duplicate coverage.
**Accept when:**
- a coverage map (behavior → test) shows no behavior lost, and every removed test is listed with the test that now covers it;
- the required CI stays ≤ 12 minutes.

### Phase 8 — Release and real-use gate (Day 5)
**Objective:** publish v1.4.0 and prove it in real use.
**Accept when:**
- the independent review of the full v1.3.18..v1.4.0 diff is READY;
- one real migration of a small module reaches COMPLETE in the consumer on **Claude Code, Codex and Copilot**, with 0 manual continues and 0 state edits;
- the first real consumer module's existing record still loads under v1.4.0 (backward compatibility in real use).

## 6. Prompts (use one per phase, in order)

Each prompt goes into a **new** Claude Code session in `<TOOLKIT_ROOT>`. Replace `<BASE_SHA>` with the current `toolkit/main` HEAD (all 40 characters).

### Phase 1 prompt
```text
Role: Build a deterministic replay harness, artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail full
BASE: toolkit/main == HEAD == <BASE_SHA> (freeze). Timebox: 3 h hard.
OBJECTIVE: `pnpm rehearse` replays the recorded fixture migration from test/golden/ without an
LLM, by feeding the recorded agent-authored artifacts at each step, and compares the normalized
trace (outcomes, checkpoints, normalized hashes of state, ledger and history) with the golden trace.
OUT OF SCOPE: any engine change.
ACCEPT: two runs give identical traces; ≤ 10 min; an injected one-line engine change fails with a
readable diff (revert it afterwards); added to the required Ubuntu CI.
STOP: if replay needs an engine change, report it and stop.
REPORT (Spanish): commands, durations, and the injected-failure diff; one commit, pushed; no release.
```

### Phase 2 prompt
```text
Role: Extract store/ as the single writer, artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail full
BASE: <BASE_SHA> (freeze). Timebox: 5 h hard.
OBJECTIVE: every write of state, ledger, history and integrity goes through store/. The store builds
the bytes, validates them with the same loader used on read, and only then writes atomically.
Behavior-preserving.
OUT OF SCOPE: decisions, slices, formats, instructions, tests outside this change.
ACCEPT: a CI check finds zero fs writes outside store/ except a committed, justified allow-list; one
adversarial test per writer kind (invalid result refused, zero mutation); pnpm rehearse matches the
golden trace; full suites pass; test count not lower.
STOP: a write that cannot be routed without a behavior change -> report and stop.
REPORT (Spanish): the writer inventory before/after, the allow-list, and the evidence; one commit,
pushed; no release.
```

### Phase 3 prompt
```text
Role: Extract decisions/ with one offer==accept predicate, artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail full
BASE: <BASE_SHA> (freeze). Timebox: 4 h hard.
OBJECTIVE: candidate building, grouping, the offer predicate, the write predicate, relay and
authority move to decisions/. status, run, pending, MCP relay, CLI relay and every writer call the
same functions. Behavior-preserving.
OUT OF SCOPE: store internals, slices, formats, instructions.
ACCEPT: an equivalence test over every decision kind x pre/post census x single/group proves
offered == accepted; one relay function shared by MCP and CLI; golden trace identical; suites pass.
STOP: if a behavior change is needed, report and stop.
REPORT (Spanish): the module API, the equivalence-test matrix, and the evidence; one commit; no release.
```

### Phase 4 prompt
```text
Role: Extract slices/ with one claims model, artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail full
BASE: <BASE_SHA> (freeze). Timebox: 4 h hard.
OBJECTIVE: scope, changedFiles, canonical claims, drift classification, rework, amend and the
IMPLEMENT gate move to slices/. VERIFY_SLICES and FINALIZE use one classifier. Behavior-preserving.
OUT OF SCOPE: decisions internals, formats, instructions.
ACCEPT: an equivalence test proves VERIFY_SLICES and FINALIZE classify every path identically; the
v1.3.16-17 reviewer fixtures pass (path spellings, rework of a claimed file, edits after a claim);
golden trace identical; suites pass.
STOP: if a behavior change is needed, report and stop.
REPORT (Spanish): the module API and the evidence; one commit; no release.
```

### Phase 5 prompt
```text
Role: Isolate formats/ (upcast at load), artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail full
BASE: <BASE_SHA> (freeze). Timebox: 4 h hard.
OBJECTIVE: records of formats 4-19 are upcast to the current in-memory model at load; writers
write only the current format; no formatVersion comparisons outside formats/.
OUT OF SCOPE: new formats, instructions, tests outside this change.
ACCEPT: a CI check finds zero formatVersion comparisons outside formats/; a compatibility matrix
(one fixture record per supported format) behaves exactly as at BASE; golden trace identical;
suites pass.
STOP: if a format cannot be upcast without a behavior change, report it and stop.
REPORT (Spanish): the format matrix results; one commit; no release.
```

### Phase 6 prompt
```text
Role: Shrink the agent instructions with progressive references, artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail full
BASE: <BASE_SHA> (freeze). Timebox: 2.5 h hard.
OBJECTIVE: the core SKILL.md (<= 300 lines) holds only the loop contract: runtime preflight as
step 0, CONTINUE without asking, decisions, stops. Checkpoint details move to references loaded
only for the active checkpoint. No engine change.
ACCEPT: SKILL.md <= 300 lines; pnpm providers:sync parity OK; a weak-model rehearsal (Haiku in
OpenCode or Claude Code) reaches COMPLETE on the fixture with 0 manual continues in 2 of 2 runs.
STOP: if a weak model still pauses after one wording revision, report the transcript and stop.
REPORT (Spanish): line counts before/after, the moved sections, and the run transcripts; one commit;
no release.
```

### Phase 7 prompt
```text
Role: Reorganize tests by module, artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail full
BASE: <BASE_SHA> (freeze). Timebox: 3 h hard.
OBJECTIVE: split migration-contract.test.mjs by module; convert tests that pin internals into
module- or CLI-boundary tests where they duplicate coverage.
ACCEPT: a coverage map (behavior -> test) with no behavior lost; every removed test is listed with
its replacement; required CI <= 12 min; golden trace identical.
STOP: if any behavior would lose coverage, keep the test and report it.
REPORT (Spanish): the coverage map and CI timings; one commit; no release.
```

### Phase 8 prompt
```text
Role: Release v1.4.0 after the architecture phases, artifact-migration-toolkit
Provider: Claude Code · Model: Claude Opus 5.5 — High Effort · Ponytail: /ponytail lite
BASE: <BASE_SHA> (freeze). Timebox: 2 h hard.
OBJECTIVE: bump to 1.4.0, then skills:lock, providers:sync, release:check/build/verify; ONE candidate
commit; Ubuntu required SUCCESS; publish (stable, immutable, 1 verified asset); release:record and
ONE record commit. Do not install in any consumer.
ACCEPT: release published and verified; full 40-char SHAs reported.
STOP: Ubuntu failure -> report it; no second fix.
```

### Review prompt (after every phase; Codex)
```text
Role: Independent read-only review of Phase <N>, artifact-migration-toolkit
Provider: Codex · Model: GPT-6 Sol — High Effort · Ponytail: $ponytail (lite), then $ponytail-review
FROZEN: BASE_SHA=<40 chars>, REVIEW_SHA=<40 chars>. Timebox: 45 min. Read-only.
CHECK, each PASS or FINDING with file:line:
1. the phase acceptance criteria from the plan, each one verified;
2. behavior preserved (pnpm rehearse matches golden on REVIEW);
3. no work outside the phase scope;
4. no removed or disabled feature, and no format change;
5. adversarial fixtures for the phase's single-owner claim (e.g. a write outside store/, an
   offer that would be refused);
6. $ponytail-review on the diff only.
OUTPUT: /tmp/phase-<N>-review.md with READY or NOT_READY, a table, and severities. End with "Review End".
```

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Regressions while moving 17k lines | Golden trace + replay in CI; one module per phase; review per phase |
| The replay harness cannot reproduce agent-authored steps | Phase 1 stops and reports; fall back to real `codex exec` rehearsal per phase (+1 h each) |
| A phase overruns | Hard timebox; Phases 6–7 slip to next week; Phases 1–5 keep priority |
| Hidden behavior found during extraction | Log it in `BACKLOG.md`; do not fix inside the phase |
| Old records break after `formats/` | Compatibility matrix in Phase 5 + the first real consumer module's record must load in Phase 8 |

## 8. Definition of done (whole plan)

- v1.4.0 published and reviewed READY.
- Every guarantee has one owner: zero writes outside `store/`, zero `formatVersion` branches outside `formats/`, one decision predicate, one claims model.
- Golden trace identical to Phase 0.
- One real migration COMPLETE on Claude Code, Codex and Copilot with 0 manual continues.
- Core `SKILL.md` ≤ 300 lines; required CI ≤ 12 minutes.
