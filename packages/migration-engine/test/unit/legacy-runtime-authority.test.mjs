// Focused Slice A coverage: `legacy-runtime` as a pinned visual authority.
//
// Every scenario drives the *shared* format-17 machinery -- the same
// `validateVisualAcceptance` / `compareVisualFact` path `figma-mcp` uses -- so a
// second visual-verification architecture would fail these tests rather than
// pass them. Fixtures are isolated `mkdtemp` records; nothing here touches a
// real migration.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveDesignSource } from "../../src/migration-utils.mjs";
import {
  compareVisualFact,
  LEGACY_AUTHORITY_ROLE,
  LEGACY_RUNTIME_CONTEXT_FILE,
  TARGET_VERIFICATION_ROLE,
  UI_PROOF_FORMAT,
  validateLegacyRuntimeContext,
  validateVisualAcceptance,
  VISUAL_ACCEPTANCE_FILE,
  VISUAL_ACCEPTANCE_FORMAT,
  VISUAL_AUTHORITIES,
  visualAuthorityOf,
} from "../../src/resumable-migration.mjs";

const REVISION = "a".repeat(40);
const FRAME_ID = "UIB-1::DEFAULT";
const AUTHORITY_DIR = "inventories/legacy-runtime/UIB-1-DEFAULT";

const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const write = async (root, relative, body) => {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  const bytes =
    typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  await writeFile(absolute, bytes);
  return sha256(bytes);
};

const legacyInventory = {
  version: 1,
  hasVisibleUi: true,
  uiBehaviors: [
    { id: "UIB-1", behaviorId: "BEH-1", runtimeStates: ["DEFAULT"] },
  ],
  behaviors: [],
  routeFlows: [],
};

// v2: the authority capture carries exactly the visual taxonomy, because the
// contract is *derived* from it and cannot assert what was never measured.
const measurements = {
  viewport: { width: 1280, height: 720 },
  values: {
    width: 1180,
    height: 640,
    padding: "16px",
    gap: "12px",
    color: "rgb(22, 32, 44)",
    backgroundColor: "#ffffff",
    borderColor: "rgb(217, 225, 234)",
    borderWidth: "1px",
    borderRadius: "4px",
    fontFamily: '"Segoe UI", Roboto, sans-serif',
    fontSize: "14px",
    fontWeight: "normal",
    lineHeight: "20px",
    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
    opacity: "1",
    visibility: "visible",
    assets: ["icon/plus", "logo/mark"],
    rows: 6,
  },
};

/** The taxonomy as a contract row's `expect`, in the authority's own values. */
const taxonomyExpect = () => ({
  width: { kind: "px", value: 1180, locator: "main" },
  height: { kind: "px", value: 640, locator: "main" },
  padding: { kind: "px", value: 16, locator: "main" },
  gap: { kind: "px", value: 12, locator: "main" },
  color: { kind: "equals", value: "#16202c", locator: "main" },
  backgroundColor: { kind: "equals", value: "#ffffff", locator: "main" },
  borderColor: { kind: "equals", value: "#d9e1ea", locator: "main" },
  borderWidth: { kind: "px", value: 1, locator: "main" },
  borderRadius: { kind: "px", value: 4, locator: "main" },
  fontFamily: { kind: "equals", value: "Segoe UI, Roboto, sans-serif", locator: "main" },
  fontSize: { kind: "px", value: 14, locator: "main" },
  fontWeight: { kind: "equals", value: 400, locator: "main" },
  lineHeight: { kind: "px", value: 20, locator: "main" },
  boxShadow: { kind: "equals", value: "0 1px 2px rgba(0,0,0,0.2)", locator: "main" },
  opacity: { kind: "equals", value: 1, locator: "main" },
  visibility: { kind: "equals", value: "visible", locator: "main" },
  assets: { kind: "equals", value: ["logo/mark", "icon/plus"], locator: "main img" },
  rows: { kind: "count", value: 6, locator: "getByRole('row')" },
});

const snapshot = {
  proofFormat: UI_PROOF_FORMAT,
  observation: {
    url: "http://localhost:4200/flights",
    controls: [{ role: "heading", name: "Flights", state: "DEFAULT" }],
  },
};

const frameFor = (hashes, overrides = {}) => ({
  id: FRAME_ID,
  uiBehaviorId: "UIB-1",
  state: "DEFAULT",
  states: ["DEFAULT"],
  viewport: { width: 1280, height: 720 },
  url: "http://localhost:4200/flights",
  rootLocator: "getByRole('main')",
  legacyRevision: REVISION,
  capturedAt: "2026-09-29T10:00:00.000Z",
  capture: {
    role: LEGACY_AUTHORITY_ROLE,
    mode: "element",
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    compare: { width: 1180, height: 640 },
  },
  extraction: {
    retrievedAt: "2026-09-29T10:00:00.000Z",
    fidelity: "COMPLETE",
    limitations: [],
  },
  sources: {
    snapshot: {
      reference: `${AUTHORITY_DIR}/snapshot.json`,
      hash: hashes.snapshot,
    },
    screenshot: {
      reference: `${AUTHORITY_DIR}/screenshot.png`,
      hash: hashes.screenshot,
    },
    measurements: {
      reference: `${AUTHORITY_DIR}/observations.json`,
      hash: hashes.measurements,
    },
  },
  ...overrides,
});

const state = () => ({
  formatVersion: VISUAL_ACCEPTANCE_FORMAT,
  migrationId: "flights",
  designSource: "legacy-runtime",
  legacyRevision: { revision: REVISION, pathScoped: true },
  artifactHashes: {},
});

/** One pinned authority record, byte-identical screenshot bytes on both sides. */
const createRecord = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-authority-"));
  await write(root, "inventories/legacy.json", legacyInventory);
  const hashes = {
    snapshot: await write(root, `${AUTHORITY_DIR}/snapshot.json`, snapshot),
    screenshot: await write(
      root,
      `${AUTHORITY_DIR}/screenshot.png`,
      "PNG-BYTES-IDENTICAL",
    ),
    measurements: await write(
      root,
      `${AUTHORITY_DIR}/observations.json`,
      measurements,
    ),
  };
  // The same bytes at the target's own disjoint path: a perfect 1:1 match.
  await write(
    root,
    "evidence/slice-1/ui/screenshot.png",
    "PNG-BYTES-IDENTICAL",
  );
  await writeContext(root, [frameFor(hashes)]);
  return { root, hashes };
};

const writeContext = (root, frames) =>
  write(root, LEGACY_RUNTIME_CONTEXT_FILE, { version: 2, frames });

const rejects = async (root, pattern, overrides) => {
  const { hashes } = overrides;
  await writeContext(root, [frameFor(hashes, overrides.frame)]);
  await assert.rejects(
    () => validateLegacyRuntimeContext(root, state()),
    pattern,
  );
};

test("legacy-17: legacy-runtime is a design source and refuses --figma", () => {
  assert.deepEqual(
    resolveDesignSource({ designSource: "legacy-runtime" }),
    { designSource: "legacy-runtime", figmaSources: [] },
  );
  assert.throws(
    () =>
      resolveDesignSource({
        designSource: "legacy-runtime",
        figma: ["https://www.figma.com/design/abc?node-id=1-2"],
      }),
    /--figma links require --design-source figma-mcp/,
  );
  // Neither existing source changed shape.
  assert.deepEqual(resolveDesignSource({}), {
    designSource: "target-system",
    figmaSources: [],
  });
  assert.equal(
    resolveDesignSource({
      designSource: "figma-mcp",
      figma: ["https://www.figma.com/design/abc?node-id=1-2"],
    }).figmaSources.length,
    1,
  );
});

test("legacy-17: the authority adapter is the one pluggable seam", () => {
  assert.deepEqual(Object.keys(VISUAL_AUTHORITIES).sort(), [
    "figma-mcp",
    "legacy-runtime",
  ]);
  assert.equal(
    visualAuthorityOf(state()).contextFile,
    LEGACY_RUNTIME_CONTEXT_FILE,
  );
  assert.equal(
    visualAuthorityOf({ ...state(), designSource: "figma-mcp" }).contextFile,
    "inventories/figma-context.json",
  );
  assert.equal(
    visualAuthorityOf({ ...state(), designSource: "target-system" }),
    null,
  );
  assert.equal(
    visualAuthorityOf(state()).boundToDigestField,
    "visualContextDigest",
  );
});

test("legacy-17: a valid authority frame validates and carries its capture role", async () => {
  const { root } = await createRecord();
  try {
    const frames = await validateLegacyRuntimeContext(root, state());
    assert.deepEqual([...frames.keys()], [FRAME_ID]);
    const frame = frames.get(FRAME_ID);
    assert.equal(frame.capture.role, LEGACY_AUTHORITY_ROLE);
    assert.equal(frame.capture.mode, "element");
    assert.deepEqual(frame.capture.compare, { width: 1180, height: 640 });
    assert.deepEqual(frame.measurements.values, measurements.values);
    // Re-validation is byte-stable: the same digest survives every resume.
    const again = await validateLegacyRuntimeContext(root, state());
    assert.deepEqual(
      again.get(FRAME_ID).sources,
      frame.sources,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy-17: the contract reaches compareVisualFact through the shared path", async () => {
  const { root } = await createRecord();
  try {
    await write(root, VISUAL_ACCEPTANCE_FILE, {
      version: 2,
      rows: [
        {
          id: "VIS-1",
          uiBehaviorId: "UIB-1",
          state: "DEFAULT",
          legacyFrameId: FRAME_ID,
          viewport: { width: 1280, height: 720 },
          expect: taxonomyExpect(),
        },
      ],
      unbacked: [],
    });
    const rows = await validateVisualAcceptance(
      root,
      state(),
      legacyInventory,
      { uiMismatches: [] },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].legacyFrameId, FRAME_ID);

    // A row naming no pinned frame is refused by the same adapter lookup.
    await write(root, VISUAL_ACCEPTANCE_FILE, {
      version: 2,
      rows: [
        {
          ...rows[0],
          legacyFrameId: "UIB-1::MISSING",
        },
      ],
      unbacked: [],
    });
    await assert.rejects(
      () =>
        validateVisualAcceptance(root, state(), legacyInventory, {
          uiMismatches: [],
        }),
      /legacyFrameId 'UIB-1::MISSING' is not a frame in inventories\/legacy-runtime-context\.json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy-17: byte-identical authority and target screenshots at disjoint paths PASS", async () => {
  const { root } = await createRecord();
  try {
    const authority = await readFile(
      path.join(root, AUTHORITY_DIR, "screenshot.png"),
    );
    const target = await readFile(
      path.join(root, "evidence/slice-1/ui/screenshot.png"),
    );
    // The premise of the assertion: the bytes really are identical.
    assert.equal(sha256(authority), sha256(target));
    // And the authority still validates. No rule anywhere compares an
    // authority hash to a target hash for inequality.
    await validateLegacyRuntimeContext(root, state());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy-17: every authority defect is refused fail-closed", async () => {
  const { root, hashes } = await createRecord();
  try {
    await rejects(root, /is not a discovered state of a UI behavior/, {
      hashes,
      frame: { id: "UIB-1::MISSING", state: "MISSING", states: ["MISSING"] },
    });
    // legacyRevision mismatch: a re-capture after the legacy tree moved.
    await rejects(root, /is not this record's pinned legacy revision/, {
      hashes,
      frame: { legacyRevision: "b".repeat(40) },
    });
    // P5: the authority slot cannot declare the target's role.
    await rejects(root, /capture\.role must be 'LEGACY_AUTHORITY'/, {
      hashes,
      frame: {
        capture: {
          ...frameFor(hashes).capture,
          role: TARGET_VERIFICATION_ROLE,
        },
      },
    });
    await rejects(root, /capture\.mode must be 'element'/, {
      hashes,
      frame: {
        capture: { ...frameFor(hashes).capture, mode: "fullPage" },
      },
    });
    await rejects(root, /capture\.compare must declare/, {
      hashes,
      frame: {
        capture: { ...frameFor(hashes).capture, compare: undefined },
      },
    });
    await rejects(root, /rootLocator must name the element/, {
      hashes,
      frame: { rootLocator: "" },
    });
    // P4: an authority source may not resolve under the target's evidence
    // tree. The authority's own root is the stricter half of the same rule.
    await rejects(
      root,
      /does not resolve under inventories\/legacy-runtime\/; authority captures and target verification evidence never share a root/,
      {
        hashes,
        frame: {
          sources: {
            ...frameFor(hashes).sources,
            screenshot: {
              reference: "evidence/slice-1/ui/screenshot.png",
              hash: hashes.screenshot,
            },
          },
        },
      },
    );
    // Mutating a pinned authority capture invalidates the record.
    await writeContext(root, [frameFor(hashes)]);
    await write(root, `${AUTHORITY_DIR}/screenshot.png`, "TAMPERED");
    await assert.rejects(
      () => validateLegacyRuntimeContext(root, state()),
      /no longer matches its recorded hash/,
    );
    await write(root, `${AUTHORITY_DIR}/screenshot.png`, "PNG-BYTES-IDENTICAL");
    // A snapshot that is not structured Playwright proof, and one with no
    // controls, are each refused.
    const bad = await write(root, `${AUTHORITY_DIR}/snapshot.json`, {
      proofFormat: "prose/v1",
    });
    await rejects(root, /is not 'playwright-ui-proof\/v1' structured proof/, {
      hashes: { ...hashes, snapshot: bad },
    });
    const empty = await write(root, `${AUTHORITY_DIR}/snapshot.json`, {
      proofFormat: UI_PROOF_FORMAT,
      observation: { url: "http://localhost:4200/flights", controls: [] },
    });
    await rejects(root, /must observe at least one control/, {
      hashes: { ...hashes, snapshot: empty },
    });
    await write(root, `${AUTHORITY_DIR}/snapshot.json`, snapshot);
    // Measurements must parse as {viewport, values} at the frame's viewport.
    const skewed = await write(root, `${AUTHORITY_DIR}/observations.json`, {
      viewport: { width: 360, height: 800 },
      values: measurements.values,
    });
    await rejects(root, /was captured at viewport 360x800/, {
      hashes: { ...hashes, measurements: skewed },
    });
    const valueless = await write(root, `${AUTHORITY_DIR}/observations.json`, {
      viewport: measurements.viewport,
      values: {},
    });
    await rejects(root, /at least one measured value/, {
      hashes: { ...hashes, measurements: valueless },
    });
    // v2: a taxonomy key the capture never recorded is a capture defect, and
    // it is refused here -- while the capture can still be retaken -- rather
    // than at BUILD_BASELINE against an already-immutable pin.
    const { boxShadow: _dropped, ...partial } = measurements.values;
    const incomplete = await write(root, `${AUTHORITY_DIR}/observations.json`, {
      viewport: measurements.viewport,
      values: partial,
    });
    await rejects(root, /records no boxShadow; the pinned authority capture/, {
      hashes: { ...hashes, measurements: incomplete },
    });
    const { rows: _count, ...withoutCount } = measurements.values;
    const noCount = await write(root, `${AUTHORITY_DIR}/observations.json`, {
      viewport: measurements.viewport,
      values: withoutCount,
    });
    await rejects(root, /has no non-negative integer structure count/, {
      hashes: { ...hashes, measurements: noCount },
    });
    // And a value no shared normalization can place is refused, never guessed.
    const unsupported = await write(root, `${AUTHORITY_DIR}/observations.json`, {
      viewport: measurements.viewport,
      values: { ...measurements.values, fontSize: "0.875rem" },
    });
    await rejects(root, /VISUAL_VALUE_UNSUPPORTED: fontSize value "0\.875rem"/, {
      hashes: { ...hashes, measurements: unsupported },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Slice B: the hardened contract, version 2 -------------------------------

/** The legacy inventory with a second required state of the same behavior. */
const twoStateInventory = {
  ...legacyInventory,
  uiBehaviors: [
    { id: "UIB-1", behaviorId: "BEH-1", runtimeStates: ["DEFAULT", "ERROR"] },
  ],
};

/** A v2 contract over the pinned authority, with overrides applied to the row. */
const v2Contract = (row = {}, extra = {}) => ({
  version: 2,
  rows: [
    {
      id: "VIS-1",
      uiBehaviorId: "UIB-1",
      state: "DEFAULT",
      legacyFrameId: FRAME_ID,
      viewport: { width: 1280, height: 720 },
      expect: taxonomyExpect(),
      ...row,
    },
  ],
  unbacked: [],
  ...extra,
});

const contractRejects = async (root, contract, pattern, legacy = legacyInventory) => {
  await write(root, VISUAL_ACCEPTANCE_FILE, contract);
  await assert.rejects(
    () => validateVisualAcceptance(root, state(), legacy, { uiMismatches: [] }),
    pattern,
  );
};

test("v2: the facts the contract asserts are derived from the pinned measurements", async () => {
  const { root } = await createRecord();
  try {
    const frames = await validateLegacyRuntimeContext(root, state());
    const facts = frames.get(FRAME_ID).facts;
    // Derived by the engine and already normalized -- the agent authored none
    // of this, and the capture file is the provenance.
    assert.equal(facts.fontWeight.value, 400);
    assert.equal(facts.backgroundColor.value, "#ffffff");
    assert.equal(facts.color.value, "#16202c");
    assert.equal(facts.fontSize.value, 14);
    assert.equal(facts.fontFamily.value, "segoe ui, roboto, sans-serif");
    assert.deepEqual(facts.assets.value, ["icon/plus", "logo/mark"]);
    assert.equal(facts.rows.value, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2: a full taxonomy verifies; anything less does not", async () => {
  const { root } = await createRecord();
  try {
    await write(root, VISUAL_ACCEPTANCE_FILE, v2Contract());
    const rows = await validateVisualAcceptance(root, state(), legacyInventory, {
      uiMismatches: [],
    });
    // The row comes back normalized, with the fixed tolerance attached, so
    // every comparison site gets the hardened semantics without asking.
    assert.deepEqual(rows[0].tolerance, { px: 1, ratio: 0 });
    assert.equal(rows[0].expect.fontFamily.value, "segoe ui, roboto, sans-serif");

    // A single fact is the thing the taxonomy exists to forbid.
    await contractRejects(
      root,
      v2Contract({ expect: { width: { kind: "px", value: 1180, locator: "main" } } }),
      /VISUAL_CONTRACT_COVERAGE/,
    );
    // A whole group missing.
    const { boxShadow: _shadow, ...noShadow } = taxonomyExpect();
    await contractRejects(
      root,
      v2Contract({ expect: noShadow }),
      /VISUAL_CONTRACT_COVERAGE: .*group\(s\) shadow/s,
    );
    // No bounded count at all.
    const { rows: _rows, ...noCount } = taxonomyExpect();
    await contractRejects(
      root,
      v2Contract({ expect: noCount }),
      /VISUAL_CONTRACT_COVERAGE: .*group\(s\) structure/s,
    );
    // A count with a floor and no ceiling admits 1 and 9000 alike.
    await contractRejects(
      root,
      v2Contract({
        expect: { ...taxonomyExpect(), rows: { kind: "count", min: 1, locator: "tr" } },
      }),
      /VISUAL_COUNT_UNBOUNDED/,
    );
    // Both bounds is how a range is expressed.
    await write(
      root,
      VISUAL_ACCEPTANCE_FILE,
      v2Contract({
        expect: {
          ...taxonomyExpect(),
          rows: { kind: "count", min: 1, max: 20, locator: "tr" },
        },
      }),
    );
    await validateVisualAcceptance(root, state(), legacyInventory, {
      uiMismatches: [],
    });
    await contractRejects(
      root,
      v2Contract({ expect: { ...taxonomyExpect(), rows: { kind: "count", min: 7, max: 9, locator: "tr" } } }),
      /VISUAL_CONTRACT_DIVERGES: .*rows/,
    );
    await contractRejects(
      root,
      v2Contract({ expect: { ...taxonomyExpect(), invented: { kind: "equals", value: "pass", locator: "main" } } }),
      /VISUAL_CONTRACT_PROVENANCE: .*invented/,
    );
    // An authored tolerance is refused outright, not capped.
    await contractRejects(
      root,
      v2Contract({ tolerance: { px: 1, ratio: 0 } }),
      /VISUAL_TOLERANCE_FIXED/,
    );
    // The contract is derived from the authority, never authored beside it.
    await contractRejects(
      root,
      v2Contract({
        expect: {
          ...taxonomyExpect(),
          fontSize: { kind: "px", value: 16, locator: "main" },
        },
      }),
      /VISUAL_CONTRACT_DIVERGES: .*expects 16.*establishes 14/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2: the fixed ±1px admits subpixel drift and refuses two pixels", async () => {
  const { root } = await createRecord();
  try {
    await write(root, VISUAL_ACCEPTANCE_FILE, v2Contract());
    const [row] = await validateVisualAcceptance(root, state(), legacyInventory, {
      uiMismatches: [],
    });
    const compare = (name, observed) =>
      compareVisualFact(row.expect[name], observed, row.tolerance);
    assert.equal(compare("width", 1180), null);
    assert.equal(compare("width", 1180.5), null);
    assert.equal(compare("width", 1179), null);
    assert.match(compare("width", 1182), /expected 1180px ±1, observed 1182/);
    assert.match(compare("width", 1178), /expected 1180px ±1, observed 1178/);
    // A browser rgb() measurement matches a hex authority value: without this
    // a pixel-perfect implementation would fail and v2 would be unusable.
    assert.equal(compare("backgroundColor", "rgb(255, 255, 255)"), null);
    assert.equal(compare("color", "rgb(22, 32, 44)"), null);
    assert.match(compare("color", "rgb(23, 32, 44)"), /observed "#17202c"/);
    assert.equal(compare("fontWeight", "normal"), null);
    assert.equal(compare("fontFamily", '"Segoe UI", Roboto, sans-serif'), null);
    assert.equal(compare("fontSize", "14px"), null);
    assert.equal(compare("assets", ["logo/mark", "icon/plus"]), null);
    assert.match(compare("assets", ["logo/mark"]), /observed \["logo\/mark"\]/);
    // A measurement no normalization can place is not a pass.
    assert.match(compare("fontSize", "0.875rem"), /was measured as "0\.875rem"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2: a newly authored version 1 refuses; an already-pinned one still reads", async () => {
  const { root } = await createRecord();
  try {
    const v1 = {
      version: 1,
      rows: [
        {
          id: "VIS-1",
          uiBehaviorId: "UIB-1",
          state: "DEFAULT",
          legacyFrameId: FRAME_ID,
          viewport: { width: 1280, height: 720 },
          tolerance: { px: 8, ratio: 0.02 },
          expect: { width: { kind: "px", value: 1180, locator: "main" } },
        },
      ],
      unbacked: [],
    };
    await contractRejects(root, v1, /VISUAL_CONTRACT_VERSION: .*declares version 1/);

    // Already pinned before v2 existed: compatibility, not certification. The
    // v1 ceilings, the one-fact row and the authored tolerance all still read.
    const pinned = {
      ...state(),
      artifactHashes: { [VISUAL_ACCEPTANCE_FILE]: "pinned" },
    };
    const rows = await validateVisualAcceptance(root, pinned, legacyInventory, {
      uiMismatches: [],
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].tolerance, { px: 8, ratio: 0.02 });
    assert.equal(rows[0].expect.width.normalized, undefined);
    assert.equal(
      compareVisualFact(rows[0].expect.width, 1174, rows[0].tolerance),
      null,
      "a v1 record keeps its own tolerance",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2: a state cannot be waived while its sibling was captured", async () => {
  const { root, hashes } = await createRecord();
  try {
    const waived = {
      uiBehaviorId: "UIB-1",
      state: "ERROR",
      reason: "Assumed unreachable.",
    };
    // DEFAULT was captured from the running app, so the rig demonstrably
    // reaches this behavior: "capture 1 of 6 states, waive 5" is refused
    // before the operator is ever consulted.
    await contractRejects(
      root,
      v2Contract({}, { unbacked: [waived] }),
      /VISUAL_SIBLING_STATE_CAPTURED: .*state 'ERROR'.*state\(s\) 'DEFAULT' of the same behavior were captured/s,
      twoStateInventory,
    );

    // With the state's own frame recording what stopped its capture, the
    // waiver returns to being the operator's call.
    await write(root, LEGACY_RUNTIME_CONTEXT_FILE, {
      version: 2,
      frames: [
        frameFor(hashes),
        frameFor(hashes, {
          id: "UIB-1::ERROR",
          state: "ERROR",
          states: ["ERROR"],
          extraction: {
            retrievedAt: "2026-09-29T10:00:00.000Z",
            fidelity: "DEGRADED",
            limitations: ["the error state needs a backend fault we cannot induce"],
          },
        }),
      ],
    });
    await contractRejects(
      root,
      v2Contract({}, { unbacked: [waived] }),
      /VISUAL_UNBACKED_REQUIRES_OPERATOR/,
      twoStateInventory,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
