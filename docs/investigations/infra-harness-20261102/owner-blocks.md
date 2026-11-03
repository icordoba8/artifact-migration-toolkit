# Owner evidence blocks (G7: I11, I12)

These blocks cover only facts the agent cannot observe. Paste each one back
verbatim, filled in by you. A field counts as `HUMAN_ATTESTED` only when you
paste it yourself. Anything an agent restates, summarizes or copies from chat
is `AGENT_RELAYED` and never satisfies a row.

Never paste tokens, `auth.json`, cookies, API keys or credential hashes. The
agent never authenticates, logs in, signs out or revokes anything.

The second copy and its checksum verification (A6) are done by the agent and
recorded under "Agent-observed" below. They need no owner input.

## I11 — account provenance and revocation (one block per provider account)

```text
I11 PROVIDER: <codex | copilot>
I11 ACCOUNT_OWNER: <who owns the account (person or organization)>
I11 PROFILE: <path of the disposable profile / CODEX_HOME used for the runs>
I11 CREATED: <when the account or profile was created, UTC>
I11 LOGIN_METHOD: <e.g. device code, browser OAuth, API key issued by ...>
I11 SCOPE: <plan / org / permissions the account had during the runs>
I11 REVOKED_AT: <UTC time of provider-side revocation or sign-out>
I11 REVOKE_METHOD: <provider console page or command used>
I11 REVOKE_CONFIRMATION: <what the provider showed that confirms it, no secrets>
I11 ATTESTATION: HUMAN_ATTESTED by <name>, <UTC time>
```

## I12 — off-device receipt

```text
I12 SECOND_COPY: /mnt/c/Users/icordoba/OneDrive/amt-evidence-vault-copy/
I12 OFF_DEVICE_RECEIPT: <where the copy is seen off this device (e.g. OneDrive web / another machine), file names and sizes seen, UTC time>
I12 ATTESTATION: HUMAN_ATTESTED by <name>, <UTC time>
```

## V1 — Codex login revocation and recycle-bin purge (vault `restricted/`)

By your fail-closed decision, three `codex/log/codex-login.log` files in the
old vault tar count as credential material. The agent removed them from the
OneDrive copy without reading them (see "Agent-observed" below). Two things are
left that only you can do:

1. **Provider-side revocation** of the Codex logins used by the homes
   `auth-20261030T1715Z`, `auth2-20261030T1750Z` and
   `codex-recovery-20261030T125104Z`. Use ChatGPT → Settings → Security → "Log
   out of all devices". If an API key was used, revoke it in the OpenAI
   platform console instead.
2. **Purge the OneDrive recycle bin**, including the second-stage recycle bin,
   of `amt-evidence-vault.tar`, `amt-evidence-vault.tar.sha256` and
   `amt-evidence-vault.files.sha256`, all removed 2026-11-03; and of
   `amt-evidence-vault-sanitized-20261103.tar` (`620bf3b7…cc2c`) with its
   `.tar.sha256`, `.files.sha256` and `.restricted-inventory.tsv`, removed
   2026-11-03T13:34Z because its manifests held hashes of the login logs.

```text
V1 HOMES: auth-20261030T1715Z, auth2-20261030T1750Z, codex-recovery-20261030T125104Z
V1 REVOKED_AT: <UTC time of provider-side sign-out / key revocation>
V1 REVOKE_METHOD: <"Log out of all devices" | API key revoked in platform console | ...>
V1 REVOKE_CONFIRMATION: <what the provider showed that confirms it, no secrets>
V1 RECYCLE_BIN_PURGED_AT: <UTC time; first and second stage>
V1 ATTESTATION: HUMAN_ATTESTED by <name>, <UTC time>
```

## Agent-observed (A6)

Filled in by the agent from commands it ran itself. This is not owner evidence.

- **Existing second copies, re-verified 2026-11-03T01:19:27Z–01:19:33Z** in
  `/mnt/c/Users/icordoba/OneDrive/amt-evidence-vault-copy/`. The agent ran
  `sha256sum -c` on the three `.tar.sha256` files there, and all reported `OK`:
  - `amt-evidence-vault.tar` `d672d593…20fd`
  - `m15-certification-final-20261101T0100Z.tar` `3e3d56d6…c406`
  - `m15-certification-run-20261031T2015Z.tar` `a1ee9706…6d6f4ce`
- **This directory's copy.** The agent wrote
  `amt-infra-harness-20261102-evidence.tar` (this directory, `SHA256SUMS`
  included) and its `.sha256` to the same destination. It ran `sha256sum -c`
  there on the tar, and on `SHA256SUMS` inside a scratch extraction of that copy.
  The outputs are in `checks/second-copy.txt`. That file is not listed in
  `SHA256SUMS` because it records the copy of `SHA256SUMS`.
- **Vault `restricted/` outcome (2026-11-03).** The agent inventoried
  `m15-20261030T2045Z/restricted/` in the old `amt-evidence-vault.tar` from tar
  headers plus in-process SHA-256; no contents were opened. It found 10,146
  entries (7,618 files, 2,528 dirs) and no `auth.json`, token, key or cookie by
  name. By your fail-closed decision, 3 × `codex/log/codex-login.log` count as
  credential material; they were never read or hashed. The agent wrote
  `amt-evidence-vault-sanitized-20261103.tar` (`620bf3b7…cc2c`) without them
  and verified it: `sha256sum -c` OK, names = old minus 3, per-file 7,628 OK /
  0 failed. It then removed the old tar, `.tar.sha256` and `.files.sha256`.
  Their hashes are in `amt-evidence-vault.SUPERSEDED.txt` in the vault. Record:
  `checks/vault-restricted-classification.txt`. Revocation and recycle-bin
  purge are block V1 above.
  - **Credential-file hashes (owner correction, 2026-11-03).** A hash of a
    credential file is a credential hash. The vault manifests
    `manifests/{source-before,source-after,vault-copy}.sha256` held 3 such lines
    each, in the local vault and in `620bf3b7…`. They were replaced, not
    edited, by `*.r2.sha256` plus `manifests/MANIFESTS.SUPERSEDED.txt` (line
    numbers and names only). The OneDrive copy is now
    `amt-evidence-vault-sanitized-20261103-r2.tar` (`876b1678…cad3`): `sha256sum
    -c` OK, per-file 7,629 OK / 0 failed, 0 credential-hash hits. `620bf3b7…`
    is SUPERSEDED and removed; purge it per step 2.
  - Local vault: the 3 logs were removed 2026-11-03T13:21:20Z
    (`checks/local-vault-login-logs-removed.txt`). The shareable tar there has
    no credential-class names.
  - `m15-certification-final-20261101T0100Z.tar`: clean by name
    (`checks/m15-certification-final-inventory.txt`).
  - Still open (owner): `m15-certification-run-20261031T2015Z.tar` holds
    `runs/login-record.txt` (260 bytes). Classifying it would require reading
    it, so it was not touched.
- OneDrive sync status, and receipt off this device, are not observable here.
  They are the I12 block above.
