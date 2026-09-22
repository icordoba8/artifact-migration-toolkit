#!/usr/bin/env node

// Shared source for the copies shipped inside both independently installable skills.
// It resolves transport only; release verification, installation, receipts and MCP
// ownership stay in the release's provider adapter.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants as fsConstants, mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'icordoba8/artifact-migration-tools';
const TOOLKIT = 'artifact-migration-tools';
const PROVIDERS = new Map([
  ['claude', 'claude'], ['claude-code', 'claude'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
  ['copilot', 'copilot'], ['github-copilot', 'copilot'],
]);
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const exactVersion = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '');
const assetName = version => `${TOOLKIT}-v${version}.tar.gz`;

const run = async (command, args, options = {}) => {
  try {
    return await execFileAsync(command, args, { encoding: options.encoding ?? 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error });
  }
};

const gitCredential = async () => {
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`git credential exited ${code}`)));
      child.stdin.end('protocol=https\nhost=github.com\n\n');
    });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
    return fields.username && fields.password
      ? `Basic ${Buffer.from(`${fields.username}:${fields.password}`).toString('base64')}`
      : null;
  } catch { return null; }
};

const requestHeaders = async (accept = 'application/vnd.github+json') => {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const authorization = token ? `Bearer ${token}` : await gitCredential();
  return { Accept: accept, 'X-GitHub-Api-Version': '2026-03-10', ...(authorization && { Authorization: authorization }) };
};

export async function apiJson(route, { execute = run, request = fetch, headers = requestHeaders } = {}) {
  try {
    const { stdout } = await execute('gh', ['api', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', route]);
    return { value: JSON.parse(stdout), viaGh: true };
  } catch (ghError) {
    const response = await request(`https://api.github.com${route}`, { headers: await headers() });
    if (!response.ok) throw new Error(`GitHub API ${route} returned ${response.status}`, { cause: ghError });
    return { value: await response.json(), viaGh: false };
  }
}

async function tagCommit(tag, api = apiJson) {
  let { value: object } = await api(`/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`);
  object = object.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    ({ value: object } = await api(`/repos/${REPOSITORY}/git/tags/${object.sha}`));
    object = object.object;
  }
  if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error(`Release tag ${tag} does not resolve to one commit`);
  return object.sha;
}

export async function resolveRelease(version, { api = apiJson } = {}) {
  if (version !== undefined && !exactVersion(version)) throw new Error('Exact --version must be X.Y.Z');
  const route = version
    ? `/repos/${REPOSITORY}/releases/tags/v${version}`
    : `/repos/${REPOSITORY}/releases/latest`;
  const { value: release, viaGh } = await api(route);
  const resolved = release.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!resolved || (version && resolved !== version) || release.draft || release.prerelease) throw new Error('GitHub Release is not an exact stable release');
  if (release.immutable !== true) throw new Error(`GitHub Release v${resolved} is not immutable`);
  const expectedAsset = assetName(resolved);
  const assets = release.assets?.filter(asset => asset.name === expectedAsset) ?? [];
  if (assets.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest ?? '')) throw new Error(`Release must have one digest-bearing ${expectedAsset} asset`);
  return { asset: assets[0], commit: await tagCommit(release.tag_name, api), release, version: resolved, viaGh };
}

export async function downloadAsset(resolved, destination) {
  if (resolved.viaGh) {
    await run('gh', ['release', 'download', `v${resolved.version}`, '--repo', REPOSITORY, '--pattern', resolved.asset.name, '--dir', path.dirname(destination), '--clobber']);
  } else {
    const response = await fetch(resolved.asset.url, { headers: await requestHeaders('application/octet-stream') });
    if (!response.ok || !response.body) throw new Error(`Release asset download returned ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(destination, { flags: 'wx' }));
  }
  await verifyDownloadedAsset(destination, resolved.asset.digest);
}

export async function verifyDownloadedAsset(file, expected) {
  if (sha256(await readFile(file)) !== expected) throw new Error('Release asset digest mismatch');
}

const safeArchiveEntry = entry => {
  const normalized = entry.replace(/\/$/, '');
  return normalized && !path.isAbsolute(normalized) && !normalized.includes('\\') && normalized.split('/').every(part => part && part !== '.' && part !== '..');
};

async function extractArchive(archive, destination, version) {
  const { stdout } = await run('tar', ['-tzf', archive]);
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some(entry => !safeArchiveEntry(entry))) throw new Error('Unsafe or empty release archive');
  await run('tar', ['-xzf', archive, '-C', destination]);
  const bundle = path.join(destination, `${TOOLKIT}-${version}`);
  if (!(await stat(path.join(bundle, 'release-manifest.json'))).isFile()) throw new Error('Release archive has no bundle manifest');
  return bundle;
}

const defaultStore = () => process.env.ARTIFACT_MIGRATION_TOOLS_STORE || path.join(
  process.platform === 'win32' ? (process.env.LOCALAPPDATA || os.homedir()) : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')),
  TOOLKIT,
);

async function adapterRun(provider, release, options) {
  const support = await import(pathToFileURL(path.join(release, 'providers/install-support.mjs')).href);
  return support.adapter(provider, options);
}

/**
 * The exact toolkit identity a `{store, release, pin}` triple actually resolves
 * to on disk, taken from the pinned manifest and never from the store folder
 * name -- the name is only *checked* against the verified manifest. The release
 * adapter's own `verifyBundle` re-verifies every file before anything installs;
 * this is the cheap identity read that selection needs first.
 */
async function pinnedToolkit(store, release, pin) {
  if (typeof release !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(pin ?? '')) throw new Error('Invalid runtime receipt identity');
  const manifestBytes = await readFile(path.join(release, 'release-manifest.json'));
  if (sha256(manifestBytes) !== pin) throw new Error('Runtime receipt manifest checksum mismatch');
  const manifest = JSON.parse(manifestBytes);
  const toolkit = manifest.toolkit;
  if (!exactVersion(toolkit?.version) || release !== path.join(store, `${toolkit.version}-${pin.slice(7)}`)) throw new Error('Runtime receipt release path conflict');
  const launcher = await readFile(path.join(release, 'providers/install-support.mjs'));
  if (sha256(launcher) !== manifest.files?.['providers/install-support.mjs']) throw new Error('Runtime installer checksum mismatch');
  return toolkit;
}

async function validateReceiptLauncher(receipt) {
  const toolkit = await pinnedToolkit(receipt.store, receipt.release, receipt.pin);
  if (JSON.stringify(toolkit) !== JSON.stringify(receipt.toolkit)) throw new Error('Runtime receipt toolkit identity mismatch');
}

/**
 * A verified runtime another provider already installed in THIS consumer.
 *
 * Switching providers is not a reason to resolve, download and verify a release
 * that is already present and provably identical. Candidates come only from
 * sibling receipts under the same root and store; each one is re-verified from
 * its pinned manifest, and the five identity fields must agree exactly across
 * all of them. Disagreement fails closed rather than picking a winner.
 *
 * An explicit exact version never adopts a sibling's version: it filters to
 * that version alone, and may also select a release the sibling still retains
 * for rollback -- those are receipt-proven and verified the same way.
 */
async function siblingSelection({ provider, root, store, version }) {
  const directory = path.join(root, '.artifact-migration-tools');
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const candidates = new Map();
  for (const name of names.sort()) {
    const sibling = name.endsWith('.json') && PROVIDERS.get(name.slice(0, -5));
    if (!sibling || sibling === provider) continue;
    let receipt;
    try { receipt = JSON.parse(await readFile(path.join(directory, name), 'utf8')); } catch { continue; }
    if (receipt?.provider !== sibling || receipt.root !== root || receipt.store !== store) continue;
    for (const item of [{ release: receipt.release, pin: receipt.pin }, ...(version ? receipt.releases ?? [] : [])]) {
      let toolkit;
      try { toolkit = await pinnedToolkit(store, item.release, item.pin); } catch { continue; }
      if (version && toolkit.version !== version) continue;
      const identity = { version: toolkit.version, commit: toolkit.commit, contentHash: toolkit.contentHash, release: item.release, pin: item.pin };
      candidates.set(JSON.stringify(identity), { ...identity, toolkit, provider: sibling });
    }
  }
  if (candidates.size > 1) throw new Error(`Sibling ${TOOLKIT} receipts disagree on the installed toolkit identity; reinstall or remove the conflicting providers explicitly`);
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

// v1.0.0's engine doctor required `.agents/knowledge/migrations` to already
// exist; v1.1.0 accepts a path it can still create. A pinned v1.0.0 runtime
// therefore answers BLOCKED for a freshly installed consumer that this release
// considers healthy, and an otherwise valid receipt would block first use.
//
// Normalized here, and only here: the legacy blocker alone, in that exact
// shape, with the absence and the writable ancestor both re-established from
// this release rather than taken on the legacy doctor's word. Anything else --
// a present-but-unwritable root, a different cause, a second blocker, a runtime
// already on v1.1.0 -- stays fatal.
const LEGACY_KNOWLEDGE_ROOT = /^knowledge-root: ENOENT:[^']*'(.+[/\\]\.agents[/\\]knowledge[/\\]migrations)'$/;

const preV110 = version => {
  const [major, minor] = version.split('.').map(Number);
  return major < 1 || (major === 1 && minor < 1);
};

/** The v1.1.0 knowledge-root probe, re-run here: the path, or its nearest existing ancestor, must be writable. */
const knowledgeRootCreatable = async root => {
  for (let current = root; ; current = path.dirname(current)) {
    try { await access(current, fsConstants.W_OK); return true; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    if (path.dirname(current) === current) return false;
  }
};

async function legacyKnowledgeRootOnly(receipt, doctor) {
  if (!preV110(receipt.toolkit.version) || doctor.blockers.length !== 1) return false;
  const root = doctor.blockers[0].match(LEGACY_KNOWLEDGE_ROOT)?.[1];
  if (!root) return false;
  try { await stat(root); return false; } // Present: the legacy check failed for some other reason.
  catch (error) { if (error.code !== 'ENOENT') return false; }
  return knowledgeRootCreatable(root);
}

async function localPreflight(receipt) {
  await validateReceiptLauncher(receipt);
  const runtimeOnly = receipt.mode === 'runtime';
  const adapterDoctor = await adapterRun(receipt.provider, receipt.release,
    { action: 'doctor', scope: receipt.scope, root: receipt.root, store: receipt.store, runtimeOnly });
  const command = receipt.commands['artifact-migration-discover'];
  if (!command) throw new Error('Runtime receipt has no discovery command');
  const { runDoctor } = await import(pathToFileURL(path.join(receipt.release, 'packages/migration-engine/src/migration-utils.mjs')).href);
  const engineDoctor = await runDoctor({ cwd: receipt.root });
  if (engineDoctor.outcome === 'OK') return { adapterDoctor, engineDoctor };
  if (!(await legacyKnowledgeRootOnly(receipt, engineDoctor))) throw new Error(`Engine doctor blocked: ${engineDoctor.blockers.join('; ')}`);
  // Reported as waived rather than dropped: the legacy verdict stays on the record.
  return { adapterDoctor, engineDoctor: { ...engineDoctor, outcome: 'OK', blockers: [], waived: engineDoctor.blockers } };
}

export async function ensureRuntime(
  { provider, root = process.cwd(), store = defaultStore(), version } = {},
  { resolve = resolveRelease, download = downloadAsset } = {},
) {
  provider = PROVIDERS.get(provider);
  if (!provider) throw new Error(`--provider must be one of: ${[...new Set(PROVIDERS.values())].join(', ')}`);
  if (version === undefined) version = process.env.ARTIFACT_MIGRATION_TOOLS_VERSION;
  if (version !== undefined && !exactVersion(version)) throw new Error('Exact version override must be X.Y.Z');
  root = path.resolve(root);
  store = path.resolve(store);
  const receiptFile = path.join(root, `.artifact-migration-tools/${provider}.json`);
  let previous = null;
  try { previous = JSON.parse(await readFile(receiptFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (previous.provider !== provider || previous.root !== root || previous.store !== store)) throw new Error('Runtime receipt selection conflict');

  const result = (receipt, extra, doctors) => ({
    outcome: 'OK', toolkit: receipt.toolkit, commands: receipt.commands, mcp: receipt.mcp,
    // Structured repair/restart state. The registration was restored, so this
    // invocation continues on the absolute CLI commands above and the host may
    // need a restart before the MCP server itself is reachable.
    mcpRepair: doctors.adapterDoctor?.mcpRepair ?? null, ...extra, ...doctors,
  });

  if (previous && (!version || previous.toolkit?.version === version)) {
    return result(previous, { bootstrapped: false }, await localPreflight(previous));
  }

  // Another provider in this consumer may already have a verified runtime. A
  // provider switch must not require the network to install the same release.
  const sibling = previous ? null : await siblingSelection({ provider, root, store, version });
  if (sibling) {
    const receipt = await adapterRun(provider, sibling.release, {
      provider, scope: 'project', root, store, action: 'install',
      bundle: sibling.release, pin: sibling.pin, runtimeOnly: true,
    });
    return result(receipt, { bootstrapped: true, reusedFrom: sibling.provider }, await localPreflight(receipt));
  }

  const resolved = await resolve(version);
  const temporary = await mkdtemp(path.join(os.tmpdir(), `${TOOLKIT}-`));
  try {
    const archive = path.join(temporary, resolved.asset.name);
    await download(resolved, archive);
    const bundle = await extractArchive(archive, temporary, resolved.version);
    const manifestBytes = await readFile(path.join(bundle, 'release-manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    if (manifest.toolkit?.name !== TOOLKIT || manifest.toolkit.version !== resolved.version || manifest.toolkit.commit !== resolved.commit) throw new Error('Release manifest identity does not match its immutable GitHub Release');
    await mkdir(store, { recursive: true });
    const selection = { provider, scope: 'project', root, store };
    const runtimeOnly = previous ? previous.mode === 'runtime' : true;
    const receipt = await adapterRun(provider, bundle, {
      ...selection, action: previous ? 'update' : 'install', bundle,
      pin: sha256(manifestBytes), runtimeOnly,
    });
    return result(receipt, { bootstrapped: true }, await localPreflight(receipt));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: { provider: { type: 'string' }, root: { type: 'string' }, store: { type: 'string' }, version: { type: 'string' } },
  });
  if (positionals.length !== 1 || positionals[0] !== 'ensure') throw new Error('Usage: runtime.mjs ensure --provider <claude|codex|opencode|copilot> [--root <path>] [--store <path>] [--version X.Y.Z]');
  process.stdout.write(`${JSON.stringify(await ensureRuntime(values), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
