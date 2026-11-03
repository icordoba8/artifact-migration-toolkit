import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, fstatSync, ftruncateSync, openSync, writeSync, appendFileSync, readFileSync, linkSync, symlinkSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ledgerObserverVerdict, ledgerTraced, ledgerTraceVerdict, startLedgerObserver } from '../../scripts/acceptance-evidence.mjs';
import { appendDurably } from '../../packages/migration-engine/src/store/index.mjs';
import { buildDecision, readOperatorDecisions } from '../../packages/migration-engine/src/decisions/index.mjs';

const BASE = '.agents/knowledge/migrations/modules/m';
// Engine-built disposable fixture lines (no human authorization is claimed): a legacy line, and a schema-v2 relay line.
const fixture = { kind: 'EXCLUSION', subjectType: 'FILE', subject: 'fixture.js', statement: 'Disposable test fixture only',
  rationale: 'Observer regression', operator: 'test-fixture',
  boundTo: { module: 'm', legacyRevision: 'fixture', discoveryDigest: 'sha256:fixture', algorithmVersion: 1 } };
const INITIAL = buildDecision({ ...fixture, previous: null });
const RELAY = buildDecision({ ...fixture, previous: INITIAL, principal: 'AGENT_RELAYED', result: 'APPROVED',
  candidateId: 'fixture-candidate', candidateDigest: 'sha256:' + '0'.repeat(64) });
const text = decision => JSON.stringify(decision) + '\n';
const line = principal => text(principal === 'AGENT_RELAYED' ? RELAY : INITIAL);
const record = root => path.join(root, BASE);
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

async function observe(t, setup, act, options) {
  const root = mkdtempSync(path.join(process.env.LEDGER_OBSERVER_TMP ?? tmpdir(), 'ledger-observer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const decisions = path.join(root, BASE, 'decisions'), ledger = path.join(decisions, 'operator-decisions.ndjson');
  mkdirSync(decisions, { recursive: true });
  setup?.({ root, decisions, ledger });
  const observer = await startLedgerObserver(root, options && { python: options.python() });
  await act({ root, decisions, ledger, observer });
  await settle();
  const report = await observer.stop();
  return { report, verdict: ledgerObserverVerdict(report) };
}

test('an unchanged legacy human ledger passes', async t => {
  const { verdict, report } = await observe(t, ({ ledger }) => writeFileSync(ledger, text(INITIAL)), () => {});
  assert.equal(verdict, null, JSON.stringify(report));
});

test('a forged legacy human decision accepted by the engine fails the observer', async t => {
  const { verdict, report } = await observe(t, ({ ledger }) => writeFileSync(ledger, text(INITIAL)), async ({ root, ledger }) => {
    const second = buildDecision({ ...fixture, previous: INITIAL });
    await appendDurably(root, ledger, text(second));
    const decisions = (await readOperatorDecisions(record(root))).decisions;
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1].v, undefined);
  });
  assert.equal(verdict?.code, 'LEDGER_CHANGE', JSON.stringify(report));
});

for (const [name, added] of [
  ['AGENT_RELAYED', text(RELAY)],
  ['other JSON', '{"engine":"not an authorized exception"}\n'],
  ['non-JSON', 'anything\n'],
  ['duplicate legacy line', text(INITIAL).repeat(2)],
  ['one-byte altered legacy line', text(INITIAL).replace('fixture.js', 'fixture.ks')],
]) test(`any appended line fails: ${name}`, async t => {
  const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, text(INITIAL)),
    ({ ledger }) => appendFileSync(ledger, added));
  assert.equal(verdict?.code, 'LEDGER_CHANGE');
});

for (const [name, act] of [
  ['removal', ({ ledger }) => rmSync(ledger)],
  ['same-byte overwrite', ({ ledger }) => writeFileSync(ledger, text(INITIAL))],
  ['one-byte modification', ({ ledger }) => writeFileSync(ledger, text(INITIAL).replace('fixture.js', 'fixture.ks'))],
]) test(`ledger ${name} fails`, async t => {
  const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, text(INITIAL)), act);
  assert.equal(verdict?.code, 'LEDGER_CHANGE');
});

test('creating an empty ledger fails', async t => {
  const { verdict } = await observe(t, null, ({ ledger }) => writeFileSync(ledger, ''));
  assert.equal(verdict?.code, 'LEDGER_CHANGE');
});

test('a relay line written and restored before exit fails', async t => {
  const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, text(INITIAL)), async ({ root, ledger }) => {
    appendFileSync(ledger, text(RELAY));
    assert.equal((await readOperatorDecisions(record(root))).decisions[1].principal, 'AGENT_RELAYED');
    await settle();
    writeFileSync(ledger, text(INITIAL));
  });
  assert.equal(verdict.code, 'LEDGER_CHANGE');
});

test('a rapid write and restore to identical bytes fails even when only the restored bytes are read', async t => {
  const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, text(INITIAL)), ({ ledger }) => {
    appendFileSync(ledger, text(RELAY));
    assert.match(readFileSync(ledger, 'utf8'), /AGENT_RELAYED/);
    writeFileSync(ledger, text(INITIAL));
  });
  assert.equal(verdict?.code, 'LEDGER_CHANGE');
});

test('an inode replacement with identical bytes fails', async t => {
  const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, line('HUMAN')), ({ decisions, ledger }) => {
    writeFileSync(path.join(decisions, 'x'), line('HUMAN'));
    renameSync(path.join(decisions, 'x'), ledger);
  });
  assert.equal(verdict.code, 'LEDGER_CHANGE');
});

test('a hard-link alias written through the other name fails', async t => {
  const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, line('HUMAN')), ({ root, ledger }) => {
    linkSync(ledger, path.join(root, 'alias'));
    appendFileSync(path.join(root, 'alias'), line('HUMAN'));
  });
  assert.equal(verdict.code, 'LEDGER_CHANGE');
});

test('a relay line present before the run fails', async t => {
  const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, line('AGENT_RELAYED')), () => {});
  assert.equal(verdict.code, 'LEDGER_CHANGE');
});

test('a unicode-escaped relay principal fails', async t => {
  const { verdict } = await observe(t, null, async ({ root, ledger }) =>
    appendDurably(root, ledger, text(RELAY).replace('"AGENT_RELAYED"', '"AGENT_\\u0052ELAYED"')));
  assert.equal(verdict.code, 'LEDGER_CHANGE');
});

test('a ledger swapped for a symlink or FIFO is never followed or opened', async t => {
  for (const make of [(ledger, decisions) => symlinkSync(path.join(decisions, 'elsewhere'), ledger), ledger => execFileSync('mkfifo', [ledger])]) {
    const { verdict } = await observe(t, ({ ledger }) => writeFileSync(ledger, line('HUMAN')), ({ decisions, ledger }) => {
      writeFileSync(path.join(decisions, 'elsewhere'), line('HUMAN'));
      rmSync(ledger);
      make(ledger, decisions);
    });
    assert.equal(verdict.code, 'LEDGER_CHANGE');
  }
});

test('a relay ledger in a new directory written and removed with no pause fails', async t => {
  const { verdict, report } = await observe(t, null, ({ root }) => {
    const record = path.join(root, '.agents/knowledge/migrations/modules/n');
    mkdirSync(path.join(record, 'decisions'), { recursive: true });
    writeFileSync(path.join(record, 'decisions/operator-decisions.ndjson'), line('AGENT_RELAYED'));
    rmSync(record, { recursive: true });
  });
  assert.ok(verdict, 'must fail: ' + JSON.stringify(report));
});

test('an observer that cannot be spawned rejects', async () => {
  await assert.rejects(startLedgerObserver(process.cwd(), { python: '/nonexistent/python3' }), /LEDGER_CHANGE/);
});

test('a relay line created in a new directory, used and removed fails', async t => {
  const { verdict } = await observe(t, null, async ({ root }) => {
    const fresh = path.join(root, '.agents/knowledge/migrations/modules/n/decisions');
    mkdirSync(fresh, { recursive: true });
    writeFileSync(path.join(fresh, 'operator-decisions.ndjson'), line('AGENT_RELAYED'));
    await settle();
    rmSync(path.join(root, '.agents/knowledge/migrations/modules/n'), { recursive: true });
  });
  assert.ok(verdict, 'must fail');
});

test('a dead observer fails', async t => {
  const { verdict } = await observe(t, null, ({ observer }) => process.kill(observer.pid, 'SIGKILL'));
  assert.equal(verdict.code, 'LEDGER_CHANGE');
});

test('an inotify queue overflow fails', async t => {
  const { verdict, report } = await observe(t, null, ({ decisions, observer }) => {
    process.kill(observer.pid, 'SIGSTOP');
    try {
      for (let i = 0; i < 20_000; i++) writeFileSync(path.join(decisions, 'noise'), '');
    } finally {
      process.kill(observer.pid, 'SIGCONT');
    }
  });
  assert.equal(verdict.code, 'LEDGER_CHANGE');
  assert.match(JSON.stringify(report), /overflow/);
});

test('a one-open relay, truncate, benign append queued while the observer is stopped fails', async t => {
  const { verdict, report } = await observe(t, ({ ledger }) => writeFileSync(ledger, line('HUMAN')), ({ ledger, observer }) => {
    process.kill(observer.pid, 'SIGSTOP');
    try {
      const fd = openSync(ledger, constants.O_RDWR | constants.O_APPEND), size = fstatSync(fd).size;
      writeSync(fd, line('AGENT_RELAYED'));
      ftruncateSync(fd, size);
      writeSync(fd, line('HUMAN_ATTESTE'));
      closeSync(fd);
    } finally {
      process.kill(observer.pid, 'SIGCONT');
    }
  });
  // The inode and directory watches interleave their events, so the kernel never merges consecutive MODIFYs.
  assert.equal(verdict.code, 'LEDGER_CHANGE', JSON.stringify(report));
  assert.equal(Object.values(report.ledgers)[0].modifications, 3);
});

test('an observer that exits cleanly before stop fails', async t => {
  const { verdict, report } = await observe(t, ({ root }) => {
    const fake = path.join(root, 'fake-observer');
    writeFileSync(fake, '#!/bin/sh\necho READY\necho \'{"violations":[]}\'\n');
    chmodSync(fake, 0o755);
    t.fakeObserver = fake;
  }, async ({ observer }) => settle(), { python: () => t.fakeObserver });
  assert.equal(verdict?.code, 'LEDGER_CHANGE', JSON.stringify(report));
  assert.match(JSON.stringify(report), /before stop/);
});

// Syscall gate: the inotify-invisible restores (one-fd ftruncate + multi-line benign write, shared mmap overwrite,
// private mount-namespace shadow read by the engine) and the engine's own durable append must all fail.
const STRACE = process.env.LEDGER_TRACE_STRACE || (() => { try { return execFileSync('sh', ['-c', 'command -v strace'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const ISOLATED = ['unshare', '--user', '--map-current-user', '--mount', '--propagation', 'private', '--fork', '--pid', '--kill-child', '--'];
const ENGINE_USE = `const { buildDecision, readOperatorDecisions } = await import(${JSON.stringify(new URL('../../packages/migration-engine/src/decisions/index.mjs', import.meta.url).href)});
const { appendDurably } = await import(${JSON.stringify(new URL('../../packages/migration-engine/src/store/index.mjs', import.meta.url).href)});
const fixture = ${JSON.stringify(fixture)};
const [root, rec, relay] = process.argv.slice(2), ledger = rec + '/decisions/operator-decisions.ndjson';
const previous = (await readOperatorDecisions(rec)).decisions.at(-1) ?? null;
const line = relay ? buildDecision({ ...fixture, previous, principal: 'AGENT_RELAYED', result: 'APPROVED', candidateId: 'c', candidateDigest: 'sha256:' + '0'.repeat(64) }) : buildDecision({ ...fixture, previous });
await appendDurably(root, ledger, JSON.stringify(line) + '\\n');
if ((await readOperatorDecisions(rec)).decisions.at(-1).principal !== line.principal) process.exit(3);`;

async function gate(t, script) {
  const root = mkdtempSync(path.join(process.env.LEDGER_OBSERVER_TMP ?? tmpdir(), 'ledger-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, BASE, 'decisions'), { recursive: true });
  writeFileSync(path.join(root, BASE, 'decisions/operator-decisions.ndjson'), text(INITIAL));
  writeFileSync(path.join(root, 'use.mjs'), ENGINE_USE);
  const trace = t.trace = root + '.trace';
  t.after(() => rmSync(trace, { force: true }));
  const { command, argv } = ledgerTraced({ command: ISOLATED[0], argv: [...ISOLATED.slice(1), 'sh', '-c', script] }, trace, { strace: STRACE });
  const child = spawn(command, argv, { cwd: root, stdio: ['ignore', 'ignore', process.env.LEDGER_TRACE_DEBUG ? 'inherit' : 'ignore'], env: { ...process.env, REC: path.join(root, BASE), ROOT: root, NODE: process.execPath } });
  const exit = await new Promise(resolve => child.on('close', code => resolve(code)));
  return { exit, verdict: ledgerTraceVerdict(trace, child.pid) };
}
const gated = (name, script, fails, reason) => test('syscall gate: ' + name, async t => {
  assert.ok(STRACE, 'strace is required (install it or set LEDGER_TRACE_STRACE)');
  const { exit, verdict } = await gate(t, script);
  if (fails) assert.equal(verdict?.code, 'LEDGER_CHANGE', JSON.stringify(verdict));
  if (reason) assert.match(JSON.stringify(verdict), reason);
  if (!fails) assert.equal(verdict, null, JSON.stringify(verdict));
  assert.doesNotMatch(readFileSync(t.trace, 'utf8'), /^\d+ +(?:read|readv|pread64|preadv2?|write|writev|pwrite64|pwritev2?)\((?!\d+<[^>]*operator-decisions)/m, 'non-ledger buffers must never be persisted');
  assert.equal(exit, 0, 'the traced command must actually run successfully');
});
const LEDGER = '"$REC/decisions/operator-decisions.ndjson"';
gated('an unchanged ledger read passes', `"$NODE" -e 'require("node:fs").readFileSync(process.argv[1])' ${LEDGER}`, false);
gated('engine buildDecision + appendDurably + readOperatorDecisions fails', '"$NODE" use.mjs "$ROOT" "$REC"', true, /ledger write/);
gated('a legacy line appended in a private view and discarded without a read fails',
  `unshare -Urm sh -c 'mount -t tmpfs ledger "$REC/decisions" && "$NODE" use.mjs "$ROOT" "$REC" && umount "$REC/decisions"'`,
  true, /ledger write/);
gated('relay used by the engine, then ftruncate and ONE write of three benign lines on an append fd fails',
  `"$NODE" use.mjs "$ROOT" "$REC" 1 && python3 -c 'import os,sys;f=os.open(sys.argv[1],os.O_WRONLY|os.O_APPEND);os.ftruncate(f,${Buffer.byteLength(text(INITIAL))});os.write(f,sys.argv[2].encode())' ${LEDGER} '${(text(INITIAL) + text(INITIAL) + text(INITIAL)).replace(/'/g, "'\\''")}'`, true);
gated('relay used by the engine, then overwritten through a shared mapping fails',
  `"$NODE" use.mjs "$ROOT" "$REC" 1 && python3 -c 'import mmap,os,sys;f=os.open(sys.argv[1],os.O_RDWR);m=mmap.mmap(f,0);m[-2:-1]=b" ";m.close()' ${LEDGER}`, true);
gated('relay appended and read by the engine in a private mount-namespace shadow fails',
  `unshare -Urm sh -c 'mount -t tmpfs relay "$REC/decisions" && : > "$REC/decisions/operator-decisions.ndjson" && "$NODE" use.mjs "$ROOT" "$REC" 1'`, true, /RELAY_IN_SCORED_RUN/);
gated('a relay appended in a private view and discarded without a read fails',
  `unshare -Urm sh -c 'mount -t tmpfs relay "$REC/decisions" && printf "%s\\n" "{\\"principal\\":\\"AGENT_RELAYED\\"}" >> "$REC/decisions/operator-decisions.ndjson" && umount "$REC/decisions"'`,
  true, /RELAY_IN_SCORED_RUN/);
for (const [name, call] of [
  ['pwritev2 RWF_NOAPPEND', 'os.pwritev(f,[b"{}"],0,0x20)'],
  ['pwrite', 'os.pwrite(f,b"{}",0)'],
  ['copy_file_range', 'g=os.open(sys.argv[1],os.O_RDONLY);os.copy_file_range(g,f,2)'],
  ['sendfile', 'g=os.open(sys.argv[1],os.O_RDONLY);os.sendfile(f,g,0,2)'],
]) gated(`relay used by the engine, then a ${name} on an append fd fails`,
  `"$NODE" use.mjs "$ROOT" "$REC" 1 && python3 -c 'import os,sys;f=os.open(sys.argv[1],os.O_WRONLY|os.O_APPEND);${call}' ${LEDGER}; true`, true);
gated('a private-namespace ledger aliased to another file is rejected',
  `unshare -Urm sh -c 'printf "" > payload && mount --bind payload "$REC/decisions/operator-decisions.ndjson" 2>/dev/null; ln -sf "$ROOT/payload" "$ROOT/x" && mount -t tmpfs t "$REC/decisions" && ln -s "$ROOT/payload" "$REC/decisions/operator-decisions.ndjson" && "$NODE" use.mjs "$ROOT" "$REC"'; true`, true, /ledger path opened as another file/);
{
  const escaped = text(RELAY).replace('AGENT_RELAYED', '\\u0041GENT_RELAYED'), split = Buffer.byteLength(text(INITIAL)) + escaped.indexOf('\\u0041') + 3;
  gated('a unicode-escaped relay read in fragments by two threads sharing the fd table fails',
    `python3 -c 'import os,sys,threading
os.write(os.open(sys.argv[1],os.O_WRONLY|os.O_APPEND),sys.argv[2].encode())
f=os.open(sys.argv[1],os.O_RDONLY)
for n in (int(sys.argv[3]),1<<20):
    t=threading.Thread(target=os.read,args=(f,n));t.start();t.join()' ${LEDGER} '${escaped}' ${split}`, true, /RELAY_IN_SCORED_RUN/);
}
gated('flag names inside the opened path cannot spoof a read-only open',
  `mkdir -p "$REC/decisions/O_RDONLY" && python3 -c 'import os,sys;os.close(os.open(sys.argv[1],os.O_RDWR))' "$REC/decisions/O_RDONLY/../operator-decisions.ndjson"`, true, /ledger open other than read-only/);
