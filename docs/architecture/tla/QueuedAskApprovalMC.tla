---- MODULE QueuedAskApprovalMC ----
\* Model-checking settings and sabotage variants for QueuedAskApproval.
\* Each variant is an override for QueueMayApprove in the cfg files.
EXTENDS QueuedAskApproval

\* Unfixed: the pre-fix drain. Any queued message answers any ask, so a
\* command the policy did not approve is resolved by the queue (#1574).
QueueMayApproveUnfixed(t, a, f) == TRUE

\* NoAskTimeGate: the claim gate is dropped. Only the consume-site re-check
\* decides, so a command the ask-time policy denied can still be consumed.
QueueMayApproveNoAskTimeGate(t, a, f) == t # "command" \/ f

\* NoRecheck: the claim gate alone decides. The fresh re-check is skipped,
\* so a command the fresh policy denies is still consumed.
QueueMayApproveNoRecheck(t, a, f) == t # "command" \/ a

====
