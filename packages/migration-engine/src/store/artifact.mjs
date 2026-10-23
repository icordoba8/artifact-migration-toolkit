/** Store: the artifact record's root and pin digests. */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertNonEmpty,
  assertSafeName,
  assertSecurePath,
  canonicalJson,
  jsonBytes,
  normalizeRelative,
  sha256Hex,
} from "../shared/index.mjs";

export const STATE_ROOT = ".agents/knowledge/migrations/artifacts";

export const fileHash = async (file) => sha256Hex(await readFile(file));

export const secureHash = async (root, relative, label = "evidence path") => {
  const normalized = normalizeRelative(relative, label);
  const file = path.resolve(root, normalized);
  await assertSecurePath(root, file);
  return fileHash(file);
};

export const artifactRoot = (targetRoot, id) =>
  path.join(
    path.resolve(assertNonEmpty(targetRoot, "targetRoot")),
    STATE_ROOT,
    assertSafeName(id, "artifact id"),
  );

const semanticEvidence = (document) => ({
  ...document,
  runtimeEvidence: document.runtimeEvidence.map(({ provider: _provider, sessionId: _session, ...row }) => row),
});

export const artifactEvidenceDigest = (document) =>
  sha256Hex(canonicalJson(semanticEvidence(document)));

const immutableProjection = (relative, document) => {
  if (relative === "matrices/parity.json") {
    return document.rows.map(({ id, behaviorId, resolution }) => ({ id, behaviorId, resolution }));
  }
  if (relative === "matrices/target-native.json") {
    return document.rows.map(({ id, path: file, description }) => ({ id, path: file, description }));
  }
  if (relative === "matrices/design-system.json") {
    return document.rows.map(({ id, behaviorId, scope, targetComponent, requiredComponent }) => ({
      id,
      behaviorId,
      scope,
      targetComponent,
      requiredComponent,
    }));
  }
  if (relative === "matrices/global-contract.json") {
    return document.rows.map(({ id, sourceContractId, kind, targetPath, consumers }) => ({
      id,
      sourceContractId,
      kind,
      targetPath,
      consumers,
    }));
  }
  throw new Error(`No immutable projection exists for ${relative}.`);
};

export const pinDigest = async (root, key) => {
  if (key.endsWith("#semantic")) {
    const relative = key.slice(0, -"#semantic".length);
    await assertSecurePath(root, path.join(root, relative));
    const document = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    return artifactEvidenceDigest(document);
  }
  if (key.endsWith("#immutable")) {
    const relative = key.slice(0, -"#immutable".length);
    await assertSecurePath(root, path.join(root, relative));
    const document = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    return sha256Hex(canonicalJson(immutableProjection(relative, document)));
  }
  return secureHash(root, key, "pinned artifact path");
};

export const HISTORY_EVENT_KEYS = ["seq", "at", "event", "from", "to", "slice", "revision", "prevDigest", "digest"];

export const integrityFor = (state, historyContent) => ({
  version: 1,
  stateSha256: sha256Hex(jsonBytes(state)),
  historyBytes: Buffer.byteLength(historyContent),
  historySha256: sha256Hex(historyContent),
  historyEvents: historyContent.split("\n").filter(Boolean).length,
  artifactHashesSha256: sha256Hex(canonicalJson(state.artifactHashes)),
});

export const revalidatePins = async (root, state) => {
  for (const [key, digest] of Object.entries(state.artifactHashes)) {
    if ((await pinDigest(root, key)) !== digest) {
      // M10: an agent that edited a pinned field can repair its own file; say how.
      throw new Error(`Completed artifact changed: ${key}.${key.endsWith("#immutable")
        ? " Only row status and evidence may change after BUILD_BASELINE: restore every other field to its pinned value and rerun."
        : " Restore the validated bytes (for example from version control) and rerun; completed work is never rewritten."}`);
    }
  }
};

// The exact byte-identical prefix of `content` holding its first `eventCount`
// history lines. Each appended line is `JSON.stringify(event)\n` (finishTransaction),
// so slicing on "\n" and rejoining reproduces the original bytes exactly -- no
// reserialization, so a prefix this reconstructs always hashes identically to
// the original bytes it was cut from.
export const historyPrefixContent = (content, eventCount) => {
  if (eventCount === 0) return "";
  const lines = content.split("\n");
  return `${lines.slice(0, eventCount).join("\n")}\n`;
};

export const readJsonAt = async (root, relative, label) => {
  const file = path.join(root, relative);
  try {
    await assertSecurePath(root, file);
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${relative}.`);
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
};
