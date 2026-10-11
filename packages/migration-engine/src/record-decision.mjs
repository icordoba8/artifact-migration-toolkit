#!/usr/bin/env node

/**
 * Operator-only recorder for `decisions/operator-decisions.ndjson`.
 *
 * A non-empty string is not an approval. Every disposition that means "this
 * legacy file is not being migrated" -- `EXCLUDED_APPROVED`, `DEAD` -- and
 * every unproven edge cleared by hand needs an approval bound to the exact
 * candidate it approves.
 *
 * For module formats <=18 and artifact 13, *who* may answer is a policy question with three answers, not one: a human at
 * a TTY, a human reached through the host, or the engine itself under
 * `--mode auto` (`autoApprovalChannel`). The TTY is the default boundary for an
 * argv invocation that declared no channel -- an agent harness running helpers
 * non-interactively is refused before a byte is touched -- but it was never the
 * thing that made a decision sound. The comparison against the challenge is,
 * and all three principals go through it.
 *
 * On those historical formats, `ask` is the mechanism all non-TTY channels use, and it is an
 * in-process function reference, never an argv option, an environment variable,
 * or a tool argument. A front end may pass it only when it has itself obtained
 * a human answer through a channel the model does not control -- today only the
 * MCP adapter, and only after the *client* declared `elicitation` during
 * `initialize`. Everything downstream of the answer is unchanged: the same
 * challenge phrase, the same module lock, the same recompute-under-lock, the
 * same chained append.
 *
 * On historical formats, `ask` returns an *answer*, never a verdict. It is compared here against the
 * phrase derived from the candidate recomputed under the lock, exactly as a
 * terminal line is, and a front end that returns anything it composed itself
 * rather than something the human supplied has approved nothing on its own
 * authority -- it has only moved the forgery one file over. That is not
 * hypothetical: an inline channel answering its own challenge on a bare host
 * `accept` can authorize multiple ledger lines without an operator. The
 * comparison below is the whole gate and nothing may shortcut it.
 *
 * Module 19 and artifact 14 relay explicit APPROVE/REJECT under STANDARD_LOCAL.
 * Only a protected high-assurance policy requires the optional signer.
 * The TTY/challenge contract below is legacy only.
 *
 * ponytail: a TTY gate plus one in-process channel for legacy, not cryptography.
 * An operator's own terminal can always forge a line -- that is the operator's
 * authority by definition, the same ceiling as history not being hash-chained.
 * Upgrade path: a detached signature over each line, verified against a key
 * pinned at RESOLVE.
 */

import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { assertSafeName } from "./shared/index.mjs";
import { appendDurably, resolveRegistryPath } from "./store/index.mjs";
import { engineCommand, isMainModule } from "./engine-paths.mjs";
import { withModuleLock } from "./module-lock.mjs";
import {
  assertRecordToolkitIdentity,
  BLOCKED_EXIT_CODE,
  legacySourceBinding,
  legacySourcesOf,
  pendingVisualUnbackedCandidates,
  previewDiscoveryScan,
  readMigrationContext,
  readState,
  sliceDriftFacts,
} from "./resumable-migration.mjs";
import { pendingTargetDriftCandidates } from "./slices/index.mjs";
import {
  appendApprovedCandidate,
  appendApprovedGroup,
  APPROVAL_EVIDENCE,
  approvedByPhrase,
  assertRelayDecision,
  attestationVerifierScope,
  buildDecision,
  candidateDigestOf,
  channelOf,
  DECISION_GROUP_KIND,
  decisionKindAllowed,
  deriveModuleDecisions,
  legacyCompatibilityProjection,
  lifecycleBinding,
  lockedApprovalCandidate,
  operatorAnswer,
  pendingArtifactDecisions,
  readOperatorDecisions,
  readRecordedDecisions,
  relayAnswer,
  relayedReview,
  renderDecisionReview,
  renderGroupApprovalSummary,
  reviewFor,
  selectApprovalCandidate,
  verifyRecord,
} from "./decisions/index.mjs";
import {
  assertDiscoveryCompletenessFormat,
  assertNoPendingFormatUpgrade,
  DECISIONS_FILE,
  MODULE_CLASSIFICATION_FILE,
  usesArtifactDirectLedger,
  usesDirectLedgerDecisions,
} from "./formats/index.mjs";
import { activeToolkitIdentity } from "./toolkit-identity.mjs";

export {
  APPROVAL_CHANNELS,
  APPROVAL_EVIDENCE_PHRASES,
  approvedByPhrase,
  assertReviewedCandidateCurrent,
  auditDecisionLedger,
  autoApprovalChannel,
  autoMayDecide,
  buildDecision,
  challengeFor,
  channelOf,
  DECISION_KINDS,
  groupFactsDigest,
  ledgerFileForChannel,
  rationaleDigestOf,
  renderDecisionReview,
  reviewFor,
  reviewReference,
  SIGNER_UNAVAILABLE,
} from "./decisions/index.mjs";

export const parseDecisionArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      approve: { type: "string" },
      relay: { type: "string" },
      decision: { type: "string" },
      list: { type: "boolean", default: false },
      pending: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      registry: { type: "string" },
      artifact: { type: "string" },
      type: { type: "string" },
      "source-root": { type: "string" },
      "target-root": { type: "string" },
    },
  });
  const modes = [
    values.list,
    values.pending,
    values.verify,
    Boolean(values.approve),
    values.relay !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      "Choose exactly one of --pending, --approve <stable-id>, --relay <reference> --decision APPROVE|REJECT, --list, or --verify.",
    );
  }
  if ((values.relay !== undefined) !== (values.decision !== undefined) || values.relay === "") {
    throw new Error("--relay <operatorApproval.reference> and --decision APPROVE|REJECT go together. Nothing was written.");
  }
  if (values.artifact !== undefined) {
    if (positionals.length !== 0 || values.relay !== undefined) {
      throw new Error(
        "Usage: record-decision.mjs --artifact <source> --type <type> [--source-root <path>] [--target-root <path>] (--pending | --approve <stable-id> | --list | --verify)",
      );
    }
    return {
      artifact: {
        source: values.artifact,
        type: values.type ?? "artifact",
        sourceRoot: values["source-root"],
        targetRoot: values["target-root"],
      },
      approve: values.approve,
      list: values.list,
      pending: values.pending,
      verify: values.verify,
    };
  }
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: record-decision.mjs <module> (--pending | --approve <stable-id> | --relay <reference> --decision APPROVE|REJECT | --list | --verify) [--registry <path>]",
    );
  }
  return {
    moduleName: positionals[0],
    approve: values.approve,
    ...(values.relay !== undefined && { relay: values.relay, decision: values.decision }),
    list: values.list,
    pending: values.pending,
    verify: values.verify,
    registryOption: values.registry,
  };
};

const derivePendingDecisions = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readMigrationContext({
    registryPath,
    moduleName,
  });
  const { state, root } = await readState(
    registryData.targetRoot,
    resolved.canonical,
  );
  assertDiscoveryCompletenessFormat(
    state,
    resolved.canonical,
    "Operator decision discovery",
  );
  const classificationPath = path.join(root, MODULE_CLASSIFICATION_FILE);
  let classification;
  try {
    classification = JSON.parse(await readFile(classificationPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read module classification '${classificationPath}': ${error.message}`,
    );
  }
  const scan = await previewDiscoveryScan({ registryPath, moduleName });
  const legacySource = await legacySourceBinding(registryData.legacyRoot);
  // Both ledgers: "is this candidate already decided" has one answer, and the
  // principal that decided it does not change it.
  const ledger = await readRecordedDecisions(root);
  // Unclaimed target drift, derived by the engine from the same set difference
  // FINALIZE refuses on, and the unbacked visual states: facts of the slice and
  // visual owners, read here and handed to decisions as data (Track A3). Before
  // A3 they were read between candidate constructions; reading them first
  // changes no candidate, only which of two simultaneous failures is reported.
  const driftRoots = {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  };
  const targetDrift = await pendingTargetDriftCandidates(
    root,
    state,
    driftRoots,
    await sliceDriftFacts(state, driftRoots),
  );
  const visualUnbacked = await pendingVisualUnbackedCandidates(root, state);
  return {
    public: await deriveModuleDecisions({
      module: resolved.canonical,
      projectRoot: registryData.targetRoot,
      root,
      state,
      classification,
      scan,
      legacySource,
      legacySources: legacySourcesOf(state),
      ledger,
      targetDrift,
      visualUnbacked,
      approveCommand: (candidateId) =>
        engineCommand("record-decision.mjs", resolved.canonical, "--approve", candidateId),
    }),
    registryData,
    resolved,
    root,
    state,
  };
};

// Named fields, not a pass-through: which decision format a record derives is
// not a caller's, an agent's or a tool argument's choice.
export const pendingDecisionCandidates = async ({ registryPath, moduleName }) =>
  (await derivePendingDecisions({ registryPath, moduleName })).public;

/**
 * The canonical fresh module decision projection, and the only authority view
 * status, pending and run read.
 *
 * Fresh by construction: it re-reads the registry, the record, the
 * classification, the current scan and both ledgers on every call, and caches
 * nothing. An approval appended a moment ago is visible to the next call in the
 * same process -- no restart, no invalidation step to forget.
 *
 * Read-only by construction too: everything it calls is a reader. It never takes
 * the module lock, never advances a checkpoint, never appends a decision, and
 * never runs a target's own code.
 *
 * A record whose authority cannot be expressed under its own format is the one
 * state that is not a candidate outcome, so it is reported as the typed
 * compatibility action rather than thrown at a read-only caller.
 */
export const projectDecisions = async ({ registryPath, moduleName }) => {
  try {
    return (await derivePendingDecisions({ registryPath, moduleName })).public
      .decisions;
  } catch (error) {
    return legacyCompatibilityProjection(error);
  }
};

/** Re-derive a module's candidates under the lock, in the same format. */
const moduleRecompute =
  ({ registryPath, moduleName }) =>
  async () => {
    const locked = await derivePendingDecisions({
      registryPath,
      moduleName,
    });
    return {
      candidates: locked.public.group
        ? [...locked.public.candidates, locked.public.group]
        : locked.public.candidates,
      root: locked.root,
      targetRoot: locked.registryData.targetRoot,
      state: locked.state,
      recordName: locked.resolved.canonical,
      recordKind: "module",
    };
  };

/**
 * Record one new-format decision group against its persisted format and trusted
 * policy. STANDARD_LOCAL uses one AGENT_RELAYED v2 group line; a protected
 * HUMAN_ATTESTED requirement blocks this local channel before any prompt.
 *
 * Reachable from no argv option, exactly like the rest of the recorder: the
 * TTY/`ask` refusal below is the same one `runRecordDecisionCli` applies.
 */
export const recordNewFormatDecisionGroup = async ({
  registryPath,
  moduleName,
  stdin = process.stdin,
  stdout = process.stdout,
  ask = null,
}) => {
  if (!ask && (!stdin.isTTY || !stdout.isTTY)) {
    stdout.write(
      "Operator decisions are recorded only from an interactive terminal. " +
        "This invocation has no TTY, so nothing was read or written.\n",
    );
    process.exitCode = BLOCKED_EXIT_CODE;
    return { blocked: true };
  }
  assertSafeName(moduleName);
  const pending = await derivePendingDecisions({
    registryPath,
    moduleName,
  });
  if (!usesDirectLedgerDecisions(pending.state)) {
    throw new Error(`Record '${moduleName}' is not format 19. A v2 group cannot be requested for a legacy record.`);
  }
  if (!pending.public.group) {
    throw new Error(
      `No homogeneous decision group is pending for '${moduleName}'. Nothing was written.`,
    );
  }
  return approveDecisionGroup({
    group: pending.public.group,
    stdin,
    stdout,
    ask,
    lockName: pending.resolved.canonical,
    targetRoot: pending.registryData.targetRoot,
    recompute: moduleRecompute({ registryPath, moduleName }),
  });
};

/**
 * The one approval gate. Both ledgers -- the module record and the standalone
 * artifact record -- run this exact sequence, because two copies of a security
 * boundary is one more than the number a reviewer can hold at once:
 *
 *   select candidate -> assert approvable -> render summary -> obtain an answer
 *   (TTY or `ask`) -> compare against `challengeFor` -> take the module lock ->
 *   recompute -> deep-equality check -> `buildDecision` -> O_APPEND.
 *
 * Only the candidate source, the ledger location, the lock name and the wording
 * of the recorded statement differ, so only those are parameters. Nothing here
 * may be short-circuited by a caller: `answer.trim() !== challenge` is the gate,
 * and it is written once.
 */
/**
 * The one approval gate. Both ledgers -- the module record and the standalone
 * artifact record -- run this exact sequence, because two copies of a security
 * boundary is one more than the number a reviewer can hold at once:
 *
 *   select candidate -> assert approvable -> render summary -> obtain an answer
 *   (TTY or `ask`) -> compare against `challengeFor` -> take the module lock ->
 *   recompute -> deep-equality check -> `buildDecision` -> O_APPEND.
 *
 * Track A3: the decision rules are decisions' (`operatorAnswer`,
 * `lockedApprovalCandidate`, the appenders); this seam holds what decisions may
 * not -- the module lock, the recompute over census/slice/visual facts, the
 * toolkit-identity and format-freeze gates, and the process exit code.
 */
const withOperatorApproval = async ({
  selected,
  renderSummary,
  lockName,
  targetRoot,
  recompute,
  stdin,
  stdout,
  ask,
  onApproved,
}) => {
  const answer = await operatorAnswer({ selected, renderSummary, stdin, stdout, ask });
  if (answer.refused) {
    process.exitCode = BLOCKED_EXIT_CODE;
    return answer.refused;
  }
  return withModuleLock(targetRoot, lockName, async () => {
    const locked = await recompute();
    // Appending to the ledger is a mutation, so it obeys the same toolkit
    // identity gate as every other one -- and it is gated here, inside the one
    // shared recorder body, so neither ledger can acquire a second answer. The
    // identity is re-read under the lock from the record just recomputed; it
    // changes no decision id, sequence, rationale digest, decision digest or
    // chain link, it only decides whether this build may write at all.
    assertRecordToolkitIdentity(
      locked.state,
      locked.recordName,
      "Recording an operator decision",
      locked.recordKind,
    );
    // And the same freeze: a module record that owes a format increment records
    // no decision either. The artifact engine has its own registry and floor, so
    // the module guard is asked only about a module record.
    if (locked.recordKind !== "artifact") {
      assertNoPendingFormatUpgrade(
        locked.state,
        locked.recordName,
        "Recording an operator decision",
      );
    }
    const current = lockedApprovalCandidate(selected, locked.candidates);
    // The AUTO line's provenance names the running build; decisions reads no
    // disk identity, so the seam supplies it, only when AUTO answered.
    const toolkit = channelOf(ask) === "AUTO" ? activeToolkitIdentity() ?? null : undefined;
    return onApproved(current, { ...locked, toolkit }, answer.result);
  });
};

const approveDecisionGroup = async ({ group, ...gate }) =>
  withOperatorApproval({
    ...gate,
    selected: group,
    renderSummary: renderGroupApprovalSummary,
    onApproved: (lockedGroup, locked, result) =>
      appendApprovedGroup({ group: lockedGroup, locked, ask: gate.ask, stdout: gate.stdout, result }),
  });

const approveCandidate = async ({
  candidates,
  approve,
  statementFor,
  ...gate
}) =>
  withOperatorApproval({
    ...gate,
    selected: selectApprovalCandidate(candidates, approve),
    onApproved: (candidate, locked, result) =>
      appendApprovedCandidate({ candidate, locked, result, ask: gate.ask, stdout: gate.stdout, statementFor }),
  });

/* -- HUMAN_ATTESTED: one locked writer for module 19 and artifact 14 -------- */

// Lazy: only a protected signer process loads the WebAuthn verifier.
const webauthnProtocol = () => import("./operator-webauthn.mjs");
const refused = (code, message) => Object.assign(new Error(`${code}: ${message} Nothing was written.`), { code });

const attestedRecompute = (target) => {
  if (target?.recordKind === "module") {
    assertSafeName(target.moduleName);
    return moduleRecompute({ registryPath: target.registryPath, moduleName: target.moduleName });
  }
  if (target?.recordKind === "artifact") {
    return async () => {
      const locked = await deriveArtifactDecisions(target.artifact);
      return { candidates: locked.candidates, root: locked.context.root, targetRoot: locked.context.targetRoot,
        state: locked.context.state, recordName: locked.context.id, recordKind: "artifact" };
    };
  }
  throw refused("UNKNOWN_TARGET", "An attested decision needs a module or artifact record target.");
};

/** Every payload binding, derived by the engine from the locked record; none from the caller. */
const attestedBinding = async (candidate, locked, result) => {
  const protocol = await webauthnProtocol();
  if (!candidate) throw refused("STALE_REVIEW", "The reviewed candidate is no longer pending.");
  if (!candidate.approvable || candidate.policyId === undefined || !candidate.requiredPrincipal) {
    throw refused("NOT_ATTESTABLE", `Candidate '${candidate.id}' is not an approvable direct-ledger candidate.`);
  }
  if (candidate.projectRoot !== path.resolve(locked.targetRoot)) {
    throw refused("WRONG_RECORD", "Candidate project root is not the locked record's target root.");
  }
  let record;
  if (locked.recordKind === "module") {
    if (!usesDirectLedgerDecisions(locked.state) || typeof locked.state.migrationId !== "string" || !locked.state.migrationId) {
      throw refused("NOT_ATTESTABLE", "Only a format-19 module record with a persisted migrationId takes attested decisions.");
    }
    if (candidate.kind !== DECISION_GROUP_KIND && locked.candidates.some((entry) =>
      entry.kind === DECISION_GROUP_KIND && entry.groupMembers.some((member) => member.id === candidate.id))) {
      throw refused("GROUP_REVIEW_REQUIRED", "This candidate belongs to one ordered decision group; attest the group.");
    }
    record = { migrationId: locked.state.migrationId, module: locked.recordName };
  } else {
    if (!usesArtifactDirectLedger(locked.state.formatVersion) || !protocol.ATTESTED_ARTIFACT_KINDS.includes(candidate.kind)) {
      throw refused("NOT_ATTESTABLE", "Artifact direct-ledger attestation covers only format-14 ARTIFACT_DECISION and VISUAL_UNBACKED candidates.");
    }
    if (locked.state.artifactId !== locked.recordName) throw refused("WRONG_RECORD", "Artifact identity does not match its record.");
    record = { artifactId: locked.state.artifactId, artifactType: locked.state.artifactType,
      sourceRoot: locked.state.source?.root, sourcePath: locked.state.source?.path };
  }
  const group = candidate.kind === DECISION_GROUP_KIND;
  return {
    protocol: protocol.ASSERTION_PROTOCOL,
    recordKind: locked.recordKind,
    record,
    projectRoot: candidate.projectRoot,
    lifecycleDigest: protocol.sha256Digest(await lifecycleBinding(locked.state, path.join(locked.root, "state.json"))),
    candidateDigest: candidateDigestOf(candidate),
    result,
    requiredPrincipal: candidate.requiredPrincipal,
    policyId: candidate.policyId,
    policyDigest: candidate.policyDigest,
    groupMembersDigest: group ? protocol.groupMembersDigestOf(candidate.boundTo.members) : null,
    groupMemberCount: group ? candidate.boundTo.members.length : 0,
  };
};

/** Fresh review data for the companion: the same derivation the writer uses. */
export const reviewAttestedCandidate = ({ signer, target, candidateId }) =>
  attestationVerifierScope.run(signer, async () => {
    const locked = await attestedRecompute(target)();
    const candidate = locked.candidates.find((entry) => entry.id === candidateId);
    const binding = await attestedBinding(candidate, locked, "APPROVED");
    return { candidate, review: candidate.review ?? reviewFor(candidate), record: binding.record };
  });

/** Issue one challenge for one explicit result over the freshly derived candidate. */
export const beginAttestedDecision = ({ signer, target, candidateId, result, expectedDigest }) =>
  attestationVerifierScope.run(signer, async () => {
    const locked = await attestedRecompute(target)();
    const binding = await attestedBinding(locked.candidates.find((entry) => entry.id === candidateId), locked, result);
    if (expectedDigest !== undefined && binding.candidateDigest !== expectedDigest) {
      throw refused("STALE_REVIEW", "The candidate changed after the page was rendered.");
    }
    return signer.issue({ binding, ledgerFile: path.join(locked.root, DECISIONS_FILE) });
  });

/**
 * The only HUMAN_ATTESTED append. Under the record lock: rederive candidate,
 * policy and lifecycle, compare with the issued payload, refuse duplicates,
 * verify the assertion, claim nonce+counter durably, append one fsynced line,
 * have the signer COMMIT that exact line, then reread the fresh projection.
 * `onBoundary` exists for crash-injection tests; it can only throw.
 */
export const completeAttestedDecision = ({ signer, target, candidateId, nonce, response, onBoundary = () => {} }) =>
  attestationVerifierScope.run(signer, async () => {
    const recompute = attestedRecompute(target);
    const first = await recompute();
    const ledgerFile = path.join(first.root, DECISIONS_FILE);
    const issued = signer.issued(nonce, ledgerFile);
    const lockName = first.recordKind === "artifact" ? `artifact-${first.recordName}` : first.recordName;
    const decision = await withModuleLock(first.targetRoot, lockName, async () => {
      const locked = await recompute();
      assertRecordToolkitIdentity(locked.state, locked.recordName, "Recording an operator decision", locked.recordKind);
      if (locked.recordKind !== "artifact") {
        assertNoPendingFormatUpgrade(locked.state, locked.recordName, "Recording an operator decision");
      }
      if (path.join(locked.root, DECISIONS_FILE) !== ledgerFile) throw refused("WRONG_RECORD", "The record moved while its review was open.");
      const candidate = locked.candidates.find((entry) => entry.id === candidateId);
      const binding = await attestedBinding(candidate, locked, issued.result);
      if (locked.recordKind !== "artifact" && !decisionKindAllowed(candidate.kind,
        (locked.state.completedSteps ?? []).includes("DISCOVERY_COMPLETENESS"))) {
        throw refused("POST_CENSUS_DECISION", "Only post-census decision kinds may be recorded after DISCOVERY_COMPLETENESS closed.");
      }
      const { BINDING_KEYS } = await webauthnProtocol();
      const current = signer.issued(nonce, ledgerFile);
      if (BINDING_KEYS.some((key) => JSON.stringify(binding[key]) !== JSON.stringify(current[key]))) {
        throw refused("STALE_REVIEW", "Candidate, policy, lifecycle or record changed after the challenge was issued.");
      }
      const { decisions } = await readRecordedDecisions(locked.root);
      const existing = decisions.find((line) => line.v === 2 && line.candidateDigest === binding.candidateDigest);
      if (existing) throw refused("DUPLICATE_DECISION", `Candidate already has ledger entry ${existing.id} (${existing.result}).`);
      const { decisions: operatorLines } = await readOperatorDecisions(locked.root);
      await onBoundary("before-verify");
      const verified = await signer.preverify({ nonce, response, ledgerFile });
      await onBoundary("after-verify");
      const shape = buildDecision({
        previous: operatorLines.at(-1) ?? null,
        kind: candidate.kind,
        subjectType: candidate.subject.type,
        subject: candidate.subject.path,
        statement: `HUMAN_ATTESTED ${binding.result} of candidate ${candidate.id}.`,
        rationale: candidate.rationale,
        candidateId: candidate.id,
        targets: candidate.targets,
        boundTo: candidate.boundTo,
        operator: `webauthn:${verified.operator}`,
        principal: "AGENT_RELAYED",
        result: binding.result,
        candidateDigest: binding.candidateDigest,
        policyId: binding.policyId,
        policyDigest: binding.policyDigest,
      });
      // Same v2 shape and key order as every DEC- line; only the principal and
      // the public proof differ, and only the signer's claim makes them authority.
      const line = { ...shape, principal: "HUMAN_ATTESTED", webauthn: verified.proof };
      await onBoundary("before-claim");
      signer.claim({ nonce, verified, line, ledgerFile });
      await onBoundary("after-claim");
      await appendDurably(locked.targetRoot, ledgerFile, `${JSON.stringify(line)}\n`, onBoundary);
      await onBoundary("before-commit");
      await signer.commit({ nonce, ledgerFile });
      await onBoundary("after-commit");
      return line;
    });
    const projection = target.recordKind === "module"
      ? await projectDecisions({ registryPath: target.registryPath, moduleName: target.moduleName })
      : (await deriveArtifactDecisions(target.artifact)).decisionProjection;
    await onBoundary("before-response");
    return { decision, projection };
  });

// The artifact half of the one operator-decision recorder. Same TTY/`ask`
// gate, same challenge phrase, same recompute-under-lock, same append-only
// chain -- only the ledger location (the artifact record) and the candidate
// source (the artifact source inventory) differ. The artifact engine is
// imported lazily so the module<->record graph stays statically acyclic.
const deriveArtifactDecisions = async (artifact) => {
  const engine = await import(
    "./artifact/artifact-migration.mjs"
  );
  const context = await engine.artifactOperatorDecisions(artifact);
  const { decisions } = await readRecordedDecisions(context.root);
  const candidates = pendingArtifactDecisions(context, decisions);
  return { engine, context, candidates,
    ...(usesArtifactDirectLedger(context.state.formatVersion) ? {
      decisionProjection: engine.reconcileArtifactDecisions(context.state, context.decisions).projection,
    } : {}) };
};

const runArtifactDecisionCli = async (options, { stdin, stdout, ask }) => {
  const { context, candidates, decisionProjection } = await deriveArtifactDecisions(options.artifact);

  if (options.verify) {
    const report = await verifyRecord(context.root);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.outcome !== "CONSISTENT") process.exitCode = BLOCKED_EXIT_CODE;
    return report;
  }
  if (options.list) {
    // Two ledgers, listed as two: `decisions` stays the human record exactly as
    // it always was, and AUTO lines are reported beside it, never folded in.
    const { operator, auto } = await readRecordedDecisions(context.root);
    stdout.write(`${JSON.stringify({ decisions: operator, autoDecisions: auto }, null, 2)}\n`);
    return { listed: operator.length + auto.length };
  }
  if (options.pending) {
    stdout.write(
      `${JSON.stringify({ artifactId: context.id, candidates, ...(decisionProjection ? { decisionProjection } : {}) }, null, 2)}\n`,
    );
    return { artifactId: context.id, candidates, ...(decisionProjection ? { decisionProjection } : {}) };
  }

  return approveCandidate({
    candidates,
    approve: options.approve,
    stdin,
    stdout,
    ask,
    lockName: `artifact-${context.id}`,
    targetRoot: context.targetRoot,
    renderSummary: (selected) =>
      `Operator decision for artifact '${context.id}'\n` +
      `Candidate: ${selected.id}\n` +
      `Kind: ${selected.kind}\n` +
      `Subject: ${selected.subject.type} ${selected.subject.path}\n` +
      (selected.boundTo.figmaContextDigest
        ? `Figma sources: ${selected.boundTo.figmaSources.join(", ")}\n` +
          `Figma context digest: ${selected.boundTo.figmaContextDigest}\n` +
          `Visual contract digest: ${selected.boundTo.visualContractDigest}\n`
        : `Legacy source: ${selected.boundTo.legacyRevision}/${selected.boundTo.legacyDirtyDigest}\n` +
          `Discovery digest: ${selected.boundTo.discoveryDigest}\n`) +
      `Agent-authored rationale:\n${selected.rationale}\n\n` +
      `This approval binds to that exact stable candidate and subject.\n` +
      `Type the challenge phrase to approve, anything else to abort.\n`,
    statementFor: (candidate, ask_) =>
      `Approved stable artifact candidate ${candidate.id} ${approvedByPhrase(ask_)} ${APPROVAL_EVIDENCE(ask_)}.`,
    recompute: async () => {
      const locked = await deriveArtifactDecisions(options.artifact);
      return {
        candidates: locked.candidates,
        root: locked.context.root,
        targetRoot: locked.context.targetRoot,
        state: locked.context.state,
        recordName: locked.context.id,
        recordKind: "artifact",
      };
    },
  });
};

export const runRecordDecisionCli = async (
  arguments_,
  { stdin = process.stdin, stdout = process.stdout, ask = null } = {},
) => {
  const options = parseDecisionArguments(arguments_);

  // Authority is checked before registry resolution, state reads, scans, or
  // locks. A non-TTY agent gets the authority refusal even in an empty or
  // misconfigured working directory and can only use the read-only modes.
  // `ask` is the only thing that stands in for a TTY, and it cannot be reached
  // from argv: `parseDecisionArguments` declares no option that produces it.
  if (options.approve && !ask && (!stdin.isTTY || !stdout.isTTY)) {
    const refusal =
      "Operator decisions are recorded only from an interactive terminal. " +
      "This invocation has no TTY, so nothing was read or written. " +
      "An agent may run --pending, but it can never approve a candidate.\n";
    if (stdout === process.stdout) writeSync(1, refusal);
    else stdout.write(refusal);
    process.exitCode = BLOCKED_EXIT_CODE;
    return { blocked: true };
  }

  if (options.artifact) {
    return runArtifactDecisionCli(options, { stdin, stdout, ask });
  }

  assertSafeName(options.moduleName);
  const { registryPath } = await resolveRegistryPath({
    cliPath: options.registryOption,
    moduleName: options.moduleName,
  });

  // The no-MCP front end of `migration_relay_decision`: same function, same authority.
  if (options.relay !== undefined) {
    const log = [];
    const result = await relayOperatorDecision({
      registryPath, moduleName: options.moduleName, reference: options.relay, decision: options.decision,
      stdout: { write: (chunk) => (log.push(String(chunk)), true) },
    });
    stdout.write(`${JSON.stringify({ ...result, log: log.join("") }, null, 2)}\n`);
    process.exitCode = result.outcome === "BLOCKED" ? BLOCKED_EXIT_CODE : 0;
    return result;
  }

  if (options.list || options.verify) {
    const { registryData, resolved } = await readMigrationContext({
      registryPath,
      moduleName: options.moduleName,
    });
    // `--verify` resolves the record root without opening the record: a
    // migration whose state.json a validator would refuse is exactly the one an
    // operator most needs this command for.
    const root = path.join(
      registryData.targetRoot,
      ".agents/knowledge/migrations/modules",
      resolved.canonical,
    );
    if (options.verify) {
      const report = await verifyRecord(root);
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.outcome !== "CONSISTENT") process.exitCode = BLOCKED_EXIT_CODE;
      return report;
    }
    const opened = await readState(registryData.targetRoot, resolved.canonical);
    // Same shape as the artifact listing above, for the same reason.
    const { operator, auto } = await readRecordedDecisions(opened.root);
    stdout.write(`${JSON.stringify({ decisions: operator, autoDecisions: auto }, null, 2)}\n`);
    return { listed: operator.length + auto.length };
  }

  const pending = await derivePendingDecisions({
    registryPath,
    moduleName: options.moduleName,
  });
  if (options.pending) {
    stdout.write(`${JSON.stringify(pending.public, null, 2)}\n`);
    return pending.public;
  }

  const gate = {
    stdin,
    stdout,
    ask,
    lockName: pending.resolved.canonical,
    targetRoot: pending.registryData.targetRoot,
    renderSummary: (selected) =>
      `Operator decision for migration '${pending.resolved.canonical}'\n` +
      `Candidate: ${selected.id}\n` +
      `Kind: ${selected.kind}\n` +
      `Subject: ${selected.subject.type} ${selected.subject.path}\n` +
      `Concrete targets: ${selected.targets.length > 0 ? selected.targets.join(", ") : "none"}\n` +
      `Legacy source: ${selected.boundTo.legacyRevision}/${selected.boundTo.legacyDirtyDigest}\n` +
      `Discovery digest: ${selected.boundTo.discoveryDigest}\n` +
      `Agent-authored rationale:\n${selected.rationale}\n\n` +
      `This approval binds to that exact stable candidate and subject.\n` +
      `Type the challenge phrase to approve, anything else to abort.\n`,
    statementFor: (candidate, ask_) =>
      `Approved stable candidate ${candidate.id} ${approvedByPhrase(ask_)} ${APPROVAL_EVIDENCE(ask_)}.`,
    recompute: moduleRecompute({ registryPath, moduleName: options.moduleName }),
  };
  if (pending.public.group && usesDirectLedgerDecisions(pending.state) &&
      pending.public.group.groupMembers.some((member) => member.id === options.approve)) {
    const blocked = { state: "GROUP_REVIEW_REQUIRED",
      reason: "This candidate belongs to one ordered decision group; an individual line cannot authorize a subset. Review the complete group instead." };
    stdout.write(renderDecisionReview(pending.public.group.review));
    stdout.write(`${blocked.state}: ${blocked.reason}\n`);
    process.exitCode = BLOCKED_EXIT_CODE;
    return { blocked };
  }
  return pending.public.group?.id === options.approve
    ? approveDecisionGroup({ group: pending.public.group, ...gate })
    : approveCandidate({
        candidates: pending.public.candidates,
        approve: options.approve,
        ...gate,
      });
};

/**
 * Relay the operator's explicit conversational APPROVE/REJECT for one open
 * format-19 review. It goes through the same gate as every other answer: the
 * module lock, the recompute, the deep-equality check and the policy's
 * requiredPrincipal. So it records AGENT_RELAYED or nothing.
 */
export const relayOperatorDecision = async ({ registryPath, moduleName, reference, decision, stdout = process.stdout }) => {
  assertRelayDecision(decision);
  const pending = await pendingDecisionCandidates({ registryPath, moduleName });
  const stale = (reason) => ({
    outcome: "BLOCKED", recorded: [], reason: `STALE_REVIEW: ${reason}`,
    blocked: { state: "STALE_REVIEW", reason },
  });
  const selected = relayedReview(pending, reference, moduleName);
  if (!selected) {
    return stale("The reviewed decision is no longer the current pending review. Nothing was written; run the migration again for the current review.");
  }
  let result;
  try {
    result = await runRecordDecisionCli([moduleName, "--approve", selected.id], {
      stdout, ask: relayAnswer(reference, decision),
    });
  } catch (error) {
    if (/changed while its review was open/.test(error.message)) return stale(error.message);
    throw error;
  }
  if (result?.blocked) {
    return { outcome: "BLOCKED", recorded: [], reason: `${result.blocked.state}: ${result.blocked.reason}`, blocked: result.blocked };
  }
  const recorded = (result?.decisions ?? (result?.decision ? [result.decision] : [])).map((line) => line.id);
  return {
    outcome: "CONTINUE", recorded,
    reason: `Recorded AGENT_RELAYED ${decision === "APPROVE" ? "APPROVED" : "REJECTED"} ${recorded.join(", ")}. Run the migration again to continue.`,
    decisions: (await pendingDecisionCandidates({ registryPath, moduleName })).decisions,
  };
};

if (isMainModule(import.meta.url)) {
  runRecordDecisionCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
