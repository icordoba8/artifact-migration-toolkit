import { REQUIRED_OBSERVATIONS_FORMAT } from "../formats/index.mjs";
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
