---- MODULE GeminiCapabilities ----
\* Sources: geminiModels, vertexModels, and the user's thinking level.
\* Sink: getGeminiReasoning and its thinkingConfig. Transport is an oracle.
\* Expect: missing registrations and a dropped xhigh selection fail the model.
\* Failure: a listed model is absent, or an unlisted Vertex model is present.
\* Failure: a supported thinking level is dropped or an unsupported level is sent.
\* Invariants: RegistrationMatchesAvailability and SupportedLevelsReachRequest.
\* First invariants precede issue comments and implementation. Vendor facts are inputs.
\* Results: the fixed model holds in 64 states. All three defect configs fail.
\* Replay: seven missing entries and two xhigh paths fail tests before the fix.
\* Sabotage: adding Neon to vertexModels fails the real absence test. The edit was removed.
\* Property tests: google-models.test.ts checks availability. reasoning.spec.ts checks each known level.
\* Input rules include stale minimal and xhigh choices, invalid input, off, and an unset choice.
\* The fallback rule uses the model default for a known level that the model does not support.
\* Null result: the model found no defect beyond the issue and the xhigh fallback path.
\* No false alarms were retained. The model checks contracts, not code or vendor facts.
\* Router check: both public catalogs list all four IDs. Gateway image fallback entries were added.
\* OpenRouter uses live model data. No static override is needed. VS Code IDs lack live evidence.
\* Approved live check: all 16 GenerateContent calls returned HTTP 403 PERMISSION_DENIED, reason ACCESS_DENIED.
\* The first attempt denied service access. The approved retry returned HTTP 402 RESOURCE_EXHAUSTED for all 16 calls.
\* The retry reports depleted prepayment credits. No capability result was obtained.
\* After prepayment, 14 calls passed. Flash and Carbon rejected xhigh with HTTP 400 as expected.
\* Hydrogen and Neon accepted xhigh. All four accepted budget and temperature parameters.
\* Acceptance does not show whether those parameters apply. Responses do not state a default thinking level.
\* Default, budget, temperature, and Flash cache write fields remain unset. An hourly fee is not a write price.
\* Default is none in this model. An unset or unsupported choice leaves the API to use its own default.
\* The original model assumed catalog defaults. Source review removed that assumption before the final gate.
\* Cost: about 12 minutes of agent work. The four-config TLC gate takes about 3 seconds.
\* Checks: 168 focused tests, both type checks, and lint pass. Suppression counts did not change.
\* Gate: TLA_JAR=/tmp/tla-tools/tla2tools.jar ./check.sh GeminiCapabilities.
\* Review: 0 covered, 0 added, 0 gap. No PR review has run.
EXTENDS TLC
CONSTANT CatalogFixed, LevelsFixed, VertexListedOnly
VARIABLE input
Models == {"flash", "carbon", "hydrogen", "neon"}
Levels == {"minimal", "low", "medium", "high", "xhigh", "invalid", "disable", "unset"}
Allowed(model) == {"low", "medium", "high"} \cup
    (IF model \in {"hydrogen", "neon"} THEN {"xhigh"} ELSE {})
Available(provider, model) == provider = "gemini" \/ model # "neon"
Inputs == [provider : {"gemini", "vertex"}, model : Models, level : Levels]
Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input
Default == "none"
Registered == CatalogFixed /\ (Available(input.provider, input.model) \/ ~VertexListedOnly)
RecognizedLevels == {"minimal", "low", "medium", "high"} \cup (IF LevelsFixed THEN {"xhigh"} ELSE {})
Selected == IF input.level = "unset" THEN Default ELSE input.level
Effort == IF Selected \in RecognizedLevels \ Allowed(input.model) THEN Default ELSE Selected
Sent == IF Effort \in RecognizedLevels THEN Effort ELSE "none"
Expected == IF input.level = "unset" THEN Default
            ELSE IF input.level \in {"invalid", "disable"} THEN "none"
            ELSE IF input.level \in Allowed(input.model) THEN input.level ELSE Default
RegistrationMatchesAvailability == Registered = Available(input.provider, input.model)
SupportedLevelsReachRequest == Sent = Expected
====
