import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXED_VISUAL_TOLERANCE,
  HARDENED_VISUAL_VERSION,
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
} from "../../src/visual-evidence.mjs";

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
