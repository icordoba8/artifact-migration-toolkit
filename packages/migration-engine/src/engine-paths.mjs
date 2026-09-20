/**
 * Where this engine actually is, resolved at runtime (R-1).
 *
 * Every operator-facing command renders through `engineCommand`, so an engine
 * installed outside the repository it migrates still prints something the
 * operator can run. `import.meta.url` is the installed location whether that is
 * a repository tree, a provider's skill directory, a plugin cache, or a global
 * toolkit checkout, so nothing here is provider-specific and no provider needs
 * to configure it.
 *
 * What this module renders is transient output only -- candidate rows, error
 * messages, MCP tool text. None of it is persisted, digested, or part of the
 * decision hash chain, so rendering a path differently cannot change a record's
 * identity, a decision digest, or a stamped format version.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Was this module run as the command?", for a module reachable by a symlink.
 *
 * Every entry point used to answer this by comparing its own
 * `import.meta.url` with `process.argv[1]`. That is correct only when the
 * operator named the file directly. A package `bin` is a symlink -- `npm`
 * links `node_modules/.bin/<name>` straight at the module -- and Node resolves
 * an ES module to its *realpath* while leaving `argv[1]` as the link the
 * operator actually typed. The two strings then disagree, the guard is false,
 * and the command exits 0 having done nothing: the worst possible failure for
 * a fail-closed CLI, because silence reads as success.
 *
 * One helper rather than nine guards: the comparison is the same question at
 * every entry point, and nine copies is eight places for the next one to be
 * written the fragile way again. It only ever widens the old answer -- a
 * direct invocation still matches on the first comparison.
 */
export const isMainModule = (moduleUrl) => {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(moduleUrl);
  const resolved = path.resolve(entry);
  if (resolved === self) return true;
  try {
    return realpathSync(resolved) === self;
  } catch {
    return false;
  }
};

/** The directory holding this engine's scripts. */
export const engineScriptsRoot = path.dirname(fileURLToPath(import.meta.url));

/** The skill directory that owns a module, given that module's `import.meta.url`. */
export const skillRootFor = (fromUrl) =>
  path.resolve(path.dirname(fileURLToPath(fromUrl)), "..");

/**
 * This engine's own skill directory.
 *
 * The single authority for "where is the engine". Nothing else in the engine
 * may walk up from its own `import.meta.url` to answer that -- a second
 * traversal is a second answer, and the one that got this wrong derived a
 * *consumer project root* from a fixed `../../../..`, which is only true when
 * the engine happens to live inside the repository it migrates.
 */
export const engineSkillRoot = path.resolve(engineScriptsRoot, "..");

/**
 * One token of a rendered command, safe to paste into the host's shell.
 *
 * The engine is installed wherever the host put it -- `C:\Users\First Last\...`
 * and `/home/user/My Tools/...` are both ordinary -- so the script path is the
 * one part of a rendered command that can carry a space, a quote, or a glob.
 * Unquoted, the operator's shell splits it and the fail-closed gate that
 * printed the command becomes unrunnable rather than merely ugly.
 *
 * `platform` is a parameter so the rule for either shell family can be asserted
 * from either host; callers never pass it.
 *
 * ponytail: quoting only, no shell-building framework. A rendered command is
 * always `node <script> <args...>` with engine-authored arguments -- validated
 * module names, decision ids, flags, `<placeholder>` prompts -- so there is no
 * redirection, pipeline, or interpolation to build.
 */
export const quoteCommandToken = (value, platform = process.platform) => {
  if (platform === "win32") {
    // `cmd` and PowerShell both take a double-quoted token literally, and `"`
    // is not a legal Windows path character, so there is nothing to escape.
    return /[\s&()[\]{}^=;!'+,`~]/.test(value) ? `"${value}"` : value;
  }
  if (!/[^\w@%+=:,./-]/.test(value)) return value;
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
};

/**
 * The argv a rendered command runs: `[<absolute script>, ...args]`.
 *
 * `engineCommand` is this, quoted and joined. Callers that *execute* rather
 * than print take the argv, so no one has to parse the rendering back apart.
 */
export const engineArgv = (script, ...args) => [
  path.join(engineScriptsRoot, ...script.split("/")),
  ...args,
];

/**
 * `node <script> <args...>`, against this engine's own installation.
 *
 * Absolute, always. A path relative to the working directory would be shorter
 * to read, but the same candidate would then render two different commands
 * depending on where the caller stood -- and these rows are compared for
 * equality: `--pending` must answer the same question the same way twice, and
 * the CLI must print what the API returned. The MCP server also chdirs into the
 * caller's repository mid-request, so an ambient base is a moving one. An
 * absolute path is the only rendering that is both runnable from anywhere and
 * identical every time -- quoted when the installation path needs it, so
 * "absolute" and "runnable" do not stop agreeing the moment a host directory
 * contains a space.
 *
 * ponytail: no environment override. `import.meta.url` is already the installed
 * location, so an override would only ever point somewhere the engine is not --
 * and an env var on the approval path is a redirect hook on a gate whose whole
 * job is to be un-bypassable. Add one only if a host proves it cannot resolve.
 *
 * @param {string} script path relative to the engine scripts directory
 */
export const engineCommand = (script, ...args) =>
  ["node", quoteCommandToken(engineArgv(script)[0]), ...args].join(" ");
