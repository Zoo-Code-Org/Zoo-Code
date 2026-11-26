---- MODULE AskResponseTargeting ----
\* Models the response slot between handleWebviewAskResponse and the consume step at the
\* end of Task.ask in src/core/task/Task.ts.
\* Source: handleWebviewAskResponse writes askResponse when a response event arrives
\* (a user click, a queue answer, an auto-approval). Sink: the consume step in ask()
\* reads askResponse and hands it to the tool callback.
\* Failure 1: a response that arrived while no ask was awaiting satisfies a later ask.
\* An orphan click between two asks (a double click, a late event) then runs the next
\* command without its own prompt (issue 998).
\* Invariants: OnlyOwnResponse (a consumed response arrived while its own ask awaited),
\* NoOrphanApproval (a response that arrived while no ask awaited satisfies no ask).
\* The model has serial asks 1..MaxAsks, because the presenter runs tools one at a time.
\* Each ask has two phases: Entry (the slot is reset, nothing awaits) and Armed.
\* Arrive writes the tag: the ask that awaits now, Orphan when none awaits. The ghost
\* arrival records the same fact for the invariant, so the gate and the truth cannot drift.
\* Arm folds in the first wait poll: an orphan that sits in the slot at arm time dies there.
\* Not modeled: the queued-message drain (QueueDrainRetry.tla owns the queue; its answers
\* go through this same slot), the auto-approval timeout token, the text and image payload.
\* Expected before the fix: the NoGate config reproduces failure 1 on the unfixed code.
\* Result: AskResponseTargeting.cfg holds (60 states). Each sabotage config fails:
\* .NoGate on OnlyOwnResponse and NoOrphanApproval (the unfixed consume), .TagByCur on
\* OnlyOwnResponse (a tag written from the minted ask instead of the awaiting ask).
\* Code check: the sabotage matches the entry-window leak that
\* src/core/task/__tests__/ask-response-targeting.spec.ts and
\* src/core/task/__tests__/Task.command-batch-approval.spec.ts replay on the real ask
\* path (each failed on the unfixed code and passes on the fixed code).
\* Cost: the spec run takes under 5 seconds. Agent time: about 2.5 hours for the
\* spec, the two tests, and the Task.ts gate (find + fix + verify).
\* Null result: none — the first version found the entry-window leak the plain
\* between-ask orphan does not cover, and the isBlocking fast path around the wait.

EXTENDS Naturals

CONSTANTS MaxAsks, Orphan, MaxArrivals

VARIABLES awaiting, pending, rtag, ghostArrival, consumed, consumedWhile, ended, begun, cur, arrivals
vars == <<awaiting, pending, rtag, ghostArrival, consumed, consumedWhile, ended, begun, cur, arrivals>>

TypeOK ==
    /\ awaiting \in {0} \union (1..MaxAsks)
    /\ pending \in BOOLEAN
    /\ rtag \in {Orphan} \union (1..MaxAsks)
    /\ ghostArrival \in {Orphan} \union (1..MaxAsks)
    /\ consumed \in [1..MaxAsks -> BOOLEAN]
    /\ consumedWhile \in [1..MaxAsks -> {Orphan} \union (1..MaxAsks)]
    /\ ended \in [1..MaxAsks -> BOOLEAN]
    /\ begun \in [1..MaxAsks -> BOOLEAN]
    /\ cur \in {0} \union (1..MaxAsks)
    /\ arrivals \in 0..MaxArrivals

Init ==
    /\ awaiting = 0
    /\ pending = FALSE
    /\ rtag = Orphan
    /\ ghostArrival = Orphan
    /\ consumed = [k \in 1..MaxAsks |-> FALSE]
    /\ consumedWhile = [k \in 1..MaxAsks |-> Orphan]
    /\ ended = [k \in 1..MaxAsks |-> FALSE]
    /\ begun = [k \in 1..MaxAsks |-> FALSE]
    /\ cur = 0
    /\ arrivals = 0

\* ask() begins for ask k. The entry reset clears the slot. Nothing awaits yet.
MintAsk(k) ==
    /\ cur = 0
    /\ ~begun[k]
    /\ k = 1 \/ (k > 1 /\ ended[k - 1])
    /\ begun' = [begun EXCEPT ![k] = TRUE]
    /\ cur' = k
    /\ pending' = FALSE
    /\ rtag' = Orphan
    /\ ghostArrival' = Orphan
    /\ UNCHANGED <<awaiting, consumed, consumedWhile, ended, arrivals>>

\* ask() arms its wait after the ask row is posted. An orphan present at the first
\* wait poll is discarded there; the spec folds that discard into this action.
ArmAsk(k) ==
    /\ cur = k
    /\ awaiting' = k
    /\ pending' = ~(pending /\ rtag = Orphan)
    /\ rtag' = rtag
    /\ ghostArrival' = ghostArrival
    /\ UNCHANGED <<consumed, consumedWhile, ended, begun, cur, arrivals>>

\* A response event arrives at any time. The host tags it with the ask that awaits
\* now (Orphan when none awaits); the ghost records the same fact.
Arrive ==
    /\ arrivals < MaxArrivals
    /\ arrivals' = arrivals + 1
    /\ pending' = TRUE
    /\ rtag' = IF awaiting > 0 THEN awaiting ELSE Orphan
    /\ ghostArrival' = rtag'
    /\ UNCHANGED <<awaiting, consumed, consumedWhile, ended, begun, cur>>

\* The consume step. The ownership gate: only a response tagged with this ask's
\* token may satisfy it. The ghost stores the arrival truth for the invariant.
Consume(k) ==
    /\ cur = k
    /\ ~ended[k]
    /\ pending
    /\ rtag = k
    /\ consumed' = [consumed EXCEPT ![k] = TRUE]
    /\ consumedWhile' = [consumedWhile EXCEPT ![k] = ghostArrival]
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ pending' = FALSE
    /\ rtag' = Orphan
    /\ ghostArrival' = Orphan
    /\ UNCHANGED <<awaiting, begun, cur, arrivals>>

\* The ask ends without consuming (superseded, abort, or the user rejected).
EndNoConsume(k) ==
    /\ cur = k
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ awaiting' = 0
    /\ UNCHANGED <<pending, rtag, ghostArrival, consumed, consumedWhile, begun, cur, arrivals>>

Next ==
    \/ \E k \in 1..MaxAsks : MintAsk(k)
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
====
