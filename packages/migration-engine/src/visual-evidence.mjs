/**
 * The hardened visual contract's evidence primitives (`version: 2`), shared by
 * both engines and importing neither -- the `format-upgrade.mjs` pattern. A
 * second copy of any rule here is the one thing that would let the module and
 * artifact pipelines drift apart, so there is exactly one.
 *
 * Five responsibilities and nothing else:
 *   1. `REQUIRED_FACTS` -- the fixed taxonomy a v2 contract must cover, so a
 *      one-fact PASS is not expressible.
 *   2. `normalizeVisualValue` -- the single space the authority value, the
 *      contract value and the runtime measurement are all compared in, so a
 *      Figma `#0B5FFF` and a browser `rgb(11, 95, 255)` are the same fact.
 *   3. The three Figma provenance resolvers, each reading a value back out of
 *      bytes the engine has already re-hashed.
 *   4. PNG decode, box resampling, pixel counts and control multiset deltas.
 *   5. Captured structured Plugin API nodes, their facts, assets and provenance.
 *
 * Nothing here decides PASS or FAIL and nothing here reads the filesystem: it
 * takes bytes and returns values or throws. The verdict stays in the engines.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const decodePng = (bytes) => {
  const { PNG } = require("pngjs");
  try {
    return PNG.sync.read(bytes);
  } catch (error) {
    throw new Error(`VISUAL_PNG_INVALID: ${error.message}`);
  }
};

// Box filtering uses premultiplied channels so translucent edge pixels stay
// correct when the result is composited over the capture's declared matte.
export const resampleTo = (image, width, height) => {
  if (![width, height].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("VISUAL_COMPARE_RASTER: width and height must be positive integers");
  }
  if (image.width === width && image.height === height) return image;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = y * image.height / height;
    const bottom = (y + 1) * image.height / height;
    for (let x = 0; x < width; x++) {
      const left = x * image.width / width;
      const right = (x + 1) * image.width / width;
      const sums = [0, 0, 0, 0];
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const area = (Math.min(right, sx + 1) - Math.max(left, sx)) *
            (Math.min(bottom, sy + 1) - Math.max(top, sy));
          const offset = (sy * image.width + sx) * 4;
          const alpha = image.data[offset + 3] / 255;
          for (let channel = 0; channel < 3; channel++) {
            sums[channel] += image.data[offset + channel] * alpha * area;
          }
          sums[3] += alpha * area;
        }
      }
      const area = (right - left) * (bottom - top);
      const offset = (y * width + x) * 4;
      const alpha = sums[3] / area;
      for (let channel = 0; channel < 3; channel++) {
        data[offset + channel] = alpha ? Math.round(sums[channel] / sums[3]) : 0;
      }
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  return { width, height, data };
};

export const perceptualDelta = (authority, target, compare) => {
  const { width, height, matte } = compare;
  if (!/^#[0-9a-f]{6}$/i.test(matte)) {
    throw new Error("VISUAL_CAPTURE_MISMATCH: matte must be an opaque #RRGGBB color");
  }
  const background = [1, 3, 5].map((at) => Number.parseInt(matte.slice(at, at + 2), 16));
  const flatten = (image) => {
    const raster = resampleTo(image, width, height);
    const data = Buffer.from(raster.data);
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        data[offset + channel] = Math.round(data[offset + channel] * alpha + background[channel] * (1 - alpha));
      }
      data[offset + 3] = 255;
    }
    return data;
  };
  const diffPixels = require("pixelmatch").default(flatten(authority), flatten(target), null, width, height, { includeAA: false });
  return { diffPixels, diffRatio: diffPixels / (width * height) };
};

export const structuralDelta = (authorityControls, targetControls) => {
  const tally = (controls) => {
    const counts = new Map();
    for (const { role, name } of controls) {
      const key = JSON.stringify([role, name]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const authority = tally(authorityControls);
  const target = tally(targetControls);
  const missing = [];
  const extra = [];
  const countDiffs = [];
  for (const key of new Set([...authority.keys(), ...target.keys()])) {
    const [role, name] = JSON.parse(key);
    const expected = authority.get(key) ?? 0;
    const actual = target.get(key) ?? 0;
    if (!actual) missing.push({ role, name, count: expected });
    else if (!expected) extra.push({ role, name, count: actual });
    else if (expected !== actual) countDiffs.push({ role, name, expected, actual });
  }
  return { missing, extra, countDiffs };
};

/** The hardened contract. `version: 1` survives only as already-pinned history. */
export const HARDENED_VISUAL_VERSION = 2;

/**
 * ponytail: fixed at ±1px because no real migration has yet needed looser;
 * upgrade path is a `VISUAL_UNBACKED`-shaped operator decision, added the first
 * time a real run proves ±1px unachievable. Authoring a tolerance at v2 is
 * refused outright -- an operator-tunable tolerance is a waiver wearing a
 * number's clothes, and v1's `MAX_TOLERANCE_*` ceilings stay where they are for
 * the records already pinned under them.
 */
export const FIXED_VISUAL_TOLERANCE = Object.freeze({ px: 1, ratio: 0 });

/**
 * The taxonomy, as a fixed table rather than a derivation engine. Coverage is
 * this table UNION every key the authority frame establishes: the union half is
 * free (the facts are already there), and the table half is what forbids a
 * contract that asserts one convenient fact and calls the state verified.
 *
 * `structure` names no fact: any one bounded `count` satisfies it, because what
 * a route counts (rows, cards, actions) is the record's business. `assets` is a
 * sorted array of resolved icon/image identifiers -- an `equals` fact, so it
 * needs no comparison code at all, and it is the only gate a 24x24 icon inside
 * a 1180x640 frame cannot slip past.
 *
 * Per-element detail below the frame root is deliberately absent; that is the
 * screenshot and structural gates' half of the division.
 */
export const REQUIRED_FACTS = Object.freeze(
  [
    { group: "geometry", facts: { width: "px", height: "px" } },
    { group: "spacing", facts: { padding: "px", gap: "px" } },
    { group: "color", facts: { color: "equals", backgroundColor: "equals" } },
    { group: "fontFamily", facts: { fontFamily: "equals" } },
    { group: "fontSize", facts: { fontSize: "px" } },
    { group: "fontWeight", facts: { fontWeight: "equals" } },
    { group: "lineHeight", facts: { lineHeight: "px" } },
    {
      group: "border",
      facts: { borderWidth: "px", borderColor: "equals", borderRadius: "px" },
    },
    { group: "shadow", facts: { boxShadow: "equals" } },
    { group: "visibility", facts: { opacity: "equals", visibility: "equals" } },
    { group: "structure", facts: {} },
    { group: "assets", facts: { assets: "equals" } },
  ].map((row) => Object.freeze({ ...row, facts: Object.freeze(row.facts) })),
);

/** The declared `kind` of every named taxonomy fact, for contract validation. */
export const REQUIRED_FACT_KINDS = Object.freeze(
  Object.assign({}, ...REQUIRED_FACTS.map((row) => row.facts)),
);

/** Every taxonomy fact name, in table order. */
export const REQUIRED_FACT_NAMES = Object.freeze(
  Object.keys(REQUIRED_FACT_KINDS),
);

/**
 * The taxonomy groups a contract row leaves uncovered. `structure` is satisfied
 * by any one `count`; every other group by all of its names. Reported as groups
 * rather than names so the refusal says what is missing, not just which key.
 */
export const missingRequiredGroups = (expect) =>
  REQUIRED_FACTS.filter((row) =>
    row.group === "structure"
      ? !Object.values(expect ?? {}).some((fact) => fact?.kind === "count")
      : Object.keys(row.facts).some((name) => (expect ?? {})[name] === undefined),
  ).map((row) => row.group);

// --- normalization -----------------------------------------------------------

class VisualValueError extends Error {}

const refuse = (property, raw, why) => {
  throw new VisualValueError(
    `VISUAL_VALUE_UNSUPPORTED: ${property} value ${JSON.stringify(raw)} ${why}. The authority value, the contract value and the runtime measurement are compared in one normalized space; a value that cannot be normalized is refused rather than guessed at.`,
  );
};

const COLOR_FACTS = new Set(["color", "backgroundColor", "borderColor", "fill"]);
const LENGTH_FACTS = new Set([
  "width",
  "height",
  "padding",
  "gap",
  "fontSize",
  "lineHeight",
  "borderWidth",
  "borderRadius",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "rowGap", "columnGap",
  "borderTopLeftRadius", "borderTopRightRadius",
  "borderBottomRightRadius", "borderBottomLeftRadius",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "x",
  "y",
]);
/** Facts whose value is established by the node's own geometry, never by CSS. */
export const GEOMETRY_FACTS = Object.freeze(["width", "height", "x", "y"]);

const FONT_WEIGHTS = { normal: 400, bold: 700 };
const hex2 = (value) => Math.round(value).toString(16).padStart(2, "0");

const normalizeColor = (property, raw) => {
  const text = String(raw).trim().toLowerCase();
  if (text === "transparent") return "#00000000";
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(text);
  if (short) {
    const [, r, g, b, a] = short;
    return `#${r}${r}${g}${g}${b}${b}${a === undefined ? "" : `${a}${a}`}`;
  }
  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) return text;
  const functional = /^rgba?\(([^)]*)\)$/.exec(text);
  if (functional) {
    const parts = functional[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (
      (parts.length === 3 || parts.length === 4) &&
      parts.every((part) => Number.isFinite(part)) &&
      parts.slice(0, 3).every((part) => part >= 0 && part <= 255) &&
      (parts.length === 3 || (parts[3] >= 0 && parts[3] <= 1))
    ) {
      const alpha = parts[3];
      return `#${parts.slice(0, 3).map(hex2).join("")}${
        alpha === undefined || alpha === 1 ? "" : hex2(alpha * 255)
      }`;
    }
  }
  return refuse(
    property,
    raw,
    "is not a hex or rgb()/rgba() color (named colors, hsl(), currentColor and unresolved variables carry no fixed value here)",
  );
};

const normalizeLength = (property, raw) => {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : refuse(property, raw, "is not finite");
  }
  const text = String(raw).trim().toLowerCase();
  const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(text);
  // Percentages stay percentages: resolving one needs a containing box the
  // contract does not carry, and inventing that box is the guess this refuses.
  if (percent) return `${Number(percent[1])}%`;
  const px = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(text);
  if (px) return Number(px[1]);
  return refuse(
    property,
    raw,
    "is not a px length, a unitless number or a percentage (rem/em/vh/pt/ch, `auto`, `normal` and calc() all depend on context this contract does not pin)",
  );
};

// --- stroke and shadow: one record, derived independently by both domains ----

const STROKE_SIDES = ["top", "right", "bottom", "left"];
const STROKE_FIELDS = ["applied", "color", "width", "widths", "style", "align"];
const SHADOW_FIELDS = ["inset", "offsetX", "offsetY", "blur", "spread", "color"];

/** The closed record, in one key order, so two sides of it stringify alike. */
const strokeRecord = ({ applied, color, width, widths, style, align }) => ({
  applied, color,
  ...(width === undefined ? {} : { width }),
  ...(widths === undefined ? {} : { widths }),
  style, align,
});

const shadowRecord = ({ inset, offsetX, offsetY, blur, spread, color }) =>
  ({ inset, offsetX, offsetY, blur, spread, color });

/**
 * Uniform sides collapse to `width`; unequal sides become `widths`. One rule
 * for both domains -- a per-side record on one side and a scalar on the other
 * would be a divergence manufactured by the representation, not by the design.
 */
const collapseWidths = (widths) => {
  const values = STROKE_SIDES.map((side) => widths[side]);
  return values.every((value) => value === values[0])
    ? { width: values[0] }
    : { widths: Object.fromEntries(STROKE_SIDES.map((side, at) => [side, values[at]])) };
};

const strokeLength = (label, raw) => {
  const value = normalizeLength(label, raw);
  return typeof value === "number" ? value : refuse(label, raw, "is not a px length");
};

const strokeStyle = (raw, subject) => {
  const text = String(raw).trim().toLowerCase();
  return ["solid", "dashed"].includes(text)
    ? text
    : refuse("stroke", subject, `applies border-style ${JSON.stringify(text)}; only solid and dashed have a Figma stroke realization`);
};

/** Validate a record either domain produced, and close it over its own fields. */
const strokeRecordFrom = (raw) => {
  const extra = Object.keys(raw).filter((key) => !STROKE_FIELDS.includes(key));
  if (extra.length) refuse("stroke", raw, `carries field(s) ${extra.join(", ")} outside the stroke record`);
  if (raw.applied !== true) refuse("stroke", raw, "is a record without `applied: true`; an unapplied stroke is the string `none`");
  const width = Object.hasOwn(raw, "width") ? strokeLength("stroke.width", raw.width) : undefined;
  const widths = Object.hasOwn(raw, "widths")
    ? Object.fromEntries(STROKE_SIDES.map((side) => [side, strokeLength(`stroke.widths.${side}`, raw.widths?.[side])]))
    : undefined;
  if ((width === undefined) === (widths === undefined)) {
    refuse("stroke", raw, "must carry exactly one of `width` (uniform sides) or `widths` (unequal sides)");
  }
  const align = String(raw.align).trim().toLowerCase();
  if (!["inside", "outside"].includes(align)) {
    refuse("stroke", raw, "has no `inside`/`outside` alignment; CENTER has no CSS realization at all");
  }
  return strokeRecord({ applied: true, color: normalizeColor("borderColor", raw.color),
    style: strokeStyle(raw.style, raw), align, width, widths });
};

/**
 * The fixed browser recipe of §7.19. `align` is the one derived field: CSS has
 * no stroke alignment, so a bordered `border-box` is `inside` and an outline at
 * offset 0 -- or a `content-box` border -- is `outside`. Any third geometry is
 * refused rather than mapped onto the nearest Figma token.
 */
export const strokeFromComputedStyle = (declaration) => {
  const styles = Object.fromEntries(Object.entries(declaration).map(([key, value]) =>
    [key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()), value]));
  if (!Object.keys(styles).some((key) => /^(border(Top|Right|Bottom|Left)(Style|Width|Color)|outline(Style|Width|Color|Offset)|boxSizing)$/.test(key))) {
    // Without one measured property this is not a computed style at all -- a
    // raw Figma paint object must not fall through to a proven `none`.
    refuse("stroke", declaration, "declares no border, outline or box-sizing property to measure a stroke from");
  }
  const sideStyle = (side) => String(styles[`border${side}Style`] ?? "none").trim().toLowerCase();
  const sideWidth = (side) => strokeLength(`border${side}Width`, styles[`border${side}Width`] ?? 0);
  const sides = ["Top", "Right", "Bottom", "Left"];
  const applied = sides.filter((side) => sideStyle(side) !== "none" && sideWidth(side) > 0);
  const outlineWidth = strokeLength("outlineWidth", styles.outlineWidth ?? 0);
  const outlined = String(styles.outlineStyle ?? "none").trim().toLowerCase() !== "none" && outlineWidth > 0;
  if (!applied.length && !outlined) return "none";
  if (applied.length && outlined) {
    refuse("stroke", declaration, "applies both a border and an outline, which is two strokes where a Figma node carries one");
  }
  if (outlined) {
    if (strokeLength("outlineOffset", styles.outlineOffset ?? 0) !== 0) {
      refuse("stroke", declaration, "applies an outline-offset other than 0px, a geometry no strokeAlign describes");
    }
    return strokeRecord({ applied: true, color: normalizeColor("borderColor", styles.outlineColor),
      width: outlineWidth, style: strokeStyle(styles.outlineStyle, declaration), align: "outside" });
  }
  const distinct = (values) => new Set(values.map((value) => JSON.stringify(value)));
  if (distinct(applied.map(sideStyle)).size > 1) refuse("stroke", declaration, "mixes border styles across sides");
  const colors = distinct(applied.map((side) => normalizeColor("borderColor", styles[`border${side}Color`])));
  if (colors.size > 1) {
    // ponytail: one Figma stroke carries one colour, so a per-side-coloured
    // border diverges from every authority record anyway; §7.19's per-side
    // record lands the first time a real node needs it.
    refuse("stroke", declaration, "mixes border colours across sides; one Figma stroke carries one colour");
  }
  const boxSizing = String(styles.boxSizing ?? "").trim().toLowerCase();
  if (!["border-box", "content-box"].includes(boxSizing)) {
    refuse("stroke", declaration, "declares no border-box/content-box box-sizing, so the border's alignment is not measured");
  }
  return strokeRecord({ applied: true, color: JSON.parse([...colors][0]),
    style: strokeStyle(sideStyle(applied[0]), declaration),
    align: boxSizing === "border-box" ? "inside" : "outside",
    ...collapseWidths(Object.fromEntries(STROKE_SIDES.map((side, at) => [side, sideWidth(sides[at])]))) });
};

/** Split on a separator the parentheses of `rgba(...)` do not enclose. */
const splitTopLevel = (text, separator) => {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(") depth++;
    else if (character === ")") depth--;
    else if (character === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  return [...parts, current].map((part) => part.trim()).filter(Boolean);
};

/** One serialized CSS `box-shadow` into component records, in paint order. */
const parseBoxShadow = (text) => {
  const declaration = String(text).trim();
  if (declaration.toLowerCase() === "none") return [];
  return splitTopLevel(declaration, ",").map((component) => {
    const tokens = splitTopLevel(component, " ");
    const lengths = [];
    const colors = [];
    let inset = false;
    for (const token of tokens) {
      if (token.toLowerCase() === "inset") inset = true;
      else if (/^[-+.\d]/.test(token)) lengths.push(token);
      else colors.push(token);
    }
    if (lengths.length < 2 || lengths.length > 4 || colors.length !== 1) {
      refuse("boxShadow", text, "is not `<color> <x> <y> [blur] [spread]` with exactly one colour per component (currentColor and named colours carry no fixed value here)");
    }
    const [offsetX, offsetY, blur, spread] = lengths;
    return { inset, offsetX, offsetY, blur: blur ?? 0, spread: spread ?? 0, color: colors[0] };
  });
};

const shadowComponentFrom = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    refuse("boxShadow", raw, "has a component that is not a shadow record");
  }
  const extra = Object.keys(raw).filter((key) => !SHADOW_FIELDS.includes(key));
  if (extra.length) refuse("boxShadow", raw, `has a component carrying field(s) ${extra.join(", ")} outside the shadow record`);
  if (raw.inset !== undefined && typeof raw.inset !== "boolean") {
    refuse("boxShadow", raw, "has a component whose `inset` is not a boolean");
  }
  return shadowRecord({ inset: raw.inset === true,
    ...Object.fromEntries(["offsetX", "offsetY", "blur", "spread"].map((field) =>
      [field, strokeLength(`boxShadow.${field}`, raw[field] ?? (["blur", "spread"].includes(field) ? 0 : undefined))])),
    color: normalizeColor("borderColor", raw.color) });
};

/**
 * One value in the one comparison space, keyed by the fact's own name. Every
 * caller -- authority derivation, contract validation, runtime comparison --
 * goes through here, which is what makes "the design says #0B5FFF" and "the
 * browser reports rgb(11, 95, 255)" the same assertion.
 */
export const normalizeVisualValue = (property, raw) => {
  if (raw === undefined || raw === null) {
    return refuse(property, raw, "is absent");
  }
  if (COLOR_FACTS.has(property)) return normalizeColor(property, raw);
  if (LENGTH_FACTS.has(property)) return normalizeLength(property, raw);
  if (property === "fontWeight") {
    const text = String(raw).trim().toLowerCase();
    if (text in FONT_WEIGHTS) return FONT_WEIGHTS[text];
    const weight = Number(text);
    return Number.isInteger(weight) && weight >= 1 && weight <= 1000
      ? weight
      : refuse(
          property,
          raw,
          "is not `normal`, `bold` or an integer 1-1000 (`lighter`/`bolder` are relative to an inherited weight the contract does not pin)",
        );
  }
  if (property === "fontFamily") {
    const families = String(raw)
      .split(",")
      .map((family) => family.trim().replace(/^["']|["']$/g, "").trim().toLowerCase())
      .filter(Boolean);
    return families.length > 0
      ? families.join(", ")
      : refuse(property, raw, "names no font family");
  }
  if (property === "opacity") {
    const value = Number(String(raw).trim());
    return Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : refuse(property, raw, "is not a number between 0 and 1");
  }
  if (property === "visibility") {
    const text = String(raw).trim().toLowerCase();
    return ["visible", "hidden", "collapse"].includes(text)
      ? text
      : refuse(property, raw, "is not `visible`, `hidden` or `collapse`");
  }
  if (property === "stroke") {
    if (typeof raw === "string") {
      return raw.trim().toLowerCase() === "none"
        ? "none"
        : refuse(property, raw, "is not `none` or a normalized stroke record");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return refuse(property, raw, "is not `none`, a stroke record or a computed style declaration");
    }
    // Both domains arrive here: Figma through `figmaStroke`, the browser as its
    // own computed style. One record comes out either way, which is the whole
    // point -- the target is never asked to reproduce Figma's paint JSON.
    return Object.hasOwn(raw, "applied") ? strokeRecordFrom(raw) : strokeFromComputedStyle(raw);
  }
  if (property === "boxShadow") {
    const list = typeof raw === "string" ? parseBoxShadow(raw) : raw;
    if (!Array.isArray(list)) {
      return refuse(property, raw, "is not a CSS box-shadow declaration or a list of shadow components");
    }
    return list.map((component) => shadowComponentFrom(component));
  }
  if (property === "assets") {
    // Sorted so two captures of the same screen are the same fact regardless of
    // paint order; an array, because "the icons on this screen" is a set.
    if (
      !Array.isArray(raw) ||
      raw.some((item) => typeof item !== "string" || !item.trim())
    ) {
      return refuse(
        property,
        raw,
        "is not an array of non-empty resolved asset identifiers",
      );
    }
    return raw.map((item) => item.trim()).sort();
  }
  // Anything outside the taxonomy is a fact the record established for itself
  // (a `count`, a `present`, a bespoke `equals`). It is carried through
  // deterministically rather than reinterpreted: the engine has no business
  // deciding what an unknown key means.
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : refuse(property, raw, "is not finite");
  }
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) || typeof raw === "object") {
    return JSON.parse(JSON.stringify(raw));
  }
  return refuse(property, raw, "is not a JSON value");
};

// --- Figma provenance --------------------------------------------------------

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** One attribute off one already-matched XML tag, entity-decoded. */
export const xmlAttribute = (tag, name) => {
  if (!/^[\w:.-]+$/.test(name)) return undefined;
  const raw = tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  return raw?.replace(/&(amp|lt|gt|quot|apos);/g, (_m, entity) => XML_ENTITIES[entity]);
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The three classic ways a Figma fact may be traced back to pinned bytes. */
export const FIGMA_PROVENANCE_KINDS = Object.freeze([
  "metadata",
  "variableDefs",
  "designContext",
]);

const dangling = (label, why) => {
  throw new Error(`VISUAL_PROVENANCE_DANGLING: ${label} ${why}.`);
};

/**
 * `kind: "metadata"` -- an XML attribute of the node's own tag in the persisted
 * `get_metadata` output. Node binding is the point: the tag is found by id, so
 * a selector read off a sibling or a parent cannot be passed off as this node's.
 */
export const resolveMetadataFact = (metadata, nodeId, selector, label) => {
  const tag = String(metadata).match(
    new RegExp(`<[^>]*\\sid="${escapeRegExp(nodeId)}"[^>]*>`),
  )?.[0];
  if (!tag) dangling(label, `does not describe node '${nodeId}'`);
  const raw = xmlAttribute(tag, selector);
  if (raw === undefined) {
    dangling(label, `node '${nodeId}' carries no '${selector}' attribute`);
  }
  return raw;
};

/**
 * `kind: "metadata"`, multi-valued -- the `assets` fact. An icon or image is a
 * *node* in Figma, not a declaration, so the identifiers are collected off the
 * node's own `vector` and `image` descendants rather than out of CSS. The
 * selector is fixed at `assets`, so a contract cannot hide an image by asking
 * the resolver to count only vectors.
 *
 * Read only descendants before the matching closing tag. Sibling assets must
 * not be attributed to this node when an MCP response includes several trees.
 */
export const resolveMetadataAssets = (metadata, nodeId, selector, label) => {
  if (selector !== "assets") dangling(label, `selector ${JSON.stringify(selector)} must be 'assets'`);
  const text = String(metadata);
  const opening = text.search(
    new RegExp(`<[^>]*\\sid="${escapeRegExp(nodeId)}"[^>]*>`),
  );
  if (opening < 0) dangling(label, `does not describe node '${nodeId}'`);
  const identifiers = [];
  let depth = 0;
  for (const [tag, closing, name] of text.slice(opening).matchAll(/<(\/)?([A-Za-z][\w:.-]*)\b[^>]*>/g)) {
    if (closing) {
      if (--depth === 0) break;
    } else {
      if (depth > 0 && ["vector", "image"].includes(name.toLowerCase())) {
        const value = xmlAttribute(tag, "name");
        if (!value?.trim()) dangling(label, `<${name}> beneath node '${nodeId}' has no resolved name`);
        identifiers.push(value);
      }
      if (!tag.endsWith("/>")) depth++;
    }
  }
  return identifiers;
};

/**
 * `kind: "variableDefs"` -- an RFC-6901 pointer into the persisted
 * `get_variable_defs` output. A pointer that does not resolve is a dangling
 * reference, never an absent-but-fine one.
 */
export const resolveVariableDefsFact = (document, pointer, label) => {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    dangling(
      label,
      `selector ${JSON.stringify(pointer)} is not an RFC-6901 JSON pointer such as "/color~1primary"`,
    );
  }
  let node = document;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      dangling(label, `pointer '${pointer}' does not resolve in the persisted variable definitions`);
    }
    node = node[key];
  }
  return node;
};

/**
 * `kind: "designContext"` -- one CSS property inside the persisted
 * `get_design_context` entry whose declared `nodeId` is this node's. Every
 * occurrence is collected and normalized; exactly one distinct value may
 * survive, so a block that declares the property twice with different values is
 * refused as ambiguous rather than resolved by document order.
 *
 * One regex over a hash-pinned, node-scoped entry. Deliberately not a CSS
 * interpretation engine: no cascade, no shorthand expansion, no inheritance.
 */
export const resolveDesignContextFact = (text, cssProperty, property, label) => {
  const matches = [
    ...String(text).matchAll(
      new RegExp(
        `(?:^|[;{}\\s])${escapeRegExp(cssProperty)}\\s*:\\s*([^;{}\\n]+)`,
        "gi",
      ),
    ),
  ];
  const distinct = new Map();
  for (const match of matches) {
    const value = normalizeVisualValue(property, match[1].trim());
    distinct.set(JSON.stringify(value), value);
  }
  if (distinct.size === 0) {
    dangling(
      label,
      `declares no '${cssProperty}' in the node-scoped design context entry`,
    );
  }
  if (distinct.size > 1) {
    throw new Error(
      `VISUAL_PROVENANCE_AMBIGUOUS: ${label} resolves '${cssProperty}' to ${distinct.size} different values (${[...distinct.values()].map((value) => JSON.stringify(value)).join(", ")}). A fact is resolved from exactly one declaration or not at all.`,
    );
  }
  return [...distinct.values()][0];
};

/**
 * Precedence, so the weakest kind cannot be chosen for convenience. Geometry is
 * established by the node's own box and nothing else; a token that exists as a
 * variable must be cited as that variable, because a `designContext` copy of it
 * would survive the variable changing. `designContext` is therefore the
 * fallback, never the choice.
 *
 * `variableValues` is the flat set of values in the frame's persisted
 * `get_variable_defs` output; `null` when the frame pins none.
 */
export const assertProvenancePrecedence = ({
  property,
  kind,
  value,
  variableValues,
  label,
}) => {
  if (GEOMETRY_FACTS.includes(property) && kind !== "metadata") {
    throw new Error(
      `VISUAL_PROVENANCE_PRECEDENCE: ${label} resolves geometry fact '${property}' through '${kind}'. Geometry is read from the node's own box in the persisted get_metadata output; a CSS declaration describing it is a weaker restatement and cannot stand in for it.`,
    );
  }
  if (
    kind === "designContext" &&
    variableValues &&
    variableValues.has(JSON.stringify(value))
  ) {
    throw new Error(
      `VISUAL_PROVENANCE_PRECEDENCE: ${label} resolves '${property}' to ${JSON.stringify(value)} through 'designContext', but that value is defined in this frame's persisted variable definitions. Cite the variableDefs pointer: a design context copy of a token stops tracking the token.`,
    );
  }
};

/**
 * Every value in a persisted `get_variable_defs` document, normalized for
 * `property` where it can be, as a set of JSON keys. Values that do not
 * normalize for this property simply are not in the set -- absence here only
 * ever means "no precedence claim", never a pass.
 */
export const variableValueSet = (document, property) => {
  const values = new Set();
  const family = COLOR_FACTS.has(property) ? "color"
    : ["padding", "gap"].includes(property) ? "spacing"
    : property === "borderRadius" ? "radius"
    : property.toLowerCase();
  const walk = (node, pointer = "") => {
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${pointer}/${index}`));
    if (node !== null && typeof node === "object") {
      return Object.entries(node).forEach(([key, value]) => walk(value, `${pointer}/${key}`));
    }
    // A coincidentally equal number in an unrelated token (for example a
    // control count of 1 beside borderWidth: 1) is not a definition of this
    // property. The pointer must identify the fact or its token family.
    const typedToken = COLOR_FACTS.has(property) ||
      (LENGTH_FACTS.has(property) && typeof node === "string" && /^-?\d+(?:\.\d+)?(?:px|%)$/i.test(node.trim()));
    if (!typedToken && !pointer.toLowerCase().replace(/[^a-z]/g, "").includes(family)) return;
    try {
      values.add(JSON.stringify(normalizeVisualValue(property, node)));
    } catch (error) {
      if (!(error instanceof VisualValueError)) throw error;
    }
  };
  walk(document);
  return values;
};

// --- Structured Plugin API evidence -----------------------------------------

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Hash the exact returned bytes; JSON key reordering is not silently erased. */
export const structuredDigest = (bytes) => {
  if (typeof bytes !== "string" && !Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error("VISUAL_STRUCTURED_INVALID: digest input must be bytes or a string");
  }
  return sha256(bytes);
};

const readStructuredNode = (record) => {
  if (typeof record?.rawSnapshot !== "string") {
    throw new Error("VISUAL_STRUCTURED_INVALID: rawSnapshot must be the verbatim JSON string");
  }
  let node;
  try {
    node = JSON.parse(record.rawSnapshot);
  } catch {
    throw new Error("VISUAL_STRUCTURED_INVALID: rawSnapshot is not JSON");
  }
  if (record.digest !== undefined && record.digest !== structuredDigest(record.rawSnapshot)) {
    throw new Error("VISUAL_STRUCTURED_TAMPERED: rawSnapshot digest changed");
  }
  if (!node || Array.isArray(node) || typeof node !== "object" ||
      (node.id === undefined && node.nodeId === undefined) ||
      (node.id !== undefined && node.id !== record.nodeId) ||
      (node.nodeId !== undefined && node.nodeId !== record.nodeId)) {
    throw new Error("VISUAL_STRUCTURED_INVALID: snapshot node identity does not match nodeId");
  }
  return node;
};

const freezeEvidence = (value, seen = new WeakSet()) => {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeEvidence(child, seen);
    Object.freeze(value);
  }
  return value;
};

/** Capture a node without rewriting its response bytes or inventing missing keys. */
export const captureStructuredNode = ({ nodeId, rawSnapshot, capture }) => {
  if (typeof nodeId !== "string" || !nodeId || capture?.tool !== "use_figma" ||
      typeof capture.operation !== "string" || !capture.operation ||
      typeof capture.timestamp !== "string" || !capture.timestamp) {
    throw new Error("VISUAL_STRUCTURED_INVALID: nodeId, use_figma operation and capture timestamp are required");
  }
  const record = { nodeId, rawSnapshot, source: "STRUCTURED_NODE" };
  const node = readStructuredNode(record);
  if (node.children !== undefined && !Array.isArray(node.children)) {
    throw new Error("VISUAL_STRUCTURED_INVALID: children must be an array");
  }
  const childIds = node.childIds ?? node.children?.map((child) => child.id ?? child.nodeId);
  if (childIds !== undefined && (!Array.isArray(childIds) || childIds.some((id) => typeof id !== "string" || !id))) {
    throw new Error("VISUAL_STRUCTURED_INVALID: childIds must contain node IDs");
  }
  const parentId = node.parentId ?? node.parent?.id;
  if (parentId !== undefined && (typeof parentId !== "string" || !parentId)) {
    throw new Error("VISUAL_STRUCTURED_INVALID: parentId must be a node ID");
  }
  return freezeEvidence({
    ...record,
    digest: structuredDigest(rawSnapshot),
    capture: structuredClone(capture),
    ...(parentId === undefined ? {} : { parentId }),
    ...(childIds === undefined ? {} : { childIds: [...childIds] }),
    propertyKeys: Object.keys(node).sort(),
  });
};

/** Stable digest for the set of captured node artifacts, independent of arrival order. */
export const structuredEvidenceDigest = (records) => {
  const entries = records.map((record) => {
    readStructuredNode(record);
    return [record.nodeId, structuredDigest(record.rawSnapshot)];
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) {
    throw new Error("VISUAL_STRUCTURED_INVALID: duplicate nodeId in evidence set");
  }
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return structuredDigest(JSON.stringify(entries));
};

/** Figma's 0..1 channels at the 8-bit quantization both domains round to. */
const rgbaHex = (color, opacity = 1) => {
  if (typeof color === "string") return color;
  if (!color || ![color.r, color.g, color.b].every((value) => typeof value === "number" && value >= 0 && value <= 1)) {
    return undefined;
  }
  const alpha = (color.a ?? 1) * opacity;
  if (!(alpha >= 0 && alpha <= 1)) throw new Error("VISUAL_STRUCTURED_INVALID: invalid paint opacity");
  return `#${[color.r, color.g, color.b, alpha].slice(0, alpha === 1 ? 3 : 4)
    .map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
};

const paintColor = (paint) => {
  if (typeof paint === "string") return paint;
  if (paint?.type !== "SOLID" || paint.visible === false) return undefined;
  return rgbaHex(paint.color, paint.opacity ?? 1);
};

/**
 * §7.19. The node's structured stroke properties as the one normalized record,
 * or the named reason no record exists. An unsupported shape yields neither a
 * fact nor a default: the dimension resolves NOT_PROVABLE with the reason.
 */
export const figmaStroke = (node) => {
  // §7.8 guard 1: a node that never returned the key proves nothing at all --
  // neither a record nor `none`, and not an unsupported shape either.
  if (!Array.isArray(node.strokes)) return {};
  const applied = node.strokes.filter((stroke) => stroke?.visible !== false);
  if (!applied.length) return { value: "none" };
  if (applied.length > 1) return { unsupported: "VISUAL_STROKE_UNSUPPORTED: multiple" };
  const color = applied[0]?.type === "SOLID" ? paintColor(applied[0]) : undefined;
  if (color === undefined) return { unsupported: "VISUAL_STROKE_UNSUPPORTED: paint" };
  const align = { INSIDE: "inside", OUTSIDE: "outside" }[node.strokeAlign];
  if (!align) {
    return { unsupported: `VISUAL_STROKE_UNSUPPORTED: align${node.strokeAlign === "CENTER" ? "-center" : ""}` };
  }
  const dashes = node.strokeDashes ?? node.dashPattern;
  // Computed CSS border-style cannot reveal the source dash lengths.
  if (dashes !== undefined && (!Array.isArray(dashes) || dashes.length)) {
    return { unsupported: "VISUAL_STROKE_UNSUPPORTED: dash" };
  }
  const individual = node.individualStrokeWeights;
  const widths = individual && typeof individual === "object"
    ? Object.fromEntries(STROKE_SIDES.map((side) => [side, individual[side]]))
    : undefined;
  if (widths ? STROKE_SIDES.some((side) => typeof widths[side] !== "number")
    : typeof node.strokeWeight !== "number") {
    return { unsupported: "VISUAL_STROKE_UNSUPPORTED: width" };
  }
  return { value: strokeRecord({ applied: true, color, align,
    style: dashes?.length ? "dashed" : "solid",
    ...(widths ? collapseWidths(widths) : { width: node.strokeWeight }) }) };
};

/**
 * §7.20. The node's structured effects as the ordered box-shadow component
 * list, or the named reason no list exists. `[]` is the proven absence; an
 * unrepresentable effect is emphatically not the absence of one.
 */
export const figmaShadows = (node) => {
  if (!Array.isArray(node.effects)) return {};
  const applied = node.effects.filter((effect) => effect?.visible !== false);
  if (!applied.length) return { value: [] };
  const alien = applied.find((effect) => !["DROP_SHADOW", "INNER_SHADOW"].includes(effect?.type));
  if (alien) return { unsupported: `VISUAL_EFFECT_UNSUPPORTED: ${alien?.type ?? "unknown"}` };
  // Figma's array order and CSS's paint order have not been measured against
  // each other on a real node, so a second effect is a named gap, not a sort.
  if (applied.length > 1) return { unsupported: "VISUAL_EFFECT_UNSUPPORTED: order-unproven" };
  const [effect] = applied;
  const color = rgbaHex(effect.color);
  if (color === undefined) return { unsupported: "VISUAL_EFFECT_UNSUPPORTED: color" };
  return { value: [shadowRecord({ inset: effect.type === "INNER_SHADOW",
    offsetX: effect.offset?.x ?? 0, offsetY: effect.offset?.y ?? 0,
    blur: effect.radius ?? 0, spread: effect.spread ?? 0, color })] };
};

/** Facts always cite the owning node and the exact returned property path. */
export const extractStructuredFacts = (record) => {
  if (typeof record?.digest !== "string") {
    throw new Error("VISUAL_STRUCTURED_INVALID: captured snapshot digest is required");
  }
  const node = readStructuredNode(record);
  const facts = [];
  const add = (property, rawProperty, rawValue, normalized = rawValue) => {
    const binding = node.boundVariables?.[rawProperty]?.id;
    facts.push({ nodeId: record.nodeId, property, value: normalizeVisualValue(property, normalized),
      source: "STRUCTURED_NODE", rawProperty, rawValue, snapshotDigest: record.digest,
      ...(binding === undefined ? {} : { bindingId: binding }) });
  };
  const direct = ["width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "rowGap", "columnGap", "fontSize", "fontWeight", "opacity", "type", "isAsset"];
  for (const key of direct) if (Object.hasOwn(node, key)) add(key, key, node[key]);
  if (Object.hasOwn(node, "itemSpacing")) add("gap", "itemSpacing", node.itemSpacing);
  if (Object.hasOwn(node, "fontFamily")) add("fontFamily", "fontFamily", node.fontFamily);
  if (Object.hasOwn(node, "fontStyle")) add("fontStyle", "fontStyle", node.fontStyle);
  if (node.fontName && Object.hasOwn(node, "fontName")) {
    if (Object.hasOwn(node.fontName, "family")) add("fontFamily", "fontName.family", node.fontName.family);
    if (Object.hasOwn(node.fontName, "style")) add("fontStyle", "fontName.style", node.fontName.style);
    if (Object.hasOwn(node.fontName.variationSettings ?? {}, "wght")) {
      add("fontWeight", "fontName.variationSettings.wght", node.fontName.variationSettings.wght);
    }
  }
  for (const axis of ["fontVariationAxes", "fontVariations"]) {
    if (node[axis] && Object.hasOwn(node[axis], "wght")) add("fontWeight", `${axis}.wght`, node[axis].wght);
  }
  if (Object.hasOwn(node, "lineHeight")) {
    const height = node.lineHeight;
    if (typeof height !== "object" || height === null) add("lineHeight", "lineHeight", height);
    else if (height.unit === "PIXELS" && Object.hasOwn(height, "value")) add("lineHeight", "lineHeight.value", height, height.value);
  }
  const radii = { topLeftRadius: "borderTopLeftRadius", topRightRadius: "borderTopRightRadius",
    bottomRightRadius: "borderBottomRightRadius", bottomLeftRadius: "borderBottomLeftRadius" };
  for (const [raw, property] of Object.entries(radii)) if (Object.hasOwn(node, raw)) add(property, raw, node[raw]);
  if (node.individualStrokeWeights && typeof node.individualStrokeWeights === "object" &&
      Array.isArray(node.strokes) && node.strokes.some((stroke) => stroke.visible !== false)) {
    for (const [side, weight] of Object.entries(node.individualStrokeWeights)) {
      if (["top", "right", "bottom", "left"].includes(side)) {
        add(`border${side[0].toUpperCase()}${side.slice(1)}Width`, `individualStrokeWeights.${side}`, weight);
      }
    }
  }
  if (Object.hasOwn(node, "visible")) {
    if (typeof node.visible !== "boolean") throw new Error("VISUAL_STRUCTURED_INVALID: visible must be boolean");
    add("visibility", "visible", node.visible, node.visible ? "visible" : "hidden");
  }
  if (Object.hasOwn(node, "parentId")) add("parentId", "parentId", node.parentId);
  else if (node.parent?.id) add("parentId", "parent.id", node.parent.id);
  if (Object.hasOwn(node, "childIds")) add("childIds", "childIds", node.childIds);
  else if (Object.hasOwn(node, "children")) add("childIds", "children", node.children,
    node.children.map((child) => child.id ?? child.nodeId));
  const paints = Object.hasOwn(node, "fills") ? node.fills : Object.hasOwn(node, "fill") ? [node.fill] : undefined;
  if (paints !== undefined) {
    if (!Array.isArray(paints)) throw new Error("VISUAL_STRUCTURED_INVALID: fills must be an array");
    for (const paint of paints) {
      const color = paintColor(paint);
      if (color !== undefined) add("fill", Object.hasOwn(node, "fills") ? "fills" : "fill", paint, color);
    }
  }
  if (Object.hasOwn(node, "strokes")) {
    if (!Array.isArray(node.strokes)) throw new Error("VISUAL_STRUCTURED_INVALID: strokes must be an array");
    const applied = node.strokes.filter((stroke) => stroke.visible !== false);
    // One `stroke` fact on both branches -- absence is the same byte-for-byte
    // "none" it has always been, presence is the normalized record rather than
    // the raw paint array only Figma could ever restate.
    const { value } = figmaStroke(node);
    // An unsupported stroke shape emits nothing at all -- not the record, and
    // not the retained scalars either: two paints have two `borderColor`s, and
    // resolving that as a conflict would abort the run that §7.19 keeps going.
    if (value !== undefined) {
      add("stroke", "strokes", node.strokes, value);
      if (applied.length) {
        if (Object.hasOwn(node, "strokeWeight")) add("borderWidth", "strokeWeight", node.strokeWeight);
        for (const stroke of applied) {
          const color = paintColor(stroke);
          if (color !== undefined) add("borderColor", "strokes", stroke, color);
        }
      }
    }
  }
  if (Object.hasOwn(node, "effects")) {
    if (!Array.isArray(node.effects)) throw new Error("VISUAL_STRUCTURED_INVALID: effects must be an array");
    const { value } = figmaShadows(node);
    if (value !== undefined) add("boxShadow", "effects", node.effects, value);
  }
  return facts;
};

const CONTAINER_TEXT_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "INSTANCE", "SECTION", "PAGE", "TEXT"]);

/** One asset retrieval's identity; omit retrieval fields until they are actually returned. */
export const structuredAssetIdentity = (record, retrieval = {}) => {
  if (typeof record?.digest !== "string") {
    throw new Error("VISUAL_STRUCTURED_INVALID: captured snapshot digest is required");
  }
  const node = readStructuredNode(record);
  const isAsset = node.isAsset === true ||
    ((node.parentId ?? node.parent?.id) !== undefined && node.visible === true &&
      typeof node.type === "string" && !CONTAINER_TEXT_TYPES.has(node.type));
  if (!isAsset) return undefined;
  if (typeof node.type !== "string" || !node.type) {
    throw new Error("VISUAL_STRUCTURED_INVALID: asset node type is required");
  }
  const identity = { nodeId: record.nodeId, type: node.type,
    ...(Object.hasOwn(node, "isAsset") ? { isAsset: node.isAsset } : {}) };
  const exportKind = retrieval.exportKind ?? node.exportKind;
  const mimeType = retrieval.mimeType ?? node.mimeType;
  if (exportKind !== undefined) identity.exportKind = exportKind;
  if (mimeType !== undefined) identity.mimeType = mimeType;
  if (retrieval.content !== undefined) identity.contentDigest = structuredDigest(retrieval.content);
  return identity;
};

export const STRUCTURED_PROVENANCE_RANKS = Object.freeze({
  STRUCTURED_NODE: 1, VARIABLE_BINDING: 2, METADATA: 3,
  DESIGN_CONTEXT_LITERAL: 4, PERCEPTUAL: 5,
});

const METADATA_PROPERTIES = new Set([...GEOMETRY_FACTS, "parentId", "childIds"]);
const LITERAL_PREFIXES = Object.freeze({
  gap: ["gap"], rowGap: ["gap-y"], columnGap: ["gap-x"],
  paddingTop: ["pt", "py"], paddingRight: ["pr", "px"],
  paddingBottom: ["pb", "py"], paddingLeft: ["pl", "px"],
  fill: ["bg", "text"], fontSize: ["text"], lineHeight: ["leading"],
  borderTopLeftRadius: ["rounded"], borderTopRightRadius: ["rounded"],
  borderBottomRightRadius: ["rounded"], borderBottomLeftRadius: ["rounded"],
  opacity: ["opacity"],
});

/** Closed bracketed Tailwind literals, scoped to the JSX tag that names this node. */
export const extractNodeLiterals = (text, nodeId, snapshotDigest = structuredDigest(text)) => {
  const facts = [];
  for (const tag of text.match(/<[^>]+>/g) ?? []) {
    if (!tag.includes(`data-node-id="${nodeId}"`)) continue;
    const classes = /className="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];
    for (const rawProperty of classes) {
      const match = /^([a-z-]+)-\[([^\]]+)\]$/i.exec(rawProperty);
      if (!match) continue;
      for (const [property, prefixes] of Object.entries(LITERAL_PREFIXES)) {
        if (!prefixes.includes(match[1])) continue;
        try {
          const value = normalizeVisualValue(property, match[2]);
          facts.push({ nodeId, property, value, source: "DESIGN_CONTEXT_LITERAL", rawProperty, snapshotDigest });
        } catch { /* A bracketed class for another CSS property establishes nothing here. */ }
      }
    }
  }
  return facts;
};

const isCitedLiteral = (item, property) => {
  const match = /^([a-z-]+)-\[([^\]]+)\]$/i.exec(item.rawProperty ?? "");
  if (!match || !LITERAL_PREFIXES[property]?.includes(match[1])) return false;
  try {
    return JSON.stringify(normalizeVisualValue(property, match[2])) ===
      JSON.stringify(normalizeVisualValue(property, item.value));
  } catch (error) {
    if (error instanceof VisualValueError) return false;
    throw error;
  }
};

/** Resolve one node-owned fact. Variable bindings annotate the value; defaults never certify. */
export const resolveVisualProvenance = (evidence, nodeId, property) => {
  const matches = evidence.filter((item) => item.nodeId === nodeId && item.property === property);
  if (matches.some((item) => item.source === "STRUCTURED_NODE" &&
      !/^[0-9a-f]{64}$/.test(item.snapshotDigest ?? ""))) {
    throw new Error(`VISUAL_FACT_UNBACKED: ${nodeId}.${property} has no captured structured snapshot digest`);
  }
  const support = matches.filter((item) => Object.hasOwn(STRUCTURED_PROVENANCE_RANKS, item.source) &&
    item.source !== "VARIABLE_BINDING" &&
    (item.source !== "METADATA" || METADATA_PROPERTIES.has(property)) &&
    (item.source !== "DESIGN_CONTEXT_LITERAL" || isCitedLiteral(item, property)));
  if (!support.some((item) => item.source !== "PERCEPTUAL")) return undefined;
  const values = new Map();
  for (const item of support) {
    const value = normalizeVisualValue(property, item.value);
    const key = JSON.stringify(value);
    const rank = STRUCTURED_PROVENANCE_RANKS[item.source];
    const atRank = values.get(rank) ?? new Map();
    atRank.set(key, [...(atRank.get(key) ?? []), item]);
    values.set(rank, atRank);
  }
  for (const atRank of values.values()) if (atRank.size > 1) {
    throw new Error(`VISUAL_PROVENANCE_AMBIGUOUS: ${nodeId}.${property} has multiple values at one rank`);
  }
  if (new Set([...values.values()].map((atRank) => [...atRank.keys()][0])).size > 1) {
    throw new Error(`VISUAL_PROVENANCE_CONFLICT: ${nodeId}.${property} differs across ranks`);
  }
  const rank = Math.min(...values.keys());
  const [valueKey, strongest] = [...values.get(rank)][0];
  const structured = support.filter((item) => item.source === "STRUCTURED_NODE");
  const bindings = matches.filter((item) => item.source === "VARIABLE_BINDING" &&
    structured.some((fact) => fact.bindingId === item.tokenId));
  const tokenIds = bindings.map((item) => item.tokenId);
  if (bindings.some((item) => !item.tokenId || (item.value !== undefined &&
      JSON.stringify(normalizeVisualValue(property, item.value)) !== valueKey))) {
    throw new Error(`VISUAL_PROVENANCE_CONFLICT: ${nodeId}.${property} variable binding disagrees or has no token`);
  }
  return { nodeId, property, value: JSON.parse(valueKey), support: strongest[0],
    corroborating: support.filter((item) => STRUCTURED_PROVENANCE_RANKS[item.source] > rank),
    ...(tokenIds.length ? { tokenIds: [...new Set(tokenIds)].sort() } : {}) };
};

const STRUCTURAL_PROPERTIES = new Set(["type", "isAsset", "parentId", "childIds"]);

/** Derive the complete comparable set from pinned node bytes, not the contract. */
export const deriveStructuredAuthority = ({ records, rootId, ancestry, metadataFacts = [], literalFacts = [],
  sourceDigests = {}, assets = [], screenshotDigest, capture }) => {
  const byId = new Map(records.map((record) => [record.nodeId, record]));
  if (byId.size !== records.length || !byId.has(rootId)) {
    throw new Error("VISUAL_STRUCTURED_INVALID: root or unique node snapshots missing");
  }
  const nodes = {};
  const certified = [];
  for (const record of records) {
    const recaptured = captureStructuredNode({ nodeId: record.nodeId, rawSnapshot: record.rawSnapshot, capture: record.capture });
    for (const key of ["digest", "parentId", "childIds", "propertyKeys"]) {
      if (JSON.stringify(record[key]) !== JSON.stringify(recaptured[key])) {
        throw new Error(`VISUAL_AUTHORITY_TAMPERED: ${record.nodeId}.${key} differs from pinned bytes`);
      }
    }
    const expectedPath = ancestry(record.nodeId);
    if (!expectedPath || expectedPath[0] !== rootId || expectedPath.at(-1) !== record.nodeId ||
        (record.nodeId !== rootId && record.parentId !== expectedPath.at(-2))) {
      throw new Error(`VISUAL_HIERARCHY_MISMATCH: metadata and structured ancestry disagree for ${record.nodeId}`);
    }
    for (const childId of record.childIds ?? []) {
      if (!byId.has(childId) || byId.get(childId).parentId !== record.nodeId ||
          JSON.stringify(ancestry(childId)) !== JSON.stringify([...expectedPath, childId])) {
        throw new Error(`VISUAL_HIERARCHY_MISMATCH: structured child ${childId} is absent or misparented`);
      }
    }
    const extracted = [...extractStructuredFacts(record),
      ...metadataFacts.filter((fact) => fact.nodeId === record.nodeId),
      ...literalFacts.filter((fact) => fact.nodeId === record.nodeId)];
    const facts = {};
    for (const property of new Set(extracted.map((fact) => fact.property))) {
      const resolved = resolveVisualProvenance(extracted, record.nodeId, property);
      if (!resolved) continue;
      certified.push({ nodeId: record.nodeId, property, value: resolved.value,
        rank: STRUCTURED_PROVENANCE_RANKS[resolved.support.source], rawProperty: resolved.support.rawProperty,
        snapshotDigest: resolved.support.snapshotDigest ?? null });
      if (!STRUCTURAL_PROPERTIES.has(property)) facts[property] = resolved;
    }
    const rawNode = JSON.parse(record.rawSnapshot);
    // A shape neither domain can represent leaves its dimension unprovable
    // *with its reason*, so FIGMA_CAPABILITY_INCOMPLETE says why rather than
    // just which key is missing.
    const unsupported = Object.fromEntries([
      ["stroke", Array.isArray(rawNode.strokes) ? figmaStroke(rawNode).unsupported : undefined],
      ["effects", Array.isArray(rawNode.effects) ? figmaShadows(rawNode).unsupported : undefined],
    ].filter(([, reason]) => reason !== undefined));
    nodes[record.nodeId] = { type: rawNode.type, isAsset: rawNode.isAsset, facts,
      parentId: record.parentId, childIds: record.childIds,
      ...(Object.keys(unsupported).length ? { unsupported } : {}) };
  }
  const assetIds = [...new Set(assets.map((asset) => asset.nodeId))].sort();
  const requiredAssets = records.flatMap((record) => structuredAssetIdentity(record) ? [record.nodeId] : []).sort();
  if (JSON.stringify(assetIds) !== JSON.stringify(requiredAssets)) {
    throw new Error(`VISUAL_ASSET_OMITTED: asset-bearing subtree requires ${requiredAssets.join(", ")}`);
  }
  for (const id of assetIds) {
    const primary = assets.find((asset) => asset.nodeId === id && asset.exportKind === "SVG") ??
      assets.find((asset) => asset.nodeId === id);
    if (!primary?.contentDigest || !primary.exportKind || !primary.mimeType) {
      throw new Error(`VISUAL_ASSET_OMITTED: ${id} has no official export bytes, kind or MIME type`);
    }
    nodes[id].facts.assetContentDigest = { nodeId: id, property: "assetContentDigest",
      value: primary.contentDigest, support: { source: "STRUCTURED_NODE", rawProperty: "officialExport.content",
        snapshotDigest: byId.get(id).digest } };
    certified.push({ nodeId: id, property: "assetContentDigest", value: primary.contentDigest,
      rank: 1, rawProperty: "officialExport.content", snapshotDigest: byId.get(id).digest });
  }
  nodes[rootId].facts.assets = { nodeId: rootId, property: "assets", value: assetIds,
    support: { source: "STRUCTURED_NODE", snapshotDigest: byId.get(rootId).digest } };
  certified.push({ nodeId: rootId, property: "assets", value: assetIds, rank: 1,
    snapshotDigest: byId.get(rootId).digest });
  const authorityDigest = structuredDigest(JSON.stringify({
    versionPinned: false, versionSource: "none", rootId,
    records: records.map((record) => ({ nodeId: record.nodeId, digest: record.digest,
      parentId: record.parentId, childIds: record.childIds, propertyKeys: record.propertyKeys,
      capture: record.capture })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    certified: certified.sort((a, b) => `${a.nodeId}.${a.property}`.localeCompare(`${b.nodeId}.${b.property}`)),
    assets: [...assets].sort((a, b) => a.nodeId.localeCompare(b.nodeId)), screenshotDigest, capture,
    sourceDigests,
  }));
  return { nodes, authorityDigest, versionPinned: false, versionSource: "none" };
};

/** The same node contract and target comparison for module and artifact engines. */
export const validateStructuredContract = (authorityNodes, contractNodes, { requireProvenance = false } = {}) => {
  if (!contractNodes || typeof contractNodes !== "object" || Array.isArray(contractNodes)) {
    throw new Error("VISUAL_FACT_OMITTED: node-scoped contract is required");
  }
  const normalized = {};
  for (const [nodeId, authority] of Object.entries(authorityNodes)) {
    const claimed = contractNodes[nodeId];
    if (!claimed) throw new Error(`VISUAL_FACT_OMITTED: node ${nodeId} is absent`);
    if (typeof claimed.targetLocator !== "string" || !claimed.targetLocator.trim()) {
      throw new Error(`VISUAL_TARGET_LOCATOR_MISSING: ${nodeId}`);
    }
    const expected = claimed.expect ?? claimed.facts;
    if (!expected || typeof expected !== "object") throw new Error(`VISUAL_FACT_OMITTED: ${nodeId}.facts absent`);
    for (const [property, fact] of Object.entries(expected)) {
      if (!authority.facts[property]) {
        const owner = Object.entries(authorityNodes).find(([id, node]) => id !== nodeId && node.facts[property] &&
          JSON.stringify(node.facts[property].value) === JSON.stringify(normalizeVisualValue(property, fact?.value)));
        throw new Error(`${owner ? "VISUAL_FACT_NODE_MISATTRIBUTED" : "VISUAL_FACT_UNBACKED"}: ${nodeId}.${property}`);
      }
    }
    for (const [property, resolved] of Object.entries(authority.facts)) {
      if (!Object.hasOwn(expected, property)) throw new Error(`VISUAL_FACT_OMITTED: ${nodeId}.${property}`);
      if (requireProvenance) {
        const cited = expected[property].provenance;
        if (cited?.nodeId !== nodeId) throw new Error(`VISUAL_FACT_NODE_MISATTRIBUTED: ${nodeId}.${property}`);
        if (cited.kind !== resolved.support.source || cited.rawProperty !== resolved.support.rawProperty ||
            cited.snapshotDigest !== resolved.support.snapshotDigest) {
          throw new Error(`VISUAL_FACT_UNBACKED: ${nodeId}.${property} provenance differs from pinned source`);
        }
      }
      if (JSON.stringify(normalizeVisualValue(property, expected[property]?.value)) !== JSON.stringify(resolved.value)) {
        throw new Error(`VISUAL_CONTRACT_DIVERGES: ${nodeId}.${property}`);
      }
    }
    normalized[nodeId] = { targetLocator: claimed.targetLocator, expect: expected };
  }
  for (const nodeId of Object.keys(contractNodes)) {
    if (!authorityNodes[nodeId]) throw new Error(`VISUAL_FACT_NODE_MISATTRIBUTED: unknown node ${nodeId}`);
  }
  return normalized;
};

/**
 * §7.19's field-by-field comparison: `color`, `style`, `align` and `applied` as
 * `equals`, `width` and every side of `widths` as `px` at the run's tolerance.
 * A field one side carries and the other does not is a divergence -- a field's
 * presence is itself evidence -- and `"none"` against a record is one too.
 */
const flattenStroke = (record) => record === "none" ? { applied: false } :
  Object.fromEntries(Object.entries(record).flatMap(([field, value]) => field === "widths"
    ? Object.entries(value).map(([side, width]) => [`widths.${side}`, width])
    : [[field, value]]));

const compareStrokeFact = (fact, actual, compareFact, tolerance) => {
  if (actual === undefined) return "was not measured";
  let observed;
  try {
    observed = flattenStroke(normalizeVisualValue("stroke", actual));
  } catch (error) {
    if (!(error instanceof VisualValueError)) throw error;
    return `was measured as ${JSON.stringify(actual)}, which ${error.message.replace(/^VISUAL_VALUE_UNSUPPORTED: .*? value .*? /, "")}`;
  }
  const expected = flattenStroke(normalizeVisualValue("stroke", fact.value));
  for (const field of new Set([...Object.keys(expected), ...Object.keys(observed)])) {
    if (!Object.hasOwn(expected, field) || !Object.hasOwn(observed, field)) {
      return `expected stroke fields ${JSON.stringify(Object.keys(expected).sort())}, observed ${JSON.stringify(Object.keys(observed).sort())}`;
    }
    const kind = field === "width" || field.startsWith("widths.") ? "px" : "equals";
    const mismatch = compareFact({ kind, value: expected[field] }, observed[field], tolerance);
    if (mismatch) return `stroke.${field} ${mismatch}`;
  }
  return null;
};

export const compareStructuredTarget = (contractNodes, observation, compareFact, tolerance) => {
  const failures = [];
  for (const [nodeId, contract] of Object.entries(contractNodes)) {
    const measured = observation.nodes?.[nodeId];
    if (measured?.targetLocator !== contract.targetLocator || !measured.values || typeof measured.values !== "object") {
      failures.push(`${nodeId} targetLocator or measurements missing`);
      continue;
    }
    if (contract.parentId !== undefined && measured.parentNodeId !== contract.parentId) {
      failures.push(`${nodeId} parentNodeId expected ${contract.parentId}`);
    }
    for (const [property, fact] of Object.entries(contract.expect)) {
      const mismatch = property === "stroke"
        ? compareStrokeFact(fact, measured.values[property], compareFact, tolerance)
        : compareFact({ ...fact, normalized: property }, measured.values[property], tolerance);
      if (mismatch) failures.push(`${nodeId}.${property} ${mismatch}`);
    }
  }
  return failures;
};

const STRUCTURED_REQUIRED = Object.freeze({
  FRAME: { geometry: ["width", "height"], spacing: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap"],
    fill: ["fill"], stroke: ["stroke"], effects: ["boxShadow"],
    radius: ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"],
    opacity: ["opacity"], visibility: ["visibility"], hierarchy: ["childIds"], assets: ["assets"] },
  TEXT: { geometry: ["width", "height"], typography: ["fontFamily", "fontStyle", "fontWeight", "fontSize", "lineHeight"],
    fill: ["fill"], opacity: ["opacity"], visibility: ["visibility"], hierarchy: ["parentId"] },
  ELLIPSE: { geometry: ["width", "height"], fill: ["fill"], opacity: ["opacity"],
    visibility: ["visibility"], hierarchy: ["parentId"], assets: ["isAsset", "assetContentDigest"] },
});

export const structuredCapabilityProfile = (nodes, targetMatched = false) => {
  const profile = {};
  const unresolved = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    const required = STRUCTURED_REQUIRED[node.type] ?? { geometry: ["width", "height"], visibility: ["visibility"] };
    profile[nodeId] = {};
    for (const [dimension, properties] of Object.entries(required)) {
      const missing = properties.filter((property) =>
        property === "parentId" || property === "childIds" ? node[property] === undefined :
        property === "isAsset" ? node.isAsset !== true : !Object.hasOwn(node.facts, property));
      profile[nodeId][dimension] = missing.length ? "NOT_PROVABLE" : targetMatched ? "SEMANTICALLY_PROVEN" : "PARTIALLY_PROVEN";
      if (missing.length) {
        unresolved.push({ nodeId, dimension, missing,
          ...(node.unsupported?.[dimension] ? { reason: node.unsupported[dimension] } : {}) });
      }
    }
    profile[nodeId].tokenBinding = Object.values(node.facts).some((fact) => fact.tokenIds?.length)
      ? "PARTIALLY_PROVEN" : "NOT_PROVABLE";
    if (node.childIds !== undefined) profile[nodeId].wholeFrameLayout = targetMatched
      ? "VISUALLY_PROVEN" : "PARTIALLY_PROVEN";
  }
  return { profile, unresolved };
};

export const assertStructuredCaptureScale = (capture, viewport) => {
  const positive = (value) => Number.isInteger(value) && value > 0;
  const { requested, returned, frameBox, compare } = capture ?? {};
  if (![frameBox?.width, frameBox?.height, returned?.imageWidth, returned?.imageHeight,
    requested?.width, requested?.height, requested?.maxDimension].every(positive) ||
    capture.imageWidth !== returned.imageWidth || capture.imageHeight !== returned.imageHeight ||
    compare?.width !== frameBox.width || compare?.height !== frameBox.height ||
    frameBox.width !== viewport.width || frameBox.height !== viewport.height) {
    throw new Error("VISUAL_CAPTURE_MISMATCH: requested, returned, frameBox and compare must be pinned");
  }
  const k = returned.imageWidth / frameBox.width;
  if (!Number.isInteger(k) || k < 1 || returned.imageHeight !== frameBox.height * k) {
    throw new Error(`VISUAL_CAPTURE_DOWNSCALED: returned ${returned.imageWidth}x${returned.imageHeight} for ${frameBox.width}x${frameBox.height}`);
  }
  return k;
};
