import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createSession, handleMessage } from "../../src/mcp-server.mjs";
import { runRecordDecisionCli } from "../../src/record-decision.mjs";
import { runMigration } from "../../src/cli/run-migration.mjs";
import { advanceMigration, previewAdvance } from "../../src/core.mjs";
import {
  candidateDigestOf,
  DEFAULT_DECISION_POLICY_ID,
  DEFAULT_DECISION_POLICY_DIGEST,
  resolveHistoricalRequiredPrincipal,
  resolveRequiredPrincipal,
} from "../../src/decisions/index.mjs";
import {
  recoverMigrationRecord,
} from "../../src/lifecycle/index.mjs";
import { withDecisionPolicy, protectedPolicyDocument } from "../support/decision-policy-fixture.mjs";
import { createFixture, atDirectLedgerCompleteness, EXCLUDED_CLASSIFICATION, decisionLedger,
  state, addLegacyFiles, extraFileNames, manyExcluded, behaviorBacked, resolutionFor,
  initialize, authorDiscoverLegacy, directLedgerClassification, MODULE_CLASSIFICATION, snapshot } from "./approval.fixture.mjs";

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
          return JSON.parse(reply.result.content.at(-1).text);
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
          // An unanswered elicitation is no answer: a recoverable OPERATOR_DECISION, not FAILED.
          assert.equal((await call("migration_run")).outcome, "OPERATOR_DECISION");
          late({ action: "accept", content: { decision: "APPROVE" } });
          assert.equal(await decisionLedger(fixture), null);
          assert.deepEqual(await state(fixture), before);
        }
        const injected = await handleMessage(message("migration_run", {
          decision: "APPROVE", principal: "HUMAN_ATTESTED" }), session);
        assert.ok(injected.error);
        const noRelay = await handleMessage(message("migration_run", { mode: "auto" }), createSession());
        assert.equal(JSON.parse(noRelay.result.content.at(-1).text).outcome, "OPERATOR_DECISION");
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

for (const [answer, transport] of ["APPROVE", "REJECT"].flatMap((answer) => [[answer, "mcp"], [answer, "cli"]])) {
  test(`conversational ${answer} relay over ${transport}: timeout/unavailable write nothing, stale and HUMAN_ATTESTED refuse`, async () => {
    const fixture = await createFixture();
    const exitCode = process.exitCode;
    try {
      await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
      const call = async (name, extra = {}, session = createSession()) => {
        const reply = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name, arguments: { module: "auth", cwd: fixture.root, ...extra } } }, session);
        assert.equal(reply.error, undefined, JSON.stringify(reply));
        return JSON.parse(reply.result.content.at(-1).text);
      };
      const failing = createSession({ request: async () => { throw new Error("Elicitation timed out"); } });
      await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { capabilities: { elicitation: {} } } }, failing);
      const relay = (reference, decision = answer) => transport === "mcp"
        ? call("migration_relay_decision", { reference, decision })
        : record(fixture, ["--relay", reference, "--decision", decision]);
      if (transport === "cli") {
        await assert.rejects(record(fixture, ["--decision", answer]), /--relay <reference> --decision/);
        await assert.rejects(record(fixture, ["--relay", "", "--decision", answer]), /--relay <operatorApproval.reference>/);
      }
      await withDecisionPolicy(protectedPolicyDocument(fixture.targetRoot, { EXCLUSION: "HUMAN_ATTESTED" }), async () => {
        const run = await call("migration_run");
        assert.equal(run.blocked.requiredPrincipal, "HUMAN_ATTESTED");
        const refused = await relay(run.operatorApproval.reference, "APPROVE");
        assert.equal(refused.outcome, "BLOCKED");
        assert.equal(refused.blocked.state, "SIGNER_UNAVAILABLE");
        assert.equal(await decisionLedger(fixture), null);
      });
      await withDecisionPolicy(null, async () => {
        const before = await state(fixture);
        const timedOut = await call("migration_run", {}, failing);
        const unavailable = await call("migration_run");
        for (const result of [timedOut, unavailable]) {
          assert.equal(result.outcome, "OPERATOR_DECISION");
          assert.equal(result.operatorApproval.review.policy.requiredPrincipal, "AGENT_RELAYED");
          assert.match(result.operatorApproval.reference, /^review-[0-9a-f]{32}$/);
        }
        const { reference } = unavailable.operatorApproval;
        assert.equal(timedOut.operatorApproval.reference, reference);
        assert.equal(await decisionLedger(fixture), null);
        assert.deepEqual(await state(fixture), before);

        assert.equal((await relay(`review-${"0".repeat(32)}`)).blocked.state, "STALE_REVIEW");
        const recorded = await relay(reference);
        assert.equal(recorded.outcome, "CONTINUE", recorded.reason);
        const lines = (await decisionLedger(fixture)).trim().split("\n").map(JSON.parse);
        assert.deepEqual(lines.map((line) => [line.principal, line.result]),
          [["AGENT_RELAYED", answer === "APPROVE" ? "APPROVED" : "REJECTED"]]);
        assert.equal((await relay(reference)).blocked.state, "STALE_REVIEW");
        assert.equal((await decisionLedger(fixture)).trim().split("\n").length, 1);
        const resumed = await call("migration_run");
        assert.equal(resumed.outcome, answer === "APPROVE" ? "CONTINUE" : "BLOCKED", resumed.reason);
        if (answer === "APPROVE") assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
      });
    } finally { process.exitCode = exitCode; await fixture.cleanup(); }
  });
}

// I1: no injected recorder, so `recorderFor` probes the TTY and the operator is
// asked for real. Only the stream moves -- the review and the prompt go to
// stderr -- so a terminal cannot contaminate the one JSON document on stdout.
test("run --json at a terminal asks the operator on stderr; stdout is one JSON document", async () => {
  const fixture = await createFixture();
  const exitCode = process.exitCode;
  const cwd = process.cwd();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const { write: outWrite, isTTY: outTty } = process.stdout;
  const { write: errWrite, isTTY: errTty } = process.stderr;
  const input = new PassThrough();
  input.isTTY = true;
  let stdout = "";
  let stderr = "";
  // Answered on whichever stream asks, so a regression fails the parse below instead of hanging.
  const answer = (chunk) => {
    if (String(chunk).includes("Choose APPROVE or REJECT")) queueMicrotask(() => input.write("APPROVE\n"));
    return chunk;
  };
  try {
    await withDecisionPolicy(null, async () => {
      await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
      let result;
      try {
        Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
        process.stdout.isTTY = true;
        process.stderr.isTTY = true;
        process.stdout.write = (chunk) => ((stdout += answer(chunk)), true);
        process.stderr.write = (chunk) => ((stderr += answer(chunk)), true);
        process.chdir(fixture.root);
        result = await runMigration(["auth", "--json"]);
      } finally {
        Object.defineProperty(process, "stdin", stdin);
        Object.assign(process.stdout, { write: outWrite, isTTY: outTty });
        Object.assign(process.stderr, { write: errWrite, isTTY: errTty });
        process.chdir(cwd);
      }
      assert.match(stderr, /Required principal: AGENT_RELAYED/);
      assert.match(stderr, /Choose APPROVE or REJECT/);
      assert.deepEqual(JSON.parse(stdout), JSON.parse(JSON.stringify(result)));
      const lines = (await decisionLedger(fixture)).trim().split("\n").map(JSON.parse);
      assert.deepEqual(lines.map((line) => [line.principal, line.result]), [["AGENT_RELAYED", "APPROVED"]]);
    });
  } finally { input.end(); process.exitCode = exitCode; await fixture.cleanup(); }
});

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

const visualClassificationPath = (fixture) => path.join(fixture.migrationRoot, "inventories/module-classification.json");
const editVisualProposal = async (fixture, edit) => {
  const file = visualClassificationPath(fixture);
  const document = JSON.parse(await readFile(file, "utf8"));
  edit(document);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
};
const advanceVisual = async (fixture, extra = {}) => {
  const input = { ...(await resolutionFor(fixture)), moduleName: "auth" };
  const preview = await previewAdvance(input);
  return advanceMigration({ ...input, confirmAdvance: preview.confirmationId, ...extra });
};
const atVisualCompleteness = async (fixture, format = 19) => {
  await addLegacyFiles(fixture, ["attach.js"]);
  await writeFile(path.join(fixture.legacyRoot, "auth/attach.js"), "export const attach = (parent, child) => parent.appendChild(child);\n");
  await initialize(fixture, { currentFormat: format === 19 ? 19 : false });
  const classification = { ...MODULE_CLASSIFICATION,
    declaredEntryPoints: [{ path: "auth/attach.js", reason: "Module entry." }],
    files: [...MODULE_CLASSIFICATION.files, { ...MODULE_CLASSIFICATION.files[0], path: "auth/attach.js",
      reachability: "REACHABLE_FROM_ENTRY", kind: "MODULE" }],
    visualApplicability: { rationale: "The parent is an XML export node; this entry never reaches a screen." } };
  await authorDiscoverLegacy(fixture, format === 19 ? directLedgerClassification(classification) : classification);
  const file = path.join(fixture.migrationRoot, "inventories/legacy.json");
  const inventory = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify({ ...inventory, hasVisibleUi: false, uiBehaviors: [] }, null, 2)}\n`);
  await advanceVisual(fixture);
  await writeFile(path.join(fixture.migrationRoot, "steps/02a-discovery-completeness.md"),
    "# Discovery completeness\n\n- Status: `COMPLETE`\n\n## Result\n\nAuthored classification.\n");
};

for (const format of [18, 19]) {
  test(`module visual applicability ${format}: AUTO stops, explicit decision binds and closes discovery`, async () => {
    const fixture = await createFixture();
    const exitCode = process.exitCode;
    try {
      await withDecisionPolicy(null, async () => {
        await atVisualCompleteness(fixture, format);
        const before = await snapshot(fixture.migrationRoot);
        await assert.rejects(advanceVisual(fixture), /VISUAL_APPLICABILITY_INCONCLUSIVE/);
        const [candidate] = (await record(fixture, ["--pending"])).candidates;
        assert.equal(candidate.kind, "VISUAL_APPLICABILITY");
        assert.equal(candidate.autoResolvable, false);
        assert.equal(candidate.boundTo.visualApplicability.files[0].path, "auth/attach.js");
        const reply = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "migration_run", arguments: { module: "auth", cwd: fixture.root, mode: "auto" } } }, createSession());
        assert.equal(JSON.parse(reply.result.content.at(-1).text).outcome, "OPERATOR_DECISION");
        // Step mode: the confirmed advance refuses and names the operator decision; it never self-approves.
        const stepInput = { ...(await resolutionFor(fixture)), moduleName: "auth", mode: "step" };
        const stepPreview = await previewAdvance(stepInput);
        assert.equal(stepPreview.requiresConfirmation, true);
        await assert.rejects(advanceMigration({ ...stepInput, confirmAdvance: stepPreview.confirmationId }),
          /VISUAL_APPLICABILITY_INCONCLUSIVE.*VISUAL_APPLICABILITY operator decision/);
        assert.equal((await record(fixture, ["--pending"])).candidates[0].id, candidate.id);
        assert.equal(await decisionLedger(fixture), null);
        assert.deepEqual(await snapshot(fixture.migrationRoot), before);
        const recorded = await record(fixture, ["--approve", candidate.id], {
          stdout: { write() {} }, ask: ({ challenge }) => format === 19 ? "APPROVE" : challenge,
        });
        const line = recorded.decision ?? recorded.decisions[0];
        if (format === 19) {
          assert.equal(line.principal, "AGENT_RELAYED");
          assert.equal(line.policyId, "engine/visual-applicability/v1");
          assert.notEqual(line.policyDigest, DEFAULT_DECISION_POLICY_DIGEST);
        } else {
          const [receipt] = (await record(fixture, ["--pending"])).references;
          await editVisualProposal(fixture, (document) => Object.assign(document.visualApplicability,
            { decisionId: receipt.decisionId, decisionDigest: receipt.decisionDigest }));
        }
        if (format === 19) {
          await assert.rejects(advanceVisual(fixture, { hooks: { afterWrite: (stage) => {
            if (stage === "state") throw new Error("visual decision crash");
          } } }), /visual decision crash/);
          await recoverMigrationRecord({ ...(await resolutionFor(fixture)), moduleName: "auth" });
        } else await advanceVisual(fixture);
        assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
        const historyPath = path.join(fixture.migrationRoot, "history/history.ndjson");
        const history = await readFile(historyPath, "utf8");
        if (format === 19) assert.equal(history.trim().split("\n").map(JSON.parse)
          .flatMap((event) => event.consumedDecisions ?? []).filter((entry) => entry.decisionId === line.id).length, 1);
        await recoverMigrationRecord({ ...(await resolutionFor(fixture)), moduleName: "auth" });
        assert.equal(await readFile(historyPath, "utf8"), history);
        assert.equal((await record(fixture, ["--pending"])).candidates.length, 0);
        // The approved waiver remains applicable at a later checkpoint without
        // consuming a second identity in the discovery event or rewriting its history.
        const { assertPinnedVisualApplicability } = await import("../../src/census/index.mjs");
        await assertPinnedVisualApplicability(fixture.migrationRoot,
          { legacyRoot: fixture.legacyRoot, targetRoot: fixture.targetRoot }, undefined, await state(fixture));
        assert.equal(await readFile(historyPath, "utf8"), history);
        const legacy = JSON.parse(await readFile(path.join(fixture.migrationRoot, "inventories/legacy.json"), "utf8"));
        await writeFile(path.join(fixture.migrationRoot, "inventories/target.json"), JSON.stringify({
          version: 1, implementationState: "ABSENT", hasVisibleUi: false,
          evidence: legacy.behaviors[0].evidence.map((item) => item.location ? { ...item, location: "target/src/placeholder.ts" } : item),
          nativeBehaviors: [], uiComponents: [], uiMismatches: [], navigationSurfaces: [],
        }, null, 2) + "\n");
        await writeFile(path.join(fixture.migrationRoot, "steps/03-assess-target.md"),
          "# Assess target\n\n- Status: `COMPLETE`\n\n## Result\n\nNonvisual target assessment.\n");
        await advanceVisual(fixture);
        assert.equal((await state(fixture)).currentStep, "BUILD_BASELINE");
        const laterHistory = await readFile(historyPath, "utf8");
        assert.ok(laterHistory.startsWith(history));
        if (format === 19) {
          const events = laterHistory.trim().split("\n").map(JSON.parse);
          for (const step of ["DISCOVERY_COMPLETENESS", "ASSESS_TARGET"]) {
            const consumed = events.filter((event) => event.step === step)
              .flatMap((event) => event.consumedDecisions ?? []);
            assert.equal(consumed.length, 1, `${step} consumes one applicable decision`);
            assert.equal(consumed[0].decisionId, line.id);
          }
        }
        await recoverMigrationRecord({ ...(await resolutionFor(fixture)), moduleName: "auth" });
        assert.equal(await readFile(historyPath, "utf8"), laterHistory);
      });
    } finally { process.exitCode = exitCode; await fixture.cleanup(); }
  });
}

test("module visual applicability: missing rationale, rejection, stale review, and protected policy fail closed", async () => {
  const fixture = await createFixture();
  const exitCode = process.exitCode;
  try {
    await withDecisionPolicy(null, async () => {
      await atVisualCompleteness(fixture);
      for (const proposal of [undefined, { rationale: " " }]) {
        await editVisualProposal(fixture, (document) => { document.visualApplicability = proposal; });
        await assert.rejects(advanceVisual(fixture), /VISUAL_APPLICABILITY_INCONCLUSIVE.*rationale/);
        assert.equal((await record(fixture, ["--pending"])).candidates[0].approvable, false);
      }
      await editVisualProposal(fixture, (document) => { document.visualApplicability = { rationale: "XML nodes only." }; });
      const [candidate] = (await record(fixture, ["--pending"])).candidates;
      await assert.rejects(record(fixture, ["--approve", candidate.id], { stdout: { write() {} }, ask: async () => {
        await editVisualProposal(fixture, (document) => { document.visualApplicability.rationale += " Revised."; });
        return "APPROVE";
      } }), /changed while its review was open/);
      assert.equal(await decisionLedger(fixture), null);
      const [fresh] = (await record(fixture, ["--pending"])).candidates;
      await record(fixture, ["--approve", fresh.id], { stdout: { write() {} }, ask: () => "REJECT" });
      await assert.rejects(advanceVisual(fixture), /REJECTED/);
      await editVisualProposal(fixture, (document) => { document.visualApplicability.rationale += " Updated evidence."; });
      assert.equal((await record(fixture, ["--pending"])).decisions.state, "STALE");
      const [revised] = (await record(fixture, ["--pending"])).candidates;
      await record(fixture, ["--approve", revised.id], { stdout: { write() {} }, ask: () => "APPROVE" });
      await writeFile(path.join(fixture.legacyRoot, "auth/attach.js"), "export const attach = (parent, child) => parent.appendChild(child); // changed\n");
      assert.equal((await record(fixture, ["--pending"])).decisions.state, "STALE");
      await assert.rejects(advanceVisual(fixture), /stale/);
    });
    for (const rules of [{}, { VISUAL_APPLICABILITY: "HUMAN_ATTESTED" }]) {
      await withDecisionPolicy(protectedPolicyDocument(fixture.targetRoot, rules), async () => {
        const [candidate] = (await record(fixture, ["--pending"])).candidates;
        assert.equal(candidate.requiredPrincipal, "HUMAN_ATTESTED");
        const before = await decisionLedger(fixture);
        const refused = await record(fixture, ["--approve", candidate.id], { stdout: { write() {} },
          ask: () => assert.fail("Protected policy cannot fall back to relay") });
        assert.equal(refused.blocked.state, "SIGNER_UNAVAILABLE");
        assert.equal(await decisionLedger(fixture), before);
      });
    }
  } finally { process.exitCode = exitCode; await fixture.cleanup(); }
});

test("module visual applicability: scan metadata cannot conceal rendering or doubt, and late work needs recovery", async () => {
  const fixture = await createFixture();
  try {
    await atVisualCompleteness(fixture);
    const source = path.join(fixture.legacyRoot, "auth/attach.js");
    // Close a genuinely nonvisual module, then reproduce an older record's unseen signal.
    await writeFile(source, "export const attach = (parent, child) => child;\n");
    assert.equal((await record(fixture, ["--pending"])).candidates.length, 0);
    await advanceVisual(fixture);
    await writeFile(source, "export const attach = (parent, child) => parent.appendChild(child);\n");
    const { validateResumableMigration, projectDecisions } = await import("../../src/lifecycle/index.mjs");
    const { assertPinnedVisualApplicability } = await import("../../src/census/index.mjs");
    const current = await state(fixture);
    const roots = { legacyRoot: fixture.legacyRoot, targetRoot: fixture.targetRoot };
    const scanPath = path.join(fixture.migrationRoot, "inventories/discovery-scan.json");
    const originalScan = await readFile(scanPath, "utf8");
    for (const edit of [() => {}, (scan) => { scan.census = []; },
      (scan) => { scan.reachability["auth/attach.js"] = "UNREACHABLE"; },
      (scan) => { scan.kinds["auth/attach.js"] = "STYLE"; },
      (scan) => { scan.discoveryDigest = "sha256:tampered"; }]) {
      const scan = JSON.parse(originalScan); edit(scan);
      await writeFile(scanPath, `${JSON.stringify(scan, null, 2)}\n`);
      for (const step of ["ASSESS_TARGET", "BUILD_BASELINE", "PLAN", "IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"]) {
        await assert.rejects(assertPinnedVisualApplicability(fixture.migrationRoot, roots, undefined, { ...current, currentStep: step }),
          /VISUAL_APPLICABILITY_RECOVERY_REQUIRED: .*--reopen-discovery/);
      }
    }
    await writeFile(scanPath, originalScan);
    for (const step of ["ASSESS_TARGET", "BUILD_BASELINE", "PLAN", "IMPLEMENT_SLICES", "VERIFY_SLICES", "FINALIZE"]) {
      await assert.rejects(validateResumableMigration({ registryPath: fixture.registryPath, moduleName: "auth", step }),
        /VISUAL_APPLICABILITY_RECOVERY_REQUIRED/);
    }
    await assert.rejects(assertPinnedVisualApplicability(fixture.migrationRoot, roots, undefined,
      { ...current, currentStep: "FINALIZE", completedSlices: ["verified"] }),
      /operator's --refresh --confirm-mismatch/);
    const projection = await projectDecisions({ registryPath: fixture.registryPath, moduleName: "auth" });
    assert.equal(projection.blocked.state, "VISUAL_APPLICABILITY_RECOVERY_REQUIRED");
    await assert.rejects(record(fixture, ["--pending"]), /VISUAL_APPLICABILITY_RECOVERY_REQUIRED/);
    const before = await snapshot(fixture.migrationRoot);
    const reply = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "migration_run", arguments: { module: "auth", cwd: fixture.root } } }, createSession());
    assert.equal(JSON.parse(reply.result.content.at(-1).text).outcome, "BLOCKED");
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
    // The named recovery really recovers: reopen, re-close, decide, and reach ASSESS_TARGET.
    const { previewMigrationExecution, bootstrapMigration } = await import("../../src/lifecycle/index.mjs");
    const resolution = { ...(await resolutionFor(fixture)), moduleName: "auth" };
    const reopen = await previewMigrationExecution({ ...resolution, reopenDiscovery: true });
    assert.equal(reopen.expectedNextCheckpoint, "DISCOVER_LEGACY");
    assert.equal((await bootstrapMigration({ ...resolution, reopenDiscovery: true,
      boundInputs: reopen.boundInputs, registryBinding: reopen.registryBinding })).reopened, true);
    await advanceVisual(fixture);
    assert.equal((await state(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
    await assert.rejects(advanceVisual(fixture), /VISUAL_APPLICABILITY_INCONCLUSIVE/);
    const [candidate] = (await record(fixture, ["--pending"])).candidates;
    await record(fixture, ["--approve", candidate.id], { stdout: { write() {} }, ask: () => "APPROVE" });
    await advanceVisual(fixture);
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally { await fixture.cleanup(); }
});

test("module visual applicability: only inconclusive reachable owned files need a waiver; COMPLETE keeps history", async () => {
  const fixture = await createFixture();
  try {
    await atVisualCompleteness(fixture);
    await editVisualProposal(fixture, (document) => { document.declaredEntryPoints = []; });
    assert.equal((await record(fixture, ["--pending"])).candidates.length, 0);
    await editVisualProposal(fixture, (document) => { document.declaredEntryPoints = [{ path: "auth/attach.js", reason: "Entry" }]; });
    const source = path.join(fixture.legacyRoot, "auth/attach.js");
    await writeFile(source, "export const attach = (parent, child) => { parent.appendChild(child); document.createElement('div'); };\n");
    await assert.rejects(record(fixture, ["--pending"]), /VISUAL_APPLICABILITY_MISMATCH/);
    await assert.rejects(advanceVisual(fixture), /VISUAL_APPLICABILITY_MISMATCH/);
    const { moduleVisualDecisionInput, readCanonicalModuleBoundary, assertPinnedVisualApplicability } = await import("../../src/census/index.mjs");
    const current = await state(fixture);
    const roots = { legacyRoot: fixture.legacyRoot, targetRoot: fixture.targetRoot };
    const boundary = await readCanonicalModuleBoundary(fixture.migrationRoot, current, roots);
    assert.equal(await moduleVisualDecisionInput({ root: fixture.migrationRoot, state: current, roots, ...boundary,
      inventory: { hasVisibleUi: true } }), null);
    assert.equal(await moduleVisualDecisionInput({ root: fixture.migrationRoot, state: { ...current, status: "COMPLETE" }, roots, ...boundary,
      inventory: { hasVisibleUi: false } }), null);
    const before = await snapshot(fixture.migrationRoot);
    await assertPinnedVisualApplicability(fixture.migrationRoot, roots, { hasVisibleUi: false },
      { ...current, status: "COMPLETE", currentStep: "COMPLETE", completedSteps: [...current.completedSteps, "DISCOVERY_COMPLETENESS"] });
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally { await fixture.cleanup(); }
});

test("module visual applicability: pending and validation refuse coordinated pin edits and illegal late ledger appends", async () => {
  const fixture = await createFixture();
  const exitCode = process.exitCode;
  try {
    await atVisualCompleteness(fixture);
    const [candidate] = (await record(fixture, ["--pending"])).candidates;
    await record(fixture, ["--approve", candidate.id], { stdout: { write() {} }, ask: () => "APPROVE" });
    await advanceVisual(fixture);
    const { projectDecisions, validateResumableMigration } = await import("../../src/lifecycle/index.mjs");
    const { readCanonicalModuleBoundary } = await import("../../src/census/index.mjs");
    const input = { registryPath: fixture.registryPath, moduleName: "auth" };
    const names = ["inventories/module-classification.json", "inventories/discovery-scan.json",
      "inventories/legacy.json", "decisions/operator-decisions.ndjson"];
    const originals = await Promise.all(names.map((name) => readFile(path.join(fixture.migrationRoot, name), "utf8")));
    for (const mutate of [
      async () => {
        await editVisualProposal(fixture, (document) => { document.declaredEntryPoints = []; });
        const { scan } = await readCanonicalModuleBoundary(fixture.migrationRoot, await state(fixture),
          { legacyRoot: fixture.legacyRoot, targetRoot: fixture.targetRoot });
        const recorded = JSON.parse(originals[1]); recorded.discoveryDigest = scan.discoveryDigest;
        await writeFile(path.join(fixture.migrationRoot, names[1]), JSON.stringify(recorded));
      },
      async () => {
        const legacy = JSON.parse(originals[2]); legacy.hasVisibleUi = true;
        await writeFile(path.join(fixture.migrationRoot, names[2]), JSON.stringify(legacy));
      },
      async () => {
        const line = JSON.parse(originals[3].trim());
        const { decisionLineDigest } = await import("../../src/decisions/index.mjs");
        await appendFile(path.join(fixture.migrationRoot, names[3]), JSON.stringify({ ...line,
          id: "DEC-002", seq: 2, prevDigest: decisionLineDigest(line) }) + "\n");
      },
    ]) {
      await mutate();
      const before = await snapshot(fixture.migrationRoot);
      await assert.rejects(record(fixture, ["--pending"]), /changed|gained a .*decision after/);
      await assert.rejects(projectDecisions(input), /changed|gained a .*decision after/);
      await assert.rejects(validateResumableMigration(input), /changed|gained a .*decision after/);
      await assert.rejects(record(fixture, ["--approve", candidate.id], { stdout: { write() {} }, ask: () => assert.fail("Corrupt pins cannot reach approval") }),
        /changed|gained a .*decision after/);
      assert.deepEqual(await snapshot(fixture.migrationRoot), before);
      for (const [index, name] of names.entries()) await writeFile(path.join(fixture.migrationRoot, name), originals[index]);
    }
  } finally { process.exitCode = exitCode; await fixture.cleanup(); }
});
