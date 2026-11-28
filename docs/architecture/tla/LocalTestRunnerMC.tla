------------------------- MODULE LocalTestRunnerMC -------------------------
(* Three worker values and two task limits cover defaults and local overrides.
Reader records represent Windows extension CI, webview CI, and readers without a fixed CI limit. *)
EXTENDS LocalTestRunner
MCWorkers == {1, 3, 4}
MCTasks == {1, 2}
MCReaders == {
    [fixedCI |-> TRUE, ciBound |-> 2, envBound |-> 0, expected |-> 2],
    [fixedCI |-> TRUE, ciBound |-> 4, envBound |-> 0, expected |-> 4],
    [fixedCI |-> TRUE, ciBound |-> 4, envBound |-> 1, expected |-> 1],
    [fixedCI |-> FALSE, ciBound |-> 0, envBound |-> 1, expected |-> 1],
    [fixedCI |-> FALSE, ciBound |-> 0, envBound |-> 0, expected |-> 0]
}
MCFlagCases == {
    [beforeBoundary |-> TRUE, supplied |-> TRUE, requested |-> "1", fallback |-> "2"],
    [beforeBoundary |-> TRUE, supplied |-> FALSE, requested |-> "1", fallback |-> "2"],
    [beforeBoundary |-> FALSE, supplied |-> TRUE, requested |-> "package-value", fallback |-> "2"]
}
MCArgs == <<"--force", "--", "probe.test.js">>
=============================================================================
