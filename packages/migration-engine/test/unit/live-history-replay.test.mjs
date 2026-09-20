// Replay compatibility with a synthetic record carrying the same edge cases.
//
// The fixture contains only the four files replay reads: `state.json`, the
// append-only history, operator decisions, and the integrity anchor. It is
// frozen so later engine changes cannot redefine compatibility by editing the
// input.
//
// The claim is exact: replaying that history reaches revision 61 at COMPLETE
// with the same 56 pins the record persists, and the bytes are untouched. Every
// step, pin and navigation field is compared by `readState` itself, so a drift
// in any of them fails here as a mismatch, not as a soft warning.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readState } from "../../src/resumable-migration.mjs";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/compatibility-record",
);
const MODULE = "catalog-sync";
const RECORD = `.agents/knowledge/migrations/modules/${MODULE}`;

/** The files the replay reads, and therefore the files it must not rewrite. */
const REPLAY_INPUTS = [
  "state.json",
  "integrity.json",
  "history/history.ndjson",
  "decisions/operator-decisions.ndjson",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const digestInputs = async (root) =>
  Object.fromEntries(
    await Promise.all(
      REPLAY_INPUTS.map(async (relative) => [
        relative,
        sha256(await readFile(path.join(root, RECORD, relative))),
      ]),
    ),
  );

const historyEvents = async (root) =>
  (await readFile(path.join(root, RECORD, "history/history.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("the synthetic compatibility record replays to its persisted revision, untouched", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "live-replay-"));
  try {
    await cp(FIXTURE, base, { recursive: true });
    const before = await digestInputs(base);

    const { state } = await readState(base, MODULE);

    assert.equal(state.revision, 61);
    assert.equal(state.currentStep, "COMPLETE");
    assert.equal(state.status, "COMPLETE");
    assert.equal(state.formatVersion, 16);

    const pins = Object.keys(state.artifactHashes);
    // `readState` already requires the replayed pin set to equal this one
    // exactly; naming the preserved roots keeps the reason visible.
    assert.equal(
      pins.filter((pin) => pin.startsWith("stale-ui-evidence/")).length,
      7,
      "the FINALIZE reopen's preserved stale PASSes stay pinned for life",
    );
    assert.equal(
      pins.filter((pin) => pin.startsWith("slice-amendments/")).length,
      3,
      "every amended slice's prior record stays pinned for life",
    );
    assert.ok(
      pins.includes("ui-remediation.json"),
      "a FINALIZE reopen leaves the remediation pin exactly as it was",
    );

    assert.deepEqual(
      await digestInputs(base),
      before,
      "reading a record rewrites no state, history or decision byte",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Guards the fixture, not the engine: if these events ever leave the frozen
// history, the suite above would still pass while proving nothing.
test("the frozen history exercises both ported transitions", async () => {
  const events = await historyEvents(FIXTURE);
  const reopens = events.filter(
    (event) => event.event === "UI_REMEDIATION_REOPENED",
  );
  assert.ok(
    reopens.some((event) => event.from === "FINALIZE" && event.preserved?.length),
    "a stale-evidence reopen from FINALIZE, with preserved evidence",
  );
  assert.ok(
    reopens.some((event) => event.from !== "FINALIZE"),
    "a reopen that does invalidate the remediation, for contrast",
  );
  assert.equal(
    events.filter((event) => event.event === "SLICE_SCOPE_AMENDED").length,
    3,
  );
});
