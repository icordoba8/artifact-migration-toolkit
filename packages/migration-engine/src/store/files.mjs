/** Store: durable file primitives -- reads, pins, the one replace-write (DR7) and the one durable append (DR8). */

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

/**
 * Makes a directory's entries durable: on POSIX a create or rename is only
 * crash-safe once its directory is fsynced, and any failure to do so throws --
 * a write is never reported durable when it is not. Windows cannot open a
 * directory for it, so there it is skipped.
 */
export const syncDirectory = async (directory) => {
  if (process.platform === "win32") return;
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * `mkdir -p` whose new entries are durable: the parent of every directory it
 * created is fsynced, deepest first, so a journal or record written into a new
 * directory cannot lose its path to a power loss. An existing path is a no-op.
 */
export const mkdirDurably = async (directory) => {
  const first = await mkdir(directory, { recursive: true });
  if (first === undefined) return;
  for (let created = path.resolve(directory); ; created = path.dirname(created)) {
    await syncDirectory(path.dirname(created));
    if (created === path.resolve(first)) return;
  }
};

/** A rename made durable in both directories it changes. */
export const renameDurably = async (from, to) => {
  await rename(from, to);
  await syncDirectory(path.dirname(path.resolve(to)));
  if (path.dirname(path.resolve(from)) !== path.dirname(path.resolve(to))) {
    await syncDirectory(path.dirname(path.resolve(from)));
  }
};

/**
 * DR7: the one replace-write. Every whole-file replacement goes through here:
 * the path is checked before and after its parent is (durably) created, the bytes go to
 * an exclusive temp file beside the destination that is fsynced and renamed
 * over it, and the directory is fsynced after the rename. A reader or a crash
 * sees the old bytes or the new ones, never a mix, and a failure removes the
 * temp file. A replaced file takes `mode` (operator-only unless the caller
 * keeps a plain file's default).
 */
export const atomicWrite = async (targetRoot, destination, content, { mode = 0o600 } = {}) => {
  const absoluteDestination = await assertSecurePath(targetRoot, destination);
  const parent = path.dirname(absoluteDestination);
  await mkdirDurably(parent);
  await assertSecurePath(targetRoot, absoluteDestination);

  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
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
  await syncDirectory(parent);
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

/**
 * DR8: the one durable append. Every append-only record goes through here: the
 * path is checked before and after its parent is (durably) created, the file is opened
 * O_APPEND | O_NOFOLLOW (operator-only when it is created), the bytes are
 * written in order without reading or rewriting anything before them, and the
 * file then its directory are fsynced. `onBoundary` is the crash-injection
 * seam of the attested decision append; it can only throw.
 */
export const appendDurably = async (targetRoot, file, text, onBoundary = async () => {}) => {
  const absolute = await assertSecurePath(targetRoot, file);
  await mkdirDurably(path.dirname(absolute));
  await assertSecurePath(targetRoot, absolute);
  const handle = await open(absolute, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
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
  await syncDirectory(path.dirname(absolute));
};
