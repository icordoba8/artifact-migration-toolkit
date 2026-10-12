#!/usr/bin/env node

// The installed `artifact-migration-discover` command (Track A7 facade). The
// implementation is transport's: `transport/discover.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runDiscoverCli } from "../transport/discover.mjs";

export * from "../transport/discover.mjs";

startCommand(import.meta.url, runDiscoverCli);
