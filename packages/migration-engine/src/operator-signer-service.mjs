/**
 * Protected signer service entry. Started by the OS service manager (or a
 * trusted admin) as the dedicated signer-service user from the installed
 * release; not a package bin, not reachable from the migration CLI or MCP.
 * Reads only the fixed root-owned service configuration; no env or path input.
 *
 *   serve
 *   enroll <operator> <actor> <reason> [allow-counterless]
 *   retire|revoke <credentialId> <actor> <reason>
 *   reconcile <nonce> <actor> <reason>
 */

// Track A7 facade: the host code is `operator-signer-host.mjs`.
import { reportFailure, startCommand } from "./transport/entry.mjs";
import { runSignerService } from "./operator-signer-host.mjs";

export * from "./operator-signer-host.mjs";

startCommand(import.meta.url, runSignerService, reportFailure(3));
