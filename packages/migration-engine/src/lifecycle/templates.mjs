/**
 * Lifecycle: step-document templates and the RESOLVE step. Moved verbatim from
 * `resumable-migration.mjs` (Track A8).
 */
import { CENSUS_ALGORITHM_VERSION } from "../census/index.mjs";
import {
  CAPABILITY_OWNERSHIP_FILE,
  FIGMA_CONTEXT_FILE,
  LEGACY_RUNTIME_CONTEXT_FILE,
  MIGRATION_FORMAT_VERSION,
  MODULE_CLASSIFICATION_FILE,
  RESUMABLE_CONTRACT_VERSION,
  UI_PROOF_FORMAT,
  usesMultiSource,
  VISUAL_ACCEPTANCE_FILE,
  WORKFLOW_VERSION,
} from "../formats/index.mjs";
import {
  FIXED_VISUAL_TOLERANCE,
  HARDENED_VISUAL_VERSION,
  LEGACY_AUTHORITY_ROLE,
  LEGACY_RUNTIME_EVIDENCE_ROOT,
  VISUAL_AUTHORITIES,
} from "../visual/index.mjs";
import { FINAL_GATES, renderStep } from "./checkpoints.mjs";

// Rendered only at bootstrap, when no visual contract is pinned yet, so the
// contract authored from it is always a new one: v2, never v1 history. The
// values come from the visual contract itself so the brief cannot drift from it.
const FIXED_TOLERANCE_RULE = `Author it at \`"version": ${HARDENED_VISUAL_VERSION}\` and never author a \`tolerance\` (\`VISUAL_TOLERANCE_FIXED\`): every row is compared at the engine's fixed \`${JSON.stringify(FIXED_VISUAL_TOLERANCE)}\`, not an agent-chosen value.`;

// I7: steps/06 and steps/07 span every slice, so COMPLETE closes the phase.
const SLICE_PHASE_STATUS_RULE =
  "This document spans every slice: each slice advances only once it holds no TODO placeholder, and Status `COMPLETE` is required when the last pending slice advances.";

export const stepTemplates = ({ designSource, figmaSources } = {}) => ({
  "steps/02-discover-legacy.md": renderStep({
    number: "02",
    name: "Discover legacy",
    purpose:
      "Inventory the complete observable legacy behavior and route flow without selecting a target implementation.",
    dependencies: "`steps/01-resolve.md`",
    requirements: [
      "Pages, routes, list/detail surfaces, transitions, back/close flows, redirects, permissions, actions, states, APIs, events, errors, and edge cases.",
      "Every behavior and route-flow has a stable ID and concrete evidence in `inventories/legacy.json`.",
      "Independent list and detail views are recorded as separate surfaces when the legacy flow exposes them independently.",
    ],
  }),
  "steps/02a-discovery-completeness.md": renderStep({
    number: "02a",
    name: "Discovery completeness",
    purpose:
      "Prove that every file the module owns, and every reference it makes, is accounted for -- not just the files the inventory happened to mention.",
    dependencies: "`steps/02-discover-legacy.md`, `inventories/legacy.json`",
    requirements: [
      "`moduleRoots` declares the roots that physically own the module; the census under them is authoritative and no import graph can shrink it.",
      "Every census file has exactly one row in `inventories/module-classification.json` with a closed-enum `disposition`, including files nothing imports.",
      "A production-reachable component, style, image, SVG, or other visual asset is BEHAVIOR_BACKED or approved for exclusion by an operator decision; agent-authored rationale alone never dismisses one.",
      "Every SUPPORTING file outside the roots records `requiredBy`, every unresolved first-party reference is resolved, and every blocking finding carries an EDGE_RESOLUTION decision.",
    ],
  }),
  "steps/03-assess-target.md": renderStep({
    number: "03",
    name: "Assess target",
    purpose:
      "Inspect the existing target independently and classify gaps without assuming that existing code is migrated.",
    dependencies: "`steps/02-discover-legacy.md`, `inventories/legacy.json`",
    requirements: [
      "Target state is ABSENT, PLACEHOLDER, PARTIAL, INCOMPATIBLE, or IMPLEMENTED_UNVERIFIED.",
      "Routes, list/detail surfaces, state ownership, permissions, integrations, UX states, tests, and target-native behavior are inventoried.",
      "Every visible control records the target design-system authority, expected component or pattern, actual source, and any approved exception.",
      // The only checkpoint that reaches the Figma MCP. Written into the
      // artifact itself, not just into SKILL.md, so the obligation is visible
      // to whoever opens the step -- and so it names this record's own links.
      ...(designSource === "figma-mcp"
        ? [
            `Read the \`figmaSources\` recorded in \`state.json\` (${(
              figmaSources ?? []
            )
              .map((source) => `\`${source.raw}\``)
              .join(
                ", ",
              )}) through the Figma MCP, and author \`${FIGMA_CONTEXT_FILE}\` as a JSON object with a non-empty \`frames\` array whose every entry names the \`fileKey\` it was read from. Figma is authoritative for visual/UX intent only; legacy stays authoritative for behavior.`,
            `Every frame records \`nodeId\` (a recorded link, or a concrete descendant of a recorded node link with \`ancestry\` \`{ sourceNodeId, path, metadata }\`: \`path\` from the source to the node and \`metadata\` the verbatim \`get_metadata\` output of the source node persisted as \`{ reference, hash }\`),\`name\`, \`type\`, \`viewport\`, \`states\`, \`extraction\` (\`retrievedAt\`, \`fidelity\` COMPLETE or DEGRADED with its \`limitations\`), and \`sources\`: the verbatim \`get_metadata\`, \`get_design_context\` (split over child nodes when too large), \`get_variable_defs\` and \`get_screenshot\` outputs persisted under \`inventories/figma/\`, each as \`{ reference, hash }\`. Never replace them with a summary.`,
          ]
        : []),
      // The other authority: captured from the running legacy app, never read
      // from legacy source, and pinned here for the migration's whole life.
      ...(designSource === "legacy-runtime"
        ? [
            `Capture every required legacy UI behavior state from the running legacy app and author \`${LEGACY_RUNTIME_CONTEXT_FILE}\` as a JSON object with a non-empty \`frames\` array. Each frame records \`id\` (\`<uiBehaviorId>::<state>\`), \`uiBehaviorId\`, \`state\`, \`states\`, \`viewport\`, \`url\`, \`rootLocator\`, this record's pinned \`legacyRevision\`, \`capture\` (\`role\` \`${LEGACY_AUTHORITY_ROLE}\`, \`mode\` \`element\`, \`deviceScaleFactor\` 1, \`compare\` {width, height}), \`extraction\` (\`retrievedAt\`, \`fidelity\` COMPLETE or DEGRADED with its \`limitations\`), and \`sources\`: the element screenshot, the \`${UI_PROOF_FORMAT}\` accessibility snapshot and the \`{viewport, values}\` measurements, persisted under \`${LEGACY_RUNTIME_EVIDENCE_ROOT}\` as \`{ reference, hash }\`. The legacy runtime is authoritative for visual appearance only; legacy code and UI structure are never an implementation authority.`,
          ]
        : []),
    ],
  }),
  "steps/04-build-baseline.md": renderStep({
    number: "04",
    name: "Build baseline",
    purpose:
      "Freeze the approved functional scope, navigation adaptations, design-system gaps, acceptance criteria, and exclusions.",
    dependencies: "`inventories/legacy.json`, `inventories/target.json`",
    requirements: [
      "Every legacy behavior maps to one row in `matrices/behavior-parity.json`.",
      "Every legacy route flow maps to one row in `matrices/route-adaptation.json`.",
      "Merging independent list and detail surfaces is a gap unless `REDESIGNED_APPROVED` includes approval and acceptance evidence.",
      "Ignoring an available target-required design-system component is a `DESIGN_SYSTEM_GAP` unless an exception is approved.",
      "Every required capability has one row in `matrices/capability-ownership.json` classified `TARGET_REUSE`, `SHARED_PREREQUISITE`, `FEATURE_LOCAL`, or `DO_NOT_MIGRATE`, from legacy evidence, target evidence, and architecture authorities.",
      "A capability is `SHARED_PREREQUISITE` only when at least two consumers other than this module are proven; its `targetOwner` is outside the migrating feature.",
      "A missing architecture authority is recorded in `authorityGaps`, never invented or cited as if present.",
      ...(designSource === "figma-mcp"
        ? [
            `Derive \`${VISUAL_ACCEPTANCE_FILE}\` from \`${FIGMA_CONTEXT_FILE}\`: one row per required UI behavior state, binding \`figmaNodeId\`, \`figmaState\`, the frame \`viewport\`, and expected visual facts (\`px\`, \`count\`, \`equals\`, \`present\`); the row is the only thing that binds a runtime state to Figma, and nothing is inferred from frame names or states. ${FIXED_TOLERANCE_RULE} A state with no row goes under \`unbacked\` with its reason, and stays blocked until an operator approves its VISUAL_UNBACKED candidate (\`record-decision.mjs <module> --pending\`, approved at a terminal) and the entry cites that \`decisionId\` and \`decisionDigest\`. A state with a row can never be unbacked.`,
          ]
        : []),
      ...(designSource === "legacy-runtime"
        ? [
            `Derive \`${VISUAL_ACCEPTANCE_FILE}\` from \`${LEGACY_RUNTIME_CONTEXT_FILE}\`: one row per required UI behavior state, binding \`legacyFrameId\` (the pinned frame's \`id\`), the frame \`viewport\`, and expected visual facts (\`px\`, \`count\`, \`equals\`, \`present\`) taken from that frame's pinned measurements; the row is the only thing that binds a runtime state to the legacy authority. ${FIXED_TOLERANCE_RULE} A state with no row goes under \`unbacked\` with its reason and an approved VISUAL_UNBACKED decision. A state with a row can never be unbacked.`,
          ]
        : []),
    ],
  }),
  "steps/05-plan.md": renderStep({
    number: "05",
    name: "Plan",
    purpose:
      "Divide the approved baseline into bounded, independently implementable and verifiable slices.",
    dependencies: "`steps/04-build-baseline.md` and every baseline matrix",
    requirements: [
      "Every non-terminal behavior, route, navigation, and design-system gap is assigned to exactly one slice.",
      "Each slice lists architecture authorities, target paths, acceptance scenarios, and dependencies in `slices/index.json`.",
      "Every `SHARED_PREREQUISITE` and `FEATURE_LOCAL` capability is assigned to exactly one slice's `capabilityIds`.",
      "A slice building a `SHARED_PREREQUISITE` is declared before, and listed in the `dependencies` of, every slice that follows it.",
      "Legacy visual structure and code are excluded as target implementation authorities.",
    ],
  }),
  "steps/06-implement-slices.md": renderStep({
    number: "06",
    name: "Implement slices",
    purpose:
      `Implement only one active slice per session and record its changed scope. ${SLICE_PHASE_STATUS_RULE}`,
    dependencies: "`steps/05-plan.md`, `slices/index.json`",
    requirements: [
      "The active `slices/<slice-id>.json` marks every assigned requirement implemented.",
      "Target-native behavior remains preserved.",
      "The target design system is reused where required, and route adaptations follow target routing conventions.",
    ],
  }),
  "steps/07-verify-slices.md": renderStep({
    number: "07",
    name: "Verify slices",
    purpose:
      `Verify one active slice against its behavior, route, navigation, design-system, and architecture requirements. ${SLICE_PHASE_STATUS_RULE}`,
    dependencies:
      "`steps/06-implement-slices.md`, active slice record, and changed target files",
    requirements: [
      "The active `evidence/<slice-id>/result.json` is PASS and covers every requirement assigned to the slice.",
      "Independent list/detail behavior or its approved redesign is exercised, including transition and return behavior.",
      "Design-system evidence proves use of the target-required source or an approved exception.",
    ],
  }),
  "steps/08-finalize.md": renderStep({
    number: "08",
    name: "Finalize",
    purpose:
      "Recheck full functional parity, provenance, all slices, and the seven mandatory gates.",
    dependencies:
      "All slice evidence, matrices, target authorities, and final repository checks",
    requirements: [
      "All in-scope behavior and route rows are verified and all target-native rows are preserved.",
      "Every design-system row is COMPLIANT or EXCEPTION_APPROVED.",
      "All seven rows in `gates.json` are PASS with concrete, fresh, bound evidence.",
      "Final report proves no legacy code, UI structure, design, or architecture was copied.",
    ],
  }),
});

export const initialJsonArtifacts = {
  "inventories/legacy.json": {
    version: 1,
    hasVisibleUi: false,
    uiBehaviors: [],
    behaviors: [],
    routeFlows: [],
    explicitNoRouteFlows: false,
  },
  [MODULE_CLASSIFICATION_FILE]: {
    version: 2,
    algorithmVersion: CENSUS_ALGORITHM_VERSION,
    moduleRoots: [],
    declaredEntryPoints: [],
    files: [],
    supporting: [],
    unresolvedReferences: [],
    findings: [],
  },
  "inventories/target.json": {
    version: 1,
    implementationState: "PLACEHOLDER",
    evidence: [],
    hasVisibleUi: false,
    navigationSurfaces: [],
    nativeBehaviors: [],
    uiComponents: [],
    uiMismatches: [],
  },
  "matrices/behavior-parity.json": { version: 1, rows: [] },
  "matrices/route-adaptation.json": { version: 1, rows: [] },
  "matrices/target-native.json": { version: 1, rows: [] },
  "matrices/design-system-usage.json": { version: 1, rows: [] },
  [CAPABILITY_OWNERSHIP_FILE]: {
    version: 1,
    architectureAuthorities: [],
    authorityGaps: [],
    rows: [],
  },
  "slices/index.json": { version: 1, slices: [] },
  "gates.json": {
    version: 1,
    gates: FINAL_GATES.map((gate) => ({
      gate,
      result: "PENDING",
      attempts: 0,
      evidence: [],
    })),
  },
};

export const createResolveStep = ({
  legacyRoot,
  targetRoot,
  legacyRevision,
  legacyModule,
  legacySources,
  targetAdoption,
  targetModule,
  ponytail,
  dataSourceMode,
  designSource,
  figmaSources,
  requirementsAuthority,
  brief,
}) => `# 01. Resolve

- Status: \`COMPLETE\`
- Contract version: \`${RESUMABLE_CONTRACT_VERSION}\`
- Format version: \`${MIGRATION_FORMAT_VERSION}\`
- Workflow version: \`${WORKFLOW_VERSION}\`
- Legacy module: \`${legacyModule}\`
- Legacy sources: \`${legacySources.join(", ")}\`
- Target module: \`${targetModule}\`
- Target adoption: \`${targetAdoption.mode}\`
- Legacy root: \`${legacyRoot}\`
- Target root: \`${targetRoot}\`
- Legacy revision: \`${legacyRevision.revision}\`
- Legacy revision scope: \`${legacyRevision.pathScoped ? "path-scoped" : "whole-repo-fallback"}\`
- OpenSpec source: \`${requirementsAuthority.source}\`
- OpenSpec digest: \`${requirementsAuthority.digest}\`
- OpenSpec requirements: \`${requirementsAuthority.requirementIds.join(", ")}\`
- OpenSpec scenarios: \`${requirementsAuthority.scenarioIds.join(", ")}\`
- Ponytail: ${ponytail ? `\`${ponytail}\`` : "`DISABLED`"}
- Data source mode: \`${dataSourceMode}\`
- Design source: \`${designSource ?? "target-system"}\`${
  VISUAL_AUTHORITIES[designSource]
    ? `\n- Visual authority: \`${VISUAL_AUTHORITIES[designSource].contextFile}\``
    : ""
}${
  designSource === "figma-mcp" && Array.isArray(figmaSources)
    ? `\n${figmaSources
        .map(
          (source) =>
            `- Figma source: \`${source.raw}\` (${source.kind} ${source.fileKey}${source.nodeId ? `#${source.nodeId}` : ""})`,
        )
        .join("\n")}`
    : ""
}
- Brief: ${brief ? `\`${brief}\`` : "`NOT_PROVIDED`"}

## Result

Mapping, repository roots, invocation options, and the immutable legacy revision
were resolved. The next session must execute only \`DISCOVER_LEGACY\`.
`;

export const LEGACY_REVISION_LINE = /^- Legacy revision: `[^`]+`$/m;

export const LEGACY_REVISION_SCOPE_LINE = /^- Legacy revision scope: `[^`]+`$/m;

/**
 * Whether a persisted record is the one this invocation resolved to. The record
 * key is `migrationId`, so the legacy module is only compared where it is still
 * the identity -- at format 15 the bare positional names the target and says
 * nothing about which sources converge on it.
 */
export const stateMappingMismatch = (state, resolved) =>
  state.targetModule !== resolved.target ||
  (usesMultiSource(state)
    ? state.migrationId !== resolved.canonical
    : state.legacyModule !== resolved.canonical);
