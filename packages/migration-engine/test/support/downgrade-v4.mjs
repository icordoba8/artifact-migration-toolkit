// The v4 downgrade harness, shared by the contract suite (in-process) and the
// external Format-17 acceptance (installed toolkit, scratch consumer).
//
// It lived in `test/unit/migration-contract.test.mjs` and moved here unchanged
// when the acceptance suite needed the same contract-4 tree; the acceptance
// fixture is a different consumer, so it takes the record root rather than a
// contract-suite fixture object.

import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// A genuine contract-4 tree: the persisted shape the upgrader accepts as
// "contract 4 format 3" and nothing else. It is produced by inverting the four
// documented v4 -> v5 differences on a tree the engine itself authored, so the
// fixture cannot drift away from what the workflow really writes:
//   1. version triple 5/4/5.0 -> 4/3/4.0
//   2. legacyRevision { revision, pathScoped } -> the bare legacyCommit string
//   3. the three disjoint v5 identifier lists -> one v4 requirementIds list
//   4. the v4-only mappingRegistered / blockers fields restored
// artifactHashes is re-pinned over the rewritten bytes, so the tree satisfies
// the upgrader's own source validation rather than a hand-waved approximation.
export const readTree = async (root) => {
  const files = {};
  for (const entry of await readdir(root, { recursive: true })) {
    const absolute = path.join(root, entry);
    if ((await stat(absolute)).isDirectory()) continue;
    files[entry.split(path.sep).join("/")] = await readFile(absolute, "utf8");
  }
  return files;
};

export const mergeTraceIds = (record) => {
  const merged = {
    ...record,
    requirementIds: [
      ...(record.requirementIds ?? []),
      ...(record.scenarioIds ?? []),
      ...(record.traceIds ?? []),
    ],
  };
  delete merged.scenarioIds;
  delete merged.traceIds;
  return merged;
};

export const downgradeToV4 = async (root) => {
  const files = await readTree(root);
  const render = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const write = async (relative, content) => {
    files[relative] = content;
    await writeFile(path.join(root, relative), content);
  };

  for (const [relative, content] of Object.entries({ ...files })) {
    if (!relative.startsWith("steps/")) continue;
    await write(
      relative,
      content
        .replace(/^- Contract version: `5`$/m, "- Contract version: `4`")
        .replace(/^- Format version: `4`$/m, "- Format version: `3`")
        .replace(/^- Workflow version: `5\.0`$/m, "- Workflow version: `4.0`"),
    );
  }

  const index = JSON.parse(files["slices/index.json"]);
  await write(
    "slices/index.json",
    render({ ...index, slices: index.slices.map(mergeTraceIds) }),
  );
  for (const slice of index.slices) {
    for (const relative of [
      `slices/${slice.id}.json`,
      `evidence/${slice.id}/result.json`,
    ]) {
      if (!Object.hasOwn(files, relative)) continue;
      await write(relative, render(mergeTraceIds(JSON.parse(files[relative]))));
    }
  }

  // A contract-4 record predates DISCOVERY_COMPLETENESS entirely: it never
  // recorded that event, never pinned its artifacts, and never had its files.
  // Leaving them in would fabricate a record no v4 build could have written.
  const droppedArtifacts = [
    "steps/02a-discovery-completeness.md",
    "inventories/module-classification.json",
    "inventories/discovery-scan.json",
  ];
  for (const relative of droppedArtifacts) {
    delete files[relative];
    await rm(path.join(root, relative), { force: true });
  }
  const events = files["history/history.ndjson"]
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.step !== "DISCOVERY_COMPLETENESS")
    // A contract-4 record also predates toolkit identity, so neither its
    // CREATED event nor its state ever carried one.
    .map(({ toolkitIdentity, seq, previousHash, hash, ...event }) => event);
  let replayed = 1;
  for (const event of events.slice(1)) {
    replayed += 1;
    if (Number.isInteger(event.revision)) event.revision = replayed;
  }
  await write(
    "history/history.ndjson",
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );

  const v5 = JSON.parse(files["state.json"]);
  const v4 = { ...v5 };
  v4.revision = replayed;
  v4.completedSteps = v5.completedSteps.filter(
    (step) => step !== "DISCOVERY_COMPLETENESS",
  );
  v4.pendingSteps = v5.pendingSteps.filter(
    (step) => step !== "DISCOVERY_COMPLETENESS",
  );
  delete v4.legacyRevision;
  delete v4.brief;
  delete v4.invalidatedArtifacts;
  // No contract-4 state had the format-15 keys either, nor a toolkit identity.
  delete v4.legacySources;
  delete v4.targetAdoption;
  delete v4.toolkitIdentity;
  v4.contractVersion = 4;
  v4.formatVersion = 3;
  v4.workflowVersion = "4.0";
  v4.legacyCommit = v5.legacyRevision.revision;
  v4.mappingRegistered = true;
  v4.blockers = [];
  if (v5.brief) v4.artifacts = { brief: v5.brief.path };
  v4.artifactHashes = Object.fromEntries(
    Object.keys(v5.artifactHashes)
      // P2-2's baseline row pin is derived, not a file, and no v4 state had
      // it; neither is the format-10 discovery pin.
      .filter((relative) => Object.hasOwn(files, relative))
      .map((relative) => [
        relative,
        createHash("sha256")
          .update(Buffer.from(files[relative], "utf8"))
          .digest("hex"),
      ]),
  );
  await write("state.json", render(v4));
  return v4;
};
