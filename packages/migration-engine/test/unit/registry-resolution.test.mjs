import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertFigmaSource,
  previewRegistryUpdate,
  resolveDesignSource,
  resolveRegistryPath,
  updateRegistry,
} from "../../src/migration-utils.mjs";
import {
  assertExecutionConfirmation,
  bootstrapMigration,
  previewMigrationExecution,
} from "../../src/resumable-migration.mjs";

const execFileAsync = promisify(execFile);
const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);

const AUTH_SPEC = `# Auth

### Requirement: AUTH-REQ-001 Authentication
The system SHALL authenticate valid users and reject invalid credentials.

#### Scenario: AUTH-SCN-001 Valid credentials
Given valid credentials, authentication succeeds.
`;
const CHANGED_AUTH_SPEC = AUTH_SPEC.replace(
  "authentication succeeds",
  "a session is established",
);

const cleanEnvironment = (overrides = {}) => {
  const environment = { ...process.env };
  delete environment.MIGRATION_REGISTRY_PATH;
  delete environment.MIGRATION_REQUIREMENTS_FILE;
  return { ...environment, ...overrides };
};

// Exit code 2 is the documented "blocked, nothing executed" result, not a
// failure: it is a normal outcome for a read-only preflight that refuses.
const BLOCKED_EXIT_CODE = 2;

const runScript = async (scriptRoot, script, args, options) => {
  try {
    return await execFileAsync(
      process.execPath,
      [path.join(scriptRoot, script), ...args],
      { encoding: "utf8", ...options },
    );
  } catch (error) {
    if (error.code === BLOCKED_EXIT_CODE) {
      return { stdout: error.stdout, stderr: error.stderr, blocked: true };
    }
    throw error;
  }
};

const createFixture = async ({ openSpec = false } = {}) => {
  let root = await mkdtemp(path.join(os.tmpdir(), "migration-registry-"));
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
    '{"name":"fixture","private":true}\n',
  );
  await writeFile(path.join(legacyRoot, "marker.txt"), "legacy\n");
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        projects: {
          legacy: {
            root: path.relative(path.dirname(registryPath), legacyRoot),
          },
          target: {
            root: path.relative(path.dirname(registryPath), targetRoot),
          },
        },
        modules: { auth: { target: "auth" } },
      },
      null,
      2,
    )}\n`,
  );
  if (openSpec) {
    const specPath = path.join(targetRoot, "openspec/specs/auth/spec.md");
    await mkdir(path.dirname(specPath), { recursive: true });
    await writeFile(
      specPath,
      "### Requirement: AUTH-REQ-001 Sign in\nThe target MUST authenticate users.\n\n#### Scenario: AUTH-SCN-001 Success\nA valid user signs in.\n",
    );
  }
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Registry Test",
      "-c",
      "user.email=registry@example.test",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return {
    get root() {
      return root;
    },
    get packagePath() {
      return path.join(root, "package.json");
    },
    get registryPath() {
      return path.join(
        root,
        "target/.agents/knowledge/migrations/registry.json",
      );
    },
    get targetRoot() {
      return path.join(root, "target");
    },
    relocate: async () => {
      const destination = `${root}-moved`;
      await rename(root, destination);
      root = destination;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const confirmRegistration = async (fixture, moduleName = "catalog") => {
  const preview = await previewRegistryUpdate({
    projectRoot: fixture.root,
    registryPath: fixture.registryPath,
    moduleName,
    target: moduleName,
  });
  return updateRegistry({
    projectRoot: fixture.root,
    registryPath: fixture.registryPath,
    moduleName,
    target: moduleName,
    confirmExecution: preview.confirmationId,
  });
};

const migrationRoot = (fixture) =>
  path.join(fixture.targetRoot, ".agents/knowledge/migrations/modules/auth");
const authSpecPath = (fixture) =>
  path.join(fixture.targetRoot, "openspec/specs/auth/spec.md");
const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const previewFreshAuth = async (fixture, proposal = AUTH_SPEC) => {
  const resolution = await resolveRegistryPath({
    cliPath: fixture.registryPath,
    moduleName: "auth",
    cwd: fixture.root,
    projectRoot: fixture.root,
    environmentPath: undefined,
  });
  const preview = await previewMigrationExecution({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: proposal,
  });
  return { preview, resolution };
};

const initializeFreshAuth = async (fixture, options = {}) => {
  const { preview, resolution } = await previewFreshAuth(fixture);
  assertExecutionConfirmation(preview, preview.confirmationId);
  const result = await bootstrapMigration({
    ...resolution,
    moduleName: "auth",
    openSpecProposal: preview.openSpecProposal,
    registryBinding: preview.registryBinding,
    boundInputs: preview.boundInputs,
    ...options,
  });
  return { preview, resolution, result };
};

test("fresh RESOLVE accepts a valid in-memory OpenSpec proposal when spec.md is absent", async () => {
  const fixture = await createFixture();
  try {
    const { resolution } = await previewFreshAuth(fixture);
    const absent = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(absent.state, "NOT_STARTED");
    assert.equal(absent.openSpecStatus, "ABSENT_VALID_AT_RESOLVE");
    assert.match(
      absent.blockers.join("\n"),
      /validly absent at NOT_STARTED\/RESOLVE/,
    );

    const { preview } = await previewFreshAuth(fixture);
    assert.equal(preview.state, "NOT_STARTED");
    assert.equal(preview.currentCheckpoint, "RESOLVE");
    assert.equal(preview.openSpecStatus, "PROPOSED");
    assert.match(preview.openSpecDigest, /^sha256:text-lf-v1:[a-f0-9]{64}$/);
    assert.deepEqual(preview.blockers, []);
  } finally {
    await fixture.cleanup();
  }
});

test("fresh RESOLVE preview writes no OpenSpec, migration artifact, registry, or project binding", async () => {
  const fixture = await createFixture();
  try {
    const packageBefore = await readFile(fixture.packagePath, "utf8");
    const registryBefore = await readFile(fixture.registryPath, "utf8");
    await previewFreshAuth(fixture);
    assert.equal(await readFile(fixture.packagePath, "utf8"), packageBefore);
    assert.equal(await readFile(fixture.registryPath, "utf8"), registryBefore);
    assert.equal(await exists(authSpecPath(fixture)), false);
    assert.equal(await exists(migrationRoot(fixture)), false);
  } finally {
    await fixture.cleanup();
  }
});

test("confirmed fresh RESOLVE creates OpenSpec and the complete initialization set", async () => {
  const fixture = await createFixture();
  try {
    const { result } = await initializeFreshAuth(fixture);
    assert.equal(await readFile(authSpecPath(fixture), "utf8"), AUTH_SPEC);
    assert.equal(result.state.currentStep, "DISCOVER_LEGACY");
    assert.deepEqual(result.state.completedSteps, ["RESOLVE"]);
    const root = migrationRoot(fixture);
    const gates = JSON.parse(
      await readFile(path.join(root, "gates.json"), "utf8"),
    );
    const history = await readFile(
      path.join(root, "history/history.ndjson"),
      "utf8",
    );
    assert.equal(gates.gates.length, 7);
    assert.match(history, /"event":"CREATED"/);
    assert.equal(await exists(path.join(root, "steps/08-finalize.md")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("continuation validates the persisted OpenSpec and resumes DISCOVER_LEGACY", async () => {
  const fixture = await createFixture();
  try {
    const { resolution } = await initializeFreshAuth(fixture);
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(preview.state, "ACTIVE");
    assert.equal(preview.currentCheckpoint, "DISCOVER_LEGACY");
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.openSpecStatus, "EXISTING");
  } finally {
    await fixture.cleanup();
  }
});

test("missing OpenSpec after initialization blocks continuation", async () => {
  const fixture = await createFixture();
  try {
    const { resolution } = await initializeFreshAuth(fixture);
    await rm(authSpecPath(fixture));
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assert.equal(preview.requiresConfirmation, false);
    assert.match(
      preview.blockers.join("\n"),
      /Required OpenSpec source does not exist/,
    );
    await assert.rejects(
      bootstrapMigration({
        ...resolution,
        moduleName: "auth",
        boundInputs: preview.boundInputs,
      }),
      /Required OpenSpec source does not exist/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("changing the proposed OpenSpec makes the prior confirmation stale", async () => {
  const fixture = await createFixture();
  try {
    const first = await previewFreshAuth(fixture, AUTH_SPEC);
    const second = await previewMigrationExecution({
      ...first.resolution,
      moduleName: "auth",
      openSpecProposal: CHANGED_AUTH_SPEC,
    });
    assert.notEqual(first.preview.openSpecDigest, second.openSpecDigest);
    assert.throws(
      () => assertExecutionConfirmation(second, first.preview.confirmationId),
      /missing or expired/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("failed confirmed initialization rolls back OpenSpec, migration tree, and project binding", async () => {
  const fixture = await createFixture();
  try {
    const packageBefore = await readFile(fixture.packagePath, "utf8");
    await assert.rejects(
      initializeFreshAuth(fixture, {
        hooks: {
          afterCommit(step) {
            if (step === "project-config") throw new Error("injected failure");
          },
        },
      }),
      /injected failure/,
    );
    assert.equal(await readFile(fixture.packagePath, "utf8"), packageBefore);
    assert.equal(await exists(authSpecPath(fixture)), false);
    assert.equal(await exists(migrationRoot(fixture)), false);
  } finally {
    await fixture.cleanup();
  }
});

test("first setup accepts an explicit registry from monorepo and target CWD without writes", async () => {
  const fixture = await createFixture();
  try {
    const packageBefore = await readFile(fixture.packagePath, "utf8");
    const registryBefore = await readFile(fixture.registryPath, "utf8");
    for (const [cwd, registry] of [
      [fixture.root, path.relative(fixture.root, fixture.registryPath)],
      [fixture.targetRoot, ".agents/knowledge/migrations/registry.json"],
    ]) {
      const result = await runScript(
        scriptsRoot,
        "cli/discover-module.mjs",
        ["auth", "--registry", registry],
        { cwd, env: cleanEnvironment() },
      );
      assert.match(
        result.stdout,
        /Registry identity: \.agents\/knowledge\/migrations\/registry\.json/,
      );
      assert.match(result.stdout, /OpenSpec/);
    }
    assert.equal(await readFile(fixture.packagePath, "utf8"), packageBefore);
    assert.equal(await readFile(fixture.registryPath, "utf8"), registryBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("MIGRATION_REGISTRY_PATH remains an optional first-setup CI fallback", async () => {
  const fixture = await createFixture();
  try {
    const resolution = await resolveRegistryPath({
      moduleName: "auth",
      cwd: fixture.root,
      projectRoot: fixture.root,
      environmentPath: fixture.registryPath,
    });
    assert.equal(resolution.registryPath, fixture.registryPath);
    assert.equal(
      JSON.parse(await readFile(fixture.packagePath, "utf8")).config,
      undefined,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("confirmed registration persists one portable binding and reuses it automatically", async () => {
  const fixture = await createFixture();
  try {
    const before = await readFile(fixture.packagePath, "utf8");
    const preview = await previewRegistryUpdate({
      projectRoot: fixture.root,
      registryPath: fixture.registryPath,
      moduleName: "catalog",
      target: "catalog",
    });
    assert.match(preview.confirmationId, /^[a-f0-9]{16}$/);
    assert.equal(await readFile(fixture.packagePath, "utf8"), before);
    await updateRegistry({
      projectRoot: fixture.root,
      registryPath: fixture.registryPath,
      moduleName: "catalog",
      target: "catalog",
      confirmExecution: preview.confirmationId,
    });
    const packageDocument = JSON.parse(
      await readFile(fixture.packagePath, "utf8"),
    );
    assert.equal(
      packageDocument.config.startMigration.registry,
      "target/.agents/knowledge/migrations/registry.json",
    );
    assert.doesNotMatch(packageDocument.config.startMigration.registry, /\\/);

    const result = await runScript(
      scriptsRoot,
      "cli/discover-module.mjs",
      ["auth"],
      { cwd: fixture.root, env: cleanEnvironment() },
    );
    assert.match(result.stdout, /Migration: auth/);
  } finally {
    await fixture.cleanup();
  }
});

test("confirmed migration execution persists config and target-relative state identity", async () => {
  const fixture = await createFixture({ openSpec: true });
  try {
    const resolution = await resolveRegistryPath({
      cliPath: fixture.registryPath,
      moduleName: "auth",
      cwd: fixture.root,
      projectRoot: fixture.root,
      environmentPath: undefined,
    });
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    assertExecutionConfirmation(preview, preview.confirmationId);
    await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      registryBinding: preview.registryBinding,
      boundInputs: preview.boundInputs,
    });
    const state = JSON.parse(
      await readFile(
        path.join(
          fixture.targetRoot,
          ".agents/knowledge/migrations/modules/auth/state.json",
        ),
        "utf8",
      ),
    );
    assert.equal(state.registry, ".agents/knowledge/migrations/registry.json");
    const packageDocument = JSON.parse(
      await readFile(fixture.packagePath, "utf8"),
    );
    delete packageDocument.config;
    await writeFile(
      fixture.packagePath,
      `${JSON.stringify(packageDocument, null, 2)}\n`,
    );
    const resumed = await runScript(
      scriptsRoot,
      "cli/discover-module.mjs",
      ["auth"],
      { cwd: fixture.root, env: cleanEnvironment() },
    );
    assert.match(resumed.stdout, /Current state: ACTIVE/);
  } finally {
    await fixture.cleanup();
  }
});

test("workspace-relative binding survives repository relocation", async () => {
  const fixture = await createFixture();
  try {
    await confirmRegistration(fixture);
    await fixture.relocate();
    const result = await runScript(
      scriptsRoot,
      "cli/discover-module.mjs",
      ["auth"],
      { cwd: fixture.root, env: cleanEnvironment() },
    );
    assert.match(result.stdout, /Migration: auth/);
  } finally {
    await fixture.cleanup();
  }
});

test("conflicting CLI, environment, project config, and state bindings fail explicitly", async () => {
  const fixture = await createFixture({ openSpec: true });
  try {
    await confirmRegistration(fixture);
    await assert.rejects(
      resolveRegistryPath({
        moduleName: "auth",
        cwd: fixture.root,
        projectRoot: fixture.root,
        environmentPath: path.join(fixture.root, "other.json"),
      }),
      /binding mismatch: MIGRATION_REGISTRY_PATH.*project configuration/s,
    );
    await assert.rejects(
      resolveRegistryPath({
        cliPath: fixture.registryPath,
        moduleName: "auth",
        cwd: fixture.root,
        projectRoot: fixture.root,
        environmentPath: undefined,
      }),
      /--registry is accepted only during first setup/,
    );

    const resolution = await resolveRegistryPath({
      moduleName: "auth",
      cwd: fixture.root,
      projectRoot: fixture.root,
      environmentPath: undefined,
    });
    const preview = await previewMigrationExecution({
      ...resolution,
      moduleName: "auth",
    });
    await bootstrapMigration({
      ...resolution,
      moduleName: "auth",
      registryBinding: preview.registryBinding,
      boundInputs: preview.boundInputs,
    });
    const packageDocument = JSON.parse(
      await readFile(fixture.packagePath, "utf8"),
    );
    packageDocument.config.startMigration.registry =
      "target/other-registry.json";
    await writeFile(
      fixture.packagePath,
      `${JSON.stringify(packageDocument, null, 2)}\n`,
    );
    await assert.rejects(
      resolveRegistryPath({
        moduleName: "auth",
        cwd: fixture.targetRoot,
        projectRoot: fixture.root,
        environmentPath: undefined,
      }),
      /project configuration.*existing migration state/s,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("missing and stale project configuration fail actionably", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      resolveRegistryPath({
        moduleName: "auth",
        cwd: fixture.root,
        projectRoot: fixture.root,
        environmentPath: undefined,
      }),
      /first setup pass --registry.*config\.startMigration\.registry/s,
    );
    const packageDocument = JSON.parse(
      await readFile(fixture.packagePath, "utf8"),
    );
    packageDocument.config = {
      startMigration: { registry: "target/missing-registry.json" },
    };
    await writeFile(
      fixture.packagePath,
      `${JSON.stringify(packageDocument, null, 2)}\n`,
    );
    await assert.rejects(
      resolveRegistryPath({
        moduleName: "auth",
        cwd: fixture.root,
        projectRoot: fixture.root,
        environmentPath: undefined,
      }),
      /ENOENT|no such file/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("registry and project-config changes stale registration confirmations", async () => {
  const fixture = await createFixture();
  try {
    const preview = await previewRegistryUpdate({
      projectRoot: fixture.root,
      registryPath: fixture.registryPath,
      moduleName: "catalog",
      target: "catalog",
    });
    await writeFile(fixture.packagePath, '{"name":"changed","private":true}\n');
    await assert.rejects(
      updateRegistry({
        projectRoot: fixture.root,
        registryPath: fixture.registryPath,
        moduleName: "catalog",
        target: "catalog",
        confirmExecution: preview.confirmationId,
      }),
      /confirmation is missing or expired/,
    );
  } finally {
    await fixture.cleanup();
  }
});

/**
 * This ran the same resolution through four generated provider copies of the
 * engine. Generation exists now and emits none: an adapter installs the one
 * engine package, so "all providers resolve the binding identically" is true
 * because there is one resolver, not because four agree.
 *
 * What is worth keeping is the property the four copies were a proxy for: the
 * binding resolves from the operator's working directory, and from an engine
 * installed somewhere else entirely. That is the same question the external
 * suite (`test/external/engine-paths.test.mjs`) asks against a real out-of-tree
 * installation, including a path containing spaces, so it is asserted there
 * rather than restated here.
 */
test("the persisted binding resolves from the operator's cwd, with a clean environment", async () => {
  const fixture = await createFixture();
  try {
    await confirmRegistration(fixture);
    const result = await runScript(scriptsRoot, "cli/discover-module.mjs", ["auth"], {
      cwd: fixture.root,
      env: cleanEnvironment(),
    });
    assert.match(result.stdout, /Migration: auth/);
  } finally {
    await fixture.cleanup();
  }
});

// --- Figma design-source normalization (pure, network-free) ------------------

test("assertFigmaSource normalizes a /design/ link and converts the node id", () => {
  const url = "https://www.figma.com/design/ABC123def/Flow?node-id=12-34";
  assert.deepEqual(assertFigmaSource(url), {
    fileKey: "ABC123def",
    nodeId: "12:34",
    kind: "design",
    raw: "https://www.figma.com/design/ABC123def?node-id=12-34",
  });
});

test("assertFigmaSource accepts a /design/ link without a node id", () => {
  const url = "https://figma.com/design/ABC123def/Flow";
  assert.equal(assertFigmaSource(url).nodeId, null);
});

test("assertFigmaSource resolves a branch URL to the branch as the effective file", () => {
  const url =
    "https://www.figma.com/design/ROOTKEY/branch/BRANCHKEY/Flow?node-id=1-2";
  assert.equal(assertFigmaSource(url).fileKey, "BRANCHKEY");
});

test("assertFigmaSource accepts a /make/ link", () => {
  const url = "https://www.figma.com/make/MAKEKEY/Prototype";
  assert.equal(assertFigmaSource(url).kind, "make");
});

test("assertFigmaSource refuses FigJam, Slides, non-figma hosts, and malformed input", () => {
  for (const bad of [
    "https://www.figma.com/board/BOARDKEY/Jam",
    "https://www.figma.com/slides/SLIDEKEY/Deck",
    "https://evil.example.com/design/KEY/Flow",
    "ftp://figma.com/design/KEY/Flow",
    "not a url",
    "https://www.figma.com/design",
    "https://www.figma.com/design/KEY/Flow?node-id=oops",
  ]) {
    assert.throws(() => assertFigmaSource(bad));
  }
});

test("assertFigmaSource rejects URLs carrying userinfo credentials", () => {
  for (const bad of [
    "https://user:pass@www.figma.com/design/KEY/Flow?node-id=1-2",
    "https://user@www.figma.com/design/KEY/Flow",
    "https://:pass@www.figma.com/design/KEY/Flow",
  ]) {
    assert.throws(() => assertFigmaSource(bad), /userinfo credentials/);
  }
});

test("assertFigmaSource never persists sensitive or extra query input verbatim", () => {
  const source = assertFigmaSource(
    "https://www.figma.com/design/KEY/Flow?node-id=1-2&token=secret&t=abc",
  );
  assert.equal(source.raw, "https://www.figma.com/design/KEY?node-id=1-2");
  assert.ok(!source.raw.includes("secret"));
  assert.ok(!source.raw.includes("token"));
});

test("assertFigmaSource canonical reference cannot disagree with nodeId on duplicate node-id", () => {
  const source = assertFigmaSource(
    "https://www.figma.com/design/KEY/Flow?node-id=1-2&node-id=3-4",
  );
  assert.equal(source.nodeId, "1:2");
  assert.equal(source.raw, "https://www.figma.com/design/KEY?node-id=1-2");
});

test("resolveDesignSource defaults to target-system and forbids stray figma links", () => {
  assert.deepEqual(resolveDesignSource({}), {
    designSource: "target-system",
    figmaSources: [],
  });
  assert.throws(
    () => resolveDesignSource({ figma: ["https://figma.com/design/K/F"] }),
    /require --design-source figma-mcp/,
  );
});

test("resolveDesignSource requires at least one link and dedupes by kind#fileKey#nodeId", () => {
  assert.throws(
    () => resolveDesignSource({ designSource: "figma-mcp" }),
    /at least one --figma link/,
  );
  const url = "https://www.figma.com/design/KEY/Flow?node-id=1-2";
  const resolved = resolveDesignSource({
    designSource: "figma-mcp",
    figma: [url, url],
  });
  assert.equal(resolved.designSource, "figma-mcp");
  assert.equal(resolved.figmaSources.length, 1);
});

test("resolveDesignSource keeps /design/ and /make/ with the same key distinct", () => {
  const resolved = resolveDesignSource({
    designSource: "figma-mcp",
    figma: [
      "https://www.figma.com/design/KEY/Flow?node-id=1-2",
      "https://www.figma.com/make/KEY/Flow?node-id=1-2",
    ],
  });
  assert.equal(resolved.figmaSources.length, 2);
  assert.deepEqual(resolved.figmaSources.map((source) => source.kind).sort(), [
    "design",
    "make",
  ]);
});

test("resolveDesignSource rejects an unknown design source", () => {
  assert.throws(
    () => resolveDesignSource({ designSource: "sketch" }),
    /Invalid design source/,
  );
});
