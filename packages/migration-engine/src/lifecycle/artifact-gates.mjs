/**
 * Lifecycle: the artifact FINALIZE gate evidence -- the scope and binding every
 * gate evidence entry carries, and the typed, agent-asserted Ponytail evidence
 * layered on top.
 * Moved out of `artifact-checkpoints.mjs`, which may not grow.
 */
import { exactObject, normalizeRelative, sha256Hex as sha256 } from "../shared/index.mjs";
import { secureHash, STATE_ROOT } from "../store/index.mjs";

// Gate evidence is a claim about *this* migration. A bare hash of any file that
// happens to exist proved nothing: the cited path must be one this migration
// changed or declared as a target file, or the seven canonical gates are
// satisfiable by an unrelated pre-existing file.
export const validateGateEvidence = async (state, item, label, scope, extra = [], optional = []) => {
  exactObject(item, label, ["path", "sha256", "boundTo", ...extra], optional);
  const relative = normalizeRelative(item.path, `${label}.path`);
  if (scope && !scope.has(relative)) {
    throw new Error(
      `${label} cites '${relative}', which is not one of this migration's changed or declared target files.`,
    );
  }
  if ((await secureHash(state.target.root, relative, `${label}.path`)) !== item.sha256) throw new Error(`${label}.sha256 does not match ${relative}.`);
  exactObject(item.boundTo, `${label}.boundTo`, ["sourceDigest", "targetDigest"]);
  if (item.boundTo.sourceDigest !== state.bindings.source.digest || item.boundTo.targetDigest !== state.bindings.target.digest) {
    throw new Error(`${label} is stale.`);
  }
};

export const ponytailTime = (value, label) => {
  const time = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return time;
};

/**
 * M10 D1. Ponytail evidence is AGENT_ASSERTED, and the engine says so. The
 * Ponytail skills are prompts with no receipt issuer: the evidence file, its
 * hash, its binding and its timestamp are all written by the agent, so no check
 * here -- nor M9-R1's binding line, which this replaces -- can prove a Ponytail
 * skill ran. The engine verifies what it can (the cited file is the expected
 * one, unchanged, non-empty, bound to the current source and target, and in
 * order) and records the agent's own `execution` statement without promoting
 * it. Nothing in this toolkit can attest a review, and none is claimed.
 */
export const PONYTAIL_ASSURANCE = "AGENT_ASSERTED";
export const PONYTAIL_EXECUTION = ["SKILL_INVOKED", "SKILL_UNAVAILABLE"];
const EMPTY_SHA256 = sha256(Buffer.alloc(0));

export const validatePonytailEvidence = async (state, gate, kind) => {
  const label = `final gate '${gate.name}' ponytailEvidence`;
  const item = gate.ponytailEvidence;
  if (!item) throw new Error(`Ponytail target '${state.ponytail}' requires ${gate.name} ${kind} evidence.`);
  const expectedPath = `${STATE_ROOT}/${state.artifactId}/evidence/ponytail-${kind}.md`;
  if (item.path !== expectedPath) throw new Error(`${label}.path must be '${expectedPath}'.`);
  // Optional so evidence written before M10 stays valid; an unstated
  // execution is reported UNRECORDED, never inferred.
  await validateGateEvidence(state, item, label, null, ["kind", "producedAt"], ["assurance", "execution"]);
  if (item.kind !== kind) throw new Error(`${label}.kind must be '${kind}'.`);
  if (Object.hasOwn(item, "assurance") && item.assurance !== PONYTAIL_ASSURANCE) {
    throw new Error(`${label}.assurance must be '${PONYTAIL_ASSURANCE}': the engine cannot verify that a Ponytail skill ran, and no authority attests it.`);
  }
  if (Object.hasOwn(item, "execution") && !PONYTAIL_EXECUTION.includes(item.execution)) {
    throw new Error(`${label}.execution must be one of ${PONYTAIL_EXECUTION.join(", ")}.`);
  }
  // Completed records keep the evidence they were pinned with.
  if (state.status !== "COMPLETE" && item.sha256 === EMPTY_SHA256) throw new Error(`${label} cites an empty file.`);
  return {
    at: ponytailTime(item.producedAt, `${label}.producedAt`),
    report: { kind, path: item.path, sha256: item.sha256, producedAt: item.producedAt, assurance: PONYTAIL_ASSURANCE, execution: item.execution ?? "UNRECORDED" },
  };
};
