/**
 * The engine suite, in two passes, because the suite has two runtimes to be.
 *
 * An unstamped record refuses every mutation until a toolkit is explicitly
 * adopted, and a source checkout has no identity to adopt. So a suite that
 * drives a lifecycle must run as an *identified* toolkit, and the only honest
 * way to be one is a real `build-identity.json` beside the engine's `src/` --
 * there is no in-process seam that fabricates an identity, by design.
 *
 * The identity suites are the exception: their subject is what an unidentified
 * checkout may and may not do, and they seed their unstamped fixture record by
 * being one. They therefore run first, with no identity file present, and every
 * *stamped* case they prove runs a staged release bundle as a child process --
 * a real installation, exactly as an operator meets it.
 *
 * Sequential on purpose. The identity file is one path in one tree, so two
 * passes that disagree about its existence must never overlap.
 *
 * ponytail: two `node --test` runs and a try/finally, no runner plugin. Ceiling:
 * the file list is maintained by hand in `package.json`. Upgrade path: glob it,
 * once `test/support/` and `*.fixture.mjs` can be excluded without guesswork.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fixtureIdentityFile,
  installFixtureIdentity,
  removeFixtureIdentity,
} from "../packages/migration-engine/test/support/fixture-identity.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Suites whose subject is the unidentified runtime itself. */
const UNIDENTIFIED_SUITES = [
  "test/unit/toolkit-identity.test.mjs",
  "test/external/format-17-acceptance.test.mjs",
];

const isUnidentifiedSuite = (file) =>
  UNIDENTIFIED_SUITES.some((suite) => file.replaceAll("\\", "/").endsWith(suite));

const runTests = (files, ...flags) =>
  files.length === 0
    ? Promise.resolve(0)
    : new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--test", ...flags, ...files], {
          cwd: repositoryRoot,
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
      });

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error("Usage: engine-test.mjs <test file> [...]");
}

// Unidentified first: a failure here is a failure about the gate itself, and it
// is worth seeing before three minutes of lifecycle suites.
//
// Serially, because both suites here stage a release build into the same
// `dist/` directory, and two builds that clear and repopulate one path at once
// make each other's bundle disappear mid-read. Two files, so serial costs
// nothing; the identified pass keeps its default concurrency.
const unidentified = await runTests(files.filter(isUnidentifiedSuite), "--test-concurrency=1");

let identified = 0;
const rest = files.filter((file) => !isUnidentifiedSuite(file));
if (rest.length > 0) {
  await installFixtureIdentity();
  try {
    identified = await runTests(rest);
  } finally {
    // Always, including on a throw: an identity file left in a source tree
    // would silently identify every later command run from this checkout.
    await removeFixtureIdentity();
  }
}

if (unidentified !== 0 || identified !== 0) {
  process.exitCode = 1;
  console.error(
    `engine:test failed (unidentified pass ${unidentified}, identified pass ${identified}). ` +
      `The identified pass runs with ${fixtureIdentityFile}.`,
  );
}
