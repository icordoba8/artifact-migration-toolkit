// A minimal consumer holding one integrity-valid, *unstamped* Format 17 record.
//
// Built by this checkout, which has no `build-identity.json` and is therefore
// an unidentified runtime -- so the record it produces is unstamped, which is
// exactly the shape of every record that exists in a consumer today. The
// staged release bundle is then pointed at it as an installed toolkit would be.
//
// Deliberately stops at RESOLVE. Driving a full lifecycle is the external
// acceptance fixture's job; everything here is about identity, and identity
// questions are answerable at any revision.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { removeTree } from "./portability.mjs";

import { resolveRegistryPath } from "../../src/migration-utils.mjs";
import {
  assertExecutionConfirmation,
  bootstrapMigration,
  previewMigrationExecution,
} from "../../src/resumable-migration.mjs";

export { SPEC, LEGACY_INVENTORY, MODULE_CLASSIFICATION };

const execFileAsync = promisify(execFile);

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

// The DISCOVER_LEGACY evidence checklist shape: every required category
// present or explicitly not applicable with a reason. Copied in shape, not in
// meaning, from the contract suite's fixture -- this module only needs enough
// of a record to close one checkpoint under an installed toolkit.
const evidenceChecklist = (location, requirementIds = [], scenarioIds = []) => [
  { category: "SOURCE", kind: "CODE", status: "PRESENT", location, requirementIds, scenarioIds },
  {
    category: "RUNTIME_OBSERVATION",
    kind: "OBSERVATION",
    status: "NOT_APPLICABLE",
    reason: "No runtime capture was taken for this fixture.",
    requirementIds: [],
    scenarioIds: [],
  },
  { category: "REQUIREMENT_TRACE", kind: "DOCS", status: "PRESENT", location, requirementIds, scenarioIds },
];

const LEGACY_INVENTORY = {
  version: 1,
  hasVisibleUi: true,
  behaviors: [
    {
      id: "LB-1",
      description: "Sign in",
      evidence: evidenceChecklist("legacy/auth/marker.txt", ["AUTH-REQ-001"], ["AUTH-SCN-001"]),
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
      requiredObservations: [
        { id: "UIO-1", state: "DEFAULT", role: "button", name: "Sign in", predicate: "visibility", expected: true },
        { id: "UIO-2", state: "DEFAULT", afterInteractionId: "UIX-1", role: "status", name: "Signed in", predicate: "presence", expected: true },
      ],
      evidence: evidenceChecklist("legacy/auth/marker.txt", ["AUTH-REQ-001"], ["AUTH-SCN-001"]),
      requirementIds: ["AUTH-REQ-001"],
      scenarioIds: ["AUTH-SCN-001"],
    },
  ],
  routeFlows: [
    {
      id: "RF-1",
      description: "Login route",
      evidence: evidenceChecklist("legacy/auth/marker.txt", ["AUTH-REQ-002"], ["AUTH-SCN-002"]),
    },
  ],
  explicitNoRouteFlows: false,
};

const MODULE_CLASSIFICATION = {
  version: 2,
  algorithmVersion: 1,
  moduleRoots: [{ path: "auth", reason: "The module's own slice." }],
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

const readJson = async (file) =>
  JSON.parse(await readFile(file, "utf8")).valueOf();

const readOrNull = async (file) =>
  readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

/**
 * @param {object} [options]
 * @param {string} [options.prefix] mkdtemp prefix. Pass one containing a space
 *   to build the path-with-spaces variant the acceptance fixture requires --
 *   `C:\\Users\\First Last\\...` and `/home/user/My Tools/...` are both ordinary
 *   installation paths, so a suite that only ever tests unquoted ones proves
 *   the easy half.
 */
export const createUnstampedRecord = async ({
  prefix = "amt-consumer-",
  designSource,
  figma,
} = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const legacyRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  const registryPath = path.join(targetRoot, ".agents/knowledge/migrations/registry.json");
  await mkdir(path.join(legacyRoot, "auth"), { recursive: true });
  await mkdir(path.dirname(registryPath), { recursive: true });
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"amt-consumer","private":true}\n');
  await writeFile(path.join(legacyRoot, "auth/marker.txt"), "auth\n");
  await writeFile(path.join(targetRoot, "src/placeholder.ts"), "export {};\n");
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        projects: {
          legacy: { root: path.relative(path.dirname(registryPath), legacyRoot) },
          target: { root: path.relative(path.dirname(registryPath), targetRoot) },
        },
        modules: { auth: { target: "auth" } },
      },
      null,
      2,
    )}\n`,
  );
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Identity Test", "-c", "user.email=identity@example.test", "commit", "-q", "-m", "fixture"],
    { cwd: root },
  );

  const resolution = await resolveRegistryPath({
    cliPath: registryPath,
    moduleName: "auth",
    cwd: root,
    projectRoot: root,
    environmentPath: undefined,
  });
  const preview = await previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: SPEC,
    designSource,
    figma,
  });
  assertExecutionConfirmation(preview, preview.confirmationId);
  await bootstrapMigration({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: preview.openSpecProposal,
    registryBinding: preview.registryBinding,
    boundInputs: preview.boundInputs,
    designSource,
    figma,
  });

  const recordRoot = path.join(targetRoot, ".agents/knowledge/migrations/modules/auth");
  const statePath = path.join(recordRoot, "state.json");

  /** Everything a transition could possibly have touched, as comparable data. */
  const snapshot = async () => ({
    state: await readJson(statePath),
    integrity: JSON.parse(await readFile(path.join(recordRoot, "integrity.json"), "utf8")),
    history: (await readFile(path.join(recordRoot, "history/history.ndjson"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    decisions: await readOrNull(path.join(recordRoot, "decisions/operator-decisions.ndjson")),
    journal: await readOrNull(path.join(recordRoot, "advance-journal.json")),
  });

  return {
    root,
    legacyRoot,
    targetRoot,
    registryPath,
    recordRoot,
    statePath,
    snapshot,
    /** Authors exactly what DISCOVER_LEGACY needs so one advance is ready. */
    authorDiscoverLegacy: async () => {
      await writeFile(
        path.join(recordRoot, "steps/02-discover-legacy.md"),
        "# 02. Discover legacy\n\n- Status: `COMPLETE`\n\n## Result\n\nAuthored by the acceptance fixture.\n",
      );
      await writeFile(
        path.join(recordRoot, "inventories/legacy.json"),
        `${JSON.stringify(LEGACY_INVENTORY, null, 2)}\n`,
      );
      await writeFile(
        path.join(recordRoot, "inventories/module-classification.json"),
        `${JSON.stringify(MODULE_CLASSIFICATION, null, 2)}\n`,
      );
    },
    editState: async (mutate) => {
      const current = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(statePath, `${JSON.stringify(mutate(current), null, 2)}\n`);
    },
    cleanup: () => removeTree(root),
  };
};
