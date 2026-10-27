/**
 * Lifecycle: the legacy module's exported call contract at FINALIZE (M14.1).
 *
 * Every export an inbound legacy consumer imports keeps its call contract in
 * the target: still exported, still callable, no used argument dropped, and no
 * key the legacy function read from an argument left unread (census/exports).
 * Both sides are derived at FINALIZE from source: the legacy bytes are the ones
 * DISCOVERY_COMPLETENESS pinned (FINALIZE has already re-proven them), and the
 * consumers are the inbound edges of the pinned discovery scan. Nothing is
 * persisted, so no record format moves; a record of any format with a
 * discovery scan is held to it.
 *
 * A consumer is a production file that imports or requires the export. A test
 * reaches internals on purpose, and a framework ancestor or a type import never
 * calls it, so neither sets the contract. A module root's public entry (its
 * `index`, or a root that is one file) owes every export it has once any
 * consumer imports it; a deeper file owes only the names its consumers take.
 */
import path from "node:path";
import {
  discoveryDigest,
  exportAnalyzer,
  exportContractIssues,
  featureLocalPrefix,
  loadTypeScript,
  sourceReader,
  TEST_PATTERN,
} from "../census/index.mjs";
import { DISCOVERY_SCAN_FILE, usesDiscoveryCompleteness } from "../formats/index.mjs";
import { readJson } from "../store/index.mjs";

const SCRIPT = /\.[cm]?[jt]sx?$/;
const CALL_EDGES = new Set(["IMPORT", "REEXPORT", "REQUIRE", "DYNAMIC"]);

const isPublicEntry = (scan, file) => (scan.moduleRoots ?? []).some((root) =>
  file === root || (path.posix.dirname(file) === root && /^index\.[cm]?[jt]sx?$/.test(path.posix.basename(file))));

/** Legacy entry file -> the symbols its production consumers import, from the pinned scan. */
const consumedEntries = async (scan, legacy) => {
  const owned = new Set(scan.census ?? []);
  const entries = new Map();
  for (const edge of scan.edges ?? []) {
    if (!CALL_EDGES.has(edge.kind) || owned.has(edge.from) || TEST_PATTERN.test(edge.from) ||
      !owned.has(edge.to) || !SCRIPT.test(edge.to)) continue;
    const symbols = entries.get(edge.to) ?? new Set();
    // A public entry owes everything. Elsewhere the scan records a CommonJS `require`
    // as the whole module, and its destructuring names the part used.
    const required = isPublicEntry(scan, edge.to) ? ["*"]
      : edge.kind === "REQUIRE" ? await legacy.requiredNames(edge.from, edge.to, edge.line) : null;
    for (const symbol of required ?? edge.symbols ?? ["*"]) symbols.add(symbol);
    entries.set(edge.to, symbols);
  }
  return entries;
};

/**
 * The target files that answer a legacy entry, in order: the same path inside
 * the target feature directory, relative to the legacy module root that owns
 * it, then the feature's index. A root that is itself one file maps to the
 * index or its own name.
 */
const targetEntriesFor = async (reader, scan, entry, targetModule) => {
  const root = (scan.moduleRoots ?? [])
    .filter((candidate) => entry === candidate || entry.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];
  const feature = featureLocalPrefix(targetModule);
  const stem = (relative) => relative.replace(SCRIPT, "");
  const specs = root === undefined || entry === root
    ? ["./index", `./${stem(path.posix.basename(entry))}`]
    : [`./${stem(entry.slice(root.length + 1))}`, "./index"];
  const found = [];
  for (const spec of specs) {
    const file = await reader.resolve(spec, `${feature}index`);
    if (file && !found.includes(file)) found.push(file);
  }
  return { found, looked: specs.map((spec) => `${feature}${spec.slice(2)}`) };
};

export const assertExportContractKept = async ({ root, state, roots }) => {
  if (!usesDiscoveryCompleteness(state) || !roots?.legacyRoot || !roots?.targetRoot) return;
  const scan = await readJson(path.join(root, DISCOVERY_SCAN_FILE), "Discovery scan");
  if (!scan || discoveryDigest(scan) !== scan.discoveryDigest) {
    throw new Error(`${DISCOVERY_SCAN_FILE} no longer hashes to its recorded discovery digest, so its inbound consumers cannot be trusted. Reopen discovery with --reopen-discovery.`);
  }
  const ts = loadTypeScript();
  const legacy = exportAnalyzer(ts, sourceReader(roots.legacyRoot));
  const entries = await consumedEntries(scan, legacy);
  if (entries.size === 0) return;
  const targetReader = sourceReader(roots.targetRoot);
  const target = exportAnalyzer(ts, targetReader);
  const issues = [];
  for (const [entry, symbols] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    const before = await legacy.contractOf(entry, [...symbols].sort());
    const names = Object.keys(before.exports).filter((name) => !["UNRESOLVED", "ABSENT"].includes(before.exports[name].kind));
    if (names.length === 0) continue;
    const { found, looked } = await targetEntriesFor(targetReader, scan, entry, state.targetModule);
    if (found.length === 0) {
      issues.push(`legacy ${entry} exports ${names.map((name) => `'${name}'`).join(", ")} to inbound consumers, and the target has no counterpart module (looked for ${looked.join(", ")} with a script extension or as a directory index).`);
      continue;
    }
    for (const name of names) {
      // The first counterpart that exports the name answers for it.
      let answer = { file: found.join(" or "), contract: { kind: "ABSENT" } };
      for (const file of found) {
        const contract = await target.describeExport(file, name);
        if (contract.kind !== "ABSENT") {
          answer = { file, contract };
          break;
        }
      }
      issues.push(...exportContractIssues({ exports: { [name]: before.exports[name] } }, { exports: { [name]: answer.contract } },
        { legacyEntry: entry, targetEntry: answer.file }));
    }
  }
  if (issues.length > 0) {
    throw Object.assign(new Error(
      `EXPORT_CONTRACT_INCOMPATIBLE: the target breaks the call contract legacy consumers rely on: ${issues.map((issue, index) => `(${index + 1}) ${issue}`).join(" ")} An export's parameter shape is observable behavior: keep the legacy call contract (adapt inside the target if its own design differs), re-run verification, and record that run as FINAL_VERIFY evidence.`,
    ), { validationCode: "EXPORT_CONTRACT_INCOMPATIBLE" });
  }
};
