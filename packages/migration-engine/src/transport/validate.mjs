import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveRegistryPath } from "../store/index.mjs";
import { assertOptionCombination } from "./arguments.mjs";
import { BLOCKED_EXIT_CODE, captureLegacyRuntimeEvidence, prefillCheckpointDraft, previewEvidenceBinding, runAppRuntime, validateResumableMigration } from "../lifecycle/index.mjs";

export const parseValidateArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      "app-runtime": { type: "string" },
      capture: { type: "string" },
      complete: { type: "boolean", default: false },
      "evidence-binding": { type: "boolean", default: false },
      prefill: { type: "boolean", default: false },
      reference: { type: "string", multiple: true },
      registry: { type: "string" },
      slice: { type: "string" },
      step: { type: "string" },
    },
  });
  if (
    positionals.length > 1 ||
    ((values.complete || values.step || values["evidence-binding"] || values.prefill || values.capture || values["app-runtime"]) && positionals.length !== 1) ||
    [values.complete, values.step, values["evidence-binding"], values.prefill, values.capture, values["app-runtime"]].filter(Boolean).length > 1 ||
    ((values["evidence-binding"] || values.prefill || values.capture || values["app-runtime"]) && values.slice) ||
    (values.reference && !values["evidence-binding"])
  ) {
    throw new Error(
      "Usage: validate-migration.mjs [<module>] [--registry <path>] [--step <step> [--slice <id>] | --complete | --evidence-binding [--reference <path>]... | --prefill | --capture <request.json> | --app-runtime check|ensure|stop]",
    );
  }
  assertOptionCombination("validate", { positionals, values });
  return {
    moduleName: positionals[0],
    complete: values.complete,
    evidenceBinding: values["evidence-binding"],
    prefill: values.prefill,
    capture: values.capture,
    appRuntime: values["app-runtime"],
    references: values.reference ?? [],
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
  if (options.evidenceBinding) {
    // QW3: the same reader `migration_evidence_binding` uses; read-only.
    const binding = await previewEvidenceBinding(options);
    process.stdout.write(`${JSON.stringify(binding, null, 2)}\n`);
    return binding;
  }
  if (options.prefill) {
    // MC1: the one writing mode -- the same call as `migration_prefill`.
    const summary = await prefillCheckpointDraft(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
  if (options.capture) {
    // MC2: the same call as `migration_capture`; the request is the JSON file's content.
    const request = JSON.parse(await readFile(path.resolve(options.capture), "utf8"));
    const summary = await captureLegacyRuntimeEvidence({ ...options, request });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
  if (options.appRuntime) {
    // The same call as `migration_app_runtime`; the JSON is the answer, the exit code its summary.
    const report = await runAppRuntime({ ...options, action: options.appRuntime });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.state !== undefined && report.state !== "READY" && report.state !== "NOT_REQUIRED") process.exitCode = BLOCKED_EXIT_CODE;
    return report;
  }
  const result = await validateResumableMigration(options);
  const message = result.complete
    ? `Complete ${result.module} -> ${result.target}`
    : result.module
      ? `Valid ${result.step} for ${result.module} -> ${result.target}`
        : `Valid registry (${result.modules.length} modules)`;
  process.stdout.write(`${message}\n`);
};
