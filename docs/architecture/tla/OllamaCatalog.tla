---- MODULE OllamaCatalog ----
\* Source: NativeOllamaHandler.fetchModel and ensureModelFetched. Sink: getModel.
\* Failures: duplicate discovery, lost retry, stale metadata, and shared cancellation.
\* Initial invariant sentences were recorded before review; the formal model came after.
\* One fetch is active. A loaded catalog is reused. Empty and failed loads can retry.
\* Completed waits expose metadata. One cancelled waiter cannot reject a live waiter.
\* Expected: cache and retry hold. A request-owned signal can reject a live waiter.
\* Network success, empty data, and failure are oracles. Two callers use two rounds.
\* Review: 1 covered, 0 added, 1 gap. PR 2520 discussion_r4638899789 is covered.
\* Gap: the Codecov partial-branch report is a code coverage result, not model state.
\* Results: fixed passes in 128 states. RequestOwned fails in 19 states.
\* Sabotage: Duplicate fails in 6, NoPublish in 7, and NoRetry in 8 states.
\* Replay: the original code fails 16 of 64 cancellation schedules. The fix passes all.
\* Code sabotage: duplicate loads, no metadata assignment, and cached empty loads each fail a test.
\* No false alarm was retained. No new code failure was found beyond the expected cancellation bug.
\* Cost: five TLC runs take about 4 seconds. Fixed focused tests take about 8 seconds.
\* Original-code replay took 76 seconds. Code sabotage took 3 seconds. Agent work took about 8 minutes.
\* The model checks discovery and publication. Task context management has a separate integration test.
\* SingleFlight needs a count to detect the Duplicate variant; phase alone cannot show duplicate work.
\* The model does not prove the code correct.
EXTENDS Naturals, TLC
CONSTANTS RequestOwnsFetch, PublishMetadata, Deduplicate, ClearFailedLoad
CONSTANTS Clients, MaxRounds, FallbackInfo, DiscoveredInfo
VARIABLES phase, callers, owner, round, starts, leaked, metadata
vars == <<phase, callers, owner, round, starts, leaked, metadata>>
Init ==
    /\ phase = "idle"
    /\ callers = [c \in Clients |-> "new"]
    /\ owner = 0 /\ round = 1 /\ starts = 0
    /\ leaked = FALSE /\ metadata = FallbackInfo
Start(c) ==
    /\ callers[c] = "new"
    /\ callers' = [callers EXCEPT ![c] = IF phase = "ready" THEN "done" ELSE "wait"]
    /\ phase' = IF phase = "idle" THEN "fetch" ELSE phase
    /\ owner' = IF phase = "idle" THEN c ELSE owner
    /\ starts' = starts + IF phase = "idle" \/ (phase = "fetch" /\ ~Deduplicate) THEN 1 ELSE 0
    /\ UNCHANGED <<round, leaked, metadata>>
Cancel(c) ==
    /\ callers[c] = "wait"
    /\ callers' = [x \in Clients |->
         IF x = c THEN "cancelled"
         ELSE IF RequestOwnsFetch /\ owner = c /\ callers[x] = "wait" THEN "failed"
         ELSE callers[x]]
    /\ leaked' = (leaked \/ (RequestOwnsFetch /\ owner = c /\
          \E x \in Clients \ {c}: callers[x] = "wait"))
    /\ phase' = IF RequestOwnsFetch /\ owner = c THEN "idle" ELSE phase
    /\ starts' = IF RequestOwnsFetch /\ owner = c THEN 0 ELSE starts
    /\ UNCHANGED <<owner, round, metadata>>
Settle(result) ==
    /\ phase = "fetch"
    /\ phase' = IF result = "models" THEN "ready" ELSE IF ClearFailedLoad THEN "idle" ELSE "stuck"
    /\ callers' = [c \in Clients |-> IF callers[c] = "wait"
          THEN IF result = "error" THEN "failed" ELSE "done" ELSE callers[c]]
    /\ starts' = 0
    /\ metadata' = IF result = "models" /\ PublishMetadata THEN DiscoveredInfo ELSE metadata
    /\ UNCHANGED <<owner, round, leaked>>
Retry ==
    /\ round < MaxRounds /\ phase # "fetch"
    /\ \A c \in Clients: callers[c] # "wait"
    /\ round' = round + 1 /\ starts' = 0
    /\ callers' = [c \in Clients |-> "new"]
    /\ UNCHANGED <<phase, owner, leaked, metadata>>
Next == (\E c \in Clients: Start(c) \/ Cancel(c))
        \/ (\E r \in {"models", "empty", "error"}: Settle(r)) \/ Retry
NoSharedCancellation == ~leaked
SingleFlight == starts <= 1
CacheReused == phase = "ready" => \A c \in Clients: callers[c] # "wait"
Retryable == phase # "stuck"
MetadataPublished == phase = "ready" => metadata = DiscoveredInfo
Spec == Init /\ [][Next]_vars
====
