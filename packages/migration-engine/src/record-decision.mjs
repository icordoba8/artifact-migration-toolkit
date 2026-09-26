#!/usr/bin/env node

/**
 * Operator-only recorder for `decisions/operator-decisions.ndjson`.
 *
 * A non-empty string is not an approval. Every disposition that means "this
 * legacy file is not being migrated" -- `EXCLUDED_APPROVED`, `DEAD` -- and
 * every unproven edge cleared by hand needs an approval bound to the exact
 * candidate it approves.
 *
 * *Who* may answer is a policy question with three answers, not one: a human at
 * a TTY, a human reached through the host, or the engine itself under
 * `--mode auto` (`autoApprovalChannel`). The TTY is the default boundary for an
 * argv invocation that declared no channel -- an agent harness running helpers
 * non-interactively is refused before a byte is touched -- but it was never the
 * thing that made a decision sound. The comparison against the challenge is,
 * and all three principals go through it.
 *
 * `ask` is the mechanism all non-TTY channels use, and it is an
 * in-process function reference, never an argv option, an environment variable,
 * or a tool argument. A front end may pass it only when it has itself obtained
 * a human answer through a channel the model does not control -- today only the
 * MCP adapter, and only after the *client* declared `elicitation` during
 * `initialize`. Everything downstream of the answer is unchanged: the same
 * challenge phrase, the same module lock, the same recompute-under-lock, the
 * same chained append.
 *
 * `ask` returns an *answer*, never a verdict. It is compared here against the
 * phrase derived from the candidate recomputed under the lock, exactly as a
 * terminal line is, and a front end that returns anything it composed itself
 * rather than something the human supplied has approved nothing on its own
 * authority -- it has only moved the forgery one file over. That is not
 * hypothetical: an inline channel answering its own challenge on a bare host
 * `accept` can authorize multiple ledger lines without an operator. The
 * comparison below is the whole gate and nothing may shortcut it.
 *
 * ponytail: a TTY gate plus one trusted in-process channel, not cryptography.
 * An operator's own terminal can always forge a line -- that is the operator's
 * authority by definition, the same ceiling as history not being hash-chained.
 * Upgrade path: a detached signature over each line, verified against a key
 * pinned at RESOLVE.
 */

import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  assertSafeName,
  assertSecurePath,
  resolveRegistryPath,
} from "./migration-utils.mjs";
import {
  engineCommand,
  isMainModule,
} from "./engine-paths.mjs";
import { withModuleLock } from "./module-lock.mjs";
import { activeToolkitIdentity } from "./toolkit-identity.mjs";
import {
  assertDiscoveryCompletenessFormat,
  assertNoPendingFormatUpgrade,
  assertRecordToolkitIdentity,
  AUTO_DECISIONS_FILE,
  BLOCKED_EXIT_CODE,
  createDecisionCandidate,
  DECISIONS_FILE,
  decisionAppliesToCandidate,
  decisionChannelOf,
  decisionGroupFor,
  decisionLineDigest,
  decisionRationaleDigest,
  edgeDecisionSubject,
  LATE_DECISION_KINDS,
  legacySourceBinding,
  legacySourcesOf,
  lifecycleBinding,
  MODULE_CLASSIFICATION_FILE,
  pendingTargetDriftCandidates,
  pendingVisualUnbackedCandidates,
  previewDiscoveryScan,
  readAutoDecisions,
  readMigrationContext,
  readOperatorDecisions,
  readRecordedDecisions,
  readState,
} from "./resumable-migration.mjs";

export const DECISION_KINDS = [
  "EXCLUSION",
  "DEAD_CONFIRMATION",
  "EDGE_RESOLUTION",
  "ROOT_DECLARATION",
  // W4-4. Some target drift is legitimate and unforeseeable -- a lockfile a
  // package manager regenerated, a formatter run. It routes through this
  // recorder like every other operator act, under the same challenge phrase and
  // the same module lock. Never a CLI flag: a flag nobody has to think about is
  // exactly what turns a security boundary into a formality.
  "TARGET_DRIFT_ACCEPTED",
  // Format 17. A required visual state no COMPLETE Figma evidence designs may
  // be left without visual acceptance only by an operator, bound to the Figma
  // context and visual contract the operator was shown.
  "VISUAL_UNBACKED",
];

/**
 * A challenge derived from the subject, so approving is a deliberate act about
 * one specific thing. `y` approves anything; this approves this.
 */
export const challengeFor = (candidate) =>
  `APPROVE ${candidate.id} ${candidate.kind} ${candidate.subject.path}`;

/**
 * The three principals that can answer a challenge, named once. `TERMINAL` is a
 * human at a TTY, `ELICITATION` a human reached through the host, and `AUTO`
 * the engine itself running under `--mode auto`.
 *
 * `AUTO` is a declared principal, not a forged human. The distinction is the
 * whole point of naming it: the ledger line says which one decided, so an
 * unattended run is auditable as an unattended run rather than being
 * indistinguishable from someone typing. The gate it passes through is the same
 * one -- `answer.trim() === challenge` -- and so is every digest that binds the
 * line to the bytes it approved.
 */
export const APPROVAL_CHANNELS = Object.freeze(["TERMINAL", "ELICITATION", "AUTO"]);

export const channelOf = (ask) =>
  ask ? (ask.channel ?? "ELICITATION") : "TERMINAL";

/**
 * An `ask` that answers on the engine's own authority. It is a real answerer
 * held to the real comparison -- it returns the challenge it was handed, and
 * `withOperatorApproval` compares it exactly as it compares a typed one -- so
 * no gate is short-circuited; only the principal differs, and the principal is
 * recorded.
 *
 * `reason` names the evidence the engine decided from and is carried into the
 * decision's rationale, so an `AUTO` line is never just an assertion that the
 * engine felt like it.
 */
export const autoApprovalChannel = (reason) =>
  Object.assign(({ challenge }) => challenge, { channel: "AUTO", reason });

/**
 * Who the recorded statement names. An AUTO line never says "operator": the
 * whole guarantee is that an unattended decision reads as an unattended
 * decision, in the ledger, in the sentence, and in the id.
 */
export const approvedByPhrase = (ask) =>
  channelOf(ask) === "AUTO" ? "by the AUTO principal" : "by operator";

const APPROVAL_EVIDENCE = (ask) =>
  ({
    TERMINAL: "at a terminal",
    ELICITATION:
      "through a host-originated approval request answered with the candidate confirmation phrase",
    AUTO: "on the engine's own authority under --mode auto, from repository evidence",
  })[channelOf(ask)];

const GROUP_APPROVAL_EVIDENCE = (ask) =>
  ({
    TERMINAL: "through one group confirmation phrase typed at a terminal",
    ELICITATION:
      "through one host-originated approval request answered with the group confirmation phrase",
    AUTO: "on the engine's own authority under --mode auto, from repository evidence covering the whole group",
  })[channelOf(ask)];

export const APPROVAL_EVIDENCE_PHRASES = APPROVAL_CHANNELS.flatMap((channel) => {
  const ask = channel === "TERMINAL" ? null : { channel };
  return [APPROVAL_EVIDENCE(ask), GROUP_APPROVAL_EVIDENCE(ask)];
});

export const parseDecisionArguments = (arguments_) => {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      approve: { type: "string" },
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
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      "Choose exactly one of --pending, --approve <stable-id>, --list, or --verify.",
    );
  }
  if (values.artifact !== undefined) {
    if (positionals.length !== 0) {
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
      "Usage: record-decision.mjs <module> (--pending | --approve <stable-id> | --list | --verify) [--registry <path>]",
    );
  }
  return {
    moduleName: positionals[0],
    approve: values.approve,
    list: values.list,
    pending: values.pending,
    verify: values.verify,
    registryOption: values.registry,
  };
};

const operatorIdentity = () =>
  `${process.env.USER ?? process.env.USERNAME ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host"}`;

/**
 * The rationale digest binds an approval to the exact bytes it approves, so an
 * agent cannot rewrite the justification under an already-granted approval.
 * Normalized for line endings only -- a CRLF checkout is not a new rationale.
 */
export const rationaleDigestOf = decisionRationaleDigest;

export const buildDecision = ({
  previous,
  kind,
  subjectType,
  subject,
  statement,
  rationale,
  boundTo,
  candidateId,
  targets,
  authorizedBy,
  at = new Date().toISOString(),
  operator = operatorIdentity(),
  // `AUTO-` for the AUTO principal's own ledger. The prefix is the point: the
  // two ledgers number independently, so without it both would mint `DEC-001`
  // and a citation would resolve to whichever file was read first. It also
  // means no AUTO decision can ever be read as a human one -- not in a state
  // row, not in a history event, not by eye.
  idPrefix = "DEC",
}) => {
  const seq = (previous?.seq ?? 0) + 1;
  return {
    id: `${idPrefix}-${String(seq).padStart(3, "0")}`,
    seq,
    prevDigest: previous ? decisionLineDigest(previous) : "genesis",
    at,
    operator,
    kind,
    subject: { type: subjectType, path: subject },
    statement,
    rationaleDigest: rationaleDigestOf(rationale),
    ...(candidateId ? { candidateId } : {}),
    ...(targets ? { targets: [...targets] } : {}),
    boundTo,
    ...(authorizedBy ? { authorizedBy } : {}),
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
  const boundTo = {
    module: resolved.canonical,
    ...legacySource,
    discoveryDigest: scan.discoveryDigest,
    algorithmVersion: scan.algorithmVersion,
  };
  // Both ledgers: "is this candidate already decided" has one answer, and the
  // principal that decided it does not change it.
  const { decisions, byId } = await readRecordedDecisions(root);
  const candidates = [];
  // Ledger-backed receipts for candidates that are already approved but not yet
  // cited. An approval recorded at a terminal is otherwise invisible to the next
  // iteration: the candidate stops pending, and the agent has no way to learn
  // the `decisionId`/`decisionDigest` the classification must carry short of the
  // operator reading them out of a file. Derived, never authored -- each one is
  // a line that `decisionAppliesToCandidate` already bound to a live candidate.
  const references = [];
  const addCandidate = ({
    kind,
    subjectType,
    subjectPath,
    rationale,
    targets = [],
    decisionId,
    blockers = [],
    boundToOverride,
    // Default true: a candidate the engine derived from evidence it holds is
    // resolvable by the principal running the engine. Only a candidate whose
    // *question* is underivable -- today, drift with no ownership to read --
    // opts out, and it opts out of AUTO alone; a human can still decide it.
    autoResolvable = true,
  }) => {
    const candidate = createDecisionCandidate({
      kind,
      subjectType,
      subjectPath,
      rationale: rationale ?? "",
      targets,
      boundTo: boundToOverride ?? boundTo,
    });
    const applied = [byId.get(decisionId), ...decisions].find((decision) =>
      decisionAppliesToCandidate(decision, candidate),
    );
    if (applied) {
      references.push({
        candidateId: candidate.id,
        subject: candidate.subject,
        decisionId: applied.id,
        decisionDigest: decisionLineDigest(applied),
      });
      return;
    }
    const allBlockers = [...blockers];
    if (!String(rationale ?? "").trim()) {
      allBlockers.push("The classification has no operator-reviewable rationale.");
    }
    candidates.push({
      ...candidate,
      approvable: allBlockers.length === 0,
      autoResolvable,
      blockers: allBlockers,
      command: engineCommand(
        "record-decision.mjs",
        resolved.canonical,
        "--approve",
        candidate.id,
      ),
    });
  };

  const roots = Array.isArray(classification.moduleRoots)
    ? classification.moduleRoots
    : [];
  // One implicit root per declared source, exactly as `validateDiscovery-
  // Completeness` computes it. Keying on `state.legacyModule` alone would flag
  // every other source's basename-matching root as a pending ROOT_DECLARATION
  // the validator never asks for. Identical to a single-source record.
  const implicitRoots = new Set(
    legacySourcesOf(state)
      .map(
        (name) =>
          [...scan.moduleRoots]
            .filter((value) => path.posix.basename(value) === name)
            .sort()[0],
      )
      .filter(Boolean),
  );
  for (const entry of roots) {
    const rootPath = typeof entry === "string" ? entry : entry?.path;
    if (!rootPath || implicitRoots.has(rootPath)) continue;
    addCandidate({
      kind: "ROOT_DECLARATION",
      subjectType: "MODULE_ROOT",
      subjectPath: rootPath,
      rationale: typeof entry === "object" ? entry.reason : "",
      decisionId: typeof entry === "object" ? entry.decisionId : undefined,
    });
  }

  const dispositionKinds = {
    DEAD: "DEAD_CONFIRMATION",
    EXCLUDED_APPROVED: "EXCLUSION",
  };
  for (const row of Array.isArray(classification.files)
    ? classification.files
    : []) {
    const kind = dispositionKinds[row?.disposition];
    if (!kind || typeof row?.path !== "string") continue;
    addCandidate({
      kind,
      subjectType: "FILE",
      subjectPath: row.path,
      rationale: row.rationale,
      decisionId: row.decisionId,
    });
  }

  const findingRows = new Map(
    (Array.isArray(classification.findings) ? classification.findings : [])
      .filter((row) => typeof row?.id === "string")
      .map((row) => [row.id, row]),
  );
  // Unclaimed target drift, derived by the engine from the same set difference
  // FINALIZE refuses on. The acceptance binds to the path's current bytes, so
  // editing the file afterwards re-blocks.
  for (const drift of await pendingTargetDriftCandidates(root, state, {
    legacyRoot: registryData.legacyRoot,
    targetRoot: registryData.targetRoot,
  })) {
    addCandidate({
      kind: "TARGET_DRIFT_ACCEPTED",
      subjectType: "TARGET_FILE",
      subjectPath: drift.subjectPath,
      rationale: drift.rationale,
      autoResolvable: drift.autoResolvable,
      boundToOverride: { ...boundTo, pathDigest: drift.pathDigest },
    });
  }

  for (const visual of await pendingVisualUnbackedCandidates(root, state)) {
    addCandidate({
      kind: visual.kind,
      subjectType: visual.subject.type,
      subjectPath: visual.subject.path,
      rationale: visual.rationale,
      boundToOverride: visual.boundTo,
    });
  }

  for (const finding of scan.findings) {
    const row = findingRows.get(finding.id);
    const targets = finding.resolvedTargets ?? [];
    const blockers = [];
    if (finding.type === "I18N_NAMESPACE") {
      blockers.push(
        "The scanner has no proven tracked i18n resource; fix governing configuration before approval.",
      );
    } else if (targets.length === 0) {
      blockers.push(
        "The unresolved module edge has no concrete tracked target; prose or approval cannot resolve it.",
      );
    }
    addCandidate({
      kind: "EDGE_RESOLUTION",
      subjectType: scan.algorithmVersion >= 2 ? "MODULE_EDGE" : "FILE",
      subjectPath:
        scan.algorithmVersion >= 2
          ? edgeDecisionSubject(finding)
          : finding.file,
      rationale: row?.resolution ?? row?.rationale,
      targets,
      decisionId: row?.decisionId,
      blockers,
    });
  }

  candidates.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.subject.path.localeCompare(right.subject.path) ||
      left.id.localeCompare(right.id),
  );
  const lifecycle = await lifecycleBinding(state, path.join(root, "state.json"));
  const groupable = (state.completedSteps ?? []).includes(
    "DISCOVERY_COMPLETENESS",
  )
    ? candidates.filter((candidate) => LATE_DECISION_KINDS.has(candidate.kind))
    : candidates;
  const group = decisionGroupFor(groupable, lifecycle);
  return {
    public: {
      module: resolved.canonical,
      algorithmVersion: scan.algorithmVersion,
      discoveryDigest: scan.discoveryDigest,
      lifecycle,
      group,
      candidates,
      references,
    },
    registryData,
    resolved,
    root,
    state,
  };
};

export const pendingDecisionCandidates = async (options) =>
  (await derivePendingDecisions(options)).public;

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
  // Ahead of the summary, the challenge and the lock, because it is not a
  // refusal of this answer -- it is a statement that this principal was never
  // eligible to be asked. A candidate whose question the engine cannot derive
  // is a genuine external blocker under `--mode auto`, and the only honest
  // outcome is to stop and say which candidate and why.
  if (channelOf(ask) === "AUTO" && selected.autoResolvable === false) {
    stdout.write(
      `Candidate '${selected.id}' is not resolvable from repository evidence, so the AUTO principal cannot decide it: ` +
        `${selected.blockers?.join(" ") || "the evidence that would settle it is not derivable from this record."} ` +
        `Nothing was written. Decide it with --mode step, or supply the missing evidence.\n`,
    );
    process.exitCode = BLOCKED_EXIT_CODE;
    return { blocked: true };
  }
  const challenge = challengeFor(selected);
  // The same bytes either way: a terminal reads them off stdout, a host reads
  // them out of the elicitation message. Only the terminal asks for a phrase.
  const summary = renderSummary(selected);
  stdout.write(summary);
  let answer;
  if (ask) {
    // The front end owns the human channel; it never owns the verdict. Whatever
    // comes back is compared against the same phrase a terminal is compared
    // against, and a non-string is a mismatch rather than a throw.
    answer = String((await ask({ candidate: selected, challenge, summary })) ?? "");
  } else {
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      answer = await reader.question(`Challenge: ${challenge}\n> `);
    } finally {
      reader.close();
    }
  }
  if (answer.trim() !== challenge) {
    stdout.write(
      ask
        ? "No matching inline confirmation phrase was received. Nothing was written.\n"
        : "Challenge phrase did not match. Nothing was written.\n",
    );
    process.exitCode = BLOCKED_EXIT_CODE;
    return { blocked: true };
  }

  return withModuleLock(targetRoot, lockName, async () => {
    // Recompute the selected candidate under the lock. Looking up the old id in
    // an unlocked list is never authority to append a line.
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
    const lockedCandidate = locked.candidates.find(
      (candidate) => candidate.id === selected.id,
    );
    if (
      !lockedCandidate ||
      !lockedCandidate.approvable ||
      JSON.stringify(lockedCandidate) !== JSON.stringify(selected)
    ) {
      throw new Error(
        `Candidate '${selected.id}' changed or ceased to be pending while the challenge was open. Nothing was written; run --pending again.`,
      );
    }
    return onApproved(lockedCandidate, locked);
  });
};

/**
 * Which ledger a line belongs in, decided from the line itself and nowhere
 * else. `--mode auto` never reaches the human record: not by a caller passing a
 * path, not by a flag, not by an option combination. There is one expression
 * that maps principal to file and this is it.
 */
export const ledgerFileForChannel = (channel) =>
  channel === "AUTO" ? AUTO_DECISIONS_FILE : DECISIONS_FILE;

const appendDecisions = async (locked, decisions, stdout) => {
  const channels = new Set(decisions.map((decision) => decisionChannelOf(decision)));
  if (channels.size > 1) {
    throw new Error(
      `One append may not mix decision principals (${[...channels].sort().join(", ")}); each ledger is one principal's append-only chain.`,
    );
  }
  const file = await assertSecurePath(
    locked.targetRoot,
    path.join(locked.root, ledgerFileForChannel([...channels][0])),
  );
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(
    file,
    decisions.map((decision) => `${JSON.stringify(decision)}\n`).join(""),
    { flag: "a", mode: 0o600 },
  );
  for (const decision of decisions) {
    stdout.write(
      `Recorded ${decision.id} (${decision.kind}) for ${decision.subject.path}.\n`,
    );
  }
};

export const groupFactsDigest = (facts) =>
  decisionRationaleDigest(JSON.stringify(facts));

/**
 * The head of the chain this principal extends, and the prefix its ids take.
 * Two ledgers, two independent chains; neither ever reads the other's head, so
 * an AUTO append cannot renumber the human record or vice versa.
 */
const ledgerHeadFor = async (root, channel) => {
  const auto = channel === "AUTO";
  const { decisions } = auto
    ? await readAutoDecisions(root)
    : await readOperatorDecisions(root);
  return { previous: decisions.at(-1) ?? null, idPrefix: auto ? "AUTO" : "DEC" };
};

/**
 * What an AUTO line must carry: the principal, the decision type, the evidence
 * it was decided from, the scope it covers, and the result. Plus the identity
 * of the build that decided, so provenance names a release and not just "the
 * engine".
 *
 * `undefined` for a human single decision, which keeps today's line shape byte
 * for byte -- `buildDecision` drops an absent `authorizedBy`, so no existing
 * record's digests move. A human *group* decision keeps its own existing
 * `authorizedBy`; this is only the single-decision path.
 */
const autoAuthorization = (ask, candidate) =>
  channelOf(ask) === "AUTO"
    ? {
        v: 1,
        principal: "AUTO",
        channel: "AUTO",
        decisionType: candidate.kind,
        evidence: ask.reason,
        toolkit: activeToolkitIdentity() ?? null,
        scope: {
          module: candidate.boundTo?.module ?? null,
          subject: candidate.subject,
          targets: [...(candidate.targets ?? [])],
        },
        result: "APPROVED",
        approvedAt: new Date().toISOString(),
      }
    : undefined;

const appendGroupDecisions = async ({ group, locked, ask, stdout }) => {
  const facts = group.boundTo.members;
  const groupDigest = groupFactsDigest(facts);
  const approvedAt = new Date().toISOString();
  const { previous: head, idPrefix } = await ledgerHeadFor(
    locked.root,
    channelOf(ask),
  );
  let previous = head;
  const written = group.groupMembers.map((member, index) => {
    const decision = buildDecision({
      previous,
      idPrefix,
      kind: member.kind,
      subjectType: member.subject.type,
      subject: member.subject.path,
      statement: `Approved stable candidate ${member.id} ${approvedByPhrase(ask)} ${GROUP_APPROVAL_EVIDENCE(ask)}.`,
      rationale: member.rationale,
      candidateId: member.id,
      targets: member.targets,
      boundTo: member.boundTo,
      authorizedBy: {
        v: 1,
        groupId: group.id,
        groupDigest,
        members: facts.length,
        index: index + 1,
        channel: channelOf(ask),
        // AUTO adds its provenance to what the group act already records; a
        // human group line keeps exactly the fields it has always had.
        // `approvedAt` last: one group act has one timestamp, whoever made it.
        ...(autoAuthorization(ask, member) ?? {}),
        approvedAt,
      },
    });
    previous = decision;
    return decision;
  });
  await appendDecisions(locked, written, stdout);
  return { decisions: written, group: group.id };
};

const approveDecisionGroup = async ({ group, ...gate }) =>
  withOperatorApproval({
    ...gate,
    selected: group,
    renderSummary: (selected) =>
      `Operator decision group for migration '${selected.boundTo.module}'\n` +
      `Group: ${selected.id}\n` +
      `Action: accept ${selected.boundTo.members.length} ${selected.groupMembers[0].kind} decision(s)\n` +
      selected.boundTo.members
        .map(
          (member, index) =>
            `  ${index + 1}. ${member.id} ${member.kind} ${member.subject.type} ${member.subject.path}` +
            `${member.pathDigest ? ` ${member.pathDigest}` : ""}\n`,
        )
        .join("") +
      `This one approval binds to that exact ordered set and lifecycle.\n` +
      `Type the challenge phrase to approve all of them, anything else to abort.\n`,
    onApproved: (lockedGroup, locked) =>
      appendGroupDecisions({
        group: lockedGroup,
        locked,
        ask: gate.ask,
        stdout: gate.stdout,
      }),
  });

const approveCandidate = async ({
  candidates,
  approve,
  statementFor,
  ...gate
}) => {
  const selected = candidates.find((candidate) => candidate.id === approve);
  if (!selected) {
    throw new Error(
      `Approval id '${approve}' is stale or is not pending. Run --pending and select an exact current stable id. Nothing was written.`,
    );
  }
  if (!selected.approvable) {
    throw new Error(
      `Candidate '${selected.id}' is not approvable: ${selected.blockers.join(" ")} Nothing was written.`,
    );
  }
  return withOperatorApproval({
    ...gate,
    selected,
    onApproved: async (lockedCandidate, locked) => {
      const { previous, idPrefix } = await ledgerHeadFor(
        locked.root,
        channelOf(gate.ask),
      );
      const decision = buildDecision({
        previous,
        idPrefix,
        kind: lockedCandidate.kind,
        subjectType: lockedCandidate.subject.type,
        subject: lockedCandidate.subject.path,
        statement: statementFor(lockedCandidate, gate.ask),
        rationale: lockedCandidate.rationale,
        candidateId: lockedCandidate.id,
        targets: lockedCandidate.targets,
        boundTo: lockedCandidate.boundTo,
        authorizedBy: autoAuthorization(gate.ask, lockedCandidate),
      });
      await appendDecisions(locked, [decision], gate.stdout);
      return { decision };
    },
  });
};

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
  const candidates = context.decisions
    .filter(
      (row) =>
        !row.satisfied &&
        !decisions.some((decision) =>
          decisionAppliesToCandidate(decision, row.candidate),
        ),
    )
    .map((row) => {
      const blockers = String(row.subject ?? "").trim()
        ? []
        : ["The operator decision has no reviewable subject."];
      return {
        ...row.candidate,
        approvable: blockers.length === 0,
        blockers,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return { engine, context, candidates };
};

const runArtifactDecisionCli = async (options, { stdin, stdout, ask }) => {
  const { context, candidates } = await deriveArtifactDecisions(options.artifact);

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
      `${JSON.stringify({ artifactId: context.id, candidates }, null, 2)}\n`,
    );
    return { artifactId: context.id, candidates };
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

/**
 * W2-5 / W6-3. The read-only record auditor. It takes no lock, opens no
 * transaction, and advances nothing: it answers "is this record internally
 * consistent" and nothing else.
 *
 * The audit must be answerable by a command, so this re-derives every
 * `prevDigest` itself rather than trusting
 * the chain the record claims, and reports the *first* break plus every line
 * whose recorded `statement` claims an evidence channel it is not entitled to.
 *
 * A line may only claim one of the two phrases `APPROVAL_EVIDENCE` can produce,
 * and either claim is falsifiable: both are only reachable through the single
 * gate in `approveCandidate`, and both require a candidate the engine derived,
 * so a line claiming a channel while carrying no `candidateId` or no complete
 * `boundTo` is describing evidence that cannot have existed.
 */
const BOUND_TO_FIELDS = [
  "module",
  "legacyRevision",
  "legacyDirtyDigest",
  "discoveryDigest",
  "algorithmVersion",
];

export const auditDecisionLedger = (lines) => {
  const findings = [];
  const groups = [];
  let previous = null;
  let chainBrokenAt = null;
  lines.forEach((raw, index) => {
    const position = index + 1;
    let decision;
    try {
      decision = JSON.parse(raw);
    } catch (error) {
      if (chainBrokenAt === null) chainBrokenAt = position;
      findings.push({
        position,
        code: "UNPARSEABLE",
        detail: error.message,
      });
      return;
    }
    const expectedPrev = previous ? decisionLineDigest(previous) : "genesis";
    if (decision.prevDigest !== expectedPrev) {
      if (chainBrokenAt === null) chainBrokenAt = position;
      findings.push({
        position,
        id: decision.id ?? null,
        code: "CHAIN_BROKEN",
        detail: `chains to '${decision.prevDigest}', but the preceding line digests to '${expectedPrev}'`,
      });
    }
    if (decision.seq !== position) {
      findings.push({
        position,
        id: decision.id ?? null,
        code: "SEQ_MISMATCH",
        detail: `records seq ${decision.seq} at position ${position}`,
      });
    }
    const statement = String(decision.statement ?? "");
    const claimed = APPROVAL_EVIDENCE_PHRASES.find((phrase) =>
      statement.includes(phrase),
    );
    if (!claimed) {
      findings.push({
        position,
        id: decision.id ?? null,
        code: "UNRECOGNISED_EVIDENCE_CHANNEL",
        detail: `statement names no channel the recorder can produce: ${JSON.stringify(statement)}`,
      });
    } else {
      const missing = [
        ...(decision.candidateId ? [] : ["candidateId"]),
        ...BOUND_TO_FIELDS.filter(
          (field) => decision.boundTo?.[field] === undefined,
        ).map((field) => `boundTo.${field}`),
      ];
      if (missing.length > 0) {
        findings.push({
          position,
          id: decision.id ?? null,
          code: "UNBOUND_EVIDENCE_CLAIM",
          detail: `claims "${claimed}" but carries no ${missing.join(", ")}; the channel it names can only produce a line bound to a derived candidate`,
        });
      }
    }
    // `groupId`, not merely `authorizedBy`: an AUTO single decision carries an
    // authorization block too, and it is not a group of one.
    if (decision.authorizedBy?.groupId) groups.push({ position, decision });
    previous = decision;
  });
  findings.push(...groupFindings(groups));
  return {
    lines: lines.length,
    chainBrokenAt,
    findings,
    outcome: findings.length === 0 ? "CONSISTENT" : "INCONSISTENT",
  };
};

const groupFindings = (grouped) => {
  const findings = [];
  const byGroup = new Map();
  for (const entry of grouped) {
    const groupId = entry.decision.authorizedBy?.groupId ?? "(none)";
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push(entry);
  }
  for (const [groupId, entries] of byGroup) {
    const first = entries[0];
    const authorization = first.decision.authorizedBy;
    const sameAuthorization = entries.every(({ decision }) =>
      ["v", "groupId", "groupDigest", "members", "channel", "approvedAt"].every(
        (field) => decision.authorizedBy?.[field] === authorization[field],
      ),
    );
    const contiguous =
      Number.isInteger(authorization.members) &&
      authorization.members > 1 &&
      entries.length === authorization.members &&
      entries.every(
        (entry, offset) =>
          entry.position === first.position + offset &&
          entry.decision.authorizedBy?.index === offset + 1,
      );
    if (!sameAuthorization || !contiguous) {
      findings.push({
        position: first.position,
        id: first.decision.id ?? null,
        code: "GROUP_INCOMPLETE",
        detail: `group '${groupId}' is not one contiguous, consistently authorized ${authorization.members}-member append`,
      });
      continue;
    }
    const facts = entries.map(({ decision }) => ({
      id: decision.candidateId,
      kind: decision.kind,
      subject: {
        type: decision.subject?.type,
        path: decision.subject?.path,
      },
      rationaleDigest: decision.rationaleDigest,
      targets: [...(decision.targets ?? [])],
      pathDigest: decision.boundTo?.pathDigest ?? null,
    }));
    const rebuilt = groupFactsDigest(facts);
    if (authorization.v !== 1 || rebuilt !== authorization.groupDigest) {
      findings.push({
        position: first.position,
        id: first.decision.id ?? null,
        code: "GROUP_BINDING_MISMATCH",
        detail: `group '${groupId}' claims ${authorization.groupDigest}, but its ordered member lines re-derive to ${rebuilt}`,
      });
    }
  }
  return findings;
};

/**
 * The ledger audit plus the two anchors `integrity.json` pins outside
 * `state.json`. Reading them here rather than through `readState` is
 * deliberate: `--verify` must be able to report a record that `readState`
 * would refuse to open at all.
 */
const verifyRecord = async (root) => {
  const linesOf = async (file) =>
    (
      await readFile(path.join(root, file), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
    )
      .split("\n")
      .filter((line) => line.trim());
  // Both chains are audited, each against its own genesis. They are separate
  // records with separate principals, so a finding in one says nothing about
  // the other and merging them would only hide which is broken.
  const ledger = auditDecisionLedger(await linesOf(DECISIONS_FILE));
  const autoLedger = auditDecisionLedger(await linesOf(AUTO_DECISIONS_FILE));

  const anchors = [];
  const integrity = await readFile(path.join(root, "integrity.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  for (const [name, file, anchor] of [
    ["history", "history/history.ndjson", integrity?.history],
    ["decisions", DECISIONS_FILE, integrity?.decisions],
    ["autoDecisions", AUTO_DECISIONS_FILE, integrity?.autoDecisions],
  ]) {
    if (!anchor) {
      anchors.push({ name, status: "UNANCHORED" });
      continue;
    }
    const content = await readFile(path.join(root, file)).catch((error) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    const prefix = content.subarray(0, anchor.bytes);
    const intact =
      content.length >= anchor.bytes &&
      createHash("sha256").update(prefix).digest("hex") === anchor.sha256;
    anchors.push({
      name,
      status: intact ? "INTACT" : "BROKEN",
      pinnedBytes: anchor.bytes,
      actualBytes: content.length,
      ...(intact ? {} : { detail: `${file} no longer contains the pinned prefix` }),
    });
  }

  const broken = anchors.filter((entry) => entry.status === "BROKEN");
  return {
    outcome:
      ledger.outcome === "CONSISTENT" &&
      autoLedger.outcome === "CONSISTENT" &&
      broken.length === 0
        ? "CONSISTENT"
        : "INCONSISTENT",
    ledger,
    autoLedger,
    anchors,
  };
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
    recompute: async () => {
      const locked = await derivePendingDecisions({
        registryPath,
        moduleName: options.moduleName,
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
    },
  };
  return pending.public.group?.id === options.approve
    ? approveDecisionGroup({ group: pending.public.group, ...gate })
    : approveCandidate({
        candidates: pending.public.candidates,
        approve: options.approve,
        ...gate,
      });
};

if (isMainModule(import.meta.url)) {
  runRecordDecisionCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
