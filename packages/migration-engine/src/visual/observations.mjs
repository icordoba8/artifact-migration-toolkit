import { REQUIRED_OBSERVATIONS_FORMAT, UI_COVERAGE_FORMAT } from "../formats/index.mjs";
import {
  assertArray,
  assertNonEmpty,
  assertPlainObject,
} from "../shared/index.mjs";

/** A disposition that drops its UI behavior out of the required-evidence set. */
const UI_UNREQUIRED_DISPOSITIONS = new Set(["LEGACY_DEFECT", "NOT_APPLICABLE"]);

/**
 * Whether a discovered UI behavior needs runtime verification. A legacy defect
 * or a not-applicable difference is never reproduced for visual similarity, and
 * a conditional control is not required merely because it was observed once --
 * it becomes required only when its disposition says the behavior is required.
 * One predicate so PLAN traceability and VERIFY_SLICES evidence agree.
 */
export const uiBehaviorIsRequired = (uiBehavior, mismatch) => {
  const disposition = mismatch?.disposition;
  if (UI_UNREQUIRED_DISPOSITIONS.has(disposition)) return false;
  return uiBehavior.conditional !== true || disposition === "REQUIRED_BEHAVIOR";
};

/**
 * The format-18 acceptance set of one legacy UI behavior. Control identity is
 * (role, exact accessible name); `url` is page-scoped and has neither. Entries
 * are conjunctive, and every runtime state and declared interaction needs at
 * least one. Shape only: nothing here reads, or may be supplied by, TARGET proof.
 */
export const OBSERVATION_EXPECTED = {
  presence: (value) => typeof value === "boolean",
  visibility: (value) => typeof value === "boolean",
  text: (value) => typeof value === "string",
  value: (value) => typeof value === "string",
  count: (value) => Number.isInteger(value) && value >= 0,
  url: (value) => typeof value === "string" && value.length > 0,
};

const OBSERVATION_FIELDS = new Set([
  "id",
  "state",
  "afterInteractionId",
  "role",
  "name",
  "predicate",
  "expected",
]);

export const assertRequiredObservations = (item, seenIds = new Set()) => {
  const label = `${item.id}.requiredObservations`;
  if (item.requiredObservations === undefined) {
    throw new Error(
      `${label} is missing. A format-${REQUIRED_OBSERVATIONS_FORMAT} UI behavior without it is an unadopted contract, never an empty set; author it from legacy evidence and the pinned OpenSpec authority.`,
    );
  }
  const observations = assertArray(item.requiredObservations, label);
  const runtimeStates = item.runtimeStates ?? [];
  const interactionIds = (item.interactions ?? []).map(
    (interaction) => interaction.id,
  );
  for (const [index, observation] of observations.entries()) {
    const at = `${label}[${index}]`;
    assertPlainObject(observation, at);
    const unknown = Object.keys(observation).filter(
      (key) => !OBSERVATION_FIELDS.has(key),
    );
    if (unknown.length > 0) {
      throw new Error(`${at} has unsupported fields: ${unknown.join(", ")}.`);
    }
    assertNonEmpty(observation.id, `${at}.id`);
    if (seenIds.has(observation.id)) {
      throw new Error(`${at}.id '${observation.id}' is not unique across the inventory.`);
    }
    seenIds.add(observation.id);
    if (!runtimeStates.includes(observation.state)) {
      throw new Error(
        `${at}.state '${observation.state}' is not one of ${item.id}.runtimeStates.`,
      );
    }
    if (
      "afterInteractionId" in observation &&
      !interactionIds.includes(observation.afterInteractionId)
    ) {
      throw new Error(
        `${at}.afterInteractionId '${observation.afterInteractionId}' is not an interaction of ${item.id}.`,
      );
    }
    const fits = OBSERVATION_EXPECTED[observation.predicate];
    if (!fits) {
      throw new Error(
        `${at}.predicate '${observation.predicate}' is not one of ${Object.keys(OBSERVATION_EXPECTED).join(", ")}.`,
      );
    }
    if (observation.predicate === "url") {
      if ("role" in observation || "name" in observation) {
        throw new Error(`${at} is a page-scoped url observation and takes no role or name.`);
      }
    } else {
      assertNonEmpty(observation.role, `${at}.role`);
      assertNonEmpty(observation.name, `${at}.name`);
    }
    if (!fits(observation.expected)) {
      throw new Error(
        `${at}.expected does not fit predicate '${observation.predicate}'.`,
      );
    }
  }
  for (const runtimeState of runtimeStates) {
    if (
      !observations.some(
        (observation) =>
          observation.state === runtimeState &&
          !("afterInteractionId" in observation),
      )
    ) {
      throw new Error(
        `${label} has no state observation for runtime state '${runtimeState}'.`,
      );
    }
  }
  for (const interactionId of interactionIds) {
    if (
      !observations.some(
        (observation) => observation.afterInteractionId === interactionId,
      )
    ) {
      throw new Error(
        `${label} has no post-action observation for interaction '${interactionId}'.`,
      );
    }
  }
};

/** Format 20's authored appearance set is pinned with the legacy inventory. */
export const assertRequiredAppearance = (item, seenIds = new Set()) => {
  const label = `${item.id}.requiredAppearance`;
  const claims = assertArray(item.requiredAppearance, label);
  const states = item.runtimeStates ?? [];
  const interactions = (item.interactions ?? []).map((row) => row.id);
  for (const [index, claim] of claims.entries()) {
    const at = `${label}[${index}]`;
    assertPlainObject(claim, at);
    assertNonEmpty(claim.id, `${at}.id`);
    if (seenIds.has(claim.id)) throw new Error(`${at}.id '${claim.id}' is not unique.`);
    seenIds.add(claim.id);
    if (!states.includes(claim.state)) throw new Error(`${at}.state must be a discovered runtime state.`);
    for (const field of ["role", "name", "locator"]) assertNonEmpty(claim[field], `${at}.${field}`);
    if (claim.afterInteractionId !== undefined && !interactions.includes(claim.afterInteractionId)) {
      throw new Error(`${at}.afterInteractionId is not a discovered interaction.`);
    }
  }
  for (const state of states) {
    if (!claims.some((claim) => claim.state === state && !claim.afterInteractionId)) {
      throw new Error(`${label} has no initial appearance claim for '${state}'.`);
    }
  }
  for (const observation of item.requiredObservations ?? []) {
    if (observation.predicate === "url" || observation.expected === false) continue;
    if (!claims.some((claim) => claim.state === observation.state &&
      claim.role === observation.role && claim.name === observation.name &&
      claim.afterInteractionId === observation.afterInteractionId)) {
      throw new Error(`${label} does not cover required control '${observation.id}' in '${observation.state}'.`);
    }
  }
  for (const interaction of interactions) {
    if (!claims.some((claim) => claim.afterInteractionId === interaction)) {
      throw new Error(`${label} has no post-action appearance claim for '${interaction}'.`);
    }
  }
  const scroll = assertArray(item.scrollContracts, `${item.id}.scrollContracts`);
  if (scroll.length !== states.length || new Set(scroll.map((row) => row.state)).size !== states.length) {
    throw new Error(`${item.id}.scrollContracts must have exactly one row per runtime state.`);
  }
  for (const row of scroll) {
    assertPlainObject(row, `${item.id}.scrollContracts row`);
    if (!states.includes(row.state) || !["NONE", "DOCUMENT", "ELEMENT"].includes(row.owner) ||
      typeof row.documentScrollable !== "boolean" || typeof row.ancestorClipped !== "boolean") {
      throw new Error(`${item.id}.scrollContracts has an unsupported state, owner or scroll fact.`);
    }
  }
  const imports = assertArray(item.externalUiImports, `${item.id}.externalUiImports`);
  for (const token of imports) assertNonEmpty(token, `${item.id}.externalUiImports entry`);
  if (new Set(imports).size !== imports.length) throw new Error(`${item.id}.externalUiImports contains duplicates.`);
  return { claims, scroll };
};

const scrollMetrics = (snapshot, label) => {
  const scroll = assertPlainObject(snapshot?.observation?.scroll, `${label}.observation.scroll`);
  const document = assertPlainObject(scroll.document, `${label}.document`);
  const measure = (item, at) => {
    for (const field of ["clientHeight", "scrollHeight"]) {
      if (!Number.isInteger(item?.[field]) || item[field] < 0) throw new Error(`${at}.${field} must be a nonnegative integer.`);
    }
  };
  measure(document, `${label}.document`);
  const owner = assertPlainObject(scroll.owner, `${label}.owner`);
  if (!["NONE", "DOCUMENT", "ELEMENT"].includes(owner.kind)) throw new Error(`${label}.owner.kind is invalid.`);
  if (owner.kind === "ELEMENT") {
    assertNonEmpty(owner.locator, `${label}.owner.locator`);
    measure(owner, `${label}.owner`);
    if (!["auto", "scroll"].includes(owner.overflowY) || owner.scrollHeight <= owner.clientHeight + 1) {
      throw new Error(`${label}.owner is not a measured scrollable element.`);
    }
  }
  const ancestors = assertArray(scroll.ancestors, `${label}.ancestors`);
  for (const [index, ancestor] of ancestors.entries()) {
    assertPlainObject(ancestor, `${label}.ancestors[${index}]`);
    assertNonEmpty(ancestor.locator, `${label}.ancestors[${index}].locator`);
    measure(ancestor, `${label}.ancestors[${index}]`);
    if (!["auto", "scroll", "hidden", "clip", "visible"].includes(ancestor.overflowY)) {
      throw new Error(`${label}.ancestors[${index}].overflowY is invalid.`);
    }
  }
  if (owner.kind === "ELEMENT" && ancestors.length === 0) throw new Error(`${label}.ancestors must measure the scroll owner's parent.`);
  const documentScrollable = document.scrollHeight > document.clientHeight + 1;
  if (owner.kind === "DOCUMENT" && !documentScrollable || owner.kind === "NONE" && documentScrollable) {
    throw new Error(`${label}.owner disagrees with measured document scrolling.`);
  }
  return {
    owner: owner.kind,
    documentScrollable,
    ancestorClipped: ancestors.some((row) => ["hidden", "clip"].includes(row.overflowY)),
    ownerClientHeight: owner.kind === "ELEMENT" ? owner.clientHeight : document.clientHeight,
    ancestorClientHeight: ancestors.length ? Math.min(...ancestors.map((row) => row.clientHeight)) : null,
  };
};

export const compareScrollContract = (legacyProof, targetProof, contract) => {
  const legacy = scrollMetrics(legacyProof, "LEGACY scroll");
  const target = scrollMetrics(targetProof, "TARGET scroll");
  for (const [field, expected] of Object.entries({
    owner: contract.owner,
    documentScrollable: contract.documentScrollable,
    ancestorClipped: contract.ancestorClipped,
  })) {
    if (legacy[field] !== expected || target[field] !== expected) {
      throw new Error(`SCROLL_DIVERGENCE: ${field} expected ${JSON.stringify(expected)}, LEGACY ${JSON.stringify(legacy[field])}, TARGET ${JSON.stringify(target[field])}.`);
    }
  }
  for (const field of ["ownerClientHeight", "ancestorClientHeight"]) {
    if (legacy[field] !== null && target[field] !== null && Math.abs(legacy[field] - target[field]) > 1) {
      throw new Error(`SCROLL_DIVERGENCE: ${field} differs by more than 1px (${legacy[field]} versus ${target[field]}).`);
    }
  }
  return { legacy, target, result: "PASS", format: UI_COVERAGE_FORMAT };
};
