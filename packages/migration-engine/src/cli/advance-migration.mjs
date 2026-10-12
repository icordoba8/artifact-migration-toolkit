#!/usr/bin/env node

// The installed `artifact-migration-advance` command (Track A7 facade). The
// implementation is transport's: `transport/advance.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runAdvanceCli } from "../transport/advance.mjs";

export * from "../transport/advance.mjs";

// No directive on this path: a throw exits non-zero, and a non-zero exit with
// no `loop:` line already means stop. Printing one would also put output on
// stdout for a usage error that must stay silent there.
startCommand(import.meta.url, runAdvanceCli);
