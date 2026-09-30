import assert from "node:assert/strict";
import test from "node:test";
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
  resolveVisualProvenance,
} from "../../src/visual-evidence.mjs";
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
  assert.equal(
    normalizeVisualValue("boxShadow", "0 1px  2px   rgba(0,0,0,0.2)"),
    "0 1px 2px rgba(0,0,0,0.2)",
  );
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
  assert.equal(fact("7:20", "boxShadow")?.value, "none");
  assert.deepEqual(fact("7:20", "effects")?.value, []);
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
    strokes: [{ type: "SOLID", color: "#112233" }], strokeWeight: 2,
    individualStrokeWeights: { top: 1, right: 2, bottom: 3, left: 4 },
    effects: [{ type: "DROP_SHADOW", visible: true, radius: 4 }],
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
  assert.equal(get("effects")[0].type, "DROP_SHADOW");
  assert.equal(get("boxShadow"), undefined);
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
