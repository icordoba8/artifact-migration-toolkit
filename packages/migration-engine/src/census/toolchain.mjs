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
import { createRequire } from "node:module";
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
  resolveCompilerBinary,
  SCANNER_REQUIREMENT_KEYS,
  STRUCTURAL_SCRIPT_EXTENSIONS,
  TARGET_COMPILER_SPECIFIERS,
  targetCodeFiles,
  TEST_UNDER_SRC,
} from "./artifact.mjs";
import { kindOf, parserResolutionError, runDiscoveryScan, structuralUnits } from "./scan.mjs";

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

// What puts markup on screen without JSX, matched by name wherever the name
// appears -- a call, a reference, an import or destructuring alias
// (`{ createElement as h }`, `const h = React.createElement`) -- so renaming
// cannot hide it. `render` counts too: a server template is still a page.
const RENDERING_NAMES = new Set([
  "createElement", "cloneElement", "createPortal", "createRoot", "hydrateRoot", "render", "jsx", "jsxs", "jsxDEV",
  "innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment", "attachShadow",
  "appendChild", "insertBefore", "replaceChildren", "replaceWith", "customElements",
]);
// Packages whose import is itself the signal: UI runtimes and CSS-in-JS. Vue,
// Preact and Angular also ship nonvisual APIs, so only their rendering names count.
const UI_PACKAGES = new Map([
  ...["react-dom", "react-dom/client", "react-dom/server", "lit", "lit-html", "lit-element", "svelte", "solid-js/web",
    "styled-components", "@emotion/styled", "@emotion/react", "@emotion/css", "@stitches/react", "goober",
    "@linaria/core", "@linaria/react", "@vanilla-extract/css", "react-jss", "styled-jsx"].map((name) => [name, null]),
  ["vue", new Set(["h", "createApp", "createSSRApp", "defineComponent", "createVNode"])],
  ["preact", new Set(["h", "Fragment", "Component", "hydrate"])],
  ["@angular/core", new Set(["Component", "Directive"])],
]);
// Tags whose template is markup or a style: lit `html`, styled-components, emotion.
const RENDERING_TAGS = new Set(["html", "svg", "css", "styled", "keyframes", "createGlobalStyle", "injectGlobal"]);
// Template and component documents are markup whatever they contain.
const MARKUP_EXTENSIONS = new Set([".mdx", ".vue", ".svelte", ".astro", ".html", ".htm", ".hbs", ".handlebars", ".ejs",
  ".pug", ".njk", ".liquid", ".mustache", ".twig", ".marko"]);
const visualKind = (specifier) => ["STYLE", "ASSET"].includes(kindOf(specifier));
const rootName = (parser, node) => {
  while (parser.isPropertyAccessExpression(node) || parser.isCallExpression(node) || parser.isElementAccessExpression(node)) node = node.expression;
  return parser.isIdentifier(node) ? node.text : null;
};

/**
 * What a file does, not what it is named: `VISUAL_UI` when it renders or may
 * render, `VISUAL_DEPENDENCY` when it is a stylesheet or asset -- or a script
 * that only imports one -- and `NON_VISUAL` only when no rendering signal is
 * left. The rule is one-sided on purpose: an uncertain file (a UI package
 * import, a `render` call, a `css` template) is `VISUAL_UI`, so doubt asks for
 * visual evidence and can never skip it. A `.tsx` holding only a hook is
 * nonvisual; the compiler picks the dialect from the file name, so JSX is
 * parsed wherever that file may legally hold it.
 * ponytail: syntax only. A renderer reached through a value the parser cannot
 * name (`obj[key]()`, a re-exporting local barrel) is not seen; add the rule
 * here when a real artifact needs it.
 */
export const classifyVisualFile = (parser, file, text) => {
  const kind = kindOf(file);
  const extension = path.extname(file).toLowerCase();
  if (kind === "STYLE" || kind === "ASSET") return { classification: "VISUAL_DEPENDENCY", reason: kind.toLowerCase() };
  if (MARKUP_EXTENSIONS.has(extension)) return { classification: "VISUAL_UI", reason: "markup document" };
  if (!STRUCTURAL_SCRIPT_EXTENSIONS.has(extension)) return { classification: "NON_VISUAL", reason: kind.toLowerCase() };
  const sourceFile = parser.createSourceFile(file, text, parser.ScriptTarget.Latest, true);
  let renders = null;
  let styled = false;
  const loaded = (specifier, names) => {
    if (!parser.isStringLiteralLike(specifier ?? {})) return;
    if (visualKind(specifier.text)) styled = true;
    if (!UI_PACKAGES.has(specifier.text)) return;
    // `names` is null for a bare or dynamic load: everything the package runs.
    const rendering = UI_PACKAGES.get(specifier.text);
    const hit = names === null ? (rendering ? null : "*") : names.find((name) => !rendering || rendering.has(name));
    if (hit) renders = `imports ${hit === "*" ? "" : `${hit} from `}'${specifier.text}'`;
  };
  const visit = (node) => {
    if (renders) return;
    if (parser.isJsxElement(node) || parser.isJsxSelfClosingElement(node) || parser.isJsxFragment(node)) {
      renders = "JSX element";
    } else if (parser.isIdentifier(node) && RENDERING_NAMES.has(node.text)) {
      renders = `${node.text} reference`;
    } else if (parser.isElementAccessExpression(node) && parser.isStringLiteralLike(node.argumentExpression) &&
        RENDERING_NAMES.has(node.argumentExpression.text)) {
      renders = `${node.argumentExpression.text} reference`;
    } else if (parser.isPropertyAccessExpression(node) && rootName(parser, node.expression) === "document" &&
        ["write", "writeln"].includes(node.name.text)) {
      renders = `document.${node.name.text} reference`;
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
      loaded(node.moduleSpecifier, names);
    } else if (parser.isCallExpression(node) &&
        (node.expression.kind === parser.SyntaxKind.ImportKeyword || rootName(parser, node.expression) === "require")) {
      loaded(node.arguments[0], null);
    }
    parser.forEachChild(node, visit);
  };
  parser.forEachChild(sourceFile, visit);
  if (renders) return { classification: "VISUAL_UI", reason: renders };
  return styled
    ? { classification: "VISUAL_DEPENDENCY", reason: "imports a stylesheet or asset" }
    : { classification: "NON_VISUAL", reason: "renders nothing" };
};

const VISUAL_RANK = ["NON_VISUAL", "VISUAL_DEPENDENCY", "VISUAL_UI"];

/**
 * The artifact's visual applicability, derived from the bound source files'
 * own bytes: the strongest classification of any of them. The gate reads it at
 * DISCOVER_LEGACY, before any slice can rewrite a same-root file in place.
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
  const rank = Math.max(0, ...files.map((file) => VISUAL_RANK.indexOf(file.classification)));
  return { classification: VISUAL_RANK[rank], files };
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
