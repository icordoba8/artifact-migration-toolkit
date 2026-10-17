/** Framework composition and externally rendered JSX imports for scanner v4. */

const NEXT_APP_FILES = new Set([
  "page", "layout", "template", "loading", "error", "global-error",
  "not-found", "default", "route", "forbidden", "unauthorized", "robots",
  "sitemap", "manifest", "icon", "apple-icon", "opengraph-image", "twitter-image",
]);
const NEXT_ROOT_FILES = new Set(["proxy", "middleware", "instrumentation", "instrumentation-client"]);

export const frameworkEntryFor = (relativePath) => {
  const segments = relativePath.split("/");
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  if (segments.includes("app") && NEXT_APP_FILES.has(base)) {
    return `Next.js app-directory convention '${base}'.`;
  }
  if (segments.length <= 2 && NEXT_ROOT_FILES.has(base)) {
    return `Next.js project-root convention '${base}'.`;
  }
  if (segments.length <= 2 && base.startsWith("next.config")) return "Next.js configuration.";
  return null;
};

export const externalJsxUses = (ts, fileName, text) => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const bindings = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    if (statement.importClause?.name) bindings.set(statement.importClause.name.text, { spec, symbol: "default" });
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const entry of named.elements) bindings.set(entry.name.text, {
        spec, symbol: entry.propertyName?.text ?? entry.name.text,
      });
    }
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { spec, symbol: "*" });
  }
  // `require("x")`, `require("x").Member`, or any `import("x")` inside the
  // initializer (`dynamic(() => import("x"))`, `lazy(...)`): the module is
  // known, a member only when it is spelled out; otherwise "*", never guessed.
  const required = (node) => {
    const call = ts.isPropertyAccessExpression(node) ? node.expression : node;
    if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !ts.isStringLiteralLike(call.arguments[0])) return null;
    if (!(ts.isIdentifier(call.expression) && call.expression.text === "require")) return null;
    return { spec: call.arguments[0].text, member: call === node ? null : node.name.text };
  };
  const dynamicImport = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) return node.arguments[0].text;
    return ts.forEachChild(node, dynamicImport);
  };
  const bindRequire = (node) => {
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)) {
      bindings.set(node.name.text, { spec: node.moduleReference.expression.text, symbol: "*" });
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const dynamic = required(node.initializer) ? undefined : dynamicImport(node.initializer);
      const module = required(node.initializer) ?? (dynamic ? { spec: dynamic, member: null } : null);
      if (module && ts.isIdentifier(node.name)) bindings.set(node.name.text, { spec: module.spec, symbol: module.member ?? "*" });
      if (module && !module.member && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          bindings.set(element.name.text, { spec: module.spec, symbol: property });
        }
      }
    }
    ts.forEachChild(node, bindRequire);
  };
  bindRequire(source);
  const uses = new Map();
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const root = ts.isIdentifier(tag) ? tag.text :
        ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) ? tag.expression.text : null;
      const imported = bindings.get(root);
      if (imported) {
        const symbol = imported.symbol === "*" && ts.isPropertyAccessExpression(tag)
          ? tag.name.text : imported.symbol;
        uses.set(JSON.stringify([imported.spec, symbol]), { spec: imported.spec, symbol });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...uses.values()];
};

export const frameworkAncestorEdges = async ({ routes, trackedSet, censusSet, extensions, assertSafe }) => {
  const edges = [];
  for (const route of routes) {
    const parts = route.split("/");
    const appIndex = parts.indexOf("app");
    if (appIndex < 0 || !/^page\.[^.]+$/.test(parts.at(-1))) continue;
    for (let depth = appIndex + 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join("/");
      for (const basename of ["layout", "template"]) {
        for (const extension of extensions) {
          const ancestor = `${directory}/${basename}${extension}`;
          if (!trackedSet.has(ancestor) || censusSet.has(ancestor) || !(await assertSafe(ancestor))) continue;
          edges.push({ from: ancestor, line: 0, kind: "FRAMEWORK_ANCESTOR", spec: route, to: route });
        }
      }
    }
  }
  return edges;
};
