/**
 * Which built toolkit is executing a record.
 *
 * Toolkit identity is metadata about the *implementation*, not about the
 * migration format. Nothing here reads, writes, or reinterprets a contract
 * version, a format version, a lifecycle step, a decision, an evidence hash or
 * a ledger digest. A record stamped with an identity means exactly one thing:
 * "the release named below is the only one permitted to mutate me", and the
 * reason is the one the extraction plan states -- after the consumer's local
 * engine is retired, a silent swap to a different build must be impossible.
 *
 * The identity of a release is fixed while packaging an already-committed tree
 * and read back from `build-identity.json` beside this `src/`. There is
 * deliberately no environment override, for the reason `engine-paths.mjs`
 * already gives about the engine's own location: the installed file *is* the
 * answer, and an env var on a fail-closed gate is a redirect hook on the gate.
 *
 * A plain source checkout has no `build-identity.json` and is therefore
 * *unidentified*. That is a real, supported state, not an error, but it is a
 * read-only one: it can read, validate and report on any record, and it may
 * mutate none, because it cannot prove it is the release a stamped record
 * pinned and it has no identity to adopt onto an unstamped one. A test suite
 * that needs to mutate therefore installs a real identity file and runs
 * identified, exactly as an operator's installation does -- see
 * `test/support/fixture-identity.mjs`. There is no seam that fabricates one
 * in-process: a setter on this module would be a forger's entry point into
 * every gate that depends on it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { engineSkillRoot } from "./engine-paths.mjs";

/** The whole identity. Four fields, exactly; no optional ones, ever. */
export const TOOLKIT_IDENTITY_KEYS = ["name", "version", "commit", "contentHash"];

/** Written into a release bundle by `scripts/release.mjs`, never committed. */
export const BUILD_IDENTITY_FILE = "build-identity.json";

export const TOOLKIT_NAME = "artifact-migration-tools";

// Toolkit SemVer is an independent axis from every migration version. Nothing
// in this file derives a format, contract or workflow number from it, and
// nothing derives it from them -- `test/unit/toolkit-identity.test.mjs` proves
// both directions.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * Strict parse. Every rejection is a refusal to run, never a downgrade to
 * "unidentified": a malformed identity on a record or in an install tree is
 * tampering or a broken build, and both must stop the command.
 */
export const validateToolkitIdentity = (value, label = "toolkitIdentity") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...TOOLKIT_IDENTITY_KEYS].sort())) {
    throw new Error(
      `${label} must contain exactly ${TOOLKIT_IDENTITY_KEYS.join(", ")}.`,
    );
  }
  if (value.name !== TOOLKIT_NAME) {
    throw new Error(`${label}.name must be '${TOOLKIT_NAME}'.`);
  }
  if (typeof value.version !== "string" || !SEMVER.test(value.version)) {
    throw new Error(`${label}.version must be an exact SemVer string.`);
  }
  if (typeof value.commit !== "string" || !COMMIT_SHA.test(value.commit)) {
    throw new Error(`${label}.commit must be a full 40-character Git commit SHA.`);
  }
  if (typeof value.contentHash !== "string" || !CONTENT_HASH.test(value.contentHash)) {
    throw new Error(`${label}.contentHash must be 'sha256:' plus 64 hex characters.`);
  }
  return value;
};

/**
 * The canonical byte form of an identity: fixed key order, so comparison and
 * digesting never depend on how a JSON file happened to be written.
 */
export const toolkitIdentityKey = (identity) =>
  identity === null || identity === undefined
    ? null
    : JSON.stringify(
        Object.fromEntries(TOOLKIT_IDENTITY_KEYS.map((key) => [key, identity[key]])),
      );

/** Exact equality on all four fields. A version match alone is not a match. */
export const sameToolkitIdentity = (left, right) =>
  left !== null &&
  left !== undefined &&
  right !== null &&
  right !== undefined &&
  toolkitIdentityKey(left) === toolkitIdentityKey(right);

export const digestToolkitIdentity = (identity) =>
  identity === null || identity === undefined
    ? null
    : createHash("sha256").update(toolkitIdentityKey(identity)).digest("hex");

/** One-line rendering for operator-facing messages. Never persisted. */
export const renderToolkitIdentity = (identity) =>
  identity === null || identity === undefined
    ? "unidentified (source checkout, no build-identity.json)"
    : `${identity.name}@${identity.version} commit ${identity.commit.slice(0, 12)} ${identity.contentHash}`;

/**
 * The identity of the toolkit running right now, or `null` for a source
 * checkout. Read once: an installed tree's identity file cannot change under a
 * running process without that being exactly the tampering this gate exists to
 * refuse, and re-reading it per call would invite a check/use gap.
 */
let cached;
export const activeToolkitIdentity = () => {
  if (cached !== undefined) return cached;
  const file = path.join(engineSkillRoot, BUILD_IDENTITY_FILE);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      cached = null;
      return cached;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Toolkit ${BUILD_IDENTITY_FILE} is not valid JSON: ${error.message}`);
  }
  cached = validateToolkitIdentity(parsed, BUILD_IDENTITY_FILE);
  return cached;
};

/** Test seam only: forget the cached read. Never called by engine code. */
export const resetActiveToolkitIdentity = () => {
  cached = undefined;
};

export const TOOLKIT_IDENTITY_EVENTS = [
  "TOOLKIT_IDENTITY_ADOPTED",
  "TOOLKIT_IDENTITY_CHANGED",
];

/**
 * The one reason a mutation may be refused for identity, as a message, or
 * `null` to proceed. Read-only paths call `toolkitIdentityStatus` instead and
 * never this: status must report and never block, mutation must block and
 * never write.
 *
 * `adoptCommand` is rendered by the caller through `engineCommand`, so the
 * operator is always given this engine's own installed executable rather than
 * a guess about where the toolkit lives.
 */
export const toolkitIdentityBlocker = (recorded, active, { action, adoptCommand }) => {
  if (!recorded) {
    // An unstamped record refuses every mutation until a toolkit is explicitly
    // adopted, and *which* toolkit is running does not soften that. An earlier
    // version exempted the unidentified runtime on the grounds that nothing had
    // been pinned yet, which is true and beside the point: the exemption made
    // "delete build-identity.json" -- or simply run from a checkout -- a way to
    // write to a record no build has claimed, which is the silent swap this
    // gate exists to refuse, dressed as the absence of a swap. So the refusal is
    // unconditional and only the remedy differs. A released toolkit can be
    // adopted, so it is told the one command. A source checkout has no identity
    // to stamp -- `changeModuleToolkitIdentity` refuses it too -- so telling it
    // to adopt would name a command that cannot succeed; it is told to install a
    // release instead. Reading the record stays open in both cases.
    return active
      ? `This record carries no toolkit identity, so ${action} is refused until the running toolkit is explicitly adopted. Nothing was written. Adopt it with: ${adoptCommand}`
      : `This record carries no toolkit identity, and the running engine is a source checkout with no ${BUILD_IDENTITY_FILE}, so it has no identity to adopt. ${action} is refused and nothing was written. Install a released toolkit bundle and adopt it against this record. Reading the record is unaffected.`;
  }
  if (!active) {
    return `This record pins toolkit ${renderToolkitIdentity(recorded)}, but the running engine is a source checkout with no ${BUILD_IDENTITY_FILE} and cannot prove it is that release. ${action} is refused and nothing was written.`;
  }
  if (!sameToolkitIdentity(recorded, active)) {
    return `This record pins toolkit ${renderToolkitIdentity(recorded)}, but the running toolkit is ${renderToolkitIdentity(active)}. ${action} is refused and nothing was written. Install the pinned release, or perform an explicit toolkit identity update.`;
  }
  return null;
};

/** `UNSTAMPED` / `MATCH` / `MISMATCH` / `UNIDENTIFIED_TOOLKIT`, for read-only reporting. */
export const toolkitIdentityStatus = (recorded, active) => {
  if (!recorded) return "UNSTAMPED";
  if (!active) return "UNIDENTIFIED_TOOLKIT";
  return sameToolkitIdentity(recorded, active) ? "MATCH" : "MISMATCH";
};
