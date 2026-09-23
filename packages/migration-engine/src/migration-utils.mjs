import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  engineCommand,
  engineScriptsRoot,
  engineSkillRoot,
} from "./engine-paths.mjs";
import { withModuleLock, writeJournalAtomic } from "./module-lock.mjs";

const execFileAsync = promisify(execFile);
const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ponytail: keep the audit split explicit; absence remains the default.
export const PONYTAIL_TARGETS = {
  full: { audit: false },
  "full-audit": { audit: true },
};

const portablePath = (value) => value.replaceAll(path.sep, "/");

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const samePath = (left, right) =>
  comparablePath(left) === comparablePath(right);

const isPonytailTarget = (value) =>
  Object.hasOwn(PONYTAIL_TARGETS, value ?? "");

export const assertPonytailTarget = (value) => {
  if (!isPonytailTarget(value)) {
    throw new Error(
      `Invalid Ponytail target '${String(value)}'. Use ${Object.keys(PONYTAIL_TARGETS).join(" or ")}.`,
    );
  }
  return value;
};

export const assertSafeName = (value, label = "module") => {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new Error(
      `Invalid ${label} '${String(value)}'. Use lowercase letters, digits, and single hyphens.`,
    );
  }
  return value;
};

export const DESIGN_SOURCES = ["target-system", "figma-mcp"];

const FIGMA_FILE_KEY = /^[A-Za-z0-9]+$/;
// Figma encodes node ids in the URL as `<page>-<node>`; the canonical form is
// `<page>:<node>`. Only the URL form is accepted, then converted.
const FIGMA_NODE_ID = /^[0-9]+-[0-9]+$/;

/**
 * Pure, network-free normalization of one Figma link string into the persisted
 * reference `{ fileKey, nodeId, kind, raw }`. Only `/design/` and `/make/`
 * links are a UI design contract; FigJam (`/board/`) and Slides are refused.
 * Fail-closed, like `assertSafeName`: a malformed link stops the bootstrap
 * before anything is written.
 */
export const assertFigmaSource = (raw) => {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Figma source must be a non-empty URL string.");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid Figma URL '${raw}'.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Figma URL must use http(s): '${raw}'.`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== "figma.com" && host !== "www.figma.com") {
    throw new Error(`Figma URL host must be figma.com: '${raw}'.`);
  }
  if (url.username || url.password) {
    throw new Error("Figma URL must not carry userinfo credentials.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const kind = segments[0];
  if (kind === "board" || kind === "slides") {
    throw new Error(
      `Figma ${kind} links are not a UI design contract and cannot be a design source: '${raw}'.`,
    );
  }
  if (kind !== "design" && kind !== "make") {
    throw new Error(
      `Unsupported Figma URL '${raw}'. Use a /design/ or /make/ link.`,
    );
  }
  // Branch URLs (`/design/:key/branch/:branchKey/...`) address the branch as
  // the effective file, per the Figma URL rules.
  let fileKey = segments[1];
  if (kind === "design" && segments[2] === "branch" && segments[3]) {
    fileKey = segments[3];
  }
  if (!fileKey || !FIGMA_FILE_KEY.test(fileKey)) {
    throw new Error(`Figma URL is missing a valid file key: '${raw}'.`);
  }
  let nodeId = null;
  const rawNode = url.searchParams.get("node-id");
  if (rawNode !== null) {
    if (!FIGMA_NODE_ID.test(rawNode)) {
      throw new Error(`Invalid Figma node-id '${rawNode}' in '${raw}'.`);
    }
    nodeId = rawNode.replace("-", ":");
  }
  // Never persist the operator URL verbatim: rebuild a canonical reference from
  // the validated fields only, so credentials, extra query params, and
  // duplicate node-id values can never leak into or disagree with the pin.
  const canonical = new URL(`https://www.figma.com/${kind}/${fileKey}`);
  if (nodeId !== null) {
    canonical.searchParams.set("node-id", nodeId.replace(":", "-"));
  }
  return { fileKey, nodeId, kind, raw: canonical.toString() };
};

/**
 * The one rule that ties `--design-source` and `--figma` together, shared by
 * the bootstrap and the read-only preview so both agree on what gets pinned.
 * `target-system` (default) forbids Figma links; `figma-mcp` requires at least
 * one and dedupes by `fileKey#nodeId`.
 */
export const resolveDesignSource = ({ designSource, figma } = {}) => {
  const mode = designSource ?? "target-system";
  if (!DESIGN_SOURCES.includes(mode)) {
    throw new Error(
      `Invalid design source '${String(mode)}'. Use ${DESIGN_SOURCES.join(" or ")}.`,
    );
  }
  const links = Array.isArray(figma) ? figma : figma ? [figma] : [];
  if (mode === "target-system") {
    if (links.length > 0) {
      throw new Error("--figma links require --design-source figma-mcp.");
    }
    return { designSource: "target-system", figmaSources: [] };
  }
  const figmaSources = [];
  const seen = new Set();
  for (const link of links) {
    const source = assertFigmaSource(link);
    const dedupeKey = `${source.kind}#${source.fileKey}#${source.nodeId ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    figmaSources.push(source);
  }
  if (figmaSources.length === 0) {
    throw new Error(
      "--design-source figma-mcp requires at least one --figma link.",
    );
  }
  return { designSource: "figma-mcp", figmaSources };
};

/**
 * A direct twin of `resolveDesignSource` for `--legacy`: a repeatable flag
 * normalized into the persisted array, shared by the bootstrap and the
 * read-only preview so both agree on what gets pinned.
 *
 * Ordering is derived, never operator-controlled. `--legacy b --legacy a` and
 * `--legacy a --legacy b` must produce byte-identical state, because state
 * feeds the confirmation-ID snapshot; sorting here is what makes that true, and
 * it means nobody has to decide which source is "first".
 */
export const resolveLegacySources = (legacy) => {
  const names = Array.isArray(legacy) ? legacy : legacy ? [legacy] : [];
  for (const name of names) assertSafeName(name, "legacy source");
  return [...new Set(names)].sort();
};

const assertPlainObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

// Exported (candidate change): Fix C (true append-only history) reuses this
// symlink/containment guard directly instead of going through atomicWrite's
// temp-file+rename path, which does not apply to an O_APPEND write.
export const assertSecurePath = async (root, candidate) => {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const rootDetails = await lstat(absoluteRoot);
  if (rootDetails.isSymbolicLink()) {
    throw new Error(`Refusing symlink output path: ${absoluteRoot}`);
  }
  if (!isWithin(absoluteRoot, absoluteCandidate)) {
    throw new Error(
      `Output path escapes the target repository: ${absoluteCandidate}`,
    );
  }

  const relative = path.relative(absoluteRoot, absoluteCandidate);
  let current = absoluteRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        throw new Error(`Refusing symlink output path: ${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return absoluteCandidate;
};

export const atomicWrite = async (targetRoot, destination, content) => {
  const absoluteDestination = await assertSecurePath(targetRoot, destination);
  const parent = path.dirname(absoluteDestination);
  await mkdir(parent, { recursive: true });
  await assertSecurePath(targetRoot, absoluteDestination);

  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, absoluteDestination);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
};

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
  if (!isWithin(targetRoot, path.resolve(registryPath))) {
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

const projectRootFor = async (cwd) => {
  const legacy = await legacyInstalledProjectRoot(cwd);
  if (legacy && isWithin(legacy, cwd)) return legacy;
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
  if (!isWithin(targetRoot, registryPath)) {
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

// Fix A (candidate change; see analysis/inventory.md Defect #1 / Part B
// mechanism #7): the original `gitRevision` ran `git -C <root> rev-parse
// HEAD`, which returns the whole repository's HEAD regardless of which
// subdirectory `root` points at. If legacy and target are two subtrees of one
// shared Git repository, any commit anywhere in that repo -- including the
// migration's own target-side implementation commits -- changed what the
// legacy side considered "current" and tripped a false `legacyRevisionChanged`
// blocker on the very next preflight.
//
// The fix scopes the revision to commits that actually touched files under
// `root`: `git -C <root> log -1 --format=%H -- .`. A brand-new directory with
// no commits touching it yet has nothing to scope to, so this falls back to
// `git -C <root> rev-parse HEAD` and reports that fallback explicitly via
// `pathScoped: false`, rather than silently pretending the reading is
// path-scoped when it is not.
export const gitRevision = async (root) => {
  let logResult;
  try {
    logResult = await execFileAsync(
      "git",
      ["-C", root, "log", "-1", "--format=%H", "--", "."],
      { encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(`Cannot read Git revision for '${root}': ${error.message}`);
  }
  const scopedRevision = logResult.stdout.trim();
  if (scopedRevision) {
    return { revision: scopedRevision, pathScoped: true };
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    return { revision: stdout.trim(), pathScoped: false };
  } catch (error) {
    throw new Error(`Cannot read Git revision for '${root}': ${error.message}`);
  }
};

/**
 * Deterministic digest of everything Git reports as dirty under `root`,
 * including the bytes of each dirty file.
 *
 * `gitRevision` only sees committed history, so a preview bound to it
 * authorizes a snapshot that uncommitted edits can change underneath the
 * confirmation. This closes that hole: tracked modifications, staged changes,
 * untracked files, deletions, and renames all participate, and each surviving
 * path contributes its content hash so re-editing an already-dirty file also
 * invalidates the confirmation.
 *
 * ponytail: hashes only the paths Git already flagged, so cost scales with the
 * dirty set, not the tree. Upgrade path: a full-tree manifest if a workflow
 * ever needs to detect changes Git cannot see (e.g. ignored files).
 */
export const dirtyManifest = async (root, { exclude = [] } = {}) => {
  let stdout;
  let repoRoot;
  try {
    // `--porcelain` always prints repository-root-relative paths, so the
    // repository root -- not `root` -- is the base they must be resolved from.
    const top = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    repoRoot = top.stdout.trim();
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-uall", "--", "."],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(`Cannot read Git status for '${root}': ${error.message}`);
  }
  const entries = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    // Rename/copy entries are "XY old -> new"; both sides matter.
    const paths = line
      .slice(3)
      .split(" -> ")
      .map((value) => value.replace(/^"|"$/g, ""));
    for (const relative of paths) {
      const absolute = path.resolve(repoRoot, relative);
      const portable = portablePath(path.relative(root, absolute));
      if (exclude.some((prefix) => portable.startsWith(prefix))) continue;
      let digest = null;
      try {
        digest = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
      }
      entries.push({ status, path: portable, sha256: digest });
    }
  }
  entries.sort((left, right) =>
    left.path === right.path
      ? left.status.localeCompare(right.status)
      : left.path.localeCompare(right.path),
  );
  return {
    entries,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
};

/**
 * Paths under `root` that committed history changed since `revision`, relative
 * to `root`. The axis a dirty-set comparison misses entirely: a file that was
 * clean when the migration started and is clean now can still have been
 * rewritten by a commit in between.
 *
 * Fails loudly rather than reporting "no drift" -- an adoption claim that
 * cannot be checked against its baseline is not a claim that holds.
 */
export const committedChangesSince = async (root, revision) => {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "diff",
        "--name-only",
        "--relative",
        revision,
        "HEAD",
        "--",
        ".",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(
      `Cannot compare '${root}' against baseline revision '${revision}': ${error.message}`,
    );
  }
  return new Set(
    stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  );
};

/**
 * The tip commit of `root`'s repository. `gitRevision` is path-scoped and may
 * report an older commit; a reopen anchor must be the tip, because only the tip
 * is guaranteed to be an ancestor of every later HEAD.
 */
export const headRevision = async (root) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(`Cannot read Git HEAD for '${root}': ${error.message}`);
  }
};

/**
 * Bytes of `relativePath` as of `revision`, or null when the path did not exist
 * there. Distinguishing "absent at that commit" from "git failed" is the whole
 * point: an ownership claim that cannot be read is never silently accepted.
 */
export const fileAtRevision = async (root, revision, relativePath) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "show", `${revision}:${relativePath}`],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
};

/** Whether `ancestor` is reachable from `descendant` in `root`'s history. */
export const isAncestorCommit = async (root, ancestor, descendant) => {
  try {
    await execFileAsync(
      "git",
      ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant],
      { encoding: "utf8" },
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Commits after `revision` that touched `relativePath`, newest first. Recorded
 * as the provenance of post-anchor drift so a reopened slice never absorbs
 * authorship of work committed after the state it was proven against.
 */
export const commitsTouchingSince = async (root, revision, relativePath) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "log",
        "--format=%H",
        `${revision}..HEAD`,
        "--",
        relativePath,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(
      `Cannot list commits touching '${relativePath}' since '${revision}' in '${root}': ${error.message}`,
    );
  }
};

/**
 * Commits that introduced exactly `blobHash` at `relativePath`, oldest first.
 *
 * Legacy reopen compatibility: a record written before reopens carried an
 * explicit anchor has to resolve one from its pinned preserved evidence. The
 * defensible anchor is the commit where those exact bytes *originated*, not
 * merely the newest commit that still carries an unchanged blob -- so this
 * reports every origin and lets the caller fail closed when there is not
 * exactly one.
 */
export const commitsIntroducingBlob = async (root, relativePath, blobHash) => {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "log",
        "--format=%H",
        "--follow",
        "--diff-filter=AM",
        "--",
        relativePath,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(
      `Cannot trace history of '${relativePath}' in '${root}': ${error.message}`,
    );
  }
  const commits = stdout.split("\n").map((v) => v.trim()).filter(Boolean);
  const origins = [];
  for (const commit of commits) {
    const bytes = await fileAtRevision(root, commit, relativePath);
    if (!bytes) continue;
    if (createHash("sha256").update(bytes).digest("hex") !== blobHash) continue;
    // An origin is a commit carrying the bytes whose parent did not.
    const parent = await fileAtRevision(root, `${commit}^`, relativePath);
    const parentHash = parent
      ? createHash("sha256").update(parent).digest("hex")
      : null;
    if (parentHash !== blobHash) origins.push(commit);
  }
  return origins;
};

/**
 * The registry binding may only be persisted into a package.json that belongs
 * to the migration itself. `projectRootFor` walks up from the CWD, so without
 * this an invocation from an unrelated directory writes its binding into a
 * stranger's package.json -- and, because the registry is not below that root,
 * persists a machine-specific absolute path.
 *
 * The root is required, never defaulted. It used to fall back to the engine's
 * own installation, which is the consumer's project root only when the engine
 * happens to live inside the consumer; `resolveRegistryPath` returns the one
 * every caller already passes.
 */
export const assertProjectRootContainment = (projectRoot, registryData) => {
  const { targetRoot } = registryData;
  if (typeof projectRoot !== "string" || !projectRoot) {
    throw new Error(
      "A project root is required to persist the migration registry binding. Resolve one with resolveRegistryPath and pass it explicitly.",
    );
  }
  if (
    !isWithin(targetRoot, projectRoot) &&
    !isWithin(projectRoot, targetRoot)
  ) {
    throw new Error(
      `Refusing to write the migration registry binding into an unrelated project at '${projectRoot}': it neither contains nor lives inside the registry target root '${targetRoot}'. Run the command from that target repository with --registry <path> on first setup, or set config.startMigration.registry in that project's package.json.`,
    );
  }
  return projectRoot;
};

/**
 * Unfinished upgrade transactions for one module. A non-DONE journal must stop
 * every normal command until deterministic recovery completes, so this lives
 * beside the shared helpers rather than inside the upgrade coordinator.
 */
export const pendingTransactions = async (targetRoot, moduleName) => {
  const root = path.join(
    targetRoot,
    ".agents/knowledge/migrations/upgrades",
    moduleName,
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const pending = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const file = path.join(directory, "transaction.json");
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const journal = JSON.parse(content);
    if (journal.state !== "DONE" && journal.state !== "ROLLED_BACK") {
      pending.push({ ...journal, file, directory });
    }
  }
  return pending;
};

export const assertNoPendingTransaction = async (targetRoot, moduleName) => {
  const [pending] = await pendingTransactions(targetRoot, moduleName);
  if (pending) {
    throw new Error(
      `An unfinished upgrade transaction exists for '${moduleName}' in state ${pending.state}. Run '${engineCommand("upgrades/upgrade-migration.mjs", moduleName, "--recover")}' before any other migration work.`,
    );
  }
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

const registryJournalPathFor = (targetRoot) =>
  path.join(targetRoot, ".agents/knowledge/migrations/registry.journal.json");

/**
 * Finishes a registry+config write pair a previous invocation started but
 * never got to clean up (killed mid-write). Both halves are applied only if
 * their current bytes still match the journalled "before" snapshot, so a
 * legitimate later change is never clobbered; either way the journal is then
 * cleared. Runs under the registry lock, before any new update is computed.
 */
const recoverRegistryJournal = async (targetRoot) => {
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

/** @param {{ registryPath?: string, moduleName: string, target: string, aliases?: string[], confirmExecution?: string }} options */
export const updateRegistry = async ({
  registryPath,
  projectRoot,
  moduleName,
  target,
  aliases = [],
  confirmExecution,
}) => {
  const preview = await previewRegistryUpdate({
    registryPath,
    projectRoot,
    moduleName,
    target,
    aliases,
  });
  if (
    typeof confirmExecution !== "string" ||
    confirmExecution !== preview.confirmationId
  ) {
    throw new Error(
      "Registration confirmation is missing or expired. Show the current pre-execution summary and ask the user to confirm again.",
    );
  }
  // The registry is one shared file for every module, so registration takes the
  // target-owned registry lock and recomputes the document from the bytes that
  // are on disk under that lock. Two concurrent registrations of different
  // modules therefore merge; a concurrent registration that contradicts this
  // one fails validation instead of silently overwriting it.
  return withModuleLock(preview.targetRoot, "registry", async () => {
    await recoverRegistryJournal(preview.targetRoot);
    const fresh = await previewRegistryUpdate({
      registryPath,
      projectRoot,
      moduleName,
      target,
      aliases,
    });
    if (
      fresh.existingTarget !== null &&
      fresh.existingTarget !== preview.existingTarget &&
      fresh.existingTarget !== target
    ) {
      throw new Error(
        `Registration is stale: '${moduleName}' now maps to '${fresh.existingTarget}' in the registry. Preview again.`,
      );
    }
    const journalFile = registryJournalPathFor(fresh.targetRoot);
    await writeJournalAtomic(journalFile, {
      registryPath: fresh.registryPath,
      registryBefore: fresh.before,
      registryAfter: fresh.content,
      configPath: fresh.registryBinding.configPath,
      configBefore: fresh.registryBinding.before,
      configAfter: fresh.registryBinding.content,
      projectRoot: fresh.registryBinding.projectRoot,
    });
    try {
      // Registry first: a death before the binding write leaves a registry the
      // next invocation's recovery re-binds idempotently, whereas the reverse
      // order would acknowledge a mapping that is not there.
      if (fresh.changed) {
        await atomicWrite(fresh.targetRoot, fresh.registryPath, fresh.content);
      }
      await persistProjectRegistryBinding(fresh.registryBinding);
    } finally {
      await unlink(journalFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { changed: fresh.changed, moduleName, target };
  });
};

/**
 * The clean-host preflight (`--doctor`). Read-only by construction: it takes no
 * lock, opens no record, and creates no directory. The writability probe uses
 * `access(W_OK)` on a directory that already exists rather than writing a file,
 * so a host that is blocked stays byte-identical after the check.
 *
 * The engine's declared runtime is larger than "Node, Git, ripgrep": the pinned
 * discovery parser and a writable knowledge root are hard requirements, and the
 * Playwright MCP server decides whether any visible-UI slice can ever finish.
 * An operator hitting one of these should read its name here, not in a stack
 * trace three checkpoints later.
 */
const doctorCheck = async (name, requirement, probe) => {
  try {
    const detail = await probe();
    return { name, requirement, status: "OK", detail, blocking: false };
  } catch (error) {
    return {
      name,
      requirement,
      status: "BLOCKED",
      detail: error.message,
      blocking: true,
    };
  }
};

const MINIMUM_NODE_MAJOR = 20;

/** The nearest ancestor of `cwd` that already owns a migration tree. */
const existingKnowledgeRoot = async (cwd) => {
  let current = path.resolve(cwd);
  while (true) {
    try {
      await access(path.join(current, ".agents/knowledge/migrations"));
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

export const runDoctor = async ({
  targetRoot,
  skillRoot = engineSkillRoot,
  cwd = process.cwd(),
} = {}) => {
  // The repository being migrated is the one the operator is standing in, not
  // the one the engine was installed into -- externally installed, those are
  // different directories, and answering from the engine's own tree reports a
  // preflight about a repository nobody asked about.
  //
  // `--doctor` runs before registry resolution on purpose, so the target root
  // is not available: the nearest ancestor that already holds a migration tree
  // is. Failing that, the project root, and failing that the CWD -- a preflight
  // that cannot find a project still has to answer, and the knowledge-root
  // check is then the thing that says so.
  const knowledgeRoot =
    targetRoot ??
    (await existingKnowledgeRoot(cwd)) ??
    (await projectRootFor(cwd).catch(() => cwd));
  const checks = [
    await doctorCheck("node", `Node.js >= ${MINIMUM_NODE_MAJOR}`, () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
        throw new Error(
          `Node ${process.versions.node} is older than the required ${MINIMUM_NODE_MAJOR}.`,
        );
      }
      return `Node ${process.versions.node}`;
    }),
    await doctorCheck(
      "git",
      "git on PATH (the census is `git ls-files`)",
      async () => {
        const { stdout } = await execFileAsync("git", ["--version"], {
          encoding: "utf8",
        });
        return stdout.trim();
      },
    ),
    await doctorCheck(
      "discovery-parser",
      "ts-discovery-compiler resolvable from the skill",
      async () => {
        const { loadTypeScript } = await import("./discovery-scan.mjs");
        return `ts-discovery-compiler ${loadTypeScript().version}`;
      },
    ),
    await doctorCheck(
      "knowledge-root",
      "writable .agents/knowledge/migrations/",
      async () => {
        const root = path.join(knowledgeRoot, ".agents/knowledge/migrations");
        let writable = root;
        while (true) {
          try {
            await access(writable, fsConstants.W_OK);
            return writable === root ? root : `${root} (creatable from ${writable})`;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          const parent = path.dirname(writable);
          if (parent === writable) throw new Error(`${root} has no writable ancestor`);
          writable = parent;
        }
      },
    ),
  ];

  // MCP registration is reported, never invoked: launching a browser server is
  // exactly the side effect a read-only preflight must not have.
  const mcp = await readFile(path.join(skillRoot, "../../mcp.json"), "utf8")
    .then((raw) => JSON.parse(raw).mcpServers ?? {})
    .catch(() => null);
  const servers = ["playwright", "figma", "start-migration"].map((name) => {
    const server = mcp?.[name];
    return {
      name,
      registered: Boolean(server),
      // `cmd /c` is a Windows-only launcher. VERIFY_SLICES requires Playwright
      // runtime evidence for every visible-UI slice and an unreachable runtime
      // is not a waiver, so a non-portable launcher makes those slices
      // unfinishable rather than merely awkward.
      portable: server
        ? server.type === "http" || server.command !== "cmd"
        : null,
      command: server?.command ?? server?.url ?? null,
    };
  });

  const blockers = checks.filter((check) => check.blocking);
  return {
    outcome: blockers.length > 0 ? "BLOCKED" : "OK",
    checks,
    mcpServers: servers,
    blockers: blockers.map((check) => `${check.name}: ${check.detail}`),
  };
};

// ---------------------------------------------------------------------------
// Cross-platform content identity (one shared policy for both engines)
//
// An ordinary file pin conflated "what this text says" with "how this checkout
// spells its line endings". Git may hand the same committed blob to Windows as
// CRLF and to Linux as LF, so a raw-byte pin written on one platform fails
// verification on the other even though nothing was edited.
//
// New pins are tagged, so the intent is on the record instead of inferred:
//
//   sha256:text-lf-v1:<64 lowercase hex>   CRLF pairs folded to LF, then hashed
//   sha256:bytes-v1:<64 lowercase hex>     the exact bytes, hashed
//
// Nothing else about the bytes is touched: BOM, lone CR, trailing whitespace,
// final-newline presence, Unicode form and JSON formatting all still change the
// identity. Content is never parsed and reserialized to compute one.
//
// Raw-byte purposes -- confirmation preimages, decision ledgers and their byte
// anchors, approval candidates, transaction preimages, preserved rework
// evidence -- keep their existing SHA-256 helpers and are never routed here.
// ---------------------------------------------------------------------------

/** Frozen v1 text-eligible extension allowlist. Changing it needs a new tag. */
const TEXT_IDENTITY_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".json", ".yaml", ".yml",
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".xml", ".svg", ".csv", ".log",
]);

export const CONTENT_IDENTITY_TEXT = "text-lf-v1";
export const CONTENT_IDENTITY_BYTES = "bytes-v1";

const IDENTITY_SCHEMES = new Set([
  CONTENT_IDENTITY_TEXT,
  CONTENT_IDENTITY_BYTES,
]);

const TAGGED_IDENTITY = /^sha256:([a-z0-9-]+):([a-f0-9]{64})$/;
const PREFIXED_DIGEST = /^sha256:([a-f0-9]{64})$/;
const BARE_DIGEST = /^[a-f0-9]{64}$/;

const CR = 0x0d;
const LF = 0x0a;
const TAB = 0x09;
const DEL = 0x7f;

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** The bytes with every CRLF pair replaced by LF. A lone CR survives intact. */
const foldCrlf = (bytes) => {
  if (!bytes.includes(CR)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === CR && bytes[index + 1] === LF) continue;
    out[length] = bytes[index];
    length += 1;
  }
  return out.subarray(0, length);
};

/** The literal inverse candidate: every LF becomes CRLF. */
const expandLf = (bytes) => {
  if (!bytes.includes(LF)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length * 2);
  let length = 0;
  for (const byte of bytes) {
    if (byte === LF) {
      out[length] = CR;
      length += 1;
    }
    out[length] = byte;
    length += 1;
  }
  return out.subarray(0, length);
};

/**
 * Valid UTF-8 with no binary control byte (C0 other than TAB/LF/CR, or DEL).
 * `fatal` decoding is the runtime's own validator -- malformed bytes throw
 * rather than decoding to replacement characters -- and `ignoreBOM` keeps a
 * leading BOM in the decoded value so it is never silently treated as absent.
 */
const isTextContent = (bytes) => {
  for (const byte of bytes) {
    if (byte === DEL) return false;
    if (byte < 0x20 && byte !== TAB && byte !== LF && byte !== CR) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return false;
  }
  return true;
};

/**
 * Whether this path plus content is eligible for a text identity.
 * Deterministic and platform-independent: extension allowlist first, then the
 * content itself. No OS, provider, locale, Git setting, or size heuristic
 * participates, so two checkouts of one blob always classify the same way.
 */
export const isTextIdentityEligible = (relativePath, bytes) =>
  TEXT_IDENTITY_EXTENSIONS.has(
    path.extname(String(relativePath)).toLowerCase(),
  ) && isTextContent(bytes);

/**
 * `{ scheme, hex, tagged }` for any supported spelling, or `null`. `scheme` is
 * `null` for the two legacy spellings (bare hex and `sha256:<hex>`), which is
 * exactly the case bounded compatibility matching applies to. An unknown or
 * malformed tag parses to `null`, so it never matches anything.
 */
export const parseContentIdentity = (value) => {
  if (typeof value !== "string") return null;
  if (BARE_DIGEST.test(value)) {
    return { scheme: null, hex: value, tagged: false };
  }
  const prefixed = PREFIXED_DIGEST.exec(value);
  if (prefixed) return { scheme: null, hex: prefixed[1], tagged: false };
  const tagged = TAGGED_IDENTITY.exec(value);
  if (!tagged || !IDENTITY_SCHEMES.has(tagged[1])) return null;
  return { scheme: tagged[1], hex: tagged[2], tagged: true };
};

/**
 * Shape predicate for persisted digest fields. `bare` admits the unprefixed
 * 64-hex spelling `artifactHashes` has always used; the `sha256:`-prefixed and
 * tagged spellings are always admitted.
 */
export const isContentIdentity = (value, { bare = false } = {}) => {
  const parsed = parseContentIdentity(value);
  if (!parsed) return false;
  return bare || parsed.tagged || value.startsWith("sha256:");
};

/**
 * The identity to record for `bytes` at `relativePath`. `bytes: true` declares
 * an explicit byte-sensitive purpose and always wins over text classification.
 */
export const contentIdentity = (
  relativePath,
  bytes,
  { bytes: bytesOnly = false } = {},
) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return !bytesOnly && isTextIdentityEligible(relativePath, buffer)
    ? `sha256:${CONTENT_IDENTITY_TEXT}:${sha256Hex(foldCrlf(buffer))}`
    : `sha256:${CONTENT_IDENTITY_BYTES}:${sha256Hex(buffer)}`;
};

/**
 * Whether `recorded` still identifies `bytes`.
 *
 * A tagged identity means exactly what its tag says and is never retried under
 * the other scheme: a bytes tag is byte equality, and a text tag on ineligible
 * content -- or under a byte-sensitive purpose -- is a contradiction and fails.
 * A legacy untagged digest is compared against the three approved candidates:
 * the current bytes, those bytes with CRLF folded to LF, and that result with
 * LF expanded back to CRLF. Together they cover an unchanged file, a historical
 * LF pin read on a CRLF checkout, and a committed CRLF pin read on a
 * Git-normalized LF checkout, without needing the original blob.
 *
 * Arbitrary historical mixed-EOL placement cannot be reconstructed from a hash
 * after folding, so anything the bounded candidates miss fails closed. Nothing
 * here rewrites, repairs, or re-pins: the recorded digest is the caller's, and
 * it comes back unchanged.
 */
export const contentIdentityMatches = (
  recorded,
  relativePath,
  bytes,
  { bytes: bytesOnly = false } = {},
) => {
  const parsed = parseContentIdentity(recorded);
  if (!parsed) return false;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const textEligible =
    !bytesOnly && isTextIdentityEligible(relativePath, buffer);

  if (parsed.scheme === CONTENT_IDENTITY_BYTES) {
    return parsed.hex === sha256Hex(buffer);
  }
  if (parsed.scheme === CONTENT_IDENTITY_TEXT) {
    return textEligible && parsed.hex === sha256Hex(foldCrlf(buffer));
  }

  // Legacy, untagged. Candidate 1 -- the current bytes -- always applies.
  if (parsed.hex === sha256Hex(buffer)) return true;
  if (!textEligible) return false;
  // Candidates 2 and 3, deduplicated: a candidate identical to one already
  // tried carries no new information.
  const folded = foldCrlf(buffer);
  if (!folded.equals(buffer) && parsed.hex === sha256Hex(folded)) return true;
  const expanded = expandLf(folded);
  return !expanded.equals(buffer) && parsed.hex === sha256Hex(expanded);
};

/** `contentIdentity` for a file on disk, read through the safe-path reader. */
export const fileContentIdentity = async (root, relativePath, options) => {
  const absolute = await assertSecurePath(
    root,
    path.resolve(root, relativePath),
  );
  return contentIdentity(relativePath, await readFile(absolute), options);
};

/** `contentIdentityMatches` for a file on disk, via the same safe reader. */
export const fileContentIdentityMatches = async (
  recorded,
  root,
  relativePath,
  options,
) => {
  const absolute = await assertSecurePath(
    root,
    path.resolve(root, relativePath),
  );
  return contentIdentityMatches(
    recorded,
    relativePath,
    await readFile(absolute),
    options,
  );
};
