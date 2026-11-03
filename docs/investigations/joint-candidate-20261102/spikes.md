# Feasibility spikes (Stage 1, local only)

No provider model was invoked, and no scored or native run took place. The
scripts ran from the session workspace. Their full text is reproduced below so
the results can be re-run.

## S-E2a: FIFO liveness token across sibling PID namespaces (`unshare -Urpf`)

```js
// hold.mjs: the owner keeps the read end open
import { open } from "node:fs/promises"; import { constants as c, readlinkSync } from "node:fs";
const h = await open(process.argv[2], c.O_RDONLY | c.O_NONBLOCK); console.log("holder pid", process.pid, "ns", readlinkSync("/proc/self/ns/pid"));
setInterval(() => h, 1e6);
// probe.mjs: a write-open with no reader is ENXIO
import { open } from "node:fs/promises"; import { constants as c, readlinkSync } from "node:fs";
try { const h = await open(process.argv[2], c.O_WRONLY | c.O_NONBLOCK | c.O_NOFOLLOW); await h.close(); console.log("probe: ALIVE (reader present)"); }
catch (e) { console.log("probe:", e.code); }
console.log("prober ns", readlinkSync("/proc/self/ns/pid"));
```

The driver runs the holder and each probe in its own `unshare -Urpf --mount-proc --kill-child`, then sends SIGKILL to the holder.

```
holder pid 1 ns pid:[4026534295]
probe: ALIVE (reader present)
prober ns pid:[4026534298]
--- after SIGKILL of holder namespace
probe: ENXIO
prober ns pid:[4026534295]
host ns pid:[4026532221]
```

The kernel reused the PID-namespace inode `4026534295` for a different
namespace. That shows the recorded `realm` string identifies an epoch, not a
namespace.

## S-E2b: the same token under the real Codex sandbox (codex-cli 0.166.0, `codex sandbox -P :workspace`)

These invocations use bwrap with `--unshare-user --unshare-pid --unshare-net --cap-drop ALL`, Landlock and seccomp. Isolated `CODEX_HOME`, no auth.

```
$ codex sandbox -P :workspace -C ws -- sh -c "mkfifo -m 600 l.fifo && ls -l l.fifo; grep -E 'NoNewPrivs|CapEff' /proc/self/status; readlink /proc/self/ns/pid; touch /etc/x"
prw------- 1 utmwac utmwac 0 Nov  2 16:56 l.fifo
CapEff:	0000000000000000
NoNewPrivs:	1
pid:[4026535986]
touch: cannot touch '/etc/x': Read-only file system

# sandbox call 1 (holder, kept running)
holder pid 2 ns pid:[4026535986]
# sandbox call 2 (prober)
probe: ALIVE (reader present)
prober ns pid:[4026536051]
# holder node process SIGKILLed; sandbox call 3 (prober)
probe: ENXIO
prober ns pid:[4026535986]
```

Results:

- `mkfifo` and the FIFO write-open both work under workspace-write.
- Zero capabilities and NoNewPrivs are unchanged.
- seccomp does not filter the token. A unix-socket token would not work, because the Codex seccomp profile denies connect, bind and listen.

Side observation, recorded as a separate harness note: killing the outer `codex sandbox` wrapper with SIGKILL left `codex-linux-sandbox` and its child alive, reparented to init. Lock tests must kill the engine process itself.

## S-E4: recursive `mkdir` on a read-only mount reports ENOENT

The mount was an `unshare -Urm` read-only bind of `ro2`.

| Node | `mkdir('ro2/a/b',{recursive:true})` | `mkdir('ro2/a')` |
| --- | --- | --- |
| v22.13.0 | `ENOENT mkdir ro2/a` | `EROFS mkdir ro2/a` |
| v24.11.0 | `ENOENT mkdir ro2/a` | `EROFS mkdir ro2/a` |
| v26.8.2 | `ENOENT mkdir ro2/a` | `EROFS mkdir ro2/a` |

On the recursive path, the reported `error.path` is the first component that is missing.
