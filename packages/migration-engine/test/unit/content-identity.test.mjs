// Focused compatibility suite for cross-platform content identities.
//
// Hermetic policy coverage: what each tag means, which spellings parse, and
// which are refused. Compatibility-record replay is covered separately by the
// synthetic fixture in live-history-replay.test.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CONTENT_IDENTITY_BYTES,
  CONTENT_IDENTITY_TEXT,
  contentIdentity,
  contentIdentityMatches,
  isContentIdentity,
  isTextIdentityEligible,
  parseContentIdentity,
} from "../../src/migration-utils.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => Buffer.from(value, "utf8");

// -- what each tag means ------------------------------------------------------

test("text-lf-v1 folds CRLF to LF and nothing else", () => {
  const crlf = text("alpha\r\nbeta\r\n");
  const lf = text("alpha\nbeta\n");
  assert.equal(
    contentIdentity("notes.md", crlf),
    `sha256:${CONTENT_IDENTITY_TEXT}:${sha256(lf)}`,
  );
  assert.equal(contentIdentity("notes.md", crlf), contentIdentity("notes.md", lf));
  assert.ok(contentIdentityMatches(contentIdentity("notes.md", lf), "notes.md", crlf));

  // Everything else still changes the identity: a lone CR is not a line
  // ending to fold, and BOM, trailing whitespace and a final newline are
  // content, not spelling.
  for (const [label, other] of [
    ["a lone CR", text("alpha\rbeta\n")],
    ["a BOM", text("﻿alpha\nbeta\n")],
    ["trailing whitespace", text("alpha \nbeta\n")],
    ["no final newline", text("alpha\nbeta")],
    ["CR LF split across content", text("alpha\n\rbeta\n")],
  ]) {
    assert.notEqual(
      contentIdentity("notes.md", other),
      contentIdentity("notes.md", lf),
      `${label} must change the identity`,
    );
  }
});

test("bytes-v1 is the exact bytes, and an explicit byte purpose wins", () => {
  const crlf = text("alpha\r\nbeta\r\n");
  assert.equal(
    contentIdentity("evidence.png", crlf),
    `sha256:${CONTENT_IDENTITY_BYTES}:${sha256(crlf)}`,
  );
  // Same path, same bytes: declaring a byte-sensitive purpose overrides the
  // text classification rather than negotiating with it.
  assert.equal(
    contentIdentity("notes.md", crlf, { bytes: true }),
    `sha256:${CONTENT_IDENTITY_BYTES}:${sha256(crlf)}`,
  );
  assert.ok(
    !contentIdentityMatches(
      contentIdentity("notes.md", text("alpha\nbeta\n")),
      "notes.md",
      crlf,
      { bytes: true },
    ),
    "a text pin must not be honoured under a byte-sensitive purpose",
  );
});

test("eligibility is the frozen extension list plus the content itself", () => {
  assert.ok(isTextIdentityEligible("a/b/notes.MD", text("hello\n")));
  assert.ok(!isTextIdentityEligible("a/b/shot.png", text("hello\n")));
  // Invalid UTF-8 and binary control bytes are not text, whatever the name.
  assert.ok(!isTextIdentityEligible("a.md", Buffer.from([0xc3, 0x28])));
  assert.ok(!isTextIdentityEligible("a.md", Buffer.from([0x61, 0x00, 0x62])));
  assert.ok(!isTextIdentityEligible("a.md", Buffer.from([0x61, 0x7f])));
  // Tab, LF and CR are text.
  assert.ok(isTextIdentityEligible("a.md", text("a\tb\r\nc\n")));
  // An ineligible file still gets an identity -- the byte one.
  assert.equal(
    parseContentIdentity(contentIdentity("a.md", Buffer.from([0xc3, 0x28]))).scheme,
    CONTENT_IDENTITY_BYTES,
  );
});

// -- which spellings parse ----------------------------------------------------

test("the three supported spellings parse, and nothing else does", () => {
  const hex = "a".repeat(64);
  assert.deepEqual(parseContentIdentity(hex), { scheme: null, hex, tagged: false });
  assert.deepEqual(parseContentIdentity(`sha256:${hex}`), {
    scheme: null,
    hex,
    tagged: false,
  });
  assert.deepEqual(parseContentIdentity(`sha256:text-lf-v1:${hex}`), {
    scheme: CONTENT_IDENTITY_TEXT,
    hex,
    tagged: true,
  });
  assert.deepEqual(parseContentIdentity(`sha256:bytes-v1:${hex}`), {
    scheme: CONTENT_IDENTITY_BYTES,
    hex,
    tagged: true,
  });

  for (const malformed of [
    `sha256:text-lf-v2:${hex}`, // unknown tag
    `sha256:TEXT-LF-V1:${hex}`, // wrong case
    `sha512:text-lf-v1:${hex}`, // wrong algorithm
    `sha256:text-lf-v1:${"a".repeat(63)}`, // truncated
    `sha256:text-lf-v1:${"A".repeat(64)}`, // uppercase hex
    `sha256:bytes-v1:sha256:${hex}`, // contradictory / doubled scheme
    `sha256:text-lf-v1:bytes-v1:${hex}`, // two schemes at once
    `sha256:${hex} `, // trailing space
    "sha256:",
    "",
    null,
    undefined,
    42,
    { hex },
  ]) {
    assert.equal(
      parseContentIdentity(malformed),
      null,
      `${String(malformed)} must not parse`,
    );
    assert.equal(
      isContentIdentity(malformed),
      false,
      `${String(malformed)} must not be a persisted identity`,
    );
    assert.equal(
      contentIdentityMatches(malformed, "notes.md", text("alpha\n")),
      false,
      `${String(malformed)} must never match anything`,
    );
  }

  // A bare hex digest is a legal pin only where the record has always spelled
  // it that way; a persisted `digest` field still requires the prefix.
  assert.equal(isContentIdentity(hex), false);
  assert.equal(isContentIdentity(hex, { bare: true }), true);
  assert.equal(isContentIdentity(`sha256:${hex}`), true);
  assert.equal(isContentIdentity(`sha256:text-lf-v1:${hex}`), true);
});

// -- what a legacy untagged pin is allowed to match ---------------------------

test("a legacy pin matches the current bytes and the two EOL candidates", () => {
  const lf = text("alpha\nbeta\n");
  const crlf = text("alpha\r\nbeta\r\n");
  for (const [label, recorded, bytes] of [
    ["unchanged bytes", sha256(lf), lf],
    ["an LF pin read on a CRLF checkout", sha256(lf), crlf],
    ["a CRLF pin read on an LF checkout", sha256(crlf), lf],
  ]) {
    assert.ok(
      contentIdentityMatches(recorded, "notes.md", bytes),
      `a legacy pin must survive ${label}`,
    );
    assert.ok(
      contentIdentityMatches(`sha256:${recorded}`, "notes.md", bytes),
      `the prefixed spelling must behave identically (${label})`,
    );
  }

  // The bounded candidates are exactly three. Mixed placement that no
  // candidate reconstructs fails closed, and a byte purpose stops the search.
  assert.ok(!contentIdentityMatches(sha256(text("alpha\r\nbeta\n")), "notes.md", lf));
  assert.ok(!contentIdentityMatches(sha256(lf), "notes.md", crlf, { bytes: true }));
  assert.ok(!contentIdentityMatches(sha256(lf), "shot.png", crlf));
  // Different content is still different content.
  assert.ok(!contentIdentityMatches(sha256(lf), "notes.md", text("gamma\n")));
});

test("a tagged pin means its tag and is never retried under the other one", () => {
  const lf = text("alpha\nbeta\n");
  const crlf = text("alpha\r\nbeta\r\n");
  const bytesPin = `sha256:${CONTENT_IDENTITY_BYTES}:${sha256(lf)}`;
  assert.ok(contentIdentityMatches(bytesPin, "notes.md", lf));
  assert.ok(
    !contentIdentityMatches(bytesPin, "notes.md", crlf),
    "a bytes tag is byte equality, even for eligible text",
  );
  const textPin = `sha256:${CONTENT_IDENTITY_TEXT}:${sha256(lf)}`;
  assert.ok(contentIdentityMatches(textPin, "notes.md", crlf));
  assert.ok(
    !contentIdentityMatches(textPin, "shot.png", lf),
    "a text tag on ineligible content is a contradiction and fails",
  );
  assert.ok(
    !contentIdentityMatches(textPin, "notes.md", Buffer.concat([lf, Buffer.from([0x00])])),
    "a text tag over binary content is a contradiction and fails",
  );
});
