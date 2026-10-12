import { readFile } from "node:fs/promises";
import path from "node:path";
import { usesArtifactDirectLedger, VISUAL_ACCEPTANCE_FORMAT } from "../formats/index.mjs";
import {
  assertPlainObject as plainObject,
  exactObject,
  normalizeRelative,
} from "../shared/index.mjs";
import { readJsonAt, secureHash } from "../store/index.mjs";
import {
  compareVisualEvidence,
  compareVisualFact,
  validateVisualAcceptance,
} from "./acceptance.mjs";
import { TARGET_VERIFICATION_ROLE, visualAuthorityOf } from "./authority.mjs";
import {
  compareStructuredTarget,
  structuredCapabilityProfile,
} from "./evidence.mjs";

// The visual evidence adapter retains the existing format-17 evidence checks.
export const strictVisualState = (state) => ({
  ...state,
  formatVersion: VISUAL_ACCEPTANCE_FORMAT,
  migrationId: state.artifactId,
  // The same source-binding projection `artifactDecisionBoundTo` uses: an
  // artifact record's legacy revision lives on its source binding, and the
  // legacy-runtime authority is bound to it exactly as a module record's is.
  legacyRevision: { revision: state.bindings?.source?.revision },
});

/** This record's pinned visual authority, or null under `target-system`. */
export const artifactVisualAuthority = (state) =>
  visualAuthorityOf(strictVisualState(state));

/**
 * The behaviors the shared validators read as the discovered UI inventory.
 * `legacy-runtime` frames are bound to a discovered behavior state exactly as
 * the module engine binds them, so both engines feed the same shape in.
 */
export const artifactUiInventory = (source) => ({
  uiBehaviors: source.document.behaviors
    .filter((row) => row.visible)
    .map((row) => ({
      id: row.id,
      runtimeStates: row.runtimeStates,
      conditional: false,
    })),
});

/**
 * The artifact engine's format-17 acceptance: the shared module validator over
 * the strict artifact projection. Under the format-14 direct ledger an unbacked
 * state passes only when its current decision row, read by the artifact seam
 * and passed in as `decisions`, projects APPROVED_APPLICABLE.
 */
export const validateArtifactVisualAcceptance = async (root, state, source, decisions) =>
  validateVisualAcceptance(
    root,
    strictVisualState(state),
    artifactUiInventory(source),
    { uiMismatches: [] },
    undefined,
    usesArtifactDirectLedger(state.formatVersion) ? { resolveUnbacked: (item, label) => {
      const decision = decisions.find((row) => row.subject === `${item.uiBehaviorId}::${item.state}`);
      if (decision?.projection.state !== "APPROVED_APPLICABLE") {
        throw new Error(decision?.projection.reason ?? `${label} has no current artifact decision candidate.`);
      }
    } } : undefined,
  );

export const validateArtifactVisualEvidence = async (root, state, row, visualRow, label, nativeRows) => {
  const authority = artifactVisualAuthority(state);
  const fail = (problem) => {
    throw new Error(
      `VISUAL_ACCEPTANCE_FAIL: ${label} (${visualRow.id}, Figma node ${visualRow[authority.rowFrameKey]}) ${problem}.`,
    );
  };
  const key = (value) => authority.normalizeFrameKey(value);
  if (key(row[authority.recordFrameKey]) !== key(visualRow[authority.rowFrameKey])) {
    fail(`names ${authority.recordFrameKey} '${row[authority.recordFrameKey]}'`);
  }
  // P5: the artifact engine's TARGET rows are the same lifecycle slot as the
  // module engine's, so a block that declares the authority's role is refused.
  if (row.capture?.role !== undefined && row.capture.role !== TARGET_VERIFICATION_ROLE) {
    fail(`declares capture.role '${row.capture.role}', not ${TARGET_VERIFICATION_ROLE}`);
  }
  const expectedViewport = `${visualRow.viewport.width}x${visualRow.viewport.height}`;
  if (`${row.viewport.width}x${row.viewport.height}` !== expectedViewport) {
    fail(`ran at viewport ${row.viewport.width}x${row.viewport.height}, the contract requires ${expectedViewport}`);
  }
  exactObject(row.measurements, `${label}.measurements`, ["path", "sha256"], ["pointer"]);
  const measurementPath = normalizeRelative(row.measurements.path, `${label}.measurements.path`);
  if (!measurementPath.startsWith(`evidence/${state.activeSlice}/ui/`)) {
    fail("measurements are not persisted under the active slice evidence/ui directory");
  }
  if ((await secureHash(root, measurementPath, `${label}.measurements.path`)) !== row.measurements.sha256) {
    fail("measurement evidence is missing, stale, or tampered");
  }
  let observation;
  try {
    const document = JSON.parse(await readFile(path.join(root, measurementPath), "utf8"));
    observation = row.measurements.pointer === undefined
      ? document
      : document?.[row.measurements.pointer];
  } catch (error) {
    fail(`references measurements that are not JSON (${error.message})`);
  }
  if (!plainObject(observation, `${label}.measurements observation`) ||
      !(visualRow.nodes ? plainObject(observation.nodes, `${label}.measurements nodes`) :
        plainObject(observation.values, `${label}.measurements values`))) {
    fail(`references measurements without a "${visualRow.nodes ? "nodes" : "values"}" object`);
  }
  if (`${observation.viewport?.width}x${observation.viewport?.height}` !== expectedViewport) {
    fail(`was measured by Playwright at viewport ${observation.viewport?.width}x${observation.viewport?.height}, the contract requires ${expectedViewport}`);
  }
  const failures = visualRow.nodes
    ? compareStructuredTarget(visualRow.nodes, observation, compareVisualFact, visualRow.tolerance)
    : Object.entries(visualRow.expect).flatMap(([name, fact]) => {
      const miss = compareVisualFact(fact, observation.values[name], visualRow.tolerance);
      return miss ? [`${name} ${miss}`] : [];
    });
  if (failures.length > 0) fail(`diverges from the design: ${failures.join("; ")}`);
  if (visualRow.version !== 2) return null;
  const frame = visualRow.authorityFrame;
  const screenshot = row.artifacts.find((item) => item.kind === "SCREENSHOT");
  const snapshot = row.artifacts.find((item) => item.kind === "ACCESSIBILITY_SNAPSHOT");
  const targetProof = state.designSource === "legacy-runtime"
    ? await readJsonAt(root, snapshot.path, "TARGET accessibility snapshot")
    : null;
  if (targetProof && targetProof.proofFormat !== "playwright-ui-proof/v1") {
    throw new Error(`VISUAL_STRUCTURE_DIVERGENCE: ${label} TARGET snapshot is not playwright-ui-proof/v1`);
  }
  const comparison = await compareVisualEvidence({
    visualRow,
    targetCapture: row.capture,
    authority: state.designSource,
    targetReference: screenshot.path,
    readAuthorityPng: () => readFile(path.join(root, frame.sources.screenshot.reference)),
    readTargetPng: () => readFile(path.join(root, screenshot.path)),
    readAuthorityControls: async () => {
      const proof = await readJsonAt(root, frame.sources.snapshot.reference, "legacy authority snapshot");
      if (proof.proofFormat !== "playwright-ui-proof/v1" || !Array.isArray(proof.observation?.controls)) {
        fail("authority snapshot is not scoped playwright-ui-proof/v1 controls");
      }
      return proof.observation.controls;
    },
    targetControls: targetProof?.observation?.controls,
    nativeRows,
  });
  return visualRow.nodes ? { ...comparison,
    capability: structuredCapabilityProfile(frame.structuredAuthority.nodes, true) } : comparison;
};
