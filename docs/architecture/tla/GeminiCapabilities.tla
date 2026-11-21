---- MODULE GeminiCapabilities ----
\* Sources: geminiModels, vertexModels, and the user's thinking level.
\* Sink: getGeminiReasoning and its thinkingConfig. Transport is an oracle.
\* Failures: missing registrations, unlisted Vertex models, dropped levels, and unsupported effort requests.
\* Invariants: RegistrationMatchesAvailability, SupportedLevelsReachRequest, and NoUnsupportedEffort.
\* Expected result: each defect config fails when an entry, xhigh support, or the effort guard is missing.
\* Vendor facts are inputs. This model does not verify prices or provider capabilities.
\* KnownLevels defines valid levels. The budget check runs before the effort guard.
\* Replay: seven missing entries and two xhigh paths failed before registration and level fixes.
\* Replay: nine assertions failed before the effort guard. The Vertex Neon absence test detects sabotage.
\* Result: all 224 states pass with the fixes. All four defect configs fail. No new code defect was found.
\* Tests: google-models.test.ts checks availability. reasoning.spec.ts checks each known level.
\* Cost: about 17 minutes of agent work. The five-config gate takes about three seconds.
\* Review: 1 covered, 1 added, 5 gaps. The effort guard required NoUnsupportedEffort.
\* Guard finding: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2640#discussion_r4655065689.
\* Covered: the later review reports the same effort guard issue.
\* Gaps: scope, price expiry, vendor evidence, test independence, and header maintenance are outside this model.
\* Review changes: add dates for price updates, state Vertex assumptions, and use fixed test expectations.
\* Vertex replay: Flash responds through Express mode and rejects xhigh.
\* Carbon and Hydrogen work with locations/global. Both return 404 with locations/us-central1.
\* Carbon rejects xhigh. Hydrogen accepts xhigh. Prices and other capabilities are not verified.
\* AGENTS.md requires the cost and findings in this header.
EXTENDS TLC
CONSTANT CatalogFixed, LevelsFixed, VertexListedOnly, EffortGuard
VARIABLE input
NewModels == {"flash", "carbon", "hydrogen", "neon"}
Models == NewModels \cup {"budget", "standard", "boolean"}
KnownLevels == {"minimal", "low", "medium", "high", "xhigh"}
Levels == KnownLevels \cup {"invalid", "disable", "unset"}
Allowed(model) == IF model \in {"budget", "standard"} THEN {}
                  ELSE IF model = "boolean" THEN KnownLevels
                  ELSE {"low", "medium", "high"} \cup
                       (IF model \in {"hydrogen", "neon"} THEN {"xhigh"} ELSE {})
Available(provider, model) == provider = "gemini" \/ model # "neon"
Inputs == [provider : {"gemini", "vertex"}, model : Models, level : Levels, enabled : BOOLEAN]
Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input
Default == "none"
Registered == IF input.model \in NewModels
              THEN CatalogFixed /\ (Available(input.provider, input.model) \/ ~VertexListedOnly) ELSE TRUE
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
RegistrationMatchesAvailability == Registered = Available(input.provider, input.model)
SupportedLevelsReachRequest == Sent = Expected
NoUnsupportedEffort == ~HasEffort /\ ~BudgetSelected => Sent = "none"
====
