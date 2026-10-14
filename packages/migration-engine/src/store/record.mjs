/** Store: the module record's layout, history hash chain and integrity anchor. */

import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import { assertSecurePath, isPlainObject, now } from "../shared/index.mjs";
import { digestToolkitIdentity, HISTORY_FILE, INTEGRITY_FILE } from "../formats/index.mjs";
import { appendDurably, fileExists, mkdirDurably } from "./files.mjs";
// Compatibility re-export (Track A2): these names are formats-owned now.
export { HISTORY_FILE, INTEGRITY_FILE } from "../formats/index.mjs";

export const digestArtifactHashes = (artifactHashes) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(artifactHashes).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        ),
      ),
    )
    .digest("hex");

/**
 * P2-3: `history.ndjson` declares itself the audit record but nothing pinned
 * its bytes -- truncating it reported no blockers, and because gate-evidence
 * freshness reads each event's `at`, dropping or back-dating events *loosened*
 * the freshness floor. This pins how long the record was and what it hashed to
 * at the moment of the state write, so it can only ever have grown since.
 *
 * The audit asked for a length plus a last-line digest; this hashes the whole
 * pinned prefix instead, which is the same one call and also catches an
 * interior line rewritten in place -- `at` is an ISO timestamp, so back-dating
 * one keeps both the byte length and the last line intact, and the history
 * replay ignores `at` entirely.
 *
 * The byte-prefix anchor still stops before the newest append. historyChain's
 * precommitted headHash covers that event through the journaled transaction.
 */
export const historyAnchorOf = (bytes) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

export const historyAnchorNow = async (root) => {
  const file = path.join(root, HISTORY_FILE);
  return historyAnchorOf(
    (await fileExists(file)) ? await readFile(file) : Buffer.alloc(0),
  );
};

export const renderIntegrity = (state, history, decisions, autoDecisions, historyChain) =>
  `${JSON.stringify(
    {
      revision: state.revision,
      artifactHashesSha256: digestArtifactHashes(state.artifactHashes),
      history,
      decisions,
      // Last, and omitted entirely on an unstamped record: JSON.stringify drops
      // an undefined value, so every integrity.json written before toolkit
      // identity existed stays byte-identical and no existing record is
      // retroactively invalidated by this field's introduction.
      toolkitIdentitySha256: digestToolkitIdentity(state.toolkitIdentity) ?? undefined,
      // Last for the same reason, and dropped on a record with no AUTO ledger:
      // a record that never ran under `--mode auto` writes the same bytes it
      // wrote before the AUTO principal existed.
      autoDecisions: autoDecisions ?? undefined,
      historyChain: historyChain ?? undefined,
    },
    null,
    2,
  )}\n`;

export const readIntegrity = async (root) => {
  const file = path.join(root, INTEGRITY_FILE);
  if (!(await fileExists(file))) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { corrupt: true };
  }
};

/**
 * W6-1, closing the documented gap in `historyAnchorOf`: the newest event is
 * appended *after* the state write, so exactly one event may legitimately sit
 * beyond the anchor, and it must be the one that moved the record to its
 * current revision. Two of them means a write path bypassed the transaction; a
 * mismatched revision means the tail was appended by something other than the
 * transaction that moved state. Both were undetected.
 *
 * A trailing fragment a killed process left half-written is not a completed
 * event: `sealTornTail` owns that repair, and asserting over it here would turn
 * a recoverable crash into a refusal.
 */
export const assertUnanchoredHistoryTail = (state, tail) => {
  const text = tail.toString("utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const events = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return; // a torn line; sealTornTail repairs it before the next append
    }
  }
  if (events.length === 0) return;
  if (events.length > 1) {
    throw new Error(
      `Migration history/history.ndjson has ${events.length} events past the integrity.json anchor, but a transaction pins the anchor before appending exactly one. Events were appended outside the checkpoint transaction; the record is untrusted.`,
    );
  }
  const [tailEvent] = events;
  if (
    Object.hasOwn(tailEvent, "revision") &&
    tailEvent.revision !== state.revision
  ) {
    throw new Error(
      `Migration history/history.ndjson's unanchored trailing event records revision ${tailEvent.revision}, but state.json is at revision ${state.revision}. The tail was appended by something other than the transaction that moved state; restore the record before continuing.`,
    );
  }
};

export const migrationRoot = (targetRoot, moduleName) =>
  path.join(targetRoot, ".agents/knowledge/migrations/modules", moduleName);

export const statePathFor = (targetRoot, moduleName) =>
  path.join(migrationRoot(targetRoot, moduleName), "state.json");

export const renderState = (state) => `${JSON.stringify(state, null, 2)}\n`;

// Fix C (candidate change; analysis/inventory.md Defect "history/
// history.ndjson is read-modify-atomic-rewrite, not append-only at the
// syscall level"): the original read the whole file, concatenated one line in
// memory, and rewrote it via temp-file+rename, which is not safe against a
// concurrent second writer (last rename wins; a racing append can be lost).
// This appends with a true OS-level append (`O_APPEND`, via the `a` flag),
// never reading or rewriting existing content, so two concurrent writers
// cannot silently clobber each other's line. The NDJSON file remains the one
// module-history record. DR8 (Track B) made it the store durable append.
const HISTORY_HASH_DOMAIN = "artifact-migration-tools/module-history/v1\n";

const historyDigest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const keyOrder = (left, right) => {
  const a = Array.from(left), b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const diff = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (diff) return diff;
  }
  return a.length - b.length;
};

const canonicalHistoryJson = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalHistoryJson).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort(keyOrder)
    .map((key) => `${JSON.stringify(key)}:${canonicalHistoryJson(value[key])}`).join(",")}}`;
  throw new Error("Migration history event contains a non-JSON value; nothing was written.");
};

export const hashHistoryEvent = (event) => {
  const { hash, ...payload } = event;
  return historyDigest(`${HISTORY_HASH_DOMAIN}${canonicalHistoryJson(payload)}`);
};

export const prepareHistoryEvent = async (root, event) => {
  if (!isPlainObject(event) || Object.hasOwn(event, "hash")) {
    throw new Error("Migration history event is already chained or invalid; nothing was written.");
  }
  const integrity = await readIntegrity(root);
  const existing = await readHistoryEvents(root, integrity);
  const bytes = await readFile(path.join(root, HISTORY_FILE));
  const legacyPrefixSha256 = integrity?.historyChain
    ? integrity.historyChain.legacyPrefixSha256 : historyDigest(bytes);
  const previousHash = existing.at(-1)?.hash ?? legacyPrefixSha256;
  Object.assign(event, { at: event.at ?? now(), seq: existing.length + 1, previousHash });
  event.hash = hashHistoryEvent(event);
  return {
    version: 1,
    startSeq: integrity?.historyChain?.startSeq ?? event.seq,
    legacyPrefixSha256,
    headHash: event.hash,
  };
};

// DR8: the store durable append, so a recorded transition survives a power
// loss as well as a killed process. A torn line is still sealHistoryTail's.
export const appendHistory = async (targetRoot, root, event) => {
  await appendDurably(
    targetRoot,
    path.join(root, HISTORY_FILE),
    `${JSON.stringify(event.hash ? event : { at: now(), ...event })}\n`,
  );
};

/** DR13: the bytes after the last newline of `history.ndjson` (empty at a record boundary). */
export const historyTailOf = async (targetRoot, root) => {
  const historyPath = await assertSecurePath(targetRoot, path.join(root, HISTORY_FILE));
  if (!(await fileExists(historyPath))) return Buffer.alloc(0);
  const content = await readFile(historyPath);
  return content.subarray(content.lastIndexOf(0x0a) + 1);
};

/**
 * DR13: whether the `tail` bytes are a torn (or newline-less) `appendHistory`
 * of exactly `event` -- the only tail a crash during that append leaves.
 * Compared byte for byte: a tear may split a multi-byte character. An unchained
 * event is written with its append time first, so that time is read from the tail.
 */
export const isTornAppendOf = (tail, event) => {
  const prefixOf = (value) => {
    const line = Buffer.from(JSON.stringify(value), "utf8");
    return tail.length <= line.length && line.subarray(0, tail.length).equals(tail);
  };
  if (event.hash || event.at !== undefined) return prefixOf(event.hash ? event : { at: event.at, ...event });
  const head = tail.toString("latin1");
  const at = /^\{"at":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/.exec(head)?.[1];
  return at ? prefixOf({ at, ...event }) : /^\{"at":"[\dTZ:.-]*$/.test(head) || '{"at":"'.startsWith(head);
};

/**
 * Proves the audit record is appendable before any state is written. Without
 * it, a broken `history/` (replaced by a file, read-only, or on a full disk)
 * was only discovered after `state.json` had already moved -- the checkpoint
 * advanced while the transition it represents was never recorded.
 */
export const assertHistoryAppendable = async (targetRoot, root) => {
  const historyPath = path.join(root, HISTORY_FILE);
  const securePath = await assertSecurePath(targetRoot, historyPath);
  await mkdirDurably(path.dirname(securePath));
  const handle = await open(securePath, "a", 0o600);
  await handle.close();
};

/**
 * Seals a trailing line a killed process left half-written, so the next append
 * starts on an event boundary.
 *
 * A pending journal can tolerate an unparseable final fragment, but `O_APPEND`
 * does not: the
 * replacement event would be spliced onto the fragment, and the combined line
 * stays unparseable and is ignored forever -- while recovery deletes the only
 * journal that could have retried. Two shapes are possible, and they are not
 * the same repair: a truncated JSON prefix is not an event and is cut, whereas
 * a complete object whose terminator never landed is an event and only gets
 * its newline. Both are decided from the bytes after the last newline, so the
 * repair is deterministic and never touches an anchored prefix.
 *
 * Runs under the module lock, immediately before every append.
 *
 * @returns {Promise<null | "TERMINATED" | "TRUNCATED">} what the tail needed.
 */
export const sealHistoryTail = async (targetRoot, root) => {
  const historyPath = await assertSecurePath(
    targetRoot,
    path.join(root, HISTORY_FILE),
  );
  if (!(await fileExists(historyPath))) return null;
  const content = await readFile(historyPath);
  // Byte offsets, not character offsets: a UTF-8 path in an event would make
  // the two disagree and truncate mid-character.
  const boundary = content.lastIndexOf(0x0a) + 1;
  const tail = content.subarray(boundary).toString("utf8");
  if (tail === "") return null;
  // A strict prefix of `{...}` only parses when it is the whole object, so
  // parsing proves the event's bytes all landed and only the newline is gone.
  let complete = false;
  try {
    complete = isPlainObject(JSON.parse(tail));
  } catch {
    complete = false;
  }
  const handle = await open(historyPath, "r+", 0o600);
  try {
    if (complete) await handle.write("\n", content.length);
    else await handle.truncate(boundary);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return complete ? "TERMINATED" : "TRUNCATED";
};

export const readHistoryEvents = async (root, integrity, pendingJournal) => {
  const historyPath = path.join(root, HISTORY_FILE);
  if (!(await fileExists(historyPath))) return [];
  const content = await readFile(historyPath);
  const events = [];
  const ends = [];
  let start = 0;
  for (let end = content.indexOf(0x0a); end !== -1; end = content.indexOf(0x0a, start)) {
    const line = content.subarray(start, end).toString("utf8");
    if (!line.trim()) throw new Error(`Migration history line ${events.length + 1} is blank; restore it before continuing.`);
    try {
      const event = JSON.parse(line);
      if (!isPlainObject(event)) throw new Error("not an event object");
      events.push(event);
    } catch {
      throw new Error(`Migration history line ${events.length + 1} is malformed; restore it before continuing.`);
    }
    start = end + 1;
    ends.push(start);
  }
  if (start < content.length &&
      (!pendingJournal || pendingJournal.corrupt || !isPlainObject(pendingJournal.event))) {
    throw new Error(`Migration history line ${events.length + 1} is unterminated; recover the pending transaction or restore it.`);
  }
  const anchor = integrity === undefined ? (await readIntegrity(root))?.historyChain : integrity?.historyChain;
  if (anchor) {
    const digestShape = /^sha256:[0-9a-f]{64}$/;
    if (anchor.version !== 1 || !Number.isInteger(anchor.startSeq) || anchor.startSeq < 1 ||
        anchor.startSeq > events.length + 1 || !digestShape.test(anchor.headHash) ||
        (anchor.startSeq === 1 ? anchor.legacyPrefixSha256 !== null :
          !digestShape.test(anchor.legacyPrefixSha256))) {
      throw new Error("Migration integrity.json has an invalid historyChain boundary; restore it before continuing.");
    }
    const prefix = content.subarray(0, ends[anchor.startSeq - 2] ?? 0);
    if (anchor.startSeq > 1 && historyDigest(prefix) !== anchor.legacyPrefixSha256) {
      throw new Error("Migration history legacy prefix differs from integrity.json; restore it before continuing.");
    }
    let previousHash = anchor.startSeq === 1 ? null : anchor.legacyPrefixSha256;
    for (let i = anchor.startSeq - 1; i < events.length; i += 1) {
      const event = events[i];
      if (!isPlainObject(event) || event.seq !== i + 1 || event.previousHash !== previousHash ||
          !digestShape.test(event.hash) || hashHistoryEvent(event) !== event.hash) {
        throw new Error(`Migration history line ${i + 1} has an invalid hash, seq, or previousHash; restore it before continuing.`);
      }
      previousHash = event.hash;
    }
    if (previousHash !== anchor.headHash &&
        !(pendingJournal?.event?.hash === anchor.headHash &&
          pendingJournal.event.seq === events.length + 1 &&
          pendingJournal.event.previousHash === previousHash &&
          hashHistoryEvent(pendingJournal.event) === anchor.headHash)) {
      throw new Error("Migration history headHash disagrees with integrity.json; recover the pending journal or restore the record.");
    }
  } else if (events.some((event) => Object.hasOwn(event, "hash") ||
      Object.hasOwn(event, "previousHash") || Object.hasOwn(event, "seq"))) {
    throw new Error("Migration history has chained events without an integrity.json historyChain boundary.");
  }
  return events;
};
/**
 * `--reopen-complete` only. Where a COMPLETE record's superseded verification
 * evidence is preserved, byte-for-byte, before its pin is released:
 * `reopen/<n>/evidence/<slice>/result.json` plus `reopen/<n>/record.json`,
 * which names the operator, the reason and the authoritative post-finalization
 * evidence that proved the finalized contract wrong. Both stay pinned for life,
 * exactly like a preserved rework attempt.
 */
export const REOPEN_ROOT = "reopen";
