# R6: module native UI (row 22): FAILED AT BOOTSTRAP, no model turn

## Owner report (HUMAN_ATTESTED, verbatim, received 2026-10-31 ~23:10Z)
```
R6 FAILED AT BOOTSTRAP. Recording: <path from Step 2>
Recording was on before launch (date -Is 2026-10-31T18:07:50-05:00 is visible at the start).

Launch 1 output:
Error: account/read failed during TUI bootstrap: account/read failed: failed to load workspace requirements: invalid data (code -32603)
AGENT_ACCEPTANCE_ERROR: Engine status failed after agent invocation; logs preserved
I never typed the /start-migration line; Codex did not open its input screen.

Launch 2: I re-ran the same command once by mistake. The harness refused it ("Output must be empty; never overwrite earlier evidence"). Nothing else was typed.
```

## Launch 1 (the only Codex start)
- Runner `startedAt` 2026-10-31T23:08:08.556Z. `native/native.typescript`: "Script started on 2026-10-31 18:08:08-05:00 … Script done on 2026-10-31 18:08:09-05:00 [COMMAND_EXIT_CODE="1"]". The TUI drew its banner and composer, then printed `Error: account/read failed during TUI bootstrap: … failed to load workspace requirements: invalid data (code -32603)` and exited.
- `native/report.json`: verdict FAIL, "Engine status failed after agent invocation; logs preserved" (`engine-status.stderr.log`: no migration registry, meaning no record exists). `agent.exitCode` 1.
- **Provider/model turn: none.** No rollout file was created in the profile after 23:00Z (`find …/codex/sessions -newermt 23:00Z` is empty), so no thread was started and no prompt was sent. Only the TUI's own state changed: `config.toml` gained `[tui] screen_reader_detection_done = true` at 18:08:08.925 −05:00, plus sqlite WAL files.

## Launch 2 (refused before any Codex start)
- The runner refused with "Output must be empty; never overwrite earlier evidence". It never reached the provider.
- **Wrapper defect (mine):** `launch-native.sh` rewrote `launch.start`, `launch.end`, `launch.exit` and `operator-seccomp.txt` on each call. The copies here (start 23:08:52.396Z, end 23:08:53.543Z, exit=1) are **Launch 2's**. Launch 1's own record survives in `native/` (report.json, typescript, timing). Fixed: the new launcher refuses an existing run directory and writes per-launch files.

## Diagnosis (model-free; `diagnosis/`)
- `account/read` through the bare app-server succeeds outside isolation and inside the runner's `isolated()` with R6's read-only set (`account-read*.mjs`). So the profile/auth store, CODEX_HOME, the isolation, the read-only mounts and the provider are excluded.
- The TUI with the runner's exact native argv reproduces the error **outside isolation** (`captures/C_full.ts`), and also inside it (`tui1.typescript`).
- Bisect (`tui-variant.mjs`, `argv.mjs`; captures A–N):
  - Plain TUI: ok.
  - `projects` trust + `approval_policy` only: ok.
  - Dropping all `mcp_servers.start-migration.*` overrides: ok.
  - Any one class alone (env_vars, the per-tool approve grants, or enabled_tools): FAIL.
  - Full argv plus `mcp_servers.start-migration.command` (and `args`) equal to the installed entry: ok.
- **Root cause:** at bootstrap, Codex 0.165's TUI calls `account/read`, which loads "workspace requirements". That load validates the `-c` override layer on its own. The runner's grant-only override makes `mcp_servers.start-migration` a table with no transport (`command`), so it fails with "invalid data". `codex exec` (R1–R5) does not call `account/read` at bootstrap, so headless runs never hit it.
- **Classification: HARNESS_DEFECT.** It is reproducible, deterministic, and caused by the runner's own native argv. The fix follows the S1 rules before any rerun.

## Fix (harness only, native only)
`commandFor(..., native, mcpServer)` also restates `mcp_servers.start-migration.command`/`args`. The runner derives them from the verified release (receipt node + `<release>/packages/migration-engine/src/mcp-server.mjs`) and refuses before launch unless the installed `.codex/config.toml` entry equals them exactly. The installed entry is not modified. The headless argv is unchanged.

Model-free bootstrap check with the fix, on the fresh rerun consumer R6b (`captures/check-fixed.ts`): PASS. The TUI reached its idle state (OSC 7501 `state=idle:app=codex`), printed no error, and was alive after 15 s. 0 new rollouts; consumer clean.

## Status
R6 is not scored: no invocation reached the model. The rerun goes on the fresh consumer R6b with a new output directory, after the fixed harness is reviewed, committed, pushed and green in CI.
