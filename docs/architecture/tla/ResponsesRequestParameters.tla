---- MODULE ResponsesRequestParameters ----
\* Source: OpenAiHandler options and resolved model info. Sink: buildResponsesRequest and SDK options.
\* Failure: zero, absent, or unsupported values change request defaults or omission.
\* Rules: OutputLimit, Temperature, ToolStrictness, TimeoutNormalization.
\* Review PR 2498, findings 4 and 5: added explicit zero, omission, and strict-schema domains.
\* The pure builder permits these value rules to be checked apart from async cleanup.
\* Runtime normalizers and schema conversion are oracles. No parser is copied.
\* Unit gate: openai-compatible-responses.spec.ts and openai.spec.ts.
\* Prior gate: 19440 states pass; eight sabotage configs fail with invariant error 12.
\* Review 6385d18512: expect null-default mutants to pass old tests (finding 2).
\* Failure: absent function strictness or parameters become false or an empty schema.
\* Added null source values and ToolParameters. The SDK is an oracle.
\* Each sabotage was replayed on the real code. Tests cover accept and reject cases.
\* No new code bug was found here; the tests now make zero and omission rules explicit.
\* Cost: about 5 agent minutes this round; each config runs in about 1 second.
\* Run with -config ResponsesRequestParameters.cfg ResponsesRequestParametersMC.tla.
\* Repeat for each variant. The model does not prove the code correct.
\* PR 2498 threads 4638668706, 4638668716, 4644389836: 0 covered, 3 added, 0 gap.
\* Expect omitted o-series temperature after merging and bounded, matching history call IDs.
\* Sources: model ID, Extra Body, tool_use.id, tool_result.tool_use_id in buildResponsesRequest.
\* Sink: final Responses request. Normalization is an oracle; no hash or encoder is copied.
\* Failures: merged temperature reaches o-series; either history ID exceeds the limit or differs.
\* Rules: Temperature, HistoryIdBounded, HistoryIdPaired, ShortIdPreserved.
\* The ID domain is measured after surrogate encoding, before truncateOpenAiCallId.
\* Current gate: 233280 states pass; twelve sabotage configs fail with invariant error 12.
\* Replays: removal of either ID normalizer or either temperature guard fails the real-code tests.
\* Findings: no new runtime defect and no replay false alarm. Existing fixes satisfy the added rules.
\* Cost: about 6 agent minutes; all 37 Responses configs ran in about 45 seconds.
\* Simplification: no extra stored state; derive the merged value and normalized ID from source.
\* Limit: the model does not check hash collisions or model-name recognition.
\* Refactor expectation: no new defect; resolve temperature once after merging Extra Body.
\* normalizeHistoryCallId applies one encoding and truncation rule to both history ID fields.
\* Existing Temperature, HistoryIdBounded, HistoryIdPaired, and ShortIdPreserved cover the refactor.
\* Refactor gate: 698 focused tests, types, lint, and all 37 TLC configs pass their expected checks.
\* Four code mutations fail assertions. No new defect or replay false alarm was found.
\* Refactor cost: about 3 agent minutes. No model state or invariant was added.
\* PR 2498 incremental review: OSeriesRecognition extends the model-name boundary in a small domain.
\* Review gate: 233280 states pass; twelve parameter sabotage configs fail with invariant error 12.
\* The recognition gate and review ratchet counts are in OSeriesRecognition.
CONSTANT ParameterBoundary
VARIABLE source
Domain == [modelFamily : {"ordinary", "oSeries"}, extraTemperature : {"unset", "custom"},
           historyId : {"short", "limit", "long"}, includeLimit : {"unset", "on", "off"}, customLimit : {"unset", "zero", "custom"},
           modelLimit : {"unset", "default"}, temperature : {"unset", "zero", "custom"},
           supportsTemperature : {"unset", "on", "off"}, strict : {"unset", "on", "off", "mcp", "null"},
           parameters : {"null", "schema"}, tools : BOOLEAN, entrypoint : {"message", "completion"},
           timeout : {"unset", "disabled", "valid", "fractional"}]
ExpectedLimit(s) == IF s.includeLimit # "on" THEN "unset"
                    ELSE IF s.customLimit = "custom" THEN "custom" ELSE s.modelLimit
ConfiguredTemperature(s) == IF s.supportsTemperature = "off" THEN "unset" ELSE s.temperature
MergedTemperature(s) == IF ConfiguredTemperature(s) = "unset" THEN s.extraTemperature ELSE ConfiguredTemperature(s)
ExpectedTemperature(s) == IF s.modelFamily = "oSeries" THEN "unset" ELSE MergedTemperature(s)
ExpectedHistoryId(s) == IF s.historyId = "long" THEN "boundedHash" ELSE s.historyId
ExpectedStrict(s) == IF ~s.tools THEN "omit" ELSE IF s.strict = "null" THEN "null" ELSE IF s.strict \in {"unset", "on"} THEN "on" ELSE "off"
ExpectedParameters(s) == IF s.tools THEN s.parameters ELSE "omit"
ExpectedTimeout(s) == IF s.entrypoint = "message" \/ s.timeout \in {"unset", "disabled"} THEN "unset"
                      ELSE IF s.timeout = "fractional" THEN "rounded" ELSE "valid"
Init == /\ source \in Domain
        /\ (source.entrypoint = "message" \/ ~source.tools)
Next == UNCHANGED source
Spec == Init /\ [][Next]_source
sink == ParameterBoundary[source]
OutputLimit == sink.limit = ExpectedLimit(source)
Temperature == sink.temperature = ExpectedTemperature(source)
ToolStrictness == sink.strict = ExpectedStrict(source)
ToolParameters == sink.parameters = ExpectedParameters(source)
HistoryIdBounded == sink.callId # "long" /\ sink.resultId # "long"
HistoryIdPaired == sink.callId = sink.resultId
ShortIdPreserved == source.historyId # "long" => sink.callId = source.historyId
TimeoutNormalization == sink.timeout = ExpectedTimeout(source)
====
