# M14: real `/start-migration` workflow validation on published v1.6.3

The first live run of the published v1.6.3 `/start-migration` module workflow
(the v1.6.3 release notes list it as NOT_TESTED). Claude Code drove a real
module migration in a disposable consumer: the skills were installed with
`skills add`, the agent derived the OpenSpec from legacy code, the run was
killed mid-checkpoint and resumed, and an independent verifier checked the
result. **Assurance: FUNCTIONAL_VALIDATION_ONLY.** This is not security
certification: there was no OS isolation (`--isolation none` equivalent), and
the verifier, store and skills were protected only by hash checks before and after.

## Toolkit under test

| Item | Value |
| --- | --- |
| Release | tag `v1.6.3` → `b441181c0add84453445ba7659155926b850a263` |
| Archive | `artifact-migration-tools-v1.6.3.tar.gz`, sha256 `7159cb74…f20d`, downloaded and checked independently |
| Manifest pin | `sha256:62f3b4c8…f4ad` (independent download), equal to the receipt's pin |
| Content hash | `sha256:2d6a0bdc…91fe`, equal to `released-versions.json` |
| Installed skills | `skills add https://github.com/icordoba8/artifact-migration-toolkit --skill start-migration|migrate-artifact --agent claude-code -y`, byte-identical to `skills/` at `b441181`. `start-migration` computedHash `a88cc8ce…` equals the manifest's |
| Runtime | `runtime.mjs ensure` by the operator: `selection: skill`, `skillIdentity: required`, `bootstrapped: true` (`baseline-run/operator-preflight.json`); every later agent preflight `network: false` |
| Agent | Claude Code 2.1.310, `claude-opus-5-5`, `claude -p … --output-format stream-json`, project MCP server `start-migration` connected, scoped `--allowedTools`, isolated `HOME`, no session identity variables, Ponytail off |

Operator environment notes (not toolkit defects): in this container, Node's
`fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set, and `gh release download`
uses GraphQL, which Claude Code sessions block. The one operator preflight therefore ran with
the container's existing `GH_TOKEN`, `NODE_USE_ENV_PROXY=1` and `gh` shadowed, so that
`runtime.mjs` used its own REST fallback. The agent's environment held no GitHub token.

## Fixture

A single Git repository with `legacy/` (CommonJS `legacy-shop`) and `target/`
(ESM `shop-next`, with conventions in `AGENTS.md`: `DomainError`, `src/shared/money.js`,
`node:test`). The module is `legacy/src/features/discounts`: `quote(cart, options)`
(validation, volume, loyalty and coupon discounts, half-up rounding, shipping) and
`validateCoupon(code, subtotal, now)`. Its inbound consumer is
`legacy/src/features/orders/checkout.js`. No OpenSpec was seeded, and the module was
not registered. The registry held only the project roots.

## Independent verifier

`verifier/verify.mjs` (sha256 `a0055e2d…52e7`), written before any agent run
and stored outside the consumer read-only: 37 checks. 27 are hand-computed quote cases,
6 are `validateCoupon` cases, 1 is the API surface, 1 is input immutability, and 1 is a
3000-cart deterministic differential against a pinned copy of the legacy module
(`verifier/legacy-ref/`). Proof (`verifier/verifier-proof.txt`): legacy 37/37, an
independent reference port passes, the absent target and the legacy CommonJS copied
unchanged both fail, and all 9 non-equivalent single-rule mutants fail. `fixed-not-capped`
survives because it is equivalent: FLAT500's minimum makes the cap unreachable.

## Baseline run on published v1.6.3 (`baseline-run/`)

| Check | Result |
| --- | --- |
| Invocation | run 1: `/start-migration discounts --target discounts --registry .agents/knowledge/migrations/registry.json` |
| Requirements | the agent read the legacy sources and drafted 6 requirements and 19 scenarios (`agent-derived-spec.md`), bootstrapped through `--openspec-proposal-stdin` in auto mode |
| Checkpoints | `RESOLVE → DISCOVER_LEGACY → DISCOVERY_COMPLETENESS → ASSESS_TARGET` committed in run 1 (`history-outline.txt`, seq 1–4) |
| Interruption | the watcher SIGKILLed the agent's process group 25 s after `BUILD_BASELINE` became current, while the agent was reading the baseline scaffolds (`interrupt.log`) |
| Durable state | after the kill, `--status` read the record cleanly (`ACTIVE`, format 21). No lock or journal was left |
| Recovery | run 2: the documented resume `/start-migration discounts` in a new session. Status came first, and the run resumed at `BUILD_BASELINE` without rediscovery. Inventories and steps 01–03 were byte-identical to the snapshot taken at the kill, and the history at the kill is an exact 4-line prefix of the final history (`record-at-interrupt.sha256`, `history-prefix-check.txt`) |
| Lifecycle | 2 slices; `COMPLETE` at revision 11 (seq 11), and `--complete` validation passed |
| Operator decisions | none was reached. No decision ledger exists, so the relay path was not exercised |
| Writes | the consumer's `legacy/`, the installed skills, the store tree and the verifier were unchanged (`tamper-check.txt`). Outside the record, `openspec/` and `src/features/discounts/`, the only changes were the engine's registry entry and the `package.json` registry binding. The agent wrote one proposal draft in the scratch directory outside the consumer |
| **Independent verifier** | **34/37 FAIL** (`verifier-result.json`): Q-012, E-010 and DIFF-001 |

### Defect D1: the published workflow completes with a changed export call contract

Legacy `quote(cart, options)` reads `options.now`. The migrated
`quote(cart, now = new Date())` (`migrated-index.js`) expects a bare `Date`, so the
legacy consumer's call `quote(cart, { now })` throws `TypeError: now.toISOString is not a
function` for any dated coupon. With a diagnostic adapter that maps only the
signature, the target passes 37/37, so every business rule matched and only the call
contract broke.

The engine accepted it because nothing in the workflow treats an export's parameter
shape as behavior. Format 21's call-contract tracing covers HTTP route tables only. The
agent's inventory recorded `validateCoupon(code, subtotal, now)` but not
`quote`'s options argument, and its own tests called its own new signature, so
`FUNCTIONAL_PARITY_GATE` passed on agent-authored evidence. The agent never opened
`discovery-checklist.md`. It drafted requirements from `SKILL.md` and read only
the `#DISCOVER_LEGACY` contract entry `schemaRef` named.

**Fix (`cd73701`, guidance only):** state the exported call contract where the agent
reads: the bootstrap proposal guidance in `SKILL.md`, the contract's
*Legacy inventory* section, and a new *Exported call-contract traceability* section
plus a coverage category in the checklist. No engine, format or gate change.

## Validation run on candidate `0.0.1` built from `cd73701`

The candidate was built with the repository's own procedure (`candidateReleaseRoot`,
`buildRelease`, `verifyRelease`, `buildReleaseArchive`): commit `cd73701`, archive
`sha256:8a4e90f8…33b9`, pin `sha256:59153861…69d4` (`candidate-run/candidate-identity.json`).
It was installed in a **fresh** consumer reset to the same fixture commit, with
`skills add <bundle> --agent claude-code -y` (`source: release`), and staged in its
own store through `ensureRuntime` with an offline transport, as
`test/installed-full-lifecycle.test.mjs` does. The agent's preflight then selected it
offline (`selection: skill`, `skillIdentity: required`, `network: false`). It is a
candidate, not a published release.

| Check | Result |
| --- | --- |
| Invocation | run 3: one uninterrupted `/start-migration discounts --target discounts --registry …`, 153 turns, exit 0, no follow-up prompt |
| Requirements | the derived spec now states "The module MUST export `quote(cart, options)` … the only key read is `options.now`", with a scenario for the checkout consumer's call (`candidate-run/agent-derived-spec.md`; "options" appears 5 times, against 0 in the baseline spec) |
| Lifecycle | 9/9, 2 slices, `COMPLETE` at seq 11; `--complete` passed (`history-outline.txt`) |
| Migrated API | `export function quote(cart, options)` (`migrated-index.js`) |
| **Independent verifier** | **37/37 PASS** (`candidate-run/verifier-result.json`) |
| Writes | `legacy/` unchanged; the installed skill and the store's engine `src/` equal the candidate bundle; the verifier hashes match |

One sample. It shows the guidance reaches the agent and changes the outcome. It does
not show the outcome is guaranteed.

## Regression

- `providers:check`: 62 files in sync; `architecture:check`: ok.
- `test/providers-sync`, `provider-progress-parity`, `release-version-discipline`,
  `architecture`: 75 tests, 74 pass, 1 skipped, 0 fail.
- Engine units that read the skill documents (`migration-contract`, `migration-policy`,
  `slices`, `mcp-server`, `v5-contract-parity`): 553 tests, 547 pass, 6 skipped, 0 fail.

## Limits and remaining risks

- One LLM sample per configuration. A guidance fix lowers the chance of D1 but does not
  enforce it: the engine still cannot detect a changed export signature. Enforcement
  would need a derived export call contract (comparable to the format-21 API response
  contract), so a format increment, which is the owner's decision.
- Module-workflow command evidence is agent-asserted. The agent ran the tests and
  transcribed their output with the Write tool, because shell redirection was not
  permitted. Engine-executed validator receipts (M13) cover only the artifact engine.
  The slice-001 transcript matches a real re-run line for line, apart from durations.
- No operator decision arose, so the `OPERATOR_DECISION` relay is still untested live.
- Not investigated: in run 3 the agent simplified `pricing.js` during FINALIZE, after
  both slices were verified, and FINALIZE accepted it. The verifier ran on the final
  bytes and passed, but it was not checked whether FINALIZE re-bound that file to fresh evidence.
- The history is an unkeyed hash chain, as in v1.6.3 F3.
- The changed skill keeps version `1.6.3` with a new computedHash (`7d9e1bfb…`), which
  the published 1.6.3 manifest (`a88cc8ce…`) does not prove. A copy installed from this
  branch therefore cannot select the published runtime (identity rule 3) until a release
  is cut. This was not exercised here, and no release was made.
