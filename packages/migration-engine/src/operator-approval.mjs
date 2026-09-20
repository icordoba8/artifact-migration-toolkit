import { decisionLineDigest } from "./resumable-migration.mjs";
import { runRecordDecisionCli } from "./record-decision.mjs";

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

export const recorderFor = ({ recordTrustedDecision }) => {
  if (recordTrustedDecision !== undefined) return recordTrustedDecision;
  return process.stdin.isTTY && process.stdout.isTTY
    ? terminalDecisionRecorder
    : null;
};

export const moduleApprover = (record, moduleName) =>
  record
    ? (candidateId) => record([moduleName, "--approve", candidateId])
    : null;

export const artifactApprover = (record, binding) =>
  record
    ? (candidateId) =>
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
        ])
    : null;

/** One offered candidate per human act; a group is one atomic candidate. */
export const approveWithOperator = async (
  candidates,
  approver,
  stdout,
  references,
  group = null,
) => {
  if (!approver) {
    stdout?.write(renderCandidateBlock(candidates, group));
    return [];
  }
  const offered = group ?? candidates[0];
  if (!offered) return [];
  const result = await approver(offered.id);
  const decisions = result?.decisions ?? (result?.decision ? [result.decision] : []);
  for (const decision of decisions) {
    references.push({
      candidateId: decision.candidateId,
      subject: decision.subject,
      decisionId: decision.id,
      decisionDigest: decisionLineDigest(decision),
    });
  }
  return decisions.map((decision) => decision.id);
};
