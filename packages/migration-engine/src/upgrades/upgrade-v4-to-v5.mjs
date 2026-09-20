// Pure contract-4 to contract-5 transformation.
//
// This module never touches the filesystem and never runs a command. It takes
// the complete migration tree as in-memory UTF-8 text, returns either blockers
// or a fully validated target tree, and leaves every authored byte it does not
// own exactly as it found it.
//
// The authority for every rule here is references/v5-contract.md, except
// where the candidate rebuild's fixes (Fix A and Fix B; see
// analysis/inventory.md and analysis/interface-changes.md) changed the v5
// target shape itself -- those spots are called out below.

import { createHash } from "node:crypto";

import {
  contentIdentityMatches,
  isContentIdentity,
} from "../migration-utils.mjs";

export const V5_CONTRACT_VERSION = 5;
export const V5_FORMAT_VERSION = 4;
export const V5_WORKFLOW_VERSION = "5.0";

export const SOURCE_CONTRACT_VERSION = 4;
export const SOURCE_FORMAT_VERSION = 3;

// Frozen by references/v5-contract.md section 1.1 as the identity mapping.
// v5-upgrade.test.mjs asserts this still equals the engine's step list.
export const V5_STEPS = [
  "RESOLVE",
  "DISCOVER_LEGACY",
  "ASSESS_TARGET",
  "BUILD_BASELINE",
  "PLAN",
  "IMPLEMENT_SLICES",
  "VERIFY_SLICES",
  "FINALIZE",
];

const STEP_FILES = {
  RESOLVE: "steps/01-resolve.md",
  DISCOVER_LEGACY: "steps/02-discover-legacy.md",
  ASSESS_TARGET: "steps/03-assess-target.md",
  BUILD_BASELINE: "steps/04-build-baseline.md",
  PLAN: "steps/05-plan.md",
  IMPLEMENT_SLICES: "steps/06-implement-slices.md",
  VERIFY_SLICES: "steps/07-verify-slices.md",
  FINALIZE: "steps/08-finalize.md",
};

// Section 1.7. matrices/*.json are deliberately absent: mutable progress.
const IMMUTABLE_STEP_ARTIFACTS = {
  RESOLVE: ["steps/01-resolve.md"],
  DISCOVER_LEGACY: ["steps/02-discover-legacy.md", "inventories/legacy.json"],
  ASSESS_TARGET: ["steps/03-assess-target.md", "inventories/target.json"],
  BUILD_BASELINE: ["steps/04-build-baseline.md"],
  PLAN: ["steps/05-plan.md", "slices/index.json"],
  IMPLEMENT_SLICES: [],
  VERIFY_SLICES: [],
  FINALIZE: ["steps/08-finalize.md", "gates.json"],
};

// Section 1.2. All four baseline matrices own trace identifiers.
const TRACE_MATRICES = [
  "matrices/behavior-parity.json",
  "matrices/route-adaptation.json",
  "matrices/target-native.json",
  "matrices/design-system-usage.json",
];

const STATE_FILE = "state.json";
const GATES_FILE = "gates.json";
const HISTORY_FILE = "history/history.ndjson";
const SLICE_INDEX_FILE = "slices/index.json";
const BRIEF_FILE = "brief.md";
// P1-1: the artifactHashes integrity anchor resumable-migration.mjs verifies
// on every read, kept in step here too so an upgraded tree is never missing
// or holding a stale one copied through unexamined from the source tree.
const INTEGRITY_FILE = "integrity.json";

const sha256 = (text) =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const renderJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const digestArtifactHashes = (artifactHashes) =>
  sha256(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(artifactHashes).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    ),
  );

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

class Blocked extends Error {}

const block = (message) => {
  throw new Blocked(message);
};

const parseJson = (files, relativePath) => {
  if (!Object.hasOwn(files, relativePath)) {
    block(`Migration artifact is missing: ${relativePath}`);
  }
  try {
    return JSON.parse(files[relativePath]);
  } catch (error) {
    block(`Migration artifact is invalid JSON: ${relativePath} (${error.message})`);
  }
};

/** Rewrites only whole `- Label: \`value\`` metadata lines. Section 4. */
const setMetadataLine = (content, label, value) => {
  const pattern = new RegExp(`^- ${label}: \`[^\`]*\`$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, `- ${label}: \`${value}\``)
    : content;
};

const validateSource = (files) => {
  const state = parseJson(files, STATE_FILE);
  if (!isPlainObject(state)) block("Migration state must be an object.");

  const formatVersion = state.formatVersion ?? 1;
  if (
    state.contractVersion !== SOURCE_CONTRACT_VERSION ||
    formatVersion !== SOURCE_FORMAT_VERSION
  ) {
    block(
      `Unsupported source version: contract ${state.contractVersion}, format ${formatVersion}. Only contract ${SOURCE_CONTRACT_VERSION} with format ${SOURCE_FORMAT_VERSION} can be upgraded to contract ${V5_CONTRACT_VERSION}.`,
    );
  }
  if (state.status === "BLOCKED") {
    block(
      "The persisted migration is BLOCKED. Contract 5 does not persist BLOCKED. Resolve the blocker under contract 4 before upgrading.",
    );
  }
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) {
    block(`Unsupported persisted status '${state.status}'.`);
  }
  if (Array.isArray(state.blockers) && state.blockers.length > 0) {
    block(
      `The persisted migration records ${state.blockers.length} blocker(s). Contract 5 does not persist blockers. Resolve them under contract 4 before upgrading: ${state.blockers.join("; ")}`,
    );
  }
  if (!isPlainObject(state.requirementsAuthority)) {
    block("Migration state is missing its OpenSpec requirements authority.");
  }
  if (
    !Array.isArray(state.requirementsAuthority.requirementIds) ||
    !Array.isArray(state.requirementsAuthority.scenarioIds)
  ) {
    block("requirementsAuthority must list requirementIds and scenarioIds.");
  }
  if (typeof state.legacyCommit !== "string" || state.legacyCommit.length === 0) {
    block("Migration state is missing its legacy commit.");
  }
  if (!isPlainObject(state.artifactHashes)) {
    block("Migration state is missing artifactHashes.");
  }
  for (const [relativePath, expected] of Object.entries(state.artifactHashes)) {
    if (!Object.hasOwn(files, relativePath)) {
      block(`Recorded artifact is missing from the migration tree: ${relativePath}`);
    }
    // A file-pin consumer, so it reads through the shared identity policy: a
    // v4 pin taken on a checkout whose line endings were spelled the other way
    // is not a corrupted pin. The frozen snapshot itself is untouched, and the
    // pins this upgrade writes below still use the v4 raw-hash spelling, which
    // the v5 engine accepts as legacy -- so the upgrade's confirmation preimage
    // does not move.
    if (
      !contentIdentityMatches(
        expected,
        relativePath,
        Buffer.from(files[relativePath], "utf8"),
      )
    ) {
      block(
        `Recorded artifact hash does not match its bytes: ${relativePath}. Reopen the responsible checkpoint under contract 4 before upgrading.`,
      );
    }
  }
  const briefPath = state.artifacts?.brief;
  if (briefPath !== undefined && !Object.hasOwn(files, briefPath)) {
    block(`Migration state records a brief that is missing: ${briefPath}`);
  }
  return state;
};

const traceOwners = (state, files) => {
  const requirements = new Set(state.requirementsAuthority.requirementIds);
  const scenarios = new Set(state.requirementsAuthority.scenarioIds);
  const traces = new Set();
  for (const relativePath of TRACE_MATRICES) {
    const matrix = parseJson(files, relativePath);
    if (!Array.isArray(matrix?.rows)) {
      block(`Baseline matrix has no rows array: ${relativePath}`);
    }
    for (const row of matrix.rows) {
      if (typeof row?.id === "string" && row.id.length > 0) traces.add(row.id);
    }
  }
  return { requirements, scenarios, traces };
};

/**
 * Splits one v4 identifier list into the three v5 fields by exact membership.
 * Section 1.2: no shape heuristics, no prefix guessing.
 */
const splitTraceIds = (record, owners, label) => {
  const source = [
    ...(record.requirementIds ?? []),
    ...(record.scenarioIds ?? []),
    ...(record.traceIds ?? []),
  ];
  const split = { requirementIds: [], scenarioIds: [], traceIds: [] };
  const seen = new Set();
  for (const id of source) {
    if (typeof id !== "string" || id.length === 0) {
      block(`${label} contains a non-string identifier.`);
    }
    if (seen.has(id)) {
      block(
        `${label} repeats identifier '${id}'. Contract 5 requires disjoint identifier lists.`,
      );
    }
    seen.add(id);
    const claims = [
      owners.requirements.has(id) && "requirementIds",
      owners.scenarios.has(id) && "scenarioIds",
      owners.traces.has(id) && "traceIds",
    ].filter(Boolean);
    if (claims.length === 0) {
      block(
        `${label} references '${id}', which is not an OpenSpec requirement, an OpenSpec scenario, or a baseline matrix row. Contract 5 cannot assign it an owner.`,
      );
    }
    if (claims.length > 1) {
      block(
        `${label} references '${id}', which is claimed by ${claims.join(" and ")}. Contract 5 requires exactly one owner.`,
      );
    }
    split[claims[0]].push(id);
  }
  return split;
};

/** Rebuilds a record with the three ID fields grouped where requirementIds was. */
const withTraceFields = (record, split) => {
  const rebuilt = {};
  let placed = false;
  for (const [key, value] of Object.entries(record)) {
    if (key === "requirementIds") {
      rebuilt.requirementIds = split.requirementIds;
      rebuilt.scenarioIds = split.scenarioIds;
      rebuilt.traceIds = split.traceIds;
      placed = true;
      continue;
    }
    if (key === "scenarioIds" || key === "traceIds") continue;
    rebuilt[key] = value;
  }
  if (!placed) {
    rebuilt.requirementIds = split.requirementIds;
    rebuilt.scenarioIds = split.scenarioIds;
    rebuilt.traceIds = split.traceIds;
  }
  return rebuilt;
};

const ponytailGapFor = (state, files) => {
  if (!state.ponytail) return null;
  const document = parseJson(files, GATES_FILE);
  const rows = Array.isArray(document?.gates) ? document.gates : [];
  const required = [
    ["SIMPLIFY_ONCE", "review"],
    ...(state.ponytail === "full-audit"
      ? [["PRECOMMIT_GATE", "audit"]]
      : []),
  ];
  const missing = required.filter(([gate, kind]) => {
    const row = rows.find((candidate) => candidate?.gate === gate);
    const evidence = row?.ponytailEvidence;
    return (
      !isPlainObject(evidence) ||
      evidence.kind !== kind ||
      typeof evidence.reference !== "string" ||
      evidence.reference.trim().length === 0
    );
  });
  return missing.length === 0
    ? null
    : missing.map(
        ([gate, kind]) =>
          `${GATES_FILE}: gate ${gate} needs typed Ponytail evidence of kind '${kind}' for Ponytail target '${state.ponytail}'.`,
      );
};

const nextActionFor = (navigation) =>
  navigation.currentStep === "COMPLETE"
    ? "Migration is ready for commit."
    : navigation.currentStep === "IMPLEMENT_SLICES"
      ? `Implement slice ${navigation.activeSlice}.`
      : navigation.currentStep === "VERIFY_SLICES"
        ? `Verify slice ${navigation.activeSlice}.`
        : `Complete ${STEP_FILES[navigation.currentStep]}.`;

export const validateV5State = (state) => {
  if (!isPlainObject(state)) block("Target state must be an object.");
  if (state.contractVersion !== V5_CONTRACT_VERSION) {
    block(`Target contractVersion must be ${V5_CONTRACT_VERSION}.`);
  }
  if (state.formatVersion !== V5_FORMAT_VERSION) {
    block(`Target formatVersion must be ${V5_FORMAT_VERSION}.`);
  }
  if (state.workflowVersion !== V5_WORKFLOW_VERSION) {
    block(`Target workflowVersion must be ${V5_WORKFLOW_VERSION}.`);
  }
  if (Object.hasOwn(state, "mappingRegistered")) {
    block("Contract 5 derives registration from the registry.");
  }
  if (Object.hasOwn(state, "blockers")) {
    block("Contract 5 does not persist blockers.");
  }
  // Candidate Fix A (analysis/inventory.md Defect #1): v5 pins a path-scoped
  // legacy revision object, not the bare whole-repo-HEAD string v4 used.
  if (Object.hasOwn(state, "legacyCommit")) {
    block("Contract 5 persists legacyRevision, not the v4 legacyCommit field.");
  }
  if (
    !isPlainObject(state.legacyRevision) ||
    typeof state.legacyRevision.revision !== "string" ||
    !/^[0-9a-f]{40}$/.test(state.legacyRevision.revision) ||
    typeof state.legacyRevision.pathScoped !== "boolean"
  ) {
    block("Target legacyRevision must be { revision, pathScoped }.");
  }
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) {
    block(`Contract 5 persists only ACTIVE or COMPLETE; found '${state.status}'.`);
  }
  if (
    state.currentStep !== "COMPLETE" &&
    !V5_STEPS.includes(state.currentStep)
  ) {
    block(`Invalid target currentStep '${state.currentStep}'.`);
  }
  if ((state.status === "COMPLETE") !== (state.currentStep === "COMPLETE")) {
    block("Target status and currentStep disagree on completion.");
  }
  if (state.brief !== null) {
    if (
      !isPlainObject(state.brief) ||
      typeof state.brief.path !== "string" ||
      !isContentIdentity(state.brief.digest)
    ) {
      block("Target brief must be null or { path, digest }.");
    }
  }
  for (const key of [
    "completedSteps",
    "pendingSteps",
    "completedSlices",
    "pendingSlices",
    "invalidatedArtifacts",
  ]) {
    if (!Array.isArray(state[key])) block(`Target ${key} must be an array.`);
  }
  if (
    ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(state.currentStep) &&
    typeof state.activeSlice !== "string"
  ) {
    block(`${state.currentStep} requires an active slice.`);
  }
  return state;
};

/**
 * @param {{
 *   files: Record<string, string>,
 *   navigation?: { status: string, currentStep: string, activeSlice: string|null,
 *     completedSteps: string[], pendingSteps: string[],
 *     completedSlices: string[], pendingSlices: string[], repairs?: string[] },
 *   now: string,
 *   contractDigest: string,
 * }} input
 */
export const upgradeV4ToV5 = ({ files, navigation, now, contractDigest }) => {
  try {
    if (!isPlainObject(files)) block("Migration tree must be an object.");
    if (typeof now !== "string" || now.length === 0) {
      block("An upgrade timestamp is required.");
    }
    const state = validateSource(files);
    const owners = traceOwners(state, files);
    const target = { ...files };
    const changedFiles = [];

    const write = (relativePath, content) => {
      if (target[relativePath] === content) return;
      target[relativePath] = content;
      changedFiles.push(relativePath);
    };

    // 1. Step-document metadata. Section 4.
    for (const [step, relativePath] of Object.entries(STEP_FILES)) {
      if (!Object.hasOwn(files, relativePath)) {
        block(`Migration artifact is missing: ${relativePath}`);
      }
      let content = setMetadataLine(
        files[relativePath],
        "Contract version",
        V5_CONTRACT_VERSION,
      );
      content = setMetadataLine(content, "Format version", V5_FORMAT_VERSION);
      if (step === "RESOLVE") {
        content = setMetadataLine(
          content,
          "Workflow version",
          V5_WORKFLOW_VERSION,
        );
      }
      write(relativePath, content);
    }

    // 2. Trace schema. Section 1.2.
    const index = parseJson(files, SLICE_INDEX_FILE);
    if (!Array.isArray(index?.slices)) {
      block(`${SLICE_INDEX_FILE} has no slices array.`);
    }
    write(
      SLICE_INDEX_FILE,
      renderJson({
        ...index,
        slices: index.slices.map((slice) =>
          withTraceFields(
            slice,
            splitTraceIds(slice, owners, `${SLICE_INDEX_FILE} slice '${slice?.id}'`),
          ),
        ),
      }),
    );
    for (const slice of index.slices) {
      const sliceId = slice?.id;
      if (typeof sliceId !== "string" || sliceId.length === 0) {
        block(`${SLICE_INDEX_FILE} contains a slice without an id.`);
      }
      for (const relativePath of [
        `slices/${sliceId}.json`,
        `evidence/${sliceId}/result.json`,
      ]) {
        if (!Object.hasOwn(files, relativePath)) continue;
        const record = parseJson(files, relativePath);
        write(
          relativePath,
          renderJson(
            withTraceFields(
              record,
              splitTraceIds(record, owners, relativePath),
            ),
          ),
        );
      }
    }

    // 3. Reopening. Section 6.
    const missingV5Content = ponytailGapFor(state, files) ?? [];
    const reopenedStep = missingV5Content.length > 0 ? "FINALIZE" : null;

    const source = navigation ?? state;
    let currentStep = source.currentStep;
    let status = source.status;
    let activeSlice = source.activeSlice ?? null;
    let completedSteps = [...source.completedSteps];
    let pendingSteps = [...source.pendingSteps];
    const invalidatedArtifacts = [];
    if (reopenedStep) {
      const reopenIndex = V5_STEPS.indexOf(reopenedStep);
      const reopened = V5_STEPS.slice(reopenIndex);
      completedSteps = completedSteps.filter((step) => !reopened.includes(step));
      pendingSteps = V5_STEPS.filter(
        (step) => reopened.includes(step) || pendingSteps.includes(step),
      );
      invalidatedArtifacts.push(...IMMUTABLE_STEP_ARTIFACTS[reopenedStep]);
      currentStep = reopenedStep;
      status = "ACTIVE";
      activeSlice = null;
    }
    const nextNavigation = {
      status,
      currentStep,
      activeSlice,
      completedSteps: V5_STEPS.filter((step) => completedSteps.includes(step)),
      pendingSteps: V5_STEPS.filter((step) => pendingSteps.includes(step)),
      completedSlices: [...source.completedSlices],
      pendingSlices: [...source.pendingSlices],
    };

    // 4. Artifact hashes. Recomputed for rewritten bytes, dropped when reopened.
    const artifactHashes = {};
    for (const step of nextNavigation.completedSteps) {
      for (const relativePath of IMMUTABLE_STEP_ARTIFACTS[step]) {
        if (Object.hasOwn(target, relativePath)) {
          artifactHashes[relativePath] = sha256(target[relativePath]);
        }
      }
    }
    for (const sliceId of nextNavigation.completedSlices) {
      for (const relativePath of [
        `slices/${sliceId}.json`,
        `evidence/${sliceId}/result.json`,
      ]) {
        if (Object.hasOwn(target, relativePath)) {
          artifactHashes[relativePath] = sha256(target[relativePath]);
        }
      }
    }
    const briefPath = state.artifacts?.brief;
    const brief = briefPath
      ? { path: briefPath, digest: `sha256:${sha256(files[briefPath])}` }
      : null;
    if (brief) artifactHashes[briefPath] = sha256(files[briefPath]);

    // 5. Target state. Section 2. Candidate Fix A: the v4 `legacyCommit`
    // string (always a whole-repo HEAD -- that is exactly what the original,
    // unfixed `gitRevision` computed) is wrapped into the v5 `legacyRevision`
    // shape with `pathScoped: false`, since that historical reading was never
    // path-scoped.
    const nextState = { ...state };
    delete nextState.mappingRegistered;
    delete nextState.blockers;
    delete nextState.legacyCommit;
    const targetState = validateV5State({
      ...nextState,
      contractVersion: V5_CONTRACT_VERSION,
      formatVersion: V5_FORMAT_VERSION,
      workflowVersion: V5_WORKFLOW_VERSION,
      legacyRevision: { revision: state.legacyCommit, pathScoped: false },
      brief,
      ...nextNavigation,
      invalidatedArtifacts,
      nextAction: nextActionFor(nextNavigation),
      nextCommand:
        nextNavigation.currentStep === "COMPLETE"
          ? null
          : `/start-migration ${state.legacyModule}`,
      artifactHashes,
      revision: state.revision + 1,
      updatedAt: now,
    });
    write(STATE_FILE, renderJson(targetState));
    write(
      INTEGRITY_FILE,
      renderJson({
        revision: targetState.revision,
        artifactHashesSha256: digestArtifactHashes(artifactHashes),
      }),
    );

    // 6. Exactly one upgrade event. Section 8.2 of the plan.
    write(
      HISTORY_FILE,
      `${files[HISTORY_FILE] ?? ""}${JSON.stringify({
        at: now,
        event: "UPGRADED_V4_TO_V5",
        fromContractVersion: SOURCE_CONTRACT_VERSION,
        fromFormatVersion: SOURCE_FORMAT_VERSION,
        fromWorkflowVersion: state.workflowVersion ?? null,
        toContractVersion: V5_CONTRACT_VERSION,
        toFormatVersion: V5_FORMAT_VERSION,
        toWorkflowVersion: V5_WORKFLOW_VERSION,
        contractDigest: contractDigest ?? null,
        reopenedStep,
        missingV5Content,
        supersededFiles: [],
        navigationRepairs: navigation?.repairs ?? [],
        changedFiles: [...changedFiles, STATE_FILE].sort(),
        revision: targetState.revision,
      })}\n`,
    );

    return {
      blockers: [],
      target,
      report: {
        sourceContractVersion: SOURCE_CONTRACT_VERSION,
        sourceFormatVersion: SOURCE_FORMAT_VERSION,
        sourceWorkflowVersion: state.workflowVersion ?? null,
        targetContractVersion: V5_CONTRACT_VERSION,
        targetFormatVersion: V5_FORMAT_VERSION,
        targetWorkflowVersion: V5_WORKFLOW_VERSION,
        changedFiles: changedFiles.slice().sort(),
        stepChanges: [],
        reopenedStep,
        preservedCompletedSteps: nextNavigation.completedSteps,
        invalidatedArtifacts,
        supersededFiles: [],
        missingV5Content,
        navigationRepairs: navigation?.repairs ?? [],
      },
    };
  } catch (error) {
    if (error instanceof Blocked) {
      return { blockers: [error.message], target: null, report: null };
    }
    throw error;
  }
};
