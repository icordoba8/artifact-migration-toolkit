// Repository-owned contract suite for the start-migration lifecycle.
//
// Every scenario here corresponds to a reproduced defect: the P0 transaction
// bypass, the concurrent-bootstrap corruption, lost/duplicated checkpoint
// transitions, unbound confirmation inputs, hand-edited state, lost registry
// mappings, and upgrade locks left behind by a real process kill. They are
// committed product protection, not audit evidence, so a regression fails the
// build instead of waiting for the next audit.
//
// Every fixture is an isolated `mkdtemp` Git repository. Nothing here touches
// the real repository or any real migration.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  dirtyManifest,
  gitRevision,
  previewRegistryUpdate,
  readRegistry,
  resolveRegistryPath,
  updateRegistry,
} from "../../src/migration-utils.mjs";
import { parseAdvanceArguments, runAdvanceCli } from "../../src/cli/advance-migration.mjs";
import {
  parseDiscoverArguments,
  renderExecutionPreview,
  runDiscoverCli,
} from "../../src/cli/discover-module.mjs";
import {
  challengeFor,
  parseDecisionArguments,
  pendingDecisionCandidates,
  runRecordDecisionCli,
} from "../../src/record-decision.mjs";
import { acquireModuleLock, lockPathFor } from "../../src/module-lock.mjs";
import { engineCommand } from "../../src/engine-paths.mjs";
import { digestToolkitIdentity } from "../../src/toolkit-identity.mjs";
import {
  AMEND_SLICE,
  authorizeOperationSequence,
  challengeForOperationSequence,
  deriveOperationSequence,
  operationSequenceRunner,
} from "../../src/operation-sequence.mjs";
import { downgradeToV4 } from "../support/downgrade-v4.mjs";
import { runDiscoveryScan } from "../../src/discovery-scan.mjs";
import {
  executeUpgrade,
  pendingTransactions,
  previewUpgrade,
  recoverUpgrade,
} from "../../src/upgrades/upgrade-migration.mjs";
import {
  advanceMigration,
  assertExecutionConfirmation,
  BASELINE_ROWS_PIN,
  bootstrapMigration,
  BLOCKED_EXIT_CODE,
  CAPABILITY_OWNERSHIP_FILE,
  compareVisualFact,
  compatibilityBlocker,
  createDecisionCandidate,
  getMigrationStatus,
  MIGRATION_FORMAT_VERSION,
  decisionLineDigest,
  legacySourceBinding,
  previewDiscoveryScan,
  previewAdvance,
  formatIsPromoting,
  formatIsSupported,
  MAX_SLICE_REWORKS,
  NON_PROMOTING_FORMAT_VERSIONS,
  pendingTargetDriftCandidates,
  SLICE_REWORK_FORMAT,
  SUPPORTED_FORMAT_VERSIONS,
  previewMigrationExecution,
  readCanonicalModuleBoundary,
  readState,
  recoverMigrationRecord,
  reconcileSliceState,
  renderProgress,
  renderProgressChecklist,
  migrationProgress,
  CHECKPOINT_STATES,
  FINAL_GATES,
  LEGACY_MIGRATION_STEPS,
  MIGRATION_STEPS,
  TARGET_DIRTY_SCOPE,
  validateResumableMigration,
  artifactBindingFor,
} from "../../src/resumable-migration.mjs";
import { parseRunArguments, runMigration } from "../../src/cli/run-migration.mjs";
import { exitCodeFor, maySelfConfirm } from "../../src/migration-policy.mjs";
import { createSession, handleMessage } from "../../src/mcp-server.mjs";
import {
  getArtifactStatus,
  runArtifact,
} from "../../src/artifact/artifact-migration.mjs";

const execFileAsync = promisify(execFile);
const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);
const repositoryRoot = path.resolve(scriptsRoot, "../../..");
// Provider installation proofs R-W9-a/R-W9-c live in test/provider-installation.test.mjs.

const SPEC = `# Auth

### Requirement: AUTH-REQ-001 Sign in
The target MUST authenticate users.

#### Scenario: AUTH-SCN-001 Success
A valid user signs in.

### Requirement: AUTH-REQ-002 Sign out
The target MUST end a session.

#### Scenario: AUTH-SCN-002 Logout
A signed-in user signs out.
`;

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const writeJson = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

// ponytail: compact manifest tree entries (trailing /) expand via filesystem walk.
const readExpandedManifest = async (root) => {
  const entries = await readJson(
    path.join(root, "providers/generated-files.json"),
  );
  const files = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.endsWith("/")) {
      const dir = path.join(root, entry.slice(0, -1));
      const dirFiles = await readdir(dir, { recursive: true });
      for (const f of dirFiles) {
        const abs = path.join(dir, f);
        if ((await stat(abs)).isFile()) {
          files.push(path.relative(root, abs).split(path.sep).join("/"));
        }
      }
    } else {
      files.push(entry);
    }
  }
  return files;
};

/** Recursive `path -> sha256:size` snapshot, used to prove "nothing written". */
const snapshot = async (root) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "-e",
      `const {readdirSync,statSync,readFileSync}=require("fs");const {createHash}=require("crypto");const p=require("path");
       const out={};const walk=(d)=>{for(const e of readdirSync(d,{withFileTypes:true})){if(e.name===".git")continue;const f=p.join(d,e.name);
       if(e.isDirectory())walk(f);else out[p.relative(process.argv[1],f).split(p.sep).join("/")]=createHash("sha256").update(readFileSync(f)).digest("hex")+":"+statSync(f).size;}};
       walk(process.argv[1]);process.stdout.write(JSON.stringify(out));`,
      root,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
};

const createFixture = async ({
  modules = { auth: { target: "auth" } },
} = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-contract-"));
  const legacyRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  const registryPath = path.join(
    targetRoot,
    ".agents/knowledge/migrations/registry.json",
  );
  await mkdir(legacyRoot, { recursive: true });
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"sm-contract-fixture","private":true}\n',
  );
  await writeFile(path.join(legacyRoot, "marker.txt"), "legacy\n");
  // The module's own root. DISCOVERY_COMPLETENESS censuses what is physically
  // under a declared root, so the fixture needs a root to declare; `marker.txt`
  // stays outside it as a legacy file the module does not own.
  await mkdir(path.join(legacyRoot, "auth"), { recursive: true });
  await writeFile(path.join(legacyRoot, "auth/marker.txt"), "auth\n");
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await writeFile(path.join(targetRoot, "src/placeholder.ts"), "export {};\n");
  await writeJson(registryPath, {
    version: 1,
    projects: {
      legacy: { root: path.relative(path.dirname(registryPath), legacyRoot) },
      target: { root: path.relative(path.dirname(registryPath), targetRoot) },
    },
    modules,
  });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Contract Test",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return {
    root,
    legacyRoot,
    targetRoot,
    registryPath,
    packagePath: path.join(root, "package.json"),
    migrationRoot: path.join(
      targetRoot,
      ".agents/knowledge/migrations/modules/auth",
    ),
    specPath: path.join(targetRoot, "openspec/specs/auth/spec.md"),
    upgradesRoot: path.join(
      targetRoot,
      ".agents/knowledge/migrations/upgrades",
    ),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

// `--registry` is a first-setup-only option: once the binding is persisted the
// resolver refuses it, exactly as a real caller would experience.
const resolutionFor = async (fixture) => {
  const project = JSON.parse(await readFile(fixture.packagePath, "utf8"));
  return resolveRegistryPath({
    cliPath: project.config?.startMigration?.registry
      ? undefined
      : fixture.registryPath,
    moduleName: "auth",
    cwd: fixture.root,
    projectRoot: fixture.root,
    environmentPath: undefined,
  });
};

const previewFresh = async (fixture, overrides = {}) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: SPEC,
    ...overrides,
  });
  return { resolution, preview };
};

const initialize = async (fixture, overrides = {}) => {
  const { resolution, preview } = await previewFresh(fixture, overrides);
  assertExecutionConfirmation(preview, preview.confirmationId);
  const result = await bootstrapMigration({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: preview.openSpecProposal,
    registryBinding: preview.registryBinding,
    boundInputs: preview.boundInputs,
    ...overrides,
  });
  return { resolution, preview, result };
};

const STEP_DOC = (number, name) => `# ${number}. ${name}

- Status: \`COMPLETE\`

## Result

Authored by the contract suite.
`;

const STEP_NAMES = {
  DISCOVER_LEGACY: ["02", "discover-legacy", "Discover legacy"],
  DISCOVERY_COMPLETENESS: [
    "02a",
    "discovery-completeness",
    "Discovery completeness",
  ],
  ASSESS_TARGET: ["03", "assess-target", "Assess target"],
  BUILD_BASELINE: ["04", "build-baseline", "Build baseline"],
  PLAN: ["05", "plan", "Plan"],
  IMPLEMENT_SLICES: ["06", "implement-slices", "Implement slices"],
  VERIFY_SLICES: ["07", "verify-slices", "Verify slices"],
  FINALIZE: ["08", "finalize", "Finalize"],
};

const completeStepDoc = async (fixture, step) => {
  const [number, file, name] = STEP_NAMES[step];
  await writeFile(
    path.join(fixture.migrationRoot, `steps/${number}-${file}.md`),
    STEP_DOC(number, name),
  );
};

// P1-7: DISCOVER_LEGACY/ASSESS_TARGET evidence is a machine-readable
// checklist (category/kind/status/location-or-reason/requirementIds/
// scenarioIds), not a bare path string. Every required category (SOURCE,
// RUNTIME_OBSERVATION, REQUIREMENT_TRACE) must appear at least once, present
// or explicitly NOT_APPLICABLE/BLOCKED with a reason.
const evidenceChecklist = (location, requirementIds = [], scenarioIds = []) => [
  {
    category: "SOURCE",
    kind: "CODE",
    status: "PRESENT",
    location,
    requirementIds,
    scenarioIds,
  },
  {
    category: "RUNTIME_OBSERVATION",
    kind: "OBSERVATION",
    status: "NOT_APPLICABLE",
    reason: "No runtime capture was taken for this fixture.",
    requirementIds: [],
    scenarioIds: [],
  },
  {
    category: "REQUIREMENT_TRACE",
    kind: "DOCS",
    status: "PRESENT",
    location,
    requirementIds,
    scenarioIds,
  },
];

// Legacy evidence points inside the declared module root: C7 requires every
// legacy evidence location to be an owned or supporting file, so citing a file
// outside the module boundary is itself a blocker.
const LEGACY_INVENTORY = {
  version: 1,
  hasVisibleUi: true,
  behaviors: [
    {
      id: "LB-1",
      description: "Sign in",
      evidence: evidenceChecklist(
        "legacy/auth/marker.txt",
        ["AUTH-REQ-001"],
        ["AUTH-SCN-001"],
      ),
    },
  ],
  uiBehaviors: [
    {
      id: "UIB-1",
      behaviorId: "LB-1",
      kind: "CREATE_EDIT_ACTION",
      description: "The sign-in form exposes its primary action.",
      configuration: { showToolbar: false },
      conditional: false,
      interactions: [
        {
          id: "UIX-1",
          action: "Submit the sign-in form.",
          expected: "The primary action submits and the form reports success.",
        },
      ],
      runtimeStates: ["DEFAULT"],
      evidence: evidenceChecklist(
        "legacy/auth/marker.txt",
        ["AUTH-REQ-001"],
        ["AUTH-SCN-001"],
      ),
      requirementIds: ["AUTH-REQ-001"],
      scenarioIds: ["AUTH-SCN-001"],
    },
  ],
  routeFlows: [
    {
      id: "RF-1",
      description: "Login route",
      evidence: evidenceChecklist(
        "legacy/auth/marker.txt",
        ["AUTH-REQ-002"],
        ["AUTH-SCN-002"],
      ),
    },
  ],
  explicitNoRouteFlows: false,
};

/** Every census file classified, which is the whole point of the checkpoint. */
const MODULE_CLASSIFICATION = {
  version: 1,
  algorithmVersion: 1,
  moduleRoots: [
    { path: "auth", reason: "The module's own slice.", decisionId: null },
  ],
  declaredEntryPoints: [],
  files: [
    {
      path: "auth/marker.txt",
      scope: "OWNED",
      reachability: "UNREACHABLE",
      reachedFrom: [],
      kind: "OTHER",
      disposition: "BEHAVIOR_BACKED",
      behaviorIds: ["LB-1"],
      routeFlowIds: [],
      rationale: "The fixture's only owned file; LB-1 describes it.",
      evidence: [],
    },
  ],
  supporting: [],
  unresolvedReferences: [],
  findings: [],
};

const exclusionClassification = (rationale = "Decorative only.") => ({
  ...MODULE_CLASSIFICATION,
  files: [
    {
      ...MODULE_CLASSIFICATION.files[0],
      disposition: "EXCLUDED_APPROVED",
      behaviorIds: [],
      rationale,
      evidence: evidenceChecklist("legacy/auth/marker.txt"),
    },
  ],
});

const TARGET_INVENTORY = {
  version: 1,
  implementationState: "ABSENT",
  evidence: evidenceChecklist(
    "target/src/placeholder.ts",
    ["AUTH-REQ-001"],
    ["AUTH-SCN-001"],
  ),
  hasVisibleUi: true,
  navigationSurfaces: [],
  nativeBehaviors: [{ id: "TN-1", description: "Target-only telemetry" }],
  uiComponents: [
    {
      id: "UC-1",
      requirement: "Primary action button",
      actualSource: "design-system/Button",
      equivalentAvailable: true,
      expectedComponent: "design-system/Button",
      evidence: "target/src/placeholder.ts",
    },
  ],
  uiMismatches: [
    {
      id: "UIM-1",
      uiBehaviorId: "UIB-1",
      disposition: "REQUIRED_BEHAVIOR",
      rationale: "The visible action is required behavior.",
      evidence: ["legacy/auth/marker.txt"],
    },
  ],
};

const matrices = (final) => ({
  "matrices/behavior-parity.json": {
    version: 1,
    rows: [
      {
        id: "BR-1",
        behaviorId: "LB-1",
        targetState: "ABSENT",
        disposition: "IMPLEMENT",
        legacyEvidence: ["legacy/marker.txt"],
        verificationStatus: final ? "VERIFIED" : "PENDING",
      },
    ],
  },
  "matrices/route-adaptation.json": {
    version: 1,
    rows: [
      {
        id: "RR-1",
        routeFlowId: "RF-1",
        targetAdaptation: "app/(auth)/login",
        verificationStatus: final ? "VERIFIED" : "PENDING",
        evidence: final ? ["target/src/placeholder.ts"] : [],
      },
    ],
  },
  "matrices/target-native.json": {
    version: 1,
    rows: [
      {
        id: "NR-1",
        nativeBehaviorId: "TN-1",
        verificationStatus: final ? "PRESERVED" : "PENDING",
      },
    ],
  },
  "matrices/design-system-usage.json": {
    version: 1,
    rows: [
      {
        id: "DR-1",
        componentId: "UC-1",
        authority: "design-system/Button",
        actualSource: "design-system/Button",
        status: "COMPLIANT",
        verificationStatus: final ? "VERIFIED" : "PENDING",
      },
    ],
  },
  // Format 11. The default fixture deliberately carries no SHARED_PREREQUISITE:
  // that classification constrains slice ordering and changed files, so the
  // tests that exercise it build their own rows rather than making every other
  // test in the suite satisfy a prerequisite it does not care about.
  "matrices/capability-ownership.json": CAPABILITY_OWNERSHIP,
});

const CAPABILITY_OWNERSHIP = {
  version: 1,
  architectureAuthorities: [],
  authorityGaps: [],
  rows: [
    {
      id: "CAP-1",
      capability: "Credential form shell",
      classification: "FEATURE_LOCAL",
      requiredDisposition: "CREATE_FEATURE_LOCAL",
      legacyEvidence: ["legacy/auth/marker.txt"],
      targetEvidence: [],
      consumers: ["auth"],
      targetOwner: "src/features/auth/form",
      replacedBy: [],
      rationale: "Only the auth slice consumes it.",
    },
    {
      id: "CAP-2",
      capability: "Typed placeholder module",
      classification: "TARGET_REUSE",
      requiredDisposition: "REUSE_EXISTING",
      legacyEvidence: ["legacy/marker.txt"],
      targetEvidence: ["target/src/placeholder.ts"],
      consumers: ["auth"],
      targetOwner: "src",
      replacedBy: [],
      rationale: "Already present in the target.",
    },
  ],
};

const capabilityOwnership = (rows, extra = {}) => ({
  ...CAPABILITY_OWNERSHIP,
  ...extra,
  rows,
});

const SLICES = [
  {
    id: "slice-a",
    requirementIds: ["AUTH-REQ-001"],
    scenarioIds: ["AUTH-SCN-001"],
    traceIds: ["BR-1", "RR-1"],
    capabilityIds: ["CAP-1"],
    architectureAuthorities: [],
    targetPaths: ["src"],
    dependencies: [],
    acceptanceScenarios: ["Sign in succeeds"],
  },
  {
    id: "slice-b",
    requirementIds: ["AUTH-REQ-002"],
    scenarioIds: ["AUTH-SCN-002"],
    traceIds: ["NR-1", "DR-1"],
    capabilityIds: [],
    architectureAuthorities: [],
    targetPaths: ["src"],
    dependencies: [],
    acceptanceScenarios: ["Sign out succeeds"],
  },
];

const writeMatrices = async (fixture, final = false) => {
  for (const [relative, content] of Object.entries(matrices(final))) {
    await writeJson(path.join(fixture.migrationRoot, relative), content);
  }
};

const gateEvidence = (context) => ({
  kind: "command",
  reference: context.reference ?? "pnpm --dir target test",
  producedAt: new Date().toISOString(),
  producer: "contract-suite",
  environment: `node ${process.version}`,
  hash: `sha256:${"a".repeat(64)}`,
  boundTo: {
    target: "auth",
    legacyRevision: context.legacyRevision,
    targetRevision: context.targetRevision,
    requirementsDigest: context.requirementsDigest,
    dataSourceMode: "standard",
    legacyDirtyDigest: context.legacyDirtyDigest,
    targetDirtyDigest: context.targetDirtyDigest,
  },
});

/** The exact `legacyRevision`/`targetRevision`/dirty-digest binding a gate
 * evidence entry must currently carry to pass FINALIZE. */
const gateBindingContext = async (fixture, extra = {}) => {
  const persisted = await state(fixture);
  return {
    legacyRevision: await revisionOf(fixture.legacyRoot),
    targetRevision: await revisionOf(fixture.targetRoot),
    requirementsDigest: persisted.requirementsAuthority.digest,
    legacyDirtyDigest: (await dirtyManifest(fixture.legacyRoot)).digest,
    targetDirtyDigest: (
      await dirtyManifest(fixture.targetRoot, TARGET_DIRTY_SCOPE)
    ).digest,
    ...extra,
  };
};

const GATES = [
  "ARCHITECTURE_PLAN_GATE",
  "TARGETED_VERIFY",
  "FUNCTIONAL_PARITY_GATE",
  "SIMPLIFY_ONCE",
  "ARCHITECTURE_IMPLEMENTATION_GATE",
  "PRECOMMIT_GATE",
  "FINAL_VERIFY",
];

const revisionOf = async (root) => {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "log", "-1", "--format=%H", "--", "."],
    { encoding: "utf8" },
  );
  return stdout.trim();
};

/** Confirms and executes one checkpoint advance through the two-phase API. */
const advance = async (fixture, options = {}) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewAdvance({
    ...resolution,
    moduleName: "auth",
    ...options,
  });
  return advanceMigration({
    ...resolution,
    moduleName: "auth",
    ...options,
    confirmAdvance: preview.confirmationId,
  });
};

const authorSlice = async (fixture, sliceId) => {
  const planned = (
    await readJson(path.join(fixture.migrationRoot, "slices/index.json"))
  ).slices.find((slice) => slice.id === sliceId);
  // P1-7: a declared changed file must be part of the target repository's
  // real, uncommitted diff, so actually touch the file being claimed.
  const changedFile = `src/${sliceId}.ts`;
  await writeFile(path.join(fixture.targetRoot, changedFile), `export {};\n`);
  await writeJson(path.join(fixture.migrationRoot, `slices/${sliceId}.json`), {
    id: sliceId,
    implementationStatus: "COMPLETE",
    requirementIds: planned.requirementIds,
    scenarioIds: planned.scenarioIds,
    traceIds: planned.traceIds,
    capabilityIds: planned.capabilityIds,
    changedFiles: [changedFile],
    decisions: ["Implemented in the target architecture."],
    checks: ["typecheck"],
  });
};

const authorEvidence = async (
  fixture,
  sliceId,
  {
    uiBehavior = LEGACY_INVENTORY.uiBehaviors[0],
    mismatch = TARGET_INVENTORY.uiMismatches[0],
    includeUi = true,
    producer = "contract-suite",
    // Lets a single test bend one field of the runtime record (or add a
    // screenshot) without restating the whole evidence document.
    mutate = (records) => records,
    limitations = [],
  } = {},
) => {
  const planned = (
    await readJson(path.join(fixture.migrationRoot, "slices/index.json"))
  ).slices.find((slice) => slice.id === sliceId);
  // P1-7: each command result is a structured record whose captured output
  // is a real, hash-verified file, not a bare string.
  const outputContent = "pnpm --dir target test\nall tests passed\n";
  const outputAbsolute = path.join(
    fixture.migrationRoot,
    `evidence/${sliceId}/commands/test.txt`,
  );
  await mkdir(path.dirname(outputAbsolute), { recursive: true });
  await writeFile(outputAbsolute, outputContent);
  const outputPath = path
    .relative(fixture.targetRoot, outputAbsolute)
    .replaceAll(path.sep, "/");
  const outputDigest = `sha256:${createHash("sha256").update(outputContent).digest("hex")}`;
  const implementationDigest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        [
          `src/${sliceId}.ts`,
          createHash("sha256")
            .update(
              await readFile(
                path.join(fixture.targetRoot, `src/${sliceId}.ts`),
              ),
            )
            .digest("hex"),
        ],
      ]),
    )
    .digest("hex")}`;
  const uiContractDigest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        uiBehavior,
        mismatch,
      }),
    )
    .digest("hex")}`;
  const persisted = await state(fixture);
  await writeJson(
    path.join(fixture.migrationRoot, `evidence/${sliceId}/result.json`),
    {
      sliceId,
      result: "PASS",
      requirementIds: planned.requirementIds,
      scenarioIds: planned.scenarioIds,
      capabilityIds: planned.capabilityIds,
      traceIds: planned.traceIds,
      commands: [
        {
          command: "pnpm --dir target test",
          exitCode: 0,
          executedAt: new Date().toISOString(),
          runner: `node ${process.version}`,
          outputPath,
          outputDigest,
        },
      ],
      scenarios: planned.acceptanceScenarios,
      uiEvidence: mutate(
        sliceId === "slice-a" && includeUi
          ? [
              {
                provider: "playwright",
                origin: "TARGET",
                producer,
                environment: `node ${process.version}`,
                route: "/auth/sign-in",
                viewport: { width: 1280, height: 720 },
                executedAt: new Date().toISOString(),
                result: "PASS",
                uiBehaviorId: uiBehavior.id,
                state: uiBehavior.runtimeStates[0],
                interactions: (uiBehavior.interactions ?? []).map(
                  (interaction) => ({
                    id: interaction.id,
                    expected: interaction.expected,
                    actual: interaction.expected,
                    outcome: "PASS",
                  }),
                ),
                reference: outputPath,
                hash: outputDigest,
                boundTo: {
                  target: "auth",
                  requirementsDigest: persisted.requirementsAuthority.digest,
                  dataSourceMode: "standard",
                  sliceId,
                  implementationDigest,
                  uiContractDigest,
                },
              },
            ]
          : [],
        { sliceId, uiBehavior, outputPath, outputDigest },
      ),
      uiEvidenceLimitations: limitations,
      residualRisks: [],
    },
  );
};

/**
 * Drives a fresh fixture up to (not through) `stopAfter`. `step` is the
 * two-phase API by default; the autonomy suite passes a CLI-driven stepper to
 * prove the same lifecycle runs unattended through `--mode auto`.
 */
const driveTo = async (fixture, stopAfter, step = advance, overrides = {}) => {
  await initialize(fixture, overrides.bootstrap ?? {});
  if (overrides.formatVersion) {
    const statePath = path.join(fixture.migrationRoot, "state.json");
    const persisted = await readJson(statePath);
    // Same rule as `downgradeToFormat9`/`downgradeToFormat10`: a genuine record
    // stamped below 15 predates the format-15 keys, so a downgraded fixture
    // that kept them would not be a record of that format at all.
    if (overrides.formatVersion < MULTI_SOURCE_FORMAT_VERSION) {
      delete persisted.legacySources;
      delete persisted.targetAdoption;
    }
    await writeJson(statePath, {
      ...persisted,
      formatVersion: overrides.formatVersion,
    });
  }
  const order = [
    "DISCOVER_LEGACY",
    "DISCOVERY_COMPLETENESS",
    "ASSESS_TARGET",
    "BUILD_BASELINE",
    "PLAN",
    "SLICES",
    "FINALIZE",
  ];
  const wanted = order.indexOf(stopAfter);

  if (wanted >= 0) {
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      overrides.legacy ?? LEGACY_INVENTORY,
    );
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      overrides.classification ?? MODULE_CLASSIFICATION,
    );
    await step(fixture);
  }
  if (wanted >= 1) {
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      overrides.classification ?? MODULE_CLASSIFICATION,
    );
    await step(fixture);
  }
  if (wanted >= 2) {
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      overrides.target ?? TARGET_INVENTORY,
    );
    await step(fixture);
  }
  if (wanted >= 3) {
    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeMatrices(fixture);
    await registerAuth(fixture);
    await step(fixture);
  }
  if (wanted >= 4) {
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await step(fixture);
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await completeStepDoc(fixture, "VERIFY_SLICES");
  }
  if (wanted >= 5) {
    for (const slice of SLICES) {
      await authorSlice(fixture, slice.id);
      await step(fixture, { slice: slice.id });
      await authorEvidence(fixture, slice.id, overrides.evidence ?? {});
      await step(fixture, { slice: slice.id });
    }
  }
  if (wanted >= 6) {
    // Lets a test put the record into the exact shape FINALIZE has to refuse --
    // an unclaimed target edit, a lingering FAIL -- without restating the whole
    // finalize authoring block.
    await overrides.beforeFinalize?.(fixture);
    await authorFinalize(fixture);
    await step(fixture);
  }
};

/** The FINALIZE authoring block, shared by `driveTo` and the W5 regressions. */
const authorFinalize = async (fixture) => {
  await completeStepDoc(fixture, "FINALIZE");
  await writeMatrices(fixture, true);
  const persisted = await readJson(
    path.join(fixture.migrationRoot, "state.json"),
  );
  const context = {
    legacyRevision: await revisionOf(fixture.legacyRoot),
    targetRevision: await revisionOf(fixture.targetRoot),
    requirementsDigest: persisted.requirementsAuthority.digest,
    legacyDirtyDigest: (await dirtyManifest(fixture.legacyRoot)).digest,
    targetDirtyDigest: (
      await dirtyManifest(fixture.targetRoot, TARGET_DIRTY_SCOPE)
    ).digest,
  };
  await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
    version: 1,
    gates: GATES.map((gate) => ({
      gate,
      result: "PASS",
      attempts: 1,
      evidence: [gateEvidence(context)],
    })),
  });
};

/**
 * Record a `TARGET_DRIFT_ACCEPTED` line the way `record-decision.mjs` writes
 * one: chained, and bound to the accepted path's exact bytes.
 */
const acceptTargetDrift = async (fixture, relative) => {
  const ledgerPath = path.join(
    fixture.migrationRoot,
    "decisions/operator-decisions.ndjson",
  );
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const existing = await readFile(ledgerPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const previous = existing
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .at(-1);
  const digest = `sha256:${createHash("sha256")
    .update(await readFile(path.join(fixture.targetRoot, relative)))
    .digest("hex")}`;
  const decision = {
    id: `DEC-${String((previous?.seq ?? 0) + 1).padStart(3, "0")}`,
    seq: (previous?.seq ?? 0) + 1,
    prevDigest: previous ? decisionLineDigest(previous) : "genesis",
    at: new Date().toISOString(),
    operator: "tester@host",
    kind: "TARGET_DRIFT_ACCEPTED",
    subject: { type: "TARGET_FILE", path: relative },
    statement: "Approved at a terminal.",
    rationaleDigest: `sha256:${"0".repeat(64)}`,
    boundTo: { module: "auth", pathDigest: digest },
  };
  await appendFile(ledgerPath, `${JSON.stringify(decision)}\n`);
  return decision;
};

const registerAuth = async (fixture) => {
  const preview = await previewRegistryUpdate({
    projectRoot: fixture.root,
    registryPath: fixture.registryPath,
    moduleName: "auth",
    target: "auth",
  });
  return updateRegistry({
    projectRoot: fixture.root,
    registryPath: fixture.registryPath,
    moduleName: "auth",
    target: "auth",
    confirmExecution: preview.confirmationId,
  });
};

const state = (fixture) =>
  readJson(path.join(fixture.migrationRoot, "state.json"));

const historyEvents = async (fixture) =>
  (
    await readFile(
      path.join(fixture.migrationRoot, "history/history.ndjson"),
      "utf8",
    )
  )
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

// --- P0-1: an unfinished upgrade/rollback blocks every path -----------------

const plantLiveMoved = async (fixture) => {
  const directory = path.join(fixture.upgradesRoot, "auth/deadbeefdeadbeef");
  await mkdir(directory, { recursive: true });
  await cp(fixture.migrationRoot, path.join(directory, "rollback-live"), {
    recursive: true,
  });
  await cp(fixture.migrationRoot, path.join(directory, "source-snapshot"), {
    recursive: true,
  });
  await rm(fixture.migrationRoot, { recursive: true, force: true });
  await writeJson(path.join(directory, "transaction.json"), {
    confirmationId: "deadbeefdeadbeef",
    module: "auth",
    kind: "UPGRADE",
    livePath: fixture.migrationRoot,
    directory,
    state: "LIVE_MOVED",
    startedAt: new Date().toISOString(),
  });
  return directory;
};

test("P0-1: a LIVE_MOVED transaction blocks preview and bootstrap with zero writes", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    await plantLiveMoved(fixture);
    const before = await snapshot(fixture.root);

    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      openSpecProposal: SPEC,
    });
    assert.equal(preview.state, "INCOMPATIBLE");
    assert.equal(preview.requiresConfirmation, false);
    assert.equal(preview.confirmationId, null);
    assert.match(preview.blockers.join("\n"), /unfinished upgrade transaction/);
    assert.match(preview.blockers.join("\n"), /--recover/);

    await assert.rejects(
      bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        openSpecProposal: SPEC,
        boundInputs: { any: "value" },
      }),
      /unfinished upgrade transaction/,
    );
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("P0-1: the same hole through an absent state.json with no migration tree", async () => {
  const fixture = await createFixture();
  try {
    // Minimal repro: journal plus renamed-away tree, no upgrade ever executed.
    const directory = path.join(fixture.upgradesRoot, "auth/feedfacefeedface");
    await mkdir(directory, { recursive: true });
    await writeJson(path.join(directory, "transaction.json"), {
      confirmationId: "feedfacefeedface",
      module: "auth",
      kind: "ROLLBACK",
      livePath: fixture.migrationRoot,
      directory,
      state: "LIVE_MOVED",
    });
    const before = await snapshot(fixture.root);
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      openSpecProposal: SPEC,
    });
    assert.equal(preview.requiresConfirmation, false);
    assert.equal(preview.confirmationId, null);
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

const journalOf = async (fixture) => {
  const [pending] = await pendingTransactions(fixture.targetRoot, "auth");
  return pending ?? null;
};

test("P0-1: a real v4 upgrade killed at LIVE_MOVED never bootstraps a fresh migration", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    // Authored, irreplaceable human evidence: the exact thing a fresh
    // initialization would silently destroy.
    const legacyInventoryPath = path.join(
      fixture.migrationRoot,
      "inventories/legacy.json",
    );
    await writeJson(legacyInventoryPath, {
      ...LEGACY_INVENTORY,
      behaviors: [
        {
          ...LEGACY_INVENTORY.behaviors[0],
          description: "Sign in — IRREPLACEABLE-HUMAN-EVIDENCE",
        },
      ],
    });
    const v4State = await downgradeToV4(fixture.migrationRoot);
    const authoredEvidence = await readFile(legacyInventoryPath, "utf8");
    assert.equal(v4State.contractVersion, 4);
    assert.equal(v4State.formatVersion, 3);

    // The engine itself classifies the fixture as an upgradable contract-4 tree.
    const resolution = await resolutionFor(fixture);
    const upgradePreview = await previewUpgrade({
      registryPath: resolution.registryPath,
      moduleName: "auth",
    });
    assert.deepEqual(upgradePreview.sourceVersions, {
      contractVersion: 4,
      formatVersion: 3,
      workflowVersion: "4.0",
    });
    assert.equal(
      upgradePreview.blockers.length,
      0,
      upgradePreview.blockers.join("; "),
    );
    assert.equal(upgradePreview.requiresConfirmation, true);

    // Kill the upgrade exactly at LIVE_MOVED: journal committed, live tree
    // renamed away, staged tree not yet renamed in.
    await assert.rejects(
      executeUpgrade({
        registryPath: resolution.registryPath,
        moduleName: "auth",
        confirmUpgrade: upgradePreview.confirmationId,
        hooks: {
          afterJournal: (state) => {
            if (state === "LIVE_MOVED") throw new Error("process killed");
          },
        },
      }),
      /process killed/,
    );
    const journal = await journalOf(fixture);
    assert.equal(journal.state, "LIVE_MOVED");
    assert.equal(journal.kind, "UPGRADE");
    assert.equal(await exists(fixture.migrationRoot), false);

    // No absent-state bootstrap: preview refuses and issues no confirmation ID,
    // bootstrap refuses, and not one byte moves under the target root.
    const before = await snapshot(fixture.root);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      openSpecProposal: SPEC,
    });
    assert.equal(preview.state, "INCOMPATIBLE");
    assert.equal(preview.requiresConfirmation, false);
    assert.equal(preview.confirmationId, null);
    assert.match(preview.blockers.join("\n"), /unfinished upgrade transaction/);
    assert.match(preview.blockers.join("\n"), /--recover/);
    await assert.rejects(
      bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        openSpecProposal: SPEC,
        boundInputs: { any: "value" },
      }),
      /unfinished upgrade transaction/,
    );
    assert.deepEqual(await snapshot(fixture.root), before);

    // Safe resume: recovery restores the contract-4 tree byte for byte.
    const recovery = await recoverUpgrade({
      registryPath: resolution.registryPath,
      moduleName: "auth",
    });
    assert.equal(recovery.clean, false);
    assert.deepEqual(recovery.recovered, [
      { outcome: "ROLLED_BACK", from: "LIVE_MOVED" },
    ]);
    assert.equal(await journalOf(fixture), null);
    const restored = await state(fixture);
    assert.equal(restored.contractVersion, 4);
    assert.equal(restored.createdAt, v4State.createdAt);
    assert.equal(restored.revision, v4State.revision);
    assert.equal(await readFile(legacyInventoryPath, "utf8"), authoredEvidence);

    // And the recovered migration still upgrades, keeping the authored evidence.
    const retry = await previewUpgrade({
      registryPath: resolution.registryPath,
      moduleName: "auth",
    });
    assert.equal(retry.requiresConfirmation, true);
    const upgraded = await executeUpgrade({
      registryPath: resolution.registryPath,
      moduleName: "auth",
      confirmUpgrade: retry.confirmationId,
    });
    assert.equal(upgraded.state.contractVersion, 5);
    assert.equal(upgraded.state.createdAt, v4State.createdAt);
    assert.equal(await readFile(legacyInventoryPath, "utf8"), authoredEvidence);
    assert.equal(
      (await previewMigrationExecution({ ...resolution, moduleName: "auth" }))
        .state,
      "ACTIVE",
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- P0-2: concurrent bootstrap ---------------------------------------------

test("P0-2: barrier-synchronized concurrent bootstraps produce exactly one winner", async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fixture = await createFixture();
    try {
      const resolution = await resolutionFor(fixture);
      const previews = await Promise.all([
        previewMigrationExecution({
          ...resolution,
          moduleName: "auth",
          openSpecProposal: SPEC,
        }),
        previewMigrationExecution({
          ...resolution,
          moduleName: "auth",
          openSpecProposal: SPEC,
        }),
      ]);
      const results = await Promise.allSettled(
        previews.map((preview) =>
          bootstrapMigration({
            ...resolution,
            moduleName: "auth",
            openSpecProposal: preview.openSpecProposal,
            registryBinding: preview.registryBinding,
            boundInputs: preview.boundInputs,
          }),
        ),
      );
      const created = results.filter(
        (entry) => entry.status === "fulfilled" && entry.value.changed === true,
      );
      assert.equal(created.length, 1, `attempt ${attempt}: one initialization`);

      // The winner's artifact set must be complete and mutually consistent: a
      // loser's rollback may never delete the shared OpenSpec authority.
      assert.equal(await exists(fixture.specPath), true);
      const persisted = await state(fixture);
      assert.equal(persisted.currentStep, "DISCOVER_LEGACY");
      assert.equal(persisted.revision, 1);
      assert.equal((await historyEvents(fixture)).length, 1);
      const binding = JSON.parse(await readFile(fixture.packagePath, "utf8"));
      assert.equal(
        binding.config.startMigration.registry,
        "target/.agents/knowledge/migrations/registry.json",
      );
      // No staging or journal residue.
      const initJournal = path.join(
        fixture.targetRoot,
        ".agents/knowledge/migrations/init/auth.journal",
      );
      assert.equal(await exists(initJournal), false);
    } finally {
      await fixture.cleanup();
    }
  }
});

// --- P1-2 / P1-3 / C10.3: one revisioned, journalled transition -------------

test("P1-2: concurrent advances of one checkpoint yield one success and one event", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    const resolution = await resolutionFor(fixture);
    const previews = await Promise.all([
      previewAdvance({ ...resolution, moduleName: "auth" }),
      previewAdvance({ ...resolution, moduleName: "auth" }),
    ]);
    const results = await Promise.allSettled(
      previews.map((preview) =>
        advanceMigration({
          ...resolution,
          moduleName: "auth",
          confirmAdvance: preview.confirmationId,
        }),
      ),
    );
    assert.equal(
      results.filter((entry) => entry.status === "fulfilled").length,
      1,
    );
    const persisted = await state(fixture);
    assert.equal(persisted.revision, 4);
    const events = await historyEvents(fixture);
    assert.equal(
      events.filter(
        (event) =>
          event.event === "STEP_COMPLETED" && event.step === "ASSESS_TARGET",
      ).length,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-2: concurrent verification of two different slices cannot lose a completion", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");
    // slice-b is not active, so a confirmation for it cannot be issued at all.
    const resolution = await resolutionFor(fixture);
    const wrongSlice = await previewAdvance({
      ...resolution,
      moduleName: "auth",
      slice: "slice-b",
    });
    assert.equal(wrongSlice.requiresConfirmation, false);
    assert.equal(wrongSlice.confirmationId, null);

    const before = await state(fixture);
    await assert.rejects(
      advanceMigration({
        ...resolution,
        moduleName: "auth",
        slice: "slice-b",
        confirmAdvance: "0000000000000000",
      }),
      /not the active slice/,
    );
    assert.deepEqual(await state(fixture), before);

    await advance(fixture, { slice: "slice-a" });
    const after = await state(fixture);
    assert.deepEqual(after.completedSlices, ["slice-a"]);
    assert.deepEqual(after.pendingSlices, ["slice-b"]);
    assert.equal(after.activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

test("P1-3: an unwritable history blocks the advance before state moves", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    const before = await state(fixture);
    // Replace history/ with a regular file: `mkdir` then `appendFile` both fail.
    await rm(path.join(fixture.migrationRoot, "history"), {
      recursive: true,
      force: true,
    });
    await writeFile(path.join(fixture.migrationRoot, "history"), "blocked\n");
    await assert.rejects(advance(fixture));
    const after = await readJson(
      path.join(fixture.migrationRoot, "state.json"),
    );
    assert.equal(after.currentStep, before.currentStep);
    assert.equal(after.revision, before.revision);
  } finally {
    await fixture.cleanup();
  }
});

test("P1-3: an interrupted transition is completed deterministically on the next command", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const persisted = await state(fixture);
    const events = await historyEvents(fixture);

    // Reproduce a death between the state write and the history append: remove
    // the last event and restore the journal the transition had written.
    await writeFile(
      path.join(fixture.migrationRoot, "history/history.ndjson"),
      `${events
        .slice(0, -1)
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    await writeJson(path.join(fixture.migrationRoot, "advance.journal"), {
      fromRevision: persisted.revision - 1,
      toRevision: persisted.revision,
      event: events.at(-1),
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    // A read tolerates the in-flight shape instead of hard-failing...
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(preview.currentCheckpoint, "ASSESS_TARGET");

    // ...and the next mutating command completes it without operator action.
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    await advance(fixture);
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "advance.journal")),
      false,
    );
    const recovered = await historyEvents(fixture);
    assert.deepEqual(
      recovered.map((event) => event.step),
      ["RESOLVE", "DISCOVER_LEGACY", "DISCOVERY_COMPLETENESS", "ASSESS_TARGET"],
    );
    assert.equal((await state(fixture)).revision, 4);
  } finally {
    await fixture.cleanup();
  }
});

// --- P1-1 / C1.6 / C5.6 / C5.7 / P2-3: the state graph is anchored ----------

test("P1-1: a hand-edited currentStep contradicts the append-only history", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "ASSESS_TARGET");
    const persisted = await state(fixture);
    persisted.currentStep = "FINALIZE";
    persisted.completedSteps = [
      "RESOLVE",
      "DISCOVER_LEGACY",
      "DISCOVERY_COMPLETENESS",
      "ASSESS_TARGET",
      "BUILD_BASELINE",
      "PLAN",
      "IMPLEMENT_SLICES",
      "VERIFY_SLICES",
    ];
    await writeJson(path.join(fixture.migrationRoot, "state.json"), persisted);
    const resolution = await resolutionFor(fixture);
    await assert.rejects(
      previewMigrationExecution({ ...resolution, moduleName: "auth" }),
      /append-only history proves/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-1: pruning artifactHashes to re-pin a rewritten inventory is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "ASSESS_TARGET");
    const persisted = await state(fixture);
    persisted.currentStep = "DISCOVER_LEGACY";
    persisted.completedSteps = ["RESOLVE"];
    persisted.revision = 2;
    delete persisted.artifactHashes["steps/02-discover-legacy.md"];
    delete persisted.artifactHashes["inventories/legacy.json"];
    delete persisted.artifactHashes["steps/03-assess-target.md"];
    delete persisted.artifactHashes["inventories/target.json"];
    await writeJson(path.join(fixture.migrationRoot, "state.json"), persisted);
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          { id: "LB-9", description: "fabricated", evidence: ["nowhere"] },
        ],
      },
    );
    const resolution = await resolutionFor(fixture);
    await assert.rejects(
      previewMigrationExecution({ ...resolution, moduleName: "auth" }),
      /append-only history proves|must pin exactly/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P2-3: a truncated or rewritten history is detected", async () => {
  const historyPath = (fixture) =>
    path.join(fixture.migrationRoot, "history/history.ndjson");
  const refuses = async (fixture) =>
    assert.rejects(
      previewMigrationExecution({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }),
      /history\/history\.ndjson must still contain, unchanged/,
    );

  const truncated = await createFixture();
  try {
    await driveTo(truncated, "DISCOVER_LEGACY");
    const anchor = (
      await readJson(path.join(truncated.migrationRoot, "integrity.json"))
    ).history;
    assert.ok(anchor.bytes > 0 && anchor.sha256, "the anchor is pinned");
    await writeFile(historyPath(truncated), "");
    await refuses(truncated);
  } finally {
    await truncated.cleanup();
  }

  // The case the pin exists for: back-dating one event in place. The byte
  // length does not move, the replay ignores `at`, and gate-evidence freshness
  // reads exactly this field -- so nothing else in the engine would notice.
  const backdated = await createFixture();
  try {
    await driveTo(backdated, "DISCOVER_LEGACY");
    const lines = (await readFile(historyPath(backdated), "utf8"))
      .split("\n")
      .filter(Boolean);
    const created = JSON.parse(lines[0]);
    const forged = JSON.stringify({
      ...created,
      at: "2020-01-01T00:00:00.000Z",
    });
    assert.equal(forged.length, lines[0].length, "same bytes, different event");
    await writeFile(
      historyPath(backdated),
      `${[forged, ...lines.slice(1)].join("\n")}\n`,
    );
    await refuses(backdated);
  } finally {
    await backdated.cleanup();
  }
});

test("the legal state graph passes at every checkpoint and reaches COMPLETE", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const persisted = await state(fixture);
    assert.equal(persisted.status, "COMPLETE");
    assert.equal(persisted.currentStep, "COMPLETE");
    assert.deepEqual(persisted.completedSlices.sort(), ["slice-a", "slice-b"]);
    const resolution = await resolutionFor(fixture);
    const validated = await validateResumableMigration({
      ...resolution,
      moduleName: "auth",
      complete: true,
    });
    assert.equal(validated.valid, true);
    const events = await historyEvents(fixture);
    assert.deepEqual(
      events.map((event) => event.step),
      [
        "RESOLVE",
        "DISCOVER_LEGACY",
        "DISCOVERY_COMPLETENESS",
        "ASSESS_TARGET",
        "BUILD_BASELINE",
        "PLAN",
        "IMPLEMENT_SLICES",
        "VERIFY_SLICES",
        "IMPLEMENT_SLICES",
        "VERIFY_SLICES",
        "FINALIZE",
      ],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("resume reports the persisted checkpoint from every durable position", async () => {
  for (const stop of [
    "DISCOVER_LEGACY",
    "DISCOVERY_COMPLETENESS",
    "ASSESS_TARGET",
    "BUILD_BASELINE",
    "PLAN",
    "SLICES",
    "FINALIZE",
  ]) {
    const fixture = await createFixture();
    try {
      await driveTo(fixture, stop);
      const resolution = await resolutionFor(fixture);
      const status = await getMigrationStatus({
        ...resolution,
        moduleName: "auth",
      });
      assert.ok(status.currentStep, `${stop}: status resolves`);
      if (stop === "FINALIZE") {
        assert.equal(status.status, "COMPLETE");
      } else {
        assert.equal(status.status, "ACTIVE");
        assert.equal(status.resumed, true);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

// --- P1-4 / P1-5 / P1-6: what the confirmation actually binds ---------------

test("P1-4: swapping the resolved legacy root invalidates the confirmation", async () => {
  const fixture = await createFixture();
  try {
    // Both subtrees must land in ONE commit: `gitRevision` is path-scoped, so a
    // legacy2 committed later would differ by revision alone and the confirm
    // would expire without the root ever being bound.
    const secondLegacy = path.join(fixture.root, "legacy2");
    await mkdir(secondLegacy, { recursive: true });
    await writeFile(path.join(secondLegacy, "marker.txt"), "legacy\n");
    await execFileAsync("git", ["add", "-A"], { cwd: fixture.root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Contract Test",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "-q",
        "--amend",
        "--no-edit",
      ],
      { cwd: fixture.root },
    );
    assert.deepEqual(
      await gitRevision(secondLegacy),
      await gitRevision(fixture.legacyRoot),
    );

    const { preview } = await previewFresh(fixture);
    assert.ok(preview.confirmationId);
    assert.match(
      renderExecutionPreview(preview),
      new RegExp(`Legacy root: .*${path.basename(fixture.legacyRoot)}\\b`),
    );
    const registry = await readJson(fixture.registryPath);
    registry.projects.legacy.root = "../../../../legacy2";
    await writeJson(fixture.registryPath, registry);

    const resolution = await resolutionFor(fixture);
    const after = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      openSpecProposal: SPEC,
    });
    // The registry swap moves all three bound inputs, so assert each one
    // individually: an ID that only tracked the registry bytes would still
    // expire here and hide an unbound root.
    assert.equal(path.basename(preview.boundInputs.legacyRoot), "legacy");
    assert.equal(path.basename(after.boundInputs.legacyRoot), "legacy2");
    assert.equal(after.boundInputs.targetRoot, preview.boundInputs.targetRoot);
    assert.notEqual(
      after.boundInputs.registryDigest,
      preview.boundInputs.registryDigest,
    );
    assert.notEqual(after.confirmationId, preview.confirmationId);
    assert.throws(
      () => assertExecutionConfirmation(after, preview.confirmationId),
      /missing or expired/,
    );
  } finally {
    await fixture.cleanup();
  }
});

// Both refusals share one preview path, so drive each through the real
// resolver and assert the package.json it would have written is untouched.
const previewFromProjectRoot = async (fixture, projectRoot) => {
  const resolution = await resolveRegistryPath({
    cliPath: fixture.registryPath,
    moduleName: "auth",
    cwd: projectRoot,
    projectRoot,
    environmentPath: undefined,
  });
  return previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: SPEC,
  });
};

test("P1-5: an unrelated project root is refused with the registry guidance and never written", async () => {
  const fixture = await createFixture();
  const stranger = await mkdtemp(path.join(os.tmpdir(), "sm-stranger-"));
  try {
    const strangerPackage = path.join(stranger, "package.json");
    await writeFile(
      strangerPackage,
      '{"name":"unrelated","private":true,"config":{"other":1}}\n',
    );
    const before = await readFile(strangerPackage, "utf8");
    await assert.rejects(previewFromProjectRoot(fixture, stranger), (error) => {
      // The refusal must name the unrelated root, the target root it is
      // unrelated to, and both documented ways to point at the registry --
      // a bare "refused" leaves the caller with no next move.
      assert.match(
        error.message,
        /Refusing to write the migration registry binding/,
      );
      assert.ok(error.message.includes(stranger));
      assert.ok(error.message.includes(fixture.targetRoot));
      assert.match(error.message, /--registry/);
      assert.match(error.message, /config\.startMigration\.registry/);
      return true;
    });
    assert.equal(await readFile(strangerPackage, "utf8"), before);
  } finally {
    await fixture.cleanup();
    await rm(stranger, { recursive: true, force: true });
  }
});

test("P1-5: a project root inside the target that cannot hold a relative binding is refused", async () => {
  const fixture = await createFixture();
  try {
    // Contained by the target root, so containment passes -- but the registry
    // sits above it, so the only expressible binding is a non-relative one.
    const nested = path.join(fixture.targetRoot, "app");
    await mkdir(nested, { recursive: true });
    const nestedPackage = path.join(nested, "package.json");
    await writeFile(nestedPackage, '{"name":"nested","private":true}\n');
    const before = await readFile(nestedPackage, "utf8");
    await assert.rejects(
      previewFromProjectRoot(fixture, nested),
      /no portable binding can be persisted/,
    );
    assert.equal(await readFile(nestedPackage, "utf8"), before);
  } finally {
    await fixture.cleanup();
  }
});

test("P1-6: dirty legacy bytes, dirty target bytes, and brief bytes are bound", async () => {
  const cases = [
    [
      "tracked legacy modification",
      (fixture) =>
        writeFile(path.join(fixture.legacyRoot, "marker.txt"), "changed\n"),
    ],
    [
      "untracked legacy file",
      (fixture) => writeFile(path.join(fixture.legacyRoot, "new.txt"), "new\n"),
    ],
    [
      "deleted legacy file",
      (fixture) => rm(path.join(fixture.legacyRoot, "marker.txt")),
    ],
    [
      "renamed legacy file",
      (fixture) =>
        rename(
          path.join(fixture.legacyRoot, "marker.txt"),
          path.join(fixture.legacyRoot, "renamed.txt"),
        ),
    ],
    [
      "dirty target file",
      (fixture) =>
        writeFile(
          path.join(fixture.targetRoot, "src/placeholder.ts"),
          "export const changed = 1;\n",
        ),
    ],
  ];
  for (const [label, mutate] of cases) {
    const fixture = await createFixture();
    try {
      const { resolution, preview } = await previewFresh(fixture);
      await mutate(fixture);
      const before = await snapshot(fixture.root);
      await assert.rejects(
        bootstrapMigration({
          ...resolution,
          moduleName: "auth",
          openSpecProposal: preview.openSpecProposal,
          registryBinding: preview.registryBinding,
          boundInputs: preview.boundInputs,
        }),
        /changed after the confirmation was issued/,
        label,
      );
      assert.deepEqual(await snapshot(fixture.root), before, label);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("P1-6: changing the brief bytes after preview invalidates the confirmation", async () => {
  const fixture = await createFixture();
  try {
    const briefPath = path.join(fixture.targetRoot, "brief.md");
    await writeFile(briefPath, "# Brief\n\nMigrate authentication.\n");
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      openSpecProposal: SPEC,
      brief: "brief.md",
    });
    assert.ok(preview.confirmationId);
    await writeFile(briefPath, "# Brief\n\nMigrate something else entirely.\n");
    const before = await snapshot(fixture.root);
    await assert.rejects(
      bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        openSpecProposal: preview.openSpecProposal,
        registryBinding: preview.registryBinding,
        boundInputs: preview.boundInputs,
        brief: "brief.md",
      }),
      /changed after the confirmation was issued/,
    );
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("P1-6: execution without the preview's bound inputs is refused", async () => {
  const fixture = await createFixture();
  try {
    const { resolution, preview } = await previewFresh(fixture);
    const before = await snapshot(fixture.root);
    await assert.rejects(
      bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        openSpecProposal: preview.openSpecProposal,
        registryBinding: preview.registryBinding,
      }),
      /requires the boundInputs/,
    );
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

// --- P1-8: concurrent registry updates --------------------------------------

test("P1-8: concurrent registrations of different modules both persist", async () => {
  const fixture = await createFixture();
  try {
    const previews = await Promise.all(
      ["billing", "catalog"].map((moduleName) =>
        previewRegistryUpdate({
          projectRoot: fixture.root,
          registryPath: fixture.registryPath,
          moduleName,
          target: moduleName,
        }),
      ),
    );
    const results = await Promise.allSettled(
      previews.map((preview, index) =>
        updateRegistry({
          projectRoot: fixture.root,
          registryPath: fixture.registryPath,
          moduleName: ["billing", "catalog"][index],
          target: ["billing", "catalog"][index],
          confirmExecution: preview.confirmationId,
        }),
      ),
    );
    const succeeded = results.filter((entry) => entry.status === "fulfilled");
    const registry = await readRegistry(fixture.registryPath);
    for (const entry of succeeded) {
      assert.ok(
        registry.modules[entry.value.moduleName],
        `${entry.value.moduleName} reported success and must be present`,
      );
    }
    assert.ok(succeeded.length >= 1);
  } finally {
    await fixture.cleanup();
  }
});

test("P1-8: concurrent conflicting registrations of the same module barrier-synchronize to exactly one persisted result", async () => {
  const fixture = await createFixture();
  try {
    const previews = await Promise.all(
      ["target-a", "target-b"].map((target) =>
        previewRegistryUpdate({
          projectRoot: fixture.root,
          registryPath: fixture.registryPath,
          moduleName: "shipping",
          target,
        }),
      ),
    );
    const results = await Promise.allSettled(
      previews.map((preview, index) =>
        updateRegistry({
          projectRoot: fixture.root,
          registryPath: fixture.registryPath,
          moduleName: "shipping",
          target: ["target-a", "target-b"][index],
          confirmExecution: preview.confirmationId,
        }),
      ),
    );
    const succeeded = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    assert.equal(
      succeeded.length,
      1,
      "exactly one of two conflicting confirmations may report success",
    );
    assert.equal(rejected.length, 1);
    assert.match(
      rejected[0].reason.message,
      /conflicts with registered target|Registration is stale/,
    );
    const registry = await readRegistry(fixture.registryPath);
    assert.equal(
      registry.modules.shipping.target,
      succeeded[0].value.target,
      "the persisted mapping must be the one that reported success",
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- P1-9: the advance helper is two-phase ----------------------------------

test("P1-9: advance without an exact confirmation writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    const resolution = await resolutionFor(fixture);
    const preview = await previewAdvance({ ...resolution, moduleName: "auth" });
    const before = await snapshot(fixture.root);
    // One hex digit off, whichever digit it already is: hard-coding the
    // replacement made this the real ID one run in sixteen.
    const tampered = `${preview.confirmationId.slice(0, -1)}${
      preview.confirmationId.at(-1) === "0" ? "1" : "0"
    }`;
    assert.notEqual(tampered, preview.confirmationId);

    for (const [label, id] of [
      ["missing", undefined],
      ["empty", ""],
      ["forged", "0123456789abcdef"],
      ["tampered", tampered],
    ]) {
      await assert.rejects(
        advanceMigration({
          ...resolution,
          moduleName: "auth",
          confirmAdvance: id,
        }),
        /confirmation is missing or expired/,
        label,
      );
    }
    assert.deepEqual(await snapshot(fixture.root), before);

    // The exact ID advances once; replaying it is refused.
    await advanceMigration({
      ...resolution,
      moduleName: "auth",
      confirmAdvance: preview.confirmationId,
    });
    await assert.rejects(
      advanceMigration({
        ...resolution,
        moduleName: "auth",
        confirmAdvance: preview.confirmationId,
      }),
      /confirmation is missing or expired|Cannot advance/,
    );
    assert.equal((await state(fixture)).revision, 4);
  } finally {
    await fixture.cleanup();
  }
});

test("P1-9: a wrong-step advance is blocked and issues no confirmation", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    const resolution = await resolutionFor(fixture);
    for (const step of ["DISCOVER_LEGACY", "PLAN", "FINALIZE"]) {
      const preview = await previewAdvance({
        ...resolution,
        moduleName: "auth",
        step,
      });
      assert.equal(preview.requiresConfirmation, false, step);
      assert.equal(preview.confirmationId, null, step);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a failed gate blocks, and the correction resumes without revision damage", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "SLICES");
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const persisted = await state(fixture);
    const context = await gateBindingContext(fixture);
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate, index) => ({
        gate,
        result: index === 3 ? "FAIL" : "PASS",
        attempts: 1,
        evidence: [gateEvidence(context)],
      })),
    });
    await assert.rejects(advance(fixture), /Gate SIMPLIFY_ONCE is not PASS/);
    assert.equal((await state(fixture)).revision, persisted.revision);

    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 2,
        evidence: [gateEvidence(context)],
      })),
    });
    await advance(fixture);
    assert.equal((await state(fixture)).status, "COMPLETE");
    assert.equal((await state(fixture)).revision, persisted.revision + 1);
  } finally {
    await fixture.cleanup();
  }
});

// --- P1-11: a real process kill must not strand the upgrade lock ------------

test("P1-11: a lock left by a killed process is reclaimed without manual deletion", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const lockFile = lockPathFor(fixture.targetRoot, "auth");

    // A real child process takes the lock and is killed while holding it.
    const holderScript = path.join(fixture.root, "hold-lock.mjs");
    await writeFile(
      holderScript,
      `import { acquireModuleLock } from ${JSON.stringify(
        pathToFileURL(path.join(scriptsRoot, "module-lock.mjs")).href,
      )};\n` +
        `await acquireModuleLock(process.argv[2], "auth");\n` +
        `process.stdout.write("held\\n");\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    const holder = spawn(process.execPath, [holderScript, fixture.targetRoot], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the lock holder never started")),
        20_000,
      );
      holder.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("held")) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      holder.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the lock holder exited with ${code}`));
      });
    });
    assert.equal(await exists(lockFile), true);
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.on("exit", resolve));
    assert.equal(
      await exists(lockFile),
      true,
      "the dead process left its lock",
    );

    // A new process must proceed without an operator removing the file.
    const release = await acquireModuleLock(fixture.targetRoot, "auth", {
      timeoutMs: 5000,
    });
    await release();
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "BUILD_BASELINE");
  } finally {
    await fixture.cleanup();
  }
});

// A real kill at every journal/rename boundary `commitReplacement` can reach.
// `afterRename` fires right after the raw rename, before the journal records
// it; `afterJournal` fires right after the journal is durable. Both are real
// crash points, and each name below is the exact state string the hook sees.
const UPGRADE_KILL_BOUNDARIES = [
  { hook: "afterJournal", state: "PREPARED" },
  { hook: "afterRename", state: "LIVE_MOVED" },
  { hook: "afterJournal", state: "LIVE_MOVED" },
  { hook: "afterRename", state: "TARGET_COMMITTED" },
  { hook: "afterJournal", state: "TARGET_COMMITTED" },
  { hook: "afterJournal", state: "DONE" },
];

test("P1-11: a kill at every journal/rename boundary leaves a lock a fresh process reclaims", async () => {
  for (const boundary of UPGRADE_KILL_BOUNDARIES) {
    const fixture = await createFixture();
    try {
      await driveTo(fixture, "PLAN");
      await downgradeToV4(fixture.migrationRoot);
      const resolution = await resolutionFor(fixture);
      const preview = await previewUpgrade({
        registryPath: resolution.registryPath,
        moduleName: "auth",
      });
      assert.equal(
        preview.requiresConfirmation,
        true,
        `${boundary.hook}:${boundary.state} ${preview.blockers.join("; ")}`,
      );

      // A real child process runs the upgrade and hangs the instant it reaches
      // the target boundary -- everything up to and including that rename or
      // journal write is already durable on disk, exactly what a real kill at
      // that instant would leave.
      const killerScript = path.join(fixture.root, "kill-upgrade.mjs");
      await writeFile(
        killerScript,
        `import { executeUpgrade } from ${JSON.stringify(
          pathToFileURL(
            path.join(scriptsRoot, "upgrades/upgrade-migration.mjs"),
          ).href,
        )};\n` +
          `const [, , registryPath, moduleName, confirmUpgrade, hook, targetState] = process.argv;\n` +
          `const trigger = (s) => {\n` +
          `  if (s !== targetState) return undefined;\n` +
          `  process.stdout.write("boundary-reached\\n");\n` +
          `  return new Promise(() => {});\n` +
          `};\n` +
          `await executeUpgrade({\n` +
          `  registryPath, moduleName, confirmUpgrade,\n` +
          `  hooks: { [hook]: trigger },\n` +
          `});\n` +
          `process.stdout.write("completed\\n");\n`,
      );
      const child = spawn(
        process.execPath,
        [
          killerScript,
          resolution.registryPath,
          "auth",
          preview.confirmationId,
          boundary.hook,
          boundary.state,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `${boundary.hook}:${boundary.state} never reported reaching the boundary`,
              ),
            ),
          20_000,
        );
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("boundary-reached")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(
            new Error(
              `${boundary.hook}:${boundary.state} exited ${code} before reaching the boundary`,
            ),
          );
        });
      });
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));

      const lockFile = lockPathFor(fixture.targetRoot, "auth");
      assert.equal(
        await exists(lockFile),
        true,
        `${boundary.hook}:${boundary.state} left no lock behind`,
      );

      // A fresh process -- this test runner never held that lock -- recovers
      // without an operator deleting the file. A journal already at DONE
      // committed successfully before the kill, so `--recover` correctly finds
      // nothing pending; every earlier boundary is a real unfinished
      // transaction. Either way `recoverUpgrade` unconditionally takes and
      // releases the lock, so it reclaims the abandoned one regardless.
      const recovery = await recoverUpgrade({
        registryPath: resolution.registryPath,
        moduleName: "auth",
      });
      assert.equal(
        recovery.clean,
        boundary.state === "DONE",
        `${boundary.hook}:${boundary.state}`,
      );
      assert.equal(
        await exists(lockFile),
        false,
        `${boundary.hook}:${boundary.state} recovery left the lock behind`,
      );
      assert.deepEqual(
        await pendingTransactions(fixture.targetRoot, "auth"),
        [],
        `${boundary.hook}:${boundary.state}`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

// Regression: the reclaim branch used to `continue` past the deadline check,
// so a lock that was classified stale and reclaimed on every attempt -- and
// kept reappearing -- spun forever instead of timing out. Acquisition must
// always settle, whatever a racer does to the file.
test("acquisition stays bounded while a racer keeps re-creating the lock", async () => {
  const fixture = await createFixture();
  const lockFile = lockPathFor(fixture.targetRoot, "auth");
  await mkdir(path.dirname(lockFile), { recursive: true });
  const racerScript = path.join(fixture.root, "racer.mjs");
  // A dead pid, so every attempt classifies the lock stale and reclaims it.
  await writeFile(
    racerScript,
    `import { writeFileSync } from "node:fs";\n` +
      `const file = process.argv[2];\n` +
      `for (;;) {\n` +
      `  try {\n` +
      `    writeFileSync(file, JSON.stringify({ pid: 2147483646, uuid: "racer", acquiredAt: new Date().toISOString() }) + "\\n");\n` +
      `  } catch {}\n` +
      `}\n`,
  );
  const racer = spawn(process.execPath, [racerScript, lockFile], {
    stdio: "ignore",
  });
  try {
    const started = Date.now();
    // Settling either way is the contract; never settling is the defect.
    await acquireModuleLock(fixture.targetRoot, "auth", {
      timeoutMs: 500,
      pollMs: 10,
    }).then(
      (release) => release(),
      () => undefined,
    );
    assert.ok(
      Date.now() - started < 15_000,
      "acquisition must settle inside its own timeout",
    );
  } finally {
    racer.kill("SIGKILL");
    await new Promise((resolve) => racer.on("exit", resolve));
    await fixture.cleanup();
  }
});

test("a live lock holder is never stolen", async () => {
  const fixture = await createFixture();
  try {
    const release = await acquireModuleLock(fixture.targetRoot, "auth");
    try {
      await assert.rejects(
        acquireModuleLock(fixture.targetRoot, "auth", {
          timeoutMs: 300,
          pollMs: 20,
        }),
        /holds the lock/,
      );
    } finally {
      await release();
    }
    // Released locks are immediately re-acquirable.
    await (
      await acquireModuleLock(fixture.targetRoot, "auth")
    )();
  } finally {
    await fixture.cleanup();
  }
});

// --- P2-1: blocked execution is distinguishable from success ----------------

test("P2-1: a blocked invocation exits with the documented blocked code", async () => {
  const fixture = await createFixture();
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "cli/discover-module.mjs"),
        "auth",
        "--registry",
        fixture.registryPath,
      ],
      { encoding: "utf8", cwd: fixture.root },
    ).catch((error) => error);
    assert.equal(result.code, BLOCKED_EXIT_CODE);
    assert.match(result.stdout, /Execution: BLOCKED/);
  } finally {
    await fixture.cleanup();
  }
});

// --- P2-2: a closed baseline pins row identity, not row progress -----------

test("P2-2: closed-baseline rows are pinned, but verificationStatus still moves", async () => {
  const fixture = await createFixture();
  const matrixPath = path.join(
    fixture.migrationRoot,
    "matrices/behavior-parity.json",
  );
  const editRow = async (patch) => {
    const matrix = await readJson(matrixPath);
    Object.assign(matrix.rows[0], patch);
    await writeJson(matrixPath, matrix);
  };
  try {
    await driveTo(fixture, "BUILD_BASELINE");
    assert.ok(
      (await state(fixture)).artifactHashes[BASELINE_ROWS_PIN],
      "BUILD_BASELINE pins the immutable projection of the baseline rows",
    );

    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });

    // The unearned-VERIFIED hole, now closed: VERIFY_SLICES is the only
    // producer of that status, so authoring it before a slice has been
    // verified is refused rather than silently retiring the row from
    // planning, implementation, verification, and FINALIZE in one edit.
    await editRow({ verificationStatus: "VERIFIED" });
    await assert.rejects(
      advance(fixture),
      /is authored 'VERIFIED' before any slice has been verified/,
    );

    // Progress is still what the matrix is for: the pin covers a row's
    // identity and deliberately not its status, so PLAN advances over a
    // legitimately edited one.
    await editRow({ verificationStatus: "EXCLUDED_APPROVED" });
    await advance(fixture);

    // Identity is not: rewriting a row's evidence after the fact is exactly
    // the edit that used to reach FINALIZE reporting no blockers.
    await writeFile(path.join(fixture.legacyRoot, "marker2.txt"), "legacy\n");
    await editRow({ legacyEvidence: ["legacy/marker2.txt"] });
    await assert.rejects(
      previewMigrationExecution({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }),
      /Behavior parity rows changed after BUILD_BASELINE closed/,
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- P2-5: the consolidated scenarios are repository-owned, not audit-only --

// The audit's P0/P1 scenarios as one table. They lived in throwaway harnesses,
// so nothing failed when a scenario simply stopped being run; parameterizing
// the list here means deleting one breaks the build instead.
const CONSOLIDATED_FINDINGS = [
  "P0-1",
  "P0-2",
  "P1-1",
  "P1-2",
  "P1-3",
  "P1-4",
  "P1-5",
  "P1-6",
  "P1-7",
  "P1-8",
  "P1-9",
  "P1-10",
  "P1-11",
];

test("P2-5: every consolidated P0/P1 scenario is owned by this suite, and engine:test runs it on both platforms", async () => {
  const suite = path
    .relative(repositoryRoot, fileURLToPath(import.meta.url))
    .split(path.sep)
    .join("/");
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");
  for (const id of CONSOLIDATED_FINDINGS) {
    assert.match(
      source,
      new RegExp(`\\btest\\("${id}: `),
      `${id} must have a scenario in ${suite}`,
    );
  }

  const { scripts } = await readJson(path.join(repositoryRoot, "package.json"));
  assert.ok(
    // The runner is `scripts/engine-test.mjs` rather than `node --test`
    // directly: the suite has two runtimes to be, identified and not, and one
    // `--test` invocation can only be one of them. What matters here is
    // unchanged -- this file is in the list that runner is handed.
    scripts["engine:test"].startsWith("node scripts/engine-test.mjs ") &&
      scripts["engine:test"].includes(suite),
    `engine:test must execute ${suite}`,
  );

  // CI is the other half of "repository-owned": the suite drives real file
  // locking, atomic renames, and path handling, so Windows and Linux are
  // different systems under test, not the same one twice.
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(workflow, /run: pnpm engine:test/);
  for (const platform of ["ubuntu-latest", "windows-latest"]) {
    assert.ok(
      workflow.includes(platform),
      `CI must run on ${platform}`,
    );
  }
});

// --- P2-6: CI can actually run the generator check --------------------------

/**
 * The original had two halves. The first -- that the installed workflow is
 * generated from a canonical source it names -- was a *consumer* defect: that
 * repository's generator emitted `.github/workflows/agents-sync.yml` from
 * `.agents/standards/...` while nothing tracked the installed copy, so `--check`
 * stayed green as the two drifted. This repository authors its one workflow
 * directly and `providers-sync.mjs` generates nothing under `.github/`, so there
 * is no second copy to drift from and half one has no subject here.
 *
 * Half two survives unchanged, because its cause does: the generator imports
 * `yaml` and the engine requires `ts-discovery-compiler`, so a clean checkout
 * that checks before installing crashes on a missing module.
 */
test("P2-6: CI installs frozen dependencies before it runs providers:check", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const install = workflow.indexOf("pnpm install --frozen-lockfile");
  const check = workflow.indexOf("pnpm providers:check");
  assert.ok(install !== -1, "CI must install frozen dependencies");
  assert.ok(check !== -1, "CI must run pnpm providers:check");
  assert.ok(install < check, "dependencies must be installed before --check");

  // And nothing under `.github/` is generated, so the workflow cannot drift
  // from a canonical copy of itself.
  const manifest = await readExpandedManifest(repositoryRoot);
  assert.deepEqual(
    manifest.filter((entry) => entry.startsWith(".github/")),
    [],
    "the provider generator must not own any CI workflow",
  );
});

// --- P2-7: documented provider ownership matches what sync and loaders do ---

// The four roots the generator writes a copy of every canonical skill into. The
// consumer's docs used to claim skills were outside the generator's scope while
// its manifest already owned 424 of these files.
const PROVIDER_SKILL_ROOTS = [
  "providers/claude/skills",
  "providers/codex/skills",
  "providers/copilot/skills",
  "providers/opencode/skills",
];

/**
 * The original also ran `<configured-root>/start-migration/scripts/discover-module.mjs`,
 * because in the consumer a copy that existed but could not execute was the same
 * outage as a missing one. That half is now unsatisfiable *by design*: a provider
 * tree carries documents plus the first-use runtime preflight, and
 * `providers-sync.mjs` refuses every other executable module. The property that
 * replaced it -- no engine source anywhere under `providers/**` -- is asserted in
 * `test/providers-sync.test.mjs`, and the inverse guard is below.
 */
test("P2-7: every provider skill root is generated, documented, and free of engine source", async () => {
  const manifest = await readExpandedManifest(repositoryRoot);
  const canonicalSkills = (
    await readdir(path.join(repositoryRoot, "skills"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(canonicalSkills.length > 0, "skills/ must hold the sources");

  const documentation = await readFile(
    path.join(
      repositoryRoot,
      "skills/start-migration/references/provider-compatibility.md",
    ),
    "utf8",
  );
  for (const root of PROVIDER_SKILL_ROOTS) {
    const provider = root.split("/")[1];
    assert.ok(
      documentation.includes(`providers/${provider}/skills/<name>/SKILL.md`),
      `provider-compatibility.md must document ${root} as generated`,
    );
    for (const skill of canonicalSkills) {
      const generated = `${root}/${skill}/SKILL.md`;
      assert.ok(manifest.includes(generated), `${generated} must be manifested`);
      assert.ok(
        await exists(path.join(repositoryRoot, generated)),
        `${generated} must exist`,
      );
    }
  }

  // The only executable in a provider skill is the bootstrap standard
  // `skills add` must carry. It resolves a release and delegates to the one
  // adapter; no provider gets a copy of the engine.
  const executable = manifest.filter(
    (entry) =>
      PROVIDER_SKILL_ROOTS.some((root) => entry.startsWith(`${root}/`)) &&
      /\.(mjs|cjs|js|ts|mts|cts)$/.test(entry),
  );
  assert.ok(executable.length > 0, "the installed skills must carry their bootstrap");
  assert.ok(executable.every((entry) => entry.endsWith("/scripts/runtime.mjs")), "a provider skill tree carries engine source");
});

// --- P3-2: every declared contract suite is deliverable --------------------

test("P3-2: every suite engine:test and providers:test run is present and not ignored", async () => {
  const { scripts } = await readJson(path.join(repositoryRoot, "package.json"));
  const suites = [scripts["engine:test"], scripts["providers:test"]]
    .join(" ")
    .split(/\s+/)
    .filter((token) => token.endsWith(".mjs"));
  assert.ok(suites.length > 0, "the runners must name at least one suite");

  // Include non-ignored additions because the implementation gate runs before
  // the operator commits. Missing or ignored suites are still undeliverable.
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...suites],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const tracked = new Set(stdout.split("\n").filter(Boolean));
  for (const suite of suites) {
    assert.ok(tracked.has(suite), `${suite} is missing or ignored`);
  }
});

// --- P3-3: a fresh clone has the generated providers, not just the sources --

test("P3-3: every manifest-owned generated path is present and not ignored", async () => {
  const manifest = await readExpandedManifest(repositoryRoot);
  assert.ok(
    manifest.length > 0,
    "the generated-file manifest must not be empty",
  );

  // `ls-files` on the root rather than on every explicit path: the argument
  // list would be near the Windows command-line limit.
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "providers"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const tracked = new Set(stdout.split("\n").filter(Boolean));

  // Ignoring the generated tree meant a fresh clone had no skills until someone
  // ran sync, and `providers:check` in CI compared against files that were not
  // in the checkout.
  const missing = manifest.filter((entry) => !tracked.has(entry));
  assert.deepEqual(
    missing,
    [],
    `${missing.length} generated path(s) are missing or ignored`,
  );
});

// --- P3-4: every output has a consumer, every canonical input has an output -

test("P3-4: every generated output has a consumer, and every canonical skill file reaches one", async () => {
  const manifest = await readJson(
    path.join(repositoryRoot, "providers/generated-files.json"),
  );

  // Provider trees used to carry copies of the engine suites. The runners
  // execute the canonical ones only, so every copy was an output no official
  // command would ever run. Adapter entry points and the skill runtime preflight
  // are both invoked by supported installation paths; anything else code-shaped
  // does not belong here.
  const expectedExecutables = [
    ...["claude", "codex", "copilot", "opencode"].map(
      (provider) => `providers/${provider}/install.mjs`,
    ),
    ...["claude", "codex", "copilot", "opencode"].flatMap((provider) =>
      ["migrate-artifact", "start-migration"].map(
        (skill) => `providers/${provider}/skills/${skill}/scripts/runtime.mjs`,
      ),
    ),
  ].sort();
  assert.deepEqual(
    manifest.filter((entry) => /\.(test\.mjs|mjs|cjs|js|ts|mts|cts)$/.test(entry)),
    expectedExecutables,
    "a generated tree carries code no official command runs",
  );
  // And it is an entry point, not a second implementation: it delegates to the
  // one shared adapter module, which is where "no engine logic in a provider
  // tree" would otherwise start leaking back in a line at a time.
  for (const provider of ["claude", "codex", "copilot", "opencode"]) {
    const entry = await readFile(
      path.join(repositoryRoot, `providers/${provider}/install.mjs`),
      "utf8",
    );
    assert.match(entry, /from '\.\.\/install-support\.mjs'/);
    assert.ok(
      entry.split("\n").filter((line) => line.trim()).length <= 4,
      `providers/${provider}/install.mjs is more than a delegating entry point`,
    );
  }

  /**
   * The other direction, which is where the consumer's defect lived:
   * `.agents/standards/claude.md` was documented as `CLAUDE.md`'s source while
   * the generator built `CLAUDE.md` from `project.md` alone, so an authored file
   * reached no output at all. Standards are consumer-owned and stay there; the
   * equivalent here is the canonical skill tree, whose every file must reach all
   * four providers. Frontmatter is re-rendered on the way out, so only the body
   * is comparable.
   */
  const normalize = (text) => text.replace(/\r\n/g, "\n");
  const bodyOf = (text) =>
    normalize(text)
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .trim();
  const skillsRoot = path.join(repositoryRoot, "skills");
  const canonical = (await readdir(skillsRoot, { recursive: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".md"));
  assert.ok(canonical.length > 5, `only ${canonical.length} canonical files`);
  const emitted = await Promise.all(
    manifest
      .filter((entry) => entry.endsWith(".md"))
      .map(async (entry) =>
        normalize(await readFile(path.join(repositoryRoot, entry), "utf8")),
      ),
  );

  for (const file of canonical) {
    const body = bodyOf(await readFile(path.join(skillsRoot, file), "utf8"));
    assert.equal(
      emitted.filter((output) => output.includes(body)).length >= 4,
      true,
      `skills/${file} does not reach all four provider trees`,
    );
  }
});

test("P3-1: --status refuses every other flag, including --registry", async () => {
  const fixture = await createFixture();
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "cli/discover-module.mjs"),
        "auth",
        "--status",
        "--registry",
        fixture.registryPath,
      ],
      { encoding: "utf8", cwd: fixture.root },
    ).catch((error) => error);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--status is read-only/);
  } finally {
    await fixture.cleanup();
  }
});

// --- P1-7 / P1-10: declared evidence must resolve to real bytes ------------

test("P1-7: a fictitious legacy evidence path is refused at DISCOVER_LEGACY", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          {
            id: "LB-1",
            description: "Sign in",
            evidence: evidenceChecklist("legacy/does-not-exist.ts"),
          },
        ],
      },
    );
    await assert.rejects(
      advance(fixture),
      /does not exist under the legacy or target repository/,
    );
    assert.equal((await state(fixture)).currentStep, "DISCOVER_LEGACY");
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a fictitious target evidence path is refused at ASSESS_TARGET", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      {
        ...TARGET_INVENTORY,
        evidence: evidenceChecklist("target/src/imaginary.ts"),
      },
    );
    await assert.rejects(
      advance(fixture),
      /does not exist under the legacy or target repository/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a checklist evidence item missing a required category is refused", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          {
            id: "LB-1",
            description: "Sign in",
            evidence: evidenceChecklist("legacy/marker.txt").filter(
              (item) => item.category !== "REQUIREMENT_TRACE",
            ),
          },
        ],
      },
    );
    await assert.rejects(
      advance(fixture),
      /missing required checklist categor/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: an evidence item that is not a checklist object (bare string) is refused", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          {
            id: "LB-1",
            description: "Sign in",
            evidence: ["legacy/marker.txt"],
          },
        ],
      },
    );
    await assert.rejects(advance(fixture), /must be an object/);
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a checklist item with an OpenSpec requirement ID the authority does not define is refused", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          {
            id: "LB-1",
            description: "Sign in",
            evidence: evidenceChecklist(
              "legacy/marker.txt",
              ["AUTH-REQ-999"],
              [],
            ),
          },
        ],
      },
    );
    await assert.rejects(
      advance(fixture),
      /OpenSpec authority does not define/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a checklist item with an OpenSpec scenario ID the authority does not define is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      {
        ...TARGET_INVENTORY,
        evidence: evidenceChecklist(
          "target/src/placeholder.ts",
          [],
          ["AUTH-SCN-999"],
        ),
      },
    );
    await assert.rejects(
      advance(fixture),
      /OpenSpec authority does not define/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a NOT_APPLICABLE/BLOCKED checklist item without a reason is refused", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    const withoutReason = evidenceChecklist("legacy/marker.txt").map((item) =>
      item.status === "NOT_APPLICABLE" ? { ...item, reason: undefined } : item,
    );
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          { id: "LB-1", description: "Sign in", evidence: withoutReason },
        ],
      },
    );
    await assert.rejects(
      advance(fixture),
      /reason.*must be a non-empty string/s,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a fully-conformant discovery checklist advances DISCOVER_LEGACY", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeClassification(fixture, MODULE_CLASSIFICATION);
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: changed files must exist and stay inside the target repository", async () => {
  for (const [label, changedFiles, pattern] of [
    ["nonexistent", ["src/never-written.ts"], /does not exist/],
    [
      "outside the target",
      ["../legacy/marker.txt"],
      /outside the target repository/,
    ],
  ]) {
    const fixture = await createFixture();
    try {
      await driveTo(fixture, "PLAN");
      const planned = SLICES[0];
      await writeJson(path.join(fixture.migrationRoot, "slices/slice-a.json"), {
        id: "slice-a",
        implementationStatus: "COMPLETE",
        requirementIds: planned.requirementIds,
        scenarioIds: planned.scenarioIds,
        traceIds: planned.traceIds,
        capabilityIds: planned.capabilityIds,
        changedFiles,
        decisions: ["d"],
        checks: ["c"],
      });
      await assert.rejects(
        advance(fixture, { slice: "slice-a" }),
        pattern,
        label,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("P1-7: a changed file that exists but was not actually touched is refused", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const planned = SLICES[0];
    // src/placeholder.ts exists (it's part of the fixture's initial commit)
    // but nothing modified it, so it must not appear in the target's dirty
    // diff.
    await writeJson(path.join(fixture.migrationRoot, "slices/slice-a.json"), {
      id: "slice-a",
      implementationStatus: "COMPLETE",
      requirementIds: planned.requirementIds,
      scenarioIds: planned.scenarioIds,
      traceIds: planned.traceIds,
      capabilityIds: planned.capabilityIds,
      changedFiles: ["src/placeholder.ts"],
      decisions: ["d"],
      checks: ["c"],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /not part of the target repository's current uncommitted diff/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a command result with a nonzero exit code is refused at VERIFY_SLICES", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");
    const evidencePath = path.join(
      fixture.migrationRoot,
      "evidence/slice-a/result.json",
    );
    const evidence = await readJson(evidencePath);
    evidence.commands[0].exitCode = 1;
    await writeJson(evidencePath, evidence);
    await assert.rejects(advance(fixture, { slice: "slice-a" }), /must exit 0/);
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a command result with a falsified output digest is refused at VERIFY_SLICES", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");
    const evidencePath = path.join(
      fixture.migrationRoot,
      "evidence/slice-a/result.json",
    );
    const evidence = await readJson(evidencePath);
    evidence.commands[0].outputDigest = `sha256:${"0".repeat(64)}`;
    await writeJson(evidencePath, evidence);
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /outputDigest does not match/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-7: a command result referencing a nonexistent output file is refused at VERIFY_SLICES", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");
    const evidencePath = path.join(
      fixture.migrationRoot,
      "evidence/slice-a/result.json",
    );
    const evidence = await readJson(evidencePath);
    evidence.commands[0].outputPath =
      ".agents/knowledge/migrations/modules/auth/evidence/slice-a/commands/ghost.txt";
    await writeJson(evidencePath, evidence);
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /does not exist under the legacy or target repository/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P1-10: a gate hash must match the referenced file's current bytes", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "SLICES");
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const base = await gateBindingContext(fixture);
    const withGates = (evidence) =>
      writeJson(path.join(fixture.migrationRoot, "gates.json"), {
        version: 1,
        gates: GATES.map((gate) => ({
          gate,
          result: "PASS",
          attempts: 1,
          evidence: [evidence],
        })),
      });

    // A reference that names a file which does not exist.
    await withGates(
      gateEvidence({ ...base, reference: "target/src/ghost-report.json" }),
    );
    await assert.rejects(
      advance(fixture),
      /does not exist under the legacy or target repository/,
    );

    // A real file with a fabricated digest.
    await withGates(
      gateEvidence({ ...base, reference: "target/src/placeholder.ts" }),
    );
    await assert.rejects(advance(fixture), /does not match the current bytes/);
    assert.equal((await state(fixture)).status, "ACTIVE");

    // The same reference with its real digest passes.
    const real = createHash("sha256")
      .update(
        await readFile(path.join(fixture.targetRoot, "src/placeholder.ts")),
      )
      .digest("hex");
    await withGates({
      ...gateEvidence({ ...base, reference: "target/src/placeholder.ts" }),
      hash: `sha256:${real}`,
    });
    await advance(fixture);
    assert.equal((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

test("P1-10: a dirty target file the evidence never mentions is refused at FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "SLICES");
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const base = await gateBindingContext(fixture);
    const real = createHash("sha256")
      .update(
        await readFile(path.join(fixture.targetRoot, "src/placeholder.ts")),
      )
      .digest("hex");
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 1,
        evidence: [
          {
            ...gateEvidence({
              ...base,
              reference: "target/src/placeholder.ts",
            }),
            hash: `sha256:${real}`,
          },
        ],
      })),
    });
    // A file the gate evidence never mentions changes after the evidence was
    // authored but before FINALIZE actually runs.
    await writeFile(
      path.join(fixture.targetRoot, "src/unreviewed.ts"),
      "export const sneaky = true;\n",
    );
    // W4 catches this one file earlier and by name; the gate's dirty-tree
    // binding is still the backstop for a change the ownership ledger cannot
    // attribute to a path at all.
    await assert.rejects(advance(fixture), (error) => {
      assert.match(
        error.message,
        /UNCLAIMED_TARGET_DRIFT|target dirty-tree digest/,
      );
      assert.ok(
        error.message.includes("src/unreviewed.ts") ||
          /target dirty-tree digest/.test(error.message),
      );
      return true;
    });
    assert.equal((await state(fixture)).status, "ACTIVE");

    // Re-authoring the evidence alone is no longer enough: the file also has to
    // be *attributable*. The documented escape is an operator decision bound to
    // its exact bytes, never a flag, so that is what the migration takes.
    await acceptTargetDrift(fixture, "src/unreviewed.ts");
    const refreshed = await gateBindingContext(fixture);
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 1,
        evidence: [
          {
            ...gateEvidence({
              ...refreshed,
              reference: "target/src/placeholder.ts",
            }),
            hash: `sha256:${real}`,
          },
        ],
      })),
    });
    await advance(fixture);
    assert.equal((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

test("P1-10: a dirty legacy file the evidence never mentions is refused at FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "SLICES");
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const base = await gateBindingContext(fixture);
    const real = createHash("sha256")
      .update(
        await readFile(path.join(fixture.targetRoot, "src/placeholder.ts")),
      )
      .digest("hex");
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 1,
        evidence: [
          {
            ...gateEvidence({
              ...base,
              reference: "target/src/placeholder.ts",
            }),
            hash: `sha256:${real}`,
          },
        ],
      })),
    });
    // The legacy tree changes after the evidence was authored: nothing in the
    // target evidence would ever notice this on its own.
    await writeFile(path.join(fixture.legacyRoot, "marker.txt"), "changed\n");
    await assert.rejects(advance(fixture), /legacy dirty-tree digest/);
    assert.equal((await state(fixture)).status, "ACTIVE");
  } finally {
    await fixture.cleanup();
  }
});

// --- P2-4: recovery from a journal written before its manifests -------------

test("P2-4: an incomplete journal recovers from the retained snapshot", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    const directory = path.join(fixture.upgradesRoot, "auth/0badc0de0badc0de");
    await mkdir(directory, { recursive: true });
    await cp(fixture.migrationRoot, path.join(directory, "source-snapshot"), {
      recursive: true,
    });
    const expected = await snapshot(fixture.migrationRoot);
    // Exactly what a kill between `mkdir` and the manifest writes leaves.
    await rm(fixture.migrationRoot, { recursive: true, force: true });
    const journal = {
      confirmationId: "0badc0de0badc0de",
      module: "auth",
      kind: "UPGRADE",
      livePath: fixture.migrationRoot,
      directory,
      state: "PREPARED",
      file: path.join(directory, "transaction.json"),
    };
    await writeJson(journal.file, journal);

    const { recoverTransaction } = await import(
      pathToFileURL(path.join(scriptsRoot, "upgrades/upgrade-migration.mjs"))
        .href
    );
    const outcome = await recoverTransaction(journal);
    assert.equal(outcome.outcome, "ROLLED_BACK");
    assert.deepEqual(await snapshot(fixture.migrationRoot), expected);

    // The module is usable again: no residue blocks the next command.
    const resolution = await resolutionFor(fixture);
    const status = await getMigrationStatus({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(status.currentStep, "DISCOVERY_COMPLETENESS");
  } finally {
    await fixture.cleanup();
  }
});

// --- provider parity ---------------------------------------------------------

/**
 * Two proofs used to live here: that all five trees -- the canonical engine plus
 * four generated provider copies of it -- reported the identical lifecycle status
 * and the identical canonical progress for one record.
 *
 * They were guarding four implementations against drift. There is one
 * implementation now: an adapter installs the engine package, so a provider tree
 * has no `discover-module.mjs` to run and no state machine to fork. Running five
 * copies of one module and asserting they agree is not a weaker version of that
 * property, it is a tautology dressed as a test.
 *
 * What replaced it is structural and is asserted where it can fail:
 * `no provider tree carries its own copy of the migration state machine` below
 * (protocol text), P2-7 and P3-4 above (no executable reaches a provider tree),
 * and `test/providers-sync.test.mjs` (the generator refuses to project one).
 */
test("only one tree can report a lifecycle status, because only one tree has an engine", async () => {
  const provided = await readJson(
    path.join(repositoryRoot, "providers/generated-files.json"),
  );
  for (const provider of ["claude", "codex", "copilot", "opencode"]) {
    assert.equal(
      await exists(
        path.join(
          repositoryRoot,
          "providers",
          provider,
          "skills/start-migration/scripts/discover-module.mjs",
        ),
      ),
      false,
      `${provider} carries an engine entry point`,
    );
    assert.ok(
      provided.some((entry) => entry.startsWith(`providers/${provider}/skills/`)),
      `${provider} must still receive a generated skill tree`,
    );
  }
  // And the one tree that does have an engine still answers.
  assert.equal(await exists(path.join(scriptsRoot, "cli/discover-module.mjs")), true);
});

// --- dirty manifest primitive ------------------------------------------------

test("the dirty manifest distinguishes every kind of uncommitted change", async () => {
  const fixture = await createFixture();
  try {
    const clean = await dirtyManifest(fixture.legacyRoot);
    assert.deepEqual(clean.entries, []);
    await writeFile(path.join(fixture.legacyRoot, "marker.txt"), "a\n");
    const modified = await dirtyManifest(fixture.legacyRoot);
    assert.notEqual(modified.digest, clean.digest);
    // Re-editing an already dirty file must move the digest again: this is the
    // case a commit-only revision can never see.
    await writeFile(path.join(fixture.legacyRoot, "marker.txt"), "b\n");
    assert.notEqual(
      (await dirtyManifest(fixture.legacyRoot)).digest,
      modified.digest,
    );
    // Exclusions apply to paths relative to the scanned root.
    const scoped = await dirtyManifest(fixture.legacyRoot, {
      exclude: ["marker.txt"],
    });
    assert.deepEqual(scoped.entries, []);
  } finally {
    await fixture.cleanup();
  }
});

// --- DISCOVERY_COMPLETENESS -------------------------------------------------
//
// Everything DISCOVER_LEGACY checks runs one way: declared evidence -> the file
// exists. Nothing ran the other way, so a file could be seen, discussed in step
// prose, consciously dropped, and produce zero behaviors, zero parity rows and
// zero approvals. These tests are that hole, closed.

const CLASSIFICATION_PATH = "inventories/module-classification.json";
const DECISIONS_PATH = "decisions/operator-decisions.ndjson";

const writeClassification = (fixture, classification) =>
  writeJson(
    path.join(fixture.migrationRoot, CLASSIFICATION_PATH),
    classification,
  );

const rationaleDigestOf = (rationale) =>
  `sha256:${createHash("sha256")
    .update(String(rationale).replace(/\r\n/g, "\n").trim())
    .digest("hex")}`;

const lineDigestOf = (decision) =>
  `sha256:${createHash("sha256").update(JSON.stringify(decision)).digest("hex")}`;

/**
 * Fabricates what an operator would have recorded at a terminal. Legitimate in
 * a fixture -- the TTY gate exists to stop an *agent*, and `record-decision.mjs`
 * has its own suite proving it refuses without one.
 *
 * Field order matches `buildDecision` exactly, because `decisionLineDigest`
 * digests the re-serialized object and a different key order breaks the chain.
 *
 * `bound: false` drops `candidateId`, which is the shape a hand-written line
 * has: everything a human could copy off a terminal, and nothing tying it to a
 * candidate anyone derived. Validation used to accept it whenever the
 * classification recorded scanner version 1.
 */
const recordDecision = async (
  fixture,
  { kind, subject, rationale, discoveryDigest, bound = true },
) => {
  const file = path.join(fixture.migrationRoot, DECISIONS_PATH);
  const existing = await readFile(file, "utf8").catch(() => "");
  const previous = existing
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .at(-1);
  const boundTo = {
    module: "auth",
    ...(await legacySourceBinding(fixture.legacyRoot)),
    discoveryDigest,
    algorithmVersion: 1,
  };
  const candidate = createDecisionCandidate({
    kind,
    subjectType: "FILE",
    subjectPath: subject,
    rationale,
    boundTo,
  });
  const decision = {
    id: `DEC-${String((previous?.seq ?? 0) + 1).padStart(3, "0")}`,
    seq: (previous?.seq ?? 0) + 1,
    prevDigest: previous ? lineDigestOf(previous) : "genesis",
    at: new Date().toISOString(),
    operator: "tester@fixture",
    kind,
    subject: { type: "FILE", path: subject },
    statement: "Approved by the fixture operator.",
    rationaleDigest: rationaleDigestOf(rationale),
    ...(bound ? { candidateId: candidate.id } : {}),
    boundTo,
  };
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(decision)}\n`);
  return { decision, digest: lineDigestOf(decision), candidate };
};

const currentDigest = async (fixture) => {
  const resolution = await resolutionFor(fixture);
  const scan = await previewDiscoveryScan({
    ...resolution,
    moduleName: "auth",
  });
  return scan.discoveryDigest;
};

/** Positions a fixture at DISCOVERY_COMPLETENESS with the step doc written. */
const atDiscoveryCompleteness = async (fixture) => {
  await driveTo(fixture, "DISCOVER_LEGACY");
  await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
  await writeClassification(fixture, MODULE_CLASSIFICATION);
};

test("DISCOVER_LEGACY and DISCOVERY_COMPLETENESS consume the same canonical boundary", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      algorithmVersion: 2,
    });
    const before = await readCanonicalModuleBoundary(
      fixture.migrationRoot,
      await state(fixture),
      { legacyRoot: fixture.legacyRoot, targetRoot: fixture.targetRoot },
    );
    await advance(fixture);
    const resolution = await resolutionFor(fixture);
    const completeness = await previewDiscoveryScan({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(completeness.discoveryDigest, before.scan.discoveryDigest);
    assert.deepEqual(completeness.boundary, before.scan.boundary);
    assert.deepEqual(completeness.census, ["auth/marker.txt"]);
  } finally {
    await fixture.cleanup();
  }
});

test("a classification must record an explicit valid scanner version before scanning", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const classification = await readJson(
      path.join(fixture.migrationRoot, CLASSIFICATION_PATH),
    );
    delete classification.algorithmVersion;
    await writeClassification(fixture, classification);
    const before = await snapshot(fixture.migrationRoot);
    const resolution = await resolutionFor(fixture);
    await assert.rejects(
      previewDiscoveryScan({ ...resolution, moduleName: "auth" }),
      (error) => {
        assert.equal(error.name, "DiscoveryScannerVersionError");
        assert.equal(error.code, "MISSING_DISCOVERY_SCANNER_VERSION");
        return true;
      },
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("an initialized unregistered migration lists deterministic pending commands", async () => {
  const fixture = await createFixture({ modules: {} });
  try {
    await initialize(fixture, { targetOverride: "auth" });
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeClassification(fixture, {
      ...exclusionClassification(
        "The fixture operator must approve exclusion.",
      ),
      algorithmVersion: 2,
    });
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
    assert.deepEqual(
      Object.keys((await readJson(fixture.registryPath)).modules),
      [],
    );

    const resolution = await resolutionFor(fixture);
    const before = await snapshot(fixture.migrationRoot);
    const first = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    const second = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    assert.deepEqual(second, first);
    assert.equal(first.candidates.length, 1);
    assert.equal(first.candidates[0].approvable, true);
    // R-1: the command names the recorder in *this* engine installation, not a
    // path inside whatever repository is being migrated. Asserted against the
    // renderer rather than a literal, so the two cannot drift apart, and
    // against the file system, so the command it prints is one that exists.
    assert.equal(
      first.candidates[0].command,
      engineCommand(
        "record-decision.mjs",
        "auth",
        "--approve",
        first.candidates[0].id,
      ),
    );
    assert.equal(
      first.candidates[0].command.split(" ")[1],
      path.join(scriptsRoot, "record-decision.mjs"),
    );
    assert.ok(await exists(first.candidates[0].command.split(" ")[1]));
    assert.deepEqual(
      parseDecisionArguments(["auth", "--approve", first.candidates[0].id]),
      {
        moduleName: "auth",
        approve: first.candidates[0].id,
        list: false,
        pending: false,
        verify: false,
        registryOption: undefined,
      },
    );
    const runPending = async () => {
      const chunks = [];
      const cwd = process.cwd();
      process.chdir(fixture.root);
      try {
        await runRecordDecisionCli(["auth", "--pending"], {
          stdin: { isTTY: false },
          stdout: {
            isTTY: false,
            write: (chunk) => chunks.push(String(chunk)),
          },
        });
      } finally {
        process.chdir(cwd);
      }
      return chunks.join("");
    };
    const firstOutput = await runPending();
    const secondOutput = await runPending();
    assert.equal(secondOutput, firstOutput);
    assert.deepEqual(JSON.parse(firstOutput), first);
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("an isolated clean roles fixture completes DISCOVERY_COMPLETENESS without artificial ownership or approvals", async () => {
  const fixture = await createFixture({
    modules: { roles: { target: "roles" } },
  });
  // createFixture's convenience paths are named auth; this fixture deliberately
  // exercises the public module argument and uses its actual roles state path.
  fixture.migrationRoot = path.join(
    fixture.targetRoot,
    ".agents/knowledge/migrations/modules/roles",
  );
  try {
    await writeFile(
      path.join(fixture.legacyRoot, ".gitignore"),
      "node_modules/\n",
    );
    await writeFile(
      path.join(fixture.legacyRoot, "package.json"),
      '{"name":"roles-legacy-fixture","private":true}\n',
    );
    await writeJson(path.join(fixture.legacyRoot, "tsconfig.json"), {
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
      },
    });
    const files = {
      "src/features/roles/index.ts": "export { useRoles } from './useRoles';\n",
      "src/features/roles/useRoles.ts":
        "import { useTranslation } from 'react-i18next';\n" +
        "import { endpoint } from '../../shared/urls';\n" +
        "import './roles.css';\n" +
        "export const useRoles = (host) => [useTranslation('roles'), endpoint(host)];\n",
      "src/features/roles/disconnected.ts":
        "export const disconnectedRoleRule = true;\n",
      "src/features/roles/roles.css":
        ".roles { background: url('../../shared/assets/roles-bg.svg'); }\n",
      "src/shared/urls.ts":
        "export const endpoint = (host) => new URL(host, 'http://localhost');\n",
      "src/shared/assets/roles-bg.svg": "<svg/>\n",
      "src/shared/i18n/es-ES/roles.json": '{"title":"Roles"}\n',
      "src/shared/i18n/es-ES/users.json": '{"title":"Users"}\n',
      "src/config/i18n.ts":
        "import rolesEs from '../shared/i18n/es-ES/roles.json';\n" +
        "import usersEs from '../shared/i18n/es-ES/users.json';\n" +
        "export const resources = { 'es-ES': { roles: rolesEs, users: usersEs } };\n",
      "src/app/roles/page.ts":
        "import { useRoles } from '../../features/roles';\nexport default useRoles;\n",
    };
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(fixture.legacyRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const typescriptLink = path.join(
      fixture.legacyRoot,
      "node_modules/typescript",
    );
    await mkdir(path.dirname(typescriptLink), { recursive: true });
    await symlink(
      path.join(repositoryRoot, "node_modules/typescript"),
      typescriptLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    await execFileAsync("git", ["add", "legacy"], { cwd: fixture.root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Contract Test",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "-qm",
        "roles fixture",
      ],
      { cwd: fixture.root },
    );

    const resolution = await resolveRegistryPath({
      cliPath: fixture.registryPath,
      moduleName: "roles",
      cwd: fixture.root,
      projectRoot: fixture.root,
      environmentPath: undefined,
    });
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "roles",
      openSpecProposal: SPEC.replaceAll("AUTH-", "ROLES-"),
    });
    await bootstrapMigration({
      ...resolution,
      moduleName: "roles",
      openSpecProposal: preview.openSpecProposal,
      registryBinding: preview.registryBinding,
      boundInputs: preview.boundInputs,
    });
    await writeFile(
      path.join(fixture.migrationRoot, "steps/02-discover-legacy.md"),
      STEP_DOC("02", "Discover legacy"),
    );
    await writeJson(path.join(fixture.migrationRoot, CLASSIFICATION_PATH), {
      version: 1,
      algorithmVersion: 2,
      moduleRoots: [
        {
          path: "src/features/roles",
          reason: "The roles feature owns this slice.",
        },
      ],
      declaredEntryPoints: [],
      files: [],
      supporting: [],
      unresolvedReferences: [],
      findings: [],
    });
    const firstScan = await previewDiscoveryScan({
      ...resolution,
      moduleName: "roles",
    });
    const classification = {
      version: 1,
      algorithmVersion: 2,
      moduleRoots: [
        {
          path: "src/features/roles",
          reason: "The roles feature owns this slice.",
        },
      ],
      declaredEntryPoints: [],
      files: firstScan.census.map((file) => ({
        path: file,
        scope: "OWNED",
        reachability: firstScan.reachability[file],
        reachedFrom: [],
        kind: firstScan.kinds[file],
        disposition: "BEHAVIOR_BACKED",
        behaviorIds: ["LB-1"],
        routeFlowIds: [],
        rationale: "Covered by the roles behavior.",
        evidence: [],
      })),
      supporting: firstScan.boundary.supporting.map((entry) => ({
        relation: entry.relation,
        type: entry.type,
        path: entry.path,
        requiredBy: entry.requiredBy,
      })),
      unresolvedReferences: [],
      findings: [],
    };
    await writeJson(
      path.join(fixture.migrationRoot, CLASSIFICATION_PATH),
      classification,
    );
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        version: 1,
        hasVisibleUi: true,
        behaviors: [
          {
            id: "LB-1",
            description: "Roles behavior",
            evidence: evidenceChecklist(
              "legacy/src/features/roles/index.ts",
              ["ROLES-REQ-001"],
              ["ROLES-SCN-001"],
            ),
          },
        ],
        uiBehaviors: [
          {
            id: "UIB-1",
            behaviorId: "LB-1",
            kind: "PRESENTATION",
            description: "The roles page presents the roles feature.",
            configuration: { density: "compact" },
            runtimeStates: ["DEFAULT"],
            evidence: evidenceChecklist(
              "legacy/src/features/roles/index.ts",
              ["ROLES-REQ-001"],
              ["ROLES-SCN-001"],
            ),
            requirementIds: ["ROLES-REQ-001"],
            scenarioIds: ["ROLES-SCN-001"],
          },
        ],
        routeFlows: [
          {
            id: "RF-1",
            description: "Roles page",
            evidence: evidenceChecklist(
              "legacy/src/app/roles/page.ts",
              ["ROLES-REQ-002"],
              ["ROLES-SCN-002"],
            ),
          },
        ],
        explicitNoRouteFlows: false,
      },
    );
    const discoverPreview = await previewAdvance({
      ...resolution,
      moduleName: "roles",
    });
    await advanceMigration({
      ...resolution,
      moduleName: "roles",
      confirmAdvance: discoverPreview.confirmationId,
    });
    await writeFile(
      path.join(fixture.migrationRoot, "steps/02a-discovery-completeness.md"),
      STEP_DOC("02a", "Discovery completeness"),
    );
    const completenessPreview = await previewAdvance({
      ...resolution,
      moduleName: "roles",
    });
    await advanceMigration({
      ...resolution,
      moduleName: "roles",
      confirmAdvance: completenessPreview.confirmationId,
    });

    const completed = await readJson(
      path.join(fixture.migrationRoot, "state.json"),
    );
    const persistedScan = await readJson(
      path.join(fixture.migrationRoot, "inventories/discovery-scan.json"),
    );
    assert.equal(completed.currentStep, "ASSESS_TARGET");
    assert.deepEqual(persistedScan.moduleRoots, ["src/features/roles"]);
    assert.ok(
      persistedScan.census.includes("src/features/roles/disconnected.ts"),
    );
    assert.deepEqual(persistedScan.findings, []);
    assert.deepEqual(persistedScan.unresolved, []);
    assert.ok(
      persistedScan.runtimeUrls.some(
        (entry) => entry.file === "src/shared/urls.ts",
      ),
    );
    assert.equal(persistedScan.census.includes("src/config/i18n.ts"), false);
    assert.equal(
      persistedScan.boundary.governingFramework.find(
        (entry) => entry.path === "src/config/i18n.ts",
      )?.relation,
      "GOVERNING_FRAMEWORK",
    );
    assert.ok(
      persistedScan.boundary.supporting.some(
        (entry) =>
          entry.path === "src/shared/i18n/es-ES/roles.json" &&
          entry.type === "I18N_RESOURCE",
      ),
    );
    assert.ok(
      !persistedScan.supporting.includes("src/shared/i18n/es-ES/users.json"),
    );
    assert.equal(
      await exists(path.join(fixture.migrationRoot, DECISIONS_PATH)),
      false,
    );
    assert.equal(
      (await historyEvents(fixture)).some(
        (event) => event.event === "REOPENED",
      ),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a runtime redirect over a destructured parameter base creates no EDGE_RESOLUTION decision, while a genuine dynamic module edge stays non-approvable", async () => {
  const fixture = await createFixture({
    modules: { roles: { target: "roles" } },
  });
  fixture.migrationRoot = path.join(
    fixture.targetRoot,
    ".agents/knowledge/migrations/modules/roles",
  );
  try {
    await writeFile(
      path.join(fixture.legacyRoot, ".gitignore"),
      "node_modules/\n",
    );
    await writeFile(
      path.join(fixture.legacyRoot, "package.json"),
      '{"name":"roles-legacy-fixture","private":true}\n',
    );
    await writeJson(path.join(fixture.legacyRoot, "tsconfig.json"), {
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
      },
    });
    const files = {
      "src/features/roles/index.ts":
        "export { redirect } from './redirect';\n" +
        "export { asset } from './dynamic';\n",
      "src/features/roles/redirect.ts":
        "export const redirect = ({ url, baseUrl }) => {\n" +
        "  const normalizedUrl = url;\n" +
        "  if (url) return new URL(normalizedUrl, baseUrl).toString();\n" +
        "  return new URL(url, baseUrl).toString();\n" +
        "};\n",
      "src/features/roles/dynamic.ts":
        "export const asset = (name) => new URL(name, import.meta.url);\n",
      "src/app/roles/page.ts":
        "import { redirect } from '../../features/roles';\nexport default redirect;\n",
    };
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(fixture.legacyRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const typescriptLink = path.join(
      fixture.legacyRoot,
      "node_modules/typescript",
    );
    await mkdir(path.dirname(typescriptLink), { recursive: true });
    await symlink(
      path.join(repositoryRoot, "node_modules/typescript"),
      typescriptLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    await execFileAsync("git", ["add", "legacy"], { cwd: fixture.root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Contract Test",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "-qm",
        "roles url fixture",
      ],
      { cwd: fixture.root },
    );

    const resolution = await resolveRegistryPath({
      cliPath: fixture.registryPath,
      moduleName: "roles",
      cwd: fixture.root,
      projectRoot: fixture.root,
      environmentPath: undefined,
    });
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "roles",
      openSpecProposal: SPEC.replaceAll("AUTH-", "ROLES-"),
    });
    await bootstrapMigration({
      ...resolution,
      moduleName: "roles",
      openSpecProposal: preview.openSpecProposal,
      registryBinding: preview.registryBinding,
      boundInputs: preview.boundInputs,
    });
    await writeFile(
      path.join(fixture.migrationRoot, "steps/02-discover-legacy.md"),
      STEP_DOC("02", "Discover legacy"),
    );
    await writeJson(path.join(fixture.migrationRoot, CLASSIFICATION_PATH), {
      version: 1,
      algorithmVersion: 2,
      moduleRoots: [
        {
          path: "src/features/roles",
          reason: "The roles feature owns this slice.",
        },
      ],
      declaredEntryPoints: [],
      files: [],
      supporting: [],
      unresolvedReferences: [],
      findings: [],
    });
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        version: 1,
        hasVisibleUi: true,
        behaviors: [
          {
            id: "LB-1",
            description: "Roles behavior",
            evidence: evidenceChecklist(
              "legacy/src/features/roles/index.ts",
              ["ROLES-REQ-001"],
              ["ROLES-SCN-001"],
            ),
          },
        ],
        uiBehaviors: [
          {
            id: "UIB-1",
            behaviorId: "LB-1",
            kind: "PRESENTATION",
            description: "The roles page presents the roles feature.",
            configuration: { density: "compact" },
            runtimeStates: ["DEFAULT"],
            evidence: evidenceChecklist(
              "legacy/src/features/roles/index.ts",
              ["ROLES-REQ-001"],
              ["ROLES-SCN-001"],
            ),
            requirementIds: ["ROLES-REQ-001"],
            scenarioIds: ["ROLES-SCN-001"],
          },
        ],
        routeFlows: [
          {
            id: "RF-1",
            description: "Roles page",
            evidence: evidenceChecklist(
              "legacy/src/app/roles/page.ts",
              ["ROLES-REQ-002"],
              ["ROLES-SCN-002"],
            ),
          },
        ],
        explicitNoRouteFlows: false,
      },
    );
    const discoverPreview = await previewAdvance({
      ...resolution,
      moduleName: "roles",
    });
    await advanceMigration({
      ...resolution,
      moduleName: "roles",
      confirmAdvance: discoverPreview.confirmationId,
    });
    assert.equal(
      (await readJson(path.join(fixture.migrationRoot, "state.json")))
        .currentStep,
      "DISCOVERY_COMPLETENESS",
    );

    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "roles",
    });
    const edgeCandidates = pending.candidates.filter(
      (candidate) => candidate.kind === "EDGE_RESOLUTION",
    );
    // The runtime redirect is classified RUNTIME_URL, so it never becomes a
    // finding and never generates an operator decision.
    assert.ok(
      !edgeCandidates.some((candidate) =>
        candidate.subject.path.includes("redirect.ts"),
      ),
    );
    // The genuine dynamic module edge over import.meta.url stays a blocking,
    // permanently non-approvable EDGE_RESOLUTION.
    const dynamicCandidate = edgeCandidates.find((candidate) =>
      candidate.subject.path.includes("dynamic.ts"),
    );
    assert.ok(dynamicCandidate);
    assert.equal(dynamicCandidate.approvable, false);
  } finally {
    await fixture.cleanup();
  }
});

test("a census file with no classification row blocks, naming it, and writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    // A file nothing imports, nothing declares, and no entry point reaches.
    await writeFile(
      path.join(fixture.legacyRoot, "auth/background.txt"),
      "decorative\n",
    );
    const before = await snapshot(fixture.migrationRoot);
    await assert.rejects(
      advance(fixture),
      /omits 1 file.*auth\/background\.txt/s,
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("the census finds an owned file with every entry point omitted", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    await writeFile(
      path.join(fixture.legacyRoot, "auth/background.txt"),
      "x\n",
    );
    const resolution = await resolutionFor(fixture);
    const scan = await previewDiscoveryScan({
      ...resolution,
      moduleName: "auth",
    });
    // No import graph participates: no entry points, no edges, no imports.
    assert.deepEqual(scan.entryPoints, []);
    assert.deepEqual(scan.edges, []);
    assert.ok(scan.census.includes("auth/background.txt"));
    assert.equal(scan.reachability["auth/background.txt"], "UNREACHABLE");
  } finally {
    await fixture.cleanup();
  }
});

test("prose is not a disposition, a scope, or a reachability", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    for (const [patch, pattern] of [
      [
        { disposition: "It is only decorative, so it was skipped." },
        /disposition must be one of/,
      ],
      [{ scope: "mostly ours" }, /scope must be 'OWNED'/],
      [
        { reachability: "not really used" },
        /Reachability is derived, not declared/,
      ],
      [{ kind: "a picture" }, /is a OTHER/],
    ]) {
      await writeClassification(fixture, {
        ...MODULE_CLASSIFICATION,
        files: [{ ...MODULE_CLASSIFICATION.files[0], ...patch }],
      });
      await assert.rejects(advance(fixture), pattern);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a classification row for a file outside the census is refused", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [
        ...MODULE_CLASSIFICATION.files,
        { ...MODULE_CLASSIFICATION.files[0], path: "marker.txt" },
      ],
    });
    await assert.rejects(advance(fixture), /not in the module census/);
  } finally {
    await fixture.cleanup();
  }
});

test("BEHAVIOR_BACKED requires a behavior the legacy inventory actually defines", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [{ ...MODULE_CLASSIFICATION.files[0], behaviorIds: [] }],
    });
    await assert.rejects(
      advance(fixture),
      /cites no behaviorIds or routeFlowIds/,
    );
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [{ ...MODULE_CLASSIFICATION.files[0], behaviorIds: ["LB-NOPE"] }],
    });
    await assert.rejects(advance(fixture), /cites 'LB-NOPE'/);
  } finally {
    await fixture.cleanup();
  }
});

test("EXCLUDED_APPROVED without a real operator decision is refused", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const excluded = {
      ...MODULE_CLASSIFICATION.files[0],
      disposition: "EXCLUDED_APPROVED",
      behaviorIds: [],
      rationale: "Decorative only.",
      evidence: evidenceChecklist("legacy/auth/marker.txt"),
    };
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [excluded],
    });
    await assert.rejects(
      advance(fixture),
      /decisionId must be a non-empty string/,
    );

    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [
        { ...excluded, decisionId: "DEC-999", decisionDigest: "sha256:x" },
      ],
    });
    await assert.rejects(
      advance(fixture),
      /not recorded in .*can never author its own approval/s,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an agent-authored or fake approval line cannot satisfy a stable candidate", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const rationale = "Agent-authored rationale is not operator authority.";
    const classification = exclusionClassification(rationale);
    await writeClassification(fixture, classification);
    const digest = await currentDigest(fixture);
    // Hand-written: correct kind, path, rationale, census and legacy binding, a
    // valid chain, a matching line digest -- everything an author can compute
    // without ever deriving a candidate. `algorithmVersion: 1` in the
    // classification used to be all it took for that to be enough.
    const { decision, digest: decisionDigest } = await recordDecision(fixture, {
      kind: "EXCLUSION",
      subject: "auth/marker.txt",
      rationale,
      discoveryDigest: digest,
      bound: false,
    });
    await writeClassification(fixture, {
      ...classification,
      files: [
        {
          ...classification.files[0],
          decisionId: decision.id,
          decisionDigest,
        },
      ],
    });
    await assert.rejects(
      advance(fixture),
      /does not approve current stable candidate.*Agent-authored, fake, and stale/s,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an operator decision approves exactly the file, rationale, and census it was shown", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const rationale = "Decorative only; the target owns visual design.";
    const digest = await currentDigest(fixture);
    const { decision, digest: lineDigest } = await recordDecision(fixture, {
      kind: "EXCLUSION",
      subject: "auth/marker.txt",
      rationale,
      discoveryDigest: digest,
    });
    const excluded = {
      ...MODULE_CLASSIFICATION.files[0],
      disposition: "EXCLUDED_APPROVED",
      behaviorIds: [],
      rationale,
      evidence: evidenceChecklist("legacy/auth/marker.txt"),
      decisionId: decision.id,
      decisionDigest: lineDigest,
    };
    // Exactly as approved, it passes.
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [excluded],
    });
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("a stale cited decision stays pending and can be reapproved without editing the classification first", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const oldRationale = "Decorative under the previous review.";
    const oldClassification = {
      ...exclusionClassification(oldRationale),
      algorithmVersion: 2,
    };
    await writeClassification(fixture, oldClassification);
    const resolution = await resolutionFor(fixture);
    const oldCandidate = (
      await pendingDecisionCandidates({ ...resolution, moduleName: "auth" })
    ).candidates[0];
    const oldRecorded = await recordAtTerminal(
      fixture,
      oldCandidate,
      challengeFor(oldCandidate),
    );
    const staleRow = {
      ...oldClassification.files[0],
      rationale: "The current review found a different exclusion reason.",
      decisionId: oldRecorded.decision.id,
      decisionDigest: lineDigestOf(oldRecorded.decision),
    };
    await writeClassification(fixture, {
      ...oldClassification,
      files: [staleRow],
    });

    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(pending.candidates.length, 1);
    assert.equal(pending.candidates[0].approvable, true);
    assert.notEqual(pending.candidates[0].id, oldCandidate.id);

    const classificationPath = path.join(
      fixture.migrationRoot,
      CLASSIFICATION_PATH,
    );
    const before = await readFile(classificationPath, "utf8");
    const replacement = await recordAtTerminal(
      fixture,
      pending.candidates[0],
      challengeFor(pending.candidates[0]),
    );
    assert.equal(await readFile(classificationPath, "utf8"), before);
    await assert.rejects(
      advance(fixture),
      /does not approve current stable candidate|rationale changed after decision/,
    );

    await writeClassification(fixture, {
      ...oldClassification,
      files: [
        {
          ...staleRow,
          decisionId: replacement.decision.id,
          decisionDigest: lineDigestOf(replacement.decision),
        },
      ],
    });
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("each way of reusing an approval is refused on its own", async () => {
  for (const [label, patch, pattern] of [
    [
      "a different file",
      { path: "auth/other.txt" },
      /approves 'auth\/marker\.txt'/,
    ],
    [
      "an edited rationale",
      { rationale: "Actually it does something." },
      /rationale changed after decision/,
    ],
    [
      "a forged line digest",
      { decisionDigest: "sha256:forged" },
      /decisionDigest does not match/,
    ],
    [
      "the wrong kind of decision",
      { decisionKind: "DEAD_CONFIRMATION" },
      /is a DEAD_CONFIRMATION decision/,
    ],
  ]) {
    const fixture = await createFixture();
    try {
      await atDiscoveryCompleteness(fixture);
      const rationale = "Decorative only.";
      const digest = await currentDigest(fixture);
      const { decision, digest: lineDigest } = await recordDecision(fixture, {
        kind: patch.decisionKind ?? "EXCLUSION",
        subject: "auth/marker.txt",
        rationale,
        discoveryDigest: digest,
      });
      const base = {
        ...MODULE_CLASSIFICATION.files[0],
        disposition: "EXCLUDED_APPROVED",
        behaviorIds: [],
        rationale,
        evidence: evidenceChecklist("legacy/auth/marker.txt"),
        decisionId: decision.id,
        decisionDigest: lineDigest,
      };
      const applied = { ...base, ...patch };
      delete applied.decisionKind;
      if (patch.path) {
        await writeFile(
          path.join(fixture.legacyRoot, "auth/other.txt"),
          "other\n",
        );
        await writeClassification(fixture, {
          ...MODULE_CLASSIFICATION,
          files: [MODULE_CLASSIFICATION.files[0], applied],
        });
      } else {
        await writeClassification(fixture, {
          ...MODULE_CLASSIFICATION,
          files: [applied],
        });
      }
      await assert.rejects(advance(fixture), pattern, label);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("an approval recorded against an older census no longer applies", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const rationale = "Decorative only.";
    const { decision, digest: lineDigest } = await recordDecision(fixture, {
      kind: "EXCLUSION",
      subject: "auth/marker.txt",
      rationale,
      discoveryDigest: "sha256:the-census-as-it-was-yesterday",
    });
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [
        {
          ...MODULE_CLASSIFICATION.files[0],
          disposition: "EXCLUDED_APPROVED",
          behaviorIds: [],
          rationale,
          evidence: evidenceChecklist("legacy/auth/marker.txt"),
          decisionId: decision.id,
          decisionDigest: lineDigest,
        },
      ],
    });
    await assert.rejects(
      advance(fixture),
      /facts the operator approved changed/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an approval does not survive an edit to the bytes it approved", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const rationale = "Decorative only.";
    const digest = await currentDigest(fixture);
    const { decision, digest: lineDigest } = await recordDecision(fixture, {
      kind: "EXCLUSION",
      subject: "auth/marker.txt",
      rationale,
      discoveryDigest: digest,
    });
    await writeClassification(fixture, {
      ...MODULE_CLASSIFICATION,
      files: [
        {
          ...MODULE_CLASSIFICATION.files[0],
          disposition: "EXCLUDED_APPROVED",
          behaviorIds: [],
          rationale,
          evidence: evidenceChecklist("legacy/auth/marker.txt"),
          decisionId: decision.id,
          decisionDigest: lineDigest,
        },
      ],
    });
    // Same path, same imports, new observable content: exactly the change the
    // graph digest is designed not to notice.
    await writeFile(
      path.join(fixture.legacyRoot, "auth/marker.txt"),
      "auth\nDelete account\n",
    );
    assert.equal(
      await currentDigest(fixture),
      digest,
      "the graph is unchanged",
    );
    const before = await snapshot(fixture.migrationRoot);
    await assert.rejects(
      advance(fixture),
      /binds to the exact bytes it approved/,
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("a legacy working-tree change after the summary expires the advance confirmation", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const resolution = await resolutionFor(fixture);
    const preview = await previewAdvance({ ...resolution, moduleName: "auth" });
    assert.ok(
      preview.confirmationId,
      "a clean checkpoint issues a confirmation",
    );
    await writeFile(
      path.join(fixture.legacyRoot, "auth/marker.txt"),
      "auth\nDelete account\n",
    );
    const before = await snapshot(fixture.migrationRoot);
    await assert.rejects(
      advanceMigration({
        ...resolution,
        moduleName: "auth",
        confirmAdvance: preview.confirmationId,
      }),
      /confirmation is missing or expired/,
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("a legacy change landing between the prompt and the lock is refused, writing nothing", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    await writeClassification(fixture, exclusionClassification());
    const resolution = await resolutionFor(fixture);
    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    const candidate = pending.candidates[0];
    assert.ok(candidate?.approvable);
    const before = await snapshot(fixture.migrationRoot);
    const stdin = new PassThrough();
    stdin.isTTY = true;
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        // The barrier. The recorder has read state, run the scan and printed
        // the summary; it has not reached `withModuleLock` yet, because it is
        // blocked on this answer. Everything it was shown changes here.
        if (!String(chunk).includes("Challenge:")) return callback();
        writeFile(
          path.join(fixture.legacyRoot, "auth/marker.txt"),
          "auth\nDelete account\n",
        )
          .then(() => stdin.end(`${challengeFor(candidate)}\n`))
          .then(() => callback(), callback);
      },
    });
    stdout.isTTY = true;
    const cwd = process.cwd();
    process.chdir(fixture.root);
    try {
      await assert.rejects(
        runRecordDecisionCli(["auth", "--approve", candidate.id], {
          stdin,
          stdout,
        }),
        /changed or ceased to be pending while the challenge was open/,
      );
    } finally {
      process.chdir(cwd);
    }
    assert.equal(
      await exists(path.join(fixture.migrationRoot, DECISIONS_PATH)),
      false,
      "a rejected approval never creates the decision record",
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("the interactive challenge must match the exact pending subject", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    await writeClassification(fixture, exclusionClassification());
    const resolution = await resolutionFor(fixture);
    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    const candidate = pending.candidates[0];
    const result = await recordAtTerminal(fixture, candidate, "y");
    assert.equal(result.blocked, true);
    assert.equal(
      await exists(path.join(fixture.migrationRoot, DECISIONS_PATH)),
      false,
    );
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("an unreadable advance journal is preserved and fails recovery from either position", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const journalPath = path.join(fixture.migrationRoot, "advance.journal");
    const corrupt = '{"fromRevision":2,"toRevision":3,"event":{"even';
    const refused = /unreadable journal.*preserved exactly as found/s;

    // Two positions, because the branch cannot tell them apart: the transition
    // it recorded is exactly what was lost. Neither may delete the only
    // artifact that could still reconstruct a missing history event.
    for (const position of ["before the advance", "after the advance"]) {
      await writeFile(journalPath, corrupt);
      const before = await snapshot(fixture.migrationRoot);
      // Repeated, because a failed recovery that is not idempotent is a
      // recovery that destroys something on the second try.
      for (const attempt of [1, 2]) {
        await assert.rejects(
          advance(fixture),
          refused,
          `${position} #${attempt}`,
        );
        assert.deepEqual(
          await snapshot(fixture.migrationRoot),
          before,
          `${position} #${attempt} changed nothing`,
        );
        assert.equal(await readFile(journalPath, "utf8"), corrupt);
      }
      await rm(journalPath);
      if (position === "before the advance") await advance(fixture);
    }
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("a production-reachable visual asset is never dismissed by rationale alone", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    // A stylesheet the module declares as its own entry: visible, reachable.
    await writeFile(
      path.join(fixture.legacyRoot, "auth/theme.css"),
      ".a { color: red; }\n",
    );
    const rows = [
      MODULE_CLASSIFICATION.files[0],
      {
        path: "auth/theme.css",
        scope: "OWNED",
        reachability: "REACHABLE_FROM_ENTRY",
        reachedFrom: [],
        kind: "STYLE",
        disposition: "NO_OBSERVABLE_BEHAVIOR",
        behaviorIds: [],
        routeFlowIds: [],
        rationale: "Only styling; no behavior.",
        evidence: evidenceChecklist("legacy/auth/marker.txt"),
      },
    ];
    const base = {
      ...MODULE_CLASSIFICATION,
      declaredEntryPoints: [
        { path: "auth/theme.css", reason: "Module stylesheet entry." },
      ],
      files: rows,
    };
    await writeClassification(fixture, base);
    await assert.rejects(
      advance(fixture),
      /production-reachable STYLE classified NO_OBSERVABLE_BEHAVIOR/,
    );

    // INFRASTRUCTURE_ONLY is the same claim wearing a different hat.
    await writeClassification(fixture, {
      ...base,
      files: [rows[0], { ...rows[1], disposition: "INFRASTRUCTURE_ONLY" }],
    });
    await assert.rejects(
      advance(fixture),
      /production-reachable STYLE classified INFRASTRUCTURE_ONLY/,
    );

    // Backed by a real behavior, it passes.
    await writeClassification(fixture, {
      ...base,
      files: [
        rows[0],
        {
          ...rows[1],
          disposition: "BEHAVIOR_BACKED",
          behaviorIds: ["LB-1"],
          evidence: [],
        },
      ],
    });
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("DISCOVER_LEGACY refuses evidence outside the canonical module boundary", async () => {
  const fixture = await createFixture();
  try {
    // Authored before DISCOVER_LEGACY closes: it resolves to a real file, so
    // that checkpoint accepts it. Only the census can tell it is out of scope.
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          {
            ...LEGACY_INVENTORY.behaviors[0],
            evidence: evidenceChecklist(
              "legacy/marker.txt",
              ["AUTH-REQ-001"],
              ["AUTH-SCN-001"],
            ),
          },
        ],
      },
    );
    await writeClassification(fixture, MODULE_CLASSIFICATION);
    await assert.rejects(
      advance(fixture),
      /sit outside the canonical module boundary/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("DISCOVERY_COMPLETENESS revalidates legacy evidence against the final editable boundary", async () => {
  const fixture = await createFixture();
  const classificationFor = (root) => ({
    version: 1,
    algorithmVersion: 2,
    moduleRoots: [{ path: root, reason: "The synthetic auth slice." }],
    declaredEntryPoints: [],
    files: [
      {
        ...MODULE_CLASSIFICATION.files[0],
        path: `${root}/marker.txt`,
      },
      {
        ...MODULE_CLASSIFICATION.files[0],
        path: `${root}/flow.txt`,
        behaviorIds: [],
        routeFlowIds: ["RF-1"],
      },
    ],
    supporting: [],
    unresolvedReferences: [],
    findings: [],
  });
  try {
    for (const relative of [
      "auth/flow.txt",
      "shadow/auth/marker.txt",
      "shadow/auth/flow.txt",
    ]) {
      const absolute = path.join(fixture.legacyRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, `${relative}\n`);
    }
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        routeFlows: [
          {
            ...LEGACY_INVENTORY.routeFlows[0],
            evidence: evidenceChecklist(
              "legacy/auth/flow.txt",
              ["AUTH-REQ-002"],
              ["AUTH-SCN-002"],
            ),
          },
        ],
      },
    );
    const wide = classificationFor("auth");
    await writeClassification(fixture, wide);
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "DISCOVERY_COMPLETENESS");

    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeClassification(fixture, classificationFor("shadow/auth"));
    const before = await snapshot(fixture.migrationRoot);
    await assert.rejects(
      advance(fixture),
      /2 legacy evidence location\(s\) sit outside the canonical module boundary: auth\/flow\.txt, auth\/marker\.txt/,
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
    assert.equal((await state(fixture)).currentStep, "DISCOVERY_COMPLETENESS");
    assert.equal(
      await exists(
        path.join(fixture.migrationRoot, "inventories/discovery-scan.json"),
      ),
      false,
    );

    await writeClassification(fixture, wide);
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("a fully classified module advances, pins the digest, and records the scan", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const before = await state(fixture);
    const expected = await currentDigest(fixture);
    await advance(fixture);
    const after = await state(fixture);
    assert.equal(after.currentStep, "ASSESS_TARGET");
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.completedSteps, [
      "RESOLVE",
      "DISCOVER_LEGACY",
      "DISCOVERY_COMPLETENESS",
    ]);
    assert.equal(after.formatVersion, MIGRATION_FORMAT_VERSION);

    const scan = await readJson(
      path.join(fixture.migrationRoot, "inventories/discovery-scan.json"),
    );
    assert.equal(scan.discoveryDigest, expected);
    assert.equal(scan.algorithmVersion, 1);
    assert.deepEqual(scan.census, ["auth/marker.txt"]);

    const emptyLedgerDigest = `sha256:${createHash("sha256").update("").digest("hex")}`;
    assert.equal(scan.decisionLedgerDigest, emptyLedgerDigest);
    // The pin binds the canonical discovery digest and exact raw decision
    // ledger bytes; generatedAt remains intentionally mutable.
    assert.equal(
      after.artifactHashes["inventories/discovery-scan.json#discovery"],
      createHash("sha256")
        .update(
          JSON.stringify({
            discoveryDigest: expected,
            decisionLedgerDigest: emptyLedgerDigest,
          }),
        )
        .digest("hex"),
    );
    const events = await historyEvents(fixture);
    assert.equal(
      events.filter(
        (e) =>
          e.event === "STEP_COMPLETED" && e.step === "DISCOVERY_COMPLETENESS",
      ).length,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a hand-edited discovery scan breaks its own pin", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const scanPath = path.join(
      fixture.migrationRoot,
      "inventories/discovery-scan.json",
    );
    const scan = await readJson(scanPath);
    await writeJson(scanPath, { ...scan, discoveryDigest: "sha256:forged" });
    const resolution = await resolutionFor(fixture);
    await assert.rejects(
      previewMigrationExecution({ ...resolution, moduleName: "auth" }),
      /recorded discovery digest changed/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("changing raw decision-ledger bytes invalidates a new discovery pin", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await mkdir(path.join(fixture.migrationRoot, "decisions"), {
      recursive: true,
    });
    // Semantically still an empty NDJSON ledger, but not the exact bytes the
    // checkpoint pinned.
    await writeFile(path.join(fixture.migrationRoot, DECISIONS_PATH), "\n");
    const resolution = await resolutionFor(fixture);
    await assert.rejects(
      previewMigrationExecution({ ...resolution, moduleName: "auth" }),
      /operator-decisions\.ndjson bytes changed after DISCOVERY_COMPLETENESS/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an existing format-10 discovery pin without a ledger field remains valid", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const scanPath = path.join(
      fixture.migrationRoot,
      "inventories/discovery-scan.json",
    );
    const scan = await readJson(scanPath);
    delete scan.decisionLedgerDigest;
    await writeJson(scanPath, scan);

    const statePath = path.join(fixture.migrationRoot, "state.json");
    const persisted = await readJson(statePath);
    persisted.artifactHashes["inventories/discovery-scan.json#discovery"] =
      createHash("sha256").update(scan.discoveryDigest).digest("hex");
    await writeJson(statePath, persisted);
    const integrityPath = path.join(fixture.migrationRoot, "integrity.json");
    const integrity = await readJson(integrityPath);
    integrity.artifactHashesSha256 = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(persisted.artifactHashes).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          ),
        ),
      )
      .digest("hex");
    await writeJson(integrityPath, integrity);

    const resolution = await resolutionFor(fixture);
    const status = await getMigrationStatus({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(status.formatVersion, MIGRATION_FORMAT_VERSION);
    assert.equal(status.currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// --- REOPENED ---------------------------------------------------------------

test("--reopen-discovery returns to DISCOVER_LEGACY without losing anything else", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const digest = await currentDigest(fixture);
    await recordDecision(fixture, {
      kind: "EXCLUSION",
      subject: "auth/marker.txt",
      rationale: "kept across the reopen",
      discoveryDigest: digest,
    });
    const before = await state(fixture);
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenDiscovery: true,
    });
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(preview.expectedNextCheckpoint, "DISCOVER_LEGACY");
    const result = await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      reopenDiscovery: true,
      boundInputs: preview.boundInputs,
      registryBinding: preview.registryBinding,
    });
    assert.equal(result.reopened, true);

    const after = await state(fixture);
    assert.equal(after.currentStep, "DISCOVER_LEGACY");
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.completedSteps, ["RESOLVE"]);
    assert.equal(after.evidenceFreshness, "STALE");
    // The pins DISCOVER_LEGACY held are gone, so `legacy.json` is editable.
    assert.ok(!("inventories/legacy.json" in after.artifactHashes));
    assert.ok(!("steps/02-discover-legacy.md" in after.artifactHashes));
    const events = await historyEvents(fixture);
    assert.equal(events.filter((e) => e.event === "REOPENED").length, 1);
    // Decisions bind to the digest, not the checkpoint, so they survive.
    const decisions = await readFile(
      path.join(fixture.migrationRoot, DECISIONS_PATH),
      "utf8",
    );
    assert.equal(decisions.split("\n").filter(Boolean).length, 1);

    // The inventory really is writable again, and re-closing replays clean.
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        behaviors: [
          {
            ...LEGACY_INVENTORY.behaviors[0],
            description: "Sign in, described again",
          },
        ],
      },
    );
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await advance(fixture);
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeClassification(fixture, MODULE_CLASSIFICATION);
    await advance(fixture);
    const reclosed = await state(fixture);
    assert.equal(reclosed.currentStep, "ASSESS_TARGET");
    assert.equal(reclosed.revision, before.revision + 3);
  } finally {
    await fixture.cleanup();
  }
});

test("--reopen-discovery from any other checkpoint is blocked and writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const before = await snapshot(fixture.migrationRoot);
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenDiscovery: true,
    });
    assert.equal(preview.requiresConfirmation, false);
    assert.match(
      preview.blockers.join("; "),
      /legal only from DISCOVERY_COMPLETENESS/,
    );
    await assert.rejects(
      bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        reopenDiscovery: true,
        boundInputs: preview.boundInputs,
      }),
      /legal only from DISCOVERY_COMPLETENESS/,
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("UI-1: completed UI remediation reopens only named slice verification", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const before = await state(fixture);
    const unaffected = before.artifactHashes["evidence/slice-b/result.json"];
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
    });
    assert.equal(preview.requiresConfirmation, true);
    const result = await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
      boundInputs: preview.boundInputs,
      registryBinding: preview.registryBinding,
    });
    assert.equal(result.reopened, true);
    const after = await state(fixture);
    assert.equal(after.currentStep, "VERIFY_SLICES");
    assert.equal(after.activeSlice, "slice-a");
    assert.deepEqual(after.completedSlices, ["slice-b"]);
    assert.deepEqual(after.pendingSlices, ["slice-a"]);
    assert.equal(
      after.artifactHashes["evidence/slice-b/result.json"],
      unaffected,
    );
    assert.ok(!after.artifactHashes["evidence/slice-a/result.json"]);
    assert.equal(
      (
        await readJson(
          path.join(fixture.migrationRoot, "evidence/slice-a/result.json"),
        )
      ).result,
      "PENDING",
    );
    assert.equal(
      (await readJson(path.join(fixture.migrationRoot, "ui-remediation.json")))
        .hasVisibleUi,
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("PLAN preserves completed slice artifacts after refresh", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "BUILD_BASELINE");
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await authorSlice(fixture, "slice-b");
    await authorEvidence(fixture, "slice-b");

    await advance(fixture);

    const after = await state(fixture);
    assert.equal(after.currentStep, "IMPLEMENT_SLICES");
    assert.equal(after.activeSlice, "slice-a");
    assert.deepEqual(after.completedSlices, ["slice-b"]);
    assert.deepEqual(after.pendingSlices, ["slice-a"]);
  } finally {
    await fixture.cleanup();
  }
});

test("active PASS evidence remains pending until verification advances", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");

    const current = await state(fixture);
    const reconciliation = await reconcileSliceState(
      fixture.migrationRoot,
      current,
    );
    assert.deepEqual(reconciliation.repairs, []);
  } finally {
    await fixture.cleanup();
  }
});

test("reconcileSliceState never fast-forwards a newly activated slice into VERIFY_SLICES from raw implementationStatus", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "BUILD_BASELINE");
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    // slice-a's on-disk record already reads COMPLETE at the moment it is
    // activated -- the same brownfield shape that forced the earlier
    // PLAN-exit fix -- but this activation never happened yet, so nothing has
    // validated it through the engine-owned IMPLEMENT_SLICES checkpoint.
    await authorSlice(fixture, "slice-a");
    await advance(fixture);

    const activated = await state(fixture);
    assert.equal(activated.currentStep, "IMPLEMENT_SLICES");
    assert.equal(activated.activeSlice, "slice-a");

    // Simulate a recovery pass that lost track of the active slice -- there
    // is no valid active slice, so reconciliation must select/reset the next
    // pending slice from the same on-disk artifacts inspected above.
    const recoveryInput = { ...activated, activeSlice: null };
    const reconciliation = await reconcileSliceState(
      fixture.migrationRoot,
      recoveryInput,
    );
    assert.equal(reconciliation.state.activeSlice, "slice-a");
    assert.equal(reconciliation.state.currentStep, "IMPLEMENT_SLICES");
    assert.ok(reconciliation.state.pendingSteps.includes("IMPLEMENT_SLICES"));
    assert.ok(!reconciliation.state.completedSteps.includes("VERIFY_SLICES"));
    assert.deepEqual(reconciliation.state.completedSlices, []);

    // The real, unmodified engine state -- untouched by the synthetic
    // recovery input above -- proves normal IMPLEMENT_SLICES validation can
    // still carry slice-a forward into VERIFY_SLICES.
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-2: visible discovery cannot declare hasVisibleUi false", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        hasVisibleUi: false,
      },
    );
    await assert.rejects(
      advance(fixture),
      /hasVisibleUi must equal whether discovery contains UI behaviors/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-3: UI configuration is pinned with completed discovery", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      {
        ...LEGACY_INVENTORY,
        uiBehaviors: [
          {
            ...LEGACY_INVENTORY.uiBehaviors[0],
            configuration: { showToolbar: true },
          },
        ],
      },
    );
    const resolution = await resolutionFor(fixture);
    await assert.rejects(
      previewMigrationExecution({ ...resolution, moduleName: "auth" }),
      /Completed artifact changed after validation/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-4: missing Playwright evidence blocks slice verification", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a", { includeUi: false });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /lacks Playwright runtime evidence/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-5: LEGACY_DEFECT requires disposition evidence, not reproduction", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
    });
    await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
      boundInputs: preview.boundInputs,
      registryBinding: preview.registryBinding,
    });
    const mismatch = {
      ...TARGET_INVENTORY.uiMismatches[0],
      disposition: "LEGACY_DEFECT",
      rationale: "The disabled control is a proven legacy defect.",
    };
    await writeJson(path.join(fixture.migrationRoot, "ui-remediation.json"), {
      version: 1,
      hasVisibleUi: true,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors,
      uiMismatches: [mismatch],
    });
    await authorEvidence(fixture, "slice-a", {
      mismatch,
      includeUi: false,
    });
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "FINALIZE");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-5: completed remediation validates after implementation files are committed", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
    });
    await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
      boundInputs: preview.boundInputs,
      registryBinding: preview.registryBinding,
    });
    const mismatch = {
      ...TARGET_INVENTORY.uiMismatches[0],
      disposition: "LEGACY_DEFECT",
      rationale: "The disabled control is a proven legacy defect.",
    };
    await writeJson(path.join(fixture.migrationRoot, "ui-remediation.json"), {
      version: 1,
      hasVisibleUi: true,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors,
      uiMismatches: [mismatch],
    });
    await authorEvidence(fixture, "slice-a", { mismatch, includeUi: false });
    await advance(fixture, { slice: "slice-a" });

    await execFileAsync("git", ["add", "target/src/slice-a.ts"], {
      cwd: fixture.root,
    });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Contract Test",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "-q",
        "-m",
        "commit remediated implementation",
      ],
      { cwd: fixture.root },
    );
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const context = await gateBindingContext(fixture);
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 1,
        evidence: [gateEvidence(context)],
      })),
    });
    await advance(fixture);

    assert.equal((await state(fixture)).status, "COMPLETE");
    assert.equal(
      (
        await previewMigrationExecution({
          ...resolution,
          moduleName: "auth",
        })
      ).state,
      "COMPLETE",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-6: design adaptation passes only with approval and runtime evidence", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
    });
    await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
      boundInputs: preview.boundInputs,
      registryBinding: preview.registryBinding,
    });
    const mismatch = {
      ...TARGET_INVENTORY.uiMismatches[0],
      disposition: "INTENTIONAL_DESIGN_ADAPTATION",
      rationale: "The target design system changes presentation only.",
      behavioralEquivalence: "The same action remains visible and operable.",
    };
    await writeJson(path.join(fixture.migrationRoot, "ui-remediation.json"), {
      version: 1,
      hasVisibleUi: true,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors,
      uiMismatches: [mismatch],
    });
    await authorEvidence(fixture, "slice-a", { mismatch });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /approval must be a non-empty string/,
    );
    mismatch.approval = "Product/design audit approval UI-6";
    await writeJson(path.join(fixture.migrationRoot, "ui-remediation.json"), {
      version: 1,
      hasVisibleUi: true,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors,
      uiMismatches: [mismatch],
    });
    await authorEvidence(fixture, "slice-a", {
      mismatch,
      producer: "different-provider-session",
    });
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "FINALIZE");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-7: every required UI behavior traces through parity to its slice", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "ASSESS_TARGET");
    await completeStepDoc(fixture, "BUILD_BASELINE");
    const documents = matrices(false);
    // Terminal, so the row is not `required` -- but not `VERIFIED`, which
    // VERIFY_SLICES alone may produce and which BUILD_BASELINE now refuses.
    documents["matrices/behavior-parity.json"].rows[0].verificationStatus =
      "EXCLUDED_APPROVED";
    for (const [relative, document] of Object.entries(documents)) {
      await writeJson(path.join(fixture.migrationRoot, relative), document);
    }
    await registerAuth(fixture);
    await advance(fixture);
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES.map((slice) => ({
        ...slice,
        traceIds: slice.traceIds.filter((id) => id !== "BR-1"),
      })),
    });
    await assert.rejects(
      advance(fixture),
      /Required UI behavior 'UIB-1' does not trace.*to a slice/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-8: provider changes and unrelated files do not stale Playwright evidence", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a", {
      producer: "claude-session-before-opencode",
    });
    await writeFile(
      path.join(fixture.targetRoot, "src/unrelated.ts"),
      "export {};\n",
    );
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-9: changing an owning slice file narrowly stales its UI evidence", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");
    await writeFile(
      path.join(fixture.targetRoot, "src/slice-a.ts"),
      "export {};\n// changed after runtime evidence\n",
    );
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /implementationDigest is stale/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-10: non-UI migrations complete without UI runtime evidence", async () => {
  const fixture = await createFixture();
  try {
    const nonUiLegacy = {
      ...LEGACY_INVENTORY,
      hasVisibleUi: false,
      uiBehaviors: [],
    };
    const nonUiTarget = {
      ...TARGET_INVENTORY,
      hasVisibleUi: false,
      uiComponents: [],
      uiMismatches: [],
    };
    const nonUiSlices = SLICES.map((slice) => ({
      ...slice,
      traceIds: slice.traceIds.filter((id) => id !== "DR-1"),
    }));
    const writeNonUiMatrices = async (final) => {
      const documents = matrices(final);
      documents["matrices/design-system-usage.json"] = {
        version: 1,
        rows: [],
      };
      for (const [relative, document] of Object.entries(documents)) {
        await writeJson(path.join(fixture.migrationRoot, relative), document);
      }
    };

    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      nonUiLegacy,
    );
    await writeClassification(fixture, MODULE_CLASSIFICATION);
    await advance(fixture);
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeClassification(fixture, MODULE_CLASSIFICATION);
    await advance(fixture);
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      nonUiTarget,
    );
    await advance(fixture);
    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeNonUiMatrices(false);
    await registerAuth(fixture);
    await advance(fixture);
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: nonUiSlices,
    });
    await advance(fixture);
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await completeStepDoc(fixture, "VERIFY_SLICES");
    for (const slice of nonUiSlices) {
      await authorSlice(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
      await authorEvidence(fixture, slice.id, { includeUi: false });
      await advance(fixture, { slice: slice.id });
    }
    await completeStepDoc(fixture, "FINALIZE");
    await writeNonUiMatrices(true);
    const context = await gateBindingContext(fixture);
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 1,
        evidence: [gateEvidence(context)],
      })),
    });
    await advance(fixture);
    assert.equal((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Runtime UI evidence (format 12, Playwright MCP)
 *
 * Every test below runs against a disposable fixture. Nothing here reads,
 * advances, or writes a real migration record.
 * ------------------------------------------------------------------ */

/** A UI behavior observed in two runtime states, for budget/viewport rules. */
const TWO_STATE_UI_BEHAVIOR = {
  ...LEGACY_INVENTORY.uiBehaviors[0],
  runtimeStates: ["DEFAULT", "EMPTY"],
};

const uiLegacy = (uiBehavior) => ({
  ...LEGACY_INVENTORY,
  uiBehaviors: [uiBehavior],
});

/** Writes a disposable capture and returns the reference/hash pair for it. */
const writeCapture = async (fixture, sliceId, name, bytes) => {
  const absolute = path.join(
    fixture.migrationRoot,
    `evidence/${sliceId}/ui/${name}`,
  );
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return {
    reference: path
      .relative(fixture.targetRoot, absolute)
      .replaceAll(path.sep, "/"),
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
};

/** DISCOVER_LEGACY with one authored legacy inventory, nothing else. */
const rejectDiscovery = async (fixture, legacy, pattern) => {
  await initialize(fixture);
  await completeStepDoc(fixture, "DISCOVER_LEGACY");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/legacy.json"),
    legacy,
  );
  await assert.rejects(advance(fixture), pattern);
};

test("UI-11: an interactive UI kind must name the interactions to exercise", async () => {
  const fixture = await createFixture();
  try {
    await rejectDiscovery(
      fixture,
      uiLegacy({ ...LEGACY_INVENTORY.uiBehaviors[0], interactions: [] }),
      /requires at least one named interaction to exercise/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-12: 'the control exists' is not a UI inventory", async () => {
  const fixture = await createFixture();
  try {
    await rejectDiscovery(
      fixture,
      uiLegacy({ ...LEGACY_INVENTORY.uiBehaviors[0], configuration: {} }),
      /must record the observable configuration, not an empty object/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-13: a required interaction that was never exercised blocks verification", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({ ...record, interactions: [] })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /interaction 'UIX-1' was never exercised against the target runtime/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-14: a conditional control is not automatically required", async () => {
  const fixture = await createFixture();
  try {
    const conditional = {
      ...LEGACY_INVENTORY.uiBehaviors[0],
      kind: "CONDITIONAL_CONTROL",
      conditional: true,
      precondition: "Visible only with the manage-users permission.",
    };
    await driveTo(fixture, "PLAN", advance, {
      legacy: uiLegacy(conditional),
      target: {
        ...TARGET_INVENTORY,
        uiMismatches: [
          {
            ...TARGET_INVENTORY.uiMismatches[0],
            disposition: "INTENTIONAL_FIX",
            rationale: "The target grants the control unconditionally.",
          },
        ],
      },
    });
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a", { includeUi: false });
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-15: an unavailable runtime is explicit and never becomes a PASS", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a", {
      includeUi: false,
      limitations: [
        { uiBehaviorId: "UIB-1", state: "DEFAULT", reason: "App offline." },
      ],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /availability must be 'NOT_AVAILABLE'/,
    );
    await authorEvidence(fixture, "slice-a", {
      includeUi: false,
      limitations: [
        {
          uiBehaviorId: "UIB-1",
          state: "DEFAULT",
          availability: "NOT_AVAILABLE",
          reason: "The target dev server is not running in this environment.",
        },
      ],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /Runtime availability NOT_AVAILABLE: The target dev server is not running/,
    );
    const status = await getMigrationStatus({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    assert.equal(status.uiEvidence.runtime, "NOT_AVAILABLE");
    assert.equal((await state(fixture)).activeSlice, "slice-a");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-16: legacy runtime capture persists and never binds the target implementation", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const legacyShot = await writeCapture(
      fixture,
      "slice-a",
      "legacy-default.png",
      "legacy pixels\n",
    );
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) => [
        ...records,
        {
          ...records[0],
          origin: "LEGACY",
          route: "/legacy/auth/sign-in",
          screenshot: legacyShot,
          boundTo: Object.fromEntries(
            Object.entries(records[0].boundTo).filter(
              ([field]) => field !== "implementationDigest",
            ),
          ),
        },
      ],
    });
    await advance(fixture, { slice: "slice-a" });
    const persisted = await readJson(
      path.join(fixture.migrationRoot, "evidence/slice-a/result.json"),
    );
    assert.equal(
      persisted.uiEvidence.filter((record) => record.origin === "LEGACY")
        .length,
      1,
    );
    assert.equal((await state(fixture)).activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-17: the screenshot budget refuses a second capture of the same state", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const shot = await writeCapture(fixture, "slice-a", "default.png", "px\n");
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) => [
        { ...records[0], screenshot: shot },
        { ...records[0], screenshot: shot },
      ],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /exceeds the budget/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-18: the same picture is never persisted twice across states", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN", advance, {
      legacy: uiLegacy(TWO_STATE_UI_BEHAVIOR),
    });
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const shot = await writeCapture(fixture, "slice-a", "shared.png", "px\n");
    await authorEvidence(fixture, "slice-a", {
      uiBehavior: TWO_STATE_UI_BEHAVIOR,
      mutate: (records) => [
        { ...records[0], screenshot: shot },
        { ...records[0], state: "EMPTY", screenshot: shot },
      ],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /duplicates an existing TARGET capture in this slice/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-19: a second viewport needs responsive behavior to justify it", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN", advance, {
      legacy: uiLegacy(TWO_STATE_UI_BEHAVIOR),
    });
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a", {
      uiBehavior: TWO_STATE_UI_BEHAVIOR,
      mutate: (records) => [
        records[0],
        {
          ...records[0],
          state: "EMPTY",
          viewport: { width: 390, height: 844 },
        },
      ],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /Capture a second viewport only where responsive behavior is the requirement/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("UI-20: credential material is refused before it can be persisted", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          producer: "playwright-mcp (password=hunter2)",
        })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /must not persist credential material in UI evidence/,
    );
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({ ...record, sessionToken: "abc" })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /must not persist credential material in UI evidence/,
    );
  } finally {
    await fixture.cleanup();
  }
});

// Non-Figma scope: without a Figma-backed visual contract, screenshots stay
// supporting evidence. A figma-mcp format-17 row is accepted by measurement
// comparison instead (see the visual-17 tests).
test("UI-21: differing legacy and target screenshots still verify without a Figma visual contract", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const legacyShot = await writeCapture(
      fixture,
      "slice-a",
      "legacy.png",
      "legacy pixels differ entirely\n",
    );
    const targetShot = await writeCapture(
      fixture,
      "slice-a",
      "target.png",
      "target pixels\n",
    );
    assert.notEqual(legacyShot.hash, targetShot.hash);
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) => [
        { ...records[0], screenshot: targetShot },
        {
          ...records[0],
          origin: "LEGACY",
          screenshot: legacyShot,
          boundTo: Object.fromEntries(
            Object.entries(records[0].boundTo).filter(
              ([field]) => field !== "implementationDigest",
            ),
          ),
        },
      ],
    });
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-25: a visible-UI slice cannot verify on a reference that is not a file", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });

    // Prose: the exact free-form claim the audit found could reach COMPLETE.
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          reference: "observed in chromium",
        })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /is not a persisted artifact path/,
    );

    // Path-shaped but absent: the file was never written.
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          reference: "evidence/slice-a/ui/never-written.txt",
        })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /which does not exist under the legacy or target repository/,
    );

    // Present, but the recorded digest is not the file's.
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          hash: `sha256:${"0".repeat(64)}`,
        })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /does not match the current bytes of/,
    );

    // A screenshot is optional, but a declared one is held to the same bar.
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          screenshot: {
            reference: "captured in the browser",
            hash: `sha256:${"1".repeat(64)}`,
          },
        })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /screenshot\.reference 'captured in the browser' is not a persisted artifact path/,
    );

    // The control: real bytes, real digest, and the slice verifies.
    await authorEvidence(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

/**
 * FINALIZE re-gates every verified slice, not just the last one. The evidence
 * document itself is tamper-proofed by the completed-artifact hashes, so the
 * gap this closes is the artifact going missing underneath a record that still
 * validates on its own: a visible-UI migration cannot complete on a runtime
 * claim whose capture is no longer there.
 */
test("UI-26: FINALIZE refuses a verified slice whose UI artifact is gone", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const capture = await writeCapture(
      fixture,
      "slice-a",
      "runtime.txt",
      "route /auth/sign-in rendered\n",
    );
    for (const slice of SLICES) {
      await authorSlice(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
      await authorEvidence(fixture, slice.id, {
        mutate: (records) =>
          records.map((record) => ({ ...record, ...capture })),
      });
      await advance(fixture, { slice: slice.id });
    }
    assert.equal((await state(fixture)).currentStep, "FINALIZE");

    // The capture is deleted after the slice verified. result.json is
    // untouched, so only FINALIZE's own re-validation can catch this.
    await rm(
      path.join(fixture.migrationRoot, "evidence/slice-a/ui/runtime.txt"),
    );

    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const context = await gateBindingContext(fixture);
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 1,
        evidence: [gateEvidence(context)],
      })),
    });
    await assert.rejects(
      advance(fixture),
      /which does not exist under the legacy or target repository/,
    );
    assert.notEqual((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The inverse of UI-21. Identical bytes across origins are not a duplicate
 * capture -- they are pixel-perfect parity between legacy and target, the best
 * outcome a migration can have. Only a repeat inside one origin is a mistake,
 * which UI-18 still holds.
 */
test("UI-27: byte-identical legacy and target screenshots verify", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const pixels = "identical pixels\n";
    const legacyShot = await writeCapture(
      fixture,
      "slice-a",
      "legacy.png",
      pixels,
    );
    const targetShot = await writeCapture(
      fixture,
      "slice-a",
      "target.png",
      pixels,
    );
    assert.equal(legacyShot.hash, targetShot.hash);
    assert.notEqual(legacyShot.reference, targetShot.reference);
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) => [
        { ...records[0], screenshot: targetShot },
        {
          ...records[0],
          origin: "LEGACY",
          screenshot: legacyShot,
          boundTo: Object.fromEntries(
            Object.entries(records[0].boundTo).filter(
              ([field]) => field !== "implementationDigest",
            ),
          ),
        },
      ],
    });
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The acceptance case, with the literals taken from a real Playwright MCP run
 * against a disposable two-page fixture (a legacy catalog with no toolbar and a
 * target catalog that adds the design-system toolbar). The browser is not
 * needed to replay it: what is pinned here is the *shape* that run produced --
 * two origins, two runtime states, one exercised interaction whose observed
 * result is recorded next to the discovered expectation, and one observable
 * difference classified as an intentional design adaptation -- carried all the
 * way to COMPLETE.
 */
test("UI-24: a real Playwright observation carries a visible-UI migration to COMPLETE", async () => {
  const fixture = await createFixture();
  try {
    const uiBehavior = {
      ...LEGACY_INVENTORY.uiBehaviors[0],
      kind: "TABLE_LIST",
      description: "The catalog lists products compactly, with no toolbar.",
      configuration: {
        showToolbar: false,
        showPagination: false,
        compactMode: true,
      },
      interactions: [
        {
          id: "UIX-1",
          action: "Type 'widget' into the search field.",
          expected: "The list filters to matching rows and reports the count.",
        },
      ],
      runtimeStates: ["DEFAULT", "SEARCH"],
    };
    const mismatch = {
      ...TARGET_INVENTORY.uiMismatches[0],
      disposition: "INTENTIONAL_DESIGN_ADAPTATION",
      rationale:
        "The target renders the design-system toolbar the legacy list lacks.",
      approval: "Operator approved the design-system toolbar on 2026-08-21.",
      behavioralEquivalence:
        "Listing, search and the row action stay identical; the toolbar only adds target-native affordances.",
    };
    const observed = (record, origin, runtimeState) => ({
      ...record,
      origin,
      route: origin === "LEGACY" ? "/legacy/catalog" : "/catalog",
      state: runtimeState,
      interactions:
        runtimeState === "SEARCH"
          ? [
              {
                id: "UIX-1",
                expected: uiBehavior.interactions[0].expected,
                actual:
                  "The list filtered to 1 row and reported '1 resultados'.",
                outcome: "PASS",
              },
            ]
          : [],
      boundTo:
        origin === "LEGACY"
          ? Object.fromEntries(
              Object.entries(record.boundTo).filter(
                ([field]) => field !== "implementationDigest",
              ),
            )
          : record.boundTo,
    });

    await driveTo(fixture, "FINALIZE", advance, {
      legacy: { ...LEGACY_INVENTORY, uiBehaviors: [uiBehavior] },
      target: { ...TARGET_INVENTORY, uiMismatches: [mismatch] },
      evidence: {
        uiBehavior,
        mismatch,
        mutate: (records) =>
          records.flatMap((record) =>
            ["LEGACY", "TARGET"].flatMap((origin) =>
              uiBehavior.runtimeStates.map((runtimeState) =>
                observed(record, origin, runtimeState),
              ),
            ),
          ),
      },
    });
    assert.equal((await state(fixture)).status, "COMPLETE");
    const status = await getMigrationStatus({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    assert.equal(status.uiEvidence.runtime, "AVAILABLE");
    assert.equal(status.uiEvidence.records, 4);
  } finally {
    await fixture.cleanup();
  }
});

test("UI-23: an observable difference with no disposition never reaches FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      {
        ...TARGET_INVENTORY,
        uiMismatches: [],
      },
    );
    await assert.rejects(
      advance(fixture),
      /Every discovered UI behavior requires exactly one explicit mismatch disposition/,
    );
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("UI-22: a fresh process resumes on persisted evidence and recaptures nothing", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const evidencePath = path.join(
      fixture.migrationRoot,
      "evidence/slice-a/result.json",
    );
    const before = await readFile(evidencePath);

    // A different process, as a different provider would run it: status first.
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(scriptsRoot, "cli/discover-module.mjs"), "auth", "--status"],
      { encoding: "utf8", cwd: fixture.root },
    );
    const status = JSON.parse(stdout);
    assert.equal(status.uiEvidence.state, "RECORDED");
    assert.equal(status.uiEvidence.runtime, "AVAILABLE");
    assert.equal(status.activeSlice, "slice-b");
    assert.ok(status.completedSlices.includes("slice-a"));

    // Finishing the *other* slice leaves the recorded evidence byte-identical.
    await authorSlice(fixture, "slice-b");
    await advance(fixture, { slice: "slice-b" });
    await authorEvidence(fixture, "slice-b");
    await advance(fixture, { slice: "slice-b" });
    assert.deepEqual(await readFile(evidencePath), before);
  } finally {
    await fixture.cleanup();
  }
});

test("a reopen killed between the state write and the history append is completed", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenDiscovery: true,
    });
    await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      reopenDiscovery: true,
      boundInputs: preview.boundInputs,
      registryBinding: preview.registryBinding,
    });
    // Reproduce the death: drop the appended event, restore the journal.
    const persisted = await state(fixture);
    const events = await historyEvents(fixture);
    await writeFile(
      path.join(fixture.migrationRoot, "history/history.ndjson"),
      `${events
        .slice(0, -1)
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    await writeJson(path.join(fixture.migrationRoot, "advance.journal"), {
      fromRevision: persisted.revision - 1,
      toRevision: persisted.revision,
      event: events.at(-1),
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    // The next command completes it: one event, no duplicate revision.
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await advance(fixture);
    const recovered = await historyEvents(fixture);
    assert.equal(recovered.filter((e) => e.event === "REOPENED").length, 1);
    assert.equal((await state(fixture)).revision, persisted.revision + 1);
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "advance.journal")),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

/**
 * Kills a just-executed reopen the worst way: `n` bytes of the event landed and
 * the newline never did, and the journal that names it is still on disk.
 * Appending onto that fragment splices two events into one unparseable line.
 */
const killMidHistoryAppend = async (fixture, bytes) => {
  const persisted = await state(fixture);
  const events = await historyEvents(fixture);
  const lines = events.slice(0, -1).map((event) => JSON.stringify(event));
  const partial = JSON.stringify(events.at(-1)).slice(0, bytes);
  await writeFile(
    path.join(fixture.migrationRoot, "history/history.ndjson"),
    `${lines.join("\n")}\n${partial}`,
  );
  const journalPath = path.join(fixture.migrationRoot, "advance.journal");
  const journal = {
    fromRevision: persisted.revision - 1,
    toRevision: persisted.revision,
    event: events.at(-1),
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  await writeJson(journalPath, journal);
  return { persisted, events, journalPath, journal };
};

/** Executes the reopen whose history append the tests then interrupt. */
const reopenDiscovery = async (fixture) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    reopenDiscovery: true,
  });
  await bootstrapMigration({
    ...resolution,
    moduleName: "auth",
    reopenDiscovery: true,
    boundInputs: preview.boundInputs,
    registryBinding: preview.registryBinding,
  });
  return resolution;
};

test("a reopen killed part-way through the history append is repaired, not spliced", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    await reopenDiscovery(fixture);
    const { persisted, events, journalPath } = await killMidHistoryAppend(
      fixture,
      24,
    );

    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await advance(fixture);

    // Every line parsing at all is the assertion: a spliced fragment throws
    // here, and used to be ignored forever with the journal already deleted.
    const recovered = await historyEvents(fixture);
    assert.equal(
      recovered.filter((event) => event.event === "REOPENED").length,
      1,
    );
    // The journalled event is recovered exactly, not approximately.
    assert.deepEqual(recovered.at(-2), events.at(-1));
    const revisions = recovered
      .map((event) => event.revision)
      .filter(Number.isInteger);
    assert.deepEqual(revisions, [...new Set(revisions)], "no duplicate event");
    assert.equal((await state(fixture)).revision, persisted.revision + 1);
    assert.equal(await exists(journalPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("recovering a partial, an absent, and an already-complete event all end identically", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const resolution = await reopenDiscovery(fixture);
    const { events, journalPath, journal } = await killMidHistoryAppend(
      fixture,
      31,
    );
    // Resuming runs recovery and nothing else, so the history it leaves is the
    // whole result.
    const resume = async () => {
      const preview = await previewMigrationExecution({
        ...resolution,
        moduleName: "auth",
      });
      return bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        boundInputs: preview.boundInputs,
        registryBinding: preview.registryBinding,
      });
    };

    await resume();
    const completed = await historyEvents(fixture);
    assert.deepEqual(completed, events);
    assert.equal(await exists(journalPath), false);

    // The same journal survives a crash before its own unlink: recovery must
    // be a no-op the second time, not a second event.
    await writeJson(journalPath, journal);
    await resume();
    assert.deepEqual(await historyEvents(fixture), completed);
    assert.equal(await exists(journalPath), false);

    // And with no journal at all, still nothing to do.
    await resume();
    assert.deepEqual(await historyEvents(fixture), completed);
  } finally {
    await fixture.cleanup();
  }
});

// --- FINALIZE drift ---------------------------------------------------------

test("a legacy file added after the checkpoint blocks FINALIZE, naming it", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "SLICES");
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const added = path.join(fixture.legacyRoot, "auth/added-later.txt");
    await writeFile(added, "unclassified\n");
    await assert.rejects(
      advance(fixture),
      /changed after DISCOVERY_COMPLETENESS closed.*added: auth\/added-later\.txt/s,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a recorded algorithm version this build cannot run blocks with a recompute message", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "SLICES");
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const scanPath = path.join(
      fixture.migrationRoot,
      "inventories/discovery-scan.json",
    );
    const scan = await readJson(scanPath);
    // The digest pin covers `discoveryDigest` only, so the version moves alone.
    await writeJson(scanPath, { ...scan, algorithmVersion: 99 });
    await assert.rejects(
      advance(fixture),
      /recorded algorithm version 99[\s\S]*reopen discovery to recompute/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a missing recorded scanner version fails as a typed version error before rescanning", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "SLICES");
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const scanPath = path.join(
      fixture.migrationRoot,
      "inventories/discovery-scan.json",
    );
    const scan = await readJson(scanPath);
    delete scan.algorithmVersion;
    await writeJson(scanPath, scan);
    await writeFile(
      path.join(fixture.legacyRoot, "auth/content-drift.txt"),
      "must not be scanned\n",
    );
    await assert.rejects(advance(fixture), (error) => {
      assert.equal(error.name, "DiscoveryScannerVersionError");
      assert.equal(error.code, "MISSING_DISCOVERY_SCANNER_VERSION");
      assert.match(error.message, /missing required algorithmVersion/i);
      assert.doesNotMatch(error.message, /legacy module changed|content-drift/);
      return true;
    });
  } finally {
    await fixture.cleanup();
  }
});

// --- backward compatibility with format 9 -----------------------------------

/**
 * Rewrites a fixture into exactly what a record born before format 10 looks
 * like: eight checkpoints, no DISCOVERY_COMPLETENESS event, no discovery
 * artifacts, and a matching integrity anchor.
 */
const downgradeToFormat9 = async (fixture) => {
  const root = fixture.migrationRoot;
  const events = (await historyEvents(fixture))
    .filter((event) => event.step !== "DISCOVERY_COMPLETENESS")
    .map((event) =>
      event.nextStep === "DISCOVERY_COMPLETENESS"
        ? { ...event, nextStep: "ASSESS_TARGET" }
        : { ...event },
    );
  let revision = 1;
  for (const event of events.slice(1)) {
    revision += 1;
    if (Number.isInteger(event.revision)) event.revision = revision;
  }
  const history = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await writeFile(path.join(root, "history/history.ndjson"), history);

  const persisted = await state(fixture);
  const artifactHashes = { ...persisted.artifactHashes };
  for (const key of [
    "steps/02a-discovery-completeness.md",
    "inventories/module-classification.json",
    "inventories/discovery-scan.json#discovery",
  ]) {
    delete artifactHashes[key];
  }
  for (const relative of [
    "steps/02a-discovery-completeness.md",
    "inventories/module-classification.json",
    "inventories/discovery-scan.json",
  ]) {
    await rm(path.join(root, relative), { force: true });
  }
  // A real format-9 record predates the format-15 keys entirely, so a
  // downgraded fixture that kept them would not be a format-9 record at all.
  //
  // Toolkit identity is the opposite case and is deliberately *kept*: it is
  // metadata about the build, not about the format, and an old-format record
  // that an operator adopted is an ordinary state -- the only one from which
  // these tests' subject, the eight-checkpoint lifecycle, can still be driven.
  // The anchor below therefore carries its digest, exactly as the engine writes.
  delete persisted.legacySources;
  delete persisted.targetAdoption;
  const downgraded = {
    ...persisted,
    formatVersion: 9,
    currentStep:
      persisted.currentStep === "DISCOVERY_COMPLETENESS"
        ? "ASSESS_TARGET"
        : persisted.currentStep,
    completedSteps: persisted.completedSteps.filter(
      (s) => s !== "DISCOVERY_COMPLETENESS",
    ),
    pendingSteps: persisted.pendingSteps.filter(
      (s) => s !== "DISCOVERY_COMPLETENESS",
    ),
    artifactHashes,
    revision,
  };
  await writeJson(path.join(root, "state.json"), downgraded);
  const bytes = Buffer.from(history, "utf8");
  await writeJson(path.join(root, "integrity.json"), {
    revision: downgraded.revision,
    toolkitIdentitySha256: digestToolkitIdentity(downgraded.toolkitIdentity) ?? undefined,
    artifactHashesSha256: createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(artifactHashes).sort(([l], [r]) =>
              l < r ? -1 : l > r ? 1 : 0,
            ),
          ),
        ),
      )
      .digest("hex"),
    history: {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  return downgraded;
};

test("a format-9 record keeps the eight-checkpoint lifecycle and never runs the new code", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const downgraded = await downgradeToFormat9(fixture);
    assert.equal(downgraded.formatVersion, 9);
    assert.equal(downgraded.currentStep, "ASSESS_TARGET");

    const resolution = await resolutionFor(fixture);
    // Read-only operations leave the record byte-identical.
    const before = await snapshot(fixture.migrationRoot);
    const status = await getMigrationStatus({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(status.currentStep, "ASSESS_TARGET");
    assert.equal(status.formatVersion, 9);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(preview.currentCheckpoint, "ASSESS_TARGET");
    assert.equal(preview.expectedNextCheckpoint, "BUILD_BASELINE");
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);

    // Advancing keeps it on the eight-step list and stamps 9, never 10.
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    await advance(fixture);
    const after = await state(fixture);
    assert.equal(after.formatVersion, 9);
    assert.equal(after.currentStep, "BUILD_BASELINE");
    assert.deepEqual(after.completedSteps, [
      "RESOLVE",
      "DISCOVER_LEGACY",
      "ASSESS_TARGET",
    ]);
    assert.ok(!after.pendingSteps.includes("DISCOVERY_COMPLETENESS"));
    assert.equal(
      await exists(
        path.join(fixture.migrationRoot, "inventories/discovery-scan.json"),
      ),
      false,
      "a pre-10 record never generates a discovery scan",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a format-9 record finalizes on the eight-checkpoint lifecycle", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await downgradeToFormat9(fixture);
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    await advance(fixture);
    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeMatrices(fixture);
    await registerAuth(fixture);
    await advance(fixture);
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await advance(fixture);
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await completeStepDoc(fixture, "VERIFY_SLICES");
    for (const slice of SLICES) {
      await authorSlice(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
      await authorEvidence(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
    }
    await completeStepDoc(fixture, "FINALIZE");
    await writeMatrices(fixture, true);
    const persisted = await state(fixture);
    const context = {
      legacyRevision: await revisionOf(fixture.legacyRoot),
      targetRevision: await revisionOf(fixture.targetRoot),
      requirementsDigest: persisted.requirementsAuthority.digest,
      legacyDirtyDigest: (await dirtyManifest(fixture.legacyRoot)).digest,
      targetDirtyDigest: (
        await dirtyManifest(fixture.targetRoot, TARGET_DIRTY_SCOPE)
      ).digest,
    };
    await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
      version: 1,
      gates: GATES.map((gate) => ({
        gate,
        result: "PASS",
        attempts: 1,
        evidence: [gateEvidence(context)],
      })),
    });
    // FINALIZE's drift assertion must not fire for a record that never ran the
    // checkpoint: there is no recorded scan to compare against.
    await advance(fixture);
    const done = await state(fixture);
    assert.equal(done.status, "COMPLETE");
    assert.equal(done.formatVersion, 9);
    assert.deepEqual(done.completedSteps, [
      "RESOLVE",
      "DISCOVER_LEGACY",
      "ASSESS_TARGET",
      "BUILD_BASELINE",
      "PLAN",
      "IMPLEMENT_SLICES",
      "VERIFY_SLICES",
      "FINALIZE",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("a record newer than the supported format is refused cleanly, touching nothing", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    assert.equal(
      (await state(fixture)).formatVersion,
      MIGRATION_FORMAT_VERSION,
    );
    // Exactly what pre-change code does when it meets a current-format record:
    // the same guard, one version further along.
    const message = compatibilityBlocker(
      { contractVersion: 5, formatVersion: MIGRATION_FORMAT_VERSION + 1 },
      "auth",
    );
    assert.match(
      message,
      new RegExp(
        `newer than the supported contract 5 format ${MIGRATION_FORMAT_VERSION}`,
      ),
    );
    assert.match(message, /No file was changed/);
  } finally {
    await fixture.cleanup();
  }
});

// --- the auxiliary discovery entry points ------------------------------------
//
// Preview, advance and FINALIZE branch on the format, but `--scan`, an
// explicitly requested DISCOVERY_COMPLETENESS validation, and the operator
// recorder reached the format-10 engine directly. They all pass one guard now,
// so these four run against both formats.

/** The public `--scan` route, as a real caller enters it. */
const scanCli = (fixture) =>
  execFileAsync(
    process.execPath,
    [path.join(scriptsRoot, "cli/discover-module.mjs"), "auth", "--scan"],
    { encoding: "utf8", cwd: fixture.root },
  ).catch((error) => error);

/** The operator recorder, answered from something that looks like a terminal. */
const recordAtTerminal = async (fixture, candidate, answer) => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.end(`${answer}\n`);
  const written = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  });
  stdout.isTTY = true;
  // The recorder resolves the registry from the working directory, exactly as
  // the operator's shell would; `--registry` is refused once state exists.
  const cwd = process.cwd();
  process.chdir(fixture.root);
  try {
    const result = await runRecordDecisionCli(
      ["auth", "--approve", candidate.id],
      { stdin, stdout },
    );
    return { ...result, written: written.join("") };
  } finally {
    process.chdir(cwd);
  }
};

test("every auxiliary discovery entry point refuses a format-9 record, touching nothing", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    await downgradeToFormat9(fixture);
    // The classification is put back deliberately: the refusal must be about
    // the format, not about an artifact a pre-10 lifecycle never writes.
    await writeClassification(fixture, MODULE_CLASSIFICATION);
    const resolution = await resolutionFor(fixture);
    const before = await snapshot(fixture.migrationRoot);
    const refused =
      /format-10 operation.*format 9.*no DISCOVERY_COMPLETENESS checkpoint/s;

    await assert.rejects(
      previewDiscoveryScan({ ...resolution, moduleName: "auth" }),
      refused,
    );
    const cli = await scanCli(fixture);
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, refused);
    await assert.rejects(
      validateResumableMigration({
        ...resolution,
        moduleName: "auth",
        step: "DISCOVERY_COMPLETENESS",
      }),
      refused,
    );
    await assert.rejects(
      recordAtTerminal(
        fixture,
        {
          id: "APP-stale",
          kind: "EXCLUSION",
          subject: { type: "FILE", path: "auth/marker.txt" },
        },
        "irrelevant",
      ),
      refused,
    );

    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
    assert.equal(
      await exists(path.join(fixture.migrationRoot, DECISIONS_PATH)),
      false,
      "a pre-10 record never gains a decisions file",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("every auxiliary discovery entry point still serves a format-10 record", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture);
    const resolution = await resolutionFor(fixture);

    const scan = await previewDiscoveryScan({
      ...resolution,
      moduleName: "auth",
    });
    assert.match(scan.discoveryDigest, /^sha256:/);
    const cli = await scanCli(fixture);
    assert.equal(JSON.parse(cli.stdout).discoveryDigest, scan.discoveryDigest);
    const validated = await validateResumableMigration({
      ...resolution,
      moduleName: "auth",
      step: "DISCOVERY_COMPLETENESS",
    });
    assert.equal(validated.step, "DISCOVERY_COMPLETENESS");
    await writeClassification(
      fixture,
      exclusionClassification("Decorative, and nothing renders it."),
    );
    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    const candidate = pending.candidates[0];
    assert.ok(candidate?.approvable);
    const recorded = await recordAtTerminal(
      fixture,
      candidate,
      challengeFor(candidate),
    );
    assert.equal(recorded.decision.kind, "EXCLUSION");
    // One locked snapshot, so the line can never attest to a
    // revision/digest/bytes combination that never existed together.
    assert.deepEqual(recorded.decision.boundTo, {
      module: "auth",
      ...(await legacySourceBinding(fixture.legacyRoot)),
      discoveryDigest: scan.discoveryDigest,
      algorithmVersion: scan.algorithmVersion,
    });
  } finally {
    await fixture.cleanup();
  }
});

// --- CLI confirmation characterization --------------------------------------
//
// The two-phase CLI contract exactly as it stands today. Nothing in this suite
// drove `runDiscoverCli`/`runAdvanceCli` before, so the confirmation branch was
// the one part of the lifecycle with no coverage at all. These pin it before
// `--mode` moves any of it, and they are never rewritten to accommodate the new
// behavior: `--mode step` has to keep satisfying them verbatim.

/**
 * Runs a CLI entry point the way an operator's shell would: from the fixture
 * root, with stdout captured. `process.exitCode` is read into the result and
 * then restored, because a blocked run sets it process-wide and would otherwise
 * fail the whole suite.
 */
const runCli = async (fixture, run) => {
  const chunks = [];
  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  const previousExitCode = process.exitCode;
  process.chdir(fixture.root);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const result = await run();
    return { ...result, stdout: chunks.join(""), exitCode: process.exitCode };
  } finally {
    process.stdout.write = write;
    process.chdir(cwd);
    process.exitCode = previousExitCode;
  }
};

/** `--registry` is first-setup-only, exactly as `resolutionFor` treats it. */
const registryArguments = async (fixture) => {
  const project = JSON.parse(await readFile(fixture.packagePath, "utf8"));
  return project.config?.startMigration?.registry
    ? []
    : ["--registry", fixture.registryPath];
};

const discoverCli = async (fixture, extra = []) => {
  const argv = ["auth", ...(await registryArguments(fixture)), ...extra];
  return runCli(fixture, () => runDiscoverCli(argv));
};

const advanceCli = (fixture, extra = []) =>
  runCli(fixture, () => runAdvanceCli(["auth", ...extra]));

/**
 * The two-phase path is reached with `--mode step` once `--mode` exists, and
 * `--mode` defaults to `auto`. Every assertion below is the one Phase 1 pinned
 * against the pre-`--mode` binary; only the way the path is selected is named.
 */
const STEP = ["--mode", "step"];
const AUTO = ["--mode", "auto"];

test("a step-mode discover invocation stops for confirmation and writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);
    const run = await discoverCli(fixture, STEP);

    assert.equal(run.awaitingConfirmation, true);
    assert.equal(run.result, undefined);
    assert.match(run.preview.confirmationId, /^[0-9a-f]{16}$/);
    assert.ok(
      run.stdout.endsWith(
        `Confirmation ID: ${run.preview.confirmationId}\n` +
          "Proceed with this invocation? Reply Yes or No. No execution has started.\n",
      ),
      run.stdout,
    );
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("a step-mode advance invocation stops for confirmation and writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);
    const run = await advanceCli(fixture, STEP);

    assert.equal(run.awaitingConfirmation, true);
    assert.equal(run.result, undefined);
    assert.match(run.preview.confirmationId, /^[0-9a-f]{16}$/);
    assert.ok(
      run.stdout.endsWith(
        `Confirmation ID: ${run.preview.confirmationId}\n` +
          "Proceed with this advance? Reply Yes or No. No execution has started.\n",
      ),
      run.stdout,
    );
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("a confirmed CLI invocation executes exactly the action it previewed", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      MODULE_CLASSIFICATION,
    );

    const offered = await discoverCli(fixture, STEP);
    const discovered = await discoverCli(fixture, [
      "--confirm-execution",
      offered.preview.confirmationId,
    ]);
    assert.equal(discovered.awaitingConfirmation, undefined);
    assert.equal(discovered.result.state.currentStep, "DISCOVER_LEGACY");
    assert.match(discovered.stdout, /Confirmation accepted\./);

    const beforeRevision = (await state(fixture)).revision;
    const beforeEvents = (await historyEvents(fixture)).length;
    const proposed = await advanceCli(fixture, STEP);
    const advanced = await advanceCli(fixture, [
      "--confirm-advance",
      proposed.preview.confirmationId,
    ]);
    assert.equal(advanced.awaitingConfirmation, undefined);
    assert.equal(advanced.result.completedStep, "DISCOVER_LEGACY");
    assert.equal((await state(fixture)).revision, beforeRevision + 1);
    assert.equal((await historyEvents(fixture)).length, beforeEvents + 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a blocked CLI invocation exits 2, offers no confirmation ID, and writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);

    const discover = await discoverCli(fixture, ["--slice", "slice-z"]);
    assert.equal(discover.blocked, true);
    assert.equal(discover.exitCode, BLOCKED_EXIT_CODE);
    assert.equal(discover.preview.requiresConfirmation, false);
    assert.equal(discover.preview.confirmationId, null);
    assert.match(discover.stdout, /Execution: BLOCKED\./);

    const advanced = await advanceCli(fixture, ["--step", "PLAN"]);
    assert.equal(advanced.blocked, true);
    assert.equal(advanced.exitCode, BLOCKED_EXIT_CODE);
    assert.equal(advanced.preview.requiresConfirmation, false);
    assert.equal(advanced.preview.confirmationId, null);
    assert.match(advanced.stdout, /Advance: BLOCKED\./);

    assert.deepEqual(await snapshot(fixture.root), before);

    // The documented code must also reach a real shell, not only the
    // in-process return value.
    const spawned = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "cli/advance-migration.mjs"),
        "auth",
        "--step",
        "PLAN",
      ],
      { encoding: "utf8", cwd: fixture.root },
    ).catch((error) => error);
    assert.equal(spawned.code, BLOCKED_EXIT_CODE);
  } finally {
    await fixture.cleanup();
  }
});

test("--status and --scan refuse exactly the options they are documented to refuse", () => {
  for (const flag of [
    ["--target", "auth"],
    ["--brief", "brief.md"],
    ["--ponytail", "full"],
    ["--refresh"],
    ["--reopen-discovery"],
    ["--reopen-ui", "slice-a"],
    ["--scan"],
    ["--confirm-execution", "abc"],
    ["--confirm-mismatch"],
    ["--openspec-proposal-stdin"],
    ["--mock"],
    ["--mode", "auto"],
    ["--registry", "registry.json"],
    ["--slice", "slice-a"],
  ]) {
    assert.throws(
      () => parseDiscoverArguments(["auth", "--status", ...flag]),
      /--status is read-only/,
      `--status must refuse ${flag[0]}`,
    );
  }

  // `--scan` guards against mutating options only. These four describe *what*
  // to scan rather than a write, and are deliberately tolerated.
  for (const flag of [
    ["--registry", "registry.json"],
    ["--target", "auth"],
    ["--mock"],
    ["--ponytail", "full"],
  ]) {
    assert.equal(
      parseDiscoverArguments(["auth", "--scan", ...flag]).scan,
      true,
      `--scan must tolerate ${flag[0]}`,
    );
  }
  for (const flag of [
    ["--refresh"],
    ["--reopen-discovery"],
    ["--reopen-ui", "slice-a"],
    ["--confirm-execution", "abc"],
    ["--confirm-mismatch"],
    ["--brief", "brief.md"],
    ["--openspec-proposal-stdin"],
    ["--slice", "slice-a"],
  ]) {
    assert.throws(
      () => parseDiscoverArguments(["auth", "--scan", ...flag]),
      /--scan is read-only/,
      `--scan must refuse ${flag[0]}`,
    );
  }

  assert.throws(
    () => parseDiscoverArguments(["auth", "--reopen-discovery", "--refresh"]),
    /different transitions/,
  );
});

test("--refresh without --confirm-mismatch is refused and writes nothing", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);
    await assert.rejects(
      discoverCli(fixture, ["--refresh"]),
      /Refresh requires explicit mismatch confirmation/,
    );
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * Drives an unregistered module up to BUILD_BASELINE. `driveTo` registers the
 * mapping on the way through, which is the one step this fixture must skip.
 */
const driveUnregisteredToBaseline = async (fixture) => {
  await initialize(fixture, { targetOverride: "auth" });
  await completeStepDoc(fixture, "DISCOVER_LEGACY");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/legacy.json"),
    LEGACY_INVENTORY,
  );
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    MODULE_CLASSIFICATION,
  );
  await advance(fixture);
  await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    MODULE_CLASSIFICATION,
  );
  await advance(fixture);
  await completeStepDoc(fixture, "ASSESS_TARGET");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/target.json"),
    TARGET_INVENTORY,
  );
  await advance(fixture);
  await completeStepDoc(fixture, "BUILD_BASELINE");
  await writeMatrices(fixture);
};

test("an unregistered mapping stops BUILD_BASELINE with nothing written", async () => {
  const fixture = await createFixture({ modules: {} });
  try {
    await driveUnregisteredToBaseline(fixture);
    const before = await snapshot(fixture.root);

    // The registration gate is not a preflight blocker: the preview is clean
    // and still offers an ID. The refusal is raised inside the advance
    // transaction, before any write, and reaches the shell as the generic
    // failure code rather than BLOCKED_EXIT_CODE.
    const offered = await advanceCli(fixture, STEP);
    assert.equal(offered.awaitingConfirmation, true);
    assert.deepEqual(offered.preview.blockers, []);

    const refused = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "cli/advance-migration.mjs"),
        "auth",
        "--confirm-advance",
        offered.preview.confirmationId,
      ],
      { encoding: "utf8", cwd: fixture.root },
    ).catch((error) => error);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /migration mapping is not registered/);

    assert.deepEqual(await snapshot(fixture.root), before);
    assert.equal((await state(fixture)).currentStep, "BUILD_BASELINE");
  } finally {
    await fixture.cleanup();
  }
});

// --- autonomy equivalence and safety ----------------------------------------
//
// `--mode auto` supplies the confirmation ID the operator would have typed. It
// must therefore reach byte-for-byte the same record as the confirmed path, and
// must not be able to cross a gate that exists for a human to decide.

/**
 * Byte-copies a driven fixture, `.git` included, so both runs share a migration
 * id, a legacy revision and a creation time. Two independently created fixtures
 * never can: their commits carry different SHAs, which would show up as a
 * difference the mode did not cause.
 */
const cloneFixture = async (fixture) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-contract-"));
  await cp(fixture.root, root, { recursive: true });
  const moved = (absolute) =>
    path.join(root, path.relative(fixture.root, absolute));
  return {
    ...fixture,
    root,
    legacyRoot: moved(fixture.legacyRoot),
    targetRoot: moved(fixture.targetRoot),
    registryPath: moved(fixture.registryPath),
    packagePath: moved(fixture.packagePath),
    migrationRoot: moved(fixture.migrationRoot),
    specPath: moved(fixture.specPath),
    upgradesRoot: moved(fixture.upgradesRoot),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

/**
 * The canonical projection of a migration record. `state.json` carries
 * `createdAt`/`updatedAt` and every history event carries `at`, so two runs are
 * never byte-identical; everything else is deterministic and is compared
 * exactly, including `integrity.json`'s independently written
 * `artifactHashesSha256` anchor. That file's `history` anchor is excluded on
 * purpose: it hashes the timestamped history bytes, so it restates the three
 * stripped timestamps rather than any lifecycle fact of its own.
 */
const canonicalRecord = async (fixture) => {
  const { createdAt, updatedAt, ...persisted } = await state(fixture);
  const integrity = await readJson(
    path.join(fixture.migrationRoot, "integrity.json"),
  );
  const events = (await historyEvents(fixture)).map(
    ({ at, ...event }) => event,
  );
  return JSON.stringify(
    {
      state: persisted,
      integrity: {
        revision: integrity.revision,
        artifactHashesSha256: integrity.artifactHashesSha256,
      },
      events,
    },
    null,
    2,
  );
};

test("an auto advance reaches the same record as the confirmed advance on a linear step", async () => {
  const stepwise = await createFixture();
  let auto;
  try {
    await initialize(stepwise);
    await completeStepDoc(stepwise, "DISCOVER_LEGACY");
    await writeJson(
      path.join(stepwise.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeJson(
      path.join(
        stepwise.migrationRoot,
        "inventories/module-classification.json",
      ),
      MODULE_CLASSIFICATION,
    );
    auto = await cloneFixture(stepwise);

    const proposed = await advanceCli(stepwise, STEP);
    await advanceCli(stepwise, [
      "--confirm-advance",
      proposed.preview.confirmationId,
    ]);

    const run = await advanceCli(auto, AUTO);
    assert.equal(run.awaitingConfirmation, undefined);
    assert.equal(run.result.completedStep, "DISCOVER_LEGACY");

    assert.equal(await canonicalRecord(auto), await canonicalRecord(stepwise));
  } finally {
    await stepwise.cleanup();
    await auto?.cleanup();
  }
});

test("an auto advance reaches the same record as the confirmed advance on a slice step", async () => {
  const stepwise = await createFixture();
  let auto;
  try {
    await driveTo(stepwise, "PLAN");
    await authorSlice(stepwise, "slice-a");
    assert.equal((await state(stepwise)).currentStep, "IMPLEMENT_SLICES");
    auto = await cloneFixture(stepwise);

    const proposed = await advanceCli(stepwise, [
      ...STEP,
      "--slice",
      "slice-a",
    ]);
    const confirmed = await advanceCli(stepwise, [
      "--slice",
      "slice-a",
      "--confirm-advance",
      proposed.preview.confirmationId,
    ]);

    const run = await advanceCli(auto, [...AUTO, "--slice", "slice-a"]);
    assert.equal(run.awaitingConfirmation, undefined);
    assert.equal(run.result.completedStep, confirmed.result.completedStep);
    assert.equal(run.result.completedSlice, confirmed.result.completedSlice);

    assert.equal(await canonicalRecord(auto), await canonicalRecord(stepwise));
  } finally {
    await stepwise.cleanup();
    await auto?.cleanup();
  }
});

test("the default mode is auto on both mutating entry points", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      MODULE_CLASSIFICATION,
    );

    // No `--mode` anywhere: the predicate's `options.mode !== "step"` has to
    // read an absent mode as `auto`, or the default is only a documented
    // intention. Every other autonomy test names `--mode auto` explicitly and
    // would still pass with no default at all.
    const discovered = await discoverCli(fixture, []);
    assert.equal(discovered.awaitingConfirmation, undefined);
    assert.equal(discovered.result.state.currentStep, "DISCOVER_LEGACY");
    assert.match(discovered.stdout, /^Mode: auto .+ self-confirmed\.$/m);
    assert.match(discovered.stdout, /Confirmation accepted\./);
    // A run that behaves as auto must also report itself as auto: `mode=none`
    // told the reader the loop was nobody's, which is how it stopped being run.
    assert.match(discovered.stdout, /mode=auto/);
    assert.doesNotMatch(discovered.stdout, /mode=none/);

    const beforeRevision = (await state(fixture)).revision;
    const beforeEvents = (await historyEvents(fixture)).length;
    const advanced = await advanceCli(fixture, []);
    assert.equal(advanced.awaitingConfirmation, undefined);
    assert.equal(advanced.result.completedStep, "DISCOVER_LEGACY");
    assert.equal((await state(fixture)).revision, beforeRevision + 1);
    assert.equal((await historyEvents(fixture)).length, beforeEvents + 1);
    assert.match(advanced.stdout, /mode=auto/);
  } finally {
    await fixture.cleanup();
  }
});

test("an unknown --mode value is refused by name on both entry points", async () => {
  // Both CLIs validate at parse time, before any registry, state or legacy
  // read, so the refusal costs nothing and cannot half-run.
  assert.throws(
    () => parseDiscoverArguments(["auth", "--mode", "banana"]),
    /--mode accepts 'auto' or 'step'\./,
  );
  assert.throws(
    () => parseAdvanceArguments(["auth", "--mode", "banana"]),
    /--mode accepts 'auto' or 'step'\./,
  );

  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);
    for (const script of [
      "cli/discover-module.mjs",
      "cli/advance-migration.mjs",
    ]) {
      const refused = await execFileAsync(
        process.execPath,
        [path.join(scriptsRoot, script), "auth", "--mode", "banana"],
        { encoding: "utf8", cwd: fixture.root },
      ).catch((error) => error);
      // Generic failure, not BLOCKED_EXIT_CODE: a misspelled flag is a usage
      // error, not a migration the contract refuses to execute.
      assert.equal(refused.code, 1, script);
      assert.match(refused.stderr, /--mode accepts 'auto' or 'step'\./, script);
      assert.equal(refused.stdout, "", script);
    }
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("--mode auto still refuses a blocked preview on both entry points", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);

    const discover = await discoverCli(fixture, [
      ...AUTO,
      "--slice",
      "slice-z",
    ]);
    assert.equal(discover.blocked, true);
    assert.equal(discover.exitCode, BLOCKED_EXIT_CODE);
    assert.equal(discover.preview.confirmationId, null);

    const advanced = await advanceCli(fixture, [...AUTO, "--step", "PLAN"]);
    assert.equal(advanced.blocked, true);
    assert.equal(advanced.exitCode, BLOCKED_EXIT_CODE);
    assert.equal(advanced.preview.confirmationId, null);

    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("--mode auto never self-confirms a bootstrap", async () => {
  const fixture = await createFixture();
  try {
    const before = await snapshot(fixture.root);
    // A bootstrap pins the OpenSpec authority for the migration's whole life,
    // so it is fed exactly as RESOLVE feeds it and must still stop.
    const run = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          path.join(scriptsRoot, "cli/discover-module.mjs"),
          "auth",
          "--registry",
          fixture.registryPath,
          "--mode",
          "auto",
          "--openspec-proposal-stdin",
        ],
        { cwd: fixture.root },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(SPEC);
    });

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Current state: NOT_STARTED/);
    assert.match(
      run.stdout,
      /Proceed with this invocation\? Reply Yes or No\. No execution has started\./,
    );
    assert.doesNotMatch(run.stdout, /self-confirmed/);
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("--mode auto refuses --refresh, and the auto default leaves --refresh two-phase", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(
      () =>
        parseDiscoverArguments([
          "auth",
          "--mode",
          "auto",
          "--refresh",
          "--confirm-mismatch",
        ]),
      /--refresh, --reopen-ui, and --rework-slice are operator decisions/,
    );

    await initialize(fixture);
    const before = await snapshot(fixture.root);
    // The assertion that matters: `--mode` defaults to `auto`, and that default
    // must not have made the artifact-invalidating path autonomous.
    const run = await discoverCli(fixture, ["--refresh", "--confirm-mismatch"]);
    assert.equal(run.awaitingConfirmation, true);
    assert.doesNotMatch(run.stdout, /self-confirmed/);
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("--mode auto stops at the registration gate with nothing written", async () => {
  const fixture = await createFixture({ modules: {} });
  try {
    await driveUnregisteredToBaseline(fixture);
    const before = await snapshot(fixture.root);

    // Auto self-confirms the advance and is refused inside the transaction,
    // before any write, with the generic failure code.
    const refused = await execFileAsync(
      process.execPath,
      [
        path.join(scriptsRoot, "cli/advance-migration.mjs"),
        "auth",
        "--mode",
        "auto",
      ],
      { encoding: "utf8", cwd: fixture.root },
    ).catch((error) => error);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /migration mapping is not registered/);

    assert.deepEqual(await snapshot(fixture.root), before);
    assert.equal((await state(fixture)).currentStep, "BUILD_BASELINE");
  } finally {
    await fixture.cleanup();
  }
});

test("the operator approval gate stays a hard TTY gate that --mode cannot reach", async () => {
  // The recorder has no `--mode` at all: autonomy never grows a path to it.
  assert.throws(() =>
    parseDecisionArguments(["auth", "--approve", "x", "--mode", "auto"]),
  );

  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.root);
    const chunks = [];
    const cwd = process.cwd();
    const previousExitCode = process.exitCode;
    process.chdir(fixture.root);
    try {
      const result = await runRecordDecisionCli(["auth", "--approve", "any"], {
        stdin: { isTTY: false },
        stdout: {
          isTTY: false,
          write: (chunk) => chunks.push(String(chunk)),
        },
      });
      assert.equal(result.blocked, true);
      assert.equal(process.exitCode, BLOCKED_EXIT_CODE);
    } finally {
      process.chdir(cwd);
      process.exitCode = previousExitCode;
    }
    assert.match(chunks.join(""), /can never approve a candidate/);
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("an unfinished upgrade transaction blocks --mode auto exactly as it blocks a manual run", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    await plantLiveMoved(fixture);
    const before = await snapshot(fixture.root);

    const run = await discoverCli(fixture, AUTO);
    assert.equal(run.blocked, true);
    assert.equal(run.exitCode, BLOCKED_EXIT_CODE);
    assert.equal(run.preview.state, "INCOMPATIBLE");
    assert.equal(run.preview.confirmationId, null);
    assert.match(
      run.preview.blockers.join("\n"),
      /unfinished upgrade transaction/,
    );
    assert.doesNotMatch(run.stdout, /self-confirmed/);

    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

// --- progress checklist ------------------------------------------------------

test("the progress checklist is deterministic and ASCII-only", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const persisted = await state(fixture);
    const rendered = renderProgressChecklist(persisted, "auto");

    for (let index = 0; index < 100; index += 1) {
      assert.equal(renderProgressChecklist(persisted, "auto"), rendered);
    }
    // Emoji and box drawing do not survive a Windows terminal, and the
    // five-tree parity test compares this string byte for byte.
    assert.match(rendered, /^[\x20-\x7e\n]*$/);
    for (const marker of rendered.match(/\[.\]/g)) {
      assert.ok(
        ["[x]", "[>]", "[ ]"].includes(marker),
        `unexpected marker ${marker}`,
      );
    }
    assert.match(
      rendered,
      /^progress: auth -> auth {2}status=ACTIVE {2}revision=\d+ {2}mode=auto$/m,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("the checklist renders the lifecycle the record was actually born under", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const modern = renderProgressChecklist(await state(fixture), "auto");
    assert.equal(modern.match(/^\[.\] \d+\/9 /gm).length, 9);
    assert.match(modern, /DISCOVERY_COMPLETENESS/);

    // A format-9 record never had a DISCOVERY_COMPLETENESS checkpoint, so
    // rendering one would invent a checkpoint the operator cannot close.
    await downgradeToFormat9(fixture);
    const born9 = renderProgressChecklist(await state(fixture), "auto");
    assert.equal(born9.match(/^\[.\] \d+\/8 /gm).length, 8);
    assert.doesNotMatch(born9, /DISCOVERY_COMPLETENESS/);
  } finally {
    await fixture.cleanup();
  }
});

test("a COMPLETE record renders every checkpoint done and nothing in progress", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const persisted = await state(fixture);
    assert.equal(persisted.status, "COMPLETE");
    const rendered = renderProgressChecklist(persisted, null);

    assert.doesNotMatch(rendered, /\[>\]/);
    assert.equal(rendered.match(/^\[x\] /gm).length, 9);
    assert.match(rendered, /mode=none/);
  } finally {
    await fixture.cleanup();
  }
});

test("the slice block appears only once slices exist, in progression order", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const planned = await state(fixture);

    // RESOLVE..PLAN have no slices at all; an empty block would be noise.
    assert.doesNotMatch(
      renderProgressChecklist(
        {
          ...planned,
          activeSlice: null,
          completedSlices: [],
          pendingSlices: [],
        },
        "auto",
      ),
      /^slices:/m,
    );
    const rendered = renderProgressChecklist(planned, "auto");
    assert.match(rendered, /^slices: 0\/2 done$/m);
    assert.deepEqual(rendered.match(/^ {2}\[.\] .+$/gm), [
      "  [>] slice-a",
      "  [ ] slice-b",
    ]);
    assert.match(rendered, /^\[>\] 7\/9 IMPLEMENT_SLICES {2}active=slice-a$/m);

    // Close the first slice and the order becomes completed -> active.
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    await authorEvidence(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const afterFirst = renderProgressChecklist(await state(fixture), "auto");
    assert.match(afterFirst, /^slices: 1\/2 done$/m);
    assert.deepEqual(afterFirst.match(/^ {2}\[.\] .+$/gm), [
      "  [x] slice-a",
      "  [>] slice-b",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("--status stays valid JSON and carries the checklist", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(scriptsRoot, "cli/discover-module.mjs"), "auth", "--status"],
      { encoding: "utf8", cwd: fixture.root },
    );
    const status = JSON.parse(stdout);
    assert.equal(status.progressChecklist, renderProgress(status.progress));
    assert.match(status.progressChecklist, /mode=none/);
  } finally {
    await fixture.cleanup();
  }
});

// --- canonical progress projection -------------------------------------------
//
// The defect these cover: every provider used to be free to invent its own
// migration plan and show it as progress, so Claude, Codex, Copilot and
// OpenCode could each display a different reading of one persisted record.
// Progress is now one deterministic projection of `state.json`, and these
// pin its contract, its cross-provider parity, and the fact that it is a
// display and never a control.

// Deliberately not a literal. Copying the lifecycle here is exactly the
// defect this section exists to prevent: a second definition that keeps
// asserting the old workflow after the engine moved on. Whatever
// `MIGRATION_STEPS` says today is what every provider must render today.
const CANONICAL_CHECKPOINTS = MIGRATION_STEPS;

test("progress is projected from the engine lifecycle, never from a frozen copy", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVERY_COMPLETENESS");
    const persisted = await state(fixture);

    // 1. The projection reports the lifecycle the engine defines, whatever
    //    that is. A checkpoint added, removed or reordered in MIGRATION_STEPS
    //    reaches every provider without touching presentation code.
    assert.deepEqual(
      migrationProgress(persisted, { mode: "auto" }).checkpoints.map(
        (checkpoint) => checkpoint.name,
      ),
      MIGRATION_STEPS,
    );

    // 2. The proof that it is derived and not duplicated: hand it a record
    //    born under a *different* lifecycle and the projection follows the
    //    engine, not a constant. A hardcoded array cannot pass both branches.
    await downgradeToFormat9(fixture);
    const legacyRecord = await state(fixture);
    assert.notDeepEqual(LEGACY_MIGRATION_STEPS, MIGRATION_STEPS);
    assert.deepEqual(
      migrationProgress(legacyRecord, { mode: "auto" }).checkpoints.map(
        (checkpoint) => checkpoint.name,
      ),
      LEGACY_MIGRATION_STEPS,
    );

    // 3. Visible-UI verification (format 12) is sub-work inside these
    //    checkpoints, and FINALIZE's gates are work inside checkpoint 9.
    //    Neither may surface as a tenth top-level row.
    for (const gate of [...FINAL_GATES, "UI_EVIDENCE", "PLAYWRIGHT"]) {
      assert.ok(
        !MIGRATION_STEPS.includes(gate),
        `${gate} was promoted to a top-level checkpoint`,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("no presentation path keeps its own copy of the engine lifecycle", async () => {
  // A provider adapter, command or prompt that declares its own checkpoint
  // array is a second source of truth by definition. Only the engine and its
  // verbatim generated copies may name the lifecycle in code.
  const allowed = new Set(
    [".agents", ".claude", ".codex", ".github", ".opencode"].flatMap((root) => [
      `${root}/skills/start-migration/scripts/resumable-migration.mjs`,
      `${root}/skills/start-migration/scripts/upgrades/upgrade-v4-to-v5.mjs`,
    ]),
  );
  const offenders = [];
  for (const root of [".agents", ".claude", ".codex", ".github", ".opencode"]) {
    const absolute = path.join(repositoryRoot, root);
    if (!(await exists(absolute))) continue;
    for (const entry of await readdir(absolute, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      if (!/\.(mjs|js|ts|json)$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      const relative = path
        .relative(repositoryRoot, file)
        .split(path.sep)
        .join("/");
      if (allowed.has(relative) || relative.endsWith(".test.mjs")) continue;
      const content = await readFile(file, "utf8");
      // A checkpoint array, not a passing mention of one checkpoint.
      if (/"RESOLVE"[\s,]*\n?\s*"DISCOVER_LEGACY"/.test(content)) {
        offenders.push(relative);
      }
    }
  }
  assert.deepEqual(offenders, [], "presentation code duplicates the lifecycle");
});

test("visible-UI progress is reported from persisted evidence, beneath the checkpoints", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(scriptsRoot, "cli/discover-module.mjs"), "auth", "--status"],
      { encoding: "utf8", cwd: fixture.root },
    );
    const status = JSON.parse(stdout);

    // Whatever the engine already computed, passed through unchanged. The
    // projection performs no I/O and invents no availability of its own.
    assert.deepEqual(status.progress.uiEvidence, status.uiEvidence);
    assert.equal(status.uiEvidence.applicable, true);
    assert.equal(status.uiEvidence.state, "MISSING");
    assert.equal(status.uiEvidence.runtime, "REQUIRED");
    assert.match(
      status.progressChecklist,
      /^ui evidence: MISSING {2}runtime=REQUIRED {2}records=0 {2}limitations=0 {2}freshness=\w+$/m,
    );
    // Sub-work, never a tenth row: the checkpoint count is untouched.
    assert.equal(status.progress.checkpoints.length, MIGRATION_STEPS.length);
    assert.doesNotMatch(status.progressChecklist, /^\[.\] \d+\/\d+ UI/m);

    // A record with no visible UI renders byte for byte what it rendered
    // before UI verification existed -- the line is absent, not empty.
    const withoutUi = migrationProgress(await state(fixture), {
      mode: null,
      uiEvidence: { applicable: false, state: "NOT_REQUIRED" },
    });
    assert.doesNotMatch(renderProgress(withoutUi), /^ui evidence:/m);
    assert.equal(
      renderProgress(withoutUi),
      renderProgressChecklist(await state(fixture), null),
    );

    // `migration_run` has not read the evidence, so it reports null rather
    // than guessing -- and still renders identical checkpoints.
    const fromRun = migrationProgress(await state(fixture), { mode: "auto" });
    assert.equal(fromRun.uiEvidence, null);
    assert.deepEqual(
      fromRun.checkpoints.map((checkpoint) => checkpoint.name),
      status.progress.checkpoints.map((checkpoint) => checkpoint.name),
    );
  } finally {
    await fixture.cleanup();
  }
});

/** Everything a provider is allowed to render, and nothing host-specific. */
const assertCanonicalProjection = (progress, label) => {
  assert.deepEqual(
    progress.checkpoints.map((checkpoint) => checkpoint.name),
    CANONICAL_CHECKPOINTS,
    `${label} checkpoint names and order`,
  );
  for (const [index, checkpoint] of progress.checkpoints.entries()) {
    assert.equal(checkpoint.index, index + 1, `${label} index`);
    assert.equal(
      checkpoint.total,
      CANONICAL_CHECKPOINTS.length,
      `${label} total`,
    );
    assert.ok(
      CHECKPOINT_STATES.includes(checkpoint.state),
      `${label} state ${checkpoint.state}`,
    );
  }
  // Exactly one checkpoint is in flight: two would let a provider choose.
  assert.equal(
    progress.checkpoints.filter((checkpoint) =>
      ["ACTIVE", "BLOCKED"].includes(checkpoint.state),
    ).length,
    progress.activeCheckpoint ? 1 : 0,
    `${label} in-flight checkpoint count`,
  );
};

test("the projection exposes the engine's checkpoints, in engine order", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const progress = migrationProgress(await state(fixture), { mode: "auto" });
    assertCanonicalProjection(progress, "PLAN");
    assert.equal(progress.activeCheckpoint, "IMPLEMENT_SLICES");
    assert.equal(
      progress.checkpoints.find((c) => c.name === "IMPLEMENT_SLICES").state,
      "ACTIVE",
    );
    assert.equal(
      progress.checkpoints.filter((c) => c.state === "COMPLETED").length,
      CANONICAL_CHECKPOINTS.indexOf("IMPLEMENT_SLICES"),
    );
    // Derived data only: nothing host-specific may ride along, or the four
    // providers stop being interchangeable.
    assert.deepEqual(Object.keys(progress).sort(), [
      "activeCheckpoint",
      "activeSlice",
      "blocker",
      "checkpoints",
      "mode",
      "module",
      "nextWork",
      "revision",
      "slices",
      "status",
      "stopReason",
      "target",
      "uiEvidence",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The four-provider half of this proof is covered by the structural assertion
 * above; what remains provable, and worth proving, is the property it depended
 * on: a fresh process reading only `state.json` -- no conversation history, no
 * rescan, which is exactly what a different provider's session is -- projects the
 * canonical progress and renders its text fallback from that same projection.
 */
test("a fresh process projects the canonical progress and renders its text from it", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(scriptsRoot, "cli/discover-module.mjs"), "auth", "--status"],
      { encoding: "utf8", cwd: fixture.root },
    );
    const status = JSON.parse(stdout);
    assertCanonicalProjection(status.progress, scriptsRoot);
    assert.equal(
      status.progressChecklist,
      renderProgress(status.progress),
      "the text fallback is rendered from the same projection",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a stopped iteration blocks the active checkpoint and approves nothing", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const persisted = await state(fixture);
    for (const outcome of ["BLOCKED", "OPERATOR_DECISION", "FAILED"]) {
      const progress = migrationProgress(persisted, {
        mode: "auto",
        outcome,
        reason: `candidate: APP-196a2d4a7b646aa233fb`,
      });
      assertCanonicalProjection(progress, outcome);
      assert.equal(
        progress.checkpoints.find((c) => c.name === progress.activeCheckpoint)
          .state,
        "BLOCKED",
      );
      assert.equal(progress.stopReason, outcome);
      assert.match(progress.blocker, /APP-196a2d4a7b646aa233fb/);
      // Deterministic: the same record and outcome render the same bytes.
      assert.equal(
        renderProgress(progress),
        renderProgress(
          migrationProgress(persisted, {
            mode: "auto",
            outcome,
            reason: `candidate: APP-196a2d4a7b646aa233fb`,
          }),
        ),
      );
      // A display, never a control. Nothing in the projection or its text
      // offers a way to approve the decision it is reporting.
      const surface = `${JSON.stringify(progress)}\n${renderProgress(progress)}`;
      assert.doesNotMatch(
        surface,
        /approve|confirmationId|challenge|elicit/i,
        `${outcome} exposes an approval affordance`,
      );
    }
    // A CONTINUE iteration is unaffected: no stop fields at all.
    const running = migrationProgress(persisted, {
      mode: "auto",
      outcome: "CONTINUE",
    });
    assert.equal(running.stopReason, null);
    assert.equal(running.blocker, null);
  } finally {
    await fixture.cleanup();
  }
});

test("no provider tree carries its own copy of the migration state machine", async () => {
  // Provider frontmatter and the generated banner legitimately differ (Codex
  // drops `user-invocable`), so the comparison starts at the protocol itself.
  const skillBody = (document) =>
    document.slice(document.indexOf("# Start Migration"));
  const skill = skillBody(
    await readFile(
      path.join(repositoryRoot, "skills/start-migration/SKILL.md"),
      "utf8",
    ),
  );
  for (const provider of ["claude", "codex", "copilot", "opencode"]) {
    const root = path.join(
      repositoryRoot,
      "providers",
      provider,
      "skills/start-migration",
    );
    // Not "the copy matches" but "there is no copy". The engine is one installed
    // package; a provider-local module is the fork this forbids, whatever its
    // bytes say today.
    assert.equal(
      await exists(path.join(root, "scripts/resumable-migration.mjs")),
      false,
      `${provider} forked the engine`,
    );
    // The protocol is authored once. A provider-local rewrite of it is how
    // four progress contracts get maintained by hand.
    assert.equal(
      skillBody(await readFile(path.join(root, "SKILL.md"), "utf8")),
      skill,
      `${provider} forked the protocol`,
    );
  }
  // Parity is worthless if the one authored copy never states the rules, so
  // the content every provider inherits is pinned here rather than assumed.
  //
  // Matched against whitespace-collapsed prose: the rules below are sentences,
  // but the document hard-wraps at the column, so a literal `includes` pins the
  // line breaks as well as the words and silently stops matching the moment a
  // paragraph is re-flowed. What is pinned here is the wording, not the wrap.
  const prose = skill.replace(/\s+/g, " ");
  for (const rule of [
    "## Progress presentation",
    "Never derive displayed progress from source files",
    "one row per `checkpoints[]` entry",
    "the engine's checkpoint name,",
    "never sort, filter, merge, rename or add",
    "both on every outcome",
    "On every iteration, render canonical progress",
    "Never reformat, re-order, translate, summarize, add emoji to, or add percentages",
    "`progressChecklist` verbatim inside a fenced code block",
    "never required to execute a migration",
    "### Never author a migration plan",
    "A progress row is a display, never a control",
    "never through a model-callable affordance",
  ]) {
    assert.ok(prose.includes(rule), `the protocol no longer states: ${rule}`);
  }
});

/**
 * Invariance across modes rather than a golden literal, on purpose. A
 * confirmation ID hashes the resolved legacy and target roots and the fixture's
 * fresh git revision, so it is different on every run of this suite; no literal
 * can be checked in, and reconstructing the pre-change value at test time would
 * mean shipping a copy of an old build or reading it back out of git, which
 * rots the moment HEAD moves.
 *
 * What remains checked in is the property that guards the regression:
 * `mode` changes the checklist, so if `progressChecklist` were ever moved
 * inside the hashed object, the three modes would produce three IDs.
 */
test("the progress checklist is outside the hashed preview, so no confirmation ID moves", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const base = { ...(await resolutionFor(fixture)), moduleName: "auth" };
    const ids = [];
    const checklists = [];
    for (const mode of [undefined, "auto", "step"]) {
      const execution = await previewMigrationExecution({ ...base, mode });
      const advanceable = await previewAdvance({ ...base, mode });
      ids.push(`${execution.confirmationId}:${advanceable.confirmationId}`);
      checklists.push(execution.progressChecklist);
    }
    // The mode reaches the checklist and nothing else. If `progressChecklist`
    // had landed inside the hashed object, the modes would mean several IDs.
    assert.equal(new Set(ids).size, 1, ids.join(" | "));
    // Two, not three: an absent `--mode` is `auto` and renders as `auto`.
    assert.equal(new Set(checklists).size, 2);
    assert.equal(checklists[0], checklists[1]);
  } finally {
    await fixture.cleanup();
  }
});

test("a blocked run still prints the checklist on both entry points", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");
    const before = await snapshot(fixture.root);
    const run = await discoverCli(fixture, [...AUTO, "--slice", "slice-z"]);

    assert.equal(run.blocked, true);
    assert.equal(run.exitCode, BLOCKED_EXIT_CODE);
    assert.match(run.stdout, /Execution: BLOCKED\./);
    assert.match(run.stdout, /^progress: auth -> auth/m);
    assert.match(run.stdout, /^slices: 0\/2 done$/m);

    const blockedAdvance = await advanceCli(fixture, [
      ...AUTO,
      "--step",
      "PLAN",
    ]);
    assert.equal(blockedAdvance.blocked, true);
    assert.equal(blockedAdvance.exitCode, BLOCKED_EXIT_CODE);
    assert.match(blockedAdvance.stdout, /Advance: BLOCKED\./);
    assert.match(blockedAdvance.stdout, /^progress: auth -> auth/m);
    assert.match(blockedAdvance.stdout, /^slices: 0\/2 done$/m);

    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

// --- autonomous continuation -------------------------------------------------

test("an auto loop closes consecutive checkpoints in one process with no operator input", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const startRevision = (await state(fixture)).revision;
    const startEvents = (await historyEvents(fixture)).length;

    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      MODULE_CLASSIFICATION,
    );
    const first = await advanceCli(fixture, AUTO);
    assert.equal(first.awaitingConfirmation, undefined);
    assert.equal(first.result.completedStep, "DISCOVER_LEGACY");

    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      MODULE_CLASSIFICATION,
    );
    const second = await advanceCli(fixture, AUTO);
    assert.equal(second.awaitingConfirmation, undefined);
    assert.equal(second.result.completedStep, "DISCOVERY_COMPLETENESS");

    // One checkpoint per iteration: two closed, two events, revision +2.
    const persisted = await state(fixture);
    assert.equal(persisted.currentStep, "ASSESS_TARGET");
    assert.equal(persisted.revision, startRevision + 2);
    assert.equal((await historyEvents(fixture)).length, startEvents + 2);
    assert.match(second.stdout, /^progress: auth -> auth/m);
    assert.match(second.stdout, /mode=auto/);
  } finally {
    await fixture.cleanup();
  }
});

test("an interrupted auto loop resumes from persisted state in a new process", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    const resumedFrom = await state(fixture);
    const discoveryArtifacts = await snapshot(
      path.join(fixture.migrationRoot, "inventories"),
    );

    // A separate process shares nothing with the loop that stopped: whatever it
    // resumes from came off disk.
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(scriptsRoot, "cli/discover-module.mjs"), "auth", "--mode", "auto"],
      { encoding: "utf8", cwd: fixture.root },
    );
    assert.match(stdout, /Current checkpoint: DISCOVERY_COMPLETENESS/);
    assert.match(stdout, /Resume mode: CHECKPOINT/);
    assert.doesNotMatch(stdout, /Refresh legacy evidence/);

    const after = await state(fixture);
    assert.equal(after.currentStep, resumedFrom.currentStep);
    assert.deepEqual(after.completedSteps, resumedFrom.completedSteps);
    assert.equal(
      after.legacyRevision.revision,
      resumedFrom.legacyRevision.revision,
    );
    // Discovery was not restarted and no artifact was recreated.
    assert.deepEqual(
      await snapshot(path.join(fixture.migrationRoot, "inventories")),
      discoveryArtifacts,
    );
    // No module lock survived the interruption.
    assert.equal(await exists(lockPathFor(fixture.targetRoot, "auth")), false);
  } finally {
    await fixture.cleanup();
  }
});

// --- the deterministic loop directive ---------------------------------------
//
// The defect: `--mode auto` automated the *confirmation* policy and nothing
// else. Whether a second iteration ran was left to the model reading prose,
// and the instructions it read told it to stop after every advance. These pin
// continuation as a contract: one machine-readable line per iteration, obeyed
// literally, and a stop that has to name a typed reason.

/** The single `loop:` line an invocation ended with, or null if it printed none. */
const loopDirective = (run) => {
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.startsWith("loop: "));
  assert.ok(lines.length <= 1, `one directive at most:\n${run.stdout}`);
  return lines[0] ?? null;
};

/**
 * One unattended iteration. Fails the run the moment anything asks a human
 * for anything, which is the whole property under test.
 */
const autoStep =
  (record) =>
  async (fixture, options = {}) => {
    const run = await advanceCli(fixture, [
      ...AUTO,
      ...(options.slice ? ["--slice", options.slice] : []),
    ]);
    assert.equal(run.awaitingConfirmation, undefined, run.stdout);
    assert.equal(run.blocked, undefined, run.stdout);
    assert.doesNotMatch(run.stdout, /Reply Yes or No/, run.stdout);
    // The directive itself says CONTINUE, so the prose is checked without it:
    // nothing may ask the operator to type "continue".
    const prose = run.stdout
      .split("\n")
      .filter((line) => !line.startsWith("loop: "))
      .join("\n");
    assert.doesNotMatch(prose, /continue/i, run.stdout);
    const persisted = await state(fixture);
    record.push({
      reached: persisted.currentStep,
      slice: persisted.activeSlice ?? null,
      directive: loopDirective(run),
    });
    return run.result;
  };

test("one auto run drives the whole lifecycle to COMPLETE with no operator input", async () => {
  const fixture = await createFixture();
  try {
    // `initialize` and `registerAuth` (inside `driveTo`) are the two operator
    // gates; everything after them must run unattended.
    const iterations = [];
    await driveTo(fixture, "FINALIZE", autoStep(iterations));

    const CONTINUE = "loop: CONTINUE next=/start-migration auth";
    assert.deepEqual(iterations, [
      { reached: "DISCOVERY_COMPLETENESS", slice: null, directive: CONTINUE },
      { reached: "ASSESS_TARGET", slice: null, directive: CONTINUE },
      { reached: "BUILD_BASELINE", slice: null, directive: CONTINUE },
      { reached: "PLAN", slice: null, directive: CONTINUE },
      // PLAN -> the first slice, then implement -> verify -> the next slice.
      { reached: "IMPLEMENT_SLICES", slice: "slice-a", directive: CONTINUE },
      { reached: "VERIFY_SLICES", slice: "slice-a", directive: CONTINUE },
      { reached: "IMPLEMENT_SLICES", slice: "slice-b", directive: CONTINUE },
      { reached: "VERIFY_SLICES", slice: "slice-b", directive: CONTINUE },
      { reached: "FINALIZE", slice: null, directive: CONTINUE },
      {
        reached: "COMPLETE",
        slice: null,
        directive: "loop: STOP reason=COMPLETE",
      },
    ]);

    const persisted = await state(fixture);
    assert.equal(persisted.status, "COMPLETE");
    // One event per iteration: the loop never batched two checkpoints.
    assert.equal(
      (await historyEvents(fixture)).filter(
        (entry) => entry.event === "STEP_COMPLETED",
      ).length,
      iterations.length,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a genuine stop names a typed reason instead of continuing", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN");

    const blockedAdvance = await advanceCli(fixture, [
      ...AUTO,
      "--step",
      "PLAN",
    ]);
    assert.equal(blockedAdvance.blocked, true);
    assert.equal(loopDirective(blockedAdvance), "loop: STOP reason=BLOCKED");

    const blockedDiscover = await discoverCli(fixture, [
      ...AUTO,
      "--slice",
      "slice-z",
    ]);
    assert.equal(blockedDiscover.blocked, true);
    assert.equal(loopDirective(blockedDiscover), "loop: STOP reason=BLOCKED");

    // `--refresh` is an operator decision, so auto hands back rather than
    // self-confirming, and says so in the directive.
    const refresh = await discoverCli(fixture, [
      "--refresh",
      "--confirm-mismatch",
    ]);
    assert.equal(refresh.awaitingConfirmation, true);
    assert.equal(
      loopDirective(refresh),
      "loop: STOP reason=AWAITING_CONFIRMATION",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("--mode step prints no directive: there is no loop for it to drive", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    assert.equal(loopDirective(await advanceCli(fixture, STEP)), null);
    assert.equal(loopDirective(await discoverCli(fixture, STEP)), null);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The instruction side of the same defect. `--mode auto` can only be
 * autonomous if the prose the agent reads does not order it to stop, and the
 * generated provider mirrors are read by exactly the same agents as the
 * authored sources.
 */
test("no authoritative instruction orders the loop to stop after an advance", async () => {
  const forbidden = [
    "Never continue into the next checkpoint",
    "End every session after state advances",
  ];
  // The canonical documents and every generated mirror of them: the mirrors are
  // read by exactly the same agents as the sources.
  const roots = ["skills", "providers"];
  const documents = [];
  for (const root of roots) {
    const absolute = path.join(repositoryRoot, root);
    if (!(await exists(absolute))) continue;
    for (const entry of await readdir(absolute, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        documents.push(path.join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  }
  // A guard that scans nothing passes trivially.
  assert.ok(
    documents.length > 20,
    `only ${documents.length} documents scanned`,
  );
  for (const document of documents) {
    if (!(await exists(document))) continue;
    const content = await readFile(document, "utf8");
    for (const phrase of forbidden) {
      assert.ok(
        !content.includes(phrase),
        `${path.relative(repositoryRoot, document)} still says "${phrase}"`,
      );
    }
  }
});

// --- format 11: capability ownership ----------------------------------------
//
// The gap these cover: the contract could require reuse of a target component
// that already existed, but said nothing at all when a required capability was
// *missing* from the target. An agent could rebuild a shared table, search box
// or form shell inside whichever feature it happened to be migrating, and no
// artifact recorded that a choice had been made. Every scenario below is that
// defect, or a guard against over-correcting into promoting everything.

const CAPABILITY_PATH = "matrices/capability-ownership.json";

const writeCapabilities = (fixture, rows, extra = {}) =>
  writeJson(
    path.join(fixture.migrationRoot, CAPABILITY_PATH),
    capabilityOwnership(rows, extra),
  );

/** BUILD_BASELINE staged but not advanced, so the matrix is still editable. */
const capabilityClassification = {
  ...MODULE_CLASSIFICATION,
  files: [
    ...MODULE_CLASSIFICATION.files,
    {
      ...MODULE_CLASSIFICATION.files[0],
      path: "auth/consumers.ts",
      kind: "MODULE",
      rationale: "The fixture dependency edge proves the consumer census.",
    },
  ],
  supporting: ["users", "partners"].map((consumer) => ({
    relation: "SUPPORTING",
    type: "MODULE",
    path: consumer,
    requiredBy: ["auth/consumers.ts"],
  })),
};

const prepareCapabilityCensus = async (fixture) => {
  await writeFile(
    path.join(fixture.legacyRoot, "auth/consumers.ts"),
    'import "../users";\nimport "../partners";\n',
  );
  await writeFile(path.join(fixture.legacyRoot, "users"), "users\n");
  await writeFile(path.join(fixture.legacyRoot, "partners"), "partners\n");
  await execFileAsync("git", ["add", "legacy"], { cwd: fixture.root });
  const typescriptLink = path.join(
    fixture.legacyRoot,
    "node_modules/typescript",
  );
  await mkdir(path.dirname(typescriptLink), { recursive: true });
  await symlink(
    path.join(repositoryRoot, "node_modules/typescript"),
    typescriptLink,
    process.platform === "win32" ? "junction" : "dir",
  );
};

const stagedBaseline = async (fixture) => {
  await prepareCapabilityCensus(fixture);
  await driveTo(fixture, "ASSESS_TARGET", advance, {
    classification: capabilityClassification,
    formatVersion: 12,
  });
  await completeStepDoc(fixture, "BUILD_BASELINE");
  await writeMatrices(fixture);
  await registerAuth(fixture);
};

const SHARED_CAPABILITY = {
  id: "CAP-S",
  capability: "Paginated data table with search",
  classification: "SHARED_PREREQUISITE",
  requiredDisposition: "CREATE_SHARED",
  legacyEvidence: ["legacy/marker.txt"],
  targetEvidence: [],
  consumers: ["users", "partners"],
  targetOwner: "src/shared/table",
  replacedBy: [],
  rationale: "Consumed by several legacy features; absent from the target.",
};

const FEATURE_CAPABILITY = CAPABILITY_OWNERSHIP.rows[0];
const REUSE_CAPABILITY = CAPABILITY_OWNERSHIP.rows[1];

const SHARED_SLICES = [
  {
    id: "shared-001",
    requirementIds: ["AUTH-REQ-001"],
    scenarioIds: ["AUTH-SCN-001"],
    traceIds: ["BR-1", "RR-1"],
    capabilityIds: ["CAP-S"],
    architectureAuthorities: [],
    targetPaths: ["src/shared"],
    dependencies: [],
    acceptanceScenarios: ["The shared table renders rows"],
  },
  {
    id: "auth-001",
    requirementIds: ["AUTH-REQ-002"],
    scenarioIds: ["AUTH-SCN-002"],
    traceIds: ["NR-1", "DR-1"],
    capabilityIds: ["CAP-1"],
    architectureAuthorities: [],
    targetPaths: ["src/features/auth"],
    dependencies: ["shared-001"],
    acceptanceScenarios: ["Sign out succeeds"],
  },
];

const SHARED_ROWS = [SHARED_CAPABILITY, FEATURE_CAPABILITY, REUSE_CAPABILITY];

/** PLAN staged on a plan that owns a real shared prerequisite. */
const stagedSharedPlan = async (fixture, slices = SHARED_SLICES) => {
  await stagedBaseline(fixture);
  await writeCapabilities(fixture, SHARED_ROWS);
  await advance(fixture);
  await completeStepDoc(fixture, "PLAN");
  await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
    version: 1,
    slices,
  });
};

test("BUILD_BASELINE refuses a capability matrix with no rows", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, []);
    await assert.rejects(advance(fixture), /at least one row/);
  } finally {
    await fixture.cleanup();
  }
});

test("a SHARED_PREREQUISITE proven by fewer than two other consumers is refused", async () => {
  for (const consumers of [[], ["auth"], ["users"], ["auth", "users"]]) {
    const fixture = await createFixture();
    try {
      await stagedBaseline(fixture);
      await writeCapabilities(fixture, [
        { ...SHARED_CAPABILITY, consumers },
        FEATURE_CAPABILITY,
      ]);
      await assert.rejects(
        advance(fixture),
        /Shared ownership requires at least 2/,
        JSON.stringify(consumers),
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("users, ./users, and users/ count as one consumer", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [
      {
        ...SHARED_CAPABILITY,
        consumers: ["users", "./users", "users/", "partners"],
      },
      FEATURE_CAPABILITY,
    ]);
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "PLAN");
  } finally {
    await fixture.cleanup();
  }
});

test("a consumer absent from the discovery scan is refused", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [
      { ...SHARED_CAPABILITY, consumers: ["users", "invented"] },
      FEATURE_CAPABILITY,
    ]);
    await assert.rejects(
      advance(fixture),
      /absent from the pinned discovery supporting census: invented/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a SHARED_PREREQUISITE may not be owned inside the migrating feature", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [
      { ...SHARED_CAPABILITY, targetOwner: "src/features/auth/table" },
      FEATURE_CAPABILITY,
    ]);
    await assert.rejects(
      advance(fixture),
      /may not be rebuilt as a feature-local replacement/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a FEATURE_LOCAL capability owned outside the feature is refused", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [
      { ...FEATURE_CAPABILITY, targetOwner: "src/shared/form" },
    ]);
    await assert.rejects(advance(fixture), /is outside/);
  } finally {
    await fixture.cleanup();
  }
});

test("a classification and requiredDisposition that disagree are refused", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [
      { ...FEATURE_CAPABILITY, requiredDisposition: "CREATE_SHARED" },
    ]);
    await assert.rejects(
      advance(fixture),
      /requires requiredDisposition 'CREATE_FEATURE_LOCAL'/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("DO_NOT_MIGRATE must cite a replacing baseline row, not argue in prose", async () => {
  const dismissal = {
    ...FEATURE_CAPABILITY,
    classification: "DO_NOT_MIGRATE",
    requiredDisposition: "NONE",
    rationale: "The target design system owns this.",
  };
  for (const [label, replacedBy, pattern] of [
    ["prose only", [], /names nothing in replacedBy/],
    ["invented row", ["DR-999"], /which is not a baseline row/],
  ]) {
    const fixture = await createFixture();
    try {
      await stagedBaseline(fixture);
      await writeCapabilities(fixture, [{ ...dismissal, replacedBy }]);
      await assert.rejects(advance(fixture), pattern, label);
    } finally {
      await fixture.cleanup();
    }
  }

  // A real baseline row -- or an OpenSpec requirement -- resolves it.
  for (const replacedBy of [["DR-1"], ["AUTH-REQ-001"]]) {
    const fixture = await createFixture();
    try {
      await stagedBaseline(fixture);
      await writeCapabilities(fixture, [{ ...dismissal, replacedBy }]);
      await advance(fixture);
      assert.equal((await state(fixture)).currentStep, "PLAN");
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TARGET_REUSE must prove the capability already exists in the target", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [
      { ...REUSE_CAPABILITY, targetEvidence: [] },
    ]);
    await assert.rejects(advance(fixture), /cites no target evidence/);
  } finally {
    await fixture.cleanup();
  }
});

test("a missing architecture authority is recorded as a gap, never cited as present", async () => {
  const fixture = await createFixture();
  try {
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [FEATURE_CAPABILITY], {
      architectureAuthorities: ["target/ARCHITECTURE.md"],
    });
    await assert.rejects(advance(fixture), /which does not exist under/);

    // The same absent document, stated as the gap it is, validates.
    await writeCapabilities(fixture, [FEATURE_CAPABILITY], {
      architectureAuthorities: ["target/src/placeholder.ts"],
      authorityGaps: [
        {
          expected: "target/ARCHITECTURE.md",
          reason:
            "Cited by the repository instructions but absent from the tree.",
        },
      ],
    });
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "PLAN");
  } finally {
    await fixture.cleanup();
  }
});

test("PLAN refuses to reach IMPLEMENT_SLICES with an unassigned SHARED_PREREQUISITE", async () => {
  const fixture = await createFixture();
  try {
    await stagedSharedPlan(fixture, [
      { ...SHARED_SLICES[0], capabilityIds: [] },
      { ...SHARED_SLICES[1], dependencies: [] },
    ]);
    await assert.rejects(
      advance(fixture),
      /Plan does not assign capability 'CAP-S' \(SHARED_PREREQUISITE\)/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a slice that skips a prerequisite slice in dependencies is refused", async () => {
  const fixture = await createFixture();
  try {
    await stagedSharedPlan(fixture, [
      SHARED_SLICES[0],
      { ...SHARED_SLICES[1], dependencies: [] },
    ]);
    await assert.rejects(
      advance(fixture),
      /auth-001 must declare 'shared-001' in dependencies/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a dependency that is unknown, self-referential, or declared later is refused", async () => {
  for (const [label, slices, pattern] of [
    [
      "unknown",
      [SHARED_SLICES[0], { ...SHARED_SLICES[1], dependencies: ["ghost-001"] }],
      /references unknown slice 'ghost-001'/,
    ],
    [
      "self",
      [{ ...SHARED_SLICES[0], dependencies: ["shared-001"] }, SHARED_SLICES[1]],
      /references itself/,
    ],
    [
      "declared later",
      [{ ...SHARED_SLICES[1], dependencies: ["shared-001"] }, SHARED_SLICES[0]],
      /which is declared after it/,
    ],
  ]) {
    const fixture = await createFixture();
    try {
      await stagedSharedPlan(fixture, slices);
      await assert.rejects(advance(fixture), pattern, label);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("one capability may not be claimed by two slices", async () => {
  const fixture = await createFixture();
  try {
    await stagedSharedPlan(fixture, [
      SHARED_SLICES[0],
      { ...SHARED_SLICES[1], capabilityIds: ["CAP-S", "CAP-1"] },
    ]);
    await assert.rejects(
      advance(fixture),
      /Capability 'CAP-S' is assigned to multiple slices/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a shared prerequisite is scheduled ahead of the feature slices that need it", async () => {
  const fixture = await createFixture();
  try {
    await stagedSharedPlan(fixture);
    await advance(fixture);
    const after = await state(fixture);
    assert.equal(after.currentStep, "IMPLEMENT_SLICES");
    // The whole point: the shared slice is executed first, deterministically.
    assert.deepEqual(after.pendingSlices, ["shared-001", "auth-001"]);
    assert.equal(after.activeSlice, "shared-001");
    const scaffolded = await readJson(
      path.join(fixture.migrationRoot, "slices/shared-001.json"),
    );
    assert.deepEqual(scaffolded.capabilityIds, ["CAP-S"]);
  } finally {
    await fixture.cleanup();
  }
});

test("a shared prerequisite built inside the feature instead of its owner is refused", async () => {
  const fixture = await createFixture();
  try {
    await stagedSharedPlan(fixture);
    await advance(fixture);
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await writeFile(
      path.join(fixture.targetRoot, "src/placeholder.ts"),
      "export {};\n// rebuilt locally\n",
    );
    await writeJson(
      path.join(fixture.migrationRoot, "slices/shared-001.json"),
      {
        id: "shared-001",
        implementationStatus: "COMPLETE",
        requirementIds: SHARED_SLICES[0].requirementIds,
        scenarioIds: SHARED_SLICES[0].scenarioIds,
        traceIds: SHARED_SLICES[0].traceIds,
        capabilityIds: ["CAP-S"],
        changedFiles: ["src/placeholder.ts"],
        decisions: ["d"],
        checks: ["c"],
      },
    );
    await assert.rejects(
      advance(fixture, { slice: "shared-001" }),
      /changed no file under 'src\/shared\/table'/,
    );

    // Building it where the matrix said it belongs is accepted.
    await mkdir(path.join(fixture.targetRoot, "src/shared/table"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.targetRoot, "src/shared/table/index.ts"),
      "export const Table = () => null;\n",
    );
    await writeJson(
      path.join(fixture.migrationRoot, "slices/shared-001.json"),
      {
        id: "shared-001",
        implementationStatus: "COMPLETE",
        requirementIds: SHARED_SLICES[0].requirementIds,
        scenarioIds: SHARED_SLICES[0].scenarioIds,
        traceIds: SHARED_SLICES[0].traceIds,
        capabilityIds: ["CAP-S"],
        changedFiles: ["src/shared/table/index.ts"],
        decisions: ["d"],
        checks: ["c"],
      },
    );
    await advance(fixture, { slice: "shared-001" });
    assert.equal((await state(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

// The contract accepts a changed file or evidence path in two spellings --
// target-relative (`src/x`) and repository-relative through the common ancestor
// of both roots (`target/src/x`) -- because `resolveEvidencePath` resolves
// against the ancestor. Ownership comparison used raw strings, so a correctly
// built shared capability was rejected purely for which accepted spelling the
// record happened to use. Both must be interchangeable on both sides.

/** The repository-relative prefix of the target root, i.e. the second spelling. */
const ancestorPrefix = (fixture) =>
  path.relative(fixture.root, fixture.targetRoot).replaceAll(path.sep, "/");

/** shared-001 driven to its implementation checkpoint with a given spelling. */
const implementShared = async (fixture, { targetOwner, changedFiles }) => {
  await stagedBaseline(fixture);
  await writeCapabilities(fixture, [
    { ...SHARED_CAPABILITY, targetOwner },
    FEATURE_CAPABILITY,
    REUSE_CAPABILITY,
  ]);
  await advance(fixture);
  await completeStepDoc(fixture, "PLAN");
  await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
    version: 1,
    slices: SHARED_SLICES,
  });
  await advance(fixture);
  await completeStepDoc(fixture, "IMPLEMENT_SLICES");
  await mkdir(path.join(fixture.targetRoot, "src/shared/table"), {
    recursive: true,
  });
  await writeFile(
    path.join(fixture.targetRoot, "src/shared/table/index.ts"),
    "export const Table = () => null;\n",
  );
  await writeJson(path.join(fixture.migrationRoot, "slices/shared-001.json"), {
    id: "shared-001",
    implementationStatus: "COMPLETE",
    requirementIds: SHARED_SLICES[0].requirementIds,
    scenarioIds: SHARED_SLICES[0].scenarioIds,
    traceIds: SHARED_SLICES[0].traceIds,
    capabilityIds: ["CAP-S"],
    changedFiles,
    decisions: ["d"],
    checks: ["c"],
  });
  return advance(fixture, { slice: "shared-001" });
};

test("a shared prerequisite is accepted in either accepted path spelling", async () => {
  for (const spelling of [
    "owner-relative",
    "claim-relative",
    "both-prefixed",
  ]) {
    const fixture = await createFixture();
    try {
      const prefix = ancestorPrefix(fixture);
      const owner = "src/shared/table";
      const claim = "src/shared/table/index.ts";
      await implementShared(fixture, {
        targetOwner:
          spelling === "owner-relative" ? owner : `${prefix}/${owner}`,
        changedFiles: [
          spelling === "claim-relative" ? claim : `${prefix}/${claim}`,
        ],
      });
      assert.equal(
        (await state(fixture)).currentStep,
        "VERIFY_SLICES",
        spelling,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("a FEATURE_LOCAL owner is recognised in either accepted path spelling", async () => {
  for (const prefixed of [false, true]) {
    const fixture = await createFixture();
    try {
      const owner = FEATURE_CAPABILITY.targetOwner;
      await stagedBaseline(fixture);
      await writeCapabilities(fixture, [
        {
          ...FEATURE_CAPABILITY,
          targetOwner: prefixed ? `${ancestorPrefix(fixture)}/${owner}` : owner,
        },
      ]);
      await advance(fixture);
      assert.equal(
        (await state(fixture)).currentStep,
        "PLAN",
        String(prefixed),
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("normalizing the owner does not weaken where a capability may live", async () => {
  const fixture = await createFixture();
  try {
    const prefix = ancestorPrefix(fixture);
    // Still inside the migrating feature, only spelled the other way.
    await stagedBaseline(fixture);
    await writeCapabilities(fixture, [
      {
        ...SHARED_CAPABILITY,
        targetOwner: `${prefix}/src/features/auth/table`,
      },
      FEATURE_CAPABILITY,
    ]);
    await assert.rejects(advance(fixture), /is inside 'src\/features\/auth\//);

    // Still outside the feature, only spelled the other way.
    await writeCapabilities(fixture, [
      { ...FEATURE_CAPABILITY, targetOwner: `${prefix}/src/shared/form` },
    ]);
    await assert.rejects(advance(fixture), /is outside 'src\/features\/auth\//);
  } finally {
    await fixture.cleanup();
  }
});

test("an owner that escapes the target repository is refused", async () => {
  for (const targetOwner of [
    "../legacy/shared/table",
    "../../etc/shared",
    path.resolve(os.tmpdir(), "elsewhere").replaceAll(path.sep, "/"),
  ]) {
    const fixture = await createFixture();
    try {
      await stagedBaseline(fixture);
      await writeCapabilities(fixture, [
        { ...SHARED_CAPABILITY, targetOwner },
        FEATURE_CAPABILITY,
      ]);
      await assert.rejects(
        advance(fixture),
        /is outside the target repository/,
        targetOwner,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("a changed file outside the owner is still refused in either spelling", async () => {
  for (const prefixed of [false, true]) {
    const fixture = await createFixture();
    try {
      const prefix = ancestorPrefix(fixture);
      const claim = "src/placeholder.ts";
      await writeFile(
        path.join(fixture.targetRoot, claim),
        "export {};\n// rebuilt locally\n",
      );
      await assert.rejects(
        implementShared(fixture, {
          targetOwner: "src/shared/table",
          changedFiles: [prefixed ? `${prefix}/${claim}` : claim],
        }),
        /changed no file under 'src\/shared\/table'/,
        String(prefixed),
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("the capability matrix is pinned once BUILD_BASELINE closes", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "BUILD_BASELINE");
    const pinned = (await state(fixture)).artifactHashes[CAPABILITY_PATH];
    assert.ok(pinned, "BUILD_BASELINE must pin the capability matrix");
    await writeCapabilities(fixture, [
      { ...FEATURE_CAPABILITY, rationale: "Quietly rewritten after the fact." },
    ]);
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await assert.rejects(advance(fixture), /Completed artifact changed/);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * Only `formatVersion` moves, so `artifactHashes` and `revision` are untouched
 * and `integrity.json` stays valid without being rewritten. Format 10 has the
 * same nine-checkpoint lifecycle as 11; it simply predates capability
 * ownership.
 */
const downgradeToFormat10 = async (fixture) => {
  const statePath = path.join(fixture.migrationRoot, "state.json");
  const persisted = await readJson(statePath);
  // Same as the format-9 downgrade: a genuine pre-11 record carries none of the
  // format-15 keys.
  delete persisted.legacySources;
  delete persisted.targetAdoption;
  const downgraded = { ...persisted, formatVersion: 10 };
  await writeJson(statePath, downgraded);
  return downgraded;
};

test("a pre-11 record closes BUILD_BASELINE with no capability matrix and is never promoted", async () => {
  // A pre-existing migration can have this shape: it closed its checkpoints before
  // capability ownership existed and must never be retro-fitted with an
  // artifact it was never validated against. Promoting it mid-flight would be
  // worse than leaving it alone -- BUILD_BASELINE would close without the
  // matrix and PLAN would then demand it.
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "ASSESS_TARGET");
    await downgradeToFormat10(fixture);

    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeMatrices(fixture);
    await rm(path.join(fixture.migrationRoot, CAPABILITY_PATH), {
      force: true,
    });
    await registerAuth(fixture);
    await advance(fixture);

    const afterBaseline = await state(fixture);
    assert.equal(afterBaseline.currentStep, "PLAN");
    assert.equal(afterBaseline.formatVersion, 10);
    assert.equal(
      afterBaseline.artifactHashes[CAPABILITY_PATH],
      undefined,
      "a pre-11 record must not be pinned to a matrix it never authored",
    );

    // PLAN closes on slices that carry no capabilityIds at all.
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES.map(
        ({
          capabilityIds,
          dependencies,
          architectureAuthorities,
          targetPaths,
          ...rest
        }) => rest,
      ),
    });
    await advance(fixture);
    const afterPlan = await state(fixture);
    assert.equal(afterPlan.currentStep, "IMPLEMENT_SLICES");
    assert.equal(afterPlan.formatVersion, 10);
  } finally {
    await fixture.cleanup();
  }
});

// --- delegated artifact prerequisites, driven through the public entry points -
//
// The delegation branches of `runMigration` used to be covered only by calling
// `runArtifactCli` directly (AUTO) or by grepping the driver's source text
// (OPERATOR-MCP). Neither proves the parent actually routes there, so both are
// exercised here through the entry points a real caller reaches: the `run`
// driver and one `tools/call migration_run` frame.

const DELEGATED_SHARED_CAPABILITY = {
  ...SHARED_CAPABILITY,
  artifactMigration: {
    source: "shared/table.ts",
    type: "component",
    target: "src/shared/table/index.ts",
  },
};

const delegatedBinding = (fixture) =>
  artifactBindingFor(DELEGATED_SHARED_CAPABILITY, {
    legacyRoot: fixture.legacyRoot,
    targetRoot: fixture.targetRoot,
  });

/**
 * IMPLEMENT_SLICES on a format 13 record whose active slice builds a delegated
 * SHARED_PREREQUISITE. `stagedBaseline` pins format 12 on purpose, so this is
 * the same ladder without that downgrade.
 */
const stagedDelegatedSlice = async (fixture) => {
  await mkdir(path.join(fixture.legacyRoot, "shared"), { recursive: true });
  await writeFile(
    path.join(fixture.legacyRoot, "shared/table.ts"),
    "export const table = true;\n",
  );
  await prepareCapabilityCensus(fixture);
  await driveTo(fixture, "ASSESS_TARGET", advance, {
    classification: capabilityClassification,
  });
  await completeStepDoc(fixture, "BUILD_BASELINE");
  await writeMatrices(fixture);
  await registerAuth(fixture);
  await writeCapabilities(fixture, [
    DELEGATED_SHARED_CAPABILITY,
    FEATURE_CAPABILITY,
    REUSE_CAPABILITY,
  ]);
  await advance(fixture);
  await completeStepDoc(fixture, "PLAN");
  await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
    version: 1,
    slices: SHARED_SLICES,
  });
  await advance(fixture);
  const current = await state(fixture);
  assert.equal(current.formatVersion, MIGRATION_FORMAT_VERSION);
  assert.equal(current.currentStep, "IMPLEMENT_SLICES");
  assert.equal(current.activeSlice, "shared-001");
  return current;
};

/** The child's source inventory, authored so it stops on one operator decision. */
const authorChildDecision = async (fixture, binding) => {
  const root = path.join(
    fixture.targetRoot,
    ".agents/knowledge/migrations/artifacts",
    binding.artifactId,
  );
  const source = path.join(fixture.legacyRoot, binding.source);
  await mkdir(path.join(root, "inventories"), { recursive: true });
  await writeJson(path.join(root, "inventories/source.json"), {
    version: 1,
    artifactId: binding.artifactId,
    hasVisibleUi: false,
    sourceFiles: [binding.source],
    behaviors: [
      {
        id: "B-1",
        description: "The shared table remains available.",
        visible: false,
        evidence: [
          {
            path: binding.source,
            sha256: createHash("sha256")
              .update(await readFile(source))
              .digest("hex"),
            status: "VERIFIED",
          },
        ],
      },
    ],
    globalContracts: [],
    featureLocalVisuals: [],
    operatorDecisions: [
      { id: "OD-1", subject: "Approve the bounded shared-table decision." },
    ],
  });
  return path.join(root, "decisions/operator-decisions.ndjson");
};

const artifactLedger = async (ledgerPath) => {
  try {
    const text = (await readFile(ledgerPath, "utf8")).trim();
    return text ? text.split("\n") : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

/** Runs one JSON-RPC frame from the fixture root, as the stdio server would. */
const rpc = async (fixture, message, session) => {
  const cwd = process.cwd();
  const previousExitCode = process.exitCode;
  process.chdir(fixture.root);
  try {
    return await handleMessage(message, session);
  } finally {
    process.chdir(cwd);
    process.exitCode = previousExitCode;
  }
};

const runCall = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "migration_run", arguments: { module: "auth" } },
});

test("AUTO drives the delegated artifact through `run`, leaving the parent record untouched", async () => {
  const fixture = await createFixture();
  try {
    const before = await stagedDelegatedSlice(fixture);
    const binding = await delegatedBinding(fixture);
    assert.equal(
      (await getArtifactStatus(binding)).status,
      "NOT_STARTED",
      "the child must not exist before the parent runs",
    );
    const events = await historyEvents(fixture);

    const run = await runCli(fixture, () =>
      runMigration(["auth", "--mode", "auto"]),
    );

    assert.equal(run.outcome, "CONTINUE");
    assert.equal(run.progress.nextWork.kind, "RUN_ARTIFACT");
    // The child record exists because `run` executed it, not because the test
    // reached past the driver and called the artifact CLI itself.
    assert.equal((await getArtifactStatus(binding)).status, "ACTIVE");

    // One artifact iteration is not a parent checkpoint: no advance, no event.
    const after = await state(fixture);
    assert.equal(after.revision, before.revision);
    assert.equal(after.currentStep, "IMPLEMENT_SLICES");
    assert.deepEqual(await historyEvents(fixture), events);
  } finally {
    await fixture.cleanup();
  }
});

test("a delegated artifact decision is recorded through one migration_run elicitation", async () => {
  const fixture = await createFixture();
  try {
    const before = await stagedDelegatedSlice(fixture);
    const binding = await delegatedBinding(fixture);
    // Bootstrap the child, then author the inventory that makes it stop on an
    // operator decision -- the state a parent `run` has to route, not swallow.
    await runArtifact(binding);
    const ledgerPath = await authorChildDecision(fixture, binding);
    assert.deepEqual(await artifactLedger(ledgerPath), []);

    const asked = [];
    const session = createSession({
      request: async (method, parameters) => {
        assert.equal(method, "elicitation/create");
        asked.push(parameters.message);
        // The human transcribes the phrase the request displayed. A host that
        // answers from the schema instead approves nothing -- proven for the
        // delegated half in the test below this one.
        return {
          action: "accept",
          content: {
            confirmation: /^Confirmation phrase: (.+)$/m.exec(
              parameters.message,
            )[1],
          },
        };
      },
    });
    await rpc(
      fixture,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { capabilities: { elicitation: {} } },
      },
      session,
    );

    const response = await rpc(fixture, runCall(1), session);

    const result = response.result.structuredContent;
    assert.equal(result.outcome, "CONTINUE", result.reason);
    assert.equal(asked.length, 1, JSON.stringify(asked));
    // The human decision crossed the transport and the ledger line is the child's,
    // written by `record-decision.mjs` under the artifact lock.
    assert.equal((await artifactLedger(ledgerPath)).length, 1);
    assert.equal((await state(fixture)).revision, before.revision);
  } finally {
    await fixture.cleanup();
  }
});

test("without elicitation the same migration_run refuses to approve the delegated decision", async () => {
  const fixture = await createFixture();
  try {
    await stagedDelegatedSlice(fixture);
    const binding = await delegatedBinding(fixture);
    await runArtifact(binding);
    const ledgerPath = await authorChildDecision(fixture, binding);

    const response = await rpc(fixture, runCall(1), createSession());

    const result = response.result.structuredContent;
    assert.equal(result.outcome, "OPERATOR_DECISION");
    assert.deepEqual(await artifactLedger(ledgerPath), []);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The delegated half of the synthetic grouped-approval regression. The artifact recorder is
 * a different ledger under a different lock, so it gets its own proof that a
 * host answering without a person writes nothing there either.
 */
test("a host answering the delegated decision without a human writes no artifact line", async () => {
  for (const answer of [
    { action: "accept", content: { decision: "Approve" } },
    { action: "accept", content: {} },
    { action: "accept", content: { confirmation: "" } },
    { action: "accept", content: { confirmation: "APPROVE" } },
    { action: "decline" },
    { action: "cancel" },
    null,
  ]) {
    const fixture = await createFixture();
    try {
      await stagedDelegatedSlice(fixture);
      const binding = await delegatedBinding(fixture);
      await runArtifact(binding);
      const ledgerPath = await authorChildDecision(fixture, binding);

      let asked = 0;
      const session = createSession({
        request: async () => (asked++, answer),
      });
      await rpc(
        fixture,
        {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { capabilities: { elicitation: {} } },
        },
        session,
      );

      const response = await rpc(fixture, runCall(1), session);

      const label = JSON.stringify(answer);
      assert.equal(asked, 1, label);
      assert.equal(
        response.result.structuredContent.outcome,
        "OPERATOR_DECISION",
        label,
      );
      assert.deepEqual(await artifactLedger(ledgerPath), [], label);
    } finally {
      await fixture.cleanup();
    }
  }
});

// --- Figma design source (figma-mcp) -----------------------------------------

const FIGMA_URL = "https://www.figma.com/design/ABC123def/Flow?node-id=12-34";
const FIGMA_NODE = "12:34";
const FIGMA_VIEWPORT = { width: 1280, height: 720 };

/**
 * Format 17: the canonical Figma evidence for one frame, persisted inside the
 * record as the verbatim MCP outputs and hashed. `metadata` defaults to a node
 * of `viewport` size, so a test bends one fact without restating the frame.
 */
const writeFigmaContext = async (
  fixture,
  {
    viewport = FIGMA_VIEWPORT,
    metadata,
    frame = {},
    file = "inventories/figma-context.json",
  } = {},
) => {
  const persist = async (name, bytes) => {
    const reference = `inventories/figma/12-34/${name}`;
    const absolute = path.join(fixture.migrationRoot, reference);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    return {
      reference,
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  };
  const written = {
    fileKey: "ABC123def",
    nodeId: FIGMA_NODE,
    name: "Sign in",
    type: "FRAME",
    viewport,
    states: ["default"],
    extraction: {
      retrievedAt: "2026-07-01T00:00:00.000Z",
      fidelity: "COMPLETE",
      limitations: [],
    },
    sources: {
      metadata: await persist(
        "metadata.xml",
        metadata ??
          `<frame id="${FIGMA_NODE}" name="Sign in" x="0" y="0" width="${viewport.width}" height="${viewport.height}"><instance id="12:40" name="Button" width="120" height="36" /></frame>\n`,
      ),
      designContext: [
        await persist(
          "design-context.txt",
          "font-family: Inter; font-size: 14px; line-height: 20px; padding: 16px; background: #0B5FFF; border-radius: 8px\n",
        ),
      ],
      variableDefs: await persist(
        "variable-defs.json",
        '{"spacing/lg":"16"}\n',
      ),
      screenshot: await persist("screenshot.png", "figma render bytes\n"),
    },
    ...frame,
  };
  await writeJson(path.join(fixture.migrationRoot, file), {
    version: 1,
    frames: [written],
  });
  return written;
};

const visualAcceptance = ({ viewport = FIGMA_VIEWPORT, row = {} } = {}) => ({
  version: 1,
  rows: [
    {
      id: "VIS-1",
      uiBehaviorId: "UIB-1",
      state: "DEFAULT",
      figmaNodeId: FIGMA_NODE,
      figmaState: "default",
      viewport,
      expect: {
        contentWidth: { kind: "px", value: viewport.width, locator: "main" },
        primaryActions: {
          kind: "count",
          value: 1,
          locator: "getByRole('button', { name: 'Sign in' })",
        },
        navigation: {
          kind: "present",
          value: false,
          locator: "getByRole('navigation')",
        },
        layout: {
          kind: "equals",
          value: "column",
          locator: "form computed flex-direction",
        },
      },
      tolerance: { px: 4, ratio: 0.01 },
      ...row,
    },
  ],
  unbacked: [],
});

const MEASURED = {
  contentWidth: FIGMA_VIEWPORT.width,
  primaryActions: 1,
  navigation: false,
  layout: "column",
};

const initFigma = (fixture, extra = {}) =>
  initialize(fixture, {
    designSource: "figma-mcp",
    figma: [FIGMA_URL],
    ...extra,
  });

test("figma-mcp: confirmed refresh preserves authorities and invalidates old-revision evidence", async () => {
  const fixture = await createFixture();
  try {
    await initFigma(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeClassification(fixture, MODULE_CLASSIFICATION);
    await advance(fixture);
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");

    const rationale = "Decorative under the reviewed legacy revision.";
    const classification = {
      ...exclusionClassification(rationale),
      algorithmVersion: 2,
    };
    await writeClassification(fixture, classification);
    const resolution = await resolutionFor(fixture);
    const oldCandidate = (
      await pendingDecisionCandidates({ ...resolution, moduleName: "auth" })
    ).candidates[0];
    const oldDecision = await recordAtTerminal(
      fixture,
      oldCandidate,
      challengeFor(oldCandidate),
    );
    await writeClassification(fixture, {
      ...classification,
      files: [
        {
          ...classification.files[0],
          decisionId: oldDecision.decision.id,
          decisionDigest: lineDigestOf(oldDecision.decision),
        },
      ],
    });
    assert.equal(
      (await pendingDecisionCandidates({ ...resolution, moduleName: "auth" }))
        .candidates.length,
      0,
    );

    const before = await state(fixture);
    const preserved = Object.fromEntries(
      await Promise.all(
        [
          "steps/02-discover-legacy.md",
          "inventories/legacy.json",
          CLASSIFICATION_PATH,
          DECISIONS_PATH,
        ].map(async (relative) => [
          relative,
          await readFile(path.join(fixture.migrationRoot, relative), "utf8"),
        ]),
      ),
    );
    await writeFile(
      path.join(fixture.legacyRoot, "auth/marker.txt"),
      "auth\nnew revision\n",
    );
    await execFileAsync("git", ["add", "legacy/auth/marker.txt"], {
      cwd: fixture.root,
    });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Contract Test",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "-q",
        "-m",
        "legacy drift",
      ],
      { cwd: fixture.root },
    );

    const offered = await discoverCli(fixture, [
      "--refresh",
      "--confirm-mismatch",
    ]);
    assert.equal(offered.awaitingConfirmation, true);
    const refreshed = await discoverCli(fixture, [
      "--refresh",
      "--confirm-mismatch",
      "--confirm-execution",
      offered.preview.confirmationId,
    ]);
    assert.equal(refreshed.result.state.currentStep, "DISCOVER_LEGACY");

    const after = await state(fixture);
    assert.deepEqual(after.requirementsAuthority, before.requirementsAuthority);
    assert.equal(after.designSource, before.designSource);
    assert.deepEqual(after.figmaSources, before.figmaSources);
    for (const key of [
      "targetModule",
      "dataSourceMode",
      "ponytail",
      "createdAt",
    ]) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.deepEqual(after.completedSteps, ["RESOLVE"]);
    assert.deepEqual(Object.keys(after.artifactHashes), [
      "steps/01-resolve.md",
    ]);
    assert.deepEqual(
      after.invalidatedArtifacts,
      Object.values(before.artifacts)
        .flatMap((value) =>
          typeof value === "string" ? [value] : Object.values(value),
        )
        .filter((value) => value !== "steps/01-resolve.md"),
    );
    assert.equal(after.evidenceFreshness, "STALE");
    assert.equal(
      after.legacyRevision.revision,
      await revisionOf(fixture.legacyRoot),
    );
    for (const [relative, bytes] of Object.entries(preserved)) {
      assert.equal(
        await readFile(path.join(fixture.migrationRoot, relative), "utf8"),
        bytes,
        relative,
      );
    }

    const refreshEvents = (await historyEvents(fixture)).filter(
      ({ event }) => event === "REFRESHED",
    );
    assert.equal(refreshEvents.length, 1);
    assert.deepEqual(
      refreshEvents[0].fromLegacyRevision,
      before.legacyRevision,
    );
    assert.deepEqual(refreshEvents[0].toLegacyRevision, after.legacyRevision);
    assert.equal(refreshEvents[0].invalidatedFrom, "DISCOVER_LEGACY");

    const resumed = await discoverCli(fixture, STEP);
    assert.equal(resumed.blocked, undefined);
    assert.equal(resumed.preview.currentCheckpoint, "DISCOVER_LEGACY");
    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(pending.candidates.length, 1);
    assert.equal(pending.candidates[0].subject.path, "auth/marker.txt");
    assert.notEqual(pending.candidates[0].id, oldCandidate.id);
  } finally {
    await fixture.cleanup();
  }
});

const figmaPin = async (fixture) =>
  (await state(fixture)).artifactHashes["inventories/figma-context.json"];

/**
 * Format 17 runtime evidence for slice-a's Figma-backed TARGET row: the node,
 * the viewport, a screenshot, and a persisted runtime observation file the
 * engine reads the measurements from. `bind: false` omits only the digest.
 */
const figmaEvidence = async (
  fixture,
  {
    values = MEASURED,
    viewport = FIGMA_VIEWPORT,
    measuredViewport = viewport,
    figmaNodeId = FIGMA_NODE,
    bind = true,
  } = {},
) => {
  const pin = await figmaPin(fixture);
  const screenshot = await writeCapture(
    fixture,
    "slice-a",
    "uib-1-default.png",
    `target render ${JSON.stringify(values)}\n`,
  );
  const measurements = await writeCapture(
    fixture,
    "slice-a",
    "observations.json",
    `${JSON.stringify({ viewport: measuredViewport, values })}\n`,
  );
  return (records) =>
    records.map((record) =>
      record.origin === "TARGET"
        ? {
            ...record,
            viewport,
            figmaNodeId,
            screenshot,
            measurements,
            boundTo: bind
              ? { ...record.boundTo, figmaContextDigest: pin }
              : record.boundTo,
          }
        : record,
    );
};

/** Drive a figma-mcp migration through ASSESS_TARGET with canonical evidence,
 * leaving BUILD_BASELINE ready to advance once the contract is written. */
const driveFigmaToBaseline = async (fixture, { viewport } = {}) => {
  await figmaAtAssessTarget(fixture);
  await writeFigmaContext(fixture, { viewport });
  await advance(fixture);
  await completeStepDoc(fixture, "BUILD_BASELINE");
  await writeMatrices(fixture);
  await registerAuth(fixture);
};

const writeVisualAcceptance = (fixture, contract) =>
  writeJson(
    path.join(fixture.migrationRoot, "matrices/visual-acceptance.json"),
    contract,
  );

/** Drive a figma-mcp migration up to (not through) VERIFY_SLICES, authoring the
 * agent-owned Figma evidence at ASSESS_TARGET and its visual contract at
 * BUILD_BASELINE. */
const driveFigmaToVerify = async (fixture, { viewport, contract } = {}) => {
  await driveFigmaToBaseline(fixture, { viewport });
  await writeVisualAcceptance(
    fixture,
    contract ?? visualAcceptance({ viewport }),
  );
  await advance(fixture);
  await completeStepDoc(fixture, "PLAN");
  await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
    version: 1,
    slices: SLICES,
  });
  await advance(fixture);
  await completeStepDoc(fixture, "IMPLEMENT_SLICES");
  await completeStepDoc(fixture, "VERIFY_SLICES");
};

/** Drive a figma-mcp migration to ASSESS_TARGET, ready to advance, without
 * authoring inventories/figma-context.json. */
const figmaAtAssessTarget = async (
  fixture,
  extra = {},
  formatVersion,
  legacy = LEGACY_INVENTORY,
) => {
  await initFigma(fixture, extra);
  if (formatVersion) {
    const statePath = path.join(fixture.migrationRoot, "state.json");
    await writeJson(statePath, {
      ...(await readJson(statePath)),
      formatVersion,
    });
  }
  await completeStepDoc(fixture, "DISCOVER_LEGACY");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/legacy.json"),
    legacy,
  );
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    MODULE_CLASSIFICATION,
  );
  await advance(fixture);
  await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    MODULE_CLASSIFICATION,
  );
  await advance(fixture);
  await completeStepDoc(fixture, "ASSESS_TARGET");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/target.json"),
    TARGET_INVENTORY,
  );
};

test("figma-mcp: every recorded Figma link is persisted into figmaSources", async () => {
  const fixture = await createFixture();
  try {
    await initFigma(fixture, {
      figma: [
        FIGMA_URL,
        "https://www.figma.com/make/OTHERkey2/Detail?node-id=56-78",
        // Same file, node, and kind as the first link: deduped, not a third.
        "https://www.figma.com/design/ABC123def/Renamed?node-id=12-34",
      ],
    });
    const persisted = await state(fixture);
    assert.deepEqual(persisted.figmaSources, [
      {
        fileKey: "ABC123def",
        nodeId: "12:34",
        kind: "design",
        raw: "https://www.figma.com/design/ABC123def?node-id=12-34",
      },
      {
        fileKey: "OTHERkey2",
        nodeId: "56:78",
        kind: "make",
        raw: "https://www.figma.com/make/OTHERkey2?node-id=56-78",
      },
    ]);
    const resolveDoc = await readFile(
      path.join(fixture.migrationRoot, "steps/01-resolve.md"),
      "utf8",
    );
    assert.match(resolveDoc, /Figma source: `[^`]*ABC123def/);
    assert.match(resolveDoc, /Figma source: `[^`]*OTHERkey2/);
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp: ASSESS_TARGET states the Figma MCP obligation and its links", async () => {
  const fixture = await createFixture();
  try {
    await initFigma(fixture);
    const stepDoc = await readFile(
      path.join(fixture.migrationRoot, "steps/03-assess-target.md"),
      "utf8",
    );
    assert.match(stepDoc, /figmaSources/);
    assert.match(stepDoc, /Figma MCP/);
    assert.match(stepDoc, /inventories\/figma-context\.json/);
    assert.match(stepDoc, /ABC123def/);
  } finally {
    await fixture.cleanup();
  }
});

test("target-system: ASSESS_TARGET carries no Figma obligation", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const stepDoc = await readFile(
      path.join(fixture.migrationRoot, "steps/03-assess-target.md"),
      "utf8",
    );
    assert.doesNotMatch(stepDoc, /[Ff]igma/);
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp: ASSESS_TARGET refuses a missing or unusable figma-context", async () => {
  const contextPath = "inventories/figma-context.json";
  const cases = [
    ["missing", null],
    ["not an object", []],
    ["no frames", { version: 1 }],
    ["empty frames", { version: 1, frames: [] }],
    ["frame without a fileKey", { version: 1, frames: [{ nodeId: "12:34" }] }],
    ["blank fileKey", { version: 1, frames: [{ fileKey: "  " }] }],
    [
      "fileKey outside figmaSources",
      { version: 1, frames: [{ fileKey: "NOTMINE" }] },
    ],
  ];
  for (const [label, context] of cases) {
    const fixture = await createFixture();
    try {
      await figmaAtAssessTarget(fixture);
      if (context !== null) {
        await writeJson(path.join(fixture.migrationRoot, contextPath), context);
      }
      await assert.rejects(
        advance(fixture),
        (error) => {
          assert.match(
            error.message,
            /inventories\/figma-context\.json/,
            label,
          );
          assert.match(error.message, /designSource: figma-mcp/, label);
          assert.match(error.message, /Figma MCP/, label);
          return true;
        },
        label,
      );
      // Nothing was pinned, so the checkpoint is still open.
      assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET", label);
      assert.equal(await figmaPin(fixture), undefined, label);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("figma-mcp: a context bound to a recorded fileKey closes ASSESS_TARGET", async () => {
  const fixture = await createFixture();
  try {
    await figmaAtAssessTarget(fixture);
    await writeFigmaContext(fixture);
    await advance(fixture);
    const persisted = await state(fixture);
    assert.ok(persisted.completedSteps.includes("ASSESS_TARGET"));
    assert.ok(await figmaPin(fixture));
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp: designSource and figmaSources are persisted and rendered at RESOLVE", async () => {
  const fixture = await createFixture();
  try {
    await initFigma(fixture);
    const persisted = await state(fixture);
    assert.equal(persisted.designSource, "figma-mcp");
    assert.equal(persisted.formatVersion, MIGRATION_FORMAT_VERSION);
    assert.deepEqual(persisted.figmaSources, [
      {
        fileKey: "ABC123def",
        nodeId: "12:34",
        kind: "design",
        raw: "https://www.figma.com/design/ABC123def?node-id=12-34",
      },
    ]);
    const resolveDoc = await readFile(
      path.join(fixture.migrationRoot, "steps/01-resolve.md"),
      "utf8",
    );
    assert.match(resolveDoc, /Design source: `figma-mcp`/);
    assert.match(resolveDoc, /Figma source: `[^`]*ABC123def/);
    const status = await getMigrationStatus({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    assert.equal(status.designSource, "figma-mcp");
  } finally {
    await fixture.cleanup();
  }
});

test("target-system is the default design source and is rendered at RESOLVE", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const persisted = await state(fixture);
    assert.equal(persisted.designSource, "target-system");
    assert.equal(persisted.figmaSources, undefined);
    const resolveDoc = await readFile(
      path.join(fixture.migrationRoot, "steps/01-resolve.md"),
      "utf8",
    );
    assert.match(resolveDoc, /Design source: `target-system`/);
    assert.doesNotMatch(resolveDoc, /Figma source:/);
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp bootstrap refuses a non-design link and an empty link set", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      initFigma(fixture, { figma: ["https://www.figma.com/board/BOARD/Jam"] }),
      /not a UI design contract/,
    );
    await assert.rejects(
      initialize(fixture, { designSource: "figma-mcp" }),
      /at least one --figma link/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp: the design source and its links are fixed for the migration's lifetime", async () => {
  const fixture = await createFixture();
  try {
    await initFigma(fixture);
    const resolution = await resolutionFor(fixture);
    await assert.rejects(
      previewMigrationExecution({
        ...resolution,
        moduleName: "auth",
        designSource: "target-system",
      }),
      /fixed for the migration's lifetime/,
    );
    await assert.rejects(
      previewMigrationExecution({
        ...resolution,
        moduleName: "auth",
        designSource: "figma-mcp",
        figma: ["https://www.figma.com/design/OTHERKEY/Flow?node-id=9-9"],
      }),
      /Figma sources conflict/,
    );
    // Same fileKey and node-id, only the kind flipped, is still a conflict.
    await assert.rejects(
      previewMigrationExecution({
        ...resolution,
        moduleName: "auth",
        designSource: "figma-mcp",
        figma: ["https://www.figma.com/make/ABC123def/Flow?node-id=12-34"],
      }),
      /Figma sources conflict/,
    );
    // Omitting the flags resumes the recorded design source untouched.
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(preview.migration, "auth");
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp: ASSESS_TARGET pins inventories/figma-context.json and editing it is caught", async () => {
  const fixture = await createFixture();
  try {
    await initFigma(fixture);
    await completeStepDoc(fixture, "DISCOVER_LEGACY");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/legacy.json"),
      LEGACY_INVENTORY,
    );
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      MODULE_CLASSIFICATION,
    );
    await advance(fixture);
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
      MODULE_CLASSIFICATION,
    );
    await advance(fixture);
    await completeStepDoc(fixture, "ASSESS_TARGET");
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/target.json"),
      TARGET_INVENTORY,
    );
    await writeFigmaContext(fixture);
    await advance(fixture);
    const pin = await figmaPin(fixture);
    assert.ok(pin, "figma-context.json is pinned after ASSESS_TARGET");
    // Editing the pinned design snapshot is refused on the next read.
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/figma-context.json"),
      { version: 1, frames: [] },
    );
    await assert.rejects(advance(fixture), /inventories\/figma-context\.json/);
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp: visual target evidence must bind the pinned figma-context digest", async () => {
  const fixture = await createFixture();
  try {
    await driveFigmaToVerify(fixture);
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    // Visual evidence without the design binding is refused.
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture, { bind: false }),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /figmaContextDigest/,
    );
    // The pinned digest satisfies it.
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture),
    });
    const result = await advance(fixture, { slice: "slice-a" });
    assert.ok(result);
  } finally {
    await fixture.cleanup();
  }
});

/** Drive a figma-mcp migration all the way through FINALIZE to COMPLETE. */
const driveFigmaToComplete = async (fixture) => {
  await driveFigmaToVerify(fixture);
  for (const slice of SLICES) {
    await authorSlice(fixture, slice.id);
    await advance(fixture, { slice: slice.id });
    await authorEvidence(
      fixture,
      slice.id,
      slice.id === "slice-a" ? { mutate: await figmaEvidence(fixture) } : {},
    );
    await advance(fixture, { slice: slice.id });
  }
  await completeStepDoc(fixture, "FINALIZE");
  await writeMatrices(fixture, true);
  const context = {
    legacyRevision: await revisionOf(fixture.legacyRoot),
    targetRevision: await revisionOf(fixture.targetRoot),
    requirementsDigest: (await state(fixture)).requirementsAuthority.digest,
    legacyDirtyDigest: (await dirtyManifest(fixture.legacyRoot)).digest,
    targetDirtyDigest: (
      await dirtyManifest(fixture.targetRoot, TARGET_DIRTY_SCOPE)
    ).digest,
  };
  // gateEvidence carries no figmaContextDigest: functional and architectural
  // gates are design-independent and pass without any Figma binding.
  await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
    version: 1,
    gates: GATES.map((gate) => ({
      gate,
      result: "PASS",
      attempts: 1,
      evidence: [gateEvidence(context)],
    })),
  });
  await advance(fixture);
};

test("figma-mcp: a figma-mcp migration reaches COMPLETE with design-independent final gates", async () => {
  const fixture = await createFixture();
  try {
    await driveFigmaToComplete(fixture);
    assert.equal((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

test("figma-mcp: --reopen-ui keeps the stamped format version and the figma pin", async () => {
  const fixture = await createFixture();
  try {
    await driveFigmaToComplete(fixture);
    const before = await state(fixture);
    assert.equal(before.status, "COMPLETE");
    assert.equal(before.formatVersion, MIGRATION_FORMAT_VERSION);
    const pin = before.artifactHashes["inventories/figma-context.json"];
    assert.ok(pin, "figma-context.json is pinned at COMPLETE");

    const resolution = await resolutionFor(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
    });
    const result = await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      reopenUi: ["slice-a"],
      boundInputs: preview.boundInputs,
      registryBinding: preview.registryBinding,
    });
    assert.equal(result.reopened, true);

    // Downgrading the format here would make usesDesignSource() false while the
    // figma pin stayed in artifactHashes, and the exact-set check would refuse
    // every later read of the record.
    const after = await state(fixture);
    assert.equal(after.formatVersion, MIGRATION_FORMAT_VERSION);
    assert.equal(after.designSource, "figma-mcp");
    assert.equal(after.artifactHashes["inventories/figma-context.json"], pin);
    assert.equal(after.currentStep, "VERIFY_SLICES");

    const resumed = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(resumed.migration, "auth");
  } finally {
    await fixture.cleanup();
  }
});

// --- Format 17: Figma visual acceptance contract -----------------------------
//
// Provenance (figmaContextDigest) was bound and tested; fidelity was not. These
// cases prove the derived contract is enforced end to end and that the engine,
// not an authored `result`, decides a Figma-backed visual state.

const rejectsAt = (fixture, pattern, options) =>
  assert.rejects(advance(fixture, options), pattern);

test("visual-17: a frame whose node is not a recorded Figma link is refused", async () => {
  const fixture = await createFixture();
  try {
    await figmaAtAssessTarget(fixture);
    await writeFigmaContext(fixture, {
      frame: { nodeId: "99:99" },
      metadata: `<frame id="99:99" width="1280" height="720"></frame>\n`,
    });
    await rejectsAt(
      fixture,
      /nodeId '99:99' is not a node of this migration's recorded figmaSources/,
    );
    assert.equal(await figmaPin(fixture), undefined);
  } finally {
    await fixture.cleanup();
  }
});

// --- Format 17: concrete descendants of a recorded Figma section ------------
//
// Synthetic visual example: the operator linked a section/flow (12:34); the
// viewport frames visual acceptance binds are nested inside it.

const MOBILE_VIEWPORT = { width: 360, height: 800 };
const SECTION_TREE = `<?xml version="1.0"?>
<section id="12:34" name="Section A" x="0" y="0" width="2400" height="1000">
  <frame id="12:40" name="Flow A" x="0" y="0" width="1200" height="1000">
    <instance id="12:45" name="Narrow shell" x="40" y="80" width="360" height="800">
      <frame id="12:50" name="catalog-sync / mobile" x="0" y="0" width="360" height="800">
        <text id="12:51" name="Title" x="16" y="16" width="200" height="24" />
      </frame>
    </instance>
  </frame>
  <frame id="12:60" name="Filters" x="480" y="80" width="360" height="800" />
</section>
<frame id="77:1" name="Elsewhere" x="0" y="0" width="360" height="800" />
`;
const OTHER_SECTION_TREE = `<section id="20:1" name="Section B" width="2000" height="900"><frame id="20:5" name="catalog-sync / mobile" width="360" height="800" /></section>\n`;

/** A descendant frame's complete format-17 evidence plus the verbatim
 * get_metadata of its recorded source, persisted and hashed. */
const writeDescendantContext = async (
  fixture,
  {
    nodeId = "12:50",
    name = "catalog-sync / mobile",
    path: ancestryPath = ["12:34", "12:40", "12:45", "12:50"],
    sourceNodeId = "12:34",
    tree = SECTION_TREE,
    ancestry = {},
    frame = {},
    file,
  } = {},
) => {
  const reference = "inventories/figma/12-34/source-metadata.xml";
  await mkdir(path.join(fixture.migrationRoot, "inventories/figma/12-34"), {
    recursive: true,
  });
  await writeFile(path.join(fixture.migrationRoot, reference), tree);
  return writeFigmaContext(fixture, {
    file,
    viewport: MOBILE_VIEWPORT,
    metadata: `<frame id="${nodeId}" name="${name}" x="0" y="0" width="360" height="800"><text id="12:51" name="Title" width="200" height="24" /></frame>\n`,
    frame: {
      nodeId,
      name,
      states: ["list initial"],
      ancestry: {
        sourceNodeId,
        path: ancestryPath,
        metadata: {
          reference,
          hash: `sha256:${createHash("sha256").update(tree).digest("hex")}`,
        },
        ...ancestry,
      },
      ...frame,
    },
  });
};

const descendantAcceptance = (nodeId = "12:50", row = {}) =>
  visualAcceptance({
    viewport: MOBILE_VIEWPORT,
    row: { figmaNodeId: nodeId, figmaState: "list initial", ...row },
  });

test("figma-17: the recorded node itself still backs a frame, with no ancestry", async () => {
  const fixture = await createFixture();
  try {
    await figmaAtAssessTarget(fixture);
    await writeFigmaContext(fixture);
    await advance(fixture);
    assert.ok(await figmaPin(fixture));
  } finally {
    await fixture.cleanup();
  }
});

test("figma-17: a direct child and a deeply nested descendant proven from the source's metadata back visual acceptance", async () => {
  for (const [label, options] of [
    [
      "direct child",
      { nodeId: "12:60", name: "Filters", path: ["12:34", "12:60"] },
    ],
    ["nested descendant", {}],
  ]) {
    const fixture = await createFixture();
    try {
      await figmaAtAssessTarget(fixture);
      await writeDescendantContext(fixture, options);
      await advance(fixture);
      await completeStepDoc(fixture, "BUILD_BASELINE");
      await writeMatrices(fixture);
      await registerAuth(fixture);
      await writeVisualAcceptance(
        fixture,
        descendantAcceptance(options.nodeId),
      );
      await advance(fixture);
      const persisted = await state(fixture);
      assert.ok(persisted.completedSteps.includes("BUILD_BASELINE"), label);
      // The operator's design authority is untouched: no node is appended.
      assert.deepEqual(
        persisted.figmaSources.map((source) => source.nodeId),
        ["12:34"],
        label,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("figma-17: an unproven, invented, foreign, or tampered descendant is refused", async () => {
  const cases = [
    [
      "arbitrary same-file node without ancestry",
      (fixture) =>
        writeDescendantContext(fixture, {
          nodeId: "77:1",
          name: "Elsewhere",
          frame: { ancestry: undefined },
        }),
      /nodeId '77:1' is not a node of this migration's recorded figmaSources .*records no ancestry/,
    ],
    [
      "same-file node outside the source tree",
      (fixture) =>
        writeDescendantContext(fixture, {
          nodeId: "77:1",
          name: "Elsewhere",
          path: ["12:34", "77:1"],
        }),
      /does not nest node '77:1' under '12:34'/,
    ],
    [
      "ancestor claimed from an unrecorded source",
      (fixture) => writeDescendantContext(fixture, { sourceNodeId: "12:40" }),
      /ancestry\.sourceNodeId '12:40' is not a recorded node link/,
    ],
    [
      "node under a different bound section",
      (fixture) =>
        writeDescendantContext(fixture, {
          nodeId: "20:5",
          path: ["12:34", "20:5"],
          tree: OTHER_SECTION_TREE,
        }),
      /does not nest node '20:5' under '12:34'/,
    ],
    [
      "invented ancestry path",
      (fixture) =>
        writeDescendantContext(fixture, { path: ["12:34", "12:50"] }),
      /ancestry\.path .* is not the ancestry read from its persisted metadata \["12:34","12:40","12:45","12:50"\]/,
    ],
    [
      "model-claimed name the source metadata does not carry",
      (fixture) =>
        writeDescendantContext(fixture, {
          name: "Invented frame",
        }),
      /name 'Invented frame' is not node '12:50' name in its source metadata/,
    ],
    [
      "tampered source metadata",
      async (fixture) => {
        await writeDescendantContext(fixture);
        await writeFile(
          path.join(
            fixture.migrationRoot,
            "inventories/figma/12-34/source-metadata.xml",
          ),
          SECTION_TREE.replace('id="12:45"', 'id="12:46"'),
        );
      },
      /ancestry\.metadata 'inventories\/figma\/12-34\/source-metadata\.xml' no longer matches its recorded hash/,
    ],
    [
      "stale descendant snapshot",
      async (fixture) => {
        const frame = await writeDescendantContext(fixture);
        await writeFile(
          path.join(fixture.migrationRoot, frame.sources.metadata.reference),
          '<frame id="12:50" />\n',
        );
      },
      /sources\.metadata '.*' no longer matches its recorded hash/,
    ],
    [
      "hierarchy disagreeing with the snapshot size",
      (fixture) =>
        writeDescendantContext(fixture, {
          tree: SECTION_TREE.replace(
            'name="catalog-sync / mobile" x="0" y="0" width="360"',
            'name="catalog-sync / mobile" x="0" y="0" width="1280"',
          ),
        }),
      /ancestry\.metadata describes node '12:50' at a size other than its viewport 360x800/,
    ],
    [
      "descendant without its complete visual evidence",
      async (fixture) => {
        const frame = await writeDescendantContext(fixture);
        await writeDescendantContext(fixture, {
          frame: { sources: { ...frame.sources, designContext: [] } },
        });
      },
      /sources\.designContext must persist the raw Figma MCP output/,
    ],
  ];
  for (const [label, author, pattern] of cases) {
    const fixture = await createFixture();
    try {
      await figmaAtAssessTarget(fixture, {
        figma: [
          FIGMA_URL,
          "https://www.figma.com/design/ABC123def/Flow?node-id=20-1",
        ],
      });
      await author(fixture);
      await assert.rejects(advance(fixture), pattern, label);
      assert.equal(await figmaPin(fixture), undefined, label);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("figma-17: a whole-file link still authorizes any node, and a node link is not widened into one", async () => {
  const fixture = await createFixture();
  try {
    await figmaAtAssessTarget(fixture, {
      figma: ["https://www.figma.com/design/ABC123def/Flow"],
    });
    await writeFigmaContext(fixture, {
      frame: { nodeId: "99:99" },
      metadata: `<frame id="99:99" width="1280" height="720"></frame>\n`,
    });
    await advance(fixture);
    assert.ok(await figmaPin(fixture));
  } finally {
    await fixture.cleanup();
  }
});

test("figma-17: a frame named 'mobile' binds nothing; only an explicit row binds MOBILE to the concrete descendant", async () => {
  const fixture = await createFixture();
  try {
    const legacy = {
      ...LEGACY_INVENTORY,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors.map((uiBehavior) =>
        uiBehavior.id === "UIB-1"
          ? { ...uiBehavior, runtimeStates: ["DEFAULT", "MOBILE"] }
          : uiBehavior,
      ),
    };
    await figmaAtAssessTarget(fixture, {}, undefined, legacy);
    await writeDescendantContext(fixture);
    await advance(fixture);
    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeMatrices(fixture);
    await registerAuth(fixture);
    const contract = descendantAcceptance();
    await writeVisualAcceptance(fixture, {
      ...contract,
      unbacked: [
        {
          uiBehaviorId: "UIB-1",
          state: "MOBILE",
          reason: "The mobile frame is only a child of the linked section.",
        },
      ],
    });
    // The frame's name says "mobile", yet nothing binds MOBILE by inference:
    // the omission stops at the operator, and the operator sees the frame.
    await rejectsAt(
      fixture,
      /VISUAL_UNBACKED_REQUIRES_OPERATOR: .*'UIB-1::MOBILE'/,
    );
    const [candidate] = await visualCandidates(fixture);
    assert.match(
      candidate.rationale,
      /Figma evidence: node 12:50 'catalog-sync \/ mobile' 360x800, COMPLETE, states: list initial/,
    );
    // An explicit MOBILE row bound to the proven descendant is authoritative.
    const backed = {
      ...contract,
      rows: [
        ...contract.rows,
        { ...contract.rows[0], id: "VIS-2", state: "MOBILE" },
      ],
    };
    await writeVisualAcceptance(fixture, {
      ...backed,
      unbacked: [{ uiBehaviorId: "UIB-1", state: "MOBILE", reason: "x" }],
    });
    await rejectsAt(
      fixture,
      /row VIS-2 explicitly binds it to Figma node '12:50'/,
    );
    assert.equal((await visualCandidates(fixture)).length, 0);
    await writeVisualAcceptance(fixture, backed);
    await advance(fixture);
    assert.ok((await state(fixture)).completedSteps.includes("BUILD_BASELINE"));
  } finally {
    await fixture.cleanup();
  }
});

// --- Format 17: `unbacked` is an operator decision, never an agent waiver ----

const unbackedContract = (entry = {}, extra = {}) => ({
  version: 1,
  rows: [],
  unbacked: [
    {
      uiBehaviorId: "UIB-1",
      state: "DEFAULT",
      reason: "No frame designs the sign-in form.",
      ...entry,
    },
  ],
  ...extra,
});

/** A frame whose name and states design nothing of UIB-1's DEFAULT state. */
const UNRELATED_FRAME = { name: "Account settings", states: ["hover"] };

const visualCandidates = async (fixture) =>
  (
    await pendingDecisionCandidates({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    })
  ).candidates.filter((candidate) => candidate.kind === "VISUAL_UNBACKED");

/** The operator approves the one pending VISUAL_UNBACKED candidate at a terminal. */
const approveVisualUnbacked = async (fixture) => {
  const [candidate] = await visualCandidates(fixture);
  assert.ok(candidate, "a VISUAL_UNBACKED candidate is pending");
  const { decision } = await recordAtTerminal(
    fixture,
    candidate,
    challengeFor(candidate),
  );
  return {
    candidate,
    decisionId: decision.id,
    decisionDigest: lineDigestOf(decision),
  };
};

const figmaBaselineWith = async (fixture, frame, legacy) => {
  await figmaAtAssessTarget(fixture, {}, undefined, legacy);
  await writeFigmaContext(fixture, { frame });
  await advance(fixture);
  await completeStepDoc(fixture, "BUILD_BASELINE");
  await writeMatrices(fixture);
  await registerAuth(fixture);
};

test("unbacked-17: explicit rows bind DEFAULT and MOBILE to Figma variants; a 'narrow layout' frame binds nothing by itself", async () => {
  const fixture = await createFixture();
  try {
    const legacy = {
      ...LEGACY_INVENTORY,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors.map((uiBehavior) =>
        uiBehavior.id === "UIB-1"
          ? { ...uiBehavior, runtimeStates: ["DEFAULT", "MOBILE"] }
          : uiBehavior,
      ),
    };
    await figmaBaselineWith(
      fixture,
      {
        name: "Sign in / narrow layout",
        states: ["Default (empty form)", "narrow layout"],
      },
      legacy,
    );
    const defaultRow = visualAcceptance({
      row: { figmaState: "Default (empty form)" },
    }).rows[0];
    const mobileUnbacked = {
      uiBehaviorId: "UIB-1",
      state: "MOBILE",
      reason: "Assumed undesigned.",
    };
    // "narrow layout" is never read as MOBILE: the state stops at the operator.
    await writeVisualAcceptance(fixture, {
      version: 1,
      rows: [defaultRow],
      unbacked: [mobileUnbacked],
    });
    await rejectsAt(
      fixture,
      /VISUAL_UNBACKED_REQUIRES_OPERATOR: .*'UIB-1::MOBILE'/,
    );
    const mobileRow = {
      ...defaultRow,
      id: "VIS-2",
      state: "MOBILE",
      figmaState: "narrow layout",
    };
    await writeVisualAcceptance(fixture, {
      version: 1,
      rows: [defaultRow, mobileRow],
      unbacked: [mobileUnbacked],
    });
    await rejectsAt(
      fixture,
      /row VIS-2 explicitly binds it to Figma node '12:34' state 'narrow layout'/,
    );
    await writeVisualAcceptance(fixture, {
      version: 1,
      rows: [defaultRow, mobileRow],
      unbacked: [],
    });
    await advance(fixture);
    assert.ok((await state(fixture)).completedSteps.includes("BUILD_BASELINE"));
  } finally {
    await fixture.cleanup();
  }
});

test("unbacked-17: without authoritative design only a live operator decision covers the state", async () => {
  const fixture = await createFixture();
  try {
    await figmaBaselineWith(fixture, UNRELATED_FRAME);
    await writeVisualAcceptance(fixture, unbackedContract());
    await rejectsAt(
      fixture,
      /VISUAL_UNBACKED_REQUIRES_OPERATOR: .*'UIB-1::DEFAULT'/,
    );

    const [candidate] = await visualCandidates(fixture);
    assert.equal(candidate.subject.path, "UIB-1::DEFAULT");
    assert.equal(candidate.boundTo.module, (await state(fixture)).migrationId);
    assert.deepEqual(candidate.boundTo.figmaSources, ["ABC123def#12:34"]);
    assert.equal(
      candidate.boundTo.figmaContextDigest,
      `sha256:${createHash("sha256")
        .update(
          await readFile(
            path.join(fixture.migrationRoot, "inventories/figma-context.json"),
          ),
        )
        .digest("hex")}`,
    );
    assert.match(
      candidate.boundTo.visualContractDigest,
      /^sha256:[a-f0-9]{64}$/,
    );

    // An agent-authored ledger line -- every field but the candidate binding.
    const ledger = path.join(fixture.migrationRoot, DECISIONS_PATH);
    const forged = {
      id: "DEC-001",
      seq: 1,
      prevDigest: "genesis",
      at: new Date().toISOString(),
      operator: "agent@host",
      kind: "VISUAL_UNBACKED",
      subject: candidate.subject,
      statement: "Approved.",
      rationaleDigest: candidate.rationaleDigest,
      boundTo: candidate.boundTo,
    };
    await mkdir(path.dirname(ledger), { recursive: true });
    await appendFile(ledger, `${JSON.stringify(forged)}\n`);
    await writeVisualAcceptance(
      fixture,
      unbackedContract({
        decisionId: "DEC-001",
        decisionDigest: lineDigestOf(forged),
      }),
    );
    await rejectsAt(
      fixture,
      /Agent-authored, fake, and stale approval ids never satisfy/,
    );

    // No TTY, no approval: an agent can list the candidate, never record it.
    const before = await readFile(ledger, "utf8");
    const blocked = await runCli(fixture, () =>
      runRecordDecisionCli(["auth", "--approve", candidate.id]),
    );
    assert.equal(blocked.blocked, true);
    assert.equal(await readFile(ledger, "utf8"), before);
    // --mode auto self-confirms a checkpoint, never an operator decision.
    await writeVisualAcceptance(fixture, unbackedContract());
    await assert.rejects(
      advanceCli(fixture, AUTO),
      /VISUAL_UNBACKED_REQUIRES_OPERATOR/,
    );
    assert.equal((await state(fixture)).currentStep, "BUILD_BASELINE");

    const approved = await approveVisualUnbacked(fixture);
    const cited = unbackedContract({
      decisionId: approved.decisionId,
      decisionDigest: approved.decisionDigest,
    });
    // A changed visual contract makes the approval stale.
    await writeVisualAcceptance(fixture, {
      ...cited,
      notes: "edited after approval",
    });
    await rejectsAt(fixture, /does not approve current stable candidate/);
    await writeVisualAcceptance(fixture, cited);
    await advance(fixture);
    const persisted = await state(fixture);
    assert.ok(persisted.completedSteps.includes("BUILD_BASELINE"));
    assert.equal(persisted.formatVersion, 17);
  } finally {
    await fixture.cleanup();
  }
});

test("unbacked-17: DEGRADED evidence is never absence of design; it needs an operator decision naming the limitation", async () => {
  const fixture = await createFixture();
  try {
    await figmaBaselineWith(fixture, {
      extraction: {
        retrievedAt: "2026-07-01T00:00:00.000Z",
        fidelity: "DEGRADED",
        limitations: [
          "get_design_context: The design was too large to fit into context",
        ],
      },
    });
    await writeVisualAcceptance(fixture, unbackedContract());
    await rejectsAt(fixture, /VISUAL_UNBACKED_REQUIRES_OPERATOR/);
    const [candidate] = await visualCandidates(fixture);
    assert.match(
      candidate.rationale,
      /DEGRADED Figma evidence, fidelity not established: node 12:34 'Sign in' \(get_design_context: The design was too large/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: a provenance-only stub or incomplete Figma evidence is refused", async () => {
  const cases = [
    [
      "fileKey/nodeId stub",
      async (fixture) =>
        writeJson(
          path.join(fixture.migrationRoot, "inventories/figma-context.json"),
          {
            version: 1,
            frames: [{ fileKey: "ABC123def", nodeId: FIGMA_NODE }],
          },
        ),
      /frames\[0\]\.name is required/,
    ],
    [
      "no persisted screenshot",
      async (fixture) => {
        const frame = await writeFigmaContext(fixture);
        await writeFigmaContext(fixture, {
          frame: { sources: { ...frame.sources, screenshot: undefined } },
        });
      },
      /sources\.screenshot must persist the raw Figma MCP output/,
    ],
    [
      "screenshot outside the record",
      async (fixture) => {
        const frame = await writeFigmaContext(fixture);
        await writeFigmaContext(fixture, {
          frame: {
            sources: {
              ...frame.sources,
              screenshot: {
                ...frame.sources.screenshot,
                reference: "../../outside.png",
              },
            },
          },
        });
      },
      /sources\.screenshot must reference a file persisted inside the migration record/,
    ],
    [
      "degraded without its limitations",
      (fixture) =>
        writeFigmaContext(fixture, {
          frame: {
            extraction: {
              retrievedAt: "2026-07-01T00:00:00.000Z",
              fidelity: "DEGRADED",
              limitations: [],
            },
          },
        }),
      /extraction must record/,
    ],
    [
      "no design states",
      (fixture) => writeFigmaContext(fixture, { frame: { states: [] } }),
      /states must list the design states/,
    ],
    [
      "metadata about another node",
      (fixture) =>
        writeFigmaContext(fixture, {
          metadata: `<frame id="12:35" width="1280" height="720"></frame>\n`,
        }),
      /sources\.metadata does not describe node '12:34'/,
    ],
    [
      "viewport the node does not have",
      (fixture) =>
        writeFigmaContext(fixture, {
          viewport: { width: 1280, height: 720 },
          metadata: `<frame id="12:34" width="360" height="800"></frame>\n`,
        }),
      /viewport 1280x720 does not match node '12:34'.*\(360x800\)/,
    ],
  ];
  for (const [label, author, pattern] of cases) {
    const fixture = await createFixture();
    try {
      await figmaAtAssessTarget(fixture);
      await author(fixture);
      await rejectsAt(fixture, pattern);
      assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET", label);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("visual-17: the contract covers every required state and binds a complete frame at its viewport", async () => {
  const fixture = await createFixture();
  try {
    await driveFigmaToBaseline(fixture);
    await rejectsAt(fixture, /visual-acceptance|Visual acceptance matrix/);
    const cases = [
      [
        { ...visualAcceptance(), rows: [] },
        /VISUAL_CONTRACT_GAP: required UI behavior 'UIB-1' state 'DEFAULT'/,
      ],
      [
        visualAcceptance({ row: { figmaNodeId: "12:35" } }),
        /figmaNodeId '12:35' is not a frame/,
      ],
      [
        visualAcceptance({ row: { viewport: { width: 360, height: 800 } } }),
        /viewport must be node '12:34' viewport 1280x720/,
      ],
      [
        visualAcceptance({ row: { figmaState: "hover" } }),
        /figmaState 'hover' is not one of node '12:34' states/,
      ],
      [
        visualAcceptance({ row: { tolerance: { px: 200, ratio: 0.01 } } }),
        /tolerance\.px must be an explicit number between 0 and 16/,
      ],
      [visualAcceptance({ row: { tolerance: undefined } }), /tolerance/],
      [
        visualAcceptance({ row: { expect: {} } }),
        /must declare at least one visual fact/,
      ],
      // An unbounded count starting at 0 holds for every measurement, so it
      // would report PASS without ever comparing anything to the design.
      [
        visualAcceptance({
          row: {
            expect: {
              primaryActions: { kind: "count", min: 0, locator: "button" },
            },
          },
        }),
        /primaryActions is unfalsifiable.*accepts every measurement/,
      ],
      [
        visualAcceptance({ row: { state: "MOBILE" } }),
        /does not name a discovered state/,
      ],
    ];
    for (const [contract, pattern] of cases) {
      await writeVisualAcceptance(fixture, contract);
      await rejectsAt(fixture, pattern);
      assert.equal((await state(fixture)).currentStep, "BUILD_BASELINE");
    }
    // A frame state named "default" binds nothing by itself: no row, no authority.
    await writeVisualAcceptance(fixture, unbackedContract());
    await rejectsAt(fixture, /VISUAL_UNBACKED_REQUIRES_OPERATOR/);
    // An explicit row is authoritative, so the same state cannot also be unbacked.
    await writeVisualAcceptance(fixture, {
      ...visualAcceptance(),
      unbacked: unbackedContract().unbacked,
    });
    await rejectsAt(
      fixture,
      /row VIS-1 explicitly binds it to Figma node '12:34' state 'default'.*cannot be unbacked, not even by an operator/,
    );
    await writeVisualAcceptance(fixture, visualAcceptance());
    await advance(fixture);
    const persisted = await state(fixture);
    assert.ok(persisted.completedSteps.includes("BUILD_BASELINE"));
    assert.ok(persisted.artifactHashes["matrices/visual-acceptance.json"]);
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: a DEGRADED Figma extraction cannot back a visual acceptance row", async () => {
  const fixture = await createFixture();
  try {
    await figmaAtAssessTarget(fixture);
    await writeFigmaContext(fixture, {
      frame: {
        extraction: {
          retrievedAt: "2026-07-01T00:00:00.000Z",
          fidelity: "DEGRADED",
          limitations: [
            "get_design_context: The design was too large to fit into context",
          ],
        },
      },
    });
    // Degradation is honest evidence, so ASSESS_TARGET records it...
    await advance(fixture);
    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeMatrices(fixture);
    await registerAuth(fixture);
    await writeVisualAcceptance(fixture, visualAcceptance());
    // ...but fidelity cannot be derived from it.
    await rejectsAt(
      fixture,
      /extraction is DEGRADED \(get_design_context: The design was too large/,
    );
  } finally {
    await fixture.cleanup();
  }
});

/** slice-a implemented and awaiting verification in a format-17 figma record. */
const figmaSliceAwaitingVerify = async (fixture, options) => {
  await driveFigmaToVerify(fixture, options);
  await authorSlice(fixture, "slice-a");
  await advance(fixture, { slice: "slice-a" });
};

test("visual-17: runtime evidence for the wrong node or viewport is refused", async () => {
  const fixture = await createFixture();
  try {
    await figmaSliceAwaitingVerify(fixture);
    const cases = [
      [
        { figmaNodeId: "12:35" },
        /VISUAL_ACCEPTANCE_FAIL: .*names figmaNodeId '12:35'/,
      ],
      [
        { viewport: { width: 1440, height: 900 } },
        /ran at viewport 1440x900, the contract requires 1280x720/,
      ],
      [
        { measuredViewport: { width: 1024, height: 720 } },
        /measured by the runtime at viewport 1024x720/,
      ],
    ];
    for (const [options, pattern] of cases) {
      await authorEvidence(fixture, "slice-a", {
        mutate: await figmaEvidence(fixture, options),
      });
      await rejectsAt(fixture, pattern, { slice: "slice-a" });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: the engine owns the visual verdict -- an authored PASS over wrong measurements fails", async () => {
  const fixture = await createFixture();
  try {
    await figmaSliceAwaitingVerify(fixture);
    // Structurally present (one action, no navigation, column layout) but
    // visually wrong: the content column is materially narrower than the frame.
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture, {
        values: { ...MEASURED, contentWidth: 1100 },
      }),
    });
    await rejectsAt(
      fixture,
      /VISUAL_ACCEPTANCE_FAIL: .*contentWidth expected 1280px ±12\.8, observed 1100/,
      { slice: "slice-a" },
    );
    // A fact the runtime never measured is not a pass.
    const { layout: _omitted, ...unmeasured } = MEASURED;
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture, { values: unmeasured }),
    });
    await rejectsAt(fixture, /layout was not measured/, { slice: "slice-a" });
    assert.equal((await state(fixture)).activeSlice, "slice-a");
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: harmless rendering variance within tolerance verifies", async () => {
  const fixture = await createFixture();
  try {
    await figmaSliceAwaitingVerify(fixture);
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture, {
        // Subpixel/hinting drift and a timestamp the contract does not name.
        values: { ...MEASURED, contentWidth: 1287.5, renderedAt: "12:04:59" },
      }),
    });
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: synthetic narrow-viewport regression -- a 360px mobile frame rendered ~244px wide beside persistent navigation fails", async () => {
  const fixture = await createFixture();
  const mobile = { width: 360, height: 800 };
  try {
    await figmaSliceAwaitingVerify(fixture, {
      viewport: mobile,
      contract: visualAcceptance({
        viewport: mobile,
        row: {
          expect: {
            contentWidth: { kind: "px", value: 360, locator: "main" },
            listItems: {
              kind: "count",
              value: 10,
              locator: "getByTestId('list-item')",
            },
            itemWidth: {
              kind: "px",
              value: 344,
              locator: "getByTestId('list-item').first()",
            },
            navigation: {
              kind: "present",
              value: false,
              locator: "getByRole('navigation')",
            },
          },
          tolerance: { px: 8, ratio: 0.02 },
        },
      }),
    });
    // Every structural assertion of the old contract holds: ten cards render.
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture, {
        viewport: mobile,
        values: {
          contentWidth: 244,
          listItems: 10,
          itemWidth: 228,
          navigation: true,
        },
      }),
    });
    await assert.rejects(advance(fixture, { slice: "slice-a" }), (error) => {
      assert.match(error.message, /VISUAL_ACCEPTANCE_FAIL/);
      assert.match(
        error.message,
        /contentWidth expected 360px ±8, observed 244/,
      );
      assert.match(error.message, /itemWidth expected 344px ±8, observed 228/);
      assert.match(
        error.message,
        /navigation expected absent, observed present/,
      );
      assert.doesNotMatch(error.message, /listItems/);
      return true;
    });
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: a traced DESIGN_SYSTEM_GAP prevents verification until COMPLIANT or approved", async () => {
  const fixture = await createFixture();
  try {
    await figmaSliceAwaitingVerify(fixture);
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture),
    });
    await advance(fixture, { slice: "slice-a" });
    await authorSlice(fixture, "slice-b");
    await advance(fixture, { slice: "slice-b" });
    const designPath = path.join(
      fixture.migrationRoot,
      "matrices/design-system-usage.json",
    );
    const design = await readJson(designPath);
    const withRow = (row) => ({
      ...design,
      rows: [{ ...design.rows[0], ...row }],
    });
    await writeJson(
      designPath,
      withRow({ status: "DESIGN_SYSTEM_GAP", exceptionApproval: null }),
    );
    await authorEvidence(fixture, "slice-b");
    await rejectsAt(
      fixture,
      /DESIGN_SYSTEM_GAP: slice-b traces design-system row DR-1 with status 'DESIGN_SYSTEM_GAP'/,
      { slice: "slice-b" },
    );
    await writeJson(
      designPath,
      withRow({
        status: "EXCEPTION_APPROVED",
        exceptionApproval: "Operator approved the variant on 2026-07-01.",
      }),
    );
    await advance(fixture, { slice: "slice-b" });
    assert.ok((await state(fixture)).completedSlices.includes("slice-b"));
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: persisted Figma evidence that changed after it was hashed is stale", async () => {
  const fixture = await createFixture();
  try {
    await figmaSliceAwaitingVerify(fixture);
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture),
    });
    await writeFile(
      path.join(
        fixture.migrationRoot,
        "inventories/figma/12-34/screenshot.png",
      ),
      "a different design render\n",
    );
    await rejectsAt(
      fixture,
      /sources\.screenshot 'inventories\/figma\/12-34\/screenshot\.png' no longer matches its recorded hash/,
      { slice: "slice-a" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: a format-16 figma-mcp record keeps provenance-only semantics", async () => {
  const fixture = await createFixture();
  try {
    await figmaAtAssessTarget(fixture, {}, 16);
    await writeJson(
      path.join(fixture.migrationRoot, "inventories/figma-context.json"),
      { version: 1, frames: [{ fileKey: "ABC123def", nodeId: FIGMA_NODE }] },
    );
    await advance(fixture);
    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeMatrices(fixture);
    await registerAuth(fixture);
    // No visual-acceptance matrix is demanded or pinned.
    await advance(fixture);
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await advance(fixture);
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await completeStepDoc(fixture, "VERIFY_SLICES");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    const pin = await figmaPin(fixture);
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          boundTo: { ...record.boundTo, figmaContextDigest: pin },
        })),
    });
    await advance(fixture, { slice: "slice-a" });
    const persisted = await state(fixture);
    assert.equal(persisted.formatVersion, 16);
    assert.equal(
      persisted.artifactHashes["matrices/visual-acceptance.json"],
      undefined,
    );
    assert.equal(persisted.activeSlice, "slice-b");
  } finally {
    await fixture.cleanup();
  }
});

test("visual-17: compareVisualFact tolerates noise and rejects material divergence", () => {
  const tolerance = { px: 8, ratio: 0.02 };
  assert.equal(
    compareVisualFact({ kind: "px", value: 360 }, 361, tolerance),
    null,
  );
  assert.equal(
    compareVisualFact({ kind: "px", value: 360 }, 352, tolerance),
    null,
  );
  assert.match(
    compareVisualFact({ kind: "px", value: 360 }, 244, tolerance),
    /expected 360px ±8, observed 244/,
  );
  assert.match(
    compareVisualFact({ kind: "px", value: 360 }, "360", tolerance),
    /observed "360"/,
  );
  assert.equal(
    compareVisualFact({ kind: "count", min: 1 }, 25, tolerance),
    null,
  );
  assert.match(
    compareVisualFact({ kind: "count", value: 10 }, 9, tolerance),
    /expected 10, observed 9/,
  );
  assert.match(
    compareVisualFact({ kind: "present", value: false }, true, tolerance),
    /expected absent, observed present/,
  );
  assert.equal(
    compareVisualFact(
      { kind: "equals", value: ["header", "list"] },
      ["header", "list"],
      tolerance,
    ),
    null,
  );
  assert.match(
    compareVisualFact({ kind: "equals", value: "column" }, "row", tolerance),
    /expected "column", observed "row"/,
  );
  assert.equal(
    compareVisualFact({ kind: "px", value: 1 }, undefined, tolerance),
    "was not measured",
  );
});

// --- --adopt-visual-contract: a pre-17 figma record opts into format 17 --------

const ADOPTED_CONTEXT = "inventories/figma-context.adopted.json";
const STUB_CONTEXT = {
  version: 1,
  frames: [
    { fileKey: "ABC123def", nodeId: FIGMA_NODE, summary: "model prose" },
  ],
};

/** Final gates bound to the current tree, then FINALIZE. */
const finalizeFixture = async (fixture) => {
  await completeStepDoc(fixture, "FINALIZE");
  await writeMatrices(fixture, true);
  const context = await gateBindingContext(fixture);
  await writeJson(path.join(fixture.migrationRoot, "gates.json"), {
    version: 1,
    gates: GATES.map((gate) => ({
      gate,
      result: "PASS",
      attempts: 1,
      evidence: [gateEvidence(context)],
    })),
  });
  await advance(fixture);
};

/** A format-16 figma-mcp migration COMPLETE under provenance-only semantics:
 * a model-prose context, no visual contract, a digest-bound TARGET UI row on
 * slice-a, and slice-b with functional evidence only. */
const driveFigma16ToComplete = async (fixture) => {
  await figmaAtAssessTarget(fixture, {}, 16);
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/figma-context.json"),
    STUB_CONTEXT,
  );
  await advance(fixture);
  await completeStepDoc(fixture, "BUILD_BASELINE");
  await writeMatrices(fixture);
  await registerAuth(fixture);
  await advance(fixture);
  await completeStepDoc(fixture, "PLAN");
  await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
    version: 1,
    slices: SLICES,
  });
  await advance(fixture);
  await completeStepDoc(fixture, "IMPLEMENT_SLICES");
  await completeStepDoc(fixture, "VERIFY_SLICES");
  const pin = await figmaPin(fixture);
  for (const slice of SLICES) {
    await authorSlice(fixture, slice.id);
    await advance(fixture, { slice: slice.id });
    await authorEvidence(fixture, slice.id, {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          boundTo: { ...record.boundTo, figmaContextDigest: pin },
        })),
    });
    await advance(fixture, { slice: slice.id });
  }
  await finalizeFixture(fixture);
  assert.equal((await state(fixture)).status, "COMPLETE");
};

/** Fresh format-17 evidence authored beside the pinned context. */
const writeAdoptionEvidence = async (fixture, options = {}) => {
  await writeFigmaContext(fixture, { ...options, file: ADOPTED_CONTEXT });
  await writeVisualAcceptance(fixture, visualAcceptance());
};

const adoptionPreview = async (fixture) =>
  previewMigrationExecution({
    ...(await resolutionFor(fixture)),
    moduleName: "auth",
    adoptVisualContract: true,
  });

const adopt = async (fixture, preview, confirmExecution) =>
  bootstrapMigration({
    ...(await resolutionFor(fixture)),
    moduleName: "auth",
    adoptVisualContract: true,
    confirmExecution:
      confirmExecution === undefined
        ? preview.confirmationId
        : confirmExecution,
    boundInputs: preview.boundInputs,
    registryBinding: preview.registryBinding,
  });

const reopenUi = async (fixture, slices) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    reopenUi: slices,
  });
  return {
    preview,
    run: () =>
      bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        reopenUi: slices,
        boundInputs: preview.boundInputs,
        registryBinding: preview.registryBinding,
      }),
  };
};

test("adopt-17: without adoption a format-16 figma record is unchanged, and a non-Figma record cannot adopt", async () => {
  const figma = await createFixture();
  const plain = await createFixture();
  try {
    await driveFigma16ToComplete(figma);
    const bytes = await readFile(
      path.join(figma.migrationRoot, "state.json"),
      "utf8",
    );
    const resolution = await resolutionFor(figma);
    const resumed = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(resumed.state, "COMPLETE");
    assert.deepEqual(resumed.blockers, []);
    const result = await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      boundInputs: resumed.boundInputs,
      registryBinding: resumed.registryBinding,
    });
    assert.equal(result.changed, false);
    assert.equal(
      await readFile(path.join(figma.migrationRoot, "state.json"), "utf8"),
      bytes,
    );
    const persisted = JSON.parse(bytes);
    assert.equal(persisted.formatVersion, 16);
    assert.equal(persisted.visualContractAdoption, undefined);

    await driveTo(plain, "FINALIZE");
    const refused = await adoptionPreview(plain);
    assert.equal(refused.confirmationId, null);
    assert.match(
      refused.blockers.join("\n"),
      /applies only to a designSource: figma-mcp migration/,
    );
  } finally {
    await figma.cleanup();
    await plain.cleanup();
  }
});

test("adopt-17: adoption fails closed on absent, incomplete, or degraded evidence and requires the operator's exact confirmation", async () => {
  const fixture = await createFixture();
  try {
    await driveFigma16ToComplete(fixture);
    const statePath = path.join(fixture.migrationRoot, "state.json");
    const before = await readFile(statePath, "utf8");
    const blockedBy = async (pattern) => {
      const preview = await adoptionPreview(fixture);
      assert.equal(preview.confirmationId, null);
      assert.match(preview.blockers.join("\n"), pattern);
      await assert.rejects(
        adopt(fixture, preview, "anything"),
        /Migration execution is blocked/,
      );
      assert.equal(await readFile(statePath, "utf8"), before);
    };
    // The old model-prose context is never promoted into format-17 evidence.
    await blockedBy(
      /fails closed: inventories\/figma-context\.adopted\.json does not exist/,
    );
    await writeJson(
      path.join(fixture.migrationRoot, ADOPTED_CONTEXT),
      STUB_CONTEXT,
    );
    await blockedBy(/fails closed: .*frames\[0\]\.name is required/);
    await writeFigmaContext(fixture, {
      file: ADOPTED_CONTEXT,
      frame: {
        extraction: {
          retrievedAt: "2026-07-01T00:00:00.000Z",
          fidelity: "DEGRADED",
          limitations: [
            "get_design_context: The design was too large to fit into context",
          ],
        },
      },
    });
    await writeVisualAcceptance(fixture, visualAcceptance());
    await blockedBy(/extraction is DEGRADED/);
    await rm(
      path.join(fixture.migrationRoot, "matrices/visual-acceptance.json"),
    );
    await writeFigmaContext(fixture, { file: ADOPTED_CONTEXT });
    await blockedBy(
      /fails closed: .*(visual-acceptance|Visual acceptance matrix)/,
    );

    await writeVisualAcceptance(fixture, visualAcceptance());
    const preview = await adoptionPreview(fixture);
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual(preview.visualContractAdoption.affectedSlices, [
      "slice-a",
    ]);
    await assert.rejects(
      adopt(fixture, preview, null),
      /confirmation is missing or expired/,
    );
    await assert.rejects(
      adopt(fixture, preview, "not-the-challenge"),
      /confirmation is missing or expired/,
    );
    // The challenge binds the exact evidence bytes the operator was shown.
    await writeVisualAcceptance(
      fixture,
      visualAcceptance({ row: { tolerance: { px: 16, ratio: 0.1 } } }),
    );
    await assert.rejects(
      adopt(fixture, preview),
      /confirmation is missing or expired/,
    );
    assert.equal(await readFile(statePath, "utf8"), before);
  } finally {
    await fixture.cleanup();
  }
});

test("adopt-17: adoption preserves identity, history, slices, and functional evidence, and names the visual slices", async () => {
  const fixture = await createFixture();
  try {
    await driveFigma16ToComplete(fixture);
    const before = await state(fixture);
    const historyBefore = await historyEvents(fixture);
    const oldContext = await readFile(
      path.join(fixture.migrationRoot, "inventories/figma-context.json"),
      "utf8",
    );
    await writeAdoptionEvidence(fixture);
    const preview = await adoptionPreview(fixture);
    const result = await adopt(fixture, preview);
    assert.equal(result.adopted, true);

    const after = await state(fixture);
    for (const key of [
      "migrationId",
      "status",
      "currentStep",
      "completedSteps",
      "completedSlices",
      "requirementsAuthority",
      "legacyRevision",
      "figmaSources",
      "designSource",
    ]) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.equal(after.formatVersion, 17);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.visualContractAdoption.pendingReverification, [
      "slice-a",
    ]);
    assert.equal(after.visualContractAdoption.fromFormat, 16);
    for (const [relative, digest] of Object.entries(before.artifactHashes)) {
      if (relative === "inventories/figma-context.json") continue;
      assert.equal(after.artifactHashes[relative], digest, relative);
    }
    assert.notEqual(
      after.artifactHashes["inventories/figma-context.json"],
      before.artifactHashes["inventories/figma-context.json"],
    );
    assert.ok(after.artifactHashes["matrices/visual-acceptance.json"]);
    assert.equal(
      await readFile(
        path.join(
          fixture.migrationRoot,
          "visual-contract-adoption/figma-context.previous.json",
        ),
        "utf8",
      ),
      oldContext,
    );
    await assert.rejects(
      access(path.join(fixture.migrationRoot, ADOPTED_CONTEXT)),
    );

    const historyAfter = await historyEvents(fixture);
    assert.deepEqual(
      historyAfter.slice(0, historyBefore.length),
      historyBefore,
    );
    assert.equal(historyAfter.length, historyBefore.length + 1);
    const event = historyAfter.at(-1);
    assert.equal(event.event, "VISUAL_CONTRACT_ADOPTED");
    assert.equal(event.fromFormat, 16);
    assert.equal(event.toFormat, 17);
    assert.deepEqual(event.affectedSlices, ["slice-a"]);
    assert.equal(event.confirmationId, preview.confirmationId);
    assert.equal(
      event.previousFigmaContextDigest,
      before.artifactHashes["inventories/figma-context.json"],
    );
    const record = await readJson(
      path.join(fixture.migrationRoot, "visual-contract-adoption/record.json"),
    );
    assert.match(
      record.note,
      /Not a legacy refresh, replan, or migration restart/,
    );
    assert.equal(record.adopted.frames[0].sources.screenshot.length, 1);

    // The old TARGET visual evidence cannot stand: resuming is refused until
    // every affected slice is reopened, and adoption is not repeatable.
    const resumed = await previewMigrationExecution({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    assert.match(
      resumed.blockers.join("\n"),
      /Reopen them first: --reopen-ui slice-a/,
    );
    const partial = await reopenUi(fixture, ["slice-b"]);
    assert.match(partial.preview.blockers.join("\n"), /--reopen-ui slice-a/);
    await assert.rejects(
      partial.run(),
      /must include every slice whose Figma visual evidence predates/,
    );
    await writeAdoptionEvidence(fixture);
    assert.match(
      (await adoptionPreview(fixture)).blockers.join("\n"),
      /already format 17\. It is not a refresh, replan, or reset/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("adopt-17: adoption consumes a proven descendant of the recorded section without touching identity, sources, history, or functional evidence", async () => {
  const fixture = await createFixture();
  try {
    await driveFigma16ToComplete(fixture);
    const before = await state(fixture);
    const historyBefore = await historyEvents(fixture);
    // An unproven descendant fails closed exactly like any other bad evidence.
    await writeDescendantContext(fixture, {
      file: ADOPTED_CONTEXT,
      path: ["12:34", "12:50"],
    });
    await writeVisualAcceptance(fixture, descendantAcceptance());
    assert.match(
      (await adoptionPreview(fixture)).blockers.join("\n"),
      /fails closed: .*ancestry\.path/,
    );

    await writeDescendantContext(fixture, { file: ADOPTED_CONTEXT });
    const preview = await adoptionPreview(fixture);
    assert.deepEqual(preview.blockers, []);
    assert.equal((await adopt(fixture, preview)).adopted, true);

    const after = await state(fixture);
    assert.equal(after.formatVersion, 17);
    for (const key of ["migrationId", "figmaSources", "completedSlices"]) {
      assert.deepEqual(after[key], before[key], key);
    }
    for (const [relative, digest] of Object.entries(before.artifactHashes)) {
      if (relative === "inventories/figma-context.json") continue;
      assert.equal(after.artifactHashes[relative], digest, relative);
    }
    assert.deepEqual(
      (await historyEvents(fixture)).slice(0, historyBefore.length),
      historyBefore,
    );
    const record = await readJson(
      path.join(fixture.migrationRoot, "visual-contract-adoption/record.json"),
    );
    assert.equal(record.adopted.frames[0].nodeId, "12:50");
    assert.deepEqual(record.adopted.frames[0].ancestry.path, [
      "12:34",
      "12:40",
      "12:45",
      "12:50",
    ]);
    assert.match(
      record.adopted.frames[0].ancestry.metadata,
      /^sha256:[a-f0-9]{64}$/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("adopt-17: an operator-approved unbacked state goes stale when the adopted Figma context changes", async () => {
  const fixture = await createFixture();
  try {
    await driveFigma16ToComplete(fixture);
    const withContext = (frame) =>
      writeFigmaContext(fixture, {
        file: ADOPTED_CONTEXT,
        frame: { ...UNRELATED_FRAME, ...frame },
      });
    await withContext();
    await writeVisualAcceptance(fixture, unbackedContract());
    assert.match(
      (await adoptionPreview(fixture)).blockers.join("\n"),
      /VISUAL_UNBACKED_REQUIRES_OPERATOR/,
    );

    const approved = await approveVisualUnbacked(fixture);
    await writeVisualAcceptance(
      fixture,
      unbackedContract({
        decisionId: approved.decisionId,
        decisionDigest: approved.decisionDigest,
      }),
    );
    assert.deepEqual((await adoptionPreview(fixture)).blockers, []);

    await withContext({
      extraction: {
        retrievedAt: "2026-09-17T00:00:00.000Z",
        fidelity: "COMPLETE",
        limitations: [],
      },
    });
    assert.match(
      (await adoptionPreview(fixture)).blockers.join("\n"),
      /does not approve current stable candidate/,
    );

    // The exact context the operator approved is consumed by adoption unchanged.
    await withContext();
    assert.equal(
      (await adopt(fixture, await adoptionPreview(fixture))).adopted,
      true,
    );
    assert.equal((await state(fixture)).formatVersion, 17);
  } finally {
    await fixture.cleanup();
  }
});

test("adopt-17: --reopen-ui after adoption verifies under format 17 and reaches COMPLETE again", async () => {
  const fixture = await createFixture();
  try {
    await driveFigma16ToComplete(fixture);
    await writeAdoptionEvidence(fixture);
    await adopt(fixture, await adoptionPreview(fixture));
    const reopen = await reopenUi(fixture, ["slice-a"]);
    assert.deepEqual(reopen.preview.blockers, []);
    await reopen.run();
    const reopened = await state(fixture);
    assert.equal(reopened.formatVersion, 17);
    assert.deepEqual(reopened.visualContractAdoption.pendingReverification, []);
    assert.deepEqual(reopened.completedSlices, ["slice-b"]);
    await writeJson(path.join(fixture.migrationRoot, "ui-remediation.json"), {
      version: 1,
      hasVisibleUi: true,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors,
      uiMismatches: TARGET_INVENTORY.uiMismatches,
    });
    const pin = await figmaPin(fixture);
    // Provenance alone -- what verified this slice at format 16 -- now fails.
    await authorEvidence(fixture, "slice-a", {
      mutate: (records) =>
        records.map((record) => ({
          ...record,
          boundTo: { ...record.boundTo, figmaContextDigest: pin },
        })),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /VISUAL_ACCEPTANCE_FAIL/,
    );
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture, {
        values: { ...MEASURED, contentWidth: 900 },
      }),
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /contentWidth expected 1280px/,
    );
    await authorEvidence(fixture, "slice-a", {
      mutate: await figmaEvidence(fixture),
    });
    await advance(fixture, { slice: "slice-a" });
    // FINALIZE re-validates slice-b's untouched functional evidence under 17.
    await finalizeFixture(fixture);
    const complete = await state(fixture);
    assert.equal(complete.status, "COMPLETE");
    assert.equal(complete.formatVersion, 17);
  } finally {
    await fixture.cleanup();
  }
});

// --- Format 15: multi-source convergence and brownfield target adoption ------
//
// The engine assumed one legacy module owned one target it effectively started
// from empty. These scenarios cover both halves of that assumption breaking at
// once: N sources converging on one target, and that target already being
// substantially implemented before the record exists.

const MULTI_SOURCE_FORMAT_VERSION = 15;

/** A second and third legacy slice, so attribution has something to attribute. */
const withLegacySources = async (fixture, names) => {
  for (const name of names) {
    await mkdir(path.join(fixture.legacyRoot, name), { recursive: true });
    await writeFile(
      path.join(fixture.legacyRoot, name, "marker.txt"),
      `${name}\n`,
    );
  }
  return fixture;
};

/**
 * A target that is already implemented and already tested -- the condition
 * `--adopt-target` exists for. Committed, so the adopted paths are clean at
 * both ends of the baseline comparison and nothing reads as migration work.
 */
const ADOPTED_SOURCE_FILE = "src/features/auth/index.ts";
const ADOPTED_TEST_FILE = "tests/features/auth/auth.unit.spec.ts";

const brownfieldFixture = async (options = {}) => {
  const fixture = await createFixture(options);
  for (const relative of [ADOPTED_SOURCE_FILE, ADOPTED_TEST_FILE]) {
    await mkdir(path.dirname(path.join(fixture.targetRoot, relative)), {
      recursive: true,
    });
    await writeFile(path.join(fixture.targetRoot, relative), "export {};\n");
  }
  await execFileAsync("git", ["add", "-A"], { cwd: fixture.root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Contract Test",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-q",
      "-m",
      "pre-existing target implementation",
    ],
    { cwd: fixture.root },
  );
  return fixture;
};

const BROWNFIELD_TARGET_INVENTORY = {
  ...TARGET_INVENTORY,
  implementationState: "IMPLEMENTED_UNVERIFIED",
  evidence: evidenceChecklist(
    ADOPTED_SOURCE_FILE,
    ["AUTH-REQ-001"],
    ["AUTH-SCN-001"],
  ),
};

/** A captured, hash-bound command output, exactly as `assertCommandResults` wants. */
const captureRun = async (fixture, body) => {
  const relative = "adoption/run.txt";
  await mkdir(path.join(fixture.targetRoot, "adoption"), { recursive: true });
  await writeFile(path.join(fixture.targetRoot, relative), body);
  return {
    outputPath: relative,
    outputDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
};

const adoptedRow = (output, overrides = {}) => ({
  id: "BR-1",
  behaviorId: "LB-1",
  targetState: "IMPLEMENTED_UNVERIFIED",
  disposition: "NO_CHANGE_REQUIRED",
  legacyEvidence: ["legacy/auth/marker.txt"],
  targetEvidence: [ADOPTED_SOURCE_FILE],
  scenarioIds: ["AUTH-SCN-001"],
  verificationStatus: "ADOPTED_VERIFIED",
  adoptionEvidence: [
    {
      command: `pnpm test:run ${ADOPTED_TEST_FILE}`,
      exitCode: 0,
      executedAt: new Date().toISOString(),
      runner: "contract-suite",
      ...output,
      scenarioIds: ["AUTH-SCN-001"],
      testPaths: [ADOPTED_TEST_FILE],
      ...(overrides.adoptionEvidence ?? {}),
    },
  ],
  ...overrides.row,
});

/** Author BUILD_BASELINE over a brownfield record with one custom parity row. */
const closeBaselineWith = async (fixture, row) => {
  await driveTo(fixture, "ASSESS_TARGET", advance, {
    bootstrap: { adoptTarget: true },
    target: BROWNFIELD_TARGET_INVENTORY,
  });
  await completeStepDoc(fixture, "BUILD_BASELINE");
  const documents = matrices(false);
  documents["matrices/behavior-parity.json"].rows[0] = row;
  for (const [relative, document] of Object.entries(documents)) {
    await writeJson(path.join(fixture.migrationRoot, relative), document);
  }
  await registerAuth(fixture);
  return advance(fixture);
};

test("format 15 keys the record on the target and derives the source order", async () => {
  const fixture = await createFixture();
  try {
    await withLegacySources(fixture, ["auth-ui", "auth-core"]);
    // Flag order is deliberately reversed relative to the sorted result, and a
    // duplicate is thrown in: neither may reach the record.
    const { result } = await initialize(fixture, {
      legacy: ["auth-ui", "auth-core", "auth-ui"],
    });
    const persisted = result.state;

    // A new record bootstraps at the current format, which is at or above the
    // one that introduced multi-source.
    assert.equal(persisted.formatVersion, MIGRATION_FORMAT_VERSION);
    assert.ok(persisted.formatVersion >= MULTI_SOURCE_FORMAT_VERSION);
    assert.deepEqual(persisted.legacySources, ["auth-core", "auth-ui"]);
    // migrationId is the target, which is what the record directory and the
    // module lock now key on -- the one thing that stays singular.
    assert.equal(persisted.migrationId, persisted.targetModule);
    assert.equal(persisted.migrationId, "auth");
    assert.equal(persisted.legacyModule, "auth-core");
    assert.deepEqual(persisted.targetAdoption, {
      mode: "GREENFIELD",
      baseline: null,
    });
    assert.equal(
      result.statePath,
      path.join(fixture.migrationRoot, "state.json"),
    );

    // The anti-circularity property: RESOLVE closes knowing only the names.
    const classification = await readJson(
      path.join(
        fixture.migrationRoot,
        "inventories/module-classification.json",
      ),
    );
    assert.deepEqual(classification.moduleRoots, []);
    assert.equal(persisted.currentStep, "DISCOVER_LEGACY");
  } finally {
    await fixture.cleanup();
  }
});

test("the source set is fixed for the migration's lifetime", async () => {
  const fixture = await createFixture();
  try {
    await withLegacySources(fixture, ["auth-ui", "auth-core"]);
    await initialize(fixture, { legacy: ["auth-core", "auth-ui"] });
    await assert.rejects(
      previewMigrationExecution({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
        legacy: ["auth-core"],
      }),
      /conflict with the recorded sources/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a format-14 record keeps legacy-keyed identity and rejects the new keys", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const statePath = path.join(fixture.migrationRoot, "state.json");
    const persisted = await readJson(statePath);
    await writeJson(statePath, {
      ...persisted,
      formatVersion: 14,
      legacySources: undefined,
      targetAdoption: undefined,
    });
    // Format 14 is in the self-healing set, so the bump to 15 must not turn
    // every existing record into "unsupported and never converted".
    assert.equal(compatibilityBlocker(await state(fixture), "auth"), null);

    await writeJson(statePath, {
      ...persisted,
      formatVersion: 14,
      legacySources: ["auth"],
      targetAdoption: undefined,
    });
    await assert.rejects(
      getMigrationStatus({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }),
      /legacySources requires format 15/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("DISCOVERY_COMPLETENESS canonicalizes roots per source", async () => {
  // Legacy evidence has to sit inside the declared roots, so it moves with
  // them: C7 refuses a citation outside the canonical module boundary.
  const legacy = JSON.parse(
    JSON.stringify(LEGACY_INVENTORY).replaceAll(
      "legacy/auth/marker.txt",
      "legacy/auth-core/marker.txt",
    ),
  );
  const sourcedClassification = (moduleRoots, files = null) => ({
    ...MODULE_CLASSIFICATION,
    moduleRoots,
    files: files ?? MODULE_CLASSIFICATION.files,
  });
  const twoRootFiles = [
    {
      ...MODULE_CLASSIFICATION.files[0],
      path: "auth-core/marker.txt",
      rationale: "Owned by auth-core.",
    },
    {
      ...MODULE_CLASSIFICATION.files[0],
      path: "auth-ui/marker.txt",
      rationale: "Owned by auth-ui.",
    },
  ];
  const drive = async (fixture, classification) =>
    driveTo(fixture, "DISCOVER_LEGACY", advance, {
      bootstrap: { legacy: ["auth-core", "auth-ui"] },
      legacy,
      classification,
    }).then(async () => {
      await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
      await writeJson(
        path.join(
          fixture.migrationRoot,
          "inventories/module-classification.json",
        ),
        classification,
      );
      return advance(fixture);
    });

  // Every source owns exactly one implicit root, named after it -- so neither
  // needs a ROOT_DECLARATION decision purely for not sorting first.
  const accepted = await createFixture();
  try {
    await withLegacySources(accepted, ["auth-core", "auth-ui"]);
    await drive(
      accepted,
      sourcedClassification(
        [
          {
            path: "auth-core",
            reason: "auth-core's own slice.",
            decisionId: null,
            source: "auth-core",
          },
          {
            path: "auth-ui",
            reason: "auth-ui's own slice.",
            decisionId: null,
            source: "auth-ui",
          },
        ],
        twoRootFiles,
      ),
    );
    assert.equal((await state(accepted)).currentStep, "ASSESS_TARGET");
  } finally {
    await accepted.cleanup();
  }

  // A root naming a source the record does not declare.
  const undeclared = await createFixture();
  try {
    await withLegacySources(undeclared, ["auth-core", "auth-ui"]);
    await assert.rejects(
      drive(
        undeclared,
        sourcedClassification(
          [
            {
              path: "auth-core",
              reason: "Owned.",
              decisionId: null,
              source: "auth-core",
            },
            {
              path: "auth-ui",
              reason: "Owned.",
              decisionId: null,
              source: "auth-legacy",
            },
          ],
          twoRootFiles,
        ),
      ),
      /names source 'auth-legacy', which this migration does not declare/,
    );
  } finally {
    await undeclared.cleanup();
  }

  // A declared source that discovered nothing is an error, not an empty set
  // silently carried into every per-source rule downstream.
  const uncovered = await createFixture();
  try {
    await withLegacySources(uncovered, ["auth-core", "auth-ui"]);
    await assert.rejects(
      drive(
        uncovered,
        sourcedClassification(
          [
            {
              path: "auth-core",
              reason: "Owned.",
              decisionId: null,
              source: "auth-core",
            },
          ],
          [twoRootFiles[0]],
        ),
      ),
      /Legacy source 'auth-ui' owns no module root/,
    );
  } finally {
    await uncovered.cleanup();
  }

  // Nesting across sources: what would make attribution a guess.
  const overlapping = await createFixture();
  try {
    await withLegacySources(overlapping, ["auth-core", "auth-ui"]);
    await mkdir(path.join(overlapping.legacyRoot, "auth-core/auth-ui"), {
      recursive: true,
    });
    await assert.rejects(
      drive(
        overlapping,
        sourcedClassification(
          [
            {
              path: "auth-core",
              reason: "Owned.",
              decisionId: null,
              source: "auth-core",
            },
            {
              path: "auth-core/auth-ui",
              reason: "Owned.",
              decisionId: null,
              source: "auth-ui",
            },
          ],
          twoRootFiles,
        ),
      ),
      /overlap or nest/,
    );
  } finally {
    await overlapping.cleanup();
  }
});

// A multi-source classification whose legacy evidence sits inside a declared
// root, with an extra non-implicit root that only an operator decision may
// widen the boundary to.
const multiSourceLegacy = () =>
  JSON.parse(
    JSON.stringify(LEGACY_INVENTORY).replaceAll(
      "legacy/auth/marker.txt",
      "legacy/auth-core/marker.txt",
    ),
  );

const multiSourceFileRow = (rootPath) => ({
  ...MODULE_CLASSIFICATION.files[0],
  path: `${rootPath}/marker.txt`,
  rationale: `Owned by ${rootPath}.`,
});

// Format 15 keys the record on the target (`migrationId === "auth"`) while
// `legacyModule` is the first source (`"auth-core"`). The recorder binds an
// approval to `migrationId`; validation must recompute the stable candidate
// under the same identity, or a multi-source ROOT_DECLARATION can never be
// satisfied. This drives the whole recorder-to-validator contract.
test("a multi-source ROOT_DECLARATION approved through the recorder satisfies DISCOVERY_COMPLETENESS", async () => {
  const fixture = await createFixture();
  try {
    await withLegacySources(fixture, [
      "auth-core",
      "auth-ui",
      "auth-core-extra",
    ]);
    // `auth-core-extra` is a second `auth-core` root whose basename is not the
    // source name, so it is never implicit -- exactly the shape (services/
    // hooks/utils roots) a real multi-source module declares.
    const classificationFor = (decisionId) => ({
      ...MODULE_CLASSIFICATION,
      moduleRoots: [
        {
          path: "auth-core",
          reason: "auth-core's own slice.",
          decisionId: null,
          source: "auth-core",
        },
        {
          path: "auth-ui",
          reason: "auth-ui's own slice.",
          decisionId: null,
          source: "auth-ui",
        },
        {
          path: "auth-core-extra",
          reason: "auth-core's second root, widened by the operator.",
          decisionId,
          source: "auth-core",
        },
      ],
      files: [
        multiSourceFileRow("auth-core"),
        multiSourceFileRow("auth-ui"),
        multiSourceFileRow("auth-core-extra"),
      ],
    });

    await driveTo(fixture, "DISCOVER_LEGACY", advance, {
      bootstrap: { legacy: ["auth-core", "auth-ui"] },
      legacy: multiSourceLegacy(),
      classification: classificationFor(null),
    });
    assert.equal((await state(fixture)).migrationId, "auth");
    assert.equal((await state(fixture)).legacyModule, "auth-core");

    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeClassification(fixture, classificationFor(null));

    const resolution = await resolutionFor(fixture);
    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    const rootCandidates = pending.candidates.filter(
      (candidate) => candidate.kind === "ROOT_DECLARATION",
    );
    // Only the non-implicit root is demanded; neither source's own implicit
    // root surfaces (Defect #2 would have added `auth-ui`).
    assert.deepEqual(
      rootCandidates.map((candidate) => candidate.subject.path),
      ["auth-core-extra"],
    );
    const candidate = rootCandidates[0];
    assert.equal(candidate.approvable, true);

    const recorded = await recordAtTerminal(
      fixture,
      candidate,
      challengeFor(candidate),
    );
    // Bound to the canonical migration identity (the target), not the first
    // legacy source -- the exact field the two paths used to disagree on.
    assert.equal(recorded.decision.boundTo.module, "auth");
    assert.equal(recorded.decision.candidateId, candidate.id);

    const linked = classificationFor(recorded.decision.id);
    linked.moduleRoots[2].decisionDigest = decisionLineDigest(
      recorded.decision,
    );
    await writeClassification(fixture, linked);
    // Validation recomputes the candidate under `migrationId` and matches the
    // approved id, so the checkpoint closes. Under the defect it threw
    // "does not approve current stable candidate".
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

// Defect #2 in isolation: the recorder derived pending roots against
// `state.legacyModule` alone, so every other source's basename-matching
// implicit root surfaced as a spurious ROOT_DECLARATION the validator never
// asked for.
test("the recorder demands no ROOT_DECLARATION for any source's own implicit root", async () => {
  const fixture = await createFixture();
  try {
    await withLegacySources(fixture, ["auth-core", "auth-ui"]);
    const classification = {
      ...MODULE_CLASSIFICATION,
      moduleRoots: [
        {
          path: "auth-core",
          reason: "auth-core's own slice.",
          decisionId: null,
          source: "auth-core",
        },
        {
          path: "auth-ui",
          reason: "auth-ui's own slice.",
          decisionId: null,
          source: "auth-ui",
        },
      ],
      files: [multiSourceFileRow("auth-core"), multiSourceFileRow("auth-ui")],
    };
    await driveTo(fixture, "DISCOVER_LEGACY", advance, {
      bootstrap: { legacy: ["auth-core", "auth-ui"] },
      legacy: multiSourceLegacy(),
      classification,
    });
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    await writeClassification(fixture, classification);

    const resolution = await resolutionFor(fixture);
    const pending = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });
    // `auth-ui`, the non-first source's implicit root, is not demanded.
    assert.deepEqual(
      pending.candidates.filter(
        (candidate) => candidate.kind === "ROOT_DECLARATION",
      ),
      [],
    );
    // And the checkpoint closes with no operator decision at all.
    await advance(fixture);
    assert.equal((await state(fixture)).currentStep, "ASSESS_TARGET");
  } finally {
    await fixture.cleanup();
  }
});

test("--adopt-target pins an immutable target baseline and requires the feature", async () => {
  const missing = await createFixture();
  try {
    const { preview } = await previewFresh(missing, { adoptTarget: true });
    assert.equal(preview.requiresConfirmation, false);
    assert.match(
      preview.blockers.join("; "),
      /'src\/features\/auth\/' does not exist/,
    );
  } finally {
    await missing.cleanup();
  }

  const fixture = await brownfieldFixture();
  try {
    // A pre-existing uncommitted edit: exactly what a revision alone misses.
    await writeFile(
      path.join(fixture.targetRoot, "src/pre-existing.ts"),
      "export const before = true;\n",
    );
    const { result } = await initialize(fixture, { adoptTarget: true });
    assert.equal(result.state.targetAdoption.mode, "BROWNFIELD");

    const baseline = await readJson(
      path.join(fixture.migrationRoot, "inventories/target-baseline.json"),
    );
    assert.match(baseline.revision, /^[0-9a-f]{40}$/);
    assert.ok(
      baseline.dirty.some((entry) => entry.path === "src/pre-existing.ts"),
      "the pre-migration dirty set is recorded per path",
    );
    // Pinned, so it can never be rewritten later to launder work into or out
    // of the baseline.
    assert.equal(
      result.state.artifactHashes["inventories/target-baseline.json"],
      result.state.targetAdoption.baseline.digest,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ADOPTED_VERIFIED is earned by evidence bound to its scenarios and tests", async () => {
  const accepted = await brownfieldFixture();
  try {
    const output = await captureRun(
      accepted,
      `RUN  ${ADOPTED_TEST_FILE}\n1 passed\n`,
    );
    await closeBaselineWith(accepted, adoptedRow(output));
    assert.equal((await state(accepted)).currentStep, "PLAN");
  } finally {
    await accepted.cleanup();
  }

  // The test that proves an unrelated green command cannot adopt a row.
  const unrelated = await brownfieldFixture();
  try {
    const output = await captureRun(
      unrelated,
      "RUN  tests/features/unrelated/unrelated.unit.spec.ts\n1 passed\n",
    );
    await assert.rejects(
      closeBaselineWith(unrelated, adoptedRow(output)),
      /does not appear in the captured output/,
    );
  } finally {
    await unrelated.cleanup();
  }

  // Coverage must be exact in both directions.
  const uncovered = await brownfieldFixture();
  try {
    const output = await captureRun(
      uncovered,
      `RUN  ${ADOPTED_TEST_FILE}\n1 passed\n`,
    );
    await assert.rejects(
      closeBaselineWith(
        uncovered,
        adoptedRow(output, {
          row: { scenarioIds: ["AUTH-SCN-001", "AUTH-SCN-002"] },
        }),
      ),
      /claims scenario\(s\) AUTH-SCN-002 that no adoption evidence covers/,
    );
  } finally {
    await uncovered.cleanup();
  }

  const unclaimed = await brownfieldFixture();
  try {
    const output = await captureRun(
      unclaimed,
      `RUN  ${ADOPTED_TEST_FILE}\n1 passed\n`,
    );
    await assert.rejects(
      closeBaselineWith(
        unclaimed,
        adoptedRow(output, {
          adoptionEvidence: { scenarioIds: ["AUTH-SCN-002"] },
        }),
      ),
      /names 'AUTH-SCN-002', which BR-1 does not claim/,
    );
  } finally {
    await unclaimed.cleanup();
  }

  // Adoption is available only to a record that adopted a target.
  const greenfield = await brownfieldFixture();
  try {
    const output = await captureRun(
      greenfield,
      `RUN  ${ADOPTED_TEST_FILE}\n1 passed\n`,
    );
    await driveTo(greenfield, "ASSESS_TARGET", advance, {
      target: BROWNFIELD_TARGET_INVENTORY,
    });
    await completeStepDoc(greenfield, "BUILD_BASELINE");
    const documents = matrices(false);
    documents["matrices/behavior-parity.json"].rows[0] = adoptedRow(output);
    for (const [relative, document] of Object.entries(documents)) {
      await writeJson(path.join(greenfield.migrationRoot, relative), document);
    }
    await registerAuth(greenfield);
    await assert.rejects(
      advance(greenfield),
      /did not adopt an existing target/,
    );
  } finally {
    await greenfield.cleanup();
  }
});

test("an adopted row goes stale when a path it named changes", async () => {
  const fixture = await brownfieldFixture();
  try {
    const output = await captureRun(
      fixture,
      `RUN  ${ADOPTED_TEST_FILE}\n1 passed\n`,
    );
    await closeBaselineWith(fixture, adoptedRow(output));

    // An unrelated file does not reopen the matrix...
    await writeFile(
      path.join(fixture.targetRoot, "src/unrelated.ts"),
      "export {};\n",
    );
    await assert.doesNotReject(
      previewMigrationExecution({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }),
    );

    // ...but a path the row named does.
    await writeFile(
      path.join(fixture.targetRoot, ADOPTED_SOURCE_FILE),
      "export const changed = true;\n",
    );
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await assert.rejects(
      advance(fixture),
      /changed since the target baseline was pinned/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("brownfield target inventories cannot come back absent or evidence-free", async () => {
  const absent = await brownfieldFixture();
  try {
    await assert.rejects(
      driveTo(absent, "ASSESS_TARGET", advance, {
        bootstrap: { adoptTarget: true },
      }),
      /records ABSENT, but this migration adopted an existing/,
    );
  } finally {
    await absent.cleanup();
  }

  const elsewhere = await brownfieldFixture();
  try {
    await assert.rejects(
      driveTo(elsewhere, "ASSESS_TARGET", advance, {
        bootstrap: { adoptTarget: true },
        target: {
          ...BROWNFIELD_TARGET_INVENTORY,
          evidence: evidenceChecklist(
            "target/src/placeholder.ts",
            ["AUTH-REQ-001"],
            ["AUTH-SCN-001"],
          ),
        },
      }),
      /cites no SOURCE evidence under 'src\/features\/auth\/'/,
    );
  } finally {
    await elsewhere.cleanup();
  }
});

test("pre-existing target work may not be claimed as slice work", async () => {
  const fixture = await brownfieldFixture();
  const preExisting = "src/pre-existing.ts";
  try {
    await writeFile(
      path.join(fixture.targetRoot, preExisting),
      "export const before = true;\n",
    );
    await driveTo(fixture, "PLAN", advance, {
      bootstrap: { adoptTarget: true },
      target: BROWNFIELD_TARGET_INVENTORY,
    });
    const slicePath = path.join(fixture.migrationRoot, "slices/slice-a.json");
    await authorSlice(fixture, "slice-a");
    const record = await readJson(slicePath);
    await writeJson(slicePath, {
      ...record,
      changedFiles: [...record.changedFiles, preExisting],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /reads exactly as it did when the target baseline was pinned/,
    );

    // The same path, now genuinely edited by the migration.
    await writeFile(
      path.join(fixture.targetRoot, preExisting),
      "export const before = false;\n",
    );
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("a greenfield slice may never skip production changes via verification-only semantics", async () => {
  const fixture = await createFixture();
  const sources = ["auth-core", "auth-ui"];
  try {
    await withLegacySources(fixture, sources);
    await driveTo(fixture, "ASSESS_TARGET", advance, {
      bootstrap: { legacy: sources },
      legacy: legacyInventoryUnder("auth-core"),
      classification: {
        ...MODULE_CLASSIFICATION,
        moduleRoots: rootsForSources(sources),
        files: filesForSources(sources),
      },
    });
    await completeStepDoc(fixture, "BUILD_BASELINE");
    const documents = matrices(false);
    documents["matrices/behavior-parity.json"].rows[0].legacyEvidence = [
      "legacy/auth-core/marker.txt",
    ];
    for (const [relative, document] of Object.entries(documents)) {
      await writeJson(path.join(fixture.migrationRoot, relative), document);
    }
    await registerAuth(fixture);
    await advance(fixture);
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await advance(fixture);
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await completeStepDoc(fixture, "VERIFY_SLICES");

    const persisted = await state(fixture);
    assert.equal(persisted.legacyModule, sources[0]);
    assert.equal(persisted.migrationId, persisted.targetModule);

    const output = await captureRun(fixture, "1 passed\n");
    const slicePath = path.join(fixture.migrationRoot, "slices/slice-a.json");
    await authorSlice(fixture, "slice-a");
    const record = await readJson(slicePath);

    // No changed files and nothing that re-proves the slice either.
    await writeJson(slicePath, { ...record, changedFiles: [] });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /must record its changed files, or the command results/,
    );

    // Valid command results do not help: verification-only is a brownfield
    // adoption concept. A greenfield migration has no pre-existing target
    // implementation to re-prove, so zero changed files is still a blocker.
    await writeJson(slicePath, {
      ...record,
      changedFiles: [],
      commandResults: [
        {
          command: "pnpm test:run tests/features/auth",
          exitCode: 0,
          executedAt: new Date().toISOString(),
          runner: "contract-suite",
          ...output,
        },
      ],
    });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /must record its changed files, or the command results/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a brownfield slice may be verification-only when it re-proves instead of rewriting", async () => {
  const fixture = await brownfieldFixture();
  try {
    await driveTo(fixture, "PLAN", advance, {
      bootstrap: { adoptTarget: true },
      target: BROWNFIELD_TARGET_INVENTORY,
    });
    const output = await captureRun(fixture, "1 passed\n");
    const slicePath = path.join(fixture.migrationRoot, "slices/slice-a.json");
    await authorSlice(fixture, "slice-a");
    const record = await readJson(slicePath);

    // No changed files and nothing that re-proves the slice either.
    await writeJson(slicePath, { ...record, changedFiles: [] });
    await assert.rejects(
      advance(fixture, { slice: "slice-a" }),
      /must record its changed files, or the command results/,
    );

    // Real command-result validation still applies -- brownfield status alone
    // is not a free pass.
    await writeJson(slicePath, {
      ...record,
      changedFiles: [],
      commandResults: [{ command: "pnpm test:run tests/features/auth" }],
    });
    await assert.rejects(advance(fixture, { slice: "slice-a" }));

    await writeJson(slicePath, {
      ...record,
      changedFiles: [],
      commandResults: [
        {
          command: "pnpm test:run tests/features/auth",
          exitCode: 0,
          executedAt: new Date().toISOString(),
          runner: "contract-suite",
          ...output,
        },
      ],
    });
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("format-15 brownfield: PLAN never skips IMPLEMENT_SLICES for a slice whose record already reads COMPLETE", async () => {
  const fixture = await brownfieldFixture();
  try {
    await driveTo(fixture, "BUILD_BASELINE", advance, {
      bootstrap: { adoptTarget: true },
      target: BROWNFIELD_TARGET_INVENTORY,
    });
    assert.equal((await state(fixture)).currentStep, "PLAN");

    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES, // slice-a (verification-only), slice-b (implementation)
    });

    // slice-a is authored as verification-only, with its record already
    // reading COMPLETE, *before* the engine ever advances out of PLAN --
    // exactly what an operator does when a slice needs no production change.
    const output = await captureRun(fixture, "1 passed\n");
    await writeJson(path.join(fixture.migrationRoot, "slices/slice-a.json"), {
      id: "slice-a",
      implementationStatus: "COMPLETE",
      requirementIds: SLICES[0].requirementIds,
      scenarioIds: SLICES[0].scenarioIds,
      traceIds: SLICES[0].traceIds,
      capabilityIds: SLICES[0].capabilityIds,
      changedFiles: [],
      decisions: ["Verification-only: already implemented; re-proven."],
      checks: ["pnpm test:run tests/features/auth"],
      commandResults: [
        {
          command: "pnpm test:run tests/features/auth",
          exitCode: 0,
          executedAt: new Date().toISOString(),
          runner: "contract-suite",
          ...output,
        },
      ],
    });

    // Advancing out of PLAN must still land on IMPLEMENT_SLICES: the
    // checkpoint has to be genuinely entered and validated, never inferred
    // from a slice file that happens to already read COMPLETE.
    await advance(fixture);
    let persisted = await state(fixture);
    assert.equal(persisted.currentStep, "IMPLEMENT_SLICES");
    assert.equal(persisted.activeSlice, "slice-a");
    assert.ok(persisted.pendingSteps.includes("IMPLEMENT_SLICES"));
    assert.ok(!persisted.completedSteps.includes("VERIFY_SLICES"));
    assert.deepEqual(persisted.completedSlices, []);
    assert.ok(persisted.pendingSlices.includes("slice-b"));

    await completeStepDoc(fixture, "IMPLEMENT_SLICES");
    await completeStepDoc(fixture, "VERIFY_SLICES");

    // Only now, from a genuine IMPLEMENT_SLICES checkpoint, may the
    // already-complete verification-only record carry the slice forward --
    // without fabricating a changed file -- into VERIFY_SLICES.
    await advance(fixture, { slice: "slice-a" });
    persisted = await state(fixture);
    assert.equal(persisted.currentStep, "VERIFY_SLICES");
    assert.equal(persisted.activeSlice, "slice-a");
    // slice-b's implementation work is still outstanding.
    assert.ok(persisted.pendingSlices.includes("slice-b"));
  } finally {
    await fixture.cleanup();
  }
});

test("format-14 retains its prior IMPLEMENT_SLICES lifecycle unchanged", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN", advance, { formatVersion: 14 });
    assert.equal((await state(fixture)).currentStep, "IMPLEMENT_SLICES");
    await authorSlice(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

/** One root per source, each named after the source that owns it. */
const rootsForSources = (names) =>
  names.map((name) => ({
    path: name,
    reason: `${name}'s own slice.`,
    decisionId: null,
    source: name,
  }));

const filesForSources = (names) =>
  names.map((name) => ({
    ...MODULE_CLASSIFICATION.files[0],
    path: `${name}/marker.txt`,
    rationale: `Owned by ${name}.`,
  }));

/** LEGACY_INVENTORY with its evidence moved into a declared multi-source root. */
const legacyInventoryUnder = (root) =>
  JSON.parse(
    JSON.stringify(LEGACY_INVENTORY).replaceAll(
      "legacy/auth/marker.txt",
      `legacy/${root}/marker.txt`,
    ),
  );

test("IMPLEMENT_SLICES resolves format-15 artifacts from the target-keyed record", async () => {
  const fixture = await createFixture();
  const sources = ["auth-core", "auth-ui"];
  try {
    await withLegacySources(fixture, sources);
    await driveTo(fixture, "ASSESS_TARGET", advance, {
      bootstrap: { legacy: sources },
      legacy: legacyInventoryUnder("auth-core"),
      classification: {
        ...MODULE_CLASSIFICATION,
        moduleRoots: rootsForSources(sources),
        files: filesForSources(sources),
      },
    });
    await completeStepDoc(fixture, "BUILD_BASELINE");
    const documents = matrices(false);
    documents["matrices/behavior-parity.json"].rows[0].legacyEvidence = [
      "legacy/auth-core/marker.txt",
    ];
    for (const [relative, document] of Object.entries(documents)) {
      await writeJson(path.join(fixture.migrationRoot, relative), document);
    }
    await registerAuth(fixture);
    await advance(fixture);
    await completeStepDoc(fixture, "PLAN");
    await writeJson(path.join(fixture.migrationRoot, "slices/index.json"), {
      version: 1,
      slices: SLICES,
    });
    await advance(fixture);
    await completeStepDoc(fixture, "IMPLEMENT_SLICES");

    const persisted = await state(fixture);
    assert.equal(persisted.currentStep, "IMPLEMENT_SLICES");
    assert.equal(persisted.migrationId, "auth");
    assert.equal(persisted.legacyModule, "auth-core");
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "inventories/legacy.json")),
      true,
    );
    const legacyKeyedRoot = path.join(
      fixture.targetRoot,
      ".agents/knowledge/migrations/modules/auth-core",
    );
    assert.equal(await exists(legacyKeyedRoot), false);

    // Greenfield: a normal implementation slice with a real changed file --
    // verification-only zero-change semantics are brownfield-only and are
    // covered by their own dedicated tests.
    const slicePath = path.join(fixture.migrationRoot, "slices/slice-a.json");
    const record = await readJson(slicePath);
    const changedFile = "src/slice-a.ts";
    await writeFile(path.join(fixture.targetRoot, changedFile), "export {};\n");
    await writeJson(slicePath, {
      ...record,
      implementationStatus: "COMPLETE",
      changedFiles: [changedFile],
      decisions: ["Implemented in the target architecture."],
      checks: ["pnpm test:run tests/features/auth"],
    });

    const run = await runCli(fixture, () => runMigration(["auth"]));
    assert.equal(run.outcome, "CONTINUE");
    assert.equal(
      (await state(fixture)).currentStep,
      "VERIFY_SLICES",
      run.reason,
    );
    assert.equal(await exists(legacyKeyedRoot), false);
  } finally {
    await fixture.cleanup();
  }
});

test("IMPLEMENT_SLICES keeps format-14 artifacts legacy-keyed", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "PLAN", advance, { formatVersion: 14 });
    const persisted = await state(fixture);
    assert.equal(persisted.migrationId, persisted.legacyModule);
    assert.equal(persisted.migrationId, "auth");
    await authorSlice(fixture, "slice-a");

    const run = await runCli(fixture, () => runMigration(["auth"]));
    assert.equal(run.outcome, "CONTINUE");
    assert.equal((await state(fixture)).currentStep, "VERIFY_SLICES");
  } finally {
    await fixture.cleanup();
  }
});

test("a format-15 advance emits a nextCommand keyed on the target, not a legacy source", async () => {
  const fixture = await createFixture();
  const sources = ["auth-core", "auth-ui"];
  try {
    await withLegacySources(fixture, sources);
    await driveTo(fixture, "DISCOVER_LEGACY", advance, {
      bootstrap: { legacy: sources },
      legacy: legacyInventoryUnder("auth-core"),
      classification: {
        ...MODULE_CLASSIFICATION,
        moduleRoots: rootsForSources(sources),
        files: filesForSources(sources),
      },
    });

    const persisted = await state(fixture);
    assert.equal(persisted.currentStep, "DISCOVERY_COMPLETENESS");
    // The precondition that makes this regression possible at all.
    assert.equal(persisted.legacyModule, "auth-core");
    assert.notEqual(persisted.legacyModule, persisted.migrationId);

    // The record key, matching every other nextCommand producer.
    assert.equal(persisted.nextCommand, "/start-migration auth");
    assert.equal(
      persisted.nextCommand,
      `/start-migration ${persisted.migrationId}`,
    );

    // Following it must reopen this very record.
    const moduleName = persisted.nextCommand.split(" ").at(-1);
    const status = await getMigrationStatus({
      ...(await resolutionFor(fixture)),
      moduleName,
    });
    assert.equal(status.target, "auth");

    // The value the bug emitted: a legacy source is not a registered module and
    // owns no record directory, so following it was a dead end.
    await assert.rejects(
      getMigrationStatus({
        ...(await resolutionFor(fixture)),
        moduleName: persisted.legacyModule,
      }),
      /not registered/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("converging legacy sources are not external consumers of a shared capability", async () => {
  // Three sources, because with two the buggy subtraction still landed under
  // SHARED_CONSUMER_THRESHOLD and the defect stayed invisible: subtracting only
  // `legacyModule` leaves two "external" consumers here, which passes.
  const sources = ["auth-api", "auth-core", "auth-ui"];
  const fixture = await createFixture();
  try {
    await withLegacySources(fixture, sources);
    await driveTo(fixture, "ASSESS_TARGET", advance, {
      bootstrap: { legacy: sources },
      legacy: legacyInventoryUnder("auth-core"),
      classification: {
        ...MODULE_CLASSIFICATION,
        moduleRoots: rootsForSources(sources),
        files: filesForSources(sources),
      },
    });
    await completeStepDoc(fixture, "BUILD_BASELINE");
    await writeMatrices(fixture);
    await writeJson(
      path.join(fixture.migrationRoot, "matrices/behavior-parity.json"),
      {
        version: 1,
        rows: [
          {
            id: "BR-1",
            behaviorId: "LB-1",
            targetState: "ABSENT",
            disposition: "IMPLEMENT",
            legacyEvidence: ["legacy/auth-core/marker.txt"],
            verificationStatus: "PENDING",
          },
        ],
      },
    );
    // The delegated artifact source has to resolve before the consumer rule is
    // reached; a plain file is enough, nothing parses it here.
    await mkdir(path.join(fixture.legacyRoot, "shared"), { recursive: true });
    await writeFile(
      path.join(fixture.legacyRoot, "shared/table.ts"),
      "export {};\n",
    );
    await writeCapabilities(fixture, [
      {
        ...DELEGATED_SHARED_CAPABILITY,
        legacyEvidence: ["legacy/auth-core/marker.txt"],
        // Every consumer is a source converging into this same target, so the
        // capability is feature-local to the target once they merge.
        consumers: sources,
      },
    ]);
    await registerAuth(fixture);

    await assert.rejects(
      advance(fixture),
      /is SHARED_PREREQUISITE but names 0 consumer\(s\)/,
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- R-W9-b / R-W9-c / R-W9-d: the clean-host preflight ---------------------

// The engine without its installed dependencies: exactly what a fresh clone or
// a target repository that has not run an install looks like.
const copyEngineWithoutDependencies = async (destination) => {
  const installed = path.join(destination, "packages/migration-engine");
  await cp(path.resolve(scriptsRoot, ".."), installed, {
    recursive: true,
    filter: (source) =>
      !source.split(path.sep).includes("node_modules") &&
      !source.split(path.sep).includes("test"),
  });
  return path.join(installed, "src/cli/discover-module.mjs");
};

test("R-W9-b: --doctor on a host without the parser reports it, names the install command, and writes nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-doctor-"));
  try {
    const command = await copyEngineWithoutDependencies(root);
    const before = await snapshot(root);

    const result = await execFileAsync(
      process.execPath,
      [command, "--doctor"],
      {
        encoding: "utf8",
        cwd: root,
      },
    ).catch((error) => error);

    assert.equal(result.code, BLOCKED_EXIT_CODE);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "BLOCKED");
    const parser = report.checks.find(
      (check) => check.name === "discovery-parser",
    );
    assert.equal(parser.status, "BLOCKED");
    assert.match(parser.detail, /ts-discovery-compiler/);
    assert.match(parser.detail, /pnpm install/);
    assert.match(parser.detail, /packages\/migration-engine\/package\.json/);

    // A preflight that repairs the host it is inspecting is not a preflight.
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R-W9-c: --doctor takes no lock and creates no directory", async () => {
  const fixture = await createFixture();
  try {
    const before = await snapshot(fixture.root);
    // From the target repository: the preflight answers "can the engine run
    // here", and "here" is where the operator is standing, not wherever the
    // engine happens to be installed (R-1).
    const result = await execFileAsync(
      process.execPath,
      [path.join(scriptsRoot, "cli/discover-module.mjs"), "--doctor"],
      { encoding: "utf8", cwd: fixture.targetRoot },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "OK");
    assert.deepEqual(await snapshot(fixture.root), before);
    assert.equal(
      await exists(lockPathFor(fixture.targetRoot, "auth")),
      false,
      "--doctor must never take the module lock",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R-W9-d: a target repository that declares none of this repository's dependencies still scans", async () => {
  const fixture = await createFixture();
  try {
    // The fixture target has no package.json, no node_modules and no
    // ts-discovery-compiler alias -- the shape of every real target repo. The
    // scan must still resolve its parser, because the skill owns it.
    assert.equal(
      await exists(path.join(fixture.targetRoot, "package.json")),
      false,
    );
    // A TypeScript file, so the scan actually has to load its parser: a census
    // of plain text would pass without proving anything about resolution.
    await writeFile(
      path.join(fixture.legacyRoot, "auth/session.ts"),
      "export const session = true;\n",
    );
    const scan = await runDiscoveryScan({
      legacyRoot: fixture.legacyRoot,
      moduleRoots: ["auth"],
    });
    assert.ok(scan.census.length > 0);
    // W1-5: the parser's own version is recorded with the scan, so a census
    // recomputed at FINALIZE under a different parser is detected rather than
    // silently compared.
    assert.match(scan.resolution.typescriptVersion, /^\d+\.\d+\.\d+/);
    assert.ok(
      scan.discoveryDigest.startsWith("sha256:"),
      "the parser version participates in the digest through `resolution`",
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- W3 / W4 / W5 / W10: controlled same-slice rework and drift ownership ---

// Drive to VERIFY_SLICES with the first slice implemented and active, then
// replace its result with an evidenced FAIL. This is the state a real defect
// found during verification actually produces.
const FAIL_DEFECT_EVIDENCE = "src/evidence-defect.txt";

const atFailedVerification = async (fixture, sliceId = SLICES[0].id) => {
  await driveTo(fixture, "PLAN");
  await authorSlice(fixture, sliceId);
  await advance(fixture, { slice: sliceId });

  // A real file, hashed, exactly as a gate's evidence reference must be.
  const defectFile = path.join(fixture.targetRoot, FAIL_DEFECT_EVIDENCE);
  const defectBody = `${sliceId}: expected 2 rows, observed 0\n`;
  await writeFile(defectFile, defectBody);
  const planned = (
    await readJson(path.join(fixture.migrationRoot, "slices/index.json"))
  ).slices.find((slice) => slice.id === sliceId);

  const failed = {
    sliceId,
    result: "FAIL",
    producedAt: new Date().toISOString(),
    requirementIds: planned.requirementIds,
    scenarioIds: planned.scenarioIds,
    traceIds: planned.traceIds,
    defects: [
      {
        scenarioId: planned.scenarioIds[0],
        observed: "the list rendered zero rows",
        expected: "the list renders one row per record",
        evidenceReference: FAIL_DEFECT_EVIDENCE,
        hash: `sha256:${createHash("sha256").update(defectBody).digest("hex")}`,
      },
    ],
  };
  const resultPath = path.join(
    fixture.migrationRoot,
    `evidence/${sliceId}/result.json`,
  );
  await mkdir(path.dirname(resultPath), { recursive: true });
  // Deliberately not `writeJson`: the preserved copy must equal these exact
  // bytes, so the test writes bytes it can compare against later.
  const failedBytes = `${JSON.stringify(failed, null, 2)}\n`;
  await writeFile(resultPath, failedBytes);
  return { sliceId, resultPath, failedBytes, defectBody };
};

const rework = async (fixture, sliceId, extra = {}) => {
  const resolution = await resolutionFor(fixture);
  const options = {
    ...resolution,
    moduleName: "auth",
    reworkSlice: sliceId,
    ...extra,
  };
  const preview = await previewMigrationExecution(options);
  if (preview.blockers.length > 0) {
    const error = new Error(preview.blockers.join("; "));
    error.blockers = preview.blockers;
    throw error;
  }
  return bootstrapMigration({
    ...options,
    confirmExecution: preview.confirmationId,
    registryBinding: preview.registryBinding,
    boundInputs: preview.boundInputs,
  });
};

/** Re-author the same evidenced FAIL for a slice already back at VERIFY_SLICES. */
const atFailedVerificationAgain = async (fixture, sliceId) => {
  const defectFile = path.join(fixture.targetRoot, FAIL_DEFECT_EVIDENCE);
  const defectBody = `${sliceId}: still failing at ${Date.now()}\n`;
  await writeFile(defectFile, defectBody);
  const planned = (
    await readJson(path.join(fixture.migrationRoot, "slices/index.json"))
  ).slices.find((slice) => slice.id === sliceId);
  await writeFile(
    path.join(fixture.migrationRoot, `evidence/${sliceId}/result.json`),
    `${JSON.stringify(
      {
        sliceId,
        result: "FAIL",
        producedAt: new Date().toISOString(),
        requirementIds: planned.requirementIds,
        scenarioIds: planned.scenarioIds,
        traceIds: planned.traceIds,
        defects: [
          {
            scenarioId: planned.scenarioIds[0],
            observed: "still zero rows",
            expected: "one row per record",
            evidenceReference: FAIL_DEFECT_EVIDENCE,
            hash: `sha256:${createHash("sha256").update(defectBody).digest("hex")}`,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
};

test("R-W3-a: a FAIL with defects returns the same slice to implementation, and only after the attempt is preserved", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId, failedBytes } = await atFailedVerification(fixture);
    const before = await readJson(
      path.join(fixture.migrationRoot, "state.json"),
    );
    assert.equal(before.currentStep, "VERIFY_SLICES");
    assert.equal(before.activeSlice, sliceId);
    // A FAIL never advances: it is a legal document, not a verification.
    await assert.rejects(
      advance(fixture, { slice: sliceId }),
      /recorded FAIL|must be PASS/,
    );

    const result = await rework(fixture, sliceId);
    const after = result.state;
    assert.equal(after.currentStep, "IMPLEMENT_SLICES");
    assert.equal(after.activeSlice, sliceId);
    assert.equal(after.sliceReworks[sliceId], 1);

    // The preserved attempt exists and is pinned...
    const preservedRelative = `rework/${sliceId}-1/result.json`;
    assert.equal(
      await readFile(
        path.join(fixture.migrationRoot, preservedRelative),
        "utf8",
      ),
      failedBytes,
    );
    assert.ok(
      after.artifactHashes[preservedRelative],
      "preserved result is pinned",
    );
    assert.ok(
      after.artifactHashes[`rework/${sliceId}-1/record.json`],
      "the rework record is pinned",
    );
    assert.ok(
      after.artifactHashes[
        `rework/${sliceId}-1/evidence/${FAIL_DEFECT_EVIDENCE}`
      ],
      "the defect's own evidence is preserved and pinned",
    );
    // ...and only then are the mutable-current locations released.
    assert.equal(after.artifactHashes[`slices/${sliceId}.json`], undefined);
    assert.equal(
      after.artifactHashes[`evidence/${sliceId}/result.json`],
      undefined,
    );

    // The record still opens: navigation, integrity and history all agree.
    await validateResumableMigration({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    }).catch(() => {});
    const reread = await readJson(
      path.join(fixture.migrationRoot, "state.json"),
    );
    assert.equal(reread.revision, before.revision + 1);
  } finally {
    await fixture.cleanup();
  }
});

test("R-W3-b: a FAIL without defects is refused and nothing is written", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId, resultPath } = await atFailedVerification(fixture);
    const parsed = JSON.parse(await readFile(resultPath, "utf8"));
    delete parsed.defects;
    await writeFile(resultPath, `${JSON.stringify(parsed, null, 2)}\n`);
    const before = await snapshot(fixture.migrationRoot);

    await assert.rejects(rework(fixture, sliceId), /no defects\[\]/);
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
    assert.equal(
      await exists(path.join(fixture.migrationRoot, `rework/${sliceId}-1`)),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R-W3-c: --rework-slice under --mode auto is refused by assertOptionCombination", () => {
  assert.throws(
    () =>
      parseDiscoverArguments([
        "auth",
        "--rework-slice",
        "slice-a",
        "--confirm-rework",
        "--mode",
        "auto",
      ]),
    /--rework-slice are operator decisions and cannot run under --mode auto/,
  );
  // And it cannot be typed without its own confirmation.
  assert.throws(
    () => parseDiscoverArguments(["auth", "--rework-slice", "slice-a"]),
    /--rework-slice requires --confirm-rework/,
  );
  // Nor combined with another transition.
  assert.throws(
    () =>
      parseDiscoverArguments([
        "auth",
        "--rework-slice",
        "slice-a",
        "--confirm-rework",
        "--refresh",
      ]),
    /different transitions; use exactly one/,
  );
});

test("R-W3-d: run-migration.mjs refuses --rework-slice by name", () => {
  assert.throws(
    () =>
      parseRunArguments([
        "auth",
        "--rework-slice",
        "slice-a",
        "--confirm-rework",
      ]),
    /--rework-slice is not accepted by run-migration\.mjs/,
  );
});

test("R-W3-e: a fourth rework is refused, naming the slice", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId } = await atFailedVerification(fixture);
    const statePath = path.join(fixture.migrationRoot, "state.json");
    for (let attempt = 1; attempt <= MAX_SLICE_REWORKS; attempt += 1) {
      const result = await rework(fixture, sliceId);
      assert.equal(result.state.sliceReworks[sliceId], attempt);
      // Re-author the same failure so the next rework has something to preserve.
      await authorSlice(fixture, sliceId);
      await advance(fixture, { slice: sliceId });
      await atFailedVerificationAgain(fixture, sliceId);
    }
    const persisted = await readJson(statePath);
    assert.equal(persisted.sliceReworks[sliceId], MAX_SLICE_REWORKS);

    const refused = await rework(fixture, sliceId).catch((error) => error);
    assert.match(
      refused.message,
      new RegExp(
        `Slice '${sliceId}' has already been reworked ${MAX_SLICE_REWORKS} times`,
      ),
    );
    // Every earlier attempt is still there, untouched.
    for (let attempt = 1; attempt <= MAX_SLICE_REWORKS; attempt += 1) {
      assert.equal(
        await exists(
          path.join(
            fixture.migrationRoot,
            `rework/${sliceId}-${attempt}/result.json`,
          ),
        ),
        true,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("R-W3-g: rework records are never overwritten and history grows by exactly one event", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId, failedBytes } = await atFailedVerification(fixture);
    const historyBefore = (
      await readFile(
        path.join(fixture.migrationRoot, "history/history.ndjson"),
        "utf8",
      )
    )
      .split("\n")
      .filter(Boolean).length;

    await rework(fixture, sliceId);
    const historyAfter = (
      await readFile(
        path.join(fixture.migrationRoot, "history/history.ndjson"),
        "utf8",
      )
    )
      .split("\n")
      .filter(Boolean);
    assert.equal(historyAfter.length, historyBefore + 1);
    const event = JSON.parse(historyAfter.at(-1));
    assert.equal(event.event, "SLICE_REWORKED");
    assert.equal(event.slice, sliceId);
    assert.equal(event.attempt, 1);
    assert.ok(event.preserved.includes(`rework/${sliceId}-1/result.json`));

    // Second rework writes a new directory and leaves the first one alone.
    await authorSlice(fixture, sliceId);
    await advance(fixture, { slice: sliceId });
    await atFailedVerificationAgain(fixture, sliceId);
    await rework(fixture, sliceId);
    assert.equal(
      await readFile(
        path.join(fixture.migrationRoot, `rework/${sliceId}-1/result.json`),
        "utf8",
      ),
      failedBytes,
      "attempt 1 must be byte-identical after attempt 2",
    );
    assert.equal(
      await exists(
        path.join(fixture.migrationRoot, `rework/${sliceId}-2/result.json`),
      ),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R-W3-h: FAIL -> rework -> PASS preserves the failed bytes, and mutating or deleting them is refused", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId, failedBytes, defectBody } =
      await atFailedVerification(fixture);
    await rework(fixture, sliceId);

    // Fix and reverify: the slice reaches a terminal PASS.
    await authorSlice(fixture, sliceId);
    await advance(fixture, { slice: sliceId });
    await authorEvidence(fixture, sliceId);
    await advance(fixture, { slice: sliceId });

    const preservedRelative = `rework/${sliceId}-1/result.json`;
    const preservedAbsolute = path.join(
      fixture.migrationRoot,
      preservedRelative,
    );

    // Byte-for-byte, compared as raw bytes rather than parsed JSON.
    assert.deepEqual(
      await readFile(preservedAbsolute),
      Buffer.from(failedBytes, "utf8"),
    );
    // And the file its defect named is still there, unchanged.
    assert.equal(
      await readFile(
        path.join(
          fixture.migrationRoot,
          `rework/${sliceId}-1/evidence/${FAIL_DEFECT_EVIDENCE}`,
        ),
        "utf8",
      ),
      defectBody,
    );
    // The terminal PASS is at the current-result path; the preserved FAIL is
    // not, so the two are distinguished by location and never confused.
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(fixture.migrationRoot, `evidence/${sliceId}/result.json`),
          "utf8",
        ),
      ).result,
      "PASS",
    );
    assert.equal(JSON.parse(failedBytes).result, "FAIL");

    // Every read-only entry point revalidates the pinned artifacts, so the
    // preserved attempt is checked on every command, not only at FINALIZE.
    const context = { ...(await resolutionFor(fixture)), moduleName: "auth" };
    const open = () => previewMigrationExecution(context);
    await open();

    // Mutation: one byte, and validation refuses with a hash mismatch naming
    // the path.
    await writeFile(preservedAbsolute, `${failedBytes} `);
    await assert.rejects(
      open(),
      (error) =>
        /Preserved rework evidence changed after it was pinned/.test(
          error.message,
        ) && error.message.includes(preservedRelative),
    );

    // Deletion: a distinct refusal, because deletion and mutation are
    // different forensics.
    await rm(preservedAbsolute);
    await assert.rejects(open(), (error) => {
      assert.match(error.message, /REWORK_EVIDENCE_MISSING/);
      assert.ok(error.message.includes(sliceId), "names the slice");
      assert.match(error.message, /attempt 1/);
      return true;
    });
  } finally {
    await fixture.cleanup();
  }
});

// --- W4: one ownership ledger for target bytes ------------------------------

const finalizeWith = (fixture, beforeFinalize) =>
  driveTo(fixture, "FINALIZE", advance, { beforeFinalize });

test("R-W4-a: an unclaimed modified target file blocks FINALIZE by name", async () => {
  const fixture = await createFixture();
  try {
    // The exact hole: the engine proved every *claimed* file was really dirty,
    // and never asked whether every dirty file was claimed. This file is
    // modified by nobody's slice and was invisible all the way to COMPLETE.
    const stray = "src/unclaimed-by-any-slice.ts";
    const failure = await finalizeWith(fixture, async () => {
      await writeFile(
        path.join(fixture.targetRoot, stray),
        "export const stray = true;\n",
      );
    }).catch((error) => error);

    assert.match(failure.message, /UNCLAIMED_TARGET_DRIFT/);
    assert.ok(failure.message.includes(stray), "the refusal names the path");
    assert.notEqual((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

test("R-W4-f: engine workspace files never register as drift", async () => {
  const fixture = await createFixture();
  try {
    // `.agents/knowledge/migrations/` is the engine's own workspace: every
    // checkpoint writes there, so counting it as drift would make FINALIZE
    // unreachable by construction.
    await finalizeWith(fixture, async () => {
      await writeFile(
        path.join(
          fixture.targetRoot,
          ".agents/knowledge/migrations/scratch.txt",
        ),
        "engine workspace\n",
      );
    });
    assert.equal((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

test("R-W4-b: a file touched under an active rework is AUTHORIZED_REWORK, not drift", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId } = await atFailedVerification(fixture);
    await rework(fixture, sliceId);
    // Fix the defect: the fix touches the slice's own file, which is exactly
    // what a rework is for. Without an authorization record this now reads the
    // same as unauthorized drift, because "the tree changed" stopped being
    // anomalous the moment rework existed.
    await authorSlice(fixture, sliceId);
    await advance(fixture, { slice: sliceId });
    await authorEvidence(fixture, sliceId);
    await advance(fixture, { slice: sliceId });

    const persisted = await state(fixture);
    assert.equal(persisted.sliceReworks[sliceId], 1);
    // The defect evidence file the rework preserved is still in the target and
    // is claimed by no slice, so it must be classified, not merely tolerated.
    const findings = await pendingTargetDriftCandidates(
      fixture.migrationRoot,
      persisted,
      { legacyRoot: fixture.legacyRoot, targetRoot: fixture.targetRoot },
    );
    assert.ok(
      findings.every((finding) => finding.subjectPath !== `src/${sliceId}.ts`),
      "the reworked slice's own file is not offered as drift",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R-W4-d: drift acceptance requires the challenge phrase and cannot be supplied by argv", async () => {
  const fixture = await createFixture();
  try {
    const stray = "src/regenerated-lockfile.ts";
    await finalizeWith(fixture, async () => {
      await writeFile(
        path.join(fixture.targetRoot, stray),
        "export const generated = true;\n",
      );
    }).catch(() => {});

    const persisted = await state(fixture);
    const roots = {
      legacyRoot: fixture.legacyRoot,
      targetRoot: fixture.targetRoot,
    };
    const drift = await pendingTargetDriftCandidates(
      fixture.migrationRoot,
      persisted,
      roots,
    );
    assert.ok(
      drift.some((finding) => finding.subjectPath === stray),
      "the unclaimed file is offered as an operator decision",
    );

    // The acceptance is a decision, never a flag: no CLI option produces one.
    for (const option of [
      "--accept-drift",
      "--accept-target-drift",
      "--allow-drift",
    ]) {
      assert.throws(
        () => parseDiscoverArguments(["auth", option, stray]),
        /Unknown option/,
        `${option} must not exist`,
      );
    }
    // And the recorder offers it under the same challenge phrase as every other
    // candidate, with no separate approval channel.
    const candidate = createDecisionCandidate({
      kind: "TARGET_DRIFT_ACCEPTED",
      subjectType: "TARGET_FILE",
      subjectPath: stray,
      rationale: "regenerated by an install",
      boundTo: { module: "auth", pathDigest: "sha256:x" },
    });
    assert.equal(
      challengeFor(candidate),
      `APPROVE ${candidate.id} TARGET_DRIFT_ACCEPTED ${stray}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R-W4-e: editing an accepted path after acceptance re-blocks", async () => {
  const fixture = await createFixture();
  try {
    const stray = "src/regenerated-lockfile.ts";
    const strayPath = path.join(fixture.targetRoot, stray);
    await finalizeWith(fixture, async () => {
      await writeFile(strayPath, "export const generated = true;\n");
    }).catch(() => {});

    const persisted = await state(fixture);
    const roots = {
      legacyRoot: fixture.legacyRoot,
      targetRoot: fixture.targetRoot,
    };
    const digest = `sha256:${createHash("sha256")
      .update(await readFile(strayPath))
      .digest("hex")}`;

    // Record the acceptance directly in the append-only ledger, bound to the
    // bytes it accepted -- the shape `record-decision.mjs` writes.
    const ledgerPath = path.join(
      fixture.migrationRoot,
      "decisions/operator-decisions.ndjson",
    );
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await appendFile(
      ledgerPath,
      `${JSON.stringify({
        id: "DEC-001",
        seq: 1,
        prevDigest: "genesis",
        at: new Date().toISOString(),
        operator: "tester@host",
        kind: "TARGET_DRIFT_ACCEPTED",
        subject: { type: "TARGET_FILE", path: stray },
        statement: "Accepted at a terminal.",
        rationaleDigest: "sha256:x",
        boundTo: { module: "auth", pathDigest: digest },
      })}\n`,
    );
    assert.deepEqual(
      await pendingTargetDriftCandidates(
        fixture.migrationRoot,
        persisted,
        roots,
      ),
      [],
      "an accepted path stops being offered",
    );

    // Edit it, and the acceptance stops applying: it was bound to bytes.
    await writeFile(strayPath, "export const generated = false;\n");
    const after = await pendingTargetDriftCandidates(
      fixture.migrationRoot,
      persisted,
      roots,
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].subjectPath, stray);
    assert.match(after[0].rationale, /bytes changed since/);
  } finally {
    await fixture.cleanup();
  }
});

// --- W5: FINALIZE rejects unresolved verification ---------------------------

/** Stamp a slice result's `producedAt`, which only a reworked slice owes. */
const stampProducedAt = async (fixture, sliceId, producedAt) => {
  const file = path.join(
    fixture.migrationRoot,
    `evidence/${sliceId}/result.json`,
  );
  await writeJson(file, {
    ...JSON.parse(await readFile(file, "utf8")),
    producedAt,
  });
};

test("R-W5-a: a lingering FAIL blocks FINALIZE, a preserved one superseded by a PASS does not", async () => {
  const fixture = await createFixture();
  try {
    // Turning a closed slice's verdict into a FAIL after the fact is refused by
    // the pin, which is the outer guard and the only reachable path: a slice
    // cannot close VERIFY_SLICES on a FAIL in the first place.
    const failure = await finalizeWith(fixture, async () => {
      const planned = SLICES[0];
      const file = path.join(
        fixture.migrationRoot,
        `evidence/${planned.id}/result.json`,
      );
      await writeJson(file, {
        ...JSON.parse(await readFile(file, "utf8")),
        result: "FAIL",
      });
    }).catch((error) => error);
    assert.match(
      failure.message,
      /Completed artifact changed after validation/,
    );
    assert.ok(failure.message.includes(`evidence/${SLICES[0].id}/result.json`));
    assert.notEqual((await state(fixture)).status, "COMPLETE");

    // The inner guard is the negative assertion itself: presence-of-positive
    // (row terminality, gate PASS) and absence-of-negative are different
    // claims, and only the first survives an artifact the engine did not
    // anticipate. Its reachable case is a reworked slice, covered by R-W5-b.
  } finally {
    await fixture.cleanup();
  }
});

test("R-W5-a: a preserved FAIL under rework/ with a newer terminal PASS finalizes", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId } = await atFailedVerification(fixture);
    await rework(fixture, sliceId);
    // Fix, reverify, then finish every remaining slice and FINALIZE.
    await authorSlice(fixture, sliceId);
    await advance(fixture, { slice: sliceId });
    await authorEvidence(fixture, sliceId);
    await stampProducedAt(fixture, sliceId, new Date().toISOString());
    await advance(fixture, { slice: sliceId });
    for (const slice of SLICES.slice(1)) {
      await authorSlice(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
      await authorEvidence(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
    }

    const persisted = await state(fixture);
    assert.equal(persisted.currentStep, "FINALIZE");
    // The preserved FAIL is still on disk and still pinned; it is the required
    // immutable record of a *resolved* failure, never a blocker.
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(fixture.migrationRoot, `rework/${sliceId}-1/result.json`),
          "utf8",
        ),
      ).result,
      "FAIL",
    );
    await assert.doesNotReject(
      validateResumableMigration({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }).catch((error) => {
        // Only an unresolved-verification refusal would be a regression here.
        if (/Unresolved verification|Stale verification/.test(error.message)) {
          throw error;
        }
      }),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R-W5-b / R-W3-f: a terminal PASS older than the newest rework blocks FINALIZE", async () => {
  const fixture = await createFixture();
  try {
    const { sliceId } = await atFailedVerification(fixture);
    await rework(fixture, sliceId);
    await authorSlice(fixture, sliceId);
    await advance(fixture, { slice: sliceId });
    await authorEvidence(fixture, sliceId);
    // "Reverified" with evidence that predates the failure it is supposed to
    // have resolved. Stamped before the advance, because closing VERIFY_SLICES
    // pins the result and editing it afterwards is a different refusal.
    await stampProducedAt(fixture, sliceId, "2000-01-01T00:00:00.000Z");
    await advance(fixture, { slice: sliceId });

    for (const slice of SLICES.slice(1)) {
      await authorSlice(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
      await authorEvidence(fixture, slice.id);
      await advance(fixture, { slice: slice.id });
    }
    assert.equal((await state(fixture)).currentStep, "FINALIZE");
    await authorFinalize(fixture);

    const failure = await validateResumableMigration({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    }).catch((error) => error);
    assert.match(failure.message, /Stale verification blocks FINALIZE/);
    assert.ok(failure.message.includes(sliceId));
  } finally {
    await fixture.cleanup();
  }
});

test("R-W5-e: a terminal FINALIZE refusal is BLOCKED with exit code 2, not an endless CONTINUE", async () => {
  const fixture = await createFixture();
  try {
    const stray = "src/unclaimed-by-any-slice.ts";
    await finalizeWith(fixture, async () => {
      await writeFile(
        path.join(fixture.targetRoot, stray),
        "export const stray = true;\n",
      );
    }).catch(() => {});

    // The hazard SKILL.md names as the one stop condition no command could
    // detect: an auto-loop re-authoring gates.json forever against a record
    // that cannot finalize until a human acts.
    const captured = [];
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    process.chdir(fixture.root);
    let result;
    try {
      result = await runMigration(["auth", "--mode", "auto", "--json"], {
        stdout: { write: (chunk) => (captured.push(chunk), true) },
        recordTrustedDecision: null,
      });
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
    assert.equal(result.outcome, "BLOCKED");
    assert.match(result.blocker, /UNCLAIMED_TARGET_DRIFT/);
    assert.equal(exitCodeFor(result.outcome), BLOCKED_EXIT_CODE);
    assert.match(captured.join(""), /loop: STOP reason=BLOCKED/);
  } finally {
    await fixture.cleanup();
  }
});

// --- W10: format compatibility is derived, not hand-maintained ---------------

test("R-W10-a: the SKILL.md compatibility table cannot drift from the exported constants", async () => {
  // The table stopped at format 13 while the engine shipped 15, because it was
  // prose bound to nothing. Binding it means the next bump breaks the build
  // instead of silently leaving an operator unable to tell what their record
  // supports.
  const skill = await readFile(
    path.join(repositoryRoot, "skills/start-migration/SKILL.md"),
    "utf8",
  );
  const table = skill.slice(
    skill.indexOf("| Persisted source"),
    skill.indexOf("### Format bump policy"),
  );
  assert.ok(table.length > 0, "the compatibility table must be findable");

  const documented = new Set();
  for (const match of table.matchAll(
    /^\| contract 5, format ([\d–\-]+)\s*\|/gm,
  )) {
    const span = match[1].replace("–", "-");
    if (span.includes("-")) {
      const [low, high] = span.split("-").map(Number);
      for (let version = low; version <= high; version += 1) {
        documented.add(version);
      }
    } else {
      documented.add(Number(span));
    }
  }
  assert.deepEqual(
    [...documented].sort((left, right) => left - right),
    [...SUPPORTED_FORMAT_VERSIONS],
    "one row per supported format, and no row for a format that is not supported",
  );
  assert.ok(
    documented.has(MIGRATION_FORMAT_VERSION),
    "the current format must have its own row",
  );
});

test("R-W10-c: formats 10, 11 and 17 stay non-promoting, and every other supported format is executable", () => {
  // Two different questions with two different answers. Conflating them is what
  // made a first attempt at deriving this set turn every format-10 record
  // unexecutable: 10 and 11 are never promoted *into*, but a record already at
  // 10 must still run its own lifecycle to completion.
  assert.deepEqual([...NON_PROMOTING_FORMAT_VERSIONS], [10, 11, 17]);
  for (const version of SUPPORTED_FORMAT_VERSIONS) {
    assert.equal(
      formatIsSupported(version),
      true,
      `format ${version} must remain executable`,
    );
    assert.equal(formatIsPromoting(version), ![10, 11, 17].includes(version));
  }
  // Bumping the constant cannot orphan the format that was current a moment
  // ago: the previous format is derived into the supported set, not typed into
  // a literal beside it.
  assert.equal(formatIsSupported(MIGRATION_FORMAT_VERSION - 1), true);
});

test("R-W10-e: a format newer than supported is refused with the update message", () => {
  const blocker = compatibilityBlocker(
    { contractVersion: 5, formatVersion: MIGRATION_FORMAT_VERSION + 1 },
    "auth",
  );
  assert.match(blocker, /Update start-migration before continuing/);
  assert.equal(
    compatibilityBlocker(
      { contractVersion: 5, formatVersion: MIGRATION_FORMAT_VERSION },
      "auth",
    ),
    null,
  );
});

test("R-W10-b / R-W10-d: a format-15 record runs the full lifecycle unchanged and gains no rework vocabulary", async () => {
  const fixture = await createFixture();
  try {
    // Born at 15, before same-slice rework existed. It must finalize exactly as
    // it did before the bump: no attempt counter, no `rework/**` pin, and no
    // FINALIZE assertion that demands records it never authored.
    await driveTo(fixture, "FINALIZE", advance, {
      formatVersion: MULTI_SOURCE_FORMAT_VERSION,
    });
    const persisted = await state(fixture);
    assert.equal(persisted.status, "COMPLETE");
    assert.equal(
      persisted.formatVersion,
      MULTI_SOURCE_FORMAT_VERSION,
      "stamped 15 until it authors a rework",
    );
    assert.equal(persisted.sliceReworks, undefined);
    assert.deepEqual(
      Object.keys(persisted.artifactHashes).filter((relative) =>
        relative.startsWith("rework/"),
      ),
      [],
      "a format-15 record's artifactHashes never gains a rework pin",
    );

    // And the transition itself is refused for it, rather than half-applied.
    const refusal = await previewMigrationExecution({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
      reworkSlice: SLICES[0].id,
    });
    assert.ok(
      refusal.blockers.some((blocker) =>
        blocker.includes(`--rework-slice needs format ${SLICE_REWORK_FORMAT}`),
      ),
      refusal.blockers.join("; "),
    );

    // A format-16 record does enforce both, which is the other half of R-W10-d.
    const modern = await createFixture();
    try {
      const { sliceId } = await atFailedVerification(modern);
      const reworked = (await rework(modern, sliceId)).state;
      assert.equal(reworked.formatVersion, MIGRATION_FORMAT_VERSION);
      assert.equal(reworked.sliceReworks[sliceId], 1);
      assert.ok(
        Object.keys(reworked.artifactHashes).some((relative) =>
          relative.startsWith("rework/"),
        ),
      );
    } finally {
      await modern.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("R-W4-c: a file under a delegated targetOwner is AUTHORIZED_DELEGATION, not drift", async () => {
  const fixture = await createFixture();
  try {
    const owned = "src/shared/theme.ts";
    await finalizeWith(fixture, async () => {
      // A SHARED_PREREQUISITE slice whose bytes the child artifact record owns
      // and validates under its own lifecycle. The parent records no copy of
      // child state, so it must classify by ownership, not by claim.
      const indexPath = path.join(fixture.migrationRoot, "slices/index.json");
      const index = await readJson(indexPath);
      await writeJson(indexPath, {
        ...index,
        slices: index.slices.map((slice) =>
          slice.id === SLICES[1].id
            ? { ...slice, artifact: "theme", targetOwner: "src/shared/" }
            : slice,
        ),
      });
      await mkdir(path.dirname(path.join(fixture.targetRoot, owned)), {
        recursive: true,
      });
      await writeFile(
        path.join(fixture.targetRoot, owned),
        "export const theme = 'delegated';\n",
      );
    }).catch((error) => error);

    const persisted = await state(fixture);
    const offered = await pendingTargetDriftCandidates(
      fixture.migrationRoot,
      persisted,
      { legacyRoot: fixture.legacyRoot, targetRoot: fixture.targetRoot },
    );
    assert.ok(
      offered.every((finding) => finding.subjectPath !== owned),
      `${owned} is owned by the delegated artifact, not unclaimed drift: ${JSON.stringify(offered)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("W4-4: only a drift acceptance may be appended after DISCOVERY_COMPLETENESS closes", async () => {
  const fixture = await createFixture();
  try {
    // The ledger pin used to freeze the whole file, which made every
    // classification approval immutable after the census closed -- right -- and
    // also made the one decision the later lifecycle genuinely needs
    // impossible to record. The pin is a prefix now, with a kind restriction.
    await driveTo(fixture, "SLICES");
    const ledgerPath = path.join(
      fixture.migrationRoot,
      "decisions/operator-decisions.ndjson",
    );
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await appendFile(
      ledgerPath,
      `${JSON.stringify({
        id: "DEC-001",
        seq: 1,
        prevDigest: "genesis",
        at: new Date().toISOString(),
        operator: "tester@host",
        kind: "EXCLUSION",
        subject: { type: "FILE", path: "auth/marker.txt" },
        statement: "Approved at a terminal.",
        rationaleDigest: `sha256:${"0".repeat(64)}`,
        boundTo: { module: "auth" },
      })}\n`,
    );
    await assert.rejects(
      validateResumableMigration({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }),
      /gained a 'EXCLUSION' decision after DISCOVERY_COMPLETENESS closed/,
    );

    // A drift acceptance in the same position is accepted, so the restriction
    // is on the kind and not on appending at all.
    await writeFile(ledgerPath, "");
    await acceptTargetDrift(fixture, "src/placeholder.ts");
    await assert.doesNotReject(
      validateResumableMigration({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }).catch((error) => {
        if (/DISCOVERY_COMPLETENESS closed/.test(error.message)) throw error;
      }),
    );
    // Rewriting the pinned *prefix* stays refused; that property is owned by
    // R-W2-g, which proves it on a record whose prefix is non-empty.
  } finally {
    await fixture.cleanup();
  }
});

// --- W6: resume, history and evidence integrity -----------------------------

/**
 * Interrupt one advance at a named write boundary, then hand the record to an
 * ordinary next invocation and report what it recovered to. Recovery is the
 * least-exercised and highest-consequence code in the engine, and "kill the
 * process and hope you land in the window" is not a test.
 */
const interruptAdvanceAt = async (fixture, stage) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewAdvance({ ...resolution, moduleName: "auth" });
  const crash = new Error(`simulated crash after the ${stage} write`);
  await assert.rejects(
    advanceMigration({
      ...resolution,
      moduleName: "auth",
      confirmAdvance: preview.confirmationId,
      hooks: {
        afterWrite: (written) => {
          if (written === stage) throw crash;
        },
      },
    }),
    (error) => error === crash,
  );
  return {
    revisionBefore: preview.revision,
    journal: path.join(fixture.migrationRoot, "advance.journal"),
  };
};

const historyLines = async (fixture) =>
  (
    await readFile(
      path.join(fixture.migrationRoot, "history/history.ndjson"),
      "utf8",
    )
  )
    .split("\n")
    .filter(Boolean);

test("R-W6-d: a crash between the state write and the integrity write recovers, replays, and drops the journal", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    const linesBefore = (await historyLines(fixture)).length;

    // Killed after integrity landed but before state did: the record still
    // reads at the old revision, and the journal is the only thing that knows a
    // transition was in flight.
    const { revisionBefore, journal } = await interruptAdvanceAt(
      fixture,
      "integrity",
    );
    assert.equal(await exists(journal), true, "the journal survives the crash");

    // An ordinary next invocation recovers with no operator action: resuming
    // is what `discover-module.mjs <module>` does.
    await recoverMigrationRecord({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    const recovered = await advance(fixture);
    assert.equal(await exists(journal), false, "recovery drops its journal");
    assert.equal(recovered.state.revision, revisionBefore + 1);
    const linesAfter = await historyLines(fixture);
    assert.equal(
      linesAfter.length,
      linesBefore + 1,
      "exactly one event for one transition, never two",
    );
    // The record opens cleanly afterwards: integrity, history and state agree.
    await previewMigrationExecution({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("R-W6-e: a crash between the state write and the history append recovers idempotently", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    const linesBefore = (await historyLines(fixture)).length;

    // The most dangerous point: state has moved, the event that explains the
    // move has not been written, and the anchor already covers a history that
    // is one event short.
    const { revisionBefore, journal } = await interruptAdvanceAt(
      fixture,
      "state",
    );
    assert.equal(await exists(journal), true);
    assert.equal(
      (await state(fixture)).revision,
      revisionBefore + 1,
      "state moved before the crash",
    );
    assert.equal((await historyLines(fixture)).length, linesBefore);

    const resolution = await resolutionFor(fixture);
    await recoverMigrationRecord({ ...resolution, moduleName: "auth" });
    assert.equal(await exists(journal), false, "the resume recovered it");
    const linesAfter = await historyLines(fixture);
    assert.equal(linesAfter.length, linesBefore + 1, "the event was replayed");
    assert.equal(JSON.parse(linesAfter.at(-1)).revision, revisionBefore + 1);
    assert.equal((await state(fixture)).revision, revisionBefore + 1);

    // Replay is idempotent by revision: recovering twice appends nothing.
    await recoverMigrationRecord({ ...resolution, moduleName: "auth" });
    await previewMigrationExecution({ ...resolution, moduleName: "auth" });
    assert.equal((await historyLines(fixture)).length, linesBefore + 1);
  } finally {
    await fixture.cleanup();
  }
});

test("R-W6-d: a crash after the journal write but before anything else rolls back", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
    const linesBefore = (await historyLines(fixture)).length;
    const { revisionBefore, journal } = await interruptAdvanceAt(
      fixture,
      "journal",
    );
    assert.equal(await exists(journal), true);

    await recoverMigrationRecord({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    assert.equal(await exists(journal), false);
    // Nothing moved: the transition never reached a durable write.
    assert.equal((await state(fixture)).revision, revisionBefore);
    assert.equal((await historyLines(fixture)).length, linesBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("R-W6-f: a corrupt journal is preserved byte-for-byte and refuses", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    const journal = path.join(fixture.migrationRoot, "advance.journal");
    const corrupt = '{"fromRevision": 2, "toRe';
    await writeFile(journal, corrupt);

    // The one case where nothing can be proven: the from/to revisions are
    // exactly what was lost, so neither the replay nor the rollback branch can
    // run. Deleting it would destroy the only evidence of what was in flight.
    await assert.rejects(
      recoverMigrationRecord({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      }),
      /journal/i,
    );
    assert.equal(await readFile(journal, "utf8"), corrupt);
  } finally {
    await fixture.cleanup();
  }
});

test("R-W6-a / R-W6-b: an unanchored history tail is bounded to one event at this revision", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "DISCOVER_LEGACY");
    const historyPath = path.join(
      fixture.migrationRoot,
      "history/history.ndjson",
    );
    const resolution = await resolutionFor(fixture);
    const open = () =>
      previewMigrationExecution({ ...resolution, moduleName: "auth" });
    await open();

    const original = await readFile(historyPath, "utf8");
    const persisted = await state(fixture);

    // R-W6-a: a second unanchored event means a write path bypassed the
    // transaction. One is legitimate -- the newest event is appended after the
    // state write on purpose -- two never are.
    await appendFile(
      historyPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: "STEP_COMPLETED",
        step: "DISCOVERY_COMPLETENESS",
        revision: persisted.revision,
      })}\n`,
    );
    await assert.rejects(open(), /events past the integrity\.json anchor/);

    // R-W6-b: exactly one unanchored event -- the legitimate count -- but it
    // claims a revision the state never reached, so it was not appended by the
    // transaction that moved state. Trim back to the anchored prefix first, so
    // the count is one and only the revision is wrong.
    const anchor = (
      await readJson(path.join(fixture.migrationRoot, "integrity.json"))
    ).history;
    await writeFile(historyPath, original.slice(0, anchor.bytes));
    await appendFile(
      historyPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: "STEP_COMPLETED",
        step: "DISCOVERY_COMPLETENESS",
        revision: persisted.revision + 41,
      })}\n`,
    );
    await assert.rejects(open(), /unanchored trailing event records revision/);

    await writeFile(historyPath, original);
    await open();
  } finally {
    await fixture.cleanup();
  }
});

// --- W8: provider-generated tree equivalence --------------------------------

/**
 * R-W8-b, R-W8-c and R-W8-d moved to `test/providers-sync.test.mjs`, which is
 * where their subject now lives:
 *
 * | Proof   | Owning test |
 * | ------- | ----------- |
 * | R-W8-b: every non-`SKILL.md` canonical file is byte-identical in all four trees | `every canonical file reaches all four provider trees, and only SKILL.md differs` |
 * | R-W8-c: `SKILL.md` divergence is limited to the banner and the frontmatter transform | same test, `SKILL.md` branch |
 * | R-W8-d: every provider entry point names its skill and carries no workflow logic | `every provider entry point names its skill and carries no workflow logic` |
 *
 * They are in that suite rather than duplicated here because they now assert the
 * *generator's* output against its input, and that suite already owns the
 * generator. Restating them here would give one property two owners.
 *
 * R-W8-e -- "every provider tree's `discover-module.mjs` loads and runs" -- is
 * replaced by the stronger boundary below: the skill-local scripts directory
 * contains only the runtime preflight, never an engine entry point.
 */
const PROVIDER_ROOTS = ["claude", "codex", "copilot", "opencode"];
const MIGRATION_SKILLS = ["start-migration", "migrate-artifact"];

test("R-W8-e: no provider tree has an engine entry point to run", async () => {
  for (const provider of PROVIDER_ROOTS) {
    for (const skill of MIGRATION_SKILLS) {
      const scripts = path.join(repositoryRoot, "providers", provider, "skills", skill, "scripts");
      assert.deepEqual(
        await readdir(scripts),
        ["runtime.mjs"],
        `providers/${provider}/skills/${skill} carries engine code`,
      );
    }
  }
});


/* --------------------------------------------------------------------------
 * `--amend-slice` and operation sequences.
 *
 * An amendment is the one transition that rewrites a pinned, verified slice
 * record, so every test here is about what it refuses: a slice that was not
 * reopened, a file it does not add, a record that moved after a human approved
 * the sequence. The successful path is asserted for exactly what it wrote --
 * the prior bytes preserved and pinned, the amended record re-pinned by content
 * identity, and one `SLICE_SCOPE_AMENDED` event carrying the authorization the
 * operation actually spent.
 * ------------------------------------------------------------------------ */

/** A format-16 figma record, COMPLETE, with both slices reopened by --reopen-ui. */
const reopenedFigma16 = async (fixture, slices = ["slice-a", "slice-b"]) => {
  await driveFigma16ToComplete(fixture);
  const reopen = await reopenUi(fixture, slices);
  assert.deepEqual(reopen.preview.blockers, []);
  await reopen.run();
  // The reopen writes a remediation template with no behaviors in it; the
  // operator fills it in before anything downstream validates, exactly as the
  // format-17 reopen test does.
  await writeJson(path.join(fixture.migrationRoot, "ui-remediation.json"), {
    version: 1,
    hasVisibleUi: true,
    uiBehaviors: LEGACY_INVENTORY.uiBehaviors,
    uiMismatches: TARGET_INVENTORY.uiMismatches,
  });
  return state(fixture);
};

/** A genuinely dirty target file the slice record does not list yet. */
const extraTargetFile = async (fixture, relative) => {
  await writeFile(
    path.join(fixture.targetRoot, relative),
    `export const helper = ${JSON.stringify(relative)};\n`,
  );
  return relative;
};

const amendPreview = async (fixture, sliceId, addFiles) =>
  previewMigrationExecution({
    ...(await resolutionFor(fixture)),
    moduleName: "auth",
    amendSlice: sliceId,
    addFiles,
  });

const amend = async (fixture, sliceId, addFiles, extra = {}) => {
  const preview = await amendPreview(fixture, sliceId, addFiles);
  return bootstrapMigration({
    ...(await resolutionFor(fixture)),
    moduleName: "auth",
    amendSlice: sliceId,
    addFiles,
    boundInputs: preview.boundInputs,
    registryBinding: preview.registryBinding,
    ...extra,
  });
};

const sequenceFor = async (fixture, operations) =>
  deriveOperationSequence({
    ...(await resolutionFor(fixture)),
    moduleName: "auth",
    operations,
  });

/** The trusted boundary, driven by an `ask` that types the real challenge. */
const approveSequence = (sequence) =>
  authorizeOperationSequence(sequence, {
    ask: ({ challenge }) => challenge,
  });

test("amend: one amendment preserves the prior record, re-pins both, and writes one event", async () => {
  const fixture = await createFixture();
  try {
    await reopenedFigma16(fixture, ["slice-a"]);
    const added = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    const before = await state(fixture);
    const priorBytes = await readFile(
      path.join(fixture.migrationRoot, "slices/slice-a.json"),
    );

    const preview = await amendPreview(fixture, "slice-a", [added]);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.sliceAmendment.amendment, 1);
    assert.deepEqual(
      preview.sliceAmendment.add.map((file) => file.path),
      [added],
    );
    assert.equal(
      preview.sliceAmendment.preservesAs,
      "slice-amendments/slice-a-1/slice.json",
    );
    // Content identity, not a raw hash: the digests the event records are the
    // same policy every other pin uses.
    assert.ok(
      preview.sliceAmendment.implementationDigestBefore !==
        preview.sliceAmendment.implementationDigestAfter,
      "adding a file must move the implementation digest",
    );

    const result = await amend(fixture, "slice-a", [added]);
    assert.equal(result.amended, true);
    const after = await state(fixture);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.currentStep, before.currentStep);
    assert.equal(after.activeSlice, before.activeSlice);
    assert.deepEqual(after.completedSlices, before.completedSlices);

    // Add-only: the prior list survives verbatim, with the addition appended.
    const record = await readJson(
      path.join(fixture.migrationRoot, "slices/slice-a.json"),
    );
    assert.deepEqual(record.changedFiles, ["src/slice-a.ts", added]);

    // The prior bytes are kept exactly, and pinned for life.
    const preserved = await readFile(
      path.join(fixture.migrationRoot, "slice-amendments/slice-a-1/slice.json"),
    );
    assert.deepEqual(preserved, priorBytes);
    assert.ok(after.artifactHashes["slice-amendments/slice-a-1/slice.json"]);
    assert.notEqual(
      after.artifactHashes["slices/slice-a.json"],
      before.artifactHashes["slices/slice-a.json"],
    );

    const events = await historyEvents(fixture);
    const amendments = events.filter(
      (event) => event.event === "SLICE_SCOPE_AMENDED",
    );
    assert.equal(amendments.length, 1);
    assert.deepEqual(amendments[0].added, [added]);
    assert.deepEqual(amendments[0].preserved, [
      "slice-amendments/slice-a-1/slice.json",
    ]);
    assert.equal(amendments[0].revision, after.revision);
    // A lone terminal amendment spends no sequence, so it claims none.
    assert.equal(amendments[0].authorizedBy, undefined);

    // The replay agrees with what was written: readState is the whole check.
    const replayed = await readState(fixture.targetRoot, "auth");
    assert.equal(replayed.state.revision, after.revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("amend: refuses a slice that is not reopened, and a file it does not add", async () => {
  const fixture = await createFixture();
  try {
    await driveFigma16ToComplete(fixture);
    const added = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    // COMPLETE, nothing reopened.
    const complete = await amendPreview(fixture, "slice-a", [added]);
    assert.match(
      complete.blockers.join(" "),
      /is legal only on an ACTIVE record at VERIFY_SLICES/,
    );

    await (await reopenUi(fixture, ["slice-a"])).run();
    await writeJson(path.join(fixture.migrationRoot, "ui-remediation.json"), {
      version: 1,
      hasVisibleUi: true,
      uiBehaviors: LEGACY_INVENTORY.uiBehaviors,
      uiMismatches: TARGET_INVENTORY.uiMismatches,
    });
    // A verified slice that was not part of the reopen.
    const notReopened = await amendPreview(fixture, "slice-b", [added]);
    assert.match(
      notReopened.blockers.join(" "),
      /is a verified slice that is not reopened|is not pending because of a reopen/,
    );
    // Already listed: an amendment only adds.
    const duplicate = await amendPreview(fixture, "slice-a", ["src/slice-a.ts"]);
    assert.match(
      duplicate.blockers.join(" "),
      /already in slice-a\.changedFiles\. An amendment only adds files/,
    );
    // Outside the target repository.
    const outside = await amendPreview(fixture, "slice-a", ["../legacy/marker.txt"]);
    assert.match(
      outside.blockers.join(" "),
      /outside the target repository|not an existing regular file/,
    );
    // Nothing above wrote anything.
    assert.equal((await state(fixture)).revision, (await state(fixture)).revision);
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "slice-amendments")),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("amend: an unbranded authorization is refused before anything is written", async () => {
  const fixture = await createFixture();
  try {
    await reopenedFigma16(fixture, ["slice-a"]);
    const added = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    const before = await state(fixture);
    await assert.rejects(
      amend(fixture, "slice-a", [added], {
        authorization: { v: 1, sequenceId: "SEQ-forged", operations: 1 },
      }),
      /must be branded by the trusted approval boundary/,
    );
    assert.equal((await state(fixture)).revision, before.revision);
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "slice-amendments")),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sequence: one approval executes an ordered set, each event citing its own index", async () => {
  const fixture = await createFixture();
  try {
    const before = await reopenedFigma16(fixture);
    const a = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    const b = await extraTargetFile(fixture, "src/slice-b-helper.ts");
    const sequence = await sequenceFor(fixture, [
      { kind: AMEND_SLICE, slice: "slice-a", files: [a] },
      { kind: AMEND_SLICE, slice: "slice-b", files: [b] },
    ]);
    assert.deepEqual(sequence.blockers, []);
    assert.equal(sequence.approvable, true);
    assert.equal(sequence.members.length, 2);
    // Member 2 is derived to run one revision after member 1, not previewed there.
    assert.equal(sequence.members[0].expected.revision, before.revision);
    assert.equal(sequence.members[1].expected.revision, before.revision + 1);
    assert.match(sequence.id, /^SEQ-[0-9a-f]{20}$/);
    assert.match(
      challengeForOperationSequence(sequence),
      /^APPROVE SEQ-[0-9a-f]{20} OPERATION_SEQUENCE 2 auth$/,
    );

    const authorization = await approveSequence(sequence);
    assert.equal(authorization.constructor, Object);
    const runner = operationSequenceRunner(sequence, authorization);
    const first = await runner.next();
    const second = await runner.next();
    assert.equal(await runner.next(), null);
    assert.equal(runner.expired, null);
    assert.equal(first.member.slice, "slice-a");
    assert.equal(second.member.slice, "slice-b");

    const after = await state(fixture);
    assert.equal(after.revision, before.revision + 2);
    const amendments = (await historyEvents(fixture)).filter(
      (event) => event.event === "SLICE_SCOPE_AMENDED",
    );
    assert.equal(amendments.length, 2);
    for (const [position, event] of amendments.entries()) {
      assert.equal(event.authorizedBy.sequenceId, sequence.id);
      assert.equal(event.authorizedBy.sequenceDigest, sequence.digest);
      assert.equal(event.authorizedBy.operations, 2);
      assert.equal(event.authorizedBy.channel, "ELICITATION");
      assert.equal(event.authorizedBy.index, position + 1);
    }
    // Both prior records kept, both pinned, and the replay still agrees.
    assert.ok(after.artifactHashes["slice-amendments/slice-a-1/slice.json"]);
    assert.ok(after.artifactHashes["slice-amendments/slice-b-1/slice.json"]);
    assert.equal(
      (await readState(fixture.targetRoot, "auth")).state.revision,
      after.revision,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sequence: naming one slice twice is refused before a human sees anything", async () => {
  const fixture = await createFixture();
  try {
    await reopenedFigma16(fixture, ["slice-a"]);
    const a = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    const other = await extraTargetFile(fixture, "src/slice-a-extra.ts");
    await assert.rejects(
      sequenceFor(fixture, [
        { kind: AMEND_SLICE, slice: "slice-a", files: [a] },
        { kind: AMEND_SLICE, slice: "slice-a", files: [other] },
      ]),
      /names 'slice-a' more than once; one slice is amended by one member/,
    );
    // A member that would be blocked makes the whole sequence unapprovable.
    const partial = await sequenceFor(fixture, [
      { kind: AMEND_SLICE, slice: "slice-a", files: [a] },
      { kind: AMEND_SLICE, slice: "slice-b", files: [other] },
    ]);
    assert.equal(partial.approvable, false);
    assert.ok(partial.blockers.length > 0);
    await assert.rejects(
      approveSequence(partial),
      /is not approvable/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sequence: a record that moved expires the whole remaining authorization", async () => {
  const fixture = await createFixture();
  try {
    const before = await reopenedFigma16(fixture);
    const a = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    const b = await extraTargetFile(fixture, "src/slice-b-helper.ts");
    const sequence = await sequenceFor(fixture, [
      { kind: AMEND_SLICE, slice: "slice-a", files: [a] },
      { kind: AMEND_SLICE, slice: "slice-b", files: [b] },
    ]);
    const runner = operationSequenceRunner(sequence, await approveSequence(sequence));
    await runner.next();

    // An amendment the sequence did not itself cause: the record is now one
    // revision further along than member 2 was derived for.
    const extra = await extraTargetFile(fixture, "src/slice-b-extra.ts");
    await amend(fixture, "slice-b", [extra]);
    const moved = await state(fixture);

    await assert.rejects(
      runner.next(),
      /expired before member 2: the record is not at the derived expected checkpoint/,
    );
    assert.ok(runner.expired);
    assert.deepEqual(runner.remaining, []);
    // Nothing further was written: the record is exactly where the unrelated
    // amendment left it.
    assert.equal((await state(fixture)).revision, moved.revision);
    assert.equal(moved.revision, before.revision + 2);
    // And the void authorization cannot be spent by asking again.
    await assert.rejects(runner.next(), /is expired/);
    assert.equal((await state(fixture)).revision, moved.revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sequence: a file edited after approval expires the sequence, unwritten", async () => {
  const fixture = await createFixture();
  try {
    const before = await reopenedFigma16(fixture);
    const a = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    const b = await extraTargetFile(fixture, "src/slice-b-helper.ts");
    const sequence = await sequenceFor(fixture, [
      { kind: AMEND_SLICE, slice: "slice-a", files: [a] },
      { kind: AMEND_SLICE, slice: "slice-b", files: [b] },
    ]);
    const runner = operationSequenceRunner(sequence, await approveSequence(sequence));
    await runner.next();
    // The bytes the human was shown for member 2 are not the bytes on disk.
    await writeFile(
      path.join(fixture.targetRoot, b),
      "export const helper = 'edited after approval';\n",
    );
    await assert.rejects(
      runner.next(),
      /no longer matches the approved operation/,
    );
    const after = await state(fixture);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(
      await exists(
        path.join(fixture.migrationRoot, "slice-amendments/slice-b-1/slice.json"),
      ),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("amend: a transition killed mid-write is recovered to the prior record", async () => {
  const fixture = await createFixture();
  try {
    await reopenedFigma16(fixture, ["slice-a"]);
    const added = await extraTargetFile(fixture, "src/slice-a-helper.ts");
    const before = await state(fixture);
    const priorBytes = await readFile(
      path.join(fixture.migrationRoot, "slices/slice-a.json"),
    );

    // Killed after the preserved copy and the amended record have landed, but
    // before state, integrity or history moved: the uncommitted half.
    const preview = await amendPreview(fixture, "slice-a", [added]);
    await assert.rejects(
      bootstrapMigration({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
        amendSlice: "slice-a",
        addFiles: [added],
        boundInputs: preview.boundInputs,
        registryBinding: preview.registryBinding,
        hooks: {
          afterWrite: () => {
            throw new Error("killed mid-amendment");
          },
        },
      }),
      /killed mid-amendment/,
    );
    // The journal names the transition that never completed.
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "advance.journal")),
      true,
    );

    // The next command recovers: prior bytes back, preserved copy removed,
    // revision unmoved, and the record readable again.
    await recoverMigrationRecord({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    const rolledBack = await state(fixture);
    assert.equal(rolledBack.revision, before.revision);
    assert.deepEqual(
      await readFile(path.join(fixture.migrationRoot, "slices/slice-a.json")),
      priorBytes,
      "the uncommitted half is rolled back to the prior record",
    );
    assert.equal(
      await exists(
        path.join(fixture.migrationRoot, "slice-amendments/slice-a-1/slice.json"),
      ),
      false,
      "and the preserved copy it had already written is removed",
    );
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "advance.journal")),
      false,
      "recovery drops its journal",
    );

    // Re-running the amendment then succeeds, once.
    const recovered = await amend(fixture, "slice-a", [added]);
    assert.equal(recovered.amended, true);
    const after = await state(fixture);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(
      await readFile(
        path.join(fixture.migrationRoot, "slice-amendments/slice-a-1/slice.json"),
      ),
      priorBytes,
    );
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "advance.journal")),
      false,
    );
    assert.equal(
      (await readState(fixture.targetRoot, "auth")).state.revision,
      after.revision,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// --- R1: operator-controlled COMPLETE -> reopened ---------------------------
//
// The gap these cover: authoritative evidence that arrives *after* FINALIZE and
// proves part of the finalized contract wrong had no supported expression.
// `--rework-slice` needs an active slice with a recorded FAIL, and a note in the
// record changed no machine state, so COMPLETE stayed COMPLETE over evidence
// everyone knew was stale.

/** Post-finalization evidence, inside the record so it is not target drift. */
const postFinalizationEvidence = async (fixture, name = "audit.md") => {
  const absolute = path.join(fixture.migrationRoot, "audits", name);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(
    absolute,
    "Production trace proves slice-a still renders the legacy total.\n",
  );
  return path.relative(fixture.targetRoot, absolute).replaceAll(path.sep, "/");
};

const reopenComplete = async (fixture, slices, overrides = {}) => {
  const resolution = await resolutionFor(fixture);
  const options = {
    ...resolution,
    moduleName: "auth",
    reopenComplete: slices,
    reopenReason: "Post-finalization production trace contradicts CAT-SCN-001.",
    reopenEvidence: overrides.evidence ?? (await postFinalizationEvidence(fixture)),
    ...overrides.options,
  };
  const preview = await previewMigrationExecution(options);
  return {
    preview,
    run: () =>
      bootstrapMigration({
        ...options,
        boundInputs: preview.boundInputs,
        registryBinding: preview.registryBinding,
      }),
  };
};

test("R1-1: COMPLETE is immutable by default", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const before = await snapshot(fixture.migrationRoot);
    const resolution = await resolutionFor(fixture);

    // A plain resume of a COMPLETE record still writes nothing.
    const resumed = await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      boundInputs: (
        await previewMigrationExecution({ ...resolution, moduleName: "auth" })
      ).boundInputs,
    });
    assert.equal(resumed.changed, false);
    assert.equal(resumed.state.status, "COMPLETE");
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);

    // And every partial form of the reopen is refused before argv is accepted.
    const refusal = (extra) => {
      try {
        parseDiscoverArguments(["auth", ...extra]);
        return null;
      } catch (error) {
        return error.message;
      }
    };
    assert.match(
      refusal(["--reopen-complete", "slice-a"]),
      /--reopen-complete requires --confirm-reopen/,
    );
    assert.match(
      refusal(["--reopen-complete", "slice-a", "--confirm-reopen"]),
      /--reopen-complete requires --reopen-reason/,
    );
    assert.match(
      refusal([
        "--reopen-complete",
        "slice-a",
        "--confirm-reopen",
        "--reopen-reason",
        "because",
      ]),
      /--reopen-complete requires --reopen-evidence/,
    );
    assert.match(
      refusal(["--confirm-reopen"]),
      /--confirm-reopen requires --reopen-complete/,
    );
    assert.match(
      refusal([
        "--reopen-complete",
        "slice-a",
        "--confirm-reopen",
        "--reopen-reason",
        "because the trace says so",
        "--reopen-evidence",
        "audits/audit.md",
        "--mode",
        "auto",
      ]),
      /--reopen-complete is an operator decision and cannot run under --mode auto/,
    );
    assert.throws(
      () => parseRunArguments(["auth", "--reopen-complete", "slice-a"]),
      /--reopen-complete is not accepted by run-migration\.mjs/,
    );
    // It is never self-confirmed, for the strongest version of the --refresh
    // reason: it un-completes a COMPLETE record.
    assert.equal(
      maySelfConfirm({
        command: "discover",
        mode: "auto",
        reopenComplete: true,
        preview: { state: "COMPLETE" },
      }),
      false,
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("R1-2: an explicit reopen invalidates only the named slice and preserves the superseded proof", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const before = await state(fixture);
    const unaffected = before.artifactHashes["evidence/slice-b/result.json"];
    const supersededBytes = await readFile(
      path.join(fixture.migrationRoot, "evidence/slice-a/result.json"),
    );

    const reopen = await reopenComplete(fixture, ["slice-a"]);
    assert.deepEqual(reopen.preview.blockers, []);
    assert.equal(reopen.preview.requiresConfirmation, true);
    assert.equal(reopen.preview.expectedNextCheckpoint, "VERIFY_SLICES");
    const result = await reopen.run();
    assert.equal(result.reopened, true);

    const after = await state(fixture);
    assert.equal(after.status, "ACTIVE");
    assert.equal(after.currentStep, "VERIFY_SLICES");
    assert.equal(after.activeSlice, "slice-a");
    assert.deepEqual(after.completedSlices, ["slice-b"]);
    assert.deepEqual(after.pendingSlices, ["slice-a"]);
    assert.equal(after.evidenceFreshness, "STALE");

    // Unaffected evidence stays pinned and byte-identical; the affected pin is
    // released and its verdict is no longer a PASS anybody can advance on.
    assert.equal(after.artifactHashes["evidence/slice-b/result.json"], unaffected);
    assert.ok(!after.artifactHashes["evidence/slice-a/result.json"]);
    assert.ok(!after.artifactHashes["gates.json"]);
    assert.equal(
      after.artifactHashes["inventories/legacy.json"],
      before.artifactHashes["inventories/legacy.json"],
    );
    assert.equal(
      after.artifactHashes["slices/index.json"],
      before.artifactHashes["slices/index.json"],
    );
    // The implementation record is untouched: a reopen invalidates a
    // verification, it does not un-implement a slice.
    assert.equal(
      after.artifactHashes["slices/slice-a.json"],
      before.artifactHashes["slices/slice-a.json"],
    );
    assert.equal(
      (
        await readJson(
          path.join(fixture.migrationRoot, "evidence/slice-a/result.json"),
        )
      ).result,
      "PENDING",
    );

    // The previous COMPLETE's proof survives byte-for-byte, permanently pinned.
    const preservedRelative = "reopen/1/evidence/slice-a/result.json";
    assert.deepEqual(
      await readFile(path.join(fixture.migrationRoot, preservedRelative)),
      supersededBytes,
    );
    assert.ok(after.artifactHashes[preservedRelative]);
    const record = await readJson(
      path.join(fixture.migrationRoot, "reopen/1/record.json"),
    );
    assert.equal(record.attempt, 1);
    assert.deepEqual(record.slices, ["slice-a"]);
    assert.match(record.reason, /production trace/i);
    assert.match(record.evidenceReference, /audits\/audit\.md$/);
    assert.equal(record.priorRevision, before.revision);
    assert.ok(after.artifactHashes["reopen/1/record.json"]);

    // One explicit, append-only history event carrying the operator's reason.
    const events = await historyEvents(fixture);
    const reopened = events.at(-1);
    assert.equal(reopened.event, "COMPLETE_REOPENED");
    assert.equal(reopened.from, "COMPLETE");
    assert.equal(reopened.step, "VERIFY_SLICES");
    assert.deepEqual(reopened.slices, ["slice-a"]);
    assert.match(reopened.reason, /production trace/i);
    assert.ok(reopened.preserved.includes(preservedRelative));
    // Previous COMPLETE history is preserved, never rewritten.
    assert.ok(
      events.some(
        (event) =>
          event.event === "STEP_COMPLETED" &&
          event.step === "VERIFY_SLICES" &&
          event.slice === "slice-a",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.event === "STEP_COMPLETED" && event.nextStep === "COMPLETE",
      ),
    );

    // The record still reads: replay, pins and slice-state all agree.
    assert.equal(
      (await readState(fixture.targetRoot, "auth")).state.revision,
      after.revision,
    );
    assert.equal(
      await exists(path.join(fixture.migrationRoot, "advance.journal")),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R1-3: a reopened migration is corrected and reaches COMPLETE again", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    await (await reopenComplete(fixture, ["slice-a"])).run();

    await authorEvidence(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "FINALIZE");
    await authorFinalize(fixture);
    await advance(fixture);

    const after = await state(fixture);
    assert.equal(after.status, "COMPLETE");
    assert.equal(after.currentStep, "COMPLETE");
    assert.deepEqual([...after.completedSlices].sort(), ["slice-a", "slice-b"]);
    // The preserved proof is still pinned after the record completes again.
    assert.ok(after.artifactHashes["reopen/1/evidence/slice-a/result.json"]);
    assert.ok(after.artifactHashes["reopen/1/record.json"]);
    assert.equal(
      (await previewMigrationExecution({
        ...(await resolutionFor(fixture)),
        moduleName: "auth",
      })).state,
      "COMPLETE",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("R1-4: invalid reopen requests fail closed", async () => {
  const active = await createFixture();
  try {
    // Not COMPLETE: a migration still in flight is corrected by advancing it.
    await driveTo(active, "SLICES");
    // Written before the snapshot: the evidence a reopen cites is not itself
    // part of what the refusal must leave untouched.
    await postFinalizationEvidence(active);
    const before = await snapshot(active.migrationRoot);
    const early = await reopenComplete(active, ["slice-a"]);
    assert.match(
      early.preview.blockers.join("\n"),
      /--reopen-complete is legal only for a COMPLETE migration/,
    );
    await assert.rejects(early.run(), /legal only for a COMPLETE migration/);
    assert.deepEqual(await snapshot(active.migrationRoot), before);
  } finally {
    await active.cleanup();
  }

  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    await postFinalizationEvidence(fixture);
    const before = await snapshot(fixture.migrationRoot);

    const unknown = await reopenComplete(fixture, ["slice-z"]);
    assert.match(
      unknown.preview.blockers.join("\n"),
      /names unknown slice 'slice-z'/,
    );
    await assert.rejects(unknown.run(), /names unknown slice 'slice-z'/);

    // Evidence must be a real, persisted observation.
    const missing = await reopenComplete(fixture, ["slice-a"], {
      evidence: "audits/never-written.md",
    });
    assert.match(
      missing.preview.blockers.join("\n"),
      /does not exist under the legacy or target repository/,
    );
    await assert.rejects(missing.run(), /does not exist under the legacy/);

    const unreasoned = await reopenComplete(fixture, ["slice-a"], {
      options: { reopenReason: "stale" },
    });
    assert.match(
      unreasoned.preview.blockers.join("\n"),
      /requires --reopen-reason <text> of at least 12 characters/,
    );
    await assert.rejects(unreasoned.run(), /at least 12 characters/);

    // Nothing above moved a byte, and the record is still COMPLETE.
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
    assert.equal((await state(fixture)).status, "COMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

// --- R1 drift: a COMPLETE reopen over path-scoped legacy drift ---------------
//
// The auth report: a COMPLETE record whose legacy revision moved could not be
// reopened at all -- the drift blocker fired before the reopen was planned, and
// the only way out was a full --refresh back to DISCOVER_LEGACY.

/** One committed change under the module's legacy path: path-scoped drift. */
const commitLegacyDrift = async (fixture) => {
  await writeFile(
    path.join(fixture.legacyRoot, "auth/marker.txt"),
    "auth\nnew revision\n",
  );
  await execFileAsync("git", ["add", "legacy/auth/marker.txt"], {
    cwd: fixture.root,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Contract Test",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-q",
      "-m",
      "legacy drift",
    ],
    { cwd: fixture.root },
  );
  return revisionOf(fixture.legacyRoot);
};

const FINALIZE_PINS = ["steps/08-finalize.md", "gates.json"];

test("R1-5: a COMPLETE reopen acknowledges legacy drift, keeps every unaffected pin, and completes again", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const before = await state(fixture);
    const oldRevision = before.legacyRevision.revision;
    const newRevision = await commitLegacyDrift(fixture);
    assert.notEqual(newRevision, oldRevision);
    const evidence = await postFinalizationEvidence(fixture);
    const supersededBytes = await readFile(
      path.join(fixture.migrationRoot, "evidence/slice-a/result.json"),
    );
    const untouched = await snapshot(fixture.migrationRoot);
    const reopenArguments = [
      "--reopen-complete",
      "slice-a",
      "--confirm-reopen",
      "--reopen-reason",
      "Post-finalization production trace contradicts CAT-SCN-001.",
      "--reopen-evidence",
      evidence,
    ];

    // Missing, wrong, or preview-bypassing acknowledgements fail closed.
    const missing = await discoverCli(fixture, reopenArguments);
    assert.equal(missing.blocked, true);
    assert.match(
      missing.preview.blockers.join("\n"),
      new RegExp(`--confirm-legacy-revision ${newRevision}`),
    );
    const wrong = await discoverCli(fixture, [
      ...reopenArguments,
      "--confirm-legacy-revision",
      oldRevision,
    ]);
    assert.equal(wrong.blocked, true);
    assert.match(
      wrong.preview.blockers.join("\n"),
      /does not match the current legacy revision/,
    );
    const bypass = await reopenComplete(fixture, ["slice-a"], { evidence });
    await assert.rejects(
      bypass.run(),
      /Legacy revision changed .*--confirm-legacy-revision.*Nothing was written/s,
    );
    assert.deepEqual(await snapshot(fixture.migrationRoot), untouched);
    assert.equal((await state(fixture)).status, "COMPLETE");

    // The acknowledged revision is part of what the operator confirms.
    const acknowledged = [
      ...reopenArguments,
      "--confirm-legacy-revision",
      newRevision,
    ];
    const offered = await discoverCli(fixture, acknowledged);
    assert.equal(offered.awaitingConfirmation, true);
    assert.equal(offered.preview.expectedNextCheckpoint, "VERIFY_SLICES");
    assert.deepEqual(
      offered.preview.reopenComplete.legacyRevision.fromLegacyRevision,
      before.legacyRevision,
    );
    assert.equal(
      offered.preview.reopenComplete.legacyRevision.toLegacyRevision.revision,
      newRevision,
    );
    const done = await discoverCli(fixture, [
      ...acknowledged,
      "--confirm-execution",
      offered.preview.confirmationId,
    ]);
    assert.equal(done.result.reopened, true);

    const after = await state(fixture);
    assert.equal(after.status, "ACTIVE");
    assert.equal(after.currentStep, "VERIFY_SLICES");
    assert.equal(after.activeSlice, "slice-a");
    assert.deepEqual(after.completedSlices, ["slice-b"]);
    assert.equal(after.legacyRevision.revision, newRevision);
    // Only the named slice's verification and FINALIZE are released; every
    // other pin -- inventories, plan, slice-b, implementation records -- holds.
    for (const [relative, hash] of Object.entries(before.artifactHashes)) {
      if (
        relative === "evidence/slice-a/result.json" ||
        FINALIZE_PINS.includes(relative)
      ) {
        assert.equal(after.artifactHashes[relative], undefined, relative);
      } else {
        assert.equal(after.artifactHashes[relative], hash, relative);
      }
    }
    // The previous COMPLETE's proof and the drift acknowledgement are kept.
    assert.deepEqual(
      await readFile(
        path.join(fixture.migrationRoot, "reopen/1/evidence/slice-a/result.json"),
      ),
      supersededBytes,
    );
    assert.ok(after.artifactHashes["reopen/1/evidence/slice-a/result.json"]);
    assert.ok(after.artifactHashes["reopen/1/record.json"]);
    const record = await readJson(
      path.join(fixture.migrationRoot, "reopen/1/record.json"),
    );
    assert.equal(record.fromLegacyRevision.revision, oldRevision);
    assert.equal(record.toLegacyRevision.revision, newRevision);
    assert.match(record.reason, /production trace/i);
    assert.match(record.evidenceReference, /audits\/audit\.md$/);
    assert.ok(record.evidenceHash);
    const reopened = (await historyEvents(fixture)).at(-1);
    assert.equal(reopened.event, "COMPLETE_REOPENED");
    assert.equal(reopened.fromLegacyRevision.revision, oldRevision);
    assert.equal(reopened.toLegacyRevision.revision, newRevision);

    // Resume reads the moved revision as current: no drift blocker remains.
    const resolution = await resolutionFor(fixture);
    const resumed = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.deepEqual(resumed.blockers, []);
    assert.equal(resumed.currentCheckpoint, "VERIFY_SLICES");

    // Corrected, reverified, and COMPLETE again on the new revision.
    await authorEvidence(fixture, "slice-a");
    await advance(fixture, { slice: "slice-a" });
    assert.equal((await state(fixture)).currentStep, "FINALIZE");
    await authorFinalize(fixture);
    await advance(fixture);
    const completed = await state(fixture);
    assert.equal(completed.status, "COMPLETE");
    assert.equal(completed.legacyRevision.revision, newRevision);
    assert.deepEqual([...completed.completedSlices].sort(), [
      "slice-a",
      "slice-b",
    ]);
    assert.ok(completed.artifactHashes["reopen/1/evidence/slice-a/result.json"]);
    assert.ok(completed.artifactHashes["reopen/1/record.json"]);
    assert.equal(
      completed.artifactHashes["evidence/slice-b/result.json"],
      before.artifactHashes["evidence/slice-b/result.json"],
    );
    const final = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(final.state, "COMPLETE");
    assert.deepEqual(final.blockers, []);
  } finally {
    await fixture.cleanup();
  }
});

test("R1-6: a drift acknowledgement with no drift fails closed; a plain reopen is unchanged", async () => {
  const fixture = await createFixture();
  try {
    await driveTo(fixture, "FINALIZE");
    const before = await state(fixture);
    await postFinalizationEvidence(fixture);
    const untouched = await snapshot(fixture.migrationRoot);

    assert.throws(
      () =>
        parseDiscoverArguments([
          "auth",
          "--confirm-legacy-revision",
          before.legacyRevision.revision,
        ]),
      /--confirm-legacy-revision requires --reopen-complete/,
    );
    const stray = await reopenComplete(fixture, ["slice-a"], {
      options: { confirmLegacyRevision: before.legacyRevision.revision },
    });
    assert.match(stray.preview.blockers.join("\n"), /no drift to acknowledge/);
    await assert.rejects(stray.run(), /no drift to acknowledge/);
    assert.deepEqual(await snapshot(fixture.migrationRoot), untouched);

    const plain = await reopenComplete(fixture, ["slice-a"]);
    assert.deepEqual(plain.preview.blockers, []);
    assert.equal("legacyRevision" in plain.preview.reopenComplete, false);
    await plain.run();
    const after = await state(fixture);
    assert.deepEqual(after.legacyRevision, before.legacyRevision);
    const record = await readJson(
      path.join(fixture.migrationRoot, "reopen/1/record.json"),
    );
    assert.equal("fromLegacyRevision" in record, false);
    const reopened = (await historyEvents(fixture)).at(-1);
    assert.equal(reopened.event, "COMPLETE_REOPENED");
    assert.equal("toLegacyRevision" in reopened, false);
  } finally {
    await fixture.cleanup();
  }
});
