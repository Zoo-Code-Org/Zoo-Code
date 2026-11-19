# MCP dynamic tool loading

Issue #578 adds a task-scoped gate to API tool declarations. When the tools
allowed by the current mode and tool policy exceed `mcp.dynamicLoad.threshold`
(default 50), the task initially attaches up to `mcp.dynamicLoad.initialK`
(default 30) ranked tools. Images-only tasks use the first distinct scoped
tools because there is no initial text to rank.

The selection is stored in task history. Missing or invalid selections are
initialized on demand; a valid empty selection remains initialized. Nonempty selections are checked against the current scope on each gated build;
selections with no available names are ranked again. Concurrent callers check
their own scope after the preceding selection completes. MCP names
already used in conversation history are retained for provider compatibility,
so resumed tasks can require more than `initialK` declarations. This is an
initial selection limit, not a lifetime cap. Historical names accumulate during
a task and are not trimmed, since removing their definitions can cause providers
to reject conversation history. Current server, mode, and tool-policy
restrictions still apply.

If saving fails, the task retains its in-memory selection and continues. Later
normal history saves retry persistence. History writes union attached names under
the disk lock, preserving newer historical names when an older save arrives late.
Storage errors do not trigger API
stream retries.

The gate limits advertised definitions; it does not add an execution permission
boundary. Existing tool authorization still applies to calls by name.

The settings schema and extension-state round trip are implemented. SettingsView
controls and replacement of the legacy catalog-wide warning are deferred to
#581. The legacy warning uses its own catalog advisory threshold; it does not
report the scoped tool count for a running task. The `mcp_load` escape hatch is
deferred to #579.

## Selection and catalog boundaries

`Task` delegates selection state to `McpToolSelection`. The selection keeps saved
and historical names. A scope check derives whether ranking is needed; there is
no separate restore-validation flag. An empty scope does not initialize a new
empty selection. Storage failures retain the selection for a later normal save.

`getMcpToolCatalog` supplies declaration building, ranking documents, and
truncated-name lookup. It uses `McpHub.getServers()` for enabled servers and
project priority, then applies the mode's server allowlist, prompt enablement,
and first-entry canonical-name deduplication. Exact names win during lookup;
an altered separator must have one match. An unavailable truncated name produces
an error before dispatch. Execution policy checks still apply.

## TypeScript model checks

Run the focused selection and request-preparation checks with:

```sh
pnpm mcp-tools:model-check
```

They also run under `pnpm lifecycle:model-check` in the existing CI gate. Each
checker has an independent state space. They do not enlarge the delegation graph.

`scripts/check-mcp-tool-selection.ts` replays bounded schedules against the
production `McpToolSelection` class. Only ranking and save completion are
controlled by the harness. It explores two callers, two tools, five saved states,
and every pair of four scopes: 80 input scenarios. Calls, rank completions, and
save completions can interleave, with a depth bound of six and a 500-state budget
per scenario. Every state must preserve admitted names and a deliberate empty selection;
completed calls with a
matching query must have a live selection unless a saved empty selection was
intentional. A pending call must retain an enabled completion event. Calls cannot finish
while their save callback is pending.

Five named landmarks require a waiting caller with another scope, names retained
from both scopes, a deliberate empty selection, initialization deferred for an
empty scope, and reranking after all saved names leave scope. Four fault
injections must produce counterexamples: skip scope revalidation, share another
caller's promise, trim saved names, and stop awaiting a save. State-budget exhaustion, an unfinished
frontier, a stalled call, or an unreachable landmark fails the check. Failure
output includes the input, schedule, bounds, and observed production state.

The shared-store explorer in `scripts/check-task-store-concurrency.ts` checks MCP
attachment union using the production `computeHistoryDelta` and
`mergeHistoryDelta` functions. Four scenarios cover concurrent selections and
late empty snapshots, on one host and across two hosts. Each commit must retain
previously committed attachment names. Named landmarks require both selections
to survive and an empty snapshot to commit after another attachment.

`scripts/check-mcp-request-preparation.ts` is an independent bounded protocol for
manual, recovery, automatic, and normal API paths. It uses production
`nextRunState` cancellation latches. Preparation stages, request starts, and
summary commits are abstract effects; `Task.spec.ts` exercises their actual
wiring. Every stage must be reachable with no cancellation and with abort or
abandonment. Missing start or commit guards must produce counterexamples. The
bounds are eight events and 100 states per path.

Catalog lookup and setting defaults remain property tests rather than separate
state machines. `mcpCatalog.spec.ts` checks enabled servers, project priority,
mode scope, canonical collisions, and altered separators. The defaults test
checks pairs of valid and invalid inputs and repeated reads. Existing provider,
handler, parser-to-presenter, and real-filesystem tests cover their boundaries.

The [scope review](https://github.com/Zoo-Code-Org/Zoo-Code/pull/2323#discussion_r4520330057)
and [catalog review](https://github.com/Zoo-Code-Org/Zoo-Code/pull/2323#discussion_r4520330067)
are represented by production regressions. They fail on the old code, including
a waiting caller whose scope differs from the first caller's scope. No new
default-value or persistence defect was found. Deliberately removing the
persistence union, changing a fallback, or removing cancellation guards fails
the corresponding production checks.

These checks establish bounded safety and reachability only. Ranking relevance,
filesystem lock behavior, provider streams, and Promise liveness remain outside
the model claims. Gemini can retain noncallable compatibility definitions;
callable names still enforce policy.
