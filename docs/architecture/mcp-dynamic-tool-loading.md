# MCP dynamic tool loading

Issue #578 adds a task-scoped gate to API tool declarations. When the tools
allowed by the current mode and tool policy exceed `mcp.dynamicLoad.threshold`
(default 50), the task initially attaches up to `mcp.dynamicLoad.initialK`
(default 30) ranked tools. Images-only tasks use the first distinct scoped
tools because there is no initial text to rank.

The selection is stored in task history. Missing or invalid selections are
initialized on demand; a valid empty selection remains initialized. MCP names
already used in conversation history are retained for provider compatibility,
so resumed tasks can require more than `initialK` declarations. This is an
initial selection limit, not a lifetime cap. Historical names accumulate during
a task and are not trimmed, since removing their definitions can cause providers
to reject conversation history. Current server, mode, and tool-policy
restrictions still apply.

If saving fails, the task retains its in-memory selection and continues. Later
normal history saves retry persistence. Storage errors do not trigger API
stream retries.

The gate limits advertised definitions; it does not add an execution permission
boundary. Existing tool authorization still applies to calls by name.

The settings schema and extension-state round trip are implemented. SettingsView
controls and replacement of the legacy catalog-wide warning are deferred to
#581. The legacy warning uses its own catalog advisory threshold; it does not
report the scoped tool count for a running task. The `mcp_load` escape hatch is
deferred to #579.
