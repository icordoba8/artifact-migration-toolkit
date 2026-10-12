// Track A8: the lifecycle/ boundary (docs/architecture/a8-ownership.md). The
// lifecycle behavior is covered where it always was: migration-contract,
// artifact-migration, format-upgrades, record-decision, toolkit-identity,
// live-history-replay, operator-approval-authority, artifact-delegation and
// the golden trace. This file pins the module boundary, the facades and the
// location-sensitive loaders A8 relies on.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import * as lifecycle from "../../src/lifecycle/index.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const enginePackage = path.resolve(src, "..");
const ts = createRequire(import.meta.url)("ts-discovery-compiler");
const execFileAsync = promisify(execFile);

const engineFiles = async () =>
  (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".mjs")).map((file) => file.split(path.sep).join("/"));
const parse = async (file) =>
  ts.createSourceFile(file, await readFile(path.join(src, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declared = (sf) => sf.statements.flatMap((statement) =>
  ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? [statement.name.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((d) => d.name.getText(sf)) : []);
/** Every relative target a file names, `src/`-relative: static, re-export and (unless excluded) dynamic. */
const targets = (file, sf, { dynamic = true } = {}) => {
  const found = [];
  const visit = (node) => {
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = node.moduleSpecifier.text;
    else if (dynamic && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      spec = ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "<dynamic>";
    }
    if (spec === "<dynamic>") found.push(spec);
    else if (spec?.startsWith(".")) found.push(path.posix.join(path.posix.dirname(file), spec));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};
const load = (file) => import(pathToFileURL(path.join(src, file)).href);

const LIFECYCLE_FILES = [
  "adoption.mjs", "advance.mjs", "approval.mjs", "artifact-checkpoints.mjs", "artifact-execution.mjs", "artifact-record.mjs",
  "artifact-run.mjs", "artifact-status.mjs", "artifact-transaction.mjs", "bootstrap.mjs", "checkpoints.mjs", "context.mjs",
  "contract-upgrade.mjs", "format-upgrade.mjs", "index.mjs", "lock.mjs", "openspec.mjs", "policy.mjs", "preview.mjs",
  "progress.mjs", "record.mjs", "recorder.mjs", "registry.mjs", "reopen.mjs", "status.mjs", "templates.mjs",
  "toolkit-identity.mjs", "validation.mjs",
];

/**
 * The historical lifecycle paths. Each declares nothing (migration-utils keeps
 * only the doctor, an installed contract) and re-exports its BASE names, the
 * lifecycle ones from lifecycle/index.mjs. `renamed` maps a facade name to the
 * index name where module and artifact contracts share a historical name.
 */
const FACADES = {
  "resumable-migration.mjs": { renamed: { pendingTargetDriftCandidates: "pendingTargetDriftCandidatesCompat" } },
  "artifact/artifact-migration.mjs": { renamed: { checkpointArtifacts: "artifactCheckpointArtifacts" } },
  "decision-recorder.mjs": {},
  "operator-approval.mjs": {},
  "lifecycle-policy.mjs": {},
  "module-lock.mjs": {},
  "upgrades/upgrade-coordinator.mjs": {},
  "migration-utils.mjs": { declares: ["doctorCheck", "existingKnowledgeRoot", "MINIMUM_NODE_MAJOR", "runDoctor"] },
};

// Generated from BASE 0a87bbc: every export name, and its arity when it is a function.
const BASE_EXPORTS = {
  "resumable-migration.mjs": {
    ADOPTION_ROOT: null, ARTIFACT_DELEGATION_FORMAT: null, AUTO_DECISIONS_FILE: null, BASELINE_ROWS_PIN: null,
    BLOCKED_EXIT_CODE: null, CAPABILITY_OWNERSHIP_FILE: null, CAPABILITY_OWNERSHIP_FORMAT: null,
    CHECKPOINT_STATES: null, DECISIONS_FILE: null, DECISION_GROUP_KIND: null, DECISION_PRINCIPALS: null,
    DECISION_PROJECTION_STATES: null, DECISION_RESULTS: null, DEFAULT_DECISION_POLICY_DIGEST: null,
    DEFAULT_DECISION_POLICY_ID: null, DEFAULT_MODE: null, DESIGN_SOURCE_FORMAT: null,
    DIRECT_LEDGER_DECISIONS_FORMAT: null, DIRECT_LEDGER_PINNED_ARTIFACTS: null, DISCOVERY_COMPLETENESS_FORMAT: null,
    DISCOVERY_PIN: null, DISCOVERY_SCAN_FILE: null, EARLIEST_SUPPORTED_FORMAT: null,
    FIGMA_CONTEXT_ADOPTION_FILE: null, FIGMA_CONTEXT_FILE: null, FINAL_GATES: null,
    FORMAT_ACTIVE_FOR_NEW_MIGRATIONS: null, FORMAT_UPGRADERS: null, FORMAT_UPGRADE_FLOOR: null,
    LATE_DECISION_KINDS: null, LEGACY_AUTHORITY_ROLE: null, LEGACY_COMPATIBILITY_ACTION_REQUIRED: null,
    LEGACY_MIGRATION_STEPS: null, LEGACY_RUNTIME_CONTEXT_FILE: null, LEGACY_RUNTIME_EVIDENCE_ROOT: null,
    LegacyCompatibilityActionRequired: 1, MAX_SLICE_REWORKS: null, MIGRATION_FORMAT_SUPPORTED: null,
    MIGRATION_FORMAT_VERSION: null, MIGRATION_STEPS: null, MODULE_CLASSIFICATION_FILE: null,
    MULTI_SOURCE_FORMAT: null, NON_PROMOTING_FORMAT_VERSIONS: null, PROVISIONAL_VISUAL_DIFF_THRESHOLDS: null,
    REOPEN_ROOT: null, REQUIRED_OBSERVATIONS_FORMAT: null, RESUMABLE_CONTRACT_VERSION: null, REWORK_ROOT: null,
    SLICE_AMENDMENT_ROOT: null, SLICE_REWORK_FORMAT: null, STEP_DEPENDENCIES: null, SUPPORTED_FORMAT_VERSIONS: null,
    TARGET_BASELINE_FILE: null, TARGET_DIRTY_SCOPE: null, TARGET_VERIFICATION_ROLE: null,
    UI_OBSERVATIONS_ADOPTION_ROOT: null, UI_OBSERVATIONS_CANDIDATE_FILE: null, UI_PROOF_FORMAT: null,
    UI_REMEDIATION_FILE: null, UI_RUNTIME_STATES: null, UI_VERIFICATION_FORMAT: null,
    UPGRADABLE_CONTRACT_VERSION: null, UPGRADABLE_FORMAT_VERSION: null, VISUAL_ACCEPTANCE_FILE: null,
    VISUAL_ACCEPTANCE_FORMAT: null, VISUAL_AUTHORITIES: null, VISUAL_UNBACKED_KIND: null, WORKFLOW_VERSION: null,
    activeArtifact: 1, adoptUiObservations: 1, advanceMigration: 1, artifactBindingFor: 2,
    artifactPrerequisiteWork: 2, assertArtifactPrerequisites: 3, assertDirectLedgerEligible: 1,
    assertDiscoveryCompletenessFormat: 3, assertExecutionConfirmation: 2, assertNoPendingFormatUpgrade: 3,
    assertRecordToolkitIdentity: 3, assertRequiredObservations: 1, assertToolkitIdentityNotMismatched: 2,
    attestationVerifierScope: null, attestedLineProblem: 1, authoringRequest: 1, autoAdoptToolkitIdentity: 1,
    bootstrapMigration: 1, brandSequenceAuthorization: 1, candidateDigestOf: 1, changeModuleToolkitIdentity: 1,
    checkpointAction: 1, checkpointArtifacts: 1, commitFormatUpgrade: 1, commitNoOpFormatUpgrade: 1,
    compareVisualEvidence: 1, compareVisualFact: 3, compatibilityBlocker: 2, createDecisionCandidate: 1,
    createNewFormatDecisionCandidate: 1, createNewFormatDecisionGroup: 1, decisionAppliesToCandidate: 2,
    decisionChannelOf: 1, decisionGroupFor: 2, decisionKindAllowed: 2, decisionLineDigest: 1,
    decisionLineProblem: 1, decisionPrincipalOf: 1, decisionRationaleDigest: 1,
    delegatedChangedFilesSatisfiedByChild: 3, directLedgerAdoptionPreview: 1, edgeDecisionSubject: 1,
    expectedNextCheckpoint: 1, figmaMetadataAncestry: 2, formatIsPromoting: 1, formatIsSupported: 1,
    getMigrationStatus: 1, inspectSliceArtifacts: 1, isAutoAuthority: 1, isBrownfield: 1,
    isUiObservationsAdoption: 1, legacySourceBinding: 1, legacySourcesOf: 1, lifecycleBinding: 2,
    loadOpenSpecAuthority: 2, migrationProgress: 1, migrationRoot: 2, pendingFormatUpgrade: 4,
    pendingTargetDriftCandidates: 3, pendingVisualUnbackedCandidates: 3, previewAdvance: 0, previewDiscoveryScan: 1,
    previewMigrationExecution: 0, previewUiObservationsAdoption: 1, principalSatisfiesRequirement: 2,
    projectModuleDecision: 1, rawDecisionLedgerBytes: 1, rawDecisionLedgerDigest: 1, readAutoDecisions: 1,
    readCanonicalModuleBoundary: 3, readMigrationContext: 1, readOperatorDecisions: 1, readRecordedDecisions: 1,
    readState: 2, reconcileSliceState: 2, recoverMigrationRecord: 1, renderAdvancePreview: 1,
    renderLoopDirective: 1, renderProgress: 1, renderProgressBlock: 1, renderProgressChecklist: 2,
    renderTargetBaseline: 1, renderToolkitAdoption: 1, repairSliceState: 2, resolveApplicableDecision: 1,
    resolveGroupDecision: 2, resolveHistoricalRequiredPrincipal: 4, resolveRequiredPrincipal: 2,
    reworkLimitBlocker: 1, reworkPathParts: 1, sequenceAuthorizationEvidence: 1, sliceDriftFacts: 2,
    sliceLacksUiProofV1: 3, sourceOfEvidence: 2, stampedFormatVersion: 1, stepsFor: 1, toolkitAdoptCommand: 1,
    unclaimedTargetDrift: 1, upgradeCommandFor: 1, usesArtifactDelegation: 1, usesCapabilityOwnership: 1,
    usesDesignSource: 1, usesDirectLedgerDecisions: 1, usesDiscoveryCompleteness: 1, usesMultiSource: 1,
    usesRequiredObservations: 1, usesSliceRework: 1, usesUiVerification: 1, usesVisualAcceptance: 1,
    validateArtifactDelegationRow: 3, validateDiscoveryCompleteness: 3, validateFigmaContext: 2,
    validateLegacyRuntimeContext: 2, validateOpenSpecProposal: 2, validateProtectedDecisionPolicy: 2,
    validateResumableMigration: 0, validateVisualAcceptance: 5, visualAuthorityOf: 1,
  },
  "artifact/artifact-migration.mjs": {
    ARTIFACT_CONTRACT_VERSION: null, ARTIFACT_FORMAT_ACTIVE_FOR_NEW_MIGRATIONS: null,
    ARTIFACT_FORMAT_SUPPORTED: null, ARTIFACT_FORMAT_UPGRADERS: null, ARTIFACT_FORMAT_UPGRADE_FLOOR: null,
    ARTIFACT_FORMAT_VERSION: null, ARTIFACT_RESOLUTIONS: null, ARTIFACT_WORKFLOW_VERSION: null,
    architectureFindings: 2, artifactArgumentsFor: 1, artifactCommandFor: 1, artifactDecisionBoundTo: 1,
    artifactDecisionCandidate: 2, artifactEvidenceDigest: 1, artifactFormatUpgrade: 1, artifactIdFor: 1,
    artifactMetrics: 0, artifactOperatorDecisions: 0, artifactRoot: 2, assertArtifactToolkitIdentity: 3,
    bootstrapArtifact: 0, changeArtifactToolkitIdentity: 0, checkpointArtifacts: 1, getArtifactStatus: 0,
    hasCodeValidationCheck: 4, hasExecutableCodeFiles: 1, legacyDependencies: 2, previewArtifact: 0,
    previewArtifactFormatUpgrade: 0, progressState: 1, readArtifactState: 2, reconcileArtifactDecisions: 2,
    resolveArtifact: 0, runArtifact: 0, structuralUnits: 3, targetTypeScript: 1, upgradeArtifactFormat: 0,
    validateArtifactComplete: 0,
  },
  "decision-recorder.mjs": {
    APPROVAL_CHANNELS: null, APPROVAL_EVIDENCE_PHRASES: null, DECISION_KINDS: null, SIGNER_UNAVAILABLE: null,
    approvedByPhrase: 1, assertReviewedCandidateCurrent: 2, auditDecisionLedger: 1, autoApprovalChannel: 1,
    autoMayDecide: 1, beginAttestedDecision: 1, buildDecision: 1, challengeFor: 1, channelOf: 1,
    completeAttestedDecision: 1, groupFactsDigest: 1, ledgerFileForChannel: 1, parseDecisionArguments: 1,
    pendingDecisionCandidates: 1, projectDecisions: 1, rationaleDigestOf: 1, recordNewFormatDecisionGroup: 1,
    relayOperatorDecision: 1, renderDecisionReview: 1, reviewAttestedCandidate: 1, reviewFor: 1, reviewReference: 1,
    runRecordDecisionCli: 1,
  },
  "operator-approval.mjs": {
    approveWithOperator: 4, artifactApprover: 2, moduleApprover: 2, recorderFor: 0, renderCandidateBlock: 1,
    renderGroupBlock: 1,
  },
  "lifecycle-policy.mjs": {
    MIGRATION_MODES: null, MIGRATION_OUTCOMES: null, exitCodeFor: 1, isAutoAuthority: 1, maySelfConfirm: 0,
    nextOutcome: 0,
  },
  "module-lock.mjs": {
    acquireModuleLock: 2, lockPathFor: 2, processAlive: 1, withModuleLock: 4, writeJournalAtomic: 2,
  },
  "upgrades/upgrade-coordinator.mjs": {
    TRANSACTION_STATES: null, executeRollback: 1, executeUpgrade: 1, pendingTransactions: 2, previewRollback: 0,
    previewUpgrade: 0, recoverTransaction: 1, recoverUpgrade: 0, renderRollbackPreview: 1, renderUpgradePreview: 1,
  },
  "migration-utils.mjs": {
    CONTENT_IDENTITY_BYTES: null, CONTENT_IDENTITY_TEXT: null, DESIGN_SOURCES: null, PONYTAIL_TARGETS: null,
    assertFigmaSource: 1, assertNoPendingTransaction: 2, assertPonytailTarget: 1, assertProjectRootContainment: 2,
    assertSafeName: 1, assertSecurePath: 2, atomicWrite: 3, commitsIntroducingBlob: 3, commitsTouchingSince: 3,
    committedChangesSince: 2, contentIdentity: 2, contentIdentityMatches: 3, dirtyManifest: 1, fileAtRevision: 3,
    fileContentIdentity: 3, fileContentIdentityMatches: 4, gitRevision: 1, headRevision: 1, isAncestorCommit: 3,
    isContentIdentity: 1, isTextIdentityEligible: 2, parseContentIdentity: 1, pendingTransactions: 2,
    persistProjectRegistryBinding: 1, previewProjectRegistryBinding: 2, previewRegistryUpdate: 1, readRegistry: 1,
    registryIdentity: 2, renderRegistryPreview: 1, resolveDesignSource: 0, resolveLegacySources: 1,
    resolveModule: 3, resolveRegistryPath: 0, runDoctor: 0, updateRegistry: 1,
  },
};
// The engine files below lifecycle in option (b). None may name lifecycle/ or a
// lifecycle facade, statically or lazily.
const LOWER = /^(shared|formats|store|decisions|census|visual|slices)\/|^(engine-paths|toolkit-identity|operator-webauthn|operator-signer|discovery-scan|visual-evidence)\.mjs$|^upgrades\/upgrade-v4-to-v5\.mjs$/;
const LIFECYCLE_PATHS = /^(lifecycle\/|resumable-migration\.mjs$|artifact\/artifact-migration\.mjs$|decision-recorder\.mjs$|operator-approval\.mjs$|lifecycle-policy\.mjs$|module-lock\.mjs$|migration-utils\.mjs$|upgrades\/upgrade-(coordinator|migration)\.mjs$|record-decision\.mjs$|migration-policy\.mjs$|core\.mjs$)/;

test("A8-ARCH-1: lifecycle has one public entry, which only re-exports the BASE lifecycle API", async () => {
  assert.deepEqual((await readdir(path.join(src, "lifecycle"))).sort(), [...LIFECYCLE_FILES].sort());
  const index = await parse("lifecycle/index.mjs");
  for (const statement of index.statements) {
    assert.ok(ts.isExportDeclaration(statement) && statement.moduleSpecifier, "lifecycle/index.mjs only re-exports");
    assert.match(statement.moduleSpecifier.text, /^\.\/[\w-]+\.mjs$/);
  }
  // The entry is exactly what the historical paths take from it: no internal leaks out.
  const taken = new Set();
  for (const [facade, { renamed = {} }] of Object.entries(FACADES)) {
    for (const statement of (await parse(facade)).statements) {
      if (!ts.isExportDeclaration(statement) || !/lifecycle\/index\.mjs$/.test(statement.moduleSpecifier.text)) continue;
      for (const element of statement.exportClause.elements) taken.add((element.propertyName ?? element.name).text);
    }
    for (const name of Object.values(renamed)) assert.ok(taken.has(name), `${facade} takes ${name}`);
  }
  assert.deepEqual(Object.keys(lifecycle).sort(), [...taken].sort());
  assert.equal(Object.keys(lifecycle).length, 106);
});

test("A8-ARCH-2: outside lifecycle/, only lifecycle/index.mjs is named; old lifecycle paths are named only by facades and the aggregator", async () => {
  const offenders = [];
  // The facades over facades are A7's bin and policy facades and the package aggregator; they name old paths, not lifecycle/.
  const OLD_PATH_IMPORTERS = new Set(["core.mjs", "cli/run-migration.mjs", "mcp-server.mjs", "migration-policy.mjs", "record-decision.mjs", "upgrades/upgrade-migration.mjs"]);
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("lifecycle/"))) {
    for (const target of targets(file, await parse(file))) {
      if (target.startsWith("lifecycle/") && target !== "lifecycle/index.mjs") offenders.push(`${file} -> ${target}`);
      if (/^(resumable-migration|artifact\/artifact-migration|decision-recorder|operator-approval|lifecycle-policy|module-lock|upgrades\/upgrade-coordinator)\.mjs$/.test(target) &&
        !OLD_PATH_IMPORTERS.has(file)) offenders.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(offenders, []);
  // Transport reaches lifecycle through the entry, and uses it.
  const transportTargets = new Set();
  for (const file of (await engineFiles()).filter((file) => file.startsWith("transport/"))) {
    for (const target of targets(file, await parse(file))) transportTargets.add(target);
  }
  assert.ok(transportTargets.has("lifecycle/index.mjs"));
});

test("A8-ARCH-3: nothing below lifecycle names it; lifecycle names only lower entries; no static or lazy cycle remains", async () => {
  const files = await engineFiles();
  const edges = new Map();
  for (const file of files) {
    const sf = await parse(file);
    edges.set(file, { static: targets(file, sf, { dynamic: false }), all: targets(file, sf) });
    if (LOWER.test(file)) {
      assert.deepEqual(edges.get(file).all.filter((target) => LIFECYCLE_PATHS.test(target) || target.startsWith("transport/")), [], file);
    }
    if (file.startsWith("lifecycle/")) {
      for (const target of edges.get(file).all) {
        assert.ok(
          target.startsWith("lifecycle/") ||
            /^(shared|formats|store|decisions|census|visual|slices)\/index\.mjs$/.test(target) ||
            /^(engine-paths|toolkit-identity|operator-webauthn)\.mjs$|^upgrades\/upgrade-v4-to-v5\.mjs$/.test(target),
          `${file} -> ${target}`,
        );
        assert.notEqual(target, "lifecycle/index.mjs", `${file} imports its own entry`);
      }
    }
  }
  // Tarjan over files: BASE had one lazily closed component of five lifecycle
  // files; A8 removed it, so neither graph has any component now.
  const components = (kind) => {
    let index = 0;
    const order = new Map(); const low = new Map(); const stack = []; const open = new Set(); const found = [];
    const visit = (v) => {
      order.set(v, index); low.set(v, index++); stack.push(v); open.add(v);
      for (const w of edges.get(v)[kind].filter((target) => edges.has(target))) {
        if (!order.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
        else if (open.has(w)) low.set(v, Math.min(low.get(v), order.get(w)));
      }
      if (low.get(v) !== order.get(v)) return;
      const component = [];
      let w;
      do { w = stack.pop(); open.delete(w); component.push(w); } while (w !== v);
      if (component.length > 1) found.push(component.sort());
    };
    for (const file of files) if (!order.has(file)) visit(file);
    return found;
  };
  assert.deepEqual(components("static"), []);
  assert.deepEqual(components("all"), []);
  // The lazy imports left in lifecycle are downward or optional-dependency loads.
  const lazy = [];
  for (const file of files.filter((file) => file.startsWith("lifecycle/"))) {
    const all = edges.get(file).all; const stat = new Set(edges.get(file).static);
    for (const target of all) if (!stat.has(target) || all.filter((t) => t === target).length > edges.get(file).static.filter((t) => t === target).length) lazy.push(`${file} -> ${target}`);
  }
  assert.deepEqual([...new Set(lazy)].sort(), [
    "lifecycle/advance.mjs -> lifecycle/policy.mjs",
    "lifecycle/recorder.mjs -> operator-webauthn.mjs",
    "lifecycle/status.mjs -> lifecycle/recorder.mjs",
    "lifecycle/validation.mjs -> census/index.mjs",
  ]);
});

test("A8-ARCH-4: one live implementation per lifecycle export, inside lifecycle/; the facades declare nothing", async () => {
  const owners = new Map();
  for (const file of await engineFiles()) {
    for (const name of declared(await parse(file))) owners.set(name, [...(owners.get(name) ?? []), file]);
  }
  // Each index name resolves to one declaration inside lifecycle/ (the aliased
  // names are declared under their file-local name).
  const index = await parse("lifecycle/index.mjs");
  for (const statement of index.statements) {
    const file = path.posix.join("lifecycle", statement.moduleSpecifier.text);
    for (const element of statement.exportClause.elements) {
      const local = (element.propertyName ?? element.name).text;
      assert.ok(declared(await parse(file)).includes(local), `${file} declares ${local}`);
      // A same-named declaration elsewhere is only a different rule with its own contract (module vs artifact, contract upgrade vs artifact transaction).
      const elsewhere = (owners.get(local) ?? []).filter((owner) => owner !== file);
      assert.ok(elsewhere.every((owner) => owner.startsWith("lifecycle/")), `${local}: ${elsewhere}`);
    }
  }
  for (const [facade, { declares = [] }] of Object.entries(FACADES)) {
    assert.deepEqual(declared(await parse(facade)).sort(), [...declares].sort(), facade);
  }
  // The monoliths' bodies are gone: no lifecycle export is declared at an old path.
  for (const file of ["resumable-migration.mjs", "artifact/artifact-migration.mjs", "decision-recorder.mjs", "operator-approval.mjs"]) {
    assert.ok((await readFile(path.join(src, file), "utf8")).split("\n").length < 220, file);
  }
});

test("A8-ARCH-5: every historical path exports its BASE names and arities, as the lifecycle bindings", async () => {
  for (const [facade, { renamed = {} }] of Object.entries(FACADES)) {
    const module = await load(facade);
    assert.deepEqual(Object.keys(module).sort(), Object.keys(BASE_EXPORTS[facade]).sort(), facade);
    for (const [name, arity] of Object.entries(BASE_EXPORTS[facade])) {
      if (arity !== null) assert.equal(module[name].length, arity, `${facade} ${name} arity`);
      const lifecycleName = renamed[name] ?? name;
      if (Object.hasOwn(lifecycle, lifecycleName)) assert.equal(module[name], lifecycle[lifecycleName], `${facade} ${name} binding`);
    }
  }
  // The shared names are one binding across every path that exports them.
  const paths = await Promise.all(["resumable-migration.mjs", "core.mjs", "lifecycle-policy.mjs", "migration-policy.mjs", "operator-approval.mjs"].map(load));
  for (const name of ["isAutoAuthority", "BLOCKED_EXIT_CODE"]) {
    for (const module of paths.filter((module) => Object.hasOwn(module, name))) assert.equal(module[name], lifecycle[name], name);
  }
  const [record, upgrade, utils, core] = await Promise.all(["record-decision.mjs", "upgrades/upgrade-migration.mjs", "migration-utils.mjs", "core.mjs"].map(load));
  for (const name of Object.keys(BASE_EXPORTS["decision-recorder.mjs"])) assert.equal(record[name], (await load("decision-recorder.mjs"))[name], name);
  for (const name of Object.keys(BASE_EXPORTS["upgrades/upgrade-coordinator.mjs"])) assert.equal(upgrade[name], (await load("upgrades/upgrade-coordinator.mjs"))[name], name);
  assert.equal(utils.pendingTransactions, lifecycle.pendingTransactions);
  assert.equal(core.bootstrapMigration, lifecycle.bootstrapMigration);
  assert.equal(core.executeMigration, lifecycle.bootstrapMigration);
  // Module and artifact readers that share a historical name stay two functions.
  const [moduleEngine, artifactEngine] = await Promise.all(["resumable-migration.mjs", "artifact/artifact-migration.mjs"].map(load));
  assert.notEqual(moduleEngine.checkpointArtifacts, artifactEngine.checkpointArtifacts);
  assert.equal(moduleEngine.pendingTargetDriftCandidates.length, 3);
});

test("A8-ARCH-6: the module lock and every journal stay lifecycle-controlled, with their BASE names", async () => {
  const LOCK = /\b(withModuleLock|acquireModuleLock|writeJournalAtomic)\b/;
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("lifecycle/"))) {
    const sf = await parse(file);
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      assert.doesNotMatch(statement.getText(sf), LOCK, `${file} imports a lock primitive`);
    }
  }
  // Only the aggregator and the lock facade still name them in code (comments aside).
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("lifecycle/"))) {
    const sf = await parse(file);
    let named = false;
    const visit = (node) => { if (ts.isIdentifier(node) && LOCK.test(node.text)) named = true; ts.forEachChild(node, visit); };
    visit(sf);
    if (named) assert.ok(["core.mjs", "module-lock.mjs"].includes(file), file);
  }
  const text = Object.fromEntries(await Promise.all(["record.mjs", "bootstrap.mjs", "artifact-transaction.mjs", "registry.mjs", "contract-upgrade.mjs", "lock.mjs"]
    .map(async (file) => [file, await readFile(path.join(src, "lifecycle", file), "utf8")])));
  assert.match(text["record.mjs"], /^export const ADVANCE_JOURNAL = "advance\.journal";$/m);
  assert.match(text["bootstrap.mjs"], /"\.agents\/knowledge\/migrations\/init",/);
  assert.match(text["artifact-transaction.mjs"], /TRANSACTION_FILE/);
  assert.match(text["registry.mjs"], /registryJournalPathFor\(fresh\.targetRoot\)/);
  assert.match(text["contract-upgrade.mjs"], /"upgrade\.lock"/);
  assert.match(text["lock.mjs"], /^const LOCK_ROOT = /m);
  // The lock path is the BASE one.
  assert.equal(lifecycle.lockPathFor("/t", "m"), path.join("/t", ".agents/knowledge/migrations/locks", "m.lock"));
});

test("A8-ARCH-7: lifecycle reaches the decision ledgers only through the recorder, under the module lock", async () => {
  const WRITE = /\b(appendDurably|appendApprovedCandidate|appendApprovedGroup|buildDecision|operatorAnswer|relayAnswer|lockedApprovalCandidate)\b/;
  for (const file of LIFECYCLE_FILES.filter((file) => file !== "recorder.mjs")) {
    const sf = await parse(`lifecycle/${file}`);
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement)) assert.doesNotMatch(statement.getText(sf), WRITE, `lifecycle/${file}`);
    }
  }
  const recorder = await readFile(path.join(src, "lifecycle/recorder.mjs"), "utf8");
  // Every append happens inside the lock taken by the one approval path.
  assert.match(recorder, /const withOperatorApproval = [\s\S]*?withModuleLock\(/);
  assert.equal((recorder.match(/\bwithModuleLock\(/g) ?? []).length >= 1, true);
  // The offer loop records only through the recorder entry, and composes no verdict.
  const approval = await readFile(path.join(src, "lifecycle/approval.mjs"), "utf8");
  assert.equal((approval.match(/runRecordDecisionCli\(/g) ?? []).length, 2);
  assert.doesNotMatch(approval, /operator-decisions\.ndjson|isTTY:\s*true|"(TERMINAL|ELICITATION)"/);
  // The artifact run loop takes its recorder from the offer loop, never a ledger.
  const run = await readFile(path.join(src, "lifecycle/artifact-run.mjs"), "utf8");
  assert.match(run, /from "\.\/approval\.mjs"/);
  assert.doesNotMatch(run, WRITE);
  // The recorder and offer loop keep their BASE API, exactly.
  const fromRecorder = new Set();
  for (const statement of (await parse("lifecycle/index.mjs")).statements) {
    if (/\.\/(recorder|approval)\.mjs$/.test(statement.moduleSpecifier.text)) for (const element of statement.exportClause.elements) fromRecorder.add(element.name.text);
  }
  const ownRecorder = Object.keys(BASE_EXPORTS["decision-recorder.mjs"]).filter((name) => !Object.hasOwn(BASE_EXPORTS["operator-approval.mjs"], name) && fromRecorder.has(name));
  assert.deepEqual([...fromRecorder].sort(), [...ownRecorder, "approveWithOperator", "artifactApprover", "moduleApprover", "recorderFor"].sort());
  // AUTO stays a principal of the policy, not of the recorder.
  assert.equal(lifecycle.isAutoAuthority(undefined), true);
  assert.equal(lifecycle.isAutoAuthority("step"), false);
});

test("A8-ARCH-8: module and artifact checkpoint rules stay separate", async () => {
  const edges = {};
  for (const file of LIFECYCLE_FILES) edges[file] = targets(`lifecycle/${file}`, await parse(`lifecycle/${file}`)).filter((t) => t.startsWith("lifecycle/")).map((t) => t.slice(10));
  // The artifact engine reads only the shared vocabulary of the module side:
  // final gates, progress, policy, the one lock and the one offer loop.
  for (const file of LIFECYCLE_FILES.filter((file) => file.startsWith("artifact-"))) {
    assert.deepEqual(edges[file].filter((t) => !t.startsWith("artifact-") && !["checkpoints.mjs", "progress.mjs", "policy.mjs", "approval.mjs", "lock.mjs"].includes(t)), [], file);
  }
  // Only the delegation validators and the recorder reach into the artifact engine.
  const reachers = LIFECYCLE_FILES.filter((file) => !file.startsWith("artifact-") && file !== "index.mjs" && edges[file].some((t) => t.startsWith("artifact-")));
  assert.deepEqual(reachers.sort(), ["recorder.mjs", "validation.mjs"]);
  // Two readers, two contracts.
  const state = { currentStep: "DISCOVER_LEGACY" };
  assert.deepEqual(lifecycle.artifactCheckpointArtifacts(state), ["inventories/source.json"]);
  assert.notDeepEqual(lifecycle.checkpointArtifacts(state), lifecycle.artifactCheckpointArtifacts(state));
  assert.deepEqual(lifecycle.checkpointArtifacts({ currentStep: "COMPLETE" }), ["state.json", "steps/08-finalize.md", "gates.json", "matrices/*.json"]);
});

test("A8-ARCH-9: installed paths and location-sensitive loaders resolve as before; importing lifecycle runs and loads nothing", async (t) => {
  // The artifact parser still resolves from src/artifact/artifact-migration.mjs.
  const toolchain = await readFile(path.join(src, "census/toolchain.mjs"), "utf8");
  assert.match(toolchain, /new URL\("\.\.\/artifact\/artifact-migration\.mjs", import\.meta\.url\)/);
  assert.doesNotMatch(toolchain.replace(/^const ENGINE_URL = .*$/m, ""), /import\.meta\.url/);
  const empty = await mkdtemp(path.join(os.tmpdir(), "a8 target "));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const census = await load("census/index.mjs");
  const fallback = census.targetTypeScript(empty);
  assert.equal(fallback.identity.origin, "PINNED_FALLBACK");
  const fromEngine = createRequire(path.join(src, "artifact/artifact-migration.mjs"));
  assert.equal(fallback.compiler, fromEngine("ts-discovery-compiler"));
  assert.equal((await load("artifact/artifact-migration.mjs")).targetTypeScript, census.targetTypeScript);
  // The contract-upgrade reference resolves to the same file it did from upgrades/.
  const coordinator = await readFile(path.join(src, "lifecycle/contract-upgrade.mjs"), "utf8");
  assert.match(coordinator, /new URL\("\.\.\/\.\.\/references\/v5-contract\.md", import\.meta\.url\)/);
  assert.equal(path.resolve(src, "lifecycle", "../../references/v5-contract.md"), path.resolve(src, "upgrades", "../../references/v5-contract.md"));
  await readFile(path.join(enginePackage, "references/v5-contract.md"));
  // The installed runtime imports runDoctor from src/migration-utils.mjs.
  const bootstrap = await readFile(path.join(enginePackage, "../../scripts/runtime-bootstrap.mjs"), "utf8");
  assert.match(bootstrap, /'packages\/migration-engine\/src\/migration-utils\.mjs'/);
  assert.equal(typeof (await load("migration-utils.mjs")).runDoctor, "function");
  // A fresh process: importing every lifecycle path prints nothing, and loads
  // neither the parser, the PNG pair, nor WebAuthn until a call needs them.
  const base = JSON.stringify(pathToFileURL(src).href);
  const probe = `
    import { createRequire, registerHooks } from "node:module";
    const resolved = [];
    registerHooks({ resolve: (specifier, context, next) => { const result = next(specifier, context); resolved.push(result.url); return result; } });
    const require = createRequire(import.meta.url);
    const from = createRequire(new URL("artifact/artifact-migration.mjs", ${base}));
    const keys = ["ts-discovery-compiler"].map((name) => from.resolve(name));
    const visual = createRequire(new URL("visual-evidence.mjs", ${base}));
    keys.push(...["pngjs", "pixelmatch"].map((name) => visual.resolve(name)));
    for (const file of ${JSON.stringify(["lifecycle/index.mjs", ...Object.keys(FACADES), "core.mjs"])}) await import(new URL(file, ${base}).href);
    console.log(JSON.stringify({
      cjs: keys.map((key) => Object.hasOwn(require.cache, key)),
      lifecycle: resolved.some((url) => url.includes("/lifecycle/recorder.mjs")),
      webauthn: resolved.filter((url) => /operator-webauthn|simplewebauthn/.test(url)),
    }));
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe], { cwd: os.tmpdir() });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { cjs: [false, false, false], lifecycle: true, webauthn: [] });
});
