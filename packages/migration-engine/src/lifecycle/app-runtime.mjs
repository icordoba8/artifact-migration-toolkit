/**
 * Lifecycle: the applications a migration observes (LEGACY, BACKEND, TARGET).
 * `check` classifies them and writes nothing; `ensure` also starts a stopped one
 * through its authorized package script; `stop` ends only what `ensure` started.
 *
 * Authority is one local file the operator owns, never the record, a response
 * or a tool argument: it may only name a package script of the project it
 * describes, and a copy tracked by Git is refused, so a clone cannot grant a
 * startup. Probes send no credential, and nothing a response or a process said
 * is returned: no body, cookie, query string or command line.
 *
 * Identity takes two proofs because either alone was wrong on a real consumer: a
 * same-named production copy passes the HTTP marker, and only the process
 * holding the port tells them apart. Every address the origin resolves to must
 * pass, because a browser falls back to the other one silently.
 *
 * The migration record is never touched, so resuming after a runtime problem is
 * an ordinary status-first resume.
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { initialArtifacts } from "../formats/index.mjs";
import { assertPlainObject, assertSecurePath, execFileAsync, isPlainObject, PACKAGE_MANAGERS, SCRIPT_NAME } from "../shared/index.mjs";
import {
  atomicWrite,
  migrationRoot,
  readJson,
  readOptionalJson,
  removeDurably,
  statePathFor,
} from "../store/index.mjs";
import { AUTH_PATH } from "../visual/index.mjs";
import { readContext } from "./context.mjs";
import { withModuleLock } from "./lock.mjs";

export const APP_RUNTIME_CONFIG = ".artifact-migration-tools/runtime-apps.json";
const OWNED_DIRECTORY = ".artifact-migration-tools/app-runtime";
export const APP_RUNTIME_ACTIONS = Object.freeze(["check", "ensure", "stop"]);

// BACKEND first: the two front ends call it while they render.
const ROLES = ["BACKEND", "LEGACY", "TARGET"];
const REQUIRED_ROLES = ["LEGACY", "TARGET"];
const APPLICATION_KEYS = new Set(["origin", "project", "identity", "protectedRoute", "start", "startTimeoutMs"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// A module name cannot contain `_`, so this lock can never be a module's.
const LOCK_NAME = "_app-runtime";
const DEFAULT_START_TIMEOUT_MS = 60_000;
const MAX_START_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 10_000;
const BODY_LIMIT = 262_144;
const POLL_MS = 500;
const KILL_GRACE_MS = 3_000;
const PASSWORD_INPUT = /<input\b[^>]*type=["']?password/i;
// Worst first: the aggregate is the first of these any application is in.
const STATE_RANK = ["WRONG_APP", "IDENTITY_UNPROVEN", "RUNTIME_DOWN", "AUTH_REQUIRED", "READY"];

/** What a started application inherits: enough to run a package script, and no ambient secret. */
const CHILD_ENVIRONMENT = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "SystemRoot",
  "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME",
  "SHELL", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PNPM_HOME", "COREPACK_HOME", "NVM_DIR",
  "NVM_HOME", "NVM_SYMLINK", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
];

export const childEnvironment = (environment = process.env) =>
  Object.fromEntries(CHILD_ENVIRONMENT.filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const powershell = async (script) =>
  (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000 })).stdout;

/** `netstat -ano`. Its state word is localized, so a listener is the row whose remote port is 0. */
export const parseNetstatListeners = (output, port) => output.split("\n").flatMap((line) => {
  const row = /^\s*TCP\s+\[?([^\]\s]+?)\]?:(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$/.exec(line);
  return row && Number(row[2]) === port ? [{ address: row[1], pid: Number(row[3]) }] : [];
});

/** Only cmdlets and pipelines: managed Windows hosts run PowerShell in ConstrainedLanguage mode. */
const windowsListeners = async (port) => {
  const { stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true, timeout: 30_000 });
  const listeners = parseNetstatListeners(stdout, port);
  if (listeners.length === 0) return [];
  const filter = [...new Set(listeners.map(({ pid }) => `ProcessId=${pid}`))].join(" OR ");
  const details = await powershell(`Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`);
  const commands = new Map([JSON.parse(details || "[]")].flat().map(({ ProcessId, CommandLine }) => [ProcessId, CommandLine]));
  return listeners.map((listener) => ({ ...listener, command: commands.get(listener.pid) ?? null, cwd: null }));
};

/** `lsof -Fpnt`, normalized to Windows' spelling: `*` is the family's wildcard. */
export const parseLsofListeners = (output) => {
  const listeners = [];
  let pid;
  let family;
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") pid = Number(value);
    if (line[0] === "t") family = value;
    if (line[0] === "n") {
      const host = value.slice(0, value.lastIndexOf(":")).replace(/^\[|\]$/g, "");
      listeners.push({ address: host === "*" ? (family === "IPv6" ? "::" : "0.0.0.0") : host, pid });
    }
  }
  return listeners;
};

const lsof = (args) => execFileAsync("lsof", args).then(({ stdout }) => stdout, (error) => {
  if (error.code === 1) return ""; // lsof's "nothing matched"
  throw error;
});

const posixListeners = async (port) => {
  const found = parseLsofListeners(await lsof(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpnt"]));
  return Promise.all(found.map(async (listener) => {
    const cwd = (await lsof(["-a", "-p", String(listener.pid), "-d", "cwd", "-Fn"])).split("\n").find((line) => line[0] === "n")?.slice(1) ?? null;
    const command = await execFileAsync("ps", ["-o", "command=", "-p", String(listener.pid)]).then(({ stdout }) => stdout.trim(), () => null);
    return { ...listener, command, cwd };
  }));
};

const processStart = async (pid) => {
  const output = process.platform === "win32"
    ? await powershell(`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CreationDate | ConvertTo-Json -Compress`)
    : await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]).then(({ stdout }) => stdout, () => "");
  return output.trim() || null;
};

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const killTree = async (pid) => {
  if (process.platform === "win32") {
    // Refusing here keeps the ownership record of a process that survived.
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(async (error) => {
      if (await processStart(pid)) throw error;
    });
    return;
  }
  const signal = (name) => { try { process.kill(-pid, name); } catch { /* the group is gone */ } };
  signal("SIGTERM");
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
  signal("SIGKILL");
};

/** The account this engine runs as, in the spelling Windows ACLs use (`DOMAIN\\user`). */
const windowsAccount = async () => (await execFileAsync("whoami", [], { windowsHide: true })).stdout.trim().toLowerCase();

/**
 * Start authority is a file this account neither owns nor can write. The agent
 * runs as this account, so a file it can write is a file it could have written:
 * it would grant itself execution outside its own sandbox. An owner can always
 * make its file writable again, so ownership counts too. The verdict is about
 * the open handle the configuration was read from, so a swap cannot borrow it.
 * shortcut: root, sudo or an administrator token defeats this, as it defeats any same-host boundary (docs/session-broker.md).
 */
const configAuthority = async (file, handle) => {
  let mine;
  let writable;
  if (process.platform === "win32") {
    // ConstrainedLanguage: a cmdlet and Select-Object only. A path is quoted the PowerShell way.
    const { Owner } = JSON.parse(await powershell(`Get-Acl -LiteralPath '${file.replaceAll("'", "''")}' | Select-Object Owner | ConvertTo-Json -Compress`));
    mine = String(Owner).toLowerCase() === await windowsAccount();
    writable = await open(file, "r+").then(async (other) => { await other.close(); return true; }, (error) => {
      if (error.code === "EACCES" || error.code === "EPERM") return false;
      throw error;
    });
    // shortcut: Windows reads an ACL by path only; a file swapped away and back between these reads goes unseen. Move the authority out of the agent's tree if that matters.
    if ((await handle.stat({ bigint: true })).ino !== (await stat(file, { bigint: true })).ino) return `${APP_RUNTIME_CONFIG} changed while it was checked.`;
  } else {
    const { uid, mode } = await handle.stat();
    mine = uid === process.getuid();
    // Without reading ACLs, any group or other write bit counts as writable here.
    writable = (mode & 0o022) !== 0;
  }
  if (!writable && !mine) return null;
  return `${APP_RUNTIME_CONFIG} is ${mine ? "owned" : "writable"} by the account this engine runs as, which is the agent's: a file the agent can write cannot authorize starting a process. The operator makes it owned by another account and read-only here, or starts the application.`;
};

const hostNamespace = () =>
  process.platform === "linux" && /microsoft/i.test(os.release()) ? "wsl" : process.platform;

const hostSystem = {
  namespace: hostNamespace(),
  // shortcut: an uninspectable host answers null and nothing it serves can be proven; add a reader per platform when one matters.
  listeners: (port) => (process.platform === "win32" ? windowsListeners(port) : posixListeners(port)).catch(() => null),
  processStart,
  killTree,
  configAuthority,
};

/**
 * Whether a listener runs this project: true, false, or null when the host
 * would not say. Windows reports no working directory, so its proof is the
 * command line naming a path under the project; the trailing separator keeps
 * `app` from matching `app-v2`.
 * shortcut: a server launched by a relative path reads as foreign on Windows, and a container's proxy always does; add an explicit container identity when a consumer needs one.
 */
export const runsProject = ({ command, cwd }, project, platform = process.platform) => {
  if (platform === "win32") {
    if (!command) return null;
    return command.toLowerCase().replaceAll("/", "\\").includes(`${project.toLowerCase().replaceAll("/", "\\")}\\`);
  }
  if (!command && !cwd) return null;
  return cwd === project || cwd?.startsWith(`${project}/`) === true || command?.includes(`${project}/`) === true;
};

/** A dual-stack `::` serves IPv4 too, unless an IPv4 listener took that address first. */
export const holdersOf = (listeners, { address, family }) => {
  const wildcard = family === 4 ? "0.0.0.0" : "::";
  const exact = listeners.filter((listener) => listener.address === address || listener.address === wildcard);
  return exact.length > 0 || family !== 4 ? exact : listeners.filter((listener) => listener.address === "::");
};

const request = (url, address, route) => new Promise((resolve) => {
  const chunks = [];
  let size = 0;
  const finish = (response) => resolve({ answered: true, status: response.statusCode, location: response.headers.location, body: Buffer.concat(chunks).toString("utf8") });
  const outgoing = http.get(
    { host: address, port: url.port, path: route, agent: false, timeout: PROBE_TIMEOUT_MS, headers: { host: url.host, accept: "text/html,application/json" } },
    (response) => {
      response.on("data", (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= BODY_LIMIT) { finish(response); response.destroy(); }
      });
      response.on("end", () => finish(response));
      response.on("error", () => finish(response));
    },
  );
  outgoing.on("timeout", () => outgoing.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
  outgoing.on("error", (error) => resolve({ answered: false, code: error.code ?? "ERROR" }));
});

const protectedRouteState = (url, app, answer) => {
  if (!answer.answered) return { state: "RUNTIME_DOWN", reason: `protected route '${app.protectedRoute}' did not answer (${answer.code}).` };
  const { status } = answer;
  if (status === 401 || status === 403) return { state: "AUTH_REQUIRED", reason: `protected route '${app.protectedRoute}' answered HTTP ${status}.` };
  if (status >= 300 && status < 400 && answer.location) {
    // The header is the application's own text; an unparsable one is no sign-in.
    const landed = URL.canParse(answer.location, url.origin) ? new URL(answer.location, url.origin) : null;
    if (landed && (landed.origin !== url.origin || AUTH_PATH.test(landed.pathname))) {
      return { state: "AUTH_REQUIRED", reason: `protected route '${app.protectedRoute}' redirected to sign-in${landed.origin === url.origin ? ` at '${landed.pathname}'` : " on another origin"}.` };
    }
  }
  if (status >= 500) return { state: "RUNTIME_DOWN", reason: `protected route '${app.protectedRoute}' answered HTTP ${status}.` };
  if (PASSWORD_INPUT.test(answer.body)) return { state: "AUTH_REQUIRED", reason: `protected route '${app.protectedRoute}' rendered a sign-in form.` };
  // Identity is already proven: a route not built yet leaves the application up, so the status is reported, not treated as a failed start.
  return { state: "READY", reason: `protected route '${app.protectedRoute}' answered HTTP ${status} without a session.` };
};

const inspect = async (app, system) => {
  const url = new URL(app.origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true, verbatim: true });
  const answers = await Promise.all(addresses.map(async (entry) => ({ ...entry, ...(await request(url, entry.address, app.identity.route)) })));
  const answering = answers.filter((answer) => answer.answered);
  const listeners = await system.listeners(Number(url.port));
  // Occupied means never start here, whatever else is wrong with what answers.
  const occupied = answering.length > 0 || addresses.some((entry) => holdersOf(listeners ?? [], entry).length > 0);
  const evidence = { occupied, answers: answering.map(({ address, status }) => ({ address, status })), listeners: (listeners ?? []).map(({ address, pid }) => ({ address, pid })) };
  const row = (state, reason) => ({ state, reason, ...evidence });

  if (answering.length === 0) {
    return row("RUNTIME_DOWN", occupied ? `a process holds ${url.host} but does not answer HTTP.` : `nothing listens at ${url.host} (${[...new Set(answers.map((answer) => answer.code))].join(", ")}).`);
  }
  for (const answer of answering) {
    if (answer.status >= 500) return row("RUNTIME_DOWN", `${answer.address} answered HTTP ${answer.status} on '${app.identity.route}'.`);
    if (answer.status < 200 || answer.status >= 300) return row("WRONG_APP", `${answer.address} answered HTTP ${answer.status} on the identity route '${app.identity.route}'.`);
    if (!answer.body.includes(app.identity.includes)) return row("WRONG_APP", `${answer.address} serves '${app.identity.route}' without the configured identity marker.`);
  }
  for (const answer of answering) {
    const verdicts = holdersOf(listeners ?? [], answer).map((listener) => runsProject(listener, app.project));
    if (verdicts.includes(false)) return row("WRONG_APP", `${answer.address} is held by a process outside '${app.project}'.`);
    if (verdicts.length === 0 || verdicts.includes(null)) return row("IDENTITY_UNPROVEN", `no inspectable process in this namespace holds ${answer.address}; a forwarded port, or a process of another user, proves nothing.`);
  }
  if (!app.protectedRoute) return row("READY", `identity proven for every address of ${url.host}.`);
  const { state, reason } = protectedRouteState(url, app, await request(url, answering[0].address, app.protectedRoute));
  return row(state, reason);
};

const route = (value, label) => {
  if (typeof value !== "string" || !/^\/(?!\/)[^?#\s]*$/.test(value)) throw new Error(`${label} must be an absolute path with no query.`);
  return value;
};

const parseApplication = async (role, value, targetRoot) => {
  assertPlainObject(value, `applications.${role}`);
  const label = `applications.${role}`;
  const unknown = Object.keys(value).filter((key) => !APPLICATION_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${label} carries unsupported ${unknown.join(", ")}; a start command is a package script name, never a command line.`);
  let url;
  try { url = new URL(value.origin); } catch { throw new Error(`${label}.origin is not a URL.`); }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || !url.port || url.origin !== value.origin) {
    throw new Error(`${label}.origin must be exactly http://<localhost|127.0.0.1|[::1]>:<port>; another address is another network namespace.`);
  }
  if (typeof value.project !== "string" || !value.project) throw new Error(`${label}.project must be a directory relative to the target root.`);
  const project = await realpath(path.resolve(targetRoot, value.project)).catch(() => { throw new Error(`${label}.project '${value.project}' does not exist.`); });
  if (!isPlainObject(value.identity) || typeof value.identity.includes !== "string" || !value.identity.includes) {
    throw new Error(`${label}.identity must be {route, includes}: a public route and text only this application serves.`);
  }
  route(value.identity.route, `${label}.identity.route`);
  if (value.protectedRoute !== undefined) route(value.protectedRoute, `${label}.protectedRoute`);
  if (value.start !== undefined) {
    const { manager, script, ...extra } = isPlainObject(value.start) ? value.start : { manager: null };
    if (!PACKAGE_MANAGERS.has(manager) || typeof script !== "string" || !SCRIPT_NAME.test(script) || Object.keys(extra).length > 0) {
      throw new Error(`${label}.start must be exactly {manager: npm|pnpm|yarn, script: <package script name>}.`);
    }
  }
  const startTimeoutMs = value.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  if (!Number.isInteger(startTimeoutMs) || startTimeoutMs < 1 || startTimeoutMs > MAX_START_TIMEOUT_MS) {
    throw new Error(`${label}.startTimeoutMs must be 1..${MAX_START_TIMEOUT_MS}.`);
  }
  return { ...value, role, project, startTimeoutMs };
};

/** The trust boundary. Anything short of a local, well-formed file is a refusal with a reason, never a default. */
const readConfiguration = async (targetRoot, system = hostSystem) => {
  const file = path.join(targetRoot, APP_RUNTIME_CONFIG);
  let handle;
  try {
    await assertSecurePath(targetRoot, file);
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`${APP_RUNTIME_CONFIG} does not exist; the operator creates it. Its port numbers come from the project, never from a migration record.`);
      throw error;
    });
    let document;
    try { document = JSON.parse(await handle.readFile("utf8")); } catch { throw new Error(`${APP_RUNTIME_CONFIG} is not valid JSON.`); }
    const tracked = await execFileAsync("git", ["-C", targetRoot, "ls-files", "--error-unmatch", "--", APP_RUNTIME_CONFIG]).then(() => true, () => false);
    if (tracked) throw new Error(`${APP_RUNTIME_CONFIG} is tracked by Git; authority to start processes must stay local, so a clone cannot grant it.`);
    assertPlainObject(document, "Application runtime configuration");
    if (document.version !== 1 || typeof document.namespace !== "string" || !isPlainObject(document.applications)) {
      throw new Error("The configuration must be {version: 1, namespace: win32|wsl|linux|darwin, applications}.");
    }
    const unknown = Object.keys(document.applications).filter((role) => !ROLES.includes(role));
    const missing = REQUIRED_ROLES.filter((role) => !document.applications[role]);
    if (unknown.length > 0 || missing.length > 0) {
      throw new Error(`applications needs LEGACY and TARGET and may add BACKEND${unknown.length ? `; unknown ${unknown.join(", ")}` : ""}${missing.length ? `; missing ${missing.join(", ")}` : ""}.`);
    }
    const applications = [];
    for (const role of ROLES.filter((name) => document.applications[name])) {
      applications.push(await parseApplication(role, document.applications[role], targetRoot));
    }
    const refusal = applications.some((app) => app.start) ? await system.configAuthority(file, handle) : null;
    return {
      namespace: document.namespace,
      applications: refusal ? applications.map(({ start, ...app }) => ({ ...app, startRefusal: refusal })) : applications,
    };
  } catch (error) {
    return { problem: error.message };
  } finally {
    await handle?.close();
  }
};

/** A finished migration, and one whose closed discovery found no visible UI, have nothing to observe. The template seeds `hasVisibleUi: false`, so before that it means nothing. */
const requirement = async (targetRoot, moduleName) => {
  const state = await readOptionalJson(statePathFor(targetRoot, moduleName), "Migration state");
  if (state?.status === "COMPLETE") return "The record is COMPLETE.";
  if (!state?.completedSteps?.includes("DISCOVER_LEGACY")) return null;
  const inventory = await readOptionalJson(path.join(migrationRoot(targetRoot, moduleName), initialArtifacts.legacyInventory), "Legacy inventory");
  return inventory?.hasVisibleUi === false ? "The module declares no visible UI; no browser or application evidence applies." : null;
};

const ownedFile = (targetRoot, role) => path.join(targetRoot, OWNED_DIRECTORY, `${role}.json`);

/** A record names a live process only while its PID still has the same start time; anything else is stale. */
const liveOwned = async (targetRoot, role, system) => {
  const file = ownedFile(targetRoot, role);
  const owned = await readOptionalJson(file, "Owned application record");
  if (!owned) return null;
  // Another namespace's PID means nothing here, so that record is not ours to judge.
  if (owned.namespace !== system.namespace) return null;
  const started = await system.processStart(owned.pid);
  if (started !== null && started === owned.processStart) return owned;
  await removeDurably(targetRoot, file);
  return null;
};

const release = async (targetRoot, owned, system) => {
  await system.killTree(owned.pid);
  await removeDurably(targetRoot, ownedFile(targetRoot, owned.role));
};

const untilSettled = async (app, system, exited) => {
  const deadline = Date.now() + app.startTimeoutMs;
  for (;;) {
    const row = await inspect(app, system);
    if (row.state === "READY" || row.state === "AUTH_REQUIRED" || row.state === "WRONG_APP" || row.state === "IDENTITY_UNPROVEN") return row;
    const stopped = await Promise.race([exited, sleep(POLL_MS).then(() => null)]);
    if (stopped) return { ...row, reason: `the start script exited (${stopped.code ?? stopped.signal ?? stopped.error}) before the application was ready.`, failure: "STARTUP_FAILED" };
    if (Date.now() >= deadline) return { ...row, reason: `the application was not ready within ${app.startTimeoutMs} ms.`, failure: "STARTUP_TIMEOUT" };
  }
};

const startApplication = async (targetRoot, app, system) => {
  const manifest = await readJson(path.join(app.project, "package.json"), "Project manifest").catch(() => null);
  if (!Object.hasOwn(manifest?.scripts ?? {}, app.start.script)) {
    return { state: "CONFIGURATION_MISSING", reason: `'${app.project}' has no package script '${app.start.script}'.` };
  }
  const directory = path.join(targetRoot, OWNED_DIRECTORY);
  await atomicWrite(targetRoot, path.join(directory, ".gitignore"), "*\n");
  const logFile = path.join(directory, `${app.role}.log`);
  const log = await open(await assertSecurePath(targetRoot, logFile), "a", 0o600);
  // A shell is unavoidable on win32, where package managers are `.cmd` shims.
  // Both words were checked against an allowlist and the project's own manifest.
  const child = spawn(`${app.start.manager} run ${app.start.script}`, [], {
    cwd: app.project, env: childEnvironment(), shell: true, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error: error.code ?? error.message }));
  });
  await log.close();
  child.unref();
  const logPath = path.relative(targetRoot, logFile).replaceAll("\\", "/");
  if (!child.pid) return { state: "RUNTIME_DOWN", reason: `'${app.start.manager}' could not be started (${(await exited).error}).`, failure: "STARTUP_FAILED", log: logPath };
  const owned = { version: 1, role: app.role, pid: child.pid, namespace: system.namespace, processStart: await system.processStart(child.pid), origin: app.origin };
  await atomicWrite(targetRoot, ownedFile(targetRoot, app.role), `${JSON.stringify(owned, null, 2)}\n`);
  const row = await untilSettled(app, system, exited);
  if (row.state !== "READY" && row.state !== "AUTH_REQUIRED") {
    await release(targetRoot, owned, system);
    return { ...row, log: logPath };
  }
  return { ...row, started: true, log: logPath };
};

const ensureApplication = async (targetRoot, app, system) => {
  const row = await inspect(app, system);
  if (row.state !== "RUNTIME_DOWN") return { ...row, reused: row.state === "READY" || row.state === "AUTH_REQUIRED" };
  // Started earlier and still coming up: wait for it, never start a second one.
  const owned = await liveOwned(targetRoot, app.role, system);
  if (owned) {
    const settled = await untilSettled(app, system, new Promise(() => {}));
    if (settled.state === "READY" || settled.state === "AUTH_REQUIRED") return { ...settled, reused: true };
    await release(targetRoot, owned, system);
    return settled;
  }
  if (row.occupied) return row;
  return app.start ? startApplication(targetRoot, app, system) : { ...row, reason: `${row.reason} ${app.startRefusal ?? "Its configuration authorizes no start."}` };
};

const publicRow = ({ occupied, ...row }, app) => ({
  role: app.role, origin: app.origin, startAuthorized: Boolean(app.start), reused: false, started: false, ...row,
});

/** `check` and `ensure` over the configured applications, `stop` over the toolkit's own. */
export const runAppRuntime = async ({ registryPath, moduleName, action = "check", system: injected = {} }) => {
  const system = { ...hostSystem, ...injected };
  if (!APP_RUNTIME_ACTIONS.includes(action)) throw new Error(`Unknown application runtime action '${action}'; use ${APP_RUNTIME_ACTIONS.join(", ")}.`);
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { targetRoot } = registryData;
  const base = { module: resolved.canonical, action, namespace: system.namespace };

  if (action === "stop") {
    return withModuleLock(targetRoot, LOCK_NAME, async () => {
      const applications = [];
      for (const role of ROLES) {
        const owned = await liveOwned(targetRoot, role, system);
        if (owned) await release(targetRoot, owned, system);
        applications.push({ role, stopped: Boolean(owned) });
      }
      return { ...base, applications };
    });
  }

  const notRequired = await requirement(targetRoot, resolved.canonical);
  if (notRequired) return { ...base, required: false, state: "NOT_REQUIRED", reason: notRequired, applications: [] };
  const configuration = await readConfiguration(targetRoot, system);
  if (configuration.problem) {
    return { ...base, required: true, state: "CONFIGURATION_MISSING", reason: configuration.problem, configFile: APP_RUNTIME_CONFIG, applications: [] };
  }
  if (configuration.namespace !== system.namespace) {
    return {
      ...base, required: true, state: "WRONG_NAMESPACE", configFile: APP_RUNTIME_CONFIG, applications: [],
      reason: `The applications run in the '${configuration.namespace}' network namespace but this engine runs in '${system.namespace}': loopback here is a different machine, so nothing was probed or started. Run the engine in '${configuration.namespace}'.`,
    };
  }

  const inspectOrEnsure = async () => {
    const applications = [];
    for (const app of configuration.applications) {
      const row = action === "ensure" ? await ensureApplication(targetRoot, app, system) : await inspect(app, system);
      applications.push(publicRow(row, app));
    }
    return applications;
  };
  const budget = configuration.applications.reduce((total, app) => total + app.startTimeoutMs, 30_000);
  const applications = action === "ensure"
    ? await withModuleLock(targetRoot, LOCK_NAME, inspectOrEnsure, { timeoutMs: budget })
    : await inspectOrEnsure();
  const states = applications.map((row) => row.state);
  const state = ["CONFIGURATION_MISSING", ...STATE_RANK].find((name) => states.includes(name));
  return { ...base, required: true, state, applications };
};
