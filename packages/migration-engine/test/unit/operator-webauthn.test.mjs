import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ASSERTION_PROTOCOL,
  MAX_CHALLENGE_LIFETIME_MS,
  assertionChallenge,
  assertionPayload,
  parseAssertionPayload,
  proofFromResponse,
  proofProblem,
} from "../../src/operator-webauthn.mjs";
import {
  PRODUCTION_ATTESTED_WRITES,
  checkSignerActivation,
  createOperatorSigner,
  inertHtml,
  openSignerStore,
  readSignerActivation,
} from "../../src/operator-signer.mjs";
import { createSoftwareAuthenticator } from "../support/software-authenticator.mjs";
import { enrolledSigner, newStoreDirectory, ORIGIN, RP_ID } from "../support/signer-fixture.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const D = (seed) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const NONCE = "A".repeat(43);

const binding = (overrides = {}) => ({
  protocol: ASSERTION_PROTOCOL,
  recordKind: "module",
  record: { migrationId: "MIG-1", module: "auth" },
  projectRoot: "/work/target",
  lifecycleDigest: D("1"),
  candidateDigest: D("c"),
  result: "APPROVED",
  requiredPrincipal: "HUMAN_ATTESTED",
  policyId: "engine/judgment/v1",
  policyDigest: D("e"),
  groupMembersDigest: null,
  groupMemberCount: 0,
  ...overrides,
});
const full = (overrides = {}) => ({ ...binding(), nonce: NONCE, issuedAtMs: 1000, expiresAtMs: 121000, ...overrides });

test("protocol: exact payload bytes and challenge vector are pinned", () => {
  const payload = assertionPayload(full());
  assert.equal(payload,
    `{"protocol":"amt.operator-decision.webauthn.assertion.v1","recordKind":"module","record":{"migrationId":"MIG-1","module":"auth"},` +
    `"projectRoot":"/work/target","lifecycleDigest":"${D("1")}","candidateDigest":"${D("c")}","result":"APPROVED",` +
    `"requiredPrincipal":"HUMAN_ATTESTED","policyId":"engine/judgment/v1","policyDigest":"${D("e")}","groupMembersDigest":null,` +
    `"groupMemberCount":0,"nonce":"${NONCE}","issuedAtMs":1000,"expiresAtMs":121000}`);
  assert.equal(assertionChallenge(payload), "jNfzLgeB7eOtvWmWJHwO7ydyyu20idmjEjIEkgkKSjI");
  assert.equal(assertionChallenge(payload), createHash("sha256")
    .update(`artifact-migration-tools/operator-decision/webauthn/assertion/v1\n${payload}`).digest("base64url"));
  const artifact = assertionPayload(full({ recordKind: "artifact",
    record: { artifactId: "ART-1", artifactType: "artifact", sourceRoot: "/legacy", sourcePath: "src/a.js" } }));
  assert.match(artifact, /"recordKind":"artifact","record":\{"artifactId":"ART-1","artifactType":"artifact","sourceRoot":"\/legacy","sourcePath":"src\/a.js"\}/);
  assert.deepEqual(parseAssertionPayload(payload), JSON.parse(payload));
  assert.throws(() => parseAssertionPayload(JSON.stringify({ ...JSON.parse(payload), extra: 1 })), /canonical/);
  const reordered = JSON.parse(payload);
  assert.throws(() => parseAssertionPayload(JSON.stringify({ recordKind: reordered.recordKind, ...reordered })), /canonical/);
});

test("protocol: every binding changes the challenge, and module/artifact are domain-separated", () => {
  const variants = [
    full(),
    full({ result: "REJECTED" }),
    full({ candidateDigest: D("d") }),
    full({ policyId: "admin/v2" }),
    full({ policyDigest: D("f") }),
    full({ lifecycleDigest: D("2") }),
    full({ record: { migrationId: "MIG-2", module: "auth" } }),
    full({ record: { migrationId: "MIG-1", module: "billing" } }),
    full({ projectRoot: "/work/other" }),
    full({ groupMembersDigest: D("a"), groupMemberCount: 2 }),
    full({ groupMembersDigest: D("a"), groupMemberCount: 3 }),
    full({ groupMembersDigest: D("7"), groupMemberCount: 2 }),
    full({ nonce: Buffer.alloc(32, 1).toString("base64url") }),
    full({ expiresAtMs: 120000 }),
    full({ issuedAtMs: 2000 }),
    full({ requiredPrincipal: "AGENT_RELAYED" }),
    full({ recordKind: "artifact", record: { artifactId: "MIG-1", artifactType: "auth", sourceRoot: "/a", sourcePath: "b" } }),
  ];
  const challenges = new Set(variants.map((value) => assertionChallenge(assertionPayload(value))));
  assert.equal(challenges.size, variants.length);
});

test("protocol: malformed, ambiguous or overlong payloads are refused", () => {
  for (const [value, pattern] of [
    [full({ protocol: "amt.operator-decision.webauthn.assertion.v2" }), /unknown protocol/],
    [full({ recordKind: "group" }), /unknown recordKind/],
    [full({ record: { migrationId: "MIG-1", module: "auth", extra: "x" } }), /record identity/],
    [full({ record: { migrationId: "", module: "auth" } }), /record identity/],
    [full({ projectRoot: "relative/root" }), /projectRoot/],
    [full({ candidateDigest: "APP-0123456789abcdef0123" }), /candidateDigest/],
    [full({ result: "approved" }), /unknown result/],
    [full({ groupMembersDigest: D("a"), groupMemberCount: 0 }), /group binding/],
    [full({ groupMembersDigest: null, groupMemberCount: 2 }), /group binding/],
    [full({ recordKind: "artifact", record: { artifactId: "A", artifactType: "t", sourceRoot: "/s", sourcePath: "p" }, groupMembersDigest: D("a"), groupMemberCount: 2 }), /artifact group authority/],
    [full({ nonce: "short" }), /nonce/],
    [full({ expiresAtMs: 1000 + MAX_CHALLENGE_LIFETIME_MS + 1 }), /lifetime/],
    [full({ expiresAtMs: 1000 }), /lifetime/],
  ]) {
    assert.throws(() => assertionPayload(value), pattern);
  }
});

test("webauthn: a valid assertion verifies and every tampered form is refused", async () => {
  const { signer, auth, cleanup } = await enrolledSigner();
  try {
    const ledgerFile = "/work/target/ledger.ndjson";
    const issued = signer.issue({ binding: binding(), ledgerFile });
    const ok = await signer.preverify({ nonce: issued.nonce, response: auth.assert(issued.options), ledgerFile });
    assert.equal(ok.counterAfter, ok.counterBefore + 1);
    assert.equal(ok.operator, "operator-a");
    const stranger = createSoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID });
    stranger.register({ user: { id: "AAAA" }, challenge: "x" });
    for (const [label, response, pattern] of [
      ["invalid signature", auth.assert(issued.options, { badSignature: true }), /did not verify|signature/i],
      ["wrong origin", auth.assert(issued.options, { origin: "https://evil.localhost:44321" }), /origin/],
      ["wrong RP", auth.assert(issued.options, { rpID: "evil.localhost" }), /RP ID/i],
      ["wrong challenge", auth.assert(issued.options, { challenge: "A".repeat(43) }), /challenge/],
      ["unregistered credential", stranger.assert(issued.options), /not enrolled/],
      ["other credential id", auth.assert(issued.options, { id: stranger.id }), /not enrolled/],
      ["missing UP", auth.assert(issued.options, { up: false }), /not present/],
      ["missing UV", auth.assert(issued.options, { uv: false }), /User verification required/],
      ["crossOrigin", auth.assert(issued.options, { crossOrigin: true }), /cross-origin/],
      ["crossOrigin absent", auth.assert(issued.options, { crossOrigin: "omit" }), /cross-origin/],
      ["wrong type", auth.assert(issued.options, { type: "webauthn.create" }), /type/],
      ["wrong userHandle", auth.assert(issued.options, { userHandle: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), /userHandle/],
      ["counter replay", auth.assert(issued.options, { counter: ok.counterAfter - 1 }), /counter/],
      ["malformed", { id: auth.id, rawId: auth.id, type: "public-key", response: { clientDataJSON: "!!", authenticatorData: "", signature: "" } }, /Malformed/],
    ]) {
      await assert.rejects(signer.preverify({ nonce: issued.nonce, response, ledgerFile }), pattern, label);
    }
    const proof = proofFromResponse(auth.assert(issued.options), issued.nonce);
    assert.match(proofProblem({ ...proof, verificationVersion: 2 }), /unknown verificationVersion/);
    assert.match(proofProblem({ ...proof, verified: true }), /missing, extra/);
    signer.setCredentialStatus({ credentialId: auth.id, status: "REVOKED", actor: "admin-a", reason: "compromise" });
    await assert.rejects(signer.preverify({ nonce: issued.nonce, response: auth.assert(issued.options), ledgerFile }), /not active/);
  } finally {
    await cleanup();
  }
});

test("webauthn: only ES256 with UV enrolls, and zero counters need admin acceptance", async () => {
  const directory = await newStoreDirectory();
  const store = await openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID });
  const signer = createOperatorSigner(store);
  try {
    const enroll = async (auth, extra = {}, uv = true) => {
      const options = await signer.beginEnrollment({ operator: "op", actor: "admin", reason: "r" });
      return signer.finishEnrollment({ challenge: options.challenge, response: auth.register(options, { uv }), actor: "admin", ...extra });
    };
    await assert.rejects(enroll(createSoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID, alg: -35, keyType: "P-384" })), /alg/i);
    await assert.rejects(enroll(createSoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID }), {}, false), /verif/i);
    await assert.rejects(enroll(createSoftwareAuthenticator({ origin: "https://evil.localhost:44321", rpID: RP_ID })), /origin/);
    await assert.rejects(signer.beginEnrollment({ operator: "op", actor: "", reason: "r" }), /ENROLLMENT_REFUSED/);
    const counterless = createSoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID, counter: 0 });
    await assert.rejects(enroll(createSoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID, counter: 0 })), /counterless/);
    await enroll(counterless, { allowCounterless: true });
    const ledgerFile = "/work/x.ndjson";
    const issued = signer.issue({ binding: binding(), ledgerFile });
    const zero = await signer.preverify({ nonce: issued.nonce, response: counterless.assert(issued.options, { keepZero: true }), ledgerFile });
    assert.equal(zero.counterAfter, 0);
    const positive = await signer.preverify({ nonce: issued.nonce, response: counterless.assert(issued.options, { counter: 5 }), ledgerFile });
    assert.equal(positive.counterAfter, 5);
    const options = await signer.beginEnrollment({ operator: "op", actor: "admin", reason: "r" });
    const reused = createSoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID, counter: 0 });
    const response = reused.register(options);
    await signer.finishEnrollment({ challenge: options.challenge, response, actor: "admin", allowCounterless: true });
    await assert.rejects(signer.finishEnrollment({ challenge: options.challenge, response, actor: "admin", allowCounterless: true }), /ENROLLMENT_REFUSED/);
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("nonce: single use, concurrent claims, wrong record, expiry, restart durability and no rollback", async () => {
  let clock = 10_000;
  const { directory, signer, auth, store, cleanup } = await enrolledSigner({ now: () => clock });
  try {
    const ledgerFile = "/work/target/a.ndjson";
    const line = (proof) => ({ id: "DEC-001", webauthn: proof });
    const issued = signer.issue({ binding: binding(), ledgerFile });
    assert.throws(() => signer.issued(issued.nonce, "/work/target/other.ndjson"), /WRONG_RECORD/);
    // Two protected connections racing the same nonce: exactly one claim.
    const second = createOperatorSigner(await openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID }), { now: () => clock });
    const response = auth.assert(issued.options);
    const [one, two] = await Promise.all([
      signer.preverify({ nonce: issued.nonce, response, ledgerFile }),
      second.preverify({ nonce: issued.nonce, response, ledgerFile }),
    ]);
    const outcomes = [
      (() => { try { signer.claim({ nonce: issued.nonce, verified: one, line: line(one.proof), ledgerFile }); return "ok"; } catch (error) { return error.code; } })(),
      (() => { try { second.claim({ nonce: issued.nonce, verified: two, line: line(two.proof), ledgerFile }); return "ok"; } catch (error) { return error.code; } })(),
    ];
    assert.deepEqual(outcomes.sort(), ["NONCE_SPENT", "ok"]);
    assert.throws(() => signer.issued(issued.nonce, ledgerFile), /NONCE_SPENT/);
    // CLAIMED without a committed line blocks the record until admin reconciliation.
    assert.throws(() => signer.issue({ binding: binding(), ledgerFile }), /RECONCILIATION_REQUIRED/);
    store.db.close();
    const reopened = createOperatorSigner(await openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID }), { now: () => clock });
    assert.equal(reopened.activeCredentialIds().length, 1);
    assert.throws(() => reopened.issue({ binding: binding(), ledgerFile }), /RECONCILIATION_REQUIRED/);
    assert.equal(await reopened.reconcile({ nonce: issued.nonce, actor: "admin-a", reason: "append never happened" }), "ABANDONED");
    assert.throws(() => reopened.issued(issued.nonce, ledgerFile), /NONCE_SPENT/);
    // Counter persisted across restart: replaying the old assertion's counter fails.
    const next = reopened.issue({ binding: binding(), ledgerFile });
    await assert.rejects(reopened.preverify({ nonce: next.nonce, response: auth.assert(next.options, { counter: one.counterAfter }), ledgerFile }), /counter/);
    clock += MAX_CHALLENGE_LIFETIME_MS + 1;
    assert.throws(() => reopened.issued(next.nonce, ledgerFile), /NONCE_EXPIRED/);
    assert.throws(() => reopened.issued(next.nonce, ledgerFile), /NONCE_SPENT/);
  } finally {
    await cleanup();
  }
});

test("store: protected directory, exact origin/RP and no relaxation on reopen", async () => {
  const directory = await newStoreDirectory();
  try {
    for (const [origin, rpID] of [
      ["http://operator-decision.localhost:44321", RP_ID],
      ["https://operator-decision.localhost:44321/", RP_ID],
      ["https://operator-decision.localhost:44321", "localhost"],
      [[ORIGIN], RP_ID],
    ]) {
      await assert.rejects(openSignerStore({ directory, origin, rpID }), /INVALID_SIGNER_CONFIG/);
    }
    await chmod(directory, 0o755);
    await assert.rejects(openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID }), /UNPROTECTED_SIGNER_STORE/);
    await chmod(directory, 0o700);
    const link = `${directory}-link`;
    await symlink(directory, link);
    await assert.rejects(openSignerStore({ directory: link, origin: ORIGIN, rpID: RP_ID }), /UNPROTECTED_SIGNER_STORE/);
    await rm(link);
    const store = await openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID });
    store.db.close();
    await assert.rejects(openSignerStore({ directory, origin: "https://other.localhost:44321", rpID: "other.localhost" }), /different origin/);
    const empty = createOperatorSigner(await openSignerStore({ directory, origin: ORIGIN, rpID: RP_ID }));
    assert.throws(() => empty.issue({ binding: binding(), ledgerFile: "/x" }), /SIGNER_UNAVAILABLE/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("activation: manifest is read/check only and production writes stay OFF", async () => {
  assert.equal(PRODUCTION_ATTESTED_WRITES, false);
  const manifest = {
    version: 1, signerBuild: { contentHash: D("b") }, protocol: ASSERTION_PROTOCOL, hostProfile: "managed-linux-v1",
    origin: ORIGIN, rpID: RP_ID, registry: { registryId: "reg-1" }, approval: { actor: "security-owner", at: "2026-01-01T00:00:00.000Z", reason: "accepted" },
  };
  const checked = checkSignerActivation(manifest, { build: { contentHash: D("b") }, registryId: "reg-1" });
  assert.deepEqual(checked, { state: "CHECKED", problems: [], writesEnabled: false });
  assert.equal(checkSignerActivation({ ...manifest, writesEnabled: true }, { build: { contentHash: D("b") }, registryId: "reg-1" }).state, "INVALID");
  assert.equal(checkSignerActivation(manifest, { build: { contentHash: D("9") }, registryId: "reg-1" }).state, "INVALID");
  assert.equal(checkSignerActivation({ ...manifest, origin: "http://operator-decision.localhost" }, { build: { contentHash: D("b") }, registryId: "reg-1" }).state, "INVALID");
  process.env.AMT_SIGNER_ACTIVATION = "ON";
  try {
    assert.equal((await readSignerActivation({ build: { contentHash: D("b") }, registryId: "reg-1" })).writesEnabled, false);
  } finally {
    delete process.env.AMT_SIGNER_ACTIVATION;
  }
  // Nothing in the signer, protocol or attested writer reads env or argv.
  for (const file of ["operator-signer.mjs", "operator-webauthn.mjs"]) {
    assert.doesNotMatch(await readFile(path.join(SRC, file), "utf8"), /process\.(env|argv)/, file);
  }
});

test("review text is inert HTML including bidi and control characters", () => {
  const hostile = `<script>alert(1)</script><img src=x onerror=alert(1)>"'&\u202eevil\u2066\x1b[2J`;
  const rendered = inertHtml(hostile);
  assert.doesNotMatch(rendered, /<|>|\u202e|\u2066|\x1b/);
  assert.match(rendered, /&lt;script&gt;/);
  assert.match(rendered, /\\u202e/);
  assert.match(rendered, /&quot;&#39;&amp;/);
});
