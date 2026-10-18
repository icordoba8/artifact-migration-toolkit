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

Run each supported provider (Claude Code, OpenCode and Codex) **separately**
on fresh consumers and on each OS/platform for which compatibility is claimed.
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
agent-writable workspace. It receives the target root as argv[2]; it must
exit nonzero unless the migrated behavior matches an independently prepared
legacy/reference contract. Pin the exact verifier SHA-256 and keep it out of
agent access. The runner rejects changes to the marker or verifier.

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
(`OS_NAMESPACE` or `NONE`), the read-only paths, and `security.certified`, which
is true only for an isolated run whose installed pin equals `--expected-pin`.
On a host without unprivileged namespaces the runner refuses; `--isolation none`
then yields functional evidence with `certified: false`. The agent still shares
the network and writes the consumer record through the engine, so the engine's
`COMPLETE` remains the agent's own run, and the SHA-pinned verifier remains the
functional verdict.

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

Artifacts written outside the consumer are `agent.stdout.log`,
`agent.stderr.log`, `engine-status.stdout.log`,
`engine-status.stderr.log`, optional `independent-verify.*.log`, and
`report.json`. The latter deliberately sets `nativeUiCertified: false`;
native UI proof is an additional screen recording.

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
