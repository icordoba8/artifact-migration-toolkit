# Discovery Checklist

Discovery is a symmetric, evidence-based comparison of the legacy and current
target implementations. It is not a license to copy legacy code, UI, design, or
architecture. The legacy repository remains read-only.

## Required order

1. Pin the legacy revision and record the target baseline revision plus working
   tree scope.
2. Collect registry and brief seeds.
3. List tracked candidates in both repositories with `git ls-files`.
4. Search names, aliases, labels, routes, navigation constants, imports,
   re-exports, consumers, producers, and direct importers in both repositories.
5. Read every recorded evidence path.
6. Trace complete observable legacy behaviors and route flows.
7. Trace the current target independently, even when its folder, route, tests,
   or apparent implementation already exists.
8. Observe runtime behavior with permission-distinct personas when static or
   automated evidence is insufficient.
9. Save legacy discovery and target assessment independently; do not mix them
   into one conversation-owned checklist.
10. Populate behavior parity, target-native behavior, route-flow adaptations,
    design-system usage, implementation authorities, and baseline.
11. Validate `BUILD_BASELINE` before registering or planning.

## Migration policy and intake

Before planning, record:

- the configured target-relative requirements source, digest,
  stable requirement IDs, and stable scenario IDs;
- one-sentence business objective;
- observable acceptance and completion criteria;
- `parity` or `scoped` policy;
- behavior-level scope and explicit approval for every scoped exclusion;
- interfaces, security, validation, accessibility, error, data, and
  compatibility behavior that must be preserved;
- unique legacy and target seeds;
- target baseline revision and working-tree scope;
- root-feature or submodule placement;
- permission-distinct personas, expected access, and fixture references;
- required targeted, parity, and final verification;
- current target architecture, routing, design-system, coding, and testing
  authorities.

Runtime fixture values are references only. Never store credentials, tokens,
passwords, or secrets.

## Fixed coverage categories

Every category must be `CONFIRMED`, `N/A`, or `BLOCKED`:

- Routes, pages, layouts and redirects
- Navigation flows, links and breadcrumbs
- Components and visible UX states
- Hooks, contexts, timers and cleanup
- Domain behavior and validation
- Local, client and server state
- Actions and mutations
- Authentication, permissions and scope
- HTTP, gRPC, websocket APIs and DTOs
- Realtime events, ordering and teardown
- Errors, retries, cancellation and recovery
- Edge cases and boundary conditions
- Internationalization and formatting
- Accessibility, styling and assets
- Tests, fixtures and observable scenarios
- Producers, consumers and cross-module coupling

`CONFIRMED` needs a concrete path plus observation, runtime reference, or
executed automated scenario. `N/A` needs a specific reason. `BLOCKED` identifies
the missing evidence, why it matters, and the smallest decision or external
condition required. Generic evidence is invalid.

## Evidence classification

Classify each discovered behavior:

- `CONFIRMED`: supported directly by code, configuration, tests, or runtime.
- `INFERENCE`: likely behavior that still needs confirmation.
- `DEAD`: unreachable or unused behavior with reachability evidence.
- `REDESIGN`: approved observable change with acceptance coverage.
- `UNRESOLVED`: missing delivery-critical evidence.

`INFERENCE` and `UNRESOLVED` cannot silently become exclusions.

## Current target inventory

Inspect and record:

- routes, layouts, redirects, navigation entries, guards, parameters, and deep
  links;
- whether list and detail are independent surfaces, combined composition
  regions, dialogs, drawers, or route-backed views;
- list-to-detail, detail-to-list, back, close, browser-history, selection, and
  state-retention behavior;
- feature owners, components, hooks, contexts, state/query ownership, actions,
  services, ports, adapters, DTOs, mappers, i18n, errors, and tests;
- initial, loading, populated, empty, denied, error, confirmation, recovery,
  retry, reconnect, and teardown states as applicable;
- permissions, data sources, API/event contracts, and public interfaces;
- placeholder, dead, duplicated, incompatible, or target-native behavior;
- architecture, routing, design-system, testing, accessibility, and coding
  compliance.
- every visible component's actual import source, target-required design-system
  equivalent, availability, evidence, and approved exception when one exists.

Derive exactly one initial state: `ABSENT`, `PLACEHOLDER`, `PARTIAL`,
`INCOMPATIBLE`, or `IMPLEMENTED_UNVERIFIED`. A directory, export, route, passing
build, existing test, or historical completion is only a seed.

## Behavior traceability

Assign every reachable legacy behavior a stable `BEH-nnn` ID and trace it to
one or more authoritative OpenSpec requirement/scenario IDs. Each row records:

- concrete legacy behavior and evidence;
- `IN_SCOPE`, approved `EXCLUDED`, or evidenced `DEAD` scope;
- concrete current target evidence or `NO_TARGET_IMPLEMENTATION`;
- target state;
- compatible implementation/verification disposition;
- target architecture owner;
- stable OpenSpec scenario ID;
- final parity result.

No target-only behavior can replace a missing legacy row. Record target-only
behavior separately as `KEEP_TARGET_NATIVE`, `CONFLICT`, or
`OUTSIDE_MIGRATION`. Preserve it unless an approved plan explicitly resolves a
conflict.

Every `ABSENT`, `PLACEHOLDER`, `PARTIAL`, or `INCOMPATIBLE` in-scope row needs a
corresponding implementation action. Every `MATCHED_UNVERIFIED` row still needs
executed acceptance. `NO_CHANGE_REQUIRED` is not a validation shortcut.

## Route-flow traceability

Assign every relevant journey a stable `FLOW-nnn` ID and trace it to a stable
OpenSpec scenario ID. Map:

- route/navigation entry trigger;
- authentication, permission, and feature-flag guards;
- parameters and validation;
- redirects, detail transitions, and back/close transitions;
- permission branches and terminal outcomes;
- adapted target route/trigger;
- target routing authority;
- stable OpenSpec scenario ID.

Preserve observable flow, not legacy path strings or routing implementation.
Literal compatibility routes or redirects are required only by the approved
compatibility contract.

When legacy list and detail are independently reachable, merging them into one
target window is not an automatic routing adaptation. Record
`preservesIndependentListAndDetail: false` and block with
`NAVIGATION_FLOW_GAP` unless the baseline includes `REDESIGNED_APPROVED`,
explicit approval, and an acceptance scenario covering entry, selection,
detail, back/close, URL/history, permissions, state, and accessibility.

## Runtime discovery

Use runtime evidence when code/configuration/tests cannot prove behavior. Record:

- initial URL and environment;
- persona and permission differences;
- loading, populated, empty, denied, error, confirmation, retry, reconnect, and
  teardown states;
- navigation transitions, requests, events, errors, and role differences;
- equivalent target observations for existing target implementations.

Runtime observation initially supports `MATCHED_UNVERIFIED`; final parity
requires a named executed acceptance scenario.

## Target implementation authority

Record the current target sources that govern:

- feature/layer placement and dependency direction;
- routes and navigation;
- design-system components, tokens, layout patterns, and accessibility;
- coding, i18n, error, and testing rules.

If target documentation requires a design-system component or pattern and an
equivalent exists, a local substitute is a `DESIGN_SYSTEM_GAP`. Assign it to a
slice for replacement, or record an explicit approved exception. An undocumented
substitute cannot pass final verification.

Legacy evidence may define observable behavior, routes, business rules,
validation, permissions, errors, edge cases, and public contracts. It may not
define target code, directories, component hierarchy, page composition, layout,
visual design, CSS, tokens, architecture, dependency direction, routing
implementation, or test implementation.

## The census is the inventory, not the graph

`DISCOVER_LEGACY` describes behavior and validates every evidence location
 against the current canonical module boundary. `DISCOVERY_COMPLETENESS`
 recomputes the boundary with the same explicitly recorded scanner version and
 validates every evidence location again before pinning the final result. The
boundary is census-first: `git ls-files --cached --others --exclude-standard`
under the declared physical roots is authoritative, and the import graph only
annotates it. Never widen ownership to include shared configuration or a route:
record typed `SUPPORTING`, `INBOUND_CONSUMER`, and `GOVERNING_FRAMEWORK`
relations instead.

The `SUPPORTING` rows typed `MODULE` are also the candidate set for
`BUILD_BASELINE`'s capability ownership matrix: each one is a capability the
module needs that lives outside it, and each therefore needs a recorded decision
about where it is built in the target. Discovery only records the relation; it
never decides ownership.

Reachability alone is **not** a module inventory. Making the graph authoritative
moves the unverified declaration up one level — from "the files I mentioned" to
"the entry points I declared" — and omitting one route hides a whole subtree
exactly as before. Three independent detectors feed one table, so no single
omission hides a file:

| Detector | What it finds | What defeats it |
| --- | --- | --- |
| Census | every file physically under a declared root | nothing — no graph, no entry points, no imports |
| Graph | reachability and a symbol-selective, typed supporting closure | named imports through a barrel retain only exports that can provide the requested symbol |
| Inbound scan | every first-party file on a resolved path into the roots | nothing an operator declares or omits |

Relevant Next.js file conventions (`page`, `layout`, `route`, `proxy.ts`,
`instrumentation.ts`, …) become `GOVERNING_FRAMEWORK`; unrelated framework
files stay outside this module's closure and digest. An explicit entry point is
always retained in `entryPoints`, but declaration never overwrites its accurate
`SUPPORTING`, `INBOUND_CONSUMER`, or `GOVERNING_FRAMEWORK` boundary relation.
Run `--scan` to see all relations before authoring.

I18n namespace calls resolve through the tracked governing configuration to
the exact JSON resource. CSS imports and URLs, assets, JSON, and
`new URL(..., import.meta.url)` become typed supporting edges with source line,
specifier, and requiring file. Safe immutable aliases and recursively nested
module URL bases have the same treatment. Mutable, cyclic, shadowed, or
otherwise unproven bases fail closed as module-resource findings; proven
HTTP/runtime `new URL()` calls are reported in `runtimeUrls` and never become
unresolved module edges.

An owned file that nothing imports is `UNREACHABLE`, and `UNREACHABLE` is a
classification, not an exemption — it still needs a disposition. `DEAD` needs an
operator `DEAD_CONFIRMATION` plus real runtime observation: "nothing imports it"
is a graph fact, not proof it never runs.

## Discovery-completeness blockers

Do not enter `ASSESS_TARGET` when any of these remains:

- a census file with no classification row, including files nothing imports;
- a classification row for a file outside the census;
- an authored `reachability` or `kind` that disagrees with the scan;
- a production-reachable component, style, image, SVG, or other visual asset
  classified `NO_OBSERVABLE_BEHAVIOR` or `INFRASTRUCTURE_ONLY` — a user can see
  it, so agent-authored rationale never dismisses it;
- `BEHAVIOR_BACKED` citing no behavior, or a behavior `legacy.json` does not
  define;
- `EXCLUDED_APPROVED` or `DEAD` without an operator decision that matches the
  current stable candidate, exact subject, exact rationale bytes, concrete
  targets, current discovery digest, and current legacy source bytes;
- a supporting file the module requires without the computed relation type and
  exact `requiredBy` list, or an unrelated shared file declared supporting;
- any unresolved first-party reference;
- a non-literal `import()`/`require()` or `new URL(expr, import.meta.url)`
  without one or more concrete tracked targets and an `EDGE_RESOLUTION`
  candidate approved by the operator. Prose and approval alone never resolve a
  module edge;
- an i18n namespace without a proven governing mapping to a tracked runtime
  resource;
- a `legacy.json` evidence location outside `OWNED`, typed `SUPPORTING`,
  `INBOUND_CONSUMER`, and `GOVERNING_FRAMEWORK`. This is checked while closing
  `DISCOVER_LEGACY` and again against the final editable boundary while closing
  `DISCOVERY_COMPLETENESS`.

## Readiness blockers

Do not enter `PLAN` when any of these remains:

- missing policy, observable criteria, baseline, or verification;
- missing or generic evidence;
- missing coverage category or `BLOCKED` category;
- unresolved current target state or inventory;
- target existence used as parity;
- missing or duplicated behavior/flow ID;
- reachable behavior or route flow absent from its matrix;
- in-scope gap without compatible action and acceptance scenario;
- scoped exclusion without approval;
- protected behavior without persona/permission coverage;
- runtime-only behavior without runtime or equivalent automated evidence;
- missing target architecture/design/routing/testing authority;
- independent legacy list/detail behavior merged without approved redesign and
  acceptance coverage;
- target component bypasses an available required design-system equivalent
  without an explicit gap or approved exception;
- legacy design, UI, code, file structure, tests, or architecture proposed as a
  target template;
- delivery-critical inference, decision, API/event contract, or target
  ownership gap.

Baseline readiness is proven only by:

```bash
artifact-migration-validate <module> --step BUILD_BASELINE
```
