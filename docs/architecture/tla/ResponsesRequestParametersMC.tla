---- MODULE ResponsesRequestParametersMC ----
\* Sabotage switches alter one value rule per run.
EXTENDS ResponsesRequestParameters
CONSTANTS HonorLimit, HonorZeroLimit, HonorTemperature, HonorZeroTemperature, HonorStrict, HonorTimeout
ParameterOracle == [s \in Domain |->
    [limit |-> IF ~HonorLimit /\ s.includeLimit = "on" /\ s.customLimit = "custom" THEN s.modelLimit
               ELSE IF ~HonorZeroLimit /\ s.includeLimit = "on" /\ s.customLimit = "zero" THEN "zero"
               ELSE ExpectedLimit(s),
     temperature |-> IF ~HonorTemperature \/ (~HonorZeroTemperature /\ s.temperature = "zero") THEN "unset"
                     ELSE ExpectedTemperature(s),
     strict |-> IF ~HonorStrict /\ s.tools THEN "on" ELSE ExpectedStrict(s),
     timeout |-> IF ~HonorTimeout /\ s.entrypoint = "completion" THEN s.timeout ELSE ExpectedTimeout(s)]]
====
