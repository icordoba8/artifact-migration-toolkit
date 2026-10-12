// Track A8 compatibility facade: the module lock lives in lifecycle/lock.mjs.
// Every BASE export is kept, as the same bindings.
export {
  acquireModuleLock,
  lockPathFor,
  processAlive,
  withModuleLock,
  writeJournalAtomic,
} from "./lifecycle/index.mjs";
