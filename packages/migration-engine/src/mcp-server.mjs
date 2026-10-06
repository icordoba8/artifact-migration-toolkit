#!/usr/bin/env node

/**
 * The MCP adapter (Plan 06). A typed transport over the same core the CLI uses,
 * and nothing else: module/artifact readers and the same iteration drivers
 * the CLI runs, with capture buffers instead of transport stdout.
 *
 * It is not a second migration engine. It owns no rule, no sequence, and no
 * exit-code table; it never maps, prunes, or renames a field the core returned
 * (D6-8); and *no tool it exposes can approve an operator decision* (D6-3).
 *
 * For legacy records, `08` D8-2 adds the one thing D6-4 deferred: when the client declares
 * `elicitation` during `initialize`, this server originates the approval
 * request itself -- a server-to-client `elicitation/create` carrying the
 * candidate's read-only details and the per-candidate confirmation phrase the
 * human types back. The model never sees that request and never answers it; the
 * answer is compared inside `record-decision.mjs` under the module lock.
 * That is why there is still no `migration_approve` tool and no approval
 * argument on any schema: an approval is not something a model can call.
 * A client that declares no elicitation declares only that *it* has no human
 * channel. Under `--mode step` that is the end of it: `migration_run` stops at
 * `OPERATOR_DECISION` and nothing is written, exactly as D6-4 specified. Under
 * `--mode auto` -- the default -- the AUTO principal answers instead, on the
 * engine's own authority, and its lines land in the AUTO ledger, never in the
 * human operator record. What a missing elicitation capability can never do is
 * fall back to the transport's own stdio: that is the JSON-RPC channel, not an
 * operator's terminal, and nothing here reads a challenge off it.
 *
 * ponytail: a hand-rolled tools-only stdio server (D6-1). Ceiling: one
 * transport, elicitation as the only server-to-client request, no sampling, no
 * resources, no prompts, no progress notifications, and no protocol-version
 * negotiation beyond echoing a version we recognize. Upgrade path: adopt
 * @modelcontextprotocol/sdk the day a consumer needs any of the rest -- the
 * tool bodies are core calls and are unaffected by a transport swap.
 */

import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./engine-paths.mjs";

import {
  DESIGN_SOURCES,
  engineCommand,
  exitCodeFor,
  getMigrationStatus,
  MIGRATION_MODES,
  pendingDecisionCandidates,
  PONYTAIL_TARGETS,
  previewDiscoveryScan,
  resolveRegistryPath,
  upgradeCommandFor,
  WORKFLOW_VERSION,
} from "./core.mjs";
import { relayOperatorDecision, runRecordDecisionCli } from "./record-decision.mjs";
import { runMigration } from "./cli/run-migration.mjs";
import { getArtifactStatus, runArtifact } from "./artifact/artifact-migration.mjs";

const SERVER_NAME = "start-migration";

/** Newest first. `initialize` echoes the client's if we know it (D6-1). */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * D6-2. The read-only tools take the same three optional strings plus a
 * required module, because that is what `resolveRegistryPath` and the core
 * already accept. `migration_run` additionally exposes the invocation options
 * the shared driver accepts; their enums come from the same policy constants.
 */
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    module: { type: "string", description: "The migration module name." },
    cwd: {
      type: "string",
      description:
        "Absolute working directory of the current migration interaction, including its isolated worktree. Supply on every call.",
    },
    registry: {
      type: "string",
      description:
        "Registry path. Accepted only during first setup; omit once the binding is persisted.",
    },
    slice: {
      type: "string",
      description: "Slice id, when the checkpoint is sliced.",
    },
    target: { type: "string", description: "Target module override." },
  },
  required: ["module"],
  additionalProperties: false,
};

const RUN_INPUT_SCHEMA = {
  ...INPUT_SCHEMA,
  properties: {
    ...INPUT_SCHEMA.properties,
    mode: {
      type: "string",
      enum: [...MIGRATION_MODES],
      description: "Confirmation mode. Defaults to auto when omitted.",
    },
    ponytail: {
      type: "string",
      enum: Object.keys(PONYTAIL_TARGETS),
      description:
        "Migration-level Ponytail target. Opt-in and independent of session-level Ponytail mode.",
    },
    designSource: {
      type: "string",
      enum: [...DESIGN_SOURCES],
      description:
        "Bootstrap-fixed design source. 'figma-mcp' makes Figma the visual/UX authority and requires one or more figma links; 'legacy-runtime' makes the running legacy app the pinned visual authority and refuses figma links; defaults to 'target-system'.",
    },
    figma: {
      type: "array",
      items: { type: "string" },
      description:
        "One or more Figma design links (/design/ or /make/). Required with designSource 'figma-mcp'; fixed for the migration's lifetime.",
    },
    legacy: {
      type: "array",
      items: { type: "string" },
      description:
        "One or more legacy source modules converging on the target. With it, `module` names the target. Sorted, deduplicated, and fixed for the migration's lifetime.",
    },
    adoptTarget: {
      type: "boolean",
      description:
        "Adopt an already-implemented target: pins an immutable pre-migration baseline of the target tree and unlocks row-level ADOPTED_VERIFIED.",
    },
  },
};

// The one tool whose arguments carry an answer, and only the operator's relayed one.
const RELAY_TOOL = "migration_relay_decision";
const RELAY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    module: INPUT_SCHEMA.properties.module,
    cwd: INPUT_SCHEMA.properties.cwd,
    reference: { type: "string", description: "operatorApproval.reference from the OPERATOR_DECISION result, unchanged." },
    decision: { type: "string", enum: ["APPROVE", "REJECT"], description: "The operator's explicit answer from their latest message." },
  },
  required: ["module", "reference", "decision"],
  additionalProperties: false,
};

const ARTIFACT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", description: "Primary artifact source path." },
    sources: { type: "array", items: { type: "string" } },
    type: { type: "string" }, target: { type: "string" },
    sourceRoot: { type: "string" }, targetRoot: { type: "string" },
    ...Object.fromEntries(["cwd", "mode", "slice", "designSource", "figma", "ponytail"]
      .map((key) => [key, RUN_INPUT_SCHEMA.properties[key]])),
  },
  required: ["source"],
  additionalProperties: false,
};

// Explicit fields only: a tool payload can select work, never supply authority.
const artifactOptions = ({ source, sources, type, target, sourceRoot, targetRoot,
  mode, slice, designSource, figma, ponytail }) =>
  ({ source, sources, type, target, sourceRoot, targetRoot, mode, slice, designSource, figma, ponytail });

/**
 * D6-3. The refused set is derived, not chosen: `01` D1's five operator acts
 * plus the two sequencers `run` already performs. A future tool request is
 * answered by naming which act it performs. Each entry maps to the command an
 * operator types at a terminal -- the same information `04` D4-4 prints.
 */
const REFUSED_TOOLS = {
  migration_approve: (module) =>
    engineCommand("record-decision.mjs", module, "--approve", "<candidate-id>"),
  migration_bootstrap: (module) =>
    engineCommand(
      "cli/discover-module.mjs",
      module,
      "--registry",
      "<path>",
      "--openspec-proposal-stdin",
    ),
  migration_refresh: (module) =>
    engineCommand(
      "cli/discover-module.mjs",
      module,
      "--refresh",
      "--confirm-mismatch",
    ),
  migration_register: (module) =>
    engineCommand(
      "cli/update-migration-registry.mjs",
      module,
      "--target",
      "<target>",
    ),
  migration_upgrade: (module) => upgradeCommandFor(module),
  migration_advance: (module) => engineCommand("cli/run-migration.mjs", module),
  migration_validate: (module) => engineCommand("cli/run-migration.mjs", module),
};

/**
 * W2-3. `REFUSED_TOOLS` refuses by name, which only works for names that exist.
 * This refuses by *shape*: any argument key that reads as an approval, a
 * confirmation, a decision, or a challenge, on any tool. A channel nobody enumerated could
 * otherwise hand the recorder a token; an enumeration of the known
 * shapes closes the class, not just the instance.
 */
const APPROVAL_SHAPED_KEY = /approv|confirm|decision|challenge/i;
export const approvalShapedArgument = (arguments_) => {
  if (!arguments_ || typeof arguments_ !== "object") return null;
  return (
    Object.keys(arguments_).find((key) => APPROVAL_SHAPED_KEY.test(key)) ?? null
  );
};

const registryFor = async (arguments_) => {
  const { registryPath } = await resolveRegistryPath({
    cliPath: arguments_.registry,
    moduleName: arguments_.module,
  });
  return { registryPath, moduleName: arguments_.module };
};

/**
 * D6-8. The core reader's object crosses verbatim -- no mapping, no pruning, no
 * renaming. Deciding what a client may not see would be policy, and `01` D1
 * says the adapter owns none.
 */
const readOnly = (reader) => async (arguments_) =>
  reader(await registryFor(arguments_));

const runArguments = ({
  module,
  registry,
  slice,
  target,
  mode,
  ponytail,
  designSource,
  figma,
  legacy,
  adoptTarget,
}) => [
  module,
  ...(registry ? ["--registry", registry] : []),
  ...(slice ? ["--slice", slice] : []),
  ...(target ? ["--target", target] : []),
  ...(mode === undefined ? [] : ["--mode", mode]),
  ...(ponytail === undefined ? [] : ["--ponytail", ponytail]),
  ...(designSource === undefined ? [] : ["--design-source", designSource]),
  ...(Array.isArray(figma)
    ? figma.flatMap((url) => ["--figma", url])
    : figma
      ? ["--figma", figma]
      : []),
  ...(Array.isArray(legacy)
    ? legacy.flatMap((name) => ["--legacy", name])
    : legacy
      ? ["--legacy", legacy]
      : []),
  ...(adoptTarget ? ["--adopt-target"] : []),
];

/**
 * `08` D8-2. Per-connection state, and the only place a human channel is
 * decided. `elicitation` is set from the *client's* `initialize` capabilities
 * and from nothing else -- no tool argument, no environment variable, no
 * default. A session built without a `request` transport can never elicit, so
 * every direct `handleMessage` caller (the tests included) is D6-4 by
 * construction.
 */
export const createSession = ({ request = null } = {}) => ({
  request,
  elicitation: false,
});

/**
 * The one field the human fills in, and it is free text on purpose.
 *
 * An `enum: ["Approve", "Decline"]` permits the unsafe grouped-answer shape
 * `{"action":"accept","content":{"decision":"Approve"}}`, which a host can
 * synthesize from the schema alone, with no dialog and no
 * person, and this adapter then handed the recorder its approval token. A
 * required free-text field carries no answer a schema-driven auto-responder can
 * derive -- it has to transcribe the per-candidate phrase, or it has nothing.
 */
const CONFIRMATION_SCHEMA = {
  type: "object",
  properties: {
    confirmation: {
      type: "string",
      title: "Confirmation phrase",
      description:
        "Type the confirmation phrase exactly as shown to approve the selected candidate or group. An empty field, any other text, or dismissing this request writes nothing.",
      minLength: 1,
    },
  },
  required: ["confirmation"],
};

/**
 * `08` D8-3. The approver `run` calls when this connection has a human behind
 * it. It is a closure over the session, built here and never returned to a
 * client, so the only way to reach it is to be `runMigration` handling a
 * genuinely pending, genuinely approvable candidate.
 *
 * It decides nothing and it *authors* nothing. The single rule here is that the
 * bytes handed to the recorder are bytes the response carried: an answer this
 * adapter composed itself would be this adapter approving, whatever the host
 * did. So the challenge phrase is never returned from this function -- only
 * `response.content.confirmation` is, verbatim, and `record-decision.mjs`
 * compares it against the phrase it derived from the candidate it recomputes
 * under the module lock.
 *
 * Everything else is the empty string, which is a mismatch and writes nothing:
 * `decline`, `cancel`, an unknown action, a missing or non-string confirmation,
 * an accept carrying extra fields, and an accept whose text does not match.
 *
 * What this deliberately does *not* do is call any of that a human rejection.
 * `decline` from a host that showed a person a dialog and `decline` from a host
 * that auto-answered without rendering anything are the same three bytes on the
 * wire; the protocol carries nothing that separates them. So a non-accept means
 * only "no human approval arrived here", the driver still reports
 * `OPERATOR_DECISION`, and the trusted terminal path it returns alongside stays
 * open. Reading `decline` as a verdict is what could strand a valid migration.
 *
 * ponytail: transcription, not proof of humanity. Ceiling: the phrase is in the
 * message the host renders, so a host that scrapes its own dialog text can
 * still forge one approval per request -- the same ceiling as an operator's
 * terminal being able to echo the phrase it was just printed. What it does buy
 * is that no *default*, no enum pick, and no empty auto-accept is an approval.
 * Upgrade path: an out-of-band token the operator reads from the record, or a
 * detached signature verified against a key pinned at RESOLVE.
 */
const ELICITATION_TIMEOUT_MS = 5000;

const trustedDecisionRecorder = (session, stdout) => (arguments_) =>
  runRecordDecisionCli(arguments_, {
    stdout,
    ask: async ({ challenge, summary, review }) => {
      let timer;
      // Elicitation is only a fast path: timeout, transport failure or an
      // unrendered request is no answer, so the driver stops at OPERATOR_DECISION.
      const response = await Promise.race([
        Promise.resolve().then(() => session.request("elicitation/create", {
          message: `Working directory: ${process.cwd()}\n${summary}` +
            (review ? "\nThis host response is AGENT_RELAYED only, never HUMAN_ATTESTED." : `\nConfirmation phrase: ${challenge}`),
          requestedSchema: review ? {
            type: "object", properties: { decision: { type: "string", enum: ["APPROVE", "REJECT"],
              description: "Choose explicitly after reviewing. No default; cancellation records nothing." } }, required: ["decision"],
          } : CONFIRMATION_SCHEMA,
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Elicitation timed out; no decision was recorded.")), ELICITATION_TIMEOUT_MS);
        }),
      ]).catch(() => null).finally(() => clearTimeout(timer));
      if (response?.action === "cancel") return "cancel";
      if (review) return response?.action === "accept" &&
        ["APPROVE", "REJECT"].includes(response.content?.decision) &&
        Object.keys(response.content).length === 1
        ? response.content.decision : "";
      // The human's own text, or nothing. Never `challenge`.
      return response?.action === "accept" &&
        typeof response.content?.confirmation === "string" &&
        Object.keys(response.content).length === 1
        ? response.content.confirmation
        : "";
    },
  });

/**
 * D6-5. The outcome crosses as a typed field; the `loop:` line never does --
 * it is stdout contract and stdout belongs to the CLI. `exitCode` comes from
 * the core's `exitCodeFor`, so the two transports can never disagree.
 *
 * The preview text both wrappers write lands in `log`, which a typed client is
 * free to ignore. It is captured rather than parsed: `01` D1 forbids MCP
 * reading CLI stdout, and this is the same prohibition honored from the inside.
 */
const runTool = async (arguments_, session) => {
  const captured = [];
  const buffer = { write: (chunk) => (captured.push(String(chunk)), true) };
  // `runMigration` sets `process.exitCode` for the CLI entry point. A long-lived
  // server's exit code is not any single iteration's, so it is restored here.
  const previousExitCode = process.exitCode;
  let result;
  try {
    result = await runMigration(runArguments(arguments_), {
      stdout: buffer,
      // A human channel when the client declared one, and `null` -- never
      // `undefined` -- when it did not. `null` is a positive statement that
      // this transport has no human to ask, which is what stops `recorderFor`
      // from probing the process's own TTY. Whether the AUTO principal answers
      // instead is decided by `mode`, in the core, from one policy.
      recordTrustedDecision: session?.elicitation
        ? trustedDecisionRecorder(session, buffer)
        : null,
    });
  } finally {
    process.exitCode = previousExitCode;
  }
  return {
    outcome: result.outcome,
    exitCode: exitCodeFor(result.outcome),
    reason: result.reason ?? null,
    request: result.request ?? null,
    progress: result.progress ?? null,
    progressChecklist: result.progressChecklist ?? null,
    // Legacy wire field, empty on the direct-ledger path: a format-19 record
    // cites no receipt and the adapter invents none.
    decisionReferences: result.decisionReferences ?? [],
    // The core's own decision projection, crossing verbatim. The adapter does
    // not interpret it, does not derive authority from this response, and does
    // not reconcile it with the status read below -- both come from the one
    // projection, so there is nothing to reconcile.
    decisions: result.decisions ?? null,
    // The core's own fallback contract, crossing verbatim (D6-8). The adapter
    // does not decide when it is offered and does not compose its commands: it
    // is the driver that knows which candidates are still pending and which
    // directory it resolved them in.
    pendingDecisions: result.pendingDecisions ?? null,
    operatorApproval: result.operatorApproval ?? null,
    ...(result.blocked ? { blocked: result.blocked } : {}),
    // Read after the iteration, so the client sees where the record now stands.
    // A record the run could not reach at all has no status to report.
    state: await getMigrationStatus(await registryFor(arguments_)).catch(
      () => null,
    ),
    log: captured.join(""),
  };
};

const TOOLS = [
  {
    name: "artifact_status",
    description: "Read an artifact record and its current direct-ledger decision projection. Writes nothing.",
    inputSchema: ARTIFACT_INPUT_SCHEMA,
    call: (arguments_) => getArtifactStatus(artifactOptions(arguments_)),
  },
  {
    name: "artifact_run",
    description: "Run one artifact iteration. Pending decisions use the engine review and explicit operator APPROVE/REJECT through elicitation; tool arguments never authorize decisions.",
    inputSchema: ARTIFACT_INPUT_SCHEMA,
    sessionAware: true,
    call: async (arguments_, session) => {
      const log = [];
      const stdout = { write: (chunk) => (log.push(String(chunk)), true) };
      const previousExitCode = process.exitCode;
      try {
        const result = await runArtifact(artifactOptions(arguments_), {
          recordTrustedDecision: session?.elicitation ? trustedDecisionRecorder(session, stdout) : null,
        });
        return { ...result, log: log.join("") };
      } finally { process.exitCode = previousExitCode; }
    },
  },
  {
    name: "migration_status",
    description:
      "Read a migration record's persisted status. Writes nothing and takes no lock.",
    inputSchema: INPUT_SCHEMA,
    call: readOnly(getMigrationStatus),
  },
  {
    name: "migration_scan",
    description:
      "Recompute the discovery census the module classification is written against. Writes nothing.",
    inputSchema: INPUT_SCHEMA,
    call: readOnly(previewDiscoveryScan),
  },
  {
    name: "migration_pending_decisions",
    description:
      "List pending decisions and engine-owned reviews. STANDARD_LOCAL relays explicit APPROVE/REJECT as AGENT_RELAYED; only protected high-assurance policy requires HUMAN_ATTESTED. Legacy records retain their terminal/host interaction.",
    inputSchema: INPUT_SCHEMA,
    call: readOnly(pendingDecisionCandidates),
  },
  {
    name: "migration_run",
    description:
      "Perform one migration iteration: preflight, validate, and at most one advance. Every write happens in the core, under its existing lock and journal.",
    inputSchema: RUN_INPUT_SCHEMA,
    call: runTool,
    /** The one tool whose body may need the connection's human channel. */
    sessionAware: true,
  },
  {
    name: RELAY_TOOL,
    description:
      "Relay the operator's explicit APPROVE or REJECT, given in conversation after seeing the review of an OPERATOR_DECISION, as AGENT_RELAYED. Pass operatorApproval.reference unchanged. Never relay without the operator's explicit answer; a stale reference or a policy requiring HUMAN_ATTESTED records nothing.",
    inputSchema: RELAY_INPUT_SCHEMA,
    call: async (arguments_) => {
      const previousExitCode = process.exitCode;
      const log = [];
      try {
        const result = await relayOperatorDecision({
          ...(await registryFor(arguments_)),
          reference: arguments_.reference,
          decision: arguments_.decision,
          stdout: { write: (chunk) => (log.push(String(chunk)), true) },
        });
        return { ...result, log: log.join("") };
      } finally { process.exitCode = previousExitCode; }
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

const descriptorOf = ({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
});

const failure = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const success = (id, result) => ({ jsonrpc: "2.0", id, result });

// The CLI wrappers resolve context from cwd. Serialize the whole call, including
// elicitation and the final status read, and restore cwd even on failure.
// This also protects direct handleMessage callers; serve already queues requests.
let toolCalls = Promise.resolve();
const callTool = (id, parameters, session) => {
  const call = toolCalls.then(async () => {
    const previousCwd = process.cwd();
    try {
      const cwd = parameters?.arguments?.cwd;
      if (cwd !== undefined) {
        if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
          return failure(
            id,
            JSON_RPC_INVALID_REQUEST,
            "cwd must be an absolute directory path.",
          );
        }
        process.chdir(cwd);
      }
      return await callToolInContext(id, parameters, session);
    } catch (error) {
      return failure(id, JSON_RPC_INTERNAL_ERROR, error.message);
    } finally {
      process.chdir(previousCwd);
    }
  });
  toolCalls = call.catch(() => {});
  return call;
};

const callToolInContext = async (id, parameters, session) => {
  const name = parameters?.name;
  const module = parameters?.arguments?.module ?? "<module>";
  // A legacy refusal may name its historical recorder command. Format 19 has
  // no ID-transcription workflow, even when a caller tries an invalid tool.
  const approvalRefusal = async () => {
    if (typeof module === "string" && module !== "<module>") {
      const pending = await registryFor(parameters.arguments)
        .then(pendingDecisionCandidates).catch(() => null);
      if (pending?.decisions?.directLedger) {
        return "Format-19 decisions require an explicit APPROVE/REJECT through the engine-owned review, never a tool argument. STANDARD_LOCAL records AGENT_RELAYED; protected HUMAN_ATTESTED policy requires the optional signer.";
      }
    }
    return `Run it as an operator: ${REFUSED_TOOLS.migration_approve(module)}`;
  };
  if (Object.hasOwn(REFUSED_TOOLS, name ?? "")) {
    return failure(
      id,
      JSON_RPC_METHOD_NOT_FOUND,
      `'${name}' is not an MCP tool. ${name === "migration_approve"
        ? await approvalRefusal()
        : `Run it as an operator: ${REFUSED_TOOLS[name](module)}`}`,
    );
  }
  // The named list above covers the tools that were asked for by name. This
  // covers the ones nobody has named yet: an approval smuggled in as an
  // argument to some future tool is the same act under a different label, and a
  // list of names cannot refuse a name it has never seen. The iteration tools
  // obtain a response through elicitation, never through a tool argument.
  const smuggled = name === RELAY_TOOL ? null : approvalShapedArgument(parameters?.arguments, name);
  if (smuggled) {
    return failure(
      id,
      JSON_RPC_INVALID_REQUEST,
      `'${name}' carries an approval-shaped argument '${smuggled}'. An operator decision is never an MCP argument. ${await approvalRefusal()}`,
    );
  }
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    return failure(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool '${name}'.`);
  }
  const arguments_ = parameters?.arguments ?? {};
  for (const key of tool.inputSchema.required) {
    if (typeof arguments_[key] !== "string" || !arguments_[key]) {
      return failure(id, JSON_RPC_INVALID_REQUEST, `'${key}' is required.`);
    }
  }
  if (Object.keys(arguments_).some((key) => !Object.hasOwn(tool.inputSchema.properties, key))) {
    return failure(id, JSON_RPC_INVALID_REQUEST, "Unknown tool argument; decision results must come from the explicit operator review.");
  }
  try {
    const structuredContent = await tool.call(
      arguments_,
      tool.sessionAware ? session : undefined,
    );
    return success(id, {
      content: [
        { type: "text", text: JSON.stringify(structuredContent, null, 2) },
      ],
      structuredContent,
    });
  } catch (error) {
    return failure(id, JSON_RPC_INTERNAL_ERROR, error.message);
  }
};

/** Returns the response, or `null` for a notification. */
export const handleMessage = async (message, session = createSession()) => {
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return message?.id === undefined
      ? null
      : failure(
          message.id,
          JSON_RPC_INVALID_REQUEST,
          "Not a JSON-RPC 2.0 request.",
        );
  }
  const { id, method, params } = message;
  if (id === undefined) return null; // every notification, `initialized` included
  if (method === "initialize") {
    // `elicitation` is a *client* capability, so it is read here and never
    // declared below. Both halves must hold: the client says it can ask a
    // human, and this connection has a transport to ask over.
    session.elicitation =
      Boolean(params?.capabilities?.elicitation) &&
      typeof session.request === "function";
    return success(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
        ? params.protocolVersion
        : PROTOCOL_VERSIONS[0],
      // Still no `resources` and no `prompts`: D6-6.
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: WORKFLOW_VERSION },
    });
  }
  if (method === "ping") return success(id, {});
  if (method === "tools/list")
    return success(id, { tools: TOOLS.map(descriptorOf) });
  if (method === "tools/call") return await callTool(id, params, session);
  return failure(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method '${method}'.`);
};

const respond = async (line, session) => {
  if (!line.trim()) return null;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return failure(null, JSON_RPC_PARSE_ERROR, error.message);
  }
  return handleMessage(message, session);
};

/** A frame answering one of *our* requests: an id we issued, and no method. */
const answeredId = (line, pending) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (message?.method !== undefined) return null;
  return pending.has(message?.id) ? message : null;
};

/**
 * Newline-delimited JSON-RPC on a pair of streams. Client requests are answered
 * in arrival order: the module lock would serialize concurrent writes anyway,
 * and one chain is less code than tracking in-flight ids.
 *
 * `08` D8-4. Replies to the server's own requests are settled *off* that chain,
 * before it is extended. They have to be: the `tools/call` waiting for an
 * elicitation answer is itself the head of the chain, so queueing its answer
 * behind that call would deadlock the connection. String ids (`sm-1`) keep them
 * from ever colliding with a client's.
 */
export const serve = ({
  input = process.stdin,
  output = process.stdout,
} = {}) => {
  const lines = readline.createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const pending = new Map();
  let issued = 0;
  // ponytail: a fixed finite lifetime; no provider capability is proof that a
  // dialog renders. Late replies cannot match an expired pending request.
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `sm-${(issued += 1)}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Elicitation timed out; no decision was recorded."));
      }, ELICITATION_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  const session = createSession({ request });
  let chain = Promise.resolve();
  lines.on("line", (line) => {
    const answer = answeredId(line, pending);
    if (answer) {
      const waiter = pending.get(answer.id);
      pending.delete(answer.id);
      if (answer.error)
        waiter.reject(new Error(answer.error.message ?? "Request failed."));
      else waiter.resolve(answer.result);
      return;
    }
    chain = chain.then(async () => {
      const response = await respond(line, session);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise((resolve) => lines.on("close", resolve)).then(() => {
    // A closed connection can never answer. Rejecting beats hanging: the throw
    // travels up through `runMigration`, which reports FAILED without having
    // approved anything.
    for (const waiter of pending.values()) {
      waiter.reject(
        new Error("The client closed the connection before answering."),
      );
    }
    pending.clear();
    return chain;
  });
};

if (isMainModule(import.meta.url)) {
  serve().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = exitCodeFor("FAILED");
  });
}
