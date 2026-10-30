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
entry, whose command, arguments and bytes stay untouched:
`approval_policy="never"`;
`mcp_servers.start-migration.enabled_tools` set to exactly `artifact_status`,
`artifact_run`, `migration_status`, `migration_scan`,
`migration_evidence_binding`, `migration_prefill`, `migration_capture`,
`migration_pending_decisions`, `migration_run`; and
`mcp_servers.start-migration.tools.<tool>.approval_mode="approve"` for each of
those nine (Codex CLI 0.165.0 keys). There is no server-wide
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
  --output /tmp/acceptance-opencode-bootstrap
```

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
