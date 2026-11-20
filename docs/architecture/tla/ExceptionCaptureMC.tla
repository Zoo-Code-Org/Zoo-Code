---- MODULE ExceptionCaptureMC ----
\* Finite inputs and guard substitutions for ExceptionCapture. No trace counter is needed.
\* Two instances share fields. Two different tuples collide under delimiter joining. A third key forces eviction.
EXTENDS ExceptionCapture

MCInstances == 1..4
MCFields == [i \in MCInstances |->
    CASE i \in {1, 2} -> <<"a|b", "c">> [] i = 3 -> <<"a", "b|c">> [] OTHER -> <<"a", "c">>]
TupleKey(fields) == fields
JoinedKey(fields) == IF fields \in {MCFields[1], MCFields[3]} THEN MCFields[1] ELSE fields
MCWindow == 2
MCLimit == 2
MCGaps == {1, 2, 3}
On == TRUE
Off == FALSE
====
