/**
 * R-1: the engine renders every operator-facing command against its own
 * installed location, so an engine installed outside the repository it migrates
 * still prints commands that exist and run.
 *
 * The failure this suite exists to catch is specific: before R-1 the engine
 * emitted the literal `.agents/skills/start-migration/scripts/...`, which is a
 * path in the *consumer* repository. Installed anywhere else, every approval,
 * upgrade, recovery and rework instruction named a file that was not there --
 * and because those gates are fail-closed, an unrunnable command is a stuck
 * migration, not a cosmetic defect.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { linkPackageDependencies } from "../support/dependency-links.mjs";

import {
  engineArgv,
  engineCommand,
  engineScriptsRoot,
  engineSkillRoot,
  quoteCommandToken,
  skillRootFor,
  upgradeCommandFor,
} from "../../src/core.mjs";

const execFileAsync = promisify(execFile);
const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);
const repositoryRoot = path.resolve(scriptsRoot, "../../..");
/** The one engine package, which is what an install now copies. */
const enginePackage = path.resolve(scriptsRoot, "..");
/** The directory name the package keeps inside an installation root. */
const PACKAGE_DIR = "migration-engine";

/** The literal R-1 removed. Split so this file does not trip its own guard. */
const FORBIDDEN = [".agents/skills", "start-migration", "scripts"].join("/");

const exists = async (target) => {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if (error.code === "EISDIR") return true;
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

/**
 * The `node <script>` argument out of a rendered command, unquoted.
 *
 * Not `split(" ")[0]`: the installation path may contain a space, and a parser
 * that assumes otherwise is the defect being tested, written down as a test.
 */
const scriptOf = (command) => {
  assert.ok(command.startsWith("node "), `not a node command: ${command}`);
  const rest = command.slice("node ".length);
  const quote = rest[0] === "'" || rest[0] === '"' ? rest[0] : null;
  if (!quote) return rest.split(" ")[0];
  // `'\''` is the only escape either shell family produces. Mask it with an
  // equal-length placeholder so the closing quote is found at its real index.
  const end = rest.replaceAll(String.raw`'\''`, "\0\0\0\0").indexOf(quote, 1);
  assert.ok(end > 0, `unterminated quoted script: ${command}`);
  return rest.slice(1, end).replaceAll(String.raw`'\''`, "'");
};

// --- the contract ------------------------------------------------------------

test("R-1: the engine root is this module's own installed location", () => {
  assert.equal(engineScriptsRoot, scriptsRoot);
  // This suite no longer sits beside the sources, so the traversal is asserted
  // from a source path rather than from the suite's own location.
  assert.equal(
    skillRootFor(pathToFileURL(path.join(scriptsRoot, "core.mjs")).href),
    path.dirname(scriptsRoot),
  );
  assert.equal(engineSkillRoot, path.dirname(scriptsRoot));
  assert.equal(engineSkillRoot, enginePackage);
});

test("R-1: an installation path with a space renders a command a shell can run", async () => {
  // POSIX and Windows quote differently, so the rule for each is asserted from
  // whichever host runs the suite rather than only from that host's own.
  const posix = (value) => quoteCommandToken(value, "linux");
  assert.equal(posix("/home/user/tools/run.mjs"), "/home/user/tools/run.mjs");
  assert.equal(
    posix("/home/user/My Tools/run.mjs"),
    "'/home/user/My Tools/run.mjs'",
  );
  assert.equal(
    posix("/home/o'brien/run.mjs"),
    String.raw`'/home/o'\''brien/run.mjs'`,
  );
  assert.equal(posix("/opt/$HOME/run.mjs"), "'/opt/$HOME/run.mjs'");

  const win32 = (value) => quoteCommandToken(value, "win32");
  assert.equal(
    win32(String.raw`C:\Tools\run.mjs`),
    String.raw`C:\Tools\run.mjs`,
  );
  assert.equal(
    win32(String.raw`C:\Users\First Last\run.mjs`),
    String.raw`"C:\Users\First Last\run.mjs"`,
  );
  // A backslash is a path separator on Windows, never an escape, so the path
  // must survive quoting byte for byte.
  assert.equal(
    win32(String.raw`C:\Users\First Last\run.mjs`).slice(1, -1),
    String.raw`C:\Users\First Last\run.mjs`,
  );

  // And the POSIX rendering is genuinely what `sh` parses back out.
  if (process.platform !== "win32") {
    const awkward = "/home/o'brien/My Tools/$x/run.mjs";
    const { stdout } = await execFileAsync(
      "sh",
      ["-c", `printf %s ${quoteCommandToken(awkward, "linux")}`],
      { encoding: "utf8" },
    );
    assert.equal(stdout, awkward);
  }
});

test("R-1: engineArgv is the command's argv, so nothing has to parse it back", () => {
  const argv = engineArgv("record-decision.mjs", "auth", "--approve", "X");
  assert.deepEqual(argv, [
    path.join(scriptsRoot, "record-decision.mjs"),
    "auth",
    "--approve",
    "X",
  ]);
  assert.equal(
    scriptOf(engineCommand("record-decision.mjs", "auth", "--approve", "X")),
    argv[0],
  );
});

test("R-1: a rendered command is absolute and identical from any directory", async () => {
  // The rendering must not depend on where the caller stands. `--pending` is
  // compared for equality across calls, the CLI must print what the API
  // returned, and the MCP server chdirs into the caller's repository
  // mid-request -- three places where an ambient base becomes a moving one.
  const here = engineCommand("record-decision.mjs", "auth", "--approve", "X");
  assert.equal(path.isAbsolute(scriptOf(here)), true);

  const previous = process.cwd();
  process.chdir(os.tmpdir());
  try {
    assert.equal(
      engineCommand("record-decision.mjs", "auth", "--approve", "X"),
      here,
    );
  } finally {
    process.chdir(previous);
  }
  assert.ok(await exists(scriptOf(here)));
});

test("R-1: every rendered command names a file that exists", async () => {
  const commands = [
    upgradeCommandFor("auth"),
    engineCommand("record-decision.mjs", "auth", "--approve", "X"),
    engineCommand("cli/discover-module.mjs", "auth", "--status"),
    engineCommand("cli/run-migration.mjs", "auth"),
    engineCommand(
      "cli/update-migration-registry.mjs",
      "auth",
      "--target",
      "auth",
    ),
    engineCommand("upgrades/upgrade-migration.mjs", "auth", "--recover"),
  ];
  for (const command of commands) {
    const script = path.resolve(process.cwd(), scriptOf(command));
    assert.ok(await exists(script), `${command} names a missing file`);
    assert.ok(
      script.startsWith(`${scriptsRoot}${path.sep}`),
      `${command} escaped the engine installation`,
    );
  }
});

// --- the regression guard ----------------------------------------------------

/** Every executable engine source, as `src/<relative>` -> contents. */
const engineSources = async () => {
  const sources = new Map();
  for (const relative of await readdir(scriptsRoot, { recursive: true })) {
    if (!relative.endsWith(".mjs")) continue;
    if (relative.includes("node_modules")) continue;
    sources.set(
      `src/${relative.split(path.sep).join("/")}`,
      await readFile(path.join(scriptsRoot, relative), "utf8"),
    );
  }
  return sources;
};

test("R-1 guard: no engine source hardcodes the consumer-relative scripts path", async () => {
  const offenders = [];
  for (const [name, source] of await engineSources()) {
    if (source.includes(FORBIDDEN)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `executable engine sources must render commands through engineCommand, not the literal ${FORBIDDEN}`,
  );
});

test("R-1 guard: only the root helper may walk up out of the engine installation", async () => {
  // The literal guard above is not enough on its own: the topology can be
  // reintroduced without ever spelling it, by resolving a fixed number of
  // levels up from a module's own location and calling the result the
  // consumer's project root. Three or more `../` segments is that move --
  // `<skill>/scripts` is two deep, so anything past two has left the engine --
  // and `engine-paths.mjs` is the one authority allowed to make it.
  const offenders = [];
  for (const [name, source] of await engineSources()) {
    if (name.endsWith("engine-paths.mjs")) continue;
    if (/\.\.\/\.\.\/\.\.\//.test(source)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    "an engine-derived project root must come from engine-paths.mjs, not a fixed upward traversal",
  );
});

test("R-1 guard: consumer-owned migration state is still addressed by convention", async () => {
  // The guard above must not be read as "no .agents path may appear anywhere".
  // Records live in the consumer repository at a fixed, consumer-owned path,
  // and that is unchanged by R-1.
  const source = await readFile(
    path.join(scriptsRoot, "resumable-migration.mjs"),
    "utf8",
  );
  assert.ok(source.includes(".agents/knowledge/migrations/modules"));
});

// --- the external installation ----------------------------------------------

/**
 * Where an install puts the engine relative to the consumer repository.
 *
 * `legacy` is the only shape that existed before R-1 and the only one that may
 * still short-circuit project-root discovery; the rest are the shapes a real
 * toolkit checkout takes. `ancestor` is the one that was broken: the engine and
 * the consumer share a filesystem ancestor, and a fixed `../../../..` from the
 * engine lands on that shared ancestor and calls it the consumer's project.
 */
const LAYOUTS = {
  legacy: (home) => path.join(home, "consumer/.agents/skills"),
  ancestor: (home) => path.join(home, "toolkit/skills"),
  unrelated: (home, away) => path.join(away, "skills"),
  spaced: (home) => path.join(home, "My Toolkit/skills"),
};

/**
 * A user-level install: `<home>/<dot-provider>/skills/<skill>/scripts`.
 *
 * Filesystem-identical to a legacy in-repo install -- that is the point. Every
 * generated provider tree is a dot-directory holding `skills/`, so the shape
 * cannot distinguish "the engine lives in the repository it migrates" from "the
 * engine is installed under a home directory that happens to own a
 * package.json". These layouts are parameterized over the provider names rather
 * than matched in production, which names none of them.
 */
const DOT_PROVIDERS = [".agents", ".claude", ".codex", ".github", ".opencode"];
for (const provider of DOT_PROVIDERS) {
  LAYOUTS[`user-level ${provider}`] = (home) =>
    path.join(home, provider, "skills");
}

const CONSUMER_REGISTRY = ".agents/knowledge/migrations/registry.json";

/**
 * An engine installed at one of the layouts above, plus a consumer repository
 * that owns a registry, a persisted binding, and its own migration state.
 *
 * Declared dependencies are linked to their resolved store directories so the
 * pinned parser resolves without a second install on either platform.
 */
const externalInstall = async (
  layout = "ancestor",
  { homePackageJson = false, homeRepository = false } = {},
) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "sm-external-"));
  const away = await mkdtemp(path.join(os.tmpdir(), "sm-toolkit-"));
  const engineRoot = path.resolve(LAYOUTS[layout](home, away));
  const consumerRoot = path.join(home, "consumer");
  const registryPath = path.join(consumerRoot, CONSUMER_REGISTRY);
  await mkdir(path.join(consumerRoot, "legacy"), { recursive: true });
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(path.join(consumerRoot, "legacy/marker.txt"), "legacy\n");
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "consumer",
        private: true,
        config: { startMigration: { registry: CONSUMER_REGISTRY } },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        projects: {
          legacy: { root: "../../../legacy" },
          target: { root: "../../.." },
        },
        modules: { auth: { target: "auth" } },
      },
      null,
      2,
    )}\n`,
  );
  // A real consumer is a repository: the census is `git ls-files` and the
  // legacy revision is a commit, so the call sites that reach past registry
  // resolution need one to reach their own argument handling at all.
  await execFileAsync("git", ["init", "-q"], { cwd: consumerRoot });
  await execFileAsync("git", ["add", "-A"], { cwd: consumerRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=R1",
      "-c",
      "user.email=r1@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: consumerRoot },
  );
  // After the commit on purpose: under the `legacy` layout the engine lands
  // inside the consumer, and an engine tracked by the consumer's own census is
  // a fixture artefact, not something any of these layouts is about.
  const installedPackage = path.join(engineRoot, PACKAGE_DIR);
  await cp(enginePackage, installedPackage, {
    recursive: true,
    filter: (source) =>
      !source.split(path.sep).includes("node_modules") &&
      !source.split(path.sep).includes("test"),
  });
  await linkPackageDependencies(engineRoot, PACKAGE_DIR, "packages/migration-engine");
  // The directory holding the install owns a package.json of its own, which is
  // what turns the shared shape into a wrong answer: it is readable, so shape
  // plus readability "proves" a legacy in-repo install that does not exist.
  const homePackagePath = path.join(home, "package.json");
  if (homePackageJson) {
    await writeFile(
      homePackagePath,
      `${JSON.stringify({ name: "home", private: true }, null, 2)}\n`,
    );
  }
  // ... and a home directory can itself be a repository (dotfiles), so absence
  // of Git is not what disqualifies it. A *different* repository does.
  if (homeRepository) {
    await execFileAsync("git", ["init", "-q"], { cwd: home });
  }
  return {
    home,
    consumerRoot,
    registryPath,
    homePackagePath,
    script: (relative) =>
      path.join(engineRoot, PACKAGE_DIR, "src", ...relative.split("/")),
    /** Give the consumer a migration state bound to `registry`. */
    withState: async (registry) => {
      const statePath = path.join(
        consumerRoot,
        ".agents/knowledge/migrations/modules/auth/state.json",
      );
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify({ registry })}\n`);
      return statePath;
    },
    cleanup: () =>
      Promise.all(
        [home, away].map((target) =>
          rm(target, { recursive: true, force: true }),
        ),
      ),
  };
};

/** Ask an externally installed engine what it would tell an operator to run. */
const renderedBy = async (install, cwd = install.consumerRoot) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(
        pathToFileURL(install.script("core.mjs")).href,
      )}).then((c) => {
         const calls = {
           upgrade: ["upgrades/upgrade-migration.mjs", "auth"],
           recover: ["upgrades/upgrade-migration.mjs", "auth", "--recover"],
           rework: ["cli/discover-module.mjs", "auth", "--rework-slice", "slice-a", "--confirm-rework"],
           approve: ["record-decision.mjs", "auth", "--approve", "DEC-1"],
           artifact: ["record-decision.mjs", "--artifact", "x", "--approve", "DEC-1"],
         };
         // upgradeCommandFor is the production renderer, not a test recipe:
         // the upgrade row below is the one operators are actually shown.
         if (c.upgradeCommandFor("auth") !== c.engineCommand(...calls.upgrade)) {
           throw new Error("upgradeCommandFor diverged from engineCommand");
         }
         process.stdout.write(JSON.stringify(Object.fromEntries(
           Object.entries(calls).map(([name, call]) => [name, {
             command: c.engineCommand(...call),
             argv: c.engineArgv(...call),
           }]),
         )));
       });`,
    ],
    { encoding: "utf8", cwd },
  );
  return JSON.parse(stdout);
};

/** Run a script from the external engine and return everything it printed. */
const runExternal = async (argv, cwd) => {
  const result = await execFileAsync(process.execPath, argv, {
    encoding: "utf8",
    cwd,
  }).catch((error) => error);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

test("R-1 proof: the consumer repository holds state and no engine copy", async () => {
  const install = await externalInstall();
  try {
    assert.equal(
      await exists(path.join(install.consumerRoot, ".agents/skills")),
      false,
      "the consumer repository must not need an engine copy",
    );
    assert.equal(
      await exists(
        path.join(install.consumerRoot, ".agents/knowledge/migrations"),
      ),
      true,
    );
    assert.equal(await exists(install.script("record-decision.mjs")), true);
  } finally {
    await install.cleanup();
  }
});

// The layouts a real installation takes. `legacy` keeps the pre-R-1 shape
// honest; the other three are what R-1 exists for.
for (const layout of ["legacy", "ancestor", "unrelated", "spaced"]) {
  test(`R-1 proof (${layout}): the engine resolves the consumer registry, not its own ancestor`, async () => {
    const install = await externalInstall(layout);
    try {
      // Registration is the shortest production path through project-root
      // discovery: it reads `config.startMigration.registry` out of the
      // consumer's package.json and renders the binding it would persist.
      // Deriving the project root from a fixed `../../../..` answers the
      // shared ancestor here, which owns no package.json at all.
      const output = await runExternal(
        [
          install.script("cli/update-migration-registry.mjs"),
          "auth",
          "--target",
          "auth",
          // `--mode step` keeps this a read-only preview; under the default
          // auto principal the registration would execute on its own authority.
          "--mode",
          "step",
        ],
        install.consumerRoot,
      );
      assert.match(output, /Registration pre-execution summary/, output);
      assert.ok(
        output.includes(`Registry: ${install.registryPath}`),
        `resolved a registry outside the consumer:\n${output}`,
      );
      assert.ok(
        output.includes(
          `Persisted binding: ${path.join(install.consumerRoot, "package.json")} -> ${CONSUMER_REGISTRY}`,
        ),
        `bound the registry into the wrong project:\n${output}`,
      );
      // Read-only: the preview stops at a confirmation prompt.
      assert.match(output, /No execution has started/);
    } finally {
      await install.cleanup();
    }
  });

  test(`R-1 proof (${layout}): existing consumer migration state stays authoritative`, async () => {
    const install = await externalInstall(layout);
    try {
      // A state whose binding disagrees with the project configuration must
      // win and say so. The engine can only report this mismatch if it located
      // the consumer's state and the consumer's package.json -- neither of
      // which lives under an external engine's own ancestor.
      await install.withState(".agents/knowledge/migrations/decoy.json");
      const conflicted = await runExternal(
        [install.script("cli/discover-module.mjs"), "auth", "--status"],
        install.consumerRoot,
      );
      assert.match(conflicted, /binding mismatch/, conflicted);
      assert.ok(
        conflicted.includes("existing migration state"),
        `the consumer's state was never read:\n${conflicted}`,
      );
      assert.ok(
        conflicted.includes(
          path.join(
            install.consumerRoot,
            ".agents/knowledge/migrations/decoy.json",
          ),
        ),
        `the state binding was resolved against the wrong root:\n${conflicted}`,
      );

      // Agreeing state resolves, and the engine then reports on the consumer's
      // own record path rather than failing to find a project at all.
      await install.withState(CONSUMER_REGISTRY);
      const agreed = await runExternal(
        [install.script("cli/discover-module.mjs"), "auth", "--status"],
        install.consumerRoot,
      );
      assert.ok(
        !/Cannot locate the canonical project package\.json/.test(agreed),
        `project discovery landed outside the consumer:\n${agreed}`,
      );
      assert.ok(
        !/binding mismatch/.test(agreed),
        `agreeing bindings were reported as a conflict:\n${agreed}`,
      );
    } finally {
      await install.cleanup();
    }
  });

  test(`R-1 proof (${layout}): approval, upgrade, recovery, rework, and artifact approval all run`, async () => {
    const install = await externalInstall(layout);
    try {
      const rendered = await renderedBy(install);

      for (const [name, { command, argv }] of Object.entries(rendered)) {
        assert.ok(
          path.isAbsolute(scriptOf(command)),
          `${name} must be absolute when the engine is outside the cwd: ${command}`,
        );
        assert.equal(
          scriptOf(command),
          argv[0],
          `${name} renders a script its own argv disagrees with: ${command}`,
        );
        assert.ok(
          await exists(argv[0]),
          `${name} names a missing file: ${command}`,
        );
        if (layout !== "legacy") {
          assert.ok(
            !command.includes(`${FORBIDDEN}/`),
            `${name} still points into a consumer repository: ${command}`,
          );
        }
      }

      // Every one of them is then executed from the consumer repository. The
      // distinction that matters is engine-refusal versus module-not-found:
      // the second is exactly what a consumer-relative path produced before
      // R-1, and it is what an unquoted spaced path produces now.
      const diagnoses = Object.fromEntries(
        await Promise.all(
          Object.entries(rendered).map(async ([name, { argv }]) => [
            name,
            await runExternal([...argv], install.consumerRoot),
          ]),
        ),
      );
      for (const [name, output] of Object.entries(diagnoses)) {
        assert.ok(
          !output.includes("Cannot find module"),
          `${name} did not resolve: ${output}`,
        );
        assert.ok(output.trim().length > 0, `${name} produced no diagnosis`);
      }
      // Each reached its own argument handling, not a shared generic refusal.
      assert.match(diagnoses.recover, /upgrade transaction/i);
      assert.match(diagnoses.rework, /Pre-execution summary/);
      assert.match(diagnoses.approve, /interactive terminal/);
      assert.match(diagnoses.artifact, /interactive terminal/);
    } finally {
      await install.cleanup();
    }
  });
}

/** The registration preview's two resolved answers, or the raw output. */
const registrationOf = async (install, cwd = install.consumerRoot) => {
  const output = await runExternal(
    [
      install.script("cli/update-migration-registry.mjs"),
      "auth",
      "--target",
      "auth",
    ],
    cwd,
  );
  return {
    output,
    registry: /^Registry: (.+)$/m.exec(output)?.[1] ?? null,
    boundTo: /^Persisted binding: (.+) -> /m.exec(output)?.[1] ?? null,
  };
};

test("R-1 proof (legacy): a nested workspace package still resolves the repository's binding", async () => {
  // This is what the legacy short-circuit exists for, so the ownership proof
  // must not cost it: a command run from a workspace package that carries its
  // own package.json still finds the repository's registry binding rather than
  // binding the nested package. Same repository, so ownership holds.
  const install = await externalInstall("legacy");
  try {
    const nested = path.join(install.consumerRoot, "packages/foo");
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, "package.json"),
      `${JSON.stringify({ name: "foo", private: true }, null, 2)}\n`,
    );
    const { registry, boundTo, output } = await registrationOf(install, nested);
    assert.equal(registry, install.registryPath, output);
    assert.equal(boundTo, path.join(install.consumerRoot, "package.json"));
  } finally {
    await install.cleanup();
  }
});

// The reproduced R-1 defect. Parameterized over the provider directories rather
// than duplicated per provider, because production matches none of them: the
// rule is repository identity, and it rejects all five for the same reason.
for (const provider of DOT_PROVIDERS) {
  test(`R-1 proof (user-level ${provider}): an install's own ancestor is never the consumer`, async () => {
    const install = await externalInstall(`user-level ${provider}`, {
      homePackageJson: true,
    });
    try {
      const before = await readFile(install.homePackagePath, "utf8");
      const { registry, boundTo, output } = await registrationOf(install);
      assert.equal(registry, install.registryPath, output);
      assert.equal(
        boundTo,
        path.join(install.consumerRoot, "package.json"),
        `the install's own ancestor was bound instead of the consumer:\n${output}`,
      );
      assert.notEqual(boundTo, install.homePackagePath);
      assert.equal(
        await readFile(install.homePackagePath, "utf8"),
        before,
        "the ancestor package.json was written to",
      );
    } finally {
      await install.cleanup();
    }
  });
}

test("R-1 proof (user-level, ancestor is its own repository): a different repository is still not the consumer", async () => {
  // Absence of Git is not what disqualifies the ancestor -- a home directory
  // under dotfiles control is a real repository with the legacy shape and a
  // package.json. It is disqualified because the consumer is a *different*
  // repository, which is the only thing the rule ever checks.
  const install = await externalInstall("user-level .claude", {
    homePackageJson: true,
    homeRepository: true,
  });
  try {
    const { registry, boundTo, output } = await registrationOf(install);
    assert.equal(registry, install.registryPath, output);
    assert.equal(boundTo, path.join(install.consumerRoot, "package.json"));
  } finally {
    await install.cleanup();
  }
});

test("R-1 proof: a spaced installation renders a command the operator's shell can run", async () => {
  const install = await externalInstall("spaced");
  try {
    const { command, argv } = (await renderedBy(install)).approve;
    assert.ok(
      argv[0].includes(" "),
      `this layout must exercise a spaced path: ${argv[0]}`,
    );
    assert.notEqual(
      command,
      ["node", ...argv].join(" "),
      "a spaced path must not be rendered by a bare join",
    );
    assert.equal(scriptOf(command), argv[0]);

    if (process.platform !== "win32") {
      // The proof that matters: hand the rendered string to a shell, verbatim,
      // the way an operator pastes it. Unquoted, `sh` splits the path at the
      // space and node reports a module it cannot find.
      const result = await execFileAsync("sh", ["-c", command], {
        encoding: "utf8",
        cwd: install.consumerRoot,
      }).catch((error) => error);
      const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.ok(
        !/Cannot find module|No such file|not found/.test(text),
        `the shell could not run the rendered command: ${command}\n${text}`,
      );
      assert.match(text, /interactive terminal/);
    }
  } finally {
    await install.cleanup();
  }
});

test("R-1 proof: --doctor from an external engine reports the consumer, not its own ancestor", async () => {
  const install = await externalInstall();
  try {
    const result = await execFileAsync(
      process.execPath,
      [install.script("cli/discover-module.mjs"), "--doctor"],
      { encoding: "utf8", cwd: install.consumerRoot },
    ).catch((error) => error);
    const report = JSON.parse(result.stdout);
    const parser = report.checks.find(
      (check) => check.name === "discovery-parser",
    );
    // Whether the pinned parser resolves through the linked dependency or not, the
    // remediation must describe the engine that is actually installed.
    if (parser.status === "BLOCKED") {
      assert.ok(
        !parser.detail.includes(`${FORBIDDEN}/`),
        `the parser remediation still names a consumer path: ${parser.detail}`,
      );
      assert.match(parser.detail, /package\.json/);
    } else {
      assert.equal(parser.status, "OK");
    }
    // The writable-knowledge-root preflight is about the repository being
    // migrated. Answered from the engine's own ancestor it reports on a
    // directory the operator never asked about.
    const knowledge = report.checks.find(
      (check) => check.name === "knowledge-root",
    );
    assert.ok(
      knowledge.detail.startsWith(install.consumerRoot),
      `the preflight checked the wrong repository: ${knowledge.detail}`,
    );
  } finally {
    await install.cleanup();
  }
});

test("R-1 proof: the MCP server starts from an external engine installation", async () => {
  const install = await externalInstall();
  try {
    const server = spawn(process.execPath, [install.script("mcp-server.mjs")], {
      cwd: install.consumerRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const frames = [];
    let buffer = "";
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) frames.push(JSON.parse(line));
        index = buffer.indexOf("\n");
      }
    });
    server.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {},
        },
      })}\n`,
    );
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP server did not answer: ${buffer}`)),
        30_000,
      );
      const check = setInterval(() => {
        if (frames.length >= 2) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
      server.on("error", reject);
    });
    server.stdin.end();
    server.kill();

    assert.equal(frames[0].result.serverInfo.name, "start-migration");
    assert.ok(frames[1].result.tools.length > 0);
  } finally {
    await install.cleanup();
  }
});
