/** Shared: SHA-256 helpers, canonical JSON bytes and the content-identity policy. */

import { createHash } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Cross-platform content identity (one shared policy for both engines)
//
// An ordinary file pin conflated "what this text says" with "how this checkout
// spells its line endings". Git may hand the same committed blob to Windows as
// CRLF and to Linux as LF, so a raw-byte pin written on one platform fails
// verification on the other even though nothing was edited.
//
// New pins are tagged, so the intent is on the record instead of inferred:
//
//   sha256:text-lf-v1:<64 lowercase hex>   CRLF pairs folded to LF, then hashed
//   sha256:bytes-v1:<64 lowercase hex>     the exact bytes, hashed
//
// Nothing else about the bytes is touched: BOM, lone CR, trailing whitespace,
// final-newline presence, Unicode form and JSON formatting all still change the
// identity. Content is never parsed and reserialized to compute one.
//
// Raw-byte purposes -- confirmation preimages, decision ledgers and their byte
// anchors, approval candidates, transaction preimages, preserved rework
// evidence -- keep their existing SHA-256 helpers and are never routed here.
// ---------------------------------------------------------------------------

/** Frozen v1 text-eligible extension allowlist. Changing it needs a new tag. */
const TEXT_IDENTITY_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".json", ".yaml", ".yml",
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".xml", ".svg", ".csv", ".log",
]);

export const CONTENT_IDENTITY_TEXT = "text-lf-v1";

export const CONTENT_IDENTITY_BYTES = "bytes-v1";

const IDENTITY_SCHEMES = new Set([
  CONTENT_IDENTITY_TEXT,
  CONTENT_IDENTITY_BYTES,
]);

const TAGGED_IDENTITY = /^sha256:([a-z0-9-]+):([a-f0-9]{64})$/;

const PREFIXED_DIGEST = /^sha256:([a-f0-9]{64})$/;

const BARE_DIGEST = /^[a-f0-9]{64}$/;

const CR = 0x0d;

const LF = 0x0a;

const TAB = 0x09;

const DEL = 0x7f;

export const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** The bytes with every CRLF pair replaced by LF. A lone CR survives intact. */
const foldCrlf = (bytes) => {
  if (!bytes.includes(CR)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === CR && bytes[index + 1] === LF) continue;
    out[length] = bytes[index];
    length += 1;
  }
  return out.subarray(0, length);
};

/** The literal inverse candidate: every LF becomes CRLF. */
const expandLf = (bytes) => {
  if (!bytes.includes(LF)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length * 2);
  let length = 0;
  for (const byte of bytes) {
    if (byte === LF) {
      out[length] = CR;
      length += 1;
    }
    out[length] = byte;
    length += 1;
  }
  return out.subarray(0, length);
};

/**
 * Valid UTF-8 with no binary control byte (C0 other than TAB/LF/CR, or DEL).
 * `fatal` decoding is the runtime's own validator -- malformed bytes throw
 * rather than decoding to replacement characters -- and `ignoreBOM` keeps a
 * leading BOM in the decoded value so it is never silently treated as absent.
 */
const isTextContent = (bytes) => {
  for (const byte of bytes) {
    if (byte === DEL) return false;
    if (byte < 0x20 && byte !== TAB && byte !== LF && byte !== CR) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return false;
  }
  return true;
};

/**
 * Whether this path plus content is eligible for a text identity.
 * Deterministic and platform-independent: extension allowlist first, then the
 * content itself. No OS, provider, locale, Git setting, or size heuristic
 * participates, so two checkouts of one blob always classify the same way.
 */
export const isTextIdentityEligible = (relativePath, bytes) =>
  TEXT_IDENTITY_EXTENSIONS.has(
    path.extname(String(relativePath)).toLowerCase(),
  ) && isTextContent(bytes);

/**
 * `{ scheme, hex, tagged }` for any supported spelling, or `null`. `scheme` is
 * `null` for the two legacy spellings (bare hex and `sha256:<hex>`), which is
 * exactly the case bounded compatibility matching applies to. An unknown or
 * malformed tag parses to `null`, so it never matches anything.
 */
export const parseContentIdentity = (value) => {
  if (typeof value !== "string") return null;
  if (BARE_DIGEST.test(value)) {
    return { scheme: null, hex: value, tagged: false };
  }
  const prefixed = PREFIXED_DIGEST.exec(value);
  if (prefixed) return { scheme: null, hex: prefixed[1], tagged: false };
  const tagged = TAGGED_IDENTITY.exec(value);
  if (!tagged || !IDENTITY_SCHEMES.has(tagged[1])) return null;
  return { scheme: tagged[1], hex: tagged[2], tagged: true };
};

/**
 * Shape predicate for persisted digest fields. `bare` admits the unprefixed
 * 64-hex spelling `artifactHashes` has always used; the `sha256:`-prefixed and
 * tagged spellings are always admitted.
 */
export const isContentIdentity = (value, { bare = false } = {}) => {
  const parsed = parseContentIdentity(value);
  if (!parsed) return false;
  return bare || parsed.tagged || value.startsWith("sha256:");
};

/**
 * The identity to record for `bytes` at `relativePath`. `bytes: true` declares
 * an explicit byte-sensitive purpose and always wins over text classification.
 */
export const contentIdentity = (
  relativePath,
  bytes,
  { bytes: bytesOnly = false } = {},
) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return !bytesOnly && isTextIdentityEligible(relativePath, buffer)
    ? `sha256:${CONTENT_IDENTITY_TEXT}:${sha256Hex(foldCrlf(buffer))}`
    : `sha256:${CONTENT_IDENTITY_BYTES}:${sha256Hex(buffer)}`;
};

/**
 * Whether `recorded` still identifies `bytes`.
 *
 * A tagged identity means exactly what its tag says and is never retried under
 * the other scheme: a bytes tag is byte equality, and a text tag on ineligible
 * content -- or under a byte-sensitive purpose -- is a contradiction and fails.
 * A legacy untagged digest is compared against the three approved candidates:
 * the current bytes, those bytes with CRLF folded to LF, and that result with
 * LF expanded back to CRLF. Together they cover an unchanged file, a historical
 * LF pin read on a CRLF checkout, and a committed CRLF pin read on a
 * Git-normalized LF checkout, without needing the original blob.
 *
 * Arbitrary historical mixed-EOL placement cannot be reconstructed from a hash
 * after folding, so anything the bounded candidates miss fails closed. Nothing
 * here rewrites, repairs, or re-pins: the recorded digest is the caller's, and
 * it comes back unchanged.
 */
export const contentIdentityMatches = (
  recorded,
  relativePath,
  bytes,
  { bytes: bytesOnly = false } = {},
) => {
  const parsed = parseContentIdentity(recorded);
  if (!parsed) return false;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const textEligible =
    !bytesOnly && isTextIdentityEligible(relativePath, buffer);

  if (parsed.scheme === CONTENT_IDENTITY_BYTES) {
    return parsed.hex === sha256Hex(buffer);
  }
  if (parsed.scheme === CONTENT_IDENTITY_TEXT) {
    return textEligible && parsed.hex === sha256Hex(foldCrlf(buffer));
  }

  // Legacy, untagged. Candidate 1 -- the current bytes -- always applies.
  if (parsed.hex === sha256Hex(buffer)) return true;
  if (!textEligible) return false;
  // Candidates 2 and 3, deduplicated: a candidate identical to one already
  // tried carries no new information.
  const folded = foldCrlf(buffer);
  if (!folded.equals(buffer) && parsed.hex === sha256Hex(folded)) return true;
  const expanded = expandLf(folded);
  return !expanded.equals(buffer) && parsed.hex === sha256Hex(expanded);
};

export const sha256Json = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export const canonicalJson = (value) =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, JSON.parse(canonicalJson(child))]),
        )
      : Array.isArray(value)
        ? value.map((child) => JSON.parse(canonicalJson(child)))
        : value,
  );

export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const jsonBytesEqual = (raw, value) => raw !== null && value !== null && raw === jsonBytes(value);
