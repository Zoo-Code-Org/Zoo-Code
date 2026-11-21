---- MODULE EvalPublication ----
\* Source: executeSideFlow and publishComparisonReport start publication.
\* Sink: publishGeneration writes commit after data, then returns completion.
\* Failure: a failed or interrupted call returns a completion marker.
\* Failure: a completion marker exists before all data writes finish.
\* Invariants: SafeReturn and MarkerLast prevent these failures.
\* Expect: guards hold; removed interruption checks fail SafeReturn.
\* Scope: atomic writes and cleanup are oracles. Cleanup can fail and throw.
\* Scope: the caller owns the output lock. Crashes and lock loss are excluded.
\* Result: fixed passes in 25 states. No new protocol bug was found.
\* Sabotage: NoInterrupt fails SafeReturn; EarlyCommit fails MarkerLast.
\* Replay: both code mutations fail publication.test.ts; restored code passes.
\* Property: publication.test.ts checks 68 bounded schedules and cleanup failure.
\* Gate: 401 eval tests, eval type check, and shared ESLint pass.
\* Lint: src ESLint excludes scripts. Shared ESLint checks the changed code.
\* Suppression counts did not change. No suppression was added.
\* Refactor: comparison rollback errors now retain both failure causes.
\* This error-reporting change is a code finding, not a TLC finding.
\* Cost: initial work took 8 agent minutes; this review took about 12 minutes total.
\* Each TLC run took less than one second. No new code bug was found.
\* Run all EvalPublication configs and the property test on each fix commit.
\* Review: 0 covered, 1 added, 4 gap. New checks follow the review.
\* PR 2154 discussion_r4624089795: gap; module layout is not a state invariant.
\* The settings now live in EvalPublicationMC.
\* PR 2154 discussion_r4624089844: CommitAllowed checks the iterator boundary.
\* Expect: the old pre-commit check fails CommitAllowed; the fix passes.
\* PR 2154 discussion_r4624089849: gap; this model does not check README claims.
\* PR 2154 discussion_r4624089854: gap; compatibility rules are outside this model.
\* PR 2154 discussion_r4624089860: gap; pricing metadata is outside this model.
\* Replay: the iterator test fails on HEAD and passes with the pre-commit check.
\* NoPreCommit fails CommitAllowed. The fixed model still has 25 states.
\* Run: TLC -config EvalPublication.cfg EvalPublicationMC; repeat all variants.
\* Simplify: derive result from phase. Fail also covers the former Stop action.
\* Expect: all invariant results and the 25 reachable states stay the same.
\* Result: 25 states remain. All three negative controls fail the same invariants.
\* Cost: the simplification took about 3 agent minutes across these models.
\* A model check checks this model. It does not prove the code correct.
EXTENDS Naturals
CONSTANTS CheckInterrupt, CommitLast, CheckBeforeCommit
VARIABLES phase, written, interrupted, marker, badCommit
vars == <<phase, written, interrupted, marker, badCommit>>
result == IF phase \in {"writing", "rollback"} THEN "pending" ELSE phase
Init == /\ phase = "writing" /\ written = 0 /\ interrupted = FALSE
        /\ marker = FALSE /\ badCommit = FALSE
Interrupt == /\ ~interrupted /\ result = "pending"
             /\ interrupted' = TRUE
             /\ UNCHANGED <<phase, written, marker, badCommit>>
Write == /\ phase = "writing" /\ written < 2
         /\ ~(interrupted /\ (IF written = 1 THEN CheckBeforeCommit ELSE CheckInterrupt))
         /\ badCommit' = (badCommit \/ (written = 1 /\ interrupted))
         /\ written' = written + 1
         /\ marker' = (IF CommitLast THEN written = 1 ELSE TRUE)
         /\ UNCHANGED <<phase, interrupted>>
Fail == /\ phase = "writing" /\ phase' = "rollback"
        /\ UNCHANGED <<written, interrupted, marker, badCommit>>
Complete == /\ phase = "writing" /\ written = 2
            /\ ~(CheckInterrupt /\ interrupted)
            /\ phase' = "completed"
            /\ UNCHANGED <<written, interrupted, marker, badCommit>>
Rollback == /\ phase = "rollback" /\ phase' = "failed"
            /\ marker' = FALSE
            /\ UNCHANGED <<written, interrupted, badCommit>>
\* Failed cleanup throws. The marker can remain, but success cannot return.
CleanupFailure == /\ phase = "rollback" /\ phase' = "cleanupFailed"
                  /\ UNCHANGED <<written, interrupted, marker, badCommit>>
Next == Interrupt \/ Write \/ Fail \/ Complete \/ Rollback \/ CleanupFailure
Spec == Init /\ [][Next]_vars
CommitAllowed == ~badCommit
MarkerLast == marker => written = 2
SafeReturn == /\ (result = "completed" => ~interrupted /\ marker)
              /\ (result = "failed" => ~marker)
====
