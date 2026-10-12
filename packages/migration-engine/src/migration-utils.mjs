import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { engineSkillRoot } from "./engine-paths.mjs";
import { execFileAsync } from "./shared/index.mjs";
import { projectRootFor } from "./store/index.mjs";

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

// Track A8: the transaction scan and the registry update are lifecycle-owned;
// `runDoctor` stays here because installed runtimes import it from this path.
export {
  assertNoPendingTransaction,
  pendingTransactions,
  updateRegistry,
} from "./lifecycle/index.mjs";

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
