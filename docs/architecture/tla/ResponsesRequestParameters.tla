---- MODULE ResponsesRequestParameters ----
\* Source: OpenAiHandler options and resolved model info. Sink: buildResponsesRequest and SDK options.
\* Failure: zero, absent, or unsupported values change request defaults or omission.
\* Rules: OutputLimit, Temperature, ToolStrictness, TimeoutNormalization.
\* Review PR 2498, findings 4 and 5: added explicit zero, omission, and strict-schema domains.
\* The pure builder permits these value rules to be checked apart from async cleanup.
\* Runtime normalizers and schema conversion are oracles. No parser is copied.
\* Unit gate: openai-compatible-responses.spec.ts and openai.spec.ts.
\* Current gate: 19440 states pass; eight sabotage configs fail with invariant error 12.
\* Review 6385d18512: expect null-default mutants to pass old tests (finding 2).
\* Failure: absent function strictness or parameters become false or an empty schema.
\* Added null source values and ToolParameters. The SDK is an oracle.
\* Each sabotage was replayed on the real code. Tests cover accept and reject cases.
\* No new code bug was found here; the tests now make zero and omission rules explicit.
\* Cost: about 5 agent minutes this round; each config runs in about 1 second.
\* Run with -config ResponsesRequestParameters.cfg ResponsesRequestParametersMC.tla.
\* Repeat for each variant. The model does not prove the code correct.
CONSTANT ParameterBoundary
VARIABLE source
Domain == [includeLimit : {"unset", "on", "off"}, customLimit : {"unset", "zero", "custom"},
           modelLimit : {"unset", "default"}, temperature : {"unset", "zero", "custom"},
           supportsTemperature : {"unset", "on", "off"}, strict : {"unset", "on", "off", "mcp", "null"},
           parameters : {"null", "schema"}, tools : BOOLEAN, entrypoint : {"message", "completion"},
           timeout : {"unset", "disabled", "valid", "fractional"}]
ExpectedLimit(s) == IF s.includeLimit # "on" THEN "unset"
                    ELSE IF s.customLimit = "custom" THEN "custom" ELSE s.modelLimit
ExpectedTemperature(s) == IF s.supportsTemperature = "off" THEN "unset" ELSE s.temperature
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
TimeoutNormalization == sink.timeout = ExpectedTimeout(source)
====
