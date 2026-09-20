import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  advanceMigration,
  assertExecutionConfirmation,
  bootstrapMigration,
  previewAdvance,
  previewMigrationExecution,
  resolveRegistryPath,
} from "../../src/core.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

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

const writeJson = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/** Exact bytes prove that the other checkout was not modified. */
const snapshot = async (root, prefix = "") => {
  const out = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(full, key));
    else out[key] = (await readFile(full)).toString("hex");
  }
  return out;
};

const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-mcp-"));
  const legacyRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  const registryPath = path.join(
    targetRoot,
    ".agents/knowledge/migrations/registry.json",
  );
  await mkdir(path.join(legacyRoot, "auth"), { recursive: true });
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"sm-mcp-fixture","private":true}\n',
  );
  await writeFile(path.join(legacyRoot, "marker.txt"), "legacy\n");
  await writeFile(path.join(legacyRoot, "auth/marker.txt"), "auth\n");
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await writeFile(path.join(targetRoot, "src/placeholder.ts"), "export {};\n");
  await writeJson(registryPath, {
    version: 1,
    projects: {
      legacy: { root: path.relative(path.dirname(registryPath), legacyRoot) },
      target: { root: path.relative(path.dirname(registryPath), targetRoot) },
    },
    modules: { auth: { target: "auth" } },
  });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Mcp Test",
      "-c",
      "user.email=mcp@example.test",
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
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

/** `--registry` is first-setup-only, so it is dropped once a binding exists. */
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

/** MCP never bootstraps (D6-3), so fixtures reach their first checkpoint here. */
const initialize = async (fixture, { ponytail } = {}) => {
  const resolution = await resolutionFor(fixture);
  const preview = await previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: SPEC,
    ponytail,
  });
  assertExecutionConfirmation(preview, preview.confirmationId);
  return bootstrapMigration({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: preview.openSpecProposal,
    ponytail,
    registryBinding: preview.registryBinding,
    boundInputs: preview.boundInputs,
  });
};

const advanceDirect = async (fixture, options = {}) => {
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

const MODULE_CLASSIFICATION = {
  version: 1,
  algorithmVersion: 2,
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

/** An approval-requiring exclusion, which is what makes a candidate pend. */
const excludedRow = (file, rationale) => ({
  ...MODULE_CLASSIFICATION.files[0],
  path: `auth/${file}`,
  disposition: "EXCLUDED_APPROVED",
  behaviorIds: [],
  rationale,
  evidence: evidenceChecklist(`legacy/auth/${file}`),
});

const EXCLUDED_CLASSIFICATION = {
  ...MODULE_CLASSIFICATION,
  files: [
    excludedRow(
      "marker.txt",
      "Decorative only; the fixture operator must approve exclusion.",
    ),
  ],
};

/**
 * A prior grouped-approval failure was thirteen candidates answered by one tool
 * call, so a census that pends exactly one line cannot reproduce it. These two
 * build the same fixture at any width: `behaviorBacked` closes DISCOVER_LEGACY
 * with nothing pending, `manyExcluded` then flips every row to an approval-
 * requiring exclusion.
 */
const extraFileNames = (count) =>
  Array.from(
    { length: count },
    (_, index) => `note-${String(index + 1).padStart(2, "0")}.txt`,
  );

const addLegacyFiles = async (fixture, names) => {
  for (const name of names) {
    await writeFile(path.join(fixture.legacyRoot, "auth", name), `${name}\n`);
  }
  await execFileAsync("git", ["add", "-A"], { cwd: fixture.root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Mcp Test",
      "-c",
      "user.email=mcp@example.test",
      "commit",
      "-q",
      "-m",
      "extra legacy files",
    ],
    { cwd: fixture.root },
  );
};

const rowFor = (name) => ({ ...MODULE_CLASSIFICATION.files[0], path: `auth/${name}` });

const behaviorBacked = (names) => ({
  ...MODULE_CLASSIFICATION,
  files: [MODULE_CLASSIFICATION.files[0], ...names.map(rowFor)],
});

const manyExcluded = (names) => ({
  ...MODULE_CLASSIFICATION,
  files: [
    excludedRow(
      "marker.txt",
      "Decorative only; the fixture operator must approve exclusion.",
    ),
    ...names.map((name) =>
      excludedRow(name, `Decorative only; ${name} needs its own approval.`),
    ),
  ],
});

/** An empty rationale blocks the candidate: agent work, not operator work. */
const NON_APPROVABLE_CLASSIFICATION = {
  ...MODULE_CLASSIFICATION,
  files: [excludedRow("marker.txt", "")],
};

const STEP_DOC = (number, name) => `# ${number}. ${name}

- Status: \`COMPLETE\`

## Result

Authored by the MCP suite.
`;

const STEP_FILES = {
  DISCOVER_LEGACY: ["02", "discover-legacy", "Discover legacy"],
  DISCOVERY_COMPLETENESS: [
    "02a",
    "discovery-completeness",
    "Discovery completeness",
  ],
};

const completeStepDoc = async (fixture, step) => {
  const [number, file, name] = STEP_FILES[step];
  await writeFile(
    path.join(fixture.migrationRoot, `steps/${number}-${file}.md`),
    STEP_DOC(number, name),
  );
};

const authorDiscoverLegacy = async (fixture, base = MODULE_CLASSIFICATION) => {
  await completeStepDoc(fixture, "DISCOVER_LEGACY");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/legacy.json"),
    LEGACY_INVENTORY,
  );
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    base,
  );
};

/** Positions a fixture at DISCOVERY_COMPLETENESS with the checkpoint authored. */
const atDiscoveryCompleteness = async (
  fixture,
  classification,
  base = MODULE_CLASSIFICATION,
) => {
  await initialize(fixture);
  await authorDiscoverLegacy(fixture, base);
  await advanceDirect(fixture);
  await completeStepDoc(fixture, "DISCOVERY_COMPLETENESS");
  await writeJson(
    path.join(fixture.migrationRoot, "inventories/module-classification.json"),
    classification,
  );
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
    .filter((line) => line.trim()).length;

const DECISIONS = "decisions/operator-decisions.ndjson";

const decisionLedger = async (fixture) => {
  try {
    return await readFile(path.join(fixture.migrationRoot, DECISIONS), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

export {
  EXCLUDED_CLASSIFICATION,
  MODULE_CLASSIFICATION,
  NON_APPROVABLE_CLASSIFICATION,
  addLegacyFiles,
  atDiscoveryCompleteness,
  authorDiscoverLegacy,
  behaviorBacked,
  createFixture,
  extraFileNames,
  manyExcluded,
  decisionLedger,
  execFileAsync,
  historyEvents,
  initialize,
  readJson,
  repositoryRoot,
  resolutionFor,
  snapshot,
  state,
};
