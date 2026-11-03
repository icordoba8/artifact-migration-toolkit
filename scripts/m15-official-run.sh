#!/usr/bin/env bash
# Invocation only: the operator provisions and authenticates a disposable profile separately.
set -euo pipefail
AMT_CODEX=/home/utmwac/.codex/packages/standalone/releases/0.165.0-x86_64-unknown-linux-musl/bin/codex
AMT_NODE=/home/utmwac/.nvm/versions/node/v22.13.0/bin/node
AMT_REPO=$(cd -- "$(dirname -- "$0")/.." && pwd)
: "${AMT_HARNESS_COMMIT:?Set the externally approved full committed-harness SHA; never infer it from HEAD}"
: "${AMT_PATCH_SHA256:?Set the reviewed complete BASE-to-harness patch SHA-256}"
[[ "$AMT_HARNESS_COMMIT" =~ ^[a-f0-9]{40}$ && "$AMT_PATCH_SHA256" =~ ^[a-f0-9]{64}$ ]]
test "$(git -C "$AMT_REPO" rev-parse HEAD)" = "$AMT_HARNESS_COMMIT"
git -C "$AMT_REPO" merge-base --is-ancestor d7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d "$AMT_HARNESS_COMMIT"
test -z "$(git -C "$AMT_REPO" status --porcelain=v1 --untracked-files=all)"
test "$(bash "$AMT_REPO/scripts/m15-patch.sh" | sha256sum | cut -d' ' -f1)" = "$AMT_PATCH_SHA256"
: "${AMT_PROFILE:?Set AMT_PROFILE to an owner-authorized disposable profile containing home/ and codex/}"
test "$(sha256sum "$AMT_CODEX" | cut -d' ' -f1)" = c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5
test "$(sha256sum "$AMT_NODE" | cut -d' ' -f1)" = af8d5d1e234beb26b3095e6bebf80edc781f79c9435553a383037eccec2716f8
test "$("$AMT_CODEX" --version)" = 'codex-cli 0.165.0'
test "$("$AMT_NODE" --version)" = v22.13.0
test "$(id -u)" != 0
grep -q '^Seccomp:[[:space:]]*0$' /proc/self/status
test -f "$AMT_PROFILE/codex/auth.json"
# The nvm bin's `pnpm` is a Corepack 0.30.0 shim whose embedded npm key no longer verifies; resolve a pinned pnpm first.
# Its unpack is per run and removed on every exit, signals included; only the verified tarball persists.
# shortcut: SIGKILL skips the trap and leaves this run's directory; prune it by hand if that ever happens.
AMT_PNPM_RUN=/home/utmwac/.cache/amt-pnpm/pnpm-11.21.0.tgz.run.$$
trap 'rm -rf -- "$AMT_PNPM_RUN"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
bash "$AMT_REPO/scripts/m15-pnpm.sh" /home/utmwac/.cache/amt-pnpm/pnpm-11.21.0.tgz "$AMT_PNPM_RUN"
# No exec, so the trap outlives the runner. pm_on_fail=error refuses a target pinning another pnpm instead of
# downloading it; AMT_PNPM_DIR joins the runner's read-only mounts.
env -i PATH="$AMT_PNPM_RUN/bin:$(dirname "$AMT_CODEX"):$(dirname "$AMT_NODE"):/usr/local/bin:/usr/bin:/bin" \
  HOME="$AMT_PROFILE/home" CODEX_HOME="$AMT_PROFILE/codex" LANG=C.UTF-8 TERM="${TERM:-xterm}" \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm_config_pm_on_fail=error AMT_PNPM_DIR="$AMT_PNPM_RUN" \
  "$AMT_NODE" "$AMT_REPO/scripts/agent-e2e-acceptance.mjs" "$@"
