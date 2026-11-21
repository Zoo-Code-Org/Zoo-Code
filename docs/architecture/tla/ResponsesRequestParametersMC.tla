---- MODULE ResponsesRequestParametersMC ----
\* Sabotage switches alter one value rule per run.
EXTENDS ResponsesRequestParameters
CONSTANTS HonorOSeries, HonorExtraTemperature, HonorCallId, HonorResultId, HonorLimit, HonorZeroLimit, HonorTemperature, HonorZeroTemperature, HonorStrict, HonorTimeout, HonorNullStrict, HonorNullParameters
ParameterOracle == [s \in Domain |->
    [limit |-> IF ~HonorLimit /\ s.includeLimit = "on" /\ s.customLimit = "custom" THEN s.modelLimit
               ELSE IF ~HonorZeroLimit /\ s.includeLimit = "on" /\ s.customLimit = "zero" THEN "zero"
               ELSE ExpectedLimit(s),
     temperature |-> IF ~HonorTemperature \/ (~HonorZeroTemperature /\ s.temperature = "zero") THEN "unset"
                     ELSE IF ~HonorOSeries /\ s.modelFamily = "oSeries" THEN MergedTemperature(s)
                     ELSE IF ~HonorExtraTemperature /\ s.modelFamily = "oSeries" THEN s.extraTemperature
                     ELSE ExpectedTemperature(s),
     callId |-> IF HonorCallId THEN ExpectedHistoryId(s) ELSE s.historyId,
     resultId |-> IF HonorResultId THEN ExpectedHistoryId(s) ELSE s.historyId,
     strict |-> IF ~HonorStrict /\ s.tools THEN "on" ELSE IF ~HonorNullStrict /\ s.strict = "null" /\ s.tools THEN "off" ELSE ExpectedStrict(s),
     parameters |-> IF ~HonorNullParameters /\ s.parameters = "null" /\ s.tools THEN "schema" ELSE ExpectedParameters(s),
     timeout |-> IF ~HonorTimeout /\ s.entrypoint = "completion" THEN s.timeout ELSE ExpectedTimeout(s)]]
====
