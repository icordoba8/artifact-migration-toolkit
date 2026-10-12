# Track A9 ownership record: instructions and documentation

Track A9 aligns the canonical skill instructions, the operator documentation and
the architecture explanations with the engine that Tracks A1–A8 produced. It
changes no engine behavior, no format version, no toolkit version and no
persisted schema. BASE is `7dac9907f3db8ff393fb70d652b8aeb70fa942fe`.

## Source-of-truth hierarchy

1. **The executable engine** (`packages/migration-engine/src/`) and its tests decide
   what a command does. Where a document disagrees with it, the document is
   wrong.
2. **The canonical skills** (`skills/<skill>/`). `SKILL.md` is the agent protocol:
   triggering, runtime preflight, status first, one iteration, typed outcomes,
   operator decisions and hard boundaries. `references/` hold the persisted
   contracts, schemas, historical format rules and detailed examples.
3. **The generated provider projections** (`providers/`). They are written by
   `pnpm providers:sync` and never edited by hand.
4. **Operator documentation**: `README.md` (product, architecture, install),
   `docs/command-reference.md` (commands, flags, MCP tools, outcomes) and
   `docs/release.md` (validation, identity and release).
5. **Ownership records** under `docs/architecture/`. Each one is a snapshot of
   its own track.
6. **Historical plans and snapshots** (`docs/*-plan.md`, `docs/phase0-architecture-baseline.md`,
   `docs/auto-mode-autonomy.md`, `docs/phase-4-acceptance.md`). These record
   what was decided at the time. A9 does not rewrite them.

## Files examined

- `skills/start-migration/SKILL.md` and every file in `references/`
- `skills/migrate-artifact/SKILL.md` and `references/artifact-contract.md`
- `README.md`, `docs/command-reference.md`, `docs/release.md`
- `docs/start-migration-architecture-plan.md`, `docs/phase0-architecture-baseline.md`
- `docs/architecture/a1-ownership.md` to `a8-ownership.md`
- The status headers of every other file under `docs/`
- The facts checked in source: the package manifests (`bin`, `engines`), the
  `transport/` argument parsers and the MCP tool list, `lifecycle/policy.mjs`
  (outcomes and exit codes), the `formats/` constants, the `shared/` and
  `store/` content identity, `lifecycle/contract-upgrade.mjs`, the facade files,
  the inter-module import graph and `scripts/providers-sync.mjs`

## Findings

Classes: **A** current guidance corrected; **B** historical material left
unchanged; **C** a normative contract that A9 must not change; **D** uncertain,
documented here and not changed.

### A — corrected

| # | Where | Was | Now | Authority |
|---|---|---|---|---|
| A1 | README *Layout* | `src/` "9 shared modules", `src/cli/` "5 entry points", `src/artifact/` "the artifact state machine" | the nine canonical modules, the installed entry points as facades, compatibility paths; new *Engine source layout* table | `src/<module>/index.mjs`, a1–a8 ownership records |
| A2 | README *Executables* | nine commands; `artifact-migration-toolkit` missing | ten, matching `bin` | `packages/migration-engine/package.json` |
| A3 | README *Tests* | "15 node:test suites" | 35 | root `package.json` `engine:test` |
| A4 | README *Pinning* | "Later phases stamp the resolved toolkit identity …; until then, pin by commit yourself" | records pin the identity and mutations refuse under a different one until `artifact-migration-toolkit` reconciles it | `lifecycle/toolkit-identity.mjs`, `formats/toolkit-identity.mjs` |
| A5 | start-migration *Runtime requirements* | Node.js 20+ | Node.js 22+ | `engines` in both manifests (see D1) |
| A6 | start-migration *Invocation* | "The server is registered in the repository's `.mcp.json`" (Claude Code only) | the preflight registers it in this provider's MCP configuration | `provider-compatibility.md` scope table |
| A7 | start-migration *Security* | approval-shaped arguments refused "on any tool but `migration_run`" | "on any tool but `migration_relay_decision`" | `transport/mcp.mjs`; `operator-approval-authority.integration.spec.mjs` checks `migration_run` |
| A8 | start-migration `IMPLEMENT_SLICES` | the artifact engine "imports … from this engine's core" | it "shares" them with this engine | `lifecycle/artifact-*.mjs` imports |
| A9 | migrate-artifact *Responsibility boundary* | table naming `migration-policy.mjs`, `resumable-migration.mjs`, `module-lock.mjs`, `migration-utils.mjs`, `record-decision.mjs`, `format-upgrade.mjs` as owners | the boundary in prose; README *Engine source layout* names the owners | `lifecycle/policy.mjs`, `transport/arguments.mjs`, `lifecycle/lock.mjs`, `store/`, `shared/`, `lifecycle/recorder.mjs`, `lifecycle/progress.mjs`, `formats/upgrade.mjs` |
| A10 | migrate-artifact | "the module core imports this engine lazily … Never add a static import in that direction" | removed; README states the engine has no import cycle | A8: `artifactEngine()` removed, no lazy cycle |
| A11 | migrate-artifact | "A contract test now fails the build if any of these literals reappear in the artifact scripts" | names what R-W7-d checks: no loop directive, mode literal or outcome-to-exit-code mapping in the artifact front end or lifecycle | `artifact-migration.test.mjs` R-W7-d |
| A12 | `migration-contract.md` | a skill-local `resumable-migration.mjs` under `scripts/` named as "the single authority for the three version axes" | the `formats/` module, re-exported by the `resumable-migration.mjs` path | `formats/module.mjs` |
| A13 | `migration-contract.md` | content identity "owns it: `migration-utils.mjs`" | `shared/` (file reads through `store/`), exported through `core.mjs` and `migration-utils.mjs` | `shared/digest.mjs`, `store/files.mjs` |
| A14 | `provider-compatibility.md` | a provider tree holds only `SKILL.md` and references; sync refuses any executable | it also holds `release-identity.json` and `scripts/runtime.mjs`, the one executable the sync allows | `scripts/providers-sync.mjs`, `providers/*/skills/` |
| A15 | `provider-compatibility.md` | "Two of these are consumer-owned files" (lists three) | "Three" | same paragraph |
| A16 | `release.md` *Format bump* | predicates "in `resumable-migration.mjs`" | `formats/module.mjs` | `formats/module.mjs` |
| A17 | `release.md` *Approval boundary* | `src/record-decision.mjs`, `src/mcp-server.mjs`, `src/cli/run-migration.mjs` | the recorder, offer loop, `decisions/`, `transport/mcp.mjs`, `transport/run.mjs`, each with the installed path that runs it | A3/A7/A8 records |
| A18 | `release.md` | relay exemption named `migration_run` | `migration_relay_decision` | as A7 |
| A19 | `release.md` | drift acceptance "under the standard challenge phrase" | historical challenge for module ≤18, direct ledger for 19 | `migration-contract.md` *Unclaimed target drift* |
| A20 | `release.md` | `src/upgrades/upgrade-migration.mjs` hashes `v5-contract.md` | `src/lifecycle/contract-upgrade.mjs`, run through that path | `lifecycle/contract-upgrade.mjs` |
| A21 | `release.md` | the Windows rules did not say Windows CI is paused | states the Track A pause and that the existing rule then blocks a release | `.github/workflows/ci.yml` |
| A22 | `command-reference.md` | no CLI/MCP correspondence, no artifact `--upgrade-format`/`--confirm-format`, no outcomes or exit codes | *Engine commands and MCP tools*, *Outcomes and errors*, the artifact format operation | `transport/mcp.mjs` `TOOLS`, `transport/artifact.mjs`, `lifecycle/policy.mjs` |
| A23 | `start-migration-architecture-plan.md` | "Status: proposal, not started" with no pointer | historical banner in the existing `docs/` convention; body unchanged | Track A |

### B — historical, unchanged

- `docs/phase0-architecture-baseline.md`, `docs/architecture/a1-ownership.md` to `a8-ownership.md`
  and `docs/architecture/phase0/`: per-track snapshots.
- The body of `docs/start-migration-architecture-plan.md` and the existing
  historical plans (`operator-decision-architecture-plan.md`,
  `operator-decision-signer-webauthn-plan.md`, `artifact-format-14-direct-ledger-plan.md`,
  `auto-mode-autonomy.md`, `runtime-install-update-audit-plan.md`,
  `phase-4-acceptance.md`). They name the files of their time.
- Installed entry paths named in the contracts (`record-decision.mjs --pending`,
  `run-migration.mjs`, `discover-module.mjs`, `update-migration-registry.mjs`).
  They are still the installed entry files, and the engine renders them in its
  own operator output (`engineCommand`).

### C — normative, unchanged

- `packages/migration-engine/references/v5-contract.md` and its byte-identical
  canonical copy `skills/start-migration/references/v5-contract.md`.
- Every schema, gate, evidence rule, format row and compatibility rule in the
  contracts. The R-W10-a compatibility table and the format notes are unchanged.
- AUTO and STEP semantics, the confirmation and retry rules, the `loop:` line
  and the stop set.
- The decision rules. They were moved word for word (see *Duplicates
  consolidated*), not reworded.

### D — documented, not changed

| # | Finding | Why it is not changed in A9 |
|---|---|---|
| D1 | `runDoctor` enforces Node 20 (`MINIMUM_NODE_MAJOR = 20` in `migration-utils.mjs`), while both manifests require `>=22`. The documents now follow the manifests. | Raising the doctor floor is an engine change. |
| D2 | Engine-emitted `schemaRef` anchors (`migration-contract.md#<STEP>`, `artifact-contract.md#<step>`) do not match a heading, except `#finalize`. | Fixing it needs either an engine change or new headings in a contract, which is a product decision. |
| D3 | `release.md`: "The named upgrade path is a detached signature verified against a key pinned at `RESOLVE`." The stronger path that shipped is the protected `HUMAN_ATTESTED` WebAuthn signer. | Whether the sentence still names the intended path is a product question. |
| D4 | README and `release.md` require Windows CI (advisory), but the job is paused during Track A. | The Windows policy is out of A9 scope. The pause is now stated, not resolved. |
| D5 | `artifact-migrate` still accepts `--pilot-format 14`. The skill says no pilot flag is needed. | Left undocumented on purpose, so that no agent is given a reason to use it. |
| D6 | `migration_run` also accepts `legacy` and `adoptTarget`. The skill's MCP bullet lists a subset of the fields. | Adding them is new agent guidance, not a correction. |
| D7 | The start-migration Figma section overlaps the contract's *Figma visual acceptance* schema. | The skill also carries capture procedure the contract lacks (`use_figma` first, `parentId`/`childIds`, splitting design context, computed `stroke`/`boxShadow`, `getBoundingClientRect`). Moving it is a restructure, not a deduplication. |
| D8 | The skill's *Format upgrades* section overlaps the contract's. | It holds the typed-outcome handling and the 17→18 authority rule the agent must obey. It stays. |
| D9 | The *Runtime UI evidence* section names `.mcp.json` for the consumer's Playwright server. | That is the consumer's own configuration, not toolkit registration. |
| D10 | The plan's Phase 6 target (a SKILL.md of at most 300 lines, proven by a weak-model rehearsal) was not attempted. | The A9 brief makes word count a non-target. The proof needs a live rehearsal. |

## Duplicates consolidated

- **Decision authority (start-migration).** BASE stated it in six places: the
  MCP bullet, the `OPERATOR_DECISION` handoff, the historical
  `operatorApproval` paragraph, `DISCOVERY_COMPLETENESS`, *Progress
  presentation* and *Security*. It is now one subsection,
  `### Operator decisions`, with the same sentences. The other places keep
  only their own checkpoint- or format-specific facts and point to it.
  - Three phrases were folded rather than moved:
    - "a valid append is immediately visible without advancing a checkpoint"
      is now "recording one advances no checkpoint";
    - "the standard review records `AGENT_RELAYED` without infrastructure" is
      already stated by `STANDARD_LOCAL` and "Standard decisions need no
      signer";
    - in *Progress presentation*, "with attested writes unavailable" was
      dropped. It was ambiguous, because protected `HUMAN_ATTESTED` writes do
      exist through the signer. The clause the progress tests pin, "never
      through a model-callable affordance", is kept.
  - Headings were added: `### Operator commands` and `### Invocation options`.
- **Decision protocol in `provider-compatibility.md`.** A second full statement
  of the protocol and the signer rules was replaced by a pointer to *Operator
  decisions*. It now states only what is provider-specific: all four use one
  protocol, and no provider adds, removes or reinterprets a rule.
- **Engine architecture in `migrate-artifact/SKILL.md`.** The file-level owner
  table and the dependency-direction rule are architecture facts, not agent
  protocol. They now live in README *Engine source layout*. The skill keeps the
  boundary the agent needs.

## Preserved invariants

Each rule below is still stated in the canonical skill and in all four
provider trees. The A9 parity tests pin the decision and artifact clauses, and
the existing `CONTRACT` and progress tests pin the rest:

- runtime preflight first, stopping on failure, and refusals reported rather
  than worked around;
- status first, fast resume with no rescan of completed work, and at most one
  transition per iteration;
- obeying the typed outcome and the `loop:` line, with no continuation after a
  stop;
- the explicit operator `APPROVE`/`REJECT`, relayed only from the user's next
  message;
- no approval from cancellation, timeout, missing response, auto-permission,
  inference or an earlier message;
- `STALE_REVIEW` re-review;
- `HUMAN_ATTESTED` fails closed with `SIGNER_UNAVAILABLE`, with no fallback to
  `AGENT_RELAYED`;
- AUTO as a distinct principal;
- the historical challenge and citation rules for module ≤18 and artifact 13;
- no hand edits of state, ledger, history or integrity;
- a standalone artifact record that never reads module registry, parent or
  module state;
- the provider short-circuit invariant;
- the Ponytail Review → Audit → pre-commit ordering.

No "must" became a "should", and no refusal became advice.

## Canonical and provider parity

- `pnpm skills:lock` updated `skills-lock.json` and both
  `skills/*/release-identity.json`.
  - `start-migration`: `556e2e79…` → `cd5d9818…`
  - `migrate-artifact`: `42358b22…` → `c4a79e21…`
  - The version stays `1.3.19`.
- `pnpm providers:sync` regenerated 24 files: the two `SKILL.md`, the two
  changed references and the two stamps, in each of the four trees.
  `pnpm providers:check` reports all 62 files synchronized.
- No published release contains these skill bytes. Until a release is
  authorized and cut, a preflight that pairs these skills with the published
  `1.3.19` release refuses them as `SKILL_IDENTITY_UNRELEASED`. That is the
  documented development-checkout behavior; `--version` is the explicit path
  through it. A9 publishes nothing.

## Documentation checks added

All of them are in files already registered in `engine:test` or
`providers:test:3`, so no CI or script registration changed.

| Check | File |
|---|---|
| Relative links and heading anchors resolve, and named repository source paths exist, in current guidance only (historical docs and `v5-contract.md` are excluded) | `test/providers-sync.test.mjs` |
| The decision-authority clauses (start-migration) and the standalone protocol clauses (migrate-artifact: preflight, status first, no module state, no decision through a tool argument, fail-closed signer, short-circuit) are present in the canonical skill and all four provider trees | `test/provider-progress-parity.test.mjs` |
| The README executables table equals the package `bin` map | `packages/migration-engine/test/external/bin-mappings.test.mjs` |
| The command reference MCP table equals `tools/list` | `packages/migration-engine/test/unit/mcp-server.test.mjs` |
| Every flag in the command reference argument tables is declared by `artifact-migrate` or `artifact-migration-run` | `packages/migration-engine/test/unit/artifact-migration.test.mjs` |

Already covered before A9, and unchanged: preflight-first and status-first
(`provider-progress-parity` `CONTRACT`), provider byte parity
(`providers-sync`), lock consistency (`providers:test`), and the compatibility
table (R-W10-a).

## Inventory

Lines and words, before and after:

| File | Lines | Words |
|---|---|---|
| `skills/start-migration/SKILL.md` | 1317 → 1322 | 11013 → 10981 |
| `skills/start-migration/references/migration-contract.md` | 2306 → 2309 | 14506 → 14529 |
| `skills/start-migration/references/provider-compatibility.md` | 172 → 160 | 1406 → 1293 |
| `skills/migrate-artifact/SKILL.md` | 222 → 210 | 1719 → 1639 |
| `README.md` | 356 → 403 | 2415 → 2794 |
| `docs/command-reference.md` | 124 → 183 | 2088 → 2508 |
| `docs/release.md` | 285 → 296 | 2154 → 2243 |

- **start-migration markdown** (the skill and its references): 31340 → 31218
  words.
- **Instruction reduction:** about 220 words across the two skills and
  `provider-compatibility.md`.
- **Operator documentation growth:** about 900 words, in the README layout
  table and the command-reference correspondence and outcomes sections that
  were missing.
