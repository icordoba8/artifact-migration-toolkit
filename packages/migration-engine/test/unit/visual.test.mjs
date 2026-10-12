// Track A6: the visual/ boundary (docs/architecture/a6-ownership.md).
// The behavior itself is covered where it always was: visual-evidence.test.mjs,
// legacy-runtime-authority.test.mjs, migration-contract.test.mjs,
// artifact-migration.test.mjs and the two external visual suites. This file
// pins the module boundary, the lazy PNG dependencies and the seams A6 added.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import * as decisions from "../../src/decisions/index.mjs";
import * as visual from "../../src/visual/index.mjs";

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
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push(ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "<dynamic>");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};
const visualFiles = async () => (await engineFiles()).filter((file) => file.startsWith("visual/"));

// -- architecture --------------------------------------------------------------

test("A6-ARCH-1: visual/ has exactly one public entry, and it only re-exports its own files", async () => {
  assert.ok((await visualFiles()).includes("visual/index.mjs"));
  for (const statement of (await parse("visual/index.mjs")).statements) {
    assert.ok(ts.isExportDeclaration(statement) && statement.moduleSpecifier, "visual/index.mjs only re-exports");
    assert.match(statement.moduleSpecifier.text, /^\.\/\w+\.mjs$/);
  }
  // Reaching past the entry is A1-ARCH-1 (store-shared.test.mjs).
});

test("A6-ARCH-2: engine code takes visual-owned names from visual/index.mjs, never through a compatibility path", async () => {
  const offenders = [];
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("visual/"))) {
    const sf = await parse(file);
    // The primitives' old path is a facade for tests and external callers only.
    for (const spec of specifiers(sf)) {
      if (path.resolve(src, path.dirname(file), spec) === path.join(src, "visual-evidence.mjs")) offenders.push(`${file}: ${spec}`);
    }
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(src, path.dirname(file), spec);
      if (target === path.join(src, "visual/index.mjs")) continue;
      const module = await import(pathToFileURL(target).href);
      for (const element of statement.importClause.namedBindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (Object.hasOwn(visual, name) && module[name] === visual[name]) offenders.push(`${file}: ${name} from ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// visual/ imports only the census, decisions, store, formats and shared entries
// (A1-ARCH-2) and nothing below it imports visual/, so with an acyclic inside it
// cannot sit on any engine import cycle. No lazy import reaches upward either.
test("A6-ARCH-3: visual/ adds no upward edge and no import cycle", async () => {
  const files = await visualFiles();
  const edges = new Map();
  for (const file of files) {
    const specs = specifiers(await parse(file));
    assert.ok(!specs.includes("<dynamic>"), `${file} has a non-literal import`);
    for (const spec of specs.filter((spec) => spec.startsWith("."))) {
      const target = path.posix.join(path.posix.dirname(file), spec);
      assert.ok(!/^(slices\/|resumable-migration|artifact\/|record-decision|module-lock|cli\/|mcp-server|core\.mjs|visual-evidence)/.test(target), `${file} imports ${target}`);
    }
    edges.set(file, specs.map((spec) => path.posix.join(path.posix.dirname(file), spec)).filter((target) => target.startsWith("visual/")));
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
  // No lower module names visual/ at all, not even lazily.
  for (const file of (await engineFiles()).filter((file) => /^(census|decisions|store|formats|shared)\//.test(file))) {
    assert.ok(!specifiers(await parse(file)).some((spec) => path.posix.join(path.posix.dirname(file), spec).startsWith("visual")), file);
  }
});

// The declarations A6 moved, by their old home. The primitives moved as a whole
// file; their old path now declares nothing.
const MOVED = {
  "resumable-migration.mjs": [
    "usesVisualContract", "UI_UNREQUIRED_DISPOSITIONS", "UI_VIEWPORT_STATES", "UI_SECRET_KEY_PATTERN", "UI_SECRET_VALUE_PATTERN",
    "assertNoUiSecret", "uiBehaviorIsRequired", "LEGACY_RUNTIME_EVIDENCE_ROOT", "TARGET_EVIDENCE_ROOT", "LEGACY_AUTHORITY_ROLE",
    "TARGET_VERIFICATION_ROLE", "hardenedVisual", "VISUAL_AUTHORITIES", "frameKeyOf", "assertCaptureRole", "assertTargetEvidencePath",
    "visualAuthorityOf", "AUTHORITY_CONTEXT_FILES", "pinsAuthorityContext", "designSourceExplicit", "figmaSourceKey",
    "assertDesignSourceUnchanged", "OBSERVATION_EXPECTED", "OBSERVATION_FIELDS", "assertRequiredObservations",
    "validateUiRuntimeEvidence", "sliceLacksUiProofV1", "completedSlicesLackingUiProofV1", "FIGMA_NODE_ID", "FIGMA_SOURCE_KINDS",
    "figmaNodeKey", "figmaMetadataAncestry", "VISUAL_UNBACKED_KIND", "visualContractDigest", "visualUnbackedCandidate",
    "backedRowFor", "pendingVisualUnbackedCandidates", "validateFigmaContext", "resolveStructuredFigmaFrame", "resolveFigmaFacts",
    "validateLegacyRuntimeContext", "MAX_TOLERANCE_PX", "MAX_TOLERANCE_RATIO", "PROVISIONAL_VISUAL_DIFF_THRESHOLDS",
    "assertVisualCaptureBlock", "compareVisualEvidence", "validateVisualAcceptance", "compareVisualFact", "assertVisualAcceptance",
    "reopenUiEligible", "reopenUiIneligible",
  ],
  "artifact/artifact-migration.mjs": ["strictVisualState", "artifactVisualAuthority", "artifactUiInventory", "validateArtifactVisualEvidence"],
};

test("A6-ARCH-4: every visual declaration has exactly one live definition, and no moved declaration survives at its old site", async () => {
  const files = await engineFiles();
  const owned = new Set();
  for (const file of files.filter((file) => file.startsWith("visual/"))) {
    for (const name of declared(await parse(file))) {
      assert.ok(!owned.has(name), `${name} is declared twice inside visual/`);
      owned.add(name);
    }
  }
  // Exported visual names are declared nowhere else.
  for (const file of files.filter((file) => !file.startsWith("visual/"))) {
    assert.deepEqual(declared(await parse(file)).filter((name) => Object.hasOwn(visual, name)), [], file);
  }
  for (const [file, moved] of Object.entries(MOVED)) {
    const live = new Set(declared(await parse(file)));
    assert.deepEqual(moved.filter((name) => live.has(name)), [], file);
    for (const name of moved) assert.ok(owned.has(name), `${name} has no new home`);
  }
  assert.deepEqual(declared(await parse("visual-evidence.mjs")), []);
});

// Every module that exported a visual-owned name at BASE still does, as the
// visual binding itself rather than a copy.
const COMPAT = {
  "resumable-migration.mjs": [
    "assertRequiredObservations", "compareVisualEvidence", "compareVisualFact", "figmaMetadataAncestry", "LEGACY_AUTHORITY_ROLE",
    "LEGACY_RUNTIME_EVIDENCE_ROOT", "pendingVisualUnbackedCandidates", "PROVISIONAL_VISUAL_DIFF_THRESHOLDS", "sliceLacksUiProofV1",
    "TARGET_VERIFICATION_ROLE", "validateFigmaContext", "validateLegacyRuntimeContext", "validateVisualAcceptance",
    "VISUAL_AUTHORITIES", "VISUAL_UNBACKED_KIND", "visualAuthorityOf",
  ],
  "visual-evidence.mjs": [
    "assertProvenancePrecedence", "assertStructuredCaptureScale", "captureStructuredNode", "compareStructuredTarget", "decodePng",
    "deriveStructuredAuthority", "extractNodeLiterals", "extractStructuredFacts", "FIGMA_PROVENANCE_KINDS", "figmaShadows",
    "figmaStroke", "FIXED_VISUAL_TOLERANCE", "GEOMETRY_FACTS", "HARDENED_VISUAL_VERSION", "missingRequiredGroups",
    "normalizeVisualValue", "perceptualDelta", "REQUIRED_FACT_KINDS", "REQUIRED_FACT_NAMES", "REQUIRED_FACTS", "resampleTo",
    "resolveDesignContextFact", "resolveMetadataAssets", "resolveMetadataFact", "resolveVariableDefsFact", "resolveVisualProvenance",
    "strokeFromComputedStyle", "structuralDelta", "structuredAssetIdentity", "structuredCapabilityProfile", "structuredDigest",
    "structuredEvidenceDigest", "STRUCTURED_PROVENANCE_RANKS", "validateStructuredContract", "variableValueSet", "xmlAttribute",
  ],
};

test("A6-ARCH-5: historical compatibility exports remain, as the visual binding itself", async () => {
  for (const [file, names] of Object.entries(COMPAT)) {
    const module = await import(pathToFileURL(path.join(src, file)).href);
    for (const name of names) assert.equal(module[name], visual[name], `${file} ${name}`);
  }
  // The primitives' public path exports exactly what it did before it moved.
  const facade = await import(pathToFileURL(path.join(src, "visual-evidence.mjs")).href);
  assert.deepEqual(Object.keys(facade).sort(), [...COMPAT["visual-evidence.mjs"]].sort());
  // Thresholds and tolerance are values, not just names.
  assert.deepEqual(visual.FIXED_VISUAL_TOLERANCE, { px: 1, ratio: 0 });
  assert.deepEqual(Object.keys(visual.VISUAL_AUTHORITIES), ["figma-mcp", "legacy-runtime"]);
  assert.equal(visual.HARDENED_VISUAL_VERSION, 2);
});

const execFileAsync = promisify(execFile);

test("A6-ARCH-6: pngjs and pixelmatch load lazily, from the public visual-evidence.mjs path", async () => {
  // A fresh process: importing visual/ and every engine module that re-exports
  // it loads neither; the first decode and the first diff do, resolved from
  // src/visual-evidence.mjs exactly as before the move. Errors keep their text.
  const base = JSON.stringify(pathToFileURL(src).href);
  const probe = `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const from = createRequire(new URL("visual-evidence.mjs", ${base}));
    const keys = ["pngjs", "pixelmatch"].map((name) => from.resolve(name));
    const loaded = () => keys.map((key) => Object.hasOwn(require.cache, key));
    for (const file of ["visual/index.mjs", "visual-evidence.mjs", "core.mjs", "resumable-migration.mjs", "artifact/artifact-migration.mjs", "record-decision.mjs", "mcp-server.mjs"]) {
      await import(new URL(file, ${base}).href);
    }
    const before = loaded();
    const visual = await import(new URL("visual/index.mjs", ${base}).href);
    let refusal;
    try { visual.decodePng(Buffer.from("not a png")); } catch (error) { refusal = error.message; }
    const afterDecode = loaded();
    const pixel = { width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) };
    const delta = visual.perceptualDelta(pixel, pixel, { width: 1, height: 1, matte: "#ffffff" });
    console.log(JSON.stringify({ before, afterDecode, after: loaded(), refusal, delta }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe], { cwd: os.tmpdir() });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.before, [false, false]);
  assert.deepEqual(result.afterDecode, [true, false]);
  assert.deepEqual(result.after, [true, true]);
  assert.match(result.refusal, /^VISUAL_PNG_INVALID: /);
  assert.deepEqual(result.delta, { diffPixels: 0, diffRatio: 0 });
});

// What visual imports from decisions: it builds the VISUAL_UNBACKED candidate
// and requires a decision, but nothing it imports records, approves or rejects.
const VISUAL_DECISIONS_IMPORTS = ["createDecisionCandidate", "createNewFormatDecisionCandidate", "readRecordedDecisions", "requireModuleDecision"];
const FS_WRITES = new Set([
  "appendFile", "chmod", "chown", "copyFile", "cp", "createWriteStream", "link", "mkdir",
  "mkdtemp", "open", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
]);

test("A6-ARCH-7: visual never grants approval or writes: it reaches decisions only to build, read and require", async () => {
  const fromDecisions = new Set();
  for (const file of await visualFiles()) {
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
  assert.deepEqual([...fromDecisions].sort(), VISUAL_DECISIONS_IMPORTS);
  for (const name of VISUAL_DECISIONS_IMPORTS) assert.equal(typeof decisions[name], "function");
  // Visual publishes facts and verdicts, never an approval path.
  assert.deepEqual(Object.keys(visual).filter((name) => /approve|reject|record|append|lock|commit/i.test(name)), []);
});

// -- seams and rules -------------------------------------------------------------

const uiState = { formatVersion: 19, targetModule: "auth", requirementsAuthority: { digest: "d" }, dataSourceMode: "real" };
const uiBaseline = () => ({ legacy: { hasVisibleUi: true, uiBehaviors: [] }, target: { uiMismatches: [] }, behaviorRows: [] });

test("A6: UI runtime evidence reads the injected implementation digests once, after the limitations and before any record", async () => {
  const implementation = { traceIds: [] };
  const roots = { legacyRoot: "/l", targetRoot: "/t" };
  const calls = [];
  const implementationDigests = async (...args) => {
    calls.push(args);
    return { current: "c", legacy: "l" };
  };
  const run = (evidence, digests = implementationDigests) => visual.validateUiRuntimeEvidence({
    evidence, implementation, baseline: uiBaseline(), sliceId: "slice-a", state: uiState, roots, root: "/r",
    implementationDigests: digests,
  });
  assert.deepEqual(await run({ uiEvidence: [], uiEvidenceLimitations: [] }), []);
  assert.deepEqual(calls, [[implementation, roots]]);
  // A malformed limitation is refused before the claimed bytes are read.
  await assert.rejects(run({ uiEvidence: [], uiEvidenceLimitations: [{ availability: "AVAILABLE" }] }), /availability must be 'NOT_AVAILABLE'/);
  assert.equal(calls.length, 1);
  // A stale binding read fails before any record is judged, as it always did.
  await assert.rejects(
    run({ uiEvidence: [{ provider: "selenium" }], uiEvidenceLimitations: [] }, async () => { throw new Error("Cannot bind UI evidence"); }),
    /Cannot bind UI evidence/,
  );
  await assert.rejects(run({ uiEvidence: [{ provider: "selenium" }], uiEvidenceLimitations: [] }), /provider must be 'playwright'/);
  // No visible UI, or a pre-format-12 record, never reads the digests at all.
  const before = calls.length;
  await visual.validateUiRuntimeEvidence({ evidence: {}, implementation, baseline: { legacy: { hasVisibleUi: false } }, state: uiState, implementationDigests });
  assert.equal(calls.length, before);
});

test("A6: each design source pins only its own authority context, and target-system pins none", () => {
  const figma = { formatVersion: 17, designSource: "figma-mcp" };
  const legacy = { formatVersion: 17, designSource: "legacy-runtime" };
  const target = { formatVersion: 17, designSource: "target-system" };
  const figmaFile = visual.VISUAL_AUTHORITIES["figma-mcp"].contextFile;
  const legacyFile = visual.VISUAL_AUTHORITIES["legacy-runtime"].contextFile;
  assert.notEqual(figmaFile, legacyFile);
  assert.equal(visual.visualAuthorityOf(figma), visual.VISUAL_AUTHORITIES["figma-mcp"]);
  assert.equal(visual.visualAuthorityOf(legacy), visual.VISUAL_AUTHORITIES["legacy-runtime"]);
  assert.equal(visual.visualAuthorityOf(target), null);
  // Before the design-source format no record has an authority, whatever it says.
  assert.equal(visual.visualAuthorityOf({ formatVersion: 13, designSource: "figma-mcp" }), null);
  for (const [state, own, other] of [[figma, figmaFile, legacyFile], [legacy, legacyFile, figmaFile]]) {
    assert.equal(visual.pinsAuthorityContext(state, own), true);
    assert.equal(visual.pinsAuthorityContext(state, other), false);
    assert.equal(visual.pinsAuthorityContext(state, "inventories/legacy.json"), true);
    assert.equal(visual.usesVisualContract(state), true);
  }
  assert.equal(visual.pinsAuthorityContext(target, figmaFile), false);
  assert.equal(visual.pinsAuthorityContext(target, legacyFile), false);
  assert.equal(visual.usesVisualContract(target), false);
  // Each authority binds target evidence through its own digest field and role.
  assert.equal(visual.VISUAL_AUTHORITIES["figma-mcp"].boundToDigestField, "figmaContextDigest");
  assert.equal(visual.VISUAL_AUTHORITIES["legacy-runtime"].boundToDigestField, "visualContextDigest");
  assert.notEqual(visual.LEGACY_AUTHORITY_ROLE, visual.TARGET_VERIFICATION_ROLE);
});

test("A6: --reopen-ui is eligible only for COMPLETE, or ACTIVE at VERIFY_SLICES or FINALIZE", () => {
  for (const [state, eligible] of [
    [{ status: "COMPLETE", currentStep: "COMPLETE" }, true],
    [{ status: "ACTIVE", currentStep: "VERIFY_SLICES" }, true],
    [{ status: "ACTIVE", currentStep: "FINALIZE" }, true],
    [{ status: "ACTIVE", currentStep: "IMPLEMENT_SLICES" }, false],
    [{ status: "ACTIVE", currentStep: "BUILD_BASELINE" }, false],
    [{ status: "BLOCKED", currentStep: "VERIFY_SLICES" }, false],
  ]) {
    assert.equal(visual.reopenUiEligible(state), eligible, JSON.stringify(state));
  }
  assert.equal(
    visual.reopenUiIneligible({ status: "ACTIVE", currentStep: "PLAN" }),
    "--reopen-ui is legal only for a COMPLETE migration, or an ACTIVE one at VERIFY_SLICES or FINALIZE; the current status is 'ACTIVE' at 'PLAN'.",
  );
});
