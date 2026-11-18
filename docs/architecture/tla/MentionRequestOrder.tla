---- MODULE MentionRequestOrder ----
\* Models startTask, userInputContent and the loop in src/core/task/Task.ts.
\* Source: startTask starts userInputContent without a wait. Sink: handleModeSwitch.
\* Failure 1: a slash command switches the mode of a task that the user cancelled.
\* Failure 2: the loop waits for the content before it shows the api_req_started row.
\* Invariants: NoSwitchAfterCancel and NoSpinnerGap.
\* Expected before the run: Guard On and RowFirst hold. Guard Off fails in 4 states. WaitFirst fails in 2.
\* Result: the fixed config holds in 60 states. NoGuard fails in 7 states. WaitFirst fails in 5 states.
\* Replay: Task.spec.ts "slash command mode switch". One test cancels from a TaskStarted listener while parseMentions waits.
\* The other tests cancel first. All of them fail without the guard.
\* The guard and the handleModeSwitch call run in one turn, so a cancel cannot fall between them.
\* Out of scope: a cancel inside handleModeSwitch itself, cross-host writes already in progress.
\* Cost: four TLC configs take about 4 seconds. Agent time is not measured.
\* Review: 0 covered, 2 added (bot thread on Task.ts, mode switch after cancel, PR 2421), 0 gap.
\* The first version came after the thread. It is not an independent first pass.

\* Review ratchet: PR 2421 discussion_r4607106857 adds NoStaleReplacement.
\* Source: resumeTaskFromHistory starts expansion. Sink: overwriteApiConversationHistory.
\* Failure: a cancelled preparation replaces the history of a newer run.
\* Expected: the ownership guard blocks replacement. HistoryOff must fail.
\* Result: HistoryOff fails in 21 states. The fixed model finds no new failure.
\* Replay: Task.persistence.spec.ts tests cancel, dispose, abandon and generation changes.
\* All four tests fail when the callback guard is removed. No false alarm was retained.
\* The first history invariant follows the review. It is not independent.
VARIABLES aborted, content, row, loop, switchedAfterCancel,
          revoked, newerHistory, preparation, staleReplacement

CONSTANTS HistoryGuard, Guard, Order   \* Guard: "On" or "Off". Order: "RowFirst" or "WaitFirst".

historyVars == <<revoked, newerHistory, preparation, staleReplacement>>
vars == <<aborted, content, row, loop, switchedAfterCancel, historyVars>>

TypeOK ==
    /\ revoked \in BOOLEAN /\ newerHistory \in BOOLEAN
    /\ preparation \in {"pending", "done"} /\ staleReplacement \in BOOLEAN
    /\ aborted \in BOOLEAN
    /\ content \in {"pending", "done"}
    /\ row \in {"none", "shown"}
    /\ loop \in {"idle", "waiting"}
    /\ switchedAfterCancel \in BOOLEAN

Init ==
    /\ revoked = FALSE /\ newerHistory = FALSE
    /\ preparation = "pending" /\ staleReplacement = FALSE
    /\ aborted = FALSE
    /\ content = "pending"
    /\ row = "none"
    /\ loop = "idle"
    /\ switchedAfterCancel = FALSE

\* The user cancels the task at any time. A TaskStarted listener can do it.
Cancel == /\ aborted' = TRUE /\ revoked' = TRUE
          /\ UNCHANGED <<content, row, loop, switchedAfterCancel, newerHistory, preparation, staleReplacement>>

\* The expansion ends. A command with a mode runs handleModeSwitch. The guard reads aborted.
Expand ==
    /\ content = "pending"
    /\ content' = "done"
    /\ switchedAfterCancel' = (switchedAfterCancel \/ (aborted /\ Guard = "Off"))
    /\ UNCHANGED <<aborted, row, loop, historyVars>>

\* The loop shows the row, then waits. The loop does not run after a cancel.
ShowRow ==
    /\ ~aborted /\ row = "none"
    /\ row' = "shown"
    /\ UNCHANGED <<aborted, content, loop, switchedAfterCancel, historyVars>>

Wait ==
    /\ ~aborted /\ loop = "idle"
    /\ \/ Order = "WaitFirst"
       \/ row = "shown"
    /\ loop' = "waiting"
    /\ UNCHANGED <<aborted, content, row, switchedAfterCancel, historyVars>>

\* Disposal or a generation change revokes the preparation without an abort flag.
Revoke == /\ revoked' = TRUE
          /\ UNCHANGED <<aborted, content, row, loop, switchedAfterCancel, newerHistory, preparation, staleReplacement>>

SaveNewer == /\ revoked /\ newerHistory' = TRUE
             /\ UNCHANGED <<aborted, content, row, loop, switchedAfterCancel, revoked, preparation, staleReplacement>>

\* The callback checks ownership before it calls the replacement sink.
Replace == /\ preparation = "pending" /\ preparation' = "done"
           /\ staleReplacement' = (staleReplacement \/
                 (newerHistory /\ (HistoryGuard = "Off" \/ ~revoked)))
           /\ UNCHANGED <<aborted, content, row, loop, switchedAfterCancel, revoked, newerHistory>>

Next == Cancel \/ Expand \/ ShowRow \/ Wait \/ Revoke \/ SaveNewer \/ Replace \/ UNCHANGED vars
NoStaleReplacement == ~staleReplacement
Spec == Init /\ [][Next]_vars

\* Safety 1: no mode switch runs after the cancel.
NoSwitchAfterCancel == ~switchedAfterCancel

\* Safety 2: the loop waits only after the row shows.
NoSpinnerGap == loop = "waiting" => row = "shown"

====
