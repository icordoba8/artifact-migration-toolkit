# R6b: module native rerun (row 22) at harness 1a9661b: no invocation reached the provider

- Window opened by Claude via wt.exe at 23:48:05Z (`../native-window.opened.utc`). Stamp 23:48:07Z. Owner Enter at 23:59:26.576Z.
- Model-free bootstrap check: PASS (`window/native-check.json`); rollouts 10→10.
- Codex TUI launch 23:59:43.131Z → exit 00:10:32.940Z (`window/launch.*`). The TUI reached its idle input screen (OSC 7501 `state=idle`). **The fix works**: no account/read error.
- **No prompt was submitted.** `native/native.typescript` (15,019 bytes) shows no typed invocation (0 occurrences of `start-migration discounts`). No rollout was created for that period: the only new rollout after the stamp is `rollout-2026-10-31T19-10-56-01a19471-…`, which is R12. Codex printed `Session ID: 01a19467-b46d-79b0-bb40-aa9bbdf33f93` on exit, and no session file exists for it.
- Runner verdict FAIL, "Engine status failed after agent invocation" (no migration registry, i.e. no record). This is a consequence of zero model turns, not a functional result.
- Context: the owner replied "done" at ~00:00Z, while Codex was still waiting for the typed line. The runner prints "Type exactly once: …" before Codex draws its screen, so the TUI may have pushed it out of view. Claude re-sent the line at ~00:01Z.
- **Recording: none found.** No .mp4 in `C:\Users\icordoba\Videos\Captures` or elsewhere under the user profile newer than 23:45Z (search 00:19Z).
- Classification: NOT_SCORED (no provider invocation). Row 22 is not demonstrated by R6b.
