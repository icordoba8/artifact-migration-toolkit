#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";
import { resolveRegistryPath, runDoctor } from "../migration-utils.mjs";
import {
  assertOptionCombination,
  exitCodeFor,
  maySelfConfirm,
  nextOutcome,
} from "../migration-policy.mjs";
import {
  assertExecutionConfirmation,
  autoAdoptToolkitIdentity,
  bootstrapMigration,
  getMigrationStatus,
  previewDiscoveryScan,
  BLOCKED_EXIT_CODE,
  previewMigrationExecution,
  recoverMigrationRecord,
  renderLoopDirective,
  renderToolkitAdoption,
} from "../resumable-migration.mjs";

/**
 * `--ponytail` is the one option that is legal bare, so a value has to be
 * supplied before `parseArgs` sees it. Exported because `run-migration.mjs`
 * forwards the same argv and must survive the same token (`03` D3-4).
 */
export const normalizePonytailArgument = (arguments_) =>
  arguments_.flatMap((argument, index) => {
    if (
      argument === "--ponytail" &&
      (index === arguments_.length - 1 ||
        arguments_[index + 1].startsWith("--"))
    ) {
      return ["--ponytail=full"];
    }
    return [argument];
  });

/** `a,b, a` -> `["a", "b"]`; absent -> `[]`. */
const sliceList = (value) =>
  value
    ? [
        ...new Set(
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ]
    : [];

export const parseDiscoverArguments = (arguments_) => {
  const normalizedArguments = normalizePonytailArgument(arguments_);
  const { positionals, values } = parseArgs({
    args: normalizedArguments,
    allowPositionals: true,
    strict: true,
    options: {
      brief: { type: "string" },
      "confirm-execution": { type: "string" },
      "confirm-mismatch": { type: "boolean", default: false },
      "adopt-target": { type: "boolean", default: false },
      "design-source": { type: "string" },
      doctor: { type: "boolean", default: false },
      figma: { type: "string", multiple: true },
      legacy: { type: "string", multiple: true },
      mock: { type: "boolean", default: false },
      // Deliberately no `default`: `--status` refuses every other flag by
      // truthiness, and a default would make `values.mode` permanently set.
      mode: { type: "string" },
      "openspec-proposal-stdin": { type: "boolean", default: false },
      ponytail: { type: "string" },
      refresh: { type: "boolean", default: false },
      registry: { type: "string" },
      "reopen-discovery": { type: "boolean", default: false },
      "reopen-ui": { type: "string" },
      "reopen-complete": { type: "string" },
      "reopen-reason": { type: "string" },
      "reopen-evidence": { type: "string" },
      "confirm-reopen": { type: "boolean", default: false },
      "confirm-legacy-revision": { type: "string" },
      "rework-slice": { type: "string" },
      "confirm-rework": { type: "boolean", default: false },
      "amend-slice": { type: "string" },
      "add-file": { type: "string", multiple: true },
      "adopt-visual-contract": { type: "boolean", default: false },
      "confirm-adopt-visual-contract": { type: "boolean", default: false },
      scan: { type: "boolean", default: false },
      slice: { type: "string" },
      status: { type: "boolean", default: false },
      target: { type: "string" },
    },
  });
  assertOptionCombination("discover", { positionals, values });
  return {
    adoptTarget: values["adopt-target"],
    brief: values.brief,
    confirmExecution: values["confirm-execution"],
    confirmMismatch: values["confirm-mismatch"],
    designSource: values["design-source"],
    doctor: values.doctor,
    figma: values.figma,
    legacy: values.legacy,
    mock: values.mock,
    mode: values.mode,
    moduleName: positionals[0],
    openSpecProposalStdin: values["openspec-proposal-stdin"],
    targetOverride: values.target,
    ponytail: values.ponytail,
    refresh: values.refresh,
    reopenDiscovery: values["reopen-discovery"],
    reopenUi: sliceList(values["reopen-ui"]),
    reopenComplete: sliceList(values["reopen-complete"]),
    reopenReason: values["reopen-reason"] ?? null,
    reopenEvidence: values["reopen-evidence"] ?? null,
    confirmReopen: values["confirm-reopen"],
    confirmLegacyRevision: values["confirm-legacy-revision"] ?? null,
    reworkSlice: values["rework-slice"] ?? null,
    confirmRework: values["confirm-rework"],
    amendSlice: values["amend-slice"] ?? null,
    addFiles: values["add-file"] ?? [],
    adoptVisualContract: values["adopt-visual-contract"],
    scan: values.scan,
    slice: values.slice,
    status: values.status,
    registryOption: values.registry,
  };
};

export const renderExecutionPreview = (preview) =>
  `Pre-execution summary\n` +
  `Migration: ${preview.migration}\n` +
  `Target: ${preview.target}\n` +
  `Registry identity: ${preview.registryIdentity}\n` +
  `Legacy root: ${preview.legacyRoot ?? "unknown"}\n` +
  `Target root: ${preview.targetRoot ?? "unknown"}\n` +
  `Persisted binding: ${preview.projectConfigPath} -> ${preview.projectRegistryBinding}\n` +
  `OpenSpec: ${preview.openSpecStatus ?? "unknown"}${preview.openSpecDigest ? ` (${preview.openSpecDigest})` : ""}\n` +
  `Current state: ${preview.state}\n` +
  `Current checkpoint: ${preview.currentCheckpoint}\n` +
  `Active slice: ${preview.activeSlice ?? "none"}\n` +
  `Action this invocation: ${preview.action}\n` +
  `Reason: ${preview.reason}\n` +
  `Artifacts involved: ${preview.artifacts.join(", ")}\n` +
  `Expected next checkpoint: ${preview.expectedNextCheckpoint}\n` +
  `Expected next artifact: ${preview.expectedNextArtifact ?? "none"}\n` +
  `Format: ${preview.recordedFormatVersion ?? "none"}/${preview.recordedWorkflowVersion ?? "none"} -> ${preview.currentFormatVersion}/${preview.currentWorkflowVersion}\n` +
  `Blockers: ${preview.blockers.length > 0 ? preview.blockers.join("; ") : "none"}\n` +
  renderSliceAmendment(preview.sliceAmendment);

const renderSliceAmendment = (amendment) =>
  amendment
    ? `Slice scope amendment ${amendment.amendment} for ${amendment.slice} (add-only)\n` +
      `  existing changedFiles: ${amendment.existingChangedFiles.join(", ")}\n` +
      amendment.add
        .map(
          (file) =>
            `  + ${file.path} basis=${file.ownershipBasis} claimedBy=${file.claimedBy.length > 0 ? file.claimedBy.join(",") : "none"} drift=${file.driftClass}\n`,
        )
        .join("") +
      `  preserves prior record as ${amendment.preservesAs}\n`
    : "";

const directive = (options, outcome, emit) =>
  emit
    ? renderLoopDirective({
        moduleName: options.moduleName,
        mode: options.mode,
        outcome,
      })
    : "";

/**
 * `emitDirective` defaults to `true`, so direct invocation is byte-identical.
 * It exists for `run-migration.mjs` (`03` D3-3): a driver that delegates to
 * both wrappers would otherwise print two `loop:` lines per iteration, at least
 * one of them wrong. Same shape as `runRecordDecisionCli`'s `{ stdin, stdout }`.
 *
 * `stdout` defaults to the process stream, so every existing caller is
 * byte-identical. It exists for `06` D6-5: MCP's stdio transport owns
 * `process.stdout`, so the server hands in a capture buffer and this human-
 * readable preview text never reaches the JSON-RPC stream.
 */
export const runDiscoverCli = async (
  arguments_,
  { emitDirective = true, stdout = process.stdout } = {},
) => {
  const options = parseDiscoverArguments(arguments_);
  // Before registry resolution on purpose: --doctor answers "can this host run
  // the engine at all", so it must not need a resolvable registry to say no.
  if (options.doctor) {
    const report = await runDoctor();
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.outcome === "BLOCKED") process.exitCode = BLOCKED_EXIT_CODE;
    return { doctor: report };
  }
  if (options.openSpecProposalStdin) {
    let proposal = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) proposal += chunk;
    options.openSpecProposal = proposal;
  }
  Object.assign(
    options,
    await resolveRegistryPath({
      cliPath: options.registryOption,
      moduleName: options.moduleName,
    }),
  );
  if (options.status) {
    const status = await getMigrationStatus(options);
    stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (options.scan) {
    const scan = await previewDiscoveryScan(options);
    stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
    return { scan };
  }
  // `discover-module.mjs <module>` *is* the resume command, and resuming a
  // record whose last transition was interrupted is the whole point of the
  // journal. The preview cannot recover -- a preview that mutates is not a
  // preview -- so recovery happens here, under the module lock, and the preview
  // is then taken of the repaired record.
  let preview;
  try {
    preview = await previewMigrationExecution(options);
  } catch (error) {
    if (!error?.pendingTransaction) throw error;
    await recoverMigrationRecord(options);
    preview = await previewMigrationExecution(options);
  }
  stdout.write(renderExecutionPreview(preview));
  // Before the blocked branch on purpose: a refused run is exactly when the
  // operator most needs to see where the migration actually stands.
  if (preview.progressChecklist) {
    stdout.write(preview.progressChecklist);
  }
  if (!preview.requiresConfirmation) {
    const { outcome } = nextOutcome({ preview });
    stdout.write(
      "Execution: BLOCKED. No delegation, file modification, or state update was performed.\n",
    );
    stdout.write(directive(options, outcome, emitDirective));
    process.exitCode = exitCodeFor(outcome);
    return { preview, blocked: true };
  }
  // `auto` supplies the ID the operator would have typed; it never changes what
  // that ID binds. Which invocations may do so is core policy (`maySelfConfirm`).
  const selfConfirm = maySelfConfirm({
    command: "discover",
    mode: options.mode,
  });
  const confirmation =
    options.confirmExecution ?? (selfConfirm ? preview.confirmationId : null);
  if (!confirmation) {
    // `--mode step` only. The process exits at this line, so it states the ID
    // and stops rather than asking a question it will not be present to hear
    // the answer to; the front end that chose `step` owns that conversation.
    stdout.write(
      `Confirmation ID: ${preview.confirmationId}\n` +
        "Mode: step — awaiting explicit confirmation. No execution has started.\n",
    );
    stdout.write(
      directive(options, nextOutcome({ preview }).outcome, emitDirective),
    );
    return { preview, awaitingConfirmation: true };
  }
  assertExecutionConfirmation(preview, confirmation);
  if (!options.confirmExecution) {
    stdout.write("Mode: auto — self-confirmed.\n");
  }
  stdout.write(
    "Confirmation accepted. Executing only the action shown in the summary.\n",
  );
  // A record stamped by an older build is adopted here, before the gate the
  // mutation below would otherwise fail closed on. The adoption is its own
  // journalled transaction with its own history event; this only decides
  // whether to run it.
  stdout.write(
    renderToolkitAdoption(
      await autoAdoptToolkitIdentity({
        registryPath: options.registryPath,
        moduleName: options.moduleName,
        mode: options.mode,
        started: preview.state !== "NOT_STARTED",
      }),
    ),
  );
  const result = await bootstrapMigration({
    ...options,
    openSpecProposal: preview.openSpecProposal,
    registryBinding: preview.registryBinding,
    boundInputs: preview.boundInputs,
  });
  if (
    options.slice &&
    result.state.activeSlice !== options.slice &&
    !result.state.pendingSlices.includes(options.slice)
  ) {
    throw new Error(
      `Slice '${options.slice}' is not active or pending for this migration.`,
    );
  }
  stdout.write(
    `${result.changed ? "Wrote" : "Resumed"} ${result.statePath}\n` +
      `Current step: ${result.state.currentStep}\n` +
      `Resume mode: ${result.resumeMode ?? "BOOTSTRAP"}\n` +
      `${result.resumeReason ? `Resume guidance: ${result.resumeReason}\n` : ""}` +
      `Next artifact: ${result.nextArtifact ?? "none"}\n`,
  );
  // The bootstrap-to-loop handoff. It used to live in `SKILL.md` prose: phase 1
  // stopped with a typed `AWAITING_CONFIRMATION`, phase 2 succeeded with no
  // machine-readable line at all, and whether the first iteration ran was left
  // to a model reading paragraphs -- the same defect the directive was
  // introduced to close for advances. Same two functions, same closed outcome
  // set, and no second continuation policy: `nextOutcome` reads the record the
  // bootstrap just wrote, and `--mode step` still renders nothing.
  stdout.write(
    directive(options, nextOutcome({ preview, result }).outcome, emitDirective),
  );
  return { preview, result };
};

if (isMainModule(import.meta.url)) {
  runDiscoverCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
