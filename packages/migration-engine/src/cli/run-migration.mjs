#!/usr/bin/env node

// The installed `artifact-migration-run` command (Track A7 facade). The
// implementation is transport's: `transport/run.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runMigration } from "../transport/run.mjs";
import { exitCodeFor } from "../lifecycle-policy.mjs";

export * from "../transport/run.mjs";

// A refusal from `parseRunArguments` escapes `runMigration` before a mode is
// known, so it is reported the way every other wrapper reports one: stderr,
// no directive, non-zero exit.
startCommand(import.meta.url, runMigration, (error) => {
  process.stderr.write(`${error.message}\n`);
  // An argument refusal still owes a --json caller its one document.
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ outcome: "FAILED", reason: error.message }, null, 2)}\n`);
  }
  process.exitCode = exitCodeFor("FAILED");
});
