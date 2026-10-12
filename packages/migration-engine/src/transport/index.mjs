// The transport module's one public entry (Track A7). It only re-exports.
export { assertOptionCombination } from "./arguments.mjs";
export { reportFailure, startCommand } from "./entry.mjs";
export {
  normalizePonytailArgument,
  parseDiscoverArguments,
  renderExecutionPreview,
  runDiscoverCli,
} from "./discover.mjs";
export { parseAdvanceArguments, runAdvanceCli } from "./advance.mjs";
export {
  decisionCandidates,
  parseRunArguments,
  renderAuthoringRequest,
  runMigration,
} from "./run.mjs";
export { parseValidateArguments, runValidateCli } from "./validate.mjs";
export { parseRegistryArguments, runRegistryCli } from "./registry.mjs";
export { parseToolkitIdentityArguments, runToolkitIdentityCli } from "./toolkit-identity.mjs";
export { artifactDirective, parseArtifactArguments, runArtifactCli } from "./artifact.mjs";
export { approvalShapedArgument, createSession, handleMessage, serve } from "./mcp.mjs";
export { parseUpgradeArguments, runUpgradeCli } from "./upgrade.mjs";
