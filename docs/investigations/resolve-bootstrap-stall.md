# RESOLVE bootstrap stall on native Windows

Status: **IMPLEMENTED_NOT_CERTIFIED**

| | |
| --- | --- |
| Base (frozen) | `4ab6f2adbcb86b188225adcf0108dcaac7f6ba9d` (v1.6.1 candidate) |
| Review SHA | `40122de6733671e7b712b2378a41866badf49869` (branch `fix/resolve-bootstrap-stall`) |
| Fix commits | `fd812b0ecf6bd47191dd117d95c45336605a69af` (stall), `40122de6733671e7b712b2378a41866badf49869` (recovery of the stall's leftovers) |
| Symptom build | installed v1.6.0 `d54352939b0172afb0b2295ed33b65798eefd65e`, Windows 11, Node 26.10.0, Git Bash |
| Workspace | `wms-milla7` monorepo: legacy `app-wms` (336 tracked files), target `app-wms-v2`, module `users` unregistered |

## Root cause

`mkdirDurably` (`packages/migration-engine/src/store/files.mjs:36-43` at the
base) walks up from the requested directory until it meets the first directory
`mkdir({ recursive: true })` reported creating:

```js
const first = await mkdir(directory, { recursive: true });
for (let created = path.resolve(directory); ; created = path.dirname(created)) {
  await syncDirectory(path.dirname(created));
  if (created === path.resolve(first)) return;   // files.mjs:41
}
```

Node on Windows reports `first` in its namespaced spelling,
`\\?\C:\Users\...` (`\\?\UNC\...` for a share), for every path length and on
every version tested: 22.13.0, 24.11.0, 26.2.0, 26.10.0. The plain walk never
equals it and reaches the drive root, where `path.dirname("C:\\")` is a fixed
point. `syncDirectory` returns immediately on win32, so the loop is a pure
microtask spin. It never yields to the event loop, prints nothing, and burns
one core forever. No timer, signal handler, or test timeout inside the process
can stop it.

The first directory a Windows bootstrap creates through `mkdirDurably` hangs:

- on a fresh target, `locks/`, when the module lock is taken (`lifecycle/lock.mjs:202`);
- otherwise, the staged record root `modules/.<module>.<tx>.init`, right after the
  init journal is written. This is what happened in `wms-milla7`, where `locks/`
  and `init/` already existed from earlier migrations.

**It was not the preview.** The preview, including the format-21 API-contract
scan, finished in about 7 s. `--mode auto` self-confirms and executes in the
same process. The agent ran the command as
`... --openspec-proposal-stdin < users-spec.md 2>&1 | tail -40`, and `tail`
prints nothing until its input closes. "Preview silent for >2 min" was really
"execution never returned".

Introduced by `29b22f5` (2026-10-14, "One store replace-write and one durable
append (DR7, DR8)"), shipped in v1.5.0, present unchanged in v1.6.0 and
4ab6f2ad.

### Second defect, found during verification

Every run that hit the hang leaves an initialization journal, a stale lock and
an empty staged root for a module that is **not yet registered** and has no
`state.json`. Status and the preview prescribe "rerun the bootstrap so the
engine recovers it". The rerun then refuses with
`Module 'users' is not registered. Supply --target <target-module>.` even when
`--target users` is supplied. `recoverMigrationRecord`
(`lifecycle/context.mjs:32` at the base) destructured only
`{ registryPath, moduleName }` and dropped `targetOverride`/`legacy` before
`readContext`. An interrupted first bootstrap was therefore unrecoverable
without manual cleanup. This is a latent bug since DR13 (`c8aec36`), whose
tests only use the registered module `auth`. With the operator's agreement it
is fixed on the same branch as a separate commit.

## Why certification and CI missed it

1. **Platform.** v1.6.0 was certified on Linux/WSL2 only (work-orders). On POSIX,
   `mkdir` reports a plain absolute path, so the walk matches.
2. **CI is Ubuntu-only** (Node 22). Windows CI was made advisory in `4efc00a` and
   later dropped.
3. **The one test that creates a new directory chain through `mkdirDurably`**
   ("DR7: a write into new directories ...") is `{ skip: !POSIX }`.
4. **No Windows bootstrap has run since v1.5.0** on this machine. The last one,
   `roles` (2026-10-06), predates `29b22f5`.
5. The live symptom was blamed on the newest RESOLVE change (the format-21 scan),
   because the agent's `| tail -40` swallowed the preview and the self-confirm
   line that would have shown execution had started.

## Phase 1: historical diff

| Area | v1.3.5 → v1.5.0 | v1.5.0 → v1.6.0 | v1.6.0 (`d543529`) → `4ab6f2a` |
| --- | --- | --- | --- |
| RESOLVE preview / OpenSpec bootstrap | Monolith `resumable-migration.mjs` split into `lifecycle/preview.mjs`, `bootstrap.mjs`, `openspec.mjs` (`7dac990`, Track A8) | `0fb914a` self-correcting fresh-module refusals, `9ec0550` `--target` kept through the handoff, `3ca711e` review findings, `3e7c857` API contract at RESOLVE (`preview.mjs:177,193`, `bootstrap.mjs:746`), `2e728ef` reopen discovery | none |
| API-contract scan | absent | `3e7c857`: `census/api.mjs` (+663), `openspec.mjs` `implicitApiContract` / `assertNewOpenSpecCoversApiContract`, scan algorithm 5 | none |
| `runDiscoveryScan` root selection / exclusions | Census extracted (`7b48165`, A5); `implicitModuleRoots` (`5660ce9`, I3/DR28, `census/boundary.mjs:147`). Exclusions unchanged: `git ls-files --cached --others --exclude-standard` | `3e7c857` (+4 in `boundary.mjs`, +10/−5 in `scan.mjs`) | none |
| CLI stdin transport | Moved `cli/discover-module.mjs` → `transport/discover.mjs` (`0a87bbc`, A7). The `for await (process.stdin)` block is byte-identical to v1.3.5 | `transport/discover.mjs` +9/−4, no change to the stdin read | none |
| Durable storage / Windows path handling | `store/files.mjs` extracted (`21e9e48`, A1); **`mkdirDurably` introduced, `29b22f5` (DR7/DR8)**, replacing plain `mkdir(..., { recursive: true })` (v1.3.5 `module-lock.mjs:98`) at 21 call sites; `dirtyManifest` realpath (`5bd2050`, pre-v1.3.5) | none | none |
| Recovery | DR13 init-journal recovery added to `recoverMigrationRecord` (`c8aec36`) without the target options | none | none |

`d543529..4ab6f2a` touches only `visual/capture.mjs`, its test and release
identity files. The original local implementation
(`C:\Users\icordoba\Desktop\start-migration`) never reads `mkdir`'s return
value and has no stdin proposal path.

## Phase 2: reproduction (native Windows, outside app-wms)

**Fixture.** A `git archive` of `wms-milla7` HEAD (`b9be1e0`) into a temp dir
with the same layout: one monorepo git holding `app-wms` (336 tracked, 299
scripts, depth ≤ 9, 0 tracked symlinks, the same empty leftover `app-wms/.git`),
`app-wms-v2` with its registry (`auth`/`roles` registered, `users` not), and an
ignored `node_modules` junction to the real pnpm install. It uses the agent's
own proposal (8 requirements / 19 scenarios, sha256 `b59a8bcd...`). app-wms
was only read.

**Experiment (a): stdin forms × modes, 3 runs each, 45 s hard timeout, fresh fixture per run.**

| Engine | Mode | Git Bash `<` file (exact agent form) | Git Bash `cat \|` | PowerShell `Get-Content -Raw \|` |
| --- | --- | --- | --- | --- |
| d5435293 | step (preview only) | 3/3 exit 0, 13.4–15.0 s | 3/3 exit 0, 12.1–14.4 s | 3/3 exit 0, 13.6–15.3 s |
| d5435293 | auto | 3/3 **hang**, preview at 13.1–14.5 s | 3/3 **hang** | 3/3 **hang** |
| 4ab6f2ad | step | 3/3 exit 0, 15.2–17.2 s | 3/3 exit 0, 10.1–14.7 s | 3/3 exit 0, 9.1–12.0 s |
| 4ab6f2ad | auto | 3/3 **hang**, preview at 11.1–14.4 s | 3/3 **hang** | 3/3 **hang** |
| fix (installed bundle) | step | 3/3 exit 0, 8.1–9.1 s | 3/3 exit 0, 8.1–9.8 s | 3/3 exit 0, 8.7–9.4 s |
| fix (installed bundle) | auto | 3/3 exit 0 in 16.7–17.3 s, state + spec written | 3/3 exit 0, 16.2–20.1 s | 3/3 exit 0, 17.0–19.9 s |

Stdin EOF arrives in every form. Every auto hang shows the same thing: preview
printed with `Blockers: none`, then `Mode: auto — self-confirmed.`, no
`state.json`, no spec.

**Experiment (b): direct scan.** `implicitApiContract` steps called directly,
3 runs × 2 SHAs × {fixture, app-wms}. All runs resolve the root
`src/features/users` (the competing route directory
`src/app/(protected)/administration/users` is excluded by I3), visit 336 files
and find 12 census entries and 216 edges. They finish in 6.7–15.2 s under
load. Bounded; not the cause.

**Experiment (c): process at the stall.** The live stalled process in
`wms-milla7` (PID 67892) was inspected after 73 min. It had used 4253 s CPU in
4380 s wall (≈ 100 % of one core), had 0 children, and had written no staged
files. Its lock was taken 7 s after start, and its journal 5 s later. A JS
stack captured over the inspector (5/5 samples) was `mkdirDurably`
`store/files.mjs:40-41`, with
`first = \\?\C:\...\modules\.users.edcfc1dc-...init`. Every timed-out fixture
run above (18/18) shows the same frames, 0 children, and 141–170 % CPU, with
`first = \\?\...\migrations\locks`. The aftermath was also reproduced 3/3:
with pre-existing `locks/` and `init/`, v1.6.0 hangs at
`first = \\?\...\.users.<tx>.init` and leaves `init/users.journal` and
`locks/users.lock`, identical to wms-milla7.

Gate met: one cause, deterministic (36/36 hangs at the same frame, 0
exceptions), mapped to `store/files.mjs:41`.

## Phase 3: fix

`fd812b0`, `store/files.mjs`. Both sides of the comparison go through
`path.toNamespacedPath`, which is Node's own spelling of `first` on win32 and
the identity on POSIX. A walk that still reaches the filesystem root without
meeting `first` throws
`mkdir reported '<first>' as the first directory it created for '<dir>', which is not one of its ancestors; refusing instead of walking past the filesystem root (Node <v>, <platform>).`
The loop can no longer wait silently: it is bounded by the path depth and
fails closed if any other spelling mismatch ever appears. Validated on real
Windows for drive, forward-slash and `\\wsl.localhost` UNC paths.

`40122de`, `lifecycle/context.mjs`. `recoverMigrationRecord` passes the
operator's `targetOverride` and `legacy` to `readContext`, exactly as the
preview already did. The DR13 journal validation, owner checks and rollback are
untouched.

No provider tree embeds engine sources. `pnpm providers:sync` reports
"Synchronized 62 generated provider files" with no diff. No version bump.

## Test evidence (failing first)

| Test | Platform | On base (+test only) | With fix |
| --- | --- | --- | --- |
| `durable-storage.test.mjs` "DR7: mkdirDurably returns once a new chain exists on every platform, and refuses rather than spins on a first directory outside it" | Linux, Node 26.8.2 | ✖ 20.1 s, `mkdirDurably spun on a foreign first directory until the timeout` (`'SIGTERM' !== null`) | ✔ 93–166 ms |
| same | Windows, Node 26.10.0 | ✖ 20.1 s, `mkdirDurably spun on a new chain until the timeout`: the real `\\?\` case | ✔ 308–416 ms |
| `test/unregistered-module-bootstrap.test.mjs` "an interrupted first bootstrap of an unregistered module is recovered by rerunning it with --target" | Linux | ✖ `Module 'partners' is not registered. Supply --target <target-module>.` | ✔ 454 ms |
| same | Windows | ✖ same message | ✔ 2.5 s |

The first test runs each case in a child process under a 20 s timeout,
because on Windows the old loop starves the event loop of the test runner
itself.

**Touched suites in full on native Windows (Node 26.10.0):**

- At the review SHA, `test/unregistered-module-bootstrap.test.mjs` passes 3/3.
- At the review SHA, `durable-storage.test.mjs` runs 17 tests: 9 pass, 4 are skipped as POSIX-only, and 4 fail. All 4 failures are `EPERM: operation not permitted, symlink ...` in test setup, because this account cannot create symlinks.
- At the base, the same `durable-storage.test.mjs` never completes: the first new directory chain hangs the runner, which was killed at 120 s.

**Normal gates (Linux WSL2, Node 26.8.2), base vs review SHA: INCOMPLETE.**
Claude Code stopped the run because the host was critically low on memory.
This was not a test failure, and the run was not restarted automatically.

| Stage | Base `4ab6f2a` | Review `40122de` |
| --- | --- | --- |
| `engine:test` | 1171/1172. The 1 failure is pre-existing: "a no-op package script cannot claim validator coverage" | not run |
| `engine:test:ts` | pass | not run |
| `providers:test` | interrupted mid-run | not run |
| `providers:check` | n/a | pass (62 files synchronized) |

The rerun command is `bash gates.sh` from the evidence folder. It compares
per-stage failure lists, base vs head. Until it completes, "no new baseline
failures" is **unproven** for the full suites. The focused tests above, the two
touched suites on Windows, `rehearse` and the work-orders comparison are the
evidence in hand.

## Phase 4: verification

**Native Windows, clean install.** The bundle was built from the committed
review SHA (`release:build` + `release:verify`: `verified: true`, content hash
`sha256:2a1edad6...`, manifest pin `sha256:2a270cb7...`). It was installed with
`providers/claude/install.mjs install --scope project` into a fresh fixture with
a new isolated store, and the rendered skills were placed as `skills add` would.
The skill's sequence then ran 3/3: runtime preflight `OK`/`selection: skill`/
`network: false`, doctor `OK`, `run` BLOCKED (OpenSpec validly absent), then the
bootstrap in the exact agent form without `| tail`. Results for each run:

- bootstrap exit 0 in 24.3–26.8 s; preview output at 12.3–13.4 s;
- engine-written `modules/users/state.json`: `currentStep=DISCOVER_LEGACY`, revision 1, format 21, toolkit `40122de`;
- engine-written `openspec/specs/users/spec.md`, byte-identical to the proposal;
- no lock or journal left; `--status` reports `DISCOVER_LEGACY`.

The v1.6.0 aftermath (journal + stale lock + staged root) was recovered by the
engine itself on rerun, 3/3, reaching DISCOVER_LEGACY.

**app-wms/users** (the real workspace, with the operator's approval). The
`40122de` engine ran by path from its isolated store with cwd `wms-milla7`, the
form the stalled session used. The project's installed v1.6.0 skills and MCP
config were not changed. The orphan from the stalled run (copied to the
evidence folder first) was recovered by the engine. Preview output came at
16.6 s with `Blockers: none`, followed by self-confirmation.
`Wrote ...\app-wms-v2\...\modules\users\state.json`,
`Current step: DISCOVER_LEGACY`, exit 0 in 24.8 s. spec.md sha256 equals the
proposal; no lock, journal or staged root is left. The legacy app was only
read: HEAD `b9be1e0`, 0 dirty, and the same index and worktree hashes before
and after. PID 67892 had already exited before this run; it was not killed by
this investigation.

**Linux WSL2, work-orders.** Release bundles were built at base and review SHA.
The base content hash `sha256:7bc63385...` equals the certified candidate's.
Consumers came from the certification harness (`make-consumer.mjs`), with the
v1.6.0 certified run's work-orders OpenSpec. On both: preflight `OK`/
`network: false`, `run` BLOCKED, bootstrap exit 0 to `DISCOVER_LEGACY` with
identical normalized output, identical record file lists and an identical
spec. The state differs only in toolkit identity and in `steps/01-resolve.md`,
whose only differences are the consumer directory and its fresh git SHA.
`pnpm rehearse` (LLM-free installed lifecycle): base and review both
"20 steps match test/golden/installed-full-lifecycle.ndjson". The live-agent
work-orders certification was **not** rerun.

**Review.** `/ponytail-review` of `4ab6f2adbcb86b188225adcf0108dcaac7f6ba9d..40122de6733671e7b712b2378a41866badf49869`:
"Lean already. Ship." No findings.

## Not done / open

- Live-agent certification (Claude, Linux and Windows) of the review SHA. Hence `IMPLEMENTED_NOT_CERTIFIED`.
- Windows CI: the DR7 chain test and most of the engine suite have never run on Windows since DR7. Restoring a Windows lane would have caught this.
- Packaging note, unrelated to the fix: `release:build` from Git Bash fails, because GNU `tar` reads `C:` as a remote host. It works from PowerShell (`System32\tar.exe`).
- The skill could tell agents not to pipe engine output through `tail`/`head`, which hid where the run actually was.
- Evidence: `~/artifact-migration-acceptance/resolve-bootstrap-stall-fd812b0-20261019/` (WSL).
