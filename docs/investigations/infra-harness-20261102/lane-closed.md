# Lane closed — infra harness 20261102

Status: the agent's work in this lane is closed. This does not mean the lane is ready: the owner items below are still open.

- **PR**: #15 (`infra/harness-20261102`), open, not merged.
- **Final commit**: the latest commit that touches this file. Get it with
  `git log -1 --format=%H -- docs/investigations/infra-harness-20261102/lane-closed.md`.
- **Executor**: GitHub Copilot CLI, Claude Opus 5.5, sessions `b7d2ee91-57b1-4818-9f55-de7bf6826168` (close-out) and `5eca6a0a-7ac2-4122-853a-334f02a1df0b` (last cleanup, E7 grant assertion).

## Done in the closing session (AGENT_OBSERVED)

- `m15-certification-run-20261031T2015Z.tar`: `runs/login-record.txt` (260 bytes) is excluded by owner decision; it was never read, hashed or copied. `runs/SHA256SUMS:281` listed its hash, so it was replaced by `SHA256SUMS.r2` and `MANIFESTS.SUPERSEDED.txt`. The new copy is `m15-certification-run-20261031T2015Z-sanitized-20261103.tar` (`95f8cb6fecf604cae5117a16c2ac862e2b49adffe6cbbb270e89894792b3431f`): `sha256sum -c` OK, and per-file 370 OK / 0 mismatches. The old tar (`a1ee9706…c406`) is recorded SUPERSEDED, was removed at 14:03:55Z, and is on the V1 purge list. Record: `checks/m15-certification-run-sanitized.txt`.
- Vault `README.md:19` now re-verifies against `vault-copy.r2.sha256`. The command exits 0 (7,604 files).
- **Last cleanup (2026-11-03, owner decisions HUMAN_ATTESTED).** History check first: no file listing `login-record.txt`'s hash was ever committed in either repo (`artifact-migration-toolkit`, `artifact-migration-tools`, every object incl. unreachable) or posted in any PR text. **HISTORY_EXPOSURE: none.** Then deleted, each recorded before removal: the untracked `login-record.txt` (never read, hashed or copied) and the untracked `runs/SHA256SUMS` next to it in the toolkit worktree; the OneDrive sidecar `m15-certification-run-20261031T2015Z.tar.sha256` (added to the V1 purge list); `/tmp/pt-m15run.HJjD`, `/tmp/pt-oldlist.txt`, `/tmp/pt-scratch`. Record: `checks/final-cleanup-20261103.txt`.
- **E7 shipped grants asserted.** The harness no longer injects a Codex tool filter, and refuses with `ACCEPTANCE_INSTALLED_GRANTS` before spawn unless every installed Codex/Copilot registration grants exactly the nine (`scoring-changes.md` row 10).

## CLEANUP_AFTER_SESSION

- The whole directory `/home/utmwac/.copilot/session-state/b7d2ee91-57b1-4818-9f55-de7bf6826168/`, `events.jsonl` and `rewind-file-snapshots/` included (its `backups/e78825971c6e7402bb4c0d15ea2228044ba0007caa4af5e8677bdca8b1c772f3`, 27,968 bytes, is the CLI's snapshot of the superseded in-tar `runs/SHA256SUMS`, whose line 281 is the credential hash). Delete it in a later session and record the deletion.
- Carried forward: `/home/utmwac/.copilot/session-state/53153755-67cb-4bb3-9771-7d549a774618/events.jsonl`. It holds superseded login-log hash output. Both session directories are held by the same CLI process (pid 24039), so delete them after it exits.

## Open items

1. **V1 (owner)**: Codex login revocation, then a purge of the OneDrive recycle bin (both stages), including the old m15-certification-run tar and its `.tar.sha256` sidecar (`owner-blocks.md` V1).
2. **I11, I12 (owner)**: account provenance and the off-device receipt (`owner-blocks.md`).
3. **OneDrive leftover**: `amt-evidence-vault-sanitized-20261103-r2.tar` still contains the old `README.md:19` text. That line names a superseded manifest and holds no credential.
4. **Second copy of this directory**: `amt-infra-harness-20261102-evidence-r4.tar` predates this close-out. Refresh it if the owner wants the copy to match this commit.
5. **BLUE integration gate**: run the harness tests against engine 1.6.6 with E7 (PR #16; E7 is uncommitted in that worktree at the time of writing). A consumer installed without E7 is refused by design.
