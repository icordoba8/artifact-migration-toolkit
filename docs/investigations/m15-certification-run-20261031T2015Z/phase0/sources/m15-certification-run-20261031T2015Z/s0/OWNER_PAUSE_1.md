# OWNER PAUSE 1 reply (HUMAN_ATTESTED, verbatim)

Received: 2026-10-31T21:53:34Z (recorded at receipt; the message carries no timestamp of its own)

```
GO + A

Bootstrap AUTO ruling (A): the implementation governs. Under the auto policy, self-confirming bootstrap and registration is the intended behavior. Record the contract text (contract.md:1063-1066 and :1092-1094) as a known documentation deviation, to be corrected in the next release candidate. No bundle change in this certification.

VAULT_COPY_DESTINATION: <path outside WSL>

D3 (F1, -32603 errors): accept, but only where the evidence shows each error was recovered autonomously within the same invocation, with no rescue and no altered state. Any unrecovered error stays a finding.

D4 (rows 19 and 27): close them as NOT_APPLICABLE only if the literal row text allows it and every run's logs show zero genuine decision stops. If a decision stop occurs, I answer it and you record it as HUMAN_ATTESTED. Never induce a decision to exercise the path.

D8 (row 14): apply the literal row text. If it requires an authentic rejection/correction to be demonstrated, the row stays unmet unless one genuinely occurs; do not close it as "not observed". If the text is conditional, close it as NOT_APPLICABLE with evidence.

Row 17: before S1, check whether the literal requirement text accepts the documented safe refusal plus the cross-namespace limitation. If it does not, keep it BLOCKED_SCOPE and do not reinterpret it.

Pacing: before each run, check Codex's 5-hour usage window. If the next run could push it past 90% (use the Attempt 3 measurement of about 10 points per run), wait for the window to reset instead of starting the run. A wait is not a stop and does not count against the per-run budget. Extend the overall deadline by the exact wait time, and record every wait.
```

## Literal-text application (executor)
- D4: docs/agent-e2e-acceptance.md:33-35 "with human participation only at a genuine `OPERATOR_DECISION`" and :258-259 "including legitimate operator decisions when required" are conditional. Rows 19/27 → NOT_APPLICABLE iff all run logs show zero genuine decision stops.
- D8: :30-32 "An authentic OpenSpec-rejection case: observe the agent correct its own authored proposal and retry without rescue" requires a demonstration. Row 14 stays unmet unless one genuinely occurs.
- Row 17: :38-41 "a provably abandoned lock, a live lock and a sandbox deliberately configured read-only; only the first two may proceed". Proceeding is required, so a safe refusal does not satisfy it. It stays BLOCKED_SCOPE.
- VAULT_COPY_DESTINATION is still a placeholder; it is required before S4.
