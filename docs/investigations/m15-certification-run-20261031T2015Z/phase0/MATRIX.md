# All rows carried forward - historical diagnostics only

Candidate disposition: **SUPERSEDED**, not certified. Every joint-candidate
cell starts **NOT_TESTED** and requires **RE-PROVE**; no old PASS is inherited.
Conditional N/A must be re-established, and an unclaimed provider/platform must
remain explicitly NOT_TESTED. The full-re-proof basis is REPORT.md section 5.

`M` is the original rev-1 matrix; `S0` = RUN/s0/S0.md;
`S2` = RUN/runs/S2.md; `HREV` = FINAL/review.md (historical review, not performed
here). Path abbreviations and unchanged source copies are defined in REPORT.md.
"Historical diagnostic status" preserves qualifications, not a fresh sign-off.
HREV's ACCEPTED/REJECTED is retained separately from the contract's cell status;
rejection for absent evidence is not fabricated execution failure.

| Row | Cell | Rev-1 status | Latest historical diagnostic status / qualifier | Evidence pointer | Joint candidate |
|---|---|---|---|---|---|
| 1 | EXACT_CANDIDATE_PAYLOAD_INSTALL | PASS | PASS at old pin; HREV ACCEPTED | M:21; R1/fresh/report.json candidate; observations identity checks | RE-PROVE |
| 2 | CODEX_CLI_VERSION | PASS | PASS 0.165.0; HREV ACCEPTED | M:22; S0 identity sheet; run report runtime | RE-PROVE |
| 3 | ISOLATED_AUTHENTICATION | PASS, provenance required | Provenance unmet; HREV REJECTED; authenticated execution alone is not attestation | M:23; ADDENDUM C4; HREV row 3 | RE-PROVE |
| 4 | REQUESTED_MODEL_EXECUTION | PASS | PASS gpt-6.1-sol/high; HREV ACCEPTED | M:24; run report runtime / rollout metadata | RE-PROVE |
| 5 | REGISTRY_FAILURE_REPRODUCTION | PASS | PASS diagnostic only; not autonomous migration | M:25; S0 row 5; UB/registry-diagnosis-verified.json | RE-PROVE |
| 6 | SHELL_FAILURE_REPRODUCTION | PASS | PASS diagnostic only | M:26; S0 row 6; UB/sandbox-verified-* | RE-PROVE |
| 7 | SHELL_EXECUTION_UNDER_OFFICIAL_CONTROLS | PASS | PASS historical isolation; HREV ACCEPTED with limitations | M:27; S0 section 4; R1 report.security | RE-PROVE |
| 8 | OFFICIAL_MODULE_COMPLETE | PASS | PASS Attempt 3; F1 retained; R3 also completes resume, not a replacement fresh run | M:28; A3/official-module-complete/report.json; R3/resume/report.json | RE-PROVE |
| 9 | OFFICIAL_UNREGISTERED_MODULE_BOOTSTRAP | PASS, contested | PASS under historical ruling A; docs deviation unresolved in old bytes | M:29; OWNER_PAUSE_1.md; S0 section 5; HREV row 9 | RE-PROVE |
| 10 | OFFICIAL_MODULE_FUNCTIONAL_EQUIVALENCE | PASS | PASS 37/37; HREV ACCEPTED | M:30; A3 verifier-result.json; R3/resume/verifier-result.json | RE-PROVE |
| 11 | OFFICIAL_ARTIFACT_COMPLETE | NOT_TESTED | PASS R1; HREV ACCEPTED | R1/fresh/report.json; R1/result.md | RE-PROVE |
| 12 | OFFICIAL_ARTIFACT_BOOTSTRAP | NOT_TESTED | PASS R1 under historical AUTO ruling | R1/result.md; R1/fresh/report.json | RE-PROVE |
| 13 | OFFICIAL_ARTIFACT_FUNCTIONAL_EQUIVALENCE | NOT_TESTED | PASS M13 36/36; HREV ACCEPTED | R1/fresh/independent-verify.stdout.log; R1/result.md | RE-PROVE |
| 14 | OPENSPEC_REJECTION_AND_CORRECTION | NOT_TESTED | NOT_TESTED / UNMET: no authentic rejection; HREV REJECTED | S2; R2/result.md; OWNER_PAUSE_1.md D8; D:30-32 | RE-PROVE |
| 15 | MODULE_INTERRUPTION_RESUME | NOT_TESTED | PASS R2 checkpoint plus R3 verified resume | R2/interrupt/report.json; R3/resume/report.json, resume-before-status.json | RE-PROVE |
| 16 | MODULE_LIVE_LOCK | NOT_TESTED | PASS safety only; registry errors retained | R4/live-lock/report.json; R4/result.md | RE-PROVE |
| 17 | MODULE_ABANDONED_LOCK | NOT_TESTED | NOT_TESTED / BLOCKED_SCOPE; not a recovery PASS; HREV REJECTED | S0 row 17; s1/report.md; E2; D:38-41 | RE-PROVE |
| 18 | MODULE_READONLY_REFUSAL | NOT_TESTED | FAIL R5, H-1 plus unrecovered F1; HREV REJECTED | R5/read-only/report.json; R5/result.md | RE-PROVE |
| 19 | MODULE_OPERATOR_DECISIONS | NOT_TESTED | Historical conditional NOT_APPLICABLE, zero genuine stops; HREV ACCEPTED applicability only | S2; OWNER_PAUSE_1.md D4; D:33-35,255-256 | RE-PROVE |
| 20 | MODULE_LIVE_CODEX_MCP_CONNECTIVITY | PASS | PASS connectivity, not absence of F1; HREV ACCEPTED | M:40; S0 row 20; R2/R3/R4 results | RE-PROVE |
| 21 | MODULE_CANONICAL_PROGRESS_AGREEMENT | PASS | PASS offline progress; not native UI proof | M:41; S0 row 21; HREV row 21 | RE-PROVE |
| 22 | MODULE_NATIVE_TERMINAL_PROGRESS | NOT_TESTED | NOT_TESTED / UNMET: R6 infra, R6b no prompt, R6c no run | R6/result.md; R6b/result.md; R6c/window/NOT_RUN; recordings.json | RE-PROVE |
| 23 | ARTIFACT_INTERRUPTION_RESUME | NOT_TESTED | PASS R7 checkpoint plus R8 verified resume | R7/interrupt/report.json; R8/resume/report.json; S2 | RE-PROVE |
| 24 | ARTIFACT_LIVE_LOCK | NOT_TESTED | PASS safety only; live host-realm owner unchanged | R9/live-lock/report.json; S2 | RE-PROVE |
| 25 | ARTIFACT_ABANDONED_LOCK | NOT_TESTED | PASS same-agent-realm MCP reclaim only; no cross-realm claim | R10/realm-abandoned-lock/report.json lock; S2; s1/report.md | RE-PROVE |
| 26 | ARTIFACT_READONLY_REFUSAL | NOT_TESTED | FAIL R11, H-1 and untyped filesystem error; HREV REJECTED | R11/read-only/report.json; S2; observations rollout pointers | RE-PROVE |
| 27 | ARTIFACT_OPERATOR_DECISIONS | NOT_TESTED | Historical conditional NOT_APPLICABLE; no human decision-path proof | S2; OWNER_PAUSE_1.md D4; HREV row 27 | RE-PROVE |
| 28 | ARTIFACT_LIVE_CODEX_MCP_CONNECTIVITY | NOT_TESTED | PASS R1; HREV ACCEPTED | R1/result.md; R1/fresh/report.json | RE-PROVE |
| 29 | ARTIFACT_CANONICAL_PROGRESS_AGREEMENT | NOT_TESTED | PASS offline; not native UI proof | R1/result.md; R1/fresh/engine-status.stdout.log; HREV row 29 | RE-PROVE |
| 30 | ARTIFACT_NATIVE_TERMINAL_PROGRESS | NOT_TESTED | NOT_TESTED / UNMET despite R12 runner functional PASS; recording missing | R12/native/report.json; R12/result.md; recordings.json | RE-PROVE |
| 31 | INSTALLED_MCP_STDIO_CONNECTIVITY | PASS | PASS diagnostic only; Copilot equivalent is G1 GAP | M:51; UB/registry-mcp-verified.stdout.log; P0 | RE-PROVE |
| 32 | ENGINE_REGRESSIONS_NODE24 | PASS | Historical PASS reused only because payload unchanged; invalid reuse premise for joint candidate | M:52; S0 row 32; UB/engine-regressions-node24.result.json | RE-PROVE |
| 33 | PROVIDERS_REGRESSIONS_COMBINED | PASS | Historical PASS on old payload | M:53; S0 row 33; UB/provider-coverage.json | RE-PROVE |
| 34 | TYPESCRIPT_REGRESSIONS_APPROVED | PASS | Historical PASS on old payload | M:54; S0 row 34; UB/typescript-regressions-approved.result.json | RE-PROVE |
| 35 | NODE_22_13_ENGINE_TEST_COMPATIBILITY | FAIL | Targeted fixes PASS, test 430 SKIP; no full 22.13 suite; HREV accepted only that limited scope | M:55; S0 row 35; Node phase-2 report gates/risks; I10 | RE-PROVE |
| 36 | OTHER_PROVIDER_PLATFORM_LIVE_ACCEPTANCE | NOT_TESTED | NOT_TESTED; HREV accepts scope restriction, not a provider/platform PASS | M:56; S0 row 36; D:46-51 | RE-PROVE / explicitly NOT_TESTED if unclaimed |
| 37 | EVIDENCE_SOURCE_RELEASE_PRESERVATION | PASS | HREV REJECTED absent copy proof; later FINAL copy assertion retained, not newly accepted | M:57; ADDENDUM C1; HREV row 37; FINAL/report.md section 6; I12 | RE-PROVE |
| A1 | Harness identity + exact-SHA CI | NOT_TESTED | Historical two-harness PASS; exact pairs verified, not a joint-candidate pin | s1/report.md; s1/native-fix/report.md; observations.json | RE-PROVE |
| A2 | OS isolation + record continuity | PASS | Historical PASS with BEST_EFFORT_FILESYSTEM_EVENTS limitation | S0 section 4; R1 report.security; D security limitations | RE-PROVE |
| A3 | One invocation, no rescue, no repair | PASS | Historical scored invocations claimed one/no rescue; R6/R6b excluded; no blanket HUMAN_ATTESTED upgrade | S2; R6/result.md; R6b/result.md; R12/result.md; HREV A3 | RE-PROVE |
| A4 | Disposable credentials / revocation | NOT_TESTED | NOT_TESTED / owner evidence missing; HREV REJECTED | ADDENDUM C2/C4; HREV A4; FINAL/report.md section 5 | RE-PROVE |
| A5 | F1 first-setup registry disposition | PASS, disposition pending | FAIL finding for unrecovered R5; recovered Attempt 3/R2/R4 retained | OWNER_PAUSE_1.md D3; R2/R4/R5 results; HREV A5 | RE-PROVE |
| A6 | Bootstrap/registration contract conformance | FAIL | Historical ruling A accepted implementation; old contract text still wrong | S0 section 5; OWNER_PAUSE_1.md; HREV A6; E3 | RE-PROVE |
| A7 | Final independent acceptance | NOT_TESTED | Historical REJECT / NOT_CERTIFIED; now SUPERSEDED, no new review/closing | FINAL/review.md final verdict; FINAL/report.md; current owner ruling | RE-PROVE on new candidate only |

`A3/`, `UB/` and `PRE/` here retain M's definitions:
`m15-codex-acceptance-20261030T1715Z/attempt3/`,
`m15-codex-certification-20261029-unblock/`, and
`m15-codex-certification-20261028/`, respectively, under INV.
Bare run paths are under RUN/runs. S0/S1 source paths are under RUN.
The Node phase-2 report is `INV/m15-node2213-phase2-20261031T1838Z/report.md`.

No cell is omitted: 37 certification rows and seven sign-off rows.
Copilot must receive its own matrix against the joint identity; mapped Codex
successes do not certify Copilot. T1's cross-provider identity effect is FULL.
