import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Test data only: seed the old bootstrap shape before any work or authority.
// Production has no creation override and never rewrites an existing record.
export const historicalBootstrap = async (root, formatVersion) => {
  const file = path.join(root, "state.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(state.completedSteps, ["RESOLVE"]);
  assert.equal(state.currentStep, "DISCOVER_LEGACY");
  const artifact = Boolean(state.artifactId);
  assert.equal(state.revision, artifact ? 0 : 1);
  assert.equal(formatVersion, artifact ? 13 : 18);
  state.formatVersion = formatVersion;
  const bytes = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(file, bytes);
  if (artifact) {
    const integrityFile = path.join(root, "integrity.json");
    const integrity = JSON.parse(await readFile(integrityFile, "utf8"));
    integrity.stateSha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(integrityFile, `${JSON.stringify(integrity, null, 2)}\n`);
  } else {
    const classificationFile = path.join(root, "inventories/module-classification.json");
    const classification = JSON.parse(await readFile(classificationFile, "utf8"));
    classification.version = 1;
    await writeFile(classificationFile, `${JSON.stringify(classification, null, 2)}\n`);
  }
  return state;
};
