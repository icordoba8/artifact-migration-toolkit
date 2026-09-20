#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";

import { resolveRegistryPath } from "../migration-utils.mjs";
import {
  assertOptionCombination,
  exitCodeFor,
  maySelfConfirm,
  nextOutcome,
} from "../migration-policy.mjs";
import {
  advanceMigration,
  DEFAULT_MODE,
  previewAdvance,
  renderAdvancePreview,
  renderLoopDirective,
  renderProgressChecklist,
} from "../resumable-migration.mjs";

export const parseAdvanceArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      "confirm-advance": { type: "string" },
      mode: { type: "string" },
      registry: { type: "string" },
      slice: { type: "string" },
      step: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: advance-migration.mjs <module> [--registry <path>] [--step <step>] [--slice <id>] [--mode auto|step] [--confirm-advance <id>]",
    );
  }
  assertOptionCombination("advance", { positionals, values });
  return {
    moduleName: positionals[0],
    mode: values.mode,
    step: values.step,
    slice: values.slice,
    confirmAdvance: values["confirm-advance"],
    registryOption: values.registry,
  };
};

const directive = (options, outcome, emit) =>
  emit
    ? renderLoopDirective({ moduleName: options.moduleName, mode: options.mode, outcome })
    : "";

/**
 * Same defaulted seams as `runDiscoverCli`: `emitDirective` (`03` D3-3) and
 * `stdout` (`06` D6-5, so the MCP transport can keep `process.stdout`).
 */
export const runAdvanceCli = async (
  arguments_,
  { emitDirective = true, stdout = process.stdout } = {},
) => {
  const options = parseAdvanceArguments(arguments_);
  Object.assign(
    options,
    await resolveRegistryPath({
      cliPath: options.registryOption,
      moduleName: options.moduleName,
    }),
  );
  const preview = await previewAdvance(options);
  stdout.write(renderAdvancePreview(preview));
  if (preview.nextWorkKind === "RUN_ARTIFACT") {
    stdout.write(preview.progressChecklist);
    stdout.write(
      `Artifact prerequisite: ${preview.artifactMigration.command}\n`,
    );
    stdout.write(directive(options, "CONTINUE", emitDirective));
    process.exitCode = exitCodeFor("CONTINUE");
    return { preview, delegated: true };
  }
  if (preview.outcome === "OPERATOR_DECISION") {
    stdout.write(preview.progressChecklist);
    for (const decision of preview.pendingDecisions ?? []) {
      stdout.write(`${decision.command}\n`);
    }
    stdout.write(directive(options, "OPERATOR_DECISION", emitDirective));
    process.exitCode = exitCodeFor("OPERATOR_DECISION");
    return { preview, blocked: true };
  }
  if (!preview.requiresConfirmation) {
    const { outcome } = nextOutcome({ preview });
    // Same reason as the discover CLI: a refused advance is exactly when the
    // operator most needs to see where the migration actually stands.
    stdout.write(preview.progressChecklist);
    stdout.write(
      "Advance: BLOCKED. No state, history, or artifact was modified.\n",
    );
    stdout.write(directive(options, outcome, emitDirective));
    process.exitCode = exitCodeFor(outcome);
    return { preview, blocked: true };
  }
  const confirmation =
    options.confirmAdvance ??
    (maySelfConfirm({ command: "advance", mode: options.mode, preview })
      ? preview.confirmationId
      : null);
  if (!confirmation) {
    stdout.write(
      `Confirmation ID: ${preview.confirmationId}\n` +
        "Proceed with this advance? Reply Yes or No. No execution has started.\n",
    );
    stdout.write(
      directive(options, nextOutcome({ preview }).outcome, emitDirective),
    );
    return { preview, awaitingConfirmation: true };
  }
  const result = await advanceMigration({
    ...options,
    confirmAdvance: confirmation,
  });
  stdout.write(
    `Completed: ${result.completedStep}` +
      `${result.completedSlice ? ` (${result.completedSlice})` : ""}\n` +
      `Current step: ${result.state.currentStep}\n` +
      `Next artifact: ${result.nextArtifact ?? "none"}\n`,
  );
  stdout.write(
    renderProgressChecklist(result.state, options.mode ?? DEFAULT_MODE),
  );
  // The advance is the end of an iteration, so this is where the loop is told
  // to run again. `COMPLETE` is the only success that stops it.
  stdout.write(
    directive(options, nextOutcome({ preview, result }).outcome, emitDirective),
  );
  return { preview, result };
};

if (isMainModule(import.meta.url)) {
  // No directive on this path: a throw exits non-zero, and a non-zero exit with
  // no `loop:` line already means stop. Printing one would also put output on
  // stdout for a usage error that must stay silent there.
  runAdvanceCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
