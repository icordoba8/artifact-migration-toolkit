/**
 * Unit tests for the discovery scan.
 *
 * Each test is one way a file used to be able to disappear from a migration.
 * Real `git init` fixtures and the real TypeScript compiler; nothing here reads
 * application source or an application's installed dependencies.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CENSUS_ALGORITHM_VERSION,
  discoveryDigest,
  kindOf,
  loadTypeScript,
  PRODUCTION_REACHABILITY,
  runDiscoveryScan,
  structuralUnits,
  VISUAL_KINDS,
} from "../../src/discovery-scan.mjs";

const execFileAsync = promisify(execFile);

/**
 * Resolution semantics are the whole point, so a stubbed resolver would test
 * nothing: these fixtures need the real compiler discovery actually ships
 * with -- its own pinned classic-API build, not whatever a legacy project
 * happens to have installed (which may be a version, like TypeScript 7, whose
 * classic API no longer exists). It is a root devDependency for exactly that
 * reason, so `pnpm install` at the root -- the only install a clean CI runner
 * does -- provides it, and a bare import fails the suite rather than
 * borrowing a `node_modules` overlay a clean checkout does not have.
 */
const typescript = createRequire(import.meta.url)("ts-discovery-compiler");

const fixture = async (files, { tsconfig } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-scan-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  if (!("package.json" in files)) {
    await writeFile(
      path.join(root, "package.json"),
      '{"name":"scan-fixture","private":true}\n',
    );
  }
  if (tsconfig !== undefined) {
    await writeFile(
      path.join(root, "tsconfig.json"),
      `${JSON.stringify(tsconfig, null, 2)}\n`,
    );
  }
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Scan Test", "-c", "user.email=scan@test", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const scan = (root, moduleRoots, declaredEntryPoints = []) =>
  runDiscoveryScan({ legacyRoot: root, moduleRoots, declaredEntryPoints, typescript });

const scanVersion = (
  root,
  moduleRoots,
  algorithmVersion,
  { declaredEntryPoints = [], moduleEdgeTargets = {} } = {},
) =>
  runDiscoveryScan({
    legacyRoot: root,
    moduleRoots,
    declaredEntryPoints,
    moduleEdgeTargets,
    algorithmVersion,
    typescript,
  });

const ALIASED = {
  compilerOptions: {
    paths: { "@features/*": ["./src/features/*"] },
    jsx: "react-jsx",
    module: "esnext",
    moduleResolution: "bundler",
  },
};

// --- A. the census, which no graph shape can shrink -------------------------

test("a file with no imports and no importers is still in the census", async () => {
  const f = await fixture({
    "src/features/auth/orphan.tsx": "export const Orphan = () => null;\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    assert.deepEqual(result.census, ["src/features/auth/orphan.tsx"]);
    assert.equal(result.reachability["src/features/auth/orphan.tsx"], "UNREACHABLE");
  } finally {
    await f.cleanup();
  }
});

test("a for-statement with an omitted initializer does not crash write-tracking", async () => {
  const f = await fixture({
    "src/features/auth/index.ts":
      "let i = 0;\n" +
      "for (; i < 3; i++) { let x = 0; x = i; }\n" +
      "export const n = i;\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    assert.ok(result.census.includes("src/features/auth/index.ts"));
  } finally {
    await f.cleanup();
  }
});

test("the census includes untracked-but-unignored files and excludes ignored ones", async () => {
  const f = await fixture({
    ".gitignore": "src/features/auth/ignored.ts\nnode_modules/\n",
    "src/features/auth/committed.ts": "export const a = 1;\n",
  });
  try {
    await writeFile(path.join(f.root, "src/features/auth/added.ts"), "export const b = 2;\n");
    await writeFile(path.join(f.root, "src/features/auth/ignored.ts"), "export const c = 3;\n");
    await mkdir(path.join(f.root, "src/features/auth/node_modules"), { recursive: true });
    await writeFile(
      path.join(f.root, "src/features/auth/node_modules/dep.ts"),
      "export const d = 4;\n",
    );
    const result = await scan(f.root, ["src/features/auth"]);
    assert.deepEqual(result.census, [
      "src/features/auth/added.ts",
      "src/features/auth/committed.ts",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a symlink under an owned root is rejected, not followed", async () => {
  const f = await fixture({
    "src/features/auth/real.ts": "export const a = 1;\n",
    "outside/secret.ts": "export const b = 2;\n",
  });
  try {
    try {
      await symlink(
        path.join(f.root, "outside/secret.ts"),
        path.join(f.root, "src/features/auth/link.ts"),
      );
    } catch {
      return; // Unprivileged Windows cannot create symlinks; nothing to assert.
    }
    await execFileAsync("git", ["add", "-A"], { cwd: f.root });
    await assert.rejects(scan(f.root, ["src/features/auth"]), /symbolic link/);
  } finally {
    await f.cleanup();
  }
});

// --- B. the graph, which annotates the census -------------------------------

test("alias -> barrel -> component resolves, so a decorative leaf is reachable", async () => {
  const f = await fixture(
    {
      "src/app/(auth)/login/page.tsx":
        "import { LoginForm } from '@features/auth/components/login';\nexport default () => <LoginForm />;\n",
      "src/features/auth/components/login/index.ts":
        "export { LoginForm } from './login-form';\n",
      "src/features/auth/components/login/login-form.tsx":
        "import { Background } from '@features/auth/components/login/background';\nexport const LoginForm = () => <Background />;\n",
      "src/features/auth/components/login/background.tsx":
        "export const Background = () => <div />;\n",
    },
    { tsconfig: ALIASED },
  );
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    const background = "src/features/auth/components/login/background.tsx";
    assert.ok(result.census.includes(background));
    assert.equal(result.reachability[background], "REACHABLE_FROM_ENTRY");
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.from === "src/features/auth/components/login/login-form.tsx" &&
          edge.to === background,
      ),
    );
    // `export ... from` is a re-export edge, not an import.
    assert.ok(result.edges.some((edge) => edge.kind === "REEXPORT"));
  } finally {
    await f.cleanup();
  }
});

test("literal dynamic import and require traverse; a non-literal one blocks", async () => {
  const f = await fixture({
    "src/features/auth/index.ts":
      "export const load = (name: string) => import(`./${name}`);\n" +
      "export const eager = () => import('./eager');\n" +
      "export const legacy = () => require('./cjs');\n",
    "src/features/auth/eager.ts": "export const a = 1;\n",
    "src/features/auth/cjs.ts": "export const b = 2;\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    assert.ok(result.edges.some((edge) => edge.kind === "DYNAMIC" && edge.to === "src/features/auth/eager.ts"));
    assert.ok(result.edges.some((edge) => edge.kind === "REQUIRE" && edge.to === "src/features/auth/cjs.ts"));
    assert.equal(result.findings.filter((x) => x.type === "DYNAMIC_NONLITERAL").length, 1);
  } finally {
    await f.cleanup();
  }
});

test("import.meta.url creates a module-resource edge and requires targets for a non-literal", async () => {
  const f = await fixture({
    "src/features/auth/logo.ts":
      "export const logo = new URL('./logo.svg', import.meta.url);\n" +
      "export const other = (name) => new URL(name, import.meta.url);\n",
    "src/features/auth/logo.svg": "<svg/>\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.kind === "MODULE_RESOURCE" &&
          edge.to === "src/features/auth/logo.svg",
      ),
    );
    assert.equal(
      result.findings.filter((x) => x.type === "MODULE_RESOURCE_NONLITERAL")
        .length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("a root-relative URL is a route, not an unresolved module reference", async () => {
  const f = await fixture({
    "src/features/auth/guard.ts":
      "export const redirect = (request) => new URL('/login', request.url);\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    // `/login` is a route the server resolves; blocking on it would make the
    // checkpoint unpassable for every real Next.js project.
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.findings, []);
  } finally {
    await f.cleanup();
  }
});

test("a finding outside the module and its closure is not the module's problem", async () => {
  const f = await fixture({
    "src/app/unrelated/page.tsx":
      "import { useTranslation } from 'react-i18next';\nexport default () => useTranslation('other');\n",
    "src/app/(auth)/login/page.tsx":
      "import { useTranslation } from 'react-i18next';\nimport { Form } from '../../../features/auth/form';\nexport default () => { useTranslation('auth'); return <Form />; };\n",
    "src/features/auth/form.tsx": "export const Form = () => <div />;\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    const files = result.findings.map((finding) => finding.file);
    assert.ok(files.includes("src/app/(auth)/login/page.tsx"), "an inbound referrer's edges count");
    assert.ok(!files.includes("src/app/unrelated/page.tsx"), "an unrelated route's edges do not");
  } finally {
    await f.cleanup();
  }
});

test("CSS @import and url() are traversed; assets are entered, not parsed", async () => {
  const f = await fixture({
    "src/features/auth/theme.css": "@import './base.css';\n.a { background: url('./bg.png'); }\n",
    "src/features/auth/base.css": ".b { color: red; }\n",
    "src/features/auth/bg.png": "png\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.kind === "CSS_IMPORT" &&
          edge.to === "src/features/auth/base.css" &&
          edge.line === 1,
      ),
    );
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.kind === "CSS_URL" &&
          edge.to === "src/features/auth/bg.png" &&
          edge.line === 2,
      ),
    );
    assert.equal(result.kinds["src/features/auth/bg.png"], "ASSET");
    assert.equal(result.kinds["src/features/auth/theme.css"], "STYLE");
  } finally {
    await f.cleanup();
  }
});

test("an i18n namespace is a finding and a bare package is EXTERNAL", async () => {
  const f = await fixture({
    "src/features/auth/useAuth.ts":
      "import { useTranslation } from 'react-i18next';\n" +
      "export const useAuth = () => useTranslation('auth');\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    assert.equal(result.findings.filter((x) => x.type === "I18N_NAMESPACE" && x.spec === "auth").length, 1);
    assert.ok(result.external.includes("react-i18next"));
    assert.ok(!result.edges.some((edge) => edge.spec === "react-i18next"));
  } finally {
    await f.cleanup();
  }
});

// --- C. the inbound scan and framework conventions --------------------------

test("an undeclared file that imports into the roots becomes an entry point", async () => {
  const f = await fixture({
    "src/shared/actions/navigation.ts": "import { signOut } from '../../features/auth/api';\nexport { signOut };\n",
    "src/features/auth/api.ts": "export const signOut = () => null;\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    const entry = result.entryPoints.find((e) => e.path === "src/shared/actions/navigation.ts");
    assert.ok(entry, "the inbound referrer is promoted to an entry point");
    assert.equal(entry.discovery, "INBOUND");
    assert.equal(result.reachability["src/features/auth/api.ts"], "REACHABLE_INBOUND_ONLY");
  } finally {
    await f.cleanup();
  }
});

test("relevant or declared Next.js conventions govern the module boundary", async () => {
  const f = await fixture(
    {
      "src/app/(auth)/login/page.tsx":
        "import { Form } from '@features/auth/form';\nexport default () => <Form />;\n",
      "src/app/layout.tsx": "export default ({ children }) => children;\n",
      "src/app/api/session/route.ts": "export const GET = () => null;\n",
      "src/proxy.ts": "export const proxy = () => null;\n",
      "src/features/auth/form.tsx": "export const Form = () => <div />;\n",
    },
    { tsconfig: ALIASED },
  );
  try {
    // The roles page reaches the module and proxy.ts is explicit. Unrelated
    // framework files remain outside this module's boundary.
    const result = await scan(f.root, ["src/features/auth"], ["src/proxy.ts"]);
    const discovered = new Map(result.entryPoints.map((e) => [e.path, e.discovery]));
    for (const file of ["src/app/(auth)/login/page.tsx", "src/proxy.ts"]) {
      assert.equal(discovered.get(file), "FRAMEWORK", `${file} is a framework entry point`);
    }
    assert.equal(discovered.has("src/app/layout.tsx"), false);
    assert.equal(discovered.has("src/app/api/session/route.ts"), false);
    assert.equal(result.reachability["src/features/auth/form.tsx"], "REACHABLE_FROM_ENTRY");
  } finally {
    await f.cleanup();
  }
});

test("a declared framework module edge needs concrete targets before it is production-reachable", async () => {
  // The defect: a route is positively discovered as a FRAMEWORK entry point,
  // but its only edge is non-literal, so it can never gain the resolved inbound
  // edge the relevance filter was built from. The finding was discarded and the
  // component it loads stayed UNREACHABLE -- free to be dismissed as having no
  // observable behavior.
  const background = "src/features/auth/background.tsx";
  const files = {
    "src/app/login/page.tsx":
      "export default ({ target }) => import(target);\n",
    "src/app/api/asset/route.ts":
      "export const GET = (name) => new URL(name, import.meta.url);\n",
    "src/app/unrelated/page.tsx":
      "import { helper } from '../../shared/helper';\nexport default () => helper();\n",
    "src/shared/helper.ts": "export const helper = () => null;\n",
    [background]: "export const Background = () => <div />;\n",
  };
  const f = await fixture(files, { tsconfig: ALIASED });
  try {
    const declaredEntryPoints = [
      "src/app/login/page.tsx",
      "src/app/api/asset/route.ts",
    ];
    const before = await scan(
      f.root,
      ["src/features/auth"],
      declaredEntryPoints,
    );
    const byFile = new Map(before.findings.map((x) => [x.file, x.type]));
    assert.equal(byFile.get("src/app/login/page.tsx"), "DYNAMIC_NONLITERAL");
    assert.equal(
      byFile.get("src/app/api/asset/route.ts"),
      "MODULE_RESOURCE_NONLITERAL",
    );
    // Module scope is preserved: the unrelated route resolves everything it
    // references and never touches the module, so it stays out.
    assert.ok(!byFile.has("src/app/unrelated/page.tsx"));
    assert.equal(before.reachability[background], "UNREACHABLE");

    const targets = Object.fromEntries(
      before.findings.map((finding) => [finding.id, [background]]),
    );
    const after = await scanVersion(
      f.root,
      ["src/features/auth"],
      CENSUS_ALGORITHM_VERSION,
      { declaredEntryPoints, moduleEdgeTargets: targets },
    );
    assert.equal(after.reachability[background], "REACHABLE_FROM_ENTRY");
    assert.ok(PRODUCTION_REACHABILITY.has(after.reachability[background]));
    assert.ok(VISUAL_KINDS.has(after.kinds[background]));
    // The findings remain visible for operator approval, but prose alone did
    // not resolve either edge: each now carries a concrete tracked target.
    assert.equal(after.findings.length, 2);
    assert.ok(
      after.findings.every(
        (finding) => finding.resolvedTargets?.[0] === background,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("the module's out-closure is SUPPORTING with a requiredBy map", async () => {
  const f = await fixture({
    "src/features/auth/service.ts": "import { format } from '../../shared/format';\nexport const s = format;\n",
    "src/shared/format.ts": "export const format = (x) => x;\n",
  });
  try {
    const result = await scan(f.root, ["src/features/auth"]);
    assert.deepEqual(result.supporting, ["src/shared/format.ts"]);
    assert.deepEqual(result.requiredBy["src/shared/format.ts"], ["src/features/auth/service.ts"]);
  } finally {
    await f.cleanup();
  }
});

// --- the digest -------------------------------------------------------------

test("a tsconfig paths edit changes the digest; reordering files does not", async () => {
  const files = {
    "src/features/auth/a.ts": "export const a = 1;\n",
    "src/features/auth/b.ts": "export const b = 2;\n",
  };
  const first = await fixture(files, { tsconfig: ALIASED });
  const same = await fixture(
    { "src/features/auth/b.ts": files["src/features/auth/b.ts"], "src/features/auth/a.ts": files["src/features/auth/a.ts"] },
    { tsconfig: ALIASED },
  );
  const edited = await fixture(files, {
    tsconfig: { compilerOptions: { ...ALIASED.compilerOptions, paths: { "@f/*": ["./src/features/*"] } } },
  });
  try {
    const a = await scan(first.root, ["src/features/auth"]);
    const b = await scan(same.root, ["src/features/auth"]);
    const c = await scan(edited.root, ["src/features/auth"]);
    assert.equal(a.discoveryDigest, b.discoveryDigest);
    assert.notEqual(a.discoveryDigest, c.discoveryDigest);
    assert.equal(a.discoveryDigest, discoveryDigest(a));
    assert.equal(a.algorithmVersion, CENSUS_ALGORITHM_VERSION);
  } finally {
    await Promise.all([first.cleanup(), same.cleanup(), edited.cleanup()]);
  }
});

test("adding a census file changes the digest", async () => {
  const f = await fixture({ "src/features/auth/a.ts": "export const a = 1;\n" });
  try {
    const before = await scan(f.root, ["src/features/auth"]);
    await writeFile(path.join(f.root, "src/features/auth/extra.ts"), "export const e = 1;\n");
    const after = await scan(f.root, ["src/features/auth"]);
    assert.notEqual(before.discoveryDigest, after.discoveryDigest);
    assert.ok(after.census.includes("src/features/auth/extra.ts"));
  } finally {
    await f.cleanup();
  }
});

// --- inputs and failure modes ----------------------------------------------

test("a legacy project with no compiler installed at all still discovers, using this skill's own compiler", async () => {
  // Discovery no longer depends on the legacy project's own toolchain state --
  // this used to be the missing-compiler failure case; now it is exactly the
  // scenario the pinned discovery compiler exists to cover.
  const f = await fixture({ "src/features/auth/a.ts": "export const a = 1;\n" });
  try {
    const result = await runDiscoveryScan({
      legacyRoot: f.root,
      moduleRoots: ["src/features/auth"],
    });
    assert.deepEqual(result.census, ["src/features/auth/a.ts"]);
    assert.equal(result.resolution.typescriptVersion, "5.9.3");
  } finally {
    await f.cleanup();
  }
});

test("a module with nothing parseable never needs a compiler at all", async () => {
  const f = await fixture({ "src/features/auth/notes.md": "# notes\n" });
  try {
    const result = await runDiscoveryScan({
      legacyRoot: f.root,
      moduleRoots: ["src/features/auth"],
    });
    assert.deepEqual(result.census, ["src/features/auth/notes.md"]);
    assert.equal(result.resolution.typescriptVersion, null);
  } finally {
    await f.cleanup();
  }
});

test("scanning refuses without a declared module root, and rejects escaping roots", async () => {
  const f = await fixture({ "src/features/auth/a.ts": "export const a = 1;\n" });
  try {
    await assert.rejects(scan(f.root, []), /at least one declared module root/);
    await assert.rejects(scan(f.root, ["../elsewhere"]), /must not escape the legacy root/);
    await assert.rejects(scan(f.root, [path.resolve(f.root)]), /legacy-relative/);
    await assert.rejects(
      scan(f.root, ["src/features/auth"], ["src/does-not-exist.ts"]),
      /not a tracked file/,
    );
  } finally {
    await f.cleanup();
  }
});

test("the visual safeguard's inputs classify the files a user can see", () => {
  assert.equal(kindOf("a/background.tsx"), "COMPONENT");
  assert.equal(kindOf("a/theme.css"), "STYLE");
  assert.equal(kindOf("a/logo.svg"), "ASSET");
  assert.equal(kindOf("a/util.ts"), "MODULE");
  for (const kind of ["COMPONENT", "STYLE", "ASSET"]) assert.ok(VISUAL_KINDS.has(kind));
  assert.ok(PRODUCTION_REACHABILITY.has("REACHABLE_FROM_ENTRY"));
  assert.ok(PRODUCTION_REACHABILITY.has("REACHABLE_INBOUND_ONLY"));
  assert.ok(!PRODUCTION_REACHABILITY.has("REACHABLE_TEST_ONLY"));
  assert.ok(!PRODUCTION_REACHABILITY.has("UNREACHABLE"));
});

test("loadTypeScript resolves this skill's own pinned discovery compiler", async () => {
  const loaded = loadTypeScript();
  assert.equal(loaded.version, typescript.version);
  // Pinned to the last classic-API release: TypeScript's published version
  // line goes straight from 5.9.x to 7.x, so this is also the newest classic
  // build available -- if this ever drifts, it must drift on purpose.
  assert.equal(loaded.version, "5.9.3");
});

// --- a legacy project on TypeScript 7 still discovers correctly ------------

const TS7_LEGACY_COMPILER_STUB = {
  "node_modules/typescript/package.json":
    '{"name":"typescript","version":"7.0.2","main":"./lib/version.cjs"}\n',
  // Mirrors the real typescript@7.0.2 default export exactly: a version stamp
  // only, no `sys` / `createSourceFile` / `findConfigFile`. If loadTypeScript
  // ever regresses to resolving the *legacy* project's own compiler, requiring
  // this stub crashes discovery instead of silently reusing it.
  "node_modules/typescript/lib/version.cjs":
    'exports.version = "7.0.2";\nexports.versionMajorMinor = "7.0";\n',
};

test("a legacy project pinned to TypeScript 7 still discovers correctly, without loading that project's own compiler", async () => {
  const f = await fixture(
    {
      ...TS7_LEGACY_COMPILER_STUB,
      "package.json":
        '{"name":"legacy-ts7","private":true,"devDependencies":{"typescript":"^7.0.2"}}\n',
      "src/app/(auth)/login/page.tsx":
        "import { LoginForm } from '@features/auth/components/login';\nexport default () => <LoginForm />;\n",
      "src/features/auth/components/login/index.ts":
        "export { LoginForm } from './login-form';\n",
      "src/features/auth/components/login/login-form.tsx":
        "import { Background } from '@features/auth/components/login/background';\nexport const LoginForm = () => <Background />;\n",
      "src/features/auth/components/login/background.tsx":
        "export const Background = () => <div />;\n",
      "src/features/auth/dynamic.ts":
        "export const load = (name: string) => import(`./${name}`);\n",
    },
    { tsconfig: ALIASED },
  );
  try {
    // No injected `typescript` -- this exercises the real production
    // loadTypeScript() path, which must resolve the pinned discovery
    // compiler and never this fixture's own (stubbed, TS7-shaped)
    // `node_modules/typescript`.
    const result = await runDiscoveryScan({
      legacyRoot: f.root,
      moduleRoots: ["src/features/auth"],
    });
    // tsconfig alias resolution, barrel resolution, and JSX/TSX parsing all
    // succeed under the pinned compiler -- normal discovery output, not a crash.
    const background = "src/features/auth/components/login/background.tsx";
    assert.ok(result.census.includes(background));
    assert.equal(result.reachability[background], "REACHABLE_FROM_ENTRY");
    // Fail-closed regression: a non-literal dynamic import stays a blocking
    // finding -- the compiler swap must not broaden module resolution.
    assert.equal(
      result.findings.filter((x) => x.type === "DYNAMIC_NONLITERAL").length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

// --- algorithm 2: one semantic boundary -----------------------------------

test("i18n configuration governs the boundary while only the used namespace resource supports it", async () => {
  const f = await fixture(
    {
      "src/features/roles/useRoles.ts":
        "import { useTranslation } from 'react-i18next';\nexport const useRoles = () => useTranslation('roles');\n",
      "src/config/i18n.ts":
        "import rolesEs from '@/shared/i18n/es-ES/roles.json';\n" +
        "import usersEs from '@/shared/i18n/es-ES/users.json';\n" +
        "export const resources = { 'es-ES': { roles: rolesEs, users: usersEs } };\n",
      "src/shared/i18n/es-ES/roles.json": "{\"title\":\"Roles\"}\n",
      "src/shared/i18n/es-ES/users.json": "{\"title\":\"Users\"}\n",
    },
    {
      tsconfig: {
        compilerOptions: {
          ...ALIASED.compilerOptions,
          paths: { "@/*": ["./src/*"] },
          resolveJsonModule: true,
        },
      },
    },
  );
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(result.census, ["src/features/roles/useRoles.ts"]);
    assert.deepEqual(result.supporting, ["src/shared/i18n/es-ES/roles.json"]);
    assert.ok(!result.supporting.includes("src/config/i18n.ts"));
    assert.ok(!result.supporting.includes("src/shared/i18n/es-ES/users.json"));
    assert.deepEqual(
      result.boundary.supporting.map(({ relation, type, path: file }) => ({
        relation,
        type,
        path: file,
      })),
      [
        {
          relation: "SUPPORTING",
          type: "I18N_RESOURCE",
          path: "src/shared/i18n/es-ES/roles.json",
        },
      ],
    );
    assert.equal(
      result.boundary.governingFramework[0].path,
      "src/config/i18n.ts",
    );
    assert.equal(result.boundary.governingFramework[0].relation, "GOVERNING_FRAMEWORK");
    assert.deepEqual(result.findings, []);
  } finally {
    await f.cleanup();
  }
});

test("HTTP new URL calls are runtime evidence, while import.meta.url remains a module-resource edge", async () => {
  const f = await fixture({
    "src/features/roles/resources.ts":
      "export const endpoint = (host) => new URL(host, 'http://localhost');\n" +
      "export const route = (request) => new URL('/roles', request.url);\n" +
      "export const icon = new URL('./role.svg', import.meta.url);\n" +
      "export const localized = (name) => new URL(name, import.meta.url);\n",
    "src/features/roles/role.svg": "<svg/>\n",
    "src/features/roles/dark.svg": "<svg/>\n",
  });
  try {
    const initial = await scan(f.root, ["src/features/roles"]);
    assert.equal(initial.runtimeUrls.length, 2);
    assert.ok(!initial.findings.some((finding) => finding.type === "NEW_URL_NONLITERAL"));
    assert.ok(
      initial.edges.some(
        (edge) =>
          edge.kind === "MODULE_RESOURCE" &&
          edge.to === "src/features/roles/role.svg",
      ),
    );
    const unresolved = initial.findings.find(
      (finding) => finding.type === "MODULE_RESOURCE_NONLITERAL",
    );
    assert.ok(unresolved);
    await assert.rejects(
      scanVersion(
        f.root,
        ["src/features/roles"],
        CENSUS_ALGORITHM_VERSION,
        { moduleEdgeTargets: { [unresolved.id]: [] } },
      ),
      /requires at least one concrete tracked target/,
    );
    await assert.rejects(
      scanVersion(
        f.root,
        ["src/features/roles"],
        CENSUS_ALGORITHM_VERSION,
        {
          moduleEdgeTargets: {
            [unresolved.id]: ["src/features/roles/not-tracked.svg"],
          },
        },
      ),
      /not a concrete tracked file/,
    );

    const resolved = await scanVersion(
      f.root,
      ["src/features/roles"],
      CENSUS_ALGORITHM_VERSION,
      { moduleEdgeTargets: { [unresolved.id]: ["src/features/roles/dark.svg"] } },
    );
    assert.deepEqual(resolved.findings[0].resolvedTargets, [
      "src/features/roles/dark.svg",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a baseless URL and a parameter-based computed URL are runtime, but a parameter-based literal still fails closed", async () => {
  const f = await fixture({
    "src/features/roles/resources.ts":
      "export const service = (host) =>\n" +
      "  new URL(/^https?:\\/\\//i.test(host) ? host : `http://${host}`);\n" +
      "export const request = (path, baseUrl) =>\n" +
      "  new URL(path.replace(/^\\/+/, ''), baseUrl);\n" +
      "export const asset = (base) => new URL('./role.svg', base);\n",
    "src/features/roles/role.svg": "<svg/>\n",
  });
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    // A single-argument `new URL` has no base, so it can never be module-relative.
    assert.ok(
      result.runtimeUrls.some(
        (url) => url.line === 2 && url.base === null,
      ),
    );
    // A computed specifier over a parameter base is exactly what the module
    // branch refuses to resolve; blocking it would claim an unproven edge.
    assert.ok(
      result.runtimeUrls.some((url) => url.line === 4 && url.base === "baseUrl"),
    );
    // A literal specifier over an unproven base could still be a module
    // resource, so it must keep failing closed.
    assert.deepEqual(
      result.findings
        .filter((finding) => finding.type === "MODULE_RESOURCE_NONLITERAL")
        .map((finding) => finding.line),
      [5],
    );
  } finally {
    await f.cleanup();
  }
});

test("a computed URL over a destructured parameter base is runtime, not a module edge", async () => {
  const f = await fixture({
    "src/features/roles/resources.ts":
      "export const redirect = ({ url, baseUrl }) => {\n" +
      "  const normalizedUrl = url;\n" +
      "  if (url) return new URL(normalizedUrl, baseUrl).toString();\n" +
      "  return new URL(url, baseUrl).toString();\n" +
      "};\n",
  });
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(
      result.runtimeUrls
        .filter((url) => url.base === "baseUrl")
        .map((url) => url.line),
      [3, 4],
    );
    assert.ok(
      !result.findings.some(
        (finding) => finding.type === "MODULE_RESOURCE_NONLITERAL",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("a computed URL over an import.meta.url base stays a blocking module edge", async () => {
  const f = await fixture({
    "src/features/roles/resources.ts":
      "export const asset = (name) => new URL(name, import.meta.url);\n",
  });
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(
      result.findings.map(({ type, spec }) => ({ type, spec })),
      [{ type: "MODULE_RESOURCE_NONLITERAL", spec: "name" }],
    );
  } finally {
    await f.cleanup();
  }
});

test("immutable import.meta.url aliases and nested URL bases remain module resources", async () => {
  const f = await fixture({
    "src/features/roles/resources.ts":
      "const here = import.meta.url;\n" +
      "const chained = here;\n" +
      "const base = new URL('.', chained);\n" +
      "const concreteBase = new URL('../../shared/base.png', chained);\n" +
      "export const a = new URL('../assets/a.png', here);\n" +
      "export const b = new URL('./b.png', base);\n" +
      "export const dynamic = (name) => new URL(name, chained);\n" +
      "export const remote = new URL('https://cdn.example.test/a.png', concreteBase);\n",
    "src/features/assets/a.png": "a\n",
    "src/features/roles/b.png": "b\n",
    "src/shared/base.png": "base\n",
  });
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(
      result.edges
        .filter((edge) => edge.kind === "MODULE_RESOURCE")
        .map((edge) => edge.to)
        .sort(),
      [
        "src/features/assets/a.png",
        "src/features/roles/b.png",
        "src/shared/base.png",
      ],
    );
    assert.deepEqual(
      result.findings.map(({ type, spec }) => ({ type, spec })),
      [{ type: "MODULE_RESOURCE_NONLITERAL", spec: "name" }],
    );
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.runtimeUrls.map(({ spec }) => spec), [
      "https://cdn.example.test/a.png",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("shadowed, reassigned, and cyclic URL bases fail closed while proven runtime URLs do not", async () => {
  const f = await fixture({
    "src/features/roles/resources.ts":
      "const moduleBase = import.meta.url;\n" +
      "let reassigned = moduleBase;\n" +
      "reassigned = runtimeBase;\n" +
      "const left = right;\n" +
      "const right = left;\n" +
      "export const changed = new URL('./changed.png', reassigned);\n" +
      "export const cyclic = new URL('./cyclic.png', left);\n" +
      "export const shadowedBase = (moduleBase) => new URL('./shadowed.png', moduleBase);\n" +
      "export const shadowedConstructor = (URL) => new URL('./fake.png', import.meta.url);\n" +
      "export const shadowedGlobal = (globalThis) => new globalThis.URL('./global.png', import.meta.url);\n" +
      "export const loopAlias = (constructors) => { for (const URL of constructors) new URL('./loop.png', import.meta.url); };\n" +
      "export function hoistedAlias(constructors) { new URL('./hoisted.png', import.meta.url); var URL = constructors[0]; }\n" +
      "export const switchAlias = (kind, constructors) => { switch (kind) { case 1: const URL = constructors[0]; return new URL('./switch.png', import.meta.url); default: return null; } };\n" +
      "export const route = (request) => { const base = request.url; return new URL('/roles', base); };\n" +
      "export const remote = new URL('https://cdn.example.test/role.svg', import.meta.url);\n" +
      "export const nestedDynamic = (name) => new URL('https://cdn.example.test/fallback.svg', new URL(name, import.meta.url));\n",
    "src/features/roles/fake.png": "not a platform URL resource\n",
    "src/features/roles/global.png": "not a platform URL resource\n",
  });
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(
      result.findings.map(({ type, spec }) => ({ type, spec })),
      [
        { type: "MODULE_RESOURCE_NONLITERAL", spec: "./changed.png" },
        { type: "MODULE_RESOURCE_NONLITERAL", spec: "./cyclic.png" },
        { type: "MODULE_RESOURCE_NONLITERAL", spec: "./shadowed.png" },
        { type: "MODULE_RESOURCE_NONLITERAL", spec: "./loop.png" },
        { type: "MODULE_RESOURCE_NONLITERAL", spec: "./hoisted.png" },
        { type: "MODULE_RESOURCE_NONLITERAL", spec: "name" },
      ],
    );
    assert.ok(!result.edges.some((edge) => edge.spec === "./fake.png"));
    assert.ok(!result.edges.some((edge) => edge.spec === "./global.png"));
    assert.ok(!result.edges.some((edge) => edge.spec === "./switch.png"));
    assert.deepEqual(
      result.runtimeUrls.map(({ spec }) => spec),
      [
        "/roles",
        "https://cdn.example.test/role.svg",
        "https://cdn.example.test/fallback.svg",
      ],
    );
  } finally {
    await f.cleanup();
  }
});

test("named class expressions and import-equals aliases shadow the platform URL constructor", async () => {
  const f = await fixture({
    "src/features/roles/class-shadow.ts":
      "export const Custom = class URL { static value = new URL('./class.png', import.meta.url); };\n",
    "src/features/roles/import-shadow.ts":
      "import URL = require('./custom-url');\nexport const value = new URL('./import.png', import.meta.url);\n",
    "src/features/roles/custom-url.ts": "export = class CustomUrl {};\n",
    "src/features/roles/class.png": "not a platform URL resource\n",
    "src/features/roles/import.png": "not a platform URL resource\n",
  });
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    assert.ok(!result.edges.some((edge) => edge.spec === "./class.png"));
    assert.ok(!result.edges.some((edge) => edge.spec === "./import.png"));
    assert.deepEqual(result.findings, []);
  } finally {
    await f.cleanup();
  }
});

test("inbound consumers and governing framework files retain distinct evidence relations", async () => {
  const f = await fixture({
    "src/features/roles/index.ts": "export const Roles = () => null;\n",
    "src/app/roles/page.tsx":
      "import { Roles } from '../../features/roles';\nexport default Roles;\n",
    "src/shared/role-link.ts":
      "import { Roles } from '../features/roles';\nexport const roleLink = Roles;\n",
  });
  try {
    const result = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(
      result.boundary.inboundConsumers.map((entry) => entry.path),
      ["src/shared/role-link.ts"],
    );
    assert.deepEqual(
      result.boundary.governingFramework.map((entry) => entry.path),
      ["src/app/roles/page.tsx"],
    );
    assert.ok(
      result.boundary.inboundConsumers.every(
        (entry) => entry.relation === "INBOUND_CONSUMER",
      ),
    );
    assert.ok(
      result.boundary.governingFramework.every(
        (entry) => entry.relation === "GOVERNING_FRAMEWORK",
      ),
    );
    assert.deepEqual(result.supporting, []);
  } finally {
    await f.cleanup();
  }
});

test("an unrelated barrel export neither expands SUPPORTING nor changes the digest", async () => {
  const f = await fixture({
    "src/features/roles/service.ts":
      "import { used } from '../../shared';\nexport const role = used;\n",
    "src/shared/index.ts":
      "export { used } from './used';\nexport { unrelated } from './unrelated';\n",
    "src/shared/used.ts": "export const used = 1;\n",
    "src/shared/unrelated.ts": "export const unrelated = 2;\n",
  });
  try {
    const before = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(before.supporting, [
      "src/shared/index.ts",
      "src/shared/used.ts",
    ]);
    await writeFile(
      path.join(f.root, "src/shared/index.ts"),
      "export { used } from './used';\n" +
        "export { unrelated } from './unrelated';\n" +
        "export { later } from './later';\n",
    );
    await writeFile(path.join(f.root, "src/shared/later.ts"), "export const later = 3;\n");
    const after = await scan(f.root, ["src/features/roles"]);
    assert.deepEqual(after.supporting, before.supporting);
    assert.equal(after.discoveryDigest, before.discoveryDigest);
  } finally {
    await f.cleanup();
  }
});

test("namespace demand subsumes named demand in either import order", async () => {
  const files = (ownedSource) => ({
    "src/features/roles/service.ts": ownedSource,
    "src/shared/helper.ts":
      "import * as shared from './index';\nexport const all = shared;\n",
    "src/shared/index.ts":
      "export { x } from './x';\nexport { y } from './y';\n",
    "src/shared/x.ts": "export const x = 1;\n",
    "src/shared/y.ts": "export const y = 2;\n",
  });
  const namedFirst = await fixture(
    files(
      "import { y } from '../../shared'; import '../../shared/helper'; export const role = y;\n",
    ),
  );
  const namespaceFirst = await fixture(
    files(
      "import '../../shared/helper'; import { y } from '../../shared'; export const role = y;\n",
    ),
  );
  try {
    const first = await scan(namedFirst.root, ["src/features/roles"]);
    const second = await scan(namespaceFirst.root, ["src/features/roles"]);
    assert.deepEqual(first.supporting, [
      "src/shared/helper.ts",
      "src/shared/index.ts",
      "src/shared/x.ts",
      "src/shared/y.ts",
    ]);
    assert.deepEqual(second.supporting, first.supporting);
    assert.deepEqual(second.requiredBy, first.requiredBy);
    assert.deepEqual(second.boundary, first.boundary);
    assert.equal(second.discoveryDigest, first.discoveryDigest);
  } finally {
    await Promise.all([namedFirst.cleanup(), namespaceFirst.cleanup()]);
  }
});

test("a declared entry point remains represented when it is also supporting", async () => {
  const f = await fixture({
    "src/features/roles/service.ts":
      "import { bootstrap } from '../../shared/bootstrap';\nexport const role = bootstrap;\n",
    "src/shared/bootstrap.ts": "export const bootstrap = true;\n",
  });
  try {
    const result = await scan(
      f.root,
      ["src/features/roles"],
      [{ path: "src/shared/bootstrap.ts", reason: "Runtime bootstrap entry." }],
    );
    assert.deepEqual(result.supporting, ["src/shared/bootstrap.ts"]);
    assert.deepEqual(result.declaredEntryPoints, ["src/shared/bootstrap.ts"]);
    assert.deepEqual(result.entryPoints, [
      {
        path: "src/shared/bootstrap.ts",
        discovery: "DECLARED",
        reason: "Runtime bootstrap entry.",
      },
    ]);
    assert.equal(result.boundary.supporting[0].relation, "SUPPORTING");
    assert.deepEqual(result.boundary.inboundConsumers, []);
  } finally {
    await f.cleanup();
  }
});

test("an unrelated repository edge does not alter the module discovery digest", async () => {
  const f = await fixture({
    "src/features/roles/service.ts": "export const role = 1;\n",
    "src/features/users/service.ts": "export const user = 1;\n",
    "src/shared/unrelated.ts": "export const unrelated = 1;\n",
  });
  try {
    const before = await scan(f.root, ["src/features/roles"]);
    await writeFile(
      path.join(f.root, "src/features/users/service.ts"),
      "import { unrelated } from '../../shared/unrelated';\nexport const user = unrelated;\n",
    );
    const after = await scan(f.root, ["src/features/roles"]);
    assert.equal(after.discoveryDigest, before.discoveryDigest);
    assert.deepEqual(after.edges, before.edges);
  } finally {
    await f.cleanup();
  }
});

test("multiple legitimate roots share one owned census", async () => {
  const f = await fixture({
    "src/features/roles/index.ts": "export const Roles = 1;\n",
    "src/roles-runtime/worker.ts": "export const worker = 1;\n",
    "src/features/users/index.ts": "export const Users = 1;\n",
  });
  try {
    const result = await scan(f.root, [
      "src/roles-runtime",
      "src/features/roles",
    ]);
    assert.deepEqual(result.moduleRoots, [
      "src/features/roles",
      "src/roles-runtime",
    ]);
    assert.deepEqual(result.census, [
      "src/features/roles/index.ts",
      "src/roles-runtime/worker.ts",
    ]);
    assert.ok(
      result.boundary.owned.every((entry) => entry.relation === "OWNED"),
    );
  } finally {
    await f.cleanup();
  }
});

test("scanner algorithm dispatch changes behavior, not only metadata", async () => {
  const f = await fixture({
    "src/features/roles/url.ts":
      "export const endpoint = (host) => new URL(host, 'http://localhost');\n",
  });
  try {
    const version1 = await scanVersion(f.root, ["src/features/roles"], 1);
    const current = await scanVersion(
      f.root,
      ["src/features/roles"],
      CENSUS_ALGORITHM_VERSION,
    );
    assert.equal(version1.algorithmVersion, 1);
    assert.equal(version1.findings[0].type, "NEW_URL_NONLITERAL");
    assert.equal(current.algorithmVersion, CENSUS_ALGORITHM_VERSION);
    assert.deepEqual(current.findings, []);
    assert.equal(current.runtimeUrls.length, 1);
    assert.notEqual(current.discoveryDigest, version1.discoveryDigest);
  } finally {
    await f.cleanup();
  }
});

test("structuralUnits enumerates nested statically-keyed contract units of an exported factory call", () => {
  const text = [
    "export const theme = createTheme({",
    "  palette: { mode: 'light' },",
    "  components: {",
    "    MuiDrawer: { defaultProps: {} },",
    "    MuiDataGrid: { defaultProps: {} },",
    "  },",
    "});",
  ].join("\n");
  const units = structuralUnits(typescript, "theme.ts", text).map((unit) => unit.path);
  assert.ok(units.includes("theme"));
  assert.ok(units.includes("theme.palette"));
  assert.ok(units.includes("theme.components"));
  assert.ok(units.includes("theme.components.MuiDrawer"));
  assert.ok(units.includes("theme.components.MuiDataGrid"));
  assert.ok(!units.some((path) => path.startsWith("theme.components.MuiDrawer.")));
});

test("a binding exported by a separate export clause censuses like an inline export", () => {
  const body = `const theme = createTheme({
  palette: { mode: 'light' },
  components: { MuiDrawer: { defaultProps: {} } },
});`;
  // `export { theme }` used to census as `[]`, so every unit the file owns left
  // the completeness universe and global completeness collapsed silently.
  const separate = structuralUnits(typescript, "theme.ts", [body, "export { theme };"].join("\n"));
  const inline = structuralUnits(typescript, "theme.ts", `export ${body}`);
  assert.deepEqual(separate, inline);
  assert.ok(separate.some((unit) => unit.path === "theme.components.MuiDrawer"));

  // A rename keeps the exported name, not the local one.
  assert.deepEqual(
    structuralUnits(
      typescript,
      "theme.ts",
      [body, "export { theme as appTheme };"].join("\n"),
    ).map((unit) => unit.path),
    inline.map((unit) => unit.path.replace(/^theme/, "appTheme")),
  );
});

test("a re-export names a unit this file cannot census, so it is unresolved", () => {
  const units = structuralUnits(typescript, "index.ts", 'export { theme } from "./theme";');
  assert.deepEqual(units, [{ path: "theme", kind: "BINDING", resolved: false }]);
});

test("a non-statically-decidable key is emitted unresolved, never dropped", () => {
  const text = "export const config = { ...base, plain: {} };";
  const units = structuralUnits(typescript, "config.ts", text);
  assert.ok(units.some((unit) => unit.resolved === false));
  assert.ok(units.some((unit) => unit.path === "config.plain"));
});

test("a non-script source file is one structural unit", () => {
  const units = structuralUnits(typescript, "widget/theme.css", ":root{--a:red}");
  assert.deepEqual(units, [{ path: "widget/theme.css", kind: "FILE", resolved: true }]);
});

test("structural traversal follows a locally declared binding named by shorthand", () => {
  // `components` used to census as a leaf, truncating every registry entry it
  // owns out of the completeness universe.
  const units = structuralUnits(
    typescript,
    "theme.ts",
    [
      "const components = {",
      "  MuiDrawer: {}",
      "};",
      "",
      "const theme = createTheme({",
      "  components",
      "});",
      "",
      "export { theme };",
    ].join("\n"),
  ).map((unit) => unit.path);
  assert.deepEqual(units, ["theme", "theme.components", "theme.components.MuiDrawer"]);
});

test("an identifier this file cannot resolve is emitted unresolved, never dropped", () => {
  const units = structuralUnits(
    typescript,
    "theme.ts",
    ['import { components } from "./components";', "export const theme = createTheme({ components });"].join("\n"),
  );
  assert.deepEqual(units.map((unit) => unit.path), ["theme", "theme.components", "theme.components.<unresolved>"]);
  assert.equal(units.at(-1).resolved, false);
});

test("a cyclic alias chain terminates instead of recursing forever", () => {
  const units = structuralUnits(
    typescript,
    "cycle.ts",
    ["const a = b;", "const b = a;", "export { a };"].join("\n"),
  ).map((unit) => unit.path);
  assert.deepEqual(units, ["a", "a.<unresolved>"]);
});

test("default-exported local identifier traverses nested structure (theme.components.MuiDrawer)", () => {
  const units = structuralUnits(
    typescript,
    "theme.ts",
    [
      "const components = { MuiDrawer: {} };",
      "const theme = createTheme({ components });",
      "export default theme;",
    ].join("\n"),
  ).map((unit) => unit.path);
  assert.ok(units.includes("theme"));
  assert.ok(units.includes("theme.components"));
  assert.ok(units.includes("theme.components.MuiDrawer"));
});

test("direct default expression uses bounded structural traversal", () => {
  const units = structuralUnits(
    typescript,
    "theme.ts",
    "export default createTheme({ components: { MuiDrawer: {} } });",
  ).map((unit) => unit.path);
  assert.ok(units.includes("default"));
  assert.ok(units.includes("default.components"));
  assert.ok(units.includes("default.components.MuiDrawer"));
  assert.ok(!units.some((p) => p.startsWith("default.components.MuiDrawer.")));
});

test("imported re-export emits unresolved binding, never resolved", () => {
  const units = structuralUnits(
    typescript,
    "index.ts",
    'import { theme } from "./base";\nexport { theme };',
  );
  assert.equal(units.length, 1);
  assert.equal(units[0].path, "theme");
  assert.equal(units[0].resolved, false);
});
