# Operator Signer — Protected Deployment Contract

This deployment is an **optional high-assurance enhancement**. Normal Module 19
and Artifact 14 migrations use engine-owned `STANDARD_LOCAL` / `AGENT_RELAYED`
authority, with explicit operator decisions and no signer infrastructure.

This is a generic contract for a managed Linux host. It is not a machine configuration. HUMAN_ATTESTED writes remain **OFF** in this build. This document describes what a deployment must provide before real-host acceptance (gate 2) and protected activation (gate 3) can even be attempted.

## Identities

| Identity | Purpose | Must not have |
| --- | --- | --- |
| `migration-agent` (non-admin) | Runs the provider, model, MCP and engine CLI in the worktree | sudo/root, docker or container-host escalation, ptrace of signer/browser, access to operator home/session bus/browser profile, access to the signer store or admin socket, browser debug/automation interfaces |
| `operator` (desktop) | Reviews in an operator-only browser profile with a registered authenticator | shared profile with the agent, agent-controlled extensions or debug port |
| `amt-signer` (dedicated, non-login) | Runs `operator-signer-service.mjs` from the installed, read-only release | login shell, write access to the installed release, write access to anything except its store and the decision ledgers it appends |

Root (the admin) owns installation, `/etc/artifact-migration-tools/operator-signer/`, the TLS key, and enrollment control. If any agent capability in the table cannot be removed on a host, that host **fails** acceptance; root-owned files alone do not make it isolated.

## Protected files (root-owned, not group/world-writable, no symlinks)

- `/etc/artifact-migration-tools/operator-signer/service.json`: `{serviceUid, origin, rpID, port, storeDirectory, tlsKeyFile, tlsCertFile, loginTokenFile, targets}`. `origin` is one exact `https://` origin whose hostname is `rpID` and whose port is `port`; there is no list, wildcard or HTTP fallback. `targets` maps opaque review keys to record locators (`{recordKind: "module", registryPath, moduleName}` or `{recordKind: "artifact", artifact: {source, type, sourceRoot, targetRoot}}`).
- `/etc/artifact-migration-tools/operator-signer/activation.json`: the gate-3 manifest, `{version, signerBuild: {contentHash}, protocol, hostProfile, origin, rpID, registry: {registryId}, approval: {actor, at, reason}}`. In this build, a valid manifest reports `CHECKED`, and writes stay disabled.
- `storeDirectory`: mode `0700`, owned by `amt-signer`. It holds `signer.sqlite` (mode `0600`, WAL, `synchronous=FULL`). Back it up only under admin custody. A restore that loses committed claims or revocations is unsafe and must block reads until reconciled.
- `loginTokenFile`: in an operator-only directory. Each service start writes one single-use login URL there.

## Service manager requirements

Run as `amt-signer` with a pinned Node ≥ 22.13 (for `node:sqlite`) and the installed release bundle; never run JS from a worktree. Use a sanitized environment (no `NODE_OPTIONS`), `NoNewPrivileges`, a private `/tmp`, a read-only release path, and bind `127.0.0.1` only. A port conflict is fatal (`PORT_IN_USE`). The service never moves to another port.

## Operations (admin only, run as `amt-signer`)

- `operator-signer-service.mjs enroll <operator> <admin> <reason> [allow-counterless]` starts enrollment-only mode. The operator completes the ES256 + UV ceremony in their browser.
- `retire|revoke <credentialId> <admin> <reason>`: a retired credential keeps its history verifiable, and a revoked one invalidates its attested authority on reads.
- `reconcile <nonce> <admin> <reason>`: a `CLAIMED` nonce becomes `COMMITTED` only if its exact durable line replay-verifies. Otherwise it becomes `ABANDONED` (spent forever). A torn ledger is refused and needs an explicitly authorized, non-destructive repair.
- `serve` refuses with `SIGNER_UNAVAILABLE` until gate 3 is performed by a later, separately approved release.

The migration CLI, MCP server and provider adapters expose none of these admin
operations. An explicit protected HUMAN_ATTESTED requirement reports
`SIGNER_UNAVAILABLE` without activated infrastructure, with no relayed fallback.
Absent that opt-up, standard operation is self-contained and signer availability
is irrelevant. Provider/terminal relays never claim cryptographic human attestation.
