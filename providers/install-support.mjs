// Shared adapter file/config operations only. Migration rules live in the engine.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const optional = file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const layouts = {
  claude: { project: ['skills', null, '.mcp.json', 'mcpServers'], user: ['skills', null, '.mcp.json', 'mcpServers'] },
  codex: { project: ['.agents/skills', '.codex/prompts', '.codex/config.toml', null], user: ['.agents/skills', '.codex/prompts', '.codex/config.toml', null] },
  opencode: { project: ['.opencode/skills', '.opencode/commands', 'opencode.json', 'mcp'], user: ['.config/opencode/skills', '.config/opencode/commands', '.config/opencode/opencode.json', 'mcp'] },
  copilot: { project: ['.github/skills', '.github/prompts', '.vscode/mcp.json', 'servers'] },
};

// Validate every component, including existing ancestors of the selected root.
export async function safePath(root, relative = '') {
  if (relative && (relative.includes('\\') || relative.includes(':') || relative.split('/').some(s => !s || s === '.' || s === '..') || path.isAbsolute(relative))) throw new Error(`Unsafe path: ${relative}`);
  root = path.resolve(root);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe path: ${relative}`);
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error(`Symlink refused: ${current}`);
  }
  return target;
}

async function filesBelow(root, prefix = '') {
  const files = [];
  for (const item of await readdir(await safePath(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Symlink refused: ${relative}`);
    if (item.isDirectory()) files.push(...await filesBelow(root, relative));
    else if (item.isFile()) files.push(relative);
    else throw new Error(`Non-file payload: ${relative}`);
  }
  return files.sort();
}

export async function verifyBundle(bundle, pin) {
  const raw = await readFile(await safePath(bundle, 'release-manifest.json'));
  if (!/^sha256:[a-f0-9]{64}$/.test(pin ?? '') || digest(raw) !== pin) throw new Error('Exact release manifest checksum required');
  const manifest = JSON.parse(raw);
  const id = manifest.toolkit;
  if (id?.name !== 'artifact-migration-tools' || !/^\d+\.\d+\.\d+$/.test(id.version) || !/^[a-f0-9]{40}$/.test(id.commit) || !/^sha256:[a-f0-9]{64}$/.test(id.contentHash)) throw new Error('Invalid exact toolkit identity');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (digest(await readFile(await safePath(bundle, relative))) !== hash) throw new Error(`Release checksum mismatch: ${relative}`);
  }
  // Pre-v1.1.0 stores staged no SHA256SUMS. The pinned release-manifest.json is
  // already fully verified above, so its absence is tolerated; present but
  // disagreeing still fails closed. New installs keep staging the file.
  const sums = await optional(await safePath(bundle, 'SHA256SUMS'));
  if (sums !== null) {
    const checksums = sums.toString('utf8').trim().split('\n').filter(Boolean).map(line => {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/);
      if (!match) throw new Error('Invalid SHA256SUMS');
      return [match[2], `sha256:${match[1]}`];
    });
    if (!same(Object.fromEntries(checksums), manifest.files)) throw new Error('SHA256SUMS does not match release manifest');
  }
  const runtime = await filesBelow(path.join(bundle, 'packages/migration-engine'));
  for (const relative of runtime) {
    if (!manifest.files[`packages/migration-engine/${relative}`]) throw new Error(`Unverified engine file: ${relative}`);
  }
  const identity = JSON.parse(await readFile(path.join(bundle, 'packages/migration-engine/build-identity.json')));
  if (!same(identity, id)) throw new Error('Engine identity mismatch');
  return manifest;
}

// Own one marked TOML block; never rewrite the rest or guess at alternate TOML
// spellings. Ambiguous start-migration declarations fail closed.
const begin = '# BEGIN artifact-migration-tools\n';
const end = '# END artifact-migration-tools\n';
/**
 * The marked region only. The separator newline install may put in front of it
 * belongs to the file, not to the block: consuming it here would delete a
 * newline the consumer wrote. Ownership is still decided by exact receipt
 * bytes; this pattern only tells "absent" apart from "there but not ours".
 */
const ownedBlock = /# BEGIN artifact-migration-tools\n[\s\S]*?\n# END artifact-migration-tools\n/;
/**
 * Provider configuration is a shared, consumer-owned resource: a consumer tool
 * may regenerate it and drop the registration this toolkit installed. So the
 * three states are distinguished rather than collapsed into one failure.
 *
 * present  -- byte/semantically equal to what the receipt proves we wrote.
 * missing  -- absent entirely. Reported as `missing` so the caller can restore
 *             exactly the receipt-owned registration and nothing else.
 * modified -- present at the owned location but different. Never overwritten.
 *
 * Ownership is always `previous` (the receipt's `configOwned`), never the
 * `start-migration` name: an entry under that name that the receipt does not
 * prove is ours is a conflict, not something to repair.
 */
function mergeConfig(raw, layout, previous, server) {
  if (layout[3] === null) {
    let text = raw?.toString() ?? '';
    let missing = false;
    if (previous) {
      // Exact receipt bytes, removed exactly, exactly once -- unchanged from
      // v1.0-v1.2, so removal still restores the consumer's file byte for byte.
      const parts = text.split(previous);
      if (parts.length === 2) text = parts.join('');
      else if (ownedBlock.test(text)) throw new Error('Owned MCP configuration was modified');
      else missing = true;
    }
    if (/start-migration|BEGIN artifact-migration-tools|END artifact-migration-tools/.test(text)) throw new Error('Conflicting MCP configuration');
    const separator = text && !text.endsWith('\n') ? '\n' : '';
    const fresh = server ? `${begin}[mcp_servers.start-migration]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n${end}` : null;
    // Restoring re-emits the receipt's own bytes, so the repair adds nothing of
    // its own and the next validation matches exactly. A merge that genuinely
    // changes the registration (update/rollback) writes the new block instead
    // and records it as the new ownership.
    const owned = fresh && missing && previous.replace(/^\n/, '') === fresh
      ? `${previous.startsWith('\n') ? '' : separator}${previous}`
      : fresh && `${separator}${fresh}`;
    return { bytes: Buffer.from(text + (owned ?? '')), owned: owned ?? null, missing };
  }
  const config = raw ? JSON.parse(raw) : {};
  const key = layout[3];
  if (!config || Array.isArray(config) || typeof config !== 'object' || (config[key] && (Array.isArray(config[key]) || typeof config[key] !== 'object'))) throw new Error('MCP config must be an object');
  const existing = config[key]?.['start-migration'];
  const missing = Boolean(previous) && existing === undefined;
  if (!missing && (previous ? !same(existing, previous) : existing !== undefined)) throw new Error('Conflicting or modified MCP configuration');
  if (server) (config[key] ??= {})['start-migration'] = server;
  else if (config[key]) { delete config[key]['start-migration']; if (!Object.keys(config[key]).length) delete config[key]; }
  return { bytes: Buffer.from(json(config)), owned: server, missing };
}

async function replace(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

function ownedPath(relative, provider, layout) {
  return relative.startsWith(`${layout[0]}/start-migration/`) || relative.startsWith(`${layout[0]}/migrate-artifact/`) ||
    (layout[1] && ['start-migration', 'migrate-artifact'].some(name => relative === `${layout[1]}/${name}${provider === 'copilot' ? '.prompt.md' : '.md'}`)) ||
    (provider === 'claude' && relative === '.claude-plugin/plugin.json');
}

async function validateSelection(receipt, provider, layout) {
  const expectedRelease = path.join(receipt.store, `${receipt.toolkit?.version}-${receipt.pin?.slice(7)}`);
  if (receipt.release !== expectedRelease) throw new Error('Installation release path conflict');
  const manifest = await verifyBundle(receipt.release, receipt.pin);
  if (!same(manifest.toolkit, receipt.toolkit)) throw new Error('Installation identity conflict');
  const pkg = JSON.parse(await readFile(path.join(receipt.release, 'packages/migration-engine/package.json')));
  const commands = Object.fromEntries(Object.entries(pkg.bin).map(([name, entry]) => [name, [process.execPath, path.join(receipt.release, 'packages/migration-engine', entry)]]));
  if (!same(receipt.commands, commands)) throw new Error('Installation CLI selection conflict');
  const launch = { command: process.execPath, args: [path.join(receipt.release, 'packages/migration-engine/src/mcp-server.mjs')] };
  const server = provider === 'opencode' ? { type: 'local', command: [launch.command, ...launch.args], enabled: true } : provider === 'copilot' ? { type: 'stdio', ...launch } : launch;
  if (!same(receipt.mcp, server)) throw new Error('Installation MCP selection conflict');
  const owned = mergeConfig(null, layout, null, server).owned;
  if (!same(receipt.configOwned, owned) && !(typeof owned === 'string' && receipt.configOwned === `\n${owned}`)) throw new Error('Invalid configuration ownership');
  const source = JSON.parse(await readFile(path.join(receipt.release, `providers/${provider}/adapter.json`)));
  const expectedFiles = (receipt.mode === 'runtime' ? [] : source.files).flatMap(relative => {
    if (relative.startsWith('skills/')) return [`${layout[0]}/${relative.slice(7)}`];
    if (/^(prompts|commands)\//.test(relative) && layout[1]) return [`${layout[1]}/${relative.split('/').at(-1)}`];
    return [];
  });
  if (provider === 'claude' && receipt.mode !== 'runtime') expectedFiles.push('.claude-plugin/plugin.json');
  if (!same(Object.keys(receipt.files).sort(), expectedFiles.sort())) throw new Error('Invalid ownership manifest');
}

async function applyAdapter(provider, { action = 'install', scope, root, store, bundle, pin, runtimeOnly = false } = {}) {
  const layout = layouts[provider]?.[scope];
  if (!layout || !root || !store) throw new Error('Supported scope, explicit root and external store are required');
  root = path.resolve(root); store = path.resolve(store);
  if (store === root || store.startsWith(`${root}${path.sep}`)) throw new Error('Engine store must be outside the consumer/plugin root');
  const receiptFile = await safePath(root, `.artifact-migration-tools/${provider}.json`);
  const rawReceipt = await optional(receiptFile);
  const previous = rawReceipt ? JSON.parse(rawReceipt) : null;
  const mode = runtimeOnly ? 'runtime' : 'provider';
  if (previous && (previous.provider !== provider || previous.scope !== scope || previous.root !== root || previous.store !== store || (previous.mode ?? 'provider') !== mode)) throw new Error('Installation selection conflict');
  if (!['install', 'update', 'rollback', 'remove', 'doctor'].includes(action)) throw new Error(`Unknown action: ${action}`);
  if (previous) await validateSelection(previous, provider, layout);
  if (action !== 'install' && !previous) throw new Error('No installation selected');
  if (action === 'install' && previous) throw new Error('Already installed; select update explicitly');
  const configFile = await safePath(root, layout[2]);
  const rawConfig = await optional(configFile);
  for (const [relative, hash] of Object.entries(previous?.files ?? {})) {
    if (!ownedPath(relative, provider, layout)) throw new Error(`Invalid ownership manifest: ${relative}`);
    if (digest(await readFile(await safePath(root, relative))) !== hash) throw new Error(`Owned file modified: ${relative}`);
  }
  if (action === 'doctor') {
    // Self-healing registration. `mergeConfig` has already refused a modified
    // one; only a provably absent registration is restored, and only from the
    // receipt, so unrelated servers and unrelated provider configuration are
    // carried through untouched.
    const merged = mergeConfig(rawConfig, layout, previous.configOwned, previous.mcp);
    let mcpRepair = null;
    if (merged.missing) {
      await replace(configFile, merged.bytes);
      // A host that cannot load an MCP server mid-process needs a restart. The
      // runtime still succeeds: this invocation continues on absolute CLI paths.
      mcpRepair = { repaired: true, server: 'start-migration', registrationFile: configFile, restartRequired: true };
    }
    const servers = layout[3] ? JSON.parse(merged.bytes)[layout[3]] ?? {} : { 'start-migration': previous.mcp };
    return { ...previous, outcome: 'OK', mcpRepair, mcpServers: Object.entries(servers).map(([name, server]) => ({ name, registered: true, portable: server.command !== 'cmd', ...server })), registrationFile: configFile };
  }
  const writes = new Map();
  let receipt = null;
  let server = null;
  if (action !== 'remove') {
    const manifest = await verifyBundle(bundle, pin);
    const source = JSON.parse(await readFile(await safePath(bundle, `providers/${provider}/adapter.json`)));
    if (!same(source.toolkit, manifest.toolkit)) throw new Error('Adapter identity mismatch');
    const release = path.join(store, `${manifest.toolkit.version}-${pin.slice(7)}`);
    if (action === 'rollback' && !(previous.releases ?? []).some(item => item.release === release && item.pin === pin)) throw new Error('Rollback requires a previously installed exact release');
    const engine = path.join(release, 'packages/migration-engine');
    const pkg = JSON.parse(await readFile(path.join(bundle, 'packages/migration-engine/package.json')));
    const commands = Object.fromEntries(Object.entries(pkg.bin).map(([name, entry]) => [name, [process.execPath, path.join(engine, entry)]]));
    const mcp = { command: process.execPath, args: [path.join(engine, 'src/mcp-server.mjs')] };
    server = provider === 'opencode' ? { type: 'local', command: [mcp.command, ...mcp.args], enabled: true } : provider === 'copilot' ? { type: 'stdio', ...mcp } : mcp;
    for (const relative of mode === 'runtime' ? [] : source.files) {
      let destination;
      if (relative.startsWith('skills/')) destination = `${layout[0]}/${relative.slice(7)}`;
      else if (/^(prompts|commands)\//.test(relative) && layout[1]) destination = `${layout[1]}/${relative.split('/').at(-1)}`;
      else continue;
      if (!ownedPath(destination, provider, layout)) throw new Error(`Unexpected adapter path: ${relative}`);
      if (!manifest.files[`providers/${provider}/${relative}`]) throw new Error(`Unverified adapter file: ${relative}`);
      let text = await readFile(await safePath(bundle, `providers/${provider}/${relative}`), 'utf8');
      if (relative.endsWith('/scripts/runtime.mjs')) {
        writes.set(destination, Buffer.from(text));
        continue;
      }
      text = text.replaceAll('{{ENGINE_MCP_ENTRY}}', mcp.args[0]);
      // Render installed CLI paths too: skill invocation never depends on PATH.
      for (const [name, argv] of Object.entries(commands).sort(([a], [b]) => b.length - a.length)) {
        const quote = value => process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
        text = text.replace(new RegExp(`(?<![\\w-])${name}(?![\\w-])`, 'g'), () => argv.map(quote).join(' '));
      }
      writes.set(destination, Buffer.from(text));
    }
    if (provider === 'claude' && mode !== 'runtime') writes.set('.claude-plugin/plugin.json', Buffer.from(json({ name: 'artifact-migration-tools', version: manifest.toolkit.version, description: 'Pinned migration skills and MCP engine' })));
    receipt = { provider, scope, mode, root, store, toolkit: manifest.toolkit, skills: manifest.skills, release, pin, commands, mcp: server, files: Object.fromEntries([...writes].map(([name, bytes]) => [name, digest(bytes)])), releases: [...(previous?.releases ?? []).filter(item => item.release !== release), { release, pin }] };
    // Check ownership/config before staging any release or changing a consumer.
  }
  const merged = mergeConfig(rawConfig, layout, previous?.configOwned, server);
  if (receipt) receipt.configOwned = merged.owned;
  const backups = new Map();
  for (const relative of new Set([...Object.keys(previous?.files ?? {}), ...writes.keys(), layout[2], `.artifact-migration-tools/${provider}.json`])) {
    const file = await safePath(root, relative);
    const bytes = await optional(file);
    if (writes.has(relative) && bytes && !previous?.files[relative]) throw new Error(`Unowned file exists: ${relative}`);
    backups.set(file, bytes);
  }
  if (receipt) {
    await safePath(store);
    const present = await optional(await safePath(receipt.release, 'release-manifest.json'));
    if (present) await verifyBundle(receipt.release, pin);
    else {
      // Copy only checksum-owned files. No recursive copy from untrusted input.
      const staging = `${receipt.release}.${randomUUID()}.tmp`;
      try {
        const manifest = await verifyBundle(bundle, pin);
        for (const relative of [...Object.keys(manifest.files), 'release-manifest.json', 'SHA256SUMS']) await replace(await safePath(staging, relative), await readFile(await safePath(bundle, relative)));
        await verifyBundle(staging, pin);
        await rename(staging, receipt.release);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
  }
  try {
    for (const relative of Object.keys(previous?.files ?? {})) if (!writes.has(relative)) await rm(await safePath(root, relative));
    for (const [relative, bytes] of writes) await replace(await safePath(root, relative), bytes);
    await replace(configFile, merged.bytes);
    if (receipt) await replace(receiptFile, Buffer.from(json(receipt)));
    else await rm(receiptFile);
  } catch (error) {
    for (const [file, bytes] of backups) { if (bytes) await replace(file, bytes); else await rm(file, { force: true }); }
    throw error;
  }
  return receipt ?? { provider, removed: true };
}

// Doctor repairs a missing registration, so it is a config writer too and takes
// the same single lock per host root instead of racing an install.
export async function adapter(provider, options = {}) {
  if (!layouts[provider]?.[options.scope] || !options.root || !options.store) throw new Error('Supported scope, explicit root and external store are required');
  const lock = await safePath(options.root, '.artifact-migration-tools/install.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  // One config writer per host root. A killed installer leaves the lock behind
  // and fails closed; do not guess whether a partially applied install is safe.
  const handle = await open(lock, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('Installation locked; inspect interrupted installation before retrying');
    throw error;
  });
  try { return await applyAdapter(provider, options); }
  finally { await handle.close(); await rm(lock); }
}

export async function main(provider) {
  const [requested, ...args] = process.argv.slice(2);
  const action = requested === '--doctor' ? 'doctor' : requested;
  const separator = args.indexOf('--');
  const forwarded = separator < 0 ? [] : args.splice(separator).slice(1);
  const options = { action: action === 'exec' ? 'doctor' : action, runtimeOnly: false };
  const runtimeIndex = args.indexOf('--runtime-only');
  if (runtimeIndex >= 0) { options.runtimeOnly = true; args.splice(runtimeIndex, 1); }
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--(scope|root|store|bundle|pin)$/.test(args[i]) || !args[i + 1]) throw new Error('Expected --scope/--root/--store/--bundle/--pin values');
    options[args[i].slice(2)] = args[i + 1];
  }
  const receipt = await adapter(provider, options);
  if (action !== 'exec') { console.log(json(receipt)); return; }
  const command = receipt.commands[forwarded[0]];
  if (!command) throw new Error('Select an installed engine bin after --');
  // Forward argv and consumer cwd unchanged. No shell and no lifecycle logic.
  const child = spawn(command[0], [...command.slice(1), ...forwarded.slice(1)], { stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}
