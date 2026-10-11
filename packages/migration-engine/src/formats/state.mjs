/** Formats: the module record's state shape and its persisted authority fields. */

import path from "node:path";

import {
  assertArray,
  assertBoolean,
  assertNonEmpty,
  assertPlainObject,
  assertSafeName,
  isContentIdentity,
} from "../shared/index.mjs";
import { DESIGN_SOURCES } from "./design-source.mjs";
import {
  MAX_SLICE_REWORKS,
  MULTI_SOURCE_FORMAT,
  recordCompatibilityBlocker,
  stepsFor,
  TARGET_BASELINE_FILE,
  usesDesignSource,
  usesMultiSource,
  WORKFLOW_VERSION,
} from "./module.mjs";
import { assertPonytailTarget } from "./record.mjs";
import { validateToolkitIdentity } from "./toolkit-identity.mjs";

const TARGET_ADOPTION_MODES = new Set(["GREENFIELD", "BROWNFIELD"]);

// Fix D (candidate change; analysis/inventory.md Defect "state.json's
// state-only contract is aspirational, not schema-enforced"): the exact set
// of top-level keys `references/migration-contract.md`'s "State-only
// contract" documents. `validateStateShape` rejects anything outside this
// set instead of only checking the shape of fields it recognizes.
const KNOWN_STATE_KEYS = new Set([
  "contractVersion",
  "formatVersion",
  "workflowVersion",
  "migrationId",
  "legacyModule",
  "targetModule",
  "registry",
  "legacyRevision",
  "requirementsAuthority",
  "brief",
  "ponytail",
  "dataSourceMode",
  "designSource",
  "figmaSources",
  "legacySources",
  "targetAdoption",
  // Format 16. Present only once a slice has actually been reworked, so a
  // record with zero reworks is byte-identical to a pre-16 one.
  "sliceReworks",
  // Present only on a pre-17 figma-mcp record that adopted the visual contract.
  "visualContractAdoption",
  "status",
  "currentStep",
  "activeSlice",
  "completedSteps",
  "pendingSteps",
  "completedSlices",
  "pendingSlices",
  "invalidatedArtifacts",
  "evidenceFreshness",
  "nextAction",
  "nextCommand",
  "artifacts",
  "artifactHashes",
  // Which built toolkit is permitted to mutate this record. Implementation
  // metadata, not a format capability: it is absent on every record created
  // before the standalone toolkit existed, and its presence changes no
  // lifecycle, decision, evidence or format meaning. Absent on an unstamped
  // record, so such a record stays byte-identical to what it always was.
  "toolkitIdentity",
  "revision",
  "createdAt",
  "updatedAt",
]);

export const requirementsSourceFor = (targetModule) => {
  const configured =
    process.env.MIGRATION_REQUIREMENTS_FILE ??
    "openspec/specs/{target}/spec.md";
  const source = configured
    .replaceAll("{target}", targetModule)
    .replaceAll("\\", "/");
  const normalized = path.posix.normalize(source);
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      "MIGRATION_REQUIREMENTS_FILE must be a target-project-relative path.",
    );
  }
  return normalized;
};

export const validateOpenSpecAuthorityShape = (authority, targetModule) => {
  assertPlainObject(authority, "requirementsAuthority");
  if (authority.kind !== "openspec") {
    throw new Error("requirementsAuthority.kind must be 'openspec'.");
  }
  const expectedSource = requirementsSourceFor(targetModule);
  if (authority.source !== expectedSource) {
    throw new Error(
      `requirementsAuthority.source must match the configured target-relative source '${expectedSource}'.`,
    );
  }
  if (!isContentIdentity(authority.digest)) {
    throw new Error(
      "requirementsAuthority.digest must be a SHA-256 content identity.",
    );
  }
  for (const [label, pattern] of [
    ["requirementIds", /^[A-Z][A-Z0-9]*-REQ-\d{3,}$/],
    ["scenarioIds", /^[A-Z][A-Z0-9]*-SCN-\d{3,}$/],
  ]) {
    const values = assertArray(
      authority[label],
      `requirementsAuthority.${label}`,
    );
    if (values.length === 0) {
      throw new Error(`requirementsAuthority.${label} cannot be empty.`);
    }
    if (
      values.some(
        (value) => typeof value !== "string" || !pattern.test(value),
      ) ||
      new Set(values).size !== values.length
    ) {
      throw new Error(
        `requirementsAuthority.${label} must contain unique stable IDs.`,
      );
    }
  }
  return authority;
};

const assertLegacyRevisionShape = (legacyRevision) => {
  assertPlainObject(legacyRevision, "legacyRevision");
  if (!/^[0-9a-f]{40}$/.test(legacyRevision.revision ?? "")) {
    throw new Error("legacyRevision.revision must be a full Git SHA-1.");
  }
  assertBoolean(legacyRevision.pathScoped, "legacyRevision.pathScoped");
  return legacyRevision;
};

/**
 * `targetAdoption` copies the `brief` precedent verbatim: the mode plus a
 * `{path, digest}` pair pointing at the artifact that holds the list, because
 * `state.json` is navigation and integrity fields only. A greenfield record
 * carries no baseline; a brownfield one must.
 */
const validateTargetAdoptionShape = (targetAdoption) => {
  assertPlainObject(targetAdoption, "targetAdoption");
  if (!TARGET_ADOPTION_MODES.has(targetAdoption.mode)) {
    throw new Error(
      `Migration state targetAdoption.mode must be ${[...TARGET_ADOPTION_MODES].join(" or ")}.`,
    );
  }
  if (targetAdoption.mode === "GREENFIELD") {
    if (targetAdoption.baseline !== null) {
      throw new Error(
        "Migration state targetAdoption.baseline must be null for a GREENFIELD target.",
      );
    }
    return targetAdoption;
  }
  const baseline = assertPlainObject(
    targetAdoption.baseline,
    "targetAdoption.baseline",
  );
  if (baseline.path !== TARGET_BASELINE_FILE) {
    throw new Error(
      `Migration state targetAdoption.baseline.path must be '${TARGET_BASELINE_FILE}'.`,
    );
  }
  if (!isContentIdentity(baseline.digest)) {
    throw new Error(
      "Migration state targetAdoption.baseline.digest must be a SHA-256 content identity.",
    );
  }
  return targetAdoption;
};

export const validateRecordStateShape = (state, moduleName, upgradeCommandFor) => {
  assertPlainObject(state, "Migration state");
  const incompatible = recordCompatibilityBlocker(
    state,
    moduleName ?? state.legacyModule ?? "this module",
    upgradeCommandFor,
  );
  if (incompatible) throw new Error(incompatible);
  // Fix D (candidate change): reject any top-level key outside the documented
  // state-only contract instead of only checking known fields' shapes.
  for (const key of Object.keys(state)) {
    if (!KNOWN_STATE_KEYS.has(key)) {
      throw new Error(
        `Migration state contains an unsupported top-level key '${key}'. state.json must contain only the documented navigation and integrity fields.`,
      );
    }
  }
  if (state.workflowVersion !== WORKFLOW_VERSION) {
    throw new Error(
      `Migration state workflowVersion must be ${WORKFLOW_VERSION}.`,
    );
  }
  assertSafeName(state.migrationId, "migration id");
  assertSafeName(state.legacyModule, "legacy module");
  assertSafeName(state.targetModule, "target module");
  if (
    state.registry !== undefined &&
    (typeof state.registry !== "string" ||
      !state.registry.trim() ||
      path.isAbsolute(state.registry) ||
      state.registry.includes("\\") ||
      state.registry.split(/[\\/]/).includes(".."))
  ) {
    throw new Error(
      "Migration state registry must be a target-relative, separator-independent path.",
    );
  }
  assertLegacyRevisionShape(state.legacyRevision);
  validateOpenSpecAuthorityShape(
    state.requirementsAuthority,
    state.targetModule,
  );
  if (!["standard", "mock"].includes(state.dataSourceMode)) {
    throw new Error("Migration state dataSourceMode must be standard or mock.");
  }
  // Format-gated: a pre-14 record carries no designSource and behaves as
  // target-system by omission. The value, when present, must be a known enum;
  // figmaSources is validated only where it is actually consumed -- a format-14
  // figma-mcp record. An older record that happens to carry the field is inert,
  // because every figma-mcp code path also gates on usesDesignSource(state).
  if (
    state.designSource !== undefined &&
    !DESIGN_SOURCES.includes(state.designSource)
  ) {
    throw new Error(
      `Migration state designSource must be ${DESIGN_SOURCES.join(" or ")}.`,
    );
  }
  if (usesDesignSource(state) && state.designSource === "figma-mcp") {
    const sources = assertArray(state.figmaSources, "figmaSources");
    if (sources.length === 0) {
      throw new Error(
        "Migration state figmaSources must not be empty for a figma-mcp design source.",
      );
    }
    for (const [index, source] of sources.entries()) {
      assertPlainObject(source, `figmaSources[${index}]`);
      assertNonEmpty(source.fileKey, `figmaSources[${index}].fileKey`);
      assertNonEmpty(source.kind, `figmaSources[${index}].kind`);
      assertNonEmpty(source.raw, `figmaSources[${index}].raw`);
      if (
        source.nodeId !== null &&
        (typeof source.nodeId !== "string" || source.nodeId.length === 0)
      ) {
        throw new Error(
          `figmaSources[${index}].nodeId must be a non-empty string or null.`,
        );
      }
    }
  }
  if (state.ponytail !== undefined && state.ponytail !== null) {
    assertPonytailTarget(state.ponytail);
  }
  // Present or absent, never partial: a half-written identity would be a
  // runtime that cannot be compared, which is the one thing this field exists
  // to make impossible.
  if (state.toolkitIdentity !== undefined) {
    validateToolkitIdentity(state.toolkitIdentity, "Migration state toolkitIdentity");
  }
  // Format 15: N sources converge on one target, so the target is the only
  // thing that stays singular and is therefore what the record directory, the
  // lock, the OpenSpec path, and `nextCommand` key on. Format <= 14 keeps the
  // old invariant verbatim.
  if (usesMultiSource(state)) {
    if (state.migrationId !== state.targetModule) {
      throw new Error(
        "Migration id must equal the target module at format 15 and above.",
      );
    }
    const sources = assertArray(state.legacySources, "legacySources");
    if (sources.length === 0) {
      throw new Error("Migration state legacySources must not be empty.");
    }
    sources.forEach((name, index) =>
      assertSafeName(name, `legacySources[${index}]`),
    );
    // Derived, never operator-controlled: two operators typing the same
    // sources in different orders must produce byte-identical state, because
    // state feeds the confirmation-ID snapshot.
    const canonicalOrder = [...new Set(sources)].sort();
    if (JSON.stringify(sources) !== JSON.stringify(canonicalOrder)) {
      throw new Error(
        `Migration state legacySources must be sorted and unique; expected ${JSON.stringify(canonicalOrder)}.`,
      );
    }
    // A shape-compatibility field only. Every format-15 rule reads
    // `legacySources`; `legacySources[0]` is alphabetically first and carries
    // no primacy, so anything treating it as "the" legacy module would migrate
    // whichever source happens to sort first.
    if (state.legacyModule !== sources[0]) {
      throw new Error(
        "Migration state legacyModule must equal legacySources[0] at format 15 and above.",
      );
    }
    validateTargetAdoptionShape(state.targetAdoption);
  } else {
    if (state.migrationId !== state.legacyModule) {
      throw new Error("Migration id must equal the canonical legacy module.");
    }
    for (const key of ["legacySources", "targetAdoption"]) {
      if (state[key] !== undefined) {
        throw new Error(
          `Migration state ${key} requires format ${MULTI_SOURCE_FORMAT}; this record is format ${state.formatVersion ?? 1}.`,
        );
      }
    }
  }
  // Contract 5 decisions 1.6 and 1.10: BLOCKED is preflight-only, and
  // registration is derived from the registry instead of cached in state.
  // (Both are also covered by the unsupported-top-level-key check above; the
  // explicit messages below are kept because they are more actionable.)
  if (Object.hasOwn(state, "blockers")) {
    throw new Error(
      "Contract 5 does not persist blockers. They are reported by the preflight.",
    );
  }
  if (Object.hasOwn(state, "mappingRegistered")) {
    throw new Error(
      "Contract 5 derives registration from the registry and does not persist mappingRegistered.",
    );
  }
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) {
    throw new Error(
      `Invalid migration status '${state.status}'. Contract 5 persists only ACTIVE or COMPLETE.`,
    );
  }
  // Version-scoped: a record born before format 10 has no
  // DISCOVERY_COMPLETENESS step and must never be held to one.
  const lifecycle = stepsFor(state);
  if (
    state.currentStep !== "COMPLETE" &&
    !lifecycle.includes(state.currentStep)
  ) {
    throw new Error(`Invalid current step '${state.currentStep}'.`);
  }
  if (state.brief !== undefined && state.brief !== null) {
    assertPlainObject(state.brief, "brief");
    assertNonEmpty(state.brief.path, "brief.path");
    if (!isContentIdentity(state.brief.digest)) {
      throw new Error(
        "Migration state brief.digest must be a SHA-256 content identity.",
      );
    }
  }
  assertArray(state.completedSteps, "completedSteps");
  // P1-1: completedSteps must be exactly the MIGRATION_STEPS prefix before
  // currentStep -- no gap, duplicate, or reordering -- checked from the state
  // shape alone, without needing history. IMPLEMENT_SLICES and VERIFY_SLICES
  // loop per slice and are recorded together only once every slice is
  // verified, so completedSteps legitimately lags one index behind
  // currentStep while VERIFY_SLICES is in progress.
  {
    const expectedPrefix = lifecycle.slice(0, state.completedSteps.length);
    if (
      JSON.stringify(state.completedSteps) !== JSON.stringify(expectedPrefix)
    ) {
      throw new Error(
        "Migration state completedSteps must be an in-order MIGRATION_STEPS prefix, with no gap, duplicate, or reordering.",
      );
    }
    const currentIndex =
      state.currentStep === "COMPLETE"
        ? lifecycle.length
        : lifecycle.indexOf(state.currentStep);
    const maxCompleted =
      currentIndex - (state.currentStep === "VERIFY_SLICES" ? 1 : 0);
    if (state.completedSteps.length !== maxCompleted) {
      throw new Error(
        `Migration state completedSteps (${state.completedSteps.length} step(s)) is inconsistent with currentStep '${state.currentStep}'; completedSteps must be exactly the MIGRATION_STEPS prefix before currentStep.`,
      );
    }
  }
  assertArray(state.pendingSteps, "pendingSteps");
  assertArray(state.completedSlices, "completedSlices");
  assertArray(state.pendingSlices, "pendingSlices");
  assertArray(state.invalidatedArtifacts, "invalidatedArtifacts");
  assertPlainObject(state.artifacts, "artifacts");
  assertPlainObject(state.artifacts.steps, "artifacts.steps");
  assertPlainObject(state.artifactHashes, "artifactHashes");
  if (state.sliceReworks !== undefined) {
    assertPlainObject(state.sliceReworks, "sliceReworks");
    for (const [sliceId, attempts] of Object.entries(state.sliceReworks)) {
      if (
        !Number.isInteger(attempts) ||
        attempts < 1 ||
        attempts > MAX_SLICE_REWORKS
      ) {
        throw new Error(
          `Migration sliceReworks['${sliceId}'] must be an integer between 1 and ${MAX_SLICE_REWORKS}; received ${JSON.stringify(attempts)}.`,
        );
      }
    }
  }
  if ((state.status === "COMPLETE") !== (state.currentStep === "COMPLETE")) {
    throw new Error(
      "Migration status and current step disagree on completion.",
    );
  }
  return state;
};
