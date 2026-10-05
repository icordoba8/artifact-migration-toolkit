/**
 * The one operator-decision WebAuthn protocol, for every direct-ledger record
 * domain (module format 19, artifact format 14). Pure: no store, no network.
 *
 * The signed payload is fixed-order JSON with a domain-separated record block;
 * the challenge is SHA-256 over a protocol prefix and those exact bytes. All
 * CBOR/COSE/authenticatorData parsing and signature checking is delegated to
 * the pinned `@simplewebauthn/server` release, never reimplemented here.
 */
import { createHash } from "node:crypto";

import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeClientDataJSON, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";

export const ASSERTION_PROTOCOL = "amt.operator-decision.webauthn.assertion.v1";
const CHALLENGE_DOMAIN = "artifact-migration-tools/operator-decision/webauthn/assertion/v1\n";
export const VERIFICATION_VERSION = 1;
export const MAX_CHALLENGE_LIFETIME_MS = 120_000;
export const COSE_ES256 = -7;
// Artifact 14 direct-ledger judgments only: no group, no EXCEPTION_RECORDED.
export const ATTESTED_ARTIFACT_KINDS = Object.freeze(["ARTIFACT_DECISION", "VISUAL_UNBACKED"]);

const RECORD_KEYS = Object.freeze({
  module: ["migrationId", "module"],
  artifact: ["artifactId", "artifactType", "sourceRoot", "sourcePath"],
});
const PAYLOAD_KEYS = [
  "protocol", "recordKind", "record", "projectRoot", "lifecycleDigest", "candidateDigest",
  "result", "requiredPrincipal", "policyId", "policyDigest", "groupMembersDigest",
  "groupMemberCount", "nonce", "issuedAtMs", "expiresAtMs",
];
export const BINDING_KEYS = PAYLOAD_KEYS.filter((key) => !["nonce", "issuedAtMs", "expiresAtMs"].includes(key));
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PROOF_KEYS = ["verificationVersion", "credentialId", "nonce", "clientDataJSON", "authenticatorData", "signature", "userHandle"];

export const sha256Digest = (value) =>
  `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
export const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const exactKeys = (value, keys) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key, index) => Object.keys(value)[index] === key);
const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const b64 = (value, min, max) =>
  typeof value === "string" && value.length >= min && value.length <= max && BASE64URL.test(value) &&
  Buffer.from(value, "base64url").toString("base64url") === value;

/** The group membership digest the payload binds, as `createNewFormatDecisionGroup` orders it. */
export const groupMembersDigestOf = (members) => sha256Digest(JSON.stringify(members));

/** Canonical payload bytes; throws on any missing, extra, reordered or malformed field. */
export const assertionPayload = (fields) => {
  const keys = RECORD_KEYS[fields?.recordKind];
  const record = keys && fields.record && Object.fromEntries(keys.map((key) => [key, fields.record[key]]));
  const problem =
    fields?.protocol !== ASSERTION_PROTOCOL ? "unknown protocol"
    : !keys ? "unknown recordKind"
    : !fields.record || Object.keys(fields.record).length !== keys.length || !keys.every((key) => nonEmpty(fields.record[key])) ? "malformed record identity"
    : !nonEmpty(fields.projectRoot) || !fields.projectRoot.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(fields.projectRoot) ? "non-absolute projectRoot"
    : !DIGEST.test(fields.lifecycleDigest ?? "") ? "malformed lifecycleDigest"
    : !DIGEST.test(fields.candidateDigest ?? "") ? "malformed candidateDigest"
    : !["APPROVED", "REJECTED"].includes(fields.result) ? "unknown result"
    : !["HUMAN_ATTESTED", "AGENT_RELAYED", "AUTO"].includes(fields.requiredPrincipal) ? "unknown requiredPrincipal"
    : !nonEmpty(fields.policyId) || !DIGEST.test(fields.policyDigest ?? "") ? "malformed policy"
    : !(fields.groupMembersDigest === null && fields.groupMemberCount === 0) &&
      !(DIGEST.test(fields.groupMembersDigest ?? "") && Number.isSafeInteger(fields.groupMemberCount) && fields.groupMemberCount > 1) ? "malformed group binding"
    : fields.recordKind === "artifact" && fields.groupMembersDigest !== null ? "artifact group authority is unsupported"
    : !b64(fields.nonce, 43, 43) ? "nonce is not 32 base64url bytes"
    : !Number.isSafeInteger(fields.issuedAtMs) || !Number.isSafeInteger(fields.expiresAtMs) ||
      fields.issuedAtMs < 0 || fields.expiresAtMs <= fields.issuedAtMs ||
      fields.expiresAtMs - fields.issuedAtMs > MAX_CHALLENGE_LIFETIME_MS ? "invalid lifetime"
    : null;
  if (problem) throw new Error(`Refusing operator assertion payload: ${problem}.`);
  return JSON.stringify(Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, key === "record" ? record : fields[key]])));
};

/** Parse stored payload bytes, refusing anything that is not already canonical. */
export const parseAssertionPayload = (text) => {
  const value = JSON.parse(text);
  if (!exactKeys(value, PAYLOAD_KEYS) || !exactKeys(value.record, RECORD_KEYS[value.recordKind] ?? []) ||
      assertionPayload(value) !== text) {
    throw new Error("Stored operator assertion payload is not canonical.");
  }
  return value;
};

export const assertionChallenge = (payloadText) =>
  base64url(createHash("sha256").update(CHALLENGE_DOMAIN, "utf8").update(payloadText, "utf8").digest());

/** The ledger's public proof: the exact raw assertion bytes, nothing decided. */
export const proofFromResponse = (response, nonce) => {
  const proof = {
    verificationVersion: VERIFICATION_VERSION,
    credentialId: response?.id,
    nonce,
    clientDataJSON: response?.response?.clientDataJSON,
    authenticatorData: response?.response?.authenticatorData,
    signature: response?.response?.signature,
    userHandle: response?.response?.userHandle,
  };
  const problem = proofProblem(proof);
  if (problem) throw new Error(`Malformed WebAuthn assertion: ${problem}.`);
  return proof;
};

export const proofProblem = (proof) =>
  !exactKeys(proof, PROOF_KEYS) ? "proof fields are missing, extra or reordered"
  : proof.verificationVersion !== VERIFICATION_VERSION ? `unknown verificationVersion ${JSON.stringify(proof.verificationVersion)}`
  : !b64(proof.credentialId, 16, 1366) ? "malformed credentialId"
  : !b64(proof.nonce, 43, 43) ? "malformed nonce"
  : !b64(proof.clientDataJSON, 40, 4096) ? "malformed clientDataJSON"
  : !b64(proof.authenticatorData, 49, 1024) ? "malformed authenticatorData"
  : !b64(proof.signature, 8, 256) ? "malformed signature"
  : !b64(proof.userHandle, 1, 86) ? "malformed userHandle"
  : null;

const responseFromProof = (proof) => ({
  id: proof.credentialId,
  rawId: proof.credentialId,
  type: "public-key",
  response: {
    clientDataJSON: proof.clientDataJSON,
    authenticatorData: proof.authenticatorData,
    signature: proof.signature,
    userHandle: proof.userHandle,
  },
  clientExtensionResults: {},
});

const assertEs256 = (publicKey) => {
  const key = decodeCredentialPublicKey(publicKey);
  if (key.get(3) !== COSE_ES256 || key.get(1) !== 2 || key.get(-1) !== 1) {
    throw new Error("Credential public key is not COSE ES256 (EC2 P-256).");
  }
};

/**
 * Verify one assertion proof against an exact challenge, origin, RP ID and a
 * registered credential snapshot. Returns the new counter; throws otherwise.
 * `verified: true` from the library is necessary, never sufficient.
 */
export const verifyAssertionProof = async ({ proof, challenge, origin, rpID, credential }) => {
  const problem = proofProblem(proof);
  if (problem) throw new Error(`Malformed WebAuthn assertion: ${problem}.`);
  if (proof.credentialId !== credential.id) throw new Error("Assertion names a different credential.");
  if (proof.userHandle !== credential.userHandle) throw new Error("Assertion userHandle does not match the registered operator.");
  assertEs256(credential.publicKey);
  const client = decodeClientDataJSON(proof.clientDataJSON);
  if (client.crossOrigin !== false || client.topOrigin !== undefined) {
    throw new Error("Assertion is cross-origin or does not state crossOrigin:false.");
  }
  const { verified, authenticationInfo: info } = await verifyAuthenticationResponse({
    response: responseFromProof(proof),
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    expectedType: "webauthn.get",
    requireUserVerification: true,
    credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter },
  });
  if (verified !== true || info.userVerified !== true || info.origin !== origin || info.rpID !== rpID ||
      info.authenticatorExtensionResults !== undefined) {
    throw new Error("WebAuthn assertion did not verify under the exact origin, RP ID, UV and no-extension policy.");
  }
  if (info.newCounter === 0 && !credential.counterless) {
    throw new Error("Assertion reports counter 0 for a credential not enrolled as counterless.");
  }
  return { newCounter: info.newCounter };
};

/** Verify an admin enrollment ceremony; ES256 only, UV required, exact origin/RP. */
export const verifyEnrollment = async ({ response, challenge, origin, rpID }) => {
  const client = decodeClientDataJSON(response?.response?.clientDataJSON ?? "");
  if (client.crossOrigin !== false || client.topOrigin !== undefined) {
    throw new Error("Registration is cross-origin or does not state crossOrigin:false.");
  }
  const { verified, registrationInfo: info } = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    expectedType: "webauthn.create",
    requireUserVerification: true,
    supportedAlgorithmIDs: [COSE_ES256],
  });
  if (verified !== true || !info?.userVerified || info.origin !== origin || info.rpID !== rpID) {
    throw new Error("WebAuthn registration did not verify under the exact origin, RP ID and UV policy.");
  }
  assertEs256(info.credential.publicKey);
  return { id: info.credential.id, publicKey: Buffer.from(info.credential.publicKey), counter: info.credential.counter };
};
