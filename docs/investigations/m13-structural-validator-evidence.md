# M13: CommonJS structural census and persistent validator evidence

Baseline: `main @ 9dee379`. M12 evidence (`evidence/m12-real-migration`) was read
for reference only, not merged. No captured logs are published here.

## Gap A: a CommonJS source contributed zero structural units

- `census/scan.mjs` `structuralUnits` parsed `.cjs` (it is in
  `SCRIPT_UNIT_EXTENSIONS`), but only enumerated ESM `export` syntax:
  `ExportAssignment`, `ExportDeclaration` and `export`-modified statements.
  `module.exports = ...` / `exports.x = ...` are plain expression statements, so
  they produced `[]`.
- `lifecycle/artifact-checkpoints.mjs` `validateCompleteness` builds the
  completeness universe only from those units (`sameMembers(documented,
  census.keys())`). A file with zero units adds nothing, so M12's
  `{"sourceFiles":["legacy/slugify.cjs"],"units":[]}` passed, and the exported
  `slugify` contract was never in the completeness universe.
- FINALIZE never re-derived the census, so nothing later caught it.

Fix: `census/commonjs.mjs` (called from `structuralUnits` for every script
extension except `.mjs`/`.mts`) enumerates `module.exports`, `exports.x`,
`module.exports.x`, bracketed literal keys and `Object.defineProperty(exports,
"x")`. It resolves values through the same local-binding and object-literal
resolver as ESM, with the same depth bound. Undecidable shapes stay visible as
`resolved: false`: a `require()` re-export, an imported or unset binding, a
computed key, a write inside a function or branch, the export object handed to
a call, a repeated root assignment, or `exports = ...`. A side-effect script
with no exports still has no units.

Rules: an unresolved CommonJS unit needs a `rationale`. ESM/TypeScript
unresolved units keep their pre-M13 contract. FINALIZE re-censuses untouched
source files, so a completeness document authored against the blind census
cannot complete. In-place rewritten files are excluded, because their bytes
are now target code.

## Gap B: validator results were not persisted

- `artifact-execution.mjs` `hasCodeValidationCheck` returned per-validator
  evidence, and `executeGenericCheck` returned its run. `validateImplementation`
  returned the first as `validationEvidence` and dropped the second.
- `artifact-transaction.mjs` `buildAdvanceTransaction` built the ADVANCED event
  from `previewAdvance`'s validation without either. So the hash-chained
  history (M12 seq 7/8) proved a transition happened, but not which checks ran,
  under what authority, or with what result.

Fix: ADVANCED events out of `IMPLEMENT_SLICES` / `VERIFY_SLICES` carry
`validationEvidence` inside the digested event body. It is a sealed envelope
bound to: artifact id, slice, checkpoint, `fromRevision`, the source and target
binding digests, the slice document hash, and every changed file's hash. It
holds one receipt per declared check:

| Check | Receipt |
| --- | --- |
| TYPESCRIPT / NODE_CHECK with changed code | `EXECUTED`, authority `ENGINE`, exit code, covered files, validator `{name, version, origin}`, input digest, bounded diagnostic codes and files |
| TYPESCRIPT / NODE_CHECK without changed code | `NOT_REQUIRED` |
| `npm/pnpm/yarn run <script>` in the target manifest | `EXECUTED`, `PACKAGE_SCRIPT`, manifest digest |
| any other command | `UNSUPPORTED`, authority `AGENT_DECLARATION`, command kept only as its sha256 |
| read-only caller | `DEFERRED`, which never reaches a transition |

Receipts never hold stdout, stderr, the environment, absolute paths or
free-text commands. They also hold no clock values: they are deterministic, so
crash recovery re-executes the validators and must reproduce the journal's
receipt exactly. FINALIZE re-reads the envelopes (a pure read) and refuses:

- a digest mismatch
- evidence bound to another record, slice, checkpoint or revision
- an `EXECUTED` receipt without engine authority, or a `DEFERRED` one
- a verified slice without evidence
- evidence stripped from a later transition
- changed-file bytes that differ from the newest evidence covering them

## Compatibility

- History records without the key are still valid. A record with no envelope
  reads as `LEGACY_UNRECORDED` and completes as before. A record upgraded
  mid-slices reads as `PARTIAL_LEGACY`: transitions before the first envelope
  are legacy, and every later one must carry an envelope.
- Pre-M13 engines refuse the new optional history key (exactObject). That is a
  loud refusal, not silent corruption.
- No format or state-schema change. COMPLETE records are not re-judged.
- Recovery reproof now also includes `visualComparison`, which
  `buildAdvanceTransaction` already wrote into VERIFY_SLICES events.

## Limits

- Only the artifact engine is covered. The module engine's validators
  (`lifecycle/validation.mjs`) are untouched.
- A node-version change between a crash and its recovery fails the reproof
  loudly, because the NODE_CHECK receipt records `process.version`.
- History integrity is an unkeyed hash chain. Anyone with write access to the
  record can rewrite it consistently. The evidence is tamper-evident relative to
  the chain, not cryptographically attested.
- `--status` does not yet display the persisted evidence.
