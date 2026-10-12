#!/usr/bin/env node

// The installed `artifact-migrate` command (Track A7 facade). The
// implementation is transport's: `transport/artifact.mjs`.
import { startCommand } from "../transport/entry.mjs";
import { runArtifactCli } from "../transport/artifact.mjs";

export * from "../transport/artifact.mjs";

startCommand(import.meta.url, runArtifactCli);
