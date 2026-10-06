/**
 * Provider generation and parity.
 *
 * Ported from the consumer's `tests/agents-sync/sync.test.ts`, keeping the cases
 * whose subject is the migration projection and dropping the ones whose subject
 * was the consumer's own agents and standards. On `node:test` rather than
 * vitest: every other suite in this repository is, and this one drives real
 * symlinks, permissions, atomic renames and a child process.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENGINE_MCP_ENTRY_PLACEHOLDER,
  manifestPath,
  providerNames,
  runProvidersSync,
} from "../scripts/providers-sync.mjs";
import { payloadPaths, releaseCheck } from "../scripts/release.mjs";
import {
  IDENTITY_BASENAME,
  canonicalSkillNames,
  computeSkillHash,
  identityDocument,
  identityPath,
  skillLockEntries,
} from "../scripts/skills-lock.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const PROVIDERS = ["claude", "codex", "copilot", "opencode"];
const SKILLS = ["migrate-artifact", "start-migration"];

/** The consumer-relative engine roots R-1 removed. Split so this file does not trip its own guard. */
const FORBIDDEN_ENGINE_PATHS = [
  [".agents/skills", "start-migration", "scripts"].join("/"),
  [".agents/skills", "migrate-artifact", "scripts"].join("/"),
];

const fixtureRoots = new Set();

const writeText = async (root, relativePath, content) => {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
};

const readText = (root, relativePath) =>
  readFile(path.join(root, relativePath), "utf8");

const replaceText = async (root, relativePath, search, replacement) =>
  writeText(
    root,
    relativePath,
    (await readText(root, relativePath)).replace(search, replacement),
  );

const pathExists = async (root, relativePath) => {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const listFiles = async (root, relativePath = ".") => {
  const entries = await readdir(path.join(root, relativePath), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else files.push(child);
  }
  return files;
};

const digestPaths = async (root, paths) => {
  const digest = {};
  for (const relativePath of [...paths].sort()) {
    digest[relativePath] = createHash("sha256")
      .update(await readFile(path.join(root, relativePath)))
      .digest("hex");
  }
  return digest;
};

const readManifest = async (root) => JSON.parse(await readText(root, manifestPath));

/**
 * A minimal but real canonical tree: two skills, one user-invocable and one not,
 * one reference file, and an unrelated repository file that must survive.
 *
 * `migrate-artifact` is deliberately NOT user-invocable here, so the fixture
 * proves the wrapper is conditional rather than unconditional. The real
 * canonical tree has both invocable, and the parity tests below check that.
 */
const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "providers-sync-"));
  fixtureRoots.add(root);
  await writeText(root, "unrelated/repository-file.txt", "keep me\n");
  await writeText(
    root,
    "skills/start-migration/SKILL.md",
    `---
name: start-migration
description: Start a legacy module migration
license: internal
compatibility: claude, copilot
context: project
agent: main-agent
disable-model-invocation: true
user-invocable: true
metadata:
  sources_reviewed: https://example.test/migration
---

Run the canonical migration workflow.
`,
  );
  await writeText(
    root,
    "skills/start-migration/references/contract.md",
    "Contract guidance.\n",
  );
  await writeText(
    root,
    "skills/migrate-artifact/SKILL.md",
    `---
name: migrate-artifact
description: Migrate one standalone artifact
---

Run the canonical artifact workflow.
`,
  );
  for (const skill of SKILLS) {
    await writeText(root, `skills/${skill}/scripts/runtime.mjs`, "export {};\n");
  }
  return root;
};

const EXPECTED = [
  ...PROVIDERS.map(provider => `providers/${provider}/install.mjs`),
  ...PROVIDERS.flatMap(provider => SKILLS.map(skill => `providers/${provider}/skills/${skill}/scripts/runtime.mjs`)),
  "providers/claude/.mcp.json",
  "providers/claude/adapter.json",
  "providers/claude/skills/migrate-artifact/SKILL.md",
  "providers/claude/skills/start-migration/SKILL.md",
  "providers/claude/skills/start-migration/references/contract.md",
  "providers/codex/adapter.json",
  "providers/codex/config.toml",
  "providers/codex/prompts/start-migration.md",
  "providers/codex/skills/migrate-artifact/SKILL.md",
  "providers/codex/skills/start-migration/SKILL.md",
  "providers/codex/skills/start-migration/references/contract.md",
  "providers/copilot/adapter.json",
  "providers/copilot/mcp.json",
  "providers/copilot/prompts/start-migration.prompt.md",
  "providers/copilot/skills/migrate-artifact/SKILL.md",
  "providers/copilot/skills/start-migration/SKILL.md",
  "providers/copilot/skills/start-migration/references/contract.md",
  "providers/opencode/adapter.json",
  "providers/opencode/commands/start-migration.md",
  "providers/opencode/opencode.fragment.json",
  "providers/opencode/skills/migrate-artifact/SKILL.md",
  "providers/opencode/skills/start-migration/SKILL.md",
  "providers/opencode/skills/start-migration/references/contract.md",
].sort();

const parseGenerated = async (root, relativePath) => {
  const content = await readText(root, relativePath);
  const match = content.match(/^---\n([\s\S]*?)\n---\n\n<!--[\s\S]*?-->\n\n([\s\S]*)$/);
  assert.ok(match, `${relativePath} must carry generated frontmatter and banner`);
  return { frontmatter: match[1], body: match[2].trim() };
};

const expectFailureWithoutWrites = async (root, expected) => {
  const sentinels = ["unrelated/repository-file.txt"];
  const before = await digestPaths(root, sentinels);
  await assert.rejects(runProvidersSync({ root }), expected);
  assert.deepEqual(await digestPaths(root, sentinels), before);
};

after(async () => {
  for (const root of fixtureRoots) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  fixtureRoots.clear();
});

// --- projection --------------------------------------------------------------

test("generates the four provider trees and records ownership in the manifest", async () => {
  const root = await createFixture();

  assert.deepEqual(await runProvidersSync({ root }), { count: EXPECTED.length });
  // The manifest itself lives under `providers/` but is ownership, not output.
  assert.deepEqual(
    (await listFiles(root, "providers"))
      .filter((entry) => entry !== manifestPath)
      .sort(),
    EXPECTED,
  );
  assert.deepEqual(await readManifest(root), EXPECTED);
  assert.equal(
    await readText(root, manifestPath),
    `${JSON.stringify(EXPECTED, null, 2)}\n`,
  );
  assert.equal(await readText(root, "unrelated/repository-file.txt"), "keep me\n");

  // Claude keeps the invocation flags; the other three drop them because their
  // skill formats do not define them. Common fields reach all four.
  const claude = await parseGenerated(root, "providers/claude/skills/start-migration/SKILL.md");
  assert.equal(
    claude.frontmatter,
    [
      "name: start-migration",
      "description: Start a legacy module migration",
      "license: internal",
      "compatibility: claude, copilot",
      "metadata:",
      "  sources_reviewed: https://example.test/migration",
      "context: project",
      "agent: main-agent",
      "disable-model-invocation: true",
      "user-invocable: true",
    ].join("\n"),
  );
  assert.equal(claude.body, "Run the canonical migration workflow.");

  for (const provider of ["codex", "copilot", "opencode"]) {
    const generated = await parseGenerated(
      root,
      `providers/${provider}/skills/start-migration/SKILL.md`,
    );
    assert.equal(
      generated.frontmatter,
      [
        "name: start-migration",
        "description: Start a legacy module migration",
        "license: internal",
        "compatibility: claude, copilot",
        "metadata:",
        "  sources_reviewed: https://example.test/migration",
      ].join("\n"),
      `${provider} frontmatter projection is wrong`,
    );
    assert.equal(generated.body, claude.body, `${provider} body diverged`);
  }

  // References are byte-identical everywhere. No packaging token is rendered
  // into them, so there is nothing to except.
  const canonical = await readText(root, "skills/start-migration/references/contract.md");
  for (const provider of PROVIDERS) {
    assert.equal(
      await readText(root, `providers/${provider}/skills/start-migration/references/contract.md`),
      canonical,
    );
  }

  // Three wrappers, and Claude has none: its skill is directly user-invocable,
  // so a wrapper would be a second entry point to the same document.
  assert.equal(await pathExists(root, "providers/claude/prompts"), false);
  assert.equal(await pathExists(root, "providers/claude/commands"), false);
  for (const [relative, expectedBody] of [
    [
      "providers/codex/prompts/start-migration.md",
      "Load and follow the `start-migration` skill. Use this command input as its invocation arguments: $ARGUMENTS",
    ],
    [
      "providers/opencode/commands/start-migration.md",
      "Load and follow the `start-migration` skill. Use this command input as its invocation arguments: $ARGUMENTS",
    ],
    [
      "providers/copilot/prompts/start-migration.prompt.md",
      "Load and follow the `start-migration` skill. Treat any text appended to this prompt invocation as the skill arguments.",
    ],
  ]) {
    const wrapper = await parseGenerated(root, relative);
    assert.equal(wrapper.body, expectedBody);
    assert.match(wrapper.frontmatter, /description: Start a legacy module migration/);
  }
  assert.match(
    (await parseGenerated(root, "providers/copilot/prompts/start-migration.prompt.md"))
      .frontmatter,
    /^mode: agent$/m,
  );

  // A skill that is not user-invocable gets no wrapper at all.
  for (const absent of [
    "providers/codex/prompts/migrate-artifact.md",
    "providers/opencode/commands/migrate-artifact.md",
    "providers/copilot/prompts/migrate-artifact.prompt.md",
  ]) {
    assert.equal(await pathExists(root, absent), false, `${absent} must not exist`);
  }
});

test("every MCP template launches the installed engine through a placeholder, never a consumer path", async () => {
  const root = await createFixture();
  await runProvidersSync({ root });

  const templates = {
    "providers/claude/.mcp.json": (parsed) => parsed.mcpServers["start-migration"],
    "providers/copilot/mcp.json": (parsed) => parsed.servers["start-migration"],
  };
  for (const [relative, select] of Object.entries(templates)) {
    const server = select(JSON.parse(await readText(root, relative)));
    assert.equal(server.command, "node");
    assert.deepEqual(server.args, [ENGINE_MCP_ENTRY_PLACEHOLDER]);
  }
  const fragment = JSON.parse(await readText(root, "providers/opencode/opencode.fragment.json"));
  assert.deepEqual(fragment.mcp["start-migration"].command, [
    "node",
    ENGINE_MCP_ENTRY_PLACEHOLDER,
  ]);
  assert.equal(fragment.mcp["start-migration"].type, "local");
  // A fragment carries only the MCP block: OpenCode's config is consumer-owned
  // and the adapter merges into it rather than replacing it.
  assert.deepEqual(Object.keys(fragment), ["mcp"]);

  const toml = await readText(root, "providers/codex/config.toml");
  assert.match(toml, /^\[mcp_servers\.start-migration\]$/m);
  assert.match(toml, /^args = \["\{\{ENGINE_MCP_ENTRY\}\}"\]$/m);

  // No template, and no generated document, may name a consumer-relative
  // engine root. That is the registration extraction exists to delete.
  for (const relative of await readManifest(root)) {
    const content = await readText(root, relative);
    for (const forbidden of FORBIDDEN_ENGINE_PATHS) {
      assert.ok(!content.includes(forbidden), `${relative} names ${forbidden}`);
    }
  }
});

test("each adapter manifest owns exactly its own generated files and leaves release identity unrendered", async () => {
  const root = await createFixture();
  await runProvidersSync({ root });
  const manifest = await readManifest(root);

  for (const provider of PROVIDERS) {
    const adapter = JSON.parse(await readText(root, `providers/${provider}/adapter.json`));
    assert.equal(adapter.provider, provider);
    assert.deepEqual(adapter.skills, SKILLS);
    assert.equal(adapter.engine.package, "@artifact-migration-tools/migration-engine");
    // Identity is injected while packaging an already committed tree, so no
    // committed file may carry it.
    assert.equal(adapter.toolkit.version, "{{TOOLKIT_VERSION}}");
    assert.equal(adapter.toolkit.commit, "{{TOOLKIT_COMMIT}}");
    assert.equal(adapter.toolkit.contentHash, "{{TOOLKIT_CONTENT_HASH}}");
    assert.equal(adapter.engine.mcpEntry, ENGINE_MCP_ENTRY_PLACEHOLDER);

    // Install metadata is source-complete: every scope is either a documented
    // root or an explicit `null` the installer must refuse. An absent key would
    // read as "not decided yet" and let an installer choose.
    for (const scope of ["user", "project"]) {
      for (const field of ["skillRoot", "mcpConfig"]) {
        assert.ok(
          scope in adapter.install[field],
          `${provider}.install.${field} must state its ${scope} scope`,
        );
        const value = adapter.install[field][scope];
        assert.ok(
          value === null || typeof value === "string",
          `${provider}.install.${field}.${scope} must be a path or null`,
        );
        // No install root may sit inside the engine or a canonical source tree,
        // and none may be absolute: a `~`-relative or repo-relative root is what
        // the host resolves, an absolute one is what escapes it.
        if (typeof value === "string") {
          assert.ok(
            !path.isAbsolute(value) && !value.startsWith("providers/") && !value.startsWith("skills/"),
            `${provider}.install.${field}.${scope} is not a host-resolved root: ${value}`,
          );
        }
      }
    }
    assert.match(adapter.install.mechanism, /^[a-z]+(-[a-z]+)*$/);

    const owned = manifest
      .filter((entry) => entry.startsWith(`providers/${provider}/`))
      .map((entry) => entry.slice(`providers/${provider}/`.length))
      .filter((entry) => entry !== "adapter.json")
      .sort();
    assert.deepEqual(adapter.files, owned, `${provider} adapter file list drifted`);
    assert.ok(adapter.files.includes(adapter.mcpTemplate));
  }
});

test("no provider tree carries engine source, engine tests, or a skill package manifest", async () => {
  const root = await createFixture();
  // The generator refuses to project an executable module rather than merely
  // not being asked to: this is the Phase 2 boundary, enforced at the copy.
  await writeText(root, "skills/start-migration/scripts/engine.mjs", "export {};\n");
  await expectFailureWithoutWrites(
    root,
    /Engine source may not be projected into a provider tree: skills\/start-migration\/scripts\/engine\.mjs/,
  );
  await rm(path.join(root, "skills/start-migration/scripts"), { recursive: true });
  await runProvidersSync({ root });

  for (const relative of await readManifest(root)) {
    assert.ok(
      (!/\.(mjs|cjs|js|ts|mts|cts)$/.test(relative) || relative.endsWith("/install.mjs") || relative.endsWith("/scripts/runtime.mjs")),
      `${relative} is executable source inside a provider tree`,
    );
    assert.ok(!relative.endsWith("/package.json"), `${relative} is a skill package manifest`);
  }
  // And the committed tree agrees, which is the claim a release makes.
  for (const relative of await readManifest(repositoryRoot)) {
    assert.ok(
      (!/\.(mjs|cjs|js|ts|mts|cts)$/.test(relative) || relative.endsWith("/install.mjs") || relative.endsWith("/scripts/runtime.mjs")) && !relative.endsWith(".test.mjs"),
      `${relative} is engine source or a test inside a provider tree`,
    );
  }
});

// --- determinism, ownership, and check --------------------------------------

test("is deterministic and self-heals corrupted generated output on the second run", async () => {
  const root = await createFixture();
  await runProvidersSync({ root });
  const first = await digestPaths(root, await readManifest(root));

  await writeText(root, "providers/codex/config.toml", "corrupted\n");
  await runProvidersSync({ root });

  assert.deepEqual(await digestPaths(root, await readManifest(root)), first);
});

test("prunes stale manifest-owned output and its empty directories, and preserves unrelated provider files", async () => {
  const root = await createFixture();
  await runProvidersSync({ root });

  // Hand-authored adapter files under a provider directory must survive: an
  // installer and a README are exactly what a real adapter adds.
  await writeText(root, "providers/codex/install.sh", "#!/bin/sh\n");
  await writeText(root, "providers/README.md", "human notes\n");

  await writeText(root, "providers/opencode/skills/legacy/SKILL.md", "old\n");
  await writeText(
    root,
    manifestPath,
    `${JSON.stringify([...EXPECTED, "providers/opencode/skills/legacy/SKILL.md"].sort(), null, 2)}\n`,
  );

  assert.deepEqual(await runProvidersSync({ root }), { count: EXPECTED.length });

  assert.equal(await pathExists(root, "providers/opencode/skills/legacy/SKILL.md"), false);
  assert.equal(await pathExists(root, "providers/opencode/skills/legacy"), false);
  assert.equal(await readText(root, "providers/codex/install.sh"), "#!/bin/sh\n");
  assert.equal(await readText(root, "providers/README.md"), "human notes\n");
  assert.deepEqual(await readManifest(root), EXPECTED);
});

test("--check reports MISSING, CHANGED and STALE, never EXTRA, and writes nothing", async () => {
  const root = await createFixture();
  await runProvidersSync({ root });
  assert.deepEqual(await runProvidersSync({ root, checkOnly: true }), {
    count: EXPECTED.length,
    differences: [],
  });

  await writeText(root, "providers/codex/config.toml", "changed\n");
  await rm(path.join(root, "providers/claude/.mcp.json"));
  // An unrelated human file under a provider directory is not the generator's,
  // so it is not a difference.
  await writeText(root, "providers/claude/notes.md", "human notes\n");
  await writeText(root, "providers/opencode/stale.md", "stale\n");
  await writeText(
    root,
    manifestPath,
    `${JSON.stringify([...EXPECTED, "providers/opencode/stale.md"].sort(), null, 2)}\n`,
  );
  const before = await digestPaths(root, [
    ...await listFiles(root, "providers"),
  ]);

  assert.deepEqual(await runProvidersSync({ root, checkOnly: true }), {
    count: EXPECTED.length,
    differences: [
      "CHANGED providers/codex/config.toml",
      `CHANGED ${manifestPath}`,
      "MISSING providers/claude/.mcp.json",
      "STALE providers/opencode/stale.md",
    ],
  });
  assert.deepEqual(
    await digestPaths(root, [
      ...await listFiles(root, "providers"),
    ]),
    before,
  );
});

test("isolates concurrent synchronizations of different roots", async () => {
  const first = await createFixture();
  const second = await createFixture();
  await replaceText(
    second,
    "skills/start-migration/SKILL.md",
    "Run the canonical migration workflow.",
    "Second fixture body.",
  );

  await Promise.all([runProvidersSync({ root: first }), runProvidersSync({ root: second })]);

  const read = (root) => readText(root, "providers/claude/skills/start-migration/SKILL.md");
  assert.ok(!(await read(first)).includes("Second fixture body."));
  assert.ok((await read(second)).includes("Second fixture body."));
});

// --- negative: invalid canonical sources ------------------------------------

test("rejects invalid canonical sources and unsupported providers before writing anything", async () => {
  const cases = [
    {
      name: "missing skills directory",
      mutate: (root) => rm(path.join(root, "skills"), { recursive: true, force: true }),
      expected: /skills|ENOENT/,
    },
    {
      name: "missing frontmatter",
      mutate: (root) => writeText(root, "skills/start-migration/SKILL.md", "No frontmatter.\n"),
      expected: /is missing YAML frontmatter/,
    },
    {
      name: "non-mapping frontmatter",
      mutate: (root) =>
        writeText(root, "skills/start-migration/SKILL.md", "---\n- start-migration\n---\n\nBody.\n"),
      expected: /frontmatter must be a YAML mapping/,
    },
    {
      name: "skill name mismatch",
      mutate: (root) =>
        replaceText(root, "skills/start-migration/SKILL.md", "name: start-migration", "name: wrong"),
      expected: /Skill file\/name mismatch: start-migration/,
    },
    {
      name: "blank description",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "description: Start a legacy module migration",
          'description: "   "',
        ),
      expected: /Skill has no description: start-migration/,
    },
    {
      name: "overlong description",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "description: Start a legacy module migration",
          `description: ${"x".repeat(1025)}`,
        ),
      expected: /Skill description is too long: start-migration/,
    },
    {
      name: "non-string compatibility",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "compatibility: claude, copilot",
          "compatibility: [claude, copilot]",
        ),
      expected: /Skill has invalid compatibility: start-migration/,
    },
    {
      name: "non-string allowed-tools",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "compatibility: claude, copilot",
          "compatibility: claude, copilot\nallowed-tools: [Read]",
        ),
      expected: /Skill allowed-tools must be a string: start-migration/,
    },
    {
      name: "non-string metadata value",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "sources_reviewed: https://example.test/migration",
          "sources_reviewed: [https://example.test/migration]",
        ),
      expected: /Skill metadata values must be strings: start-migration/,
    },
    {
      name: "non-boolean user-invocable",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "user-invocable: true",
          "user-invocable: yes-please",
        ),
      expected: /Skill user-invocable must be boolean: start-migration/,
    },
    {
      name: "legacy camelCase field",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "disable-model-invocation: true",
          "disableModelInvocation: true",
        ),
      expected: /unsupported camelCase field disableModelInvocation: start-migration/,
    },
    {
      name: "malformed YAML",
      mutate: (root) =>
        replaceText(
          root,
          "skills/start-migration/SKILL.md",
          "description: Start a legacy module migration",
          "description: [broken",
        ),
      expected: /flow sequence|YAML/i,
    },
  ];

  for (const testCase of cases) {
    const root = await createFixture();
    await testCase.mutate(root);
    try {
      await expectFailureWithoutWrites(root, testCase.expected);
      assert.equal(
        await pathExists(root, "providers"),
        false,
        "no provider tree may exist after a rejected run",
      );
    } catch (error) {
      throw new Error(`Failure case did not behave as expected: ${testCase.name}`, {
        cause: error,
      });
    }
  }
});

test("the provider set is closed, and no CLI option can widen it", async () => {
  assert.deepEqual([...providerNames].sort(), PROVIDERS);

  // The generator takes exactly one flag. An unknown target is rejected because
  // there is no way to name one, which is stronger than a validator that a
  // future option could forget to call.
  const root = await createFixture();
  const stdoutPath = path.join(root, "stdout");
  const stderrPath = path.join(root, "stderr");
  const stdout = await open(stdoutPath, "w");
  const stderr = await open(stderrPath, "w");
  const child = spawn(
    process.execPath,
    [path.join(repositoryRoot, "scripts/providers-sync.mjs"), "--provider", "cursor"],
    { cwd: repositoryRoot, stdio: ["ignore", stdout.fd, stderr.fd] },
  );
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  assert.equal(code, 1);
  assert.match(await readFile(stderrPath, "utf8"), /Unknown argument: --provider/);
  assert.equal(await readFile(stdoutPath, "utf8"), "", "a rejected invocation must generate nothing");
});

test("rejects malformed manifest ownership entries", async () => {
  for (const malformed of [
    ["../outside.txt"],
    ["/etc/passwd"],
    ["providers/a.md", "providers/a.md"],
    ["providers/./a.md"],
    [42],
  ]) {
    const root = await createFixture();
    await writeText(root, manifestPath, `${JSON.stringify(malformed)}\n`);
    await assert.rejects(
      runProvidersSync({ root }),
      new RegExp(`Invalid generated files manifest: ${manifestPath.replace("/", "\\/")}`),
      `${JSON.stringify(malformed)} must be rejected`,
    );
  }
});

test("fails before writing when an output path is an existing directory", async () => {
  const root = await createFixture();
  await mkdir(path.join(root, "providers/codex/config.toml"), { recursive: true });

  await assert.rejects(
    runProvidersSync({ root }),
    /Generated file path is a directory: providers\/codex\/config\.toml/,
  );
  assert.equal(await pathExists(root, "providers/claude/.mcp.json"), false);
});

// --- negative: symlinks, junctions and permissions ---------------------------

const fileSymlink = async (t, target, link) => {
  try {
    await symlink(target, link);
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Windows runner cannot create file symlinks");
      return false;
    }
    throw error;
  }
};

test("rejects direct and nested canonical file symlinks", async (t) => {
  const direct = await createFixture();
  await rm(path.join(direct, "skills/start-migration/references/contract.md"));
  if (!await fileSymlink(t,
    path.join(direct, "unrelated/repository-file.txt"),
    path.join(direct, "skills/start-migration/references/contract.md"),
  )) return;
  await expectFailureWithoutWrites(
    direct,
    /Canonical sources cannot be symlinks: skills\/start-migration\/references\/contract\.md/,
  );

  const nested = await createFixture();
  if (!await fileSymlink(t,
    path.join(nested, "unrelated/repository-file.txt"),
    path.join(nested, "skills/start-migration/references/linked.md"),
  )) return;
  await expectFailureWithoutWrites(
    nested,
    /Canonical sources cannot be symlinks: skills\/start-migration\/references\/linked\.md/,
  );
});

test("rejects a canonical directory junction", async () => {
  const directory = await createFixture();
  await rename(path.join(directory, "skills"), path.join(directory, "real-skills"));
  await symlink(path.join(directory, "real-skills"), path.join(directory, "skills"), "junction");
  await expectFailureWithoutWrites(
    directory,
    /Canonical sources cannot be symlinks: skills/,
  );
});

test("rejects an output file symlink without following it", async (t) => {
  const output = await createFixture();
  await mkdir(path.join(output, "providers/claude"), { recursive: true });
  if (!await fileSymlink(t,
    path.join(output, "unrelated/repository-file.txt"),
    path.join(output, "providers/claude/.mcp.json"),
  )) return;
  await assert.rejects(
    runProvidersSync({ root: output }),
    /Generated file path is a symlink: providers\/claude\/\.mcp\.json/,
  );
  assert.equal(await readText(output, "unrelated/repository-file.txt"), "keep me\n");
});

test("rejects an output parent junction without following it", async () => {
  const parent = await createFixture();
  await mkdir(path.join(parent, "outside"), { recursive: true });
  await mkdir(path.join(parent, "providers/codex"), { recursive: true });
  await symlink(path.join(parent, "outside"), path.join(parent, "providers/codex/prompts"), "junction");
  await assert.rejects(
    runProvidersSync({ root: parent }),
    /Generated file path is a symlink: providers\/codex\/prompts\/start-migration\.md/,
  );
  assert.deepEqual(await readdir(path.join(parent, "outside")), []);
});

test("rejects a stale manifest path through a junction without deleting its target", async () => {
  const root = await createFixture();
  await runProvidersSync({ root });
  await mkdir(path.join(root, "outside"));
  await writeText(root, "outside/stale.md", "keep me\n");
  await symlink(path.join(root, "outside"), path.join(root, "providers/legacy"), "junction");
  await writeText(
    root,
    manifestPath,
    `${JSON.stringify([...EXPECTED, "providers/legacy/stale.md"].sort(), null, 2)}\n`,
  );

  await assert.rejects(
    runProvidersSync({ root }),
    /Generated file path is a symlink: providers\/legacy\/stale\.md/,
  );
  assert.equal(await readText(root, "outside/stale.md"), "keep me\n");
});

/**
 * The consumer's staging name was `<output>.agents-sync.tmp` -- derivable, so a
 * symlink planted there redirected a write outside the repository. Two things
 * close that here, and both are asserted: the name carries a random UUID, and
 * `open(temp, "wx")` refuses any existing path including a symlink. A planted
 * fixed-name file therefore survives untouched, and no staging file is left
 * behind for a later run to follow.
 */
test("leaves no staging residue and does not write through a planted fixed-name path", async (t) => {
  const root = await createFixture();
  const sentinel = path.join(root, "outside-sentinel.txt");
  await writeFile(sentinel, "keep sentinel\n");
  await mkdir(path.join(root, "providers/claude"), { recursive: true });
  const planted = "providers/claude/.providers-sync.tmp";
  if (!await fileSymlink(t, sentinel, path.join(root, planted))) return;

  await runProvidersSync({ root });

  assert.equal(await readFile(sentinel, "utf8"), "keep sentinel\n");
  assert.equal((await lstat(path.join(root, planted))).isSymbolicLink(), true);

  // No `.providers-sync-<uuid>.tmp` anywhere: a leftover is a name a later run
  // could be redirected through, and a failed staging must clean up after itself.
  const residue = (await listFiles(root, "providers")).filter((entry) =>
    /\.providers-sync-/.test(entry),
  );
  assert.deepEqual(residue, []);

  // And the name is not derivable: staging is UUID-suffixed by construction.
  const generator = await readFile(
    path.join(repositoryRoot, "scripts/providers-sync.mjs"),
    "utf8",
  );
  assert.match(generator, /\.providers-sync-\$\{randomUUID\(\)\}\.tmp/);
  assert.match(generator, /open\(temp, "wx"\)/);
});

const permissionTest =
  process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test;

permissionTest("rejects an unreadable canonical source without changing outputs", async () => {
  const root = await createFixture();
  const source = path.join(root, "skills/start-migration/references/contract.md");
  await chmod(source, 0o000);
  try {
    await expectFailureWithoutWrites(root, /EACCES|permission denied/i);
  } finally {
    await chmod(source, 0o644);
  }
});

// --- canonical-tree parity and the skills lock ------------------------------

test("the committed provider trees are byte-for-byte what the canonical skills project", async () => {
  const { differences } = await runProvidersSync({
    root: repositoryRoot,
    checkOnly: true,
  });
  assert.deepEqual(differences, [], "run `pnpm providers:sync` and commit the result");
});

test("every canonical file reaches all four provider trees, and only SKILL.md differs", async () => {
  let compared = 0;
  for (const skill of await canonicalSkillNames(repositoryRoot)) {
    const canonicalRoot = path.join(repositoryRoot, "skills", skill);
    const document = await readFile(path.join(canonicalRoot, "SKILL.md"), "utf8");
    const body = document.slice(document.indexOf("\n---\n") + 5).trim();

    for (const relative of (await readdir(canonicalRoot, { recursive: true }))
      .map((entry) => entry.split(path.sep).join("/"))
      .filter((entry) => !entry.startsWith("node_modules/"))) {
      const absolute = path.join(canonicalRoot, relative);
      if (!(await stat(absolute)).isFile()) continue;
      const canonical = await readFile(absolute);
      for (const provider of PROVIDERS) {
        const copy = path.join(
          repositoryRoot,
          "providers",
          provider,
          "skills",
          skill,
          relative,
        );
        if (relative === "SKILL.md") {
          const generated = await readFile(copy, "utf8");
          assert.ok(
            generated.includes("Generated by pnpm providers:sync"),
            `${provider}/${skill} must carry the generated-source banner`,
          );
          assert.ok(
            generated.trimEnd().endsWith(body),
            `${provider}/${skill} body diverged from canonical`,
          );
          const frontmatter = generated.slice(4, generated.indexOf("\n---\n"));
          assert.equal(
            frontmatter.includes("user-invocable"),
            provider === "claude" && document.includes("user-invocable: true"),
            `${provider}/${skill} frontmatter transform is wrong`,
          );
        } else {
          assert.ok(
            canonical.equals(await readFile(copy)),
            `providers/${provider}/skills/${skill}/${relative} diverged from canonical`,
          );
        }
        compared += 1;
      }
    }
  }
  assert.ok(compared > 20, `expected a real tree, compared ${compared} files`);
});

test("every generated skill copy carries the toolkit-identity operator surface and its no-hand-edit rule", async () => {
  // Normalized because the canonical documents wrap these sentences at
  // different columns; the rule is the text, not the line breaks.
  const flatten = (text) => text.replace(/\s+/g, " ");
  const required = [
    "artifact-migration-toolkit status|adopt|update|rollback",
    "An identity MISMATCH is reconciled through `artifact-migration-toolkit`, never by manually editing persisted migration state.",
    "`status` is read-only",
    "`state.json`, `integrity.json` and `history/history.ndjson` are never hand-edited to reconcile toolkit identity.",
  ];

  for (const skill of await canonicalSkillNames(repositoryRoot)) {
    for (const provider of PROVIDERS) {
      const relative = `providers/${provider}/skills/${skill}/SKILL.md`;
      const generated = flatten(await readText(repositoryRoot, relative));
      for (const rule of required) {
        assert.ok(
          generated.includes(flatten(rule)),
          `${relative} must document: ${rule}`,
        );
      }
      for (const verb of ["status", "adopt", "update", "rollback"]) {
        assert.ok(
          generated.includes(`artifact-migration-toolkit`) &&
            generated.includes(verb),
          `${relative} must document the '${verb}' identity command`,
        );
      }
    }
  }
});

test("every generated start-migration copy carries the module recovery transitions", async () => {
  // F-05. These transitions are executable in production but were absent from
  // the operator surface, so the only discoverable exit from a recoverable
  // refusal was an operator decision.
  const flatten = (text) => text.replace(/\s+/g, " ");
  const surfaces = {
    "SKILL.md": [
      "artifact-migration-discover <module> --rework-slice <id> --confirm-rework",
      "artifact-migration-discover <module> --reopen-ui <slice[,slice...]>",
      "artifact-migration-discover <module> --amend-slice <id> --add-file <path> [--add-file <path>...]",
      "`--amend-slice` is **add-only**",
      "requires at least one `--add-file`",
      "one of the two legitimate exits from `UNCLAIMED_TARGET_DRIFT`",
    ],
    "references/migration-contract.md": [
      "artifact-migration-discover <module> --rework-slice <id> --confirm-rework",
      "artifact-migration-discover <module> --amend-slice <id> --add-file <path> [--add-file <path>...]",
      "`--amend-slice` is **add-only**",
      "At least one `--add-file` is required.",
      "appends `SLICE_SCOPE_AMENDED`",
      "The refusal names both legitimate exits.",
      "`TARGET_DRIFT_ACCEPTED` operator decision",
    ],
  };

  for (const provider of PROVIDERS) {
    for (const [document, required] of Object.entries(surfaces)) {
      const relative = `providers/${provider}/skills/start-migration/${document}`;
      const generated = flatten(await readText(repositoryRoot, relative));
      for (const rule of required) {
        assert.ok(
          generated.includes(flatten(rule)),
          `${relative} must document: ${rule}`,
        );
      }
    }
  }
});

test("every provider entry point names its skill and carries no workflow logic", async () => {
  const entryPoints = {
    claude: (skill) => `providers/claude/skills/${skill}/SKILL.md`,
    codex: (skill) => `providers/codex/prompts/${skill}.md`,
    copilot: (skill) => `providers/copilot/prompts/${skill}.prompt.md`,
    opencode: (skill) => `providers/opencode/commands/${skill}.md`,
  };
  const manifest = await readManifest(repositoryRoot);

  for (const skill of await canonicalSkillNames(repositoryRoot)) {
    for (const [provider, resolve] of Object.entries(entryPoints)) {
      const relative = resolve(skill);
      assert.ok(manifest.includes(relative), `${relative} must be generated`);
      const content = await readText(repositoryRoot, relative);
      assert.ok(content.includes(skill), `${relative} must name ${skill}`);
      if (provider === "claude") continue;
      // A wrapper loads the skill and forwards the invocation text. Four copies
      // of the workflow is exactly what these files exist to prevent. Asserted
      // by content, not by size: the frontmatter carries the skill description
      // verbatim, so a length bound would track description edits instead.
      const body = content.slice(content.indexOf("\n---\n") + 5);
      assert.match(
        body,
        /Load and follow the `[a-z-]+` skill/,
        `${relative} must be a generated wrapper that loads the skill`,
      );
      for (const leak of ["DISCOVERY_COMPLETENESS", "loop:", "artifactHashes"]) {
        assert.ok(!body.includes(leak), `${relative} carries workflow logic ('${leak}')`);
      }
    }
  }
});

test("skills-lock.json matches the canonical skill bytes, and the hash tracks both path and content", async () => {
  const lock = JSON.parse(await readText(repositoryRoot, "skills-lock.json"));
  const entries = await skillLockEntries(repositoryRoot);
  assert.deepEqual(Object.keys(lock.skills).sort(), SKILLS);
  for (const [name, entry] of Object.entries(entries)) {
    assert.equal(lock.skills[name]?.computedHash, entry.computedHash, `${name} is unlocked`);
    assert.equal(lock.skills[name]?.skillPath, `skills/${name}`);
  }

  // Same tree, one byte different: the hash must not survive it.
  const root = await createFixture();
  const before = await computeSkillHash(root, "start-migration");
  await writeText(
    root,
    "skills/start-migration/references/contract.md",
    `${await readText(root, "skills/start-migration/references/contract.md")}// drift\n`,
  );
  const afterEdit = await computeSkillHash(root, "start-migration");
  assert.notEqual(afterEdit, before);

  // A rename with identical bytes must move it too.
  await rename(
    path.join(root, "skills/start-migration/references/contract.md"),
    path.join(root, "skills/start-migration/references/renamed.md"),
  );
  assert.notEqual(await computeSkillHash(root, "start-migration"), afterEdit);
});

/**
 * T16. The digest is the stamp's own release binding, so the stamp cannot be an
 * input to it -- and what remains covered is exactly skill semantics. Both
 * halves matter: excluding too much would let real drift through, and excluding
 * nothing at all is the cycle that kept the digest out of the stamp until now.
 */
test("computeSkillHash covers skill semantics and excludes the identity stamp it feeds", async () => {
  const root = await createFixture();
  await writeText(root, "package.json", `${JSON.stringify({ name: "artifact-migration-tools", version: "9.9.9" }, null, 2)}\n`);

  const before = await computeSkillHash(root, "start-migration");
  const stamp = await identityDocument(root, "start-migration");
  assert.equal(JSON.parse(stamp).computedHash, before, "the stamp must carry the digest of the skill it stamps");

  // Writing the stamp -- the whole file, with the digest inside it -- does not
  // move the digest. Without this, the field could not exist at all.
  await writeFile(identityPath(root, "start-migration"), stamp);
  assert.equal(await computeSkillHash(root, "start-migration"), before);

  // And a version bump rewrites the stamp without touching skill semantics.
  await writeText(root, "package.json", `${JSON.stringify({ name: "artifact-migration-tools", version: "9.9.10" }, null, 2)}\n`);
  const bumped = await identityDocument(root, "start-migration");
  await writeFile(identityPath(root, "start-migration"), bumped);
  assert.notEqual(bumped, stamp);
  assert.equal(await computeSkillHash(root, "start-migration"), before);
  assert.equal(JSON.parse(bumped).computedHash, before);

  // Every other canonical file still moves it: protocol semantics, references
  // and the shared bootstrap alike.
  for (const [relative, content] of [
    ["skills/start-migration/SKILL.md", `${await readText(root, "skills/start-migration/SKILL.md")}\nDrift.\n`],
    ["skills/start-migration/references/contract.md", "Different contract.\n"],
    ["skills/start-migration/scripts/runtime.mjs", "export const drifted = true;\n"],
  ]) {
    const previous = await computeSkillHash(root, "start-migration");
    await writeText(root, relative, content);
    assert.notEqual(await computeSkillHash(root, "start-migration"), previous, `${relative} is outside the digest`);
  }

  // Order-independent: the lock and the stamps agree however they are written.
  const { writeSkillsLock, lockPath } = await import("../scripts/skills-lock.mjs");
  const first = await writeSkillsLock(root);
  const stamps = await Promise.all((await canonicalSkillNames(root)).map((name) => readText(root, `skills/${name}/${IDENTITY_BASENAME}`)));
  const second = await writeSkillsLock(root);
  assert.deepEqual(second, first);
  assert.deepEqual(
    await Promise.all((await canonicalSkillNames(root)).map((name) => readText(root, `skills/${name}/${IDENTITY_BASENAME}`))),
    stamps,
  );
  const locked = JSON.parse(await readFile(lockPath(root), "utf8"));
  for (const name of await canonicalSkillNames(root)) {
    assert.equal(locked.skills[name].computedHash, JSON.parse(await readText(root, `skills/${name}/${IDENTITY_BASENAME}`)).computedHash);
  }
});

/**
 * The release gate for the same binding: a stamp and a manifest that disagree
 * about one skill's digest can never ship, because selection reads the stamp
 * and proves it against the manifest.
 */
test("a staged stamp whose computedHash disagrees with skills-lock.json blocks the release", async () => {
  const live = await releaseCheck(repositoryRoot);
  assert.deepEqual(live.blockers.filter((blocker) => /computedHash/.test(blocker)), []);

  const root = await mkdtemp(path.join(os.tmpdir(), "stamp-manifest-"));
  fixtureRoots.add(root);
  for (const relative of await payloadPaths(repositoryRoot)) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, relative), destination);
  }
  const lock = JSON.parse(await readText(root, "skills-lock.json"));
  lock.skills["start-migration"].computedHash = "0".repeat(64);
  await writeText(root, "skills-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

  const drifted = await releaseCheck(root);
  const blockers = drifted.blockers.filter((blocker) => /computedHash/.test(blocker));
  assert.equal(blockers.length, 1, drifted.blockers.join("; "));
  assert.match(blockers[0], /skills\/start-migration/);
  assert.match(blockers[0], /skills-lock\.json/);
});

test("a standard tree install carries the real toolkit version, with no placeholder to resolve", async () => {
  const manifest = JSON.parse(await readText(repositoryRoot, "package.json"));

  for (const skill of SKILLS) {
    // `skills add <repo>` copies the committed skill directory as-is: no packaging
    // step, no runtime, no placeholder renderer. This is what a normal install
    // lands on, so it is what has to already be true.
    const installed = await mkdtemp(path.join(os.tmpdir(), `skills-add-${skill}-`));
    fixtureRoots.add(installed);
    await cp(path.join(repositoryRoot, "skills", skill), installed, {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("node_modules"),
    });

    const canonical = await readFile(path.join(installed, IDENTITY_BASENAME));
    const identity = JSON.parse(canonical.toString("utf8"));
    assert.deepEqual(identity, {
      name: manifest.name,
      version: manifest.version,
      skill,
      // The release binding. `version` selects a candidate release; this proves
      // the candidate carries the semantics actually installed, which version
      // equality alone cannot -- `skills add <repo>` installs current `main`
      // under an already-published version string.
      computedHash: await computeSkillHash(repositoryRoot, skill),
      source: "repository",
    });
    assert.match(identity.computedHash, /^[a-f0-9]{64}$/);
    assert.match(identity.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    assert.ok(
      !canonical.toString("utf8").includes("{{"),
      `${skill} would install an unresolved placeholder`,
    );
    // Commit and content hash are absent rather than placeheld: both are
    // unknowable while writing the file that feeds them. `source` is what says so.
    assert.ok(!("commit" in identity) && !("contentHash" in identity));

    // Every provider projection is the same bytes, so which provider installed a
    // skill cannot change what that skill says it is.
    for (const provider of PROVIDERS) {
      const projected = await readFile(
        path.join(repositoryRoot, `providers/${provider}/skills/${skill}/${IDENTITY_BASENAME}`),
      );
      assert.ok(projected.equals(canonical), `${provider}/${skill} identity drifted from canonical`);
    }
  }
});

// -- G-01: the documented AUTO authority is the engine's AUTO authority.
//
// The released skill claimed `auto` "never self-confirms a bootstrap and never
// accepts `--refresh`". Both are false: `maySelfConfirm` is `isAutoAuthority`
// for every command, and `--refresh --confirm-mismatch --mode auto` is a valid
// operator authorization whose REFRESHED event names OPERATOR. Only the
// canonical source is edited, so this reads the real generated copies too --
// documentation drift that reaches providers is the failure that shipped.
test("the canonical AUTO rule states the real contract and reaches every provider", async () => {
  for (const relative of [
    "skills/start-migration/SKILL.md",
    ...PROVIDERS.map((provider) => `providers/${provider}/skills/start-migration/SKILL.md`),
  ]) {
    // The rule is one hard-wrapped paragraph, so match it unwrapped: where the
    // line breaks fall is formatting, not contract.
    const text = (await readText(repositoryRoot, relative)).replace(/\s+/g, " ");
    // No categorical refusal of an explicitly authorized refresh, and no claim
    // that a bootstrap is exempt from self-confirmation.
    assert.doesNotMatch(text, /never accepts `--refresh`/, relative);
    assert.doesNotMatch(text, /never self-confirms a bootstrap/, relative);
    // Autonomous refresh stays forbidden, explicitly.
    assert.match(
      text,
      /never refreshes a legacy mismatch or drift on its own initiative/,
      relative,
    );
    // Explicit operator authorization, valid in auto, with OPERATOR provenance.
    assert.match(
      text,
      /`--refresh --confirm-mismatch`, including while running `--mode auto`/,
      relative,
    );
    assert.match(text, /`REFRESHED` event records `principal: OPERATOR`/, relative);
    // AUTO is an authority, not an exemption from the authorization rules.
    assert.match(text, /not an exemption from the authorization rules/, relative);
  }
});

test("a committed skill identity that disagrees with the root manifest blocks the release", async () => {
  const blockerFor = (check, skill) =>
    check.blockers.filter((blocker) => blocker.startsWith(`skills/${skill}/${IDENTITY_BASENAME}`));

  // The real tree must be in agreement: this is the CI-side half of the guarantee.
  const live = await releaseCheck(repositoryRoot);
  for (const skill of SKILLS) {
    assert.deepEqual(blockerFor(live, skill), [], `skills/${skill} identity is stale`);
    assert.equal(
      await readText(repositoryRoot, `skills/${skill}/${IDENTITY_BASENAME}`),
      await identityDocument(repositoryRoot, skill),
    );
  }

  // A payload copy with one stale version is the failure this exists to catch: a
  // `skills add` install naming a release the tree is not.
  const root = await mkdtemp(path.join(os.tmpdir(), "release-identity-"));
  fixtureRoots.add(root);
  for (const relative of await payloadPaths(repositoryRoot)) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, relative), destination);
  }
  const stale = JSON.parse(await readText(root, `skills/start-migration/${IDENTITY_BASENAME}`));
  await writeFile(
    identityPath(root, "start-migration"),
    `${JSON.stringify({ ...stale, version: "0.0.1" }, null, 2)}\n`,
  );
  const drifted = await releaseCheck(root);
  assert.equal(blockerFor(drifted, "start-migration").length, 1, drifted.blockers.join("; "));
  assert.deepEqual(blockerFor(drifted, "migrate-artifact"), []);
});
