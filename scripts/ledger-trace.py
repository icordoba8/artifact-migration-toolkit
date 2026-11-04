#!/usr/bin/env python3
"""A9 syscall gate, companion to ledger-observer.py: rejects every ledger write and inspects ledger reads,
including private filesystem views. No operator-ledger append is exempt in scored runs.
The command must run as `strace <LEDGER_TRACE_FLAGS> -o <trace> -- python3 no-io-uring.py <isolated command>`
(see ledgerTraced in acceptance-evidence.mjs).

  ledger-trace.py filter <trace> <engines-json>       strace -o '|...' sink: drops data records of non-ledger fds
  ledger-trace.py <trace> <root-pid>                  prints {"violations": [...]}; exit 1 if any
  ledger-trace.py engine-documents <trace> <engines-json>   prints {"documents": [...]} (G1 CLI refusals)

engines-json is the receipt's [[node, entry], ...]. Besides the ledger, the sink keeps exactly: the execve of such a pair
(execve("<node>", [argv0, "<entry>", ...]): no node flag can sit before the entry) and that pid's own fd-1 write/writev
starting a JSON object. A document counts only if one such write parses whole and that pid then exits non-zero, so nothing
another process prints, in any shell composition, can be attributed to the engine.
strace shows this sink every execve environment (-e abbrev=!execve). It is reduced here to a verdict and never persisted:
the kept execve carries ["AMT_ENV_CLEAN"] or ["AMT_ENV_UNSAFE", <names from UNSAFE_ENV only>] in its place, and an engine
started with an unsafe environment binds nothing, because that code runs before the entry.
Shadowing the node binary, the entry or a library at the same path needs CAP_SYS_ADMIN, which the sandbox holds only in a user
namespace it creates (setns already fails the gate). So an engine also binds nothing unless the user namespaces created along
its own lineage number exactly USERNS_DEPTHS.

No namespace is trusted: mounts are allowed anywhere (Codex bubblewrap), so every read or append of an fd whose canonical -yy path
names the ledger has its bytes inspected (any namespace, per shared-fd-table stream, unicode escapes decoded): a relay line read
anywhere is RELAY_IN_SCORED_RUN. Opening a path named operator- or auto-decisions.ndjson that resolves to another file, a
truncated read record, chroot, setns, or a pid not reached by a traced clone, fails.
Ledger access (requested path or -yy canonical fd naming operator- or auto-decisions.ndjson): any writable open,
O_CREAT or O_TRUNC; creat/truncate/ftruncate/fallocate/link/unlink/rename/symlink; fcntl F_SETFL without
O_APPEND; any write*/pwrite*/copy_file_range/splice/sendfile touching it; any mmap. Also any successful io_uring_setup, open_by_handle_at,
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
# Run code or change module loading before the engine entry, on Node 22.13 and glibc; any LD_* counts too. Exact names, not
# NODE_*: NODE_TEST_CONTEXT, NODE_NO_WARNINGS and the like are harmless and a false rejection is a functional failure.
# Not listed, data only: NODE_ICU_DATA, LOCPATH, NLSPATH, RES_OPTIONS, MALLOC_*.
UNSAFE_ENV = frozenset({'NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_PRESERVE_SYMLINKS', 'NODE_PRESERVE_SYMLINKS_MAIN',
                        'NODE_REPL_EXTERNAL_MODULE', 'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_MODULES', 'OPENSSL_ENGINES',
                        'GLIBC_TUNABLES', 'GCONV_PATH'})
FILTERED = BUFFERED | {'execve'}  # Every execve but an installed engine's is dropped: argv is agent content.
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


def engine_pair(text, engines):
    """True if this execve record's path and argv[1] are a receipt-installed (node, entry) pair."""
    match = EXECVE.match(text)
    return bool(match) and list(match.groups()) in engines


def userns_depth(pid, born, unshared):
    """User namespaces created along pid's lineage; `born[child]` = (parent, parent's unshares at the clone, clone created one)."""
    depth, count, seen = 0, unshared.get(pid, 0), set()
    while pid in born and pid not in seen:
        seen.add(pid)
        parent, at_clone, created = born[pid]
        depth += count + created
        pid, count = parent, at_clone
    return depth + count


def touches(name, text, engines):
    """True if a successful path change or writable open in this record could replace an engine's node or entry path."""
    protected = {os.path.normpath(p) for pair in engines for p in pair}
    parts = {part for p in protected for part in p.split('/') if part}
    plain = bare(text)
    if name in ('open', 'openat', 'openat2', 'creat', 'truncate'):
        if name not in ('creat', 'truncate') and not re.search(r'O_(?:WRONLY|RDWR|CREAT|TRUNC)', plain):
            return False
        opened = re.search(r'= \d+<([^<>]*)>\s*$', text)
        candidates = [opened.group(1)] if opened else []
        named = PATH_ARG.search(text)
        if named:
            candidates.append(os.path.join(named.group(1) or '', unescape(named.group(2)).decode('utf-8', 'replace')))
        return any(os.path.normpath(c) in protected or (not c.startswith('/') and os.path.basename(c) in parts) for c in candidates)
    for directory, raw in PATH_ARG.findall(text):
        path = os.path.join(directory, unescape(raw).decode('utf-8', 'replace'))
        if not path.startswith('/'):  # A plain relative path: no cwd in the trace, so any overlap with a protected name counts.
            if '..' in path.split('/') or parts & set(path.split('/')):
                return True
            continue
        path = os.path.normpath(path)
        if any(p == path or p.startswith(path.rstrip('/') + '/') for p in protected):
            return True
    return False


def unsafe_names(entries):
    names = set()
    for data, _ in QUOTED.findall(entries):
        name = unescape(data).split(b'=', 1)[0].decode('ascii', 'replace')
        if name in UNSAFE_ENV:
            names.add(name)
        elif name.startswith('LD_'):
            names.add('LD_*')
    return sorted(names)


def with_env_verdict(rest):
    """An engine execve record with its environment replaced by the verdict; None if its argv cannot be delimited.
    Only constants from UNSAFE_ENV leave this function: no value, and no name outside the list."""
    head = EXEC_HEAD.match(rest)
    if not head:
        return None
    env = ENV_ARRAY.match(rest, head.end())
    if env:
        names, tail = unsafe_names(env.group(1)), rest[env.end():]
    else:  # A cut or unreadable environment proves nothing.
        ending = EXEC_TAIL.search(rest, head.end())
        names, tail = ['UNREADABLE'], ending.group(1) if ending else ') = ?'
    verdict = ', '.join(['"AMT_ENV_UNSAFE"'] + ['"%s"' % name for name in names]) if names else '"AMT_ENV_CLEAN"'
    return '%s[%s]%s' % (head.group(0), verdict, tail)


def filter_stream(trace, engines):
    """strace -o '|...' sink: discard non-ledger read/write buffers before persisting records.
    A record that cannot be attributed is replaced by a REDACTED marker, which verify() rejects as unparsed."""
    # strace -DD execs the tracee in its original process. script(1) waits for all its children;
    # leave that child set, or it waits for this sink while the sink waits for the tracee's EOF.
    if os.fork():
        return
    os.setsid()
    pending, engine = {}, set()

    def keep(pid, name, rest):
        if name == 'execve':
            return engine_pair(rest, engines)
        return bool(LEDGER.search(rest.split(',', 1)[0])) or (pid in engine and name in WRITES and bool(STDOUT_OBJECT.match(rest)))

    def execed(pid, kept, result):
        if not FAILED.search(result):
            (engine.add if kept else engine.discard)(pid)

    with open(trace, 'w', errors='surrogateescape') as out:
        for raw in sys.stdin:
            match = LINE.match(raw.rstrip('\n'))
            if not match:
                raw = 'REDACTED unparsable trace record\n'
            else:
                pid, name, rest, resumed = match.group(1), match.group(2), match.group(3), match.group(4)
                if (match.group(6) or '').startswith('+++'):
                    engine.discard(pid)  # The pid is gone and may be reused.
                if name in FILTERED and rest.endswith('<unfinished ...>'):
                    pending[pid] = keep(pid, name, rest)
                    if not pending[pid]:
                        continue
                elif name in FILTERED:
                    kept = keep(pid, name, rest)
                    if name == 'execve':
                        execed(pid, kept, rest)
                    if not kept:
                        continue
                if name == 'execve':
                    record = with_env_verdict(rest)
                    raw = '%s execve(%s\n' % (pid, record) if record else 'REDACTED unparsable trace record\n'
                elif resumed in FILTERED:
                    known = pending.pop(pid, None)
                    if known is None:
                        raw = 'REDACTED read resumed without its start (pid %s)\n' % pid
                    else:
                        if resumed == 'execve':
                            execed(pid, known, match.group(5))
                        if not known:
                            continue
            out.write(raw)
            out.flush()


# Exactly the harness sandbox: the runner's isolation (1) plus Codex 0.165.0's bwrap (2), measured at 3 on real scored runs.
# The runner pins that Codex version and every agent shell runs in its sandbox; any namespace an agent process creates
# adds at least one. Depth 1 (runner alone) is never accepted: from there two nested namespaces would forge depth 3.
SANDBOX_USERNS_DEPTH = 3
# Replacing a node or entry path, or any ancestor of it, needs no capability where the ancestor is writable (rename it away,
# put a fake tree in its place, rename it back). Path-changing syscalls are kept by the sink; one that names a protected path,
# its ancestor, or that cannot be resolved and could name one, unbinds every engine of the run (ENTRY_PATH_CHANGED).
PATH_CHANGES = {'rename', 'renameat', 'renameat2', 'link', 'linkat', 'symlink', 'symlinkat', 'unlink', 'unlinkat'}
PATH_ARG = re.compile(r'(?:(?:AT_FDCWD|\d+)<([^<>]*)>, )?"((?:[^"\\]|\\.)*)"')
LEDGER = re.compile(r'(?:operator|auto)-decisions\.ndjson')  # human and AUTO ledgers: both are consumed as decisions
DESTRUCTIVE = {'creat', 'truncate', 'ftruncate', 'fallocate', 'link', 'linkat', 'unlink', 'unlinkat', 'rename',
               'renameat', 'renameat2', 'symlink', 'symlinkat'}
LINE = re.compile(r'^(\d+) +(?:(\w+)\((.*)|<\.\.\. (\w+) resumed>(.*)|(\+\+\+ .*|--- .*))$')
FAILED = re.compile(r'\)\s+= (?:-1 |\?)')
EXECVE = re.compile(r'"((?:[^"\\]|\\.)*)", \["(?:[^"\\]|\\.)*", "((?:[^"\\]|\\.)*)"')
STDOUT_OBJECT = re.compile(r'1(?:<.*?>)?, (?:\[\{iov_base=)?"\{')
EXEC_HEAD = re.compile(r'"(?:[^"\\]|\\.)*", \[(?:"(?:[^"\\]|\\.)*"(?:\.\.\.)?(?:, )?)*(?:\.\.\.)?\], ')
ENV_ARRAY = re.compile(r'\[((?:"(?:[^"\\]|\\.)*"(?:, )?)*)\]')  # No "..." forms: a truncated environment does not match.
ENV_VERDICT = re.compile(r'\["AMT_ENV_CLEAN"\]|\["AMT_ENV_UNSAFE"((?:, "[A-Z0-9_*]+")+)\]')
EXEC_TAIL = re.compile(r'( <unfinished \.\.\.>|\)\s+= [^"]*)$')


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
        ledger = bool(LEDGER.search(text))
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
        elif name in READS | WRITES and LEDGER.search(text.split(',', 1)[0]):
            if name in WRITES:
                bad('ledger write')
            fd, path = text.split(',', 1)[0].split('<', 1)
            key = (table(pid), fd)
            stream = reads.setdefault(key + (path, generation.get(key, 0), name in READS), [])
            for data, cut in QUOTED.findall(text.split(',', 1)[1]):
                if cut:
                    bad('truncated ledger read')
                stream.append(unescape(data))
        elif opened and (named := re.search(r'"(?:[^"]*/)?(%s)"' % LEDGER.pattern, text)) and not opened.group(2).endswith('/' + named.group(1)):
            bad('ledger path opened as another file')
        elif ledger and name in DESTRUCTIVE:
            bad('destructive ledger syscall')
        elif ledger and name in ('open', 'openat', 'openat2'):
            if not flags or flags[0] != 'O_RDONLY' or 'O_CREAT' in flags or 'O_TRUNC' in flags:
                bad('ledger open other than read-only without creation or truncation')
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


def engine_documents(trace, engines):
    """JSON objects an installed engine process wrote whole to its own fd 1 and then exited non-zero."""
    found, unsafe, running, started, born, unshared, changed = [], [], {}, [], {}, {}, []
    with open(trace, errors='surrogateescape') as handle:
        for pid, name, text in calls(handle):
            if name in PATH_CHANGES | {'open', 'openat', 'openat2', 'creat', 'truncate'} and not FAILED.search(text) and touches(name, text, engines):
                changed.append({'pid': pid, 'names': ['ENTRY_PATH_CHANGED'], 'syscall': name})
            if name == 'unshare' and not FAILED.search(text) and 'CLONE_NEWUSER' in bare(text):
                unshared[pid] = unshared.get(pid, 0) + 1
            elif name in ('clone', 'clone3', 'fork', 'vfork') and not FAILED.search(text) and child_of(text):
                born[child_of(text)] = (pid, unshared.get(pid, 0), 'CLONE_NEWUSER' in bare(text))
            elif name == 'execve' and not FAILED.search(text):
                running.pop(pid, None)
                if engine_pair(text, engines):
                    head = EXEC_HEAD.match(text)
                    verdict = head and ENV_VERDICT.match(text, head.end())
                    names = re.findall(r'"([^"]+)"', verdict.group(1) or '') if verdict else ['UNVERIFIED']
                    if names:
                        unsafe.append({'pid': pid, 'entry': EXECVE.match(text).group(2), 'names': names})
                    else:
                        running[pid] = {'entry': EXECVE.match(text).group(2), 'documents': []}
                        started.append(pid)
            elif name == 'status' and text.startswith('+++'):
                process = running.pop(pid, None)
                status = re.match(r'\+\+\+ exited with (\d+) \+\+\+', text)
                if process and status and status.group(1) != '0':
                    found += [{'pid': pid, 'entry': process['entry'], 'exitCode': int(status.group(1)), 'document': document}
                              for document in process['documents']]
            elif pid in running and name in WRITES and STDOUT_OBJECT.match(text) and not FAILED.search(text):
                try:
                    document = json.loads(b''.join(unescape(data) for data, _ in QUOTED.findall(text.split(',', 1)[1])))
                except ValueError:
                    continue
                if isinstance(document, dict):
                    running[pid]['documents'].append(document)
    # Completion order puts a vforked child's exec before its clone record: lineage is read once the whole trace is in.
    shadowed = {pid: userns_depth(pid, born, unshared) for pid in started}
    shadowed = {pid: depth for pid, depth in shadowed.items() if depth != SANDBOX_USERNS_DEPTH}
    unsafe += [{'pid': pid, 'names': ['USERNS_DEPTH_%d' % depth]} for pid, depth in shadowed.items()] + changed
    # A changed path can precede or follow any engine and be restored before verification: then no engine binds.
    return {'documents': [] if changed else [item for item in found if item['pid'] not in shadowed], 'unsafeEngines': unsafe}


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
        filter_stream(sys.argv[2], json.loads(sys.argv[3]))
        sys.exit(0)
    if sys.argv[1] == 'engine-documents':
        print(json.dumps(engine_documents(sys.argv[2], json.loads(sys.argv[3]))))
        sys.exit(0)
    trace, root_pid = sys.argv[1:3]
    found = verify(trace, root_pid) if tracer_done(trace) else ['tracer still running after the command exited']
    print(json.dumps({'violations': found}))
    sys.exit(1 if found else 0)
