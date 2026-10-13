// Track A5: the census/ boundary (docs/architecture/a5-ownership.md).
// The behavior itself is covered where it always was: discovery-scan.test.mjs,
// migration-contract.test.mjs, evidence-provenance.test.mjs and
// artifact-migration.test.mjs. This file pins the module boundary, the scanner's
// loading and versions, and the seams A5 introduced.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import * as census from "../../src/census/index.mjs";
import * as decisions from "../../src/decisions/index.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const ts = createRequire(import.meta.url)("ts-discovery-compiler");

const engineFiles = async () =>
  (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".mjs")).map((file) => file.split(path.sep).join("/"));
const parse = async (file) =>
  ts.createSourceFile(file, await readFile(path.join(src, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declared = (sf) => sf.statements.flatMap((statement) =>
  ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? [statement.name.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((d) => d.name.getText(sf)) : []);
/** Every module specifier a file names: static, re-export and dynamic import. */
const specifiers = (sf) => {
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) found.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

// -- architecture --------------------------------------------------------------

test("A5-ARCH-1: census/ has exactly one public entry, and it only re-exports its own files", async () => {
  const files = (await engineFiles()).filter((file) => file.startsWith("census/"));
  assert.ok(files.includes("census/index.mjs"));
  for (const statement of (await parse("census/index.mjs")).statements) {
    assert.ok(ts.isExportDeclaration(statement) && statement.moduleSpecifier, "census/index.mjs only re-exports");
    assert.match(statement.moduleSpecifier.text, /^\.\/\w+\.mjs$/);
  }
  // Reaching past the entry is A1-ARCH-1 (store-shared.test.mjs).
});

test("A5-ARCH-2: engine code takes census-owned names from census/index.mjs, never through a compatibility path", async () => {
  const offenders = [];
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("census/"))) {
    const sf = await parse(file);
    // The scanner's old path is a facade for external callers only.
    for (const spec of specifiers(sf)) {
      if (path.resolve(src, path.dirname(file), spec) === path.join(src, "discovery-scan.mjs")) offenders.push(`${file}: ${spec}`);
    }
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(src, path.dirname(file), spec);
      if (target === path.join(src, "census/index.mjs")) continue;
      const module = await import(pathToFileURL(target).href);
      for (const element of statement.importClause.namedBindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (Object.hasOwn(census, name) && module[name] === census[name]) offenders.push(`${file}: ${name} from ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// Nothing below census/ may import it, and census/ imports only the decisions,
// store, formats and shared entries and the leaf engine-paths.mjs (A1-ARCH-2).
// With an acyclic inside it cannot sit on any engine import cycle.
test("A5-ARCH-3: census/ adds no import cycle: its files import each other acyclically", async () => {
  const files = (await engineFiles()).filter((file) => file.startsWith("census/"));
  const edges = new Map();
  for (const file of files) {
    edges.set(file, specifiers(await parse(file))
      .map((spec) => path.posix.join(path.posix.dirname(file), spec))
      .filter((target) => target.startsWith("census/")));
  }
  const state = new Map();
  const visit = (file, trail) => {
    assert.notEqual(state.get(file), "open", `import cycle: ${[...trail, file].join(" -> ")}`);
    if (state.get(file) === "done") return;
    state.set(file, "open");
    for (const next of edges.get(file) ?? []) visit(next, [...trail, file]);
    state.set(file, "done");
  };
  for (const file of files) visit(file, []);
});

// The declarations A5 moved, by their old home. The scanner moved as a whole
// file; its old path now declares nothing.
const MOVED = {
  "resumable-migration.mjs": [
    "legacySourcesOf", "isBrownfield", "TARGET_STATES", "UI_KINDS", "UI_MISMATCH_DISPOSITIONS", "UI_INTERACTIVE_KINDS",
    "UI_CONDITIONAL_KINDS", "UI_RUNTIME_STATES", "assertLegacySourcesUnchanged", "EVIDENCE_CATEGORIES", "EVIDENCE_KINDS",
    "EVIDENCE_STATUSES", "assertOpenSpecIds", "assertEvidenceChecklist", "assertLegacyDiscoveryChecklist",
    "assertTargetAssessmentChecklist", "CLASSIFICATION_SCOPES", "DISPOSITIONS", "DECISION_BACKED_DISPOSITIONS",
    "AGENT_DISMISSIBLE", "legacySourceBinding", "moduleDecisionCandidate", "moduleEdgeTargetsFrom",
    "assertRecordedScannerVersion", "readCanonicalModuleBoundary", "moduleRootPath", "moduleRootSource",
    "assertSourcedModuleRoots", "sourceOfEvidence", "assertLegacyEvidenceWithinBoundary", "validateDiscoveryCompleteness",
    "assertAdoptedTargetEvidence", "validateTargetInventory", "featureLocalPrefix", "isUnderFeature",
    "assertLegacyEvidenceAttributes", "assertDiscoveryUnchanged", "targetFeatureDirectory", "brownfieldTargetBlocker",
  ],
  "migration-utils.mjs": ["resolveLegacySources"],
  "artifact/artifact-migration.mjs": [
    "COMPLETENESS_DISPOSITIONS", "EXTERNAL_ELEMENT", "CODE_FILE_EXTENSIONS", "hasExecutableCodeFiles", "commandFile",
    "TARGET_COMPILER_SPECIFIERS", "resolveCompilerBinary", "metrics", "STRUCTURAL_SCRIPT_EXTENSIONS", "moduleSpecifiersIn",
    "targetCodeFiles", "TEST_UNDER_SRC", "FEATURE_INDEX", "UI_TEXT_PROPS", "hardcodedUiText", "PROVIDER_PATHS",
    "bindingInput", "sourcePathForId", "artifactIdFor", "assertDirectory", "isExcluded", "scopedManifest", "captureBinding",
    "sourcePathAtRoot", "targetPathsFor", "resolveArtifact", "validateEvidenceFile", "validateSourceEvidenceFile",
    "dispositionValidator", "packageNameOf", "SCANNER_REQUIREMENT_KEYS", "versionOne",
  ],
};

test("A5-ARCH-4: every census declaration has exactly one live definition, and no moved declaration survives at its old site", async () => {
  const files = await engineFiles();
  const owned = new Set();
  for (const file of files.filter((file) => file.startsWith("census/"))) {
    for (const name of declared(await parse(file))) {
      assert.ok(!owned.has(name), `${name} is declared twice inside census/`);
      owned.add(name);
    }
  }
  // Exported census names are declared nowhere else. (Unexported scanner
  // helpers may share a name with an unrelated local elsewhere.)
  // Same name, kept outside on purpose: the module engine's three-argument
  // legacy inventory seam, and the artifact engine's own target inventory
  // validator (a different record, a lifecycle checkpoint validator). Both
  // moved from the monoliths into lifecycle/ in Track A8.
  const seams = { "lifecycle/validation.mjs": ["validateLegacyInventory"], "lifecycle/artifact-checkpoints.mjs": ["validateTargetInventory"] };
  for (const file of files.filter((file) => !file.startsWith("census/"))) {
    assert.deepEqual(declared(await parse(file)).filter((name) => Object.hasOwn(census, name)), seams[file] ?? [], file);
  }
  // Track A8: the monoliths moved into lifecycle/ (the artifact engine's
  // parser-bound census into census/toolchain.mjs); the old-site rule follows them.
  const lifecycleFiles = (await readdir(path.join(src, "lifecycle"))).filter((file) => file !== "index.mjs");
  assert.ok(lifecycleFiles.length > 20);
  const follow = Object.fromEntries(lifecycleFiles.map((file) => [`lifecycle/${file}`,
    MOVED[file.startsWith("artifact-") ? "artifact/artifact-migration.mjs" : "resumable-migration.mjs"] ?? []]));
  for (const [file, moved] of Object.entries({ ...MOVED, ...follow })) {
    const live = new Set(declared(await parse(file)));
    assert.deepEqual(moved.filter((name) => live.has(name)), [], file);
    for (const name of moved) assert.ok(owned.has(name) || name === "versionOne", `${name} has no new home`);
  }
  assert.deepEqual(declared(await parse("discovery-scan.mjs")), []);
  // The one seam that keeps a census name: the three-argument legacy inventory
  // reader, which hands census the visual observation rule.
  const lifecycle = await import(pathToFileURL(path.join(src, "resumable-migration.mjs")).href);
  assert.equal(Object.hasOwn(lifecycle, "validateLegacyInventory"), false);
  assert.equal(census.validateLegacyInventory.length, 4);
});

// Every module that exported a census-owned name at BASE still does, as the
// census binding itself rather than a copy.
const COMPAT = {
  "core.mjs": ["isBrownfield", "legacySourceBinding", "parserResolutionError", "readCanonicalModuleBoundary", "resolveLegacySources", "runDiscoveryScan", "sourceOfEvidence", "structuralUnits", "UI_RUNTIME_STATES", "validateDiscoveryCompleteness"],
  "resumable-migration.mjs": ["isBrownfield", "legacySourceBinding", "legacySourcesOf", "readCanonicalModuleBoundary", "sourceOfEvidence", "UI_RUNTIME_STATES", "validateDiscoveryCompleteness"],
  "artifact/artifact-migration.mjs": ["artifactIdFor", "hasExecutableCodeFiles", "resolveArtifact", "structuralUnits"],
  "migration-utils.mjs": ["resolveLegacySources"],
  "discovery-scan.mjs": [
    "CENSUS_ALGORITHM_VERSION", "CENSUS_COMMAND", "discoveryDigest", "DiscoveryScannerVersionError", "kindOf", "loadTypeScript",
    "parserResolutionError", "PROBE_EXTENSIONS", "PRODUCTION_REACHABILITY", "REACHABILITY_VALUES", "runDiscoveryScan",
    "structuralUnits", "SUPPORTED_ALGORITHM_VERSIONS", "VISUAL_KINDS",
  ],
};

test("A5-ARCH-5: historical compatibility exports remain, as the census binding itself", async () => {
  for (const [file, names] of Object.entries(COMPAT)) {
    const module = await import(pathToFileURL(path.join(src, file)).href);
    for (const name of names) assert.equal(module[name], census[name], `${file} ${name}`);
  }
  // The scanner's public path exports exactly what it did before it moved.
  const facade = await import(pathToFileURL(path.join(src, "discovery-scan.mjs")).href);
  assert.deepEqual(Object.keys(facade).sort(), [...COMPAT["discovery-scan.mjs"]].sort());
});

const execFileAsync = promisify(execFile);

test("A5-ARCH-6: the scanner's versions are pinned, and its parser loads lazily from the scanner's installed path", async () => {
  assert.equal(census.CENSUS_ALGORITHM_VERSION, 3);
  assert.deepEqual([...census.SUPPORTED_ALGORITHM_VERSIONS], [1, 2, 3]);
  // A fresh process: importing the census entry and every engine module that
  // re-exports it loads no compiler; the first parse does, and from the same
  // place the scanner always resolved it (src/discovery-scan.mjs).
  const probe = `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const expected = createRequire(new URL("discovery-scan.mjs", ${JSON.stringify(pathToFileURL(src).href)})).resolve("ts-discovery-compiler");
    const loaded = () => Object.hasOwn(require.cache, expected);
    for (const file of ["census/index.mjs", "discovery-scan.mjs", "core.mjs", "resumable-migration.mjs", "artifact/artifact-migration.mjs", "migration-utils.mjs", "record-decision.mjs"]) {
      await import(new URL(file, ${JSON.stringify(pathToFileURL(src).href)}).href);
    }
    const before = loaded();
    const census = await import(new URL("census/index.mjs", ${JSON.stringify(pathToFileURL(src).href)}).href);
    const compiler = census.loadTypeScript();
    console.log(JSON.stringify({ before, after: loaded(), version: compiler.version }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe], { cwd: os.tmpdir() });
  const result = JSON.parse(stdout);
  assert.equal(result.before, false);
  assert.equal(result.after, true);
  assert.equal(result.version, ts.version);
});

// What census imports from decisions: it builds and checks candidates and
// reads the ledger, but nothing it imports records, approves or rejects.
const CENSUS_DECISIONS_IMPORTS = [
  "assertDirectLedgerClassificationSchema", "createDecisionCandidate", "createNewFormatDecisionCandidate",
  "edgeDecisionSubject", "readRecordedDecisions", "requireModuleDecision",
];
const FS_WRITES = new Set([
  "appendFile", "chmod", "chown", "copyFile", "cp", "createWriteStream", "link", "mkdir",
  "mkdtemp", "open", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
]);

test("A5-ARCH-7: census never grants approval or writes: it reaches decisions only to build, read and require", async () => {
  const fromDecisions = new Set();
  for (const file of (await engineFiles()).filter((file) => file.startsWith("census/"))) {
    for (const statement of (await parse(file)).statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
      const spec = statement.moduleSpecifier.text;
      const names = ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.map((element) => (element.propertyName ?? element.name).text)
        : ["*"];
      if (spec === "../decisions/index.mjs") names.forEach((name) => fromDecisions.add(name));
      if (/^node:fs(\/promises)?$/.test(spec)) assert.deepEqual(names.filter((name) => FS_WRITES.has(name) || name === "*"), [], `${file} imports a write from ${spec}`);
      if (spec === "../store/index.mjs") {
        assert.deepEqual(names.filter((name) => /write|append|persist|journal|remove|seal/i.test(name)), [], `${file} imports a store write`);
      }
    }
  }
  assert.deepEqual([...fromDecisions].sort(), CENSUS_DECISIONS_IMPORTS);
  for (const name of CENSUS_DECISIONS_IMPORTS) assert.equal(typeof decisions[name], "function");
});

// -- seams ---------------------------------------------------------------------

test("A5: the legacy inventory rules apply the injected observation rule once per UI behavior, in order, only from format 18", async (t) => {
  const legacyRoot = await mkdtemp(path.join(os.tmpdir(), "amt-census-"));
  t.after(() => rm(legacyRoot, { recursive: true, force: true }));
  const root = path.join(legacyRoot, "migration");
  await mkdir(path.join(root, "inventories"), { recursive: true });
  await writeFile(path.join(legacyRoot, "page.tsx"), "export default () => null;\n");
  const ui = (id) => ({
    id, behaviorId: "B1", kind: "TABLE_LIST", description: "rows", configuration: { columns: 2 },
    runtimeStates: ["DEFAULT"], evidence: ["page.tsx"], requirementIds: ["R1"], scenarioIds: ["S1"],
  });
  await writeFile(path.join(root, "inventories/legacy.json"), JSON.stringify({
    behaviors: [{ id: "B1", description: "lists", evidence: ["page.tsx"] }],
    routeFlows: [], explicitNoRouteFlows: true, hasVisibleUi: true, uiBehaviors: [ui("U1"), ui("U2")],
  }));
  const roots = { legacyRoot, targetRoot: legacyRoot };
  const run = async (formatVersion) => {
    const seen = [];
    const state = { formatVersion, requirementsAuthority: { requirementIds: ["R1"], scenarioIds: ["S1"] } };
    const inventory = await census.validateLegacyInventory(root, roots, state, {
      assertRequiredObservations: (item, observationIds) => seen.push([item.id, observationIds instanceof Set]),
    });
    return { seen, inventory };
  };
  assert.deepEqual((await run(18)).seen, [["U1", true], ["U2", true]]);
  assert.deepEqual((await run(17)).seen, []);
  // A refusal from the injected rule surfaces unchanged.
  const state = { formatVersion: 19, requirementsAuthority: { requirementIds: ["R1"], scenarioIds: ["S1"] } };
  await assert.rejects(
    census.validateLegacyInventory(root, roots, state, { assertRequiredObservations: () => { throw new Error("U1 lacks observations"); } }),
    /U1 lacks observations/,
  );
});

test("A5: an external requirement's census rules decide the package the target must provide, before any target read", () => {
  const label = "completeness requirement";
  assert.deepEqual(census.externalRequirementPackage({ element: "EXTERNAL @scope/pkg/deep", disposition: "EXTERNAL_DEPENDENCY", ref: "@scope/pkg" }, label), { element: "EXTERNAL @scope/pkg/deep", expected: "@scope/pkg" });
  assert.equal(census.externalRequirementPackage({ element: "EXTERNAL lodash", disposition: "NOT_APPLICABLE", rationale: "x" }, label), null);
  assert.equal(census.externalRequirementPackage({ element: "src/a.ts", disposition: "MIGRATED_BEHAVIOR" }, label), null);
  assert.throws(() => census.externalRequirementPackage({ element: "EXTERNAL lodash", disposition: "FEATURE_LOCAL" }, label), /is an external package; 'FEATURE_LOCAL' names something inside this artifact/);
  assert.throws(() => census.externalRequirementPackage({ element: "src/a.ts", disposition: "EXTERNAL_DEPENDENCY", ref: "a" }, label), /is not an external package requirement/);
  assert.throws(() => census.externalRequirementPackage({ element: "EXTERNAL lodash/fp", disposition: "EXTERNAL_DEPENDENCY", ref: "lodash/fp" }, label), /must name the required package 'lodash', not 'lodash\/fp'/);
});

test("I3/DR28: implicitModuleRoots prefers the one feature root, fails closed on competing ones, and respects attribution", () => {
  const single = { formatVersion: 18, legacyModule: "auth" };
  const implicit = (state, roots) =>
    [...census.implicitModuleRoots(state, roots.map((path) => (typeof path === "string" ? { path } : path)), roots.map((root) => root.path ?? root))].sort();
  // The feature root beats a same-named route that sorts first, with or
  // without a package/app prefix.
  assert.deepEqual(implicit(single, ["src/app/auth", "src/features/auth"]), ["src/features/auth"]);
  assert.deepEqual(implicit(single, ["apps/web/src/app/auth", "apps/web/src/features/auth"]), ["apps/web/src/features/auth"]);
  // Exact components only: neither `xsrc` nor `myfeatures` is the convention,
  // so the historical first match stands.
  assert.deepEqual(implicit(single, ["src/app/auth", "src/myfeatures/auth"]), ["src/app/auth"]);
  assert.deepEqual(implicit(single, ["src/app/auth", "xsrc/features/auth"]), ["src/app/auth"]);
  // Historical: no feature root, first basename match; a single root as before.
  assert.deepEqual(implicit(single, ["src/pages/auth", "src/app/auth"]), ["src/app/auth"]);
  assert.deepEqual(implicit(single, ["auth", "auth-extra"]), ["auth"]);
  assert.deepEqual(implicit(single, ["src/auth-ui"]), []);
  // Competing feature roots: neither is the owner, so neither is implicit.
  assert.deepEqual(implicit(single, ["apps/a/src/features/auth", "apps/b/src/features/auth", "src/app/auth"]), []);
  // Multi-source: per source, and only among roots declared as that source's.
  const multi = { formatVersion: 19, legacyModule: "auth", legacySources: ["auth", "billing"] };
  assert.deepEqual(
    implicit(multi, [
      { path: "packages/billing/src/features/auth", source: "billing" },
      { path: "src/app/auth", source: "auth" },
      { path: "src/features/billing", source: "billing" },
    ]),
    ["src/app/auth", "src/features/billing"],
  );
});
