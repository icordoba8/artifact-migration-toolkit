#!/usr/bin/env node

// The installed `artifact-migration-upgrade` command (Track A7 facade). The
// transaction is `upgrade-coordinator.mjs`; the argv and output are transport's,
// in `transport/upgrade.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runUpgradeCli } from "../transport/upgrade.mjs";

export * from "./upgrade-coordinator.mjs";
export { parseUpgradeArguments, runUpgradeCli } from "../transport/upgrade.mjs";

startCommand(import.meta.url, runUpgradeCli);
