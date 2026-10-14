/** Store: durable file primitives -- reads, pins, the replace-write and the attested append. */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  assertSecurePath,
  contentIdentity,
  contentIdentityMatches,
  isLexicallyWithin,
} from "../shared/index.mjs";

// DR7 variant: secure path, temp file cleaned up on error, fsync, rename.
export const atomicWrite = async (targetRoot, destination, content) => {
  const absoluteDestination = await assertSecurePath(targetRoot, destination);
  const parent = path.dirname(absoluteDestination);
  await mkdir(parent, { recursive: true });
  await assertSecurePath(targetRoot, absoluteDestination);

  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, absoluteDestination);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
};

/** `contentIdentity` for a file on disk, read through the safe-path reader. */
export const fileContentIdentity = async (root, relativePath, options) => {
  const absolute = await assertSecurePath(
    root,
    path.resolve(root, relativePath),
  );
  return contentIdentity(relativePath, await readFile(absolute), options);
};

/** `contentIdentityMatches` for a file on disk, via the same safe reader. */
export const fileContentIdentityMatches = async (
  recorded,
  root,
  relativePath,
  options,
) => {
  const absolute = await assertSecurePath(
    root,
    path.resolve(root, relativePath),
  );
  return contentIdentityMatches(
    recorded,
    relativePath,
    await readFile(absolute),
    options,
  );
};

export const fileExists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

export const readJson = async (filePath, label) => {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${filePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
};

export const hashFile = async (filePath) =>
  createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

/**
 * The two ordinary-file-pin primitives. Everything that pins *a file* goes
 * through these; `hashFile` stays exactly where a raw-byte preimage is the
 * point (confirmation snapshots, transaction stateHash, approval candidates,
 * decision subjects, preserved bytes).
 */
export const fileIdentity = async (filePath, options) =>
  contentIdentity(filePath, await readFile(filePath), options);

export const fileIdentityMatches = async (recorded, filePath, options) =>
  contentIdentityMatches(recorded, filePath, await readFile(filePath), options);

/** `fileIdentityMatches` against a target-relative source, or false if absent. */
export const contentIdentityMatchesSource = async (recorded, targetRoot, source) => {
  const filePath = path.resolve(targetRoot, source);
  if (!isLexicallyWithin(targetRoot, filePath)) return false;
  return fileIdentityMatches(recorded, filePath).catch(() => false);
};

export const readOptionalJson = async (filePath, label) => {
  if (!(await fileExists(filePath))) return null;
  return readJson(filePath, label);
};

export const removeEmptyParents = async (start, boundary) => {
  let current = path.resolve(start);
  const limit = path.resolve(boundary);
  while (current !== limit && isLexicallyWithin(limit, current)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) return;
      throw error;
    }
    current = path.dirname(current);
  }
};

// DR8 variant: O_APPEND, then fsync of the file and (off Windows) its directory.
export const appendDurably = async (targetRoot, file, text, onBoundary) => {
  await assertSecurePath(targetRoot, file);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    await onBoundary("during-append", { writePrefix: (length) => handle.write(bytes, 0, length) });
    for (let offset = 0; offset < bytes.length;) {
      offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
    }
    await onBoundary("after-append");
    await handle.sync();
    await onBoundary("after-fsync");
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(file), fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
};
