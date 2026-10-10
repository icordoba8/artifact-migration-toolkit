// Read-only inventory of engine source files at a git ref.
// usage: node inventory.mjs <repo> <ref> <decls|writes|imports|fv>
//   decls   file line E/I kind name span      kind: fn class value module-init reexport
//   writes  file line owner call              every fs mutation reached through an fs binding (see below)
//   imports file line specifier names         relative static and dynamic imports
//   fv      file line owner comparison        one row per formatVersion / FORMAT_VERSION comparison
// writes: fs bindings come from node:fs / fs / node:fs/promises / fs/promises imports, resolved by symbol,
// never by spelling. `open` counts only when its flags allow writing; a FileHandle (a binding that only ever
// holds `await open(...)`) counts its write methods. writeSync/write on a literal fd 0-2 is stdio, not a file.
// Fails (no output) on what it cannot classify: non-literal or non-zero numeric open flags, a handle or write
// primitive used as a value, computed fs access, require/import() of fs, unknown FileHandle methods.
// Not detected by design: child-process writes, non-fs streams, writes inside third-party packages.
import { engineProgram, forEachOwned, parseArgs, run, tsv, Failure, MODULE_INIT } from "./analysis.mjs";

const USAGE = "node inventory.mjs <repo> <ref> <decls|writes|imports|fv>";
const FS = new Map([["node:fs", "fs"], ["fs", "fs"], ["node:fs/promises", "fsp"], ["fs/promises", "fsp"]]);
const BASE_WRITES = ["writeFile", "appendFile", "write", "writev", "rename", "mkdir", "mkdtemp", "rm", "rmdir", "unlink", "copyFile", "cp", "symlink", "link",
  "truncate", "ftruncate", "chmod", "fchmod", "lchmod", "chown", "fchown", "lchown", "utimes", "futimes", "lutimes"];
const WRITES = new Set([...BASE_WRITES, ...BASE_WRITES.map((n) => `${n}Sync`), "createWriteStream"]);
const OPENS = new Set(["open", "openSync"]);
const WRITE_FLAGS = new Set(["O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND"]);
const HANDLE_WRITES = new Set(["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes"]);
const HANDLE_OTHER = new Set(["close", "sync", "datasync", "stat", "read", "readv", "readFile", "readLines", "createReadStream", "readableWebStream", "fd"]);

const main = () => {
  const { positional: [repo, ref, mode] } = parseArgs(process.argv.slice(2), { positional: [{ name: "repo" }, { name: "ref" }, { name: "mode", values: ["decls", "writes", "imports", "fv"] }] });
  const p = engineProgram(repo, ref), { ts, checker } = p, rows = [], problems = [];
  for (const { file, sf } of p.files) {
    const line = (n) => p.line(sf, n), at = (n) => `${file}:${line(n)}`;
    if (mode === "decls") {
      for (const b of p.bindingsOf.get(file)) rows.push([file, b.line, b.exported ? "E" : "I", b.kind, b.name, b.span]);
      for (const r of p.reexportsOf.get(file)) rows.push([file, r.line, "E", "reexport", r.text, r.span]);
    }
    if (mode === "imports") {
      for (const s of sf.statements) if (ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier)) {
        const spec = s.moduleSpecifier.text; if (!spec.startsWith(".")) continue;
        const names = s.importClause?.namedBindings?.elements?.map((e) => (e.propertyName ?? e.name).text)
          ?? s.exportClause?.elements?.map((e) => (e.propertyName ?? e.name).text) ?? ["*"];
        if (s.importClause?.name) names.push("default");
        rows.push([file, line(s), spec, names.join(",")]);
      }
      const visit = (n) => { if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0].text.startsWith("."))
        rows.push([file, line(n), n.arguments[0].text, "dynamic"]); ts.forEachChild(n, visit); };
      visit(sf);
    }
    if (mode === "fv") {
      const CMP = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
      const operand = (n) => (ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) && /formatVersion|FORMAT_VERSION/.test(n.getText(sf));
      forEachOwned(ts, sf, function visit(n, owner) {
        if (ts.isBinaryExpression(n) && CMP.has(n.operatorToken.kind) && (operand(n.left) || operand(n.right)))
          rows.push([file, line(n), owner, n.getText(sf).replace(/\s+/g, " ").slice(0, 100)]);
        ts.forEachChild(n, (c) => visit(c, owner));
      });
    }
    if (mode === "writes") writes(p, file, sf, rows, problems, at);
  }
  if (problems.length) throw new Failure(problems);
  return tsv(rows);
};

const writes = (p, file, sf, rows, problems, at) => {
  const { ts, checker } = p;
  const strip = (n) => { while (ts.isParenthesizedExpression(n)) n = n.expression; return n; };
  const up = (n) => { while (ts.isParenthesizedExpression(n.parent)) n = n.parent; return n; }; // outermost paren around n
  const fsImport = (symbol) => {
    const d = symbol?.flags & ts.SymbolFlags.Alias ? symbol.declarations?.[0] : null;
    const decl = d && (ts.isImportSpecifier(d) ? d.parent.parent.parent : ts.isNamespaceImport(d) ? d.parent.parent : ts.isImportClause(d) ? d.parent : null);
    const mod = decl && FS.get(decl.moduleSpecifier.text);
    if (!mod) return null;
    if (!ts.isImportSpecifier(d)) return { ns: mod };
    const name = (d.propertyName ?? d.name).text;
    return name === "default" ? { ns: mod } : member(mod, name);
  };
  const member = (mod, name) => (mod === "fs" && name === "promises" ? { ns: "fsp" } : name === "constants" ? { ns: "constants" } : { mod, name });
  // What an expression denotes in fs terms: { ns } for fs / fsp / constants, { mod, name } for a member, else null.
  const fsRef = (e, depth = 0) => {
    e = strip(e);
    if (ts.isIdentifier(e)) {
      const s = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? checker.getShorthandAssignmentValueSymbol(e.parent) : checker.getSymbolAtLocation(e);
      const viaImport = fsImport(s);
      if (viaImport) return viaImport;
      // `const w = writeFile` is followed one level.
      const d = s?.valueDeclaration;
      if (depth === 0 && d && ts.isVariableDeclaration(d) && d.initializer && d.parent.flags & ts.NodeFlags.Const) {
        const r = fsRef(d.initializer, 1);
        if (r?.name) return r;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(e)) { const r = fsRef(e.expression, depth); return r?.ns && r.ns !== "constants" ? member(r.ns, e.name.text) : r?.ns === "constants" ? { constant: e.name.text } : null; }
    return null;
  };
  const isFsLoad = (n) => ts.isCallExpression(n) && n.arguments.length && ts.isStringLiteralLike(n.arguments[0]) && FS.has(n.arguments[0].text)
    && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"));
  const flagsOf = (call) => {
    const arg = call.arguments[1];
    const set = new Set();
    const collect = (e) => {
      e = strip(e);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarToken) return collect(e.left) && collect(e.right);
      const c = fsRef(e)?.constant;
      if (c && /^O_[A-Z]+$/.test(c)) { set.add(c); return true; }
      return false;
    };
    if (!arg || ts.isFunctionLike(arg)) return "read";
    const a = strip(arg);
    if (ts.isStringLiteralLike(a)) return /[wa+]/.test(a.text) ? "write" : /^rs?$/.test(a.text) ? "read" : problems.push(`${at(a)}: unknown open flags ${a.getText(sf)}`) && null;
    if (ts.isNumericLiteral(a) && Number(a.text) === 0) return "read";
    if (!ts.isNumericLiteral(a) && collect(a)) return [...set].some((f) => WRITE_FLAGS.has(f)) ? "write" : "read";
    problems.push(`${at(a)}: cannot classify open flags ${a.getText(sf)} (numeric values differ by platform)`);
    return null;
  };
  // A handle expression: `await <fs/promises open>(...)`.
  const awaitedOpen = (e) => { e = strip(e); if (!ts.isAwaitExpression(e)) return null; const c = strip(e.expression); const r = ts.isCallExpression(c) && fsRef(c.expression); return r?.mod === "fsp" && r.name === "open" ? c : null; };
  const handles = new Set();
  const handleMethod = (pa, owner) => {
    const m = pa.name.text, call = ts.isCallExpression(pa.parent) && pa.parent.expression === pa ? pa.parent : null;
    if (HANDLE_WRITES.has(m) && call) rows.push([file, p.line(sf, call), owner, pa.getText(sf).replace(/\s+/g, " ")]);
    else if (!HANDLE_OTHER.has(m)) problems.push(`${at(pa)}: unsupported FileHandle use .${m}`);
  };
  const isNullish = (e) => { e = strip(e); return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined"); };
  forEachOwned(ts, sf, function visit(n, owner) {
    if (isFsLoad(n)) problems.push(`${at(n)}: fs loaded dynamically: ${n.getText(sf)}`);
    if (ts.isCallExpression(n)) {
      const r = fsRef(n.expression);
      const fd = n.arguments[0] && strip(n.arguments[0]);
      const stdio = fd && ts.isNumericLiteral(fd) && ["0", "1", "2"].includes(fd.text) && ["write", "writeSync"].includes(r?.name);
      if (r?.name && !stdio && (WRITES.has(r.name) || (OPENS.has(r.name) && flagsOf(n) === "write")))
        rows.push([file, p.line(sf, n), owner, n.expression.getText(sf).replace(/\s+/g, " ")]);
    }
    // A write primitive that is not the callee (nor a one-level const alias) is used as a value.
    if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      const r = fsRef(n), top = up(n), parent = top.parent;
      const callee = ts.isCallExpression(parent) && parent.expression === top;
      const alias = ts.isVariableDeclaration(parent) && (parent.name === top || (parent.initializer === top && parent.parent.flags & ts.NodeFlags.Const));
      const receiver = ts.isPropertyAccessExpression(parent) && parent.expression === top;
      if (r?.name && (WRITES.has(r.name) || OPENS.has(r.name)) && !callee && !alias) problems.push(`${at(n)}: fs write primitive used as a value: ${n.getText(sf)}`);
      if ((r?.ns === "fs" || r?.ns === "fsp") && !receiver)
        problems.push(ts.isElementAccessExpression(parent) ? `${at(n)}: computed fs access ${parent.getText(sf)}` : `${at(n)}: fs namespace used as a value: ${n.getText(sf)}`);
    }
    const open = awaitedOpen(n);
    if (open) {
      const top = up(n), parent = top.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === top) handleMethod(parent, owner);
      else if (ts.isVariableDeclaration(parent) && parent.initializer === top && ts.isIdentifier(parent.name)) handles.add(checker.getSymbolAtLocation(parent.name));
      else if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === top && ts.isIdentifier(parent.left))
        handles.add(checker.getSymbolAtLocation(parent.left));
      else problems.push(`${at(n)}: unsupported FileHandle flow: ${parent.getText(sf).slice(0, 80)}`);
    } else if (ts.isCallExpression(n) && fsRef(n.expression)?.mod === "fsp" && fsRef(n.expression).name === "open" && !ts.isAwaitExpression(up(n).parent))
      problems.push(`${at(n)}: unsupported FileHandle flow: open() is not awaited`);
    ts.forEachChild(n, (c) => visit(c, owner));
  });
  if (!handles.size) return;
  // Second pass: every use of a handle binding is a method call, a test, or an assignment of another handle.
  forEachOwned(ts, sf, function visit(n, owner) {
    if (ts.isIdentifier(n) && handles.has(checker.getSymbolAtLocation(n))) {
      const top = up(n), parent = top.parent;
      const op = ts.isBinaryExpression(parent) ? parent.operatorToken.kind : null, K = ts.SyntaxKind;
      if (ts.isVariableDeclaration(parent) && parent.name === n) {
        if (parent.initializer && !awaitedOpen(parent.initializer) && !isNullish(parent.initializer)) problems.push(`${at(n)}: handle ${n.text} also holds a non-handle value`);
      } else if (op === K.EqualsToken && parent.left === top) {
        if (!awaitedOpen(parent.right) && !isNullish(parent.right)) problems.push(`${at(n)}: handle ${n.text} also holds a non-handle value`);
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === top) handleMethod(parent, owner);
      else if (!((ts.isPrefixUnaryExpression(parent) && parent.operator === K.ExclamationToken)
        || [K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(op)
        || (op === K.AmpersandAmpersandToken && parent.left === top)
        || (ts.isIfStatement(parent) && parent.expression === top) || (ts.isConditionalExpression(parent) && parent.condition === top)))
        problems.push(`${at(n)}: handle ${n.text} escapes: ${parent.getText(sf).replace(/\s+/g, " ").slice(0, 80)}`);
    }
    ts.forEachChild(n, (c) => visit(c, owner));
  });
};

run(USAGE, main);
