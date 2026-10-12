#!/usr/bin/env node

// The installed `artifact-migration-toolkit` command (Track A7 facade). The
// implementation is transport's: `transport/toolkit-identity.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runToolkitIdentityCli } from "../transport/toolkit-identity.mjs";

export * from "../transport/toolkit-identity.mjs";

startCommand(import.meta.url, runToolkitIdentityCli);
