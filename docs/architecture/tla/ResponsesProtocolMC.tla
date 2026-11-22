---- MODULE ResponsesProtocolMC ----
\* Model switches remove one boundary guard at a time.
EXTENDS ResponsesProtocol
CONSTANTS RequireTerminal, RejectFailures, PreserveReasoning, PreserveOrder, ReplayReasoning, ResetReasoning,
          PreserveRestriction, UseAzureV1, GuardInference, GuardReplayScope
Samples == {<<>>, <<"r1">>, <<"r1", "r2">>}
ReplayScopeOracle == [destination \in {"same", "other", "chat"} |-> GuardReplayScope => destination = "same"]
AcceptOracle == [status \in {"completed", "failed", "incomplete", "cancelled", "error", "ended"} |->
                  status = "completed" \/ ~RejectFailures \/ (~RequireTerminal /\ status = "ended")]
SaveOracle == [items \in Samples |-> IF ~PreserveReasoning THEN <<>> ELSE IF PreserveOrder THEN items ELSE [i \in 1..Len(items) |-> items[Len(items) - i + 1]]]
ReplayOracle == [items \in Samples \cup {<<"r2", "r1">>} |-> IF ReplayReasoning THEN items ELSE <<>>]
ResetOracle == [items \in Samples \cup {<<"old">>} |-> IF ResetReasoning THEN <<>> ELSE items]
ChoiceOracle == [choice \in {"none", "auto", "restricted", "malformed"} |->
                  IF ~PreserveRestriction THEN "auto" ELSE IF choice = "malformed" THEN "reject" ELSE choice]
ClientOracle == [s \in Domain |->
                  IF s.endpoint = "inferenceLegacy" THEN IF GuardInference THEN "reject" ELSE "plain"
                  ELSE IF s.endpoint = "azureLegacy" THEN IF s.explicitVersion \/ ~UseAzureV1 THEN "azure" ELSE "plain"
                  ELSE "plain"]
====
