// The identity the test suite runs as.
//
// An unstamped record refuses every mutation until a toolkit is explicitly
// adopted, and a source checkout has no identity to adopt, so a suite that
// drives a lifecycle has to be an *identified* toolkit. There is deliberately
// no in-process seam that fabricates one -- a setter on `toolkit-identity.mjs`
// would be a forger's entry point into every gate that reads it -- so the suite
// becomes identified the only way anything does: a real `build-identity.json`
// beside the engine's `src/`, installed before the run and removed after.
//
// `scripts/engine-test.mjs` owns that install. The value below is obviously a
// fixture (`0.0.0-fixture`, a commit of zeroes) so a file left behind by a
// killed run can never be mistaken for a release, and `.gitignore` keeps it out
// of the tree a real release builds from.

import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_IDENTITY_FILE, TOOLKIT_NAME } from "../../src/toolkit-identity.mjs";

/** Valid under `validateToolkitIdentity`, and unmistakably not a release. */
export const FIXTURE_IDENTITY = {
  name: TOOLKIT_NAME,
  version: "0.0.0-fixture",
  commit: "0".repeat(40),
  contentHash: `sha256:${"0".repeat(64)}`,
};

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const fixtureIdentityFile = path.join(engineRoot, BUILD_IDENTITY_FILE);

export const installFixtureIdentity = () =>
  writeFile(fixtureIdentityFile, `${JSON.stringify(FIXTURE_IDENTITY, null, 2)}\n`, "utf8");

export const removeFixtureIdentity = () => rm(fixtureIdentityFile, { force: true });
