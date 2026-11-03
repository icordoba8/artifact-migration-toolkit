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
- **Risk for the owner.** The pre-existing `amt-evidence-vault.tar` (written
  2026-10-31, before this session) contains
  `m15-20261030T2045Z/restricted/` (10,146 entries; listed by name only, never
  opened; no entry is named `auth.json`). It sits in a cloud-synced folder.
  Whether that subtree may stay there is an owner decision; the agent did not
  alter or delete it.
- OneDrive sync status, and receipt off this device, are not observable here.
  They are the I12 block above.
