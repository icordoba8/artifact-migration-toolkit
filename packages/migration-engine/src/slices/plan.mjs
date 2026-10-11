import path from "node:path";
import {
  initialArtifacts,
  usesCapabilityOwnership,
  usesUiVerification,
} from "../formats/index.mjs";
import {
  assertArray,
  assertPlainObject,
  assertSafeName,
  assertUniqueIds,
} from "../shared/index.mjs";
import { assertEvidenceResolves, readJson } from "../store/index.mjs";

/** Whether any slice has been verified yet, so a row could have earned it. */
export const anySliceVerified = (state) =>
  (state?.completedSlices?.length ?? 0) > 0 ||
  ["VERIFY_SLICES", "FINALIZE", "COMPLETE"].includes(state?.currentStep);

export const TERMINAL_DESIGN_SYSTEM = new Set(["COMPLIANT", "EXCEPTION_APPROVED"]);

/** Rows a slice must own at PLAN. The other two classifications are terminal. */
export const NON_TERMINAL_CAPABILITIES = new Set([
  "SHARED_PREREQUISITE",
  "FEATURE_LOCAL",
]);

// Contract 5 decision 1.2: requirementIds, scenarioIds, and traceIds are
// disjoint and separately owned. acceptanceScenarios stays authored prose.
// Format 11 adds capabilityIds as a fourth separately-owned list; a pre-11
// record has no capability matrix, so the list is absent rather than empty.
export const traceLists = (record, label, state) => ({
  requirementIds: assertArray(record.requirementIds, `${label}.requirementIds`),
  scenarioIds: assertArray(record.scenarioIds, `${label}.scenarioIds`),
  traceIds: assertArray(record.traceIds, `${label}.traceIds`),
  ...(usesCapabilityOwnership(state)
    ? {
        capabilityIds: assertArray(
          record.capabilityIds,
          `${label}.capabilityIds`,
        ),
      }
    : {}),
});

export const assertCoversPlanned = (planned, actual, label, verb) => {
  for (const field of Object.keys(planned)) {
    const covered = new Set(actual[field]);
    for (const id of planned[field]) {
      if (!covered.has(id)) {
        throw new Error(`${label} did not ${verb} '${id}' from ${field}.`);
      }
    }
  }
};

// Track A4: the plan rules, over the BUILD_BASELINE matrices the lifecycle
// already validated. The `validatePlan` seam reads that baseline first, exactly
// where the rules used to, and supplies the two facts slices/ does not own: the
// terminal parity statuses (lifecycle) and the UI-requirement predicate (visual).
export const validateSlicePlan = async (
  root,
  state,
  roots,
  baseline,
  { terminalParity, uiBehaviorIsRequired },
) => {
  const index = assertPlainObject(
    await readJson(path.join(root, initialArtifacts.slices), "Slice index"),
    "Slice index",
  );
  const slices = assertArray(index.slices, "Slices");
  if (slices.length === 0) throw new Error("Plan requires at least one slice.");
  const sliceIds = assertUniqueIds(slices, "Slices");
  const authority = state?.requirementsAuthority;
  for (const slice of slices) {
    assertSafeName(slice.id.toLowerCase(), "slice id");
    const lists = traceLists(slice, slice.id, state);
    if (lists.traceIds.length === 0) {
      throw new Error(
        `${slice.id} must own at least one baseline row in traceIds.`,
      );
    }
    if (
      assertArray(slice.acceptanceScenarios, `${slice.id}.acceptanceScenarios`)
        .length === 0
    ) {
      throw new Error(`${slice.id} requires acceptance scenarios.`);
    }
    if (authority) {
      for (const [field, allowed] of [
        ["requirementIds", authority.requirementIds],
        ["scenarioIds", authority.scenarioIds],
      ]) {
        for (const id of lists[field]) {
          if (!allowed.includes(id)) {
            throw new Error(
              `${slice.id}.${field} references '${id}', which the OpenSpec authority does not define.`,
            );
          }
        }
      }
    }
  }
  const required = [
    ...baseline.behaviorRows
      .filter((row) => !terminalParity.has(row.verificationStatus))
      .map((row) => row.id),
    ...baseline.routeRows
      .filter((row) => row.verificationStatus !== "VERIFIED")
      .map((row) => row.id),
    // A target-native row that is not yet PRESERVED still needs implementation
    // or verification, so it belongs to exactly one slice like any other row.
    ...baseline.nativeRows
      .filter((row) => row.verificationStatus !== "PRESERVED")
      .map((row) => row.id),
    ...baseline.designRows
      .filter(
        (row) =>
          !TERMINAL_DESIGN_SYSTEM.has(row.status) ||
          row.verificationStatus !== "VERIFIED",
      )
      .map((row) => row.id),
  ];
  const ownership = new Map();
  for (const slice of slices) {
    for (const traceId of slice.traceIds) {
      if (ownership.has(traceId)) {
        throw new Error(
          `Baseline row '${traceId}' is assigned to multiple slices.`,
        );
      }
      ownership.set(traceId, slice.id);
    }
  }
  for (const traceId of required) {
    if (!ownership.has(traceId)) {
      throw new Error(
        `Plan does not assign baseline row '${traceId}' to a slice.`,
      );
    }
  }
  if (usesUiVerification(state)) {
    const mismatchByBehavior = new Map(
      baseline.target.uiMismatches.map((row) => [row.uiBehaviorId, row]),
    );
    for (const uiBehavior of baseline.legacy.uiBehaviors) {
      if (
        !uiBehaviorIsRequired(uiBehavior, mismatchByBehavior.get(uiBehavior.id))
      ) {
        continue;
      }
      const parityRow = baseline.behaviorRows.find(
        (row) => row.behaviorId === uiBehavior.behaviorId,
      );
      const ownerId = parityRow && ownership.get(parityRow.id);
      const owner = slices.find((slice) => slice.id === ownerId);
      if (!owner) {
        throw new Error(
          `Required UI behavior '${uiBehavior.id}' does not trace through a behavior-parity row to a slice.`,
        );
      }
      for (const [field, ids] of [
        ["requirementIds", uiBehavior.requirementIds],
        ["scenarioIds", uiBehavior.scenarioIds],
      ]) {
        for (const id of ids) {
          if (!owner[field].includes(id)) {
            throw new Error(
              `Required UI behavior '${uiBehavior.id}' traces to ${owner.id}, but ${owner.id}.${field} omits '${id}'.`,
            );
          }
        }
      }
    }
  }
  await assertCapabilityPlan(slices, baseline.capabilityRows, state, roots);
  return {
    index,
    slices,
    sliceIds,
    capabilityRows: baseline.capabilityRows,
  };
};

/**
 * Format 11. PLAN is where a proven shared prerequisite stops being an
 * observation and becomes a scheduled slice. A SHARED_PREREQUISITE does not
 * have to be *implemented* before PLAN closes -- it has to be deterministically
 * ordered ahead of the feature work that depends on it.
 *
 * Ordering rides on declaration order rather than a new scheduler:
 * `pendingSlices` is derived from `index.slices` order, so requiring every
 * dependency to be declared earlier makes declaration order a valid topological
 * order and makes cycles structurally impossible.
 */
export const assertCapabilityPlan = async (slices, capabilityRows, state, roots) => {
  if (!usesCapabilityOwnership(state)) return;
  const declaredAt = new Map(slices.map((slice, index) => [slice.id, index]));
  for (const slice of slices) {
    await assertEvidenceResolves(
      assertArray(
        slice.architectureAuthorities,
        `${slice.id}.architectureAuthorities`,
      ),
      `${slice.id}.architectureAuthorities`,
      roots,
    );
    assertArray(slice.targetPaths, `${slice.id}.targetPaths`);
    for (const dependency of assertArray(
      slice.dependencies,
      `${slice.id}.dependencies`,
    )) {
      if (dependency === slice.id) {
        throw new Error(`${slice.id}.dependencies references itself.`);
      }
      if (!declaredAt.has(dependency)) {
        throw new Error(
          `${slice.id}.dependencies references unknown slice '${dependency}'.`,
        );
      }
      if (declaredAt.get(dependency) > declaredAt.get(slice.id)) {
        throw new Error(
          `${slice.id} depends on '${dependency}', which is declared after it. Slices execute in declaration order, so a dependency must be declared first.`,
        );
      }
    }
  }

  const rowsById = new Map(capabilityRows.map((row) => [row.id, row]));
  const owner = new Map();
  for (const slice of slices) {
    for (const capabilityId of slice.capabilityIds) {
      if (!rowsById.has(capabilityId)) {
        throw new Error(
          `${slice.id}.capabilityIds references '${capabilityId}', which the capability ownership matrix does not define.`,
        );
      }
      if (owner.has(capabilityId)) {
        throw new Error(
          `Capability '${capabilityId}' is assigned to multiple slices.`,
        );
      }
      owner.set(capabilityId, slice.id);
    }
  }
  for (const row of capabilityRows) {
    if (!NON_TERMINAL_CAPABILITIES.has(row.classification)) continue;
    if (!owner.has(row.id)) {
      throw new Error(
        `Plan does not assign capability '${row.id}' (${row.classification}) to a slice. A shared prerequisite must be planned before the feature slices that depend on it.`,
      );
    }
  }

  // Any slice building a proven shared capability is a prerequisite for the
  // rest of the plan. Blunt on purpose: the capability was discovered as a
  // dependency of the module being migrated, so the feature work needs it.
  const prerequisites = slices.filter((slice) =>
    slice.capabilityIds.some(
      (id) => rowsById.get(id)?.classification === "SHARED_PREREQUISITE",
    ),
  );
  for (const slice of slices) {
    if (prerequisites.includes(slice)) continue;
    for (const prerequisite of prerequisites) {
      if (!slice.dependencies.includes(prerequisite.id)) {
        throw new Error(
          `${slice.id} must declare '${prerequisite.id}' in dependencies: it builds a SHARED_PREREQUISITE capability this slice relies on.`,
        );
      }
    }
  }
};
