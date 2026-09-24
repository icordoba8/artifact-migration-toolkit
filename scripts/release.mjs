#!/usr/bin/env node

/**
 * Release identity and the staged, checksum-verifiable release bundle.
 *
 * Three commands, one hash:
 *
 *   --check   releasability gate: clean protected tree, versions agree, the
 *             generated provider trees are current. Writes nothing.
 *   --build   stage `dist/<name>-<version>/` from the *committed* tree, inject
 *             `build-identity.json`, render the provider manifests' release
 *             placeholders, and write `release-manifest.json` + `SHA256SUMS`.
 *   --verify  re-hash a staged bundle against its own manifest.
 *
 * The content hash is explicitly acyclic. Its inputs are the canonical skills,
 * the engine payload, the lockfile and the *committed* provider payload with
 * the four release placeholders still unrendered. Everything that carries the
 * identity -- `build-identity.json`, the rendered manifests, the checksums,
 * `release-manifest.json` -- is derived after the hash exists and is never an
 * input to it. The Git commit SHA is injected while packaging an already
 * committed tree, so no committed file ever tries to contain the SHA of the
 * commit containing it.
 *
 * Resolved dependencies are copied into the bundle so it runs where it is
 * installed. The lockfile pins their identity inputs; the transport manifest
 * also hashes every shipped dependency byte so installation detects tampering.
 *
 * ponytail: a staged directory plus checksums, not tar/zip archives. Immutable
 * identity is what the acceptance gate needs and `SHA256SUMS` over an exact
 * commit provides it; the transport format is the distribution phase's problem
 * and adding one here would be a packaging decision made a phase early.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  TOOLKIT_CONTENT_HASH_PLACEHOLDER,
  TOOLKIT_COMMIT_PLACEHOLDER,
  TOOLKIT_VERSION_PLACEHOLDER,
} from "./providers-sync.mjs";
import {
  IDENTITY_BASENAME,
  canonicalSkillNames,
  identityDocument,
  identityPath,
} from "./skills-lock.mjs";

const execFileAsync = promisify(execFile);

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const TOOLKIT_NAME = "artifact-migration-tools";

/**
 * What a release *is*, as paths. Ordered and explicit: a glob over the working
 * tree would quietly fold an untracked scratch file into the identity of a
 * release, which is the one thing a content hash must never do.
 */
const PAYLOAD_ROOTS = [
  "skills",
  "packages/migration-engine/src",
  "packages/migration-engine/references",
  "providers",
];
const PAYLOAD_FILES = [
  "pnpm-lock.yaml",
  "skills-lock.json",
  "package.json",
  "packages/migration-engine/package.json",
];

/** Never part of the payload: installed output, and generated release identity. */
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);
const EXCLUDED_FILES = new Set(["build-identity.json", "release-manifest.json", "SHA256SUMS"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const git = async (...args) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
};

const walk = async (root, relative = "", includeInstalled = false) => {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) {
      if (!includeInstalled && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await walk(root, path.posix.join(relative, entry.name), includeInstalled)));
    } else if (!EXCLUDED_FILES.has(entry.name)) {
      files.push(path.posix.join(relative, entry.name));
    }
  }
  return files;
};

/** Every payload path, repository-relative, POSIX-separated, sorted. */
export const payloadPaths = async (root = repositoryRoot) => {
  const paths = [...PAYLOAD_FILES];
  for (const directory of PAYLOAD_ROOTS) {
    for (const relative of await walk(path.join(root, directory))) {
      paths.push(path.posix.join(directory, relative));
    }
  }
  return paths.sort();
};

/**
 * Path and bytes both, exactly like `skills-lock.mjs`: a rename must move the
 * hash as surely as an edit does.
 */
export const contentHashOf = async (root = repositoryRoot) => {
  const digest = createHash("sha256");
  const files = {};
  for (const relative of await payloadPaths(root)) {
    const bytes = await readFile(path.join(root, relative));
    files[relative] = `sha256:${sha256(bytes)}`;
    digest.update(relative);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return { contentHash: `sha256:${digest.digest("hex")}`, files };
};

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

export const declaredVersions = async (root = repositoryRoot) => ({
  root: (await readJson(path.join(root, "package.json"))).version,
  engine: (await readJson(path.join(root, "packages/migration-engine/package.json"))).version,
});

/**
 * Releasability. Every failure is collected rather than thrown one at a time,
 * so one run tells the operator everything that is wrong.
 */
export const releaseCheck = async (root = repositoryRoot) => {
  const blockers = [];
  const versions = await declaredVersions(root);
  if (versions.root !== versions.engine) {
    blockers.push(
      `Root version ${versions.root} and engine version ${versions.engine} disagree. Provider adapter versions equal the toolkit version; there is no independent engine SemVer.`,
    );
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(versions.root)) {
    blockers.push(`Version '${versions.root}' is not an exact release SemVer.`);
  }
  // A dirty tree cannot be released: the commit SHA in the identity would name
  // a tree that is not the one being hashed.
  const dirty = await git("status", "--porcelain");
  if (dirty) {
    blockers.push(`The working tree is not clean:\n${dirty}`);
  }
  const commit = await git("rev-parse", "HEAD");
  // Untracked payload files would be hashed but not committed, so the identity
  // could never be reproduced from the commit it names.
  const tracked = new Set((await git("ls-files")).split("\n").filter(Boolean));
  const untracked = (await payloadPaths(root)).filter((relative) => !tracked.has(relative));
  if (untracked.length > 0) {
    blockers.push(`Payload paths are not committed: ${untracked.join(", ")}`);
  }
  // A committed skill identity that disagrees with the root manifest would ship a
  // `skills add` install naming the wrong release, and the packaged copy is
  // derived from it, so the two could never be reconciled after the fact.
  // Byte equality against a freshly generated stamp is the whole check: it
  // catches a stale version, a hand-edit and a leftover placeholder alike.
  for (const name of await canonicalSkillNames(root)) {
    const committed = await readFile(identityPath(root, name), "utf8").catch(() => null);
    if (committed !== (await identityDocument(root, name))) {
      blockers.push(
        `skills/${name}/${IDENTITY_BASENAME} does not match version ${versions.root}. Run 'pnpm skills:lock' and 'pnpm providers:sync'.`,
      );
    }
  }
  const { contentHash } = await contentHashOf(root);
  return { version: versions.root, commit, contentHash, blockers };
};

const renderIdentityPlaceholders = (content, identity) =>
  content
    .replaceAll(TOOLKIT_VERSION_PLACEHOLDER, identity.version)
    .replaceAll(TOOLKIT_COMMIT_PLACEHOLDER, identity.commit)
    .replaceAll(TOOLKIT_CONTENT_HASH_PLACEHOLDER, identity.contentHash);

export const buildRelease = async ({ root = repositoryRoot, force = false } = {}) => {
  const check = await releaseCheck(root);
  if (check.blockers.length > 0 && !force) {
    throw new Error(`Release is blocked:\n- ${check.blockers.join("\n- ")}`);
  }
  const identity = {
    name: TOOLKIT_NAME,
    version: check.version,
    commit: check.commit,
    contentHash: check.contentHash,
  };
  const stagingRoot = path.join(root, "dist", `${TOOLKIT_NAME}-${identity.version}`);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const payload = await payloadPaths(root);
  for (const relative of payload) {
    const destination = path.join(stagingRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    // The four release placeholders are rendered only here, in the staged copy.
    // The committed provider manifests keep them, which is what keeps the
    // content hash acyclic.
    if (path.posix.basename(relative) === "adapter.json") {
      const rendered = renderIdentityPlaceholders(
        await readFile(path.join(root, relative), "utf8"),
        identity,
      );
      await writeFile(destination, rendered, "utf8");
    } else if (path.posix.basename(relative) === IDENTITY_BASENAME) {
      // Derived from the committed stamp rather than rebuilt, so a packaged skill
      // cannot claim a different name, version or skill than the tree it came
      // from. Commit and content hash are added only here: the committed file
      // feeds `contentHash`, so carrying it would be a cycle.
      const committed = JSON.parse(await readFile(path.join(root, relative), "utf8"));
      const staged = {
        ...committed,
        source: "release",
        commit: identity.commit,
        contentHash: identity.contentHash,
      };
      await writeFile(destination, `${JSON.stringify(staged, null, 2)}\n`, "utf8");
    } else {
      await cp(path.join(root, relative), destination);
    }
  }

  // The engine's identity, read back at runtime by `toolkit-identity.mjs`. It
  // lives beside `src/`, is written only here, and is never committed.
  const identityFile = path.join(stagingRoot, "packages/migration-engine/build-identity.json");
  await writeFile(identityFile, `${JSON.stringify(identity, null, 2)}\n`, "utf8");

  // The one runtime dependency, dereferenced because pnpm's store link is
  // checkout-relative. Package-manager launch shims are build-machine output,
  // not runtime input, and are deliberately excluded at every depth.
  const dependencyTarget = path.join(
    stagingRoot,
    "packages/migration-engine/node_modules/ts-discovery-compiler",
  );
  await mkdir(path.dirname(dependencyTarget), { recursive: true });
  await cp(
    path.join(root, "packages/migration-engine/node_modules/ts-discovery-compiler"),
    dependencyTarget,
    {
      recursive: true,
      dereference: true,
      filter: (source) => !source.split(path.sep).includes(".bin"),
    },
  );

  const staged = {};
  for (const relative of [...payload, "packages/migration-engine/build-identity.json",
    ...(await walk(path.join(stagingRoot, "packages/migration-engine/node_modules"), "", true)).map(relative => `packages/migration-engine/node_modules/${relative}`),
  ].sort()) {
    staged[relative] = `sha256:${sha256(await readFile(path.join(stagingRoot, relative)))}`;
  }
  const engineManifest = await readJson(path.join(root, "packages/migration-engine/package.json"));
  const rootManifest = await readJson(path.join(root, "package.json"));
  const manifest = {
    version: 1,
    toolkit: identity,
    // Toolkit SemVer is an independent axis. These are stated, not derived from
    // the version above, and the version above is not derived from them.
    supports: await supportedMigrationVersions(root),
    requires: {
      node: engineManifest.engines.node,
      packageManager: rootManifest.packageManager,
    },
    skills: await readJson(path.join(root, "skills-lock.json")),
    files: staged,
  };
  await writeFile(
    path.join(stagingRoot, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(stagingRoot, "SHA256SUMS"),
    `${Object.entries(staged)
      .map(([relative, digest]) => `${digest.slice("sha256:".length)}  ${relative}`)
      .join("\n")}\n`,
    "utf8",
  );
  return { identity, stagingRoot, manifest, blockers: check.blockers };
};

/** Build the one GitHub Release asset consumed by the skill bootstrap. */
export const buildReleaseArchive = async (built) => {
  const archive = path.join(
    path.dirname(built.stagingRoot),
    `${TOOLKIT_NAME}-v${built.identity.version}.tar.gz`,
  );
  await rm(archive, { force: true });
  await execFileAsync(
    "tar",
    ["-czf", archive, "-C", path.dirname(built.stagingRoot), path.basename(built.stagingRoot)],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return { archive, digest: `sha256:${sha256(await readFile(archive))}` };
};

/**
 * The supported persisted migration versions, read from the engine rather than
 * restated here. A release manifest that carried its own copy of these numbers
 * would be a second answer to a question the engine already answers.
 */
const supportedMigrationVersions = async (root) => {
  const core = await import(
    pathToFileURL(path.join(root, "packages/migration-engine/src/core.mjs")).href
  );
  const artifact = await import(
    pathToFileURL(path.join(root, "packages/migration-engine/src/artifact/artifact-migration.mjs")).href
  );
  return {
    moduleContract: core.RESUMABLE_CONTRACT_VERSION,
    moduleFormat: core.MIGRATION_FORMAT_VERSION,
    moduleWorkflow: core.WORKFLOW_VERSION,
    artifactContract: artifact.ARTIFACT_CONTRACT_VERSION,
    artifactFormat: artifact.ARTIFACT_FORMAT_VERSION,
    artifactWorkflow: artifact.ARTIFACT_WORKFLOW_VERSION,
  };
};

/** Re-hash a staged bundle against its own manifest. */
export const verifyRelease = async (stagingRoot) => {
  const manifest = await readJson(path.join(stagingRoot, "release-manifest.json"));
  const mismatched = [];
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const actual = `sha256:${sha256(await readFile(path.join(stagingRoot, relative)))}`;
    if (actual !== expected) mismatched.push(relative);
  }
  const identity = await readJson(
    path.join(stagingRoot, "packages/migration-engine/build-identity.json"),
  );
  if (JSON.stringify(identity) !== JSON.stringify(manifest.toolkit)) {
    mismatched.push("packages/migration-engine/build-identity.json (identity disagrees with the manifest)");
  }
  const sums = Object.fromEntries(
    (await readFile(path.join(stagingRoot, "SHA256SUMS"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/);
        return match ? [match[2], `sha256:${match[1]}`] : [line, "invalid"];
      }),
  );
  if (JSON.stringify(sums) !== JSON.stringify(manifest.files)) {
    mismatched.push("SHA256SUMS (disagrees with the manifest)");
  }
  return { toolkit: manifest.toolkit, mismatched, verified: mismatched.length === 0 };
};

const main = async (argv) => {
  if (argv.includes("--check")) {
    const check = await releaseCheck();
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    if (check.blockers.length > 0) process.exitCode = 1;
    return;
  }
  if (argv.includes("--verify")) {
    const target = argv[argv.indexOf("--verify") + 1];
    if (!target) throw new Error("Usage: release.mjs --verify <staged-bundle-directory>");
    const result = await verifyRelease(path.resolve(target));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.verified) process.exitCode = 1;
    return;
  }
  if (argv.includes("--build")) {
    const built = await buildRelease({ force: argv.includes("--allow-dirty") });
    const asset = await buildReleaseArchive(built);
    process.stdout.write(
      `${JSON.stringify({ toolkit: built.identity, stagingRoot: built.stagingRoot, asset, blockers: built.blockers }, null, 2)}\n`,
    );
    return;
  }
  throw new Error("Usage: release.mjs (--check | --build [--allow-dirty] | --verify <directory>)");
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
