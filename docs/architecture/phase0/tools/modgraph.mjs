// usage: node modgraph.mjs owners.tsv edges.tsv
import { readFileSync } from "node:fs";
const [ownersF, edgesF] = process.argv.slice(2);
const rows = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => l.split("\t"));
const owner = new Map(rows(ownersF).map((r) => [`${r[0]}\t${r[3]}`, r[4] === "unassigned:leaf" ? "leaf" : r[4]]));
// Middle-tier order: LAYER_ORDER="slices>visual>census>decisions" lets each module call the ones to its right.
// Unset = siblings forbidden (all four share one rank).
const rank = { transport: 9, lifecycle: 8, decisions: 3, slices: 3, census: 3, visual: 3, store: 2, formats: 1, leaf: 0 };
(process.env.LAYER_ORDER ?? "").split(">").filter(Boolean).forEach((m, i, all) => { rank[m] = 3 + (all.length - 1 - i) * 0.1; });
const agg = new Map(), samples = new Map();
for (const [ff, fn, tf, tn, c] of rows(edgesF)) {
  const a = owner.get(`${ff}\t${fn}`), b = owner.get(`${tf}\t${tn}`);
  if (!a || !b || a === b) continue; // value nodes skipped (see report)
  const k = `${a}->${b}`; agg.set(k, (agg.get(k) ?? 0) + 1);
  (samples.get(k) ?? samples.set(k, []).get(k)).push(`${ff}:${fn} -> ${tf === ff ? "" : tf + ":"}${tn}`);
}
const violating = (k) => { const [a, b] = k.split("->"); return rank[b] > rank[a] || (rank[b] === rank[a]); };
console.log("## module edges (function->function references; count = distinct caller/callee pairs)");
for (const [k, c] of [...agg].sort()) console.log(`${violating(k) ? "VIOLATION" : "ok       "}\t${k}\t${c}`);
// SCC (Tarjan) on module graph
const nodes = Object.keys(rank), adj = new Map(nodes.map((n) => [n, []]));
for (const k of agg.keys()) { const [a, b] = k.split("->"); adj.get(a).push(b); }
let idx = 0; const st = [], on = new Set(), ix = new Map(), low = new Map(), sccs = [];
const sc = (v) => { ix.set(v, idx); low.set(v, idx++); st.push(v); on.add(v);
  for (const w of adj.get(v)) { if (!ix.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w))); }
  if (low.get(v) === ix.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c); } };
for (const n of nodes) if (!ix.has(n)) sc(n);
console.log("## SCCs (module cycles)"); for (const c of sccs) console.log(c.join(", "));
console.log("## 2-cycles"); for (const k of agg.keys()) { const [a, b] = k.split("->"); if (a < b && agg.has(`${b}->${a}`)) console.log(`${a} <-> ${b}\t${agg.get(k)} / ${agg.get(`${b}->${a}`)}`); }
if (process.argv[4] === "samples") for (const [k, s] of [...samples].sort()) if (violating(k)) console.log(`### ${k} (${s.length})\n` + s.join("\n"));
