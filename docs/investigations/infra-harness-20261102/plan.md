# Infra harness I1–I12, T3, row 17 fixture — Stage 1 plan

**Status: PLAN, awaiting owner approval. Nothing below is implemented except T3.**
No scored or native run, no engine/payload change, no host change. Not "ready".

Executor: GitHub Copilot CLI, Claude Opus 5.5. Ponytail: ultra (Stage 1).
Source of defects: Phase 0, `cert/m15-codex-uidmap-20261030` @
`a0cfb35472f02c784676f81b62587c3753ef89b9`,
`docs/investigations/m15-certification-run-20261031T2015Z/phase0/REPORT.md` §4.

## Identities

| Name | 40-char SHA |
|---|---|
| BASE (`toolkit/main`, frozen) | `15090145a43af1e1bcb9fbce692fafac6e06f1e9` |
| Harness lineage head (T3 source, native-fix; REPORT §1) | `1a9661b3aba58d7e8fe41076d5e72b3d1d87701a` |
| Engine under test (`engine/joint-candidate-20261102`) | `2782612c1f1796316233995a350712bc8a508fc3` |

BASE is an ancestor of both. `git merge-tree` of harness head and engine is
clean; their only overlapping paths are version/release-identity files, which
T3 deliberately does not carry.

## T3 — harness lineage (done in this stage)

Carried the 10 harness files of `BASE..1a9661b` byte-for-byte (each verified
`git diff --quiet 1a9661b -- <file>`): `docs/agent-e2e-acceptance.md`,
`docs/m15-harness-implementation.md`, `scripts/{agent-e2e-acceptance.mjs,
acceptance-evidence.mjs, engine-test.mjs, m15-official-run.sh, m15-patch.sh,
m15-pnpm.sh}`, `test/agent-e2e-acceptance.test.mjs`,
`packages/migration-engine/test/unit/lifecycle.test.mjs` (test-only).
**Not carried:** commit `874806f` 1.6.5 version/release-identity bumps (payload
identity belongs to the joint candidate). One squashed commit, provenance in its
message. Check: `checks/t3-harness-node22.13.0.tap` — 32 pass, 0 fail, 0 skip
(Node v22.13.0, this host). The launcher test passes only because it builds its
own fixture repo around `d7eb28ca`; it does not prove this branch's lineage.

**Found while carrying (fix in Stage 2, group G3):** `scripts/m15-patch.sh:6`,
`scripts/m15-official-run.sh:11`, `test/agent-e2e-acceptance.test.mjs:967` and
`docs/m15-harness-implementation.md:4,87` pin M15 BASE `d7eb28ca…`, which is
**not** an ancestor of this branch. The official launcher therefore refuses on
this lineage, and the patch digest is computed from the wrong base. Rebind to
the recorded BASE above.

A prior, interrupted attempt (19:18–19:22 local, unknown session) had staged the
same T3 bytes and left test scratch inside this evidence directory. Its logs are
kept unchanged in `checks/prior-attempt-19-19/`; its 94 MB scratch tree was moved
out of Git to the session workspace, not deleted. `pnpm install` flips engine
`bin` modes to 100755; those are never staged.

## Root-cause groups

Line refs are at T3 (`scripts/agent-e2e-acceptance.mjs` = R, 
`scripts/acceptance-evidence.mjs` = AE) and the joint engine @ `2782612`.
Every group's fix is harness-side only. Tests run on the infra branch (engine
1.6.4) **and** on a scratch merge of this branch with `2782612` (outside Git,
evidence logs only), Node 22.13.0, TMPDIR outside the repo. TMPDIR holds
scratch only: TAP logs are redirected straight into `checks/`, never into TMPDIR
(the first S2 logs were lost from `/tmp` at a reboot).

### G1 — Refusals scored from prose, not from engine tool results (I1)

- **Root cause.** R:575 decides `refusalObserved` with
  `/read.only|EROFS|permission denied|holds the lock|cannot be proven gone/i`
  over agent stdout+stderr. Under Codex code mode every tool call is a
  `custom_tool_call`; its output exists only in the rollout, never in
  `exec --json` stdout, so R5/R11 failed with an unchanged consumer. The same
  regex also accepts non-engine text: R5's only "refusal" was
  `bwrap: Can't mkdir …: Read-only file system` (provider sandbox), and any
  agent prose saying "read-only" would pass. Codex renders MCP errors as
  ``tool call failed for `start-migration/<tool>` … Mcp error: -32603: <message>``
  and drops `error.data.code` (R9 rollout l.44, R11 l.47), so the engine code is
  recoverable only from the message.
- **Fix boundary.** One provider adapter seam in R: `adapter.toolResults(runDir)`
  returning `{source: "mcp"|"cli", tool, exitCode, text}` bound to the call that
  produced it. Codex: locate the rollout by `thread_id` from `thread.started`
  (headless) or by `session_meta` cwd + start window (native), copy it into the
  output with SHA-256, pair `custom_tool_call`/`function_call` with its output.
  A refusal counts only if it is (a) a ``start-migration/<tool>`` MCP failure or
  structured result, or (b) an `exec_command` whose argv runs the receipt's
  installed engine CLI, with non-zero exit. A table maps the engine's exact
  message templates (joint `lock.mjs:274-283`, `files.mjs:62-72`, Node errno
  messages, `entry.mjs:20-27`) to codes. Per-scenario acceptance:

  | Code (joint engine) | live-lock (16/24) | read-only (18/26) | Notes |
  |---|---|---|---|
  | `LOCK_HELD` | **accepted** | – | with holder alive and lock bytes unchanged (existing checks) |
  | `LOCK_OWNER_UNKNOWN` | recorded, **not accepted** | – | fixture defect: a live tokened holder must read ALIVE |
  | `LOCK_NO_LIVENESS_TOKEN` | recorded, **not accepted** | – | expected only for token-less owners (G4) |
  | `LOCK_PROTOCOL_1` | recorded, not accepted | – | |
  | `EROFS` / `EACCES` / `EPERM` | – | **accepted** | the real syscall refusal |
  | `FS_ERRNO_UNKNOWN` | – | recorded, **not accepted** | cause unproven; never normalized to read-only (E4) |
  | `BLOCKED` / `NOT_STARTED`, exit 2 (`REGISTRY_UNBOUND`) | recorded `notStarted`, **not accepted** | same | nothing ran, but it precedes the lock/fs path, so it does not prove the scenario's refusal |
  | provider sandbox (`bwrap: …`), agent prose | ignored | ignored | not engine evidence |

  Unchanged-consumer, no-record, no-timeout checks stay. Old reports are never
  rewritten. The `lockRemovals` lead stays.
- **Files.** R, AE (classifier + rollout reader), test file.
- **Tests.** Classifier on fixture lines shaped like R9/R11/R5 rollouts:
  LOCK_HELD accepted; EROFS accepted; bwrap line, agent prose, and an `echo` of
  an engine message from a non-engine command rejected; FS_ERRNO_UNKNOWN and
  BLOCKED recorded but not accepted; rollout thread binding refuses a foreign
  thread id.
- **Unblocks.** Rows 16, 18, 24, 26 measurable (R5/R11 stay historical FAIL).
- **Codex:** rollout ingestion. **Copilot:** same seam; its adapter (reads
  `--output-format json` JSONL, per P0:114,143) is P1, out of scope — `--provider
  copilot` stays refused until P1.
- **Separate engine task (not fixed here):** E6 — MCP refusals cross as
  JSON-RPC `-32603` and Codex drops `error.data`; return the code in the text or
  as an `isError` result with `structuredContent`.

### G2 — Native run evidence depends on unverified operator state (I2, I3, I4)

- **Root cause.** The native path trusts what the operator did: the override
  layer's transport (I2), whether the one prompt was actually submitted (I3: R6b
  idled; R:497 prints the line once, the TUI redraw hides it), and which window
  was recorded (I4: R6 recorded Edge; R12 REC=yes had no file).
- **Fix boundary.**
  - I2: already fixed by T3 (`1a9661b`, R:376 preflight equality). Re-prove
    only; no installed-config rewrite.
  - I3: after a native run, read the bound rollout (G1 seam): require exactly one
    `event_msg/task_started` and exactly one operator `message/role=user` whose
    text equals the printed invocation (`/` or `$` skill sigil). Zero →
    verdict `NATIVE_NO_PROMPT` (not counted, never FAIL-as-scored); more than
    one → `FAIL` (rescue turn). Before launch, write the invocation and a random
    run nonce to `<output>/native-handoff.json` and print them; set the terminal
    title to the nonce (survives TUI redraw). No auto-typed prompt, no rescue.
  - I4: new tracked intake `scripts/acceptance-recording.mjs <output> <video>`:
    refuses unless the run's report exists; records path, size, SHA-256,
    birth/mtime against `startedAt`/`endedAt` (window not covered → `UNBOUND`);
    writes `<output>/recording.json` with `reviewRequired: ["nonce visible",
    "terminal window", "single invocation"]`. Never copies the video into Git.
    PTY typescript, recording file and human REC=yes stay three separate
    evidence types; nothing is HUMAN_ATTESTED unless the owner pastes it.
- **Files.** R, new `scripts/acceptance-recording.mjs`, test file,
  `docs/agent-e2e-acceptance.md` (native procedure).
- **Tests.** Turn counter on synthetic rollouts (0/1/2 turns, sigil variants);
  intake rejects missing report, out-of-window file, and never writes into Git.
- **Unblocks.** Rows 22, 30, A3 (and the evidence side of 37).
- **Codex:** as above. **Copilot:** native `-i` (P0:116) reuses handoff/intake;
  its turn reader is P1.

### G3 — Run orchestration lives in untracked, untested wrappers (I5, I6, I7, T3 BASE)

- **Root cause.** Launch metadata, report lookup and the start deadline were
  owned by per-campaign shell (`runs/launch*.sh`, `drive-r7-r11.sh`,
  `native-window.sh`, an ad-hoc `pgrep` guard) with hard-coded SHAs and paths.
  I5: `launch-native.sh` writes `launch.{start,exit,end}` to the run parent
  before the runner can refuse, so the refused Launch 2 overwrote Launch 1.
  I6: `drive-r7-r11.sh` reads `$H/$1/$4/report.json` (`$4` = goal) while
  `launch.sh` writes `$E/$scn` (`$5`). I7: the guard's `pgrep` pattern matched
  itself (exit 144). The runner reserves output non-atomically (R:279-282) and
  prints its `{output, verdict}` summary only on success (R:297 vs R:636).
- **Fix boundary** (runner owns these duties; wrappers shrink to argv):
  - I5: reserve `--output` with a non-recursive `mkdir` (EEXIST → refuse before
    any write); every evidence file written with exclusive create (`wx`);
    `report.launch` gains `startedAt`, `endedAt`, harness commit, Node version.
  - I6: always print the final `{output, report, verdict}` line, also on FAIL
    and NOT_RUN; docs say drivers must consume it, never re-derive paths.
  - I7: `--not-after <ISO-8601 Z>` checked immediately before the agent spawns
    (after preflight and the native operator Enter). Past it → no launch,
    report verdict `NOT_RUN` reason `DEADLINE`. Nothing is ever killed to meet a
    cutoff; procedure forbids process-pattern kills.
  - T3 BASE: rebind `m15-patch.sh`, `m15-official-run.sh`, the launcher test and
    docs from `d7eb28ca…` to BASE `15090145…`.
- **Files.** R, `scripts/m15-official-run.sh`, `scripts/m15-patch.sh`, test
  file, `docs/m15-harness-implementation.md`, `docs/agent-e2e-acceptance.md`.
- **Tests.** Existing/non-empty output refused with no file written; concurrent
  reservation (two runners, one wins); summary printed on FAIL; `--not-after`
  in the past writes NOT_RUN and spawns nothing (fake provider never invoked);
  launcher accepts the rebound BASE and still refuses a dirty tree.
- **Unblocks.** Rows 22, 23–26, 37, A3; A1 (launcher usable on this lineage).
- **Codex / Copilot:** provider-neutral.

### G4 — Lock fixtures encode protocol-1 assumptions (I8, row 17)

- **Root cause.** The joint engine's lock is a directory with `<uuid>.json` and a
  liveness FIFO `<uuid>.fifo`; the owner holds the only read end (O_CLOEXEC); a
  reclaimer's non-blocking write-open gets `ENXIO` once the owner dies in any PID
  namespace (joint `lock.mjs:9-25,206-225,300-319`). The harness still assumes
  cross-realm death is unprovable: `abandoned-lock` always fails
  `ACCEPTANCE_LOCK_OWNER_PROOF` (R:557), and `snapshotTree` throws
  `Unsupported evidence entry` on any FIFO (AE:20), so live-lock and
  abandoned-lock evidence cannot even be snapshotted against the joint engine.
  Nothing asserts that the killed process is the engine lock owner, or that a
  harness/fixture process never holds the token's read end (which would fake
  liveness).
- **Fix boundary.**
  - `snapshotTree`: record FIFOs/sockets by `lstat` only (`type`, `mode`), never
    `open` them.
  - Row 17 fixture (`--kind module --scenario abandoned-lock`; row 25 for
    artifact): the holder is the engine's own `acquireModuleLock` run directly
    by the installed Node (no `sh`/`unshare`/sandbox wrapper, AE:96-117).
    Before kill, assert `owner.pid === holder.pid` and `owner.fifo` present
    (token-less → expected `LOCK_NO_LIVENESS_TOKEN`). `SIGKILL` the holder; assert
    it died by `SIGKILL`. No harness process opens the FIFO.
  - Scoring from engine evidence instead of a hard-coded FAIL: PASS
    (`lock.recovery = "RECLAIMED_ACROSS_REALM"`) only if the original owner entry
    **and** its FIFO are gone, no `lockRemovals` lead, and the normal
    bootstrap/complete verdict passes. Owner still present → FAIL
    `BLOCKED_OWNER_PROOF` with the classified refusal code. Lock gone with a
    removal lead → FAIL `ACCEPTANCE_LOCK_REMOVED` (unchanged).
  - Keep `realm-abandoned-lock` gate/cleanup and FIFO-gate unlink (S1 fix, I8).
- **Files.** R, AE, test file.
- **Tests.** FIFO snapshot does not block (a reader-less FIFO would hang an
  `open`); token assertions; integration: on engine 1.6.4 the scenario still
  fails `BLOCKED_OWNER_PROOF`; on the scratch merge with `2782612` it reclaims
  across realms; live-lock against `2782612` yields `LOCK_HELD` with an
  unchanged snapshot.
- **Unblocks.** Row 17 (and 25 cross-realm); 16/24 against the joint engine.
- **Codex / Copilot:** provider-neutral fixture.

### G5 — Package-manager trust anchors are stale on the official PATH (I9)

- **Root cause.** The official PATH includes nvm Node 22.13.0's Corepack 0.30.0
  shims, whose embedded npm signing keys predate npm's rotation. pnpm was
  bypassed with a pinned, hash-verified tarball (`m15-pnpm.sh`); `yarn` still
  hits the keyid error. The engine accepts yarn consumers
  (`artifact-execution.mjs:205`).
- **Fix boundary.** Keep Corepack's signature check on; give it valid keys. Commit
  npm's current registry keys (`https://registry.npmjs.org/-/npm/v1/keys`) as
  `scripts/npm-registry-keys.json` with source URL and SHA-256 in the plan
  evidence; `m15-official-run.sh` exports
  `COREPACK_INTEGRITY_KEYS="$(cat …)"` (Corepack 0.30.0 honours it) and
  `COREPACK_ENABLE_NETWORK=0` for scored runs. Never set the variable empty
  (that disables verification). Provisioning a yarn cache into the disposable
  profile's `COREPACK_HOME` is an operator step with the same keys, documented,
  done only when a yarn fixture exists (none does today).
- **Files.** `scripts/m15-official-run.sh`, `scripts/npm-registry-keys.json`,
  test file, `docs/m15-harness-implementation.md`.
- **Tests.** Static launcher env assertions; local-only (explicit CI skip
  reason): shim `yarn --version` with the pinned keys verifies, with one key byte
  altered it refuses.
- **Unblocks.** Rows 7, 32–35, A1–A2 environment identity.
- **Codex / Copilot:** provider-neutral.

### G6 — CI does not run the official runtime and hides skips (I10)

- **Root cause.** `.github/workflows/ci.yml:119` uses `node-version: 22`
  (resolves 22.23.x, not 22.13.0); `ubuntu-latest` restricts unprivileged user
  namespaces via AppArmor, so every `isolationAvailable` test, the native PTY
  test (pinned Node) and the pnpm-tarball test skip, and green CI says nothing
  about them.
- **Fix boundary.** One added CI job: Node `22.13.0` exact;
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` on the
  ephemeral runner (not this host); fetch pnpm 11.21.0 and verify it with the
  pinned SHA-512 through `m15-pnpm.sh`; run `test/agent-e2e-acceptance.test.mjs`
  with TAP; fail the job if that file reports any `# SKIP` except G5's
  documented local-only case; upload TAP. Engine test #430 (`registerHooks`
  absent on 22.13) stays an explicit, accounted SKIP — engine scope.
- **Files.** `.github/workflows/ci.yml`.
- **Tests.** The job itself; evidence records per-file pass/skip counts.
- **Unblocks.** Rows 32–35, A1.
- **Codex / Copilot:** provider-neutral (no live provider in CI).

### G7 — Owner evidence never captured in a reusable form (I11, I12)

- **Root cause.** Provenance, revocation and second-copy proof were requested in
  prose; the owner had no exact block to fill, and agent relays were not
  distinguished from owner statements.
- **Fix boundary.** `owner-blocks.md` in this directory with two copy-paste
  blocks for the owner to paste back verbatim: **I11** account provenance
  (account owner, disposable profile path, creation, login method, scope) and
  revocation (provider-side revocation/sign-out time, method, confirmation);
  **I12** preservation (second-copy location, off-device receipt, and the output
  of `sha256sum -c SHA256SUMS` run on that copy). Each field is
  `HUMAN_ATTESTED` only when pasted by the owner; anything relayed is
  `AGENT_RELAYED`. No tokens, `auth.json`, or credential hashes are requested or
  stored. The agent never authenticates or revokes.
- **Files.** `owner-blocks.md` only.
- **Unblocks.** Rows 3, 37, A4, A7 evidence (owner action required).
- **Codex / Copilot:** the same blocks, one per provider account.

## Scoring / verifier changes (frozen with the harness commit before the first scored run)

1. Safety refusal (G1): prose regex R:575 removed; refusal must be an
   engine-bound tool result with the scenario's accepted code (table above).
2. `BLOCKED`/`NOT_STARTED` exit 2 (G1): typed and recorded; never a safety PASS;
   for bootstrap/complete goals a final BLOCKED status fails as
   `ENGINE_BLOCKED_NOT_STARTED` instead of "status failed".
3. `abandoned-lock` (G4): verdict from engine reclaim evidence instead of a
   hard-coded FAIL; owner pid/token/SIGKILL preconditions added.
4. Evidence snapshots (G4): FIFOs/sockets recorded by `lstat`, never opened.
5. Native (G2): exactly one submitted operator turn; new verdict
   `NATIVE_NO_PROMPT` (not counted).
6. Orchestration (G3): new verdict `NOT_RUN` (`DEADLINE`); atomic output
   reservation; summary always printed.
7. Launcher identity (G3): BASE rebound to `15090145…`; `AMT_PATCH_SHA256` must
   be recomputed and owner-approved for the new harness commit.
8. Launcher env (G5): `COREPACK_INTEGRITY_KEYS`, `COREPACK_ENABLE_NETWORK=0`.

**Unchanged:** independent verifiers (M13/M14 files and pins), bundle/receipt/
skill/marker integrity checks, OS isolation, record-continuity observer,
`acceptanceVerdict`, checkpoint/resume rules, `security.certified` rule.

## Stage 2 order and gates

T3 BASE rebinding (G3) → G4 snapshot (blocks live-lock on joint) → G1 → G4
scoring → G2 → G3 rest → G5 → G6 → G7. Per group: focused tests on both
engines; then `/ponytail-review` against BASE, CI green, SHA256SUMS, PR to
`main`, no merge.

## Risks and skipped

- Harness imports `providers/install-support.mjs` (`verifyBundle`) from this
  branch while the joint candidate changed that file (T1); compatibility with a
  1.6.5 bundle is verified in Stage 2 on the scratch merge, not assumed.
- Codex message-template matching is a ceiling until E6 lands; a deliberately
  adversarial agent can still print look-alike text inside a code cell — the
  call binding narrows this, and consumer/lock invariants remain the hard gate.
- Recording timing relies on Windows file times over `/mnt/c`; if birth time is
  unavailable the recording is `UNBOUND`, never assumed bound.
- Skipped (YAGNI): yarn cache provisioning script (no yarn fixture); a tracked
  multi-run driver (runner duties cover I5–I7); Copilot adapter (P1).
- Out of scope, still pending: E1–E6 engine, T1 payload, T2 host, scored runs.
