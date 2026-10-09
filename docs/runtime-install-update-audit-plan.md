# Runtime install / update / identity audit — plan

Status: **PLAN_READY_CORRECTED — correction round 1/1 applied. Awaiting final
approval. Do not implement until approved.**
Audit date: 2026-10-06. Correction date: 2026-10-06.
Repository HEAD: `f313d19` (v1.3.8). Scope: install / update /
runtime-selection lifecycle only.

> **Correction round 1/1 summary.** The first plan chose *“the installed skill's
> SemVer is the runtime authority”* and claimed that `skill.version ==
> runtime.version` makes drift unrepresentable. **That was wrong and is
> corrected throughout.** `skills add <repository>` installs *current `main`
> bytes* stamped with whatever `package.json` says, so a skill can carry
> `version: "1.3.8"` while differing byte-for-byte from the published, immutable
> v1.3.8 — the same defect class, re-entered through the fix. The authority is
> now the installed skill's **exact release-compatible identity** (§9), built
> from identity material that already exists: the canonical skill
> `computedHash` from `skills-lock.json`, which `scripts/release.mjs:413`
> already embeds in every release manifest and `providers/install-support.mjs:323`
> already persists on every receipt. Sections rewritten: 1, 5, 6, 7, 9, 10, 11,
> 14, 17, 18, 19, 20, 21, 22, 23. Sections preserved unchanged: 2, 3, 4, 8, 12,
> 13, 15, 16. Every superseded claim is listed in **§6.1**.

---

## 1. Executive verdict

**IMPLEMENTATION_DEFECT in the selection contract, not in the installer.**

`ensureRuntime()` has no notion of *which toolkit release this skill belongs
to*. It has only two inputs that can select a version: an explicit
`--version`, and the mutable GitHub `latest` endpoint — and the latter is
consulted **only when no receipt exists**. The consequence is that the first
successful install permanently decides the runtime version for that consumer,
for every provider, forever, with no user-visible decision and no path back
other than hand-deleting `.artifact-migration-toolkit/`.

The fix is not a new updater, a staleness check, a network poll, or a new
identity system. The authoritative material is already present, already
released, and already persisted — it is simply never *compared*:

| Fact | Where it already exists | Read by selection today |
|---|---|---|
| Canonical per-skill digest over `skills/<name>/**` | `skills-lock.json` `skills.<name>.computedHash`, written by `scripts/skills-lock.mjs:93-116` | no |
| That same digest, inside every immutable release | `release-manifest.json` `skills` — `scripts/release.mjs:413` embeds the whole `skills-lock.json` | no |
| That same digest, on every provider receipt | `receipt.skills` — `providers/install-support.mjs:323` already writes `skills: manifest.skills` | no |
| Which release an installed skill belongs to | `release-identity.json` `{name, version, skill, source}` (+`commit`, `contentHash` when `source: "release"`) | no |

The corrected architecture closes the loop by making the installed skill carry
its own canonical `computedHash` and requiring the selected runtime's immutable
release manifest to *prove* that same digest (§9). SemVer selects a candidate;
the digest decides whether it is acceptable. **A matching version with a
mismatching skill digest is rejected, not reused.**

Normal operation then needs **less** network than today, not more:
`/releases/latest` leaves the normal path entirely, `ensureRuntime` always
resolves an exact tag, and the steady state — a receipt whose `skills`
document already proves the installed skill's digest — is fully offline.

Severity: high. It is reproducible, it is live in a real consumer, and it
silently pairs v1.3.8 skill semantics with a v1.3.4 and a v1.2.6 engine in the
same repository.

**This defect cannot be fixed without publishing a new release.** The fix spans
the skill-side bootstrap *and* the release-side adapter, and the adapter is
loaded **from the selected release** (`runtime-bootstrap.mjs:136`). Expected
next version: **v1.3.9** (§20.2). No release is performed by this plan.

---

## 2. Confirmed root cause

*(Unchanged by the correction.)*

`scripts/runtime-bootstrap.mjs:275-277`:

```js
if (previous && (!version || previous.toolkit?.version === version)) {
  return result(previous, { bootstrapped: false }, await localPreflight(previous));
}
```

Read precisely:

- `previous` is the parsed `.artifact-migration-toolkit/<provider>.json`.
- `version` is `--version` / `ARTIFACT_MIGRATION_TOOLS_VERSION`, else `undefined`.
- For a normal invocation `version` is `undefined`, so `!version` is `true`.
- Therefore **any** existing, locally-validatable receipt short-circuits
  selection. `resolveRelease()` (line 290) is unreachable. No release
  discovery, no comparison, no `bootstrapped: true`, no receipt write.

The only reachable update paths in the whole file are:

1. `version` is given **and** differs from `previous.toolkit.version`
   (line 275 falls through → line 290 `resolve(version)` → `action: 'update'`).
2. No receipt at all (first install, or the directory was deleted).

There is no third path. `action: 'update'` exists in
`providers/install-support.mjs:253` and works correctly — including MCP
convergence — but **nothing in the normal user flow ever asks for it.**

The deeper contract defect behind the branch: the installed skill and the
installed runtime are two independently versioned artifacts with two different
owners (`skills add` owns one, `ensureRuntime` owns the other) and **no
declared, verifiable relationship between them**. The branch above is where
that missing relationship becomes an observable bug. The correction round
established the stronger form of the same statement: a relationship expressed
in SemVer alone is not verifiable, because `skills add <repository>` can
install arbitrary `main` bytes under an already-published version string.

---

## 3. Real consumer evidence

*(Unchanged by the correction.)*

Read-only inspection of `C:\Users\icordoba\Desktop\wms-milla7`
(WSL view `/mnt/c/Users/icordoba/Desktop/wms-milla7`). Nothing was modified.
No secrets are reproduced here.

### 3.1 Installed skills — all five provider surfaces

Every installed `start-migration` / `migrate-artifact` carries:

```json
{ "name": "artifact-migration-tools", "version": "1.3.8",
  "skill": "start-migration", "source": "repository" }
```

Locations: `.claude/skills/`, `.codex/skills/`, `.agents/skills/`,
`.github/skills/`, `.opencode/skills/`.

Every installed `scripts/runtime.mjs` is **byte-identical** to repo HEAD
`scripts/runtime-bootstrap.mjs`
(`sha256 aea196ab97c7dc73187707f10d75caceab2957b565f9bc5912f7d2a058bb8586`).

→ The skill layer is fully current at **1.3.8**.

**Correction note.** `source: "repository"` and the absence of `commit` /
`contentHash` are exactly the gap the correction identified: these ten files
prove the skills came from the *repository tree*, not from the published
v1.3.8 release artifact. At this HEAD the two happen to coincide
(`released-versions.json` establishes 1.3.8 and the tree is clean), but nothing
in the installed files proves it, and no code checks it. Under the corrected
architecture these files would carry `computedHash` and that coincidence
becomes a verified fact instead of an assumption.

### 3.2 Provider receipts — `.artifact-migration-toolkit/`

Only two receipts exist; no `copilot.json`, no `opencode.json`;
no `install.lock` present (no interrupted install).

| field | `claude.json` | `codex.json` |
|---|---|---|
| provider | claude | codex |
| scope / mode | project / **runtime** | project / **runtime** |
| root | `C:\Users\icordoba\Desktop\wms-milla7` | same |
| store | `C:\Users\icordoba\AppData\Local\artifact-migration-tools` | same |
| toolkit.version | **1.3.4** | **1.2.6** |
| toolkit.commit | `b83b76d39ae8c56a3286cab76fa916d4c9dc37ba` | `aa76c886eb6ae54188979716f65907ca3db4fe8e` |
| toolkit.contentHash | `sha256:2737533475…92ba2` | `sha256:a9a8c63787…1ec8f` |
| pin | `sha256:fa11e027bb…9a4eb` | `sha256:ccd52b9fb4…2c51a` |
| release path | `…\1.3.4-fa11e027bb…` | `…\1.2.6-ccd52b9fb4…` |
| retained `releases[]` | 1.2.2, 1.2.3, 1.2.4, 1.2.5, 1.2.6, **1.3.4** | **1.2.6** only |
| `files` (owned skill files) | `{}` (runtime mode) | `{}` (runtime mode) |
| commands | 10 absolute bins under the 1.3.4 release | 10 absolute bins under the 1.2.6 release |
| `configOwned` | `.mcp.json` JSON object → 1.3.4 path | TOML block → **1.2.6** path |
| **`skills`** | **present** — the 1.3.4 `skills-lock.json` document | **present** — the 1.2.6 `skills-lock.json` document |

The `skills` row is the correction's key enabler: **the exact per-skill digest
of the installed runtime is already on the receipt**, written by
`install-support.mjs:323`, verified offline via the pinned manifest, and read by
nothing. No new receipt field is needed to carry runtime-side skill identity.

### 3.3 Runtime store — `C:\Users\icordoba\AppData\Local\artifact-migration-tools`

Seven extracted releases present: `1.2.1`, `1.2.2`, `1.2.3`, `1.2.4`, `1.2.5`,
`1.2.6`, `1.3.4`. For each, `release-manifest.json` `toolkit` and
`packages/migration-engine/build-identity.json` agree exactly (verified:
version + commit + contentHash identical in both files, all seven).

**No `1.3.8` runtime exists in the store.** Current stable release is v1.3.8
(`released-versions.json`, `package.json`).

### 3.4 Provider MCP registrations

| file | `start-migration` entry | points at |
|---|---|---|
| `.mcp.json` (claude) | present | **1.3.4** engine `mcp-server.mjs` |
| `.vscode/mcp.json` (copilot) | **absent** | — (playwright only) |
| `.codex/config.toml` (codex) | **absent** — header says *“Generated by pnpm agents:sync. Edit the canonical source in .agents instead.”* | — (playwright only) |
| `opencode.json` | **absent** | — (playwright only) |
| `.agents/mcp.json` | **absent** (playwright only, `targets: [claude, codex, copilot, opencode]`) | — |

### 3.5 Migration records

`C:\Users\icordoba\Desktop\wms-milla7\.agents\knowledge\migrations` does not
exist. **No migration records; no `toolkitIdentity` is at risk in this
consumer today.** Section 13 is therefore forward-looking, not remedial.

### 3.6 What the evidence proves

1. **The confirmed defect is real and live.** Skill 1.3.8 + receipt 1.3.4 +
   engine 1.3.4 + MCP absolute path 1.3.4, with v1.3.8 published and not
   installed. The reported banner `Preflight OK (toolkit 1.3.4, …)` is the
   `claude` receipt reused through line 275.
2. **It is worse than reported: it is per-provider.** `codex` is pinned four
   minor-patch generations further back, at 1.2.6. Two different engines are
   addressable from one repository depending only on which provider the user
   launches.
3. **A second, independent live failure is already armed.** `codex.json`
   claims ownership of a TOML block that `.codex/config.toml` no longer
   contains (a consumer tool, `pnpm agents:sync`, regenerated the file). The
   next `/start-migration` under codex reaches `localPreflight` →
   `adapterRun(action: 'doctor')` → `mergeConfig(..., missing: true)` →
   `replace(configFile, merged.bytes)` and **writes a 1.2.6 absolute engine
   path back into the consumer's config in 2026**, reporting `mcpRepair`.
   Drift case C/I, observed, not hypothetical.
4. **A third live failure blocks a new provider outright.** A first
   `/start-migration` under `copilot` or `opencode` in this consumer has no
   receipt → `siblingSelection()` → it reads `claude.json` (1.3.4) and
   `codex.json` (1.2.6), builds two distinct identities, and
   `runtime-bootstrap.mjs:197` throws *“Sibling … receipts disagree on the
   installed toolkit identity; reinstall or remove the conflicting providers
   explicitly.”* The only documented escape is manual receipt deletion —
   explicitly forbidden as normal operation.
5. **The authority the design needs is already on disk and already ignored.**
   All ten installed `release-identity.json` files say `1.3.8`.
   `grep -rn release-identity scripts/ providers/*.mjs` returns **no hit in
   `runtime-bootstrap.mjs` or `install-support.mjs`** — only
   `scripts/skills-lock.mjs` (writes it), `scripts/release.mjs:315-327`
   (restamps it with `source: "release"` + commit + contentHash), and two
   tests. Selection never reads it.
6. **The exact-identity material is also already on disk and also ignored.**
   `release-manifest.json.skills` is the whole `skills-lock.json` document
   (`release.mjs:413`); `receipt.skills` is a copy of it
   (`install-support.mjs:323`); and `release-identity.json` is **byte-verbatim
   across all eight provider projections** (verified by `diff`, §9.3). The
   only missing piece is that `identityDocument()`
   (`skills-lock.mjs:50-64`) does not include the skill's own `computedHash`.

---

## 4. Current end-to-end flow (executable trace)

*(Unchanged by the correction.)*

```
/start-migration (SKILL.md "Runtime preflight")
  └─ node <installed-skill>/scripts/runtime.mjs ensure --provider P --root R
       = scripts/runtime-bootstrap.mjs :: main() :312
          └─ ensureRuntime({provider,root,store,version}) :251
             ├─ normalize provider via PROVIDERS map                       :255
             ├─ version ??= env ARTIFACT_MIGRATION_TOOLS_VERSION           :257
             ├─ root/store = path.resolve(...)   store default = defaultStore() :130
             ├─ read R/.artifact-migration-toolkit/P.json  -> `previous`     :263
             ├─ identity guard: provider/root/store must match             :265
             │
             ├─[A] previous && (!version || previous.version === version)  :275  ◀── ROOT CAUSE
             │     └─ localPreflight(previous) :236
             │        ├─ validateReceiptLauncher -> pinnedToolkit          :147
             │        │     • manifest bytes sha256 == receipt.pin
             │        │     • release path == store/<version>-<pinhex>
             │        │     • providers/install-support.mjs hash == manifest
             │        │     • toolkit identity deep-equals receipt.toolkit
             │        │     ✗ receipt.skills is NEVER compared to anything
             │        ├─ adapterRun(P, receipt.release, {action:'doctor'})
             │        │     → install-support.adapter() :367  [takes install.lock]
             │        │     → applyAdapter :243
             │        │        · validateSelection(previous)               :221
             │        │        · verifyBundle(release, pin)  (every file)  :45
             │        │        · owned-file digests re-checked             :263
             │        │        · mergeConfig(...) missing|stale -> REPAIR  :270-283
             │        └─ engine runDoctor({cwd: root})
             │     RETURN { bootstrapped:false, toolkit: <RECEIPT VERSION> }
             │     *** no network, no release discovery, no comparison ***
             │
             ├─[B] !previous -> siblingSelection({provider,root,store,version}) :177
             │     · scan R/.artifact-migration-toolkit/*.json for other providers
             │     · candidate = {receipt.release, receipt.pin}
             │       + receipt.releases[] ONLY IF an explicit `version` was given :189
             │     · each candidate re-verified through pinnedToolkit
             │     · filter by `version` only if given                      :192
             │     · >1 distinct identity -> THROW (fail closed)            :197
             │     └─ hit: adapterRun(P, sibling.release, {action:'install', runtimeOnly:true})
             │        RETURN { bootstrapped:true, reusedFrom: <sibling> }
             │
             └─[C] resolve(version)  ->  resolveRelease :85
                   • version given  -> /releases/tags/v<version>
                   • version absent -> /releases/latest        ◀── only `latest` consumer
                   • reject draft / prerelease / non-immutable / !=1 digest asset
                   • tagCommit() resolves annotated tags to one commit sha
                   -> downloadAsset (gh release download | fetch) + digest check :100
                   -> extractArchive (tar -tzf safety scan, then -xzf)           :120
                   -> manifest.toolkit must match {name, resolved.version, resolved.commit} :298
                   -> adapterRun(P, bundle, { action: previous ? 'update' : 'install',
                                              pin: sha256(manifestBytes),
                                              runtimeOnly: previous ? previous.mode==='runtime' : true })
                      → applyAdapter :243 — ONE lock, ONE backup set:
                        · verifyBundle(bundle,pin); adapter.toolkit == manifest.toolkit
                        · release = store/<version>-<pinhex>
                        · commands/mcp/server computed from the NEW release
                        · receipt.skills = manifest.skills      ◀── written, never read
                        · receipt.releases = [...old minus this release, {release,pin}]
                        · mergeConfig(raw, layout, previous.configOwned, NEW server, historical)
                        · stage store copy (checksum-owned files only) -> rename
                        · write owned files, config, agents, receipt  (try/catch -> restore backups)
                   RETURN { bootstrapped:true }
```

Two callers share this file verbatim — `skills/start-migration/scripts/runtime.mjs`
and `skills/migrate-artifact/scripts/runtime.mjs`, plus the four generated
`providers/*/skills/*/scripts/runtime.mjs` copies. All **ten** copies are
byte-identical (verified). A single-file fix therefore propagates to every
provider via `pnpm providers:sync`.

**Note the second loaded artifact.** Line 136,
`adapterRun → import(<release>/providers/install-support.mjs)`, loads the
adapter **from the selected release**, not from the skill. The fix therefore has
two halves that must ship together in one release (§20.2).

---

## 5. Identity / authority model

Corrected: rows 1, 2, 5, 6 now distinguish **SemVer** from **exact skill
identity**, and row 9 is new.

| # | Identity | Authoritative source | Identity fields | Creator | Updater | Validator | Lifecycle | Can drift? | Consequence of drift |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Canonical skill source | `skills/<name>/` in this repo | `skills-lock.json` `skills.<name>.computedHash` = sha256 over `(path, bytes)` of every file under `skills/<name>/**` (`skills-lock.mjs:93-103`); `release-identity.json` `{name, version, skill, source:"repository"}` | authors | `pnpm skills:lock` (version read from root `package.json`) | `release.mjs:259-267` byte-compares the committed stamp against a freshly generated one | per commit | n/a | n/a |
| 2 | Installed skill | consumer `.claude/skills/…`, `.github/skills/…`, `.codex/skills/…`, `.opencode/skills/…`, `.agents/skills/…` | `release-identity.json` `{name, version, skill, source}` (+`commit`,`contentHash` when `source:"release"`). **Today it carries NO digest of its own bytes** | `skills add` (Agent Skills CLI) — or the adapter in `mode:"provider"` | `skills add` | **nobody** | user-driven | **yes, in two independent dimensions** | (a) version advances while the runtime does not — the reported defect; (b) **bytes advance while the version does not** — `skills add <repo>` installs current `main` under an already-published version string. **(b) is what the correction adds.** |
| 3 | Runtime bootstrap script | `scripts/runtime-bootstrap.mjs`, copied to all ten skill `scripts/runtime.mjs` | file sha256 | `pnpm providers:sync` | same | `runtime-bootstrap.test.mjs:171` ("one shared bootstrap source") | ships inside #2, and is covered by #2's `computedHash` | no (locked to #2) | n/a |
| 4 | Immutable GitHub Release | `github.com/icordoba8/artifact-migration-toolkit` releases | tag `vX.Y.Z`, tag commit sha, one asset + `digest`, `immutable:true` | `scripts/release.mjs` + CI | never (immutable) | `resolveRelease()` :85 | permanent | no | n/a |
| 5 | Extracted runtime store | `<store>/<version>-<pinhex>/` | `release-manifest.json`: `toolkit{name,version,commit,contentHash}`, **`skills` = the whole `skills-lock.json`** (`release.mjs:413`), `files{}`; plus `SHA256SUMS`, `packages/migration-engine/build-identity.json` | `applyAdapter` staging+rename :341-348 | never rewritten in place (new version = new directory) | `verifyBundle()` :45 (every file), `pinnedToolkit()` :147 | append-only, never GC'd | only by tampering | `verifyBundle` fails closed |
| 6 | Provider receipt | `<root>/.artifact-migration-toolkit/<provider>.json` | `provider, scope, mode, root, store, toolkit{}, **skills**, release, pin, commands{}, mcp{}, configOwned, files{}, releases[]` | `applyAdapter` :323 | `applyAdapter` on install/update/rollback | `validateSelection` :221 + `pinnedToolkit` :147. **`skills` is written but never validated or compared** | per provider per consumer; **never expires** | **yes — this is the stale pin** | Reused forever (§2) |
| 7 | Provider MCP registration | `.mcp.json` / `.vscode/mcp.json` / `.codex/config.toml` / `opencode.json` (+`.agents/mcp.json`) | absolute `node` + absolute `<release>/packages/migration-engine/src/mcp-server.mjs` | `mergeConfig` :137 / `mergeAgents` :179 | same, on every install/update/rollback/doctor | `mergeConfig` ownership check against `receipt.configOwned` + `historicalOwned` | follows #6 inside one lock | **yes** — consumer tooling regenerates the file (observed, §3.4) | `doctor` restores it **from the receipt**, i.e. restores the *stale* path (§3.6.3) |
| 8 | Migration record `toolkitIdentity` | `.agents/knowledge/migrations/**` record JSON | `{name, version, commit, contentHash}` | engine on record creation / `toolkit-identity.mjs adopt` | **only** explicit `adopt` / `update` / `rollback` | `toolkitIdentityStatus()` → `UNSTAMPED`/`MATCH`/`MISMATCH`/`UNIDENTIFIED_TOOLKIT`; `autoAdoptableToolkitTransition()` | per record, independent of #6 | yes, by design | `MISMATCH` reported read-only; fail-closed gates apply. **Correct as built — do not touch.** |
| 9 | **Skill↔release binding (new, §9)** | the pair `(installed release-identity.json, selected release-manifest.json.skills)` | required: `{skill, version, computedHash}` (+`commit`,`contentHash` when `source:"release"`); proven by: `manifest.skills.skills[skill].computedHash` | `skills-lock.mjs` (requirement side), `release.mjs` (proof side) — **both already exist; only the requirement side needs the digest added** | neither — it is a relation, not a stored artifact | **`ensureRuntime` (new)** | evaluated on every invocation | **no — it is the thing that makes drift detectable** | A mismatch is a typed, fail-closed error, never a silent reuse |

**Authority summary.** Today there are *two* independent version authorities
(#2 via `skills add`, #6 via first-install-wins) and *no* rule relating them —
and #2 is not even self-describing, because it carries no digest of its own
bytes. The corrected architecture introduces #9: one relation, verified on every
invocation, built entirely from material #1/#5/#6 already carry.

---

## 6. Contract contradictions

| # | Source | Claim | Executable truth | Verdict |
|---|---|---|---|---|
| C1 | `README.md:107-112` | “On first use … resolves the latest stable immutable GitHub Release … Later invocations validate and reuse that receipt without network access.” | Accurate, and silent on what happens when the skill is later updated. The doc describes a *cache*; users read it as a *lifecycle*. | **DOCUMENTATION_GAP** (not false) |
| C2 | `SKILL.md` “Runtime preflight” | “This preflight is **the only normal runtime installer**: it reuses a valid pinned receipt …, reuses a verified runtime another provider already installed …, **or installs the latest stable** immutable GitHub Release.” | The three branches are ordered, and branch 1 unconditionally wins. “The only normal runtime installer” is true and is exactly the problem: it is the only installer and it can never update. | **DESIGNED_BUT_SURPRISING** |
| C3 | `README.md:116-118` | “The explicit provider installer … remains available for local bundles, **updates and rollback**; it is not the normal skill-install UX.” | Confirms update is an *out-of-band admin action*. A normal user has no update path at all. | **CONTRADICTS the stated product requirement** |
| C4 | `SKILL.md` | “`--version X.Y.Z` … are explicit admin/CI overrides.” | True, and today it is the only way a normal user can escape a stale pin — which the no-rework rule forbids recommending. | **AMBIGUOUS_CONTRACT** |
| C5 | `scripts/skills-lock.mjs:30-58` doc comment | `release-identity.json` exists so “an operator [can] tell the two apart in an installed tree **without running the engine**.” | It is written, released, re-stamped, and tested — then read by nothing in the selection path. The file's stated purpose is diagnostic; its available purpose is authoritative. | **UNUSED AUTHORITY** |
| **C6** | `release.mjs:413` + `install-support.mjs:323` | The per-skill canonical digest is embedded in every release manifest and copied onto every receipt. | **Never compared to anything.** `validateSelection` (`:221-241`) checks release path, bundle, toolkit, commands, mcp, configOwned and files — and skips `skills` entirely. A hand-edited `receipt.skills` is not even detected. | **UNUSED PROOF** (new) |
| **C7** | `skills-lock.mjs:35-49` doc comment | The committed stamp exists so a `skills add` install cannot “name the wrong release”, and `release.mjs` gates it by byte-comparison. | The gate only proves *version* agreement between the stamp and `package.json`. It cannot and does not prove that the installed bytes correspond to a *published* release — `skills add <repo>` installs `main` at any time, published or not. | **INSUFFICIENT GUARANTEE** (new) |

**Classification of the reported defect (Question 2):** **IMPLEMENTATION_DEFECT.**
The reuse branch is designed and documented (C1/C2), but the system promises
“one coherent lifecycle … these layers must not silently drift”, ships a
version authority it declines to consult (C5), and ships an exact proof it
declines to compare (C6). The observable behavior — a 1.3.8 skill durably
driving a 1.2.6 engine with no user decision and no non-manual exit — is the
unhandled interaction of two independently-updated artifacts.

### 6.1 Claims from plan v1 that this correction supersedes

Listed explicitly so no superseded reasoning survives anywhere in the document.

| Plan-v1 claim | Status | Corrected statement |
|---|---|---|
| “makes that file the single **version** authority” (§1) | **SUPERSEDED** | `release-identity.json` is the single **exact-identity** authority: version *selects*, `computedHash` *proves*. |
| “the steady state (receipt version == skill version) is fully offline” (§1) | **SUPERSEDED** | Steady state is “receipt's `skills` document proves the installed skill's required digest”, which is likewise fully offline. |
| “the runtime version **is** the skill version” (§9) | **SUPERSEDED** | The runtime release must *prove* the installed skill's exact canonical digest. Equal versions are necessary, never sufficient. |
| “the split state is unrepresentable **because versions match**” (§9) | **SUPERSEDED** | The split state is *detectable and rejected* because the digest must match. Equal-version/different-bytes was precisely the hole. |
| “release discipline makes [same-version identity conflict] unreachable in practice” (§11) | **SUPERSEDED** | `release-version-discipline.test.mjs` + `released-versions.json` protect *published* version↔contentHash reuse. They say nothing about arbitrary `main` bytes carrying an already-published version string. That case is now an explicit, tested, fail-closed path (case B, §10.2). |
| “`release-version-discipline.test.mjs` … is what makes ‘same version ⇒ same identity’ true” (§18.1) | **SUPERSEDED** | It makes *“same published version ⇒ same published identity”* true. Installed-repository-skill identity is proven by the `computedHash` comparison, not by version discipline. |
| “Not changed, deliberately: `scripts/release.mjs`, `scripts/skills-lock.mjs`” (§17) | **SUPERSEDED** | `scripts/skills-lock.mjs` **must** change (carry the digest in the stamp; exclude the stamp from the digest). `scripts/release.mjs` **must** change (one added release gate). §17. |
| “`--version` … writes `pinned` … subsequent normal invocations stay on it” (§10 G) | **SUPERSEDED** | `--version` is a **one-invocation** override and persists no intent (§10.3). Only `rollback` persists a pin. |
| “A `pinned` receipt … honoured indefinitely” (§8/§10) | **SUPERSEDED** | A rollback pin records the skill identity it was taken against and is superseded when the installed skill's identity changes (§10.3). |
| Step 8: “install the updated skill; run `/start-migration` … verify” (§20) | **SUPERSEDED** | A new skill paired with the published v1.3.8 release would load v1.3.8's adapter and prove nothing. The proof requires a staged candidate, then **v1.3.9** (§20.2). |

---

## 7. Complete drift / failure matrix

Classification under **current** behavior. “Target” = behavior after §9.
Rows N and O are new in this correction.

| | Scenario | Current behavior (traced) | Class | Target |
|---|---|---|---|---|
| **A** | Current skill + stale provider receipt | `:275` reuses the receipt forever | **BUG** | Converge to the release that proves the skill's identity |
| **B** | Current skill + stale runtime store dir | Same branch; stale engine executes; `verifyBundle` passes (it is a *valid* old release) | **BUG** | Converge |
| **C** | Current skill + stale MCP absolute path | `doctor` *restores* the stale path from `receipt.configOwned` when the config was regenerated (**observed live, §3.6.3**) | **BUG** | Update rewrites MCP in the same lock; repair then restores the current path |
| **D** | One provider current, another stale | Independent receipts, zero cross-check on the normal path (**observed: claude 1.3.4, codex 1.2.6**) | **BUG** | Every provider converges to the one release the skill requires |
| **E** | Provider switch adopts an older sibling | `siblingSelection` has **no** version filter unless `--version` is passed (`:192`); a brand-new provider silently adopts whatever the oldest sibling has | **BUG** | Siblings are always filtered by required **exact identity**, not version |
| **F** | Receipt current + runtime files tampered | `verifyBundle` re-hashes every manifest file on every `doctor`; `pinnedToolkit` re-hashes the manifest and `install-support.mjs` | **SAFE** | unchanged |
| **G** | Receipt current + runtime directory missing | `pinnedToolkit` `readFile(release-manifest.json)` → ENOENT → throws; **no recovery**, user must delete the receipt | **BUG** (fails closed but needs manual repair) | ENOENT on the pinned release is reclassified as *absent*, not *invalid*: reinstall the same immutable release |
| **H** | Interrupted runtime update | `install.lock` (`open(…,'wx')`) survives the crash; every later run throws *“Installation locked…”*. **Normal recovery requires deleting a lock file by hand.** Data is safe (staging+rename, backup restore) | **BUG** (correctly fail-closed, incorrectly unrecoverable) | Lock carries owner pid + start time; a lock with no live owner is reclaimed once, after re-validating the receipt |
| **I** | Update succeeds, MCP stays old | **Cannot happen inside `applyAdapter`** (§12). The reverse is also prevented by the same backup-restore | **SAFE** — but unreachable, because no normal path ever runs `update` | unchanged mechanism, now actually reachable |
| **J** | Explicit `--version`, then a normal invocation | `:275` — `!version` is true → the pinned version is reused. Indistinguishable from the stale-receipt bug | **AMBIGUOUS_CONTRACT** | `--version` is one-invocation; the next normal invocation converges back and says so (§10.3) |
| **K** | Rollback, then a normal invocation | Same branch, same ambiguity. Rollback has no way to say “stay here” | **AMBIGUOUS_CONTRACT** | Rollback persists `pinned{by:"rollback", againstSkill}`; it sticks, is reported every invocation, and is superseded only by a skill-identity change |
| **L** | New runtime + record pinned to older toolkit | `toolkitIdentityStatus` → `MISMATCH`, read-only; `status` never writes; `autoAdoptableToolkitTransition` returns a *suggestion* | **SAFE** | unchanged — out of scope for runtime selection |
| **M** | Windows-native and WSL invocation of one consumer | See §15 | **REAL_RISK** (latent) | Unchanged mechanism; one added diagnostic |
| **N** | **Same SemVer, different skill bytes** — `skills add <repo>` after v1.3.8 was published, `package.json` still `1.3.8` | `release-identity.json` says `1.3.8`; nothing compares bytes; **plan v1 would have accepted the published v1.3.8 release as a match.** New skill semantics against the old engine, silently | **BUG** (introduced by plan v1; latent in HEAD) | `computedHash` differs from `manifest.skills.skills[skill].computedHash` → typed `SKILL_IDENTITY_UNRELEASED`, fail closed (§10.2 case B) |
| **O** | **SemVer bumped, release not yet published** — `package.json` at `1.3.9`, no v1.3.9 release | No path reaches release resolution at all on a normal invocation; on a fresh consumer it resolves `latest` = v1.3.8 and **silently pairs a 1.3.9 skill with a 1.3.8 engine** | **BUG** | `resolveRelease('1.3.9')` → tag 404 → typed `RELEASE_NOT_PUBLISHED`, fail closed, nothing written (§10.2 case C) |

---

## 8. Receipt responsibility analysis

*(Unchanged by the correction, except the final field list.)*

`.artifact-migration-toolkit/<provider>.json` currently carries **seven**
responsibilities:

| Responsibility | Fields | Correct? |
|---|---|---|
| Installed-runtime state | `release`, `pin`, `toolkit`, `commands`, `skills` | ✔ yes |
| Provider ownership receipt | `provider`, `scope`, `mode`, `root`, `store`, `files{}` | ✔ yes |
| MCP ownership state | `mcp`, `configOwned` | ✔ yes — `configOwned` holds *exact bytes/object we wrote*, which is what makes byte-exact removal and conflict detection possible |
| Rollback history | `releases[]` | ✔ yes |
| Cache metadata | implicit: “this release is extracted and verified at this path” | ✔ yes (derivable, cheap to re-verify) |
| Runtime-side **exact skill identity** | `skills` (the release's whole `skills-lock.json`) | ✔ **present and sufficient** — but never validated (C6) |
| **Version pin / rollback intent** | *none* — inferred from `toolkit.version` | ✘ **conflated** |

**Finding:** the receipt is not overloaded; it is **under-specified in exactly
one dimension**. Six of the seven roles are coherent, co-located, and
co-validated inside one lock — splitting them would require multi-file
atomicity for no benefit. The single missing field is *intent*: the receipt
records which version is installed but not **why**, so “the user rolled back to
1.3.4” and “1.3.4 is merely what was latest the first time” are byte-identical
states.

**Decision: do not split the file.** Add two optional fields:

```jsonc
// Set ONLY by an explicit `rollback`. Absent => convergeable.
"pinned": {
  "version": "1.3.4",
  "by": "rollback",
  "at": "<ISO-8601>",
  // The skill identity this rollback was a decision about. When the installed
  // skill's identity changes, the user has taken a newer deliberate action and
  // the pin is superseded -- a rollback is not an eternal veto.
  "againstSkill": { "skill": "start-migration", "computedHash": "<hex>" }
},

// Which installed skill identities this selection has satisfied. Lets an
// incoherent skill set (one skill updated, the other not) be detected and
// refused instead of flip-flopping the runtime per invocation.
"requiredBy": { "start-migration": "<hex>", "migrate-artifact": "<hex>" }
```

Both absent ⇒ not pinned, nothing recorded ⇒ convergeable. Backward compatible
by construction (§19).

---

## 9. Chosen target architecture

### The one architecture: **the installed skill's exact release-compatible identity determines the runtime.**

> **Authority order:** explicit intentional pin (rollback) **>** exact
> installed-skill/release identity **>** supported development path
> (`--version`, one invocation only).
>
> There is no SemVer-only authority and no `latest` authority on the normal
> path.

### 9.1 The required identity, and why it is the smallest robust one

The installed skill must answer: *“Which immutable toolkit release contains
exactly the canonical skill semantics I am currently executing?”*

**Required identity (carried by the installed skill):**

```jsonc
// <installed-skill>/release-identity.json
{
  "name": "artifact-migration-tools",
  "version": "1.3.9",              // selects the candidate release (exact tag)
  "skill": "start-migration",
  "computedHash": "<64 hex>",      // ◀ ADDED: the canonical digest, the proof
  "source": "repository" | "release",
  "commit": "<40 hex>",            // present only when source === "release"
  "contentHash": "sha256:<64 hex>" //   "       "    "      "        "
}
```

**Proof (carried by the immutable release, already):**

```jsonc
// <release>/release-manifest.json      (bytes pinned by receipt.pin)
"skills": { "version": 1, "skills": {
  "start-migration":  { "skillPath": "skills/start-migration",  "computedHash": "<64 hex>" },
  "migrate-artifact": { "skillPath": "skills/migrate-artifact", "computedHash": "<64 hex>" }
}}
```

**Acceptance predicate** — a release `R` satisfies installed skill `S` iff all
hold:

1. `R.manifest.toolkit.name === S.name`
2. `R.manifest.toolkit.version === S.version`
3. `R.manifest.skills.skills[S.skill].computedHash === S.computedHash`
4. if `S.source === "release"`: `R.manifest.toolkit.commit === S.commit`
   **and** `R.manifest.toolkit.contentHash === S.contentHash`

(1)–(2) select; (3) proves; (4) strengthens to full byte identity when the skill
came from a release artifact. **(3) is mandatory in every case.** Rule 2 without
rule 3 is exactly the hole this correction closes.

**Why this is the smallest robust identity available:**

| Candidate | Verdict |
|---|---|
| SemVer only | **Insufficient** — the defect the correction identifies (case N). |
| Toolkit `contentHash` only | Unavailable: a `source:"repository"` skill cannot carry it (acyclic — `release.mjs:10-24`: contentHash's inputs include `skills/**`, so a committed file cannot contain the hash it feeds). |
| Git `commit` only | Same acyclicity bar, same reason (`skills-lock.mjs:44-48`). |
| Re-hash the installed skill's own bytes at runtime | **Impossible by design.** `install-support.mjs:314-320` renders `{{ENGINE_MCP_ENTRY}}` and every CLI name into absolute paths, and `providers-sync.mjs` rewrites provider frontmatter. Installed bytes legitimately differ per provider and per install path. The identity must be *carried*, not recomputed. |
| **Canonical skill `computedHash`** | **CHOSEN.** Already computed (`skills-lock.mjs:93`), already released (`release.mjs:413`), already on every receipt (`install-support.mjs:323`), already gated at release time (`release.mjs:259-267` byte-compares the stamp), and **already byte-verbatim across all eight provider projections** (§9.3). Provider-independent, acyclic, offline-verifiable, one string per skill. |

### 9.2 The one cycle to break, and how

`computeSkillHash` currently walks **all** of `skills/<name>/**`, which
includes `release-identity.json`. Putting the digest *into* that file would be a
cycle. `writeSkillsLock` dodges it today by writing the stamp first and hashing
after — which is why the stamp can contain the version but not the digest.

**Fix: exclude `release-identity.json` from `computeSkillHash`.** Then:

```
computedHash(name)       = H( skills/<name>/** \ {release-identity.json} )
release-identity.json    = { …, computedHash: computedHash(name) }
skills-lock.json         = { version:1, skills:{ name:{ skillPath, computedHash(name) } } }
contentHash              = H( payloadPaths )          # includes both of the above
```

No file is an input to itself, at any layer. Verified against
`release.mjs:10-24` (contentHash acyclicity contract) and
`release.mjs:315-327` (staged restamp is `{...committed, source, commit,
contentHash}`, so `computedHash` propagates into released copies with **zero**
change to `release.mjs`'s stamping logic).

Two deliberate consequences, both correct:

- The digest no longer changes when only the version string changes. A release
  that touches only the engine leaves `computedHash` stable, so predicate (3)
  still holds across it — correct, because the *skill semantics really are
  identical*, and predicate (2) still forces the engine to be the one the skill
  names.
- The digest now covers exactly “skill semantics”: `SKILL.md`, `references/**`,
  `scripts/runtime.mjs`. This matches the file's own stated purpose
  (`skills-lock.mjs:12-15`: *“What it is NOT is engine identity”*).

### 9.3 Provider projection — verified

`release-identity.json` must survive provider projection without depending on
provider-specific rendered bytes. Verified by `diff` at HEAD:

```
providers/claude/skills/{start-migration,migrate-artifact}   VERBATIM
providers/codex/skills/{start-migration,migrate-artifact}    VERBATIM
providers/copilot/skills/{start-migration,migrate-artifact}  VERBATIM
providers/opencode/skills/{start-migration,migrate-artifact} VERBATIM
```

All eight projections are byte-identical to the canonical
`skills/<name>/release-identity.json`. `providers-sync.mjs` rewrites
provider frontmatter in `SKILL.md`; `install-support.mjs:309-320` renders
`{{ENGINE_MCP_ENTRY}}` and CLI names — and `release-identity.json` is excluded
from both because it is neither a frontmatter carrier nor a template. One new
test (T19) locks this invariant so a future projection change cannot silently
break the binding.

### 9.4 Why this architecture, over the five alternatives

| Option | Verdict |
|---|---|
| 1. Resolve latest on every invocation | **Rejected.** Makes every migration network-dependent; violates the infrastructure constraint; makes a mutable endpoint the authority; a release published mid-migration changes the engine under a running workflow. |
| 2. Permanent pin until an explicit update command | **Rejected.** Today's behavior plus a command. The user must know a stale state exists in order to fix it — the knowledge the product requirement forbids requiring. |
| 3. Bind the installed skill to one immutable release **by SemVer** | **Rejected by this correction.** Case N: `skills add <repo>` installs current `main` under an already-published version string, so SemVer equality proves nothing about bytes. |
| 3′. **Bind the installed skill to one immutable release by exact canonical skill identity** | **CHOSEN.** §9.1. |
| 4. Online latest check with verified offline fallback | **Rejected.** Needs a staleness policy, a check cadence, a cached-latest file and a last-checked timestamp — four new pieces of mutable state — and still leaves `latest` as authority. Strictly more complex and less deterministic. |
| 5. Something simpler found in the code | **This is 3′.** Every piece of the proof already exists and ships; the gap is one field in `identityDocument()` and one comparison in selection. |

### 9.5 Why it satisfies every constraint

- **Deterministic:** `(rollback pin, installed skill identity, explicit
  override)` is a total ordering onto exactly one immutable release tag, plus a
  digest equality that either holds or does not. No clock, no `latest`, no
  ordering ambiguity.
- **No silent split, in either dimension:** version drift and byte drift are
  both detected. A mismatch is a typed error, never a reuse.
- **Less network, not more:** steady state makes zero requests;
  `ensureRuntime` resolves only exact tags; `/releases/latest` is no longer
  reachable from it at all.
- **Immutable verification unchanged:** tag commit, asset digest,
  `verifyBundle`, `pinnedToolkit` are untouched. The digest comparison is
  *added* to them, never a substitute.
- **Offline continuity strengthened:** four *local* sources are consulted
  before any network call, each filtered by the full acceptance predicate —
  and the predicate is checkable offline, because `receipt.skills` and the
  pinned `release-manifest.json` already carry the proof.
- **Provider convergence is free:** all providers read the same required
  identity, so all converge to one release. Sibling disagreement on *different*
  versions stops being an error (which unblocks the live consumer, §3.6.4).
- **Rollback deterministic, overrides non-persistent:** §10.3.
- **One updater:** every write still goes through `adapter(provider, …)`.
- **Skill update is the user's explicit update action.** `skills add` remains
  the sole owner of skill install/update, and now that one action
  deterministically and *verifiably* governs the whole stack.

### 9.6 `ensureRuntime()` — final decision order

```
ensureRuntime({ provider, root = cwd, store = defaultStore(), version }, deps):

  # ---- 0. normalize (unchanged) -------------------------------------------
  provider := PROVIDERS[provider]                        or FAIL
  version  := version ?? env ARTIFACT_MIGRATION_TOOLS_VERSION
  if version given and not exactVersion(version): FAIL
  root, store := path.resolve(...)
  previous := read(root/.artifact-migration-toolkit/<provider>.json) or null
  if previous and (provider|root|store mismatch): FAIL  # enriched message, §15

  # ---- 1. authority: pin > exact skill identity > development override ----
  skill := deps.skillRelease()     # ../release-identity.json next to this script
                                   # -> { name, version, skill, computedHash,
                                   #      source, commit?, contentHash? } | null

  if version given:
      # DEVELOPMENT / ADMIN / CI PATH. One invocation only. Persists no intent.
      # Deliberately BYPASSES the skill-identity predicate -- this is the
      # defined escape for an unreleased or identity-less skill (cases B/C/E).
      require := { version, exact: null, reason: "explicit",
                   skillIdentity: "unverified" }

  elif previous?.pinned and pinStillValid(previous.pinned, skill):
      # pinStillValid: pinned.againstSkill.computedHash === skill?.computedHash
      # A rollback is a decision about the skill in place at the time. A newer
      # skill identity is a newer deliberate action and supersedes it.
      require := { version: previous.pinned.version, exact: null,
                   reason: "pinned", skillIdentity: "pinned" }

  elif skill is null:
      FAIL typed SKILL_IDENTITY_MISSING                               # case E
        # "This skill carries no release-identity.json, so the toolkit release
        #  containing its semantics cannot be determined. Reinstall the skill
        #  with `skills add`, or select a release explicitly with --version."

  elif skill.computedHash is absent:
      FAIL typed SKILL_IDENTITY_LEGACY                     # pre-v1.3.9 stamp
        # "This skill predates exact identity binding. Reinstall it with
        #  `skills add` to adopt it, or select a release with --version."

  else:
      require := { version: skill.version, exact: skill, reason: "skill",
                   skillIdentity: "required" }                     # ◀ NORMAL

  # ---- 2. the acceptance predicate (§9.1), offline-checkable --------------
  satisfies(manifest) :=
        manifest.toolkit.name    == "artifact-migration-tools"
    and manifest.toolkit.version == require.version
    and ( require.exact is null
          or ( manifest.skills.skills[require.exact.skill].computedHash
                 == require.exact.computedHash
               and ( require.exact.source != "release"
                     or ( manifest.toolkit.commit      == require.exact.commit
                      and manifest.toolkit.contentHash == require.exact.contentHash ))))

  # Incoherent skill set: another installed skill already pinned this receipt
  # to a release that cannot satisfy THIS skill. Flip-flopping the runtime per
  # invocation is the worst outcome; refuse and name both.
  if previous?.requiredBy and require.exact
     and conflictsWith(previous.requiredBy, require.exact, previous):
         FAIL typed SKILL_SET_INCOHERENT   # names both skills and both digests
           # "Install both skills from the same release (`skills add` each)."

  # ---- 3. local sources, strongest first. NO network in this whole block. --
  # Every candidate is verified by pinnedToolkit() (manifest bytes == pin,
  # path == store/<version>-<pinhex>, install-support.mjs hash == manifest)
  # AND THEN by satisfies(its manifest).

  if previous and satisfies(manifestOf(previous)) and verifies(previous):
      return reuse(previous, { bootstrapped: false, selection: require.reason,
                               network: false })

  local := firstAccepted([
      previous ? fromHistory(previous.releases, store) : [],   # rollback history
      fromSiblings(root, store, provider),                     # sibling receipts
      fromStore(store, require.version),                       # shared store scan
  ])                                        # each filtered by satisfies()

  if local:
      receipt := adapter(provider, {
          action: previous ? "update" : "install",
          provider, scope: "project", root, store,
          bundle: local.release, pin: local.pin,
          runtimeOnly: previous ? previous.mode == "runtime" : true,
          pinned: carryPin(previous, require),      # rollback pins only
          requiredBy: recordRequirement(previous, require.exact),
      })
      # one lock; receipt + MCP config + owned files converge or all roll back
      return reuse(receipt, { bootstrapped: true, reusedFrom: local.origin,
                              selection: require.reason, network: false })

  # ---- 4. network, only now. Always an EXACT tag; never /releases/latest. --
  try:
      resolved := deps.resolve(require.version)        # /releases/tags/vX.Y.Z
  catch notFound:                                                   # case C
      FAIL typed RELEASE_NOT_PUBLISHED
        { required: require.version, skill: require.exact?.skill,
          detail: "no immutable release carries this skill's version",
          receipt: "unchanged" }
  catch networkError:
      if previous and verifies(previous):                     # offline, stale
          FAIL typed RUNTIME_UPDATE_REQUIRED_OFFLINE
            { installed: previous.toolkit.version, required: require.version,
              reason: require.reason, detail: "<network error>",
              receipt: "unchanged" }
      FAIL original networkError            # nothing installed, nothing to keep

  download -> digest-verify -> extract -> safety-scan
  assert manifest.toolkit == { name, resolved.version, resolved.commit }   # :298
  if not satisfies(manifest):                                       # case B
      FAIL typed SKILL_IDENTITY_UNRELEASED
        { skill: require.exact.skill, required: require.exact.computedHash,
          releaseProves: manifest.skills.skills[require.exact.skill]?.computedHash,
          version: require.version, receipt: "unchanged" }
        # "The installed skill's semantics are not the semantics published in
        #  v<version>. Reinstall the skill from a published release, or select a
        #  release explicitly with --version."

  receipt := adapter(provider, {
      action: previous ? "update" : "install",
      provider, scope: "project", root, store, bundle, pin: sha256(manifestBytes),
      runtimeOnly: previous ? previous.mode == "runtime" : true,
      pinned: carryPin(previous, require),
      requiredBy: recordRequirement(previous, require.exact),
  })
  return reuse(receipt, { bootstrapped: true, selection: require.reason,
                          network: true })


# migration-record identity is NOT touched anywhere above.
# ensureRuntime neither reads nor writes any record's toolkitIdentity.
```

Four structural invariants:

- **I1 — single updater.** Every write to a receipt, a provider config or the
  store goes through exactly one call site: `adapter(provider, …)`. Steps 3 and
  4 differ only in where the verified bundle came from.
- **I2 — network is last, and always exact.** Steps 0–3 are pure local I/O.
  `ensureRuntime` never calls `/releases/latest`.
- **I3 — no migration-record mutation.** No code path reaches
  `.agents/knowledge/migrations`.
- **I4 — no acceptance without proof.** Every reuse and every install passes
  `satisfies()`. The only predicate bypass is an explicit `--version`, which is
  one-invocation and labelled `skillIdentity: "unverified"` in the result.

---

## 10. Exact semantics

`selection` ∈ `"skill" | "pinned" | "explicit"`. `skillIdentity` ∈
`"required" | "pinned" | "unverified"`. `network` is a boolean. All three are
new fields on the returned JSON and are printed by the preflight.

### 10.1 Cases A–K (original question set)

| | Case | Behavior | Network | Receipt write | Output |
|---|---|---|---|---|---|
| **A** | First invocation, online | Resolve tag `v<skill.version>`; **verify `satisfies()`**; install; register MCP; both doctors | yes | create | `bootstrapped:true, selection:"skill", network:true` |
| **B** | First invocation, offline | History → siblings → store scan, each filtered by `satisfies()`. Hit ⇒ install from the verified local copy. Miss ⇒ the original network error (nothing to preserve) | no, or fails | create, or none | `bootstrapped:true, reusedFrom:…` or hard failure |
| **C** | Existing runtime satisfies the skill, online | `previous` passes `satisfies()` ⇒ reuse immediately. **Zero requests**, exactly as today | no | none | `bootstrapped:false, selection:"skill"` |
| **D** | Existing runtime satisfies the skill, offline | Identical to C — the path never reaches the network | no | none | `bootstrapped:false` |
| **E** | Existing runtime does **not** satisfy, online | Local sources first; else resolve `v<skill.version>`, verify, `action:'update'` ⇒ receipt + MCP + commands converge atomically. Old release stays in `releases[]` and on disk | yes (unless local hit) | update | `bootstrapped:true, selection:"skill"` |
| **F** | Existing runtime does **not** satisfy, offline | Local sources first. **Hit ⇒ converge offline.** **Miss ⇒ `RUNTIME_UPDATE_REQUIRED_OFFLINE`**, non-zero exit, receipt/store/config byte-identical | attempted, fails | **none** | typed error naming installed + required |
| **G** | `--version X.Y.Z` / env | **One invocation only.** Resolves that exact release, bypasses the identity predicate, reports `skillIdentity:"unverified"`, **persists no intent**. The runtime and MCP do change on disk (they must), so the next normal invocation converges back and says so | only if needed | create/update | `selection:"explicit", skillIdentity:"unverified"` |
| **H** | Provider switch | The new provider derives the same required identity. Siblings are filtered by `satisfies()`: a satisfying sibling is reused offline, a non-satisfying one is ignored (not a conflict). Two *distinct* satisfying identities still fail closed | only if no local copy | create | `bootstrapped:true, reusedFrom:"<sibling>"` |
| **I** | Explicit rollback (`providers/<p>/install.mjs rollback`) | Requires the release in `releases[]` (unchanged, `install-support.mjs:296`). **Persists `pinned{version, by:"rollback", at, againstSkill}`** ⇒ sticks across normal invocations, reported every time as `selection:"pinned"`, superseded when the installed skill's `computedHash` changes | no | update | `selection:"pinned"` |
| **J** | Skill updated while receipt/runtime is old | **This is E (online) / F (offline).** A skill update changes the required identity; it is never a steady state | per E/F | per E/F | per E/F |
| **K** | Existing record pinned to an older toolkit identity | **`ensureRuntime` does nothing.** Not read, not written. `artifact-migration-toolkit status` still reports `MISMATCH` read-only; convergence stays an explicit `adopt`/`update`/`rollback` (§13) | n/a | n/a | unchanged |

### 10.2 Cases A–E (repository-source question set — new)

The decisive set. `S` = installed `release-identity.json`, `R` = the release at
tag `v<S.version>`.

| | Case | Detection | Behavior | State written |
|---|---|---|---|---|
| **A** | **Repository skill bytes correspond exactly to a published immutable release.** `source:"repository"`, `S.version == R.version`, `S.computedHash == R.manifest.skills.skills[S.skill].computedHash` | predicate (1)–(3) hold; (4) not applicable | **Proceed.** Install/reuse normally. `selection:"skill"`, `skillIdentity:"required"`. This is the normal, expected, dominant case — and it is the case the live consumer is in at HEAD | receipt (if it changed) |
| **B** | **Repository skill changed after that release; SemVer not yet bumped.** `S.version == R.version` but digests differ | predicate (3) **fails** | **FAIL CLOSED**, typed `SKILL_IDENTITY_UNRELEASED`, naming the skill, the required digest, the digest the release proves, and the version. **Never paired with the older release.** Remedies, both first-class, no JSON editing: (i) `skills add` from a published release; (ii) `--version X.Y.Z` as the one-invocation development override | **nothing** — receipt, store, every provider config byte-identical |
| **C** | **SemVer bumped; that release is not yet published.** `package.json`/`S.version` = `1.3.9`, no v1.3.9 release | `resolveRelease('1.3.9')` → tag 404 | **FAIL CLOSED**, typed `RELEASE_NOT_PUBLISHED`, naming the required version. **Never falls back to `latest`, never to the previous version.** Same two remedies as B | **nothing** |
| **D** | **Released skill source carries exact commit/contentHash.** `source:"release"` | predicate (1)–(4), all four | **Proceed** under the strongest binding: version + skill digest + toolkit commit + toolkit contentHash. A release artifact's skill can only ever run on the exact release it came from | receipt (if it changed) |
| **E** | **Hand-copied / identity-less skill.** no `release-identity.json`, or it has no `computedHash` (a pre-v1.3.9 stamp) | `skillRelease()` → `null`, or `computedHash` absent | **FAIL CLOSED**, typed `SKILL_IDENTITY_MISSING` / `SKILL_IDENTITY_LEGACY`. **No `latest` fallback** — an unverifiable skill driving an arbitrary release is the defect class itself. Remedies: `skills add` (adopts identity), `--version` (one invocation), or the documented local-bundle installer `providers/<p>/install.mjs` for checkout development | **nothing** |

**Noted behavior change.** Case E means a bare repo checkout can no longer run
`node scripts/runtime-bootstrap.mjs ensure` with no arguments and get `latest`.
That path is replaced by two supported ones that already exist: `--version
X.Y.Z`, or `providers/<p>/install.mjs install --bundle <local>`. `/releases/latest`
becomes unreachable from `ensureRuntime` — `resolveRelease`'s `latest` branch
stays as a library function and keeps its existing coverage
(`runtime-bootstrap.test.mjs:178`).

### 10.3 Explicit override vs. persistent pin (re-evaluated)

Plan v1 persisted `--version` as a pin. **Reversed.** The correction's
instruction is correct: intent must not be persisted merely to simplify the
state machine, and existing user semantics must be preserved unless the
confirmed defect requires a change.

| | One-invocation exact override | Persistent pin |
|---|---|---|
| Trigger | `--version X.Y.Z` on the preflight, or `ARTIFACT_MIGRATION_TOOLS_VERSION` | `providers/<p>/install.mjs rollback` — an explicit, separate, deliberate command |
| Documented as | “explicit admin/CI overrides” (`SKILL.md`, `README.md:114-118`) — **unchanged** | “updates and rollback … not the normal skill-install UX” (`README.md:116-118`) — **unchanged** |
| Persists intent? | **No.** Nothing written to `pinned` | **Yes.** `pinned{version, by:"rollback", at, againstSkill}` |
| Next normal invocation | Converges back to the skill's required identity, reporting `bootstrapped:true, selection:"skill"` | Stays, reporting `selection:"pinned"` every single time |
| Why | An env var or a single CLI flag is a statement about *this* run. A CI job that wants a version passes it every run — that is what CI does. Letting a one-off flag silently govern a human's later interactive runs is the same class of invisible state as the defect being fixed. | Rollback is meaningless if the next normal invocation immediately undoes it. Determinism here is a stated requirement. It is loud (reported every invocation), scoped (see below), and recoverable. |
| Scope / release | — | `againstSkill` records the skill identity the rollback was a decision *about*. When the installed skill's `computedHash` changes, the user has taken a newer deliberate action (`skills add`) and the pin is **superseded**, not honoured. A rollback is a decision, not an eternal veto — and this is also how a pin is cleared, with no new command and no JSON editing. |

Justification for keeping *any* persistence, as required: it attaches
**only** to `rollback`, which is already an explicit out-of-band admin command
with no other way to express “stay here”; it is reported on every invocation so
it can never be silent; and it self-clears on the user's next deliberate skill
action. Both environment-variable and single-CLI-flag overrides remain
non-persistent, exactly as documented today.

### 10.4 Completeness

Decision input is the 4-tuple `(explicit --version?, valid rollback pin?,
installed skill identity state, local/network availability)`. Step 1 is a total
ordering over the first three — including both degenerate identity states
(`null`, and present-but-legacy) — and steps 3–4 a total ordering over the
fourth, with every failure typed. **No undefined case.**

**Deliberate strictness, case F and §10.2 B/C/E.** These fail closed rather
than warn-and-continue. Rationale: a newer `SKILL.md` instructs the agent in
protocol semantics an older engine does not implement, so continuing produces a
wrong migration — worse than a stop. Every stop is loud, typed, names both
sides, leaves all state untouched, and has at least two first-class remedies
that are existing documented commands. This is the same fail-closed posture the
toolkit already takes on tampering, conflicting MCP config, and
`validateSelection` conflicts. Flagged as the plan's most reviewable decision.

---

## 11. Provider convergence rules

`siblingSelection()` (`runtime-bootstrap.mjs:177`) becomes `fromSiblings()`
with two changes:

1. **Filter by the full `satisfies()` predicate**, not by `version` and not only
   when `--version` was given. Today the filter is
   `if (version && toolkit.version !== version) continue;` (`:192`) with
   `version` normally `undefined` — which is what lets a new provider silently
   adopt an older sibling (case E).
2. **Always consider `receipt.releases[]`**, not only when `--version` was given
   (`:189`). With the predicate always applied, retained releases are a safe
   extra source of the *exact* required identity and can never downgrade.

A sibling candidate's proof is read from **its own pinned
`release-manifest.json`** (via the existing `pinnedToolkit`), not from the
sibling receipt's `skills` copy — the manifest is the release-pinned artifact.
`receipt.skills` is additionally asserted equal to it by the new
`validateSelection` check (§17 #2), so a hand-edited receipt cannot fake the
binding either way.

| Sibling state | Behavior |
|---|---|
| Sibling satisfies the required identity | Reuse offline. `reusedFrom: <provider>` |
| Siblings agree with each other but **do not satisfy** the requirement | **Not candidates.** Ignored silently (they are other releases). The requirement is met from history/store/network |
| Siblings differ from each other, none satisfies | Ignored. **No error** — this is what unblocks the live consumer (§3.6.4) |
| Siblings differ, exactly one satisfies | That one is reused |
| **Same version, different skill `computedHash`** | **Not a candidate.** Rejected by `satisfies()` before any identity comparison. This is the new case-N guard at the sibling boundary |
| Two siblings satisfy with **different** `{commit, contentHash, pin}` | **FAIL CLOSED** — `"Sibling receipts disagree on the installed toolkit identity"`, preserved verbatim. Possible only under tampering or a release-discipline breach; retained as a tripwire, not relied on as a version guard |
| Sibling retains the required release in `releases[]` | Valid candidate, verified identically |
| Sibling has a rollback `pinned` | **Irrelevant.** Pins are per-receipt intent and are **never inherited across providers** |
| Sibling `release` path missing or fails `pinnedToolkit` | Skipped (already `try/catch continue` at `:191`) |
| Sibling on a **newer** release than required | Not a candidate. The installed skill's identity is authority; a sibling being ahead does not drag this provider forward |

All four providers — Claude, Codex, OpenCode, GitHub Copilot — run the identical
`ensureRuntime` (all ten `runtime.mjs` copies byte-identical, verified §3.1) and
differ only in `layouts[provider]` (`install-support.mjs:11-16`) and
`serverFor()` shape (`:86`). **No provider-specific logic is added.**

---

## 12. MCP update / atomicity rules

*(Unchanged by the correction.)*

**Proof that update already converges MCP** (`applyAdapter`, `install-support.mjs`):

- `:295` `release` is computed from the **new** manifest.
- `:299-301` `commands`, `mcp`, `server` are computed from the **new** release.
- `:326` `mergeConfig(rawConfig, layout, previous.configOwned, NEW server, historical)`
  removes exactly the previous owned bytes/object and writes the new one.
- `:328` `receipt.configOwned = merged.owned` — the receipt records what was
  just written.
- `:351-361` `writes` → `replace(configFile)` → `replace(agentsFile)` →
  `replace(receiptFile)` in one `try`; the `catch` restores **every** backed-up
  file (`:330-335` captured owned files, the config, `.agents/mcp.json`, and the
  receipt before any write).
- `:367-379` the whole thing is inside one `install.lock` per consumer root.

**Therefore no sequence produces `receipt = new, MCP = old` or the reverse** —
*provided `action: 'update'` runs at all*. The defect is that it never does on
the normal path. Case I in §7 is `SAFE`-but-unreachable, and §9 makes it
reachable. **No new atomicity machinery is required.**

Two gaps that §9 closes as a side effect:

- **Stale-path restoration (live, §3.6.3).** `doctor` restores
  `previous.configOwned`, which is correct *for the installed version*. Under
  §9 the receipt reaches `doctor` already converged, so a restored path is
  always the current one. The `doctor` logic itself is unchanged.
- **Post-write verification.** After a successful `update`, `ensureRuntime`
  calls `localPreflight(receipt)` → `adapterRun(action:'doctor')`, which
  re-reads the config and compares against the **new** `configOwned`. A stale
  absolute path surviving an update would be reported as `missing`/`modified`
  on the very same invocation. One assertion is added to make the acceptance
  criterion explicit: after any `bootstrapped:true`, no file this toolkit owns
  may contain a path under a non-selected store release directory.

---

## 13. Existing migration record identity rules

*(Unchanged by the correction.)*

**Rule: `ensureRuntime` never reads and never writes any migration record's
`toolkitIdentity`.** This is invariant I3 (§9.6) and it is already true today —
the plan preserves it, it does not extend it.

Behavior when `runtime = newer release` and `record.toolkitIdentity = older`:

| Command | Behavior | Change |
|---|---|---|
| `artifact-migration-toolkit status` | Read-only. Reports `toolkitIdentityStatus(recorded, active)` → `MISMATCH`, plus `autoAdoptableToolkitTransition` → `"update"` as a **suggestion**. Never writes, on any record, in any state (`toolkit-identity.mjs:13`) | **none** |
| `… adopt` | Explicit, user-invoked. Stamps an `UNSTAMPED` record | **none** |
| `… update` | Explicit, user-invoked. Moves a record forward to the active identity | **none** |
| `… rollback` | Explicit, user-invoked | **none** |
| A runtime update via `ensureRuntime` | Touches receipt, store, provider config. **Does not enumerate, open, lock, or write records.** Test `runtime-bootstrap.test.mjs:231` already asserts `.agents/knowledge/migrations` is not even created | **none** |

The one *reporting* change: when `ensureRuntime` returns `bootstrapped:true`
because the required identity changed, `SKILL.md` instructs the agent to run
`artifact-migration-toolkit status` before resuming an existing migration, so a
resulting `MISMATCH` is surfaced as a decision rather than discovered
mid-checkpoint. **No automatic record mutation is introduced.** Fail-closed
identity gates are untouched.

---

## 14. Offline contract

Preserved from plan v1, with “matching” redefined as **satisfying the exact
acceptance predicate**, not version equality.

| Question | Answer |
|---|---|
| What metadata is safe to use offline | The installed `release-identity.json` (a *requirement*, never a trust anchor); `release-manifest.json` **after** its bytes hash to the receipt `pin` — which makes its `skills` document a release-pinned fact usable offline; `SHA256SUMS`; `build-identity.json`; `providers/<p>/adapter.json`; receipt fields, all re-validated by `validateSelection` + `verifyBundle`. Nothing is trusted because it is local — everything is trusted because it hashes. |
| When may a locally verified receipt be reused | When `satisfies(manifestOf(previous))` holds **and** `pinnedToolkit()` + `validateSelection()` + `verifyBundle()` all pass. Identical to today, plus the predicate. |
| Is the predicate checkable offline | **Yes, fully.** Its inputs are the installed stamp (local) and the pinned `release-manifest.json` (local, hash-verified). **No network is ever needed to detect a mismatch** — only to *resolve* a release that is not present locally. |
| Offline sources for a different required identity | In order: `previous.releases[]`, sibling receipts, raw store scan of `<store>/<requiredVersion>-*`. Each verified through `pinnedToolkit()` — the store directory name is *checked against* the verified manifest, never trusted (`runtime-bootstrap.mjs:153`) — and then filtered by `satisfies()`. A store scan adds a source, not a trust assumption. |
| Pin vs. offline fallback — how does the runtime tell? | Explicitly. `pinned` means rollback intent; its absence means convergeable. `selection` (`"skill"`/`"pinned"`/`"explicit"`), `skillIdentity` (`"required"`/`"pinned"`/`"unverified"`) and `network` name exactly which rule fired. Never conflated. |
| What happens when discovery cannot reach GitHub | If local sources satisfy the requirement: nothing — success with `network:false`. If not, and a valid local runtime exists: typed `RUNTIME_UPDATE_REQUIRED_OFFLINE`. If not, and nothing is installed: the original network error propagates. |
| Typed informational state | Yes: `{ code, installed, required, reason, detail, receipt: "unchanged" }` on stderr with a non-zero exit, and the same shape in the JSON result for MCP callers. Codes: `RUNTIME_UPDATE_REQUIRED_OFFLINE`, `SKILL_IDENTITY_UNRELEASED`, `RELEASE_NOT_PUBLISHED`, `SKILL_IDENTITY_MISSING`, `SKILL_IDENTITY_LEGACY`, `SKILL_SET_INCOHERENT`. |
| What state is persisted on failure | **Nothing.** No cache file, no last-checked timestamp, no negative result. Receipt, store and every provider config are byte-identical before and after. Asserted by T8 and T20. |
| Can an offline failure corrupt/delete/downgrade a verified runtime | **No.** The failure branches contain no delete and no write; the only writer is `adapter()`, which is not called. |

Infrastructure constraint: unchanged. No Docker, VM, service, privileged
process, signer, hardware authenticator, or always-online dependency is added or
implied. A verified local runtime that satisfies its skill works offline
forever.

---

## 15. Windows / WSL findings

*(Unchanged by the correction — it alters no path-resolution behavior.)*

**Verdict: REAL_RISK (latent — not currently triggered in this consumer).**

Evidence from the live receipts (§3.2):

- `root`: `C:\Users\icordoba\Desktop\wms-milla7`
- `store`: `C:\Users\icordoba\AppData\Local\artifact-migration-tools`
- Both written by `path.resolve()` on **win32**, so both are backslashed
  Windows paths.
- `commands[*][0]` and `mcp.command`: `C:\Program Files\nodejs\node.exe`
  — i.e. `process.execPath` captured on win32.

Traced consequences of running the same repository from WSL:

1. `defaultStore()` (`runtime-bootstrap.mjs:130-133`) branches on
   `process.platform`. Under WSL it returns
   `$XDG_DATA_HOME/artifact-migration-tools` or
   `~/.local/share/artifact-migration-tools` — **a different store entirely**.
2. `root` resolves to `/mnt/c/Users/icordoba/Desktop/wms-milla7`, which is
   `!==` the receipt's `C:\…\wms-milla7`.
3. `runtime-bootstrap.mjs:265` therefore throws **`"Runtime receipt selection
   conflict"`** — and `install-support.mjs:252` independently throws
   `"Installation selection conflict"`. **Fail-closed, as designed.** A WSL
   invocation cannot silently adopt or corrupt the Windows installation.
4. But the failure is **unrecoverable without manual deletion**: the two
   environments are mutually exclusive over one `.artifact-migration-toolkit/`
   directory, and the error message names neither cause nor remedy.
5. `pinnedToolkit`'s path equality (`:153`) and `validateSelection`'s
   (`install-support.mjs:222`) both use `path.join`, so they are consistent
   *within* one platform and guaranteed to disagree *across* platforms.
6. `mcp.command` = `C:\Program Files\nodejs\node.exe` is unusable from WSL even
   if the paths matched. Conversely a WSL-written `/usr/bin/node` registration
   is unusable from Windows hosts.

**Why it is not a current risk in `wms-milla7`:** both receipts were written by
win32 and no WSL receipt exists. The directory is consistently Windows-native.

**Scope decision:** this plan does **not** attempt dual-environment support —
that is a genuinely different product question. It changes **one** thing: the
two conflict errors gain the actual cause:

```
Runtime receipt selection conflict: this receipt was written for
root "C:\Users\icordoba\Desktop\wms-milla7" / store "C:\Users\...\AppData\Local\artifact-migration-tools"
but this invocation resolved
root "/mnt/c/Users/icordoba/Desktop/wms-milla7" / store "/home/u/.local/share/artifact-migration-tools".
Run the toolkit from one environment, or pass --root/--store explicitly.
```

No Windows CI work, no path-normalization layer, no platform shims.

---

## 16. Interruption / recovery contract

*(Unchanged by the correction.)*

Current state after interruption, traced point by point:

| Interruption point | On-disk state | Next invocation today |
|---|---|---|
| After release resolution | Nothing written. `mkdtemp` dir may leak into `os.tmpdir()` | Clean retry |
| During download | Temp dir only, outside store and consumer | Clean retry |
| After verification, before adapter | Temp dir only | Clean retry |
| During store extraction | `<release>.<uuid>.tmp` staging dir; `rename()` to `<release>` is the only publish step (`install-support.mjs:342-348`). A crash leaves the staging dir and **no** half-release | Correct — but the leaked `.tmp` dir is never GC'd |
| During receipt / config replacement | `replace()` is write-temp-then-`rename` per file (`:208-213`); the `catch` at `:358` restores every backup. A hard kill between two `rename`s can leave config written and receipt not | **`install.lock` blocks everything** |
| During MCP registration replacement | Same as above, same lock | Same |

**The real gap is the lock, not the data.** `adapter()` (`:367-379`) opens
`.artifact-migration-toolkit/install.lock` with `'wx'`. A killed process never
reaches the `finally`, so the lock persists and **every subsequent invocation,
forever, throws** *“Installation locked; inspect interrupted installation
before retrying”*. Recovery requires deleting a file by hand — a direct
violation of the zero-manual-repair criterion. (Not currently triggered: no
`install.lock` exists in the live consumer.)

**Target contract:**

1. The lock file gains content: `{ pid, hostname, startedAt, action, provider }`.
   Written with the same `'wx'` open, so mutual exclusion is unchanged.
2. On `EEXIST`, read it. If the recorded `pid` is **not alive on this hostname**
   (`process.kill(pid, 0)` → `ESRCH`), the lock is stale: remove it once, log
   `recoveredLock: true`, and re-acquire. If the pid is alive, or the hostname
   differs, or the file is unparseable, **fail closed exactly as today** with
   the existing message.
3. After reclaiming a stale lock, `applyAdapter` proceeds normally — and its
   first act on an existing receipt is already `validateSelection(previous)` +
   `verifyBundle` + per-file digest checks (`:254`, `:263-266`). **A
   half-applied install is therefore detected before anything new is written,
   not assumed safe.** Lock reclamation does not assume consistency; it
   re-proves it.
4. Leaked `<release>.<uuid>.tmp` staging dirs are removed opportunistically
   when the store is scanned (§9.6 step 3), which is already a directory
   listing.
5. A half-written receipt cannot exist: `replace()` renames a fully-written
   temp file. A missing receipt reverts to the first-install path; a receipt
   that fails `validateSelection` fails closed with its existing message.

Net: interruption either **recovers automatically with full re-verification**
or **fails closed with its existing message**. Manual JSON editing is never part
of recovery.

---

## 17. Files that must change

**Corrected: two files are added to scope** (`scripts/skills-lock.mjs`,
`scripts/release.mjs`), which plan v1 wrongly declared out of scope (§6.1).
Seven production files, of which four are mechanical regenerations.

| # | Path | Change |
|---|---|---|
| 1 | `scripts/skills-lock.mjs` | **The binding's requirement side.** (a) `computeSkillHash` (`:93-103`) skips `IDENTITY_BASENAME` during the walk — breaks the cycle (§9.2). (b) `identityDocument` (`:50-64`) adds `computedHash: await computeSkillHash(root, skillName)`. (c) Update the doc comment at `:35-49`: `computedHash` is now present and *is* the release binding; `commit`/`contentHash` remain release-only. (d) `writeSkillsLock` (`:118-127`) no longer depends on write-then-hash ordering. Est. **+12 / −4** lines. |
| 2 | `providers/install-support.mjs` | (a) `validateSelection` (`:221-241`) asserts `same(receipt.skills, manifest.skills)` — closes C6 so a hand-edited receipt cannot fake the binding. (b) Accept and persist `options.pinned` and `options.requiredBy` on the receipt (`:323`) and preserve both on `doctor` (`:286`). (c) `adapter()` (`:367-379`): lock file gains JSON content + stale-pid reclamation. (d) Reclassify ENOENT on a pinned release as *absent* rather than *invalid* (case G). Est. **+55 / −10** lines. |
| 3 | `scripts/runtime-bootstrap.mjs` | **The binding's selection side.** `readSkillRelease()` (reads `../release-identity.json` next to the module) injected as `deps.skillRelease`; §9.6 authority ordering; the `satisfies()` predicate; `fromHistory` / `fromSiblings` / `fromStore` over the existing `pinnedToolkit`; the six typed errors; `pinStillValid` / `carryPin` / `recordRequirement` / `conflictsWith`; `selection` + `skillIdentity` + `network` on the result; enriched selection-conflict messages (§15). Est. **+135 / −25** lines. |
| 4 | `scripts/release.mjs` | **One added gate.** In the `--check` blocker loop beside the existing stamp comparison (`:259-267`), assert that each staged `release-identity.json` `computedHash` equals the corresponding `skills-lock.json` entry — so a release can never ship a stamp and a manifest that disagree about the same skill. The existing byte-comparison against `identityDocument()` already covers the committed side, and the staged restamp (`:315-327`) already propagates `computedHash` via `{...committed}` with **no change**. Est. **+8 / −0** lines. |
| 5 | `skills/start-migration/scripts/runtime.mjs` | Regenerated copy of #3 — `pnpm providers:sync`. No hand edits. |
| 6 | `skills/migrate-artifact/scripts/runtime.mjs` | Same. |
| 7 | `providers/{claude,codex,opencode,copilot}/skills/{start-migration,migrate-artifact}/scripts/runtime.mjs` (8 files) + the eight `release-identity.json` projections | Regenerated. `test/runtime-bootstrap.test.mjs:171` already enforces byte-identity across all ten `runtime.mjs` copies; T19 adds the same for the identity stamp. |

Documentation (same work item, not optional):

| Path | Change |
|---|---|
| `README.md:107-118` | Replace the “resolves the latest stable release / later invocations reuse the receipt” paragraph with the exact-identity contract: what `release-identity.json` now carries, the acceptance predicate in one sentence, the four local sources, the offline contract, and the six typed states. Document `--version` as a **one-invocation** admin/CI/development override that bypasses identity verification, and rollback as the only persistent pin. Stop implying `--version` is the normal escape from a stale runtime. |
| `skills/start-migration/SKILL.md` | Same rewrite of “Runtime preflight”; document `selection`, `skillIdentity`, `network`, and all six typed codes; add the post-update `status` instruction (§13). |
| `skills/migrate-artifact/SKILL.md` | Mirror the preflight paragraph. |
| `skills/start-migration/references/provider-compatibility.md` | State the convergence rules of §11. |

**Not changed, deliberately:** `scripts/providers-sync.mjs` (regeneration
already covers the new sources), every `providers/*/adapter.json`
(`release-identity.json` is already in `files[]` and already manifest-hashed),
the engine, and all of
`packages/migration-engine/src/toolkit-identity.mjs`.

**Regeneration note:** changing the skills and `computeSkillHash` changes
`skills-lock.json`, every `release-identity.json`, and therefore the release
`contentHash`. That is normal `pnpm skills:lock` + `pnpm providers:sync` +
`pnpm release:check` flow, not an extra work item. It also means a v1.3.9 skill
digest can never collide with a v1.3.8 manifest entry, because the published
1.3.8 digests were computed under the old rule — a useful side effect, not a
load-bearing assumption.

---

## 18. Tests that must change / be added

### 18.1 Current tests mapped to current behavior

| Test | Enforces | Disposition |
|---|---|---|
| `runtime-bootstrap.test.mjs:215` *“each provider bootstraps once … then stays offline”* | Second `ensureRuntime` with a throwing resolver returns `bootstrapped:false`; `assert.equal(version, undefined)` on first resolve | **CHANGE SEMANTICS.** The offline-reuse assertion stays (cases C/D must keep passing). The fixture must supply a `skillRelease` whose `computedHash` matches the fixture manifest's `skills` entry, and the first resolve now receives the **exact** version instead of `undefined`. |
| `runtime-bootstrap.test.mjs:120` *pre-v1.1.0 legacy knowledge root, offline* | Legacy receipt reused offline with a throwing resolver | **CHANGE SEMANTICS.** Inject a `skillRelease` satisfying the legacy fixture so the scenario stays reachable. The legacy-doctor waiver logic itself is untouched. |
| `runtime-bootstrap.test.mjs:156,166` legacy-waiver negative cases | Same offline receipt reuse | Same fixture adjustment; assertions unchanged. |
| `runtime-bootstrap.test.mjs:171` *one shared bootstrap source* | All ten `runtime.mjs` byte-identical | **UNCHANGED** (and it is what makes a one-file fix safe). |
| `runtime-bootstrap.test.mjs:178` *latest and exact resolvers* | `/releases/latest` for `undefined`, tag route for exact; draft/prerelease/non-immutable/digest rejection | **UNCHANGED.** `resolveRelease` is not modified; its `latest` branch stays covered as a library function even though `ensureRuntime` no longer reaches it. |
| `runtime-bootstrap.test.mjs:200` *private metadata via gh* | No anonymous fallback when `gh` works | **UNCHANGED.** |
| `runtime-bootstrap.test.mjs:243` *tampered asset* | No receipt / config / migrations dir written | **UNCHANGED.** |
| `runtime-bootstrap.test.mjs:259` *exact-version override* | Exact version reaches the resolver; `latest` as a version string rejected | **EXTEND** — add the follow-up normal invocation asserting the override **did not** persist and the next run converges back (T9, reversing plan v1). |
| `provider-runtime-matrix.test.mjs:438` *D1: three agreeing siblings → fourth installs offline* | Sibling reuse, `reusedFrom` | **EXTEND** — siblings must now *satisfy the required identity*; add a case where they agree with each other but do not satisfy it. |
| `provider-runtime-matrix.test.mjs:472` *D2: siblings that disagree fail closed* | `/disagree/i`, no receipt, config untouched | **REPLACE.** Siblings on *different releases* must no longer be an error (§11; §3.6.4 proves the current rule blocks a real user). Replaced by: (a) siblings not satisfying ⇒ ignored, requirement met normally; (b) two siblings satisfying with different `{commit, contentHash}` ⇒ still `/disagree/i`. |
| `provider-runtime-matrix.test.mjs:491` *E: an exact version is never satisfied by a sibling on another version* | Exact-version sibling filtering | **UNCHANGED** — it becomes the general rule rather than the explicit-version special case. |
| `provider-runtime-matrix.test.mjs:454` *regenerated provider config repaired without adopting anything else* | `doctor` restores exactly the receipt-owned registration | **UNCHANGED** mechanism; **EXTEND** to assert the restored path belongs to the *converged* release (the live `codex.json` bug, §3.6.3). |
| `provider-runtime-matrix.test.mjs:516` *F: every provider format survives install/update/rollback* | Four config formats | **EXTEND** with the post-update no-stale-absolute-path assertion and the rollback-pin assertion (T10). |
| `installed-full-lifecycle.test.mjs:41` *offline installed toolkit bootstraps a fresh consumer and completes migration* | Full offline lifecycle | **CHANGE SEMANTICS** (fixture `skillRelease` must satisfy the installed release) then **UNCHANGED** assertions. Primary guard that the fix does not make the toolkit network-dependent. |
| `provider-installation.test.mjs:41,143` *`release-identity.json` handling* | Released copies carry `source:"release"` + commit + contentHash | **EXTEND** — also assert `computedHash` is present, equals the manifest `skills` entry, and is identical across all provider projections (T19). |
| `release-version-discipline.test.mjs` | One content hash per version; `released-versions.json` discipline | **UNCHANGED** — but its claim is narrowed in the plan (§6.1): it protects *published* version↔contentHash reuse and is **not** evidence about repository skill identity. |
| `providers-sync.test.mjs:1169` *release-identity* | Stamp generation parity | **EXTEND** — assert the stamp carries `computedHash` and that `computeSkillHash` excludes `release-identity.json` (T16). |
| `concurrent-suites.test.mjs`, `provider-progress-parity.test.mjs`, `portability-support.test.mjs` | Concurrency, progress, portability | **UNCHANGED.** |

**Tests that intentionally enforce receipt reuse without a network request:**
`runtime-bootstrap.test.mjs:120, 140, 150, 160, 168, 215(second call)`;
`provider-runtime-matrix.test.mjs` `OFFLINE` constant throughout;
`installed-full-lifecycle.test.mjs:41`. **All must keep passing** — they encode
the offline guarantee, which the chosen architecture preserves whenever the
receipt *satisfies* the installed skill. They need fixture updates (supply a
satisfying `skillRelease`), not semantic reversals.

### 18.2 Required regression coverage

T1–T15 from plan v1 (retained, with T9/T10 corrected for non-persistent
overrides) plus **T16–T23** from this correction. Added to
`test/runtime-bootstrap.test.mjs` (T1–T5, T7–T9, T12, T14, T15, T17, T18, T20,
T21, T23), `test/provider-runtime-matrix.test.mjs` (T6, T10, T13, T22),
`test/providers-sync.test.mjs` (T16) and `test/provider-installation.test.mjs`
(T19).

| # | Test |
|---|---|
| T1 | Receipt at 1.3.4 + satisfying skill identity at 1.3.9 + online ⇒ resolver called with exactly `"1.3.9"`, `action:'update'`, `bootstrapped:true`, `selection:"skill"` |
| T2 | Same, end to end ⇒ returned `toolkit` and on-disk receipt are the 1.3.9 identity, not 1.3.4 |
| T3 | Post-update receipt carries exact immutable identity: `toolkit{…}`, `pin`, `release == store/<version>-<pinhex>`, `skills` equal to the manifest, `releases[]` still retaining 1.3.4 |
| T4 | After update, each provider's own config holds the new absolute `mcp-server.mjs` path, and `receipt.configOwned` equals what is on disk |
| T5 | After update, **no** toolkit-owned file contains any path under a non-selected `<store>/<version>-<pin>` directory |
| T6 | Two providers on different stale releases + one required identity ⇒ both converge; **no** `/disagree/i`; neither downgraded. (Direct regression for the live `wms-milla7` state.) |
| T7 | Receipt satisfies the required identity + throwing resolver ⇒ `bootstrapped:false`, zero requests |
| T8 | Receipt stale + resolver throws + requirement absent locally ⇒ `RUNTIME_UPDATE_REQUIRED_OFFLINE`; receipt bytes, store listing and every provider config byte-identical before and after |
| T8b | Receipt stale + resolver throws + requirement **present** in `releases[]` / a sibling / the store ⇒ converges offline, `network:false`, zero requests |
| T9 | **(corrected)** `--version 1.3.4` against a 1.3.9 skill ⇒ installs 1.3.4, reports `selection:"explicit", skillIdentity:"unverified"`, and writes **no** `pinned`. The **next** normal invocation converges back to 1.3.9 with `selection:"skill"` |
| T10 | **(corrected)** `rollback` to a retained release ⇒ `pinned{by:"rollback", againstSkill}`; next normal invocation stays, reports `selection:"pinned"`, makes no request; after the installed skill's `computedHash` changes, the next normal invocation **supersedes** the pin and converges |
| T11 | A runtime update leaves an existing record's `toolkitIdentity` byte-identical; `status` still reports `MISMATCH`; `.agents/knowledge/migrations` is neither created nor opened during `ensureRuntime` |
| T12 | A stale `install.lock` whose pid is dead is reclaimed once and the install completes with full re-verification; a lock whose pid is alive, or unparseable, or from another hostname, still fails closed with the existing message |
| T13 | Tampering still rejected: mutated store file ⇒ `verifyBundle` throws; mutated `release-manifest.json` ⇒ `pinnedToolkit` pin mismatch; mutated owned consumer file ⇒ `"Owned file modified"`; **hand-edited `receipt.skills` ⇒ `validateSelection` rejects** |
| T14 | A receipt whose `root`/`store` were written on another platform produces the enriched conflict error naming both recorded and resolved root/store (§15). No cross-platform adoption is attempted |
| T15 | Skill identity changed between two invocations, nothing else ⇒ the second does **not** return `bootstrapped:false` on the old release; it converges or raises a typed error. **A stale runtime is never a steady state** |
| **T16** | `computeSkillHash` **excludes** `release-identity.json`: rewriting the stamp (version bump) leaves `computedHash` unchanged, while editing `SKILL.md`, a `references/**` file, or `scripts/runtime.mjs` changes it. `identityDocument()` carries that exact digest, and `writeSkillsLock` is order-independent |
| **T17** | **Same SemVer, different skill identity ⇒ never reused silently.** Receipt/release at version X proving digest `A`; installed skill at version X requiring digest `B` ⇒ `SKILL_IDENTITY_UNRELEASED`, `bootstrapped` absent, nothing written. (The correction's worked example, steps 1–7.) |
| **T18** | **Repository skill changed after a release without a version bump ⇒ fail closed.** Resolver serves the published vX bundle; the skill requires a different digest at vX ⇒ `SKILL_IDENTITY_UNRELEASED`. Separately: version bumped with no published release ⇒ resolver 404 ⇒ `RELEASE_NOT_PUBLISHED`. Neither falls back to `latest` or to a previous version (cases B and C) |
| **T19** | **Released skill identity matches the selected runtime.** For a built bundle: every `release-identity.json` has `source:"release"`, `commit`, `contentHash`, `computedHash`; `computedHash` equals `manifest.skills.skills[skill].computedHash`; `commit`/`contentHash` equal `manifest.toolkit`'s; and the stamp is **byte-identical across all provider projections** (§9.3). A `source:"release"` skill whose `commit` or `contentHash` disagrees with the selected release is refused (predicate 4, case D) |
| **T20** | **Offline exact-identity match succeeds with zero network**, and **offline same-version/different-identity does not silently run**: with a throwing resolver, a satisfying receipt returns `bootstrapped:false` and 0 requests; a same-version/different-digest receipt raises a typed error and mutates nothing |
| **T21** | **Identity-less and legacy stamps fail closed.** No `release-identity.json` ⇒ `SKILL_IDENTITY_MISSING`; a stamp without `computedHash` (pre-v1.3.9) ⇒ `SKILL_IDENTITY_LEGACY`. Neither resolves `latest`; both name `--version` and `skills add` as remedies (case E) |
| **T22** | **Provider siblings with the right version but the wrong skill/release identity cannot satisfy selection.** A sibling receipt at the required version whose pinned manifest proves a different skill digest is not a candidate: selection proceeds to history/store/network instead of adopting it, and never errors with `/disagree/i` |
| **T23** | **Incoherent skill set is refused, not flip-flopped.** `start-migration` requiring release X and `migrate-artifact` requiring release Y against one receipt ⇒ `SKILL_SET_INCOHERENT` naming both skills and both digests; the receipt is unchanged; the message directs the user to `skills add` both skills |

**T24 is not a unit test but a release gate** (§20.2 step 8): the real-consumer
four-provider proof must run against the **candidate/released v1.3.9
implementation**, never against the published v1.3.8 adapter.

---

## 19. Backward compatibility

| Surface | Compatibility |
|---|---|
| **Old receipts** (no `pinned`, no `requiredBy` — including both live `wms-milla7` receipts) | Fully readable. Both absent ⇒ not pinned, nothing recorded ⇒ convergeable, which is the intended reading for a receipt written before intent was recordable. **`skills` is already present on both live receipts**, so the runtime side of the binding needs no migration at all. No format version bump; the receipt is updated in place through the existing `action:'update'` path. |
| **Old receipts whose `skills` is absent** (any receipt written before `skills` existed) | `validateSelection`'s new equality is applied only when `receipt.skills` is present; absent ⇒ the proof is read from the pinned manifest instead. No pre-existing receipt is invalidated by the added check. |
| **Retained releases** (`releases[]`) | Preserved verbatim and now *more* useful: a first-class offline source, filtered by the acceptance predicate. The live `claude.json` history of six releases keeps working; rollback (`install-support.mjs:296`) is unchanged. |
| **Extracted store releases** | Untouched and still valid. All seven in the live store remain verifiable; nothing is deleted or garbage-collected. Only orphaned `*.tmp` staging dirs are cleaned. |
| **Pre-v1.3.9 published releases as *selection targets*** | Their manifests carry `skills` (every release since the field existed), so they can be *proven* against — but their digests were computed under the old `computeSkillHash` rule, so a v1.3.9+ skill can never match them. That is correct: a v1.3.9 skill must run on v1.3.9+. A **rollback** to such a release still works, because a rollback pin bypasses the skill predicate by design (`require.exact = null`). |
| **Pre-v1.3.9 installed skills** (stamp without `computedHash`) | They ship an *old bootstrap* that behaves exactly as today — old code selects as old code did. They become subject to the new rules only after `skills add` replaces them, which is the correct direction. A *new* bootstrap reading an *old* stamp is the `SKILL_IDENTITY_LEGACY` path (T21) — typed, loud, remedied by `skills add`. |
| **New bootstrap + old release adapter** (a fixed skill whose pin targets a pre-v1.3.9 release) | Does not crash: `applyAdapter` destructures only the options it knows, so unknown `pinned` / `requiredBy` are ignored and simply not persisted. Degrades to “no pin recorded”, never to a wrong runtime. This is also exactly why the fix needs its own release (§20.2). |
| **Existing migration records** | Not read, not written (§13). `toolkitIdentity`, `toolkitIdentityStatus`, `autoAdoptableToolkitTransition` and every fail-closed gate untouched. |
| **Existing provider configs** | Converged, not rewritten wholesale. `mergeConfig` removes exactly the previously-owned bytes/object and writes exactly the new one; unrelated servers (the live `playwright` entries in all four configs) and unrelated settings are preserved — the existing `provider-runtime-matrix.test.mjs:454` guarantee. |
| **`--version` / `ARTIFACT_MIGRATION_TOOLS_VERSION`** | Same syntax, same validation, same exact-tag route, **same non-persistent semantics as documented today** (`README.md:114-118`). Plan v1's added persistence is withdrawn. |
| **Pre-v1.1.0 runtimes** | The legacy knowledge-root waiver (`runtime-bootstrap.mjs:201-234`) is untouched. A rollback-pinned legacy runtime stays usable; an unpinned one converges forward. |
| **Repo-checkout invocation with no stamp** | **Behavior change** (case E): fails closed instead of resolving `latest`. Replaced by two existing supported paths — `--version X.Y.Z`, or `providers/<p>/install.mjs install --bundle <local>`. Documented in `README.md`. |

**Live-consumer effect of shipping v1.3.9** (no manual steps): the user runs
`skills add` for both skills; `claude` converges 1.3.4 → 1.3.9 with `.mcp.json`
rewritten to the 1.3.9 engine path; `codex` converges 1.2.6 → 1.3.9 with the
missing TOML block written fresh at 1.3.9 rather than restored at 1.2.6;
`copilot` / `opencode` first runs stop failing on sibling disagreement; all
seven old store releases and the full rollback history are retained.

---

## 20. Implementation plan

### 20.1 One work item

No safety boundary demands a split: the logic change is confined to one
function's decision order plus one digest field, and the remaining files are
generated or documentation. Splitting would ship a half-converged contract —
exactly the rework this audit exists to prevent.

| Step | Work | Gate |
|---|---|---|
| 1 | `scripts/skills-lock.mjs`: exclude the stamp from `computeSkillHash`; add `computedHash` to `identityDocument`; update the doc comment | T16 green |
| 2 | `scripts/release.mjs`: add the stamp↔manifest `computedHash` gate to `--check` | `pnpm release:check` clean |
| 3 | `providers/install-support.mjs`: `receipt.skills` equality in `validateSelection`; persist/preserve `pinned` + `requiredBy`; lock JSON + stale-pid reclamation; ENOENT reclassification | — |
| 4 | `scripts/runtime-bootstrap.mjs`: `readSkillRelease`, authority ordering, `satisfies()`, three local candidate sources, six typed errors, pin/requirement helpers, result fields, enriched conflict messages | — |
| 5 | `pnpm skills:lock` + `pnpm providers:sync` (regenerates all ten `runtime.mjs` copies, ten `release-identity.json` stamps, `skills-lock.json`) | `pnpm providers:check` clean |
| 6 | Update existing tests per §18.1 (fixtures gain a satisfying `skillRelease`; D2 replaced; T9/T10 reversed from plan v1) | existing suites green |
| 7 | Add T1–T23 per §18.2 | new suites green |
| 8 | `README.md`, both `SKILL.md`s, `provider-compatibility.md` per §17 | — |
| 9 | `pnpm test` (engine + engine:ts + providers) | all green |

### 20.2 Release and end-to-end ordering (corrected)

**Plan v1's Step 8 was invalid.** It proposed installing the fixed skill into
`wms-milla7` and declaring end-to-end proof. That cannot prove anything: the
fixed bootstrap would resolve a release and then
`adapterRun → import(<release>/providers/install-support.mjs)`
(`runtime-bootstrap.mjs:136`) would load **v1.3.8's** adapter — which has no
`receipt.skills` validation, no `pinned`/`requiredBy` persistence and no lock
reclamation. The proof would exercise new skill semantics against old adapter
semantics: the very defect under repair.

**This defect therefore requires a NEW toolkit release after v1.3.8.
Expected version: v1.3.9** (next patch under
`released-versions.json`, which establishes 1.3.0 … 1.3.8). **No release is
performed during this plan correction.**

The chosen sequence — *staged immutable candidate verification before
publication*:

| # | Step | Gate |
|---|---|---|
| 1 | Implement §20.1 steps 1–9 | `pnpm test` green |
| 2 | Focused identity suites in isolation: T16–T23 | green |
| 3 | Full suite: `pnpm test` | green |
| 4 | Bump `package.json` to **1.3.9**; `pnpm skills:lock`; `pnpm providers:sync`; `pnpm release:check` | clean, including the new stamp↔manifest gate |
| 5 | `pnpm release:build` → staged `dist/artifact-migration-tools-1.3.9/`; `pnpm release:verify` re-hashes the staged bundle against its own manifest | verify clean |
| 6 | **Staged candidate acceptance.** Run the full `ensureRuntime` matrix against the **staged candidate bundle**, with `deps.resolve`/`deps.download` serving `dist/` locally and `deps.skillRelease` reading the staged `skills/<name>/release-identity.json`. This proves the exact binding — stamp `computedHash` ↔ candidate `manifest.skills` ↔ candidate adapter behavior — **before publication**, in a throwaway consumer root, offline. Covers all four providers | all four providers converge; T1–T23 pass against the candidate |
| 7 | Publish the immutable v1.3.9 GitHub Release; `pnpm release:record` | `released-versions.json` establishes 1.3.9 |
| 8 | **Real-consumer proof against the released identity.** Back up `wms-milla7/.artifact-migration-toolkit/`, the four MCP configs and `.agents/mcp.json`. Install **both** skills from the v1.3.9 identity (`skills add`, then confirm each installed stamp's `computedHash` equals v1.3.9's `manifest.skills` entry). Run the preflight as claude, codex, copilot and opencode | all four receipts, all four configs and every MCP absolute path land on **one** identity = v1.3.9; old store releases and `releases[]` survive; a second run is offline with `bootstrapped:false` and zero requests |
| 9 | Negative proof on the real consumer: with the network unavailable and a deliberately stale receipt, confirm `RUNTIME_UPDATE_REQUIRED_OFFLINE` leaves every file byte-identical | byte-comparison clean |

Step 8 is the only step that touches the consumer, happens **after** v1.3.9
exists, and uses skills whose identity provably matches the published release.
The bootstrapping path for users already stuck at 1.3.4/1.2.6 is the same single
action: `skills add` replaces the old bootstrap with the fixed one, which then
converges — no receipt deletion, no JSON editing, no `--version`.

---

## 21. Acceptance criteria

1. In the live `wms-milla7`, a normal online preflight under **each** of the
   four providers converges to the release that proves the installed skill's
   exact identity (v1.3.9), with no flags, no deletions and no JSON editing.
2. Skill and runtime identity cannot remain silently split **in either
   dimension**: version drift and equal-version byte drift are both detected.
   A split state exists only as an explicit rollback pin or a typed error.
3. **SemVer equality alone never establishes compatibility.** No accepted
   selection path exists in which the skill digest is unchecked, except an
   explicit `--version`, which is one-invocation and labelled
   `skillIdentity:"unverified"`.
4. `.artifact-migration-toolkit/<provider>.json` has a documented role in
   `README.md`: *installed-runtime state + runtime-side skill identity +
   provider/MCP ownership + rollback history + optional rollback pin + satisfied
   requirements* — and nothing else.
5. A receipt that satisfies the requirement makes **zero** network requests
   (T7, T20, and the unchanged `installed-full-lifecycle` suite).
6. Offline with a satisfying receipt is fully functional (C/D); offline with the
   requirement available locally **converges without network** (T8b).
7. Immutable verification is mandatory and unchanged: tag commit, asset digest,
   `release-manifest.json`, `SHA256SUMS`, per-file hashes, `build-identity.json`,
   adapter identity — **plus** the skill-digest predicate.
8. `ensureRuntime` never consults `/releases/latest`; every resolution is an
   exact tag (I2).
9. Provider switching cannot downgrade, and cannot adopt a same-version sibling
   with the wrong skill identity: T6, T22.
10. A successful update converges the provider-owned MCP registration in the
    same lock: T4.
11. No stale provider-owned absolute engine path survives a successful update,
    in any of the four config formats: T5.
12. Existing migration record `toolkitIdentity` is never written by
    `ensureRuntime`: T11.
13. `--version X.Y.Z` is deterministic, **one-invocation, and persists no
    intent**: T9.
14. Rollback is deterministic, persists a scoped pin, is reported on every
    invocation, and is superseded by a skill-identity change: T10.
15. Repository-source cases are all deterministic and typed: A proceeds, B and C
    fail closed, D proceeds under the strongest binding, E fails closed: T17,
    T18, T19, T21.
16. An incoherent skill set is refused, not flip-flopped: T23.
17. Interruption either recovers with full re-verification or fails closed with
    its existing message; no manual JSON or lock editing: T12.
18. No Docker, VM, service, privileged process, hardware authenticator or
    always-online dependency introduced. The diff adds no dependency to
    `package.json`.
19. No manual receipt deletion or editing appears anywhere in `README.md` or
    `SKILL.md` as normal operation.
20. `pnpm test` and `pnpm release:check` green; all ten `runtime.mjs` copies
    byte-identical (`runtime-bootstrap.test.mjs:171`); all ten
    `release-identity.json` stamps byte-identical across projections (T19).
21. The staged candidate bundle passes the full matrix **before** publication
    (§20.2 step 6).
22. Proven end to end on all four providers against the **released v1.3.9**
    identity (§20.2 step 8), never against v1.3.8 adapter semantics.

---

## 22. Active engineering time estimate

Recalculated for the corrected scope. Plan v1's 10 h is **not** carried over:
two files were added to scope, eight regression tests were added, and the
release/E2E sequence grew a staged-candidate gate.

| Step | Estimate | Δ vs plan v1 |
|---|---|---|
| 1 — `skills-lock.mjs` digest/stamp change | 0.75 h | **new** |
| 2 — `release.mjs` stamp↔manifest gate | 0.5 h | **new** |
| 3 — `install-support.mjs` (`skills` equality, `pinned`, `requiredBy`, lock, ENOENT) | 1.5 h | +0.5 |
| 4 — `runtime-bootstrap.mjs` selection rewrite incl. `satisfies()` + 6 typed errors | 3.0 h | +1.0 |
| 5 — regeneration + lock | 0.25 h | — |
| 6 — amend existing tests / fixtures (satisfying `skillRelease`, D2 replaced, T9/T10 reversed) | 2.0 h | +0.5 |
| 7 — new regression tests T1–T23 | 4.0 h | +1.5 |
| 8 — docs (README, 2× SKILL.md, provider-compatibility) | 1.25 h | +0.25 |
| 9 — full suite + release check + fixes | 1.0 h | — |
| 10 — v1.3.9 candidate build/verify + **staged candidate acceptance matrix** | 1.5 h | **new** |
| 11 — release v1.3.9 + record | 0.5 h | **new** |
| 12 — real-consumer four-provider proof + offline negative proof | 1.25 h | +0.5 |
| **Total active** | **≈ 17.5 h** (≈ 2.5 focused days) | **+7.5 h** |

---

## 23. Risks / blockers

**BLOCKERS: none.** Every decision is backed by traced source or live-consumer
evidence. The four facts the correction turned on were each verified directly:
`release.mjs:413` (manifest carries `skills-lock.json`),
`install-support.mjs:323` (receipt carries `manifest.skills`),
`diff` across all eight provider projections (stamp is verbatim), and
`skills-lock.mjs:93-103` + `release.mjs:10-24` (the exact cycle and how
excluding the stamp breaks it).

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Test-fixture churn: many existing offline tests build receipts with no notion of skill identity and will try to converge once selection reads one | high | Inject `skillRelease` through the existing `deps` object (same pattern as `resolve`/`download`). Mechanical; §18.1 lists every affected test by line. |
| R2 | **Changing `computeSkillHash` changes every `computedHash`, `skills-lock.json` and the release `contentHash`** | certain, by design | Normal `skills:lock` + `providers:sync` + `release:check` flow, gated by the new stamp↔manifest check. Side benefit: v1.3.9+ digests cannot collide with pre-v1.3.9 published digests, so no false positive can cross the change boundary. Not relied on as a guarantee. |
| R3 | **Fail-closed on unreleased `main` bytes (case B) will bite maintainers daily** — every uncommitted/unreleased skill edit makes the normal preflight refuse | **high, for maintainers only** | This is the correction's explicit requirement, and the development path is defined and pre-existing: `--version X.Y.Z` (one invocation, identity bypassed, loud) or `providers/<p>/install.mjs install --bundle <local>`. Documented prominently in `README.md` under “Development checkout”. End users on `skills add` of a published version never see it. |
| R4 | Case E/case C fail-closed is a behavior change for bare-checkout `ensureRuntime` callers (`latest` no longer resolved) | medium | Two supported replacements already exist (R3). Covered by T21. The alternative — an unverifiable skill driving an arbitrary release — is the defect class itself. |
| R5 | A user installs one skill and not the other, producing `SKILL_SET_INCOHERENT` | medium | Typed, names both skills and both digests, remedied by `skills add` for each — the documented install UX. Chosen deliberately over per-invocation runtime flip-flop, which would rewrite MCP on alternating invocations. T23. |
| R6 | First post-fix invocation performs a real download for users whose store lacks v1.3.9 | certain, by design | This is the fix. Mitigated by the four local sources — a shared store or a converged sibling makes it free. One-time per release per store. |
| R7 | `release-identity.json` in a `mode:"runtime"` installed skill is not manifest-checksummed (it came from `skills add`, not the adapter) | low | It is a *requirement*, not a trust anchor. The release it names is resolved through an immutable, digest-verified GitHub Release whose manifest must *prove* the digest. The worst a tampered stamp can do is demand a release that does not satisfy it — which fails closed — or name a different **legitimate** release, the same power `--version` already grants. Documented in the README rewrite. |
| R8 | Case F (offline + unsatisfied + no local copy) blocks users who could previously keep working | low–medium | Deliberate (§10.4). Three local sources are tried first; the error is typed, names both sides, leaves state untouched, and is cleared by one online run or an explicit `--version`. Flagged as the single most reviewable decision. |
| R9 | Windows/WSL dual invocation remains unsupported | accepted | Out of scope by §15; mitigated to a clear diagnostic. A separate product decision. |
| R10 | Stale-lock reclamation races two installers that both see a dead pid | low | Reclaim is a single `rm` then `open(…,'wx')`; the loser gets `EEXIST` and fails closed with the existing message. `concurrent-suites.test.mjs` already exercises concurrency. |
| R11 | v1.3.9 must ship before the fix is provable, so the staged-candidate gate is the only pre-publication proof | certain | §20.2 step 6 runs the full matrix against the staged bundle offline, in a throwaway root, across all four providers — the same artifact that is then published byte-for-byte (`release:verify`). |

---

*End of corrected plan. Correction round 1/1 is complete. Implementation must
not begin until this document is approved.*
