#!/usr/bin/env node

/**
 * The standalone artifact front end. It owns argument parsing and rendering,
 * and nothing else: mode validation, `--status` exclusivity, the closed outcome
 * set, exit codes and the loop directive all live in `migration-policy.mjs` and
 * `resumable-migration.mjs`, because a second front end that carries its own
 * copy of a rule is how the two answers drift apart. This file used to carry
 * four such copies, and one of them was already wrong.
 */

import path from "node:path";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";

import {
  assertOptionCombination,
  exitCodeFor,
  MIGRATION_OUTCOMES,
  renderLoopDirective,
  renderProgressBlock,
  assertPonytailTarget,
} from "../core.mjs";
import { getArtifactStatus, runArtifact } from "./artifact-migration.mjs";

export const parseArtifactArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      type: { type: "string", default: "artifact" },
      target: { type: "string" },
      source: { type: "string", multiple: true },
      "source-root": { type: "string" },
      "target-root": { type: "string" },
      status: { type: "boolean", default: false },
      mode: { type: "string" },
      ponytail: { type: "string" },
      slice: { type: "string" },
      "design-source": { type: "string" },
      figma: { type: "string", multiple: true },
      "pilot-format": { type: "string" },
      "upgrade-format": { type: "string" },
      "confirm-format": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  assertOptionCombination("artifact", { positionals, values });
  if (values.ponytail !== undefined) assertPonytailTarget(values.ponytail);
  if (values["pilot-format"] !== undefined && values["pilot-format"] !== "14") {
    throw new Error("--pilot-format accepts only 14.");
  }
  if (values["upgrade-format"] !== undefined && values["upgrade-format"] !== "14") {
    throw new Error("--upgrade-format accepts only 14.");
  }
  if ((values.status && (values["pilot-format"] || values["upgrade-format"] || values["confirm-format"])) ||
      (values["pilot-format"] && values["upgrade-format"]) ||
      (values["confirm-format"] && !values["pilot-format"] && !values["upgrade-format"])) {
    throw new Error("Format selection, upgrade and confirmation must be invoked explicitly and separately from --status.");
  }
  return {
    source: positionals[0],
    sources: values.source,
    type: values.type,
    target: values.target,
    sourceRoot: values["source-root"],
    targetRoot: values["target-root"],
    status: values.status,
    mode: values.mode,
    ponytail: values.ponytail,
    slice: values.slice,
    designSource: values["design-source"],
    figma: values.figma,
    pilotFormat: values["pilot-format"] === "14" ? 14 : undefined,
    upgradeFormat: values["upgrade-format"] === "14" ? 14 : undefined,
    confirmationId: values["confirm-format"],
    json: values.json,
  };
};

/**
 * `CONTINUE` with no continuation command is an engine fault by this engine's
 * own doctrine, and an engine fault must never be reported as `CONTINUE`: an
 * automated driver would loop on it forever. It used to be rendered as
 * `loop: STOP reason=CONTINUE`, which is not a member of the closed stop set at
 * all, so a provider obeying the directive literally -- which the protocol
 * requires -- met an unknown token at the one place it must not improvise.
 */
export const artifactDirective = (result, source, mode) => {
  if (result.outcome === "CONTINUE" && !result.progress?.nextWork?.command) {
    return renderLoopDirective({
      mode,
      outcome: "FAILED",
    });
  }
  return renderLoopDirective({
    mode,
    outcome: result.outcome,
    next: result.progress?.nextWork?.command ?? `/migrate-artifact ${source}`,
  });
};

const render = (result, { emitDirective = true, source, mode } = {}) => {
  // Nested under `run-migration` (no directive), the parent shows the block.
  let output = emitDirective ? renderProgressBlock(result) : "";
  if (result.request) {
    output +=
      `Author next: ${result.request.artifacts.join(", ")}\n` +
      `Schema: ${result.request.schemaRef}\n` +
      `Validation: ${result.request.reason}\n`;
  }
  if (result.outcome === "AWAITING_CONFIRMATION") {
    output += `Confirmation ID: ${result.confirmationId}\nAwaiting explicit confirmation. Nothing has been written.\n`;
  }
  if (result.outcome === "CONTINUE" && !result.progress?.nextWork?.command) {
    output +=
      "Reason: the engine reported CONTINUE with no next command. That is an engine fault, not pending work.\n";
  }
  if (result.reason && !result.request) output += `Reason: ${result.reason}\n`;
  if (result.metrics) {
    output +=
      `Metrics: ${result.metrics.durationMs}ms, ${result.metrics.discoveryScans} scan(s), ` +
      `${result.metrics.filesParsed} file(s) parsed, ${result.metrics.validatorRuns} validator run(s)\n`;
  }
  if (!emitDirective) return output;
  return output + artifactDirective(result, source, mode);
};

export const runArtifactCli = async (
  arguments_ = process.argv.slice(2),
  { stdout = process.stdout, emitDirective = true, recordTrustedDecision } = {},
) => {
  const parsed = parseArtifactArguments(arguments_);
  const options = {
    source: parsed.source,
    sources: parsed.sources,
    type: parsed.type,
    target: parsed.target,
    sourceRoot: parsed.sourceRoot,
    targetRoot: parsed.targetRoot,
    mode: parsed.mode,
    ponytail: parsed.ponytail,
    slice: parsed.slice,
    designSource: parsed.designSource,
    figma: parsed.figma,
    pilotFormat: parsed.pilotFormat,
    upgradeFormat: parsed.upgradeFormat,
    confirmationId: parsed.confirmationId,
  };
  // No interactive consent prompt here. `AWAITING_CONFIRMATION` returns to the
  // agent under the same rule as every other confirmation in this workflow, so
  // "what counts as approval" has one answer instead of two -- and a process
  // that may be driven over MCP grows no second interactive code path.
  const result = parsed.status
    ? await getArtifactStatus(options)
    : await runArtifact(options, { recordTrustedDecision });
  // stdout stays pure JSON; the engine still shows progress, on stderr.
  if (parsed.json || parsed.status) process.stderr.write(renderProgressBlock(result));
  const output = parsed.json || parsed.status
    ? `${JSON.stringify(result, null, 2)}\n`
    : render(result, {
        emitDirective,
        source: parsed.source,
        mode: parsed.mode,
      });
  if (stdout === process.stdout) writeSync(1, output);
  else stdout.write(output);
  const outcome = result.outcome ?? "CONTINUE";
  if (!MIGRATION_OUTCOMES.includes(outcome)) {
    throw new Error(`Unknown migration outcome '${outcome}'.`);
  }
  process.exitCode = result.exitCode ?? exitCodeFor(outcome);
  return result;
};

if (isMainModule(import.meta.url)) {
  runArtifactCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
