/**
 * Process startup for every installed command (Track A7).
 *
 * Each installed entry path (`cli/*.mjs`, `mcp-server.mjs`,
 * `record-decision.mjs`, `upgrades/upgrade-migration.mjs`,
 * `artifact/run-artifact.mjs`, `operator-signer-service.mjs`) is a facade that
 * ends in one `startCommand(import.meta.url, …)` call. It starts the command
 * only when that file is the process entry -- `isMainModule` follows a bin
 * symlink -- so importing a facade runs nothing.
 */

import { isMainModule } from "../engine-paths.mjs";
import { BLOCKED_EXIT_CODE } from "../lifecycle/index.mjs";
import { REGISTRY_UNBOUND } from "../store/index.mjs";

/**
 * E6. A coded engine refusal (LOCK_*, FS_ERRNO_UNKNOWN, EROFS, ...) as every
 * transport carries it: MCP as an `isError` result's `structuredContent`, the
 * CLI as its stdout document. Node's own `ERR_*` codes are internal faults.
 */
export const refusalOf = (error) => {
  if (typeof error?.code !== "string" || error.code.startsWith("ERR_")) return null;
  const { code, errno, syscall, path } = error;
  return { code, errno, syscall, path };
};

/**
 * The message on stderr and a non-zero exit code; a coded refusal also prints
 * its `refusalOf` document on stdout. An unbound registry is resolved before
 * anything runs: its BLOCKED / NOT_STARTED document on stdout, exactly as MCP
 * returns it, and exit 2.
 */
export const reportFailure = (exitCode) => (error) => {
  process.stderr.write(`${error.message}\n`);
  if (error.code === REGISTRY_UNBOUND) {
    process.stdout.write(`${JSON.stringify(error.result, null, 2)}\n`);
    process.exitCode = BLOCKED_EXIT_CODE;
    return;
  }
  const refusal = refusalOf(error);
  if (refusal) process.stdout.write(`${JSON.stringify(refusal, null, 2)}\n`);
  process.exitCode = exitCode;
};

export const startCommand = (moduleUrl, run, onFailure = reportFailure(1)) => {
  if (isMainModule(moduleUrl)) run(process.argv.slice(2)).catch(onFailure);
};
