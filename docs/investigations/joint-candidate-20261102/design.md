# Joint candidate 20261102: Stage 1 design (E1–E4, T1)

| | |
| --- | --- |
| BASE | `toolkit/main` = `15090145a43af1e1bcb9fbce692fafac6e06f1e9` (v1.6.4) |
| Branch / worktree | `engine/joint-candidate-20261102` / `/home/utmwac/amt-joint-candidate` |
| Phase 0 | `cert/m15-codex-uidmap-20261030` @ `a0cfb35472f02c784676f81b62587c3753ef89b9` (`phase0/REPORT.md`, `contracts.txt`) |
| Owner rulings | PATH B (one joint candidate); GO + A (implementation governs Bootstrap AUTO, so the text is fixed); G1 harness workaround rejected; row 17 literal text governs |
| Executor | Copilot CLI · Claude Opus 5.5, no fallback triggered. Ponytail ultra (Stage 1) |
| Spikes | [`spikes.md`](spikes.md) |

Phase 0 engine line numbers apply to BASE unchanged. Between M15 BASE `d7eb28c`
and BASE, engine, skill and provider bytes differ only in version identity.

Shared identity note: every fix below changes the bytes of at least one payload
root (`skills`, `packages/migration-engine/src`, `providers`).

- The skill `computedHash` changes for all four providers (`skills-lock.json`).
- The release `contentHash` changes.
- `scripts/release.mjs:292-293` refuses to build a changed payload as 1.6.4.

Stage 2 therefore regenerates `skills-lock.json` and the projections but cuts no candidate. The version bump, the pin and the release are owner-gated (see *Identity*).

---

## E1: no first-setup registry result

**Rows:** 9, 15, 16, 18, 20, A5.

**Root cause.**

- When nothing binds the registry (no state, no `--registry`, no `package.json#config.startMigration.registry`, no `MIGRATION_REGISTRY_PATH`), `resolveRegistryPath` (`store/registry.mjs:348-351`) throws an untyped `Error`.
- Every front end calls it *before* its fresh-module path:
  - MCP `registryFor` (`transport/mcp.mjs:227-233`): status, scan, evidence_binding, prefill, capture, pending_decisions.
  - `runDiscoverCli` (`transport/discover.mjs:217-223`), which `migration_run` and `artifact-migration-run` use.
  - The status CLI.
- So `notStarted()` (`lifecycle/status.mjs:38-55`) and the BLOCKED result that names the bootstrap call, as SKILL.md:323-325 promises, are unreachable on a first setup.
- MCP turns the throw into JSON-RPC `-32603` (`mcp.mjs:604-607`), which R5's agent could not act on.

**Fix boundary.** One typed result at the shared resolver. Each front end gets one branch that maps it.

1. `resolveRegistryPath` throws the same message with `code: "REGISTRY_UNBOUND"`, carrying `moduleName`, `projectRoot` and the documented first-setup path `<target-root>/.agents/knowledge/migrations/registry.json` (SKILL.md:456-457). The path is named only when that file exists; otherwise it appears as a `<registry.json>` placeholder. Nothing is created and nothing is guessed. Mismatch and "`--registry` only on first setup" stay fail-closed exactly as today.
2. The MCP `callTool` catch (`mcp.mjs:604-607`, `:685-687`) handles `REGISTRY_UNBOUND`.
   - Instead of `-32603`, it returns a normal tool result: `outcome: "BLOCKED"`, `status: "NOT_STARTED"`, `reason`, `nextAction`.
   - `nextCommand` is the first-setup `artifact-migration-discover <module> --registry …`.
   - `mcpNext` is `migration_run` with `registry`, because MCP tools already accept `registry`, `mcp.mjs:87`.
3. CLI:
   - `run.mjs:580-584` and the status/discover entry (`transport/entry.mjs:15-18`) map the same code to `BLOCKED`, exit 2, with the same directive.
   - Downgrading to BLOCKED is sound only for this code: the registry is resolved before any lock or write, so "nothing was executed" holds. Every other throw stays `FAILED`.
4. Skill guidance:
   - SKILL.md *Invocation* :323-325 and *Registry resolution* :452-457 state that an unbound registry returns `BLOCKED` / `NOT_STARTED` with the first-setup call, in both front ends.
   - They state that a read-only sandbox's refusal of that call is a safety stop, not something to work around.

**Files.**

- `packages/migration-engine/src/store/registry.mjs`
- `packages/migration-engine/src/transport/{mcp,run,entry}.mjs` (`discover.mjs` only if its status read needs the same branch)
- `skills/start-migration/SKILL.md` and its 4 generated projections
- Tests listed below

**Codex impact.** A fresh module over MCP or CLI gets an actionable BLOCKED with the first-setup call instead of `-32603` or a bare throw. Writes are unchanged.

**Copilot impact.** Identical, because the engine is provider-agnostic. Copilot also reaches it once T1 connects the server.

**Identity.** `skill computedHash` changes (SKILL.md, all providers); payload `contentHash` changes.

**Focused tests.**

- `registry-resolution.test.mjs` covers each of the 4 sources absent, and:
  - typed code and payload;
  - conventional file present means a concrete path, absent means a placeholder;
  - mismatch and `--registry`-after-setup still throw untyped.
- `mcp-server.test.mjs`:
  - `migration_status`, `migration_run` and `migration_scan` on an unbound root return BLOCKED/NOT_STARTED, never `-32603`;
  - a non-registry throw still returns `-32603`;
  - no file is written (tree snapshot before and after).
- `transport.test.mjs`: CLI `artifact-migration-run` and the status CLI exit 2 with the same directive (parity with MCP).
- `unregistered-module-bootstrap.test.mjs`: following the named first-setup call bootstraps.

---

## E2: lock ownership is proven only inside one PID realm

**Rows:** 17, 25; recovery risk 15, 23.

**Row 17 literal text** (`docs/agent-e2e-acceptance.md:38-41`): "Installation in a clean consumer, a provably abandoned lock, a live lock and a sandbox deliberately configured read-only; only the first two may proceed."

**Root cause.**

- A lock owner is "provably gone" only if `inThisRealm(owner) && kill(pid,0) === ESRCH` (`lifecycle/lock.mjs:139-145`, realm `:76-87`).
- Every Codex shell call runs in a fresh PID namespace (bwrap `--unshare-pid`), and so does the MCP server. An abandoned lock from any earlier call is therefore *never* provable, and it stays held until a human removes it. Row 17 calls for a "provably abandoned lock" that proceeds.
- The installer lock repeats the identical rule (`providers/install-support.mjs:533-555` `lockOwnerAlive`, `:567-582` `reclaim`), so row 17's "installation" leg fails the same way.
- Spike S-E2a also shows the kernel recycles PID-namespace inodes, so the recorded `realm` is weak evidence even within its own rule.

**Fix: a kernel-held, namespace-independent liveness token.**

Each lock owner holds the read end of a FIFO that lives in its own lock directory:

- The kernel closes that read end the instant the owner dies, in every namespace.
- A write-only, non-blocking open of a FIFO with no reader fails with `ENXIO` (POSIX). That failure is the proof that the owner is gone.
- Spikes S-E2a and S-E2b confirm this under `unshare` and under the real Codex sandbox (CapEff 0, NoNewPrivs 1, seccomp and Landlock active).
- The kernel offers no other primitive that is reachable from Node, works across namespaces and is permitted by seccomp: unix sockets are denied by seccomp, Node has no `flock`, and `/proc` start-time is per-namespace.

Protocol (writer lock protocol stays `2`; the on-disk change is additive):

1. **Acquire.**
   - Staging holds `<uuid>.json` plus `<uuid>.fifo`, created with `mkfifo -m 600` as an argv spawn with no shell (Node has no `mkfifo`).
   - The owner opens the FIFO `O_RDONLY|O_NONBLOCK`. Node sets `O_CLOEXEC`, so children never inherit it.
   - It records `fifo: {dev, ino}` from `fstat` in the owner JSON, then publishes with the existing single `rename`.
   - The handle is strongly referenced until release.
2. **Probe** (`provablyGone`). With owner `hostname` equal to this host, a non-Windows prober:
   - `lstat(<uuid>.fifo)` must be a FIFO whose `dev`/`ino` equal the recorded ones.
   - Open it `O_WRONLY|O_NONBLOCK|O_NOFOLLOW`. `ENXIO` means gone. Success means alive (close at once). Any other answer is unproven.
   - The `dev`/`ino` match pins the probe to the same kernel object. On NFS, 9p or drvfs, or from another host, the numbers differ, so the probe fails closed rather than misreading a client-local pipe as "no reader".
   - The existing same-realm `kill(pid,0) === ESRCH` rule is kept as the only proof for FIFO-less owners (mkfifo unavailable: Windows, drvfs) and for locks written before this change.
3. **Accepted entries.**
   - Exactly `{<uuid>.json}` or `{<uuid>.json, <uuid>.fifo}` with the same uuid. Anything else is UNPROVEN, as today.
   - A lone `<uuid>.fifo` is a release or reclaim cut short after its JSON was removed: it is free. Unlink it, then `rmdir`.
4. **Release / reclaim order.** Unlink `<uuid>.json`, unlink `<uuid>.fifo`, close the handle, then `rmdir` if empty. Every removal stays identity-keyed (that uuid's names only), so a racing reclaimer still cannot remove a successor's lock.
5. **Fail closed.**
   - mkfifo or open failure at acquire means a JSON-only owner, exactly today's behaviour.
   - A token whose identity does not match, a non-FIFO entry, a symlink, or any unexpected errno is UNPROVEN.
   - False "alive" outcomes are tolerated, for example a prober racing an open; false "gone" is impossible while the owner holds the read end.

**Read-only leg of row 17.** The read-only leg never proceeds:

- A read-only prober may *prove* the owner gone, because a FIFO write-open does not write the filesystem.
- Reclaiming still needs `unlink`, which returns `EROFS`.
- E4 makes that `EROFS` (not `ENOENT`) reach the caller as a typed refusal.

The live leg refuses, because the owner holds the reader. Only "clean" and "provably abandoned" proceed, as row 17 demands. **Row 17 is satisfiable by design: no stop.**

**Fix boundary.**

- `lifecycle/lock.mjs` covers every engine writer: bootstrap, advance, registry, recorder, prefill, capture, reopen, toolkit-identity, and `artifact-<id>` (row 25).
- The installer lock in `providers/install-support.mjs` mirrors the same token.
  - The duplication predates this change: the installer runs before any engine exists, so it cannot import `lock.mjs`.
  - It stays a `ponytail:` note pointing each copy at the other.

**Docs.**

- `lock.mjs` header: replace the PID-reuse and WSL-restart ceilings with the token's remaining ceilings: FIFO-less filesystems/Windows, and remote or 9p roots fail closed.
- `docs/lock-protocol-cutover.md` *Rule: one writer OS/PID namespace*: same-kernel sibling namespaces now reclaim. The Windows↔WSL single-writer rule stays, and `wsl --shutdown` no longer needs manual removal where FIFOs work.

**Compatibility.**

- A 1.6.4 reader sees two entries and returns UNPROVEN, so it refuses. It never reclaims wrongly.
- A new reader handles 1.6.4 single-entry locks by the old rule.
- Mixed-version writers on one root are already forbidden by the cutover doc.

**Files.**

- `packages/migration-engine/src/lifecycle/lock.mjs`
- `providers/install-support.mjs`
- `docs/lock-protocol-cutover.md`
- `packages/migration-engine/test/unit/lifecycle.test.mjs` (lock section) or a new `lock-liveness.test.mjs`
- `test/provider-installation.test.mjs`

**Codex impact.** An abandoned lock from an earlier sandboxed call is reclaimed automatically (rows 17, 25). A live lock still refuses. No sandbox, capability or mount change: `mkfifo` runs inside workspace-write.

**Copilot impact.** Same engine behaviour. Copilot's sandbox is not yet certified, and if FIFOs are refused there the old rule applies (fail closed).

**Identity.** Engine `src` and `providers/install-support.mjs` bytes change, so `contentHash` changes. Skill `computedHash` is unaffected unless docs projected into skills change (they do not).

**Focused tests** (Linux CI, using real processes):

- **Abandoned, cross-namespace:** a child takes the lock inside `unshare -Urpf` and is SIGKILLed. A second process, in another namespace, reclaims and proceeds. If unprivileged userns is unavailable the test is skipped with a reason; a same-namespace variant always runs.
- **Live:** the holder is alive and the waiter times out with "cannot be proven gone / still running". Nothing is removed.
- **Read-only:** a dead owner on a read-only bind mount gives a typed `EROFS` refusal and the lock remains.
- **Tamper / fail-closed:**
  - FIFO replaced by a regular file, by a symlink, or by a FIFO with another `ino`;
  - foreign `hostname`;
  - extra entry;
  - mismatched uuid;
  - JSON-only owner in a foreign realm.
  All of these are UNPROVEN.
- **Legacy and partial states:** a pre-change single-entry lock with the same-realm dead PID is reclaimed, and one from a foreign realm is refused. A lone `<uuid>.fifo` is freed.
- **mkfifo unavailable** (`PATH` without it): the lock is acquired JSON-only and today's behaviour applies.
- **Race:** two reclaimers on one dead owner give exactly one winner, and the successor's lock is untouched.
- **Installer:** the abandoned, live and read-only cases above, run through `adapter()`. The existing `recoveredLock` reporting is preserved.

---

## E3: AUTO contradiction in the contract text

**Rows:** 9, 12, A6.

**Root cause.** The implementation is authoritative (ruling A):

- `maySelfConfirm` (`lifecycle/policy.mjs:119-124`) lets AUTO self-confirm `registry`, `advance` and `discover`. This includes a `NOT_STARTED` bootstrap (pinned by `auto-authority.test.mjs:78-85`) and the BUILD_BASELINE registration (`advance.mjs:216-219`, `:361-372`).
- `artifact-run.mjs:186-231` keeps the two-phase gate only under `step` (or pilot format 14) and self-confirms otherwise.

The contract says the opposite in two places:

- `migration-contract.md:1063-1066`: "The carve-out is a bootstrap (`NOT_STARTED`) … so it stays two-phase under either mode."
- `:1092-1098`: "Registration is never self-confirmed, in any mode … It is therefore a stop condition for an autonomous loop. An unregistered mapping … advance fails with exit `1`."

Under AUTO, advance registers inline. Only an invocation without a mode (direct API) still throws with "not registered".

**Fix boundary.** Contract text only, no behaviour change.

- `:1063-1066`: a bootstrap is two-phase under `step`. Under `auto`, the AUTO principal confirms the preview it just computed, as for every other transition, and records it in `decisions/auto-decisions.ndjson`.
- `:1092-1098`: registration is self-confirmed under `auto` (inline at BUILD_BASELINE) and two-phase under `step`. Without a mode, the advance still fails with exit `1` and "not registered", writing nothing.
- Same-meaning sentences elsewhere: `SKILL.md:1448` and `migration-contract.md:1380` and `:1429` concern rework/amend under `step` and are already consistent. Stage 2 re-reads each `never self-confirmed` hit and changes only the contradictory ones.
- Explicitly not touched:
  - `references/v5-contract.md` is FROZEN. Its digest binds upgrade confirmations (`:3-6`, `:216-225`).
  - No AUTO ledger obligation is added.
  - `docs/auto-mode-autonomy.md` is history and is not projected.

**Files.**

- `skills/start-migration/references/migration-contract.md` and the 4 projections `providers/*/skills/start-migration/references/migration-contract.md` (regenerated by `pnpm providers:sync`)
- `skills-lock.json`
- `packages/migration-engine/test/unit/migration-contract.test.mjs`, only if it pins the old sentence

**Codex / Copilot impact.** The documentation now matches what both already do. No behaviour change.

**Identity.** Skill `computedHash` changes for all 4 providers; `contentHash` changes.

**Focused tests.**

- A contract-text assertion: the old carve-out and "never self-confirmed, in any mode" are absent, and the new sentences are present.
- Existing `auto-authority.test.mjs` passes unchanged. It is the behaviour the text now describes.
- `v5-contract-parity` passes unchanged, which proves the frozen v5 bytes did not change.
- `pnpm providers:check` and `pnpm skills:lock` are in sync.

---

## E4: filesystem failures lose their errno, and ENOENT masquerades as read-only

**Rows:** 16, 18, 24, 26.

**Root cause.** There are two layers.

1. **Wrong errno at the source.**
   - Node's recursive `mkdir` on a read-only mount reports `ENOENT` (syscall `mkdir`, path = first missing component), not `EROFS`. This is true on Node 22.13, 24.11 and 26.8 (spike S-E4).
   - R11's `ENOENT: mkdir …/.agents/knowledge/migrations/locks` was exactly this, from `mkdirDurably` (`store/files.mjs:36-53`) called by `acquireModuleLock` (`lock.mjs:202`).
   - The installer's `replace()` (`install-support.mjs:243`) and adapter lock dir (`:591`) use the same recursive mkdir.
2. **Structure dropped at the boundary.**
   - MCP `callTool` and `callToolInContext` catches (`mcp.mjs:604-607`, `:685-687`) return `{code:-32603, message}` and discard `code`, `errno`, `syscall` and `path`.
   - A client can only string-match the message, so a missing-path `ENOENT` and a genuine read-only refusal are indistinguishable.

**Fix boundary.**

1. In `mkdirDurably`, the shared primitive for every engine writer: if the recursive `mkdir` throws `ENOENT`, retry a non-recursive `mkdir(error.path)`.
   - Its parent exists by construction, so the kernel answers with the true errno (`EROFS`, `EACCES`, `EPERM`). That error is thrown unchanged.
   - If that retry succeeds (a racing creator) or answers `EEXIST`, the recursive `mkdir` is repeated once. A genuine `ENOENT` (parent removed concurrently) stays `ENOENT`.
   - It is one fallback in one function, so every caller is fixed.
   - The installer's two recursive `mkdir` calls get the same one-line fallback, because it cannot import the engine.
2. The MCP JSON-RPC error for a thrown `Error` with a string `code` carries `error.data = {code, errno, syscall, path}` as Node reported them. The message is unchanged. Nothing else is added, so no environment, token or credential path can enter `data`.
3. CLI stderr already prints Node's `CODE: message`, so it is correct once (1) restores the errno. No change.
4. Skill guidance (SKILL.md, the read-only refusal note next to the E1 text): classify a refusal by `error.data.code`.
   - `EROFS`, `EACCES` and `EPERM` are a sandbox write refusal, a legitimate safety stop.
   - `ENOENT` is a missing path. It is never a read-only refusal.

**Files.**

- `packages/migration-engine/src/store/files.mjs`
- `packages/migration-engine/src/transport/mcp.mjs`
- `providers/install-support.mjs`
- `skills/start-migration/SKILL.md` and its projections
- Tests listed below

**Codex impact.** A read-only workspace now surfaces `EROFS` with structured data, end to end (rows 16, 18, 24, 26). Behaviour on writable roots is unchanged.

**Copilot impact.** Identical.

**Identity.** `contentHash` changes, and skill `computedHash` changes through SKILL.md.

**Focused tests.**

- `durable-storage.test.mjs`:
  - an `unshare -Urm` read-only bind gives `EROFS` with `path` (skipped with a reason without userns);
  - a missing-parent race gives the retry;
  - a genuine `ENOENT` remains `ENOENT`;
  - an existing path is a no-op;
  - `mkdir` reports a first-created path as before.
- `mcp-server.test.mjs`: the error carries `data.code` for `EROFS` and for `ENOENT`, and a non-errno throw has no `data`.
- `provider-installation.test.mjs`: install into a read-only root is refused with `EROFS`.
- The existing `-32603` assertion (`mcp-server.test.mjs:1192`) is kept, because the code is unchanged.

---

## T1: Copilot CLI never sees the MCP server

**Rows:** Copilot P0 T1. These are prerequisites for every Copilot MCP row.

**Root cause.**

- The Copilot layout (`providers/install-support.mjs:23`), the generator (`scripts/providers-sync.mjs:360-362`, `:370`), `providers/copilot/adapter.json:31` and `providers/copilot/mcp.json` register in `.vscode/mcp.json` under `servers`, with no `tools` and no `env`.
- Copilot CLI 1.0.105 reads `~/.copilot/mcp-config.json`, workspace `.mcp.json` / `.github/mcp.json` (trusted folder only) or plugins, with the key `mcpServers`.
- For a local server, `tools` is **required** (D1 *Local server configuration fields*; `copilot mcp` help; P0 `H/sub-mcp.txt:9-12`).
- `provider-compatibility.md:28-30` documents the gap instead of closing it.

**Fix boundary** (payload, generator and installer; no harness):

1. Layout `copilot.project = ['.github/skills', '.github/prompts', '.github/mcp.json', 'mcpServers']`. `.github/mcp.json` was chosen over `.mcp.json` for three reasons:
   - It is Copilot's documented *repository* source, next to `.github/skills` and `.github/prompts`.
   - `.mcp.json` is Claude's registration file. Sharing it would make a Claude and a Copilot install on one root collide on the same `start-migration` key, which is `INSTALL_REGISTRATION_CONFLICT`.
   - It would also make Copilot load Claude's entry.
2. `serverFor('copilot')` returns:
   ```json
   {
     "type": "stdio",
     "command": "<execPath>",
     "args": ["<release>/…/mcp-server.mjs"],
     "tools": ["artifact_status","artifact_run","migration_status","migration_scan",
               "migration_evidence_binding","migration_prefill","migration_capture",
               "migration_pending_decisions","migration_run"],
     "env": {"pnpm_config_pm_on_fail": "error"}
   }
   ```
   - `tools` is exactly the 9 grants. `migration_relay_decision` is never granted; its CLI equivalent `artifact-migration-decision --relay` stays the documented path.
   - `env` carries `pm_on_fail=error` on the MCP leg. Copilot builds a local server's environment from `env` (D1), so the invariant cannot depend on the caller's environment.
   - One exported constant `COPILOT_MCP_TOOLS` in `install-support.mjs` is the only list. `providers-sync.mjs` imports it to render `providers/copilot/mcp.json` (`{"mcpServers": {...}}`), and a test asserts it equals the engine `TOOLS` names minus `migration_relay_decision`.
3. Convergence from ≤1.6.4 receipts:
   - The old shape `{type:'stdio',command,args}` in `.vscode/mcp.json` becomes Copilot's `legacy` server form. This reuses the existing `serverFor(provider, release, legacy)` and `validateSelection` candidate pattern, today used for OpenCode.
   - On update or rollback from a legacy receipt, the installer removes exactly the receipt-owned entry from `.vscode/mcp.json` (byte and semantic ownership as today) and writes the new entry to `.github/mcp.json`. Both files are inside the existing backup and restore set.
   - A modified legacy entry is a conflict and fails closed with `INSTALL_REGISTRATION_CONFLICT`. Unrelated `.vscode/mcp.json` content is preserved.
   - `historicalTemplateMatches` accepts both template shapes.
   - Doctor on a legacy receipt repairs in the receipt's own file only.
   - Receipt ownership, merge and conflict refusal are otherwise unchanged.
4. `adapter.json` `mcpConfig.project` becomes `.github/mcp.json`. It is generated from `providers-sync.mjs`.
5. `provider-compatibility.md`, the shared reference projected to all providers:
   - `:28-30` states the Copilot registration in `.github/mcp.json` with the 9-tool allowlist and `env`, and that Copilot loads it only in a trusted folder. Trusting the folder is the operator's or harness's act, never the payload's.
   - The table `:75` and the consumer-owned file list `:78` are updated to match.
   - The other hits are updated too: `docs/lock-protocol-cutover.md:64` (inventory), `docs/phase-4-acceptance.md`, `docs/runtime-install-update-audit-plan.md`, and the tests `test/provider-installation.test.mjs` and `test/provider-runtime-matrix.test.mjs`.
6. `skills/start-migration/scripts/runtime.mjs:220`, `:238-239` need **no change**. The runtime imports the *release's* checksum-verified `providers/install-support.mjs`, so the new registration ships with the release it belongs to. A test confirms this end to end.

**Files.**

- `providers/install-support.mjs`
- `scripts/providers-sync.mjs`
- `providers/copilot/{adapter.json,mcp.json}`, generated
- `skills/start-migration/references/provider-compatibility.md` and its 4 projections
- `docs/lock-protocol-cutover.md`
- `docs/phase-4-acceptance.md`
- `docs/runtime-install-update-audit-plan.md`
- `test/{provider-installation,provider-runtime-matrix,providers-sync,runtime-bootstrap}.test.mjs`

**Codex impact.** Codex behaviour is unchanged: its layout, `serverFor` and templates are untouched. Its skill `computedHash` changes only because `provider-compatibility.md` is a shared projected reference. That is an intended identity change.

**Copilot impact.**

- The `start-migration` server is registered where Copilot CLI 1.0.105 loads it, with exactly 9 grants and `pm_on_fail=error`.
- The CLI fallback is unchanged.
- Folder trust and `--add-dir <store>` remain harness duties (separate tasks).

**Identity.** Skill `computedHash` changes for all 4 providers; `contentHash` changes; `providers/copilot/adapter.json` and `mcp.json` digests change.

**Focused tests.**

- **Fresh install:** `.github/mcp.json` gets `mcpServers.start-migration` with exactly the 9 tools (and the relay absent) and `env.pnpm_config_pm_on_fail === "error"`. `.vscode/mcp.json` is not created.
- **Merge:** unrelated servers in `.github/mcp.json` are preserved. A foreign `start-migration` entry is refused with `INSTALL_REGISTRATION_CONFLICT`.
- **Legacy update:**
  - 1.6.4-style receipt plus `.vscode/mcp.json` with other servers: the owned entry moves, other servers stay, and remove restores both files byte for byte.
  - A modified legacy entry is a conflict with no writes.
  - A missing legacy entry is not an error.
- **Doctor:** a missing `.github/mcp.json` entry is repaired, and a tampered one is a conflict.
- **Generator:** `pnpm providers:check` passes, and `COPILOT_MCP_TOOLS` equals the engine tools minus the relay.
- **Codex:** adapter and provider tests unchanged and green, including the Codex layout snapshot.

---

## Identity (all defects)

| Item | Change | Why |
| --- | --- | --- |
| Skill `computedHash` (start-migration, all 4 providers) | changes | SKILL.md (E1, E4), migration-contract.md (E3), provider-compatibility.md (T1) |
| Skill `computedHash` (migrate-artifact) | expected unchanged | No file of it is touched. Verified by `skills:lock` in Stage 2 |
| Payload `contentHash` | changes | engine `src`, `providers/`, `skills/`, `skills-lock.json` |
| Version / pin / release candidate | **not done** | release.mjs refuses a changed payload as 1.6.4. Bumping to 1.6.5 and pinning are owner-gated. If CI requires a version bump to go green, Stage 2 stops and asks rather than bumping. |

## Invariants preserved

- No change to capabilities, NoNewPrivs, read-only mounts (pnpm included), root refusal, workspace-write or `approval_policy=never`.
- The Codex MCP grants are untouched.
- Copilot is pinned to exactly the same 9 grants.
- `pm_on_fail=error` is unchanged for Codex and made explicit for Copilot.
- No integrity, signature or sandbox disabling.
- `mkfifo` runs as a no-shell argv spawn inside the workspace.
- MCP `error.data` carries only `code`, `errno`, `syscall` and `path`.

## Separate tasks (recorded, not fixed here)

1. **Harness (row 17 fixture).** The abandoned-lock fixture must be a real new-format lock taken by an engine process that is then killed, not a hand-written owner file. The kill must target the engine process: killing the `codex sandbox` wrapper leaves it running (spikes.md S-E2b).
2. **Harness (Copilot).** Mark the consumer folder trusted and pass `--add-dir <store>` (P0 I-rows). The payload cannot and must not do either.
3. **Harness and infra I1–I12, T2, T3:** untouched.
4. **Owner.** Version bump, release candidate and pin for the joint candidate.

## Timebox and model

- Stage 1 was finished inside its 3 h box.
- Model: Claude Opus 5.5 throughout; no fallback trigger fired.
- AI credits are not visible to the agent session; read them from the Copilot usage report for this session.
