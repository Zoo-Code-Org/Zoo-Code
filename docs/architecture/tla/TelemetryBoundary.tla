---- MODULE TelemetryBoundary ----
\* Source: vscode.env.machineId; sinks: PostHogTelemetryClient and ClineProvider.getStateToPostToWebview.
\* Source: validated tool calls in presentAssistantMessage; sink: telemetry events and task usage counts.
\* Failures: raw IDs reach a sink; per-call events duplicate task usage. Invariants: HashedSinks, AggregateOnly.
\* Expected: the two identity sinks use the same projection; tool calls update only the aggregate.
\* Hash is an oracle with raw and pseudonymous classes. This does not model SHA-256 or payload privacy.
\* Initial rules preceded review. The prior rebase exposed the fix summary: this spec is retrospective.
\* Result: fixed passes (12 states). RawHost fails (2); RawWebview fails (3); PerCall fails (4). Null result: no new bug.
\* Replay: raw host and webview IDs, and an added per-call event each fail assertions in the real-code tests.
\* Tests: distinct-id.property.test.ts checks 36 IDs at capture and captureException; sticky-profile checks the same domain.
\* Tests: tool-usage-attribution checks four calls for static and MCP tools, aggregate counts, and no per-call event.
\* Scope excludes task completion delivery, removed unused APIs, policy text, other payload fields, and cloud sync.
\* Cost: two small model files, four configs, 36 IDs and two call sequences. Agent time is not measured; TLC runs took under 1 second.
\* Gate: TLA_JAR=<jar> ./check.sh TelemetryBoundaryMC. Review counts: covered 0, added 0, gap 0.
EXTENDS Naturals
CONSTANTS HashHost, HashWebview, PerCall, MaxCalls
VARIABLES host, webview, calls, aggregate, events
vars == <<host, webview, calls, aggregate, events>>
Init == /\ host = "none" /\ webview = "none" /\ calls = 0 /\ aggregate = 0 /\ events = 0
Host == /\ host' = (IF HashHost THEN "hash" ELSE "raw") /\ UNCHANGED <<webview, calls, aggregate, events>>
Webview == /\ webview' = (IF HashWebview THEN "hash" ELSE "raw") /\ UNCHANGED <<host, calls, aggregate, events>>
Tool == /\ calls < MaxCalls /\ calls' = calls + 1 /\ aggregate' = aggregate + 1
        /\ events' = (IF PerCall THEN events + 1 ELSE events) /\ UNCHANGED <<host, webview>>
Next == Host \/ Webview \/ Tool
Spec == Init /\ [][Next]_vars
HashedSinks == host # "raw" /\ webview # "raw" /\ (host # "none" /\ webview # "none" => host = webview)
AggregateOnly == events = 0 /\ aggregate = calls
====
