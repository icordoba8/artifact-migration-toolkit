/**
 * Session broker. Run by the operator as a dedicated OS account the agent is
 * not, from the installed release (`session-broker.mjs <config.json>`); not a
 * package bin, and the migration CLI and MCP reach it only as clients.
 *
 * The account's private store is the boundary: it alone holds the LEGACY and
 * TARGET sessions, and no endpoint can return one. A client gets a status word,
 * a sign-in window on the operator's desktop, or what `captureInBrowser` already
 * reports: never a cookie, a stored value or a page body. Running this as the
 * agent's own account isolates nothing (docs/session-broker.md).
 *
 * `config.json`, owned by that account: {port, store, browser?, headless?,
 * applications: {LEGACY: {origin, signInRoute}, TARGET: {origin, signInRoute}}}.
 * `headless` exists for the automated test; a real sign-in needs a window.
 */
import { stat } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

import { assertPlainObject, isPlainObject } from "./shared/index.mjs";
import { atomicWrite, readJson, readOptionalJson } from "./store/index.mjs";
import { assertSessionUsable, AUTH_PATH, captureInBrowser, parseBrokeredPlan, refuseCapture } from "./visual/index.mjs";

const ROLES = ["LEGACY", "TARGET"];
const BODY_LIMIT = 1_048_576;
const SIGN_IN_TIMEOUT_MS = 300_000;

const sessionFile = (config, role) => path.join(config.store, `${role}.json`);

const applicationOf = (config, role) => {
  if (!ROLES.includes(role) || !config.applications[role]) refuseCapture("BROKER_ROLE_UNKNOWN", `No application is configured for role '${String(role)}'.`);
  return config.applications[role];
};

/** Present is the file's own claim; only a browser reaching the route proves a session still works. */
const sessionStatus = async (config, role) => {
  const document = await readOptionalJson(sessionFile(config, role), "Stored session");
  if (document === null) return { state: "NONE" };
  try {
    assertSessionUsable(document, applicationOf(config, role).origin);
    return { state: "PRESENT" };
  } catch (error) {
    if (error.validationCode === "CAPTURE_SESSION_EXPIRED") return { state: "EXPIRED" };
    if (error.validationCode === "CAPTURE_SESSION_HOST") return { state: "NONE" };
    throw error;
  }
};

const capture = async (config, { role, plan }) => {
  const application = applicationOf(config, role);
  const checked = parseBrokeredPlan(plan);
  if (checked.origin !== application.origin) refuseCapture("CAPTURE_ORIGIN_VIOLATION", `Role ${role} is served at ${application.origin}, not ${checked.origin}.`);
  const { state } = await sessionStatus(config, role);
  if (state === "NONE") refuseCapture("CAPTURE_AUTH_REQUIRED", `No session is stored for ${role}; the operator signs in through the broker once.`);
  if (state === "EXPIRED") refuseCapture("CAPTURE_SESSION_EXPIRED", `The stored ${role} session has expired; the operator signs in through the broker again.`);
  const { screenshot, image, ...report } = await captureInBrowser({ ...checked, storageState: sessionFile(config, role), browser: config.browser });
  return { ...report, image: { width: image.width, height: image.height }, screenshot: screenshot.toString("base64") };
};

const signingIn = new Set();

/** First sign-in and renewal are one path: the operator types into a browser only this account can reach. */
const signIn = async (config, { role }) => {
  const { origin, signInRoute } = applicationOf(config, role);
  if (signingIn.has(role)) refuseCapture("BROKER_BUSY", `A ${role} sign-in is already open.`);
  signingIn.add(role);
  let browser;
  try {
    const { chromium } = createRequire(import.meta.url)("playwright-core");
    browser = await chromium.launch({ headless: config.headless === true, ...(config.browser ? { channel: config.browser } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(new URL(signInRoute, origin).href);
    // Leaving the sign-in page on this origin is the only proof: its pre-auth cookies are not a session.
    await page.waitForURL((url) => url.origin === origin && url.pathname !== signInRoute && !AUTH_PATH.test(url.pathname), { timeout: SIGN_IN_TIMEOUT_MS });
    await atomicWrite(config.store, sessionFile(config, role), JSON.stringify(await context.storageState()));
    return sessionStatus(config, role);
  } finally {
    signingIn.delete(role);
    await browser?.close();
  }
};

const status = async (config) => Object.fromEntries(await Promise.all(
  ROLES.filter((role) => config.applications[role]).map(async (role) => [role, await sessionStatus(config, role)]),
));

const ROUTES = { "/status": status, "/capture": capture, "/sign-in": signIn };

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > BODY_LIMIT) { reject(Object.assign(new Error("Request too large."), { validationCode: "BROKER_REQUEST_INVALID" })); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
});

const serveBroker = async (config) => {
  const host = `127.0.0.1:${config.port}`;
  const server = http.createServer(async (request, response) => {
    const send = (code, body) => {
      response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    // A web page cannot pass these three: this is not an API for browsers.
    if (request.headers.host !== host) return send(421, { code: "WRONG_HOST" });
    if (request.headers.origin !== undefined || !/^application\/json\b/.test(request.headers["content-type"] ?? "")) return send(403, { code: "BROKER_REQUEST_REFUSED" });
    const route = request.method === "POST" ? ROUTES[request.url] : undefined;
    if (!route) return send(404, { code: "BROKER_ROUTE_UNKNOWN" });
    try {
      const body = JSON.parse((await readBody(request)) || "{}");
      if (!isPlainObject(body)) refuseCapture("BROKER_REQUEST_INVALID", "The request must be a JSON object.");
      return send(200, await route(config, body));
    } catch (error) {
      if (error.validationCode) return send(422, { code: error.validationCode, message: error.message });
      // An unexpected fault stays here: its text may quote anything the browser saw.
      process.stderr.write(`session broker: ${error.stack ?? error}\n`);
      return send(500, { code: "BROKER_FAILED" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  return server;
};

export const readBrokerConfig = async (file) => {
  const config = assertPlainObject(await readJson(file, "Session broker configuration"), "Session broker configuration");
  if (!Number.isInteger(config.port) || typeof config.store !== "string" || !path.isAbsolute(config.store) || !isPlainObject(config.applications)) {
    throw new Error("The broker configuration must be {port, store (absolute), applications}.");
  }
  for (const [role, application] of Object.entries(config.applications)) {
    if (!ROLES.includes(role) || !isPlainObject(application) || new URL(application.origin).origin !== application.origin || !application.signInRoute?.startsWith("/")) {
      throw new Error(`applications.${role} must be {origin, signInRoute}.`);
    }
  }
  // shortcut: Windows ACLs are not read here; docs/session-broker.md sets and verifies them, read them here if that step proves skippable.
  if (process.platform !== "win32") {
    const { mode, uid } = await stat(config.store);
    if ((mode & 0o077) !== 0 || uid !== process.getuid()) throw new Error(`The store '${config.store}' must be mode 0700 and owned by this account.`);
  }
  return config;
};

export const runSessionBroker = async ([file]) => {
  if (!file) throw new Error("Usage: session-broker.mjs <config.json>");
  const config = await readBrokerConfig(file);
  await serveBroker(config);
  process.stdout.write(`session broker listening on 127.0.0.1:${config.port}\n`);
};
