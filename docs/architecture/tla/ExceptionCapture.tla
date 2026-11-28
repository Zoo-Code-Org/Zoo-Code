---- MODULE ExceptionCapture ----
\* Source: TelemetryService.captureException. Sink: registered TelemetryClient.captureException calls.
\* Failures: repeats emit, distinct fields collide, blocked calls consume state, or the cache exceeds its bound.
\* WindowDecision, FieldsDistinct, BlockedUnchanged, and Bounded check these rules. Client delivery remains an oracle.
\* SuppressedMarked checks flags on window hits. IdentityDoesNotRefresh checks identity hits before cache refresh.
\* Review ratchet, PR #2330, supplied review without thread URLs: items 1, 2, 3, and 8 add boundary checks or invariants.
\* Items 4, 5, 6, 7, 9, and 10 are gaps: PR prose, test labels, descriptor flags, and header layout need direct checks.
\* This review totals 0 covered, 4 added, 6 gaps across the three models. Each finding is counted once here.
\* Prior review coverage: identity, window expiry, field boundaries, single-field differences, and bounded eviction.
\* Expectation: OptInGuard=FALSE changes state while disabled. MarkSuppressed=FALSE loses a suppressed instance flag.
\* IdentityFirst=FALSE refreshes the window on an identity hit. The fixed model must reject all three defects.
\* ready checks service readiness. enabled is the client opt-in oracle. No network-success claim is made.
\* Property tests: TelemetryService.exception-single-capture.test.ts checks short traces, flags, timing, gates, and eviction.
\* Results: 1,079 fixed states pass. All 11 capture sabotage configs fail, including the three new guard mutations.
\* Replay: opt-in tests fail twice on old code. Late marking and late identity each fail their new timing test.
\* Property tests pass after the fix. No false counterexample or new runtime defect beyond the review was found.
\* Cost: one agent, about six minutes shared across all three models, tests, mutations, and PR text. No delegates.
\* Simplification: nextMarked is derived. The client gate is an input oracle, not a new persisted state variable.
\* TLC checks this model, not implementation correctness.

\* Review trace: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2330#discussion_r4486070563 covers the dedupe window.
\* Earlier rounds: capture 1 covered, 0 added, 0 gaps; field inputs 0 covered, 2 added, 1 gap.
\* Historical costs: first capture spec about 6 minutes; model split about 4 minutes; prior review about 10 minutes shared.
\* Single-eviction follow-up cost about 1 minute. The earlier combined review counts remain above.
\* Current six-finding review: 0 covered, 1 added, 5 gaps. Error-body preservation adds two OpenRouter invariants.
\* Gaps: PR scope, duplicate test setup, missing header history, flag wording, and ambiguous review labels need direct checks.
\* Expectation: these text and test changes reveal no new runtime defect. Existing capture and copy checks must still pass.
\* Current result: all 24 selected configs give the expected result. Fixed states: capture 1,079; copy 64; provider 24.
\* All 54 provider and 146 telemetry tests pass. Removing the body fails four provider body checks.
\* With body assertions omitted, the same mutation fails both numeric-code message checks. Production code is restored.
\* Current cost: one agent, about 6 minutes for models, tests, mutation replays, header history, and PR text. No delegates.
\* Null result: no new runtime defect beyond the reported coverage gap. No runtime counterexample was rejected.
EXTENDS Naturals, Sequences
CONSTANTS Instances, Fields, FieldCases, Fingerprint(_), Window, Limit, Gaps,
          IdentityGuard, WindowGuard, SizeGuard, OptInGuard, MarkSuppressed, IdentityFirst
VARIABLES marked, cache, last
vars == <<marked, cache, last>>

NoCall == [kind |-> "tick", ready |-> FALSE, marked |-> FALSE, recent |-> FALSE, markedAfter |-> FALSE, emitted |-> FALSE]
Drop(c, k) == SelectSeq(c, LAMBDA entry : entry.key # k)
Recent(c, k) == \E n \in 1..Len(c) : c[n].key = k /\ c[n].age < Window
Refresh(c, k) == Append(Drop(c, k), [key |-> k, age |-> 0])
Trim(c) == IF SizeGuard /\ Len(c) > Limit THEN Tail(c) ELSE c

Init == marked = {} /\ cache = <<>> /\ last = NoCall

Call(i, ready, enabled) ==
    LET key == Fingerprint(Fields[i])
        known == i \in marked
        recent == Recent(cache, key)
        allowed == ready /\ (~OptInGuard \/ enabled)
        accepts == allowed /\ (~IdentityGuard \/ ~known)
        nextMarked == IF allowed /\ (MarkSuppressed \/ ~recent) THEN marked \cup {i} ELSE marked
    IN /\ marked' = nextMarked
       /\ cache' = IF allowed /\ (~IdentityFirst \/ ~known) THEN Trim(Refresh(cache, key)) ELSE cache
       /\ last' = [kind |-> "call", ready |-> ready /\ enabled, marked |-> known, recent |-> recent, markedAfter |-> i \in nextMarked,
                    emitted |-> accepts /\ enabled /\ (~WindowGuard \/ ~recent)]

Tick(gap) ==
    /\ cache' = [n \in 1..Len(cache) |->
          [cache[n] EXCEPT !.age = IF @ + gap >= Window THEN Window ELSE @ + gap]]
    /\ last' = NoCall
    /\ UNCHANGED marked

Next == (\E i \in Instances, ready, enabled \in BOOLEAN : Call(i, ready, enabled)) \/ (\E gap \in Gaps : Tick(gap))
Spec == Init /\ [][Next]_vars

TypeOK == /\ marked \subseteq Instances
          /\ cache \in Seq([key : {Fingerprint(Fields[i]) : i \in Instances}, age : 0..Window])
          /\ last \in [kind : {"call", "tick"}, ready : BOOLEAN, marked : BOOLEAN,
                       recent : BOOLEAN, markedAfter : BOOLEAN, emitted : BOOLEAN]
WindowDecision == last.kind = "call" =>
    (last.emitted = (last.ready /\ ~last.marked /\ ~last.recent))
FieldsDistinct == last.kind = "call" => \A a, b \in FieldCases :
    a # b => Fingerprint(a) # Fingerprint(b)
SuppressedMarked == last.kind = "call" /\ last.ready /\ last.recent => last.markedAfter
IdentityDoesNotRefresh == [][(last'.kind = "call" /\ last'.marked) => UNCHANGED cache]_vars
Bounded == Len(cache) <= Limit
\* A blocked call leaves both policy stores unchanged. Time advances are separate actions.
BlockedUnchanged == [][(last'.kind = "call" /\ ~last'.ready) => UNCHANGED <<marked, cache>>]_vars
====
