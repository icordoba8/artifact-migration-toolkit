#!/usr/bin/env python3
"""A9 syscall gate, companion to ledger-observer.py: records how a ledger changed and inspects ledger reads and writes,
including private filesystem views. appendDurably only opens O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW.
The command must run as `strace <LEDGER_TRACE_FLAGS> -o <trace> -- python3 no-io-uring.py <isolated command>`
(see ledgerTraced in acceptance-evidence.mjs).

  ledger-trace.py filter <trace>                 strace -o '|...' sink: drops data records of non-ledger fds
  ledger-trace.py <trace> <root-pid>                  prints {"violations": [...]}; exit 1 if any

No namespace is trusted: mounts are allowed anywhere (Codex bubblewrap), so every read or append of an fd whose canonical -yy path
names the ledger has its bytes inspected (any namespace, per shared-fd-table stream, unicode escapes decoded): a relay line read
anywhere is RELAY_IN_SCORED_RUN. Opening a path named operator-decisions.ndjson that resolves to another file, a
truncated read record, chroot, setns, or a pid not reached by a traced clone, fails.
Ledger access (requested path or -yy canonical fd naming operator-decisions.ndjson): a writable open other than
O_WRONLY|O_APPEND, or with O_TRUNC; creat/truncate/ftruncate/fallocate/link/unlink/rename/symlink; fcntl F_SETFL without
O_APPEND; any pwrite*/copy_file_range/splice/sendfile touching it (appendDurably only uses write); any mmap. Also any successful io_uring_setup, open_by_handle_at,
process_vm_writev or writable /proc/<pid>/mem open; an incomplete trace (no root exit, tracer still running).
"""
import importlib.util, json, os, re, sys, time

sys.dont_write_bytecode = True

_spec = importlib.util.spec_from_file_location('ledger_observer', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ledger-observer.py'))
_observer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_observer)
relayed = _observer.relayed
READS = {'read', 'readv', 'pread64', 'preadv', 'preadv2'}
WRITES = {'write', 'writev'}
BUFFERED = READS | WRITES | {'pwrite64', 'pwritev', 'pwritev2'}
QUOTED = re.compile(r'"((?:[^"\\]|\\.)*)"(\.\.\.)?')
ESCAPE = re.compile(rb'\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)')
SIMPLE = {b'n': b'\n', b't': b'\t', b'r': b'\r', b'v': b'\v', b'f': b'\f'}


def unescape(text):
    def one(match):
        code = match.group(1)
        if code[:1] == b'x':
            return bytes([int(code[1:], 16)])
        if code[:1].isdigit():
            return bytes([int(code, 8) & 0xff])
        return SIMPLE.get(code, code)
    return ESCAPE.sub(one, text.encode('utf-8', 'surrogateescape'))


def filter_stream(trace):
    """strace -o '|...' sink: discard non-ledger read/write buffers before persisting records.
    A record that cannot be attributed is replaced by a REDACTED marker, which verify() rejects as unparsed."""
    # strace -DD execs the tracee in its original process. script(1) waits for all its children;
    # leave that child set, or it waits for this sink while the sink waits for the tracee's EOF.
    if os.fork():
        return
    os.setsid()
    pending = {}
    with open(trace, 'w', errors='surrogateescape') as out:
        for raw in sys.stdin:
            match = LINE.match(raw.rstrip('\n'))
            if not match:
                raw = 'REDACTED unparsable trace record\n'
            else:
                pid, name, rest, resumed = match.group(1), match.group(2), match.group(3), match.group(4)
                if name in BUFFERED and rest.endswith('<unfinished ...>'):
                    pending[pid] = LEDGER in rest.split(',', 1)[0]
                    if not pending[pid]:
                        continue
                elif name in BUFFERED and LEDGER not in rest.split(',', 1)[0]:
                    continue
                elif resumed in BUFFERED:
                    known = pending.pop(pid, None)
                    if known is None:
                        raw = 'REDACTED read resumed without its start (pid %s)\n' % pid
                    elif not known:
                        continue
            out.write(raw)
            out.flush()


LEDGER = 'operator-decisions.ndjson'
DESTRUCTIVE = {'creat', 'truncate', 'ftruncate', 'fallocate', 'link', 'linkat', 'unlink', 'unlinkat', 'rename',
               'renameat', 'renameat2', 'symlink', 'symlinkat'}
LINE = re.compile(r'^(\d+) +(?:(\w+)\((.*)|<\.\.\. (\w+) resumed>(.*)|(\+\+\+ .*|--- .*))$')
FAILED = re.compile(r'\)\s+= (?:-1 |\?)')


def calls(lines):
    pending = {}
    for raw in lines:
        match = LINE.match(raw.rstrip('\n'))
        if not match:
            yield None, 'unparsed', raw
            continue
        pid, name, rest, resumed, tail, status = match.groups()
        if status:
            yield pid, 'status', status
        elif name:
            if rest.endswith('<unfinished ...>'):
                pending[pid] = (name, rest[:-len('<unfinished ...>')])
            else:
                yield pid, name, rest
        else:
            name0, head = pending.pop(pid, (resumed, ''))
            yield pid, name0, head + tail


def child_of(text):
    """Host pid of a successful clone: '= 7 /* 2345 in strace's PID NS */' or plain '= 2345'."""
    match = re.search(r'\)\s+= (\d+)(?: /\* (\d+) in strace\'s PID NS \*/)?\s*$', text)
    return match and (match.group(2) or match.group(1))


STRING = re.compile(r'"(?:[^"\\]|\\.)*"')
FD_PATH = re.compile(r'<[^<>]*>')


def bare(text):
    """Syscall text without quoted strings or <fd path> annotations, so a crafted file name cannot spoof flag names."""
    return FD_PATH.sub('', STRING.sub('""', text))


def verify(trace, root_pid):
    violations, ended, rows, parent = [], False, [], {}
    with open(trace, errors='surrogateescape') as handle:
        for pid, name, text in calls(handle):
            if name == 'unparsed':
                if text.strip():
                    violations.append('trace incomplete or unparsed: ' + text.strip()[:200])
            elif name == 'status':
                ended = ended or (pid == root_pid and ('exited with' in text or 'killed by' in text))
            else:
                rows.append((pid, name, text))
                if name in ('clone', 'clone3', 'fork', 'vfork') and not FAILED.search(text):
                    child = child_of(text)
                    if child is None:
                        violations.append('pid %s: clone without a child pid: %s' % (pid, text[:200]))
                    else:
                        parent[child] = (pid, 'CLONE_FILES' in bare(text))

    def table(pid, seen=()):
        """The pid owning this pid's fd table (threads and libuv workers share it via CLONE_FILES); None if unrooted."""
        if pid == root_pid:
            return pid
        if pid not in parent or pid in seen:
            return None
        up, shared = parent[pid]
        owner = table(up, seen + (pid,))
        return None if owner is None else (owner if shared else pid)

    reads, generation = {}, {}
    for pid in {pid for pid, _, _ in rows if table(pid) is None}:
        violations.append('pid %s was not reached by a traced clone from the root' % pid)
    for pid, name, text in rows:  # trace (completion) order
        bad = lambda reason: violations.append('%s: pid %s %s(%s' % (reason, pid, name, text[:300]))
        ok = not FAILED.search(text)
        ledger = LEDGER in text
        flags = re.search(r'O_(?:RDONLY|WRONLY|RDWR)[A-Z_|0-9x]*', bare(text))
        flags = flags.group(0).split('|') if flags else []
        opened = re.search(r'= (\d+)<([^<>]*)>\s*$', text) if name in ('open', 'openat', 'openat2', 'creat') and ok else None
        if opened:
            key = (table(pid), opened.group(1))
            generation[key] = generation.get(key, 0) + 1
        if name == 'setns' and ok:
            bad('namespace entry')
        elif name == 'chroot' and ok:
            bad('chroot')
        elif name in ('io_uring_setup', 'open_by_handle_at', 'process_vm_writev') and ok:
            bad('syscall that bypasses the trace')
        elif opened and re.search(r'(?:"(?:[^"]*/)?mem"|/mem>)', text) and flags[:1] != ['O_RDONLY']:
            bad('writable process memory open')
        elif name in READS | WRITES and LEDGER in text.split(',', 1)[0]:
            fd, path = text.split(',', 1)[0].split('<', 1)
            key = (table(pid), fd)
            stream = reads.setdefault(key + (path, generation.get(key, 0), name in READS), [])
            for data, cut in QUOTED.findall(text.split(',', 1)[1]):
                if cut:
                    bad('truncated ledger read')
                stream.append(unescape(data))
        elif opened and re.search(r'"(?:[^"]*/)?%s"' % re.escape(LEDGER), text) and not opened.group(2).endswith('/' + LEDGER):
            bad('ledger path opened as another file')
        elif ledger and name in DESTRUCTIVE:
            bad('destructive ledger syscall')
        elif ledger and name in ('open', 'openat', 'openat2'):
            if not flags or 'O_TRUNC' in flags or flags[0] == 'O_RDWR' or (flags[0] == 'O_WRONLY' and 'O_APPEND' not in flags):
                bad('ledger open other than read-only or O_WRONLY|O_APPEND')
        elif ledger and name == 'fcntl' and 'F_SETFL' in bare(text) and 'O_APPEND' not in bare(text):
            bad('ledger fd lost O_APPEND')
        elif ledger and name in ('pwrite64', 'pwritev', 'pwritev2', 'copy_file_range', 'splice', 'sendfile'):
            bad('positioned or copy ledger write')
        elif ledger and name == 'mmap':
            bad('ledger mapping')
    for (owner, fd, path, _, reading), chunks in reads.items():
        if relayed(b''.join(chunks) + b'\n'):
            violations.append('RELAY_IN_SCORED_RUN: fd table of pid %s %s a relay line on ledger fd %s' %
                              (owner, 'read' if reading else 'wrote', fd))
    if not ended:
        violations.append('trace incomplete: root pid %s has no exit record' % root_pid)
    return violations


def tracer_done(trace, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        running = False
        for pid in filter(str.isdigit, os.listdir('/proc')):
            try:
                with open('/proc/%s/cmdline' % pid, 'rb') as handle:
                    args = handle.read().split(b'\0')
                running = running or (int(pid) != os.getpid() and args[1:3] != [os.path.abspath(__file__).encode(), trace.encode()]
                                      and any(trace.encode() in a for a in args))
            except OSError:
                pass
        if not running:
            return True
        time.sleep(0.1)
    return False


if __name__ == '__main__':
    if sys.argv[1] == 'filter':
        filter_stream(sys.argv[2])
        sys.exit(0)
    trace, root_pid = sys.argv[1:3]
    found = verify(trace, root_pid) if tracer_done(trace) else ['tracer still running after the command exited']
    print(json.dumps({'violations': found}))
    sys.exit(1 if found else 0)
