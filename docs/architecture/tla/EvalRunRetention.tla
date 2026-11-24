---- MODULE EvalRunRetention ----
\* Source: runSide returns complete run records.
\* Sink: buildComparisonReport feeds publication before scratch cleanup.
\* Failure: The report drops records before scratch cleanup.
\* Invariant: RecordsRetained prevents this failure.
\* Expect: the old code fails; the fixed code passes. No new bug is expected.
\* These first invariants follow review; no blind prediction was made.
\* PR 2154 discussion_r4658313665.
\* Review: 0 covered, 1 added, 0 gap.
\* Scope: content is an oracle value. This model checks the transfer only.
\* Result: fixed passes in 6 states. Unfixed fails the named invariant.
\* Replay: the old projection drops records before source removal.
\* Property: coding-report.test.ts pass on fixed code.
\* The tests fail with the old transfer. No false alarm was found.
\* Findings: no new code bug was found by TLC.
\* Gate: 404 eval tests, eval type check, and shared ESLint pass.
\* The src lint config excludes scripts. Suppression counts did not change.
\* Cost: about 10 agent minutes total for both fixes. Each TLC run took under 1 second.
\* Run both configs and the property tests by hand on each fix commit.
\* Simplify: output holds the sink value; phase marks transfer and cleanup.
\* This model check does not prove the code correct.
\* Refactor: full records are the sole report input; metrics are derived.
\* Expect: transfer and cleanup keep the same invariant results.
\* Property: the published metric rows equal the retained records' metrics.
\* Refactor result: both configs keep their prior results. No new model failure.
\* Refactor cost: about 5 agent minutes total; each TLC run took under 1 second.
EXTENDS Naturals
CONSTANT KeepRecords
VARIABLES records, phase, output
vars == <<records, phase, output>>
Init == /\ records \in {{"trace", "verdict"}, {"trace", "verdict", "failure"}}
        /\ phase = "source" /\ output = {}
Publish == /\ phase = "source" /\ phase' = "published"
           /\ output' = IF KeepRecords THEN records ELSE {}
           /\ UNCHANGED records
Cleanup == /\ phase = "published" /\ phase' = "scratchRemoved"
           /\ UNCHANGED <<records, output>>
Next == Publish \/ Cleanup
Spec == Init /\ [][Next]_vars
RecordsRetained == phase # "source" => output = records
====
