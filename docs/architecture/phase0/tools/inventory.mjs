// Read-only inventory of engine source files at a git ref.
// usage: node inventory.mjs <repo> <ref> <mode>   mode: decls | writes | imports | fv
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const [repo, ref, mode] = process.argv.slice(2);
const ts = createRequire(`${repo}/package.json`)("./node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js");
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
const files = git("ls-tree", "-r", "--name-only", ref, "packages/migration-engine/src").split("\n").filter((f) => f.endsWith(".mjs"));
const WRITE = /^(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync|truncate|truncateSync|chmod|chmodSync|utimes|utimesSync|createWriteStream|open|openSync)$/;
const isFn = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
for (const file of files) {
  const text = git("show", `${ref}:${file}`);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const short = file.replace("packages/migration-engine/src/", "");
  // top-level owner of a node
  const owner = (n) => { let c = n; while (c.parent && c.parent !== sf) c = c.parent;
    if (ts.isFunctionDeclaration(c) || ts.isClassDeclaration(c)) return c.name?.text ?? "?";
    if (ts.isVariableStatement(c)) return c.declarationList.declarations.map((d) => d.name.getText(sf)).join(",");
    return "<top-level>"; };
  if (mode === "decls") {
    for (const s of sf.statements) {
      const exp = !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const span = sf.getLineAndCharacterOfPosition(s.end).line + 1 - line(s) + 1;
      if (ts.isFunctionDeclaration(s)) console.log([short, line(s), exp ? "E" : "I", "fn", s.name?.text, span].join("\t"));
      else if (ts.isClassDeclaration(s)) console.log([short, line(s), exp ? "E" : "I", "class", s.name?.text, span].join("\t"));
      else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations)
        console.log([short, line(s), exp ? "E" : "I", isFn(d.initializer) ? "fn" : "value", d.name.getText(sf), span].join("\t"));
      else if (ts.isExportDeclaration(s)) console.log([short, line(s), "E", "reexport", s.getText(sf).replace(/\s+/g, " ").slice(0, 160), span].join("\t"));
    }
  }
  if (mode === "writes" || mode === "fv") {
    const visit = (n) => {
      if (mode === "writes" && ts.isCallExpression(n)) {
        const e = n.expression;
        const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : "";
        const recv = ts.isPropertyAccessExpression(e) ? e.expression.getText(sf) : "";
        const fsLike = !recv || /^(fs|fsp|promises|fsPromises|fs\.promises|handle|fd|fileHandle)$/.test(recv);
        if (WRITE.test(name) && fsLike) {
          if (/^open(Sync)?$/.test(name) && !/["'`](w|a|wx|ax|r\+|w\+|a\+)/.test(n.getText(sf))) {} else
          console.log([short, line(n), owner(n), (recv ? recv + "." : "") + name].join("\t"));
        }
      }
      if (mode === "fv" && (ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) && /formatVersion|FORMAT_VERSION/.test(n.getText(sf)) && n.parent && ts.isBinaryExpression(n.parent) && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.parent.operatorToken.kind))
        console.log([short, line(n), owner(n), n.parent.getText(sf).replace(/\s+/g, " ").slice(0, 100)].join("\t"));
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  if (mode === "imports") {
    for (const s of sf.statements) if (ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier)) {
      const spec = s.moduleSpecifier.text; if (!spec.startsWith(".")) continue;
      const names = s.importClause?.namedBindings?.elements?.map((e) => (e.propertyName ?? e.name).text)
        ?? s.exportClause?.elements?.map((e) => (e.propertyName ?? e.name).text) ?? ["*"];
      if (s.importClause?.name) names.push("default");
      console.log([short, line(s), spec, names.join(",")].join("\t"));
    }
    // dynamic imports
    const visit = (n) => { if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text.startsWith("."))
      console.log([short, line(n), n.arguments[0].text, "dynamic"].join("\t")); ts.forEachChild(n, visit); };
    visit(sf);
  }
}
