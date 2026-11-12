import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { probeMcpTools } from '../scripts/mcp-preflight-transport.mjs';
import { installedGrants } from '../scripts/agent-e2e-acceptance.mjs';

describe('Linux FIFO MCP preflight', { skip: process.platform !== 'linux' }, () => {

  const server = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    if (!fs.fstatSync(0).isFIFO()) process.exit(43);
    if (!fs.fstatSync(1).isFile() || !fs.fstatSync(2).isFile()) process.exit(44);
    const mode = process.argv[1];
    if (mode === 'early-exit') process.exit(0);
    if (mode === 'no-tools') process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {} }
    }) + '\\n');
    if (mode === 'excess-output') process.stdout.write('x'.repeat(1024 * 1024 + 1));
    if (mode === 'stderr' || mode === 'excess-stderr') {
      process.stderr.write('confidential-diagnostic-value'.repeat(mode === 'stderr' ? 1 : 3000));
      process.exit(12);
    }
    if (mode === 'detached-descendant') {
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', \`
        const fs = require('node:fs');
        fs.writeFileSync(process.argv[1], fs.readFileSync('/proc/self/status', 'utf8').split(String.fromCharCode(10)).find(line => line.startsWith('NSpid:')).match(/[0-9]+/)[0]);
        setInterval(() => {}, 1000);
      \`, process.argv[2]], { detached: true, stdio: 'ignore' }).unref();
      setInterval(() => {}, 1000);
    }
    else if (mode === 'timeout' || mode === 'stubborn-timeout') {
      if (mode === 'stubborn-timeout') process.on('SIGTERM', () => {});
      if (process.argv[2]) fs.writeFileSync(process.argv[2], fs.readFileSync('/proc/self/status', 'utf8').split(String.fromCharCode(10)).find(line => line.startsWith('NSpid:')).match(/[0-9]+/)[0]);
      setInterval(() => {}, 1000);
    }
    else {
      const lines = readline.createInterface({ input: process.stdin });
      lines.on('line', raw => {
        const message = JSON.parse(raw);
        if (mode === 'malformed' && message.id === 1) return process.stdout.write('confidential-json-value {bad json}\\n');
        if (message.method === 'initialize') process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        }) + '\\n');
        if (message.method === 'tools/list') process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { tools: Array.from({ length: 9 }, (_, index) => ({ name: 'tool_' + index })),
            ...(mode === 'paginated' ? { nextCursor: 'next' } : {}) }
        }) + '\\n');
      });
    }
  `;

  const runProbe = (mode, extra = {}) => probeMcpTools({
    command: process.execPath,
    args: ['-e', server, mode],
    cwd: process.cwd(),
    timeoutMs: 2000,
    ...extra,
  });

  test('preflight exchanges initialize and tools/list over a real FIFO', async () => {
    assert.deepEqual(await runProbe('success'),
      Array.from({ length: 9 }, (_, index) => `tool_${index}`));
  });

  test('early zero exit fails closed with its exit status', async () => {
    await assert.rejects(runProbe('early-exit'), /exited before tools\/list \(code=0, signal=null\)/);
  });

  test('malformed protocol output fails closed', async () => {
    await assert.rejects(runProbe('malformed'), error => {
      assert.ok(error instanceof SyntaxError);
      assert.doesNotMatch(error.message, /confidential-json-value/);
      return true;
    });
  });

  test('missing tool advertisement fails closed', async () => {
    await assert.rejects(runProbe('no-tools'), /did not advertise tools/);
  });

  test('paginated tool grants fail closed', async () => {
    await assert.rejects(runProbe('paginated'), /Incomplete MCP tools\/list/);
  });

  test('excess stdout fails closed', async () => {
    await assert.rejects(runProbe('excess-output'), /stdout exceeds 1 MiB/);
  });

  test('private diagnostics expose only length/hash, never stderr contents', async () => {
    for (const mode of ['stderr', 'excess-stderr']) {
      await assert.rejects(runProbe(mode), error => {
        assert.match(error.message, mode === 'stderr' ? /stderr_bytes=29, stderr_hashed_bytes=29/
          : /stderr_bytes=87000, stderr_hashed_bytes=65536/);
        assert.doesNotMatch(error.message, /confidential-diagnostic-value/);
        return true;
      });
    }
  });

  test('silent child times out and is terminated', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amt-mcp-timeout-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const mode of ['timeout', 'stubborn-timeout']) {
      const pidFile = path.join(root, mode);
      await assert.rejects(runProbe(mode, { args: ['-e', server, mode, pidFile], timeoutMs: 500 }), /tools\/list timed out/);
      assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
    }
  });

  test('a timed-out server cannot leave a detached descendant running', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amt-mcp-descendant-'));
    const pidFile = path.join(root, 'descendant.pid');
    t.after(() => {
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        try {
          if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(pidFile)) process.kill(pid, 'SIGKILL');
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    await assert.rejects(runProbe('detached-descendant', { args: ['-e', server, 'detached-descendant', pidFile], timeoutMs: 1500 }), /tools\/list timed out/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });

  test('invalid server path fails with a diagnostic error', async () => {
    await assert.rejects(probeMcpTools({ command: '/no-such-mcp-server', cwd: process.cwd() }), /ENOENT/);
  });

  test('scratch path inside consumer is rejected before child launch', async () => {
    await assert.rejects(runProbe('success', { scratchRoot: process.cwd() }), /scratch must be outside/);
  });

  test('temporary FIFO and output files are removed after each run', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('amt-mcp-stdio-')));
    await runProbe('success');
    const after = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('amt-mcp-stdio-')));
    assert.deepEqual(after, before);
  });

  test('mkfifo is installed', () => {
    const result = spawnSync('/usr/bin/mkfifo', ['--version'], { stdio: 'ignore' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
  });

  test('installed grants keep exact argv and apply Codex and Copilot filters after the FIFO handshake', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amt-installed-fifo-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const args = [path.join(root, 'server with spaces.cjs'), 'literal $(no-shell); argument', '--without-relay'];
    const checkArgs = `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args.slice(1)))}) process.exit(45);`;
    fs.writeFileSync(args[0], checkArgs + server);
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.codex/config.toml'),
      `[mcp_servers.start-migration]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n` +
      'enabled_tools = ["tool_1","tool_2"]\ndisabled_tools = ["tool_2"]\n');
    const codex = await installedGrants(root, 'codex');
    assert.deepEqual(codex.server, { command: process.execPath, args });
    assert.equal(codex.advertised.length, 9);
    assert.deepEqual(codex.grants, ['tool_1']);
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      'start-migration': { command: process.execPath, args, tools: ['*'] },
    } }));
    const copilot = await installedGrants(root, 'copilot');
    assert.deepEqual(copilot.grants, codex.advertised);
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      'start-migration': { command: process.execPath, tools: ['*'] },
    } }));
    await assert.rejects(installedGrants(root, 'copilot'), /Unreadable installed command\/args/);
  });

});
