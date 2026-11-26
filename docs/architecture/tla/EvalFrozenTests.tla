---- MODULE EvalFrozenTests ----
\* Source: runCodingFixtureOnce supplies fixture tests.
\* Sink: buildGradingCopy writes the fresh grading workspace.
\* Failure: An agent edit or deletion replaces a frozen visible test.
\* Invariant: FrozenTests prevents this failure.
\* Expect: the old code fails; the fixed code passes. No new bug is expected.
\* These first invariants follow review; no blind prediction was made.
\* PR 2154 discussion_r4658313661.
\* Review: 0 covered, 1 added, 1 gap.
\* Scope: content is an oracle value. This model checks the transfer only.
\* Result: fixed passes in 6 states. Unfixed fails the named invariant.
\* Replay: edited visible tests give a false pass on old code.
\* Property: coding-frozen-tests.test.ts and coding-run.test.ts pass on fixed code.
\* The tests fail with the old transfer. No false alarm was found.
\* Findings: no new code bug was found by TLC.
\* Gate: 404 eval tests, eval type check, and shared ESLint pass.
\* The src lint config excludes scripts. Suppression counts did not change.
\* Cost: about 10 agent minutes total for both fixes. Each TLC run took under 1 second.
\* Run both configs and the property tests by hand on each fix commit.
\* Simplify: output holds the sink value; phase marks transfer and cleanup.
\* This model check does not prove the code correct.
\* Refactor: visibleTests is required at the grading and copy entry points.
\* Expect: file transfer keeps the same invariant results.
\* Scope: TypeScript checks required arguments; TLC does not check types.
\* Refactor result: both configs keep their prior results. No new model failure.
\* Refactor cost: about 5 agent minutes total; each TLC run took under 1 second.
\* PR 2154 discussion_r4689875376: gap; this model does not check test assertions.
\* Failure: runGrader catches a callback assertion, but the test still passes.
\* Check: the returned grading reason must equal the callback reason.
\* Expect: no new model failure. Removing visible tests must fail the code test.
\* Replay: omit visible tests in buildGradingCopy; the strengthened test fails.
\* Restore the transfer; the same test passes. No false alarm was found.
\* Result: fixed has 6 states; Unfixed fails FrozenTests. No new model bug.
\* Gate: all 404 eval tests, eval type check, shared ESLint, and format check pass.
\* The src lint config excludes this test. Suppression counts did not change.
\* Cost: this review took about 5 agent minutes. Each TLC run took under 1 second.
EXTENDS Naturals
CONSTANT RestoreVisible
VARIABLES input, phase, output
vars == <<input, phase, output>>
Init == /\ input \in {"original", "changed", "missing"}
        /\ phase = "source" /\ output = "none"
Transfer == /\ phase = "source" /\ phase' = "sink"
            /\ output' = IF RestoreVisible THEN "original" ELSE input
            /\ UNCHANGED input
Next == Transfer
Spec == Init /\ [][Next]_vars
FrozenTests == phase = "sink" => output = "original"
====
