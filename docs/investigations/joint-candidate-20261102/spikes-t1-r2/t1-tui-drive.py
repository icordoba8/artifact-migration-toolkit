# Drives the native TUI in a real PTY: wait for startup, type "/mcp show start-migration", capture the screen text. No prompt is sent to a model.
import os, pty, sys, time, select, re
S = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    [os.environ.pop(k) for k in list(os.environ) if k.startswith(("VSCODE_", "TERM_PROGRAM"))]; os.environ["TERM"] = "xterm-256color"; os.environ["COPILOT_HOME"] = S + "/home"; os.environ["COLUMNS"] = "200"; os.environ["LINES"] = "60"
    os.chdir(S + "/consumer")
    os.execvp("copilot", ["copilot", "--log-dir", S + "/logs-tui-mcp2", "--log-level", "debug"])
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 200, 0, 0))
out = b""
def pump(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: out += os.read(fd, 65536)
            except OSError: return
pump(12)
os.write(fd, b"\x1b"); pump(2)
for ch in "/mcp show start-migration": os.write(fd, ch.encode()); time.sleep(0.03)
pump(1.5); os.write(fd, b"\r"); pump(6)
os.write(fd, b"\x1b"); pump(1)
for ch in "/exit": os.write(fd, ch.encode()); time.sleep(0.03)
os.write(fd, b"\r"); pump(3)
try: os.kill(pid, 9)
except Exception: pass
text = re.sub(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[=>78]", b"", out).decode("utf8", "replace")
open(S + "/tui-mcp2.screen.txt", "w").write(text)
