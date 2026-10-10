// node --test docs/architecture/phase0/tools/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DATA, baseData, engineRepo, hasBase, rowsOf, tool } from "./fixture.mjs";

const graph = (files) => tool("callgraph.mjs", [engineRepo(files), "HEAD"]);
// Edges as "from>to via" strings (file names dropped when the fixture has one file).
const edgesOf = (files) => {
  const r = graph(files);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, "");
  return rowsOf(r.stdout).map(([ff, fn, tf, tn, , via]) => (Object.keys(files).length === 1 ? `${fn}>${tn} ${via}` : `${ff}:${fn}>${tf}:${tn} ${via}`));
};
const refused = (r, pattern) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.equal(r.stdout, ""); assert.match(r.stderr, pattern); };

test("F3-1 a block-local shadow does not hide an earlier top-level reference", () => {
  assert.deepEqual(edgesOf({ "a.mjs": "const target = () => 1;\nexport function f() { target(); { const target = 2; return target; } }\n" }), ["f>target local"]);
});

test("F3-2 parameter, catch, local, nested function and class shadowing produce no edge", () => {
  const src = `const target = 1;
export function g() { const target = 2; return target; }
export function h(target) { return target; }
export function i() { try {} catch (target) { return target; } }
export function j() { function target() {} return target(); }
export function k() { return class target { m() { return target; } }; }
`;
  assert.deepEqual(edgesOf({ "a.mjs": src }), []);
});

test("F3-3 each declarator owns only its own initializer", () => {
  assert.deepEqual(edgesOf({ "a.mjs": "const helper = () => 1;\nexport const x = helper(), y = 3;\n" }), ["x>helper local"]);
});

test("F3-4 a declarator may depend on its sibling", () => {
  assert.deepEqual(edgesOf({ "a.mjs": "export const a = 1, b = a;\n" }), ["b>a local"]);
});

test("F3-5 names that are not references produce no edges", () => {
  const src = `const target = 1, keys = 2, K = 3;
export const obj = { target: 0, keys() {}, [Symbol.iterator]: 0 };
export class C { target = 1; K() { return this.target; } }
export function f(o) { const { target: t, keys: k } = o; target: for (;;) { break target; } return o.target + t + k; }
export { target as renamed };
`;
  assert.deepEqual(edgesOf({ "a.mjs": src }), []);
});

test("F3-6 shorthand properties, renamed imports and default-less named imports are references", () => {
  const files = {
    "a.mjs": "export const helper = () => 1;\nexport const target = 2;\n",
    "b.mjs": 'import { helper as h, target } from "./a.mjs";\nexport const use = () => ({ target, n: h() });\n',
  };
  assert.deepEqual(edgesOf(files), ["b.mjs:use>a.mjs:helper import", "b.mjs:use>a.mjs:target import"]);
});

test("F3-7 re-export chains of any length and export * resolve to the original declaration", () => {
  const files = { "a0.mjs": "export const deep = 1;\nexport const star = 2;\n" };
  for (let i = 1; i <= 6; i++) files[`a${i}.mjs`] = `export { deep } from "./a${i - 1}.mjs";\n`;
  files["s.mjs"] = 'export * from "./a0.mjs";\n';
  files["use.mjs"] = 'import { deep } from "./a6.mjs";\nimport { star } from "./s.mjs";\nexport const u = () => deep + star;\n';
  assert.deepEqual(edgesOf(files), ["use.mjs:u>a0.mjs:deep import", "use.mjs:u>a0.mjs:star import"]);
});

test("F3-8 namespace imports: static members are edges; an escaping namespace fails without inventing edges", () => {
  const a = "export const helper = () => 1;\n";
  assert.deepEqual(edgesOf({ "a.mjs": a, "b.mjs": 'import * as ns from "./a.mjs";\nexport const f = () => ns.helper();\n' }), ["b.mjs:f>a.mjs:helper namespace"]);
  refused(graph({ "a.mjs": a, "b.mjs": 'import * as ns from "./a.mjs";\nconst use = () => {};\nexport const f = () => use(ns);\n' }), /module-only dependency: use\(ns\)/);
  refused(graph({ "a.mjs": a, "b.mjs": 'import * as ns from "./a.mjs";\nexport const f = () => ns.missing;\n' }), /ns\.missing does not resolve/);
});

test("F3-9 dynamic imports: lazy loaders, destructuring, bound and stored namespaces, .then", () => {
  const files = {
    "a.mjs": "export const helper = () => 1;\nexport const other = 2;\nexport const third = 3;\nexport const fourth = 4;\n",
    "b.mjs": `const lazy = () => import("./a.mjs");
export const f = async () => (await lazy()).helper();
export const g = async () => { const { other: o } = await import("./a.mjs"); return o; };
export const h = async () => { const m = await lazy(); return { m, v: m.third }; };
export const i = async () => (await h()).m.fourth;
export const j = () => import("./a.mjs").then((mod) => mod.helper());
export const k = () => import("./a.mjs").then(({ third }) => third);
export const l = async () => ({ mod: await lazy() });
`,
  };
  assert.deepEqual(edgesOf(files), ["b.mjs:f>a.mjs:helper dynamic", "b.mjs:f>b.mjs:lazy local", "b.mjs:g>a.mjs:other dynamic",
    "b.mjs:h>a.mjs:third dynamic", "b.mjs:h>b.mjs:lazy local", "b.mjs:i>a.mjs:fourth dynamic", "b.mjs:i>b.mjs:h local", "b.mjs:j>a.mjs:helper dynamic",
    "b.mjs:k>a.mjs:third dynamic", "b.mjs:l>b.mjs:lazy local"]);
});

test("F3-10 computed member access, non-literal specifiers and lossy flows fail", () => {
  const a = "export const helper = () => 1;\n";
  refused(graph({ "a.mjs": a, "b.mjs": 'export const f = async (k) => (await import("./a.mjs"))[k];\n' }), /module-only dependency/);
  refused(graph({ "a.mjs": a, "b.mjs": "export const f = async (s) => import(s);\n" }), /non-literal specifier/);
  refused(graph({ "a.mjs": a, "b.mjs": 'const use = (x) => x;\nexport const f = async () => use(await import("./a.mjs"));\n' }), /module-only dependency/);
  refused(graph({ "a.mjs": a, "b.mjs": 'export const f = async () => { const { ...all } = await import("./a.mjs"); return all; };\n' }), /module-only dependency/);
  refused(graph({ "a.mjs": a, "b.mjs": 'export const f = async () => { await import("./a.mjs"); };\n' }), /module-only dependency/);
  refused(graph({ "a.mjs": a, "b.mjs": 'export const f = () => import("./a.mjs").then(({ ...all }) => all);\n' }), /module-only dependency/);
});

test("F3-11 top-level statements belong to <module-init>", () => {
  assert.deepEqual(edgesOf({ "a.mjs": "const isMain = () => true;\nconst run = () => {};\nif (isMain()) run();\n" }), ["<module-init>>isMain local", "<module-init>>run local"]);
});

test("F3-12 an unresolved specifier, an unknown named import and a syntax error fail", () => {
  refused(graph({ "a.mjs": 'import { x } from "./missing.mjs";\nexport const f = () => x;\n' }), /does not resolve to an engine file/);
  refused(graph({ "a.mjs": "export const y = 1;\n", "b.mjs": 'import { x } from "./a.mjs";\nexport const f = () => x;\n' }), /does not resolve to a top-level declaration/);
  refused(graph({ "a.mjs": "export const f = () => {;\n" }), /syntax error/);
});

test("F3-13 recursion is not an edge", () => {
  assert.deepEqual(edgesOf({ "a.mjs": "export function f(n) { return n ? f(n - 1) : 0; }\nexport const g = (n) => (n ? g(n - 1) : 0);\n" }), []);
});

test("F3 count is reference occurrences, one row per via", () => {
  const r = graph({ "a.mjs": "export const t = 1;\n", "b.mjs": 'import { t } from "./a.mjs";\nexport const u = () => t + t + t;\n' });
  assert.deepEqual(rowsOf(r.stdout), [["b.mjs", "u", "a.mjs", "t", "3", "import"]]);
});

test("D-1 callgraph output is byte-identical across runs", () => {
  const repo = engineRepo({ "a.mjs": "export const t = 1;\nexport const v = () => t;\n", "b.mjs": 'import { t, v } from "./a.mjs";\nexport const u = () => t + v();\n' });
  assert.equal(tool("callgraph.mjs", [repo, "HEAD"]).stdout, tool("callgraph.mjs", [repo, "HEAD"]).stdout);
});

test("X-1 BASE: every endpoint and write owner is a declaration; old pairs all kept; additions are only module-init or dynamic", { skip: !hasBase() && "BASE commit not in this clone" }, () => {
  const b = baseData(), rows = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => l.split("\t"));
  const decls = new Set(rows(b["decls.tsv"]).filter((r) => r[3] !== "reexport").map((r) => `${r[0]}\t${r[4]}`));
  const edges = rows(b["edges.tsv"]);
  for (const e of edges) { assert.ok(decls.has(`${e[0]}\t${e[1]}`), e.join(" ")); assert.ok(decls.has(`${e[2]}\t${e[3]}`), e.join(" ")); }
  for (const w of rows(b["writes.tsv"])) assert.ok(decls.has(`${w[0]}\t${w[2]}`), w.join(" "));
  const pairs = new Set(edges.map((e) => e.slice(0, 4).join("\t")));
  const old = new Set(rows(path.join(DATA, "edges.tsv")).map((e) => e.slice(0, 4).join("\t")));
  for (const k of old) assert.ok(pairs.has(k), `lost ${k}`);
  for (const e of edges) if (!old.has(e.slice(0, 4).join("\t"))) assert.ok(e[1] === "<module-init>" || e[5] === "dynamic", e.join(" "));
});
