# M15 Node 22.13.0 disposition: Phase 2 (#11, #202, #430)

- Executor: Claude Code, Opus 5.5. Ponytail 4.8.4 `/ponytail full` for the implementation; `/ponytail-review` (5.1.0) ran twice on the full diff and connected code. Started 2026-10-31T18:28:00Z.
- Worktree: `/home/utmwac/amt-m15-uidmap`, branch `cert/m15-codex-uidmap-20261030`.
- Phase 1 evidence: `../m15-node2213-phase1-20261031T1822Z/` (SHA256SUMS `3298c00f…63d3`).

## Owner disposition of Attempt 3 (recorded as instructed)
- Attempt 3's functional PASS stands for its scope: module `discounts`, with no pnpm validator.
- It provides no evidence for artifacts that declare pnpm checks.
- ATTEMPT3_VALIDITY_AT_RISK is **closed as "scoped, not invalidated"**.

## Identities
| Identity | Value | Status |
|---|---|---|
| Frozen base (parent) | `6810b08f60984f184663b6d4977ccf8d0975f3e5` | HEAD equalled it with a clean tree before any edit |
| **New harness commit** | `8b2f7fddcf03ba3bdf8659b6096363c210eec62d` (tree `847ad8a0…`, parent 6810b08) | pushed to `toolkit` |
| Historical BASE | `d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d` | unchanged; still an ancestor of HEAD |
| Expected pin | `sha256:bbf8b295722287014407d2c6bf7bd5293105f3f65ea0575f92d135ab1fabbbf6` | unchanged; not touched |
| Payload contentHash | `sha256:1f9786e285d5ec2d183a0f9f91d8f64a5a46e6100e42a5b9fab7d5394bafaaf7` | unchanged (`release:check` at 8b2f7fd) |
| Historical AMT_PATCH_SHA256 | `8712859de88dedaf888fb6223f2bee2676f28826da68164d5953c67bdfd4012a` | kept in the record, paired with harness commit `6810b08f60984f184663b6d4977ccf8d0975f3e5` |
| **Owner-approved next official-run AMT_PATCH_SHA256** | `9ffb36059fb6da63014bea09defbecbfc4b1d01eec6f5dae8ba989f5d4aeef76` | paired with harness commit `8b2f7fddcf03ba3bdf8659b6096363c210eec62d` |

The owner corrected the brief: AMT_PATCH_SHA256 is part of the harness-commit identity. Their approval conditions were checked as follows:
1. **Post-commit digest equals the pre-commit digest:** all 64 hex characters match (`9ffb3605…ef76` both times).
2. **The review covered exactly that content:** the second `/ponytail-review` ran on the tree at that digest. Nothing changed between it and the commit (`git add -A` staged exactly the reviewed files).
3. **`release:check` passes:** no blockers, contentHash 1f9786e2. BASE, the expected pin and the payload are unchanged.
4. **The new digest is in no tracked file:** `grep` over `git ls-files` found nothing. No tooling derives it from HEAD. It appears only in this report and in SHA256SUMS (`owner-approved-next-official-run-AMT_PATCH_SHA256.d7eb28c-to-8b2f7fd.patch`, the exact `m15-patch.sh` output).
5. **8712859d is kept as historical,** paired with 6810b08.

## Change (6 files, +86/−5; full diff in `commit-6810b08-to-8b2f7fd.patch`)
- **#202, root cause.** On the official PATH, `pnpm` was the nvm v22.13.0 bin's Corepack 0.30.0 shim. Its embedded npm key `jl3bwswu…` cannot verify the registry signature `DhQ8wR5…`, so every pnpm package-script check exited 1.
  - New `scripts/m15-pnpm.sh` pins `PNPM_VERSION=11.21.0` and `PNPM_SHA512=521705bc…3bb1`, which is the registry integrity `sha512-UhcFvOaJ…Mo7sQ==`. It copies the pre-provisioned tarball into a fresh `mktemp -d` beside it, verifies the copy's sha512, and unpacks that same copy. It then prints a `bin/` that holds `pnpm` and `pnpx` symlinks.
  - It refuses with `PNPM_MISSING` or `PNPM_HASH_MISMATCH`. A mismatch leaves nothing behind. It never fetches.
  - `scripts/m15-official-run.sh` calls it **after** all existing refusals (pins, clean tree, patch, binary hashes, versions, root, seccomp, auth.json). It puts the result **first** on the `env -i` PATH, ahead of the nvm bin.
  - The node hash/version lines are byte-identical. `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` is kept, and Corepack integrity and signature checks are not disabled anywhere.
- **#11.** `scripts/engine-test.mjs` runs each unidentified suite in its own serial `node --test`. Only `test/external/format-17-acceptance.test.mjs` gets `--experimental-strip-types`. No `NODE_OPTIONS` is used, `fixtures.ts` is untouched, and the exit codes from the two runs are OR-combined.
- **#430.** `test/unit/lifecycle.test.mjs`:
  - Imports the `node:module` default as well.
  - Adds `{ skip: typeof nodeModule.registerHooks !== "function" && "requires node:module registerHooks (Node >= 22.15)" }`.
  - The assertions are unchanged.
- **Tests.** `test/agent-e2e-acceptance.test.mjs` adds two tests:
  - Launcher wiring (pnpm step and PATH order), the unchanged node hash line, missing → refuse, altered → refuse with no residue.
  - Verified tarball → `pnpm --version` = 11.21.0 and `pnpx` resolves. This one skips when the provisioned tarball is absent, as on CI.
- **Runbook.** `docs/m15-harness-implementation.md` gains a one-time provisioning step (curl from registry.npmjs.org only).

## Gates
| Gate | Result | Evidence |
|---|---|---|
| G1 | PASS | `pnpm/pnpm-11.21.0.json` (registry metadata): integrity `sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ==`, which equals the base64 of the tarball's sha512 and the repo pin. The tarball was fetched once: 8,799,855 B, sha256 `87237d37eadb79dc626a0576eb3a52d23d70422c323ae5e00fc05c91f4323780`, sha512 `521705bc…3bb1`. The npm ECDSA signature (keyid `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`, from `pnpm/npm-keys.json`) verifies over `pnpm@11.21.0:<integrity>`. `engines.node` is `>=22.13`, so 22.13.0 is accepted. |
| G2 | PASS | `logs/g2-launcher.log` (v22.13.0, rerun after the review fix): 3/3. These are the existing pin/clean-tree launcher test plus both new pnpm tests. |
| G3 | PASS | `logs/g3-pnpm-version.log`: env -i, official PATH composition, `pnpm` → `~/.cache/amt-pnpm/pnpm-11.21.0.tgz.run.fok2os/bin/pnpm` → `package/bin/pnpm.mjs`, node v22.13.0, `pnpm --version` 11.21.0. `logs/g3-202.log`: #202 individually on v22.13.0 → 1/1 pass. |
| G4 | PASS | `logs/g4-11.log`: `format-17-acceptance.test.mjs` on v22.13.0, 16/16, `ok 11 - an artifact transaction killed mid-write…`, not skipped. |
| G5 | PASS | `logs/g5-430.log`: `ok 1 - A8-ARCH-9 … # SKIP requires node:module registerHooks (Node >= 22.15)`. |
| G6 | PASS | `logs/architecture-check.log` ok. `logs/release-check.log` at 8b2f7fd: blockers `[]`, contentHash 1f9786e2. The pre-commit run (`release-check-precommit.log`) was blocked only by the dirty tree. |
| G7 | PASS | Review 1: Ship. Its finding 1 (pnpm unpacked before the refusals, so a refused or root launch leaves 47 MB) was fixed. Review 2 on the final content: Ship, no blocking findings. |
| G8 | PASS | `logs/push.log`, `logs/remote-tip.txt`: `6810b08..8b2f7fd`. CI run https://github.com/icordoba8/artifact-migration-toolkit/actions/runs/41230352274 is green on that exact SHA (`ci/run-41230352274.json`), with 5/5 jobs successful. |

### CI details (`ci/job-124623106406.log`, shard 3)
- Node is `v22.23.4` (line 146), not 22.13.0.
- `ok 11 - an artifact transaction killed mid-write…` (l.1005), `ok 202` (l.2444) and `ok 430 - A8-ARCH-9…` (l.3814) all PASS with no `# SKIP`.
- providers: 114 tests, 105 pass, 9 skip.
  - 8 are the pre-existing namespace / pinned-Node skips.
  - 1 is the new tarball-start test (`# SKIP requires the provisioned …`).
  - The new refusal test (`ok 30`) runs and passes.
- architecture ok.
- engine:test is 16/16 (format-17, now its own run) + 19/19 (toolkit-identity) + 1168/1168.
- engine:test:ts is 69/69.
- `gh run view --log` was not used; job logs came from `gh api …/jobs/ID/logs`.

## Not done / not checked
- No full engine suite locally, no scored run, no auth, no GPT, no merge, tags or release.
- The full launcher was not executed end to end, because that needs an authenticated profile. G3 reproduced its PATH and env composition exactly, and G2 checks the wiring by text plus behaviour of the helper.
- Node 22.23.4 is not installed locally. Its PASS evidence for #11 and #430 is CI only.
- pnpm `pmOnFail` (review finding 2) was not probed. That is the owner's policy choice, see Risks.

## Material risks
1. **pnpm version switch.** pnpm 11 defaults `pmOnFail` to `download` when a target's `packageManager` names a different pnpm. Such a target's validator would run a pnpm fetched at run time, not the pinned one. The M15 fixtures have no `packageManager`. Fix option: `pnpm_config_pm_on_fail=ignore|error` in the launcher env (owner's choice, untested).
2. **yarn shim and old shims.** `yarn`, `yarnpkg`, `pnpm` and `pnpx` in `/home/utmwac/.nvm/versions/node/v22.13.0/bin` are Corepack symlinks dated Jul 15 (someone ran `corepack enable` after the Jan 6 2025 Node install). They were left untouched.
   - `yarn` is still in the engine's `PACKAGE_MANAGERS` and still resolves to the shim, so any `yarn <script>` check fails the same keyid way on the official runtime.
   - pnpm/pnpx are now only shadowed, not removed.
3. **CI Node is not the official runtime.** CI resolves `node-version: 22` → v22.23.4, which has native `.ts` stripping and `registerHooks`. CI therefore proves #11/#430 PASS on 22.23.4, not 22.13.0.
   - #11 on 22.13.0 is proven only locally (G4).
   - #430 never runs on the official runtime. It skips by design, so its loader assertions are unexercised on 22.13.0.
   - On CI the tarball-start test skips. Only the refusal paths run there.
4. **Unpacked trees pile up.** Every official launch leaves one ~47 MB unpacked tree under `~/.cache/amt-pnpm/` (a `ponytail:` comment in the script says so). Prune them by hand. One exists now from G3: `pnpm-11.21.0.tgz.run.fok2os`.
5. **Write protection is the codex sandbox, not a bind.** The unpacked pnpm is protected from agent writes only by codex `workspace-write` (writable: target, `.agents`, `/tmp`). That is the same protection as the nvm node. It is not in the runner's read-only bind list.
6. **Corepack keys will rotate again.** Corepack 0.30.0 keys stay stale. Any path that bypasses the launcher, such as a plain shell with the nvm bin first, still hits the keyid failure.
