// Track A2: the formats/ module boundary, the split format-upgrade registries,
// and the format predicates consumers now decide through. The import-direction
// and single-entry checks shared with store/ and shared/ are A1-ARCH-1/2 in
// `store-shared.test.mjs`.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as formats from "../../src/formats/index.mjs";
import * as store from "../../src/store/index.mjs";
import {
  ARTIFACT_FORMAT_UPGRADERS,
  ARTIFACT_FORMAT_VERSION,
  artifactFormatUpgrade,
} from "../../src/artifact/artifact-migration.mjs";
import {
  compatibilityBlocker,
  FORMAT_UPGRADERS,
  upgradeCommandFor,
} from "../../src/resumable-migration.mjs";

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

// Same name, different rule -- not a second copy of a formats declaration:
// the frozen v4 -> v5 upgrader keeps its own snapshot of the layout (Q5);
// `FIGMA_NODE_ID` there is the canonical `<page>:<node>` form (DR25, visual),
// here the URL `<page>-<node>` form; the monolith's `confirmationIdFor` hashes
// an advance snapshot, formats' the upgrade preview (DR21).
const SAME_NAME_OTHER_RULE = {
  "upgrades/upgrade-v4-to-v5.mjs": ["HISTORY_FILE", "INTEGRITY_FILE", "STATE_FILE", "STEP_FILES"],
  // The monolith's copy moved with the module checkpoint readers (Track A8).
  "lifecycle/checkpoints.mjs": ["confirmationIdFor"],
  // The canonical node-id rule moved with the Figma context validator (Track A6).
  "visual/authority.mjs": ["FIGMA_NODE_ID"],
};

test("A2-ARCH-1: every formats declaration has exactly one live definition, inside formats/", async () => {
  const files = await engineFiles();
  const owned = new Set();
  for (const file of files.filter((file) => file.startsWith("formats/"))) {
    for (const name of declared(await parse(file))) {
      assert.ok(!owned.has(name), `${name} is declared twice inside formats/`);
      owned.add(name);
    }
  }
  for (const file of files.filter((file) => !file.startsWith("formats/"))) {
    const second = declared(await parse(file)).filter((name) => owned.has(name) && !SAME_NAME_OTHER_RULE[file]?.includes(name));
    assert.deepEqual(second, [], file);
  }
});

test("A2-ARCH-2: engine code imports formats-owned names from formats/index.mjs, never through a compatibility re-export", async () => {
  const offenders = [];
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("formats/"))) {
    for (const statement of (await parse(file)).statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(src, path.dirname(file), spec);
      if (target === path.join(src, "formats/index.mjs")) continue;
      const module = await import(pathToFileURL(target).href);
      for (const element of statement.importClause.namedBindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (Object.hasOwn(formats, name) && module[name] === formats[name]) offenders.push(`${file}: ${name} from ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// The raw `formatVersion` comparisons left outside formats/, each named: they
// are not format-feature decisions a predicate could own without changing
// behavior. Shrink this table when one moves; never grow it.
//   census/artifact: resolveArtifact (creation stamp vs ACTIVE/SUPPORTED),
//     moved from artifact-migration by Track A5.
//   lifecycle/artifact-transaction (artifact-migration until Track A8):
//     pristineFormatUpgrade (`!== 13`, the pristine 13 -> 14 source check),
//     validateTransactionInput (`!== undefined && !== 14`, input admission
//     with its own message), proveBootstrapTransaction (persisted == input).
//   lifecycle/contract-upgrade (upgrade-migration until Track A7,
//     upgrade-coordinator until Track A8): classify (`=== 3`) and
//     executeUpgrade (`!== V5_FORMAT_VERSION`) read the frozen v4 -> v5
//     snapshot (Q5).
//   upgrade-v4-to-v5: the frozen snapshot itself.
const RAW_FORMAT_COMPARISONS = {
  "census/artifact.mjs": 1,
  "lifecycle/artifact-transaction.mjs": 4,
  "lifecycle/contract-upgrade.mjs": 2,
  "upgrades/upgrade-v4-to-v5.mjs": 2,
};

test("A2-ARCH-3: format-version branching outside formats/ is only the identified remainder", async () => {
  const K = ts.SyntaxKind;
  const comparisons = new Set([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken,
    K.LessThanToken, K.LessThanEqualsToken, K.GreaterThanToken, K.GreaterThanEqualsToken]);
  const found = {};
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("formats/"))) {
    const sf = await parse(file);
    let count = 0;
    const visit = (node) => {
      if (ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind) &&
        /formatVersion/.test(`${node.left.getText(sf)} ${node.right.getText(sf)}`)) count += 1;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (count) found[file] = count;
  }
  assert.deepEqual(found, RAW_FORMAT_COMPARISONS);
});

// Every module that exported a formats-owned name at BASE still does, and
// re-exports the formats binding itself rather than a copy.
const COMPAT = {
  "core.mjs": ["MIGRATION_FORMAT_VERSION", "RESUMABLE_CONTRACT_VERSION", "compatibilityBlocker", "stepsFor", "MIGRATION_STEPS", "assertNoPendingFormatUpgrade", "resolveDesignSource", "validateToolkitIdentity"],
  "resumable-migration.mjs": ["MIGRATION_FORMAT_VERSION", "SUPPORTED_FORMAT_VERSIONS", "NON_PROMOTING_FORMAT_VERSIONS", "stampedFormatVersion", "assertNoPendingFormatUpgrade", "DECISIONS_FILE", "MIGRATION_STEPS", "LEGACY_MIGRATION_STEPS", "compatibilityBlocker", "upgradeCommandFor", "FORMAT_UPGRADERS"],
  "artifact/artifact-migration.mjs": ["ARTIFACT_CONTRACT_VERSION", "ARTIFACT_FORMAT_VERSION", "ARTIFACT_FORMAT_UPGRADE_FLOOR", "artifactFormatUpgrade", "assertArtifactToolkitIdentity", "ARTIFACT_FORMAT_UPGRADERS"],
  "migration-utils.mjs": ["DESIGN_SOURCES", "assertFigmaSource", "resolveDesignSource", "PONYTAIL_TARGETS", "assertPonytailTarget"],
  "format-upgrade.mjs": ["nextIncrement", "upgradeIsActive", "classifyUpgrade", "assertRegistryCoverage", "upgradeProjection"],
  "toolkit-identity.mjs": ["TOOLKIT_IDENTITY_KEYS", "BUILD_IDENTITY_FILE", "validateToolkitIdentity", "toolkitIdentityBlocker", "activeToolkitIdentity", "resetActiveToolkitIdentity"],
  "upgrades/upgrade-migration.mjs": ["renderUpgradePreview", "renderRollbackPreview"],
  "store/index.mjs": ["HISTORY_FILE", "INTEGRITY_FILE"],
};

test("A2-ARCH-4: historical compatibility exports remain, as the formats binding itself", async () => {
  for (const [file, names] of Object.entries(COMPAT)) {
    const module = await import(pathToFileURL(path.join(src, file)).href);
    for (const name of names) assert.ok(Object.hasOwn(module, name), `${file} no longer exports ${name}`);
    for (const name of Object.keys(module)) {
      if (Object.hasOwn(formats, name)) assert.equal(module[name], formats[name], `${file} ${name} is a copy`);
    }
  }
});

// -- record layout owned by formats, persisted by store --------------------------

test("formats owns the record-layout names store persists, with their exact values", () => {
  assert.equal(formats.HISTORY_FILE, "history/history.ndjson");
  assert.equal(formats.INTEGRITY_FILE, "integrity.json");
  assert.equal(store.HISTORY_FILE, formats.HISTORY_FILE);
  assert.equal(store.INTEGRITY_FILE, formats.INTEGRITY_FILE);
  assert.equal(formats.initialArtifacts.history, formats.HISTORY_FILE);
});

// -- predicates ----------------------------------------------------------------

test("each format predicate turns on exactly at its format, and an unstamped record is format 1", () => {
  for (const [format, uses] of [
    [formats.DISCOVERY_COMPLETENESS_FORMAT, formats.usesDiscoveryCompleteness],
    [formats.CAPABILITY_OWNERSHIP_FORMAT, formats.usesCapabilityOwnership],
    [formats.UI_VERIFICATION_FORMAT, formats.usesUiVerification],
    [formats.ARTIFACT_DELEGATION_FORMAT, formats.usesArtifactDelegation],
    [formats.DESIGN_SOURCE_FORMAT, formats.usesDesignSource],
    [formats.MULTI_SOURCE_FORMAT, formats.usesMultiSource],
    [formats.SLICE_REWORK_FORMAT, formats.usesSliceRework],
    [formats.VISUAL_ACCEPTANCE_FORMAT, formats.usesVisualAcceptance],
    [formats.REQUIRED_OBSERVATIONS_FORMAT, formats.usesRequiredObservations],
    [formats.DIRECT_LEDGER_DECISIONS_FORMAT, formats.usesDirectLedgerDecisions],
  ]) {
    assert.equal(uses({ formatVersion: format - 1 }), false, `${format}`);
    assert.equal(uses({ formatVersion: format }), true, `${format}`);
    assert.equal(uses({}), false, `${format}`);
  }
  assert.equal(formats.usesIntegrityAnchor({ formatVersion: 8 }), false);
  assert.equal(formats.usesIntegrityAnchor({ formatVersion: 9 }), true);
  assert.equal(formats.usesIntegrityAnchor({}), false);
  assert.throws(() => formats.usesIntegrityAnchor(undefined), TypeError, "the unguarded read callers relied on");
  assert.deepEqual([12, 13, 14, 15, undefined].map(formats.usesArtifactDirectLedger), [false, false, true, false, false]);
});

test("historical formats keep their lifecycle and are never promoted by an advance", () => {
  assert.deepEqual(formats.SUPPORTED_FORMAT_VERSIONS, Array.from({ length: 16 }, (_, index) => 4 + index));
  for (const format of formats.SUPPORTED_FORMAT_VERSIONS) assert.equal(formats.formatIsSupported(format), true, `${format}`);
  for (const format of [1, 2, 3, 20, "19"]) assert.equal(formats.formatIsSupported(format), false, `${format}`);
  assert.equal(formats.stepsFor({ formatVersion: 9 }), formats.LEGACY_MIGRATION_STEPS);
  assert.equal(formats.stepsFor({ formatVersion: 10 }), formats.MIGRATION_STEPS);
  for (const format of formats.NON_PROMOTING_FORMAT_VERSIONS) assert.equal(formats.formatIsPromoting(format), false, `${format}`);
  // A format-18 record with every 18 feature is stamped 18, not promoted to 19.
  assert.equal(formats.stampedFormatVersion({ formatVersion: 18 }), 18);
  assert.equal(formats.stampedFormatVersion({ formatVersion: 19 }), 19);
});

test("the compatibility classification is formats', and the engine binds the same refusal bytes", () => {
  const render = (name) => `RENDERED ${name}`;
  for (const state of [
    { contractVersion: 5, formatVersion: 19 },
    { contractVersion: 5, formatVersion: 4 },
    { contractVersion: 4, formatVersion: 3 },
    { contractVersion: 5, formatVersion: 20 },
    { contractVersion: 6, formatVersion: 19 },
    { contractVersion: 5, formatVersion: 3 },
    { contractVersion: 5 },
  ]) {
    const engine = compatibilityBlocker(state, "orders");
    assert.equal(engine, formats.recordCompatibilityBlocker(state, "orders", upgradeCommandFor), JSON.stringify(state));
    assert.equal(formats.recordCompatibilityBlocker(state, "orders", render)?.includes("RENDERED orders") ?? false,
      state.contractVersion === 4, JSON.stringify(state));
  }
  assert.match(compatibilityBlocker({ contractVersion: 4, formatVersion: 3 }, "orders"), /Run the explicit upgrade first: node .*upgrade-migration\.mjs orders$/);
  assert.throws(() => formats.validateRecordStateShape({ contractVersion: 4, formatVersion: 3 }, "orders", render), /Run the explicit upgrade first: RENDERED orders$/);
});

// -- the split registries (baseline §4.1) ---------------------------------------

const ELIGIBILITY = ["from", "to", "id", "version", "requiredInput", "activation"];
const HANDLERS = ["domain", "plan", "commit"];

test("each engine's upgrader rows are its formats increments plus runtime handlers, in the same order", () => {
  for (const [increments, upgraders] of [
    [formats.FORMAT_INCREMENTS, FORMAT_UPGRADERS],
    [formats.ARTIFACT_FORMAT_INCREMENTS, ARTIFACT_FORMAT_UPGRADERS],
  ]) {
    assert.ok(Object.isFrozen(increments) && Object.isFrozen(upgraders));
    assert.equal(upgraders.length, increments.length);
    increments.forEach((increment, index) => {
      const row = upgraders[index];
      assert.ok(Object.isFrozen(increment) && Object.isFrozen(row));
      assert.deepEqual(Object.keys(increment), ELIGIBILITY, "formats holds eligibility only");
      for (const field of ELIGIBILITY) assert.equal(row[field], increment[field], field);
      for (const field of HANDLERS) assert.equal(typeof row[field], "function", field);
    });
    // The pure table alone is not a shippable registry: the release gate still
    // demands every handler.
    assert.throws(() => formats.assertRegistryCoverage({
      floor: increments[0].from, runtimeFormat: increments.at(-1).to, registry: increments,
    }), /must declare a callable domain/);
  }
});

test("the freeze gate and artifact admission read only the formats increments", () => {
  const pinned = { formatVersion: 17, artifactHashes: { [formats.initialArtifacts.legacyInventory]: "sha256:x" } };
  assert.doesNotThrow(() => formats.assertNoPendingFormatUpgrade({ formatVersion: 17 }, "orders", "Advancing"));
  assert.throws(() => formats.assertNoPendingFormatUpgrade(pinned, "orders", "Advancing"), (error) => error.formatUpgrade === true);
  for (const format of [18, 19, 16]) assert.doesNotThrow(() => formats.assertNoPendingFormatUpgrade({ formatVersion: format }, "orders", "Advancing"));

  assert.equal(artifactFormatUpgrade({ formatVersion: ARTIFACT_FORMAT_VERSION }), null);
  const pending = artifactFormatUpgrade({ formatVersion: 13 });
  assert.deepEqual([pending.from, pending.to, pending.state, pending.active, pending.upgrader],
    [13, 14, "INACTIVE", false, { id: "PRISTINE_ARTIFACT_ADOPTED", version: 1 }]);
});
