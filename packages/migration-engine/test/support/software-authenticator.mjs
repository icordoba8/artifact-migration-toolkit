/**
 * Test-only software WebAuthn authenticator. Keys are generated per test run
 * in memory; nothing here is shipped or persisted. It builds raw CBOR, COSE,
 * authenticatorData and ECDSA signatures so the real verifier is exercised.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest();
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const head = (major, length) =>
  length < 24 ? Buffer.from([(major << 5) | length])
  : length < 256 ? Buffer.from([(major << 5) | 24, length])
  : Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
const text = (value) => Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
const bytes = (value) => Buffer.concat([head(2, value.length), value]);
const int = (value) => (value >= 0 ? head(0, value) : head(1, -1 - value));

export const createSoftwareAuthenticator = ({
  origin, rpID, alg = -7, counter = 1, keyType = "P-256",
} = {}) => {
  const { privateKey, publicKey } = keyType === "P-384"
    ? generateKeyPairSync("ec", { namedCurve: "P-384" })
    : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.concat([
    head(5, 5),
    int(1), int(2),
    int(3), int(alg),
    int(-1), int(keyType === "P-384" ? 2 : 1),
    int(-2), bytes(Buffer.from(jwk.x, "base64url")),
    int(-3), bytes(Buffer.from(jwk.y, "base64url")),
  ]);
  const credentialId = createHash("sha256").update(cose).digest().subarray(0, 16);
  let count = counter;
  let userHandle = null;
  const authData = ({ flags, rp = rpID, attested = false }) => {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(count);
    return Buffer.concat([
      sha256(rp), Buffer.from([flags]), counterBytes,
      ...(attested ? [Buffer.alloc(16), Buffer.from([0, credentialId.length]), credentialId, cose] : []),
    ]);
  };
  const clientData = (type, challenge, overrides = {}) => {
    const value = { type, challenge, origin, crossOrigin: false, ...overrides };
    if (value.crossOrigin === "omit") delete value.crossOrigin;
    return Buffer.from(JSON.stringify(value));
  };
  return {
    id: b64(credentialId),
    get counter() { return count; },
    set counter(value) { count = value; },
    register: (options, { uv = true } = {}) => {
      userHandle = options.user.id;
      const attestationObject = Buffer.concat([
        head(5, 3),
        text("fmt"), text("none"),
        text("attStmt"), head(5, 0),
        text("authData"), bytes(authData({ flags: 0x41 | (uv ? 0x04 : 0), attested: true })),
      ]);
      return {
        id: b64(credentialId), rawId: b64(credentialId), type: "public-key",
        response: {
          clientDataJSON: b64(clientData("webauthn.create", options.challenge)),
          attestationObject: b64(attestationObject),
          transports: ["usb"],
        },
        clientExtensionResults: {},
      };
    },
    /** One assertion; `tamper` overrides any flag/field to build negative cases. */
    assert: (options, tamper = {}) => {
      if (tamper.counter !== undefined) count = tamper.counter;
      else count = count === 0 && tamper.keepZero ? 0 : count + 1;
      const flags = (tamper.up === false ? 0 : 0x01) | (tamper.uv === false ? 0 : 0x04);
      const data = authData({ flags, rp: tamper.rpID ?? rpID });
      const client = clientData(tamper.type ?? "webauthn.get", tamper.challenge ?? options.challenge, {
        ...(tamper.origin ? { origin: tamper.origin } : {}),
        ...(tamper.crossOrigin !== undefined ? { crossOrigin: tamper.crossOrigin } : {}),
      });
      let signature = sign("sha256", Buffer.concat([data, sha256(client)]), privateKey);
      if (tamper.badSignature) signature = Buffer.from(signature.map((byte, index) => (index === 10 ? byte ^ 1 : byte)));
      return {
        id: tamper.id ?? b64(credentialId), rawId: tamper.id ?? b64(credentialId), type: "public-key",
        response: {
          clientDataJSON: b64(client), authenticatorData: b64(data),
          signature: b64(signature), userHandle: tamper.userHandle ?? userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
};
