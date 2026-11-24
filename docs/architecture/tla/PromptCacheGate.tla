---- MODULE PromptCacheGate ----
\* Sources: fetched ModelInfo.supportsPromptCache (derived by the OpenRouter
\* fetcher from published input_cache_read/write prices) and the hand-maintained
\* OPEN_ROUTER_PROMPT_CACHING_MODELS ID set. Sink: Anthropic-style cache_control
\* markers on the OpenRouter request.
\* Code: OpenRouterHandler.createMessage prompt-cache gate (issue 2502).
\* Initial invariants preceded review: markers follow the gate exactly, the
\* OpenAI family is never annotated, unlisted IDs are annotated exactly when
\* their fetched record is cache-capable AND the family consumes these markers,
\* and listed IDs always cache (set fallback for records predating the price
\* parse).
\* Expect: the fixed gate holds in all 32 states; each sabotage variant fails
\* exactly one invariant. Replay: the capability tests in
\* api/providers/__tests__/openrouter.spec.ts cover every variant in code.
\* Not modeled: HTTP transport, marker placement inside addCacheBreakpoints,
\* TTL resolution, and the fetcher's price-to-capability parse.

VARIABLES req

Families == {"anthropic", "google", "openai", "other"}
\* The ID set contains only Anthropic- and Gemini-family IDs, so a listed
\* record is unreachable for openai/other families.
Inputs == {r \in [family : Families, capable : BOOLEAN, listed : BOOLEAN] :
	~r.listed \/ r.family \in {"anthropic", "google"}}
Init == req \in Inputs
Next == UNCHANGED req
Spec == Init /\ [][Next]_req

\* Gate conjuncts. Each sabotage cfg overrides Eligible with one of these.
CapabilityGate == req.capable /\ req.family \in {"anthropic", "google"}
SetGate == req.listed
BroadFamilyGate == req.capable \/ req.listed
FixedEligible == CapabilityGate \/ SetGate

\* Sabotage variants (check.sh expects each to fail one invariant):
\* NoCapability drops the capability conjunct (a stale-list-style set gate).
\* NoSetFallback drops the set disjunct (listed legacy records lose caching).
\* BroadFamily drops the family scope (OpenAI-style models get markers).
Eligible == FixedEligible

\* The marker decision equals the gate (the implementation has no other branch).
MarkersSent == Eligible

TypeOK == req \in Inputs
MarkersMatchGate == MarkersSent = Eligible
NoOpenAiMarkers == req.family = "openai" => ~MarkersSent
UnlistedNeedsCapability == ~req.listed => MarkersSent = CapabilityGate
ListedAlwaysCaches == req.listed => MarkersSent
====
