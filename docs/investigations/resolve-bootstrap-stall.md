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

## Completion: gates, sweep, Windows tests, review (2026-10-19)

### Phase 1: base-vs-branch gates (Linux WSL2, Node 26.8.2)

`tests/gates.sh` ran to completion on both trees, one stage at a time, with
logs per stage (evidence: `tests/gates-complete-20261019/`). The earlier run
that stopped for host memory is kept beside it. `providers:test` runs at
`--test-concurrency=1` by its own script. `engine:test`'s identified pass has
no concurrency flag (Node refuses `--test-concurrency` in `NODE_OPTIONS`), so it
ran at its default. No OS or WSL memory setting was changed.

| Stage | Base `4ab6f2adbcb86b188225adcf0108dcaac7f6ba9d` | Branch `e4ec398d212460cb4b972ec2bbe9dd6b6b980809` | New failures |
| --- | --- | --- | --- |
| `engine:test`, unidentified pass | 35 pass / 0 fail / 0 skip | 35 / 0 / 0 | 0 |
| `engine:test`, identified pass | 1136 pass / 1 fail / 0 skip of 1137 | 1137 / 1 / 0 of 1138 (+1: the mkdirDurably test) | 0 |
| `engine:test:ts` (vitest) | 69/69 pass, 2 files | 69/69 pass, 2 files | 0 |
| `providers:test` | 197 pass / 0 fail / 1 skip of 198 | 198 / 0 / 1 of 199 (+1: the interrupted-bootstrap test) | 0 |
| `providers:check` | synchronized (62 files) | synchronized (62 files) | n/a |
| `architecture:check` | ok (130 engine files, 693 edges) | ok (130 engine files, 693 edges) | n/a |

The one failure on both sides is pre-existing and unchanged:
`artifact-migration.test.mjs:3249` "a no-op package script cannot claim
validator coverage" (`'pnpm run typecheck' exited 127` instead of the expected
`trusted validator evidence` message). The one skip on both sides is the
win32-only "Windows: ensure succeeds with Git GNU tar first on PATH".
**Gate met: the branch introduces zero new failures.** `1772fb2` (below) only
changes `durable-storage.test.mjs`: on Linux it still passes 17/17.

### Phase 2: path-comparison sweep (`packages/migration-engine/src`)

What each fs API returns on native Windows (Node 26.10.0), measured by
`windows/fs-spellings.mjs`: only `mkdir(…, { recursive: true })` returns the
`\\?\` namespaced spelling, and it keeps the input's case and 8.3 short names.
`realpath` returns the plain long-name spelling with the on-disk case.
`readdir({ recursive })`'s `parentPath`, `opendir().path` and `process.cwd()`
echo the caller's spelling. `path.win32.relative` compares case-insensitively.

| Site | Comparison | Verdict |
| --- | --- | --- |
| `store/files.mjs:37-50` `mkdirDurably` | `mkdir` result vs `path.resolve` walk | **affected → fixed in `fd812b0`**. Both sides go through `path.toNamespacedPath`, and the walk is bounded at the root. Verified on Windows for drive, forward-slash, lower-case, 8.3 short-name and `\\wsl.localhost` UNC inputs. Every `mkdirDurably` caller (lock, journals, staged roots, `writeTree`, `copyTree`, appends) routes through this one helper. |
| `lifecycle/capture.mjs:160-162` | `realpath(storageState)` vs `realpath(root)` via `path.relative` | safe: both sides are realpaths |
| `engine-paths.mjs:42-45` `isMainModule` | `path.resolve(argv[1])`, then `realpathSync(argv[1])`, vs the loader's realpath'd `import.meta.url` | safe: the fallback compares realpath to realpath |
| `lifecycle/prefill.mjs:311,336-339` | `cited` realpaths vs `path.join(realpath(root), git-relative path)` | safe: both bases are realpaths. A git index whose case differs from disk only counts an evidence file's mtime, so it fails closed. |
| `slices/claims.mjs:343-345` `isTargetFile` | lexical `isWithin`, then realpath vs realpath | safe |
| `slices/claims.mjs:356-359` `isLinkFree` | `realpath(resolved)` vs `path.join(realpath(targetRoot), relative(targetRoot, resolved))` | safe (fail-closed): a claim whose spelling differs from disk on Windows reads as "reached through a link" and is refused, never accepted. Not RESOLVE/bootstrap. |
| `slices/amendment.mjs:170-190` | realpath vs realpath, and lexical `isWithin` vs lexical | safe |
| `store/registry.mjs:145,194-195` | `canonical()` (realpath) of the git top level vs `canonical(project)` | safe |
| `shared/git.mjs:83,94` `dirtyManifest` | `realpath(root)` vs `realpath(git top level)` | safe (the earlier 8.3 fix) |
| `lifecycle/gates.mjs:261,276` | `realpath(resolved)` vs `repositoryRealpaths` | safe |
| `store/tree.mjs:35,89` | `readdir` `parentPath` vs `root` via `path.relative` | safe: `parentPath` echoes `root`'s spelling |
| `lifecycle/lock.mjs:85` | `readlinkSync("/proc/self/ns/pid")` | safe: Linux only, an identity string, not a path comparison |
| `lifecycle/lock.mjs:215`, `lifecycle/bootstrap.mjs:284` | non-recursive `mkdir`, result unused | safe |
| `process.cwd()` defaults (`migration-utils.mjs:113`, `store/registry.mjs:319`, `lifecycle/artifact-record.mjs:259`, `census/artifact.mjs:378-379`, `transport/run.mjs:196-199`, `lifecycle/artifact-checkpoints.mjs:1088,1136`, `transport/mcp.mjs:591`) | used as a root or restored, never compared with an fs-returned spelling | safe |

Out of the sweep's class, but noted: persisted lexical paths compared with a
fresh `path.resolve` (`lifecycle/journal.mjs:194,198`, `recorder.mjs:464`,
`operator-signer.mjs:232-301`, `decisions/policy.mjs:90`). Neither side comes
from fs. A rerun from a different spelling of the same directory is refused
with a message, never hung or accepted. No change.

**No affected site remains.** No new shared helper was needed: the one affected
comparison already lives in the one helper every caller uses.

### Phase 2: Windows tests

`1772fb2aaae7fddf9fc62826565102d237404139` (test only):

- "DR7: a write into new directories makes each new directory entry durable
  before it returns" now runs on every platform. Each write (`atomicWrite` into
  `a/b/c`, the module lock and first journal on a fresh target, `appendDurably`
  into `record/decisions`) must land and return. The fsync order stays asserted
  on POSIX only, because `syncDirectory` is a no-op on win32. On Windows
  (Node 26.10.0) with `4ab6f2ad`'s `files.mjs` it **times out at 60 s, and the
  runner is killed**. With the fix it **passes in 0.7 s** (`windows/win-newdir.log`).
- The four EPERM failures are classified as a **test-only limitation**:

  | Test (`durable-storage.test.mjs` at `e4ec398`) | Syscall | Call site |
  | --- | --- | --- |
  | DR7: atomicWrite refuses symlinks, traversal and a directory destination without mutation (`:133`) | `symlink` (`CreateSymbolicLinkW`), EPERM | `:140` |
  | DR7: writeJournalAtomic checks the whole path from the target root and refuses any symlink in it (`:190`) | `symlink`, EPERM | `:200` |
  | DR7: writeTree stages a flushed tree … stays inside its root (`:304`) | `symlink`, EPERM | `:335` |
  | DR8: appendDurably refuses symlinks, traversal and a directory ledger without mutation (`:448`) | `symlink`, EPERM | `:455` |

  Every EPERM comes from the test's own setup `fs.symlink`, which Windows
  refuses to an account without `SeCreateSymbolicLinkPrivilege` or Developer
  Mode. `src/` contains no `symlink` call. The product guard still holds on
  Windows: against a junction, the reparse point such an account *can* create,
  `atomicWrite`, `appendDurably` and `writeTree` all refuse with `Refusing
  symlink output path` and leave the outside file untouched
  (`windows/junction.log`). Not a product defect. Only those four tests are
  skipped on win32, each with the reason as its skip message.
- `durable-storage.test.mjs` on Windows at `1772fb2`: 10 pass, 0 fail, 7 skip
  (4 symlink setup, 3 pre-existing POSIX-only). Linux: 17/17.

**Full engine suite on native Windows: INCOMPLETE (memory stop).** It ran at
`1772fb2` in the Windows clone, through `windows/engine-test-lowpar.mjs`. That
is `scripts/engine-test.mjs`'s two passes, with the same file list, scratch
root and fixture identity, at `--test-concurrency=2`. The runner takes no flags,
Node refuses the flag in `NODE_OPTIONS`, and its default here would be 21
workers. Claude Code's memory guard stopped it during the identified pass: the
host had about 3 GB free of 31.4 GB while the WSL2 VM held most of the rest. No
OS or WSL memory setting was changed. Up to the stop:

- unidentified pass (`toolkit-identity`, `format-17-acceptance`): **35/35 pass**;
- identified pass, partial: **172 ✔, 42 ✖**. The ✖ cluster in the
  operator-decision suites: the per-provider relay matrix, the
  conversational APPROVE/REJECT relay over MCP and CLI (each about 20 s, a
  timeout path), terminal APPROVE/REJECT, and canonical/protected policy. The
  runner prints failure details only in its final summary, which the stop
  preempted, so these are **unclassified**. They cannot be compared with base on
  Windows, because base hangs at the first new directory chain.
- **No hang**: the suite progressed for its whole run, and no test process was
  left behind.

Log: `windows/win-engine-test-partial.log`.

### Phase 3: review

Frozen SHAs:

- base `4ab6f2adbcb86b188225adcf0108dcaac7f6ba9d`
- reviewed HEAD `1772fb2aaae7fddf9fc62826565102d237404139` (code and tests); this
  document's commit on top is docs only.

`/ponytail-review` over the full range covers `fd812b0`, `40122de` (recovery
honors `--target`/`--legacy`), `e4ec398` and `1772fb2`: **no findings, "Lean
already. Ship."** (`tests/ponytail-review-1772fb2.txt`). It is an AI review by
Claude Opus 5.5, the same model family that authored the change. It is
therefore not the independent reviewer that `docs/release.md`'s
owner-maintained rule asks for where a sign-off row applies. No sign-off row
names this change class (engine store/lifecycle code outside the format and
approval boundaries), and the owner's own acceptance is still recorded at merge.

### Status reached

**BLOCKED_WINDOWS_SUITE_INCOMPLETE** (still `IMPLEMENTED_NOT_CERTIFIED`).

| Phase | Result |
| --- | --- |
| 1. Gates (Linux) | **PASS**: zero new failures |
| 2. Sweep | **PASS**: one affected site, fixed in `fd812b0`; no other |
| 2. Windows new-directory test | **PASS**: active on Windows, times out before the fix, passes after it (`1772fb2`) |
| 2. EPERM classification | **test-only**: 4 tests skipped on win32, with the reason |
| 2. Full Windows engine suite | **INCOMPLETE**: memory stop; 42 unclassified ✖ so far; no hang |
| 3. Review | **no findings** on `1772fb2aaae7fddf9fc62826565102d237404139` |
| 4. CI and live certification | not started: the branch is not pushed, and no PR or CI run exists |
| 5. Release | not started; v1.6.0 is unchanged |

Blocker: the full Windows run hit the memory stop, and Claude Code's guard does
not restart it unattended. To resume, free host memory (for example
`wsl --shutdown` after saving WSL work, which is not a settings change) and
rerun `node windows/engine-test-lowpar.mjs <clone> 1 180`. Then classify the
operator-decision failures. Any that is a product defect reachable in a real
Windows migration is outside RESOLVE/bootstrap/store path handling and becomes
a separate task.

## Resume: Windows suite, file by file (2026-10-20)

Frozen: base `4ab6f2adbcb86b188225adcf0108dcaac7f6ba9d`, reviewed
`1772fb2aaae7fddf9fc62826565102d237404139`, HEAD
`da3a024e87c462159c5987efa120f63d05cda9d6` (docs only on top of reviewed).

### Phase 1 gates at HEAD (Linux WSL2, Node 26.8.2)

The reused gate logs (`tests/gates-complete-20261019/`) name no SHA of their
own. Only their README says `e4ec398`, so they cannot prove the tree they ran.
`pnpm engine:test` was rerun at HEAD with a clean tree before and after
(`tests/head-da3a024/linux-engine-test.{sh,meta,log,failures}`). It took 969 s:
unidentified pass 35/35, identified pass 1137/1138. The one failure is the
pre-existing `artifact-migration.test.mjs:3249` "a no-op package script cannot
claim validator coverage", the same as on base. **No new failures.**

### Native Windows per file (Node 26.10.0): INCOMPLETE, 30 of 38 files

Clone: `%TEMP%\rbs\thead` at `da3a024`, clean, `pnpm install --frozen-lockfile --offline`.
Runner: `windows/engine-test-perfile.mjs`. It keeps `scripts/engine-test.mjs`'s
file list, scratch root (`withTestRoot`), pass order, fixture identity, cwd and
env. Each file runs alone as `node --test --test-concurrency=1 <file>`.
Logs: `windows/perfile-head-da3a024/` (`results.json`, one log per file) and
`windows/perfile-head-da3a024.summary.log`.

| File | Result | tests / pass / fail / skip |
| --- | --- | --- |
| external/format-17-acceptance | pass | 16 / 16 / 0 / 0 |
| unit/toolkit-identity | pass | 19 / 19 / 0 / 0 |
| integration/direct-ledger-defaults | **fail** | 13 / 0 / 13 / 0 |
| external/bin-mappings | pass | 3 / 2 / 0 / 1 |
| external/visual-authority-proof | pass | 2 / 2 / 0 / 0 |
| external/engine-paths | pass | 35 / 35 / 0 / 0 |
| integration/artifact-delegation | pass | 18 / 18 / 0 / 0 |
| integration/inline-approval | **fail** | 4 / 3 / 1 / 0 |
| integration/operator-approval-authority | **fail** | 16 / 14 / 2 / 0 |
| unit/artifact-migration | **fail** | 127 / 116 / 10 / 1 |
| unit/auto-authority | pass | 8 / 8 / 0 / 0 |
| unit/v5-contract-parity | pass | 1 / 1 / 0 / 0 |
| unit/discovery-scan | pass | 55 / 55 / 0 / 0 |
| unit/api-contract | pass | 6 / 6 / 0 / 0 |
| integration/api-response-contract | pass | 3 / 3 / 0 / 0 |
| unit/evidence-provenance | pass | 3 / 3 / 0 / 0 |
| unit/format-upgrades | pass | 14 / 14 / 0 / 0 |
| unit/mcp-server | **fail** | 39 / 38 / 1 / 0 |
| unit/content-identity | pass | 6 / 6 / 0 / 0 |
| unit/store-shared | **fail** | 15 / 10 / 5 / 0 |
| unit/durable-storage | pass | 17 / 10 / 0 / 7 |
| unit/formats | pass | 10 / 10 / 0 / 0 |
| unit/decisions | pass | 12 / 12 / 0 / 0 |
| unit/slices | **fail** | 12 / 9 / 2 / 1 |
| unit/census | pass | 10 / 10 / 0 / 0 |
| unit/visual | pass | 11 / 11 / 0 / 0 |
| unit/transport | pass | 9 / 8 / 0 / 1 |
| unit/lifecycle | pass | 9 / 9 / 0 / 0 |
| unit/legacy-runtime-authority | pass | 11 / 11 / 0 / 0 |
| unit/live-history-replay | pass | 2 / 2 / 0 / 0 |
| unit/migration-contract | **killed** (memory) | partial |
| migration-policy, record-decision, registry-resolution, visual-evidence, run-migration, operator-webauthn, operator-signer.integration | not run | |

No file hung, and none timed out (30 min per file).

**Memory stop.** Host free memory was 3.1 GB at the start and fell to 0.6 GB
during the run. Claude Code then killed the run for low system memory during
`migration-contract`. Free memory was 0.7 GB afterwards, with the runner gone.
The WSL2 VM held about 12 GB. `wsl --shutdown` was **not** run, because WSL has
active work: Docker containers (Keycloak, Quarkus services, MongoDB), the VS Code
server, and a second Claude Code session on the host. No setting was changed.

**First reading of the 34 HEAD failures (tentative, not yet compared with the baseline):**

- 27 fail with `EPERM: operation not permitted, fsync` at `store/files.mjs:25`
  (`syncDirectory` ← `mkdirDurably` ← `acquireModuleLock`). Every one runs
  inside the test fixture `withDecisionPolicy`
  (`test/support/decision-policy-fixture.mjs:31`). That fixture overrides
  `process.platform` with `"linux"` to fake the protected policy directory
  `/etc/artifact-migration-tools`, which defeats `syncDirectory`'s win32 skip
  (`files.mjs:22`). The fsync of a directory is then attempted on Windows.
  Candidate category 1 (test-environment assumption). Outside that fixture, the
  same path passes on Windows (`durable-storage`, `lifecycle`,
  `unregistered-module-bootstrap`, the live bootstrap runs above).
- 6 fail with `EPERM ... symlink` in test setup (`store-shared` ×4, `slices` ×2):
  candidate category 1, the same class as the four `durable-storage` symlink tests.
- 2 `artifact-migration` signer tests fail with `UNPROTECTED_SIGNER_STORE ...
  mode 0700/0600`: the operator-signer store check is POSIX owner/mode,
  fail-closed. Unclassified. The signer is not on the RESOLVE → OpenSpec →
  DISCOVER_LEGACY path.
- 1 `store-shared` "DR1 one containment rule ... posix and win32" fails with
  `Error: cwd gone`. Unclassified.

### Phase B baseline: prepared, not run

`%TEMP%\rbs\tbaseline` is a worktree of the Windows clone at base with
`git cherry-pick -n fd812b0`, staged and uncommitted, with deps installed. It
has not run yet: Phase B needs the same memory.

### Status reached

**BLOCKED_WINDOWS_SUITE_INCOMPLETE** (still `IMPLEMENTED_NOT_CERTIFIED`).
The memory stop recurred at concurrency 1, and WSL has active work that rules out
`wsl --shutdown`. Phases B–D are not started. Nothing was pushed. v1.6.0 is
unchanged.

To resume, free host memory (stop the WSL Docker stack and other sessions, then
`wsl --shutdown`), and run the remaining 8 files plus the baseline:
`node windows/engine-test-perfile.mjs <clone> 30 <outDir> [file suffix ...]`.

## Resume 2: Windows classification under the memory rule (2026-10-20)

Frozen: base `4ab6f2adbcb86b188225adcf0108dcaac7f6ba9d`, reviewed
`1772fb2aaae7fddf9fc62826565102d237404139`, HEAD
`f39e8bb4a40db1e795918ea0bd36cdc2ee58271a`. `da3a024..f39e8bb` is docs only,
so the 30 files run at `da3a024` ran the HEAD code.

**Memory rule.** Before each Windows file the runner reads `os.freemem()`. Below
4 GiB (`4 × 2^30` bytes) the file is not started and is recorded
`NOT_RUN_WINDOWS (memory)` with the measured value; a skipped or killed file is
never retried. `migration-contract` runs last. Docker, the VS Code server, the
other Claude Code session and WSL were left running. The gate is in
`windows/engine-test-perfile.mjs`.

### Phase A: the 38-file HEAD table (native Windows, Node 26.10.0)

Clone `%TEMP%\rbs\thead`, checked out at `f39e8bb`, clean. Logs:
`windows/perfile-head-da3a024/` (the first 30 files) and
`windows/perfile-head-f39e8bb{,.summary.log}` (the last 8).

| # | File | Result | tests / pass / fail / skip |
| --- | --- | --- | --- |
| 1 | external/format-17-acceptance | PASS | 16 / 16 / 0 / 0 |
| 2 | unit/toolkit-identity | PASS | 19 / 19 / 0 / 0 |
| 3 | integration/direct-ledger-defaults | **FAIL 13** | 13 / 0 / 13 / 0 |
| 4 | external/bin-mappings | PASS | 3 / 2 / 0 / 1 |
| 5 | external/visual-authority-proof | PASS | 2 / 2 / 0 / 0 |
| 6 | external/engine-paths | PASS | 35 / 35 / 0 / 0 |
| 7 | integration/artifact-delegation | PASS | 18 / 18 / 0 / 0 |
| 8 | integration/inline-approval | **FAIL 1** | 4 / 3 / 1 / 0 |
| 9 | integration/operator-approval-authority | **FAIL 2** | 16 / 14 / 2 / 0 |
| 10 | unit/artifact-migration | **FAIL 10** | 127 / 116 / 10 / 1 |
| 11 | unit/auto-authority | PASS | 8 / 8 / 0 / 0 |
| 12 | unit/v5-contract-parity | PASS | 1 / 1 / 0 / 0 |
| 13 | unit/discovery-scan | PASS | 55 / 55 / 0 / 0 |
| 14 | unit/api-contract | PASS | 6 / 6 / 0 / 0 |
| 15 | integration/api-response-contract | PASS | 3 / 3 / 0 / 0 |
| 16 | unit/evidence-provenance | PASS | 3 / 3 / 0 / 0 |
| 17 | unit/format-upgrades | PASS | 14 / 14 / 0 / 0 |
| 18 | unit/mcp-server | **FAIL 1** | 39 / 38 / 1 / 0 |
| 19 | unit/content-identity | PASS | 6 / 6 / 0 / 0 |
| 20 | unit/store-shared | **FAIL 5** | 15 / 10 / 5 / 0 |
| 21 | unit/durable-storage | PASS | 17 / 10 / 0 / 7 |
| 22 | unit/formats | PASS | 10 / 10 / 0 / 0 |
| 23 | unit/decisions | PASS | 12 / 12 / 0 / 0 |
| 24 | unit/slices | **FAIL 2** | 12 / 9 / 2 / 1 |
| 25 | unit/census | PASS | 10 / 10 / 0 / 0 |
| 26 | unit/visual | PASS | 11 / 11 / 0 / 0 |
| 27 | unit/transport | PASS | 9 / 8 / 0 / 1 |
| 28 | unit/lifecycle | PASS | 9 / 9 / 0 / 0 |
| 29 | unit/legacy-runtime-authority | PASS | 11 / 11 / 0 / 0 |
| 30 | unit/live-history-replay | PASS | 2 / 2 / 0 / 0 |
| 31 | unit/migration-policy | NOT_RUN_WINDOWS (memory), 2.0 GiB (2112016384 B) | |
| 32 | unit/record-decision | NOT_RUN_WINDOWS (memory), 2.0 GiB (2112008192 B) | |
| 33 | unit/registry-resolution | NOT_RUN_WINDOWS (memory), 2.0 GiB (2111807488 B) | |
| 34 | unit/visual-evidence | NOT_RUN_WINDOWS (memory), 2.0 GiB (2111950848 B) | |
| 35 | unit/run-migration | NOT_RUN_WINDOWS (memory), 2.0 GiB (2111950848 B) | |
| 36 | unit/operator-webauthn | NOT_RUN_WINDOWS (memory), 2.0 GiB (2111954944 B) | |
| 37 | integration/operator-signer.integration | NOT_RUN_WINDOWS (memory), 2.0 GiB (2111954944 B) | |
| 38 | unit/migration-contract | NOT_RUN_WINDOWS (memory), 2.0 GiB (2111959040 B); killed mid-run at `da3a024`, not retried | |

Totals: 22 files PASS, 7 FAIL (34 failing tests), 8 NOT_RUN_WINDOWS (memory),
one of which (`migration-contract`) had been killed earlier. No file hung or
timed out. The first reading's "27 fsync" was a miscount: the logs show 25.

### Phase B: baseline comparison

Baseline `%TEMP%\rbs\tbaseline`: base plus `git cherry-pick -n fd812b0`
(`store/files.mjs` and its test, staged), since plain base hangs at the first new
directory chain. Logs: `windows/perfile-baseline-4ab6f2a+fd812b0{,.summary.log}`.

| File | Baseline result |
| --- | --- |
| integration/direct-ledger-defaults | **FAIL 13/13**: the same 13 tests, the same `EPERM ... fsync` at the same frames (`files.mjs:25` ← `files.mjs:44` ← `lock.mjs:202`, inside `withDecisionPolicy`); 4.2 GiB free before |
| integration/inline-approval, integration/operator-approval-authority, unit/artifact-migration, unit/mcp-server, unit/store-shared, unit/slices | NOT_RUN_WINDOWS (memory), 3.8 GiB (4131635200 / 4131508224 B) < 4 GiB |

The branch changes only two `src` files against base: `store/files.mjs`
(`fd812b0`, also in the baseline) and `lifecycle/context.mjs` (`40122de`,
`recoverMigrationRecord`). No failing stack passes through `context.mjs`, and the
branch changes none of the failing tests or fixtures.

### Classification of the 34 HEAD failures

| Tests | file:line (test) | Error | Cause | Category | Baseline |
| --- | --- | --- | --- | --- | --- |
| 13 direct-ledger-defaults | `direct-ledger-defaults.integration.spec.mjs:41,153,215,259,318,353` | `EPERM: operation not permitted, fsync` (MCP cases surface it as JSON-RPC `-32603`) | `withDecisionPolicy` (`test/support/decision-policy-fixture.mjs:31`) sets `process.platform = "linux"` to fake `/etc/artifact-migration-tools`. That defeats `syncDirectory`'s win32 skip (`store/files.mjs:22`), so a directory fsync is attempted on Windows (`files.mjs:25` ← `mkdirDurably` `:44` ← `acquireModuleLock` `lock.mjs:202`). At plain base the walk also calls `syncDirectory` first (`files.mjs:40` at base), so it throws the same EPERM before it could spin | 1 test-environment | **verified**: identical 13/13 |
| 1 inline-approval | `inline-approval.integration.spec.mjs:342` | same EPERM fsync | same fixture | 1 | unverified (memory) |
| 2 operator-approval-authority | `operator-approval-authority.integration.spec.mjs:421,526` | same | same fixture | 1 | unverified (memory) |
| 8 artifact-migration | `artifact-migration.test.mjs:1718,1764,1965,2079`, `:2195` ×4 providers | same (×4 as JSON-RPC `-32603`) | every one runs inside `withDecisionPolicy` (`:1720,1765,1969,2082,2199`) | 1 | unverified (memory) |
| 1 mcp-server | `mcp-server.test.mjs:1417` | same | same fixture | 1 | unverified (memory) |
| 4 store-shared | `store-shared.test.mjs:241,258,276,369` | `EPERM ... symlink` | the test's own `fs.symlink` setup (`:244,265,292,374`); this account has no `SeCreateSymbolicLinkPrivilege`. `src/` has no `symlink` call, and the product guard holds against junctions (`windows/junction.log`) | 1 | unverified (memory) |
| 2 slices | `slices.test.mjs:186,242` | `EPERM ... symlink` | test setup `fs.symlink` (`:197,255`) | 1 | unverified (memory) |
| 1 store-shared | `store-shared.test.mjs:210` "DR1 one containment rule" | `Error: cwd gone`, thrown at `:238` | the test mocks `process.cwd` to throw (`:236`), then expects `isLexicallyWithin("/a", "/a/b")` to need no cwd. On win32 `"/a"` is drive-relative, so `path.resolve` (`shared/paths.mjs:25`) reads the cwd for the drive. This is a POSIX path assumption, and the product fails closed (throws) | 1 | unverified (memory) |
| 2 artifact-migration signer | `artifact-migration.test.mjs:5895,5943` | `UNPROTECTED_SIGNER_STORE: ... must be a non-symlink owned by the service user with mode 0700/0600` | `openSignerStore` → `assertOwnerOnly` (`src/operator-signer.mjs:64-69`, `:52-55`) requires `(mode & 0o077) === 0`. Windows reports group/other mode bits on every directory, whatever `chmod(0o700)` asked (`test/support/signer-fixture.mjs:13`), so a Windows store can never pass. The branch does not change `operator-signer.mjs` | 2 pre-existing Windows product limitation | unverified (memory); established from code |

**Category 3 (branch regression): 0.** **Category 2 on the RESOLVE →
DISCOVER_LEGACY path: 0.** No skip was added, and nothing in categories 1 or 2 was fixed.

### Signer reachability on native Windows

- **Production entry.** `operator-signer-service.mjs:19` → `runSignerService`
  (`operator-signer-host.mjs:31`) → `readRootOwnedJson(SERVICE_CONFIG_FILE)`
  (`:32` → `operator-signer.mjs:361-362`) throws `UNSUPPORTED_HOST` on any
  non-Linux platform. That happens before `openSignerStore` (`host.mjs:37`), so
  on Windows the service stops at its first line. Only tests reach the store
  check that fails here, by opening the store directly
  (`signer-fixture.mjs:12-18`). `PRODUCTION_ATTESTED_WRITES = false`
  (`operator-signer.mjs:36`, checked at `host.mjs:51-54`) also keeps attested
  writes off on every platform in this build.
- **Migration steps.** The migration CLI and MCP never open the signer
  (`operator-signer.mjs:5`). A step needs it only when a decision candidate's
  required principal is `HUMAN_ATTESTED`. New candidates resolve through
  `createNewFormatDecisionCandidate` (`decisions/candidate.mjs:97`) →
  `resolveRequiredPrincipal` (`decisions/policy.mjs:162-174`) →
  `trustedPolicyFor`, which returns `null` off Linux (`policy.mjs:130`). The
  policy is then `STANDARD_LOCAL`, where every judgment kind is `AGENT_RELAYED`
  (`policy.mjs:54-57`). On Windows, `HUMAN_ATTESTED` can only come from a
  historical pin. Either a ledger line sits under the legacy `engine/judgment/v1`
  policy (`policy.mjs:184-185`, via `decisions/authority.mjs:782`), or under a
  Linux protected policy, which resolves to `null` and is refused
  (`authority.mjs:792`). Such a candidate is blocked as `SIGNER_UNAVAILABLE`
  (`decisions/record.mjs:152-156`).
- **Earliest step it would block on Windows:** the operator decisions at
  **DISCOVER_LEGACY**. For modules these are the judgment kinds
  `ROOT_DECLARATION`, `EXCLUSION`, `EDGE_RESOLUTION` and `DEAD_CONFIRMATION`,
  read by its DISCOVERY_COMPLETENESS gate. For artifact records it is
  `ARTIFACT_DECISION` (`authority.mjs:799`). It blocks only a record carried
  over with a legacy or protected policy pin. The RESOLVE bootstrap that
  *reaches* DISCOVER_LEGACY is unaffected, and so is a fresh Windows record,
  which is pinned to `STANDARD_LOCAL`.
- **Follow-up (P0, separate task):** the protected signer and its owner-only
  store check are POSIX-only by construction, so a Windows host can never
  attest. Decide between a supported Windows signer (an ACL-based owner-only
  check and no `/etc` config) and documenting that records needing
  `HUMAN_ATTESTED` must be decided on managed Linux. Not fixed here.

### Known Windows issues (out of scope)

| Issue | Category | Where | Effect on a real Windows migration |
| --- | --- | --- | --- |
| `withDecisionPolicy` fakes `process.platform = "linux"` on Windows | 1 (test) | `test/support/decision-policy-fixture.mjs:31` | none; 25 tests fail on Windows only |
| Symlink-setup tests need `SeCreateSymbolicLinkPrivilege` | 1 (test) | `store-shared.test.mjs`, `slices.test.mjs`; 4 skipped in `durable-storage.test.mjs` | none; the guard holds against junctions |
| DR1 containment test assumes `"/a"` needs no cwd | 1 (test) | `store-shared.test.mjs:238` | none |
| **Protected signer cannot run or open its store on Windows** | 2 (product) | `operator-signer.mjs:52-55,361-362` | blocks `HUMAN_ATTESTED` decisions at DISCOVER_LEGACY or later, only for legacy- or protected-pinned records. **P0 follow-up** |
| 8 engine files never ran on Windows | not run | Phase A rows 31–38 | unknown |
| Windows CI | not run | CI is Ubuntu-only | n/a |

### Cleanup

`%TEMP%\migration-tests-E9tS1b` no longer exists; its 30 logs are in
`windows/perfile-head-da3a024/`. The runner removes each invocation's
`withTestRoot` scratch. `tbaseline` is removed after these logs are committed.

### Phase C: CI and live certification (Claude only)

Candidate `8f0998718cae8299515d0840d84c718eeef83469`: the Phase A/B docs commit
on top of `f39e8bb`. No non-doc file changed after `1772fb2`, so no new review
was needed. Branch pushed without force; PR
[#8](https://github.com/icordoba8/artifact-migration-toolkit/pull/8).

**Exact-SHA Ubuntu CI: SUCCESS.** Push run
[39438914947](https://github.com/icordoba8/artifact-migration-toolkit/actions/runs/39438914947)
(head `8f09987`): provenance, shards 1–3 and `toolkit (ubuntu-latest)` all
green. The PR run 39438967954 is also green. WINDOWS CI: NOT_RUN.

**Candidate bundle** (clean worktree at `8f09987`; evidence
`~/artifact-migration-acceptance/v1.6.1-8f09987-claude-20261020/`):
`release:check` no blockers, `release:build` + `release:verify` `verified: true`.
Version 1.6.1, unchanged from `4ab6f2ad`. Content hash
`sha256:2a1edad6490d419e42af8f6294ef354981dae61e18d7446814963553e9159e3e`,
identical to the reviewed code's bundle. Archive
`sha256:72abeca2b6bb550a14791b54a31d8eab89272c8355599cefb5967a2e31602614`.
The manifest pin `sha256:065f31776393bf8067d8283377d813a4f462053fcc3a0c63d5ea2e6238a008c8`
was taken independently from the staged `release-manifest.json`, and both
consumers' installed receipts carry the same pin. The verifier is
`4a096044…`, the same as v1.6.0. Claude Code is 2.1.304 on both hosts.

| Run | Procedure | Memory before | Result |
| --- | --- | --- | --- |
| a) Linux WSL2 work-orders, attempt 1 | v1.6.0 procedure: `make-consumer.mjs` fresh consumer `runs-v1.6.1-8f09987/c-claude1`, `agent-e2e-acceptance.mjs --goal complete --isolation os --expected-pin …` (`launch-linux.sh`) | 4.77 GiB | **FAIL (precondition, not product)**. The agent ended after 1 turn: `Failed to authenticate: OAuth session expired and could not be refreshed` (exit 1, 0 tokens). No record was created. `claude auth status` in WSL reports `loggedIn: false`. |
| b) Native Windows, attempt 1 | The same runner with `--goal bootstrap --isolation none` (no `unshare` on Windows, so `certified: false` by design). Fresh consumer `%TEMP%\rbs-cert\cw1` from `make-consumer-win.mjs`, which is `make-consumer.mjs` minus the Linux `node_modules` (symlinked `.bin`) and with a win32 harness path. Fresh install through the installed skill's `ensureRuntime`; 60 min timeout (`launch-win.mjs`) | 4.54 GiB | **FAIL (runner verdict)**: `agent.timedOut: true` at 60 min, so the verdict is FAIL whatever the record reached. The bootstrap criteria were met **without a manual step**: the engine wrote `openspec/specs/work-orders/spec.md` and `state.json` (history `CREATED`, then `STEP_COMPLETED`), with toolkit identity `8f09987` / `2a1edad6…`. `--mode auto` then carried on through `DISCOVER_LEGACY, DISCOVERY_COMPLETENESS, ASSESS_TARGET, BUILD_BASELINE, PLAN` (a `REOPENED` event on the way) and was still in `VERIFY_SLICES` (rev 9, ACTIVE) at the timeout. Its vite dev server and esbuild leftovers were stopped afterwards. Evidence: `out-win1/`, `win-record-work-orders/`, `win-spec.md`. |

Attempt b's FAIL is not relabelled. Its timeout came from the harness
configuration chosen here: a 60 min bound on a `--mode auto` run, which goes
on past the bootstrap goal. It did not come from an engine error: the record
kept advancing and no engine refusal appears.

### Status reached

**BLOCKED_LIVE_CERTIFICATION** (still `IMPLEMENTED_NOT_CERTIFIED`). Phases A
and B are complete: 0 category 3, and 0 category 2 on the bootstrap path. CI
is green on `8f09987`. Phase D was not started: `main` is unchanged
(`594f2cf`), there is no tag or release, and v1.6.0 is unchanged.

Blockers:

1. The Linux WSL Claude Code CLI is logged out. The operator must log in
   (`claude /login` in WSL); this cannot be done unattended.
2. The native Windows attempt failed on the runner's timeout. A rerun on a
   fresh consumer needs a timeout that covers an auto run (the v1.6.0 run
   used 100 min), or the operator's decision that the record evidence above
   is enough for the bootstrap criterion.

### Phase D: Linux live certification and release (Claude only)

This section supersedes the blockers above. The operator logged Claude Code in
under WSL. The operator also accepted the native Windows attempt b as the
bootstrap PASS: it reached `DISCOVER_LEGACY` without a manual step, as recorded
in `out-win1/`, `win-record-work-orders/` and `win-spec.md`. The runner's FAIL
verdict for b stands as recorded and is not relabelled.

| Run | Procedure | Memory before | Result |
| --- | --- | --- | --- |
| c) Linux WSL2 work-orders, attempt 2 | Same procedure as a): fresh consumer `runs-v1.6.1-8f09987/c-claude2` (port 5944), `--goal complete --isolation os --expected-pin …`, 120 min (`make-linux2.sh`, `launch-linux2.sh`). Claude Code 2.1.305, `claude-opus-5-5` | 5.18 GiB (3.39 GiB at first; the 5-min re-check passed after 25 min) | **PASS**: `E2E_COMPLETE_PASS`, engine `COMPLETE` (revision 15), independent verifier 25/25 (`4a096044…`), `security.certified: true`. Installed pin = expected pin `065f3177…`. 01:16:42Z–01:41:18Z, no timeout, watchdog killed nothing. No retry was needed. Evidence: `linux2/`, `runs-v1.6.1-8f09987/out-claude2/`. |

**Release.** The asset was rebuilt in a fresh detached worktree at `8f09987`
(not the earlier cert worktree). `pnpm install` set the executable bit on 10
engine sources, a mode-only change that was restored with `git checkout`
before building. `release:check` reported no blockers, and `release:build` and
`release:verify` both returned `verified: true`. Content hash `2a1edad6…`
and manifest pin `065f3177…` match the certified candidate. Archive
`sha256:de3ed0d1f418294b1e20b1e2db9491debec54d1a7369f98d8e4f307dd666903d`.
`main` was fast-forwarded `594f2cf..8f09987` without force. Annotated tag
`v1.6.1` points at `8f09987`, and the immutable
[v1.6.1 release](https://github.com/icordoba8/artifact-migration-toolkit/releases/tag/v1.6.1)
is published with that asset. v1.6.0 is unchanged. `released-versions.json` was
updated by `pnpm release:record 1.6.1`.

Release scope: Claude only, covering the Linux WSL2 work-orders E2E and the
native Windows bootstrap to `DISCOVER_LEGACY`. Windows E2E is NOT_CERTIFIED and
Windows CI is NOT_RUN. The Windows engine suite is PARTIAL (22 pass, 7 fail in
categories 1 and 2 only, 8 NOT_RUN for memory). The signer `UNSUPPORTED_HOST`
P0 follow-up stays open. Codex and OpenCode are NOT_CERTIFIED, and no general
Windows compatibility claim is made.

### Final status

**CERTIFIED_RELEASED**:
[v1.6.1](https://github.com/icordoba8/artifact-migration-toolkit/releases/tag/v1.6.1)
at `8f0998718cae8299515d0840d84c718eeef83469`.
