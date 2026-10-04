/**
 * The test side of the Windows portability boundary.
 *
 * Production renders paths and commands through `engine-paths.mjs`; tests
 * compare what it renders here, by meaning rather than by POSIX spelling:
 *
 * - filesystem path: whatever `path`/`fileURLToPath` produce -- never rewritten;
 * - comparison path: `comparisonPath`, for asserting on rendered text only;
 * - shell argument: `quoteCommandToken`, matched by `renderedCommandPattern`.
 */

import { once } from "node:events";
import { rm } from "node:fs/promises";
import path from "node:path";

/** Host separators as `/`, for comparing rendered text. Never pass to `fs`. */
export const comparisonPath = (value) => value.split(path.sep).join("/");

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches `<script> <args>` as `engineCommand` renders it on any host: the
 * absolute script path in either separator, plus the closing quote
 * `quoteCommandToken` adds when the installation path needs one.
 *
 * @param {string} script path below the engine `src/`, `/`-separated
 * @param {string} args the literal arguments that follow the script
 */
export const renderedCommandPattern = (script, args) =>
  new RegExp(
    String.raw`[\\/]` +
      script.split("/").map(escapeRegExp).join(String.raw`[\\/]`) +
      `["']? ${escapeRegExp(args)}`,
  );

/**
 * Stop a child and wait for it to exit. win32 keeps a running process's cwd
 * locked, so a fixture removed before the exit is observed fails with EBUSY.
 */
export const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.stdin?.end();
  child.kill();
  await exited;
};

/**
 * Remove a fixture tree. `fs.rm` itself retries a bounded number of times, and
 * only for transient EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM; anything else throws.
 */
export const removeTree = (target) =>
  rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
