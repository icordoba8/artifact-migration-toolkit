# M15 certification plan: addendum (rev 2)

**Status: NOT_READY.** This addendum re-verifies and corrects the rev 1 package `m15-certification-plan-20261030T2045Z/` ([MATRIX.md](../m15-certification-plan-20261030T2045Z/MATRIX.md), [PLAN.md](../m15-certification-plan-20261030T2045Z/PLAN.md)). Rev 1 is unchanged and still verifies against its `SHA256SUMS`. Where they differ, this file wins. Prepared 2026-10-30 23:42–23:55Z under `/ponytail lite`. It changed no source, contract, historical evidence or security control, and it ran no authentication, commit, push, scored run or acceptance execution.

## 1. Re-verification (2026-10-30 ~23:45Z)

| Check | Result |
|---|---|
| Vault copy `~/amt-evidence-vault/m15-20261030T2045Z/restricted/tmp` against `manifests/vault-copy.sha256` (7,607 files) | `cmp` identical |
| Shareable tar `m15-official-attempts-1-3-consumers.tar.gz` | `sha256sum -c` OK (`d38bde8b…6600`) |
| `auth.json` anywhere in the vault | 0 |
| `SHA256SUMS` for acceptance top level, `attempt3/`, `M15_upload_20261030/`, rev 1 plan | all OK |
| `attempt3/official-module-complete/verifier-result.json` | 37/37 |
| Candidate `/home/utmwac/amt-m15-uidmap` | HEAD `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d`, 0 porcelain lines |
| `git diff 874806f d7eb28c -- packages skills providers` | empty, so the payload under test is unchanged |
| Rev 1 line references: `migration-contract.md:1063-1066,1092-1097`, `policy.mjs:119-124`, runner `:165` / `:216` / `:217`; canonical and `providers/codex` contracts | confirmed; the two contract copies are byte-identical |

## 2. Corrections to rev 1

**C1. `/tmp` is gone. The vault is now the only copy.** The host rebooted at 2026-10-30 23:30:23Z (`uptime -s`, 18:30:23 −05:00), and `/tmp/amt-m15-*` no longer exists. When the vault was made, the originals were preserved (`source-before` == `source-after`), but that can no longer be re-checked. The vault is a single copy on the WSL ext4 disk. **Owner action:** make a second copy offline or on encrypted media; I did not make one. The vault README's sentence "Originals in `/tmp` were left in place" is now historical.

**C2. The credential files were deleted with `/tmp`. That is not the same as revoking them.** The three `auth.json` files (profiles auth, auth2, auth3) were never vaulted and are now gone from disk. Their tokens may stay valid at the provider until someone revokes them. Disposal (rev 1 §2 item 4) must therefore happen **at the provider**: sign out the device sessions or revoke the authorizations for the attested account. Also, rev 1 D1's choice to "reuse the attested credentials" for new scenarios no longer exists. **Every new scenario needs a fresh device-auth login with the operator present.**

**C3. The vault access description was wrong.** The README says files are `0600`. In fact the vault root and its top-level directories are `0700`, while copied files kept their source modes (for example `0644` git hook samples). Access is still owner-only, because nobody else can traverse the `0700` root. Nothing was changed.

**C4. Provenance (rev 1 §2): one owner record was missing.** The rev 1 table omits the owner's instruction at **2026-10-30T17:06:27Z** (session `aee043b8…`, task 5): *"Proceed immediately to disposable interactive authentication and one authenticated model request inside the approved boundary."* It comes before device codes 3 and 4, and it authorizes the *class* of authentication (disposable, interactive). The message at 18:49:49Z is a continuation summary written by the agent, not an owner statement. Rev 1 cites the 18:50:54Z "Reuse…" prompt correctly.

Even with this record, **no non-secret record shows** which account approved codes 3 and 4, that the account really was disposable or test-only and separate from the owner's personal or company account, who entered the codes, or that copying auth2's credentials into the new HOME auth3 counts as "reuse". The search covered `docs/investigations/`, the vault (credential files absent) and all six project session transcripts from 2026-10-30.

**Required owner attestation (replaces rev 1 §2 items 1–4).** Write it as a new, signed file dated at the real signing time. Do not backdate it, and do not edit older records.
1. **Account class:** the account that approved codes 3 and 4 is a disposable or test account used only for this certification, and it is not the owner's personal or company account. An opaque label is enough; no email or token.
2. **Operator:** who entered each code, and a statement that nobody else had access.
3. **Reuse:** a statement that copying auth2's credentials into `/tmp/amt-m15-auth3-20261030T1910Z` was within the 18:50:54Z instruction. Otherwise, a statement that Attempt 3's provenance is accepted as a **ruling dated <signing date>**, which is not prior authorization.
4. **Disposal:** revoke the sessions at the provider after certification (C2), with the date it was done.

Until the attestation is signed, row A4 stays `NOT_TESTED` and row 3 keeps `PROVENANCE_ATTESTATION_REQUIRED`.

**C5. The environment has drifted since Attempt 3.** The default `codex` is now **0.166.0** (`~/.local/bin/codex`, auto-updated), and the default `node` is **v26.8.2**. `official-run.sh` pins both itself: Codex 0.165.0 musl and Node 22.13.0. The rev 1 prep commands do not: `node prepare-fresh2.mjs` and the S-A lock holder would run on Node 26. The pinned binary is still present: `$R/bin/codex --version` = 0.165.0, sha256 prefix `c06a67fd`. The auto-updater could remove it before a run.

**C6. Restoring the bundle is now mandatory.** `prepare-fresh2.mjs:12` hardcodes `/tmp/amt-m15-codex-recovery-20261030T125104Z/…`, and that path is gone, so the `cp -a` restore in rev 1 §5 must always run.

## 3. Matrix deltas (all other rows of rev 1 MATRIX.md stand)

| # | Status | Qualifier change | Evidence |
|---|---|---|---|
| 3 ISOLATED_AUTHENTICATION | PASS (unchanged) | `PROVENANCE_ATTESTATION_REQUIRED`; the class is authorized by the 17:06:27Z instruction (C4) | session `aee043b8…` 17:06:27Z, 18:50:54Z |
| 37 EVIDENCE_SOURCE_RELEASE_PRESERVATION | PASS (unchanged) | re-checked at 23:45Z. The `/tmp` originals no longer exist (C1); the vault is the only copy, still byte-identical to the pre-reboot manifest | §1 |
| A4 Disposable credentials | NOT_TESTED (unchanged) | attestation narrowed to C4 items 1–4. Credentials are gone from disk, but revocation is still pending | C2, C4 |

The 37 functional verifier assertions are unchanged and separate: 37/37, verifier `a0055e2d…52e7`, and they back row 10 only. The accepted discounts result is preserved and **not** repeated to remove F1.

## 4. Bootstrap AUTO contradiction

The rev 1 §3 references were re-confirmed in §1. **The recommendation is unchanged: (A) the implementation governs.** In a separate, reviewed change, rewrite only the docs (`migration-contract.md:1063-1066` and `:1092-1097`, plus `v5-contract.md` §1.8) to describe AUTO's self-confirmation. In the same ruling, decide whether an auto-confirmed bootstrap or registration must leave a ledger line. Neither the contract text nor the code was changed. Owner + GPT ruling D2.

## 5. Execution-plan deltas (missing mandatory scenarios only)

Replace the first lines of the rev 1 §5 common block with the following. The rest is unchanged:

```bash
R=/home/utmwac/.codex/packages/standalone/releases/0.165.0-x86_64-unknown-linux-musl
export PATH=$R/bin:/home/utmwac/.nvm/versions/node/v22.13.0/bin:/usr/local/bin:/usr/bin:/bin   # C5
test "$($R/bin/codex --version)" = "codex-cli 0.165.0" && test "$(node --version)" = v22.13.0 && grep -q '^Seccomp:[[:space:]]*0' /proc/self/status
VT=/home/utmwac/amt-evidence-vault/m15-20261030T2045Z/restricted/tmp
test -e /tmp/amt-m15-codex-recovery-20261030T125104Z || cp -a $VT/amt-m15-codex-recovery-20261030T125104Z /tmp/   # C6; prepare-fresh2's manifest-pin assert guards the bytes
```

| Scenario | Needs | Operator participation | Realistic duration (rev 1 + C2) |
|---|---|---|---|
| S-A1 MODULE_LIVE_LOCK | D1 (attestation), D7 | enter one device code (≤15 min window) | ~10 min prep + 5–15 min login + 5–10 min run + ~10 min trusted-side checks ≈ 30–45 min |
| S-A2 MODULE_ABANDONED_LOCK | D1, D7 | one device code | ≈ 30–45 min; risk: realm owner proof may refuse reclaim across the agent's PID namespace. Record it as it happens |
| S-B MODULE_NATIVE_TERMINAL_PROGRESS | D1, D5, D7 + launcher review | one device code + the single typed invocation + screen recording, present throughout | ≈ 45–60 min |
| S-C read-only, resume, all 11 artifact cells | D6 (harness work), then D7 (commit, push, CI) | one device code per run; present for artifact UI | 4–6 h implementation + review + one 30–40 min CI run, then ~3–4 h of runs (≥8 logins) |
| A1 CI at the harness SHA | D7 (push) | none | 30–40 min |

Independent verification is unchanged: GPT reviews the transcript, `report.json`, before/after lock and target hashes, `engine-status.*` and the verifier output. The runner's verdict alone is not a safety verdict.

**Owner decisions, amended:** D1 = sign the C4 attestation **and** schedule provider-side revocation. The credential-reuse branch is removed (C2). D2–D8 are as in rev 1.

Recommended order: D1–D4, then S-A1 and S-A2 (about 1.5 h), then D5 and S-B, then D6 and S-C, then A1, then the GPT final review.
