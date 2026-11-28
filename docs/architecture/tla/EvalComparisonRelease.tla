---- MODULE EvalComparisonRelease ----
\* Source: executeLockedComparisonFlow ends with a published report.
\* Sink: executeOwnedComparisonFlow releases the output lock and returns.
\* Failures: success returns after an observed interrupt.
\* Failures: a failed or interrupted run keeps its completion marker.
\* Invariant: SafeOutcome prevents these failures.
\* Expect: the old release fails SafeOutcome. These invariants follow review.
\* Scope: this follows the "completed" phase of EvalPublication.
\* Scope: report removal succeeds here. A signal after release has no effect.
\* Scope: observed means that the signal handler ran. Scratch removal is outside.
\* PR 2154 discussion_r4719753653. Review: 0 covered, 1 added, 0 gap.
\* Split: a separate module keeps the EvalPublication states and controls.
\* Result: fixed passes in 5 states. NoSyncRelease and NoRemove fail SafeOutcome.
\* Replay: three tests in coding-compare-driver.test.ts fail on the old release.
\* Replay: without the removal after a failed release, one test fails.
\* Findings: no new bug was found by TLC. The old tail also awaited the scratch
\* removal after the release. Code reading found it, and the same fix covers it.
\* Property: the interrupt test arms a signal in each final async removal.
\* Simplify: OwnedRemoval was vacuous, so it and its variable were removed.
\* Gate: 408 eval tests, eval type check, and shared ESLint pass.
\* Cost: about 10 agent minutes for both fixes. Each TLC run took under 1 second.
\* Run each EvalComparisonRelease config with the MC module on each fix commit.
\* A model check checks this model. It does not prove the code correct.
EXTENDS Naturals
CONSTANTS SyncRelease, RemoveOnFailure
VARIABLES phase, interrupted, marker, outcome
vars == <<phase, interrupted, marker, outcome>>
Init == /\ phase = "check" /\ interrupted = FALSE /\ marker = TRUE
        /\ outcome = "pending"
Interrupt == /\ ~interrupted /\ outcome = "pending" /\ interrupted' = TRUE
             /\ UNCHANGED <<phase, marker, outcome>>
\* The old code checks the signal, then awaits the release.
Check == /\ ~SyncRelease /\ phase = "check" /\ phase' = "release"
         /\ marker' = (marker /\ ~interrupted)
         /\ outcome' = IF interrupted THEN "interrupted" ELSE outcome
         /\ UNCHANGED interrupted
\* The new code checks and releases in one step.
\* A failed release keeps the lock, so the removal is still owned.
Release == /\ phase = (IF SyncRelease THEN "check" ELSE "release")
           /\ phase' = "done"
           /\ \E released \in BOOLEAN :
                LET seen == SyncRelease /\ interrupted
                    remove == seen \/ (~released /\ RemoveOnFailure)
                IN /\ marker' = (marker /\ ~remove)
                   /\ outcome' = IF outcome # "pending" THEN outcome
                                 ELSE IF seen THEN "interrupted"
                                 ELSE IF released THEN "success" ELSE "failed"
           /\ UNCHANGED interrupted
Next == Interrupt \/ Check \/ Release
Spec == Init /\ [][Next]_vars
SafeOutcome == /\ (outcome = "success" => ~interrupted /\ marker)
               /\ (outcome \in {"failed", "interrupted"} => ~marker)
====
