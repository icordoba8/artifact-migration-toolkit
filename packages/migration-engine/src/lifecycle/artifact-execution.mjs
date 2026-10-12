/**
 * Lifecycle: the artifact engine's capability-gated execution of target
 * validators. Moved verbatim from `artifact/artifact-migration.mjs` (Track A8).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  asEngineFault,
  CODE_FILE_EXTENSIONS,
  commandFile,
  engineFault,
  metrics,
  pathKey,
  targetTypeScript,
} from "../census/index.mjs";
import { assertSecurePath, execFileAsync, normalizeRelative } from "../shared/index.mjs";
import { fileExists as exists } from "../store/index.mjs";

const JS_FILE_EXTENSIONS = new Set([".js", ".jsx", ".mjs"]);

// P1 #6: running target-controlled code is a capability a caller is granted,
// never an ambient property of being inside a validator. A read-only entry
// point (`--status`, preview, an artifact prerequisite probe) passes
// READ_ONLY_CAPABILITY, and every child process this engine starts goes through
// `execute`, so a validator that reaches for one from a read-only caller faults
// loudly instead of silently spawning the target's package script, the target's
// compiler binary or `node --check`.
export const EXECUTION_CAPABILITY = Object.freeze({ execution: true });

export const READ_ONLY_CAPABILITY = Object.freeze({ execution: false });

const assertMayExecute = (capability, what, cwd) => {
  if (capability?.execution === true) return;
  throw engineFault(
    `Refusing to execute '${what}' in '${cwd}'`,
    "a read-only artifact operation must not run target-controlled code",
  );
};

const execute = async (file, args, cwd, { shell = false, capability } = {}) => {
  assertMayExecute(capability, [file, ...args].join(" "), cwd);
  metrics.validatorRuns += 1;
  try {
    const { stdout = "", stderr = "" } = await execFileAsync(file, args, {
      cwd,
      shell,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    // A numeric exit code is the tool's verdict. A string code (ENOBUFS from an
    // exhausted output buffer, EMFILE, EACCES, ENOENT) or a killing signal is
    // the engine failing to run the check at all, and reporting that as
    // "exit 1" silently downgraded a resource failure to "not covered yet".
    if (typeof error.code === "string" || error.signal) {
      throw engineFault(
        `Cannot execute '${[file, ...args].join(" ")}' in '${cwd}'`,
        error.signal ? `killed by ${error.signal}` : error,
      );
    }
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      output: `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    };
  }
};

const executeTypeScriptValidation = async (validator, changedFiles, targetRoot, capability) => {
  const project = normalizeRelative(validator.project, "TypeScript validator project");
  const projectFile = path.resolve(targetRoot, project);
  await assertSecurePath(targetRoot, projectFile);
  const { compiler, bin, identity } = targetTypeScript(targetRoot);
  // A validator naming a project that does not exist is an authoring error; a
  // compiler that crashes on one that does is an engine fault. Only the latter
  // must stop the loop.
  if (!(await exists(projectFile))) throw new Error(`TypeScript validator project '${project}' does not exist.`);
  const parsed = await asEngineFault(`Cannot load TypeScript validator project '${project}'`, () => {
    const loaded = compiler.readConfigFile(projectFile, compiler.sys.readFile);
    if (loaded.error) throw new Error("the compiler refused to read it");
    const result = compiler.parseJsonConfigFileContent(
      loaded.config,
      compiler.sys,
      path.dirname(projectFile),
      undefined,
      projectFile,
    );
    if (result.errors.length > 0) throw new Error("the compiler refused to parse it");
    return result;
  });
  const projectFiles = new Set(parsed.fileNames.map((file) => pathKey(path.resolve(file))));
  const coveredFiles = changedFiles.filter((file) => projectFiles.has(pathKey(path.resolve(targetRoot, file))));
  const args = [bin, "--project", projectFile, "--noEmit", "--pretty", "false", "--incremental", "false"];
  const result = await execute(process.execPath, args, targetRoot, { capability });
  const errorLines = result.output.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line));
  const changed = new Set(changedFiles.map(pathKey));
  const diagnostics = errorLines.map((line) => {
    const match = line.match(/^(.*?)\(\d+,\d+\): error TS(\d+):/);
    const file = match ? commandFile(targetRoot, match[1]) : null;
    return { file, code: match ? Number(match[2]) : null, affectsChangedFile: file !== null && changed.has(pathKey(file)) };
  });
  return {
    validatorKind: "TYPESCRIPT",
    // Which compiler produced this verdict is part of the verdict. A FINALIZE
    // gate that consumed a pinned-fallback result on a project that uses a
    // different compiler has to be readable as such after the fact.
    compiler: identity,
    command: { file: process.execPath, args },
    exitCode: result.exitCode,
    coveredFiles,
    projectScope: project,
    diagnostics,
    diagnosticsComplete: diagnostics.every((diagnostic) => diagnostic.file !== null),
  };
};

const executeNodeCheckValidation = async (validator, changedFiles, targetRoot, capability) => {
  const file = normalizeRelative(validator.file, "node --check validator file");
  const absolute = path.resolve(targetRoot, file);
  await assertSecurePath(targetRoot, absolute);
  const args = ["--check", file];
  const result = await execute(process.execPath, args, targetRoot, { capability });
  return {
    validatorKind: "NODE_CHECK",
    command: { file: process.execPath, args },
    exitCode: result.exitCode,
    coveredFiles: changedFiles.includes(file) && JS_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()) ? [file] : [],
    projectScope: null,
    diagnostics: result.exitCode === 0 ? [] : [{ file, code: null, affectsChangedFile: changedFiles.includes(file) }],
    diagnosticsComplete: true,
  };
};

const executeValidator = (validator, changedFiles, targetRoot, capability) =>
  validator.kind === "TYPESCRIPT"
    ? executeTypeScriptValidation(validator, changedFiles, targetRoot, capability)
    : executeNodeCheckValidation(validator, changedFiles, targetRoot, capability);

export const hasCodeValidationCheck = async (checks, changedFiles, targetRoot, capability) => {
  const changedCode = changedFiles.filter((file) => CODE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const covered = new Set();
  const evidence = [];
  for (const check of checks.filter((entry) => entry.validator)) {
    const result = await executeValidator(check.validator, changedCode, targetRoot, capability);
    evidence.push(result);
    const isolatedTypeScriptFailure =
      result.validatorKind === "TYPESCRIPT" &&
      result.exitCode !== 0 &&
      result.diagnostics.length > 0 &&
      result.diagnosticsComplete &&
      result.diagnostics.every((diagnostic) => !diagnostic.affectsChangedFile);
    if (result.exitCode !== 0 && !isolatedTypeScriptFailure) continue;
    for (const file of result.coveredFiles) covered.add(file);
  }
  return { passed: changedCode.every((file) => covered.has(file)), evidence };
};

// The target's own manifest. Missing is a plain JS/target-less project, not a
// fault; unreadable or malformed is a fault, because the answer it would have
// given decides whether a required external dependency is really there.
const targetManifest = async (targetRoot) => {
  const file = path.join(targetRoot, "package.json");
  if (!(await exists(file))) return null;
  return asEngineFault(`Cannot read the target manifest '${file}'`, async () =>
    JSON.parse(await readFile(file, "utf8")),
  );
};

const MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Target-side evidence for an `EXTERNAL <spec>` requirement: the artifact does
 * not carry the package, so the target has to declare it. Asserted, not
 * assumed -- a dependency that is absent (or that disappears before FINALIZE)
 * holds the checkpoint instead of vanishing between the scanner and the gate.
 */
export const assertTargetProvides = async (targetRoot, packageName, label) => {
  const manifest = await targetManifest(targetRoot);
  if (manifest === null) {
    throw new Error(
      `${label} claims the target provides '${packageName}', but the target root has no package.json to prove it.`,
    );
  }
  const declared = MANIFEST_DEPENDENCY_FIELDS.some((field) => {
    const map = manifest[field];
    return map && typeof map === "object" && Object.hasOwn(map, packageName);
  });
  if (!declared) {
    throw new Error(
      `${label} claims the target provides '${packageName}', but the target package.json declares no such dependency.`,
    );
  }
};

// A generic check is a prose claim by default. When it names one of the target's
// own package scripts it is an executable build/test command, so it is executed
// rather than trusted: an unexecuted "PASS" proved nothing.
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

const SCRIPT_NAME = /^[A-Za-z0-9_.:-]+$/;

const packageScriptOf = async (command, targetRoot) => {
  const [manager, ...rest] = command.trim().split(/\s+/);
  if (!PACKAGE_MANAGERS.has(manager)) return null;
  const args = rest[0] === "run" ? rest.slice(1) : rest;
  if (args.length !== 1 || !SCRIPT_NAME.test(args[0])) return null;
  const manifest = await targetManifest(targetRoot);
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object" || !Object.hasOwn(scripts, args[0])) return null;
  return { manager, script: args[0] };
};

export const executeGenericCheck = async (command, targetRoot, label, capability) => {
  const invocation = await packageScriptOf(command, targetRoot);
  if (!invocation) return null;
  // A shell is unavoidable -- win32 package managers are `.cmd` shims and a
  // script body is a shell line either way. The manager is allowlisted and the
  // script name is pattern-checked against the target's own manifest, so
  // nothing author-controlled reaches that shell.
  const result = await execute(
    `${invocation.manager} run ${invocation.script}`,
    [],
    targetRoot,
    { shell: true, capability },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} declares PASS but '${invocation.manager} run ${invocation.script}' exited ${result.exitCode} in the target root.`,
    );
  }
  return { command, ...invocation, exitCode: result.exitCode };
};
