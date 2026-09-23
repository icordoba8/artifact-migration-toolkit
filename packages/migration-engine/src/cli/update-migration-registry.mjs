#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";
import { maySelfConfirm, MIGRATION_MODES } from "../migration-policy.mjs";
import {
  previewRegistryUpdate,
  renderRegistryPreview,
  resolveRegistryPath,
  updateRegistry,
} from "../migration-utils.mjs";

export const parseRegistryArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      alias: { type: "string", multiple: true, default: [] },
      "confirm-execution": { type: "string" },
      mode: { type: "string" },
      registry: { type: "string" },
      target: { type: "string" },
    },
  });
  if (positionals.length !== 1 || !values.target) {
    throw new Error(
      "Usage: update-migration-registry.mjs <module> --target <target> [--registry <path>] [--alias <alias>] [--mode auto|step]",
    );
  }
  if (values.mode && !MIGRATION_MODES.includes(values.mode)) {
    throw new Error("--mode accepts 'auto' or 'step'.");
  }
  return {
    moduleName: positionals[0],
    target: values.target,
    aliases: values.alias,
    confirmExecution: values["confirm-execution"],
    mode: values.mode,
    registryOption: values.registry,
  };
};

export const runRegistryCli = async (arguments_) => {
  const options = parseRegistryArguments(arguments_);
  Object.assign(
    options,
    await resolveRegistryPath({
      cliPath: options.registryOption,
      moduleName: options.moduleName,
    }),
  );
  const preview = await previewRegistryUpdate(options);
  process.stdout.write(renderRegistryPreview(preview));
  // Registration answers to the same policy as every other command: under
  // `auto` the process confirms its own preview, under `step` a human does. It
  // used to be the one hard-coded `false`, which made an unattended bootstrap
  // stop at the most mechanical transition in the toolkit.
  const confirmation =
    options.confirmExecution ??
    (maySelfConfirm({ command: "registry", mode: options.mode })
      ? preview.confirmationId
      : null);
  if (!confirmation) {
    process.stdout.write(
      `Confirmation ID: ${preview.confirmationId}\n` +
        "Mode: step — awaiting explicit confirmation. No execution has started.\n",
    );
    return { preview, awaitingConfirmation: true };
  }
  // The confirmation the policy just decided on, not the one argv carried:
  // under `auto` those differ, and `updateRegistry` re-verifies whichever it is
  // given against its own freshly computed preview either way.
  const result = await updateRegistry({ ...options, confirmExecution: confirmation });
  process.stdout.write(
    `${result.changed ? "Updated" : "Unchanged"} ${result.moduleName} -> ${result.target}\n`,
  );
  return { preview, result };
};

if (isMainModule(import.meta.url)) {
  runRegistryCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
