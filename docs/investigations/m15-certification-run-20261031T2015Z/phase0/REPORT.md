# M15 Phase 0: PATH B, historical diagnostics, joint-candidate boundaries

**Disposition: SUPERSEDED. Identities: OK. No certification is awarded.**

Prepared 2026-11-02 by GitHub Copilot CLI (GPT-6 Astra), not Claude Code/Opus.
The historical reports retain their original executor labels. This phase is
analysis and evidence only: no provider invocation, acceptance run, S3 review,
S4 closing, authentication, host change, or engine/skill/receipt/verifier change.
Ponytail level: lite. Timebox: 21:30:45Z through 22:15:45Z.

## Evidence and authority

`RUN` means the original persistent directory
`/home/utmwac/artifact-migration-toolkit/docs/investigations/m15-certification-run-20261031T2015Z`.
`INV` is its parent. `FINAL` means
`INV/m15-certification-final-20261101T0100Z`.
`M` means `INV/m15-certification-plan-20261030T2045Z/MATRIX.md`.
`P0` means `docs/investigations/m16-copilot-20261102/p0/P0.md` at
`a2117bfd79748d1ea23f33323bbce878bfe6092e`.

Selected original narrative evidence is copied, unchanged, under `sources/`
using paths relative to `INV`. It is historical, not a new attestation.
`observations.json` holds allowlisted report extracts, full hashes and exact
source pointers; `SOURCE-SHA256SUMS` pins those original inputs.
`contracts.txt` contains numbered excerpts from immutable Git objects.
`recordings.json` contains discovery scope and video metadata/hashes, not videos.
`SHA256SUMS` covers every file in this directory except itself.
No credential file, token, or credential hash was read or included.

### Controlling decision (HUMAN_ATTESTED)

The owner pasted the following rulings in the current request on 2026-11-02;
the transcript timestamp is 2026-11-02T16:30:30.673-05:00. This records the
statement's provenance, not a signature, approval of future bytes, or permission
to perform the future tasks:

> PATH B with a joint candidate: row 17 + Bootstrap AUTO contract text + T1 (Copilot MCP registration via providers/install-support.mjs) ship in ONE new candidate.
>
> The current Codex candidate is SUPERSEDED: no further scored runs (R6c, R7-R11), no S3 review, no S4 closing on it. Its evidence is preserved as historical and used as diagnostics only.
>
> G1 harness workaround stays REJECTED (recorded in cert/m16-copilot-20261102 @ a2117bfd79748d1ea23f33323bbce878bfe6092e, p0/P0.md).

The source request uses an en dash in `R7-R11`; this ASCII transcription changes
only that punctuation. The complete G1 quotation is in P0:34:

> "G1 harness workaround (harness writing Copilot MCP config) is REJECTED. G1 remains GAP until the toolkit payload itself registers the MCP server for Copilot CLI (task T1). T1 requires a new release candidate."

**Decision recorded:** one future candidate contains row 17's engine/protocol
resolution, the Bootstrap AUTO contract correction, and T1. Engine/payload and
infrastructure work remain separate tasks below. No new candidate is created
here. No historical PASS, owner exception, CI result, or review is a PASS for
the future identity; every matrix row must be re-proved or explicitly recorded
NOT_TESTED for an unclaimed provider/platform.

This portfolio **PATH B is not S0's Bootstrap option B** ("contract governs").
The earlier owner ruling A, `RUN/s0/OWNER_PAUSE_1.md:8`, intended AUTO
self-confirmation and deferred a documentation correction. The current ruling
puts that correction in the joint candidate; it does not invent a new AUTO
ledger requirement or silently reverse the earlier semantic ruling.

Historical R7-R11, R12 and FINAL's S3/S4 records already exist with timestamps
from October 31/November 1. They are retained as diagnostics, not erased,
repeated, newly approved, or used to close this superseded candidate.

## 1. Historical identities

| Identity | Full value |
|---|---|
| M15 comparison BASE | `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d` |
| M16 frozen BASE (different purpose) | `15090145a43af1e1bcb9fbce692fafac6e06f1e9` |
| Release manifest's toolkit commit (unpublished 1.6.5) | `874806fc778295b6017a635f6aae51ce8c782e51` |
| S0 harness | `42364020d6db36a60327b271dc83bfbebc4daf4e` |
| S0 AMT_PATCH_SHA256 | `35d5cb6109b1c4543fededc42cee9b6e0e6d38a0f417448c21ae7ad227fbe296` |
| R1-R5, original R6, R7-R11 harness | `64a1a4c88147507227ca9bd927191486f6dc28e5` |
| Its AMT_PATCH_SHA256 | `778d1d5be16f97a0dd9a81d637cdfb3ec96e5e15cfc9e872be24ac752a488533` |
| R6 native fix; R6b/R12 harness | `1a9661b3aba58d7e8fe41076d5e72b3d1d87701a` |
| Its AMT_PATCH_SHA256 | `244b32d897c06b8e537cb6f3e73862453bf720bc39d96a6c543fc324282a423a` |
| Release manifest pin | `sha256:bbf8b295722287014407d2c6bf7bd5293105f3f65ea0575f92d135ab1fabbbf6` |
| Payload contentHash | `sha256:1f9786e285d5ec2d183a0f9f91d8f64a5a46e6100e42a5b9fab7d5394bafaaf7` |
| Codex 0.165.0 binary SHA-256 | `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5` |
| Node 22.13.0 binary SHA-256 | `af8d5d1e234beb26b3095e6bebf80edc781f79c9435553a383037eccec2716f8` |
| pnpm 11.21.0 archive SHA-512 | `521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1` |
| M13 verifier SHA-256 | `ff0b7d20fd5a11ee67627e2732051c5fb83cc2de9944d667f3a061481e86c221` |
| M14 verifier SHA-256 | `a0055e2d9571f86d27bae315f18ea8717686efefed6e36e1a633d9ed95bc52e7` |
| Provider/model/platform | Codex 0.165.0 / `gpt-6.1-sol`, high / WSL2 Ubuntu 24.04, kernel 6.18.33.2; not a native Windows claim |

Checks: all three complete BASE-to-commit patches reproduce their stated
digests using the exact diff options in `scripts/m15-patch.sh`; both stored
S1 patches also match. A default `git diff --binary` gives different bytes
because it omits the canonical no-indent-heuristic/no-renames settings; this
serialization difference was resolved, not treated as an identity mismatch.
The release manifest pin and all 1,243 manifest-listed files were rehashed
read-only, and both verifier files matched. Every historical run report agrees
on the manifest pin, toolkit identity and runtime. S0/S1/native-fix/runs
SHA256SUMS all verified before copying.

Local cert HEAD initially lagged at `64a1a4c88147507227ca9bd927191486f6dc28e5`;
the remote was already `1a9661b3aba58d7e8fe41076d5e72b3d1d87701a`.
The clean local branch was fast-forwarded to that existing commit, without
reimplementing its fix. This evidence commit is based on the remote native-fix
commit. It is **not** a new approved harness/payload identity. Recomputing a
BASE-to-HEAD patch after adding these evidence files must not be paired with
either historical AMT_PATCH_SHA256.

Historical exact-SHA CI: S0 41234280726, headless 41246968597, native
41253081464. These are stored evidence, not CI executed by this phase.

## 2. R1-R12 diagnostic inventory

`SCORED_PASS` means the historical scenario's runner criterion passed, not
production acceptance or native-UI proof. Interrupt and safety passes never
mean COMPLETE. `SCORED_FAIL` preserves a historical runner failure after a
model invocation. `INFRA_ONLY` means no model invocation; `NOT_COUNTED` means
no submitted prompt/run. No run's status is UNKNOWN. Unlocated recordings and
unattested provenance are explicitly unknown/missing evidence, not invented.

All time budgets were **30 minutes per run**. Times below are wrapper wall
clock, including native operator exit, rather than only model work.
S0's 480-minute overall allowance was superseded by the owner's 02:00Z hard
deadline and 01:10Z no-new-run cutoff (`runs/OWNER_INSTRUCTION_4_DEADLINE.md`).
Pacing evidence exists in `runs/pacing.ndjson`; no allowance wait is recorded.
Token totals, cached/input/output breakdowns and exact timestamps are in
`observations.json`; interrupted totals are the last observation, not a final
completed-turn bill.

| Run | Status | Functional result | Operational / 30m | Recording | Original evidence under RUN/runs |
|---|---|---|---|---|---|
| R1 | SCORED_PASS | E2E_COMPLETE_PASS; M13 36/36 | 2m33s, within | Headless; no screen recording located; logs/rollout present | `R1/fresh/report.json`, `R1/result.md` |
| R2 | SCORED_PASS | INTERRUPTED_CHECKPOINT; rev 2, not completion | 2m18s, within; intentional SIGKILL escalation | Headless; logs/rollout present | `R2/interrupt/report.json`, `R2/result.md` |
| R3 | SCORED_PASS | E2E_COMPLETE_PASS; M14 37/37; history/artifacts preserved | 4m55s, within | Headless; logs/rollout present | `R3/resume/report.json`, `R3/result.md` |
| R4 | SCORED_PASS | SAFETY_REFUSAL_PASS; live owner and consumer unchanged | 1m43s, within | Headless; logs/rollout present | `R4/live-lock/report.json`, `R4/result.md` |
| R5 | SCORED_FAIL | FAIL; unchanged consumer but refusalObserved=false; F1 unrecovered | 29s, within; process exit alone is not success | Headless; refusal is in rollout | `R5/read-only/report.json`, `R5/result.md` |
| R6 | INFRA_ONLY | No model turn; native bootstrap failed | TUI about 1s; Launch 1 outer timestamps overwritten by refused Launch 2 | Edge video located, not terminal proof; earlier 4s terminal clip predates launch | `R6/native/report.json`, `R6/result.md` |
| R6b | NOT_COUNTED | No prompt reached model; TUI startup fixed | 10m50s idle, within; not execution | Not located; PTY exists, no rollout | `R6b/native/report.json`, `R6b/result.md` |
| R6c | NOT_COUNTED | NOT_RUN: deadline; no launch/model call | No run; window manually stopped 01:12:47Z | Not located; no native output | `R6c/window/NOT_RUN` |
| R7 | SCORED_PASS | INTERRUPTED_CHECKPOINT; not completion | 1m06s, within; intentional SIGKILL escalation | Headless; logs/rollout present | `R7/interrupt/report.json`, `S2.md` |
| R8 | SCORED_PASS | E2E_COMPLETE_PASS; M13 36/36; history/artifacts preserved | 2m06s, within | Headless; logs/rollout present | `R8/resume/report.json`, `S2.md` |
| R9 | SCORED_PASS | SAFETY_REFUSAL_PASS; live owner and consumer unchanged | 1m51s, within | Headless; logs/rollout present | `R9/live-lock/report.json`, `S2.md` |
| R10 | SCORED_PASS | BOOTSTRAP_PASS; RECLAIMED_IN_AGENT_REALM; no manual removal | 2m38s, within | Headless; logs/rollout present | `R10/realm-abandoned-lock/report.json`, `S2.md` |
| R11 | SCORED_FAIL | FAIL; unchanged consumer, refusalObserved=false; raw ENOENT | 33s, within | Headless; refusal is in rollout | `R11/read-only/report.json`, `S2.md` |
| R12 | SCORED_PASS | E2E_COMPLETE_PASS; M13 36/36, but row 30 not proved | 7m57s, within; model work about 2m15s | Not located; historical REC=yes is not a file; PTY/rollout present | `R12/native/report.json`, `R12/result.md` |

R12's SCORED_PASS preserves its runner's functional E2E_COMPLETE_PASS, not
acceptance of row 30. Its report explicitly retains `nativeUiCertified: false`
and `security.certified: false`; the missing recording leaves native UI unmet.
R6/R6b's runner FAIL is not a scored functional failure: neither reached a model
turn. R6's second launch was refused before Codex and is not another run.

Recording discovery on 2026-11-02 located two MP4s in
`/mnt/c/Users/icordoba/Videos/Captures/`: the 18:07:32 Edge handoff recording
(65,480,537 bytes), and the 18:05:34 terminal clip (2,470,129 bytes).
The historical R6 report/final risk classifies the first as the wrong window;
the second ends before the 18:08:08 local R6 launch. Neither proves row 22.
No matching R6b/R6c/R12 recording was located in the bounded profile,
OneDrive, public Videos or ScreenSketch/Xbox capture-cache searches recorded in
`recordings.json`. This is not a claim that no file exists anywhere on C:.
No video was added to Git, and no new attestation is inferred from filenames.

## 3. Engine/payload tasks (no implementation)

Each root cause appears once. These tasks are distinct from infrastructure
tasks even where the same failed run exposes both. A proposed boundary is not
approval to implement it.

| Task | Root cause, variants and state | Affected matrix rows | Evidence | Proposed fix boundary |
|---|---|---|---|---|
| E1 | Fresh module setup has no usable registry binding; registry resolution throws before the advertised fresh-module BLOCKED/setup path. MCP translates this to generic -32603. F1 in Attempt 3, R2/R4 is recovered autonomously; in R5 it is not. | 9, 15, 16, 18, 20, A5 | `store/registry.mjs:316-351`, `transport/mcp.mjs:227-232,606,686`, `skills/start-migration/SKILL.md:311-328`; `R2/result.md`, `R4/result.md`, `R5/result.md`; exact log/rollout lines in observations | Shared first-setup preflight/result contract and consistent skill guidance; expose the missing binding/action without fabricating a registry or overriding existing authoritative bindings. Preserve CLI/MCP parity and fail-closed mismatch checks. Not per-run rescue flags. |
| E2 | Owner proof is PID-realm-local, while module bootstrap is CLI-only and successive Codex shell invocations have different PID realms. A genuinely dead owner cannot be proved gone from the next CLI realm. Host-realm and nested-shell variants are one protocol/topology gap. R10's same-realm MCP artifact success does not solve module row 17. | 17; 25 limited to tested realm; interruption/recovery risk for 15, 23 | `lifecycle/lock.mjs:142-147,169-176`; `transport/mcp.mjs:185-191`; `RUN/s0/S0.md` row 17; `RUN/s1/report.md`; runbook known blockers; R10 lock fields | Engine/broker design for a stable, provable ownership topology and an authorized module bootstrap path, or explicit reviewed contract amendment. Preserve live-owner/unknown-owner refusal; never infer death from a foreign PID, delete locks, or substitute a harness repair. |
| E3 | AUTO policy and shipped contract text disagree about bootstrap/registration. Implementation intentionally self-confirms; the canonical and generated docs still promise a two-phase stop. This is a payload contract defect, not evidence that AUTO is unauthorized after historical ruling A. | 9, 12, A6; all providers carrying the shared text | `migration-contract.md:1063-1066,1092-1095`; `v5-contract.md:216-225`; `lifecycle/policy.mjs:119-124`; `lifecycle/artifact-run.mjs:186-205,231`; `RUN/s0/OWNER_PAUSE_1.md` | Correct the canonical contract under the recorded AUTO ruling, review frozen-v5 upgrade/hash implications, regenerate provider projections and release identities in the joint candidate. Do not silently add an AUTO ledger obligation or edit installed copies. |
| E4 | Expected filesystem inability is exposed as an untyped internal MCP error. R11 reaches lock-parent mkdir and emits raw ENOENT; the transport drops structured error data. This is a diagnostic-contract gap, not proof that ENOENT itself means EROFS or that the engine wrote on a read-only mount. | 26; shared refusal surface also 18, 16, 24 | `R11/read-only/agent.stdout.log:10`, rollout line 47; `lifecycle/lock.mjs:196-202`, `store/files.mjs:36-38`, `transport/mcp.mjs:686` | Shared filesystem/tool-result diagnostic boundary: preserve actual errno and operation, distinguish setup absence from a demonstrated permission/read-only refusal. Do not normalize arbitrary ENOENT to safety PASS. The exact reason for that errno is unresolved from preserved evidence; any runtime investigation belongs to a later authorized task. |
| T1 | Copilot registration targets VS Code's .vscode/mcp.json/servers, not Copilot CLI's loadable mcpServers configuration. Generated template also lacks required tools/env. Runtime reasserts the wrong registration. G1 remains GAP. | Copilot 1, 7-13, 15-18, 20, 22-26, 28, 30, 31, A1-A3; identity impact is ALL Codex rows | P0:28-42,48-59; frozen-BASE literal excerpts in section 5 | Provider payload/install-support, generator, registration/receipt/runtime convergence and shared documentation; register the nine tools without migration_relay_decision and carry pnpm_config_pm_on_fail. New candidate and provider tests. No harness-authored MCP config; keep receipt ownership, merging and conflict refusal. |

Paths without a prefix in the table are under
`packages/migration-engine/src/`, except explicitly named `skills/` paths and
contract basenames, which are under `skills/start-migration/references/`.
Engine source bytes relevant here are unchanged between the frozen release
lineage and the native-fix harness. T1 is a release-payload task, not a new
engine rule; it is deliberately not hidden in the infrastructure list.

## 4. Infrastructure tasks and evidence/process gaps (no implementation)

| Task | Root cause / grouped variants / disposition | Rows | Evidence | Proposed fix boundary |
|---|---|---|---|---|
| I1 (H-1) | Refusal detection reads stdout/stderr, not actual code-mode tool output in the rollout. Both R5 and R11 therefore fail while the consumer remains unchanged. This is a harness defect but the scored results remain FAIL, not INFRA_ONLY. | 18, 26 | `R5/result.md`; `S2.md`; R5 rollout lines 18/30; R11 lines 18/38; runner `:575-577` at native-fix | Trusted ingestion/binding of provider tool-result evidence, plus existing unchanged/no-record/no-timeout checks. Do not accept arbitrary prose or ENOENT as a refusal; do not mutate old reports. Coordinate with E4 without mixing tasks. |
| I2 | Native TUI validates the override layer independently; grants without command/args form an invalid server table at account/read. Fixed historically in the native-only harness commit; headless argv unchanged. | 22, 30, A1 | `R6/result.md`; `s1/native-fix/report.md`; commit `1a9661b3aba58d7e8fe41076d5e72b3d1d87701a` | Carry the reviewed harness fix and its preflight equality check forward; no installed-config rewrite. Re-prove on the new harness rather than reopen R6. |
| I3 | Native handoff does not keep the one invocation visible/confirm its submission after the TUI redraw. R6b idled without a model prompt; "done" was mistaken for a submitted run. Visibility is a plausible contributor, not a proven statement about operator intent. | 22, 30, A3 | `R6b/result.md:4-10`; native PTY and rollout counts | Launcher/operator handoff only: durable one-shot instructions and observable submitted-turn boundary. No automatic rescue turns or model-call substitution. |
| I4 | Recording is not bound to the scored window/session and not checked as an artifact. R6 captured Edge; R12 REC=yes had no located file; a short earlier terminal recording cannot substitute. | 22, 30, 37, A3 | `R6/result.md`, `R12/result.md`, FINAL/report.md section 9; `recordings.json` | Recording procedure and evidence intake: verify terminal/window and timing, retain original video outside Git, hash and link it; PTY text and human REC=yes remain distinct evidence types. |
| I5 | Outer launch metadata is mutable on a rejected retry: launch-native.sh overwrote Launch 1 start/end/exit with Launch 2's preflight refusal. Fixed historical wrapper claim, not retroactive recovery. | 22, 37, A3 | `R6/result.md` Launch 2; FINAL/report.md section 9 | Reserve/refuse output before writes; immutable per-launch metadata. Preserve surviving native report/PTY timestamps and disclose unrecoverable outer metadata. |
| I6 | Driver looks up report by goal instead of scenario, emitting NO_REPORT despite valid reports. R7-to-R8 gate used the correct path. | 23-26, 37 | `S2.md:5`; `runs/drive.log`, `runs/drive-r7-r11.sh` | Wrapper report-path selection only; derive from the actual output path. Never reinterpret the log as missing execution. |
| I7 | Deadline guard selects processes by a command-line pattern matching itself, so it kills itself instead of the waiting window. R6c was stopped manually before any launch. | 22, 37, A3 | `R6c/window/NOT_RUN`; FINAL/report.md section 9 | Track the exact child/process identity and distinguish waiting windows from active invocations. Do not terminate an active scored invocation to meet a start cutoff. |
| I8 | Abandoned-lock fixture originally planted owners in the host realm, which cannot exercise agent-realm reclaim; plant-failure cleanup also left a FIFO. Both addressed for the artifact fixture by S1, not a fix for E2. | 25, A1-A2; row 17 still blocked | `s0/S0.md` row 25; `s1/report.md` tests/review; commit `64a1a4c88147507227ca9bd927191486f6dc28e5` | Preserve fixture setup/gate/cleanup controls and owner pinning; re-prove failure cleanup and same-realm artifact topology. Do not extend its PASS to module bootstrap. |
| I9 | Toolchain reproducibility was not end-to-end: stale Corepack keys, pnpm auto-download, missing MCP env forwarding, writable unpack and retained unpack trees. Historical pnpm fixes exist; yarn still uses stale Corepack. | 7, 32-35, A1-A2 | S0 section 4; `m15-node2213-phase2-20261031T1838Z/report.md`; `m15-pnpm-hardening-20261031T1910Z/report.md` | Future harness/tool provisioning task, preserving signature/hash checks, RO store and env propagation. Keep yarn unsupported/unproved until a separately authorized solution; do not modify this host. |
| I10 | Exact-platform regression evidence is incomplete: CI Node 22 resolves to 22.23.4, namespace/tarball tests skip on CI, Node 22.13 lacks registerHooks; only targeted local tests cover some paths. | 32-35, A1-A2 | S0 row 35; S1 CI skip; Node phase-2 report gates/risks; pnpm hardening CI details | Certification CI/provisioning and coverage accounting; explicitly distinguish pass/skip and official runtime. No relabeling targeted evidence as a full exact-runtime suite. |
| I11 | Credential provenance and provider-side disposal are not established by successful login, quota values, or file deletion. Required owner statement/revocation evidence is absent from the reviewed package. | 3, A4 | ADDENDUM C2/C4; FINAL/review.md rows 3/A4; FINAL/report.md sections 5/9 | Owner evidence task, outside implementation. Never infer account identity or ask this phase to authenticate/revoke. AGENT_RELAYED is not HUMAN_ATTESTED. |
| I12 | Preservation/redundancy proof is incomplete across stages: S0 had one vault copy; FINAL later asserts an extracted second copy, but reviewer lacked it and placeholders section 5a/6a were not filled. OneDrive local placement alone is not off-device durability. | 37, A4, A7 | ADDENDUM C1; FINAL/review.md row 37; FINAL/report.md sections 5-6; owner destination record | Evidence retention task, verify authorized second-copy/off-device receipt without touching credentials. This phase pins selected sources only; it is not S4 closure or a new vault audit. |
| T2 | Copilot sandbox prerequisite missing at frozen P0: system bubblewrap absent. Installing it may also change Codex's chosen bwrap binary. | Copilot 6-7, A2; Codex 7/A2 environment identity | P0:41,86-98,185 | Separately authorized host-provisioning task after a new environment plan. Supersession does not authorize installation or lift the no-host-change scope. |
| T3 | Frozen main BASE lacks the M15 hardened adapter contract; a Copilot adapter cannot claim parity with code absent from its selected base. | Copilot A1-A2 and affected scenario rows | P0:14,42,93-98 | Separate harness/base-selection task: owner-approved lineage incorporating reviewed hardening. Do not merge main here. |

### Residual risks, not invented failed runs

- **Interruption race:** polling cannot atomically stop the next engine call.
  S1/runbook documents fail-closed locks/journals; R2/R3 and R7/R8 preserved
  checkpoints. Reliable interception would need engine coordination in a
  separately scoped task, not deleting locks after interruption (rows 15/23).
- **Record continuity:** filesystem events are best effort, not an append-only
  trusted anchor. RO toolkit/verifier protection does not prove malicious-agent
  record integrity; network is shared and the agent can author consumer state.
  `agent-e2e-acceptance.md` security limitation and runbook apply (A2).
- **Toolchain residuals:** SIGKILL bypasses unpack cleanup; SIGTERM to only the
  launcher PID defers its trap until the runner exits. Target pnpm configuration
  precedence over the environment was not proven. Shell env propagation in S0
  was static reasoning; do not convert it to observed runtime evidence.
- **Host drift:** defaults auto-update, and P0 records enabled unattended APT
  timers. A new candidate needs newly recorded sandbox/runtime conditions;
  no service, package or policy is changed here.
- **Copilot P0 uncertainties:** nested sandbox viability, prompt-mode denial
  behavior, native permission prompts, model routing, usage-output schema and
  policy-only built-in file edits remain unproven. T1 fixes G1 only.
- **Row 14 is an evidence gap, not a defective validator:** zero authentic
  OpenSpec rejections/corrections were observed. It remains NOT_TESTED/unmet;
  do not seed malformed proposals, force a rejection, or call absence PASS.
- **Rows 19/27:** historical logs report zero genuine decision stops and the
  contract is conditional. Historical conditional N/A is not coverage of a
  human decision path, nor an N/A approval for the next candidate.
- **Agent errors are not separate engine defects:** artifact `--status` plus
  `--mode` refusals (R1/R7/R8/R9), guessed paths/rg no-match, early authoring
  before a record existed, R5's wrong MCP server name, and SKILL_UNAVAILABLE
  are preserved diagnostics. Expected live-lock refusals are safety behavior.
  No new engine root cause is inferred merely from a nonzero command exit.
- **Mixed harnesses:** historical identities are explicitly separated; tests
  assert headless argv equality, but this never makes their commit hashes equal.
  Neither old hash can identify the joint payload.

## 5. Literal contracts and T1 at frozen BASE

Excerpts below are tied to immutable objects in `contracts.txt`, not current
line numbers on a future branch. `D` is
`docs/agent-e2e-acceptance.md` at M15 BASE
`d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d`.

**Row 17 - D:38-41:**

> 5. Installation in a clean consumer, a provably abandoned lock, a live lock
>    and a sandbox deliberately configured read-only; only the first two may
>    proceed. A legitimate refusal is a passing *safety* result, not an
>    autonomous-completion result.

"First two" refers to clean installation and provably abandoned lock, not to
live lock. In combination with the case and the historical owner literal-text
ruling, safe foreign-realm refusal does not demonstrate abandoned-lock recovery.
Keep row 17 blocked; satisfy it in the new candidate or explicitly amend the
contract. Do not claim R10 proves it.

**Bootstrap AUTO - `skills/start-migration/references/migration-contract.md`
at M15 BASE:1063-1066:**

> format-specific flag or separate confirmation exists. The carve-out is a bootstrap
> (`NOT_STARTED`): initialization pins the OpenSpec authority for the migration's
> whole life and there is no prior record to decide from, so it stays two-phase
> under either mode.

**Same file:1092-1095:**

> Registration is never self-confirmed, in any mode: it persists a binding into
> the canonical project's `package.json`, which is a project-level change rather
> than a mechanical confirmation. It is therefore a stop condition for an
> autonomous loop. An unregistered mapping is detected when `BUILD_BASELINE` is

The full paragraph and `v5-contract.md:216-225` are preserved in
`contracts.txt`. The latter says "It writes only when re-invoked with
`--confirm-execution <id>`." Its opening :3-6 also declares a frozen authority
whose digest binds upgrade confirmations; do not casually rewrite frozen
history when correcting the current contract.

**T1 - verified at frozen M16 BASE
`15090145a43af1e1bcb9fbce692fafac6e06f1e9`:**

| Literal location | Literal text / significance |
|---|---|
| `providers/install-support.mjs:23` | `copilot: { project: ['.github/skills', '.github/prompts', '.vscode/mcp.json', 'servers'] },` |
| `skills/start-migration/scripts/runtime.mjs:220` | `const support = await import(pathToFileURL(path.join(release, 'providers/install-support.mjs')).href);` |
| Same runtime:238-239 | `const launcher = await readFile(path.join(release, 'providers/install-support.mjs'));` then `if (sha256(launcher) !== manifest.files?.['providers/install-support.mjs']) throw new Error('Runtime installer checksum mismatch');` |
| `skills/start-migration/references/provider-compatibility.md:28-30` | "GitHub Copilot CLI reads workspace MCP servers only from `.mcp.json` or `.github/mcp.json`, and only in a trusted folder; the Copilot adapter registers in `.vscode/mcp.json` (VS Code)." |
| Same doc:13-16,58-62 | "All four providers receive a generated skill tree projected from the same canonical documents." / "Everything except `SKILL.md` is copied byte-for-byte." |
| `providers/codex/skills/start-migration/references/provider-compatibility.md:28-30` | Byte-identical shared text above, not a Copilot-only document. |
| `scripts/providers-sync.mjs:360-362,370` | Emits `providers/copilot/mcp.json`, `renderJson({ servers: { [MCP_SERVER_NAME]: { type: "stdio", ...server } } })`, and `.vscode/mcp.json` install location. |
| `scripts/skills-lock.mjs:44-49,111-121` | "`computedHash` *proves* that the release carries the skill semantics actually installed"; hashes relative paths and bytes except release identity. |
| `scripts/release.mjs:70-75,292-293` | `skills` and `providers` are payload roots; changed established contentHash "cannot claim it - bump the version" (exact punctuation in contracts.txt). |

These T1 source files are byte-identical between the frozen M16 BASE and M15
BASE; canonical and Codex-projected provider-compatibility docs are identical.
The identities in observations record that comparison. Registration/receipt
convergence and doc projection necessarily change more than Copilot-only bytes.
Do not treat runtime checksum verification as permission to alter an old receipt.

**Why PATH B requires a new identity and full matrix re-proof:**

> D:12-14: Install the **exact immutable candidate release** of both skills into the
> consumer using the documented installation path. Record package digest,
> runtime identity, CLI versions, model names, OS and sandbox settings.

> D:18-20: Never repair installed skill files, runtime receipts, locks, MCP config or
> state during acceptance. No prompts after the one official invocation; any
> rescue turns invalidate the attempt.

> D:46-49: Run each provider declared production-certified by this release **separately**
> on fresh consumers and on each OS/platform for which compatibility is claimed.
> An adapter packaged for another provider is not thereby certified; label its
> status NOT_TESTED or experimental until a later exact-SHA release qualifies it.

> D:253-254: Immutable release SHA/digest, installed skill/runtime identity, model,
> CLI version, permission mode and isolated consumer fixture revision.

D:259-260 requires an explicit PASS/FAIL/NOT_TESTED for every declared cell.
The historical row-32 reuse justification was *unchanged payload contentHash*;
it does not apply to row 17/E3/T1 payload changes. These citations support the
owner's full re-proof decision; they do not contain a hidden exception allowing
old Codex evidence to certify the joint candidate. At the native-fix harness,
the sign-off citation moves from D:253 to :256; the quoted substance is unchanged.

## 6. Carry-forward and completion scope

See [MATRIX.md](MATRIX.md): all 37 rows plus A1-A7 retain their historical
status and pointer, and each is explicitly marked for joint-candidate re-proof.
The new candidate is not assigned any PASS. "All" includes re-evaluating
conditional applicability and explicitly keeping unclaimed provider/platform
cells NOT_TESTED, not inventing runs for every possible platform.

Visible phase tasks: identities, run inventory, engine/payload defect extraction,
infrastructure defect extraction, contracts/matrix, and evidence publication.
Their final states are recorded in the session task list; the future fix tasks
E1-E4/T1 and I1-I12/T2/T3 above remain **pending**, with engine/protocol work,
scored execution, human-only evidence and host changes **blocked in this phase**
by scope. Historically fixed items are labelled as such, not implemented again.

Skipped: runs, new review/closing, fixes, candidate/version generation, host
changes, authentication/revocation, full vault audit, video copies, and main
merge. The shortest safe approach was to retain the original narratives and
derive a small allowlisted evidence index rather than duplicate raw transcripts.
