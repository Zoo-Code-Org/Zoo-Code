---- MODULE McpToolBoundary ----
\* Sources: saved attachment names, assistant tool_use history, and streamed mcp_tool_use blocks.
\* Sinks: isCanonicalMcpToolName, McpToolSelection.select, and presentAssistantMessage tool results.
\* Failures: an unbounded name reaches the matcher; a resolved history tool is omitted; a partial call emits an error.
\* Invariants: BoundedMatcher, ValidNamesAccepted, HistoryAttached, PartialSilent, CompleteError.
\* Failure: the parser rejects a valid 64-char alias cut inside the server. Invariant: TruncatedAliasAccepted.
\* Source: normalizeMcpToolName. Sink: parseMcpToolName and NativeToolCallParser.parseToolCall.
\* Oracles: the name matcher and catalog lookup. A unique lookup includes exact-name priority.
\* Scope: one history name and one unresolved streamed call. Saved names include a different live tool.
\* Review was read before this spec. The first invariants are review-informed, not independent evidence.
\* Review: PR 2323, 0 covered, 5 added, 3 gap. The module dependency finding is included.
\* Added: discussion_r4624440171, discussion_r4624611219, discussion_r4624611232, discussion_r4624611239.
\* Added: pullrequestreview-5969668380, mcp-name.ts outside-diff alias finding.
\* Gap: discussion_r4520330057 needs caller-scope interleavings. check-mcp-tool-selection.ts checks them.
\* Gap: discussion_r4520330067 needs catalog priority and policy. Lookup is an oracle; catalog and presenter tests check them.
\* Gap: discussion_r4638427029 needs a module dependency check. Only the MC wrapper defines the finite input domain.
\* Replay: old code accepts a 65-char name and omits a historical alias. Both property tests failed before the fix.
\* Replay: Partial and EmptyError sabotage edits each fail the presenter attribution test. Both edits were removed.
\* Replay: the old normalizer fails all four server seeds in mcp-name-alias.property.spec.ts. The fixed code passes.
\* Tests: mcp-name.property.test.ts, mcp-name-alias.property.spec.ts, mcpToolSelection.spec.ts, and the presenter attribution suite.
\* Baseline: the wrapper fixed run holds in 240 states. All five fault configs fail. The 63 focused tests pass.
\* Expect: input reduction keeps all six verdicts and each failed invariant. No new behavior defect is expected.
\* Reduction: 12 and 63 are equivalent; 65 and 4096 are equivalent. Missing and ambiguous lookups have the same effect.
\* Reduction: truncated aliases have length 64. Property tests keep concrete length and lookup cases.
\* Source: https://learntla.com/topics/optimization.html (smaller constants). No state constraint is used.
\* Result: the reduced fixed model holds in 64 states. All five fault configs fail their intended invariants.
\* Findings: no new defect was found (null result). All 63 focused tests pass after input reduction.
\* Cost: reduced gate 4.3 seconds; fault attribution 3.6 seconds. Baseline gate 4.7 seconds. Agent time is not measured.
\* Run: TLA_JAR=<jar> ./check.sh McpToolBoundaryMC. The wrapper is the runner entry point.

EXTENDS Naturals, Sequences

CONSTANTS Inputs, Variant
VARIABLES input, phase, attached, results, errors

vars == <<input, phase, attached, results, errors>>

\* Matching and lookup are input oracles. The model does not parse a name.
MatcherReached == Variant = "Unbounded" \/ input.length <= 64
Accepted == MatcherReached /\ input.parses
AliasAccepted == Variant # "TwoPartAlias" /\ input.parses
ResolvedName == IF input.lookup = "unique" /\ Variant # "Unresolved" THEN "canonical" ELSE "history"

Init ==
    /\ input \in Inputs
    /\ phase = "new"
    /\ attached = {"saved"}
    /\ results = <<>>
    /\ errors = 0

Attach ==
    /\ phase = "new"
    /\ attached' = attached \cup {ResolvedName}
    /\ phase' = "partial"
    /\ UNCHANGED <<input, results, errors>>

\* The unresolved presenter call emits a result only after its arguments are complete.
PresentPartial ==
    /\ phase = "partial"
    /\ phase' = "waiting"
    /\ results' = IF Variant = "Partial" THEN Append(results, "unavailable") ELSE results
    /\ errors' = IF Variant = "Partial" THEN errors + 1 ELSE errors
    /\ UNCHANGED <<input, attached>>

PresentComplete ==
    /\ phase = "waiting"
    /\ phase' = "done"
    /\ results' = Append(results, IF Variant = "EmptyError" THEN "" ELSE "unavailable")
    /\ errors' = errors + 1
    /\ UNCHANGED <<input, attached>>

Next == Attach \/ PresentPartial \/ PresentComplete
Spec == Init /\ [][Next]_vars

BoundedMatcher == MatcherReached => input.length <= 64
ValidNamesAccepted == (input.length <= 64 /\ input.parses) => Accepted
TruncatedAliasAccepted == (input.truncatedAlias /\ input.length = 64 /\ input.parses) => AliasAccepted
HistoryAttached == phase # "new" =>
    /\ "saved" \in attached
    /\ (IF input.lookup = "unique" THEN "canonical" \in attached ELSE "history" \in attached)
PartialSilent == phase = "waiting" => results = <<>> /\ errors = 0
CompleteError == phase = "done" => results = <<"unavailable">> /\ errors = 1

====
