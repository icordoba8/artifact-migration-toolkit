# v1.6.2 release attempt — BLOCKED at publication

Release candidate: `336531c4b5a23814f6e35699bedb5315003c3542` ("Prepare 1.6.2
release candidate"): a version bump only on top of M10 `dd74799`. `main` was
fast-forwarded `dd74799..336531c` without force. **No tag and no GitHub Release
exist.** v1.6.1 and earlier are unchanged.

| Step | Result |
| --- | --- |
| Post-merge CI on `dd74799` | toolkit + 3 shards + provenance: success |
| v1.6.2 unused | no tag, no release, not in `released-versions.json` |
| Bump | `package.json` x2, `skills:lock`, `providers:sync`, `providers:check` (62 files in sync); same 12-file shape as the 1.6.1 bump |
| `release:check` | no blockers; contentHash `sha256:67c9f36a…8f82` |
| Targeted tests | `release-version-discipline` + `providers-sync`: 37 pass, 0 fail, 1 skipped (`targeted-tests.log`) |
| RC CI, exact SHA (run 40056848262) | toolkit (ubuntu-latest) + shards 1/2/3 + provenance: success (`ci-rc-336531c.tsv`) |
| Merge | fast-forward of `main` to `336531c` (same SHA, procedure used for v1.6.1) |
| Main CI, exact SHA (run 40057922259) | toolkit (ubuntu-latest) + shards 1/2/3 + provenance: success |
| `release:build` | archive `sha256:19fe13a09948905570d4d7c09b2904f6625a225356744489299367e46beeeec5`, manifest pin `sha256:f574cd822400071c7b4dd5ede1d60360b288650f26488e8209336c1bf04951f9` |
| `release:verify` | `verified: true`, no mismatches |
| Installed smoke | Claude adapter, project scope, staged bundle; `build-identity.json` = 1.6.2 / `336531c` / `67c9f36a…`; `artifact-migrate --status` read-only `NOT_STARTED` (`smoke-status.json`) |
| Publication | **BLOCKED**, see below |
| `release:record`, consumer install, real-agent migration | NOT_RUN: each one needs the published immutable v1.6.2 asset |

```
UBUNTU CI: SUCCESS
WINDOWS CI: NOT_RUN (not required)
```

## Blocker

The Claude Code cloud session that ran the release could not create the tag or the release:

- `git push origin v1.6.2`: the proxy dropped the connection ("unexpected disconnect while reading sideband packet").
- `POST /repos/.../git/tags`: HTTP 403 "Write access to this GitHub API path is not permitted through this proxy".
- `POST /repos/.../releases`: HTTP 403 "Creating, editing, or deleting releases is not permitted for this session type".
- `gh release create`: the session blocks GraphQL.

The repository token has admin rights. The refusal comes from session policy and was not bypassed.

## To finish (owner, from an authorized environment)

1. Build from a clean checkout at `336531c` and confirm that `release:check`, `release:build` and `release:verify` reproduce contentHash `67c9f36a…8f82`.
2. Create the annotated tag `v1.6.2` at `336531c`. Publish a stable release (immutable releases are enabled on the repository) with `artifact-migration-tools-v1.6.2.tar.gz` and `release-notes.md` as the body.
3. Run `pnpm release:record 1.6.2` and commit `released-versions.json`.
4. In a fresh disposable consumer, run `pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit --skill migrate-artifact -a claude-code -y`, then make one `claude -p "/migrate-artifact src/utils/slugify.js"` invocation. Check for `COMPLETE`, then run an external SHA-pinned verifier and confirm the installed `build-identity.json`.
