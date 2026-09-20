#!/usr/bin/env node

/**
 * The one explicit toolkit-identity maintenance command.
 *
 * It is a separate front end, not a flag on `run-migration.mjs`, for two
 * reasons. Adopting or moving an identity is engine maintenance rather than a
 * lifecycle step -- it advances no checkpoint, records no decision, and stops
 * immediately so the lifecycle resumes on the *next* invocation -- and the
 * approval-bearing CLI's argument surface is a reviewed security boundary that
 * gains nothing by growing a verb which is not an approval.
 *
 * `status` is read-only and never writes, on any record, in any state.
 */

import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";
import { resolveRegistryPath } from "../migration-utils.mjs";
import {
  changeModuleToolkitIdentity,
  getMigrationStatus,
} from "../resumable-migration.mjs";
import {
  activeToolkitIdentity,
  renderToolkitIdentity,
  toolkitIdentityStatus,
} from "../toolkit-identity.mjs";

const COMMANDS = ["status", "adopt", "update", "rollback"];

export const parseToolkitIdentityArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      module: { type: "string" },
      artifact: { type: "string" },
      type: { type: "string" },
      "source-root": { type: "string" },
      "target-root": { type: "string" },
      registry: { type: "string" },
    },
  });
  const usage =
    "Usage: toolkit-identity.mjs (status | adopt | update | rollback) (--module <module> [--registry <path>] | --artifact <source> [--type <type>] [--source-root <path>] [--target-root <path>])";
  if (positionals.length !== 1 || !COMMANDS.includes(positionals[0])) {
    throw new Error(usage);
  }
  // Exactly one record, named exactly once. A command that could be read as
  // naming two records is a command that mutates the wrong one.
  if ((values.module === undefined) === (values.artifact === undefined)) {
    throw new Error(usage);
  }
  return {
    command: positionals[0],
    moduleName: values.module,
    registryOption: values.registry,
    artifact:
      values.artifact === undefined
        ? null
        : {
            source: values.artifact,
            type: values.type ?? "artifact",
            sourceRoot: values["source-root"],
            targetRoot: values["target-root"],
          },
  };
};

const artifactEngine = () => import("../artifact/artifact-migration.mjs");

const reportChange = (stdout, label, result) => {
  if (!result.changed) {
    stdout.write(
      `${label} already pins ${renderToolkitIdentity(result.next)}. Nothing was written.\n`,
    );
    return;
  }
  stdout.write(
    `${label}: ${result.previous === null ? "adopted" : "changed"} toolkit identity.\n` +
      `  previous: ${renderToolkitIdentity(result.previous)}\n` +
      `  next:     ${renderToolkitIdentity(result.next)}\n` +
      `The record was not advanced. Resume the lifecycle with its own command.\n`,
  );
};

export const runToolkitIdentityCli = async (
  arguments_,
  { stdout = process.stdout } = {},
) => {
  const options = parseToolkitIdentityArguments(arguments_);
  const active = activeToolkitIdentity();

  if (options.artifact) {
    const engine = await artifactEngine();
    if (options.command === "status") {
      const report = await engine.getArtifactStatus(options.artifact);
      stdout.write(
        `${JSON.stringify(
          {
            artifactId: report.artifactId,
            toolkitIdentity: report.toolkitIdentity ?? null,
            activeToolkitIdentity: active,
            toolkitIdentityStatus: toolkitIdentityStatus(report.toolkitIdentity ?? null, active),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    const result = await engine.changeArtifactToolkitIdentity({
      ...options.artifact,
      mode: options.command,
    });
    reportChange(stdout, `artifact ${result.artifactId}`, result);
    return;
  }

  Object.assign(
    options,
    await resolveRegistryPath({
      cliPath: options.registryOption,
      moduleName: options.moduleName,
    }),
  );
  if (options.command === "status") {
    const report = await getMigrationStatus(options);
    stdout.write(
      `${JSON.stringify(
        {
          module: report.module,
          target: report.target,
          // Reported side by side to make the independence visible: a toolkit
          // release never implies a format bump and a format bump never implies
          // a toolkit release.
          formatVersion: report.formatVersion,
          contractVersion: report.contractVersion,
          workflowVersion: report.workflowVersion,
          toolkitIdentity: report.toolkitIdentity,
          activeToolkitIdentity: report.activeToolkitIdentity,
          toolkitIdentityStatus: report.toolkitIdentityStatus,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const result = await changeModuleToolkitIdentity({
    registryPath: options.registryPath,
    moduleName: options.moduleName,
    mode: options.command,
  });
  reportChange(stdout, `migration ${result.resolved.canonical}`, result);
};

if (isMainModule(import.meta.url)) {
  runToolkitIdentityCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
