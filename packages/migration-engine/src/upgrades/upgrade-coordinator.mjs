// Track A8 compatibility facade: the contract-upgrade transaction lives in
// lifecycle/contract-upgrade.mjs. Every BASE export is kept, as the same
// bindings.
// Compatibility re-export (Track A2): these names are formats-owned now.
export { renderRollbackPreview, renderUpgradePreview } from "../formats/index.mjs";
export {
  executeRollback,
  executeUpgrade,
  pendingTransactions,
  previewRollback,
  previewUpgrade,
  recoverTransaction,
  recoverUpgrade,
  TRANSACTION_STATES,
} from "../lifecycle/index.mjs";
