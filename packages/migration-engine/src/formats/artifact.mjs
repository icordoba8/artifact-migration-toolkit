/** Formats: the artifact record's contract, admission rule and state shape. */

import {
  assertArray as arrayOf,
  assertBoolean as boolean,
  assertNonEmpty as nonEmpty,
  assertPlainObject as plainObject,
  assertSafeName,
  canonicalJson as canonical,
  exactObject,
  normalizeRelative,
  unique,
} from "../shared/index.mjs";
import { resolveDesignSource } from "./design-source.mjs";
import { MIGRATION_STEPS } from "./module.mjs";
import { assertPonytailTarget } from "./record.mjs";
import {
  TOOLKIT_IDENTITY_EVENTS,
  toolkitIdentityKey,
  validateToolkitIdentity,
} from "./toolkit-identity.mjs";
import { nextIncrement, upgradeProjection } from "./upgrade.mjs";

export const ARTIFACT_CONTRACT_VERSION = 1;

export const ARTIFACT_FORMAT_VERSION = 14;

export const ARTIFACT_FORMAT_SUPPORTED = ARTIFACT_FORMAT_VERSION;

export const ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS = 14;

/**
 * Artifact 14: decision authority is resolved directly from the verified
 * ledger, the artifact counterpart of module format 19. Exact, not "at
 * least": a format-13 record keeps its citation rules and its pristine
 * bootstrap history for its whole life, and reaches 14 only through the
 * explicit 13 -> 14 increment.
 */
export const ARTIFACT_DIRECT_LEDGER_FORMAT = 14;
export const usesArtifactDirectLedger = (formatVersion) =>
  formatVersion === ARTIFACT_DIRECT_LEDGER_FORMAT;

export const ARTIFACT_WORKFLOW_VERSION = "1.0";

export const ARTIFACT_RESOLUTIONS = Object.freeze([
  "TARGET_REUSE",
  "TARGET_EXTEND",
  "MIGRATE_NEW",
]);

/**
 * The artifact engine's format-upgrade floor and registry, the same contract the
 * module engine declares. Declared, never derived: at or above the floor the
 * registry is the sole promoter of `formatVersion`, and below it nothing here
 * applies.
 *
 * The floor remains 13: no historical 12 -> 13 upgrader is claimed.
 */
export const ARTIFACT_FORMAT_UPGRADE_FLOOR = 13;

/**
 * The pure half of the registry: which adjacent increments exist. How each
 * runs is `ARTIFACT_FORMAT_UPGRADERS` in `artifact/artifact-migration.mjs`.
 */
export const ARTIFACT_FORMAT_INCREMENTS = Object.freeze([Object.freeze({
  from: 13,
  to: 14,
  id: "PRISTINE_ARTIFACT_ADOPTED",
  version: 1,
  requiredInput: null,
  activation: null,
})]);

/**
 * A cursor is informational only. Explicit preview and confirmation are the
 * sole route to the registered transition; normal execution never promotes.
 */
export const artifactFormatUpgrade = (state) => {
  const increment = nextIncrement(
    ARTIFACT_FORMAT_INCREMENTS,
    state?.formatVersion ?? 1,
    ARTIFACT_FORMAT_VERSION,
    ARTIFACT_FORMAT_UPGRADE_FLOOR,
  );
  if (!increment) return null;
  const { from, to, row } = increment;
  return upgradeProjection({
    recordFormat: state.formatVersion,
    runtimeFormat: ARTIFACT_FORMAT_VERSION,
    from,
    to,
    upgrader: row ? { id: row.id, version: row.version } : null,
    // Fail closed: a missing row means this toolkit cannot move the record, and
    // `validateState` has already refused to admit it.
    state: row ? "INACTIVE" : "BLOCKED",
    active: !row,
    domain: null,
    blockers: row
      ? []
      : [
          `No registered artifact format upgrader for ${from} -> ${to}. This toolkit cannot move the record past format ${from}; nothing was read or written.`,
        ],
    nextAction: row
      ? `Preview the explicit artifact format upgrade ${from} -> ${to} (${row.id} v${row.version}).`
      : `Install a toolkit that registers the ${from} -> ${to} artifact format upgrader.`,
  });
};

/**
 * Admission, and only admission. A persisted format is readable when it is the
 * runtime format, or when it sits at or above the floor, behind the runtime, and
 * every increment from there to the runtime has a registered upgrader. Anything
 * else -- below the floor, newer than the runtime, a gap in the path -- stays
 * refused with the message it has always been refused with.
 */
const artifactFormatAdmissible = (formatVersion) => {
  if (formatVersion === ARTIFACT_FORMAT_VERSION) return true;
  if (
    !Number.isInteger(formatVersion) ||
    formatVersion < ARTIFACT_FORMAT_UPGRADE_FLOOR ||
    formatVersion > ARTIFACT_FORMAT_VERSION
  ) {
    return false;
  }
  for (let at = formatVersion; at < ARTIFACT_FORMAT_VERSION; at += 1) {
    const increment = nextIncrement(
      ARTIFACT_FORMAT_INCREMENTS,
      at,
      ARTIFACT_FORMAT_VERSION,
      ARTIFACT_FORMAT_UPGRADE_FLOOR,
    );
    if (!increment?.row) return false;
  }
  return true;
};

export const STATE_FILE = "state.json";

export const TRANSACTION_FILE = "transaction.json";

const ARTIFACT_KNOWN_STATE_KEYS = [
  "contractVersion",
  "formatVersion",
  "workflowVersion",
  "artifactId",
  "artifactType",
  "source",
  "target",
  "resolution",
  "hasVisibleUi",
  "status",
  "currentStep",
  "activeSlice",
  "completedSteps",
  "pendingSteps",
  "completedSlices",
  "pendingSlices",
  "bindings",
  "artifactHashes",
  "revision",
  "nextAction",
  "nextCommand",
  "createdAt",
  "updatedAt",
];

// Which built toolkit may mutate this record. Implementation metadata, not an
// artifact format capability: absent on every record created before the
// standalone toolkit existed, and its presence changes no contract 1 /
// format 13 / workflow 1.0 meaning. Genuinely optional, so it is declared as
// optional rather than smuggled into the required set -- an unstamped record
// stays byte-identical to what it always was.
const ARTIFACT_OPTIONAL_STATE_KEYS = [
  "toolkitIdentity",
  "designSource",
  "figmaSources",
  "ponytail",
];

const validateBinding = (value, label) => {
  exactObject(value, label, ["revision", "pathScoped", "dirtyDigest", "paths", "entries", "digest"]);
  nonEmpty(value.revision, `${label}.revision`);
  boolean(value.pathScoped, `${label}.pathScoped`);
  nonEmpty(value.dirtyDigest, `${label}.dirtyDigest`);
  nonEmpty(value.digest, `${label}.digest`);
  const paths = arrayOf(value.paths, `${label}.paths`).map((entry) =>
    normalizeRelative(entry, `${label}.paths[]`),
  );
  unique(paths, `${label}.paths`);
  for (const [index, entry] of arrayOf(value.entries, `${label}.entries`).entries()) {
    exactObject(entry, `${label}.entries[${index}]`, ["path", "kind", "sha256"]);
    normalizeRelative(entry.path, `${label}.entries[${index}].path`);
    if (!["FILE", "MISSING"].includes(entry.kind)) throw new Error(`${label}.entries[${index}].kind is invalid.`);
    if (entry.kind === "FILE") nonEmpty(entry.sha256, `${label}.entries[${index}].sha256`);
    else if (entry.sha256 !== null) throw new Error(`${label}.entries[${index}].sha256 must be null.`);
  }
};

export const validateState = (state, expectedId) => {
  exactObject(state, "artifact state", ARTIFACT_KNOWN_STATE_KEYS, ARTIFACT_OPTIONAL_STATE_KEYS);
  // Present or absent, never partial: a half-written identity is a runtime that
  // cannot be compared, which is the one thing this field exists to prevent.
  if (state.toolkitIdentity !== undefined) {
    validateToolkitIdentity(state.toolkitIdentity, "artifact state.toolkitIdentity");
  }
  if (state.contractVersion !== ARTIFACT_CONTRACT_VERSION) {
    throw new Error(`Unsupported artifact contract ${state.contractVersion}.`);
  }
  if (!artifactFormatAdmissible(state.formatVersion)) {
    throw new Error(`Unsupported artifact format ${state.formatVersion}.`);
  }
  if (state.workflowVersion !== ARTIFACT_WORKFLOW_VERSION) throw new Error("Unsupported artifact workflow version.");
  assertSafeName(state.artifactId, "artifact id");
  if (expectedId && state.artifactId !== expectedId) throw new Error("Artifact state identity does not match its directory.");
  assertSafeName(state.artifactType, "artifact type");
  for (const [key, label] of [["source", "source"], ["target", "target"]]) {
    exactObject(state[key], label, ["root", "path"]);
    nonEmpty(state[key].root, `${label}.root`);
    normalizeRelative(state[key].path, `${label}.path`);
  }
  if (state.resolution !== null && !ARTIFACT_RESOLUTIONS.includes(state.resolution)) {
    throw new Error(`Unknown artifact resolution '${state.resolution}'.`);
  }
  if (state.hasVisibleUi !== null) boolean(state.hasVisibleUi, "hasVisibleUi");
  if (state.designSource !== undefined) {
    const design = resolveDesignSource({
      designSource: state.designSource,
      figma: (state.figmaSources ?? []).map((source) => source?.raw),
    });
    if (canonical(design.figmaSources) !== canonical(state.figmaSources ?? [])) {
      throw new Error("Artifact state figmaSources are not canonical.");
    }
  } else if (state.figmaSources !== undefined) {
    throw new Error("Artifact state figmaSources require designSource.");
  }
  if (state.ponytail !== undefined) assertPonytailTarget(state.ponytail);
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) throw new Error(`Invalid artifact status '${state.status}'.`);
  if (state.currentStep !== "COMPLETE" && !MIGRATION_STEPS.includes(state.currentStep)) {
    throw new Error(`Unknown artifact checkpoint '${state.currentStep}'.`);
  }
  for (const field of ["completedSteps", "pendingSteps", "completedSlices", "pendingSlices"]) {
    arrayOf(state[field], field);
    unique(state[field], field);
  }
  const prefix = MIGRATION_STEPS.slice(0, state.completedSteps.length);
  if (canonical(prefix) !== canonical(state.completedSteps)) {
    throw new Error("completedSteps must be an in-order checkpoint prefix.");
  }
  exactObject(state.bindings, "bindings", ["source", "target"]);
  validateBinding(state.bindings.source, "bindings.source");
  validateBinding(state.bindings.target, "bindings.target");
  if (!state.bindings.source.paths.includes(state.source.path) || !state.bindings.target.paths.includes(state.target.path)) {
    throw new Error("Artifact binding paths must include their primary source and target.");
  }
  plainObject(state.artifactHashes, "artifactHashes");
  for (const [key, digest] of Object.entries(state.artifactHashes)) {
    nonEmpty(key, "artifactHashes key");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`artifactHashes['${key}'] is not SHA-256.`);
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error("revision must be a non-negative integer.");
  for (const field of ["nextAction", "nextCommand", "createdAt", "updatedAt"]) nonEmpty(state[field], field);
  return state;
};

/**
 * The toolkit identity the append-only history proves this record has reached.
 *
 * Identity is anchored by the event chain, not by state.json alone: the record
 * is born with whatever the creating toolkit was (absent for an unidentified
 * source checkout, exactly as before this field existed), and every later change
 * must be an explicit recorded maintenance event whose `previous` is exactly
 * where the replay stands. A duplicated, reordered, fabricated or unknown
 * identity event therefore cannot line up, and fails closed.
 */
export const replayToolkitIdentity = (events) => {
  let identity =
    events[0]?.toolkitIdentity === undefined
      ? null
      : validateToolkitIdentity(
          events[0].toolkitIdentity,
          "artifact history BOOTSTRAPPED toolkitIdentity",
        );
  for (const event of events.slice(1)) {
    if (!String(event.event).startsWith("TOOLKIT_IDENTITY_")) continue;
    if (!TOOLKIT_IDENTITY_EVENTS.includes(event.event)) {
      throw new Error(`Artifact history contains an unrecognized toolkit identity event '${event.event}'.`);
    }
    const adopting = event.event === "TOOLKIT_IDENTITY_ADOPTED";
    if (adopting !== (identity === null)) {
      throw new Error(
        adopting
          ? "Artifact history adopts a toolkit identity on a record that already carries one."
          : "Artifact history changes a toolkit identity on a record that never adopted one.",
      );
    }
    if (!Object.hasOwn(event, "previous") || !Object.hasOwn(event, "next")) {
      throw new Error(`Artifact history ${event.event} must carry both previous and next identities.`);
    }
    if (toolkitIdentityKey(event.previous) !== toolkitIdentityKey(identity)) {
      throw new Error(
        "Artifact history records a toolkit identity change whose previous identity is not the one the replayed history had reached.",
      );
    }
    identity = validateToolkitIdentity(event.next, `artifact history ${event.event} next identity`);
  }
  return identity;
};
