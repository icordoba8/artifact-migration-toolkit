// Compatibility path (Track A7). The policy is two halves now: the argv
// refusals are transport's (`transport/arguments.mjs`), and the mode and
// outcome policy stays below transport (`lifecycle-policy.mjs`). Engine code
// imports those; this path keeps its BASE exports for external callers.
export * from "./lifecycle-policy.mjs";
export { assertOptionCombination } from "./transport/index.mjs";
