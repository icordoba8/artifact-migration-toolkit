/**
 * Format 21: the legacy module's observable API response contract, derived
 * from source -- never from an agent-authored spec, and never from a
 * framework's or the target's defaults.
 *
 * A legacy service can throw `DUPLICATE_TAX_ID` while a route layer three
 * calls up maps it to 409 and lets everything unmapped fall to 422. A spec
 * written from the service alone loses the 409, and every checkpoint after it
 * still passed. So each obligation is traced through every layer that shapes
 * the wire: route -> handler -> wrapper -> service throw -> catch mapping ->
 * `{ status, body }`.
 *
 * Supported convention (scanner algorithm 5): a route table -- an object
 * literal keyed `"<METHOD> <path>"` -- whose handlers return
 * `{ status, body[, headers] }`, directly or through higher-order wrappers
 * whose try/catch maps errors with lookup tables, `??`/`||` fallbacks and
 * `instanceof` guards, over services that `throw new SomeError("<CODE>")`.
 *
 * ponytail: a small abstract interpreter over the pinned parser's AST, no type
 * checker. Ceiling: Express-style registrations and Next.js route handlers are
 * DETECTED, not interpreted, and any status, identifier or throw it cannot
 * establish is UNRESOLVED -- which blocks. Nothing falls back to a framework
 * default. Upgrade path: interpret those conventions here, or bind
 * engine-captured runtime observations.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const API_CONTRACT_ALGORITHM = 5;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const ROUTE_KEY = new RegExp(`^(${METHODS.join("|")}) (/\\S*)$`);
const CODE = /^[A-Z][A-Z0-9_]*$/;
const SCRIPT = /\.[cm]?[jt]sx?$/;
const NEXT_ROUTE = /(?:^|\/)app\/(?:.+\/)?route\.[cm]?[jt]sx?$/;
const BUILTIN_ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"]);
const MAX_DEPTH = 12;

// An error no traced throw site creates -- a runtime fault such as a
// TypeError. It is no first-party class and carries no first-party field.
const RUNTIME_FAULT = Object.freeze({ fault: true, site: null });

/** One canonical line per obligation; OpenSpec scenarios cite it verbatim. */
export const responseIdentity = ({ method, path: route, status, code, bodyKeys, headers }) =>
  `${method} ${route} -> ${status}${code ? ` ${code}` : ""}` +
  `${bodyKeys ? ` body{${bodyKeys.join(",")}}` : ""}` +
  `${headers?.length ? ` headers{${headers.join(",")}}` : ""}`;

const UNDEF = Object.freeze({ undef: true });

/**
 * The interpreter over one parsed file set. `files` maps a repository-relative
 * path to its text; `resolve(from, spec)` is the scanner's own resolution.
 *
 * Values: { num } { str } { bool } UNDEF { fn, scope } { cls, file }
 * { builtin } { obj, scope } { ns } { err }; `null` is "cannot be established".
 * A walk yields { responses, throws, unresolved, falls }, `falls` being
 * whether control can reach the next statement.
 */
const interpreter = (ts, files, resolve) => {
  const K = ts.SyntaxKind;
  const units = new Map();
  const propName = (name) =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) ? name.text : null;
  const exported = (node) => node.modifiers?.some((m) => m.kind === K.ExportKeyword);
  const lineOf = (node) => {
    const sf = node.getSourceFile();
    return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  };

  const unit = (file) => {
    if (units.has(file)) return units.get(file);
    const text = files.get(file);
    let indexed = null;
    if (text !== undefined) {
      const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
      indexed = { sf, decls: new Map(), imports: new Map(), exports: new Map() };
      for (const statement of sf.statements) {
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
          indexed.decls.set(statement.name.text, statement);
          if (exported(statement)) indexed.exports.set(statement.name.text, statement.name.text);
        } else if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name)) continue;
            indexed.decls.set(decl.name.text, decl);
            if (exported(statement)) indexed.exports.set(decl.name.text, decl.name.text);
          }
        } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          const spec = statement.moduleSpecifier.text;
          const clause = statement.importClause;
          if (clause?.name) indexed.imports.set(clause.name.text, { spec, imported: "default" });
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) indexed.imports.set(bindings.name.text, { spec, namespace: true });
          for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
            indexed.imports.set(element.name.text, { spec, imported: (element.propertyName ?? element.name).text });
          }
        } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            indexed.exports.set(element.name.text, (element.propertyName ?? element.name).text);
          }
        }
      }
    }
    units.set(file, indexed);
    return indexed;
  };

  // --- values -------------------------------------------------------------
  const fileScope = (file) => ({ file, vars: new Map(), parent: null });
  const resolving = new Set();
  const exportOf = (file, name, seen) => {
    const local = unit(file)?.exports.get(name);
    return local === undefined ? null : declValue(file, local, seen);
  };
  const declValue = (file, name, seen = new Set()) => {
    const key = `${file}#${name}`;
    const target = unit(file);
    if (!target || seen.has(key)) return null;
    seen.add(key);
    const decl = target.decls.get(name);
    if (decl) {
      if (ts.isFunctionDeclaration(decl)) return { fn: decl, scope: fileScope(file) };
      if (ts.isClassDeclaration(decl)) return { cls: decl, file };
      if (!decl.initializer) return UNDEF;
      // `const a = f(); function f() { return a; }` refers to itself.
      if (resolving.has(decl)) return null;
      resolving.add(decl);
      try {
        return evaluate(decl.initializer, fileScope(file));
      } finally {
        resolving.delete(decl);
      }
    }
    const imported = target.imports.get(name);
    const to = imported && resolve(file, imported.spec);
    if (!to || !unit(to)) return null;
    return imported.namespace ? { ns: to } : exportOf(to, imported.imported, seen);
  };
  const lookup = (name, scope) => {
    for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    if (name === "undefined") return UNDEF;
    return declValue(scope.file, name) ?? (BUILTIN_ERRORS.has(name) ? { builtin: name } : null);
  };
  /** Binds a parameter or declaration name; destructured names are unknown. */
  const bind = (vars, name, value) => {
    if (ts.isIdentifier(name)) return vars.set(name.text, value);
    for (const element of name.elements ?? []) if (ts.isBindingElement(element)) bind(vars, element.name, null);
  };

  const evaluate = (expr, scope, depth = 0) => {
    if (!expr) return UNDEF;
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) ||
        ts.isNonNullExpression(expr) || ts.isAwaitExpression(expr)) return evaluate(expr.expression, scope, depth);
    if (ts.isNumericLiteral(expr)) return { num: Number(expr.text) };
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { str: expr.text };
    if (expr.kind === K.TrueKeyword || expr.kind === K.FalseKeyword) return { bool: expr.kind === K.TrueKeyword };
    if (expr.kind === K.NullKeyword) return UNDEF;
    if (ts.isIdentifier(expr)) return lookup(expr.text, scope);
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return { fn: expr, scope };
    if (ts.isObjectLiteralExpression(expr)) return { obj: expr, scope };
    if (ts.isPropertyAccessExpression(expr)) return member(evaluate(expr.expression, scope, depth), expr.name.text);
    if (ts.isElementAccessExpression(expr)) {
      const key = evaluate(expr.argumentExpression, scope, depth);
      if (key?.undef) return UNDEF;
      const name = key?.str ?? (key && "num" in key ? String(key.num) : null);
      return name === null ? null : member(evaluate(expr.expression, scope, depth), name);
    }
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === K.ExclamationToken) {
      const value = truth(evaluate(expr.operand, scope, depth));
      return value === null ? null : { bool: !value };
    }
    if (ts.isConditionalExpression(expr)) {
      const value = truth(evaluate(expr.condition, scope, depth));
      return value === null ? null : evaluate(value ? expr.whenTrue : expr.whenFalse, scope, depth);
    }
    if (ts.isBinaryExpression(expr)) return binary(expr, scope, depth);
    // A call's value is what its function returns: this is what makes a
    // wrapper call `handle(fn)` evaluate to the handler it builds.
    if (ts.isCallExpression(expr) && depth < MAX_DEPTH) {
      const callee = evaluate(expr.expression, scope, depth);
      return callee?.fn ? callValue(callee, expr.arguments.map((arg) => evaluate(arg, scope, depth)), depth + 1) : null;
    }
    return null;
  };
  const callValue = (callee, args, depth) => {
    const scope = paramScope(callee, args);
    const body = callee.fn.body;
    if (!body) return null;
    if (!ts.isBlock(body)) return evaluate(body, scope, depth);
    const returns = body.statements.filter((s) => ts.isReturnStatement(s));
    // Only a body that is straight-line up to its single return has one value.
    return returns.length === 1 && body.statements.at(-1) === returns[0] &&
      body.statements.every((s) => ts.isReturnStatement(s) || ts.isVariableStatement(s))
      ? evaluate(returns[0].expression, withLocals(body.statements, scope, depth), depth)
      : null;
  };
  const withLocals = (statements, scope, depth) => {
    const local = { file: scope.file, vars: new Map(), parent: scope };
    for (const s of statements.filter((x) => ts.isVariableStatement(x))) {
      for (const decl of s.declarationList.declarations) bind(local.vars, decl.name, decl.initializer ? evaluate(decl.initializer, local, depth) : UNDEF);
    }
    return local;
  };
  const paramScope = (callee, args) => {
    const vars = new Map();
    callee.fn.parameters.forEach((p, i) => {
      const arg = i < args.length ? args[i] : UNDEF;
      bind(vars, p.name, arg?.undef && p.initializer ? evaluate(p.initializer, callee.scope) : arg);
    });
    return { file: callee.scope.file, vars, parent: callee.scope };
  };
  const truth = (value) => {
    if (!value) return null;
    if (value.undef) return false;
    if ("bool" in value) return value.bool;
    if ("num" in value) return value.num !== 0;
    if ("str" in value) return value.str !== "";
    return value.fn || value.obj || value.cls || value.err ? true : null;
  };
  const scalar = (value) =>
    !value ? null : value.undef ? "u" : "str" in value ? `s:${value.str}` : "num" in value ? `n:${value.num}` : "bool" in value ? `b:${value.bool}` : null;
  const binary = (expr, scope, depth) => {
    const op = expr.operatorToken.kind;
    if (op === K.InstanceOfKeyword) return instanceOf(evaluate(expr.left, scope, depth), evaluate(expr.right, scope, depth));
    const left = evaluate(expr.left, scope, depth);
    if (op === K.QuestionQuestionToken) return left === null ? null : left.undef ? evaluate(expr.right, scope, depth) : left;
    if (op === K.BarBarToken || op === K.AmpersandAmpersandToken) {
      const t = truth(left);
      return t === null ? null : (op === K.BarBarToken) === t ? left : evaluate(expr.right, scope, depth);
    }
    const equality = { [K.EqualsEqualsEqualsToken]: true, [K.EqualsEqualsToken]: true, [K.ExclamationEqualsEqualsToken]: false, [K.ExclamationEqualsToken]: false };
    if (op in equality) {
      const a = scalar(left);
      const b = scalar(evaluate(expr.right, scope, depth));
      return a === null || b === null ? null : { bool: (a === b) === equality[op] };
    }
    return null;
  };
  const member = (base, name) => {
    if (!base) return null;
    if (base.ns) return exportOf(base.ns, name, new Set());
    if (base.err) return errorField(base.err, name);
    if (!base.obj) return null;
    let found = UNDEF;
    for (const prop of base.obj.properties) {
      if (ts.isSpreadAssignment(prop) || (prop.name && ts.isComputedPropertyName(prop.name))) return null;
      if (propName(prop.name) !== name) continue;
      found = ts.isPropertyAssignment(prop) ? evaluate(prop.initializer, base.scope)
        : ts.isShorthandPropertyAssignment(prop) ? lookup(prop.name.text, base.scope)
          : ts.isMethodDeclaration(prop) ? { fn: prop, scope: base.scope } : null;
    }
    return found;
  };

  // --- errors -------------------------------------------------------------
  const superOf = (cls) => {
    const clause = cls.cls.heritageClauses?.find((h) => h.token === K.ExtendsKeyword);
    return clause ? evaluate(clause.types[0].expression, fileScope(cls.file)) : null;
  };
  const instanceOf = (left, right) => {
    if (!left?.err || !(right?.cls || right?.builtin)) return null;
    if (left.err.fault) return { bool: right.builtin === "Error" };
    for (let cls = left.err.cls, depth = 0; cls && depth < MAX_DEPTH; depth += 1) {
      if (cls.builtin) return { bool: right.builtin === "Error" || right.builtin === cls.builtin };
      if (right.cls === cls.cls) return { bool: true };
      cls = superOf(cls);
    }
    return null;
  };
  /** `error.<name>` for a traced `new Class(args)`: the constructor chain's own assignment. */
  const errorField = (error, name) => {
    if (error.fault) return UNDEF;
    let { cls, args } = error;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      if (!cls) return null;
      if (cls.builtin) return UNDEF;
      const ctor = cls.cls.members.find((m) => ts.isConstructorDeclaration(m));
      if (!ctor) { cls = superOf(cls); continue; }
      const scope = { file: cls.file, vars: new Map(), parent: null };
      ctor.parameters.forEach((p, i) => {
        const arg = args[i] ? evaluate(args[i].expr, args[i].scope) : UNDEF;
        bind(scope.vars, p.name, arg?.undef && p.initializer ? evaluate(p.initializer, fileScope(cls.file)) : arg);
      });
      let next = null;
      for (const statement of ctor.body?.statements ?? []) {
        const e = ts.isExpressionStatement(statement) ? statement.expression : null;
        if (e && ts.isCallExpression(e) && e.expression.kind === K.SuperKeyword) next = e.arguments.map((expr) => ({ expr, scope }));
        if (e && ts.isBinaryExpression(e) && e.operatorToken.kind === K.EqualsToken && ts.isPropertyAccessExpression(e.left) &&
            e.left.expression.kind === K.ThisKeyword && e.left.name.text === name) return evaluate(e.right, scope);
      }
      if (!next) return UNDEF;
      args = next;
      cls = superOf(cls);
    }
    return null;
  };

  // --- statements ---------------------------------------------------------
  const empty = () => ({ responses: [], throws: [], unresolved: [], falls: true });
  const merge = (into, from, { responses = true } = {}) => {
    if (responses) into.responses.push(...from.responses);
    into.throws.push(...from.throws);
    into.unresolved.push(...from.unresolved);
    return into;
  };
  const active = new Set();
  // A service's throws depend only on its scalar arguments, so each function is
  // walked once per argument signature -- not once per call site.
  const memo = new Map();
  const signature = (args) => args.map((arg) => scalar(arg) ?? "?").join("\0");

  /** Runs a function value; when `handler`, its returns are responses. */
  const invoke = (callee, args, handler, depth) => {
    const out = empty();
    if (!callee?.fn?.body || depth > MAX_DEPTH || active.has(callee.fn)) return out;
    const key = handler ? null : signature(args);
    const seen = key === null ? null : memo.get(callee.fn)?.get(key);
    if (seen) return merge(out, seen);
    active.add(callee.fn);
    try {
      const scope = paramScope(callee, args);
      const body = callee.fn.body;
      if (ts.isBlock(body)) merge(out, block(body.statements, scope, handler, depth));
      else merge(out, handler ? returned(body, scope, depth) : calls(body, scope, depth));
    } finally {
      active.delete(callee.fn);
    }
    if (key !== null) {
      if (!memo.has(callee.fn)) memo.set(callee.fn, new Map());
      memo.get(callee.fn).set(key, { responses: [], throws: [...out.throws], unresolved: [...out.unresolved] });
    }
    return out;
  };

  /** Throws raised by first-party calls anywhere inside an expression. */
  const calls = (expr, scope, depth) => {
    const out = empty();
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = evaluate(node.expression, scope, depth);
        if (callee?.fn) merge(out, invoke(callee, node.arguments.map((arg) => evaluate(arg, scope, depth)), false, depth + 1), { responses: false });
      }
      // A callback may run: its throws count, its returns are values.
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) {
        const inner = paramScope({ fn: node, scope }, []);
        merge(out, ts.isBlock(node.body) ? block(node.body.statements, inner, false, depth + 1) : calls(node.body, inner, depth + 1), { responses: false });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(expr);
    return out;
  };

  const response = (literal, scope) => {
    const field = (name) => literal.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === name);
    const statusField = field("status");
    const status = evaluate(statusField.initializer, scope);
    if (!status || !("num" in status)) {
      return { unresolved: [{ at: lineOf(statusField), reason: "the response status cannot be established statically" }] };
    }
    let bodyKeys = null;
    let code = null;
    const body = field("body")?.initializer;
    if (body && ts.isObjectLiteralExpression(body) && body.properties.every((p) => !ts.isSpreadAssignment(p) && propName(p.name) !== null)) {
      bodyKeys = body.properties.map((p) => propName(p.name)).sort();
      // Only an error response carries a machine-readable error identifier.
      for (const prop of status.num >= 400 ? body.properties : []) {
        const value = ts.isPropertyAssignment(prop) ? evaluate(prop.initializer, scope) : lookup(propName(prop.name), scope);
        if (value?.str && CODE.test(value.str)) { code = value.str; break; }
      }
    }
    const headersField = field("headers")?.initializer;
    const headers = headersField && ts.isObjectLiteralExpression(headersField)
      ? headersField.properties.map((p) => propName(p.name)?.toLowerCase()).filter(Boolean).sort()
      : [];
    return { responses: [{ status: status.num, code, bodyKeys, headers, statusAt: lineOf(statusField) }] };
  };

  /** A handler's returned expression: a response literal, or a call whose returns are responses. */
  const returned = (expr, scope, depth) => {
    const out = empty();
    while (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)) expr = expr.expression;
    if (ts.isObjectLiteralExpression(expr) && expr.properties.some((p) => ts.isPropertyAssignment(p) && propName(p.name) === "status")) {
      const shaped = response(expr, scope);
      out.responses.push(...(shaped.responses ?? []));
      out.unresolved.push(...(shaped.unresolved ?? []));
      return merge(out, calls(expr, scope, depth), { responses: false });
    }
    if (ts.isConditionalExpression(expr)) {
      const t = truth(evaluate(expr.condition, scope, depth));
      if (t !== false) merge(out, returned(expr.whenTrue, scope, depth));
      if (t !== true) merge(out, returned(expr.whenFalse, scope, depth));
      return out;
    }
    if (ts.isCallExpression(expr)) {
      const callee = evaluate(expr.expression, scope, depth);
      if (callee?.fn) {
        for (const arg of expr.arguments) merge(out, calls(arg, scope, depth), { responses: false });
        return merge(out, invoke(callee, expr.arguments.map((arg) => evaluate(arg, scope, depth)), true, depth + 1));
      }
    }
    out.unresolved.push({ at: lineOf(expr), reason: "the handler returns a value whose response status cannot be established statically" });
    return out;
  };

  const thrown = (statement, scope, depth) => {
    const out = merge(empty(), calls(statement.expression, scope, depth), { responses: false });
    out.falls = false;
    const expr = statement.expression;
    const value = ts.isNewExpression(expr) ? evaluate(expr.expression, scope, depth) : ts.isIdentifier(expr) ? lookup(expr.text, scope) : null;
    if (value?.err) {
      out.throws.push(value.err);
    } else if (value?.cls || value?.builtin) {
      const error = { cls: value, args: (expr.arguments ?? []).map((arg) => ({ expr: arg, scope })), site: lineOf(statement) };
      const code = errorField(error, "code");
      if (code && (code.undef || code.str)) out.throws.push(error);
      else out.unresolved.push({ at: lineOf(statement), reason: "the thrown error's identifier cannot be established statically" });
    } else {
      out.unresolved.push({ at: lineOf(statement), reason: "the thrown value cannot be established statically" });
    }
    return out;
  };

  const block = (statements, scope, handler, depth) => {
    const out = empty();
    const local = { file: scope.file, vars: new Map(), parent: scope };
    for (const statement of statements) {
      const step = walk(statement, local, handler, depth);
      merge(out, step);
      if (!step.falls) { out.falls = false; break; }
    }
    return out;
  };

  const walk = (statement, scope, handler, depth) => {
    if (ts.isBlock(statement)) return block(statement.statements, scope, handler, depth);
    if (ts.isReturnStatement(statement)) {
      const out = !statement.expression ? empty() : handler ? returned(statement.expression, scope, depth) : calls(statement.expression, scope, depth);
      return { ...out, responses: handler ? out.responses : [], falls: false };
    }
    if (ts.isThrowStatement(statement)) return thrown(statement, scope, depth);
    if (ts.isVariableStatement(statement)) {
      const out = empty();
      for (const decl of statement.declarationList.declarations) {
        if (decl.initializer) merge(out, calls(decl.initializer, scope, depth), { responses: false });
        bind(scope.vars, decl.name, decl.initializer ? evaluate(decl.initializer, scope, depth) : UNDEF);
      }
      return out;
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) scope.vars.set(statement.name.text, { fn: statement, scope });
      return empty();
    }
    if (ts.isIfStatement(statement)) {
      const out = merge(empty(), calls(statement.expression, scope, depth), { responses: false });
      const t = truth(evaluate(statement.expression, scope, depth));
      const branches = [];
      if (t !== false) branches.push(walk(statement.thenStatement, scope, handler, depth));
      if (t !== true) branches.push(statement.elseStatement ? walk(statement.elseStatement, scope, handler, depth) : empty());
      for (const branch of branches) merge(out, branch);
      out.falls = branches.some((branch) => branch.falls);
      return out;
    }
    if (ts.isTryStatement(statement)) return attempt(statement, scope, handler, depth);
    if (ts.isExpressionStatement(statement)) return merge(empty(), calls(statement.expression, scope, depth), { responses: false });
    // Loops, switches, labels: every nested part may run, and control may continue.
    const out = empty();
    ts.forEachChild(statement, (child) => {
      if (ts.isStatement(child) || ts.isBlock(child)) merge(out, walk(child, scope, handler, depth));
      else if (ts.isExpression(child)) merge(out, calls(child, scope, depth), { responses: false });
      else if (ts.isCaseBlock?.(child)) for (const clause of child.clauses) merge(out, block(clause.statements, scope, handler, depth));
    });
    return out;
  };

  /** try/catch: each traced throw -- and, in a handler, one runtime fault -- runs the catch with its own error bound. */
  const attempt = (statement, scope, handler, depth) => {
    const body = block(statement.tryBlock.statements, scope, handler, depth);
    const out = { ...empty(), responses: [...body.responses], unresolved: [...body.unresolved], falls: body.falls };
    const clause = statement.catchClause;
    if (!clause) out.throws.push(...body.throws);
    for (const error of clause ? (handler ? [...body.throws, RUNTIME_FAULT] : body.throws) : []) {
      const vars = new Map();
      if (clause.variableDeclaration) bind(vars, clause.variableDeclaration.name, { err: error });
      const handled = block(clause.block.statements, { file: scope.file, vars, parent: scope }, handler, depth);
      for (const r of handled.responses) out.responses.push({ ...r, origin: r.origin ?? error.site });
      merge(out, handled, { responses: false });
      out.falls ||= handled.falls;
    }
    if (statement.finallyBlock) merge(out, block(statement.finallyBlock.statements, scope, handler, depth));
    return out;
  };

  return { unit, evaluate, invoke, propName, lineOf, exported };
};

/** Route-table entries, plus the conventions algorithm 5 detects but does not interpret. */
const endpointsOf = (ts, it, sf) => {
  const tables = [];
  const unsupported = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        const match = prop.name && (ts.isStringLiteral(prop.name) || ts.isNoSubstitutionTemplateLiteral(prop.name)) && prop.name.text.match(ROUTE_KEY);
        if (match) tables.push({ method: match[1], path: match[2], prop });
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const [route, ...rest] = node.arguments;
      if (METHODS.includes(name.toUpperCase()) && name === name.toLowerCase() && route && ts.isStringLiteral(route) &&
          route.text.startsWith("/") && rest.some((arg) => (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && arg.parameters.length >= 2)) {
        unsupported.push({ endpoint: `${name.toUpperCase()} ${route.text}`, node,
          reason: "an Express-style route registration; discovery scanner algorithm 5 does not interpret its responses" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (NEXT_ROUTE.test(sf.fileName)) {
    for (const statement of sf.statements.filter((s) => it.exported(s))) {
      const names = ts.isFunctionDeclaration(statement) && statement.name ? [statement.name.text]
        : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((d) => d.name.getText()) : [];
      for (const name of names.filter((n) => METHODS.includes(n))) {
        unsupported.push({ endpoint: `${name} ${sf.fileName}`, node: statement,
          reason: "a Next.js route handler; discovery scanner algorithm 5 does not interpret its responses" });
      }
    }
  }
  return { tables, unsupported };
};

/**
 * Algorithm 5's contract over a scan's owned census. Endpoints come only from
 * owned files; throws are traced into every parsed first-party file the scan
 * resolved an edge to.
 */
export const extractApiContract = async ({ ts, legacyRoot, census, supporting = [], edges = [] }) => {
  const contract = { version: 1, obligations: [], unresolved: [] };
  if (!ts) return contract;
  const files = new Map();
  for (const file of [...new Set([...census, ...supporting])].filter((f) => SCRIPT.test(f)).sort()) {
    files.set(file, await readFile(path.join(legacyRoot, file), "utf8"));
  }
  const edgeTo = new Map(edges.map((edge) => [`${edge.from}\0${edge.spec}`, edge.to]));
  const it = interpreter(ts, files, (from, spec) => edgeTo.get(`${from}\0${spec}`) ?? null);
  const obligations = new Map();
  const unresolved = new Map();
  const unresolve = (endpoint, at, reason) => unresolved.set(`${endpoint}\0${at}\0${reason}`, { endpoint, at, reason });
  for (const file of census.filter((f) => SCRIPT.test(f)).sort()) {
    const target = it.unit(file);
    if (!target) continue;
    const { tables, unsupported } = endpointsOf(ts, it, target.sf);
    for (const entry of unsupported) unresolve(entry.endpoint, it.lineOf(entry.node), entry.reason);
    for (const { method, path: route, prop } of tables) {
      const endpoint = `${method} ${route}`;
      const scope = { file, vars: new Map(), parent: null };
      const handler = ts.isMethodDeclaration(prop) ? { fn: prop, scope } : ts.isPropertyAssignment(prop) ? it.evaluate(prop.initializer, scope) : null;
      if (!handler?.fn) {
        unresolve(endpoint, it.lineOf(prop), "the route handler cannot be resolved statically");
        continue;
      }
      const outcome = it.invoke(handler, [], true, 0);
      for (const entry of outcome.unresolved) unresolve(endpoint, entry.at, entry.reason);
      for (const error of outcome.throws) {
        unresolve(endpoint, error.site ?? it.lineOf(prop), "an error escapes the route handler, so its response is decided by a dispatcher algorithm 5 does not trace");
      }
      if (outcome.responses.length === 0 && outcome.unresolved.length === 0) {
        unresolve(endpoint, it.lineOf(prop), "the route handler produces no statically established response");
      }
      for (const r of outcome.responses) {
        const obligation = { method, path: route, status: r.status, code: r.code, bodyKeys: r.bodyKeys, headers: r.headers };
        const id = responseIdentity(obligation);
        const entry = obligations.get(id) ?? { id, ...obligation, route: it.lineOf(prop), statusAt: r.statusAt, origins: [] };
        if (r.origin && !entry.origins.includes(r.origin)) entry.origins = [...entry.origins, r.origin].sort();
        obligations.set(id, entry);
      }
    }
  }
  contract.obligations = [...obligations.values()].sort((a, b) => a.id.localeCompare(b.id));
  contract.unresolved = [...unresolved.values()].sort((a, b) =>
    a.endpoint.localeCompare(b.endpoint) || a.at.localeCompare(b.at) || a.reason.localeCompare(b.reason));
  return contract;
};

/**
 * Every `Response:` line in the OpenSpec, by the scenarios citing it. A line
 * outside a scenario is malformed: nothing could ever verify it.
 */
export const openSpecResponses = (content) => {
  const cited = new Map();
  const malformed = [];
  let scenario = null;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (/^#{1,6}\s/.test(line)) {
      scenario = line.match(/^#### Scenario: ([A-Z][A-Z0-9]*-SCN-\d{3,})/)?.[1] ?? null;
      continue;
    }
    const match = line.match(/^\s*(?:[-*]\s+)?Response:\s*(.*?)\s*$/);
    if (!match) continue;
    if (!scenario) {
      malformed.push(`line ${index + 1} cites 'Response: ${match[1]}' outside a scenario`);
      continue;
    }
    const id = match[1].replace(/\s+/g, " ");
    cited.set(id, [...new Set([...(cited.get(id) ?? []), scenario])]);
  }
  return { cited, malformed };
};

/**
 * The checkpoint rule: every source-established obligation is cited by an
 * OpenSpec scenario, every cited response is source-established, and nothing
 * stays unresolved.
 */
export const apiContractIssues = (contract, content, source) => {
  const issues = contract.unresolved.map((entry) =>
    `API_RESPONSE_UNRESOLVED: ${entry.endpoint} at ${entry.at}: ${entry.reason}. No coverage is recorded and no default is assumed; this endpoint's responses cannot be claimed until the convention is supported.`);
  const { cited, malformed } = openSpecResponses(content);
  issues.push(...malformed.map((entry) => `API_RESPONSE_MALFORMED: ${source} ${entry}.`));
  const known = new Set(contract.obligations.map((o) => o.id));
  for (const o of contract.obligations.filter((x) => !cited.has(x.id))) {
    issues.push(`API_RESPONSE_UNCOVERED: the legacy source establishes '${o.id}' (route ${o.route}, status ${o.statusAt}${o.origins.length ? `, raised at ${o.origins.join(", ")}` : ""}), but no ${source} scenario cites it. Add '- Response: ${o.id}' to the scenario that specifies this behavior.`);
  }
  for (const [id, scenarios] of cited) {
    if (!known.has(id)) issues.push(`API_RESPONSE_UNGROUNDED: ${scenarios.join(", ")} in ${source} cite 'Response: ${id}', which the legacy source does not establish. Cite only responses the discovery contract lists, verbatim.`);
  }
  return issues;
};

export const assertApiContractCovered = (contract, content, source) => {
  const issues = apiContractIssues(contract, content, source);
  if (issues.length > 0) {
    throw Object.assign(new Error(`OpenSpec ${source} does not cover the legacy API response contract. Nothing was written.\n- ${issues.join("\n- ")}`),
      { validationCode: "API_RESPONSE_CONTRACT", issues });
  }
};

const quoted = (id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const passes = (id, text) => new RegExp(`^\\s*(?:ok \\d+ - |PASS |✔ )Response: ${quoted(id)}(?:\\s+[#(].*)?\\s*$`, "m").test(text);
const fails = (id, text) => new RegExp(`^\\s*(?:not ok \\d+ - |FAIL |✖ )Response: ${quoted(id)}`, "m").test(text);

/**
 * The obligations a slice tracing `scenarioIds` owes, that its command
 * `outputs` do not prove: no passing test named `Response: <identity>`, or a
 * failing one.
 */
export const unprovenResponses = (contract, content, scenarioIds, outputs) => {
  const { cited } = openSpecResponses(content);
  const traced = new Set(scenarioIds ?? []);
  return contract.obligations
    .filter((o) => (cited.get(o.id) ?? []).some((id) => traced.has(id)))
    .filter((o) => !outputs.some((text) => passes(o.id, text)) || outputs.some((text) => fails(o.id, text)));
};

/** The obligations no planned slice traces a citing scenario for. */
export const unplannedResponses = (contract, content, slices) => {
  const { cited } = openSpecResponses(content);
  const traced = new Set(slices.flatMap((slice) => slice.scenarioIds ?? []));
  return contract.obligations.filter((o) => !(cited.get(o.id) ?? []).some((id) => traced.has(id)));
};
