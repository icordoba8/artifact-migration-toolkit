import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

import { captureStructuredNode, deriveStructuredAuthority, structuredAssetIdentity,
  structuredDigest } from "../../src/visual-evidence.mjs";
import { structuredNodes } from "./structured-figma-fixture.mjs";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export const writeStructuredFigmaContext = async (root, { fileKey = "File123",
  rootId = "12:34", viewport = { width: 40, height: 20 },
  rootLocator = "getByRole('dialog')" } = {}) => {
  const ids = { "7:20": rootId, "7:21": `${rootId.split(":")[0]}:${Number(rootId.split(":")[1]) + 1}`,
    "7:22": `${rootId.split(":")[0]}:${Number(rootId.split(":")[1]) + 2}` };
  const base = `inventories/figma/${rootId.replace(":", "-")}-structured`;
  const persist = async (name, bytes) => {
    const reference = `${base}/${name}`;
    await mkdir(path.dirname(path.join(root, reference)), { recursive: true });
    await writeFile(path.join(root, reference), bytes);
    return { reference, hash: digest(bytes) };
  };
  const capture = { tool: "use_figma", operation: "inspect_nodes", parameters: { nodeIds: Object.values(ids) },
    timestamp: "2026-07-01T00:00:00.000Z" };
  const records = [];
  const structuredEntries = [];
  for (const [original, source] of Object.entries(structuredNodes)) {
    const nodeId = ids[original];
    const node = { ...source, id: nodeId,
      ...(source.parentId ? { parentId: ids[source.parentId] } : {}),
      ...(source.childIds ? { childIds: source.childIds.map((id) => ids[id]) } : {}),
      ...(original === "7:20" ? { width: viewport.width, height: viewport.height } : {}) };
    const rawSnapshot = JSON.stringify(node);
    const record = captureStructuredNode({ nodeId, rawSnapshot, capture });
    records.push(record);
    structuredEntries.push({ nodeId, ...await persist(`${nodeId.replace(":", "-")}.json`, rawSnapshot),
      digest: record.digest, capture });
  }
  const metadata = `<frame id="${rootId}" name="Dialog" width="${viewport.width}" height="${viewport.height}">` +
    `<ellipse id="${ids["7:21"]}" width="8" height="8" />` +
    `<text id="${ids["7:22"]}" width="46" height="18" /></frame>`;
  const metadataEntry = await persist("metadata.xml", metadata);
  const assetBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  const assetIdentity = structuredAssetIdentity(records[1], {
    exportKind: "SVG", mimeType: "image/svg+xml", content: assetBytes });
  const assetEntry = { nodeId: ids["7:21"], exportKind: "SVG", mimeType: "image/svg+xml",
    contentDigest: assetIdentity.contentDigest, ...await persist("ellipse.svg", assetBytes) };
  const image = new PNG({ width: viewport.width, height: viewport.height });
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const offset = (y * image.width + x) * 4;
    const dark = x >= 5 && x < 20 && y >= 4 && y < 15;
    image.data.fill(dark ? 20 : 240, offset, offset + 3);
    image.data[offset + 3] = 255;
  }
  const screenshot = PNG.sync.write(image);
  const screenshotEntry = await persist("screenshot.png", screenshot);
  const frameCapture = { role: "FIGMA_AUTHORITY", requested: { width: viewport.width, height: viewport.height,
    maxDimension: Math.max(viewport.width, viewport.height) },
    returned: { imageWidth: viewport.width, imageHeight: viewport.height }, frameBox: viewport,
    compare: viewport, imageWidth: viewport.width, imageHeight: viewport.height, matte: "#ffffff" };
  const authority = deriveStructuredAuthority({ records, rootId, assets: [assetIdentity],
    ancestry: (id) => id === rootId ? [id] : [rootId, id],
    metadataFacts: records.flatMap((record) => {
      const node = JSON.parse(record.rawSnapshot);
      return ["width", "height"].map((property) => ({ nodeId: record.nodeId, property,
        value: node[property], source: "METADATA", rawProperty: property }));
    }),
    sourceDigests: { metadata: structuredDigest(metadata) },
    screenshotDigest: structuredDigest(screenshot), capture: frameCapture });
  const nodes = Object.fromEntries(Object.entries(authority.nodes).map(([id, node]) =>
    [id, { targetLocator: id === rootId ? "[role=dialog]" : `[data-node-id="${id}"]`,
      facts: Object.fromEntries(Object.entries(node.facts).map(([property, fact]) =>
        [property, { value: fact.value, provenance: { kind: "STRUCTURED_NODE", nodeId: id,
          rawProperty: fact.support.rawProperty, snapshotDigest: fact.support.snapshotDigest } }])) }]));
  const rowNodes = Object.fromEntries(Object.entries(nodes).map(([id, node]) =>
    [id, { targetLocator: node.targetLocator,
      expect: Object.fromEntries(Object.entries(node.facts).map(([property, fact]) =>
        [property, { kind: "equals", value: fact.value }])) }]));
  const observation = { viewport: { width: 1280, height: 720 },
    nodes: Object.fromEntries(Object.entries(rowNodes).map(([id, node]) =>
      [id, { targetLocator: node.targetLocator,
        ...(id === rootId ? {} : { parentNodeId: rootId }),
        values: Object.fromEntries(Object.entries(node.expect).map(([property, fact]) => [property, fact.value])) }])) };
  const context = { version: 2, frames: [{ fileKey, nodeId: rootId, name: "Dialog", type: "FRAME",
    viewport, states: ["default"], rootLocator, extraction: { retrievedAt: capture.timestamp,
      fidelity: "COMPLETE", limitations: [] }, capture: frameCapture,
    sources: { metadata: metadataEntry, screenshot: screenshotEntry,
      structuredNodes: structuredEntries, assets: [assetEntry] },
    authority: { versionPinned: false, versionSource: "none", authorityDigest: authority.authorityDigest },
    nodes }] };
  await writeFile(path.join(root, "inventories/figma-context.json"), `${JSON.stringify(context, null, 2)}\n`);
  return { context, nodes: rowNodes, observation, base, ids, authorityDigest: authority.authorityDigest };
};
