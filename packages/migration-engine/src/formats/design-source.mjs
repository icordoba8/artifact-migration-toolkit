/** Formats: the design-source vocabulary a record declares. */

export const DESIGN_SOURCES = [
  "target-system",
  "figma-mcp",
  "legacy-runtime",
];

const FIGMA_FILE_KEY = /^[A-Za-z0-9]+$/;

// Figma encodes node ids in the URL as `<page>-<node>`; the canonical form is
// `<page>:<node>`. Only the URL form is accepted, then converted.
const FIGMA_NODE_ID = /^[0-9]+-[0-9]+$/;

/**
 * Pure, network-free normalization of one Figma link string into the persisted
 * reference `{ fileKey, nodeId, kind, raw }`. Only `/design/` and `/make/`
 * links are a UI design contract; FigJam (`/board/`) and Slides are refused.
 * Fail-closed, like `assertSafeName`: a malformed link stops the bootstrap
 * before anything is written.
 */
export const assertFigmaSource = (raw) => {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Figma source must be a non-empty URL string.");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid Figma URL '${raw}'.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Figma URL must use http(s): '${raw}'.`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== "figma.com" && host !== "www.figma.com") {
    throw new Error(`Figma URL host must be figma.com: '${raw}'.`);
  }
  if (url.username || url.password) {
    throw new Error("Figma URL must not carry userinfo credentials.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const kind = segments[0];
  if (kind === "board" || kind === "slides") {
    throw new Error(
      `Figma ${kind} links are not a UI design contract and cannot be a design source: '${raw}'.`,
    );
  }
  if (kind !== "design" && kind !== "make") {
    throw new Error(
      `Unsupported Figma URL '${raw}'. Use a /design/ or /make/ link.`,
    );
  }
  // Branch URLs (`/design/:key/branch/:branchKey/...`) address the branch as
  // the effective file, per the Figma URL rules.
  let fileKey = segments[1];
  if (kind === "design" && segments[2] === "branch" && segments[3]) {
    fileKey = segments[3];
  }
  if (!fileKey || !FIGMA_FILE_KEY.test(fileKey)) {
    throw new Error(`Figma URL is missing a valid file key: '${raw}'.`);
  }
  let nodeId = null;
  const rawNode = url.searchParams.get("node-id");
  if (rawNode !== null) {
    if (!FIGMA_NODE_ID.test(rawNode)) {
      throw new Error(`Invalid Figma node-id '${rawNode}' in '${raw}'.`);
    }
    nodeId = rawNode.replace("-", ":");
  }
  // Never persist the operator URL verbatim: rebuild a canonical reference from
  // the validated fields only, so credentials, extra query params, and
  // duplicate node-id values can never leak into or disagree with the pin.
  const canonical = new URL(`https://www.figma.com/${kind}/${fileKey}`);
  if (nodeId !== null) {
    canonical.searchParams.set("node-id", nodeId.replace(":", "-"));
  }
  return { fileKey, nodeId, kind, raw: canonical.toString() };
};

/**
 * The one rule that ties `--design-source` and `--figma` together, shared by
 * the bootstrap and the read-only preview so both agree on what gets pinned.
 * `target-system` (default) and `legacy-runtime` forbid Figma links; `figma-mcp`
 * requires at least one and dedupes by `fileKey#nodeId`.
 */
export const resolveDesignSource = ({ designSource, figma } = {}) => {
  const mode = designSource ?? "target-system";
  if (!DESIGN_SOURCES.includes(mode)) {
    throw new Error(
      `Invalid design source '${String(mode)}'. Use ${DESIGN_SOURCES.join(" or ")}.`,
    );
  }
  const links = Array.isArray(figma) ? figma : figma ? [figma] : [];
  // Every non-Figma source takes the same branch: the links belong to exactly
  // one origin, so `legacy-runtime` refuses them exactly as `target-system` does.
  if (mode !== "figma-mcp") {
    if (links.length > 0) {
      throw new Error("--figma links require --design-source figma-mcp.");
    }
    return { designSource: mode, figmaSources: [] };
  }
  const figmaSources = [];
  const seen = new Set();
  for (const link of links) {
    const source = assertFigmaSource(link);
    const dedupeKey = `${source.kind}#${source.fileKey}#${source.nodeId ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    figmaSources.push(source);
  }
  if (figmaSources.length === 0) {
    throw new Error(
      "--design-source figma-mcp requires at least one --figma link.",
    );
  }
  return { designSource: "figma-mcp", figmaSources };
};
