#!/usr/bin/env node

/**
 * Version stamp for the two canonical skills.
 *
 * Adapted from the consumer's `scripts/agents-sync/skills-lock.mjs`. The
 * consumer's lock was mixed: three externally sourced entries recording where
 * they came from, plus these two recording what they currently are. Only the
 * two first-party entries move here, so the file has one meaning again and no
 * `source`/`sourceType` discriminator is needed to read it.
 *
 * What it is NOT is engine identity. A skill hash covers `skills/<name>/**` and
 * nothing else; the engine package is hashed separately at release time. The
 * two were never the same number and a lock that pretended otherwise would go
 * stale on every engine change that left the protocol alone.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const lockPath = (root) => path.join(root, "skills-lock.json");

export const IDENTITY_BASENAME = "release-identity.json";

export const identityPath = (root, skillName) =>
  path.join(root, "skills", skillName, IDENTITY_BASENAME);

/**
 * The committed half of an installed skill's identity.
 *
 * `skills add` copies the *committed* tree, so every field here has to be a real
 * value. A placeholder would install as the literal `{{TOOLKIT_VERSION}}` and the
 * installed skill would name no release at all -- which is why the version is
 * read from the root manifest rather than restated here, a second copy of it
 * being exactly the drift this file exists to remove.
 *
 * `version` *selects* a candidate release; `computedHash` *proves* that the
 * release carries the skill semantics actually installed. Version equality alone
 * never establishes compatibility: `skills add <repo>` installs current `main`
 * under an already-published version string, so the digest is the only field
 * that distinguishes those bytes from the published ones. It is the release
 * binding, and it is acyclic because `computeSkillHash` excludes this file.
 *
 * Commit and content hash are *absent*, not placeheld, and have to be: the commit
 * containing this file, and the hash this file feeds, are both unknowable while
 * writing it. `scripts/release.mjs` adds them to the staged copy only, which is
 * what keeps the release content hash acyclic. `source` is what lets an operator
 * tell the two apart in an installed tree without running the engine, and what
 * says whether commit/contentHash are also part of the binding.
 */
export const identityDocument = async (root, skillName) => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  return `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      skill: skillName,
      computedHash: await computeSkillHash(root, skillName),
      source: "repository",
    },
    null,
    2,
  )}\n`;
};

/** Install output, never canonical source; under pnpm it is symlinks too. */
const walk = async (absolute, relative = "") => {
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(absolute, entry.name), child)));
    } else {
      files.push(child);
    }
  }
  return files;
};

export const canonicalSkillNames = async (root = repositoryRoot) =>
  (await readdir(path.join(root, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/**
 * Path and bytes both feed the digest: renaming a file has to change the hash as
 * surely as editing one does, or a downstream target comparing one string would
 * miss a moved reference.
 *
 * `release-identity.json` is the one exclusion, and it is what makes the digest
 * usable as the stamp's own release binding: the stamp carries the hash, so the
 * hash cannot cover the stamp. What remains is exactly skill semantics --
 * `SKILL.md`, `references/**`, `scripts/runtime.mjs` -- which is this file's
 * stated subject anyway. The deliberate consequence is that a release touching
 * only the engine leaves the digest stable, and that is correct: the skill
 * semantics really are identical, and the version in the stamp still forces the
 * engine to be the one the skill names.
 */
export const computeSkillHash = async (root, skillName) => {
  const skillRoot = path.join(root, "skills", skillName);
  const digest = createHash("sha256");
  for (const relative of (await walk(skillRoot)).sort()) {
    if (relative === IDENTITY_BASENAME) continue;
    digest.update(relative);
    digest.update("\0");
    digest.update(await readFile(path.join(skillRoot, relative)));
    digest.update("\0");
  }
  return digest.digest("hex");
};

export const skillLockEntries = async (root = repositoryRoot) =>
  Object.fromEntries(
    await Promise.all(
      (await canonicalSkillNames(root)).map(async (name) => [
        name,
        {
          skillPath: `skills/${name}`,
          computedHash: await computeSkillHash(root, name),
        },
      ]),
    ),
  );

export const writeSkillsLock = async (root = repositoryRoot) => {
  // Order-independent: the stamp is not an input to its own digest, so writing
  // it before or after the lock produces the same two numbers. Both are read
  // from the same `computeSkillHash`, so the lock and every stamp agree by
  // construction rather than by sequencing.
  for (const name of await canonicalSkillNames(root)) {
    await writeFile(identityPath(root, name), await identityDocument(root, name));
  }
  const lock = { version: 1, skills: await skillLockEntries(root) };
  await writeFile(lockPath(root), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const lock = await writeSkillsLock();
  console.log(
    `Updated release-identity.json and skills-lock.json for ${Object.keys(lock.skills).join(", ")}.`,
  );
}
