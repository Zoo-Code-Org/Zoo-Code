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
\* The model runs asks 1..MaxAsks in order, because the presenter runs tools one at a time;\n\* a superseded ask may still unwind while its successor arms (the unwind race below).
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
\* .NoGate on OnlyOwnResponse (the ungated wait-step consume takes an entry-window
\* orphan the arm preserved; the consume lands after publication), .TagByCur on OnlyOwnResponse (a tag
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
\* fields, so the gate and the truth cannot drift. Also still not modeled (bounded
\* gaps, each pinned by a test in ask-response-targeting.spec.ts): the status-timer
\* arming rule, and the late publication of a parked older ask (Publish still
\* requires cur = k; the arm skip is pinned by the older-publication test).
\* The unwind race itself is modeled since review 6084536709: ask k mints over
\* a superseded, unended k-1, and StaleCleanup(k-1) then clears only k-1's own
\* arm; ArmSlotCurrent pins it and .StaleWipe is the unconditional sabotage.
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
\* objectResponse
\* negative test seeds the owning row ts so the response-kind exclusion, not the
\* unset stamp, is what leaves the row unmarked.
\* Review ratchet (review 6084536709): covered 1, added 2, gap 0.
\* Covered: the keeps-a-newer-ask's-token behavior the reviewer cites was already
\* test-pinned on this head. Added: the unwind race -- MintAsk enters ask k over
\* a superseded, unended k-1 and StaleCleanup(k) ends k late while clearing only
\* k's own arm, with ArmSlotCurrent as the invariant. Added: the .StaleWipe
\* sabotage, whose unconditional clearing must fail ArmSlotCurrent.
\* Review ratchet (review 6093228862, finding on AskResponseTargeting.tla:173):
\* added 1. The arm no longer folds the orphan discard -- the arm preserves the
\* slot, as the real wait reads the slot it finds -- and both consume actions
\* are constrained to the armed wait phase (awaiting = k). The orphan
\* rejection now lives only in the wait step's gate, matching the real
\* Task.ask ordering: publish, arm, then reject or accept inside the wait.
\* The .NoGate sabotage then fails on a reachable schedule: MintAsk, an
\* entry-window Arrive, Publish, ArmAsk (slot preserved), ConsumeNoGate --
\* the orphan is consumed after publication. The old trace (consume before
\* publication or arming) is unreachable now, so the sabotage pins the
\* realistic defect.

EXTENDS Naturals

CONSTANTS MaxAsks, Orphan, MaxArrivals

VARIABLES awaiting, pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
    consumedWhile, ended, begun, published, tsBumped, armedAfterBump, cur, curArmed, arrivals
vars == <<awaiting, pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
    consumedWhile, ended, begun, published, tsBumped, armedAfterBump, cur, curArmed, arrivals>>

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
    /\ curArmed \in BOOLEAN
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
    /\ curArmed = FALSE
    /\ arrivals = 0

\* ask() begins for ask k. The entry reset clears the slot. Nothing awaits yet
\* and the row is not published. Ask k may also enter while ask k-1 is
\* superseded (its ts moved on) and still winding down: ask 1's cleanup lands
\* after ask 2 can arm (the keeps-a-newer-ask's-token test).
MintAsk(k) ==
    /\ ~begun[k]
    /\ k = 1 \/ (k > 1 /\ (ended[k - 1] \/ (tsBumped[k - 1] /\ cur = k - 1)))
    /\ begun' = [begun EXCEPT ![k] = TRUE]
    /\ cur' = k
    /\ curArmed' = FALSE
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
        consumedPhase, consumedWhile, ended, begun, tsBumped, armedAfterBump, curArmed, cur, arrivals>>

\* lastMessageTs moves past ask k while it still runs: supersedePendingAsk, or
\* another flow publishing a row. The ask's wait will exit as superseded.
BumpTs(k) ==
    /\ cur = k
    /\ ~ended[k]
    /\ tsBumped' = [tsBumped EXCEPT ![k] = TRUE]
    /\ UNCHANGED <<awaiting, pending, rtag, ghostArrival, ghostPhase, consumed,
        consumedPhase, consumedWhile, ended, begun, published, armedAfterBump, curArmed, cur, arrivals>>

\* ask() arms its wait at the ask row's publication boundary, and only while the
\* ask is still current. The arm preserves the slot: the real wait reads the
\* slot it finds, so whatever the entry window left there stays (review
\* 6093228862). The wait step does the rejecting -- Consume requires this ask's
\* own tag, so an orphan present at the first wait poll satisfies nothing.
\* Arming never manufactures a response: an empty slot stays empty.
ArmAsk(k) ==
    /\ cur = k
    /\ published[k]
    /\ ~tsBumped[k]
    /\ armedAfterBump' = FALSE
    /\ awaiting' = k
    /\ curArmed' = TRUE
    /\ UNCHANGED <<pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
        consumedWhile, ended, begun, published, tsBumped, cur, arrivals>>

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
        published, tsBumped, armedAfterBump, curArmed, cur>>

\* The consume step, inside the armed wait: the ask reads the slot only while
\* its own wait is live (awaiting = k). The ownership gate: only a response
\* tagged with this ask's token may satisfy it, and only while the ask is
\* still current (a superseded ask exits as superseded, never by consuming).
\* The ghost stores the arrival truth for the invariants. Consuming ends the
\* ask: the arm clears with the active ask, and the next ask may enter.
Consume(k) ==
    /\ cur = k
    /\ awaiting = k
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
    /\ UNCHANGED <<begun, published, tsBumped, armedAfterBump, curArmed, arrivals>>

\* The ask ends without consuming (superseded, abort, or the user rejected).
\* The active ask clears too, so the next ask can enter.
EndNoConsume(k) ==
    /\ cur = k
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ awaiting' = 0
    /\ cur' = 0
    /\ UNCHANGED <<pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
        consumedWhile, begun, published, tsBumped, armedAfterBump, curArmed, arrivals>>

\* A superseded ask's cleanup lands after its wait exited: cur has moved to
\* the successor that raced in over the bump. The cleanup clears only this
\* ask's own arm and own-tagged response; a newer ask's armed token survives
\* it (the keeps-a-newer-ask's-token test).
StaleCleanup(k) ==
    /\ cur # k
    /\ tsBumped[k]
    /\ ~ended[k]
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ awaiting' = IF awaiting = k THEN 0 ELSE awaiting
    /\ pending' = IF pending /\ rtag = k THEN FALSE ELSE pending
    /\ rtag' = IF pending /\ rtag = k THEN Orphan ELSE rtag
    /\ ghostArrival' = IF pending /\ rtag = k THEN Orphan ELSE ghostArrival
    /\ ghostPhase' = IF pending /\ rtag = k THEN "none" ELSE ghostPhase
    /\ UNCHANGED <<consumed, consumedPhase, consumedWhile, begun, published,
        tsBumped, armedAfterBump, curArmed, cur, arrivals>>

Next ==
    \/ \E k \in 1..MaxAsks : MintAsk(k)
    \/ \E k \in 1..MaxAsks : Publish(k)
    \/ \E k \in 1..MaxAsks : BumpTs(k)
    \/ \E k \in 1..MaxAsks : ArmAsk(k)
    \/ Arrive
    \/ \E k \in 1..MaxAsks : Consume(k)
    \/ \E k \in 1..MaxAsks : EndNoConsume(k)
    \/ \E k \in 1..MaxAsks : StaleCleanup(k)

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

\* Once the current ask armed, the arm slot holds it: a superseded ask's late
\* cleanup must not wipe a newer ask's armed token (issue 998 review
\* 6084536709).
ArmSlotCurrent == (cur > 0 /\ curArmed) => awaiting = cur
====
