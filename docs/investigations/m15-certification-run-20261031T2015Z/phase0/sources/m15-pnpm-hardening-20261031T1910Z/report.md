# M15 pnpm provisioning hardening

- Executor: Claude Code, Opus 5.5. `/ponytail full` (5.1.0) for the implementation. `/ponytail-review` (5.1.0) ran twice: once on the complete diff with its connected code, and once more on the final content after fixing its one finding. Started 2026-10-31T19:10:23Z.
- Worktree: `/home/utmwac/amt-m15-uidmap`, branch `cert/m15-codex-uidmap-20261030`, remote `toolkit`.
- Base: HEAD equalled `8b2f7fddcf03ba3bdf8659b6096363c210eec62d` with a clean tree before any edit.
- Prior evidence: `../m15-node2213-phase2-20261031T1838Z/`.

## Identities
| Identity | Value | Status |
|---|---|---|
| Frozen base (parent) | `8b2f7fddcf03ba3bdf8659b6096363c210eec62d` | HEAD equalled it, tree clean |
| **New harness commit** | `42364020d6db36a60327b271dc83bfbebc4daf4e` (parent 8b2f7fd) | pushed to `toolkit` (`8b2f7fd..4236402`) |
| Historical BASE | `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d` | unchanged; still an ancestor |
| Expected pin | `sha256:bbf8b295722287014407d2c6bf7bd5293105f3f65ea0575f92d135ab1fabbbf6` | unchanged; not touched |
| Payload contentHash | `sha256:1f9786e285d5ec2d183a0f9f91d8f64a5a46e6100e42a5b9fab7d5394bafaaf7` | unchanged (`release:check` at 4236402) |
| Historical AMT_PATCH_SHA256 | `9ffb36059fb6da63014bea09defbecbfc4b1d01eec6f5dae8ba989f5d4aeef76` | kept, paired with harness commit `8b2f7fddcf03ba3bdf8659b6096363c210eec62d` |
| **Owner-approved next official-run AMT_PATCH_SHA256** | `35d5cb6109b1c4543fededc42cee9b6e0e6d38a0f417448c21ae7ad227fbe296` | paired with harness commit `42364020d6db36a60327b271dc83bfbebc4daf4e` |

Pre-approval conditions:
1. **Pre-commit digest equals post-commit digest.** `bash scripts/m15-patch.sh | sha256sum` gave `35d5cb6109b1c4543fededc42cee9b6e0e6d38a0f417448c21ae7ad227fbe296` before `git add` and again after the commit, with the tree clean. All 64 characters match.
2. **The review covered exactly that content.** The second `/ponytail-review` ran on the worktree at digest `35d5cb61…e296`. Nothing was edited between that review and the commit, and `git add -A` staged exactly those 5 files.
3. **No tracked file stores the digest.** `git ls-files | xargs grep` for `35d5cb6109b1c454` and for `9ffb36059fb6da63` found nothing, both before and after the commit. The digest appears only in this report and in SHA256SUMS. The owner-approved patch file is the exact `m15-patch.sh` output: `owner-approved-next-official-run-AMT_PATCH_SHA256.d7eb28c-to-4236402.patch`.

No other identity changed. Node 22.13.0 and Codex 0.165.0 pins, binary hashes and the nvm shims were not touched.

## Change (5 files, +47/−22; full diff in `commit-8b2f7fd-to-4236402.patch`)
- **R1: version switch.** pnpm 11.21.0 honors the setting, confirmed before any edit. With `pnpm_config_pm_on_fail=error` and a target that declares `packageManager: pnpm@10.0.0`, pnpm refused with `This project is configured to use 10.0.0 of pnpm. Your current pnpm is v11.21.0`, and the logging registry received 0 requests. Without the setting, pnpm sent `GET /pnpm` and `GET /@pnpm%2Fexe`.
  - `scripts/m15-official-run.sh` adds `pnpm_config_pm_on_fail=error` to the `env -i` environment.
  - Review finding (fixed): Codex 0.165 starts stdio MCP servers with only an env allowlist. A local probe (`logs/review-codex-mcp-env-probe.log`; no auth, closed-port fake model, throwaway CODEX_HOME) showed the server got only `HOME`, `PATH`, `LANG` and `PWD`. So the engine's validators, run through start-migration, would not have seen the setting.
  - `scripts/agent-e2e-acceptance.mjs` `commandFor('codex')` therefore adds `-c 'mcp_servers.start-migration.env_vars=["pnpm_config_pm_on_fail"]'`. The same probe with this override showed `pnpm_config_pm_on_fail=error` in the server's environment. The nine grants, `approval_policy="never"`, workspace-write and `--add-dir` are unchanged.
  - The exact-override test and `docs/agent-e2e-acceptance.md` list the new override.
- **R2: read-only binary.** The read-only list is in the harness runner (`scripts/agent-e2e-acceptance.mjs`, `score()`), not in engine or broker code, so BLOCKED_MOUNT_SCOPE did not apply.
  - The launcher passes `AMT_PNPM_DIR=<run dir>`, and the runner adds it to `readOnly`. That list feeds the `unshare` bind-and-remount-ro setup and `report.security.readOnly`.
- **R3: no residue.** `scripts/m15-pnpm.sh` now takes `<tgz> <new run dir>`. It reports `PNPM_MISSING` first, then `mkdir -m 700` (which refuses an existing path), then copies, verifies the sha512 and unpacks. It no longer prints anything.
  - The launcher fixes the run path as `~/.cache/amt-pnpm/pnpm-11.21.0.tgz.run.$$`. It installs `trap 'rm -rf -- "$AMT_PNPM_RUN"' EXIT` and HUP/INT/TERM traps that exit 129/130/143 **before** the directory exists, so there is no window where the directory exists without a trap.
  - The launcher no longer `exec`s the runner, so the trap outlives it.
  - All earlier refusals still run before this block. Their lines are byte-identical.
- **R4: CI skip.** The verified-tarball test now skips only when `CI` is set, with the reason `tarball not cached on runner: CI does not provision /home/utmwac/.cache/amt-pnpm/pnpm-11.21.0.tgz`. Off CI, a missing tarball fails the test instead of skipping it.
  - The test also asserts the pm_on_fail refusal. The registry is pointed at closed port 9, so a fetch attempt would show up as a different error.
- **Cache pruning (authorized).** `meta/` was byte-identical to `../m15-node2213-phase2-20261031T1838Z/pnpm/`, and `pnpm-11.21.0.tgz.run.fok2os` was 47 MB. Both were removed. The tarball was kept, with sha512 `521705bc…3bb1` (`logs/prune-cache.log`).

## Gates
| Gate | Result | Evidence |
|---|---|---|
| G1 | PASS | `logs/g1-pm-on-fail.log`. This ran the real hardened launcher from a disposable clone where only the runner was a stub, with the registry redirected to a local request logger. Under the launcher env the target pinning pnpm@10.0.0 was refused and the logger recorded **0 requests**. The control (same env minus pm_on_fail) recorded 2 fetches. `logs/review-codex-mcp-env-probe.log` shows the setting reaching the Codex MCP server. |
| G2 | PASS | `logs/g2-readonly-probe.log`. Inside the runner's `isolated()` with the unpacked run dir in its read-only list, both writes failed with `Read-only file system`. `pnpm --version` still printed 11.21.0, and `NoNewPrivs` was 1. `logs/g2-isolation-test.log` and `logs/g4-launcher-tests-postcommit.log` show the full runner test with `AMT_PNPM_DIR` reporting `pnpm=DENIED`. |
| G3 | PASS | `logs/g3-exit-paths.log`: normal exit (0), wrong patch digest (1), missing auth.json (1), stale run dir at the PID path (1, mkdir refuses and the trap removes it), forced runner error (1), SIGTERM to the group (143), SIGINT to the group (130), SIGTERM to the launcher only (143, after the runner finishes) and SIGHUP to the group (129). After every one, `~/.cache/amt-pnpm` held only `pnpm-11.21.0.tgz`. `logs/g3-real-launcher-forced-error.log` repeats the forced error with the real committed launcher and the real runner (`Missing --provider`), with the same result. |
| G4 | PASS | Node v22.13.0, each test run individually. Launcher tests 3/3, in `logs/g4-launcher-tests.log` and rerun on the committed content in `logs/g4-launcher-tests-postcommit.log`. #202: 1/1 pass (`logs/g4-202.log`). #11: 16/16 with `ok 11`, not skipped (`logs/g4-11.log`). #430: `# SKIP requires node:module registerHooks (Node >= 22.15)` (`logs/g4-430.log`). These match the phase-2 results. #202, #11 and #430 ran under the launcher's env composition, including `pnpm_config_pm_on_fail=error`. |
| G5 | PASS | `logs/architecture-check.log` is ok. `logs/release-check.log` at 4236402: blockers `[]`, contentHash 1f9786e2. The pre-commit run was blocked only by the dirty tree (`release-check-precommit.log`). |
| G6 | PASS | Review 1 found one Must-fix (the MCP env allowlist drops pm_on_fail), which was fixed. The tests touched by the fix pass (`logs/review-fix-codex-argv-tests.log`). Review 2 on the final content (`35d5cb61…`): Ship, no findings. |
| G7 | PASS | Pushed `8b2f7fd..4236402` (`logs/push.log`, `logs/remote-tip.txt`). CI run https://github.com/icordoba8/artifact-migration-toolkit/actions/runs/41234280726 is green on exactly `42364020d6db36a60327b271dc83bfbebc4daf4e`, 5/5 jobs (`ci/run-41234280726.json`). |

### CI details (`ci/job-124634701033.log`, shard 3; job logs fetched via `gh api …/jobs/ID/logs`)
- `ok 31 - the verified pinned pnpm tarball starts pnpm 11.21.0 and pnpx, and refuses a target pinning another pnpm # SKIP tarball not cached on runner: CI does not provision /home/utmwac/.cache/amt-pnpm/pnpm-11.21.0.tgz` (l.397). The skip states its reason; it is not silent.
- `ok 30` (the launcher wiring, missing tarball and altered tarball) and `ok 16` (the exact Codex overrides, including the new `env_vars`) run and pass.
- `ok 10`, the OS-isolation test that carries the new `pnpm=DENIED` check, is one of the pre-existing namespace skips on the runner. It was exercised locally only (G2).
- providers: 114 tests, 105 pass, 0 fail, 9 skip. That is the same count as at 8b2f7fd: 8 namespace / pinned-Node skips, plus this tarball test.
- architecture ok. engine:test is 16/16 + 19/19 + 1168/1168, all passing.

## Not done / not checked
- No full engine suite, no scored run, no authentication, no GPT request, no merge, no tag and no release.
- Claude Code and OpenCode MCP env passing was not checked; the official M15 runs are Codex only. The env of Codex's shell tool needs a model turn, so it was not checked either (its documented default inherits everything except names matching KEY, SECRET or TOKEN).
- A full official launch (authenticated profile, real provider) was not run. G1 and G3 used the real launcher with a stub runner and a fake profile that held no credentials.

- Credential scan of this directory: the only match is the runner-masked checkout header `AUTHORIZATION: basic ***` (3×) in the CI job logs. No credentials are stored.

## Material risks
1. **SIGKILL** to the launcher cannot be trapped, so it leaves `pnpm-11.21.0.tgz.run.<pid>`. This is noted inline as a `shortcut:`; prune it by hand.
2. **SIGTERM to the launcher PID alone** no longer stops the runner. Bash runs the trap only after the runner exits. Before this change, `exec` let it kill the node runner but left the namespaced agent orphaned. To abort a run, signal the process group (Ctrl-C in the terminal, or `kill -- -PGID`).
3. **The agent controls the target workspace.** It could set `pmOnFail` in the target's own pnpm config, so the refusal is a guard against honest version pins, not a sandbox boundary. Precedence between workspace config and env was not probed.
4. Unchanged from phase 2: the yarn Corepack shim still fails with the same keyid error, and CI runs Node 22.23.4, not 22.13.0.
