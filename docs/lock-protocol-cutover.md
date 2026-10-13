# Writer lock protocol 2: cutover runbook

v1.4.0 changes how every writer serializes itself. Protocol 1 (all releases up
to 1.3.19) took a regular lock file. Protocol 2 takes a directory that holds
exactly one owner entry, `<uuid>.json`, which records `pid`, `hostname` and the
PID `realm`. The two protocols do not see each other's locks, so a protocol-1
writer and a protocol-2 writer on one root can both "hold" the lock. This
cutover exists to make sure that never happens.

Locks affected, per consumer root:

- engine: `.agents/knowledge/migrations/locks/<module>.lock`
- installer: `.artifact-migration-tools/install.lock`

## What new code enforces, and what it cannot

Enforced by protocol-2 code (the `runtime.mjs` launcher shipped in each skill,
and the release installer `providers/install-support.mjs`):

- A release manifest without `writerLockProtocol: 2` is protocol 1. It is
  refused for every selection source: installed receipt, retained history,
  sibling receipts, the shared store, `--version`,
  `ARTIFACT_MIGRATION_TOOLS_VERSION`, rollback pins and downloads. The
  refusal (`RELEASE_LOCK_PROTOCOL_UNSUPPORTED`) happens before that release's
  adapter runs and before anything is written.
- The installer refuses to install, update to, roll back to, `doctor` or
  `exec` a protocol-1 release (`INSTALL_LOCK_PROTOCOL_UNSUPPORTED`). A root on
  protocol 1 can still be updated to protocol 2.
- A protocol-1 lock file is never reclaimed automatically, alive or dead.
- An owner entry is reclaimed automatically only if it is a valid regular
  file (no symlink) recorded on this host, in this PID realm, and the PID
  probe answers ESRCH. Anything else fails closed.

Not enforceable: historical executables. A 1.3.x `runtime.mjs` in an old skill
copy, a release still in a store (`node <store>/<release>/...`), an MCP server
registered by an old receipt, or a vendored `mcp-server.mjs` runs protocol-1
code that no new code can stop. Releases v1.3.6 through v1.3.19 stay
downloadable by exact tag. The cutover therefore depends on the operator:
every writer is stopped first and restarted only on protocol 2.

## Rule: one writer OS/PID namespace per writable root

A PID only means something inside its own namespace. Windows and each WSL
distro share a hostname, and through `/mnt/c` and `\\wsl.localhost` they share
files, but they do not share PIDs. The realm recorded in an owner entry is
`win32` on Windows, `darwin` on macOS, and `linux:pid:[<inode>]` on Linux (one
per PID namespace: each WSL distro, each container).

- Pick one namespace (Windows, or one WSL distro) per consumer root. Only that
  namespace runs CLI, MCP, installer or skill commands that write to the root.
- Windows and WSL must never both write to the same root, before or after
  the cutover.
- A lock owned by another realm is never reclaimed automatically. The error
  says "cannot be proven gone". `wsl --shutdown` starts a new realm, so a lock
  left by a WSL process killed before the shutdown also needs manual removal.

## Procedure

Do this once per consumer root. Do not touch roots you are not cutting over.

1. **Inventory.** Record the root, the store, and each receipt at
   `<root>/.artifact-migration-tools/<provider>.json` (`toolkit.version`,
   `release`). Record every MCP registration that points at a store release
   (`.mcp.json`, `.codex/config.toml`, `opencode.json`, `.vscode/mcp.json`,
   `.agents/mcp.json`).
2. **Stop every writer, in every namespace that can reach the root.** Close
   Claude Code, Codex, OpenCode and Copilot sessions on the root, including
   unattended ones (`--permission-mode auto`, `--approve-for-me`). Closing a
   host stops the MCP servers it started. Then look for anything still
   running:
   - Linux / WSL: `pgrep -af 'artifact-migration|mcp-server\.mjs|start-migration|migrate-artifact'`
   - Windows (PowerShell): `Get-CimInstance Win32_Process | Where-Object CommandLine -match 'artifact-migration|mcp-server\.mjs|start-migration|migrate-artifact' | Select-Object ProcessId, CommandLine`

   Stop whatever you find, in its own namespace.
3. **Verify quiescence.** Rerun both process checks, from Windows and from
   every WSL distro. Then list the locks:
   `ls -la <root>/.agents/knowledge/migrations/locks <root>/.artifact-migration-tools | grep '\.lock'`.
   Wait a minute and check again. Continue only if no process is found and
   nothing changes between the two checks.
4. **Preserve legacy locks.** A regular file named `*.lock` was written by
   protocol 1. With quiescence verified, rename it instead of deleting it,
   for example `mv install.lock install.lock.protocol1-<UTC timestamp>`. No
   tool reads that name. A `*.lock` directory is protocol 2: leave it alone.
   An empty directory, or one whose owner died in this realm, is reclaimed
   automatically.
5. **Upgrade, from the chosen namespace only.** Run `skills add` for both
   `start-migration` and `migrate-artifact` from the v1.4.0 release, then run
   either skill once for each provider in use. The launcher converges the
   receipt, the other hosts' skill copies and the MCP registration to v1.4.0.
   The installer can do the same directly:
   `node <release>/providers/<provider>/install.mjs update --scope project --root <root> --store <store> --bundle <release> --pin sha256:<manifest digest>`.
6. **Verify.** Each receipt names a release whose `release-manifest.json` has
   `"writerLockProtocol": 2`. Every MCP registration points into that release.
   No old skill copy is left in any host's skill root (`.agents/skills`,
   `.claude/skills`, `.github/skills`, `.codex/skills`, `.opencode/skills`).
7. **Restart writers**, in the chosen namespace only.

## Rollback policy

Protocol-2 code never selects, runs or rolls back to a protocol-1 release.
Rollback stays available between protocol-2 releases (v1.4.0 and later) only.
Returning a root to v1.3.x is unsupported. It would take this whole procedure
in reverse, done by hand with historical binaries.

## Interrupted cutover

Every step can be rerun. The installer restores its backups on failure, and
the launcher converges the receipt on the next run. After an interruption:

- Repeat steps 2 and 3 before doing anything else.
- `<name>.lock.<uuid>.tmp` and `install.lock.<uuid>.tmp` directories are
  staging left by a killed acquirer. Nothing reads them, and they can be
  deleted while the root is quiescent.
- If an error reports an owner that "cannot be proven gone" (another realm,
  an unreadable or malformed entry, a symlink), confirm quiescence in every
  namespace, then remove that lock directory by hand (`rm -r <lock>`).
- If an error reports a protocol-1 lock file, do step 4.
- Then continue from step 5.
