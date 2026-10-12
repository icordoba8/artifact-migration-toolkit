#!/usr/bin/env node

// The installed `artifact-migration-decision` command (Track A7 facade). The
// recorder it runs is the decision gate in `decision-recorder.mjs`, which stays
// below transport: the lifecycle, the AUTO and terminal recorders, relay and
// the MCP elicitation channel all record through `runRecordDecisionCli`.
import { startCommand } from "./transport/entry.mjs";
import { runRecordDecisionCli } from "./decision-recorder.mjs";

export * from "./decision-recorder.mjs";

startCommand(import.meta.url, runRecordDecisionCli);
