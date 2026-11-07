# Session broker

The broker gives a migration authenticated LEGACY and TARGET captures without
giving the agent a session. It is the smallest piece that enforces that: a
loopback service, running as an OS account the agent is not, that wraps the
engine's existing `captureInBrowser`. Both roles go through it, each with its
own session, through the same `migration_capture` operation (`role: "TARGET"`
writes the TARGET row).

## What it guarantees, and only when

| Guarantee | Holds when |
| --- | --- |
| The agent cannot read a session, cookie or stored value | The broker runs as a **separate OS account**, its store is private to that account, and the agent has no way to become that account or an administrator |
| Passwords and OTPs never reach the agent or the record | The operator types them into the broker's own browser window; no tool accepts one |
| LEGACY and TARGET sessions stay separate | Always: one file per role, each bound to its configured origin |
| A capture stays inside what the operator opened | Always: the role's origin and `routes`, and no write request (anything but GET, HEAD, OPTIONS) unless `allowWrites` is true |
| Only a client holding the token may ask | Always: loopback is every local account, so the bearer token is the authorization |
| An expired or revoked session is typed, not a false pass | Always: `EXPIRED` from the file, `CAPTURE_SESSION_EXPIRED` from the real browser |

**A broker running as the agent's own account isolates nothing.** Neither does a
persistent Playwright profile, DPAPI, Credential Manager, or an environment
variable: the same user can read them all. The engine refuses a capture from a
broker that reports the engine's own account (`CAPTURE_BROKER_NOT_ISOLATED`).
This matches the identity table in
[operator-signer-deployment.md](operator-signer-deployment.md).

On a host where the agent has `sudo`, `docker`, or `wsl.exe -u root`, no account
inside that Linux environment is a boundary. A WSL agent still runs Windows
programs as the Windows user, unelevated, so a separate **Windows** account is
the boundary for the Windows-hosted applications, as long as UAC stays between
that token and the administrator role.

## What the agent gets

`POST /status`, `POST /capture` and `POST /sign-in`, on `127.0.0.1` only, each
with `authorization: Bearer <token>`:

- `/status` answers `NONE`, `PRESENT` or `EXPIRED` for each role.
- `/capture` re-validates the plan, forces the role's origin and routes, and
  returns what the capture already sanitizes, plus the broker's account name.
  A plan's `storageState` or `browser` is dropped.
- `/sign-in` opens a browser at the configured sign-in route on the operator's
  desktop. It can reach that origin and the configured `identityProviders`,
  nothing else.

A missing token, a wrong `Host`, any `Origin` header, or a body that is not JSON
is refused, so neither another account nor a web page can use it.

## Windows deployment

There is no released bundle with the broker yet. Install from the **reviewed
candidate archive**, by its exact SHA-256. The published releases stay
untouched.

### 1. Install, once, from an elevated PowerShell

Set the first two lines, read the block, then paste it whole. It works in
ConstrainedLanguage mode, names groups by SID because names are localized,
and stops before changing anything unless it runs elevated, the archive
matches, and neither the directory nor the account exists yet. Any later
failure removes the account and the directory it created, so a failed run
leaves no account or store behind.

```powershell
$candidate = 'C:\path\to\artifact-migration-tools-<candidate>.tar.gz'
$expected = '<candidate SHA-256, as reported with the candidate>'
$root = 'C:\ProgramData\amt-session-broker'
$account = 'amt-broker'
$ErrorActionPreference = 'Stop'
if (-not ((whoami /groups) -match 'S-1-16-12288')) { throw 'Run this from an elevated PowerShell.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash -ne $expected) { throw 'The candidate archive does not match its SHA-256.' }
if (Test-Path -LiteralPath $root) { throw "$root already exists." }
if (Get-LocalUser -Name $account -ErrorAction SilentlyContinue) { throw "The account $account already exists." }
$created = $false
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  icacls $root /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls could not protect the directory.' }
  tar -xzf $candidate -C $root
  if ($LASTEXITCODE -ne 0) { throw 'The candidate archive did not extract.' }
  $password = Read-Host -AsSecureString "Password for $account (keep it out of any file)"
  New-LocalUser -Name $account -Password $password -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
  $created = $true
  Add-LocalGroupMember -SID S-1-5-32-545 -Member $account
  New-Item -ItemType Directory -Path "$root\store" | Out-Null
  icacls "$root\store" /inheritance:r /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls could not make the store private.' }
  $tokenFile = "$env:LOCALAPPDATA\artifact-migration-tools\session-broker.token"
  New-Item -ItemType Directory -Force -Path (Split-Path $tokenFile) | Out-Null
  Set-Content -NoNewline -LiteralPath $tokenFile -Value ((New-Guid).Guid + (New-Guid).Guid)
  $tokenHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tokenFile).Hash
  "token file: $tokenFile"
  "token hash: $tokenHash"
} catch {
  if ($created) { Remove-LocalUser -Name $account }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  throw
}
```

Then write `C:\ProgramData\amt-session-broker\config.json`, also elevated.
`clientTokenSha256` is the printed token hash. Use forward slashes. `routes` are
the path prefixes the agent may observe while signed in. Keep `allowWrites` off
unless a verified interaction must submit, such as an edit, and then only with
a disposable test account.

```json
{
  "port": 11900,
  "store": "C:/ProgramData/amt-session-broker/store",
  "clientTokenSha256": "<token hash>",
  "browser": "chrome",
  "applications": {
    "LEGACY": { "origin": "http://[::1]:11080", "signInRoute": "/login", "routes": ["/administration/partners"] },
    "TARGET": { "origin": "http://localhost:11088", "signInRoute": "/login", "routes": ["/administration/partners"] }
  }
}
```

Add `identityProviders: ["https://idp.example"]` to an application whose
sign-in leaves its origin.

### 2. Start it, from an ordinary terminal

The `amt-broker` password is typed here, each time. Never use
`runas /savecred`: it stores the credential where the agent's account can
replay it. `<bundle>` is the one directory the archive extracted.

```powershell
runas /user:amt-broker "\"C:\Program Files\nodejs\node.exe\" C:\ProgramData\amt-session-broker\<bundle>\packages\migration-engine\src\session-broker.mjs C:\ProgramData\amt-session-broker\config.json"
```

It refuses to start if the store admits anyone but its account, SYSTEM and
Administrators.

### 3. Point the target at it and make that file the operator's

Add the broker to the target's `.artifact-migration-tools/runtime-apps.json`:

```json
"sessionBroker": { "url": "http://127.0.0.1:11900", "tokenFile": "C:/Users/<you>/AppData/Local/artifact-migration-tools/session-broker.token" }
```

The engine starts an application only from a `runtime-apps.json` that another
account owns and this one cannot write. If it should start them, lock the file
from the elevated PowerShell:

```powershell
icacls <target>\.artifact-migration-tools\runtime-apps.json /setowner '*S-1-5-32-544'
icacls <target>\.artifact-migration-tools\runtime-apps.json /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' '*S-1-5-32-545:R'
```

### 4. Prove the boundary, then sign in

From the agent's account, all of these must fail with access denied or 401:

```powershell
Get-ChildItem C:\ProgramData\amt-session-broker\store
Get-Content C:\ProgramData\amt-session-broker\store\LEGACY.json
curl.exe -s -o NUL -w "%{http_code}" -X POST -H "content-type: application/json" --data "{}" http://127.0.0.1:11900/status
```

Before typing a password, confirm who owns the window's process:
`tasklist /v /fi "IMAGENAME eq node.exe"` must list `amt-broker`. Then sign in
once per role with a least-privileged test account, by asking the broker for
`/sign-in` (the agent can do this; only the operator types). Do it again only
when a session expires or is revoked.

## Residual risk

- **The operator's desktop is shared.** A process at the same integrity level on
  that desktop can watch the screen or keyboard while the operator signs in. Sign
  in while no agent is running.
- **A window is not proof of who opened it.** If the real broker is down, an
  agent could start its own on that port. Confirm the owner before typing.
- **The capability is real.** A capture acts as the test account inside the
  configured routes. A GET can still change state on an application that
  misuses it, such as a sign-out link, so the account must be least-privileged.
- **Capture sanitizes by rule, not by proof.** A page that prints a token as
  visible text would appear in a screenshot.
- **The token stops other accounts, not the agent.** The agent is the client.
- **UAC is the line.** An administrator token or auto-elevation defeats every
  boundary here.
