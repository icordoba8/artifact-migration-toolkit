/**
 * Decisions: whether a ledger line is authority. The verified, principal-
 * segregated ledger readers, append-only late-decision checks, the citation
 * resolver for historical formats, the format-19 resolver and its projection
 * (rejection, staleness, weaker principal, policy change, group authority),
 * consumed-decision identities, operation-sequence authorization branding, and
 * the artifact consumed-history proof.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTO_DECISIONS_FILE,
  DECISIONS_FILE,
  DIRECT_LEDGER_DECISIONS_FORMAT,
  LegacyCompatibilityActionRequired,
  usesArtifactDirectLedger,
  usesDirectLedgerDecisions,
  VISUAL_ACCEPTANCE_FILE,
} from "../formats/index.mjs";
import {
  assertArray as arrayOf,
  assertNonEmpty,
  exactObject,
  isPlainObject,
  sha256Hex as sha256,
} from "../shared/index.mjs";
import { fileExists, readJsonAt } from "../store/index.mjs";
import {
  candidateDigestOf,
  createNewFormatDecisionCandidate,
  DECISION_GROUP_KIND,
  decisionAppliesToCandidate,
  decisionGroupMemberFact,
  decisionKindAllowed,
  decisionLineDigest,
  groupCandidateInput,
  LATE_DECISION_KINDS,
} from "./candidate.mjs";
import {
  decisionChannelOf,
  decisionLineProblem,
  decisionPrincipalOf,
  principalSatisfiesRequirement,
  resolveHistoricalRequiredPrincipal,
  verifyAttestedLine,
} from "./policy.mjs";

export const assertLateDecisionsAreAppendable = (tail) => {
  const text = tail.toString("utf8");
  const rewritten = () =>
    new Error(
      `${DECISIONS_FILE} bytes changed after DISCOVERY_COMPLETENESS closed. Everything appended past the pinned prefix must be whole ${[...LATE_DECISION_KINDS].join("/")} decision lines; a semantically equivalent rewrite -- reformatting, or a bare newline -- is still a rewrite of the immutable operator record.`,
    );
  // The tail is NDJSON or it is a rewrite. Exactly one trailing newline, no
  // blank lines, nothing that is not a complete decision.
  if (!text.endsWith("\n")) throw rewritten();
  for (const line of text.slice(0, -1).split("\n")) {
    if (!line.trim()) throw rewritten();
    let decision;
    try {
      decision = JSON.parse(line);
    } catch {
      throw rewritten();
    }
    if (!decisionKindAllowed(decision.kind, true)) {
      throw new Error(
        `${DECISIONS_FILE} gained a '${decision.kind}' decision after DISCOVERY_COMPLETENESS closed. Only ${[...LATE_DECISION_KINDS].join(", ")} may be recorded once the census is fixed; every other approval binds to facts that checkpoint already pinned.`,
      );
    }
  }
};

export const rawDecisionLedgerDigest = async (root) => {
  const file = path.join(root, DECISIONS_FILE);
  const bytes = (await fileExists(file))
    ? await readFile(file)
    : Buffer.alloc(0);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};

/** The pinned prefix length, so the pin can be append-only rather than frozen. */
export const rawDecisionLedgerBytes = async (root) => {
  const file = path.join(root, DECISIONS_FILE);
  return (await fileExists(file)) ? (await readFile(file)).length : 0;
};

/**
 * Reads one decision ledger and verifies its hash chain. Absent file is legal:
 * a module with nothing to approve records nothing.
 *
 * `principal` is the segregation guard, and it is the reason this is one
 * function over two files rather than two functions. A line is only ever read
 * back out of the ledger its principal owns, so appending an `AUTO` line to the
 * human record -- or a forged `TERMINAL` line to the auto record -- does not
 * quietly become authority; it makes the file unreadable and every command that
 * opens the record says so.
 */
export const readDecisionLedger = async (root, file, principal) => {
  const absolute = path.join(root, file);
  if (!(await fileExists(absolute))) return { decisions: [], byId: new Map() };
  const decisions = [];
  const content = await readFile(absolute, "utf8");
  // Every line this engine has ever appended ended in a newline, written with
  // the record in one O_APPEND write. A ledger that does not end in one is a
  // torn append, and a torn line is refused whole rather than parsed as far as
  // it got -- a group entry is one line, so refusing it refuses the group.
  if (content.length > 0 && !content.endsWith("\n")) {
    throw new Error(
      `${file} does not end in a newline, so its last line is an incomplete append: the process was interrupted mid-write. A torn decision line is never authority; nothing was read.`,
    );
  }
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let decision;
    try {
      decision = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${file} line ${index + 1} is not valid JSON: ${error.message}. The operator decision record was truncated or rewritten.`,
      );
    }
    const problem = decision?.v === 2 && decision.principal === "HUMAN_ATTESTED" && principal !== "AUTO"
      ? await verifyAttestedLine(decision, absolute)
      : decisionLineProblem(decision);
    if (problem) {
      throw new Error(
        `${file} line ${index + 1} ('${decision.id ?? "unknown"}') ${problem}. The operator decision record is untrusted.`,
      );
    }
    const isAuto = decisionPrincipalOf(decision) === "AUTO";
    const channel =
      decision?.v === 2 ? decision.principal : decisionChannelOf(decision);
    if (principal === "AUTO" ? !isAuto : isAuto) {
      throw new Error(
        `${file} line ${index + 1} ('${decision.id ?? "unknown"}') records ${decision?.v === 2 ? "principal" : "channel"} '${channel}', which does not belong in this ledger. ${DECISIONS_FILE} is the human operator record and ${AUTO_DECISIONS_FILE} is the AUTO principal's; a line in the wrong one is a forged principal, not a misfile.`,
      );
    }
    const previous = decisions.at(-1) ?? null;
    const expectedPrev = previous ? decisionLineDigest(previous) : "genesis";
    if (decision.prevDigest !== expectedPrev) {
      throw new Error(
        `${file} line ${index + 1} ('${decision.id ?? "unknown"}') chains to '${decision.prevDigest}', but the preceding line digests to '${expectedPrev}'. A decision was edited, reordered, or removed; the whole record is untrusted.`,
      );
    }
    if (decision.seq !== decisions.length + 1) {
      throw new Error(
        `${file} line ${index + 1} records seq ${decision.seq} at position ${decisions.length + 1}.`,
      );
    }
    decisions.push(decision);
  }
  return {
    decisions,
    byId: new Map(decisions.map((decision) => [decision.id, decision])),
  };
};

/** The human record, and only ever the human record. */
export const readOperatorDecisions = async (root) =>
  readDecisionLedger(root, DECISIONS_FILE, "OPERATOR");

/** The AUTO principal's record, and only ever that. */
export const readAutoDecisions = async (root) =>
  readDecisionLedger(root, AUTO_DECISIONS_FILE, "AUTO");

/**
 * Every recorded decision, whoever made it, for *resolving a citation*.
 *
 * Validation asks "does the id this row cites resolve to a line that binds to
 * this candidate", and that question has the same answer for both principals --
 * the binding digests, the rationale digest and the candidate identity are what
 * make a line authority, and they are checked identically. Which principal
 * decided stays legible in the id prefix and in `authorizedBy.channel`; it is
 * never erased by this union, only looked up through it.
 */
export const readRecordedDecisions = async (root) => {
  const [operator, auto] = await Promise.all([
    readOperatorDecisions(root),
    readAutoDecisions(root),
  ]);
  return {
    operator: operator.decisions,
    auto: auto.decisions,
    decisions: [...operator.decisions, ...auto.decisions],
    byId: new Map([...operator.byId, ...auto.byId]),
  };
};

/**
 * The one authority every module-side operator approval passes through.
 *
 * A row cites a decision id; the id must resolve to a recorded line, the line
 * must digest to the digest the row pins, and `decisionAppliesToCandidate` --
 * the same predicate `record-decision.mjs` and the artifact engine use -- must
 * bind it to the candidate this validation just derived from the current scan.
 *
 * `candidate` is required, never optional. Every candidate-bound check here used
 * to read `candidate && ...`, and callers supplied one only at scanner version
 * >= 2. `algorithmVersion` is an *agent-authored* field of
 * `module-classification.json`, so writing `1` switched candidate identity,
 * subject type, targets, module and scanner binding off in one edit, and a
 * hand-written ledger line matching only kind, path, rationale and discovery
 * digest became sufficient authority. A candidate is derivable at every
 * supported scanner version, so there is no version at which an authored line
 * may stand on its own -- and no candidate means no authority at all.
 */
export const requireDecision = ({ byId, row, label, candidate }) => {
  if (!candidate) {
    throw new Error(
      `${label} requires an operator decision, but no stable candidate could be derived to bind one to. A recorded ledger line is never authority by itself; re-run discovery and approve the current candidate.`,
    );
  }
  const decisionId = assertNonEmpty(row.decisionId, `${label}.decisionId`);
  const decision = byId.get(decisionId);
  if (!decision) {
    throw new Error(
      `${label} cites decision '${decisionId}', which is recorded in neither ${DECISIONS_FILE} nor ${AUTO_DECISIONS_FILE}. Only record-decision.mjs writes either -- a human answering a challenge into the first, the AUTO principal under --mode auto into the second -- and an agent can never author its own approval into either.`,
    );
  }
  if (decision.kind !== candidate.kind) {
    throw new Error(
      `${label} cites '${decisionId}', which is a ${decision.kind} decision; a ${candidate.kind} decision is required.`,
    );
  }
  if (decision.subject?.path !== candidate.subject.path) {
    throw new Error(
      `${label} cites '${decisionId}', which approves '${decision.subject?.path ?? "nothing"}'. An approval cannot be recycled onto '${candidate.subject.path}'.`,
    );
  }
  const expectedDigest = decisionLineDigest(decision);
  if (row.decisionDigest !== expectedDigest) {
    throw new Error(
      `${label}.decisionDigest does not match decision '${decisionId}': recorded ${row.decisionDigest ?? "nothing"}, actual ${expectedDigest}.`,
    );
  }
  if (decision.rationaleDigest !== candidate.rationaleDigest) {
    throw new Error(
      `${label}.rationale changed after decision '${decisionId}' approved it. An approval binds to the exact rationale it was shown; record a new decision or restore the rationale.`,
    );
  }
  if (decision.boundTo?.discoveryDigest !== candidate.boundTo.discoveryDigest) {
    throw new Error(
      `${label} cites '${decisionId}', which was recorded against discovery digest '${decision.boundTo?.discoveryDigest ?? "none"}'; the module now scans to '${candidate.boundTo.discoveryDigest}'. The facts the operator approved changed; record the decision again.`,
    );
  }
  if (
    decision.boundTo?.module !== candidate.boundTo.module ||
    decision.boundTo?.algorithmVersion !== candidate.boundTo.algorithmVersion
  ) {
    throw new Error(
      `${label} cites '${decisionId}', but its module or scanner-version binding does not match candidate '${candidate.id}'.`,
    );
  }
  // The digest binds the graph -- roots, entry points, edges, what is unproven
  // -- and deliberately not the bytes inside a file. So an approval for
  // decorative content used to survive that content growing a delete button, as
  // long as the path and the imports held still. This is the missing half.
  if (
    decision.boundTo?.legacyRevision !== candidate.boundTo.legacyRevision ||
    decision.boundTo?.legacyDirtyDigest !== candidate.boundTo.legacyDirtyDigest
  ) {
    throw new Error(
      `${label} cites '${decisionId}', which was recorded against legacy source ${decision.boundTo?.legacyRevision ?? "none"}/${decision.boundTo?.legacyDirtyDigest ?? "none"}; the legacy tree now reads ${candidate.boundTo.legacyRevision}/${candidate.boundTo.legacyDirtyDigest}. An approval binds to the exact bytes it approved, not just to the shape of the import graph; record the decision again.`,
    );
  }
  // Last, deliberately. `candidateId` hashes everything checked above, so a
  // stale census, an edited rationale and edited legacy bytes would all surface
  // as one indistinguishable "wrong candidate" if this ran first. What reaches
  // it is a line that agrees on every named field and still is not the
  // candidate: an authored id, a fabricated line, a replay from another target.
  if (decision.candidateId !== candidate.id) {
    throw new Error(
      `${label} cites '${decisionId}', but that line does not approve current stable candidate '${candidate.id}'. Agent-authored, fake, and stale approval ids never satisfy a candidate.`,
    );
  }
  if (decision.subject?.type !== candidate.subject.type) {
    throw new Error(
      `${label} cites '${decisionId}', but its subject type does not match candidate '${candidate.id}'.`,
    );
  }
  if (
    JSON.stringify(decision.targets ?? []) !== JSON.stringify(candidate.targets)
  ) {
    throw new Error(
      `${label} cites '${decisionId}', but its concrete targets do not match candidate '${candidate.id}'.`,
    );
  }
  // The checks above are diagnostics: each names one way a line fails to bind.
  // This is the authority. A field added to the binding is enforced here whether
  // or not a message above ever learns to name it.
  if (!decisionAppliesToCandidate(decision, candidate)) {
    throw new Error(
      `${label} cites '${decisionId}', which is not bound to current stable candidate '${candidate.id}'.`,
    );
  }
  return decision;
};

// --- Format 19: direct ledger authority ------------------------------------

/**
 * The decisions one checkpoint advance actually consumed.
 *
 * An `AsyncLocalStorage` rather than a parameter threaded through forty
 * validator signatures, and rather than a module-level variable: two records
 * can validate concurrently in one process (`withModuleLock` keys on the
 * record, not the process), and a shared mutable collector would attribute one
 * record's authority to the other's checkpoint. The store is a `Map` keyed by
 * decision id, so a group entry resolved once per member is recorded once --
 * "exactly once", structurally, not by a later de-duplication pass.
 *
 * Absent outside an advance. Status, preview and every read-only projection
 * resolve authority through the same resolver and record nothing.
 */
export const consumedDecisionStore = new AsyncLocalStorage();

/** The identity set the approved plan journals, and nothing else from the line. */
export const consumedDecisionIdentity = (decision, candidate) => ({
  candidateDigest: decision.candidateDigest ?? candidateDigestOf(candidate),
  decisionId: decision.id,
  decisionDigest: decisionLineDigest(decision),
  policyId: decision.policyId ?? null,
  policyDigest: decision.policyDigest ?? null,
  principal: decisionPrincipalOf(decision),
  result: decision.result ?? null,
});

export const recordConsumedDecision = (decision, candidate) => {
  const store = consumedDecisionStore.getStore();
  if (!store || !decision?.id) return;
  store.set(decision.id, consumedDecisionIdentity(decision, candidate));
};

/**
 * The resolver's own answer, before anyone decides whether to throw it.
 *
 * Status, pending and run disagreed historically because each ran its own test
 * for "is this decided": the gate threw, the projection re-implemented a
 * lenient version of the same question, and the two could answer differently
 * over one ledger. So there is one body, and exactly two faces over it -- this
 * one, which names the state, and `resolveApplicableDecision`, which refuses on
 * anything but `APPROVED_APPLICABLE` using this function's own message. A
 * difference between what status shows and what run enforces is now a
 * structural impossibility rather than a tested coincidence.
 *
 * Ambiguity and malformed records still throw from here: a duplicate outcome or
 * a record authoring receipts under direct authority is not a decision state to
 * display, it is a refusal every caller must fail closed on identically.
 */
export const applicableDecisionOutcome = ({
  decisions,
  candidate,
  label,
  group = null,
  row = null,
}) => {
  if (!candidate) {
    throw new Error(
      `${label} requires an operator decision, but no stable candidate could be derived to bind one to. A recorded ledger line is never authority by itself; re-run discovery and resolve the current candidate.`,
    );
  }
  if (
    candidate.policyId === undefined ||
    candidate.policyDigest === undefined ||
    candidate.requiredPrincipal === undefined ||
    typeof candidate.projectRoot !== "string"
  ) {
    throw new Error(
      `${label} derived candidate '${candidate.id}' without a trusted policy binding. A format-${DIRECT_LEDGER_DECISIONS_FORMAT} decision is resolved against a pinned policy identity, required principal and project root; an unbound candidate is refused rather than resolved under a default nobody pinned.`,
    );
  }
  // Direct authority and a copied receipt are two different claims about where
  // authority lives, and a record making both is ambiguous. Rejected here as
  // well as in the schema so a hand-edited row cannot slip past the authoring
  // check and then be silently ignored at the gate.
  if (row && (row.decisionId !== undefined || row.decisionDigest !== undefined)) {
    throw new Error(
      `${label} carries decisionId/decisionDigest, which a format-${DIRECT_LEDGER_DECISIONS_FORMAT} record must not author. Authority is resolved from the ledger against the current candidate digest, never from a receipt copied into the record. Remove the receipt fields.`,
    );
  }
  // One reviewed act, one authoritative entry. A member resolves through the
  // group's own candidate, never through a line of its own.
  const authority = group ?? candidate;
  const digest = candidateDigestOf(authority);
  const matching = decisions.filter(
    (decision) => decision?.v === 2 && decision.candidateDigest === digest,
  );
  if (matching.length > 1) {
    throw new Error(
      `${label} resolves to ${matching.length} ledger entries over the same candidate '${authority.id}' (${matching
        .map((decision) => `${decision.id} ${decision.result}`)
        .join(", ")}). Duplicate or conflicting outcomes fail closed; nothing is authoritative until the record is repaired.`,
    );
  }
  const [decision] = matching;
  if (decision?.result === "REJECTED" && decisionAppliesToCandidate({ ...decision, result: "APPROVED" }, authority)) {
    return {
      state: "REJECTED",
      decision,
      authority,
      message: `${label} is blocked by decision '${decision.id}', a candidate-bound REJECTED outcome over '${authority.id}'. A rejection is a decision, not a missing one; it blocks until the candidate's evidence actually changes.`,
    };
  }
  if (!decision) {
    // Distinguish "never decided" from "decided, then the facts moved": a line
    // that names this candidate id but a different digest is the operator's
    // own earlier decision over superseded evidence, and saying so is the
    // difference between a usable refusal and a mysterious one.
    const stale = decisions.find(
      (line) => line?.v === 2 && line.boundTo?.module === authority.boundTo.module &&
        ((line.kind === authority.kind && line.subject?.type === authority.subject.type &&
          line.subject?.path === authority.subject.path) ||
          (!group && line.kind === DECISION_GROUP_KIND && line.boundTo?.members?.some((member) =>
            member.kind === authority.kind && member.subject?.type === authority.subject.type &&
            member.subject?.path === authority.subject.path))),
    );
    return stale
      ? {
          state: "STALE",
          decision: stale,
          authority,
          message: `${label} has no applicable decision: '${stale.id}' was recorded against candidate digest ${stale.candidateDigest}, and the current candidate '${authority.id}' digests to ${digest}. The facts changed after that decision; it is stale and cannot authorize the current candidate.`,
        }
      : {
          state: "AWAITING_HUMAN_DECISION",
          decision: null,
          authority,
          message: `${label} has no applicable decision for candidate '${authority.id}' (${digest}). It requires a ${authority.requiredPrincipal} decision under policy ${authority.policyId}; nothing in the verified ledger resolves to it.`,
        };
  }
  if (!decisionAppliesToCandidate(decision, authority)) {
    const weaker = !principalSatisfiesRequirement(
      decisionPrincipalOf(decision),
      authority.requiredPrincipal,
    );
    const otherPolicy =
      decision.policyId !== authority.policyId ||
      decision.policyDigest !== authority.policyDigest;
    return {
      // A line that is present but does not authorize is still an undecided
      // candidate, except when the *policy* moved underneath it: that line was
      // a real decision over a binding that no longer exists, which is exactly
      // staleness, and saying "never decided" would hide the operator's own act.
      state: otherPolicy && !weaker ? "STALE" : "AWAITING_HUMAN_DECISION",
      decision,
      authority,
      message: weaker
        ? `${label} is not authorized by decision '${decision.id}': it was recorded by principal '${decisionPrincipalOf(decision)}', and candidate '${authority.id}' requires '${authority.requiredPrincipal}'. A weaker principal never satisfies a stronger requirement and never falls back to one.`
        : otherPolicy
          ? `${label} is not authorized by decision '${decision.id}': it was recorded under policy ${decision.policyId}/${decision.policyDigest}, and candidate '${authority.id}' is pinned to ${authority.policyId}/${authority.policyDigest}. A policy change invalidates outstanding candidate bindings and cannot retroactively authorize them.`
          : `${label} cites no applicable decision: '${decision.id}' is not bound to current stable candidate '${authority.id}'.`,
    };
  }
  return {
    state: "APPROVED_APPLICABLE",
    decision,
    authority,
    message: null,
  };
};

/**
 * The enforcing face: the same resolution, refused unless it is an applicable
 * approval. The consumed identity is journalled here and nowhere else, so a
 * read-only projection resolving the same line records nothing even if it runs
 * inside an advance.
 */
export const resolveApplicableDecision = (input) => {
  const outcome = applicableDecisionOutcome(input);
  if (outcome.state !== "APPROVED_APPLICABLE") {
    throw new Error(outcome.message);
  }
  recordConsumedDecision(outcome.decision, outcome.authority);
  return outcome.decision;
};

/**
 * The complete group entry covering this candidate, re-derived and re-digested
 * rather than believed.
 *
 * A group line carries its whole ordered member set in `boundTo.members`, with
 * each member's own evidence binding, and the group candidate's digest covers
 * all of it. So the set is rebuilt from the line, bound to the *trusted* policy
 * resolved now (never to the identity the line asserts), and its digest
 * compared with the one the line was signed over. A line whose membership was
 * edited, reordered, extended or trimmed digests to something else and is not
 * authority for anyone.
 *
 * Returns the rebuilt group candidate -- the thing the caller then resolves
 * against -- so one group yields one decision and one consumed identity, never
 * a per-member subset.
 */
export const groupAuthorityFor = async (decisions, candidate, label) => {
  const lines = decisions.filter(
    (decision) =>
      decision?.v === 2 &&
      decision.kind === DECISION_GROUP_KIND &&
      (decision.boundTo?.members ?? []).some((fact) => fact?.id === candidate.id),
  );
  if (lines.length === 0) return null;
  if (lines.length > 1) {
    throw new Error(
      `${label} is covered by ${lines.length} group entries (${lines
        .map((decision) => `${decision.id} ${decision.result}`)
        .join(", ")}). One reviewed group act is one authoritative entry; duplicate or conflicting group outcomes fail closed.`,
    );
  }
  const [line] = lines;
  const { members: facts, lifecycle, groupKind, ...binding } = line.boundTo ?? {};
  if (groupKind !== "DECISION_CANDIDATES" || !Array.isArray(facts) || facts.length < 2) {
    throw new Error(
      `${label} cites group entry '${line.id}', whose membership is not a well-formed decision group. A malformed group is never partially authoritative.`,
    );
  }
  const rebuilt = await createNewFormatDecisionCandidate({
    projectRoot: candidate.projectRoot,
    policyKind: facts[0]?.kind,
    ...groupCandidateInput({ first: facts[0], binding, lifecycle, facts }),
  });
  if (candidateDigestOf(rebuilt) !== line.candidateDigest) {
    throw new Error(
      `${label} cites group entry '${line.id}', whose recorded member set does not re-derive to the candidate digest it was decided over (${line.candidateDigest}). The group's membership or policy binding changed after the decision; nothing in it is authoritative.`,
    );
  }
  const fact = facts.find((entry) => entry.id === candidate.id);
  const current = {
    ...decisionGroupMemberFact(candidate),
    boundTo: candidate.boundTo ?? null,
  };
  if (JSON.stringify(fact) !== JSON.stringify(current)) {
    throw new Error(
      `${label} is a member of group '${line.id}', but its evidence binding has changed since the group was decided. A member's facts are part of the group's digest; re-review the group.`,
    );
  }
  return rebuilt;
};

/**
 * The one dispatch every module decision gate goes through, so a new caller
 * cannot pick the wrong authority by picking the wrong helper. Pre-19 records
 * keep `requireDecision` byte for byte; 19 and later resolve directly.
 */
export const requireModuleDecision = async ({
  state,
  byId,
  decisions,
  row,
  label,
  candidate,
}) => {
  if (!usesDirectLedgerDecisions(state)) {
    return requireDecision({ byId, row, label, candidate });
  }
  const group = candidate
    ? await groupAuthorityFor(decisions, candidate, label)
    : null;
  return resolveApplicableDecision({ decisions, candidate, label, group, row });
};

/**
 * The projected state of one format-19 candidate: the same resolution the gate
 * enforces, reported instead of thrown.
 *
 * A grouped member is resolved through its complete group entry, and the view
 * says so -- `group` names the one authoritative candidate, so a member can be
 * read as approved only because the group was, never on a line of its own. The
 * group lookup is the same `groupAuthorityFor` the gate uses, which re-derives
 * the recorded member set and refuses a membership that changed.
 *
 * Nothing is cached: the ledger is re-read by the caller on every projection,
 * so an append made a millisecond ago is visible without a restart.
 */
export const projectModuleDecision = async ({
  decisions,
  candidate,
  label,
  row = null,
}) => {
  const group = candidate
    ? await groupAuthorityFor(decisions, candidate, label)
    : null;
  const outcome = applicableDecisionOutcome({
    decisions,
    candidate,
    label,
    group,
    row,
  });
  return {
    state: outcome.state,
    reason: outcome.message,
    requiredPrincipal: candidate.requiredPrincipal ?? null,
    policyId: candidate.policyId ?? null,
    policyDigest: candidate.policyDigest ?? null,
    candidateDigest: candidateDigestOf(candidate),
    // The single authoritative entry this view is a projection of. Null when the
    // candidate is its own authority.
    group: group ? { id: group.id, candidateDigest: candidateDigestOf(group) } : null,
    principal: outcome.decision ? decisionPrincipalOf(outcome.decision) : null,
    result: outcome.decision?.result ?? null,
    // Engine audit only (§4): the projection reports which line it resolved, and
    // no record or agent ever cites it back as authority.
    decisionId: outcome.decision?.id ?? null,
    decisionDigest: outcome.decision ? decisionLineDigest(outcome.decision) : null,
  };
};

/**
 * The format-19 classification schema, and the one place it is enforced.
 *
 * `version: 2` keeps proposal, rationale, evidence and targets -- everything
 * the operator reviews -- and drops the authorization receipt entirely. A
 * record that authors `decisionId`/`decisionDigest` under direct authority is
 * making two incompatible claims about where authority lives, so it is refused
 * rather than silently resolved one way. Checked over the whole document, not
 * just the rows that happen to reach a gate: an unreached receipt is still an
 * ambiguous record, and the row it sits on may reach a gate tomorrow.
 *
 * Pre-19 documents are not touched: the receipt is their authority.
 */
export const assertDirectLedgerClassificationSchema = (classification, state) => {
  if (!usesDirectLedgerDecisions(state)) return;
  if (classification.version !== 2) {
    throw new LegacyCompatibilityActionRequired(
      `Module classification declares version ${JSON.stringify(classification.version ?? null)}, but a format-${DIRECT_LEDGER_DECISIONS_FORMAT} record authors version 2, whose authority is resolved from the ledger rather than cited in the file. Resume this record under its historical citation rules, or author a version 2 classification before adopting direct ledger decisions.`,
    );
  }
  const bearers = [
    ...(Array.isArray(classification.moduleRoots) ? classification.moduleRoots : []).map(
      (row, index) => [`moduleRoots[${index}]`, row],
    ),
    ...(Array.isArray(classification.files) ? classification.files : []).map(
      (row, index) => [`files[${index}]`, row],
    ),
    ...(Array.isArray(classification.findings) ? classification.findings : []).map(
      (row, index) => [`findings[${index}]`, row],
    ),
  ].filter(
    ([, row]) =>
      isPlainObject(row) &&
      (row.decisionId !== undefined || row.decisionDigest !== undefined),
  );
  if (bearers.length > 0) {
    throw new Error(
      `Module classification version 2 carries authorization receipts on ${bearers
        .map(([at]) => at)
        .join(", ")}. A format-${DIRECT_LEDGER_DECISIONS_FORMAT} record never authors decisionId or decisionDigest: authority is resolved from the verified ledger against the current candidate digest. Remove the receipt fields.`,
    );
  }
};

/**
 * The brand an operation-sequence authorization carries, and the only channel
 * through which an `authorizedBy` can reach a `SLICE_SCOPE_AMENDED` event.
 *
 * A module-private Symbol is not expressible in argv, in JSON-RPC tool input,
 * in an environment variable, or in anything `--mode auto` computes: every one
 * of those carries strings and plain objects, and a plain object parsed from
 * any of them cannot hold this key. So the only constructor is
 * `brandSequenceAuthorization`, which `operation-sequence.mjs` reaches only
 * after the trusted approval boundary has matched a human-typed phrase against
 * the sequence it freshly derived.
 *
 * `maySelfConfirm` is untouched and still false for `--amend-slice`: this does
 * not make an amendment self-confirmable, it makes *one* human act cover an
 * ordered set of them, each still re-derived and re-proven under the lock.
 *
 * ponytail: an unforgeable in-process reference, not a signature -- the same
 * ceiling as `record-decision.mjs`'s `ask`, and for the same reason. Upgrade
 * path: a detached signature over the sequence facts, verified against a key
 * pinned at RESOLVE.
 */
export const SEQUENCE_AUTHORIZATION = Symbol("start-migration/operation-sequence");

export const brandSequenceAuthorization = (evidence) =>
  Object.freeze({ [SEQUENCE_AUTHORIZATION]: Object.freeze({ ...evidence }) });

/**
 * The evidence one executed member records, or a refusal.
 *
 * Absent in, absent out: a single `--amend-slice` confirmed at a terminal is
 * still one operator act and still writes its event, it just has no sequence to
 * cite. Anything else present but unbranded is a caller trying to author the
 * audit field itself, which is exactly what the Symbol exists to refuse.
 */
export const sequenceAuthorizationEvidence = (authorization) => {
  if (authorization === null || authorization === undefined) return null;
  const evidence = authorization[SEQUENCE_AUTHORIZATION];
  if (!evidence) {
    throw new Error(
      "An operation authorization must be branded by the trusted approval boundary; a plain object is not one. Nothing was written.",
    );
  }
  return evidence;
};

// Artifact 14 authority is individual only: a group line never projects onto an artifact candidate.
export const projectArtifactDecision = (input) => projectModuleDecision({
  ...input, decisions: input.decisions.filter((line) => line?.kind !== DECISION_GROUP_KIND),
});

export const consumedFrom = (rows) => rows.filter((row) => row.satisfied).map(({ projection }) => ({
  candidateDigest: projection.candidateDigest,
  decisionId: projection.decisionId,
  decisionDigest: projection.decisionDigest,
  policyId: projection.policyId,
  policyDigest: projection.policyDigest,
  principal: projection.principal,
  result: projection.result,
})).sort((left, right) => left.decisionId.localeCompare(right.decisionId));

export const verifyConsumedHistory = async (root, state, history) => {
  const consumedEvents = history.events.filter((event) => Object.hasOwn(event, "consumedDecisions"));
  if (!usesArtifactDirectLedger(state.formatVersion)) {
    if (consumedEvents.length || history.events.some((event) => Object.hasOwn(event, "decisionLedgerPrefixes"))) {
      throw new Error("Artifact 13 history cannot contain consumed decisions.");
    }
    return;
  }
  if (history.events.some((event) => Object.hasOwn(event, "decisionLedgerPrefixes") !==
      Object.hasOwn(event, "consumedDecisions"))) {
    throw new Error("Consumed decision history is missing its identity or ledger prefix.");
  }
  for (const [step, file, key] of [
    ["DISCOVER_LEGACY", "inventories/source.json", "operatorDecisions"],
    ["BUILD_BASELINE", VISUAL_ACCEPTANCE_FILE, "unbacked"],
  ]) {
    const event = history.events.find((entry) => entry.from === step && entry.event === "ADVANCED");
    if (!event) continue;
    if (step === "BUILD_BASELINE" && !Object.hasOwn(state.artifactHashes, file)) {
      if (event.consumedDecisions?.length) throw new Error("Unpinned visual evidence cannot consume decisions.");
      continue;
    }
    const document = await readJsonAt(root, file, `${step} decision evidence`);
    if (!Array.isArray(document[key]) || document[key].length !== (event.consumedDecisions?.length ?? 0)) {
      throw new Error(`${step} committed history is missing consumed decision identities.`);
    }
  }
  if (!consumedEvents.length) return;
  const ledgers = await readRecordedDecisions(root);
  for (const event of consumedEvents) {
    const previous = history.events[event.seq - 2];
    if (!["DISCOVER_LEGACY", "BUILD_BASELINE"].includes(event.from) ||
        event.event !== "ADVANCED" ||
        event.to !== (event.from === "DISCOVER_LEGACY" ? "DISCOVERY_COMPLETENESS" : "PLAN") ||
        previous?.to !== event.from || previous.revision !== event.revision - 1) {
      throw new Error("Consumed decisions belong only to a decision-bearing checkpoint.");
    }
    const prefixes = event.decisionLedgerPrefixes;
    exactObject(prefixes, "decision ledger prefixes", ["operator", "auto"]);
    const accepted = {};
    for (const [key, file] of [["operator", DECISIONS_FILE], ["auto", AUTO_DECISIONS_FILE]]) {
      const prefix = prefixes[key];
      exactObject(prefix, `${key} ledger prefix`, ["bytes", "sha256"]);
      if (!Number.isSafeInteger(prefix.bytes) || prefix.bytes < 0 || !/^[a-f0-9]{64}$/.test(prefix.sha256)) {
        throw new Error("Consumed decision ledger prefix is malformed.");
      }
      const content = await readFile(path.join(root, file), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const bytes = Buffer.from(content);
      if (bytes.length < prefix.bytes || sha256(bytes.subarray(0, prefix.bytes)) !== prefix.sha256 ||
          (prefix.bytes && bytes[prefix.bytes - 1] !== 10)) {
        throw new Error("Consumed decision ledger prefix/head no longer matches.");
      }
      accepted[key] = new Set(bytes.subarray(0, prefix.bytes).toString("utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line).id));
    }
    const identities = arrayOf(event.consumedDecisions, "consumedDecisions");
    if (!identities.length || ![...identities.map((item) => item.decisionId)].every((id, index, ids) =>
      typeof id === "string" && (index === 0 || ids[index - 1] < id))) {
      throw new Error("Consumed decisions must be nonempty, unique and ordered.");
    }
    for (const identity of identities) {
      exactObject(identity, "consumed decision", ["candidateDigest", "decisionId", "decisionDigest", "policyId", "policyDigest", "principal", "result"]);
      const line = ledgers.byId.get(identity.decisionId);
      const requiredPrincipal = line && await resolveHistoricalRequiredPrincipal(
        line.kind, state.target.root, line.policyId, line.policyDigest);
      const historicalCandidate = line && {
        id: line.candidateId, kind: line.kind, subject: line.subject,
        rationaleDigest: line.rationaleDigest, targets: line.targets, boundTo: line.boundTo,
        projectRoot: state.target.root, policyId: line.policyId, policyDigest: line.policyDigest,
        requiredPrincipal,
      };
      if (!line || !accepted.operator.has(identity.decisionId) || line.v !== 2 ||
          line.result !== "APPROVED" || identity.result !== "APPROVED" ||
          !requiredPrincipal || !decisionAppliesToCandidate(line, historicalCandidate) ||
          identity.candidateDigest !== line.candidateDigest ||
          identity.decisionDigest !== decisionLineDigest(line) ||
          identity.policyId !== line.policyId || identity.policyDigest !== line.policyDigest ||
          identity.principal !== line.principal ||
          line.boundTo?.artifactId !== state.artifactId || !usesArtifactDirectLedger(line.boundTo?.formatVersion) ||
          line.boundTo?.currentStep !== event.from || line.boundTo?.revision !== event.revision - 1 ||
          line.kind !== (event.from === "DISCOVER_LEGACY" ? "ARTIFACT_DECISION" : "VISUAL_UNBACKED")) {
        throw new Error("Consumed decision identity is not proven by its accepted ledger prefix.");
      }
    }
  }
};
