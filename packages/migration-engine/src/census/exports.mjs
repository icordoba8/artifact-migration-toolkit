/**
 * Census: the exported call contract of a module entry, derived from source --
 * never from an agent-authored spec or test.
 *
 * Legacy `quote(cart, options)` read `options.now`; a target that exports
 * `quote(cart, now)` passed every agent-authored test and broke every legacy
 * caller (M14 D1). The behavior was equivalent; the call contract was not. So
 * for each export an inbound consumer imports, the contract records whether it
 * is callable and, per positional parameter, which property keys the function
 * reads from it -- through aliases (`opts = options || {}`), destructuring
 * (`{ now } = {}`) and hand-offs to resolvable local functions in any file the
 * entry reaches by a relative import.
 *
 * Fail-open on purpose, so an equivalent migration is never refused on a guess:
 * a parameter whose use cannot be established (spread, returned, stored, handed
 * to an unresolvable callee, a computed key) is `open`, and an open target
 * parameter satisfies any legacy keys. An incompatibility is reported only when
 * the target provably drops an export, a callable, a used argument or a key.
 * A name declared again inside the function (a nested `const options`) is
 * `open` too, on either side, rather than guessed apart by scope.
 * Ceiling: no type checker, no tsconfig path aliases (non-relative imports are
 * unresolved), method calls on a parameter are not keys. Upgrade path: bind
 * engine-captured runtime calls from the legacy consumers.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isLexicallyWithin } from "../shared/index.mjs";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_HANDOFF_DEPTH = 12;
// Calls that only coerce or inspect a value as a scalar: the argument is used, no key is read.
const SCALAR_CALLS = new Set(["String", "Number", "Boolean", "BigInt", "Date", "parseInt", "parseFloat", "isNaN", "isFinite"]);
const SCALAR_NAMESPACES = new Set(["Math", "Number", "console"]);
const SCALAR_NEW = new Set(["Date", "Number", "String", "Boolean", "Error", "TypeError", "RangeError", "URL", "Set", "Map"]);
// Every value has these, so reading one says nothing about the argument's shape.
const NON_CONTRACT_KEYS = new Set(["length", "constructor"]);

const OPEN = Object.freeze({ keys: [], open: true, used: true });
const UNUSED = Object.freeze({ keys: [], open: false, used: false });
const USED = Object.freeze({ keys: [], open: false, used: true });
const merge = (shapes) => ({
  keys: [...new Set(shapes.flatMap((shape) => shape.keys))].sort(),
  open: shapes.some((shape) => shape.open),
  used: shapes.some((shape) => shape.used),
});

/** `{ resolve(spec, from), load(file) }` over one repository, reading only files inside it. */
export const sourceReader = (root) => {
  const texts = new Map();
  const load = async (relative) => {
    if (!texts.has(relative)) {
      const absolute = path.resolve(root, relative);
      texts.set(relative, isLexicallyWithin(root, absolute) ? await readFile(absolute, "utf8").catch(() => null) : null);
    }
    return texts.get(relative);
  };
  const resolve = async (spec, from) => {
    if (!spec.startsWith(".")) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    for (const candidate of [base, ...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => `${base}/index${ext}`)]) {
      if ((await load(candidate)) !== null) return candidate;
    }
    return null;
  };
  return { load, resolve };
};

/**
 * The analyzer over one repository. `contractOf(entry, symbols)` returns
 * `{ exports: { name: { kind, params?, rest? } }, unresolved }`, `kind` being
 * FUNCTION, CLASS, VALUE or UNRESOLVED; `symbols` is the imported names, `*`
 * for the whole module.
 */
export const exportAnalyzer = (ts, reader) => {
  const K = ts.SyntaxKind;
  const modules = new Map();
  const strip = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression?.(node) || ts.isSatisfiesExpression?.(node))) node = node.expression;
    return node;
  };
  const keyOf = (name) =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) ? name.text : null;
  const isFunction = (node) =>
    node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node));
  const requireSpec = (node) => {
    const call = strip(node);
    return call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "require" &&
      call.arguments.length === 1 && ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : null;
  };
  const isModuleExports = (node) => {
    const value = strip(node);
    return ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) &&
      value.expression.text === "module" && value.name.text === "exports";
  };

  // One file's declarations, imports and exports. ESM and CommonJS share the maps:
  // exports: name -> { node } | { local } | { spec, imported }; stars: re-exported specs.
  const moduleOf = async (file) => {
    if (modules.has(file)) return modules.get(file);
    const text = await reader.load(file);
    let unit = null;
    if (text !== null) {
      const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
      unit = { file, sf, decls: new Map(), imports: new Map(), exports: new Map(), stars: [], unresolved: false };
      const exported = (node) => node.modifiers?.some((m) => m.kind === K.ExportKeyword);
      const isDefault = (node) => node.modifiers?.some((m) => m.kind === K.DefaultKeyword);
      const exportObject = (object) => {
        for (const property of object.properties) {
          if (ts.isShorthandPropertyAssignment(property)) unit.exports.set(property.name.text, { local: property.name.text });
          else if (ts.isPropertyAssignment(property) && keyOf(property.name) !== null) unit.exports.set(keyOf(property.name), { node: property.initializer });
          else if (ts.isMethodDeclaration(property) && keyOf(property.name) !== null) unit.exports.set(keyOf(property.name), { node: property });
          else unit.unresolved = true;
        }
      };
      for (const statement of sf.statements) {
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) {
          if (statement.name) unit.decls.set(statement.name.text, statement);
          if (exported(statement)) unit.exports.set(isDefault(statement) ? "default" : statement.name.text, { node: statement });
        } else if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            // `require("x")`, `require("x").name` and `const { name } = require("x")`.
            const init = strip(decl.initializer);
            const member = init && ts.isPropertyAccessExpression(init);
            const call = init && (member ? init.expression : init);
            const spec = call && requireSpec(call);
            // The scan's REQUIRE edge line, so an edge finds the destructuring it came from.
            const line = spec ? sf.getLineAndCharacterOfPosition(strip(call).getStart(sf)).line + 1 : 0;
            if (ts.isIdentifier(decl.name)) {
              unit.decls.set(decl.name.text, decl);
              if (exported(statement)) unit.exports.set(decl.name.text, { local: decl.name.text });
              if (spec) unit.imports.set(decl.name.text, { spec, imported: member ? init.name.text : "*", line });
            } else if (ts.isObjectBindingPattern(decl.name) && spec) {
              for (const element of decl.name.elements) {
                if (ts.isIdentifier(element.name)) unit.imports.set(element.name.text, { spec, imported: keyOf(element.propertyName ?? element.name), line });
              }
            }
          }
        } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          const spec = statement.moduleSpecifier.text;
          const clause = statement.importClause;
          if (clause?.name) unit.imports.set(clause.name.text, { spec, imported: "default" });
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) unit.imports.set(bindings.name.text, { spec, imported: "*" });
          for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
            unit.imports.set(element.name.text, { spec, imported: (element.propertyName ?? element.name).text });
          }
        } else if (ts.isExportDeclaration(statement)) {
          const spec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
          if (!statement.exportClause) {
            if (spec) unit.stars.push(spec);
          } else if (ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
              const local = (element.propertyName ?? element.name).text;
              unit.exports.set(element.name.text, spec ? { spec, imported: local } : { local });
            }
          } else {
            unit.exports.set(statement.exportClause.name.text, spec ? { spec, imported: "*" } : { node: null });
          }
        } else if (ts.isExportAssignment(statement)) {
          unit.exports.set("default", { node: statement.expression });
        } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
          statement.expression.operatorToken.kind === K.EqualsToken) {
          const { left, right } = statement.expression;
          const target = strip(left);
          if (isModuleExports(target)) {
            const value = strip(right);
            const spec = requireSpec(value);
            const local = ts.isIdentifier(value) ? unit.decls.get(value.text) : null;
            const literal = ts.isObjectLiteralExpression(value) ? value
              : local && ts.isVariableDeclaration(local) && local.initializer && ts.isObjectLiteralExpression(strip(local.initializer)) ? strip(local.initializer) : null;
            unit.exports.clear();
            if (literal) exportObject(literal);
            else if (spec) unit.stars.push(spec);
            else unit.exports.set("default", { node: value });
          } else if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
            (isModuleExports(target.expression) || (ts.isIdentifier(strip(target.expression)) && strip(target.expression).text === "exports"))) {
            const key = ts.isPropertyAccessExpression(target) ? target.name.text : keyOf(target.argumentExpression);
            if (key === null) unit.unresolved = true;
            else unit.exports.set(key, { node: right });
          }
        }
      }
    }
    modules.set(file, unit);
    return unit;
  };

  // What a name or expression in `unit` evaluates to: { fn, unit } | { kind } | null.
  const valueOf = async (unit, node, seen = new Set()) => {
    const value = strip(node);
    if (!value) return null;
    if (isFunction(value)) return { fn: value, unit };
    if (ts.isClassDeclaration(value) || ts.isClassExpression(value)) return { kind: "CLASS" };
    if (ts.isVariableDeclaration(value)) return value.initializer ? valueOf(unit, value.initializer, seen) : null;
    if (ts.isIdentifier(value)) {
      const key = `${unit.file}#${value.text}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const imported = unit.imports.get(value.text);
      if (imported) {
        const file = await reader.resolve(imported.spec, unit.file);
        return file && imported.imported !== "*" ? exportValue(file, imported.imported, seen) : null;
      }
      const decl = unit.decls.get(value.text);
      return decl ? valueOf(unit, decl, seen) : null;
    }
    if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(strip(value.expression))) {
      // `ns.fn` through a namespace import or a CommonJS `require` binding.
      const imported = unit.imports.get(strip(value.expression).text);
      const file = imported?.imported === "*" && (await reader.resolve(imported.spec, unit.file));
      return file ? exportValue(file, value.name.text, seen) : null;
    }
    if (ts.isLiteralExpression(value) || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) ||
      [K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(value.kind)) return { kind: "VALUE" };
    return null;
  };

  // undefined: not exported; null: exported, value undecidable.
  const exportValue = async (file, name, seen = new Set()) => {
    const unit = await moduleOf(file);
    if (!unit) return null;
    const entry = unit.exports.get(name);
    if (entry) {
      if (entry.spec) {
        const from = await reader.resolve(entry.spec, file);
        return from && entry.imported !== "*" ? exportValue(from, entry.imported, seen) : null;
      }
      return entry.local ? valueOf(unit, unit.decls.get(entry.local) ?? ts.factory.createIdentifier(entry.local), seen) : valueOf(unit, entry.node, seen);
    }
    for (const spec of name === "default" ? [] : unit.stars) {
      const from = await reader.resolve(spec, file);
      const found = from ? await exportValue(from, name, seen) : null;
      if (found !== undefined) return found;
    }
    return unit.unresolved || (unit.stars.length > 0 && name !== "default") ? null : undefined;
  };

  const exportNames = async (file, seen = new Set()) => {
    const unit = await moduleOf(file);
    if (!unit || seen.has(file)) return { names: [], unresolved: true };
    seen.add(file);
    const names = new Set(unit.exports.keys());
    let unresolved = unit.unresolved;
    for (const spec of unit.stars) {
      const from = await reader.resolve(spec, file);
      const nested = from ? await exportNames(from, seen) : { names: [], unresolved: true };
      for (const name of nested.names) if (name !== "default") names.add(name);
      unresolved ||= nested.unresolved;
    }
    return { names: [...names].sort(), unresolved };
  };

  // --- parameter shapes ---------------------------------------------------
  const memo = new Map();
  const bindingKeys = (pattern) => {
    const keys = [];
    let open = false;
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) open = true;
      else {
        const key = keyOf(element.propertyName ?? element.name);
        if (key === null) open = true;
        else if (!NON_CONTRACT_KEYS.has(key)) keys.push(key);
      }
    }
    return { keys, open, used: true };
  };
  const shadows = (fn, name) =>
    fn.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);

  // How `name`, bound in `scope` (a function or its body), is used there. An
  // alias of itself (`options = options || {}`) is the binding already being read.
  const active = new Set();
  // `allowed`: declarations of `name` the scope may hold -- an alias's own, never a parameter's.
  const usesOf = async (unit, scope, name, depth, allowed = 0) => {
    const key = `${unit.file}:${scope.pos}:${name}`;
    if (active.has(key)) return USED;
    active.add(key);
    const references = [];
    let declared = 0;
    const visit = (node) => {
      if (isFunction(node) && node !== scope && shadows(node, name)) return;
      if (ts.isIdentifier(node) && node.text === name) {
        if (declares(node)) declared += 1;
        else if (!isDeclarationName(node)) references.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    if (declared > allowed) {
      active.delete(key);
      return OPEN;
    }
    const shapes = [];
    for (const reference of references) shapes.push(await useOf(unit, reference, depth));
    active.delete(key);
    return merge(shapes.length > 0 ? shapes : [UNUSED]);
  };
  const isDeclarationName = (node) => {
    const parent = node.parent;
    return ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node) ||
      ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node));
  };
  const declares = (node) => {
    const parent = node.parent;
    return parent.name === node && (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent));
  };
  const enclosingScope = (node) => {
    for (let at = node.parent; at; at = at.parent) if (isFunction(at) || ts.isSourceFile(at)) return at;
    return node.getSourceFile();
  };

  // One use of a value that is (an alias of) the argument.
  const useOf = async (unit, node, depth) => {
    while (node.parent && strip(node.parent) !== node.parent && node.parent.expression === node) node = node.parent;
    const parent = node.parent;
    if (!parent) return OPEN;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return USED;
      return { keys: NON_CONTRACT_KEYS.has(parent.name.text) ? [] : [parent.name.text], open: false, used: true };
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      const key = keyOf(parent.argumentExpression);
      return key === null ? OPEN : { keys: NON_CONTRACT_KEYS.has(key) ? [] : [key], open: false, used: true };
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if ([K.BarBarToken, K.QuestionQuestionToken, K.AmpersandAmpersandToken].includes(operator)) {
        // `options || {}` is the argument again; `a && b` yields b when a is truthy.
        return operator === K.AmpersandAmpersandToken && parent.left === node ? USED : useOf(unit, parent, depth);
      }
      if (operator === K.EqualsToken) {
        if (parent.left === node) return USED;
        const left = strip(parent.left);
        return ts.isIdentifier(left) ? usesOf(unit, enclosingScope(parent), left.text, depth, 1) : OPEN;
      }
      if (operator === K.InKeyword && parent.right === node) {
        const key = keyOf(parent.left);
        return key === null ? OPEN : { keys: [key], open: false, used: true };
      }
      return [K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken,
        K.LessThanToken, K.LessThanEqualsToken, K.GreaterThanToken, K.GreaterThanEqualsToken, K.PlusToken, K.MinusToken,
        K.AsteriskToken, K.SlashToken, K.PercentToken, K.InstanceOfKeyword, K.InKeyword].includes(operator)
        ? USED : OPEN;
    }
    if (ts.isConditionalExpression(parent)) {
      return parent.condition === node ? USED : useOf(unit, parent, depth);
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      if (ts.isObjectBindingPattern(parent.name)) return bindingKeys(parent.name);
      return ts.isIdentifier(parent.name) ? usesOf(unit, enclosingScope(parent), parent.name.text, depth, 1) : OPEN;
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return USED;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const index = parent.arguments?.indexOf(node) ?? -1;
      if (index < 0) return OPEN;
      const callee = strip(parent.expression);
      if (ts.isIdentifier(callee) && (ts.isNewExpression(parent) ? SCALAR_NEW : SCALAR_CALLS).has(callee.text) &&
        !unit.decls.has(callee.text) && !unit.imports.has(callee.text)) return USED;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && SCALAR_NAMESPACES.has(callee.expression.text) &&
        !unit.decls.has(callee.expression.text) && !unit.imports.has(callee.expression.text)) return USED;
      if (ts.isNewExpression(parent)) return OPEN;
      const target = await valueOf(unit, callee);
      return target?.fn ? parameterShape(target.unit, target.fn, index, depth + 1) : OPEN;
    }
    if (ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) ||
      ts.isTemplateSpan(parent) || ts.isExpressionStatement(parent) || ts.isCaseClause(parent) ||
      ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isSwitchStatement(parent)) && parent.expression === node) ||
      (ts.isForOfStatement(parent) && parent.expression === node)) return USED;
    return OPEN;
  };

  // The shape a function gives its `index`-th positional argument; `null` when it declares none there.
  const parameterShape = async (unit, fn, index, depth = 0) => {
    if (depth > MAX_HANDOFF_DEPTH) return OPEN;
    const key = `${unit.file}:${fn.pos}:${index}`;
    // A recursive hand-off back into this parameter adds nothing it does not already read.
    if (memo.has(key)) return memo.get(key) ?? USED;
    memo.set(key, null);
    const shape = await (async () => {
      const parameter = fn.parameters[index] ?? (fn.parameters.at(-1)?.dotDotDotToken ? fn.parameters.at(-1) : null);
      if (!parameter) return null;
      if (parameter.dotDotDotToken) return OPEN;
      if (ts.isObjectBindingPattern(parameter.name)) return bindingKeys(parameter.name);
      if (!ts.isIdentifier(parameter.name) || !fn.body) return { keys: [], open: !fn.body, used: true };
      return usesOf(unit, fn.body, parameter.name.text, depth);
    })();
    memo.set(key, shape);
    return shape;
  };
  const readsArguments = (fn) => {
    let found = false;
    const visit = (node) => {
      if (found || (node !== fn && isFunction(node) && !ts.isArrowFunction(node))) return;
      if (ts.isIdentifier(node) && node.text === "arguments") found = true;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    return found;
  };

  const describe = async (value) => {
    if (value === undefined) return { kind: "ABSENT" };
    if (!value) return { kind: "UNRESOLVED" };
    if (!value.fn) return { kind: value.kind };
    const params = [];
    for (let index = 0; index < value.fn.parameters.length; index += 1) {
      const shape = await parameterShape(value.unit, value.fn, index);
      params.push({ name: value.fn.parameters[index].name.getText(), ...shape });
    }
    return { kind: "FUNCTION", params, rest: Boolean(value.fn.parameters.at(-1)?.dotDotDotToken) || readsArguments(value.fn) };
  };

  const contractOf = async (entry, symbols) => {
    const listed = symbols.includes("*") ? await exportNames(entry) : { names: symbols, unresolved: false };
    const exports = {};
    for (const name of listed.names) exports[name] = await describe(await exportValue(entry, name));
    return { exports, unresolved: listed.unresolved };
  };
  /** What `file`'s top-level `require` of `entry` on `line` destructures; null when it binds the whole module. */
  const requiredNames = async (file, entry, line) => {
    const names = [];
    for (const binding of (await moduleOf(file))?.imports.values() ?? []) {
      if (binding.line !== line || (await reader.resolve(binding.spec, file)) !== entry) continue;
      if (binding.imported === "*" || binding.imported === null) return null;
      names.push(binding.imported);
    }
    return names.length > 0 ? names : null;
  };
  return { contractOf, describeExport: async (entry, name) => describe(await exportValue(entry, name)), requiredNames };
};

const signature = (name, contract) =>
  contract.kind === "FUNCTION" ? `${name}(${contract.params.map((param) => param.name).join(", ")})` : name;

/**
 * Every way the target breaks a legacy caller, one line each. A legacy export
 * whose value cannot be established carries no obligation; a target one that
 * cannot be established satisfies it.
 */
export const exportContractIssues = (legacy, target, { legacyEntry, targetEntry }) => {
  const issues = [];
  for (const [name, before] of Object.entries(legacy.exports)) {
    if (before.kind === "UNRESOLVED" || before.kind === "ABSENT") continue;
    const after = target.exports[name] ?? { kind: "ABSENT" };
    const where = `legacy ${legacyEntry} export '${signature(name, before)}'`;
    if (after.kind === "ABSENT") {
      issues.push(`${where} is not exported by ${targetEntry}.`);
      continue;
    }
    if (before.kind !== "FUNCTION" || after.kind === "UNRESOLVED") continue;
    if (after.kind !== "FUNCTION") {
      issues.push(`${where} is callable; ${targetEntry} exports '${name}' as a ${after.kind.toLowerCase()}.`);
      continue;
    }
    for (const [index, param] of before.params.entries()) {
      const now = after.params[index] ?? (after.rest ? OPEN : null);
      const position = `argument ${index + 1} ('${param.name}')`;
      if (!now) {
        if (param.used) issues.push(`${where} reads ${position}; target '${signature(name, after)}' declares no parameter there.`);
        continue;
      }
      const missing = now.open ? [] : param.keys.filter((key) => !now.keys.includes(key));
      if (missing.length > 0) {
        issues.push(`${where} reads ${missing.map((key) => `'${param.name}.${key}'`).join(", ")} from ${position}; target '${signature(name, after)}' never reads ${missing.length === 1 ? "that key" : "those keys"} from its argument ${index + 1} ('${after.params[index].name}').`);
      }
    }
  }
  return issues;
};
