# Independent validation: v1.6.3 release candidate

**Verdict: FUNCTIONAL_VALIDATION_ONLY.** The stamped v1.6.3 candidate passes every
release gate, installs cleanly offline, and a real Claude Code `/migrate-artifact`
run on it reached `COMPLETE` with behavioral parity. It is **not** production-certified
security evidence: the agent had no disposable credential (see Isolation), and the
repository's certified runner does not cover `/migrate-artifact`.

This is validation only. It changed nothing in the candidate, PR #13, `main`, tags,
releases, `released-versions.json` or historical evidence branches. No logs are
published; transcripts stay off-repo (`session-transcripts.sha256`).

## Exact candidate

| Item | Value | Check |
| --- | --- | --- |
| Commit | `b441181c0add84453445ba7659155926b850a263` | fetched `release/v1.6.3-rc`, clean detached worktree |
| Tree | `666b2b3487687a9887a0fb83d3b4e82738ba18c1` | equal |
| Base | `852388feee739b069253b3228c649562bd71e835` | merge-base equal, one commit ahead |
| Diff vs main | 12 files, each exactly `"version": "1.6.2"` → `"1.6.3"` | 2 package.json, 2 canonical + 8 provider `release-identity.json` |
| contentHash | `sha256:2d6a0bdc60cf6ba7562287c5444b25305ee42e617698d40ffd645ff00fed91fe` | **equal** to expected (check, build, verify, receipt, record) |
| Staged manifest (pin) | `sha256:62f3b4c85ad849148a5eda553b1e6a811d01a2663b342b7a82a9a7aadaeef4ad` | identical across two independent builds |
| Archive digest | expected `sha256:9e84b8c7…987e` | **not reproducible** (F1): builds gave `f83a7b1b…7133` and `3c90a407…070e` |

## CI and packaging

| Gate | Result |
| --- | --- |
| CI run 40163203925 on exact SHA, attempt 1 | 5/5 success: provenance, shards 1–3, final gate. The final gate took the `reused=false` branch, so it required real shard success |
| `release:check` | `blockers: []`, `versionConflict: null` (after restoring file modes, F2) |
| `release:build` | `blockers: []`, identity v1.6.3 / b441181 / 2d6a0b… |
| `release:verify` (dist and store copy) | `verified: true`, `mismatched: []` |
| `providers:check` | 62 files synchronized |
| `architecture:check` | ok |
| `skills:lock` regeneration | byte-identical no-op; tree stays clean |
| `git diff --check` | clean |
| Skill identities | all 10 stamps 1.6.3; migrate-artifact `b39c1650…`, start-migration `a88cc8ce…`, equal to `skills-lock.json` and the staged manifest |
| Tags | `v1.6.2` still dereferences to `336531c4`; no `v1.6.3` tag |

## Installed smoke

Disposable consumer, store and HOME, with the egress proxy pointed at a dead port.
The skill was copied from the staged bundle and its identity is `source: release`,
bound to b441181 and 2d6a0b…. `runtime.mjs ensure --provider claude` returned
`outcome OK`, `selection: skill`, `skillIdentity: required`, `reusedFrom: store`,
`network: false`, and the engine doctor passed 4/4 (node, git, discovery-parser, knowledge-root).

## Real-agent invocation

- Claude Code `2.1.310`. Model `claude-opus-5-5` (from the init event and `modelUsage`).
  `--permission-mode default`.
- Command: `command.txt`. Allowlist: Read/Write/Edit/Glob/Grep and Bash for `node`,
  `/opt/node22/bin/node`, `git`, `ls`, `cat`, `mkdir`, `head`, `wc`, `diff`, `sha256sum`.
  WebFetch, WebSearch and subagents are disallowed. No `npm`. No bypass mode.
- Fixture: the M13.1 fixture, byte-identical (`legacy/strings.cjs` `9b31168e…`):
  `module.exports = createApi()` with generated `kebabCase`/`snakeCase`, then `module.exports.VERSION`.
- Fresh consumer, with runtime pre-installed through the documented preflight. Fresh agent HOME, `env -i`.

### Attempts (all disclosed)

| Attempt | Outcome | Cause |
| --- | --- | --- |
| 1 | INVALID, no record created | Operator error: I sealed `/tmp/claude-0` read-only, and the CLI's Bash tool needs its per-project temp dir there |
| 2 | INVALID, no record created | Operator error: `ARTIFACT_MIGRATION_TOOLS_STORE` was left out of the agent env. The toolkit refused with a typed `Runtime receipt selection conflict` and changed nothing |
| 3 (scored) | COMPLETE | 52 turns, 51 tool calls, 0 user prompt turns, 4m41s |

Attempts 1 and 2 never reached the engine. In both, the agent stopped and asked; it
did not bypass. Each attempt used a brand-new consumer, never a reset one. Before
attempt 3, the single launcher (`isolation/launch.sh`) was dry-run end to end
(agent → Bash → preflight `OK`) on a separate smoke consumer.

Attempt 3 had 3 permission denials and none were bypassed: Claude Code's "quoted text"
check on one compound command, and two `cd` commands outside the consumer.

## Isolation and credentials

OS-enforced (`isolation/isolate-run.sh`), using the same primitive as
`scripts/agent-e2e-acceptance.mjs`:

- `unshare` user, mount and PID namespaces; `setpriv` with no-new-privs and empty
  inheritable and bounding sets (probed CapEff=0, NoNewPrivs=1, remount refused).
- Read-only: the store, verifier, installed skills, receipt file, `.mcp.json`, the whole
  session tmp tree (candidate checkout and evidence) and `/home`. `/root` is masked by tmpfs.
- Writable: only the consumer and the agent HOME. No egress proxy is passed, so the
  proxy-injected GitHub and cloud credentials are unreachable (direct GitHub API returned 403).

Not achieved, so not certifiable:

- **No disposable credential.** The CLI authenticates with the host session's token,
  which it finds under `/home`. That file is read-only to the agent but readable.
  Masking it breaks auth, and narrowing it further was refused by this environment's
  permission classifier as credential handling. I did not work around that refusal.
- The repository runner (`--isolation os`, `security.certified`) supports only
  `/start-migration`. It cannot score `/migrate-artifact`, so this run has no runner `report.json`.
- The network is shared, and the agent writes the consumer record directly.

## Verifier (prepared before the run, outside the writable workspace)

`verify.mjs` `ff0b7d20…` and `contract.json` `d0b471d9…` are byte-identical to M13.1.
All 27 rows, 4 throw cases, the export set and VERSION re-derived from the legacy
CommonJS module with 0 mismatches. Pre-run proof (`verifier-proof.txt`):

- An independent good ESM port passes 36/36.
- The unchanged CommonJS fails (0/2: not importable as ESM).
- 9/9 mutants fail: ellipsis, snake separator, VERSION, missing TypeError, NFKD,
  trailing separator, dropped dynamic `kebabCase` export, titleCase, truncate boundary.

## Results

| Requirement | Evidence |
| --- | --- |
| Lifecycle | 9/9 steps, `COMPLETE`, record `strings-2eb849682dc8`, revision 8 (`engine-status.sanitized.json`) |
| CommonJS census | units exactly `#module.exports` (unresolved, `createApi()`) and `#module.exports.VERSION` (`record/inventories/completeness.json`) |
| Completeness enforcement | on the installed v1.6.3 engine, a separate probe consumer refused omitting the unresolved root, a missing or blank rationale, an extra unit, and an unknown disposition; the agent's document was accepted (`omission-probe.txt`) |
| Validator receipts | seq 7 and 8 each carry an `ENGINE` / `EXECUTED` `NODE_CHECK` on `src/utils/strings.js`, exit 0, node v22.22.0, inputSha256 = target `593d4b5e…` |
| Re-verification | `verifyValidationEvidence` on the completed record: `RECORDED`. 11 forgeries refused; one accepted only on the post-COMPLETE view (F3) (`reverify.txt`) |
| Toolkit identity | record `toolkitIdentity` = active = 1.6.3 / b441181 / 2d6a0b…, status `MATCH` |
| Behavior | independent verifier 36/36, exit 0 (`verifier-result.json`) |
| Tamper | 12 pre/post hashes equal, including the whole store tree (`pre.sha256`, `post.sha256-check.txt`). Every agent write landed inside the consumer |

## Findings

- **F1 (Medium, release engineering, pre-existing):** `buildReleaseArchive` runs
  plain `tar -czf` with no `--mtime`, `--sort=name` or `gzip -n`. Archive bytes depend
  on build time, so the expected `sha256:9e84b8c7…` cannot be reproduced by anyone.
  Two builds of b441181 produced different digests while `release-manifest.json` stayed
  byte-identical. Only contentHash and the manifest are reproducible identities. The
  PR's "archive digest independently confirmed" can only mean the author's own file was
  re-hashed. Publication must upload exactly the file whose digest is recorded.
- **F2 (Low, pre-existing):** `pnpm install` chmods 10 engine bin files 100644→100755,
  so `release:check` reports a dirty tree. The fix is `git checkout -- packages`; no
  content changes.
- **F3 (Info, pre-existing, engine unchanged since M13.1):** the target-binding check
  runs only while the VERIFY_SLICES transition is the latest one (`event.revision ===
  state.revision`). FINALIZE refuses a re-sealed `targetDigest` forgery. After COMPLETE,
  status re-reads accept it if the history chain is also recomputed. The M13.1 wording
  "on the completed record" is broader than what is enforced. This is consistent with
  the documented unkeyed-chain limit.
- **F4 (Info):** a refused checkpoint document returns exit 0 with `outcome CONTINUE`.
  The refusal shows only as a `Validation:` line and an unchanged step. Automation must
  not treat exit 0 as acceptance.

## Remaining blockers before any certification or publication

1. A disposable, per-run credential, with the agent unable to read any host session token.
2. A certified runner path for `/migrate-artifact` (`security.certified`), or an explicit
   owner decision that functional evidence is enough for this patch release.
3. F1: publish exactly one archive and record its digest from the published asset
   (`release:record`), not from the PR text.
4. Owner approval to merge. After merge, recheck the exact main SHA, CI and the staged bundle.
5. Windows and non-Claude providers are NOT_TESTED.
