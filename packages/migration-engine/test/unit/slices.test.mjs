// Track A4: the slices/ module boundary, and adversarial cases for the claim,
// rework, drift and reconciliation rules slices/ now owns. The single-entry and
// import-direction checks shared with store/, shared/, formats/ and decisions/
// are A1-ARCH-1/2 in `store-shared.test.mjs`.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as slices from "../../src/slices/index.mjs";
import * as store from "../../src/store/index.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const ts = createRequire(import.meta.url)("ts-discovery-compiler");

const engineFiles = async () =>
  (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".mjs")).map((file) => file.split(path.sep).join("/"));
const parse = async (file) =>
  ts.createSourceFile(file, await readFile(path.join(src, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declared = (sf) => sf.statements.flatMap((statement) =>
  ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? [statement.name.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((d) => d.name.getText(sf)) : []);

// -- architecture --------------------------------------------------------------

test("A4-ARCH-1: slices/ has exactly one public entry, and it exports only what something outside uses", async () => {
  const files = (await engineFiles()).filter((file) => file.startsWith("slices/"));
  assert.ok(files.includes("slices/index.mjs"));
  const index = await parse("slices/index.mjs");
  for (const statement of index.statements) {
    assert.ok(ts.isExportDeclaration(statement) && statement.moduleSpecifier, "slices/index.mjs only re-exports");
    assert.match(statement.moduleSpecifier.text, /^\.\/\w+\.mjs$/);
  }
  // Reaching past the entry is A1-ARCH-1 (store-shared.test.mjs).
});

test("A4-ARCH-2: engine code imports slices-owned names from slices/index.mjs, never through a compatibility re-export", async () => {
  const offenders = [];
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("slices/"))) {
    for (const statement of (await parse(file)).statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(src, path.dirname(file), spec);
      if (target === path.join(src, "slices/index.mjs")) continue;
      const module = await import(pathToFileURL(target).href);
      for (const element of statement.importClause.namedBindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (Object.hasOwn(slices, name) && module[name] === slices[name]) offenders.push(`${file}: ${name} from ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// Nothing below slices/ may import it (A1-ARCH-2), and slices/ imports only
// decisions/, store/, formats/ and shared/ entries, so with an acyclic inside
// it cannot sit on any engine import cycle.
test("A4-ARCH-3: slices/ adds no import cycle: its files import each other acyclically", async () => {
  const files = (await engineFiles()).filter((file) => file.startsWith("slices/"));
  const edges = new Map();
  for (const file of files) {
    edges.set(file, (await parse(file)).statements
      .filter((statement) => (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier)
      .map((statement) => path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text))
      .filter((target) => target.startsWith("slices/")));
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

// The declarations A4 moved, by their old home: one live definition each, in
// slices/ (or store/ for the re-homed evidence cluster and REOPEN_ROOT).
const MOVED = {
  "resumable-migration.mjs": [
    "anySliceVerified", "TERMINAL_DESIGN_SYSTEM", "NON_TERMINAL_CAPABILITIES", "TARGET_DIRTY_SCOPE", "portableRoot",
    "baselineDirtyEntries", "renderTargetBaseline", "validateTargetBaselineShape", "targetBaselineDrift", "readTargetBaseline",
    "assertSliceStateConsistent", "rootRelativePath", "targetRelativePath", "legacyRelativePath", "traceLists",
    "assertCoversPlanned", "assertCapabilityPlan", "governingReopen", "verifiedReopenRecord", "resolveReopenAnchor",
    "repoRelative", "anchoredOwnershipCache", "anchoredReopenOwnership", "resolveAnchoredOwnership", "resolveChangedFile",
    "implementationDigests", "delegatedChangedFilesSatisfiedByChild", "assertPostAnchorEvidence", "REWORK_ROOT",
    "reworkLimitBlocker", "REWORK_PATH", "reworkPathParts", "reworkAttemptsOf", "preservedEvidencePath",
    "validateFailedSliceResult", "assertNoUnresolvedVerification", "assertGatesCoverSliceScenarios", "DRIFT_OWNERSHIP_STEPS",
    "DRIFT_CLASSES", "plannedTargetOwners", "withinPlannedScope", "canonicalClaim", "claimedTargetPaths",
    "UNDERIVABLE_OWNERSHIP_REASON", "driftCandidateFacts", "classifyTargetDrift", "SLICE_AMENDMENT_ROOT",
    "ENGINE_SKILL_ROOT", "TEST_LEVEL_SUFFIX", "targetRelative", "eventNamesSlice", "pendingTargetDriftCandidates", "unclaimedTargetDrift",
    "assertNoUnclaimedTargetDrift", "inspectSliceArtifacts", "reconcileSliceState",
    "PATH_CLAIM", "evidencePathClaim", "resolveEvidencePath", "assertEvidenceResolves", "assertEvidenceReference",
    "assertCommandResults", "REOPEN_ROOT",
  ],
  "artifact/artifact-migration.mjs": ["migrationChangedFiles", "diffEntries", "implementationCoversDrift"],
};

test("A4-ARCH-4: every slices declaration has exactly one live definition, and no moved declaration survives at its old site", async () => {
  const files = await engineFiles();
  const owned = new Set();
  for (const file of files.filter((file) => file.startsWith("slices/"))) {
    for (const name of declared(await parse(file))) {
      assert.ok(!owned.has(name), `${name} is declared twice inside slices/`);
      owned.add(name);
    }
  }
  for (const file of files.filter((file) => !file.startsWith("slices/"))) {
    assert.deepEqual(declared(await parse(file)).filter((name) => owned.has(name)), [], file);
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
    for (const name of moved) assert.ok(owned.has(name) || Object.hasOwn(store, name) || name === "PATH_CLAIM", `${name} has no new home`);
  }
});

// Every module that exported a slices-owned name at BASE still does, as the
// slices (or store) binding itself rather than a copy. The one exception keeps
// its BASE arity: the three-argument drift reader reads its census facts itself.
const COMPAT = {
  "core.mjs": ["TARGET_DIRTY_SCOPE", "delegatedChangedFilesSatisfiedByChild", "inspectSliceArtifacts", "reconcileSliceState", "renderTargetBaseline"],
  "resumable-migration.mjs": ["REWORK_ROOT", "SLICE_AMENDMENT_ROOT", "TARGET_DIRTY_SCOPE", "delegatedChangedFilesSatisfiedByChild", "inspectSliceArtifacts", "reconcileSliceState", "renderTargetBaseline", "reworkLimitBlocker", "reworkPathParts", "unclaimedTargetDrift"],
};

test("A4-ARCH-5: historical compatibility exports remain, as the slices binding itself", async () => {
  for (const [file, names] of Object.entries(COMPAT)) {
    const module = await import(pathToFileURL(path.join(src, file)).href);
    for (const name of names) assert.equal(module[name], slices[name], `${file} ${name}`);
  }
  const lifecycle = await import(pathToFileURL(path.join(src, "resumable-migration.mjs")).href);
  assert.equal(lifecycle.REOPEN_ROOT, store.REOPEN_ROOT);
  assert.equal(lifecycle.pendingTargetDriftCandidates.length, 3);
  assert.equal(slices.pendingTargetDriftCandidates.length, 4);
});

// -- claim spellings (DR4 is Track B: every variant keeps its own rule) --------

const {
  canonicalClaim,
  legacyRelativePath,
  repoRelative,
  settleFact,
  targetRelative,
  targetRelativePath,
} = slices;

test("A4: the root-relative claim spelling keeps its rules for ./, trailing and Windows separators, sibling prefixes and containment", () => {
  const workspace = path.resolve(os.tmpdir(), "a4-spelling");
  const roots = { legacyRoot: path.join(workspace, "legacy"), targetRoot: path.join(workspace, "target") };
  for (const [claim, expected] of [
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["src/dir/", "src/dir"],
    ["src\\a.ts", "src/a.ts"],
    ["target/src/a.ts", "src/a.ts"],
    ["target", ""],
    ["legacy/x.ts", "legacy/x.ts"],
  ]) assert.equal(targetRelativePath(claim, roots, "Claim"), expected, claim);
  assert.equal(legacyRelativePath("legacy/src/x.ts", roots, "Claim"), "src/x.ts");
  for (const outside of ["../legacy/x.ts", path.join(workspace, "elsewhere.ts")]) {
    assert.throws(() => targetRelativePath(outside, roots, "Claim"), new RegExp(`Claim '.*' is outside the target repository\\.`));
  }
  // No root to resolve against: only the spelling is normalized.
  assert.equal(targetRelativePath("./src/a.ts/", {}, "Claim"), "src/a.ts");
});

test("A4: the changed-file claim spelling resolves real files only, and otherwise keeps the raw first token", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "a4-claim-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const roots = { legacyRoot: path.join(workspace, "legacy"), targetRoot: path.join(workspace, "target") };
  await mkdir(path.join(roots.targetRoot, "src"), { recursive: true });
  await mkdir(roots.legacyRoot, { recursive: true });
  await writeFile(path.join(roots.targetRoot, "src/a.ts"), "a\n");
  await writeFile(path.join(workspace, "outside.ts"), "o\n");
  for (const [changed, expected] of [
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["target/src/a.ts", "src/a.ts"],
    [`src/a.ts sha256:${"0".repeat(64)}`, "src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    ["src\\missing.ts", "src/missing.ts"],
    // Never resolved outside the target root, so it stays the raw spelling.
    ["../outside.ts", "../outside.ts"],
  ]) assert.equal(await canonicalClaim(changed, roots), expected, changed);
  assert.equal(await canonicalClaim("./src/a.ts", {}), "./src/a.ts");
  const absolute = path.join(roots.targetRoot, "src/a.ts");
  assert.equal(repoRelative(roots.targetRoot, absolute), "./src/a.ts");
  assert.equal(targetRelative(roots, absolute), "src/a.ts");
});

// -- census facts handed in as data ---------------------------------------------

test("A4: a settled census fact keeps its value, and a failed read rejects nothing until it is consumed", async () => {
  const failure = new Error("legacy read failed");
  assert.deepEqual(await settleFact(Promise.resolve({ legacyRevision: "r" })), { value: { legacyRevision: "r" } });
  const settled = await settleFact(Promise.reject(failure));
  assert.equal(settled.error, failure);
  // Not consumed: drift is no question before VERIFY_SLICES, so nothing throws.
  assert.deepEqual(
    await slices.pendingTargetDriftCandidates(os.tmpdir(), { currentStep: "PLAN", formatVersion: 19 }, { targetRoot: os.tmpdir() }, { brownfield: false, legacySource: settled }),
    [],
  );
});
