import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

import {
  FIXED_VISUAL_TOLERANCE,
  HARDENED_VISUAL_VERSION,
  decodePng,
  resampleTo,
  perceptualDelta,
  structuralDelta,
  REQUIRED_FACTS,
  REQUIRED_FACT_KINDS,
  REQUIRED_FACT_NAMES,
  assertProvenancePrecedence,
  missingRequiredGroups,
  normalizeVisualValue,
  resolveDesignContextFact,
  resolveMetadataFact,
  resolveMetadataAssets,
  resolveVariableDefsFact,
  variableValueSet,
  xmlAttribute,
  captureStructuredNode,
  extractStructuredFacts,
  structuredDigest,
  structuredEvidenceDigest,
  structuredAssetIdentity,
  extractNodeLiterals,
  resolveVisualProvenance,
  deriveStructuredAuthority,
  validateStructuredContract,
  compareStructuredTarget,
  structuredCapabilityProfile,
  assertStructuredCaptureScale,
  figmaStroke,
  figmaShadows,
  strokeFromComputedStyle,
} from "../../src/visual-evidence.mjs";
import { compareVisualFact } from "../../src/resumable-migration.mjs";
import { structuredNodes } from "../support/structured-figma-fixture.mjs";

const raster = (scale = 1, shift = 0, alpha = 255) => {
  const image = new PNG({ width: 40 * scale, height: 20 * scale });
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const offset = (y * image.width + x) * 4;
    const dark = x >= (5 + shift) * scale && x < (20 + shift) * scale && y >= 4 * scale && y < 15 * scale;
    image.data.fill(dark ? 20 : 240, offset, offset + 3);
    image.data[offset + 3] = alpha;
  }
  return image;
};

test("Slice C: PNG decode, 2x box filter, alpha matte, and pixel deltas", () => {
  const image = raster();
  const compare = { width: 40, height: 20, matte: "#ffffff" };
  assert.equal(perceptualDelta(image, image, compare).diffPixels, 0);
  assert.deepEqual(resampleTo(raster(2), 40, 20).data, image.data);
  assert.equal(perceptualDelta(raster(2), image, compare).diffPixels, 0);
  assert.ok(perceptualDelta(image, raster(1, 4), compare).diffRatio > 0.05);
  assert.equal(perceptualDelta(raster(1, 0, 0), raster(1, 4, 0), compare).diffPixels, 0);
  assert.equal(perceptualDelta(raster(1, 0, 0), raster(1, 4, 0), { ...compare, matte: "#000000" }).diffPixels, 0);
  assert.equal(decodePng(PNG.sync.write(image)).width, 40);
  assert.throws(() => decodePng(Buffer.from("not a PNG")), /VISUAL_PNG_INVALID/);
  const translucent = { width: 1, height: 1, data: Buffer.from([255, 0, 0, 128]) };
  const onWhite = { width: 1, height: 1, data: Buffer.from([255, 127, 127, 255]) };
  assert.equal(perceptualDelta(translucent, onWhite, { width: 1, height: 1, matte: "#ffffff" }).diffPixels, 0);
  assert.equal(perceptualDelta(translucent, onWhite, { width: 1, height: 1, matte: "#000000" }).diffPixels, 1);
});

test("Slice C: antialiasing-only edge pixels are excluded", () => {
  const a = Buffer.alloc(5 * 5 * 4, 255);
  const b = Buffer.from(a);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 2; x++) {
    const offset = (y * 5 + x) * 4;
    a.fill(0, offset, offset + 3);
    b.fill(0, offset, offset + 3);
  }
  for (let y = 1; y < 4; y++) {
    a.fill(128, (y * 5 + 2) * 4, (y * 5 + 2) * 4 + 3);
    b.fill(180, (y * 5 + 2) * 4, (y * 5 + 2) * 4 + 3);
  }
  assert.equal(pixelmatch(a, b, null, 5, 5, { includeAA: true }), 3);
  assert.equal(perceptualDelta({ width: 5, height: 5, data: a }, { width: 5, height: 5, data: b }, { width: 5, height: 5, matte: "#ffffff" }).diffPixels, 0);
});

test("Slice C: control multiset reports missing, extra, and multiplicity", () => {
  const button = { role: "button", name: "Save" };
  const link = { role: "link", name: "Help" };
  assert.deepEqual(structuralDelta([button], [button]), { missing: [], extra: [], countDiffs: [] });
  assert.deepEqual(structuralDelta([button], []).missing, [{ ...button, count: 1 }]);
  assert.deepEqual(structuralDelta([button], [button, button]).countDiffs, [{ ...button, expected: 1, actual: 2 }]);
  assert.deepEqual(structuralDelta([button], [button, link]).extra, [{ ...link, count: 1 }]);
});

// The pure half of the hardened visual contract: values in, values or refusals
// out. No fixtures, no filesystem, no engine -- if any of this needed one, the
// module would not be shareable by both engines, which is the point of it.

const refuses = (property, raw) =>
  assert.throws(
    () => normalizeVisualValue(property, raw),
    /VISUAL_VALUE_UNSUPPORTED/,
    `${property}: ${JSON.stringify(raw)} should be refused`,
  );

// --- normalization -----------------------------------------------------------

test("normalize: rgb() and hex land in the same colour space", () => {
  const expected = "#0b5fff";
  for (const spelling of [
    "#0B5FFF",
    "#0b5fff",
    "rgb(11, 95, 255)",
    "rgb(11 95 255)",
    "rgba(11, 95, 255, 1)",
  ]) {
    assert.equal(normalizeVisualValue("color", spelling), expected, spelling);
  }
  // The whole reason this exists: a Figma hex authority value and a browser
  // rgb() measurement are one assertion, not two.
  assert.equal(
    normalizeVisualValue("backgroundColor", "#0B5FFF"),
    normalizeVisualValue("backgroundColor", "rgb(11, 95, 255)"),
  );
  assert.equal(normalizeVisualValue("borderColor", "#ABC"), "#aabbcc");
  assert.equal(normalizeVisualValue("color", "transparent"), "#00000000");
  assert.equal(normalizeVisualValue("color", "rgba(0, 0, 0, 0.5)"), "#00000080");
  refuses("color", "rgba(0, 0, 0, 2)");
});

test("normalize: named colours, hsl() and unresolved variables refuse", () => {
  for (const raw of ["red", "hsl(220, 100%, 52%)", "currentColor", "var(--brand)", "#12345"]) {
    refuses("color", raw);
  }
});

test("normalize: px, unitless and percentage lengths", () => {
  assert.equal(normalizeVisualValue("width", 1180), 1180);
  assert.equal(normalizeVisualValue("width", "1180px"), 1180);
  assert.equal(normalizeVisualValue("width", "1180"), 1180);
  assert.equal(normalizeVisualValue("lineHeight", "20PX"), 20);
  assert.equal(normalizeVisualValue("borderRadius", "8.5px"), 8.5);
  assert.equal(normalizeVisualValue("padding", 0), 0);
  // A percentage stays a percentage: resolving it needs a containing box the
  // contract does not pin, so it compares literally rather than being guessed.
  assert.equal(normalizeVisualValue("width", "50%"), "50%");
  assert.equal(normalizeVisualValue("width", "50.0%"), "50%");
});

test("normalize: context-dependent units refuse rather than coerce", () => {
  for (const raw of ["1rem", "2em", "10vh", "12pt", "3ch", "auto", "normal", "calc(100% - 8px)"]) {
    refuses("fontSize", raw);
  }
});

test("normalize: keyword and numeric font weights", () => {
  assert.equal(normalizeVisualValue("fontWeight", "normal"), 400);
  assert.equal(normalizeVisualValue("fontWeight", "Bold"), 700);
  assert.equal(normalizeVisualValue("fontWeight", 600), 600);
  assert.equal(normalizeVisualValue("fontWeight", "600"), 600);
  // Relative weights depend on an inherited value the contract does not carry.
  refuses("fontWeight", "lighter");
  refuses("fontWeight", "bolder");
  refuses("fontWeight", 0);
});

test("normalize: font family lists are deterministic", () => {
  const expected = "inter, segoe ui, roboto, sans-serif";
  assert.equal(
    normalizeVisualValue("fontFamily", 'Inter, "Segoe UI", Roboto, sans-serif'),
    expected,
  );
  assert.equal(
    normalizeVisualValue("fontFamily", "  inter ,'segoe ui' ,roboto,SANS-SERIF "),
    expected,
  );
  refuses("fontFamily", "  ");
});

test("normalize: the remaining taxonomy kinds", () => {
  assert.equal(normalizeVisualValue("opacity", "0.5"), 0.5);
  refuses("opacity", "1.5");
  assert.equal(normalizeVisualValue("visibility", "Visible"), "visible");
  refuses("visibility", "shown");
  // §7.20: a box-shadow is components, never text -- so the browser's
  // serialization and Figma's effect array land on the same records.
  assert.deepEqual(
    normalizeVisualValue("boxShadow", "0 1px  2px   rgba(0,0,0,0.2)"),
    [{ inset: false, offsetX: 0, offsetY: 1, blur: 2, spread: 0, color: "#00000033" }],
  );
  assert.deepEqual(normalizeVisualValue("boxShadow", "none"), []);
  // Paint order does not matter, but duplicate visible assets still count.
  assert.deepEqual(
    normalizeVisualValue("assets", ["icon-b", " icon-a ", "icon-b"]),
    ["icon-a", "icon-b", "icon-b"],
  );
  refuses("assets", "icon-a");
  refuses("assets", ["icon-a", 3]);
  refuses("color", undefined);
});

test("normalize: a fact outside the taxonomy is carried, never reinterpreted", () => {
  assert.equal(normalizeVisualValue("primaryActions", 3), 3);
  assert.equal(normalizeVisualValue("navigation", false), false);
  assert.equal(normalizeVisualValue("layout", " column "), "column");
  assert.deepEqual(normalizeVisualValue("badge", { tone: "warn" }), { tone: "warn" });
});

// --- taxonomy ----------------------------------------------------------------

test("taxonomy: every group is required and structure needs one bounded count", () => {
  assert.equal(REQUIRED_FACTS.length, 12);
  for (const name of ["width", "height", "padding", "gap", "color", "backgroundColor",
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "borderWidth", "borderColor",
    "borderRadius", "boxShadow", "opacity", "visibility", "assets"]) {
    assert.ok(REQUIRED_FACT_NAMES.includes(name), `${name} is in the taxonomy`);
  }
  assert.equal(REQUIRED_FACT_KINDS.width, "px");
  assert.equal(REQUIRED_FACT_KINDS.color, "equals");
  assert.equal(REQUIRED_FACT_KINDS.assets, "equals");
});

test("taxonomy: a one-fact contract cannot cover it", () => {
  const groups = missingRequiredGroups({ width: { kind: "px", value: 10 } });
  assert.ok(groups.length > 5, `one fact leaves ${groups.length} groups open`);
  assert.ok(groups.includes("assets"));
  assert.ok(groups.includes("structure"));
  assert.ok(groups.includes("geometry"), "one geometry fact does not cover the group");

  const full = Object.fromEntries(
    REQUIRED_FACT_NAMES.map((name) => [name, { kind: REQUIRED_FACT_KINDS[name] }]),
  );
  assert.deepEqual(missingRequiredGroups(full), ["structure"]);
  full.rows = { kind: "count", value: 3 };
  assert.deepEqual(missingRequiredGroups(full), []);
  delete full.assets;
  assert.deepEqual(missingRequiredGroups(full), ["assets"]);
  full.assets = { kind: "equals" };
  delete full.borderColor;
  assert.deepEqual(missingRequiredGroups(full), ["border"]);
});

test("the fixed tolerance is exactly ±1px with no ratio allowance", () => {
  assert.deepEqual({ ...FIXED_VISUAL_TOLERANCE }, { px: 1, ratio: 0 });
  assert.equal(HARDENED_VISUAL_VERSION, 2);
});

// --- provenance --------------------------------------------------------------

const METADATA = `<frame id="12:34" name="Sign in" x="0" y="0" width="1180" height="640">
  <instance id="12:40" name="Button" x="16" y="16" width="120" height="36" />
</frame>
`;

test("provenance: metadata resolves the node's own box", () => {
  assert.equal(resolveMetadataFact(METADATA, "12:34", "width", "at"), "1180");
  assert.equal(resolveMetadataFact(METADATA, "12:40", "width", "at"), "120");
  assert.equal(xmlAttribute('<n id="1:2" name="A &amp; B" />', "name"), "A & B");
});

test("provenance: a dangling metadata node or attribute refuses", () => {
  assert.throws(
    () => resolveMetadataFact(METADATA, "99:99", "width", "frames[0].facts.width"),
    /VISUAL_PROVENANCE_DANGLING.*does not describe node '99:99'/s,
  );
  assert.throws(
    () => resolveMetadataFact(METADATA, "12:34", "fill", "at"),
    /VISUAL_PROVENANCE_DANGLING.*no 'fill' attribute/s,
  );
});

test("provenance: metadata assets stay inside their node", () => {
  const metadata = '<frame id="1:1"><vector name="inside" /></frame><frame id="2:2"><vector name="outside" /></frame>';
  assert.deepEqual(resolveMetadataAssets(metadata, "1:1", "assets", "at"), ["inside"]);
  assert.deepEqual(resolveMetadataAssets(metadata, "2:2", "assets", "at"), ["outside"]);
  assert.deepEqual(resolveMetadataAssets('<frame id="3:3"><image name="photo" /><vector name="icon" /></frame>', "3:3", "assets", "at"), ["photo", "icon"]);
  assert.deepEqual(resolveMetadataAssets('<frame id="3:3" />', "3:3", "assets", "at"), []);
  assert.throws(() => resolveMetadataAssets(metadata, "1:1", "vector@name", "at"), /must be 'assets'/);
});

const VARIABLES = {
  "color/primary": "#0B5FFF",
  spacing: { lg: "16px" },
  "radius~sm": "4px",
  "a/b": "2px",
};

test("provenance: an RFC-6901 pointer resolves, a dangling one refuses", () => {
  assert.equal(resolveVariableDefsFact(VARIABLES, "/color~1primary", "at"), "#0B5FFF");
  assert.equal(resolveVariableDefsFact(VARIABLES, "/spacing/lg", "at"), "16px");
  assert.equal(resolveVariableDefsFact(VARIABLES, "/radius~0sm", "at"), "4px");
  for (const pointer of ["/color/primary", "/spacing/xl", "/nope", "/toString", "/__proto__", "color/primary", ""]) {
    assert.throws(
      () => resolveVariableDefsFact(VARIABLES, pointer, "frames[0].facts.color"),
      /VISUAL_PROVENANCE_DANGLING/,
      `pointer ${JSON.stringify(pointer)}`,
    );
  }
});

test("provenance: designContext resolves exactly one unambiguous declaration", () => {
  const text = "font-family: Inter, sans-serif; font-size: 14px;\nline-height: 20px\n";
  assert.equal(resolveDesignContextFact(text, "font-size", "fontSize", "at"), 14);
  assert.equal(
    resolveDesignContextFact(text, "font-family", "fontFamily", "at"),
    "inter, sans-serif",
  );
  // Repeated but identical after normalization is still one value.
  assert.equal(
    resolveDesignContextFact("padding: 16px; padding:16PX;", "padding", "padding", "at"),
    16,
  );
  assert.throws(
    () => resolveDesignContextFact(text, "padding", "padding", "frames[0].facts.padding"),
    /VISUAL_PROVENANCE_DANGLING.*declares no 'padding'/s,
  );
});

test("provenance: conflicting declarations refuse instead of picking one", () => {
  assert.throws(
    () =>
      resolveDesignContextFact(
        "padding: 16px; padding: 24px;",
        "padding",
        "padding",
        "frames[0].facts.padding",
      ),
    /VISUAL_PROVENANCE_AMBIGUOUS.*2 different values/s,
  );
});

test("provenance: geometry cannot be downgraded to a weaker kind", () => {
  for (const kind of ["designContext", "variableDefs"]) {
    assert.throws(
      () =>
        assertProvenancePrecedence({
          property: "width",
          kind,
          value: 1180,
          variableValues: null,
          label: "frames[0].facts.width",
        }),
      /VISUAL_PROVENANCE_PRECEDENCE.*Geometry is read from the node's own box/s,
      kind,
    );
  }
  assert.doesNotThrow(() =>
    assertProvenancePrecedence({
      property: "width",
      kind: "metadata",
      value: 1180,
      variableValues: null,
      label: "at",
    }),
  );
});

test("provenance: a value defined as a variable must be cited as one", () => {
  const values = variableValueSet(VARIABLES, "color");
  assert.ok(values.has(JSON.stringify("#0b5fff")));
  assert.ok(variableValueSet({ brand: "#0B5FFF" }, "color").has(JSON.stringify("#0b5fff")));
  assert.ok(variableValueSet({ large: "16px" }, "padding").has(JSON.stringify(16)));
  assert.equal(variableValueSet({ primaryActions: 1 }, "borderWidth").size, 0);
  assert.throws(
    () =>
      assertProvenancePrecedence({
        property: "color",
        kind: "designContext",
        value: "#0b5fff",
        variableValues: values,
        label: "frames[0].facts.color",
      }),
    /VISUAL_PROVENANCE_PRECEDENCE.*Cite the variableDefs pointer/s,
  );
  // A value the variables do not define has no stronger kind to be forced to.
  assert.doesNotThrow(() =>
    assertProvenancePrecedence({
      property: "color",
      kind: "designContext",
      value: "#123456",
      variableValues: values,
      label: "at",
    }),
  );
  // variableDefs itself is never downgraded by its own set.
  assert.doesNotThrow(() =>
    assertProvenancePrecedence({
      property: "color",
      kind: "variableDefs",
      value: "#0b5fff",
      variableValues: values,
      label: "at",
    }),
  );
});

// --- Structured Plugin API evidence -----------------------------------------

const capture = { tool: "use_figma", operation: "inspect_nodes", parameters: {
  fileKey: "SyntheticDesignFile123", nodeIds: ["7:20", "7:21", "7:22"],
}, timestamp: "2026-07-01T00:00:00.000Z" };
const structured = Object.fromEntries(Object.entries(structuredNodes).map(([nodeId, node]) => [
  nodeId, captureStructuredNode({ nodeId, rawSnapshot: JSON.stringify(node), capture }),
]));
const facts = Object.fromEntries(Object.entries(structured).map(([nodeId, record]) => [
  nodeId, extractStructuredFacts(record),
]));
const fact = (nodeId, property) => facts[nodeId].find((item) => item.property === property);

test("structured capture keeps exact bytes, key presence, hierarchy and deterministic digests", () => {
  const frame = structured["7:20"];
  assert.equal(frame.rawSnapshot, JSON.stringify(structuredNodes["7:20"]));
  assert.equal(frame.digest, structuredDigest(frame.rawSnapshot));
  assert.equal(frame.digest, structuredDigest(frame.rawSnapshot));
  assert.deepEqual(frame.propertyKeys, Object.keys(structuredNodes["7:20"]).sort());
  assert.ok(frame.propertyKeys.includes("strokes"));
  assert.ok(frame.propertyKeys.includes("effects"));
  assert.ok(!structured["7:21"].propertyKeys.includes("strokes"));
  assert.deepEqual(frame.childIds, ["7:21", "7:22"]);
  assert.equal(structured["7:21"].parentId, "7:20");
  assert.equal(structured["7:22"].parentId, "7:20");
  assert.deepEqual(frame.capture, capture);
  assert.notEqual(frame.capture, capture);
  assert.ok(Object.isFrozen(frame));
  assert.ok(Object.isFrozen(frame.capture.parameters));
  assert.equal(fact("7:20", "width").snapshotDigest, frame.digest);
  assert.equal(structuredEvidenceDigest(Object.values(structured)),
    structuredEvidenceDigest(Object.values(structured).reverse()));
  assert.throws(() => structuredEvidenceDigest([frame, frame]), /duplicate nodeId/);
  assert.throws(() => captureStructuredNode({ nodeId: "7:21", rawSnapshot: frame.rawSnapshot, capture }),
    /snapshot node identity/);
  assert.throws(() => captureStructuredNode({ nodeId: "7:20", rawSnapshot: JSON.stringify({
    id: "wrong", nodeId: "7:20",
  }), capture }), /snapshot node identity/);
  assert.throws(() => extractStructuredFacts({ ...frame, rawSnapshot: frame.rawSnapshot.replace('"width":84', '"width":85') }),
    /VISUAL_STRUCTURED_TAMPERED/);
});

test("structured facts retain directional spacing and each node's own geometry and fill", () => {
  for (const [property, value] of Object.entries({ paddingTop: 5, paddingRight: 12,
    paddingBottom: 5, paddingLeft: 9, gap: 5 })) {
    assert.equal(fact("7:20", property)?.value, value);
    assert.equal(fact("7:20", property)?.nodeId, "7:20");
  }
  assert.equal(fact("7:20", "gap").rawProperty, "itemSpacing");
  assert.equal(fact("7:20", "padding"), undefined);
  for (const [nodeId, width, height, fill] of [
    ["7:20", 84, 28, "#f3ede2"], ["7:21", 8, 8, "#b5562a"],
    ["7:22", 46, 18, "#5a3d1e"],
  ]) {
    assert.equal(fact(nodeId, "width")?.value, width);
    assert.equal(fact(nodeId, "height")?.value, height);
    assert.equal(fact(nodeId, "fill")?.value, fill);
    assert.equal(fact(nodeId, "fill")?.nodeId, nodeId);
    assert.equal(fact(nodeId, "fill")?.source, "STRUCTURED_NODE");
    assert.equal(fact(nodeId, "opacity")?.value, 1);
    assert.equal(fact(nodeId, "visibility")?.value, "visible");
    assert.equal(fact(nodeId, "visibility")?.rawProperty, "visible");
  }
  assert.deepEqual(fact("7:20", "childIds")?.value, ["7:21", "7:22"]);
  assert.equal(fact("7:21", "parentId")?.value, "7:20");
  assert.equal(fact("7:22", "parentId")?.value, "7:20");
  assert.equal(fact("7:21", "isAsset")?.value, true);
  for (const property of ["borderTopLeftRadius", "borderTopRightRadius",
    "borderBottomRightRadius", "borderBottomLeftRadius"]) {
    assert.equal(fact("7:20", property)?.value, 14);
  }
});

test("structured typography has the text node and numeric weight axis as its source", () => {
  assert.equal(fact("7:22", "fontFamily")?.value, "roboto");
  assert.equal(fact("7:22", "fontStyle")?.value, "Medium");
  assert.equal(fact("7:22", "fontWeight")?.value, 500);
  assert.equal(fact("7:22", "fontWeight")?.rawProperty, "fontVariationAxes.wght");
  assert.equal(fact("7:22", "fontSize")?.value, 12);
  assert.equal(fact("7:22", "lineHeight")?.value, 18);
  assert.equal(fact("7:22", "lineHeight")?.rawProperty, "lineHeight.value");
  for (const property of ["fontFamily", "fontStyle", "fontWeight", "fontSize", "lineHeight"]) {
    assert.equal(fact("7:20", property), undefined);
  }
});

test("empty structured strokes and effects prove absence; missing keys prove nothing", () => {
  assert.equal(fact("7:20", "stroke")?.value, "none");
  assert.deepEqual(fact("7:20", "stroke")?.rawValue, []);
  assert.deepEqual(fact("7:20", "boxShadow")?.value, []);
  assert.equal(fact("7:20", "effects"), undefined, "the raw effect array is no longer a certified fact");
  assert.deepEqual(fact("7:20", "boxShadow")?.rawValue, []);
  assert.equal(fact("7:20", "borderWidth"), undefined);
  assert.equal(fact("7:21", "stroke"), undefined);
  assert.equal(fact("7:21", "boxShadow"), undefined);
  const noCollections = captureStructuredNode({ nodeId: "7:21", rawSnapshot: JSON.stringify({
    id: "7:21", strokeWeight: 2,
  }), capture });
  assert.equal(extractStructuredFacts(noCollections).length, 0);
  const emptyStroke = captureStructuredNode({ nodeId: "7:21", rawSnapshot: JSON.stringify({
    id: "7:21", strokeWeight: 2, strokes: [],
  }), capture });
  assert.equal(extractStructuredFacts(emptyStroke).find((item) => item.property === "borderWidth"), undefined);
  assert.equal(extractStructuredFacts(emptyStroke).find((item) => item.property === "stroke")?.value, "none");
});

test("structured assets retain node identity and deterministic content digest", () => {
  const ellipse = structuredAssetIdentity(structured["7:21"]);
  assert.deepEqual(ellipse, { nodeId: "7:21", type: "ELLIPSE", isAsset: true });
  assert.equal(structuredAssetIdentity(structured["7:20"]), undefined);
  const retrieval = { exportKind: "SVG", mimeType: "image/svg+xml", content: Buffer.from("<svg/>") };
  const withContent = structuredAssetIdentity(structured["7:21"], retrieval);
  assert.equal(withContent.contentDigest, structuredDigest(retrieval.content));
  assert.equal(withContent.contentDigest, structuredAssetIdentity(structured["7:21"], retrieval).contentDigest);
  assert.equal(withContent.exportKind, "SVG");
  assert.equal(withContent.mimeType, "image/svg+xml");
  const png = structuredAssetIdentity(structured["7:21"], {
    exportKind: "PNG", mimeType: "image/png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.notEqual(png.contentDigest, withContent.contentDigest);
  const fallback = captureStructuredNode({ nodeId: "7:29", capture, rawSnapshot: JSON.stringify({
    id: "7:29", parentId: "7:20", type: "ELLIPSE", visible: true,
  }) });
  assert.deepEqual(structuredAssetIdentity(fallback), { nodeId: "7:29", type: "ELLIPSE" });
});

test("explicit gaps, applied strokes, directional weights and effects stay structured", () => {
  const node = captureStructuredNode({ nodeId: "7:20", capture, rawSnapshot: JSON.stringify({
    id: "7:20", rowGap: 3, columnGap: 5,
    strokes: [{ type: "SOLID", color: "#112233" }], strokeWeight: 2, strokeAlign: "INSIDE",
    individualStrokeWeights: { top: 1, right: 2, bottom: 3, left: 4 },
    effects: [{ type: "DROP_SHADOW", visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.2 } }],
  }) });
  const values = extractStructuredFacts(node);
  const get = (property) => values.find((item) => item.property === property)?.value;
  assert.equal(get("rowGap"), 3);
  assert.equal(get("columnGap"), 5);
  assert.equal(get("gap"), undefined);
  assert.equal(get("borderWidth"), 2);
  assert.equal(get("borderColor"), "#112233");
  assert.deepEqual(["Top", "Right", "Bottom", "Left"].map((side) => get(`border${side}Width`)),
    [1, 2, 3, 4]);
  assert.deepEqual(get("stroke"), { applied: true, color: "#112233", style: "solid", align: "inside",
    widths: { top: 1, right: 2, bottom: 3, left: 4 } });
  assert.equal(get("effects"), undefined);
  assert.deepEqual(get("boxShadow"),
    [{ inset: false, offsetX: 0, offsetY: 0, blur: 4, spread: 0, color: "#00000033" }]);
  const rgbaPaint = captureStructuredNode({ nodeId: "7:21", capture, rawSnapshot: JSON.stringify({
    id: "7:21", fills: [{ type: "SOLID", color: { r: 181 / 255, g: 86 / 255, b: 42 / 255 } }],
  }) });
  assert.equal(extractStructuredFacts(rgbaPaint).find((item) => item.property === "fill")?.value, "#b5562a");
});

test("structured provenance keeps strongest support, corroboration and token identity", () => {
  const strong = { ...fact("7:20", "gap"), bindingId: "spacing/gap" };
  const agreeing = { nodeId: "7:20", property: "gap", value: "5px",
    source: "DESIGN_CONTEXT_LITERAL", rawProperty: "gap-[5px]" };
  const binding = { nodeId: "7:20", property: "gap", source: "VARIABLE_BINDING",
    tokenId: "spacing/gap", value: 5 };
  const resolved = resolveVisualProvenance([agreeing, binding, strong], "7:20", "gap");
  assert.equal(resolved.value, 5);
  assert.equal(resolved.support, strong);
  assert.deepEqual(resolved.corroborating, [agreeing]);
  assert.deepEqual(resolved.tokenIds, ["spacing/gap"]);
  assert.throws(() => resolveVisualProvenance([strong, { ...agreeing, value: "8px", rawProperty: "gap-[8px]" }], "7:20", "gap"),
    /VISUAL_PROVENANCE_CONFLICT/);
  assert.throws(() => resolveVisualProvenance([strong, { ...strong, value: 8 }], "7:20", "gap"),
    /VISUAL_PROVENANCE_AMBIGUOUS/);
  assert.throws(() => resolveVisualProvenance([strong, { ...binding, value: 8 }], "7:20", "gap"),
    /VISUAL_PROVENANCE_CONFLICT/);
  assert.equal(resolveVisualProvenance([{ ...binding }], "7:20", "gap"), undefined);
  assert.equal(resolveVisualProvenance([fact("7:20", "gap"), binding], "7:20", "gap").tokenIds,
    undefined);
  assert.throws(() => resolveVisualProvenance([{ ...strong, snapshotDigest: undefined }], "7:20", "gap"),
    /VISUAL_FACT_UNBACKED/);
});

test("semantic Tailwind aliases never establish literal facts", () => {
  for (const rawProperty of ["font-medium", "p-4", "shadow-md", "opacity-50", "rounded-full"]) {
    assert.equal(resolveVisualProvenance([{ nodeId: "7:20", property: "gap", value: 5,
      source: "DESIGN_CONTEXT_LITERAL", rawProperty }], "7:20", "gap"), undefined);
  }
  assert.equal(resolveVisualProvenance([fact("7:20", "gap"), {
    nodeId: "7:20", property: "gap", value: 50,
    source: "DESIGN_CONTEXT_LITERAL", rawProperty: "p-4",
  }], "7:20", "gap").value, 5);
  assert.equal(resolveVisualProvenance([{ nodeId: "7:20", property: "gap", value: 5,
    source: "DESIGN_CONTEXT_LITERAL", rawProperty: "bg-[5px]" }], "7:20", "gap"), undefined);
  assert.equal(resolveVisualProvenance([{ nodeId: "7:20", property: "gap", value: 8,
    source: "DESIGN_CONTEXT_LITERAL", rawProperty: "gap-[5px]" }], "7:20", "gap"), undefined);
});

test("metadata is geometry/ancestry only and pixels cannot certify a semantic fact alone", () => {
  assert.equal(resolveVisualProvenance([{ nodeId: "7:20", property: "fill", value: "#f3ede2",
    source: "METADATA" }], "7:20", "fill"), undefined);
  assert.equal(resolveVisualProvenance([{ nodeId: "7:20", property: "fill", value: "#f3ede2",
    source: "PERCEPTUAL" }], "7:20", "fill"), undefined);
  const geometry = resolveVisualProvenance([{ nodeId: "7:20", property: "width", value: 84,
    source: "METADATA" }], "7:20", "width");
  assert.equal(geometry.value, 84);
  assert.equal(geometry.support.source, "METADATA");
});

test("structured node contract derives all owned facts and compares each target locator", () => {
  const records = Object.entries(structuredNodes).map(([nodeId, node]) =>
    captureStructuredNode({ nodeId, rawSnapshot: JSON.stringify(node), capture }));
  const derive = (overrides = {}) => deriveStructuredAuthority({ records, rootId: "7:20",
    ancestry: (id) => id === "7:20" ? [id] : ["7:20", id],
    assets: [structuredAssetIdentity(records[1], { exportKind: "SVG", mimeType: "image/svg+xml", content: Buffer.from("<svg/>") })],
    screenshotDigest: structuredDigest(Buffer.from("png")), capture: { requested: { width: 84, height: 28, maxDimension: 84 } },
    ...overrides });
  const authority = derive();
  assert.equal(authority.nodes["7:20"].facts.paddingRight.value, 12);
  assert.equal(authority.nodes["7:22"].facts.fontWeight.value, 500);
  assert.equal(authority.nodes["7:20"].facts.stroke.value, "none");
  assert.deepEqual(authority.nodes["7:20"].facts.boxShadow.value, []);
  assert.equal(authority.nodes["7:20"].facts.effects, undefined);
  assert.deepEqual(authority.nodes["7:20"].facts.assets.value, ["7:21"]);
  assert.deepEqual(structuredCapabilityProfile(authority.nodes).unresolved, []);
  const contract = Object.fromEntries(Object.entries(authority.nodes).map(([id, node]) =>
    [id, { targetLocator: id === "7:20" ? "[data-badge]" : `[data-node='${id}']`,
      facts: Object.fromEntries(Object.entries(node.facts).map(([name, fact]) =>
        [name, { kind: "equals", value: fact.value }])) }]));
  const normalized = validateStructuredContract(authority.nodes, contract);
  const observation = { nodes: Object.fromEntries(Object.entries(normalized).map(([id, node]) =>
    [id, { targetLocator: node.targetLocator,
      values: Object.fromEntries(Object.entries(node.expect).map(([name, fact]) => [name, fact.value])) }])) };
  assert.deepEqual(compareStructuredTarget(normalized, observation, (fact, actual) =>
    JSON.stringify(fact.value) === JSON.stringify(actual) ? null : "diverged", {}), []);
  delete contract["7:22"].facts.fontWeight;
  assert.throws(() => validateStructuredContract(authority.nodes, contract), /VISUAL_FACT_OMITTED/);
  contract["7:22"].facts.fontWeight = { kind: "equals", value: 500 };
  contract["7:20"].facts.fontWeight = { kind: "equals", value: 500 };
  assert.throws(() => validateStructuredContract(authority.nodes, contract), /VISUAL_FACT_NODE_MISATTRIBUTED/);
  delete contract["7:20"].facts.fontWeight;
  contract["7:20"].facts.unsupported = { kind: "equals", value: 1 };
  assert.throws(() => validateStructuredContract(authority.nodes, contract), /VISUAL_FACT_UNBACKED/);
  assert.throws(() => derive({ assets: [] }), /VISUAL_ASSET_OMITTED/);
  assert.throws(() => derive({ ancestry: (id) => [id] }), /VISUAL_HIERARCHY_MISMATCH/);
  assert.equal(authority.authorityDigest, derive().authorityDigest);
});

test("structured capture accepts only exact integer scale", () => {
  const frameBox = { width: 1200, height: 900 };
  const capture = (imageWidth, imageHeight) => ({
    requested: { ...frameBox, maxDimension: 1200 }, returned: { imageWidth, imageHeight },
    imageWidth, imageHeight, frameBox, compare: frameBox,
  });
  assert.equal(assertStructuredCaptureScale(capture(1200, 900), frameBox), 1);
  assert.equal(assertStructuredCaptureScale(capture(2400, 1800), frameBox), 2);
  assert.throws(() => assertStructuredCaptureScale(capture(1170, 878), frameBox),
    /VISUAL_CAPTURE_DOWNSCALED/);
});

// --- §7.19 / §7.20: normalized stroke and shadow, synthetic card frame -----

// A synthetic FRAME snapshot in the Plugin API's property shape.
// `individualStrokeWeights` is absent, as on a frame with uniform strokes.
const CARD_SNAPSHOT = readFileSync(
  new URL("../support/structured-figma-card.json", import.meta.url), "utf8",
).trim();
const cardCapture = { tool: "use_figma", operation: "inspect_nodes", parameters: {
  fileKey: "SyntheticDesignFile123", nodeIds: ["8:40"],
}, timestamp: "2026-07-01T00:00:00.000Z" };
const cardRecord = captureStructuredNode({ nodeId: "8:40", rawSnapshot: CARD_SNAPSHOT, capture: cardCapture });
const cardFact = (property) =>
  extractStructuredFacts(cardRecord).find((item) => item.property === property);

const synthetic = (properties) => captureStructuredNode({ nodeId: "8:40", capture: cardCapture,
  rawSnapshot: JSON.stringify({ id: "8:40", type: "FRAME", ...properties }) });
const authorityOf = (record, options = {}) => deriveStructuredAuthority({ records: [record], rootId: "8:40",
  ancestry: () => ["8:40"], assets: [], screenshotDigest: structuredDigest(Buffer.from("png")),
  capture: { requested: { width: 320, height: 96, maxDimension: 320 } }, ...options });
const dimension = (record, name) => {
  const { profile, unresolved } = structuredCapabilityProfile(authorityOf(record).nodes);
  return { state: profile["8:40"][name],
    reason: unresolved.find((item) => item.dimension === name)?.reason };
};

/** The browser's computed style for `border: 1px solid #d4cfc6` + border-box. */
const borderStyles = (overrides = {}) => ({
  borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
  borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
  borderTopColor: "rgb(212, 207, 198)", borderRightColor: "rgb(212, 207, 198)",
  borderBottomColor: "rgb(212, 207, 198)", borderLeftColor: "rgb(212, 207, 198)",
  outlineStyle: "none", outlineWidth: "0px", boxSizing: "border-box", ...overrides,
});

const CARD_STROKE = { applied: true, color: "#d4cfc6", width: 1, style: "solid", align: "inside" };
const CARD_SHADOW = [{ inset: false, offsetX: 0, offsetY: 2, blur: 6, spread: 0, color: "#1c191714" }];

test("the card frame derives one browser-comparable stroke record from its structured paint", () => {
  assert.deepEqual(cardFact("stroke").value, CARD_STROKE);
  assert.equal(cardFact("stroke").rawProperty, "strokes");
  assert.equal(cardFact("stroke").source, "STRUCTURED_NODE");
  assert.equal(cardFact("strokes"), undefined, "the raw paint array is no longer a certified fact");
  // The retained scalars are unchanged by §7.19.
  assert.equal(cardFact("borderWidth").value, 1);
  assert.equal(cardFact("borderColor").value, "#d4cfc6");
  // The browser reaches the identical record from its own measurement.
  assert.deepEqual(normalizeVisualValue("stroke", borderStyles()), CARD_STROKE);
  assert.deepEqual(strokeFromComputedStyle(borderStyles()), CARD_STROKE);
  assert.equal(dimension(cardRecord, "stroke").state, "PARTIALLY_PROVEN");
});

test("the card frame derives one browser-comparable box-shadow list from its structured effect", () => {
  assert.deepEqual(cardFact("boxShadow").value, CARD_SHADOW);
  assert.equal(cardFact("boxShadow").rawProperty, "effects");
  assert.equal(cardFact("effects"), undefined);
  // Chromium serializes the same shadow colour-first; both sides quantize the
  // 0.08 alpha to the same two hex digits.
  assert.deepEqual(normalizeVisualValue("boxShadow", "rgba(28, 25, 23, 0.08) 0px 2px 6px 0px"), CARD_SHADOW);
  assert.deepEqual(normalizeVisualValue("boxShadow", "0 2px 6px rgba(28,25,23,0.08)"), CARD_SHADOW);
  assert.equal(dimension(cardRecord, "effects").state, "PARTIALLY_PROVEN");
});

test("the card frame compares clean against a matching target and diverges on every real difference", () => {
  const authority = authorityOf(cardRecord);
  const expect = Object.fromEntries(Object.entries(authority.nodes["8:40"].facts)
    .map(([name, fact]) => [name, { kind: "equals", value: fact.value }]));
  const contract = validateStructuredContract(authority.nodes,
    { "8:40": { targetLocator: "[data-node-id='8:40']", facts: expect } });
  const measure = (overrides = {}) => ({ nodes: { "8:40": { targetLocator: "[data-node-id='8:40']",
    values: { ...Object.fromEntries(Object.entries(expect).map(([name, fact]) => [name, fact.value])),
      stroke: borderStyles(), boxShadow: "rgba(28, 25, 23, 0.08) 0px 2px 6px 0px", ...overrides } } } });
  const compare = (overrides) =>
    compareStructuredTarget(contract, measure(overrides), compareVisualFact, FIXED_VISUAL_TOLERANCE);
  assert.deepEqual(compare(), []);
  // Each divergence the plan names, measured from the browser side only.
  for (const [label, overrides] of Object.entries({
    width: { stroke: borderStyles({ borderTopWidth: "3px", borderRightWidth: "3px",
      borderBottomWidth: "3px", borderLeftWidth: "3px" }) },
    color: { stroke: borderStyles({ borderTopColor: "rgb(120, 113, 108)" }) },
    outline: { stroke: { outlineStyle: "solid", outlineWidth: "1px", outlineOffset: "0px",
      outlineColor: "rgb(212, 207, 198)", boxSizing: "border-box" } },
    contentBox: { stroke: borderStyles({ boxSizing: "content-box" }) },
    absent: { stroke: borderStyles({ borderTopStyle: "none", borderRightStyle: "none",
      borderBottomStyle: "none", borderLeftStyle: "none" }) },
    shadowBlur: { boxShadow: "rgba(28, 25, 23, 0.08) 0px 2px 7px 0px" },
    shadowAlpha: { boxShadow: "rgba(28, 25, 23, 0.16) 0px 2px 6px 0px" },
    shadowAbsent: { boxShadow: "none" },
  })) {
    assert.equal(compare(overrides).length, 1, `${label} diverges`);
  }
  // §7.19 compares every width as `px` at the run's fixed tolerance, so a 2px
  // border against a 1px stroke is *within* ±1px and does not diverge. Only
  // the per-side shape changes: uniform `width` becomes per-side `widths`.
  assert.deepEqual(compare({ stroke: borderStyles({ borderTopWidth: "2px",
    borderRightWidth: "2px", borderBottomWidth: "2px", borderLeftWidth: "2px" }) }), []);
  assert.match(compare({ stroke: borderStyles({ borderTopWidth: "2px" }) })[0],
    /stroke fields.*"width".*widths\.bottom/s);
});

test("stroke absence is unchanged and still satisfies FRAME.stroke", () => {
  assert.equal(fact("7:20", "stroke").value, "none");
  assert.deepEqual(fact("7:20", "stroke").rawValue, []);
  assert.equal(fact("7:20", "borderWidth"), undefined);
  assert.equal(dimension(synthetic({ strokes: [] }), "stroke").state, "PARTIALLY_PROVEN");
  // §7.8 guard 2: a weight without a paint still proves "none", never a width.
  const weighted = extractStructuredFacts(synthetic({ strokes: [], strokeWeight: 2 }));
  assert.equal(weighted.find((item) => item.property === "stroke").value, "none");
  assert.equal(weighted.find((item) => item.property === "borderWidth"), undefined);
  assert.equal(normalizeVisualValue("stroke", "none"), "none");
  assert.equal(normalizeVisualValue("stroke", { borderTopStyle: "none", outlineStyle: "none" }), "none");
});

test("effect absence is unchanged and still satisfies FRAME.effects", () => {
  assert.deepEqual(fact("7:20", "boxShadow").value, []);
  assert.equal(dimension(synthetic({ effects: [] }), "effects").state, "PARTIALLY_PROVEN");
  assert.deepEqual(normalizeVisualValue("boxShadow", []), []);
  // An invisible effect is not an applied effect; it is dropped, not certified.
  const invisible = synthetic({ effects: [{ type: "DROP_SHADOW", visible: false, radius: 8,
    color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 } }] });
  assert.deepEqual(extractStructuredFacts(invisible).find((item) => item.property === "boxShadow").value, []);
});

test("structured fills certify one solid and fail closed on mixed applied paints", () => {
  const solid = { type: "SOLID", color: "#123456" };
  const gradient = { type: "GRADIENT_LINEAR", gradientStops: [] };
  const image = { type: "IMAGE", imageHash: "image-1" };
  assert.equal(extractStructuredFacts(synthetic({ fills: [solid] })).find((item) => item.property === "fill")?.value,
    "#123456");
  assert.equal(dimension(synthetic({ fills: [solid] }), "fill").state, "PARTIALLY_PROVEN");
  assert.equal(extractStructuredFacts(synthetic({ fills: [] })).find((item) => item.property === "fill"), undefined);
  assert.equal(dimension(synthetic({ fills: [] }), "fill").state, "NOT_PROVABLE");
  for (const [paints, reason] of [
    [[solid, gradient], "VISUAL_FILL_UNSUPPORTED: multiple applied paints"],
    [[solid, image], "VISUAL_FILL_UNSUPPORTED: multiple applied paints"],
    [[gradient, image], "VISUAL_FILL_UNSUPPORTED: multiple applied paints"],
    [[gradient], "VISUAL_FILL_UNSUPPORTED: GRADIENT_LINEAR"],
    [[image], "VISUAL_FILL_UNSUPPORTED: IMAGE"],
  ]) {
    const record = synthetic({ fills: paints });
    assert.equal(extractStructuredFacts(record).find((item) => item.property === "fill"), undefined);
    const authority = authorityOf(record);
    assert.equal(authority.nodes["8:40"].facts.fill, undefined);
    assert.deepEqual(dimension(record, "fill"), { state: "NOT_PROVABLE", reason });
    assert.equal(structuredCapabilityProfile(authority.nodes, true).profile["8:40"].fill, "NOT_PROVABLE");
  }
});

test("unsupported structured fill cannot be replaced by a weaker design-context literal", () => {
  const record = synthetic({ fills: [{ type: "SOLID", color: "#123456" }, { type: "IMAGE" }] });
  const literalFacts = extractNodeLiterals('<div data-node-id="8:40" className="bg-[#123456]" />', "8:40");
  assert.equal(literalFacts[0].property, "fill");
  assert.equal(authorityOf(synthetic({}), { literalFacts }).nodes["8:40"].facts.fill.value, "#123456");
  const authority = authorityOf(record, { literalFacts });
  assert.equal(authority.nodes["8:40"].facts.fill, undefined);
  assert.deepEqual(structuredCapabilityProfile(authority.nodes).unresolved.find((item) => item.dimension === "fill"),
    { nodeId: "8:40", dimension: "fill", missing: ["fill"],
      reason: "VISUAL_FILL_UNSUPPORTED: multiple applied paints" });
  assert.throws(() => validateStructuredContract(authority.nodes, { "8:40": {
    targetLocator: "[data-node-id='8:40']", facts: { fill: { kind: "equals", value: "#123456" } } } }),
  /VISUAL_FACT_UNBACKED: 8:40\.fill/);
});

test("an unsupported stroke or effect shape is NOT_PROVABLE with its own reason, never a fact", () => {
  const cases = {
    "VISUAL_STROKE_UNSUPPORTED: paint": { strokes: [{ type: "GRADIENT_LINEAR", visible: true }],
      strokeWeight: 1, strokeAlign: "INSIDE" },
    "VISUAL_STROKE_UNSUPPORTED: multiple": { strokeAlign: "INSIDE", strokeWeight: 1,
      strokes: [{ type: "SOLID", color: "#d4cfc6" }, { type: "SOLID", color: "#1c1917" }] },
    "VISUAL_STROKE_UNSUPPORTED: align-center": { strokes: [{ type: "SOLID", color: "#d4cfc6" }],
      strokeWeight: 1, strokeAlign: "CENTER" },
    "VISUAL_STROKE_UNSUPPORTED: dash": { strokes: [{ type: "SOLID", color: "#d4cfc6" }],
      strokeWeight: 1, strokeAlign: "INSIDE", dashPattern: [4, 2] },
  };
  for (const [reason, properties] of Object.entries(cases)) {
    const record = synthetic(properties);
    assert.equal(extractStructuredFacts(record).find((item) => item.property === "stroke"), undefined, reason);
    assert.deepEqual(dimension(record, "stroke"), { state: "NOT_PROVABLE", reason });
    // A contract claiming the dimension anyway is refused, not defaulted.
    assert.throws(() => validateStructuredContract(authorityOf(record).nodes, { "8:40": {
      targetLocator: "[data-node-id='8:40']", facts: { stroke: { kind: "equals", value: "none" } } } }),
      /VISUAL_FACT_UNBACKED: 8:40\.stroke/);
  }
  const shadow = { color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 1 }, radius: 3 };
  for (const [reason, effects] of Object.entries({
    "VISUAL_EFFECT_UNSUPPORTED: LAYER_BLUR": [{ type: "LAYER_BLUR", visible: true, radius: 4 }],
    "VISUAL_EFFECT_UNSUPPORTED: order-unproven": [{ type: "DROP_SHADOW", ...shadow },
      { type: "INNER_SHADOW", ...shadow }],
  })) {
    const record = synthetic({ effects });
    assert.equal(extractStructuredFacts(record).find((item) => item.property === "boxShadow"), undefined, reason);
    assert.deepEqual(dimension(record, "effects"), { state: "NOT_PROVABLE", reason });
  }
});

test("neither domain may satisfy the record with a shape the other cannot produce", () => {
  // Raw Figma JSON as a target value is exactly what §7.19 forbids.
  refuses("stroke", { type: "SOLID", color: { r: 1, g: 1, b: 1 } });
  refuses("stroke", [{ type: "SOLID" }]);
  refuses("stroke", { applied: true, color: "#d4cfc6", width: 1, style: "dotted", align: "inside" });
  refuses("stroke", { applied: true, color: "#d4cfc6", width: 1, style: "solid", align: "center" });
  refuses("stroke", { applied: true, color: "#d4cfc6", style: "solid", align: "inside" });
  refuses("stroke", { applied: true, color: "#d4cfc6", width: 1, widths: { top: 1, right: 1, bottom: 1, left: 1 },
    style: "solid", align: "inside" });
  refuses("stroke", { ...CARD_STROKE, strokeAlign: "INSIDE" });
  // Two CSS strokes, an offset outline and an unmeasured box-sizing are refused
  // rather than mapped onto the nearest Figma token.
  refuses("stroke", borderStyles({ outlineStyle: "solid", outlineWidth: "1px" }));
  refuses("stroke", { outlineStyle: "solid", outlineWidth: "1px", outlineOffset: "2px",
    outlineColor: "rgb(212, 207, 198)" });
  refuses("stroke", borderStyles({ boxSizing: "" }));
  refuses("stroke", borderStyles({ borderTopColor: "rgb(0, 0, 0)" }));
  refuses("boxShadow", "0 2px 6px");
  refuses("boxShadow", "currentColor 0 2px 6px");
  refuses("boxShadow", [{ offsetX: 0, offsetY: 2, blur: 6, spread: 0, color: "#1c191714", radius: 6 }]);
  assert.deepEqual(normalizeVisualValue("boxShadow", "inset 0 2px 6px rgba(28,25,23,0.08)"),
    [{ ...CARD_SHADOW[0], inset: true }]);
});

test("the shared engine semantics are one function for both domains", () => {
  // The Figma derivation and the browser recipe are the same normalizer, which
  // is why an authority record and a measurement are the same assertion.
  assert.deepEqual(figmaStroke(JSON.parse(CARD_SNAPSHOT)).value, CARD_STROKE);
  assert.deepEqual(figmaShadows(JSON.parse(CARD_SNAPSHOT)).value, CARD_SHADOW);
  assert.deepEqual(normalizeVisualValue("stroke", figmaStroke(JSON.parse(CARD_SNAPSHOT)).value),
    normalizeVisualValue("stroke", borderStyles()));
  assert.deepEqual(normalizeVisualValue("boxShadow", figmaShadows(JSON.parse(CARD_SNAPSHOT)).value),
    normalizeVisualValue("boxShadow", "rgba(28, 25, 23, 0.08) 0px 2px 6px 0px"));
});

test("a node that returned no strokes/effects key proves neither a record nor an absence", () => {
  assert.deepEqual(figmaStroke({ id: "8:40", strokeWeight: 1 }), {});
  assert.deepEqual(figmaShadows({ id: "8:40" }), {});
  assert.equal(fact("7:21", "stroke"), undefined);
  assert.equal(fact("7:21", "boxShadow"), undefined);
});
