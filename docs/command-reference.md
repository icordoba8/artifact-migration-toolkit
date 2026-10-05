# Migration command reference

Run these skills from the repository being migrated. Use `migrate-artifact` for one bounded artifact; use `start-migration` for a complete feature, module, or app that needs requirements and multiple slices. Both resume from saved progress.

The examples use Claude Code slash commands. [Provider invocation](#provider-invocation) shows equivalent syntax in other hosts.

New modules use format **19** (supported: 19); standalone and delegated artifacts
use **14** (supported: 14). Standard decisions use built-in `STANDARD_LOCAL`:
review the current candidate and explicitly choose `APPROVE` or `REJECT`, relayed
as `AGENT_RELAYED` into the direct ledger. No signer, protected policy, activation
manifest, external service or authenticator is needed. Cancellation records
nothing. Auto mode never supplies a judgment decision on the operator's behalf.
Existing Module 18 and Artifact 13 records retain their explicit upgrade paths.
An optional protected high-assurance policy requires the retained WebAuthn
`HUMAN_ATTESTED` signer and fails closed without it, with no silent downgrade.

## migrate-artifact arguments

| Argument | What it does | When to use it | Default / requirement |
| --- | --- | --- | --- |
| `<primary-source>` | Identifies the source file and artifact record. | Always; for example, `src/shared/button.ts`. | **Required.** A path under the source root. |
| `--source <additional-source>` | Adds another exact source file to the artifact. Repeat for more files. | Files must migrate together as one bounded artifact. Do not use it for a whole module. | Optional; only the primary source is included by default. |
| `--type <name>` | Labels the artifact kind, such as `component` or `hook`. | A useful kind helps identify this record. | Optional; `artifact`. Use a safe lower-case, hyphenated name. |
| `--target <path>` | Sets the output path under the target root. | The target file should have a different path from the source file. | Optional; the primary source path. Cannot remap an artifact with multiple source files. |
| `--source-root <path>` | Sets the directory containing the source files. | Legacy files are in another repository or subtree. | Optional; current working directory. The directory must exist. |
| `--target-root <path>` | Sets the directory for target files and the migration record. | Output belongs in another repository or subtree. | Optional; current working directory. The directory must exist. |
| `--design-source target-system\|figma-mcp\|legacy-runtime` | Chooses the visual design authority. | Use `figma-mcp` for Figma or `legacy-runtime` for the running legacy app; otherwise use the target design system. | Optional; `target-system`. `figma-mcp` requires `--figma`. |
| `--figma <url>` | Supplies a Figma design or Make link. Repeat for multiple links. | Only with `--design-source figma-mcp`. Do not pass a link for `target-system`. | Required at least once with `figma-mcp`; otherwise omit. |
| `--ponytail full\|full-audit` | Adds a Ponytail Review, or a Review and Audit, before completion. | Use `full` for a simplification review; `full-audit` adds a whole-target audit. | Optional; disabled. **An explicit value is required** if passed. |
| `--status` | Shows saved progress without advancing or writing the record. | Check where to resume or inspect a blocker. | Optional; off. Do not combine with `--mode`, `--slice`, `--ponytail`, `--design-source`, or `--figma`. |
| `--mode auto\|step` | Chooses how execution confirmations are handled. | Use `auto` for routine continuation; use `step` to review each transition yourself. | Optional; `auto`. |
| `--slice <id>` | Selects a planned slice. | Choose a particular pending slice when the plan allows it. Do not use it to skip dependencies. | Optional; the active or next slice. |
| `--json` | Prints the structured outcome as JSON. | An integration needs machine-readable output. | Optional; normal human-readable output. `--status` already prints JSON. |

## start-migration arguments

| Argument | What it does | When to use it | Default / requirement |
| --- | --- | --- | --- |
| `<module>` | Identifies the migration. With `--legacy`, it names the **target** module; without it, it names the single legacy module. | Always; for example, `auth`. | **Required.** |
| `--registry <path>` | Selects the target project's migration registry. | First setup when the project has no saved registry binding. Do not use it to override an existing binding. | Optional when already configured; accepted only before a binding or migration state exists. |
| `--target <target-module>` | Maps the migration to its target feature/module name. | First setup of an unregistered mapping, especially when the names differ. | Required for an unregistered single-legacy mapping. With `--legacy`, `<module>` supplies the target; an existing mapping supplies its saved target. Conflicts are rejected. |
| `--legacy <module>` | Adds a legacy source module; repeat to merge several sources into one target. | Several legacy modules converge on one target. Do not use it to change the source set after bootstrap. | Optional; without it, `<module>` is the sole legacy source. |
| `--adopt-target` | Records a baseline of substantial implementation already in the target. | Migration starts with an existing target feature that should be assessed and preserved. | Optional; off. Requires `src/features/<target>/` to exist. |
| `--mock` | Uses mock data as the migration's data-source mode. | The target workflow is intentionally built against mock data. | Optional; standard data mode. Set at bootstrap; the choice persists on resume. |
| `--brief <path>` | Loads a written migration brief from the target repository. | Existing scope or requirements should guide the migration. | Optional; no brief. The file is bound at bootstrap and must remain unchanged. |
| `--design-source target-system\|figma-mcp\|legacy-runtime` | Chooses the visual design authority. | Use `figma-mcp` for Figma or `legacy-runtime` for the running legacy app; otherwise use the target design system. | Optional; `target-system`. Set at bootstrap and fixed for this migration. |
| `--figma <url>` | Supplies a Figma design or Make link. Repeat for multiple links. | Only with `--design-source figma-mcp`. Do not pass a link for `target-system`. | Required at least once with `figma-mcp`; otherwise omit. |
| `--ponytail [full\|full-audit]` | Adds a Ponytail Review, or a Review and Audit, before completion. | Use `full` for a simplification review; `full-audit` adds a whole-target audit. | Optional; disabled. A bare `--ponytail` means `full`. |
| `--mode auto\|step` | Chooses how execution confirmations are handled. | Use `auto` for routine continuation; use `step` to review each transition yourself. | Optional; `auto`. |
| `--slice <id>` | Selects an active or pending planned slice. | Continue a particular slice when its dependencies are satisfied. | Optional; the active or next slice. |
| `--json` | Prints the structured run outcome as JSON. | An integration needs machine-readable output. | Optional; normal human-readable output. |
| `--status` | Requests the module's read-only status operation. | Inspect progress before starting or resuming. | Optional; use alone with `<module>`. The normal `artifact-migration-run` command does **not** accept it. |

## Important argument relationships

### Design authority

- **`--design-source target-system`:** The target project's design system controls visuals. Use it for the usual migration or when there is no Figma authority. It is the default; do not add `--figma`.
- **`--design-source figma-mcp` and `--figma`:** Figma controls visual and UX intent. Use them together when the design is authoritative. Supply at least one `/design/` or `/make/` link; repeat `--figma` for more links. FigJam and Slides links are not accepted. The host needs a connected Figma MCP to obtain design evidence.
- **`--design-source legacy-runtime`:** The running legacy app controls visual appearance. Capture its required UI states as legacy-runtime evidence; do not add `--figma`.
- **Legacy and Figma:** Legacy remains authoritative for behavior, routes, business rules, permissions, and the content those flows require. Figma guides layout, visual states, and copy as designed; the target supplies architecture and design-system components. Use this combination when the new UI should follow Figma without dropping legacy behavior. For `start-migration`, the design-source choice is fixed at bootstrap; omit it on resume to keep the saved choice.

### Ponytail and execution

- **`--ponytail full` versus `full-audit`:** `full` applies Ponytail during implementation and requires a Review before completion. `full-audit` also requires an Audit after verification and before pre-commit review. Choose `full-audit` when you want the broader audit. Both are opt-in and persist in the record; a session-level Ponytail setting does not enable them. The flag does not install a companion Ponytail skill.
- **Bare `--ponytail`:** `migrate-artifact` rejects it; pass `full` or `full-audit`. `start-migration` still accepts it as `full`. Use an explicit value when you want the choice to be clear.
- **`--mode auto` versus `--mode step`:** `auto` (the default) confirms routine, evidence-backed transitions and continues when the workflow says to continue. It can still stop for an ambiguous decision or blocker. `step` stops for explicit confirmation at each transition and leaves the operator in control of each iteration. Use `step` when you want to review progress one transition at a time.
- **`--slice` with execution mode:** A slice ID selects planned work; it never skips prerequisites or verification. Use it when choosing among eligible pending slices. `auto` or `step` still governs how the selected work advances.
- **`--status`:** Status reads saved progress without advancing it. Use it to check the next checkpoint or blocker. For `start-migration`, the skill uses the status operation (`migration_status` or `artifact-migration-discover <module> --status`); `artifact-migration-run` rejects `--status`.

### Sources and targets

- **`--source-root` and `--target-root`:** Both default to the current directory. Set them when artifact source and target live in different directories. Source paths are resolved under the source root; target paths and the saved record are under the target root.
- **Multiple `--source` files:** The primary source and every additional file form one exact artifact. Use repeated `--source` for files that must move together. Their target paths must match the source paths; `--target` cannot remap a multi-file artifact.
- **Multiple `--legacy` modules:** Each flag adds one legacy module to the same target migration. Use them when several old modules converge on one new module. The positional `<module>` then names the target; the source set is fixed after bootstrap.
- **`--target` has two meanings:** In `migrate-artifact` it is a target **file path**; in `start-migration` it is a target **module name**. Use the artifact form to relocate one file and the module form to establish an unregistered mapping.
- **Bootstrap choices:** `--mock`, `--design-source`, `--legacy`, and `--adopt-target` describe the migration being started; an existing record keeps its saved choices. `--registry` establishes a project binding only on first setup. Use these when starting the record, then resume with the module name.

## Common examples

These use Claude Code syntax. Replace the paths, module names, and Figma URL with your own. `start-migration` examples assume a configured registry unless `--target` is shown.

| Goal | Example |
| --- | --- |
| Migrate one artifact | `/migrate-artifact src/shared/button.ts` |
| Choose an explicit target file path | `/migrate-artifact src/shared/button.ts --target src/ui/button.ts` |
| Use auto mode explicitly | `/migrate-artifact src/shared/button.ts --mode auto` |
| Review each transition in step mode | `/migrate-artifact src/shared/button.ts --mode step` |
| Add Ponytail Review | `/migrate-artifact src/shared/button.ts --ponytail full` |
| Add Ponytail Review and Audit | `/migrate-artifact src/shared/button.ts --ponytail full-audit` |
| Use the target design system for visuals | `/migrate-artifact src/shared/button.ts --design-source target-system` |
| Use Figma for visuals | `/migrate-artifact src/shared/button.ts --design-source figma-mcp --figma https://www.figma.com/design/AbCdEf123456/Example?node-id=1-2` |
| Check artifact status | `/migrate-artifact src/shared/button.ts --status` |
| Start a complete module migration | `/start-migration auth --target identity` |
| Check module status | `/start-migration auth --status` |

For one target fed by two legacy modules:

```text
/start-migration identity --legacy auth --legacy users --target identity
```

For a module migration that follows Figma visuals:

```text
/start-migration auth --target identity --design-source figma-mcp --figma https://www.figma.com/design/AbCdEf123456/Example?node-id=1-2
```

## Advanced recovery operations

Recovery switches such as `--refresh`, `--reopen-discovery`, and `--reopen-ui` belong to the separate `artifact-migration-discover` operator command. They are not ordinary `start-migration` run arguments. Use them only when the engine reports the matching recovery need.

## Provider invocation

The argument contract above is the same in each provider. Only the way you invoke an installed skill changes.

| Provider | Artifact example | Module example |
| --- | --- | --- |
| Claude Code | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` |
| Codex | `Use the migrate-artifact skill for src/shared/button.ts` | `Start migration auth using the start-migration skill` |
| OpenCode | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` |
| GitHub Copilot | `/migrate-artifact src/shared/button.ts` | `/start-migration auth` in a supported IDE agent chat |

Append the arguments from the tables to the slash command. In Codex, state them in the chat instruction, for example: `Use the migrate-artifact skill for src/shared/button.ts with --mode step`.
