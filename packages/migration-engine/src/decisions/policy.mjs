/**
 * Decisions: who may decide. The principal and result vocabulary, the built-in
 * STANDARD_LOCAL policy and the protected opt-up read from root-owned storage,
 * the required-principal resolvers, principal strength, and the per-line
 * principal checks, including HUMAN_ATTESTED verification through the protected
 * verifier scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { AUTO_DECISIONS_FILE } from "../formats/index.mjs";
import { sha256Json } from "../shared/index.mjs";

/** Which principal a recorded line claims. Absent means the original human one. */
export const decisionChannelOf = (decision) =>
  decision?.authorizedBy?.channel ?? "TERMINAL";

/**
 * Decision-line schema v2: `v: 2` plus an explicit `principal`, an explicit
 * `result` and the full `candidateDigest`. A legacy line carries none of those
 * top-level fields and keeps its exact bytes; its principal is derived, and a
 * non-AUTO legacy line is historical `LEGACY_HUMAN` -- never `HUMAN_ATTESTED`.
 *
 * HUMAN_ATTESTED requires the optional protected verifier on every read.
 * The standard writer can only relay decisions; AUTO keeps its legacy shape.
 */
export const DECISION_PRINCIPALS = Object.freeze([
  "HUMAN_ATTESTED",
  "AGENT_RELAYED",
  "AUTO",
]);

export const DECISION_RESULTS = Object.freeze(["APPROVED", "REJECTED"]);

export const DECISION_V2_FIELDS = ["v", "principal", "result", "candidateDigest", "policyId", "policyDigest"];

// ponytail: one built-in policy and the existing protected opt-up, no policy selector.
export const DEFAULT_DECISION_POLICY_ID = "engine/STANDARD_LOCAL/v1";

export const PROTECTED_DECISION_POLICY_FILE = "/etc/artifact-migration-tools/decision-policy.json";

export const JUDGMENT_KINDS = new Set([
  "EXCLUSION", "DEAD_CONFIRMATION", "EDGE_RESOLUTION", "ROOT_DECLARATION",
  "TARGET_DRIFT_ACCEPTED", "VISUAL_UNBACKED", "ARTIFACT_DECISION",
]);

export const canonicalPolicy = ({ policyId, projectRoot, revision, rules }) => ({
  policyId, projectRoot, revision,
  rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
});

export const STANDARD_LOCAL = Object.freeze(canonicalPolicy({
  policyId: DEFAULT_DECISION_POLICY_ID, projectRoot: null, revision: 1,
  rules: Object.fromEntries([...JUDGMENT_KINDS].map((kind) => [kind, "AGENT_RELAYED"])),
}));

export const DEFAULT_DECISION_POLICY_DIGEST = sha256Json(STANDARD_LOCAL);

// The former default remains a historical pin, never reinterpreted as local authority.
export const LEGACY_DECISION_POLICY_ID = "engine/judgment/v1";

export const LEGACY_DECISION_POLICY_DIGEST = sha256Json(canonicalPolicy({
  policyId: LEGACY_DECISION_POLICY_ID, projectRoot: null, revision: 1, rules: {},
}));

export const policyPrincipal = (policy, kind) => policy.rules[kind] ?? "HUMAN_ATTESTED";

/** Principal strength is explicit; legacy HUMAN never acquires attestation. */
export const principalSatisfiesRequirement = (actual, required) => {
  const eligible = { HUMAN_ATTESTED: ["HUMAN_ATTESTED"],
    AGENT_RELAYED: ["HUMAN_ATTESTED", "AGENT_RELAYED"],
    AUTO: ["HUMAN_ATTESTED", "AGENT_RELAYED", "AUTO"],
  };
  return Object.hasOwn(eligible, required) && eligible[required].includes(actual);
};

/** Validate contents and the protected pin; this parser alone grants no provenance. */
export const validateProtectedDecisionPolicy = (document, projectRoot) => {
  const onlyKeys = (value, keys) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
  if (!onlyKeys(document, ["policy", "policyDigest", "provenance", "previous"])) {
    throw new Error("Protected decision policy document is malformed.");
  }
  const policy = document?.policy;
  if (!onlyKeys(policy, ["policyId", "projectRoot", "revision", "rules"]) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(policy.policyId ?? "") ||
      policy.projectRoot !== path.resolve(projectRoot) ||
      !Number.isSafeInteger(policy.revision) || policy.revision < 1 ||
      !policy.rules || typeof policy.rules !== "object" || Array.isArray(policy.rules) ||
      Object.entries(policy.rules).some(([kind, principal]) =>
        !JUDGMENT_KINDS.has(kind) || !DECISION_PRINCIPALS.includes(principal))) {
    throw new Error("Protected decision policy has invalid identity, project binding or rules.");
  }
  if (document.policyDigest !== sha256Json(canonicalPolicy(policy))) {
    throw new Error("Protected decision policy identity/digest pin mismatch.");
  }
  const audit = document.provenance;
  if (!onlyKeys(audit, ["action", "actor", "at", "reason", "previousPolicyDigest"]) ||
      audit.action !== "OPERATOR_ADMIN_POLICY_CHANGE" ||
      typeof audit.actor !== "string" || !audit.actor.trim() ||
      typeof audit.reason !== "string" || !audit.reason.trim() ||
      typeof audit.at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(audit.at) ||
      !Number.isFinite(Date.parse(audit.at)) ||
      !/^sha256:[0-9a-f]{64}$/.test(audit.previousPolicyDigest ?? "")) {
    throw new Error("Protected decision policy has missing or invalid admin-change provenance.");
  }
  if (policy.revision === 1) {
    if (document.previous !== undefined ||
        ![DEFAULT_DECISION_POLICY_DIGEST, LEGACY_DECISION_POLICY_DIGEST].includes(audit.previousPolicyDigest)) {
      throw new Error("Protected decision policy genesis provenance does not match the engine default.");
    }
  } else {
    if (!document.previous ||
        validateProtectedDecisionPolicy(document.previous, projectRoot).revision !== policy.revision - 1 ||
        document.previous.policy.policyId !== policy.policyId ||
        audit.previousPolicyDigest !== document.previous.policyDigest) {
      throw new Error("Protected decision policy admin-change history does not match its previous pin.");
    }
  }
  // The audit and pin become authority only when read from root-owned storage.
  return { ...canonicalPolicy(policy), policyDigest: document.policyDigest };
};

export const trustedPolicyFor = async (projectRoot) => {
  // The optional protected opt-up is Linux-specific; STANDARD_LOCAL works everywhere.
  if (process.platform !== "linux") return null;
  for (const directory of ["/", "/etc", path.dirname(PROTECTED_DECISION_POLICY_FILE)]) {
    let details;
    try { details = await lstat(directory); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!details.isDirectory() || details.uid !== 0 || (details.mode & 0o022)) {
      throw new Error(`Untrusted protected decision policy directory: ${directory}`);
    }
  }
  let handle;
  try {
    handle = await open(PROTECTED_DECISION_POLICY_FILE, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== 0 || (details.mode & 0o022)) {
      throw new Error("Untrusted protected decision policy file ownership or permissions.");
    }
    const document = JSON.parse(await handle.readFile("utf8"));
    return { ...validateProtectedDecisionPolicy(document, projectRoot), previous: document.previous };
  } finally {
    await handle.close();
  }
};

/** The only production policy resolver; repository/state/tool input is not read. */
export const resolveRequiredPrincipal = async (kind, projectRoot) => {
  if (!JUDGMENT_KINDS.has(kind)) throw new Error(`Unknown judgment decision kind: ${kind}`);
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("A canonical absolute project root is required for decision policy.");
  }
  const canonicalRoot = path.resolve(projectRoot);
  const policy = await trustedPolicyFor(canonicalRoot) ?? STANDARD_LOCAL;
  return {
    projectRoot: canonicalRoot,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest ?? DEFAULT_DECISION_POLICY_DIGEST,
    requiredPrincipal: policyPrincipal(policy, kind),
  };
};

export const resolveHistoricalRequiredPrincipal = async (kind, projectRoot, policyId, policyDigest) => {
  if (!JUDGMENT_KINDS.has(kind) || typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("A known decision kind and canonical absolute project root are required.");
  }
  if (policyId === DEFAULT_DECISION_POLICY_ID && policyDigest === DEFAULT_DECISION_POLICY_DIGEST) {
    return policyPrincipal(STANDARD_LOCAL, kind);
  }
  if (policyId === LEGACY_DECISION_POLICY_ID && policyDigest === LEGACY_DECISION_POLICY_DIGEST) {
    return "HUMAN_ATTESTED";
  }
  let policy = await trustedPolicyFor(path.resolve(projectRoot));
  while (policy) {
    const current = policy.policy ?? policy;
    if (current.policyId === policyId && policy.policyDigest === policyDigest) {
      return policyPrincipal(current, kind);
    }
    policy = policy.previous;
  }
  return null;
};

/** Why a line's principal/result cannot be trusted, or null. Fail-closed. */
export const decisionLineProblem = (decision) => {
  if (decision?.v === undefined) {
    const stray = DECISION_V2_FIELDS.filter(
      (field) => decision?.[field] !== undefined,
    );
    return stray.length === 0
      ? null
      : `carries ${stray.join(", ")} without "v": 2; a legacy line has no explicit principal or result`;
  }
  if (decision.v !== 2) {
    return `declares unknown decision schema v ${JSON.stringify(decision.v)}`;
  }
  if (!DECISION_PRINCIPALS.includes(decision.principal)) {
    return `declares unknown principal ${JSON.stringify(decision.principal)}`;
  }
  if (decision.principal === "HUMAN_ATTESTED") {
    return "claims HUMAN_ATTESTED, which this build has no verifier for; an unverifiable attestation is refused, not trusted";
  }
  if (decision.principal === "AUTO") {
    return `claims a v2 AUTO principal; AUTO decisions keep their own ledger shape in ${AUTO_DECISIONS_FILE}`;
  }
  if (!DECISION_RESULTS.includes(decision.result)) {
    return `declares unknown result ${JSON.stringify(decision.result)}`;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(decision.candidateDigest ?? "")) {
    return `carries no full candidateDigest (${JSON.stringify(decision.candidateDigest)})`;
  }
  if (decision.policyId !== undefined || decision.policyDigest !== undefined) {
    if (typeof decision.policyId !== "string" || !decision.policyId ||
        !/^sha256:[0-9a-f]{64}$/.test(decision.policyDigest ?? "")) {
      return "carries a missing or malformed policy identity/digest";
    }
  }
  if (decision.authorizedBy !== undefined) {
    return "carries a legacy authorizedBy block; a v2 line's principal is explicit";
  }
  if (decision.webauthn !== undefined) {
    return "carries a webauthn proof without being a HUMAN_ATTESTED line";
  }
  return null;
};

/**
 * The protected verifier for HUMAN_ATTESTED lines, scoped to one call tree by
 * whoever holds the protected signer store. Never set from argv, env, MCP or
 * repository input; absent, every attested line is refused (fail closed).
 */
export const attestationVerifierScope = new AsyncLocalStorage();

/** Shape of a HUMAN_ATTESTED v2 line; proof validity is the verifier's job. */
export const attestedLineProblem = (decision) => {
  const problem = decisionLineProblem({ ...decision, principal: "AGENT_RELAYED", webauthn: undefined });
  if (problem) return problem;
  if (!/^DEC-\d{3,}$/.test(decision.id ?? "") || !decision.candidateId) return "is not a candidate-bound DEC- line";
  if (decision.policyId === undefined) return "carries no policy binding";
  if (!decision.webauthn || typeof decision.webauthn !== "object") return "claims HUMAN_ATTESTED without a webauthn proof";
  return null;
};

export const verifyAttestedLine = async (decision, ledgerFile) => {
  const verifier = attestationVerifierScope.getStore();
  if (!verifier) {
    return "claims HUMAN_ATTESTED, but no protected signer verifier is available in this process; an unverifiable attestation is refused, not trusted (SIGNER_UNAVAILABLE)";
  }
  const shape = attestedLineProblem(decision);
  if (shape) return shape;
  try {
    await verifier.verifyDecisionLine(decision, ledgerFile);
    return null;
  } catch (error) {
    return `claims HUMAN_ATTESTED, but its proof failed protected replay verification (${error.message})`;
  }
};

/** The principal a line is read as: explicit for v2, derived for legacy. */
export const decisionPrincipalOf = (decision) =>
  decision?.v === 2
    ? decision.principal
    : decisionChannelOf(decision) === "AUTO"
      ? "AUTO"
      : "LEGACY_HUMAN";
