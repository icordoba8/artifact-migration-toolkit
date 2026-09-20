import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { adapter, digest, verifyBundle } from '../providers/install-support.mjs';
import { buildRelease } from '../scripts/release.mjs';
import { createUnstampedRecord } from '../packages/migration-engine/test/support/consumer-fixture.mjs';

const canonicalSkills = JSON.parse(await readFile(new URL('../skills-lock.json', import.meta.url)));
const frontmatter = text => text.slice(0, text.indexOf('\n---\n') + 5);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'provider acceptance with spaces '));
after(() => rm(scratch, { recursive: true, force: true }));
let releases;
let childId = 0;
async function bundles() {
  if (releases) return releases;
  const built = await buildRelease({ force: true });
  const first = path.join(scratch, 'release one');
  await cp(built.stagingRoot, first, { recursive: true });
  const pin = digest(await readFile(path.join(first, 'release-manifest.json')));
  // Synthetic next-release fixture: same compatible engine, distinct identity.
  // This is not a publishable release or a claim about a second Git commit.
  const second = path.join(scratch, 'release two');
  await cp(first, second, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(second, 'release-manifest.json')));
  manifest.toolkit = { ...manifest.toolkit, version: '1.1.1', commit: '1'.repeat(40), contentHash: `sha256:${'2'.repeat(64)}` };
  const replace = async (relative, value) => {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path.join(second, relative), bytes);
    manifest.files[relative] = digest(bytes);
  };
  await replace('packages/migration-engine/build-identity.json', manifest.toolkit);
  for (const provider of ['claude', 'codex', 'opencode', 'copilot']) {
    const file = `providers/${provider}/adapter.json`;
    const source = JSON.parse(await readFile(path.join(second, file)));
    source.toolkit = manifest.toolkit; source.engine.version = manifest.toolkit.version;
    await replace(file, source);
  }
  await writeFile(path.join(second, 'SHA256SUMS'), `${Object.entries(manifest.files).map(([relative, hash]) => `${hash.slice(7)}  ${relative}`).join('\n')}\n`);
  await writeFile(path.join(second, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  releases = { first, pin, second, nextPin: digest(await readFile(path.join(second, 'release-manifest.json'))), identity: built.identity };
  return releases;
}
// Regular files avoid the Node 24 anonymous-pipe output loss exercised by this harness.
const capture = async (command, args, cwd) => {
  const id = childId++;
  const stdoutPath = path.join(scratch, `child-${id}.stdout`);
  const stderrPath = path.join(scratch, `child-${id}.stderr`);
  const stdoutFile = await open(stdoutPath, 'w');
  const stderrFile = await open(stderrPath, 'w');
  let code;
  try {
    const child = spawn(command, args, { cwd, stdio: ['ignore', stdoutFile.fd, stderrFile.fd] });
    code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
  } finally {
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }
  return { code, stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8') };
};
const run = async (receipt, name, args, cwd) => {
  const [command, ...prefix] = receipt.commands[name];
  const result = await capture(command, [...prefix, ...args], cwd);
  return { code: result.code, output: `${result.stdout}${result.stderr}` };
};
const advance = async (receipt, cwd) => {
  const preview = await run(receipt, 'artifact-migration-advance', ['auth'], cwd);
  const id = preview.output.match(/Confirmation ID: ([0-9a-f]+)/)?.[1];
  return id ? run(receipt, 'artifact-migration-advance', ['auth', '--confirm-advance', id], cwd) : preview;
};
async function mcpStatus(receipt, cwd) {
  const [command, ...args] = Array.isArray(receipt.mcp.command) ? receipt.mcp.command : [receipt.mcp.command, ...receipt.mcp.args];
  const id = childId++;
  const inputPath = path.join(scratch, `child-${id}.stdin`);
  const outputPath = path.join(scratch, `child-${id}.stdout`);
  const errorPath = path.join(scratch, `child-${id}.stderr`);
  await writeFile(inputPath,
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'provider-acceptance', version: '1' } } })}\n` +
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'migration_status', arguments: { module: 'auth' } } })}\n`);
  const input = await open(inputPath, 'r');
  const output = await open(outputPath, 'w');
  const errors = await open(errorPath, 'w');
  let code;
  try {
    const child = spawn(command, args, { cwd, stdio: [input.fd, output.fd, errors.fd] });
    code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('MCP startup timeout')); }, 15000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
  } finally {
    await Promise.all([input.close(), output.close(), errors.close()]);
  }
  const errorText = await readFile(errorPath, 'utf8');
  if (code !== 0) throw new Error(`MCP exit ${code}: ${errorText}`);
  const response = (await readFile(outputPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 2);
  if (!response) throw new Error(`MCP returned no status response: ${errorText}`);
  return response;
}

for (const provider of ['claude', 'codex', 'opencode', 'copilot']) {
  for (const scope of provider === 'copilot' ? ['project'] : ['user', 'project']) {
    test(`${provider}/${scope}: pinned install, CLI/MCP status, update gate, rollback, safe removal`, async t => {
      const b = await bundles();
      const consumer = await createUnstampedRecord({ prefix: `${provider} consumer with spaces ` });
      t.after(() => consumer.cleanup());
      await consumer.authorDiscoverLegacy();
      const root = scope === 'project' && provider !== 'claude' ? consumer.root : path.join(scratch, `${provider} ${scope} host root`);
      const options = { scope, root, store: path.join(scratch, 'shared engine store'), bundle: b.first, pin: b.pin };
      const receipt = await adapter(provider, options);
      assert.deepEqual(receipt.toolkit, b.identity);
      // Every row reports the one toolkit identity *and* the canonical skill
      // hashes: same skills, not merely same engine.
      assert.deepEqual(receipt.skills, canonicalSkills);
      // Both invocation surfaces as installed. Bodies are rendered to absolute
      // engine paths; the frontmatter that makes a surface discoverable is the
      // exact provider projection and survives installation byte for byte.
      const wrappers = provider === 'opencode' ? 'commands' : 'prompts';
      const surfaces = new Set();
      for (const relative of Object.keys(receipt.files)) {
        assert.ok(!/\.(mjs|js|ts)$/.test(relative) || relative.endsWith('/scripts/runtime.mjs'), relative);
        const text = await readFile(path.join(root, relative), 'utf8');
        assert.ok(!text.includes('{{ENGINE_MCP_ENTRY}}'), relative);
        const skill = relative.match(/(?:^|\/)(start-migration|migrate-artifact)\/(.+)$/);
        if (skill) {
          if (!relative.endsWith('SKILL.md')) continue;
          assert.match(text, /status/i);
          if (provider === 'claude') assert.match(text, /^user-invocable: true$/m);
          surfaces.add(`skill:${skill[1]}`);
          assert.equal(frontmatter(text), frontmatter(await readFile(
            path.join(b.first, `providers/${provider}/skills/${skill[1]}/${skill[2]}`), 'utf8')), relative);
        } else if (relative.endsWith('.md')) {
          const name = path.basename(relative).replace(/(\.prompt)?\.md$/, '');
          assert.ok(text.includes(`\`${name}\``), `${relative} must load its skill`);
          surfaces.add(`wrapper:${name}`);
          assert.equal(frontmatter(text), frontmatter(await readFile(
            path.join(b.first, `providers/${provider}/${wrappers}/${path.basename(relative)}`), 'utf8')), relative);
        }
      }
      for (const name of ['start-migration', 'migrate-artifact']) {
        assert.ok(surfaces.has(`skill:${name}`), `${name} skill not installed`);
        // Claude invokes the native skill directly: no duplicate prompt wrapper.
        assert.equal(surfaces.has(`wrapper:${name}`), provider !== 'claude', `${name} wrapper`);
      }
      const doctor = await adapter(provider, { ...options, action: 'doctor' });
      assert.equal(doctor.outcome, 'OK');
      assert.equal(doctor.scope, scope);
      const before = await consumer.snapshot();
      const status = await run(receipt, 'artifact-migration-toolkit', ['status', '--module', 'auth'], consumer.root);
      assert.equal(status.code, 0, status.output);
      assert.equal(JSON.parse(status.output).toolkitIdentityStatus, 'UNSTAMPED');
      const mcp = await mcpStatus(receipt, consumer.root);
      assert.equal(mcp.error, undefined, JSON.stringify(mcp));
      assert.ok(!mcp.result.isError, JSON.stringify(mcp));
      assert.deepEqual(mcp.result.structuredContent.activeToolkitIdentity, receipt.toolkit);
      assert.deepEqual(JSON.parse(status.output).activeToolkitIdentity, receipt.toolkit);
      assert.deepEqual(await consumer.snapshot(), before);
      const adopted = await run(receipt, 'artifact-migration-toolkit', ['adopt', '--module', 'auth'], consumer.root);
      assert.equal(adopted.code, 0, adopted.output);
      const pinned = await consumer.snapshot();
      const next = await adapter(provider, { ...options, action: 'update', bundle: b.second, pin: b.nextPin });
      const blocked = await advance(next, consumer.root);
      assert.notEqual(blocked.code, 0, blocked.output);
      assert.match(blocked.output, /toolkit/i);
      assert.deepEqual(await consumer.snapshot(), pinned);
      const updated = await run(next, 'artifact-migration-toolkit', ['update', '--module', 'auth'], consumer.root);
      assert.equal(updated.code, 0, updated.output);
      const rollback = await adapter(provider, { ...options, action: 'rollback' });
      assert.notEqual((await advance(rollback, consumer.root)).code, 0);
      const rolled = await run(rollback, 'artifact-migration-toolkit', ['rollback', '--module', 'auth'], consumer.root);
      assert.equal(rolled.code, 0, rolled.output);
      const restored = await consumer.snapshot();
      assert.deepEqual(restored.state.toolkitIdentity, receipt.toolkit);
      assert.equal(restored.state.currentStep, pinned.state.currentStep);
      assert.equal(restored.decisions, pinned.decisions);
      const resumed = await advance(rollback, consumer.root);
      assert.equal(resumed.code, 0, resumed.output);
      assert.equal((await consumer.snapshot()).state.currentStep, 'DISCOVERY_COMPLETENESS');
      await writeFile(path.join(root, 'unrelated.txt'), 'preserve me');
      const state = await consumer.snapshot();
      await adapter(provider, { ...options, action: 'remove' });
      assert.equal(await readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'preserve me');
      assert.deepEqual(await consumer.snapshot(), state);
      for (const relative of Object.keys(receipt.files)) await assert.rejects(readFile(path.join(root, relative)), { code: 'ENOENT' });
      await verifyBundle(receipt.release, b.pin); // rollback assets retained
    });
  }
}

test('R-W9-a / R-W9-c: installed MCP is launchable; doctor preserves and reports consumer MCP without launching it', async t => {
  const b = await bundles();
  const consumer = await createUnstampedRecord({ prefix: 'provider MCP proofs ' });
  t.after(() => consumer.cleanup());
  const config = path.join(consumer.root, '.vscode/mcp.json');
  await mkdir(path.dirname(config), { recursive: true });
  const browser = { command: process.execPath, args: ['--version'] };
  const figma = { type: 'http', url: 'https://example.invalid/mcp' };
  await writeFile(config, JSON.stringify({ servers: { playwright: browser, figma }, inputs: [{ id: 'preserved' }] }));
  const options = { scope: 'project', root: consumer.root, store: path.join(scratch, 'proof store'), bundle: b.first, pin: b.pin };
  const installed = await adapter('copilot', options);
  const before = await readFile(config, 'utf8');
  const doctor = await adapter('copilot', { ...options, action: 'doctor' });
  for (const name of ['playwright', 'figma', 'start-migration']) assert.equal(doctor.mcpServers.find(item => item.name === name).registered, true);
  assert.equal(await readFile(config, 'utf8'), before);
  // The retained consumer launcher executes cross-platform, while doctor never
  // runs it (the .invalid Figma endpoint also cannot be contacted).
  assert.match((await capture(browser.command, browser.args, consumer.root)).stdout, /^v\d+/);
  assert.ok(!(await mcpStatus(installed, consumer.root)).result.isError);
  await adapter('copilot', { ...options, action: 'remove' });
  assert.deepEqual(JSON.parse(await readFile(config)), { servers: { playwright: browser, figma }, inputs: [{ id: 'preserved' }] });
});

test('ownership, checksums, symlinks and config conflicts fail closed', async () => {
  const b = await bundles();
  const root = path.join(scratch, 'negative root');
  const options = { scope: 'project', root, store: path.join(scratch, 'negative store'), bundle: b.first, pin: b.pin };
  await assert.rejects(adapter('copilot', { ...options, scope: 'user' }), /Supported scope/);
  await assert.rejects(adapter('copilot', { ...options, pin: 'latest' }), /checksum/);
  await mkdir(path.join(root, '.vscode'), { recursive: true });
  const config = path.join(root, '.vscode/mcp.json');
  const existing = JSON.stringify({ servers: { 'start-migration': { command: 'unrelated' } } });
  await writeFile(config, existing);
  await assert.rejects(adapter('copilot', options), /Conflicting/);
  assert.equal(await readFile(config, 'utf8'), existing);
  await writeFile(config, '{}');
  const receipt = await adapter('copilot', options);
  const file = Object.keys(receipt.files)[0];
  const bytes = await readFile(path.join(root, file));
  await writeFile(path.join(root, file), 'edited by owner');
  await assert.rejects(adapter('copilot', { ...options, action: 'remove' }), /Owned file modified/);
  await writeFile(path.join(root, file), bytes);
  const manifestFile = path.join(root, '.artifact-migration-tools/copilot.json');
  const raw = await readFile(manifestFile);
  await writeFile(manifestFile, JSON.stringify({ ...receipt, files: { '../victim': digest('x') } }));
  await assert.rejects(adapter('copilot', { ...options, action: 'remove' }), /Invalid ownership/);
  await writeFile(manifestFile, JSON.stringify({ ...receipt, commands: { ...receipt.commands, 'artifact-migrate': [process.execPath, '/unowned/code.mjs'] } }));
  await assert.rejects(adapter('copilot', { ...options, action: 'doctor' }), /CLI selection conflict/);
  await writeFile(manifestFile, raw);
  if (process.platform !== 'win32') {
    await rm(path.join(root, file));
    await symlink(config, path.join(root, file));
    await assert.rejects(adapter('copilot', { ...options, action: 'remove' }), /Symlink/);
    await rm(path.join(root, file)); await writeFile(path.join(root, file), bytes);
  }
  await adapter('copilot', { ...options, action: 'remove' });
});

test('Codex TOML merge preserves unrelated bytes and rejects alternate conflicting declarations', async () => {
  const b = await bundles();
  const root = path.join(scratch, 'TOML consumer');
  const options = { scope: 'project', root, store: path.join(scratch, 'toml store'), bundle: b.first, pin: b.pin };
  await mkdir(path.join(root, '.codex'), { recursive: true });
  const config = path.join(root, '.codex/config.toml');
  const original = '# user comment\nmodel = "chosen"\n[mcp_servers.other]\ncommand = "other"';
  await writeFile(config, original);
  await adapter('codex', options);
  assert.ok((await readFile(config, 'utf8')).startsWith(original));
  await adapter('codex', { ...options, action: 'remove' });
  assert.equal(await readFile(config, 'utf8'), original);
  await writeFile(config, '[mcp_servers."start-migration"]\ncommand="owned-by-user"\n');
  await assert.rejects(adapter('codex', options), /Conflicting/);
});

test('provider-owned CLI forwards argv and cwd; interrupted install locks fail closed', async t => {
  const b = await bundles();
  const consumer = await createUnstampedRecord({ prefix: 'CLI provider consumer ' });
  t.after(() => consumer.cleanup());
  const options = { scope: 'project', root: consumer.root, store: path.join(scratch, 'CLI store'), bundle: b.first, pin: b.pin };
  const receipt = await adapter('opencode', options);
  const entry = path.join(receipt.release, 'providers/opencode/install.mjs');
  const selection = ['--scope', options.scope, '--root', options.root, '--store', options.store];
  const doctor = await capture(process.execPath, [entry, '--doctor', ...selection], consumer.root);
  assert.deepEqual(JSON.parse(doctor.stdout).toolkit, receipt.toolkit);
  const status = await capture(process.execPath, [entry, 'exec', ...selection, '--', 'artifact-migration-toolkit', 'status', '--module', 'auth'], consumer.root);
  assert.equal(JSON.parse(status.stdout).toolkitIdentityStatus, 'UNSTAMPED');
  const lock = path.join(consumer.root, '.artifact-migration-tools/install.lock');
  await writeFile(lock, 'interrupted');
  await assert.rejects(adapter('opencode', { ...options, action: 'update' }), /locked/);
  await assert.rejects(adapter('opencode', { ...options, action: 'doctor' }), /locked/);
  await rm(lock);
  await adapter('opencode', { ...options, action: 'remove' });
});

test('v1.0.0 stores without a mode or SHA256SUMS remain valid, updatable and removable', async () => {
  const b = await bundles();
  const root = path.join(scratch, 'v1 receipt root');
  const options = { scope: 'project', root, store: path.join(scratch, 'v1 receipt store'), bundle: b.first, pin: b.pin };
  const receipt = await adapter('codex', options);
  const receiptFile = path.join(root, '.artifact-migration-tools/codex.json');
  delete receipt.mode;
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  // v1.0.0 staged no SHA256SUMS alongside the pinned release manifest.
  await rm(path.join(receipt.release, 'SHA256SUMS'));
  assert.equal((await adapter('codex', { ...options, action: 'doctor' })).outcome, 'OK');
  const next = await adapter('codex', { ...options, action: 'update', bundle: b.second, pin: b.nextPin });
  assert.equal(next.toolkit.version, '1.1.1');
  assert.equal((await adapter('codex', { ...options, action: 'rollback' })).pin, b.pin);
  assert.equal((await adapter('codex', { ...options, action: 'remove' })).removed, true);
});

test('SHA256SUMS disagreeing with the release manifest fails closed', async () => {
  const b = await bundles();
  const root = path.join(scratch, 'sums mismatch root');
  const options = { scope: 'project', root, store: path.join(scratch, 'sums mismatch store'), bundle: b.first, pin: b.pin };
  const receipt = await adapter('codex', options);
  const sums = path.join(receipt.release, 'SHA256SUMS');
  const [first, ...rest] = (await readFile(sums, 'utf8')).split('\n');
  await writeFile(sums, [`${'0'.repeat(64)}  ${first.slice(66)}`, ...rest].join('\n'));
  await assert.rejects(verifyBundle(receipt.release, b.pin), /SHA256SUMS does not match/);
  await assert.rejects(adapter('codex', { ...options, action: 'doctor' }), /SHA256SUMS does not match/);
});
