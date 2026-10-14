import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
  ARTIFACT_FORMAT_SUPPORTED,
  assertPonytailTarget,
  resolveDesignSource,
} from "../formats/index.mjs";
import {
  assertArray as arrayOf,
  assertBoolean as boolean,
  assertNonEmpty as nonEmpty,
  assertPlainObject as plainObject,
  assertSafeName,
  canonicalJson as canonical,
  dirtyManifest,
  exactObject,
  gitRevision,
  isLexicallyWithin as isWithin,
  normalizeRelative,
  sameMembers,
  samePath,
  sha256Hex as sha256,
  unique,
  versionOne,
} from "../shared/index.mjs";
import { artifactRoot, fileHash, readJsonAt, secureHash } from "../store/index.mjs";
import { UI_RUNTIME_STATES } from "./inventory.mjs";

// The completeness dispositions: the shared UI mismatch vocabulary, the
// capability vocabulary, and the terminal row for an element the artifact
// requires but does not own -- an external package the target must provide.
export const COMPLETENESS_DISPOSITIONS = Object.freeze([
  "MIGRATED_BEHAVIOR",
  "TARGET_NATIVE_EQUIVALENT",
  "FEATURE_LOCAL",
  "NOT_APPLICABLE",
  "EXTERNAL_DEPENDENCY",
  "LEGACY_DEFECT",
  "INTENTIONAL_FIX",
  "INTENTIONAL_DESIGN_ADAPTATION",
  "DO_NOT_MIGRATE",
]);

// A requirement element is either a source-relative path or a reference token.
// Tokens carry a space, so a token can never be mistaken for a path.
export const EXTERNAL_ELEMENT = /^EXTERNAL (.+)$/;

// ponytail: executable code detection for the code-validation gate.
// Only extensions that carry runtime or compile-time semantics need validation.
export const CODE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);

export const hasExecutableCodeFiles = (changedFiles) =>
  changedFiles.some((file) => CODE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()));

export const commandFile = (targetRoot, value, base = targetRoot) => {
  const absolute = path.resolve(base, value);
  const relative = path.relative(targetRoot, absolute).replaceAll("\\", "/");
  return relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
};

// Two jobs, opposite version requirements, so they resolve from different
// places. Job A parses tsconfig with the pinned classic API (a TypeScript 7
// project has none to lend). Job B type-checks the target and must therefore
// run the TARGET's own compiler -- checking a TypeScript 7 project with 5.9.3
// reports diagnostics the project does not have and misses ones it does.
export const TARGET_COMPILER_SPECIFIERS = Object.freeze([
  "typescript",
  "@typescript/native-preview",
]);

// TypeScript 7 blocks `typescript/bin/tsc` behind `exports`, so the binary is
// located through the manifest's own `bin` field instead of by subpath.
export const resolveCompilerBinary = (require, specifier) => {
  let manifestPath;
  try {
    manifestPath = require.resolve(`${specifier}/package.json`);
  } catch {
    return null;
  }
  const manifest = require(`${specifier}/package.json`);
  const declared =
    typeof manifest.bin === "string"
      ? manifest.bin
      : (manifest.bin?.tsc ?? manifest.bin?.tsgo);
  if (typeof declared !== "string" || !declared) return null;
  return {
    specifier,
    version: typeof manifest.version === "string" ? manifest.version : null,
    bin: path.resolve(path.dirname(manifestPath), declared),
  };
};

// ponytail: one process runs one artifact command, so a module-level counter is
// the whole instrumentation -- no tracer, no per-call plumbing. Ceiling: two
// concurrent in-process runs share it; thread it through the call chain if that
// ever happens.
export const metrics = {
  startedAt: 0,
  discoveryScans: 0,
  filesParsed: 0,
  validatorRuns: 0,
  previewAdvanceCalls: 0,
};

// Extensions `structuralUnits` parses. Anything else is censused as a whole
// file, so its bytes never need to be read.
export const STRUCTURAL_SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Every module specifier a file states, from anywhere in its AST: static
// `import`/`export`, `import =`, dynamic `import()`, and `require()`. The old
// top-level-statements-only walk saw none of the last two. A dynamic call whose
// argument is not a literal is undecidable and is returned separately rather
// than dropped.
export const moduleSpecifiersIn = (compiler, file, text) => {
  metrics.filesParsed += 1;
  const sourceFile = compiler.createSourceFile(
    file,
    text,
    compiler.ScriptTarget.Latest,
    true,
  );
  const specifiers = new Set();
  const undecidable = new Set();
  const literalOf = (node) =>
    node && compiler.isStringLiteralLike(node) ? node.text : null;
  const isModuleCall = (node) =>
    compiler.isCallExpression(node) &&
    (node.expression.kind === compiler.SyntaxKind.ImportKeyword ||
      (compiler.isIdentifier(node.expression) && node.expression.text === "require"));
  const visit = (node) => {
    if (compiler.isImportDeclaration(node) || compiler.isExportDeclaration(node)) {
      const specifier = literalOf(node.moduleSpecifier);
      if (specifier) specifiers.add(specifier);
    } else if (
      compiler.isImportEqualsDeclaration(node) &&
      compiler.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = literalOf(node.moduleReference.expression);
      if (specifier) specifiers.add(specifier);
    } else if (isModuleCall(node)) {
      const specifier = literalOf(node.arguments[0]);
      if (specifier) specifiers.add(specifier);
      else undecidable.add(node.getText(sourceFile).replaceAll(/\s+/gu, " ").slice(0, 120));
    }
    compiler.forEachChild(node, visit);
  };
  compiler.forEachChild(sourceFile, visit);
  return { specifiers: [...specifiers].sort(), undecidable: [...undecidable].sort() };
};

// Every code file under the target root, found by walking the tree rather than
// by reading the tsconfig's file list: a file excluded from `include` still
// ships, and still leaks if it imports legacy code.
// ponytail: one walk plus one parse per target code file, at FINALIZE only, and
// one DFS per root file over the memoized parse. If a target grows large enough
// for that to hurt, memoize reachability per file -- do not narrow the walk,
// which is exactly what made this gate blind.
export const targetCodeFiles = async (targetRoot) => {
  const files = [];
  const visit = async (absolute, relative) => {
    if (relative && isExcluded(relative)) return;
    const details = await lstat(absolute).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!details || details.isSymbolicLink()) return;
    if (details.isFile()) {
      if (CODE_FILE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) files.push(absolute);
      return;
    }
    if (!details.isDirectory()) return;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      await visit(
        path.join(absolute, entry.name),
        relative ? `${relative}/${entry.name}` : entry.name,
      );
    }
  };
  await visit(path.resolve(targetRoot), "");
  return files.sort();
};

// The repository's mandatory architecture rules, asserted against the files this
// migration actually changed. A pre-existing unrelated file can neither satisfy
// nor break a gate. Each rule fires only on the path shape it governs, so a
// target that does not use the convention is not judged by it.
export const TEST_UNDER_SRC = /^src\/.*\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|mjs)$/;

export const FEATURE_INDEX = /^src\/features\/[^/]+\/index\.[^/]+$/;

export const UI_TEXT_PROPS = new Set(["label", "title", "placeholder", "aria-label", "alt"]);

// MR-3: every visible string belongs in an i18n namespace. A JSX text node and a
// literal user-facing prop are visible text by construction, so this needs no
// language list -- only a letter.
export const hardcodedUiText = (compiler, file, text) => {
  const sourceFile = compiler.createSourceFile(
    file,
    text,
    compiler.ScriptTarget.Latest,
    true,
    compiler.ScriptKind.TSX,
  );
  const found = new Set();
  const hasLetter = (value) => /\p{L}/u.test(value);
  const visit = (node) => {
    if (compiler.isJsxText(node) && hasLetter(node.text)) {
      found.add(node.text.trim().replaceAll(/\s+/gu, " ").slice(0, 60));
    }
    if (compiler.isJsxAttribute(node)) {
      const name = node.name?.getText(sourceFile) ?? "";
      const value = node.initializer;
      if (
        UI_TEXT_PROPS.has(name) &&
        value &&
        compiler.isStringLiteral(value) &&
        hasLetter(value.text)
      ) {
        found.add(`${name}="${value.text.slice(0, 60)}"`);
      }
    }
    compiler.forEachChild(node, visit);
  };
  compiler.forEachChild(sourceFile, visit);
  return [...found].sort();
};

export const PROVIDER_PATHS = [
  ".agents/knowledge/migrations/",
  ".agents/sessions/",
  ".agents/skills/",
  ".claude/",
  ".codex/",
  ".github/",
  ".opencode/",
  ".playwright-mcp/",
  "coverage/",
  "dist/",
  "node_modules/",
  "playwright-report/",
  "test-results/",
  ".git/",
  ".next/",
];

export const bindingInput = (binding) => {
  if (typeof binding === "string") return { source: binding, type: "artifact" };
  plainObject(binding, "source binding");
  return {
    source: binding.source ?? binding.path,
    sourceRoot: binding.sourceRoot,
    type: binding.type ?? "artifact",
  };
};

export const sourcePathForId = ({ source, sourceRoot }) => {
  const value = nonEmpty(source, "source binding");
  if (!path.isAbsolute(value)) return normalizeRelative(value, "source binding");
  if (!sourceRoot) {
    throw new Error("An absolute source binding requires sourceRoot.");
  }
  return normalizeRelative(path.relative(path.resolve(sourceRoot), value), "source binding");
};

export const artifactIdFor = (binding) => {
  const input = bindingInput(binding);
  const type = assertSafeName(input.type, "artifact type");
  const source = sourcePathForId(input);
  // ponytail: on win32 the same physical artifact reached through case-variant
  // paths must share one identity, mirroring samePath's platform fold.
  const idSource = process.platform === "win32" ? source.toLowerCase() : source;
  const base = path.posix.basename(source).replace(/\.[^.]+$/, "").toLowerCase();
  const slug = (base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || type)
    .slice(0, 40)
    .replace(/-$/, "");
  return assertSafeName(
    `${slug}-${sha256(canonical({ source: idSource, type })).slice(0, 12)}`,
    "artifact id",
  );
};

export const assertDirectory = async (root, label) => {
  const details = await lstat(root).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${root}`);
    throw error;
  });
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${root}`);
  }
};

export const isExcluded = (relative) => {
  const normalized = relative === "." ? "" : `${relative.replace(/\/$/, "")}/`;
  return PROVIDER_PATHS.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
};

export const scopedManifest = async (root, scopes, { excludeProviders = false } = {}) => {
  const entries = new Map();
  const visit = async (absolute, relative) => {
    if (excludeProviders && isExcluded(relative)) return;
    let details;
    try {
      details = await lstat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") {
        entries.set(relative, { path: relative, kind: "MISSING", sha256: null });
        return;
      }
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error(`Refusing symlink evidence path: ${absolute}`);
    if (details.isFile()) {
      entries.set(relative, { path: relative, kind: "FILE", sha256: await fileHash(absolute) });
      return;
    }
    if (!details.isDirectory()) return;
    for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      await visit(path.join(absolute, entry.name), child);
    }
  };
  for (const scope of [...new Set(scopes)].sort()) {
    const relative = normalizeRelative(scope, "binding path");
    const absolute = path.resolve(root, relative);
    if (!isWithin(root, absolute)) throw new Error(`Binding path escapes root: ${relative}`);
    await visit(absolute, relative);
  }
  const rows = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { entries: rows, digest: sha256(canonical(rows)) };
};

export const captureBinding = async (root, paths, side) => {
  const excludeProviders = side === "target";
  const [revision, dirty, manifest] = await Promise.all([
    gitRevision(root),
    dirtyManifest(root, { exclude: excludeProviders ? PROVIDER_PATHS : [".agents/knowledge/migrations/"] }),
    scopedManifest(root, paths, { excludeProviders }),
  ]);
  return {
    revision: revision.revision,
    pathScoped: revision.pathScoped,
    dirtyDigest: dirty.digest,
    paths: [...new Set(paths.map((value) => normalizeRelative(value, `${side} path`)))].sort(),
    entries: manifest.entries,
    digest: manifest.digest,
  };
};

export const sourcePathAtRoot = (root, value) => {
  const file = nonEmpty(value, "source");
  const relative = normalizeRelative(path.isAbsolute(file) ? path.relative(root, file) : file, "source");
  if (!isWithin(root, path.resolve(root, relative))) throw new Error("source escapes sourceRoot.");
  return relative;
};

export const targetPathsFor = (sourcePath, targetPath, sourcePaths) =>
  sourcePath === targetPath ? sourcePaths : [targetPath];

export const resolveArtifact = async ({
  source,
  sources = [],
  type = "artifact",
  target,
  sourceRoot = process.cwd(),
  targetRoot = process.cwd(),
  formatVersion = ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS,
  pilotFormat,
  designSource,
  figma,
  ponytail,
} = {}) => {
  if (ponytail !== undefined) assertPonytailTarget(ponytail);
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedTargetRoot = path.resolve(targetRoot);
  await Promise.all([
    assertDirectory(resolvedSourceRoot, "sourceRoot"),
    assertDirectory(resolvedTargetRoot, "targetRoot"),
  ]);
  const sourcePath = sourcePathAtRoot(resolvedSourceRoot, source);
  const sourcePaths = [...new Set([sourcePath, ...sources.map((file) => sourcePathAtRoot(resolvedSourceRoot, file))])].sort();
  for (const file of sourcePaths) {
    const absolute = path.resolve(resolvedSourceRoot, file);
    await access(absolute).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`Source artifact does not exist: ${absolute}`);
      throw error;
    });
  }
  const artifactType = assertSafeName(type, "artifact type");
  const targetPath = normalizeRelative(target ?? sourcePath, "target");
  if (sourcePaths.length > 1 && targetPath !== sourcePath) {
    throw new Error("Multi-file artifacts require matching source and target paths; explicit remapping is unsupported.");
  }
  const targetPaths = targetPathsFor(sourcePath, targetPath, sourcePaths);
  const id = artifactIdFor({ source: sourcePath, type: artifactType });
  if (formatVersion !== ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS ||
    (pilotFormat !== undefined && pilotFormat !== ARTIFACT_FORMAT_SUPPORTED)) {
    throw new Error(`Unsupported artifact migration format ${formatVersion}.`);
  }
  const design = resolveDesignSource({ designSource, figma });
  return {
    id,
    artifactType,
    formatVersion: pilotFormat ?? formatVersion,
    source: { root: resolvedSourceRoot, path: sourcePath },
    sourcePaths,
    target: { root: resolvedTargetRoot, path: targetPath },
    targetPaths,
    root: artifactRoot(resolvedTargetRoot, id),
    ...(ponytail ? { ponytail } : {}),
    ...design,
  };
};

export const validateEvidenceFile = async (root, evidence, label, extra = []) => {
  exactObject(evidence, label, ["path", "sha256", "status", ...extra]);
  const relative = normalizeRelative(evidence.path, `${label}.path`);
  if (evidence.status !== "VERIFIED") throw new Error(`${label}.status must be VERIFIED.`);
  const actual = await secureHash(root, relative, `${label}.path`).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${label}.path does not exist: ${relative}.`);
    throw error;
  });
  if (actual !== evidence.sha256) throw new Error(`${label}.sha256 does not match ${relative}.`);
  return relative;
};

export const validateSourceEvidenceFile = async (state, evidence, label) => {
  const relative = normalizeRelative(evidence.path, `${label}.path`);
  const frozen = samePath(state.source.root, state.target.root) &&
    state.bindings.target.paths.includes(relative)
      ? state.bindings.source.entries.find((entry) => entry.path === relative && entry.kind === "FILE")
      : null;
  if (!frozen) return validateEvidenceFile(state.source.root, evidence, label);
  exactObject(evidence, label, ["path", "sha256", "status"]);
  if (evidence.status !== "VERIFIED" || evidence.sha256 !== frozen.sha256) {
    throw new Error(`${label} does not match the frozen source binding for ${relative}.`);
  }
  return relative;
};

/**
 * The source inventory document: its shape, the bound source files, and every
 * behavior, global contract and feature-local visual with its evidence. Track
 * A5 split this out of the artifact engine's `validateSourceInventory`, which
 * keeps the operator-decision projection (ledger, history, candidates).
 */
export const validateSourceInventoryDocument = async (root, state) => {
  const relative = "inventories/source.json";
  const document = await readJsonAt(root, relative, "source inventory");
  exactObject(document, "source inventory", [
    "version",
    "artifactId",
    "hasVisibleUi",
    "sourceFiles",
    "behaviors",
    "globalContracts",
    "featureLocalVisuals",
    "operatorDecisions",
  ]);
  versionOne(document.version, "source inventory");
  if (document.artifactId !== state.artifactId) throw new Error("source inventory artifactId does not match state.");
  boolean(document.hasVisibleUi, "source inventory.hasVisibleUi");
  const sourceFiles = arrayOf(document.sourceFiles, "source inventory.sourceFiles").map((file) =>
    normalizeRelative(file, "source inventory source file"),
  );
  unique(sourceFiles, "source inventory.sourceFiles");
  const boundFiles = state.bindings.source.entries
    .filter((entry) => entry.kind === "FILE")
    .map((entry) => entry.path);
  sameMembers(sourceFiles, boundFiles, "source inventory.sourceFiles");
  const behaviorIds = [];
  for (const [index, row] of arrayOf(document.behaviors, "source inventory.behaviors").entries()) {
    exactObject(row, `source inventory.behaviors[${index}]`, ["id", "description", "visible", "evidence"], ["runtimeStates"]);
    behaviorIds.push(nonEmpty(row.id, `source inventory.behaviors[${index}].id`));
    nonEmpty(row.description, `source inventory.behaviors[${index}].description`);
    boolean(row.visible, `source inventory.behaviors[${index}].visible`);
    // A visible behavior declares the runtime states its target must capture,
    // mirroring the module engine's uiBehavior.runtimeStates contract.
    if (row.visible) {
      const states = arrayOf(row.runtimeStates, `source behavior '${row.id}' runtimeStates`);
      if (states.length === 0) throw new Error(`visible source behavior '${row.id}' requires at least one runtime state.`);
      unique(states, `source behavior '${row.id}' runtimeStates`);
      for (const runtimeState of states) {
        if (!UI_RUNTIME_STATES.has(runtimeState)) throw new Error(`source behavior '${row.id}' declares unsupported runtime state '${runtimeState}'.`);
      }
    } else if (row.runtimeStates !== undefined && arrayOf(row.runtimeStates, `source behavior '${row.id}' runtimeStates`).length > 0) {
      throw new Error(`non-visible source behavior '${row.id}' cannot declare runtimeStates.`);
    }
    const evidence = arrayOf(row.evidence, `source inventory.behaviors[${index}].evidence`);
    if (evidence.length === 0) throw new Error(`source inventory behavior '${row.id}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateSourceEvidenceFile(state, item, `source behavior '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  if (behaviorIds.length === 0) throw new Error("source inventory requires at least one behavior.");
  unique(behaviorIds, "source behavior ids");
  const contractIds = [];
  for (const [index, row] of arrayOf(document.globalContracts, "source inventory.globalContracts").entries()) {
    exactObject(row, `source inventory.globalContracts[${index}]`, ["id", "kind", "sourcePath", "consumers"]);
    contractIds.push(nonEmpty(row.id, `source inventory.globalContracts[${index}].id`));
    nonEmpty(row.kind, `source inventory.globalContracts[${index}].kind`);
    const sourcePath = normalizeRelative(row.sourcePath, `global contract '${row.id}' sourcePath`);
    const consumers = arrayOf(row.consumers, `global contract '${row.id}' consumers`).map((entry) =>
      normalizeRelative(entry, `global contract '${row.id}' consumer`),
    );
    unique(consumers, `global contract '${row.id}' consumers`);
    for (const file of [sourcePath, ...consumers]) await access(path.join(state.source.root, file));
  }
  unique(contractIds, "global contract ids");
  const visualIds = [];
  for (const [index, row] of arrayOf(document.featureLocalVisuals, "source inventory.featureLocalVisuals").entries()) {
    exactObject(row, `source inventory.featureLocalVisuals[${index}]`, ["id", "path", "evidence"]);
    visualIds.push(nonEmpty(row.id, `source inventory.featureLocalVisuals[${index}].id`));
    normalizeRelative(row.path, `feature-local visual '${row.id}' path`);
    const evidence = arrayOf(row.evidence, `feature-local visual '${row.id}' evidence`);
    if (evidence.length === 0) throw new Error(`feature-local visual '${row.id}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateSourceEvidenceFile(state, item, `feature-local visual '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  unique(visualIds, "feature-local visual ids");
  return { relative, document, behaviorIds, contractIds, visualIds };
};

// One disposition vocabulary, applied identically to a structural unit and to a
// requirement. Neither can be satisfied by prose: a behavior/visual ref must
// name a real row, NOT_APPLICABLE must carry a rationale, and the four
// judgement dispositions require a satisfied ledger decision.
export const dispositionValidator = (source) => {
  const behaviorIds = new Set(source.behaviorIds);
  const visualIds = new Set(source.visualIds);
  const satisfiedDecisions = new Set(
    source.decisions.filter((row) => row.satisfied).map((row) => row.id),
  );
  return (row, key, label) => {
    if (!COMPLETENESS_DISPOSITIONS.includes(row.disposition)) {
      throw new Error(`${label} '${key}' has unknown disposition '${row.disposition}'.`);
    }
    const ref = row.ref ?? null;
    switch (row.disposition) {
      case "MIGRATED_BEHAVIOR":
        if (!behaviorIds.has(ref)) throw new Error(`${label} '${key}' names unknown behavior '${ref}'.`);
        break;
      case "FEATURE_LOCAL":
        if (!visualIds.has(ref)) throw new Error(`${label} '${key}' names unknown feature-local visual '${ref}'.`);
        break;
      case "NOT_APPLICABLE":
        nonEmpty(row.rationale, `${label} '${key}' rationale`);
        break;
      case "TARGET_NATIVE_EQUIVALENT":
        nonEmpty(ref, `${label} '${key}' targetNative ref`);
        break;
      case "EXTERNAL_DEPENDENCY":
        nonEmpty(ref, `${label} '${key}' external package ref`);
        break;
      default:
        // The four decision-backed dispositions require a satisfied ledger id.
        if (!satisfiedDecisions.has(ref)) throw new Error(`${label} '${key}' lacks a recorded operator decision.`);
    }
  };
};

// `@scope/name/deep` and `name/deep` both require the package `@scope/name` /
// `name`; a subpath import is not its own dependency.
export const packageNameOf = (spec) => {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/**
 * The census rules of one external requirement row (Track A5 split out of the
 * artifact engine's `validateExternalRequirements`): an external element is
 * never disposed of as something inside the artifact, and EXTERNAL_DEPENDENCY
 * names exactly the package it requires. Returns that package, which the
 * target must still provide, or null for any other disposition.
 */
export const externalRequirementPackage = (row, label) => {
  const element = typeof row?.element === "string" ? row.element : "";
  const external = EXTERNAL_ELEMENT.exec(element);
  if (external && ["MIGRATED_BEHAVIOR", "FEATURE_LOCAL", "TARGET_NATIVE_EQUIVALENT"].includes(row.disposition)) {
    throw new Error(
      `${label} '${element}' is an external package; '${row.disposition}' names something inside this artifact and cannot dispose of it.`,
    );
  }
  if (row?.disposition !== "EXTERNAL_DEPENDENCY") return null;
  if (!external) {
    throw new Error(
      `${label} '${element}' is not an external package requirement, so EXTERNAL_DEPENDENCY cannot dispose of it.`,
    );
  }
  const expected = packageNameOf(external[1]);
  if (row.ref !== expected) {
    throw new Error(
      `${label} '${element}' must name the required package '${expected}', not '${row.ref}'.`,
    );
  }
  return { element, expected };
};

// Every scanner output that names something the artifact requires from outside
// its own boundary. Dropping any one of them is exactly the defect that let a
// required external package vanish between the scan and the completeness gate,
// so the projection names them and the scan is asserted to still expose each.
export const SCANNER_REQUIREMENT_KEYS = Object.freeze([
  "supporting",
  "external",
  "unresolved",
  "findings",
  "runtimeUrls",
]);
