---- MODULE MentionRequestOrder ----
\* Models startTask, userInputContent and the loop in src/core/task/Task.ts.
\* Source: startTask starts userInputContent without a wait. Sink: handleModeSwitch.
\* Failure 1: a slash command switches the mode of a task that the user cancelled.
\* Failure 2: the loop waits for the content before it shows the api_req_started row.
\* Invariants: NoSwitchAfterCancel and NoSpinnerGap.
\* Expected before the run: Guard On and RowFirst hold. Guard Off fails in 4 states. WaitFirst fails in 2.
\* Result: the fixed config holds in 12 states. NoGuard fails in 3 states. WaitFirst fails in 2 states.
\* Replay: the unit test cancels the task, then calls userInputContent with a mode. It fails without the guard.
\* The guard and the handleModeSwitch call run in one turn, so a cancel cannot fall between them.
\* Out of scope: a cancel inside handleModeSwitch itself, and the saved history.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 1 added (bot thread on Task.ts, mode switch after cancel, PR 2421), 0 gap.
\* The first version came after the thread. It is not an independent first pass.

VARIABLES aborted, content, row, loop, switchedAfterCancel

CONSTANTS Guard, Order   \* Guard: "On" or "Off". Order: "RowFirst" or "WaitFirst".

vars == <<aborted, content, row, loop, switchedAfterCancel>>

TypeOK ==
    /\ aborted \in BOOLEAN
    /\ content \in {"pending", "done"}
    /\ row \in {"none", "shown"}
    /\ loop \in {"idle", "waiting"}
    /\ switchedAfterCancel \in BOOLEAN

Init ==
    /\ aborted = FALSE
    /\ content = "pending"
    /\ row = "none"
    /\ loop = "idle"
    /\ switchedAfterCancel = FALSE

\* The user cancels the task at any time. A TaskStarted listener can do it.
Cancel == aborted' = TRUE /\ UNCHANGED <<content, row, loop, switchedAfterCancel>>

\* The expansion ends. A command with a mode runs handleModeSwitch. The guard reads aborted.
Expand ==
    /\ content = "pending"
    /\ content' = "done"
    /\ switchedAfterCancel' = (switchedAfterCancel \/ (aborted /\ Guard = "Off"))
    /\ UNCHANGED <<aborted, row, loop>>

\* The loop shows the row, then waits. The loop does not run after a cancel.
ShowRow ==
    /\ ~aborted /\ row = "none"
    /\ row' = "shown"
    /\ UNCHANGED <<aborted, content, loop, switchedAfterCancel>>

Wait ==
    /\ ~aborted /\ loop = "idle"
    /\ \/ Order = "WaitFirst"
       \/ row = "shown"
    /\ loop' = "waiting"
    /\ UNCHANGED <<aborted, content, row, switchedAfterCancel>>

Next == Cancel \/ Expand \/ ShowRow \/ Wait \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

\* Safety 1: no mode switch runs after the cancel.
NoSwitchAfterCancel == ~switchedAfterCancel

\* Safety 2: the loop waits only after the row shows.
NoSpinnerGap == loop = "waiting" => row = "shown"

====
