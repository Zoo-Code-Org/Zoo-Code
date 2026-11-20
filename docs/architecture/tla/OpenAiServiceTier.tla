---- MODULE OpenAiServiceTier ----
\* Source: response service_tier in createResponseStream and processEvent.
\* Sink: normalizeUsage sends one tier to applyServiceTierPricing and calculateApiCostOpenAI.
\* Failure: Fast uses base rates or skips the long-context rate.
\* Invariant: Fast uses priority at both cost readers. Other tiers keep their meaning.
\* Before review: expect catalog or routing mismatches. Each provider must use its own catalog.
\* Review: 0 covered, 1 added, 0 gap. PR 2484, thread PRRT_kwDOSK-bwM66Hdu8.
\* Added: FastUsesPriority and OtherTiersKeepMeaning narrow the catalog invariant.
\* Expect: Raw fails on fast. Fixed holds. Prices and token counts are oracles.
\* Result: Raw fails FastUsesPriority on fast. Fixed holds in all 20 states. No new failure was found.
\* Replay: both real stream paths bill Sol at 0.439 instead of 0.878 at 272000 input tokens.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 6 minutes.
\* Scope: price math and response transport are outside this model. The property test checks both.
\* Gate: run both configs and the property test. Raw must fail. Fixed and the test must pass.
\* Property test: src/api/providers/__tests__/openai-service-tier.spec.ts.

EXTENDS TLC
CONSTANT Variant
VARIABLE input

Inputs == [actual : {"fast", "priority", "default", "flex", "absent"},
           requested : {"priority", "default", "flex", "absent"}]
Normalize(t) == IF Variant = "Fixed" /\ t = "fast" THEN "priority" ELSE t
Actual == Normalize(input.actual)
Effective == IF Actual = "absent" THEN input.requested ELSE Actual
Expected == IF input.actual = "fast" THEN "priority"
            ELSE IF input.actual = "absent" THEN input.requested ELSE input.actual

Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input
FastUsesPriority == input.actual = "fast" => Effective = "priority"
OtherTiersKeepMeaning == input.actual # "fast" => Effective = Expected
====
