// Read-only: top-level declaration reference graph of packages/migration-engine/src at <ref>.
// usage: node callgraph.mjs <repo> <ref>  -> TSV: fromFile fromName toFile toName count
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
const [repo, ref] = process.argv.slice(2);
const ts = createRequire(`${repo}/package.json`)("./node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js");
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
const ROOT = "packages/migration-engine/src/";
const files = git("ls-tree", "-r", "--name-only", ref, ROOT).split("\n").filter((f) => f.endsWith(".mjs")).map((f) => f.slice(ROOT.length));
const parsed = new Map();
for (const f of files) parsed.set(f, ts.createSourceFile(f, git("show", `${ref}:${ROOT}${f}`), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
const resolve = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
// per file: top-level names, imports local->[file,name], re-exports name->[file,name]
const tops = new Map(), imports = new Map(), reexports = new Map();
for (const [f, sf] of parsed) {
  const t = new Set(), im = new Map(), re = new Map();
  for (const s of sf.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) t.add(s.name.text);
    else if (ts.isVariableStatement(s)) { for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) t.add(d.name.text); }
    else if (ts.isImportDeclaration(s) && s.moduleSpecifier.text.startsWith(".")) {
      const src = resolve(f, s.moduleSpecifier.text);
      for (const e of s.importClause?.namedBindings?.elements ?? []) im.set(e.name.text, [src, (e.propertyName ?? e.name).text]);
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier?.text.startsWith(".")) {
      const src = resolve(f, s.moduleSpecifier.text);
      for (const e of s.exportClause?.elements ?? []) re.set(e.name.text, [src, (e.propertyName ?? e.name).text]);
    }
  }
  tops.set(f, t); imports.set(f, im); reexports.set(f, re);
}
const origin = ([file, name], seen = 0) => (reexports.get(file)?.has(name) && seen < 5 ? origin(reexports.get(file).get(name), seen + 1) : [file, name]);
const edges = new Map();
for (const [f, sf] of parsed) {
  for (const s of sf.statements) {
    const owners = (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name ? [s.name.text]
      : ts.isVariableStatement(s) ? s.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => d.name.text) : [];
    if (!owners.length) continue;
    // ponytail: names declared anywhere inside the declaration shadow top-level ones (no per-block scoping).
    const locals = new Set();
    const collect = (n) => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n !== s) {
        const add = (b) => ts.isIdentifier(b) ? locals.add(b.text) : b.elements?.forEach((e) => e.name && add(e.name));
        if (!(ts.isVariableDeclaration(n) && n.parent?.parent === s)) add(n.name);
      } else if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n !== s && n.name) locals.add(n.name.text);
      ts.forEachChild(n, collect);
    };
    ts.forEachChild(s, collect);
    const visit = (n) => {
      if (ts.isIdentifier(n) && !locals.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
        let to = null;
        if (tops.get(f).has(n.text) && !owners.includes(n.text)) to = [f, n.text];
        else if (imports.get(f).has(n.text)) to = origin(imports.get(f).get(n.text));
        if (to) for (const o of owners) { const k = [f, o, to[0], to[1]].join("\t"); edges.set(k, (edges.get(k) ?? 0) + 1); }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(s, visit);
  }
}
for (const [k, c] of edges) console.log(`${k}\t${c}`);
