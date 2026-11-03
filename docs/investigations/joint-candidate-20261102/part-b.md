# Part B — E1–E4 implementation evidence

Owner decision on design `04423c9ea8d7dc58da0389e34a043c8205f96696` (HUMAN_ATTESTED).
BASE `15090145a43af1e1bcb9fbce692fafac6e06f1e9`. Executor: Copilot CLI 1.0.105,
Claude Opus 5.5 (no fallback). Not a readiness claim.

## Version discrepancy (resolved)

| Source | Value |
|---|---|
| Latest tag | `v1.6.4` |
| `released-versions.json` (last entry) | `1.6.4` |
| `package.json` at BASE | `1.6.4` |
| Phase 0 / P0 "1.6.5" | the unpublished cert candidate prepared in `874806f` ("prepare unpublished 1.6.5 Codex candidate"), never tagged or released |
| `docs/release.md:220-224` | a candidate never reserves its version |

Current released version is **1.6.4**; the design was right. Next version per policy:
**1.6.5**, applied like `874806f` (root and engine `package.json`, then
`pnpm skills:lock`, `pnpm providers:sync`). Risk: the evidence vault holds a
different-bytes cert build labelled 1.6.5; identify builds by contentHash
(`release-identity.json`), never by version string. This is not the candidate pin.

## Per defect

| Defect | Change | Tests |
|---|---|---|
| E1 | `store/registry.mjs` throws `REGISTRY_UNBOUND` carrying one BLOCKED / NOT_STARTED document; `transport/mcp.mjs` returns it as the tool result, `transport/entry.mjs` prints it on stdout with exit 2, `transport/run.mjs` wraps it with `finish("BLOCKED")`. Contract text (`migration-contract.md` registry paragraph + JSON example) and `SKILL.md` Invocation 1, projected to all four providers. | `mcp-server.test.mjs` "an unbound registry is the same BLOCKED / not started result on MCP and CLI, and writes nothing" (status/scan/run over MCP + `discover-module --status` and `run-migration --json` exit 2, identical `outcome/status/module/reason/nextAction/nextCommand`, conventional registry named once present, zero writes); `registry-resolution.test.mjs` (code + result shape; a stale binding stays ENOENT, never a first setup). |
| E2 | `lifecycle/lock.mjs` + installer mirror `providers/install-support.mjs`: `<uuid>.fifo` liveness token (read end opened `O_RDONLY\|O_NONBLOCK\|O_NOFOLLOW`; Node sets O_CLOEXEC), owner entry binds `fifo:{dev,ino}`; GONE only on ENXIO from a non-blocking write-open re-verified to be the recorded FIFO. Missing / mismatched / foreign token → `LOCK_OWNER_UNKNOWN`; token-less owner outside this PID realm → `LOCK_NO_LIVENESS_TOKEN`; live → `LOCK_HELD`; protocol-1 → `LOCK_PROTOCOL_1` (installer keeps `INSTALL_LEGACY_LOCK`). `docs/lock-protocol-cutover.md` updated. | Engine (`migration-contract.test.mjs`): SIGKILL of the real engine node process (child of `unshare -Urpf`, never the wrapper) → reclaimed; a detached grandchild outliving the owner does not keep the lock, token fd has O_CLOEXEC; token tamper matrix (missing, replaced by rename, non-FIFO, bad dev/ino, other host) → UNKNOWN, distinct from LOCK_HELD; no-`mkfifo` PATH fallback; race single winner. Installer (`provider-installation.test.mjs`): installer SIGKILLed in another PID namespace reclaimed; token matrix codes. |
| E3 | `migration-contract.md` only: bootstrap carve-out and "Registration is never self-confirmed, in any mode" replaced (AUTO self-confirms and records in `decisions/auto-decisions.ndjson`; `step` stays two-phase). `v5-contract.md` untouched (`git diff 15090145 -- '*v5-contract.md'` empty): it is "frozen" (`v5-contract.md:1-6`) and declared "the frozen decision record … (a historical diff, not a restatement of current values)" by `migration-contract.md:214-216`; it contains no AUTO text (0 matches); its registration section `:216-225` predates AUTO. | `auto-authority.test.mjs` contract-text pin (stale sentences absent, new rules present); `v5-contract-parity.test.mjs` unchanged and passing. |
| E4 | `store/files.mjs` `mkdirDurably` and installer `mkdirp`: on ENOENT, `access(parent, W_OK)` — a real syscall — supplies EROFS/EACCES/EPERM (original ENOENT kept as `cause`); anything else is typed `FS_ERRNO_UNKNOWN`. Nothing is created. MCP `internalError` forwards Node's own `{code, errno, syscall, path}` as `error.data`; non-errno errors carry none. | `durable-storage.test.mjs` (read-only bind mount → EROFS; injected unexplained ENOENT → FS_ERRNO_UNKNOWN; tree unchanged); `provider-installation.test.mjs` (read-only root → `{code: EROFS, cause: ENOENT}`, nothing created); `mcp-server.test.mjs` (missing registry → -32603 with `data.code ENOENT`, `syscall open`, `path`; torn `package.json` → no `data`). |

## Functional E2 check (`spikes-b/`)

`e2-check.mjs` / `e2-holder.mjs` → `e2-check.out`: token fd flags `02504000`
(O_CLOEXEC set); entries `<uuid>.fifo`, `<uuid>.json`; a live owner in another
PID namespace → `LOCK_HELD`; after SIGKILL of the engine node PID (unshare's
child) the next writer reclaims. The `unshare: sigprocmask` line is unshare
reporting its child's death.

## Findings during implementation

- A FIFO in the lock directory blocks any naive `readFile`/`open(O_RDONLY)` of
  "the first entry": `artifact-migration.test.mjs:4717` hung the full suite until
  it selected the `.json` entry. Test `treeOf` helpers skip FIFOs. Production
  code never reads lock entries by position.
- `transport/entry.mjs` first imported `lifecycle/policy.mjs`; A8-ARCH-2 /
  A7-ARCH-7 caught it; it now imports `lifecycle/index.mjs`.
- Kill helpers assert the PID read from `/proc/<pid>/task/<pid>/children` is
  positive: `kill(0)` would signal the whole test process group.

## /ponytail-review (BASE 15090145)

- `providers/install-support.mjs` `reclaim`: orphan-token predicate evaluated
  twice → computed once. Resolved.
- `createToken` win32 guard kept: Windows has no `O_NONBLOCK`, so an emulated
  FIFO would open as a regular file and every token would read UNKNOWN.

No open findings.

## Tests and CI

See `part-b-tests.txt`.

## Separate tasks (not fixed here)

- Row 17 killed-engine fixture → infrastructure lane.
- Copilot folder trust and `--add-dir` → P1.
- E5 (relay reachable by the agent under test) → owner-gated, see `design-t1-r2.md`.
