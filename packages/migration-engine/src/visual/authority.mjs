import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  FIGMA_CONTEXT_ADOPTION_FILE,
  FIGMA_CONTEXT_FILE,
  LEGACY_RUNTIME_CONTEXT_FILE,
  UI_PROOF_FORMAT,
  usesDesignSource,
  usesVisualAcceptance,
  VISUAL_ACCEPTANCE_FORMAT,
} from "../formats/index.mjs";
import {
  isPlainObject,
  isResolvedWithin as isWithin,
  recordRelative,
} from "../shared/index.mjs";
import { fileExists, fileIdentityMatches } from "../store/index.mjs";
import {
  assertProvenancePrecedence,
  assertStructuredCaptureScale,
  captureStructuredNode,
  deriveStructuredAuthority,
  extractNodeLiterals,
  FIGMA_PROVENANCE_KINDS,
  FIXED_VISUAL_TOLERANCE,
  HARDENED_VISUAL_VERSION,
  normalizeVisualValue,
  REQUIRED_FACT_KINDS,
  REQUIRED_FACT_NAMES,
  resolveDesignContextFact,
  resolveMetadataAssets,
  resolveMetadataFact,
  resolveVariableDefsFact,
  structuredAssetIdentity,
  structuredDigest,
  validateStructuredContract,
  variableValueSet,
  xmlAttribute,
} from "./evidence.mjs";

/**
 * Whether this record derives a format-17 visual contract at all. True for
 * every record whose design source pins a visual authority (`VISUAL_AUTHORITIES`),
 * false for `target-system`, which designs nothing and is held to nothing.
 */
export const usesVisualContract = (state) =>
  usesVisualAcceptance(state) && visualAuthorityOf(state) !== null;

// Where the authority's own captures live. P4: nothing under here may be cited
// as TARGET verification evidence, and nothing under `evidence/` may be cited
// as an authority source. Different root, different checkpoint, different pin.
export const LEGACY_RUNTIME_EVIDENCE_ROOT = "inventories/legacy-runtime/";

const TARGET_EVIDENCE_ROOT = "evidence/";

/**
 * P5. The lifecycle slot a capture was produced for, declared in the record
 * itself rather than only in the engine's head. The authority is captured at
 * ASSESS_TARGET, before the target exists; target verification is captured at
 * VERIFY_SLICES, after it does. A block whose role disagrees with the slot it
 * is cited from is refused -- and note that no rule anywhere compares the two
 * roles' image hashes for *inequality*: byte-identical captures are the correct
 * 1:1 outcome of a migration and must pass.
 */
export const LEGACY_AUTHORITY_ROLE = "LEGACY_AUTHORITY";

export const TARGET_VERIFICATION_ROLE = "TARGET_VERIFICATION";

/**
 * The `version: 2` discriminator, asked of one visual artifact at a time.
 *
 * The artifact declares its own version, because the rules it is held to must
 * not change underneath it: pinning happens after validation, so a state-based
 * answer would say "hardened" at the step that authors the file and "not
 * hardened" at every later re-read of the same bytes.
 *
 * `version: 1` is therefore legal only where it is already history -- a record
 * that pinned this artifact before v2 existed keeps passing exactly as it did.
 * Nothing newly authored may choose it: v1 is compatibility, never a
 * certification path.
 */
export const hardenedVisual = (state, relative, document, label) => {
  const version = document?.version;
  if (version === HARDENED_VISUAL_VERSION) return true;
  if (version === 1 && state?.artifactHashes?.[relative]) return false;
  throw new Error(
    `VISUAL_CONTRACT_VERSION: ${label} declares version ${JSON.stringify(version)}. Author it at version ${HARDENED_VISUAL_VERSION}: the hardened visual contract covers the full visual taxonomy, resolves every fact from the pinned authority, and compares at a fixed ±${FIXED_VISUAL_TOLERANCE.px}px. Version 1 remains readable only for records that had already pinned it before version ${HARDENED_VISUAL_VERSION} existed.`,
  );
};

/**
 * The one adapter table that makes the format-17 acceptance pipeline pluggable.
 * Exactly the fields that differ between the two supported origins -- there is
 * no normalized-frame layer beyond them, and no entry for a hypothetical third
 * authority. `validateVisualAcceptance`, `compareVisualFact`,
 * `assertVisualAcceptance`, the pin/replay filters and both front ends stay
 * exactly one implementation each.
 *
 * `validateContext` is wrapped in an arrow because the validators are declared
 * far below this table; the table is only ever read at call time.
 */
export const VISUAL_AUTHORITIES = Object.freeze({
  "figma-mcp": Object.freeze({
    contextFile: FIGMA_CONTEXT_FILE,
    validateContext: (root, state, contextFile) =>
      validateFigmaContext(root, state, contextFile),
    rowFrameKey: "figmaNodeId",
    rowStateKey: "figmaState",
    recordFrameKey: "figmaNodeId",
    normalizeFrameKey: (value) => figmaNodeKey(value),
    boundToDigestField: "figmaContextDigest",
  }),
  "legacy-runtime": Object.freeze({
    contextFile: LEGACY_RUNTIME_CONTEXT_FILE,
    validateContext: (root, state, contextFile, legacy) =>
      validateLegacyRuntimeContext(root, state, contextFile, legacy),
    rowFrameKey: "legacyFrameId",
    // The runtime state a legacy frame shows is the row's own state; there is
    // no second design-side state vocabulary to map through.
    rowStateKey: "state",
    recordFrameKey: "legacyFrameId",
    normalizeFrameKey: (value) => String(value ?? "").trim(),
    boundToDigestField: "visualContextDigest",
  }),
});

/** The authority-neutral frame identity a row or an evidence record binds. */
export const frameKeyOf = (authority, source, field) =>
  authority.normalizeFrameKey(source?.[authority[field]]);

/**
 * P4, target side. A TARGET screenshot, measurement or proof reference may not
 * resolve inside the authority's own capture tree: the authority was pinned at
 * ASSESS_TARGET and citing it here would let the thing being measured *be* the
 * thing it is measured against. Only an independent capture at the slice's own
 * path can be cited. Nothing here compares hashes -- byte-identical authority
 * and target images at disjoint paths are the correct 1:1 outcome and pass.
 */
/**
 * P5. A declared capture role must be the role of the lifecycle slot it is
 * cited from. The block stays optional so no existing record gains an
 * obligation; declaring the *wrong* role is what is refused.
 */
export const assertCaptureRole = (capture, expected, label) => {
  const role = capture?.role;
  if (role !== undefined && role !== expected) {
    throw new Error(
      `VISUAL_CAPTURE_ROLE: ${label}.capture.role is '${role}', but this evidence is cited as ${expected}. A capture declares the lifecycle slot it was produced for, and the two slots are never interchangeable.`,
    );
  }
};

export const assertTargetEvidencePath = (reference, label) => {
  const spelled = String(reference ?? "").split(path.sep).join("/");
  if (
    spelled === LEGACY_RUNTIME_EVIDENCE_ROOT.slice(0, -1) ||
    spelled.includes(LEGACY_RUNTIME_EVIDENCE_ROOT)
  ) {
    throw new Error(
      `VISUAL_AUTHORITY_SUBSTITUTION: ${label} '${reference}' resolves inside ${LEGACY_RUNTIME_EVIDENCE_ROOT}, the pinned visual authority's own capture tree. Target verification evidence is captured at VERIFY_SLICES under evidence/<slice>/ and never cites the authority it is compared against.`,
    );
  }
};

/** The pinned visual authority of a record, or null for `target-system`. */
export const visualAuthorityOf = (state) =>
  (usesDesignSource(state) && VISUAL_AUTHORITIES[state?.designSource]) || null;

const AUTHORITY_CONTEXT_FILES = new Set(
  Object.values(VISUAL_AUTHORITIES).map((authority) => authority.contextFile),
);

/**
 * The one rule both the pin filter and the history-replay filter read: an
 * authority context is pinned at ASSESS_TARGET only by the record whose design
 * source owns it. A target-system record authored neither, and a figma-mcp
 * record must never be held to the legacy one (or the reverse), or the next
 * resume fails the "pins exactly" assertion.
 */
export const pinsAuthorityContext = (state, relative) =>
  !AUTHORITY_CONTEXT_FILES.has(relative) ||
  visualAuthorityOf(state)?.contextFile === relative;

/**
 * Whether the operator explicitly named a design source on this invocation.
 * A plain resume names neither `--design-source` nor `--figma`, so it must not
 * be read as an attempt to switch back to the default -- exactly as omitting
 * `--mock` resumes a mock migration untouched.
 */
export const designSourceExplicit = ({ designSource, figma } = {}) =>
  designSource !== undefined ||
  (Array.isArray(figma) ? figma.length > 0 : figma !== undefined);

const figmaSourceKey = (sources) =>
  (sources ?? [])
    .map((source) => `${source.kind}#${source.fileKey}#${source.nodeId ?? ""}`)
    .sort()
    .join(",");

/**
 * The design source is bootstrap-fixed. A resume that explicitly names a
 * different one is refused, mirroring the `--mock` and `--ponytail` conflicts.
 */
export const assertDesignSourceUnchanged = (state, design) => {
  const recorded = state.designSource ?? "target-system";
  if (design.designSource !== recorded) {
    throw new Error(
      `Design source '${design.designSource}' conflicts with the recorded design source '${recorded}'. The design source is fixed for the migration's lifetime; start a new migration to change it.`,
    );
  }
  if (
    figmaSourceKey(design.figmaSources) !== figmaSourceKey(state.figmaSources)
  ) {
    throw new Error(
      "Figma sources conflict with the recorded Figma sources. The design source and its links are fixed for the migration's lifetime.",
    );
  }
};

/**
 * The shape contract behind the Figma pin. Pinning proves only that the bytes
 * never changed after ASSESS_TARGET closed -- `{}` pinned and passed, so the
 * digest bound into every visual TARGET evidence row was cryptographically
 * sound and semantically anchored to nothing. This is the cheapest check that
 * the Figma MCP was actually consulted: frames exist, and every frame names a
 * file the operator authorized at bootstrap.
 *
 * ponytail: structural only -- it cannot prove the frames were not invented.
 * Ceiling: an agent that fabricates a frame naming a recorded fileKey still
 * passes. Upgrade path: have the engine re-read node metadata, which would
 * make it call the Figma MCP and stop being pure.
 *
 * Format 17 narrows that ceiling without a network call: each frame must be a
 * recorded link's node, and must carry the verbatim MCP outputs persisted in
 * the record and hashed, whose metadata has to describe that node at the
 * declared viewport. Re-run at every verification, so a persisted Figma file
 * that changed after it was hashed is stale evidence, not silent drift.
 * Returns the frames keyed by node id (format 17 only).
 */
const FIGMA_NODE_ID = /^[0-9]+:[0-9]+$/;

export const FIGMA_SOURCE_KINDS = [
  "metadata",
  "designContext",
  "variableDefs",
  "screenshot",
];

const figmaNodeKey = (value) =>
  typeof value === "string" ? value.trim().replace("-", ":") : "";

/**
 * The node ids from the root of a persisted `get_metadata` output down to
 * `nodeId`, or null when `nodeId` is not nested under that root. Read off the
 * element nesting of the verbatim MCP output, never off an authored claim.
 */
export const figmaMetadataAncestry = (metadata, nodeId) => {
  const stack = [];
  let rootId;
  for (const [tag, closing, selfClosing] of metadata.matchAll(
    /<(\/?)[A-Za-z][\w:.-]*(?:\s+[^\s=>/]+="[^"]*")*\s*(\/?)>/g,
  )) {
    if (closing) {
      stack.pop();
      if (stack.length === 0) return null; // left the root: one tree only
      continue;
    }
    const id = figmaNodeKey(xmlAttribute(tag, "id"));
    rootId ??= id;
    if (stack.length === 0 && id !== rootId) return null;
    if (id === nodeId && stack.length > 0) return [...stack, id];
    if (!selfClosing) stack.push(id);
  }
  return null;
};

export const validateFigmaContext = async (
  root,
  state,
  contextFile = FIGMA_CONTEXT_FILE,
) => {
  const strict = usesVisualAcceptance(state);
  const fail = (problem) => {
    throw Object.assign(new Error(
      `${contextFile} ${problem}. This migration records designSource: figma-mcp, so ASSESS_TARGET cannot close without it: read the figmaSources recorded in state.json through the Figma MCP and author ${FIGMA_CONTEXT_FILE} as a JSON object with a non-empty "frames" array whose every entry names the "fileKey" it was read from.${
        strict
          ? ` Format ${VISUAL_ACCEPTANCE_FORMAT} also requires every frame's nodeId, name, type, viewport, states, extraction {retrievedAt, fidelity, limitations}, and sources {metadata, designContext[], variableDefs, screenshot}: the verbatim Figma MCP outputs persisted inside the migration record, each as {reference, hash}.`
          : ""
      }`,
    ), { visualContextFail: true });
  };
  const filePath = path.join(root, contextFile);
  if (!(await fileExists(filePath))) fail("does not exist");
  let context;
  try {
    context = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`is invalid JSON: ${error.message}`);
  }
  if (!isPlainObject(context)) fail("must be a JSON object");
  if (!Array.isArray(context.frames) || context.frames.length === 0) {
    fail('must record a non-empty "frames" array');
  }
  // The contract derived from this authority is hardened, so the authority it
  // is derived from must be: a v2 contract over a v1 context would assert
  // taxonomy facts nothing resolved.
  const hardened =
    strict &&
    hardenedVisual(
      state,
      // During adoption the fresh file is authored beside the pinned one, so
      // the pin that makes v1 legal is the pin of the file being replaced.
      contextFile === FIGMA_CONTEXT_ADOPTION_FILE ? FIGMA_CONTEXT_FILE : contextFile,
      context,
      contextFile,
    );
  const recorded = new Set(
    (state.figmaSources ?? []).map((source) => source.fileKey),
  );
  const frames = new Map();
  for (const [index, frame] of context.frames.entries()) {
    if (!isPlainObject(frame) || typeof frame.fileKey !== "string") {
      fail(`frames[${index}] must name a "fileKey"`);
    }
    const fileKey = frame.fileKey.trim();
    if (fileKey.length === 0) fail(`frames[${index}].fileKey is empty`);
    if (!recorded.has(fileKey)) {
      fail(
        `frames[${index}].fileKey '${fileKey}' is not one of this migration's recorded figmaSources (${[...recorded].join(", ")})`,
      );
    }
    if (!strict) continue;
    const at = `frames[${index}]`;
    const nodeId = figmaNodeKey(frame.nodeId);
    if (!FIGMA_NODE_ID.test(nodeId)) {
      fail(`${at}.nodeId must be a Figma node id such as "12:34"`);
    }
    const verifyPersisted = async (entry, label) => {
      const absolute =
        isPlainObject(entry) && typeof entry.reference === "string"
          ? path.resolve(root, entry.reference)
          : null;
      if (!absolute || !isWithin(root, absolute) || !(await fileExists(absolute))) {
        fail(`${Array.isArray(frame.sources?.structuredNodes) ? "VISUAL_AUTHORITY_TAMPERED: " : ""}${label} must reference a file persisted inside the migration record`);
      }
      // P4: the authority is pinned at ASSESS_TARGET, before any slice exists,
      // so it can never legitimately cite the target's verification tree.
      if (recordRelative(root, absolute).startsWith(TARGET_EVIDENCE_ROOT)) {
        fail(
          `${label} '${entry.reference}' resolves under ${TARGET_EVIDENCE_ROOT}; a pinned visual authority never cites target verification evidence`,
        );
      }
      // A persisted UI binding, so it reads through the shared identity
      // policy: the captured XML and text are text, and a checkout that only
      // re-spelled their line endings has not made the evidence stale. The
      // recorded spelling is left exactly as it was written.
      if (!(await fileIdentityMatches(entry.hash, absolute))) {
        fail(
          `${Array.isArray(frame.sources?.structuredNodes) ? "VISUAL_AUTHORITY_TAMPERED: " : ""}${label} '${entry.reference}' no longer matches its recorded hash; the persisted Figma evidence is stale`,
        );
      }
      return absolute;
    };
    const recordedNodes = (state.figmaSources ?? []).filter(
      (source) => source.fileKey === fileKey,
    );
    // A node link authorizes that node, a whole-file link any node of the file,
    // and a node link also authorizes a descendant whose nesting under it is
    // read from the source's own persisted get_metadata output.
    let ancestryTag = null;
    if (
      !recordedNodes.some(
        (source) =>
          source.nodeId === null || figmaNodeKey(source.nodeId) === nodeId,
      )
    ) {
      const ancestry = frame.ancestry;
      const recordedLinks = `(${(state.figmaSources ?? []).map((source) => `${source.fileKey}#${source.nodeId ?? "*"}`).join(", ")})`;
      if (!isPlainObject(ancestry)) {
        fail(
          `${at}.nodeId '${nodeId}' is not a node of this migration's recorded figmaSources ${recordedLinks}, and records no ancestry proving it descends from one`,
        );
      }
      const sourceNodeId = figmaNodeKey(ancestry.sourceNodeId);
      if (
        !recordedNodes.some(
          (source) => source.nodeId && figmaNodeKey(source.nodeId) === sourceNodeId,
        )
      ) {
        fail(
          `${at}.ancestry.sourceNodeId '${ancestry.sourceNodeId}' is not a recorded node link of file '${fileKey}' ${recordedLinks}`,
        );
      }
      const metadataPath = await verifyPersisted(
        ancestry.metadata,
        `${at}.ancestry.metadata`,
      );
      const sourceMetadata = await readFile(metadataPath, "utf8");
      const derived = figmaMetadataAncestry(sourceMetadata, nodeId);
      if (!derived || derived[0] !== sourceNodeId) {
        fail(
          `${at}.ancestry.metadata (the persisted get_metadata of '${sourceNodeId}') does not nest node '${nodeId}' under '${sourceNodeId}'`,
        );
      }
      if (JSON.stringify((ancestry.path ?? []).map(figmaNodeKey)) !== JSON.stringify(derived)) {
        fail(
          `${at}.ancestry.path ${JSON.stringify(ancestry.path)} is not the ancestry read from its persisted metadata ${JSON.stringify(derived)}`,
        );
      }
      ancestryTag = sourceMetadata.match(
        new RegExp(`<[^>]*\\sid="${nodeId}"[^>]*>`),
      )[0];
      if (xmlAttribute(ancestryTag, "name") !== frame.name) {
        fail(
          `${at}.name '${frame.name}' is not node '${nodeId}' name in its source metadata ('${xmlAttribute(ancestryTag, "name")}')`,
        );
      }
    }
    if (frames.has(nodeId)) fail(`${at}.nodeId '${nodeId}' is recorded twice`);
    for (const field of ["name", "type"]) {
      if (typeof frame[field] !== "string" || frame[field].trim() === "") {
        fail(`${at}.${field} is required`);
      }
    }
    const viewport = frame.viewport;
    if (
      !isPlainObject(viewport) ||
      !["width", "height"].every(
        (axis) => Number.isInteger(viewport[axis]) && viewport[axis] > 0,
      )
    ) {
      fail(`${at}.viewport must record positive integer width and height`);
    }
    if (
      !Array.isArray(frame.states) ||
      frame.states.length === 0 ||
      frame.states.some((item) => typeof item !== "string" || !item.trim())
    ) {
      fail(`${at}.states must list the design states the frame shows`);
    }
    const extraction = frame.extraction;
    if (
      !isPlainObject(extraction) ||
      typeof extraction.retrievedAt !== "string" ||
      Number.isNaN(Date.parse(extraction.retrievedAt)) ||
      !Array.isArray(extraction.limitations) ||
      !(
        (extraction.fidelity === "COMPLETE" &&
          extraction.limitations.length === 0) ||
        (extraction.fidelity === "DEGRADED" &&
          extraction.limitations.length > 0)
      )
    ) {
      fail(
        `${at}.extraction must record an ISO retrievedAt and fidelity COMPLETE with no limitations, or DEGRADED with every limitation`,
      );
    }
    const sources = isPlainObject(frame.sources) ? frame.sources : {};
    const structured = Array.isArray(sources.structuredNodes) && sources.structuredNodes.length > 0;
    const persisted = { designContext: [] };
    for (const kind of FIGMA_SOURCE_KINDS) {
      const entries =
        kind === "designContext" ? sources[kind] : sources[kind] && [sources[kind]];
      if (!Array.isArray(entries) || entries.length === 0) {
        if (structured && ["designContext", "variableDefs"].includes(kind)) continue;
        fail(`${at}.sources.${kind} must persist the raw Figma MCP output`);
      }
      for (const entry of entries) {
        const absolute = await verifyPersisted(entry, `${at}.sources.${kind}`);
        if (kind === "designContext") {
          // v2: an entry that does not say which node it describes cannot bind
          // a fact to a node, and an unbound CSS declaration is exactly the
          // "somewhere in the design it says 16px" claim this contract refuses.
          if (hardened && figmaNodeKey(entry.nodeId) === "") {
            fail(
              `${at}.sources.designContext[].nodeId is required: every persisted design context entry must name the node it was read for`,
            );
          }
          persisted.designContext.push({ entry, absolute });
        } else {
          persisted[kind] = { entry, absolute };
        }
      }
    }
    // The viewport is read off the persisted node, never taken on trust.
    const metadata = await readFile(
      path.resolve(root, sources.metadata.reference),
      "utf8",
    );
    const tag = metadata.match(new RegExp(`<[^>]*\\bid="${nodeId}"[^>]*>`))?.[0];
    if (!tag) fail(`${at}.sources.metadata does not describe node '${nodeId}'`);
    const size = (axis) =>
      Math.round(Number(tag.match(new RegExp(`\\b${axis}="([\\d.]+)"`))?.[1]));
    if (size("width") !== viewport.width || size("height") !== viewport.height) {
      fail(
        `${at}.viewport ${viewport.width}x${viewport.height} does not match node '${nodeId}' in its persisted metadata (${size("width")}x${size("height")})`,
      );
    }
    // The descendant's own snapshot and its source's hierarchy must agree.
    if (
      ancestryTag &&
      ["width", "height"].some(
        (axis) =>
          Math.round(Number(xmlAttribute(ancestryTag, axis))) !== viewport[axis],
      )
    ) {
      fail(
        `${at}.ancestry.metadata describes node '${nodeId}' at a size other than its viewport ${viewport.width}x${viewport.height}`,
      );
    }
    if (hardened && structured) {
      try { assertVisualCaptureBlock(frame, frame.capture, at, false, true); }
      catch (error) { fail(error.message); }
    }
    const structuredAuthority = hardened && structured
      ? await resolveStructuredFigmaFrame({ frame, nodeId, at, fail, metadata, persisted, verifyPersisted })
      : null;
    const facts = hardened && !structured
      ? await resolveFigmaFacts({ frame, nodeId, at, fail, metadata, persisted })
      : {};
    if (hardened && !structured) {
      try { assertVisualCaptureBlock(frame, frame.capture, at); }
      catch (error) { fail(error.message); }
    }
    // `key` is the authority-neutral frame identity every shared reader uses;
    // `nodeId` stays exactly what it was for every Figma-only reader.
    frames.set(nodeId, { ...frame, nodeId, key: nodeId, facts,
      ...(structuredAuthority ? { structuredAuthority, structured: true } : {}) });
  }
  return frames;
};

const resolveStructuredFigmaFrame = async ({ frame, nodeId, at, fail, metadata, persisted, verifyPersisted }) => {
  try {
    const records = [];
    for (const entry of frame.sources.structuredNodes) {
      if (!FIGMA_NODE_ID.test(figmaNodeKey(entry.nodeId))) fail(`${at}.sources.structuredNodes nodeId invalid`);
      const absolute = await verifyPersisted(entry, `${at}.sources.structuredNodes.${entry.nodeId}`);
      const rawSnapshot = await readFile(absolute, "utf8");
      const record = captureStructuredNode({ nodeId: entry.nodeId, rawSnapshot, capture: entry.capture });
      if (entry.digest !== record.digest) fail(`VISUAL_AUTHORITY_TAMPERED: ${entry.nodeId} digest differs`);
      records.push(record);
    }
    const byId = new Map(records.map((record) => [record.nodeId, record]));
    const assets = [];
    for (const entry of frame.sources.assets ?? []) {
      if (typeof entry.exportKind !== "string" || !entry.exportKind ||
          typeof entry.mimeType !== "string" || !entry.mimeType) {
        fail(`VISUAL_ASSET_OMITTED: ${entry.nodeId} requires official export kind and MIME type`);
      }
      const absolute = await verifyPersisted(entry, `${at}.sources.assets.${entry.nodeId}`);
      const record = byId.get(entry.nodeId);
      if (!record) fail(`VISUAL_ASSET_OMITTED: ${entry.nodeId} has no structured node`);
      const identity = structuredAssetIdentity(record, {
        exportKind: entry.exportKind, mimeType: entry.mimeType, content: await readFile(absolute),
      });
      if (!identity || entry.contentDigest !== identity.contentDigest) {
        fail(`VISUAL_AUTHORITY_TAMPERED: asset ${entry.nodeId} identity or content digest differs`);
      }
      assets.push(identity);
    }
    const screenshot = await readFile(await verifyPersisted(frame.sources.screenshot, `${at}.sources.screenshot`));
    const metadataFacts = records.flatMap((record) => {
      const tag = metadata.match(new RegExp(`<[^>]*\\bid="${record.nodeId}"[^>]*>`))?.[0];
      if (!tag) fail(`VISUAL_HIERARCHY_MISMATCH: metadata omits ${record.nodeId}`);
      return ["x", "y", "width", "height"].flatMap((property) => {
        const value = xmlAttribute(tag, property);
        return value === undefined ? [] : [{ nodeId: record.nodeId, property, value,
          source: "METADATA", rawProperty: property }];
      });
    });
    const literalFacts = [];
    const sourceDigests = { metadata: structuredDigest(metadata) };
    for (const { entry, absolute } of persisted.designContext) {
      const raw = await readFile(absolute, "utf8");
      const digest = structuredDigest(raw);
      sourceDigests[entry.reference] = digest;
      if (byId.has(figmaNodeKey(entry.nodeId))) {
        literalFacts.push(...extractNodeLiterals(raw, figmaNodeKey(entry.nodeId), digest));
      }
    }
    if (persisted.variableDefs) {
      sourceDigests.variableDefs = structuredDigest(await readFile(persisted.variableDefs.absolute));
    }
    const derived = deriveStructuredAuthority({ records, rootId: nodeId, assets,
      ancestry: (id) => id === nodeId ? [nodeId] : figmaMetadataAncestry(metadata, id),
      metadataFacts, literalFacts, sourceDigests,
      screenshotDigest: structuredDigest(screenshot), capture: frame.capture });
    if (frame.authority?.versionPinned !== false || frame.authority?.versionSource !== "none" ||
        frame.authority?.authorityDigest !== derived.authorityDigest) {
      fail(`VISUAL_AUTHORITY_TAMPERED: ${at}.authority differs from pinned evidence`);
    }
    const contract = validateStructuredContract(derived.nodes, frame.nodes, { requireProvenance: true });
    const nodes = Object.fromEntries(Object.entries(derived.nodes).map(([id, node]) =>
      [id, { ...node, targetLocator: contract[id].targetLocator }]));
    return { ...derived, nodes, assets };
  } catch (error) {
    if (error.visualContextFail) throw error;
    fail(error.message);
  }
};

/**
 * v2, figma-mcp: every authored fact re-resolved from the bytes whose hash this
 * validator has just re-verified, and refused when the authored value is not
 * what those bytes say. The frame declares `{value, provenance {kind,
 * reference, nodeId, selector}}`; the engine reads the value back out and
 * compares in the one normalized space, so the authored number is a claim about
 * pinned evidence rather than the evidence itself.
 *
 * `legacy-runtime` needs none of this: its facts are measured, not transcribed,
 * so the capture file *is* the provenance.
 */
const resolveFigmaFacts = async ({ frame, nodeId, at, fail, metadata, persisted }) => {
  const authored = frame.facts;
  if (!isPlainObject(authored) || Object.keys(authored).length === 0) {
    fail(
      `${at}.facts must record the visual facts this node establishes, each as {value, provenance {kind, reference, nodeId, selector}} resolvable from the persisted evidence (${REQUIRED_FACT_NAMES.join(", ")} plus whatever else this node establishes)`,
    );
  }
  let variableDefs;
  try {
    variableDefs = JSON.parse(await readFile(persisted.variableDefs.absolute, "utf8"));
  } catch (error) {
    fail(`${at}.sources.variableDefs is not JSON: ${error.message}`);
  }
  const designContextText = new Map();
  for (const { entry, absolute } of persisted.designContext) {
    designContextText.set(entry.reference, {
      nodeId: figmaNodeKey(entry.nodeId),
      text: await readFile(absolute, "utf8"),
    });
  }
  const facts = {};
  for (const [name, fact] of Object.entries(authored)) {
    const label = `${at}.facts.${name}`;
    if (!isPlainObject(fact)) fail(`${label} must be a JSON object`);
    const provenance = fact.provenance;
    if (!isPlainObject(provenance) || !FIGMA_PROVENANCE_KINDS.includes(provenance.kind)) {
      fail(
        `${label}.provenance.kind must be one of ${FIGMA_PROVENANCE_KINDS.join(", ")}`,
      );
    }
    // Node binding, checked before anything is read: a fact of *this* frame is
    // resolved against *this* node, so a selector aimed elsewhere in the same
    // file cannot be presented as this node's value.
    if (figmaNodeKey(provenance.nodeId) !== nodeId) {
      fail(
        `${label}.provenance.nodeId '${provenance.nodeId}' is not this frame's node '${nodeId}'`,
      );
    }
    if (typeof provenance.selector !== "string" || !provenance.selector.trim()) {
      fail(`${label}.provenance.selector is required`);
    }
    let resolved;
    try {
      if (provenance.kind === "metadata") {
        if (provenance.reference !== persisted.metadata.entry.reference) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' is not this frame's persisted metadata ('${persisted.metadata.entry.reference}')`,
          );
        }
        resolved = normalizeVisualValue(
          name,
          name === "assets"
            ? resolveMetadataAssets(metadata, nodeId, provenance.selector.trim(), label)
            : resolveMetadataFact(metadata, nodeId, provenance.selector.trim(), label),
        );
      } else if (provenance.kind === "variableDefs") {
        if (provenance.reference !== persisted.variableDefs.entry.reference) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' is not this frame's persisted variableDefs ('${persisted.variableDefs.entry.reference}')`,
          );
        }
        resolved = normalizeVisualValue(
          name,
          resolveVariableDefsFact(variableDefs, provenance.selector.trim(), label),
        );
      } else {
        const entry = designContextText.get(provenance.reference);
        if (!entry) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' is not one of this frame's persisted designContext entries`,
          );
        }
        if (entry.nodeId !== nodeId) {
          fail(
            `${label}.provenance.reference '${provenance.reference}' was read for node '${entry.nodeId}', not '${nodeId}'`,
          );
        }
        resolved = resolveDesignContextFact(
          entry.text,
          provenance.selector.trim(),
          name,
          label,
        );
      }
      assertProvenancePrecedence({
        property: name,
        kind: provenance.kind,
        value: resolved,
        variableValues:
          provenance.kind === "designContext"
            ? variableValueSet(variableDefs, name)
            : null,
        label,
      });
      const declared = normalizeVisualValue(name, fact.value);
      if (JSON.stringify(declared) !== JSON.stringify(resolved)) {
        fail(
          `${label}.value ${JSON.stringify(fact.value)} normalizes to ${JSON.stringify(declared)}, but its own ${provenance.kind} provenance resolves to ${JSON.stringify(resolved)}`,
        );
      }
    } catch (error) {
      // A refusal raised by `fail` already carries the context-file preamble;
      // a resolver's own refusal is re-thrown through it, so every message in
      // this validator names the file the operator has to fix.
      if (error.visualContextFail) throw error;
      fail(error.message);
    }
    facts[name] = { value: resolved, provenance };
  }
  const uncovered = REQUIRED_FACT_NAMES.filter((name) => facts[name] === undefined);
  if (uncovered.length > 0) {
    fail(
      `${at}.facts records no ${uncovered.join(", ")}; a node the contract derives from must establish the full visual taxonomy (${REQUIRED_FACT_NAMES.join(", ")})`,
    );
  }
  return facts;
};

/**
 * Format 17, legacy-runtime: the pinned visual authority, validated with
 * `validateFigmaContext`'s own primitives -- containment + `fileIdentityMatches`
 * on every persisted source, the COMPLETE/DEGRADED extraction rule, the
 * positive-integer viewport rule, the duplicate-key rule -- plus the rules that
 * bind it to *this* record's legacy tree rather than to a design file.
 *
 * The authority is captured before the target exists and is pinned at
 * ASSESS_TARGET, which is what makes substitution a recorded act: a frame is
 * bound to the pinned `legacyRevision`, declares `capture.role:
 * "LEGACY_AUTHORITY"`, and may cite nothing under `evidence/` (P4/P5).
 */
export const validateLegacyRuntimeContext = async (
  root,
  state,
  contextFile = LEGACY_RUNTIME_CONTEXT_FILE,
  legacy,
) => {
  const fail = (problem) => {
    throw new Error(
      `${contextFile} ${problem}. This migration records designSource: legacy-runtime, so ASSESS_TARGET cannot close without it: capture every required legacy UI behavior state from the running legacy app and author ${LEGACY_RUNTIME_CONTEXT_FILE} as a JSON object with a non-empty "frames" array, each frame naming its uiBehaviorId, state, viewport, rootLocator, this record's legacyRevision, a capture block {role: "LEGACY_AUTHORITY", mode: "element", compare {width, height}}, and sources {snapshot, screenshot, measurements} persisted under ${LEGACY_RUNTIME_EVIDENCE_ROOT} as {reference, hash}.`,
    );
  };
  const filePath = path.join(root, contextFile);
  if (!(await fileExists(filePath))) fail("does not exist");
  let context;
  try {
    context = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`is invalid JSON: ${error.message}`);
  }
  if (!isPlainObject(context)) fail("must be a JSON object");
  if (!Array.isArray(context.frames) || context.frames.length === 0) {
    fail('must record a non-empty "frames" array');
  }
  const hardened = hardenedVisual(state, contextFile, context, contextFile);
  const inventory =
    legacy ??
    JSON.parse(
      await readFile(path.join(root, "inventories/legacy.json"), "utf8"),
    );
  const discovered = new Map(
    (inventory.uiBehaviors ?? []).map((uiBehavior) => [
      uiBehavior.id,
      uiBehavior.runtimeStates ?? [],
    ]),
  );
  const frames = new Map();
  for (const [index, frame] of context.frames.entries()) {
    const at = `frames[${index}]`;
    if (!isPlainObject(frame)) fail(`${at} must be a JSON object`);
    const uiBehaviorId = frame.uiBehaviorId;
    const runtimeState = frame.state;
    if (!discovered.get(uiBehaviorId)?.includes(runtimeState)) {
      fail(
        `${at} names '${uiBehaviorId}' state '${runtimeState}', which is not a discovered state of a UI behavior in inventories/legacy.json`,
      );
    }
    const key = `${uiBehaviorId}::${runtimeState}`;
    if (frame.id !== key) fail(`${at}.id must be '${key}'`);
    if (frames.has(key)) fail(`${at}.id '${key}' is recorded twice`);
    if (
      !Array.isArray(frame.states) ||
      frame.states.length !== 1 ||
      frame.states[0] !== runtimeState
    ) {
      fail(`${at}.states must be exactly ['${runtimeState}']`);
    }
    // The authority is bound to the pinned legacy tree: a re-capture taken
    // after the legacy source moved cannot pass without an explicit --refresh.
    if (frame.legacyRevision !== state.legacyRevision?.revision) {
      fail(
        `${at}.legacyRevision '${frame.legacyRevision}' is not this record's pinned legacy revision '${state.legacyRevision?.revision}'`,
      );
    }
    if (typeof frame.rootLocator !== "string" || !frame.rootLocator.trim()) {
      fail(
        `${at}.rootLocator must name the element that owns the behavior's surface`,
      );
    }
    const viewport = frame.viewport;
    if (
      !isPlainObject(viewport) ||
      !["width", "height"].every(
        (axis) => Number.isInteger(viewport[axis]) && viewport[axis] > 0,
      )
    ) {
      fail(`${at}.viewport must record positive integer width and height`);
    }
    const capture = frame.capture;
    if (!isPlainObject(capture)) fail(`${at}.capture is required`);
    if (capture.role !== LEGACY_AUTHORITY_ROLE) {
      fail(
        `${at}.capture.role must be '${LEGACY_AUTHORITY_ROLE}'; '${capture.role}' is the role of a different lifecycle slot`,
      );
    }
    if (capture.mode !== "element") {
      fail(
        `${at}.capture.mode must be 'element' (scoped to rootLocator); a full-page capture makes unrelated app chrome dominate the comparison`,
      );
    }
    const compare = capture.compare;
    if (
      !isPlainObject(compare) ||
      !["width", "height"].every(
        (axis) => Number.isInteger(compare[axis]) && compare[axis] > 0,
      )
    ) {
      fail(
        `${at}.capture.compare must declare the positive integer width and height both sides are compared at`,
      );
    }
    if (hardened) {
      try { assertVisualCaptureBlock(frame, capture, at, true); }
      catch (error) { fail(error.message); }
    }
    const extraction = frame.extraction;
    if (
      !isPlainObject(extraction) ||
      typeof extraction.retrievedAt !== "string" ||
      Number.isNaN(Date.parse(extraction.retrievedAt)) ||
      !Array.isArray(extraction.limitations) ||
      !(
        (extraction.fidelity === "COMPLETE" &&
          extraction.limitations.length === 0) ||
        (extraction.fidelity === "DEGRADED" &&
          extraction.limitations.length > 0)
      )
    ) {
      fail(
        `${at}.extraction must record an ISO retrievedAt and fidelity COMPLETE with no limitations, or DEGRADED with every limitation`,
      );
    }
    const sources = isPlainObject(frame.sources) ? frame.sources : {};
    const read = {};
    for (const kind of ["snapshot", "screenshot", "measurements"]) {
      const entry = sources[kind];
      const absolute =
        isPlainObject(entry) && typeof entry.reference === "string"
          ? path.resolve(root, entry.reference)
          : null;
      if (
        !absolute ||
        !isWithin(root, absolute) ||
        !(await fileExists(absolute))
      ) {
        fail(
          `${at}.sources.${kind} must reference a file persisted inside the migration record`,
        );
      }
      // P4: the authority predates every slice, so it can never legitimately
      // live in the target's verification tree. Citing one there would let a
      // post-implementation capture be pinned as the thing it is measured against.
      if (!recordRelative(root, absolute).startsWith(LEGACY_RUNTIME_EVIDENCE_ROOT)) {
        fail(
          `${at}.sources.${kind} '${entry.reference}' does not resolve under ${LEGACY_RUNTIME_EVIDENCE_ROOT}; authority captures and target verification evidence never share a root`,
        );
      }
      if (!(await fileIdentityMatches(entry.hash, absolute))) {
        fail(
          `${at}.sources.${kind} '${entry.reference}' no longer matches its recorded hash; the persisted legacy authority capture is stale`,
        );
      }
      read[kind] = absolute;
    }
    let measurements;
    try {
      measurements = JSON.parse(await readFile(read.measurements, "utf8"));
    } catch (error) {
      fail(`${at}.sources.measurements is not JSON: ${error.message}`);
    }
    if (
      !isPlainObject(measurements) ||
      !isPlainObject(measurements.values) ||
      Object.keys(measurements.values).length === 0
    ) {
      fail(
        `${at}.sources.measurements must parse as {viewport, values} with at least one measured value`,
      );
    }
    if (
      measurements.viewport?.width !== viewport.width ||
      measurements.viewport?.height !== viewport.height
    ) {
      fail(
        `${at}.sources.measurements was captured at viewport ${measurements.viewport?.width}x${measurements.viewport?.height}, the frame declares ${viewport.width}x${viewport.height}`,
      );
    }
    // v2: the frame's facts are *derived* here, from the pinned capture, and
    // never authored. There is no provenance to check because there is no
    // authoring step to distrust -- the measurement file is the provenance.
    // A taxonomy key the capture did not record is a capture defect, refused at
    // ASSESS_TARGET while the capture can still be retaken, rather than
    // discovered at BUILD_BASELINE against an immutable pin. This is also what
    // keeps coverage bounded: the file carries the taxonomy, not a full
    // computed-style dump.
    const missing = hardened
      ? REQUIRED_FACT_NAMES.filter((name) => measurements.values[name] === undefined)
      : [];
    if (missing.length > 0) {
      fail(
        `${at}.sources.measurements records no ${missing.join(", ")}; the pinned authority capture must measure the full visual taxonomy (${REQUIRED_FACT_NAMES.join(", ")}) because the visual contract is derived from it and cannot assert what was never captured`,
      );
    }
    if (hardened && !Object.entries(measurements.values).some(
      ([name, value]) => REQUIRED_FACT_KINDS[name] === undefined && Number.isInteger(value) && value >= 0,
    )) {
      fail(`${at}.sources.measurements has no non-negative integer structure count outside the named taxonomy facts`);
    }
    const facts = {};
    if (hardened) {
      for (const [name, raw] of Object.entries(measurements.values)) {
        try {
          facts[name] = { value: normalizeVisualValue(name, raw) };
        } catch (error) {
          fail(`${at}.sources.measurements ${error.message}`);
        }
      }
    }
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(read.snapshot, "utf8"));
    } catch (error) {
      fail(`${at}.sources.snapshot is not JSON: ${error.message}`);
    }
    if (snapshot?.proofFormat !== UI_PROOF_FORMAT) {
      fail(
        `${at}.sources.snapshot is not '${UI_PROOF_FORMAT}' structured proof (proofFormat '${snapshot?.proofFormat}')`,
      );
    }
    const controls = snapshot?.observation?.controls;
    if (!Array.isArray(controls) || controls.length === 0) {
      fail(
        `${at}.sources.snapshot.observation.controls must observe at least one control`,
      );
    }
    frames.set(key, { ...frame, key, name: key, measurements, facts });
  }
  return frames;
};

export const assertVisualCaptureBlock = (frame, capture, label, runtime = false, structured = false) => {
  if (!isPlainObject(capture)) throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture is required`);
  if (structured) {
    assertStructuredCaptureScale(capture, frame.viewport);
    return;
  }
  if (capture.mode !== "element" || typeof frame.rootLocator !== "string" || !frame.rootLocator.trim()) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label} requires an element capture scoped to the authority rootLocator`);
  }
  if (capture.rootLocator !== frame.rootLocator) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.rootLocator must equal '${frame.rootLocator}'`);
  }
  if (!Number.isFinite(capture.deviceScaleFactor) || capture.deviceScaleFactor <= 0 ||
      (runtime && capture.deviceScaleFactor !== 1)) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.deviceScaleFactor must be 1 for a runtime element capture`);
  }
  if (!["light", "dark", "no-preference"].includes(capture.colorScheme)) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.colorScheme must be a Playwright color scheme`);
  }
  if (capture.reducedMotion !== "reduce") {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.reducedMotion must be reduce`);
  }
  if (typeof capture.matte !== "string" || !/^#[0-9a-f]{6}$/i.test(capture.matte)) {
    throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.matte must be an opaque #RRGGBB color`);
  }
  for (const dimensions of [capture.compare, capture]) {
    const fields = dimensions === capture ? ["imageWidth", "imageHeight"] : ["width", "height"];
    if (!isPlainObject(dimensions) || fields.some((field) => !Number.isInteger(dimensions[field]) || dimensions[field] <= 0)) {
      throw new Error(`VISUAL_CAPTURE_MISMATCH: ${label}.capture.${dimensions === capture ? "imageWidth/imageHeight" : "compare"} must be positive integers`);
    }
  }
};
