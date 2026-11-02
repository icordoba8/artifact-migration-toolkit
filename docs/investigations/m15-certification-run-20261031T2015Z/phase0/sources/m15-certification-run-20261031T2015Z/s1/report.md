# S1: recovery harness (`/ponytail full`)

- **Scope check (row 17, literal text):** `docs/agent-e2e-acceptance.md:38-41` requires that a provably abandoned lock *proceed*. The module path cannot proceed. Module bootstrap is CLI-only (`src/transport/mcp.mjs:185-191` refuses `migration_bootstrap`), and Codex runs each shell command in a new PID namespace. The engine (`lifecycle/lock.mjs:142-147`) reclaims only in its own realm. **Row 17 = BLOCKED_SCOPE**; the existing host-realm `abandoned-lock` scenario and its documented limitation are unchanged.
- **Row 25 (artifact):** `migrate-artifact/SKILL.md:92` directs MCP `artifact_run`, which takes the lock in the MCP server process (`lifecycle/artifact-run.mjs:209`). New scenario `--scenario realm-abandoned-lock`:
  - Inside the agent's PID namespace, before the agent exists, a trusted step (after `setpriv`, same mounts) acquires the real engine lock and exits without releasing it.
  - A FIFO gate holds the agent until the runner has pinned the owner (realm ≠ host realm) from outside.
  - PASS requires the owner entry to be gone, no lock-removal command in the transcript (`lockRemovals`), and `BOOTSTRAP_PASS`.
- **Tests:**
  - Node 22.13: 32/32 (`harness-tests-node22.13.log`).
  - The new test covers same-realm reclaim → BOOTSTRAP_PASS, a nested PID namespace → ACCEPTANCE_LOCK_NOT_RECLAIMED, manual `rm` → ACCEPTANCE_LOCK_REMOVED, and plant failure → agent never starts and no FIFO is left.
  - Revert controls: the realm check flipped, and the gate cleanup removed. Both fail the test as expected.
  - Architecture: 31/31; `check-architecture.mjs` ok.
- **/ponytail-review:** pass 1 → "fix 1 first" (FIFO left on the plant-failure path), plus 2 nits; all applied. Pass 2 on the final content → **Ship**. That content is the complete patch `778d1d5b…`, delta `814e11aa…`.
- **Commit:** `64a1a4c88147507227ca9bd927191486f6dc28e5` (tree `7ec045a76fd180cc6489e08f2a88645a303396a7`, parent 4236402), 5 files, pushed `4236402..64a1a4c` to `toolkit`.
- **CI:** run 41246968597, success 5/5 on that exact SHA (`ci/`). The new test **skips on CI** (no unprivileged namespaces), like the other isolation tests, so it is proven locally only.
- **Payload unchanged:** no diff under packages/skills/providers; contentHash `sha256:1f9786e2…faaf7`.

## Re-pin (rule satisfied)
| | Value |
|---|---|
| Pre-commit `m15-patch.sh` sha256 | `778d1d5be16f97a0dd9a81d637cdfb3ec96e5e15cfc9e872be24ac752a488533` |
| Post-commit `m15-patch.sh` sha256 | `778d1d5be16f97a0dd9a81d637cdfb3ec96e5e15cfc9e872be24ac752a488533` (64/64 equal) |
| Reviewed content | exactly this patch (review pass 2) |
| Tracked files storing the digest | 0 (`git grep` at HEAD) |
| **New AMT_HARNESS_COMMIT / AMT_PATCH_SHA256** | `64a1a4c88147507227ca9bd927191486f6dc28e5` / `778d1d5be16f97a0dd9a81d637cdfb3ec96e5e15cfc9e872be24ac752a488533` |
| Historical (superseded) | `35d5cb6109b1c4543fededc42cee9b6e0e6d38a0f417448c21ae7ad227fbe296` ↔ `42364020d6db36a60327b271dc83bfbebc4daf4e` |
