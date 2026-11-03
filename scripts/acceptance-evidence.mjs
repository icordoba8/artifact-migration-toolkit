/** Trusted-side evidence only. Never repairs a consumer or awards human acceptance. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // Never open a FIFO or socket (an engine liveness token): its identity and mode are the evidence.
    else if (info.isFIFO()) item.type = 'fifo';
    else if (info.isSocket()) item.type = 'socket';
    else if (!info.isDirectory()) throw new Error('Unsupported evidence entry: ' + file);
    entries[relative] = item;
    if (info.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
  }
  await visit('');
  return entries;
}
export const sameTree = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A9 in-run observer (scripts/ledger-observer.py): raw inotify outside the sandbox from before spawn until after exit.
 * Resolves once every watch is attached; `stop()` always resolves to a report whose violations are non-empty on any
 * relay line, tamper, watcher error/overflow or observer death, so a lost observer can never read as a clean window.
 */
export async function startLedgerObserver(root, { timeoutMs = 30_000, python = 'python3' } = {}) {
  const base = path.join(root, '.agents/knowledge/migrations');
  const child = spawn(python, [fileURLToPath(new URL('./ledger-observer.py', import.meta.url)), base, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', error => { err += error.message; resolve({ code: null, signal: error.code ?? 'error' }); });
  });
  let readyTimer;
  const ready = await Promise.race([
    new Promise(resolve => child.stdout.on('data', () => out.startsWith('READY\n') && resolve(true))),
    exited.then(() => false),
    new Promise(resolve => { readyTimer = setTimeout(resolve, timeoutMs, false); }),
  ]);
  clearTimeout(readyTimer);
  if (!ready) {
    child.kill('SIGKILL');
    await exited;
    throw new Error('LEDGER_TAMPER: ledger observer did not start: ' + (err.trim() || out.trim() || 'timeout'));
  }
  let report, stopping = false;
  const premature = exited.then(() => !stopping);
  return {
    pid: child.pid,
    stop: () => report ??= (async () => {
      stopping = true;
      child.stdin.end('STOP\n');
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const { code, signal } = await exited;
      clearTimeout(timer);
      try {
        if (await premature) throw new Error('exited before stop (' + (code ?? signal) + '): the run was not fully observed');
        if (code !== 0) throw new Error('exit ' + (code ?? signal));
        return JSON.parse(out.slice('READY\n'.length));
      } catch (error) {
        return { violations: [{ code: 'LEDGER_TAMPER', reason: 'ledger observer failed (' + error.message + '): ' + err.trim() }] };
      }
    })(),
  };
}
/**
 * Wrap an (already isolated) command in the A9 syscall gate: strace (LEDGER_TRACE_STRACE, default `strace` on PATH)
 * follows every descendant from outside the namespaces; -DD keeps the command itself as the spawned child, so the
 * runner's SIGTERM/SIGKILL still reach it. no-io-uring.py installs an inherited seccomp denial of io_uring.
 */
const quote = arg => "'" + arg.replaceAll("'", "'\\''") + "'";
export const ledgerTraced = ({ command, argv }, trace, { strace = process.env.LEDGER_TRACE_STRACE || 'strace', python = 'python3' } = {}) => ({
  command: strace,
  argv: ['-DD', '-f', '-yy', '-s', String(1 << 24), '--pidns-translation', '--kill-on-exit', '--seccomp-bpf', '-e',
    'trace=read,readv,pread64,preadv,preadv2,write,writev,pwrite64,pwritev,pwritev2,copy_file_range,splice,sendfile,process_vm_writev,open,openat,openat2,creat,truncate,ftruncate,fallocate,link,linkat,unlink,unlinkat,rename,' +
    'renameat,renameat2,symlink,symlinkat,fcntl,mmap,io_uring_setup,open_by_handle_at,mount,umount2,move_mount,' +
    'open_tree,fsmount,mount_setattr,pivot_root,chroot,setns,unshare,clone,clone3,fork,vfork',
    // Non-ledger read/write buffers are dropped by the trusted sink before anything is persisted.
    '-o', '|' + [python, fileURLToPath(new URL('./ledger-trace.py', import.meta.url)), 'filter', trace].map(quote).join(' '), '--', python, fileURLToPath(new URL('./no-io-uring.py', import.meta.url)), command, ...argv],
});
/** Gate verdict for a finished ledgerTraced run (rootPid = the spawned child's pid). No namespace is trusted: every ledger read's bytes are inspected. */
export const ledgerTraceVerdict = (trace, rootPid, { python = 'python3' } = {}) => {
  const run = spawnSync(python, [fileURLToPath(new URL('./ledger-trace.py', import.meta.url)), trace, String(rootPid)], { encoding: 'utf8', timeout: 120_000 });
  let violations;
  try { violations = JSON.parse(run.stdout).violations; } catch { violations = ['syscall gate failed: ' + (run.error?.message ?? run.stderr)]; }
  if (run.status !== (violations.length ? 1 : 0)) violations = [...violations, 'syscall gate exited ' + (run.status ?? run.signal)];
  return violations.length ? { code: violations.some(v => v.startsWith('RELAY_IN_SCORED_RUN')) ? 'RELAY_IN_SCORED_RUN' : 'LEDGER_TAMPER', reasons: violations.map(v => 'syscall gate: ' + v) } : null;
};
/** The scored-run failure code for an observer report, or null when the window was fully observed and clean. */
export const ledgerObserverVerdict = report => {
  const violations = Array.isArray(report?.violations) ? report.violations : [{ code: 'LEDGER_TAMPER', reason: 'no observer report' }];
  if (!violations.length) return null;
  return { code: violations.some(v => v.code === 'RELAY_IN_SCORED_RUN') ? 'RELAY_IN_SCORED_RUN' : 'LEDGER_TAMPER', reasons: violations.map(v => v.code + ': ' + v.reason) };
};

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

// Review leads only: shell commands (Codex exec JSON or rollout command items, or plain trace lines) that remove or move a lock.
export const lockRemovals = transcript => transcript.split('\n').flatMap((line, index) => {
  let command = line;
  try {
    const event = JSON.parse(line), item = event?.payload?.item;
    command = event?.item?.type === 'command_execution' ? String(event.item.command)
      : event?.type === 'event_msg' && item?.type === 'CommandExecution' ? [].concat(item.command).join(' ') : '';
  } catch {}
  return command.includes('locks') && /\b(rm|rmdir|unlink|mv)\b/.test(command) ? [{ line: index + 1, sha256: sha256(line) }] : [];
});

/**
 * G1: refusals come from engine tool results bound to the call that produced them, never from agent prose.
 * A structured engine code (E6: MCP `isError` + `structuredContent.code`; CLI stdout refusal document; the
 * BLOCKED / NOT_STARTED document) always wins. Otherwise the engine's exact message templates
 * (lock.mjs lockedError, store/files.mjs mkdirCause, Node errno, registry.mjs registryUnbound) give
 * codeSource "template". ponytail: template matching is the ceiling for engines without E6.
 */
const TEMPLATES = [
  ['LOCK_PROTOCOL_1', /^Another migration command holds the lock for '[^'\n]*' at [^\n]* as a lock file from a protocol-1 release/m],
  ['LOCK_OWNER_UNKNOWN', /^Another migration command holds the lock for '[^'\n]*' at [^\n]*cannot be proven gone from here: its entry or liveness token is unreadable/m],
  ['LOCK_NO_LIVENESS_TOKEN', /^Another migration command holds the lock for '[^'\n]*' at [^\n]*recorded no liveness token and runs in another PID realm/m],
  // Engine 1.6.4 has no codes: its cross-realm refusal names no reason.
  ['LOCK_OWNER_UNPROVEN', /^Another migration command holds the lock for '[^'\n]*' at [^\n]*\) cannot be proven gone from here, so it is never reclaimed/m],
  ['LOCK_HELD', /^Another migration command holds the lock for '[^'\n]*' at [^\n]* \(pid (?:\d+|unknown)\)\. Wait for it to finish/m],
  ['FS_ERRNO_UNKNOWN', /^Cannot create '[^\n]*': mkdir reported ENOENT and no syscall recovered the real cause\./m],
  // Any Node errno is recorded by its own code; only the scenario's accepted codes ever count.
  [null, /^(E[A-Z]+): [^,\n]+, [a-z]+ '/m],
  ['BLOCKED_NOT_STARTED', /^Migration registry is not configured\./m],
];
const templateCode = text => {
  for (const [code, pattern] of TEMPLATES) { const match = pattern.exec(text); if (match) return code ?? match[1]; }
  return null;
};
export const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };
const structured = doc => typeof doc?.code === 'string' ? doc.code
  : doc?.outcome === 'BLOCKED' && doc?.status === 'NOT_STARTED' ? 'BLOCKED_NOT_STARTED' : null;

const mcpRefusal = item => {
  if (item.status === 'failed') // Codex drops error.data: only the message after its JSON-RPC prefix is the engine's.
    return { code: templateCode(String(item.error?.message ?? '').replace(/^[\s\S]*?Mcp error: -?\d+: /, '')), codeSource: 'template' };
  const result = item.result ?? {}, doc = result.structuredContent ?? parseJson(result.content?.at(-1)?.text);
  const code = structured(doc);
  if (code && (result.isError || code === 'BLOCKED_NOT_STARTED')) return { code, codeSource: 'structured' };
  return result.isError ? { code: templateCode((result.content ?? []).map(part => part.text ?? '').join('\n')), codeSource: 'template' } : null;
};

// Minimal POSIX word splitter. Returns null on anything but plain words and quotes (pipes, lists,
// redirections, substitutions, globs), so a bound command's exit code is the engine's own.
// ponytail: `cd x && engine ...`, env prefixes and heredocs are never bound; widen only with a real parser.
const shellWords = line => {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? '') + line.slice(i + 1, end); i = end;
    } else if (c === '"') {
      let text = '', j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '$' || line[j] === '`') return null;
        if (line[j] === '\\' && /["\\$`]/.test(line[j + 1] ?? '')) j++;
        text += line[j];
      }
      if (j >= line.length) return null;
      word = (word ?? '') + text; i = j;
    } else if (c === '\\') word = (word ?? '') + (line[++i] ?? '');
    else if (/\s/.test(c)) { if (word !== null) words.push(word); word = null; }
    else if (/[|&;<>()`$*?[\]{}~#!]/.test(c)) return null;
    else word = (word ?? '') + c;
  }
  if (word !== null) words.push(word);
  return words;
};

// Only a failed shell call whose argv runs a receipt-installed engine command is engine evidence: an
// `echo` of an engine message, a provider sandbox line (bwrap) or prose never is.
const cliRefusal = (item, engineCommands) => {
  const [shell, flag, line] = Array.isArray(item.command) ? item.command : [];
  if (!Number.isInteger(item.exit_code) || item.exit_code === 0 || !Array.isArray(item.command) || item.command.length !== 3 ||
      !/^\/(?:usr\/)?bin\/(?:ba)?sh$/.test(shell) || !['-c', '-lc'].includes(flag)) return null;
  const words = shellWords(String(line).replace(/\s+2>&1\s*$/, ''));
  if (!words || !engineCommands.some(([node, entry]) => words[0] === node && words[1] === entry)) return null;
  const output = String(item.aggregated_output ?? '');
  const code = structured(parseJson(output.match(/^\{\n[\s\S]*?\n\}$/m)?.[0]));
  if (code && (code !== 'BLOCKED_NOT_STARTED' || item.exit_code === 2)) return { code, codeSource: 'structured' };
  return { code: templateCode(output), codeSource: 'template' };
};

/**
 * A Codex 0.165.0 rollout (`$CODEX_HOME/sessions/.../rollout-*-<thread>.jsonl`): the provider's own per-call record.
 * Returns its session, turn count, operator prompts and every engine refusal (line number + line SHA-256).
 */
export function codexRollout(text, engineCommands) {
  const rollout = { meta: null, turns: 0, prompts: [], refusals: [] };
  text.split('\n').forEach((line, index) => {
    if (!line) return;
    const event = JSON.parse(line), payload = event.payload ?? {};
    if (event.type === 'session_meta') {
      if (rollout.meta) throw new Error('ACCEPTANCE_ROLLOUT_UNBOUND: more than one session in a rollout');
      rollout.meta = { id: payload.id, cwd: payload.cwd, timestamp: payload.timestamp };
    }
    if (event.type !== 'event_msg') return;
    if (payload.type === 'task_started') rollout.turns += 1;
    const item = payload.type === 'item_completed' ? payload.item : null;
    if (item?.type === 'UserMessage') rollout.prompts.push((item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join(''));
    const refusal = item?.type === 'McpToolCall' && item.server === 'start-migration' ? mcpRefusal(item)
      : item?.type === 'CommandExecution' ? cliRefusal(item, engineCommands) : null;
    if (refusal) rollout.refusals.push({ line: index + 1, sha256: sha256(line),
      source: item.type === 'McpToolCall' ? 'mcp' : 'cli', tool: item.tool ?? null, exitCode: item.exit_code ?? null, ...refusal });
  });
  if (!rollout.meta) throw new Error('ACCEPTANCE_ROLLOUT_UNBOUND: rollout has no session_meta');
  return rollout;
}

/**
 * Finds this run's rollout: headless by the `thread.started` id Codex printed (file name and session id must
 * both match), native by consumer cwd within the launch window. Never another thread's or consumer's session.
 * Returns null only when no candidate exists; a foreign or ambiguous match throws.
 */
export async function findCodexRollout(codexHome, { threadId, cwd, startedAt, endedAt }) {
  const sessions = path.join(codexHome, 'sessions');
  const names = (await readdir(sessions, { recursive: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(name => /(?:^|\/)rollout-[^/]*\.jsonl$/.test(name) && (!threadId || name.endsWith('-' + threadId + '.jsonl')));
  const found = [];
  for (const name of names) {
    const file = path.join(sessions, name), text = await readFile(file, 'utf8');
    const meta = JSON.parse(text.slice(0, text.indexOf('\n'))).payload ?? {};
    if (threadId && (meta.id !== threadId || meta.cwd !== cwd))
      throw new Error('ACCEPTANCE_ROLLOUT_UNBOUND: ' + name + ' belongs to another thread or consumer');
    if (threadId || (meta.cwd === cwd && meta.timestamp >= startedAt && meta.timestamp <= endedAt)) found.push({ file, text });
  }
  if (found.length > 1) throw new Error('ACCEPTANCE_ROLLOUT_UNBOUND: more than one rollout matches this run');
  return found[0] ?? null;
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
  // A5: the holder's own PID namespace, read from the host side before it can die.
  const pidns = readlinkSync(`/proc/${child.pid}/ns/pid`);
  return { pid: child.pid, pidns, alive: () => child.exitCode === null && child.signalCode === null,
    // Resolves with the signal that ended the holder: an abandoned owner must have died by SIGKILL.
    stop: async (abandon = false) => { child.kill(abandon ? 'SIGKILL' : 'SIGTERM'); await closed; return child.signalCode; } };
}
