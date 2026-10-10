// node --test docs/architecture/phase0/tools/test/
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DATA, TOOLS, baseData, hasBase, rowsOf, tmp, tool, writeTsv } from "./fixture.mjs";

const refused = (r, status, pattern) => { assert.equal(r.status, status, r.stdout + r.stderr); assert.equal(r.stdout, ""); if (pattern) assert.match(r.stderr, pattern); };
const noBase = !hasBase() && "BASE commit not in this clone";
const lines = (f) => readFileSync(f, "utf8").trim().split("\n");
const shuffled = (file) => { const l = lines(file); const out = [...l.slice(1).reverse(), l[0]]; return writeTsv(out); };
// A copy of assign.mjs (next to analysis.mjs) with one textual edit, as the reviewer reproduced F2.
const editedAssign = (from, to) => {
  const dir = tmp(), src = readFileSync(path.join(TOOLS, "assign.mjs"), "utf8");
  assert.ok(src.includes(from), `fixture edit target missing: ${from}`);
  copyFileSync(path.join(TOOLS, "analysis.mjs"), path.join(dir, "analysis.mjs"));
  writeFileSync(path.join(dir, "assign.mjs"), src.replace(from, to));
  return path.join(dir, "assign.mjs");
};

// Small owner/edge fixture: f.mjs a (lifecycle) calls b (store) and c (formats); c calls GHOST-free leaf d.
const O = (file, name, mod, kind = "fn") => [file, "1", "I", name, mod, "1", kind];
const owners = [O("f.mjs", "a", "lifecycle"), O("f.mjs", "b", "store"), O("f.mjs", "c", "formats"), O("g.mjs", "d", "unassigned:leaf"), O("g.mjs", "e", "decisions"), O("g.mjs", "s", "slices")];
const E = (fn, tn, via = "local", count = "1", tf = "f.mjs", ff = "f.mjs") => [ff, fn, tf, tn, count, via];
const edges = [E("a", "b"), E("a", "c"), E("c", "d", "import", "2", "g.mjs"), E("b", "a"), E("e", "s", "import", "1", "g.mjs", "g.mjs"), E("s", "e", "local", "1", "g.mjs", "g.mjs")];
const mg = (o, e, ...args) => tool("modgraph.mjs", [writeTsv(o), writeTsv(e), ...args]);

test("F1-1 a duplicated owner fails and names both lines", () => {
  refused(mg([...owners, O("f.mjs", "b", "transport")], edges), 1, /f\.tsv:7: duplicate "f\.mjs b" \(first at line 2\)/);
});

test("F1-2 an edge to a missing declaration fails", () => {
  refused(mg(owners, [...edges, E("a", "GHOST")]), 1, /endpoint f\.mjs GHOST is not in the owners/);
});

test("F1-3/F1-4 an owner module outside the registry fails (?, typo)", () => {
  refused(mg([...owners.slice(1), O("f.mjs", "a", "?")], edges), 1, /module "\?" is not one of/);
  refused(mg([...owners.slice(1), O("f.mjs", "a", "lifecyle")], edges), 1, /module "lifecyle" is not one of/);
});

test("F1-5 malformed owner rows fail", () => {
  refused(mg([owners[0].slice(0, 6), ...owners.slice(1)], edges), 1, /expected 7 columns, got 6/);
  refused(mg([["f.mjs", "1", "I", "", "store", "1", "fn"], ...owners], edges), 1, /empty name/);
  refused(mg([["f.mjs", "x", "I", "z", "store", "1", "fn"], ...owners], edges), 1, /line "x" is malformed/);
});

test("F1-6 malformed edges fail: bad count, duplicate key, unknown via", () => {
  for (const count of ["0", "-1", "x"]) refused(mg(owners, [...edges, E("a", "d", "local", count, "g.mjs")]), 1, /count/);
  refused(mg(owners, [...edges, E("a", "b", "local", "5")]), 1, /duplicate/);
  refused(mg(owners, [...edges, E("a", "d", "guess", "1", "g.mjs")]), 1, /via "guess"/);
});

test("F1-7 a valid fixture gives the exact hand-written result", () => {
  const r = mg(owners, edges, "--samples");
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, "");
  assert.equal(r.stdout, `## layer order: none (siblings forbidden)
## module edges (function->function references; count = distinct caller/callee pairs)
VIOLATION\tdecisions->slices\t1
ok       \tformats->leaf\t1
ok       \tlifecycle->formats\t1
ok       \tlifecycle->store\t1
VIOLATION\tslices->decisions\t1
VIOLATION\tstore->lifecycle\t1
## SCCs (module cycles)
decisions, slices
lifecycle, store
## 2-cycles
decisions <-> slices\t1 / 1
lifecycle <-> store\t1 / 1
### decisions->slices (1)
g.mjs:e -> s
### slices->decisions (1)
g.mjs:s -> e
### store->lifecycle (1)
f.mjs:b -> a
`);
});

test("F5-1 an ambient LAYER_ORDER is refused, not applied", () => {
  refused(tool("modgraph.mjs", [writeTsv(owners), writeTsv(edges)], { env: { LAYER_ORDER: "store>lifecycle" } }), 2, /LAYER_ORDER is set/);
  refused(tool("modgraph.mjs", [writeTsv(owners), writeTsv(edges)], { env: { LAYER_ORDER: "" } }), 2, /LAYER_ORDER is set/);
});

test("F5-2 --layer-order must be an exact permutation of the middle tier", () => {
  for (const v of ["store>lifecycle", "slices>visual>census", "slices>slices>census>decisions", "slices>visual>census>decisions>store", "slices>>census>decisions", ""])
    refused(mg(owners, edges, `--layer-order=${v}`), 2, /--layer-order/);
  refused(mg(owners, edges, "--layer-order"), 2, /needs a value/);
});

test("F5-3 every one of the 24 orders keeps lifecycle->store ok and store->lifecycle a violation", () => {
  const perms = (xs) => (xs.length ? xs.flatMap((x) => perms(xs.filter((y) => y !== x)).map((p) => [x, ...p])) : [[]]);
  const all = perms(["decisions", "slices", "census", "visual"]);
  assert.equal(all.length, 24);
  for (const p of all) {
    const r = mg(owners, edges, `--layer-order=${p.join(">")}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ok {7}\tlifecycle->store\t1$/m); assert.match(r.stdout, /^VIOLATION\tstore->lifecycle\t1$/m);
    assert.equal(/^VIOLATION\tdecisions->slices/m.test(r.stdout), p.indexOf("decisions") > p.indexOf("slices"), p.join(">"));
  }
});

test("F6-2 modgraph refuses unknown options and extra arguments", () => {
  refused(mg(owners, edges, "samplez"), 2, /expected 2 arguments/);
  refused(mg(owners, edges, "--samplez"), 2, /unknown option/);
  refused(mg(owners, edges, "--samples=yes"), 2, /takes no value/);
});

test("D-1 modgraph is byte-identical across runs and on shuffled input", () => {
  const a = mg(owners, edges, "--samples").stdout;
  assert.equal(mg(owners, edges, "--samples").stdout, a);
  assert.equal(mg([...owners].reverse(), [...edges].reverse(), "--samples").stdout, a);
});

test("F2-6 assign needs exactly <decls.tsv> <a|b>", () => {
  const decls = writeTsv([["f.mjs", "1", "I", "fn", "a", "1"]]);
  refused(tool("assign.mjs", [decls]), 2); refused(tool("assign.mjs", [decls, "c"]), 2, /a, b/); refused(tool("assign.mjs", [decls, "a", "x"]), 2);
});

test("F2-1 a module outside the registry fails", { skip: noBase }, () => {
  refused(tool(editedAssign(`[AM, "store", \`STATE_ROOT`, `[AM, "bogusmod", \`STATE_ROOT`), [baseData()["decls.tsv"], "a"]), 1, /UNKNOWN MODULE bogusmod/);
});

test("F2-2 a duplicated declaration row fails", { skip: noBase }, () => {
  const l = lines(baseData()["decls.tsv"]);
  refused(tool("assign.mjs", [writeTsv([...l, l[5]]), "a"]), 1, /duplicate/);
});

test("F2-3 UNKNOWN, DUPLICATE and MISSING table cases fail", { skip: noBase }, () => {
  const decls = baseData()["decls.tsv"], l = lines(decls);
  refused(tool("assign.mjs", [writeTsv(l.filter((r) => !r.includes("\tSTATE_ROOT\t"))), "a"]), 1, /UNKNOWN artifact\/artifact-migration\.mjs STATE_ROOT/);
  refused(tool(editedAssign("`STATE_ROOT HISTORY_EVENT_KEYS`", "`STATE_ROOT HISTORY_EVENT_KEYS FEATURE_FILE`"), [decls, "a"]), 1, /DUPLICATE artifact\/artifact-migration\.mjs FEATURE_FILE/);
  refused(tool(editedAssign("`STATE_ROOT HISTORY_EVENT_KEYS`", "`STATE_ROOT`"), [decls, "a"]), 1, /MISSING artifact\/artifact-migration\.mjs:\d+ HISTORY_EVENT_KEYS/);
});

test("F2-4 an option-b override that matches nothing or changes nothing fails", { skip: noBase }, () => {
  const decls = baseData()["decls.tsv"];
  refused(tool(editedAssign(`[RM, "moduleEdgeTargetsFrom", "census"]`, `[RM, "noSuchBuilder", "census"]`), [decls, "b"]), 1, /OVERRIDE resumable-migration\.mjs noSuchBuilder matches no declaration/);
  refused(tool(editedAssign(`[RM, "moduleEdgeTargetsFrom", "census"]`, `[RM, "moduleEdgeTargetsFrom", "decisions"]`), [decls, "b"]), 1, /does not change its owner/);
});

test("F2-5 an empty table entry fails", { skip: noBase }, () => {
  refused(tool(editedAssign(`  ["migration-utils.mjs", "census", \`resolveLegacySources\`],`, `  ["migration-utils.mjs", "visual", \` \`],\n  ["migration-utils.mjs", "census", \`resolveLegacySources\`],`), [baseData()["decls.tsv"], "a"]), 1, /EMPTY migration-utils\.mjs visual fn/);
});

test("F2/A4 BASE: assign a and b own every declaration once; b moves exactly the four builders; both reproduce the committed rows", { skip: noBase }, () => {
  const b = baseData(), a = lines(b["owners.tsv"]), ob = lines(b["owners-b.tsv"]);
  assert.equal(a.length, lines(b["decls.tsv"]).filter((r) => r.split("\t")[3] !== "reexport").length);
  const changed = a.filter((r, i) => r !== ob[i]).map((r) => r.split("\t")[3]).sort();
  assert.deepEqual(changed, ["moduleDecisionCandidate", "moduleEdgeTargetsFrom", "pendingTargetDriftCandidates", "pendingVisualUnbackedCandidates"]);
  const sa = new Set(a), sb = new Set(ob);
  for (const r of lines(path.join(DATA, "owners.tsv"))) assert.ok(sa.has(r), r);
  for (const r of lines(path.join(DATA, "owners-b.tsv"))) assert.ok(sb.has(r), r);
  assert.equal(tool("assign.mjs", [shuffled(b["decls.tsv"]), "b"]).stdout, readFileSync(b["owners-b.tsv"], "utf8"));
});

test("A4 writesites: owned and wrapper-calls on BASE; every curated wrapper reaches a write", { skip: noBase }, () => {
  const b = baseData();
  const owned = tool("writesites.mjs", ["owned", b["owners.tsv"], b["writes.tsv"]]);
  assert.equal(owned.status, 0, owned.stderr);
  assert.equal(rowsOf(owned.stdout).length, lines(b["writes.tsv"]).length);
  const calls = tool("writesites.mjs", ["wrapper-calls", b["owners.tsv"], b["writes.tsv"], b["edges.tsv"]]);
  assert.equal(calls.status, 0, calls.stderr);
  const got = new Set(calls.stdout.trim().split("\n"));
  for (const r of lines(path.join(DATA, "wrapper-calls.tsv"))) assert.ok(got.has(r), r);
  assert.equal(tool("writesites.mjs", ["wrapper-calls", shuffled(b["owners.tsv"]), shuffled(b["writes.tsv"]), shuffled(b["edges.tsv"])]).stdout, calls.stdout);
});

test("A4 writesites keeps two identical write rows (two calls on one line)", () => {
  const r = tool("writesites.mjs", ["owned", writeTsv([O("a.mjs", "f", "store")]), writeTsv([["a.mjs", "2", "f", "rm"], ["a.mjs", "2", "f", "rm"]])]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "a.mjs\t2\tf\trm\tstore\na.mjs\t2\tf\trm\tstore\n");
});

test("A4 writesites refuses incomplete relationships", { skip: noBase }, () => {
  const b = baseData(), w = lines(b["writes.tsv"]);
  refused(tool("writesites.mjs", ["owned", b["owners.tsv"], writeTsv([...w, "a.mjs\t1\tGHOST\trm"])]), 1, /write owner a\.mjs GHOST is not in the owners/);
  const noAppend = writeTsv(w.filter((r) => !r.includes("\tappendDurably\t")));
  refused(tool("writesites.mjs", ["wrapper-calls", b["owners.tsv"], noAppend, b["edges.tsv"]]), 1, /wrapper record-decision\.mjs appendDurably reaches no write site/);
  const o = lines(b["owners.tsv"]).filter((r) => !r.includes("\twriteTree\t")), e = lines(b["edges.tsv"]).filter((r) => !r.includes("\twriteTree\t"));
  const ww = writeTsv(w.filter((r) => !r.includes("\twriteTree\t")));
  refused(tool("writesites.mjs", ["wrapper-calls", writeTsv(o), ww, writeTsv(e)]), 1, /wrapper upgrades\/upgrade-migration\.mjs writeTree is not in the owners/);
  refused(tool("writesites.mjs", ["owned", b["owners.tsv"], b["writes.tsv"], b["edges.tsv"]]), 2);
  refused(tool("writesites.mjs", ["bogus", b["owners.tsv"], b["writes.tsv"]]), 2);
});
