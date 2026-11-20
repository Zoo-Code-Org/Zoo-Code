---- MODULE McpToolBoundary ----
\* Sources: saved attachment names, assistant tool_use history, and streamed mcp_tool_use blocks.
\* Sinks: isCanonicalMcpToolName, McpToolSelection.select, and presentAssistantMessage tool results.
\* Failures: an unbounded name reaches the matcher; a resolved history tool is omitted; a partial call emits an error.
\* Invariants: BoundedMatcher, ValidNamesAccepted, HistoryAttached, PartialSilent, CompleteError.
\* Failure: the parser rejects a valid 64-char alias cut inside the server. Invariant: TruncatedAliasAccepted.
\* Source: normalizeMcpToolName. Sink: parseMcpToolName and NativeToolCallParser.parseToolCall.
\* Ratchet: PR 2323 pullrequestreview-5969668380, mcp-name.ts outside-diff finding. Added after the first run.
\* Expect: TwoPartAlias fails on the old normalizer. Fixed holds. Other input shapes do not change.
\* Expect: Fixed holds. Unbounded and Unresolved fail on the old code. Partial and EmptyError fail under sabotage.
\* Review was read before this spec. The first invariants are review-informed, not independent evidence.
\* Review: PR 2323, 0 covered, 5 added, 2 gap. No findings on this spec yet.
\* Threads: discussion_r4624440171, discussion_r4624611219, discussion_r4624611232, discussion_r4624611239.
\* Oracles: the name matcher and catalog lookup. A unique lookup includes exact-name priority.
\* Scope: one history name and one unresolved streamed call. Saved names include a different live tool.
\* Result: Fixed holds in 240 states. All five fault configs fail. No new defect was found (null result).
\* Replay: old code accepts a 65-char name and omits a historical alias. Both property tests failed before the fix.
\* Replay: Partial and EmptyError sabotage edits each fail the presenter attribution test. Both edits were removed.
\* Replay: the old normalizer fails all four server seeds in mcp-name-alias.property.spec.ts. The fixed code passes.
\* Tests: mcp-name.property.test.ts, mcpToolSelection.spec.ts, presentAssistantMessage-tool-usage-attribution.spec.ts.
\* Gap: discussion_r4520330057 needs caller-scope interleavings. check-mcp-tool-selection.ts checks them.
\* Gap: discussion_r4520330067 needs hub catalog priority and policy. Lookup is an oracle here; catalog and presenter tests check them.
\* Cost: all six TLC runs took about 5 seconds. Agent time is not measured.

EXTENDS Naturals, Sequences, McpToolBoundaryMC

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
