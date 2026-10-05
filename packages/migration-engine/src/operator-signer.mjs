/**
 * The protected operator-decision signer service: one credential registry, one
 * durable ISSUED -> CLAIMED -> COMMITTED nonce store and one review companion
 * for every direct-ledger record domain. Runs under a dedicated service UID
 * from an installed release; never reachable from the migration CLI or MCP.
 *
 * Production HUMAN_ATTESTED writes are OFF in this build regardless of any
 * manifest, file, flag or environment (see `PRODUCTION_ATTESTED_WRITES`).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

import { generateRegistrationOptions } from "@simplewebauthn/server";

import {
  ASSERTION_PROTOCOL,
  BINDING_KEYS,
  MAX_CHALLENGE_LIFETIME_MS,
  assertionChallenge,
  assertionPayload,
  base64url,
  groupMembersDigestOf,
  parseAssertionPayload,
  proofFromResponse,
  sha256Digest,
  verifyAssertionProof,
  verifyEnrollment,
} from "./operator-webauthn.mjs";
import { DECISION_GROUP_KIND, decisionLineDigest } from "./resumable-migration.mjs";

// ponytail: hard OFF until the separate gate-3 activation action ships a build
// that flips this after real-host acceptance. No input can override it.
export const PRODUCTION_ATTESTED_WRITES = false;
export const ACTIVATION_MANIFEST_FILE = "/etc/artifact-migration-tools/operator-signer/activation.json";
const STORE_FILE = "signer.sqlite";

const typed = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/** Exact single https origin and its hostname as RP ID; no lists, no HTTP. */
export const assertSignerOrigin = (origin, rpID) => {
  let url;
  try { url = new URL(origin); } catch { throw typed("INVALID_SIGNER_CONFIG", "origin is not a URL"); }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
      typeof rpID !== "string" || rpID !== url.hostname) {
    throw typed("INVALID_SIGNER_CONFIG", "origin must be one exact https origin whose hostname is the RP ID");
  }
};

const assertOwnerOnly = (details, what) => {
  const uid = process.getuid?.();
  if (details.isSymbolicLink() || (uid !== undefined && details.uid !== uid) || (details.mode & 0o077) !== 0) {
    throw typed("UNPROTECTED_SIGNER_STORE", `${what} must be a non-symlink owned by the service user with mode 0700/0600`);
  }
};

/**
 * Open the protected store. node:sqlite (Node >= 22.13) gives UNIQUE nonces,
 * BEGIN IMMEDIATE and synchronous=FULL without a new dependency; an older
 * runtime is SIGNER_UNAVAILABLE, never a JSON fallback.
 */
export const openSignerStore = async ({ directory, origin, rpID }) => {
  assertSignerOrigin(origin, rpID);
  if (!path.isAbsolute(directory ?? "")) throw typed("INVALID_SIGNER_CONFIG", "store directory must be absolute");
  const details = await lstat(directory);
  if (!details.isDirectory()) throw typed("UNPROTECTED_SIGNER_STORE", "store path is not a directory");
  assertOwnerOnly(details, directory);
  const file = path.join(directory, STORE_FILE);
  const existing = await lstat(file).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (existing && (!existing.isFile() || existing.nlink !== 1)) throw typed("UNPROTECTED_SIGNER_STORE", "store file is not a single-link regular file");
  if (existing) assertOwnerOnly(existing, file);
  else await (await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)).close();
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { throw typed("SIGNER_UNAVAILABLE", "this Node runtime has no node:sqlite; the protected store cannot open"); }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, publicKey BLOB NOT NULL, userHandle TEXT NOT NULL,
      operator TEXT NOT NULL, counter INTEGER NOT NULL, counterless INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED','REVOKED')), enrolledAtMs INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollments (challenge TEXT PRIMARY KEY, userHandle TEXT NOT NULL, operator TEXT NOT NULL,
      expiresAtMs INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (nonce TEXT PRIMARY KEY, challenge TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
      ledgerFile TEXT NOT NULL, issuedAtMs INTEGER NOT NULL, expiresAtMs INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ISSUED','CLAIMED','COMMITTED','EXPIRED','CANCELLED','ABANDONED')),
      credentialId TEXT REFERENCES credentials(id), lineDigest TEXT UNIQUE, proofDigest TEXT,
      counterBefore INTEGER, counterAfter INTEGER, claimedAtMs INTEGER, committedAtMs INTEGER);
    CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, atMs INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);`);
  const meta = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  if (meta("registryId") === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('registryId', ?), ('origin', ?), ('rpID', ?)")
      .run(base64url(randomBytes(16)), origin, rpID);
  } else if (meta("origin") !== origin || meta("rpID") !== rpID) {
    db.close();
    throw typed("INVALID_SIGNER_CONFIG", "store was enrolled under a different origin/RP ID; re-enroll rather than relax it");
  }
  return { db, origin, rpID, directory, registryId: meta("registryId") };
};

const transaction = (db, run) => {
  db.exec("BEGIN IMMEDIATE");
  try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
};

/** Read a ledger through a no-follow handle; a torn ledger is never parsed. */
const readLedgerNoFollow = async (ledgerFile) => {
  const handle = await open(ledgerFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile("utf8"); } finally { await handle.close(); }
};

/**
 * The signer core over one open store. `now` is injectable for expiry tests.
 * Every method that moves state does so in one BEGIN IMMEDIATE transaction.
 */
export const createOperatorSigner = (store, { now = Date.now } = {}) => {
  const { db, origin, rpID } = store;
  const audit = (action, detail) =>
    db.prepare("INSERT INTO audit (atMs, action, detail) VALUES (?, ?, ?)").run(now(), action, JSON.stringify(detail));
  const credential = (id) => {
    const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id);
    return row && { ...row, publicKey: new Uint8Array(row.publicKey), counterless: row.counterless === 1 };
  };
  const claimOf = (nonce) => db.prepare("SELECT * FROM claims WHERE nonce = ?").get(nonce);

  const signer = {
    origin,
    rpID,
    registryId: store.registryId,
    activeCredentialIds: () => db.prepare("SELECT id FROM credentials WHERE status = 'ACTIVE' ORDER BY id").all().map((row) => row.id),

    /* -- admin: enrollment, retirement, revocation, reconciliation ---------- */
    beginEnrollment: async ({ operator, actor, reason }) => {
      if (![operator, actor, reason].every((value) => typeof value === "string" && value.trim())) {
        throw typed("ENROLLMENT_REFUSED", "operator, admin actor and reason are required");
      }
      const userHandle = base64url(randomBytes(32));
      const options = await generateRegistrationOptions({
        rpName: "Artifact migration operator decisions", rpID, userName: operator,
        userID: Buffer.from(userHandle, "base64url"), challenge: randomBytes(32), timeout: MAX_CHALLENGE_LIFETIME_MS,
        attestationType: "none", supportedAlgorithmIDs: [-7],
        excludeCredentials: db.prepare("SELECT id FROM credentials").all().map(({ id }) => ({ id })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      transaction(db, () => {
        db.prepare("INSERT INTO enrollments (challenge, userHandle, operator, expiresAtMs, status) VALUES (?, ?, ?, ?, 'ISSUED')")
          .run(options.challenge, userHandle, operator, now() + MAX_CHALLENGE_LIFETIME_MS);
        audit("ENROLLMENT_ISSUED", { operator, actor, reason });
      });
      return options;
    },
    finishEnrollment: async ({ challenge, response, allowCounterless = false, actor }) => {
      const pending = db.prepare("SELECT * FROM enrollments WHERE challenge = ?").get(challenge);
      if (!pending || pending.status !== "ISSUED" || now() > pending.expiresAtMs) throw typed("ENROLLMENT_REFUSED", "unknown, used or expired enrollment");
      const verified = await verifyEnrollment({ response, challenge, origin, rpID });
      if (verified.counter === 0 && !allowCounterless) throw typed("ENROLLMENT_REFUSED", "counterless authenticator not admin-accepted");
      transaction(db, () => {
        const used = db.prepare("UPDATE enrollments SET status = 'USED' WHERE challenge = ? AND status = 'ISSUED'").run(challenge);
        if (used.changes !== 1) throw typed("ENROLLMENT_REFUSED", "enrollment already used");
        db.prepare("INSERT INTO credentials (id, publicKey, userHandle, operator, counter, counterless, status, enrolledAtMs) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)")
          .run(verified.id, verified.publicKey, pending.userHandle, pending.operator, verified.counter, verified.counter === 0 ? 1 : 0, now());
        audit("CREDENTIAL_ENROLLED", { credentialId: verified.id, operator: pending.operator, actor, publicKey: sha256Digest(verified.publicKey.toString("base64url")) });
      });
      return { credentialId: verified.id };
    },
    /** RETIRED: no new claims, history still verifies. REVOKED: history stops verifying too. */
    setCredentialStatus: ({ credentialId, status, actor, reason }) => transaction(db, () => {
      if (!["RETIRED", "REVOKED"].includes(status) || !actor || !reason) throw typed("ADMIN_REFUSED", "status, actor and reason are required");
      const changed = db.prepare("UPDATE credentials SET status = ? WHERE id = ? AND status != 'REVOKED'").run(status, credentialId);
      if (changed.changes !== 1) throw typed("ADMIN_REFUSED", "unknown or already revoked credential");
      audit(`CREDENTIAL_${status}`, { credentialId, actor, reason });
    }),
    /**
     * Admin reconciliation of a CLAIMED nonce: COMMITTED only for the exact
     * durable, replay-verified line; ABANDONED (spent forever) when no line
     * exists. A torn ledger is refused, never repaired here.
     */
    reconcile: async ({ nonce, actor, reason }) => {
      const claim = claimOf(nonce);
      if (claim?.status !== "CLAIMED" || !actor || !reason) throw typed("ADMIN_REFUSED", "only a CLAIMED nonce with actor and reason can be reconciled");
      const content = await readLedgerNoFollow(claim.ledgerFile).catch((error) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
      if (content && !content.endsWith("\n")) throw typed("RECONCILIATION_REQUIRED", "ledger ends in a torn line; repair it first");
      const line = content.split("\n").filter(Boolean).map((raw) => JSON.parse(raw))
        .find((entry) => decisionLineDigest(entry) === claim.lineDigest);
      if (line) await signer.verifyDecisionLine(line, claim.ledgerFile, { allowClaimed: true });
      transaction(db, () => {
        db.prepare("UPDATE claims SET status = ?, committedAtMs = ? WHERE nonce = ? AND status = 'CLAIMED'")
          .run(line ? "COMMITTED" : "ABANDONED", line ? now() : null, nonce);
        audit(line ? "CLAIM_RECONCILED_COMMITTED" : "CLAIM_ABANDONED", { nonce, actor, reason });
      });
      return line ? "COMMITTED" : "ABANDONED";
    },

    /* -- decision ceremony ------------------------------------------------ */
    /** Persist ISSUED before any challenge leaves the service. */
    issue: ({ binding, ledgerFile }) => {
      const ledger = path.resolve(ledgerFile);
      return transaction(db, () => {
        if (db.prepare("SELECT 1 FROM claims WHERE ledgerFile = ? AND status = 'CLAIMED'").get(ledger)) {
          throw typed("RECONCILIATION_REQUIRED", "a spent claim on this record has no committed line; an admin must reconcile it first");
        }
        const allowCredentials = signer.activeCredentialIds();
        if (allowCredentials.length === 0) throw typed("SIGNER_UNAVAILABLE", "no active enrolled operator credential");
        const issuedAtMs = now();
        const payload = assertionPayload({ ...binding, nonce: base64url(randomBytes(32)), issuedAtMs, expiresAtMs: issuedAtMs + MAX_CHALLENGE_LIFETIME_MS });
        const fields = JSON.parse(payload);
        const challenge = assertionChallenge(payload);
        db.prepare("INSERT INTO claims (nonce, challenge, payload, ledgerFile, issuedAtMs, expiresAtMs, status) VALUES (?, ?, ?, ?, ?, ?, 'ISSUED')")
          .run(fields.nonce, challenge, payload, ledger, issuedAtMs, fields.expiresAtMs);
        audit("CHALLENGE_ISSUED", { nonce: fields.nonce, ledgerFile: ledger, candidateDigest: fields.candidateDigest, result: fields.result });
        return {
          nonce: fields.nonce, payload, binding: fields,
          options: { challenge, rpId: rpID, timeout: MAX_CHALLENGE_LIFETIME_MS, userVerification: "required",
            allowCredentials: allowCredentials.map((id) => ({ id, type: "public-key" })) },
        };
      });
    },
    /** The exact issued payload, only while ISSUED and unexpired. */
    issued: (nonce, ledgerFile) => {
      const claim = claimOf(nonce);
      if (!claim || claim.status !== "ISSUED") throw typed("NONCE_SPENT", "nonce is unknown or no longer ISSUED");
      if (now() > claim.expiresAtMs) {
        transaction(db, () => {
          db.prepare("UPDATE claims SET status = 'EXPIRED' WHERE nonce = ? AND status = 'ISSUED'").run(nonce);
          audit("CHALLENGE_EXPIRED", { nonce });
        });
        throw typed("NONCE_EXPIRED", "challenge expired; start a new review");
      }
      if (claim.ledgerFile !== path.resolve(ledgerFile)) throw typed("WRONG_RECORD", "nonce was issued for another record");
      return parseAssertionPayload(claim.payload);
    },
    cancel: (nonce) => transaction(db, () => {
      db.prepare("UPDATE claims SET status = 'CANCELLED' WHERE nonce = ? AND status = 'ISSUED'").run(nonce);
      audit("CHALLENGE_CANCELLED", { nonce });
    }),
    /** Verify a browser assertion against the issued challenge; mutates nothing. */
    preverify: async ({ nonce, response, ledgerFile }) => {
      signer.issued(nonce, ledgerFile);
      const claim = claimOf(nonce);
      const proof = proofFromResponse(response, nonce);
      const registered = credential(proof.credentialId);
      if (!registered || registered.status !== "ACTIVE") throw typed("CREDENTIAL_REFUSED", "credential is not enrolled or not active");
      const { newCounter } = await verifyAssertionProof({ proof, challenge: claim.challenge, origin, rpID, credential: registered });
      return { proof, operator: registered.operator, counterBefore: registered.counter, counterAfter: newCounter };
    },
    /**
     * Spend the nonce and advance the counter in one transaction, bound to the
     * exact tentative line digest. Never rolled back after this returns.
     */
    claim: ({ nonce, verified, line, ledgerFile }) => transaction(db, () => {
      const claim = claimOf(nonce);
      if (claim?.status !== "ISSUED") throw typed("NONCE_SPENT", "nonce already claimed or closed");
      if (now() > claim.expiresAtMs) throw typed("NONCE_EXPIRED", "challenge expired before claim");
      if (claim.ledgerFile !== path.resolve(ledgerFile)) throw typed("WRONG_RECORD", "nonce was issued for another record");
      if (line.webauthn !== verified.proof && JSON.stringify(line.webauthn) !== JSON.stringify(verified.proof)) {
        throw typed("PROOF_MISMATCH", "line does not carry the verified proof");
      }
      const advanced = db.prepare("UPDATE credentials SET counter = ? WHERE id = ? AND counter = ? AND status = 'ACTIVE'")
        .run(verified.counterAfter, verified.proof.credentialId, verified.counterBefore);
      if (advanced.changes !== 1) throw typed("COUNTER_RACE", "credential state changed during verification");
      db.prepare(`UPDATE claims SET status = 'CLAIMED', credentialId = ?, lineDigest = ?, proofDigest = ?,
        counterBefore = ?, counterAfter = ?, claimedAtMs = ? WHERE nonce = ? AND status = 'ISSUED'`)
        .run(verified.proof.credentialId, decisionLineDigest(line), sha256Digest(verified.proof),
          verified.counterBefore, verified.counterAfter, now(), nonce);
      audit("NONCE_CLAIMED", { nonce, lineDigest: decisionLineDigest(line), counterBefore: verified.counterBefore, counterAfter: verified.counterAfter });
    }),
    /** COMMITTED only after rereading the exact durable line and replay-verifying it. */
    commit: async ({ nonce, ledgerFile }) => {
      const claim = claimOf(nonce);
      if (claim?.status !== "CLAIMED" || claim.ledgerFile !== path.resolve(ledgerFile)) throw typed("NOT_CLAIMED", "no matching CLAIMED nonce");
      const content = await readLedgerNoFollow(claim.ledgerFile);
      if (!content.endsWith("\n")) throw typed("RECONCILIATION_REQUIRED", "ledger ends in a torn line");
      const lines = content.split("\n").filter(Boolean);
      const matches = lines.filter((raw) => { try { return decisionLineDigest(JSON.parse(raw)) === claim.lineDigest; } catch { return false; } });
      if (matches.length !== 1 || matches[0] !== lines.at(-1) || JSON.stringify(JSON.parse(matches[0])) !== matches[0]) {
        throw typed("RECONCILIATION_REQUIRED", "the exact claimed line is not the single durable ledger head");
      }
      await signer.verifyDecisionLine(JSON.parse(matches[0]), claim.ledgerFile, { allowClaimed: true });
      transaction(db, () => {
        const done = db.prepare("UPDATE claims SET status = 'COMMITTED', committedAtMs = ? WHERE nonce = ? AND status = 'CLAIMED'").run(now(), nonce);
        if (done.changes !== 1) throw typed("NOT_CLAIMED", "claim changed during commit");
        audit("CLAIM_COMMITTED", { nonce, lineDigest: claim.lineDigest });
      });
    },

    /**
     * Independent replay verification of one HUMAN_ATTESTED ledger line: the
     * protected COMMITTED claim, its canonical payload and challenge, the
     * line's own bindings, the registered key and the historic counter.
     */
    verifyDecisionLine: async (line, ledgerFile, { allowClaimed = false } = {}) => {
      const nonce = line?.webauthn?.nonce;
      const claim = typeof nonce === "string" ? claimOf(nonce) : undefined;
      if (!claim) throw typed("ATTESTATION_UNVERIFIED", "no protected claim exists for this proof");
      if (claim.status !== "COMMITTED" && !(allowClaimed && claim.status === "CLAIMED")) {
        throw typed(claim.status === "CLAIMED" ? "RECONCILIATION_REQUIRED" : "ATTESTATION_UNVERIFIED", `protected claim is ${claim.status}, not COMMITTED`);
      }
      if (claim.ledgerFile !== path.resolve(ledgerFile)) throw typed("ATTESTATION_UNVERIFIED", "claim belongs to another record ledger");
      if (claim.lineDigest !== decisionLineDigest(line)) throw typed("ATTESTATION_UNVERIFIED", "line digest does not match the protected claim");
      if (claim.proofDigest !== sha256Digest(line.webauthn) || claim.credentialId !== line.webauthn.credentialId) {
        throw typed("ATTESTATION_UNVERIFIED", "proof does not match the protected claim");
      }
      const payload = parseAssertionPayload(claim.payload);
      if (payload.protocol !== ASSERTION_PROTOCOL || assertionChallenge(claim.payload) !== claim.challenge || payload.nonce !== nonce) {
        throw typed("ATTESTATION_UNVERIFIED", "stored challenge does not derive from its payload");
      }
      const group = line.kind === DECISION_GROUP_KIND;
      if (line.principal !== "HUMAN_ATTESTED" || line.result !== payload.result ||
          line.candidateDigest !== payload.candidateDigest || line.policyId !== payload.policyId ||
          line.policyDigest !== payload.policyDigest ||
          (group ? payload.recordKind !== "module" || payload.groupMembersDigest !== groupMembersDigestOf(line.boundTo?.members) ||
            payload.groupMemberCount !== line.boundTo.members.length
            : payload.groupMembersDigest !== null || payload.groupMemberCount !== 0) ||
          (payload.recordKind === "module" && line.boundTo?.module !== payload.record.module)) {
        throw typed("ATTESTATION_UNVERIFIED", "line bindings differ from the signed payload");
      }
      const registered = credential(claim.credentialId);
      if (!registered || registered.status === "REVOKED") throw typed("ATTESTATION_UNVERIFIED", "credential is unknown or revoked");
      const { newCounter } = await verifyAssertionProof({
        proof: line.webauthn, challenge: claim.challenge, origin, rpID,
        credential: { ...registered, counter: claim.counterBefore },
      });
      if (newCounter !== claim.counterAfter) throw typed("ATTESTATION_UNVERIFIED", "historic counter transition does not match");
      return payload;
    },
  };
  return signer;
};

/* -- activation manifest: read/check only ---------------------------------- */

const ACTIVATION_KEYS = ["version", "signerBuild", "protocol", "hostProfile", "origin", "rpID", "registry", "approval"];

/** Validate an activation manifest's contents; activation itself stays OFF. */
export const checkSignerActivation = (document, { build, registryId } = {}) => {
  const problems = [];
  if (!document || typeof document !== "object" || Object.keys(document).sort().join() !== [...ACTIVATION_KEYS].sort().join()) problems.push("manifest fields are missing or extra");
  else {
    if (document.version !== 1) problems.push("unknown manifest version");
    if (document.protocol !== ASSERTION_PROTOCOL) problems.push("protocol mismatch");
    if (!/^sha256:[0-9a-f]{64}$/.test(document.signerBuild?.contentHash ?? "") || document.signerBuild.contentHash !== build?.contentHash) problems.push("signer build identity does not match the installed build");
    if (typeof document.hostProfile !== "string" || !document.hostProfile) problems.push("no accepted host profile");
    try { assertSignerOrigin(document.origin, document.rpID); } catch { problems.push("origin/RP ID invalid"); }
    if (typeof document.registry?.registryId !== "string" || document.registry.registryId !== registryId) problems.push("credential registry identity mismatch");
    if (!document.approval?.actor || !document.approval?.at || !document.approval?.reason) problems.push("approval metadata missing");
  }
  return {
    state: problems.length ? "INVALID" : "CHECKED",
    problems,
    writesEnabled: PRODUCTION_ATTESTED_WRITES && problems.length === 0,
  };
};

/**
 * Read one fixed root-owned, non-group/world-writable JSON file through a
 * no-follow handle with root-owned ancestors. `null` when absent.
 */
export const readRootOwnedJson = async (file) => {
  if (process.platform !== "linux") throw typed("UNSUPPORTED_HOST", "protected signer configuration exists only on managed Linux");
  let handle;
  try { handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022)) throw typed("UNTRUSTED_CONFIG", `untrusted ${directory}`);
      if (directory === path.dirname(directory)) break;
    }
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== 0 || (details.mode & 0o022)) throw typed("UNTRUSTED_CONFIG", `untrusted ownership of ${file}`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
};

/** The fixed root-owned manifest; any doubt is OFF. No path, env or flag selects another. */
export const readSignerActivation = async (expected) => {
  try {
    const document = await readRootOwnedJson(ACTIVATION_MANIFEST_FILE);
    if (document === null) return { state: "OFF", problems: ["no protected activation manifest"], writesEnabled: false };
    return checkSignerActivation(document, expected);
  } catch (error) {
    return { state: process.platform === "linux" ? "INVALID" : "OFF", problems: [error.message], writesEnabled: false };
  }
};

/* -- review companion ----------------------------------------------------- */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// Control and bidi characters become visible escapes before HTML escaping.
export const inertHtml = (value) => String(value)
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
  .replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
};

// Served same-origin; reads only data attributes and writes only textContent.
const APP_JS = `"use strict";
const main = document.getElementById("review");
const status = document.getElementById("status");
const b = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const s = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const post = async (url, body) => {
  const reply = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await reply.json();
  if (!reply.ok) throw new Error(json.error || "refused");
  return json;
};
const decide = async (result) => {
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  document.getElementById("chosen").textContent = result;
  let nonce = null;
  try {
    const begun = await post("/api/begin", { target: main.dataset.target, candidate: main.dataset.candidate, candidateDigest: main.dataset.digest, pageToken: main.dataset.token, result });
    nonce = begun.nonce;
    const options = begun.options;
    const credential = await navigator.credentials.get({ publicKey: { challenge: b(options.challenge), rpId: options.rpId, timeout: options.timeout,
      userVerification: "required", allowCredentials: options.allowCredentials.map((entry) => ({ type: "public-key", id: b(entry.id) })) } });
    const done = await post("/api/complete", { nonce, response: { id: credential.id, rawId: s(credential.rawId), type: credential.type,
      response: { clientDataJSON: s(credential.response.clientDataJSON), authenticatorData: s(credential.response.authenticatorData),
        signature: s(credential.response.signature), userHandle: credential.response.userHandle ? s(credential.response.userHandle) : null } } });
    status.textContent = "Recorded " + done.decisionId + " (" + result + "). Projection: " + done.projection;
  } catch (error) {
    if (nonce) await post("/api/cancel", { nonce }).catch(() => {});
    status.textContent = "Nothing was recorded: " + error.message;
  }
};
document.getElementById("approve").addEventListener("click", () => decide("APPROVED"));
document.getElementById("reject").addEventListener("click", () => decide("REJECTED"));
`;

// Admin enrollment ceremony only; served only by a companion started in enroll mode.
const ENROLL_JS = `"use strict";
const b = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const s = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const post = async (url, body) => {
  const reply = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await reply.json();
  if (!reply.ok) throw new Error(json.error || "refused");
  return json;
};
document.getElementById("enroll").addEventListener("click", async () => {
  const status = document.getElementById("status");
  try {
    const options = await post("/api/enroll/begin", {});
    const credential = await navigator.credentials.create({ publicKey: { ...options, challenge: b(options.challenge),
      user: { ...options.user, id: b(options.user.id) }, excludeCredentials: options.excludeCredentials.map((entry) => ({ ...entry, id: b(entry.id) })) } });
    const done = await post("/api/enroll/finish", { challenge: options.challenge, response: { id: credential.id, rawId: s(credential.rawId), type: credential.type,
      response: { clientDataJSON: s(credential.response.clientDataJSON), attestationObject: s(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : [] }, clientExtensionResults: {} } });
    status.textContent = "Enrolled credential " + done.credentialId;
  } catch (error) {
    status.textContent = "Nothing was enrolled: " + error.message;
  }
});
`;

const SESSION_MS = 10 * 60_000;
const BODY_LIMIT = 64 * 1024;

/**
 * Start the loopback HTTPS review companion. `engine` supplies the shared
 * engine-owned review/begin/complete operations; `targets` is the protected
 * service configuration of record locators. A URL is a locator only: every
 * request re-derives the candidate, and the browser returns raw proof only.
 * With `enrollment` (admin-launched only) it serves enrollment and nothing else.
 */
export const startReviewCompanion = async ({ signer, engine, tls, port, targets = {}, loginToken, enrollment = null }) => {
  const { origin } = signer;
  const host = new URL(origin).host;
  if (Number(new URL(origin).port || 443) !== port) throw typed("INVALID_SIGNER_CONFIG", "listen port must be the configured origin's port");
  if (!tls?.key || !tls?.cert) throw typed("INVALID_TLS", "a protected TLS key and certificate are required; there is no HTTP fallback");
  if (typeof loginToken !== "string" || loginToken.length < 32) throw typed("INVALID_SIGNER_CONFIG", "a one-time operator login token is required");
  let server;
  try { server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }); }
  catch (error) { throw typed("INVALID_TLS", error.message); }
  const sessions = new Map();
  let unusedLogin = Buffer.from(loginToken);

  const send = (response, status, body, type = "application/json") => {
    response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": `${type}; charset=utf-8` });
    response.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const sessionOf = (request) => {
    const id = /(?:^|;\s*)amt_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
    const session = id && sessions.get(id);
    if (!session || Date.now() > session.expiresAtMs) return null;
    return session;
  };
  const readBody = (request) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    request.on("data", (chunk) => { size += chunk.length; if (size > BODY_LIMIT) { reject(typed("BAD_REQUEST", "body too large")); request.destroy(); } else chunks.push(chunk); });
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(typed("BAD_REQUEST", "body is not JSON")); } });
    request.on("error", reject);
  });
  const targetOf = (key) => (typeof key === "string" && Object.hasOwn(targets, key) ? targets[key] : null);

  const reviewPage = async (session, key, candidateId) => {
    const target = targetOf(key);
    if (!target) throw typed("UNKNOWN_TARGET", "this companion does not serve that record");
    const { candidate, review, record } = await engine.review({ signer, target, candidateId });
    const token = base64url(randomBytes(32));
    session.pages.set(token, { key, candidateId, candidateDigest: review.candidateDigest });
    const field = (label, value) => `<dt>${inertHtml(label)}</dt><dd>${inertHtml(value)}</dd>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operator decision review</title></head><body>
<main id="review" data-target="${inertHtml(key)}" data-candidate="${inertHtml(candidate.id)}" data-digest="${inertHtml(review.candidateDigest)}" data-token="${token}">
<h1>Operator decision review</h1>
<p>Trusted origin: <strong>${inertHtml(origin)}</strong></p>
<dl>${field("Record kind", target.recordKind)}${Object.entries(record).map(([name, value]) => field(name, value)).join("")}
${field("Candidate digest", review.candidateDigest)}${field("Required principal", review.policy.requiredPrincipal)}
${field("Policy", `${review.policy.policyId} ${review.policy.policyDigest}`)}${field("Kind", review.kind)}
${review.members.length ? field("Group members", `${review.members.length} ordered members`) : ""}</dl>
<pre>${inertHtml(engine.renderReview(review))}</pre>
<p>Chosen result: <strong id="chosen">none</strong></p>
<button id="approve" type="button">Approve</button> <button id="reject" type="button">Reject</button>
<p id="status" role="status"></p></main><script src="/app.js"></script></body></html>`;
  };

  server.on("request", async (request, response) => {
    try {
      if (request.headers.host !== host) return send(response, 421, { error: "WRONG_HOST" });
      const url = new URL(request.url, origin);
      const site = request.headers["sec-fetch-site"];
      if (request.method === "GET") {
        if (site !== undefined && !["none", "same-origin"].includes(site)) return send(response, 403, { error: "CROSS_SITE" });
        if (url.pathname === "/app.js") return send(response, 200, enrollment ? ENROLL_JS : APP_JS, "text/javascript");
        if (url.pathname === "/login") {
          const offered = Buffer.from(url.searchParams.get("token") ?? "");
          if (!unusedLogin || offered.length !== unusedLogin.length || !timingSafeEqual(offered, unusedLogin)) return send(response, 403, { error: "LOGIN_REFUSED" });
          unusedLogin = null;
          const id = base64url(randomBytes(32));
          sessions.set(id, { expiresAtMs: Date.now() + SESSION_MS, pages: new Map(), pending: null });
          response.writeHead(303, { ...SECURITY_HEADERS, Location: "/", "Set-Cookie": `amt_session=${id}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
          return response.end();
        }
        const session = sessionOf(request);
        if (!session) return send(response, 401, { error: "NO_OPERATOR_SESSION" });
        if (enrollment) {
          if (url.pathname !== "/enroll") return send(response, 404, { error: "NOT_FOUND" });
          return send(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operator credential enrollment</title></head><body><main>
<h1>Operator credential enrollment</h1><p>Origin: <strong>${inertHtml(origin)}</strong></p><p>Operator: <strong>${inertHtml(enrollment.operator)}</strong></p>
<button id="enroll" type="button">Enroll security key</button><p id="status" role="status"></p></main><script src="/app.js"></script></body></html>`, "text/html");
        }
        if (url.pathname === "/review") {
          return send(response, 200, await reviewPage(session, url.searchParams.get("target"), url.searchParams.get("candidate")), "text/html");
        }
        return send(response, 404, { error: "NOT_FOUND" });
      }
      if (request.method !== "POST") return send(response, 405, { error: "METHOD" });
      const session = sessionOf(request);
      if (!session) return send(response, 401, { error: "NO_OPERATOR_SESSION" });
      if (request.headers.origin !== origin || site !== "same-origin" ||
          !String(request.headers["content-type"] ?? "").startsWith("application/json")) {
        return send(response, 403, { error: "CSRF_REFUSED" });
      }
      const body = await readBody(request);
      if (enrollment) {
        if (url.pathname === "/api/enroll/begin") return send(response, 200, await signer.beginEnrollment(enrollment));
        if (url.pathname === "/api/enroll/finish") {
          return send(response, 200, await signer.finishEnrollment({ challenge: body.challenge, response: body.response,
            actor: enrollment.actor, allowCounterless: enrollment.allowCounterless === true }));
        }
        return send(response, 404, { error: "NOT_FOUND" });
      }
      if (url.pathname === "/api/begin") {
        const page = session.pages.get(body.pageToken);
        if (!page || page.key !== body.target || page.candidateId !== body.candidate || page.candidateDigest !== body.candidateDigest) {
          return send(response, 409, { error: "STALE_REVIEW" });
        }
        if (!["APPROVED", "REJECTED"].includes(body.result)) return send(response, 400, { error: "BAD_RESULT" });
        if (session.pending) signer.cancel(session.pending.nonce);
        const begun = await engine.begin({ signer, target: targetOf(page.key), candidateId: page.candidateId, result: body.result, expectedDigest: page.candidateDigest });
        session.pages.delete(body.pageToken);
        session.pending = { nonce: begun.nonce, key: page.key, candidateId: page.candidateId };
        return send(response, 200, { nonce: begun.nonce, options: begun.options });
      }
      if (url.pathname === "/api/complete") {
        const pending = session.pending;
        if (!pending || pending.nonce !== body.nonce) return send(response, 409, { error: "NO_PENDING_DECISION" });
        session.pending = null;
        const done = await engine.complete({ signer, target: targetOf(pending.key), candidateId: pending.candidateId, nonce: body.nonce, response: body.response });
        return send(response, 200, { decisionId: done.decision.id, projection: done.projection?.state ?? null });
      }
      if (url.pathname === "/api/cancel") {
        if (session.pending?.nonce === body.nonce) { signer.cancel(body.nonce); session.pending = null; }
        return send(response, 200, { cancelled: true });
      }
      return send(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (!response.headersSent) send(response, 409, { error: error.code ?? "REFUSED", message: String(error.message).slice(0, 300) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(error.code === "EADDRINUSE" ? typed("PORT_IN_USE", `port ${port} is taken; the companion never moves to another port`) : error));
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
};
