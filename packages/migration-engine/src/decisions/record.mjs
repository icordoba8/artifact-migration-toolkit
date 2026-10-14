/**
 * Decisions: recording. Channels and challenges, review rendering, the answer
 * half of the approval gate and the locked-equality rule, ledger lines and
 * appends, the read-only ledger audit, explicit relay, and the module and
 * artifact decision derivations over facts the orchestration seams supply.
 * The module lock, the recompute and the toolkit-identity gate stay with the
 * seams in `record-decision.mjs`; nothing here reads census, slice or visual
 * state.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AUTO_DECISIONS_FILE,
  DECISIONS_FILE,
  LEGACY_COMPATIBILITY_ACTION_REQUIRED,
  usesArtifactDirectLedger,
  usesDirectLedgerDecisions,
} from "../formats/index.mjs";
import {
  assertArray as arrayOf,
  assertNonEmpty as nonEmpty,
  assertSecurePath,
  canonicalJson as canonical,
  exactObject,
  sha256Hex as sha256,
  unique,
} from "../shared/index.mjs";
import {
  projectArtifactDecision,
  projectModuleDecision,
  readAutoDecisions,
  readOperatorDecisions,
  readRecordedDecisions,
} from "./authority.mjs";
import {
  artifactCandidateEvidence,
  artifactDecisionCandidate,
  candidateDigestOf,
  createDecisionCandidate,
  createNewFormatDecisionCandidate,
  createNewFormatDecisionGroup,
  DECISION_GROUP_KIND,
  decisionAppliesToCandidate,
  decisionGroupFor,
  decisionKindAllowed,
  decisionLineDigest,
  decisionRationaleDigest,
  edgeDecisionSubject,
  LATE_DECISION_KINDS,
  lifecycleBinding,
} from "./candidate.mjs";
import {
  attestationVerifierScope,
  attestedLineProblem,
  decisionChannelOf,
  decisionLineProblem,
} from "./policy.mjs";

/**
 * A challenge derived from the subject, so approving is a deliberate act about
 * one specific thing. `y` approves anything; this approves this.
 */
export const challengeFor = (candidate) =>
  `APPROVE ${candidate.id} ${candidate.kind} ${candidate.subject.path}`;

/**
 * The three principals that can answer a challenge, named once. `TERMINAL` is a
 * human at a TTY, `ELICITATION` a human reached through the host, and `AUTO`
 * the engine itself running under `--mode auto`.
 *
 * `AUTO` is a declared principal, not a forged human. The distinction is the
 * whole point of naming it: the ledger line says which one decided, so an
 * unattended run is auditable as an unattended run rather than being
 * indistinguishable from someone typing. The gate it passes through is the same
 * one -- `answer.trim() === challenge` -- and so is every digest that binds the
 * line to the bytes it approved.
 */
export const APPROVAL_CHANNELS = Object.freeze(["TERMINAL", "ELICITATION", "AUTO"]);

export const channelOf = (ask) =>
  ask ? (ask.channel ?? "ELICITATION") : "TERMINAL";

/**
 * An `ask` that answers on the engine's own authority. It is a real answerer
 * held to the real comparison -- it returns the challenge it was handed, and
 * `withOperatorApproval` compares it exactly as it compares a typed one -- so
 * no gate is short-circuited; only the principal differs, and the principal is
 * recorded.
 *
 * `reason` names the evidence the engine decided from and is carried into the
 * decision's rationale, so an `AUTO` line is never just an assertion that the
 * engine felt like it.
 */
export const autoApprovalChannel = (reason) =>
  Object.assign(({ challenge }) => challenge, { channel: "AUTO", reason });

/**
 * Offer == accept for the AUTO principal: the one predicate the AUTO gate in
 * `withOperatorApproval` refuses on, and the one `approveWithOperator` offers
 * by. A group is one act over its members, so one member whose question is
 * underivable makes the whole group a human decision.
 */
export const autoMayDecide = (candidate) =>
  candidate.autoResolvable !== false &&
  !(candidate.groupMembers ?? []).some((member) => member.autoResolvable === false);

/**
 * Who the recorded statement names. An AUTO line never says "operator": the
 * whole guarantee is that an unattended decision reads as an unattended
 * decision, in the ledger, in the sentence, and in the id.
 */
export const approvedByPhrase = (ask) =>
  channelOf(ask) === "AUTO" ? "by the AUTO principal" : "by operator";

export const APPROVAL_EVIDENCE = (ask) =>
  ({
    TERMINAL: "at a terminal",
    ELICITATION:
      "through a host-originated approval request answered with the candidate confirmation phrase",
    AUTO: "on the engine's own authority under --mode auto, from repository evidence",
  })[channelOf(ask)];

export const GROUP_APPROVAL_EVIDENCE = (ask) =>
  ({
    TERMINAL: "through one group confirmation phrase typed at a terminal",
    ELICITATION:
      "through one host-originated approval request answered with the group confirmation phrase",
    AUTO: "on the engine's own authority under --mode auto, from repository evidence covering the whole group",
  })[channelOf(ask)];

export const APPROVAL_EVIDENCE_PHRASES = APPROVAL_CHANNELS.flatMap((channel) => {
  const ask = channel === "TERMINAL" ? null : { channel };
  return [APPROVAL_EVIDENCE(ask), GROUP_APPROVAL_EVIDENCE(ask)];
});

export const operatorIdentity = () =>
  `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`;

/**
 * The rationale digest binds an approval to the exact bytes it approves, so an
 * agent cannot rewrite the justification under an already-granted approval.
 * Normalized for line endings only -- a CRLF checkout is not a new rationale.
 */
export const rationaleDigestOf = decisionRationaleDigest;

// The local recorder never substitutes for the optional protected signer.
export const SIGNER_UNAVAILABLE = "SIGNER_UNAVAILABLE";

export const blockedFor = (candidate) => candidate.requiredPrincipal === "AGENT_RELAYED"
  ? null
  : candidate.requiredPrincipal === "HUMAN_ATTESTED"
    ? { state: SIGNER_UNAVAILABLE, requiredPrincipal: candidate.requiredPrincipal,
        reason: "No trusted signer or review companion is available; no host interaction can attest this decision." }
    : { state: "AUTO_DECISION_UNAVAILABLE", requiredPrincipal: candidate.requiredPrincipal,
        reason: "No engine-owned automatic decision exists for this judgment; a host cannot supply one." };

export const REVIEW_EFFECTS = {
  EXCLUSION: "Authorize the proposed exclusion of this legacy file.",
  DEAD_CONFIRMATION: "Authorize the proposed DEAD disposition of this legacy file.",
  EDGE_RESOLUTION: "Authorize the proposed resolution of this module edge to the listed targets.",
  ROOT_DECLARATION: "Authorize the proposed additional module root.",
  TARGET_DRIFT_ACCEPTED: "Authorize acceptance of the currently observed target drift.",
  VISUAL_UNBACKED: "Authorize the proposed visual-unbacked exception for this subject.",
};

/** Review data comes only from the already derived, policy-bound candidate. */
export const reviewFor = (candidate) => ({
  candidateId: candidate.id,
  title: candidate.kind === DECISION_GROUP_KIND
    ? `Review one ${candidate.groupMembers.length}-member ${candidate.groupMembers[0].kind} decision group`
    : `Review ${candidate.kind} for ${candidate.subject.path}`,
  kind: candidate.kind,
  migration: candidate.boundTo.module,
  worktree: candidate.projectRoot,
  subject: candidate.subject,
  why: candidate.kind === DECISION_GROUP_KIND
    ? "Each ordered member requires operator judgment; this is one indivisible decision."
    : "The proposed disposition requires operator judgment over the current evidence.",
  approveEffect: `${candidate.kind === DECISION_GROUP_KIND
    ? "Authorize the complete ordered member set below as one act."
    : REVIEW_EFFECTS[candidate.kind] ?? "Authorize only this proposed decision."} This records authority only; it neither changes files nor advances a checkpoint, and other validation must still pass.`,
  rejectEffect: "Record a candidate-bound REJECTED outcome that blocks this decision until its evidence changes; cancel or host decline records nothing.",
  targets: candidate.kind === DECISION_GROUP_KIND
    ? [...new Set(candidate.groupMembers.flatMap((member) => member.targets))]
    : candidate.targets,
  rationale: candidate.rationale,
  evidence: candidate.boundTo,
  policy: {
    requiredPrincipal: candidate.requiredPrincipal,
    policyId: candidate.policyId,
    policyDigest: candidate.policyDigest,
  },
  candidateDigest: candidateDigestOf(candidate),
  members: candidate.groupMembers?.map((member) => ({
    id: member.id, kind: member.kind, subject: member.subject,
    targets: member.targets, rationale: member.rationale,
    rationaleDigest: member.rationaleDigest, evidence: member.boundTo,
    candidateDigest: candidateDigestOf(member),
  })) ?? [],
});

// Single-line by construction: authored text can never start a new review line.
export const inertText = (value) => String(value).replace(
  /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
);

export const indentReview = (value) => String(value).split("\n").map((line) => `    ${inertText(line)}`).join("\n");

export const renderEvidence = (value, indent = "  ") =>
  Object.entries(value ?? {}).map(([name, field]) =>
    field && typeof field === "object"
      ? `${indent}${inertText(name)}:\n${renderEvidence(field, `${indent}  `)}`
      : `${indent}${inertText(name)}: ${JSON.stringify(field)}\n`,
  ).join("");

export const renderDecisionReview = (review) =>
  `${inertText(review.title)}\nMigration: ${inertText(review.migration)}\nWorktree: ${inertText(review.worktree)}\n` +
  `Candidate: ${inertText(review.candidateId)}\n` +
  `Subject: ${inertText(review.subject.type)} ${inertText(review.subject.path)}\nWhy: ${review.why}\n` +
  `Approve: ${review.approveEffect}\nReject: ${review.rejectEffect}\n` +
  `Targets: ${review.targets.map(inertText).join(", ") || "none"}\n` +
  `Rationale (untrusted proposal):\n${indentReview(review.rationale)}\n` +
  `Evidence/provenance (inert data):\n${renderEvidence(review.evidence)}` +
  `Required principal: ${review.policy.requiredPrincipal}\n` +
  `Trusted policy: ${inertText(review.policy.policyId)} / ${inertText(review.policy.policyDigest)}\n` +
  `Candidate digest: ${review.candidateDigest}\n` +
  (review.members.length ? `Ordered group members:\n${review.members.map((member, index) =>
    `${index + 1}. ${inertText(member.id)} ${inertText(member.kind)} ${inertText(member.subject.type)} ${inertText(member.subject.path)}\n` +
    `   Targets: ${member.targets.map(inertText).join(", ") || "none"}\n` +
    `   Rationale (untrusted proposal):\n${indentReview(member.rationale)}\n` +
    `   Evidence/provenance (inert data):\n${renderEvidence(member.evidence, "     ")}` +
    `   Candidate digest: ${member.candidateDigest}\n`).join("")}` : "");

export const buildDecision = ({
  previous,
  kind,
  subjectType,
  subject,
  statement,
  rationale,
  boundTo,
  candidateId,
  targets,
  authorizedBy,
  at = new Date().toISOString(),
  operator = operatorIdentity(),
  // `AUTO-` for the AUTO principal's own ledger. The prefix is the point: the
  // two ledgers number independently, so without it both would mint `DEC-001`
  // and a citation would resolve to whichever file was read first. It also
  // means no AUTO decision can ever be read as a human one -- not in a state
  // row, not in a history event, not by eye.
  idPrefix = "DEC",
  // Schema v2. Absent all v2 fields, the line is today's legacy shape byte for
  // byte. Present, the line is written only as AGENT_RELAYED: a terminal or
  // host-relayed answer is never HUMAN_ATTESTED, and AUTO keeps its own shape.
  principal,
  result,
  candidateDigest,
  policyId,
  policyDigest,
}) => {
  const seq = (previous?.seq ?? 0) + 1;
  const line = {
    id: `${idPrefix}-${String(seq).padStart(3, "0")}`,
    seq,
    prevDigest: previous ? decisionLineDigest(previous) : "genesis",
    at,
    operator,
    kind,
    subject: { type: subjectType, path: subject },
    statement,
    rationaleDigest: rationaleDigestOf(rationale),
    ...(candidateId ? { candidateId } : {}),
    ...(targets ? { targets: [...targets] } : {}),
    boundTo,
    ...(authorizedBy ? { authorizedBy } : {}),
  };
  if (principal === undefined && result === undefined && candidateDigest === undefined &&
      policyId === undefined && policyDigest === undefined) {
    return line;
  }
  const v2 = { v: 2, ...line, principal, result, candidateDigest,
    ...(policyId === undefined && policyDigest === undefined ? {} : { policyId, policyDigest }),
  };
  const problem =
    principal !== "AGENT_RELAYED" || idPrefix !== "DEC"
      ? `names principal ${JSON.stringify(principal)}, which is not writable; only AGENT_RELAYED v2 lines in ${DECISIONS_FILE} are`
      : !candidateId
        ? "carries no candidateId"
        : decisionLineProblem(v2);
  if (problem) {
    throw new Error(`Refusing to build a v2 decision line that ${problem}.`);
  }
  return v2;
};

/**
 * Which checkpoint the decisions currently in question are consumed by, and
 * whether it has closed. Separate from any decision state on purpose: a
 * recorded approval is `APPROVED_APPLICABLE` the instant it is appended, with
 * `state.json` untouched and this `false`. Conflating the two is what made
 * "approved" and "advanced" indistinguishable and sent callers looking for a
 * restart.
 */
export const decisionCheckpoint = (state) => {
  const completed = state.completedSteps ?? [];
  const step = completed.includes("DISCOVERY_COMPLETENESS")
    ? "FINALIZE"
    : "DISCOVERY_COMPLETENESS";
  return { checkpoint: step, checkpointAdvanced: completed.includes(step) };
};

/** Overall state: the worst thing standing between the record and its gate. */
export const PROJECTION_PRECEDENCE = ["REJECTED", "STALE", "AWAITING_HUMAN_DECISION"];

export const decisionProjection = ({ state, directLedger, projected, candidates }) => {
  const states = new Set(projected.map((entry) => entry.state));
  // A derived candidate nobody has decided yet is awaiting one even when its
  // own blockers make it unapprovable: the gate is not clear either way.
  if (candidates.length > 0) states.add("AWAITING_HUMAN_DECISION");
  return {
    directLedger,
    ...decisionCheckpoint(state),
    state:
      PROJECTION_PRECEDENCE.find((value) => states.has(value)) ??
      "READY_TO_ADVANCE",
    candidates: projected,
    ...(directLedger ? { blocked: candidates.find((entry) => entry.blocked)?.blocked ?? null } : {}),
  };
};

/**
 * Which ledger a line belongs in, decided from the line itself and nowhere
 * else. `--mode auto` never reaches the human record: not by a caller passing a
 * path, not by a flag, not by an option combination. There is one expression
 * that maps principal to file and this is it.
 */
export const ledgerFileForChannel = (channel) =>
  channel === "AUTO" ? AUTO_DECISIONS_FILE : DECISIONS_FILE;

export const appendDecisions = async (locked, decisions, stdout) => {
  if (locked.recordKind !== "artifact" && decisions.some((decision) =>
    !decisionKindAllowed(decision.kind, (locked.state.completedSteps ?? []).includes("DISCOVERY_COMPLETENESS")))) {
    throw new Error("Only post-census decision kinds may be recorded after DISCOVERY_COMPLETENESS closed. Nothing was written.");
  }
  const channels = new Set(decisions.map((decision) => decisionChannelOf(decision)));
  if (channels.size > 1) {
    throw new Error(
      `One append may not mix decision principals (${[...channels].sort().join(", ")}); each ledger is one principal's append-only chain.`,
    );
  }
  const file = await assertSecurePath(
    locked.targetRoot,
    path.join(locked.root, ledgerFileForChannel([...channels][0])),
  );
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(
    file,
    decisions.map((decision) => `${JSON.stringify(decision)}\n`).join(""),
    { flag: "a", mode: 0o600 },
  );
  for (const decision of decisions) {
    stdout.write(
      `Recorded ${decision.id} (${decision.kind}) for ${decision.subject.path}.\n`,
    );
  }
};

export const groupFactsDigest = (facts) =>
  decisionRationaleDigest(JSON.stringify(facts));

/**
 * The head of the chain this principal extends, and the prefix its ids take.
 * Two ledgers, two independent chains; neither ever reads the other's head, so
 * an AUTO append cannot renumber the human record or vice versa.
 */
export const ledgerHeadFor = async (root, channel) => {
  const auto = channel === "AUTO";
  const { decisions } = auto
    ? await readAutoDecisions(root)
    : await readOperatorDecisions(root);
  return { previous: decisions.at(-1) ?? null, idPrefix: auto ? "AUTO" : "DEC" };
};

/**
 * What an AUTO line must carry: the principal, the decision type, the evidence
 * it was decided from, the scope it covers, and the result. Plus the identity
 * of the build that decided, so provenance names a release and not just "the
 * engine".
 *
 * `undefined` for a human single decision, which keeps today's line shape byte
 * for byte -- `buildDecision` drops an absent `authorizedBy`, so no existing
 * record's digests move. A human *group* decision keeps its own existing
 * `authorizedBy`; this is only the single-decision path.
 *
 * `toolkit` is the running build's identity. Decisions reads no build identity
 * off disk; the recording seam reads it under the lock when AUTO answered.
 */
export const autoAuthorization = (ask, candidate, toolkit) =>
  channelOf(ask) === "AUTO"
    ? {
        v: 1,
        principal: "AUTO",
        channel: "AUTO",
        decisionType: candidate.kind,
        evidence: ask.reason,
        toolkit,
        scope: {
          module: candidate.boundTo?.module ?? null,
          subject: candidate.subject,
          targets: [...(candidate.targets ?? [])],
        },
        result: "APPROVED",
        approvedAt: new Date().toISOString(),
      }
    : undefined;

export const appendGroupDecisions = async ({ group, locked, ask, stdout }) => {
  const facts = group.boundTo.members;
  const groupDigest = groupFactsDigest(facts);
  const approvedAt = new Date().toISOString();
  const { previous: head, idPrefix } = await ledgerHeadFor(
    locked.root,
    channelOf(ask),
  );
  let previous = head;
  const written = group.groupMembers.map((member, index) => {
    const decision = buildDecision({
      previous,
      idPrefix,
      kind: member.kind,
      subjectType: member.subject.type,
      subject: member.subject.path,
      statement: `Approved stable candidate ${member.id} ${approvedByPhrase(ask)} ${GROUP_APPROVAL_EVIDENCE(ask)}.`,
      rationale: member.rationale,
      candidateId: member.id,
      targets: member.targets,
      boundTo: member.boundTo,
      authorizedBy: {
        v: 1,
        groupId: group.id,
        groupDigest,
        members: facts.length,
        index: index + 1,
        channel: channelOf(ask),
        // AUTO adds its provenance to what the group act already records; a
        // human group line keeps exactly the fields it has always had.
        // `approvedAt` last: one group act has one timestamp, whoever made it.
        ...(autoAuthorization(ask, member, locked.toolkit) ?? {}),
        approvedAt,
      },
    });
    previous = decision;
    return decision;
  });
  await appendDecisions(locked, written, stdout);
  return { decisions: written, group: group.id };
};

/**
 * The new-format group append: one reviewed group act, one v2 ledger line.
 *
 * Not one line per member. The complete ordered member set, with each member's
 * own evidence binding, is inside `boundTo.members`, and `boundTo.members` is
 * inside the `candidateDigest` this line names -- so the one line *is* the
 * whole group, and there is exactly one result, one principal, one policy
 * binding and one decision identity for it.
 *
 * That is what makes the append crash-atomic. A torn write leaves an
 * unparseable or newline-less last line, which the ledger reader refuses
 * whole, so the interrupted group is simply absent: there is no subset of it
 * left behind to become authority. The legacy N-line group had no such
 * property, which is why it stays behind its own gate rather than being
 * rewritten.
 */
export const appendNewFormatGroupDecision = async ({ group, locked, ask, stdout, result }) => {
  const candidateDigest = candidateDigestOf(group);
  // Under the lock, and before writing: a second line over the same reviewed
  // group would make its outcome ambiguous, and `resolveGroupDecision` would
  // then refuse the record. Refuse the write instead of creating that record.
  const { decisions } = await readRecordedDecisions(locked.root);
  const existing = decisions.find(
    (decision) => decision?.v === 2 && decision.candidateDigest === candidateDigest,
  );
  if (existing) {
    throw new Error(
      `Decision group '${group.id}' already has ledger entry ${existing.id} (${existing.result}). A second line over one reviewed group is a duplicate or a conflict, and both fail closed. Nothing was written.`,
    );
  }
  const { previous, idPrefix } = await ledgerHeadFor(
    locked.root,
    channelOf(ask),
  );
  const decision = buildDecision({
    previous,
    idPrefix,
    kind: group.kind,
    subjectType: group.subject.type,
    subject: group.subject.path,
    statement: `AGENT_RELAYED ${result} of decision group ${group.id} over ${group.boundTo.members.length} ${group.groupMembers[0].kind} candidate(s).`,
    rationale: group.rationale,
    candidateId: group.id,
    targets: group.targets,
    boundTo: group.boundTo,
    principal: "AGENT_RELAYED",
    result,
    candidateDigest,
    policyId: group.policyId,
    policyDigest: group.policyDigest,
  });
  await appendDecisions(locked, [decision], stdout);
  return { decisions: [decision], group: group.id };
};

export const assertReviewedCandidateCurrent = (selected, candidates) => {
  const current = candidates.find((candidate) => candidate.id === selected.id);
  if (!current || !current.approvable || JSON.stringify(current) !== JSON.stringify(selected)) {
    throw new Error(`Candidate '${selected.id}' changed while its review was open. Nothing was written.`);
  }
  return current;
};

/**
 * W2-5 / W6-3. The read-only record auditor. It takes no lock, opens no
 * transaction, and advances nothing: it answers "is this record internally
 * consistent" and nothing else.
 *
 * The audit must be answerable by a command, so this re-derives every
 * `prevDigest` itself rather than trusting
 * the chain the record claims, and reports the *first* break plus every line
 * whose recorded `statement` claims an evidence channel it is not entitled to.
 *
 * A line may only claim one of the two phrases `APPROVAL_EVIDENCE` can produce,
 * and either claim is falsifiable: both are only reachable through the single
 * gate in `approveCandidate`, and both require a candidate the engine derived,
 * so a line claiming a channel while carrying no `candidateId` or no complete
 * `boundTo` is describing evidence that cannot have existed.
 */
export const BOUND_TO_FIELDS = [
  "module",
  "legacyRevision",
  "legacyDirtyDigest",
  "discoveryDigest",
  "algorithmVersion",
];

export const auditDecisionLedger = (lines, verifiedAttested = new Set()) => {
  const findings = [];
  const groups = [];
  const v2Positions = new Map();
  let previous = null;
  let chainBrokenAt = null;
  lines.forEach((raw, index) => {
    const position = index + 1;
    let decision;
    try {
      decision = JSON.parse(raw);
    } catch (error) {
      if (chainBrokenAt === null) chainBrokenAt = position;
      findings.push({
        position,
        code: "UNPARSEABLE",
        detail: error.message,
      });
      return;
    }
    const expectedPrev = previous ? decisionLineDigest(previous) : "genesis";
    if (decision.prevDigest !== expectedPrev) {
      if (chainBrokenAt === null) chainBrokenAt = position;
      findings.push({
        position,
        id: decision.id ?? null,
        code: "CHAIN_BROKEN",
        detail: `chains to '${decision.prevDigest}', but the preceding line digests to '${expectedPrev}'`,
      });
    }
    if (decision.seq !== position) {
      findings.push({
        position,
        id: decision.id ?? null,
        code: "SEQ_MISMATCH",
        detail: `records seq ${decision.seq} at position ${position}`,
      });
    }
    const missingBinding = () => [
      ...(decision.candidateId ? [] : ["candidateId"]),
      ...BOUND_TO_FIELDS.filter(
        (field) => decision.boundTo?.[field] === undefined,
      ).map((field) => `boundTo.${field}`),
    ];
    // An attested line is consistent only after protected replay verification.
    const problem = verifiedAttested.has(position) ? null : decisionLineProblem(decision);
    if (problem) {
      findings.push({
        position,
        id: decision.id ?? null,
        code: "INVALID_DECISION_PRINCIPAL",
        detail: problem,
      });
    }
    // A v2 line's authority is its explicit principal/result/candidateDigest;
    // its statement is description only. A legacy line has only its statement.
    if (decision?.v === 2) {
      const missing = missingBinding();
      if (missing.length > 0) {
        findings.push({
          position,
          id: decision.id ?? null,
          code: "UNBOUND_EVIDENCE_CLAIM",
          detail: `records ${decision.principal} ${decision.result} but carries no ${missing.join(", ")}`,
        });
      }
      // One reviewed group act -- its whole ordered member set -- has one
      // outcome. A second line over the same group digest is a duplicate or a
      // conflict, and the auditor names it rather than leaving a resolver to
      // discover it. Single candidates keep their own resolution rules.
      if (decision.kind === DECISION_GROUP_KIND) {
        const first = v2Positions.get(decision.candidateDigest);
        if (first === undefined) {
          v2Positions.set(decision.candidateDigest, position);
        } else {
          findings.push({
            position,
            id: decision.id ?? null,
            code: "AMBIGUOUS_DECISION",
            detail: `records ${decision.result} over the group digest already decided at line ${first}; duplicate or conflicting group outcomes fail closed`,
          });
        }
      }
      previous = decision;
      return;
    }
    const statement = String(decision.statement ?? "");
    const claimed = APPROVAL_EVIDENCE_PHRASES.find((phrase) =>
      statement.includes(phrase),
    );
    if (!claimed) {
      findings.push({
        position,
        id: decision.id ?? null,
        code: "UNRECOGNISED_EVIDENCE_CHANNEL",
        detail: `statement names no channel the recorder can produce: ${JSON.stringify(statement)}`,
      });
    } else {
      const missing = missingBinding();
      if (missing.length > 0) {
        findings.push({
          position,
          id: decision.id ?? null,
          code: "UNBOUND_EVIDENCE_CLAIM",
          detail: `claims "${claimed}" but carries no ${missing.join(", ")}; the channel it names can only produce a line bound to a derived candidate`,
        });
      }
    }
    // `groupId`, not merely `authorizedBy`: an AUTO single decision carries an
    // authorization block too, and it is not a group of one.
    if (decision.authorizedBy?.groupId) groups.push({ position, decision });
    previous = decision;
  });
  findings.push(...groupFindings(groups));
  return {
    lines: lines.length,
    chainBrokenAt,
    findings,
    outcome: findings.length === 0 ? "CONSISTENT" : "INCONSISTENT",
  };
};

export const groupFindings = (grouped) => {
  const findings = [];
  const byGroup = new Map();
  for (const entry of grouped) {
    const groupId = entry.decision.authorizedBy?.groupId ?? "(none)";
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push(entry);
  }
  for (const [groupId, entries] of byGroup) {
    const first = entries[0];
    const authorization = first.decision.authorizedBy;
    const sameAuthorization = entries.every(({ decision }) =>
      ["v", "groupId", "groupDigest", "members", "channel", "approvedAt"].every(
        (field) => decision.authorizedBy?.[field] === authorization[field],
      ),
    );
    const contiguous =
      Number.isInteger(authorization.members) &&
      authorization.members > 1 &&
      entries.length === authorization.members &&
      entries.every(
        (entry, offset) =>
          entry.position === first.position + offset &&
          entry.decision.authorizedBy?.index === offset + 1,
      );
    if (!sameAuthorization || !contiguous) {
      findings.push({
        position: first.position,
        id: first.decision.id ?? null,
        code: "GROUP_INCOMPLETE",
        detail: `group '${groupId}' is not one contiguous, consistently authorized ${authorization.members}-member append`,
      });
      continue;
    }
    const facts = entries.map(({ decision }) => ({
      id: decision.candidateId,
      kind: decision.kind,
      subject: {
        type: decision.subject?.type,
        path: decision.subject?.path,
      },
      rationaleDigest: decision.rationaleDigest,
      targets: [...(decision.targets ?? [])],
      pathDigest: decision.boundTo?.pathDigest ?? null,
    }));
    const rebuilt = groupFactsDigest(facts);
    if (authorization.v !== 1 || rebuilt !== authorization.groupDigest) {
      findings.push({
        position: first.position,
        id: first.decision.id ?? null,
        code: "GROUP_BINDING_MISMATCH",
        detail: `group '${groupId}' claims ${authorization.groupDigest}, but its ordered member lines re-derive to ${rebuilt}`,
      });
    }
  }
  return findings;
};

/**
 * The ledger audit plus the two anchors `integrity.json` pins outside
 * `state.json`. Reading them here rather than through `readState` is
 * deliberate: `--verify` must be able to report a record that `readState`
 * would refuse to open at all.
 */
export const verifyRecord = async (root) => {
  const linesOf = async (file) =>
    (
      await readFile(path.join(root, file), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
    )
      .split("\n")
      .filter((line) => line.trim());
  // Both chains are audited, each against its own genesis. They are separate
  // records with separate principals, so a finding in one says nothing about
  // the other and merging them would only hide which is broken.
  const operatorLines = await linesOf(DECISIONS_FILE);
  const verifier = attestationVerifierScope.getStore();
  const verifiedAttested = new Set();
  for (const [index, raw] of operatorLines.entries()) {
    let decision;
    try { decision = JSON.parse(raw); } catch { continue; }
    if (!verifier || decision?.v !== 2 || decision.principal !== "HUMAN_ATTESTED" || attestedLineProblem(decision)) continue;
    try {
      await verifier.verifyDecisionLine(decision, path.join(root, DECISIONS_FILE));
      verifiedAttested.add(index + 1);
    } catch {
      // Left unverified: the audit reports it as an untrusted principal.
    }
  }
  const ledger = auditDecisionLedger(operatorLines, verifiedAttested);
  const autoLedger = auditDecisionLedger(await linesOf(AUTO_DECISIONS_FILE));

  const anchors = [];
  const integrity = await readFile(path.join(root, "integrity.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  for (const [name, file, anchor] of [
    ["history", "history/history.ndjson", integrity?.history],
    ["decisions", DECISIONS_FILE, integrity?.decisions],
    ["autoDecisions", AUTO_DECISIONS_FILE, integrity?.autoDecisions],
  ]) {
    if (!anchor) {
      anchors.push({ name, status: "UNANCHORED" });
      continue;
    }
    const content = await readFile(path.join(root, file)).catch((error) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    const prefix = content.subarray(0, anchor.bytes);
    const intact =
      content.length >= anchor.bytes &&
      createHash("sha256").update(prefix).digest("hex") === anchor.sha256;
    anchors.push({
      name,
      status: intact ? "INTACT" : "BROKEN",
      pinnedBytes: anchor.bytes,
      actualBytes: content.length,
      ...(intact ? {} : { detail: `${file} no longer contains the pinned prefix` }),
    });
  }

  const broken = anchors.filter((entry) => entry.status === "BROKEN");
  return {
    outcome:
      ledger.outcome === "CONSISTENT" &&
      autoLedger.outcome === "CONSISTENT" &&
      broken.length === 0
        ? "CONSISTENT"
        : "INCONSISTENT",
    ledger,
    autoLedger,
    anchors,
  };
};

/** Opaque handle for one engine review; any candidate, evidence or policy change yields another. */
export const reviewReference = (review) =>
  `review-${createHash("sha256").update(JSON.stringify(review)).digest("hex").slice(0, 32)}`;

export const renderGroupBlock = (group) =>
  `  One approval covers all ${group.boundTo.members.length}:\n` +
  `  ${group.id}  ${group.kind}  ${group.subject.path}\n` +
  group.boundTo.members
    .map(
      (member, index) =>
        `    ${index + 1}. ${member.id}  ${member.kind}  ` +
        `${member.subject.type} ${member.subject.path}` +
        `${member.pathDigest ? `  ${member.pathDigest}` : ""}\n`,
    )
    .join("") +
  "\n";

export const renderCandidateBlock = (candidates, group = null) =>
  `Operator approval required: ${candidates.length} candidate(s). ` +
  `No approval can be recorded here.\n\n` +
  (group ? renderGroupBlock(group) : "") +
  candidates
    .map(
      (candidate) =>
        `  ${candidate.id}  ${candidate.kind}  ` +
        `${candidate.subject.type} ${candidate.subject.path}\n` +
        `    ${candidate.command}\n`,
    )
    .join("") +
  "\n";

/**
 * The module's pending decisions and its decision projection, constructed from
 * supplied facts (Track A3, Phase 0 option (b)).
 *
 * Decisions reads no census, slice or visual module: the orchestration seam in
 * `record-decision.mjs` reads the record, the classification, the current scan,
 * the legacy source binding, both verified ledgers, the unclaimed target drift
 * and the unbacked visual states, and hands them over as data. Everything that
 * turns those facts into authority -- candidate identity, policy binding,
 * kind eligibility, grouping, offer == accept and the projection -- is here.
 * `approveCommand` only renders the legacy `--approve` hint.
 */
export const deriveModuleDecisions = async ({
  module,
  projectRoot,
  root,
  state,
  classification,
  scan,
  legacySource,
  implicitRoots = new Set(),
  ledger: { decisions, byId },
  targetDrift,
  visualUnbacked,
  approveCommand,
}) => {
  // Which decision format this record derives is read off the persisted record,
  // not chosen by the caller: an argument could otherwise ask for new-format
  // candidates over an 18 record, or legacy ones over a 19, and the "pending"
  // answer would stop meaning the same thing as the gate's.
  const directLedger = usesDirectLedgerDecisions(state);
  const boundTo = {
    module,
    ...legacySource,
    discoveryDigest: scan.discoveryDigest,
    algorithmVersion: scan.algorithmVersion,
  };
  const candidates = [];
  const censusClosed = (state.completedSteps ?? []).includes("DISCOVERY_COMPLETENESS");
  // Ledger-backed receipts for candidates that are already approved but not yet
  // cited. An approval recorded at a terminal is otherwise invisible to the next
  // iteration: the candidate stops pending, and the agent has no way to learn
  // the `decisionId`/`decisionDigest` the classification must carry short of the
  // operator reading them out of a file. Derived, never authored -- each one is
  // a line that `decisionAppliesToCandidate` already bound to a live candidate.
  const references = [];
  // Every derived candidate with its projected state, including the ones that
  // are no longer pending. `candidates` is what still needs an operator;
  // `projected` is what the record's decision gate currently says, which is the
  // thing status, pending and run have to agree on.
  const projected = [];
  const addCandidate = async ({
    kind,
    subjectType,
    subjectPath,
    rationale,
    targets = [],
    decisionId,
    blockers = [],
    boundToOverride,
    // Default true: a candidate the engine derived from evidence it holds is
    // resolvable by the principal running the engine. Only a candidate whose
    // *question* is underivable -- today, drift with no ownership to read --
    // opts out, and it opts out of AUTO alone; a human can still decide it.
    autoResolvable = true,
  }) => {
    if (!decisionKindAllowed(kind, censusClosed)) return;
    const input = {
      kind,
      subjectType,
      subjectPath,
      rationale: rationale ?? "",
      targets,
      boundTo: boundToOverride ?? boundTo,
    };
    const candidate = directLedger
      ? await createNewFormatDecisionCandidate({
          projectRoot,
          ...input,
        })
      : createDecisionCandidate(input);
    const allBlockers = [...blockers];
    if (!String(rationale ?? "").trim()) {
      allBlockers.push("The classification has no operator-reviewable rationale.");
    }
    const pending = {
      ...candidate,
      approvable: allBlockers.length === 0,
      autoResolvable,
      blockers: allBlockers,
      ...(directLedger ? {
        review: reviewFor(candidate),
        blocked: blockedFor(candidate),
      } : { command: approveCommand(candidate.id) }),
    };
    if (directLedger) {
      // One resolver, reported rather than thrown. No receipt is consulted: the
      // row's `decisionId` is not even read here, because a format-19 record
      // must not carry one and authority comes from the ledger line bound to
      // this candidate's current digest.
      const view = await projectModuleDecision({
        decisions,
        candidate,
        label: `Candidate '${candidate.id}' (${kind} ${subjectPath})`,
      });
      projected.push({
        id: candidate.id,
        kind: candidate.kind,
        subject: candidate.subject,
        approvable: pending.approvable,
        blockers: allBlockers,
        review: pending.review,
        blocked: pending.blocked,
        ...view,
      });
      // An applicable approval and a candidate-bound rejection are both decided:
      // neither is waiting on an operator. A stale line is not -- the facts moved
      // and the question is open again -- so it stays pending, with the staleness
      // visible in the projection beside it.
      if (view.state === "APPROVED_APPLICABLE" || view.state === "REJECTED") return;
      candidates.push(pending);
      return;
    }
    const applied = [byId.get(decisionId), ...decisions].find((decision) =>
      decisionAppliesToCandidate(decision, candidate),
    );
    if (applied) {
      references.push({
        candidateId: candidate.id,
        subject: candidate.subject,
        decisionId: applied.id,
        decisionDigest: decisionLineDigest(applied),
      });
      projected.push({
        id: candidate.id,
        kind: candidate.kind,
        subject: candidate.subject,
        approvable: true,
        blockers: [],
        state: "APPROVED_APPLICABLE",
        reason: null,
        decisionId: applied.id,
        decisionDigest: decisionLineDigest(applied),
      });
      return;
    }
    projected.push({
      id: candidate.id,
      kind: candidate.kind,
      subject: candidate.subject,
      approvable: pending.approvable,
      blockers: allBlockers,
      state: "AWAITING_HUMAN_DECISION",
      reason: null,
      decisionId: null,
      decisionDigest: null,
    });
    candidates.push(pending);
  };

  const roots = Array.isArray(classification.moduleRoots)
    ? classification.moduleRoots
    : [];
  // `implicitRoots` is census's answer (`implicitModuleRoots`), handed in by
  // the lifecycle: the roots validateDiscoveryCompleteness exempts, so the offer
  // is exactly what the gate asks for. Absent, every root is offered.
  for (const entry of roots) {
    const rootPath = typeof entry === "string" ? entry : entry?.path;
    if (!rootPath || implicitRoots.has(rootPath)) continue;
    await addCandidate({
      kind: "ROOT_DECLARATION",
      subjectType: "MODULE_ROOT",
      subjectPath: rootPath,
      rationale: typeof entry === "object" ? entry.reason : "",
      decisionId: typeof entry === "object" ? entry.decisionId : undefined,
    });
  }

  const dispositionKinds = {
    DEAD: "DEAD_CONFIRMATION",
    EXCLUDED_APPROVED: "EXCLUSION",
  };
  for (const row of Array.isArray(classification.files)
    ? classification.files
    : []) {
    const kind = dispositionKinds[row?.disposition];
    if (!kind || typeof row?.path !== "string") continue;
    await addCandidate({
      kind,
      subjectType: "FILE",
      subjectPath: row.path,
      rationale: row.rationale,
      decisionId: row.decisionId,
    });
  }

  const findingRows = new Map(
    (Array.isArray(classification.findings) ? classification.findings : [])
      .filter((row) => typeof row?.id === "string")
      .map((row) => [row.id, row]),
  );
  // Unclaimed target drift, derived by the engine from the same set difference
  // FINALIZE refuses on. The acceptance binds to the path's current bytes, so
  // editing the file afterwards re-blocks.
  for (const drift of targetDrift) {
    await addCandidate({
      kind: "TARGET_DRIFT_ACCEPTED",
      subjectType: "TARGET_FILE",
      subjectPath: drift.subjectPath,
      rationale: drift.rationale,
      autoResolvable: drift.autoResolvable,
      boundToOverride: { ...boundTo, pathDigest: drift.pathDigest },
    });
  }

  for (const visual of visualUnbacked) {
    await addCandidate({
      kind: visual.kind,
      subjectType: visual.subject.type,
      subjectPath: visual.subject.path,
      rationale: visual.rationale,
      boundToOverride: visual.boundTo,
    });
  }

  for (const finding of scan.findings) {
    const row = findingRows.get(finding.id);
    const targets = finding.resolvedTargets ?? [];
    const blockers = [];
    if (finding.type === "I18N_NAMESPACE") {
      blockers.push(
        "The scanner has no proven tracked i18n resource; fix governing configuration before approval.",
      );
    } else if (targets.length === 0) {
      blockers.push(
        "The unresolved module edge has no concrete tracked target; prose or approval cannot resolve it.",
      );
    }
    await addCandidate({
      kind: "EDGE_RESOLUTION",
      subjectType: scan.algorithmVersion >= 2 ? "MODULE_EDGE" : "FILE",
      subjectPath:
        scan.algorithmVersion >= 2
          ? edgeDecisionSubject(finding)
          : finding.file,
      rationale: row?.resolution ?? row?.rationale,
      targets,
      decisionId: row?.decisionId,
      blockers,
    });
  }

  candidates.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.subject.path.localeCompare(right.subject.path) ||
      left.id.localeCompare(right.id),
  );
  const lifecycle = await lifecycleBinding(state, path.join(root, "state.json"));
  const groupable = censusClosed
    ? candidates.filter((candidate) => LATE_DECISION_KINDS.has(candidate.kind))
    : candidates;
  // Offer == accept: the v2 group is one GROUP_APPROVAL line, so the predicate
  // `appendDecisions` writes under decides whether it is offered at all. When it
  // refuses, the members stay offered one by one, each a writable late kind.
  const group = !directLedger
    ? decisionGroupFor(groupable, lifecycle)
    : decisionKindAllowed(DECISION_GROUP_KIND, censusClosed)
      ? await createNewFormatDecisionGroup({
          candidates: groupable,
          lifecycle,
          projectRoot,
        })
      : null;
  if (directLedger && group) {
    group.review = reviewFor(group);
    group.blocked = blockedFor(group);
    for (const view of projected) {
      if (group.groupMembers.some((member) => member.id === view.id)) {
        view.groupReview = group.review;
      }
    }
  }
  return {
    module,
    algorithmVersion: scan.algorithmVersion,
    discoveryDigest: scan.discoveryDigest,
    lifecycle,
    group,
    candidates,
    // Legacy wire field. A format-19 record resolves authority from the ledger
    // against the current candidate digest, so there is no receipt to hand
    // back and the key stays present and empty rather than disappearing.
    references,
    decisions: decisionProjection({ state, directLedger, projected, candidates }),
  };
};

/**
 * The answer half of the one approval gate, shared by the module and artifact
 * recorders: the review or summary, the principal's eligibility, the challenge
 * and the explicit answer. It takes no lock and writes no ledger; a refusal is
 * returned for the recorder to report (`refused`), and an accepted answer
 * carries the explicit v2 `result` (undefined for a legacy challenge, which
 * only ever approves).
 *
 * Only the candidate source, the ledger location, the lock name and the wording
 * of the recorded statement differ, so only those are parameters. Nothing here
 * may be short-circuited by a caller: `answer.trim() !== challenge` is the gate,
 * and it is written once.
 */
export const operatorAnswer = async ({ selected, renderSummary, stdin, stdout, ask }) => {
  if (selected.policyId !== undefined) {
    const review = selected.review ?? reviewFor(selected);
    stdout.write(renderDecisionReview(review));
    if (selected.requiredPrincipal !== "AGENT_RELAYED" || channelOf(ask) === "AUTO") {
      const blocked = selected.blocked ?? blockedFor(selected) ?? {
        state: "NON_SIGNER_AUTHORITY_REFUSED", requiredPrincipal: selected.requiredPrincipal,
        reason: "No host channel can claim a signer result; no authority was appended.",
      };
      stdout.write(`${blocked.state}: ${blocked.reason}\n`);
      return { refused: { blocked } };
    }
    // The explicit result comes only from this review's operator channel.
    // A bare accept, auto-permission or inferred intent is never a decision.
    const answer = ask
      ? await ask({ candidate: selected, review, summary: renderDecisionReview(review) })
      : await (async () => {
          const reader = createInterface({ input: stdin, output: stdout });
          try { return await reader.question("Choose APPROVE or REJECT (anything else cancels)\n> "); }
          finally { reader.close(); }
        })();
    if (typeof answer !== "string" || !["APPROVE", "REJECT"].includes(answer)) {
      stdout.write("No explicit operator decision received. Nothing was written.\n");
      return { refused: { blocked: { state: "CANCELLED", reason: "No decision was recorded." } } };
    }
    return { result: answer === "APPROVE" ? "APPROVED" : "REJECTED" };
  }
  // Ahead of the summary, the challenge and the lock, because it is not a
  // refusal of this answer -- it is a statement that this principal was never
  // eligible to be asked. A candidate whose question the engine cannot derive
  // is a genuine external blocker under `--mode auto`, and the only honest
  // outcome is to stop and say which candidate and why.
  if (channelOf(ask) === "AUTO" && !autoMayDecide(selected)) {
    stdout.write(
      `Candidate '${selected.id}' is not resolvable from repository evidence, so the AUTO principal cannot decide it: ` +
        `${selected.blockers?.join(" ") || "the evidence that would settle it is not derivable from this record."} ` +
        `Nothing was written. Decide it with --mode step, or supply the missing evidence.\n`,
    );
    return { refused: { blocked: true } };
  }
  const challenge = challengeFor(selected);
  // The same bytes either way: a terminal reads them off stdout, a host reads
  // them out of the elicitation message. Only the terminal asks for a phrase.
  const summary = renderSummary(selected);
  stdout.write(summary);
  let answer;
  if (ask) {
    // The front end owns the human channel; it never owns the verdict. Whatever
    // comes back is compared against the same phrase a terminal is compared
    // against, and a non-string is a mismatch rather than a throw.
    answer = String((await ask({ candidate: selected, challenge, summary })) ?? "");
  } else {
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      answer = await reader.question(`Challenge: ${challenge}\n> `);
    } finally {
      reader.close();
    }
  }
  if (answer.trim() !== challenge) {
    stdout.write(
      ask
        ? "No matching inline confirmation phrase was received. Nothing was written.\n"
        : "Challenge phrase did not match. Nothing was written.\n",
    );
    return { refused: { blocked: true, ...(answer.trim() === "cancel" ? { reason: "CANCELLED" } : {}) } };
  }

  return { result: undefined };
};

/**
 * The candidate an accepted answer may be recorded against: the one recomputed
 * under the lock, deep-equal to the one that was reviewed or challenged. Looking
 * up the old id in an unlocked list is never authority to append a line.
 */
export const lockedApprovalCandidate = (selected, candidates) => {
  if (selected.policyId !== undefined) {
    const current = assertReviewedCandidateCurrent(selected, candidates);
    if (current.requiredPrincipal !== "AGENT_RELAYED") {
      throw new Error(`Candidate '${selected.id}' changed while its review was open. Nothing was written.`);
    }
    return current;
  }
  const lockedCandidate = candidates.find(
    (candidate) => candidate.id === selected.id,
  );
  if (
    !lockedCandidate ||
    !lockedCandidate.approvable ||
    JSON.stringify(lockedCandidate) !== JSON.stringify(selected)
  ) {
    throw new Error(
      `Candidate '${selected.id}' changed or ceased to be pending while the challenge was open. Nothing was written; run --pending again.`,
    );
  }
  return lockedCandidate;
};

/** The summary an operator confirms one legacy decision group by. */
export const renderGroupApprovalSummary = (selected) =>
    `Operator decision group for migration '${selected.boundTo.module}'\n` +
    `Group: ${selected.id}\n` +
    `Action: accept ${selected.boundTo.members.length} ${selected.groupMembers[0].kind} decision(s)\n` +
    selected.boundTo.members
      .map(
        (member, index) =>
          `  ${index + 1}. ${member.id} ${member.kind} ${member.subject.type} ${member.subject.path}` +
          `${member.pathDigest ? ` ${member.pathDigest}` : ""}\n`,
      )
      .join("") +
    `This one approval binds to that exact ordered set and lifecycle.\n` +
    `Type the challenge phrase to approve all of them, anything else to abort.\n`;

// The new format is selected by the candidate the operator reviewed, not by
// a caller: only `createNewFormatDecisionGroup` produces a policy-bound
// group, and only a policy-bound group gets the single-line v2 append. An
// old-format group keeps its exact existing serialization.
export const appendApprovedGroup = ({ group, locked, ask, stdout, result }) =>
  (group.policyId === undefined
    ? appendGroupDecisions
    : appendNewFormatGroupDecision)({ group, locked, ask, stdout, result });

/** Only an exact, current, approvable stable id can be put to the operator. */
export const selectApprovalCandidate = (candidates, approve) => {
  const selected = candidates.find((candidate) => candidate.id === approve);
  if (!selected) {
    throw new Error(
      `Approval id '${approve}' is stale or is not pending. Run --pending and select an exact current stable id. Nothing was written.`,
    );
  }
  if (!selected.approvable) {
    throw new Error(
      `Candidate '${selected.id}' is not approvable: ${selected.blockers.join(" ")} Nothing was written.`,
    );
  }
  return selected;
};

/** Record one approved candidate, recomputed under the lock, in its own format. */
export const appendApprovedCandidate = async ({ candidate: lockedCandidate, locked, result, ask, stdout, statementFor }) => {
  if (lockedCandidate.policyId !== undefined) {
    const { decisions } = await readRecordedDecisions(locked.root);
    const digest = candidateDigestOf(lockedCandidate);
    if (decisions.some((decision) => decision.v === 2 && decision.candidateDigest === digest)) {
      throw new Error(`Candidate '${lockedCandidate.id}' already has a decision. Nothing was written.`);
    }
    const { previous, idPrefix } = await ledgerHeadFor(locked.root, channelOf(ask));
    const decision = buildDecision({
      previous, idPrefix, kind: lockedCandidate.kind,
      subjectType: lockedCandidate.subject.type, subject: lockedCandidate.subject.path,
      statement: `AGENT_RELAYED ${result} of candidate ${lockedCandidate.id}.`,
      rationale: lockedCandidate.rationale, candidateId: lockedCandidate.id,
      targets: lockedCandidate.targets, boundTo: lockedCandidate.boundTo,
      principal: "AGENT_RELAYED", result, candidateDigest: digest,
      policyId: lockedCandidate.policyId, policyDigest: lockedCandidate.policyDigest,
    });
    await appendDecisions(locked, [decision], stdout);
    return { decision };
  }
  const { previous, idPrefix } = await ledgerHeadFor(
    locked.root,
    channelOf(ask),
  );
  const decision = buildDecision({
    previous,
    idPrefix,
    kind: lockedCandidate.kind,
    subjectType: lockedCandidate.subject.type,
    subject: lockedCandidate.subject.path,
    statement: statementFor(lockedCandidate, ask),
    rationale: lockedCandidate.rationale,
    candidateId: lockedCandidate.id,
    targets: lockedCandidate.targets,
    boundTo: lockedCandidate.boundTo,
    authorizedBy: autoAuthorization(ask, lockedCandidate, locked.toolkit),
  });
  await appendDecisions(locked, [decision], stdout);
  return { decision };
};

/**
 * The artifact recorder's pending candidates: the artifact engine's decision
 * rows (its facts) less every row that is satisfied, rejected under direct
 * authority, or already bound by a recorded line.
 */
export const pendingArtifactDecisions = (context, decisions) =>
  context.decisions
    .filter(
      (row) =>
        !row.satisfied &&
        (!usesArtifactDirectLedger(context.state.formatVersion) || row.projection.state !== "REJECTED") &&
        !decisions.some((decision) =>
          decisionAppliesToCandidate(decision, row.candidate),
        ),
    )
    .map((row) => {
      const blockers = String(row.subject ?? "").trim()
        ? []
        : ["The operator decision has no reviewable subject."];
      return {
        ...row.candidate,
        approvable: blockers.length === 0,
        blockers,
        ...(usesArtifactDirectLedger(context.state.formatVersion) ? {
          review: reviewFor(row.candidate),
          blocked: blockedFor(row.candidate),
          projection: row.projection,
        } : {}),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

/**
 * A record whose authority cannot be expressed under its own format is the one
 * state that is not a candidate outcome, so it is reported as the typed
 * compatibility action rather than thrown at a read-only caller. Every other
 * error is rethrown.
 */
export const legacyCompatibilityProjection = (error) => {
  if (error?.compatibilityAction !== LEGACY_COMPATIBILITY_ACTION_REQUIRED) {
    throw error;
  }
  return {
    directLedger: true,
    checkpoint: null,
    checkpointAdvanced: false,
    state: LEGACY_COMPATIBILITY_ACTION_REQUIRED,
    reason: error.message,
    candidates: [],
  };
};

/** An explicit relay carries exactly APPROVE or REJECT, never an inferred intent. */
export const assertRelayDecision = (decision) => {
  if (!["APPROVE", "REJECT"].includes(decision)) {
    throw new Error("decision must be APPROVE or REJECT. Nothing was written.");
  }
};

/**
 * The one open format-19 review a relay reference names, or null when it no
 * longer is the current review. A legacy record has nothing to relay.
 */
export const relayedReview = (pending, reference, moduleName) => {
  if (!pending.decisions?.directLedger) {
    throw new Error(`Record '${moduleName}' does not use direct-ledger decisions; nothing can be relayed. Nothing was written.`);
  }
  return [pending.group, ...pending.candidates]
    .find((candidate) => candidate?.approvable !== false && candidate?.review &&
      typeof reference === "string" && reviewReference(candidate.review) === reference);
};

/**
 * The relay's answerer: the operator's explicit decision, and only for the
 * review the reference was issued for. Any other review gets no answer, so the
 * gate cancels rather than records.
 */
export const relayAnswer = (reference, decision) => async ({ review }) =>
  (reviewReference(review) === reference ? decision : "");

/**
 * The artifact engine's VISUAL_UNBACKED decision rows, constructed from
 * supplied facts: the visual owner's unbacked candidates, the committed visual
 * matrix, the source inventory, both verified ledgers, and (format 14 past
 * BUILD_BASELINE) the decision identities that checkpoint consumed.
 */
export const artifactVisualDecisionRows = async ({ state, source, candidates, matrix, ledger: { byId, decisions }, historical }) => {
  if (usesArtifactDirectLedger(state.formatVersion)) {
    if (historical && historical.length !== candidates.length) {
      throw new Error("Consumed visual decisions do not match the committed visual matrix.");
    }
    unique(
      arrayOf(matrix.unbacked ?? [], "Visual acceptance unbacked").map((item) =>
        `${item.uiBehaviorId}::${item.state}`),
      "Visual acceptance unbacked states",
    );
    return Promise.all(candidates.map(async (legacy) => {
      const item = (matrix.unbacked ?? []).find(
        (row) => `${row.uiBehaviorId}::${row.state}` === legacy.subject.path,
      );
      exactObject(item, `Visual acceptance unbacked '${legacy.subject.path}'`, ["uiBehaviorId", "state", "reason"]);
      nonEmpty(item.reason, `Visual acceptance unbacked '${legacy.subject.path}' reason`);
      if (!source.document.behaviors.some((behavior) =>
        behavior.id === item.uiBehaviorId && behavior.runtimeStates?.includes(item.state))) {
        throw new Error(`Visual acceptance unbacked '${legacy.subject.path}' does not name a source UI state.`);
      }
      if (historical) {
        const matched = historical.filter((identity) => byId.get(identity.decisionId)?.subject?.path === legacy.subject.path);
        const line = byId.get(matched[0]?.decisionId);
        if (matched.length !== 1 || line?.kind !== "VISUAL_UNBACKED" ||
            canonical(line.boundTo?.visualUnbacked) !== canonical(item) ||
            line.boundTo?.visualMatrixDigest !== `sha256:${sha256(canonical(matrix))}` ||
            canonical(line.boundTo?.sourceBinding) !== canonical(state.bindings.source)) {
          throw new Error(`Visual acceptance unbacked '${legacy.subject.path}' has no provable consumed identity.`);
        }
        return { id: legacy.id, subject: legacy.subject.path, decisionId: null, candidate: null,
          satisfied: true, recorded: null, projection: { state: "APPROVED_APPLICABLE" } };
      }
      const candidate = await createNewFormatDecisionCandidate({
        projectRoot: state.target.root,
        kind: legacy.kind,
        subjectType: legacy.subject.type,
        subjectPath: legacy.subject.path,
        rationale: legacy.rationale,
        targets: state.bindings.target.paths,
        boundTo: {
          ...legacy.boundTo,
          ...artifactCandidateEvidence(state, source.document),
          visualMatrixDigest: `sha256:${sha256(canonical(matrix))}`,
          visualUnbacked: item,
        },
      });
      const projection = await projectArtifactDecision({ decisions, candidate, label: `Visual acceptance unbacked '${legacy.subject.path}'`, row: item });
      return { id: candidate.id, subject: candidate.subject.path, decisionId: null, candidate,
        satisfied: projection.state === "APPROVED_APPLICABLE", recorded: null, projection };
    }));
  }
  return candidates.map((candidate) => {
    const item = (matrix.unbacked ?? []).find(
      (row) => `${row.uiBehaviorId}::${row.state}` === candidate.subject.path,
    );
    const recorded = decisions.find((row) => decisionAppliesToCandidate(row, candidate)) ?? null;
    return {
      id: candidate.id,
      subject: candidate.subject.path,
      decisionId: item?.decisionId ?? null,
      candidate,
      satisfied: decisionAppliesToCandidate(byId.get(item?.decisionId), candidate),
      recorded,
    };
  });
};

/**
 * Which artifact decision rows are approvable, citable or decided, and the
 * artifact decision projection. `commandFor` only renders the legacy
 * `--approve` hint.
 */
export const reconcileArtifactDecisionRows = (state, decisions, commandFor) => {
  const pending = decisions.filter((row) => !row.satisfied);
  if (usesArtifactDirectLedger(state.formatVersion)) {
    const undecided = pending.filter((row) => row.projection.state !== "REJECTED");
    return {
      approvable: undecided,
      citable: [],
      references: [],
      citations: [],
      projection: {
        state: pending.some((row) => row.projection.state === "REJECTED") ? "REJECTED"
          : undecided.some((row) => row.projection.state === "STALE") ? "STALE"
          : undecided.length ? "AWAITING_HUMAN_DECISION"
          : decisions.length ? "APPROVED_APPLICABLE" : "READY_TO_ADVANCE",
        checkpointAdvanced: false,
        blocked: undecided.some((row) => row.candidate.requiredPrincipal === "HUMAN_ATTESTED")
          ? { state: "SIGNER_UNAVAILABLE", requiredPrincipal: "HUMAN_ATTESTED" } : null,
        decisions: decisions.map((row) => row.projection),
      },
      candidates: undecided.map((row) => ({ ...row.candidate, approvable: true, blockers: [], review: reviewFor(row.candidate) })),
      pendingDecisions: undecided.map((row) => ({ id: row.id, subject: row.subject, candidateId: row.candidate.id,
        state: row.projection.state, blocked: row.candidate.requiredPrincipal === "HUMAN_ATTESTED"
          ? { state: "SIGNER_UNAVAILABLE", requiredPrincipal: "HUMAN_ATTESTED" } : null,
        review: reviewFor(row.candidate) })),
    };
  }
  const approvable = pending.filter((row) => !row.recorded);
  const citable = pending.filter((row) => row.recorded);
  return {
    approvable,
    citable,
    candidates: approvable.map((row) => ({
      ...(row.candidate ?? artifactDecisionCandidate(state, row)),
      approvable: Boolean(String(row.subject ?? "").trim()),
      blockers: String(row.subject ?? "").trim()
        ? []
        : ["The operator decision has no reviewable subject."],
      command: commandFor(row.candidate ?? artifactDecisionCandidate(state, row)),
    })),
    references: citable.map((row) => ({
      candidateId: (row.candidate ?? artifactDecisionCandidate(state, row)).id,
      subject: (row.candidate ?? artifactDecisionCandidate(state, row)).subject,
      decisionId: row.recorded.id,
      decisionDigest: decisionLineDigest(row.recorded),
    })),
    citations: citable.map((row) => ({ id: row.id, decisionId: row.recorded.id })),
    pendingDecisions: pending.map((row) => ({
      id: row.id,
      subject: row.subject,
      candidateId: (row.candidate ?? artifactDecisionCandidate(state, row)).id,
      recordedDecisionId: row.recorded?.id ?? null,
      command: commandFor(row.candidate ?? artifactDecisionCandidate(state, row)),
    })),
  };
};
export const OPERATION_SEQUENCE_KIND = "OPERATION_SEQUENCE";

/** The only operation a sequence may carry today. */
export const AMEND_SLICE = "AMEND_SLICE";

/**
 * An amendment moves neither the checkpoint nor the active slice: it re-pins
 * one reopened slice's record and bumps the revision. So the position member k
 * must execute at is derivable in full from the position member k-1 executed
 * at, which is what lets one approval bind to all of them.
 */
export const nextExpected = (expected) => ({
  ...expected,
  revision: expected.revision + 1,
});

/**
 * The facts one member is approved against, and the whole of them. Everything
 * here is either the operator's own input (the slice and its files) or an
 * engine-derived identity, so a member whose bytes, ownership, amendment slot
 * or expected position moved has different facts and a different sequence id.
 */
export const memberFacts = (member) => ({
  index: member.index,
  operation: member.operation,
  slice: member.slice,
  files: member.files,
  add: member.add,
  amendment: member.amendment,
  preservesAs: member.preservesAs,
  sliceRecordDigestBefore: member.sliceRecordDigestBefore,
  sliceRecordDigestAfter: member.sliceRecordDigestAfter,
  implementationDigestBefore: member.implementationDigestBefore,
  implementationDigestAfter: member.implementationDigestAfter,
  expected: member.expected,
});

/** The ownership and identity facts shown to the human, per added file. */
export const addedFileFact = (file) => ({
  path: file.path,
  identity: file.identity,
  ownershipBasis: file.ownershipBasis,
  claimedBy: [...(file.claimedBy ?? [])],
  driftClass: file.driftClass,
});

/**
 * The phrase a human types, derived from the sequence. `y` approves anything;
 * this approves this ordered set at this record position, and the id it names
 * is content-addressed over every fact rendered below it.
 */
export const challengeForOperationSequence = (sequence) =>
  `APPROVE ${sequence.id} ${OPERATION_SEQUENCE_KIND} ${sequence.members.length} ${sequence.module}`;

export const renderOperationSequence = (sequence) =>
  `Operator operation sequence for migration '${sequence.module}'\n` +
  `Sequence: ${sequence.id}\n` +
  `Action: execute ${sequence.members.length} operation(s), in this order\n` +
  `Bound to: format ${sequence.lifecycle.formatVersion} ` +
  `revision ${sequence.lifecycle.revision} ` +
  `${sequence.lifecycle.status}/${sequence.lifecycle.currentStep}` +
  `${sequence.lifecycle.activeSlice ? `/${sequence.lifecycle.activeSlice}` : ""}\n` +
  `State hash: ${sequence.lifecycle.stateHash}\n\n` +
  sequence.members
    .map(
      (member) =>
        `  ${member.index}. ${member.operation} ${member.slice} ` +
        `(amendment ${member.amendment}, at revision ${member.expected.revision})\n` +
        member.add
          .map(
            (file) =>
              `       + ${file.path}\n` +
              `         bytes ${file.identity}\n` +
              `         basis ${file.ownershipBasis} drift ${file.driftClass} ` +
              `claimedBy ${file.claimedBy.length > 0 ? file.claimedBy.join(",") : "none"}\n`,
          )
          .join("") +
        `       slice record ${member.sliceRecordDigestBefore} -> ${member.sliceRecordDigestAfter}\n` +
        `       preserves prior record as ${member.preservesAs}\n`,
    )
    .join("") +
  `\nThis one approval binds to that exact sequence, in that exact order, from\n` +
  `that exact record state. Each operation is re-derived and re-proven when it\n` +
  `runs; any change this sequence did not itself cause expires the rest of it.\n` +
  `Type the challenge phrase to approve the whole sequence, anything else to abort.\n`;
