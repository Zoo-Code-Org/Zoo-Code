---- MODULE AskResponseTargetingMC ----
\* Model-checking settings and sabotage variants for AskResponseTargeting.
EXTENDS AskResponseTargeting

\* Sabotage 1: the ownership gate at the consume step is removed. This is the
\* unfixed consume: any pending response satisfies the ask that reads it.
ConsumeNoGate(k) ==
    /\ cur = k
    /\ ~ended[k]
    /\ pending
    /\ consumed' = [consumed EXCEPT ![k] = TRUE]
    /\ consumedWhile' = [consumedWhile EXCEPT ![k] = ghostArrival]
    /\ ended' = [ended EXCEPT ![k] = TRUE]
    /\ pending' = FALSE
    /\ rtag' = Orphan
    /\ ghostArrival' = Orphan
    /\ UNCHANGED <<awaiting, begun, cur, arrivals>>

\* Sabotage 2: the tag is written from the ask that is minted, not from the ask
\* that awaits. A response arriving during the entry window then carries the new
\* ask's token and passes the gate, while the ghost still records the orphan truth.
ArriveTagByCur ==
    /\ arrivals < MaxArrivals
    /\ arrivals' = arrivals + 1
    /\ pending' = TRUE
    /\ rtag' = IF cur > 0 THEN cur ELSE Orphan
    /\ ghostArrival' = IF awaiting > 0 THEN awaiting ELSE Orphan
    /\ UNCHANGED <<awaiting, consumed, consumedWhile, ended, begun, cur>>

====
\* Run each config on this module. AskResponseTargeting.cfg passes. Each variant
\* config fails the invariant of its failure.
