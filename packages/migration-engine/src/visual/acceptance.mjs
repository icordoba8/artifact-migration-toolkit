import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createDecisionCandidate,
  createNewFormatDecisionCandidate,
  readRecordedDecisions,
  requireModuleDecision,
} from "../decisions/index.mjs";
import {
  FIGMA_CONTEXT_ADOPTION_FILE,
  FIGMA_CONTEXT_FILE,
  LEGACY_RUNTIME_CONTEXT_FILE,
  usesDirectLedgerDecisions,
  usesVisualAcceptance,
  VISUAL_ACCEPTANCE_FILE,
  VISUAL_ACCEPTANCE_FORMAT,
} from "../formats/index.mjs";
import {
  assertArray,
  assertNonEmpty,
  assertPlainObject,
  assertUniqueIds,
  isPlainObject,
} from "../shared/index.mjs";
import {
  assertEvidenceReference,
  evidencePathClaim,
  fileExists,
  hashFile,
  readJson,
  resolveEvidencePath,
} from "../store/index.mjs";
import {
  assertTargetEvidencePath,
  assertVisualCaptureBlock,
  frameKeyOf,
  hardenedVisual,
  visualAuthorityOf,
} from "./authority.mjs";
import {
  compareStructuredTarget,
  decodePng,
  FIXED_VISUAL_TOLERANCE,
  HARDENED_VISUAL_VERSION,
  missingRequiredGroups,
  normalizeVisualValue,
  perceptualDelta,
  REQUIRED_FACT_KINDS,
  structuralDelta,
  structuredCapabilityProfile,
  validateStructuredContract,
} from "./evidence.mjs";
import { uiBehaviorIsRequired } from "./observations.mjs";

/** The operator decision kind that alone can leave a required visual state unbacked. */
export const VISUAL_UNBACKED_KIND = "VISUAL_UNBACKED";

/** The contract digest a VISUAL_UNBACKED decision binds, minus its own citations. */
const visualContractDigest = (matrix) =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        ...matrix,
        unbacked: (matrix.unbacked ?? []).map((item) => {
          if (!isPlainObject(item)) return item;
          const { decisionId, decisionDigest, ...rest } = item;
          return rest;
        }),
      }),
    )
    .digest("hex")}`;

/**
 * One persisted frame as the operator reads it, in its own authority's terms.
 * The text is hashed into the candidate id: the figma-mcp wording is frozen
 * (changing it re-asks every operator), and I5's legacy-runtime correction
 * deliberately invalidated approvals of the old "Figma evidence" text.
 */
const describeFrame = (state, frame) => {
  const legacy = visualAuthorityOf(state).contextFile === LEGACY_RUNTIME_CONTEXT_FILE;
  const [source, id] = legacy
    ? ["legacy runtime", `frame ${frame.key} at legacy revision ${frame.legacyRevision}`]
    : ["Figma", `node ${frame.key} '${frame.name}'`];
  return frame.extraction.fidelity === "COMPLETE"
    ? `${legacy ? "Legacy runtime" : "Figma"} evidence: ${id} ${frame.viewport.width}x${frame.viewport.height}, COMPLETE, states: ${frame.states.join(" | ")}`
    : `DEGRADED ${source} evidence, fidelity not established: ${id} (${frame.extraction.limitations.join("; ")})`;
};

/**
 * One `unbacked` entry as an operator decision candidate. Shared by validation
 * and `record-decision.mjs`, so the candidate the operator approves is exactly
 * the one FINALIZE re-derives. The engine never judges whether a frame designs
 * the state -- that is the operator's call, so the rationale lists every
 * persisted frame, and every DEGRADED limitation, the operator decides against.
 */
const visualUnbackedCandidate = ({ state, frames, matrix, contextDigest, item }) => ({
  candidate: createDecisionCandidate({
      kind: VISUAL_UNBACKED_KIND,
      subjectType: "VISUAL_STATE",
      subjectPath: `${item.uiBehaviorId}::${item.state}`,
      rationale: [
        String(item.reason ?? ""),
        ...[...frames.values()].map((frame) => describeFrame(state, frame)),
      ].join("\n"),
      boundTo: {
        module: state.migrationId,
        figmaSources: (state.figmaSources ?? [])
          .map((source) => `${source.fileKey}#${source.nodeId ?? "*"}`)
          .sort(),
        // The same slot under both authorities, named by the adapter: what the
        // operator approved is bound to the exact authority bytes it saw.
        [visualAuthorityOf(state).boundToDigestField]: contextDigest,
        visualContractDigest: visualContractDigest(matrix),
      },
    }),
});

/** Whether an explicit backed row already binds this behavior state to Figma. */
const backedRowFor = (matrix, item) =>
  (Array.isArray(matrix.rows) ? matrix.rows : []).find(
    (row) =>
      row?.uiBehaviorId === item.uiBehaviorId && row?.state === item.state,
  );

/**
 * The VISUAL_UNBACKED candidates an operator may approve. Exported for
 * `record-decision.mjs`, which owns every approval; nothing here records.
 * During adoption the fresh context is read as format 17 would read it.
 */
export const pendingVisualUnbackedCandidates = async (root, state, legacy) => {
  const authority = visualAuthorityOf(state);
  if (!authority) return [];
  // `--adopt-visual-contract` is a Figma-only migration path (a pre-17 record
  // adopting format-17 Figma evidence); no legacy-runtime record can predate
  // its own authority, so the adoption file is read only for that origin.
  const adopting =
    !usesVisualAcceptance(state) &&
    authority.contextFile === FIGMA_CONTEXT_FILE &&
    (await fileExists(path.join(root, FIGMA_CONTEXT_ADOPTION_FILE)));
  if (!usesVisualAcceptance(state) && !adopting) return [];
  const contextFile = adopting
    ? FIGMA_CONTEXT_ADOPTION_FILE
    : authority.contextFile;
  const strictState = { ...state, formatVersion: VISUAL_ACCEPTANCE_FORMAT };
  let frames;
  let matrix;
  try {
    frames = await authority.validateContext(
      root,
      strictState,
      contextFile,
      legacy,
    );
    matrix = JSON.parse(
      await readFile(path.join(root, VISUAL_ACCEPTANCE_FILE), "utf8"),
    );
  } catch {
    return []; // nothing valid to decide about yet
  }
  const contextDigest = `sha256:${await hashFile(path.join(root, contextFile))}`;
  return (Array.isArray(matrix?.unbacked) ? matrix.unbacked : [])
    .filter((item) => isPlainObject(item) && !backedRowFor(matrix, item))
    .map(
      (item) =>
        visualUnbackedCandidate({ state, frames, matrix, contextDigest, item })
          .candidate,
    );
};

// ponytail: tolerance ceilings keep "explicit tolerance" from becoming a
// waiver; they are the calibration knob if a real design needs more slack.
const MAX_TOLERANCE_PX = 16;

const MAX_TOLERANCE_RATIO = 0.1;

// PROVISIONAL: unproven on real migrations. Slice D owns calibration; never
// widen one of these to admit a known divergent layout.
export const PROVISIONAL_VISUAL_DIFF_THRESHOLDS = Object.freeze({
  "legacy-runtime": 0.0005,
  "figma-mcp": 0.05,
});

/** The one v2 image and control comparison used by both migration engines. */
export const compareVisualEvidence = async ({
  visualRow, targetCapture, authority, targetReference, readAuthorityPng,
  readTargetPng, readAuthorityControls, targetControls, nativeRows = [],
}) => {
  const frame = visualRow.authorityFrame;
  const sourceReference = frame.sources.screenshot.reference;
  assertVisualCaptureBlock(frame, frame.capture, `${visualRow.id} authority`, authority === "legacy-runtime", !!frame.structured);
  assertVisualCaptureBlock(frame, targetCapture, `${visualRow.id} TARGET`, true);
  // A structured authority is a design render, so the runtime-capture fields do
  // not apply to it -- but the matte does: it is what both sides are flattened
  // over, and letting the TARGET's declaration stand in for a missing authority
  // matte would let the evidence choose its own comparison background.
  for (const field of frame.structured ? ["matte"] : ["mode", "deviceScaleFactor", "colorScheme", "reducedMotion", "matte"]) {
    if (frame.capture[field] !== targetCapture[field]) {
      throw new Error(`VISUAL_CAPTURE_MISMATCH: ${visualRow.id}.capture.${field} differs between '${sourceReference}' and '${targetReference}'`);
    }
  }
  if (frame.capture.compare.width !== targetCapture.compare.width ||
      frame.capture.compare.height !== targetCapture.compare.height) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${visualRow.id}.capture.compare differs between '${sourceReference}' and '${targetReference}'`);
  }
  const decode = async (read, capture, reference) => {
    let image;
    try {
      image = decodePng(await read());
    } catch (error) {
      throw new Error(`VISUAL_PNG_INVALID: '${reference}' ${error.message}`);
    }
    if (image.width !== capture.imageWidth || image.height !== capture.imageHeight) {
      throw new Error(`VISUAL_CAPTURE_MISMATCH: '${reference}' decoded ${image.width}x${image.height}, recorded ${capture.imageWidth}x${capture.imageHeight}`);
    }
    return image;
  };
  const source = await decode(readAuthorityPng, frame.capture, sourceReference);
  const target = await decode(readTargetPng, targetCapture, targetReference);
  const compare = frame.capture.compare;
  const { diffPixels, diffRatio } = perceptualDelta(source, target, { ...compare, matte: frame.capture.matte });
  const threshold = PROVISIONAL_VISUAL_DIFF_THRESHOLDS[authority];
  if (threshold === undefined) throw new Error(`VISUAL_CAPTURE_MISMATCH: unknown visual authority '${authority}'`);
  if (diffRatio > threshold) {
    throw new Error(`VISUAL_DIVERGENCE: ${visualRow.id} diffPixels ${diffPixels}, diffRatio ${diffRatio}, threshold ${threshold}; authority '${sourceReference}', TARGET '${targetReference}'`);
  }
  let structural = null;
  const extrasAuthorized = [];
  if (frame.structured) structural = { hierarchy: "PASS", assets: "PASS",
    nodeCount: Object.keys(frame.structuredAuthority.nodes).length };
  if (authority === "legacy-runtime") {
    const authorityControls = await readAuthorityControls();
    if (!Array.isArray(authorityControls) || !Array.isArray(targetControls) ||
        [...authorityControls, ...targetControls].some((control) =>
          typeof control?.role !== "string" || !control.role.trim() ||
          typeof control?.name !== "string" || !control.name.trim())) {
      throw new Error(`VISUAL_STRUCTURE_DIVERGENCE: ${visualRow.id} requires scoped {role, name} controls on both sides`);
    }
    structural = structuralDelta(authorityControls, targetControls);
    if (structural.missing.length || structural.countDiffs.length) {
      throw new Error(`VISUAL_STRUCTURE_DIVERGENCE: ${visualRow.id} ${JSON.stringify(structural)}`);
    }
    const licenses = nativeRows.flatMap((row) =>
      ["PRESERVED", "VERIFIED"].includes(row.verificationStatus ?? row.status)
        ? (row.controls ?? []).map((control) => ({ ...control, nativeRowId: row.id }))
        : []);
    for (const extra of structural.extra) {
      for (let count = 0; count < extra.count; count++) {
        const index = licenses.findIndex((control) => control.role === extra.role && control.name === extra.name);
        if (index < 0) throw new Error(`VISUAL_STRUCTURE_DIVERGENCE: ${visualRow.id} unauthorized extra ${extra.role} '${extra.name}'`);
        extrasAuthorized.push(licenses.splice(index, 1)[0]);
      }
    }
  }
  return { rowId: visualRow.id, authority, diffPixels, diffRatio, threshold,
    margin: threshold - diffRatio, compare, structural, extrasAuthorized,
    ...(frame.structured ? { authorityDigest: frame.structuredAuthority.authorityDigest,
      capability: structuredCapabilityProfile(frame.structuredAuthority.nodes, true) } : {}) };
};

/**
 * Format 17. The derived visual contract: validated against the pinned visual
 * authority it claims to come from -- Figma or the legacy runtime, read through
 * the one `VISUAL_AUTHORITIES` adapter -- and required to cover every required
 * UI behavior state. A state no COMPLETE frame establishes may be listed under
 * `unbacked` only with a cited VISUAL_UNBACKED operator decision bound to this
 * migration, the state, the authority context digest and the visual contract
 * digest. Only an explicit row binds a state to its authority frame; an
 * explicitly backed state cannot be unbacked, and nothing is inferred from
 * frame names or states.
 */
export const validateVisualAcceptance = async (
  root,
  state,
  legacy,
  target,
  contextFile,
  // Only a format-19 record reads it, and there it is mandatory: an absent
  // project root leaves the candidate unbindable to a trusted policy, and
  // `createNewFormatDecisionCandidate` refuses rather than defaulting. The
  // artifact engine calls this through `strictVisualState`, which pins format
  // 17, so artifact-13 behavior is untouched.
  { projectRoot, resolveUnbacked } = {},
) => {
  const authority = visualAuthorityOf(state);
  const frames = await authority.validateContext(
    root,
    state,
    contextFile,
    legacy,
  );
  const contextDigest = `sha256:${await hashFile(
    path.join(root, contextFile ?? authority.contextFile),
  )}`;
  const decisions = await readRecordedDecisions(root);
  const matrix = assertPlainObject(
    await readJson(
      path.join(root, VISUAL_ACCEPTANCE_FILE),
      "Visual acceptance matrix",
    ),
    "Visual acceptance matrix",
  );
  const rows = assertArray(matrix.rows, "Visual acceptance rows");
  assertUniqueIds(rows, "Visual acceptance rows");
  const hardened = hardenedVisual(
    state,
    VISUAL_ACCEPTANCE_FILE,
    matrix,
    VISUAL_ACCEPTANCE_FILE,
  );
  const normalized = new Map();
  const behaviors = new Map(
    (legacy.uiBehaviors ?? []).map((uiBehavior) => [uiBehavior.id, uiBehavior]),
  );
  const covered = new Set();
  const claim = (item, label) => {
    assertPlainObject(item, label);
    if (!behaviors.get(item.uiBehaviorId)?.runtimeStates.includes(item.state)) {
      throw new Error(
        `${label} does not name a discovered state of UI behavior '${item.uiBehaviorId}'.`,
      );
    }
    const key = `${item.uiBehaviorId}::${item.state}`;
    if (covered.has(key)) {
      throw new Error(`${label} covers '${key}', which is already covered.`);
    }
    covered.add(key);
  };
  for (const row of rows) {
    const label = `Visual acceptance row ${row.id}`;
    claim(row, label);
    const frame = frames.get(frameKeyOf(authority, row, "rowFrameKey"));
    if (!frame) {
      throw new Error(
        `${label}.${authority.rowFrameKey} '${row[authority.rowFrameKey]}' is not a frame in ${authority.contextFile}.`,
      );
    }
    if (frame.extraction.fidelity !== "COMPLETE") {
      throw new Error(
        `${label} binds node '${frame.key}', whose Figma extraction is DEGRADED (${frame.extraction.limitations.join("; ")}). Fidelity cannot be established from it: re-extract the node (split get_design_context over its children) before deriving acceptance from it.`,
      );
    }
    if (!frame.states.includes(row[authority.rowStateKey])) {
      throw new Error(
        `${label}.${authority.rowStateKey} '${row[authority.rowStateKey]}' is not one of node '${frame.key}' states (${frame.states.join(", ")}).`,
      );
    }
    if (
      row.viewport?.width !== frame.viewport.width ||
      row.viewport?.height !== frame.viewport.height
    ) {
      throw new Error(
        `${label}.viewport must be node '${frame.key}' viewport ${frame.viewport.width}x${frame.viewport.height}.`,
      );
    }
    if (frame.structured) {
      const nodes = validateStructuredContract(frame.structuredAuthority.nodes, row.nodes);
      for (const [nodeId, contract] of Object.entries(nodes)) {
        if (contract.targetLocator !== frame.structuredAuthority.nodes[nodeId].targetLocator) {
          throw new Error(`VISUAL_FACT_NODE_MISATTRIBUTED: ${nodeId} targetLocator differs from pinned frame contract`);
        }
      }
      const capability = structuredCapabilityProfile(frame.structuredAuthority.nodes);
      if (capability.unresolved.length) {
        throw new Error(`FIGMA_CAPABILITY_INCOMPLETE: ${JSON.stringify(capability.unresolved)}`);
      }
      const boundNodes = Object.fromEntries(Object.entries(nodes).map(([id, node]) =>
        [id, { ...node, parentId: frame.structuredAuthority.nodes[id].parentId }]));
      normalized.set(row.id, { ...row, nodes: boundNodes, tolerance: FIXED_VISUAL_TOLERANCE,
        version: HARDENED_VISUAL_VERSION, authorityFrame: frame, capability });
      continue;
    }
    if (hardened) {
      // Fixed, not defaulted: at v2 there is no number to argue about, so
      // authoring one is refused outright rather than capped.
      if (row.tolerance !== undefined) {
        throw new Error(
          `VISUAL_TOLERANCE_FIXED: ${label}.tolerance is authored. Version ${HARDENED_VISUAL_VERSION} compares at a fixed ±${FIXED_VISUAL_TOLERANCE.px}px with no ratio allowance, and a per-row tolerance is a waiver with a number in it. Remove it.`,
        );
      }
    } else {
      const tolerance = assertPlainObject(row.tolerance, `${label}.tolerance`);
      for (const [key, ceiling] of [
        ["px", MAX_TOLERANCE_PX],
        ["ratio", MAX_TOLERANCE_RATIO],
      ]) {
        if (
          typeof tolerance[key] !== "number" ||
          !(tolerance[key] >= 0 && tolerance[key] <= ceiling)
        ) {
          throw new Error(
            `${label}.tolerance.${key} must be an explicit number between 0 and ${ceiling}.`,
          );
        }
      }
    }
    const expect = assertPlainObject(row.expect, `${label}.expect`);
    if (Object.keys(expect).length === 0) {
      throw new Error(`${label}.expect must declare at least one visual fact.`);
    }
    for (const [name, fact] of Object.entries(expect)) {
      const at = `${label}.expect.${name}`;
      assertPlainObject(fact, at);
      assertNonEmpty(fact.locator, `${at}.locator`);
      const valid =
        // v2 lets a `px` fact carry a length *spelling* -- "16px", "50%" --
        // because normalization, not the shape check, is what decides whether
        // a unit is supported. A `rem` therefore refuses with the reason it
        // refuses for, instead of as a malformed fact.
        (fact.kind === "px" &&
          (Number.isFinite(fact.value) ||
            (hardened && typeof fact.value === "string"))) ||
        (fact.kind === "count" &&
          (Number.isInteger(fact.value) ||
            (Number.isInteger(fact.min) &&
              (fact.max === undefined ||
                (Number.isInteger(fact.max) && fact.max >= fact.min))))) ||
        (fact.kind === "equals" && fact.value !== undefined) ||
        (fact.kind === "present" && typeof fact.value === "boolean");
      if (!valid) {
        throw new Error(
          `${at} must be {kind: px, value: number} | {kind: count, value | min[, max]: integer} | {kind: equals, value} | {kind: present, value: boolean}.`,
        );
      }
      // ponytail: a count with no upper bound and a min of 0 accepts every
      // measurement a runtime can produce -- a waiver wearing a row's clothes,
      // the same reason tolerance has ceilings. Give it a max, or a min of 1.
      if (
        fact.kind === "count" &&
        fact.value === undefined &&
        fact.max === undefined &&
        fact.min <= 0
      ) {
        throw new Error(
          `${at} is unfalsifiable: {kind: count, min: ${fact.min}} with no max accepts every measurement. Give it a max, or a min of at least 1.`,
        );
      }
      // v2 closes the remaining half of that hole: `min: 1` with no max still
      // admits 1 and 9000 alike. A count is an exact number or a closed range.
      if (
        hardened &&
        fact.kind === "count" &&
        fact.value === undefined &&
        fact.max === undefined
      ) {
        throw new Error(
          `VISUAL_COUNT_UNBOUNDED: ${at} declares {kind: count, min: ${fact.min}} with no max, which accepts every count at or above ${fact.min}. Version ${HARDENED_VISUAL_VERSION} requires an exact value, or both min and max.`,
        );
      }
      if (hardened && REQUIRED_FACT_KINDS[name] !== undefined && fact.kind !== REQUIRED_FACT_KINDS[name]) {
        throw new Error(
          `${at} declares kind '${fact.kind}'; the taxonomy fixes '${name}' at kind '${REQUIRED_FACT_KINDS[name]}'.`,
        );
      }
    }
    if (hardened) {
      // Coverage: the fixed taxonomy UNION every fact the authority frame
      // established. The union half costs nothing -- those facts already exist
      // -- and the table half is what makes a one-fact PASS unauthorable.
      const groups = missingRequiredGroups(expect);
      if (groups.length > 0) {
        throw new Error(
          `VISUAL_CONTRACT_COVERAGE: ${label}.expect covers none of the required taxonomy group(s) ${groups.join(", ")}. A version ${HARDENED_VISUAL_VERSION} row asserts geometry, spacing, colour, typography, border, shadow, visibility, a bounded structural count and the visible assets; a row that asserts only what happens to match is not a contract.`,
        );
      }
      const authoritative = frame.facts ?? {};
      const unbackedFacts = Object.keys(expect).filter(
        (name) => authoritative[name] === undefined,
      );
      if (unbackedFacts.length > 0) {
        throw new Error(
          `VISUAL_CONTRACT_PROVENANCE: ${label}.expect asserts ${unbackedFacts.join(", ")}, which frame '${frame.key}' does not establish. Every version ${HARDENED_VISUAL_VERSION} fact must come from the pinned authority.`,
        );
      }
      const omitted = Object.keys(authoritative).filter(
        (name) => expect[name] === undefined,
      );
      if (omitted.length > 0) {
        throw new Error(
          `VISUAL_CONTRACT_COVERAGE: ${label}.expect omits ${omitted.join(", ")}, which frame '${frame.key}' establishes. A fact the authority carries cannot be dropped from the contract derived from it.`,
        );
      }
      // The contract value is checked against the authority value in the one
      // normalized space, which is what makes a Figma `#0B5FFF` and a browser
      // `rgb(11, 95, 255)` the same assertion rather than two.
      const expected = {};
      for (const [name, fact] of Object.entries(expect)) {
        const at = `${label}.expect.${name}`;
        let value;
        try {
          value = normalizeVisualValue(name, fact.value ?? fact.min);
        } catch (error) {
          throw new Error(`${at} ${error.message}`);
        }
        const authority = authoritative[name];
        const authorityCount = authority.value;
        const disagrees = fact.kind === "count" && fact.value === undefined
          ? !Number.isInteger(authorityCount) || authorityCount < fact.min || authorityCount > fact.max
          : JSON.stringify(authorityCount) !== JSON.stringify(value);
        if (disagrees) {
          throw new Error(
            `VISUAL_CONTRACT_DIVERGES: ${at} expects ${JSON.stringify(value)}, but frame '${frame.key}' establishes ${JSON.stringify(authority.value)}. The contract is derived from the pinned authority, never authored beside it.`,
          );
        }
        // `normalized` carries the fact's own property name, so the runtime
        // measurement is put in the same space by the one shared function at
        // comparison time -- in both engines, through one `compareVisualFact`.
        expected[name] =
          fact.value === undefined
            ? { ...fact, normalized: name }
            : { ...fact, value, normalized: name };
      }
      normalized.set(row.id, {
        ...row,
        expect: expected,
        tolerance: FIXED_VISUAL_TOLERANCE,
        version: HARDENED_VISUAL_VERSION,
        authorityFrame: frame,
      });
    }
  }
  for (const [index, item] of assertArray(
    matrix.unbacked ?? [],
    "Visual acceptance unbacked",
  ).entries()) {
    const label = `Visual acceptance unbacked[${index}]`;
    assertPlainObject(item, label);
    const backed = backedRowFor(matrix, item);
    if (backed) {
      throw new Error(
        `${label} declares '${item.uiBehaviorId}' state '${item.state}' unbacked, but row ${backed.id} explicitly binds it to Figma node '${backed[authority.rowFrameKey]}' state '${backed[authority.rowStateKey]}'. That row is authoritative; an explicitly backed state cannot be unbacked, not even by an operator.`,
      );
    }
    claim(item, label);
    assertNonEmpty(item.reason, `${label}.reason`);
    // v2, legacy-runtime only. "We captured one of six states and waived the
    // rest" is the shape this closes: if a sibling state of the same behavior
    // was captured, the capture rig demonstrably reaches this behavior, so the
    // only honest reason to leave a sibling unbacked is a recorded extraction
    // limitation on that state's own frame. figma-mcp is deliberately exempt --
    // the engine cannot know whether a design for the state exists at all, so
    // the operator stays the only judge there.
    if (hardened && authority.contextFile === LEGACY_RUNTIME_CONTEXT_FILE) {
      const captured = [...frames.values()].filter(
        (frame) =>
          frame.uiBehaviorId === item.uiBehaviorId && frame.state !== item.state,
      );
      const own = frames.get(`${item.uiBehaviorId}::${item.state}`);
      if (captured.length > 0 && !(own?.extraction?.limitations?.length > 0)) {
        throw new Error(
          `VISUAL_SIBLING_STATE_CAPTURED: ${label} leaves '${item.uiBehaviorId}' state '${item.state}' unbacked, but state(s) ${captured.map((frame) => `'${frame.state}'`).join(", ")} of the same behavior were captured from the running legacy app. Capture this state too, or record its frame in ${LEGACY_RUNTIME_CONTEXT_FILE} with the extraction.limitations that stopped the capture. An operator decision waives a state the rig cannot reach, not one it did not try.`,
        );
      }
    }
    const { candidate: legacyCandidate } = visualUnbackedCandidate({
      state,
      frames,
      matrix,
      contextDigest,
      item,
    });
    const candidate = usesDirectLedgerDecisions(state)
      ? await createNewFormatDecisionCandidate({
          projectRoot,
          kind: legacyCandidate.kind,
          subjectType: legacyCandidate.subject.type,
          subjectPath: legacyCandidate.subject.path,
          rationale: legacyCandidate.rationale,
          targets: legacyCandidate.targets,
          boundTo: legacyCandidate.boundTo,
        })
      : legacyCandidate;
    if (
      !usesDirectLedgerDecisions(state) &&
      !resolveUnbacked &&
      (typeof item.decisionId !== "string" || !item.decisionId)
    ) {
      throw new Error(
        `VISUAL_UNBACKED_REQUIRES_OPERATOR: ${label} leaves '${candidate.subject.path}' without Figma visual acceptance. No agent may waive a visual state: an operator must approve candidate '${candidate.id}' (record-decision.mjs <module> --pending, then --approve at a terminal), and the entry must cite its decisionId and decisionDigest.`,
      );
    }
    if (resolveUnbacked) {
      await resolveUnbacked(item, label);
    } else {
      await requireModuleDecision({
        state,
        byId: decisions.byId,
        decisions: decisions.decisions,
        row: item,
        label,
        candidate,
      });
    }
  }
  const mismatchByBehavior = new Map(
    target.uiMismatches.map((row) => [row.uiBehaviorId, row]),
  );
  for (const uiBehavior of behaviors.values()) {
    if (!uiBehaviorIsRequired(uiBehavior, mismatchByBehavior.get(uiBehavior.id)))
      continue;
    for (const runtimeState of uiBehavior.runtimeStates) {
      if (!covered.has(`${uiBehavior.id}::${runtimeState}`)) {
        throw new Error(
          `VISUAL_CONTRACT_GAP: required UI behavior '${uiBehavior.id}' state '${runtimeState}' has no row in ${VISUAL_ACCEPTANCE_FILE}. Bind it explicitly to its Figma node and state, or list it under "unbacked" with its reason and an operator's VISUAL_UNBACKED decision.`,
        );
      }
    }
  }
  // v2 rows are returned normalized and with the fixed tolerance already
  // attached, so every comparison site -- both engines -- gets the hardened
  // semantics without knowing the version exists.
  return rows.map((row) => normalized.get(row.id) ?? row);
};

/** One expected fact against one runtime value; null when it holds. */
export const compareVisualFact = (fact, actual, tolerance) => {
  if (actual === undefined) return "was not measured";
  if (fact.normalized) {
    try {
      actual = normalizeVisualValue(fact.normalized, actual);
    } catch (error) {
      return `was measured as ${JSON.stringify(actual)}, which ${error.message.replace(/^VISUAL_VALUE_UNSUPPORTED: .*? value .*? /, "")}`;
    }
  }
  const observed = JSON.stringify(actual);
  if (fact.kind === "px") {
    // A percentage never became a number, so it is compared as the literal it
    // is; mixing the two would be the silent coercion normalization forbids.
    if (typeof fact.value === "string" || typeof actual === "string") {
      return JSON.stringify(fact.value) === observed
        ? null
        : `expected ${JSON.stringify(fact.value)}, observed ${observed}`;
    }
    const allowed = Math.max(tolerance.px, tolerance.ratio * Math.abs(fact.value));
    return Number.isFinite(actual) && Math.abs(actual - fact.value) <= allowed
      ? null
      : `expected ${fact.value}px ±${allowed}, observed ${observed}`;
  }
  if (fact.kind === "count") {
    const min = fact.value ?? fact.min;
    const max = fact.value ?? fact.max ?? Infinity;
    return Number.isInteger(actual) && actual >= min && actual <= max
      ? null
      : `expected ${min === max ? min : `${min}..${max}`}, observed ${observed}`;
  }
  if (fact.kind === "present") {
    return actual === fact.value
      ? null
      : `expected ${fact.value ? "present" : "absent"}, observed ${actual === true ? "present" : actual === false ? "absent" : observed}`;
  }
  return JSON.stringify(fact.value) === observed
    ? null
    : `expected ${JSON.stringify(fact.value)}, observed ${observed}`;
};

/**
 * Format 17. Compares one Figma-backed TARGET row's runtime measurements with
 * its visual acceptance row. Measurements are read from the persisted runtime
 * observation file the row references -- never from the row's own prose -- and
 * the engine, not the row's `result`, decides.
 */
export const assertVisualAcceptance = async ({
  record,
  visualRow,
  label,
  roots,
  authority,
}) => {
  const refuse = (problem) => {
    throw new Error(
      `VISUAL_ACCEPTANCE_FAIL: ${label} (${visualRow.id}, Figma node ${visualRow[authority.rowFrameKey]}) ${problem}. Figma-backed states are accepted by comparing runtime measurements with ${VISUAL_ACCEPTANCE_FILE}; an authored result: "PASS" cannot verify them. Fix the target and re-measure, or record FAIL and rework the slice.`,
    );
  };
  if (
    frameKeyOf(authority, record, "recordFrameKey") !==
    frameKeyOf(authority, visualRow, "rowFrameKey")
  ) {
    refuse(
      `names ${authority.recordFrameKey} '${record[authority.recordFrameKey]}'`,
    );
  }
  const expectedViewport = `${visualRow.viewport.width}x${visualRow.viewport.height}`;
  if (`${record.viewport.width}x${record.viewport.height}` !== expectedViewport) {
    refuse(
      `ran at viewport ${record.viewport.width}x${record.viewport.height}, the contract requires ${expectedViewport}`,
    );
  }
  if (!record.screenshot) refuse("has no runtime screenshot");
  const source = assertPlainObject(record.measurements, `${label}.measurements`);
  assertTargetEvidencePath(source.reference, `${label}.measurements.reference`);
  await assertEvidenceReference(source, `${label}.measurements`, roots, {
    require: true,
  });
  let observation;
  try {
    const file = JSON.parse(
      await readFile(
        await resolveEvidencePath(evidencePathClaim(source.reference), roots),
        "utf8",
      ),
    );
    observation = source.pointer === undefined ? file : file?.[source.pointer];
  } catch (error) {
    refuse(`references measurements that are not JSON (${error.message})`);
  }
  if (!isPlainObject(observation) ||
      !(visualRow.nodes ? isPlainObject(observation.nodes) : isPlainObject(observation.values))) {
    refuse(`references measurements without a "${visualRow.nodes ? "nodes" : "values"}" object`);
  }
  if (
    `${observation.viewport?.width}x${observation.viewport?.height}` !==
    expectedViewport
  ) {
    refuse(
      `was measured by the runtime at viewport ${observation.viewport?.width}x${observation.viewport?.height}, the contract requires ${expectedViewport}`,
    );
  }
  const failures = visualRow.nodes
    ? compareStructuredTarget(visualRow.nodes, observation, compareVisualFact, visualRow.tolerance)
    : Object.entries(visualRow.expect).flatMap(([name, fact]) => {
      const miss = compareVisualFact(fact, observation.values[name], visualRow.tolerance);
      return miss ? [`${name} ${miss}`] : [];
    });
  if (failures.length > 0) {
    refuse(`diverges from the design: ${failures.join("; ")}`);
  }
};
