import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import {
  challengeFor,
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
    // Transport failure and a candidate that moved under an open request: both
    // are FAILED and both write nothing.
    for (answer of ["disconnect", "stale"]) {
      const failed = await call();
      assert.equal(failed.outcome, "FAILED", answer);
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
