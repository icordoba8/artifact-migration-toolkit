// Track A8 compatibility facade: the mode and outcome policy lives in
// lifecycle/policy.mjs. Every BASE export is kept, as the same bindings.
export {
  exitCodeFor,
  isAutoAuthority,
  maySelfConfirm,
  MIGRATION_MODES,
  MIGRATION_OUTCOMES,
  nextOutcome,
} from "./lifecycle/index.mjs";
