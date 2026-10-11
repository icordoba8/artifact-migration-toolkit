/** Store: whole-tree snapshot reads and writes for the format upgrader. */

import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "../shared/index.mjs";

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

// DR7 variant: plain writeFile per file; the caller's journal makes it recoverable.
export const writeTree = async (root, files) => {
  for (const relative of Object.keys(files).sort()) {
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, files[relative], "utf8");
  }
};

export const sameManifest = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);
