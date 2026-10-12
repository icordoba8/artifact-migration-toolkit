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

/** The message on stderr, nothing on stdout, and a non-zero exit code. */
export const reportFailure = (exitCode) => (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = exitCode;
};

export const startCommand = (moduleUrl, run, onFailure = reportFailure(1)) => {
  if (isMainModule(moduleUrl)) run(process.argv.slice(2)).catch(onFailure);
};
