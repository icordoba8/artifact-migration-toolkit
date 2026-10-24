/**
 * Census: the CommonJS half of the structural contract census (M13). Split
 * from `scan.mjs` by ownership; `structuralUnits` is its only caller and hands
 * it the shared unit sink and the local-binding resolver so both module
 * systems resolve structures identically.
 */
// The exported root of a CommonJS module. `exports.x` and `module.exports.x`
// name the same object, so both census under this one prefix.
const CJS_ROOT = "module.exports";

/**
 * The CommonJS half of `structuralUnits`: `module.exports = ...`,
 * `exports.name = ...`, `module.exports.name = ...` and their bracketed forms,
 * resolved through local bindings exactly as ESM exports are. Anything that
 * touches the export object in a way this walk cannot decide -- a computed key,
 * a write inside a function or branch, the object handed to another call, a
 * repeated root assignment, a `require()` re-export -- is surfaced with
 * `resolved: false`, never dropped, so a CommonJS file can no longer leave the
 * completeness universe with zero units.
 * shortcut: a local binding or parameter named `exports`/`module` is not
 * tracked as shadowing; it over-reports (fail-safe), upgrade if that is noisy.
 */
export const commonJsUnits = (ts, source, locals, { add, descend }) => {
  const units = new Map();
  // A later, weaker observation of the same path may only downgrade it.
  const mark = (unitPath, kind, resolved) => {
    const previous = units.get(unitPath);
    units.set(unitPath, { kind, resolved: (previous?.resolved ?? true) && resolved });
  };
  const declared = new Set();
  for (const statement of source.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declared.add(statement.name.text);
    }
  }
  const strip = (node) =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression?.(node) ? strip(node.expression) : node;
  const isRequire = (node) =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require";
  // A root value is decidable when this file holds its shape: not a
  // `require()` re-export and not a binding that is imported, cyclic or unset.
  const decidable = (node, seen = new Set()) => {
    if (!node) return false;
    const value = strip(node);
    if (isRequire(value)) return false;
    if (!ts.isIdentifier(value)) return true;
    if (declared.has(value.text)) return true;
    if (seen.has(value.text) || !locals.has(value.text)) return false;
    seen.add(value.text);
    return decidable(locals.get(value.text), seen);
  };
  const isExportObject = (node) => {
    const value = strip(node);
    if (ts.isIdentifier(value)) return value.text === "exports";
    return ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) &&
      value.expression.text === "module" && value.name.text === "exports";
  };
  const memberKey = (access) => {
    if (ts.isPropertyAccessExpression(access)) return access.name.text;
    const argument = access.argumentExpression;
    return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral?.(argument) || ts.isNumericLiteral(argument))
      ? argument.text
      : null;
  };
  const values = [];
  let rootAssignments = 0;
  const visit = (node) => {
    // `exports` as a property name (`module.exports`, `obj.exports`) is not a
    // reference to the export object.
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
    if (!isExportObject(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    const assigned = (target) =>
      ts.isBinaryExpression(target.parent) && target.parent.left === target &&
      target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const topLevel = (expression) =>
      ts.isExpressionStatement(expression.parent) && expression.parent.parent === source;
    if (assigned(node)) {
      // `module.exports = value` replaces the export object; `exports = value`
      // only rebinds a local and exports nothing, so it is undecidable intent.
      rootAssignments += 1;
      const ok = !ts.isIdentifier(strip(node)) && topLevel(parent) && decidable(parent.right);
      mark(CJS_ROOT, "BINDING", ok);
      values.push([CJS_ROOT, parent.right, 2]);
      return;
    }
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && strip(parent.expression) === node) {
      const key = memberKey(parent);
      if (!assigned(parent)) {
        // A read of a named member defines no contract; a computed read might.
        if (key === null) mark(`${CJS_ROOT}.<computed>`, "MEMBER", false);
        return;
      }
      const unitPath = key === null ? `${CJS_ROOT}.<computed>` : `${CJS_ROOT}.${key}`;
      mark(CJS_ROOT, "BINDING", true);
      mark(unitPath, "MEMBER", key !== null && topLevel(parent.parent));
      if (key !== null) values.push([unitPath, parent.parent.right, 3]);
      return;
    }
    // `Object.defineProperty(exports, "name", ...)`: the transpiler idiom.
    if (ts.isCallExpression(parent) && parent.arguments[0] === node &&
        ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "defineProperty" &&
        parent.arguments[1] && ts.isStringLiteral(parent.arguments[1])) {
      mark(CJS_ROOT, "BINDING", true);
      mark(`${CJS_ROOT}.${parent.arguments[1].text}`, "MEMBER", ts.isExpressionStatement(parent.parent) && parent.parent.parent === source);
      return;
    }
    // Handed to anything else (`Object.assign(module.exports, x)`, a helper,
    // an alias): what it ends up exporting is undecidable here.
    mark(CJS_ROOT, "BINDING", true);
    mark(`${CJS_ROOT}.<dynamic>`, "MEMBER", false);
  };
  ts.forEachChild(source, visit);
  if (rootAssignments > 1) mark(CJS_ROOT, "BINDING", false);
  // Units are only added after the walk so a downgrade always wins.
  for (const [unitPath, unit] of units) add(unitPath, unit.kind, unit.resolved);
  for (const [unitPath, value, depth] of values) {
    // A function or class declaration exports a callable, not a structure.
    const plain = strip(value);
    if (ts.isIdentifier(plain) && declared.has(plain.text)) continue;
    descend(unitPath, value, depth);
  }
};
