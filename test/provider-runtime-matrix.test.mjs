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
import { replaceSerializedPath } from '../packages/migration-engine/test/support/serialized-path.mjs';

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
  built = { first, second, digests: base.manifest.skills.skills };
  return built;
}

// --- the installed skill's exact identity -----------------------------------
//
// Selection reads a requirement from the skill beside the bootstrap, so every
// scenario states one. Injected through the same `deps` object as
// `resolve`/`download`; held in one place and set per scenario rather than
// threaded through every call site. Both synthetic releases publish the same
// canonical skills, so the version is what distinguishes which one satisfies.

let requiredSkill = null;
const skillRelease = async () => requiredSkill;

/** Require `version`, proving the staged bundle's real canonical skill digest. */
async function requiring(version, skill = 'start-migration') {
  const { digests } = await fixtures();
  requiredSkill = { name: 'artifact-migration-tools', version, skill, computedHash: digests[skill].computedHash, source: 'repository' };
  return requiredSkill;
}

async function packageRelease(name, stagingRoot, version, identity, skillDigest = null) {
  const home = path.join(scratch, name);
  const bundle = path.join(home, `artifact-migration-tools-${version}`);
  await cp(stagingRoot, bundle, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(bundle, 'release-manifest.json'), 'utf8'));
  if (skillDigest) {
    // A release publishing *different* skill semantics. `release-manifest.json`
    // is not one of its own `files` entries, so only the pin moves: every
    // per-file checksum and SHA256SUMS line stays valid. That is what makes a
    // second skill identity expressible without rebuilding the bundle.
    for (const skill of Object.keys(manifest.skills.skills)) manifest.skills.skills[skill].computedHash = skillDigest;
    await writeFile(path.join(bundle, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
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
  skillRelease,
};

/**
 * A store shared between the providers of ONE consumer, derived from its root.
 *
 * Deliberately not shared across tests any more: the release store is a
 * first-class local selection source now, so a store carrying another test's
 * release would serve an install offline and no test could still assert that
 * the network path ran. Sibling reuse only ever needed the providers of a
 * single consumer to agree on a store, which this still gives them.
 */
const sharedStore = root => `${root} store`;

/** Install `provider` from the network, asserting exactly one release download. */
async function install(provider, root, store, release, { version } = {}) {
  let requests = 0;
  await requiring(release.version);
  const result = await ensureRuntime({ provider, root, store, version }, {
    resolve: async requested => {
      assert.equal(requested, release.version, `resolver asked for ${requested}`);
      return release.resolved;
    },
    download: async (resolved, destination) => {
      requests++;
      await cp(release.archive, destination);
      await verifyDownloadedAsset(destination, resolved.asset.digest);
    },
    skillRelease,
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

for (const provider of NAMES) {
  test(`B-stale/${provider}: verified history converges; unproven or modified history stays blocked`, async () => {
    const { first, second } = await fixtures();
    const root = await seedConsumer(`stale ${provider}`);
    const store = path.join(scratch, `stale ${provider} store`);
    await install(provider, root, store, first);
    const old = await readReceipt(root, provider);
    await install(provider, root, store, second, { version: second.version });
    const current = await readReceipt(root, provider);
    const native = await readConfig(root, provider);
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair, null);
    assert.equal(await readConfig(root, provider), native);
    await assert.rejects(stat(path.join(root, '.agents')), { code: 'ENOENT' });

    const writeRegistration = async value => {
      const file = configFile(root, provider);
      if (SURFACES[provider].key) {
        const config = JSON.parse(native);
        config[SURFACES[provider].key]['start-migration'] = value;
        await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
      } else await writeFile(file, native.replace(OWNED_BLOCK, value));
    };
    const oldEntry = SURFACES[provider].key ? old.mcp : old.configOwned.replace(/^\n/, '');
    await writeRegistration(oldEntry);
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair.repaired, true);
    await assertReceiptOwnsRegistration(root, provider, current);
    await assertUnrelatedPreserved(root, provider);
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair, null);

    await writeRegistration(oldEntry);
    const receipt = await readReceipt(root, provider);
    receipt.releases = receipt.releases.filter(item => item.release !== old.release);
    await writeFile(receiptFile(root, provider), `${JSON.stringify(receipt, null, 2)}\n`);
    const unproven = await readConfig(root, provider);
    await assert.rejects(ensureRuntime({ provider, root, store }, OFFLINE), /modified/i);
    assert.equal(await readConfig(root, provider), unproven);
    await writeFile(receiptFile(root, provider), `${JSON.stringify(current, null, 2)}\n`);

    const sums = path.join(old.release, 'SHA256SUMS');
    const validSums = await readFile(sums);
    await writeFile(sums, 'invalid\n');
    await assert.rejects(ensureRuntime({ provider, root, store }, OFFLINE), /modified/i);
    assert.equal(await readConfig(root, provider), unproven);
    await writeFile(sums, validSums);

    for (const kind of ['path', 'args', 'extra', 'foreign']) {
      let changed;
      if (SURFACES[provider].key) {
        changed = structuredClone(oldEntry);
        if (kind === 'path') {
          if (Array.isArray(changed.command)) changed.command[1] = '/foreign/mcp-server.mjs';
          else changed.args[0] = '/foreign/mcp-server.mjs';
        } else if (kind === 'args') {
          if (Array.isArray(changed.command)) changed.command.push('--changed');
          else changed.args.push('--changed');
        } else if (kind === 'extra') changed.unowned = true;
        else changed.command = 'foreign';
      } else {
        changed = kind === 'path' ? replaceSerializedPath(oldEntry, old.release, '/foreign')
          : kind === 'args' ? oldEntry.replace(/(args = \[[^\n]*)(\]\n)/, '$1, "--changed"$2')
            : kind === 'extra' ? oldEntry.replace(OWNED_BLOCK, match => match.replace('# END', 'extra = true\n# END'))
              : oldEntry.replace(/command = "[^"]*"/, 'command = "foreign"');
      }
      assert.notEqual(changed, oldEntry, `${provider}/${kind}: tamper did not change the registration`);
      await writeRegistration(changed);
      const before = await readConfig(root, provider);
      await assert.rejects(ensureRuntime({ provider, root, store }, OFFLINE), /modified|conflict/i, `${provider}/${kind}`);
      assert.equal(await readConfig(root, provider), before, `${provider}/${kind}`);
    }
    if (SURFACES[provider].key) {
      const duplicate = native.replace('"start-migration":', '"start-migration": {"command":"foreign"}, "start-migration":');
      await writeFile(configFile(root, provider), duplicate);
      await assert.rejects(ensureRuntime({ provider, root, store }, OFFLINE), /modified|conflict/i, `${provider}/duplicate`);
    }

    await writeRegistration(SURFACES[provider].key ? current.mcp : current.configOwned.replace(/^\n/, ''));
    const agentsFile = path.join(root, '.agents/mcp.json');
    await mkdir(path.dirname(agentsFile), { recursive: true });
    const launch = receipt => ({ command: process.execPath, args: [path.join(receipt.release, 'packages/migration-engine/src/mcp-server.mjs')] });
    const agents = { mcpServers: { other: { command: 'other', args: [], targets: ['claude'] }, 'start-migration': { ...launch(current), targets: [provider, 'antigravity'] } }, keep: { untouched: true } };
    await writeFile(agentsFile, JSON.stringify(agents));
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair, null);
    assert.equal(await readFile(agentsFile, 'utf8'), JSON.stringify(agents));
    agents.mcpServers['start-migration'] = { ...launch(old), targets: [provider, 'antigravity'] };
    await writeFile(agentsFile, JSON.stringify(agents));
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair.repaired, true);
    const settled = JSON.parse(await readFile(agentsFile, 'utf8'));
    assert.deepEqual(settled, { ...agents, mcpServers: { ...agents.mcpServers, 'start-migration': { ...launch(current), targets: [provider, 'antigravity'] } } });
    const settledBytes = await readFile(agentsFile, 'utf8');
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair, null);
    assert.equal(await readFile(agentsFile, 'utf8'), settledBytes);

    for (const kind of ['path', 'args', 'extra', 'foreign']) {
      const changed = structuredClone(agents);
      const entry = changed.mcpServers['start-migration'];
      if (kind === 'path') entry.args[0] = '/foreign/mcp-server.mjs';
      else if (kind === 'args') entry.args.push('--changed');
      else if (kind === 'extra') entry.unowned = true;
      else entry.command = 'foreign';
      const before = JSON.stringify(changed);
      await writeFile(agentsFile, before);
      await assert.rejects(ensureRuntime({ provider, root, store }, OFFLINE), /modified|conflict/i, `${provider}/.agents/${kind}`);
      assert.equal(await readFile(agentsFile, 'utf8'), before);
    }
    const ambiguous = settledBytes.replace('"start-migration":', '"start-migration":{"command":"foreign"},"start-migration":');
    await writeFile(agentsFile, ambiguous);
    await assert.rejects(ensureRuntime({ provider, root, store }, OFFLINE), /modified|conflict/i, `${provider}/.agents/duplicate`);
    assert.equal(await readFile(agentsFile, 'utf8'), ambiguous);
  });
}

// --- C. cross-provider offline reuse, all 12 ordered transitions ------------

for (const source of NAMES) {
  for (const destination of NAMES) {
    if (source === destination) continue;
    test(`C/${source} -> ${destination}: destination reuses the verified runtime with zero network access`, async () => {
      const { first } = await fixtures();
      const root = await seedConsumer(`reuse ${source} to ${destination}`);
      const store = sharedStore(root);

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
  const store = sharedStore(root);
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

/**
 * The other half of D1: siblings that all agree with *each other* but do not
 * satisfy the requirement. Agreement among siblings was never the question --
 * whether they carry the identity the installed skill requires is. Four
 * agreeing siblings on the wrong release are four non-candidates, so the
 * requirement is met normally instead of adopted from them.
 */
test('D1b: siblings that agree with each other but do not satisfy the requirement are not candidates', async () => {
  const { first, second } = await fixtures();
  const root = await seedConsumer('siblings agree wrongly');
  const store = sharedStore(root);
  await install('claude', root, store, first);
  for (const provider of ['codex', 'opencode']) {
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).bootstrapped, true);
  }
  // All three agree on `first`. The skill now requires `second`, which no
  // sibling has and the store does not hold.
  await requiring(second.version);
  const error = await ensureRuntime({ provider: 'copilot', root, store }, OFFLINE).then(() => null, e => e);
  assert.doesNotMatch(error.message, /disagree/i, 'agreement among siblings is not the question');
  assert.match(error.message, /network used/);
  await assert.rejects(stat(receiptFile(root, 'copilot')), { code: 'ENOENT' });

  // Given the network, it installs the required release and does not adopt the
  // three agreeing siblings' older one.
  const installed = await install('copilot', root, store, second);
  assert.equal(installed.toolkit.version, second.version);
  assert.equal(installed.reusedFrom, undefined);
  // And the stale siblings are untouched until each converges on its own.
  assert.equal((await readReceipt(root, 'claude')).toolkit.version, first.version);
});

test('a provider configuration regenerated from scratch is repaired without adopting anything else', async () => {
  const { first } = await fixtures();
  for (const provider of NAMES) {
    const root = await seedConsumer(`regenerated ${provider}`);
    const store = sharedStore(root);
    await install(provider, root, store, first);
    const receipt = await readReceipt(root, provider);

    await rm(configFile(root, provider));
    const repaired = await ensureRuntime({ provider, root, store }, OFFLINE);
    assert.equal(repaired.mcpRepair.repaired, true, provider);
    await assertReceiptOwnsRegistration(root, provider, receipt);
    assert.deepEqual(identityOf(await readReceipt(root, provider)), identityOf(receipt));
    // The restored path belongs to the release the receipt actually selects.
    // Restoring `configOwned` is only correct for the *installed* version, and
    // the receipt now reaches the doctor already converged, so a restored path
    // is always the current one.
    const entry = await ownedRegistration(root, provider);
    assert.ok(JSON.stringify(entry).includes(JSON.stringify(receipt.release).slice(1, -1)), `${provider}: the restored registration does not name the selected release`);
    // Idempotent: the restored file validates as ours on the next run.
    assert.equal((await ensureRuntime({ provider, root, store }, OFFLINE)).mcpRepair, null, provider);
  }
});

/**
 * D2, replaced. Siblings on *different releases* used to be a hard error, which
 * blocked a new provider in any consumer whose existing providers had drifted
 * apart -- the common real state, and one the user cannot fix without deleting
 * receipts. They are now simply other releases: filtered out by the acceptance
 * predicate and ignored, with the requirement met normally.
 *
 * The tripwire survives for what it was actually for: two candidates that both
 * claim to satisfy the *same* requirement while disagreeing on immutable
 * release identity. That is only reachable under tampering or a
 * release-discipline breach, and it still fails closed.
 */
test('D2a: siblings on different releases are not candidates and do not block a new provider', async () => {
  const { first, second } = await fixtures();
  const root = await seedConsumer('siblings differ');
  const store = sharedStore(root);
  await install('claude', root, store, first);
  // An explicit exact version never adopts the sibling's, so this really installs a second identity.
  await install('codex', root, store, second, { version: second.version });
  assert.notEqual((await readReceipt(root, 'claude')).pin, (await readReceipt(root, 'codex')).pin);

  // The requirement names `first`, which exactly one sibling happens to carry.
  await requiring(first.version);
  const reused = await ensureRuntime({ provider: 'opencode', root, store }, OFFLINE);
  assert.equal(reused.reusedFrom, 'claude');
  assert.deepEqual(identityOf(await readReceipt(root, 'opencode')), identityOf(await readReceipt(root, 'claude')));

  // And a requirement neither sibling satisfies is met from the store, still
  // offline, still without any complaint about the siblings disagreeing.
  await requiring(second.version);
  const converged = await ensureRuntime({ provider: 'copilot', root, store }, OFFLINE);
  assert.equal(converged.toolkit.version, second.version);
  assert.equal(converged.network, false);
});

test('D2b: two candidates claiming one requirement with different release identities fail closed', async () => {
  const { first } = await fixtures();
  const root = await seedConsumer('siblings disagree');
  const store = sharedStore(root);
  await install('claude', root, store, first);
  // The store already carries `first`, so codex comes up from the sibling with
  // no download -- which is the point of C/D1 and is simply the setup here.
  assert.equal((await ensureRuntime({ provider: 'codex', root, store }, OFFLINE)).toolkit.version, first.version);

  // Forge a second release carrying the same version and the same skill digests
  // under a different immutable identity, and point one sibling at it. Only
  // tampering or a discipline breach produces this, and it must never be
  // resolved by picking a winner.
  const forged = await packageRelease('forged release', path.join(scratch, 'release one', `artifact-migration-tools-${first.version}`), first.version, { commit: '9'.repeat(40), contentHash: `sha256:${'8'.repeat(64)}` });
  const staged = path.join(store, `${first.version}-${forged.pin.slice(7)}`);
  await cp(path.join(scratch, 'forged release', `artifact-migration-tools-${first.version}`), staged, { recursive: true });
  const receipt = await readReceipt(root, 'codex');
  await writeFile(receiptFile(root, 'codex'), `${JSON.stringify({ ...receipt, toolkit: forged.identity, release: staged, pin: forged.pin, releases: [{ release: staged, pin: forged.pin }] }, null, 2)}\n`);

  await requiring(first.version);
  const before = await readConfig(root, 'opencode');
  await assert.rejects(ensureRuntime({ provider: 'opencode', root, store }, OFFLINE), /disagree/i);
  await assert.rejects(stat(receiptFile(root, 'opencode')), { code: 'ENOENT' });
  assert.equal(await readConfig(root, 'opencode'), before);
});

/**
 * T6. The live regression: two providers stranded on different stale releases,
 * one required identity. Both converge, neither downgrades, and the sibling
 * disagreement that used to stop the whole consumer never fires.
 */
test('T6: two providers on different stale releases both converge on the required identity', async () => {
  const { first, second } = await fixtures();
  const root = await seedConsumer('stale providers converge');
  const store = sharedStore(root);
  await install('claude', root, store, first);
  await install('codex', root, store, second, { version: second.version });

  // The skill requires `second`; claude is behind and codex is already there.
  await requiring(second.version);
  const moved = await ensureRuntime({ provider: 'claude', root, store }, OFFLINE);
  assert.equal(moved.bootstrapped, true);
  assert.equal(moved.toolkit.version, second.version);
  assert.equal(moved.network, false);
  const settled = await ensureRuntime({ provider: 'codex', root, store }, OFFLINE);
  assert.equal(settled.bootstrapped, false);
  assert.equal(settled.toolkit.version, second.version);

  for (const provider of ['claude', 'codex']) {
    const receipt = await readReceipt(root, provider);
    assert.equal(receipt.toolkit.version, second.version, `${provider} did not converge`);
    await assertReceiptOwnsRegistration(root, provider, receipt);
    await assertUnrelatedPreserved(root, provider);
  }
  // The release claude came from is retained, so nothing was lost by converging.
  assert.ok((await readReceipt(root, 'claude')).releases.some(item => item.release.endsWith(`${first.version}-${first.pin.slice(7)}`)));
});

/**
 * T22. A sibling at the required *version* whose pinned manifest proves a
 * different skill digest is not a candidate. This is the case-N guard at the
 * sibling boundary: without it, a provider switch silently adopts bytes that
 * are not the ones the installed skill was written against.
 */
test('T22: a sibling with the right version but the wrong skill identity cannot satisfy selection', async () => {
  const { first } = await fixtures();
  const root = await seedConsumer('sibling wrong identity');
  const store = sharedStore(root);
  await install('claude', root, store, first);

  await requiring(first.version);
  requiredSkill.computedHash = 'c'.repeat(64);
  // The sibling is at the right version, so a version-only filter would adopt
  // it. Selection must fall through to the network instead -- and must not
  // complain that siblings disagree, because they do not.
  const error = await ensureRuntime({ provider: 'opencode', root, store }, OFFLINE).then(() => null, e => e);
  assert.doesNotMatch(error.message, /disagree/i);
  assert.match(error.message, /network used/);
  await assert.rejects(stat(receiptFile(root, 'opencode')), { code: 'ENOENT' });
});

/**
 * T10. A rollback is an explicit operator decision and would be meaningless if
 * the next ordinary invocation undid it -- so it persists, is reported every
 * single time, and is superseded by the operator's next deliberate skill
 * action rather than by editing a receipt.
 */
test('T10: an explicit rollback persists a scoped pin that a skill-identity change supersedes', async () => {
  const { first, second } = await fixtures();
  const root = await seedConsumer('rollback pin');
  const store = sharedStore(root);
  const selection = { scope: 'project', root, store, runtimeOnly: true };
  await install('codex', root, store, first);
  const installed = await readReceipt(root, 'codex');
  await requiring(second.version);
  await ensureRuntime({ provider: 'codex', root, store }, { ...OFFLINE, resolve: async () => second.resolved, download: async (resolved, destination) => { await cp(second.archive, destination); await verifyDownloadedAsset(destination, resolved.asset.digest); } });

  const rolled = await adapter('codex', { ...selection, action: 'rollback', bundle: installed.release, pin: installed.pin });
  assert.deepEqual(identityOf(rolled), identityOf(installed));
  assert.equal(rolled.pinned.by, 'rollback');
  assert.equal(rolled.pinned.version, first.version);
  assert.deepEqual(rolled.pinned.againstSkill['start-migration'], { skill: 'start-migration', version: second.version, computedHash: requiredSkill.computedHash });

  // The pin holds across ordinary invocations, reported every time, no network.
  for (let run = 0; run < 2; run++) {
    const pinned = await ensureRuntime({ provider: 'codex', root, store }, OFFLINE);
    assert.equal(pinned.selection, 'pinned');
    assert.equal(pinned.skillIdentity, 'pinned');
    assert.equal(pinned.toolkit.version, first.version);
    assert.equal(pinned.bootstrapped, false);
  }

  // A newer deliberate skill action -- `skills add` of a release publishing
  // different skill semantics -- supersedes the pin. The pin was a decision
  // about the identity in place at the time, not an eternal veto.
  const third = await packageRelease('release three', path.join(scratch, 'release one', `artifact-migration-tools-${first.version}`), '1.98.0', { version: '1.98.0', commit: '5'.repeat(40), contentHash: `sha256:${'6'.repeat(64)}` }, 'd'.repeat(64));
  await requiring('1.98.0');
  requiredSkill.computedHash = 'd'.repeat(64);
  const converged = await ensureRuntime({ provider: 'codex', root, store }, {
    resolve: async requested => { assert.equal(requested, '1.98.0'); return third.resolved; },
    download: async (resolved, destination) => { await cp(third.archive, destination); await verifyDownloadedAsset(destination, resolved.asset.digest); },
    skillRelease,
  });
  assert.equal(converged.selection, 'skill', 'a changed skill identity must supersede the pin');
  assert.equal(converged.skillIdentity, 'required');
  assert.equal(converged.toolkit.version, '1.98.0');
  assert.equal((await readReceipt(root, 'codex')).pinned, undefined, 'a superseded pin must not survive the write');

  // And the supersession is not a downgrade loophole: with the pin gone, the
  // skill's own requirement is the only authority, so a requirement no release
  // proves fails closed instead of falling back to the pinned release.
  await requiring('1.98.0');
  requiredSkill.computedHash = 'a'.repeat(64);
  const unproven = await ensureRuntime({ provider: 'codex', root, store }, {
    resolve: async () => third.resolved,
    download: async (resolved, destination) => { await cp(third.archive, destination); await verifyDownloadedAsset(destination, resolved.asset.digest); },
    skillRelease,
  }).then(() => null, e => e);
  assert.equal(unproven.code, 'SKILL_IDENTITY_UNRELEASED');
  assert.equal((await readReceipt(root, 'codex')).toolkit.version, '1.98.0', 'a refusal must not move the receipt');
});

/**
 * T13. Every tampering boundary still fails closed, including the new one: the
 * receipt's copy of the release's skill digests is a convenience, never a
 * second authority, so hand-editing it cannot fake the binding either way.
 */
test('T13: tampering is refused at every boundary, including a hand-edited receipt.skills', async () => {
  const { first } = await fixtures();
  const root = await seedConsumer('tampered receipt');
  const store = sharedStore(root);
  await install('codex', root, store, first);
  const receipt = await readReceipt(root, 'codex');

  const forged = structuredClone(receipt);
  forged.skills.skills['start-migration'].computedHash = 'e'.repeat(64);
  await writeFile(receiptFile(root, 'codex'), `${JSON.stringify(forged, null, 2)}\n`);
  await requiring(first.version);
  await assert.rejects(ensureRuntime({ provider: 'codex', root, store }, OFFLINE), /skill identity conflict/i);

  // A receipt predating the field is proven from the pinned manifest instead,
  // so the added check invalidates nothing that was already valid.
  const { skills, ...legacy } = receipt;
  await writeFile(receiptFile(root, 'codex'), `${JSON.stringify(legacy, null, 2)}\n`);
  const reused = await ensureRuntime({ provider: 'codex', root, store }, OFFLINE);
  assert.equal(reused.bootstrapped, false);

  // The pinned manifest itself is still the anchor.
  await writeFile(receiptFile(root, 'codex'), `${JSON.stringify(receipt, null, 2)}\n`);
  const manifestFile = path.join(receipt.release, 'release-manifest.json');
  const valid = await readFile(manifestFile);
  await writeFile(manifestFile, `${valid.toString('utf8').replace(/\n$/, '')} \n`);
  try {
    await assert.rejects(ensureRuntime({ provider: 'codex', root, store }, OFFLINE), /checksum mismatch/i);
  } finally {
    await writeFile(manifestFile, valid);
  }
});

// --- E. explicit version ----------------------------------------------------

for (const destination of NAMES) {
  const [siblingA, siblingB] = NAMES.filter(name => name !== destination);
  test(`E/${destination}: an exact version is never satisfied by a sibling on another version`, async () => {
    const { first, second } = await fixtures();
    const root = await seedConsumer(`exact version ${destination}`);
    const store = sharedStore(root);
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
  const { first, second } = await fixtures();
  for (const provider of NAMES) {
    const root = await seedConsumer(`preserve ${provider}`);
    const store = sharedStore(root);
    const original = await readConfig(root, provider);
    await install(provider, root, store, first);
    await assertUnrelatedPreserved(root, provider);

    // T4/T5, in all four native formats: a converging update rewrites the
    // provider-owned MCP registration in the same lock, and leaves no owned
    // path anywhere under the release it just left.
    const stale = await readReceipt(root, provider);
    await requiring(second.version);
    const updated = await ensureRuntime({ provider, root, store }, {
      resolve: async requested => { assert.equal(requested, second.version); return second.resolved; },
      download: async (resolved, destination) => { await cp(second.archive, destination); await verifyDownloadedAsset(destination, resolved.asset.digest); },
      skillRelease,
    });
    assert.equal(updated.toolkit.version, second.version, provider);
    const converged = await readReceipt(root, provider);
    await assertReceiptOwnsRegistration(root, provider, converged);
    await assertUnrelatedPreserved(root, provider);
    for (const relative of [...Object.keys(converged.files), SURFACES[provider].config]) {
      const text = await readFile(path.join(root, relative), 'utf8');
      assert.ok(!text.includes(JSON.stringify(stale.release).slice(1, -1)), `${provider}: ${relative} still names the previous release`);
    }
    // Converge back so the removal assertion below reads the first release.
    await requiring(first.version);
    await ensureRuntime({ provider, root, store }, OFFLINE);

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
