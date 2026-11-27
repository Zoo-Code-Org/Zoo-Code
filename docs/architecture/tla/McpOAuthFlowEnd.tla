---- MODULE McpOAuthFlowEnd ----
EXTENDS Naturals
\* Source: McpHub._runOAuthFlow registers the watcher entry in _oauthWatchers and
\* owns the flow promise. deleteConnection(), flow replacement in _runOAuthFlow(),
\* dispose(), and the token-watcher error path remove or replace that entry.
\* Sink: McpHub.callTool awaits the re-auth promise, and the flow promise resolves
\* through the shared removal path _endOAuthWatcher.
\* Failure: a removed watcher leaves its flow pending, so the notification stays
\* open and tool calls that wait on the flow stay blocked (issue 2761).
\* Failure: an old flow removes the watcher of a newer flow, so the newer flow
\* can never time out or resolve.
\* Failure: a reconnect that throws in the token watcher leaves the flow pending.
\* Invariants: WatchedFlowIsSingle, NoOrphanFlow, ToolNotOrphaned, NoErrorLeak.
\* Fix rule: every watcher removal goes through one shared path that also ends
\* the flow, and a reconnect error ends the flow with a visible error.
\* Scope: timeouts, cancellation, and the toast paths end the flow inside the
\* flow itself; the model folds them into FlowEnds. Secret storage is an oracle.
\* Scope: at most two flows and one watcher per key. One tool call waits at a time.
\* Expect: Fixed holds. ReplaceLeak, DeleteLeak, DisposeLeak and ErrorLeak each fail.
\* Result: Fixed holds in 3 states. ReplaceLeak fails at 4 states (NoDuplicateFlow).
\* DeleteLeak fails at 4 states (NoOrphanFlow). DisposeLeak fails at 4 states
\* (NoOrphanFlow). ErrorLeak fails at 4 states (NoErrorLeak).
\* Property test: src/services/mcp/__tests__/mcp-oauth-flow.property.spec.ts.

CONSTANTS ReplaceEndsFlow   \* TRUE when a replacement flow ends the replaced flow
CONSTANTS DeleteEndsFlow    \* TRUE when deleteConnection ends the flow
CONSTANTS DisposeEndsFlows  \* TRUE when dispose ends all flows
CONSTANTS ErrorEndsFlow     \* TRUE when a reconnect error ends the flow

VARIABLES watcher     \* a watcher entry is registered for this key
VARIABLES pending     \* number of flows not yet ended (0 to 2)
VARIABLES toolWait    \* a tool call waits on the re-auth promise
VARIABLES errorLeak   \* latch: a reconnect error left its flow pending

vars == <<watcher, pending, toolWait, errorLeak>>

Init ==
    /\ watcher = FALSE
    /\ pending = 0
    /\ toolWait = FALSE
    /\ errorLeak = FALSE

\* connectToServer starts a flow. A replacement ends the old flow through the
\* shared path; without that rule the replaced flow stays pending forever.
StartFlow ==
    /\ pending' = IF watcher /\ ReplaceEndsFlow THEN pending
                  ELSE IF pending < 2 THEN pending + 1 ELSE 2
    /\ watcher' = TRUE
    /\ UNCHANGED <<toolWait, errorLeak>>

\* callTool hits a 401 and starts the re-auth flow it waits on.
CallTool ==
    /\ toolWait' = TRUE
    /\ pending' = IF watcher /\ ReplaceEndsFlow THEN pending
                  ELSE IF pending < 2 THEN pending + 1 ELSE 2
    /\ watcher' = TRUE
    /\ UNCHANGED errorLeak

\* deleteConnection removes the watcher. The shared path also ends the flow and
\* releases the waiting tool call.
DeleteConnection ==
    /\ watcher' = FALSE
    /\ pending' = IF watcher /\ DeleteEndsFlow THEN pending - 1 ELSE pending
    /\ toolWait' = IF watcher /\ DeleteEndsFlow THEN FALSE ELSE toolWait
    /\ UNCHANGED errorLeak

\* The token watcher catches a reconnect error. The fix ends the flow and shows
\* the error on the server status; the old code only logged it.
WatcherError ==
    /\ pending >= 1
    /\ errorLeak' = (errorLeak \/ ~ErrorEndsFlow)
    /\ pending' = IF ErrorEndsFlow THEN pending - 1 ELSE pending
    /\ watcher' = IF ErrorEndsFlow THEN FALSE ELSE watcher
    /\ toolWait' = IF ErrorEndsFlow THEN FALSE ELSE toolWait

\* A flow ends inside itself: timeout, cancel, or a completed sign-in.
FlowEnds ==
    /\ pending >= 1
    /\ pending' = pending - 1
    /\ watcher' = FALSE
    /\ toolWait' = FALSE
    /\ UNCHANGED errorLeak

\* The hub is disposed. The shared path ends every flow and releases every wait.
Dispose ==
    /\ watcher' = FALSE
    /\ pending' = IF DisposeEndsFlows THEN 0 ELSE pending
    /\ toolWait' = IF DisposeEndsFlows THEN FALSE ELSE toolWait
    /\ UNCHANGED errorLeak

Next ==
    \/ StartFlow
    \/ CallTool
    \/ DeleteConnection
    \/ WatcherError
    \/ FlowEnds
    \/ Dispose

Spec == Init /\ [][Next]_vars

TypeOK ==
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
ToolNotOrphaned == toolWait => (watcher \/ pending = 0)

\* A reconnect error never leaves its flow pending.
NoErrorLeak == ~errorLeak

====
