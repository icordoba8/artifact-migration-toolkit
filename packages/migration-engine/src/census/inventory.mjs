import path from "node:path";
import {
  initialArtifacts,
  UI_REMEDIATION_FILE,
  usesRequiredObservations,
  usesUiVerification,
} from "../formats/index.mjs";
import {
  assertArray,
  assertBoolean,
  assertNonEmpty,
  assertPlainObject,
  assertUniqueIds,
  isResolvedWithin as isWithin,
} from "../shared/index.mjs";
import {
  assertEvidenceResolves,
  evidencePathClaim,
  readJson,
  readOptionalJson,
  resolveEvidencePath,
} from "../store/index.mjs";
import { isBrownfield, targetFeatureDirectory } from "./sources.mjs";

export const TARGET_STATES = new Set([
  "ABSENT",
  "PLACEHOLDER",
  "PARTIAL",
  "INCOMPATIBLE",
  "IMPLEMENTED_UNVERIFIED",
]);

export const UI_KINDS = new Set([
  "INFORMATION_HIERARCHY",
  "TABLE_LIST",
  "SEARCH",
  "PAGINATION",
  "CONDITIONAL_CONTROL",
  "PERMISSION_VISIBILITY",
  "ROW_ACTION",
  "CREATE_EDIT_ACTION",
  "LOADING",
  "EMPTY",
  "ERROR",
  "RESPONSIVE",
  "PRESENTATION",
]);

export const UI_MISMATCH_DISPOSITIONS = new Set([
  "REQUIRED_BEHAVIOR",
  "LEGACY_DEFECT",
  "INTENTIONAL_FIX",
  "INTENTIONAL_DESIGN_ADAPTATION",
  "NOT_APPLICABLE",
]);

/**
 * Kinds whose whole point is an interaction. A row of one of these kinds has to
 * name the interactions Playwright must exercise; a passive kind (a hierarchy,
 * a loading state) legitimately has none.
 */
export const UI_INTERACTIVE_KINDS = new Set([
  "SEARCH",
  "PAGINATION",
  "ROW_ACTION",
  "CREATE_EDIT_ACTION",
  "CONDITIONAL_CONTROL",
]);

/** Kinds that are conditional by definition, so `conditional` is not optional. */
export const UI_CONDITIONAL_KINDS = new Set([
  "CONDITIONAL_CONTROL",
  "PERMISSION_VISIBILITY",
]);

export const UI_RUNTIME_STATES = new Set([
  "DEFAULT",
  "POPULATED",
  "SEARCH",
  "PAGINATION",
  "EMPTY",
  "ERROR",
  "DESKTOP",
  "MOBILE",
  "MENU",
  "DIALOG",
  "ACTION",
]);

// P1-7 machine-readable evidence checklist. `assertEvidenceResolves` (store/)
// only closes "the path must exist"; `DISCOVERY-TARGET-UNDERVALIDATION` also
// exploited the absence of fixed categories, an evidence kind, and OpenSpec
// requirement/scenario lineage -- arbitrary prose with no structure reached
// BUILD_BASELINE. This is applied only at the DISCOVER_LEGACY/ASSESS_TARGET
// checkpoint gate itself (see `validateStep`), never inside
// `validateLegacyInventory`/`validateTargetInventory`, which stay exactly as
// lenient as before: those are reused every time a later step (BUILD_BASELINE,
// PLAN, FINALIZE) re-reads an already-closed, hash-pinned inventory, and a
// closed checkpoint's conclusions are tamper-checked, not re-litigated under a
// rule that postdates it (same philosophy as the P1-1 `artifactHashes`
// anchor). This keeps the real, already-completed `auth` migration's
// flat-string evidence fully valid forever, while any inventory not yet
// completed must use the checklist from here on.
export const EVIDENCE_CATEGORIES = [
  "SOURCE",
  "RUNTIME_OBSERVATION",
  "REQUIREMENT_TRACE",
];

export const EVIDENCE_KINDS = ["CODE", "CONFIG", "TEST", "DOCS", "OBSERVATION"];

export const EVIDENCE_STATUSES = ["PRESENT", "NOT_APPLICABLE", "BLOCKED"];

export const assertOpenSpecIds = (ids, allowed, label) => {
  for (const id of assertArray(ids ?? [], label)) {
    if (allowed && !allowed.includes(id)) {
      throw new Error(
        `${label} references '${id}', which the OpenSpec authority does not define.`,
      );
    }
  }
};

export const assertEvidenceChecklist = async (items, label, roots, authority) => {
  const list = assertArray(items, label);
  const seenCategories = new Set();
  for (const [index, item] of list.entries()) {
    const at = `${label}[${index}]`;
    assertPlainObject(item, at);
    if (!EVIDENCE_CATEGORIES.includes(item.category)) {
      throw new Error(
        `${at}.category must be one of ${EVIDENCE_CATEGORIES.join(", ")}.`,
      );
    }
    if (!EVIDENCE_KINDS.includes(item.kind)) {
      throw new Error(
        `${at}.kind must be one of ${EVIDENCE_KINDS.join(", ")}.`,
      );
    }
    if (!EVIDENCE_STATUSES.includes(item.status)) {
      throw new Error(
        `${at}.status must be one of ${EVIDENCE_STATUSES.join(", ")}.`,
      );
    }
    if (item.status === "PRESENT") {
      const claim = evidencePathClaim(item.location);
      if (!claim || !(await resolveEvidencePath(claim, roots))) {
        throw new Error(
          `${at}.location '${item.location}' does not exist under the legacy or target repository.`,
        );
      }
    } else {
      assertNonEmpty(item.reason, `${at}.reason`);
    }
    assertOpenSpecIds(
      item.requirementIds,
      authority?.requirementIds,
      `${at}.requirementIds`,
    );
    assertOpenSpecIds(
      item.scenarioIds,
      authority?.scenarioIds,
      `${at}.scenarioIds`,
    );
    seenCategories.add(item.category);
  }
  const missing = EVIDENCE_CATEGORIES.filter(
    (category) => !seenCategories.has(category),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing required checklist categor${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}. Record an item (PRESENT, or NOT_APPLICABLE/BLOCKED with a reason) for each.`,
    );
  }
};

export const assertLegacyDiscoveryChecklist = async (root, roots, authority) => {
  const inventory = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.legacyInventory),
      "Legacy inventory",
    ),
    "Legacy inventory",
  );
  for (const behavior of assertArray(inventory.behaviors, "Legacy behaviors")) {
    await assertEvidenceChecklist(
      behavior.evidence,
      `${behavior.id}.evidence`,
      roots,
      authority,
    );
  }
  for (const flow of assertArray(inventory.routeFlows, "Legacy route flows")) {
    await assertEvidenceChecklist(
      flow.evidence,
      `${flow.id}.evidence`,
      roots,
      authority,
    );
  }
  const remediation = await readOptionalJson(
    path.join(root, UI_REMEDIATION_FILE),
    "UI remediation",
  );
  for (const item of inventory.uiBehaviors ?? remediation?.uiBehaviors ?? []) {
    await assertEvidenceChecklist(
      item.evidence,
      `${item.id}.evidence`,
      roots,
      authority,
    );
  }
};

export const assertTargetAssessmentChecklist = async (root, roots, authority) => {
  const inventory = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.targetInventory),
      "Target inventory",
    ),
    "Target inventory",
  );
  await assertEvidenceChecklist(
    inventory.evidence,
    "Target evidence",
    roots,
    authority,
  );
};

/**
 * Track A5 seam: the format-18 observation rule is visual's. It arrives as a
 * pure validator, called at the same point of the same loop as before.
 */
export const validateLegacyInventory = async (
  root,
  roots,
  state,
  { assertRequiredObservations },
) => {
  const persisted = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.legacyInventory),
      "Legacy inventory",
    ),
    "Legacy inventory",
  );
  const remediation = usesUiVerification(state)
    ? await readOptionalJson(
        path.join(root, UI_REMEDIATION_FILE),
        "UI remediation",
      )
    : null;
  const inventory = remediation
    ? {
        ...persisted,
        hasVisibleUi: remediation.hasVisibleUi,
        uiBehaviors: remediation.uiBehaviors,
      }
    : persisted;
  const behaviors = assertArray(inventory.behaviors, "Legacy behaviors");
  if (behaviors.length === 0) {
    throw new Error("Legacy inventory must contain at least one behavior.");
  }
  assertUniqueIds(behaviors, "Legacy behaviors");
  for (const behavior of behaviors) {
    assertNonEmpty(behavior.description, `${behavior.id}.description`);
    if (
      assertArray(behavior.evidence, `${behavior.id}.evidence`).length === 0
    ) {
      throw new Error(`${behavior.id} requires concrete legacy evidence.`);
    }
    await assertEvidenceResolves(
      behavior.evidence,
      `${behavior.id}.evidence`,
      roots,
    );
  }
  const routeFlows = assertArray(inventory.routeFlows, "Legacy route flows");
  assertUniqueIds(routeFlows, "Legacy route flows");
  if (routeFlows.length === 0 && inventory.explicitNoRouteFlows !== true) {
    throw new Error(
      "Legacy route flows are empty without explicitNoRouteFlows=true.",
    );
  }
  for (const flow of routeFlows) {
    assertNonEmpty(flow.description, `${flow.id}.description`);
    assertArray(flow.evidence, `${flow.id}.evidence`);
    await assertEvidenceResolves(flow.evidence, `${flow.id}.evidence`, roots);
    if (flow.independentListAndDetail === true) {
      assertNonEmpty(flow.listSurface, `${flow.id}.listSurface`);
      assertNonEmpty(flow.detailSurface, `${flow.id}.detailSurface`);
      assertNonEmpty(flow.openTransition, `${flow.id}.openTransition`);
      assertNonEmpty(flow.returnTransition, `${flow.id}.returnTransition`);
    }
  }
  if (usesUiVerification(state)) {
    assertBoolean(inventory.hasVisibleUi, "Legacy hasVisibleUi");
    const uiBehaviors = assertArray(
      inventory.uiBehaviors,
      "Legacy UI behaviors",
    );
    assertUniqueIds(uiBehaviors, "Legacy UI behaviors");
    if (inventory.hasVisibleUi !== uiBehaviors.length > 0) {
      throw new Error(
        "Legacy hasVisibleUi must equal whether discovery contains UI behaviors.",
      );
    }
    const behaviorIds = new Set(behaviors.map((behavior) => behavior.id));
    const observationIds = new Set();
    for (const item of uiBehaviors) {
      if (!behaviorIds.has(item.behaviorId)) {
        throw new Error(
          `${item.id}.behaviorId '${item.behaviorId}' is not a discovered legacy behavior.`,
        );
      }
      if (!UI_KINDS.has(item.kind)) {
        throw new Error(`${item.id}.kind '${item.kind}' is not supported.`);
      }
      assertNonEmpty(item.description, `${item.id}.description`);
      // "table exists" is not an inventory. Meaningful configuration
      // (showToolbar: false, compactMode: true, ...) is the part a target
      // implementation can silently drop, so it may not be empty.
      if (
        Object.keys(
          assertPlainObject(item.configuration, `${item.id}.configuration`),
        ).length === 0
      ) {
        throw new Error(
          `${item.id}.configuration must record the observable configuration, not an empty object.`,
        );
      }
      assertBoolean(item.conditional ?? false, `${item.id}.conditional`);
      if (UI_CONDITIONAL_KINDS.has(item.kind) && item.conditional !== true) {
        throw new Error(
          `${item.id}.kind '${item.kind}' is conditional by definition and requires conditional: true.`,
        );
      }
      if (item.conditional === true) {
        assertNonEmpty(item.precondition, `${item.id}.precondition`);
      }
      const interactions = assertArray(
        item.interactions ?? [],
        `${item.id}.interactions`,
      );
      assertUniqueIds(interactions, `${item.id}.interactions`);
      if (interactions.length === 0 && UI_INTERACTIVE_KINDS.has(item.kind)) {
        throw new Error(
          `${item.id}.kind '${item.kind}' requires at least one named interaction to exercise.`,
        );
      }
      for (const interaction of interactions) {
        assertNonEmpty(
          interaction.action,
          `${item.id}.${interaction.id}.action`,
        );
        assertNonEmpty(
          interaction.expected,
          `${item.id}.${interaction.id}.expected`,
        );
      }
      const runtimeStates = assertArray(
        item.runtimeStates,
        `${item.id}.runtimeStates`,
      );
      if (new Set(runtimeStates).size !== runtimeStates.length) {
        throw new Error(
          `${item.id}.runtimeStates must not contain duplicates.`,
        );
      }
      for (const runtimeState of runtimeStates) {
        if (!UI_RUNTIME_STATES.has(runtimeState)) {
          throw new Error(
            `${item.id}.runtimeStates contains unsupported state '${runtimeState}'.`,
          );
        }
      }
      await assertEvidenceResolves(item.evidence, `${item.id}.evidence`, roots);
      assertOpenSpecIds(
        item.requirementIds,
        state.requirementsAuthority.requirementIds,
        `${item.id}.requirementIds`,
      );
      assertOpenSpecIds(
        item.scenarioIds,
        state.requirementsAuthority.scenarioIds,
        `${item.id}.scenarioIds`,
      );
      if (item.requirementIds.length === 0 || item.scenarioIds.length === 0) {
        throw new Error(
          `${item.id} requires OpenSpec requirement and scenario traceability.`,
        );
      }
      if (usesRequiredObservations(state)) {
        assertRequiredObservations(item, observationIds);
      }
    }
  }
  return inventory;
};

/**
 * A brownfield inventory has to have actually looked at the feature. One
 * PRESENT `SOURCE` item under `src/features/<target>/` is the minimum: an
 * inventory of a substantially implemented feature cannot legitimately cite
 * nothing inside it.
 */
export const assertAdoptedTargetEvidence = async (evidence, roots, state) => {
  const featureDirectory = targetFeatureDirectory(
    roots.targetRoot,
    state.targetModule,
  );
  for (const item of evidence) {
    const isSource =
      typeof item === "string" ? true : item?.category === "SOURCE";
    if (!isSource) continue;
    const claim = evidencePathClaim(
      typeof item === "string" ? item : item?.location,
    );
    if (!claim) continue;
    const absolute = await resolveEvidencePath(claim, roots);
    if (absolute && isWithin(featureDirectory, absolute)) return evidence;
  }
  throw new Error(
    `Target inventory cites no SOURCE evidence under 'src/features/${state.targetModule}/'. An adopted target must be inventoried from the implementation it claims to adopt.`,
  );
};

export const validateTargetInventory = async (root, roots, legacy, state) => {
  const persisted = assertPlainObject(
    await readJson(
      path.join(root, initialArtifacts.targetInventory),
      "Target inventory",
    ),
    "Target inventory",
  );
  const remediation = usesUiVerification(state)
    ? await readOptionalJson(
        path.join(root, UI_REMEDIATION_FILE),
        "UI remediation",
      )
    : null;
  const inventory = remediation
    ? {
        ...persisted,
        hasVisibleUi: remediation.hasVisibleUi,
        uiMismatches: remediation.uiMismatches,
      }
    : persisted;
  if (!TARGET_STATES.has(inventory.implementationState)) {
    throw new Error(
      `Invalid target implementation state '${inventory.implementationState}'.`,
    );
  }
  if (assertArray(inventory.evidence, "Target evidence").length === 0) {
    throw new Error("Target inventory requires concrete evidence.");
  }
  await assertEvidenceResolves(inventory.evidence, "Target evidence", roots);
  // The five implementation states were validated and then discarded -- no
  // branch read them, so `IMPLEMENTED_UNVERIFIED` had no effect and a false
  // `ABSENT` cost nothing. Under `--adopt-target` they become load-bearing:
  // the record was created *because* the target exists, so an inventory of it
  // may not come back empty or absent.
  if (isBrownfield(state)) {
    if (inventory.implementationState === "ABSENT") {
      throw new Error(
        `Target inventory records ABSENT, but this migration adopted an existing '${state.targetModule}' implementation. Reassess the target, or start a greenfield migration.`,
      );
    }
    await assertAdoptedTargetEvidence(inventory.evidence, roots, state);
  }
  assertBoolean(inventory.hasVisibleUi, "Target hasVisibleUi");
  if (
    usesUiVerification(state) &&
    inventory.hasVisibleUi !== legacy.hasVisibleUi
  ) {
    throw new Error(
      `Target hasVisibleUi must describe the migration delivery (${legacy.hasVisibleUi}), not whether UI existed before implementation.`,
    );
  }
  assertUniqueIds(
    assertArray(inventory.navigationSurfaces, "Target navigation surfaces"),
    "Target navigation surfaces",
  );
  assertUniqueIds(
    assertArray(inventory.nativeBehaviors, "Target-native behaviors"),
    "Target-native behaviors",
  );
  const components = assertArray(
    inventory.uiComponents,
    "Target UI components",
  );
  assertUniqueIds(components, "Target UI components");
  if (inventory.hasVisibleUi && components.length === 0) {
    throw new Error(
      "Visible target UI requires a component and design-system inventory.",
    );
  }
  if (
    usesUiVerification(state) &&
    !inventory.hasVisibleUi &&
    components.length > 0
  ) {
    throw new Error(
      "A non-UI migration cannot inventory user-visible target components.",
    );
  }
  for (const component of components) {
    assertNonEmpty(component.requirement, `${component.id}.requirement`);
    assertNonEmpty(component.actualSource, `${component.id}.actualSource`);
    assertBoolean(
      component.equivalentAvailable,
      `${component.id}.equivalentAvailable`,
    );
    if (component.equivalentAvailable) {
      assertNonEmpty(
        component.expectedComponent,
        `${component.id}.expectedComponent`,
      );
    }
    await assertEvidenceResolves(
      [component.evidence],
      `${component.id}.evidence`,
      roots,
    );
  }
  if (usesUiVerification(state)) {
    const mismatches = assertArray(
      inventory.uiMismatches,
      "Target UI mismatch dispositions",
    );
    assertUniqueIds(mismatches, "Target UI mismatch dispositions");
    const uiBehaviorIds = new Set(legacy.uiBehaviors.map((item) => item.id));
    const mapped = new Set();
    for (const mismatch of mismatches) {
      if (!uiBehaviorIds.has(mismatch.uiBehaviorId)) {
        throw new Error(
          `${mismatch.id}.uiBehaviorId '${mismatch.uiBehaviorId}' is not a discovered UI behavior.`,
        );
      }
      if (mapped.has(mismatch.uiBehaviorId)) {
        throw new Error(
          `UI behavior '${mismatch.uiBehaviorId}' has more than one mismatch disposition.`,
        );
      }
      mapped.add(mismatch.uiBehaviorId);
      if (!UI_MISMATCH_DISPOSITIONS.has(mismatch.disposition)) {
        throw new Error(
          `${mismatch.id}.disposition '${mismatch.disposition}' is not supported.`,
        );
      }
      assertNonEmpty(mismatch.rationale, `${mismatch.id}.rationale`);
      const evidence = assertArray(
        mismatch.evidence,
        `${mismatch.id}.evidence`,
      );
      if (evidence.length === 0) {
        throw new Error(`${mismatch.id} requires explicit mismatch evidence.`);
      }
      await assertEvidenceResolves(evidence, `${mismatch.id}.evidence`, roots);
      if (mismatch.disposition === "INTENTIONAL_DESIGN_ADAPTATION") {
        assertNonEmpty(mismatch.approval, `${mismatch.id}.approval`);
        assertNonEmpty(
          mismatch.behavioralEquivalence,
          `${mismatch.id}.behavioralEquivalence`,
        );
      }
    }
    if (
      mapped.size !== uiBehaviorIds.size ||
      [...uiBehaviorIds].some((id) => !mapped.has(id))
    ) {
      throw new Error(
        "Every discovered UI behavior requires exactly one explicit mismatch disposition.",
      );
    }
  }
  return inventory;
};
