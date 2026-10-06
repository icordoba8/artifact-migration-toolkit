import assert from "node:assert/strict";
import { withDecisionPolicy, protectedPolicyDocument } from "../support/decision-policy-fixture.mjs";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import {
  buildDecision,
  challengeFor,
  projectDecisions,
  runRecordDecisionCli,
} from "../../src/record-decision.mjs";
import {
  createSession,
  handleMessage,
} from "../../src/mcp-server.mjs";
import {
  decisionLineDigest,
  pendingDecisionCandidates,
  validateResumableMigration,
} from "../../src/core.mjs";
import {
  createFixture,
  atDirectLedgerCompleteness,
  atDiscoveryCompleteness,
  EXCLUDED_CLASSIFICATION,
  state,
  decisionLedger,
  snapshot,
  resolutionFor,
} from "./approval.fixture.mjs";

/**
 * Every shape the wire can carry, and exactly one of them is consent.
 *
 * `auto-approve-enum` reproduces the unsafe grouped-answer shape: the answer a host
 * can compose from an `enum: ["Approve","Decline"]` schema without rendering a
 * dialog or reaching a person. It recorded thirteen ledger lines on one tool
 * call. Every entry below except `approve` must leave the ledger byte-identical.
 */
const HOST_RESPONSES = {
  approve: (challenge) => ({ action: "accept", content: { confirmation: challenge } }),
  "auto-approve-enum": () => ({ action: "accept", content: { decision: "Approve" } }),
  decline: () => ({ action: "decline" }),
  cancel: () => ({ action: "cancel" }),
  dismiss: () => ({ action: "dismiss" }),
  "unknown-action": () => ({ action: "approved" }),
  "wrong-case-action": (challenge) => ({
    action: "ACCEPT",
    content: { confirmation: challenge },
  }),
  "empty-content": () => ({ action: "accept", content: {} }),
  "no-content": () => ({ action: "accept" }),
  "empty-confirmation": () => ({ action: "accept", content: { confirmation: "" } }),
  "blank-confirmation": () => ({
    action: "accept",
    content: { confirmation: "   \t \n " },
  }),
  "wrong-phrase": () => ({ action: "accept", content: { confirmation: "APPROVE" } }),
  "other-candidate-phrase": () => ({
    action: "accept",
    content: { confirmation: "APPROVE APP-wrong EXCLUSION auth/marker.txt" },
  }),
  "non-string-confirmation": () => ({
    action: "accept",
    content: { confirmation: true },
  }),
  "extra-fields": (challenge) => ({
    action: "accept",
    content: { confirmation: challenge, candidateId: "APP-wrong" },
  }),
  "null-response": () => null,
  "undefined-response": () => undefined,
  "no-action-field": (challenge) => ({ content: { confirmation: challenge } }),
  "array-response": () => [],
  "string-response": () => "Approve",
  "number-response": () => 1,
};

/** Everything that is not an explicit, correctly transcribed human Approve. */
const REFUSED_RESPONSES = Object.keys(HOST_RESPONSES).filter(
  (name) => name !== "approve",
);

// Real engine, Git worktree, recorder and ledger; only the human host is simulated.
// Host keyboard/focus behavior is external and requires a manual host smoke test.
test("inline worktree approval preserves context, rejects invalid answers, and returns usable references", async () => {
  const main = await createFixture();
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const worktreeRoot = path.join(main.root, "isolated");
  const git = (...args) =>
    promisify(execFile)("git", ["-C", main.root, ...args]);
  try {
    await git("worktree", "add", "--detach", worktreeRoot, "HEAD");
    const worktree = Object.fromEntries(
      Object.entries(main).map(([key, value]) => [
        key,
        typeof value === "string"
          ? value.replace(main.root, worktreeRoot)
          : value,
      ]),
    );
    await atDiscoveryCompleteness(main, EXCLUDED_CLASSIFICATION);
    await atDiscoveryCompleteness(worktree, EXCLUDED_CLASSIFICATION);
    process.chdir(main.root);
    const before = await snapshot(main.targetRoot);
    const initialState = await state(worktree);
    const classificationFile = path.join(
      worktree.migrationRoot,
      "inventories/module-classification.json",
    );
    const originalClassification = await readFile(classificationFile, "utf8");
    const {
      candidates: [displayed],
    } = await pendingDecisionCandidates({
      ...(await resolutionFor(worktree)),
      moduleName: "auth",
    });
    const challenge = challengeFor(displayed);
    let answer = "decline";
    let prompts = 0;
    const session = createSession({
      request: async (method, params) => {
        prompts++;
        assert.equal(method, "elicitation/create");
        assert.equal(process.cwd(), worktreeRoot);
        assert.ok(params.message.includes(worktreeRoot));
        assert.ok(params.message.includes(displayed.id));
        assert.ok(params.message.includes(displayed.subject.path));
        assert.ok(params.message.includes(displayed.boundTo.discoveryDigest));
        // The human is asked to transcribe a phrase, never to pick from a set a
        // host could satisfy from the schema alone.
        assert.ok(params.message.includes(`Confirmation phrase: ${challenge}`));
        assert.deepEqual(params.requestedSchema.properties, {
          confirmation: {
            type: "string",
            title: "Confirmation phrase",
            description:
              "Type the confirmation phrase exactly as shown to approve the selected candidate or group. An empty field, any other text, or dismissing this request writes nothing.",
            minLength: 1,
          },
        });
        assert.deepEqual(params.requestedSchema.required, ["confirmation"]);
        if (answer === "disconnect") throw new Error("Host disconnected");
        if (answer === "stale") {
          const changed = JSON.parse(originalClassification);
          changed.files[0].rationale = "Changed while approval was open";
          await writeFile(classificationFile, JSON.stringify(changed));
          return { action: "accept", content: { confirmation: challenge } };
        }
        return HOST_RESPONSES[answer](challenge);
      },
    });
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: { elicitation: {} } },
      },
      session,
    );
    const call = async (name = "migration_run", extra = {}) => {
      const response = await handleMessage(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name,
            arguments: { module: "auth", cwd: worktreeRoot, ...extra },
          },
        },
        session,
      );
      assert.equal(process.cwd(), main.root);
      assert.ok(!response.error, JSON.stringify(response));
      return response.result.structuredContent;
    };
    assert.equal(
      (await call("migration_status")).currentStep,
      "DISCOVERY_COMPLETENESS",
    );
    for (answer of REFUSED_RESPONSES) {
      const result = await call();
      assert.equal(result.outcome, "OPERATOR_DECISION", answer);
      assert.deepEqual(result.decisionReferences, [], answer);
      assert.equal(await decisionLedger(worktree), null, answer);
      // The trusted terminal path stays open for every one of them: none of
      // these is a human rejection, so none of them may strand the migration.
      assert.equal(result.operatorApproval.cwd, worktreeRoot, answer);
      assert.equal(result.operatorApproval.candidates.length, 1, answer);
    }
    // A transport failure is no answer and stays recoverable; a candidate that
    // moved under an open request FAILS. Both write nothing.
    for (answer of ["disconnect", "stale"]) {
      const failed = await call();
      assert.equal(failed.outcome, answer === "disconnect" ? "OPERATOR_DECISION" : "FAILED", answer);
      assert.deepEqual(failed.decisionReferences, [], answer);
      assert.equal(await decisionLedger(worktree), null, answer);
    }
    await writeFile(classificationFile, originalClassification);
    answer = "approve";
    const approved = await call();
    assert.equal(approved.outcome, "CONTINUE", approved.reason);
    const [reference] = approved.decisionReferences;
    const ledger = await decisionLedger(worktree);
    const decision = JSON.parse(ledger.trim());
    assert.equal(reference.decisionId, decision.id);
    assert.equal(reference.decisionDigest, decisionLineDigest(decision));
    assert.equal(reference.candidateId, decision.candidateId);
    assert.equal(decision.candidateId, displayed.id);
    assert.deepEqual(decision.subject, displayed.subject);
    assert.deepEqual(decision.boundTo, displayed.boundTo);
    assert.deepEqual(await state(worktree), initialState);
    assert.deepEqual(await snapshot(main.targetRoot), before);
    assert.equal(await decisionLedger(main), null);
    // The agent cites the returned receipt; no operator identifier transfer.
    const classification = JSON.parse(
      await readFile(classificationFile, "utf8"),
    );
    Object.assign(classification.files[0], {
      decisionId: reference.decisionId,
      decisionDigest: reference.decisionDigest,
    });
    await writeFile(classificationFile, JSON.stringify(classification));
    const context = { ...(await resolutionFor(worktree)), moduleName: "auth" };
    await validateResumableMigration(context);
    classification.files[0].decisionDigest = "sha256:" + "0".repeat(64);
    await writeFile(classificationFile, JSON.stringify(classification));
    await assert.rejects(validateResumableMigration(context), /digest/i);
    classification.files[0].decisionDigest = reference.decisionDigest;
    await writeFile(classificationFile, JSON.stringify(classification));
    const resumed = await call();
    assert.equal(resumed.outcome, "CONTINUE", resumed.reason);
    assert.notEqual(
      (await state(worktree)).currentStep,
      "DISCOVERY_COMPLETENESS",
    );
    // One request per iteration and no more: every refused answer, the two
    // failures, and the single approval. The resumed run asks nothing.
    assert.equal(prompts, REFUSED_RESPONSES.length + 3);
    assert.equal(await decisionLedger(worktree), ledger);
    assert.deepEqual(await snapshot(main.targetRoot), before);
    const invalid = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "migration_run",
          arguments: { module: "auth", cwd: "relative" },
        },
      },
      session,
    );
    assert.equal(invalid.error.code, -32600);
    assert.equal(process.cwd(), main.root);
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    await main.cleanup();
  }
});

// The real readline branch owns fallback protection; no trusted ask callback.
test("terminal fallback rejects Approve and requires the exact candidate challenge", async () => {
  const fixture = await createFixture();
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    process.chdir(fixture.root);
    const {
      candidates: [candidate],
    } = await pendingDecisionCandidates({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    for (const answer of [
      "Approve",
      "APPROVE wrong",
      challengeFor(candidate),
    ]) {
      const stdin = new PassThrough();
      stdin.isTTY = true;
      stdin.end(`${answer}\n`);
      let output = "";
      const stdout = new Writable({
        write(chunk, encoding, done) {
          output += String(chunk);
          done();
        },
      });
      stdout.isTTY = true;
      const result = await runRecordDecisionCli(
        ["auth", "--approve", candidate.id],
        { stdin, stdout },
      );
      assert.ok(output.includes(`Challenge: ${challengeFor(candidate)}`));
      if (answer === challengeFor(candidate)) {
        assert.equal(result.decision.candidateId, candidate.id);
        assert.ok(await decisionLedger(fixture));
      } else {
        assert.equal(result.blocked, true);
        assert.equal(await decisionLedger(fixture), null);
      }
    }
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    await fixture.cleanup();
  }
});

/* -- Phase 3: one fresh module decision projection -------------------------- */

/**
 * Status, pending decisions and run over a real format-19 record, and the one
 * question this test exists to answer: do the three ever disagree?
 *
 * They used to, structurally. Pending ran its own lenient "is this decided"
 * test, the gate ran a strict one, and status ran none at all -- so the only way
 * to find out where a record really stood was to read the ledger by hand, and
 * a decision recorded mid-session was invisible until something restarted.
 *
 * Here all three are driven through the MCP adapter, which is the most
 * suspicious caller available: it is a separate process boundary with its own
 * response shape, and it is the one that must not be able to form an opinion of
 * its own from a log, a receipt or a host reply.
 *
 * This case opts up through a protected HUMAN_ATTESTED policy. A local relayed
 * decision cannot satisfy that requirement. An appended line is seen
 * immediately and identically by all three, with its principal and result
 * reported and refused. The state table itself -- applicable, rejected, stale,
 * group-through-group -- is proved against a trusted admin policy in
 * `migration-contract.test.mjs` (ODA-5).
 */
test("protected high assurance: status, pending and run refuse relayed authority identically", async () => {
  const fixture = await createFixture();
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  return withDecisionPolicy(protectedPolicyDocument(fixture.targetRoot, { EXCLUSION: "HUMAN_ATTESTED" }), async () => {
  try {
    await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    assert.equal((await state(fixture)).formatVersion, 19);
    process.chdir(fixture.root);
    const resolution = { ...(await resolutionFor(fixture)), moduleName: "auth" };

    const session = createSession({ request: () => ({ action: "decline" }) });
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: { elicitation: {} } },
      },
      session,
    );
    const call = async (name) => {
      const response = await handleMessage(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: { module: "auth", cwd: fixture.root } },
        },
        session,
      );
      assert.ok(!response.error, JSON.stringify(response));
      return response.result.structuredContent;
    };

    /** The projection as each of the four consumers reports it, in one go. */
    const views = async () => {
      const status = await call("migration_status");
      const pending = await call("migration_pending_decisions");
      const run = await call("migration_run");
      const direct = await projectDecisions(resolution);
      return { status, pending, run, direct };
    };

    const first = await views();
    assert.deepEqual(first.status.decisions, first.direct);
    assert.deepEqual(first.pending.decisions, first.direct);
    assert.deepEqual(first.run.decisions, first.direct);
    assert.deepEqual(first.run.state.decisions, first.direct);
    assert.equal(first.direct.directLedger, true);
    assert.equal(first.direct.state, "AWAITING_HUMAN_DECISION");
    assert.equal(first.direct.checkpointAdvanced, false);
    assert.equal(first.direct.candidates.length, 1);
    const [awaiting] = first.direct.candidates;
    assert.equal(awaiting.state, "AWAITING_HUMAN_DECISION");
    assert.equal(awaiting.requiredPrincipal, "HUMAN_ATTESTED");
    assert.equal(awaiting.decisionId, null);
    assert.equal(awaiting.group, null);
    assert.equal(first.pending.candidates.length, 1);
    assert.equal(first.pending.candidates[0].id, awaiting.id);

    // No receipt crosses any wire on this path, and the agent is never told to
    // transcribe one into the classification.
    assert.deepEqual(first.pending.references, []);
    assert.deepEqual(first.run.decisionReferences, []);
    assert.equal(first.run.outcome, "BLOCKED");
    assert.equal(first.run.blocked.state, "SIGNER_UNAVAILABLE");
    assert.equal(first.direct.blocked.state, "SIGNER_UNAVAILABLE");
    assert.equal(first.run.operatorApproval.review.candidateDigest, awaiting.candidateDigest);
    assert.match(first.run.reason, /SIGNER_UNAVAILABLE/);
    assert.ok(!/decisionDigest/.test(first.run.reason), first.run.reason);
    assert.equal(await decisionLedger(fixture), null);

    // Read-only is bytes, not intent: status and pending leave the record, the
    // ledger and the checkpoint exactly as they were.
    const before = await snapshot(fixture.targetRoot);
    await call("migration_status");
    await call("migration_pending_decisions");
    await pendingDecisionCandidates(resolution);
    await projectDecisions(resolution);
    assert.deepEqual(await snapshot(fixture.targetRoot), before);

    // One real ledger append, in this process, with nothing restarted. The line
    // is `AGENT_RELAYED` -- the strongest principal this build can write -- over
    // the exact current candidate.
    const stateBefore = await state(fixture);
    const line = buildDecision({
      previous: null,
      kind: awaiting.kind,
      subjectType: awaiting.subject.type,
      subject: awaiting.subject.path,
      statement: `Relayed decision for ${awaiting.id}.`,
      rationale: first.pending.candidates[0].rationale,
      candidateId: awaiting.id,
      targets: first.pending.candidates[0].targets,
      boundTo: first.pending.candidates[0].boundTo,
      principal: "AGENT_RELAYED",
      result: "APPROVED",
      candidateDigest: awaiting.candidateDigest,
      policyId: awaiting.policyId,
      policyDigest: awaiting.policyDigest,
    });
    await mkdir(path.join(fixture.migrationRoot, "decisions"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.migrationRoot, "decisions/operator-decisions.ndjson"),
      `${JSON.stringify(line)}\n`,
    );

    const second = await views();
    assert.deepEqual(second.status.decisions, second.direct);
    assert.deepEqual(second.pending.decisions, second.direct);
    assert.deepEqual(second.run.decisions, second.direct);
    const [seen] = second.direct.candidates;
    // Seen immediately: same session, same process, no restart, no cache to
    // invalidate. And refused: a weaker principal never satisfies the
    // requirement and never falls back to one, so the gate stays shut and the
    // candidate stays pending.
    assert.equal(seen.decisionId, line.id);
    assert.equal(seen.principal, "AGENT_RELAYED");
    assert.equal(seen.result, "APPROVED");
    assert.equal(seen.state, "AWAITING_HUMAN_DECISION");
    assert.match(seen.reason, /weaker principal|requires 'HUMAN_ATTESTED'/);
    assert.equal(second.direct.checkpointAdvanced, false);
    assert.equal((await state(fixture)).revision, stateBefore.revision);
    assert.equal((await state(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    // A record whose classification cannot express its own format's authority is
    // a typed compatibility action, not a crashed status read.
    await writeFile(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      JSON.stringify({ ...EXCLUDED_CLASSIFICATION, version: 1 }),
    );
    const legacyView = await projectDecisions(resolution);
    assert.equal(legacyView.state, "LEGACY_COMPATIBILITY_ACTION_REQUIRED");
    assert.match(legacyView.reason, /historical citation rules/);
    assert.deepEqual(
      (await call("migration_status")).decisions,
      legacyView,
    );
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    await fixture.cleanup();
  }
  });
});

/**
 * The same three consumers over a format-18 record. Nothing about the legacy
 * path changes: the receipt is still the authority, the reference still comes
 * back, and the agent is still told to cite it.
 */
test("a format-18 record keeps its historical citation behavior under the shared projection", async () => {
  const fixture = await createFixture();
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    assert.equal((await state(fixture)).formatVersion, 18);
    process.chdir(fixture.root);
    const resolution = { ...(await resolutionFor(fixture)), moduleName: "auth" };

    const pending = await pendingDecisionCandidates(resolution);
    assert.equal(pending.decisions.directLedger, false);
    assert.equal(pending.decisions.state, "AWAITING_HUMAN_DECISION");
    assert.equal(pending.decisions.checkpointAdvanced, false);
    const [candidate] = pending.candidates;
    // A legacy candidate is unbound by design: no policy pin enters its digest.
    assert.equal(candidate.policyId, undefined);
    assert.equal(candidate.requiredPrincipal, undefined);

    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.end(`${challengeFor(candidate)}\n`);
    const stdout = new Writable({ write: (chunk, encoding, done) => done() });
    stdout.isTTY = true;
    const recorded = await runRecordDecisionCli(
      ["auth", "--approve", candidate.id],
      { stdin, stdout },
    );
    assert.equal(recorded.decision.candidateId, candidate.id);

    // Historical behavior, unchanged: the approval leaves pending, comes back as
    // a citable reference, and the projection reports it as the legacy path
    // always resolved it.
    const after = await pendingDecisionCandidates(resolution);
    assert.deepEqual(after.candidates, []);
    assert.equal(after.references.length, 1);
    assert.equal(after.references[0].decisionId, recorded.decision.id);
    assert.equal(
      after.references[0].decisionDigest,
      decisionLineDigest(recorded.decision),
    );
    assert.equal(after.decisions.directLedger, false);
    assert.equal(after.decisions.state, "READY_TO_ADVANCE");
    assert.equal(after.decisions.candidates[0].state, "APPROVED_APPLICABLE");
    assert.equal(after.decisions.checkpointAdvanced, false);
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    await fixture.cleanup();
  }
});
