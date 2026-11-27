---- MODULE AskResponseTargeting ----
\* Models the response slot between handleWebviewAskResponse and the consume step at the
\* end of Task.ask in src/core/task/Task.ts.
\* Source: handleWebviewAskResponse writes askResponse when a response event arrives
\* (a user click, a queue answer, an auto-approval). Sink: the consume step in ask()
\* reads askResponse and hands it to the tool callback.
\* Failure 1: a response that arrived while no ask was awaiting satisfies a later ask.
\* An orphan click between two asks (a double click, a late event) then runs the next
\* command without its own prompt (issue 998).
\* Failure 2 (review r3): a response processed in a completion path's save window, before
\* that ask published its row, is tagged with the new ask's token and satisfies it —
\* the next command runs on the previous command's approval.
\* Invariants: OnlyOwnResponse (a consumed response arrived while its own ask awaited),
\* NoOrphanApproval (a response that arrived while no ask awaited satisfies no ask),
\* OnlyOwnPublishedResponse (a consumed response arrived after its ask's row published),
\* NoStaleConsumption (a superseded ask consumes nothing), ArmOnlyWhileCurrent (the arm
\* never fires for an ask whose ts already moved on).
\* The model has serial asks 1..MaxAsks, because the presenter runs tools one at a time.
\* Each ask has phases: Entry (slot reset, row not yet published), Published (the row
\* reached the webview; the arm may fire), and the terminal end. Publish models the
\* row publication; BumpTs models lastMessageTs moving past the ask (supersedePendingAsk
\* or another flow's row publication). The arm is guarded: it fires only while the ask
\* is published and still current, and a response that lands in the entry window tags
\* as an orphan no ask may consume. Arrive records the truthful phase in the ghost
\* fields, so the gate and the truth cannot drift.
\* Not modeled: the queued-message drain (QueueDrainRetry.tla owns the queue; its answers
\* go through this same slot), the auto-approval timeout token, the text and image payload.
\* Expected before the fix: the NoGate config reproduces failure 1 on the unfixed code.
\* Result (r3): AskResponseTargeting.cfg holds. Each sabotage config fails:
\* .NoGate on OnlyOwnResponse (the unfixed consume takes a real orphan arrival in
\* the entry window, before the arm folds it), .TagByCur on OnlyOwnResponse (a tag
\* written from the minted ask instead of the awaiting ask), .ArmEarly on
\* OnlyOwnPublishedResponse (an arm in the entry window lets a save-window response
\* satisfy the ask — the r3 completion-path finding), .ArmNoCurrentGuard on
\* ArmOnlyWhileCurrent (an out-of-date publication re-arms a superseded ask).
\* Review ratchet (round on the fresh head): the arming transition no longer
\* makes a pending response out of an empty slot, and both terminal actions
\* reset cur to 0 while Consume also clears awaiting, so the second ask is
\* reachable and the between-ask orphan windows get checked. r3 repair: that
\* r2 line was written unparenthesized, so it parsed as the assignment
\* pending' = pending CONJUNCT the guard rtag # Orphan, and the guard killed
\* the arm whenever rtag was Orphan — the arm action never fired and every
\* config passed or failed on arm-free traces alone. The assignment is now
\* parenthesized; the state counts below reflect the arm actually running.
\* r3 added the
\* published phase, the currency guard, and the phase ghosts above; the two r3
\* stamp facts stay test-pinned in src/core/task/__tests__/ask-response-targeting.spec.ts
\* (the stamp follows the arrival's owning row, and the stamp is skipped for
\* unset targets and partial rows) because row identity needs the overlap
\* envelope this serial model does not carry. Also still not modeled (bounded
\* gaps, each pinned by a test in ask-response-targeting.spec.ts): the status-timer
\* arming rule, and concurrent asks (the presenter runs one ask at a time; the
\* arm-clobber window an overlapping publication opens is pinned by the
\* keeps-a-newer-ask's-token test).
\* Code check: the sabotages match the entry-window leak that
\* src/core/task/__tests__/ask-response-targeting.spec.ts and
\* src/core/task/__tests__/Task.command-batch-approval.spec.ts replay on the real ask
\* path (each failed on the unfixed code and passes on the fixed code).
\* Cost: the spec run takes under 5 seconds. Agent time: about 2.5 hours for the
\* spec, the two tests, and the Task.ts gate (find + fix + verify).
\* Null result: none — the first version found the entry-window leak the plain
\* between-ask orphan does not cover, and the isBlocking fast path around the wait.
\* Review ratchet (r4, threads 4715054203 and 4715054207): both findings were
\* verification-artifact repairs, so both count as covered — the model already
\* expressed each rule. ConsumeNoGate now carries the ~tsBumped[k] guard the
\* fixed Consume has (without it a bump-trace NoStaleConsumption violation could
\* mask a broken ownership-gate check in the must-fail cfg), and the objectResponse
\* negative test seeds the owning row ts so the response-kind exclusion, not the
\* unset stamp, is what leaves the row unmarked.

EXTENDS Naturals

CONSTANTS MaxAsks, Orphan, MaxArrivals

VARIABLES awaiting, pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
    consumedWhile, ended, begun, published, tsBumped, armedAfterBump, cur, arrivals
vars == <<awaiting, pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
    consumedWhile, ended, begun, published, tsBumped, armedAfterBump, cur, arrivals>>

TypeOK ==
    /\ awaiting \in {0} \union (1..MaxAsks)
    /\ pending \in BOOLEAN
    /\ rtag \in {Orphan} \union (1..MaxAsks)
    /\ ghostArrival \in {Orphan} \union (1..MaxAsks)
    /\ ghostPhase \in {"entry", "pub", "none"}
    /\ consumed \in [1..MaxAsks -> BOOLEAN]
    /\ consumedWhile \in [1..MaxAsks -> {Orphan} \union (1..MaxAsks)]
    /\ consumedPhase \in [1..MaxAsks -> {"entry", "pub", "none"}]
    /\ ended \in [1..MaxAsks -> BOOLEAN]
    /\ begun \in [1..MaxAsks -> BOOLEAN]
    /\ published \in [1..MaxAsks -> BOOLEAN]
    /\ tsBumped \in [1..MaxAsks -> BOOLEAN]
    /\ armedAfterBump \in BOOLEAN
    /\ cur \in {0} \union (1..MaxAsks)
    /\ arrivals \in 0..MaxArrivals

Init ==
    /\ awaiting = 0
    /\ pending = FALSE
    /\ rtag = Orphan
    /\ ghostArrival = Orphan
    /\ ghostPhase = "none"
    /\ consumed = [k \in 1..MaxAsks |-> FALSE]
    /\ consumedWhile = [k \in 1..MaxAsks |-> Orphan]
    /\ consumedPhase = [k \in 1..MaxAsks |-> "none"]
    /\ ended = [k \in 1..MaxAsks |-> FALSE]
    /\ begun = [k \in 1..MaxAsks |-> FALSE]
    /\ published = [k \in 1..MaxAsks |-> FALSE]
    /\ tsBumped = [k \in 1..MaxAsks |-> FALSE]
    /\ armedAfterBump = FALSE
    /\ cur = 0
    /\ arrivals = 0

\* ask() begins for ask k. The entry reset clears the slot. Nothing awaits yet and
\* the row is not published.
MintAsk(k) ==
    /\ cur = 0
    /\ ~begun[k]
    /\ k = 1 \/ (k > 1 /\ ended[k - 1])
    /\ begun' = [begun EXCEPT ![k] = TRUE]
    /\ cur' = k
    /\ pending' = FALSE
    /\ rtag' = Orphan
    /\ ghostArrival' = Orphan
    /\ ghostPhase' = "none"
    /\ published' = [published EXCEPT ![k] = FALSE]
    /\ tsBumped' = [tsBumped EXCEPT ![k] = FALSE]
    /\ armedAfterBump' = FALSE
    /\ UNCHANGED <<awaiting, consumed, consumedPhase, consumedWhile, ended, arrivals>>

\* The ask row's publication completes: the row reached the webview and the
\* persistence boundary ran. Only now may the arm fire.
Publish(k) ==
    /\ cur = k
    /\ ~published[k]
    /\ published' = [published EXCEPT ![k] = TRUE]
    /\ UNCHANGED <<awaiting, pending, rtag, ghostArrival, ghostPhase, consumed,
        consumedPhase, consumedWhile, ended, begun, tsBumped, armedAfterBump, cur, arrivals>>

\* lastMessageTs moves past ask k while it still runs: supersedePendingAsk, or
\* another flow publishing a row. The ask's wait will exit as superseded.
BumpTs(k) ==
    /\ cur = k
    /\ ~ended[k]
    /\ tsBumped' = [tsBumped EXCEPT ![k] = TRUE]
    /\ UNCHANGED <<awaiting, pending, rtag, ghostArrival, ghostPhase, consumed,
        consumedPhase, consumedWhile, ended, begun, published, armedAfterBump, cur, arrivals>>

\* ask() arms its wait at the ask row's publication boundary, and only while the
\* ask is still current. An orphan present at the first wait poll is discarded
\* there; the spec folds that discard into this action. Arming never manufactures
\* a response: an empty slot stays empty, an orphan-tagged slot clears, an
\* own-tagged slot stays available.
ArmAsk(k) ==
    /\ cur = k
    /\ published[k]
    /\ ~tsBumped[k]
    /\ armedAfterBump' = FALSE
    /\ awaiting' = k
    /\ pending' = (pending /\ rtag # Orphan)
    /\ rtag' = rtag
    /\ ghostArrival' = ghostArrival
    /\ ghostPhase' = ghostPhase
    /\ UNCHANGED <<consumed, consumedPhase, consumedWhile, ended, begun, published,
        tsBumped, cur, arrivals>>

\* A response event arrives at any time. The host tags it with the ask that awaits
\* now (Orphan when none awaits); the ghost records the same fact plus the ask's
\* phase, so a tag earned in the entry window stays detectable at consume time.
Arrive ==
    /\ arrivals < MaxArrivals
    /\ arrivals' = arrivals + 1
    /\ pending' = TRUE
    /\ rtag' = IF awaiting > 0 THEN awaiting ELSE Orphan
    /\ ghostArrival' = rtag'
    /\ ghostPhase' = IF awaiting > 0
        THEN (IF published[awaiting] THEN "pub" ELSE "entry")
        ELSE "none"
    /\ UNCHANGED <<awaiting, consumed, consumedPhase, consumedWhile, ended, begun,
        published, tsBumped, armedAfterBump, cur>>

\* The consume step. The ownership gate: only a response tagged with this ask's
\* token may satisfy it, and only while the ask is still current (a superseded
\* ask exits as superseded, never by consuming). The ghost stores the arrival
\* truth for the invariants. Consuming ends the ask: the arm clears with the
\* active ask, and the next ask may enter.
Consume(k) ==
    /\ cur = k
    /\ ~ended[k]
    /\ ~tsBumped[k]
    /\ pending
    /\ rtag = k
    /\ consumed' = [consumed EXCEPT ![k] = TRUE]
    /\ consumedWhile' = [consumedWhile EXCEPT ![k] = ghostArrival]
    /\ consumedPhase' = [consumedPhase EXCEPT ![k] = ghostPhase]
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ pending' = FALSE
    /\ rtag' = Orphan
    /\ ghostArrival' = Orphan
    /\ ghostPhase' = "none"
    /\ awaiting' = 0
    /\ cur' = 0
    /\ UNCHANGED <<begun, published, tsBumped, armedAfterBump, arrivals>>

\* The ask ends without consuming (superseded, abort, or the user rejected).
\* The active ask clears too, so the next ask can enter.
EndNoConsume(k) ==
    /\ cur = k
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ awaiting' = 0
    /\ cur' = 0
    /\ UNCHANGED <<pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
        consumedWhile, begun, published, tsBumped, armedAfterBump, arrivals>>

Next ==
    \/ \E k \in 1..MaxAsks : MintAsk(k)
    \/ \E k \in 1..MaxAsks : Publish(k)
    \/ \E k \in 1..MaxAsks : BumpTs(k)
    \/ \E k \in 1..MaxAsks : ArmAsk(k)
    \/ Arrive
    \/ \E k \in 1..MaxAsks : Consume(k)
    \/ \E k \in 1..MaxAsks : EndNoConsume(k)

Spec == Init /\ [][Next]_vars

\* A consumed response arrived while the consuming ask itself awaited.
OnlyOwnResponse ==
    \A k \in 1..MaxAsks : consumed[k] => consumedWhile[k] = k

\* A response that arrived while no ask awaited satisfies no ask at all.
NoOrphanApproval ==
    \A k \in 1..MaxAsks : consumed[k] => consumedWhile[k] # Orphan

\* A consumed response arrived after its own ask's row was published: an
\* arrival in the entry window is an orphan no ask may consume (issue 998
\* review r3, the completion-path arm).
OnlyOwnPublishedResponse ==
    \A k \in 1..MaxAsks :
        consumed[k] => consumedWhile[k] = k /\ consumedPhase[k] = "pub"

\* An ask whose ts moved on consumes nothing: its wait exits as superseded.
NoStaleConsumption ==
    \A k \in 1..MaxAsks : tsBumped[k] => ~consumed[k]

\* The arm is monotonic: it never fires for an ask whose ts already moved on,
\* so an out-of-date publication cannot take the arm slot (issue 998 review r3).
ArmOnlyWhileCurrent == armedAfterBump = FALSE
====
