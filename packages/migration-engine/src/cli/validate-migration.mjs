#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";
import { resolveRegistryPath } from "../migration-utils.mjs";
import { assertOptionCombination } from "../migration-policy.mjs";
import { validateResumableMigration } from "../resumable-migration.mjs";

export const parseValidateArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      complete: { type: "boolean", default: false },
      registry: { type: "string" },
      slice: { type: "string" },
      step: { type: "string" },
    },
  });
  if (
    positionals.length > 1 ||
    ((values.complete || values.step) && positionals.length !== 1) ||
    [values.complete, values.step].filter(Boolean).length > 1
  ) {
    throw new Error(
      "Usage: validate-migration.mjs [<module>] [--registry <path>] [--step <step> [--slice <id>] | --complete]",
    );
  }
  assertOptionCombination("validate", { positionals, values });
  return {
    moduleName: positionals[0],
    complete: values.complete,
    slice: values.slice,
    step: values.step,
    registryOption: values.registry,
  };
};

export const runValidateCli = async (arguments_) => {
  const options = parseValidateArguments(arguments_);
  Object.assign(
    options,
    await resolveRegistryPath({
      cliPath: options.registryOption,
      moduleName: options.moduleName,
    }),
  );
  const result = await validateResumableMigration(options);
  const message = result.complete
    ? `Complete ${result.module} -> ${result.target}`
    : result.module
      ? `Valid ${result.step} for ${result.module} -> ${result.target}`
        : `Valid registry (${result.modules.length} modules)`;
  process.stdout.write(`${message}\n`);
};

if (isMainModule(import.meta.url)) {
  runValidateCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
