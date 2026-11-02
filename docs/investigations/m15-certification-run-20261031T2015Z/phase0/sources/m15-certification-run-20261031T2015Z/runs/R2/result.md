# R2: module interruption (row 15, stage 1)
- Invocation: 1, launch 22:30:19.760Z → 22:32:37.929Z ≈ **2 min 18 s / 30 min: WITHIN**. Rescues: 0.
- Functional: **INTERRUPTED_CHECKPOINT** at rev 2, `DISCOVERY_COMPLETENESS`. The runner stopped the agent after the first committed, unlocked checkpoint (SIGTERM → SIGKILL escalation). No lock or journal left; record continuity 0 violations.
- MCP: 2 `migration_status` + 4 `migration_run`, 0 approval refusals.
- F1 recurred: MCP `-32603` "Migration registry is not configured" (line 13), and a CLI exit 1 with the same message. The agent re-read the skill and bootstrapped with `--registry` at line 47 (exit 0), within this invocation, with no rescue. D3: accepted as autonomously recovered.
- OpenSpec: the proposal was accepted on the first bootstrap. All 11 regex leads are skill/contract reads or that successful bootstrap. **0 genuine rejections.**
- Decision stops: 0. Tokens: no `turn.completed` (killed mid-turn by design); the rollout has the counts.
