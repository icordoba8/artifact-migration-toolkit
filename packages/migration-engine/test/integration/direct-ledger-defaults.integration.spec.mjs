import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createSession, handleMessage } from "../../src/mcp-server.mjs";
import { runRecordDecisionCli } from "../../src/record-decision.mjs";
import { advanceMigration, previewAdvance } from "../../src/core.mjs";
import { candidateDigestOf, DEFAULT_DECISION_POLICY_ID, DEFAULT_DECISION_POLICY_DIGEST,
  resolveHistoricalRequiredPrincipal, resolveRequiredPrincipal, recoverMigrationRecord } from "../../src/resumable-migration.mjs";
import { withDecisionPolicy, protectedPolicyDocument } from "../support/decision-policy-fixture.mjs";
import { createFixture, atDirectLedgerCompleteness, EXCLUDED_CLASSIFICATION, decisionLedger,
  state, addLegacyFiles, extraFileNames, manyExcluded, behaviorBacked, resolutionFor } from "./approval.fixture.mjs";

const record = async (fixture, args, channel = { stdout: { write() {} } }) => {
  const cwd = process.cwd();
  process.chdir(fixture.root);
  try { return await runRecordDecisionCli(["auth", ...args], channel); }
  finally { process.chdir(cwd); }
};
const editEvidence = async (fixture) => {
  const file = path.join(fixture.migrationRoot, "inventories/module-classification.json");
  const document = JSON.parse(await readFile(file, "utf8"));
  document.files[0].rationale += " Revised evidence.";
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
};

for (const provider of ["claude", "codex", "copilot", "opencode"]) {
  test(`${provider}: no infrastructure, default 19, explicit relay, stale, rejection and consumed identity`, async (t) => {
    const noNetwork = () => { throw new Error("Standard decisions must not use the network"); };
    t.mock.method(globalThis, "fetch", noNetwork);
    t.mock.method(http, "request", noNetwork);
    t.mock.method(https, "request", noNetwork);
    t.mock.method(https, "createServer", noNetwork);
    const fixture = await createFixture();
    const exitCode = process.exitCode;
    try {
      await withDecisionPolicy(null, async () => {
        await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
        assert.equal((await state(fixture)).formatVersion, 19);
        let response;
        let reviews = 0;
        const session = createSession({ request: async (method, params) => {
          reviews += 1;
          assert.equal(method, "elicitation/create");
          assert.deepEqual(params.requestedSchema.properties.decision.enum, ["APPROVE", "REJECT"]);
          assert.equal(params.requestedSchema.properties.decision.default, undefined);
          assert.match(params.message, /Required principal: AGENT_RELAYED/);
          assert.doesNotMatch(params.message, /Confirmation phrase:|Challenge:/);
          if (response instanceof Error) throw response;
          return response;
        } });
        await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { clientInfo: { name: provider }, capabilities: { elicitation: {} } } }, session);
        const message = (name, extra = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name, arguments: { module: "auth", cwd: fixture.root, ...extra } } });
        const call = async (name, extra) => {
          const reply = await handleMessage(message(name, extra), session);
          assert.equal(reply.error, undefined, JSON.stringify(reply));
          return reply.result.structuredContent;
        };
        const pending = await call("migration_pending_decisions");
        const [candidate] = pending.candidates;
        assert.equal(candidate.requiredPrincipal, "AGENT_RELAYED");
        assert.equal(candidate.policyId, DEFAULT_DECISION_POLICY_ID);
        assert.equal(candidate.policyDigest, DEFAULT_DECISION_POLICY_DIGEST);
        assert.equal(candidate.blocked, null);
        assert.deepEqual(pending.references, []);
        const before = await state(fixture);
        for (response of [undefined, {}, { action: "accept" }, { action: "accept", content: {} },
          { action: "cancel", content: { decision: "APPROVE" } },
          { action: "decline", content: { decision: "REJECT" } },
          { action: "dismiss" }, { action: "accept", content: { decision: "Approve" } },
          { action: "accept", content: { decision: "APPROVE", inferred: true } },
          new Error("transport failure")]) {
          await call("migration_run");
          assert.equal(await decisionLedger(fixture), null);
          assert.deepEqual(await state(fixture), before);
        }
        if (provider === "claude") {
          let late;
          response = new Promise((resolve) => { late = resolve; });
          assert.equal((await call("migration_run")).outcome, "FAILED");
          late({ action: "accept", content: { decision: "APPROVE" } });
          assert.equal(await decisionLedger(fixture), null);
          assert.deepEqual(await state(fixture), before);
        }
        const injected = await handleMessage(message("migration_run", {
          decision: "APPROVE", principal: "HUMAN_ATTESTED" }), session);
        assert.ok(injected.error);
        const noRelay = await handleMessage(message("migration_run", { mode: "auto" }), createSession());
        assert.equal(noRelay.result.structuredContent.outcome, "OPERATOR_DECISION");
        assert.equal(await decisionLedger(fixture), null);

        response = { action: "accept", content: { decision: "APPROVE" } };
        const approved = await call("migration_run");
        assert.equal(approved.outcome, "CONTINUE", approved.reason);
        assert.equal(approved.decisions.candidates[0].state, "APPROVED_APPLICABLE");
        assert.deepEqual(approved.decisionReferences, []);
        assert.deepEqual(await state(fixture), before);
        let lines = (await decisionLedger(fixture)).trim().split("\n").map(JSON.parse);
        assert.equal(lines[0].principal, "AGENT_RELAYED");
        assert.equal(lines[0].result, "APPROVED");
        assert.equal(lines[0].candidateDigest, candidateDigestOf(candidate));
        assert.equal(lines[0].webauthn, undefined);
        assert.equal((await call("migration_status")).decisions.candidates[0].state, "APPROVED_APPLICABLE");

        await editEvidence(fixture);
        assert.equal((await call("migration_pending_decisions")).decisions.state, "STALE");
        response = { action: "accept", content: { decision: "REJECT" } };
        const rejected = await call("migration_run");
        assert.equal(rejected.outcome, "BLOCKED");
        assert.equal(rejected.decisions.state, "REJECTED");
        assert.equal((await call("migration_run")).outcome, "BLOCKED");
        assert.deepEqual(await state(fixture), before);
        await editEvidence(fixture);
        assert.equal((await call("migration_pending_decisions")).decisions.state, "STALE");
        response = { action: "accept", content: { decision: "APPROVE" } };
        assert.equal((await call("migration_run")).decisions.candidates[0].state, "APPROVED_APPLICABLE");
        lines = (await decisionLedger(fixture)).trim().split("\n").map(JSON.parse);
        assert.deepEqual(lines.map((line) => line.result), ["APPROVED", "REJECTED", "APPROVED"]);
        const reviewCount = reviews;
        assert.equal((await call("migration_run")).outcome, "CONTINUE");
        assert.equal(reviews, reviewCount);
        assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
        const history = (await readFile(path.join(fixture.migrationRoot, "history/history.ndjson"), "utf8"))
          .trim().split("\n").map(JSON.parse);
        const consumed = history.flatMap((event) => event.consumedDecisions ?? []);
        assert.equal(consumed.length, 1);
        assert.equal(consumed[0].decisionId, lines[2].id);
        assert.equal(consumed[0].candidateDigest, lines[2].candidateDigest);
        assert.equal(consumed[0].principal, "AGENT_RELAYED");
        assert.equal(consumed[0].policyDigest, DEFAULT_DECISION_POLICY_DIGEST);
      });
    } finally { process.exitCode = exitCode; await fixture.cleanup(); }
  });
}

for (const answer of ["APPROVE", "REJECT"]) {
  test(`standard terminal ${answer}: one complete group, one ledger line, no IDs or challenge`, async () => {
    const fixture = await createFixture();
    const exitCode = process.exitCode;
    try {
      await withDecisionPolicy(null, async () => {
        const names = extraFileNames(3);
        await addLegacyFiles(fixture, names);
        await atDirectLedgerCompleteness(fixture, manyExcluded(names), behaviorBacked(names));
        const input = new PassThrough();
        input.isTTY = true;
        let text = "";
        const output = new Writable({ write(chunk, _encoding, done) {
          text += chunk;
          if (String(chunk).includes("Choose APPROVE or REJECT")) queueMicrotask(() => input.write(`${answer}\n`));
          done();
        } });
        output.isTTY = true;
        const pending = await record(fixture, ["--pending"]);
        const result = await record(fixture, ["--approve", pending.group.id], { stdin: input, stdout: output });
        assert.equal(result.decisions.length, 1);
        const [line] = result.decisions;
        assert.equal(line.kind, "GROUP_APPROVAL");
        assert.equal(line.principal, "AGENT_RELAYED");
        assert.equal(line.result, answer === "APPROVE" ? "APPROVED" : "REJECTED");
        assert.equal(line.boundTo.members.length, 4);
        assert.equal((await decisionLedger(fixture)).trim().split("\n").length, 1);
        const fresh = await record(fixture, ["--pending"]);
        assert.ok(fresh.decisions.candidates.every((row) => row.state ===
          (answer === "APPROVE" ? "APPROVED_APPLICABLE" : "REJECTED")));
        assert.doesNotMatch(text, /Challenge:|Confirmation phrase:/);
        if (answer === "APPROVE") {
          const target = { ...(await resolutionFor(fixture)), moduleName: "auth" };
          const preview = await previewAdvance(target);
          await assert.rejects(advanceMigration({ ...target, confirmAdvance: preview.confirmationId,
            hooks: { afterWrite: (stage) => { if (stage === "state") throw new Error("crash after state"); } },
          }), /crash after state/);
          await recoverMigrationRecord(target);
          const historyFile = path.join(fixture.migrationRoot, "history/history.ndjson");
          const bytes = await readFile(historyFile, "utf8");
          const consumed = bytes.trim().split("\n").map(JSON.parse).flatMap((event) => event.consumedDecisions ?? []);
          assert.equal(consumed.length, 1);
          assert.equal(consumed[0].decisionId, line.id);
          assert.equal(consumed[0].candidateDigest, line.candidateDigest);
          await recoverMigrationRecord(target);
          assert.equal(await readFile(historyFile, "utf8"), bytes);
          assert.equal((await state(fixture)).formatVersion, 19);
        } else {
          await writeFile(path.join(fixture.legacyRoot, "auth/marker.txt"), "changed legacy evidence\n");
          const stale = await record(fixture, ["--pending"]);
          assert.equal(stale.decisions.state, "STALE");
          assert.ok(stale.decisions.candidates.every((row) => row.state === "STALE"));
          assert.equal(stale.group.groupMembers.length, 4);
        }
        input.end();
      });
    } finally { process.exitCode = exitCode; await fixture.cleanup(); }
  });
}

test("canonical policy: deterministic standard, protected opt-up, historical pins and policy staleness", async () => {
  const fixture = await createFixture();
  try {
    await withDecisionPolicy(null, async () => {
      for (const kind of ["EXCLUSION", "DEAD_CONFIRMATION", "EDGE_RESOLUTION", "ROOT_DECLARATION",
        "TARGET_DRIFT_ACCEPTED", "ARTIFACT_DECISION", "VISUAL_UNBACKED"]) {
        const binding = await resolveRequiredPrincipal(kind, fixture.targetRoot);
        assert.equal(binding.policyId, "engine/STANDARD_LOCAL/v1");
        assert.equal(binding.requiredPrincipal, "AGENT_RELAYED");
        assert.equal(binding.policyDigest, "sha256:f38ec59bad6a56b15e7c5c1a87f9a003591644de0203bd5a7ff91df82af81042");
        assert.equal(await resolveHistoricalRequiredPrincipal(kind, fixture.targetRoot, binding.policyId, binding.policyDigest), "AGENT_RELAYED");
      }
      const oldDigest = `sha256:${createHash("sha256").update(JSON.stringify({
        policyId: "engine/judgment/v1", projectRoot: null, revision: 1, rules: {},
      })).digest("hex")}`;
      assert.equal(await resolveHistoricalRequiredPrincipal("EXCLUSION", fixture.targetRoot, "engine/judgment/v1", oldDigest), "HUMAN_ATTESTED");
      await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
      const [candidate] = (await record(fixture, ["--pending"])).candidates;
      await record(fixture, ["--approve", candidate.id], { stdout: { write() {} }, ask: () => "APPROVE" });
    });
    await withDecisionPolicy(protectedPolicyDocument(fixture.targetRoot, { EXCLUSION: "HUMAN_ATTESTED" }), async () => {
      const pending = await record(fixture, ["--pending"]);
      assert.equal(pending.decisions.state, "STALE");
      assert.equal(pending.candidates[0].requiredPrincipal, "HUMAN_ATTESTED");
      assert.equal(pending.candidates[0].blocked.state, "SIGNER_UNAVAILABLE");
      const bytes = await decisionLedger(fixture);
      const refused = await record(fixture, ["--approve", pending.candidates[0].id], {
        stdout: { write() {} }, ask: () => assert.fail("High assurance must not prompt for local fallback"),
      });
      assert.equal(refused.blocked.state, "SIGNER_UNAVAILABLE");
      assert.equal(await decisionLedger(fixture), bytes);
    });
  } finally { process.exitCode = 0; await fixture.cleanup(); }
});

test("standard relay revalidates evidence and protected policy under the append lock", async () => {
  const fixture = await createFixture();
  try {
    await withDecisionPolicy(null, async () => {
      await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
      const [candidate] = (await record(fixture, ["--pending"])).candidates;
      await assert.rejects(record(fixture, ["--approve", candidate.id], {
        stdout: { write() {} }, ask: async () => { await editEvidence(fixture); return "APPROVE"; },
      }), /changed while its review was open/);
      assert.equal(await decisionLedger(fixture), null);
    });
    let document = protectedPolicyDocument(fixture.targetRoot, { EXCLUSION: "AGENT_RELAYED" });
    await withDecisionPolicy(() => document, async () => {
      const [candidate] = (await record(fixture, ["--pending"])).candidates;
      await assert.rejects(record(fixture, ["--approve", candidate.id], {
        stdout: { write() {} }, ask: () => {
          document = protectedPolicyDocument(fixture.targetRoot, { EXCLUSION: "HUMAN_ATTESTED" }, document);
          return "APPROVE";
        },
      }), /changed while its review was open/);
      assert.equal(await decisionLedger(fixture), null);
    });
  } finally { process.exitCode = 0; await fixture.cleanup(); }
});
