---- MODULE OpenAiServiceTier ----
\* Source: response service_tier in handleStreamResponse and processEvent.
\* Normalize: normalizeResponseServiceTier. Capture: captureResponseMetadata (openai-native.ts).
\* Sink: normalizeUsage sends one tier to applyServiceTierPricing and calculateApiCostOpenAI.
\* Failure: Fast uses base rates or skips the long-context rate.
\* Invariant: Fast uses priority at both cost readers. Other tiers keep their meaning.
\* Review: 0 covered, 1 added, 4 gap. PR 2484, thread PRRT_kwDOSK-bwM66Hdu8 and supplied review summary.
\* Added: FastUsesPriority and OtherTiersKeepMeaning narrow the catalog invariant.
\* Expect: Raw fails on fast. Fixed holds. Prices and token counts are oracles.
\* Result: Raw fails FastUsesPriority on fast. Fixed holds in all 20 states. No new failure was found.
\* Replay: both real stream paths bill Sol at 0.439 instead of 0.878 at 272000 input tokens.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 6 minutes.
\* Scope: price math and response transport are outside this model. The property test checks both.
\* Gate: run all configs and the property test. Raw and DroppedStatus must fail. Fixed and the test must pass.
\* Property test: src/api/providers/__tests__/openai-service-tier.spec.ts.
\* Not modeled: unknown response tiers and the SDK-to-fetch fallback reset. The property test covers both.
\* Review gaps: #1 is PR scope and description. #2, #3 and #4 are spec documentation. State invariants cannot check them.
\* Review fixes: document the tier work in the PR; remove stale text, name the functions and state the model limits.
\* Review expect: header changes leave the model results unchanged. No new runtime failure is expected.
\* Review result: Fixed passes in 180 states. Raw and DroppedStatus fail FastUsesPriority. All 448 provider tests pass.
\* Review cost: three TLC runs take less than 1 second each. Agent work takes about 5 minutes. No new failure was found.

\* Simplification expect: one capture rule keeps status, core and legacy tiers before usage.
\* Failure: removal of fallback capture loses a status tier before a later usage event.
\* Invariant: capture precedes billing for every event shape. DroppedStatus must fail.
\* Simplification result: Fixed holds in 180 states. Raw and DroppedStatus fail as expected.
\* Replay: removal of fallback capture bills Fast at 0.439 instead of 0.878 and loses the response id.
\* Simplification cost: each TLC run takes less than 1 second. Agent work takes about 6 minutes.
\* No new failure was found in the shared capture design. The status counterexample rejects naive removal.

EXTENDS TLC
CONSTANT Variant
VARIABLES input, phase, captured

Inputs == [actual : {"fast", "priority", "default", "flex", "absent"},
           requested : {"priority", "default", "flex", "absent"},
           shape : {"core", "status", "legacy"}]
Normalize(t) == IF Variant # "Raw" /\ t = "fast" THEN "priority" ELSE t
Actual == captured
Effective == IF Actual = "absent" THEN input.requested ELSE Actual
Expected == IF input.actual = "fast" THEN "priority"
            ELSE IF input.actual = "absent" THEN input.requested ELSE input.actual

Init == /\ input \in Inputs
        /\ phase = "source"
        /\ captured = "absent"
Capture == /\ phase = "source"
           /\ captured' = IF Variant = "DroppedStatus" /\ input.shape # "core"
                          THEN "absent" ELSE Normalize(input.actual)
           /\ phase' = "captured"
           /\ UNCHANGED input
Bill == /\ phase = "captured"
        /\ phase' = "billed"
        /\ UNCHANGED <<input, captured>>
Next == Capture \/ Bill
Spec == Init /\ [][Next]_<<input, phase, captured>>
FastUsesPriority == phase = "billed" /\ input.actual = "fast" => Effective = "priority"
OtherTiersKeepMeaning == phase = "billed" /\ input.actual # "fast" => Effective = Expected
====
