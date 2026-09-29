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

const measurements = {
  viewport: { width: 1280, height: 720 },
  values: { contentWidth: 1180, backgroundColor: "#ffffff" },
};

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
  write(root, LEGACY_RUNTIME_CONTEXT_FILE, { version: 1, frames });

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
      version: 1,
      rows: [
        {
          id: "VIS-1",
          uiBehaviorId: "UIB-1",
          state: "DEFAULT",
          legacyFrameId: FRAME_ID,
          viewport: { width: 1280, height: 720 },
          tolerance: { px: 1, ratio: 0 },
          expect: {
            contentWidth: { kind: "px", value: 1180, locator: "main" },
            backgroundColor: {
              kind: "equals",
              value: "#ffffff",
              locator: "main",
            },
          },
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
      version: 1,
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
