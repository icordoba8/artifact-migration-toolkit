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
  if (!root) return normalized.replace(/\/+$/, "");
  let candidate = normalized.replace(/\/+$/, "");
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

export const targetRelativePath = (claim, roots, label) =>
  rootRelativePath(
    claim,
    roots?.targetRoot,
    roots?.legacyRoot,
    label,
    "target",
  );

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

/**
 * The two spellings of one composition. `current` composes file identities;
 * `legacy` composes the raw hashes evidence recorded before tagged identities
 * existed. Both are computed from the same files in the same order, so a
 * record bound to either is still bound to these bytes.
 */
/**
 * The target file one `changedFiles` claim names, or null. Extracted so the
 * amendment resolves a claim exactly as the implementation digest does -- two
 * spellings of "which file is this" is how an amended record ends up disagreeing
 * with the digest that binds it.
 */
export const resolveChangedFile = async (changed, roots) => {
  const claim = changed.trim().split(/\s+/)[0];
  const direct = path.resolve(roots.targetRoot, claim);
  const resolved =
    isWithin(roots.targetRoot, direct) && (await fileExists(direct))
      ? direct
      : await resolveEvidencePath(claim, roots);
  return resolved && isWithin(roots.targetRoot, resolved) ? resolved : null;
};

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
export const plannedTargetOwners = (slices) =>
  slices
    .flatMap((slice) => [
      slice.targetOwner,
      ...(Array.isArray(slice.targetPaths) ? slice.targetPaths : []),
    ])
    .filter((owner) => typeof owner === "string" && owner)
    .map((owner) => owner.replaceAll("\\", "/").replace(/\/+$/, ""));

/**
 * A plan that declares no owners at all cannot answer the ownership question,
 * so every finding stays unclaimed: *unable to tell* is not *outside*, and only
 * one of those may be waved through.
 */
export const withinPlannedScope = (relative, owners) =>
  owners.length === 0 ||
  owners.some((owner) => relative === owner || relative.startsWith(`${owner}/`));

/**
 * One `changedFiles` claim in canonical target-relative form, resolved exactly
 * as the implementation digest resolves it -- so `target/src/x.ts` and
 * `src/x.ts` are one claim to every lookup, manual or engine. A v1.3.17
 * `<path> <identity>` entry reads as its path, like any other entry.
 */
export const canonicalClaim = async (changed, roots) => {
  const resolved = roots?.targetRoot ? await resolveChangedFile(changed, roots) : null;
  return resolved
    ? targetRelative(roots, resolved)
    : changed.trim().split(/\s+/)[0].replaceAll("\\", "/");
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
