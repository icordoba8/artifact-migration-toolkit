/**
 * Decisions: what is decided. Candidate identity and digests (legacy and
 * policy-bound), decision kinds and post-census eligibility, the lifecycle
 * binding, homogeneous groups (legacy and format 19), the one applicability
 * predicate, and the artifact candidate shape.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { ARTIFACT_WORKFLOW_VERSION } from "../formats/index.mjs";
import { canonicalJson as canonical, sha256Hex as sha256 } from "../shared/index.mjs";
import { hashFile } from "../store/index.mjs";
import { principalSatisfiesRequirement, resolveRequiredPrincipal } from "./policy.mjs";

/**
 * The only decision kinds a record may gain after DISCOVERY_COMPLETENESS
 * closed. A classification approval added late would be an approval for facts
 * the census already fixed; a drift acceptance is a judgement about bytes that
 * did not exist yet when the census ran.
 */
export const LATE_DECISION_KINDS = new Set(["TARGET_DRIFT_ACCEPTED", "VISUAL_UNBACKED"]);

export const decisionKindAllowed = (kind, censusClosed) =>
  !censusClosed || LATE_DECISION_KINDS.has(kind);

/**
 * ponytail: the chain digests the re-serialized object, not the raw line
 * bytes. `JSON.parse` preserves key order and `JSON.stringify` re-emits it, so
 * the round trip is stable for lines this workflow writes. Ceiling: a
 * hand-written line with different key order breaks its own chain, which is
 * the intended outcome anyway. Upgrade path: digest raw line bytes.
 */
export const decisionLineDigest = (decision) =>
  `sha256:${createHash("sha256").update(JSON.stringify(decision)).digest("hex")}`;

export const decisionRationaleDigest = (rationale) =>
  `sha256:${createHash("sha256")
    .update(String(rationale).replace(/\r\n/g, "\n").trim())
    .digest("hex")}`;

/** The record's exact lifecycle position, as one comparable object. */
export const lifecycleBinding = async (state, statePath) => ({
  module: state.migrationId ?? state.targetModule ?? null,
  formatVersion: state.formatVersion ?? null,
  revision: state.revision ?? null,
  stateHash: await hashFile(statePath),
  status: state.status ?? null,
  currentStep: state.currentStep ?? null,
  activeSlice: state.activeSlice ?? null,
});

export const edgeDecisionSubject = (finding) =>
  `${finding.file}:${finding.line}#${finding.id}`;

export const candidateHash = ({ kind, subject, rationaleDigest, targets, boundTo, projectRoot, policyId, policyDigest, requiredPrincipal }) =>
  createHash("sha256")
    .update(JSON.stringify({ kind, subject, rationaleDigest, targets, boundTo,
      ...(policyId === undefined ? {} : { projectRoot, policyId, policyDigest, requiredPrincipal }),
    }))
    .digest("hex");

/** The full digest the candidate id is the 20-hex prefix of. */
export const candidateDigestOf = (candidate) =>
  `sha256:${candidateHash(candidate)}`;

export const createDecisionCandidate = ({
  kind,
  subjectType,
  subjectPath,
  rationale,
  targets = [],
  boundTo,
}) => {
  const candidate = {
    kind,
    subject: { type: subjectType, path: subjectPath },
    rationaleDigest: decisionRationaleDigest(rationale),
    targets: [...new Set(targets)].sort(),
    boundTo,
  };
  return {
    id: `APP-${candidateHash(candidate).slice(0, 20)}`,
    ...candidate,
    rationale: String(rationale).replace(/\r\n/g, "\n").trim(),
  };
};

/**
 * New-format only. No caller-supplied policy, mode or capability is authority.
 *
 * `policyKind` exists for the one case where the kind under review is not the
 * kind the policy is about: a decision *group* is kind `GROUP_APPROVAL`, but
 * the authority it needs is its members' kind's authority. It selects a policy
 * row; it never supplies one.
 */
export const createNewFormatDecisionCandidate = async ({ projectRoot, policyKind, ...candidate }) => {
  const binding = await resolveRequiredPrincipal(policyKind ?? candidate.kind, projectRoot);
  const bound = { ...createDecisionCandidate(candidate), ...binding };
  return { ...bound, id: `APP-${candidateHash(bound).slice(0, 20)}` };
};

export const decisionGroupMemberFact = (candidate) => ({
  id: candidate.id,
  kind: candidate.kind,
  subject: candidate.subject,
  rationaleDigest: candidate.rationaleDigest,
  targets: [...(candidate.targets ?? [])],
  pathDigest: candidate.boundTo?.pathDigest ?? null,
});

export const DECISION_GROUP_KIND = "GROUP_APPROVAL";

export const DECISION_MODULE_BINDING = [
  "module",
  "legacyRevision",
  "legacyDirtyDigest",
  "discoveryDigest",
  "algorithmVersion",
];

/**
 * Which approvable candidates form the first homogeneous group, and the module
 * binding they share. One selection rule, used by both the legacy group and the
 * new-format one, so the two can never disagree about who the members are.
 */
export const groupMembersOf = (candidates) => {
  const approvable = candidates.filter((candidate) => candidate.approvable);
  const [first] = approvable;
  if (!first) return null;
  const binding = Object.fromEntries(
    DECISION_MODULE_BINDING.map((field) => [field, first.boundTo?.[field]]),
  );
  const members = approvable.filter(
    (candidate) =>
      candidate.kind === first.kind &&
      DECISION_MODULE_BINDING.every(
        (field) => candidate.boundTo?.[field] === binding[field],
      ),
  );
  return members.length < 2 ? null : { first, binding, members };
};

/** The candidate inputs a group is derived from, given its ordered facts. */
export const groupCandidateInput = ({ first, binding, lifecycle, facts }) => ({
  kind: DECISION_GROUP_KIND,
  subjectType: "DECISION_GROUP",
  subjectPath: `${first.kind}@${String(binding.discoveryDigest).replace(/^sha256:/, "").slice(0, 12)}`,
  rationale: facts
    .map(
      (fact, index) =>
        `${index + 1}. ${fact.id} ${fact.kind} ${fact.subject.path}` +
        (fact.pathDigest ? ` [${fact.pathDigest}]` : ""),
    )
    .join("\n"),
  targets: [],
  boundTo: {
    ...binding,
    groupKind: "DECISION_CANDIDATES",
    lifecycle,
    members: facts,
  },
});

/** One stable candidate representing the first homogeneous approvable group. */
export const decisionGroupFor = (candidates, lifecycle) => {
  const selection = groupMembersOf(candidates);
  if (!selection) return null;
  const group = createDecisionCandidate(
    groupCandidateInput({
      ...selection,
      lifecycle,
      facts: selection.members.map(decisionGroupMemberFact),
    }),
  );
  return {
    ...group,
    approvable: true,
    blockers: [],
    groupMembers: selection.members,
  };
};

/**
 * One reviewed group act, one authoritative ledger entry.
 *
 * The complete ordered member set is part of the group candidate's own digest,
 * and each fact carries that member's full evidence binding -- not just its
 * `APP-` id, which is a display identifier. So a reorder, an omission, an
 * addition or changed member evidence is a *different* candidate rather than
 * the same one with a detail moved, and a decision over the old one stops
 * applying. The group's required principal comes from its members' kind: a
 * batch of judgments is not a lesser act than one of them.
 */
export const createNewFormatDecisionGroup = async ({
  candidates,
  lifecycle,
  projectRoot,
}) => {
  const selection = groupMembersOf(candidates);
  if (!selection) return null;
  const group = await createNewFormatDecisionCandidate({
    projectRoot,
    policyKind: selection.first.kind,
    ...groupCandidateInput({
      ...selection,
      lifecycle,
      facts: selection.members.map((member) => ({
        ...decisionGroupMemberFact(member),
        boundTo: member.boundTo ?? null,
      })),
    }),
  });
  return {
    ...group,
    approvable: true,
    blockers: [],
    groupMembers: selection.members,
  };
};

/**
 * The one authoritative entry for a reviewed group act, or none.
 *
 * Two v2 lines over the same reviewed group -- a duplicate APPROVED, or an
 * APPROVED beside a REJECTED -- is an ambiguity, and an ambiguous decision is
 * not a decision. Picking the newest, the oldest or the first would be the
 * engine deciding, so this refuses instead. A member line cannot answer for the
 * group either: it would be a second line over the same digest and fail here
 * too.
 */
export const resolveGroupDecision = (decisions, candidate) => {
  if (candidate?.kind !== DECISION_GROUP_KIND) {
    throw new Error(
      `resolveGroupDecision takes a ${DECISION_GROUP_KIND} candidate, not '${candidate?.kind}'.`,
    );
  }
  const digest = candidateDigestOf(candidate);
  const matching = decisions.filter(
    (decision) => decision?.v === 2 && decision.candidateDigest === digest,
  );
  if (matching.length > 1) {
    throw new Error(
      `Decision group '${candidate.id}' has ${matching.length} ledger entries (${matching
        .map((decision) => `${decision.id} ${decision.result}`)
        .join(", ")}). Duplicate or conflicting group outcomes fail closed; nothing is authoritative until the record is repaired.`,
    );
  }
  const [decision] = matching;
  return {
    decision: decision ?? null,
    result: decision?.result ?? null,
    applicable: Boolean(
      decision && decisionAppliesToCandidate(decision, candidate),
    ),
  };
};

export const decisionAppliesToCandidate = (decision, candidate) =>
  Boolean(decision && candidate) &&
  // A policy-bound candidate cannot shed one field and fall back to legacy.
  ((candidate.policyId === undefined && candidate.policyDigest === undefined &&
    candidate.requiredPrincipal === undefined) ||
    (typeof candidate.projectRoot === "string" && path.isAbsolute(candidate.projectRoot) &&
      candidate.policyId !== undefined && candidate.policyDigest !== undefined &&
      candidate.requiredPrincipal !== undefined && decision.v === 2 &&
      candidate.id === `APP-${candidateHash(candidate).slice(0, 20)}` &&
      decision.policyId === candidate.policyId &&
      decision.policyDigest === candidate.policyDigest &&
      principalSatisfiesRequirement(decision.principal, candidate.requiredPrincipal))) &&
  // A v2 line applies only as an explicit APPROVED over the full candidate
  // digest. REJECTED is never an approval. For a policy-bound candidate, the
  // required principal and pinned policy are also checked above.
  (decision.v !== 2 ||
    (decision.result === "APPROVED" &&
      decision.candidateDigest === candidateDigestOf(candidate))) &&
  decision.candidateId === candidate.id &&
  decision.kind === candidate.kind &&
  decision.subject?.type === candidate.subject.type &&
  decision.subject?.path === candidate.subject.path &&
  JSON.stringify(decision.targets ?? []) ===
    JSON.stringify(candidate.targets) &&
  decision.rationaleDigest === candidate.rationaleDigest &&
  [
    "module",
    "legacyRevision",
    "legacyDirtyDigest",
    "discoveryDigest",
    "algorithmVersion",
  ].every((field) => decision.boundTo?.[field] === candidate.boundTo[field]);

export const DECISION_KINDS = [
  "EXCLUSION",
  "DEAD_CONFIRMATION",
  "EDGE_RESOLUTION",
  "ROOT_DECLARATION",
  // W4-4. Some target drift is legitimate and unforeseeable -- a lockfile a
  // package manager regenerated, a formatter run. It routes through this
  // recorder like every other operator act, under the same challenge phrase and
  // the same module lock. Never a CLI flag: a flag nobody has to think about is
  // exactly what turns a security boundary into a formality.
  "TARGET_DRIFT_ACCEPTED",
  // Format 17. A required visual state no COMPLETE Figma evidence designs may
  // be left without visual acceptance only by an operator, bound to the Figma
  // context and visual contract the operator was shown.
  "VISUAL_UNBACKED",
];

// An artifact operator decision reuses the module candidate shape verbatim, so
// the module ledger reader, candidate hash, and challenge all apply unchanged.
// The binding maps: module=artifactId, legacy revision/dirty from the source
// binding, discoveryDigest=the source manifest digest.
export const artifactDecisionBoundTo = (state) => ({
  module: state.artifactId,
  legacyRevision: state.bindings.source.revision,
  legacyDirtyDigest: state.bindings.source.dirtyDigest,
  discoveryDigest: state.bindings.source.digest,
  algorithmVersion: ARTIFACT_WORKFLOW_VERSION,
});

export const artifactDecisionCandidate = (state, row) =>
  createDecisionCandidate({
    kind: "ARTIFACT_DECISION",
    subjectType: "ARTIFACT_DECISION",
    subjectPath: row.id,
    rationale: row.subject,
    targets: [],
    boundTo: artifactDecisionBoundTo(state),
  });

export const artifactCandidateEvidence = (state, inventory) => ({
  ...artifactDecisionBoundTo(state),
  artifactId: state.artifactId,
  formatVersion: state.formatVersion,
  status: state.status,
  currentStep: state.currentStep,
  revision: state.revision,
  source: state.source,
  target: state.target,
  sourceBinding: state.bindings.source,
  targetBinding: state.bindings.target,
  artifactHashes: state.artifactHashes,
  sourceInventoryDigest: `sha256:${sha256(canonical(inventory))}`,
});
