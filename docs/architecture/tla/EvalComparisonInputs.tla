---- MODULE EvalComparisonInputs ----
\* Source: codingRepetitionPlan supplies execution and validation keys.
\* Source: CLI minutes and side-results.json. Sink: timer and positional pairs.
\* Failures: a large timer runs at 1 ms; partial keys shift positional pairs.
\* Invariants: TimerSafe and KeysComplete forbid these failures.
\* Expect: old guards fail both checks. These invariants follow the review.
\* PR 2154 threads: discussion_r4624089802 and discussion_r4624089824.
\* Review: 0 covered, 2 added, 0 gap. Parsing and metric content are oracles.
\* Scope: each integer key stands for one fixture and repetition pair.
\* Property: coding-report.test.ts and coding-compare-script.test.ts.
\* Result: fixed passes in 640 states. No new code bug was found.
\* Control: NoCheckKeys fails KeysComplete; NoCheckTimer fails TimerSafe.
\* Replay: Missing keys and 35792 minutes fail on HEAD and pass with the fixes.
\* Cost: this review took about 12 agent minutes total. Each TLC run took under 1 second.
\* Gate: 401 eval tests, eval type check, and shared ESLint pass.
\* Run each EvalComparisonInputs config with EvalComparisonInputsMC on each fix commit.
\* Refactor: one code plan replaces two copies. Expect no new model failure.
\* Result: all input checks keep their prior results. No new code bug was found.
\* Property: coding-fixtures.test.ts checks literal names, versions, order, and fresh entries.
\* Sabotage: omit one fixture from the shared plan. The independent code test fails.
\* Restored plan passes. The plan builder is outside the input model.
\* Cost: the simplification took about 3 agent minutes across these models.
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Inputs, Minutes, ExpectedKeys, CheckKeys, CheckTimer
VARIABLES keys, agrees, minutes, result
vars == <<keys, agrees, minutes, result>>
KeySet == {keys[i] : i \in DOMAIN keys}
Complete == KeySet = ExpectedKeys /\ Len(keys) = Cardinality(ExpectedKeys) /\ agrees
Init == /\ keys \in Inputs /\ agrees \in BOOLEAN /\ minutes \in Minutes
        /\ result = "pending"
Validate == /\ result = "pending"
            /\ result' = IF (~CheckKeys \/ Complete) /\ (~CheckTimer \/ minutes <= 35791)
                          THEN "accepted" ELSE "rejected"
            /\ UNCHANGED <<keys, agrees, minutes>>
Next == Validate
Spec == Init /\ [][Next]_vars
KeysComplete == result = "accepted" => Complete
TimerSafe == result = "accepted" => minutes <= 2147483647 \div 60000
====
