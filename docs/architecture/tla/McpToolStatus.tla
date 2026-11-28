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
\* Initial result: the fixed model passed. All five initial sabotage configs failed.
\* Replay: DropStale, PostOnChange, SendNull, ReadLast, and CheckTask each fail a test when removed.
\* Tests: mcpToolStatus.property.spec.ts, build-tools-dynamic-load, ClineProvider, and ExtensionStateContext.
\* Test gap found: the first property test passed without DropStale. It now checks each later step.
\* Before review: Fresh, LatestWins, and matching counts were the expected properties.
\* Review PR 2763: added FullHidden (thread PRRT_kwDOSK-bwM68_ECR).
\* Review PR 2763: added Replace with the same ID (thread PRRT_kwDOSK-bwM68_ECU).
\* Failure: a full selection shows a status. Invariant: FullHidden. Source: build-tools; sink: status report.
\* Failure: an old instance snapshot restores its status. Invariant: Fresh. Source: provider; sink: state merge.
\* Expect: FullStatus fails FullHidden; OldInstance fails Fresh. Replay: build and provider property cases.
\* Gap: screen reader announcements need a DOM test (thread PRRT_kwDOSK-bwM68_ECX).
\* Covered: review comment cr-comment:v1:07662f59f9c00d7ff3044a8e; Snapshot and Deliver already model a delayed read.
\* Review counts: covered 1, added 2, gap 1. Cost: about 7 minutes of agent work; each TLC config takes less than 2 seconds.
\* Result: fixed passes (8,832 states); all seven fault configs fail. No new defect beyond the review findings.
\* Replay: four new regression cases fail before the fix and pass after it; 426 focused tests pass.
\* Simplified: replacement is one bit in the pending snapshot; ranking and build results remain oracles.
\* Refactor expectation: null result. Fresh, LatestWins, and FullHidden must keep their verdicts.
\* Failure to prevent: a null status renders an indicator, or a partial selection is hidden.
\* Source: buildNativeToolsArrayWithRestrictions. Sink: DynamicToolsStatus reads ExtensionState directly.
\* Only the selection gate removes scoped tools, so a smaller count implies that the gate ran.
\* The UI derives visibility from null and the count from attachedToolNames; no mode adapter is needed.
\* Refactor result: null result. Fixed passes (8,832 states); all seven fault configs still fail.
\* Refactor replay: 83 build, tracker property, component, and chat tests pass. Lint passes with no new suppressions.
\* Refactor cost: about 2 minutes of agent work. No model variable or action was added.
EXTENDS Naturals

CONSTANTS SendNull, DropStale, PostOnChange, CheckTask, ReadLast, HideFull, ReadCurrent
VARIABLES current, status, started, newest, pending, shown, late
vars == <<current, status, started, newest, pending, shown, late>>

Tasks == {1, 2}
\* "none" means that the gate did not run. The other values are two different selections.
Results == {"none", "a", "b", "all"}
Visible(result) == IF HideFull /\ result = "all" THEN "none" ELSE result
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
        next == IF accept THEN [status EXCEPT ![t] = Visible(result)] ELSE status
    IN
    /\ b \in pending /\ pending' = pending \ {b}
    /\ status' = next
    /\ newest' = IF seq > newest[t].seq THEN [newest EXCEPT ![t] = [seq |-> seq, value |-> Visible(result)]] ELSE newest
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
    /\ late = <<>> /\ late' = <<current, status[current], FALSE>>
    /\ UNCHANGED <<current, status, started, newest, pending, shown>>

\* It arrives later. ReadLast reads the status after the last await of the snapshot.
Deliver ==
    /\ late # <<>> /\ late' = <<>>
    /\ IF CheckTask /\ late[1] # current
       THEN UNCHANGED shown
       ELSE Post(IF ReadLast /\ (ReadCurrent \/ ~late[3]) THEN status[late[1]] ELSE late[2])
    /\ UNCHANGED <<current, status, started, newest, pending>>

\* Restore replaces the current instance with the same task ID and no status.
Replace ==
    /\ late # <<>> /\ late[1] = current /\ ~late[3]
    /\ late' = <<late[1], late[2], TRUE>>
    /\ status' = [status EXCEPT ![current] = "none"] /\ Post("none")
    /\ newest' = [newest EXCEPT ![current] = [seq |-> 0, value |-> "none"]]
    /\ UNCHANGED <<current, started, pending>>

Next ==
    \/ Replace
    \/ Snapshot \/ Deliver
    \/ \E t \in Tasks : Begin(t) \/ Switch(t)
    \/ \E b \in pending, result \in Results : Finish(b, result)

Spec == Init /\ [][Next]_vars

FullHidden == shown # "all"
Fresh == shown = status[current]
\* A newer build that is still pending makes an older result obsolete.
LatestWins ==
    \A t \in Tasks : newest[t].seq = started[t] => status[t] = newest[t].value
====
