---- MODULE LiteLLMMaxTokenParam ----
\* Sources: the request model id (gpt-5 naming), the fetched ModelInfo
\* (requiresResponsesApi, requiresMaxCompletionTokens derived from the routed
\* litellm_params.model backend family), and info.maxTokens. Sink: the token
\* limit parameter name on the LiteLLM chat request.
\* Code: LiteLLMHandler.usesMaxCompletionTokens + the two request builders
\* (createMessage, completePrompt). Issue 1865.
\* Initial invariants preceded review: at most one token parameter is sent, the
\* routed-OpenAI branch sends the modern parameter, a non-OpenAI routing keeps
\* the legacy parameter, and an unbounded model sends neither.
\* Expect: the fixed rule holds in all 16 states; NoRouted (the issue's bug)
\* fails RoutedOpenAiGetsCompletion; InvertRouted fails NonOpenaiKeepsMaxTokens.
\* Replay: the alias tests in api/providers/__tests__/lite-llm.spec.ts and the
\* derivation table in api/providers/fetchers/__tests__/litellm.spec.ts cover
\* every variant in code. Not modeled: HTTP transport, token accounting, and
\* the exact regex shape (the spec models the family predicate, not the regex).

VARIABLES req

Inputs == [namedGpt5 : BOOLEAN, responsesApi : BOOLEAN, routedOpenAi : BOOLEAN, maxTokens : BOOLEAN]
Init == req \in Inputs
Next == UNCHANGED req
Spec == Init /\ [][Next]_req

\* Sabotage variants (check.sh expects each to fail one invariant):
\* NoRouted drops the routed-backend branch — exactly the issue 1865 bug.
\* InvertRouted sends the modern parameter for NON-OpenAI routings instead.
Rule == req.namedGpt5 \/ req.responsesApi \/ req.routedOpenAi
NoRoutedRule == req.namedGpt5 \/ req.responsesApi
InvertRoutedRule == req.namedGpt5 \/ req.responsesApi \/ ~req.routedOpenAi
FixedRule == Rule

\* SendsCompletion == the request carries max_completion_tokens.
SendsCompletion == req.maxTokens /\ FixedRule
\* SendsMaxTokens == the request carries max_tokens.
SendsMaxTokens == req.maxTokens /\ ~FixedRule

TypeOK == req \in Inputs
RoutedOpenAiGetsCompletion == req.routedOpenAi => SendsCompletion \/ ~req.maxTokens
NonOpenaiKeepsMaxTokens ==
    (~req.namedGpt5 /\ ~req.responsesApi /\ ~req.routedOpenAi) => SendsMaxTokens \/ ~req.maxTokens
BothNever == ~(SendsCompletion /\ SendsMaxTokens)
AbsentWhenUnbounded == ~req.maxTokens => (~SendsCompletion /\ ~SendsMaxTokens)

====
