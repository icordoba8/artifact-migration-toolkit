import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, readlinkSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { adapter, RELAYLESS_MCP_TOOLS, digest, verifyBundle } from '../providers/install-support.mjs';
import { buildRelease } from '../scripts/release.mjs';
import { candidateReleaseRoot } from '../packages/migration-engine/test/support/candidate-release-root.mjs';
import { createUnstampedRecord } from '../packages/migration-engine/test/support/consumer-fixture.mjs';

const canonicalSkills = JSON.parse(await readFile(new URL('../skills-lock.json', import.meta.url)));
const frontmatter = text => text.slice(0, text.indexOf('\n---\n') + 5);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'provider acceptance with spaces '));
after(() => rm(scratch, { recursive: true, force: true }));
let releases;
let childId = 0;
async function bundles() {
  if (releases) return releases;
  // 'release two' below is version 1.1.1, and the update gate this file proves
  // is the one that refuses an *older* toolkit, so the candidate stays newer.
  const candidate = await candidateReleaseRoot(scratch, { version: '1.3.1' });
  const built = await buildRelease({ root: candidate, force: true });
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
  // The per-skill stamps move with the synthetic identity too, or the second
  // release would ship skills still claiming the first release's version.
  for (const file of Object.keys(manifest.files).filter(relative => relative.endsWith('/release-identity.json'))) {
    const source = JSON.parse(await readFile(path.join(second, file)));
    await replace(file, { ...source, version: manifest.toolkit.version, commit: manifest.toolkit.commit, contentHash: manifest.toolkit.contentHash });
  }
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
async function mcpStatus(receipt, cwd, request = { method: 'tools/call', params: { name: 'migration_status', arguments: { module: 'auth' } } }, server = receipt.mcp) {
  const [command, ...args] = Array.isArray(server.command) ? server.command : [server.command, ...server.args];
  const id = childId++;
  const inputPath = path.join(scratch, `child-${id}.stdin`);
  const outputPath = path.join(scratch, `child-${id}.stdout`);
  const errorPath = path.join(scratch, `child-${id}.stderr`);
  await writeFile(inputPath,
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'provider-acceptance', version: '1' } } })}\n` +
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, ...request })}\n`);
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
          // An installed skill states the release it came from as data, so an
          // operator can inspect what is installed without running the runtime --
          // and it says `release`, not `repository`, because this tree was packaged.
          if (relative.endsWith('/release-identity.json')) {
            // T19. A released skill names the release it came from *and* proves
            // which semantics it is: `computedHash` is what the release manifest
            // must agree with before that release may run this skill, and
            // commit/contentHash strengthen it to full byte identity because
            // this tree was packaged rather than copied from a checkout.
            assert.deepEqual(JSON.parse(text), { name: receipt.toolkit.name, version: receipt.toolkit.version, skill: skill[1], computedHash: canonicalSkills.skills[skill[1]].computedHash, source: 'release', commit: receipt.toolkit.commit, contentHash: receipt.toolkit.contentHash }, relative);
            assert.equal(JSON.parse(text).computedHash, receipt.skills.skills[skill[1]].computedHash, `${relative} is not proven by the release it names`);
            surfaces.add(`identity:${skill[1]}`);
            continue;
          }
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
        assert.ok(surfaces.has(`identity:${name}`), `${name} release identity not installed`);
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
      assert.deepEqual(JSON.parse(mcp.result.content.at(-1).text).activeToolkitIdentity, receipt.toolkit);
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

test('T1: Copilot registers nine tools without the relay by default, on install and on upgrade from a <=1.6.5 receipt', async t => {
  const b = await bundles();
  const consumer = await createUnstampedRecord({ prefix: 'copilot T1 ' });
  t.after(() => consumer.cleanup());
  const options = { scope: 'project', root: consumer.root, store: path.join(scratch, 'T1 store'), bundle: b.first, pin: b.pin };
  const vscode = path.join(consumer.root, '.vscode/mcp.json');
  const cli = path.join(consumer.root, '.github/mcp.json');
  const receiptFile = path.join(consumer.root, '.artifact-migration-tools/copilot.json');
  const toolsOf = async (receipt, server) => (await mcpStatus(receipt, consumer.root, { method: 'tools/list' }, server)).result.tools.map(tool => tool.name);
  const expectNine = async receipt => {
    const registered = JSON.parse(await readFile(cli, 'utf8')).mcpServers['start-migration'];
    assert.deepEqual(registered, { ...receipt.mcp, tools: RELAYLESS_MCP_TOOLS, env: { pnpm_config_pm_on_fail: 'error' } });
    assert.equal(registered.args.at(-1), '--without-relay');
    assert.deepEqual(JSON.parse(await readFile(vscode, 'utf8')).servers['start-migration'], receipt.mcp);
    assert.deepEqual(await toolsOf(receipt, registered), RELAYLESS_MCP_TOOLS);
    assert.equal(RELAYLESS_MCP_TOOLS.length, 9);
    assert.ok(!RELAYLESS_MCP_TOOLS.includes('migration_relay_decision'));
  };
  await expectNine(await adapter('copilot', options));

  // A <=1.6.5 receipt: the relay-carrying `.vscode` entry and no `.github` registration.
  const legacy = JSON.parse(await readFile(receiptFile, 'utf8'));
  legacy.mcp = { ...legacy.mcp, args: legacy.mcp.args.slice(0, 1) };
  legacy.configOwned = legacy.mcp;
  delete legacy.cliConfigOwned;
  await writeFile(receiptFile, JSON.stringify(legacy, null, 2));
  await writeFile(vscode, JSON.stringify({ servers: { 'start-migration': legacy.mcp } }));
  await rm(cli);
  assert.equal((await toolsOf(legacy, legacy.mcp)).length, 10);
  await expectNine(await adapter('copilot', { ...options, action: 'update', bundle: b.second, pin: b.nextPin }));

  // Doctor repairs a removed `.github` registration; remove takes only ours.
  const current = JSON.parse(await readFile(receiptFile, 'utf8'));
  await writeFile(cli, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://example.invalid/mcp' } } }));
  await adapter('copilot', { ...options, action: 'doctor', bundle: b.second, pin: b.nextPin });
  await expectNine(current);
  await adapter('copilot', { ...options, action: 'remove' });
  assert.deepEqual(JSON.parse(await readFile(cli, 'utf8')), { mcpServers: { other: { type: 'http', url: 'https://example.invalid/mcp' } } });
});

test('E7: Codex grants nine tools without the relay by default, on install and on upgrade from a <=1.6.5 receipt', async t => {
  const b = await bundles();
  const consumer = await createUnstampedRecord({ prefix: 'codex E7 ' });
  t.after(() => consumer.cleanup());
  const options = { scope: 'project', root: consumer.root, store: path.join(scratch, 'E7 store'), bundle: b.first, pin: b.pin };
  const config = path.join(consumer.root, '.codex/config.toml');
  const receiptFile = path.join(consumer.root, '.artifact-migration-tools/codex.json');
  const toolsOf = async server => (await mcpStatus(null, consumer.root, { method: 'tools/list' }, server)).result.tools.map(tool => tool.name);
  const expectNine = async receipt => {
    assert.equal(receipt.mcp.args.at(-1), '--without-relay');
    assert.deepEqual(receipt.mcp.enabled_tools, RELAYLESS_MCP_TOOLS);
    const toml = await readFile(config, 'utf8');
    assert.ok(toml.includes(`args = ${JSON.stringify(receipt.mcp.args)}\nenabled_tools = ${JSON.stringify(RELAYLESS_MCP_TOOLS)}\n`));
    assert.deepEqual(await toolsOf(receipt.mcp), RELAYLESS_MCP_TOOLS);
  };
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, 'model = "consumer"\n');
  await expectNine(await adapter('codex', options));

  // A <=1.6.5 (e.g. 1.6.4) receipt: the relay-carrying block, no filter.
  const legacy = JSON.parse(await readFile(receiptFile, 'utf8'));
  legacy.mcp = { command: legacy.mcp.command, args: legacy.mcp.args.slice(0, 1) };
  legacy.configOwned = `# BEGIN artifact-migration-tools\n[mcp_servers.start-migration]\ncommand = ${JSON.stringify(legacy.mcp.command)}\nargs = ${JSON.stringify(legacy.mcp.args)}\n# END artifact-migration-tools\n`;
  await writeFile(receiptFile, JSON.stringify(legacy, null, 2));
  await writeFile(config, `model = "consumer"\n${legacy.configOwned}`);
  assert.equal((await toolsOf(legacy.mcp)).length, 10);
  await expectNine(await adapter('codex', { ...options, action: 'update', bundle: b.second, pin: b.nextPin }));
  await adapter('codex', { ...options, action: 'remove' });
  assert.equal(await readFile(config, 'utf8'), 'model = "consumer"\n');
});

test('T1: a root .mcp.json start-migration entry shadows .github/mcp.json and is refused naming the file', async () => {
  const b = await bundles();
  const root = path.join(scratch, 'T1 shadow root');
  const options = { scope: 'project', root, store: path.join(scratch, 'T1 shadow store'), bundle: b.first, pin: b.pin };
  await mkdir(root, { recursive: true });
  const shadow = JSON.stringify({ mcpServers: { 'start-migration': { command: 'node', args: ['x'] } } });
  await writeFile(path.join(root, '.mcp.json'), shadow);
  const refused = { code: 'INSTALL_REGISTRATION_CONFLICT', message: /'\.mcp\.json' registers 'start-migration'/ };
  await assert.rejects(adapter('copilot', options), error => { assert.equal(error.state?.file, '.mcp.json'); return true; });
  await assert.rejects(adapter('copilot', options), refused);
  for (const file of ['.vscode', '.github', '.artifact-migration-tools/copilot.json']) await assert.rejects(lstat(path.join(root, file)), { code: 'ENOENT' });
  await writeFile(path.join(root, '.mcp.json'), '{}');
  await adapter('copilot', options);
  await writeFile(path.join(root, '.mcp.json'), shadow);
  for (const action of ['update', 'doctor']) await assert.rejects(adapter('copilot', { ...options, action }), refused);
  await writeFile(path.join(root, '.mcp.json'), '{}');
  // A tampered `.github` entry is a conflict for doctor; a foreign one for a fresh install.
  const cli = path.join(root, '.github/mcp.json');
  const owned = await readFile(cli, 'utf8');
  const foreign = JSON.stringify({ mcpServers: { 'start-migration': { type: 'stdio', command: 'node', args: ['x'], tools: ['*'] } } });
  await writeFile(cli, foreign);
  await assert.rejects(adapter('copilot', { ...options, action: 'doctor' }), { code: 'INSTALL_REGISTRATION_CONFLICT' });
  await writeFile(cli, owned);
  await adapter('copilot', { ...options, action: 'remove' });
  await writeFile(cli, foreign);
  await assert.rejects(adapter('copilot', options), { code: 'INSTALL_REGISTRATION_CONFLICT' });
  assert.equal(await readFile(cli, 'utf8'), foreign);
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

// Fix A, F3/Fix B: reinstall is an update, and with no receipt a registration
// is adopted only when it is exactly what this installer wrote into this store.
const receiptOf = async (root, provider) => JSON.parse(await readFile(path.join(root, `.artifact-migration-tools/${provider}.json`), 'utf8'));
const dropReceipts = root => rm(path.join(root, '.artifact-migration-tools'), { recursive: true });
/** Every consumer file by content, receipts aside: what an install changed. */
async function consumerTree(root, prefix = '') {
  const tree = {};
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => [])) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (relative === '.artifact-migration-tools') continue;
    if (item.isDirectory()) Object.assign(tree, await consumerTree(root, relative));
    else tree[relative] = digest(await readFile(path.join(root, relative)));
  }
  return tree;
}
const configOf = provider => (provider === 'codex' ? '.codex/config.toml' : '.mcp.json');
const unrelated = { codex: 'model = "consumer"\n', claude: `${JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2)}\n` };
const refusal = code => error => error.code === code && error.state?.code === code;

for (const provider of ['codex', 'claude']) {
  test(`${provider}: reinstall is an idempotent update that keeps unrelated configuration`, async () => {
    const b = await bundles();
    const root = path.join(scratch, `${provider} reinstall`);
    const options = { scope: 'project', root, store: path.join(scratch, `${provider} reinstall store`) };
    await mkdir(path.dirname(path.join(root, configOf(provider))), { recursive: true });
    await writeFile(path.join(root, configOf(provider)), unrelated[provider]);
    await adapter(provider, { ...options, bundle: b.second, pin: b.nextPin });
    // A plain install over an existing receipt updates instead of refusing.
    const updated = await adapter(provider, { ...options, bundle: b.first, pin: b.pin });
    assert.equal(updated.toolkit.version, b.identity.version);
    assert.deepEqual(updated.releases.map(item => item.pin), [b.nextPin, b.pin]);
    const settled = await consumerTree(root);
    assert.deepEqual(await adapter(provider, { ...options, bundle: b.first, pin: b.pin }), updated);
    assert.deepEqual(await adapter(provider, { ...options, bundle: b.first, pin: b.pin }), updated);
    assert.deepEqual(await consumerTree(root), settled);
    // A different selection over the receipt still refuses, typed and naming both sides.
    await assert.rejects(adapter(provider, { ...options, store: path.join(scratch, `${provider} other store`), bundle: b.first, pin: b.pin }),
      error => refusal('INSTALL_SELECTION_CONFLICT')(error) && error.state.recorded.store === updated.store);
    assert.equal((await adapter(provider, { ...options, action: 'remove' })).removed, true);
    assert.equal(await readFile(path.join(root, configOf(provider)), 'utf8'), unrelated[provider]);
  });

  test(`${provider}: without a receipt, its own current or historical registration is adopted`, async () => {
    const b = await bundles();
    const root = path.join(scratch, `${provider} adopt`);
    const options = { scope: 'project', root, store: path.join(scratch, `${provider} adopt store`) };
    await mkdir(path.dirname(path.join(root, configOf(provider))), { recursive: true });
    await writeFile(path.join(root, configOf(provider)), unrelated[provider]);
    // The current release: the receipt comes back identical, nothing else moves.
    const first = await adapter(provider, { ...options, bundle: b.first, pin: b.pin });
    const installed = await consumerTree(root);
    await dropReceipts(root);
    assert.deepEqual(await adapter(provider, { ...options, bundle: b.first, pin: b.pin }), first);
    assert.deepEqual(await consumerTree(root), installed);
    assert.equal((await adapter(provider, { ...options, action: 'doctor' })).outcome, 'OK');
    // A historical release in the same store: adopted, then updated in one step,
    // and recorded so it stays a rollback target.
    assert.equal((await adapter(provider, { ...options, action: 'remove' })).removed, true);
    await adapter(provider, { ...options, bundle: b.second, pin: b.nextPin });
    await dropReceipts(root);
    const adopted = await adapter(provider, { ...options, bundle: b.first, pin: b.pin });
    assert.deepEqual(adopted.releases.map(item => item.pin), [b.nextPin, b.pin]);
    assert.deepEqual(await consumerTree(root), installed);
    const back = await adapter(provider, { ...options, action: 'rollback', bundle: b.second, pin: b.nextPin });
    assert.equal(back.toolkit.version, '1.1.1');
    assert.equal((await adapter(provider, { ...options, action: 'remove' })).removed, true);
    assert.equal(await readFile(path.join(root, configOf(provider)), 'utf8'), unrelated[provider]);
  });

  test(`${provider}: without a receipt, a modified, foreign-store or unowned-file registration fails closed and writes nothing`, async () => {
    const b = await bundles();
    const root = path.join(scratch, `${provider} refuse`);
    const options = { scope: 'project', root, store: path.join(scratch, `${provider} refuse store`), bundle: b.first, pin: b.pin };
    await adapter(provider, options);
    await dropReceipts(root);
    const config = path.join(root, configOf(provider));
    const original = await readFile(config, 'utf8');
    const settled = () => assert.rejects(receiptOf(root, provider), { code: 'ENOENT' });
    // Another store's registration is not provably ours.
    const before = await consumerTree(root);
    await assert.rejects(adapter(provider, { ...options, store: path.join(scratch, `${provider} refuse other store`) }),
      error => refusal('INSTALL_REGISTRATION_CONFLICT')(error) && error.state.file === configOf(provider));
    assert.deepEqual(await consumerTree(root), before);
    await settled();
    // An edited registration is never adopted.
    await writeFile(config, original.replace('mcp-server.mjs', 'mcp-server.mjs.edited'));
    const edited = await consumerTree(root);
    await assert.rejects(adapter(provider, options), refusal('INSTALL_REGISTRATION_CONFLICT'));
    assert.deepEqual(await consumerTree(root), edited);
    await settled();
    // Our registration, but an edited owned file: the file is not adopted.
    await writeFile(config, original);
    const skill = Object.keys(await consumerTree(root)).find(relative => relative.endsWith('/SKILL.md'));
    await writeFile(path.join(root, skill), 'edited by owner');
    const touched = await consumerTree(root);
    await assert.rejects(adapter(provider, options), error => refusal('INSTALL_UNOWNED_FILE')(error) && error.state.file === skill);
    assert.deepEqual(await consumerTree(root), touched);
    await settled();
  });
}

test('without a receipt, a foreign .agents/mcp.json start-migration entry is a typed conflict', async () => {
  const b = await bundles();
  const root = path.join(scratch, 'agents adopt');
  const options = { scope: 'project', root, store: path.join(scratch, 'agents adopt store'), bundle: b.first, pin: b.pin };
  await mkdir(path.join(root, '.agents'), { recursive: true });
  await writeFile(path.join(root, '.agents/mcp.json'), `${JSON.stringify({ mcpServers: { 'start-migration': { command: 'node', args: ['elsewhere.mjs'] } } }, null, 2)}\n`);
  await assert.rejects(adapter('codex', options), error => refusal('INSTALL_REGISTRATION_CONFLICT')(error) && error.state.file === '.agents/mcp.json');
  // The provider CLI prints the same typed state, as JSON on stderr.
  const cli = await capture(process.execPath, [fileURLToPath(new URL('../providers/codex/install.mjs', import.meta.url)), 'install',
    '--scope', 'project', '--root', root, '--store', options.store, '--bundle', b.first, '--pin', b.pin], root);
  assert.equal(cli.code, 1);
  assert.deepEqual(JSON.parse(cli.stderr.slice(cli.stderr.indexOf('{'))), { code: 'INSTALL_REGISTRATION_CONFLICT', file: '.agents/mcp.json' });
  // Its own entry for this store is adopted with the rest.
  await writeFile(path.join(root, '.agents/mcp.json'), '{"mcpServers":{}}\n');
  const first = await adapter('codex', options);
  const agents = { mcpServers: { 'start-migration': { ...first.mcp, targets: ['codex'] } } };
  await writeFile(path.join(root, '.agents/mcp.json'), `${JSON.stringify(agents, null, 2)}\n`);
  await dropReceipts(root);
  assert.deepEqual(await adapter('codex', options), first);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.agents/mcp.json'), 'utf8')), agents);
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

test('staged release ships the pinned signer runtime closure and no test credential or key', async () => {
  const { first } = await bundles();
  const engine = path.join(first, 'packages/migration-engine');
  const manifest = JSON.parse(await readFile(path.join(first, 'release-manifest.json')));
  const shipped = Object.keys(manifest.files);
  for (const dependency of ['@simplewebauthn/server', '@peculiar/x509', '@levischuck/tiny-cbor', 'tslib', 'pngjs']) {
    assert.ok(shipped.includes(`packages/migration-engine/node_modules/${dependency}/package.json`), dependency);
  }
  assert.ok(shipped.some(file => file.startsWith('packages/migration-engine/node_modules/tsyringe/node_modules/tslib/')), 'conflicting version nested under its dependent');
  assert.deepEqual(shipped.filter(file => /software-authenticator|signer-fixture|\.pem$|\.sqlite$/.test(file) ||
    /^packages\/migration-engine\/(src|test)\/.*\btest\//.test(file)), []);
  for (const file of shipped.filter(file => file.startsWith('packages/migration-engine/src/'))) {
    assert.doesNotMatch(await readFile(path.join(first, file), 'utf8'), /BEGIN (EC |RSA )?PRIVATE KEY/, file);
  }
  // The staged signer and verifier load from the bundle alone under this Node.
  const result = await capture(process.execPath, ['--input-type=module', '-e', `
    const signer = await import(${JSON.stringify(new URL(`file://${path.join(engine, 'src/operator-signer.mjs')}`).href)});
    const webauthn = await import(${JSON.stringify(new URL(`file://${path.join(engine, 'src/operator-webauthn.mjs')}`).href)});
    console.log(JSON.stringify({ writes: signer.PRODUCTION_ATTESTED_WRITES, protocol: webauthn.ASSERTION_PROTOCOL,
      activation: (await signer.readSignerActivation({})).writesEnabled }));`], scratch);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)),
    { writes: false, protocol: 'amt.operator-decision.webauthn.assertion.v1', activation: false });
});

/**
 * T19. The identity stamp is the one file that must survive provider projection
 * unchanged: selection reads it to decide which release may run, so a
 * projection that rewrote it per provider would make "which provider installed
 * this skill" change what the skill says it is. `providers-sync` rewrites
 * `SKILL.md` frontmatter and the adapter renders `{{ENGINE_MCP_ENTRY}}`; this
 * file is neither a frontmatter carrier nor a template, and it has to stay that
 * way.
 */
test('every provider projection of a released skill carries the identical identity stamp', async () => {
  const b = await bundles();
  const manifest = JSON.parse(await readFile(path.join(b.first, 'release-manifest.json'), 'utf8'));
  for (const skill of ['start-migration', 'migrate-artifact']) {
    const canonical = await readFile(path.join(b.first, `skills/${skill}/release-identity.json`));
    const identity = JSON.parse(canonical.toString('utf8'));
    assert.equal(identity.source, 'release');
    assert.equal(identity.commit, manifest.toolkit.commit);
    assert.equal(identity.contentHash, manifest.toolkit.contentHash);
    assert.equal(identity.computedHash, manifest.skills.skills[skill].computedHash);
    assert.equal(identity.computedHash, canonicalSkills.skills[skill].computedHash);
    for (const provider of ['claude', 'codex', 'opencode', 'copilot']) {
      const projected = await readFile(path.join(b.first, `providers/${provider}/skills/${skill}/release-identity.json`));
      assert.ok(projected.equals(canonical), `${provider}/${skill} identity drifted from canonical`);
    }
  }
});

// --- install.lock ownership under adversarial interleavings -----------------
//
// Each interleaving below once let two installers hold the lock, or let one
// release another's (v1.4.0 audit L2). Barriers, not sleeps: node:fs/promises
// is wrapped in this process -- the adapter's named imports are live bindings,
// refreshed by syncBuiltinESMExports -- and each installer runs under an
// AsyncLocalStorage name. An installer is "inside" from its first read of
// anything but the lock: every such read comes after it holds the lock.
const fsp = createRequire(import.meta.url)('node:fs/promises');
const actor = new AsyncLocalStorage();
function hookFs(wrappers) {
  const originals = Object.fromEntries(Object.keys(wrappers).map(name => [name, fsp[name]]));
  for (const [name, wrap] of Object.entries(wrappers)) fsp[name] = wrap(originals[name]);
  syncBuiltinESMExports();
  return () => { Object.assign(fsp, originals); syncBuiltinESMExports(); };
}
const barrier = () => { let open; const opened = new Promise(resolve => { open = resolve; }); return { open, opened }; };
const DEAD = 2 ** 22 - 1; // Above every pid_max this test could collide with.
// This process's PID realm, as install-support.mjs records it.
const REALM = process.platform === 'linux' ? `linux:${readlinkSync('/proc/self/ns/pid')}` : process.platform;
const LOCK_TIMEOUT = { timeout: 180_000 };
const underLock = (lock, file) => String(file) === lock || String(file).startsWith(`${lock}${path.sep}`);
/** Calls `onOwner` once a named installer has a lock owner record open, `onInside` at its first other read; either may park it. */
const watchInstallers = (lock, { onOwner = () => {}, onInside = () => {} }, extra = {}) => {
  const inside = new Set();
  return hookFs({
    open: real => async (file, ...rest) => {
      const handle = await real(file, ...rest);
      const name = actor.getStore();
      if (name && underLock(lock, file)) await onOwner(name);
      return handle;
    },
    readFile: real => async (file, ...rest) => {
      const bytes = await real(file, ...rest);
      const name = actor.getStore();
      if (name && !underLock(lock, file) && !inside.has(name)) { inside.add(name); await onInside(name); }
      return bytes;
    },
    ...extra,
  });
};
const as = (name, run) => actor.run(name, run).then(result => ({ result }), error => ({ error }));
async function lockRoot(label) {
  const b = await bundles();
  const root = path.join(scratch, label);
  await mkdir(path.join(root, '.artifact-migration-tools'), { recursive: true });
  const lock = path.join(root, '.artifact-migration-tools/install.lock');
  return { root, lock, options: { scope: 'project', root, store: path.join(scratch, `${label} store`), bundle: b.first, pin: b.pin } };
}
/** The owner entry this lock format publishes, for a chosen owner. */
async function seedOwner(lock, owner = {}) {
  const uuid = randomUUID();
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, `${uuid}.json`), `${JSON.stringify({ uuid, pid: DEAD, hostname: os.hostname(), realm: REALM, startedAt: new Date().toISOString(), action: 'install', provider: 'codex', ...owner }, null, 2)}\n`);
  return uuid;
}
/** Every name and byte below `dir`: what "left untouched" means. */
async function treeOf(dir, tree = {}) {
  for (const name of (await readdir(dir)).sort()) {
    const file = path.join(dir, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) tree[file] = `-> ${await readlink(file)}`;
    else if (info.isFIFO()) tree[file] = `fifo ${info.ino}`; // reading one would block
    else if (info.isDirectory()) await treeOf(file, Object.assign(tree, { [file]: 'dir' }));
    else tree[file] = await readFile(file, 'utf8');
  }
  return tree;
}
const lockLeftovers = async root => (await readdir(path.join(root, '.artifact-migration-tools'))).filter(name => name.startsWith('install.lock'));
const doctorOk = async options => assert.equal((await adapter('codex', { ...options, action: 'doctor' })).outcome, 'OK');

for (const [label, seed] of [
  ['a dead owner entry', lock => seedOwner(lock)],
]) {
  test(`two installers reclaiming ${label} never both work under the lock`, LOCK_TIMEOUT, async () => {
    const { root, lock, options } = await lockRoot(`two reclaimers of ${label}`);
    await seed(lock);
    const bParked = barrier();
    const bResume = barrier();
    let bSettled;
    const bDone = new Promise(resolve => { bSettled = resolve; });
    const inside = new Set();
    let overlap = false;
    let paused = false;
    const restore = watchInstallers(lock, {
      onOwner: async name => {
        if (name !== 'B' || paused) return;
        paused = true; bParked.open(); await bResume.opened;
      },
      onInside: async name => {
        if (inside.size) overlap = true;
        inside.add(name);
        // A works on under the lock while B finishes reclaiming the owner it saw die.
        if (name === 'A') { bResume.open(); await bDone; }
      },
    });
    try {
      const b = as('B', () => adapter('codex', options)).then(outcome => { bSettled(); return outcome; });
      await bParked.opened; // B has read the dead owner
      const a = await as('A', () => adapter('codex', options)).finally(() => bResume.open());
      const outcome = await b;
      assert.equal(overlap, false, 'two installers worked under the lock at once');
      assert.match(outcome.error?.message ?? 'B installed', /Installation locked/);
      assert.equal(a.result?.recoveredLock, true, a.error?.message);
      assert.deepEqual(await lockLeftovers(root), []);
      await doctorOk(options);
    } finally { restore(); }
  });
}

test("an installer whose lock was lost releases only its own, never its replacement's", LOCK_TIMEOUT, async () => {
  const { root, lock, options } = await lockRoot('replacement owner');
  await adapter('codex', options);
  const aInside = barrier(); const aResume = barrier();
  const cInside = barrier(); const cResume = barrier();
  const restore = watchInstallers(lock, {
    onInside: async name => {
      if (name === 'A') { aInside.open(); await aResume.opened; }
      if (name === 'C') { cInside.open(); await cResume.opened; }
    },
  });
  try {
    const a = as('A', () => adapter('codex', { ...options, action: 'doctor' }));
    await aInside.opened;
    // A's lock is lost while it works -- deleted by hand -- and C takes the lock.
    await rm(lock, { recursive: true, force: true });
    const c = as('C', () => adapter('codex', { ...options, action: 'doctor' }));
    await cInside.opened;
    aResume.open();
    assert.equal((await a).result?.outcome, 'OK');
    assert.equal(await lstat(lock).then(() => true, () => false), true, "A's cleanup removed C's lock");
    await assert.rejects(adapter('codex', { ...options, action: 'doctor' }), /Installation locked/);
    cResume.open();
    assert.equal((await c).result?.outcome, 'OK');
    assert.deepEqual(await lockLeftovers(root), []);
    await doctorOk(options);
  } finally { restore(); }
});

test('a doctor that meets a working install fails closed and leaves its lock alone', LOCK_TIMEOUT, async () => {
  const { root, lock, options } = await lockRoot('concurrent doctor');
  const aInside = barrier(); const aResume = barrier();
  const restore = watchInstallers(lock, { onInside: async name => { if (name === 'A') { aInside.open(); await aResume.opened; } } });
  try {
    const a = as('A', () => adapter('codex', options));
    await aInside.opened;
    const held = await treeOf(lock);
    await assert.rejects(adapter('codex', { ...options, action: 'doctor' }), /Installation locked/);
    await assert.rejects(adapter('codex', options), /Installation locked/);
    assert.deepEqual(await treeOf(lock), held, "a refused installer touched the owner's lock");
    aResume.open();
    assert.equal((await a).error, undefined);
    assert.deepEqual(await lockLeftovers(root), []);
    await doctorOk(options);
  } finally { restore(); }
});

test('a failed install rolls back under contention, releasing only its own lock', LOCK_TIMEOUT, async () => {
  const { root, lock, options } = await lockRoot('contended rollback');
  const config = path.join(root, '.codex/config.toml');
  const aInside = barrier(); const aResume = barrier();
  const restore = watchInstallers(lock, { onInside: async name => { if (name === 'A') { aInside.open(); await aResume.opened; } } }, {
    rename: real => async (from, to, ...rest) => {
      if (actor.getStore() === 'A' && String(to) === config) throw Object.assign(new Error('injected config failure'), { code: 'EIO' });
      return real(from, to, ...rest);
    },
  });
  try {
    const a = as('A', () => adapter('codex', options));
    await aInside.opened;
    await assert.rejects(adapter('codex', options), /Installation locked/);
    aResume.open();
    assert.match((await a).error?.message ?? 'A installed', /injected config failure/);
    assert.deepEqual(await consumerTree(root), {}, 'the failed install was not rolled back');
    assert.deepEqual(await readdir(path.join(root, '.artifact-migration-tools')), [], 'a receipt or lock survived the rollback');
  } finally { restore(); }
  await adapter('codex', options);
  await doctorOk(options);
});

test('a half-built install lock is only staging: it neither blocks nor shares the published lock', LOCK_TIMEOUT, async () => {
  const { root, lock, options } = await lockRoot('half-built lock');
  const aParked = barrier(); const aResume = barrier();
  const bInside = barrier(); const bResume = barrier();
  const restore = watchInstallers(lock, { onInside: async name => { if (name === 'B') { bInside.open(); await bResume.opened; } } }, {
    // A has created its staging directory; its owner record is not written yet.
    writeFile: real => async (file, ...rest) => {
      if (actor.getStore() === 'A' && String(file).startsWith(`${lock}.`)) { aParked.open(); await aResume.opened; }
      return real(file, ...rest);
    },
  });
  try {
    const a = as('A', () => adapter('codex', options));
    await aParked.opened;
    const b = as('B', () => adapter('codex', options));
    await bInside.opened; // B holds the lock while A's staging exists
    aResume.open();
    assert.match((await a).error?.message ?? 'A installed', /Installation locked/);
    bResume.open();
    assert.equal((await b).error, undefined);
    assert.deepEqual(await lockLeftovers(root), []);
    await doctorOk(options);
  } finally { restore(); }
});

test('an install lock whose owner cannot be proven dead fails closed and is left untouched', LOCK_TIMEOUT, async () => {
  const cases = [
    ['a live owner', lock => seedOwner(lock, { pid: process.pid })],
    ['a dead owner on another host', lock => seedOwner(lock, { hostname: `${os.hostname()}-elsewhere` })],
    ['an owner without a hostname', lock => seedOwner(lock, { hostname: undefined })],
    ['a torn owner entry', async lock => { await mkdir(lock); await writeFile(path.join(lock, `${randomUUID()}.json`), '{"pid":'); }],
    ['an entry naming another owner', async lock => { const uuid = await seedOwner(lock); await rename(path.join(lock, `${uuid}.json`), path.join(lock, `${randomUUID()}.json`)); }],
    ['two owner entries', async lock => { await seedOwner(lock); await seedOwner(lock); }],
    ['an unexpected entry', async lock => { await mkdir(lock); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: DEAD, hostname: os.hostname() })); }],
    ['a symlink to a dead owner', async (lock, root) => { await seedOwner(path.join(root, 'elsewhere')); await symlink(path.join(root, 'elsewhere'), lock); }],
    ['a dead owner in the Windows realm on this host', lock => seedOwner(lock, { realm: 'win32' })],
    ['a dead owner in another Linux pid namespace', lock => seedOwner(lock, { realm: 'linux:pid:[1]' })],
    ['an owner without a realm', lock => seedOwner(lock, { realm: undefined })],
    ['an entry symlinked to a dead owner', async (lock, root) => { const uuid = await seedOwner(path.join(root, 'elsewhere')); await mkdir(lock); await symlink(path.join(root, 'elsewhere', `${uuid}.json`), path.join(lock, `${uuid}.json`)); }],
    ['an entry that is a directory', lock => mkdir(path.join(lock, `${randomUUID()}.json`), { recursive: true })],
    ['an oversized owner entry', lock => seedOwner(lock, { padding: 'x'.repeat(2048) })],
    ['a dead legacy lock file', lock => writeFile(lock, `${JSON.stringify({ pid: DEAD, hostname: os.hostname(), startedAt: new Date().toISOString(), action: 'install', provider: 'codex' }, null, 2)}\n`)],
  ];
  for (const [label, seed] of cases) {
    const { root, lock, options } = await lockRoot(`unproven ${label}`);
    await seed(lock, root);
    const before = await treeOf(root);
    await assert.rejects(adapter('codex', options), /Installation locked|Symlink refused/, label);
    assert.deepEqual(await treeOf(root), before, `${label}: the lock was touched or something was installed`);
  }
});

test('an interrupted install or reclaim leaves a lock the next installer recovers', LOCK_TIMEOUT, async () => {
  const cases = [
    // A release, or a reclaimer killed after removing the dead entry, leaves the directory empty.
    ['an empty lock directory', lock => mkdir(lock), undefined],
    // A killed installer, or a reclaimer killed before removing it, leaves the dead entry.
    ['a dead owner entry', lock => seedOwner(lock), true],
  ];
  for (const [label, seed, recovered] of cases) {
    const { root, lock, options } = await lockRoot(`interrupted ${label}`);
    await seed(lock);
    assert.equal((await adapter('codex', options)).recoveredLock, recovered, label);
    assert.deepEqual(await lockLeftovers(root), [], label);
    await doctorOk(options);
  }
  // An installer killed before publishing leaves only its staging: never read, never removed.
  const { root, lock, options } = await lockRoot('interrupted staging');
  const stray = `${lock}.${randomUUID()}.tmp`;
  await seedOwner(stray, { pid: process.pid });
  const before = await treeOf(stray);
  assert.equal((await adapter('codex', options)).recoveredLock, undefined);
  assert.deepEqual(await treeOf(stray), before);
  assert.deepEqual(await lockLeftovers(root), [path.basename(stray)]);
});

test('a protocol-1 install.lock file is never reclaimed; once an operator removes it, installs work', LOCK_TIMEOUT, async () => {
  const { root, lock, options } = await lockRoot('legacy lock file');
  for (const legacy of [
    `${JSON.stringify({ pid: DEAD, hostname: os.hostname(), startedAt: new Date().toISOString(), action: 'install', provider: 'codex' }, null, 2)}\n`,
    `${JSON.stringify({ pid: process.pid, hostname: os.hostname() })}\n`,
    '',
  ]) {
    await writeFile(lock, legacy);
    const before = await treeOf(root);
    await assert.rejects(adapter('codex', options), { code: 'INSTALL_LEGACY_LOCK', message: /^Installation locked; .* protocol-1 release/ });
    await assert.rejects(adapter('codex', { ...options, action: 'doctor' }), /Installation locked/);
    assert.deepEqual(await treeOf(root), before, 'the legacy lock was touched or something was installed');
  }
  await rm(lock); // the documented manual recovery, once every writer is stopped
  assert.equal((await adapter('codex', options)).recoveredLock, undefined);
  assert.deepEqual(await lockLeftovers(root), []);
  await doctorOk(options);
});

test('only ESRCH proves an installer gone: every other probe answer keeps its lock', LOCK_TIMEOUT, async () => {
  const kill = process.kill;
  try {
    for (const code of ['EPERM', 'EINVAL', 'EACCES', 'ENOSYS', undefined]) {
      let probed = false;
      process.kill = (pid, signal) => {
        if (pid !== DEAD) return kill.call(process, pid, signal);
        probed = true;
        throw Object.assign(new Error(`injected ${code}`), { code });
      };
      const { root, lock, options } = await lockRoot(`probe ${code}`);
      await seedOwner(lock);
      const before = await treeOf(root);
      await assert.rejects(adapter('codex', options), /Installation locked/, String(code));
      assert.equal(probed, true, `${code}: the probe was never reached`);
      assert.deepEqual(await treeOf(root), before, `${code}: the lock was touched`);
    }
  } finally { process.kill = kill; }
});

test('a lock that cannot be reclaimed is refused with its path and the reason, untouched', LOCK_TIMEOUT, async () => {
  for (const [label, owner, reason, code] of [
    ['live', { pid: process.pid }, /held by pid \d+ \(install, started .+\), which is still running/, 'LOCK_HELD'],
    ['other namespace', { realm: 'linux:pid:[1]' }, /recorded no liveness token, in another PID namespace \(linux:pid:\[1\]; this process: .+\)/, 'LOCK_NO_LIVENESS_TOKEN'],
    ['other host', { hostname: 'elsewhere.invalid' }, /on host elsewhere\.invalid/, 'LOCK_OWNER_UNKNOWN'],
  ]) {
    const { root, lock, options } = await lockRoot(`diagnosed ${label}`);
    await seedOwner(lock, owner);
    const before = await treeOf(root);
    const error = await adapter('codex', options).then(() => assert.fail(`${label}: installed`), error => error);
    assert.equal(error.code, code, label);
    const refusal = error.message;
    assert.ok(refusal.startsWith(`Installation locked; inspect interrupted installation before retrying: ${lock}: `), refusal);
    assert.match(refusal, reason, label);
    assert.deepEqual(await treeOf(root), before, `${label}: the lock was touched`);
  }
});

// E2: the installer mirrors the engine's liveness token.
const TOKENS = process.platform === 'win32' ? 'Windows has no FIFOs' : false;
const execFileAsync = promisify(execFile);
const userns = TOKENS || await execFileAsync('unshare', ['-Urpf', 'true']).then(() => false, () => 'unprivileged user and PID namespaces are unavailable here');
const installSupport = new URL('../providers/install-support.mjs', import.meta.url).href;
/** An owner entry bound to a fresh FIFO nobody holds open, in another PID realm. */
async function seedTokenOwner(lock, owner = {}) {
  const uuid = await seedOwner(lock, { realm: 'linux:pid:[1]' });
  const fifo = path.join(lock, `${uuid}.fifo`);
  await execFileAsync('mkfifo', [fifo]);
  const { dev, ino } = await lstat(fifo, { bigint: true });
  const entry = path.join(lock, `${uuid}.json`);
  await writeFile(entry, JSON.stringify({ ...JSON.parse(await readFile(entry, 'utf8')), fifo: { dev: String(dev), ino: String(ino) }, ...owner }));
  return fifo;
}

test('an installer SIGKILLed in another PID namespace leaves a lock the next installer reclaims', { ...LOCK_TIMEOUT, skip: userns }, async () => {
  const { root, lock, options } = await lockRoot('killed in another namespace');
  // The real installer process parks once it holds the lock.
  const script = `import { createRequire, syncBuiltinESMExports } from 'node:module';\n` +
    `const fsp = createRequire(import.meta.url)('node:fs/promises');\n` +
    `const options = JSON.parse(process.argv[1]);\nconst real = fsp.rename;\n` +
    `fsp.rename = async (from, to) => { await real(from, to); if (String(to).endsWith('install.lock')) { process.stdout.write('HELD\\n'); await new Promise(() => setInterval(() => {}, 1000)); } };\n` +
    `syncBuiltinESMExports();\nawait (await import(${JSON.stringify(installSupport)})).adapter('codex', options);\n`;
  const child = spawn('unshare', ['-Urpf', process.execPath, '--input-type=module', '-e', script, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); exited.then(() => reject(new Error('the installer exited before holding the lock'))); });
    assert.equal((await readdir(lock)).length, 2, 'the owner holds no liveness token');
    await assert.rejects(adapter('codex', options), { code: 'LOCK_HELD' });
    const installer = Number(await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8'));
    assert.ok(installer > 0, 'no installer process under unshare'); // never kill(0): the whole group
    process.kill(installer, 'SIGKILL'); // the installer itself, not the unshare wrapper
    await exited;
    assert.equal((await adapter('codex', options)).recoveredLock, true);
    assert.deepEqual(await lockLeftovers(root), []);
    await doctorOk(options);
  } finally { child.kill('SIGKILL'); }
});

test('an install token proves its owner gone or alive; anything that is not the recorded FIFO is refused untouched', { ...LOCK_TIMEOUT, skip: TOKENS }, async () => {
  for (const [label, seed, code] of [
    ['a missing token', async lock => rm(await seedTokenOwner(lock)), 'LOCK_OWNER_UNKNOWN'],
    ['a token replaced by a regular file', async lock => { const fifo = await seedTokenOwner(lock); await rm(fifo); await writeFile(fifo, ''); }, 'LOCK_OWNER_UNKNOWN'],
    ['a token replaced by another FIFO', async (lock, root) => { const fifo = await seedTokenOwner(lock); const other = path.join(root, 'other.fifo'); await execFileAsync('mkfifo', [other]); await rename(other, fifo); }, 'LOCK_OWNER_UNKNOWN'],
    ['a token on another host', lock => seedTokenOwner(lock, { hostname: 'elsewhere.invalid' }), 'LOCK_OWNER_UNKNOWN'],
  ]) {
    const { root, lock, options } = await lockRoot(`token ${label}`);
    await seed(lock, root);
    const before = await treeOf(root);
    await assert.rejects(adapter('codex', options), { code, message: /^Installation locked; / }, label);
    assert.deepEqual(await treeOf(root), before, `${label}: the lock was touched or something was installed`);
  }
  const { root, lock, options } = await lockRoot('token live then dead');
  const reader = await open(await seedTokenOwner(lock), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    await assert.rejects(adapter('codex', options), { code: 'LOCK_HELD' }, 'a live token');
  } finally { await reader.close(); }
  assert.equal((await adapter('codex', options)).recoveredLock, true, 'a dead token in another PID realm');
  assert.deepEqual(await lockLeftovers(root), []);
});

test('an install into a read-only root is refused with the kernel errno, creating nothing', { ...LOCK_TIMEOUT, skip: userns }, async () => {
  const { options } = await lockRoot('read-only root');
  const root = path.join(scratch, 'read-only root bare');
  await mkdir(root);
  const script = `await (await import(${JSON.stringify(installSupport)})).adapter('codex', JSON.parse(process.argv[1]))` +
    `.then(() => console.log('{}'), error => console.log(JSON.stringify({ code: error.code, cause: error.cause?.code })));\n`;
  const { stdout } = await execFileAsync('unshare', ['-Urm', 'sh', '-c', 'mount --bind "$1" "$1" && mount -o remount,bind,ro "$1" "$1" && exec "$2" --input-type=module -e "$3" "$4"',
    'sh', root, process.execPath, script, JSON.stringify({ ...options, root })]);
  assert.deepEqual(JSON.parse(stdout), { code: 'EROFS', cause: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);
});

test('an install owner entry swapped for a symlink after it was vetted is never followed', LOCK_TIMEOUT, async () => {
  const { root, lock, options } = await lockRoot('swapped owner entry');
  const uuid = await seedOwner(lock, { pid: process.pid });
  const decoy = path.join(root, 'decoy');
  await mkdir(decoy);
  await writeFile(path.join(decoy, `${uuid}.json`), JSON.stringify({ uuid, pid: DEAD, hostname: os.hostname(), realm: REALM }));
  const entry = path.join(lock, `${uuid}.json`);
  let swapped = false;
  const restore = hookFs({
    open: real => async (file, ...rest) => {
      if (String(file) === entry && !swapped) {
        swapped = true; // after the reader's lstat, before its open
        await rm(entry);
        await symlink(path.join(decoy, `${uuid}.json`), entry);
      }
      return real(file, ...rest);
    },
  });
  try {
    await assert.rejects(adapter('codex', options), /Installation locked/);
    assert.equal(swapped, true);
    assert.equal((await lstat(entry)).isSymbolicLink(), true, 'the swapped entry was removed');
    assert.deepEqual(await readdir(lock), [`${uuid}.json`]);
  } finally { restore(); }
});

test('a protocol-1 release is never installed, run, repaired, updated to or rolled back to; a protocol-1 receipt still updates', LOCK_TIMEOUT, async () => {
  const b = await bundles();
  // A protocol-1 release: no manifest field, and the installer it shipped (here
  // the current one with its protocol check removed, which is what it lacked).
  const old = path.join(scratch, 'release protocol one');
  await cp(b.first, old, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(old, 'release-manifest.json')));
  delete manifest.writerLockProtocol;
  const installer = (await readFile(path.join(old, 'providers/install-support.mjs'), 'utf8')).replaceAll('.writerLockProtocol !== WRITER_LOCK_PROTOCOL)', '.writerLockProtocol === "never")');
  await writeFile(path.join(old, 'providers/install-support.mjs'), installer);
  manifest.files['providers/install-support.mjs'] = digest(installer);
  await writeFile(path.join(old, 'SHA256SUMS'), `${Object.entries(manifest.files).map(([relative, hash]) => `${hash.slice(7)}  ${relative}`).join('\n')}\n`);
  await writeFile(path.join(old, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const oldPin = digest(await readFile(path.join(old, 'release-manifest.json')));
  const refused = { code: 'INSTALL_LOCK_PROTOCOL_UNSUPPORTED', message: /writer lock protocol 1/ };
  const unchanged = async (label, run, { root, store }) => {
    const before = [await treeOf(root), await treeOf(store).catch(() => null)];
    await assert.rejects(run(), refused, label);
    assert.deepEqual([await treeOf(root), await treeOf(store).catch(() => null)], before, `${label}: something was written`);
  };

  // Fresh root: not installed, and nothing staged in the store.
  const fresh = await lockRoot('protocol one fresh');
  await unchanged('install', () => adapter('codex', { ...fresh.options, bundle: old, pin: oldPin }), fresh.options);

  // Installed on protocol 2: neither updated nor rolled back to protocol 1.
  const current = await lockRoot('protocol one current');
  await adapter('codex', current.options);
  await unchanged('update', () => adapter('codex', { ...current.options, action: 'update', bundle: old, pin: oldPin }), current.options);
  await unchanged('rollback', () => adapter('codex', { ...current.options, action: 'rollback', bundle: old, pin: oldPin }), current.options);
  await doctorOk(current.options);

  // Left on protocol 1 by its own installer: never run or repaired from here...
  const legacy = await lockRoot('protocol one receipt');
  const installed = await capture(process.execPath, [path.join(old, 'providers/codex/install.mjs'), 'install', '--scope', 'project', '--root', legacy.root, '--store', legacy.options.store, '--bundle', old, '--pin', oldPin], legacy.root);
  assert.equal(installed.code, 0, installed.stderr);
  await unchanged('doctor', () => adapter('codex', { ...legacy.options, action: 'doctor' }), legacy.options);
  // ...but it updates to protocol 2, and cannot then roll back.
  const updated = await adapter('codex', { ...legacy.options, action: 'update' });
  assert.equal(updated.pin, b.pin);
  assert.ok(updated.releases.some(item => item.pin === oldPin));
  await unchanged('rollback after update', () => adapter('codex', { ...legacy.options, action: 'rollback', bundle: old, pin: oldPin }), legacy.options);
  await doctorOk(legacy.options);
});
