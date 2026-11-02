# Owner instruction 4 (pasted 2026-10-31 ~23:26Z; HUMAN_ATTESTED, verbatim)

HARD DEADLINE: 21:00 America/Bogota (02:00Z). The final verdict and report must exist by then. This supersedes the previous overall deadline. Owner-issued.

TIMELINE (Bogotá; cut-offs are hard)
- 18:35: report the literal-text verdict for rows 17, 14, 19 and 27 in 5 lines or fewer, and state whether NOT_CERTIFIED is already certain. Do not wait for my reply; continue regardless.
- 18:35–20:05: R7, R8, R9, R10 and R11, automatically and back-to-back, with no notifications between runs. In parallel, diagnose and fix the R6 native bootstrap failure (account/read -32603), harness-only, under the S1 rules.
- No new scored run may start after 20:10. Any run not started is recorded as NOT_RUN, with the reason.
- R6 and R12 (native): only if the model-free native bootstrap check passes. Notify me once, with one copy-paste block for both, by 20:10 at the latest. If the check does not pass by 20:10, record R6 and R12 as FAILED_BOOTSTRAP findings and skip them.
- 20:35 at the latest: start S3, the independent review. Capped at 15 minutes; if it does not finish, record REVIEW_INCOMPLETE.
- 20:50: S4. Give me one block with both the account-provenance statement and the revocation step. The vault copy and the final report are automatic.
- 21:00: deliver the final verdict (CERTIFIED or NOT_CERTIFIED), whatever is still pending.

RULES
- Never abort a running invocation to meet a cut-off. Simply do not start new work after a cut-off.
- Pacing: if the 5-hour usage window would exceed 90%, skip the remaining runs (record NOT_RUN: ALLOWANCE) instead of waiting.
- All security invariants, the no-rescue rule, HUMAN_ATTESTED rules and evidence rules are unchanged. The deadline never justifies skipping a verification or relabeling a result.

FINAL OUTPUT AT 21:00 (as concise as possible)
1. Verdict.
2. Per run: scenario | functional | operational | verifier.
3. Unmet items, each with its reason.
4. What a follow-up candidate would need in order to certify.
5. Evidence path and SHA256SUMS.

## Application
- Rows 17/14/19/27 literal-text report delivered ~23:30Z (18:30 Bogotá), before the 18:35 cut-off.
- R7–R11 started 23:27:42Z, done 23:35:59Z (`drive.log`).
- Native fix committed, pushed, CI green 23:47Z. Native window opened 23:48:05Z (`native-window.opened.utc`). One block was sent to the owner at ~23:48Z, before 20:10 Bogotá.
- Owner instruction 3 (minimize manual steps; wt.exe window; recording lookup by Claude) was applied through `native-window.sh`. Its text is in the session transcript (`~/.claude/projects/-home-utmwac-artifact-migration-toolkit/9c9dae19-…jsonl`).
