# M12: code-changing Claude migration on the published v1.6.2

Release `v1.6.2` @ `336531c4b5a23814f6e35699bedb5315003c3542` (immutable,
asset digest unchanged: `release-unchanged.json`).

| Check | Result |
| --- | --- |
| Resolution | `MIGRATE_NEW` (not `TARGET_REUSE`) |
| Final state | `COMPLETE`, record `slugify-0a4f9b12a9b9`, revision 8, 9/9 steps (`engine-status.json`) |
| Target code changed | `src/utils/slugify.js` created (ESM), `test/slugify.test.js` created, `package.json` gains a `test` script (`target/`, `package.json.diff`) |
| Engine-executed validators | IMPLEMENT_SLICES declares `NODE_CHECK` on both changed `.js` files plus the command check `npm run test` (`record/slices/slugify-esm.json`) |
| Independent behavior verifier | 27/27 PASS (`verifier-result.json`) |
| Installed identity | 1.6.2 / `336531c` / `sha256:67c9f36a…8f82`; `release:verify` of the installed store: `verified: true` |
| Corrective prompts | none: 1 session, 1 user turn (the slash command), 36 tool calls (`transcript-audit.txt`) |
| Tamper | installed skill, `legacy/slugify.cjs`, `src/index.js`, verifier unchanged (`pre.sha256`/`post.sha256`, `verifier.sha256`) |

## Fixture: why reuse cannot satisfy it

`package.json` sets `"type": "module"`; the source is CommonJS at
`legacy/slugify.cjs`; `src/index.js` re-exports `slugify` from
`src/utils/slugify.js`, which did not exist. Invocation (`launch.sh`, `command.txt`):

```
claude -p "/migrate-artifact legacy/slugify.cjs --target src/utils/slugify.js"
```

The verifier (read-only, outside the consumer) was proven both ways before the
run (`verifier-proof.txt`): the legacy `.cjs` passes 27/27; the legacy file copied
unchanged to the target fails 0/27 (CommonJS under `type: module`); a correct
ESM port passes; two single-behavior ESM mutants fail.

## Install

`pnpm dlx skills add https://github.com/icordoba8/artifact-migration-toolkit --skill migrate-artifact -a claude-code -y`
(`skills-add.log`); the installed tree is byte-identical to `skills/migrate-artifact`
at `336531c`. The skill preflight selected the existing v1.6.2 store
(`receipt-claude.json`).

## How "validators executed" is established

The 1.6.2 engine's IMPLEMENT_SLICES checkpoint (`artifact-checkpoints.mjs`,
`previewAdvance` → `validateCheckpoint(..., EXECUTION_CAPABILITY)`) executes every
`command` check that names a package script (`npm run test` does; "executed, not believed") and every `validator`, and refuses
unless trusted validator evidence covers every changed executable file. No
`deferredExecution` appears in the record, and the record advanced
IMPLEMENT_SLICES → VERIFY_SLICES (history seq 7), so those checks ran and passed.

## Limitations

- The engine does not persist validator output (`runtimeEvidence: []`); execution
  is proven by the gate's code path and the advance, not by a stored log.
- `NODE_CHECK` is a syntax check; behavior is covered by the agent's `npm run test`
  (5 cases) run by the engine, and by the independent 27-case verifier.
- Census found zero structural units in the CommonJS source (agent-reported, same
  gap as the v1.6.2 acceptance), so the completeness gate disposed of nothing.
- No isolation: operator's user-level Claude config (Ponytail SessionStart hook,
  auto-memory) and the shared runtime store. Functional evidence, not
  `security.certified`; not an independent Ponytail attestation.
- The transcript is kept off-repo (sha256 in `session-transcript.sha256`).
