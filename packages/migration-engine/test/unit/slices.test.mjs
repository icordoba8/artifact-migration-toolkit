// Track A4: the slices/ module boundary, and adversarial cases for the claim,
// rework, drift and reconciliation rules slices/ now owns. The single-entry and
// import-direction checks shared with store/, shared/, formats/ and decisions/
// are A1-ARCH-1/2 in `store-shared.test.mjs`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CAPABILITY_OWNERSHIP_FORMAT } from "../../src/formats/index.mjs";
import { commitsTouchingSince } from "../../src/shared/index.mjs";
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

// -- claim spellings (DR4: one canonical target-relative spelling) ------------

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
  // Legacy-relative paths keep their own rule.
  assert.equal(legacyRelativePath("../legacy/src/x.ts", roots, "Claim"), "src/x.ts");
  // DR4: a traversal is never a target spelling, even one that lands back inside.
  for (const outside of ["../legacy/x.ts", path.join(workspace, "elsewhere.ts"), "/", "//", "../target/src", "src/../src/a.ts", "src\\..\\a.ts"]) {
    assert.throws(() => targetRelativePath(outside, roots, "Claim"), new RegExp(`Claim '.*' is outside the target repository\\.`));
  }
  // No root to resolve against: only the spelling is normalized.
  assert.equal(targetRelativePath("./src/a.ts/", {}, "Claim"), "src/a.ts");
});

test("DR4: every accepted spelling of a changed-file claim is one target path, existing or missing, and never a path outside the target", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dr4-claim-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const roots = { legacyRoot: path.join(workspace, "legacy"), targetRoot: path.join(workspace, "target") };
  await mkdir(path.join(roots.targetRoot, "src"), { recursive: true });
  await mkdir(path.join(roots.legacyRoot, "src"), { recursive: true });
  await mkdir(path.join(workspace, "elsewhere"), { recursive: true });
  await writeFile(path.join(roots.targetRoot, "src/a.ts"), "a\n");
  await writeFile(path.join(roots.legacyRoot, "src/b.ts"), "b\n");
  await writeFile(path.join(workspace, "outside.ts"), "o\n");
  await writeFile(path.join(workspace, "elsewhere/x.ts"), "x\n");
  await symlink(path.join(workspace, "elsewhere"), path.join(roots.targetRoot, "src/linked"));
  const identity = `sha256:${"0".repeat(64)}`;
  for (const [changed, expected] of [
    // An existing file, in every spelling the contract accepts.
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["target/src/a.ts", "src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    [".\\src\\a.ts", "src/a.ts"],
    ["src//a.ts", "src/a.ts"],
    [path.join(roots.targetRoot, "src/a.ts"), "src/a.ts"],
    // A v1.3.17 `<path> <identity>` entry reads as its path.
    [`src/a.ts ${identity}`, "src/a.ts"],
    [`target/src/a.ts ${identity}`, "src/a.ts"],
    // A file that does not exist (yet, or any more) is spelled the same way.
    ["src/missing.ts", "src/missing.ts"],
    ["./src/missing.ts", "src/missing.ts"],
    ["target/src/missing.ts", "src/missing.ts"],
    ["src\\missing.ts", "src/missing.ts"],
    ["src/missing.ts/", "src/missing.ts"],
    // A legacy-only file is not a target file: it stays a target-relative
    // spelling that names nothing in the target.
    ["src/b.ts", "src/b.ts"],
    ["legacy/src/b.ts", "legacy/src/b.ts"],
    // Only the target's own prefix is stripped, never a sibling sharing it.
    ["target-copy/src/a.ts", "target-copy/src/a.ts"],
    // Lexical, never through a link: the claim names the target entry.
    ["src/linked/x.ts", "src/linked/x.ts"],
    // Outside the target: kept as written, so it equals no target path. A
    // `..` segment is never read back into the target unless the file exists
    // there as written, exactly as before DR4.
    ["../outside.ts", "../outside.ts"],
    ["../target/src/a.ts", "src/a.ts"],
    ["../target/src/missing.ts", "../target/src/missing.ts"],
    ["/", "/"],
    [path.join(workspace, "outside.ts"), path.join(workspace, "outside.ts").replaceAll("\\", "/")],
  ]) assert.equal(await canonicalClaim(changed, roots), expected, changed);
  // No root to resolve against: only the spelling is normalized.
  assert.equal(await canonicalClaim("./src/a.ts", {}), "src/a.ts");
  const absolute = path.join(roots.targetRoot, "src/a.ts");
  // Git's own syntax stays apart: `git show <rev>:./<path>` needs the `./`.
  assert.equal(repoRelative(roots.targetRoot, absolute), "./src/a.ts");
  assert.equal(targetRelative(roots, absolute), "src/a.ts");
});

test("DR4: the implementation digest binds the same bytes whichever accepted spelling the record uses", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dr4-digest-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const roots = { legacyRoot: path.join(workspace, "legacy"), targetRoot: path.join(workspace, "target") };
  await mkdir(path.join(roots.targetRoot, "src"), { recursive: true });
  await mkdir(roots.legacyRoot, { recursive: true });
  await writeFile(path.join(roots.targetRoot, "src/a.ts"), "a\n");
  const canonical = await slices.implementationDigests({ changedFiles: ["src/a.ts"] }, roots);
  for (const changed of ["./src/a.ts", "target/src/a.ts", "src\\a.ts", `src/a.ts sha256:${"0".repeat(64)}`]) {
    assert.deepEqual(await slices.implementationDigests({ changedFiles: [changed] }, roots), canonical, changed);
  }
  // Never bound to bytes outside the target: not by traversal, not through a link.
  await writeFile(path.join(workspace, "outside.ts"), "o\n");
  await symlink(path.join(workspace, "outside.ts"), path.join(roots.targetRoot, "src/link.ts"));
  for (const changed of ["../legacy/a.ts", "src/link.ts"]) {
    await assert.rejects(
      slices.implementationDigests({ changedFiles: [changed] }, roots),
      new RegExp(`Cannot bind UI evidence to changed file '${changed.replaceAll(".", "\\.")}'`),
    );
  }
});

test("DR4: the post-anchor history of a claimed path reads it as a file name, never a pattern", async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "dr4-pathspec-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "maintenance.auto=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src/a[1].ts"), "a\n");
  await writeFile(path.join(repo, "src/a1.ts"), "b\n");
  git("add", "-A");
  git("commit", "-qm", "anchor");
  const anchor = git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "src/a1.ts"), "c\n");
  git("commit", "-qam", "only the other file");
  assert.deepEqual(await commitsTouchingSince(repo, anchor, "./src/a[1].ts"), []);
  await writeFile(path.join(repo, "src/a[1].ts"), "d\n");
  git("commit", "-qam", "the claimed file");
  assert.deepEqual(await commitsTouchingSince(repo, anchor, "./src/a[1].ts"), [git("rev-parse", "HEAD")]);
});

test("DR4: a POSIX file named with a literal backslash keeps resolving, and its digest, as before DR4", { skip: process.platform === "win32" }, async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dr4-backslash-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const roots = { legacyRoot: path.join(workspace, "legacy"), targetRoot: path.join(workspace, "target") };
  await mkdir(path.join(roots.targetRoot, "src"), { recursive: true });
  await mkdir(roots.legacyRoot, { recursive: true });
  const literal = "src/back\\slash.ts";
  await writeFile(path.join(roots.targetRoot, literal), "b\n");
  assert.equal(await canonicalClaim(literal, roots), literal);
  const identity = await store.fileIdentity(path.join(roots.targetRoot, literal));
  const { createHash } = await import("node:crypto");
  assert.equal(
    (await slices.implementationDigests({ changedFiles: [literal] }, roots)).current,
    `sha256:${createHash("sha256").update(JSON.stringify([[literal, identity]])).digest("hex")}`,
  );
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

// -- the documented record contract ----------------------------------------------

// I8: the canonical contract's slice-index, `slices/<slice-id>.json` and
// `evidence/<slice-id>/result.json` examples, parsed from the first ```json
// block after each section's marker sentence.
const contractExamples = async () => {
  const doc = await readFile(new URL("../../../../skills/start-migration/references/migration-contract.md", import.meta.url), "utf8");
  const after = (marker) => {
    const at = doc.indexOf(marker);
    assert.notEqual(at, -1, `migration-contract.md lost '${marker}'`);
    return JSON.parse(doc.slice(at).match(/```json\n([\s\S]*?)\n```/)[1]);
  };
  return {
    index: after("## Slice index and records"),
    implementation: after("`slices/<slice-id>.json` records implementation."),
    evidence: after("`evidence/<slice-id>/result.json` records verification."),
  };
};

test("I8: the documented slice and evidence records satisfy the list-coverage rule at format 11+, and pre-11 records need no capabilityIds", async () => {
  const { index, implementation, evidence } = await contractExamples();
  const sliceId = implementation.id;
  assert.equal(evidence.sliceId, sliceId);
  const planned = index.slices.find((slice) => slice.id === sliceId);
  assert.ok(planned, `the slice index example plans '${sliceId}'`);
  const command = () => "<engine command>";
  // assertSlicePassed is the exported entry over traceLists/assertCoversPlanned:
  // IMPLEMENT_SLICES holds the record to the plan, VERIFY_SLICES the evidence to the record.
  const covers = (before, after, formatVersion) =>
    slices.assertSlicePassed(before, { sliceId, result: "PASS", ...after }, sliceId, { formatVersion }, command);
  const withoutCapabilities = ({ capabilityIds, ...record }) => record;

  covers(planned, implementation, CAPABILITY_OWNERSHIP_FORMAT);
  covers(implementation, evidence, CAPABILITY_OWNERSHIP_FORMAT);
  // The rule the examples must honor is still enforced at format 11+.
  assert.throws(() => covers(planned, withoutCapabilities(implementation), CAPABILITY_OWNERSHIP_FORMAT), /capabilityIds/);
  assert.throws(() => covers(implementation, withoutCapabilities(evidence), CAPABILITY_OWNERSHIP_FORMAT), /capabilityIds/);
  // A pre-11 record has no capability matrix: none of the three carries the list.
  const legacy = CAPABILITY_OWNERSHIP_FORMAT - 1;
  covers(withoutCapabilities(planned), withoutCapabilities(implementation), legacy);
  covers(withoutCapabilities(implementation), withoutCapabilities(evidence), legacy);
});
