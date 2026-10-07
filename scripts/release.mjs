#!/usr/bin/env node

/**
 * Release identity and the staged, checksum-verifiable release bundle.
 *
 * Four commands, one hash:
 *
 *   --check   releasability gate: clean tree, versions and committed skill
 *             stamps agree, published version identity is not reused. Writes nothing.
 *   --build   stage `dist/<name>-<version>/` from the *committed* tree, inject
 *             `build-identity.json`, render the provider manifests' release
 *             placeholders, and write `release-manifest.json` + `SHA256SUMS`.
 *   --verify  re-hash a staged bundle against its own manifest.
 *   --record  establish a version only from its verified published manifest.
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
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveRelease, downloadAsset, verifyDownloadedAsset } from "./runtime-bootstrap.mjs";

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

const RELEASED_VERSIONS = "released-versions.json";
const exactVersion = (value) => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const validContentHash = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

const releasedVersions = async (root) => {
  const rows = await readJson(path.join(root, RELEASED_VERSIONS)).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const versions = new Set();
  if (!Array.isArray(rows) || rows.some((row) => {
    if (!row || Object.keys(row).sort().join(",") !== "contentHash,version" ||
        !exactVersion(row.version) || !validContentHash(row.contentHash) || versions.has(row.version)) return true;
    versions.add(row.version);
    return false;
  })) throw new Error(`Invalid ${RELEASED_VERSIONS}`);
  return rows;
};

/** Record publication evidence, never a local candidate's identity. */
export const recordRelease = async (version, {
  root = repositoryRoot,
  resolve = resolveRelease,
  download = downloadAsset,
  runTar = execFileAsync,
} = {}) => {
  if (!exactVersion(version)) throw new Error("release:record requires one exact X.Y.Z version");
  const resolved = await resolve(version);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "amt-release-record-"));
  try {
    if (resolved.version !== version || resolved.asset.name !== `${TOOLKIT_NAME}-v${version}.tar.gz`) {
      throw new Error("Resolved release does not match the requested version/asset");
    }
    const archive = path.join(scratch, resolved.asset.name);
    await download(resolved, archive);
    await verifyDownloadedAsset(archive, resolved.asset.digest);

    const tarOptions = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
    const { stdout: listing } = await runTar("tar", ["-tzf", archive], tarOptions);
    const entries = listing.trimEnd().split(/\r?\n/);
    if (entries.some((entry) => {
      const name = entry.replace(/\/$/, "");
      return !name || path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === "..");
    })) throw new Error("Unsafe or empty release archive");
    const member = `${TOOLKIT_NAME}-${version}/release-manifest.json`;
    if (entries.filter((entry) => entry === member).length !== 1) {
      throw new Error("Release archive must contain exactly one release-manifest.json member");
    }
    const { stdout: details } = await runTar("tar", ["-tvzf", archive, "--", member], tarOptions);
    const types = details.trimEnd().split(/\r?\n/);
    if (types.length !== 1 || !types[0].startsWith("-") || !types[0].endsWith(` ${member}`)) {
      throw new Error("Release manifest must be one regular file");
    }
    const { stdout } = await runTar("tar", ["-xOzf", archive, "--", member], tarOptions);
    const { toolkit } = JSON.parse(stdout);
    if (toolkit?.version !== version || toolkit?.name !== TOOLKIT_NAME ||
        toolkit?.commit !== resolved.commit || !validContentHash(toolkit?.contentHash)) {
      throw new Error("Published manifest toolkit version, name, commit or contentHash is invalid");
    }
    const rows = await releasedVersions(root);
    const established = rows.find((row) => row.version === version);
    if (established) {
      if (established.contentHash !== toolkit.contentHash) {
        throw new Error(`Version ${version} is already established with a different contentHash; registry unchanged`);
      }
      return established;
    }
    const row = { version, contentHash: toolkit.contentHash };
    rows.push(row);
    rows.sort((a, b) => a.version.localeCompare(b.version, "en", { numeric: true }));
    await writeFile(path.join(root, RELEASED_VERSIONS), `${JSON.stringify(rows, null, 2)}\n`);
    return row;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

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
  // The staged stamp is `{...committed, source, commit, contentHash}` and the
  // manifest's `skills` document is `skills-lock.json` verbatim, so comparing
  // the committed stamp against the lock here is the same assertion the bundle
  // would carry -- a release can never ship a stamp and a manifest that
  // disagree about the same skill's digest, which is the binding selection
  // relies on.
  const lock = await readJson(path.join(root, "skills-lock.json")).catch(() => null);
  for (const name of await canonicalSkillNames(root)) {
    const committed = await readFile(identityPath(root, name), "utf8").catch(() => null);
    if (committed !== (await identityDocument(root, name))) {
      blockers.push(
        `skills/${name}/${IDENTITY_BASENAME} does not match version ${versions.root}. Run 'pnpm skills:lock' and 'pnpm providers:sync'.`,
      );
    }
    // Parsed defensively: this function collects every blocker rather than
    // throwing one, so an unreadable stamp has to report as a mismatch like any
    // other, not escape the gate.
    let stamped = null;
    try { stamped = JSON.parse(committed).computedHash ?? null; } catch { stamped = null; }
    const locked = lock?.skills?.[name]?.computedHash;
    if (stamped !== locked) {
      blockers.push(
        `skills/${name}/${IDENTITY_BASENAME} computedHash ${stamped} does not match skills-lock.json ${locked}. Run 'pnpm skills:lock' and 'pnpm providers:sync'.`,
      );
    }
  }
  // A runtime format with no adjacent upgrader is a bundle that can read a
  // record it can never move. Collected like every other blocker so one run
  // reports it, and re-asserted (throwing) at manifest time.
  await engineFormatUpgrades(root).catch((error) => blockers.push(error.message));
  const { contentHash } = await contentHashOf(root);
  const established = (await releasedVersions(root)).find((row) => row.version === versions.root);
  const versionConflict = established && established.contentHash !== contentHash
    ? `Version ${versions.root} is already established with contentHash ${established.contentHash}. This build's payload bytes hash to ${contentHash} and cannot claim it — bump the version.`
    : null;
  if (versionConflict) blockers.push(versionConflict);
  return { version: versions.root, commit, contentHash, blockers, versionConflict };
};

const renderIdentityPlaceholders = (content, identity) =>
  content
    .replaceAll(TOOLKIT_VERSION_PLACEHOLDER, identity.version)
    .replaceAll(TOOLKIT_COMMIT_PLACEHOLDER, identity.commit)
    .replaceAll(TOOLKIT_CONTENT_HASH_PLACEHOLDER, identity.contentHash);

export const buildRelease = async ({ root = repositoryRoot, force = false } = {}) => {
  const check = await releaseCheck(root);
  if (check.versionConflict || (check.blockers.length > 0 && !force)) {
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

  // Every declared runtime dependency, dereferenced because pnpm's store link
  // is checkout-relative. Package-manager launch shims are build-machine
  // output, not runtime input, and are deliberately excluded at every depth.
  // Read from the manifest rather than named here, so adding a dependency
  // cannot ship a bundle that fails to resolve it at runtime.
  // The full transitive closure: pnpm's isolated layout keeps a dependency's
  // own dependencies beside it in the store, not under it. Placed as Node will
  // resolve them: top level first, nested under the dependent only when the
  // name it would find there is another version.
  const resolveFrom = async (from, name) => {
    for (let directory = from; ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, "node_modules", name);
      try { return await realpath(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (path.dirname(directory) === directory) throw new Error(`Cannot resolve runtime dependency '${name}' from ${from}.`);
    }
  };
  const placed = new Map();
  const visibleFrom = (installed, name) => {
    for (let parent = installed; parent; parent = parent.includes("/node_modules/") ? parent.slice(0, parent.lastIndexOf("/node_modules/")) : null) {
      const nested = `${parent}/node_modules/${name}`;
      if (placed.has(nested)) return nested;
    }
    return placed.has(name) ? name : null;
  };
  const queue = Object.keys(
    (await readJson(path.join(root, "packages/migration-engine/package.json"))).dependencies ?? {},
  ).map((name) => [name, path.join(root, "packages/migration-engine"), null]);
  while (queue.length > 0) {
    const [name, from, parent] = queue.shift();
    const directory = await resolveFrom(from, name);
    const visible = parent ? visibleFrom(parent, name) : (placed.has(name) ? name : null);
    if (visible && placed.get(visible) === directory) continue;
    const installed = !placed.has(name) ? name : parent ? `${parent}/node_modules/${name}` : null;
    if (!installed || placed.has(installed)) throw new Error(`Runtime dependency '${name}' cannot be staged without a resolution conflict.`);
    placed.set(installed, directory);
    for (const next of Object.keys((await readJson(path.join(directory, "package.json"))).dependencies ?? {})) {
      queue.push([next, directory, installed]);
    }
  }
  for (const [dependency, source] of placed) {
    const dependencyTarget = path.join(
      stagingRoot,
      "packages/migration-engine/node_modules",
      dependency,
    );
    await mkdir(path.dirname(dependencyTarget), { recursive: true });
    await cp(
      source,
      dependencyTarget,
      {
        recursive: true,
        dereference: true,
        // Type declarations and source maps are build-time output, except
        // TypeScript's default libs (lib.*.d.ts): the pinned tsc fallback reads them.
        filter: (source) => !source.split(path.sep).includes(".bin") &&
          (!/\.(d\.ts|map)$/.test(path.basename(source)) || /^lib(\..+)?\.d\.ts$/.test(path.basename(source))),
      },
    );
  }

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
  // Normalized ownership: the published asset must not carry the builder's account.
  await execFileAsync(
    "tar",
    ["--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", path.dirname(built.stagingRoot), path.basename(built.stagingRoot)],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return { archive, digest: `sha256:${sha256(await readFile(archive))}` };
};

/**
 * The supported persisted migration versions, read from the engine rather than
 * restated here. A release manifest that carried its own copy of these numbers
 * would be a second answer to a question the engine already answers.
 *
 * The format-upgrade gate runs here, for both engines, because this is where
 * both engines are already loaded and it is strictly before the manifest that
 * would otherwise advertise a format nothing can upgrade into. Only
 * `{floor, runtimeFormat, registry}` is consulted: a format declared
 * self-healing, promoting or featureful buys no pass.
 */
export const supportedMigrationVersions = async (root = repositoryRoot) => {
  const { core, artifact } = await engineFormatUpgrades(root);
  return {
    moduleContract: core.RESUMABLE_CONTRACT_VERSION,
    // The format new records are created at. Deliberately not the supported
    // ceiling: a consumer reading this to decide what it will be handed wants
    // the activation control, and the two are stated separately below.
    moduleFormat: core.FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
    moduleFormatSupported: core.MIGRATION_FORMAT_SUPPORTED,
    moduleWorkflow: core.WORKFLOW_VERSION,
    formatUpgradeFloor: core.FORMAT_UPGRADE_FLOOR,
    formatUpgraders: releaseUpgraders(core.FORMAT_UPGRADERS),
    artifactContract: artifact.ARTIFACT_CONTRACT_VERSION,
    artifactFormat: artifact.ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
    artifactFormatSupported: artifact.ARTIFACT_FORMAT_SUPPORTED,
    artifactWorkflow: artifact.ARTIFACT_WORKFLOW_VERSION,
    artifactFormatUpgradeFloor: artifact.ARTIFACT_FORMAT_UPGRADE_FLOOR,
    artifactFormatUpgraders: releaseUpgraders(artifact.ARTIFACT_FORMAT_UPGRADERS),
  };
};

/**
 * Inspectable upgrade identity, and nothing else. `domain`, `plan`, `commit`
 * and `requiredInput` are engine internals -- functions and record paths -- so
 * they are deliberately not serialized: a manifest states which increments a
 * bundle can walk, not how.
 */
const releaseUpgraders = (registry) =>
  registry.map(({ from, to, id, version }) => ({ from, to, id, version }));

/**
 * Both engines' registries, gated. Exported so the release-safety tests call
 * exactly what the release calls.
 */
export const engineFormatUpgrades = async (root = repositoryRoot) => {
  const core = await import(
    pathToFileURL(path.join(root, "packages/migration-engine/src/core.mjs")).href
  );
  const artifact = await import(
    pathToFileURL(path.join(root, "packages/migration-engine/src/artifact/artifact-migration.mjs")).href
  );
  const { assertRegistryCoverage } = await import(
    pathToFileURL(path.join(root, "packages/migration-engine/src/format-upgrade.mjs")).href
  );
  assertRegistryCoverage({
    // The *supported* ceiling, not the creation default: a release may ship a
    // format it can read and explicitly move a record to while new records
    // keep being created at the active one, and every increment up to the
    // ceiling still needs its registered upgrader.
    floor: core.FORMAT_UPGRADE_FLOOR,
    runtimeFormat: core.MIGRATION_FORMAT_SUPPORTED,
    registry: core.FORMAT_UPGRADERS,
  });
  assertRegistryCoverage({
    floor: artifact.ARTIFACT_FORMAT_UPGRADE_FLOOR,
    runtimeFormat: artifact.ARTIFACT_FORMAT_VERSION,
    registry: artifact.ARTIFACT_FORMAT_UPGRADERS,
  });
  return { core, artifact };
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
  if (argv[0] === "--record") {
    if (argv.length !== 2) throw new Error("Usage: release.mjs --record <version>");
    process.stdout.write(`${JSON.stringify(await recordRelease(argv[1]), null, 2)}\n`);
    return;
  }
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
  throw new Error("Usage: release.mjs (--check | --build [--allow-dirty] | --verify <directory> | --record <version>)");
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
