// Fixture support for the migrate-artifact journal/recovery integration spec.
// Ported from the canonical unit-test fixtures in
// .agents/skills/migrate-artifact/scripts/artifact-migration.test.mjs so the
// integration spec drives real production checkpoints instead of re-deriving
// its own model of the lifecycle documents.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { FINAL_GATES } from "../../../../src/core.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- untyped production JS module, consumed directly for real fixture behavior.
import {
  artifactEvidenceDigest,
  artifactIdFor,
  artifactRoot,
  readArtifactState,
  runArtifact,
} from "../../../../src/artifact/artifact-migration.mjs";

const execFileAsync = promisify(execFile);

export interface Fixture {
  root: string;
  sourceRoot: string;
  targetRoot: string;
  options: { source: string; type: string; target: string; sourceRoot: string; targetRoot: string };
  id: string;
  artifactRoot: string;
  cleanup: () => Promise<void>;
}

export const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
export const exists = (file: string) => access(file).then(() => true, () => false);

export const typescriptCheck = (status = "PASS", project = "tsconfig.json") => ({
  validator: { kind: "TYPESCRIPT", project },
  status,
});

export const writeJson = async (root: string, relative: string, value: unknown) => {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

export const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-journal-"));
  const sourceRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  await mkdir(path.join(sourceRoot, "widget"), { recursive: true });
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceRoot, "widget/source.ts"), "export const source = true;\n"),
    writeFile(path.join(sourceRoot, "widget/theme.css"), ":root { --accent: red; }\n"),
    writeFile(path.join(sourceRoot, "widget/consumer-a.ts"), "export const a = 'theme';\n"),
    writeFile(path.join(sourceRoot, "widget/consumer-b.ts"), "export const b = 'theme';\n"),
    writeFile(path.join(sourceRoot, "widget/local.css"), ".widget { color: red; }\n"),
    writeFile(path.join(targetRoot, "src/widget.ts"), "export const widget = 'native';\n"),
    writeFile(path.join(targetRoot, "src/theme.ts"), "export const theme = 'target';\n"),
    writeFile(path.join(targetRoot, "src/placeholder.ts"), "export {};\n"),
    writeFile(
      path.join(targetRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: true,
            target: "ES2022",
          },
          include: ["src/**/*.ts", "src/**/*.tsx"],
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Artifact Journal Test", "-c", "user.email=artifact-journal@example.test", "commit", "-q", "-m", "fixture"],
    { cwd: root },
  );
  const options = {
    source: "widget",
    type: "component",
    target: "src/widget.ts",
    sourceRoot,
    targetRoot,
  };
  const id = artifactIdFor({ source: options.source, type: options.type });
  return {
    root,
    sourceRoot,
    targetRoot,
    options,
    id,
    artifactRoot: artifactRoot(targetRoot, id),
    cleanup: async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rm(root, { recursive: true, force: true });
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 10 || !code || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    },
  };
};

export const FIXTURE_CENSUS = [
  "widget/consumer-a.ts#a",
  "widget/consumer-b.ts#b",
  "widget/local.css",
  "widget/source.ts#source",
  "widget/theme.css",
];

export const stateOf = (fixture: Fixture) => readArtifactState(fixture.targetRoot, fixture.id);

export const sourceEvidence = async (fixture: Fixture, relative = "widget/source.ts") => ({
  path: relative,
  sha256: await digest(path.join(fixture.sourceRoot, relative)),
  status: "VERIFIED",
});

export const targetEvidence = async (fixture: Fixture, relative = fixture.options.target) => ({
  path: relative,
  sha256: await digest(path.join(fixture.targetRoot, relative)),
  status: "VERIFIED",
});

export const bootstrap = async (fixture: Fixture, extra: Record<string, unknown> = {}) => {
  const result = await runArtifact({ ...fixture.options, ...extra });
  if (result.outcome !== "CONTINUE") throw new Error(`bootstrap did not continue: ${result.reason}`);
  const state = await stateOf(fixture);
  if (state.currentStep !== "DISCOVER_LEGACY") throw new Error(`bootstrap landed on ${state.currentStep}`);
  return result;
};

export const sourceInventory = async (
  fixture: Fixture,
  { ui = false, runtimeStates = ["DEFAULT"] }: { ui?: boolean; runtimeStates?: string[] } = {},
) => {
  const state = await stateOf(fixture);
  return {
    version: 1,
    artifactId: fixture.id,
    hasVisibleUi: ui,
    sourceFiles: state.bindings.source.entries
      .filter((entry: { kind: string }) => entry.kind === "FILE")
      .map((entry: { path: string }) => entry.path),
    behaviors: [
      {
        id: "B-1",
        description: "The artifact retains its observable behavior.",
        visible: ui,
        evidence: [await sourceEvidence(fixture)],
        ...(ui ? { runtimeStates } : {}),
      },
    ],
    globalContracts: [
      {
        id: "GC-1",
        kind: "GLOBAL_THEME",
        sourcePath: "widget/theme.css",
        consumers: ["widget/consumer-a.ts", "widget/consumer-b.ts"],
      },
    ],
    featureLocalVisuals: [
      {
        id: "FV-1",
        path: "widget/local.css",
        evidence: [await sourceEvidence(fixture, "widget/local.css")],
      },
    ],
    operatorDecisions: [],
  };
};

export const authorSource = async (fixture: Fixture, options?: { ui?: boolean; runtimeStates?: string[] }) => {
  const document = await sourceInventory(fixture, options);
  await writeJson(fixture.artifactRoot, "inventories/source.json", document);
  return document;
};

export const advanceDiscovery = async (fixture: Fixture, options?: { ui?: boolean }) => {
  const source = await authorSource(fixture, options);
  const first = await runArtifact(fixture.options);
  if (first.outcome !== "CONTINUE") throw new Error(`advanceDiscovery step 1 failed: ${first.reason}`);
  await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
    version: 1,
    sourceFiles: source.sourceFiles,
    units: FIXTURE_CENSUS.map((unitPath) => ({ path: unitPath, disposition: "MIGRATED_BEHAVIOR", ref: "B-1" })),
    requirements: [],
  });
  const second = await runArtifact(fixture.options);
  if (second.outcome !== "CONTINUE") throw new Error(`advanceDiscovery step 2 failed: ${second.reason}`);
  return second;
};

export const targetInventory = async (fixture: Fixture, resolution: string) => {
  if (resolution === "MIGRATE_NEW") {
    return { version: 1, artifactId: fixture.id, resolution, targetFiles: [], targetNative: [], evidence: [] };
  }
  const evidence = await targetEvidence(fixture);
  return {
    version: 1,
    artifactId: fixture.id,
    resolution,
    targetFiles: [fixture.options.target],
    targetNative: [
      {
        id: "TN-1",
        path: fixture.options.target,
        description: "Existing target-native artifact behavior.",
        evidence: [evidence],
      },
    ],
    evidence: resolution === "TARGET_REUSE" ? [{ behaviorId: "B-1", ...evidence }] : [],
  };
};

export const advanceAssessment = async (fixture: Fixture, resolution: string) => {
  const document = await targetInventory(fixture, resolution);
  await writeJson(fixture.artifactRoot, "inventories/target.json", document);
  const result = await runArtifact(fixture.options);
  if (result.outcome !== "CONTINUE") throw new Error(`advanceAssessment failed: ${result.reason}`);
  return result;
};

export const baselineDocuments = async (fixture: Fixture, resolution: string, { final = false } = {}) => {
  const target = await targetInventory(fixture, resolution);
  const evidence = await targetEvidence(fixture);
  const state = await stateOf(fixture);
  return {
    parity: {
      version: 1,
      rows: [
        {
          id: "P-1",
          behaviorId: "B-1",
          resolution,
          status: resolution === "TARGET_REUSE" || final ? "VERIFIED" : "PLANNED",
          targetEvidence: resolution === "TARGET_REUSE" || final ? [evidence] : [],
        },
      ],
    },
    native: {
      version: 1,
      rows: target.targetNative.map((row: { id: string; path: string; description: string }) => ({
        id: row.id,
        path: row.path,
        description: row.description,
        status: resolution === "TARGET_REUSE" ? "VERIFIED" : final ? "PRESERVED" : "PLANNED",
        evidence: final || resolution === "TARGET_REUSE" ? [evidence] : [],
      })),
    },
    design: { version: 1, rows: state.hasVisibleUi ? [] : [] },
    global: {
      version: 1,
      rows: [
        {
          id: "GM-1",
          sourceContractId: "GC-1",
          kind: "GLOBAL_THEME",
          targetPath: "src/theme.ts",
          consumers: ["widget/consumer-a.ts", "widget/consumer-b.ts"],
          status: final ? "VERIFIED" : "PLANNED",
          evidence: final ? [await targetEvidence(fixture, "src/theme.ts")] : [],
        },
      ],
    },
  };
};

export const writeBaseline = async (fixture: Fixture, resolution: string, options?: { final?: boolean }) => {
  const documents = await baselineDocuments(fixture, resolution, options);
  await Promise.all([
    writeJson(fixture.artifactRoot, "matrices/parity.json", documents.parity),
    writeJson(fixture.artifactRoot, "matrices/target-native.json", documents.native),
    writeJson(fixture.artifactRoot, "matrices/design-system.json", documents.design),
    writeJson(fixture.artifactRoot, "matrices/global-contract.json", documents.global),
  ]);
  return documents;
};

export const advanceBaseline = async (fixture: Fixture, resolution: string) => {
  await writeBaseline(fixture, resolution);
  const result = await runArtifact(fixture.options);
  if (result.outcome !== "CONTINUE") throw new Error(`advanceBaseline failed: ${result.reason}`);
  return result;
};

export const advancePlan = async (fixture: Fixture, resolution: string, selectedSlice?: string) => {
  await writeJson(fixture.artifactRoot, "slices/index.json", {
    version: 1,
    slices: [
      { id: "slice-1", behaviorIds: ["B-1"], dependsOn: [], kind: { TARGET_REUSE: "REUSE", TARGET_EXTEND: "EXTEND", MIGRATE_NEW: "NEW" }[resolution] },
    ],
  });
  const result = await runArtifact({ ...fixture.options, slice: selectedSlice });
  if (result.outcome !== "CONTINUE") throw new Error(`advancePlan failed: ${result.reason}`);
  return result;
};

export const advanceImplementation = async (fixture: Fixture, resolution: string) => {
  if (resolution !== "TARGET_REUSE") {
    await writeFile(path.join(fixture.targetRoot, fixture.options.target), `export const widget = '${resolution}';\n`);
  }
  const changedFiles =
    resolution === "TARGET_REUSE"
      ? []
      : [{ path: fixture.options.target, sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)) }];
  await writeJson(fixture.artifactRoot, "slices/slice-1.json", {
    version: 1,
    sliceId: "slice-1",
    status: "COMPLETE",
    changedFiles,
    checks: [typescriptCheck()],
    preservedTargetNativeIds: resolution === "TARGET_EXTEND" ? ["TN-1"] : [],
  });
  const result = await runArtifact(fixture.options);
  if (result.outcome !== "CONTINUE") throw new Error(`advanceImplementation failed: ${result.reason}`);
  return result;
};

export const verificationDocument = async (fixture: Fixture) => {
  const target = await targetEvidence(fixture);
  return {
    version: 1,
    sliceId: "slice-1",
    status: "PASS",
    checks: [{ behaviorId: "B-1", status: "PASS", evidence: [target] }],
    runtimeEvidence: [],
  };
};

export const advanceVerification = async (fixture: Fixture) => {
  const document = await verificationDocument(fixture);
  await writeJson(fixture.artifactRoot, "evidence/slice-1/result.json", document);
  const result = await runArtifact(fixture.options);
  if (result.outcome !== "CONTINUE") throw new Error(`advanceVerification failed: ${result.reason}`);
  return document;
};

export const gatesDocument = async (fixture: Fixture) => {
  const state = await stateOf(fixture);
  const evidence = {
    path: fixture.options.target,
    sha256: await digest(path.join(fixture.targetRoot, fixture.options.target)),
    boundTo: { sourceDigest: state.bindings.source.digest, targetDigest: state.bindings.target.digest },
  };
  return {
    version: 1,
    gates: FINAL_GATES.map((name: string) => ({ name, status: "PASS", evidence: [evidence] })),
    uiEvidence: [],
    requirementEvidence: [],
  };
};

export const driveToBuild = async (fixture: Fixture, resolution: string) => {
  await bootstrap(fixture);
  await advanceDiscovery(fixture);
  await advanceAssessment(fixture, resolution);
};

export const driveToVerifySlices = async (fixture: Fixture, resolution: string) => {
  await driveToBuild(fixture, resolution);
  await advanceBaseline(fixture, resolution);
  await advancePlan(fixture, resolution);
  await advanceImplementation(fixture, resolution);
};

export const driveToComplete = async (fixture: Fixture, resolution = "TARGET_EXTEND") => {
  await driveToVerifySlices(fixture, resolution);
  await advanceVerification(fixture);
  await writeBaseline(fixture, resolution, { final: true });
  await writeJson(fixture.artifactRoot, "gates.json", await gatesDocument(fixture));
  const result = await runArtifact(fixture.options);
  if (result.outcome !== "COMPLETE") throw new Error(`driveToComplete failed: ${result.reason}`);
  return result;
};
