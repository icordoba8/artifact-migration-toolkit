#!/usr/bin/env node

// The installed `artifact-migration-registry` command (Track A7 facade). The
// implementation is transport's: `transport/registry.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runRegistryCli } from "../transport/registry.mjs";

export * from "../transport/registry.mjs";

startCommand(import.meta.url, runRegistryCli);
