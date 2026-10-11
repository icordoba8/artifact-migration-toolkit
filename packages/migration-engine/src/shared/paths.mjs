/** Shared: path spelling, comparison and containment primitives. */

import { lstat, stat } from "node:fs/promises";
import path from "node:path";

import { assertNonEmpty } from "./values.mjs";

export const portablePath = (value) => value.replaceAll(path.sep, "/");

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export const samePath = (left, right) =>
  comparablePath(left) === comparablePath(right);

export const isLexicallyWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

// Exported (candidate change): Fix C (true append-only history) reuses this
// symlink/containment guard directly instead of going through atomicWrite's
// temp-file+rename path, which does not apply to an O_APPEND write.
export const assertSecurePath = async (root, candidate) => {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const rootDetails = await lstat(absoluteRoot);
  if (rootDetails.isSymbolicLink()) {
    throw new Error(`Refusing symlink output path: ${absoluteRoot}`);
  }
  if (!isLexicallyWithin(absoluteRoot, absoluteCandidate)) {
    throw new Error(
      `Output path escapes the target repository: ${absoluteCandidate}`,
    );
  }

  const relative = path.relative(absoluteRoot, absoluteCandidate);
  let current = absoluteRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        throw new Error(`Refusing symlink output path: ${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return absoluteCandidate;
};

/**
 * The registry binding may only be persisted into a package.json that belongs
 * to the migration itself. `projectRootFor` walks up from the CWD, so without
 * this an invocation from an unrelated directory writes its binding into a
 * stranger's package.json -- and, because the registry is not below that root,
 * persists a machine-specific absolute path.
 *
 * The root is required, never defaulted. It used to fall back to the engine's
 * own installation, which is the consumer's project root only when the engine
 * happens to live inside the consumer; `resolveRegistryPath` returns the one
 * every caller already passes.
 */
export const assertProjectRootContainment = (projectRoot, registryData) => {
  const { targetRoot } = registryData;
  if (typeof projectRoot !== "string" || !projectRoot) {
    throw new Error(
      "A project root is required to persist the migration registry binding. Resolve one with resolveRegistryPath and pass it explicitly.",
    );
  }
  if (
    !isLexicallyWithin(targetRoot, projectRoot) &&
    !isLexicallyWithin(projectRoot, targetRoot)
  ) {
    throw new Error(
      `Refusing to write the migration registry binding into an unrelated project at '${projectRoot}': it neither contains nor lives inside the registry target root '${targetRoot}'. Run the command from that target repository with --registry <path> on first setup, or set config.startMigration.registry in that project's package.json.`,
    );
  }
  return projectRoot;
};

/** A record-relative, forward-slash path, for the two P4 root comparisons. */
export const recordRelative = (root, absolute) =>
  path.relative(root, absolute).split(path.sep).join("/");

export const isResolvedWithin = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const commonAncestor = (left, right) => {
  let current = path.resolve(left);
  while (!isResolvedWithin(current, path.resolve(right))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
};

export const withoutExtension = (relative) => relative.replace(/\.[^./]+$/, "");

export const sameFile = async (left, right) => {
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

export const normalizeRelative = (value, label) => {
  const raw = assertNonEmpty(value, label).replaceAll("\\", "/");
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`${label} must be relative to its declared root.`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} escapes its declared root.`);
  }
  return normalized === "" ? "." : normalized;
};
