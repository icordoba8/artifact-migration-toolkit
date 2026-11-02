# M15 Codex certification: final report

**Verdict: NOT_CERTIFIED.** Written 2026-11-01 ~01:20Z, under the owner's hard deadline of 02:00Z (21:00 Bogotá).
- Executor: Claude Code, Opus 5.5.
- Provider: Codex CLI 0.165.0, `gpt-6.1-sol`, reasoning high (unchanged throughout).
- Run evidence: `../m15-certification-run-20261031T2015Z/` (RUN).

## 1. Identity sheet
| Identity | Value |
|---|---|
| BASE | `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d` |
| Headless harness (R1–R5, R7–R11) | `64a1a4c88147507227ca9bd927191486f6dc28e5`, AMT_PATCH_SHA256 `778d1d5be16f97a0dd9a81d637cdfb3ec96e5e15cfc9e872be24ac752a488533`, CI 41246968597 green |
| Native harness (R6b, R12) | `1a9661b3aba58d7e8fe41076d5e72b3d1d87701a`, AMT_PATCH_SHA256 `244b32d897c06b8e537cb6f3e73862453bf720bc39d96a6c543fc324282a423a`, CI 41253081464 green (5/5) |
| Historical patch digests | `35d5cb61…` ↔ 4236402 (S0 baseline); `9ffb3605…` ↔ 8b2f7fd; `8712859d…` ↔ 6810b08; `4cfc2a06…` ↔ 4d0d83a |
| Release pin / payload | `sha256:bbf8b295722287014407d2c6bf7bd5293105f3f65ea0575f92d135ab1fabbbf6` / `sha256:1f9786e285d5ec2d183a0f9f91d8f64a5a46e6100e42a5b9fab7d5394bafaaf7` |
| Codex / Node | `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5` / `af8d5d1e234beb26b3095e6bebf80edc781f79c9435553a383037eccec2716f8` |
| Profile | `/home/utmwac/amt-m15-auth4-20261031T200214Z` (device login 2026-10-31 ~22:25Z, plan plus) |

## 2. Per run (budget 30 min; 1 invocation, 0 rescues and 0 decision stops in each scored run)
| Run | Scenario | Functional | Operational | Verifier |
|---|---|---|---|---|
| R1 | artifact fresh complete | E2E_COMPLETE_PASS | 2m33s WITHIN | M13 36/36 |
| R2 | module interrupt | INTERRUPTED_CHECKPOINT | 2m18s WITHIN | — |
| R3 | module resume | E2E_COMPLETE_PASS | 4m55s WITHIN | M14 37/37 |
| R4 | module live lock | SAFETY_REFUSAL_PASS | 1m43s WITHIN | — |
| R5 | module read-only | **FAIL** (H-1) | 0m29s WITHIN | — |
| R6 | module native | not scored: TUI bootstrap -32603, no model turn, HARNESS_DEFECT, fixed in 1a9661b | — | — |
| R6b | module native rerun | not scored: no prompt reached the provider | — | — |
| R6c | module native rerun | NOT_RUN: deadline (no launch by 01:10Z) | — | — |
| R7 | artifact interrupt | INTERRUPTED_CHECKPOINT | 1m06s WITHIN | — |
| R8 | artifact resume | E2E_COMPLETE_PASS | 2m06s WITHIN | M13 36/36 |
| R9 | artifact live lock | SAFETY_REFUSAL_PASS | 1m51s WITHIN | — |
| R10 | artifact realm-abandoned-lock | BOOTSTRAP_PASS (RECLAIMED_IN_AGENT_REALM) | 2m38s WITHIN | — |
| R11 | artifact read-only | **FAIL** (H-1) | 0m33s WITHIN | — |
| R12 | artifact native | E2E_COMPLETE_PASS (recording file not found) | 7m57s WITHIN | M13 36/36 |

Details: RUN/runs/S2.md and RUN/runs/<R>/result.md.

## 3. Independent review (S3)
- Fresh Codex 0.165.0 session `01a194aa-b11e-7f90-9bf8-d39d99488265`: `gpt-6.1-sol` high, `-s read-only`, `--ignore-user-config`, `mcp_servers={}`, no resume. Ran 01:12:56Z → 01:15:17Z.
- Prompt: verbatim, plus the path of `review-input.md` (sha256 `790cea3ca0c2fa44e39bf1a8f9e9520e538477b05961bb7d8ef3b9726a98e0c7`).
- Result: **VERDICT: REJECT**. `review.md` sha256 `aa69ec3baf2c7fe5f05026e7e5658eaf794ea2d0a0605fc71c51749ecf8877f6` (unedited).
- Events and rollout are in `review/`. No file in RUN or here changed during the review.
- Rejected items: 3, 14, 17, 18, 22, 26, 30, 37, A4, A5. All others were accepted.
- On 37, the reviewer had no vault-copy evidence. That evidence was produced after the review (§6). On 3/A4, see §5.

## 4. Unmet items
| Item | Reason |
|---|---|
| 14 OpenSpec rejection/correction | No authentic rejection occurred in any run. The literal text requires one (D8), so the row cannot be closed. |
| 17 Module abandoned lock | BLOCKED_SCOPE. Module bootstrap is CLI-only, and Codex runs each shell command in its own PID namespace, while owner proof works only within one realm. Fixing it needs an engine/broker change, which is not authorized. |
| 18, 26 Read-only refusal | Functional FAIL (H-1). The refusal shows up only in the rollout (code-mode `exec` bwrap EROFS) or as the engine's ENOENT. The runner regex reads stdout/stderr only. |
| 22 Module native progress | Never demonstrated: R6 had a harness defect, R6b got no input, R6c was not run (deadline). |
| 30 Artifact native progress | Functional PASS, but no recording file was found (owner attests REC=yes; search covered Videos\Captures and the user profile). |
| A5 F1 | Unrecovered in R5 (D3 keeps it as a finding). |
| 3, A4 Provenance, revocation | See §5. |
| A7 Reviewer | REJECT. |

## 5. Owner items (S4)
- Provenance statement and provider-side revocation: §5a (filled in at close).
- Bootstrap AUTO disposition: **ruling A**, the implementation governs. The contract text (`migration-contract.md:1063-1066`, `:1092-1094`) is a known documentation deviation, to be corrected in the next release candidate. HUMAN_ATTESTED in RUN/s0/OWNER_PAUSE_1.md.

## 6. Vault, credentials
- Vault copy to `/mnt/c/Users/icordoba/OneDrive/amt-evidence-vault-copy/`. This is a OneDrive-synced folder (option 2, because C: and D: share one physical disk with the WSL VHDX).
- `amt-evidence-vault.tar` sha256 `d672d59326ac2b29719f397735c8ad9955a1d0561c2bb97d78b04de92bd620fd` OK.
- The copy was extracted from OneDrive and checked: 7,631/7,631 files match the live vault, and 7,607/7,607 match the vault's original `manifests/vault-copy.sha256`.
- Run and final dirs are copied at close: §6a.
- Credential scan: `credential-scan.md`. 0 auth.json, 0 JWT, 0 auth-hash hits. 2 `sk-` substrings are false positives inside encrypted reasoning blobs.

## 7. What a follow-up candidate needs
1. **Harness (H-1).** Make refusal detection read the provider rollout and accept the engine's read-only error class. Then rerun module and artifact read-only.
2. **Native runs.** The window must keep showing the line to type after Codex draws its screen. The run must not count as done until a recording file is found and vaulted. Rerun the module native run, plus artifact native with a recording.
3. **Row 17.** Needs an authorized engine/broker change (an MCP-side module bootstrap, or a cross-realm owner proof), or an owner/contract decision.
4. **Row 14.** Needs an authentic OpenSpec rejection; it cannot be forced. Otherwise, an owner decision on the contract text.
5. **F1 ("registry not configured").** Needs an engine fix, so that R5-like read-only runs cannot leave it unrecovered.
6. **Owner items.** Provenance attestation and provider-side revocation. A docs-only release-candidate fix for the Bootstrap AUTO text.

## 8. Checks executed
- S0: identity, security probe, Node 22.13 suite.
- S1: realm-abandoned-lock plus the native transport fix. Both had tests, `/ponytail-review`, pre = post digests, push, and CI green.
- S2: model-free native bootstrap check before every native launch. Pacing read before every run (19→36%).
- Rollouts were copied per run, and the credential scan, vault copy and verification were done.

## 9. Material risks
- **Native evidence.** For R6 Launch 1, the only recording captured the Edge window, not the terminal. No recording file exists for R12.
- **Account.** The weekly window started at 0%, against Attempt 3's 62%, so this may be a different account than Attempt 3. That is unattested unless §5a says so.
- **Two harness identities.** The headless runs used 64a1a4c and the native runs used 1a9661b. The only difference is the native argv; headless argv equality is test-asserted.
- **My own wrapper defects** (all recorded):
  - `launch-native.sh` overwrote Launch 1's `launch.*` files.
  - The driver log printed verdict=NO_REPORT.
  - The 01:10Z guard killed itself, and I stopped the R6c window by hand at 01:12:47Z, before any launch.
