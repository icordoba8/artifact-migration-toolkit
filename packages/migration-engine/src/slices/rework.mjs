import { readFile } from "node:fs/promises";
import path from "node:path";

import { MAX_SLICE_REWORKS, SLICE_REWORK_FORMAT, usesSliceRework } from "../formats/index.mjs";
import {
  assertArray,
  assertNonEmpty,
  assertPlainObject,
  now,
  sha256Hex as hashContent,
} from "../shared/index.mjs";
import {
  assertEvidenceReference,
  evidencePathClaim,
  fileExists,
  resolveEvidencePath,
} from "../store/index.mjs";

/* ------------------------------------------------------------------ *
 * W3. Controlled same-slice rework at VERIFY_SLICES (format 16)
 *
 * A slice that fails verification for a real defect had no legal way back to
 * implementation: `FAIL` was unrepresentable, `expectedNextCheckpoint` offered
 * no same-slice return, and `slices/<id>.json` was hash-pinned once
 * IMPLEMENT_SLICES closed. The remaining options were all bad -- author a false
 * PASS, abandon the migration, or `--refresh --confirm-mismatch`, which the
 * protocol explicitly forbids for a target-side cause.
 *
 * Modelled structurally on `--reopen-ui`: operator-only, refused under
 * `--mode auto`, refused by `run-migration.mjs`, preview-gated, journalled, and
 * it writes a record of *why* the reopen happened.
 *
 * The ordering below is the whole safety property. The failed attempt is
 * preserved byte-for-byte and pinned BEFORE the mutable current-result path is
 * released for rewriting, in one transaction, so there is no reachable state in
 * which the evidence that caused a rework has been freed before it was kept.
 * ------------------------------------------------------------------ */

export const REWORK_ROOT = "rework";

export const reworkLimitBlocker = (sliceId) =>
  `Slice '${sliceId}' has already been reworked ${MAX_SLICE_REWORKS} times. A slice that cannot be verified in ${MAX_SLICE_REWORKS} attempts is a planning defect, not an implementation one: reopen PLAN or split the slice rather than attempting it again.`;

export const REWORK_PATH = /^rework\/(.+)-(\d+)\/(.+)$/;

/** `rework/<slice-id>-<n>/...` -> its slice and attempt, or null. */
export const reworkPathParts = (relativePath) => {
  const match = REWORK_PATH.exec(relativePath);
  return match
    ? { sliceId: match[1], attempt: Number(match[2]), file: match[3] }
    : null;
};

export const reworkAttemptsOf = (state, sliceId) =>
  Number.isInteger(state?.sliceReworks?.[sliceId])
    ? state.sliceReworks[sliceId]
    : 0;

/**
 * Where a defect's evidence is preserved. The claim path is kept intact under
 * `evidence/` so provenance survives and two defects naming different files can
 * never collide.
 */
export const preservedEvidencePath = (sliceId, attempt, claim) => {
  const normalized = claim.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.length === 0
  ) {
    throw new Error(
      `A defect evidenceReference must be a repository-relative path; received '${claim}'.`,
    );
  }
  return `${REWORK_ROOT}/${sliceId}-${attempt}/evidence/${normalized}`;
};

/**
 * W3-1. A `FAIL` is only legal when it is as evidenced as a `PASS`: every
 * defect names what was expected, what was observed, the scenario or trace it
 * belongs to, and a real file whose current bytes hash to what it claims --
 * the same `assertEvidenceReference` rule the FINALIZE gates use.
 *
 * `inspectSliceArtifacts` continues to treat only `PASS` as verified, so a
 * `FAIL` never counts toward completion no matter how well evidenced it is.
 */
export const validateFailedSliceResult = async (root, sliceId, evidence, roots) => {
  if (evidence.sliceId !== sliceId) {
    throw new Error(
      `Evidence for ${sliceId} records sliceId '${evidence.sliceId}'.`,
    );
  }
  if (evidence.result !== "FAIL") {
    throw new Error(
      `--rework-slice requires a recorded FAIL for '${sliceId}'; evidence/${sliceId}/result.json records '${evidence.result}'. A slice is reworked because verification found a defect, never because the agent wants another attempt.`,
    );
  }
  const defects = assertArray(evidence.defects, `${sliceId} evidence defects`);
  if (defects.length === 0) {
    throw new Error(
      `${sliceId} evidence records FAIL with no defects[]. A failure with no named defect is not evidence of anything; nothing was written.`,
    );
  }
  const claims = [];
  for (const [index, defect] of defects.entries()) {
    const label = `${sliceId} evidence defects[${index}]`;
    assertPlainObject(defect, label);
    if (!defect.traceId && !defect.scenarioId) {
      throw new Error(`${label} requires a traceId or a scenarioId.`);
    }
    assertNonEmpty(defect.observed, `${label}.observed`);
    assertNonEmpty(defect.expected, `${label}.expected`);
    assertNonEmpty(defect.evidenceReference, `${label}.evidenceReference`);
    await assertEvidenceReference(
      { reference: defect.evidenceReference, hash: defect.hash },
      label,
      roots,
      { require: true },
    );
    claims.push(evidencePathClaim(defect.evidenceReference));
  }
  return { defects, claims };
};

/**
 * W3-2, everything the operator transition decides before the transaction:
 * the refusals, then the failed attempt and every file its defects name
 * preserved under `rework/<slice>-<n>/`, their pins, the attempt record, and
 * the state that releases the slice back to IMPLEMENT_SLICES. Nothing is
 * written here; `reworkSliceUnderLock` journals and writes it (Track A4).
 */
export const planSliceRework = async ({ root, state, sliceId, roots, canonical }) => {
  if (!usesSliceRework(state)) {
    throw new Error(
      `--rework-slice needs format ${SLICE_REWORK_FORMAT}; migration '${canonical}' is recorded at format ${state.formatVersion}. A record runs the lifecycle it was born under.`,
    );
  }
  if (state.currentStep !== "VERIFY_SLICES") {
    throw new Error(
      `--rework-slice is legal only at VERIFY_SLICES; the current checkpoint is '${state.currentStep}'.`,
    );
  }
  if (state.activeSlice !== sliceId) {
    throw new Error(
      `--rework-slice names '${sliceId}', but the active slice is '${state.activeSlice ?? "none"}'. Only the slice currently under verification can be reworked.`,
    );
  }

  const resultRelative = `evidence/${sliceId}/result.json`;
  const resultPath = path.join(root, resultRelative);
  if (!(await fileExists(resultPath))) {
    throw new Error(
      `--rework-slice requires a recorded verification result at ${resultRelative}; none exists. Nothing was written.`,
    );
  }
  // Raw bytes, read once and preserved unchanged. No parse-and-reserialize:
  // key order, whitespace and line endings are part of what was recorded.
  const preservedBytes = await readFile(resultPath);
  const evidence = assertPlainObject(
    JSON.parse(preservedBytes.toString("utf8")),
    `Evidence for ${sliceId}`,
  );
  const { defects, claims } = await validateFailedSliceResult(
    root,
    sliceId,
    evidence,
    roots,
  );

  const attempt = reworkAttemptsOf(state, sliceId) + 1;
  // The preview reports this as a BLOCKED outcome naming the slice; this is the
  // backstop for a caller that reached the lock without one.
  if (attempt > MAX_SLICE_REWORKS) {
    throw new Error(reworkLimitBlocker(sliceId));
  }
  const directory = `${REWORK_ROOT}/${sliceId}-${attempt}`;
  if (await fileExists(path.join(root, directory))) {
    throw new Error(
      `${directory} already exists. Rework attempts are append-only and an attempt number is never reused; nothing was written.`,
    );
  }

  // Every file the transaction writes, built completely before anything lands.
  const writes = [[`${directory}/result.json`, preservedBytes]];
  for (const [index, claim] of claims.entries()) {
    const source = await resolveEvidencePath(claim, roots);
    if (!source) {
      throw new Error(
        `${sliceId} evidence defects[${index}].evidenceReference names '${claim}', which no longer resolves. Nothing was written.`,
      );
    }
    writes.push([
      preservedEvidencePath(sliceId, attempt, claim),
      await readFile(source),
    ]);
  }
  // Bare hex, the same shape every other `artifactHashes` pin uses, so the
  // standard completed-hash validation covers these without a special case.
  const preserved = {};
  for (const [relative, bytes] of writes) {
    preserved[relative] = hashContent(bytes);
  }
  const recordRelative = `${directory}/record.json`;
  const record = `${JSON.stringify(
    {
      version: 1,
      sliceId,
      attempt,
      at: now(),
      operator: `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`,
      // Metadata *about* the preserved bytes. It never stands in for them.
      priorEvidenceDigest: `sha256:${hashContent(preservedBytes)}`,
      priorRevision: state.revision,
      defects: defects.map((defect) => ({
        traceId: defect.traceId ?? null,
        scenarioId: defect.scenarioId ?? null,
        observed: defect.observed,
        expected: defect.expected,
        evidenceReference: defect.evidenceReference,
        hash: defect.hash,
      })),
      preserved,
    },
    null,
    2,
  )}\n`;
  writes.push([recordRelative, Buffer.from(record, "utf8")]);
  preserved[recordRelative] = hashContent(record);

  const artifactHashes = { ...state.artifactHashes, ...preserved };
  // Released only now, and only after every preserved path is in the pin set.
  delete artifactHashes[`slices/${sliceId}.json`];
  delete artifactHashes[resultRelative];

  const reworked = {
    ...state,
    status: "ACTIVE",
    currentStep: "IMPLEMENT_SLICES",
    activeSlice: sliceId,
    completedSteps: state.completedSteps.filter(
      (step) => !["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"].includes(step),
    ),
    completedSlices: state.completedSlices.filter((id) => id !== sliceId),
    pendingSlices: [...new Set([sliceId, ...state.pendingSlices])],
    sliceReworks: { ...(state.sliceReworks ?? {}), [sliceId]: attempt },
    invalidatedArtifacts: [`slices/${sliceId}.json`, resultRelative],
    evidenceFreshness: "STALE",
    nextAction: `Fix the ${defects.length} recorded defect(s) in slice '${sliceId}', then reverify it. Attempt ${attempt} of ${MAX_SLICE_REWORKS}.`,
    nextCommand: `/start-migration ${canonical}`,
    artifactHashes,
    revision: state.revision + 1,
    updatedAt: now(),
  };
  const event = {
    event: "SLICE_REWORKED",
    from: "VERIFY_SLICES",
    step: "IMPLEMENT_SLICES",
    slice: sliceId,
    attempt,
    defects: defects.length,
    preserved: Object.keys(preserved).sort(),
    revision: reworked.revision,
  };
  return { writes, reworked, event };
};
