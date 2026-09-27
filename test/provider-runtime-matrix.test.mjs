/**
 * Executable four-provider proof for the two v1.2.2 runtime behaviors:
 * self-healing MCP registration, and offline reuse of a verified runtime a
 * sibling provider already installed in the same consumer.
 *
 * Every provider is exercised through the real adapter and the real runtime
 * bootstrap against a real staged release. Nothing here compares generated
 * skill documents: a matching document is not a working adapter.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';

import { adapter, digest } from '../providers/install-support.mjs';
import { ensureRuntime, verifyDownloadedAsset } from '../scripts/runtime-bootstrap.mjs';
import { buildRelease } from '../scripts/release.mjs';
import { candidateReleaseRoot } from '../packages/migration-engine/test/support/candidate-release-root.mjs';

const execFileAsync = promisify(execFile);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'provider runtime matrix '));
after(() => rm(scratch, { recursive: true, force: true }));

const NAMES = ['claude', 'codex', 'opencode', 'copilot'];

/**
 * Each provider's native project-scope registration surface. `key` is the
 * object the server lives under, or null for Codex's marked TOML block.
 */
const SURFACES = {
  claude: {
    config: '.mcp.json',
    key: 'mcpServers',
    seed: { mcpServers: { playwright: { command: 'node', args: ['--version'] } }, unrelatedTopLevel: { keep: true } },
  },
  codex: {
    config: '.codex/config.toml',
    key: null,
    seed: '# a user comment that must survive\nmodel = "chosen"\n\n[mcp_servers.other]\ncommand = "other"\nargs = []\n',
  },
  opencode: {
    config: 'opencode.json',
    key: 'mcp',
    seed: { $schema: 'https://opencode.ai/config.json', theme: 'chosen', mcp: { other: { type: 'local', command: ['node', '--version'], enabled: true } } },
  },
  copilot: {
    config: '.vscode/mcp.json',
    key: 'servers',
    seed: { servers: { playwright: { type: 'stdio', command: 'node', args: ['--version'] } }, inputs: [{ id: 'preserved' }] },
  },
};

const OWNED_BLOCK = /# BEGIN artifact-migration-tools\n[\s\S]*?\n# END artifact-migration-tools\n/;
const configFile = (root, provider) => path.join(root, SURFACES[provider].config);
const readConfig = (root, provider) => readFile(configFile(root, provider), 'utf8');
const receiptFile = (root, provider) => path.join(root, '.artifact-migration-tools', `${provider}.json`);
const readReceipt = async (root, provider) => JSON.parse(await readFile(receiptFile(root, provider), 'utf8'));
/** The five fields a reused runtime must carry over exactly. */
const identityOf = receipt => ({
  version: receipt.toolkit.version, commit: receipt.toolkit.commit,
  contentHash: receipt.toolkit.contentHash, release: receipt.release, pin: receipt.pin,
});

async function ownedRegistration(root, provider) {
  const text = await readConfig(root, provider);
  const { key } = SURFACES[provider];
  return key ? JSON.parse(text)[key]?.['start-migration'] ?? null : text.match(OWNED_BLOCK)?.[0] ?? null;
}

/** The registration in the file is exactly the one the receipt proves it owns. */
async function assertReceiptOwnsRegistration(root, provider, receipt) {
  const found = await ownedRegistration(root, provider);
  const expected = SURFACES[provider].key ? receipt.configOwned : receipt.configOwned.replace(/^\n/, '');
  assert.deepEqual(found, expected, `${provider}: registration is not the receipt's`);
}

/** Remove ONLY the toolkit-owned registration, exactly as a regenerating consumer tool would. */
async function deleteOwnedRegistration(root, provider) {
  const file = configFile(root, provider);
  const text = await readFile(file, 'utf8');
  const { key } = SURFACES[provider];
  if (!key) return writeFile(file, text.replace(OWNED_BLOCK, ''));
  const config = JSON.parse(text);
  delete config[key]['start-migration'];
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** Leave a registration at the owned location that the receipt does not prove is ours. */
async function modifyOwnedRegistration(root, provider) {
  const file = configFile(root, provider);
  const text = await readFile(file, 'utf8');
  const { key } = SURFACES[provider];
  if (!key) return writeFile(file, text.replace(/(\[mcp_servers\.start-migration\]\ncommand = )"[^"]*"/, '$1"tampered"'));
  const config = JSON.parse(text);
  config[key]['start-migration'] = { ...config[key]['start-migration'], tamperedByUser: true };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** Seed the unrelated provider configuration that every operation must preserve. */
async function seedConsumer(name, providers = NAMES) {
  const root = path.join(scratch, name);
  await mkdir(root, { recursive: true });
  for (const provider of providers) {
    const { seed } = SURFACES[provider];
    const file = configFile(root, provider);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof seed === 'string' ? seed : `${JSON.stringify(seed, null, 2)}\n`);
  }
  return root;
}

/** Unrelated entries survive; only the owned registration was added. */
async function assertUnrelatedPreserved(root, provider) {
  const { key, seed } = SURFACES[provider];
  const text = await readConfig(root, provider);
  if (!key) {
    assert.equal(text.replace(OWNED_BLOCK, ''), seed, `${provider}: unrelated TOML text/comments not preserved byte for byte`);
    return;
  }
  const config = JSON.parse(text);
  for (const [name, value] of Object.entries(seed)) {
    if (name !== key) { assert.deepEqual(config[name], value, `${provider}: unrelated top-level key ${name} lost`); continue; }
    for (const [server, definition] of Object.entries(value)) {
      assert.deepEqual(config[key][server], definition, `${provider}: unrelated MCP server ${server} lost`);
    }
  }
}

// --- release fixtures -------------------------------------------------------

const NEXT = { version: '1.99.0', commit: '3'.repeat(40), contentHash: `sha256:${'4'.repeat(64)}` };
let built;

/** One staged release, plus a synthetic distinct-identity release for version selection. */
async function fixtures() {
  if (built) return built;
  const base = await buildRelease({ root: await candidateReleaseRoot(scratch), force: true });
  const first = await packageRelease('release one', base.stagingRoot, base.identity.version, null);
  const second = await packageRelease('release two', base.stagingRoot, NEXT.version, NEXT);
  built = { first, second };
  return built;
}

async function packageRelease(name, stagingRoot, version, identity) {
  const home = path.join(scratch, name);
  const bundle = path.join(home, `artifact-migration-tools-${version}`);
  await cp(stagingRoot, bundle, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(bundle, 'release-manifest.json'), 'utf8'));
  if (identity) {
    // Synthetic next-release fixture: the same compatible engine under a second
    // exact identity. Not a publishable release and not a claim about a commit.
    manifest.toolkit = { ...manifest.toolkit, ...identity };
    const restamp = async (relative, value) => {
      const bytes = `${JSON.stringify(value, null, 2)}\n`;
      await writeFile(path.join(bundle, relative), bytes);
      manifest.files[relative] = digest(bytes);
    };
    await restamp('packages/migration-engine/build-identity.json', manifest.toolkit);
    for (const provider of NAMES) {
      const relative = `providers/${provider}/adapter.json`;
      const source = JSON.parse(await readFile(path.join(bundle, relative), 'utf8'));
      source.toolkit = manifest.toolkit; source.engine.version = manifest.toolkit.version;
      await restamp(relative, source);
    }
    await writeFile(path.join(bundle, 'SHA256SUMS'), `${Object.entries(manifest.files).map(([relative, hash]) => `${hash.slice(7)}  ${relative}`).join('\n')}\n`);
    await writeFile(path.join(bundle, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const archive = path.join(home, `artifact-migration-tools-v${version}.tar.gz`);
  await execFileAsync('tar', ['-czf', archive, '-C', home, path.basename(bundle)]);
  return {
    version, archive,
    identity: manifest.toolkit,
    pin: digest(await readFile(path.join(bundle, 'release-manifest.json'))),
    resolved: {
      asset: { name: path.basename(archive), digest: digest(await readFile(archive)), url: 'private://release-asset' },
      commit: manifest.toolkit.commit, version, viaGh: false,
    },
  };
}

/** A transport that fails on any network use, so a passing test proves zero access. */
const OFFLINE = {
  resolve: async () => { throw new Error('network used: release resolution attempted'); },
  download: async () => { throw new Error('network used: asset download attempted'); },
};

const sharedStore = () => path.join(scratch, 'shared release store');

/** Install `provider` from the network, asserting exactly one release download. */
async function install(provider, root, store, release, { version } = {}) {
  let requests = 0;
  const result = await ensureRuntime({ provider, root, store, version }, {
    resolve: async requested => {
      assert.ok(requested === undefined || requested === release.version, `resolver asked for ${requested}`);
      return release.resolved;
    },
    download: async (resolved, destination) => {
      requests++;
      await cp(release.archive, destination);
      await verifyDownloadedAsset(destination, resolved.asset.digest);
    },
  });
  assert.equal(requests, 1, `${provider}: expected exactly one release download`);
  return result;
}

// --- A. fresh provider install ---------------------------------------------

for (const provider of NAMES) {
  test(`A/${provider}: fresh install creates the receipt, the registration and absolute runtime paths`, async () => {
    const { first } = await fixtures();
    const root = await seedConsumer(`fresh ${provider}`);
    const store = path.join(scratch, `fresh ${provider} store`);

    const result = await install(provider, root, store, first);
    assert.equal(result.bootstrapped, true);
    assert.equal(result.reusedFrom, undefined);
    assert.deepEqual(result.toolkit, first.identity);
    assert.equal(result.adapterDoctor.outcome, 'OK');
    assert.equal(result.engineDoctor.outcome, 'OK');
    assert.equal(result.mcpRepair, null);

    const receipt = await readReceipt(root, provider);
    assert.equal(receipt.provider, provider);
    assert.equal(receipt.scope, 'project');
    assert.equal(receipt.mode, 'runtime');
    assert.equal(receipt.release, path.join(store, `${first.version}-${first.pin.slice(7)}`));
    assert.equal(receipt.pin, first.pin);

    // Correct provider surface, and a registration that is exactly the receipt's.
    await assertReceiptOwnsRegistration(root, provider, receipt);
    await assertUnrelatedPreserved(root, provider);

    // Absolute paths under the external store; never PATH, never the consumer.
    for (const argv of Object.values(receipt.commands)) {
      assert.ok(path.isAbsolute(argv[1]), `${provider}: ${argv[1]} is not absolute`);
      assert.ok(argv[1].startsWith(`${receipt.release}${path.sep}`), `${provider}: ${argv[1]} escapes the pinned release`);
    }
    const entry = Array.isArray(receipt.mcp.command) ? receipt.mcp.command[1] : receipt.mcp.args[0];
    assert.ok(entry.startsWith(`${receipt.release}${path.sep}`), `${provider}: MCP entry escapes the pinned release`);
  });
}

// --- B. MCP self-heal matrix -----------------------------------------------

for (const provider of NAMES) {
  test(`B/${provider}: a deleted owned registration is restored; a modified one fails closed`, async () => {
    const { first } = await fixtures();
    const root = await seedConsumer(`selfheal ${provider}`);
    const store = path.join(scratch, `selfheal ${provider} store`);
    await install(provider, root, store, first);

    const installed = await readConfig(root, provider);
    const receipt = await readReceipt(root, provider);

    // 1. A consumer tool regenerated the configuration and dropped our server.
    await deleteOwnedRegistration(root, provider);
    assert.equal(await ownedRegistration(root, provider), null);

    const repaired = await ensureRuntime({ provider, root, store }, OFFLINE);
    assert.equal(repaired.outcome, 'OK');
    assert.equal(repaired.mcpRepair.repaired, true);
    assert.equal(repaired.mcpRepair.server, 'start-migration');
    assert.equal(repaired.mcpRepair.restartRequired, true);
    assert.equal(repaired.mcpRepair.registrationFile, configFile(root, provider));
    assert.equal(await readConfig(root, provider), installed, `${provider}: repair did not restore the exact configuration`);
    assert.deepEqual(identityOf(await readReceipt(root, provider)), identityOf(receipt));
    await assertUnrelatedPreserved(root, provider);
    // Runtime still usable in this process: absolute CLI commands unchanged.
    assert.deepEqual(repaired.commands, receipt.commands);

    // 2. Second ensure is idempotent and reports no repair.
    const settled = await ensureRuntime({ provider, root, store }, OFFLINE);
    assert.equal(settled.mcpRepair, null);
    assert.equal(await readConfig(root, provider), installed);

    // 3. Present at the owned location but different: never overwritten.
    await modifyOwnedRegistration(root, provider);
    const tampered = await readConfig(root, provider);
    await assert.rejects(ensureRuntime({ provider, root, store }, OFFLINE), /modified/i);
    assert.equal(await readConfig(root, provider), tampered, `${provider}: a conflicting registration was overwritten`);
  });
}

// --- C. cross-provider offline reuse, all 12 ordered transitions ------------

for (const source of NAMES) {
  for (const destination of NAMES) {
    if (source === destination) continue;
    test(`C/${source} -> ${destination}: destination reuses the verified runtime with zero network access`, async () => {
      const { first } = await fixtures();
      const root = await seedConsumer(`reuse ${source} to ${destination}`);
      const store = sharedStore();

      await install(source, root, store, first);
      const sourceReceipt = await readReceipt(root, source);
      const sourceConfig = await readConfig(root, source);
      await assert.rejects(stat(receiptFile(root, destination)), { code: 'ENOENT' });

      // Every network path throws. Reaching the assertions below is the proof.
      const reused = await ensureRuntime({ provider: destination, root, store }, OFFLINE);
      assert.equal(reused.outcome, 'OK');
      assert.equal(reused.bootstrapped, true);
      assert.equal(reused.reusedFrom, source);
      assert.equal(reused.adapterDoctor.outcome, 'OK');
      assert.equal(reused.engineDoctor.outcome, 'OK');

      const destinationReceipt = await readReceipt(root, destination);
      assert.deepEqual(identityOf(destinationReceipt), identityOf(sourceReceipt));
      assert.equal(destinationReceipt.provider, destination);

      // The destination's own registration, in its own native format.
      await assertReceiptOwnsRegistration(root, destination, destinationReceipt);
      await assertUnrelatedPreserved(root, destination);
      // The source provider's configuration is not touched by another provider's install.
      assert.equal(await readConfig(root, source), sourceConfig);
    });
  }
}

// --- D. multiple sibling providers ------------------------------------------

test('D1: three agreeing siblings let a fourth provider install entirely offline', async () => {
  const { first } = await fixtures();
  const root = await seedConsumer('siblings agree');
  const store = sharedStore();
  // One network install for the whole consumer; every later provider reuses it.
  await install('claude', root, store, first);
  for (const provider of ['codex', 'opencode', 'copilot']) {
    const reused = await ensureRuntime({ provider, root, store }, OFFLINE);
    assert.equal(reused.bootstrapped, true);
    assert.ok(NAMES.includes(reused.reusedFrom), `${provider}: no sibling reported`);
    assert.equal(reused.adapterDoctor.outcome, 'OK');
  }
  const identities = await Promise.all(NAMES.map(async provider => identityOf(await readReceipt(root, provider))));
  for (const identity of identities) assert.deepEqual(identity, identities[0]);
});

test('a provider configuration regenerated from scratch is repaired without adopting anything else', async () => {
  const { first } = await fixtures();
  for (const provider of NAMES) {
    const root = await seedConsumer(`regenerated ${provider}`);
    const store = sharedStore();
    await install(provider, root, store, first);
    const receipt = await readReceipt(root, provider);

    await rm(configFile(root, provider));
    const repaired = await ensureRuntime({ provider, root, store }, OFFLINE);
    assert.equal(repaired.mcpRepair.repaired, true, provider);
    await assertReceiptOwnsRegistration(root, provider, receipt);
    assert.deepEqual(identityOf(await readReceipt(root, provider)), identityOf(receipt));
    // Idempotent: the restored file validates as ours on the next run.
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair, null, provider);
  }
});

test('D2: siblings that disagree on identity fail closed without writing a receipt or touching config', async () => {
  const { first, second } = await fixtures();
  const root = await seedConsumer('siblings disagree');
  const store = sharedStore();
  await install('claude', root, store, first);
  // An explicit exact version never adopts the sibling's, so this really installs a second identity.
  await install('codex', root, store, second, { version: second.version });
  assert.notEqual((await readReceipt(root, 'claude')).pin, (await readReceipt(root, 'codex')).pin);

  const before = await readConfig(root, 'opencode');
  await assert.rejects(ensureRuntime({ provider: 'opencode', root, store }, OFFLINE), /disagree/i);
  await assert.rejects(stat(receiptFile(root, 'opencode')), { code: 'ENOENT' });
  assert.equal(await readConfig(root, 'opencode'), before);
});

// --- E. explicit version ----------------------------------------------------

for (const destination of NAMES) {
  const [siblingA, siblingB] = NAMES.filter(name => name !== destination);
  test(`E/${destination}: an exact version is never satisfied by a sibling on another version`, async () => {
    const { first, second } = await fixtures();
    const root = await seedConsumer(`exact version ${destination}`);
    const store = sharedStore();
    await install(siblingA, root, store, first);

    // Requested B is not installed here: reuse must be refused and normal
    // release resolution used, never a silent downgrade to the sibling's A.
    await assert.rejects(
      ensureRuntime({ provider: destination, root, store, version: second.version }, OFFLINE),
      /network used/,
    );
    await assert.rejects(stat(receiptFile(root, destination)), { code: 'ENOENT' });

    // With B verified locally through a second sibling, B is reused offline.
    await install(siblingB, root, store, second, { version: second.version });
    const reused = await ensureRuntime({ provider: destination, root, store, version: second.version }, OFFLINE);
    assert.equal(reused.reusedFrom, siblingB);
    assert.equal(reused.toolkit.version, second.version);
    assert.deepEqual(identityOf(await readReceipt(root, destination)), identityOf(await readReceipt(root, siblingB)));
  });
}

// --- F. provider configuration preservation ---------------------------------

test('F: every provider format survives install, self-heal and removal intact', async () => {
  const { first } = await fixtures();
  for (const provider of NAMES) {
    const root = await seedConsumer(`preserve ${provider}`);
    const store = sharedStore();
    const original = await readConfig(root, provider);
    await install(provider, root, store, first);
    await assertUnrelatedPreserved(root, provider);

    await deleteOwnedRegistration(root, provider);
    const repaired = await ensureRuntime({ provider, root, store }, OFFLINE);
    assert.equal(repaired.mcpRepair.repaired, true, provider);
    await assertUnrelatedPreserved(root, provider);
    // Codex: the owned block is restored byte for byte, markers included.
    if (provider === 'codex') assert.match(await readConfig(root, provider), OWNED_BLOCK);

    await adapter(provider, { action: 'remove', scope: 'project', root, store, runtimeOnly: true });
    assert.equal(await readConfig(root, provider), original, `${provider}: removal did not restore the untouched configuration`);
  }
});

// --- G. lifecycle -----------------------------------------------------------

for (const provider of NAMES) {
  test(`G/${provider}: install, doctor, update, rollback and remove keep exact identity`, async () => {
    const { first, second } = await fixtures();
    const root = await seedConsumer(`lifecycle ${provider}`);
    const store = path.join(scratch, `lifecycle ${provider} store`);
    const selection = { scope: 'project', root, store, runtimeOnly: true };
    await install(provider, root, store, first);
    const installed = await readReceipt(root, provider);

    const doctor = await adapter(provider, { ...selection, action: 'doctor' });
    assert.equal(doctor.outcome, 'OK');
    assert.equal(doctor.mcpRepair, null);
    assert.ok(doctor.mcpServers.some(server => server.name === 'start-migration' && server.registered));

    const updated = await install(provider, root, store, second, { version: second.version });
    assert.equal(updated.toolkit.version, second.version);
    await assertUnrelatedPreserved(root, provider);

    const rolled = await adapter(provider, { ...selection, action: 'rollback', bundle: installed.release, pin: installed.pin });
    assert.deepEqual(identityOf(rolled), identityOf(installed));
    await assertReceiptOwnsRegistration(root, provider, rolled);

    // Doctor refuses a conflicting owned state rather than repairing over it.
    await modifyOwnedRegistration(root, provider);
    await assert.rejects(adapter(provider, { ...selection, action: 'doctor' }), /modified/i);
    await deleteOwnedRegistration(root, provider);
    assert.equal((await adapter(provider, { ...selection, action: 'doctor' })).mcpRepair.repaired, true);

    assert.equal((await adapter(provider, { ...selection, action: 'remove' })).removed, true);
    await assert.rejects(stat(receiptFile(root, provider)), { code: 'ENOENT' });
    await assertUnrelatedPreserved(root, provider);
  });
}
