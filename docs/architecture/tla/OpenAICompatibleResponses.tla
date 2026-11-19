---- MODULE OpenAICompatibleResponses ----
\* Source: OpenAICompatible.handleInputChange and OpenAiHandler.createMessage.
\* Sink: client.responses.create and processResponsesApiStream.
\* Expectation before review: find routing, option loss, or listener leaks.
\* Initial rules: Routing, ReasoningAndTools, ListenerReleased (written before review).
\* Failures: a saved option is lost, bad text reaches the SDK, or a listener leaks.
\* Added rules: Streaming, ExtraBody, WellFormed. The SDK is an oracle.
\* Review PR 2498: 0 covered, 3 added, 2 gap (translations and pixels).
\* Threads: #discussion_r4616096233, #discussion_r4616097051, #discussion_r4616097077.
\* Thread base: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2498
\* Self-review added OutputLimit: modelMaxTokens must override the model default.
\* Replay: 456 requested tokens became 1000. The new test failed before the fix.
\* Failure: the stored flag selects the wrong API. Rule: Routing.
\* Failure: reasoning or tools are lost. Rule: ReasoningAndTools.
\* Failure: a terminal request retains its listener. Rule: ListenerReleased.
\* Failure: streaming ignores a saved false. Rule: Streaming.
\* Failure: Extra Body fields are lost. Rule: ExtraBody.
\* Failure: lone surrogates reach the SDK. Rule: WellFormed.
\* Failure: the custom output limit is lost. See ResponsesRequestParameters.tla.
\* Previous gate e7ed99742a: 1440 states; 8 sabotage checks. See the refactor gate below.
\* Previous gate: the unfixed config and all sabotage checks failed as expected.
\* Property tests: openai.spec.ts checks the finite option and UTF-16 domains.
\* New result: the output-limit test found one more bug. The initial model did not find it.
\* No other new bug or replay false alarm was found. Types and focused tests pass.
\* Cost: about 15 agent minutes through the local gate. All TLC runs take about 8 seconds.
\* Run from this folder with -config OpenAICompatibleResponses.cfg OpenAICompatibleResponsesMC.tla.
\* Use the same MC module for each variant. Variants must exit with invariant error 12.
\* Unit gate: pnpm --dir src exec vitest run api/providers/__tests__/openai.spec.ts api/providers/utils/__tests__/openai-compatible-responses.spec.ts.
\* The model checks the request boundary. It does not prove the code correct.
\* Refactor expectation: no new request bug; test build failures and abort order.
\* Self-review ratchet: 0 covered, 1 added, 0 gap. The derived listener hid disposal order.
\* Failures: a listener is attached before construction or retained after the request ends.
\* Rules: added NoListenerDuringBuild; strengthened ListenerReleased with actual transitions.
\* Refactor result: no new code defect found. Pure-builder tests check unchanged inputs.
\* The fixed model holds in 6912 states. Nine sabotage configs and the unfixed config fail.
\* Each of the nine sabotage replays fails on real-code tests. No replay false alarm remains.
\* Input rule: only the Responses route registers a bridge listener.
\* Cost: about 8 more agent minutes. All TLC configs take about 8 seconds per gate.
\* New source: buildResponsesRequest. New sinks: bridgeExternalAbortSignal and its dispose.
\* Review ratchet, user review of PR 2498 at e7ed99742a: 0 covered, 9 added, 2 gap.
\* Added: findings 1-5, 7, 9-11. Abort assertions from finding 3 were already covered.
\* Gaps: finding 6 is code duplication; finding 8 is code/model correspondence.
\* Finding 9's blanket rejection of max is false. Effort support is model-specific.
\* New rules: route both entry points, isolate subclasses, retain zero/default option semantics.
\* Failure and reasoning replay rules are in ResponsesProtocol.tla. No parser is copied.
\* These are manual TLC and real-code gates. No script proves code/model correspondence.
\* Review gate: routing/cleanup holds in 6912 states. Ten sabotage configs and the unfixed config fail.
\* Option rules are in ResponsesRequestParameters.tla; protocol rules are in ResponsesProtocol.tla.
\* All 25 sabotage cases across the three models fail in separate real-code tests.
\* The unfixed code failed 24 focused regression cases. All 861 focused tests now pass.
\* New findings: completion routing, terminal failures, subclass flags, and reasoning replay were missing.
\* Cost: about 30 agent minutes for this review round. The final 29-config TLC gate takes about 25 seconds.
CONSTANTS RequestBoundary, CleanupBoundary, InitialListenerBoundary
VARIABLES source, phase, listener, aborted
vars == <<source, phase, listener, aborted>>
sink == RequestBoundary[source]
ExpectedResponses == source.responses /\ source.compatible

InputDomain ==
    [responses : BOOLEAN, entrypoint : {"message", "completion"}, compatible : BOOLEAN,
     streaming : {"unset", "on", "off"},
     reasoning : BOOLEAN, tools : BOOLEAN, extra : BOOLEAN, badText : BOOLEAN,
     signal : {"none", "live", "aborted"}]

Init ==
    /\ source \in InputDomain
    /\ (source.entrypoint = "message" \/ ~source.tools)
    /\ phase = "build"
    /\ aborted = (source.signal = "aborted")
    /\ listener = InitialListenerBoundary[source]

\* buildResponsesRequest can return a body or throw before listener registration.
Build ==
    /\ phase = "build"
    /\ phase' \in {"ready", "buildFailed"}
    /\ UNCHANGED <<source, listener, aborted>>

\* bridgeExternalAbortSignal skips registration for absent or pre-aborted signals.
Attach ==
    /\ phase = "ready"
    /\ phase' = "request"
    /\ listener' = (ExpectedResponses /\ source.entrypoint = "message" /\ source.signal = "live" /\ ~aborted)
    /\ UNCHANGED <<source, aborted>>

\* The once-only abort listener removes itself when the external signal fires.
Abort ==
    /\ source.signal = "live"
    /\ ~aborted
    /\ aborted' = TRUE
    /\ listener' = FALSE
    /\ UNCHANGED <<source, phase>>

\* Success, SDK failure, and generator close all enter the same finally block.
Finish ==
    /\ phase = "request"
    /\ phase' = "cleanup"
    /\ UNCHANGED <<source, listener, aborted>>

\* The finally block calls the bridge's dispose function before the generator ends.
Dispose ==
    /\ phase = "cleanup"
    /\ phase' = "done"
    /\ listener' = CleanupBoundary[listener]
    /\ UNCHANGED <<source, aborted>>

Next == Build \/ Attach \/ Abort \/ Finish \/ Dispose
Spec == Init /\ [][Next]_vars
RequestBuilt == phase \in {"ready", "request", "cleanup", "done"}
Routing == RequestBuilt => sink.responses = ExpectedResponses
ReasoningAndTools == RequestBuilt =>
    /\ sink.reasoning = source.reasoning
    /\ sink.tools = source.tools
NoListenerDuringBuild == phase \in {"build", "ready", "buildFailed"} => ~listener
ListenerReleased == phase \in {"done", "buildFailed"} => ~listener
Streaming == RequestBuilt => sink.streaming = (source.entrypoint = "message" /\ source.streaming # "off")
ExtraBody == RequestBuilt => sink.extra = source.extra
WellFormed == RequestBuilt => ~sink.badText
====
