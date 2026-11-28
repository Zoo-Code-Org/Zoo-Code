---- MODULE McpOAuthFlowEnd ----
EXTENDS Naturals
\* Source: McpHub.createOAuthFlow registers one entry in oauthFlows.
\* McpOAuthFlow owns the completion promise. deleteConnection(), flow replacement in createOAuthFlow(),
\* dispose(), and the token-watcher error path remove or replace that entry.
\* Sink: McpHub.callTool awaits the re-auth promise, and the flow promise resolves
\* through McpOAuthFlow.finish.
\* Failure: a removed watcher leaves its flow pending, so the notification stays
\* open and tool calls that wait on the flow stay blocked (issue 2761).
\* Failure: an old flow removes the watcher of a newer flow, so the newer flow
\* can never time out or resolve.
\* Failure: a reconnect that throws in the token watcher leaves the flow pending.
\* Invariants: NoDuplicateFlow, NoOrphanFlow, ToolNotOrphaned, NoErrorLeak.
\* Fix rule: every watcher removal goes through one shared path that also ends
\* the flow, and a reconnect error ends the flow with a visible error.
\* Scope: timeouts, cancellation, and the toast paths end the flow inside the
\* flow itself; the model folds them into FlowEnds. Secret storage is an oracle.
\* Scope: at most two flows and one watcher per key. One tool call waits at a time.
\* Expect: Fixed holds. ReplaceLeak, DeleteLeak, DisposeLeak and ErrorLeak each fail.
\* Result: Fixed holds in 672 states. ReplaceLeak fails at 80 states (NoDuplicateFlow).
\* DeleteLeak fails at 80 states (NoOrphanFlow). DisposeLeak fails at 80 states
\* (NoOrphanFlow). ErrorLeak fails at 80 states (NoErrorLeak).
\* Property test: src/services/mcp/__tests__/mcp-oauth-flow.property.spec.ts.

\* Review ratchet: PR #2762, supplied review findings #1, #2, #3, #8 and #29.
\* Added: stale work must not reconnect or change a replacement connection.
\* Expect: the ownership guard blocks a stale continuation after each wait.
\* Cost: one agent, about 20 minutes across four models and their code tests.
\* Replay: 25 ownership cases and eight real HTTP cases pass. Guard sabotage fails.
\* Findings #42 and #44: corrected the invariant name, tool-wait check, and header.
\* Ratchet: covered 0, added 8. Retry and redirect findings have their own model.
\* Gap: task abort and scope step-up need separate source and sink models.
\* Simplification expectation: one flow owns cleanup and settlement; only one callback can claim its work.
\* Failure: token and toast callbacks both start reconnect work for the same flow.
\* Invariants: OneContinuation claims work once. ToolRequiresSuccess accepts only a connected outcome.
\* Scope: the claim and outcome oracles each describe one flow episode.
\* Sources: https://stately.ai/docs/invoke and https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
\* Cost: one agent; shared flow object and synchronous registry removal.
\* Result: DoubleClaim fails in 71 states; IgnoreOutcome in 51; StaleContinuation in 75.
\* Findings: one terminal outcome also closes review #10. No new legacy runtime defect was found.
\* Runtime sabotage: claim and outcome guards fail five and four tests when removed.
\* Replay: synchronous removal fails before the refactor. The new HTTP cancellation cases pass.
\* Covered: NoStaleWrite also requires a current-connection check after the panel update.
\* Review ratchet: PR #2762 follow-ups A and D. Added 2 timer rules, covered 0, gap 0.
\* Failure: the approval timer cuts short browser authentication or reconnect setup.
\* Expect: TimerOnlyWhileWaiting fails when claim or reconnect keeps the timer armed.
\* Cost: one agent; two timer transitions and fake-time properties.
\* Timer result: BrowserTimer fails at 3 states; ReconnectTimer fails at 4.
\* Replay: a late Authenticate click fails before the fix; waiting, browser, and reconnect tests pass.
\* Runtime sabotage: removing either timer cleanup fails its phase test.
\* Simplification: McpOAuthFlow.transitionTo owns the timer exit action for every phase change.
\* Failure: a terminal transition leaves the approval timer armed.
\* Invariant: TimerOnlyWhileWaiting includes ended flows as well as browser and reconnect work.
\* Expect: no new runtime defect. FinishTimer sabotage must fail; the existing guards must still hold.
\* Cost: one agent; one timer transition and terminal-outcome property cases.
\* Simplification result: fixed holds in 672 states; FinishTimer fails at 2 states.
\* Null result: terminal timer properties passed before and after extraction. No new runtime defect was found.
\* Runtime sabotage: removing shared timer cleanup or the terminal guard fails the phase tests.
CONSTANTS StopOnFinish
CONSTANTS StopOnClaim, StopOnReconnect
CONSTANTS CheckOutcome
CONSTANTS ClaimOnce
CONSTANTS GuardContinuation
CONSTANTS ReplaceEndsFlow   \* TRUE when a replacement flow ends the replaced flow
CONSTANTS DeleteEndsFlow    \* TRUE when deleteConnection ends the flow
CONSTANTS DisposeEndsFlows  \* TRUE when dispose ends all flows
CONSTANTS ErrorEndsFlow     \* TRUE when a reconnect error ends the flow

VARIABLES watcher     \* a watcher entry is registered for this key
VARIABLES pending     \* number of flows not yet ended (0 to 2)
VARIABLES toolWait    \* a tool call waits on the re-auth promise
VARIABLES errorLeak   \* latch: a reconnect error left its flow pending

VARIABLES current, active, staleWrite, claims, flowResult, toolRetried, timerPhase, timerArmed
vars == <<watcher, pending, toolWait, errorLeak, current, active, staleWrite, claims, flowResult, toolRetried, timerPhase, timerArmed>>

Init ==
    /\ timerPhase = "waiting" /\ timerArmed = TRUE
    /\ flowResult = "waiting" /\ toolRetried = FALSE
    /\ claims = 0
    /\ current = TRUE
    /\ active = TRUE
    /\ staleWrite = FALSE
    /\ watcher = FALSE
    /\ pending = 0
    /\ toolWait = FALSE
    /\ errorLeak = FALSE

\* connectToServer starts a flow. A replacement ends the old flow through the
\* shared path; without that rule the replaced flow stays pending forever.
StartFlow ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ UNCHANGED <<current, active, staleWrite>>
    /\ pending' = IF watcher /\ ReplaceEndsFlow THEN pending
                  ELSE IF pending < 2 THEN pending + 1 ELSE 2
    /\ watcher' = TRUE
    /\ UNCHANGED <<toolWait, errorLeak>>

\* callTool hits a 401 and starts the re-auth flow it waits on.
CallTool ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ UNCHANGED <<current, active, staleWrite>>
    /\ toolWait' = TRUE
    /\ pending' = IF watcher /\ ReplaceEndsFlow THEN pending
                  ELSE IF pending < 2 THEN pending + 1 ELSE 2
    /\ watcher' = TRUE
    /\ UNCHANGED errorLeak

\* deleteConnection removes the watcher. The shared path also ends the flow and
\* releases the waiting tool call.
DeleteConnection ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ UNCHANGED <<current, active, staleWrite>>
    /\ watcher' = FALSE
    /\ pending' = IF watcher /\ DeleteEndsFlow THEN pending - 1 ELSE pending
    /\ toolWait' = IF watcher /\ DeleteEndsFlow THEN FALSE ELSE toolWait
    /\ UNCHANGED errorLeak

\* The token watcher catches a reconnect error. The fix ends the flow and shows
\* the error on the server status; the old code only logged it.
WatcherError ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ UNCHANGED <<current, active, staleWrite>>
    /\ pending >= 1
    /\ errorLeak' = (errorLeak \/ ~ErrorEndsFlow)
    /\ pending' = IF ErrorEndsFlow THEN pending - 1 ELSE pending
    /\ watcher' = IF ErrorEndsFlow THEN FALSE ELSE watcher
    /\ toolWait' = IF ErrorEndsFlow THEN FALSE ELSE toolWait

\* A flow ends inside itself: timeout, cancel, or a completed sign-in.
FlowEnds ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ UNCHANGED <<current, active, staleWrite>>
    /\ pending >= 1
    /\ pending' = pending - 1
    /\ watcher' = FALSE
    /\ toolWait' = FALSE
    /\ UNCHANGED errorLeak

\* The hub is disposed. The shared path ends every flow and releases every wait.
Dispose ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ UNCHANGED <<current, active, staleWrite>>
    /\ watcher' = FALSE
    /\ pending' = IF DisposeEndsFlows THEN 0 ELSE pending
    /\ toolWait' = IF DisposeEndsFlows THEN FALSE ELSE toolWait
    /\ UNCHANGED errorLeak

Invalidate ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ current' = FALSE
    /\ UNCHANGED <<active, staleWrite, watcher, pending, toolWait, errorLeak>>

\* An await resumes after delete, disable, dispose, or replacement.
Continue ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ UNCHANGED claims
    /\ active
    /\ active' = FALSE
    /\ staleWrite' = (~current /\ ~GuardContinuation)
    /\ UNCHANGED <<current, watcher, pending, toolWait, errorLeak>>

NoStaleWrite == ~staleWrite

Claim ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ UNCHANGED <<flowResult, toolRetried>>
    /\ claims < 2
    /\ (claims = 0 \/ ~ClaimOnce)
    /\ claims' = claims + 1
    /\ UNCHANGED <<watcher, pending, toolWait, errorLeak, current, active, staleWrite>>

OneContinuation == claims <= 1

Settle ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ flowResult = "waiting"
    /\ flowResult' \in {"connected", "cancelled", "failed", "removed", "timed-out"}
    /\ UNCHANGED <<watcher, pending, toolWait, errorLeak, current, active, staleWrite, claims, toolRetried>>
RetryTool ==
    /\ UNCHANGED <<timerPhase, timerArmed>>
    /\ flowResult # "waiting"
    /\ toolRetried' = (toolRetried \/ (~CheckOutcome \/ flowResult = "connected"))
    /\ UNCHANGED <<watcher, pending, toolWait, errorLeak, current, active, staleWrite, claims, flowResult>>
ToolRequiresSuccess == toolRetried => flowResult = "connected"

\* One phase transition owns the approval timer exit action.
ChangeTimerPhase(nextPhase, stopTimer) ==
    /\ timerPhase' = nextPhase
    /\ timerArmed' = IF stopTimer THEN FALSE ELSE timerArmed
    /\ UNCHANGED <<watcher, pending, toolWait, errorLeak, current, active, staleWrite, claims, flowResult, toolRetried>>
ClaimBrowser ==
    /\ timerPhase = "waiting"
    /\ ChangeTimerPhase("browser", StopOnClaim)
StartReconnect ==
    /\ timerPhase \in {"waiting", "browser"}
    /\ ChangeTimerPhase("reconnecting", StopOnReconnect)
FinishTimer ==
    /\ timerPhase # "ended"
    /\ ChangeTimerPhase("ended", StopOnFinish)
TimerOnlyWhileWaiting == timerArmed => timerPhase = "waiting"

Next ==
    \/ FinishTimer
    \/ ClaimBrowser
    \/ StartReconnect
    \/ Settle
    \/ RetryTool
    \/ Claim
    \/ Invalidate
    \/ Continue
    \/ StartFlow
    \/ CallTool
    \/ DeleteConnection
    \/ WatcherError
    \/ FlowEnds
    \/ Dispose

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ timerPhase \in {"waiting", "browser", "reconnecting", "ended"}
    /\ timerArmed \in BOOLEAN
    /\ claims \in 0..2
    /\ flowResult \in {"waiting", "connected", "cancelled", "removed", "failed", "timed-out"}
    /\ toolRetried \in BOOLEAN
    /\ watcher \in BOOLEAN
    /\ pending \in 0 .. 2
    /\ toolWait \in BOOLEAN
    /\ errorLeak \in BOOLEAN

\* A watcher entry belongs to exactly one pending flow, and a replaced flow
\* ends instead of piling up.
NoDuplicateFlow == pending <= 1

\* A pending flow always still owns its watcher. A removal without a flow end
\* orphans the flow.
NoOrphanFlow == pending >= 1 => watcher

\* A waiting tool call either waits on a live flow or was released by its end.
ToolNotOrphaned == toolWait => (watcher /\ pending = 1)

\* A reconnect error never leaves its flow pending.
NoErrorLeak == ~errorLeak

====
