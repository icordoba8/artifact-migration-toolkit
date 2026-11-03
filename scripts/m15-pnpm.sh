#!/usr/bin/env bash
# Verify the pinned, pre-provisioned pnpm tarball (never fetched here) and unpack the verified copy
# into the new run directory <run>, whose bin/ then holds `pnpm` and `pnpx`. The caller removes <run>.
set -euo pipefail
PNPM_VERSION=11.21.0
PNPM_SHA512=521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1
tgz=${1:?usage: m15-pnpm.sh <pnpm-$PNPM_VERSION.tgz> <new run dir>}
run=${2:?usage: m15-pnpm.sh <pnpm-$PNPM_VERSION.tgz> <new run dir>}
test -f "$tgz" || { echo "PNPM_MISSING: $tgz (provision pnpm $PNPM_VERSION from registry.npmjs.org first)" >&2; exit 1; }
mkdir -m 700 -- "$run"
# Hash and unpack one private copy, so the bytes verified are the bytes executed.
cp -- "$tgz" "$run/pnpm.tgz"
test "$(sha512sum "$run/pnpm.tgz" | cut -d' ' -f1)" = "$PNPM_SHA512" ||
  { rm -rf -- "$run"; echo "PNPM_HASH_MISMATCH: $tgz is not pnpm $PNPM_VERSION" >&2; exit 1; }
tar -xzf "$run/pnpm.tgz" -C "$run" --no-same-owner --no-same-permissions
mkdir "$run/bin"
ln -s ../package/bin/pnpm.mjs "$run/bin/pnpm"
ln -s ../package/bin/pnpx.mjs "$run/bin/pnpx"
