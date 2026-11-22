---- MODULE OSeriesRecognition ----
\* Source: OpenAiHandler modelId and buildResponsesRequest options.openAiModelId.
\* Sink: isOSeriesModelId controls temperature omission on both API paths.
\* Expect the prefix-only sabotage to fail for a deployment with an embedded marker.
\* Failure: a model with an embedded o1, o3, or o4 marker keeps temperature.
\* Rule: Recognition agrees with the explicit model-name domain. Matching is an oracle.
\* PR 2498 review summary findings 1-4 (no thread IDs supplied): 0 covered, 1 added, 3 gap.
\* Gaps: helper duplication and test structure are source properties, not request values.
\* Replay: the substring table must reject a startsWith mutation in the shared helper.
\* Gate: 8 recognition states pass; PrefixOnly fails with invariant error 12 for foo-o3-bar.
\* Replay: startsWith fails both embedded-marker tests; 664 focused tests pass after restoration.
\* Parameter gate: 233280 states pass; all twelve parameter sabotage configs fail as expected.
\* Types and lint pass. No suppression count changed. No new runtime defect was found.
\* Cost: about 5 agent minutes. No replay false alarm. The model does not prove the code correct.
EXTENDS TLC
CONSTANT PrefixOnly
VARIABLE modelId
Names == {"o1", "o3", "o4-mini", "foo-o3-bar", "gpt-4o1", "gpt-4o", "o5", "gpt-5.1"}
Omit == {"o1", "o3", "o4-mini", "foo-o3-bar", "gpt-4o1"}
Init == modelId \in Names
Next == UNCHANGED modelId
Spec == Init /\ [][Next]_modelId
\* The oracle selects the known results of the real-code boundary cases.
Recognized == IF PrefixOnly THEN modelId \in {"o1", "o3", "o4-mini"} ELSE modelId \in Omit
Recognition == Recognized = (modelId \in Omit)
====
