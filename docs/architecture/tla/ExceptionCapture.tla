---- MODULE ExceptionCapture ----
\* Single-eviction refactor: Refresh adds at most one key; Trim removes at most one oldest entry.
\* Failure: a call exceeds the cache limit. Bounded already covers this change. No new bug is expected.
\* Refactor result: 25 tests pass; 1,079 model states pass. All eight sabotages fail as expected.
\* Replay: removing eviction fails the existing cache-bound test. Cost: about one minute. Null result: no new bug.
\* Review ratchet, PR 2330 summary items 3 and 7: added single-field and plain-name input cases.
\* Current round: 0 covered, 2 added, 1 gap. Item 5 is a gap: client filters and task IDs are outside this model.
\* Expected: removing code, provider, model, or plain name must fail FieldsDistinct.
\* Replay: each matching production mutation fails the single-capture test suite.
\* Result: fixed model holds in 1,079 states. All eight sabotage configs fail their intended invariant.
\* Cost: about 10 minutes shared across the three models, tests, replays, and fixes. No new bug beyond the review.
\* FieldCases checks extra input pairs without increasing the cache state domain.
\* Gate: TLA_JAR=<jar> ./check.sh ExceptionCaptureMC ExceptionCopyMC OpenRouterExceptionMC
\* Source: TelemetryService.captureException. Sink: each registered TelemetryClient.captureException.
\* Failures: repeats emit, distinct fields collide, blocked calls change state, or the cache grows.
\* Rules: WindowDecision, FieldsDistinct, BlockedUnchanged, and Bounded prevent those failures.
\* Expected before simplification: the shared cache refresh preserves all rules. No new code bug is expected.
\* Initial rules preceded review comments, but followed inspection of the original fix.
\* Review: PR 2330 discussion_r4486070563 is covered by WindowDecision, including window expiry.
\* Review counts for this module: 1 covered, 0 added, 0 gap. Copy findings are in ExceptionCopy.
\* Prior replay found delimiter collisions. The JSON tuple fix keeps (a|b, c) distinct from (a, b|c).
\* Prior replay removed identity, window, and size guards. Each real-code regression test failed.
\* Property tests: TelemetryService.exception-single-capture.test.ts checks 256 four-call traces and cache eviction.
\* A time advance saturates cache ages at expiry. It is separate from a capture call.
\* Instance identity is separate from field equality. Two instances can have the same fields.
\* The window applies to retained entries. Expiry or eviction permits a fresh instance to emit again.
\* ready is the service gate, not client opt-in. Client filtering and network success are outside the model.
\* Historical cost: about 6 minutes for the first spec, replay, tests, and fixes.
\* Previous result: ExceptionCaptureMC holds in 1,079 states. Joined, NoIdentity, NoWindow, and Unbounded each fail.
\* Cost: about 4 minutes across both new models, the code refactor, and validation. Each TLC run takes less than 2 seconds.
\* Null result: no new production bug. The shared refresh passes the property tests and eviction regression.
\* WindowDecision covers repeat identity, so the redundant identity history flag was removed.
\* BlockedUnchanged is an action property; it needs no history flag. The instance set bounds marked.
\* The copy model has its own states. Combining it with this cache would add unrelated state combinations.
\* Guidance: https://lamport.azurewebsites.net/tla/book-02-02-27.pdf (Chapter 7).
\* MC layout: https://github.com/tlaplus/vscode-tlaplus/blob/master/resources/knowledgebase/tlc-config-files.md
\* TLC checks the model, not code correctness. The prior trace-limited model visited 67 states.

EXTENDS Naturals, Sequences
CONSTANTS Instances, Fields, FieldCases, Fingerprint(_), Window, Limit, Gaps,
          IdentityGuard, WindowGuard, SizeGuard
VARIABLES marked, cache, last
vars == <<marked, cache, last>>

NoCall == [kind |-> "tick", ready |-> FALSE, marked |-> FALSE, recent |-> FALSE, emitted |-> FALSE]
Drop(c, k) == SelectSeq(c, LAMBDA entry : entry.key # k)
Recent(c, k) == \E n \in 1..Len(c) : c[n].key = k /\ c[n].age < Window
Refresh(c, k) == Append(Drop(c, k), [key |-> k, age |-> 0])
Trim(c) == IF SizeGuard /\ Len(c) > Limit THEN Tail(c) ELSE c

Init == marked = {} /\ cache = <<>> /\ last = NoCall

Call(i, ready) ==
    LET key == Fingerprint(Fields[i])
        known == i \in marked
        recent == Recent(cache, key)
        accepts == ready /\ (~IdentityGuard \/ ~known)
    IN /\ marked' = IF ready THEN marked \cup {i} ELSE marked
       /\ cache' = IF accepts THEN Trim(Refresh(cache, key)) ELSE cache
       /\ last' = [kind |-> "call", ready |-> ready, marked |-> known, recent |-> recent,
                    emitted |-> accepts /\ (~WindowGuard \/ ~recent)]

Tick(gap) ==
    /\ cache' = [n \in 1..Len(cache) |->
          [cache[n] EXCEPT !.age = IF @ + gap >= Window THEN Window ELSE @ + gap]]
    /\ last' = NoCall
    /\ UNCHANGED marked

Next == (\E i \in Instances, ready \in BOOLEAN : Call(i, ready)) \/ (\E gap \in Gaps : Tick(gap))
Spec == Init /\ [][Next]_vars

TypeOK == /\ marked \subseteq Instances
          /\ cache \in Seq([key : {Fingerprint(Fields[i]) : i \in Instances}, age : 0..Window])
          /\ last \in [kind : {"call", "tick"}, ready : BOOLEAN, marked : BOOLEAN,
                       recent : BOOLEAN, emitted : BOOLEAN]
WindowDecision == last.kind = "call" =>
    (last.emitted = (last.ready /\ ~last.marked /\ ~last.recent))
FieldsDistinct == last.kind = "call" => \A a, b \in FieldCases :
    a # b => Fingerprint(a) # Fingerprint(b)
Bounded == Len(cache) <= Limit
\* A blocked call leaves both policy stores unchanged. Time advances are separate actions.
BlockedUnchanged == [][(last'.kind = "call" /\ ~last'.ready) => UNCHANGED <<marked, cache>>]_vars
====
