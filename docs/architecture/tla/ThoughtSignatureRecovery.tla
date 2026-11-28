---- MODULE ThoughtSignatureRecovery ----
\* Source: recursivelyMakeClineRequests catches a failed tool stream. Sink: ask, user reply, and the next request.
\* Thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4673468489
\* Failure: stopping the loop leaves no recovery action. Invariant: RecoverableStop.
\* Failure: recovery resends the failed tool turn, loses its results, or overlaps its presenter.
\* Invariants: ExplicitRecovery, NoToolReplay, RecoveryHasReceipt, NoResumeUnderPresenter.
\* Expect the old return path to violate RecoverableStop. Replay failures and deadlines through the real presenter.
\* Oracle: a tool has started and may still be running when the stream fails. User input is an explicit event.
\* Scope: in-memory recovery, not restart persistence or a provider's later choice of tools.
\* Result: the old model fails RecoverableStop after Fail (3 states). Both old runtime cases stay Running.
\* Six real-presenter replays cover failure, deadline, late tool settlement, both reply paths, queued input, and decline.
\* Fixed holds (11 states). NoAsk, Automatic, Presenter, Receipt, and Replay each violate their named invariant.
\* Recovery waits for the presenter, then sends tool inputs and recorded results as text. Protocol calls are not resent.
\* This round: 0 covered, 1 added, 0 gap. PR totals: 2 covered, 14 added, 0 gap.
\* Null result: no new failure in the fixed bounded model. New provider tool choices and restart recovery remain outside scope.
\* Validation: 253 focused tests and all 14 full-test tasks pass. The extension suite passes 15,547 tests.
\* Types, lint, formatting, both Knip checks, lifecycle checks, and both signature model gates pass.
\* Suppression counts stay equal. Cost: about 10 agent minutes.
\* Review: cancel failed-turn persistence before joining the presenter, then open the recovery ask.
\* https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4674061742
\* https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4674161300
\* Expect a persistence-dependent presenter to block settlement and late tool messages to invalidate an overlapping ask.
\* Invariants: CanSettleFailedTurn and PromptAfterPresenter. Keep completion and pending-action safeguards.
\* Grounding: https://devblogs.microsoft.com/dotnet/are-deadlocks-still-possible-with-await/
\* Grounding: https://docs.python.org/3.12/library/asyncio-task.html#task-groups
\* Result: child completion fails both old runtime cases with a held presenter lock. Late error leaves the old ask superseded.
\* Fixed: cancel the failed persistence generation, join its presenter, then open the protected recovery ask.
\* No second presenter wait is needed after the reply. Completion stays uncommitted and pending actions stay intact.
\* Fixed holds (11 states). All seven negative variants fail, including Persistence and LateMessage.
\* Nine recovery cases and 439 focused tests pass, including the real child attempt_completion handler.
\* Review round: 0 covered, 3 added, 0 gap; one finding concerns a spec. PR totals: 2 covered, 17 added, 0 gap.
\* Null result: no further failure in the fixed bounded model. Uncooperative tools can still require task cancellation.
\* Validation: all 14 full-test tasks pass, including 15,554 extension tests. Types, lint, formatting, and both Knip checks pass.
\* Lifecycle checks and all three relevant TLA+ gates pass. Suppression counts stay equal. Cost: about 15 agent minutes.
EXTENDS Naturals
VARIABLES stage, busy, blocked, authorized, receipt, executions
vars == <<stage, busy, blocked, authorized, receipt, executions>>
OfferRecovery == TRUE
RequireReply == TRUE
PreserveReceipt == TRUE
ReplayTool == FALSE
CancelPersistence == TRUE
WaitBeforeAsk == TRUE
Init == /\ stage = "streaming" /\ busy \in BOOLEAN
        /\ blocked \in (IF busy THEN BOOLEAN ELSE {FALSE})
        /\ authorized = FALSE /\ receipt = FALSE /\ executions = 1
Fail == /\ stage = "streaming"
        /\ stage' = IF ~OfferRecovery THEN "stopped" ELSE IF WaitBeforeAsk THEN "settling" ELSE "waiting"
        /\ blocked' = IF CancelPersistence THEN FALSE ELSE blocked
        /\ UNCHANGED <<busy, authorized, receipt, executions>>
FinishTool == /\ busy /\ ~blocked /\ busy' = FALSE
              /\ UNCHANGED <<stage, blocked, authorized, receipt, executions>>
OpenAsk == /\ stage = "settling" /\ ~busy /\ stage' = "waiting"
           /\ UNCHANGED <<busy, blocked, authorized, receipt, executions>>
Reply == /\ stage = "waiting" /\ stage' = "ready" /\ authorized' = TRUE
         /\ UNCHANGED <<busy, blocked, receipt, executions>>
Resume == /\ (stage = "ready" \/ (~RequireReply /\ stage = "waiting"))
          /\ stage' = "resumed"
          /\ receipt' = PreserveReceipt /\ executions' = IF ReplayTool THEN 2 ELSE executions
          /\ UNCHANGED <<busy, blocked, authorized>>
Cancel == /\ stage \in {"settling", "waiting", "ready"} /\ stage' = "cancelled"
          /\ UNCHANGED <<busy, blocked, authorized, receipt, executions>>
Next == Fail \/ FinishTool \/ OpenAsk \/ Reply \/ Resume \/ Cancel
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in {"streaming", "settling", "waiting", "ready", "resumed", "stopped", "cancelled"}
          /\ busy \in BOOLEAN /\ blocked \in BOOLEAN /\ authorized \in BOOLEAN
          /\ receipt \in BOOLEAN /\ executions \in 1..2
RecoverableStop == stage # "stopped"
ExplicitRecovery == stage = "resumed" => authorized
NoToolReplay == executions = 1
RecoveryHasReceipt == stage = "resumed" => receipt
NoResumeUnderPresenter == stage = "resumed" => ~busy
CanSettleFailedTurn == stage \in {"settling", "waiting", "ready"} => ~blocked
PromptAfterPresenter == stage = "waiting" => ~busy
====
