import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

// --- the installed skill's exact identity -----------------------------------
//
// Selection now reads a *requirement* from the skill beside the bootstrap, so
// every fixture has to state one. Injected through the same `deps` object as
// `resolve`/`download`, which is what keeps these suites free of real release
// state. Held in one place and set per scenario rather than threaded through
// each of the forty call sites.

let requiredSkill = null;
const skillRelease = async () => requiredSkill;

/** Require `version`, proving the staged bundle's real canonical skill digest. */
async function requiring(version, overrides = {}) {
  const { built } = await releaseFixture();
  requiredSkill = {
    name: 'artifact-migration-tools',
    version,
    skill: 'start-migration',
    computedHash: built.manifest.skills.skills['start-migration'].computedHash,
    source: 'repository',
    ...overrides,
  };
  return requiredSkill;
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
 * The staged release under a second exact toolkit version, optionally with a
 * different engine.
 *
 * `engine: LEGACY_ENGINE` reproduces what a pre-v1.1.0 consumer has staged: the
 * old engine and the old identity, installed through the ordinary adapter, so
 * the receipt, the MCP registration and the owned paths are the ones a real
 * v1.0.0 install left. With no engine override it is simply the same compatible
 * runtime under another exact version, which is how a *skill update* -- the one
 * thing that changes the required identity -- is simulated without publishing.
 *
 * `manifest.skills` is deliberately untouched: these variants differ in engine
 * identity, not in skill semantics, so a stamp requiring any of their versions
 * is satisfied by exactly one of them.
 */
const variants = new Map();
async function variantRelease(version, engine = null) {
  const key = `${version} ${engine ? 'legacy' : 'current'}`;
  if (variants.has(key)) return variants.get(key);
  const { built } = await releaseFixture();
  const home = path.join(scratch, `${key} bundle`);
  const bundle = path.join(home, `artifact-migration-tools-${version}`);
  await cp(built.stagingRoot, bundle, { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(bundle, 'release-manifest.json'), 'utf8'));
  manifest.toolkit.version = version;
  const restamp = async (relative, contents) => {
    await writeFile(path.join(bundle, relative), contents);
    manifest.files[relative] = digest(Buffer.from(contents));
  };
  if (engine) await restamp('packages/migration-engine/src/migration-utils.mjs', engine);
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
    version,
    bundle,
    pin: digest(await readFile(path.join(bundle, 'release-manifest.json'))),
    resolve: async requested => {
      if (requested !== version) throw new Error(`GitHub API /releases/tags/v${requested} returned 404`);
      return { asset: { name: path.basename(archive), digest: digest(await readFile(archive)), url: 'private://variant-asset' }, commit: manifest.toolkit.commit, version, viaGh: false };
    },
    download: async (resolved, destination) => { requests++; await cp(archive, destination); await verifyDownloadedAsset(destination, resolved.asset.digest); },
    requests: () => requests,
  };
  variants.set(key, fixture);
  return fixture;
}

const legacyRelease = version => variantRelease(version, LEGACY_ENGINE);

async function legacyConsumer(name, version = '1.0.0') {
  const f = await legacyRelease(version);
  const root = path.join(scratch, `${name} consumer`);
  const store = path.join(scratch, `${name} store`);
  const knowledgeRoot = path.join(root, '.agents/knowledge/migrations');
  // Installing runs the pinned doctor. A runtime the allowance does not cover has
  // to be handed the directory its doctor demands before it can be installed.
  await mkdir(version === '1.0.0' ? root : knowledgeRoot, { recursive: true });
  await requiring(version);
  await ensureRuntime({ provider: 'codex', root, store }, { ...f, skillRelease });
  return { root, store, knowledgeRoot, requests: f.requests, version };
}

const offline = { resolve: async () => { throw new Error('network used'); }, download: async () => { throw new Error('download used'); }, skillRelease };
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

// chmod cannot make a directory unwritable on Windows, and root can bypass it.
const posixPermissionTest = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test;
posixPermissionTest('the legacy knowledge-root allowance distinguishes POSIX permission failures', async () => {
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
});

test('the legacy knowledge-root allowance does not hide other blockers', async () => {
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
  assert.equal(routes[0], '/repos/icordoba8/artifact-migration-toolkit/releases/latest');
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
  // The required identity is now what drives selection, so the resolver is asked
  // for the skill's exact version -- never `undefined`, which is the only input
  // that reached `/releases/latest`.
  await requiring(f.resolved.version);
  for (const provider of ['claude', 'codex', 'opencode', 'copilot']) {
    const root = path.join(scratch, `${provider} consumer`);
    // One store per provider: this test's subject is the network bootstrap, and
    // a shared store would legitimately serve providers 2-4 offline (the store
    // is a first-class local source now -- proved separately by T8b and T22).
    const store = path.join(scratch, `${provider} release store`);
    await mkdir(root, { recursive: true });
    const before = f.requests();
    const first = await ensureRuntime(
      { provider, root, store },
      { resolve: async version => { assert.equal(version, f.resolved.version); return f.resolved; }, download: f.download, skillRelease },
    );
    assert.equal(first.bootstrapped, true);
    assert.equal(first.selection, 'skill');
    assert.equal(first.skillIdentity, 'required');
    assert.equal(first.network, true);
    assert.deepEqual(first.toolkit, f.built.identity);
    assert.equal(first.adapterDoctor.outcome, 'OK');
    assert.equal(first.engineDoctor.outcome, 'OK');
    assert.equal(f.requests(), before + 1);
    await assert.rejects(stat(path.join(root, '.agents/knowledge/migrations')), { code: 'ENOENT' });

    // T7: a receipt that satisfies the requirement makes zero requests.
    const second = await ensureRuntime({ provider, root, store }, offline);
    assert.equal(second.bootstrapped, false);
    assert.equal(second.selection, 'skill');
    assert.equal(second.network, false);
    assert.deepEqual(second.toolkit, first.toolkit);
    assert.equal(f.requests(), before + 1);
  }
});

test('tampered release asset is refused before receipt, MCP, or migration-state writes', async () => {
  const f = await releaseFixture();
  const root = path.join(scratch, 'tampered consumer');
  await mkdir(root, { recursive: true });
  await requiring(f.resolved.version);
  await assert.rejects(
    ensureRuntime(
      { provider: 'codex', root, store: path.join(scratch, 'tampered store') },
      { resolve: async () => ({ ...f.resolved, asset: { ...f.resolved.asset, digest: `sha256:${'0'.repeat(64)}` } }), download: f.download, skillRelease },
    ),
    /asset digest mismatch/,
  );
  for (const relative of ['.artifact-migration-tools/codex.json', '.codex/config.toml', '.agents/knowledge/migrations']) {
    await assert.rejects(stat(path.join(root, relative)), { code: 'ENOENT' });
  }
});

// T9. The override is a statement about *this* run. Letting a one-off flag
// govern a human's later interactive runs would be the same class of invisible
// state as the defect being fixed, so nothing is persisted and the next
// ordinary invocation converges back to what the installed skill requires.
test('an exact-version override reaches the resolver unchanged, persists nothing, and does not survive one run', async () => {
  const f = await releaseFixture();
  const other = await variantRelease('1.42.0');
  const root = path.join(scratch, 'exact version consumer');
  const store = path.join(scratch, 'exact version store');
  const version = f.resolved.version;
  await mkdir(root, { recursive: true });

  // The skill requires 1.42.0; the operator asks for exactly the other release.
  await requiring(other.version);
  const explicit = await ensureRuntime(
    { provider: 'codex', root, store, version },
    { resolve: async requested => { assert.equal(requested, version); return f.resolved; }, download: f.download, skillRelease },
  );
  assert.equal(explicit.toolkit.version, version);
  assert.equal(explicit.selection, 'explicit');
  assert.equal(explicit.skillIdentity, 'unverified');
  const receiptFile = path.join(root, '.artifact-migration-tools/codex.json');
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).pinned, undefined, 'an override must not persist a pin');

  // The next ordinary invocation converges back, and says which rule fired.
  const converged = await ensureRuntime({ provider: 'codex', root, store }, { ...other, skillRelease });
  assert.equal(converged.toolkit.version, other.version);
  assert.equal(converged.selection, 'skill');
  assert.equal(converged.skillIdentity, 'required');
  assert.equal(converged.bootstrapped, true);

  await assert.rejects(ensureRuntime({ provider: 'codex', root, version: 'latest' }), /Exact version override/);
});

// ---------------------------------------------------------------------------
// Exact-identity selection. Everything below proves the same one thing from a
// different side: SemVer equality alone never establishes compatibility, and a
// skill/runtime split is either an explicit pin or a typed refusal -- never a
// silent steady state.
// ---------------------------------------------------------------------------

const receiptPath = (root, provider = 'codex') => path.join(root, `.artifact-migration-tools/${provider}.json`);

/** Every file under `root`, by digest. The proof that a refusal wrote nothing. */
async function snapshot(root) {
  const files = {};
  const walk = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files[path.relative(root, absolute)] = digest(await readFile(absolute));
    }
  };
  await walk(root);
  return files;
}

/** A codex consumer converged on `release` through the ordinary network path. */
async function consumerAt(name, release) {
  const root = path.join(scratch, `${name} consumer`);
  const store = path.join(scratch, `${name} store`);
  await mkdir(root, { recursive: true });
  await requiring(release.version);
  const result = await ensureRuntime({ provider: 'codex', root, store }, { ...release, skillRelease });
  return { root, store, result, name };
}

// T1-T5. The live defect, end to end: a stale receipt plus a newer required
// identity converges -- receipt, retained history, provider MCP registration
// and every absolute engine path -- under one lock, in one invocation.
test('T1-T5: a stale receipt converges to the exact release the installed skill requires', async () => {
  const stale = await variantRelease('1.3.4');
  const wanted = await variantRelease('1.3.9');
  const { root, store } = await consumerAt('stale receipt', stale);
  const before = JSON.parse(await readFile(receiptPath(root), 'utf8'));
  assert.equal(before.toolkit.version, '1.3.4');

  // T1: the resolver is asked for exactly the required version, and it updates.
  await requiring('1.3.9');
  let asked = null;
  const updated = await ensureRuntime({ provider: 'codex', root, store }, {
    resolve: async requested => { asked = requested; return wanted.resolve(requested); },
    download: wanted.download, skillRelease,
  });
  assert.equal(asked, '1.3.9');
  assert.equal(updated.bootstrapped, true);
  assert.equal(updated.selection, 'skill');
  assert.equal(updated.skillIdentity, 'required');

  // T2: the returned identity and the on-disk receipt are both the new one.
  const receipt = JSON.parse(await readFile(receiptPath(root), 'utf8'));
  assert.equal(updated.toolkit.version, '1.3.9');
  assert.equal(receipt.toolkit.version, '1.3.9');

  // T3: the receipt carries the exact immutable identity, and still retains the
  // release it came from, so a rollback target is never lost by converging.
  assert.equal(receipt.pin, wanted.pin);
  assert.equal(receipt.release, path.join(store, `1.3.9-${wanted.pin.slice(7)}`));
  assert.deepEqual(receipt.skills, JSON.parse(await readFile(path.join(wanted.bundle, 'release-manifest.json'), 'utf8')).skills);
  assert.ok(receipt.releases.some(item => item.release === before.release && item.pin === before.pin), 'the previous release is no longer retained');
  assert.deepEqual(receipt.requiredBy['start-migration'], { skill: 'start-migration', version: '1.3.9', computedHash: requiredSkill.computedHash });

  // T4: the provider's own configuration holds the new absolute MCP entry, and
  // `configOwned` is exactly what is on disk.
  const config = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
  assert.ok(config.includes(receipt.configOwned.replace(/^\n/, '')), 'the config is not the receipt-owned registration');
  assert.ok(receipt.mcp.args[0].startsWith(`${receipt.release}${path.sep}`), 'the MCP entry escapes the selected release');

  // T5: no toolkit-owned file anywhere refers to the release we just left.
  for (const relative of [...Object.keys(receipt.files), '.codex/config.toml']) {
    const text = await readFile(path.join(root, relative), 'utf8');
    assert.ok(!text.includes(before.release), `${relative} still names the previous release`);
  }
});

// T15. The whole point: a stale runtime is not a steady state. Nothing changed
// between these two invocations except the installed skill.
test('T15: a changed skill identity is never answered with bootstrapped:false on the old release', async () => {
  const first = await variantRelease('1.5.0');
  const second = await variantRelease('1.6.0');
  const { root, store } = await consumerAt('skill changed', first);
  assert.equal((await ensureRuntime({ provider: 'codex', root, store }, offline)).bootstrapped, false);

  await requiring('1.6.0');
  const converged = await ensureRuntime({ provider: 'codex', root, store }, { ...second, skillRelease });
  assert.equal(converged.bootstrapped, true);
  assert.equal(converged.toolkit.version, '1.6.0');
});

// T17 / T20. The correction's worked example. Same version, different bytes:
// the release at that tag proves a digest the installed skill does not have, so
// pairing them would run new skill semantics on an engine that never
// implemented them. Refused, and nothing is touched.
test('T17, T20: same SemVer with a different skill identity is refused, not reused', async () => {
  const release = await variantRelease('1.7.0');
  const { root, store } = await consumerAt('same semver', release);
  const consumerBefore = await snapshot(root);
  const storeBefore = await snapshot(store);

  const proven = JSON.parse(await readFile(path.join(release.bundle, 'release-manifest.json'), 'utf8')).skills.skills['start-migration'].computedHash;
  await requiring('1.7.0', { computedHash: 'f'.repeat(64) });
  const error = await ensureRuntime({ provider: 'codex', root, store }, { ...release, skillRelease }).then(() => null, e => e);
  assert.ok(error, 'a same-version/different-digest release must not be accepted');
  assert.equal(error.code, 'SKILL_IDENTITY_UNRELEASED');
  assert.equal(error.state.receipt, 'unchanged');
  assert.equal(error.state.required, 'f'.repeat(64));
  assert.equal(error.state.releaseProves, proven);
  assert.match(error.message, /not the semantics published/);

  // T20's second half: no silent run, and no state mutated by refusing.
  assert.deepEqual(await snapshot(root), consumerBefore);
  assert.deepEqual(await snapshot(store), storeBefore);
});

// T18. Both repository-source failure modes, and neither falls back.
test('T18: unreleased repository bytes and an unpublished version both fail closed', async () => {
  const release = await variantRelease('1.8.0');
  const { root, store } = await consumerAt('repository source', release);

  // Case B: bytes changed after the release, version not yet bumped.
  await requiring('1.8.0', { computedHash: '1'.repeat(64) });
  const unreleased = await ensureRuntime({ provider: 'codex', root, store }, { ...release, skillRelease }).then(() => null, e => e);
  assert.equal(unreleased.code, 'SKILL_IDENTITY_UNRELEASED');
  assert.equal(unreleased.state.version, '1.8.0');

  // Case C: version bumped, that release is not published. The fixture resolver
  // answers 404 for any version but its own -- never `latest`, never the
  // previous version.
  await requiring('1.8.1');
  const unpublished = await ensureRuntime({ provider: 'codex', root, store }, { ...release, skillRelease }).then(() => null, e => e);
  assert.equal(unpublished.code, 'RELEASE_NOT_PUBLISHED');
  assert.equal(unpublished.state.required, '1.8.1');
  assert.equal(unpublished.state.receipt, 'unchanged');
  assert.equal(JSON.parse(await readFile(receiptPath(root), 'utf8')).toolkit.version, '1.8.0');
});

// T8 / T8b. Offline is two different answers, and the difference is whether the
// exact required release can be found locally -- never whether it is convenient.
test('T8, T8b: offline converges from local history, and otherwise refuses without mutating anything', async () => {
  const first = await variantRelease('1.9.0');
  const second = await variantRelease('1.9.1');
  const { root, store } = await consumerAt('offline history', first);

  // Converge forward, then back: 1.9.0 is now retained in `releases[]`.
  await requiring('1.9.1');
  await ensureRuntime({ provider: 'codex', root, store }, { ...second, skillRelease });

  // T8b: the requirement is present locally, so it converges with zero network.
  const requests = first.requests();
  await requiring('1.9.0');
  const offlineConverged = await ensureRuntime({ provider: 'codex', root, store }, offline);
  assert.equal(offlineConverged.bootstrapped, true);
  assert.equal(offlineConverged.network, false);
  assert.equal(offlineConverged.reusedFrom, 'history');
  assert.equal(offlineConverged.toolkit.version, '1.9.0');
  assert.equal(first.requests(), requests);

  // T8: a requirement that exists nowhere locally and cannot be fetched.
  const consumerBefore = await snapshot(root);
  const storeBefore = await snapshot(store);
  await requiring('1.9.5');
  const error = await ensureRuntime({ provider: 'codex', root, store }, offline).then(() => null, e => e);
  assert.equal(error.code, 'RUNTIME_UPDATE_REQUIRED_OFFLINE');
  assert.equal(error.state.installed, '1.9.0');
  assert.equal(error.state.required, '1.9.5');
  assert.equal(error.state.receipt, 'unchanged');
  assert.deepEqual(await snapshot(root), consumerBefore);
  assert.deepEqual(await snapshot(store), storeBefore);
});

// T21. An unverifiable skill driving an arbitrary release is the defect class
// itself, so there is no `latest` escape -- only the two documented remedies.
test('T21: an identity-less or pre-binding skill stamp fails closed and names its remedies', async () => {
  const release = await variantRelease('1.10.0');
  const { root, store } = await consumerAt('identity less', release);

  requiredSkill = null;
  const missing = await ensureRuntime({ provider: 'codex', root, store }, offline).then(() => null, e => e);
  assert.equal(missing.code, 'SKILL_IDENTITY_MISSING');
  assert.match(missing.message, /skills add/);
  assert.match(missing.message, /--version/);

  await requiring('1.10.0');
  delete requiredSkill.computedHash;
  const legacy = await ensureRuntime({ provider: 'codex', root, store }, offline).then(() => null, e => e);
  assert.equal(legacy.code, 'SKILL_IDENTITY_LEGACY');
  assert.match(legacy.message, /skills add/);
  assert.match(legacy.message, /--version/);

  // Neither reached the network at all, so neither could have resolved `latest`.
  assert.equal(JSON.parse(await readFile(receiptPath(root), 'utf8')).toolkit.version, '1.10.0');
});

// T23. Two skills, one receipt. Refusing and naming both is strictly better
// than rewriting the runtime and the MCP registration on alternating
// invocations, which is the only other way this can end.
test('T23: an incoherent installed skill set is refused, not flip-flopped', async () => {
  const first = await variantRelease('1.11.0');
  const second = await variantRelease('1.11.1');
  const { root, store } = await consumerAt('incoherent skills', first);

  // `start-migration` is updated and converges; `migrate-artifact` is not.
  await requiring('1.11.1');
  await ensureRuntime({ provider: 'codex', root, store }, { ...second, skillRelease });
  const converged = await snapshot(root);

  const { built } = await releaseFixture();
  requiredSkill = {
    name: 'artifact-migration-tools', version: '1.11.0', skill: 'migrate-artifact',
    computedHash: built.manifest.skills.skills['migrate-artifact'].computedHash, source: 'repository',
  };
  const error = await ensureRuntime({ provider: 'codex', root, store }, offline).then(() => null, e => e);
  assert.equal(error.code, 'SKILL_SET_INCOHERENT');
  assert.match(error.message, /migrate-artifact/);
  assert.match(error.message, /start-migration/);
  assert.match(error.message, /skills add/);
  assert.deepEqual(await snapshot(root), converged, 'the receipt must not move');

  // Installing both skills from the same release is the documented remedy.
  requiredSkill.version = '1.11.1';
  const settled = await ensureRuntime({ provider: 'codex', root, store }, offline);
  assert.equal(settled.bootstrapped, false);
  assert.equal(settled.selection, 'skill');
});

// T12. A killed installer used to mean "delete a lock file by hand, forever".
// Recovery now re-proves the installation instead of assuming it, and every
// ambiguous owner still fails closed with the message it always had.
test('T12: a provably dead lock owner is reclaimed once; anything ambiguous stays blocked', async () => {
  const release = await variantRelease('1.12.0');
  const { root, store } = await consumerAt('stale lock', release);
  const lock = path.join(root, '.artifact-migration-tools/install.lock');
  const dead = 2 ** 22 - 1; // Above every pid_max this test could collide with.
  const settled = await snapshot(root);

  // Live owner: this very process. Still blocked.
  await writeFile(lock, `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), action: 'install', provider: 'codex' })}\n`);
  await requiring('1.12.0');
  await rm(path.join(root, '.codex/config.toml'));
  await assert.rejects(ensureRuntime({ provider: 'codex', root, store }, offline), /Installation locked/);

  // Unparseable, and another hostname: nothing is known, so nothing is reclaimed.
  await writeFile(lock, 'not json\n');
  await assert.rejects(ensureRuntime({ provider: 'codex', root, store }, offline), /Installation locked/);
  await writeFile(lock, `${JSON.stringify({ pid: dead, hostname: `${os.hostname()}-elsewhere` })}\n`);
  await assert.rejects(ensureRuntime({ provider: 'codex', root, store }, offline), /Installation locked/);

  // Provably dead on this host: reclaimed once, and the repair completes with
  // full re-verification of the receipt, the bundle and every owned file.
  await writeFile(lock, `${JSON.stringify({ pid: dead, hostname: os.hostname(), startedAt: new Date().toISOString(), action: 'install', provider: 'codex' })}\n`);
  const repaired = await ensureRuntime({ provider: 'codex', root, store }, offline);
  assert.equal(repaired.mcpRepair.repaired, true);
  await assert.rejects(stat(lock), { code: 'ENOENT' }, 'the reclaimed lock was not released');
  assert.deepEqual(await snapshot(root), settled, 'recovery did not restore the exact installed state');
});

// T14. Fail-closed was always right here; an error naming neither cause nor
// remedy was not. No cross-environment adoption is attempted either way.
test('T14: a receipt written for another root or store names both sides', async () => {
  const release = await variantRelease('1.13.0');
  const { root, store } = await consumerAt('platform conflict', release);
  const file = receiptPath(root);
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  const foreign = { ...receipt, root: 'C:\\elsewhere\\consumer', store: 'C:\\Users\\someone\\AppData\\Local\\artifact-migration-tools' };
  await writeFile(file, `${JSON.stringify(foreign, null, 2)}\n`);

  await requiring('1.13.0');
  const error = await ensureRuntime({ provider: 'codex', root, store }, offline).then(() => null, e => e);
  assert.match(error.message, /Runtime receipt selection conflict/);
  for (const named of [foreign.root, foreign.store, root, store]) assert.ok(error.message.includes(named), `the conflict does not name ${named}`);
  assert.match(error.message, /--root\/--store/);
  // Untouched: a conflict is not an invitation to adopt the other environment.
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(foreign, null, 2)}\n`);
});

// T11. Runtime selection and migration-record identity are separate lifecycles.
// `ensureRuntime` converging the runtime must not enumerate, create, open or
// write any record -- record convergence stays an explicit operator action.
test('T11: a runtime update never reads or writes a migration record', async () => {
  const first = await variantRelease('1.14.0');
  const second = await variantRelease('1.14.1');
  const { root, store } = await consumerAt('record identity', first);
  const record = path.join(root, '.agents/knowledge/migrations/modules/auth');
  await mkdir(record, { recursive: true });
  const state = `${JSON.stringify({ version: 1, toolkitIdentity: { name: 'artifact-migration-tools', version: '1.0.0', commit: 'a'.repeat(40), contentHash: `sha256:${'b'.repeat(64)}` } }, null, 2)}\n`;
  await writeFile(path.join(record, 'state.json'), state);
  const before = await snapshot(path.join(root, '.agents/knowledge'));

  await requiring('1.14.1');
  const updated = await ensureRuntime({ provider: 'codex', root, store }, { ...second, skillRelease });
  assert.equal(updated.toolkit.version, '1.14.1');
  assert.equal(await readFile(path.join(record, 'state.json'), 'utf8'), state, 'toolkitIdentity moved');
  assert.deepEqual(await snapshot(path.join(root, '.agents/knowledge')), before);
});

// T19, predicate 4. A skill that came out of a release artifact carries the
// release's own commit and content hash, so it can only ever run on the exact
// release it came from -- the strongest binding available, and the one case D
// the repository-source cases cannot reach.
test('T19: a released skill stamp binds to the exact commit and contentHash of its release', async () => {
  const release = await variantRelease('1.15.0');
  const root = path.join(scratch, 'released source consumer');
  const store = path.join(scratch, 'released source store');
  await mkdir(root, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(release.bundle, 'release-manifest.json'), 'utf8'));

  // Version and skill digest both agree; only the toolkit commit does not.
  await requiring('1.15.0', { source: 'release', commit: '7'.repeat(40), contentHash: manifest.toolkit.contentHash });
  const wrongCommit = await ensureRuntime({ provider: 'codex', root, store }, { ...release, skillRelease }).then(() => null, e => e);
  assert.equal(wrongCommit.code, 'SKILL_IDENTITY_UNRELEASED');
  await assert.rejects(stat(receiptPath(root)), { code: 'ENOENT' });

  await requiring('1.15.0', { source: 'release', commit: manifest.toolkit.commit, contentHash: `sha256:${'6'.repeat(64)}` });
  const wrongContent = await ensureRuntime({ provider: 'codex', root, store }, { ...release, skillRelease }).then(() => null, e => e);
  assert.equal(wrongContent.code, 'SKILL_IDENTITY_UNRELEASED');
  await assert.rejects(stat(receiptPath(root)), { code: 'ENOENT' });

  // All four fields agreeing is the only accepted released-source selection.
  await requiring('1.15.0', { source: 'release', commit: manifest.toolkit.commit, contentHash: manifest.toolkit.contentHash });
  const accepted = await ensureRuntime({ provider: 'codex', root, store }, { ...release, skillRelease });
  assert.equal(accepted.bootstrapped, true);
  assert.equal(accepted.selection, 'skill');
  assert.equal(accepted.toolkit.version, '1.15.0');
});

test('project copies of a skill converge from the verified .agents copy; skew without one is refused', async () => {
  const f = await releaseFixture();
  const version = f.resolved.version;
  const root = path.join(scratch, 'projection consumer');
  const store = path.join(scratch, 'projection store');
  await mkdir(root, { recursive: true });
  await requiring(version);
  await ensureRuntime({ provider: 'codex', root, store }, { resolve: async () => f.resolved, download: f.download, skillRelease });

  const copy = rel => path.join(root, rel, 'start-migration');
  const identity = async rel => JSON.parse(await readFile(path.join(copy(rel), 'release-identity.json'), 'utf8'));
  const stamp = (rel, stamped) => writeFile(path.join(copy(rel), 'release-identity.json'), `${JSON.stringify(stamped, null, 2)}\n`);
  const from = rel => ({ ...offline, skillRelease: () => identity(rel), skillDir: copy(rel) });
  const current = { ...requiredSkill };
  const older = { ...current, version: '1.0.5' };
  for (const rel of ['.agents/skills', '.github/skills', '.opencode/skills']) {
    await cp(path.join(import.meta.dirname, '../skills/start-migration'), copy(rel), { recursive: true });
    await stamp(rel, rel === '.agents/skills' ? current : older);
  }

  const converged = await ensureRuntime({ provider: 'codex', root, store }, from('.agents/skills'));
  assert.deepEqual(converged.projectionsConverged, ['.github/skills/start-migration', '.opencode/skills/start-migration']);
  assert.deepEqual(await identity('.github/skills'), current);

  // The host ran a stale copy: it is updated too, and the run stops so the new instructions load.
  await stamp('.github/skills', older);
  const rerun = await ensureRuntime({ provider: 'codex', root, store }, from('.github/skills')).then(() => null, e => e);
  assert.equal(rerun.code, 'SKILL_PROJECTION_CONVERGED');
  assert.deepEqual(await identity('.github/skills'), current);

  const receipt = await readFile(receiptPath(root));
  const refused = async (rel, why) => {
    await stamp('.opencode/skills', older);
    const error = await ensureRuntime({ provider: 'codex', root, store }, from(rel)).then(() => null, e => e);
    assert.equal(error?.code, 'SKILL_PROJECTION_SKEW', why);
    assert.deepEqual(await identity('.opencode/skills'), older, why);
    assert.deepEqual(await readFile(receiptPath(root)), receipt, why);
  };
  await writeFile(path.join(copy('.agents/skills'), 'SKILL.md'), 'tampered\n', { flag: 'a' });
  await refused('.agents/skills', 'reference bytes do not match its stamp');
  await rm(path.join(root, '.agents'), { recursive: true });
  await refused('.github/skills', 'no reference copy');
});
