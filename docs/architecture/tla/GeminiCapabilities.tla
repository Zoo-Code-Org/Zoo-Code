---- MODULE GeminiCapabilities ----
\* Sources: geminiModels, vertexModels, and the user's thinking level.
\* Sink: getGeminiReasoning and its thinkingConfig. Transport is an oracle.
\* Failures: missing registrations, dropped levels, and unsupported effort requests.
\* Invariants: RegistrationMatchesAvailability, SupportedLevelsReachRequest, and NoUnsupportedEffort.
\* Expected: all four models are registered on both providers. Supported levels and defaults reach the request.
\* Expected: unknown or disabled levels stay absent. Budget selection precedes the effort-support guard.
\* Vendor facts are inputs. This model does not verify prices, provider capabilities, or code correctness.
\* Review: 2 covered, 1 added, 5 gaps. The effort guard required NoUnsupportedEffort.
\* Guard thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2640#discussion_r4655065689.
\* Covered: the repeated guard finding and Torey's missing Vertex Neon finding.
\* Neon thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2640#discussion_r4659915941.
\* The original availability input excluded Vertex Neon incorrectly. RequiredRegistrations now includes it.
\* Gaps: scope, price expiry, vendor evidence, test independence, and header maintenance.
\* Replay: missing entries, dropped xhigh, and the absent effort guard failed focused tests before their fixes.
\* Replay: removing defaults failed seven reasoning tests. Missing Vertex Neon failed the catalog test.
\* Live checks: Flash works in Express mode. Carbon and Hydrogen work in global, but return 404 in us-central1.
\* Flash and Carbon reject xhigh. Hydrogen accepts it. Vertex Neon accepts default, HIGH, and XHIGH in global.
\* Budget checks: 42 requests showed that acceptance does not establish support. Vertex rejects Carbon and Hydrogen budgets.
\* Google documents medium defaults for Flash and Carbon, high for Hydrogen and Neon, and ignored custom temperature.
\* Flash cache storage uses an hourly rate. No separate cache write rate is listed, so cacheWritesPrice stays unset.
\* Sources: https://aistudio.google.com/docs/thinking and each model developer guide.
\* Neon source: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-neon.
\* Result before cleanup: 224 states pass. All four defect configs fail. No new defect beyond review findings was found.
\* Tests: 20 catalog and 126 reasoning tests pass. Both type checks and lint pass.
\* Cost: about 31 minutes of agent work across implementation and review fixes. The gate takes about three seconds.
\* Cleanup: explicit registration sets preserve 224 states and all five config outcomes. All 146 focused tests pass.
\* Cleanup cost: about two minutes of agent work. No new code defect was found.
EXTENDS TLC
CONSTANT CatalogFixed, LevelsFixed, VertexNeonRegistered, EffortGuard
VARIABLE input
NewModels == {"flash", "carbon", "hydrogen", "neon"}
Models == NewModels \cup {"budget", "standard", "boolean"}
KnownLevels == {"minimal", "low", "medium", "high", "xhigh"}
Levels == KnownLevels \cup {"invalid", "disable", "unset"}
Allowed(model) == IF model \in {"budget", "standard"} THEN {}
                  ELSE IF model = "boolean" THEN KnownLevels
                  ELSE {"low", "medium", "high"} \cup
                       (IF model \in {"hydrogen", "neon"} THEN {"xhigh"} ELSE {})
RequiredRegistrations == {"gemini", "vertex"} \X NewModels
Inputs == [provider : {"gemini", "vertex"}, model : Models, level : Levels, enabled : BOOLEAN]
Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input
Default == IF input.model \in {"flash", "carbon"} THEN "medium"
           ELSE IF input.model \in {"hydrogen", "neon"} THEN "high" ELSE "none"
Registered == IF ~CatalogFixed THEN {}
              ELSE RequiredRegistrations \ (IF VertexNeonRegistered THEN {} ELSE {<<"vertex", "neon">>})
RecognizedLevels == IF LevelsFixed THEN KnownLevels ELSE KnownLevels \ {"xhigh"}
HasEffort == input.model \notin {"budget", "standard"}
Selected == IF input.level = "unset" THEN Default ELSE input.level
Effort == IF HasEffort /\ input.model # "boolean" /\ Selected \in RecognizedLevels \ Allowed(input.model)
          THEN Default ELSE Selected
BudgetSelected == input.model = "budget" /\ input.enabled
Sent == IF BudgetSelected THEN "budget"
        ELSE IF (~EffortGuard \/ HasEffort) /\ Effort \in RecognizedLevels THEN Effort ELSE "none"
Expected == IF BudgetSelected THEN "budget"
            ELSE IF ~HasEffort THEN "none"
            ELSE IF input.level = "unset" THEN Default
            ELSE IF input.level \in {"invalid", "disable"} THEN "none"
            ELSE IF input.level \in Allowed(input.model) THEN input.level ELSE Default
RegistrationMatchesAvailability ==
    (<<input.provider, input.model>> \in Registered) = (<<input.provider, input.model>> \in RequiredRegistrations)
SupportedLevelsReachRequest == Sent = Expected
NoUnsupportedEffort == ~HasEffort /\ ~BudgetSelected => Sent = "none"
====
