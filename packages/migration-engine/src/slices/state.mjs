import path from "node:path";
import { initialArtifacts, MIGRATION_STEPS } from "../formats/index.mjs";
import { readOptionalJson } from "../store/index.mjs";

// Fix E (candidate change; analysis/inventory.md Defect
// "reconcileSliceState/inspectSliceArtifacts... only wired up inside the
// one-time v4->v5 upgrade coordinator"): resume never revalidated that
// state.json's navigation fields (`currentStep`, `activeSlice`,
// `pendingSlices`) actually agree with what `slices/*.json` and
// `evidence/*/result.json` record. This runs the existing reconciliation
// logic in read-only/verify mode: if it would produce any repair, resume
// throws a named inconsistency instead of silently trusting state.json.
// Normal resume never auto-repairs; that stays a one-time upgrade-coordinator
// operation.
export const assertSliceStateConsistent = async (root, state) => {
  const { repairs } = await reconcileSliceState(root, state);
  if (repairs.length > 0) {
    throw new Error(
      `Migration state is inconsistent with slice/evidence artifacts and was not auto-repaired: ${repairs.join("; ")}. Investigate state.json and the slice/evidence records before continuing.`,
    );
  }
};

export const inspectSliceArtifacts = async (root) => {
  const index = await readOptionalJson(
    path.join(root, initialArtifacts.slices),
    "Slice index",
  );
  const slices = Array.isArray(index?.slices) ? index.slices : [];
  const plannedSlices = slices
    .map((slice) => slice?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  const implementedSlices = [];
  const verifiedSlices = [];

  for (const sliceId of plannedSlices) {
    const implementation = await readOptionalJson(
      path.join(root, `slices/${sliceId}.json`),
      `Slice ${sliceId}`,
    );
    const evidence = await readOptionalJson(
      path.join(root, `evidence/${sliceId}/result.json`),
      `Evidence for ${sliceId}`,
    );
    if (
      implementation?.id === sliceId &&
      implementation?.implementationStatus === "COMPLETE"
    ) {
      implementedSlices.push(sliceId);
      if (evidence?.sliceId === sliceId && evidence?.result === "PASS") {
        verifiedSlices.push(sliceId);
      }
    }
  }

  return {
    plannedSlices,
    implementedSlices,
    verifiedSlices,
  };
};

export const reconcileSliceState = async (root, state) => {
  const inspected = await inspectSliceArtifacts(root);
  const planReached =
    MIGRATION_STEPS.indexOf(state.currentStep) >=
      MIGRATION_STEPS.indexOf("IMPLEMENT_SLICES") ||
    state.currentStep === "COMPLETE" ||
    state.completedSteps.includes("PLAN");
  if (!planReached || inspected.plannedSlices.length === 0) {
    return {
      state,
      repairs: [],
      inspected,
    };
  }

  const verified = new Set(inspected.verifiedSlices);
  if (state.currentStep === "VERIFY_SLICES" && state.activeSlice) {
    verified.delete(state.activeSlice);
  }
  const implemented = new Set(inspected.implementedSlices);
  const pendingSlices = inspected.plannedSlices.filter(
    (sliceId) => !verified.has(sliceId),
  );
  const repairs = [];
  let currentStep = state.currentStep;
  let activeSlice = state.activeSlice;
  let status = state.status;

  if (pendingSlices.length > 0) {
    const activeIsPending =
      typeof activeSlice === "string" && pendingSlices.includes(activeSlice);
    const nextSlice = activeIsPending ? activeSlice : pendingSlices[0];
    const stateCanKeepActiveSlice =
      activeIsPending &&
      ["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep);
    if (!stateCanKeepActiveSlice) {
      activeSlice = nextSlice;
      currentStep = "IMPLEMENT_SLICES";
    } else if (currentStep === "VERIFY_SLICES" && !implemented.has(nextSlice)) {
      currentStep = "IMPLEMENT_SLICES";
    }
    if (status === "COMPLETE") status = "ACTIVE";
  } else if (["IMPLEMENT_SLICES", "VERIFY_SLICES"].includes(currentStep)) {
    currentStep = "FINALIZE";
    activeSlice = null;
  }

  const completedSlices = inspected.plannedSlices.filter((sliceId) =>
    verified.has(sliceId),
  );
  if (
    JSON.stringify(state.completedSlices) !== JSON.stringify(completedSlices)
  ) {
    repairs.push("reconciled completedSlices with PASS evidence");
  }
  if (JSON.stringify(state.pendingSlices) !== JSON.stringify(pendingSlices)) {
    repairs.push("reconciled pendingSlices with planned slice evidence");
  }
  if (state.currentStep !== currentStep) {
    repairs.push(`repaired currentStep ${state.currentStep} -> ${currentStep}`);
  }
  if (state.activeSlice !== activeSlice) {
    repairs.push(
      `repaired activeSlice ${state.activeSlice ?? "none"} -> ${activeSlice ?? "none"}`,
    );
  }
  if (state.status !== status) {
    repairs.push(`repaired status ${state.status} -> ${status}`);
  }

  const completedSteps = new Set(state.completedSteps);
  const pendingSteps = new Set(state.pendingSteps);
  if (pendingSlices.length > 0) {
    completedSteps.delete("IMPLEMENT_SLICES");
    completedSteps.delete("VERIFY_SLICES");
    completedSteps.delete("FINALIZE");
    pendingSteps.add("IMPLEMENT_SLICES");
    pendingSteps.add("VERIFY_SLICES");
    pendingSteps.add("FINALIZE");
  }

  return {
    state: {
      ...state,
      status,
      currentStep,
      activeSlice,
      completedSteps: MIGRATION_STEPS.filter((step) =>
        completedSteps.has(step),
      ),
      pendingSteps: MIGRATION_STEPS.filter((step) => pendingSteps.has(step)),
      completedSlices,
      pendingSlices,
    },
    repairs,
    inspected,
  };
};
