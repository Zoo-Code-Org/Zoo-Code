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
\* Gate: 391 eval tests, eval type check, and shared ESLint pass.
\* Lint: src ESLint excludes scripts. Shared ESLint checks the changed code.
\* Suppression counts did not change. No suppression was added.
\* Refactor: comparison rollback errors now retain both failure causes.
\* This error-reporting change is a code finding, not a TLC finding.
\* Cost: about 8 agent minutes. Each TLC run took less than one second.
\* Run all EvalPublication configs and the property test on each fix commit.
\* Review: 0 covered, 0 added, 0 gap. No review threads read for this spec.
\* A model check checks this model. It does not prove the code correct.
EXTENDS Naturals
CONSTANTS CheckInterrupt, CommitLast
VARIABLES phase, written, interrupted, marker, result
vars == <<phase, written, interrupted, marker, result>>
Init == /\ phase = "writing" /\ written = 0 /\ interrupted = FALSE
        /\ marker = FALSE /\ result = "pending"
Interrupt == /\ ~interrupted /\ result = "pending"
             /\ interrupted' = TRUE
             /\ UNCHANGED <<phase, written, marker, result>>
Write == /\ phase = "writing" /\ written < 2
         /\ ~(CheckInterrupt /\ interrupted)
         /\ written' = written + 1
         /\ marker' = (IF CommitLast THEN written = 1 ELSE TRUE)
         /\ UNCHANGED <<phase, interrupted, result>>
Fail == /\ phase = "writing" /\ phase' = "rollback"
        /\ UNCHANGED <<written, interrupted, marker, result>>
Stop == /\ phase = "writing" /\ CheckInterrupt /\ interrupted
        /\ phase' = "rollback"
        /\ UNCHANGED <<written, interrupted, marker, result>>
Complete == /\ phase = "writing" /\ written = 2
            /\ ~(CheckInterrupt /\ interrupted)
            /\ phase' = "done" /\ result' = "completed"
            /\ UNCHANGED <<written, interrupted, marker>>
Rollback == /\ phase = "rollback" /\ phase' = "done"
            /\ marker' = FALSE /\ result' = "failed"
            /\ UNCHANGED <<written, interrupted>>
\* Failed cleanup throws. The marker can remain, but success cannot return.
CleanupFailure == /\ phase = "rollback" /\ phase' = "done"
                  /\ result' = "cleanupFailed"
                  /\ UNCHANGED <<written, interrupted, marker>>
Next == Interrupt \/ Write \/ Fail \/ Stop \/ Complete \/ Rollback \/ CleanupFailure
Spec == Init /\ [][Next]_vars
MarkerLast == marker => written = 2
SafeReturn == /\ (result = "completed" => ~interrupted /\ marker)
              /\ (result = "failed" => ~marker)
====
