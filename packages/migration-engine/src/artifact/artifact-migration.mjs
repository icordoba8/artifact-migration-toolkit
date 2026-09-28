import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertSafeName,
  assertPonytailTarget,
  assertSecurePath,
  atomicWrite,
  createDecisionCandidate,
  decisionAppliesToCandidate,
  decisionLineDigest,
  dirtyManifest,
  exitCodeFor,
  FINAL_GATES,
  gitRevision,
  MIGRATION_MODES,
  MIGRATION_OUTCOMES,
  MIGRATION_STEPS,
  migrationProgress,
  readRecordedDecisions,
  renderProgress,
  resolveDesignSource,
  runDiscoveryScan,
  structuralUnits as structuralUnitsRaw,
  UI_RUNTIME_STATES,
} from "../core.mjs";
import {
  compareVisualFact,
  FIGMA_CONTEXT_FILE,
  pendingVisualUnbackedCandidates,
  validateFigmaContext,
  validateVisualAcceptance,
  VISUAL_ACCEPTANCE_FILE,
  VISUAL_ACCEPTANCE_FORMAT,
} from "../resumable-migration.mjs";
import {
  approveWithOperator,
  artifactApprover,
  recorderFor,
} from "../operator-approval.mjs";
import { nextIncrement, upgradeProjection } from "../format-upgrade.mjs";

// Re-export for tests that need to verify the structural census directly.
export { structuralUnitsRaw as structuralUnits };
import { withModuleLock } from "../module-lock.mjs";
import { parserResolutionError } from "../discovery-scan.mjs";
// ponytail: this skill already imports the start-migration engine (above) and
// already routes every artifact approval through its recorder, so binding the
// rendered command to that same installation adds no coupling that was not
// already load-bearing.
import { engineCommand, quoteCommandToken } from "../engine-paths.mjs";
import {
  activeToolkitIdentity,
  sameToolkitIdentity,
  TOOLKIT_IDENTITY_EVENTS,
  toolkitIdentityBlocker,
  toolkitIdentityKey,
  toolkitIdentityStatus,
  validateToolkitIdentity,
} from "../toolkit-identity.mjs";

// Structural census parsing needs a TypeScript syntax parser, not module
// resolution, so any resolvable compiler works; load the one nearest this
// engine rather than the (possibly dependency-less) legacy project.
const loadStructuralParser = () => {
  try {
    return createRequire(import.meta.url)("ts-discovery-compiler");
  } catch (error) {
    throw parserResolutionError(error, import.meta.url, "migrate-artifact");
  }
};

// The completeness dispositions: the shared UI mismatch vocabulary, the
// capability vocabulary, and the terminal row for an element the artifact
// requires but does not own -- an external package the target must provide.
const COMPLETENESS_DISPOSITIONS = Object.freeze([
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

// A requirement disposed with one of these claims the element is carried into
// the target, so it owes concrete preservation evidence at FINALIZE. The rest
// are terminal without a target file: TARGET_NATIVE_EQUIVALENT is proved by its
// target-native row, EXTERNAL_DEPENDENCY by the target's own manifest, and the
// remaining four say the element is deliberately not carried.
const PRESERVED_DISPOSITIONS = Object.freeze([
  "MIGRATED_BEHAVIOR",
  "FEATURE_LOCAL",
  "INTENTIONAL_FIX",
  "INTENTIONAL_DESIGN_ADAPTATION",
]);

// A requirement element is either a source-relative path or a reference token.
// Tokens carry a space, so a token can never be mistaken for a path.
const EXTERNAL_ELEMENT = /^EXTERNAL (.+)$/;

export const ARTIFACT_CONTRACT_VERSION = 1;
export const ARTIFACT_FORMAT_VERSION = 13;
export const ARTIFACT_WORKFLOW_VERSION = "1.0";
export const ARTIFACT_RESOLUTIONS = Object.freeze([
  "TARGET_REUSE",
  "TARGET_EXTEND",
  "MIGRATE_NEW",
]);

/**
 * The artifact engine's format-upgrade floor and registry, the same contract the
 * module engine declares. Declared, never derived: at or above the floor the
 * registry is the sole promoter of `formatVersion`, and below it nothing here
 * applies.
 *
 * The floor is the current runtime format, so the registry is *correctly* empty
 * -- there is no adjacent increment to register yet, and inventing a historical
 * 12 -> 13 upgrader would claim a path this toolkit has never been able to walk.
 * `assertRegistryCoverage` is what makes that self-correcting: bumping
 * `ARTIFACT_FORMAT_VERSION` to 14 fails the release gate until exactly one
 * 13 -> 14 row exists.
 */
export const ARTIFACT_FORMAT_UPGRADE_FLOOR = ARTIFACT_FORMAT_VERSION;
export const ARTIFACT_FORMAT_UPGRADERS = Object.freeze([]);

/**
 * The cursor, over the shared walk. Today it can only ever answer `null`: floor
 * and runtime are the same number, so no format is both at or above the floor
 * and behind the runtime. It is the seam a registered row plugs into, not a
 * guess about what that row will need.
 *
 * ponytail: no domain/plan classification, because an empty registry has nothing
 * to classify. Ceiling: a registered row makes `state`/`domain`/`requiredInput`
 * real, and the module engine's `pendingFormatUpgrade` is the shape to follow.
 */
export const artifactFormatUpgrade = (state) => {
  const increment = nextIncrement(
    ARTIFACT_FORMAT_UPGRADERS,
    state?.formatVersion ?? 1,
    ARTIFACT_FORMAT_VERSION,
    ARTIFACT_FORMAT_UPGRADE_FLOOR,
  );
  if (!increment) return null;
  const { from, to, row } = increment;
  return upgradeProjection({
    recordFormat: state.formatVersion,
    runtimeFormat: ARTIFACT_FORMAT_VERSION,
    from,
    to,
    upgrader: row ? { id: row.id, version: row.version } : null,
    // Fail closed: a missing row means this toolkit cannot move the record, and
    // `validateState` has already refused to admit it.
    state: row ? "READY" : "BLOCKED",
    domain: null,
    blockers: row
      ? []
      : [
          `No registered artifact format upgrader for ${from} -> ${to}. This toolkit cannot move the record past format ${from}; nothing was read or written.`,
        ],
    nextAction: row
      ? `Commit the artifact format upgrade ${from} -> ${to} (${row.id} v${row.version}).`
      : `Install a toolkit that registers the ${from} -> ${to} artifact format upgrader.`,
  });
};

/**
 * Admission, and only admission. A persisted format is readable when it is the
 * runtime format, or when it sits at or above the floor, behind the runtime, and
 * every increment from there to the runtime has a registered upgrader. Anything
 * else -- below the floor, newer than the runtime, a gap in the path -- stays
 * refused with the message it has always been refused with.
 */
const artifactFormatAdmissible = (formatVersion) => {
  if (formatVersion === ARTIFACT_FORMAT_VERSION) return true;
  if (
    !Number.isInteger(formatVersion) ||
    formatVersion < ARTIFACT_FORMAT_UPGRADE_FLOOR ||
    formatVersion > ARTIFACT_FORMAT_VERSION
  ) {
    return false;
  }
  for (let at = formatVersion; at < ARTIFACT_FORMAT_VERSION; at += 1) {
    const increment = nextIncrement(
      ARTIFACT_FORMAT_UPGRADERS,
      at,
      ARTIFACT_FORMAT_VERSION,
      ARTIFACT_FORMAT_UPGRADE_FLOOR,
    );
    if (!increment?.row) return false;
  }
  return true;
};

// ponytail: executable code detection for the code-validation gate.
// Only extensions that carry runtime or compile-time semantics need validation.
const CODE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);
const JS_FILE_EXTENSIONS = new Set([".js", ".jsx", ".mjs"]);
const execFileAsync = promisify(execFile);
const hasExecutableCodeFiles = (changedFiles) =>
  changedFiles.some((file) => CODE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()));

const commandFile = (targetRoot, value, base = targetRoot) => {
  const absolute = path.resolve(base, value);
  const relative = path.relative(targetRoot, absolute).replaceAll("\\", "/");
  return relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
};

// Two jobs, opposite version requirements, so they resolve from different
// places. Job A parses tsconfig with the pinned classic API (a TypeScript 7
// project has none to lend). Job B type-checks the target and must therefore
// run the TARGET's own compiler -- checking a TypeScript 7 project with 5.9.3
// reports diagnostics the project does not have and misses ones it does.
const TARGET_COMPILER_SPECIFIERS = Object.freeze([
  "typescript",
  "@typescript/native-preview",
]);

// TypeScript 7 blocks `typescript/bin/tsc` behind `exports`, so the binary is
// located through the manifest's own `bin` field instead of by subpath.
const resolveCompilerBinary = (require, specifier) => {
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

const targetTypeScript = (targetRoot) => {
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
    createRequire(import.meta.url),
    "ts-discovery-compiler",
  );
  if (!pinned) {
    throw parserResolutionError(
      new Error("its package manifest declares no tsc binary"),
      import.meta.url,
      "migrate-artifact",
    );
  }
  return {
    compiler,
    bin: pinned.bin,
    identity: { ...pinned, origin: "PINNED_FALLBACK" },
  };
};

export { targetTypeScript };

// ponytail: an engine fault is a crash in the toolchain this engine drives -- a
// corrupt tsconfig, an unloadable compiler, a scanner blow-up. It is never "the
// next artifact has not been authored yet", so it must never be reported as
// CONTINUE: an automated driver would loop on it forever.
const engineFault = (message, cause) =>
  Object.assign(new Error(`${message}: ${cause?.message ?? cause}`), {
    engineFault: true,
  });

// ponytail: one process runs one artifact command, so a module-level counter is
// the whole instrumentation -- no tracer, no per-call plumbing. Ceiling: two
// concurrent in-process runs share it; thread it through the call chain if that
// ever happens.
const metrics = {
  startedAt: 0,
  discoveryScans: 0,
  filesParsed: 0,
  validatorRuns: 0,
  previewAdvanceCalls: 0,
};

const startMetrics = () =>
  Object.assign(metrics, {
    startedAt: Date.now(),
    discoveryScans: 0,
    filesParsed: 0,
    validatorRuns: 0,
    previewAdvanceCalls: 0,
  });

export const artifactMetrics = () => ({
  durationMs: Date.now() - metrics.startedAt,
  discoveryScans: metrics.discoveryScans,
  filesParsed: metrics.filesParsed,
  validatorRuns: metrics.validatorRuns,
  // Proves the invariant externally: normal execution establishes the
  // transition proof exactly once before the journal exists; recovery, with no
  // in-memory proof to reuse, reruns it independently; --status never does.
  previewAdvanceCalls: metrics.previewAdvanceCalls,
});

const asEngineFault = async (message, run) => {
  try {
    return await run();
  } catch (error) {
    throw error?.engineFault ? error : engineFault(message, error);
  }
};

const structuralParser = () =>
  asEngineFault("Cannot load a TypeScript parser for the structural census", () =>
    loadStructuralParser(),
  );

// Extensions `structuralUnits` parses. Anything else is censused as a whole
// file, so its bytes never need to be read.
const STRUCTURAL_SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

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

// Every module specifier a file states, from anywhere in its AST: static
// `import`/`export`, `import =`, dynamic `import()`, and `require()`. The old
// top-level-statements-only walk saw none of the last two. A dynamic call whose
// argument is not a literal is undecidable and is returned separately rather
// than dropped.
const moduleSpecifiersIn = (compiler, file, text) => {
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
const targetCodeFiles = async (targetRoot) => {
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

// The repository's mandatory architecture rules, asserted against the files this
// migration actually changed. A pre-existing unrelated file can neither satisfy
// nor break a gate. Each rule fires only on the path shape it governs, so a
// target that does not use the convention is not judged by it.
const TEST_UNDER_SRC = /^src\/.*\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|mjs)$/;
const FEATURE_FILE = /^src\/features\/([^/]+)\//;
const FEATURE_INDEX = /^src\/features\/[^/]+\/index\.[^/]+$/;
const QUERY_KEYS_FILE = /\.query-keys\.ts$/;
const UI_TEXT_PROPS = new Set(["label", "title", "placeholder", "aria-label", "alt"]);

// MR-3: every visible string belongs in an i18n namespace. A JSX text node and a
// literal user-facing prop are visible text by construction, so this needs no
// language list -- only a letter.
const hardcodedUiText = (compiler, file, text) => {
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

// P1 #6: running target-controlled code is a capability a caller is granted,
// never an ambient property of being inside a validator. A read-only entry
// point (`--status`, preview, an artifact prerequisite probe) passes
// READ_ONLY_CAPABILITY, and every child process this engine starts goes through
// `execute`, so a validator that reaches for one from a read-only caller faults
// loudly instead of silently spawning the target's package script, the target's
// compiler binary or `node --check`.
const EXECUTION_CAPABILITY = Object.freeze({ execution: true });
const READ_ONLY_CAPABILITY = Object.freeze({ execution: false });

const assertMayExecute = (capability, what, cwd) => {
  if (capability?.execution === true) return;
  throw engineFault(
    `Refusing to execute '${what}' in '${cwd}'`,
    "a read-only artifact operation must not run target-controlled code",
  );
};

const execute = async (file, args, cwd, { shell = false, capability } = {}) => {
  assertMayExecute(capability, [file, ...args].join(" "), cwd);
  metrics.validatorRuns += 1;
  try {
    const { stdout = "", stderr = "" } = await execFileAsync(file, args, {
      cwd,
      shell,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    // A numeric exit code is the tool's verdict. A string code (ENOBUFS from an
    // exhausted output buffer, EMFILE, EACCES, ENOENT) or a killing signal is
    // the engine failing to run the check at all, and reporting that as
    // "exit 1" silently downgraded a resource failure to "not covered yet".
    if (typeof error.code === "string" || error.signal) {
      throw engineFault(
        `Cannot execute '${[file, ...args].join(" ")}' in '${cwd}'`,
        error.signal ? `killed by ${error.signal}` : error,
      );
    }
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      output: `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    };
  }
};

const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;

const executeTypeScriptValidation = async (validator, changedFiles, targetRoot, capability) => {
  const project = normalizeRelative(validator.project, "TypeScript validator project");
  const projectFile = path.resolve(targetRoot, project);
  await assertSecurePath(targetRoot, projectFile);
  const { compiler, bin, identity } = targetTypeScript(targetRoot);
  // A validator naming a project that does not exist is an authoring error; a
  // compiler that crashes on one that does is an engine fault. Only the latter
  // must stop the loop.
  if (!(await exists(projectFile))) throw new Error(`TypeScript validator project '${project}' does not exist.`);
  const parsed = await asEngineFault(`Cannot load TypeScript validator project '${project}'`, () => {
    const loaded = compiler.readConfigFile(projectFile, compiler.sys.readFile);
    if (loaded.error) throw new Error("the compiler refused to read it");
    const result = compiler.parseJsonConfigFileContent(
      loaded.config,
      compiler.sys,
      path.dirname(projectFile),
      undefined,
      projectFile,
    );
    if (result.errors.length > 0) throw new Error("the compiler refused to parse it");
    return result;
  });
  const projectFiles = new Set(parsed.fileNames.map((file) => pathKey(path.resolve(file))));
  const coveredFiles = changedFiles.filter((file) => projectFiles.has(pathKey(path.resolve(targetRoot, file))));
  const args = [bin, "--project", projectFile, "--noEmit", "--pretty", "false", "--incremental", "false"];
  const result = await execute(process.execPath, args, targetRoot, { capability });
  const errorLines = result.output.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line));
  const changed = new Set(changedFiles.map(pathKey));
  const diagnostics = errorLines.map((line) => {
    const match = line.match(/^(.*?)\(\d+,\d+\): error TS(\d+):/);
    const file = match ? commandFile(targetRoot, match[1]) : null;
    return { file, code: match ? Number(match[2]) : null, affectsChangedFile: file !== null && changed.has(pathKey(file)) };
  });
  return {
    validatorKind: "TYPESCRIPT",
    // Which compiler produced this verdict is part of the verdict. A FINALIZE
    // gate that consumed a pinned-fallback result on a project that uses a
    // different compiler has to be readable as such after the fact.
    compiler: identity,
    command: { file: process.execPath, args },
    exitCode: result.exitCode,
    coveredFiles,
    projectScope: project,
    diagnostics,
    diagnosticsComplete: diagnostics.every((diagnostic) => diagnostic.file !== null),
  };
};

const executeNodeCheckValidation = async (validator, changedFiles, targetRoot, capability) => {
  const file = normalizeRelative(validator.file, "node --check validator file");
  const absolute = path.resolve(targetRoot, file);
  await assertSecurePath(targetRoot, absolute);
  const args = ["--check", file];
  const result = await execute(process.execPath, args, targetRoot, { capability });
  return {
    validatorKind: "NODE_CHECK",
    command: { file: process.execPath, args },
    exitCode: result.exitCode,
    coveredFiles: changedFiles.includes(file) && JS_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()) ? [file] : [],
    projectScope: null,
    diagnostics: result.exitCode === 0 ? [] : [{ file, code: null, affectsChangedFile: changedFiles.includes(file) }],
    diagnosticsComplete: true,
  };
};

const executeValidator = (validator, changedFiles, targetRoot, capability) =>
  validator.kind === "TYPESCRIPT"
    ? executeTypeScriptValidation(validator, changedFiles, targetRoot, capability)
    : executeNodeCheckValidation(validator, changedFiles, targetRoot, capability);

const hasCodeValidationCheck = async (checks, changedFiles, targetRoot, capability) => {
  const changedCode = changedFiles.filter((file) => CODE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const covered = new Set();
  const evidence = [];
  for (const check of checks.filter((entry) => entry.validator)) {
    const result = await executeValidator(check.validator, changedCode, targetRoot, capability);
    evidence.push(result);
    const isolatedTypeScriptFailure =
      result.validatorKind === "TYPESCRIPT" &&
      result.exitCode !== 0 &&
      result.diagnostics.length > 0 &&
      result.diagnosticsComplete &&
      result.diagnostics.every((diagnostic) => !diagnostic.affectsChangedFile);
    if (result.exitCode !== 0 && !isolatedTypeScriptFailure) continue;
    for (const file of result.coveredFiles) covered.add(file);
  }
  return { passed: changedCode.every((file) => covered.has(file)), evidence };
};
export { hasExecutableCodeFiles, hasCodeValidationCheck };

// The target's own manifest. Missing is a plain JS/target-less project, not a
// fault; unreadable or malformed is a fault, because the answer it would have
// given decides whether a required external dependency is really there.
const targetManifest = async (targetRoot) => {
  const file = path.join(targetRoot, "package.json");
  if (!(await exists(file))) return null;
  return asEngineFault(`Cannot read the target manifest '${file}'`, async () =>
    JSON.parse(await readFile(file, "utf8")),
  );
};

const MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Target-side evidence for an `EXTERNAL <spec>` requirement: the artifact does
 * not carry the package, so the target has to declare it. Asserted, not
 * assumed -- a dependency that is absent (or that disappears before FINALIZE)
 * holds the checkpoint instead of vanishing between the scanner and the gate.
 */
const assertTargetProvides = async (targetRoot, packageName, label) => {
  const manifest = await targetManifest(targetRoot);
  if (manifest === null) {
    throw new Error(
      `${label} claims the target provides '${packageName}', but the target root has no package.json to prove it.`,
    );
  }
  const declared = MANIFEST_DEPENDENCY_FIELDS.some((field) => {
    const map = manifest[field];
    return map && typeof map === "object" && Object.hasOwn(map, packageName);
  });
  if (!declared) {
    throw new Error(
      `${label} claims the target provides '${packageName}', but the target package.json declares no such dependency.`,
    );
  }
};

// A generic check is a prose claim by default. When it names one of the target's
// own package scripts it is an executable build/test command, so it is executed
// rather than trusted: an unexecuted "PASS" proved nothing.
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const SCRIPT_NAME = /^[A-Za-z0-9_.:-]+$/;

const packageScriptOf = async (command, targetRoot) => {
  const [manager, ...rest] = command.trim().split(/\s+/);
  if (!PACKAGE_MANAGERS.has(manager)) return null;
  const args = rest[0] === "run" ? rest.slice(1) : rest;
  if (args.length !== 1 || !SCRIPT_NAME.test(args[0])) return null;
  const manifest = await targetManifest(targetRoot);
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object" || !Object.hasOwn(scripts, args[0])) return null;
  return { manager, script: args[0] };
};

const executeGenericCheck = async (command, targetRoot, label, capability) => {
  const invocation = await packageScriptOf(command, targetRoot);
  if (!invocation) return null;
  // A shell is unavoidable -- win32 package managers are `.cmd` shims and a
  // script body is a shell line either way. The manager is allowlisted and the
  // script name is pattern-checked against the target's own manifest, so
  // nothing author-controlled reaches that shell.
  const result = await execute(
    `${invocation.manager} run ${invocation.script}`,
    [],
    targetRoot,
    { shell: true, capability },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} declares PASS but '${invocation.manager} run ${invocation.script}' exited ${result.exitCode} in the target root.`,
    );
  }
  return { command, ...invocation, exitCode: result.exitCode };
};

const STATE_ROOT = ".agents/knowledge/migrations/artifacts";
const STATE_FILE = "state.json";
const INTEGRITY_FILE = "integrity.json";
const HISTORY_FILE = "history/history.ndjson";
const TRANSACTION_FILE = "transaction.json";
// Version 2 carries the previous state/integrity preimage and the exact
// transition input alongside the proposed state/event, so a later process with
// no in-memory proof can independently reconstruct and prove the transition
// before mutating anything. Version 1 (state+event only) is still accepted for
// recovery where its proof is reconstructible; see reconstructLegacyTransaction.
const TRANSACTION_VERSION = 2;
const PROVIDER_PATHS = [
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
const KNOWN_STATE_KEYS = [
  "contractVersion",
  "formatVersion",
  "workflowVersion",
  "artifactId",
  "artifactType",
  "source",
  "target",
  "resolution",
  "hasVisibleUi",
  "status",
  "currentStep",
  "activeSlice",
  "completedSteps",
  "pendingSteps",
  "completedSlices",
  "pendingSlices",
  "bindings",
  "artifactHashes",
  "revision",
  "nextAction",
  "nextCommand",
  "createdAt",
  "updatedAt",
];
// Which built toolkit may mutate this record. Implementation metadata, not an
// artifact format capability: absent on every record created before the
// standalone toolkit existed, and its presence changes no contract 1 /
// format 13 / workflow 1.0 meaning. Genuinely optional, so it is declared as
// optional rather than smuggled into the required set -- an unstamped record
// stays byte-identical to what it always was.
const OPTIONAL_STATE_KEYS = [
  "toolkitIdentity",
  "designSource",
  "figmaSources",
  "ponytail",
];
const RESOLUTION_KIND = {
  TARGET_REUSE: "REUSE",
  TARGET_EXTEND: "EXTEND",
  MIGRATE_NEW: "NEW",
};

const portable = (value) => value.split(path.sep).join("/");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = async (file) => sha256(await readFile(file));
const secureHash = async (root, relative, label = "evidence path") => {
  const normalized = normalizeRelative(relative, label);
  const file = path.resolve(root, normalized);
  await assertSecurePath(root, file);
  return fileHash(file);
};
const canonical = (value) =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, JSON.parse(canonical(child))]),
        )
      : Array.isArray(value)
        ? value.map((child) => JSON.parse(canonical(child)))
        : value,
  );
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const samePath = (left, right) => {
  const normalize = (value) =>
    process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  return normalize(left) === normalize(right);
};
export const artifactArgumentsFor = ({ artifactType, source, target, sourcePaths, sourceBinding, bindings, designSource, figmaSources, ponytail }) => [
  source.path,
  ...(sourcePaths ?? sourceBinding?.paths ?? bindings?.source?.paths ?? [source.path])
    .filter((file) => file !== source.path)
    .flatMap((file) => ["--source", file]),
  "--type",
  artifactType,
  "--target",
  target.path,
  "--source-root",
  source.root,
  "--target-root",
  target.root,
  ...(designSource === "figma-mcp"
    ? [
        "--design-source",
        designSource,
        ...(figmaSources ?? []).flatMap((item) => ["--figma", item.raw]),
      ]
    : []),
  ...(ponytail ? ["--ponytail", ponytail] : []),
];

export const artifactCommandFor = (binding) =>
  `/migrate-artifact ${artifactArgumentsFor(binding)
    .map((argument) => JSON.stringify(argument))
    .join(" ")}`;
const isWithin = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
const exists = async (file) =>
  access(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const plainObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

const exactObject = (value, label, required, optional = []) => {
  plainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown key(s): ${unknown.join(", ")}.`);
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing key(s): ${missing.join(", ")}.`);
  }
  return value;
};

const arrayOf = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};
const nonEmpty = (value, label) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};
const boolean = (value, label) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
};
const versionOne = (value, label) => {
  if (value !== 1) throw new Error(`${label}.version must be 1.`);
};
const unique = (values, label) => {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} repeats '${value}'.`);
    seen.add(value);
  }
  return seen;
};
const sameMembers = (actual, expected, label) => {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (canonical(left) !== canonical(right)) {
    throw new Error(`${label} must be exactly [${right.join(", ")}].`);
  }
};

const normalizeRelative = (value, label) => {
  const raw = nonEmpty(value, label).replaceAll("\\", "/");
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`${label} must be relative to its declared root.`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} escapes its declared root.`);
  }
  return normalized === "" ? "." : normalized;
};

const bindingInput = (binding) => {
  if (typeof binding === "string") return { source: binding, type: "artifact" };
  plainObject(binding, "source binding");
  return {
    source: binding.source ?? binding.path,
    sourceRoot: binding.sourceRoot,
    type: binding.type ?? "artifact",
  };
};

const sourcePathForId = ({ source, sourceRoot }) => {
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

export const artifactRoot = (targetRoot, id) =>
  path.join(
    path.resolve(nonEmpty(targetRoot, "targetRoot")),
    STATE_ROOT,
    assertSafeName(id, "artifact id"),
  );

// An artifact operator decision reuses the module candidate shape verbatim, so
// the module ledger reader, candidate hash, and challenge all apply unchanged.
// The binding maps: module=artifactId, legacy revision/dirty from the source
// binding, discoveryDigest=the source manifest digest.
export const artifactDecisionBoundTo = (state) => ({
  module: state.artifactId,
  legacyRevision: state.bindings.source.revision,
  legacyDirtyDigest: state.bindings.source.dirtyDigest,
  discoveryDigest: state.bindings.source.digest,
  algorithmVersion: ARTIFACT_WORKFLOW_VERSION,
});

export const artifactDecisionCandidate = (state, row) =>
  createDecisionCandidate({
    kind: "ARTIFACT_DECISION",
    subjectType: "ARTIFACT_DECISION",
    subjectPath: row.id,
    rationale: row.subject,
    targets: [],
    boundTo: artifactDecisionBoundTo(state),
  });

const assertDirectory = async (root, label) => {
  const details = await lstat(root).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${root}`);
    throw error;
  });
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${root}`);
  }
};

const isExcluded = (relative) => {
  const normalized = relative === "." ? "" : `${relative.replace(/\/$/, "")}/`;
  return PROVIDER_PATHS.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
};

const scopedManifest = async (root, scopes, { excludeProviders = false } = {}) => {
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

const captureBinding = async (root, paths, side) => {
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

const sourcePathAtRoot = (root, value) => {
  const file = nonEmpty(value, "source");
  const relative = normalizeRelative(path.isAbsolute(file) ? path.relative(root, file) : file, "source");
  if (!isWithin(root, path.resolve(root, relative))) throw new Error("source escapes sourceRoot.");
  return relative;
};

const targetPathsFor = (sourcePath, targetPath, sourcePaths) =>
  sourcePath === targetPath ? sourcePaths : [targetPath];

export const resolveArtifact = async ({
  source,
  sources = [],
  type = "artifact",
  target,
  sourceRoot = process.cwd(),
  targetRoot = process.cwd(),
  formatVersion = ARTIFACT_FORMAT_VERSION,
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
  if (formatVersion !== ARTIFACT_FORMAT_VERSION) {
    throw new Error(`Unsupported artifact migration format ${formatVersion}.`);
  }
  const design = resolveDesignSource({ designSource, figma });
  return {
    id,
    artifactType,
    formatVersion,
    source: { root: resolvedSourceRoot, path: sourcePath },
    sourcePaths,
    target: { root: resolvedTargetRoot, path: targetPath },
    targetPaths,
    root: artifactRoot(resolvedTargetRoot, id),
    ...(ponytail ? { ponytail } : {}),
    ...design,
  };
};

const validateBinding = (value, label) => {
  exactObject(value, label, ["revision", "pathScoped", "dirtyDigest", "paths", "entries", "digest"]);
  nonEmpty(value.revision, `${label}.revision`);
  boolean(value.pathScoped, `${label}.pathScoped`);
  nonEmpty(value.dirtyDigest, `${label}.dirtyDigest`);
  nonEmpty(value.digest, `${label}.digest`);
  const paths = arrayOf(value.paths, `${label}.paths`).map((entry) =>
    normalizeRelative(entry, `${label}.paths[]`),
  );
  unique(paths, `${label}.paths`);
  for (const [index, entry] of arrayOf(value.entries, `${label}.entries`).entries()) {
    exactObject(entry, `${label}.entries[${index}]`, ["path", "kind", "sha256"]);
    normalizeRelative(entry.path, `${label}.entries[${index}].path`);
    if (!["FILE", "MISSING"].includes(entry.kind)) throw new Error(`${label}.entries[${index}].kind is invalid.`);
    if (entry.kind === "FILE") nonEmpty(entry.sha256, `${label}.entries[${index}].sha256`);
    else if (entry.sha256 !== null) throw new Error(`${label}.entries[${index}].sha256 must be null.`);
  }
};

const validateState = (state, expectedId) => {
  exactObject(state, "artifact state", KNOWN_STATE_KEYS, OPTIONAL_STATE_KEYS);
  // Present or absent, never partial: a half-written identity is a runtime that
  // cannot be compared, which is the one thing this field exists to prevent.
  if (state.toolkitIdentity !== undefined) {
    validateToolkitIdentity(state.toolkitIdentity, "artifact state.toolkitIdentity");
  }
  if (state.contractVersion !== ARTIFACT_CONTRACT_VERSION) {
    throw new Error(`Unsupported artifact contract ${state.contractVersion}.`);
  }
  if (!artifactFormatAdmissible(state.formatVersion)) {
    throw new Error(`Unsupported artifact format ${state.formatVersion}.`);
  }
  if (state.workflowVersion !== ARTIFACT_WORKFLOW_VERSION) throw new Error("Unsupported artifact workflow version.");
  assertSafeName(state.artifactId, "artifact id");
  if (expectedId && state.artifactId !== expectedId) throw new Error("Artifact state identity does not match its directory.");
  assertSafeName(state.artifactType, "artifact type");
  for (const [key, label] of [["source", "source"], ["target", "target"]]) {
    exactObject(state[key], label, ["root", "path"]);
    nonEmpty(state[key].root, `${label}.root`);
    normalizeRelative(state[key].path, `${label}.path`);
  }
  if (state.resolution !== null && !ARTIFACT_RESOLUTIONS.includes(state.resolution)) {
    throw new Error(`Unknown artifact resolution '${state.resolution}'.`);
  }
  if (state.hasVisibleUi !== null) boolean(state.hasVisibleUi, "hasVisibleUi");
  if (state.designSource !== undefined) {
    const design = resolveDesignSource({
      designSource: state.designSource,
      figma: (state.figmaSources ?? []).map((source) => source?.raw),
    });
    if (canonical(design.figmaSources) !== canonical(state.figmaSources ?? [])) {
      throw new Error("Artifact state figmaSources are not canonical.");
    }
  } else if (state.figmaSources !== undefined) {
    throw new Error("Artifact state figmaSources require designSource.");
  }
  if (state.ponytail !== undefined) assertPonytailTarget(state.ponytail);
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) throw new Error(`Invalid artifact status '${state.status}'.`);
  if (state.currentStep !== "COMPLETE" && !MIGRATION_STEPS.includes(state.currentStep)) {
    throw new Error(`Unknown artifact checkpoint '${state.currentStep}'.`);
  }
  for (const field of ["completedSteps", "pendingSteps", "completedSlices", "pendingSlices"]) {
    arrayOf(state[field], field);
    unique(state[field], field);
  }
  const prefix = MIGRATION_STEPS.slice(0, state.completedSteps.length);
  if (canonical(prefix) !== canonical(state.completedSteps)) {
    throw new Error("completedSteps must be an in-order checkpoint prefix.");
  }
  exactObject(state.bindings, "bindings", ["source", "target"]);
  validateBinding(state.bindings.source, "bindings.source");
  validateBinding(state.bindings.target, "bindings.target");
  if (!state.bindings.source.paths.includes(state.source.path) || !state.bindings.target.paths.includes(state.target.path)) {
    throw new Error("Artifact binding paths must include their primary source and target.");
  }
  plainObject(state.artifactHashes, "artifactHashes");
  for (const [key, digest] of Object.entries(state.artifactHashes)) {
    nonEmpty(key, "artifactHashes key");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`artifactHashes['${key}'] is not SHA-256.`);
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error("revision must be a non-negative integer.");
  for (const field of ["nextAction", "nextCommand", "createdAt", "updatedAt"]) nonEmpty(state[field], field);
  return state;
};

const semanticEvidence = (document) => ({
  ...document,
  runtimeEvidence: document.runtimeEvidence.map(({ provider: _provider, sessionId: _session, ...row }) => row),
});

export const artifactEvidenceDigest = (document) =>
  sha256(canonical(semanticEvidence(document)));

const immutableProjection = (relative, document) => {
  if (relative === "matrices/parity.json") {
    return document.rows.map(({ id, behaviorId, resolution }) => ({ id, behaviorId, resolution }));
  }
  if (relative === "matrices/target-native.json") {
    return document.rows.map(({ id, path: file, description }) => ({ id, path: file, description }));
  }
  if (relative === "matrices/design-system.json") {
    return document.rows.map(({ id, behaviorId, scope, targetComponent, requiredComponent }) => ({
      id,
      behaviorId,
      scope,
      targetComponent,
      requiredComponent,
    }));
  }
  if (relative === "matrices/global-contract.json") {
    return document.rows.map(({ id, sourceContractId, kind, targetPath, consumers }) => ({
      id,
      sourceContractId,
      kind,
      targetPath,
      consumers,
    }));
  }
  throw new Error(`No immutable projection exists for ${relative}.`);
};

const pinDigest = async (root, key) => {
  if (key.endsWith("#semantic")) {
    const relative = key.slice(0, -"#semantic".length);
    await assertSecurePath(root, path.join(root, relative));
    const document = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    return artifactEvidenceDigest(document);
  }
  if (key.endsWith("#immutable")) {
    const relative = key.slice(0, -"#immutable".length);
    await assertSecurePath(root, path.join(root, relative));
    const document = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    return sha256(canonical(immutableProjection(relative, document)));
  }
  return secureHash(root, key, "pinned artifact path");
};

const HISTORY_EVENT_KEYS = ["seq", "at", "event", "from", "to", "slice", "revision", "prevDigest", "digest"];

/**
 * The only events allowed to carry anything beyond the fixed nine keys, and the
 * only extra keys they may carry. Everything else stays exactly as strict as it
 * was: an unknown key on an ADVANCED event is still a rejected record.
 *
 * `BOOTSTRAPPED` carries the creating toolkit's identity when there was one, so
 * it is optional there; the two identity events must carry both ends of the
 * change, so those are required.
 */
const historyEventExtraKeys = (event) =>
  event === "BOOTSTRAPPED"
    ? ["toolkitIdentity"]
    : TOOLKIT_IDENTITY_EVENTS.includes(event)
      ? ["previous", "next"]
      : [];

const readHistory = async (root) => {
  const file = path.join(root, HISTORY_FILE);
  const content = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const events = [];
  for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`History line ${index + 1} is invalid JSON: ${error.message}`);
      }
      exactObject(event, `history[${index}]`, HISTORY_EVENT_KEYS, historyEventExtraKeys(event.event));
      const { digest, ...body } = event;
      if (event.seq !== index + 1) throw new Error(`History sequence breaks at line ${index + 1}.`);
      const expectedPrevious = index === 0 ? null : events[index - 1].digest;
      if (event.prevDigest !== expectedPrevious || digest !== sha256(canonical(body))) {
        throw new Error(`History integrity breaks at line ${index + 1}.`);
      }
      events.push(event);
  }
  return { content, events };
};

/**
 * The toolkit identity the append-only history proves this record has reached.
 *
 * Identity is anchored by the event chain, not by state.json alone: the record
 * is born with whatever the creating toolkit was (absent for an unidentified
 * source checkout, exactly as before this field existed), and every later change
 * must be an explicit recorded maintenance event whose `previous` is exactly
 * where the replay stands. A duplicated, reordered, fabricated or unknown
 * identity event therefore cannot line up, and fails closed.
 */
const replayToolkitIdentity = (events) => {
  let identity =
    events[0]?.toolkitIdentity === undefined
      ? null
      : validateToolkitIdentity(
          events[0].toolkitIdentity,
          "artifact history BOOTSTRAPPED toolkitIdentity",
        );
  for (const event of events.slice(1)) {
    if (!String(event.event).startsWith("TOOLKIT_IDENTITY_")) continue;
    if (!TOOLKIT_IDENTITY_EVENTS.includes(event.event)) {
      throw new Error(`Artifact history contains an unrecognized toolkit identity event '${event.event}'.`);
    }
    const adopting = event.event === "TOOLKIT_IDENTITY_ADOPTED";
    if (adopting !== (identity === null)) {
      throw new Error(
        adopting
          ? "Artifact history adopts a toolkit identity on a record that already carries one."
          : "Artifact history changes a toolkit identity on a record that never adopted one.",
      );
    }
    if (!Object.hasOwn(event, "previous") || !Object.hasOwn(event, "next")) {
      throw new Error(`Artifact history ${event.event} must carry both previous and next identities.`);
    }
    if (toolkitIdentityKey(event.previous) !== toolkitIdentityKey(identity)) {
      throw new Error(
        "Artifact history records a toolkit identity change whose previous identity is not the one the replayed history had reached.",
      );
    }
    identity = validateToolkitIdentity(event.next, `artifact history ${event.event} next identity`);
  }
  return identity;
};

const integrityFor = (state, historyContent) => ({
  version: 1,
  stateSha256: sha256(jsonBytes(state)),
  historyBytes: Buffer.byteLength(historyContent),
  historySha256: sha256(historyContent),
  historyEvents: historyContent.split("\n").filter(Boolean).length,
  artifactHashesSha256: sha256(canonical(state.artifactHashes)),
});

const revalidatePins = async (root, state) => {
  for (const [key, digest] of Object.entries(state.artifactHashes)) {
    if ((await pinDigest(root, key)) !== digest) throw new Error(`Completed artifact changed: ${key}.`);
  }
};

const validateIntegrity = async (root, state) => {
  const document = JSON.parse(await readFile(path.join(root, INTEGRITY_FILE), "utf8"));
  exactObject(document, "integrity", ["version", "stateSha256", "historyBytes", "historySha256", "historyEvents", "artifactHashesSha256"]);
  versionOne(document.version, "integrity");
  const history = await readHistory(root);
  const expected = integrityFor(state, history.content);
  if (canonical(document) !== canonical(expected)) throw new Error("Artifact integrity anchor does not match state/history.");
  if (history.events.at(-1)?.revision !== state.revision) throw new Error("History does not end at the state revision.");
  if (toolkitIdentityKey(replayToolkitIdentity(history.events)) !== toolkitIdentityKey(state.toolkitIdentity ?? null)) {
    throw new Error("Artifact state toolkitIdentity is not the identity its append-only history proves.");
  }
  await revalidatePins(root, state);
};

// The exact byte-identical prefix of `content` holding its first `eventCount`
// history lines. Each appended line is `JSON.stringify(event)\n` (finishTransaction),
// so slicing on "\n" and rejoining reproduces the original bytes exactly -- no
// reserialization, so a prefix this reconstructs always hashes identically to
// the original bytes it was cut from.
const historyPrefixContent = (content, eventCount) => {
  if (eventCount === 0) return "";
  const lines = content.split("\n");
  return `${lines.slice(0, eventCount).join("\n")}\n`;
};

export const readArtifactState = async (targetRoot, id) => {
  const root = artifactRoot(targetRoot, id);
  if (await exists(path.join(root, TRANSACTION_FILE))) {
    throw new Error(`Artifact transaction recovery is required at ${root}.`);
  }
  const file = path.join(root, STATE_FILE);
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw new Error(`Invalid artifact state JSON at '${file}': ${error.message}`);
  }
  validateState(state, id);
  await validateIntegrity(root, state);
  return state;
};

const eventFor = (history, state, event) => {
  const body = {
    seq: history.events.length + 1,
    at: state.updatedAt,
    event: event.event,
    from: event.from,
    to: event.to,
    slice: event.slice ?? null,
    revision: state.revision,
    prevDigest: history.events.at(-1)?.digest ?? null,
    // Only BOOTSTRAPPED and the two identity maintenance events have any, and
    // they go *inside* the digested body, so the existing hash chain covers
    // toolkit identity exactly as it covers every other event field.
    ...Object.fromEntries(
      historyEventExtraKeys(event.event)
        .filter((key) => Object.hasOwn(event, key))
        .map((key) => [key, event[key]]),
    ),
  };
  return { ...body, digest: sha256(canonical(body)) };
};

// The shared deterministic bootstrap constructor: normal execution and
// recovery both build the initial state this same way, from a resolved
// artifact identity and the bindings captured at the given timestamp. No
// bootstrap rule lives anywhere else.
const initialArtifactState = (resolved, sourceBinding, targetBinding, timestamp) => ({
  contractVersion: ARTIFACT_CONTRACT_VERSION,
  formatVersion: resolved.formatVersion,
  workflowVersion: ARTIFACT_WORKFLOW_VERSION,
  artifactId: resolved.id,
  artifactType: resolved.artifactType,
  source: resolved.source,
  target: resolved.target,
  ...(resolved.designSource
    ? { designSource: resolved.designSource, figmaSources: resolved.figmaSources }
    : {}),
  ...(resolved.ponytail ? { ponytail: resolved.ponytail } : {}),
  resolution: null,
  hasVisibleUi: null,
  status: "ACTIVE",
  currentStep: "DISCOVER_LEGACY",
  activeSlice: null,
  completedSteps: ["RESOLVE"],
  pendingSteps: MIGRATION_STEPS.slice(1),
  completedSlices: [],
  pendingSlices: [],
  bindings: { source: sourceBinding, target: targetBinding },
  artifactHashes: {},
  // Born stamped under a released toolkit, born unstamped under a source
  // checkout -- which is the state every pre-extraction record is already in.
  ...(activeToolkitIdentity() ? { toolkitIdentity: activeToolkitIdentity() } : {}),
  revision: 0,
  nextAction: "Author the source inventory.",
  nextCommand: artifactCommandFor(resolved),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const bootstrapEventInput = () => ({
  event: "BOOTSTRAPPED",
  from: "NOT_STARTED",
  to: "DISCOVER_LEGACY",
  slice: null,
  ...(activeToolkitIdentity() ? { toolkitIdentity: activeToolkitIdentity() } : {}),
});

const EMPTY_HISTORY = { events: [] };

// Strict discriminated transition input: ADVANCE carries the selected slice
// explicitly, independently of the event's slice (which retains the existing
// previous-active-slice semantics); BOOTSTRAP carries exactly what the shared
// initial-state constructor and resolver need.
const validateTransactionInput = (input, label) => {
  plainObject(input, label);
  if (input.kind === "BOOTSTRAP") {
    exactObject(
      input,
      label,
      ["kind", "artifactType", "source", "target"],
      ["designSource", "figmaSources", "sourcePaths", "ponytail"],
    );
    assertSafeName(input.artifactType, `${label}.artifactType`);
    for (const key of ["source", "target"]) {
      exactObject(input[key], `${label}.${key}`, ["root", "path"]);
      nonEmpty(input[key].root, `${label}.${key}.root`);
      normalizeRelative(input[key].path, `${label}.${key}.path`);
    }
    if (input.sourcePaths !== undefined) {
      const paths = arrayOf(input.sourcePaths, `${label}.sourcePaths`);
      unique(paths, `${label}.sourcePaths`);
      if (!paths.includes(input.source.path) || canonical(paths) !== canonical([...paths].sort())) {
        throw new Error(`${label}.sourcePaths must be sorted and include the primary source.`);
      }
      for (const file of paths) normalizeRelative(file, `${label}.sourcePaths`);
    }
    if (input.designSource !== undefined) {
      const design = resolveDesignSource({
        designSource: input.designSource,
        figma: (input.figmaSources ?? []).map((source) => source?.raw),
      });
      if (canonical(design.figmaSources) !== canonical(input.figmaSources ?? [])) {
        throw new Error(`${label}.figmaSources are not canonical.`);
      }
    }
    if (input.ponytail !== undefined) assertPonytailTarget(input.ponytail);
  } else if (input.kind === "ADVANCE") {
    exactObject(input, label, ["kind", "selectedSlice"]);
    if (input.selectedSlice !== null) nonEmpty(input.selectedSlice, `${label}.selectedSlice`);
  } else if (input.kind === "TOOLKIT_IDENTITY") {
    // Engine maintenance, not a lifecycle transition: it moves no step, slice,
    // pin, binding or decision. It is a third transaction kind rather than a
    // special ADVANCE precisely so `proveAdvanceTransaction` -- which reruns the
    // whole previewAdvance/nextState chain -- can never be asked to reproduce it.
    exactObject(input, label, ["kind", "previous", "next"]);
    if (input.previous !== null) validateToolkitIdentity(input.previous, `${label}.previous`);
    validateToolkitIdentity(input.next, `${label}.next`);
  } else {
    throw new Error(`${label}.kind must be BOOTSTRAP, ADVANCE or TOOLKIT_IDENTITY.`);
  }
};

// Exactly the checks `finishTransaction` would perform, without writing, and
// without ever calling `previewAdvance`/`nextState`/`eventFor` -- this is the
// one read-only structural proof shared by `--status`, a normal commit's
// persistence, and recovery's pre-check. It binds the envelope shape and the
// event's position against history; it never proves the lifecycle transition
// itself. Both `--status` and `run` call it, so a transaction that `run` will
// refuse can never be reported as healthy by the read-only path SKILL.md
// mandates first.
const assertTransactionReplayable = async (root, transaction) => {
  if (transaction.version === TRANSACTION_VERSION) {
    exactObject(transaction, "artifact transaction", ["version", "previousState", "previousIntegrity", "input", "state", "event"]);
    validateTransactionInput(transaction.input, "artifact transaction.input");
    if (transaction.input.kind === "BOOTSTRAP") {
      if (transaction.previousState !== null || transaction.previousIntegrity !== null) {
        throw new Error("Bootstrap transaction must not carry a previous state.");
      }
    } else {
      plainObject(transaction.previousState, "artifact transaction.previousState");
      validateState(transaction.previousState, transaction.previousState.artifactId);
      exactObject(
        transaction.previousIntegrity,
        "artifact transaction.previousIntegrity",
        ["version", "stateSha256", "historyBytes", "historySha256", "historyEvents", "artifactHashesSha256"],
      );
      versionOne(transaction.previousIntegrity.version, "artifact transaction.previousIntegrity");
    }
  } else if (transaction.version === 1) {
    exactObject(transaction, "artifact transaction", ["version", "state", "event"]);
  } else {
    throw new Error(`Unsupported artifact transaction version ${transaction.version}.`);
  }
  validateState(transaction.state, transaction.state.artifactId);
  const history = await readHistory(root);
  const matching = history.events.find((event) => event.seq === transaction.event.seq);
  if (matching && canonical(matching) !== canonical(transaction.event)) {
    throw new Error("Artifact transaction conflicts with append-only history.");
  }
  if (!matching && transaction.event.seq !== history.events.length + 1) {
    throw new Error("Artifact transaction cannot be appended in sequence.");
  }
  // The journal may describe only the exact old prefix or that prefix plus
  // its complete serialized event. Never normalize a torn/reformatted suffix,
  // or accept an event buried in a longer history before mutating authority.
  const prefix = historyPrefixContent(history.content, transaction.event.seq - 1);
  const expected = matching ? `${prefix}${JSON.stringify(transaction.event)}\n` : prefix;
  if (history.content !== expected || (matching && history.events.length !== transaction.event.seq)) {
    throw new Error("Artifact transaction history is not its exact persisted prefix or completed event.");
  }
  return { history, matching };
};

const jsonBytesEqual = (raw, value) => raw !== null && value !== null && raw === jsonBytes(value);

// The real writer only ever leaves state.json/integrity.json in one of the
// crash-window table's phases (write order is: append history, replace state,
// replace integrity). This proves the actual bytes on disk are genuinely one
// of those phases before finishTransaction is allowed to overwrite them --
// never trusting a freshly computed integrity document to excuse arbitrary
// existing corruption, and never treating a state/integrity anchor that
// belongs to neither the previous nor the proposed transition as recoverable.
const assertKnownRecoveryPhase = async (root, transaction, prefixContent) => {
  const readOrNull = (file) =>
    readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const [actualState, actualIntegrity] = await Promise.all([
    readOrNull(path.join(root, STATE_FILE)),
    readOrNull(path.join(root, INTEGRITY_FILE)),
  ]);
  const isBootstrap = transaction.previousState === null;
  const finalIntegrity = integrityFor(transaction.state, `${prefixContent}${JSON.stringify(transaction.event)}\n`);

  const stateIsPrevious = !isBootstrap && jsonBytesEqual(actualState, transaction.previousState);
  const stateIsAbsent = actualState === null;
  const stateIsNext = jsonBytesEqual(actualState, transaction.state);
  if (!stateIsPrevious && !stateIsAbsent && !stateIsNext) {
    throw new Error("Artifact state.json matches neither the previous nor the proposed state.");
  }
  if (!isBootstrap && stateIsAbsent) {
    throw new Error("Artifact state.json is missing for a non-bootstrap transaction.");
  }

  const integrityIsPrevious = !isBootstrap && jsonBytesEqual(actualIntegrity, transaction.previousIntegrity);
  const integrityIsAbsent = actualIntegrity === null;
  const integrityIsFinal = jsonBytesEqual(actualIntegrity, finalIntegrity);
  if (!integrityIsPrevious && !integrityIsAbsent && !integrityIsFinal) {
    throw new Error("Artifact integrity.json matches neither the retained nor the proposed anchor.");
  }
  if (!isBootstrap && integrityIsAbsent) {
    throw new Error("Artifact integrity.json is missing for a non-bootstrap transaction.");
  }

  const previousPaired = isBootstrap ? stateIsAbsent : stateIsPrevious;
  if (previousPaired && integrityIsFinal) {
    throw new Error("Artifact integrity anchor is ahead of its state.");
  }
  if (stateIsNext && !isBootstrap && integrityIsAbsent) {
    throw new Error("Artifact integrity anchor is behind its state.");
  }
};

// Independently reconstructs and proves a bootstrap transaction from its input
// alone: no previous state exists to anchor against, so the proof is that the
// shared constructor, given the same resolved identity and freshly captured
// bindings, reproduces the exact persisted proposal.
const proveBootstrapTransaction = async (root, transaction) => {
  const { input, state } = transaction;
  const resolved = {
    id: state.artifactId,
    artifactType: input.artifactType,
    formatVersion: state.formatVersion,
    source: input.source,
    sourcePaths: input.sourcePaths ?? [input.source.path],
    target: input.target,
    targetPaths: targetPathsFor(input.source.path, input.target.path, input.sourcePaths ?? [input.source.path]),
    ...(input.ponytail ? { ponytail: input.ponytail } : {}),
    // The journal's design fields are optional (see validateTransactionInput);
    // absent means normal execution resolved the default, so recovery resolves
    // it through the same shared resolver rather than reproducing a record with
    // no design source at all -- which no bootstrap constructor can ever emit.
    ...resolveDesignSource({
      designSource: input.designSource,
      figma: (input.figmaSources ?? []).map((source) => source?.raw),
    }),
  };
  const [sourceBinding, targetBinding] = await Promise.all([
    captureBinding(resolved.source.root, resolved.sourcePaths, "source"),
    captureBinding(resolved.target.root, resolved.targetPaths, "target"),
  ]);
  const expectedState = initialArtifactState(resolved, sourceBinding, targetBinding, state.updatedAt);
  if (canonical(expectedState) !== canonical(state)) {
    throw new Error("Recovered bootstrap transaction does not reproduce the persisted proposal.");
  }
  const expectedEvent = eventFor(EMPTY_HISTORY, expectedState, bootstrapEventInput());
  if (canonical(expectedEvent) !== canonical(transaction.event)) {
    throw new Error("Recovered bootstrap transaction event does not reproduce the persisted proposal.");
  }
  await assertKnownRecoveryPhase(root, transaction, "");
};

// Independently reconstructs and proves an advance transaction from its
// persisted preimage: rebinds the retained previous-history prefix by its
// recorded byte/hash/count boundary, then reruns the exact same
// previewAdvance -> nextState -> eventFor chain normal execution ran, from the
// persisted previousState and exact input, and compares every field.
const proveAdvanceTransaction = async (root, transaction) => {
  const { previousState, previousIntegrity, input } = transaction;
  validateState(previousState, previousState.artifactId);
  await revalidatePins(root, previousState);
  const history = await readHistory(root);
  const prefixContent = historyPrefixContent(history.content, previousIntegrity.historyEvents);
  const expectedPreviousIntegrity = integrityFor(previousState, prefixContent);
  if (canonical(expectedPreviousIntegrity) !== canonical(previousIntegrity)) {
    throw new Error("Recovered transaction previous integrity does not match retained history.");
  }
  const prefixEvents = history.events.slice(0, previousIntegrity.historyEvents);
  if (history.events.length !== prefixEvents.length && history.events.length !== prefixEvents.length + 1) {
    throw new Error("Recovered transaction history has diverged from its recorded prefix.");
  }
  if (
    history.events.length === prefixEvents.length + 1 &&
    canonical(history.events.at(-1)) !== canonical(transaction.event)
  ) {
    throw new Error("Recovered transaction history already advanced past its recorded prefix.");
  }
  // previewAdvance's "CONTINUE" reports two different things through the same
  // string: genuinely ready to commit, or still waiting on unauthored
  // checkpoint artifacts (validation.ready === false, exactly the case normal
  // execution itself refuses to commit from). Only the former reproves a
  // committed transaction; an unauthored checkpoint's CONTINUE is insufficient.
  const preview = await previewAdvance(root, previousState, { slice: input.selectedSlice });
  if (preview.outcome !== "CONTINUE" || (preview.validation && !preview.validation.ready)) {
    throw new Error(`Recovered transaction cannot be reproved: ${preview.reason ?? preview.outcome}.`);
  }
  const proposed = await nextState(root, previousState, preview.validation, preview.fresh, input.selectedSlice);
  const expectedState = { ...proposed, updatedAt: transaction.state.updatedAt };
  if (canonical(expectedState) !== canonical(transaction.state)) {
    throw new Error("Recovered transaction does not reproduce the persisted proposal.");
  }
  const expectedEvent = eventFor({ events: prefixEvents }, expectedState, {
    event: expectedState.status === "COMPLETE" ? "COMPLETED" : "ADVANCED",
    from: previousState.currentStep,
    to: expectedState.currentStep,
    slice: previousState.activeSlice,
  });
  if (canonical(expectedEvent) !== canonical(transaction.event)) {
    throw new Error("Recovered transaction event does not reproduce the persisted proposal.");
  }
  await assertKnownRecoveryPhase(root, transaction, prefixContent);
};

// A version-1 journal never recorded a preimage/input once state.json is
// replaced, so it cannot always be reconstructed -- this is an explicit
// compatibility limit of the old envelope, not a new lifecycle rule. Bootstrap
// (no predecessor to lose) is always reconstructible via the shared
// constructor. A non-bootstrap advance is reconstructible only while the
// still-current state.json is genuinely its unreplaced preimage; once state.json
// already shows the proposed state, the preimage is gone and recovery must fail
// closed rather than invent one.
const reconstructLegacyTransaction = async (root, transaction) => {
  if (transaction.event.from === "NOT_STARTED" && transaction.event.seq === 1) {
    await proveBootstrapTransaction(root, {
      previousState: null,
      previousIntegrity: null,
      input: {
        kind: "BOOTSTRAP",
        artifactType: transaction.state.artifactType,
        source: transaction.state.source,
        ...(transaction.state.bindings.source.paths.length > 1
          ? { sourcePaths: transaction.state.bindings.source.paths }
          : {}),
        target: transaction.state.target,
        ...(transaction.state.designSource
          ? {
              designSource: transaction.state.designSource,
              figmaSources: transaction.state.figmaSources,
            }
          : {}),
      },
      state: transaction.state,
      event: transaction.event,
    });
    return;
  }
  const onDisk = await readFile(path.join(root, STATE_FILE), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!onDisk || canonical(onDisk) === canonical(transaction.state)) {
    throw new Error(
      "Legacy artifact transaction has no reconstructible predecessor: version 1 does not retain a preimage once state.json is replaced.",
    );
  }
  const previousState = validateState(onDisk, onDisk.artifactId);
  const selectedSlice = previousState.currentStep === "PLAN" ? transaction.state.activeSlice : previousState.activeSlice;
  const { history, matching } = await assertTransactionReplayable(root, transaction);
  // HISTORY_APPENDED still retains the previous state/integrity pair, but its
  // history already includes the proposed event. Bind only the preimage prefix;
  // the shared proof below rejects conflicting, stale, or unanchored histories.
  const prefixContent = matching
    ? historyPrefixContent(history.content, transaction.event.seq - 1)
    : history.content;
  const previousIntegrity = integrityFor(previousState, prefixContent);
  await proveAdvanceTransaction(root, {
    previousState,
    previousIntegrity,
    input: { kind: "ADVANCE", selectedSlice },
    state: transaction.state,
    event: transaction.event,
  });
};

/**
 * The identity maintenance transition, reproved from its own preimage.
 *
 * Deliberately not routed through `proveAdvanceTransaction`: there is no
 * lifecycle transition to rerun, and the proof is correspondingly narrow --
 * the proposed state must be the previous state with *only* the identity, the
 * revision and the timestamp changed. Every other field, including every pin,
 * every binding and the whole navigation, must be byte-identical.
 */
const proveToolkitIdentityTransaction = async (root, transaction) => {
  const { previousState, previousIntegrity, input } = transaction;
  validateState(previousState, previousState.artifactId);
  await revalidatePins(root, previousState);
  const history = await readHistory(root);
  const prefixContent = historyPrefixContent(history.content, previousIntegrity.historyEvents);
  if (canonical(integrityFor(previousState, prefixContent)) !== canonical(previousIntegrity)) {
    throw new Error("Recovered toolkit identity transaction previous integrity does not match retained history.");
  }
  if (toolkitIdentityKey(previousState.toolkitIdentity ?? null) !== toolkitIdentityKey(input.previous)) {
    throw new Error("Recovered toolkit identity transaction does not start from the record's own identity.");
  }
  const prefixEvents = history.events.slice(0, previousIntegrity.historyEvents);
  const expectedState = {
    ...previousState,
    toolkitIdentity: input.next,
    revision: previousState.revision + 1,
    updatedAt: transaction.state.updatedAt,
  };
  if (canonical(expectedState) !== canonical(transaction.state)) {
    throw new Error("Recovered toolkit identity transaction does not reproduce the persisted proposal.");
  }
  const expectedEvent = eventFor({ events: prefixEvents }, expectedState, {
    event: input.previous === null ? "TOOLKIT_IDENTITY_ADOPTED" : "TOOLKIT_IDENTITY_CHANGED",
    from: previousState.currentStep,
    to: previousState.currentStep,
    slice: previousState.activeSlice,
    previous: input.previous,
    next: input.next,
  });
  if (canonical(expectedEvent) !== canonical(transaction.event)) {
    throw new Error("Recovered toolkit identity transaction event does not reproduce the persisted proposal.");
  }
  await assertKnownRecoveryPhase(root, transaction, prefixContent);
};

const finishTransaction = async (targetRoot, root, transaction) => {
  const { history, matching } = await assertTransactionReplayable(root, transaction);
  // Publish the whole next history atomically under the existing record lock:
  // interrupted temporary writes leave the proven prefix untouched; rename
  // exposes only the complete event. Recovery uses the same transition proof.
  if (!matching) {
    // Preserve the existing read-only-history contract when replacing its inode.
    await access(path.join(root, HISTORY_FILE), constants.W_OK).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await atomicWrite(targetRoot, path.join(root, HISTORY_FILE), `${history.content}${JSON.stringify(transaction.event)}\n`);
  }
  await atomicWrite(targetRoot, path.join(root, STATE_FILE), jsonBytes(transaction.state));
  const finalHistory = await readHistory(root);
  await atomicWrite(
    targetRoot,
    path.join(root, INTEGRITY_FILE),
    jsonBytes(integrityFor(transaction.state, finalHistory.content)),
  );
  await rm(path.join(root, TRANSACTION_FILE), { force: true });
  return transaction.state;
};

// Normal execution establishes the transition proof once, in-memory, before
// this ever runs (see buildAdvanceTransaction / createArtifactRecord), so this
// write+finish never re-runs previewAdvance/nextState/eventFor -- it just
// persists the already-proven transaction. Recovery, invoked from a later
// process with no in-memory proof, independently reproves through
// proveBootstrapTransaction/proveAdvanceTransaction before ever reaching here.
const writeTransaction = async (targetRoot, root, transaction) => {
  await atomicWrite(targetRoot, path.join(root, TRANSACTION_FILE), jsonBytes(transaction));
  return finishTransaction(targetRoot, root, transaction);
};

// Binds the journal to the record it was found in before any evidence in it is
// dereferenced. A transaction is content, not location: without this, a
// transaction.json copied or left over from a different artifact directory
// would be recovered as if it belonged here, writing a foreign identity's
// state into this record.
const assertTransactionBoundToRecord = (targetRoot, root, transaction) => {
  plainObject(transaction, "artifact transaction");
  plainObject(transaction.state, "artifact transaction.state");
  const expectedId = path.basename(root);
  if (transaction.state.artifactId !== expectedId) {
    throw new Error("Artifact transaction identity does not match its directory.");
  }
  exactObject(transaction.state.target, "artifact transaction.state.target", ["root", "path"]);
  if (!samePath(transaction.state.target.root, targetRoot)) {
    throw new Error("Artifact transaction target root does not match its directory.");
  }
};

const recoverTransaction = async (targetRoot, root) => {
  const file = path.join(root, TRANSACTION_FILE);
  if (!(await exists(file))) return;
  const transaction = JSON.parse(await readFile(file, "utf8"));
  assertTransactionBoundToRecord(targetRoot, root, transaction);
  if (transaction.version === TRANSACTION_VERSION) {
    if (transaction.input?.kind === "BOOTSTRAP") {
      await proveBootstrapTransaction(root, transaction);
    } else if (transaction.input?.kind === "TOOLKIT_IDENTITY") {
      await proveToolkitIdentityTransaction(root, transaction);
    } else {
      await proveAdvanceTransaction(root, transaction);
    }
  } else if (transaction.version === 1) {
    await reconstructLegacyTransaction(root, transaction);
  } else {
    throw new Error(`Unsupported artifact transaction version ${transaction.version}.`);
  }
  await finishTransaction(targetRoot, root, transaction);
};

// Establishes the advance transition exactly once, in-memory, from the
// previousState/input the running command already validated via
// `previewAdvance` -- nothing here is re-derived from disk by a later caller.
const buildAdvanceTransaction = async (root, previousState, preview, selectedSlice) => {
  await mkdir(root, { recursive: true });
  const history = await readHistory(root);
  const previousIntegrity = integrityFor(previousState, history.content);
  const proposed = await nextState(root, previousState, preview.validation, preview.fresh, selectedSlice);
  const state = { ...proposed, updatedAt: new Date().toISOString() };
  const event = eventFor(history, state, {
    event: state.status === "COMPLETE" ? "COMPLETED" : "ADVANCED",
    from: previousState.currentStep,
    to: state.currentStep,
    slice: previousState.activeSlice,
  });
  return {
    version: TRANSACTION_VERSION,
    previousState,
    previousIntegrity,
    input: { kind: "ADVANCE", selectedSlice: selectedSlice ?? null },
    state,
    event,
  };
};

const stateFileExists = (root) => exists(path.join(root, STATE_FILE));

export const previewArtifact = async (options = {}) => {
  const location = locate(options);
  if (await stateFileExists(location.root)) {
    // The inner reader, not the exported wrapper: a nested status must not
    // reset the counters of the run that asked for it.
    const status = await readArtifactStatus({ ...options, targetRoot: location.targetRoot, id: location.id });
    return {
      action: "RESUME",
      artifactId: location.id,
      root: location.root,
      requiresConfirmation: status.outcome !== "BLOCKED" && status.status !== "COMPLETE",
      confirmationId: null,
      status,
    };
  }
  const resolved = await resolveArtifact(options);
  const [sourceBinding, targetBinding] = await Promise.all([
    captureBinding(resolved.source.root, resolved.sourcePaths, "source"),
    captureBinding(resolved.target.root, resolved.targetPaths, "target"),
  ]);
  const snapshot = {
    action: "BOOTSTRAP",
    artifactId: resolved.id,
    artifactType: resolved.artifactType,
    formatVersion: resolved.formatVersion,
    source: resolved.source,
    target: resolved.target,
    designSource: resolved.designSource,
    figmaSources: resolved.figmaSources,
    ...(resolved.ponytail ? { ponytail: resolved.ponytail } : {}),
    sourceBinding,
    targetBinding,
  };
  return {
    ...snapshot,
    root: resolved.root,
    requiresConfirmation: true,
    confirmationId: sha256(canonical(snapshot)).slice(0, 16),
  };
};

const createArtifactRecord = async (resolved, options, confirmExecution) => {
  const preview = await previewArtifact(options);
  if (confirmExecution !== preview.confirmationId) {
    throw new Error("Artifact bootstrap confirmation is missing or stale.");
  }
  const timestamp = new Date().toISOString();
  const state = initialArtifactState(resolved, preview.sourceBinding, preview.targetBinding, timestamp);
  await mkdir(resolved.root, { recursive: true });
  const history = await readHistory(resolved.root);
  const event = eventFor(history, state, bootstrapEventInput());
  const transaction = {
    version: TRANSACTION_VERSION,
    previousState: null,
    previousIntegrity: null,
    input: {
      kind: "BOOTSTRAP",
      artifactType: resolved.artifactType,
      source: resolved.source,
      ...(resolved.sourcePaths.length > 1 ? { sourcePaths: resolved.sourcePaths } : {}),
      target: resolved.target,
      designSource: resolved.designSource,
      figmaSources: resolved.figmaSources,
      ...(resolved.ponytail ? { ponytail: resolved.ponytail } : {}),
    },
    state,
    event,
  };
  return writeTransaction(resolved.target.root, resolved.root, transaction);
};

export const bootstrapArtifact = async ({ confirmExecution, ...options } = {}) => {
  const resolved = await resolveArtifact(options);
  return withModuleLock(resolved.target.root, `artifact-${resolved.id}`, async () => {
    await recoverTransaction(resolved.target.root, resolved.root);
    if (await stateFileExists(resolved.root)) throw new Error(`Artifact migration '${resolved.id}' already exists.`);
    return createArtifactRecord(resolved, options, confirmExecution);
  });
};

const readJsonAt = async (root, relative, label) => {
  const file = path.join(root, relative);
  try {
    await assertSecurePath(root, file);
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${relative}.`);
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
};

const validateEvidenceFile = async (root, evidence, label, extra = []) => {
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

const validateSourceEvidenceFile = async (state, evidence, label) => {
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

const validateSourceInventory = async (root, state) => {
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
  // A decision is satisfied only by a matching line in one of the artifact's
  // append-only ledgers, recorded through record-decision.mjs --artifact by a
  // human under a TTY/elicitation or by the AUTO principal under --mode auto.
  // An agent can never mint approval by editing this JSON, and the two ledgers
  // stay separate files -- this reads them, it does not merge them.
  const { byId, decisions: ledger } = await readRecordedDecisions(root);
  const decisions = [];
  for (const [index, row] of arrayOf(document.operatorDecisions, "source inventory.operatorDecisions").entries()) {
    exactObject(row, `source inventory.operatorDecisions[${index}]`, ["id", "subject"], ["decisionId"]);
    const id = nonEmpty(row.id, `operator decision[${index}].id`);
    nonEmpty(row.subject, `operator decision '${id}' subject`);
    const decisionId = row.decisionId ?? null;
    if (decisionId !== null) nonEmpty(decisionId, `operator decision '${id}' decisionId`);
    const candidate = artifactDecisionCandidate(state, row);
    const satisfied = decisionId !== null && decisionAppliesToCandidate(byId.get(decisionId), candidate);
    // The receipt for an approval already in the ledger but not yet cited --
    // what a terminal approval leaves behind. Bound by the same predicate that
    // decides `satisfied`, so it can only ever name a line this candidate owns;
    // finding one is never itself satisfaction, only the id to cite.
    const recorded = ledger.find((line) => decisionAppliesToCandidate(line, candidate)) ?? null;
    decisions.push({ id, subject: row.subject, decisionId, candidate, satisfied, recorded });
  }
  unique(decisions.map((row) => row.id), "operator decision ids");
  return { relative, document, behaviorIds, contractIds, visualIds, decisions };
};

// One disposition vocabulary, applied identically to a structural unit and to a
// requirement. Neither can be satisfied by prose: a behavior/visual ref must
// name a real row, NOT_APPLICABLE must carry a rationale, and the four
// judgement dispositions require a satisfied ledger decision.
const dispositionValidator = (source) => {
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
const packageNameOf = (spec) => {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/**
 * The terminal rules for an external requirement, applied wherever the
 * completeness rows are read -- at DISCOVERY_COMPLETENESS and again at
 * FINALIZE, so a dependency the target has since dropped cannot ride a stale
 * approval into a COMPLETE record.
 */
const validateExternalRequirements = async (state, rows, label) => {
  for (const row of rows) {
    const element = typeof row?.element === "string" ? row.element : "";
    const external = EXTERNAL_ELEMENT.exec(element);
    if (external && ["MIGRATED_BEHAVIOR", "FEATURE_LOCAL", "TARGET_NATIVE_EQUIVALENT"].includes(row.disposition)) {
      throw new Error(
        `${label} '${element}' is an external package; '${row.disposition}' names something inside this artifact and cannot dispose of it.`,
      );
    }
    if (row?.disposition !== "EXTERNAL_DEPENDENCY") continue;
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
    await assertTargetProvides(state.target.root, expected, `${label} '${element}'`);
  }
};

// Every scanner output that names something the artifact requires from outside
// its own boundary. Dropping any one of them is exactly the defect that let a
// required external package vanish between the scan and the completeness gate,
// so the projection names them and the scan is asserted to still expose each.
const SCANNER_REQUIREMENT_KEYS = Object.freeze([
  "supporting",
  "external",
  "unresolved",
  "findings",
  "runtimeUrls",
]);

/**
 * The source requirement graph: every element the bound artifact requires from
 * outside its own boundary, plus every reference the scanner could not decide.
 *
 * This is the reference discovery engine (`runDiscoveryScan`), scoped to the
 * artifact's own path. The census defines the artifact; the resolved import
 * graph is what makes an element it reaches *into* -- a shared utility, a
 * stylesheet, an i18n namespace -- visible instead of silently absent.
 */
const sourceRequirements = (state) =>
  asEngineFault("Cannot scan the source requirement graph", async () => {
    metrics.discoveryScans += 1;
    const scan = await runDiscoveryScan({
      legacyRoot: state.source.root,
      moduleRoots: state.bindings.source.paths,
      typescript: await structuralParser(),
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

const validateCompleteness = async (root, state) => {
  const source = await validateSourceInventory(root, state);
  const relative = "inventories/completeness.json";
  const document = await readJsonAt(root, relative, "discovery completeness");
  exactObject(document, "discovery completeness", [
    "version",
    "sourceFiles",
    "units",
    "requirements",
  ]);
  versionOne(document.version, "discovery completeness");
  sameMembers(document.sourceFiles, source.document.sourceFiles, "discovery completeness.sourceFiles");
  const disposed = dispositionValidator(source);

  // The machine census defines the completeness universe; behavior prose never
  // bounds it. It runs unconditionally and censuses the artifact's own files --
  // not only the global contracts the authoring agent chose to volunteer, which
  // made an empty `globalContracts` disable the whole gate.
  const parser = await structuralParser();
  const census = new Map();
  const censusFiles = [
    ...source.document.sourceFiles,
    ...source.document.globalContracts.map((contract) => contract.sourcePath),
  ];
  for (const file of [...new Set(censusFiles)].sort()) {
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
      structuralUnitsRaw(parser, file, text),
    );
    // A structural unit path is a binding name, unique only within its file, so
    // the census key qualifies it. A whole-file unit keys as the file itself.
    for (const unit of units) {
      census.set(unit.path === file ? file : `${file}#${unit.path}`, unit);
    }
  }
  const documented = [];
  for (const [index, unit] of arrayOf(document.units, "discovery completeness.units").entries()) {
    exactObject(unit, `completeness.units[${index}]`, ["path", "disposition"], ["ref", "rationale"]);
    const unitPath = nonEmpty(unit.path, `completeness.units[${index}].path`);
    documented.push(unitPath);
    disposed(unit, unitPath, "completeness unit");
  }
  unique(documented, "discovery completeness.units paths");
  sameMembers(documented, [...census.keys()], "discovery completeness.units");

  // Nothing the artifact requires from outside itself may be silently dropped:
  // every out-of-boundary element and every undecidable reference carries a
  // disposition before this checkpoint advances.
  const scan = await sourceRequirements(state);
  // The scan censuses through git. If the bound artifact has files on disk but
  // none in the census, the graph is empty because git cannot see them, not
  // because the artifact requires nothing -- and an empty graph would let every
  // requirement through unnoticed.
  if (scan.census.length === 0 && source.document.sourceFiles.length > 0) {
    throw engineFault(
      `The source requirement graph is empty for '${state.source.path}' although it has ${source.document.sourceFiles.length} file(s)`,
      "the scan censuses through git; the artifact is ignored or outside a repository",
    );
  }
  const required = [];
  for (const [index, row] of arrayOf(document.requirements, "discovery completeness.requirements").entries()) {
    exactObject(row, `completeness.requirements[${index}]`, ["element", "disposition"], ["ref", "rationale"]);
    const element = nonEmpty(row.element, `completeness.requirements[${index}].element`);
    required.push(element);
    disposed(row, element, "completeness requirement");
  }
  unique(required, "discovery completeness.requirements elements");
  // Naming what is missing beats printing the whole universe: a silently
  // omitted element is exactly the failure this gate exists to make loud.
  const authored = new Set(required);
  const discovered = new Set(scan.elements);
  const missing = scan.elements.filter((element) => !authored.has(element));
  const unexpected = required.filter((element) => !discovered.has(element));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `discovery completeness.requirements must dispose of every discovered element (missing: ${missing.join(", ") || "none"}; not discovered: ${unexpected.join(", ") || "none"}).`,
    );
  }
  // A path requirement is a claim about a real file. Checking it here is what
  // makes a resolved-but-unreadable dependency loud: the scanner keeps the node
  // whether or not the bytes can still be read, so without this the disposition
  // would settle something the engine cannot actually see.
  for (const element of required) {
    if (element.includes(" ")) continue; // a reference token, not a path
    await asEngineFault(`Cannot read required source element '${element}'`, async () => {
      const details = await lstat(path.join(state.source.root, element));
      if (!details.isFile()) throw new Error("it is not a readable regular file");
    });
  }
  await validateExternalRequirements(state, document.requirements, "completeness requirement");
  await validateExternalRequirements(
    state,
    document.units.map((unit) => ({ ...unit, element: unit.path })),
    "completeness unit",
  );
  return { relative, document };
};

const validateTargetInventory = async (root, state) => {
  const source = await validateSourceInventory(root, state);
  const relative = "inventories/target.json";
  const document = await readJsonAt(root, relative, "target inventory");
  const assessmentCompleted = state.completedSteps.includes("ASSESS_TARGET");
  exactObject(document, "target inventory", ["version", "artifactId", "resolution", "targetFiles", "targetNative", "evidence"]);
  versionOne(document.version, "target inventory");
  if (document.artifactId !== state.artifactId) throw new Error("target inventory artifactId does not match state.");
  if (!ARTIFACT_RESOLUTIONS.includes(document.resolution)) throw new Error(`Unknown target resolution '${document.resolution}'.`);
  if (!assessmentCompleted) {
    const targetExists = await exists(path.join(state.target.root, state.target.path));
    const inPlace = samePath(state.source.root, state.target.root) &&
      state.bindings.source.paths.includes(state.target.path);
    if (document.resolution === "MIGRATE_NEW" && targetExists && !inPlace) {
      throw new Error("MIGRATE_NEW requires the bound target artifact to be absent.");
    }
    if (document.resolution !== "MIGRATE_NEW" && !targetExists) {
      throw new Error(`${document.resolution} requires the bound target artifact to exist.`);
    }
  }
  const targetFiles = arrayOf(document.targetFiles, "target inventory.targetFiles").map((file) =>
    normalizeRelative(file, "target inventory target file"),
  );
  unique(targetFiles, "target inventory.targetFiles");
  for (const file of targetFiles) await access(path.join(state.target.root, file));
  // TARGET_REUSE/EXTEND integrity: reuse is proven against the bound target,
  // never laundered through an unrelated file. MIGRATE_NEW creates the target
  // during implementation, so it is exempt from the bound-target membership.
  const targetFileSet = new Set(targetFiles);
  if (document.resolution !== "MIGRATE_NEW" && !targetFileSet.has(normalizeRelative(state.target.path, "bound target"))) {
    throw new Error(`target inventory.targetFiles must include the bound target '${state.target.path}'.`);
  }
  const nativeIds = [];
  for (const [index, row] of arrayOf(document.targetNative, "target inventory.targetNative").entries()) {
    exactObject(row, `target inventory.targetNative[${index}]`, ["id", "path", "description", "evidence"]);
    nativeIds.push(nonEmpty(row.id, `target inventory.targetNative[${index}].id`));
    const nativePath = normalizeRelative(row.path, `target-native '${row.id}' path`);
    if (!targetFileSet.has(nativePath)) throw new Error(`target-native '${row.id}' path '${nativePath}' is not a declared target file.`);
    nonEmpty(row.description, `target-native '${row.id}' description`);
    const evidence = arrayOf(row.evidence, `target-native '${row.id}' evidence`);
    if (evidence.length === 0) throw new Error(`target-native '${row.id}' requires verified evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      if (!targetFileSet.has(normalizeRelative(item.path, `target-native '${row.id}' evidence path`))) {
        throw new Error(`target-native '${row.id}' evidence[${evidenceIndex}] path is not a declared target file.`);
      }
      if (assessmentCompleted) {
        exactObject(item, `target-native '${row.id}' evidence[${evidenceIndex}]`, ["path", "sha256", "status"]);
      } else {
        await validateEvidenceFile(state.target.root, item, `target-native '${row.id}' evidence[${evidenceIndex}]`);
      }
    }
  }
  unique(nativeIds, "target-native ids");
  // A TARGET_NATIVE_EQUIVALENT unit is a claim that a named target-native row
  // already covers it. The claim is authored at DISCOVERY_COMPLETENESS, before
  // target.json exists, so it is settled here -- the first point where the
  // real target-native ids are known.
  const nativeIdSet = new Set(nativeIds);
  const completeness = await readJsonAt(root, "inventories/completeness.json", "discovery completeness");
  const claims = [
    ...(Array.isArray(completeness?.units) ? completeness.units : []).map((unit) => ({
      label: "unit",
      key: unit?.path,
      ...unit,
    })),
    ...(Array.isArray(completeness?.requirements) ? completeness.requirements : []).map((row) => ({
      label: "requirement",
      key: row?.element,
      ...row,
    })),
  ];
  for (const claim of claims) {
    if (claim?.disposition !== "TARGET_NATIVE_EQUIVALENT") continue;
    if (!nativeIdSet.has(claim.ref)) {
      throw new Error(
        `completeness ${claim.label} '${claim.key}' names target-native '${claim.ref}', which is not a declared targetNative row.`,
      );
    }
  }
  const verifiedBehaviors = [];
  for (const [index, item] of arrayOf(document.evidence, "target inventory.evidence").entries()) {
    exactObject(item, `target inventory.evidence[${index}]`, ["behaviorId", "path", "sha256", "status"]);
    if (!source.behaviorIds.includes(item.behaviorId)) throw new Error(`target evidence names unknown behavior '${item.behaviorId}'.`);
    if (!targetFileSet.has(normalizeRelative(item.path, `target evidence[${index}] path`))) {
      throw new Error(`target evidence[${index}] path '${item.path}' is not a declared target file.`);
    }
    if (!assessmentCompleted) {
      await validateEvidenceFile(state.target.root, item, `target evidence[${index}]`, ["behaviorId"]);
    }
    verifiedBehaviors.push(item.behaviorId);
  }
  if (document.resolution === "TARGET_REUSE") {
    sameMembers(verifiedBehaviors, source.behaviorIds, "TARGET_REUSE verified behavior evidence");
    // Reuse is a claim about the bound target, so every behavior has to be
    // proven on it. Listing the bound target among targetFiles while every
    // evidence row cites a sibling only launders an unrelated file as proof.
    const boundTarget = normalizeRelative(state.target.path, "bound target");
    const provenOnBoundTarget = new Set(
      document.evidence
        .filter((item) => normalizeRelative(item.path, "target evidence path") === boundTarget)
        .map((item) => item.behaviorId),
    );
    for (const behaviorId of source.behaviorIds) {
      if (!provenOnBoundTarget.has(behaviorId)) {
        throw new Error(
          `TARGET_REUSE behavior '${behaviorId}' has no evidence on the bound target '${boundTarget}'.`,
        );
      }
    }
  }
  if (document.resolution === "TARGET_EXTEND" && document.targetNative.length === 0) {
    throw new Error("TARGET_EXTEND requires at least one verified targetNative row.");
  }
  if (document.resolution === "MIGRATE_NEW" && document.targetNative.length > 0) {
    throw new Error("MIGRATE_NEW cannot declare targetNative rows.");
  }
  return { relative, document, source, nativeIds, targetFiles };
};

// Artifact records keep format 13 for compatibility; the shared Figma
// validators receive the format-17 view that opts into the existing strict
// start-migration contract without creating a second contract.
const strictFigmaState = (state) => ({
  ...state,
  formatVersion: VISUAL_ACCEPTANCE_FORMAT,
  migrationId: state.artifactId,
});

const artifactVisualAcceptance = async (root, state, source, target) =>
  validateVisualAcceptance(
    root,
    strictFigmaState(state),
    {
      uiBehaviors: source.document.behaviors
        .filter((row) => row.visible)
        .map((row) => ({
          id: row.id,
          runtimeStates: row.runtimeStates,
          conditional: false,
        })),
    },
    { uiMismatches: [] },
  );

const artifactVisualDecisions = async (root, state) => {
  if (state.designSource !== "figma-mcp") return [];
  const candidates = await pendingVisualUnbackedCandidates(
    root,
    strictFigmaState(state),
  );
  if (candidates.length === 0) return [];
  const matrix = await readJsonAt(root, VISUAL_ACCEPTANCE_FILE, "Visual acceptance matrix");
  const { byId, decisions } = await readRecordedDecisions(root);
  return candidates.map((candidate) => {
    const item = (matrix.unbacked ?? []).find(
      (row) => `${row.uiBehaviorId}::${row.state}` === candidate.subject.path,
    );
    const recorded = decisions.find((row) => decisionAppliesToCandidate(row, candidate)) ?? null;
    return {
      id: candidate.id,
      subject: candidate.subject.path,
      decisionId: item?.decisionId ?? null,
      candidate,
      satisfied: decisionAppliesToCandidate(byId.get(item?.decisionId), candidate),
      recorded,
    };
  });
};

const validateBaseline = async (root, state, { final = false } = {}) => {
  const target = await validateTargetInventory(root, state);
  const resolution = state.resolution ?? target.document.resolution;
  const files = {
    parity: "matrices/parity.json",
    native: "matrices/target-native.json",
    design: "matrices/design-system.json",
    global: "matrices/global-contract.json",
  };
  const parity = await readJsonAt(root, files.parity, "parity matrix");
  exactObject(parity, "parity matrix", ["version", "rows"]);
  versionOne(parity.version, "parity matrix");
  const parityBehaviorIds = [];
  for (const [index, row] of arrayOf(parity.rows, "parity matrix.rows").entries()) {
    exactObject(row, `parity matrix.rows[${index}]`, ["id", "behaviorId", "resolution", "status", "targetEvidence"]);
    nonEmpty(row.id, `parity row[${index}].id`);
    parityBehaviorIds.push(nonEmpty(row.behaviorId, `parity row[${index}].behaviorId`));
    if (row.resolution !== resolution) throw new Error(`parity row '${row.id}' resolution does not match ${resolution}.`);
    if (!["PLANNED", "VERIFIED"].includes(row.status)) throw new Error(`parity row '${row.id}' status is invalid.`);
    const evidence = arrayOf(row.targetEvidence, `parity row '${row.id}' targetEvidence`);
    if ((resolution === "TARGET_REUSE" || final) && row.status !== "VERIFIED") {
      throw new Error(`parity row '${row.id}' must be VERIFIED.`);
    }
    if (row.status === "VERIFIED" && evidence.length === 0) throw new Error(`parity row '${row.id}' requires target evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `parity row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(parityBehaviorIds, target.source.behaviorIds, "parity behavior coverage");

  const native = await readJsonAt(root, files.native, "target-native matrix");
  exactObject(native, "target-native matrix", ["version", "rows"]);
  versionOne(native.version, "target-native matrix");
  const nativeIds = [];
  for (const [index, row] of arrayOf(native.rows, "target-native matrix.rows").entries()) {
    exactObject(row, `target-native matrix.rows[${index}]`, ["id", "path", "description", "status", "evidence"]);
    nativeIds.push(nonEmpty(row.id, `target-native matrix row[${index}].id`));
    normalizeRelative(row.path, `target-native matrix '${row.id}' path`);
    nonEmpty(row.description, `target-native matrix '${row.id}' description`);
    if (!["PLANNED", "PRESERVED", "VERIFIED"].includes(row.status)) throw new Error(`target-native row '${row.id}' status is invalid.`);
    if (final && !["PRESERVED", "VERIFIED"].includes(row.status)) throw new Error(`target-native row '${row.id}' is not preserved.`);
    const evidence = arrayOf(row.evidence, `target-native row '${row.id}' evidence`);
    if (final && evidence.length === 0) throw new Error(`target-native row '${row.id}' requires final evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `target-native row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(nativeIds, target.nativeIds, "target-native matrix rows");

  const design = await readJsonAt(root, files.design, "design-system matrix");
  exactObject(design, "design-system matrix", ["version", "rows"]);
  versionOne(design.version, "design-system matrix");
  const visibleIds = target.source.document.behaviors.filter((row) => row.visible).map((row) => row.id);
  const designBehaviorIds = [];
  const recordedDecisions = new Set(
    target.source.decisions.filter((row) => row.satisfied).map((row) => row.id),
  );
  for (const [index, row] of arrayOf(design.rows, "design-system matrix.rows").entries()) {
    exactObject(row, `design-system matrix.rows[${index}]`, [
      "id",
      "behaviorId",
      "scope",
      "targetComponent",
      "requiredComponent",
      "status",
      "evidence",
      "decisionId",
    ]);
    nonEmpty(row.id, `design-system row[${index}].id`);
    designBehaviorIds.push(nonEmpty(row.behaviorId, `design-system row[${index}].behaviorId`));
    if (!['FEATURE_LOCAL', 'GLOBAL'].includes(row.scope)) throw new Error(`design-system row '${row.id}' scope is invalid.`);
    nonEmpty(row.targetComponent, `design-system row '${row.id}' targetComponent`);
    nonEmpty(row.requiredComponent, `design-system row '${row.id}' requiredComponent`);
    if (!["PLANNED", "COMPLIANT", "EXCEPTION_RECORDED"].includes(row.status)) throw new Error(`design-system row '${row.id}' status is invalid.`);
    if (final && !["COMPLIANT", "EXCEPTION_RECORDED"].includes(row.status)) throw new Error(`design-system row '${row.id}' is not terminal.`);
    if (row.status === "EXCEPTION_RECORDED" && !recordedDecisions.has(row.decisionId)) {
      throw new Error(`design-system row '${row.id}' lacks a recorded operator decision.`);
    }
    // MR-5: reuse the required primitive before writing a new one. Shipping
    // something other than the component the row itself names is the exception,
    // and an exception is only ever an operator's call, never an agent's.
    if (row.targetComponent !== row.requiredComponent && row.status !== "EXCEPTION_RECORDED") {
      throw new Error(
        `design-system row '${row.id}' ships '${row.targetComponent}' instead of the required '${row.requiredComponent}' without a recorded exception.`,
      );
    }
    const evidence = arrayOf(row.evidence, `design-system row '${row.id}' evidence`);
    if (final && evidence.length === 0) throw new Error(`design-system row '${row.id}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `design-system row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(designBehaviorIds, visibleIds, "design-system visible behavior coverage");

  const global = await readJsonAt(root, files.global, "global-contract matrix");
  exactObject(global, "global-contract matrix", ["version", "rows"]);
  versionOne(global.version, "global-contract matrix");
  const globalIds = [];
  for (const [index, row] of arrayOf(global.rows, "global-contract matrix.rows").entries()) {
    exactObject(row, `global-contract matrix.rows[${index}]`, [
      "id",
      "sourceContractId",
      "kind",
      "targetPath",
      "consumers",
      "status",
      "evidence",
    ]);
    nonEmpty(row.id, `global-contract row[${index}].id`);
    const sourceContractId = nonEmpty(row.sourceContractId, `global-contract row[${index}].sourceContractId`);
    if (target.source.visualIds.includes(sourceContractId)) {
      throw new Error(`Feature-local visual '${sourceContractId}' cannot enter the global-contract matrix.`);
    }
    const sourceContract = target.source.document.globalContracts.find((entry) => entry.id === sourceContractId);
    if (!sourceContract) throw new Error(`global-contract row '${row.id}' names unknown source contract '${sourceContractId}'.`);
    globalIds.push(sourceContractId);
    if (row.kind !== sourceContract.kind) throw new Error(`global-contract row '${row.id}' kind does not match source.`);
    normalizeRelative(row.targetPath, `global-contract row '${row.id}' targetPath`);
    sameMembers(row.consumers, sourceContract.consumers, `global-contract row '${row.id}' consumers`);
    if (!["PLANNED", "VERIFIED"].includes(row.status)) throw new Error(`global-contract row '${row.id}' status is invalid.`);
    if (final && row.status !== "VERIFIED") throw new Error(`global-contract row '${row.id}' must be VERIFIED.`);
    const evidence = arrayOf(row.evidence, `global-contract row '${row.id}' evidence`);
    if (final && evidence.length === 0) throw new Error(`global-contract row '${row.id}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `global-contract row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(globalIds, target.source.contractIds, "global-contract source coverage");
  const visualRows =
    state.designSource === "figma-mcp"
      ? await artifactVisualAcceptance(root, state, target.source, target)
      : null;
  return { files, parity, native, design, global, target, visualRows };
};

const validatePlan = async (root, state) => {
  const baseline = await validateBaseline(root, state);
  const relative = "slices/index.json";
  const document = await readJsonAt(root, relative, "slice plan");
  exactObject(document, "slice plan", ["version", "slices"]);
  versionOne(document.version, "slice plan");
  const ids = [];
  const covered = [];
  for (const [index, row] of arrayOf(document.slices, "slice plan.slices").entries()) {
    exactObject(row, `slice plan.slices[${index}]`, ["id", "behaviorIds", "dependsOn", "kind"]);
    const id = assertSafeName(row.id, `slice plan.slices[${index}].id`);
    ids.push(id);
    if (row.kind !== RESOLUTION_KIND[state.resolution]) throw new Error(`slice '${id}' kind does not match ${state.resolution}.`);
    const behaviorIds = arrayOf(row.behaviorIds, `slice '${id}' behaviorIds`).map((value) => nonEmpty(value, `slice '${id}' behavior id`));
    unique(behaviorIds, `slice '${id}' behaviorIds`);
    if (behaviorIds.length === 0) throw new Error(`slice '${id}' has no behaviors.`);
    covered.push(...behaviorIds);
    const dependencies = arrayOf(row.dependsOn, `slice '${id}' dependsOn`);
    for (const dependency of dependencies) {
      if (!ids.slice(0, -1).includes(dependency)) throw new Error(`slice '${id}' dependency '${dependency}' must name an earlier slice.`);
    }
  }
  if (ids.length === 0) throw new Error("slice plan requires at least one slice.");
  unique(ids, "slice ids");
  unique(covered, "planned behavior ids");
  sameMembers(covered, baseline.target.source.behaviorIds, "slice behavior coverage");
  return { relative, document, ids, baseline };
};

const validateImplementation = async (root, state, capability) => {
  const plan = await validatePlan(root, state);
  const missingDependencies = plan.document.slices
    .find((slice) => slice.id === state.activeSlice)?.dependsOn
    .filter((dependency) => !state.completedSlices.includes(dependency)) ?? [];
  if (missingDependencies.length > 0) {
    throw new Error(`Slice '${state.activeSlice}' requires completed slices: ${missingDependencies.join(", ")}.`);
  }
  const relative = `slices/${state.activeSlice}.json`;
  const document = await readJsonAt(root, relative, "slice implementation");
  exactObject(document, "slice implementation", [
    "version",
    "sliceId",
    "status",
    "changedFiles",
    "checks",
    "preservedTargetNativeIds",
  ]);
  versionOne(document.version, "slice implementation");
  if (document.sliceId !== state.activeSlice) throw new Error("slice implementation does not match activeSlice.");
  if (document.status !== "COMPLETE") throw new Error("slice implementation status must be COMPLETE.");
  const changedFiles = [];
  for (const [index, item] of arrayOf(document.changedFiles, "slice implementation.changedFiles").entries()) {
    exactObject(item, `slice implementation.changedFiles[${index}]`, ["path", "sha256"]);
    const relativeFile = normalizeRelative(item.path, `changed file[${index}].path`);
    // Provider, generated and dependency trees are excluded from the target
    // binding manifest, so drift inside one is invisible to every later
    // freshness check. Migration state, the engine's own sources and the
    // generated provider copies are all under those prefixes.
    if (isExcluded(relativeFile)) {
      throw new Error(
        `changed file '${relativeFile}' is under a provider/generated path that this migration must never write.`,
      );
    }
    const actual = await secureHash(state.target.root, relativeFile, `changed file[${index}].path`);
    if (actual !== item.sha256) throw new Error(`changed file hash does not match ${relativeFile}.`);
    changedFiles.push(relativeFile);
  }
  unique(changedFiles, "changed files");
  if (state.resolution === "TARGET_REUSE" && changedFiles.length > 0) {
    throw new Error("TARGET_REUSE cannot change target files.");
  }
  const checks = arrayOf(document.checks, "slice implementation.checks");
  if (checks.length === 0) throw new Error("slice implementation requires at least one check.");
  const deferredExecution = [];
  for (const [index, check] of checks.entries()) {
    const label = `slice implementation.checks[${index}]`;
    if (Object.hasOwn(check, "validator")) {
      exactObject(check, label, ["validator", "status"]);
      plainObject(check.validator, `${label}.validator`);
      if (check.validator.kind === "TYPESCRIPT") {
        exactObject(check.validator, `${label}.validator`, ["kind", "project"]);
        normalizeRelative(check.validator.project, `${label}.validator.project`);
      } else if (check.validator.kind === "NODE_CHECK") {
        exactObject(check.validator, `${label}.validator`, ["kind", "file"]);
        normalizeRelative(check.validator.file, `${label}.validator.file`);
      } else {
        throw new Error(`${label}.validator.kind is unsupported.`);
      }
    } else {
      exactObject(check, label, ["command", "status"]);
      nonEmpty(check.command, `${label}.command`);
    }
    if (check.status !== "PASS") throw new Error(`slice implementation check '${check.command ?? check.validator.kind}' did not PASS.`);
    // An applicable generic check is executed, not believed -- but only when
    // the caller was granted execution. A read-only caller defers it (P1 #6).
    if (check.command) {
      if (capability.execution) await executeGenericCheck(check.command, state.target.root, label, capability);
      else deferredExecution.push(check.command);
    }
  }
  // The structural half of this checkpoint -- the changed-file manifest and its
  // hashes -- is pure filesystem reading, so it still runs for a read-only
  // caller and keeps P1 #2 target-drift acceptance exact. The executable half
  // is reported as deferred instead of being trusted or faked.
  const needsValidatorEvidence = hasExecutableCodeFiles(changedFiles);
  if (needsValidatorEvidence && !capability.execution) {
    for (const check of checks.filter((entry) => entry.validator)) deferredExecution.push(check.validator.kind);
  }
  const validation = needsValidatorEvidence && capability.execution
    ? await hasCodeValidationCheck(checks, changedFiles, state.target.root, capability)
    : { passed: true, evidence: [] };
  if (!validation.passed) {
    throw new Error(
      "IMPLEMENT_SLICES changed executable code (.ts/.tsx/.js/.jsx/.mts/.mjs) but trusted validator evidence does not cover every changed file.",
    );
  }
  const preserved = arrayOf(document.preservedTargetNativeIds, "slice implementation.preservedTargetNativeIds");
  if (state.resolution === "TARGET_EXTEND") {
    sameMembers(preserved, plan.baseline.native.rows.map((row) => row.id), "TARGET_EXTEND preservedTargetNativeIds");
  }
  return { relative, document, changedFiles, validationEvidence: validation.evidence, deferredExecution, plan };
};

const validateBoundTo = (boundTo, state, label, sliceDigest, origin) => {
  exactObject(
    boundTo,
    label,
    ["sourceDigest", "targetDigest", "sliceDigest"],
    state.designSource === "figma-mcp" ? ["figmaContextDigest"] : [],
  );
  if (boundTo.sourceDigest !== state.bindings.source.digest ||
    (origin === "TARGET" && boundTo.targetDigest !== state.bindings.target.digest) ||
    (origin === "LEGACY" && !/^[a-f0-9]{64}$/.test(boundTo.targetDigest))) {
    throw new Error(`${label} is stale for the current source/target binding.`);
  }
  if (boundTo.sliceDigest !== sliceDigest) throw new Error(`${label}.sliceDigest is stale.`);
  if (
    state.designSource === "figma-mcp" &&
    boundTo.figmaContextDigest !== state.artifactHashes[FIGMA_CONTEXT_FILE]
  ) {
    throw new Error(`${label}.figmaContextDigest is stale.`);
  }
};

const validateArtifactVisualEvidence = async (root, state, row, visualRow, label) => {
  const fail = (problem) => {
    throw new Error(
      `VISUAL_ACCEPTANCE_FAIL: ${label} (${visualRow.id}, Figma node ${visualRow.figmaNodeId}) ${problem}.`,
    );
  };
  const node = (value) => String(value ?? "").trim().replace("-", ":");
  if (node(row.figmaNodeId) !== node(visualRow.figmaNodeId)) {
    fail(`names figmaNodeId '${row.figmaNodeId}'`);
  }
  const expectedViewport = `${visualRow.viewport.width}x${visualRow.viewport.height}`;
  if (`${row.viewport.width}x${row.viewport.height}` !== expectedViewport) {
    fail(`ran at viewport ${row.viewport.width}x${row.viewport.height}, the contract requires ${expectedViewport}`);
  }
  exactObject(row.measurements, `${label}.measurements`, ["path", "sha256"], ["pointer"]);
  const measurementPath = normalizeRelative(row.measurements.path, `${label}.measurements.path`);
  if (!measurementPath.startsWith(`evidence/${state.activeSlice}/ui/`)) {
    fail("measurements are not persisted under the active slice evidence/ui directory");
  }
  if ((await secureHash(root, measurementPath, `${label}.measurements.path`)) !== row.measurements.sha256) {
    fail("measurement evidence is missing, stale, or tampered");
  }
  let observation;
  try {
    const document = JSON.parse(await readFile(path.join(root, measurementPath), "utf8"));
    observation = row.measurements.pointer === undefined
      ? document
      : document?.[row.measurements.pointer];
  } catch (error) {
    fail(`references measurements that are not JSON (${error.message})`);
  }
  if (!plainObject(observation, `${label}.measurements observation`) || !plainObject(observation.values, `${label}.measurements values`)) {
    fail('references measurements without a "values" object');
  }
  if (`${observation.viewport?.width}x${observation.viewport?.height}` !== expectedViewport) {
    fail(`was measured by Playwright at viewport ${observation.viewport?.width}x${observation.viewport?.height}, the contract requires ${expectedViewport}`);
  }
  const failures = Object.entries(visualRow.expect).flatMap(([name, fact]) => {
    const miss = compareVisualFact(fact, observation.values[name], visualRow.tolerance);
    return miss ? [`${name} ${miss}`] : [];
  });
  if (failures.length > 0) fail(`diverges from the design: ${failures.join("; ")}`);
};

const validateVerification = async (root, state, capability) => {
  const implementation = await validateImplementation(root, state, capability);
  const relative = `evidence/${state.activeSlice}/result.json`;
  const document = await readJsonAt(root, relative, "slice verification");
  exactObject(document, "slice verification", ["version", "sliceId", "status", "checks", "runtimeEvidence"]);
  versionOne(document.version, "slice verification");
  if (document.sliceId !== state.activeSlice || document.status !== "PASS") {
    throw new Error("slice verification must match activeSlice and PASS.");
  }
  const slice = implementation.plan.document.slices.find((row) => row.id === state.activeSlice);
  const checkIds = [];
  for (const [index, check] of arrayOf(document.checks, "slice verification.checks").entries()) {
    exactObject(check, `slice verification.checks[${index}]`, ["behaviorId", "status", "evidence"]);
    checkIds.push(nonEmpty(check.behaviorId, `slice verification.checks[${index}].behaviorId`));
    if (check.status !== "PASS") throw new Error(`verification check '${check.behaviorId}' did not PASS.`);
    const evidence = arrayOf(check.evidence, `verification check '${check.behaviorId}' evidence`);
    if (evidence.length === 0) throw new Error(`verification check '${check.behaviorId}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `verification check '${check.behaviorId}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(checkIds, slice.behaviorIds, "slice verification behavior coverage");
  const sliceDigest = await pinDigest(root, implementation.relative);
  const behaviors = implementation.plan.baseline.target.source.document.behaviors;
  const visibleBehaviors = behaviors.filter((row) => row.visible && slice.behaviorIds.includes(row.id));
  const declaredStates = new Map(visibleBehaviors.map((row) => [row.id, row.runtimeStates ?? []]));
  const slots = new Set();
  const targetSlots = new Set();
  const capturePaths = new Set();
  for (const [index, row] of arrayOf(document.runtimeEvidence, "slice verification.runtimeEvidence").entries()) {
    exactObject(row, `runtimeEvidence[${index}]`, [
      "behaviorId",
      "origin",
      "state",
      "route",
      "viewport",
      "actions",
      "artifacts",
      "boundTo",
      "provider",
    ], ["sessionId", "figmaNodeId", "measurements"]);
    const behaviorId = nonEmpty(row.behaviorId, `runtimeEvidence[${index}].behaviorId`);
    if (row.origin !== "LEGACY" && row.origin !== "TARGET") throw new Error(`runtimeEvidence[${index}].origin must be 'LEGACY' or 'TARGET'.`);
    nonEmpty(row.state, `runtimeEvidence[${index}].state`);
    if (!UI_RUNTIME_STATES.has(row.state)) throw new Error(`runtimeEvidence[${index}].state '${row.state}' is not supported.`);
    if (!declaredStates.has(behaviorId)) throw new Error(`runtimeEvidence[${index}] names '${behaviorId}', which is not a visible behavior in this slice.`);
    if (!declaredStates.get(behaviorId).includes(row.state)) throw new Error(`runtimeEvidence[${index}] state '${row.state}' is not declared by behavior '${behaviorId}'.`);
    nonEmpty(row.route, `runtimeEvidence[${index}].route`);
    if (row.provider !== "playwright") throw new Error(`runtimeEvidence[${index}].provider must be playwright.`);
    if (row.sessionId !== undefined) nonEmpty(row.sessionId, `runtimeEvidence[${index}].sessionId`);
    exactObject(row.viewport, `runtimeEvidence[${index}].viewport`, ["width", "height"]);
    if (!Number.isInteger(row.viewport.width) || !Number.isInteger(row.viewport.height)) throw new Error("runtime viewport must use integer width/height.");
    const actions = arrayOf(row.actions, `runtimeEvidence[${index}].actions`);
    if (actions.length === 0) throw new Error(`runtime evidence '${row.behaviorId}' requires actions.`);
    for (const [actionIndex, action] of actions.entries()) {
      exactObject(action, `runtimeEvidence[${index}].actions[${actionIndex}]`, ["kind", "target", "expected", "actual", "status"]);
      for (const field of ["kind", "target", "expected", "actual"]) nonEmpty(action[field], `runtime action ${field}`);
      if (action.status !== "PASS") throw new Error(`runtime action for '${row.behaviorId}' did not PASS.`);
    }
    const kinds = [];
    for (const [artifactIndex, artifact] of arrayOf(row.artifacts, `runtimeEvidence[${index}].artifacts`).entries()) {
      exactObject(artifact, `runtimeEvidence[${index}].artifacts[${artifactIndex}]`, ["kind", "path", "sha256"]);
      if (!["ACCESSIBILITY_SNAPSHOT", "SCREENSHOT"].includes(artifact.kind)) throw new Error(`runtime artifact kind '${artifact.kind}' is invalid.`);
      kinds.push(artifact.kind);
      const artifactPath = normalizeRelative(artifact.path, "runtime artifact path");
      if (!artifactPath.startsWith(`evidence/${state.activeSlice}/ui/`)) throw new Error("runtime artifacts must stay under the active slice evidence/ui directory.");
      // A persisted capture file backs exactly one logical observation; the same
      // reference reused across slots is rejected (byte-identical distinct files
      // stay legal, since identity is the path, not the SHA).
      if (capturePaths.has(artifactPath)) throw new Error(`runtime artifact '${artifactPath}' is reused across logical observations.`);
      capturePaths.add(artifactPath);
      if ((await secureHash(root, artifactPath, "runtime artifact path")) !== artifact.sha256) throw new Error(`runtime artifact hash does not match ${artifactPath}.`);
    }
    sameMembers(kinds, ["ACCESSIBILITY_SNAPSHOT", "SCREENSHOT"], `runtime evidence '${row.behaviorId}' artifact kinds`);
    validateBoundTo(row.boundTo, state, `runtime evidence '${row.behaviorId}' boundTo`, sliceDigest, row.origin);
    const visualRow =
      row.origin === "TARGET"
        ? implementation.plan.baseline.visualRows?.find(
            (item) => item.uiBehaviorId === behaviorId && item.state === row.state,
          )
        : null;
    if (visualRow) {
      await validateArtifactVisualEvidence(
        root,
        state,
        row,
        visualRow,
        `runtimeEvidence[${index}]`,
      );
    }
    // Logical observation identity: origin + behavior + runtime state. A given
    // logical slot is captured at most once; byte-identical images across
    // distinct slots stay legal (no pixel-equality rule is carried over).
    const slot = `${row.origin}::${behaviorId}::${row.state}`;
    if (slots.has(slot)) throw new Error(`runtimeEvidence[${index}] logical slot '${slot}' is captured more than once.`);
    slots.add(slot);
    if (row.origin === "TARGET") targetSlots.add(`${behaviorId}::${row.state}`);
  }
  if (state.hasVisibleUi) {
    const requiredTargetSlots = [];
    for (const behavior of visibleBehaviors) {
      for (const runtimeState of behavior.runtimeStates ?? []) requiredTargetSlots.push(`${behavior.id}::${runtimeState}`);
    }
    sameMembers([...targetSlots], requiredTargetSlots, "Playwright TARGET runtime coverage");
  } else if (document.runtimeEvidence.length > 0) {
    throw new Error("Non-UI artifact cannot carry runtime UI evidence.");
  }
  return { relative, document, implementation, semanticDigest: artifactEvidenceDigest(document) };
};

// Gate evidence is a claim about *this* migration. A bare hash of any file that
// happens to exist proved nothing: the cited path must be one this migration
// changed or declared as a target file, or the seven canonical gates are
// satisfiable by an unrelated pre-existing file.
const validateGateEvidence = async (state, item, label, scope, extra = []) => {
  exactObject(item, label, ["path", "sha256", "boundTo", ...extra]);
  const relative = normalizeRelative(item.path, `${label}.path`);
  if (scope && !scope.has(relative)) {
    throw new Error(
      `${label} cites '${relative}', which is not one of this migration's changed or declared target files.`,
    );
  }
  if ((await secureHash(state.target.root, relative, `${label}.path`)) !== item.sha256) throw new Error(`${label}.sha256 does not match ${relative}.`);
  exactObject(item.boundTo, `${label}.boundTo`, ["sourceDigest", "targetDigest"]);
  if (item.boundTo.sourceDigest !== state.bindings.source.digest || item.boundTo.targetDigest !== state.bindings.target.digest) {
    throw new Error(`${label} is stale.`);
  }
};

const ponytailTime = (value, label) => {
  const time = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return time;
};

const validatePonytailEvidence = async (state, gate, kind) => {
  const label = `final gate '${gate.name}' ponytailEvidence`;
  const item = gate.ponytailEvidence;
  if (!item) throw new Error(`Ponytail target '${state.ponytail}' requires ${gate.name} ${kind} evidence.`);
  const expectedPath = `${STATE_ROOT}/${state.artifactId}/evidence/ponytail-${kind}.md`;
  if (item.path !== expectedPath) throw new Error(`${label}.path must be '${expectedPath}'.`);
  await validateGateEvidence(state, item, label, null, ["kind", "producedAt"]);
  if (item.kind !== kind) throw new Error(`${label}.kind must be '${kind}'.`);
  return ponytailTime(item.producedAt, `${label}.producedAt`);
};

// Every file this migration wrote, across every planned slice.
const migrationChangedFiles = async (root, plan) => {
  const files = new Set();
  for (const id of plan.ids) {
    const document = await readJsonAt(root, `slices/${id}.json`, `slice implementation '${id}'`);
    for (const item of arrayOf(document.changedFiles, `slice '${id}'.changedFiles`)) {
      files.add(normalizeRelative(item.path, `slice '${id}' changed file`));
    }
  }
  return files;
};

const validateFinal = async (root, state) => {
  const baseline = await validateBaseline(root, state, { final: true });
  const plan = await validatePlan(root, state);
  const relative = "gates.json";
  const document = await readJsonAt(root, relative, "final gates");
  exactObject(document, "final gates", ["version", "gates", "uiEvidence", "requirementEvidence"]);
  versionOne(document.version, "final gates");
  const changedFiles = await migrationChangedFiles(root, plan);
  const gateScope = new Set([
    ...changedFiles,
    ...baseline.target.targetFiles,
    normalizeRelative(state.target.path, "bound target"),
  ]);
  // The gate names promise the repository's mandatory architecture rules. These
  // are those rules, evaluated for real -- a gate whose rule is violated cannot
  // be declared PASS.
  const architecture = await architectureFindings(state.target.root, changedFiles);
  const gateFailures = {
    ARCHITECTURE_IMPLEMENTATION_GATE: architecture.implementation,
    PRECOMMIT_GATE: architecture.precommit,
  };
  const names = [];
  let ponytailReviewAt;
  let ponytailAuditAt;
  let precommitReviewedAt;
  for (const [index, gate] of arrayOf(document.gates, "final gates.gates").entries()) {
    exactObject(gate, `final gates.gates[${index}]`, ["name", "status", "evidence"], ["ponytailEvidence", "reviewedAt"]);
    names.push(nonEmpty(gate.name, `final gates.gates[${index}].name`));
    if (gate.status !== "PASS") throw new Error(`final gate '${gate.name}' did not PASS.`);
    const evidence = arrayOf(gate.evidence, `final gate '${gate.name}' evidence`);
    if (evidence.length === 0) throw new Error(`final gate '${gate.name}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateGateEvidence(state, item, `final gate '${gate.name}' evidence[${evidenceIndex}]`, gateScope);
    }
    const failures = gateFailures[gate.name] ?? [];
    if (failures.length > 0) {
      throw new Error(`final gate '${gate.name}' cannot PASS: ${failures.join(" ")}`);
    }
    if (state.ponytail && gate.name === "SIMPLIFY_ONCE") {
      ponytailReviewAt = await validatePonytailEvidence(state, gate, "review");
    }
    if (state.ponytail === "full-audit" && gate.name === "PRECOMMIT_GATE") {
      ponytailAuditAt = await validatePonytailEvidence(state, gate, "audit");
      precommitReviewedAt = ponytailTime(gate.reviewedAt, "PRECOMMIT_GATE.reviewedAt");
    }
  }
  sameMembers(names, FINAL_GATES, "final gate names");
  if (state.ponytail === "full-audit" &&
      (ponytailReviewAt >= ponytailAuditAt || ponytailAuditAt >= precommitReviewedAt)) {
    throw new Error("Ponytail Review and Audit must precede the artifact pre-commit review in order.");
  }
  const uiRows = arrayOf(document.uiEvidence, "final gates.uiEvidence");
  if (state.hasVisibleUi) {
    const referenced = [];
    for (const [index, row] of uiRows.entries()) {
      exactObject(row, `final gates.uiEvidence[${index}]`, ["sliceId", "path", "sha256", "boundTo"]);
      const sliceId = assertSafeName(row.sliceId, `final gates.uiEvidence[${index}].sliceId`);
      referenced.push(sliceId);
      const expectedPath = `evidence/${sliceId}/result.json`;
      if (normalizeRelative(row.path, "final UI evidence path") !== expectedPath) throw new Error(`final UI evidence for '${sliceId}' has the wrong path.`);
      const evidence = await readJsonAt(root, expectedPath, `final UI evidence '${sliceId}'`);
      if (artifactEvidenceDigest(evidence) !== row.sha256) throw new Error(`final UI evidence hash for '${sliceId}' is stale.`);
      exactObject(row.boundTo, `final UI evidence '${sliceId}' boundTo`, ["sourceDigest", "targetDigest"]);
      if (row.boundTo.sourceDigest !== state.bindings.source.digest || row.boundTo.targetDigest !== state.bindings.target.digest) {
        throw new Error(`final UI evidence '${sliceId}' binding is stale.`);
      }
      for (const [rowIndex, runRow] of arrayOf(evidence.runtimeEvidence, `final UI evidence '${sliceId}' runtimeEvidence`).entries()) {
        for (const [artifactIndex, artifact] of arrayOf(runRow.artifacts, `final UI evidence '${sliceId}' runtimeEvidence[${rowIndex}].artifacts`).entries()) {
          exactObject(artifact, `final UI evidence '${sliceId}' runtimeEvidence[${rowIndex}].artifacts[${artifactIndex}]`, ["kind", "path", "sha256"]);
          const artifactPath = normalizeRelative(artifact.path, "runtime artifact path");
          if ((await secureHash(root, artifactPath, "runtime artifact path")) !== artifact.sha256) {
            throw new Error(`runtime artifact hash does not match ${artifactPath}.`);
          }
        }
      }
    }
    const uiSlices = plan.document.slices
      .filter((slice) => baseline.target.source.document.behaviors.some((behavior) => behavior.visible && slice.behaviorIds.includes(behavior.id)))
      .map((slice) => slice.id);
    sameMembers(referenced, uiSlices, "final UI evidence slices");
  } else if (uiRows.length > 0) {
    throw new Error("Final UI evidence is not applicable to this artifact format/type.");
  }
  const completeness = await readJsonAt(root, "inventories/completeness.json", "discovery completeness");
  const requirements = Array.isArray(completeness?.requirements) ? completeness.requirements : [];

  // A requirement disposed as carried into the target owes a target file that
  // actually carries it. Discovering a stylesheet, an asset, an i18n namespace
  // or a runtime URL and then never proving it downstream is how non-code
  // requirements were lost after the completeness gate approved them.
  const owedPreservation = requirements
    .filter((row) => PRESERVED_DISPOSITIONS.includes(row?.disposition))
    .map((row) => row.element);
  const provenPreservation = [];
  for (const [index, row] of arrayOf(document.requirementEvidence, "final gates.requirementEvidence").entries()) {
    const label = `final gates.requirementEvidence[${index}]`;
    await validateGateEvidence(state, row, label, gateScope, ["element"]);
    provenPreservation.push(nonEmpty(row.element, `${label}.element`));
  }
  unique(provenPreservation, "final gates.requirementEvidence elements");
  sameMembers(provenPreservation, owedPreservation, "final gates.requirementEvidence");

  // Re-asserted here, not inherited from the completeness checkpoint: a target
  // dependency dropped since then must block completion, not ride an old
  // approval into a COMPLETE record.
  await validateExternalRequirements(state, requirements, "final requirement");

  // In one root, only a source path actually changed by a migration slice is
  // migrated. Bootstrap prebinds every source path as a target, even untouched
  // legacy files. Separate-root migration keeps its existing full scope.
  const inPlace = samePath(state.source.root, state.target.root);
  const legacyPaths = [
    ...state.bindings.source.paths,
    ...(inPlace ? [] : requirements)
      .map((row) => row?.element)
      .filter((element) => typeof element === "string" && !element.includes(" ")),
  ].filter((file) =>
    !inPlace || !changedFiles.has(file),
  );
  const legacy = await legacyDependencies(state.target.root, state.source.root, legacyPaths, {
    changedFiles: [...changedFiles],
  });
  if (legacy.findings.length > 0) {
    throw new Error(
      `Target code still resolves to legacy modules: ${legacy.findings
        .map((finding) => `${finding.file} -> ${finding.legacyPath}`)
        .join(", ")}.`,
    );
  }
  if (legacy.undecidable.length > 0) {
    throw new Error(
      `Changed target code carries undecidable dynamic module references: ${legacy.undecidable
        .map((row) => `${row.file}: ${row.expression}`)
        .join(", ")}.`,
    );
  }
  return { relative, document };
};

export const checkpointArtifacts = (state) => {
  switch (state.currentStep) {
    case "RESOLVE": return ["state.json"];
    case "DISCOVER_LEGACY": return ["inventories/source.json"];
    case "DISCOVERY_COMPLETENESS": return ["inventories/completeness.json"];
    case "ASSESS_TARGET": return [
      "inventories/target.json",
      ...(state.designSource === "figma-mcp" ? [FIGMA_CONTEXT_FILE] : []),
    ];
    case "BUILD_BASELINE": return [
      "matrices/parity.json",
      "matrices/target-native.json",
      "matrices/design-system.json",
      "matrices/global-contract.json",
      ...(state.designSource === "figma-mcp" ? [VISUAL_ACCEPTANCE_FILE] : []),
    ];
    case "PLAN": return ["slices/index.json"];
    case "IMPLEMENT_SLICES": return [`slices/${state.activeSlice}.json`];
    case "VERIFY_SLICES": return [`evidence/${state.activeSlice}/result.json`];
    case "FINALIZE": return ["gates.json"];
    default: return [];
  }
};

// The capability is required, never defaulted: P1 #6 was exactly a read-only
// caller silently inheriting the write path's right to run target code. Every
// result is stamped with the capability it was produced under, so a caller that
// turns a validation into a state transition can refuse one that skipped the
// executable half.
const validateCheckpoint = async (root, state, capability) => {
  if (capability?.execution !== true && capability?.execution !== false) {
    throw new Error("validateCheckpoint requires an explicit execution capability.");
  }
  const result = await runCheckpointValidation(root, state, capability);
  return { ...result, executed: capability.execution };
};

export const reconcileArtifactDecisions = (state, decisions) => {
  const commandFor = (candidate) =>
    engineCommand(
      "record-decision.mjs",
      "--artifact",
      JSON.stringify(state.source.path),
      "--type",
      state.artifactType,
      "--source-root",
      JSON.stringify(state.source.root),
      "--target-root",
      JSON.stringify(state.target.root),
      "--approve",
      candidate.id,
    );
  const pending = decisions.filter((row) => !row.satisfied);
  const approvable = pending.filter((row) => !row.recorded);
  const citable = pending.filter((row) => row.recorded);
  return {
    approvable,
    citable,
    candidates: approvable.map((row) => ({
      ...(row.candidate ?? artifactDecisionCandidate(state, row)),
      approvable: Boolean(String(row.subject ?? "").trim()),
      blockers: String(row.subject ?? "").trim()
        ? []
        : ["The operator decision has no reviewable subject."],
      command: commandFor(row.candidate ?? artifactDecisionCandidate(state, row)),
    })),
    references: citable.map((row) => ({
      candidateId: (row.candidate ?? artifactDecisionCandidate(state, row)).id,
      subject: (row.candidate ?? artifactDecisionCandidate(state, row)).subject,
      decisionId: row.recorded.id,
      decisionDigest: decisionLineDigest(row.recorded),
    })),
    citations: citable.map((row) => ({ id: row.id, decisionId: row.recorded.id })),
    pendingDecisions: pending.map((row) => ({
      id: row.id,
      subject: row.subject,
      candidateId: (row.candidate ?? artifactDecisionCandidate(state, row)).id,
      recordedDecisionId: row.recorded?.id ?? null,
      command: commandFor(row.candidate ?? artifactDecisionCandidate(state, row)),
    })),
  };
};

const runCheckpointValidation = async (root, state, capability) => {
  try {
    switch (state.currentStep) {
      case "DISCOVER_LEGACY": {
        const result = await validateSourceInventory(root, state);
        const reconciled = reconcileArtifactDecisions(state, result.decisions);
        if (reconciled.approvable.length > 0) {
          return {
            ready: false,
            outcome: "OPERATOR_DECISION",
            reason: `${reconciled.approvable.length} source operator decision(s) require operator approval.`,
            pendingDecisions: reconciled.pendingDecisions,
            decisionReferences: reconciled.references,
            operatorApproval: { cwd: process.cwd(), candidates: reconciled.candidates },
          };
        }
        if (reconciled.citable.length > 0) {
          return {
            ready: false,
            reason: `${reconciled.citable.length} recorded operator decision(s) are not cited in inventories/source.json.`,
            pendingDecisions: reconciled.pendingDecisions,
            decisionReferences: reconciled.references,
            citations: reconciled.citations,
          };
        }
        return { ready: true, result };
      }
      case "DISCOVERY_COMPLETENESS": return { ready: true, result: await validateCompleteness(root, state) };
      case "ASSESS_TARGET": {
        const result = await validateTargetInventory(root, state);
        if (state.designSource === "figma-mcp") {
          await validateFigmaContext(root, strictFigmaState(state));
        }
        return { ready: true, result };
      }
      case "BUILD_BASELINE": {
        const visual = reconcileArtifactDecisions(
          state,
          await artifactVisualDecisions(root, state),
        );
        if (visual.approvable.length > 0) {
          return {
            ready: false,
            outcome: "OPERATOR_DECISION",
            reason: `${visual.approvable.length} visual state(s) require operator approval.`,
            pendingDecisions: visual.pendingDecisions,
            decisionReferences: visual.references,
            operatorApproval: { cwd: process.cwd(), candidates: visual.candidates },
          };
        }
        if (visual.citable.length > 0) {
          return {
            ready: false,
            reason: `${visual.citable.length} recorded visual decision(s) are not cited in ${VISUAL_ACCEPTANCE_FILE}.`,
            pendingDecisions: visual.pendingDecisions,
            decisionReferences: visual.references,
          };
        }
        return { ready: true, result: await validateBaseline(root, state) };
      }
      case "PLAN": return { ready: true, result: await validatePlan(root, state) };
      case "IMPLEMENT_SLICES": return { ready: true, result: await validateImplementation(root, state, capability) };
      case "VERIFY_SLICES": return { ready: true, result: await validateVerification(root, state, capability) };
      case "FINALIZE": return { ready: true, result: await validateFinal(root, state) };
      default: return { ready: false, outcome: "COMPLETE", reason: "Artifact migration is complete." };
    }
  } catch (error) {
    // A contract violation means "author the next artifact" -- CONTINUE. An
    // engine fault means the engine itself could not run, and reporting that as
    // CONTINUE made a crash indistinguishable from pending work, so an
    // automated driver looped on it forever.
    return error?.engineFault
      ? { ready: false, outcome: "BLOCKED", reason: error.message }
      : { ready: false, outcome: "CONTINUE", reason: error.message };
  }
};

const diffEntries = (before, after) => {
  const left = new Map(before.map((entry) => [entry.path, canonical(entry)]));
  const right = new Map(after.map((entry) => [entry.path, canonical(entry)]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key))
    .sort();
};

const implementationCoversDrift = (changedFiles, drift) =>
  drift.every((driftPath) =>
    changedFiles.some(
      (changed) =>
        changed === driftPath ||
        changed.startsWith(`${driftPath}/`) ||
        driftPath.startsWith(`${changed}/`),
    ),
  );

const freshness = async (root, state, validation = null) => {
  const [source, target] = await Promise.all([
    captureBinding(state.source.root, state.bindings.source.paths, "source"),
    captureBinding(state.target.root, state.bindings.target.paths, "target"),
  ]);
  const targetScope = new Set(state.bindings.target.paths);
  const sourceDrift = diffEntries(state.bindings.source.entries, source.entries)
    .filter((file) => !samePath(state.source.root, state.target.root) || !targetScope.has(file));
  const targetDrift = diffEntries(state.bindings.target.entries, target.entries);
  const acceptedTargetDrift =
    state.currentStep === "IMPLEMENT_SLICES" &&
    validation?.ready &&
    implementationCoversDrift(validation.result.changedFiles, targetDrift);
  const stale = sourceDrift.length > 0 || (targetDrift.length > 0 && !acceptedTargetDrift);
  return { stale, source, target, sourceDrift, targetDrift, acceptedTargetDrift };
};

export const progressState = (state, status = state.status) => ({
  formatVersion: state.formatVersion,
  legacyModule: state.artifactId,
  targetModule: state.target.path,
  status,
  currentStep: state.currentStep,
  activeSlice: state.activeSlice,
  completedSteps: state.completedSteps,
  completedSlices: state.completedSlices,
  pendingSlices: state.pendingSlices,
  revision: state.revision,
  nextAction: state.nextAction,
  nextCommand: state.nextCommand,
  artifacts: {
    steps: Object.fromEntries(
      MIGRATION_STEPS.map((step) => [
        step,
        checkpointArtifacts({ ...state, currentStep: step }),
      ]),
    ),
  },
});

const requestFor = (state, reason) => ({
  checkpoint: state.currentStep,
  slice: state.activeSlice,
  artifacts: checkpointArtifacts(state),
  schemaRef: `references/artifact-contract.md#${state.currentStep.toLowerCase().replaceAll("_", "-")}`,
  reason,
});

const outcomeResult = (state, outcome, reason, mode, extra = {}, status = state.status) => {
  if (!MIGRATION_OUTCOMES.includes(outcome)) throw new Error(`Unknown migration outcome '${outcome}'.`);
  const progress = migrationProgress(progressState(state, status), {
    lifecycle: MIGRATION_STEPS,
    mode,
    outcome,
    reason,
  });
  return {
    artifactId: state.artifactId,
    status,
    outcome,
    reason,
    exitCode: exitCodeFor(outcome),
    progress,
    progressChecklist: renderProgress(progress),
    metrics: artifactMetrics(),
    ...extra,
  };
};

const blockedArtifactResult = (state, reason, mode, nextCommand) =>
  outcomeResult(
    { ...state, nextAction: reason, nextCommand: nextCommand === undefined ? state.nextCommand : nextCommand },
    "BLOCKED", reason, mode,
    { nextAction: reason, nextCommand: nextCommand === undefined ? state.nextCommand : nextCommand },
    "BLOCKED",
  );

const locate = ({ targetRoot = process.cwd(), id, source, type = "artifact", sourceRoot } = {}) => {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const artifactId = id ?? artifactIdFor({ source, type, sourceRoot });
  return { targetRoot: resolvedTargetRoot, id: artifactId, root: artifactRoot(resolvedTargetRoot, artifactId) };
};

const assertInvocationMatches = (state, options) => {
  if (options.type && options.type !== state.artifactType) throw new Error("Invocation artifact type conflicts with persisted state.");
  if (options.source !== undefined) {
    const requestedSource = sourcePathForId({ source: options.source, sourceRoot: options.sourceRoot });
    // Fold case on win32 exactly as artifactIdFor does, so a case-variant path
    // to the same physical artifact is a match, not a conflict.
    const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    if (fold(requestedSource) !== fold(state.source.path)) throw new Error("Invocation source path conflicts with persisted state.");
  }
  if (options.sources !== undefined) {
    const requested = [...new Set([
      state.source.path,
      ...arrayOf(options.sources, "sources").map((file) => sourcePathAtRoot(state.source.root, file)),
    ])].sort();
    sameMembers(requested, state.bindings.source.paths, "Invocation source paths");
  }
  if (options.sourceRoot && !samePath(options.sourceRoot, state.source.root)) throw new Error("Invocation sourceRoot conflicts with persisted state.");
  if (options.target && normalizeRelative(options.target, "target") !== state.target.path) throw new Error("Invocation target conflicts with persisted state.");
  if (options.targetRoot && !samePath(options.targetRoot, state.target.root)) throw new Error("Invocation targetRoot conflicts with persisted state.");
  if (options.ponytail !== undefined) {
    assertPonytailTarget(options.ponytail);
    if (options.ponytail !== state.ponytail) throw new Error("Invocation Ponytail target conflicts with persisted state.");
  }
  const designExplicit =
    options.designSource !== undefined ||
    (Array.isArray(options.figma) ? options.figma.length > 0 : options.figma !== undefined);
  if (designExplicit) {
    const requested = resolveDesignSource(options);
    if (
      requested.designSource !== (state.designSource ?? "target-system") ||
      canonical(requested.figmaSources) !== canonical(state.figmaSources ?? [])
    ) {
      throw new Error("Invocation design source conflicts with persisted state.");
    }
  }
};

// Every status path -- recoverable transaction, blocked record, stale drift,
// healthy checkpoint -- reports the same scan/time counters, so "how much work
// did this cost" is answerable without timing the process from outside.
export const getArtifactStatus = async (options = {}) => {
  startMetrics();
  const result = await readArtifactStatus(options);
  return { ...result, metrics: artifactMetrics() };
};

const readArtifactStatus = async (options = {}) => {
  const location = locate(options);
  const transactionFile = path.join(location.root, TRANSACTION_FILE);
  if (await exists(transactionFile)) {
    // A recoverable two-phase transaction reports honestly as ACTIVE and is
    // replayed by the next run; only a torn or invalid one blocks. No write.
    let transaction;
    let replayable = false;
    try {
      transaction = JSON.parse(await readFile(transactionFile, "utf8"));
      await assertTransactionReplayable(location.root, transaction);
      replayable = true;
      if (transaction.state.artifactId !== location.id) {
        throw new Error("Artifact state identity does not match its directory.");
      }
      assertInvocationMatches(transaction.state, options);
      return {
        artifactId: location.id,
        exists: true,
        status: "ACTIVE",
        outcome: "CONTINUE",
        reason: "A pending artifact transaction will be recovered automatically on the next run.",
        exitCode: exitCodeFor("CONTINUE"),
        root: location.root,
      };
    } catch (error) {
      const state = replayable && transaction?.state?.artifactId === location.id
        ? transaction.state
        : await readArtifactState(location.targetRoot, location.id).catch(() => null);
      if (state) {
        return { ...blockedArtifactResult(state, error.message, null, artifactCommandFor(state)), exists: true, root: location.root };
      }
      return {
        artifactId: location.id,
        exists: true,
        status: "BLOCKED",
        outcome: "BLOCKED",
        reason: error.message,
        exitCode: exitCodeFor("BLOCKED"),
        root: location.root,
      };
    }
  }
  if (!(await stateFileExists(location.root))) {
    return { artifactId: location.id, exists: false, status: "NOT_STARTED", outcome: "CONTINUE", root: location.root };
  }
  let state;
  try {
    state = await readArtifactState(location.targetRoot, location.id);
    assertInvocationMatches(state, options);
  } catch (error) {
    if (state) {
      return { ...blockedArtifactResult(state, error.message, null, artifactCommandFor(state)), exists: true, root: location.root };
    }
    return {
      artifactId: location.id,
      exists: true,
      status: "BLOCKED",
      outcome: "BLOCKED",
      reason: error.message,
      exitCode: exitCodeFor("BLOCKED"),
      root: location.root,
    };
  }
  // READ_ONLY: `--status` answers a question nobody asked to run. It never
  // spawns the target's package scripts, compiler binary or `node --check`, and
  // it never loads target-controlled modules (P1 #6). The structural half of
  // every checkpoint still runs, so stale detection and blocking stay exact.
  const validation = state.status === "COMPLETE" ? null : await validateCheckpoint(location.root, state, READ_ONLY_CAPABILITY);
  // An engine fault blocks `run`, so it must block `--status` too.
  if (validation?.outcome === "BLOCKED") {
    return {
      ...outcomeResult(state, "BLOCKED", validation.reason, null, { exists: true, root: location.root, validation }),
      status: "BLOCKED",
    };
  }
  const fresh = await freshness(location.root, state, validation);
  if (fresh.stale) {
    const reason = `Relevant artifact drift detected (source: ${fresh.sourceDrift.join(", ") || "none"}; target: ${fresh.targetDrift.join(", ") || "none"}).`;
    return {
      ...outcomeResult(state, "BLOCKED", reason, null, { exists: true, root: location.root, stale: fresh }, "STALE"),
      status: "STALE",
    };
  }
  if (state.status === "COMPLETE" && state.ponytail) {
    try {
      await validateFinal(location.root, state);
    } catch (error) {
      return { ...blockedArtifactResult(state, error.message, null, artifactCommandFor(state)), exists: true, root: location.root };
    }
  }
  const progress = migrationProgress(progressState(state), {
    lifecycle: MIGRATION_STEPS,
    mode: null,
  });
  return {
    artifactId: state.artifactId,
    exists: true,
    status: state.status,
    outcome: state.status === "COMPLETE" ? "COMPLETE" : "CONTINUE",
    state,
    root: location.root,
    validation,
    progress,
    progressChecklist: renderProgress(progress),
    // Same protocol as a module migration's `formatUpgrade`, and read-only like
    // the rest of this function: projected from the record's own cursor, never
    // committed here. `null` whenever the record is at the runtime format, which
    // today is every record this engine admits.
    formatUpgrade: artifactFormatUpgrade(state),
    // Read-only reporting, never a write: `UNSTAMPED` is what every record
    // created before the standalone toolkit reports, and status says so without
    // stamping anything.
    toolkitIdentity: state.toolkitIdentity ?? null,
    activeToolkitIdentity: activeToolkitIdentity(),
    toolkitIdentityStatus: toolkitIdentityStatus(
      state.toolkitIdentity ?? null,
      activeToolkitIdentity(),
    ),
  };
};

const pinsFor = async (root, state, validation) => {
  const pins = {};
  const add = async (key) => {
    pins[key] = await pinDigest(root, key);
  };
  switch (state.currentStep) {
    case "DISCOVER_LEGACY": await add("inventories/source.json"); break;
    case "DISCOVERY_COMPLETENESS": await add("inventories/completeness.json"); break;
    case "ASSESS_TARGET":
      await add("inventories/target.json");
      if (state.designSource === "figma-mcp") await add(FIGMA_CONTEXT_FILE);
      break;
    case "BUILD_BASELINE":
      for (const relative of Object.values(validation.result.files)) await add(`${relative}#immutable`);
      if (state.designSource === "figma-mcp") await add(VISUAL_ACCEPTANCE_FILE);
      break;
    case "PLAN": await add("slices/index.json"); break;
    case "IMPLEMENT_SLICES": await add(validation.result.relative); break;
    case "VERIFY_SLICES": await add(`${validation.result.relative}#semantic`); break;
    case "FINALIZE": await add("gates.json"); break;
  }
  return pins;
};

const pathsAfterCheckpoint = (state, validation) => {
  const targetPaths = new Set(state.bindings.target.paths);
  if (state.currentStep === "ASSESS_TARGET") {
    for (const file of validation.result.targetFiles) targetPaths.add(file);
    for (const row of validation.result.document.targetNative) targetPaths.add(row.path);
  }
  if (state.currentStep === "BUILD_BASELINE") {
    for (const row of validation.result.global.rows) targetPaths.add(row.targetPath);
  }
  if (state.currentStep === "IMPLEMENT_SLICES") {
    for (const file of validation.result.changedFiles) targetPaths.add(file);
  }
  return [...targetPaths].sort();
};

const nextState = async (root, state, validation, fresh, selectedSlice) => {
  const next = structuredClone(state);
  next.revision += 1;
  next.artifactHashes = { ...state.artifactHashes, ...(await pinsFor(root, state, validation)) };
  next.bindings = {
    source: state.bindings.source,
    target: await captureBinding(state.target.root, pathsAfterCheckpoint(state, validation), "target"),
  };
  const current = state.currentStep;
  if (current === "DISCOVER_LEGACY") next.hasVisibleUi = validation.result.document.hasVisibleUi;
  if (current === "ASSESS_TARGET") next.resolution = validation.result.document.resolution;
  if (current === "PLAN") {
    const ids = validation.result.ids;
    const first = selectedSlice ?? ids[0];
    if (!ids.includes(first)) throw new Error(`Selected slice '${first}' is not in the plan.`);
    const missing = validation.result.document.slices
      .find((slice) => slice.id === first).dependsOn
      .filter((dependency) => !state.completedSlices.includes(dependency));
    if (missing.length > 0) throw new Error(`Slice '${first}' requires completed slices: ${missing.join(", ")}.`);
    next.completedSteps = [...state.completedSteps, current];
    next.currentStep = "IMPLEMENT_SLICES";
    next.activeSlice = first;
    next.pendingSlices = [first, ...ids.filter((id) => id !== first)];
  } else if (current === "IMPLEMENT_SLICES") {
    next.currentStep = "VERIFY_SLICES";
  } else if (current === "VERIFY_SLICES") {
    const remaining = state.pendingSlices.filter((id) => id !== state.activeSlice);
    next.completedSlices = [...state.completedSlices, state.activeSlice];
    next.pendingSlices = remaining;
    if (remaining.length > 0) {
      next.currentStep = "IMPLEMENT_SLICES";
      next.activeSlice = remaining[0];
    } else {
      next.completedSteps = [...state.completedSteps, "IMPLEMENT_SLICES", "VERIFY_SLICES"];
      next.currentStep = "FINALIZE";
      next.activeSlice = null;
    }
  } else if (current === "FINALIZE") {
    next.completedSteps = [...state.completedSteps, current];
    next.currentStep = "COMPLETE";
    next.status = "COMPLETE";
    next.activeSlice = null;
    next.pendingSlices = [];
  } else {
    next.completedSteps = [...state.completedSteps, current];
    next.currentStep = MIGRATION_STEPS[MIGRATION_STEPS.indexOf(current) + 1];
  }
  next.pendingSteps = next.currentStep === "COMPLETE"
    ? []
    : MIGRATION_STEPS.slice(MIGRATION_STEPS.indexOf(next.currentStep));
  next.nextAction = next.currentStep === "COMPLETE"
    ? "Artifact migration is complete."
    : `Author ${checkpointArtifacts(next).join(", ")}.`;
  return next;
};

const previewAdvance = async (root, state, options) => {
  metrics.previewAdvanceCalls += 1;
  if (options.slice && ![state.activeSlice, null].includes(options.slice) && state.currentStep !== "PLAN") {
    return { state, outcome: "BLOCKED", reason: `Slice '${options.slice}' is not active (${state.activeSlice ?? "none"}).` };
  }
  const validation = state.status === "COMPLETE" ? null : await validateCheckpoint(root, state, EXECUTION_CAPABILITY);
  // The mirror of P1 #6: a transition must never be derived from a validation
  // that skipped the executable half.
  if (validation && validation.executed !== true) {
    throw new Error("An artifact transition cannot be derived from a read-only checkpoint validation.");
  }
  if (validation && !validation.ready) return { state, validation, outcome: validation.outcome, reason: validation.reason };
  if (state.currentStep === "PLAN" && options.slice) {
    const selected = validation.result.document.slices.find((slice) => slice.id === options.slice);
    if (selected?.dependsOn.some((dependency) => !state.completedSlices.includes(dependency))) {
      return { state, validation, outcome: "BLOCKED", reason: `Slice '${options.slice}' requires completed slices: ${selected.dependsOn.join(", ")}.` };
    }
  }
  const fresh = await freshness(root, state, validation);
  if (fresh.stale) {
    return {
      state,
      validation,
      fresh,
      outcome: "BLOCKED",
      reason: state.status === "COMPLETE"
        ? "Previously completed output is stale and cannot be accepted as complete."
        : `Relevant artifact drift detected (source: ${fresh.sourceDrift.join(", ") || "none"}; target: ${fresh.targetDrift.join(", ") || "none"}).`,
    };
  }
  if (state.status === "COMPLETE") {
    if (state.ponytail) {
      try {
        await validateFinal(root, state);
      } catch (error) {
        return { state, outcome: "BLOCKED", reason: error.message };
      }
    }
    return { state, outcome: "COMPLETE", reason: "Artifact migration is complete." };
  }
  const snapshot = {
    artifactId: state.artifactId,
    revision: state.revision,
    checkpoint: state.currentStep,
    slice: state.activeSlice,
    selectedSlice: options.slice ?? null,
    stateSha256: sha256(jsonBytes(state)),
    sourceDigest: fresh.source.digest,
    targetDigest: fresh.target.digest,
    artifacts: await Promise.all(checkpointArtifacts(state).map(async (relative) => [relative, await fileHash(path.join(root, relative))])),
  };
  return {
    state,
    validation,
    fresh,
    outcome: "CONTINUE",
    confirmationId: sha256(canonical(snapshot)).slice(0, 16),
  };
};

const runArtifactIteration = async (options = {}) => {
  startMetrics();
  const mode = options.mode ?? "auto";
  // The mode vocabulary has one definition site, in the shared policy module.
  if (!MIGRATION_MODES.includes(mode)) {
    throw new Error(`--mode accepts ${MIGRATION_MODES.map((value) => `'${value}'`).join(" or ")}.`);
  }
  const location = locate(options);
  if (mode === "step" && !(await stateFileExists(location.root))) {
    const preview = await previewArtifact(options);
    if (options.confirmationId !== preview.confirmationId) {
      const synthetic = {
        artifactId: preview.artifactId,
        target: preview.target,
        formatVersion: preview.formatVersion,
        status: "ACTIVE",
        currentStep: "RESOLVE",
        activeSlice: null,
        completedSteps: [],
        completedSlices: [],
        pendingSlices: [],
        revision: 0,
        nextAction: "Confirm standalone artifact bootstrap.",
        nextCommand: artifactCommandFor(preview),
      };
      return outcomeResult(synthetic, "AWAITING_CONFIRMATION", "Bootstrap confirmation is pending; nothing was written.", mode, {
        confirmationId: preview.confirmationId,
        preview,
      });
    }
  }
  return withModuleLock(location.targetRoot, `artifact-${location.id}`, async () => {
    try {
      await recoverTransaction(location.targetRoot, location.root);
    } catch (error) {
      // An unreplayable transaction is a blocked record, and `--status` says so
      // too. Throwing here made the two paths disagree about the same journal.
      const state = await readArtifactState(location.targetRoot, location.id).catch(() => null);
      if (state) return blockedArtifactResult(state, error.message, mode);
      return {
        artifactId: location.id,
        outcome: "BLOCKED",
        reason: error.message,
        exitCode: exitCodeFor("BLOCKED"),
        root: location.root,
      };
    }
    if (!(await stateFileExists(location.root))) {
      const resolved = await resolveArtifact(options);
      const preview = await previewArtifact(options);
      const state = await createArtifactRecord(
        resolved,
        options,
        mode === "auto" ? preview.confirmationId : options.confirmationId,
      );
      return outcomeResult(state, "CONTINUE", null, mode);
    }
    const state = await readArtifactState(location.targetRoot, location.id);
    try {
      assertInvocationMatches(state, options);
      assertArtifactToolkitIdentity(state, location.id, "Advancing this artifact migration");
    } catch (error) {
      if (!error.toolkitIdentity && !error.message.startsWith("Invocation ")) throw error;
      const nextCommand = error.toolkitIdentity
        ? activeToolkitIdentity()
          ? artifactIdentityCommand(state, state.toolkitIdentity ? "update" : "adopt")
          : null
        : artifactCommandFor(state);
      return blockedArtifactResult(state, `${error.message}${nextCommand ? ` Next action: ${nextCommand}` : ""}`, mode, nextCommand);
    }
    const preview = await previewAdvance(location.root, state, options);
    if (preview.outcome === "COMPLETE") return outcomeResult(state, "COMPLETE", preview.reason, mode);
    if (preview.outcome === "OPERATOR_DECISION") {
      return outcomeResult(state, "OPERATOR_DECISION", preview.reason, mode, {
        pendingDecisions: preview.validation.pendingDecisions,
        decisionReferences: preview.validation.decisionReferences,
        operatorApproval: preview.validation.operatorApproval,
      });
    }
    if (preview.outcome === "BLOCKED") return outcomeResult(state, "BLOCKED", preview.reason, mode, {}, preview.fresh?.stale ? "STALE" : state.status);
    if (!preview.validation.ready) {
      return outcomeResult(state, "CONTINUE", preview.reason, mode, {
        request: requestFor(state, preview.reason),
        pendingDecisions: preview.validation.pendingDecisions,
        decisionReferences: preview.validation.decisionReferences,
        citations: preview.validation.citations,
      });
    }
    if (mode === "step" && options.confirmationId !== preview.confirmationId) {
      return outcomeResult(state, "AWAITING_CONFIRMATION", "Checkpoint confirmation is pending; nothing was written.", mode, {
        confirmationId: preview.confirmationId,
        request: requestFor(state, "Checkpoint artifacts validate."),
      });
    }
    if (mode !== "auto" && options.confirmationId !== preview.confirmationId) {
      return outcomeResult(state, "BLOCKED", "Checkpoint confirmation is stale.", mode);
    }
    const transaction = await buildAdvanceTransaction(location.root, state, preview, options.slice);
    const persisted = await writeTransaction(location.targetRoot, location.root, transaction);
    return outcomeResult(
      persisted,
      persisted.status === "COMPLETE" ? "COMPLETE" : "CONTINUE",
      persisted.status === "COMPLETE" ? "Artifact migration reached COMPLETE." : null,
      mode,
    );
  });
};

/**
 * How many times one `runArtifact` call may clear decisions and retry. An upper
 * bound, never a budget: the loop already exits the moment a pass records
 * nothing, and no run can raise decisions at more checkpoints than the record
 * has. Written as the step count so it cannot fall behind a new checkpoint.
 */
const CHECKPOINT_DECISION_PASSES = MIGRATION_STEPS.length;

export const runArtifact = async (
  options = {},
  { recordTrustedDecision } = {},
) => {
  const recorder = recorderFor({ recordTrustedDecision, mode: options.mode });
  const approver = recorder
    ? artifactApprover(recorder, {
        source: options.source,
        type: options.type ?? "artifact",
        sourceRoot: options.sourceRoot,
        targetRoot: options.targetRoot,
      })
    : null;
  // A human answers one act and the iteration ends; `AUTO` keeps going, because
  // clearing the decisions at DISCOVER_LEGACY only to stop at the ones
  // BUILD_BASELINE raises is the same stop one checkpoint later. Bounded by the
  // checkpoints themselves: each pass must record at least one decision or the
  // loop ends, so it can neither spin nor outlive the record's own lifecycle.
  const passes = approver?.channel === "AUTO" ? CHECKPOINT_DECISION_PASSES : 1;
  let result = await runArtifactIteration(options);
  for (let pass = 0; pass < passes; pass += 1) {
    if (result.outcome !== "OPERATOR_DECISION") return result;
    const candidates = result.operatorApproval?.candidates ?? [];
    if (!approver || candidates.length === 0) return result;
    const recorded = await approveWithOperator(candidates, approver, null, []);
    if (recorded.length === 0) return result;
    result = await runArtifactIteration(options);
  }
  return result;
};

// Reads the artifact's authored operator-decision rows with each row's
// reproducible candidate and ledger-backed satisfaction. record-decision.mjs
// --artifact uses this to present and approve child decisions; the engine never
// records one itself (approval lives only in record-decision.mjs).
/** The artifact-side twin of the module gate. Mutation only; never a read. */
const artifactIdentityCommand = (state, mode) => engineCommand(
  "cli/toolkit-identity.mjs", mode,
  "--artifact", quoteCommandToken(state.source.path),
  "--type", state.artifactType,
  "--source-root", quoteCommandToken(state.source.root),
  "--target-root", quoteCommandToken(state.target.root),
);

export const assertArtifactToolkitIdentity = (state, id, action) => {
  const blocker = toolkitIdentityBlocker(state.toolkitIdentity ?? null, activeToolkitIdentity(), {
    action,
    adoptCommand: artifactIdentityCommand(state, "adopt"),
    updateCommand: artifactIdentityCommand(state, "update"),
  });
  if (blocker) throw Object.assign(new Error(blocker), { toolkitIdentity: true });
};

/**
 * Adopt, update or roll back the toolkit identity of one artifact record.
 *
 * Runs the record's own transaction machinery -- journal, atomic state and
 * integrity writes, hash-chained history append -- as a third transaction kind,
 * so an interrupted adoption is recovered by exactly the same `recoverTransaction`
 * path as an interrupted advance, and then stops. It moves no step, slice, pin
 * or binding and writes no decision.
 */
export const changeArtifactToolkitIdentity = async (options = {}) => {
  const mode = options.mode ?? "adopt";
  if (!["adopt", "update", "rollback"].includes(mode)) {
    throw new Error(`Unknown toolkit identity mode '${mode}'.`);
  }
  const active = activeToolkitIdentity();
  if (!active) {
    throw new Error(
      "The running engine is a source checkout with no build-identity.json and has no identity to stamp. Install a released toolkit bundle and run this against that installation. Nothing was written.",
    );
  }
  const location = locate(options);
  return withModuleLock(location.targetRoot, `artifact-${location.id}`, async () => {
    await recoverTransaction(location.targetRoot, location.root);
    // Full read validation: strict state shape, integrity anchor, hash-chained
    // history and its identity replay, plus every pin.
    const state = await readArtifactState(location.targetRoot, location.id);
    const previous = state.toolkitIdentity ?? null;
    if (mode === "adopt" && previous !== null && !sameToolkitIdentity(previous, active)) {
      throw new Error(
        "This artifact record already pins a toolkit identity. Adoption is for an unstamped record; use update. Nothing was written.",
      );
    }
    if (mode !== "adopt" && previous === null) {
      throw new Error(
        "This artifact record carries no toolkit identity, so there is nothing to update or roll back. Adopt one first. Nothing was written.",
      );
    }
    // Idempotent, therefore replayable: rerunning a command that already
    // succeeded is a no-op, not a second history event.
    if (sameToolkitIdentity(previous, active)) {
      return { artifactId: location.id, changed: false, previous, next: active, root: location.root };
    }
    const history = await readHistory(location.root);
    const proposed = {
      ...state,
      toolkitIdentity: active,
      revision: state.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const transaction = {
      version: TRANSACTION_VERSION,
      previousState: state,
      previousIntegrity: integrityFor(state, history.content),
      input: { kind: "TOOLKIT_IDENTITY", previous, next: active },
      state: proposed,
      event: eventFor(history, proposed, {
        event: previous === null ? "TOOLKIT_IDENTITY_ADOPTED" : "TOOLKIT_IDENTITY_CHANGED",
        from: state.currentStep,
        to: state.currentStep,
        slice: state.activeSlice,
        previous,
        next: active,
      }),
    };
    const persisted = await writeTransaction(location.targetRoot, location.root, transaction);
    return { artifactId: location.id, changed: true, previous, next: active, root: location.root, state: persisted };
  });
};

export const artifactOperatorDecisions = async (options = {}) => {
  const location = locate(options);
  const state = await readArtifactState(location.targetRoot, location.id);
  assertInvocationMatches(state, options);
  const source = await validateSourceInventory(location.root, state);
  const visual = await artifactVisualDecisions(location.root, state);
  const decisions = [...source.decisions, ...visual];
  return {
    state,
    root: location.root,
    targetRoot: location.targetRoot,
    id: location.id,
    decisions,
    reconciled: reconcileArtifactDecisions(state, decisions),
  };
};

export const validateArtifactComplete = async (options = {}) => {
  const location = locate(options);
  const state = await readArtifactState(location.targetRoot, location.id);
  assertInvocationMatches(state, options);
  if (state.status !== "COMPLETE" || state.currentStep !== "COMPLETE") {
    throw new Error("Artifact migration state is not COMPLETE.");
  }
  const fresh = await freshness(location.root, state);
  if (fresh.stale) throw new Error("Artifact migration is COMPLETE but its source or target evidence is stale.");
  await validateFinal(location.root, state);
  return {
    valid: true,
    complete: true,
    artifactId: state.artifactId,
    resolution: state.resolution,
    status: state.status,
    statePath: path.join(location.root, STATE_FILE),
  };
};
