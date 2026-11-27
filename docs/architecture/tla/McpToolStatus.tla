---- MODULE McpToolStatus ----
\* Source: buildNativeToolsArrayWithRestrictions reports to McpToolStatusTracker.begin for each build.
\* State source: ClineProvider.getStateToPostToWebview.
\* Sink: ExtensionState.mcpToolStatus in the webview, after mergeExtensionState.
\* Failure: the webview keeps an old status after the extension has none. Invariant: Fresh.
\* Failure: the webview shows the status of another task. Invariant: Fresh.
\* Failure: a status change does not reach the webview. Invariant: Fresh.
\* Failure: an older build replaces the result of a newer build. Invariant: LatestWins.
\* Failure: a late post without messages brings the status of the previous task. Invariant: Fresh.
\* Failure: a post reads the status before an await and delivers an old value. Invariant: Fresh.
\* Oracles: ranking and the gate give any result. One snapshot can arrive after a task switch.
\* Expect (before the code): each removed guard fails its invariant.
\* Added after the first run: Snapshot and Deliver, after a read of mergeExtensionState and its tests.
\* Found: with those actions, the first design failed Fresh (old value after an await). Fixed by ReadLast.
\* Result: the fixed model passes. All five sabotage configs fail.
\* Replay: DropStale, PostOnChange, SendNull, ReadLast, and CheckTask each fail a test when removed.
\* Tests: mcpToolStatus.property.spec.ts, build-tools-dynamic-load, ClineProvider, and ExtensionStateContext.
\* Test gap found: the first property test passed without DropStale. It now checks each later step.
\* Review counts: covered 0, added 0, gap 0. Cost: each run takes less than 5 seconds.
EXTENDS Naturals

CONSTANTS SendNull, DropStale, PostOnChange, CheckTask, ReadLast
VARIABLES current, status, started, newest, pending, shown, late
vars == <<current, status, started, newest, pending, shown, late>>

Tasks == {1, 2}
\* "none" means that the gate did not run. The other values are two different selections.
Results == {"none", "a", "b"}
MaxBuilds == 2

Init ==
    /\ current = 1 /\ shown = "none" /\ pending = {} /\ late = <<>>
    /\ status = [t \in Tasks |-> "none"]
    /\ started = [t \in Tasks |-> 0]
    /\ newest = [t \in Tasks |-> [seq |-> 0, value |-> "none"]]

\* A state post. Without SendNull the key is absent, so the merge keeps the old value.
Post(value) == shown' = IF value = "none" /\ ~SendNull THEN shown ELSE value

Begin(t) ==
    /\ started[t] < MaxBuilds
    /\ started' = [started EXCEPT ![t] = @ + 1]
    /\ pending' = pending \cup {<<t, started[t] + 1>>}
    /\ UNCHANGED <<current, status, newest, shown, late>>

Finish(b, result) ==
    LET t == b[1]
        seq == b[2]
        accept == ~DropStale \/ seq = started[t]
        next == IF accept THEN [status EXCEPT ![t] = result] ELSE status
    IN
    /\ b \in pending /\ pending' = pending \ {b}
    /\ status' = next
    /\ newest' = IF seq > newest[t].seq THEN [newest EXCEPT ![t] = [seq |-> seq, value |-> result]] ELSE newest
    /\ IF PostOnChange /\ next # status
       THEN Post(next[current])
       ELSE UNCHANGED shown
    /\ UNCHANGED <<current, started, late>>

\* A task switch always posts the state.
Switch(t) ==
    /\ t # current /\ current' = t /\ Post(status[t])
    /\ UNCHANGED <<status, started, newest, pending, late>>

\* A post without messages starts: the extension takes a snapshot of the current task.
Snapshot ==
    /\ late = <<>> /\ late' = <<current, status[current]>>
    /\ UNCHANGED <<current, status, started, newest, pending, shown>>

\* It arrives later. ReadLast reads the status after the last await of the snapshot.
Deliver ==
    /\ late # <<>> /\ late' = <<>>
    /\ IF CheckTask /\ late[1] # current
       THEN UNCHANGED shown
       ELSE Post(IF ReadLast THEN status[late[1]] ELSE late[2])
    /\ UNCHANGED <<current, status, started, newest, pending>>

Next ==
    \/ Snapshot \/ Deliver
    \/ \E t \in Tasks : Begin(t) \/ Switch(t)
    \/ \E b \in pending, result \in Results : Finish(b, result)

Spec == Init /\ [][Next]_vars

Fresh == shown = status[current]
\* A newer build that is still pending makes an older result obsolete.
LatestWins ==
    \A t \in Tasks : newest[t].seq = started[t] => status[t] = newest[t].value
====
