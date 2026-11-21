---- MODULE EvalComparisonInputsMC ----
\* Bounded inputs and negative controls for the manual gate.
EXTENDS EvalComparisonInputs
Enabled == TRUE
Disabled == FALSE
Keys == {0, 1}
MCInputs == UNION {[1..n -> {0, 1, 2}] : n \in 0..3}
MCMinutes == {1, 120, 35791, 35792}
====
