// Read-only: top-level declaration reference graph of packages/migration-engine/src at <ref>.
// usage: node callgraph.mjs <repo> <ref>  -> TSV: fromFile fromName toFile toName count via
// References are resolved by the TypeScript checker (lexical scope, aliases, re-export chains), per declarator;
// top-level statements belong to <module-init>. count = reference occurrences; via = local | import | namespace | dynamic.
// A namespace or dynamically imported module may only be read through a static member or destructuring; any other use
// (escaping, computed access, an unknown member, a loader or module-holding object passed on, a named or member-less
// `.then` callback, a JSDoc type that hides the module) fails the run, so no declaration edge is ever guessed.
import { engineProgram, forEachOwned, parseArgs, run, tsv, Failure } from "./analysis.mjs";

const USAGE = "node callgraph.mjs <repo> <ref>";

const main = () => {
  const { positional: [repo, ref] } = parseArgs(process.argv.slice(2), { positional: [{ name: "repo" }, { name: "ref" }] });
  const p = engineProgram(repo, ref), { ts, checker } = p, edges = new Map(), problems = [];
  // The engine module a value denotes (namespace types only); used to resolve member reads.
  const moduleOf = (type) => (type?.isUnion() ? type.types.map(moduleOf).find(Boolean) ?? null : p.isModuleSymbol(type?.symbol) ? type.symbol : null);
  // How a value carries an engine namespace: "namespace", "promise" of one, "object" (literal or anonymous) holding one in a property,
  // or "function" returning one (a loader or a method).
  const kinds = new Map();
  const carrier = (type) => {
    if (!type) return null;
    if (kinds.has(type)) return kinds.get(type);
    kinds.set(type, null); // cycle guard
    let kind = null;
    if (type.isUnion()) kind = type.types.map(carrier).find(Boolean) ?? null;
    else if (moduleOf(type)) kind = "namespace";
    else if (type.symbol?.name === "Promise" && checker.getTypeArguments(type).some(carrier)) kind = "promise";
    // Not only ObjectLiteral: a JS return value widens to JSLiteral, and a spread to a plain Anonymous type.
    else if (type.flags & ts.TypeFlags.Object && type.objectFlags & (ts.ObjectFlags.ObjectLiteral | ts.ObjectFlags.JSLiteral | ts.ObjectFlags.Anonymous)
      && type.getProperties().some((s) => carrier(checker.getTypeOfSymbol(s)))) kind = "object";
    else if (type.getCallSignatures().some((s) => carrier(s.getReturnType()))) kind = "function";
    kinds.set(type, kind);
    return kind;
  };
  const strip = (n) => { while (ts.isParenthesizedExpression(n)) n = n.expression; return n; };
  const up = (n) => { while (ts.isParenthesizedExpression(n.parent)) n = n.parent; return n; };
  const bindingKey = (n) => ts.isBindingElement(n.parent) && n.parent.propertyName === n;
  const isStaticNamespace = (e) => {
    const d = ts.isIdentifier(strip(e)) && checker.getSymbolAtLocation(strip(e))?.declarations?.[0];
    return !!d && (ts.isNamespaceImport(d) || ts.isImportClause(d));
  };
  for (const { file, sf } of p.files) {
    const at = (n) => `${file}:${p.line(sf, n)}`;
    const edge = (owner, target, via) => {
      if (target.file === file && target.name === owner) return; // recursion is not a dependency
      const k = [file, owner, target.file, target.name, via].join("\t");
      edges.set(k, (edges.get(k) ?? 0) + 1);
    };
    // A value carrying a namespace may only be read by static member, called (a loader), awaited, bound, destructured, returned
    // or stored in an object literal, and only where the receiving binding, cast or return type still carries it, so later
    // reads are checked too. `.then` takes only an inline callback whose first parameter carries it. Anything else fails.
    const keeps = (node) => !!carrier(checker.getTypeAtLocation(node));
    const returnKeeps = (node) => {
      while (!ts.isFunctionLike(node)) node = node.parent;
      // shortcut: class instances are not tracked as carriers, so a class member may not hand a module out at all.
      return !ts.isClassLike(node.parent) && !!carrier(checker.getSignatureFromDeclaration(node)?.getReturnType());
    };
    const thenKeeps = (member) => {
      const call = member.parent, cb = ts.isCallExpression(call) && call.expression === member && call.arguments[0] && strip(call.arguments[0]);
      return !!cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length > 0 && keeps(cb.parameters[0]);
    };
    const usedSafely = (top, parent, kind) => {
      if (ts.isPropertyAccessExpression(parent) && parent.expression === top)
        return kind === "namespace" || kind === "object" || (kind === "promise" && (["catch", "finally"].includes(parent.name.text) || (parent.name.text === "then" && thenKeeps(parent))));
      if (ts.isCallExpression(parent) && parent.expression === top) return kind === "function";
      if (ts.isAwaitExpression(parent) || (ts.isPropertyAssignment(parent) && parent.initializer === top) || ts.isShorthandPropertyAssignment(parent)) return true;
      if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === top)) return returnKeeps(parent);
      if (ts.isVariableDeclaration(parent) && parent.initializer === top) {
        const pattern = parent.name;
        if (ts.isIdentifier(pattern)) return keeps(pattern);
        return (kind === "namespace" || kind === "object") && ts.isObjectBindingPattern(pattern) && keeps(pattern)
          && pattern.elements.every((e) => !e.dotDotDotToken && (!e.propertyName || ts.isIdentifier(e.propertyName)) && ts.isIdentifier(e.name));
      }
      return false;
    };
    const checkModuleUse = (n, kind) => {
      const top = up(n), parent = top.parent;
      if ((top === n || keeps(top)) && usedSafely(top, parent, kind)) return;
      problems.push(`${at(n)}: module-only dependency: ${parent.getText(sf).replace(/\s+/g, " ").slice(0, 80)}`);
    };
    forEachOwned(ts, sf, function visit(n, owner) {
      if (ts.isIdentifier(n) || ts.isCallExpression(n) || ts.isAwaitExpression(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isObjectLiteralExpression(n)
        || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const declName = ts.isIdentifier(n) && n.parent && n.parent.name === n && (ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent)
          || ts.isBindingElement(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isMethodDeclaration(n.parent)
          || ts.isFunctionDeclaration(n.parent) || ts.isFunctionExpression(n.parent));
        const memberName = ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
        const type = !declName && !memberName && !bindingKey(n) ? checker.getTypeAtLocation(n) : null;
        const kind = carrier(type);
        if (kind) checkModuleUse(n, kind);
      }
      if (ts.isIdentifier(n) && !bindingKey(n) && !(ts.isBindingElement(n.parent) && n.parent.name === n)) {
        const shorthand = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n;
        const symbol = shorthand ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
        const receiver = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent.expression : null;
        const fromModule = receiver && moduleOf(checker.getTypeAtLocation(receiver));
        const target = p.bindingOf(symbol);
        if (fromModule && !target) problems.push(`${at(n)}: ${n.parent.getText(sf)} does not resolve to a top-level declaration`);
        else if (target) {
          const via = fromModule ? (isStaticNamespace(receiver) ? "namespace" : "dynamic")
            : symbol.flags & ts.SymbolFlags.Alias ? "import" : target.file === file ? "local" : null;
          if (via) edge(owner, target, via);
          else problems.push(`${at(n)}: unclassified cross-file reference ${n.text}`);
        }
      }
      // Destructuring keys read members: `const { a, b: c } = <module>` or `({ a }) =>` on a module is a reference to each member.
      const typed = ts.isObjectBindingPattern(n) && (ts.isVariableDeclaration(n.parent) ? n.parent.initializer : ts.isParameter(n.parent) ? n.parent : null);
      const module = typed && moduleOf(checker.getTypeAtLocation(typed));
      if (module) for (const e of n.elements) {
        if (e.dotDotDotToken || (e.propertyName && !ts.isIdentifier(e.propertyName))) { problems.push(`${at(e)}: module-only dependency: ${e.getText(sf)}`); continue; }
        const key = (e.propertyName ?? e.name).text, target = p.bindingOf(checker.tryGetMemberInModuleExports(key, module));
        if (target) edge(owner, target, ts.isVariableDeclaration(n.parent) && isStaticNamespace(typed) ? "namespace" : "dynamic");
        else problems.push(`${at(e)}: ${key} is not a top-level declaration of ${module.name}`);
      }
      ts.forEachChild(n, (c) => visit(c, owner));
    });
  }
  if (problems.length) throw new Failure(problems);
  return tsv([...edges].map(([k, c]) => { const [ff, fn, tf, tn, via] = k.split("\t"); return [ff, fn, tf, tn, c, via]; }));
};

run(USAGE, main);
