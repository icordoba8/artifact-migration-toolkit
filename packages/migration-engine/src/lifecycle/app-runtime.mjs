/**
 * Lifecycle: the applications a migration observes (LEGACY, BACKEND, TARGET).
 * `prepare` seeds a missing template without probing or starting applications.
 * `configure` verifies project-declared endpoints before saving local facts.
 * `check` probes without writes. `ensure` can start an authorized application.
 * `stop` ends only what `ensure` started.
 *
 * Authority is one local file the operator configures, never the record, a response
 * or a tool argument. An incomplete generated template confers no authority.
 * An isolated start may only name a package script of the project it
 * describes, and a copy tracked by Git is refused, so a clone cannot grant a
 * startup. Probes send no credential, and nothing a response or a process said
 * is returned: no body, cookie, query string or command line. `trust:
 * "operator-local"` is the operator's waiver of the ownership half of that
 * authority only (`configAuthority`), for a machine that is theirs alone.
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
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { initialArtifacts } from "../formats/index.mjs";
import { assertPlainObject, assertSecurePath, execFileAsync, isLexicallyWithin, isPlainObject, PACKAGE_MANAGERS, samePath, SCRIPT_NAME, sha256Hex } from "../shared/index.mjs";
import {
  atomicWrite,
  migrationRoot,
  readJson,
  readOptionalJson,
  removeDurably,
  statePathFor,
} from "../store/index.mjs";
import { AUTH_PATH, refuseCapture } from "../visual/index.mjs";
import { readContext } from "./context.mjs";
import { withModuleLock } from "./lock.mjs";

export const APP_RUNTIME_CONFIG = ".artifact-migration-tools/runtime-apps.json";
const OWNED_DIRECTORY = ".artifact-migration-tools/app-runtime";
// What the installer writes into the consumer root's `.artifact-migration-tools/`; its presence marks that root.
const RECEIPTS = ["claude", "codex", "opencode", "copilot"].map((provider) => `.artifact-migration-tools/${provider}.json`);
export const APP_RUNTIME_ACTIONS = Object.freeze(["check", "configure", "prepare", "ensure", "stop"]);

// BACKEND first: the two front ends call it while they render.
const ROLES = ["BACKEND", "LEGACY", "TARGET"];
const REQUIRED_ROLES = ["LEGACY", "TARGET"];
const APPLICATION_KEYS = new Set(["origin", "project", "identity", "protectedRoute", "signInPath", "onSignIn", "start", "startTimeoutMs"]);
const TRUSTS = ["operator-isolated", "operator-local"];
const ON_SIGN_IN = ["record-gap", "wait-for-operator"];
// cmd.exe would read these; refusing them everywhere keeps one config valid on every host and Windows quoting inert.
const COMMAND_ARGUMENT = /^[^"&|<>^%!\r\n]+$/;
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

/**
 * Creates a process through WMI, so its parent is the WMI service: it holds no handle of this engine or of what
 * called it, and joins none of their jobs. Started as this engine's child, the application tree held the caller's
 * pipe open and kept `Start-Process -Wait` waiting until the applications exited (F-W7). Its console is hidden.
 * ponytail: every word is quoted as is; the words passed here (node's path, `-e`, the relay, base64) carry no `"`.
 */
const createDetached = async (argv, cwd) => {
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const line = argv.map((word) => `"${word}"`).join(" ");
  const { ReturnValue, ProcessId } = JSON.parse(await powershell(
    "$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow = [uint16]0}; " +
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = ${quote(line)}; CurrentDirectory = ${quote(cwd)}; ProcessStartupInformation = $s} | Select-Object ReturnValue,ProcessId | ConvertTo-Json -Compress`,
  ));
  if (ReturnValue !== 0) throw new Error(`Win32_Process.Create returned ${ReturnValue}`);
  return ProcessId;
};

const PM2_CHILD = /[\\/]pm2[\\/]lib[\\/]ProcessContainer(Fork)?\.js/;

/** The pm2 app name of a PID, or null. Asked only of a pm2 child, so its daemon is up and none is started here; best effort. */
const pm2App = async (pid) => {
  const { stdout } = await execFileAsync("pm2 jlist", [], { shell: true, windowsHide: true, timeout: 15_000, maxBuffer: 64 << 20 }).catch(() => ({ stdout: "" }));
  try {
    return JSON.parse(stdout.slice(stdout.indexOf("["))).find((app) => app.pid === pid)?.name ?? null;
  } catch {
    return null;
  }
};

const hostNamespace = () =>
  process.platform === "linux" && /microsoft/i.test(os.release()) ? "wsl" : process.platform;

const hostSystem = {
  namespace: hostNamespace(),
  platform: process.platform,
  // shortcut: an uninspectable host answers null and nothing it serves can be proven; add a reader per platform when one matters.
  lookup,
  listeners: (port) => (process.platform === "win32" ? windowsListeners(port) : posixListeners(port)).catch(() => null),
  processStart,
  killTree,
  configAuthority,
  createDetached,
  pm2App,
};

/** Who holds the port, and how the operator frees it; never the holder's command line. */
const foreignHolder = async (listener, system) => {
  const name = PM2_CHILD.test(listener.command ?? "") ? await system.pm2App(listener.pid).catch(() => null) : null;
  if (name) return `PID ${listener.pid} (pm2 app ${JSON.stringify(name)}); free the port with \`pm2 stop ${name}\``;
  return `PID ${listener.pid}; free the port with \`${system.platform === "win32" ? `taskkill /PID ${listener.pid}` : `kill ${listener.pid}`}\``;
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
export const holdersOf = (listeners, { address, family }, assumeDualStack = true) => {
  const wildcard = family === 4 ? "0.0.0.0" : "::";
  const exact = listeners.filter((listener) => listener.address === address || listener.address === wildcard);
  return exact.length > 0 || family !== 4 || !assumeDualStack ? exact : listeners.filter((listener) => listener.address === "::");
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
    if (landed && (landed.origin !== url.origin || landed.pathname === app.signInPath || AUTH_PATH.test(landed.pathname))) {
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
  const addresses = await system.lookup(host, { all: true, verbatim: true });
  if (addresses.some(({ address }) => address !== "127.0.0.1" && address !== "::1")) {
    return { state: "WRONG_APP", occupied: true, reason: `${url.hostname} resolves outside loopback.`, answers: [], listeners: [] };
  }
  const probes = await Promise.all(addresses.map(async (entry) => ({ ...entry, ...(await request(url, entry.address, app.identity.route)) })));
  const listeners = await system.listeners(Number(url.port));
  // An IPv6 wildcard is only evidence of an IPv4 holder when IPv4 answered.
  const answers = probes.map((answer) => ({ ...answer, holders: holdersOf(listeners ?? [], answer, answer.answered) }));
  const answering = answers.filter((answer) => answer.answered);
  // Occupied means never start here, whatever else is wrong with what answers.
  const occupied = answering.length > 0 || addresses.some((entry) => holdersOf(listeners ?? [], entry).length > 0);
  const evidence = { occupied, answers: answering.map(({ address, status }) => ({ address, status })), listeners: (listeners ?? []).map(({ address, pid }) => ({ address, pid })) };
  const row = (state, reason) => ({ state, reason, ...evidence });

  for (const answer of answering) {
    if (answer.status >= 500) continue;
    if (answer.status < 200 || answer.status >= 300) return row("WRONG_APP", `${answer.address} answered HTTP ${answer.status} on the identity route '${app.identity.route}'.`);
    if (!answer.body.includes(app.identity.includes)) return row("WRONG_APP", `${answer.address} serves '${app.identity.route}' without the configured identity marker.`);
  }
  let unproven;
  for (const { address, answered, holders } of answers) {
    const verdicts = holders.map((listener) => runsProject(listener, app.project));
    if (verdicts.includes(false)) {
      const foreign = await foreignHolder(holders[verdicts.indexOf(false)], system);
      return row("WRONG_APP", `${address} is held by a process outside '${app.project}': ${foreign}, or point ${app.role}.origin at this project's own port.`);
    }
    if (verdicts.includes(null) || (answered && verdicts.length === 0)) unproven ??= address;
  }
  const serverError = answering.find(({ status }) => status >= 500);
  if (serverError) return row("RUNTIME_DOWN", `${serverError.address} answered HTTP ${serverError.status} on '${app.identity.route}'.`);
  if (answering.length === 0) {
    return row("RUNTIME_DOWN", occupied ? `a process holds ${url.host} but does not answer HTTP.` : `nothing listens at ${url.host} (${[...new Set(answers.map((answer) => answer.code))].join(", ")}).`);
  }
  if (unproven) return row("IDENTITY_UNPROVEN", `no inspectable process in this namespace holds ${unproven}; a forwarded port, or a process of another user, proves nothing.`);
  const silent = answers.find(({ answered, holders }) => !answered && holders.length > 0);
  if (silent) return row("RUNTIME_DOWN", `a process holds ${silent.address} but does not answer HTTP on '${app.identity.route}' (${silent.code}).`);
  if (!app.protectedRoute) return row("READY", `identity proven on the listening addresses of ${url.host}.`);
  const { state, reason } = protectedRouteState(url, app, await request(url, answering[0].address, app.protectedRoute));
  return row(state, reason);
};

const route = (value, label) => {
  if (typeof value !== "string" || !/^\/(?!\/)(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-f]{2})*$/i.test(value)) throw new Error(`${label} must be an absolute path with no query.`);
  return value;
};

/**
 * The consumer root: the nearest directory from the target up to its Git top
 * level, inclusive, whose `.artifact-migration-tools/` holds an installer
 * receipt; the target itself when none does. Nothing above the work tree is
 * ever read, so a file planted there cannot become this target's authority.
 */
const configHome = async (targetRoot) => {
  const start = await realpath(targetRoot);
  const top = await execFileAsync("git", ["-C", start, "rev-parse", "--show-toplevel"]).then(({ stdout }) => stdout.trim(), () => null);
  const limit = top && await realpath(top).catch(() => null);
  if (!limit || !isLexicallyWithin(limit, start)) {
    throw new Error(`The target root '${start}' is not in a Git work tree, so the consumer root holding ${APP_RUNTIME_CONFIG} cannot be bounded.`);
  }
  for (let current = start; ; current = path.dirname(current)) {
    for (const receipt of RECEIPTS) {
      if ((await lstat(path.join(current, receipt)).catch(() => null))?.isFile()) return current;
    }
    if (samePath(current, limit) || path.dirname(current) === current) return start;
  }
};

const present = (file) => lstat(file).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

/**
 * Which configuration this target uses, and the folder its started
 * applications are recorded in. The engine never moves an operator's file:
 * a target-root copy beside a consumer-root one is refused, naming both.
 */
const locate = async (targetRoot) => {
  const home = await configHome(targetRoot);
  const target = await realpath(targetRoot);
  const at = (base, versions) => ({ base, file: path.join(base, APP_RUNTIME_CONFIG), target, home, versions });
  if (samePath(home, target)) return at(target, [1, 2]);
  const legacy = at(target, [1]);
  const current = at(home, [2]);
  const [old, now] = [await present(legacy.file), await present(current.file)];
  if (old && now) {
    throw new Error(`Two application runtime configurations exist, '${current.file}' and '${legacy.file}'; nothing was probed or started. Keep only '${current.file}' (version 2) and move the other aside.`);
  }
  if (!old) return current;
  return { ...legacy, notice: `'${legacy.file}' is in the deprecated target-root location; move it to '${current.file}' as version 2, with every project relative to '${home}'.` };
};

const parseApplication = async (role, value, base, trust) => {
  assertPlainObject(value, `applications.${role}`);
  const label = `applications.${role}`;
  const unknown = Object.keys(value).filter((key) => !APPLICATION_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${label} carries unsupported ${unknown.join(", ")}; a start command is a package script name, never a command line.`);
  let url;
  try { url = new URL(value.origin); } catch { throw new Error(`${label}.origin is not a URL.`); }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || !url.port || url.origin !== value.origin) {
    throw new Error(`${label}.origin must be exactly http://<localhost|127.0.0.1|[::1]>:<port>; another address is another network namespace.`);
  }
  if (typeof value.project !== "string" || !value.project.trim() || path.parse(value.project).root) throw new Error(`${label}.project must be a directory relative to the root holding the configuration.`);
  const project = await realpath(path.resolve(base, value.project)).catch(() => { throw new Error(`${label}.project '${value.project}' does not exist.`); });
  if (!(await stat(project)).isDirectory()) throw new Error(`${label}.project '${value.project}' is not a directory.`);
  if (!isPlainObject(value.identity) || typeof value.identity.includes !== "string" || !value.identity.includes.trim()) {
    throw new Error(`${label}.identity must be {route, includes}: a public route and text only this application serves.`);
  }
  route(value.identity.route, `${label}.identity.route`);
  if (value.protectedRoute !== undefined) route(value.protectedRoute, `${label}.protectedRoute`);
  if (value.signInPath !== undefined) route(value.signInPath, `${label}.signInPath`);
  const onSignIn = value.onSignIn ?? "record-gap";
  if (!ON_SIGN_IN.includes(onSignIn)) throw new Error(`${label}.onSignIn must be ${ON_SIGN_IN.join(" or ")}.`);
  if (onSignIn === "wait-for-operator") {
    // A browser signed in as this agent's account is exactly what operator-isolated keeps away from the agent.
    if (trust !== "operator-local") throw new Error(`${label}.onSignIn "wait-for-operator" is allowed only under trust "operator-local".`);
    if (value.signInPath === undefined) throw new Error(`${label}.onSignIn "wait-for-operator" needs signInPath.`);
  }
  if (value.start !== undefined) {
    const local = trust === "operator-local";
    const { manager, script, command, ...extra } = isPlainObject(value.start) ? value.start : { manager: null };
    const packageScript = PACKAGE_MANAGERS.has(manager) && typeof script === "string" && SCRIPT_NAME.test(script) && command === undefined;
    const argv = local && manager === undefined && script === undefined && Array.isArray(command) && command.length > 0 &&
      command.every((word) => typeof word === "string" && COMMAND_ARGUMENT.test(word));
    if (!(packageScript || argv) || Object.keys(extra).length > 0) {
      throw new Error(`${label}.start must be exactly {manager: npm|pnpm|yarn, script: <package script name>}, or, under trust "operator-local" only, {command: [<argument>...]} with no " & | < > ^ % ! or line break.`);
    }
  }
  const startTimeoutMs = value.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  if (!Number.isInteger(startTimeoutMs) || startTimeoutMs < 1 || startTimeoutMs > MAX_START_TIMEOUT_MS) {
    throw new Error(`${label}.startTimeoutMs must be 1..${MAX_START_TIMEOUT_MS}.`);
  }
  return { ...value, role, project, startTimeoutMs, onSignIn, trust };
};

const placeholder = (field) => `REPLACE_WITH_${field}`;
const placeholderValue = (value) => typeof value === "string" && /^\/?REPLACE_WITH_[A-Z0-9_]+$/.test(value);

const configurationTemplate = () => ({
  version: 2,
  namespace: placeholder("NAMESPACE"),
  trust: "operator-isolated",
  applications: Object.fromEntries(["LEGACY", "BACKEND", "TARGET"].map((role) => [role, {
    origin: placeholder(`${role}_HTTP_ORIGIN`),
    project: placeholder(`${role}_PROJECT`),
    identity: {
      route: placeholder(`${role}_PUBLIC_ROUTE`),
      includes: placeholder(`${role}_RESPONSE_MARKER`),
    },
    start: { manager: "pnpm", script: placeholder(`${role}_PACKAGE_SCRIPT`) },
  }])),
});

const unresolvedFields = (document) => {
  const unresolved = [];
  const record = (key, value) => { if (placeholderValue(value)) unresolved.push(key); };
  record("namespace", document.namespace);
  for (const [role, app] of Object.entries(document.applications)) {
    const prefix = `applications.${role}`;
    for (const field of ["origin", "project", "protectedRoute", "signInPath"]) record(`${prefix}.${field}`, app?.[field]);
    record(`${prefix}.identity.route`, app?.identity?.route);
    record(`${prefix}.identity.includes`, app?.identity?.includes);
    record(`${prefix}.start.script`, app?.start?.script);
    if (Array.isArray(app?.start?.command)) {
      app.start.command.forEach((value, i) => record(`${prefix}.start.command[${i}]`, value));
    }
  }
  return unresolved;
};

const assertUntracked = async (base, file) => {
  const relative = path.relative(base, file).replaceAll("\\", "/");
  const { stdout } = await execFileAsync("git", ["-C", base, "ls-files", "--", relative]).catch(() => {
    throw new Error(`could not verify '${file}' against the Git index; repair the index and retry.`);
  });
  if (stdout.trim()) throw new Error(`${relative} is tracked by Git; authority to start processes must stay local, so a clone cannot grant it.`);
};

const createLocalFile = (base, file, contents) =>
  atomicWrite(base, file, contents, { exclusive: true }).then(
    () => true,
    (error) => error.code === "EEXIST" ? false : Promise.reject(error),
  );

const createTemplate = async ({ base, file, target }) => {
  await assertUntracked(base, file);
  // If a deprecated copy appeared after locate(), leave it for the next read.
  if (!samePath(base, target) && await present(path.join(target, APP_RUNTIME_CONFIG))) return null;
  const template = configurationTemplate();
  await createLocalFile(base, path.join(path.dirname(file), ".gitignore"), "/runtime-apps.json\n/.gitignore\n");
  if (!(await createLocalFile(base, file, `${JSON.stringify(template, null, 2)}\n`))) return null;
  return template;
};

const incompleteConfiguration = (file, unresolved, templateCreated = false) => ({
  problem: `${templateCreated ? "Created the application template at" : "Edit"} '${file}'. Replace unresolved values: ${unresolved.join(", ")}. Remove BACKEND entirely if unused. Remove start from any application that the toolkit should not start.`,
  file, unresolved, ...(templateCreated ? { templateCreated } : {}),
});

const startScriptProblem = async ({ project, start }) => {
  if (!start || start.command) return null;
  const manifest = await readJson(path.join(project, "package.json"), "Project manifest").catch(() => null);
  return Object.hasOwn(manifest?.scripts ?? {}, start.script) ? null : `'${project}' has no package script '${start.script}'.`;
};

/** The trust boundary. Anything short of a local, well-formed file is a refusal with a reason, never a default. */
const readConfiguration = async (targetRoot, system = hostSystem, { validateScripts = false, seedTemplate = false, proposal } = {}) => {
  let handle;
  let file;
  try {
    const located = await locate(targetRoot);
    const { base, versions } = located;
    file = located.file;
    await assertSecurePath(base, file);
    if (proposal === undefined) handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (proposal === undefined && !handle) {
      if (seedTemplate) {
        const template = await createTemplate(located);
        if (template) return incompleteConfiguration(file, unresolvedFields(template), true);
        return readConfiguration(targetRoot, system, { validateScripts });
      }
      throw new Error(`${APP_RUNTIME_CONFIG} does not exist at '${file}'. Run the application preflight prepare to generate a template when runtime is needed.`);
    }
    await assertUntracked(base, file);
    let document = proposal;
    if (handle) {
      try { document = JSON.parse(await handle.readFile("utf8")); } catch { throw new Error(`${APP_RUNTIME_CONFIG} is not valid JSON.`); }
    }
    assertPlainObject(document, "Application runtime configuration");
    if (![1, 2].includes(document.version) || typeof document.namespace !== "string" || !isPlainObject(document.applications)) {
      throw new Error("The configuration must be {version: 1|2, namespace: win32|wsl|linux|darwin, applications}.");
    }
    // Version 1 resolves its projects against the target root, version 2 against the consumer root: a file moved without its projects is refused, never started.
    if (!versions.includes(document.version)) {
      throw new Error(document.version === 1
        ? `'${file}' is version 1, whose projects are relative to the target root; at the consumer root it must be version 2, with every project relative to '${base}'.`
        : `'${file}' is version 2, which belongs at the consumer root '${path.join(located.home, APP_RUNTIME_CONFIG)}'; in the target root only version 1 is read.`);
    }
    const unresolved = unresolvedFields(document);
    if (unresolved.length > 0) return incompleteConfiguration(file, unresolved);
    const trust = document.trust ?? "operator-isolated";
    if (!TRUSTS.includes(trust)) throw new Error(`trust must be ${TRUSTS.join(" or ")}.`);
    const unknown = Object.keys(document.applications).filter((role) => !ROLES.includes(role));
    const missing = REQUIRED_ROLES.filter((role) => !Object.hasOwn(document.applications, role));
    if (unknown.length > 0 || missing.length > 0) {
      throw new Error(`applications needs LEGACY and TARGET and may add BACKEND${unknown.length ? `; unknown ${unknown.join(", ")}` : ""}${missing.length ? `; missing ${missing.join(", ")}` : ""}.`);
    }
    const applications = [];
    for (const role of ROLES.filter((name) => Object.hasOwn(document.applications, name))) {
      applications.push(await parseApplication(role, document.applications[role], base, trust));
    }
    // One consumer-root file serves one target: the one its TARGET application lives in.
    const own = applications.find((app) => app.role === "TARGET").project;
    if (document.version === 2 && !isLexicallyWithin(located.target, own)) {
      throw Object.assign(new Error(`'${file}' serves the target at '${own}', not this module's target '${located.target}'; nothing was probed, started or stopped.`), { foreign: true });
    }
    if (validateScripts && document.namespace === system.namespace) {
      for (const app of applications) {
        const problem = await startScriptProblem(app);
        if (problem) throw new Error(problem);
      }
    }
    const broker = document.sessionBroker;
    if (broker !== undefined && (!isPlainObject(broker) || Object.keys(broker).length !== 2 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(broker.url) ||
        typeof broker.tokenFile !== "string" || !path.isAbsolute(broker.tokenFile))) {
      throw new Error("sessionBroker must be exactly {url: http://127.0.0.1:<port>, tokenFile: <absolute path to the client token>}.");
    }
    // operator-local: the operator accepts that this account, the agent's, may author starts. Only ownership is waived.
    const refusal = handle && trust !== "operator-local" && applications.some((app) => app.start) ? await system.configAuthority(file, handle) : null;
    return {
      base,
      file,
      notice: located.notice,
      namespace: document.namespace,
      sessionBroker: document.sessionBroker,
      applications: refusal ? applications.map(({ start, ...app }) => ({ ...app, startRefusal: refusal })) : applications,
    };
  } catch (error) {
    return { problem: error.message, foreign: error.foreign, file };
  } finally {
    await handle?.close();
  }
};

/** Where the session broker listens and the token this client asks with, for a capture that asked for its session. */
export const sessionBrokerOf = async (targetRoot) => {
  const { problem, sessionBroker } = await readConfiguration(targetRoot);
  if (problem || !sessionBroker) refuseCapture("CAPTURE_BROKER_UNCONFIGURED", `No session broker is configured in ${APP_RUNTIME_CONFIG}${problem ? `: ${problem}` : "."}`);
  const token = (await readFile(sessionBroker.tokenFile, "utf8").catch(() => "")).trim();
  if (!token) refuseCapture("CAPTURE_BROKER_UNCONFIGURED", `The session broker client token '${sessionBroker.tokenFile}' is missing or empty.`);
  return { url: sessionBroker.url, token };
};

/**
 * The LEGACY origin the runtime contract declares, or null when no contract
 * exists. A contract that exists but cannot be read is refused: it can neither
 * authorize nor be ignored by a capture.
 */
export const legacyRuntimeOriginOf = async (targetRoot) => {
  const { problem, file, applications } = await readConfiguration(targetRoot);
  if (!problem) return applications.find((app) => app.role === "LEGACY").origin;
  // ponytail: no locatable file (no Git work tree, or none written) means no contract; a session check still needs one.
  if (!file || !(await lstat(file).then(() => true, () => false))) return null;
  return refuseCapture("CAPTURE_AUTHORITY_MISMATCH", `The runtime contract cannot authorize this capture: ${problem}`);
};

/** Each role's session word, so an AUTH_REQUIRED row says whether a capture can continue. */
const sessionStates = async (targetRoot) => {
  const broker = await sessionBrokerOf(targetRoot).catch(() => null);
  const response = broker && await fetch(new URL("/status", broker.url), {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${broker.token}` }, body: "{}", signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  return response?.ok ? response.json() : "UNAVAILABLE";
};

/** A finished migration, and one whose closed discovery found no visible UI, have nothing to observe. The template seeds `hasVisibleUi: false`, so before that it means nothing. */
const requirement = async (targetRoot, moduleName) => {
  const state = await readOptionalJson(statePathFor(targetRoot, moduleName), "Migration state");
  if (state?.status === "COMPLETE") return "The record is COMPLETE.";
  if (!state?.completedSteps?.includes("DISCOVER_LEGACY")) return null;
  const inventory = await readOptionalJson(path.join(migrationRoot(targetRoot, moduleName), initialArtifacts.legacyInventory), "Legacy inventory");
  return inventory?.hasVisibleUi === false ? "The module declares no visible UI; no browser or application evidence applies." : null;
};

// `base` is the folder holding the configuration in use: the consumer root, or a deprecated target root.
const ownedFile = (base, role) => path.join(base, OWNED_DIRECTORY, `${role}.json`);

/** Both folders a started application may be recorded in, so moving the configuration never strands a process. */
const stateFolders = async (targetRoot) => {
  const target = await realpath(targetRoot);
  const home = await configHome(target).catch(() => target);
  return samePath(home, target) ? [target] : [target, home];
};

/** A record names a live process only while its PID still has the same start time; anything else is stale. */
const liveOwned = async (base, role, system, { prune = true } = {}) => {
  const file = ownedFile(base, role);
  const owned = await readOptionalJson(file, "Owned application record");
  if (!owned) return null;
  // Another namespace's PID means nothing here, so that record is not ours to judge.
  if (owned.namespace !== system.namespace) return null;
  const started = await system.processStart(owned.pid);
  if (started !== null && started === owned.processStart) return owned;
  if (prune) await removeDurably(base, file);
  return null;
};

const release = async (base, owned, system) => {
  await system.killTree(owned.pid);
  await removeDurably(base, ownedFile(base, owned.role));
};

const untilSettled = async (app, system, exited) => {
  const deadline = Date.now() + app.startTimeoutMs;
  for (;;) {
    const row = await inspect(app, system);
    if (row.state === "READY" || row.state === "AUTH_REQUIRED" || row.state === "WRONG_APP" || row.state === "IDENTITY_UNPROVEN") return row;
    await sleep(POLL_MS);
    const stopped = await exited();
    if (stopped != null) return { ...row, reason: `the start script exited (${stopped}) before the application was ready.`, failure: "STARTUP_FAILED" };
    if (Date.now() >= deadline) return { ...row, reason: `the application was not ready within ${app.startTimeoutMs} ms.`, failure: "STARTUP_TIMEOUT" };
  }
};

/**
 * The win32 start: a node relay that holds the log and runs the line through a shell, an ordinary child that
 * shares the relay's console (a console-less cmd.exe would give its console program a new one, writing there
 * instead of the log). Its one argument is base64 JSON, never source, and the relay has no `"`, so neither needs
 * quoting. The engine is not its parent, so the relay writes how the shell ended to the exit file.
 */
const WIN32_RELAY = "const a=JSON.parse(Buffer.from(process.argv[1],'base64'));const fs=require('node:fs');const f=fs.openSync(a.log,'a');" +
  "const c=require('node:child_process').spawn(a.line,{shell:true,cwd:a.cwd,env:a.env,stdio:['ignore',f,f],windowsHide:true});" +
  "const end=(how)=>{fs.writeFileSync(a.exit,String(how));process.exit()};" +
  "c.on('exit',(code,signal)=>end(signal??code));c.on('error',(error)=>end(error.code??'error'));";

/**
 * How a start runs. A package script goes through a shell, as it always has. An
 * argv command runs without one, except on win32, where package managers are
 * `.cmd` shims only cmd.exe resolves; its arguments carry no character cmd.exe reads.
 */
const startLine = (start) => start.command ? start.command.map((word) => (/\s/.test(word) ? `"${word}"` : word)).join(" ") : `${start.manager} run ${start.script}`;

/** A started process's PID and `exited()`: how its start ended, or null while it runs. */
const spawnStart = async (base, app, logFile, system) => {
  if (system.platform === "win32") {
    const exitFile = `${logFile.slice(0, -".log".length)}.exit`;
    await removeDurably(base, exitFile);
    const payload = Buffer.from(JSON.stringify({ line: startLine(app.start), cwd: app.project, env: childEnvironment(), log: logFile, exit: exitFile })).toString("base64");
    const pid = await system.createDetached([process.execPath, "-e", WIN32_RELAY, payload], app.project);
    return { pid, exited: () => readFile(exitFile, "utf8").catch(() => null) };
  }
  const log = await open(logFile, "a", 0o600);
  const [file, args, shell] = app.start.command ? [app.start.command[0], app.start.command.slice(1), false] : [startLine(app.start), [], true];
  const child = spawn(file, args, { cwd: app.project, env: childEnvironment(), shell, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
  let exit = null;
  const ended = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(exit = code ?? signal));
    child.once("error", (error) => resolve(exit = error.code ?? error.message));
  });
  await log.close();
  child.unref();
  if (!child.pid) throw new Error(String(await ended));
  return { pid: child.pid, exited: () => exit };
};

const startApplication = async (base, app, system) => {
  const problem = await startScriptProblem(app);
  if (problem) return { state: "CONFIGURATION_MISSING", reason: problem };
  const directory = path.join(base, OWNED_DIRECTORY);
  await atomicWrite(base, path.join(directory, ".gitignore"), "*\n");
  const logFile = await assertSecurePath(base, path.join(directory, `${app.role}.log`));
  const logPath = path.relative(base, logFile).replaceAll("\\", "/");
  // A script's two words were checked against an allowlist and the project's own manifest.
  const { pid, exited, error } = await spawnStart(base, app, logFile, system).catch((failure) => ({ error: failure }));
  if (error) return { state: "RUNTIME_DOWN", reason: `'${app.start.manager ?? app.start.command[0]}' could not be started (${error.message}).`, failure: "STARTUP_FAILED", log: logPath };
  const owned = { version: 1, role: app.role, pid, namespace: system.namespace, processStart: await system.processStart(pid), origin: app.origin };
  await atomicWrite(base, ownedFile(base, app.role), `${JSON.stringify(owned, null, 2)}\n`);
  const row = await untilSettled(app, system, exited);
  if (row.state !== "READY" && row.state !== "AUTH_REQUIRED") {
    await release(base, owned, system);
    return { ...row, log: logPath };
  }
  return { ...row, started: true, log: logPath };
};

const ensureApplication = async (base, app, system) => {
  const row = await inspect(app, system);
  if (row.state !== "RUNTIME_DOWN") return { ...row, reused: row.state === "READY" || row.state === "AUTH_REQUIRED" };
  // Started earlier and still coming up: wait for it, never start a second one.
  const owned = await liveOwned(base, app.role, system);
  if (owned) {
    const settled = await untilSettled(app, system, () => null);
    if (settled.state === "READY" || settled.state === "AUTH_REQUIRED") return { ...settled, reused: true };
    await release(base, owned, system);
    return settled;
  }
  if (row.occupied) return row;
  return app.start ? startApplication(base, app, system) : { ...row, reason: `${row.reason} ${app.startRefusal ?? "Its configuration authorizes no start."}` };
};

const publicRow = ({ occupied, ...row }, app) => ({
  role: app.role, origin: app.origin, trust: app.trust, onSignIn: app.onSignIn,
  protectedRoute: app.protectedRoute, signInPath: app.signInPath,
  startAuthorized: Boolean(app.start), reused: false, started: false, ...row,
});

const runtimeDescriptor = async (base, project) => {
  const file = await assertSecurePath(base, path.join(project, "package.json"));
  return (await readOptionalJson(file, "Project manifest"))?.config?.startMigration?.runtime;
};

const verifiedConfiguration = async ({ registryData, system, report }) => {
  const { legacyRoot, targetRoot } = registryData;
  const { base, file, versions } = await locate(targetRoot);
  const legacy = await runtimeDescriptor(base, legacyRoot);
  const target = await runtimeDescriptor(base, targetRoot);
  if (legacy === undefined && target === undefined) {
    return { ...report, state: "DISCOVERY_UNAVAILABLE", reason: "The project manifests declare no application runtime endpoints.", applications: [] };
  }
  await assertSecurePath(base, file);
  await assertUntracked(base, file);
  const readCurrent = () => readFile(file, {
    flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const before = await readCurrent();
  let previous = null;
  if (before !== null) {
    try { previous = JSON.parse(before.toString("utf8")); } catch { throw new Error(`${APP_RUNTIME_CONFIG} is not valid JSON.`); }
    assertPlainObject(previous, "Application runtime configuration");
  }
  if (!versions.includes(2) || (previous && (previous.version !== 2 || !isPlainObject(previous.applications)))) {
    throw new Error("Use the current consumer-root version 2 configuration before synchronizing project endpoints.");
  }
  const namespace = previous?.namespace;
  if (namespace !== undefined && !placeholderValue(namespace) && namespace !== system.namespace) {
    return { ...report, state: "WRONG_NAMESPACE", reason: `The configuration is for '${namespace}', not this engine's '${system.namespace}' namespace.`, applications: [] };
  }
  const hasOperatorAuthority = previous && (previous.sessionBroker !== undefined ||
    Object.values(previous.applications).some((app) =>
      (app?.start !== undefined && !placeholderValue(app.start?.script)) || app?.onSignIn === "wait-for-operator",
    ));
  if (hasOperatorAuthority) {
    const prior = await readConfiguration(targetRoot, system, { proposal: previous, validateScripts: true });
    if (prior.problem) throw new Error(`Resolve the project binding and endpoint configuration before preserving startup or sign-in settings. ${prior.problem}`);
  }
  const document = previous ? structuredClone(previous) : { version: 2, trust: "operator-isolated", applications: {} };
  document.namespace = system.namespace;
  const projects = [["LEGACY", legacyRoot, legacy], ["TARGET", targetRoot, target]];
  if (target?.backendProject !== undefined) {
    if (typeof target.backendProject !== "string" || !target.backendProject.trim() || path.isAbsolute(target.backendProject)) {
      throw new Error("TARGET runtime.backendProject must be a relative project directory.");
    }
    const project = await assertSecurePath(base, path.resolve(targetRoot, target.backendProject));
    projects.push(["BACKEND", project, await runtimeDescriptor(base, project)]);
  } else if (JSON.stringify(document.applications.BACKEND) === JSON.stringify(configurationTemplate().applications.BACKEND)) {
    delete document.applications.BACKEND;
  }
  for (const [role, project, descriptor] of projects) {
    const { port, identity } = assertPlainObject(descriptor, `${role} config.startMigration.runtime`);
    if (!Number.isInteger(port) || port < 1 || port > 0xffff || port === 80) {
      throw new Error(`${role} runtime.port must be a valid, nonzero TCP port other than HTTP default port 80.`);
    }
    const old = document.applications[role] ?? {};
    assertPlainObject(old, `applications.${role}`);
    const configured = typeof old.project === "string" && !placeholderValue(old.project) && !path.isAbsolute(old.project)
      ? await realpath(path.resolve(base, old.project)).catch(() => null)
      : null;
    const hasStart = old.start !== undefined && !placeholderValue(old.start?.script);
    const previousOrigin = typeof old.origin === "string" && URL.canParse(old.origin) ? new URL(old.origin) : null;
    const hostname = previousOrigin?.protocol === "http:" && LOOPBACK.has(previousOrigin.hostname)
      ? previousOrigin.hostname
      : "localhost";
    const origin = `http://${hostname}:${port}`;
    const usesSession = old.onSignIn === "wait-for-operator" || (role !== "BACKEND" && document.sessionBroker !== undefined);
    if ((configured && !samePath(configured, project)) || (!configured && hasStart) ||
        (usesSession && (!configured || old.origin !== origin))) {
      throw new Error(`The discovered ${role} project or session origin differs from its local configuration. Resolve the project binding before changing its runtime endpoints.`);
    }
    const app = {
      ...old,
      project: configured ? old.project : path.relative(base, project).replaceAll("\\", "/") || ".",
      origin,
      identity: { route: identity?.route, includes: identity?.includes },
    };
    if (!hasStart) delete app.start;
    document.applications[role] = app;
  }

  const candidate = await readConfiguration(targetRoot, system, { proposal: document, validateScripts: true });
  if (candidate.problem || candidate.file !== file) throw new Error(candidate.problem ?? "The configuration path changed during discovery.");
  for (const { role, origin } of candidate.applications) {
    const owned = await liveOwned(base, role, system, { prune: false });
    if (owned && owned.origin !== origin) {
      throw new Error(`Stop the toolkit-owned ${role} process at ${owned.origin} before changing its runtime origin.`);
    }
  }
  const applications = await Promise.all(candidate.applications.map(async ({ start, ...app }) => publicRow(await inspect(app, system), app)));
  const state = STATE_RANK.find((status) => applications.some((app) => app.state === status));
  if (!["READY", "AUTH_REQUIRED"].includes(state)) return { ...report, state, applications };

  const changed = before === null || JSON.stringify(previous) !== JSON.stringify(document);
  let rollbackPath;
  if (changed) {
    if ((await locate(targetRoot)).file !== file) throw new Error("The configuration path changed during discovery.");
    await assertUntracked(base, file);
    await createLocalFile(base, path.join(path.dirname(file), ".gitignore"), "/runtime-apps.json\n/.gitignore\n");
    await execFileAsync("git", ["-C", base, "check-ignore", "--", APP_RUNTIME_CONFIG]);
    if (before === null) {
      if (!(await createLocalFile(base, file, `${JSON.stringify(document, null, 2)}\n`))) throw new Error("The local configuration appeared during discovery. Retry.");
    } else {
      // Respect the existing file's write permissions before replacing its directory entry.
      const handle = await open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const original = await handle.stat({ bigint: true });
        if (!(await handle.readFile()).equals(before)) throw new Error("The local configuration changed during discovery. Retry.");
        rollbackPath = path.join(base, OWNED_DIRECTORY, `runtime-apps.previous-${sha256Hex(before)}.json`);
        await assertUntracked(base, rollbackPath);
        await createLocalFile(base, path.join(path.dirname(rollbackPath), ".gitignore"), "*\n");
        await execFileAsync("git", ["-C", base, "check-ignore", "--", path.relative(base, rollbackPath)]);
        if (!(await createLocalFile(base, rollbackPath, before)) && !(await readFile(rollbackPath)).equals(before)) {
          throw new Error(`Rollback copy '${rollbackPath}' does not match the current configuration.`);
        }
        const current = await lstat(file, { bigint: true });
        if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino || !(await readCurrent())?.equals(before)) {
          throw new Error("The local configuration changed during discovery. Retry.");
        }
      } finally {
        await handle.close();
      }
      await atomicWrite(base, file, `${JSON.stringify(document, null, 2)}\n`).catch((error) => {
        throw new Error(`Cannot publish the verified configuration. The previous bytes are at '${rollbackPath}'. ${error.message}`, { cause: error });
      });
    }
  }
  return { ...report, state: "CONFIGURED", configPath: file, changed, ...(rollbackPath ? { rollbackPath } : {}), applications };
};

/** Prepare configuration, check or ensure applications, or stop toolkit-owned processes. */
export const runAppRuntime = async ({ registryPath, moduleName, action = "check", system: injected = {} }) => {
  const system = { ...hostSystem, ...injected };
  if (!APP_RUNTIME_ACTIONS.includes(action)) throw new Error(`Unknown application runtime action '${action}'; use ${APP_RUNTIME_ACTIONS.join(", ")}.`);
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { targetRoot } = registryData;
  const base = { module: resolved.canonical, action, namespace: system.namespace };

  if (action === "stop") {
    // A missing or doubled configuration never blocks ending what ensure started; a file serving another target does.
    const configuration = await readConfiguration(targetRoot, system);
    if (configuration.foreign) return { ...base, state: "CONFIGURATION_MISSING", reason: configuration.problem, configFile: APP_RUNTIME_CONFIG, applications: [] };
    const folders = await stateFolders(targetRoot);
    return withModuleLock(targetRoot, LOCK_NAME, async () => {
      const applications = [];
      for (const role of ROLES) {
        let stopped = false;
        for (const folder of folders) {
          const owned = await liveOwned(folder, role, system);
          if (owned) await release(folder, owned, system);
          stopped ||= Boolean(owned);
        }
        applications.push({ role, stopped });
      }
      return { ...base, applications };
    });
  }

  const notRequired = await requirement(targetRoot, resolved.canonical);
  if (notRequired) return { ...base, required: false, state: "NOT_REQUIRED", reason: notRequired, applications: [] };
  if (action === "configure") {
    const report = { ...base, required: true, configFile: APP_RUNTIME_CONFIG };
    return withModuleLock(targetRoot, LOCK_NAME, () =>
      verifiedConfiguration({ registryData, system, report }).catch((error) => ({
        ...report, state: "CONFIGURATION_MISSING", reason: error.message, applications: [],
      })),
    );
  }
  const inspectOrEnsure = async (configuration) => {
    if (configuration.problem) {
      const { problem, file, unresolved, templateCreated } = configuration;
      return {
        ...base, required: true, state: "CONFIGURATION_MISSING", reason: problem, configFile: APP_RUNTIME_CONFIG,
        ...(file ? { configPath: file } : {}), ...(unresolved ? { unresolved } : {}), ...(templateCreated ? { templateCreated } : {}),
        applications: [],
      };
    }
    if (configuration.namespace !== system.namespace) {
      return {
        ...base, required: true, state: "WRONG_NAMESPACE", configFile: APP_RUNTIME_CONFIG, applications: [],
        reason: `The applications run in the '${configuration.namespace}' network namespace but this engine runs in '${system.namespace}': loopback here is a different machine, so nothing was probed or started. Run the engine in '${configuration.namespace}'.`,
      };
    }
    if (action === "prepare") {
      return {
        ...base, required: true, state: "CONFIGURED", configPath: configuration.file,
        ...(configuration.notice ? { reason: configuration.notice } : {}), applications: [],
      };
    }
    const applications = [];
    for (const app of configuration.applications) {
      const row = action === "ensure" ? await ensureApplication(configuration.base, app, system) : await inspect(app, system);
      applications.push(publicRow(row, app));
    }
    const states = applications.map((row) => row.state);
    const state = ["CONFIGURATION_MISSING", ...STATE_RANK].find((name) => states.includes(name));
    return {
      ...base, required: true, state, ...(configuration.notice ? { reason: configuration.notice } : {}), applications,
      ...(configuration.sessionBroker ? { sessions: await sessionStates(targetRoot) } : {}),
    };
  };
  const configuration = await readConfiguration(targetRoot, system, { validateScripts: true, seedTemplate: action === "prepare" || action === "ensure" });
  if (action !== "ensure" || configuration.problem || configuration.namespace !== system.namespace) return inspectOrEnsure(configuration);
  const budget = configuration.applications.reduce((total, app) => total + app.startTimeoutMs, 30_000);
  return withModuleLock(targetRoot, LOCK_NAME, async () =>
    inspectOrEnsure(await readConfiguration(targetRoot, system, { validateScripts: true })),
    { timeoutMs: budget },
  );
};
