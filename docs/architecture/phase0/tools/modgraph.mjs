// usage: node modgraph.mjs <owners.tsv> <edges.tsv> [--layer-order=w>x>y>z] [--samples]
// Aggregates declaration edges into module edges, marks violations against the fixed layer ranks, and reports SCCs and
// 2-cycles. --layer-order orders the four middle-tier modules (an exact permutation; each may call the ones to its right);
// without it siblings are forbidden. The ambient LAYER_ORDER variable is refused so a stale shell cannot change the rules.
import { MIDDLE, MODULES, UsageError, parseArgs, readEdges, readOwners, run } from "./analysis.mjs";

const USAGE = "node modgraph.mjs <owners.tsv> <edges.tsv> [--layer-order=w>x>y>z] [--samples]";
const orderProblem = (v) => {
  if (v === true) return "needs a value";
  const names = v.split(">");
  return names.length === MIDDLE.length && new Set(names).size === MIDDLE.length && names.every((n) => MIDDLE.includes(n))
    ? null : `must be a permutation of ${MIDDLE.join(", ")} joined by ">"`;
};

run(USAGE, () => {
  if ("LAYER_ORDER" in process.env) throw new UsageError("LAYER_ORDER is set in the environment; unset it and pass --layer-order instead");
  const { positional: [ownersF, edgesF], flags } = parseArgs(process.argv.slice(2), {
    positional: [{ name: "owners.tsv" }, { name: "edges.tsv" }],
    flags: { "layer-order": orderProblem, samples: (v) => (v === true ? null : "takes no value") },
  });
  const owners = readOwners(ownersF), edges = readEdges(edgesF, owners);
  const label = (m) => (m === "unassigned:leaf" ? "leaf" : m);
  const rank = Object.fromEntries(Object.entries(MODULES).map(([m, r]) => [label(m), r]));
  const order = flags["layer-order"]?.split(">") ?? [];
  order.forEach((m, i) => { rank[m] = 3 + (order.length - 1 - i) * 0.1; }); // stays strictly between store (2) and lifecycle (8)
  const owner = new Map(owners.map((r) => [`${r[0]}\t${r[3]}`, label(r[4])]));
  // Distinct caller/callee pairs; `via` only says how a pair was resolved.
  const pairs = new Set(edges.map(([ff, fn, tf, tn]) => [ff, fn, tf, tn].join("\t")));
  const agg = new Map(), samples = new Map();
  for (const k of [...pairs].sort()) {
    const [ff, fn, tf, tn] = k.split("\t"), a = owner.get(`${ff}\t${fn}`), b = owner.get(`${tf}\t${tn}`);
    if (a === b) continue;
    const m = `${a}->${b}`; agg.set(m, (agg.get(m) ?? 0) + 1);
    (samples.get(m) ?? samples.set(m, []).get(m)).push(`${ff}:${fn} -> ${tf === ff ? "" : tf + ":"}${tn}`);
  }
  const violating = (k) => { const [a, b] = k.split("->"); return rank[b] >= rank[a]; };
  const keys = [...agg.keys()].sort(), out = [];
  out.push(`## layer order: ${order.length ? order.join(">") : "none (siblings forbidden)"}`);
  out.push("## module edges (function->function references; count = distinct caller/callee pairs)");
  for (const k of keys) out.push(`${violating(k) ? "VIOLATION" : "ok       "}\t${k}\t${agg.get(k)}`);
  // SCC (Tarjan) on the module graph, over sorted nodes and adjacency so the result never depends on input order.
  const nodes = Object.keys(rank).sort(), adj = new Map(nodes.map((n) => [n, []]));
  for (const k of keys) { const [a, b] = k.split("->"); adj.get(a).push(b); }
  let idx = 0; const st = [], on = new Set(), ix = new Map(), low = new Map(), sccs = [];
  const sc = (v) => { ix.set(v, idx); low.set(v, idx++); st.push(v); on.add(v);
    for (const w of adj.get(v)) { if (!ix.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w))); }
    if (low.get(v) === ix.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c.sort()); } };
  for (const n of nodes) if (!ix.has(n)) sc(n);
  out.push("## SCCs (module cycles)"); for (const c of sccs.sort()) out.push(c.join(", "));
  out.push("## 2-cycles"); for (const k of keys) { const [a, b] = k.split("->"); if (a < b && agg.has(`${b}->${a}`)) out.push(`${a} <-> ${b}\t${agg.get(k)} / ${agg.get(`${b}->${a}`)}`); }
  if (flags.samples) for (const k of keys) if (violating(k)) out.push(`### ${k} (${samples.get(k).length})\n` + samples.get(k).join("\n"));
  return `${out.join("\n")}\n`;
});
