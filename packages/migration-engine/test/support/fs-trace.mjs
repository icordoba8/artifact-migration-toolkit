// Deterministic filesystem tracing and fault injection for the DR7/DR8 storage
// tests. node:fs/promises is patched in this process (engine modules see the
// change through their live named imports, refreshed by syncBuiltinESMExports)
// and FileHandle's write/sync methods are patched on its prototype, so every
// open, write, fsync, rename and unlink the engine makes is logged in order
// with the path it touched. `inject(op, file, call)` runs before the real call
// and may throw to stop the engine there, do part of the work first (a torn
// write), or return `{ result }` to answer in the real call's place (a short
// write the OS is allowed to make). No production logic is replaced and
// nothing waits on time.
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const NAMED = ["open", "rename", "unlink", "appendFile", "writeFile", "truncate", "mkdir", "rm", "rmdir", "link"];
let restoreActive = null;
const HANDLE = ["write", "writeFile", "sync", "truncate"];

/** An injected I/O failure, shaped like the real one. */
export const ioError = (code = "EIO") => Object.assign(new Error(`${code}: injected`), { code });

/**
 * Starts tracing until `t` ends. Returns the live log: `[op, file, detail]`
 * rows, `file` being the path the call (or the handle's open) named. A new
 * trace replaces the active one, so a test can re-arm with a different fault.
 */
export const traceFs = async (t, inject = async () => {}) => {
  restoreActive?.();
  const log = [];
  const handles = new WeakMap();
  const probe = await fsp.open(os.devNull);
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const named = Object.fromEntries(NAMED.map((name) => [name, fsp[name]]));
  const methods = Object.fromEntries(HANDLE.map((name) => [name, proto[name]]));
  const step = async (op, file, call) => {
    log.push([op, file, call.detail]);
    return inject(op, file, call);
  };
  fsp.open = async (file, flags, ...rest) => {
    await step("open", String(file), { detail: flags });
    const handle = await named.open(file, flags, ...rest);
    handles.set(handle, String(file));
    return handle;
  };
  for (const name of ["rename", "link"]) {
    fsp[name] = async (from, to) => {
      await step(name, String(to), { detail: String(from) });
      return named[name](from, to);
    };
  }
  for (const name of ["unlink", "appendFile", "writeFile", "truncate", "mkdir", "rm", "rmdir"]) {
    fsp[name] = async (file, ...args) => {
      await step(name, String(file), {});
      return named[name](file, ...args);
    };
  }
  for (const name of HANDLE) {
    proto[name] = async function (...args) {
      const replaced = await step(name, handles.get(this), { handle: this, args, real: methods[name] });
      return replaced ? replaced.result : methods[name].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  restoreActive = () => {
    Object.assign(fsp, named);
    Object.assign(proto, methods);
    syncBuiltinESMExports();
    restoreActive = null;
  };
  t.after(() => restoreActive?.());
  return log;
};
