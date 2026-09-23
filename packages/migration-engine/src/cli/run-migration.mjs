#!/usr/bin/env node

/**
 * One migration iteration in one process (Plan 03).
 *
 * The agent used to be the sequencer: three scripts, in an order stated only in
 * `SKILL.md` prose, with a `--step` retyped from a value the core computes.
 * This file performs that sequence and nothing else. It contains no rule --
 * every branch is either a discriminant a wrapper returned or a call into
 * `migration-policy.mjs` -- and it writes no file: every write is still
 * performed by `bootstrapMigration` or `advanceMigration`, on their existing
 * paths, under their existing locks and journals (D3-8).
 *
 * `run` performs at most one advance and always exits (D3-2). That is not a
 * policy choice: every checkpoint requires an artifact an agent has to author,
 * so a second advance inside one process could never be legal. Continuation is
 * the `loop:` line, obeyed by re-invoking the same bare command.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "../engine-paths.mjs";

import {
  assertOptionCombination,
  authoringRequest,
  DEFAULT_MODE,
  exitCodeFor,
  LATE_DECISION_KINDS,
  migrationProgress,
  MODULE_CLASSIFICATION_FILE,
  nextOutcome,
  pendingDecisionCandidates,
  previewAdvance,
  renderProgress,
  renderLoopDirective,
  resolveRegistryPath,
  validateResumableMigration,
} from "../core.mjs";
import {
  normalizePonytailArgument,
  runDiscoverCli,
} from "./discover-module.mjs";
import { runAdvanceCli } from "./advance-migration.mjs";
import { runArtifactCli } from "../artifact/run-artifact.mjs";
import {
  approveWithOperator,
  artifactApprover,
  moduleApprover,
  recorderFor,
} from "../operator-approval.mjs";

export const parseRunArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: normalizePonytailArgument(arguments_),
    allowPositionals: true,
    strict: true,
    options: {
      "adopt-target": { type: "boolean", default: false },
      brief: { type: "string" },
      "design-source": { type: "string" },
      figma: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      legacy: { type: "string", multiple: true },
      mock: { type: "boolean", default: false },
      // No `default`, for the same reason `discover` has none: an absent
      // `--mode` has to stay absent so the wrappers resolve it themselves.
      mode: { type: "string" },
      ponytail: { type: "string" },
      registry: { type: "string" },
      slice: { type: "string" },
      target: { type: "string" },
      // Declared only so `assertOptionCombination` can refuse them by name.
      // Without an entry `parseArgs` would reject them as unknown options and
      // the operator would never be told which command owns them.
      "confirm-execution": { type: "string" },
      refresh: { type: "boolean", default: false },
      "reopen-discovery": { type: "boolean", default: false },
      "reopen-ui": { type: "string" },
      "reopen-complete": { type: "string" },
      "rework-slice": { type: "string" },
      "confirm-rework": { type: "boolean", default: false },
      "amend-slice": { type: "string" },
      "add-file": { type: "string", multiple: true },
      "adopt-visual-contract": { type: "boolean", default: false },
      doctor: { type: "boolean", default: false },
      scan: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
    },
  });
  assertOptionCombination("run", { positionals, values });
  return {
    moduleName: positionals[0],
    mode: values.mode,
    slice: values.slice,
    json: values.json,
  };
};

/**
 * `--json` is the only stdout switch this file adds, and `--step` is never
 * forwarded: the core defaults it from `state.currentStep` and re-checks it, so
 * passing it would only restate a computed value. `--slice` is forwarded,
 * because it selects among genuinely pending work.
 */
const discoverArguments = (arguments_) =>
  arguments_.filter((argument) => argument !== "--json");

const advanceArguments = ({ moduleName, mode, slice }) => [
  moduleName,
  ...(mode ? ["--mode", mode] : []),
  ...(slice ? ["--slice", slice] : []),
];

/**
 * Validation refusals that no amount of re-authoring can clear, because they
 * name a human act: preserve or restore evidence, claim a file in the slice it
 * belongs to, record a drift acceptance, or reverify after a rework. Each is
 * raised from exactly one place in the engine and each names its own class in
 * the message, so this list matches on the class token rather than on prose.
 */
const TERMINAL_VALIDATION_REFUSALS = [
  /\bUNCLAIMED_TARGET_DRIFT\b/,
  /\bREWORK_EVIDENCE_MISSING\b/,
  /\bREOPEN_EVIDENCE_MISSING\b/,
  /^Unresolved verification blocks FINALIZE/,
  /^Stale verification blocks FINALIZE/,
  /^FINALIZE refuses to advance on repaired navigation/,
  /^Preserved rework evidence changed after it was pinned/,
  /^Preserved reopen evidence changed after it was pinned/,
];

/**
 * D3-5. Diagnostic prose, not contract: only the `loop:` line is. Field order
 * is the block's, and the closing `Validation:` line carries the reason the
 * checkpoint is not yet closeable, which is the whole point of being told to
 * author something.
 */
export const renderAuthoringRequest = (request, reason) =>
  `Author next: ${request.summary}\n` +
  `Checkpoint: ${request.step}\n` +
  `Slice: ${request.slice ?? "none"}\n` +
  `Primary artifact: ${request.primaryArtifact ?? "none"}\n` +
  `Artifacts involved: ${request.artifacts.join(", ")}\n` +
  `Schema: ${request.schemaRef}\n` +
  `Expected next checkpoint: ${request.expectedNextCheckpoint}\n` +
  `Validation: ${reason}\n`;

/**
 * D4-7 step 4a. The one place `run` narrows an outcome, and it does so from a
 * structural field: `state.currentStep`, then `candidate.approvable`. Never a
 * message. Read-only, lock-free, and asked only on the failed-validation path
 * at the one checkpoint whose census can produce a candidate -- which is also
 * the only checkpoint whose record is format >= 10 by construction, so the
 * format assertion inside cannot throw here (`04` §1.7).
 *
 * `03` D3-6 hooked this to a blocked advance instead. `previewAdvance` blocks
 * only on a status/step/slice mismatch and never validates an artifact, so that
 * hook was unreachable; `04` §1.1 is the evidence and D4-7 is the correction.
 */
const pendingApprovals = async ({ step, state, registryPath, moduleName }) => {
  const censusClosed = (state?.completedSteps ?? []).includes(
    "DISCOVERY_COMPLETENESS",
  );
  if (step !== "DISCOVERY_COMPLETENESS" && !censusClosed) {
    return { candidates: [], references: [], group: null };
  }
  const pending = await pendingDecisionCandidates({ registryPath, moduleName });
  if (step === "DISCOVERY_COMPLETENESS") return pending;
  const candidates = pending.candidates.filter((candidate) =>
    LATE_DECISION_KINDS.has(candidate.kind),
  );
  const offered = new Set(candidates.map((candidate) => candidate.id));
  return {
    ...pending,
    candidates,
    group:
      pending.group?.boundTo.members.every((member) => offered.has(member.id))
        ? pending.group
        : null,
  };
};

export const decisionCandidates = async (options) =>
  (await pendingApprovals(options)).candidates;

/**
 * The trusted human path that is still reachable when the inline one was not.
 *
 * It is the same terminal gate `record-decision.mjs` has always owned -- no
 * second approval channel -- carried as a typed field so a front end no longer
 * has to scrape `renderCandidateBlock` out of the log to offer it. `cwd` is the
 * directory this iteration actually resolved the record in, which under MCP is
 * the isolated worktree the call named: the commands are repository-relative,
 * so naming the wrong directory would approve in the wrong checkout.
 *
 * It is emitted for *every* non-approval, because the reason is never knowable
 * here. An MCP host that declines an elicitation without showing anyone, a host
 * that never had a human, and a human who genuinely refused are one outcome on
 * the wire; treating any of them as a final rejection is what left a valid
 * migration blocked with no way forward.
 */
const operatorApproval = (candidates, group = null) => ({
  cwd: process.cwd(),
  candidates,
  group,
});

/**
 * D4-1, D4-2. The pause is not a second approval path: it is the existing gate,
 * reached in the operator's own terminal. `runRecordDecisionCli` is called with
 * exactly one argument, so its `stdin`/`stdout` defaults resolve to the real
 * process handles and there is no object `run` could substitute -- the gate at
 * the top of that function re-tests and refuses on its own. `run`'s own probe
 * is an optimization; if it were wrong in either direction the result is a
 * refusal, never an approval.
 *
 * `--registry` is deliberately not forwarded, for the same reason step 3 omits
 * it: the binding is persisted by then, and re-supplying the flag is refused as
 * a second setup.
 */
/**
 * One iteration, one human act, at most one ledger line.
 *
 * This used to loop the whole approvable list, asking per candidate and
 * appending per answer. A prior run wrote multiple approvals: the ask was per
 * candidate, but the *run*
 * was not, so one answering channel -- a host auto-answering, at the time --
 * spent one tool call on thirteen writes. Asking again is not the same act as
 * being asked again, and the record cannot tell them apart after the fact.
 *
 * So the batch is gone. The first pending candidate is offered, and whatever it
 * returns the driver stops: approved, and the caller reports the remainder
 * still pending so the `loop:` directive brings the operator back for the next
 * one; not approved, and nothing was written at all. Thirteen approvals now
 * cost thirteen invocations by construction, whatever any host answers.
 */
/**
 * `OPERATOR_DECISION` no longer promises an empty ledger: a capped iteration can
 * record one approval and still stop with a remainder. Naming the line it wrote
 * is the difference between a receipt the agent can cite from `reason` and
 * `decisionReferences`, and one it has to go hunting for.
 */
const recordedPrefix = (recorded) =>
  recorded.length > 0 ? `Recorded ${recorded.join(", ")}. ` : "";

/**
 * `06` D6-5: every byte this driver and both wrappers produce goes to `stdout`,
 * which defaults to the process stream. The MCP server passes a capture buffer
 * so the JSON-RPC transport keeps `process.stdout` to itself; nothing else
 * changes, and the CLI path is byte-identical.
 */
export const runMigration = async (
  arguments_,
  // No default: absent probes the TTY; null declares no trusted human channel.
  { stdout = process.stdout, recordTrustedDecision } = {},
) => {
  const options = parseRunArguments(arguments_);
  const recorder = recorderFor({ recordTrustedDecision, mode: options.mode });
  const approver = moduleApprover(recorder, options.moduleName);
  // The most recent persisted record this iteration saw. It is only ever read
  // to project progress from -- `finish` never writes it and never consults it
  // to decide anything -- so an iteration that failed before reaching a record
  // simply reports no progress rather than inventing one.
  const decisionReferences = [];
  let latestState = null;
  let nextWork = null;
  const finish = (outcome, extra = {}) => {
    const progress = latestState
      ? migrationProgress(latestState, {
          mode: options.mode ?? DEFAULT_MODE,
          outcome,
          reason: extra.reason ?? null,
          nextWorkKind: nextWork?.kind ?? null,
          artifactMigration: nextWork?.artifactMigration ?? null,
        })
      : null;
    const result = {
      outcome,
      request: null,
      decisionReferences,
      ...extra,
      progress,
      progressChecklist: progress ? renderProgress(progress) : null,
    };
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.request?.summary) {
      stdout.write(renderAuthoringRequest(result.request, result.reason));
    }
    stdout.write(
      renderLoopDirective({
        moduleName: options.moduleName,
        mode: options.mode,
        outcome,
      }),
    );
    process.exitCode = exitCodeFor(outcome);
    return result;
  };

  try {
    // 1. Preflight, bootstrap or resume. Every byte the wrapper writes today it
    //    still writes, on the same path, in the same order.
    const discovered = await runDiscoverCli(discoverArguments(arguments_), {
      emitDirective: false,
      stdout,
    });
    latestState = discovered.result?.state ?? latestState;

    // 2. Stop unless the record is ready to move. `nextOutcome` answers
    //    blocked, awaiting confirmation, and already-complete in one call --
    //    including `--mode step`, which stops here with the ID displayed and no
    //    directive, exactly as it does today.
    const preflight = nextOutcome({
      preview: discovered.preview,
      result: discovered.result,
    });
    if (preflight.outcome !== "CONTINUE") {
      return finish(preflight.outcome, {
        reason: preflight.reason,
        next: preflight.next,
      });
    }

    // The binding is persisted by the bootstrap above, so no `--registry` is
    // passed here: after step 1 there is exactly one registry this module can
    // resolve to, and re-supplying the flag is refused as a second setup.
    const { registryPath } = await resolveRegistryPath({
      moduleName: options.moduleName,
    });

    // Delegation is detected by the lock-free module preflight before normal
    // module validation. A healthy child is work, not a module validation
    // failure, and this iteration never takes the module lock.
    const delegated = await previewAdvance({
      registryPath,
      moduleName: options.moduleName,
      slice: options.slice,
      mode: options.mode,
    });
    if (delegated.nextWorkKind === "RUN_ARTIFACT") {
      const binding = delegated.artifactMigration;
      nextWork = { kind: "RUN_ARTIFACT", artifactMigration: binding };
      if (options.mode === "step") {
        stdout.write(`Artifact prerequisite: ${binding.command}\n`);
        return finish("CONTINUE", { reason: delegated.reason });
      }
      const child = await runArtifactCli(binding.arguments, {
        stdout,
        emitDirective: false,
      });
      if (child.outcome === "BLOCKED" || child.outcome === "FAILED") {
        return finish("BLOCKED", {
          reason: `Artifact prerequisite '${binding.artifactId}' failed: ${child.reason}`,
        });
      }
      if (child.outcome === "OPERATOR_DECISION") {
        const candidates = (child.pendingDecisions ?? []).map((decision) => ({
          id: decision.candidateId,
          kind: "ARTIFACT_DECISION",
          subject: { type: "ARTIFACT_DECISION", path: decision.id },
          command: decision.command,
        }));
        const recorded = await approveWithOperator(
          candidates,
          artifactApprover(recorder, binding),
          stdout,
          decisionReferences,
        );
        if (recorded.length < candidates.length) {
          return finish("OPERATOR_DECISION", {
            reason: `${recordedPrefix(recorded)}${candidates.length - recorded.length} artifact operator decision(s) are still pending, each requiring its own operator approval in a new iteration.`,
            pendingDecisions: child.pendingDecisions,
            operatorApproval: operatorApproval(candidates.slice(recorded.length)),
          });
        }
      }
      return finish("CONTINUE", {
        reason:
          child.outcome === "COMPLETE"
            ? "Artifact prerequisite reached COMPLETE; re-enter the parent."
            : child.reason,
        request: child.request ?? null,
      });
    }
    if (delegated.outcome === "OPERATOR_DECISION") {
      const binding = delegated.artifactMigration;
      const candidates = (delegated.pendingDecisions ?? []).map((decision) => ({
        id: decision.candidateId,
        kind: "ARTIFACT_DECISION",
        subject: { type: "ARTIFACT_DECISION", path: decision.id },
        command: decision.command,
      }));
      const recorded = await approveWithOperator(
        candidates,
        artifactApprover(recorder, binding),
        stdout,
        decisionReferences,
      );
      return recorded.length === candidates.length
        ? finish("CONTINUE", {
            reason: "Artifact operator decisions recorded.",
          })
        : finish("OPERATOR_DECISION", {
            reason: `${recordedPrefix(recorded)}${candidates.length - recorded.length} artifact operator decision(s) are still pending, each requiring its own operator approval in a new iteration.`,
            pendingDecisions: delegated.pendingDecisions,
            operatorApproval: operatorApproval(candidates.slice(recorded.length)),
          });
    }
    if (delegated.outcome === "BLOCKED") {
      return finish("BLOCKED", { reason: delegated.reason });
    }

    // 3-4. Lock-free validation. Advisory only: the advance re-validates under
    //      the lock, so this can never be the reason something executes -- only
    //      the reason a missing artifact is reported before a lock is taken.
    try {
      await validateResumableMigration({
        registryPath,
        moduleName: options.moduleName,
        slice: options.slice,
      });
    } catch (error) {
      const step = discovered.result.state.currentStep;
      // W5-4. A FINALIZE refusal for unresolved verification, unclaimed target
      // drift, missing preserved evidence, or repaired navigation is a stop
      // condition, not pending work. Reporting it as CONTINUE would send an
      // auto-loop back to re-author `gates.json` forever against a record that
      // cannot be finalized until a human acts, which SKILL.md names as the one
      // stop condition no command could detect. It is detectable now.
      const terminal = TERMINAL_VALIDATION_REFUSALS.find((pattern) =>
        pattern.test(error.message),
      );
      if (terminal) {
        return finish("BLOCKED", {
          reason: error.message,
          next: step,
          blocker: error.message,
        });
      }
      // 4a. Advisory: a throw here may add information to the failure already
      //     being reported, but it may never replace it and may never be
      //     silent (D4-7).
      let candidates = [];
      let group = null;
      try {
        const pending = await pendingApprovals({
          step,
          state: discovered.result.state,
          registryPath,
          moduleName: options.moduleName,
        });
        candidates = pending.candidates;
        group = pending.group ?? null;
        // An approval recorded in a previous iteration -- at a terminal, or
        // inline -- and not yet cited. Reporting it here is what makes the
        // trusted fallback complete: the operator approves in their own
        // terminal, the next ordinary iteration hands the agent the receipt,
        // and no identifier is ever transcribed by hand.
        decisionReferences.push(...(pending.references ?? []));
      } catch (narrowing) {
        process.stderr.write(`${narrowing.message}\n`);
      }
      const approvable = candidates.filter((candidate) => candidate.approvable);
      if (approvable.length > 0) {
        // 4b/4c. Pause in the operator's terminal, print the commands anywhere
        //        else. Either way `run` performs no advance afterwards (D4-3).
        const recorded = await approveWithOperator(
          approvable,
          approver,
          stdout,
          decisionReferences,
          group,
        );
        if (recorded.length < approvable.length) {
          return finish("OPERATOR_DECISION", {
            reason:
              `${recordedPrefix(recorded)}${approvable.length - recorded.length} operator decision(s) are still pending, ` +
              `each requiring its own operator approval in a new iteration; ` +
              `cite every returned decisionId with its decisionDigest in ${MODULE_CLASSIFICATION_FILE}.`,
            next: step,
            operatorApproval: operatorApproval(
              approvable.slice(recorded.length),
              recorded.length === 0 ? group : null,
            ),
          });
        }
        // An approval is half an act (§1.6): the checkpoint stays invalid until
        // the agent cites each id and its digest in the classification.
        return finish("CONTINUE", {
          reason:
            `${error.message} Recorded ${recorded.join(", ")}; ` +
            `cite each as decisionId with its decisionDigest in ${MODULE_CLASSIFICATION_FILE}.`,
          next: step,
          request: authoringRequest(discovered.result.state),
        });
      }
      // 4d. Non-approvable candidates are agent work, so their blockers travel
      //     with the authoring request instead of a challenge prompt.
      return finish("CONTINUE", {
        reason:
          candidates.length === 0
            ? error.message
            : `${error.message} ${candidates
                .map(
                  (candidate) =>
                    `${candidate.id}: ${candidate.blockers.join(" ")}`,
                )
                .join(" ")}`,
        next: step,
        request: authoringRequest(discovered.result.state),
      });
    }

    // 5. Advance. One checkpoint, one lock, one history event.
    const advanced = await runAdvanceCli(advanceArguments(options), {
      emitDirective: false,
      stdout,
    });
    latestState = advanced.result?.state ?? latestState;
    const advance = nextOutcome({
      preview: advanced.preview,
      result: advanced.result,
    });

    // 6. Exactly one directive.
    return finish(advance.outcome, {
      reason: advance.reason,
      next: advance.next,
    });
  } catch (error) {
    // Never downgraded to BLOCKED: exit 2 promises nothing was executed, and a
    // throw from inside the advance cannot promise that.
    process.stderr.write(`${error.message}\n`);
    return finish("FAILED", { reason: error.message });
  }
};

if (isMainModule(import.meta.url)) {
  // A refusal from `parseRunArguments` escapes `runMigration` before a mode is
  // known, so it is reported the way every other wrapper reports one: stderr,
  // no directive, non-zero exit.
  runMigration(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = exitCodeFor("FAILED");
  });
}
