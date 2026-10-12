// Track A8 compatibility facade: the operator offer loop and recorders live in
// lifecycle/approval.mjs. Every BASE export is kept, as the same bindings.
// Compatibility re-export (Track A3): the offer renderers are decisions-owned now.
export { renderCandidateBlock, renderGroupBlock } from "./decisions/index.mjs";
export {
  approveWithOperator,
  artifactApprover,
  moduleApprover,
  recorderFor,
} from "./lifecycle/index.mjs";
