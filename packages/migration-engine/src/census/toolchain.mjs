/**
 * Census: the artifact engine's parser-bound structural census (Track A8).
 *
 * The TypeScript loader, the target compiler and project resolution, the
 * legacy-dependency and architecture findings, and the structural source
 * requirements. They were the last census rules inside
 * `artifact/artifact-migration.mjs`; that file is now a lifecycle facade, so
 * they moved here verbatim. `engineFault`/`asEngineFault` came along: the
 * toolchain is what raises them, and the lifecycle reads them from here.
 */
import { lstat, readFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

import {
  assertNonEmpty,
  isLexicallyWithin as isWithin,
  normalizeRelative,
  portablePath as portable,
  sameMembers,
  samePath,
} from "../shared/index.mjs";
import { fileExists as exists } from "../store/index.mjs";
import {
  CODE_FILE_EXTENSIONS,
  FEATURE_INDEX,
  hardcodedUiText,
  metrics,
  moduleSpecifiersIn,
  packageNameOf,
  resolveCompilerBinary,
  SCANNER_REQUIREMENT_KEYS,
  STRUCTURAL_SCRIPT_EXTENSIONS,
  TARGET_COMPILER_SPECIFIERS,
  targetCodeFiles,
  TEST_UNDER_SRC,
} from "./artifact.mjs";
import { kindOf, loadTypeScript, parserResolutionError, PRODUCTION_REACHABILITY, runDiscoveryScan, structuralUnits } from "./scan.mjs";

// The parser still resolves from the artifact engine's installed location,
// `src/artifact/artifact-migration.mjs`, and its refusal names that file,
// exactly as before this code moved into census/.
const ENGINE_URL = new URL("../artifact/artifact-migration.mjs", import.meta.url).href;

// Structural census parsing needs a TypeScript syntax parser, not module
// resolution, so any resolvable compiler works; load the one nearest this
// engine rather than the (possibly dependency-less) legacy project.
const loadStructuralParser = () => {
  try {
    return createRequire(ENGINE_URL)("ts-discovery-compiler");
  } catch (error) {
    throw parserResolutionError(error, ENGINE_URL, "migrate-artifact");
  }
};

export const targetTypeScript = (targetRoot) => {
  const compiler = loadStructuralParser();
  const fromTarget = createRequire(path.join(targetRoot, "package.json"));
  for (const specifier of TARGET_COMPILER_SPECIFIERS) {
    const resolved = resolveCompilerBinary(fromTarget, specifier);
    if (resolved) {
      return { compiler, bin: resolved.bin, identity: { ...resolved, origin: "TARGET" } };
    }
  }
  // The target declares no resolvable TypeScript at all. Falling back keeps the
  // check running, but the substitution is recorded in the evidence so a
  // reviewer can see the verdict came from a compiler the project does not use.
  const pinned = resolveCompilerBinary(
    createRequire(ENGINE_URL),
    "ts-discovery-compiler",
  );
  if (!pinned) {
    throw parserResolutionError(
      new Error("its package manifest declares no tsc binary"),
      ENGINE_URL,
      "migrate-artifact",
    );
  }
  return {
    compiler,
    bin: pinned.bin,
    identity: { ...pinned, origin: "PINNED_FALLBACK" },
  };
};

// ponytail: an engine fault is a crash in the toolchain this engine drives -- a
// corrupt tsconfig, an unloadable compiler, a scanner blow-up. It is never "the
// next artifact has not been authored yet", so it must never be reported as
// CONTINUE: an automated driver would loop on it forever.
export const engineFault = (message, cause) =>
  Object.assign(new Error(`${message}: ${cause?.message ?? cause}`), {
    engineFault: true,
  });

export const asEngineFault = async (message, run) => {
  try {
    return await run();
  } catch (error) {
    throw error?.engineFault ? error : engineFault(message, error);
  }
};

export const structuralParser = () =>
  asEngineFault("Cannot load a TypeScript parser for the structural census", () =>
    loadStructuralParser(),
  );

// The target's compiler options, used to resolve specifiers the way the target
// itself resolves them. A target with no tsconfig is a plain JS project, not a
// fault; a tsconfig that cannot be read or parsed is a fault.
const targetProject = async (targetRoot) => {
  const { compiler } = targetTypeScript(targetRoot);
  const projectFile = path.join(targetRoot, "tsconfig.json");
  const base = { allowJs: true, resolveJsonModule: true };
  if (!(await exists(projectFile))) return { compiler, options: base };
  return asEngineFault(`Cannot load the target TypeScript project '${projectFile}'`, () => {
    const loaded = compiler.readConfigFile(projectFile, compiler.sys.readFile);
    if (loaded.error) throw new Error("the compiler refused to read it");
    const parsed = compiler.parseJsonConfigFileContent(
      loaded.config,
      compiler.sys,
      targetRoot,
      undefined,
      projectFile,
    );
    if (parsed.errors.length > 0) throw new Error("the compiler refused to parse it");
    return { compiler, options: { ...parsed.options, ...base } };
  });
};

/**
 * Target code that still resolves into the legacy tree, from anywhere under the
 * target root -- not only `src/shared`, and not only through static imports.
 *
 * Legacy scope depends on the invocation, and both forms are real. With
 * distinct roots the whole source root is legacy. With one root -- the SKILL's
 * documented default, where the previous implementation returned nothing at all
 * -- "legacy" is exactly this artifact's bound source paths. Requirements
 * outside that frozen set are shared dependencies, not migrated legacy files.
 */
export const legacyDependencies = async (
  targetRoot,
  sourceRoot,
  legacyPaths = [],
  { changedFiles = [] } = {},
) => {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const inPlace = samePath(resolvedTargetRoot, resolvedSourceRoot);
  const legacyRoots = [...new Set(legacyPaths)].map((value) =>
    path.resolve(resolvedSourceRoot, normalizeRelative(value, "legacy path")),
  );
  const isLegacy = (absolute) =>
    inPlace
      ? legacyRoots.some((root) => isWithin(root, absolute))
      : isWithin(resolvedSourceRoot, absolute);

  const { compiler, options } = await targetProject(resolvedTargetRoot);
  const parsed = new Map();
  const edgesOf = async (file) => {
    const key = pathKey(file);
    const cached = parsed.get(key);
    if (cached) return cached;
    const relative = portable(path.relative(resolvedTargetRoot, file));
    const value = await asEngineFault(`Cannot analyse target module '${relative}'`, async () => {
      const { specifiers, undecidable } = moduleSpecifiersIn(
        compiler,
        file,
        await readFile(file, "utf8"),
      );
      const edges = specifiers
        .map((specifier) => {
          const resolvedModule = compiler.resolveModuleName(
            specifier,
            file,
            options,
            compiler.sys,
          ).resolvedModule;
          return {
            specifier,
            resolved: resolvedModule?.resolvedFileName
              ? path.resolve(resolvedModule.resolvedFileName)
              : null,
            external: resolvedModule?.isExternalLibraryImport ?? false,
          };
        })
        .filter((edge) => edge.resolved);
      return { edges, undecidable };
    });
    parsed.set(key, value);
    return value;
  };

  const changed = new Set(
    changedFiles.map((file) => pathKey(path.resolve(resolvedTargetRoot, file))),
  );
  const findings = new Map();
  const undecidable = new Map();
  for (const rootFile of await targetCodeFiles(resolvedTargetRoot)) {
    if (isLegacy(rootFile)) continue;
    const rootRelative = portable(path.relative(resolvedTargetRoot, rootFile));
    const visit = async (file, chain, seen) => {
      const analysis = await edgesOf(file);
      const fileRelative = portable(path.relative(resolvedTargetRoot, file));
      // An undecidable reference is adjudicated only for the files this
      // migration actually changed; the rest of the target is not its business.
      if (changed.has(pathKey(file))) {
        for (const expression of analysis.undecidable) {
          undecidable.set(`${fileRelative}\u0000${expression}`, {
            file: fileRelative,
            expression,
          });
        }
      }
      for (const edge of analysis.edges) {
        const legacy = isLegacy(edge.resolved);
        const nextChain = [
          ...chain,
          {
            file: fileRelative,
            specifier: edge.specifier,
            resolved: portable(
              path.relative(legacy ? resolvedSourceRoot : resolvedTargetRoot, edge.resolved),
            ),
          },
        ];
        if (legacy) {
          const finding = {
            file: rootRelative,
            legacyPath: portable(path.relative(resolvedSourceRoot, edge.resolved)),
            chain: nextChain,
          };
          findings.set(`${finding.file}\u0000${finding.legacyPath}`, finding);
        } else if (
          !edge.external &&
          isWithin(resolvedTargetRoot, edge.resolved) &&
          CODE_FILE_EXTENSIONS.has(path.extname(edge.resolved).toLowerCase()) &&
          !seen.has(pathKey(edge.resolved))
        ) {
          await visit(edge.resolved, nextChain, new Set([...seen, pathKey(edge.resolved)]));
        }
      }
    };
    await visit(rootFile, [], new Set([pathKey(rootFile)]));
  }
  const byFile = (left, right) =>
    left.file.localeCompare(right.file) ||
    (left.legacyPath ?? left.expression).localeCompare(right.legacyPath ?? right.expression);
  return {
    findings: [...findings.values()].sort(byFile),
    undecidable: [...undecidable.values()].sort(byFile),
  };
};

const FEATURE_FILE = /^src\/features\/([^/]+)\//;

const QUERY_KEYS_FILE = /\.query-keys\.ts$/;

export const architectureFindings = async (targetRoot, changedFiles) => {
  const implementation = [];
  const precommit = [];
  const changed = [...changedFiles].sort();

  // MR-2: a touched feature carries the mandated hexagonal layers.
  const features = new Set();
  for (const file of changed) {
    const match = FEATURE_FILE.exec(file);
    if (match) features.add(match[1]);
  }
  for (const feature of [...features].sort()) {
    for (const layer of ["domain", "application"]) {
      const directory = path.join(targetRoot, "src/features", feature, layer);
      const present = await lstat(directory).then(
        (details) => details.isDirectory(),
        () => false,
      );
      if (!present) {
        implementation.push(
          `feature '${feature}' has no src/features/${feature}/${layer}/ layer (MR-2).`,
        );
      }
    }
  }

  for (const file of changed) {
    // MR-4: a feature's query keys live at exactly one canonical path.
    if (QUERY_KEYS_FILE.test(file)) {
      const feature = FEATURE_FILE.exec(file)?.[1] ?? null;
      const expected = feature
        ? `src/features/${feature}/infrastructure/${feature}.query-keys.ts`
        : null;
      if (file !== expected) {
        implementation.push(
          `'${file}' is not the canonical feature query-key path${expected ? ` '${expected}'` : ""} (MR-4).`,
        );
      }
    }
    // MR-6: frontend tests never live under src/.
    if (TEST_UNDER_SRC.test(file)) {
      precommit.push(`'${file}' co-locates a test under src/ (MR-6).`);
    }
  }

  const codeChanged = changed.filter((file) =>
    CODE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  if (codeChanged.length === 0) return { implementation, precommit };
  const { compiler, options } = await targetProject(targetRoot);
  for (const file of codeChanged) {
    const absolute = path.resolve(targetRoot, file);
    const text = await readFile(absolute, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text === null) continue;
    const owner = FEATURE_FILE.exec(file)?.[1] ?? null;
    const { specifiers } = await asEngineFault(
      `Cannot analyse changed file '${file}'`,
      async () => moduleSpecifiersIn(compiler, absolute, text),
    );
    // MR-7: a feature's public surface is its index; no deep cross-slice import.
    for (const specifier of specifiers) {
      const resolvedModule = compiler.resolveModuleName(
        specifier,
        absolute,
        options,
        compiler.sys,
      ).resolvedModule;
      if (!resolvedModule || resolvedModule.isExternalLibraryImport) continue;
      const resolved = portable(
        path.relative(targetRoot, path.resolve(resolvedModule.resolvedFileName)),
      );
      const imported = FEATURE_FILE.exec(resolved)?.[1] ?? null;
      if (!imported || imported === owner || FEATURE_INDEX.test(resolved)) continue;
      implementation.push(
        `'${file}' imports '${specifier}' deep into feature '${imported}' ('${resolved}'); consume its index (MR-7).`,
      );
    }
    // MR-3: no hardcoded visible text in a changed component.
    if (path.extname(file).toLowerCase() === ".tsx") {
      for (const literal of hardcodedUiText(compiler, absolute, text)) {
        precommit.push(
          `'${file}' hardcodes visible UI text ${JSON.stringify(literal)}; it belongs in an i18n namespace (MR-3).`,
        );
      }
    }
  }
  return { implementation, precommit };
};

export const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;

/**
 * The source requirement graph: every element the bound artifact requires from
 * outside its own boundary, plus every reference the scanner could not decide.
 *
 * This is the reference discovery engine (`runDiscoveryScan`), scoped to the
 * artifact's own path. The census defines the artifact; the resolved import
 * graph is what makes an element it reaches *into* -- a shared utility, a
 * stylesheet, an i18n namespace -- visible instead of silently absent.
 */
export const sourceRequirements = (state) =>
  asEngineFault("Cannot scan the source requirement graph", async () => {
    metrics.discoveryScans += 1;
    const scan = await runDiscoveryScan({
      legacyRoot: state.source.root,
      moduleRoots: state.bindings.source.paths,
      typescript: await structuralParser(),
      // The artifact graph reads no API response contract, so it stays on the
      // algorithm it has always run instead of following the module default.
      algorithmVersion: 4,
    });
    for (const key of SCANNER_REQUIREMENT_KEYS) {
      if (!Array.isArray(scan[key])) {
        throw new Error(`the discovery scan no longer exposes '${key}'`);
      }
    }
    return {
      census: scan.census,
      elements: [
        ...scan.supporting,
        ...scan.external.map((spec) => `EXTERNAL ${spec}`),
        ...scan.unresolved.map((row) => `UNRESOLVED ${row.from}:${row.line ?? 0} ${row.spec}`),
        ...scan.findings.map((row) => `${row.type} ${row.file}:${row.line} ${row.spec}`),
        ...scan.runtimeUrls.map((row) => `RUNTIME_URL ${row.file}:${row.line} ${row.spec}`),
      ].sort(),
    };
  });

// Modules whose import is the rendering signal. `null`: every export renders
// (UI runtimes, DOM/canvas libraries, CSS-in-JS). A Set: the package also ships
// nonvisual APIs, so only these exports count -- imported by name, destructured,
// or read off its default/namespace binding (`React.createElement`, `d3.select`).
// Provenance, not spelling: `Mustache.render` or `solid-js`'s `createRoot` is not
// a renderer because no module here exported it.
const RENDERERS = new Map([
  ...["react-dom", "react-dom/client", "react-dom/server", "react/jsx-runtime", "react/jsx-dev-runtime",
    "preact/jsx-runtime", "vue/jsx-runtime", "lit", "lit-html", "lit-element", "svelte", "solid-js/web",
    "mithril",
    "styled-components", "@emotion/styled", "@emotion/react", "@emotion/css", "@stitches/react", "goober",
    "@linaria/core", "@linaria/react", "@vanilla-extract/css", "react-jss", "styled-jsx"].map((name) => [name, null]),
  ["react", new Set(["createElement", "cloneElement", "createFactory"])],
  ["vue", new Set(["h", "render", "createApp", "createSSRApp", "defineComponent", "createVNode"])],
  ["preact", new Set(["h", "createElement", "cloneElement", "render", "hydrate", "Fragment", "Component"])],
  ["@angular/core", new Set(["Component", "Directive"])],
  ["snabbdom", new Set(["init", "h", "jsx", "toVNode"])],
  ["d3", new Set(["select", "selectAll", "create"])],
  ["d3-selection", new Set(["select", "selectAll", "create"])],
  ["three", new Set(["WebGLRenderer", "WebGL1Renderer", "WebGPURenderer"])],
]);
// A subpath of a package listed by export name (`three/webgpu`) carries the same
// names; a subpath of an all-rendering package (`chart.js/helpers`) counts only
// when it is listed itself.
const rendererOf = (specifier) => {
  if (typeof specifier !== "string") return undefined;
  if (RENDERERS.has(specifier)) return RENDERERS.get(specifier);
  const named = RENDERERS.get(packageNameOf(specifier));
  return named instanceof Set ? named : undefined;
};
// DOM and canvas libraries that are also utility belts: calling or constructing
// the binding (`$("#x")`, `new Chart(el)`) renders; any other use (`$.ajax`,
// `Chart.register`) is doubt; importing one renders nothing by itself.
const CALLED_RENDERERS = new Set(["jquery", "chart.js", "chart.js/auto"]);
// Script-tag globals of these modules, read only where the file never declares the name.
const GLOBAL_RENDERERS = new Map([["$", "jquery"], ["jQuery", "jquery"], ["d3", "d3"], ["Chart", "chart.js"],
  ["THREE", "three"], ["React", "react"], ["ReactDOM", "react-dom"], ["Vue", "vue"]]);
// Values from these never reach a screen: string templating, an XML DOM, Node built-ins.
// shortcut: a short list; any other nonvisual package leaves DOM-shaped names on its
// values INCONCLUSIVE -- add it here when a real artifact needs it.
const NONVISUAL_MODULES = new Set(["mustache", "handlebars", "@xmldom/xmldom", "xmldom", "jsdom"]);
const nonvisualModule = (specifier) =>
  typeof specifier === "string" && (NONVISUAL_MODULES.has(packageNameOf(specifier)) || isBuiltin(specifier));
// DOM-shaped operations an XML node, a template engine or any object may also
// have. On a receiver of unknown provenance they are doubt, never proof either way.
const AMBIGUOUS_CALLS = new Set(["appendChild", "insertBefore", "replaceChild", "replaceChildren", "removeChild",
  "insertAdjacentElement", "insertAdjacentText", "createElement", "createElementNS", "createTextNode",
  "setAttribute", "setAttributeNS", "setProperty", "render", "hydrate", "mount"]);
const AMBIGUOUS_WRITES = new Set(["textContent", "nodeValue", "className", "style"]);
// `parseFromString(text, "text/xml")`, `document.implementation.createDocument(...)`: a document no screen shows.
const XML_MIME = /(^|[/+])xml$/;
// Members only an HTML element or the browser has, whatever the receiver.
const DOM_ONLY_NAMES = new Set(["innerHTML", "outerHTML", "innerText", "insertAdjacentHTML", "createContextualFragment",
  "attachShadow", "customElements", "classList"]);
// The browser's own `document` (never a local of that name) putting markup on screen.
const DOCUMENT_UI = new Set(["write", "writeln", "body", "head", "documentElement", "createElement", "createElementNS",
  "createTextNode", "createDocumentFragment", "getElementById", "getElementsByClassName", "getElementsByTagName",
  "getElementsByName", "querySelector", "querySelectorAll", "adoptedStyleSheets"]);
const CANVAS_CONTEXTS = new Set(["2d", "webgl", "webgl2", "experimental-webgl", "bitmaprenderer", "webgpu"]);
const DOM_CONSTRUCTOR = /^(HTML|SVG)\w*Element$/;
// Tags whose template is markup or a style: lit `html`, styled-components, emotion.
const RENDERING_TAGS = new Set(["html", "svg", "css", "styled", "keyframes", "createGlobalStyle", "injectGlobal"]);
// Template and component documents are markup whatever they contain.
const MARKUP_EXTENSIONS = new Set([".mdx", ".vue", ".svelte", ".astro", ".html", ".htm", ".hbs", ".handlebars", ".ejs",
  ".pug", ".njk", ".liquid", ".mustache", ".twig", ".marko"]);
const visualKind = (specifier) => ["STYLE", "ASSET"].includes(kindOf(specifier));
const rootName = (parser, node) => {
  while (parser.isPropertyAccessExpression(node) || parser.isCallExpression(node) || parser.isElementAccessExpression(node) ||
      parser.isNewExpression(node) || parser.isParenthesizedExpression(node) || parser.isAsExpression(node) ||
      parser.isNonNullExpression(node)) node = node.expression;
  return parser.isIdentifier(node) ? node.text : null;
};
// `x.style.color = v`, `x.textContent += v`: the member is assigned, directly or through a deeper member.
const written = (parser, node) => {
  while ((parser.isPropertyAccessExpression(node.parent) || parser.isElementAccessExpression(node.parent)) &&
    node.parent.expression === node) node = node.parent;
  const { parent } = node;
  return parser.isBinaryExpression(parent) && parent.left === node &&
    parent.operatorToken.kind >= parser.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= parser.SyntaxKind.LastAssignment;
};
const xmlDocument = (parser, node) => parser.isCallExpression(node) && parser.isPropertyAccessExpression(node.expression) &&
  ((node.expression.name.text === "createDocument" && parser.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === "implementation") || (node.expression.name.text === "parseFromString" &&
    parser.isStringLiteralLike(node.arguments[1] ?? {}) && XML_MIME.test(node.arguments[1].text)));
// Erased at compile time: types, ambient declarations, type-only imports, `export {}`.
const typeOnly = (parser, statement) =>
  parser.isInterfaceDeclaration(statement) || parser.isTypeAliasDeclaration(statement) ||
  (statement.modifiers ?? []).some((modifier) => modifier.kind === parser.SyntaxKind.DeclareKeyword) ||
  ((parser.isImportDeclaration(statement) || parser.isExportDeclaration(statement)) &&
    (statement.isTypeOnly || statement.importClause?.isTypeOnly === true)) ||
  (parser.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause?.elements?.length === 0);

/**
 * What a file does, not what it is named, as one of three applicability states:
 * - `CONFIRMED_VISUAL`: positive evidence that it renders (`VISUAL_UI`).
 * - `CONFIRMED_NONVISUAL`: it owes no visible-UI evidence of its own -- a
 *   stylesheet or asset, or a script that only loads one (`VISUAL_DEPENDENCY`,
 *   verified by its consumers), data, docs, types, or a script with no
 *   rendering signal and nothing in doubt.
 * - `INCONCLUSIVE`: the bytes cannot decide -- a DOM-shaped operation on a
 *   receiver of unknown provenance (`el.appendChild`, `view.render(data)`,
 *   `node.textContent = v`), or a kind the engine cannot read (`.php`).
 * Every verdict needs provenance. Rendering: JSX, a rendering export of a module
 * in RENDERERS (imported, or its script-tag global), the browser's `document`, a
 * DOM-only member, a canvas context, a DOM element class extended or built, a
 * markup/style tagged template. Clearing doubt -- and a DOM-only member -- needs
 * the same provenance: a receiver derived from an XML document or from a
 * NONVISUAL_MODULES value (`Mustache.render`, a jsdom document).
 * `conclusive` is narrower: proven by kind or signal (markup, a stylesheet, data,
 * types, a rendering signal). Only files that are all conclusive and render
 * nothing may refuse an honest `hasVisibleUi: true`.
 * shortcut: syntax only -- no type checker, names not scopes; a renderer reached
 * with no DOM-shaped name (`new Widget(container)` from an unlisted package) or
 * through a local re-export reads CONFIRMED_NONVISUAL -- add the rule here when a
 * real artifact needs it.
 */
export const classifyVisualFile = (parser, file, text) => {
  const kind = kindOf(file);
  const extension = path.extname(file).toLowerCase();
  const verdict = (classification, reason, applicability, conclusive) => ({ classification, reason, conclusive, applicability });
  if (kind === "STYLE" || kind === "ASSET") return verdict("VISUAL_DEPENDENCY", kind.toLowerCase(), "CONFIRMED_NONVISUAL", true);
  if (MARKUP_EXTENSIONS.has(extension)) return verdict("VISUAL_UI", "markup document", "CONFIRMED_VISUAL", true);
  // Only data and docs are proven inert; an unknown kind (`.php`, `.erb`) may be a page.
  if (!STRUCTURAL_SCRIPT_EXTENSIONS.has(extension)) {
    const inert = kind === "DATA" || kind === "DOC";
    return verdict("NON_VISUAL", kind.toLowerCase(), inert ? "CONFIRMED_NONVISUAL" : "INCONCLUSIVE", inert);
  }
  const sourceFile = parser.createSourceFile(file, text, parser.ScriptTarget.Latest, true);
  const declared = new Set();
  // `bound`: default/namespace/require bindings, whose members are the module's exports.
  // `imported`: every value binding to a module. `origin`: a local's one initializer.
  const bound = new Map();
  const imported = new Map();
  const origin = new Map();
  const opaque = new Set();
  const requireOf = (node) => node && parser.isCallExpression(node) && parser.isIdentifier(node.expression) &&
    node.expression.text === "require" && parser.isStringLiteralLike(node.arguments[0] ?? {}) ? node.arguments[0].text : null;
  // Pass 1: local names, module bindings, and where each local's value came from.
  const collect = (node) => {
    if ((parser.isVariableDeclaration(node) || parser.isParameter(node) || parser.isBindingElement(node) ||
        parser.isFunctionDeclaration(node) || parser.isClassLike(node) || parser.isImportClause(node) ||
        parser.isImportSpecifier(node) || parser.isNamespaceImport(node)) && node.name && parser.isIdentifier(node.name)) {
      declared.add(node.name.text);
      // A name declared twice, or by anything but one initialized variable, has no single provenance.
      if (!parser.isVariableDeclaration(node) || !node.initializer || origin.has(node.name.text)) opaque.add(node.name.text);
      else origin.set(node.name.text, node.initializer);
    }
    if (parser.isImportDeclaration(node) && parser.isStringLiteralLike(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      const from = node.moduleSpecifier.text;
      if (clause?.name) bound.set(clause.name.text, from);
      if (clause?.namedBindings && parser.isNamespaceImport(clause.namedBindings)) bound.set(clause.namedBindings.name.text, from);
      for (const element of clause?.namedBindings?.elements ?? []) imported.set(element.name.text, from);
    } else if (parser.isVariableDeclaration(node) && parser.isIdentifier(node.name) && requireOf(node.initializer)) {
      bound.set(node.name.text, requireOf(node.initializer));
    }
    parser.forEachChild(node, collect);
  };
  parser.forEachChild(sourceFile, collect);
  for (const [name, from] of bound) imported.set(name, from);
  const global = (node, names) => parser.isIdentifier(node) && names.includes(node.text) && !declared.has(node.text);
  // A receiver holds no DOM when its root came from a nonvisual module or an XML document.
  const resolved = (name, seen = new Set()) => {
    if (name === null || seen.has(name)) return false;
    seen.add(name);
    if (nonvisualModule(imported.get(name))) return true;
    const value = !opaque.has(name) && origin.get(name);
    return Boolean(value) && (xmlDocument(parser, value) || resolved(rootName(parser, value), seen));
  };
  const doubtOf = (node) => {
    if (parser.isCallExpression(node) && parser.isPropertyAccessExpression(node.expression) &&
        AMBIGUOUS_CALLS.has(node.expression.name.text) && !resolved(rootName(parser, node.expression.expression))) {
      return `${node.expression.name.text}() on a receiver of unknown provenance`;
    }
    if (parser.isPropertyAccessExpression(node) && AMBIGUOUS_WRITES.has(node.name.text) && written(parser, node) &&
        !resolved(rootName(parser, node.expression))) {
      return `${node.name.text} written on a receiver of unknown provenance`;
    }
    if (parser.isCallExpression(node) && parser.isIdentifier(node.expression) && AMBIGUOUS_CALLS.has(node.expression.text) &&
        imported.has(node.expression.text) && !nonvisualModule(imported.get(node.expression.text))) {
      return `${node.expression.text}() imported from '${imported.get(node.expression.text)}'`;
    }
    return null;
  };
  let renders = null;
  let doubt = null;
  let styled = false;
  const loaded = (specifier, names) => {
    if (typeof specifier !== "string") return;
    if (visualKind(specifier)) styled = true;
    const rendering = rendererOf(specifier);
    if (rendering === undefined) return;
    // `names` is null for a bare or dynamic load: everything the package runs.
    const hit = names === null ? (rendering ? null : "*") : names.find((name) => !rendering || rendering.has(name));
    if (hit) renders = `imports ${hit === "*" ? "" : `${hit} from `}'${specifier}'`;
  };
  const visit = (node) => {
    if (renders) return;
    // Types are erased; only a class's `extends` clause survives as a value.
    if (parser.isInterfaceDeclaration(node) || parser.isTypeAliasDeclaration(node) ||
        (parser.isTypeNode(node) && !(parser.isExpressionWithTypeArguments(node) && parser.isClassLike(node.parent.parent)))) return;
    if (parser.isJsxElement(node) || parser.isJsxSelfClosingElement(node) || parser.isJsxFragment(node)) {
      renders = "JSX element";
    } else if (parser.isIdentifier(node) && DOM_ONLY_NAMES.has(node.text) && parser.isPropertyAccessExpression(node.parent) &&
        !resolved(rootName(parser, node.parent.expression))) {
      renders = `${node.text} reference`;
    } else if (parser.isIdentifier(node) && DOM_CONSTRUCTOR.test(node.text) && !declared.has(node.text)) {
      // `extends HTMLElement` or `new HTMLImageElement()` defines or builds DOM; `instanceof` only asks.
      if (parser.isExpressionWithTypeArguments(node.parent) || (parser.isNewExpression(node.parent) && node.parent.expression === node)) {
        renders = `${node.text} reference`;
      } else {
        doubt ??= `${node.text} reference`;
      }
    } else if (parser.isIdentifier(node) && (parser.isCallExpression(node.parent) || parser.isNewExpression(node.parent) ||
        parser.isPropertyAccessExpression(node.parent)) && node.parent.expression === node &&
        (declared.has(node.text) ? CALLED_RENDERERS.has(imported.get(node.text)) : GLOBAL_RENDERERS.has(node.text))) {
      // A binding to a library above, imported or global: an all-rendering one used
      // at all, a utility belt called, or a rendering member (`d3.select`).
      const from = declared.has(node.text) ? imported.get(node.text) : GLOBAL_RENDERERS.get(node.text);
      const member = parser.isPropertyAccessExpression(node.parent) ? node.parent.name.text : null;
      const rendering = RENDERERS.get(from);
      if (rendering === null || (member === null ? CALLED_RENDERERS.has(from) : rendering?.has(member))) {
        renders = `${node.text}${member === null ? "" : `.${member}`} ${declared.has(node.text) ? "from" : "global of"} '${from}'`;
      } else if (CALLED_RENDERERS.has(from)) {
        doubt ??= `${node.text}.${member} of '${from}', a DOM library`;
      }
    } else if (parser.isElementAccessExpression(node) && parser.isStringLiteralLike(node.argumentExpression) &&
        DOM_ONLY_NAMES.has(node.argumentExpression.text) && !resolved(rootName(parser, node.expression))) {
      renders = `${node.argumentExpression.text} reference`;
    } else if (parser.isPropertyAccessExpression(node) && DOCUMENT_UI.has(node.name.text) &&
        (global(node.expression, ["document"]) || (parser.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "document" && global(node.expression.expression, ["window", "globalThis", "self"])))) {
      renders = `document.${node.name.text} reference`;
    } else if (parser.isPropertyAccessExpression(node) && parser.isIdentifier(node.expression) &&
        rendererOf(bound.get(node.expression.text))?.has(node.name.text)) {
      renders = `${node.name.text} reference`;
    } else if (parser.isCallExpression(node) && parser.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "getContext" && parser.isStringLiteralLike(node.arguments[0] ?? {}) &&
        CANVAS_CONTEXTS.has(node.arguments[0].text)) {
      renders = `canvas getContext('${node.arguments[0].text}')`;
    } else if (parser.isTaggedTemplateExpression(node) && RENDERING_TAGS.has(rootName(parser, node.tag))) {
      renders = `${rootName(parser, node.tag)} tagged template`;
    } else if ((parser.isImportDeclaration(node) || parser.isExportDeclaration(node)) &&
        !node.isTypeOnly && !node.importClause?.isTypeOnly) {
      // A type-only import is erased; it cannot render.
      const clause = node.importClause;
      const bindings = clause?.namedBindings ?? node.exportClause;
      const names = !clause && !node.exportClause ? null : [
        ...(clause?.name ? ["default"] : []),
        ...(bindings && !bindings.elements ? ["*"] : []),
        ...(bindings?.elements ?? []).filter((element) => !element.isTypeOnly)
          .map((element) => (element.propertyName ?? element.name).text),
      ];
      loaded(node.moduleSpecifier?.text, names);
    } else if (parser.isVariableDeclaration(node) && parser.isObjectBindingPattern(node.name) && node.initializer) {
      // `const { createElement: h } = React` or `= require("react")`: the names taken.
      const from = requireOf(node.initializer) ?? (parser.isIdentifier(node.initializer) ? bound.get(node.initializer.text) : null);
      loaded(from, node.name.elements.map((element) => (element.propertyName ?? element.name).text));
    } else if (parser.isCallExpression(node) &&
        (node.expression.kind === parser.SyntaxKind.ImportKeyword || rootName(parser, node.expression) === "require")) {
      loaded(parser.isStringLiteralLike(node.arguments[0] ?? {}) ? node.arguments[0].text : null, null);
    }
    doubt ??= doubtOf(node);
    parser.forEachChild(node, visit);
  };
  parser.forEachChild(sourceFile, visit);
  if (renders) return verdict("VISUAL_UI", renders, "CONFIRMED_VISUAL", true);
  if (sourceFile.isDeclarationFile || sourceFile.statements.every((statement) => typeOnly(parser, statement))) {
    return verdict("NON_VISUAL", "type declarations only", "CONFIRMED_NONVISUAL", true);
  }
  // Loading a stylesheet or asset renders nothing itself: its consumers verify it.
  const applicability = doubt ? "INCONCLUSIVE" : "CONFIRMED_NONVISUAL";
  return styled
    ? verdict("VISUAL_DEPENDENCY", doubt ?? "imports a stylesheet or asset", applicability, false)
    : verdict("NON_VISUAL", doubt ?? "no rendering signal recognized", applicability, false);
};

const VISUAL_RANK = ["NON_VISUAL", "VISUAL_DEPENDENCY", "VISUAL_UI"];
const APPLICABILITY_RANK = ["CONFIRMED_NONVISUAL", "INCONCLUSIVE", "CONFIRMED_VISUAL"];

/**
 * The artifact's visual applicability, derived from the bound source files'
 * own bytes: the strongest classification and applicability of any of them,
 * `conclusive` when that verdict is proof (any file renders, or every file is
 * conclusive). Read where `hasVisibleUi` is decided (DISCOVER_LEGACY), held
 * again at ASSESS_TARGET, and reported by `--status`.
 */
export const visualApplicability = async (state) => {
  const parser = await structuralParser();
  const files = [];
  for (const entry of state.bindings.source.entries.filter((item) => item.kind === "FILE")) {
    const script = STRUCTURAL_SCRIPT_EXTENSIONS.has(path.extname(entry.path).toLowerCase());
    const text = script
      ? await asEngineFault(`Cannot read source file '${entry.path}'`, () =>
          readFile(path.join(state.source.root, entry.path), "utf8"))
      : "";
    files.push({ path: entry.path, ...classifyVisualFile(parser, entry.path, text) });
  }
  const strongest = (rank, field) => rank[Math.max(0, ...files.map((file) => rank.indexOf(file[field])))];
  const classification = strongest(VISUAL_RANK, "classification");
  return {
    classification,
    applicability: strongest(APPLICABILITY_RANK, "applicability"),
    conclusive: classification === "VISUAL_UI" || files.every((file) => file.conclusive),
    files,
  };
};

/** The operator decision row that records an INCONCLUSIVE artifact as rendering nothing. */
export const VISUAL_APPLICABILITY_DECISION = "visual-applicability";

/**
 * Why a source inventory's `hasVisibleUi` and visible behaviors cannot stand
 * against what its bound files show, or null. The claim is the agent's; the
 * bytes and the operator are the evidence:
 * - CONFIRMED_VISUAL cannot be declared invisible (that skips every Playwright check);
 * - `hasVisibleUi` must equal whether any behavior is visible, so `true` cannot reach
 *   `{"frames": []}` or zero TARGET captures, and `false` cannot carry visible rows;
 * - INCONCLUSIVE may be declared invisible only through the `visual-applicability`
 *   operator decision -- the agent's word alone never waives visual evidence;
 * - and, only where the claim is made (`deciding`, DISCOVER_LEGACY), files that are
 *   all conclusive and render nothing refuse `true`: no markup is fabricated around a
 *   stylesheet to capture it. ASSESS_TARGET re-reads the pinned inventory with the
 *   bypass rules alone, so a record that closed discovery before them is held to them
 *   while an over-declared stylesheet keeps the evidence it already owes.
 */
export const visualApplicabilityProblem = (applicability, { hasVisibleUi, behaviors }, decisions, deciding) => {
  const files = (state) => applicability.files.filter((file) => file.applicability === state)
    .map((file) => `${file.path}: ${file.reason}`).join("; ");
  if (applicability.applicability === "CONFIRMED_VISUAL" && !hasVisibleUi) {
    return `VISUAL_APPLICABILITY_MISMATCH: this artifact is VISUAL_UI (${files("CONFIRMED_VISUAL")}), so source inventory.hasVisibleUi must be true and its rendered behaviors visible with runtimeStates. Visual, interaction and accessibility evidence is required.`;
  }
  if (deciding && applicability.applicability !== "CONFIRMED_VISUAL" && hasVisibleUi && applicability.conclusive) {
    return `VISUAL_APPLICABILITY_MISMATCH: this artifact is ${applicability.classification}; no bound file renders UI, so source inventory.hasVisibleUi must be false and no behavior visible. ${applicability.classification === "VISUAL_DEPENDENCY" ? "Its visual verification belongs to the UI migrations that consume it; never wrap it in temporary markup to capture it." : "No browser, Playwright or screenshot evidence applies."}`;
  }
  const visible = behaviors.filter((row) => row.visible === true).map((row) => row.id);
  if (hasVisibleUi && visible.length === 0) {
    return `VISUAL_APPLICABILITY_MISMATCH: source inventory.hasVisibleUi is true but no behavior is visible${applicability.applicability === "CONFIRMED_VISUAL" ? ` although this artifact is VISUAL_UI (${files("CONFIRMED_VISUAL")})` : ""}. Mark each rendered behavior visible with its runtimeStates; visual, interaction and accessibility evidence is required.`;
  }
  if (!hasVisibleUi && visible.length > 0) {
    return `VISUAL_APPLICABILITY_MISMATCH: source inventory.hasVisibleUi is false but behavior(s) ${visible.join(", ")} are visible. Declare hasVisibleUi true, or mark them visible: false.`;
  }
  if (applicability.applicability === "INCONCLUSIVE" && !hasVisibleUi &&
      !decisions.some((row) => row.id === VISUAL_APPLICABILITY_DECISION && (deciding || row.satisfied))) {
    return `VISUAL_APPLICABILITY_INCONCLUSIVE: source inventory.hasVisibleUi is false, but the bound source neither proves nor rules out rendering (${files("INCONCLUSIVE")}). An unsupported claim cannot waive visual evidence: declare hasVisibleUi true with its rendered behaviors visible, or add {"id": "${VISUAL_APPLICABILITY_DECISION}", "subject": "<why nothing here reaches a screen, answering each signal above>"} to source inventory.operatorDecisions for the operator to decide.`;
  }
  return null;
};

/**
 * The module side: the production-reachable files of a discovery scan that
 * render, as `path: reason`. Read at DISCOVERY_COMPLETENESS from the fresh scan
 * and at ASSESS_TARGET from the pinned one.
 */
export const renderingModuleFiles = async (scan, legacyRoot) => {
  const parser = loadTypeScript();
  const rendering = [];
  for (const file of scan.census.filter((item) => PRODUCTION_REACHABILITY.has(scan.reachability[item]))) {
    // Only a script's bytes are read; any other kind is classified by name (`.vue`, `.html` are markup).
    const text = ["MODULE", "COMPONENT"].includes(scan.kinds[file])
      ? await readFile(path.join(legacyRoot, file), "utf8") : "";
    const verdict = classifyVisualFile(parser, file, text);
    if (verdict.applicability === "CONFIRMED_VISUAL") rendering.push(`${file}: ${verdict.reason}`);
  }
  return rendering;
};

// The machine structural census over the completeness universe's files. It is
// derived from the source bytes every time it is needed -- at
// DISCOVERY_COMPLETENESS and again at FINALIZE -- so a scanner that has since
// learned to see more (M13: CommonJS exports) cannot be outrun by a
// completeness document authored against the blind one.
export const structuralCensus = async (state, sourceDocument, skip = new Set()) => {
  const parser = await structuralParser();
  const census = new Map();
  const censusFiles = [
    ...sourceDocument.sourceFiles,
    ...sourceDocument.globalContracts.map((contract) => contract.sourcePath),
  ];
  for (const file of [...new Set(censusFiles)].sort().filter((name) => !skip.has(name))) {
    const script = STRUCTURAL_SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase());
    // A censused file that resolves but cannot be read is a resource failure,
    // not "author the next artifact": it must stop the loop, loudly.
    const text = script
      ? await asEngineFault(`Cannot read source file '${file}'`, () =>
          readFile(path.join(state.source.root, file), "utf8"),
        )
      : "";
    metrics.filesParsed += 1;
    const units = await asEngineFault(`Cannot census source file '${file}'`, () =>
      structuralUnits(parser, file, text),
    );
    // A structural unit path is a binding name, unique only within its file, so
    // the census key qualifies it. A whole-file unit keys as the file itself.
    for (const unit of units) {
      census.set(unit.path === file ? file : `${file}#${unit.path}`, unit);
    }
  }
  return census;
};

// Every authored unit must be exactly the census (nothing omitted, renamed or
// invented). A CommonJS unit the census could not resolve must also say how it
// was decided: `resolved: false` there is never satisfied by a bare
// disposition. ESM/TypeScript unresolved units keep their pre-M13 contract so
// existing completeness documents stay valid.
export const assertStructuralCoverage = (units, census, label) => {
  sameMembers(units.map((unit) => unit.path), [...census.keys()], label);
  for (const unit of units) {
    if (census.get(unit.path)?.resolved === false && unit.path.includes("#module.exports")) {
      assertNonEmpty(unit.rationale, `${label} unresolved unit '${unit.path}' rationale`);
    }
  }
};
