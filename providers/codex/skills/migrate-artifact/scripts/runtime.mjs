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
const REPOSITORY = 'icordoba8/artifact-migration-toolkit';
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const IDENTITY_FILE = 'release-identity.json';

/**
 * The installed skill's exact identity, read from the stamp beside this skill.
 *
 * This file is a *requirement*, never a trust anchor: it states which immutable
 * release carries the skill semantics being executed, and that release still has
 * to be resolved, digest-verified and made to *prove* the claim. The worst a
 * tampered stamp can do is demand a release that cannot satisfy it, which fails
 * closed, or name a different legitimate release -- the same power `--version`
 * already grants an operator.
 *
 * It cannot be recomputed from the installed bytes: installation renders the
 * engine MCP entry placeholder and every CLI name into absolute paths and
 * rewrites provider frontmatter, so installed bytes legitimately differ per
 * provider and per install path. The identity has to be carried.
 */
export async function readSkillRelease() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', IDENTITY_FILE);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * A selection refusal that names both sides and asserts what was not written.
 *
 * Every one of these leaves the receipt, the runtime store, the provider
 * configuration and the MCP registration byte-identical: the failure branches
 * contain no write and no delete, and the only writer is the adapter, which is
 * not reached. They are deliberately typed rather than folded into a generic
 * fallback, because the whole defect class being fixed is a split that stayed
 * silent.
 */
export class RuntimeSelectionError extends Error {
  constructor(code, message, state = {}) {
    super(message);
    this.name = 'RuntimeSelectionError';
    this.code = code;
    this.state = { code, ...state, receipt: 'unchanged' };
  }
}

const REMEDY = 'Reinstall the skill with `skills add` from a published release, or select a release explicitly with `--version X.Y.Z`.';

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
 * The exact release manifest a `{store, release, pin}` triple actually resolves
 * to on disk, taken from the pinned bytes and never from the store folder
 * name -- the name is only *checked* against the verified manifest. The release
 * adapter's own `verifyBundle` re-verifies every file before anything installs;
 * this is the cheap identity read that selection needs first.
 */
async function pinnedManifest(store, release, pin) {
  if (typeof release !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(pin ?? '')) throw new Error('Invalid runtime receipt identity');
  const manifestBytes = await readFile(path.join(release, 'release-manifest.json'));
  if (sha256(manifestBytes) !== pin) throw new Error('Runtime receipt manifest checksum mismatch');
  const manifest = JSON.parse(manifestBytes);
  const toolkit = manifest.toolkit;
  if (!exactVersion(toolkit?.version) || release !== path.join(store, `${toolkit.version}-${pin.slice(7)}`)) throw new Error('Runtime receipt release path conflict');
  const launcher = await readFile(path.join(release, 'providers/install-support.mjs'));
  if (sha256(launcher) !== manifest.files?.['providers/install-support.mjs']) throw new Error('Runtime installer checksum mismatch');
  return manifest;
}

/**
 * The receipt's own pinned manifest, or `null` when that release is simply not
 * on this disk any more.
 *
 * Only `ENOENT` is absence. A checksum mismatch, a path conflict or an identity
 * disagreement is tampering or a discipline breach and propagates: an integrity
 * failure must never be downgraded into a cache miss that silently reinstalls.
 */
async function receiptManifest(receipt) {
  let manifest;
  try { manifest = await pinnedManifest(receipt.store, receipt.release, receipt.pin); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!same(manifest.toolkit, receipt.toolkit)) throw new Error('Runtime receipt toolkit identity mismatch');
  return manifest;
}

async function validateReceiptLauncher(receipt) {
  if (!(await receiptManifest(receipt))) throw new Error(`Runtime receipt release is missing from the store: ${receipt.release}`);
}

/**
 * Does a candidate release carry exactly what the selection requires?
 *
 * (1)-(2) *select* a candidate; (3) *proves* it carries the skill semantics
 * installed right now; (4) strengthens the binding to full byte identity when
 * the skill itself came out of a release artifact. (3) is mandatory in every
 * case: SemVer equality alone proves nothing about bytes, because `skills add
 * <repo>` installs current `main` under an already-published version string.
 *
 * Checkable entirely offline -- its inputs are the installed stamp and the
 * hash-verified pinned manifest -- so a mismatch never needs the network to be
 * detected, only to be *fixed*.
 */
const satisfies = (manifest, require) =>
  manifest?.toolkit?.name === TOOLKIT &&
  manifest.toolkit.version === require.version &&
  (require.exact === null || (
    manifest.skills?.skills?.[require.exact.skill]?.computedHash === require.exact.computedHash &&
    (require.exact.source !== 'release' || (
      manifest.toolkit.commit === require.exact.commit &&
      manifest.toolkit.contentHash === require.exact.contentHash))));

/** A local release that verifies against its pin *and* proves the requirement. */
async function accept(store, release, pin, require, origin) {
  let manifest;
  try { manifest = await pinnedManifest(store, release, pin); } catch { return null; }
  return satisfies(manifest, require) ? { release, pin, manifest, origin } : null;
}

/** Releases this receipt still retains for rollback. Never a downgrade: the
 *  requirement names one exact release, so history can only ever *match* it. */
async function fromHistory(previous, store, require) {
  for (const item of previous.releases ?? []) {
    const found = await accept(store, item.release, item.pin, require, 'history');
    if (found) return found;
  }
  return null;
}

/**
 * A verified runtime another provider already installed in THIS consumer.
 *
 * Switching providers is not a reason to resolve, download and verify a release
 * that is already present and provably identical. Candidates come only from
 * sibling receipts under the same root and store, and each is filtered by the
 * *full* requirement rather than by version: a sibling at the right version
 * whose pinned manifest proves a different skill digest is not a candidate, and
 * a sibling on another release is simply not one either -- it is some other
 * release, not a conflict, so it can never block a new provider.
 *
 * Disagreement among candidates that all claim to satisfy the *same*
 * requirement is still fatal. That is only reachable under tampering or a
 * release-discipline breach, and it stays a tripwire rather than a version guard.
 */
async function fromSiblings({ provider, root, store, require }) {
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
    for (const item of [{ release: receipt.release, pin: receipt.pin }, ...(receipt.releases ?? [])]) {
      const found = await accept(store, item.release, item.pin, require, sibling);
      if (!found) continue;
      const { toolkit } = found.manifest;
      candidates.set(JSON.stringify({ commit: toolkit.commit, contentHash: toolkit.contentHash, release: item.release, pin: item.pin }), found);
    }
  }
  if (candidates.size > 1) throw new Error(`Sibling ${TOOLKIT} receipts disagree on the installed toolkit identity; reinstall or remove the conflicting providers explicitly`);
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

/**
 * The shared release store, as a last local source. The directory name is a
 * hint and nothing more: the pin it encodes is checked against the verified
 * manifest by `pinnedManifest`, so a renamed or planted directory cannot smuggle
 * in a release. This adds a source, not a trust assumption.
 *
 * ponytail: no garbage collection of leaked `<release>.<uuid>.tmp` staging dirs
 * here. The store is shared across consumers but the install lock is per
 * consumer root, so removing another root's in-flight staging directory would
 * break a live install to reclaim disk. Upgrade path: an age threshold, once
 * leaked staging dirs are observed to actually accumulate.
 */
async function fromStore(store, require) {
  let names;
  try { names = await readdir(store); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names.sort()) {
    const hex = name.startsWith(`${require.version}-`) && name.slice(require.version.length + 1);
    if (!/^[a-f0-9]{64}$/.test(hex || '')) continue;
    const found = await accept(store, path.join(store, name), `sha256:${hex}`, require, 'store');
    if (found) return found;
  }
  return null;
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

/**
 * A rollback pin is a decision about the skill set that was in place when it was
 * taken. It stands across ordinary invocations -- a rollback the next invocation
 * undoes is not a rollback -- and is superseded as soon as the operator takes a
 * newer deliberate action (`skills add`) that changes an installed skill's
 * digest. That is also how a pin is cleared: no new command, no JSON editing.
 *
 * `againstSkill` holds the whole recorded requirement set because both skills
 * share one receipt; a skill with no record there had taken no prior position,
 * so it does not supersede the pin on its own.
 */
const pinStillValid = (pinned, skill) => {
  if (pinned?.by !== 'rollback' || !exactVersion(pinned.version)) return false;
  const recorded = skill?.skill ? pinned.againstSkill?.[skill.skill] : null;
  return !recorded || recorded.computedHash === skill.computedHash;
};

/** Only a pin that is still the reason for this selection survives the write. */
const carryPin = (previous, require, skill) =>
  require.reason === 'skill' ? undefined
    : pinStillValid(previous?.pinned, skill) ? previous.pinned : undefined;

/** What this skill now requires of the receipt, merged over the other skill's. */
const recordRequirement = (previous, exact) => exact
  ? { ...previous?.requiredBy, [exact.skill]: { skill: exact.skill, version: exact.version, computedHash: exact.computedHash } }
  : previous?.requiredBy;

/**
 * Another installed skill has already moved this receipt forward past what this
 * one requires, so honouring this skill would drag the runtime *back* and the
 * next invocation of the other skill would drag it forward again -- the runtime
 * and the MCP registration rewritten on alternating invocations. Refusing and
 * naming both is strictly better than that, and it is the only outcome a user
 * can act on.
 *
 * Deliberately one-directional. A *forward* move is how the normal "update both
 * skills" flow works: whichever skill runs first converges and records, and the
 * second then agrees. Flagging disagreement in both directions would refuse that
 * flow, because the other skill's record is legitimately stale until it runs.
 *
 * ponytail: version ordering is used only as this anti-flip-flop ratchet, never
 * as selection authority -- which stays exact identity.
 */
const conflictingRequirement = (requiredBy, exact) => {
  for (const recorded of Object.values(requiredBy ?? {})) {
    if (recorded.skill === exact.skill || !exactVersion(recorded.version)) continue;
    if (recorded.version.localeCompare(exact.version, 'en', { numeric: true }) > 0) return recorded;
  }
  return null;
};

/** A 404 is the only "this release was never published"; anything else is transport. */
const releaseMissing = error => {
  for (let current = error; current; current = current.cause) {
    if (/\b404\b|not found/i.test(String(current.message ?? ''))) return true;
  }
  return false;
};

export async function ensureRuntime(
  { provider, root = process.cwd(), store = defaultStore(), version } = {},
  { resolve = resolveRelease, download = downloadAsset, skillRelease = readSkillRelease } = {},
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
  if (previous && (previous.provider !== provider || previous.root !== root || previous.store !== store)) {
    // Names both sides. The common cause is one repository driven from two
    // environments -- a Windows checkout and the same tree under WSL resolve a
    // different store and a different absolute root, so the two are mutually
    // exclusive over one `.artifact-migration-tools/`. Fail-closed is correct;
    // an error that named neither cause nor remedy was not.
    throw new Error(
      `Runtime receipt selection conflict: this receipt was written for provider "${previous.provider}" / root "${previous.root}" / store "${previous.store}" `
      + `but this invocation resolved provider "${provider}" / root "${root}" / store "${store}". `
      + 'Run the toolkit from one environment, or pass --root/--store explicitly.',
    );
  }

  // ---- authority: explicit override > valid rollback pin > exact skill identity
  const skill = await skillRelease();
  let require;
  if (version !== undefined) {
    // Development / admin / CI path. One invocation only, persists no intent,
    // and deliberately bypasses the identity predicate -- this is the defined
    // escape for an unreleased or identity-less skill.
    require = { version, exact: null, reason: 'explicit', skillIdentity: 'unverified' };
  } else if (pinStillValid(previous?.pinned, skill)) {
    require = { version: previous.pinned.version, exact: null, reason: 'pinned', skillIdentity: 'pinned' };
  } else if (!skill || skill.name !== TOOLKIT || !exactVersion(skill.version)) {
    throw new RuntimeSelectionError('SKILL_IDENTITY_MISSING',
      `This skill carries no usable ${IDENTITY_FILE}, so the toolkit release containing its semantics cannot be determined. ${REMEDY}`,
      { required: null });
  } else if (typeof skill.computedHash !== 'string') {
    throw new RuntimeSelectionError('SKILL_IDENTITY_LEGACY',
      `This skill predates exact identity binding and states no computedHash. Reinstall it with \`skills add\` to adopt it, or select a release with \`--version X.Y.Z\`.`,
      { required: skill.version, skill: skill.skill });
  } else {
    require = { version: skill.version, exact: skill, reason: 'skill', skillIdentity: 'required' };
  }

  const conflict = require.exact && conflictingRequirement(previous?.requiredBy, require.exact);
  if (conflict) {
    throw new RuntimeSelectionError('SKILL_SET_INCOHERENT',
      `Installed skills require different toolkit releases: "${require.exact.skill}" requires ${require.exact.version} (${require.exact.computedHash}) `
      + `while "${conflict.skill}" already selected ${conflict.version} (${conflict.computedHash}) for this provider. `
      + 'Install both skills from the same release (`skills add` each).',
      { required: require.exact.version, installed: conflict.version, reason: require.reason });
  }

  const result = (receipt, extra, doctors) => ({
    outcome: 'OK', toolkit: receipt.toolkit, commands: receipt.commands, mcp: receipt.mcp,
    // Structured repair/restart state. The registration was restored, so this
    // invocation continues on the absolute CLI commands above and the host may
    // need a restart before the MCP server itself is reachable.
    mcpRepair: doctors.adapterDoctor?.mcpRepair ?? null,
    selection: require.reason, skillIdentity: require.skillIdentity, ...extra, ...doctors,
  });

  // ---- local sources, strongest first. No network anywhere in this block. ----
  const installed = previous ? await receiptManifest(previous) : null;
  if (installed && satisfies(installed, require)) {
    return result(previous, { bootstrapped: false, network: false }, await localPreflight(previous));
  }

  let local = previous ? await fromHistory(previous, store, require) : null;
  local ??= await fromSiblings({ provider, root, store, require });
  local ??= await fromStore(store, require);

  const converge = async (bundle, pin, extra) => {
    const receipt = await adapterRun(provider, bundle, {
      provider, scope: 'project', root, store,
      action: previous ? 'update' : 'install', bundle, pin,
      runtimeOnly: previous ? previous.mode === 'runtime' : true,
      pinned: carryPin(previous, require, skill),
      requiredBy: recordRequirement(previous, require.exact),
    });
    // One lock: receipt, commands, provider-owned MCP registration and owned
    // files converge together or every backed-up file is restored.
    return result(receipt, { bootstrapped: true, ...extra }, await localPreflight(receipt));
  };

  if (local) return converge(local.release, local.pin, { reusedFrom: local.origin, network: false });

  // ---- network, only now, and always an exact tag; never /releases/latest. ---
  let resolved;
  try { resolved = await resolve(require.version); }
  catch (error) {
    if (releaseMissing(error)) {
      throw new RuntimeSelectionError('RELEASE_NOT_PUBLISHED',
        `No immutable release carries version ${require.version}, which the installed skill requires. ${REMEDY}`,
        { required: require.version, skill: require.exact?.skill, reason: require.reason, detail: error.message });
    }
    if (installed) {
      throw new RuntimeSelectionError('RUNTIME_UPDATE_REQUIRED_OFFLINE',
        `The installed runtime ${previous.toolkit.version} does not carry the semantics this skill requires (${require.version}), `
        + `and the exact release is neither available locally nor reachable. Reconnect once, or select a release with \`--version X.Y.Z\`.`,
        { installed: previous.toolkit.version, required: require.version, reason: require.reason, detail: error.message });
    }
    throw error;
  }
  // The resolver is a dependency, so this is a trust boundary: `resolveRelease`
  // enforces it already, but an injected one that answered with a *different*
  // version would otherwise fail later as an identity mismatch and name the
  // digest, which is not what went wrong. Selection resolves one exact tag.
  if (resolved.version !== require.version) throw new Error(`Release resolution returned v${resolved.version} for required v${require.version}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), `${TOOLKIT}-`));
  try {
    const archive = path.join(temporary, resolved.asset.name);
    await download(resolved, archive);
    const bundle = await extractArchive(archive, temporary, resolved.version);
    const manifestBytes = await readFile(path.join(bundle, 'release-manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    if (manifest.toolkit?.name !== TOOLKIT || manifest.toolkit.version !== resolved.version || manifest.toolkit.commit !== resolved.commit) throw new Error('Release manifest identity does not match its immutable GitHub Release');
    if (!satisfies(manifest, require)) {
      throw new RuntimeSelectionError('SKILL_IDENTITY_UNRELEASED',
        `The installed "${require.exact.skill}" skill's semantics are not the semantics published in v${require.version}: `
        + `the skill requires ${require.exact.computedHash} and that release proves ${manifest.skills?.skills?.[require.exact.skill]?.computedHash ?? 'nothing for this skill'}. ${REMEDY}`,
        { required: require.exact.computedHash, releaseProves: manifest.skills?.skills?.[require.exact.skill]?.computedHash ?? null, version: require.version, skill: require.exact.skill });
    }
    await mkdir(store, { recursive: true });
    return await converge(bundle, sha256(manifestBytes), { network: true });
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
  main(process.argv.slice(2)).catch(error => {
    // The typed state too, machine-readable, for an MCP caller reading stderr:
    // a refusal has to be actionable without parsing an English sentence.
    process.stderr.write(`${error.message}\n`);
    if (error.state) process.stderr.write(`${JSON.stringify(error.state, null, 2)}\n`);
    process.exitCode = 1;
  });
}
