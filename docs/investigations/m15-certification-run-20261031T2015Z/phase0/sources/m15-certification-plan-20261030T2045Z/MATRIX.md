# M15 Codex consolidated certification matrix

**VERDICT: NOT_READY.** This matrix is prepared for owner approval. It grants no certification, and GPT keeps final acceptance authority.

| Identity | Value |
|---|---|
| Harness HEAD (frozen) | `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d`, local branch `cert/m15-codex-uidmap-20261030`, unpushed, clean. Runner sha256 `c3479f87…bad5b` |
| Toolkit payload under test | 1.6.5 at `874806fc…`, contentHash `sha256:1f9786e2…faaf7`, manifest pin `sha256:bbf8b295…bbbf6`. The pin matched the trusted pin in Attempt 3 |
| Provider / model | Codex CLI 0.165.0, `gpt-6.1-sol`, effort `high` (from the Attempt 3 rollout in the vault) |
| Platform | WSL2 Ubuntu 24.04, kernel 6.18.33.2, Node 22.13.0 |
| Scored result | Attempt 3, 2026-10-30 19:10:41Z–19:23:24Z, `E2E_COMPLETE_PASS`, `security.certified: true` |

The contract basis is `docs/agent-e2e-acceptance.md`, test cases 1–6 and "What can be signed off", at d7eb28c. Rows 1–37 keep the cell IDs of the existing matrix `m15-codex-certification-20261029-unblock/acceptance-matrix.json` and update them with later evidence. Rows A1–A7 are sign-off items the contract requires that the old matrix did not carry. Status uses only the contract's `PASS` / `FAIL` / `NOT_TESTED`. Any reservation goes in **Qualifier**.

Evidence path abbreviations: `A3` = `m15-codex-acceptance-20261030T1715Z/attempt3/`, `OMC` = `A3/official-module-complete/`, `UB` = `m15-codex-certification-20261029-unblock/`, `PRE` = `m15-codex-certification-20261028/`, `V` = `~/amt-evidence-vault/m15-20261030T2045Z/`.

## Certification rows

| # | Cell | Status | Qualifier | Evidence |
|---|---|---|---|---|
| 1 | EXACT_CANDIDATE_PAYLOAD_INSTALL | PASS | | `OMC/report.json` candidate.installedPin == expectedPin, matchesTrustedPin; `A3/module-official-setup.json` |
| 2 | CODEX_CLI_VERSION | PASS | | `A3/official-module-complete.command.json` PATH = 0.165.0; rollout `cli_version` 0.165.0 (`V/restricted/tmp/amt-m15-auth3-…/codex/sessions/…`) |
| 3 | ISOLATED_AUTHENTICATION | PASS | PROVENANCE_ATTESTATION_REQUIRED | An authenticated agent ran 13 min (`OMC/agent.stdout.log`). The profile is auth3 = auth2 credentials in a new HOME. See PLAN §2 |
| 4 | REQUESTED_MODEL_EXECUTION | PASS | | rollout: `model gpt-6.1-sol`, `reasoning_effort high`, provider openai |
| 5 | REGISTRY_FAILURE_REPRODUCTION | PASS | diagnostic only | `UB/registry-diagnosis-verified.json` |
| 6 | SHELL_FAILURE_REPRODUCTION | PASS | diagnostic only | `UB/sandbox-verified-*` |
| 7 | SHELL_EXECUTION_UNDER_OFFICIAL_CONTROLS | PASS | | `OMC/report.json` isolation OS_NAMESPACE. The nested bwrap shell ran, e.g. the discover bootstrap exit 0 at `OMC/agent.stdout.log` line 45; uid-map fix `m15-codex-uidmap-impl-20261030T143405Z` |
| 8 | OFFICIAL_MODULE_COMPLETE | PASS | F1 recovered autonomously (A5) | `OMC/report.json` verdict E2E_COMPLETE_PASS, engine COMPLETE rev 9, certified true |
| 9 | OFFICIAL_UNREGISTERED_MODULE_BOOTSTRAP | PASS | CONTESTED: AUTO self-confirmed the bootstrap and the registration the contract calls two-phase (A6, PLAN §3) | `OMC/agent.stdout.log` line 45 "Current state: NOT_STARTED … Mode: auto — self-confirmed." |
| 10 | OFFICIAL_MODULE_FUNCTIONAL_EQUIVALENCE | PASS | | `OMC/verifier-result.json` 37/37, verifierSha256 `a0055e2d…52e7` (functional section below) |
| 11 | OFFICIAL_ARTIFACT_COMPLETE | NOT_TESTED | harness has no artifact mode | `UB/official-harness.mjs.txt`; still true at d7eb28c (runner hardcodes `/start-migration`, `scripts/agent-e2e-acceptance.mjs:217`) |
| 12 | OFFICIAL_ARTIFACT_BOOTSTRAP | NOT_TESTED | same | same |
| 13 | OFFICIAL_ARTIFACT_FUNCTIONAL_EQUIVALENCE | NOT_TESTED | same; M13 verifier proven 36/36 on its reference | `PRE/evidence/m13-reference-proof.json` |
| 14 | OPENSPEC_REJECTION_AND_CORRECTION | NOT_TESTED | not observed: the authored proposal was accepted on the first bootstrap | `OMC/agent.stdout.log` line 45 (only discover call, exit 0) |
| 15 | MODULE_INTERRUPTION_RESUME | NOT_TESTED | runner is fresh-only (`agent-e2e-acceptance.mjs:216`) | — |
| 16 | MODULE_LIVE_LOCK | NOT_TESTED | engine-only preflight passed earlier | `PRE/evidence/lock-preflight.json` (realCodexSafetyRun false) |
| 17 | MODULE_ABANDONED_LOCK | NOT_TESTED | same | same |
| 18 | MODULE_READONLY_REFUSAL | NOT_TESTED | engine-only preflight passed earlier | `PRE/evidence/readonly-preflight.json` |
| 19 | MODULE_OPERATOR_DECISIONS | NOT_TESTED | none arose: 0 OPERATOR_DECISION outcomes in 36 MCP calls, no `decisions/` dir. Owner disposition D4 | `OMC/agent.stdout.log`; consumer record in `V/restricted/tmp/amt-m15-run3-20261030T1910Z/` |
| 20 | MODULE_LIVE_CODEX_MCP_CONNECTIVITY | PASS | | 36 MCP calls (status 10, run 21, prefill 5), 0 approval refusals, two -32603 F1 errors (lines 9, 15) |
| 21 | MODULE_CANONICAL_PROGRESS_AGREEMENT | PASS | offline analysis of existing evidence, 2026-10-30 | 17 displayed blocks, revisions monotonic 1→9. The final block equals `OMC/engine-status.stdout.log` progressChecklist except the `mode=` label (auto vs none: status is a modeless read). History: CREATED + 8 STEP_COMPLETED |
| 22 | MODULE_NATIVE_TERMINAL_PROGRESS | NOT_TESTED | headless `codex exec`; nativeUiCertified false | `OMC/report.json` presentation |
| 23 | ARTIFACT_INTERRUPTION_RESUME | NOT_TESTED | no artifact mode | — |
| 24 | ARTIFACT_LIVE_LOCK | NOT_TESTED | no artifact mode | — |
| 25 | ARTIFACT_ABANDONED_LOCK | NOT_TESTED | no artifact mode | — |
| 26 | ARTIFACT_READONLY_REFUSAL | NOT_TESTED | no artifact mode | — |
| 27 | ARTIFACT_OPERATOR_DECISIONS | NOT_TESTED | no artifact mode | — |
| 28 | ARTIFACT_LIVE_CODEX_MCP_CONNECTIVITY | NOT_TESTED | no artifact mode | — |
| 29 | ARTIFACT_CANONICAL_PROGRESS_AGREEMENT | NOT_TESTED | no artifact mode | — |
| 30 | ARTIFACT_NATIVE_TERMINAL_PROGRESS | NOT_TESTED | no artifact mode | — |
| 31 | INSTALLED_MCP_STDIO_CONNECTIVITY | PASS | diagnostic only | `UB/registry-mcp-verified.stdout.log` |
| 32 | ENGINE_REGRESSIONS_NODE24 | PASS | ran at 874806f; the payload contentHash is unchanged at d7eb28c | `UB/engine-regressions-node24.result.json` (1168/1168) |
| 33 | PROVIDERS_REGRESSIONS_COMBINED | PASS | at 874806f | `UB/provider-coverage.json` |
| 34 | TYPESCRIPT_REGRESSIONS_APPROVED | PASS | at 874806f | `UB/typescript-regressions-approved.result.json` |
| 35 | NODE_22_13_ENGINE_TEST_COMPATIBILITY | FAIL | test-runtime limitation, unchanged | `UB/engine-regressions-approved.result.json` |
| 36 | OTHER_PROVIDER_PLATFORM_LIVE_ACCEPTANCE | NOT_TESTED | Codex on WSL2 only; no other OS or provider claim | — |
| 37 | EVIDENCE_SOURCE_RELEASE_PRESERVATION | PASS | re-checked 2026-10-30 | `sha256sum -c` OK for the acceptance top level, `A3`, `UB`, `PRE` and `M15_upload_20261030`. Candidate clean at d7eb28c. Vault copy byte-identical (`V/manifests/`) |

## Sign-off rows the old matrix did not carry

| # | Item (contract source) | Status | Qualifier | Evidence |
|---|---|---|---|---|
| A1 | Harness identity + exact-SHA CI ("Immutable release SHA/digest…") | NOT_TESTED | 17/17 runner tests on Node 22.13/26.8.2. No CI at d7eb28c (unpushed). Toolkit CI 40685834989 covers 874806f only | `m15-entry-guard-fix-20261030T190800Z/node22.txt`, `node26.txt` |
| A2 | OS isolation + record continuity (§Security limitation) | PASS | assurance BEST_EFFORT_FILESYSTEM_EVENTS (documented limit) | `OMC/report.json` security: 6 RO paths, 1 rename event, 0 violations |
| A3 | One invocation, no rescue, no repair ("Non-negotiable boundary") | PASS | the preflight refusal (exit 91) came before the provider launched, so it was not an attempt | `A3/preflight-refusal-1.json`, `A3/official-run.sh` |
| A4 | Disposable credentials ("Non-negotiable boundary") | NOT_TESTED | no record identifies the account. Owner attestation required (PLAN §2) | session records cited in PLAN §2 |
| A5 | F1 first-setup `--registry` omission | PASS | OWNER/GPT DISPOSITION: two -32603 errors, recovered without rescue. The accepted discounts result is preserved and not repeated | `OMC/agent.stdout.log` lines 9, 15, 25, 45 |
| A6 | Bootstrap/registration confirmation conforms to the contract | FAIL | contract and implementation contradict each other. Ruling required (PLAN §3) | PLAN §3 |
| A7 | Final independent (GPT) acceptance | NOT_TESTED | pending | — |

Every row is assigned a status above; none is left blank. A provider/platform marked `NOT_TESTED` must not be marketed as certified.

## Functional verifier assertions (separate: not certification rows)

`m14-discounts` verifier, pinned sha256 `a0055e2d9571f86d27bae315f18ea8717686efefed6e36e1a633d9ed95bc52e7`, run by the trusted runner on the migrated `src/features/discounts/index.js`: **37/37 pass, 0 failures** (`OMC/verifier-result.json`, `OMC/independent-verify.stdout.log`).

| Group | IDs | Pass |
|---|---|---|
| API | API-001 | 1/1 |
| Quote behavior | Q-001 … Q-016 | 16/16 |
| Errors | E-001 … E-012 | 12/12 |
| validateCoupon | V-001 … V-006 | 6/6 |
| Differential vs legacy | DIFF-001 (3000 generated carts), DIFF-002 (no input mutation) | 2/2 |

These assertions back only row 10. They do not count toward any other row.
