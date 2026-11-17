---- MODULE QueueEditRace ----
\* Models editQueuedMessage in src/core/webview/webviewMessageHandler.ts and MessageQueueService.
\* Source: an edit arrives while a queue drain can run. Sink: dequeueMessage sends the text it holds.
\* Failure: a drain sends the text from before an edit, or the edited text without its image.
\* Invariant DrainedWhole: the drained source and image both belong to the latest edit begun before the drain.
\* Property Monotone: a late image resolve never replaces a newer source or newer images.
\* All edits have the same text. A text check cannot tell them apart. Only the source version can.
\* Modes: Await (update after the image scan), Text (update at once, attach images if the text is unchanged),
\* Claim (hold the message and commit text, source and images together, only for the latest edit).
\* First version (PR 2421, CodeRabbit thread 1): edits had distinct text. It hid the same-text case.
\* Result: "Await" fails DrainedWhole in 6 states. "Text" fails DrainedWhole in 6 states. "Claim" holds.
\* Review: 0 covered, 2 added (the await before the update; the same-text edit and the drained image), 0 gap.
\* Not modeled: the image content, a failed scan (the handler then keeps the old images), and the webview.
\* Configs: QueueEditRace.cfg (Claim) must pass. Must fail: .Await, .Text.
\* Cost: each run takes under 5 seconds. Agent time is not measured.

EXTENDS Naturals

CONSTANTS Mode, MaxEdits

VARIABLES present, src, imgs, began, latest, pend, claimed, drained
vars == <<present, src, imgs, began, latest, pend, claimed, drained>>

Init == /\ present = TRUE /\ src = 0 /\ imgs = 0 /\ began = 0 /\ latest = 0
        /\ pend = {} /\ claimed = FALSE /\ drained = <<>>

\* The handler receives edit v. A refused edit (message gone) is not counted. "Claim" holds the message.
Begin == /\ began < MaxEdits /\ present
         /\ began' = began + 1
         /\ latest' = began + 1
         /\ pend' = pend \cup {began + 1}
         /\ src' = IF Mode = "Text" THEN began + 1 ELSE src
         /\ claimed' = (Mode = "Claim")
         /\ UNCHANGED <<present, imgs, drained>>

\* The scan for edit v ends. "Claim" commits only the latest edit and then lets the message go.
Resolve(v) ==
    /\ v \in pend
    /\ pend' = pend \ {v}
    /\ IF ~present THEN UNCHANGED <<src, imgs, claimed>>
       ELSE CASE Mode = "Await" -> /\ src' = v /\ imgs' = v /\ UNCHANGED claimed
         [] Mode = "Text"  -> /\ imgs' = v /\ UNCHANGED <<src, claimed>>
         [] OTHER          -> IF v = latest THEN /\ src' = v /\ imgs' = v /\ claimed' = FALSE
                                            ELSE UNCHANGED <<src, imgs, claimed>>
    /\ UNCHANGED <<present, began, latest, drained>>

\* The drain skips a claimed message. It removes the message and sends the source and images it holds.
Drain == /\ present /\ ~claimed
         /\ present' = FALSE
         /\ drained' = <<src, imgs, began>>
         /\ UNCHANGED <<src, imgs, began, latest, pend, claimed>>

Next == Begin \/ (\E v \in 1..MaxEdits : Resolve(v)) \/ Drain

Spec == Init /\ [][Next]_vars

DrainedWhole == drained # <<>> => drained[1] = drained[3] /\ drained[2] = drained[3]
Monotone == [][src' >= src /\ imgs' >= imgs]_vars

====
