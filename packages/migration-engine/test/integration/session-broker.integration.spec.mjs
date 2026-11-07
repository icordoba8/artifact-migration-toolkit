// The session boundary between two real OS users. One account runs the broker
// and alone holds the session; a second, unprivileged account plays the agent
// and tries to take it. Needs passwordless sudo to create both accounts, and a
// browser: it skips by name without them, and ARTIFACT_MIGRATION_BROWSER_GATE=1
// turns a skip into a failure.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readBrokerConfig, storeIsPrivate } from "../../src/session-broker-host.mjs";
import { captureThroughBroker, claimCapturePlan, parseBrokeredPlan, parseCaptureRequest } from "../../src/visual/index.mjs";

const execFileAsync = promisify(execFile);
const engineRoot = fileURLToPath(new URL("../..", import.meta.url));
const CANARY = `amt-session-${randomBytes(12).toString("hex")}`;
const TOKEN = randomBytes(24).toString("hex");
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
const suffix = randomBytes(4).toString("hex");
const BROKER = `amtbroker${suffix}`;
const AGENT = `amtagent${suffix}`;

const sudo = (...args) => execFileAsync("sudo", ["-n", ...args], { encoding: "utf8", timeout: 30_000 });
const asAgent = (...args) => sudo("-u", AGENT, ...args).then(({ stdout }) => ({ ok: true, stdout }), (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));

const SKIP = await (async () => {
  if (process.platform === "win32") return "the boundary is proven on POSIX accounts here; Windows needs its own deployment run";
  if (!(await sudo("true").then(() => true, () => false))) return "needs passwordless sudo to create two accounts";
  if (!(await execFileAsync("sh", ["-c", "command -v google-chrome"]).then(() => true, () => false))) return "needs google-chrome on PATH";
  return null;
})();
if (SKIP && process.env.ARTIFACT_MIGRATION_BROWSER_GATE === "1") throw new Error(`session boundary not proven: ${SKIP}`);

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const PAGE = `<!doctype html><html><head><title>Records</title><style>body{margin:0;font-family:Arial, sans-serif;background:#ffffff}
main{display:flex;flex-direction:column;padding:16px;gap:12px;color:rgb(22,32,44);background:#ffffff;border:1px solid rgb(217,225,234);border-radius:4px;font-size:14px;line-height:20px;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.2);}</style></head>
<body><main aria-label="Records"><h1>Records</h1><p class="row">One</p><p class="row">Two</p>
<button onclick="fetch('/records/delete-all',{method:'POST'}).catch(()=>{})">Delete all</button><a href="/admin">Admin</a></main></body></html>`;

/** An application whose only session is an HttpOnly cookie, so a page script cannot see it either. */
const application = async () => {
  const controls = { maxAge: 600, revoked: false, writes: 0 };
  const server = http.createServer((request, response) => {
    const signedIn = !controls.revoked && (request.headers.cookie ?? "").includes(`sid=${CANARY}`);
    if (request.method === "POST") controls.writes += 1;
    if (request.url === "/login") { response.writeHead(200, { "content-type": "text/html" }); response.end('<script>location.href="/do-login"</script>'); return; }
    if (request.url === "/do-login") {
      response.writeHead(302, { location: "/records", "set-cookie": `sid=${CANARY}; HttpOnly; Path=/; Max-Age=${controls.maxAge}` });
      response.end();
      return;
    }
    if (!signedIn) { response.writeHead(302, { location: "/login" }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, controls, origin: `http://127.0.0.1:${server.address().port}` };
};

const plan = (origin, extra = {}) => parseCaptureRequest({
  origin, route: "/records", viewport: { width: 640, height: 360 }, uiBehaviorId: "records", state: "DEFAULT",
  rootLocator: "main", counts: { rows: ".row" }, controls: [{ role: "heading", name: "Records", locator: "h1" }], ...extra,
});

const ROUTES = ["/records"];

test("the broker refuses a store another account could read, and any route that leaves its origin", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amt-broker-config-"));
  await chmod(directory, 0o755);
  const file = path.join(directory, "config.json");
  const write = (applications, extra = {}) => writeFile(file, JSON.stringify({ port: 1, store: directory, clientTokenSha256: TOKEN_SHA256, applications, ...extra }));
  await write({});
  await assert.rejects(readBrokerConfig(file), /must be mode 0700/);
  await chmod(directory, 0o700);
  assert.equal((await readBrokerConfig(file)).store, directory);
  const legacy = { origin: "http://127.0.0.1:1", signInRoute: "/login", routes: ROUTES };
  await write({ LEGACY: legacy });
  assert.equal((await readBrokerConfig(file)).applications.LEGACY.origin, legacy.origin);
  for (const [application, extra] of [
    [{ ...legacy, signInRoute: "//evil.example" }],
    [{ ...legacy, signInRoute: "/\\evil.example" }],
    [{ ...legacy, signInRoute: "https://evil.example/login" }],
    [{ ...legacy, routes: [] }],
    [{ ...legacy, routes: ["//evil.example"] }],
    [{ ...legacy, allowWrites: "yes" }],
    [{ ...legacy, identityProviders: ["http://idp.example"] }],
    [legacy, { clientTokenSha256: undefined }],
  ]) {
    await write({ LEGACY: application }, extra);
    await assert.rejects(readBrokerConfig(file), /must be/, JSON.stringify(application));
  }
  await rm(directory, { recursive: true, force: true });
});

test("a Windows store admits only its own account, SYSTEM and Administrators, by SID", () => {
  const me = "S-1-5-21-1-2-3-1001";
  assert.equal(storeIsPrivate(`O:${me}G:${me}D:PAI(A;OICI;FA;;;${me})(A;OICI;FA;;;SY)`, me), true);
  assert.equal(storeIsPrivate(`O:BAD:P(A;OICI;FA;;;${me})(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;BA)`, me), true);
  assert.equal(storeIsPrivate(`O:${me}D:AI(A;OICI;FA;;;${me})(A;OICIID;0x1200a9;;;BU)`, me), false, "Users inherited");
  assert.equal(storeIsPrivate(`O:${me}D:P(A;OICI;FA;;;${me})(A;OICI;FA;;;S-1-5-21-1-2-3-1002)`, me), false, "the agent's account");
  assert.equal(storeIsPrivate(`O:${me}D:P(A;OICI;FA;;;WD)`, me), false, "Everyone");
  assert.equal(storeIsPrivate(`O:${me}D:P`, me), false, "no grant at all is not a store this account can use");
});

test("a broker running as this same account is refused: it isolates nothing", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ account: os.userInfo().username, screenshot: "" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(captureThroughBroker({ url: `http://127.0.0.1:${server.address().port}`, token: TOKEN }, {}), { validationCode: "CAPTURE_BROKER_NOT_ISOLATED" });
  } finally {
    server.close();
  }
});

test("a capture request cannot carry both a session file and the broker session", () => {
  assert.equal(plan("http://127.0.0.1:1", { session: true }).session, true);
  assert.throws(() => plan("http://127.0.0.1:1", { session: true, storageState: "/tmp/x.json" }), /replaces storageState/);
  assert.throws(() => plan("http://127.0.0.1:1", { session: "yes" }), /session must be true/);
});

test("a plan crosses the boundary whole, and only what parsing accepts survives", () => {
  const frame = plan("http://127.0.0.1:1", { session: true, setup: [{ type: "fill", target: "input", value: "a" }] });
  const { browser, storageState, session, ...frameKept } = frame;
  assert.deepEqual(parseBrokeredPlan(frame), { ...frameKept, browser: undefined, storageState: undefined, session: undefined });

  const claim = claimCapturePlan(
    parseCaptureRequest({ origin: "http://127.0.0.1:1", route: "/records", viewport: { width: 640, height: 360 }, appearanceClaimId: "claim-1", interaction: { type: "click", target: "#more" }, session: true }),
    { id: "records" },
    { id: "claim-1", state: "OPEN", locator: "#menu", role: "menu", name: "Account", afterInteractionId: "open-menu" },
  );
  const crossed = parseBrokeredPlan({ ...claim, storageState: "/etc/passwd", browser: "msedge", extra: "dropped" });
  for (const key of ["mode", "origin", "url", "uiBehaviorId", "state", "rootLocator", "controls", "appearanceClaimId", "interaction"]) assert.deepEqual(crossed[key], claim[key], key);
  assert.equal(crossed.storageState, undefined);
  assert.equal(crossed.browser, undefined);
  assert.equal(crossed.extra, undefined);
  assert.throws(() => parseBrokeredPlan({ ...claim, interaction: { id: "x", action: { type: "evaluate", target: "y" } } }), /type must be one of/);
  assert.throws(() => parseBrokeredPlan({ ...claim, mode: "other" }), /capture plan/);
});

test("without a broker a capture is refused by name, not sent elsewhere", async () => {
  await assert.rejects(captureThroughBroker({ url: `http://127.0.0.1:${await freePort()}`, token: TOKEN }, {}), { validationCode: "CAPTURE_BROKER_UNAVAILABLE" });
});

let root;
let broker;
let legacy;
let target;
let brokerUrl;
let store;
const stderr = [];

const post = async (route, body = {}, headers = {}) => {
  const response = await fetch(`${brokerUrl}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
};

before(async () => {
  if (SKIP) return;
  for (const name of [BROKER, AGENT]) await sudo("useradd", "-M", "-s", "/usr/sbin/nologin", name);
  // Under /home a test tree is not reachable by another account, so both get a copy of what they run.
  root = await mkdtemp(path.join(os.tmpdir(), "amt-broker-"));
  await chmod(root, 0o755);
  await cp(path.join(engineRoot, "src"), path.join(root, "engine/src"), { recursive: true });
  await cp(path.join(engineRoot, "package.json"), path.join(root, "engine/package.json"));
  await cp(path.join(engineRoot, "node_modules"), path.join(root, "engine/node_modules"), { recursive: true, dereference: true });
  await cp(process.execPath, path.join(root, "node"));
  [legacy, target] = await Promise.all([application(), application()]);
  store = path.join(root, "store");
  const home = path.join(root, "home");
  await mkdir(store);
  await mkdir(home);
  await sudo("chown", BROKER, store, home);
  await sudo("chmod", "700", store, home);
  const port = await freePort();
  brokerUrl = `http://127.0.0.1:${port}`;
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({
    port, store, browser: "chrome", headless: true, clientTokenSha256: TOKEN_SHA256,
    applications: { LEGACY: { origin: legacy.origin, signInRoute: "/login", routes: ROUTES }, TARGET: { origin: target.origin, signInRoute: "/login", routes: ROUTES } },
  }));
  await chmod(path.join(root, "node"), 0o755);
  await sudo("chmod", "-R", "a+rX", path.join(root, "engine"), config);
  broker = spawn("sudo", ["-n", "-u", BROKER, "env", "-i", `HOME=${home}`, `PATH=${process.env.PATH}`, path.join(root, "node"), path.join(root, "engine/src/session-broker.mjs"), config], { stdio: ["ignore", "pipe", "pipe"] });
  broker.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await fetch(brokerUrl, { method: "POST" }).then(() => true, () => false)) break;
    assert.ok(Date.now() < deadline, `the broker did not start: ${stderr.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

after(async () => {
  if (SKIP) return;
  await sudo("pkill", "-u", BROKER).catch(() => {});
  legacy?.server.close();
  target?.server.close();
  for (const name of [BROKER, AGENT]) await sudo("userdel", name).catch(() => {});
  if (root) await sudo("rm", "-rf", root);
});

test("the agent account gets the capability and never the session", { skip: SKIP ?? false, timeout: 120_000 }, async () => {
  // Nothing stored yet: refused by name, and the other role is unaffected throughout.
  assert.deepEqual((await post("/status")).body, { LEGACY: { state: "NONE" }, TARGET: { state: "NONE" } });
  assert.equal((await post("/capture", { role: "LEGACY", plan: plan(legacy.origin) })).body.code, "CAPTURE_AUTH_REQUIRED");

  assert.deepEqual((await post("/sign-in", { role: "LEGACY" })).body, { state: "PRESENT" });
  assert.deepEqual((await post("/status")).body, { LEGACY: { state: "PRESENT" }, TARGET: { state: "NONE" } });
  assert.equal((await post("/capture", { role: "TARGET", plan: plan(target.origin) })).body.code, "CAPTURE_AUTH_REQUIRED", "LEGACY's session is not TARGET's");

  // The store really does hold the secret, so the refusals below prove something.
  const sealed = await sudo("-u", BROKER, "cat", path.join(store, "LEGACY.json"));
  assert.ok(sealed.stdout.includes(CANARY));

  // What the agent's account can do on disk and to the process.
  const { stdout: pid } = await sudo("pgrep", "-u", BROKER, "-f", "session-broker.mjs");
  const brokerPid = pid.trim().split("\n")[0];
  for (const probe of [
    ["cat", path.join(store, "LEGACY.json")],
    ["ls", store],
    ["cat", `/proc/${brokerPid}/environ`],
    ["cat", `/proc/${brokerPid}/mem`],
    ["ls", `/proc/${brokerPid}/fd`],
    ["cat", path.join(root, "home/.config/google-chrome/Default/Cookies")],
  ]) {
    const result = await asAgent(...probe);
    assert.equal(result.ok, false, `the agent must not ${probe.join(" ")}`);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(CANARY));
  }

  // What the agent's account can do over the wire: the bounded capture, no secret.
  const captured = await post("/capture", { role: "LEGACY", plan: plan(legacy.origin) });
  assert.equal(captured.status, 200, captured.text);
  assert.ok(!captured.text.includes(CANARY), "no capture field may carry the session");
  assert.ok(new URL(captured.body.url).pathname === "/records");
  const client = await captureThroughBroker({ url: brokerUrl, token: TOKEN }, plan(legacy.origin));
  assert.equal(client.screenshot.subarray(1, 4).toString(), "PNG");
  assert.equal(client.capture.role, "LEGACY_AUTHORITY");
  assert.equal(client.account, undefined, "the broker's account is checked, not passed on as evidence");

  // Only a client holding the token may ask, whatever account it runs as.
  assert.equal((await post("/status", {}, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post("/status", {}, { authorization: "" })).status, 401);
  const agentAsks = await asAgent("curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", "content-type: application/json", "--data", "{}", `${brokerUrl}/status`);
  assert.equal(agentAsks.stdout, "401");

  // The test account's authority stays inside the operator's routes and writes nothing unless allowed.
  assert.equal((await post("/capture", { role: "LEGACY", plan: plan(legacy.origin, { route: "/admin" }) })).body.code, "CAPTURE_ORIGIN_VIOLATION");
  const destructive = await post("/capture", { role: "LEGACY", plan: plan(legacy.origin, { setup: [{ type: "click", target: "getByRole('button', { name: 'Delete all' })" }] }) });
  assert.equal(destructive.status, 200, destructive.text);
  assert.equal(destructive.body.operations.blockedWrites, 1);
  assert.equal(legacy.controls.writes, 0, "the application never received the write");
  const wandered = await post("/capture", { role: "LEGACY", plan: plan(legacy.origin, { setup: [{ type: "click", target: "getByRole('link', { name: 'Admin' })" }] }) });
  assert.equal(wandered.body.code, "CAPTURE_ORIGIN_VIOLATION", wandered.text);

  // TARGET goes through the same boundary with its own session and slot.
  assert.deepEqual((await post("/sign-in", { role: "TARGET" })).body, { state: "PRESENT" });
  const targetCapture = await captureThroughBroker({ url: brokerUrl, token: TOKEN }, plan(target.origin), "TARGET");
  assert.equal(targetCapture.capture.role, "TARGET_VERIFICATION");
  assert.equal((await post("/capture", { role: "TARGET", plan: plan(legacy.origin) })).body.code, "CAPTURE_ORIGIN_VIOLATION");

  // Everything a client might try instead.
  const asked = plan(legacy.origin);
  assert.equal((await post("/capture", { role: "LEGACY", plan: plan(target.origin) })).body.code, "CAPTURE_ORIGIN_VIOLATION");
  assert.equal((await post("/capture", { role: "LEGACY", plan: { ...asked, setup: [{ type: "evaluate", target: "document.cookie" }] } })).body.code, "CAPTURE_REQUEST_INVALID");
  assert.equal((await post("/capture", { role: "LEGACY", plan: { ...asked, route: "//elsewhere.invalid/" } })).body.code, "CAPTURE_REQUEST_INVALID");
  assert.equal((await post("/capture", { role: "ADMIN", plan: asked })).body.code, "BROKER_ROLE_UNKNOWN");
  assert.equal((await post("/session")).status, 404);
  assert.equal((await post("/status", {}, { origin: "https://evil.example" })).status, 403);
  const wrongHost = await new Promise((resolve) => {
    const request = http.request(brokerUrl, { method: "POST", path: "/status", headers: { host: "evil.example", "content-type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.end("{}");
  });
  assert.equal(wrongHost, 421);
  const plain = await fetch(`${brokerUrl}/status`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 403);
  // A session file named in the plan is dropped, so this reaches the stored session and no other.
  assert.equal((await post("/capture", { role: "LEGACY", plan: { ...asked, storageState: "/etc/passwd", browser: "msedge" } })).status, 200);
});

test("expiry is typed and one sign-in renews it", { skip: SKIP ?? false, timeout: 120_000 }, async () => {
  legacy.controls.maxAge = 1;
  assert.deepEqual((await post("/sign-in", { role: "LEGACY" })).body, { state: "PRESENT" });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.deepEqual((await post("/status")).body.LEGACY, { state: "EXPIRED" });
  assert.equal((await post("/capture", { role: "LEGACY", plan: plan(legacy.origin) })).body.code, "CAPTURE_SESSION_EXPIRED");

  legacy.controls.maxAge = 600;
  assert.deepEqual((await post("/sign-in", { role: "LEGACY" })).body, { state: "PRESENT" });
  assert.equal((await post("/capture", { role: "LEGACY", plan: plan(legacy.origin) })).status, 200);

  // Revoked by the application while the cookie still looks alive: only the browser can tell.
  legacy.controls.revoked = true;
  assert.deepEqual((await post("/status")).body.LEGACY, { state: "PRESENT" });
  const refused = await post("/capture", { role: "LEGACY", plan: plan(legacy.origin) });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "CAPTURE_SESSION_EXPIRED", refused.text);
  assert.ok(!refused.text.includes(CANARY));
  assert.deepEqual(stderr.filter((line) => line.includes(CANARY)), [], "not even the broker's own log");
});
