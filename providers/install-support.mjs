// Shared adapter file/config operations only. Migration rules live in the engine.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const optional = file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
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
      owned.push({ native: mergeConfig(null, layout, null, serverFor(provider, item.release, legacy)).owned, agents: serverFor('claude', item.release) });
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
        else if (ownedBlock.test(text)) throw new Error('Owned MCP configuration was modified');
        else missing = true;
      }
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
    return { bytes: Buffer.from(text + (owned ?? '')), owned: owned ?? null, missing, stale };
  }
  const config = raw ? JSON.parse(raw) : {};
  const [key, nested] = layout[3].split('.');
  const notObject = value => value && (Array.isArray(value) || typeof value !== 'object');
  if (!config || Array.isArray(config) || typeof config !== 'object' || notObject(config[key]) || (nested && notObject(config[key]?.[nested]))) throw new Error('MCP config must be an object');
  const legacy = nested ? config[key]?.['start-migration'] : undefined;
  const found = [(nested ? config[key]?.[nested] : config[key])?.['start-migration'], legacy].filter(entry => entry !== undefined);
  if (found.length > 1 || (raw?.toString().match(/"start-migration"\s*:/g) ?? []).length !== found.length) throw new Error('Conflicting or modified MCP configuration');
  const [existing] = found;
  const missing = Boolean(previous) && existing === undefined;
  const stale = previous && existing !== undefined && !same(existing, previous) && historical.some(owned => same(existing, owned));
  if (!missing && !stale && (previous ? !same(existing, previous) : existing !== undefined)) throw new Error('Conflicting or modified MCP configuration');
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
    if (existing !== undefined || raw.includes('"start-migration"')) throw new Error('Conflicting or modified MCP configuration');
    return null;
  }
  if (existing === undefined) return null;
  if (!previous) throw new Error('Conflicting or modified MCP configuration');
  if ((raw.toString().match(/"start-migration"\s*:/g) ?? []).length !== 1 ||
      (config.targets && !config.targets.includes(provider))) throw new Error('Conflicting or modified MCP configuration');
  if (!existing || Array.isArray(existing) || typeof existing !== 'object') throw new Error('Conflicting or modified MCP configuration');
  const { targets, ...registration } = existing;
  if (targets !== undefined && (!Array.isArray(targets) || !targets.includes(provider) ||
      !targets.every(target => typeof target === 'string' && target.length > 0) || new Set(targets).size !== targets.length)) {
    throw new Error('Conflicting or modified MCP configuration');
  }
  const current = serverFor('claude', previous.release);
  if (!same(registration, current) && !historical.some(item => same(registration, item.agents))) throw new Error('Conflicting or modified MCP configuration');
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
  if (previous && (previous.provider !== provider || previous.scope !== scope || previous.root !== root || previous.store !== store || (previous.mode ?? 'provider') !== mode)) throw new Error('Installation selection conflict');
  if (!['install', 'update', 'rollback', 'remove', 'doctor'].includes(action)) throw new Error(`Unknown action: ${action}`);
  if (previous) await validateSelection(previous, provider, layout);
  const history = previous ? await historicalOwned(previous, provider, layout) : [];
  const historical = history.map(item => item.native);
  if (action !== 'install' && !previous) throw new Error('No installation selected');
  if (action === 'install' && previous) throw new Error('Already installed; select update explicitly');
  const configFile = await safePath(root, layout[2]);
  const rawConfig = await optional(configFile);
  const agentsFile = scope === 'project' ? await safePath(root, '.agents/mcp.json') : null;
  const rawAgents = agentsFile ? await optional(agentsFile) : null;
  for (const [relative, hash] of Object.entries(previous?.files ?? {})) {
    if (!ownedPath(relative, provider, layout)) throw new Error(`Invalid ownership manifest: ${relative}`);
    if (digest(await readFile(await safePath(root, relative))) !== hash) throw new Error(`Owned file modified: ${relative}`);
  }
  if (action === 'doctor') {
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
    const mcp = serverFor('claude', release);
    server = serverFor(provider, release);
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
    receipt = { provider, scope, mode, root, store, toolkit: manifest.toolkit, skills: manifest.skills, release, pin, commands, mcp: server, files: Object.fromEntries([...writes].map(([name, bytes]) => [name, digest(bytes)])), releases: [...(previous?.releases ?? []).filter(item => item.release !== release), { release, pin }] };
    // Both are selection *intent*, recorded so that two installed skills cannot
    // silently flip the active runtime back and forth between invocations, and
    // so a rollback survives one. Omitted rather than written null when absent,
    // so a receipt that was never pinned stays byte-identical in shape to one
    // written before the fields existed.
    if (intent) receipt.pinned = intent;
    if (requiredBy ?? previous?.requiredBy) receipt.requiredBy = requiredBy ?? previous.requiredBy;
    // Check ownership/config before staging any release or changing a consumer.
  }
  const merged = mergeConfig(rawConfig, layout, previous?.configOwned, server, historical);
  const agents = mergeAgents(rawAgents, previous, receipt?.release, history, provider);
  if (receipt) receipt.configOwned = merged.owned;
  const backups = new Map();
  for (const relative of new Set([...Object.keys(previous?.files ?? {}), ...writes.keys(), layout[2], ...(agents ? ['.agents/mcp.json'] : []), `.artifact-migration-tools/${provider}.json`])) {
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

/**
 * Is the recorded lock owner provably dead on this host?
 *
 * Only `ESRCH` -- no such process -- proves it. `EPERM` means the pid exists
 * and belongs to someone else, an unparseable file means nothing is known, and
 * a different hostname means the pid number says nothing about that machine's
 * process table. Every one of those is ambiguous, and ambiguity fails closed:
 * reclaiming a live installer's lock would run two config writers at once.
 */
const lockOwnerDead = async (lock) => {
  let owner;
  try { owner = JSON.parse(await readFile(lock, 'utf8')); } catch { return false; }
  if (!owner || typeof owner !== 'object' || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};

// Doctor repairs a missing registration, so it is a config writer too and takes
// the same single lock per host root instead of racing an install.
export async function adapter(provider, options = {}) {
  if (!layouts[provider]?.[options.scope] || !options.root || !options.store) throw new Error('Supported scope, explicit root and external store are required');
  const lock = await safePath(options.root, '.artifact-migration-tools/install.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  // One config writer per host root, still the same `wx` open, so mutual
  // exclusion is unchanged. The file now says who holds it, which is what turns
  // a killed installer from "delete this by hand, forever" into one reclaim --
  // and reclaiming assumes nothing about consistency: `applyAdapter`'s first act
  // on an existing receipt is `validateSelection` + `verifyBundle` + per-file
  // digest checks, so a half-applied install is re-proven, not trusted.
  const claim = () => open(lock, 'wx').then(
    handle => handle.writeFile(json({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), action: options.action ?? 'install', provider })).then(() => handle),
    error => { if (error.code === 'EEXIST') return null; throw error; },
  );
  let handle = await claim();
  let recoveredLock = false;
  if (!handle && await lockOwnerDead(lock)) {
    // One `rm` then one `wx` open: a second installer that also saw the dead pid
    // loses the race with EEXIST and fails closed with the existing message.
    await rm(lock, { force: true });
    handle = await claim();
    recoveredLock = handle !== null;
  }
  if (!handle) throw new Error(LOCKED);
  try {
    const result = await applyAdapter(provider, options);
    // Reported, not persisted: the receipt records what is installed, and a
    // reclaimed lock is a fact about this invocation.
    return recoveredLock ? { ...result, recoveredLock } : result;
  }
  finally { await handle.close(); await rm(lock, { force: true }); }
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
