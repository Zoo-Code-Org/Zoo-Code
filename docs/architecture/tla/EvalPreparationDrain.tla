---- MODULE EvalPreparationDrain ----
\* Source: coding-preparation IPC PID. Sink: runCompareSide finishes cleanup.
\* Failure: exit starts cleanup before the queued PID reaches the guard.
\* Invariant: Drained requires delivery and group termination before return.
\* Expect: finish on exit fails. This invariant follows the review.
\* PR 2154 thread: discussion_r4624089806. Review: 0 covered, 1 added, 0 gap.
\* Scope: one queued PID survives exit. Group termination is an oracle.
\* Node close follows queued IPC delivery. The error path has no spawned PID.
\* Property: coding-compare-driver.test.ts replays exit, message, then close.
\* Result: fixed passes in 5 states. No new code bug was found.
\* Control: NoWaitClose fails Drained.
\* Replay: The exit/message/close test fails on HEAD and passes with close.
\* Cost: this review took about 12 agent minutes total. Each TLC run took under 1 second.
\* Gate: 401 eval tests, eval type check, and shared ESLint pass.
\* Run each EvalPreparationDrain config with EvalPreparationDrainMC on each fix commit.
EXTENDS Naturals
CONSTANT WaitClose
VARIABLES exited, delivered, finished, running
vars == <<exited, delivered, finished, running>>
Init == /\ exited = FALSE /\ delivered = FALSE /\ finished = FALSE /\ running = TRUE
Exit == /\ ~exited /\ exited' = TRUE /\ UNCHANGED <<delivered, finished, running>>
Deliver == /\ ~delivered /\ delivered' = TRUE /\ UNCHANGED <<exited, finished, running>>
Finish == /\ exited /\ ~finished /\ (~WaitClose \/ delivered)
          /\ finished' = TRUE /\ running' = IF delivered THEN FALSE ELSE running
          /\ UNCHANGED <<exited, delivered>>
Next == Exit \/ Deliver \/ Finish
Spec == Init /\ [][Next]_vars
Drained == finished => delivered /\ ~running
====
