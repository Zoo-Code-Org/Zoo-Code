---- MODULE McpConnectionOwnership ----
EXTENDS Naturals
\* Source: McpHub.deleteConnection removes a connection and awaits SDK cleanup.
\* Sink: isCurrentOAuthConnection gates continuations; cleanup must preserve a replacement.
\* Failure: removing the closing set permits access while the old connection remains registered.
\* Failure: cleanup by server name removes a replacement published during the await.
\* Invariants: NoStaleAccess, ReplacementRetained, and NoLateSetup.
\* Expect: synchronous removal replaces the closing-set guard. No new defect is expected.
\* Cost: one agent; a two-connection model, property tests, and a runtime refactor.
\* Result: fixed holds in 28 states. LateDetach fails at 5, DeleteReplacement at 11, LateSetup at 9.
\* Finding: the refactor needs cancellation to invalidate its reconnect setup permit.
\* Replay: the held HTTP initialize case passes after cancelling the owned setup.
\* Runtime sabotage: late registry removal fails two tests; missing setup cancellation fails one.
\* Review ratchet: PR #2762, follow-up D in the supplied review. Added 1, covered 0, gap 0.
\* Expect: StopReconnect without KeepStoppedRow violates RecoveryVisible.
\* Cost: one agent; row visibility model and real HTTP regression cases.
\* Follow-up result: LostRecoveryRow fails at 10 states. Cancel and timeout fail before the fix.
\* Replay: both error rows are posted to the panel and can restart against a real HTTP server.
\* Runtime sabotage: removing recovery fails the cancel and timeout cases. A later delete still wins.
\* Gap: the model does not describe SDK resource cleanup or browser behavior.
\* Simplification: McpHub.stopOAuthReconnect performs StopReconnect as one synchronous operation.
\* Source: an abort callback supplies the owner, revision, validated config, and reason.
\* Sink: cleanup starts, and a cancel or timeout retains the error row before any await.
\* Expect: existing RecoveryVisible and ReplacementRetained still hold. No new defect is expected.
\* Cost: one agent; function extraction with no extra model state or dependencies.
\* Simplification result: fixed holds in 28 states and all four failure variants still fail.
\* Null result: all 17 HTTP cases pass after extraction. No new runtime defect was found.
\* Runtime sabotage: removing the extracted recovery step fails cancel and timeout cases.
CONSTANTS DetachBeforeClose, CheckClosing, PreserveReplacement, GuardSetup, KeepStoppedRow
\* registered = 3 is a disconnected row with an error and an enabled retry action.
VARIABLES registered, closing, staleAccess, replacementLost, permit, setup, latePublish, recoveryRequired
vars == <<registered, closing, staleAccess, replacementLost, permit, setup, latePublish, recoveryRequired>>
Init ==
    /\ registered = 1 /\ closing = 0
    /\ staleAccess = FALSE /\ replacementLost = FALSE
    /\ permit = TRUE /\ setup = TRUE /\ latePublish = FALSE /\ recoveryRequired = FALSE
BeginClose ==
    /\ closing = 0 /\ registered = 1
    /\ closing' = 1
    /\ registered' = IF DetachBeforeClose THEN 0 ELSE registered
    /\ UNCHANGED <<permit, setup, latePublish, recoveryRequired, staleAccess, replacementLost>>
ContinueOld ==
    /\ staleAccess' = (staleAccess \/ (registered = 1 /\ closing = 1 /\ ~CheckClosing))
    /\ UNCHANGED <<registered, closing, replacementLost, permit, setup, latePublish, recoveryRequired>>
PublishReplacement ==
    /\ closing = 1 /\ registered # 2
    /\ registered' = 2 /\ recoveryRequired' = FALSE
    /\ UNCHANGED <<closing, staleAccess, replacementLost, permit, setup, latePublish>>
CompleteClose ==
    /\ closing = 1
    /\ registered' = IF PreserveReplacement /\ registered \in {2, 3} THEN registered ELSE 0
    /\ closing' = 2
    /\ replacementLost' = (replacementLost \/ (registered \in {2, 3} /\ ~PreserveReplacement))
    /\ UNCHANGED <<staleAccess, permit, setup, latePublish, recoveryRequired>>
CancelSetup ==
    /\ permit' = FALSE
    /\ UNCHANGED <<registered, closing, staleAccess, replacementLost, setup, latePublish, recoveryRequired>>
PublishSetup ==
    /\ setup
    /\ setup' = FALSE
    /\ latePublish' = (~permit /\ ~GuardSetup)
    /\ UNCHANGED <<registered, closing, staleAccess, replacementLost, permit, recoveryRequired>>
\* Cancel or a callback timeout stops reconnect, but retains an error row.
StopReconnect ==
    /\ registered = 2
    /\ registered' = IF KeepStoppedRow THEN 3 ELSE 0
    /\ recoveryRequired' = TRUE
    /\ UNCHANGED <<closing, staleAccess, replacementLost, permit, setup, latePublish>>
NoLateSetup == ~latePublish
RecoveryVisible == recoveryRequired => registered = 3
Next == StopReconnect \/ BeginClose \/ ContinueOld \/ PublishReplacement \/ CompleteClose \/ CancelSetup \/ PublishSetup
Spec == Init /\ [][Next]_vars
TypeOK == /\ registered \in 0..3 /\ closing \in 0..2
          /\ staleAccess \in BOOLEAN /\ replacementLost \in BOOLEAN
          /\ permit \in BOOLEAN /\ setup \in BOOLEAN /\ latePublish \in BOOLEAN
          /\ recoveryRequired \in BOOLEAN
NoStaleAccess == ~staleAccess
ReplacementRetained == ~replacementLost
====
