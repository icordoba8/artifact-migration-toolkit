/**
 * One human act, an ordered set of operator transitions (OPERATION_SEQUENCE).
 *
 * `DECISION_CANDIDATES` already solved this shape for *decisions*: N pending
 * candidates, one confirmation phrase, N chained ledger lines. It cannot solve
 * it for *operations*, because an operation is not a line appended under one
 * lock -- it is a transition that moves the record, so member 2's confirmation
 * ID does not exist until member 1 has executed and the revision has moved.
 * That is why reconciling three reopened slices used to cost three human
 * confirmations, each requiring an operator to read a regenerated
 * `confirmationId` out of a preview and type it back.
 *
 * The regeneration is real and stays real. What changes is who handles it: the
 * authorization minted here re-derives each member's preview at the moment it
 * is executed, takes that preview's own fresh `confirmationId`, and hands it
 * straight back to `assertExecutionConfirmation`. No ID is ever displayed,
 * transcribed, or accepted from outside.
 *
 * What makes that safe is that the authorization is not a token. It is a
 * frozen, Symbol-branded, in-process object (see `brandSequenceAuthorization`):
 * it cannot be spelled in argv, in JSON-RPC tool input, in an environment
 * variable, or by `--mode auto`, and it is gone when the process is. And it is
 * not a blank cheque either -- every member re-proves, before it executes, that
 *
 *   - the record sits at exactly the lifecycle position derived for it, which
 *     for member k is "the position member k-1's successful execution should
 *     have produced" and nothing else;
 *   - the operation, its slice, its files and their byte identities are the
 *     ones the human saw;
 *   - the ownership facts under those files still read the same.
 *
 * Any other difference -- an unrelated advance, a rework, a drift acceptance
 * that reclassifies a file, an edit to one of the files -- expires the whole
 * remaining authorization rather than the one member that noticed. A human
 * approved a sequence against one record; a record that moved out from under it
 * is not that record any more.
 *
 * `maySelfConfirm` stays false for `--amend-slice`. This does not make an
 * amendment self-confirmable; it makes one deliberate human act cover an
 * ordered set of them.
 *
 * ponytail: the sequence is derived and verified, never persisted. There is no
 * on-disk authorization to reconcile, expire, or leak, and an interrupted
 * session simply re-derives and re-asks. Ceiling: a sequence cannot span
 * processes. Upgrade path: persist the facts and their signature if a
 * multi-session sequence is ever wanted -- not before.
 */

import { createInterface } from "node:readline/promises";

import {
  assertExecutionConfirmation,
  bootstrapMigration,
  brandSequenceAuthorization,
  decisionRationaleDigest,
  lifecycleBinding,
  previewMigrationExecution,
  readState,
  sequenceAuthorizationEvidence,
} from "./resumable-migration.mjs";

export const OPERATION_SEQUENCE_KIND = "OPERATION_SEQUENCE";

/** The only operation a sequence may carry today. */
export const AMEND_SLICE = "AMEND_SLICE";

/**
 * An amendment moves neither the checkpoint nor the active slice: it re-pins
 * one reopened slice's record and bumps the revision. So the position member k
 * must execute at is derivable in full from the position member k-1 executed
 * at, which is what lets one approval bind to all of them.
 */
const nextExpected = (expected) => ({
  ...expected,
  revision: expected.revision + 1,
});

/**
 * The facts one member is approved against, and the whole of them. Everything
 * here is either the operator's own input (the slice and its files) or an
 * engine-derived identity, so a member whose bytes, ownership, amendment slot
 * or expected position moved has different facts and a different sequence id.
 */
const memberFacts = (member) => ({
  index: member.index,
  operation: member.operation,
  slice: member.slice,
  files: member.files,
  add: member.add,
  amendment: member.amendment,
  preservesAs: member.preservesAs,
  sliceRecordDigestBefore: member.sliceRecordDigestBefore,
  sliceRecordDigestAfter: member.sliceRecordDigestAfter,
  implementationDigestBefore: member.implementationDigestBefore,
  implementationDigestAfter: member.implementationDigestAfter,
  expected: member.expected,
});

/** The ownership and identity facts shown to the human, per added file. */
const addedFileFact = (file) => ({
  path: file.path,
  identity: file.identity,
  ownershipBasis: file.ownershipBasis,
  claimedBy: [...(file.claimedBy ?? [])],
  driftClass: file.driftClass,
});

/**
 * Derive the sequence from the live record. Read-only: no lock, no write, no
 * clock. Every member's preview is taken now, which is legal because an
 * amendment of one reopened slice does not change what another reopened
 * slice's amendment would add -- only the lifecycle position it lands at, and
 * that position is derived rather than previewed.
 *
 * A member that derives a blocker is not offered at all. A partially valid
 * sequence is not a sequence; it is the beginning of one, and offering it would
 * ask a human to authorize an ordering the engine already knows will stop.
 */
export const deriveOperationSequence = async ({ operations, ...resolution }) => {
  // The whole registry resolution travels with the sequence, never just the
  // registry path: `projectRoot` and `cwd` decide which checkout a preview and
  // an execution resolve in, and a sequence that re-derived in a different one
  // would be proving facts about the wrong tree.
  const { moduleName } = resolution;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("An operation sequence needs at least one operation.");
  }
  const blockers = [];
  const members = [];
  let expected = null;
  let lifecycle = null;
  let targetRoot = null;
  let statePath = null;

  // One slice per sequence. Amending the same slice twice would make member 2's
  // approved facts -- its amendment slot, its prior record digest, its
  // implementation digest -- the facts member 1 rewrote, so the human would be
  // approving a "before" that cannot still be true when it is reached. That is
  // not a checkpoint expectation, it is an unpredictable one.
  //
  // ponytail: refused rather than chained. Ceiling: a sequence cannot amend one
  // slice twice; run it as two sequences. Upgrade path: derive member k's
  // expected prior record from member k-1's `sliceRecordDigestAfter` -- only
  // worth it if same-slice chaining is ever actually wanted.
  const seen = new Set();
  for (const operation of operations) {
    if (seen.has(operation?.slice)) {
      throw new Error(
        `An operation sequence names '${operation.slice}' more than once; one slice is amended by one member.`,
      );
    }
    seen.add(operation?.slice);
  }

  for (const [index, operation] of operations.entries()) {
    if (operation?.kind !== AMEND_SLICE) {
      throw new Error(
        `Operation ${index + 1} is '${operation?.kind ?? "none"}'; a sequence carries ${AMEND_SLICE} operations.`,
      );
    }
    const files = [...(operation.files ?? [])];
    const preview = await previewMigrationExecution({
      ...resolution,
      amendSlice: operation.slice,
      addFiles: files,
    });
    if (index === 0) {
      targetRoot = preview.targetRoot;
      statePath = preview.statePath;
      const { state } = await readState(preview.targetRoot, preview.target);
      lifecycle = await lifecycleBinding(state, preview.statePath);
      expected = {
        revision: preview.revision,
        status: preview.state,
        currentStep: preview.currentCheckpoint,
        activeSlice: preview.activeSlice,
        stateHash: lifecycle.stateHash,
      };
    }
    if (preview.blockers.length > 0 || !preview.sliceAmendment) {
      blockers.push(
        `${operation.slice}: ${preview.blockers.join(" ") || "derived no amendment."}`,
      );
      continue;
    }
    const amendment = preview.sliceAmendment;
    members.push({
      index: index + 1,
      operation: AMEND_SLICE,
      slice: operation.slice,
      files,
      add: amendment.add.map(addedFileFact),
      amendment: amendment.amendment,
      preservesAs: amendment.preservesAs,
      sliceRecordDigestBefore: amendment.sliceRecordDigestBefore,
      sliceRecordDigestAfter: amendment.sliceRecordDigestAfter,
      implementationDigestBefore: amendment.implementationDigestBefore,
      implementationDigestAfter: amendment.implementationDigestAfter,
      action: preview.action,
      // The position this member must find the record at, not the position it
      // was previewed against: member k executes after k-1 has moved it.
      expected: { ...expected, revision: expected.revision + index },
    });
  }

  const facts = members.map(memberFacts);
  // `lifecycle` and every member fact are inside the hashed preimage, so the
  // id *is* the binding: move the record or any member fact and the id moves,
  // and an approval naming the old one is stale by construction.
  const sequenceDigest = decisionRationaleDigest(
    JSON.stringify({
      kind: OPERATION_SEQUENCE_KIND,
      module: lifecycle?.module ?? null,
      formatVersion: lifecycle?.formatVersion ?? null,
      lifecycle,
      members: facts,
    }),
  );
  return {
    kind: OPERATION_SEQUENCE_KIND,
    id: `SEQ-${String(sequenceDigest).replace(/^sha256:/, "").slice(0, 20)}`,
    digest: sequenceDigest,
    module: lifecycle?.module ?? null,
    formatVersion: lifecycle?.formatVersion ?? null,
    resolution,
    targetRoot,
    statePath,
    lifecycle,
    members,
    facts,
    blockers,
    approvable: blockers.length === 0 && members.length > 0,
  };
};

/**
 * The phrase a human types, derived from the sequence. `y` approves anything;
 * this approves this ordered set at this record position, and the id it names
 * is content-addressed over every fact rendered below it.
 */
export const challengeForOperationSequence = (sequence) =>
  `APPROVE ${sequence.id} ${OPERATION_SEQUENCE_KIND} ${sequence.members.length} ${sequence.module}`;

export const renderOperationSequence = (sequence) =>
  `Operator operation sequence for migration '${sequence.module}'\n` +
  `Sequence: ${sequence.id}\n` +
  `Action: execute ${sequence.members.length} operation(s), in this order\n` +
  `Bound to: format ${sequence.lifecycle.formatVersion} ` +
  `revision ${sequence.lifecycle.revision} ` +
  `${sequence.lifecycle.status}/${sequence.lifecycle.currentStep}` +
  `${sequence.lifecycle.activeSlice ? `/${sequence.lifecycle.activeSlice}` : ""}\n` +
  `State hash: ${sequence.lifecycle.stateHash}\n\n` +
  sequence.members
    .map(
      (member) =>
        `  ${member.index}. ${member.operation} ${member.slice} ` +
        `(amendment ${member.amendment}, at revision ${member.expected.revision})\n` +
        member.add
          .map(
            (file) =>
              `       + ${file.path}\n` +
              `         bytes ${file.identity}\n` +
              `         basis ${file.ownershipBasis} drift ${file.driftClass} ` +
              `claimedBy ${file.claimedBy.length > 0 ? file.claimedBy.join(",") : "none"}\n`,
          )
          .join("") +
        `       slice record ${member.sliceRecordDigestBefore} -> ${member.sliceRecordDigestAfter}\n` +
        `       preserves prior record as ${member.preservesAs}\n`,
    )
    .join("") +
  `\nThis one approval binds to that exact sequence, in that exact order, from\n` +
  `that exact record state. Each operation is re-derived and re-proven when it\n` +
  `runs; any change this sequence did not itself cause expires the rest of it.\n` +
  `Type the challenge phrase to approve the whole sequence, anything else to abort.\n`;

/**
 * The trusted approval boundary, reached exactly as `record-decision.mjs`
 * reaches it: `ask` is an in-process function a front end may pass only when it
 * has itself obtained a human answer through a channel the model does not
 * control, and it returns an *answer*, never a verdict. Omitting it asks for
 * the TTY probe instead.
 *
 * The comparison below is the whole gate. A front end that returns something it
 * composed rather than something a human supplied has approved nothing on its
 * own authority -- it has only moved the forgery one file over.
 */
export const authorizeOperationSequence = async (
  sequence,
  { ask, stdin = process.stdin, stdout = process.stdout } = {},
) => {
  if (!sequence.approvable) {
    throw new Error(
      `Operation sequence ${sequence.id} is not approvable: ${sequence.blockers.join(" ")} Nothing was executed.`,
    );
  }
  const challenge = challengeForOperationSequence(sequence);
  const summary = renderOperationSequence(sequence);
  let answer = "";
  if (ask) {
    answer = String((await ask({ challenge, summary })) ?? "");
  } else if (stdin.isTTY && stdout.isTTY) {
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      stdout.write(summary);
      answer = await readline.question(`Type: ${challenge}\n> `);
    } finally {
      readline.close();
    }
  } else {
    stdout.write(summary);
    stdout.write(
      "No trusted human channel is available in this process. Nothing was executed.\n",
    );
    return null;
  }
  if (answer.trim() !== challenge) {
    stdout.write(
      ask
        ? "No matching inline confirmation phrase was received. Nothing was executed.\n"
        : "Challenge phrase did not match. Nothing was executed.\n",
    );
    return null;
  }
  return brandSequenceAuthorization({
    v: 1,
    sequenceId: sequence.id,
    sequenceDigest: sequence.digest,
    operations: sequence.members.length,
    channel: ask ? "ELICITATION" : "TERMINAL",
    approvedAt: new Date().toISOString(),
  });
};

/**
 * The ordered, at-most-once-each spender of one authorization.
 *
 * It holds the approved facts and the position each member must find, and it is
 * the only thing that ever sees a `confirmationId`. `expire` is deliberately
 * whole-sequence: a member that finds the record somewhere it was not derived
 * for does not get to be skipped.
 */
export const operationSequenceRunner = (sequence, authorization) => {
  if (!authorization) {
    throw new Error(
      `Operation sequence ${sequence.id} was not authorized. Nothing was executed.`,
    );
  }
  // Unwrapped once, here, so an unbranded value is refused before any member
  // runs rather than by the first execution. The approved facts are the same
  // for every member; only `index` differs, exactly as a grouped decision's
  // `authorizedBy` differs only by its position in the group.
  const approved = sequenceAuthorizationEvidence(authorization);
  const remaining = [...sequence.members];
  const executed = [];
  let expired = null;
  let position = { ...sequence.members[0].expected };

  const expire = (reason) => {
    expired = reason;
    remaining.length = 0;
    return new Error(
      `Operation sequence ${sequence.id} expired before member ${executed.length + 1}: ${reason} ` +
        `${executed.length} operation(s) executed; the remaining authorization is void and nothing further was executed.`,
    );
  };

  return {
    get expired() {
      return expired;
    },
    get executed() {
      return [...executed];
    },
    get remaining() {
      return [...remaining];
    },
    /**
     * Execute the approved next member, and only it. Re-derives the preview,
     * re-proves every approved fact against it, supplies that preview's own
     * regenerated confirmation ID internally, and records the authorization on
     * the event the execution writes.
     */
    async next() {
      if (expired) {
        throw new Error(
          `Operation sequence ${sequence.id} is expired: ${expired} Nothing was executed.`,
        );
      }
      const member = remaining.shift();
      if (!member) return null;

      const preview = await previewMigrationExecution({
        ...sequence.resolution,
        amendSlice: member.slice,
        addFiles: member.files,
      });
      if (preview.blockers.length > 0 || !preview.sliceAmendment) {
        throw expire(
          `re-deriving ${member.slice} now reports ${preview.blockers.join(" ") || "no amendment"}.`,
        );
      }
      const { state } = await readState(preview.targetRoot, preview.target);
      const now = await lifecycleBinding(state, preview.statePath);

      // The expected checkpoint, in full. Member 1 must find the record exactly
      // where the human saw it; member k must find it exactly where k-1's
      // execution left it, and `position.stateHash` is that state's own hash,
      // captured below rather than predicted.
      const drift = [
        ["module", now.module, sequence.lifecycle.module],
        ["formatVersion", now.formatVersion, sequence.lifecycle.formatVersion],
        ["revision", now.revision, position.revision],
        ["status", now.status, position.status],
        ["currentStep", now.currentStep, position.currentStep],
        ["activeSlice", now.activeSlice, position.activeSlice],
        ["stateHash", now.stateHash, position.stateHash],
      ].filter(([, actual, wanted]) => actual !== wanted);
      if (drift.length > 0) {
        throw expire(
          `the record is not at the derived expected checkpoint (${drift
            .map(([field, actual, wanted]) => `${field} ${wanted} -> ${actual}`)
            .join(", ")}).`,
        );
      }

      // The operation itself: same slice, same files, same bytes, same
      // ownership, same amendment slot, same prior record.
      const derived = {
        ...member,
        add: preview.sliceAmendment.add.map(addedFileFact),
        amendment: preview.sliceAmendment.amendment,
        preservesAs: preview.sliceAmendment.preservesAs,
        sliceRecordDigestBefore:
          preview.sliceAmendment.sliceRecordDigestBefore,
        sliceRecordDigestAfter: preview.sliceAmendment.sliceRecordDigestAfter,
        implementationDigestBefore:
          preview.sliceAmendment.implementationDigestBefore,
        implementationDigestAfter:
          preview.sliceAmendment.implementationDigestAfter,
      };
      if (
        JSON.stringify(memberFacts(derived)) !==
        JSON.stringify(memberFacts(member))
      ) {
        throw expire(
          `${member.slice} no longer matches the approved operation (files, byte identities, ownership, amendment slot or preserved record moved).`,
        );
      }

      // The regenerated ID, handled here and never displayed. It comes from the
      // preview just re-derived and re-proven, so it can only confirm the
      // operation the human approved, at the position it was approved for.
      assertExecutionConfirmation(preview, preview.confirmationId);
      const result = await bootstrapMigration({
        ...sequence.resolution,
        registryBinding: preview.registryBinding,
        boundInputs: preview.boundInputs,
        amendSlice: member.slice,
        addFiles: member.files,
        // Re-branded per member so the event records which operation of the
        // approved set this was. Nothing else about the act differs.
        authorization: brandSequenceAuthorization({
          ...approved,
          index: member.index,
        }),
      });

      const after = await lifecycleBinding(result.state, result.statePath);
      position = nextExpected({ ...position, stateHash: after.stateHash });
      // Not predicted: read back. A member whose execution left the record
      // somewhere other than the next derived revision expires the rest.
      if (after.revision !== position.revision) {
        throw expire(
          `${member.slice} executed to revision ${after.revision}, not the derived ${position.revision}.`,
        );
      }
      executed.push({ member, revision: after.revision, result });
      return { member, result, lifecycle: after };
    },
  };
};
