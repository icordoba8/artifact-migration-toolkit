Target: `336531c4b5a23814f6e35699bedb5315003c3542`
Archive sha256: `451002370969660361d56c4c97c0a1434b48088bef164f771a041bd5fceab300`
Manifest pin: `sha256:f574cd822400071c7b4dd5ede1d60360b288650f26488e8209336c1bf04951f9`
Content hash: `sha256:67c9f36afc8d9e3887686048c4e653e726b1aea0fba04509822aec20b3748f82`

v1.6.2 is a patch release on top of v1.6.1 that ships M10 (#10, `dd74799`). The release commit is a version-bump-only commit (package identities, skill release identities, generated provider projections). v1.6.1 and earlier releases are unchanged.

## Changes (M10)

- **Single-invocation `migrate-artifact` stabilization.** Artifact gate checks moved into `artifact-gates.mjs`; the skill and `artifact-contract.md` describe the one-invocation loop and its stop outcomes.
- **FINALIZE → COMPLETE crash recovery.** An interrupted FINALIZE (including the version-2 journal) recovers to `COMPLETE` on the next invocation.
- **Honest Ponytail evidence classification.** Ponytail evidence is `AGENT_ASSERTED`: the engine verifies the cited file, hash, binding and order, never that a Ponytail skill ran. No independent Ponytail attestation is claimed.

## Validation

```
UBUNTU CI: SUCCESS
WINDOWS CI: NOT_RUN (not required)
```

- Exact-SHA Ubuntu CI on `336531c`: all three `toolkit shard N/3 (ubuntu-latest)` jobs and `toolkit (ubuntu-latest)` succeeded.
- `release:check` (no blockers), `release:build`, `release:verify` (`verified: true`), and an installed smoke of the staged bundle (Claude provider, project scope).
- Installation and real-agent acceptance on this published release are recorded in `docs/releases/v1.6.2-acceptance.md`.

## Scope and limitations

- Claude on Linux only: functional real-agent evidence for `migrate-artifact`. This is not OS-isolated certification, and no operator-decision E2E was run.
- Codex, OpenCode and Copilot adapters are packaged but NOT_TESTED for this release.
- Windows compatibility has not been validated.
