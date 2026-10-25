# M13.1: real Claude Code migration on the M13.1 candidate

The candidate under test is code commit `0a791e718b7e76927a9e50c2f82d2bd611d3730b`, the
M13.1 engine fixes. It was built with the repository's own candidate procedure
(`test/support/candidate-release-root.mjs`): the committed payload is restamped as
the unregistered version `0.0.1`, because `release:check` correctly refuses to
stage changed bytes under the immutable `1.6.2`. The bundle was then staged in a
disposable release store (`installed-candidate-identity.json`). No logs are
published here; the transcript is kept off-repo (`session-transcript.sha256`).

| Check | Result |
| --- | --- |
| Installed identity | skill `release-identity.json`: `0.0.1`, computedHash `b39c1650…a23510`, equal to `skills/migrate-artifact` at the candidate commit. The runtime receipt pins `sha256:b6ce76e9…ce1b`, toolkit commit `0a791e7`, contentHash `sha256:c2d52e56…0c3e` (`receipt-claude.sanitized.json`). Published v1.6.2 cannot satisfy this skill (its computedHash differs), so no silent fallback is possible. |
| Invocation | one `claude -p "/migrate-artifact legacy/strings.cjs --target src/utils/strings.js"` call on `claude-opus-5-5` (Claude Code 2.1.310), exit 0, 45 turns, 44 tool calls, no follow-up prompt (`command.txt`, `transcript-audit.json`) |
| Skill start | the runtime preflight selected the staged candidate offline (`selection: skill`, `skillIdentity: required`) |
| Discovery | `sourceFiles: ["legacy/strings.cjs"]`, resolution `MIGRATE_NEW` (the target did not exist), one slice `esm-strings` |
| CommonJS census | `legacy/strings.cjs#module.exports` is **unresolved** (the root is `createApi()`), and `legacy/strings.cjs#module.exports.VERSION` is resolved (`record/inventories/completeness.json`) |
| Completeness enforcement | the agent's first document listed 6 non-export bindings and was refused: "units must be exactly [...]" (`completeness-first-attempt.txt`). Against the installed engine, omitting the unresolved root, leaving out its rationale, or giving a blank rationale is each refused; the agent's justified document is accepted (`omission-probe.txt`) |
| Validators | IMPLEMENT_SLICES and VERIFY_SLICES each ran `NODE_CHECK` on `src/utils/strings.js` (EXECUTED, ENGINE, exit 0, `node v22.22.0`) |
| Persisted evidence | `validationEvidence` on history seq 7 and seq 8, still present after COMPLETE (`record/history/history.ndjson`) |
| Lifecycle | 9/9 steps, record `strings-2eb849682dc8`, revision 8, `COMPLETE` (`engine-status.sanitized.json`) |
| FINALIZE re-verification | the candidate's `verifyValidationEvidence` on the completed record returns `RECORDED`. 8 tamper probes on copies (unsealed edit, dropped receipt, NOT_REQUIRED downgrade, changed declared file, slice-document hash, changed files, target digest, artifact id) are all refused (`reverify.txt`) |
| Behavior | the independent verifier passes 36/36 (`verifier-result.json`). The verifier was proven before the run (`verifier-proof.txt`): a known-good port passes 36/36; the legacy file copied unchanged fails; 4 single-behavior mutants fail |
| Crash recovery | replayed from the agent's own documents: a journal that crashed after landing at IMPLEMENT_SLICES with a forged receipt is refused; the genuine journal is reproved by re-executing the validator. The recovered seq 7 equals the journal and the agent run's evidence, and the recovered record reaches COMPLETE (`crash-recovery.txt`) |
| Tamper | `legacy/strings.cjs`, `src/index.js`, `package.json`, the installed skill and the verifier are unchanged (`pre.sha256`, `post.sha256-check.txt`) |

## Environment and operator actions

- Claude Cloud container. The agent ran nested, under an isolated `HOME`: no user
  plugins, hooks or memory, and only built-in skills loaded. The session identity
  variables were unset. `ARTIFACT_MIGRATION_TOOLS_STORE` pointed at the disposable
  store.
- Permissions: a scoped `--allowedTools` list covering the file tools and Bash for
  `node`, `/opt/node22/bin/node`, `git`, `npm`, `ls`, `cat`, `mkdir`, `head`,
  `wc`, `diff` and `sha256sum`. `bypassPermissions` was refused by the host's
  safety classifier and was not used.
- **Attempt 1 was invalid (operator configuration error).** The allowlist named
  `node` but not the absolute `/opt/node22/bin/node` that the preflight returns.
  The skill started and its preflight passed; the first engine call was denied,
  and the agent stopped cleanly without creating a record. The consumer was reset
  to its two fixture commits, the agent `HOME` was recreated, and the absolute
  path was added. Attempt 2, documented above, ran unrescued.
- The agent wrote one scratch differential-test script outside the consumer, in
  the session scratch directory. It touched neither the source, the verifier nor
  the store.

## Limits

- The bundle is the candidate payload at version `0.0.1`, not a published release.
  Its installed engine `src/` is byte-identical to the candidate commit.
- The history is an unkeyed hash chain. The evidence is tamper-evident against
  the record, not cryptographically attested.
- `state.sanitized.json` and `engine-status.sanitized.json` have the disposable
  roots replaced with `<disposable>`, so their integrity hash no longer matches.
  The history, inventories, slices and matrices are byte-exact.
- `NODE_CHECK` is a syntax check. Behavior preservation is established by the
  independent verifier, not by the engine.
