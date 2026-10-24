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
import { assertSecurePath, canonicalJson, execFileAsync, normalizeRelative, sha256Hex } from "../shared/index.mjs";
import { fileExists as exists, fileHash, secureHash } from "../store/index.mjs";

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
    inputSha256: await fileHash(projectFile),
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
    compiler: { specifier: "node", version: process.version, origin: "ENGINE_RUNTIME" },
    inputSha256: (await exists(absolute)) ? await fileHash(absolute) : null,
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
  return {
    command,
    ...invocation,
    exitCode: result.exitCode,
    // What actually ran: the manifest's script body at execution time, as a
    // digest -- never the body, which is the target's to keep.
    inputSha256: await fileHash(path.join(targetRoot, "package.json")),
  };
};

// ---------------------------------------------------------------------------
// M13 persistent validator evidence. A receipt is what one declared check
// actually amounted to, recorded from the engine's own execution result. It
// never carries stdout, an environment, an absolute path or an author's free
// text (a declared command is kept only as its digest), and it is
// deterministic -- no clock, no duration -- so crash recovery re-executes the
// checks and reproves the exact receipt rather than trusting a stored one.
// ---------------------------------------------------------------------------
export const VALIDATION_EVIDENCE_VERSION = 1;
export const RECEIPT_EXECUTIONS = Object.freeze(["EXECUTED", "NOT_REQUIRED", "UNSUPPORTED", "DEFERRED"]);
const DIAGNOSTIC_LIMIT = 20;

const bounded = (values) => {
  const all = [...new Set(values.filter((value) => value !== null))].sort();
  return { values: all.slice(0, DIAGNOSTIC_LIMIT), truncated: all.length > DIAGNOSTIC_LIMIT };
};

const validatorIdentity = (identity) => identity
  ? { name: identity.specifier ?? null, version: identity.version ?? null, origin: identity.origin ?? null }
  : null;

export const validatorReceipt = (index, check, result) => {
  const receipt = {
    check: index,
    kind: check.validator.kind,
    declared: check.validator,
    authority: "ENGINE",
  };
  if (!result) return { ...receipt, execution: "NOT_REQUIRED", exitCode: null };
  const files = bounded(result.diagnostics.map((diagnostic) => diagnostic.file));
  const codes = bounded(result.diagnostics.map((diagnostic) => diagnostic.code));
  return {
    ...receipt,
    execution: "EXECUTED",
    exitCode: result.exitCode,
    coveredFiles: [...result.coveredFiles].sort(),
    validator: validatorIdentity(result.compiler),
    inputSha256: result.inputSha256,
    diagnostics: {
      count: result.diagnostics.length,
      codes: codes.values,
      files: files.values,
      truncated: codes.truncated || files.truncated,
      affectsChangedFile: result.diagnostics.some((diagnostic) => diagnostic.affectsChangedFile),
    },
  };
};

export const commandReceipt = (index, check, run) => {
  const receipt = { check: index, declared: { commandSha256: sha256Hex(check.command) } };
  if (run === undefined) return { ...receipt, kind: "COMMAND", authority: "AGENT_DECLARATION", execution: "DEFERRED", exitCode: null };
  // Not one of the target's own package scripts: the engine has no safe way to
  // run it, so its PASS stays exactly what it is -- the agent's word.
  if (run === null) return { ...receipt, kind: "COMMAND", authority: "AGENT_DECLARATION", execution: "UNSUPPORTED", exitCode: null };
  return {
    ...receipt,
    kind: "PACKAGE_SCRIPT",
    declared: { ...receipt.declared, manager: run.manager, script: run.script },
    authority: "ENGINE",
    execution: "EXECUTED",
    exitCode: run.exitCode,
    coveredFiles: [],
    validator: { name: run.manager, version: null, origin: "TARGET_MANIFEST" },
    inputSha256: run.inputSha256,
  };
};

const EVIDENCE_STEPS = new Set(["IMPLEMENT_SLICES", "VERIFY_SLICES"]);

const evidenceDigest = (body) => sha256Hex(canonicalJson(body));

/**
 * The durable validation-evidence envelope an ADVANCED event out of
 * IMPLEMENT_SLICES or VERIFY_SLICES carries. It lives inside the hash-chained
 * history body, and is additionally bound to the exact migration state it was
 * produced under (record, slice, checkpoint, revision, source/target binding
 * digests, the slice document and every changed file's bytes), so it cannot
 * be replayed against changed target files or another record. Returns null for
 * any other transition, and for a validation that did not execute: evidence is
 * only ever what an execution actually produced.
 */
export const validationEvidenceFor = async (root, previousState, validation, fresh) => {
  if (!EVIDENCE_STEPS.has(previousState.currentStep) || validation?.executed !== true) return null;
  const implementation = validation.result.implementation ?? validation.result;
  const body = {
    version: VALIDATION_EVIDENCE_VERSION,
    artifactId: previousState.artifactId,
    slice: previousState.activeSlice,
    checkpoint: previousState.currentStep,
    fromRevision: previousState.revision,
    sourceDigest: fresh.source.digest,
    targetDigest: fresh.target.digest,
    sliceDocument: { path: implementation.relative, sha256: await fileHash(path.join(root, implementation.relative)) },
    changedFiles: implementation.document.changedFiles
      .map((file) => ({ path: normalizeRelative(file.path, "changed file"), sha256: file.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    receipts: implementation.checkReceipts,
  };
  return { ...body, digest: evidenceDigest(body) };
};

/**
 * FINALIZE's read of the persisted evidence. Pure reading: it never executes a
 * validator (status and preview share it). Compatibility is explicit: slice
 * transitions committed before the first one that carries an envelope predate
 * M13 and are reported as legacy (LEGACY_UNRECORDED when none carries one,
 * PARTIAL_LEGACY for a record upgraded mid-slices); from that first envelope on,
 * every slice transition must carry one, so evidence can be neither stripped
 * from a later slice nor invented for another.
 */
export const verifyValidationEvidence = async (state, events, completedSlices = state.completedSlices) => {
  const transitions = events.filter((event) => event.event === "ADVANCED" && EVIDENCE_STEPS.has(event.from));
  const first = transitions.findIndex((event) => Object.hasOwn(event, "validationEvidence"));
  if (first === -1) return { status: "LEGACY_UNRECORDED", slices: [] };
  const carrying = transitions.slice(first);
  const gaps = carrying.filter((event) => !Object.hasOwn(event, "validationEvidence")).length;
  if (gaps > 0) {
    throw new Error(`Validator evidence is missing from ${gaps} slice transition(s) of a record that persists it.`);
  }
  const legacySlices = new Set(transitions.slice(0, first).map((event) => event.slice));
  const latest = new Map();
  for (const event of carrying) {
    const { digest, ...body } = event.validationEvidence;
    const label = `history seq ${event.seq} validationEvidence`;
    if (body.version !== VALIDATION_EVIDENCE_VERSION) throw new Error(`${label} has unsupported version ${body.version}.`);
    if (digest !== evidenceDigest(body)) throw new Error(`${label} digest does not match its content.`);
    if (body.artifactId !== state.artifactId || body.slice !== event.slice ||
        body.checkpoint !== event.from || body.fromRevision !== event.revision - 1) {
      throw new Error(`${label} is bound to a different migration state.`);
    }
    for (const receipt of body.receipts) {
      if (!RECEIPT_EXECUTIONS.includes(receipt.execution) || receipt.execution === "DEFERRED") {
        throw new Error(`${label} check ${receipt.check} was never executed (${receipt.execution}).`);
      }
      if (receipt.execution === "EXECUTED" && receipt.authority !== "ENGINE") {
        throw new Error(`${label} check ${receipt.check} claims execution without engine authority.`);
      }
    }
    latest.set(body.slice, body);
  }
  const missing = completedSlices.filter((slice) =>
    latest.get(slice)?.checkpoint !== "VERIFY_SLICES" && !(legacySlices.has(slice) && !latest.has(slice)));
  if (missing.length > 0) throw new Error(`Validator evidence does not cover verified slice(s): ${missing.join(", ")}.`);
  // Each changed file is judged by the newest evidence that covered it: a later
  // slice may legitimately rewrite an earlier slice's file, but nothing may
  // rewrite it after its last validation.
  const owner = new Map();
  for (const body of latest.values()) for (const file of body.changedFiles) owner.set(file.path, file.sha256);
  for (const [file, expected] of owner) {
    const actual = await secureHash(state.target.root, file, "validated target file").catch(() => null);
    if (actual !== expected) throw new Error(`Target file '${file}' changed after its validator evidence was recorded.`);
  }
  return {
    status: legacySlices.size > 0 ? "PARTIAL_LEGACY" : "RECORDED",
    slices: [...latest.values()].map((body) => ({
      slice: body.slice,
      digest: evidenceDigest(body),
      executed: body.receipts.filter((receipt) => receipt.execution === "EXECUTED").length,
      unsupported: body.receipts.filter((receipt) => receipt.execution === "UNSUPPORTED").length,
      notRequired: body.receipts.filter((receipt) => receipt.execution === "NOT_REQUIRED").length,
    })),
  };
};
