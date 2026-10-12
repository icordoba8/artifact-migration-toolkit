#!/usr/bin/env node

// The installed `artifact-migration-mcp` server (Track A7 facade). The
// implementation is transport's: `transport/mcp.mjs`. Provider registrations
// launch this path.
import { reportFailure, startCommand } from "./transport/entry.mjs";
import { serve } from "./transport/mcp.mjs";
import { exitCodeFor } from "./lifecycle-policy.mjs";

export * from "./transport/mcp.mjs";

startCommand(import.meta.url, () => serve(), reportFailure(exitCodeFor("FAILED")));
