import { readCanonicalModuleBoundary } from "../census/index.mjs";
import { assertExternalUiCapabilityRows } from "../slices/index.mjs";

export const validateExternalUiCapabilities = async (root, state, roots, rows) => {
  const { scan } = await readCanonicalModuleBoundary(root, state, roots);
  assertExternalUiCapabilityRows(scan, rows, roots);
};
