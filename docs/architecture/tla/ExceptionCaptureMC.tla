---- MODULE ExceptionCaptureMC ----
\* Finite inputs and guard substitutions for ExceptionCapture. No trace counter is needed.
\* Two instances share fields. Two different tuples collide under delimiter joining. A third key forces eviction.
EXTENDS ExceptionCapture

MCInstances == 1..4
MCFields == [i \in MCInstances |->
    CASE i \in {1, 2} -> <<"a|b", "c">> [] i = 3 -> <<"a", "b|c">> [] OTHER -> <<"a", "c">>]
\* Review PR 2330 items 3 and 7: each field must distinguish errors by itself.
BaseApi == <<"ApiProviderError", "provider", "model", "operation", "500", "failure">>
SingleFieldCases == {BaseApi} \cup
    {[BaseApi EXCEPT ![n] = "other"] : n \in {2, 3, 4, 6}} \cup
    {[BaseApi EXCEPT ![5] = code] : code \in {"429", ""}}
MCFieldCases == {MCFields[i] : i \in MCInstances} \cup SingleFieldCases \cup
    {<<"TypeError", "failure">>, <<"RangeError", "failure">>}
TupleKey(fields) == fields
WithoutCode(fields) == IF Len(fields) = 6 THEN [fields EXCEPT ![5] = ""] ELSE fields
WithoutProvider(fields) == IF Len(fields) = 6 THEN [fields EXCEPT ![2] = ""] ELSE fields
WithoutModel(fields) == IF Len(fields) = 6 THEN [fields EXCEPT ![3] = ""] ELSE fields
WithoutName(fields) == IF Len(fields) = 2 THEN <<"", fields[2]>> ELSE fields
JoinedKey(fields) == IF fields \in {MCFields[1], MCFields[3]} THEN MCFields[1] ELSE fields
MCWindow == 2
MCLimit == 2
MCGaps == {1, 2, 3}
On == TRUE
Off == FALSE
====
