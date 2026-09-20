#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";
import { maySelfConfirm } from "../migration-policy.mjs";
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
      registry: { type: "string" },
      target: { type: "string" },
    },
  });
  if (positionals.length !== 1 || !values.target) {
    throw new Error(
      "Usage: update-migration-registry.mjs <module> --target <target> [--registry <path>] [--alias <alias>]",
    );
  }
  return {
    moduleName: positionals[0],
    target: values.target,
    aliases: values.alias,
    confirmExecution: values["confirm-execution"],
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
  // Registration is never self-confirmed, in any mode: `maySelfConfirm` answers
  // `false` for this command by rule, not by the absence of a branch.
  const confirmation =
    options.confirmExecution ??
    (maySelfConfirm({ command: "registry", mode: options.mode, preview })
      ? preview.confirmationId
      : null);
  if (!confirmation) {
    process.stdout.write(
      `Confirmation ID: ${preview.confirmationId}\n` +
        "Proceed with this registration? Reply Yes or No. No execution has started.\n",
    );
    return { preview, awaitingConfirmation: true };
  }
  const result = await updateRegistry(options);
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
