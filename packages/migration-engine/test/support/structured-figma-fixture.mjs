// Synthetic badge nodes in the Plugin API property shape; values invented for tests.
const solid = (hex) => ({ type: "SOLID", color: hex });

export const structuredNodes = Object.freeze({
  "7:20": {
    id: "7:20", type: "FRAME", width: 84, height: 28,
    paddingTop: 5, paddingRight: 12, paddingBottom: 5, paddingLeft: 9,
    itemSpacing: 5, fills: [solid("#f3ede2")], strokes: [],
    topLeftRadius: 14, topRightRadius: 14, bottomRightRadius: 14, bottomLeftRadius: 14,
    effects: [], opacity: 1, visible: true, childIds: ["7:21", "7:22"],
  },
  "7:21": {
    id: "7:21", parentId: "7:20", type: "ELLIPSE", width: 8, height: 8,
    fills: [solid("#b5562a")], opacity: 1, visible: true, isAsset: true,
  },
  "7:22": {
    id: "7:22", parentId: "7:20", type: "TEXT", width: 46, height: 18,
    fontName: { family: "Roboto", style: "Medium" }, fontVariationAxes: { wght: 500 },
    fontSize: 12, lineHeight: { unit: "PIXELS", value: 18 },
    fills: [solid("#5a3d1e")], opacity: 1, visible: true,
  },
});
