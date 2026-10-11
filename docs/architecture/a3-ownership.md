# Track A3 ownership record: `decisions/`

BASE `d6ff5ed`. Plan: `docs/phase0-architecture-baseline.md` §2 (R1, R3), §4 option (b), §8 A3, Appendix C (decisions rows). The decisions rows of `owners-b.tsv` were reconciled against BASE. All 195 rows were still at their Phase 0 sites. F6 had added `record-decision.mjs` `autoMayDecide`, which is decisions-owned and moved, and `resumable-migration.mjs` `driftCandidateFacts`, a slice fact builder that stays.

**Scope:** A3 is a partial extraction of the owners-b decisions rows, by design. 112 of the 195 rows, plus F6's `autoMayDecide`, now live in `decisions/`, beside 14 new decisions functions split out of seams. The other 83 stay outside, either as orchestration seams or behind a named blocker; they are all listed under "Not moved" below.

**Method:** the extraction preserves behavior.
- Most declarations moved verbatim.
- Five functions that read census, slice, visual, lifecycle or transport state were split instead. Each split puts the decision rules in `decisions/` and leaves the reads in an orchestration seam, which passes them to decisions as data (option (b)).
- Evidence that the extraction preserves behavior:
  - **Types:** `tsc --checkJs` diagnostics equal BASE's once file paths are ignored. The only difference is 3 fewer `process` references: the four `process.exitCode = BLOCKED_EXIT_CODE` lines of the old gate are now one line in the seam.
  - **Exports:** all 46 BASE engine files export the same names, function arities and values.
  - **Golden:** `pnpm rehearse` matches the 20-step golden trace.
  - **Negatives:** `pnpm rehearse:negative` refuses all four corruptions.

## Files

| File | Holds |
|---|---|
| `decisions/index.mjs` | The one public entry. It exports only names that something outside `decisions/` uses. |
| `decisions/policy.mjs` | Principal and result vocabulary. The built-in `STANDARD_LOCAL` policy and the protected opt-up (`/etc/.../decision-policy.json`, root-owned). The resolvers `resolveRequiredPrincipal` / `resolveHistoricalRequiredPrincipal`, and principal strength (`principalSatisfiesRequirement`). Per-line principal checks: `decisionLineProblem`, `attestedLineProblem`, and HUMAN_ATTESTED verification through `attestationVerifierScope`. |
| `decisions/candidate.mjs` | Decision kinds and post-census eligibility (`DECISION_KINDS`, `LATE_DECISION_KINDS`, `decisionKindAllowed`). Candidate identity and digests: `createDecisionCandidate`, `createNewFormatDecisionCandidate`, `candidateDigestOf`, `decisionRationaleDigest`, `decisionLineDigest`. `lifecycleBinding`. Groups: `decisionGroupFor`, `createNewFormatDecisionGroup`, `resolveGroupDecision`, and member facts and group input. The single applicability predicate `decisionAppliesToCandidate`. The artifact candidate shape. |
| `decisions/authority.mjs` | Principal-segregated, chain-verified ledger readers. Append-only late-decision checks. The citation resolver for formats ≤18 (`requireDecision`). The format-19 resolver and its projection (`applicableDecisionOutcome`, `resolveApplicableDecision`, `projectModuleDecision`, `groupAuthorityFor`, `requireModuleDecision`). Consumed-decision identities. The format-19 classification schema. Operation-sequence authorization branding. The artifact consumed-history proof (`verifyConsumedHistory`). |
| `decisions/record.mjs` | Recording: channels, challenges, review rendering and `blockedFor`. The answer half of the approval gate (`operatorAnswer`) and the locked-equality rule (`lockedApprovalCandidate`). Ledger lines (`buildDecision`) and appends. The read-only audit (`auditDecisionLedger`, `verifyRecord`). Explicit relay. The module and artifact derivations over supplied facts. Operation-sequence challenge and rendering. |

`decisions/` imports only `store/index.mjs`, `formats/index.mjs`, `shared/index.mjs` and `node:` builtins. It has no dynamic `import()` and runs nothing at import.

## Dependency inversions

There are two kinds of seam:
- **Fact seams** read state that decisions may not read, and pass it to decisions as plain data.
- **Text renderers** are pure functions that only produce strings. They are the same kind of injection A2 used for `upgradeCommandFor`.

No seam hands decisions a function that reads a fact or takes a lock.

| Was | Now |
|---|---|
| `record-decision.mjs` `derivePendingDecisions` read the scan, legacy sources and legacy binding (census), unclaimed drift (slices) and unbacked visual states (visual), and built candidates while reading them. | The seam `derivePendingDecisions` reads, in order: context, state, classification, scan, legacy binding, both ledgers, drift and visual facts. It then calls `deriveModuleDecisions(facts)`, which builds the candidates and policy bindings, applies the kind eligibility, groups, and projects. `approveCommand` renders the legacy `--approve` hint. |
| `artifact/artifact-migration.mjs` `artifactVisualDecisions` read visual facts (`visualAuthorityOf`, `pendingVisualUnbackedCandidates`, `artifactUiInventory`) and lifecycle facts (`consumedAtCheckpoint`) and built the candidates in the same function. | The seam reads those facts, the matrix and the ledgers in the original order. It then calls `artifactVisualDecisionRows({ state, source, candidates, matrix, ledger, historical })`. |
| `reconcileArtifactDecisions` rendered `engineCommand` (transport) inside the reconciliation. | The engine export is a one-line wrapper that passes a command renderer to `reconcileArtifactDecisionRows`. |
| `withOperatorApproval` combined the decision rules with the lifecycle module lock, the recompute, the toolkit-identity gate and the process exit code. | The decision rules moved to `operatorAnswer` and `lockedApprovalCandidate`; `appendApprovedCandidate` and `appendApprovedGroup` append under the lock. The seam keeps the lock, recompute, identity and format-freeze gates and the exit code, in the same order as before. |
| `autoAuthorization` read the build identity from disk (`activeToolkitIdentity`). | It takes the identity as an argument. The seam reads it under the lock, and only when AUTO answered. |
| `deriveArtifactDecisions` filtered and mapped the artifact engine's rows inline. | The seam lazily imports the artifact engine, as before, and calls `pendingArtifactDecisions(context, ledger)`. |
| `relayOperatorDecision`, `projectDecisions` | The rules moved to `assertRelayDecision`, `relayedReview`, `relayAnswer` and `legacyCompatibilityProjection`. The seam keeps the call into the CLI recorder (transport) and the shape of the BLOCKED and CONTINUE results. |

**One ordering change.** The seam now reads the drift and visual facts before it builds the root and file candidates. Before A3 these reads were interleaved with candidate construction. The ledgers are still read before the drift facts, as before.
- No candidate, id, digest, order or projection changes.
- The only possible difference is which error is reported when the drift or visual read fails in the same call as a policy-file or ledger-ambiguity refusal.

## Guarantees and their one owner

| Guarantee | Public function(s) | Tests |
|---|---|---|
| Candidate identity binds kind, subject, rationale, targets and evidence, and, at format 19, the project root, policy and required principal. | `createDecisionCandidate`, `createNewFormatDecisionCandidate`, `candidateDigestOf` | record-decision.test: "new-format judgment uses only the engine policy…", "a new-format group is one candidate binding its complete ordered member set" |
| Offer == accept: post-census, only late kinds are offered. No format-19 group (a non-late kind) is offered after the census, because the writer would refuse it. AUTO is offered exactly what its gate accepts. | `decisionKindAllowed`, `deriveModuleDecisions`, `autoMayDecide` (offer in `approveWithOperator`, refusal in `operatorAnswer`) | decisions.test: "post-census facts offer only what the writer accepts…"; migration-contract F6-c; "the pinned census never re-offers discovery approvals after legacy edits" |
| No automatic human approval. AUTO never answers a format-19 review. A host or terminal channel never satisfies HUMAN_ATTESTED. | `operatorAnswer`, `blockedFor`, `buildDecision` (writes AGENT_RELAYED v2 only) | decisions.test: "AUTO and a host channel never answer a format-19 review…"; record-decision.test: "a format-19 single candidate cannot write v1, attest via host/TTY/argv, or downgrade to AUTO"; operator-signer: "provider, TTY and MCP surfaces cannot attest…" |
| Only an explicit APPROVE or REJECT records. A legacy challenge needs its exact phrase. | `operatorAnswer` | decisions.test: "only an exact APPROVE or REJECT…", "a legacy challenge accepts only its exact phrase…"; mcp-server.test: "cancel and transport failure are not signed REJECTED…" |
| No stale acceptance: a line is written only against the candidate recomputed under the lock and deep-equal to the reviewed one, at the same principal. | `lockedApprovalCandidate`, `assertReviewedCandidateCurrent` | decisions.test: "under the lock only the deep-equal reviewed candidate is writable…"; operator-approval-authority: "standard relay revalidates evidence and protected policy under the append lock" |
| A weaker principal never satisfies a stronger one. A policy change invalidates outstanding bindings. An unmatched line is never authority. | `principalSatisfiesRequirement`, `decisionAppliesToCandidate`, `applicableDecisionOutcome` | record-decision.test: "…weak principals never satisfy it"; migration-contract: "no fabricated, unbound, stale or mismatched ledger line authorizes a checkpoint" |
| A rejection blocks until the evidence changes; after that the line is stale and never approved. | `applicableDecisionOutcome`, `projectModuleDecision` | decisions.test: "a rejection blocks until the facts change…"; operator-signer: "module 19: signed REJECTED blocks only that candidate digest…" |
| Group approval is atomic. One reviewed group has one entry, and its membership is rebuilt and re-digested. | `createNewFormatDecisionGroup`, `resolveGroupDecision`, `groupAuthorityFor`, `appendApprovedGroup` | record-decision.test: "one reviewed group resolves to one authoritative entry…", "duplicate and conflicting group outcomes fail closed…", "a torn group append is refused whole…" |
| The ledger is principal-segregated, chain-verified, and append-only past the census. | `readOperatorDecisions`, `readAutoDecisions`, `assertLateDecisionsAreAppendable`, `auditDecisionLedger` | record-decision.test: "AUTO stays isolated…", "group audit rejects tampering…" |
| Signer: HUMAN_ATTESTED is trusted only after protected replay verification. | `verifyAttestedLine` (via `attestationVerifierScope`), `attestedLineProblem` | operator-signer: "module 19: forged, edited, unclaimed and duplicated attested lines are refused on read" |
| Relay answers only the review its reference names, and only with the explicit decision. | `relayedReview`, `relayAnswer`, `assertRelayDecision` | decisions.test: "a relay answers only the review…"; migration-contract F6-b |
| CLI and MCP share one gate: both reach `runRecordDecisionCli` → `withOperatorApproval` → `operatorAnswer`. | `operatorAnswer` | mcp-server.test: "with client elicitation the server originates the approval request", "migration_pending_decisions deep-equals the core reader…" |
| AUTO provenance names exactly the build identity the seam read. | `autoAuthorization` | decisions.test: "AUTO provenance names exactly the identity its seam supplied…"; auto-authority.test |

Architecture checks:
- `decisions.test.mjs`:
  - **A3-ARCH-1:** every decisions declaration has exactly one live definition, and it is inside `decisions/`.
  - **A3-ARCH-2:** engine code imports decisions names only through `decisions/index.mjs`, never through a compatibility re-export.
  - **A3-ARCH-3:** the files inside `decisions/` import each other acyclically. A1-ARCH-2 forbids `store/`, `formats/` and `shared/` from importing decisions. Together these mean decisions can be on no engine import cycle.
  - **A3-ARCH-4:** every BASE compatibility export is still present and is the decisions binding itself, not a copy.
- `store-shared.test.mjs`: A1-ARCH-1 and A1-ARCH-2 now also cover `decisions/`. Decisions has a single entry; it imports only `store/`, `formats/` and `shared/` index files, statically and dynamically; and it runs nothing at import.

## Compatibility

These modules keep every export name, arity and value they had at BASE: `core.mjs`, `resumable-migration.mjs`, `record-decision.mjs`, `operator-approval.mjs`, `operation-sequence.mjs` and `artifact/artifact-migration.mjs`. Moved names are thin re-exports of the decisions binding. `reconcileArtifactDecisions` keeps its `(state, decisions)` signature.

One name became public that was module-private before: `consumedDecisionStore`, the consumed-identity scope. The lifecycle advance in `resumable-migration.mjs` opens that scope, so it must reach it through the entry. Only `resolveApplicableDecision` records into it.

The CLI entry blocks are unchanged, along with their arguments and the CLI and MCP adapters. Formats ≤18, format 19, and artifact formats 13 and 14 keep their decision paths: the legacy challenge, the AUTO ledger, the direct ledger and the signer path.

## Not moved, with the reason and owning phase

| Declarations | Reason | Phase |
|---|---|---|
| `record-decision.mjs`: `derivePendingDecisions`, `moduleRecompute`, `pendingDecisionCandidates`, `projectDecisions`, `recordNewFormatDecisionGroup`, `withOperatorApproval`, `approveCandidate`, `approveDecisionGroup`, `deriveArtifactDecisions`, `relayOperatorDecision` | Orchestration seams. They read census, slice and visual facts; take the lifecycle module lock (`withModuleLock`); assert the toolkit identity (`assertRecordToolkitIdentity`, which reads disk); set the transport exit code (`BLOCKED_EXIT_CODE`); or call the CLI recorder (`runRecordDecisionCli`). No decision rule is left in them. | A8 lifecycle (lock and recompute), A7 transport |
| `record-decision.mjs`: `attestedRecompute`, `attestedBinding`, `reviewAttestedCandidate`, `beginAttestedDecision`, `completeAttestedDecision`, `webauthnProtocol`, `refused` | The protected-signer boundary. These functions drive a signer object (issue, preverify, claim, commit) under the module lock, and lazily load the WebAuthn verifier. Signer host operations stay at their boundary. | A8 / signer host |
| `operator-webauthn.mjs` (21) | Lazily loaded on purpose: it imports `@simplewebauthn/server`. A static re-export from `decisions/index.mjs` would load that dependency into every engine process. `operator-signer.mjs` imports it statically. | stays a separately loaded protocol file |
| `operator-signer.mjs` (20), `operator-signer-service.mjs` (2) | Impure host code: root-owned store files, HTTPS companion, process entry. | signer host / A7 |
| `operation-sequence.mjs` `authorizeOperationSequence`, `deriveOperationSequence`, `operationSequenceRunner` | Authorization reads `isAutoAuthority` (below). Derivation and running call lifecycle previews and bootstrap. The pure vocabulary moved: kind, challenge, rendering, member facts. | A8 |
| `resumable-migration.mjs` `isAutoAuthority`; `migration-policy.mjs` `maySelfConfirm` | Read the lifecycle mode default `DEFAULT_MODE`. | A8 |
| `resumable-migration.mjs` `readMigrationContext` | Alias of `readContext`, which is store-owned but blocked in A1. | A1 residue / A8 |
| `operator-approval.mjs` `approveWithOperator`, `recorderFor`, `moduleApprover`, `artifactApprover`, `carryChannel`, the terminal and AUTO recorders, `AUTO_REASON` | Offer loop and recorder adapters around the CLI recorder (transport). The offer predicate it applies, `autoMayDecide`, is decisions'. | A7 |
| `mcp-server.mjs` `trustedDecisionRecorder`, `CONFIRMATION_SCHEMA`, `ELICITATION_TIMEOUT_MS`; `cli/run-migration.mjs` `pendingApprovals`, `decisionCandidates`, `operatorApproval` | Transport adapters. | A7 |
| `artifact/artifact-migration.mjs` `artifactOperatorDecisions`, `artifactVisualDecisions`, `reconcileArtifactDecisions` | Fact seams for the artifact engine: locate, freshness, source inventory, visual and lifecycle facts, and the command renderer. | A6, A8 |

Not taken from the owners-b map: `DECISION_PROJECTION_STATES` stays in `resumable-migration.mjs`. Owners-b assigns it to lifecycle (R5), and no decisions function reads it.

## Remaining dependency violations

- **decisions/ outgoing:** none. It has no edge to lifecycle, slices, census, visual or transport.
- **Into decisions:** from the seams above, all downward.
- **Store-blocked rows now unblocked:** A1 recorded `assertLateDecisionsAreAppendable` and `verifyConsumedHistory` as blockers of the store pins cluster and of `validateIntegrity`. Both are in `decisions/` now, so those store rows wait only on their other blockers.
- **Violations still present:** these belong to the seams' owners. `withModuleLock` and the recompute stay in lifecycle until A8, and `runRecordDecisionCli` and `BLOCKED_EXIT_CODE` stay in transport until A7.
