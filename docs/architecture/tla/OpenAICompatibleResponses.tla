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
\* Failure: the custom output limit is lost. Rule: OutputLimit.
\* Gate 2026-11-19: fixed config holds in 1440 states. Each run takes less than 1 second.
\* The unfixed config and 8 sabotage configs fail. Each real-code replay rejects the defect.
\* Property tests: openai.spec.ts checks the finite option and UTF-16 domains.
\* New result: the output-limit test found one more bug. The initial model did not find it.
\* No other new bug or replay false alarm was found. Types and focused tests pass.
\* Cost: about 15 agent minutes through the local gate. All TLC runs take about 8 seconds.
\* Run from this folder with -config OpenAICompatibleResponses.cfg OpenAICompatibleResponsesMC.tla.
\* Use the same MC module for each variant. Variants must exit with invariant error 12.
\* Unit gate: pnpm --dir src exec vitest run api/providers/__tests__/openai.spec.ts.
\* The model checks the request boundary. It does not prove the code correct.
CONSTANTS RequestBoundary, CleanupBoundary
VARIABLES source, phase
vars == <<source, phase>>
\* These values depend only on the source and phase. Do not store them twice.
sink == RequestBoundary[source]
listener == IF phase = "build" THEN FALSE ELSE IF phase = "request" THEN TRUE ELSE CleanupBoundary

InputDomain ==
    [responses : {TRUE, FALSE}, streaming : {"unset", "on", "off"},
                    reasoning : {TRUE, FALSE}, tools : {TRUE, FALSE},
                    extra : {TRUE, FALSE}, badText : {TRUE, FALSE},
                    limit : {"omit", "default", "custom"}]

Init ==
    /\ source \in InputDomain
    /\ phase = "build"

\* The request owns routing and streaming. Extra Body cannot replace them.
Build ==
    /\ phase = "build"
    /\ phase' = "request"
    /\ UNCHANGED source

\* The SDK can finish, fail, or stop. All exits must release the listener.
Finish ==
    /\ phase = "request"
    /\ phase' \in {"done", "error", "closed"}
    /\ UNCHANGED source
Next == Build \/ Finish
Spec == Init /\ [][Next]_vars
Routing == phase # "build" => sink.responses = source.responses
ReasoningAndTools == phase # "build" =>
    /\ sink.reasoning = source.reasoning
    /\ sink.tools = source.tools
ListenerReleased == phase \in {"done", "error", "closed"} => ~listener
Streaming == phase # "build" => sink.streaming = (source.streaming # "off")
ExtraBody == phase # "build" => sink.extra = source.extra
WellFormed == phase # "build" => ~sink.badText
OutputLimit == phase # "build" => sink.limit = source.limit
====
