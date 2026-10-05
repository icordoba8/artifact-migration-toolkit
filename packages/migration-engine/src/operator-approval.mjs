import {
  decisionLineDigest,
  isAutoAuthority,
} from "./resumable-migration.mjs";
import { autoApprovalChannel, renderDecisionReview, runRecordDecisionCli } from "./record-decision.mjs";

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

const terminalDecisionRecorder = (arguments_) =>
  runRecordDecisionCli(arguments_);

const AUTO_REASON =
  "Decided under --mode auto from repository evidence: the candidate was " +
  "recomputed under the module lock and the line is bound to its current digests.";

const autoDecisionRecorder = Object.assign(
  (arguments_) =>
    runRecordDecisionCli(arguments_, { ask: autoApprovalChannel(AUTO_REASON) }),
  { channel: "AUTO" },
);

/**
 * Which principal answers this process's challenges.
 *
 * A caller-supplied channel wins: the MCP adapter passes one only after the
 * client declared `elicitation`, and that is a real human. Otherwise `auto`
 * answers on the engine's own authority -- ahead of the TTY probe, because the
 * whole contract of `--mode auto` is that it does not stop to ask, and a run
 * that happens to have a terminal attached must not behave differently from one
 * that does not. `step` keeps the old behaviour exactly: a TTY, or nothing.
 */
export const recorderFor = ({ recordTrustedDecision, mode, directLedger = false } = {}) => {
  if (typeof recordTrustedDecision === "function") return recordTrustedDecision;
  if (!directLedger && isAutoAuthority(mode)) return autoDecisionRecorder;
  if (recordTrustedDecision !== undefined) return recordTrustedDecision;
  return process.stdin.isTTY && process.stdout.isTTY
    ? terminalDecisionRecorder
    : null;
};

/**
 * The approver carries the principal that will answer its challenges, so
 * `approveWithOperator` can ask how many candidates one act may cover without
 * being handed the mode at four call sites.
 */
const carryChannel = (record, approve) =>
  record ? Object.assign(approve, { channel: record.channel ?? null }) : null;

export const moduleApprover = (record, moduleName) =>
  carryChannel(record, (candidateId) =>
    record([moduleName, "--approve", candidateId]),
  );

export const artifactApprover = (record, binding) =>
  carryChannel(record, (candidateId) =>
    record([
      "--artifact",
      binding.source,
      "--type",
      binding.type,
      "--source-root",
      binding.sourceRoot,
      "--target-root",
      binding.targetRoot,
      "--approve",
      candidateId,
    ]),
  );

/**
 * One offered candidate per human act; a group is one atomic candidate.
 *
 * That cap exists so a human is never asked to assent to a batch they cannot
 * read. Under `AUTO` there is no human to protect from a batch, and the
 * protection the cap stood in for is still enforced per candidate regardless:
 * each one is recomputed under the module lock, deep-equality checked, and
 * bound to its own digests. So `AUTO` drains the queue in one iteration instead
 * of stopping at `OPERATOR_DECISION` with a remainder that no one is coming to
 * approve. Any candidate that stops being approvable simply stops being
 * recorded -- the loop ends on the first one the recorder declines.
 */
export const approveWithOperator = async (
  candidates,
  approver,
  stdout,
  references,
  group = null,
) => {
  if (!approver) {
    stdout?.write(candidates[0]?.review
      ? renderDecisionReview(group?.review ?? candidates[0].review)
      : renderCandidateBlock(candidates, group));
    return [];
  }
  const record = async (offered) => {
    const result = await approver(offered.id);
    const decisions =
      result?.decisions ?? (result?.decision ? [result.decision] : []);
    for (const decision of decisions.filter((entry) => entry.v !== 2)) {
      references.push({
        candidateId: decision.candidateId,
        subject: decision.subject,
        decisionId: decision.id,
        decisionDigest: decisionLineDigest(decision),
      });
    }
    return decisions.map((decision) => decision.id);
  };
  const first = group ?? candidates[0];
  if (!first) return [];
  const recorded = await record(first);
  if (approver.channel !== "AUTO" || recorded.length === 0) return recorded;
  // A group act covers several candidates at once, so "what is left" is read
  // off the references just written rather than assumed to be `slice(1)`.
  const covered = () => new Set(references.map((reference) => reference.candidateId));
  let done = covered();
  for (const candidate of candidates) {
    if (done.has(candidate.id)) continue;
    const more = await record(candidate);
    if (more.length === 0) break;
    recorded.push(...more);
    done = covered();
  }
  return recorded;
};
