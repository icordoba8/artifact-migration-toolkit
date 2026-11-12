#!/usr/bin/env python3
"""exec argv with io_uring_setup/enter/register denied (EPERM) by an inherited, irremovable seccomp filter.
io_uring submits file opcodes without syscalls, so a ptrace gate must never see one succeed. libuv falls back."""
import ctypes, os, struct, sys
LD_W_ABS, JEQ, JGE, RET = 0x20, 0x15, 0x35, 0x06
ALLOW, EPERM = 0x7fff0000, 0x00050000 | 1
def op(code, k, jt=0, jf=0):
    return struct.pack('HBBI', code, jt, jf, k)
prog = b''.join([
    op(LD_W_ABS, 4), op(JEQ, 0xc000003e, 1, 0), op(RET, EPERM),   # any non-x86_64 ABI: deny everything
    op(LD_W_ABS, 0), op(JGE, 0x40000000, 0, 1), op(RET, EPERM),   # x32 numbers
    op(JGE, 425, 0, 2), op(JGE, 428, 1, 0), op(RET, EPERM),       # 425..427 io_uring_*
    op(RET, ALLOW)])
buf = ctypes.create_string_buffer(prog)
fprog = struct.pack('HxxxxxxQ', len(prog) // 8, ctypes.addressof(buf))
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4
fbuf = ctypes.create_string_buffer(fprog)
if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.addressof(fbuf), 0, 0):
    sys.exit('no-io-uring: seccomp failed: %s' % os.strerror(ctypes.get_errno()))
os.execvp(sys.argv[1], sys.argv[1:])
