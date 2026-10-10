// Shared analysis boundary for the Phase 0 tools: argument and TSV contracts, the module registry,
// declaration identities, the engine program, and emit-after-validate. Every tool imports it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Rank per owner module. The four middle-tier modules share one rank unless --layer-order orders them.
export const MODULES = Object.freeze({ transport: 9, lifecycle: 8, decisions: 3, slices: 3, census: 3, visual: 3, store: 2, formats: 1, "unassigned:leaf": 0 });
export const MIDDLE = Object.freeze(["decisions", "slices", "census", "visual"]);
export const KINDS = Object.freeze(["fn", "class", "value", "module-init"]);
export const VIA = Object.freeze(["local", "import", "namespace", "dynamic"]);
export const MODULE_INIT = "<module-init>";
export const ENGINE_SRC = "packages/migration-engine/src/";

export class UsageError extends Error {}
export class Failure extends Error {
  constructor(problems) { super(problems.join("\n")); this.problems = problems; }
}
export const failIf = (problems) => { if (problems.length) throw new Failure(problems); };

// Runs a tool: nothing reaches stdout unless body() returns; usage errors exit 2, any other problem exits 1.
export const run = (usage, body) => {
  let out;
  try { out = body(); } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`usage error: ${error.message}\nusage: ${usage}\n`); process.exitCode = 2; return; }
    process.stderr.write(error instanceof Failure ? error.problems.map((p) => `error: ${p}\n`).join("") : `error: ${error.stack}\n`);
    process.exitCode = 1; return;
  }
  process.stdout.write(out);
};

// spec: { positional: [{ name, values? }], flags: { name: (value|true) => problem string | null } }
export const parseArgs = (argv, spec) => {
  const positional = [], flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [, name, value] = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg) ?? [];
    if (!name || !(name in (spec.flags ?? {}))) throw new UsageError(`unknown option ${JSON.stringify(arg)}`);
    if (name in flags) throw new UsageError(`option --${name} given twice`);
    const problem = spec.flags[name](value ?? true);
    if (problem) throw new UsageError(`--${name}: ${problem}`);
    flags[name] = value ?? true;
  }
  if (positional.length !== spec.positional.length)
    throw new UsageError(`expected ${spec.positional.length} arguments (${spec.positional.map((p) => p.name).join(" ")}), got ${positional.length}`);
  spec.positional.forEach((p, i) => {
    if (p.values && !p.values.includes(positional[i])) throw new UsageError(`${p.name} must be one of ${p.values.join(", ")}; got ${JSON.stringify(positional[i])}`);
  });
  return { positional, flags };
};

// Total order used for every TSV: column by column, numerically when both cells are integers.
const compareRows = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? "", y = b[i] ?? "";
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
};
export const tsv = (rows) => {
  const cells = rows.map((r) => r.map(String));
  const bad = cells.filter((r) => r.some((c) => c === "" || /[\t\n\r]/.test(c)));
  if (bad.length) throw new Error(`refusing to emit a row with an empty or tab/newline cell: ${JSON.stringify(bad[0])}`);
  return cells.sort(compareRows).map((r) => `${r.join("\t")}\n`).join("");
};

// columns: [{ name, re? , values? }]; key(row), when given, must be unique. Reports every problem with its line number.
export const readTsv = (file, { columns, key }) => {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) { throw new Failure([`${file}: cannot read (${error.code ?? error.message})`]); }
  if (text !== "" && !text.endsWith("\n")) text += "\n"; // shortcut: a missing final newline is tolerated, nothing else
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  const problems = [], seen = new Map(), rows = [];
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`, row = line.split("\t");
    if (row.length !== columns.length) { problems.push(`${at}: expected ${columns.length} columns, got ${row.length}`); return; }
    columns.forEach((c, j) => {
      const v = row[j];
      if (v === "") problems.push(`${at}: empty ${c.name}`);
      else if (c.values && !c.values.includes(v)) problems.push(`${at}: ${c.name} ${JSON.stringify(v)} is not one of ${c.values.join(", ")}`);
      else if (c.re && !c.re.test(v)) problems.push(`${at}: ${c.name} ${JSON.stringify(v)} is malformed`);
    });
    const k = key?.(row);
    if (k === undefined) { rows.push(row); return; }
    if (seen.has(k)) problems.push(`${at}: duplicate ${JSON.stringify(k.replaceAll("\t", " "))} (first at line ${seen.get(k)})`);
    else seen.set(k, i + 1);
    rows.push(row);
  });
  failIf(problems);
  return rows;
};

const INT = /^[1-9]\d*$/, NAME = /^(?:[A-Za-z_$][\w$]*|<module-init>)$/, FILE = /^[\w./-]+\.mjs$/;
export const OWNER_COLUMNS = [{ name: "file", re: FILE }, { name: "line", re: INT }, { name: "export", values: ["E", "I"] }, { name: "name", re: NAME },
  { name: "module", values: Object.keys(MODULES) }, { name: "span", re: INT }, { name: "kind", values: KINDS }];
export const EDGE_COLUMNS = [{ name: "fromFile", re: FILE }, { name: "fromName", re: NAME }, { name: "toFile", re: FILE }, { name: "toName", re: NAME },
  { name: "count", re: INT }, { name: "via", values: VIA }];
export const WRITE_COLUMNS = [{ name: "file", re: FILE }, { name: "line", re: INT }, { name: "owner", re: NAME }, { name: "call", re: /^\S(?:.*\S)?$/ }];
export const readOwners = (file) => readTsv(file, { columns: OWNER_COLUMNS, key: (r) => `${r[0]}\t${r[3]}` });
// No unique key: two identical calls on one line are two write sites.
export const readWrites = (file) => readTsv(file, { columns: WRITE_COLUMNS });
// Every edge endpoint must be an owned declaration.
export const readEdges = (file, owners) => {
  const rows = readTsv(file, { columns: EDGE_COLUMNS, key: (r) => [r[0], r[1], r[2], r[3], r[5]].join("\t") });
  const known = new Set(owners.map((r) => `${r[0]}\t${r[3]}`)), problems = [];
  rows.forEach((r, i) => {
    for (const [f, n] of [[r[0], r[1]], [r[2], r[3]]]) if (!known.has(`${f}\t${n}`)) problems.push(`${file}:${i + 1}: endpoint ${f} ${n} is not in the owners`);
  });
  failIf(problems);
  return rows;
};

// The engine's pinned TypeScript alias, resolved from this toolkit checkout (not from the analyzed repo).
const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const loadTypeScript = () => {
  const ts = createRequire(path.join(TOOLKIT, "packages/migration-engine/package.json"))("ts-discovery-compiler");
  if (ts.version !== "5.9.3") throw new Failure([`ts-discovery-compiler is ${ts.version}; these tools are verified against 5.9.3`]);
  return ts;
};

const isExported = (ts, s) => !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

// The only definition of a declaration identity: (file, name). Problems are returned, not thrown.
export const topLevelBindings = (ts, sf, file) => {
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const span = (n) => sf.getLineAndCharacterOfPosition(n.end).line + 1 - line(n) + 1;
  const bindings = [], reexports = [], init = [], problems = [];
  const isFn = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  for (const s of sf.statements) {
    const base = { file, exported: isExported(ts, s), line: line(s), span: span(s), statement: s };
    if (ts.isImportDeclaration(s) || ts.isEmptyStatement(s)) continue;
    if (ts.isExportDeclaration(s)) reexports.push({ ...base, text: s.getText(sf).replace(/\s+/g, " ").slice(0, 160) });
    else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name)
      bindings.push({ ...base, name: s.name.text, kind: ts.isClassDeclaration(s) ? "class" : "fn", node: s });
    else if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isExportAssignment(s))
      problems.push(`${file}:${line(s)}: unsupported construct: default export`);
    else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) { problems.push(`${file}:${line(d)}: unsupported construct: top-level destructuring declaration`); continue; }
        bindings.push({ ...base, name: d.name.text, kind: isFn(d.initializer) ? "fn" : "value", node: d });
      }
    } else init.push(s);
  }
  if (init.length) bindings.push({ file, exported: false, line: line(init[0]), span: init.reduce((n, s) => n + span(s), 0), name: MODULE_INIT, kind: "module-init", node: null, statements: init });
  const seen = new Set();
  for (const b of bindings) { if (seen.has(b.name)) problems.push(`${file}:${b.line}: duplicate top-level declaration ${b.name}`); seen.add(b.name); }
  return { bindings, reexports, problems };
};

const gitIn = (repo) => (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
export const resolveCommit = (repo, ref) => {
  try { return gitIn(repo)("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).trim(); } catch { throw new UsageError(`${JSON.stringify(ref)} is not a commit in ${repo}`); }
};

// One TypeScript program over every engine .mjs blob at <ref>, on a virtual root that sees only those files
// and lib.es2022 (needed to type `await import(...)`). Fails on syntax errors and on unresolved engine specifiers.
export const engineProgram = (repo, ref) => {
  const ts = loadTypeScript(), commit = resolveCommit(repo, ref), git = gitIn(repo);
  const ROOT = "/__engine__/";
  const names = git("ls-tree", "-r", "--name-only", commit, "--", ENGINE_SRC).split("\n").filter((f) => f.endsWith(".mjs")).map((f) => f.slice(ENGINE_SRC.length));
  if (!names.length) throw new Failure([`no ${ENGINE_SRC}**/*.mjs at ${ref}`]);
  const text = new Map(names.map((f) => [ROOT + f, git("show", `${commit}:${ENGINE_SRC}${f}`)]));
  const options = { allowJs: true, checkJs: false, noEmit: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], types: [] };
  const host = ts.createCompilerHost(options), libDir = path.dirname(ts.getDefaultLibFilePath(options));
  const real = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  const isLib = (f) => f.startsWith(libDir + path.sep);
  Object.assign(host, {
    getCurrentDirectory: () => ROOT, realpath: (f) => f, useCaseSensitiveFileNames: () => true, getCanonicalFileName: (f) => f,
    fileExists: (f) => text.has(f) || (isLib(f) && real.fileExists(f)),
    readFile: (f) => text.get(f) ?? (isLib(f) ? real.readFile(f) : undefined),
    directoryExists: (d) => d === libDir || [...text.keys()].some((f) => f.startsWith(d.endsWith("/") ? d : `${d}/`)),
    getDirectories: () => [],
    getSourceFile: (f, v) => text.has(f) ? ts.createSourceFile(f, text.get(f), v, true, ts.ScriptKind.JS) : isLib(f) ? real.getSourceFile(f, v) : undefined,
  });
  const program = ts.createProgram([...text.keys()], options, host), checker = program.getTypeChecker();
  const files = names.map((f) => ({ file: f, sf: program.getSourceFile(ROOT + f) }));
  const problems = [], byNode = new Map(), bindingsOf = new Map(), reexportsOf = new Map();
  const where = (sf, n) => `${sf.fileName.slice(ROOT.length)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  for (const { file, sf } of files) {
    for (const d of program.getSyntacticDiagnostics(sf)) problems.push(`${file}:${sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    const t = topLevelBindings(ts, sf, file);
    problems.push(...t.problems);
    bindingsOf.set(file, t.bindings); reexportsOf.set(file, t.reexports);
    for (const b of t.bindings) if (b.node) byNode.set(b.node, b);
  }
  // Resolves a symbol (through aliases and re-export chains) to a top-level binding, or null.
  const bindingOf = (symbol) => {
    if (!symbol) return null;
    const s = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return byNode.get(s.valueDeclaration ?? s.declarations?.[0]) ?? null;
  };
  const isModuleSymbol = (symbol) => {
    const s = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return !!s?.declarations?.some((d) => ts.isSourceFile(d) && text.has(d.fileName));
  };
  const specifierOf = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null);
  const resolvesTo = (sf, spec) => text.has(path.posix.join(path.posix.dirname(sf.fileName), spec));
  for (const { sf } of files) {
    const visit = (n) => {
      const isImportCall = ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const specNode = ts.isImportDeclaration(n) || ts.isExportDeclaration(n) ? n.moduleSpecifier : isImportCall ? n.arguments[0] : null;
      if (isImportCall && specifierOf(specNode) === null) problems.push(`${where(sf, n)}: unresolvable dynamic import: non-literal specifier`);
      const spec = specNode && specifierOf(specNode);
      if (spec?.startsWith(".") && !resolvesTo(sf, spec)) problems.push(`${where(sf, n)}: specifier ${JSON.stringify(spec)} does not resolve to an engine file`);
      // Every named engine import and re-export must reach a top-level binding.
      if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n))) {
        const decl = ts.isImportSpecifier(n) ? n.parent.parent.parent : n.parent.parent;
        const from = decl.moduleSpecifier && specifierOf(decl.moduleSpecifier);
        if ((from === undefined || from?.startsWith(".")) && !bindingOf(checker.getSymbolAtLocation(n.name)) && !isModuleSymbol(checker.getSymbolAtLocation(n.name)))
          problems.push(`${where(sf, n)}: ${n.getText(sf)} does not resolve to a top-level declaration`);
      }
      if (ts.isImportClause(n) && n.name && specifierOf(n.parent.moduleSpecifier)?.startsWith(".") && !bindingOf(checker.getSymbolAtLocation(n.name)))
        problems.push(`${where(sf, n)}: default import ${n.name.text} does not resolve to a top-level declaration`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  failIf(problems);
  return { ts, program, checker, commit, files, bindingsOf, reexportsOf, bindingOf, isModuleSymbol, where,
    line: (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 };
};

// Walks each top-level statement with its owning identity: a function/class name, one declarator, or <module-init>.
// Import and export-list statements are not executable and get no owner.
export const forEachOwned = (ts, sf, visit) => {
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isEmptyStatement(s)) continue;
    if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) ts.forEachChild(s, (n) => visit(n, s.name.text));
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) d.initializer && visit(d.initializer, d.name.text);
    else visit(s, MODULE_INIT);
  }
};
