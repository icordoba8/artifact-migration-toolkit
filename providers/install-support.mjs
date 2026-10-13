// Shared adapter file/config operations only. Migration rules live in the engine.
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, readlinkSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const optional = file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
// A typed refusal: the message is unchanged, `code` and `state` are for a
// machine reader (the bootstrap prints `state` to stderr as JSON).
// The release manifest's `writerLockProtocol`; a manifest without it is protocol 1.
const WRITER_LOCK_PROTOCOL = 2;
const refuse = (code, message, state = {}) => Object.assign(new Error(message), { code, state: { code, ...state } });
const conflict = (file, message = 'Conflicting or modified MCP configuration') => refuse('INSTALL_REGISTRATION_CONFLICT', message, { file });
const layouts = {
  claude: { project: ['skills', null, '.mcp.json', 'mcpServers'], user: ['skills', null, '.mcp.json', 'mcpServers'] },
  codex: { project: ['.agents/skills', '.codex/prompts', '.codex/config.toml', null], user: ['.agents/skills', '.codex/prompts', '.codex/config.toml', null] },
  opencode: { project: ['.opencode/skills', '.opencode/commands', 'opencode.json', 'mcp.servers'], user: ['.config/opencode/skills', '.config/opencode/commands', '.config/opencode/opencode.json', 'mcp.servers'] },
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
// OpenCode 2 honors `codemode` only under `mcp.servers`; `false` puts the engine's
// tool result in the tool row instead of inside `execute`. `legacy` is the
// pre-1.3.13 `mcp.<name>` shape, accepted only so it can converge.
const opencodeServer = (command, legacy) => legacy ? { type: 'local', command, enabled: true } : { type: 'local', command, codemode: false };
const serversIn = (config, key) => {
  const [outer, nested] = key.split('.');
  if (!nested) return config[outer] ?? {};
  const { [nested]: servers, ...legacy } = config[outer] ?? {};
  return { ...legacy, ...servers };
};
const serverFor = (provider, release, legacy = false) => {
  const launch = { command: process.execPath, args: [path.join(release, 'packages/migration-engine/src/mcp-server.mjs')] };
  return provider === 'opencode' ? opencodeServer([launch.command, ...launch.args], legacy)
    : provider === 'copilot' ? { type: 'stdio', ...launch } : launch;
};

async function historicalTemplateMatches(release, provider, layout, adapter) {
  const template = await readFile(await safePath(release, `providers/${provider}/${adapter.mcpTemplate}`), 'utf8');
  if (layout[3] === null) {
    const sections = template.split('[mcp_servers.start-migration]\n');
    return sections.length === 2 && sections[1].trim() === 'command = "node"\nargs = ["{{ENGINE_MCP_ENTRY}}"]';
  }
  const parsed = JSON.parse(template);
  const launch = { command: 'node', args: ['{{ENGINE_MCP_ENTRY}}'] };
  if (provider === 'opencode') {
    return same(parsed?.mcp?.servers?.['start-migration'], opencodeServer(['node', '{{ENGINE_MCP_ENTRY}}'], false)) ||
      same(parsed?.mcp?.['start-migration'], opencodeServer(['node', '{{ENGINE_MCP_ENTRY}}'], true));
  }
  return same(parsed?.[layout[3]]?.['start-migration'], provider === 'copilot' ? { type: 'stdio', ...launch } : launch);
}

async function historicalOwned(receipt, provider, layout) {
  const owned = [];
  for (const item of receipt.releases ?? []) {
    if (item.release === receipt.release && item.pin === receipt.pin) continue;
    if (typeof item.release !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.pin ?? '')) continue;
    if (path.dirname(item.release) !== receipt.store) continue;
    let manifest;
    try {
      manifest = await verifyBundle(item.release, item.pin);
      if (item.release !== path.join(receipt.store, `${manifest.toolkit.version}-${item.pin.slice(7)}`)) continue;
      const adapter = JSON.parse(await readFile(await safePath(item.release, `providers/${provider}/adapter.json`)));
      if (adapter.provider !== provider || !same(adapter.toolkit, manifest.toolkit) ||
          !(await historicalTemplateMatches(item.release, provider, layout, adapter))) continue;
    } catch { continue; }
    for (const legacy of provider === 'opencode' ? [false, true] : [false]) {
      owned.push({ native: mergeConfig(null, layout, null, serverFor(provider, item.release, legacy)).owned, agents: serverFor('claude', item.release), release: item.release, pin: item.pin, manifest });
    }
  }
  return owned;
}
/**
 * Provider configuration is a shared, consumer-owned resource: a consumer tool
 * may regenerate it and drop the registration this toolkit installed. So the
 * exact, missing, verified historical and conflicting states are distinguished.
 *
 * present  -- byte/semantically equal to what the receipt proves we wrote.
 * missing  -- absent entirely. Reported as `missing` so the caller can restore
 *             exactly the receipt-owned registration and nothing else.
 * stale   -- exactly matches a recorded, verified historical release.
 * modified -- present at the owned location but different. Never overwritten.
 *
 * Ownership is always `previous` (the receipt's `configOwned`), never the
 * `start-migration` name: an entry under that name that the receipt does not
 * prove is ours is a conflict, not something to repair.
 */
function mergeConfig(raw, layout, previous, server, historical = []) {
  if (layout[3] === null) {
    let text = raw?.toString() ?? '';
    let missing = false;
    let stale = false;
    if (previous) {
      // Exact receipt bytes, removed exactly, exactly once -- unchanged from
      // v1.0-v1.2, so removal still restores the consumer's file byte for byte.
      const parts = text.split(previous);
      if (parts.length === 2) text = parts.join('');
      else {
        const matches = historical.filter(owned => typeof owned === 'string' && text.split(owned).length === 2);
        if (matches.length === 1) { text = text.replace(matches[0], ''); stale = true; }
        else if (ownedBlock.test(text)) throw conflict(layout[2], 'Owned MCP configuration was modified');
        else missing = true;
      }
    }
    if (/start-migration|BEGIN artifact-migration-tools|END artifact-migration-tools/.test(text)) throw conflict(layout[2], 'Conflicting MCP configuration');
    const separator = text && !text.endsWith('\n') ? '\n' : '';
    const fresh = server ? `${begin}[mcp_servers.start-migration]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n${end}` : null;
    // Restoring re-emits the receipt's own bytes, so the repair adds nothing of
    // its own and the next validation matches exactly. A merge that genuinely
    // changes the registration (update/rollback) writes the new block instead
    // and records it as the new ownership.
    const owned = fresh && missing && previous.replace(/^\n/, '') === fresh
      ? `${previous.startsWith('\n') ? '' : separator}${previous}`
      : fresh && `${separator}${fresh}`;
    return { bytes: Buffer.from(text + (owned ?? '')), owned: owned ?? null, missing, stale };
  }
  const config = raw ? JSON.parse(raw) : {};
  const [key, nested] = layout[3].split('.');
  const notObject = value => value && (Array.isArray(value) || typeof value !== 'object');
  if (!config || Array.isArray(config) || typeof config !== 'object' || notObject(config[key]) || (nested && notObject(config[key]?.[nested]))) throw new Error('MCP config must be an object');
  const legacy = nested ? config[key]?.['start-migration'] : undefined;
  const found = [(nested ? config[key]?.[nested] : config[key])?.['start-migration'], legacy].filter(entry => entry !== undefined);
  if (found.length > 1 || (raw?.toString().match(/"start-migration"\s*:/g) ?? []).length !== found.length) throw conflict(layout[2]);
  const [existing] = found;
  const missing = Boolean(previous) && existing === undefined;
  const stale = previous && existing !== undefined && !same(existing, previous) && historical.some(owned => same(existing, owned));
  if (!missing && !stale && (previous ? !same(existing, previous) : existing !== undefined)) throw conflict(layout[2]);
  if (legacy !== undefined) delete config[key]['start-migration'];
  if (server) {
    config[key] ??= {};
    (nested ? (config[key][nested] ??= {}) : config[key])['start-migration'] = server;
  } else if (config[key]) {
    const servers = nested ? config[key][nested] : config[key];
    if (servers) delete servers['start-migration'];
    if (nested && servers && !Object.keys(servers).length) delete config[key][nested];
    if (!Object.keys(config[key]).length) delete config[key];
  }
  return { bytes: Buffer.from(json(config)), owned: server, missing, stale };
}

function mergeAgents(raw, previous, server, historical, provider) {
  if (raw === null) return null;
  const config = JSON.parse(raw);
  const entries = config?.mcpServers;
  const existing = entries?.['start-migration'];
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      !entries || Array.isArray(entries) || typeof entries !== 'object' ||
      (config.targets !== undefined && (!Array.isArray(config.targets) || !config.targets.every(target => typeof target === 'string')))) {
    if (existing !== undefined || raw.includes('"start-migration"')) throw conflict('.agents/mcp.json');
    return null;
  }
  if (existing === undefined) return null;
  if (!previous) throw conflict('.agents/mcp.json');
  if ((raw.toString().match(/"start-migration"\s*:/g) ?? []).length !== 1 ||
      (config.targets && !config.targets.includes(provider))) throw conflict('.agents/mcp.json');
  if (!existing || Array.isArray(existing) || typeof existing !== 'object') throw conflict('.agents/mcp.json');
  const { targets, ...registration } = existing;
  if (targets !== undefined && (!Array.isArray(targets) || !targets.includes(provider) ||
      !targets.every(target => typeof target === 'string' && target.length > 0) || new Set(targets).size !== targets.length)) {
    throw conflict('.agents/mcp.json');
  }
  const current = serverFor('claude', previous.release);
  if (!same(registration, current) && !historical.some(item => same(registration, item.agents))) throw conflict('.agents/mcp.json');
  const desired = server ? serverFor('claude', server) : null;
  if (!desired || same(registration, desired)) return null;
  entries['start-migration'] = { ...desired, ...(targets && { targets }) };
  return Buffer.from(json(config));
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
  // A pinned store release that is simply *gone* -- pruned, a cleaned cache, a
  // restored consumer on a new machine -- is an absent local candidate, not a
  // tampered one. Nothing the receipt claims about itself is contradicted (the
  // path still proves version+pin above), so the exact required release can be
  // reinstalled deterministically instead of the receipt being unusable. Only
  // ENOENT: a checksum, identity or ownership failure still fails closed, so an
  // integrity failure is never downgraded to a cache miss.
  const manifest = await verifyBundle(receipt.release, receipt.pin)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (manifest === null) return;
  if (!same(manifest.toolkit, receipt.toolkit)) throw new Error('Installation identity conflict');
  // The receipt's copy of the release's skill digests is a convenience for
  // offline selection, never a second authority: the pinned manifest is the
  // release-pinned artifact, so a hand-edited receipt cannot fake the binding
  // in either direction. Absent is tolerated -- receipts predating the field
  // are proven from the manifest alone -- but present and disagreeing is not.
  if (receipt.skills !== undefined && !same(receipt.skills, manifest.skills)) throw new Error('Installation skill identity conflict');
  const pkg = JSON.parse(await readFile(path.join(receipt.release, 'packages/migration-engine/package.json')));
  const commands = Object.fromEntries(Object.entries(pkg.bin).map(([name, entry]) => [name, [process.execPath, path.join(receipt.release, 'packages/migration-engine', entry)]]));
  if (!same(receipt.commands, commands)) throw new Error('Installation CLI selection conflict');
  const server = [serverFor(provider, receipt.release), serverFor(provider, receipt.release, true)].find(candidate => same(receipt.mcp, candidate));
  if (!server) throw new Error('Installation MCP selection conflict');
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
  return manifest;
}

/** The consumer files a verified release's adapter writes, rendered for `release` in the store. */
async function renderFiles(bundle, manifest, provider, layout, mode, release) {
  const writes = new Map();
  const source = JSON.parse(await readFile(await safePath(bundle, `providers/${provider}/adapter.json`)));
  const engine = path.join(release, 'packages/migration-engine');
  const pkg = JSON.parse(await readFile(path.join(bundle, 'packages/migration-engine/package.json')));
  const commands = Object.fromEntries(Object.entries(pkg.bin).map(([name, entry]) => [name, [process.execPath, path.join(engine, entry)]]));
  const mcp = serverFor('claude', release);
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
  return { writes, source, commands };
}

/**
 * No receipt, but a registration may still be there: the receipt folder was
 * deleted, or the consumer is a fresh checkout of a configured repository. It
 * is ours only when it is exactly what this installer writes for the release
 * being installed or for a verified release in this same store; that release
 * then stands in for the missing receipt. Anything else -- another store, an
 * edited entry, an unverifiable release -- is left to the conflict checks.
 *
 * Restoration after adoption is byte-exact to the adopted file minus our block:
 * a separator newline the original install added cannot be told apart from
 * one the consumer wrote, so it stays.
 */
async function adoptRegistration(provider, layout, store, current, rawConfig, rawAgents) {
  const names = await readdir(store).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const releases = names.filter(name => /^\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(name)).map(name => ({ release: path.join(store, name), pin: `sha256:${name.slice(-64)}` }));
  const candidates = [
    ...(provider === 'opencode' ? [false, true] : [false]).map(legacy => ({ ...current, native: mergeConfig(null, layout, null, serverFor(provider, current.release, legacy)).owned, agents: serverFor('claude', current.release) })),
    ...await historicalOwned({ ...current, store, releases }, provider, layout),
  ];
  const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
  const native = layout[3] === null ? null : serversIn(parse(rawConfig ?? '{}') ?? {}, layout[3])['start-migration'];
  const nativeMatch = layout[3] === null
    ? item => (rawConfig?.toString() ?? '').split(item.native).length === 2
    : item => native !== undefined && same(native, item.native);
  const { targets, ...agents } = parse(rawAgents)?.mcpServers?.['start-migration'] ?? {};
  return candidates.find(nativeMatch) ?? candidates.find(item => rawAgents && same(agents, item.agents));
}

async function applyAdapter(provider, { action = 'install', scope, root, store, bundle, pin, runtimeOnly = false, pinned, requiredBy } = {}) {
  const layout = layouts[provider]?.[scope];
  if (!layout || !root || !store) throw new Error('Supported scope, explicit root and external store are required');
  root = path.resolve(root); store = path.resolve(store);
  if (store === root || store.startsWith(`${root}${path.sep}`)) throw new Error('Engine store must be outside the consumer/plugin root');
  const receiptFile = await safePath(root, `.artifact-migration-tools/${provider}.json`);
  const rawReceipt = await optional(receiptFile);
  const previous = rawReceipt ? JSON.parse(rawReceipt) : null;
  const mode = runtimeOnly ? 'runtime' : 'provider';
  if (previous && (previous.provider !== provider || previous.scope !== scope || previous.root !== root || previous.store !== store || (previous.mode ?? 'provider') !== mode)) {
    throw refuse('INSTALL_SELECTION_CONFLICT', 'Installation selection conflict', {
      recorded: { provider: previous.provider, scope: previous.scope, root: previous.root, store: previous.store, mode: previous.mode ?? 'provider' },
      requested: { provider, scope, root, store, mode },
    });
  }
  if (!['install', 'update', 'rollback', 'remove', 'doctor'].includes(action)) throw new Error(`Unknown action: ${action}`);
  const installed = previous ? await validateSelection(previous, provider, layout) : null;
  const history = previous ? await historicalOwned(previous, provider, layout) : [];
  const historical = history.map(item => item.native);
  if (action !== 'install' && !previous) throw new Error('No installation selected');
  // Reinstalling is an update: the same ownership checks, the new bundle.
  if (action === 'install' && previous) action = 'update';
  const configFile = await safePath(root, layout[2]);
  const rawConfig = await optional(configFile);
  const agentsFile = scope === 'project' ? await safePath(root, '.agents/mcp.json') : null;
  const rawAgents = agentsFile ? await optional(agentsFile) : null;
  for (const [relative, hash] of Object.entries(previous?.files ?? {})) {
    if (!ownedPath(relative, provider, layout)) throw new Error(`Invalid ownership manifest: ${relative}`);
    if (digest(await readFile(await safePath(root, relative))) !== hash) throw new Error(`Owned file modified: ${relative}`);
  }
  if (action === 'doctor') {
    // `exec` and repair would run or re-register a protocol-1 engine whose
    // writers ignore this installer's locks: refused, as selection refuses it.
    if (installed && installed.writerLockProtocol !== WRITER_LOCK_PROTOCOL) {
      throw refuse('INSTALL_LOCK_PROTOCOL_UNSUPPORTED', `The installed release ${installed.toolkit.version} uses writer lock protocol ${installed.writerLockProtocol ?? 1}, which this installer (protocol ${WRITER_LOCK_PROTOCOL}) never runs or repairs. Update this root to a protocol-${WRITER_LOCK_PROTOCOL} release (1.4.0 or later); see docs/lock-protocol-cutover.md.`, { version: installed.toolkit.version, writerLockProtocol: installed.writerLockProtocol ?? 1, action });
    }
    // Restore missing or verified historical registrations after both surfaces
    // have rejected conflicts; leave unrelated configuration untouched.
    const merged = mergeConfig(rawConfig, layout, previous.configOwned, previous.mcp, historical);
    const agents = mergeAgents(rawAgents, previous, previous.release, history, provider);
    let mcpRepair = null;
    if (merged.missing || merged.stale || agents) {
      try {
        if (agents) await replace(agentsFile, agents);
        if (merged.missing || merged.stale) await replace(configFile, merged.bytes);
      } catch (error) {
        if (agents) await replace(agentsFile, rawAgents);
        throw error;
      }
      // A host that cannot load an MCP server mid-process needs a restart. The
      // runtime still succeeds: this invocation continues on absolute CLI paths.
      mcpRepair = { repaired: true, server: 'start-migration', registrationFile: merged.missing || merged.stale ? configFile : agentsFile, restartRequired: true };
    }
    const servers = layout[3] ? serversIn(JSON.parse(merged.bytes), layout[3]) : { 'start-migration': previous.mcp };
    return { ...previous, outcome: 'OK', mcpRepair, mcpServers: Object.entries(servers).map(([name, server]) => ({ name, registered: true, portable: server.command !== 'cmd', ...server })), registrationFile: configFile };
  }
  let writes = new Map();
  let receipt = null;
  let server = null;
  let adopted = null;
  if (action !== 'remove') {
    const manifest = await verifyBundle(bundle, pin);
    // Before any write: a protocol-1 release's writers ignore this installer's
    // locks, so it is never installed, updated to or rolled back to from here.
    if (manifest.writerLockProtocol !== WRITER_LOCK_PROTOCOL) {
      throw refuse('INSTALL_LOCK_PROTOCOL_UNSUPPORTED', `Release ${manifest.toolkit.version} uses writer lock protocol ${manifest.writerLockProtocol ?? 1}, which this installer (protocol ${WRITER_LOCK_PROTOCOL}) never installs, updates to or rolls back to: its writers do not honour protocol-${WRITER_LOCK_PROTOCOL} locks. Select a protocol-${WRITER_LOCK_PROTOCOL} release (1.4.0 or later); see docs/lock-protocol-cutover.md.`, { version: manifest.toolkit.version, writerLockProtocol: manifest.writerLockProtocol ?? 1, action });
    }
    const release = path.join(store, `${manifest.toolkit.version}-${pin.slice(7)}`);
    if (action === 'rollback' && !(previous.releases ?? []).some(item => item.release === release && item.pin === pin)) throw new Error('Rollback requires a previously installed exact release');
    const rendered = await renderFiles(bundle, manifest, provider, layout, mode, release);
    if (!same(rendered.source.toolkit, manifest.toolkit)) throw new Error('Adapter identity mismatch');
    ({ writes } = rendered);
    const { commands } = rendered;
    server = serverFor(provider, release);
    if (!previous) {
      adopted = await adoptRegistration(provider, layout, store, { release, pin }, rawConfig, rawAgents);
      // Its files are ours too, where they are exactly what it (or this bundle) writes.
      if (adopted) {
        const theirs = adopted.manifest ? (await renderFiles(adopted.release, adopted.manifest, provider, layout, mode, adopted.release)).writes : writes;
        adopted.files = {};
        for (const relative of new Set([...writes.keys(), ...theirs.keys()])) {
          const bytes = await optional(await safePath(root, relative));
          if (bytes && (bytes.equals(writes.get(relative) ?? Buffer.alloc(0)) || bytes.equals(theirs.get(relative) ?? Buffer.alloc(0)))) adopted.files[relative] = digest(bytes);
        }
      }
    }
    // Rollback is the one action that *creates* intent: it is an explicit,
    // out-of-band operator decision about the skill set in place at the time,
    // and it would be meaningless if the next ordinary invocation undid it. The
    // skill identities it was taken against are recorded with it, so a later
    // `skills add` -- a newer deliberate action -- supersedes it without an
    // operator ever editing or deleting a receipt. Every other action only
    // *carries* a pin the caller already decided to keep.
    //
    // `againstSkill` is the whole recorded requirement set, not one pair: both
    // skills share one receipt, so a pin that named only one of them would be
    // superseded by the other skill's very next invocation and the runtime
    // would alternate -- the exact outcome `requiredBy` exists to prevent.
    const intent = action === 'rollback'
      ? { version: manifest.toolkit.version, by: 'rollback', at: new Date().toISOString(), againstSkill: previous.requiredBy ?? null }
      : pinned;
    const prior = previous?.releases ?? (adopted ? [{ release: adopted.release, pin: adopted.pin }] : []);
    receipt = { provider, scope, mode, root, store, toolkit: manifest.toolkit, skills: manifest.skills, release, pin, commands, mcp: server, files: Object.fromEntries([...writes].map(([name, bytes]) => [name, digest(bytes)])), releases: [...prior.filter(item => item.release !== release), { release, pin }] };
    // Both are selection *intent*, recorded so that two installed skills cannot
    // silently flip the active runtime back and forth between invocations, and
    // so a rollback survives one. Omitted rather than written null when absent,
    // so a receipt that was never pinned stays byte-identical in shape to one
    // written before the fields existed.
    if (intent) receipt.pinned = intent;
    if (requiredBy ?? previous?.requiredBy) receipt.requiredBy = requiredBy ?? previous.requiredBy;
    // Check ownership/config before staging any release or changing a consumer.
  }
  const merged = mergeConfig(rawConfig, layout, previous?.configOwned ?? adopted?.native, server, historical);
  const agents = mergeAgents(rawAgents, previous ?? adopted, receipt?.release, history, provider);
  if (receipt) receipt.configOwned = merged.owned;
  const owned = previous?.files ?? adopted?.files ?? {};
  const backups = new Map();
  for (const relative of new Set([...Object.keys(owned), ...writes.keys(), layout[2], ...(agents ? ['.agents/mcp.json'] : []), `.artifact-migration-tools/${provider}.json`])) {
    const file = await safePath(root, relative);
    const bytes = await optional(file);
    if (writes.has(relative) && bytes && !owned[relative]) throw refuse('INSTALL_UNOWNED_FILE', `Unowned file exists: ${relative}`, { file: relative });
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
    for (const relative of Object.keys(owned)) if (!writes.has(relative)) await rm(await safePath(root, relative));
    for (const [relative, bytes] of writes) await replace(await safePath(root, relative), bytes);
    await replace(configFile, merged.bytes);
    if (agents) await replace(agentsFile, agents);
    if (receipt) await replace(receiptFile, Buffer.from(json(receipt)));
    else await rm(receiptFile);
  } catch (error) {
    for (const [file, bytes] of backups) { if (bytes) await replace(file, bytes); else await rm(file, { force: true }); }
    throw error;
  }
  return receipt ?? { provider, removed: true };
}

const LOCKED = 'Installation locked; inspect interrupted installation before retrying';
// What `rename` of a directory reports while something occupies the lock path
// (EPERM: Windows will not replace an existing directory).
const OCCUPIED = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM']);
const OWNER_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const MAX_OWNER_BYTES = 1024;
const ignore = (...codes) => error => { if (!codes.includes(error.code)) throw error; };
const rmdirIfEmpty = dir => rmdir(dir).catch(ignore('ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'));
// The space a recorded pid means anything in, as in the engine's lifecycle/lock.mjs:
// Windows and WSL share a hostname but not pids, and each Linux pid namespace
// is its own. Null (no /proc) never proves an owner gone.
const PID_REALM = (() => {
  if (process.platform !== 'linux') return process.platform;
  try { return `linux:${readlinkSync('/proc/self/ns/pid')}`; } catch { return null; }
})();

/**
 * Is the lock owner recorded in `file` provably dead?
 *
 * Only when the entry is a regular file of bounded size, read without following
 * a symlink (O_NOFOLLOW where the OS has it, and the opened file must be the
 * lstat-vetted one everywhere), naming this `uuid`, this host and this PID
 * realm, and `kill(pid, 0)` answers ESRCH. EPERM is a live process another user
 * owns, and every other answer -- a torn or foreign entry, another host or
 * realm, an unexpected probe error -- is ambiguous, and ambiguity fails closed:
 * reclaiming a live installer's lock would run two config writers at once.
 */
const lockOwnerDead = async (file, uuid) => {
  let handle;
  let owner;
  try {
    const vetted = await lstat(file);
    if (!vetted.isFile() || vetted.size > MAX_OWNER_BYTES) return false;
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== vetted.dev || opened.ino !== vetted.ino) return false;
    const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_OWNER_BYTES) return false;
    owner = JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } catch { return false; } finally { await handle?.close().catch(() => undefined); }
  if (!owner || typeof owner !== 'object' || owner.uuid !== uuid || owner.hostname !== os.hostname() || PID_REALM === null || owner.realm !== PID_REALM || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};

/**
 * Frees a lock nothing provably holds: 'dead' when a dead owner was removed,
 * 'empty' when there was no owner left (a release or reclaim cut short),
 * 'legacy' for a protocol-1 `install.lock` file, null to fail closed. Each
 * removal is keyed by identity -- the dead owner's own entry name, `rmdir` of
 * an empty directory -- so a reclaimer that lost the race removes nothing of
 * the winner's.
 */
const reclaim = async (lock) => {
  const info = await lstat(lock).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return 'empty';
  // Written by a protocol-1 installer, which does not honour this format: never
  // ours to remove, whoever wrote it and whether or not they are alive.
  if (info.isFile()) return 'legacy';
  if (!info.isDirectory()) return null;
  const entries = await readdir(lock).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; });
  if (entries.length === 0) { await rmdirIfEmpty(lock); return 'empty'; }
  const [entry] = entries;
  if (entries.length !== 1 || !OWNER_ENTRY.test(entry) || !await lockOwnerDead(path.join(lock, entry), entry.slice(0, -5))) return null;
  await unlink(path.join(lock, entry)).catch(ignore('ENOENT', 'ENOTDIR'));
  await rmdirIfEmpty(lock);
  return 'dead';
};

// Doctor repairs a missing registration, so it is a config writer too and takes
// the same single lock per host root instead of racing an install.
export async function adapter(provider, options = {}) {
  if (!layouts[provider]?.[options.scope] || !options.root || !options.store) throw new Error('Supported scope, explicit root and external store are required');
  const lock = await safePath(options.root, '.artifact-migration-tools/install.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  // One config writer per host root. The lock is a directory holding exactly
  // its owner's `<uuid>.json`, staged complete and published by one `rename`,
  // which cannot land on a held lock -- so it never exists without saying who
  // holds it. That is what turns a killed installer from "delete this by hand,
  // forever" into one reclaim, and reclaiming assumes nothing about consistency:
  // `applyAdapter`'s first act on an existing receipt is `validateSelection` +
  // `verifyBundle` + per-file digest checks, so a half-applied install is
  // re-proven, not trusted.
  const id = randomUUID();
  const staging = `${lock}.${id}.tmp`;
  const claim = () => rename(staging, lock).then(() => true, error => { if (OCCUPIED.has(error.code)) return false; throw error; });
  let held = false;
  let recoveredLock = false;
  try {
    await mkdir(staging);
    await writeFile(path.join(staging, `${id}.json`), json({ uuid: id, pid: process.pid, hostname: os.hostname(), realm: PID_REALM, startedAt: new Date().toISOString(), action: options.action ?? 'install', provider }), { flag: 'wx' });
    held = await claim();
    // One reclaim, then one claim: a second installer that also saw the dead
    // owner loses that claim and fails closed with the existing message.
    const freed = held ? null : await reclaim(lock);
    if (freed === 'legacy') throw refuse('INSTALL_LEGACY_LOCK', `${LOCKED}: ${lock} is a lock file from a protocol-1 release, which is never reclaimed automatically. Stop every installer and migration command on this root, old releases included, then remove it by hand (docs/lock-protocol-cutover.md).`, { lock });
    if (freed) { held = await claim(); recoveredLock = held && freed === 'dead'; }
  } finally { if (!held) await rm(staging, { recursive: true, force: true }); }
  if (!held) throw new Error(LOCKED);
  try {
    const result = await applyAdapter(provider, options);
    // Reported, not persisted: the receipt records what is installed, and a
    // reclaimed lock is a fact about this invocation.
    return recoveredLock ? { ...result, recoveredLock } : result;
  }
  finally {
    // Our entry, then the directory only if that emptied it: never another
    // installer's lock, whatever happened to ours meanwhile.
    await unlink(path.join(lock, `${id}.json`)).catch(ignore('ENOENT', 'ENOTDIR'));
    await rmdirIfEmpty(lock);
  }
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
