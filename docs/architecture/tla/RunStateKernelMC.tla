---- MODULE RunStateKernelMC ----
\* Model-checking settings for RunStateKernel. Each operator replaces one guard or effect in one sabotage config.
EXTENDS RunStateKernel

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
