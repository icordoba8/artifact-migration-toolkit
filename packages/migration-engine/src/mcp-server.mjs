#!/usr/bin/env node

// The installed `artifact-migration-mcp` server (Track A7 facade). The
// implementation is transport's: `transport/mcp.mjs`. Provider registrations
// launch this path.
import { reportFailure, startCommand } from "./transport/entry.mjs";
import { serve } from "./transport/mcp.mjs";
import { exitCodeFor } from "./lifecycle-policy.mjs";

export * from "./transport/mcp.mjs";

// `--without-relay` (T1): the Copilot registrations omit `migration_relay_decision`;
// the operator's answer is then relayed through `artifact-migration-decision`.
startCommand(import.meta.url, (argv) => serve({ withoutRelay: argv.includes("--without-relay") }), reportFailure(exitCodeFor("FAILED")));
