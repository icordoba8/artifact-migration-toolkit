// The `artifact-migration-upgrade` command (Track A7: transport). It parses argv,
// prints the previews and the stop lines, and drives the coordinator in
// `upgrades/upgrade-coordinator.mjs`, which owns the transaction.

import { parseArgs } from "node:util";

import { renderRollbackPreview, renderUpgradePreview } from "../formats/index.mjs";
import { resolveRegistryPath } from "../store/index.mjs";
import {
  executeRollback,
  executeUpgrade,
  previewRollback,
  previewUpgrade,
  recoverUpgrade,
} from "../upgrades/upgrade-coordinator.mjs";

export const parseUpgradeArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      "confirm-upgrade": { type: "string" },
      "confirm-rollback": { type: "string" },
      recover: { type: "boolean", default: false },
      registry: { type: "string" },
      rollback: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: upgrade-migration.mjs <module> [--registry <path>] [--confirm-upgrade <id> | --rollback [--confirm-rollback <id>] | --recover]",
    );
  }
  const modes = [
    values.recover,
    values.rollback || Boolean(values["confirm-rollback"]),
    Boolean(values["confirm-upgrade"]),
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new Error(
      "Choose one of --confirm-upgrade, --rollback, or --recover.",
    );
  }
  return {
    moduleName: positionals[0],
    confirmUpgrade: values["confirm-upgrade"],
    confirmRollback: values["confirm-rollback"],
    recover: values.recover,
    rollback: values.rollback || Boolean(values["confirm-rollback"]),
    registryOption: values.registry,
  };
};

export const runUpgradeCli = async (arguments_) => {
  const options = parseUpgradeArguments(arguments_);
  Object.assign(
    options,
    await resolveRegistryPath({
      cliPath: options.registryOption,
      moduleName: options.moduleName,
    }),
  );
  if (options.recover) {
    const result = await recoverUpgrade(options);
    process.stdout.write(
      result.clean
        ? `No unfinished upgrade transaction exists for ${result.migration}.\n`
        : `${result.recovered.map((entry) => `Recovered from ${entry.from}: ${entry.outcome}`).join("\n")}\n`,
    );
    return result;
  }
  if (options.rollback) {
    const preview = await previewRollback(options);
    process.stdout.write(renderRollbackPreview(preview));
    if (!preview.requiresConfirmation) {
      process.stdout.write(
        "Rollback: BLOCKED. No file, state, history, snapshot, or archive was modified.\n",
      );
      return { preview, blocked: true };
    }
    if (!options.confirmRollback) {
      process.stdout.write(
        `Confirmation ID: ${preview.confirmationId}\n` +
          "Awaiting explicit confirmation of this rollback. No execution has started.\n",
      );
      return { preview, awaitingConfirmation: true };
    }
    const result = await executeRollback(options);
    process.stdout.write(
      `Restored ${result.migration} from upgrade ${result.restoredUpgrade}\n` +
        `Snapshot of the replaced tree: ${result.snapshotPath}\n` +
        "Stop: restoration is the only action for this invocation. Contract 5 refuses the restored tree until it is upgraded again.\n",
    );
    return { preview, result };
  }
  const preview = await previewUpgrade(options);
  process.stdout.write(renderUpgradePreview(preview));
  if (!preview.requiresConfirmation) {
    process.stdout.write(
      "Upgrade: BLOCKED. No file, state, history, snapshot, or archive was modified.\n",
    );
    return { preview, blocked: true };
  }
  if (!options.confirmUpgrade) {
    process.stdout.write(
      `Confirmation ID: ${preview.confirmationId}\n` +
        "Awaiting explicit confirmation of this upgrade. No execution has started.\n",
    );
    return { preview, awaitingConfirmation: true };
  }
  const result = await executeUpgrade(options);
  process.stdout.write(
    `Upgraded ${result.migration} to contract ${result.targetVersions.contractVersion} format ${result.targetVersions.formatVersion}\n` +
      `Reopened step: ${result.reopenedStep ?? "none"}\n` +
      `Snapshot: ${result.snapshotPath}\n` +
      `Stop: the upgrade is the only action for this invocation. Run /start-migration ${result.migration} to continue.\n`,
  );
  return { preview, result };
};
