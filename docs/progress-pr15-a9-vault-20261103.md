# Progress: PR #15 gap closure (A9, delta review, vault restricted/)

The owner stopped this work at about 03:40Z on 2026-11-03. The 2h timebox started at 02:20Z.
- Worktree: `/home/utmwac/amt-infra-harness`
- Branch: `infra/harness-20261102`
- PR: #15
- Last pushed commit: `eb89b47a47daf88982ef675f126ee07d2017c7a0`

**Status (resumed 2026-11-03 ~12:35Z): committed and pushed as `59b33292b9cd44d1cf8f3d69a53a5414d14e7f9a`; CI on PR #15 all green. Not merged.**

## Done (uncommitted in the worktree)

### A9 relay detection

A9 was implemented here; it was not present before.

`scripts/acceptance-evidence.mjs`:
- `decisionLedgers(root)` reads every `decisions/operator-decisions.ndjson` under `<consumer>/.agents/knowledge/migrations`. It finds them via `snapshotTree`, so it never follows a symlink or opens a FIFO, and reads each regular file with `O_NOFOLLOW|O_NONBLOCK`.
- `ledgerChanges(before, after)` reports any line that was added, rewritten or removed.

`scripts/agent-e2e-acceptance.mjs`:
- The runner takes the before snapshot right before spawn. It reads it host-side, outside the agent sandbox.
- The after snapshot is taken right after the agent's stdout/stderr logs are written, before any other scoring. This covers headless and native runs.
- A change fails the run with `RELAY_IN_SCORED_RUN`: a functional FAIL, so `rerunEligible` is false. The changed lines are copied to `relay-lines.json`, and the counts go to `report.decisionLedgers`.

`auto-decisions.ndjson` (the engine's AUTO principal) is out of scope. No engine change was needed; 1.6.4 and joint `2782612` use the same `DECISIONS_FILE`.

Tests, in `test/agent-e2e-acceptance.test.mjs`:
- **artifact test, headless:** no new line leaves the verdict unaffected (`BOOTSTRAP_PASS`); a line forged with plain `echo >>` gives FAIL.
- **native launcher test:** a forged relay line gives FAIL and is not rerun-eligible.
- **snapshot test:** a planted symlink's target is never read; a truncation and a replayed duplicate line both count as changes.

A mutation check (gate disabled) made both runner tests fail. Targeted tests pass on Node 22.13.0.

Docs: a new paragraph in `docs/agent-e2e-acceptance.md` and a new row 9 in `scoring-changes.md`.

### Delta review (`/ponytail-review`)

Scope: the race and `$` hunks in `eb89b47a…` plus the A9 diff on top of it.

Two findings, both applied and both retested passing:
- `ledgerChanges` now uses `findIndex` instead of a loop.
- The artifact test uses a shared `artifactRun` helper.

Re-review: lean, no open findings.

### Vault `restricted/` (in OneDrive `amt-evidence-vault-copy/`)

The inventory came from tar headers plus in-process SHA-256 hashing; no file contents were opened, printed or copied out.
- 10,146 entries: 7,618 files and 2,528 directories.
- No `auth.json`, tokens, keys or cookies by name.
- 3 × `codex/log/codex-login.log` were classified as credential material. This is the owner's fail-closed decision, given via ask_user. Those files were never read or hashed.

Sanitization:
- The new vault files are `amt-evidence-vault-sanitized-20261103.{tar,tar.sha256,files.sha256,restricted-inventory.tsv}`.
- Verification:
  - `sha256sum -c`: OK;
  - the new tar's names equal the old ones minus 3;
  - per-file check: 7,628 OK, 0 failed.
- The old `amt-evidence-vault.tar`, `.tar.sha256` and `.files.sha256` were removed after verification. Their hashes are recorded in `amt-evidence-vault.SUPERSEDED.txt` in the vault.

## Resumed 2026-11-03 (~12:35Z–12:55Z)

- `/tmp` had been cleared by a reboot, so the in-flight suite logs were gone. Both suites were rerun on Node 22.13.0, with TMPDIR under `/tmp/amt-s2-tmp`:
  - 1.6.4, infra worktree: 37 pass, 0 fail, 0 skip.
  - Joint `2782612` (1.6.5), scratch worktree plus a copy of the 13 harness files from `15090145..` (no path overlap with the engine) and copied `node_modules`: 37 pass, 0 fail, 0 skip.
- Remaining step 1 is done: `owner-blocks.md` has a new block V1 (revocation for the 3 homes, recycle-bin purge), and the "Risk for the owner" bullet was replaced with the outcome.
- Remaining step 2 is done:
  - the TAP logs were replaced;
  - `model-log.md` got a gap-closure row;
  - `SHA256SUMS` was regenerated (now includes `vault-restricted-classification.txt`);
  - the second copy `amt-infra-harness-20261102-evidence-r3.tar` (`6d1863ec…82aa`) was written and verified (`sha256sum -c` OK on the tar and on `SHA256SUMS` in a scratch extraction); `second-copy.txt` was updated.
- Remaining step 3 is done: the joint scratch worktree was removed and `/tmp/amt-s2-tmp` was deleted.
- Remaining step 4: committed `59b3329` and pushed to `toolkit`. CI on PR #15 is green: the 3 shards, the toolkit job and provenance pass in both runs (41639344571, 41639350115). The acceptance harness job (Node 22.13.0, namespaces) reported 37 tests: 36 pass, 0 fail, 1 skip. The skip is the documented G5 local-only Corepack case; there are no unaccounted SKIPs. Not merged.
- Remaining step 5: the Corepack note is unchanged (record only).

## Credential cleanup, /tmp evidence, A9 confirmation (2026-11-03 13:19Z–)

Owner decisions (HUMAN_ATTESTED, via ask_user): credential files are never read or hashed (correction to the first instruction); a hash of a credential file is a credential hash; scrub manifests by replacement, not in-place edit; the live session log is not edited.

- **m15-certification-final** (`3e3d56d6…f4ce`, `sha256sum -c` OK): 15 entries inventoried by name, type, size and in-process SHA-256 (`checks/m15-certification-final-inventory.txt`). The name-screen match is `credential-scan.md`, a report. Clean by name; no new V1 entries.
- **Local vault**: the 3 `codex-login.log` files were removed 2026-11-03T13:21:20Z (`checks/local-vault-login-logs-removed.txt`: name and size; mtime not recoverable). Their SHA-256 had been computed at 13:21:20Z under the superseded instruction. It was removed from that record before commit and is not in Git. The shareable tar in the vault has no credential-class names.
- **Credential hashes in manifests**: `manifests/{source-before,source-after,vault-copy}.sha256` (written 2026-10-30) held 3 login-log hash lines each, at lines 9, 639 and 4384. Replaced by `*.r2.sha256` plus `MANIFESTS.SUPERSEDED.txt`; the vault re-verifies with `vault-copy.r2.sha256` (7,604 OK). On OneDrive, `amt-evidence-vault-sanitized-20261103-r2.tar` (`876b1678…cad3`) replaces `620bf3b7…cc2c`: `sha256sum -c` OK, per-file 7,629 OK / 0 failed. `620bf3b7` is recorded SUPERSEDED, removed, and added to the V1 purge list.
- **CLEANUP_AFTER_SESSION**: `/home/utmwac/.copilot/session-state/53153755-67cb-4bb3-9771-7d549a774618/events.jsonl` (live session log; delete in a later session and record it).
- **/tmp cause**: the S2 recipe (`plan.md:56`) set TMPDIR but never said where the TAP went, so the logs were written to `/tmp/amt-s2-tmp` next to the scratch and lost at the 07:25 reboot. The runner also accepted any `--output`, and the doc example used `/tmp`. Fix: `scripts/agent-e2e-acceptance.mjs:292-294` refuses `--output` inside TMPDIR; `test/agent-e2e-acceptance.test.mjs:159` checks it (fails without the fix). The test gives runner children their own TMPDIR. `docs/agent-e2e-acceptance.md:196`, `plan.md:56` and `docs/start-migration-architecture-plan.md:283` now point evidence at persistent paths. This rerun wrote TAP straight into `checks/`.
- **A9 review** (`/ponytail-review`, delta `eb89b47..` plus the guard): no open findings. Relay detection is at `scripts/acceptance-evidence.mjs:37` (`decisionLedgers`, `O_NOFOLLOW` read at :44) and `:50` (`ledgerChanges`); in the runner at `scripts/agent-e2e-acceptance.mjs:556` (before snapshot), `:594` (after snapshot) and `:599` (`RELAY_IN_SCORED_RUN`). Tests are at `test/agent-e2e-acceptance.test.mjs:605`, `:936-942` and `:1222`.
- **Suites** (Node 22.13.0): 1.6.4 37/37, joint `2782612` 37/37, 0 skip.
- **Open (owner)**: `m15-certification-run-20261031T2015Z.tar` contains `runs/login-record.txt` (260 bytes). Classifying it needs a read, so it is untouched. V1 revocation and purge are still owner actions.

## In flight when stopped

- `checks/vault-restricted-classification.txt` in the evidence directory has since finished writing (23 lines, exit 0).
- Full suites on Node 22.13.0 were running:
  - 1.6.4 → `/tmp/amt-s2-tmp/a.tap`;
  - joint `2782612` → `/tmp/amt-s2-tmp/b.tap`, scratch worktree `/tmp/amt-s2-tmp/joint-scratch`.

## Remaining

1. Add the owner block to `owner-blocks.md` and replace its "Risk for the owner" bullet with the outcome above. The block covers:
   - provider-side revocation of the Codex logins for homes `auth-20261030T1715Z`, `auth2-20261030T1750Z` and `codex-recovery-20261030T125104Z`: ChatGPT "Log out of all devices", or revoke the API key if one was used;
   - purging the OneDrive recycle bin (including the second stage) of the 3 removed files.
2. Once both suites pass:
   - replace the two `checks/s2-*.tap` logs;
   - regenerate `SHA256SUMS`;
   - make a new second copy (`-r3`) and update `second-copy.txt`.
3. Remove the joint scratch worktree.
4. Commit, push to `toolkit`, and watch CI on PR #15, including the 22.13.0 job's skip counts. Do not merge.
5. Record for the baseline-freeze prompt, with no action taken here:
   - the host `~/.cache/node/corepack` is broken;
   - pnpm 12 and Corepack 0.30 expect different layouts.

## Risks and open items

- ~~Local vault still holds the 3 login logs~~ and ~~m15-final not inventoried~~: closed by the credential cleanup below.
- The OneDrive recycle bin may still hold the old tar until the owner purges it.
