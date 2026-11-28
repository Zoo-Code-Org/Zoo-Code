---- MODULE McpOAuthStatusHandoff ----
EXTENDS Naturals
\* Source: McpHub.connectToServer sets server.status to "connected" and then
\* awaits fetchToolsList, fetchResourcesList, and fetchResourceTemplatesList.
\* Sink: notifyWebviewOfServerChanges pushes the server list to the MCP panel.
\* Failure: the panel shows "connecting" until every list request finishes, and a
\* list request can wait a full request timeout (issue 2761, reproduction row:
\* three slow list requests delayed the first panel update to 3 s).
\* Invariant: PanelShowsConnected. When the server status is "connected", the
\* panel already shows "connected", even while list requests are pending.
\* Fix rule: notifyWebviewOfServerChanges runs when the status changes, and runs
\* again when the lists arrive.
\* Scope: one server, one connect, and up to two list requests.
\* 401 errors and generic HTTP errors use a separate stream-status oracle.
\* Expect: Fixed holds. NoEarlyNotify fails.
\* Result: Fixed holds in 12 states. NoEarlyNotify fails at 3 states
\* (PanelShowsConnected). No additional failure was found.
\* Cost: one agent; header correction only.
\* Review ratchet: PR #2762 supplied finding #44, added 1.
\* Property test: src/services/mcp/__tests__/mcp-oauth-flow.property.spec.ts.

\* Review ratchet: PR #2762 follow-ups B and C. Added 2, covered 0, gap 0.
\* Source: HTTP transport.onerror. Sink: the current connection status and error.
\* Expect: stale transport errors do nothing; generic errors preserve an OAuth connect.
\* Cost: one agent; two SDK inputs and focused transport regression tests.
\* Transport result: StaleTransport and GenericDuringAuth each fail at 3 states.
\* Replay: both stale error types and a generic error during connect fail before the fix.
\* Runtime sabotage: each HTTP guard and the stdio correction fail their regression tests.
CONSTANTS GuardTransport, GuardConnecting
CONSTANTS NotifyOnConnected   \* TRUE when the status change itself updates the panel

VARIABLES status        \* connection status the hub holds for the server
VARIABLES panelStatus   \* status the panel last received
VARIABLES pendingLists  \* list requests not finished yet (0 to 2)
VARIABLES listsArrived  \* the list results were fetched

VARIABLES streamStatus, staleError, interruptedAuth
vars == <<status, panelStatus, pendingLists, listsArrived, streamStatus, staleError, interruptedAuth>>

Init ==
    /\ streamStatus = "connecting" /\ staleError = FALSE /\ interruptedAuth = FALSE
    /\ status = "connecting"
    /\ panelStatus = "connecting"
    /\ pendingLists = 0
    /\ listsArrived = FALSE

\* client.connect succeeded. The fix updates the panel in the same step; the
\* old code only fetched the lists here.
ConnectOk ==
    /\ UNCHANGED <<streamStatus, staleError, interruptedAuth>>
    /\ status' = "connected"
    /\ pendingLists' = 2
    /\ listsArrived' = FALSE
    /\ panelStatus' = IF NotifyOnConnected THEN "connected" ELSE panelStatus

\* A list request finished. Only after all of them does the old code update the
\* panel; the fix updates again when the lists arrive.
ListDone ==
    /\ UNCHANGED <<streamStatus, staleError, interruptedAuth>>
    /\ pendingLists >= 1
    /\ pendingLists' = pendingLists - 1
    /\ panelStatus' = IF pendingLists = 1 THEN "connected" ELSE panelStatus
    /\ listsArrived' = (pendingLists = 1)
    /\ UNCHANGED status

StreamConnect ==
    /\ streamStatus = "connecting"
    /\ streamStatus' = "connected"
    /\ UNCHANGED <<status, panelStatus, pendingLists, listsArrived, staleError, interruptedAuth>>
\* The transport owner and error kind are inputs from the SDK.
HttpError ==
    \E sameTransport \in BOOLEAN, unauthorized \in BOOLEAN :
        LET allowed == (sameTransport \/ ~GuardTransport)
            reauth == unauthorized /\ streamStatus = "connected"
            generic == ~unauthorized /\ (streamStatus # "connecting" \/ ~GuardConnecting)
        IN /\ streamStatus' = IF ~allowed THEN streamStatus
                               ELSE IF reauth THEN "connecting"
                               ELSE IF generic THEN "disconnected" ELSE streamStatus
           /\ staleError' = (staleError \/ (allowed /\ ~sameTransport))
           /\ interruptedAuth' = (interruptedAuth \/ (allowed /\ generic /\ streamStatus = "connecting"))
           /\ UNCHANGED <<status, panelStatus, pendingLists, listsArrived>>
NoStaleTransportError == ~staleError
AuthStillConnecting == ~interruptedAuth

Next ==
    \/ StreamConnect
    \/ HttpError
    \/ ConnectOk
    \/ ListDone

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ streamStatus \in {"connecting", "connected", "disconnected"}
    /\ staleError \in BOOLEAN /\ interruptedAuth \in BOOLEAN
    /\ status \in {"connecting", "connected"}
    /\ panelStatus \in {"connecting", "connected"}
    /\ pendingLists \in 0 .. 2
    /\ listsArrived \in BOOLEAN

\* While the lists are still pending, the panel already shows connected.
PanelShowsConnected == (status = "connected" /\ ~listsArrived) => panelStatus = "connected"

====
