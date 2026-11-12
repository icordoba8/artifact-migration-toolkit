import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Preflight an installed MCP server without Node's AF_UNIX socketpair stdio.
 * All child descriptors are real FIFO/file descriptors, independent of
 * libuv's socket-descriptor classification inside restrictive sandboxes.
 * The server executable and arguments are passed unchanged, without a shell.
 */
export async function probeMcpTools({ command, args = [], cwd, scratchRoot = os.tmpdir(), timeoutMs = 10000 }) {
  if (process.platform !== 'linux') throw new Error('MCP FIFO preflight requires Linux');
  if (typeof command !== 'string' || !command || !Array.isArray(args) || !args.every(arg => typeof arg === 'string') ||
      !path.isAbsolute(cwd ?? '') || !path.isAbsolute(scratchRoot))
    throw new Error('Invalid MCP command or arguments');
  if (path.isAbsolute(command)) fs.accessSync(command, fs.constants.X_OK);
  const consumer = fs.realpathSync(cwd);
  const scratch = fs.realpathSync(scratchRoot);
  if (scratch === consumer || scratch.startsWith(consumer + path.sep))
    throw new Error('MCP scratch must be outside the consumer');

  const dir = fs.mkdtempSync(path.join(scratch, 'amt-mcp-stdio-'));
  let inputFd, stdoutFd, stderrFd, child;
  let closed = false, spawnError = null;
  let closeResult = { code: null, signal: null };
  let resolveClose;
  const closePromise = new Promise(resolve => { resolveClose = resolve; });
  const stdoutPath = path.join(dir, 'stdout');
  const stderrPath = path.join(dir, 'stderr');
  try {
    const fifo = path.join(dir, 'stdin.fifo');
    const created = spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo], { timeout: 3000, stdio: 'ignore' });
    if (created.status !== 0 || created.error)
      throw new Error(`mkfifo failed (code ${created.status}, error=${created.error?.code ?? 'none'})`);
    inputFd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(inputFd).isFIFO()) throw new Error('MCP stdin is not a FIFO');
    stdoutFd = fs.openSync(stdoutPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    stderrFd = fs.openSync(stderrPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);

    // The server is PID 1 in its own namespace: exiting or killing it also
    // kills detached descendants, which process-group signals cannot contain.
    child = spawn('unshare', ['--user', '--map-current-user', '--pid', '--fork', '--kill-child', '--', command, ...args], {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: [inputFd, stdoutFd, stderrFd],
    });
    child.on('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      closed = true;
      closeResult = { code, signal };
      resolveClose();
    });
    const writeMessage = value => {
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
      if (bytes.length > 4096) throw new Error('MCP preflight request exceeds 4 KiB');
      if (fs.writeSync(inputFd, bytes) !== bytes.length) throw new Error('Short MCP preflight write');
    };
    writeMessage({ id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'acceptance-preflight', version: '1' },
    } });

    let consumed = 0, pending = Buffer.alloc(0), initialized = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (fs.fstatSync(stderrFd).size > 65536) throw new Error('MCP stderr exceeds 64 KiB');
      const size = fs.fstatSync(stdoutFd).size;
      if (size > 1024 * 1024) throw new Error('MCP stdout exceeds 1 MiB');
      const bytes = Buffer.alloc(size - consumed);
      const count = fs.readSync(stdoutFd, bytes, 0, bytes.length, consumed);
      pending = Buffer.concat([pending, bytes.subarray(0, count)]);
      consumed += count;
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline).toString('utf8');
        pending = pending.subarray(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { throw new SyntaxError('Invalid MCP response JSON'); }
        if (message.jsonrpc !== '2.0' || message.error) throw new Error('Invalid MCP response');
        if (!initialized && message.id === 1) {
          if (!message.result?.protocolVersion || !message.result?.capabilities?.tools)
            throw new Error('MCP initialization did not advertise tools');
          initialized = true;
          writeMessage({ method: 'notifications/initialized' });
          writeMessage({ id: 2, method: 'tools/list', params: {} });
        } else if (initialized && message.id === 2) {
          const result = message.result;
          if (!Array.isArray(result?.tools) || result.nextCursor !== undefined ||
              !result.tools.every(tool => typeof tool?.name === 'string'))
            throw new Error('Incomplete MCP tools/list');
          return result.tools.map(tool => tool.name);
        } else if (message.id !== undefined) throw new Error('Unexpected MCP response');
      }
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        await closePromise;
        throw new Error(`MCP server exited before tools/list (code=${closeResult.code}, signal=${closeResult.signal})`);
      }
      await sleep(20);
    }
    throw new Error('MCP tools/list timed out');
  } catch (error) {
    // Only a digest/length enters the error; private raw stderr is never copied
    // into reports, stdout, or Git artifacts.
    if (stderrFd !== undefined) {
      const size = fs.fstatSync(stderrFd).size;
      const bytes = Buffer.alloc(Math.min(size, 65536));
      const count = fs.readSync(stderrFd, bytes, 0, bytes.length, 0);
      const digest = createHash('sha256').update(bytes.subarray(0, count)).digest('hex');
      error.message += ` [stderr_bytes=${size}, stderr_hashed_bytes=${count}, stderr_sha256=${digest}]`;
    }
    throw error;
  } finally {
    const signalServer = signal => {
      try {
        const pids = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim();
        if (pids) {
          // Keep unshare alive to reap its namespace init instead of orphaning it.
          for (const pid of pids.split(/\s+/)) process.kill(Number(pid), signal);
        } else child.kill(signal);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
      }
    };
    if (child && !closed) {
      signalServer('SIGTERM');
      await Promise.race([closePromise, sleep(500)]);
      if (!closed) {
        signalServer('SIGKILL');
        await Promise.race([closePromise, sleep(500)]);
      }
    }
    for (const fd of [inputFd, stdoutFd, stderrFd]) {
      if (fd !== undefined) fs.closeSync(fd);
    }
    fs.rmSync(dir, { recursive: true });
    if (child && !closed) throw new Error('MCP server cleanup did not complete');
  }
}
