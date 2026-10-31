/** Trusted-side evidence only. Never repairs a consumer or awards human acceptance. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const exists = file => lstat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

// Include directories, modes and link destinations: empty files alone cannot prove a read-only tree.
export async function snapshotTree(root) {
  const entries = Object.create(null);
  async function visit(relative) {
    const file = path.join(root, relative), info = await lstat(file);
    const item = { mode: info.mode };
    if (info.isSymbolicLink()) item.link = await readlink(file);
    else if (info.isFile()) item.sha256 = sha256(await readFile(file));
    else if (!info.isDirectory()) throw new Error('Unsupported evidence entry: ' + file);
    entries[relative] = item;
    if (info.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
  }
  await visit('');
  return entries;
}
export const sameTree = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const pendingTransaction = async record => await exists(path.join(record, 'transaction.json')) || await exists(path.join(record, 'advance.journal'));

export async function checkpoint(record, lock) {
  if (await exists(lock) || await pendingTransaction(record)) return null;
  const stateBytes = await readFile(path.join(record, 'state.json'));
  const state = JSON.parse(stateBytes);
  const history = await readFile(path.join(record, 'history/history.ndjson'), 'utf8');
  const events = history.trim().split('\n').map(line => JSON.parse(line));
  const tail = events.at(-1);
  if (!['STEP_COMPLETED', 'ADVANCED'].includes(tail?.event) || tail.revision !== state.revision ||
      state.currentStep === 'COMPLETE' || !history.endsWith('\n')) return null;
  const integrity = await readFile(path.join(record, 'integrity.json'));
  const frozen = Object.create(null);
  for (const key of Object.keys(state.artifactHashes ?? {}).sort()) {
    if (key.includes('#')) continue; // The installed engine validates semantic/projection pins on status.
    if (path.isAbsolute(key) || key.split(/[\\/]/).includes('..')) throw new Error('Unsafe checkpoint pin');
    frozen[key] = sha256(await readFile(path.join(record, key)));
  }
  if (await exists(lock) || await pendingTransaction(record) ||
      !stateBytes.equals(await readFile(path.join(record, 'state.json')))) return null;
  return { revision: state.revision, step: state.currentStep, history, frozen, pins: state.artifactHashes ?? {},
    stateSha256: sha256(stateBytes), integritySha256: sha256(integrity) };
}

export async function verifyCheckpoint(record, saved, beforeResume = false) {
  const history = await readFile(path.join(record, 'history/history.ndjson'), 'utf8');
  const stateBytes = await readFile(path.join(record, 'state.json'));
  const state = JSON.parse(stateBytes);
  if (!history.startsWith(saved.history) || state.revision < saved.revision)
    throw new Error('ACCEPTANCE_CHECKPOINT_CHANGED: history prefix or revision regressed');
  for (const [key, digest] of Object.entries(saved.pins ?? {})) {
    if (state.artifactHashes?.[key] !== digest) throw new Error('ACCEPTANCE_CHECKPOINT_CHANGED: engine pin ' + key);
  }
  for (const [file, digest] of Object.entries(saved.frozen)) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Unsafe checkpoint pin');
    if (sha256(await readFile(path.join(record, file))) !== digest)
      throw new Error('ACCEPTANCE_CHECKPOINT_CHANGED: completed artifact ' + file);
  }
  if (beforeResume && (sha256(stateBytes) !== saved.stateSha256 ||
      sha256(await readFile(path.join(record, 'integrity.json'))) !== saved.integritySha256 || history !== saved.history))
    throw new Error('ACCEPTANCE_CHECKPOINT_CHANGED: saved record differs before resume');
}

// These are review leads, never an automatic OpenSpec PASS. Agent prose is not engine evidence.
export function openspecLeads(transcript) {
  return transcript.split('\n').flatMap((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { return []; }
    const item = event.item;
    if (event.type !== 'item.completed' || !['command_execution', 'mcp_tool_call'].includes(item?.type)) return [];
    const output = JSON.stringify(item.aggregated_output ?? item.result ?? item.error ?? '');
    return /openspec|requirement|scenario/i.test(output) ? [{ line: index + 1, type: item.type,
      exitCode: item.exit_code ?? null, sha256: sha256(line) }] : [];
  });
}

// A real engine lock, owned by a separate trusted process in the host PID realm.
export async function startLockHolder(node, moduleUrl, root, name) {
  const { spawn } = await import('node:child_process');
  const child = spawn(node, ['--input-type=module', '-e', `
    const { acquireModuleLock } = await import(process.argv[1]);
    const release = await acquireModuleLock(process.argv[2], process.argv[3], { timeoutMs: 0 });
    process.on('SIGTERM', async () => { await release(); process.exit(0); });
    setInterval(() => {}, 1000);
    console.log('HELD');
  `, moduleUrl, root, name], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Lock holder timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Lock holder failed: ' + stderr)); });
    child.stdout.once('data', data => {
      clearTimeout(timer);
      if (data.toString().trim() === 'HELD') resolve();
      else { child.kill('SIGKILL'); reject(new Error('Unexpected lock holder output')); }
    });
  });
  return { pid: child.pid, alive: () => child.exitCode === null && child.signalCode === null,
    stop: async (abandon = false) => { child.kill(abandon ? 'SIGKILL' : 'SIGTERM'); await closed; } };
}
