# v1.6.2 release — RELEASED

Release SHA: `336531c4b5a23814f6e35699bedb5315003c3542` ("Prepare 1.6.2
release candidate"). This commit only bumps the version on top of M10 `dd74799`.
Tag `v1.6.2` (annotated, object `262c49cd`) points at it. Release:
<https://github.com/icordoba8/artifact-migration-toolkit/releases/tag/v1.6.2>
(stable, Latest, `immutable: true`, published 2026-10-24T15:29:11Z). Record
commit `0ed58b8` fast-forwarded `main`. v1.6.1 and earlier are unchanged.

```
UBUNTU CI: SUCCESS
WINDOWS CI: NOT_RUN (not required)
```

## Candidate (cloud session, 2026-10-24)

| Step | Result |
| --- | --- |
| Post-merge CI on `dd74799` | toolkit + 3 shards + provenance: success |
| Bump | `package.json` x2, `skills:lock`, `providers:sync`, `providers:check` (62 files in sync) |
| Targeted tests | `release-version-discipline` + `providers-sync`: 37 pass, 0 fail, 1 skipped (`targeted-tests.log`) |
| RC CI, exact SHA (run 40056848262, `release/v1.6.2`) | toolkit (ubuntu-latest) + shards 1/2/3 + provenance: success (`ci-rc-336531c.tsv`) |
| Main CI, exact SHA (run 40057922259, `main`) | toolkit (ubuntu-latest) + shards 1/2/3 + provenance: success |

The cloud session could not publish because of session policy. Its tag push was
dropped by the proxy, and the releases API returned 403. See git history
`31d99a1` for that blocker.

## Publication (local WSL2, 2026-10-24)

Clean detached worktree at `336531c`. After `pnpm install --frozen-lockfile`, the
10 engine bin modes (100644→100755) were restored from HEAD, and the tree was
clean before any release command ran.

| Step | Result (`publication/`) |
| --- | --- |
| `release:check` | no blockers, contentHash `sha256:67c9f36a…8f82`, **matches** |
| `release:build` | manifest pin `sha256:f574cd82…51f9`, **matches**; archive `sha256:45100237…b300` |
| `release:verify dist/artifact-migration-tools-1.6.2` | `verified: true`, no mismatches |
| Installed smoke (offline, staged archive, Claude, project scope; `smoke.mjs`) | 17/17 PASS |
| Tag + `gh release create --verify-tag` | asset `artifact-migration-tools-v1.6.2.tar.gz`, GitHub digest `sha256:451002370969660361d56c4c97c0a1434b48088bef164f771a041bd5fceab300` = local archive |
| `release:record 1.6.2` | contentHash `sha256:67c9f36a…8f82` read from the published manifest; commit `0ed58b8` |
| Main CI on record commit `0ed58b8` (run 40107217451) | toolkit (ubuntu-latest) + shards 1/2/3 + provenance: success |

**The archive digest differs from the cloud build (`19fe13a0…`).**
`buildReleaseArchive` normalizes owner and group but not mtimes or gzip headers,
so archive bytes are not reproducible across builds. The identity anchors are
contentHash and the manifest pin, and both matched. Before publication, the
`Archive sha256` line of `release-notes.md` was corrected to the asset that was
actually uploaded. That line is the only difference from the cloud draft.

## Installation and real-agent acceptance

Full record: [`docs/releases/v1.6.2-acceptance.md`](../../releases/v1.6.2-acceptance.md); raw files are in `acceptance/`.

| Check | Result |
| --- | --- |
| Install | `pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit --skill migrate-artifact -a claude-code -y`: exit 0; installed `.claude/skills/migrate-artifact` byte-identical to `skills/migrate-artifact` at `336531c`; stamp 1.6.2, `source: repository` |
| Scored invocation | exactly one `claude -p "/migrate-artifact src/utils/slugify.js"`, 15:32:53–15:37:05Z (4m12s), exit 0 |
| Corrective prompts | none: the transcript has one user turn (the slash command) and one session |
| Engine | installed `artifact-migrate --status --json`: `COMPLETE`, record `slugify-64048cadb324`, revision 8, artifact format 14, resolution `TARGET_REUSE` |
| Installed identity | receipt + `build-identity.json` = 1.6.2 / `336531c` / `67c9f36a…8f82`; store pin `f574cd82…51f9`; `release:verify` of the installed store `verified: true` |
| Independent verifier | `verify.mjs` sha256 `4664f86d…6ae6`, outside the consumer and read-only: 27/27 PASS |
| Tamper checks | installed skill bytes unchanged pre/post; verifier hash unchanged; `src/` and `package.json` unchanged |

**VERDICT: FUNCTIONAL_PASS** (Claude Code 2.1.310, `claude-opus-5-5`, Linux WSL2). This is not OS-isolated certification.
