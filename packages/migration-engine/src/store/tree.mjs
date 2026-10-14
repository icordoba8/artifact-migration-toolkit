/** Store: whole-tree snapshot reads and writes for the format upgrader. */

import { constants as fsConstants } from "node:fs";
import { cp, lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "../shared/index.mjs";
import { atomicWrite, mkdirDurably, syncDirectory } from "./files.mjs";

export const entryExists = async (target) => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

export const assertNoSymlink = async (target) => {
  const details = await lstat(target);
  if (details.isSymbolicLink()) {
    throw new Error(`Refusing symlinked migration path: ${target}`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Migration path is not a directory: ${target}`);
  }
};

/** Reads a whole tree as UTF-8 text, rejecting symlinks anywhere inside it. */
export const readTree = async (root) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symlinked migration file: ${absolute}`);
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    files[relative] = await readFile(absolute, "utf8");
  }
  return files;
};

export const manifestOf = (files) =>
  Object.keys(files)
    .sort()
    .map((relative) => {
      const buffer = Buffer.from(files[relative], "utf8");
      return { path: relative, bytes: buffer.byteLength, sha256: sha256Hex(buffer) };
    });

/**
 * DR7: a staged tree, not a transaction of its own. Each file is the store
 * replace-write, contained in `root` and keeping a plain file's default mode;
 * then every directory of the tree is fsynced, deepest first, so the caller's
 * journalled rename commits durable entries. The commit and its recovery stay
 * the caller's.
 */
export const writeTree = async (root, files) => {
  await mkdirDurably(root);
  const directories = new Set([path.resolve(root)]);
  for (const relative of Object.keys(files).sort()) {
    const destination = path.join(root, ...relative.split("/"));
    await atomicWrite(root, destination, files[relative], { mode: 0o666 });
    for (let directory = path.dirname(path.resolve(destination)); !directories.has(directory); directory = path.dirname(directory)) {
      directories.add(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
};

/**
 * DR7: `cp -R` whose result is durable before the caller commits or journals
 * it: every copied file, then every directory deepest first and finally the
 * parent that names the copy, is fsynced.
 * Bytes, modes and layout are `cp`'s. Windows has no directory fsync, so there
 * the copy is only as durable as `cp` leaves it.
 */
export const copyTree = async (from, to) => {
  await mkdirDurably(path.dirname(to));
  await cp(from, to, { recursive: true });
  if (process.platform === "win32") return;
  const directories = [path.resolve(to), path.dirname(path.resolve(to))];
  for (const entry of await readdir(to, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isDirectory()) directories.push(absolute);
    if (!entry.isFile()) continue;
    const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
};

export const sameManifest = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);
