# S1 addendum: native Codex TUI bootstrap fix (R6 HARNESS_DEFECT)

- Diagnosis and classification: `../../runs/R6/result.md` (no model turn; bisect captures in `runs/R6/diagnosis/`).
- Commit `1a9661b3aba58d7e8fe41076d5e72b3d1d87701a` (parent 64a1a4c), pushed to `toolkit` `cert/m15-codex-uidmap-20261030`. The worktree is `/home/utmwac/amt-m15-native` (detached, same remote branch). It was a separate worktree so that headless R7–R11 could keep running at 64a1a4c with a clean tree.
- Scope: harness only (`scripts/agent-e2e-acceptance.mjs`, `test/agent-e2e-acceptance.test.mjs`). Engine, broker, isolation, grants and owner-proof are unchanged. Headless argv is unchanged (test asserts this).
- Tests on Node 22.13.0: `agent-e2e-acceptance.test.mjs` + `architecture.test.mjs`, 63/63 pass (`harness-and-architecture-tests-node22.13.log`). Revert control: both native tests fail without the code change (session record).
- `/ponytail-review` of exactly `commit-64a1a4c-to-1a9661b.patch` (sha256 `ec6ed7205ec11b75c036fdb6d810f86450a1fc675c1440f14c846f4abb6ffc27`): "Looks good. Ship." No findings.
- Re-pin: `m15-patch.sh` pre-commit = post-commit = `244b32d897c06b8e537cb6f3e73862453bf720bc39d96a6c543fc324282a423a` (64/64). `git grep` found no tracked file storing a digest.
- **AMT_HARNESS_COMMIT = 1a9661b3…, AMT_PATCH_SHA256 = 244b32d8…** for native runs R6b and R12. Historical: `778d1d5b…` ↔ 64a1a4c (R1–R5, R7–R11); `35d5cb61…` ↔ 4236402.
- CI: run 41253081464 at 1a9661b, success 5/5 jobs (`run-41253081464.json`).
- Model-free native bootstrap check with the fix (`runs/native-check.mjs`): PASS on R6b and R12 consumers. Idle marker present, no error, alive after 15 s; rollouts 10→10; consumers clean (`runs/R6b/precheck`, `runs/R12/precheck`).
