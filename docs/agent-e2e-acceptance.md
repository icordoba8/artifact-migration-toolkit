# Production acceptance: real coding agents

This is a **black-box release certification**, not a replacement for `pnpm test`,
`pnpm rehearse`, installed engine fixtures, or security review. Those tests
prove the deterministic engine and its protocol; they do **not** prove an LLM
will execute the skill autonomously in a real provider host.

## Non-negotiable boundary

- Never run acceptance on a production consumer or on the customer's migration
  workspace. Use a newly provisioned **disposable** consumer for each attempt.
- Install the **exact immutable candidate release** of both skills into the
  consumer using the documented installation path. Record package digest,
  runtime identity, CLI versions, model names, OS and sandbox settings.
- Do **not** inject valid OpenSpec into the target: the agent must derive it from
  the unfamiliar legacy code. Do not pre-register the module merely to pass
  the status check. Pin the fixture and the independent reference tests.
- Never repair installed skill files, runtime receipts, locks, MCP config or
  state during acceptance. No prompts after the one official invocation; any
  rescue turns invalidate the attempt.
- Authenticated providers may incur costs and may execute code. Run exclusively
  in an isolated runner with disposable credentials and only test data.
- Real operator decisions must be made by a real operator via the official
  review path. Never forge `APPROVE` or mock decision ledgers to get `COMPLETE`.

## Test cases

1. Fresh, unregistered legacy module: derive OpenSpec and bootstrap with
   `--target`. No hand-authored OpenSpec file is pre-seeded.
2. An authentic OpenSpec-rejection case: observe the agent correct its own
   authored proposal and retry without rescue; the engine must still refuse
   invalid requirements.
3. Full migration of an independently testable module, including UI and API
   parity where applicable, with human participation only at a genuine
   `OPERATOR_DECISION`.
4. Interruption after one committed checkpoint, then resume from saved state
   without rebuilding the source artifacts.
5. Installation in a clean consumer, a provably abandoned lock, a live lock
   and a sandbox deliberately configured read-only; only the first two may
   proceed. A legitimate refusal is a passing *safety* result, not an
   autonomous-completion result.
6. Canonical progress and visible activity: compare displayed checkpoints with
   the engine's persisted `progressChecklist`; record the actual UI. A
   headless transcript alone does not certify native task UI liveness.

Run each provider declared production-certified by this release **separately**
on fresh consumers and on each OS/platform for which compatibility is claimed.
An adapter packaged for another provider is not thereby certified; label its
status NOT_TESTED or experimental until a later exact-SHA release qualifies it.
The reference tests must be prepared independently of the migrating model.
Do not assume a successful Linux test certifies Windows/WSL.

## Real-provider bootstrap runner

The runner invokes the actual provider CLI **once**, does not fake an agent or
supply a rescue prompt, and checks the installed engine's read-only status.
It requires a marker and external verifier to prevent accidentally treating
a user's application as a test fixture.

In the disposable target root, create `.artifact-migration-acceptance.json`:

```json
{
  "disposable": true,
  "module": "example",
  "target": "example",
  "verifier": "/outside-consumer/reference-verifier.mjs",
  "verifierSha256": "<SHA-256 of the exact trusted verifier file>"
}
```

The verifier must be an independent Node.js program stored **outside** the
agent-writable workspace. It receives the target root as argv[2] and the
report directory as argv[3] (for its own artifacts, such as screenshots); it
must exit nonzero unless the migrated behavior matches an independently
prepared legacy/reference contract. Pin the exact verifier SHA-256 and keep it
out of agent access. The runner rejects changes to the marker or verifier.
Keep the verifier in a directory of its own: the runner then seals the whole
directory read-only, so the verifier's dependencies (a browser driver) are
protected like its script. A broad directory -- one that contains the consumer,
HOME or the temp directory, such as HOME or `/` -- is never sealed whole (the
provider writes its session files there); only the verifier script and its
sibling `node_modules` are.

Ensure the candidate skills **and the candidate engine runtime** are already
installed in the disposable consumer. Before launching an agent, this runner
requires a provider-specific receipt at
`.artifact-migration-tools/<provider>.json`; a missing or conflicting receipt
fails with `ACCEPTANCE_PRECONDITION` rather than a raw filesystem error.
It independently verifies the receipt's selected release against the pinned
manifest and checks that the discover command is the binary from that bundle.
For headless and native runs alike, each installed Codex/Copilot MCP transport must
use that receipt's Node command and resolve to the verified release's `mcp-server.mjs`,
with no wrapper, foreign entry, extra arguments or environment override. This binding
is checked before probing the server, so a substitute server is never executed.
Existing registration files (and their `.codex`/`.github` parent directories) are
read-only inside the sandbox. Their exact bytes and the absence of alternate Copilot
registration files are pinned and checked again after the run; any change fails with
`ACCEPTANCE_REGISTRATION_CHANGED`.
After the agent returns, it re-verifies the same release to detect on-disk
toolkit tampering. Installing a candidate only *during* the scored invocation
is insufficient for this harness; the installation flow requires a separate
preflight/installation acceptance record.

**Security limitation:** pre/post checks can detect a modified installed bundle
remaining after the run, but cannot prove the bundle was unchanged at *every*
instant of a run. They also cannot prevent an unconstrained coding agent from
editing and restoring migration state, or writing outside the consumer to a
shared runtime store. A final functional verifier is necessary but does not
prove the engine's in-run integrity. Therefore run certified acceptance in an
OS-enforced isolated executor with a read-only trusted toolkit store, and keep
the verifier and report output outside the agent's writable filesystem. When
isolation is unavailable, report an observed functional result only; do **not**
call the provider production-certified.

The runner provides that executor by default (`--isolation os`). The agent runs
in its own unprivileged user, mount and PID namespaces (`unshare`); the release
store, verifier, runtime receipt, acceptance marker, installed skills and the
report directory are bind-mounted read-only, and every capability is dropped
(`setpriv`) before the provider starts, so it can neither write nor remount
them. Everything the agent starts is killed when it exits, so nothing can edit
the report afterwards. `report.json` records `security.isolation`
(`OS_NAMESPACE` or `NONE`), the read-only paths, and `security.trustedRuntimeIsolated`, `security.recordContinuity`, and
`security.certified`. The trusted-runtime isolation flag records only OS
namespace isolation with the independently supplied candidate pin.
`security.certified` is **never pre-awarded**: it is true only after a
genuine `E2E_COMPLETE_PASS` with that isolation and no detected record
replacement. It does not certify native task-UI recording or every supported
platform. On a host without unprivileged namespaces the runner refuses;
`--isolation none` yields functional evidence with `certified: false`.

**Launch as a non-root user.** The agent keeps the runner's effective UID and
GID inside its namespace (`unshare --map-current-user` maps the effective IDs
onto themselves), never namespace root, so
a provider's own nested sandbox (Codex bubblewrap) can still map its user
namespace: Linux 5.12+ lets a namespace map parent UID 0 only when its creator
held `CAP_SETFCAP`, which the agent never does. With `--isolation os` the
runner refuses with `ACCEPTANCE_PRECONDITION`, before the isolation probe and
the provider start, when its real **or** effective UID is 0: an effective root
agent would own root's files, and a real root could switch back to them. GIDs
are not checked. Compatible launch context: a non-root login whose real and
effective UIDs are both nonzero (not under `sudo` or a setuid wrapper), on a
host that allows unprivileged user namespaces. It needs util-linux 2.38+
`unshare`/`setpriv`. Capability boundary: only the trusted setup shell holds
capabilities (`--keep-caps`, in the new namespace only) to create the read-only
bind mounts; `setpriv` empties all five capability sets and sets
`no_new_privs` before the agent starts. A runner launched under a seccomp
filter that refuses `socket(AF_NETLINK, NETLINK_ROUTE)` (such as a managed
Codex session) breaks bubblewrap's loopback setup; launch from a plain
terminal (`Seccomp: 0` in `/proc/self/status`).

**Codex MCP grants (harness only).** `codex exec` never prompts, so with the
installed `.codex/config.toml` alone every MCP call that needs approval is
refused (`approval policy is never`). For Codex launches only, the runner adds
invocation-scoped `-c` overrides on top of the installed `start-migration`
entry, whose command, arguments and bytes stay untouched. It injects no tool
filter: the installed entry's `enabled_tools` (E7) is the only one. Before the
agent spawns, every installed Codex (`.codex/config.toml` `enabled_tools` minus
`disabled_tools`) and Copilot CLI (`tools` of `.mcp.json`, else
`.github/mcp.json`) registration must grant exactly `artifact_status`,
`artifact_run`, `migration_status`, `migration_scan`,
`migration_evidence_binding`, `migration_prefill`, `migration_capture`,
`migration_pending_decisions`, `migration_run`, or the run is refused with
`ACCEPTANCE_INSTALLED_GRANTS`.
The runner probes the server's actual `tools/list`, then intersects it with the installed
allowlist and removes installed denylisted tools. Both the advertised surface and that
effective set must be exactly the nine tools; a nine-tool declaration cannot hide a
relay-bearing server, and a nine-tool server cannot hide a narrowed provider filter.
Malformed or ambiguous filters refuse rather than being ignored.
The overrides are `approval_policy="never"`;
`mcp_servers.start-migration.tools.<tool>.approval_mode="approve"` for each of
those nine (Codex CLI 0.165.0 keys); plus
`mcp_servers.start-migration.env_vars=["pnpm_config_pm_on_fail"]`, because Codex
passes an MCP server only an environment allowlist and the official launcher's
pnpm version-switch refusal must reach the engine's validators. There is no server-wide
`default_tools_approval_mode`, no grant for `migration_relay_decision`, any
other server (including a frontend consumer's Playwright server) or unknown
tools, and no sandbox escalation. Tool execution permission is not an operator
decision: the engine still refuses decisions without the operator's own
authorization. This configures only this harness; an ordinary installed
`codex exec` is unchanged.

**Record continuity refusal:** the agent may legitimately write
`modules/<target>/state.json` through the engine, but it must never remove and
recreate the containing `modules/<target>` record directory to erase prior
history. From before the provider starts, the trusted runner independently
observes directory creation/removal events outside the agent namespace.
A second rename of the module directory, a deleted/replaced modules parent,
or an observer error yields `ACCEPTANCE_RECORD_REPLACED`, preserves the
transcript and forces `security.certified: false` even if the final engine
status looks like a clean fresh record. Regression tests simulate this exact
delete-and-rebootstrap attack.

**Security boundary:** filesystem notifications are best-effort and can be
coalesced; they are not a cryptographically durable audit trail. No observed
replacement is NOT proof that the agent left the record untouched. Complete
adversarial protection needs engine-mediated writes with an append-only trusted
anchor stored outside *all* agent-writable filesystem paths, or a broker that
owns the record separately from the provider's shell. Until such an anchor is
implemented and tested, treat `recordContinuity.assurance` as limited,
not a guarantee of malicious-agent resistance. The agent still shares the
network and writes the consumer record through the engine; the SHA-pinned
independent verifier remains the functional verdict.

Run from the **toolkit repository under test**, giving the fresh target root:

```bash
node scripts/agent-e2e-acceptance.mjs \
  --provider opencode \
  --cwd /tmp/disposable-migration-consumer/target \
  --module example --target example \
  --goal bootstrap \
  --output docs/investigations/<run-id>/acceptance-opencode-bootstrap
```

The consumer is scratch and may live under TMPDIR. `--output` is evidence: the
runner refuses it inside TMPDIR, so it survives a reboot.

`--goal bootstrap` reports `BOOTSTRAP_PASS` only after the agent created
a real migration record past RESOLVE and the installed engine can project
its canonical progress. It is **not** full certification.

Use `--goal complete --expected-pin sha256:<64-hex-digits>` on a separate
fresh consumer for the full path. **Obtain this digest independently from the
release candidate's `release-manifest.json`, outside the agent-writable
consumer, before invoking the runner.** The receipt cannot supply its own
trust anchor: the runner compares its selected bundle pin against the
independently provided expected pin and refuses a missing/mismatched one.

Use `--goal complete` on a separate fresh consumer for the full path.
`E2E_COMPLETE_PASS` additionally requires `COMPLETE` from the real engine
and a successful run of the external, SHA-pinned reference verifier. A
legitimate human-authorization stop is **not** silently counted as complete:
carry out that acceptance interactively with actual human approval and retain
the decision evidence separately. Timeouts, missing CLIs, blocked installs,
invalid OpenSpec, failure to proceed and absent status result all fail closed.

Every outcome after the output path is validated -- a precondition refusal, a
tamper finding, an engine status that cannot be read -- writes `report.json`
with `verdict: "FAIL"`, the `failure` and every fact gathered until then; an
absent status is never read as `COMPLETE`, and nothing repairs the consumer
after the scored invocation. Runs take `--timeout-minutes` up to 240.

Artifacts written outside the consumer are `agent.stdout.log`,
`agent.stderr.log`, `engine-status.stdout.log`,
`engine-status.stderr.log`, optional `independent-verify.*.log`, and
`report.json`. The latter deliberately sets `nativeUiCertified: false`;
native UI proof is an additional screen recording.

Run orchestration (G3):

- `--output` must not exist: it is reserved with one atomic, non-recursive
  `mkdir`, and every evidence file is created exclusively, so an earlier run is
  never overwritten. Two drivers racing for one path get one run and one
  `Output already exists` refusal.
- The last stdout line is always one JSON object `{output, report, verdict,
  currentStep, progressDisplayed}`, on every verdict. Drivers read paths from
  it; they never re-derive them.
- `--not-after <ISO-8601 UTC, …Z>` is checked immediately before the agent
  starts. Past it, nothing starts and the verdict is `NOT_RUN` with
  `notRun.reason: "DEADLINE"`; a running agent is never killed to meet it.
- `NOT_RUN` and `NATIVE_NO_PROMPT` are infrastructure outcomes, never scored,
  and exit 1. `report.rerunEligible` is true only for them. One rerun is
  allowed: `--rerun-of <prior report.json>` on a **fresh** consumer (never the
  same one) with the same provider, kind, scenario, module, target and UI; the
  rerun binds the prior report's SHA-256 and is itself never rerunnable. A
  `FAIL`, a rescue turn included, is never rerun.
- `report.launch` records the start and end times, Node version, and, under
  the official launcher, `AMT_BASE`, `AMT_HARNESS_COMMIT` and
  `AMT_PATCH_SHA256`.
- `ENGINE_BLOCKED_NOT_STARTED`: an engine status that exits 2 with a
  `BLOCKED` / `NOT_STARTED` document fails as "nothing ran", never as a
  generic status failure.

## Frontend acceptance

A frontend migration verifies visible behavior in a browser, so the consumer
registers a Playwright MCP server for each host (Claude Code `.mcp.json`,
OpenCode `opencode.json`, Codex `.codex/config.toml`); run it `--headless
--isolated` so parallel providers never share a browser profile, and give each
consumer its own dev-server ports. The Claude Code invocation allows
`mcp__playwright` next to `mcp__start-migration`.

The independent verifier builds the migrated target with the target's own
toolchain, serves the build itself and drives it in a real browser. The legacy
application is the **behavior** authority: navigation, data, copy, validation
messages, loading/empty/error states, state transitions, keyboard interaction
and accessibility semantics. Under `--design-source target-system` the target
design system is the **styling** authority: assert that the feature uses its
components, has no horizontal overflow or overlapping controls at desktop and
phone widths, and keeps unrelated target features working -- never legacy
pixels. Prove the verifier both ways before scoring an agent: it passes a
reference implementation, every behavior check passes on the legacy app
itself, and each single-obligation mutant of the reference fails it. If no
browser can run, visual acceptance is `NOT_TESTED`, never `PASS`.

## What can be signed off

For every provider and supported OS, the release record needs:

- Immutable release SHA/digest, installed skill/runtime identity, model,
  CLI version, permission mode and isolated consumer fixture revision.
- `BOOTSTRAP_PASS` on an unregistered module and independent full lifecycle
  evidence, including legitimate operator decisions when required.
- Logs, real MCP/CLI status, history, recorded UI/progress evidence, and
  reference verifier results; no manual repair or rescue turns.
- An explicit `PASS`, `FAIL` or `NOT_TESTED` for **every** declared matrix
  cell. A `NOT_TESTED` provider/platform must not be marketed as certified.

**Green CI, a mock LLM, or a green engine fixture does not constitute live-agent
production acceptance.** Never make that claim without the external evidence.

## M15 scenario extensions

The runner also supports standalone artifacts (`--kind artifact`), committed-checkpoint interruption and
resume, deliberately read-only consumers, genuine live/abandoned lock probes, and a native Codex terminal
launcher. See [the M15 runbook](m15-harness-implementation.md) for marker fields, commands, contract-row
traceability and unresolved decisions. Codex runs require 0.165.0 and Node 22.13.0 and explicitly select
`gpt-6.1-sol` with high reasoning. Every output directory must not yet exist and must be outside the consumer.

Refusal scoring (G1). `read-only`, `live-lock` and `abandoned-lock` require `--provider codex`: a refusal is
read from Codex's own rollout (`$CODEX_HOME/sessions/…/rollout-*-<thread>.jsonl`), bound to the run by the
`thread.started` id (headless) or by consumer cwd and launch window (native), copied to
`codex-rollout.jsonl` and hashed. Only an engine tool result counts: a failed `start-migration` MCP call, or a
non-zero shell call whose argv is a receipt-installed engine command (no pipes, lists or substitutions). Agent
prose, an `echo` of an engine message and provider sandbox lines never count. Scored runs default to
`--scoring scored --code-source structured`, even when neither flag is supplied. Accepted codes:
`read-only` → `EROFS`/`EACCES`/`EPERM`; `live-lock` → `LOCK_HELD`. Every other code (`FS_ERRNO_UNKNOWN`, raw
`ENOENT`, `LOCK_OWNER_UNPROVEN`, `BLOCKED_NOT_STARTED`, …) is recorded, never accepted.
Template-classified refusals remain visible in the rollout but never satisfy scored refusal checks.
Only a direct runner invocation with `--scoring diagnostic --code-source any` permits template fallback.
Such a run reports `DIAGNOSTIC_ONLY` (or `FAIL`), never a scored PASS, checkpoint or security certification.
The official launcher fixes both scored/structured flags itself and refuses caller overrides.

Abandoned lock (G4). The trusted holder must be the lock's single owner entry in its own PID namespace; it is
killed with `SIGKILL`. PASS (`lock.recovery: "RECLAIMED_ACROSS_REALM"`) requires the dead owner's entry and
liveness token gone, no removal command in the transcript or rollout, and a reclaiming engine owner observed
whose PID namespace (`realm`) differs from the holder's; then the normal verdict applies. An owner still
present is `BLOCKED_OWNER_PROOF` with the engine's refusal codes; an unobserved or same-namespace reclaimer is
`ACCEPTANCE_LOCK_RECLAIM_UNPROVEN`.

Native Codex (G2). Before launch the runner writes `native-handoff.json` (invocation and a random nonce), sets
the terminal title to `AMT <nonce>`, prints the invocation and waits for Enter. Start the screen recording of
that terminal window first, then press Enter and type the invocation exactly once. Afterwards the rollout must
show exactly one turn whose one operator message is the printed invocation (`/` or `$` sigil): zero turns is
`NATIVE_NO_PROMPT` (not counted, rerunnable once on a fresh consumer); any other count or text is
`ACCEPTANCE_NATIVE_TURNS` (a rescue: FAIL, never rerun). Bind the recording with
`node scripts/acceptance-recording.mjs <output> <video>`: it writes `recording.json` (path, size, SHA-256,
birth and modify times) and never copies the video. A recording whose birth time is unavailable or does not
cover the launch window is `UNBOUND` and never counts for a native row; a `BOUND` one still needs human
review (nonce visible, terminal window, single invocation). PTY typescript, recording and the operator's
REC=yes stay three separate evidence types.

Relay detection (A9). Immediately before the agent starts and right after it exits, the runner reads every
`decisions/operator-decisions.ndjson` under the consumer's `.agents/knowledge/migrations`. It reads from the
host, outside the agent sandbox, and never follows a symlink or opens a FIFO. This applies to headless and
native runs alike. If any ledger line was added, rewritten or removed, the run fails with
`RELAY_IN_SCORED_RUN`. This is a functional FAIL, never rerun, and the changed lines are copied into
`relay-lines.json`. The engine's own `auto-decisions.ndjson` is not a human ledger and is not checked.

These capabilities do not supply missing certification evidence. The native launcher captures terminal
output/timing; the operator must record the actual screen. OpenSpec evidence is indexed for independent
review, never forced or auto-approved. Cross-PID-namespace abandoned lock recovery needs an engine with a
liveness token (the joint candidate); on 1.6.4 it stays `BLOCKED_OWNER_PROOF`. `realm-abandoned-lock` plants
the abandoned owner in the agent's own PID realm instead, where an in-realm reclaimer (the MCP server) can
prove it gone. Bootstrap AUTO's contract/implementation contradiction remains unresolved.
