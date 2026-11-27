---- MODULE AskResponseTargetingMC ----
\* Model-checking settings and sabotage variants for AskResponseTargeting.
EXTENDS AskResponseTargeting

\* Sabotage 1: the ownership gate at the consume step is removed. This is the
\* unfixed consume: any pending response satisfies the ask that reads it. The
\* lifecycle (awaiting, cur) and the ts guard mirror the fixed Consume, so the
\* gate is the only delta (review r4: without the guard this variant fails
\* NoStaleConsumption instead, masking a broken ownership-gate check).
\* OnlyOwnResponse must fail.
ConsumeNoGate(k) ==
    /\ cur = k
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
    /\ UNCHANGED <<begun, published, tsBumped, armedAfterBump, arrivals>>

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
        published, tsBumped, armedAfterBump, cur>>

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
    /\ pending' = (pending /\ rtag # Orphan)
    /\ rtag' = rtag
    /\ ghostArrival' = ghostArrival
    /\ ghostPhase' = ghostPhase
    /\ UNCHANGED <<consumed, consumedPhase, consumedWhile, ended, begun, published,
        tsBumped, cur, arrivals>>

\* Sabotage 4 (review r3): the currency guard is dropped — an out-of-date
\* publication arms its ask even though the ask's ts already moved on and its
\* wait will exit as superseded. The ghost flag makes the violation
\* observable. ArmOnlyWhileCurrent must fail.
ArmNoCurrentGuard(k) ==
    /\ cur = k
    /\ published[k]
    /\ armedAfterBump' = tsBumped[k]
    /\ awaiting' = k
    /\ pending' = (pending /\ rtag # Orphan)
    /\ rtag' = rtag
    /\ ghostArrival' = ghostArrival
    /\ ghostPhase' = ghostPhase
    /\ UNCHANGED <<consumed, consumedPhase, consumedWhile, ended, begun, published,
        tsBumped, cur, arrivals>>

====
\* Run each config on this module. AskResponseTargeting.cfg passes. Each variant
\* config fails the invariant of its failure.
