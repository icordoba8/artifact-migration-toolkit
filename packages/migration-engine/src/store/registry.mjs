/** Store: the migration registry and its project binding -- resolution, preview, persistence, journal recovery. */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { engineScriptsRoot, engineSkillRoot } from "../engine-paths.mjs";
import {
  assertPlainObject,
  assertProjectRootContainment,
  assertSafeName,
  execFileAsync,
  isLexicallyWithin,
  portablePath,
  samePath,
} from "../shared/index.mjs";
import { atomicWrite } from "./files.mjs";

const resolveRegistryRoot = (value, registryPath, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Migration ${label} root must be a non-empty path.`);
  }
  const expanded = value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => {
    const replacement = process.env[name];
    if (!replacement) {
      throw new Error(
        `Migration ${label} root requires environment variable ${name}.`,
      );
    }
    return replacement;
  });
  return path.resolve(path.dirname(registryPath), expanded);
};

const validateRegistry = (document, registryPath) => {
  const registry = assertPlainObject(document, "Migration registry");
  if (registry.version !== 1) {
    throw new Error("Migration registry version must be 1.");
  }
  const projects = assertPlainObject(
    registry.projects,
    "Migration registry projects",
  );
  const legacyRoot = resolveRegistryRoot(
    projects.legacy?.root,
    registryPath,
    "legacy",
  );
  const targetRoot = resolveRegistryRoot(
    projects.target?.root,
    registryPath,
    "target",
  );
  if (legacyRoot === targetRoot) {
    throw new Error("Legacy and target project roots must be different.");
  }
  if (!isLexicallyWithin(targetRoot, path.resolve(registryPath))) {
    throw new Error(
      "The migration registry must live inside the target repository.",
    );
  }

  const modules = assertPlainObject(
    registry.modules ?? {},
    "Migration registry modules",
  );
  const aliases = new Map();
  for (const [moduleName, rawEntry] of Object.entries(modules)) {
    assertSafeName(moduleName);
    const entry = assertPlainObject(rawEntry, `Registry entry '${moduleName}'`);
    assertSafeName(entry.target, `target for ${moduleName}`);
    if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) {
      throw new Error(`Aliases for '${moduleName}' must be an array.`);
    }
    for (const alias of entry.aliases ?? []) {
      assertSafeName(alias, `alias for ${moduleName}`);
      if (modules[alias] || aliases.has(alias)) {
        throw new Error(`Ambiguous migration alias '${alias}'.`);
      }
      aliases.set(alias, moduleName);
    }
  }
  return { registry, legacyRoot, targetRoot, modules, aliases };
};

export const registryIdentity = (targetRoot, registryPath) =>
  portablePath(path.relative(targetRoot, registryPath));

const readProjectConfiguration = async (projectRoot) => {
  const configPath = path.join(projectRoot, "package.json");
  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Migration registry configuration requires the canonical project package.json at '${configPath}'.`,
      );
    }
    throw error;
  }
  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid project package.json: ${error.message}`);
  }
  const binding = document.config?.startMigration?.registry;
  if (
    binding !== undefined &&
    (typeof binding !== "string" || !binding.trim())
  ) {
    throw new Error(
      "Project configuration 'config.startMigration.registry' must be a non-empty string.",
    );
  }
  return {
    binding: binding ?? null,
    configPath,
    content,
    document,
    registryPath: binding ? path.resolve(projectRoot, binding) : null,
  };
};

/** A path with every symlink resolved, or `null` if it cannot be resolved. */
const canonical = async (target) => realpath(target).catch(() => null);

/**
 * The Git repository root that owns `directory`, canonicalized, or `null`.
 *
 * `null` is "not proven": no repository, no Git, an unreadable path. The only
 * caller treats that as "cannot claim ownership", so an unprovable answer
 * narrows what the engine may assume instead of widening it -- the fallback is
 * ordinary discovery from the caller's own directory, which needs no proof.
 */
const gitTopLevel = async (directory) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    return await canonical(stdout.trim());
  } catch {
    return null;
  }
};

/**
 * The project root of a legacy in-repo installation, or `null`.
 *
 * Before the engine could be installed anywhere, it only ever lived inside the
 * repository it migrated, at `<project>/<provider>/skills/<skill>/scripts`, and
 * `<project>` was four levels up from the scripts directory. That convenience
 * is kept -- it is what lets a command run from a nested workspace package that
 * carries its own `package.json` and still find the repository's registry
 * binding -- but it is now proven instead of assumed.
 *
 * Depth alone is not proof, and this is the defect the proof exists for: a
 * toolkit checked out at `<home>/toolkit` with a consumer repository beside it
 * at `<home>/consumer` is also four levels up from `<home>`. Answering `<home>`
 * there hands every registry and state lookup a project root belonging to
 * neither repository, and the consumer's own binding is never read.
 *
 * No provider is named. The shape is "a dot-directory that holds `skills/`",
 * which is what `.agents` and every generated provider tree are; the engine
 * stays free of provider-specific knowledge.
 *
 * Shape is necessary and not sufficient, which is the second defect: a
 * user-level install at `<home>/<provider>/skills/<skill>/scripts` has exactly
 * this shape, and `<home>` may well hold a package.json of its own, so a
 * consumer repository anywhere below `<home>` would have `<home>` answered as
 * its project root and its own binding never read. Ownership is therefore
 * proven by repository identity instead: one Git repository has to contain the
 * engine, contain the caller, and *be* the candidate root.
 */
const legacyInstalledProjectRoot = async (cwd) => {
  const skills = path.dirname(engineSkillRoot);
  const provider = path.dirname(skills);
  const project = path.dirname(provider);
  if (path.basename(skills) !== "skills") return null;
  if (!path.basename(provider).startsWith(".")) return null;
  if (project === provider) return null;
  try {
    await access(path.join(project, "package.json"), fsConstants.R_OK);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const owner = await gitTopLevel(engineScriptsRoot);
  if (!owner) return null;
  if (owner !== (await gitTopLevel(cwd))) return null;
  if (owner !== (await canonical(project))) return null;
  return project;
};

export const projectRootFor = async (cwd) => {
  const legacy = await legacyInstalledProjectRoot(cwd);
  if (legacy && isLexicallyWithin(legacy, cwd)) return legacy;
  let current = path.resolve(cwd);
  while (true) {
    try {
      await readFile(path.join(current, "package.json"), "utf8");
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    "Cannot locate the canonical project package.json needed for migration registry configuration.",
  );
};

const readStateRegistry = async (targetRoot, moduleName) => {
  const statePath = path.join(
    targetRoot,
    ".agents/knowledge/migrations/modules",
    moduleName,
    "state.json",
  );
  let content;
  try {
    content = await readFile(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let state;
  try {
    state = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid migration state JSON at '${statePath}': ${error.message}`,
    );
  }
  const identity =
    state.registry ?? ".agents/knowledge/migrations/registry.json";
  if (
    typeof identity !== "string" ||
    !identity.trim() ||
    path.isAbsolute(identity)
  ) {
    throw new Error(
      `Migration state registry binding is invalid at '${statePath}'.`,
    );
  }
  const registryPath = path.resolve(targetRoot, identity);
  if (!isLexicallyWithin(targetRoot, registryPath)) {
    throw new Error(
      `Migration state registry binding escapes the target at '${statePath}'.`,
    );
  }
  return { registryPath, statePath, targetRoot };
};

const stateRegistryFromCwd = async (cwd, moduleName) => {
  let current = path.resolve(cwd);
  while (true) {
    const state = await readStateRegistry(current, moduleName);
    if (state) return state;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const stateRegistryFromCandidate = async (candidate, moduleName) => {
  try {
    const registryData = await readRegistry(candidate);
    const canonical = registryData.modules[moduleName]
      ? moduleName
      : (registryData.aliases.get(moduleName) ?? moduleName);
    return readStateRegistry(registryData.targetRoot, canonical);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
};

const stateRegistryFromWorkspace = async (projectRoot, moduleName) => {
  const matches = [];
  const visit = async (directory) => {
    const state = await readStateRegistry(directory, moduleName);
    if (state) matches.push(state);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        ["coverage", "dist", "node_modules", "production"].includes(entry.name)
      ) {
        continue;
      }
      await visit(path.join(directory, entry.name));
    }
  };
  await visit(projectRoot);
  if (matches.length > 1) {
    throw new Error(
      `Multiple existing migration states named '${moduleName}' were found in the workspace; restore project configuration to select the intended target.`,
    );
  }
  return matches[0] ?? null;
};

const mismatch = (source, sourcePath, authoritativeSource, authoritativePath) =>
  new Error(
    `Migration registry binding mismatch: ${source} resolves to '${sourcePath}', but ${authoritativeSource} resolves to '${authoritativePath}'.`,
  );

export const resolveRegistryPath = async ({
  cliPath,
  moduleName,
  cwd = process.cwd(),
  environmentPath = process.env.MIGRATION_REGISTRY_PATH,
  projectRoot,
} = {}) => {
  const resolvedProjectRoot = projectRoot ?? (await projectRootFor(cwd));
  const project = await readProjectConfiguration(resolvedProjectRoot);
  const sources = [
    ["--registry", cliPath ? path.resolve(cwd, cliPath) : null],
    ["project configuration", project.registryPath],
    [
      "MIGRATION_REGISTRY_PATH",
      environmentPath ? path.resolve(cwd, environmentPath) : null,
    ],
  ].filter(([, value]) => value);

  let state = moduleName ? await stateRegistryFromCwd(cwd, moduleName) : null;
  if (!state && moduleName) {
    for (const [, candidate] of sources) {
      state = await stateRegistryFromCandidate(candidate, moduleName);
      if (state) break;
    }
  }
  if (!state && moduleName) {
    state = await stateRegistryFromWorkspace(resolvedProjectRoot, moduleName);
  }

  const authoritative = state
    ? ["existing migration state", state.registryPath]
    : sources[0];
  if (!authoritative) {
    throw new Error(
      "Migration registry is not configured. On first setup pass --registry <path>; otherwise restore config.startMigration.registry in the project package.json. MIGRATION_REGISTRY_PATH is available only as a CI fallback.",
    );
  }
  for (const [source, candidate] of sources) {
    if (!samePath(candidate, authoritative[1])) {
      throw mismatch(source, candidate, authoritative[0], authoritative[1]);
    }
  }
  if (cliPath && (state || project.binding)) {
    throw new Error(
      "--registry is accepted only during first setup. Omit it and use the persisted migration registry binding.",
    );
  }

  const registryData = await readRegistry(authoritative[1]);
  if (state) {
    const currentIdentity = registryIdentity(
      registryData.targetRoot,
      registryData.registryPath,
    );
    const stateIdentity = registryIdentity(
      state.targetRoot,
      state.registryPath,
    );
    if (currentIdentity !== stateIdentity) {
      throw mismatch(
        "resolved registry",
        currentIdentity,
        "existing migration state",
        stateIdentity,
      );
    }
  }
  return {
    projectRoot: resolvedProjectRoot,
    registryIdentity: registryIdentity(
      registryData.targetRoot,
      registryData.registryPath,
    ),
    registryPath: registryData.registryPath,
  };
};

export const previewProjectRegistryBinding = async (
  registryData,
  projectRoot,
) => {
  assertProjectRootContainment(projectRoot, registryData);
  const project = await readProjectConfiguration(projectRoot);
  const relative = path.relative(projectRoot, registryData.registryPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    // An absolute binding is machine-specific and does not survive relocation,
    // so it is refused rather than silently persisted.
    throw new Error(
      `The migration registry at '${registryData.registryPath}' is not inside the project at '${projectRoot}', so no portable binding can be persisted. Run the command from the project that contains the registry.`,
    );
  }
  const binding = portablePath(relative);
  if (
    project.registryPath &&
    !samePath(project.registryPath, registryData.registryPath)
  ) {
    throw mismatch(
      "project configuration",
      project.registryPath,
      "resolved registry",
      registryData.registryPath,
    );
  }
  const document = structuredClone(project.document);
  document.config ??= {};
  document.config.startMigration ??= {};
  document.config.startMigration.registry = binding;
  const content = `${JSON.stringify(document, null, 2)}\n`;
  return {
    before: project.content,
    binding,
    changed: content !== project.content,
    configPath: project.configPath,
    content,
    identity: registryIdentity(
      registryData.targetRoot,
      registryData.registryPath,
    ),
    projectRoot,
  };
};

export const persistProjectRegistryBinding = async (preview) => {
  const current = await readFile(preview.configPath, "utf8");
  if (current !== preview.before) {
    throw new Error(
      "Migration registry configuration changed after preview. The confirmation is stale; preview again.",
    );
  }
  if (preview.changed) {
    await atomicWrite(preview.projectRoot, preview.configPath, preview.content);
  }
};

export const readRegistry = async (registryPath) => {
  if (typeof registryPath !== "string" || !registryPath.trim()) {
    throw new Error("Migration registry path must be a non-empty string.");
  }
  const resolvedRegistryPath = path.resolve(registryPath);
  const content = await readFile(resolvedRegistryPath, "utf8");
  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid migration registry JSON: ${error.message}`);
  }
  return {
    ...validateRegistry(document, resolvedRegistryPath),
    content,
    registryPath: resolvedRegistryPath,
  };
};

export const resolveModule = (registryData, inputName, targetOverride) => {
  assertSafeName(inputName);
  if (targetOverride !== undefined) assertSafeName(targetOverride, "target");
  const canonical = registryData.modules[inputName]
    ? inputName
    : (registryData.aliases.get(inputName) ?? inputName);
  const entry = registryData.modules[canonical];
  if (!entry && !targetOverride) {
    throw new Error(
      `Module '${inputName}' is not registered. Supply --target <target-module>.`,
    );
  }
  if (entry && targetOverride && entry.target !== targetOverride) {
    throw new Error(
      `Target '${targetOverride}' conflicts with registered target '${entry.target}' for '${canonical}'.`,
    );
  }
  return {
    canonical,
    target: entry?.target ?? targetOverride,
    registered: Boolean(entry),
  };
};

const nextRegistryDocument = (
  registryData,
  { moduleName, target, aliases },
) => {
  assertSafeName(moduleName);
  assertSafeName(target, "target");
  for (const alias of aliases) assertSafeName(alias, "alias");
  const existingCanonical = registryData.modules[moduleName]
    ? moduleName
    : registryData.aliases.get(moduleName);
  if (existingCanonical && existingCanonical !== moduleName) {
    throw new Error(
      `'${moduleName}' is already an alias for '${existingCanonical}'.`,
    );
  }
  const existing = registryData.modules[moduleName];
  if (existing && existing.target !== target) {
    throw new Error(
      `Target '${target}' conflicts with registered target '${existing.target}' for '${moduleName}'.`,
    );
  }
  for (const alias of aliases) {
    if (alias === moduleName || registryData.modules[alias]) {
      throw new Error(`Alias '${alias}' conflicts with a registered module.`);
    }
    const owner = registryData.aliases.get(alias);
    if (owner && owner !== moduleName) {
      throw new Error(`Alias '${alias}' already belongs to '${owner}'.`);
    }
  }

  const document = structuredClone(registryData.registry);
  const mergedAliases = [
    ...new Set([...(existing?.aliases ?? []), ...aliases]),
  ].sort();
  document.modules[moduleName] = {
    ...(existing ?? {}),
    target,
    ...(mergedAliases.length > 0 ? { aliases: mergedAliases } : {}),
  };
  document.modules = Object.fromEntries(
    Object.entries(document.modules).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  validateRegistry(document, registryData.registryPath);
  return `${JSON.stringify(document, null, 2)}\n`;
};

/**
 * Read-only registration preview. Writes nothing and returns the confirmation
 * ID bound to the exact registry bytes, module, target, and aliases shown.
 * @param {{ registryPath?: string, moduleName: string, target: string, aliases?: string[] }} options
 */
export const previewRegistryUpdate = async ({
  registryPath,
  projectRoot,
  moduleName,
  target,
  aliases = [],
}) => {
  const registryData = await readRegistry(registryPath);
  const registryBinding = await previewProjectRegistryBinding(
    registryData,
    projectRoot,
  );
  const content = nextRegistryDocument(registryData, {
    moduleName,
    target,
    aliases,
  });
  const preview = {
    registryPath: registryData.registryPath,
    moduleName,
    target,
    aliases: [...aliases].sort(),
    existingTarget: registryData.modules[moduleName]?.target ?? null,
    changed: content !== registryData.content,
    registryIdentity: registryBinding.identity,
    projectConfigPath: registryBinding.configPath,
    projectRegistryBinding: registryBinding.binding,
  };
  return {
    ...preview,
    before: registryData.content,
    content,
    registryBinding,
    targetRoot: registryData.targetRoot,
    confirmationId: createHash("sha256")
      .update(
        JSON.stringify({
          ...preview,
          before: registryData.content,
          after: content,
          projectBefore: registryBinding.before,
          projectAfter: registryBinding.content,
        }),
      )
      .digest("hex")
      .slice(0, 16),
  };
};

export const renderRegistryPreview = (preview) =>
  `Registration pre-execution summary\n` +
  `Registry: ${preview.registryPath}\n` +
  `Registry identity: ${preview.registryIdentity}\n` +
  `Persisted binding: ${preview.projectConfigPath} -> ${preview.projectRegistryBinding}\n` +
  `Module: ${preview.moduleName}\n` +
  `Target: ${preview.target}\n` +
  `Recorded target: ${preview.existingTarget ?? "none"}\n` +
  `Aliases: ${preview.aliases.length > 0 ? preview.aliases.join(", ") : "none"}\n` +
  `Action: ${preview.changed ? "write the updated registry" : "no change"}\n`;

export const registryJournalPathFor = (targetRoot) =>
  path.join(targetRoot, ".agents/knowledge/migrations/registry.journal.json");

/**
 * Finishes a registry+config write pair a previous invocation started but
 * never got to clean up (killed mid-write). Both halves are applied only if
 * their current bytes still match the journalled "before" snapshot, so a
 * legitimate later change is never clobbered; either way the journal is then
 * cleared. Runs under the registry lock, before any new update is computed.
 */
export const recoverRegistryJournal = async (targetRoot) => {
  const file = registryJournalPathFor(targetRoot);
  let journal;
  try {
    journal = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(
      `Registry transaction journal is unreadable at ${file}. Preserve it and inspect the transaction before continuing.`,
    );
  }
  const registryCurrent = await readFile(journal.registryPath, "utf8").catch(
    () => null,
  );
  if (registryCurrent === journal.registryBefore) {
    await atomicWrite(targetRoot, journal.registryPath, journal.registryAfter);
  }
  if (journal.configPath) {
    const configCurrent = await readFile(journal.configPath, "utf8").catch(
      () => null,
    );
    if (configCurrent === journal.configBefore) {
      await atomicWrite(
        journal.projectRoot,
        journal.configPath,
        journal.configAfter,
      );
    }
  }
  await unlink(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
};
