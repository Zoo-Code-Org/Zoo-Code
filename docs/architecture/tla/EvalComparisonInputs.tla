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
\* Source: side-results.json metrics. Sink: paired deltas, cost and outcome rows.
\* Failure: a null duration reads as zero and shows as a speedup.
\* Invariant: ValuesSafe accepts only well-formed values. It follows review.
\* PR 2154 discussion_r4719753641. Review: 0 covered, 1 added, 0 gap.
\* Expect: the old validator fails ValuesSafe. No new bug is expected.
\* Result: fixed passes in 696 states. NoCheckValues accepts a null duration.
\* Replay: the null duration test fails on the old validator and passes now.
\* Findings: no new code bug was found by TLC. No false alarm was found.
\* Property: coding-report.test.ts checks bad kinds for each report metric.
\* Gate: 408 eval tests, eval type check, and shared ESLint pass.
\* Lint: src ESLint excludes scripts. Suppression counts did not change.
\* Cost: about 10 agent minutes for both fixes. Each TLC run took under 1 second.
\* PR 2154 discussion_r4725130159: the test helper kept an absent duration.
\* Review: 0 covered, 0 added, 1 gap. This model cannot check test fixture creation.
\* Source: coding-report.test.ts check helper. Sink: validateSideResultFile.
\* Expect: no model change. ValueOk already permits an absent duration.
\* Property: serialize the whole fixture, then assert that durationMs is absent.
\* Sabotage: the old helper fails the absence assertion. The fixed helper passes.
\* Result: fixed passes in 696 states. All three controls fail their invariants.
\* Findings: no new code bug or false alarm was found. No model state was added.
\* Gate: 410 eval tests, eval and extension type checks, and shared ESLint pass.
\* Cost: shared with the EvalComparisonRelease review, about 10 agent minutes.
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Inputs, Minutes, ExpectedKeys, CheckKeys, CheckTimer, CheckValues
VARIABLES keys, agrees, minutes, metric, result
vars == <<keys, agrees, minutes, metric, result>>
\* A metric is one field that the report reads, and the kind of its JSON value.
Metrics == {"duration", "usd", "outcome"} \X {"valid", "absent", "null", "wrongType", "outOfRange"}
ValueOk == metric[2] = "valid" \/ metric = <<"duration", "absent">>
KeySet == {keys[i] : i \in DOMAIN keys}
Complete == KeySet = ExpectedKeys /\ Len(keys) = Cardinality(ExpectedKeys) /\ agrees
\* Values vary only with good keys and timer, because the checks are independent.
Init == /\ keys \in Inputs /\ agrees \in BOOLEAN /\ minutes \in Minutes
        /\ metric \in Metrics
        /\ metric # <<"duration", "valid">> => (Complete /\ minutes = 1)
        /\ result = "pending"
Validate == /\ result = "pending"
            /\ result' = IF (~CheckKeys \/ Complete) /\ (~CheckTimer \/ minutes <= 35791)
                           /\ (~CheckValues \/ ValueOk)
                          THEN "accepted" ELSE "rejected"
            /\ UNCHANGED <<keys, agrees, minutes, metric>>
Next == Validate
Spec == Init /\ [][Next]_vars
KeysComplete == result = "accepted" => Complete
ValuesSafe == result = "accepted" => ValueOk
TimerSafe == result = "accepted" => minutes <= 2147483647 \div 60000
====
