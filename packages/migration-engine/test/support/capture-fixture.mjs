// MC2: a disposable legacy application for the real-browser capture suites.
// A local HTTP server on 127.0.0.1 with fixed pages; nothing reaches a network.

import http from "node:http";

/**
 * Why the browser suites skip, or null when a Chromium-family browser
 * launches. `ARTIFACT_MIGRATION_BROWSER_GATE=1` turns a missing browser into a
 * failure, so a gate that must prove real capture cannot pass by skipping.
 */
export const CAPTURE_BROWSER_SKIP = await (async () => {
  const { chromium } = await import("playwright-core");
  for (const channel of [undefined, "chrome", "msedge"]) {
    try {
      await (await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })).close();
      return null;
    } catch {
      // try the next installed channel
    }
  }
  if (process.env.ARTIFACT_MIGRATION_BROWSER_GATE === "1") {
    throw new Error("ARTIFACT_MIGRATION_BROWSER_GATE=1, but no Chromium-family browser launches.");
  }
  return "no Chromium-family browser is installed; set ARTIFACT_MIGRATION_BROWSER_GATE=1 to require one";
})();

const ROWS = Array.from({ length: 4 }, (_, index) => `<div class="row" role="row" aria-label="Session ${index}">Session ${index}</div>`).join("");

const page = ({ mainStyle = "", extra = "" } = {}) => `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title><style>
body{margin:0;font-family:Arial, sans-serif;background:#ffffff}
.shell{height:240px;overflow-y:auto}
main{display:flex;flex-direction:column;padding:16px;gap:12px;color:rgb(22,32,44);background:#ffffff;border:1px solid rgb(217,225,234);border-radius:4px;font-size:14px;line-height:20px;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.2);${mainStyle}}
.row{height:32px}
[role=menu]{margin:0;padding:8px;border:1px solid rgb(217,225,234)}
</style></head><body><div class="shell"><main aria-label="Sign in">
<img src="/logo.svg?v=1" alt="" width="12" height="12">
<button type="button" onclick="document.getElementById('signed').hidden=false">Sign in</button>
<button type="button" id="more" onclick="document.getElementById('menu').hidden=false">More</button>
<ul id="menu" role="menu" aria-label="Account" hidden><li role="menuitem">Sign out</li></ul>
<p id="signed" role="status" aria-label="Signed in" hidden>Signed in</p>
${ROWS}${extra}
</main></div><a id="away" href="http://capture-elsewhere.invalid/">Elsewhere</a>
<label>Password <input id="pw" type="password"></label></body></html>`;

const PAGES = {
  "/auth/sign-in": page(),
  "/degraded": page({ extra: '<svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4"/></svg>' }),
  "/line-height": page({ mainStyle: "line-height:normal" }),
};

/** The session the private page needs, as a Playwright storageState names it. */
export const CAPTURE_SESSION = { cookie: "SECRET-COOKIE-VALUE", local: "SECRET-LOCAL-VALUE" };

export const startCaptureServer = async () => {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://127.0.0.1");
    if (pathname === "/logo.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#0b5fff"/></svg>');
    }
    if (pathname === "/private") {
      if (!(request.headers.cookie ?? "").includes(`session=${CAPTURE_SESSION.cookie}`)) {
        response.writeHead(401);
        return response.end();
      }
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(PAGES["/auth/sign-in"]);
    }
    if (!PAGES[pathname]) {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(200, { "content-type": "text/html" });
    return response.end(PAGES[pathname]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    storageState: () => ({
      cookies: [{ name: "session", value: CAPTURE_SESSION.cookie, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [{ origin, localStorage: [{ name: "token", value: CAPTURE_SESSION.local }] }],
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

/** A closed port on this host: what an application that is not running looks like. */
export const unusedOrigin = async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
};
