---- MODULE SonnetCapabilities ----
\* Sources: provider catalog IDs and enableReasoningEffort. Sinks: request thinking and capability sets.
\* Code: getAnthropicProviderReasoning, AwsBedrockHandler.createMessage, parseOpenRouterModel,
\* parseVercelAiGatewayModel, getRequestyModels. Provider responses are oracles.
\* Initial invariants preceded review: preserve limits, send supported reasoning, isolate model overrides.
\* Expect: catalog matching and reasoning defaults can disagree with request intent.
\* Failures: an off selection keeps up-front thinking; a catalog ID misses its capabilities.
\* Failure: Requesty loses its budget override when the catalog reports false.
\* Review: PR 2521, 0 covered, 9 added, 0 gap. No earlier subsystem spec exists.
\* Threads: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2521#discussion_r4642783710
\* and discussion_r4642783718: OffMeansBetweenTools and EnabledMeansAdaptive.
\* Threads: discussion_r4642783725 and discussion_r4642783731: CatalogRecognized.
\* Thread: discussion_r4642783738: RequestyBudget. Catalog identity is a verified input rule.
\* Initial result: Fixed held in 24 states. All five review defect variants failed their invariant.
\* Replay: off and catalog failures occur in real tests. Removing the Requesty override fails the false case.
\* Null result: the spec found no defect beyond the review findings. No false alarms were retained.
\* Cost: six TLC runs take about 6 seconds. Agent work takes about 10 minutes, including tests.
\* Gate: TLA_JAR=/tmp/tla-tools/tla2tools.jar ./check.sh SonnetCapabilitiesMC passes all eight configs.
\* Initial tests: all 506 focused tests passed. reasoning.spec.ts enumerates selection and budget domains.
\* Limit preservation remains a test assertion. This change does not alter static limits.
\* The model checks contracts, not vendor facts or code correctness.
\* Replay/property tests: anthropic.spec.ts, bedrock.spec.ts, and the three fetcher suites.
\* Cleanup expectation: exact membership preserves all override effects. No new defect is expected.
\* Failure: a merged predicate drops a member or overrides an unrelated catalog model.
\* Invariant: ExactOverrideEffects preserves the listed effects and the unlisted catalog result.
\* Source: exact provider model IDs. Sink: capability assignments in the two fetchers.
\* The listed input separates members from other IDs. It is needed to check both predicate directions.
\* Cleanup result: Fixed holds in 48 states. LostMember and BroadMatch fail ExactOverrideEffects.
\* Replay: both predicate defects fail the new tests in each real fetcher. The original predicates also pass.
\* Cleanup tests: all 76 fetcher tests pass. Table properties cover every member and similar unlisted IDs.
\* Null result: the cleanup found no new runtime defect. No false alarms were retained.
\* Cleanup cost: about 3 minutes of agent work. The eight-config TLC gate takes about 8 seconds.
\* Round 2 threads: PR 2521 discussion_r4648981362 and discussion_r4648981368 fix model structure and budget scope.
\* Threads: discussion_r4648981372 strengthens the limit test. discussion_r4648981379 adds Requesty off-mode coverage.
\* Review round 2: four findings added. Requesty now shares the off-mode contract.
\* RequestyHandler.getModel passes the prefixed ID. Request tests cover true, false, and unset.
\* The budget invariant preserves unlisted catalog values. MC holds all injected defects.
\* Expect: the fixed contract holds and each injected defect fails. No new runtime defect is expected.
\* Result: Fixed holds in 48 states. All eight defect variants fail their invariant.
\* Replay: Requesty request tests pass for enabled, disabled, and unset selections. The helper checks both ID forms.
\* Tests: 225 focused tests pass. Type checking and lint pass. Suppression counts did not change.
\* Null result: this review found no additional runtime defect. Cost: about 6 minutes and nine TLC runs.
\* Not modeled: HTTP, SDK transport, token counting, and the provider parser internals.

VARIABLE input

Providers == {"anthropic", "vertex", "bedrock", "openrouter", "vercel", "requesty"}
Inputs == [provider : Providers, enabled : BOOLEAN, reportedBudget : BOOLEAN, listed : BOOLEAN]
Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input

Direct == input.provider \in {"anthropic", "vertex", "bedrock", "requesty"}
Thinking == IF input.enabled THEN "adaptive" ELSE "between_tools"
Effort == IF input.enabled THEN "xhigh" ELSE "high"

\* The dotted ID is the catalog source. A hyphenated override does not match it.
CatalogId == "anthropic/claude-sonnet-5.5"
OverrideId == CatalogId
Budget == IF input.listed THEN TRUE ELSE input.reportedBudget

\* Catalog values are an oracle. An empty effect set leaves their values unchanged.
MemberEffects == IF input.provider = "requesty"
                 THEN {"forceBudget", "forceBinary", "disableTemperature"}
                 ELSE {"disableTemperature"}
ExpectedEffects == IF input.listed THEN MemberEffects ELSE {}
MergedEffects == ExpectedEffects
ExactOverrideEffects == input.provider \in {"requesty", "vercel"} => MergedEffects = ExpectedEffects

TypeOK == input \in Inputs
OffMeansBetweenTools == Direct /\ ~input.enabled => Thinking = "between_tools" /\ Effort \in {"low", "medium", "high"}
EnabledMeansAdaptive == Direct /\ input.enabled => Thinking = "adaptive"
CatalogRecognized == input.provider \in {"openrouter", "vercel"} => OverrideId = CatalogId
RequestyBudget == input.provider = "requesty" => Budget = (IF input.listed THEN TRUE ELSE input.reportedBudget)
====
