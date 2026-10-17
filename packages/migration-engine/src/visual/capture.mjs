/**
 * Visual: MC2 engine-native legacy-runtime capture. One bounded, validated
 * request drives a real browser; what comes back is observed, never authored:
 * the element screenshot, a `playwright-ui-proof/v1` snapshot (controls,
 * format-20 scroll metrics, an optional post-action observation) and, for an
 * authority frame, the `{viewport, values}` taxonomy read off the root
 * element's computed style.
 *
 * Nothing here writes a file, picks an outcome or decides acceptance: the
 * lifecycle persists, the existing validators decide. The only script the page
 * runs is the two probes below; a request carries locators and actions, never
 * code.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { UI_PROOF_FORMAT } from "../formats/index.mjs";
import { isPlainObject, sha256Hex } from "../shared/index.mjs";
import { LEGACY_AUTHORITY_ROLE } from "./authority.mjs";
import { decodePng, normalizeVisualValue, REQUIRED_FACT_KINDS, REQUIRED_FACT_NAMES } from "./evidence.mjs";
import { assertNoUiSecret, uiContractDigestOf } from "./proof.mjs";

// Resolved like pngjs and pixelmatch, and only when a capture runs: importing
// the engine never loads a browser driver.
const requireDriver = createRequire(new URL("../visual-evidence.mjs", import.meta.url));

export const refuseCapture = (code, message) => {
  throw Object.assign(new Error(`${code}: ${message} Nothing was written.`), { validationCode: code });
};

const invalid = (message) => refuseCapture("CAPTURE_REQUEST_INVALID", message);

const COMMON_KEYS = ["origin", "route", "viewport", "controls", "setup", "colorScheme", "matte", "browser", "storageState", "timeoutMs"];
const MODE_KEYS = { frame: ["uiBehaviorId", "state", "rootLocator", "counts"], claim: ["appearanceClaimId", "interaction"] };
const ACTIONS = new Set(["click", "fill", "press", "hover", "check", "uncheck", "select"]);
const VALUE_ACTIONS = new Set(["fill", "press", "select"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SECRET_PARAM = /(password|passwd|secret|token|cookie|authorization|credential|api[_-]?key|session)|(^|[_-])sig(nature)?$|^saml(request|response)?$/i;
// One-time codes and SSO assertions are credentials too (`/callback?code=...`):
// any whole word of the key, camelCase or snake_case. Fail-closed, so
// `zipCode` refuses as well; a single word such as `zipcode` does not.
// ponytail: a deny-list cannot be complete; the contract still forbids URL secrets.
const SECRET_WORDS = new Set(["code", "otp", "ticket", "jwt", "nonce", "assertion",
  "auth", "key", "pin", "pass", "sid", "sso", "saml", "hmac", "bearer"]);
const secretParam = (url) => [...url.searchParams.keys()].find((key) => SECRET_PARAM.test(key) ||
  key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/).some((word) => SECRET_WORDS.has(word)));

const text = (value, label, max = 500) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${label} must be a non-empty string of at most ${max} characters.`);
  return value;
};
const id = (value, label) => SAFE_ID.test(value ?? "") ? value : invalid(`${label} must match ${SAFE_ID}.`);
const list = (value, label, max) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be an array of at most ${max} entries.`);
  return value;
};
const action = (step, label) => {
  if (!isPlainObject(step) || Object.keys(step).some((key) => !["type", "target", "value"].includes(key))) invalid(`${label} must be {type, target, value?}.`);
  if (!ACTIONS.has(step.type)) invalid(`${label}.type must be one of ${[...ACTIONS].join(", ")}.`);
  text(step.target, `${label}.target`);
  if (VALUE_ACTIONS.has(step.type) !== (typeof step.value === "string")) {
    invalid(`${label}.value is ${VALUE_ACTIONS.has(step.type) ? "required" : "not allowed"} for '${step.type}'.`);
  }
  return { type: step.type, target: step.target, ...(step.value === undefined ? {} : { value: step.value }) };
};

/**
 * The capture plan, validated before any browser starts. Only explicit input is
 * accepted; the lifecycle derives the rest from the pinned records. A route is
 * a path on the authorized origin, so the request cannot point the browser
 * anywhere else.
 */
export const parseCaptureRequest = (request) => {
  if (!isPlainObject(request)) invalid("The request must be a JSON object.");
  const mode = request.appearanceClaimId !== undefined ? "claim" : "frame";
  const allowed = new Set([...COMMON_KEYS, ...MODE_KEYS[mode]]);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`Unsupported ${mode} request key(s): ${unknown.join(", ")}.`);
  let origin;
  try { origin = new URL(text(request.origin, "origin")); } catch (error) { if (error.validationCode) throw error; invalid(`origin '${request.origin}' is not a URL.`); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== request.origin) {
    invalid(`origin must be exactly an http(s) origin such as 'http://localhost:4200' (no path, query or credentials); got '${request.origin}'.`);
  }
  const route = text(request.route, "route", 2000);
  const url = new URL(route, origin);
  if (!route.startsWith("/") || route.startsWith("//") || url.origin !== origin.origin) invalid(`route must be a path on ${origin.origin}.`);
  const secret = secretParam(url);
  if (secret) invalid(`route carries the credential-like query parameter '${secret}'; use an authorized test session instead of a URL secret.`);
  const viewport = request.viewport;
  if (!isPlainObject(viewport) || Object.keys(viewport).length !== 2 ||
      !["width", "height"].every((axis) => Number.isInteger(viewport[axis]) && viewport[axis] > 0 && viewport[axis] <= 10000)) {
    invalid("viewport must be {width, height} positive integers.");
  }
  const controls = list(request.controls, "controls", 50).map((control, index) => {
    const at = `controls[${index}]`;
    if (!isPlainObject(control) || Object.keys(control).some((key) => !["role", "name", "locator"].includes(key))) invalid(`${at} must be {role, name, locator}.`);
    return { role: text(control.role, `${at}.role`, 64), name: text(control.name, `${at}.name`), locator: text(control.locator, `${at}.locator`) };
  });
  const colorScheme = request.colorScheme ?? "light";
  if (!["light", "dark", "no-preference"].includes(colorScheme)) invalid("colorScheme must be light, dark or no-preference.");
  const matte = request.matte ?? "#ffffff";
  if (!/^#[0-9a-f]{6}$/i.test(matte)) invalid("matte must be an opaque #RRGGBB color.");
  if (request.browser !== undefined && !["chromium", "chrome", "msedge"].includes(request.browser)) invalid("browser must be chromium, chrome or msedge.");
  if (request.storageState !== undefined && !path.isAbsolute(text(request.storageState, "storageState", 4096))) {
    invalid("storageState must be an absolute path to a Playwright storage-state file.");
  }
  const timeoutMs = request.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) invalid("timeoutMs must be an integer from 1000 to 120000.");
  const common = {
    mode, origin: origin.origin, url: url.href, route, viewport: { width: viewport.width, height: viewport.height },
    controls, setup: list(request.setup, "setup", 20).map((step, index) => action(step, `setup[${index}]`)),
    colorScheme, matte: matte.toLowerCase(), browser: request.browser, storageState: request.storageState, timeoutMs,
  };
  if (mode === "claim") {
    return { ...common, appearanceClaimId: id(request.appearanceClaimId, "appearanceClaimId"),
      interaction: request.interaction === undefined ? undefined : action(request.interaction, "interaction") };
  }
  const counts = request.counts ?? {};
  if (!isPlainObject(counts) || Object.keys(counts).length === 0 || Object.keys(counts).length > 10) {
    invalid("counts must name 1-10 structure counts as {name: locator}; the taxonomy's structure group needs at least one, and what a state counts is the record's business.");
  }
  for (const [name, locator] of Object.entries(counts)) {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(name) || REQUIRED_FACT_KINDS[name] !== undefined) invalid(`counts.${name} must be a camelCase name outside the taxonomy.`);
    text(locator, `counts.${name}`);
  }
  return { ...common, uiBehaviorId: id(request.uiBehaviorId, "uiBehaviorId"), state: id(request.state, "state"),
    rootLocator: text(request.rootLocator, "rootLocator"), counts };
};

const LOCATOR_CALL = /^(?:page\.)?getBy(Role|TestId|Text|Label|Placeholder|AltText|Title)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*(?:,\s*\{\s*(?:name\s*:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*,?\s*)?(?:exact\s*:\s*(true|false)\s*)?\}\s*)?\)$/;
const literal = (quoted) => quoted.slice(1, -1).replace(/\\(.)/g, "$1");

/**
 * The locators a migration record spells: a single `getByRole('button', {
 * name: 'Save' })`-style call, parsed (never evaluated), or a Playwright
 * selector string. The spelling persisted is always the request's own.
 */
export const parseLocator = (spec) => {
  const call = LOCATOR_CALL.exec(spec.trim());
  if (!call) return { selector: spec };
  const [, kind, first, name, exact] = call;
  if (name !== undefined && kind !== "Role") return { selector: spec };
  const options = { ...(name === undefined ? {} : { name: literal(name) }), ...(exact === undefined ? {} : { exact: exact === "true" }) };
  return { method: `getBy${kind}`, argument: literal(first), options };
};

const locate = (scope, spec) => {
  const parsed = parseLocator(spec);
  return parsed.method ? scope[parsed.method](parsed.argument, parsed.options) : scope.locator(parsed.selector);
};

/** Scroll metrics of the captured element, its ancestors and the document, in the format-20 shape. */
const SCROLL_PROBE = (element, rootLocator) => {
  const html = document.documentElement;
  const cssPath = (node) => {
    const parts = [];
    for (let at = node; at && at !== html; at = at.parentElement) {
      if (at.id && document.querySelectorAll(`#${CSS.escape(at.id)}`).length === 1) return [`#${CSS.escape(at.id)}`, ...parts].join(" > ");
      parts.unshift(at === document.body ? "body" : `${at.localName}:nth-child(${[...at.parentElement.children].indexOf(at) + 1})`);
    }
    return ["html", ...parts].join(" > ");
  };
  const overflowY = (node) => getComputedStyle(node).overflowY;
  const scrolls = (node) => ["auto", "scroll"].includes(overflowY(node)) && node.scrollHeight > node.clientHeight + 1;
  const measure = (node) => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, overflowY: overflowY(node) });
  const chain = [];
  for (let at = element.parentElement; at && at !== html; at = at.parentElement) chain.push(at);
  const owner = [element, ...chain].find(scrolls);
  const document_ = { clientHeight: html.clientHeight, scrollHeight: html.scrollHeight };
  const relevant = chain.filter((node) => overflowY(node) !== "visible");
  const parent = owner?.parentElement;
  if (parent && !relevant.includes(parent)) relevant.push(parent);
  const inner = [...element.querySelectorAll("*")].filter(scrolls).slice(0, 3);
  return {
    scroll: {
      document: document_,
      owner: owner
        ? { kind: "ELEMENT", locator: owner === element ? rootLocator : cssPath(owner), ...measure(owner) }
        : { kind: document_.scrollHeight > document_.clientHeight + 1 ? "DOCUMENT" : "NONE" },
      ancestors: relevant.map((node) => ({ locator: cssPath(node), ...measure(node) })),
    },
    // ponytail: the owner is read on the element and its ancestors only; a
    // scroll container inside the element is reported, never chosen for it.
    limitations: inner.length > 0
      ? [`scroll container(s) inside the captured element (${inner.map(cssPath).join("; ")}); the scroll owner was resolved on the element and its ancestors only`]
      : [],
  };
};

/** The taxonomy's raw computed values on the root element, plus its rendered asset identifiers. */
const MEASURE_PROBE = (element) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const sides = (prefix, suffix, names = ["Top", "Right", "Bottom", "Left"]) => names.map((side) => style[`${prefix}${side}${suffix}`]);
  const assets = [];
  let inlineSvg = 0;
  const urls = (value) => [...String(value).matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((match) => match[2]);
  for (const node of [element, ...element.querySelectorAll("*")]) {
    if (!node.checkVisibility()) continue;
    if (node instanceof HTMLImageElement) assets.push(node.currentSrc || node.src);
    if (node instanceof HTMLInputElement && node.type === "image") assets.push(node.src);
    if (node instanceof SVGUseElement || node instanceof SVGImageElement) assets.push(node.href.baseVal);
    if (node instanceof SVGSVGElement && !node.ownerSVGElement && !node.querySelector("use, image")) inlineSvg += 1;
    for (const pseudo of [null, "::before", "::after"]) {
      const computed = getComputedStyle(node, pseudo);
      if (pseudo && computed.content === "none") continue;
      assets.push(...urls(computed.backgroundImage));
    }
  }
  return {
    tagName: element.localName,
    width: rect.width,
    height: rect.height,
    padding: sides("padding", ""),
    gap: [style.rowGap, style.columnGap],
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    borderWidth: sides("border", "Width"),
    borderColor: sides("border", "Color"),
    borderRadius: sides("border", "Radius", ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]),
    boxShadow: style.boxShadow,
    opacity: style.opacity,
    visibility: style.visibility,
    assets: assets.filter(Boolean).map((raw) => {
      if (raw.startsWith("#")) return raw;
      const url = new URL(raw, document.baseURI);
      return url.protocol === "data:" ? url.href : `${url.origin === location.origin ? "" : url.origin}${url.pathname}${url.hash}`;
    }),
    inlineSvg,
  };
};

/**
 * Raw probe output into the version-2 `values`, pure so it is unit-tested.
 * Per-side longhands collapse only when every side agrees; otherwise the sides
 * stay spelled out and normalization refuses them, as the validator would.
 * No keyword is resolved (`gap: normal`, `line-height: normal`): the
 * normalizer refuses them on both sides, so the capture refuses rather than
 * guessing a number. Data URIs are identified by digest.
 */
export const taxonomyValues = (raw, counts) => {
  // Diagnostics only: the computed spelling of every value that is not a plain copy.
  const computed = {};
  const collapse = (name, sides) => {
    if (sides.every((side) => side === sides[0])) return sides[0];
    computed[name] = sides.join(" ");
    return computed[name];
  };
  const values = {
    width: raw.width,
    height: raw.height,
    padding: collapse("padding", raw.padding),
    gap: collapse("gap", raw.gap),
    color: raw.color,
    backgroundColor: raw.backgroundColor,
    fontFamily: raw.fontFamily,
    fontSize: raw.fontSize,
    fontWeight: raw.fontWeight,
    lineHeight: raw.lineHeight,
    borderWidth: collapse("borderWidth", raw.borderWidth),
    borderColor: collapse("borderColor", raw.borderColor),
    borderRadius: collapse("borderRadius", raw.borderRadius),
    boxShadow: raw.boxShadow,
    opacity: raw.opacity,
    visibility: raw.visibility,
    assets: [...new Set(raw.assets.map((asset) => (asset.startsWith("data:") ? `data:sha256:${sha256Hex(asset)}` : asset)))].sort(),
    ...counts,
  };
  const unsupported = Object.entries(values).flatMap(([name, value]) => {
    try {
      normalizeVisualValue(name, value);
      return [];
    } catch (error) {
      return [`${name} computed ${JSON.stringify(computed[name] ?? value)}: ${error.message.split(". ")[0]}`];
    }
  });
  const missing = REQUIRED_FACT_NAMES.filter((name) => values[name] === undefined);
  return {
    values,
    computed,
    unsupported: [...unsupported, ...missing.map((name) => `${name} was not measured`)],
    limitations: raw.inlineSvg > 0
      ? [`${raw.inlineSvg} inline <svg> element(s) inside the root carry no resolvable asset identifier, so the assets fact may omit them`]
      : [],
  };
};

const firstLine = (error) => String(error?.message ?? error).split("\n")[0];

const launch = async (chromium, channel) => {
  const tried = [];
  for (const candidate of channel ? [channel] : ["chromium", "chrome", "msedge"]) {
    try {
      return { browser: await chromium.launch({ headless: true, ...(candidate === "chromium" ? {} : { channel: candidate }) }), channel: candidate };
    } catch (error) {
      tried.push(`${candidate}: ${firstLine(error)}`);
    }
  }
  return refuseCapture("CAPTURE_BROWSER_UNAVAILABLE", `No Chromium-family browser could be launched (${tried.join("; ")}). The capture never installs one: install Playwright's Chromium (\`npx playwright-core@1.62.1 install chromium-headless-shell\`) or Google Chrome, or name an installed channel with "browser".`);
};

/**
 * Run one plan in a fresh, isolated browser context: the authorized session (if
 * any) is loaded from `storageState` and never read back; no cookie, storage
 * or header is observed. Main-frame navigation off the authorized origin is
 * aborted and refuses the capture. Every refusal names what was not reached;
 * a browser command that merely did not throw proves nothing on its own.
 */
export const captureInBrowser = async (plan) => {
  const started = Date.now();
  const { chromium } = requireDriver("playwright-core");
  const { browser, channel } = await launch(chromium, plan.browser);
  const operations = { navigations: 0, actions: 0, locatorQueries: 0, probes: 0, screenshots: 0 };
  try {
    const context = await browser.newContext({
      viewport: plan.viewport, deviceScaleFactor: 1, colorScheme: plan.colorScheme, reducedMotion: "reduce",
      serviceWorkers: "block", acceptDownloads: false, ...(plan.storageState ? { storageState: plan.storageState } : {}),
    });
    const page = await context.newPage();
    // A popup is never followed: only the authorized page is observed.
    context.on("page", (other) => other !== page && other.close().catch(() => undefined));
    page.setDefaultTimeout(plan.timeoutMs);
    const blocked = [];
    // Every top-level navigation off the origin is aborted, popups included;
    // one on the observed page refuses the capture.
    await context.route("**/*", (route) => {
      const request = route.request();
      const frame = request.isNavigationRequest() ? request.frame() : null;
      if (frame && !frame.parentFrame() && new URL(request.url()).origin !== plan.origin) {
        if (frame.page() === page) blocked.push(new URL(request.url()).origin);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const onOrigin = (label) => {
      const at = new URL(page.url()).origin;
      if (blocked.length > 0 || at !== plan.origin) {
        refuseCapture("CAPTURE_ORIGIN_VIOLATION", `${label} navigated to '${blocked[0] ?? at}', outside the authorized origin ${plan.origin}.`);
      }
    };
    const settle = async () => {
      await page.waitForLoadState("load");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
    };
    // Chrome turns a bodiless 4xx into a navigation error, the headless shell
    // into a response; either way the document's own status is what is reported.
    let status;
    page.on("response", (answer) => {
      if (answer.request().isNavigationRequest() && answer.frame() === page.mainFrame()) status = answer.status();
    });
    try {
      operations.navigations += 1;
      await page.goto(plan.url, { waitUntil: "load" });
    } catch (error) {
      if (blocked.length > 0) onOrigin(`'${plan.url}'`);
      if (!(status >= 400)) refuseCapture("CAPTURE_UNREACHABLE", `'${plan.url}' could not be loaded: ${firstLine(error)}. Start the legacy application at the authorized origin first.`);
    }
    if (!(status < 400)) refuseCapture("CAPTURE_UNREACHABLE", `'${plan.url}' answered HTTP ${status ?? "nothing"}.`);
    onOrigin(`'${plan.url}'`);
    await settle();
    const act = async (step, label) => {
      const target = locate(page, step.target);
      operations.actions += 1;
      try {
        if (step.type === "fill" && await target.evaluate((node) => node instanceof HTMLInputElement && node.type === "password")) {
          refuseCapture("CAPTURE_SECRET_INPUT", `${label} fills a password field; reach authenticated states through an authorized test session (storageState), never typed credentials.`);
        }
        if (step.type === "fill") await target.fill(step.value);
        else if (step.type === "press") await target.press(step.value);
        else if (step.type === "select") await target.selectOption(step.value);
        else await target[step.type]();
      } catch (error) {
        if (error.validationCode) throw error;
        if (blocked.length > 0) onOrigin(label);
        refuseCapture("CAPTURE_STATE_NOT_REACHED", `${label} ${step.type} '${step.target}' did not complete: ${firstLine(error)}.`);
      }
      await settle();
      onOrigin(label);
    };
    for (const [index, step] of plan.setup.entries()) await act(step, `setup[${index}]`);
    const observe = async (root) => {
      const controls = [];
      const issues = [];
      for (const control of plan.controls) {
        const located = locate(page, control.locator);
        operations.locatorQueries += 1;
        const count = await located.count();
        const base = { role: control.role, name: control.name, locator: control.locator, state: plan.state };
        if (count > 1) issues.push(`control ${control.role} '${control.name}' locator '${control.locator}' matches ${count} elements`);
        if (count !== 1) {
          if (count === 0) controls.push({ ...base, present: false, visible: false, count: 0 });
          continue;
        }
        // The browser's own accessibility computation, not the request, says what the element is.
        if (await located.and(page.getByRole(control.role, { name: control.name, exact: true, includeHidden: true })).count() !== 1) {
          issues.push(`control at '${control.locator}' does not expose role '${control.role}' with accessible name '${control.name}'`);
          continue;
        }
        const visible = await located.isVisible();
        const field = await located.evaluate((node) => ({
          input: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement,
          secret: node instanceof HTMLInputElement && node.type === "password",
        }));
        const shown = visible ? (await located.innerText()).trim() : "";
        controls.push({ ...base, present: true, visible, count: 1,
          ...(shown && shown.length <= 500 ? { text: shown } : {}),
          ...(field.input && !field.secret ? { value: await located.inputValue() } : {}) });
      }
      let scroll;
      let limitations = [];
      if (root) {
        operations.probes += 1;
        ({ scroll, limitations } = await root.evaluate(SCROLL_PROBE, plan.rootLocator));
      }
      return { observation: { url: page.url(), controls, ...(scroll ? { scroll } : {}) }, issues, limitations };
    };
    const issues = [];
    let before;
    if (plan.interaction) {
      before = await observe(null);
      issues.push(...before.issues);
      await act(plan.interaction.action, `interaction '${plan.interaction.id}'`);
    }
    const root = locate(page, plan.rootLocator);
    operations.locatorQueries += 1;
    try {
      await root.waitFor({ state: "visible" });
    } catch (error) {
      const count = await root.count().catch(() => 0);
      refuseCapture(count > 1 ? "CAPTURE_LOCATOR_AMBIGUOUS" : "CAPTURE_ELEMENT_MISSING",
        `${plan.mode === "claim" ? "Claim" : "Root"} locator '${plan.rootLocator}' ${count > 1 ? `matches ${count} elements` : "is not visible"} in state '${plan.state}'${plan.interaction ? ` after interaction '${plan.interaction.id}'` : ""}: ${firstLine(error)}.`);
    }
    const main = await observe(root);
    issues.push(...main.issues);
    if (issues.length > 0) refuseCapture("CAPTURE_OBSERVATION_FAILED", `${issues.join("; ")}.`);
    // The controls are what the state shows: one missing or hidden means the
    // state was not reached, however cleanly every step ran.
    const unseen = main.observation.controls.filter((control) => !control.visible);
    if (unseen.length > 0) {
      refuseCapture("CAPTURE_STATE_NOT_REACHED", `State '${plan.state}'${plan.interaction ? ` after interaction '${plan.interaction.id}'` : ""} does not show ${unseen.map((control) => `${control.role} '${control.name}' at '${control.locator}' (${control.present ? "hidden" : "absent"})`).join(", ")}.`);
    }
    // A claim row has no field the validator reads a limitation from, so a
    // scroll container inside the claim element is refused, never written away.
    if (plan.mode === "claim" && main.limitations.length > 0) {
      refuseCapture("CAPTURE_VALUE_UNSUPPORTED", `Claim locator '${plan.rootLocator}': ${main.limitations.join("; ")}. The format-20 scroll contract measures the claim element and its ancestors only; a LEGACY row would omit what was observed, so none is written.`);
    }
    onOrigin("the capture");
    operations.screenshots += 1;
    const screenshot = await root.screenshot({ animations: "disabled", caret: "hide", scale: "css", type: "png" });
    const { width, height } = decodePng(screenshot);
    const image = { width, height };
    let measured = null;
    if (plan.mode === "frame") {
      operations.probes += 1;
      const raw = await root.evaluate(MEASURE_PROBE);
      const counts = {};
      for (const [name, locator] of Object.entries(plan.counts)) {
        operations.locatorQueries += 1;
        counts[name] = await locate(root, locator).count();
      }
      measured = { ...taxonomyValues(raw, counts), tagName: raw.tagName };
      if (measured.unsupported.length > 0) {
        refuseCapture("CAPTURE_VALUE_UNSUPPORTED", `The root element's computed style cannot be expressed in the version-2 taxonomy: ${measured.unsupported.join("; ")}. The validator refuses these values too; no value is guessed. A state the contract cannot pin needs an operator VISUAL_UNBACKED decision.`);
      }
    }
    const snapshot = {
      proofFormat: UI_PROOF_FORMAT,
      uiBehaviorId: plan.uiBehaviorId,
      state: plan.state,
      // How the state was reached, values withheld: auditable, never replayable secrets.
      ...(plan.setup.length > 0 ? { setup: plan.setup.map(({ type, target }) => ({ type, target })) } : {}),
      observation: before ? before.observation : main.observation,
      interactions: before
        ? [{ id: plan.interaction.id, action: { type: plan.interaction.action.type, target: plan.interaction.action.target }, postAction: main.observation }]
        : [],
    };
    assertNoUiSecret(snapshot, "Captured snapshot");
    // Every URL the snapshot persists, the pre-action page included, and the final one.
    const secret = [snapshot.observation.url, ...snapshot.interactions.map((item) => item.postAction.url), page.url()]
      .map((url) => secretParam(new URL(url))).find(Boolean);
    if (secret) refuseCapture("CAPTURE_SECRET_URL", `A captured page URL carries the credential-like query parameter '${secret}'; capture from a sanitized test session.`);
    return {
      screenshot, image, snapshot, measured, operations,
      capture: captureBlock(plan, image),
      url: page.url(),
      executedAt: new Date(started).toISOString(),
      environment: `${channel === "chromium" ? "chromium" : channel} ${browser.version()}`,
      limitations: main.limitations,
      durationMs: Date.now() - started,
    };
  } finally {
    await browser.close();
  }
};

/**
 * One format-20 appearance claim as a plan. Behavior, state, locator, role and
 * name come from the pinned claim; the request adds only where the app runs and
 * how to drive the claim's interaction, which the inventory does not say.
 */
export const claimCapturePlan = (request, uiBehavior, claim) => {
  const own = { role: claim.role, name: claim.name, locator: claim.locator };
  return {
    ...request,
    uiBehaviorId: uiBehavior.id,
    state: claim.state,
    rootLocator: claim.locator,
    controls: [own, ...request.controls.filter((control) => control.locator !== claim.locator)],
    interaction: request.interaction && { id: claim.afterInteractionId, action: request.interaction },
  };
};

/** The `capture` block both legacy-runtime slots declare, from the decoded screenshot. */
const captureBlock = (plan, image) => ({
  role: LEGACY_AUTHORITY_ROLE,
  mode: "element",
  rootLocator: plan.rootLocator,
  deviceScaleFactor: 1,
  colorScheme: plan.colorScheme,
  reducedMotion: "reduce",
  matte: plan.matte,
  compare: { width: image.width, height: image.height },
  imageWidth: image.width,
  imageHeight: image.height,
});

/**
 * The format-20 LEGACY `uiEvidence` row for one appearance claim. Every binding
 * is the validator's own (`uiContractDigestOf`, the pinned revision); `result`
 * and each interaction's `actual`/`outcome` stay null -- observing the legacy
 * screen is not the agent's judgment that it shows what the claim says.
 */
export const legacyAppearanceRow = ({ state, sliceId, uiBehavior, mismatch, claim, plan, captured, files }) => ({
  provider: "playwright",
  origin: "LEGACY",
  producer: "artifact-migration-capture",
  environment: captured.environment,
  route: plan.route,
  viewport: plan.viewport,
  executedAt: captured.executedAt,
  result: null,
  uiBehaviorId: uiBehavior.id,
  state: claim.state,
  appearanceClaimId: claim.id,
  interactions: claim.afterInteractionId
    ? [{ id: claim.afterInteractionId, expected: uiBehavior.interactions.find((item) => item.id === claim.afterInteractionId).expected, actual: null, outcome: null }]
    : [],
  reference: files.snapshot.reference,
  hash: files.snapshot.hash,
  screenshot: { reference: files.screenshot.reference, hash: files.screenshot.hash },
  capture: captured.capture,
  boundTo: {
    target: state.targetModule,
    requirementsDigest: state.requirementsAuthority?.digest,
    dataSourceMode: state.dataSourceMode,
    sliceId,
    uiContractDigest: uiContractDigestOf(uiBehavior, mismatch),
    legacyRevision: state.legacyRevision?.revision,
  },
});
