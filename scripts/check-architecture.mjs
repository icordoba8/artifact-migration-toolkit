#!/usr/bin/env node
/**
 * The engine's architecture gate (Track A10, docs/architecture/a10-tests.md).
 *
 * One TypeScript AST scan (the engine's pinned `ts-discovery-compiler`, the
 * parser A1-A8 tests already use) over the engine source, the provider trees
 * and the test trees. Every static import, re-export and dynamic `import()` is
 * an edge; a dynamic import is checked like a static one, and one whose target
 * is not a literal is a violation unless its file is named below.
 *
 *   node scripts/check-architecture.mjs [--root <dir>]
 *
 * Exit 0 with a summary, or exit 1 with one line per violation:
 *   [A10-ARCH-n] <file>: <edge or subject>: <what the rule requires>
 *
 * The per-track tests (A1-ARCH .. A8-ARCH) keep the finer rules of each module.
 * This file holds the engine-wide ones, so a new file, edge or writer outside
 * the tables below fails here before it reaches a module's own test.
 */

import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The canonical modules, top to bottom. Downward edges may skip layers. */
export const MODULES = ["transport", "lifecycle", "slices", "visual", "census", "decisions", "store", "formats", "shared"];

/**
 * Every engine file outside a module has an explicit tier, so an unlisted file
 * fails (A10-ARCH-3). Tiers run top to bottom and an edge must go strictly
 * down, except inside one module.
 */
export const TIERS = [
  // Installed executables and the package aggregator (`.` export). Nothing in the engine imports them.
  ["entry", ["core.mjs", "migration-policy.mjs", "operator-signer-service.mjs", "record-decision.mjs", "mcp-server.mjs",
    "artifact/run-artifact.mjs", "upgrades/upgrade-migration.mjs", "cli/advance-migration.mjs", "cli/discover-module.mjs",
    "cli/run-migration.mjs", "cli/toolkit-identity.mjs", "cli/update-migration-registry.mjs", "cli/validate-migration.mjs"]],
  ["transport"],
  // Historical paths over the modules (A1-A8 facades) and the two live files that sit above lifecycle.
  ["compat", ["resumable-migration.mjs", "artifact/artifact-migration.mjs", "decision-recorder.mjs", "operator-approval.mjs",
    "lifecycle-policy.mjs", "module-lock.mjs", "migration-utils.mjs", "upgrades/upgrade-coordinator.mjs", "discovery-scan.mjs",
    "visual-evidence.mjs", "format-upgrade.mjs", "operation-sequence.mjs", "operator-signer-host.mjs"]],
  ["lifecycle"],
  ["slices"],
  ["visual"],
  ["census"],
  // The protected signer's verification core: above decisions, below its host.
  ["signer", ["operator-signer.mjs"]],
  ["decisions"],
  ["store"],
  // The installed-runtime identity reader and the frozen v4 -> v5 upgrader.
  ["identity", ["toolkit-identity.mjs", "upgrades/upgrade-v4-to-v5.mjs"]],
  ["formats"],
  ["shared"],
  // Location-sensitive leaves with no engine import: rendered command paths, and WebAuthn (loaded lazily).
  ["leaf", ["engine-paths.mjs", "operator-webauthn.mjs"]],
];

/**
 * A10-ARCH-2 exception EXC-BIN: an installed executable fronts exactly one
 * transport command file (A7: a bin never loads another command's file) and
 * starts through `transport/entry.mjs`. `null` = entry only.
 */
export const BIN_FRONTS = {
  "cli/discover-module.mjs": "transport/discover.mjs",
  "cli/run-migration.mjs": "transport/run.mjs",
  "cli/advance-migration.mjs": "transport/advance.mjs",
  "cli/validate-migration.mjs": "transport/validate.mjs",
  "cli/update-migration-registry.mjs": "transport/registry.mjs",
  "cli/toolkit-identity.mjs": "transport/toolkit-identity.mjs",
  "artifact/run-artifact.mjs": "transport/artifact.mjs",
  "mcp-server.mjs": "transport/mcp.mjs",
  "upgrades/upgrade-migration.mjs": "transport/upgrade.mjs",
  "record-decision.mjs": null,
  "operator-signer-service.mjs": null,
};

/**
 * A10-ARCH-5: historical and executable paths that declare nothing but these
 * names. Live root files (operation-sequence, operator-signer-host,
 * toolkit-identity, the signer, WebAuthn, engine-paths, the v4 upgrader) are
 * not facades.
 */
export const FACADE_DECLARES = {
  ...Object.fromEntries(Object.keys(BIN_FRONTS).map((file) => [file, []])),
  "core.mjs": [],
  "migration-policy.mjs": [],
  "resumable-migration.mjs": [],
  "artifact/artifact-migration.mjs": [],
  "decision-recorder.mjs": [],
  "operator-approval.mjs": [],
  "lifecycle-policy.mjs": [],
  "module-lock.mjs": [],
  "upgrades/upgrade-coordinator.mjs": [],
  "discovery-scan.mjs": [],
  "visual-evidence.mjs": [],
  "format-upgrade.mjs": [],
  // EXC-DOCTOR: the installed runtime bootstrap imports runDoctor from this path (A7, A8).
  "migration-utils.mjs": ["doctorCheck", "existingKnowledgeRoot", "MINIMUM_NODE_MAJOR", "runDoctor"],
};

/**
 * A10-ARCH-5: names a module exports that another engine file also declares.
 * Each is a different rule under a historical name, kept as found at BASE.
 */
export const SAME_NAME_OTHER_RULE = {
  // The frozen v4 -> v5 upgrader keeps its own private copies of the v4 vocabulary (A1, A2).
  "store/record.mjs#digestArtifactHashes": ["upgrades/upgrade-v4-to-v5.mjs"],
  "formats/artifact.mjs#STATE_FILE": ["upgrades/upgrade-v4-to-v5.mjs"],
  "formats/module.mjs#STEP_FILES": ["upgrades/upgrade-v4-to-v5.mjs"],
  "formats/record.mjs#HISTORY_FILE": ["upgrades/upgrade-v4-to-v5.mjs"],
  "formats/record.mjs#INTEGRITY_FILE": ["upgrades/upgrade-v4-to-v5.mjs"],
  "shared/values.mjs#isPlainObject": ["upgrades/upgrade-v4-to-v5.mjs"],
  // The module checkpoint confirmation (snapshot) vs the format-upgrade confirmation (preview) (A2, A8).
  "formats/upgrade.mjs#confirmationIdFor": ["lifecycle/checkpoints.mjs"],
  // The lifecycle wrappers read the census rule against module or artifact state (A5, A8).
  "census/inventory.mjs#validateLegacyInventory": ["lifecycle/validation.mjs"],
  "census/inventory.mjs#validateTargetInventory": ["lifecycle/artifact-checkpoints.mjs"],
};

/**
 * A10-SRC-1: which files import a filesystem mutation primitive, and which.
 * Exact: a new writer, a new primitive or a stale row fails. `*` = the whole
 * module namespace. Durable writes belong to store/; the rest are the lock,
 * journal, recovery, signer and stdout sites each track documented.
 */
export const FS_WRITERS = {
  // store/: the one replace-write, the one durable append and the one durable removal (DR7, DR8, DR13), staged trees.
  "store/files.mjs": ["mkdir", "open", "rename", "rmdir", "unlink"],
  "store/record.mjs": ["open"],
  "store/tree.mjs": ["cp", "open"],
  // decisions/: the O_RDONLY|O_NOFOLLOW protected-policy read (the ledger append is store's since DR8).
  "decisions/policy.mjs": ["open"],
  // lifecycle/: the module lock; initialization's staged trees, root owner, OpenSpec link and their rollback;
  // the upgrade's staged and rollback trees. Every journal is retired through the store durable removal (DR13).
  "lifecycle/lock.mjs": ["mkdir", "open", "rename", "rm", "rmdir", "unlink"],
  "lifecycle/bootstrap.mjs": ["link", "mkdir", "open", "rm"],
  "lifecycle/initialization.mjs": ["rm"],
  "lifecycle/contract-upgrade.mjs": ["rm"],
  // Synchronous refusal/result bytes to fd 1 before exit, not a file write.
  "lifecycle/recorder.mjs": ["writeSync"],
  "transport/artifact.mjs": ["writeSync"],
  // The protected signer: O_NOFOLLOW reads, the O_EXCL ledger create, the 0600 operator-only file.
  "operator-signer.mjs": ["open"],
  "operator-signer-host.mjs": ["open"],
};

/** A10-TEST-1: test-side files allowed a non-literal `import()` (they load engine paths by computed name to inspect them). */
export const COMPUTED_IMPORT_TESTS = [
  // A2-A8 architecture tests: load every historical path by name to compare bindings and arities.
  "packages/migration-engine/test/unit/census.test.mjs",
  "packages/migration-engine/test/unit/decisions.test.mjs",
  "packages/migration-engine/test/unit/formats.test.mjs",
  "packages/migration-engine/test/unit/lifecycle.test.mjs",
  "packages/migration-engine/test/unit/slices.test.mjs",
  "packages/migration-engine/test/unit/transport.test.mjs",
  "packages/migration-engine/test/unit/visual.test.mjs",
  // Installed, staged-release and bin paths, loaded by computed path from the release or src/ root.
  "packages/migration-engine/test/external/visual-authority-proof.test.mjs",
  "packages/migration-engine/test/integration/artifact/support/history-crash.mjs",
  "packages/migration-engine/test/unit/migration-contract.test.mjs",
  "test/installed-full-lifecycle.test.mjs",
];

/**
 * A10-TEST-1: tests that import a historical facade statically, because the
 * facade is their subject (its exports must stay the canonical bindings).
 * Every other test takes the module entry; installed bins, `core.mjs` (the
 * package `.` export) and live root files stay importable as they are.
 */
export const FACADE_TESTS = {
  // A2-ARCH-4: the historical paths export the formats bindings themselves.
  "packages/migration-engine/test/unit/formats.test.mjs": ["artifact/artifact-migration.mjs", "resumable-migration.mjs"],
  // The artifact engine path's own surface: no approve/record export, no removed constant, its decision API.
  "packages/migration-engine/test/unit/artifact-migration.test.mjs": ["artifact/artifact-migration.mjs"],
  "packages/migration-engine/test/integration/operator-approval-authority.integration.spec.mjs": ["artifact/artifact-migration.mjs"],
};

/** A10-ARCH-6: the only executable files a provider tree may carry. */
const PROVIDER_EXECUTABLE = /^providers\/(install-support\.mjs|(claude|codex|copilot|opencode)\/install\.mjs|(claude|codex|copilot|opencode)\/skills\/(start-migration|migrate-artifact)\/scripts\/runtime\.mjs)$/;

/** A10-SIZE-1: the 1,000-line ceiling, and the files above it at BASE (no growth allowed). */
export const SOURCE_LINE_CEILING = 1000;
export const OVERSIZED_SOURCES = {
  "census/scan.mjs": 2296,
  "decisions/record.mjs": 1642,
  "lifecycle/validation.mjs": 1583,
  "lifecycle/artifact-checkpoints.mjs": 1358,
  "visual/evidence.mjs": 1355,
  "lifecycle/record.mjs": 1058,
  "visual/authority.mjs": 1004,
};

const ENGINE = "packages/migration-engine";
const toPosix = (file) => file.split(path.sep).join("/");
const moduleOf = (file) => (file.includes("/") && MODULES.includes(file.split("/")[0]) ? file.split("/")[0] : null);
const tierOf = (file) => {
  const owner = moduleOf(file);
  return TIERS.findIndex(([name, files]) => (files ? files.includes(file) : name === owner));
};

const listFiles = async (root, directory, pattern) =>
  (await readdir(path.join(root, directory), { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => `${directory}/${toPosix(path.relative(path.join(root, directory), path.join(entry.parentPath, entry.name)))}`)
    .filter((file) => pattern.test(file))
    .sort();

/** Every edge a file names: `{ kind, spec, line }`, `spec` null for a computed `import()`. */
const edgesOf = (ts, file, text) => {
  const kind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const edges = [];
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      edges.push({ kind: ts.isImportDeclaration(node) ? "import" : "export", spec: node.moduleSpecifier.text, line: line(node), node });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      const literal = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
      edges.push({ kind: "dynamic", spec: literal ? argument.text : null, line: line(node), node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sf, edges };
};

const declaredNames = (ts, sf) => sf.statements.flatMap((statement) =>
  (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name ? [statement.name.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []))
      : []);

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const FS_MUTATIONS = new Set([
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream",
  "link", "linkSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync", "rename", "renameSync", "rm", "rmSync",
  "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "unlink", "unlinkSync", "utimes", "writeFile", "writeFileSync",
  "writeSync", "fsync", "fsyncSync",
]);
const fsWritesOf = (ts, sf) => {
  const names = new Set();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !FS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add("*");
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add("*");
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (FS_MUTATIONS.has(imported)) names.add(imported);
      }
    }
  }
  return [...names].sort();
};

const calls = (ts, sf, name) => {
  let count = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
};

/** Tarjan over a file graph; returns every component of more than one file. */
const cycles = (nodes, next) => {
  let index = 0;
  const order = new Map(); const low = new Map(); const stack = []; const open = new Set(); const found = [];
  const visit = (v) => {
    order.set(v, index); low.set(v, index++); stack.push(v); open.add(v);
    for (const w of next(v)) {
      if (!order.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (open.has(w)) low.set(v, Math.min(low.get(v), order.get(w)));
    }
    if (low.get(v) !== order.get(v)) return;
    const component = [];
    let w;
    do { w = stack.pop(); open.delete(w); component.push(w); } while (w !== v);
    if (component.length > 1) found.push(component.sort());
  };
  for (const node of nodes) if (!order.has(node)) visit(node);
  return found;
};

/**
 * Scans `root` and returns `{ violations, stats }`. A violation is
 * `{ rule, file, subject, message }`; `format` renders it as one line.
 */
export const checkArchitecture = async ({ root }) => {
  const ts = createRequire(path.join(root, ENGINE, "package.json"))("ts-discovery-compiler");
  const violations = [];
  const fail = (rule, file, subject, message) => violations.push({ rule, file, subject, message });
  const read = (file) => readFile(path.join(root, file), "utf8");

  // --- engine source ---------------------------------------------------------
  const srcFiles = (await listFiles(root, `${ENGINE}/src`, /\.mjs$/)).map((file) => file.slice(`${ENGINE}/src/`.length));
  const srcSet = new Set(srcFiles);
  const parsed = new Map();
  for (const file of srcFiles) {
    const text = await read(`${ENGINE}/src/${file}`);
    parsed.set(file, { text, ...edgesOf(ts, file, text) });
  }
  const resolve = (file, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));

  // A10-ARCH-1: one public entry per module, which only re-exports its own files.
  for (const name of MODULES) {
    const files = srcFiles.filter((file) => moduleOf(file) === name);
    if (!files.includes(`${name}/index.mjs`)) { fail("A10-ARCH-1", `${name}/`, "index.mjs", "a canonical module needs exactly one public index.mjs"); continue; }
    for (const file of files.filter((file) => file.split("/").length !== 2)) fail("A10-ARCH-1", file, "nested file", "a module is one flat directory behind its index.mjs");
    const { sf } = parsed.get(`${name}/index.mjs`);
    for (const statement of sf.statements) {
      const spec = ts.isExportDeclaration(statement) && statement.moduleSpecifier?.text;
      if (!spec || !/^\.\/[\w-]+\.mjs$/.test(spec) || spec === "./index.mjs" || !srcSet.has(`${name}/${spec.slice(2)}`)) {
        fail("A10-ARCH-1", `${name}/index.mjs`, statement.getText(sf).split("\n")[0], "the entry only re-exports files of its own module");
      }
    }
  }

  // A10-ARCH-3 (tiers): every file has a place.
  for (const file of srcFiles) if (tierOf(file) < 0) fail("A10-ARCH-3", file, "unclassified", "add the file to a module or to TIERS in scripts/check-architecture.mjs");
  for (const file of TIERS.flatMap(([, files]) => files ?? [])) if (!srcSet.has(file)) fail("A10-ARCH-3", file, "TIERS", "a listed file no longer exists; remove its row");
  for (const file of Object.keys(FACADE_DECLARES)) if (!srcSet.has(file)) fail("A10-ARCH-5", file, "FACADE_DECLARES", "a listed facade no longer exists; remove its row");

  const graph = new Map(srcFiles.map((file) => [file, { static: [], all: [] }]));
  for (const [file, { edges }] of parsed) {
    for (const edge of edges) {
      const where = `${file}:${edge.line}`;
      if (edge.spec === null) { fail("A10-ARCH-4", where, `${edge.kind} import(<computed>)`, "an engine import must name its target literally"); continue; }
      if (!edge.spec.startsWith(".")) continue;
      const target = resolve(file, edge.spec);
      if (!srcSet.has(target)) {
        if (target.startsWith("../")) fail("A10-ARCH-2", where, `${edge.kind} ${edge.spec}`, "engine source imports only engine source and packages");
        else fail("A10-ARCH-2", where, `${edge.kind} ${edge.spec}`, "the target does not exist");
        continue;
      }
      graph.get(file).all.push(target);
      if (edge.kind !== "dynamic") graph.get(file).static.push(target);
      const from = moduleOf(file); const to = moduleOf(target);
      // A10-ARCH-2: outside a module, only its index.mjs.
      if (to && from !== to && target !== `${to}/index.mjs`) {
        const fronted = Object.hasOwn(BIN_FRONTS, file) && (target === "transport/entry.mjs" || target === BIN_FRONTS[file]);
        if (!fronted) fail("A10-ARCH-2", where, `${edge.kind} -> ${target}`, `outside ${to}/, import ${to}/index.mjs`);
      }
      // A10-ARCH-3: strictly downward between tiers.
      if (from && from === to) continue;
      const a = tierOf(file); const b = tierOf(target);
      if (a >= 0 && b >= 0 && b <= a) {
        fail("A10-ARCH-3", where, `${edge.kind} -> ${target}`, `${TIERS[a][0]} may not depend on ${TIERS[b][0]} (${b === a ? "same tier" : "upward"})`);
      }
    }
  }

  // A10-ARCH-4: no static or lazy file cycle.
  for (const kind of ["static", "all"]) {
    for (const component of cycles(srcFiles, (file) => graph.get(file)[kind])) {
      fail("A10-ARCH-4", component[0], `${kind === "all" ? "lazy" : "static"} cycle ${component.join(" -> ")}`, "break the cycle by moving the shared rule down");
    }
  }

  // A10-ARCH-5: facades declare nothing of their own; a module export has one live definition.
  const declarations = new Map();
  for (const [file, { sf }] of parsed) for (const name of declaredNames(ts, sf)) declarations.set(name, [...(declarations.get(name) ?? []), file]);
  for (const [file, allowed] of Object.entries(FACADE_DECLARES)) {
    if (!parsed.has(file)) continue;
    const extra = declaredNames(ts, parsed.get(file).sf).filter((name) => !allowed.includes(name));
    if (extra.length) fail("A10-ARCH-5", file, `declares ${extra.join(", ")}`, "a facade re-exports the canonical binding; it declares nothing");
  }
  const sameName = new Map();
  for (const name of MODULES) {
    const { sf } = parsed.get(`${name}/index.mjs`) ?? {};
    for (const statement of sf?.statements ?? []) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !statement.moduleSpecifier) continue;
      const owner = resolve(`${name}/index.mjs`, statement.moduleSpecifier.text);
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        // A re-exported name is checked at the module that declares it.
        if (!(declarations.get(local) ?? []).includes(owner)) continue;
        const others = (declarations.get(local) ?? []).filter((file) => file !== owner && moduleOf(file) !== name).sort();
        if (others.length) sameName.set(`${owner}#${local}`, others);
      }
    }
  }
  for (const [key, others] of sameName) {
    if (JSON.stringify(SAME_NAME_OTHER_RULE[key]) !== JSON.stringify(others)) {
      fail("A10-ARCH-5", key.split("#")[0], `${key.split("#")[1]} also declared in ${others.join(", ")}`, "one live definition per module export (or a named SAME_NAME_OTHER_RULE row)");
    }
  }
  for (const key of Object.keys(SAME_NAME_OTHER_RULE)) if (!sameName.has(key)) fail("A10-ARCH-5", key, "SAME_NAME_OTHER_RULE", "stale exception; remove the row");

  // A10-SRC-1: filesystem mutation primitives, per file, exactly as pinned.
  for (const [file, { sf }] of parsed) {
    const found = fsWritesOf(ts, sf);
    const pinned = FS_WRITERS[file] ?? [];
    if (JSON.stringify(found) !== JSON.stringify(pinned)) {
      fail("A10-SRC-1", file, `fs ${found.join(", ") || "(none)"}`, `pinned ${pinned.join(", ") || "(none)"}; durable writes go through store/, or justify a new row`);
    }
  }
  for (const file of Object.keys(FS_WRITERS)) if (!srcSet.has(file)) fail("A10-SRC-1", file, "FS_WRITERS", "stale row; remove it");

  // A10-SRC-2: one process-entry check, and only installed executables start a command.
  for (const [file, { sf }] of parsed) {
    if (file !== "transport/entry.mjs" && calls(ts, sf, "isMainModule") > 0) fail("A10-SRC-2", file, "isMainModule()", "only transport/entry.mjs decides whether a file is the process entry");
    const starts = calls(ts, sf, "startCommand");
    if (Object.hasOwn(BIN_FRONTS, file) ? starts !== 1 : starts !== 0) fail("A10-SRC-2", file, `startCommand() x${starts}`, "exactly the installed executables call startCommand, once each");
  }
  const bins = JSON.parse(await read(`${ENGINE}/package.json`)).bin;
  for (const target of Object.values(bins)) {
    const file = target.replace(/^src\//, "");
    if (!Object.hasOwn(BIN_FRONTS, file)) fail("A10-ARCH-2", file, "package.json bin", "every installed bin is a BIN_FRONTS facade");
  }

  // A10-SIZE-1: no source file grows past its pinned size, and no new one passes the ceiling.
  for (const [file, { text }] of parsed) {
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const limit = OVERSIZED_SOURCES[file] ?? SOURCE_LINE_CEILING;
    if (lines > limit) fail("A10-SIZE-1", file, `${lines} lines`, `limit ${limit}; split by ownership in a reviewed change, do not raise the pin`);
  }
  for (const file of Object.keys(OVERSIZED_SOURCES)) if (!srcSet.has(file)) fail("A10-SIZE-1", file, "OVERSIZED_SOURCES", "stale row; remove it");

  // --- provider trees --------------------------------------------------------
  // A10-ARCH-6: no engine implementation in a provider tree.
  const bootstrap = await read("scripts/runtime-bootstrap.mjs");
  const engineBytes = new Set([...parsed.values()].map(({ text }) => text));
  const providerFiles = await listFiles(root, "providers", /./);
  for (const file of providerFiles) {
    if (/\/(packages|migration-engine|node_modules)\//.test(file)) fail("A10-ARCH-6", file, "path", "a provider tree carries no engine package");
    if (!/\.(mjs|cjs|js|ts|mts|cts)$/.test(file)) continue;
    if (!PROVIDER_EXECUTABLE.test(file)) { fail("A10-ARCH-6", file, "executable", "only install.mjs, install-support.mjs and the runtime.mjs bootstrap copies"); continue; }
    const text = await read(file);
    if (engineBytes.has(text)) fail("A10-ARCH-6", file, "bytes", "a provider file is a copy of an engine source file");
    if (file.endsWith("/runtime.mjs")) {
      if (text !== bootstrap) fail("A10-ARCH-6", file, "bytes", "runtime.mjs is a byte copy of scripts/runtime-bootstrap.mjs");
      continue; // Its imports are the bootstrap's, checked once below.
    }
    for (const edge of edgesOf(ts, file, text).edges) {
      const target = edge.spec && edge.spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), edge.spec)) : null;
      if (edge.spec?.startsWith("node:") || target === "providers/install-support.mjs") continue;
      fail("A10-ARCH-6", `${file}:${edge.line}`, `${edge.kind} ${edge.spec ?? "import(<computed>)"}`, "an installer imports only node: builtins and install-support.mjs");
    }
  }
  // The bootstrap reaches the engine only inside the verified release, at run time.
  for (const edge of edgesOf(ts, "scripts/runtime-bootstrap.mjs", bootstrap).edges) {
    if (edge.spec?.startsWith("node:")) continue;
    if (edge.kind === "dynamic" && edge.spec === null) continue; // EXC-BOOTSTRAP: runDoctor from the verified release root.
    fail("A10-ARCH-6", `scripts/runtime-bootstrap.mjs:${edge.line}`, `${edge.kind} ${edge.spec}`, "the bootstrap imports only node: builtins and, at run time, the verified release");
  }

  // --- tests -----------------------------------------------------------------
  // A10-TEST-1: tests reach the engine through a module's index.mjs or a non-module (historical, executable or live root) path.
  const testFiles = [
    ...(await listFiles(root, `${ENGINE}/test`, /\.(mjs|ts)$/)).filter((file) => !file.includes("/fixtures/")),
    ...(await listFiles(root, "test", /\.mjs$/)),
  ];
  const HISTORICAL = new Set(Object.keys(FACADE_DECLARES).filter((file) => file !== "core.mjs" && !Object.hasOwn(BIN_FRONTS, file)));
  for (const file of testFiles) {
    for (const edge of edgesOf(ts, file, await read(file)).edges) {
      const where = `${file}:${edge.line}`;
      if (edge.spec === null) {
        if (!COMPUTED_IMPORT_TESTS.includes(file)) fail("A10-TEST-1", where, `${edge.kind} import(<computed>)`, "a computed import is allowed only in a COMPUTED_IMPORT_TESTS file");
        continue;
      }
      if (!edge.spec.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), edge.spec));
      if (!target.startsWith(`${ENGINE}/src/`)) continue;
      const inside = target.slice(`${ENGINE}/src/`.length);
      const owner = moduleOf(inside);
      if (owner && inside !== `${owner}/index.mjs`) fail("A10-TEST-1", where, `${edge.kind} -> ${inside}`, `a test imports ${owner}/index.mjs, not a module internal`);
      if (HISTORICAL.has(inside) && !(FACADE_TESTS[file] ?? []).includes(inside)) fail("A10-TEST-1", where, `${edge.kind} -> ${inside}`, "a test imports the canonical module entry; only FACADE_TESTS test the facade itself");
    }
  }
  for (const file of Object.keys(FACADE_TESTS)) if (!testFiles.includes(file)) fail("A10-TEST-1", file, "FACADE_TESTS", "stale row; remove it");
  for (const file of COMPUTED_IMPORT_TESTS) if (!testFiles.includes(file)) fail("A10-TEST-1", file, "COMPUTED_IMPORT_TESTS", "stale row; remove it");

  // A10-TEST-2: registration. Every suite runs exactly once, in its runner; no support file runs as a suite.
  const scripts = JSON.parse(await read("package.json")).scripts;
  const listed = (name) => (scripts[name] ?? "").split(/\s+/).filter((token) => /\.(mjs|ts)$/.test(token));
  const engineListed = listed("engine:test").filter((file) => file !== "scripts/engine-test.mjs");
  const engineSuites = testFiles.filter((file) => file.startsWith(`${ENGINE}/test/`) && /\.(test|spec)\.mjs$/.test(file));
  for (const file of engineSuites) if (!engineListed.includes(file)) fail("A10-TEST-2", file, "engine:test", "an engine suite is registered in package.json engine:test");
  for (const file of engineListed) {
    if (!engineSuites.includes(file)) fail("A10-TEST-2", file, "engine:test", "only existing *.test.mjs / *.spec.mjs suites are registered (no support or fixture file)");
    if (engineListed.indexOf(file) !== engineListed.lastIndexOf(file)) fail("A10-TEST-2", file, "engine:test", "registered twice");
  }
  if (!/^node scripts\/engine-test\.mjs /.test(scripts["engine:test"] ?? "")) fail("A10-TEST-2", "package.json", "engine:test", "the engine suites run through scripts/engine-test.mjs (two identity passes)");
  const runner = await read("scripts/engine-test.mjs");
  const unidentified = [...runner.matchAll(/^\s+"(test\/(?:unit|external|integration)\/[\w./-]+)",$/gm)].map((match) => `${ENGINE}/${match[1]}`);
  if (unidentified.length === 0) fail("A10-TEST-2", "scripts/engine-test.mjs", "UNIDENTIFIED_SUITES", "the unidentified pass names its suites, one quoted path per line");
  for (const suite of unidentified) {
    if (!engineListed.includes(suite)) fail("A10-TEST-2", suite, "UNIDENTIFIED_SUITES", "an unidentified-pass suite must be registered");
  }
  const vitest = await read("vitest.config.ts");
  for (const file of testFiles.filter((file) => file.endsWith(".spec.ts"))) {
    if (!file.startsWith(`${ENGINE}/test/`) || !vitest.includes('"packages/migration-engine/test/**/*.spec.ts"')) fail("A10-TEST-2", file, "vitest", "TypeScript specs run under engine:test:ts");
  }
  const providerListed = listed("providers:test");
  for (const file of testFiles.filter((file) => file.startsWith("test/") && file.endsWith(".test.mjs"))) {
    if (!providerListed.includes(file)) fail("A10-TEST-2", file, "providers:test", "a root suite is registered in providers:test");
  }
  for (const file of providerListed) if (!testFiles.includes(file)) fail("A10-TEST-2", file, "providers:test", "the registered suite does not exist");

  // A10-OWN-1: OWNERSHIP.md has one owner per guarantee, and every adversarial test it or the A10 matrix names exists and runs.
  const registered = new Set([...engineListed, ...providerListed, ...testFiles.filter((file) => file.endsWith(".spec.ts"))]);
  const ownership = await read("OWNERSHIP.md").catch(() => null);
  if (ownership === null) fail("A10-OWN-1", "OWNERSHIP.md", "missing", "the ownership register is required");
  const seen = new Set();
  for (const row of (ownership ?? "").split("\n").filter((line) => /^\| G\d+ \|/.test(line))) {
    const [id, guarantee, owner, , attack] = row.split(" | ").map((cell) => cell.replace(/^\| /, "").trim());
    for (const key of [id, guarantee]) {
      if (seen.has(key)) fail("A10-OWN-1", "OWNERSHIP.md", key, "a guarantee has exactly one row");
      seen.add(key);
    }
    const named = /^`([^`]+)`/.exec(owner ?? "")?.[1];
    const exists = named && (MODULES.includes(named.replace(/\/$/, "")) ? named.endsWith("/") : srcSet.has(named) || named === "providers/install-support.mjs");
    if (!exists) fail("A10-OWN-1", "OWNERSHIP.md", `${id} owner ${owner}`, "the owner is one module directory or one existing engine file");
    if (!/` › "/.test(attack ?? "")) fail("A10-OWN-1", "OWNERSHIP.md", `${id} adversarial test`, "every guarantee names a test that attacks it");
  }
  if (ownership !== null && seen.size === 0) fail("A10-OWN-1", "OWNERSHIP.md", "guarantees", "no guarantee rows found");
  for (const document of ["OWNERSHIP.md", "docs/architecture/a10-tests.md"]) {
    const text = await read(document).catch(() => "");
    for (const [, file, title] of text.matchAll(/`((?:packages|test)\/[^`]+\.(?:mjs|ts))` › "([^"]+)"/g)) {
      const source = await read(file).catch(() => null);
      if (source === null) fail("A10-OWN-1", document, file, "the named test file does not exist");
      else if (!registered.has(file)) fail("A10-OWN-1", document, file, "the named test file is not registered in a runner");
      else if (![`"${title}"`, `'${title}'`, `\`${title}\``].some((quoted) => source.includes(quoted))) fail("A10-OWN-1", document, `${file} › "${title}"`, "no test with this exact title");
    }
  }

  return {
    violations,
    stats: { sourceFiles: srcFiles.length, edges: [...graph.values()].reduce((n, { all }) => n + all.length, 0), providerFiles: providerFiles.length, testFiles: testFiles.length },
  };
};

export const format = ({ rule, file, subject, message }) => `[${rule}] ${file}: ${subject}: ${message}`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--root");
  const root = at > 0 ? path.resolve(process.argv[at + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { violations, stats } = await checkArchitecture({ root });
  if (violations.length) {
    for (const violation of violations) console.error(format(violation));
    console.error(`architecture: ${violations.length} violation(s).`);
    process.exitCode = 1;
  } else {
    console.log(`architecture: ok (${stats.sourceFiles} engine files, ${stats.edges} edges, ${stats.providerFiles} provider files, ${stats.testFiles} test files).`);
  }
}
