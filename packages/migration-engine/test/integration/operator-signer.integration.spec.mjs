/**
 * The protected signer end to end over a real format-19 module record: real
 * engine, real ledger, real WebAuthn verification, real HTTPS companion. Only
 * the authenticator is a test-only in-memory software key.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { advanceMigration, pendingDecisionCandidates, previewAdvance } from "../../src/core.mjs";
import {
  beginAttestedDecision,
  completeAttestedDecision,
  reviewAttestedCandidate,
  renderDecisionReview,
  runRecordDecisionCli,
} from "../../src/record-decision.mjs";
import { attestationVerifierScope, candidateDigestOf } from "../../src/resumable-migration.mjs";
import { createOperatorSigner, openSignerStore, startReviewCompanion } from "../../src/operator-signer.mjs";
import {
  addLegacyFiles,
  atDirectLedgerCompleteness,
  behaviorBacked,
  createFixture,
  decisionLedger,
  EXCLUDED_CLASSIFICATION,
  extraFileNames,
  manyExcluded,
  resolutionFor,
} from "./approval.fixture.mjs";
import { enrolledSigner, ORIGIN, RP_ID } from "../support/signer-fixture.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const CLASSIFICATION = "inventories/module-classification.json";

const moduleTarget = async (fixture) => ({ recordKind: "module", ...(await resolutionFor(fixture)), moduleName: "auth" });
const ledgerLines = async (fixture) => ((await decisionLedger(fixture)) ?? "").split("\n").filter(Boolean);
const inScope = (signer, run) => attestationVerifierScope.run(signer, run);

const withRecord = async (classification, run, { group = false } = {}) => {
  const fixture = await createFixture();
  const signed = await enrolledSigner();
  try {
    if (group) {
      const names = extraFileNames(13);
      await addLegacyFiles(fixture, names);
      await atDirectLedgerCompleteness(fixture, manyExcluded(names), behaviorBacked(names));
    } else {
      await atDirectLedgerCompleteness(fixture, classification);
    }
    const target = await moduleTarget(fixture);
    return await run({ fixture, target, ...signed });
  } finally {
    process.exitCode = 0;
    await signed.cleanup();
    await fixture.cleanup();
  }
};

const attest = async ({ signer, auth, target }, candidateId, result = "APPROVED", extra = {}) => {
  const begun = await beginAttestedDecision({ signer, target, candidateId, result });
  return completeAttestedDecision({ signer, target, candidateId, nonce: begun.nonce, response: auth.assert(begun.options), ...extra });
};

test("module 19: signed APPROVED appends one replay-verified line and the shared projection updates", async () => {
  await withRecord(EXCLUDED_CLASSIFICATION, async ({ fixture, target, signer, auth, directory }) => {
    const [candidate] = (await pendingDecisionCandidates(target)).candidates;
    const done = await attest({ signer, auth, target }, candidate.id);
    assert.equal(done.decision.principal, "HUMAN_ATTESTED");
    assert.equal(done.decision.result, "APPROVED");
    assert.equal(done.decision.candidateDigest, candidateDigestOf(candidate));
    assert.equal(done.decision.v, 2);
    assert.equal(done.projection.candidates.find((entry) => entry.id === candidate.id).state, "APPROVED_APPLICABLE");
    const lines = await ledgerLines(fixture);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], JSON.stringify(done.decision));
    // A restarted service on the same protected store replays the proof.
    const restarted = createOperatorSigner(await openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID }));
    const projected = await inScope(restarted, () => pendingDecisionCandidates(target));
    assert.equal(projected.candidates.length, 0);
    assert.equal(projected.decisions.candidates[0].state, "APPROVED_APPLICABLE");
    // Without the protected verifier, the attested line is refused, not trusted.
    await assert.rejects(pendingDecisionCandidates(target), /no protected signer verifier|SIGNER_UNAVAILABLE/);
    // --verify: consistent only through protected replay.
    const verify = async () => {
      const previous = process.cwd();
      process.chdir(fixture.root);
      try { return await runRecordDecisionCli(["auth", "--verify"], { stdout: { write: () => true } }); }
      finally { process.chdir(previous); }
    };
    assert.equal((await inScope(restarted, verify)).outcome, "CONSISTENT");
    assert.equal((await verify()).outcome, "INCONSISTENT");
    // The checkpoint consumes exactly this identity.
    await inScope(restarted, async () => {
      const preview = await previewAdvance({ ...target });
      await advanceMigration({ ...target, confirmAdvance: preview.confirmationId });
    });
    const history = await readFile(path.join(fixture.migrationRoot, "history/history.ndjson"), "utf8");
    assert.ok(history.includes(done.decision.id) && history.includes("consumedDecisions"));
  });
});

test("module 19: signed REJECTED blocks only that candidate digest and a stale review writes nothing", async () => {
  await withRecord(EXCLUDED_CLASSIFICATION, async ({ fixture, target, signer, auth }) => {
    const [candidate] = (await pendingDecisionCandidates(target)).candidates;
    // Candidate changes between issue and completion: STALE, nothing written, nonce unspent.
    const begun = await beginAttestedDecision({ signer, target, candidateId: candidate.id, result: "APPROVED" });
    const file = path.join(fixture.migrationRoot, CLASSIFICATION);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("Decorative", "Decorative (edited)"));
    await assert.rejects(
      completeAttestedDecision({ signer, target, candidateId: candidate.id, nonce: begun.nonce, response: auth.assert(begun.options) }),
      /STALE_REVIEW/,
    );
    assert.equal(await decisionLedger(fixture), null);
    await writeFile(file, original);
    const rejected = await attest({ signer, auth, target }, candidate.id, "REJECTED");
    assert.equal(rejected.decision.result, "REJECTED");
    assert.equal(rejected.projection.state, "REJECTED");
    // Decided candidates are no longer attestable: no duplicate or conflicting line.
    await assert.rejects(beginAttestedDecision({ signer, target, candidateId: candidate.id, result: "APPROVED" }), /STALE_REVIEW/);
    // Changed evidence makes the rejection stale and the question open again.
    await writeFile(file, original.replace("Decorative", "Decorative, revised"));
    const reopened = await inScope(signer, () => pendingDecisionCandidates(target));
    assert.equal(reopened.decisions.candidates[0].state, "STALE");
    assert.equal((await ledgerLines(fixture)).length, 1);
  });
});

test("module 19: forged, edited, unclaimed and duplicated attested lines are refused on read", async () => {
  await withRecord(EXCLUDED_CLASSIFICATION, async ({ fixture, target, signer, auth }) => {
    const [candidate] = (await pendingDecisionCandidates(target)).candidates;
    const done = await attest({ signer, auth, target }, candidate.id);
    const ledger = path.join(fixture.migrationRoot, "decisions/operator-decisions.ndjson");
    const genuine = await readFile(ledger, "utf8");
    const read = () => inScope(signer, () => pendingDecisionCandidates(target));
    for (const [label, forged, pattern] of [
      ["stored verified:true", { ...done.decision, verified: true }, /line digest/],
      ["result flipped", { ...done.decision, result: "REJECTED" }, /line digest/],
      ["proof swapped", { ...done.decision, webauthn: { ...done.decision.webauthn, signature: done.decision.webauthn.signature.slice(0, -2) + "AA" } }, /line digest|proof/],
      ["no proof", { ...done.decision, webauthn: undefined }, /without a webauthn proof/],
      ["unknown verifier version", { ...done.decision, webauthn: { ...done.decision.webauthn, verificationVersion: 2 } }, /line digest|verificationVersion/],
    ]) {
      await writeFile(ledger, `${JSON.stringify(forged)}\n`);
      await assert.rejects(read(), pattern, label);
    }
    // A second protected store has no claim for this proof.
    await writeFile(ledger, genuine);
    const other = await enrolledSigner();
    try {
      await assert.rejects(inScope(other.signer, () => pendingDecisionCandidates(target)), /no protected claim/);
    } finally { await other.cleanup(); }
    // The same line appended twice is a chain break and a duplicate.
    await appendFile(ledger, genuine);
    await assert.rejects(read(), /chains to|seq/);
    await writeFile(ledger, genuine);
    assert.equal((await read()).decisions.candidates[0].state, "APPROVED_APPLICABLE");
  });
});

test("module 19: one signed group act is one line; members cannot be attested alone", async () => {
  await withRecord(null, async ({ fixture, target, signer, auth }) => {
    const pending = await pendingDecisionCandidates(target);
    const group = pending.group;
    assert.equal(group.groupMembers.length, 14);
    await assert.rejects(
      beginAttestedDecision({ signer, target, candidateId: group.groupMembers[0].id, result: "APPROVED" }),
      /GROUP_REVIEW_REQUIRED/,
    );
    const begun = await beginAttestedDecision({ signer, target, candidateId: group.id, result: "APPROVED" });
    assert.equal(begun.binding.groupMemberCount, 14);
    const done = await completeAttestedDecision({ signer, target, candidateId: group.id, nonce: begun.nonce, response: auth.assert(begun.options) });
    assert.equal(done.decision.kind, "GROUP_APPROVAL");
    assert.equal((await ledgerLines(fixture)).length, 1);
    assert.ok(done.projection.candidates.filter((entry) => group.groupMembers.some((member) => member.id === entry.id))
      .every((entry) => entry.state === "APPROVED_APPLICABLE"));
  }, { group: true });
});

test("module 19: changed group membership invalidates an issued group challenge", async () => {
  await withRecord(null, async ({ fixture, target, signer, auth }) => {
    const { group } = await pendingDecisionCandidates(target);
    const begun = await beginAttestedDecision({ signer, target, candidateId: group.id, result: "APPROVED" });
    const file = path.join(fixture.migrationRoot, CLASSIFICATION);
    const classification = JSON.parse(await readFile(file, "utf8"));
    classification.files = classification.files.filter((row) => row.path !== group.groupMembers.at(-1).subject.path);
    await writeFile(file, JSON.stringify(classification));
    await assert.rejects(
      completeAttestedDecision({ signer, target, candidateId: group.id, nonce: begun.nonce, response: auth.assert(begun.options) }),
      /STALE_REVIEW/,
    );
    assert.equal(await decisionLedger(fixture), null);
  }, { group: true });
});

/* -- crash boundaries ------------------------------------------------------ */

const BOUNDARIES = [
  "before-verify", "after-verify", "before-claim", "after-claim", "during-append",
  "after-append", "after-fsync", "before-commit", "after-commit", "before-response",
];

for (const boundary of BOUNDARIES) {
  test(`crash at ${boundary}: one committed line or an explicit blocked state, never two`, async () => {
    await withRecord(EXCLUDED_CLASSIFICATION, async ({ fixture, target, signer, auth, directory }) => {
      const [candidate] = (await pendingDecisionCandidates(target)).candidates;
      const begun = await beginAttestedDecision({ signer, target, candidateId: candidate.id, result: "APPROVED" });
      await assert.rejects(completeAttestedDecision({
        signer, target, candidateId: candidate.id, nonce: begun.nonce, response: auth.assert(begun.options),
        onBoundary: async (name, context) => {
          if (name !== boundary) return;
          if (name === "during-append") await context.writePrefix(40);
          throw new Error(`injected crash at ${name}`);
        },
      }), /injected crash/);
      // Service and engine restart: a fresh connection to the same protected store.
      const service = createOperatorSigner(await openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID }));
      const lines = ((await decisionLedger(fixture)) ?? "");
      const read = () => inScope(service, () => pendingDecisionCandidates(target));
      const again = () => beginAttestedDecision({ signer: service, target, candidateId: candidate.id, result: "APPROVED" });
      if (["before-verify", "after-verify", "before-claim"].includes(boundary)) {
        assert.equal(lines, "");
        const fresh = await again();
        const done = await completeAttestedDecision({ signer: service, target, candidateId: candidate.id, nonce: fresh.nonce, response: auth.assert(fresh.options) });
        assert.equal(done.decision.principal, "HUMAN_ATTESTED");
      } else if (boundary === "after-claim") {
        assert.equal(lines, "");
        await assert.rejects(again(), /RECONCILIATION_REQUIRED/);
        await assert.rejects(completeAttestedDecision({ signer: service, target, candidateId: candidate.id, nonce: begun.nonce, response: auth.assert(begun.options) }), /NONCE_SPENT/);
        assert.equal(await service.reconcile({ nonce: begun.nonce, actor: "admin-a", reason: "no line was appended" }), "ABANDONED");
        assert.equal((await read()).candidates.length, 1);
      } else if (boundary === "during-append") {
        assert.ok(!lines.endsWith("\n"));
        await assert.rejects(read(), /incomplete append/);
        await assert.rejects(again(), /RECONCILIATION_REQUIRED|incomplete append/);
        await assert.rejects(service.reconcile({ nonce: begun.nonce, actor: "admin-a", reason: "torn" }), /torn line/);
      } else if (["after-append", "after-fsync", "before-commit"].includes(boundary)) {
        assert.equal(lines.split("\n").filter(Boolean).length, 1);
        await assert.rejects(read(), /RECONCILIATION_REQUIRED|not COMMITTED/);
        await assert.rejects(again(), /RECONCILIATION_REQUIRED/);
        assert.equal(await service.reconcile({ nonce: begun.nonce, actor: "admin-a", reason: "exact durable line verified" }), "COMMITTED");
        assert.equal((await read()).decisions.candidates[0].state, "APPROVED_APPLICABLE");
      } else {
        assert.equal(lines.split("\n").filter(Boolean).length, 1);
        assert.equal((await read()).decisions.candidates[0].state, "APPROVED_APPLICABLE");
        await assert.rejects(again(), /STALE_REVIEW/);
      }
      assert.ok((await ledgerLines(fixture)).length <= 1, "never two lines");
      service.store?.db?.close?.();
    });
  });
}

/* -- review companion ------------------------------------------------------ */

const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const selfSignedTls = async (directory) => {
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"), "-days", "1",
    "-subj", `/CN=${RP_ID}`, "-addext", `subjectAltName=DNS:${RP_ID}`,
  ]);
  return { key: await readFile(path.join(directory, "key.pem")), cert: await readFile(path.join(directory, "cert.pem")) };
};

test("companion: HTTPS-only, session-bound, CSRF-checked, inert, stale-aware; approve/reject/cancel/timeout", async () => {
  const fixture = await createFixture();
  const tlsDirectory = await mkdtemp(path.join(os.tmpdir(), "amt-tls-"));
  const port = await freePort();
  const origin = `https://${RP_ID}:${port}`;
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), "amt-signer-"));
  let clock = Date.now();
  let companion;
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(storeDirectory, 0o700);
    const store = await openSignerStore({ directory: storeDirectory, origin, rpID: RP_ID });
    const signer = createOperatorSigner(store, { now: () => clock });
    const { createSoftwareAuthenticator } = await import("../support/software-authenticator.mjs");
    const auth = createSoftwareAuthenticator({ origin, rpID: RP_ID });
    const enrollment = await signer.beginEnrollment({ operator: "operator-a", actor: "admin-a", reason: "test" });
    await signer.finishEnrollment({ challenge: enrollment.challenge, response: auth.register(enrollment), actor: "admin-a" });

    const hostile = "<script>alert(1)</script>\u202eevil\u2066 <img src=x onerror=alert(1)>";
    const classification = JSON.parse(JSON.stringify(EXCLUDED_CLASSIFICATION));
    classification.files[0].rationale = `Decorative ${hostile}`;
    await atDirectLedgerCompleteness(fixture, classification);
    const target = await moduleTarget(fixture);
    const tls = await selfSignedTls(tlsDirectory);
    const loginToken = "t".repeat(48);
    const engine = {
      review: reviewAttestedCandidate,
      begin: beginAttestedDecision,
      complete: completeAttestedDecision,
      renderReview: renderDecisionReview,
    };
    await assert.rejects(startReviewCompanion({ signer, engine, tls: {}, port, targets: { auth: target }, loginToken }), /INVALID_TLS/);
    await assert.rejects(startReviewCompanion({ signer, engine, tls: { key: "bad", cert: "bad" }, port, targets: { auth: target }, loginToken }), /INVALID_TLS/);
    companion = await startReviewCompanion({ signer, engine, tls, port, targets: { auth: target }, loginToken });
    await assert.rejects(startReviewCompanion({ signer, engine, tls, port, targets: { auth: target }, loginToken }), /PORT_IN_USE/);

    let cookie = "";
    const request = (method, url, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
      const outgoing = https.request({
        host: "127.0.0.1", port, servername: RP_ID, ca: tls.cert, method, path: url,
        headers: { host: `${RP_ID}:${port}`, ...(cookie ? { cookie } : {}), ...headers },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      if (body !== undefined) outgoing.write(JSON.stringify(body));
      outgoing.end();
    });
    const post = (url, body, headers = {}) => request("POST", url, {
      body, headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    });

    const [candidate] = (await pendingDecisionCandidates(target)).candidates;
    const reviewPath = `/review?target=auth&candidate=${candidate.id}`;
    assert.equal((await request("GET", reviewPath)).status, 401);
    assert.equal((await request("GET", "/login?token=wrong")).status, 403);
    const login = await request("GET", `/login?token=${loginToken}`);
    assert.equal(login.status, 303);
    assert.match(login.headers["set-cookie"][0], /Secure; HttpOnly; SameSite=Strict/);
    assert.equal((await request("GET", `/login?token=${loginToken}`)).status, 403, "login token is single use");
    cookie = login.headers["set-cookie"][0].split(";")[0];
    assert.equal((await request("GET", reviewPath, { headers: { host: `evil.localhost:${port}` } })).status, 421);
    assert.equal((await request("GET", reviewPath, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);

    const page = await request("GET", reviewPath);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.doesNotMatch(page.text, /<script>alert|<img src=x|\u202e|\u2066/);
    assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page.text, /\\u202e/);
    assert.ok(page.text.includes(candidateDigestOf(candidate)));
    assert.match(page.text, /Required principal<\/dt><dd>HUMAN_ATTESTED/);
    assert.equal((page.text.match(/<script/g) ?? []).length, 1);
    assert.match(page.text, /<script src="\/app.js"><\/script>/);
    const token = /data-token="([^"]+)"/.exec(page.text)[1];
    const beginBody = (overrides = {}) => ({ target: "auth", candidate: candidate.id, candidateDigest: candidateDigestOf(candidate), pageToken: token, result: "APPROVED", ...overrides });

    // CSRF: wrong/missing origin, cross-site fetch metadata, wrong content type.
    assert.equal((await post("/api/begin", beginBody(), { origin: "https://evil.localhost" })).status, 403);
    assert.equal((await post("/api/begin", beginBody(), { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post("/api/begin", beginBody(), { "content-type": "text/plain" })).status, 403);
    // Stale page: a digest the page did not render.
    assert.equal(JSON.parse((await post("/api/begin", beginBody({ candidateDigest: `sha256:${"0".repeat(64)}` }))).text).error, "STALE_REVIEW");

    // Cancel: no line, nonce closed.
    const cancelled = JSON.parse((await post("/api/begin", beginBody())).text);
    assert.equal((await post("/api/cancel", { nonce: cancelled.nonce })).status, 200);
    assert.equal((await post("/api/complete", { nonce: cancelled.nonce, response: auth.assert(cancelled.options) })).status, 409);
    assert.equal(await decisionLedger(fixture), null);

    // Timeout: a challenge past its lifetime cannot complete.
    const pageTwo = await request("GET", reviewPath);
    const tokenTwo = /data-token="([^"]+)"/.exec(pageTwo.text)[1];
    const late = JSON.parse((await post("/api/begin", beginBody({ pageToken: tokenTwo }))).text);
    clock += 121_000;
    assert.match((await post("/api/complete", { nonce: late.nonce, response: auth.assert(late.options) })).text, /NONCE_EXPIRED/);
    clock = Date.now();
    assert.equal(await decisionLedger(fixture), null);

    // Changed candidate after render: the rendered page is invalid.
    const pageThree = await request("GET", reviewPath);
    const tokenThree = /data-token="([^"]+)"/.exec(pageThree.text)[1];
    const file = path.join(fixture.migrationRoot, CLASSIFICATION);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("Decorative", "Decorative, edited"));
    assert.match((await post("/api/begin", beginBody({ pageToken: tokenThree }))).text, /STALE_REVIEW/);
    await writeFile(file, original);

    // Close: begun but never completed writes nothing.
    const pageFour = await request("GET", reviewPath);
    const closed = JSON.parse((await post("/api/begin", beginBody({ pageToken: /data-token="([^"]+)"/.exec(pageFour.text)[1] }))).text);
    assert.ok(closed.nonce);
    assert.equal(await decisionLedger(fixture), null);

    // Reject: explicit result, raw proof only, engine decides authority.
    const pageFive = await request("GET", reviewPath);
    const rejectBegin = JSON.parse((await post("/api/begin", beginBody({ pageToken: /data-token="([^"]+)"/.exec(pageFive.text)[1], result: "REJECTED" }))).text);
    assert.equal(rejectBegin.options.userVerification, "required");
    const forged = await post("/api/complete", { nonce: rejectBegin.nonce, response: { verified: true, result: "APPROVED" } });
    assert.equal(forged.status, 409);
    assert.equal(await decisionLedger(fixture), null);
    const pageSix = await request("GET", reviewPath);
    const approveBegin = JSON.parse((await post("/api/begin", beginBody({ pageToken: /data-token="([^"]+)"/.exec(pageSix.text)[1], result: "REJECTED" }))).text);
    const done = await post("/api/complete", { nonce: approveBegin.nonce, response: auth.assert(approveBegin.options) });
    assert.equal(done.status, 200, done.text);
    assert.equal(JSON.parse(done.text).projection, "REJECTED");
    const [line] = await ledgerLines(fixture);
    assert.equal(JSON.parse(line).result, "REJECTED");
    assert.equal(JSON.parse(line).principal, "HUMAN_ATTESTED");
    store.db.close();
  } finally {
    await companion?.close();
    process.exitCode = 0;
    await fixture.cleanup();
    await rm(tlsDirectory, { recursive: true, force: true });
    await rm(storeDirectory, { recursive: true, force: true });
  }
  // Signer down: nothing listens, and the CLI path still reports SIGNER_UNAVAILABLE.
  await assert.rejects(new Promise((resolve, reject) => https.get({ host: "127.0.0.1", port, rejectUnauthorized: false }, resolve).on("error", reject)), /ECONNREFUSED/);
});

test("provider, TTY and MCP surfaces cannot attest, even beside an active protected verifier", async () => {
  await withRecord(EXCLUDED_CLASSIFICATION, async ({ fixture, target, signer }) => {
    const [candidate] = (await pendingDecisionCandidates(target)).candidates;
    const previousCwd = process.cwd();
    process.chdir(fixture.root);
    try {
      for (const ask of [() => "accept", () => "yes", () => ({ verified: true, principal: "HUMAN_ATTESTED" })]) {
        const result = await inScope(signer, () => runRecordDecisionCli(["auth", "--approve", candidate.id], {
          stdout: { isTTY: true, write: () => true }, ask,
        }));
        assert.equal(result.blocked.state, "SIGNER_UNAVAILABLE");
      }
      await assert.rejects(runRecordDecisionCli(["auth", "--approve", candidate.id, "--principal", "HUMAN_ATTESTED"]), /Unknown option/);
      await assert.rejects(runRecordDecisionCli(["auth", "--approve", candidate.id, "--webauthn", "{}"]), /Unknown option/);
    } finally { process.chdir(previousCwd); }
    assert.equal(await decisionLedger(fixture), null);
    for (const file of ["mcp-server.mjs", "operator-approval.mjs", "cli/run-migration.mjs", "cli/advance-migration.mjs"]) {
      const source = await readFile(path.join(SRC, file), "utf8");
      assert.doesNotMatch(source, /operator-signer|completeAttestedDecision|beginAttestedDecision|beginEnrollment/, file);
    }
    const engineManifest = JSON.parse(await readFile(path.join(SRC, "../package.json"), "utf8"));
    assert.ok(!Object.values(engineManifest.bin).some((bin) => /operator-signer|webauthn/.test(bin)));
  });
});

const companionClient = ({ port, cert, origin }) => {
  let cookie = "";
  const request = (method, url, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const outgoing = https.request({
      host: "127.0.0.1", port, servername: RP_ID, ca: cert, method, path: url, agent: false,
      headers: { host: `${RP_ID}:${port}`, ...(cookie ? { cookie } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
  return {
    request,
    login: async (token) => { cookie = (await request("GET", `/login?token=${token}`)).headers["set-cookie"][0].split(";")[0]; },
    post: (url, body) => request("POST", url, { body, headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" } }),
  };
};

test("companion: enrollment is a separate admin-launched mode; review mode exposes no enrollment", async () => {
  const tlsDirectory = await mkdtemp(path.join(os.tmpdir(), "amt-tls-"));
  const enrollPort = await freePort();
  const origin = `https://${RP_ID}:${enrollPort}`;
  const { newStoreDirectory } = await import("../support/signer-fixture.mjs");
  const { createSoftwareAuthenticator } = await import("../support/software-authenticator.mjs");
  const directory = await newStoreDirectory();
  const companions = [];
  try {
    const tls = await selfSignedTls(tlsDirectory);
    const store = await openSignerStore({ directory, origin, rpID: RP_ID });
    const signer = createOperatorSigner(store);
    const token = "e".repeat(43);
    companions.push(await startReviewCompanion({ signer, engine: {}, tls, port: enrollPort, loginToken: token,
      enrollment: { operator: "operator-b", actor: "admin-b", reason: "new security key" } }));
    const admin = companionClient({ port: enrollPort, cert: tls.cert, origin });
    assert.equal((await admin.post("/api/enroll/begin", {})).status, 401);
    await admin.login(token);
    assert.equal((await admin.request("GET", "/review?target=x&candidate=y")).status, 404);
    const page = await admin.request("GET", "/enroll");
    assert.equal(page.status, 200);
    assert.match(page.text, /operator-b/);
    const options = JSON.parse((await admin.post("/api/enroll/begin", {})).text);
    assert.deepEqual(options.pubKeyCredParams.map((entry) => entry.alg), [-7]);
    assert.equal(options.authenticatorSelection.userVerification, "required");
    const auth = createSoftwareAuthenticator({ origin, rpID: RP_ID });
    const finished = await admin.post("/api/enroll/finish", { challenge: options.challenge, response: auth.register(options) });
    assert.equal(finished.status, 200, finished.text);
    assert.deepEqual(signer.activeCredentialIds(), [auth.id]);

    // A review-mode companion on the same store has no enrollment surface,
    // and never listens anywhere but its configured origin's port.
    await companions.pop().close();
    await assert.rejects(startReviewCompanion({ signer, engine: {}, tls, port: enrollPort + 1, loginToken: token }), /INVALID_SIGNER_CONFIG/);
    companions.push(await startReviewCompanion({ signer, engine: {}, tls, port: enrollPort, loginToken: token, targets: {} }));
    const operator = companionClient({ port: enrollPort, cert: tls.cert, origin });
    await operator.login(token);
    assert.equal((await operator.request("GET", "/enroll")).status, 404);
    assert.equal((await operator.post("/api/enroll/begin", {})).status, 404);
    store.db.close();
  } finally {
    for (const companion of companions) await companion.close();
    await rm(tlsDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
  // The protected service entry refuses to start without its root-owned configuration
  // and, in this build, would refuse to serve decisions even with one.
  const { runSignerService } = await import("../../src/operator-signer-service.mjs");
  await assert.rejects(runSignerService(["serve"]), /SIGNER_UNAVAILABLE|UNSUPPORTED_HOST/);
  await assert.rejects(runSignerService(["enroll", "x", "y", "z"]), /SIGNER_UNAVAILABLE|UNSUPPORTED_HOST/);
});
