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
\* Scope: one server, one connect, and up to two list requests. Reconnects,
\* 401 flows, and transport errors are outside this model.
\* Expect: Fixed holds. NoEarlyNotify fails.
\* Result: Fixed holds in 4 states. NoEarlyNotify fails at 2 states
\* (PanelShowsConnected). No additional failure was found.
\* Property test: src/services/mcp/__tests__/mcp-oauth-flow.property.spec.ts.

CONSTANTS NotifyOnConnected   \* TRUE when the status change itself updates the panel

VARIABLES status        \* connection status the hub holds for the server
VARIABLES panelStatus   \* status the panel last received
VARIABLES pendingLists  \* list requests not finished yet (0 to 2)
VARIABLES listsArrived  \* the list results were fetched

vars == <<status, panelStatus, pendingLists, listsArrived>>

Init ==
    /\ status = "connecting"
    /\ panelStatus = "connecting"
    /\ pendingLists = 0
    /\ listsArrived = FALSE

\* client.connect succeeded. The fix updates the panel in the same step; the
\* old code only fetched the lists here.
ConnectOk ==
    /\ status' = "connected"
    /\ pendingLists' = 2
    /\ listsArrived' = FALSE
    /\ panelStatus' = IF NotifyOnConnected THEN "connected" ELSE panelStatus

\* A list request finished. Only after all of them does the old code update the
\* panel; the fix updates again when the lists arrive.
ListDone ==
    /\ pendingLists >= 1
    /\ pendingLists' = pendingLists - 1
    /\ panelStatus' = IF pendingLists = 1 THEN "connected" ELSE panelStatus
    /\ listsArrived' = (pendingLists = 1)
    /\ UNCHANGED status

Next ==
    \/ ConnectOk
    \/ ListDone

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ status \in {"connecting", "connected"}
    /\ panelStatus \in {"connecting", "connected"}
    /\ pendingLists \in 0 .. 2
    /\ listsArrived \in BOOLEAN

\* While the lists are still pending, the panel already shows connected.
PanelShowsConnected == (status = "connected" /\ ~listsArrived) => panelStatus = "connected"

====
