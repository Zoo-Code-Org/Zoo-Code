---- MODULE AskResponseTargetingMC ----
\* Model-checking settings and sabotage variants for AskResponseTargeting.
EXTENDS AskResponseTargeting

\* Sabotage 1: the ownership gate at the consume step is removed. This is the
\* unfixed consume: any pending response satisfies the ask that reads it. The
\* lifecycle (awaiting, cur) and the ts guard mirror the fixed Consume, so the
\* gate is the only delta (review r4: without the guard this variant fails
\* NoStaleConsumption instead, masking a broken ownership-gate check; review
\* 6093228862: the consume is bound to the armed wait phase, so the failing
\* trace publishes and arms first -- an entry-window orphan survives the
\* preserving arm and the ungated wait consumes it after publication).
\* OnlyOwnResponse must fail.
ConsumeNoGate(k) ==
    /\ cur = k
    /\ awaiting = k
    /\ ~ended[k]
    /\ ~tsBumped[k]
    /\ pending
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

\* Sabotage 2: the tag is written from the ask that is minted, not from the ask
\* that awaits. A response arriving during the entry window then carries the new
\* ask's token and passes the gate, while the ghost still records the orphan
\* truth. OnlyOwnResponse must fail.
ArriveTagByCur ==
    /\ arrivals < MaxArrivals
    /\ arrivals' = arrivals + 1
    /\ pending' = TRUE
    /\ rtag' = IF cur > 0 THEN cur ELSE Orphan
    /\ ghostArrival' = IF awaiting > 0 THEN awaiting ELSE Orphan
    /\ ghostPhase' = IF awaiting > 0
        THEN (IF published[awaiting] THEN "pub" ELSE "entry")
        ELSE "none"
    /\ UNCHANGED <<awaiting, consumed, consumedPhase, consumedWhile, ended, begun,
        published, tsBumped, armedAfterBump, curArmed, cur>>

\* Sabotage 3 (review r3): the arm fires at the entry phase, before the row
\* published — the completion path's pre-save arm. A response landing in the
\* entry window is then tagged with this ask and satisfies it, so the next
\* command runs on the previous command's approval. OnlyOwnPublishedResponse
\* must fail.
ArmEarly(k) ==
    /\ cur = k
    /\ ~tsBumped[k]
    /\ armedAfterBump' = FALSE
    /\ awaiting' = k
    /\ UNCHANGED <<pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
        consumedWhile, ended, begun, published, tsBumped, curArmed, cur, arrivals>>

\* Sabotage 4 (review r3): the currency guard is dropped — an out-of-date
\* publication arms its ask even though the ask's ts already moved on and its
\* wait will exit as superseded. The ghost flag makes the violation
\* observable. ArmOnlyWhileCurrent must fail.
ArmNoCurrentGuard(k) ==
    /\ cur = k
    /\ published[k]
    /\ armedAfterBump' = tsBumped[k]
    /\ awaiting' = k
    /\ UNCHANGED <<pending, rtag, ghostArrival, ghostPhase, consumed, consumedPhase,
        consumedWhile, ended, begun, published, tsBumped, curArmed, cur, arrivals>>

\* Sabotage 5 (review 6084536709): the superseded ask's cleanup clears the arm
\* slot unconditionally, so ask k's late unwind wipes a newer ask's armed
\* token -- the exact wipe the keeps-a-newer-ask's-token test forbids on the
\* real path. ArmSlotCurrent must fail.
StaleCleanupStaleWipe(k) ==
    /\ cur # k
    /\ tsBumped[k]
    /\ ~ended[k]
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ awaiting' = 0
    /\ pending' = FALSE
    /\ rtag' = Orphan
    /\ ghostArrival' = Orphan
    /\ ghostPhase' = "none"
    /\ UNCHANGED <<consumed, consumedPhase, consumedWhile, begun, published,
        tsBumped, armedAfterBump, curArmed, cur, arrivals>>

====
\* Run each config on this module. AskResponseTargeting.cfg passes. Each variant
\* config fails the invariant of its failure. StaleCleanupStaleWipe fails
\* ArmSlotCurrent.
