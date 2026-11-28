---- MODULE PromptCacheGate ----
\* Sources: fetched ModelInfo.supportsPromptCache (derived by the OpenRouter
\* fetcher from published input_cache_read/write prices), whether a record
\* for the selected id exists (catalog or endpoint; an unlisted id resolves to
\* openRouterDefaultModelInfo, whose capability belongs to a different model),
\* and the hand-maintained OPEN_ROUTER_PROMPT_CACHING_MODELS ID set. Sink:
\* Anthropic-style cache_control markers on the OpenRouter request.
\* Code: OpenRouterHandler.createMessage prompt-cache gate (issue 2502).
\* Initial invariants preceded review: markers follow the gate exactly, the
\* OpenAI family is never annotated, unlisted ids are annotated exactly when a
\* record exists and is cache-capable AND the family consumes these markers,
\* and listed ids always cache (set fallback for records predating the price
\* parse).
\* Expect: the fixed gate holds in all 24 states; each sabotage variant fails
\* exactly one invariant.
\* Result: Fixed holds in 24 states. NoCapability, NoSetFallback, BroadFamily
\* and NoResolutionGuard each fail their invariant. NoCapability, NoSetFallback
\* and BroadFamily replay as code variants of the capability tests
\* (unlisted-without-prices, listed-incapable, openai-family cases in
\* api/providers/__tests__/openrouter.spec.ts); NoResolutionGuard replays as
\* the empty-catalog regression. Null result: the spec found no defect beyond
\* what the tests pin; the initial NoOpenAiMarkers violation was a model-domain
\* error (listed-and-openai is unreachable - the set is anthropic/google only),
\* corrected to model the real set contents.
\* Cost: two TLC runs of four configs each take about 20 seconds; agent work
\* including the review round is about 25 minutes.
\* Not modeled: HTTP transport, marker placement inside addCacheBreakpoints,
\* TTL resolution, and the fetcher's price-to-capability parse.

VARIABLES req

Families == {"anthropic", "google", "openai", "other"}
\* The ID set contains only Anthropic- and Gemini-family IDs, so a listed
\* record is unreachable for openai/other families.
Inputs == {r \in [family : Families, resolved : BOOLEAN, capable : BOOLEAN, listed : BOOLEAN] :
	~r.listed \/ r.family \in {"anthropic", "google"}}
Init == req \in Inputs
Next == UNCHANGED req
Spec == Init /\ [][Next]_req

\* Gate conjuncts. Each sabotage cfg overrides Eligible with one of these.
CapabilityGate == req.capable /\ req.family \in {"anthropic", "google"}
ResolvedCapabilityGate == req.resolved /\ CapabilityGate
SetGate == req.listed
BroadFamilyGate == (req.resolved /\ req.capable) \/ req.listed
NoResolutionGuardGate == CapabilityGate \/ req.listed
FixedEligible == ResolvedCapabilityGate \/ SetGate

\* Sabotage variants (check.sh expects each to fail one invariant):
\* NoCapability drops the capability conjunct (a stale-list-style set gate).
\* NoSetFallback drops the set disjunct (listed legacy records lose caching).
\* BroadFamily drops the family scope (OpenAI-style models get markers).
\* NoResolutionGuard drops the record requirement (an unlisted anthropic id
\* inherits the default record's capability - review 4674816431).
Eligible == FixedEligible

\* The marker decision equals the gate (the implementation has no other branch).
MarkersSent == Eligible

TypeOK == req \in Inputs
MarkersMatchGate == MarkersSent = Eligible
NoOpenAiMarkers == req.family = "openai" => ~MarkersSent
UnlistedNeedsRecordedCapability ==
	~req.listed => MarkersSent = ResolvedCapabilityGate
ListedAlwaysCaches == req.listed => MarkersSent
====
