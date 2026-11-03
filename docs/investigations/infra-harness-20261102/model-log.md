# Model log — infra harness 20261102

Fallback policy (unchanged): Opus 5.5 → GPT-6 Astra → different family, on trigger only, logged here.

| Window (local, -05:00) | Executor / model | Role | Committed |
|---|---|---|---|
| 19:18–19:22 | GitHub Copilot CLI, **GPT-6 Astra** — session started by mistake (owner statement, OWNER DECISION A1) | Interrupted attempt; staged T3 bytes, left test scratch | Nothing. Its three logs are preserved verbatim, as evidence only, in `checks/prior-attempt-19-19/`; its 94 MB scratch tree was moved out of Git |
| Stage 1 | GitHub Copilot CLI, Claude Opus 5.5 | T3 carry, `plan.md` | `c5fb8eb306005d4f38327ce0859e20cee49cc175` (T3), `b47ddc4` (plan) |
| Stage 2 | GitHub Copilot CLI, Claude Opus 5.5 (same session as the owner decision) | G1–G7, A1–A8 | this branch, see PR |

The 19:18 attempt was not a fallback: no trigger fired. No fallback model was used in Stage 1 or Stage 2.

T3 byte check (re-run in Stage 2): each of the ten carried files is identical between
`1a9661b3aba58d7e8fe41076d5e72b3d1d87701a` and the T3 commit `c5fb8eb306005d4f38327ce0859e20cee49cc175`
(`git diff --quiet 1a9661b3aba58d7e8fe41076d5e72b3d1d87701a c5fb8eb306005d4f38327ce0859e20cee49cc175 -- <file>`, exit 0 for all ten).
Whatever that session staged, the committed T3 bytes are the verified `1a9661b` lineage.
