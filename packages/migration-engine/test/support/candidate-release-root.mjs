// A release *candidate* at an unregistered version, in a throwaway root.
//
// `released-versions.json` establishes the versions that were actually
// published, and the build refuses to stage different payload bytes under an
// established one -- `force` included, because claiming a published version is
// not the same kind of warning as a dirty tree. A suite that needs a staged
// *bundle* is not making a release claim, so it builds the committed payload as
// an unregistered `0.0.1` against an empty registry instead of restating the
// repository's real version. The checkout's own version is untouched.
//
// Only the declared versions move. The payload bytes, the provider manifests
// and every identity the bundle stamps are the committed ones, so a suite's
// assertions read the same content they always did -- at a version no
// publication owns.
//
// ponytail: copy the payload and restamp the declared versions; no build-root
// abstraction. Ceiling: the two package manifests are named literally, as
// `release.mjs` names them. Upgrade path: none needed while `payloadPaths`
// stays the one definition of what a payload is.

import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { payloadPaths } from "../../../../scripts/release.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Obviously a candidate, and no publication's version. */
const CANDIDATE_VERSION = "0.0.1";

const declaresVersion = (relative) =>
  ["package.json", "packages/migration-engine/package.json"].includes(relative) ||
  path.basename(relative) === "release-identity.json";

/**
 * Copy the committed payload into `parent` as an unregistered candidate root.
 *
 * `parent` is the caller's own scratch directory, so the copy is removed by the
 * cleanup the suite already has. A suite whose subject is version *ordering*
 * passes the `version` its own synthetic releases are ordered against; the
 * registry in the candidate root is empty either way, so the choice is about
 * that suite's semantics and never about the published-version gate.
 */
export const candidateReleaseRoot = async (parent, { version = CANDIDATE_VERSION } = {}) => {
  const root = await mkdtemp(path.join(parent, "release-candidate-"));
  for (const relative of await payloadPaths(repositoryRoot)) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, relative), destination);
    if (declaresVersion(relative)) {
      const manifest = JSON.parse(await readFile(destination, "utf8"));
      await writeFile(
        destination,
        `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
      );
    }
  }
  await writeFile(path.join(root, "released-versions.json"), "[]\n");

  // One link per declared dependency, pointed at the *resolved* store directory
  // rather than at `node_modules` as a whole. pnpm links each dependency into
  // the workspace package relatively (`../../../node_modules/.pnpm/...`), and a
  // single link over the directory left Windows resolving those relative targets
  // against the candidate root, where no store exists -- ENOENT on the first
  // dependency `release.mjs` dereferenced. Resolving here makes every target an
  // absolute real directory, which both platforms traverse the same way.
  //
  // ponytail: declared dependencies only, which is exactly the set `release.mjs`
  // copies. Ceiling: a suite that needed to *execute* from the candidate root
  // would need the transitive tree; none does.
  const engineModules = path.join(repositoryRoot, "packages/migration-engine/node_modules");
  const candidateModules = path.join(root, "packages/migration-engine/node_modules");
  await mkdir(candidateModules, { recursive: true });
  const { dependencies = {} } = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/migration-engine/package.json"), "utf8"),
  );
  for (const dependency of Object.keys(dependencies)) {
    await symlink(
      await realpath(path.join(engineModules, dependency)),
      path.join(candidateModules, dependency),
      "junction",
    );
  }
  return root;
};
