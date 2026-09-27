import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';

import { digest } from '../providers/install-support.mjs';

const execFileAsync = promisify(execFile);

import { apiJson, ensureRuntime, resolveRelease, verifyDownloadedAsset } from '../scripts/runtime-bootstrap.mjs';
import { buildRelease, buildReleaseArchive } from '../scripts/release.mjs';
import { candidateReleaseRoot } from '../packages/migration-engine/test/support/candidate-release-root.mjs';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'runtime bootstrap '));
after(() => rm(scratch, { recursive: true, force: true }));
let fixture;

async function releaseFixture() {
  if (fixture) return fixture;
  const built = await buildRelease({ root: await candidateReleaseRoot(scratch), force: true });
  const asset = await buildReleaseArchive(built);
  let requests = 0;
  const download = async (resolved, destination) => {
    requests++;
    await cp(asset.archive, destination);
    await verifyDownloadedAsset(destination, resolved.asset.digest);
  };
  fixture = {
    built,
    resolved: {
      asset: { name: path.basename(asset.archive), digest: asset.digest, url: 'private://release-asset' },
      commit: built.identity.commit,
      version: built.identity.version,
      viaGh: false,
    },
    download,
    requests: () => requests,
  };
  return fixture;
}

// The v1.0.0 knowledge-root probe: the directory had to already exist. The
// blocker text is whatever the real `access` produced, not a written-out string.
// Extra blockers come from the environment so one staged release can play every
// doctor result a legacy runtime might return.
const LEGACY_ENGINE = `import { access, constants } from 'node:fs/promises';
import path from 'node:path';
export const runDoctor = async ({ cwd }) => {
  const blockers = JSON.parse(process.env.LEGACY_DOCTOR_BLOCKERS ?? '[]');
  try { await access(path.join(cwd, '.agents/knowledge/migrations'), constants.W_OK); }
  catch (error) { blockers.unshift(\`knowledge-root: \${error.message}\`); }
  return { outcome: blockers.length ? 'BLOCKED' : 'OK', checks: [], mcpServers: [], blockers };
};
`;

/**
 * A release as a pre-v1.1.0 consumer has one staged: the old engine and the old
 * identity, installed through the ordinary adapter, so the receipt, the MCP
 * registration and the owned paths are the ones a real v1.0.0 install left.
 */
const legacyReleases = new Map();
async function legacyRelease(version) {
  if (legacyReleases.has(version)) return legacyReleases.get(version);
  const { built } = await releaseFixture();
  const home = path.join(scratch, `legacy ${version} bundle`);
  const bundle = path.join(home, `artifact-migration-tools-${version}`);
  await cp(built.stagingRoot, bundle, { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(bundle, 'release-manifest.json'), 'utf8'));
  manifest.toolkit.version = version;
  const restamp = async (relative, contents) => {
    await writeFile(path.join(bundle, relative), contents);
    manifest.files[relative] = digest(Buffer.from(contents));
  };
  await restamp('packages/migration-engine/src/migration-utils.mjs', LEGACY_ENGINE);
  await restamp('packages/migration-engine/build-identity.json', `${JSON.stringify(manifest.toolkit, null, 2)}\n`);
  for (const relative of Object.keys(manifest.files).filter(name => /^providers\/[^/]+\/adapter\.json$/.test(name))) {
    const adapter = JSON.parse(await readFile(path.join(bundle, relative), 'utf8'));
    await restamp(relative, `${JSON.stringify({ ...adapter, toolkit: manifest.toolkit }, null, 2)}\n`);
  }
  await writeFile(path.join(bundle, 'SHA256SUMS'), `${Object.entries(manifest.files).map(([name, hash]) => `${hash.slice(7)}  ${name}`).join('\n')}\n`);
  await writeFile(path.join(bundle, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const archive = path.join(home, `artifact-migration-tools-v${version}.tar.gz`);
  await execFileAsync('tar', ['-czf', archive, '-C', home, path.basename(bundle)]);
  let requests = 0;
  const fixture = {
    resolve: async () => ({
      asset: { name: path.basename(archive), digest: digest(await readFile(archive)), url: 'private://legacy-asset' },
      commit: manifest.toolkit.commit, version, viaGh: false,
    }),
    download: async (resolved, destination) => { requests++; await cp(archive, destination); await verifyDownloadedAsset(destination, resolved.asset.digest); },
    requests: () => requests,
  };
  legacyReleases.set(version, fixture);
  return fixture;
}

async function legacyConsumer(name, version = '1.0.0') {
  const f = await legacyRelease(version);
  const root = path.join(scratch, `${name} consumer`);
  const store = path.join(scratch, `${name} store`);
  const knowledgeRoot = path.join(root, '.agents/knowledge/migrations');
  // Installing runs the pinned doctor. A runtime the allowance does not cover has
  // to be handed the directory its doctor demands before it can be installed.
  await mkdir(version === '1.0.0' ? root : knowledgeRoot, { recursive: true });
  await ensureRuntime({ provider: 'codex', root, store }, f);
  return { root, store, knowledgeRoot, requests: f.requests };
}

const offline = { resolve: async () => { throw new Error('network used'); }, download: async () => { throw new Error('download used'); } };
const withBlockers = async (blockers, body) => {
  process.env.LEGACY_DOCTOR_BLOCKERS = JSON.stringify(blockers);
  try { await body(); } finally { delete process.env.LEGACY_DOCTOR_BLOCKERS; }
};

test('a pre-v1.1.0 runtime whose doctor only wants a knowledge root it can still create is usable offline', async () => {
  const legacy = await legacyConsumer('legacy');
  const before = legacy.requests();
  const result = await ensureRuntime({ provider: 'codex', root: legacy.root, store: legacy.store }, offline);
  assert.equal(result.bootstrapped, false);
  assert.equal(result.toolkit.version, '1.0.0');
  assert.equal(result.adapterDoctor.outcome, 'OK');
  assert.equal(result.engineDoctor.outcome, 'OK');
  assert.match(result.engineDoctor.waived.join('; '), /^knowledge-root: ENOENT.*\.agents[/\\]knowledge[/\\]migrations'$/);
  assert.equal(legacy.requests(), before);
  await assert.rejects(stat(legacy.knowledgeRoot), { code: 'ENOENT' });
});

test('the legacy knowledge-root allowance stops at the exact compatible case', async () => {
  // No writable ancestor: this release's own probe fails too, so it stays blocked.
  const sealed = await legacyConsumer('sealed legacy');
  await chmod(sealed.root, 0o555);
  try {
    await assert.rejects(ensureRuntime({ provider: 'codex', root: sealed.root, store: sealed.store }, offline), /Engine doctor blocked: knowledge-root: ENOENT/);
  } finally {
    await chmod(sealed.root, 0o755);
  }

  // Present but unwritable: the same check name, a cause the allowance never covers.
  const unwritable = await legacyConsumer('unwritable legacy');
  await mkdir(unwritable.knowledgeRoot, { recursive: true });
  await chmod(unwritable.knowledgeRoot, 0o555);
  try {
    await assert.rejects(ensureRuntime({ provider: 'codex', root: unwritable.root, store: unwritable.store }, offline), /Engine doctor blocked: knowledge-root: EACCES/);
  } finally {
    await chmod(unwritable.knowledgeRoot, 0o755);
  }

  const other = await legacyConsumer('other blockers legacy');
  await withBlockers(['git: git --version failed'], async () => {
    // Alongside the legacy one, and on its own: either way the runtime is unusable.
    await assert.rejects(ensureRuntime({ provider: 'codex', root: other.root, store: other.store }, offline), /Engine doctor blocked: knowledge-root: ENOENT.*; git: /s);
    await mkdir(other.knowledgeRoot, { recursive: true });
    await assert.rejects(ensureRuntime({ provider: 'codex', root: other.root, store: other.store }, offline), /Engine doctor blocked: git: /);
  });

  // v1.1.0 answers OK for a creatable root on its own, so the same result there is real.
  const current = await legacyConsumer('current runtime', '1.1.0');
  await rm(current.knowledgeRoot, { recursive: true, force: true });
  await assert.rejects(ensureRuntime({ provider: 'codex', root: current.root, store: current.store }, offline), /Engine doctor blocked: knowledge-root: ENOENT/);
});

test('both independently installable skills carry the one shared bootstrap source', async () => {
  const source = await readFile(new URL('../scripts/runtime-bootstrap.mjs', import.meta.url));
  for (const skill of ['start-migration', 'migrate-artifact']) {
    assert.deepEqual(await readFile(new URL(`../skills/${skill}/scripts/runtime.mjs`, import.meta.url)), source);
  }
});

test('latest and exact resolvers accept only stable immutable releases pinned to the tag commit', async () => {
  const commit = 'a'.repeat(40);
  const release = {
    tag_name: 'v1.1.0', draft: false, prerelease: false, immutable: true,
    assets: [{ name: 'artifact-migration-tools-v1.1.0.tar.gz', digest: `sha256:${'b'.repeat(64)}` }],
  };
  const routes = [];
  const api = async route => {
    routes.push(route);
    return route.includes('/git/ref/')
      ? { value: { object: { type: 'commit', sha: commit } }, viaGh: true }
      : { value: release, viaGh: true };
  };
  assert.equal((await resolveRelease(undefined, { api })).version, '1.1.0');
  assert.equal(routes[0], '/repos/icordoba8/artifact-migration-tools/releases/latest');
  routes.length = 0;
  assert.equal((await resolveRelease('1.1.0', { api })).commit, commit);
  assert.match(routes[0], /releases\/tags\/v1\.1\.0$/);
  await assert.rejects(resolveRelease(undefined, { api: async () => ({ value: { ...release, immutable: false }, viaGh: true }) }), /not immutable/);
  await assert.rejects(resolveRelease('latest', { api }), /Exact --version/);
});

test('private GitHub metadata uses the authenticated gh CLI without reading its credential', async () => {
  let invocation;
  const result = await apiJson('/repos/private/tool/releases/latest', {
    execute: async (command, args) => {
      invocation = { command, args };
      return { stdout: JSON.stringify({ private: true }) };
    },
    request: async () => { throw new Error('anonymous network fallback used'); },
  });
  assert.equal(result.viaGh, true);
  assert.equal(result.value.private, true);
  assert.equal(invocation.command, 'gh');
  assert.ok(!invocation.args.some(argument => /token|authorization/i.test(argument)));
});

test('each provider bootstraps once, registers exact MCP, runs doctors, then stays offline', async () => {
  const f = await releaseFixture();
  for (const provider of ['claude', 'codex', 'opencode', 'copilot']) {
    const root = path.join(scratch, `${provider} consumer`);
    const store = path.join(scratch, 'release store');
    await mkdir(root, { recursive: true });
    const before = f.requests();
    const first = await ensureRuntime(
      { provider, root, store },
      { resolve: async version => { assert.equal(version, undefined); return f.resolved; }, download: f.download },
    );
    assert.equal(first.bootstrapped, true);
    assert.deepEqual(first.toolkit, f.built.identity);
    assert.equal(first.adapterDoctor.outcome, 'OK');
    assert.equal(first.engineDoctor.outcome, 'OK');
    assert.equal(f.requests(), before + 1);
    await assert.rejects(stat(path.join(root, '.agents/knowledge/migrations')), { code: 'ENOENT' });

    const second = await ensureRuntime(
      { provider, root, store },
      { resolve: async () => { throw new Error('network used'); }, download: async () => { throw new Error('download used'); } },
    );
    assert.equal(second.bootstrapped, false);
    assert.deepEqual(second.toolkit, first.toolkit);
    assert.equal(f.requests(), before + 1);
  }
});

test('tampered release asset is refused before receipt, MCP, or migration-state writes', async () => {
  const f = await releaseFixture();
  const root = path.join(scratch, 'tampered consumer');
  await mkdir(root, { recursive: true });
  await assert.rejects(
    ensureRuntime(
      { provider: 'codex', root, store: path.join(scratch, 'tampered store') },
      { resolve: async () => ({ ...f.resolved, asset: { ...f.resolved.asset, digest: `sha256:${'0'.repeat(64)}` } }), download: f.download },
    ),
    /asset digest mismatch/,
  );
  for (const relative of ['.artifact-migration-tools/codex.json', '.codex/config.toml', '.agents/knowledge/migrations']) {
    await assert.rejects(stat(path.join(root, relative)), { code: 'ENOENT' });
  }
});

test('admin exact-version override reaches the immutable resolver unchanged', async () => {
  const f = await releaseFixture();
  const root = path.join(scratch, 'exact version consumer');
  const version = f.resolved.version;
  await mkdir(root, { recursive: true });
  const result = await ensureRuntime(
    { provider: 'codex', root, store: path.join(scratch, 'exact version store'), version },
    { resolve: async requested => { assert.equal(requested, version); return f.resolved; }, download: f.download },
  );
  assert.equal(result.toolkit.version, version);
  await assert.rejects(ensureRuntime({ provider: 'codex', root, version: 'latest' }), /Exact version override/);
});
