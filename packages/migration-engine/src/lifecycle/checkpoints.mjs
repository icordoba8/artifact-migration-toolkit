/**
 * Lifecycle: the module checkpoint vocabulary -- final gates, parity and
 * disposition sets, step dependencies -- and the checkpoint readers
 * (`expectedNextCheckpoint`, `checkpointArtifacts`, `checkpointAction`,
 * `authoringRequest`). Moved verbatim from `resumable-migration.mjs` (Track A8).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { engineCommand } from "../engine-paths.mjs";
import {
  CAPABILITY_OWNERSHIP_FILE,
  MIGRATION_FORMAT_VERSION,
  MODULE_CLASSIFICATION_FILE,
  recordCompatibilityBlocker,
  RESUMABLE_CONTRACT_VERSION,
  stepsFor,
  validateRecordStateShape,
} from "../formats/index.mjs";
import { fileExists } from "../store/index.mjs";

export const upgradeCommandFor = (moduleName) =>
  engineCommand("upgrades/upgrade-migration.mjs", moduleName);

// Formats classifies and validates; the one rendered command in its refusal
// is bound here (baseline §4.1), so the bytes are unchanged.
export const compatibilityBlocker = (state, moduleName) =>
  recordCompatibilityBlocker(state, moduleName, upgradeCommandFor);

export const validateStateShape = (state, moduleName) =>
  validateRecordStateShape(state, moduleName, upgradeCommandFor);

export const FINAL_GATES = [
  "ARCHITECTURE_PLAN_GATE",
  "TARGETED_VERIFY",
  "FUNCTIONAL_PARITY_GATE",
  "SIMPLIFY_ONCE",
  "ARCHITECTURE_IMPLEMENTATION_GATE",
  "PRECOMMIT_GATE",
  "FINAL_VERIFY",
];

export const TERMINAL_PARITY = new Set([
  "VERIFIED",
  "REDESIGNED_VERIFIED",
  "EXCLUDED_APPROVED",
  "DEAD_CONFIRMED",
  // Format 15: proven by a pre-existing target implementation plus a bound,
  // scenario-covering test run (`validateAdoptedRow`). Never authorable without
  // that evidence, which is what separates it from the unearned `VERIFIED` the
  // closed enum below now refuses.
  "ADOPTED_VERIFIED",
]);

/**
 * `verificationStatus` was never enum-checked: any string outside
 * `TERMINAL_PARITY` read as "not terminal" and any string inside it read as
 * proven. `PENDING` is the one documented non-terminal value
 * (`references/migration-contract.md`), so the vocabulary is closed to it plus
 * the terminal set.
 */
export const PARITY_STATUSES = new Set(["PENDING", ...TERMINAL_PARITY]);

/**
 * The two statuses only a verified slice can produce. Authoring one before any
 * slice has been verified is "the code already exists" accepted as parity --
 * the row silently leaves planning, implementation, verification, and FINALIZE
 * in a single edit. `ADOPTED_VERIFIED` is the sanctioned way to say that, and
 * it costs real evidence.
 */
export const SLICE_EARNED_PARITY = new Set(["VERIFIED", "REDESIGNED_VERIFIED"]);

export const BEHAVIOR_DISPOSITIONS = {
  ABSENT: "IMPLEMENT",
  PLACEHOLDER: "UPDATE",
  PARTIAL: "UPDATE",
  INCOMPATIBLE: "REDESIGN_IN_TARGET",
  // One vocabulary at both altitudes: this key used to be
  // `MATCHED_UNVERIFIED`, which meant a row could not carry the `TARGET_STATES`
  // value describing exactly the same judgement. No alias: the old key appears
  // in zero persisted artifacts, so an alias would guard a case that cannot
  // exist.
  IMPLEMENTED_UNVERIFIED: "NO_CHANGE_REQUIRED",
};

/**
 * Capability ownership: the same strict classification-to-disposition mapping
 * `BEHAVIOR_DISPOSITIONS` uses, so a row cannot claim one judgement and record
 * the action of another.
 */
export const CAPABILITY_DISPOSITIONS = {
  TARGET_REUSE: "REUSE_EXISTING",
  SHARED_PREREQUISITE: "CREATE_SHARED",
  FEATURE_LOCAL: "CREATE_FEATURE_LOCAL",
  DO_NOT_MIGRATE: "NONE",
};

/** The minimum number of *other* consumers that proves a capability is shared. */
export const SHARED_CONSUMER_THRESHOLD = 2;

export const ADOPTION_ROOT = "visual-contract-adoption";

export const STEP_DEPENDENCIES = {
  RESOLVE: ["steps/01-resolve.md"],
  DISCOVER_LEGACY: ["steps/02-discover-legacy.md", "inventories/legacy.json"],
  DISCOVERY_COMPLETENESS: [
    "steps/02a-discovery-completeness.md",
    MODULE_CLASSIFICATION_FILE,
    "inventories/legacy.json",
  ],
  ASSESS_TARGET: ["steps/03-assess-target.md", "inventories/target.json"],
  BUILD_BASELINE: [
    "steps/04-build-baseline.md",
    "matrices/behavior-parity.json",
    "matrices/route-adaptation.json",
    "matrices/target-native.json",
    "matrices/design-system-usage.json",
    CAPABILITY_OWNERSHIP_FILE,
  ],
  PLAN: ["steps/05-plan.md", "slices/index.json"],
  IMPLEMENT_SLICES: ["steps/06-implement-slices.md"],
  VERIFY_SLICES: ["steps/07-verify-slices.md"],
  FINALIZE: ["steps/08-finalize.md", "gates.json"],
};

// A `<module>.md` sibling is a retired contract-2/3 checklist. Contract 2 and 3
// are unsupported: refuse to bootstrap over one and leave the file untouched.
export const legacyChecklistBlocker = async (targetRoot, moduleName) =>
  (await fileExists(
    path.join(
      targetRoot,
      ".agents/knowledge/migrations/modules",
      `${moduleName}.md`,
    ),
  ))
    ? `Unsupported legacy migration workflow: '.agents/knowledge/migrations/modules/${moduleName}.md' is a retired contract-2 or contract-3 checklist. Those workflows are never parsed, converted, moved, or deleted. The file was left untouched and no migration was bootstrapped over it.`
    : null;

export const activeArtifact = (state) =>
  state.currentStep === "COMPLETE"
    ? null
    : state.currentStep === "IMPLEMENT_SLICES" && state.activeSlice
      ? `slices/${state.activeSlice}.json`
      : state.currentStep === "VERIFY_SLICES" && state.activeSlice
        ? `evidence/${state.activeSlice}/result.json`
        : state.artifacts.steps[state.currentStep];

export const expectedNextCheckpoint = (state) => {
  if (state.currentStep === "COMPLETE") return "COMPLETE";
  if (state.currentStep === "IMPLEMENT_SLICES") return "VERIFY_SLICES";
  if (state.currentStep === "VERIFY_SLICES") {
    return state.pendingSlices.some((sliceId) => sliceId !== state.activeSlice)
      ? "IMPLEMENT_SLICES"
      : "FINALIZE";
  }
  if (state.currentStep === "FINALIZE") return "COMPLETE";
  const steps = stepsFor(state);
  const index = steps.indexOf(state.currentStep);
  return steps[index + 1] ?? "COMPLETE";
};

export const checkpointArtifacts = (state) => {
  if (state.currentStep === "COMPLETE") {
    return [
      "state.json",
      "steps/08-finalize.md",
      "gates.json",
      "matrices/*.json",
    ];
  }
  if (state.currentStep === "IMPLEMENT_SLICES" && state.activeSlice) {
    return [
      "steps/06-implement-slices.md",
      "steps/05-plan.md",
      "slices/index.json",
      `slices/${state.activeSlice}.json`,
      "assigned target files",
    ];
  }
  if (state.currentStep === "VERIFY_SLICES" && state.activeSlice) {
    return [
      "steps/07-verify-slices.md",
      `slices/${state.activeSlice}.json`,
      `evidence/${state.activeSlice}/result.json`,
      "changed target files and focused tests",
    ];
  }
  return [...(STEP_DEPENDENCIES[state.currentStep] ?? [])];
};

export const checkpointAction = (state) => {
  if (state.currentStep === "COMPLETE") {
    return "Revalidate the completed migration";
  }
  if (state.currentStep === "IMPLEMENT_SLICES" && state.activeSlice) {
    return `Implement slice ${state.activeSlice}`;
  }
  if (state.currentStep === "VERIFY_SLICES" && state.activeSlice) {
    return `Verify slice ${state.activeSlice}`;
  }
  if (state.currentStep === "FINALIZE") {
    return "Finalize the migration and run the seven gates";
  }
  if (state.currentStep === "DISCOVERY_COMPLETENESS") {
    return "Classify every file in the module census";
  }
  return `Execute checkpoint ${state.currentStep}`;
};

/**
 * What the agent is being asked to author at this checkpoint, as a value
 * (`02` D2-6). Composed on read from the navigation readers above and never
 * persisted, so it carries no format of its own and cannot drift from state.
 *
 * `lifecycle` comes from `stepsFor`, so a record born before format 10 is
 * described with its own eight-checkpoint lifecycle rather than the nine this
 * build ships. `state.nextAction` keeps its field and its prose; it is one
 * rendering of this request, no longer the only expression of it.
 */
export const authoringRequest = (state) => ({
  step: state.currentStep,
  slice: state.activeSlice ?? null,
  artifacts: checkpointArtifacts(state),
  primaryArtifact: activeArtifact(state),
  dependencies: [...(STEP_DEPENDENCIES[state.currentStep] ?? [])],
  summary: checkpointAction(state),
  expectedNextCheckpoint: expectedNextCheckpoint(state),
  schemaRef: `references/migration-contract.md#${state.currentStep}`,
  lifecycle: [...stepsFor(state)],
});

export const confirmationIdFor = (snapshot) =>
  createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex")
    .slice(0, 16);

export const resumeGuidance = (state) => {
  const activeSlice =
    ["IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE", "COMPLETE"].includes(
      state.currentStep,
    ) && state.activeSlice;
  return {
    resumed: state.status === "ACTIVE",
    resumeMode: activeSlice ? "ACTIVE_SLICE" : "CHECKPOINT",
    resumeReason: activeSlice
      ? `Continue the persisted ${state.currentStep} slice '${activeSlice}'. A session or model interruption does not require --refresh.`
      : `Continue the persisted ${state.currentStep} checkpoint. A session or model interruption does not require --refresh.`,
  };
};

export const renderStep = ({
  number,
  name,
  purpose,
  dependencies,
  requirements,
  status = "PENDING",
}) => `# ${number}. ${name}

- Status: \`${status}\`
- Contract version: \`${RESUMABLE_CONTRACT_VERSION}\`
- Format version: \`${MIGRATION_FORMAT_VERSION}\`
- Purpose: ${purpose}
- Dependencies: ${dependencies}

## Required evidence

${requirements.map((requirement) => `- [TODO] ${requirement}`).join("\n")}

## Decisions

- [TODO] Record decisions that affect scope, behavior, routes, architecture, or verification.

## Result

- [TODO] Summarize the validated result of this checkpoint.
`;
