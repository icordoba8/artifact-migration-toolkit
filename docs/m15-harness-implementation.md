# M15 harness implementation and operator runbook

Implementation scope: harness, local tests, review. **Certification: NOT_READY.**
BASE: `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d`.
The reviewed starting patch was preserved; no applicable AGENTS.md was present in the candidate or its ancestors.
No engine, provider, installed skill, requirement, release payload or historical evidence is changed.
Attempt 3's accepted discounts functional PASS (37/37) stands. Do not repeat it to erase F1.

## Contract trace

Sources: [certification contract](agent-e2e-acceptance.md), rev 1
`/home/utmwac/artifact-migration-toolkit/docs/investigations/m15-certification-plan-20261030T2045Z/{PLAN,MATRIX}.md`,
and controlling rev 2 `../m15-certification-plan-addendum-20261030T2345Z/ADDENDUM.md` in that investigations directory.
All matrix statuses remain historical; local tests are not new scored evidence.

| Contract / matrix | Implemented capability | Acceptance still needed |
| --- | --- | --- |
| Cases 1, 3; rows 11–13, 28–29 | `--kind artifact`, pinned source/target marker, installed `artifact-migrate --status --json`, real artifact record identity, independent external verifier, canonical progress saved | Artifact bootstrap/full run, M13 reference verification, MCP/progress review |
| Case 4; rows 15, 23 | `--scenario interrupt` stops after the first observed unlocked committed STEP_COMPLETED/ADVANCED; `resume` accepts only that report and consumer | Separate interruption/resumption stages; full completion and verifier PASS after resume |
| Case 5; rows 18, 26 | `--scenario read-only` seals the whole consumer, re-enters the mounted cwd, records byte/mode/link/directory snapshots and refusal | Official refusal transcript and independent safety review |
| Case 5; rows 16–17, 24–25 | Real installed-engine lock holder; live owner remains alive through observation; abandoned owner is killed and reaped before launch; captures owner and before/after lock bytes | Live safety review; abandoned foreign-realm recovery remains blocked by protocol |
| Case 2; row 14 | Unmodified invocation; raw tool results retained; structured OpenSpec-related result line numbers/hashes indexed for review | Authentic engine rejection, agent-authored correction, successful retry without rescue. `openspec.status` stays NOT_TESTED; index matches alone never pass it |
| Case 6; rows 22, 30 | `--ui native` uses the same namespace/mount/grant configuration with interactive Codex; trusted `script` records PTY output and timing | Operator screen recording, one-invocation attestation, visible-progress comparison. PTY output is not a screen recording; nativeUiCertified remains false |
| Sign-off A1–A7 | Versions/model pinned; evidence cannot overwrite prior output; failures cannot retain certified=true | CI at an authorized committed harness SHA, owner rulings, final independent acceptance |

Each stage invokes the provider once. Resume starts a new session from the engine record, not conversation memory.
The interruption report pins state/integrity bytes, full history prefix, all existing engine artifact pin values,
raw completed artifact bytes, source bytes, and the trusted marker/receipt/verifier paths and SHA-256 digests.
Before resume all original identities must match exactly; older reports without them are refused. After resume the
history prefix and completed pins/bytes must remain and the revision must increase. Installed read-only
status validates the record both before resume and after execution. The existing pending-transaction helper
rejects journals before status or provider startup; resume neither recovers them nor launches on pending work.
Locks are never repaired.
Source-root is required for interruption/resume; module legacy roots must be separate from the target.
Artifacts pin one primary source (file or directory); multi-source/type variants are outside this M13 fixture scope.
The artifact legacy binding must differ from its migrated target.

`SAFETY_REFUSAL_PASS` is a narrow observation: unchanged consumer, refusal text, no record,
no timeout/signal/overflow, and (for a live lock) unchanged owner bytes with the holder still alive.
It is not completion or production certification; independent transcript review remains required.
`INTERRUPTED_CHECKPOINT` also never certifies completion. Native runs never automatically award security certification.
Existing functional `E2E_COMPLETE_PASS` semantics remain, including an external verifier and an independently supplied release pin.

## Known blockers and unresolved rulings

- **Engine protocol blocker:** a host lock owner has a different PID realm from every isolated agent.
  A dead host PID therefore cannot be proven gone by that agent. `abandoned-lock` retains the lock and
  reports `ACCEPTANCE_LOCK_OWNER_PROOF`, never deleting/relabeling it or claiming recovery. Because no
  engine path can reclaim that owner, a lock that vanishes anyway fails as `ACCEPTANCE_LOCK_REMOVED`
  (agent removed it outside the protocol). Local tests prove same-realm recovery, cross-realm refusal and
  the manual-removal failure control separately. Codex 0.165.0 also gives every sandboxed shell command
  its own PID namespace (probe: agent `pid:[4026535538]`, `codex sandbox` shell `pid:[4026535932]`), so
  even an owner planted in the agent's realm could only be reclaimed through the MCP server process, and
  a lock abandoned by one sandboxed engine CLI call is unreclaimable by the next. Changing this requires an engine/broker
  protocol design and a new candidate, or an explicitly reviewed alternative acceptance topology.
- **Interruption race:** polling observes a committed, unlocked checkpoint but cannot atomically stop
  the provider before its next engine call. A changed state, remaining lock or journal fails closed and is
  preserved. Reliable interception at every checkpoint would require engine coordination. Do not remove
  locks, edit state, or rerun on a damaged consumer to turn this into a pass.
- **D2 / A6 remains unresolved:** bootstrap AUTO and registration self-confirm in code while the contract
  says two-phase. No contract correction or human ruling is made here.
- D1/A4: signed account-class/operator/reuse attestation for Attempt 3 and provider-side revocation are pending.
  `/tmp` credentials disappeared at reboot. Authentication and any session/profile reuse require existing
  owner authorization; a new scenario or resume stage does not itself impose a device-login requirement.
  The older addendum's per-scenario operational login statement is not a contractual rule; historical evidence is unchanged.
- D3: owner/GPT disposition of F1's two autonomously recovered errors; preserve Attempt 3.
- D4: real operator-decision coverage remains unresolved. No decision ledger or approval is fabricated;
  no `migration_relay_decision` grant is added. A genuine stop needs the authorized operator review path.
- D5: owner/GPT must accept the native recording method. D7: scored runs and commits/push/CI need separate
  authorization. D8: authentic OpenSpec rejection may not occur; do not seed malformed requirements or
  force a rejection. A run with no such event leaves row 14 NOT_TESTED.
- The evidence vault remains one copy; owner should make the second offline/encrypted copy from rev 2.
- Filesystem event continuity remains best effort, not an append-only trusted audit anchor.

## Exact remaining commands (not executed in this session)

Use a plain non-root terminal with `Seccomp: 0`. Approvals above must precede their dependent actions.
The launcher requires externally approved `AMT_HARNESS_COMMIT` and `AMT_PATCH_SHA256`, a clean
worktree (including no untracked files), and historical BASE ancestry. It refuses changed binary hashes,
other Node/Codex versions, or different reviewed content. It passes `gpt-6.1-sol`, high reasoning, workspace-write, approval_policy=never and the
same exact nine MCP grants. It uses a separate disposable HOME and CODEX_HOME with an empty environment.
Do not reuse the old official-run.sh, which requires a clean historical worktree.

Four identities are separate:

- **Historical BASE:** `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d`, the comparison ancestor, never the final harness SHA.
- **Reviewed content:** SHA-256 of `bash scripts/m15-patch.sh`, the complete binary BASE-to-worktree patch,
  including new files. A temporary index/object store leaves the real index untouched; staging order and
  committing the same bytes do not change this digest. The old HEAD-diff-only digest is historical.
- **Release:** independent `--expected-pin` release-manifest digest (`PIN` below); the payload is unchanged.
- **Final harness commit:** a full 40-character SHA approved externally after an independently authorized
  local commit. It must be supplied explicitly; never fill it from the launch checkout's HEAD.

Before any candidate commit, export the complete patch outside the checkout and compare its digest with
this review's externally recorded digest. Do not put that digest or the future commit SHA into files that
it hashes. No candidate commit is authorized or executed by this implementation session.

```bash
bash scripts/m15-patch.sh > /tmp/m15-reviewed-complete.patch
sha256sum /tmp/m15-reviewed-complete.patch
# Compare with the final review report. The dirty, uncommitted candidate cannot launch officially.
```

After a separately authorized commit, record its full SHA outside the repository through the approval
process. Use the reviewed digest and that approved commit in the exports below. Recompute the patch
and compare the same reviewed digest, require a clean tree, and let the launcher enforce both pins.
Any content change requires review again; do not derive-and-approve new pins from the execution checkout.

```bash
cd /home/utmwac/amt-m15-uidmap
R=/home/utmwac/.codex/packages/standalone/releases/0.165.0-x86_64-unknown-linux-musl
N=/home/utmwac/.nvm/versions/node/v22.13.0/bin
export PATH="$R/bin:$N:/usr/local/bin:/usr/bin:/bin"
# One-time pnpm provisioning: the launcher verifies scripts/m15-pnpm.sh's pinned sha512 and never fetches.
test -f ~/.cache/amt-pnpm/pnpm-11.21.0.tgz || { mkdir -p ~/.cache/amt-pnpm &&
  curl -fsS --proto =https -o ~/.cache/amt-pnpm/pnpm-11.21.0.tgz https://registry.npmjs.org/pnpm/-/pnpm-11.21.0.tgz; }
PIN=sha256:bbf8b295722287014407d2c6bf7bd5293105f3f65ea0575f92d135ab1fabbbf6
VT=/home/utmwac/amt-evidence-vault/m15-20261030T2045Z/restricted/tmp
V="$VT/amt-m15-run3-20261030T1910Z"
ACC=/home/utmwac/artifact-migration-toolkit/docs/investigations/m15-codex-acceptance-20261030T1715Z
# Copy both pins from the external review/commit approval records.
export AMT_PATCH_SHA256='<reviewed complete BASE-to-harness patch SHA-256>'
export AMT_HARNESS_COMMIT='<externally approved full final harness commit SHA>'
# The prepare script's historical bundle path was lost on reboot: restore exact bytes first.
test -e /tmp/amt-m15-codex-recovery-20261030T125104Z || cp -a "$VT/amt-m15-codex-recovery-20261030T125104Z" /tmp/
BUNDLE=/tmp/amt-m15-codex-recovery-20261030T125104Z/store/artifact-migration-tools-1.6.5
```

Provision a fresh consumer base for each new scenario; resume retains the interrupted consumer and store.
Use only an owner-authorized disposable profile. A valid session may be reused only within that authorization;
authenticate interactively only when necessary and authorized. A replacement profile for resume does not
move the installed store. The scored-fixture preparation below awaits its own authorization. Local regression
tests use disposable Git commits only; no candidate commit or authentication command was run here.

```bash
SCN=artifact-complete # change per row below; never reuse a previous base
TS=$(date -u +%Y%m%dT%H%M%SZ)
B="/tmp/amt-m15-$SCN-$TS"
export AMT_PROFILE='<owner-authorized disposable profile path>'
E="/home/utmwac/artifact-migration-toolkit/docs/investigations/m15-official-$SCN-$TS"
STORE="$AMT_PROFILE/home/.local/share/artifact-migration-tools"
mkdir -p -m 700 "$B" "$E" "$AMT_PROFILE/home" "$AMT_PROFILE/codex"
cp -a "$V/harness" "$V/verifiers" "$B/"
test -f "$AMT_PROFILE/codex/config.toml" || cp "$ACC/profile-config.toml" "$AMT_PROFILE/codex/config.toml"
# Only if needed and owner-authorized: operator authenticates the approved disposable account.
env -i PATH="$PATH" HOME="$AMT_PROFILE/home" CODEX_HOME="$AMT_PROFILE/codex" "$R/bin/codex" --no-daemon login --device-auth
env -i PATH="$PATH" HOME="$AMT_PROFILE/home" CODEX_HOME="$AMT_PROFILE/codex" "$R/bin/codex" --no-daemon login status
# Require login-status exit 0; login itself can exit 0 after timeout.
```

For module scenarios, reuse the preserved builder; add the legacy-root marker before the scored invocation:

```bash
node "$ACC/attempt3/prepare-fresh2.mjs" "$B" "$E" "$STORE"
T="$B/module-official/target"
node --input-type=module - "$T" "$B/module-official/legacy" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
const file = process.argv[2] + '/.artifact-migration-acceptance.json';
const marker = JSON.parse(await readFile(file));
marker.sourceRoot = process.argv[3];
await writeFile(file, JSON.stringify(marker, null, 2) + '\n');
JS
COMMON=(--provider codex --cwd "$T" --module discounts --target discounts --source-root "$B/module-official/legacy" --expected-pin "$PIN" --isolation os)
```

For artifact scenarios, use the original pinned M13 fixture and verifier, without a pre-existing artifact record:

```bash
PRE=/home/utmwac/artifact-migration-toolkit/docs/investigations/m15-codex-certification-20261028
T="$B/artifact/consumer"
mkdir -p "$T"
cp -a "$PRE/fixtures/artifact/." "$T/"
node "$BUNDLE/providers/codex/install.mjs" install --scope project --root "$T" --store "$STORE" --bundle "$BUNDLE" --pin "$PIN"
node --input-type=module - "$T" "$B/verifiers/m13/verify.mjs" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const [root, verifier] = process.argv.slice(2);
await writeFile(root + '/.artifact-migration-acceptance.json', JSON.stringify({ disposable: true,
  module: 'strings', target: 'strings', kind: 'artifact', source: 'legacy/strings.cjs', sourceRoot: root,
  artifactTarget: 'src/utils/strings.js', verifier,
  verifierSha256: createHash('sha256').update(await readFile(verifier)).digest('hex') }, null, 2) + '\n');
JS
git -C "$T" init -q
git -C "$T" add -A
git -C "$T" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'Exact M13 disposable acceptance fixture'
COMMON=(--provider codex --cwd "$T" --module strings --target strings --kind artifact --source legacy/strings.cjs --source-root "$T" --artifact-target src/utils/strings.js --expected-pin "$PIN" --isolation os)
# Before scoring, independently verify the exact verifier against its reference and all obligation mutants.
# Existing proof artifacts are PRE/evidence/m13-*; do not claim a new proof from the command below alone.
node "$B/verifiers/m13/verify.mjs" "$B/verifiers/m13-reference" "$E/reference"
```

Run **one applicable command** on each newly provisioned consumer. Never run this list sequentially on one target:

```bash
# Artifact complete (rows 11–13, 28–29); do not repeat accepted module Attempt 3.
bash scripts/m15-official-run.sh "${COMMON[@]}" --goal complete --scenario fresh --output "$E/complete"
# Module or artifact live lock: expected SAFETY_REFUSAL_PASS, independently review owner and target snapshots.
bash scripts/m15-official-run.sh "${COMMON[@]}" --goal bootstrap --scenario live-lock --output "$E/live-lock"
# Module or artifact abandoned lock: currently expected BLOCKED_OWNER_PROOF, NOT recovery PASS.
# Do not spend a scored run on this until the blocker has a reviewed disposition.
bash scripts/m15-official-run.sh "${COMMON[@]}" --goal bootstrap --scenario abandoned-lock --output "$E/abandoned-lock"
# Module or artifact read-only: expected SAFETY_REFUSAL_PASS, never COMPLETE.
bash scripts/m15-official-run.sh "${COMMON[@]}" --goal bootstrap --scenario read-only --output "$E/read-only"
# Module or artifact interruption; require INTERRUPTED_CHECKPOINT and preserved evidence.
bash scripts/m15-official-run.sh "${COMMON[@]}" --goal complete --scenario interrupt --output "$E/interrupt"
# Only after that exact report passes: same consumer, receipt, verifier, marker and original store.
# Keep the authorized profile, or select another only within existing owner authorization.
bash scripts/m15-official-run.sh "${COMMON[@]}" --goal complete --scenario resume --resume-from "$E/interrupt/report.json" --output "$E/resume"
# Module or artifact native UI, operator present. Start a real screen recording before launch.
bash scripts/m15-official-run.sh "${COMMON[@]}" --goal complete --ui native --output "$E/native"
```

Resume keeps the installed receipt's original immutable store intact and readable. The harness passes
`ARTIFACT_MIGRATION_TOOLS_STORE=installed.store` to the provider and its descendants, using the supported
runtime selection mechanism even with a different HOME/CODEX_HOME. It does not rewrite the receipt.
An authorized valid session may be reused; a new login is conditional on need and existing owner authorization.
Runtime bootstrap reuses the original receipt offline. Missing original identities, a consistently replaced
verifier/marker pair, a changed receipt, or either pending-journal filename refuses before provider startup.

Native operator actions: type the printed skill invocation once, make no rescue turns, exit when the agent
stops, retain the original screen recording and its SHA-256, compare visible checkpoints/activity with
`engine-status.stdout.log`, `report.engine.progressChecklist`, and history. A genuine decision stop needs
an explicit owner-authorized review; do not improvise a grant. `native.typescript`/`native.timing` supplement
that recording. GPT/owner reviews OpenSpec tool-result leads and the authored proposal/correction sequence;
a model's claim of rejection is insufficient. Authenticate nowhere else and revoke the sessions at the provider.

CI and final independent acceptance remain separate. No push command is supplied for the historical BASE:
the final reviewed harness must first receive an authorized commit, then exact-SHA CI and independent review.
