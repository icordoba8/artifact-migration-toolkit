# PR #21: module visual-applicability decision policy

Date: 2026-11-05. Implementation: GPT-6 Astra, Ponytail full (installed skill).
Starting PR HEAD: `b300bd19d7db16981a057e83cd86091c05bba956`.
The two existing commits and all prior investigations/evidence are preserved.
Starting cumulative diff SHA-256: `db9b0ad7871af9c603d2f5792ba890d2b37e7a6ba5ba3dfe925f251834e1b130`.

## Decision and acceptance boundary

- A reachable owned INCONCLUSIVE file under `hasVisibleUi: false` requires
  `VISUAL_APPLICABILITY`, proposed as `module-classification.visualApplicability.rationale`.
  Confirmed rendering cannot be waived; nonvisual, unreachable and supporting-only
  files create no waiver requirement. Existing inventory consistency rules remain.
- Reuse the recorder, policy resolver, ledger, candidate projection and locked
  recomputation. Legacy formats cite operator receipts; direct-ledger formats
  resolve explicit decisions. AUTO cannot write or satisfy this kind.
- Preserve `engine/STANDARD_LOCAL/v1` bytes and digest
  `sha256:f38ec59bad6a56b15e7c5c1a87f9a003591644de0203bd5a7ff91df82af81042`.
  Only the new kind selects `engine/visual-applicability/v1` by default.
  Protected policy omission still requires HUMAN_ATTESTED. Historical policy
  resolution does not reinterpret either default as authority for other kinds.
- Check fresh discovery and every ACTIVE post-discovery validation boundary.
  Recompute from the pinned classification and compare with the discovery pin;
  persisted reachability/kind maps cannot suppress the requirement. The recorder
  verifies completed artifact hashes before reading candidate inputs.
- Closed discovery cannot gain this decision. Recovery is `--reopen-discovery`
  before any verified slice, otherwise the operator's `--refresh --confirm-mismatch`.
  COMPLETE records are exempt from the new applicability rule.
- A group reader verifies unique homogeneous membership, shared module binding,
  and matching policy/principal before granting authority. A mixed-kind group
  cannot borrow a weaker principal from its first member.
- No format bump, dependency, new approval channel, or historical record rewrite.

## Independent AI review

Reviewer: GPT-6 Astra, separate session
`ses_e52744ad9ffeew2Jf2FYmudMyn`; no source/test edits by reviewer.
All reviews are AI technical reviews, not human acceptance.

Architecture review initially blocked on unauthenticated stored scan metadata,
legacy AUTO receipts, and ACTIVE records past assessment. The corrected design
received APPROVE before implementation.

Implementation review initially found mixed-kind group principal borrowing and
unverified pinned artifacts on the recorder path. Both were fixed at their shared
validation points and covered by reproductions. Independent re-review verdict:
**APPROVE**, no remaining blocking or major finding, over base `b300bd19…` and diff
SHA-256 `fe75c0e5178ec15526685f78e388a9e743ad3daf27eb9f66fbb24606bd877eea`.
The reviewer independently checked mixed-kind/duplicate/foreign-binding group
refusals and valid homogeneous group authority with one consumed identity.

After approval, one existing integration test was extended to advance an approved
waiver through ASSESS_TARGET, preserve the previous history prefix, check one
consumed identity per checkpoint, and verify recovery idempotence. It passes.
Final implementation diff SHA-256 (excluding this report):
`bf326d2a0575321a8632102a2e46a48ff1b5f440e60001d168d8845e0c974022`.
The final test-only review request failed with:
`Subagent failed (sessionID: ses_e52744ad9ffeew2Jf2FYmudMyn): You have exceeded your monthly quota`.
That test extension and this report are not covered by the independent APPROVE.
No human owner acceptance or release sign-off is asserted.

## Verification

Node 22.23.4, pnpm 11.21.0, Linux. Logs and isolated historical fixtures are in
`/tmp/opencode/pr21-module-policy/`; retained evidence is copied to
`/home/utmwac/amt-verify-logs/pr21-module-policy-20261105/`.

| Check | Evidence/result |
| --- | --- |
| Focused decisions/integration | 34/34 pass (`focused-review-fixes.log`) |
| Later-checkpoint extension | Integration suite passes (`later-checkpoint.log`) |
| Full suite, approved production diff | Engine 35 + 1,244 pass; TypeScript 69 pass; providers 198 pass, one Windows-only skip (`full-tests-review-fixes.log`) |
| Architecture/provider projection | Pass (`architecture-final-acceptance.log`, `providers-final-acceptance.log`) |
| Red baseline | Seven new regressions fail against original PR runtime; 25 existing tests pass (`red-baseline.log`) |
| Golden rehearsal | All 20 steps match, golden unchanged (`rehearse-default-temp.log`) |
| Historical policies | Both historical policy digests and STANDARD_LOCAL object unchanged |
| Outstanding old approval | Candidate ID, digest, authority and all 23 record files unchanged |
| Consumed old approval | Validation passes; all 24 record files unchanged |
| Old inconclusive ACTIVE record | Now blocks with recovery; all 23 record files unchanged |
| Real historical stylesheet | `index-77e9a449e135` remains COMPLETE/CONSUMERS; identical status and every recorded file hash |

Historical approval fixtures were produced by the original `b300bd19…` runtime,
then read/validated by the changed runtime. The real record was read in an isolated
mount namespace over the preserved copy, retaining its absolute path bindings.
These are before/after checks, not regenerated expected values.

One full run was interrupted by the requested model/session restart; its passing
engine results are retained but the complete replacement run above is authoritative.
Relocating TMPDIR caused a baseline-identical rehearsal digest mismatch; the default
path passes, and the golden was not updated. An initial negative replay failed on
scratch cleanup (`ENOTEMPTY`); a dedicated scratch root is used for its rerun.

Required CI remains all three Ubuntu shards and `toolkit (ubuntu-latest)` on the
exact pushed commit. Local results and a prior commit's green CI do not substitute.
Final CI URLs/results belong in the PR's post-push evidence, avoiding another
untested commit solely to record its own SHA. No READY claim is made by this report.
