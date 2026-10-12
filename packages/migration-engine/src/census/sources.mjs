import path from "node:path";
import { usesMultiSource } from "../formats/index.mjs";
import { assertSafeName, dirtyManifest, gitRevision } from "../shared/index.mjs";
import { fileExists } from "../store/index.mjs";

/** Declared legacy sources, as the one reader every format may call. */
export const legacySourcesOf = (state) =>
  state?.legacySources ?? (state?.legacyModule ? [state.legacyModule] : []);

/**
 * Whether the target was already substantially implemented when the record was
 * created. Every format below 15 is greenfield by omission, exactly as every
 * format below 14 is `target-system` by omission.
 */
export const isBrownfield = (state) =>
  usesMultiSource(state) && state?.targetAdoption?.mode === "BROWNFIELD";

/**
 * The sources are bootstrap-fixed, exactly like the design source. Without this
 * a resume that names a different `--legacy` set would be silently ignored and
 * the operator would believe a source had been added.
 */
export const assertLegacySourcesUnchanged = (state, legacySources) => {
  if (legacySources.length === 0) return;
  const recorded = legacySourcesOf(state);
  if (JSON.stringify(legacySources) !== JSON.stringify(recorded)) {
    throw new Error(
      `Legacy sources ${JSON.stringify(legacySources)} conflict with the recorded sources ${JSON.stringify(recorded)}. The source set is fixed for the migration's lifetime; start a new migration to change it.`,
    );
  }
};

/**
 * The exact legacy bytes an approval or a confirmation was shown.
 *
 * `legacyRevision` alone is a commit, so an uncommitted edit slips underneath
 * it; the dirty manifest alone repeats itself once that edit is committed and
 * the file leaves the dirty set. The pair identifies one working tree, which is
 * what "the source the operator approved" means.
 */
export const legacySourceBinding = async (legacyRoot) => {
  const [revision, dirty] = await Promise.all([
    gitRevision(legacyRoot),
    dirtyManifest(legacyRoot),
  ]);
  return { legacyRevision: revision.revision, legacyDirtyDigest: dirty.digest };
};

/** `src/features/<module>/` -- the one place a SHARED_PREREQUISITE may not live. */
export const featureLocalPrefix = (targetModule) => `src/features/${targetModule}/`;

/** Takes an already-canonical target-relative path from `targetRelativePath`. */
export const isUnderFeature = (normalized, targetModule) => {
  const prefix = featureLocalPrefix(targetModule);
  return normalized === prefix.slice(0, -1) || normalized.startsWith(prefix);
};

/** Where a target feature slice lives, and the only path adoption asserts on. */
export const targetFeatureDirectory = (targetRoot, targetModule) =>
  path.join(targetRoot, "src/features", targetModule);

/**
 * The inverse of the greenfield check, and the guard that would have stopped a
 * record being aimed at a module beside the real one: `--adopt-target` claims
 * the target already exists, so refuse to bootstrap when it does not.
 */
export const brownfieldTargetBlocker = async (
  targetRoot,
  { adoptTarget, targetModule },
) =>
  adoptTarget &&
  !(await fileExists(targetFeatureDirectory(targetRoot, targetModule)))
    ? `--adopt-target declares an existing implementation, but 'src/features/${targetModule}/' does not exist in the target repository. Nothing was written.`
    : null;

/**
 * A direct twin of `resolveDesignSource` for `--legacy`: a repeatable flag
 * normalized into the persisted array, shared by the bootstrap and the
 * read-only preview so both agree on what gets pinned.
 *
 * Ordering is derived, never operator-controlled. `--legacy b --legacy a` and
 * `--legacy a --legacy b` must produce byte-identical state, because state
 * feeds the confirmation-ID snapshot; sorting here is what makes that true, and
 * it means nobody has to decide which source is "first".
 */
export const resolveLegacySources = (legacy) => {
  const names = Array.isArray(legacy) ? legacy : legacy ? [legacy] : [];
  for (const name of names) assertSafeName(name, "legacy source");
  return [...new Set(names)].sort();
};
