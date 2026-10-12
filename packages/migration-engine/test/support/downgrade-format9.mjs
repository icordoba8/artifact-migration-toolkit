// A record born before format 10, made from a driven fixture (shared by the
// CLI and MCP backward-compatibility suites).

import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestToolkitIdentity } from "../../src/toolkit-identity.mjs";

// The migration-contract helpers, verbatim (approval.fixture's `historyEvents` counts lines instead).
const writeJson = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const state = async (fixture) =>
  JSON.parse(await readFile(path.join(fixture.migrationRoot, "state.json"), "utf8"));

const historyEvents = async (fixture) =>
  (
    await readFile(
      path.join(fixture.migrationRoot, "history/history.ndjson"),
      "utf8",
    )
  )
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/**
 * Rewrites a fixture into exactly what a record born before format 10 looks
 * like: eight checkpoints, no DISCOVERY_COMPLETENESS event, no discovery
 * artifacts, and a matching integrity anchor.
 */
export const downgradeToFormat9 = async (fixture) => {
  const root = fixture.migrationRoot;
  const events = (await historyEvents(fixture))
    .filter((event) => event.step !== "DISCOVERY_COMPLETENESS")
    .map(({ seq, previousHash, hash, ...event }) =>
      event.nextStep === "DISCOVERY_COMPLETENESS"
        ? { ...event, nextStep: "ASSESS_TARGET" }
        : { ...event },
    );
  let revision = 1;
  for (const event of events.slice(1)) {
    revision += 1;
    if (Number.isInteger(event.revision)) event.revision = revision;
  }
  const history = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await writeFile(path.join(root, "history/history.ndjson"), history);

  const persisted = await state(fixture);
  const artifactHashes = { ...persisted.artifactHashes };
  for (const key of [
    "steps/02a-discovery-completeness.md",
    "inventories/module-classification.json",
    "inventories/discovery-scan.json#discovery",
  ]) {
    delete artifactHashes[key];
  }
  for (const relative of [
    "steps/02a-discovery-completeness.md",
    "inventories/module-classification.json",
    "inventories/discovery-scan.json",
  ]) {
    await rm(path.join(root, relative), { force: true });
  }
  // A real format-9 record predates the format-15 keys entirely, so a
  // downgraded fixture that kept them would not be a format-9 record at all.
  //
  // Toolkit identity is the opposite case and is deliberately *kept*: it is
  // metadata about the build, not about the format, and an old-format record
  // that an operator adopted is an ordinary state -- the only one from which
  // these tests' subject, the eight-checkpoint lifecycle, can still be driven.
  // The anchor below therefore carries its digest, exactly as the engine writes.
  delete persisted.legacySources;
  delete persisted.targetAdoption;
  const downgraded = {
    ...persisted,
    formatVersion: 9,
    currentStep:
      persisted.currentStep === "DISCOVERY_COMPLETENESS"
        ? "ASSESS_TARGET"
        : persisted.currentStep,
    completedSteps: persisted.completedSteps.filter(
      (s) => s !== "DISCOVERY_COMPLETENESS",
    ),
    pendingSteps: persisted.pendingSteps.filter(
      (s) => s !== "DISCOVERY_COMPLETENESS",
    ),
    artifactHashes,
    revision,
  };
  await writeJson(path.join(root, "state.json"), downgraded);
  const bytes = Buffer.from(history, "utf8");
  await writeJson(path.join(root, "integrity.json"), {
    revision: downgraded.revision,
    toolkitIdentitySha256: digestToolkitIdentity(downgraded.toolkitIdentity) ?? undefined,
    artifactHashesSha256: createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(artifactHashes).sort(([l], [r]) =>
              l < r ? -1 : l > r ? 1 : 0,
            ),
          ),
        ),
      )
      .digest("hex"),
    history: {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  return downgraded;
};
