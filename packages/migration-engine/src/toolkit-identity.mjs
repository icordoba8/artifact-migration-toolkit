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
 *
 * Track A2: the identity's shape, comparison and refusal text are formats
 * vocabulary (`formats/toolkit-identity.mjs`), re-exported here unchanged. What
 * stays is the one disk read -- the running build's own identity -- because
 * formats reads no file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { engineSkillRoot } from "./engine-paths.mjs";
import { BUILD_IDENTITY_FILE, validateToolkitIdentity } from "./formats/index.mjs";
// Compatibility re-export (Track A2): these names are formats-owned now.
export {
  autoAdoptableToolkitTransition,
  BUILD_IDENTITY_FILE,
  digestToolkitIdentity,
  renderToolkitIdentity,
  sameToolkitIdentity,
  TOOLKIT_IDENTITY_EVENTS,
  TOOLKIT_IDENTITY_KEYS,
  TOOLKIT_NAME,
  toolkitIdentityBlocker,
  toolkitIdentityKey,
  toolkitIdentityStatus,
  validateToolkitIdentity,
} from "./formats/index.mjs";

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
