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
\* PR 2154 discussion_r4725130157: a cleanup error can keep a complete report.
\* Review: 0 covered, 1 added, 0 gap. Add the locked flow error as an oracle.
\* Source: executeLockedComparisonFlow cleanup. Sink: owned report and release.
\* Failure: a cleanup error returns failure but keeps the completion marker.
\* Invariant: SafeOutcome also checks failure from the locked flow.
\* Expect: NoFlowRollback fails. No new code bug is expected.
\* Scope: report removal succeeds. Error identity is checked in code tests.
\* Result: fixed passes in 7 states. All three controls fail SafeOutcome.
\* Replay: both cleanup error cases fail on the old code and pass on the fix.
\* Property: coding-compare-driver.test.ts checks rollback with and without error.
\* Property: rollback holds the lock and preserves each error by identity.
\* Findings: TLC found no new code bug. There was no false alarm.
\* Simplify: use outcome for the flow error. No new variable is needed.
\* Gate: 410 eval tests, eval and extension type checks, and shared ESLint pass.
\* Gate: all 8 fixed eval configs pass; all 13 negative controls fail as expected.
\* Lint: src ESLint excludes scripts. Suppression counts did not change.
\* Cost: about 10 agent minutes for both findings. Each TLC run took under 1 second.
\* Refactor: executeOwnedComparisonFlow owns the terminal outcome and rollback.
\* Source: executeLockedComparisonFlow appends body and cleanup errors in order.
\* Sink: the owner removes reports before synchronous release, then returns.
\* Expect: SafeOutcome and all control results stay the same. No new bug is expected.
\* The worktree removal loop keeps its order. Its command result is an oracle.
\* One error list replaces the failure sentinel and nested error collections.
\* Result: fixed still passes in 7 states. All three controls fail SafeOutcome.
\* Sabotage: omit the owner's rollback. Both publication error tests fail.
\* Property: eight body value and cleanup cases preserve errors in order.
\* Replay: the old code loses an undefined throw in both cleanup cases.
\* Findings: code tests found that sentinel error. TLC found no new bug.
\* Scope: error values and order are code tests, not states in this model.
\* Gate: 419 eval tests, both type checks, shared ESLint, and formatting pass.
\* Gate: all 8 fixed eval configs pass; all 13 negative controls fail as expected.
\* Cost: the refactor took about 6 agent minutes. Each TLC run took under 1 second.
EXTENDS Naturals
CONSTANTS SyncRelease, RemoveOnFailure, RemoveOnFlowFailure
VARIABLES phase, interrupted, marker, outcome
vars == <<phase, interrupted, marker, outcome>>
Init == /\ phase = "cleanup" /\ interrupted = FALSE /\ marker = TRUE
        /\ outcome = "pending"
\* Cleanup can fail after publication. The rest of the locked flow is an oracle.
Cleanup == /\ phase = "cleanup" /\ phase' = "check"
           /\ \E failed \in BOOLEAN :
                /\ outcome' = IF failed THEN "failed" ELSE "pending"
                /\ marker' = marker /\ ~(failed /\ RemoveOnFlowFailure)
           /\ UNCHANGED interrupted
Interrupt == /\ ~interrupted /\ phase # "done" /\ interrupted' = TRUE
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
Next == Cleanup \/ Interrupt \/ Check \/ Release
Spec == Init /\ [][Next]_vars
SafeOutcome == phase = "done" => /\ (outcome = "success" => ~interrupted /\ marker)
               /\ (outcome \in {"failed", "interrupted"} => ~marker)
====
