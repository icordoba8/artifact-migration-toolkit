// Track A8 compatibility facade: the one decision recorder lives in
// lifecycle/recorder.mjs. Every BASE export is kept, as the same bindings.
export {
  APPROVAL_CHANNELS,
  APPROVAL_EVIDENCE_PHRASES,
  approvedByPhrase,
  assertReviewedCandidateCurrent,
  auditDecisionLedger,
  autoApprovalChannel,
  autoMayDecide,
  buildDecision,
  challengeFor,
  channelOf,
  DECISION_KINDS,
  groupFactsDigest,
  ledgerFileForChannel,
  rationaleDigestOf,
  renderDecisionReview,
  reviewFor,
  reviewReference,
  SIGNER_UNAVAILABLE,
} from "./decisions/index.mjs";
export {
  beginAttestedDecision,
  completeAttestedDecision,
  parseDecisionArguments,
  pendingDecisionCandidates,
  projectDecisions,
  recordNewFormatDecisionGroup,
  relayOperatorDecision,
  reviewAttestedCandidate,
  runRecordDecisionCli,
} from "./lifecycle/index.mjs";
