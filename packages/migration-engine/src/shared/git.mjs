/** Shared: read-only git queries (revisions, dirty manifests, history walks). */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { portablePath } from "./paths.mjs";

export const execFileAsync = promisify(execFile);

// Fix A (candidate change; see analysis/inventory.md Defect #1 / Part B
// mechanism #7): the original `gitRevision` ran `git -C <root> rev-parse
// HEAD`, which returns the whole repository's HEAD regardless of which
// subdirectory `root` points at. If legacy and target are two subtrees of one
// shared Git repository, any commit anywhere in that repo -- including the
// migration's own target-side implementation commits -- changed what the
// legacy side considered "current" and tripped a false `legacyRevisionChanged`
// blocker on the very next preflight.
//
// The fix scopes the revision to commits that actually touched files under
// `root`: `git -C <root> log -1 --format=%H -- .`. A brand-new directory with
// no commits touching it yet has nothing to scope to, so this falls back to
// `git -C <root> rev-parse HEAD` and reports that fallback explicitly via
// `pathScoped: false`, rather than silently pretending the reading is
// path-scoped when it is not.
export const gitRevision = async (root) => {
  let logResult;
  try {
    logResult = await execFileAsync(
      "git",
      ["-C", root, "log", "-1", "--format=%H", "--", "."],
      { encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(`Cannot read Git revision for '${root}': ${error.message}`);
  }
  const scopedRevision = logResult.stdout.trim();
  if (scopedRevision) {
    return { revision: scopedRevision, pathScoped: true };
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    return { revision: stdout.trim(), pathScoped: false };
  } catch (error) {
    throw new Error(`Cannot read Git revision for '${root}': ${error.message}`);
  }
};

/**
 * Deterministic digest of everything Git reports as dirty under `root`,
 * including the bytes of each dirty file.
 *
 * `gitRevision` only sees committed history, so a preview bound to it
 * authorizes a snapshot that uncommitted edits can change underneath the
 * confirmation. This closes that hole: tracked modifications, staged changes,
 * untracked files, deletions, and renames all participate, and each surviving
 * path contributes its content hash so re-editing an already-dirty file also
 * invalidates the confirmation.
 *
 * ponytail: hashes only the paths Git already flagged, so cost scales with the
 * dirty set, not the tree. Upgrade path: a full-tree manifest if a workflow
 * ever needs to detect changes Git cannot see (e.g. ignored files).
 */
export const dirtyManifest = async (root, { exclude = [] } = {}) => {
  let stdout;
  let repoRoot;
  let base;
  try {
    // `root` reaches us however the caller spelled it, and on Windows that is
    // routinely an 8.3 short path (`C:\Users\RUNNER~1\...`) while Git always
    // answers with the canonical long one. Two spellings of the same directory
    // make `path.relative` below produce a `..\..`-style path that matches none
    // of the caller's `exclude` prefixes -- the migration's own writes stop
    // being excluded, so the dirty digest moves under the toolkit's own feet
    // and every already-issued confirmation reads as stale. One canonical form
    // for both sides is the whole fix.
    base = await realpath(root);
    // `--porcelain` always prints repository-root-relative paths, so the
    // repository root -- not `root` -- is the base they must be resolved from.
    const top = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    // Through the same canonicalization as `base`, so the two are always
    // comparable: resolving only one side would invent a mismatch on any
    // symlinked checkout that has none today.
    repoRoot = await realpath(top.stdout.trim());
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-uall", "--", "."],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(`Cannot read Git status for '${root}': ${error.message}`);
  }
  const entries = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    // Rename/copy entries are "XY old -> new"; both sides matter.
    const paths = line
      .slice(3)
      .split(" -> ")
      .map((value) => value.replace(/^"|"$/g, ""));
    for (const relative of paths) {
      const absolute = path.resolve(repoRoot, relative);
      const portable = portablePath(path.relative(base, absolute));
      if (exclude.some((prefix) => portable.startsWith(prefix))) continue;
      let digest = null;
      try {
        digest = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
      }
      entries.push({ status, path: portable, sha256: digest });
    }
  }
  entries.sort((left, right) =>
    left.path === right.path
      ? left.status.localeCompare(right.status)
      : left.path.localeCompare(right.path),
  );
  return {
    entries,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
};

/**
 * Paths under `root` that committed history changed since `revision`, relative
 * to `root`. The axis a dirty-set comparison misses entirely: a file that was
 * clean when the migration started and is clean now can still have been
 * rewritten by a commit in between.
 *
 * Fails loudly rather than reporting "no drift" -- an adoption claim that
 * cannot be checked against its baseline is not a claim that holds.
 */
export const committedChangesSince = async (root, revision) => {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "diff",
        "--name-only",
        "--relative",
        revision,
        "HEAD",
        "--",
        ".",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(
      `Cannot compare '${root}' against baseline revision '${revision}': ${error.message}`,
    );
  }
  return new Set(
    stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  );
};

/**
 * The tip commit of `root`'s repository. `gitRevision` is path-scoped and may
 * report an older commit; a reopen anchor must be the tip, because only the tip
 * is guaranteed to be an ancestor of every later HEAD.
 */
export const headRevision = async (root) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(`Cannot read Git HEAD for '${root}': ${error.message}`);
  }
};

/**
 * Bytes of `relativePath` as of `revision`, or null when the path did not exist
 * there. Distinguishing "absent at that commit" from "git failed" is the whole
 * point: an ownership claim that cannot be read is never silently accepted.
 */
export const fileAtRevision = async (root, revision, relativePath) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "show", `${revision}:${relativePath}`],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
};

/** Whether `ancestor` is reachable from `descendant` in `root`'s history. */
export const isAncestorCommit = async (root, ancestor, descendant) => {
  try {
    await execFileAsync(
      "git",
      ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant],
      { encoding: "utf8" },
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Commits after `revision` that touched `relativePath`, newest first. Recorded
 * as the provenance of post-anchor drift so a reopened slice never absorbs
 * authorship of work committed after the state it was proven against.
 */
export const commitsTouchingSince = async (root, revision, relativePath) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "log",
        "--format=%H",
        `${revision}..HEAD`,
        "--",
        relativePath,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(
      `Cannot list commits touching '${relativePath}' since '${revision}' in '${root}': ${error.message}`,
    );
  }
};

/**
 * Commits that introduced exactly `blobHash` at `relativePath`, oldest first.
 *
 * Legacy reopen compatibility: a record written before reopens carried an
 * explicit anchor has to resolve one from its pinned preserved evidence. The
 * defensible anchor is the commit where those exact bytes *originated*, not
 * merely the newest commit that still carries an unchanged blob -- so this
 * reports every origin and lets the caller fail closed when there is not
 * exactly one.
 */
export const commitsIntroducingBlob = async (root, relativePath, blobHash) => {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "log",
        "--format=%H",
        "--follow",
        "--diff-filter=AM",
        "--",
        relativePath,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(
      `Cannot trace history of '${relativePath}' in '${root}': ${error.message}`,
    );
  }
  const commits = stdout.split("\n").map((v) => v.trim()).filter(Boolean);
  const origins = [];
  for (const commit of commits) {
    const bytes = await fileAtRevision(root, commit, relativePath);
    if (!bytes) continue;
    if (createHash("sha256").update(bytes).digest("hex") !== blobHash) continue;
    // An origin is a commit carrying the bytes whose parent did not.
    const parent = await fileAtRevision(root, `${commit}^`, relativePath);
    const parentHash = parent
      ? createHash("sha256").update(parent).digest("hex")
      : null;
    if (parentHash !== blobHash) origins.push(commit);
  }
  return origins;
};
