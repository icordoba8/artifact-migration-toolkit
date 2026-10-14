import { realpath } from "node:fs/promises";
import path from "node:path";
import { TARGET_BASELINE_FILE } from "../formats/index.mjs";
import {
  assertArray,
  assertArray as arrayOf,
  assertNonEmpty,
  assertPlainObject,
  canonicalJson as canonical,
  committedChangesSince,
  commonAncestor,
  dirtyManifest,
  fileAtRevision,
  gitRevision,
  isLexicallyWithin as isWithin,
  normalizeRelative,
  sha256Hex as hashContent,
} from "../shared/index.mjs";
import {
  fileExists,
  fileIdentity,
  hashFile,
  readJson,
  readJsonAt,
  readOptionalJson,
  resolveEvidencePath,
} from "../store/index.mjs";

// The engine's own workspace is excluded from the target dirty manifest: the
// migration tree's authored artifacts are already pinned by `artifactHashes`,
// and the lock/journal files this transaction itself creates live there, so
// including them would invalidate every confirmation the moment it is used.
export const TARGET_DIRTY_SCOPE = {
  exclude: [".agents/knowledge/migrations/"],
};

export const portableRoot = (value) => path.resolve(value).split(path.sep).join("/");

/** One digested entry per dirty path, deduplicated (a rename reports both). */
export const baselineDirtyEntries = (dirty) => {
  const byPath = new Map();
  for (const entry of dirty.entries) {
    if (byPath.has(entry.path)) continue;
    byPath.set(entry.path, {
      path: entry.path,
      digest: entry.sha256 === null ? null : `sha256:${entry.sha256}`,
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
};

/**
 * The immutable pre-migration picture of the target tree: committed history
 * plus every uncommitted path and its bytes.
 *
 * Per-path digests, not `dirtyManifest`'s aggregate: the aggregate answers "did
 * anything change", and the question `changedFiles` asks is "did *this* file
 * change". Both producers are the pair `legacySourceBinding` already trusts for
 * the legacy side, pointed at the target root.
 */
export const renderTargetBaseline = async (targetRoot) => {
  const [revision, dirty] = await Promise.all([
    gitRevision(targetRoot),
    dirtyManifest(targetRoot, TARGET_DIRTY_SCOPE),
  ]);
  return `${JSON.stringify(
    {
      version: 1,
      revision: revision.revision,
      dirty: baselineDirtyEntries(dirty),
    },
    null,
    2,
  )}\n`;
};

export const validateTargetBaselineShape = (baseline) => {
  assertPlainObject(baseline, "Target baseline");
  if (!/^[0-9a-f]{40}$/.test(baseline.revision ?? "")) {
    throw new Error("Target baseline revision must be a full Git SHA-1.");
  }
  for (const [index, entry] of assertArray(
    baseline.dirty,
    "Target baseline dirty",
  ).entries()) {
    const at = `Target baseline dirty[${index}]`;
    assertPlainObject(entry, at);
    assertNonEmpty(entry.path, `${at}.path`);
    if (entry.digest !== null && !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) {
      throw new Error(`${at}.digest must be a SHA-256 digest or null.`);
    }
  }
  return baseline;
};

/**
 * `changed(targetRelativePath)` -- whether this migration, and not whoever was
 * working in the tree before it, is responsible for the file's current bytes.
 *
 * Three cases, and the third is why `revision` is in the baseline at all:
 * currently dirty with the recorded bytes means untouched; recorded dirty but
 * clean now means the pre-existing edit went away; and a file clean at both
 * ends can still have been rewritten by a commit in between.
 */
export const targetBaselineDrift = async (targetRoot, baseline) => {
  const [current, dirty] = await Promise.all([
    gitRevision(targetRoot),
    dirtyManifest(targetRoot, TARGET_DIRTY_SCOPE),
  ]);
  const recorded = new Map(
    baseline.dirty.map((entry) => [entry.path, entry.digest]),
  );
  const now = new Map(
    baselineDirtyEntries(dirty).map((entry) => [entry.path, entry.digest]),
  );
  // Skipped entirely in the common case: the engine's working assumption is
  // that nothing is committed before FINALIZE, so the revision usually holds.
  const committed =
    current.revision === baseline.revision
      ? new Set()
      : await committedChangesSince(targetRoot, baseline.revision);
  return (relativePath) =>
    committed.has(relativePath) ||
    (now.has(relativePath)
      ? now.get(relativePath) !== recorded.get(relativePath)
      : recorded.has(relativePath));
};

/**
 * The pinned baseline of a brownfield record, or null for a greenfield one.
 * Whether the record is brownfield is a census fact its caller supplies.
 */
export const readTargetBaseline = async (root, brownfield) =>
  brownfield
    ? validateTargetBaselineShape(
        await readJson(path.join(root, TARGET_BASELINE_FILE), "Target baseline"),
      )
    : null;

/**
 * The one canonical form ownership comparisons use: target-root-relative,
 * forward slashes. `changedFiles` and every evidence field already accept both
 * `src/x` and `<target-dir>/src/x`, because `resolveEvidencePath` resolves
 * against the common ancestor of the two roots -- so an ownership prefix check
 * that compares raw strings rejects a correctly-built capability over how its
 * path happened to be spelled.
 *
 * Existence-based resolution is deliberately not reused here: `targetOwner`
 * names a directory that does *not* exist yet at BUILD_BASELINE, which is the
 * whole point of a SHARED_PREREQUISITE. So the repository-relative prefix is
 * stripped by path math, and the result is still required to land inside the
 * target root -- which is what rejects `../` traversal and absolute paths.
 */
export const rootRelativePath = (claim, root, siblingRoot, label, repositoryLabel) => {
  const normalized = claim.replace(/\\/g, "/").replace(/^\.\//, "");
  // DR4: trailing separators go, but never the one that makes `/` absolute --
  // stripping it turned the filesystem root into the target root.
  const trimmed = normalized.replace(/(?<=.)\/+$/, "");
  if (!root) return trimmed;
  let candidate = trimmed;
  if (siblingRoot) {
    const prefix = path
      .relative(commonAncestor(siblingRoot, root), root)
      .replaceAll(path.sep, "/");
    if (prefix && !prefix.startsWith("..")) {
      if (candidate === prefix) candidate = "";
      else if (candidate.startsWith(`${prefix}/`)) {
        candidate = candidate.slice(prefix.length + 1);
      }
    }
  }
  const absolute = path.resolve(root, candidate);
  if (!isWithin(root, absolute)) {
    throw new Error(
      `${label} '${claim}' is outside the ${repositoryLabel} repository.`,
    );
  }
  return path.relative(root, absolute).replaceAll(path.sep, "/");
};

export const targetRelativePath = (claim, roots, label) => {
  // DR4: a `..` segment never spells a target path, even one that lands back
  // inside: a traversal is not an ownership spelling, and reading it as one let
  // an owner reach a subtree its spelling never named.
  if (claim.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error(`${label} '${claim}' is outside the target repository.`);
  }
  return rootRelativePath(
    claim,
    roots?.targetRoot,
    roots?.legacyRoot,
    label,
    "target",
  );
};

export const legacyRelativePath = (claim, roots, label) =>
  rootRelativePath(
    claim,
    roots?.legacyRoot,
    roots?.targetRoot,
    label,
    "legacy",
  );

/**
 * A path under the target root in the form Git resolves against it. The `./`
 * prefix is load-bearing: `git show <rev>:<path>` reads a bare path from the
 * repository root, which is not always the target root, whereas `:./<path>`
 * resolves relative to the `-C` directory.
 */
export const repoRelative = (targetRoot, absolute) =>
  `./${path.relative(targetRoot, absolute).replaceAll(path.sep, "/")}`;

/** The first token of a `changedFiles` entry: a v1.3.17 `<path> <identity>` entry reads as its path. */
const claimToken = (changed) => changed.trim().split(/\s+/)[0];

/**
 * DR4. The canonical target path a spelling names by path math alone
 * (`targetRelativePath`), or null when it names nothing inside the target.
 * Files are never consulted, so the answer cannot change with what exists.
 */
export const lexicalTargetPath = (value, roots) => {
  try {
    return targetRelativePath(value, roots, "Path");
  } catch {
    return null;
  }
};

/** A claim spelled by path math alone: the canonical path of its token, or null. */
export const pinnedClaimPath = (changed, roots) =>
  lexicalTargetPath(claimToken(changed), roots);

const resolveToken = async (claim, roots) => {
  const direct = path.resolve(roots.targetRoot, claim);
  return isWithin(roots.targetRoot, direct) && (await fileExists(direct))
    ? direct
    : resolveEvidencePath(claim, roots);
};

/**
 * The existing file one `changedFiles` claim names, inside the target or not,
 * or null: directly under the target first, then through the evidence bases.
 * The implementation gate reads "missing" and "outside" apart from this.
 *
 * DR4: `\` is read as a separator, as every ownership spelling reads it, but
 * only when the token as written names nothing. A spelling that resolved before
 * DR4 therefore still resolves to the same file, and its digest does not move.
 */
export const resolveClaimPath = async (changed, roots) => {
  const claim = claimToken(changed);
  const resolved = await resolveToken(claim, roots);
  return resolved ?? (claim.includes("\\") ? resolveToken(claim.replaceAll("\\", "/"), roots) : null);
};

/**
 * DR4. The target paths a claim's spelling can read as, in `resolveClaimPath`
 * order: the token as written before `\` is read as a separator, and for each,
 * directly under the target, then through the legacy and common-ancestor bases.
 * A reading outside the target is null.
 */
const targetReadings = (changed, roots) => {
  const claim = claimToken(changed);
  const ancestor = roots.legacyRoot ? commonAncestor(roots.legacyRoot, roots.targetRoot) : null;
  const at = (base, token) => {
    if (!base) return null;
    const absolute = path.resolve(base, token);
    return isWithin(base, absolute) && isWithin(roots.targetRoot, absolute)
      ? targetRelative(roots, absolute) || null
      : null;
  };
  return (claim.includes("\\") ? [claim, claim.replaceAll("\\", "/")] : [claim]).map((token) => ({
    direct: at(roots.targetRoot, token),
    legacy: at(roots.legacyRoot, token),
    ancestor: at(ancestor, token),
  }));
};

/**
 * DR4. The existing target files the spelling that resolves can name, read
 * directly and through the target's own prefix. More than one means the
 * spelling is ambiguous (`<target-dir>/src/x` when the target itself holds a
 * `<target-dir>/` directory), and one spelling must name one file.
 */
export const existingClaimReadings = async (changed, roots) => {
  const exists = (relative) =>
    relative ? fileExists(path.join(roots.targetRoot, relative)) : false;
  for (const { direct, legacy, ancestor } of targetReadings(changed, roots)) {
    const named = [...new Set([direct, ancestor])].filter(Boolean);
    const existing = [];
    for (const relative of named) if (await exists(relative)) existing.push(relative);
    if (existing.length > 0 || (await exists(legacy))) return existing;
  }
  return [];
};

/**
 * DR4. The target file a pinned claim named in the commit `revision`, as a
 * canonical path, or null: the first reading that exists in that commit. So a
 * reopened slice's anchored claim is read from the anchored state, whichever
 * accepted spelling the pinned record used, and never from what exists at HEAD.
 */
export const anchoredClaimPath = async (changed, roots, revision) => {
  for (const reading of targetReadings(changed, roots)) {
    for (const relative of [reading.direct, reading.legacy, reading.ancestor]) {
      if (relative && (await fileAtRevision(roots.targetRoot, revision, `./${relative}`))) {
        return relative;
      }
    }
  }
  return null;
};

/**
 * Whether a resolved claim is a target file: inside the target as spelled and
 * once every link is followed, so a link cannot bind a claim (or its digest) to
 * bytes outside the target.
 */
export const isTargetFile = async (resolved, roots) => {
  if (!isWithin(roots.targetRoot, resolved)) return false;
  try {
    return isWithin(await realpath(roots.targetRoot), await realpath(resolved));
  } catch {
    return false;
  }
};

/**
 * DR4. Whether a resolved target file is reached through no link at all, so
 * its own path is the path whose history and bytes it carries.
 */
export const isLinkFree = async (resolved, roots) => {
  try {
    return (
      (await realpath(resolved)) ===
      path.join(await realpath(roots.targetRoot), path.relative(roots.targetRoot, resolved))
    );
  } catch {
    return false;
  }
};

/**
 * The target file one `changedFiles` claim names, or null. Extracted so the
 * amendment resolves a claim exactly as the implementation digest does -- two
 * spellings of "which file is this" is how an amended record ends up disagreeing
 * with the digest that binds it.
 */
export const resolveChangedFile = async (changed, roots) => {
  const resolved = await resolveClaimPath(changed, roots);
  return resolved && (await isTargetFile(resolved, roots)) ? resolved : null;
};

/**
 * The two spellings of one composition. `current` composes file identities;
 * `legacy` composes the raw hashes evidence recorded before tagged identities
 * existed. Both are computed from the same files in the same order, so a
 * record bound to either is still bound to these bytes.
 */

export const implementationDigests = async (record, roots) => {
  const identities = [];
  const legacy = [];
  for (const changed of record.changedFiles) {
    const resolved = await resolveChangedFile(changed, roots);
    if (!resolved) {
      throw new Error(`Cannot bind UI evidence to changed file '${changed}'.`);
    }
    const relative = path
      .relative(roots.targetRoot, resolved)
      .replaceAll(path.sep, "/");
    identities.push([relative, await fileIdentity(resolved)]);
    legacy.push([relative, await hashFile(resolved)]);
  }
  const compose = (rows) =>
    `sha256:${hashContent(JSON.stringify(rows.sort(([a], [b]) => a.localeCompare(b))))}`;
  return { current: compose(identities), legacy: compose(legacy) };
};

/**
 * The target subtrees the plan says this migration owns -- `targetOwner` and
 * `targetPaths`, read off the slice plan, never guessed.
 */
export const plannedTargetOwners = (slices, roots) =>
  targetOwnerPaths(
    slices.flatMap((slice) => [
      slice.targetOwner,
      ...(Array.isArray(slice.targetPaths) ? slice.targetPaths : []),
    ]),
    roots,
  );

/**
 * DR4. Declared owners in the canonical target-relative form (`lexicalTargetPath`):
 * `src/x`, `./src/x/`, `<target-dir>/src/x` and `src\\x` are one owner, and `.`
 * is the target root (`""`). An owner that names nothing inside the target is
 * kept as `null`: it still counts as declared, as it always did, and owns nothing.
 */
export const targetOwnerPaths = (owners, roots) =>
  owners
    .filter((owner) => typeof owner === "string" && owner)
    .map((owner) => lexicalTargetPath(owner, roots));

/** DR4. Whether a canonical path is the owner or inside it: a subtree, never a string prefix. */
export const ownsPath = (owner, relative) =>
  typeof owner === "string" &&
  (owner === "" || relative === owner || relative.startsWith(`${owner}/`));

/**
 * A plan that declares no owners at all cannot answer the ownership question,
 * so every finding stays unclaimed: *unable to tell* is not *outside*, and only
 * one of those may be waved through.
 */
export const withinPlannedScope = (relative, owners) =>
  owners.length === 0 || owners.some((owner) => ownsPath(owner, relative));

/**
 * DR4. One `changedFiles` claim in the canonical target-relative form every
 * ownership comparison uses. An existing file resolves exactly as the
 * implementation digest resolves it, so `target/src/x.ts`, `./src/x.ts` and
 * `src/x.ts` are one claim to every lookup, manual or engine. A missing file
 * (deleted since, or never there) is spelled by the same path math as an
 * owner (`pinnedClaimPath`), so it still reads as the path Git reports. A
 * claim that names nothing inside the target stays as written, which equals
 * no target path. A v1.3.17 `<path> <identity>`
 * entry reads as its path, like any other entry.
 */
export const canonicalClaim = async (changed, roots) => {
  const resolved = roots?.targetRoot ? await resolveChangedFile(changed, roots) : null;
  if (resolved) return targetRelative(roots, resolved);
  return pinnedClaimPath(changed, roots) ?? claimToken(changed).replaceAll("\\", "/");
};

/** Every target path any planned slice claims, in canonical target-relative form. */
export const claimedTargetPaths = async (root, slices, roots) => {
  const claimed = new Set();
  for (const slice of slices) {
    const record = await readOptionalJson(
      path.join(root, `slices/${slice.id}.json`),
      `Slice ${slice.id}`,
    );
    for (const changed of record?.changedFiles ?? []) {
      if (typeof changed !== "string") continue;
      const claim = await canonicalClaim(changed, roots);
      if (claim) claimed.add(claim);
    }
  }
  return claimed;
};

export const targetRelative = (roots, absolute) =>
  path.relative(roots.targetRoot, absolute).replaceAll(path.sep, "/");

// Every file this migration wrote, across every planned slice.
export const migrationChangedFiles = async (root, plan) => {
  const files = new Set();
  for (const id of plan.ids) {
    const document = await readJsonAt(root, `slices/${id}.json`, `slice implementation '${id}'`);
    for (const item of arrayOf(document.changedFiles, `slice '${id}'.changedFiles`)) {
      files.add(normalizeRelative(item.path, `slice '${id}' changed file`));
    }
  }
  return files;
};

export const diffEntries = (before, after) => {
  const left = new Map(before.map((entry) => [entry.path, canonical(entry)]));
  const right = new Map(after.map((entry) => [entry.path, canonical(entry)]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key))
    .sort();
};

export const implementationCoversDrift = (changedFiles, drift) =>
  drift.every((driftPath) =>
    changedFiles.some(
      (changed) =>
        changed === driftPath ||
        changed.startsWith(`${driftPath}/`) ||
        driftPath.startsWith(`${changed}/`),
    ),
  );
