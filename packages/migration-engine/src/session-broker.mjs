/** Session broker entry; the code is `session-broker-host.mjs`. */
import { reportFailure, startCommand } from "./transport/entry.mjs";
import { runSessionBroker } from "./session-broker-host.mjs";

export * from "./session-broker-host.mjs";

startCommand(import.meta.url, runSessionBroker, reportFailure(3));
