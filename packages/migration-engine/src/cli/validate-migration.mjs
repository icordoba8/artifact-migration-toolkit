#!/usr/bin/env node

// The installed `artifact-migration-validate` command (Track A7 facade). The
// implementation is transport's: `transport/validate.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runValidateCli } from "../transport/validate.mjs";

export * from "../transport/validate.mjs";

startCommand(import.meta.url, runValidateCli);
