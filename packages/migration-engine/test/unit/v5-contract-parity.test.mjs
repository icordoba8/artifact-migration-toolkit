/**
 * The v5 upgrade contract exists twice on purpose, and the two copies must not
 * drift.
 *
 * `upgrade-migration.mjs` hashes `references/v5-contract.md` into every upgrade
 * transaction's `contractDigest`, so those bytes are persisted material in
 * consumer state, not documentation. The engine therefore has to carry its own
 * copy: it is installed alone, without `skills/`, and an engine that reaches
 * out of its package for a hashed input is an engine whose digest depends on
 * what else the host happened to install.
 *
 * The canonical operator-facing copy still lives under `skills/`, because that
 * is what the generated provider skill trees project. One file cannot be in
 * both places without a symlink, and Phase 2's generator rejects canonical
 * symlinks. So: two files, one assertion, and a byte difference fails here
 * rather than silently changing a digest.
 *
 * ponytail: byte-equality test, not a generator. If Phase 2's providers-sync
 * ends up projecting this file anyway, delete the copy and this suite with it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePackage = path.resolve(here, "../..");
const repositoryRoot = path.resolve(enginePackage, "../..");

test("the engine's hashed v5 contract is byte-identical to the canonical skill copy", async () => {
  const runtime = await readFile(
    path.join(enginePackage, "references/v5-contract.md"),
  );
  const canonical = await readFile(
    path.join(repositoryRoot, "skills/start-migration/references/v5-contract.md"),
  );
  assert.deepEqual(
    runtime,
    canonical,
    "references/v5-contract.md is hashed into contractDigest; the two copies must not drift",
  );
});
