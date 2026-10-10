// Write ownership datasets, by checked joins.
// usage: node writesites.mjs owned <owners.tsv> <writes.tsv>
//          -> file line owner call module            (writes-owned.tsv: each write site with its owner's module)
//        node writesites.mjs wrapper-calls <owners.tsv> <writes.tsv> <edges.tsv>
//          -> fromFile fromName fromModule wrapper count (wrapper-calls.tsv: every reference into a curated write wrapper)
// Fails, printing nothing, if a write owner is not an owned declaration, an edge endpoint is unknown, or a curated
// wrapper is missing or cannot reach a write site directly or through edges.
import { Failure, UsageError, parseArgs, readEdges, readOwners, readWrites, run, tsv } from "./analysis.mjs";

const USAGE = "node writesites.mjs owned <owners.tsv> <writes.tsv> | wrapper-calls <owners.tsv> <writes.tsv> <edges.tsv>";
// The curated write wrappers (report section B.2). Each must exist and must reach a primitive write.
const WRAPPERS = [
  ["artifact/artifact-migration.mjs", "writeTransaction"], ["migration-utils.mjs", "atomicWrite"], ["migration-utils.mjs", "persistProjectRegistryBinding"],
  ["migration-utils.mjs", "updateRegistry"], ["module-lock.mjs", "writeJournalAtomic"], ["operator-signer-service.mjs", "writeOperatorOnly"],
  ["record-decision.mjs", "appendDurably"], ["resumable-migration.mjs", "appendHistory"], ["resumable-migration.mjs", "appendHistoryOnce"],
  ["resumable-migration.mjs", "sealHistoryTail"], ["resumable-migration.mjs", "writeOwner"], ["upgrades/upgrade-migration.mjs", "commitReplacement"],
  ["upgrades/upgrade-migration.mjs", "writeTree"],
];

run(USAGE, () => {
  const mode = process.argv[2];
  if (!["owned", "wrapper-calls"].includes(mode)) throw new UsageError(`mode must be owned or wrapper-calls; got ${JSON.stringify(mode)}`);
  const files = mode === "owned" ? ["owners.tsv", "writes.tsv"] : ["owners.tsv", "writes.tsv", "edges.tsv"];
  const { positional: [, ownersF, writesF, edgesF] } = parseArgs(process.argv.slice(2), { positional: [{ name: "mode" }, ...files.map((name) => ({ name }))] });
  const owners = readOwners(ownersF), writes = readWrites(writesF);
  const module = new Map(owners.map((r) => [`${r[0]}\t${r[3]}`, r[4]])), problems = [];
  writes.forEach((w, i) => { if (!module.has(`${w[0]}\t${w[2]}`)) problems.push(`${writesF}:${i + 1}: write owner ${w[0]} ${w[2]} is not in the owners`); });
  if (problems.length) throw new Failure(problems);
  if (mode === "owned") return tsv(writes.map((w) => [...w, module.get(`${w[0]}\t${w[2]}`)]));

  const edges = readEdges(edgesF, owners), next = new Map();
  for (const [ff, fn, tf, tn] of edges) (next.get(`${ff}\t${fn}`) ?? next.set(`${ff}\t${fn}`, new Set()).get(`${ff}\t${fn}`)).add(`${tf}\t${tn}`);
  const writers = new Set(writes.map((w) => `${w[0]}\t${w[2]}`));
  const reachesWrite = (start) => {
    const seen = new Set([start]), todo = [start];
    while (todo.length) { const k = todo.pop(); if (writers.has(k)) return true; for (const n of next.get(k) ?? []) if (!seen.has(n)) { seen.add(n); todo.push(n); } }
    return false;
  };
  for (const [f, n] of WRAPPERS) {
    const k = `${f}\t${n}`;
    if (!module.has(k)) problems.push(`wrapper ${f} ${n} is not in the owners`);
    else if (!reachesWrite(k)) problems.push(`wrapper ${f} ${n} reaches no write site`);
  }
  if (problems.length) throw new Failure(problems);
  if (new Set(WRAPPERS.map(([, n]) => n)).size !== WRAPPERS.length) throw new Failure(["internal: wrapper names must be unique"]);
  const wrappers = new Set(WRAPPERS.map(([f, n]) => `${f}\t${n}`)), calls = new Map();
  for (const [ff, fn, tf, tn, count] of edges) if (wrappers.has(`${tf}\t${tn}`)) {
    const k = [ff, fn, module.get(`${ff}\t${fn}`), tn].join("\t"); // wrapper names are unique, so the name alone identifies it
    calls.set(k, (calls.get(k) ?? 0) + Number(count));
  }
  return tsv([...calls].map(([k, c]) => [...k.split("\t"), c]));
});
