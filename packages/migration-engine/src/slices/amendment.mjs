import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SLICE_REWORK_FORMAT, usesSliceRework } from "../formats/index.mjs";
import {
  isLexicallyWithin as isWithin,
  isPlainObject,
  sha256Hex as hashContent,
  withoutExtension,
} from "../shared/index.mjs";
import { fileExists, fileIdentity, readHistoryEvents } from "../store/index.mjs";
import {
  canonicalClaim,
  claimedTargetPaths,
  implementationDigests,
  lexicalTargetPath,
  ownsPath,
  resolveChangedFile,
  TARGET_DIRTY_SCOPE,
  targetRelative,
} from "./claims.mjs";
import { classifyTargetDrift } from "./drift.mjs";

/* --------------------------------------------------------------------------
 * `--amend-slice`: an add-only correction of a reopened slice's `changedFiles`.
 *
 * A reopen returns a verified slice to VERIFY_SLICES because its UI evidence is
 * stale, not because its implementation was wrong. Sometimes re-verifying it
 * reveals that the implementation always depended on files the pinned record
 * never listed. Failing and reworking the slice would be a lie about what
 * happened; re-planning it would discard verified work. An amendment adds the
 * missing files and nothing else: the prior record is preserved byte-pinned,
 * no step or slice moves, and the plan is untouched.
 * ------------------------------------------------------------------------ */

/** Where `--amend-slice` keeps the slice record it replaces, byte-pinned. */
export const SLICE_AMENDMENT_ROOT = "slice-amendments";

// The running engine's own skill root: its source and tests are never slice work.
// Two levels up from slices/, the same directory the lifecycle file resolved
// one level up from src/.
export const ENGINE_SKILL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const TEST_LEVEL_SUFFIX = /\.(?:unit|integration|component)\.spec(\.[^./]+)$/;

export const eventNamesSlice = (event, sliceId) =>
  event.slice === sliceId ||
  (Array.isArray(event.slices) && event.slices.includes(sliceId));

/**
 * `--amend-slice`, first half (Track A4): the refusals over the record and the
 * files to add, against the validated plan the `sliceAmendmentFor` seam
 * supplies. Returns the blocked result, or the draft the seam revalidates as an
 * implementation before `completeSliceAmendment` computes the facts.
 */
export const draftSliceAmendment = async (
  root,
  state,
  roots,
  sliceId,
  addFiles,
  { slices, capabilityRows },
) => {
  const blockers = [];
  const refuse = (message) =>
    blockers.push(`--amend-slice '${sliceId}' ${message}`);
  const blocked = () => ({ blockers, sliceAmendment: null });

  // Lifecycle.
  if (!usesSliceRework(state)) {
    refuse(
      `needs format ${SLICE_REWORK_FORMAT}; this migration is recorded at format ${state.formatVersion}.`,
    );
  }
  if (state.status !== "ACTIVE" || state.currentStep !== "VERIFY_SLICES") {
    refuse(
      `is legal only on an ACTIVE record at VERIFY_SLICES; the record is '${state.status}' at '${state.currentStep}'.`,
    );
  }
  if (!Array.isArray(addFiles) || addFiles.length === 0) {
    refuse("requires at least one --add-file <path>.");
  }
  const planned = slices.find((slice) => slice.id === sliceId);
  if (!planned) refuse("names no planned slice.");
  if (state.completedSlices.includes(sliceId)) {
    refuse(
      "is a verified slice that is not reopened; reopen it with --reopen-ui before amending it.",
    );
  } else if (
    state.activeSlice !== sliceId &&
    !state.pendingSlices.includes(sliceId)
  ) {
    refuse("is neither the active nor a pending slice.");
  }
  const events = await readHistoryEvents(root);
  const reopenedAt = events.findLastIndex(
    (event) =>
      event.event === "UI_REMEDIATION_REOPENED" &&
      eventNamesSlice(event, sliceId),
  );
  if (reopenedAt < 0) {
    refuse(
      "is not pending because of a reopen. A first implementation pass or a rework edits the slice record directly; only a slice reopened by --reopen-ui is amended.",
    );
  } else {
    if (
      events
        .slice(reopenedAt + 1)
        .some(
          (event) =>
            ["REFRESHED", "REOPENED"].includes(event.event) ||
            (eventNamesSlice(event, sliceId) &&
              event.event !== "SLICE_SCOPE_AMENDED"),
        )
    ) {
      refuse(
        "was reverified, reworked or reset after its reopen; amend a reopened slice before it is verified again.",
      );
    }
    if (
      !events
        .slice(0, reopenedAt)
        .some(
          (event) =>
            event.event === "STEP_COMPLETED" &&
            event.step === "VERIFY_SLICES" &&
            event.slice === sliceId,
        )
    ) {
      refuse("has no verified PASS in history before its reopen.");
    }
  }
  const recordRelative = `slices/${sliceId}.json`;
  const recordPath = path.join(root, recordRelative);
  const priorBytes = (await fileExists(recordPath))
    ? await readFile(recordPath)
    : null;
  let prior = null;
  try {
    prior = priorBytes ? JSON.parse(priorBytes.toString("utf8")) : null;
  } catch {
    prior = null;
  }
  if (
    !isPlainObject(prior) ||
    prior.implementationStatus !== "COMPLETE" ||
    !Array.isArray(prior.changedFiles)
  ) {
    refuse(`needs a COMPLETE implementation record at ${recordRelative}.`);
    return blocked();
  }
  if (!state.artifactHashes[recordRelative]) {
    refuse(`needs ${recordRelative} pinned; it is not.`);
  }

  // Files.
  const existing = new Set();
  for (const changed of prior.changedFiles) {
    if (typeof changed === "string") existing.add(await canonicalClaim(changed, roots));
  }
  const recordAuthored = new Set(
    [state.requirementsAuthority?.source, state.brief?.path]
      .filter((value) => typeof value === "string" && value)
      .map((value) => value.replaceAll("\\", "/")),
  );
  const realTarget = await realpath(roots.targetRoot);
  const engineRoot = await realpath(ENGINE_SKILL_ROOT).catch(
    () => ENGINE_SKILL_ROOT,
  );
  const added = [];
  for (const file of addFiles ?? []) {
    // DR4: any accepted spelling names one target file -- as typed when that
    // exists, otherwise through the canonical path math -- and the link and
    // containment checks below run on the file it named.
    let direct = path.resolve(roots.targetRoot, String(file));
    const canonical = lexicalTargetPath(String(file), roots);
    if (!(await fileExists(direct)) && canonical !== null) {
      direct = path.resolve(roots.targetRoot, canonical);
    }
    // Symlinks resolved first, so a link cannot smuggle an outside file in.
    const real = await realpath(direct).catch(() => null);
    if (real && isWithin(engineRoot, real)) {
      refuse(`cannot add '${file}': migration-engine source is never slice work.`);
      continue;
    }
    if (!isWithin(roots.targetRoot, direct) || (real && !isWithin(realTarget, real))) {
      refuse(`cannot add '${file}': it is outside the target repository.`);
      continue;
    }
    if (!real || !(await stat(real)).isFile()) {
      refuse(`cannot add '${file}': it is not an existing regular file.`);
      continue;
    }
    const relative = targetRelative(roots, direct);
    if (TARGET_DIRTY_SCOPE.exclude.some((prefix) => relative.startsWith(prefix))) {
      refuse(`cannot add '${relative}': it is in the migration engine workspace.`);
      continue;
    }
    if (recordAuthored.has(relative)) {
      refuse(
        `cannot add '${relative}': the migration record itself authors it (requirements authority or brief).`,
      );
      continue;
    }
    if (existing.has(relative) || added.includes(relative)) {
      refuse(
        `cannot add '${relative}': it is already in ${sliceId}.changedFiles. An amendment only adds files.`,
      );
      continue;
    }
    added.push(relative);
  }
  if (blockers.length > 0) return blocked();

  // Add-only by construction: the prior list, untouched, then the additions.
  const amended = { ...prior, changedFiles: [...prior.changedFiles, ...added] };
  return {
    blockers,
    refuse,
    blocked,
    slices,
    capabilityRows,
    planned,
    events,
    prior,
    priorBytes,
    added,
    amended,
  };
};

/**
 * `--amend-slice`, second half: the preservation path and the ownership facts
 * the preview shows, for a draft whose amended record validated. `facts` are
 * the census facts drift classification reads.
 */
export const completeSliceAmendment = async (root, state, roots, sliceId, draft, facts) => {
  const {
    blockers,
    refuse,
    blocked,
    slices,
    capabilityRows,
    planned,
    events,
    prior,
    priorBytes,
    added,
    amended,
  } = draft;
  const amendment =
    events.filter(
      (event) =>
        event.event === "SLICE_SCOPE_AMENDED" && event.slice === sliceId,
    ).length + 1;
  const preservesAs = `${SLICE_AMENDMENT_ROOT}/${sliceId}-${amendment}/slice.json`;
  if (await fileExists(path.join(root, preservesAs))) {
    refuse(`cannot preserve to ${preservesAs}: it already exists, and preserved slice records are append-only.`);
    return blocked();
  }

  // Ownership facts for the operator. The engine proves them; it never decides.
  const drift = new Map(
    (await classifyTargetDrift(root, state, roots, slices, facts)).map((finding) => [
      finding.path,
      finding.class,
    ]),
  );
  const otherClaims = [];
  for (const slice of slices) {
    if (slice.id === sliceId) continue;
    otherClaims.push([slice.id, await claimedTargetPaths(root, [slice], roots)]);
  }
  const amendedStems = new Set();
  for (const changed of amended.changedFiles) {
    const resolved =
      typeof changed === "string"
        ? await resolveChangedFile(changed, roots)
        : null;
    if (resolved) amendedStems.add(withoutExtension(targetRelative(roots, resolved)));
  }
  const under = (relative, owner) =>
    ownsPath(lexicalTargetPath(String(owner), roots), relative);
  const add = [];
  for (const relative of added) {
    const testedSource =
      relative.startsWith("tests/") && TEST_LEVEL_SUFFIX.test(relative)
        ? `src/${withoutExtension(relative.slice("tests/".length).replace(TEST_LEVEL_SUFFIX, "$1"))}`
        : null;
    const claimedBy = otherClaims
      .filter(([, claims]) => claims.has(relative))
      .map(([id]) => id);
    add.push({
      path: relative,
      identity: await fileIdentity(path.join(roots.targetRoot, relative)),
      ownershipBasis: (planned.targetPaths ?? []).some((owner) =>
        under(relative, owner),
      )
        ? "TARGET_PATH"
        : capabilityRows.some((row) => row.targetOwner && under(relative, row.targetOwner))
          ? "CAPABILITY_OWNER"
          : testedSource && amendedStems.has(testedSource)
            ? "TEST_OF_OWNED_SOURCE"
            : "OUTSIDE_PLANNED_SCOPE",
      claimedBy,
      driftClass:
        drift.get(relative) ?? (claimedBy.length > 0 ? "CLAIMED" : "NOT_DRIFT"),
    });
  }
  const amendedBytes = `${JSON.stringify(amended, null, 2)}\n`;
  return {
    blockers,
    sliceAmendment: {
      slice: sliceId,
      existingChangedFiles: prior.changedFiles,
      add,
      implementationDigestBefore: (await implementationDigests(prior, roots))
        .current,
      implementationDigestAfter: (await implementationDigests(amended, roots))
        .current,
      sliceRecordDigestBefore: `sha256:${hashContent(priorBytes)}`,
      sliceRecordDigestAfter: `sha256:${hashContent(amendedBytes)}`,
      preservesAs,
      amendment,
    },
    priorBytes,
    amendedBytes,
  };
};
