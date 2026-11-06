# Session broker

The broker gives a migration authenticated LEGACY and TARGET captures without
giving the agent a session. It is the smallest piece that enforces that: a
loopback service, running as an OS account the agent is not, that wraps the
engine's existing `captureInBrowser`.

## What it guarantees, and only when

| Guarantee | Holds when |
| --- | --- |
| The agent cannot read a session, cookie or stored value | The broker runs as a **separate OS account**, its store is private to that account, and the agent has no way to become that account or an administrator |
| Passwords and OTPs never reach the agent or the record | The operator types them into the broker's own browser window; no tool accepts one |
| LEGACY and TARGET sessions stay separate | Always: one file per role, each bound to its configured origin |
| An expired session is typed, not a false pass | Always: `EXPIRED` from the file, `CAPTURE_SESSION_EXPIRED` from the real browser |

**A broker running as the agent's own account isolates nothing.** Neither does a
persistent Playwright profile, DPAPI, Credential Manager, or an environment
variable: the same user can read them all. This matches the identity table in
[operator-signer-deployment.md](operator-signer-deployment.md).

On a host where the agent has `sudo`, `docker`, or `wsl.exe -u root`, no account
inside that Linux environment is a boundary. A WSL agent still runs Windows
programs as the Windows user, unelevated, so a separate **Windows** account is
the boundary for the Windows-hosted applications, as long as UAC stays between
that token and the administrator role.

## What the agent gets

`POST /status`, `POST /capture` and `POST /sign-in`, on `127.0.0.1` only:

- `/status` answers `NONE`, `PRESENT` or `EXPIRED` for each role.
- `/capture` re-validates the plan, forces the role's origin and returns what the
  capture already sanitizes. A plan's `storageState` or `browser` is dropped.
- `/sign-in` opens a browser at the configured sign-in route on the operator's
  desktop. It cannot be pointed anywhere else.

A wrong `Host`, any `Origin` header, or a body that is not JSON is refused, so a
web page cannot reach it.

## Windows deployment (once, from an elevated PowerShell)

An administrator runs this. Read it first: it creates a local account. Every
command works in ConstrainedLanguage mode, and groups are named by SID because
their names are localized.

```powershell
$root = 'C:\ProgramData\amt-session-broker'
$password = Read-Host -AsSecureString 'Password for amt-broker (keep it out of any agent-readable file)'
New-LocalUser -Name amt-broker -Password $password -PasswordNeverExpires -UserMayNotChangePassword
Add-LocalGroupMember -SID S-1-5-32-545 -Member amt-broker
New-Item -ItemType Directory -Path "$root\store","$root\engine" -Force
Copy-Item -Recurse "$env:LOCALAPPDATA\artifact-migration-tools\<release>\packages\migration-engine\*" "$root\engine"
icacls "$root" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX"
icacls "$root\store" /inheritance:r /grant:r "amt-broker:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"
```

Then write `C:\ProgramData\amt-session-broker\config.json`, also elevated:

```json
{
  "port": 11900,
  "store": "C:\\ProgramData\\amt-session-broker\\store",
  "browser": "chrome",
  "applications": {
    "LEGACY": { "origin": "http://localhost:<port>", "signInRoute": "/login" },
    "TARGET": { "origin": "http://localhost:<port>", "signInRoute": "/login" }
  }
}
```

Start it from an ordinary terminal. The password is typed here, each time. Never
use `runas /savecred`: it stores the credential where the agent's account can
replay it.

```powershell
runas /user:amt-broker "node C:\ProgramData\amt-session-broker\engine\src\session-broker.mjs C:\ProgramData\amt-session-broker\config.json"
```

Add `"sessionBroker": "http://127.0.0.1:11900"` to the target's
`.artifact-migration-tools/runtime-apps.json`. Sign in once per role with a
least-privileged test account, and again only when a session expires.

Prove the boundary from the agent's account before relying on it. Both must fail
with access denied:

```powershell
Get-ChildItem C:\ProgramData\amt-session-broker\store
Get-Content C:\ProgramData\amt-session-broker\store\LEGACY.json
```

## Residual risk

- **The operator's desktop is shared.** A process at the same integrity level on
  that desktop can watch the screen or keyboard while the operator signs in. Sign
  in while no agent is running.
- **A window is not proof of who opened it.** If the real broker is down, an
  agent could start its own on that port. Before typing, confirm the owner:
  `tasklist /v /fi "IMAGENAME eq node.exe"` must list `amt-broker` for the broker.
- **The capability is real.** A capture acts as the test account inside the
  configured origin, so that account must be least-privileged.
- **Capture sanitizes by rule, not by proof.** A page that prints a token as
  visible text would appear in a screenshot.
- **TARGET through Playwright MCP is not covered.** The engine's capture writes
  LEGACY evidence. An authenticated TARGET browser needs Playwright MCP hosted by
  the broker's account, which has not been tested.
