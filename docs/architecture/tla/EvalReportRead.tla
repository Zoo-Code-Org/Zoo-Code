---- MODULE EvalReportRead ----
\* Source: completion marker before read. Sink: readPublishedComparisonReport.
\* Failure: replacement during read returns a report or reports corruption.
\* Invariant: ReadResult rejects corruption only for the same generation.
\* Expect: the old reader fails. This invariant follows the review.
\* PR 2154 thread: discussion_r4624089829. Review: 0 covered, 1 added, 0 gap.
\* Scope: a writer removes marker A, changes files, then writes marker B.
\* JSON parsing and file validity are oracles. Stamps are unique in this model.
\* Property: coding-report.test.ts checks read boundaries and stable errors.
\* Result: fixed passes in 20 states. No new code bug was found.
\* Control: NoRecheck fails ReadResult.
\* Replay: The read-boundary test fails on HEAD and passes with the recheck.
\* Cost: this review took about 12 agent minutes total. Each TLC run took under 1 second.
\* Gate: 401 eval tests, eval type check, and shared ESLint pass.
\* Run each EvalReportRead config with EvalReportReadMC on each fix commit.
EXTENDS Naturals
CONSTANT Recheck
VARIABLES writer, phase, valid, result
vars == <<writer, phase, valid, result>>
Marker == CASE writer = 0 -> "A" [] writer = 3 -> "B" [] OTHER -> "none"
\* The reader has already read marker A at the start of this model.
Init == /\ writer = 0 /\ phase = "read" /\ valid = TRUE /\ result = "pending"
Replace == /\ result = "pending" /\ writer < 3 /\ writer' = writer + 1
           /\ UNCHANGED <<phase, valid, result>>
ReadFiles == /\ phase = "read" /\ phase' = "check" /\ valid' \in BOOLEAN
             /\ UNCHANGED <<writer, result>>
Finish == /\ phase = "check" /\ phase' = "done"
          /\ result' = IF Recheck /\ Marker # "A" THEN "unavailable"
                        ELSE IF valid THEN "report" ELSE "corrupt"
          /\ UNCHANGED <<writer, valid>>
Next == Replace \/ ReadFiles \/ Finish
Spec == Init /\ [][Next]_vars
ReadResult == phase = "done" =>
              IF Marker # "A" THEN result = "unavailable"
              ELSE result = (IF valid THEN "report" ELSE "corrupt")
====
