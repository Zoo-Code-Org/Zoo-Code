------------------------- MODULE LocalTestRunnerMC -------------------------
(* Two worker values and two task limits cover defaults and local overrides.
Reader records represent Windows extension CI, webview CI, and readers without a fixed CI limit. *)
EXTENDS LocalTestRunner
MCWorkers == {2, 4}
MCTasks == {1, 2}
MCReaders == {
    [fixedCI |-> TRUE, ciBound |-> 2, localBound |-> 4, expected |-> 2],
    [fixedCI |-> TRUE, ciBound |-> 4, localBound |-> 2, expected |-> 4],
    [fixedCI |-> FALSE, ciBound |-> 0, localBound |-> 2, expected |-> 2],
    [fixedCI |-> FALSE, ciBound |-> 0, localBound |-> 0, expected |-> 0]
}
=============================================================================
