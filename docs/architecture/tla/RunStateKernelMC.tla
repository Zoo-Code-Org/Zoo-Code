---- MODULE RunStateKernelMC ----
\* Model-checking settings for RunStateKernel. Source: Next. Sink: MCSpec and the TLC configs.
\* Failure: a model limit changes the shared transition rules. Keep limits here; the core has no finite cap.
\* Expected: 5160 states pass; 11 sabotage configs fail. Result: all match, with no new model bug.
\* Cost: about 20 seconds for all configs. PR 2244, discussion_r4633780176 is a file-layout gap.
\* Each override replaces one guard or effect. MCNext bounds successors; it does not add a production guard.
EXTENDS RunStateKernel

CONSTANTS MaxAsks, MaxGen
BoundedAskTimestamps == 1..MaxAsks
MCNext == Next /\ n' <= MaxAsks /\ gen' <= MaxGen
MCSpec == Init /\ [][MCNext]_vars

\* Reuse: an ask can carry the askTs of an earlier ask (issue 2365).
AskTsAny(t) == TRUE
\* ResumeResetsLatches: the first start clears the latches, as resumeAfterDelegation did before.
InitializedResetsLatches == abort' = FALSE /\ abandoned' = FALSE /\ disposed' = FALSE
StreamStartAnyPhase == TRUE
StreamEndResetsGen == 0
AskStartIgnoresAbort == phase = "running"
SettleAny(k) == TRUE
AcceptIgnoresTs(k) == phase = "running" /\ ~abort
AcceptKeepsAsk == ask
ReasonOverwrites == TRUE
AbandonAnyTime == TRUE
DisposeKeepsAbort == abort

====
