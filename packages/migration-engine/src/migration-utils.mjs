import { constants as fsConstants } from "node:fs";
import {
  access,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  engineCommand,
  engineSkillRoot,
} from "./engine-paths.mjs";
import { withModuleLock, writeJournalAtomic } from "./module-lock.mjs";
import { execFileAsync } from "./shared/index.mjs";
import {
  atomicWrite,
  persistProjectRegistryBinding,
  previewRegistryUpdate,
  projectRootFor,
  recoverRegistryJournal,
  registryJournalPathFor,
} from "./store/index.mjs";
// Compatibility re-export (Track A5): this name is census-owned now.
export { resolveLegacySources } from "./census/index.mjs";
// Compatibility re-export (Track A2): these names are formats-owned now.
export {
  assertFigmaSource,
  assertPonytailTarget,
  DESIGN_SOURCES,
  PONYTAIL_TARGETS,
  resolveDesignSource,
} from "./formats/index.mjs";

// Compatibility re-exports: these moved to shared/ and store/ (Track A1).
// Existing importers of this file keep working; engine code imports the
// module entry instead.
export {
  assertProjectRootContainment,
  assertSafeName,
  assertSecurePath,
  commitsIntroducingBlob,
  commitsTouchingSince,
  committedChangesSince,
  CONTENT_IDENTITY_BYTES,
  CONTENT_IDENTITY_TEXT,
  contentIdentity,
  contentIdentityMatches,
  dirtyManifest,
  fileAtRevision,
  gitRevision,
  headRevision,
  isAncestorCommit,
  isContentIdentity,
  isTextIdentityEligible,
  parseContentIdentity,
} from "./shared/index.mjs";
export {
  atomicWrite,
  fileContentIdentity,
  fileContentIdentityMatches,
  persistProjectRegistryBinding,
  previewProjectRegistryBinding,
  previewRegistryUpdate,
  readRegistry,
  registryIdentity,
  renderRegistryPreview,
  resolveModule,
  resolveRegistryPath,
} from "./store/index.mjs";

/**
 * Unfinished upgrade transactions for one module. A non-DONE journal must stop
 * every normal command until deterministic recovery completes, so this lives
 * beside the shared helpers rather than inside the upgrade coordinator.
 */
export const pendingTransactions = async (targetRoot, moduleName) => {
  const root = path.join(
    targetRoot,
    ".agents/knowledge/migrations/upgrades",
    moduleName,
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const pending = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const file = path.join(directory, "transaction.json");
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const journal = JSON.parse(content);
    if (journal.state !== "DONE" && journal.state !== "ROLLED_BACK") {
      pending.push({ ...journal, file, directory });
    }
  }
  return pending;
};

export const assertNoPendingTransaction = async (targetRoot, moduleName) => {
  const [pending] = await pendingTransactions(targetRoot, moduleName);
  if (pending) {
    throw new Error(
      `An unfinished upgrade transaction exists for '${moduleName}' in state ${pending.state}. Run '${engineCommand("upgrades/upgrade-migration.mjs", moduleName, "--recover")}' before any other migration work.`,
    );
  }
};

/** @param {{ registryPath?: string, moduleName: string, target: string, aliases?: string[], confirmExecution?: string }} options */
export const updateRegistry = async ({
  registryPath,
  projectRoot,
  moduleName,
  target,
  aliases = [],
  confirmExecution,
}) => {
  const preview = await previewRegistryUpdate({
    registryPath,
    projectRoot,
    moduleName,
    target,
    aliases,
  });
  if (
    typeof confirmExecution !== "string" ||
    confirmExecution !== preview.confirmationId
  ) {
    throw new Error(
      "Registration confirmation is missing or expired. Show the current pre-execution summary and ask the user to confirm again.",
    );
  }
  // The registry is one shared file for every module, so registration takes the
  // target-owned registry lock and recomputes the document from the bytes that
  // are on disk under that lock. Two concurrent registrations of different
  // modules therefore merge; a concurrent registration that contradicts this
  // one fails validation instead of silently overwriting it.
  return withModuleLock(preview.targetRoot, "registry", async () => {
    await recoverRegistryJournal(preview.targetRoot);
    const fresh = await previewRegistryUpdate({
      registryPath,
      projectRoot,
      moduleName,
      target,
      aliases,
    });
    if (
      fresh.existingTarget !== null &&
      fresh.existingTarget !== preview.existingTarget &&
      fresh.existingTarget !== target
    ) {
      throw new Error(
        `Registration is stale: '${moduleName}' now maps to '${fresh.existingTarget}' in the registry. Preview again.`,
      );
    }
    const journalFile = registryJournalPathFor(fresh.targetRoot);
    await writeJournalAtomic(journalFile, {
      registryPath: fresh.registryPath,
      registryBefore: fresh.before,
      registryAfter: fresh.content,
      configPath: fresh.registryBinding.configPath,
      configBefore: fresh.registryBinding.before,
      configAfter: fresh.registryBinding.content,
      projectRoot: fresh.registryBinding.projectRoot,
    });
    try {
      // Registry first: a death before the binding write leaves a registry the
      // next invocation's recovery re-binds idempotently, whereas the reverse
      // order would acknowledge a mapping that is not there.
      if (fresh.changed) {
        await atomicWrite(fresh.targetRoot, fresh.registryPath, fresh.content);
      }
      await persistProjectRegistryBinding(fresh.registryBinding);
    } finally {
      await unlink(journalFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { changed: fresh.changed, moduleName, target };
  });
};

/**
 * The clean-host preflight (`--doctor`). Read-only by construction: it takes no
 * lock, opens no record, and creates no directory. The writability probe uses
 * `access(W_OK)` on a directory that already exists rather than writing a file,
 * so a host that is blocked stays byte-identical after the check.
 *
 * The engine's declared runtime is larger than "Node, Git, ripgrep": the pinned
 * discovery parser and a writable knowledge root are hard requirements, and the
 * Playwright MCP server decides whether any visible-UI slice can ever finish.
 * An operator hitting one of these should read its name here, not in a stack
 * trace three checkpoints later.
 */
const doctorCheck = async (name, requirement, probe) => {
  try {
    const detail = await probe();
    return { name, requirement, status: "OK", detail, blocking: false };
  } catch (error) {
    return {
      name,
      requirement,
      status: "BLOCKED",
      detail: error.message,
      blocking: true,
    };
  }
};

const MINIMUM_NODE_MAJOR = 20;

/** The nearest ancestor of `cwd` that already owns a migration tree. */
const existingKnowledgeRoot = async (cwd) => {
  let current = path.resolve(cwd);
  while (true) {
    try {
      await access(path.join(current, ".agents/knowledge/migrations"));
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

export const runDoctor = async ({
  targetRoot,
  skillRoot = engineSkillRoot,
  cwd = process.cwd(),
} = {}) => {
  // The repository being migrated is the one the operator is standing in, not
  // the one the engine was installed into -- externally installed, those are
  // different directories, and answering from the engine's own tree reports a
  // preflight about a repository nobody asked about.
  //
  // `--doctor` runs before registry resolution on purpose, so the target root
  // is not available: the nearest ancestor that already holds a migration tree
  // is. Failing that, the project root, and failing that the CWD -- a preflight
  // that cannot find a project still has to answer, and the knowledge-root
  // check is then the thing that says so.
  const knowledgeRoot =
    targetRoot ??
    (await existingKnowledgeRoot(cwd)) ??
    (await projectRootFor(cwd).catch(() => cwd));
  const checks = [
    await doctorCheck("node", `Node.js >= ${MINIMUM_NODE_MAJOR}`, () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
        throw new Error(
          `Node ${process.versions.node} is older than the required ${MINIMUM_NODE_MAJOR}.`,
        );
      }
      return `Node ${process.versions.node}`;
    }),
    await doctorCheck(
      "git",
      "git on PATH (the census is `git ls-files`)",
      async () => {
        const { stdout } = await execFileAsync("git", ["--version"], {
          encoding: "utf8",
        });
        return stdout.trim();
      },
    ),
    await doctorCheck(
      "discovery-parser",
      "ts-discovery-compiler resolvable from the skill",
      async () => {
        const { loadTypeScript } = await import("./census/index.mjs");
        return `ts-discovery-compiler ${loadTypeScript().version}`;
      },
    ),
    await doctorCheck(
      "knowledge-root",
      "writable .agents/knowledge/migrations/",
      async () => {
        const root = path.join(knowledgeRoot, ".agents/knowledge/migrations");
        let writable = root;
        while (true) {
          try {
            await access(writable, fsConstants.W_OK);
            return writable === root ? root : `${root} (creatable from ${writable})`;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          const parent = path.dirname(writable);
          if (parent === writable) throw new Error(`${root} has no writable ancestor`);
          writable = parent;
        }
      },
    ),
  ];

  // MCP registration is reported, never invoked: launching a browser server is
  // exactly the side effect a read-only preflight must not have.
  const mcp = await readFile(path.join(skillRoot, "../../mcp.json"), "utf8")
    .then((raw) => JSON.parse(raw).mcpServers ?? {})
    .catch(() => null);
  const servers = ["playwright", "figma", "start-migration"].map((name) => {
    const server = mcp?.[name];
    return {
      name,
      registered: Boolean(server),
      // `cmd /c` is a Windows-only launcher. VERIFY_SLICES requires Playwright
      // runtime evidence for every visible-UI slice and an unreachable runtime
      // is not a waiver, so a non-portable launcher makes those slices
      // unfinishable rather than merely awkward.
      portable: server
        ? server.type === "http" || server.command !== "cmd"
        : null,
      command: server?.command ?? server?.url ?? null,
    };
  });

  const blockers = checks.filter((check) => check.blocking);
  return {
    outcome: blockers.length > 0 ? "BLOCKED" : "OK",
    checks,
    mcpServers: servers,
    blockers: blockers.map((check) => `${check.name}: ${check.detail}`),
  };
};
