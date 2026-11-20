---- MODULE ExceptionCapture ----
\* Source: TelemetryService.captureException. Sink: TelemetryClient.captureException.
\* Initial rules were recorded before review, after reading the current fix.
\* Failures: repeats emit, distinct fields collide, blocked calls consume state, or the cache grows.
\* Invariants: IdentityOnce, WindowDecision, FieldsDistinct, BlockedUnchanged, Bounded.
\* Expected: field collisions or identity and window boundary errors. No prior telemetry spec exists.
\* Review: PR 2330 discussion_r4486068932 adds CallerMessage. It was an initial gap.
\* Review: PR 2330 discussion_r4486070563 is covered by WindowDecision, including expiry.
\* The window is 30 seconds. A retry after a longer gap emits again. This is not retry-chain identity.
\* Client mutation is an oracle. The model does not copy PostHog message extraction.
\* Result: Fixed holds in 67 states. All five variants fail their invariants. Each run takes less than 2 seconds.
\* Cost: about 6 minutes of agent work for the spec, tests, replay, and fixes. Review: 1 covered, 1 added, 0 gap.
\* New finding: joined fields collide (a|b, c versus a, b|c). A real-code test failed before the JSON tuple fix.
\* Replay: the real PostHog client changed the source message. Three inputs failed before the detached-copy fix.
\* Replay: removal of identity, window, and size guards each makes its real-code test fail.
\* Null result: no new window boundary bug. Tests accept a new event at 30 seconds and at a 600-second retry gap.
\* No oracle counterexample was rejected as an impossible input. This checks the model, not code correctness.
\* Property: TelemetryService.exception-single-capture.test.ts checks all 256 four-call traces on real code.
\* Sink replay: PostHogTelemetryClient.message-preservation.test.ts uses the real client and a fake PostHog transport.
\* ready is the service gate, not the client opt-in flag. A registered client can still filter an event.
\* Each gap is time since the last cache write. Ages saturate at expiry. The model covers API errors only.
\* One id denotes one field tuple; fresh chooses a new instance. Client network success is outside this model.
\* Eviction can admit a repeat early. The window rule applies only to a retained fingerprint.

EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Mode, Limit, Steps
VARIABLES seen, cache, step, checks
vars == <<seen, cache, step, checks>>
Ids == 1..3
\* Two realistic field tuples have the same delimiter-joined text.
Fields(i) == CASE i = 1 -> <<"a|b", "c">> [] i = 2 -> <<"a", "b|c">> [] OTHER -> <<"a", "c">>
Key(i) == IF Mode = "Joined" /\ i \in {1, 2} THEN Fields(1) ELSE Fields(i)
Drop(c, k) == SelectSeq(c, LAMBDA e : e.key # k)
Init == seen = {} /\ cache = <<>> /\ step = 0 /\ checks = [identity |-> TRUE, window |-> TRUE, blocked |-> TRUE, caller |-> TRUE]
\* A gap of 2 is the expiry boundary; 3 represents a longer backoff gap.
Call(i, fresh, gap, ready, mutate) ==
    LET k == Key(i)
        entries == {n \in 1..Len(cache) : cache[n].key = k}
        recent == \E n \in entries : cache[n].age + gap < 2
        identity == ~fresh /\ i \in seen
        emit == ready /\ (~identity \/ Mode = "NoIdentity") /\ (Mode = "NoWindow" \/ ~recent)
        expected == ready /\ ~identity /\ ~recent
        aged == [n \in 1..Len(cache) |-> [cache[n] EXCEPT !.age = IF @ + gap > 2 THEN 2 ELSE @ + gap]]
        touched == Append(Drop(aged, k), [key |-> k, age |-> 0])
        nextCache == IF Len(touched) > Limit /\ Mode # "Unbounded" THEN Tail(touched) ELSE touched
        writes == ready /\ ~identity
    IN /\ step < Steps
       /\ step' = step + 1
       /\ seen' = IF ready THEN seen \cup {i} ELSE seen
       /\ cache' = IF writes THEN nextCache ELSE cache
       /\ checks' = [identity |-> checks.identity /\ ~(emit /\ identity),
                      window |-> checks.window /\ (emit = expected),
                      blocked |-> checks.blocked /\ (~ready => seen' = seen /\ cache' = cache),
                      caller |-> checks.caller /\ ~(emit /\ mutate /\ Mode = "Mutating")]
Next == \E i \in Ids, fresh \in BOOLEAN, gap \in 0..3, ready \in BOOLEAN, mutate \in BOOLEAN :
            Call(i, fresh, gap, ready, mutate)
Spec == Init /\ [][Next]_vars
TypeOK == seen \subseteq Ids /\ step \in 0..Steps /\ checks \in [ {"identity", "window", "blocked", "caller"} -> BOOLEAN ]
FieldsDistinct == step >= 0 => \A i, j \in Ids : Fields(i) # Fields(j) => Key(i) # Key(j)
\* checks records each decision and source preservation at each call.
WindowDecision == checks.window
IdentityOnce == checks.identity
BlockedUnchanged == checks.blocked
CallerMessage == checks.caller
Bounded == Len(cache) <= Limit
====
