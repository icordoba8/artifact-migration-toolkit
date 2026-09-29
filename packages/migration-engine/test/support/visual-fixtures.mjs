// The synthetic visual-authority fixture set: one frame, one taxonomy, one
// render, spelled once for both authority origins.
//
// Slice D drives the *installed* bundle, so nothing here imports the engine --
// these are bytes and JSON documents a consumer would have authored by hand.
// The renders are real PNGs (pngjs writes them), because the perceptual gate
// decodes what it is given and a hand-rolled fixture writer is exactly what
// Slice C deleted.
//
// ponytail: `migration-contract.test.mjs` still carries its own copy of these
// shapes from Slices A-C. Folding that suite onto this module is a mechanical
// delete-and-import; it is out of Slice D's scope, so the dedupe is named here
// rather than done here.

import { createHash } from "node:crypto";
import { PNG } from "pngjs";

export const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export const VIEWPORT = { width: 1280, height: 720 };
export const COMPARE = { width: 40, height: 20 };
export const FIGMA_URL =
  "https://www.figma.com/design/ABC123def/Flow?node-id=12-34";
export const FIGMA_KEY = "ABC123def";
export const FIGMA_NODE = "12:34";
export const LEGACY_FRAME_ID = "UIB-1::DEFAULT";
export const LEGACY_CONTEXT_FILE = "inventories/legacy-runtime-context.json";
export const FIGMA_CONTEXT_FILE = "inventories/figma-context.json";
export const LEGACY_AUTHORITY_DIR = "inventories/legacy-runtime/UIB-1-DEFAULT";
export const FIGMA_AUTHORITY_DIR = "inventories/figma/12-34";

/**
 * A deterministic render: a dark block on a light field. `shift` moves the
 * block without touching a single measured fact, which is the whole point of
 * the perceptual-only injection; `scale` renders the same surface at 2x, which
 * is what a Figma design export looks like next to a DSF-1 runtime capture.
 */
export const visualPng = (scale = 1, shift = 0) => {
  const png = new PNG({ width: COMPARE.width * scale, height: COMPARE.height * scale });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const dark =
        x >= (5 + shift) * scale &&
        x < (20 + shift) * scale &&
        y >= 4 * scale &&
        y < 15 * scale;
      const offset = (y * png.width + x) * 4;
      png.data.fill(dark ? 30 : 245, offset, offset + 3);
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
};

/** The authority's own render, and the byte-identical target capture of it. */
export const SHARED_RENDER = visualPng();

export const TARGET_CAPTURE = {
  role: "TARGET_VERIFICATION",
  mode: "element",
  rootLocator: "getByRole('main')",
  deviceScaleFactor: 1,
  colorScheme: "light",
  reducedMotion: "reduce",
  matte: "#ffffff",
  compare: COMPARE,
  imageWidth: COMPARE.width,
  imageHeight: COMPARE.height,
};

export const FIGMA_VARIABLES = {
  "color/text": "#16202C",
  "color/surface": "#0B5FFF",
  "color/border": "#D9E1EA",
  "spacing/lg": "16px",
  "spacing/gap": "12px",
  "radius/md": "8px",
  primaryActions: 1,
  navigation: false,
  layout: "column",
};

export const FIGMA_DESIGN_CONTEXT = [
  "font-family: Inter, sans-serif; font-size: 14px; line-height: 20px;",
  "font-weight: 600; border-width: 1px; box-shadow: 0 1px 2px rgba(0,0,0,0.2);",
  "opacity: 1; visibility: visible; letter-spacing: 0.2px;",
  "width: 1280px; height: 720px; background-color: #0B5FFF;",
].join("\n");

export const figmaMetadata = () =>
  `<frame id="${FIGMA_NODE}" name="Sign in" x="0" y="0" width="${VIEWPORT.width}" height="${VIEWPORT.height}"><instance id="12:40" name="Button" width="120" height="36" /><vector id="12:41" name="icon/chevron" width="24" height="24" /><vector id="12:42" name="logo/mark" width="32" height="32" /></frame>\n`;

/**
 * One fact per taxonomy group, each bound through the strongest provenance kind
 * that can carry it: geometry off the node's metadata box, tokens off the
 * variable pointers, the rest out of the node-scoped design context.
 */
export const figmaFacts = (node = FIGMA_NODE) => {
  const at = (kind, file) => (selector, value) => ({
    value,
    provenance: { kind, reference: `${FIGMA_AUTHORITY_DIR}/${file}`, nodeId: node, selector },
  });
  const dc = at("designContext", "design-context.txt");
  const variable = at("variableDefs", "variable-defs.json");
  const box = at("metadata", "metadata.xml");
  return {
    width: box("width", VIEWPORT.width),
    height: box("height", VIEWPORT.height),
    padding: variable("/spacing~1lg", "16px"),
    gap: variable("/spacing~1gap", "12px"),
    color: variable("/color~1text", "#16202C"),
    backgroundColor: variable("/color~1surface", "#0B5FFF"),
    borderColor: variable("/color~1border", "#D9E1EA"),
    borderRadius: variable("/radius~1md", "8px"),
    fontFamily: dc("font-family", "Inter, sans-serif"),
    fontSize: dc("font-size", "14px"),
    fontWeight: dc("font-weight", 600),
    lineHeight: dc("line-height", "20px"),
    borderWidth: dc("border-width", "1px"),
    boxShadow: dc("box-shadow", "0 1px 2px rgba(0,0,0,0.2)"),
    opacity: dc("opacity", 1),
    visibility: dc("visibility", "visible"),
    assets: box("assets", ["logo/mark", "icon/chevron"]),
    letterSpacing: dc("letter-spacing", "0.2px"),
    primaryActions: variable("/primaryActions", 1),
    navigation: variable("/navigation", false),
    layout: variable("/layout", "column"),
  };
};

/** The taxonomy as one contract row's `expect`, in the authority's own values. */
export const taxonomyExpect = () => ({
  width: { kind: "px", value: VIEWPORT.width, locator: "main" },
  height: { kind: "px", value: VIEWPORT.height, locator: "main" },
  padding: { kind: "px", value: 16, locator: "main" },
  gap: { kind: "px", value: 12, locator: "main" },
  color: { kind: "equals", value: "#16202c", locator: "main" },
  backgroundColor: { kind: "equals", value: "rgb(11, 95, 255)", locator: "main" },
  borderColor: { kind: "equals", value: "#d9e1ea", locator: "main" },
  borderRadius: { kind: "px", value: 8, locator: "main" },
  borderWidth: { kind: "px", value: 1, locator: "main" },
  fontFamily: { kind: "equals", value: "Inter, sans-serif", locator: "main" },
  fontSize: { kind: "px", value: 14, locator: "main" },
  fontWeight: { kind: "equals", value: 600, locator: "main" },
  lineHeight: { kind: "px", value: 20, locator: "main" },
  boxShadow: { kind: "equals", value: "0 1px 2px rgba(0,0,0,0.2)", locator: "main" },
  opacity: { kind: "equals", value: 1, locator: "main" },
  visibility: { kind: "equals", value: "visible", locator: "main" },
  assets: { kind: "equals", value: ["logo/mark", "icon/chevron"], locator: "main img" },
  letterSpacing: { kind: "equals", value: "0.2px", locator: "main" },
  primaryActions: {
    kind: "count",
    value: 1,
    locator: "getByRole('button', { name: 'Sign in' })",
  },
  navigation: { kind: "present", value: false, locator: "getByRole('navigation')" },
  layout: { kind: "equals", value: "column", locator: "form computed flex-direction" },
});

/**
 * The runtime measurement of a perfect implementation. Spelled the way a
 * browser spells it -- `rgb()`, `"14px"`, `"600"` -- so the proof exercises the
 * normalized space rather than a string match on the design's own spelling.
 */
export const MEASURED = {
  width: VIEWPORT.width,
  height: VIEWPORT.height,
  padding: "16px",
  gap: "12px",
  color: "rgb(22, 32, 44)",
  backgroundColor: "rgb(11, 95, 255)",
  borderColor: "rgb(217, 225, 234)",
  borderRadius: "8px",
  borderWidth: "1px",
  fontFamily: '"Inter", sans-serif',
  fontSize: "14px",
  fontWeight: "600",
  lineHeight: "20px",
  boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
  opacity: "1",
  visibility: "visible",
  assets: ["icon/chevron", "logo/mark"],
  letterSpacing: "0.2px",
  primaryActions: 1,
  navigation: false,
  layout: "column",
};

/** The authority's scoped control tree. The heading is the removable control:
 * no requiredObservation names it, so deleting it reaches the structural gate
 * instead of the runtime-observation sweep. */
export const AUTHORITY_CONTROLS = [
  { role: "button", name: "Sign in", state: "DEFAULT" },
  { role: "heading", name: "Sign in", state: "DEFAULT" },
];

export const NATIVE_EXTRA = { role: "link", name: "Help" };

/** The TARGET's own control tree, as a playwright-ui-proof/v1 observation. */
export const targetControls = () => [
  {
    role: "button",
    name: "Sign in",
    state: "DEFAULT",
    present: true,
    visible: true,
    text: "Sign in",
    assertions: [
      { predicate: "presence", expected: true },
      { predicate: "visibility", expected: true },
      { predicate: "text", expected: "Sign in" },
      { predicate: "url", expected: "http://localhost/auth/sign-in" },
    ],
  },
  {
    role: "heading",
    name: "Sign in",
    state: "DEFAULT",
    present: true,
    visible: true,
    assertions: [{ predicate: "presence", expected: true }],
  },
];

export const TARGET_INVENTORY = {
  version: 1,
  implementationState: "ABSENT",
  evidence: [
    {
      category: "SOURCE",
      kind: "CODE",
      status: "PRESENT",
      location: "target/src/placeholder.ts",
      requirementIds: ["AUTH-REQ-001"],
      scenarioIds: ["AUTH-SCN-001"],
    },
    {
      category: "RUNTIME_OBSERVATION",
      kind: "OBSERVATION",
      status: "NOT_APPLICABLE",
      reason: "No runtime capture was taken for this fixture.",
      requirementIds: [],
      scenarioIds: [],
    },
    {
      category: "REQUIREMENT_TRACE",
      kind: "DOCS",
      status: "PRESENT",
      location: "target/src/placeholder.ts",
      requirementIds: ["AUTH-REQ-001"],
      scenarioIds: ["AUTH-SCN-001"],
    },
  ],
  hasVisibleUi: true,
  navigationSurfaces: [],
  nativeBehaviors: [{ id: "TN-1", description: "Target-only telemetry" }],
  uiComponents: [
    {
      id: "UC-1",
      requirement: "Primary action button",
      actualSource: "design-system/Button",
      equivalentAvailable: true,
      expectedComponent: "design-system/Button",
      evidence: "target/src/placeholder.ts",
    },
  ],
  uiMismatches: [
    {
      id: "UIM-1",
      uiBehaviorId: "UIB-1",
      disposition: "REQUIRED_BEHAVIOR",
      rationale: "The visible action is required behavior.",
      evidence: ["legacy/auth/marker.txt"],
    },
  ],
};

export const SLICES = [
  {
    id: "slice-a",
    requirementIds: ["AUTH-REQ-001"],
    scenarioIds: ["AUTH-SCN-001"],
    traceIds: ["BR-1", "RR-1"],
    capabilityIds: ["CAP-1"],
    architectureAuthorities: [],
    targetPaths: ["src"],
    dependencies: [],
    acceptanceScenarios: ["Sign in succeeds"],
  },
  {
    id: "slice-b",
    requirementIds: ["AUTH-REQ-002"],
    scenarioIds: ["AUTH-SCN-002"],
    traceIds: ["NR-1", "DR-1"],
    capabilityIds: [],
    architectureAuthorities: [],
    targetPaths: ["src"],
    dependencies: [],
    acceptanceScenarios: ["Sign out succeeds"],
  },
];

export const matrices = ({ final = false, nativeControls } = {}) => ({
  "matrices/behavior-parity.json": {
    version: 1,
    rows: [
      {
        id: "BR-1",
        behaviorId: "LB-1",
        targetState: "ABSENT",
        disposition: "IMPLEMENT",
        legacyEvidence: ["legacy/auth/marker.txt"],
        verificationStatus: final ? "VERIFIED" : "PENDING",
      },
    ],
  },
  "matrices/route-adaptation.json": {
    version: 1,
    rows: [
      {
        id: "RR-1",
        routeFlowId: "RF-1",
        targetAdaptation: "app/(auth)/login",
        verificationStatus: final ? "VERIFIED" : "PENDING",
        evidence: final ? ["target/src/placeholder.ts"] : [],
      },
    ],
  },
  "matrices/target-native.json": {
    version: 1,
    rows: [
      {
        id: "NR-1",
        nativeBehaviorId: "TN-1",
        verificationStatus: nativeControls || final ? "PRESERVED" : "PENDING",
        ...(nativeControls ? { controls: nativeControls } : {}),
      },
    ],
  },
  "matrices/design-system-usage.json": {
    version: 1,
    rows: [
      {
        id: "DR-1",
        componentId: "UC-1",
        authority: "design-system/Button",
        actualSource: "design-system/Button",
        status: "COMPLIANT",
        verificationStatus: final ? "VERIFIED" : "PENDING",
      },
    ],
  },
  "matrices/capability-ownership.json": {
    version: 1,
    architectureAuthorities: [],
    authorityGaps: [],
    rows: [
      {
        id: "CAP-1",
        capability: "Credential form shell",
        classification: "FEATURE_LOCAL",
        requiredDisposition: "CREATE_FEATURE_LOCAL",
        legacyEvidence: ["legacy/auth/marker.txt"],
        targetEvidence: [],
        consumers: ["auth"],
        targetOwner: "src/features/auth/form",
        replacedBy: [],
        rationale: "Only auth consumes it.",
      },
      {
        id: "CAP-2",
        capability: "Typed placeholder module",
        classification: "TARGET_REUSE",
        requiredDisposition: "REUSE_EXISTING",
        legacyEvidence: ["legacy/auth/marker.txt"],
        targetEvidence: ["target/src/placeholder.ts"],
        consumers: ["auth"],
        targetOwner: "src",
        replacedBy: [],
        rationale: "Already present.",
      },
    ],
  },
});

export const GATES = [
  "ARCHITECTURE_PLAN_GATE",
  "TARGETED_VERIFY",
  "FUNCTIONAL_PARITY_GATE",
  "SIMPLIFY_ONCE",
  "ARCHITECTURE_IMPLEMENTATION_GATE",
  "PRECOMMIT_GATE",
  "FINAL_VERIFY",
];

export const STEP_DOCS = {
  DISCOVER_LEGACY: ["02", "discover-legacy", "Discover legacy"],
  DISCOVERY_COMPLETENESS: ["02a", "discovery-completeness", "Discovery completeness"],
  ASSESS_TARGET: ["03", "assess-target", "Assess target"],
  BUILD_BASELINE: ["04", "build-baseline", "Build baseline"],
  PLAN: ["05", "plan", "Plan"],
  IMPLEMENT_SLICES: ["06", "implement-slices", "Implement slices"],
  VERIFY_SLICES: ["07", "verify-slices", "Verify slices"],
  FINALIZE: ["08", "finalize", "Finalize"],
};
