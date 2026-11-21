---- MODULE EvalOutputOwnership ----
\* Source: prepareOutputDirectory resolves an alias and the caller locks A.
\* Sinks: executeSideGeneration and executeOwnedComparisonFlow use that path.
\* Failure: a retargeted alias sends a write or rollback into another lock.
\* Invariant: OwnedTarget requires each sink to use the locked directory.
\* Expect: the alias path fails. This invariant follows the review.
\* PR 2154 threads: discussion_r4624089822 and discussion_r4624089838.
\* Review: 0 covered, 2 added, 0 gap. Directory writes and locks are oracles.
\* Scope: the canonical directories stay in place; only the alias changes.
\* Property: coding-compare-driver.test.ts checks writes and interruption.
\* Result before simplification: fixed passes in 6 states. No new code bug was found.
\* Control: NoPinOutput fails OwnedTarget.
\* Replay: Both alias tests fail on HEAD, for writes and rollback; the fixes pass.
\* Cost: this review took about 12 agent minutes total. Each TLC run took under 1 second.
\* Gate: 401 eval tests, eval type check, and shared ESLint pass.
\* Run each EvalOutputOwnership config with EvalOutputOwnershipMC on each fix commit.
\* Simplify: write and rollback share Sink. The target also marks completion.
\* Expect: OwnedTarget still holds and NoPinOutput still fails.
\* Result: fixed passes in 4 states, down from 6. The negative control still fails.
\* Cost: the simplification took about 3 agent minutes across these models.
EXTENDS Naturals
CONSTANT PinOutput
VARIABLES alias, target
vars == <<alias, target>>
Init == /\ alias = "A" /\ target = "none"
Retarget == /\ target = "none" /\ alias = "A" /\ alias' = "B"
            /\ UNCHANGED target
Sink == /\ target = "none"
        /\ target' = IF PinOutput THEN "A" ELSE alias
        /\ UNCHANGED alias
Next == Retarget \/ Sink
Spec == Init /\ [][Next]_vars
OwnedTarget == target \in {"none", "A"}
====
