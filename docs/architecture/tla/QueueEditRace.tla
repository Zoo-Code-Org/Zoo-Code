---- MODULE QueueEditRace ----
\* Models editQueuedMessage in src/core/webview/webviewMessageHandler.ts and MessageQueueService.
\* Source: an edit arrives while a queue drain can run. Sink: dequeueMessage sends the text it holds.
\* Failure: a drain sends the text from before an edit that the handler already received.
\* Invariant NoLostEdit: the drained text is the latest edit issued before the drain.
\* Property Monotone: a late image resolve never replaces newer text or newer images.
\* Expected before the run: "Await" (update after resolveIncomingImages) fails NoLostEdit.
\* "SyncUnguarded" fails Monotone. "SyncGuarded" holds. PR 2421 review, CodeRabbit thread on the handler.
\* Result: as expected. "Await" fails NoLostEdit in 6 states. "SyncUnguarded" fails Monotone in 19 states.
\* "SyncGuarded" holds in 32 states. The fix: update the text at once, then attach images only if the text is unchanged.
\* Review: 0 covered, 1 added (the await between the edit and the update), 0 gap.
\* Modes: Await, SyncUnguarded, SyncGuarded. Text and image versions are numbers. 0 is the original.
\* Not modeled: the image content, the claim set, and a drain that fails after dequeue.
\* Configs: QueueEditRace.cfg must pass. Must fail: .Await, .Unguarded.
\* Cost: each run takes under 5 seconds. Agent time is not measured.

EXTENDS Naturals

CONSTANTS Mode, MaxEdits

VARIABLES present, text, imgs, issued, pend, drained
vars == <<present, text, imgs, issued, pend, drained>>

Init == /\ present = TRUE /\ text = 0 /\ imgs = 0 /\ issued = 0 /\ pend = {} /\ drained = <<>>

\* The handler receives edit v. "Await" waits for the resolve. The sync modes update the text now.
Issue == /\ issued < MaxEdits
         /\ issued' = issued + 1
         /\ pend' = pend \cup {issued + 1}
         /\ text' = IF Mode # "Await" /\ present THEN issued + 1 ELSE text
         /\ UNCHANGED <<present, imgs, drained>>

\* The resolve for edit v ends. The guard needs the text to still be v.
Resolve(v) ==
    /\ v \in pend
    /\ pend' = pend \ {v}
    /\ IF ~present THEN UNCHANGED <<text, imgs>>
       ELSE IF Mode = "Await" THEN /\ text' = v /\ imgs' = v
       ELSE IF Mode = "SyncGuarded" /\ text # v THEN UNCHANGED <<text, imgs>>
       ELSE /\ imgs' = v /\ UNCHANGED text
    /\ UNCHANGED <<present, issued, drained>>

\* The queue drain removes the message and sends the text and images it holds.
Drain == /\ present
         /\ present' = FALSE
         /\ drained' = <<text, imgs, issued>>
         /\ UNCHANGED <<text, imgs, issued, pend>>

Next == Issue \/ (\E v \in 1..MaxEdits : Resolve(v)) \/ Drain

Spec == Init /\ [][Next]_vars

NoLostEdit == drained # <<>> => drained[1] = drained[3]
Monotone == [][text' >= text /\ imgs' >= imgs]_vars

====
