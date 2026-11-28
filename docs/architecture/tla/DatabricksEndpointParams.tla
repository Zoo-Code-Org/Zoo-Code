---- MODULE DatabricksEndpointParams ----
\* Sources: openAiBaseUrl and the metadata.parallelToolCalls flag at OpenAiHandler.createMessage.
\* Sink: the chat.completions.create request body. Streaming, retries, and response handling are oracles.
\* URL parsing is an oracle: IsDatabricks is a literal class split, not the string rules.
\* Failure: a body bound for a Databricks serving endpoint carries parallel_tool_calls;
\* the endpoint rejects unknown fields with 400 BAD_REQUEST (issue #2168).
\* Failure: a body bound for another endpoint loses the resolved parallel_tool_calls flag.
\* Invariant DatabricksNeverSends: a Databricks-bound body has no parallel_tool_calls field.
\* Invariant NonDatabricksKeeps: another endpoint's body keeps the resolved flag value.
\* Expected: both endpoint classes and all three flag forms are admitted inputs.
\* Replay: unfixed code is the NoGuard config; DatabricksNeverSends is violated there and the
\* violation replays as issue #2168's 400 on the real endpoint.
\* Tests: src/api/providers/__tests__/databricks-endpoint.spec.ts failed the four omission cases
\* before the fix and passes after; the 491 pre-existing openai handler tests pass both sides.
\* Findings: none new. The spec pins the decision the tests already cover; the invariant
\* sentence is available to future call sites that build OpenAI-compatible bodies.
\* Review ratchet (PR #2697 round 2): OmitEverywhere duplicated NoGuard - FlagPreserved = FALSE
\* made ParallelFieldSent constant TRUE, so the variant sent the field everywhere. Added: the
\* conjunction form (FlagPreserved /\ ~(IsDatabricks /\ DatabricksGuard)) and a presence-checked
\* NonDatabricksKeeps, so OmitEverywhere now drops the field everywhere and fails the loss it names.
\* Result: DatabricksEndpointParams.cfg passes; NoGuard fails DatabricksNeverSends and
\* OmitEverywhere fails NonDatabricksKeeps. See the run log for state counts.
\* Cost: about 20 minutes to author and gate. TLC finishes in seconds.
EXTENDS Naturals
CONSTANT DatabricksGuard, FlagPreserved
VARIABLE input
BaseUrls == {"aws", "azure", "gov", "path", "openai", "localhost", "lookalike", "invalid"}
Flags == {"on", "off", "unset"}
Inputs == [base : BaseUrls, flag : Flags]
IsDatabricks == input.base \in {"aws", "azure", "gov", "path"}
ResolvedFlag == IF input.flag = "unset" THEN TRUE ELSE input.flag = "on"
ParallelFieldSent == FlagPreserved /\ ~(IsDatabricks /\ DatabricksGuard)
Sent == IF ParallelFieldSent
        THEN {"model", "tools", "parallel_tool_calls"}
        ELSE {"model", "tools"}
Body == [f \in Sent |->
          CASE f = "model" -> "m"
            [] f = "tools" -> TRUE
            [] f = "parallel_tool_calls" -> ResolvedFlag]
Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input
DatabricksNeverSends == IsDatabricks => "parallel_tool_calls" \notin DOMAIN Body
NonDatabricksKeeps == ~IsDatabricks => "parallel_tool_calls" \in DOMAIN Body /\ Body["parallel_tool_calls"] = ResolvedFlag
====
