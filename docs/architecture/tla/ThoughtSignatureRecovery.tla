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
EXTENDS Naturals
VARIABLES stage, busy, authorized, receipt, executions
vars == <<stage, busy, authorized, receipt, executions>>
OfferRecovery == TRUE
RequireReply == TRUE
WaitForPresenter == TRUE
PreserveReceipt == TRUE
ReplayTool == FALSE
Init == /\ stage = "streaming" /\ busy \in BOOLEAN
        /\ authorized = FALSE /\ receipt = FALSE /\ executions = 1
Fail == /\ stage = "streaming" /\ stage' = IF OfferRecovery THEN "waiting" ELSE "stopped"
        /\ UNCHANGED <<busy, authorized, receipt, executions>>
FinishTool == /\ busy /\ busy' = FALSE /\ UNCHANGED <<stage, authorized, receipt, executions>>
Reply == /\ stage = "waiting" /\ stage' = "ready" /\ authorized' = TRUE
         /\ UNCHANGED <<busy, receipt, executions>>
Resume == /\ (stage = "ready" \/ (~RequireReply /\ stage = "waiting"))
          /\ (~busy \/ ~WaitForPresenter) /\ stage' = "resumed"
          /\ receipt' = PreserveReceipt /\ executions' = IF ReplayTool THEN 2 ELSE executions
          /\ UNCHANGED <<busy, authorized>>
Cancel == /\ stage \in {"waiting", "ready"} /\ stage' = "cancelled"
          /\ UNCHANGED <<busy, authorized, receipt, executions>>
Next == Fail \/ FinishTool \/ Reply \/ Resume \/ Cancel
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in {"streaming", "waiting", "ready", "resumed", "stopped", "cancelled"}
          /\ busy \in BOOLEAN /\ authorized \in BOOLEAN /\ receipt \in BOOLEAN /\ executions \in 1..2
RecoverableStop == stage # "stopped"
ExplicitRecovery == stage = "resumed" => authorized
NoToolReplay == executions = 1
RecoveryHasReceipt == stage = "resumed" => receipt
NoResumeUnderPresenter == stage = "resumed" => ~busy
====
