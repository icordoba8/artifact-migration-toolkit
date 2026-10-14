/**
 * DR18: one design-source immutability matrix, run against both the module and
 * the artifact record so the two can never drift apart again. Each case is the
 * design half of an invocation that resumes a record bootstrapped as RECORDED.
 */
const A = "https://www.figma.com/design/ABC123def/Flow?node-id=12-34";
const B = "https://www.figma.com/make/OTHERkey2/Detail?node-id=56-78";

export const RECORDED_FIGMA = { designSource: "figma-mcp", figma: [A, B] };

const figma = (...links) => ({ designSource: "figma-mcp", figma: links });

/** Invocations naming exactly the pinned figma-mcp authority: accepted. */
export const SAME_FIGMA_AUTHORITY = [
  ["the recorded links", figma(A, B)],
  ["the recorded links reordered", figma(B, A)],
  ["equivalent URLs", figma(
    "http://figma.com/design/ABC123def/Renamed?node-id=12-34&t=discarded",
    "https://www.figma.com/make/OTHERkey2?node-id=56-78#frame",
  )],
  ["duplicate normalized links", figma(B, A, "https://figma.com/design/ABC123def/Other?node-id=12-34", B)],
];

/** Invocations naming any other authority, or none: refused. */
export const OTHER_FIGMA_AUTHORITY = [
  ["target-system", { designSource: "target-system" }],
  ["legacy-runtime", { designSource: "legacy-runtime" }],
  ["a different kind", figma("https://www.figma.com/make/ABC123def/Flow?node-id=12-34", B)],
  ["a changed file key", figma("https://www.figma.com/design/ABC123deg/Flow?node-id=12-34", B)],
  ["a branch of the file", figma("https://www.figma.com/design/ABC123def/branch/BRANCHkey/Flow?node-id=12-34", B)],
  ["a changed node id", figma("https://www.figma.com/design/ABC123def/Flow?node-id=12-35", B)],
  ["a dropped node id", figma("https://www.figma.com/design/ABC123def/Flow", B)],
  ["a missing source", figma(A)],
  ["an added source", figma(A, B, "https://www.figma.com/design/NEWkey1/New?node-id=1-2")],
  ["figma-mcp without links", { designSource: "figma-mcp" }],
  ["links without figma-mcp", { figma: [A, B] }],
  ["links under legacy-runtime", { designSource: "legacy-runtime", figma: [A, B] }],
  ["a malformed link", figma(A, "not a url")],
  ["a malformed node id", figma(A, "https://www.figma.com/make/OTHERkey2/Detail?node-id=56:78")],
  ["a FigJam board", figma(A, "https://www.figma.com/board/OTHERkey2/Detail?node-id=56-78")],
  ["an empty link value", { designSource: "figma-mcp", figma: "" }],
];

/** The same matrix for a record pinned to a non-Figma design source. */
export const nonFigmaCases = (recorded) => ({
  same: [["the recorded design source", { designSource: recorded }]],
  other: [
    ["figma-mcp", figma(A)],
    ["the other non-Figma source", { designSource: recorded === "legacy-runtime" ? "target-system" : "legacy-runtime" }],
    ["links under the recorded source", { designSource: recorded, figma: [A] }],
    ["an empty link value", { figma: "" }],
    ["a null link value", { designSource: recorded, figma: null }],
  ],
});
