/**
 * Deterministic module discovery for the DISCOVERY_COMPLETENESS checkpoint.
 *
 * Reachability alone is not a module inventory: making the import graph
 * authoritative just moves the unverified declaration up one level, from "the
 * files I mentioned" to "the entry points I declared". Omit the login route and
 * a decorative component disappears exactly as before.
 *
 * So the census is authoritative and the graph only annotates it. Three
 * independent detectors feed one table:
 *
 *   A. CENSUS   `git ls-files` under the declared module roots. No graph, no
 *               entry points, no imports. This alone forces a classification.
 *   B. GRAPH    TypeScript module resolution from discovered entry points,
 *               which annotates reachability and finds SUPPORTING files.
 *   C. INBOUND  A repository-wide parse: any first-party file outside the roots
 *               that references into them becomes an entry point nobody had to
 *               declare.
 *
 * The compiler is this skill's own pinned classic-API TypeScript
 * (`ts-discovery-compiler`), not the analyzed project's installed one: this
 * scan only ever parses syntax and runs the classic module-resolution
 * algorithm over the legacy project's own `tsconfig.json` -- `paths` aliases,
 * extensions, `index` barrels, `exports` maps all still resolve per that
 * project's own config -- it never needs the project's actual compiler
 * instance or type checker. Pinning independently means a legacy project on
 * any TypeScript version, including one whose classic Node-hosted API no
 * longer exists (TypeScript 7+), still discovers correctly.
 *
 * ponytail: file-local `createSourceFile` walk, no `Program` and no type
 * checker. Ceiling: a re-export chain through an ambient `.d.ts` alias resolves
 * by module resolution but not by symbol. Those surface as UNRESOLVED findings
 * that block, never as silent misses. Upgrade path: a real `Program` if the
 * unresolved volume ever justifies ~10x the cost.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { engineSkillRoot } from "./engine-paths.mjs";

const execFileAsync = promisify(execFile);

/**
 * Bump only when the scan's own rules change what a correct run produces.
 * FINALIZE recomputes with the version a migration recorded, so an in-flight
 * migration is never silently held to rules that postdate its checkpoint.
 */
export const CENSUS_ALGORITHM_VERSION = 2;
export const SUPPORTED_ALGORITHM_VERSIONS = new Set([1, 2]);

export class DiscoveryScannerVersionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiscoveryScannerVersionError";
    this.code = code;
  }
}

const SCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less"];
const ASSET_EXTENSIONS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".webm",
];
const DATA_EXTENSIONS = [".json", ".yaml", ".yml"];
const DOC_EXTENSIONS = [".md"];

/** Probe order for a specifier the TypeScript resolver could not resolve. */
export const PROBE_EXTENSIONS = [
  ...SCRIPT_EXTENSIONS,
  ...DATA_EXTENSIONS,
  ...STYLE_EXTENSIONS,
];

/**
 * Visual kinds. A production-reachable file of one of these kinds can never be
 * dismissed with agent-authored rationale alone -- see `VISUAL_KINDS` use in
 * `resumable-migration.mjs`.
 */
export const VISUAL_KINDS = new Set(["COMPONENT", "STYLE", "ASSET"]);

/** Reachability values that mean "a user can reach this in production". */
export const PRODUCTION_REACHABILITY = new Set([
  "REACHABLE_FROM_ENTRY",
  "REACHABLE_INBOUND_ONLY",
]);

export const REACHABILITY_VALUES = [
  "REACHABLE_FROM_ENTRY",
  "REACHABLE_INBOUND_ONLY",
  "REACHABLE_TEST_ONLY",
  "UNREACHABLE",
];

/** Next.js file conventions: an operator cannot omit these by not declaring them. */
const NEXT_APP_FILES = new Set([
  "page",
  "layout",
  "template",
  "loading",
  "error",
  "global-error",
  "not-found",
  "default",
  "route",
  "forbidden",
  "unauthorized",
  "robots",
  "sitemap",
  "manifest",
  "icon",
  "apple-icon",
  "opengraph-image",
  "twitter-image",
]);

/** Project-root conventions. `proxy` is Next 16's rename of `middleware`. */
const NEXT_ROOT_FILES = new Set([
  "proxy",
  "middleware",
  "instrumentation",
  "instrumentation-client",
]);

const TEST_PATTERN =
  /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec|e2e-spec|integration-spec)\.[^/]+$/;

const portable = (value) => value.split(path.sep).join("/");

const extensionOf = (relativePath) => path.extname(relativePath).toLowerCase();

export const kindOf = (relativePath) => {
  const extension = extensionOf(relativePath);
  if (extension === ".tsx" || extension === ".jsx" || extension === ".mdx")
    return "COMPONENT";
  if (STYLE_EXTENSIONS.includes(extension)) return "STYLE";
  if (ASSET_EXTENSIONS.includes(extension)) return "ASSET";
  if (DATA_EXTENSIONS.includes(extension)) return "DATA";
  if (DOC_EXTENSIONS.includes(extension)) return "DOC";
  if (SCRIPT_EXTENSIONS.includes(extension)) return "MODULE";
  return "OTHER";
};

const isScript = (relativePath) =>
  SCRIPT_EXTENSIONS.includes(extensionOf(relativePath));
const isStyle = (relativePath) =>
  STYLE_EXTENSIONS.includes(extensionOf(relativePath));
const isParseable = (relativePath) =>
  isScript(relativePath) || isStyle(relativePath);

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

/**
 * Discovery owns a pinned classic-API TypeScript, independent of the analyzed
 * project's installed compiler -- see the module doc comment. Loaded from
 * this skill's own dependency, not from the legacy root.
 */
/**
 * One message for both engines. The specifier is a skill-owned alias, so
 * "install the repository's dependencies" was never enough to act on: an
 * operator needs the dependency's name, the manifest that declares it, and the
 * directory the resolver actually searched from.
 */
export const parserResolutionError = (error, fromUrl, skillName) => {
  const searchedFrom = path.dirname(fileURLToPath(fromUrl));
  // R-1: the manifest is wherever this engine is installed. Both engines now
  // live in one package, so the declaring manifest is the package root rather
  // than one level up from whichever module raised this -- `src/artifact/` is
  // two levels below it. `skillName` stays only to name the skill in prose; it
  // no longer implies a consumer-repository-relative location.
  const skillRoot = engineSkillRoot;
  return new Error(
    `Cannot load the pinned discovery parser 'ts-discovery-compiler': ${error.message}. ` +
      `It is declared as 'npm:typescript@5.9.3' by ${skillRoot}/package.json and is resolved ` +
      `from the node_modules directories above ${searchedFrom}. ` +
      `Run 'pnpm install --frozen-lockfile' at the repository root that contains the ${skillName} skill, or ` +
      `'pnpm install' inside ${skillRoot} when the skill is installed into a target repository. ` +
      `This parser is pinned on purpose: the scan runs the classic Node-hosted TypeScript API, which a ` +
      `TypeScript 7+ project no longer ships, so the analyzed project's own compiler cannot stand in for it. ` +
      `Nothing was changed.`,
  );
};

export const loadTypeScript = () => {
  try {
    return createRequire(import.meta.url)("ts-discovery-compiler");
  } catch (error) {
    throw parserResolutionError(error, import.meta.url, "start-migration");
  }
};

const gitList = async (root, pathspec) => {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      pathspec,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split("\0").filter(Boolean).map(portable);
};

export const CENSUS_COMMAND =
  "git ls-files --cached --others --exclude-standard -z -- <root>";

const normalizeRoot = (value, label) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(
      `${label} '${value}' must be a legacy-relative, '/'-separated path.`,
    );
  }
  const normalized = portable(path.normalize(value)).replace(/\/+$/, "");
  if (normalized.split("/").includes("..")) {
    throw new Error(`${label} '${value}' must not escape the legacy root.`);
  }
  return normalized === "." ? "." : normalized;
};

const underRoot = (relativePath, root) =>
  root === "." || relativePath === root || relativePath.startsWith(`${root}/`);

/** Security rule shared with the rest of the workflow: evidence is never a symlink. */
const assertNotSymlink = async (legacyRoot, relativePath) => {
  const absolute = path.join(legacyRoot, relativePath);
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    throw new Error(
      `Module census entry '${relativePath}' is a symbolic link. Symlinked module content is never accepted as evidence.`,
    );
  }
  return entry.isFile();
};

/**
 * Every reference this scan understands, extracted from the real AST rather
 * than from a regex over source text.
 */
const scriptEdges = (ts, fileName, text, algorithmVersion) => {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const edges = [];
  const lineOf = (node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const importBindings = new Map();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.importClause
    ) {
      continue;
    }
    if (statement.importClause.name) {
      importBindings.set(statement.importClause.name.text, {
        spec: statement.moduleSpecifier.text,
        symbol: "default",
      });
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        importBindings.set(element.name.text, {
          spec: statement.moduleSpecifier.text,
          symbol: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  }
  const importSymbols = (node) => {
    if (!node.importClause) return ["*"];
    const symbols = [];
    if (node.importClause.name) symbols.push("default");
    const bindings = node.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) symbols.push("*");
    if (bindings && ts.isNamedImports(bindings)) {
      symbols.push(
        ...bindings.elements.map(
          (element) => element.propertyName?.text ?? element.name.text,
        ),
      );
    }
    return [...new Set(symbols)].sort();
  };
  const exportSymbols = (node) => {
    if (!node.exportClause) return ["*"];
    if (ts.isNamespaceExport?.(node.exportClause)) {
      return [node.exportClause.name.text];
    }
    return [
      ...new Set(
        node.exportClause.elements.map((element) => element.name.text),
      ),
    ].sort();
  };
  const moduleUrlEdges = () => {
    const scopeBindings = new Map();
    const written = new Set();
    const consumedBases = new Set();
    const sourceUrl = pathToFileURL(fileName).href;
    const unwrap = (node) => {
      while (
        node &&
        (ts.isParenthesizedExpression(node) ||
          ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isNonNullExpression(node) ||
          ts.isSatisfiesExpression?.(node))
      ) {
        node = node.expression;
      }
      return node;
    };
    const addBinding = (bindings, name, binding) => {
      if (!bindings.has(name)) bindings.set(name, []);
      if (
        !bindings
          .get(name)
          .some((entry) => entry.declaration === binding.declaration)
      ) {
        bindings.get(name).push(binding);
      }
    };
    const addBindingName = (bindings, name, binding) => {
      if (ts.isIdentifier(name)) {
        addBinding(bindings, name.text, binding);
        return;
      }
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) {
            addBindingName(bindings, element.name, {
              ...binding,
              kind: binding.kind === "parameter" ? "parameter" : "other",
              initializer: null,
            });
          }
        }
      }
    };
    const addVariableDeclarations = (bindings, declarationList) => {
      const kind =
        declarationList.flags & ts.NodeFlags.Const ? "const" : "mutable";
      for (const declaration of declarationList.declarations) {
        addBindingName(bindings, declaration.name, {
          kind,
          declaration,
          initializer: declaration.initializer ?? null,
        });
      }
    };
    const addHoistedVariables = (bindings, root) => {
      const visitHoisted = (node) => {
        if (node !== root && ts.isFunctionLike(node)) return;
        if (
          ts.isVariableDeclarationList(node) &&
          !(node.flags & ts.NodeFlags.BlockScoped)
        ) {
          addVariableDeclarations(bindings, node);
        }
        ts.forEachChild(node, visitHoisted);
      };
      if (root) visitHoisted(root);
    };
    const isLoopScope = (node) =>
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node);
    const isCaseBlock = (node) =>
      ts.isCaseBlock?.(node) || node.kind === ts.SyntaxKind.CaseBlock;
    const bindingsIn = (scope) => {
      if (scopeBindings.has(scope)) return scopeBindings.get(scope);
      const bindings = new Map();
      if (
        ts.isSourceFile(scope) ||
        ts.isBlock(scope) ||
        ts.isModuleBlock?.(scope) ||
        isCaseBlock(scope)
      ) {
        const statements = isCaseBlock(scope)
          ? scope.clauses.flatMap((clause) => [...clause.statements])
          : scope.statements;
        for (const statement of statements) {
          if (ts.isVariableStatement(statement)) {
            addVariableDeclarations(bindings, statement.declarationList);
            continue;
          }
          if (ts.isImportDeclaration(statement) && statement.importClause) {
            const binding = {
              kind: "other",
              declaration: statement,
              initializer: null,
            };
            if (statement.importClause.name) {
              addBinding(bindings, statement.importClause.name.text, binding);
            }
            const named = statement.importClause.namedBindings;
            if (named && ts.isNamespaceImport(named)) {
              addBinding(bindings, named.name.text, binding);
            }
            if (named && ts.isNamedImports(named)) {
              for (const element of named.elements) {
                addBinding(bindings, element.name.text, binding);
              }
            }
            continue;
          }
          if (ts.isImportEqualsDeclaration?.(statement)) {
            addBinding(bindings, statement.name.text, {
              kind: "other",
              declaration: statement,
              initializer: null,
            });
            continue;
          }
          if (
            (ts.isFunctionDeclaration(statement) ||
              ts.isClassDeclaration(statement) ||
              ts.isEnumDeclaration?.(statement)) &&
            statement.name &&
            ts.isIdentifier(statement.name)
          ) {
            addBinding(bindings, statement.name.text, {
              kind: "other",
              declaration: statement,
              initializer: null,
            });
          }
        }
        if (ts.isSourceFile(scope)) addHoistedVariables(bindings, scope);
      }
      if (
        isLoopScope(scope) &&
        scope.initializer &&
        ts.isVariableDeclarationList(scope.initializer)
      ) {
        addVariableDeclarations(bindings, scope.initializer);
      }
      if (ts.isFunctionLike(scope)) {
        for (const parameter of scope.parameters) {
          addBindingName(bindings, parameter.name, {
            kind: "parameter",
            declaration: parameter,
            initializer: null,
          });
        }
        if (scope.name && ts.isIdentifier(scope.name)) {
          addBinding(bindings, scope.name.text, {
            kind: "other",
            declaration: scope,
            initializer: null,
          });
        }
        addHoistedVariables(bindings, scope.body);
      }
      if (
        ts.isClassExpression(scope) &&
        scope.name &&
        ts.isIdentifier(scope.name)
      ) {
        addBinding(bindings, scope.name.text, {
          kind: "other",
          declaration: scope,
          initializer: null,
        });
      }
      if (ts.isCatchClause(scope) && scope.variableDeclaration) {
        addBindingName(bindings, scope.variableDeclaration.name, {
          kind: "parameter",
          declaration: scope.variableDeclaration,
          initializer: null,
        });
      }
      scopeBindings.set(scope, bindings);
      return bindings;
    };
    const bindingFor = (identifier) => {
      let parent = identifier.parent;
      while (parent) {
        if (
          ts.isSourceFile(parent) ||
          ts.isBlock(parent) ||
          ts.isModuleBlock?.(parent) ||
          isCaseBlock(parent) ||
          isLoopScope(parent) ||
          ts.isClassExpression(parent) ||
          ts.isFunctionLike(parent) ||
          ts.isCatchClause(parent)
        ) {
          const matches = bindingsIn(parent).get(identifier.text);
          if (matches) {
            return matches.length === 1
              ? matches[0]
              : { kind: "ambiguous", declaration: parent, initializer: null };
          }
        }
        parent = parent.parent;
      }
      return null;
    };
    const markWrite = (target) => {
      target = unwrap(target);
      if (target && ts.isIdentifier(target)) {
        const binding = bindingFor(target);
        if (binding) written.add(binding.declaration);
      }
    };
    const collectWrites = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        markWrite(node.left);
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        markWrite(node.operand);
      }
      ts.forEachChild(node, collectWrites);
    };
    collectWrites(source);

    const immutableInitializer = (identifier, seen) => {
      const binding = bindingFor(identifier);
      if (
        !binding ||
        binding.kind !== "const" ||
        !binding.initializer ||
        written.has(binding.declaration) ||
        binding.declaration.getStart(source) >= identifier.getStart(source) ||
        seen.has(binding.declaration)
      ) {
        return null;
      }
      return {
        node: binding.initializer,
        seen: new Set(seen).add(binding.declaration),
      };
    };
    const isImportMeta = (node, seen = new Set()) => {
      node = unwrap(node);
      if (
        node &&
        ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        return true;
      }
      if (!node || !ts.isIdentifier(node)) return false;
      const alias = immutableInitializer(node, seen);
      return alias ? isImportMeta(alias.node, alias.seen) : false;
    };
    const constructorKind = (node, seen = new Set()) => {
      node = unwrap(node);
      if (
        node &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "globalThis" &&
        node.name.text === "URL"
      ) {
        return bindingFor(node.expression) ? "OTHER" : "PLATFORM";
      }
      if (!node || !ts.isIdentifier(node)) return "OTHER";
      const binding = bindingFor(node);
      if (!binding) return node.text === "URL" ? "PLATFORM" : "OTHER";
      if (binding.kind === "parameter" || binding.kind === "other") {
        return "OTHER";
      }
      const alias = immutableInitializer(node, seen);
      return alias ? constructorKind(alias.node, alias.seen) : "UNKNOWN";
    };
    const isHttp = (value) => /^https?:\/\//i.test(value);
    const moduleBase = (url = sourceUrl) => ({ kind: "MODULE", url });
    const unknownBase = { kind: "UNKNOWN" };
    const runtimeBase = { kind: "RUNTIME" };
    const resolveBase = (node, seen = new Set()) => {
      node = unwrap(node);
      if (!node) return unknownBase;
      if (ts.isStringLiteralLike(node)) {
        return isHttp(node.text) ? runtimeBase : unknownBase;
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "url") {
        if (isImportMeta(node.expression, seen)) return moduleBase();
        if (ts.isIdentifier(node.expression)) {
          const binding = bindingFor(node.expression);
          if (binding?.kind === "parameter") return runtimeBase;
        }
        return unknownBase;
      }
      if (ts.isIdentifier(node)) {
        const alias = immutableInitializer(node, seen);
        return alias ? resolveBase(alias.node, alias.seen) : unknownBase;
      }
      if (ts.isNewExpression(node)) {
        if (constructorKind(node.expression, seen) !== "PLATFORM") {
          return unknownBase;
        }
        const argument = node.arguments?.[0];
        if (
          argument &&
          ts.isStringLiteralLike(argument) &&
          isHttp(argument.text)
        ) {
          return runtimeBase;
        }
        const base = resolveBase(node.arguments?.[1], seen);
        if (base.kind === "RUNTIME") return runtimeBase;
        if (
          base.kind !== "MODULE" ||
          !argument ||
          !ts.isStringLiteralLike(argument)
        ) {
          return unknownBase;
        }
        try {
          const resolved = new globalThis.URL(argument.text, base.url);
          if (resolved.protocol !== "file:") return runtimeBase;
          if (
            argument.text === "." ||
            argument.text === ".." ||
            argument.text.endsWith("/")
          ) {
            consumedBases.add(node);
          }
          return moduleBase(resolved.href);
        } catch {
          return unknownBase;
        }
      }
      return unknownBase;
    };
    const moduleSpecifier = (spec, base) => {
      if (base.url === sourceUrl) return spec;
      try {
        const resolved = new globalThis.URL(spec, base.url);
        if (resolved.protocol !== "file:") return null;
        const relative = portable(
          path.relative(path.dirname(fileName), fileURLToPath(resolved)),
        );
        return relative.startsWith(".") ? relative : `./${relative}`;
      } catch {
        return null;
      }
    };
    const expressions = [];
    const collectExpressions = (node) => {
      if (ts.isNewExpression(node)) {
        const constructor = constructorKind(node.expression);
        if (constructor !== "OTHER") expressions.push({ node, constructor });
      }
      ts.forEachChild(node, collectExpressions);
    };
    collectExpressions(source);
    const bases = new Map(
      expressions.map(({ node }) => [node, resolveBase(node.arguments?.[1])]),
    );
    for (const { node, constructor } of expressions) {
      if (consumedBases.has(node)) continue;
      const argument = node.arguments?.[0];
      const spec = argument
        ? ts.isStringLiteralLike(argument)
          ? argument.text
          : argument.getText(source)
        : "<no argument>";
      const base = bases.get(node) ?? unknownBase;
      // A module resource needs a base to be relative to, and the module branch
      // below only accepts a string-literal specifier. Two shapes therefore
      // cannot be module edges at all, and blocking them claims an edge the
      // scanner has no evidence for:
      //   1. a single-argument `new URL(x)` -- there is no base, so nothing
      //      module-relative can resolve;
      //   2. a computed specifier over a base bound to a function parameter --
      //      the module branch would have refused the specifier anyway, and
      //      `param.url` is already treated as a runtime base above.
      const baseNode = unwrap(node.arguments?.[1]);
      const parameterBase = Boolean(
        baseNode &&
        ts.isIdentifier(baseNode) &&
        bindingFor(baseNode)?.kind === "parameter",
      );
      const computedSpecifier = Boolean(
        argument && !ts.isStringLiteralLike(argument),
      );
      if (
        (argument &&
          ts.isStringLiteralLike(argument) &&
          isHttp(argument.text)) ||
        (constructor === "PLATFORM" && base.kind === "RUNTIME") ||
        (constructor === "PLATFORM" && node.arguments?.length === 1) ||
        (constructor === "PLATFORM" && parameterBase && computedSpecifier)
      ) {
        edges.push({
          kind: "RUNTIME_URL",
          spec,
          base: node.arguments?.[1]?.getText(source) ?? null,
          line: lineOf(node),
        });
        continue;
      }
      if (
        constructor === "PLATFORM" &&
        base.kind === "MODULE" &&
        argument &&
        ts.isStringLiteralLike(argument)
      ) {
        const resolvedSpec = moduleSpecifier(argument.text, base);
        if (resolvedSpec) {
          edges.push({
            kind: "MODULE_RESOURCE",
            spec: resolvedSpec,
            line: lineOf(node),
          });
          continue;
        }
      }
      edges.push({
        kind: "MODULE_RESOURCE_NONLITERAL",
        spec,
        line: lineOf(node),
      });
    }
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      edges.push({
        kind: ts.isExportDeclaration(node) ? "REEXPORT" : "IMPORT",
        spec: node.moduleSpecifier.text,
        line: lineOf(node),
        ...(algorithmVersion >= 2
          ? {
              symbols: ts.isExportDeclaration(node)
                ? exportSymbols(node)
                : importSymbols(node),
            }
          : {}),
      });
    } else if (
      ts.isImportEqualsDeclaration?.(node) &&
      node.moduleReference &&
      ts.isExternalModuleReference?.(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      edges.push({
        kind: "IMPORT",
        spec: node.moduleReference.expression.text,
        line: lineOf(node),
        ...(algorithmVersion >= 2 ? { symbols: ["*"] } : {}),
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      edges.push({
        kind: "TYPE_IMPORT",
        spec: node.argument.literal.text,
        line: lineOf(node),
        ...(algorithmVersion >= 2 ? { symbols: ["*"] } : {}),
      });
    } else if (ts.isCallExpression(node)) {
      const argument = node.arguments[0];
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamic || required) {
        if (argument && ts.isStringLiteralLike(argument)) {
          edges.push({
            kind: dynamic ? "DYNAMIC" : "REQUIRE",
            spec: argument.text,
            line: lineOf(node),
            ...(algorithmVersion >= 2 ? { symbols: ["*"] } : {}),
          });
        } else {
          edges.push({
            kind: "DYNAMIC_NONLITERAL",
            spec: argument ? argument.getText(source) : "<no argument>",
            line: lineOf(node),
          });
        }
      }
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      const namespaceArgument =
        algorithmVersion >= 2 && callee === "getFixedT"
          ? node.arguments[1]
          : argument;
      if (
        (callee === "useTranslation" ||
          callee === "getFixedT" ||
          callee === "loadNamespaces") &&
        namespaceArgument
      ) {
        if (ts.isStringLiteralLike(namespaceArgument)) {
          edges.push({
            kind: "I18N_NAMESPACE",
            spec: namespaceArgument.text,
            line: lineOf(node),
          });
        } else if (ts.isArrayLiteralExpression(namespaceArgument)) {
          for (const element of namespaceArgument.elements) {
            if (ts.isStringLiteralLike(element)) {
              edges.push({
                kind: "I18N_NAMESPACE",
                spec: element.text,
                line: lineOf(node),
              });
            }
          }
        }
      }
    } else if (
      algorithmVersion >= 2 &&
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.initializer) &&
      importBindings.has(node.initializer.text)
    ) {
      const name = node.name;
      const namespace =
        ts.isIdentifier(name) || ts.isStringLiteralLike(name)
          ? name.text
          : null;
      const binding = importBindings.get(node.initializer.text);
      if (namespace && path.extname(binding.spec).toLowerCase() === ".json") {
        edges.push({
          kind: "I18N_RESOURCE_MAPPING",
          namespace,
          spec: binding.spec,
          symbol: binding.symbol,
          line: lineOf(node),
        });
      }
    } else if (
      algorithmVersion === 1 &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL"
    ) {
      const argument = node.arguments?.[0];
      edges.push(
        argument && ts.isStringLiteralLike(argument)
          ? {
              kind: "NEW_URL",
              spec: argument.text,
              line: lineOf(node),
            }
          : {
              kind: "NEW_URL_NONLITERAL",
              spec: argument ? argument.getText(source) : "<no argument>",
              line: lineOf(node),
            },
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (algorithmVersion >= 2) moduleUrlEdges();
  return edges;
};

const SCRIPT_UNIT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Bounded structural granularity: exported root -> contract domain -> named
// registry entry, then STOP. Depth 3 is exactly theme.components.MuiDrawer; it
// never explodes an implementation leaf like styleOverrides.root.padding.
const STRUCTURAL_MAX_DEPTH = 3;

/**
 * The machine-derived structural contract census for one source file. Returns a
 * deterministic, sorted list of `{ path, kind, resolved }`. It is framework
 * neutral: no framework name or prefix appears here. A statically-undecidable
 * key (spread of an imported value, computed key, call result) is surfaced with
 * `resolved: false` so it can never be silently dropped.
 */
export const structuralUnits = (ts, fileName, text) => {
  const extension = path.extname(fileName).toLowerCase();
  if (!SCRIPT_UNIT_EXTENSIONS.has(extension)) {
    return [{ path: portable(fileName), kind: "FILE", resolved: true }];
  }
  const units = new Map();
  const add = (unitPath, kind, resolved = true) => {
    if (!units.has(unitPath))
      units.set(unitPath, { path: unitPath, kind, resolved });
  };
  const exported = (node) =>
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
  // Unwraps an initializer to the object literal it contributes: a bare object
  // literal, the single argument of a top-level call (createTheme({...}),
  // configureStore({...}), defineConfig({...})), or a locally declared binding
  // either form names -- `const components = {...}` reached through
  // `createTheme({ components })` is the same structure written in two
  // statements. `unresolved` marks an identifier whose shape is undecidable in
  // this file (imported, cyclic, or not an object) so the caller can surface it
  // instead of dropping the structure it stands for. `seen` is the cycle guard
  // for an alias chain (`const a = b; const b = a;`).
  const objectLiteralOf = (node, seen = new Set()) => {
    // ponytail: returns { objects: ASTNode[], unresolved: boolean } — an array
    // because a ConditionalExpression may contribute objects from both branches.
    if (!node) return { objects: [], unresolved: false };
    if (ts.isObjectLiteralExpression(node))
      return { objects: [node], unresolved: false };
    if (ts.isParenthesizedExpression?.(node) || ts.isAsExpression?.(node)) {
      return objectLiteralOf(node.expression, seen);
    }
    if (ts.isConditionalExpression?.(node)) {
      const trueResult = objectLiteralOf(node.whenTrue, seen);
      const falseResult = objectLiteralOf(node.whenFalse, seen);
      const objects = [...trueResult.objects, ...falseResult.objects];
      const unresolved = trueResult.unresolved || falseResult.unresolved;
      return { objects, unresolved };
    }
    if (ts.isArrowFunction?.(node) || ts.isFunctionExpression?.(node)) {
      const body = ts.isBlock(node.body)
        ? node.body.statements.at(-1)
        : node.body;
      if (body && ts.isReturnStatement?.(body))
        return objectLiteralOf(body.expression, seen);
      if (body && !ts.isBlock(node.body)) return objectLiteralOf(body, seen);
      return { objects: [], unresolved: false };
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text) || !locals.has(node.text))
        return { objects: [], unresolved: true };
      seen.add(node.text);
      const target = objectLiteralOf(locals.get(node.text), seen);
      return target.objects.length ? target : { objects: [], unresolved: true };
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      return objectLiteralOf(node.arguments[0], seen);
    }
    return { objects: [], unresolved: false };
  };
  const staticKey = (property) => {
    const nameNode = property.name;
    if (!nameNode) return null;
    if (ts.isIdentifier(nameNode)) return nameNode.text;
    if (ts.isStringLiteral(nameNode)) return nameNode.text;
    if (ts.isNumericLiteral(nameNode)) return nameNode.text;
    return null;
  };
  const recurse = (prefix, objectLiteral, depth) => {
    if (depth > STRUCTURAL_MAX_DEPTH) return;
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        add(`${prefix}.<spread>`, "MEMBER", false);
        continue;
      }
      const key = staticKey(property);
      if (key === null) {
        add(`${prefix}.<computed>`, "MEMBER", false);
        continue;
      }
      const unitPath = `${prefix}.${key}`;
      add(unitPath, "MEMBER", true);
      // A shorthand carries its value in the name node, not an initializer.
      descend(
        unitPath,
        ts.isShorthandPropertyAssignment(property)
          ? property.name
          : property.initializer,
        depth + 1,
      );
    }
  };
  // Depth is checked here, so the bounded granularity holds for a resolved
  // binding and for an unresolved one alike.
  const descend = (unitPath, node, depth) => {
    if (depth > STRUCTURAL_MAX_DEPTH) return;
    const { objects, unresolved } = objectLiteralOf(node);
    for (const obj of objects) recurse(unitPath, obj, depth);
    if (!objects.length && unresolved)
      add(`${unitPath}.<unresolved>`, "MEMBER", false);
  };
  const addBinding = (name, initializer) => {
    add(name, "BINDING", true);
    descend(name, initializer, 2);
  };
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  // A binding may be declared in one statement and exported in another
  // (`const theme = createTheme({...}); export { theme };`), so the top-level
  // declarations are indexed first and `export { ... }` resolves against them.
  // Without this the census returns `[]` for that file and every unit it owns
  // silently leaves the completeness universe.
  const locals = new Map();
  const imported = new Set();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          locals.set(declaration.name.text, declaration.initializer);
      }
      continue;
    }
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      if (statement.importClause.name)
        imported.add(statement.importClause.name.text);
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        imported.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements)
          imported.add(element.name.text);
      }
    }
  }
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      const expr = statement.expression;
      // `export default <local>` names the bound structure by its own
      // identifier (`theme.components.MuiDrawer`), matching how the binding is
      // written when it is also `export { theme }`.
      if (!statement.isExportEquals && expr && ts.isIdentifier(expr)) {
        if (!locals.has(expr.text)) add(expr.text, "BINDING", false);
        else addBinding(expr.text, locals.get(expr.text));
      } else {
        add("default", "BINDING", true);
        descend("default", expr, 2);
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      !ts.isNamespaceExport?.(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        // A re-export names something declared in another file, so its shape is
        // undecidable here and is surfaced rather than silently dropped. The
        // same holds for a locally imported name: there is no initializer in
        // this file to resolve, so it must not be marked resolved.
        const localName = (element.propertyName ?? element.name).text;
        if (statement.moduleSpecifier || !locals.has(localName)) {
          add(element.name.text, "BINDING", false);
        } else {
          addBinding(element.name.text, locals.get(localName));
        }
      }
      continue;
    }
    if (!exported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        addBinding(declaration.name.text, declaration.initializer);
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) {
      add(statement.name.text, "BINDING", true);
    }
  }
  return [...units.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
};

const scriptExportNames = (ts, fileName, text) => {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set();
  const exported = (node) =>
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
  const addBinding = (name) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBinding(element.name);
      }
    }
  };
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamespaceExport?.(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
      } else {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
        }
      }
      continue;
    }
    if (!exported(statement)) continue;
    if (statement.name && ts.isIdentifier(statement.name)) {
      names.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBinding(declaration.name);
      }
    }
    if (
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )
    ) {
      names.add("default");
    }
  }
  return names;
};

// CSS is not a TypeScript dialect, so the compiler cannot parse it. These two
// forms are the whole surface: `@import` pulls in another stylesheet, `url()`
// pulls in an asset.
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

const styleEdges = (text, algorithmVersion) => {
  const edges = [];
  const lineOf = (index) =>
    algorithmVersion >= 2 ? text.slice(0, index).split("\n").length : 0;
  for (const match of text.matchAll(CSS_IMPORT)) {
    edges.push({
      kind: "CSS_IMPORT",
      spec: match[1],
      line: lineOf(match.index),
    });
  }
  for (const match of text.matchAll(CSS_URL)) {
    if (match[1].startsWith("data:") || /^[a-z]+:\/\//i.test(match[1]))
      continue;
    edges.push({
      kind: "CSS_URL",
      spec: match[1],
      line: lineOf(match.index),
    });
  }
  return edges;
};

/**
 * A root-relative specifier is a runtime URL, not a module reference:
 * `new URL('/login', request.url)` is a route and `url(/img/a.png)` is a
 * public asset, and neither is resolved by the module resolver. Treating them
 * as first-party would block every real project on references that can never
 * resolve to a module.
 */
const isFirstPartySpecifier = (spec, aliasPrefixes) =>
  spec.startsWith(".") ||
  aliasPrefixes.some(
    (prefix) => spec === prefix || spec.startsWith(`${prefix}/`),
  );

/** Blocking finding kinds: an edge whose target cannot be proven. */
const FINDING_KINDS = new Set([
  "DYNAMIC_NONLITERAL",
  "NEW_URL_NONLITERAL",
  "MODULE_RESOURCE_NONLITERAL",
  "I18N_NAMESPACE",
]);

/** The subset that names a module path, so its target could be an owned file. */
const UNPROVEN_MODULE_EDGES = new Set([
  "DYNAMIC_NONLITERAL",
  "NEW_URL_NONLITERAL",
  "MODULE_RESOURCE_NONLITERAL",
]);

export const runDiscoveryScan = async ({
  legacyRoot,
  moduleRoots,
  declaredEntryPoints = [],
  moduleEdgeTargets = {},
  algorithmVersion = CENSUS_ALGORITHM_VERSION,
  typescript,
} = {}) => {
  if (typeof legacyRoot !== "string" || !legacyRoot) {
    throw new Error("Discovery scan requires a legacy root.");
  }
  const roots = [
    ...new Set(
      (Array.isArray(moduleRoots) ? moduleRoots : []).map((value, index) =>
        normalizeRoot(value, `moduleRoots[${index}]`),
      ),
    ),
  ].sort();
  if (roots.length === 0) {
    throw new Error(
      "Discovery scan requires at least one declared module root. The census -- not the import graph -- defines the module.",
    );
  }
  if (!SUPPORTED_ALGORITHM_VERSIONS.has(algorithmVersion)) {
    throw new Error(
      `Unsupported discovery scanner algorithm version '${algorithmVersion}'. Supported versions: ${[...SUPPORTED_ALGORITHM_VERSIONS].join(", ")}.`,
    );
  }

  const tracked = await gitList(legacyRoot, ".");
  const trackedSet = new Set(tracked);
  const census = [];
  for (const relativePath of tracked) {
    if (!roots.some((root) => underRoot(relativePath, root))) continue;
    if (await assertNotSymlink(legacyRoot, relativePath))
      census.push(relativePath);
  }
  census.sort();
  const censusSet = new Set(census);

  // The compiler is only needed to parse scripts. A module of stylesheets and
  // assets, or a fixture with no code at all, must not be blocked on a
  // toolchain it never uses -- CSS is not a TypeScript dialect anyway.
  const parseables = tracked.filter(isParseable);
  const ts = parseables.some(isScript)
    ? (typescript ?? loadTypeScript())
    : null;

  let compilerOptions = {};
  let tsconfigPath = null;
  let tsconfigDigest = null;
  if (ts) {
    const found = ts.findConfigFile(
      legacyRoot,
      ts.sys.fileExists,
      "tsconfig.json",
    );
    if (found && isWithin(legacyRoot, path.resolve(found))) {
      tsconfigPath = portable(path.relative(legacyRoot, path.resolve(found)));
      tsconfigDigest = `sha256:${createHash("sha256")
        .update(await readFile(path.resolve(found)))
        .digest("hex")}`;
      const { config, error } = ts.readConfigFile(found, ts.sys.readFile);
      if (error) {
        throw new Error(
          `Cannot read the legacy tsconfig '${tsconfigPath}': ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
        );
      }
      compilerOptions = ts.parseJsonConfigFileContent(
        config,
        ts.sys,
        legacyRoot,
      ).options;
    }
  }
  const resolutionOptions = {
    ...compilerOptions,
    allowJs: true,
    resolveJsonModule: true,
  };
  const aliasPrefixes = Object.keys(compilerOptions.paths ?? {})
    .map((pattern) => pattern.replace(/\/?\*$/, ""))
    .filter(Boolean)
    .sort();
  const resolutionHost = ts
    ? { fileExists: ts.sys.fileExists, readFile: ts.sys.readFile }
    : null;

  const probe = (candidate) => {
    const relative = portable(path.relative(legacyRoot, candidate));
    if (relative.startsWith("..")) return null;
    if (trackedSet.has(relative)) return relative;
    for (const extension of PROBE_EXTENSIONS) {
      if (trackedSet.has(`${relative}${extension}`))
        return `${relative}${extension}`;
    }
    for (const extension of PROBE_EXTENSIONS) {
      if (trackedSet.has(`${relative}/index${extension}`))
        return `${relative}/index${extension}`;
    }
    return null;
  };

  const resolveSpecifier = (spec, fromRelative) => {
    const fromAbsolute = path.join(legacyRoot, fromRelative);
    if (ts && !spec.startsWith("/")) {
      const resolved = ts.resolveModuleName(
        spec,
        fromAbsolute,
        resolutionOptions,
        resolutionHost,
      ).resolvedModule;
      if (resolved) {
        const absolute = path.resolve(resolved.resolvedFileName);
        if (
          !resolved.isExternalLibraryImport &&
          isWithin(legacyRoot, absolute) &&
          !portable(path.relative(legacyRoot, absolute)).includes(
            "node_modules/",
          )
        ) {
          return { to: portable(path.relative(legacyRoot, absolute)) };
        }
        return { external: spec };
      }
    }
    // TypeScript resolution does not cover CSS, images or fonts; probe the
    // tracked file list literally for those.
    if (spec.startsWith(".")) {
      const hit = probe(path.resolve(path.dirname(fromAbsolute), spec));
      if (hit) return { to: hit };
    } else {
      for (const [pattern, targets] of Object.entries(
        compilerOptions.paths ?? {},
      )) {
        const prefix = pattern.replace(/\*$/, "");
        if (!spec.startsWith(prefix)) continue;
        const rest = spec.slice(prefix.length);
        for (const target of targets) {
          const candidate = path.resolve(
            compilerOptions.baseUrl ?? legacyRoot,
            target.replace(/\*$/, "") + rest,
          );
          const hit = probe(candidate);
          if (hit) return { to: hit };
        }
      }
    }
    return isFirstPartySpecifier(spec, aliasPrefixes)
      ? { unresolved: spec, firstParty: true }
      : { external: spec };
  };

  const edges = [];
  const findings = [];
  const unresolved = [];
  const resourceMappings = [];
  const runtimeUrls = [];
  const exportedNames = new Map();
  const external = new Set();
  const externalEdges = [];
  const outgoing = new Map();
  const addOutgoing = (from, to) => {
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    outgoing.get(from).add(to);
  };

  for (const relativePath of parseables) {
    let text;
    try {
      text = await readFile(path.join(legacyRoot, relativePath), "utf8");
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") continue;
      throw error;
    }
    const fileEdges = isScript(relativePath)
      ? scriptEdges(
          ts,
          path.join(legacyRoot, relativePath),
          text,
          algorithmVersion,
        )
      : styleEdges(text, algorithmVersion);
    if (algorithmVersion >= 2 && isScript(relativePath)) {
      exportedNames.set(
        relativePath,
        scriptExportNames(ts, path.join(legacyRoot, relativePath), text),
      );
    }
    for (const edge of fileEdges) {
      if (edge.kind === "RUNTIME_URL") {
        runtimeUrls.push({
          file: relativePath,
          line: edge.line,
          spec: edge.spec,
          base: edge.base,
        });
        continue;
      }
      if (FINDING_KINDS.has(edge.kind)) {
        findings.push({
          type: edge.kind,
          file: relativePath,
          line: edge.line,
          spec: edge.spec,
        });
        continue;
      }
      const resolution = resolveSpecifier(edge.spec, relativePath);
      if (resolution.to) {
        const resolvedEdge = {
          from: relativePath,
          kind: edge.kind,
          spec: edge.spec,
          to: resolution.to,
          ...(algorithmVersion >= 2
            ? {
                line: edge.line,
                ...(edge.symbols ? { symbols: edge.symbols } : {}),
              }
            : {}),
        };
        if (edge.kind === "I18N_RESOURCE_MAPPING") {
          resourceMappings.push({
            ...resolvedEdge,
            namespace: edge.namespace,
          });
          continue;
        }
        edges.push(resolvedEdge);
        addOutgoing(relativePath, resolution.to);
      } else if (resolution.unresolved) {
        unresolved.push({
          from: relativePath,
          spec: edge.spec,
          firstParty: true,
          ...(algorithmVersion >= 2
            ? { kind: edge.kind, line: edge.line }
            : {}),
        });
      } else {
        external.add(resolution.external);
        if (algorithmVersion >= 2) {
          externalEdges.push({ from: relativePath, spec: resolution.external });
        }
      }
    }
  }

  const entryPoints = new Map();
  const addEntryPoint = (entryPath, discovery, reason) => {
    if (entryPoints.has(entryPath)) return;
    entryPoints.set(entryPath, { path: entryPath, discovery, reason });
  };

  for (const relativePath of tracked) {
    if (!isScript(relativePath)) continue;
    const segments = relativePath.split("/");
    const base = path.basename(relativePath, path.extname(relativePath));
    if (segments.includes("app") && NEXT_APP_FILES.has(base)) {
      addEntryPoint(
        relativePath,
        "FRAMEWORK",
        `Next.js app-directory convention '${base}'.`,
      );
      continue;
    }
    if (segments.length <= 2 && NEXT_ROOT_FILES.has(base)) {
      addEntryPoint(
        relativePath,
        "FRAMEWORK",
        `Next.js project-root convention '${base}'.`,
      );
      continue;
    }
    if (segments.length <= 2 && base.startsWith("next.config")) {
      addEntryPoint(relativePath, "FRAMEWORK", "Next.js configuration.");
    }
  }

  const inbound = [];
  for (const edge of edges) {
    if (censusSet.has(edge.from) || !censusSet.has(edge.to)) continue;
    inbound.push(edge);
    addEntryPoint(
      edge.from,
      entryPoints.get(edge.from)?.discovery ?? "INBOUND",
      entryPoints.get(edge.from)?.reason ??
        `References the module directly (${edge.to}).`,
    );
  }

  const declaredPaths = new Set();
  for (const [index, declared] of (Array.isArray(declaredEntryPoints)
    ? declaredEntryPoints
    : []
  ).entries()) {
    const entryPath = normalizeRoot(
      typeof declared === "string" ? declared : declared?.path,
      `declaredEntryPoints[${index}]`,
    );
    if (!trackedSet.has(entryPath)) {
      throw new Error(
        `Declared entry point '${entryPath}' is not a tracked file under the legacy root.`,
      );
    }
    declaredPaths.add(entryPath);
    if (!entryPoints.has(entryPath)) {
      addEntryPoint(
        entryPath,
        "DECLARED",
        typeof declared === "string"
          ? "Declared by the migration."
          : (declared?.reason ?? "Declared by the migration."),
      );
    }
  }

  const reachFrom = (seeds) => {
    const seen = new Set();
    const queue = [...seeds];
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of outgoing.get(current) ?? []) queue.push(next);
    }
    return seen;
  };

  const entryList = [...entryPoints.values()];
  const productionSeeds = entryList
    .filter(
      (entry) =>
        entry.discovery !== "INBOUND" && !TEST_PATTERN.test(entry.path),
    )
    .map((entry) => entry.path);
  const inboundSeeds = entryList
    .filter((entry) => !TEST_PATTERN.test(entry.path))
    .map((entry) => entry.path);
  const testSeeds = tracked.filter(
    (relativePath) => isScript(relativePath) && TEST_PATTERN.test(relativePath),
  );

  const fromProduction = reachFrom(productionSeeds);
  const fromInbound = reachFrom(inboundSeeds);
  const fromTests = reachFrom(testSeeds);

  const reachability = {};
  for (const relativePath of census) {
    reachability[relativePath] = fromProduction.has(relativePath)
      ? "REACHABLE_FROM_ENTRY"
      : fromInbound.has(relativePath)
        ? "REACHABLE_INBOUND_ONLY"
        : fromTests.has(relativePath)
          ? "REACHABLE_TEST_ONLY"
          : "UNREACHABLE";
  }

  if (algorithmVersion === 1) {
    // SUPPORTING is the module's own out-closure: what an owned file requires.
    // It is deliberately not "everything an entry point reaches" -- that is the
    // whole application, and none of it is required *by* the module.
    const supportingClosure = reachFrom(census);
    const requiredBy = new Map();
    for (const edge of edges) {
      if (!supportingClosure.has(edge.from) || censusSet.has(edge.to)) continue;
      if (!requiredBy.has(edge.to)) requiredBy.set(edge.to, new Set());
      requiredBy.get(edge.to).add(edge.from);
    }
    const supporting = [...supportingClosure]
      .filter((relativePath) => !censusSet.has(relativePath))
      .sort();

    // An unproven edge only matters where it could hide a module file: inside the
    // module, in what the module requires, or in something that reaches into it.
    // A framework route elsewhere in the app that never touches this module can
    // hide nothing here, and blocking on it would make the checkpoint about the
    // whole repository instead of the module.
    const relevant = new Set([
      ...census,
      ...supporting,
      ...inbound.map((edge) => edge.from),
    ]);
    // One exception, and it is the reason a component could still vanish: a
    // discovered production entry point whose module edge is computed at runtime.
    // Its target can be any file in the repository, including one this module
    // owns, and it can never appear in `relevant` -- an unresolved edge is
    // precisely an edge that could not establish the resolved inbound
    // relationship the set is built from. Discarding it let the owned target stay
    // UNREACHABLE and therefore agent-dismissible. An i18n namespace is a
    // resource token rather than a module path, so an unrelated route's namespace
    // stays out and the module's scope is preserved.
    const productionEntry = new Set(productionSeeds);
    const unprovenFromEntry = (finding) =>
      UNPROVEN_MODULE_EDGES.has(finding.type) &&
      productionEntry.has(finding.file);
    const relevantFindings = findings
      .filter(
        (finding) => relevant.has(finding.file) || unprovenFromEntry(finding),
      )
      .sort(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.type.localeCompare(right.type) ||
          left.line - right.line ||
          left.spec.localeCompare(right.spec),
      )
      .map((finding, index) => ({
        id: `FIND-${String(index + 1).padStart(3, "0")}`,
        ...finding,
      }));
    const relevantUnresolved = unresolved
      .filter((entry) => relevant.has(entry.from))
      .sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.spec.localeCompare(right.spec),
      );

    const scan = {
      algorithmVersion,
      moduleRoots: roots,
      entryPoints: entryList.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      resolution: {
        typescriptVersion: ts?.version ?? null,
        tsconfigPath,
        tsconfigDigest,
        compilerOptions: {
          baseUrl: compilerOptions.baseUrl
            ? portable(path.relative(legacyRoot, compilerOptions.baseUrl))
            : null,
          paths: compilerOptions.paths ?? null,
          moduleResolution: compilerOptions.moduleResolution ?? null,
          module: compilerOptions.module ?? null,
          jsx: compilerOptions.jsx ?? null,
        },
        extensions: PROBE_EXTENSIONS,
        censusCommand: CENSUS_COMMAND,
      },
      census,
      supporting,
      external: [...external].sort(),
      edges: edges.sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to) ||
          left.kind.localeCompare(right.kind) ||
          left.spec.localeCompare(right.spec),
      ),
      findings: relevantFindings,
      unresolved: relevantUnresolved,
      reachability,
      kinds: Object.fromEntries(
        census.map((relativePath) => [relativePath, kindOf(relativePath)]),
      ),
      requiredBy: Object.fromEntries(
        [...requiredBy.entries()]
          .map(([key, value]) => [key, [...value].sort()])
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    return { ...scan, discoveryDigest: discoveryDigest(scan) };
  }

  const edgeKey = (edge) =>
    JSON.stringify([
      edge.from,
      edge.line ?? 0,
      edge.kind,
      edge.spec,
      edge.to,
      edge.findingId ?? null,
      edge.via ?? null,
    ]);
  const compareEdges = (left, right) =>
    left.from.localeCompare(right.from) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.to.localeCompare(right.to) ||
    left.kind.localeCompare(right.kind) ||
    left.spec.localeCompare(right.spec);
  const compareFindings = (left, right) =>
    left.file.localeCompare(right.file) ||
    left.type.localeCompare(right.type) ||
    left.line - right.line ||
    left.spec.localeCompare(right.spec);
  const stableFindingId = (finding) =>
    `FIND-${createHash("sha256")
      .update(
        JSON.stringify([
          finding.type,
          finding.file,
          finding.line,
          finding.spec,
        ]),
      )
      .digest("hex")
      .slice(0, 16)}`;
  const allFindings = findings
    .sort(compareFindings)
    .map((finding) => ({ id: stableFindingId(finding), ...finding }));
  const findingIds = new Set(allFindings.map((finding) => finding.id));
  if (
    !moduleEdgeTargets ||
    typeof moduleEdgeTargets !== "object" ||
    Array.isArray(moduleEdgeTargets)
  ) {
    throw new Error("moduleEdgeTargets must be an object keyed by finding id.");
  }
  for (const findingId of Object.keys(moduleEdgeTargets)) {
    if (!findingIds.has(findingId)) {
      throw new Error(
        `moduleEdgeTargets names stale or unknown finding '${findingId}'. Re-run discovery and use the current stable finding id.`,
      );
    }
  }

  const edgesFrom = new Map();
  const edgesTo = new Map();
  const indexEdge = (edge) => {
    if (!edgesFrom.has(edge.from)) edgesFrom.set(edge.from, []);
    edgesFrom.get(edge.from).push(edge);
    if (!edgesTo.has(edge.to)) edgesTo.set(edge.to, []);
    edgesTo.get(edge.to).push(edge);
  };
  for (const edge of edges) indexEdge(edge);
  const exportCache = new Map();
  const exportsSymbol = (file, symbol, seen = new Set()) => {
    const cacheKey = `${file}\0${symbol}`;
    if (exportCache.has(cacheKey)) return exportCache.get(cacheKey);
    if (seen.has(file)) return false;
    const nextSeen = new Set(seen).add(file);
    if (exportedNames.get(file)?.has(symbol)) {
      exportCache.set(cacheKey, true);
      return true;
    }
    for (const edge of edgesFrom.get(file) ?? []) {
      if (edge.kind !== "REEXPORT") continue;
      const symbols = edge.symbols ?? ["*"];
      if (symbols.includes(symbol)) {
        exportCache.set(cacheKey, true);
        return true;
      }
      if (symbols.includes("*") && exportsSymbol(edge.to, symbol, nextSeen)) {
        exportCache.set(cacheKey, true);
        return true;
      }
    }
    exportCache.set(cacheKey, false);
    return false;
  };

  // A supporting barrel is traversed only for the symbols an owned file asks
  // it for. `export *` and namespace imports remain conservative; named
  // imports do not drag unrelated exports into the migration boundary.
  const demandByPath = new Map();
  const supportQueue = [];
  const supportingSet = new Set();
  const relevantEdgeKeys = new Set();
  const addDemand = (file, symbols = ["*"]) => {
    const incoming = new Set(symbols.length > 0 ? symbols : ["*"]);
    const current = demandByPath.get(file) ?? new Set();
    const before = current.size;
    const widenedToWildcard = incoming.has("*") && !current.has("*");
    if (incoming.has("*")) {
      current.clear();
      current.add("*");
    } else if (!current.has("*")) {
      for (const symbol of incoming) current.add(symbol);
    }
    demandByPath.set(file, current);
    if (widenedToWildcard || current.size !== before) supportQueue.push(file);
  };
  for (const file of census) addDemand(file);
  const processSupportQueue = () => {
    while (supportQueue.length > 0) {
      const from = supportQueue.shift();
      const demand = demandByPath.get(from) ?? new Set(["*"]);
      for (const edge of edgesFrom.get(from) ?? []) {
        if (edge.kind === "REEXPORT" && !censusSet.has(from)) {
          const symbols = new Set(edge.symbols ?? ["*"]);
          if (
            !demand.has("*") &&
            ![...demand].some(
              (symbol) =>
                symbols.has(symbol) ||
                (symbols.has("*") && exportsSymbol(edge.to, symbol)),
            )
          ) {
            continue;
          }
        }
        relevantEdgeKeys.add(edgeKey(edge));
        if (!censusSet.has(edge.to)) supportingSet.add(edge.to);
        addDemand(edge.to, edge.symbols ?? ["*"]);
      }
    }
  };
  processSupportQueue();

  // Reverse reachability proves who consumes the module. Only edges on a path
  // into an owned file are retained; unrelated repository edges never enter
  // the boundary or its digest.
  const reverseReachable = new Set(census);
  const reverseQueue = [...census];
  while (reverseQueue.length > 0) {
    const to = reverseQueue.shift();
    for (const edge of edgesTo.get(to) ?? []) {
      relevantEdgeKeys.add(edgeKey(edge));
      if (reverseReachable.has(edge.from)) continue;
      reverseReachable.add(edge.from);
      reverseQueue.push(edge.from);
    }
  }
  const consumerSet = new Set(
    [...reverseReachable, ...declaredPaths].filter(
      (file) => !censusSet.has(file) && !supportingSet.has(file),
    ),
  );
  const frameworkSet = new Set(
    [...consumerSet].filter(
      (file) => entryPoints.get(file)?.discovery === "FRAMEWORK",
    ),
  );
  const i18nConfiguration = new Set();
  const resolvedI18n = new Set();
  const resolvedTargets = new Map();
  const syntheticEdges = [];
  const findingProcessed = new Set();

  const currentRelevant = () =>
    new Set([
      ...census,
      ...supportingSet,
      ...consumerSet,
      ...frameworkSet,
      ...i18nConfiguration,
    ]);
  let changed = true;
  while (changed) {
    changed = false;
    const relevant = currentRelevant();
    for (const finding of allFindings) {
      if (findingProcessed.has(finding.id) || !relevant.has(finding.file)) {
        continue;
      }
      findingProcessed.add(finding.id);
      if (finding.type === "I18N_NAMESPACE") {
        const mappings = resourceMappings
          .filter((mapping) => mapping.namespace === finding.spec)
          .sort(compareEdges);
        if (mappings.length === 0) continue;
        resolvedI18n.add(finding.id);
        for (const mapping of mappings) {
          i18nConfiguration.add(mapping.from);
          frameworkSet.add(mapping.from);
          consumerSet.delete(mapping.from);
          const edge = {
            from: finding.file,
            line: finding.line,
            kind: "I18N_NAMESPACE",
            spec: finding.spec,
            to: mapping.to,
            via: mapping.from,
            viaLine: mapping.line,
            findingId: finding.id,
          };
          syntheticEdges.push(edge);
          relevantEdgeKeys.add(edgeKey(edge));
          if (!censusSet.has(mapping.to)) supportingSet.add(mapping.to);
          addDemand(mapping.to);
        }
        processSupportQueue();
        changed = true;
        continue;
      }
      if (!UNPROVEN_MODULE_EDGES.has(finding.type)) continue;
      const rawTargets = moduleEdgeTargets[finding.id];
      if (rawTargets === undefined) continue;
      if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
        throw new Error(
          `${finding.id} requires at least one concrete tracked target; prose or approval alone cannot resolve a module edge.`,
        );
      }
      const targets = [
        ...new Set(
          rawTargets.map((target, index) =>
            normalizeRoot(target, `moduleEdgeTargets.${finding.id}[${index}]`),
          ),
        ),
      ].sort();
      for (const target of targets) {
        if (
          !trackedSet.has(target) ||
          !(await assertNotSymlink(legacyRoot, target))
        ) {
          throw new Error(
            `${finding.id} target '${target}' is not a concrete tracked file under the legacy root.`,
          );
        }
        const edge = {
          from: finding.file,
          line: finding.line,
          kind: `${finding.type}_TARGET`,
          spec: finding.spec,
          to: target,
          findingId: finding.id,
        };
        syntheticEdges.push(edge);
        indexEdge(edge);
        relevantEdgeKeys.add(edgeKey(edge));
        if (!censusSet.has(target)) supportingSet.add(target);
        addDemand(target);
      }
      resolvedTargets.set(finding.id, targets);
      processSupportQueue();
      changed = true;
    }
  }

  const relevantAfterFindings = currentRelevant();
  for (const findingId of Object.keys(moduleEdgeTargets)) {
    const finding = allFindings.find((entry) => entry.id === findingId);
    if (!relevantAfterFindings.has(finding.file)) {
      throw new Error(
        `moduleEdgeTargets names '${findingId}', but its source '${finding.file}' is outside this module boundary.`,
      );
    }
  }

  // A relevant framework file may own a stylesheet, asset, or import.meta.url
  // resource. Include that runtime resource, but never traverse every JSON
  // import in shared i18n configuration; namespace mapping above selects the
  // exact resource instead.
  for (const frameworkPath of frameworkSet) {
    for (const edge of edgesFrom.get(frameworkPath) ?? []) {
      const targetKind = kindOf(edge.to);
      const frameworkResource =
        edge.kind === "MODULE_RESOURCE" ||
        targetKind === "STYLE" ||
        targetKind === "ASSET";
      if (!frameworkResource) continue;
      relevantEdgeKeys.add(edgeKey(edge));
      if (!censusSet.has(edge.to)) supportingSet.add(edge.to);
      addDemand(edge.to);
    }
  }
  processSupportQueue();

  const allRelevantEdges = [...edges, ...syntheticEdges]
    .filter((edge) => relevantEdgeKeys.has(edgeKey(edge)))
    .sort(compareEdges);
  const relevantPaths = currentRelevant();
  const relevantFindings = allFindings
    .filter(
      (finding) =>
        relevantPaths.has(finding.file) && !resolvedI18n.has(finding.id),
    )
    .map((finding) => ({
      ...finding,
      ...(resolvedTargets.has(finding.id)
        ? { resolvedTargets: resolvedTargets.get(finding.id) }
        : {}),
    }));
  const relevantUnresolved = unresolved
    .filter((entry) => relevantPaths.has(entry.from))
    .sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.line - right.line ||
        left.spec.localeCompare(right.spec),
    );

  const boundaryOutgoing = new Map();
  for (const edge of allRelevantEdges) {
    if (!boundaryOutgoing.has(edge.from))
      boundaryOutgoing.set(edge.from, new Set());
    boundaryOutgoing.get(edge.from).add(edge.to);
  }
  const reachBoundary = (seeds) => {
    const seen = new Set();
    const queue = [...seeds];
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of boundaryOutgoing.get(current) ?? []) queue.push(next);
    }
    return seen;
  };
  const inboundConsumerSet = new Set(
    [...consumerSet].filter((file) => !frameworkSet.has(file)),
  );
  const currentProduction = reachBoundary([
    ...[...frameworkSet].filter((file) => !TEST_PATTERN.test(file)),
    ...[...declaredPaths].filter((file) => !TEST_PATTERN.test(file)),
  ]);
  const currentInbound = reachBoundary(
    [...inboundConsumerSet].filter((file) => !TEST_PATTERN.test(file)),
  );
  const currentTests = reachBoundary(
    [...relevantPaths].filter((file) => TEST_PATTERN.test(file)),
  );
  const currentReachability = Object.fromEntries(
    census.map((file) => [
      file,
      currentProduction.has(file)
        ? "REACHABLE_FROM_ENTRY"
        : currentInbound.has(file)
          ? "REACHABLE_INBOUND_ONLY"
          : currentTests.has(file)
            ? "REACHABLE_TEST_ONLY"
            : "UNREACHABLE",
    ]),
  );

  const evidenceFor = (edge) => ({
    from: edge.from,
    line: edge.line ?? 0,
    kind: edge.kind,
    spec: edge.spec,
    ...(edge.via ? { via: edge.via, viaLine: edge.viaLine } : {}),
    ...(edge.findingId ? { findingId: edge.findingId } : {}),
  });
  const evidenceTo = (file) =>
    allRelevantEdges
      .filter((edge) => edge.to === file)
      .map(evidenceFor)
      .sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.spec.localeCompare(right.spec),
      );
  const supportingType = (file, evidence) => {
    if (evidence.some((entry) => entry.kind === "I18N_NAMESPACE")) {
      return "I18N_RESOURCE";
    }
    if (
      evidence.some(
        (entry) =>
          entry.kind === "MODULE_RESOURCE" ||
          entry.kind === "MODULE_RESOURCE_NONLITERAL_TARGET",
      )
    ) {
      return "MODULE_RESOURCE";
    }
    const kind = kindOf(file);
    if (["STYLE", "ASSET", "DATA"].includes(kind)) return kind;
    if (evidence.some((entry) => frameworkSet.has(entry.from))) {
      return "FRAMEWORK_RUNTIME_RESOURCE";
    }
    return "MODULE";
  };
  const supporting = [...supportingSet]
    .filter((file) => !censusSet.has(file))
    .sort();
  const requiredBy = Object.fromEntries(
    supporting.map((file) => [
      file,
      [...new Set(evidenceTo(file).map((entry) => entry.from))].sort(),
    ]),
  );
  const relationEvidence = (file) =>
    allRelevantEdges
      .filter(
        (edge) =>
          edge.from === file &&
          (reverseReachable.has(edge.to) || censusSet.has(edge.to)),
      )
      .map((edge) => ({
        to: edge.to,
        line: edge.line ?? 0,
        kind: edge.kind,
        spec: edge.spec,
      }))
      .sort(
        (left, right) =>
          left.to.localeCompare(right.to) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind),
      );
  const governingFramework = [...frameworkSet].sort().map((file) => ({
    relation: "GOVERNING_FRAMEWORK",
    path: file,
    type: i18nConfiguration.has(file)
      ? "I18N_CONFIGURATION"
      : "FRAMEWORK_CONVENTION",
    reason:
      entryPoints.get(file)?.reason ??
      (i18nConfiguration.has(file)
        ? "Maps a used i18n namespace to its runtime resource."
        : "Governs a runtime entry into the module."),
    evidence: [
      ...relationEvidence(file),
      ...syntheticEdges
        .filter((edge) => edge.via === file)
        .map((edge) => ({
          to: edge.to,
          line: edge.viaLine,
          kind: "I18N_RESOURCE_MAPPING",
          spec: edge.spec,
        })),
    ].sort(
      (left, right) =>
        left.to.localeCompare(right.to) ||
        left.line - right.line ||
        left.kind.localeCompare(right.kind),
    ),
  }));
  const inboundConsumers = [...inboundConsumerSet].sort().map((file) => ({
    relation: "INBOUND_CONSUMER",
    path: file,
    evidence: relationEvidence(file),
  }));
  const boundary = {
    owned: census.map((file) => ({
      relation: "OWNED",
      path: file,
      roots: roots.filter((root) => underRoot(file, root)),
      kind: kindOf(file),
      reachability: currentReachability[file],
    })),
    supporting: supporting.map((file) => {
      const evidence = evidenceTo(file);
      return {
        relation: "SUPPORTING",
        type: supportingType(file, evidence),
        path: file,
        requiredBy: requiredBy[file],
        evidence,
      };
    }),
    inboundConsumers,
    governingFramework,
  };

  const currentEntryPoints = [
    ...governingFramework.map((entry) => ({
      path: entry.path,
      discovery:
        entry.type === "FRAMEWORK_CONVENTION" ? "FRAMEWORK" : "GOVERNING",
      reason: entry.reason,
    })),
    ...inboundConsumers.map((entry) => ({
      path: entry.path,
      discovery: declaredPaths.has(entry.path) ? "DECLARED" : "INBOUND",
      reason:
        entryPoints.get(entry.path)?.reason ??
        "References the module directly or transitively.",
    })),
    ...[...declaredPaths]
      .filter(
        (file) => !frameworkSet.has(file) && !inboundConsumerSet.has(file),
      )
      .map((file) => ({
        path: file,
        discovery: "DECLARED",
        reason: entryPoints.get(file)?.reason ?? "Declared by the migration.",
      })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const resolution = {
    typescriptVersion: ts?.version ?? null,
    tsconfigPath,
    tsconfigDigest,
    compilerOptions: {
      baseUrl: compilerOptions.baseUrl
        ? portable(path.relative(legacyRoot, compilerOptions.baseUrl))
        : null,
      paths: compilerOptions.paths ?? null,
      moduleResolution: compilerOptions.moduleResolution ?? null,
      module: compilerOptions.module ?? null,
      jsx: compilerOptions.jsx ?? null,
    },
    extensions: PROBE_EXTENSIONS,
    censusCommand: CENSUS_COMMAND,
  };
  const scan = {
    algorithmVersion,
    moduleRoots: roots,
    declaredEntryPoints: [...declaredPaths].sort(),
    entryPoints: currentEntryPoints,
    resolution,
    census,
    supporting,
    external: [
      ...new Set(
        externalEdges
          .filter((edge) => relevantPaths.has(edge.from))
          .map((edge) => edge.spec),
      ),
    ].sort(),
    edges: allRelevantEdges,
    findings: relevantFindings,
    unresolved: relevantUnresolved,
    runtimeUrls: runtimeUrls
      .filter((entry) => relevantPaths.has(entry.file))
      .sort(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.spec.localeCompare(right.spec),
      ),
    reachability: currentReachability,
    kinds: Object.fromEntries(census.map((file) => [file, kindOf(file)])),
    requiredBy,
    boundary,
  };
  return { ...scan, discoveryDigest: discoveryDigest(scan) };
};

/**
 * Binds every input that could change what a correct classification looks like:
 * roots, entry points and how each was discovered, resolution rules and
 * algorithm version, the tsconfig, the sorted census, the edges, and everything
 * unproven.
 *
 * Deliberately excluded: per-file content hashes (`legacyRevision` and
 * `dirtyManifest` already bind legacy bytes into every confirmation ID and gate
 * `boundTo`) and every authored classification -- an operator decision binds to
 * this digest, so including the rows it approves would make the binding
 * circular.
 */
export const discoveryDigest = (scan) => {
  const canonical = {
    algorithmVersion: scan.algorithmVersion,
    moduleRoots: scan.moduleRoots,
    ...(scan.algorithmVersion >= 2
      ? { declaredEntryPoints: scan.declaredEntryPoints }
      : {}),
    entryPoints: scan.entryPoints,
    resolution: scan.resolution,
    census: scan.census,
    edges: scan.edges,
    findings: scan.findings,
    unresolved: scan.unresolved,
    ...(scan.algorithmVersion >= 2
      ? { boundary: scan.boundary, runtimeUrls: scan.runtimeUrls }
      : {}),
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
};
