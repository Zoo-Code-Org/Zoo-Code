---- MODULE StreamStopRetry ----
\* Models the stop-reason path for a provider stream in src/core/task/Task.ts.
\* Source: OpenRouterHandler.createMessage sees a filter or refusal finish reason
\* and the stream ends with a stop error (src/api/providers/openrouter.ts,
\* matchChatCompletionsStreamStop). Sink: the request row usage and the next
\* request after a confirmed retry (recursivelyMakeClineRequests catch, and the
\* attemptApiRequest first-chunk catch when the stop lands before the first
\* chunk).
\* Failure 1: Zoo Code resends a stopped request with no user consent.
\* Failure 2: the stopped response's usage is lost, so the request row shows
\* 0 tokens. The stream loop reads the next chunk before it processes the
\* current one, so a usage chunk yielded before the throw is never counted.
\* The fixed handler puts the usage on the error and the catch records it.
\* Failure 3: a confirmed retry adds a second user turn to the history. The
\* fixed retry pushes retryAttempt above 0, so the saved turn is reused.
\* Invariants: NoResendWithoutConsent, NoLostUsage, NoSecondUserTurn.
\* Modes: fixed (the new stop path), unfixed (the old generic path that resends
\* with no ask and drops the usage), second_turn (a consented retry that copies
\* the retryAttempt 0 mistake and adds a user turn).
\* Expected before the run: unfixed fails NoResendWithoutConsent and
\* NoLostUsage. second_turn fails NoSecondUserTurn. fixed holds.
\* Result: StreamStopRetry.cfg (fixed) holds in 44 distinct states. Unfixed
\* fails NoResendWithoutConsent and NoLostUsage. SecondTurn fails
\* NoSecondUserTurn. See the check.sh output in the fix PR.
\* Code check (step 10): core/task/__tests__/stream-stop-retry.spec.ts runs the
\* same three invariant sentences on the real task loop with stubbed streams.
\* Cost: each run is under 5 seconds. Agent time is not measured.
\* Not modeled: the ask timeout, the provider request text, a tool call in the
\* stopped response, and a retry whose own request also stops beyond MaxStops.

EXTENDS Naturals

CONSTANTS Mode, MaxStops

VARIABLES auto, deltas, usage, phase, stops, consumed, usageRecorded, resends, approved, userTurns

vars == <<auto, deltas, usage, phase, stops, consumed, usageRecorded, resends, approved, userTurns>>

Asks == {"fixed", "second_turn"}

TypeOK ==
    /\ auto \in BOOLEAN
    /\ deltas \in BOOLEAN
    /\ usage \in BOOLEAN
    /\ phase \in {"run", "asked", "ended"}
    /\ stops \in Nat
    /\ consumed \subseteq {"delta", "usage"}
    /\ usageRecorded \in BOOLEAN
    /\ resends \in Nat
    /\ approved \in Nat
    /\ userTurns \in Nat

Init ==
    /\ auto \in BOOLEAN
    /\ deltas \in BOOLEAN
    /\ usage \in BOOLEAN
    /\ phase = "run"
    /\ stops = 0
    /\ consumed = {}
    /\ usageRecorded = FALSE
    /\ resends = 0
    /\ approved = 0
    /\ userTurns = 1

\* The stream loop consumed the deltas it read. The usage chunk stays
\* unconsumed: the loop reads the next chunk before it processes the current
\* one, and the stop throw lands on that read.
LoopConsumed(early) ==
    IF early THEN {} ELSE IF deltas THEN {"delta"} ELSE {}

\* The provider stops the stream. early tells a stop before the first chunk.
\* fixed and second_turn ask the user. unfixed resends at once: the generic
\* mid-stream path resends with no question, and a stop before the first chunk
\* auto-retries under auto-approval. Only the fixed catch records the usage
\* that rides on the error.
Stop(early) ==
    /\ phase = "run"
    /\ stops < MaxStops
    /\ stops' = stops + 1
    /\ consumed' = LoopConsumed(early)
    /\ usageRecorded' = (Mode # "unfixed") /\ usage
    /\ IF Mode \in Asks
        THEN
            /\ phase' = "asked"
            /\ UNCHANGED <<resends, approved>>
        ELSE
            /\ phase' = "run"
            /\ resends' = resends + 1
            /\ UNCHANGED approved
    /\ UNCHANGED <<auto, deltas, usage, userTurns>>

\* The user answers the consent ask. Approve resends the same request. The
\* second_turn mode copies the retryAttempt 0 mistake and adds a user turn; the
\* fixed retry reuses the saved turn.
Decide(c) ==
    /\ phase = "asked"
    /\ c \in {"approve", "deny"}
    /\ IF c = "approve"
        THEN
            /\ phase' = "run"
            /\ resends' = resends + 1
            /\ approved' = approved + 1
            /\ userTurns' = IF Mode = "second_turn" THEN userTurns + 1 ELSE userTurns
        ELSE
            /\ phase' = "ended"
            /\ UNCHANGED <<resends, approved, userTurns>>
    /\ UNCHANGED <<auto, deltas, usage, stops, consumed, usageRecorded>>

Next ==
    \/ \E early \in BOOLEAN : Stop(early)
    \/ \E c \in {"approve", "deny"} : Decide(c)

Spec == Init /\ [][Next]_vars

\* Safety Rule 1: every resend follows a user approve.
NoResendWithoutConsent == resends <= approved

\* Safety Rule 2: a stop that carried usage keeps it in the request row.
NoLostUsage == (stops > 0 /\ usage) => usageRecorded

\* Safety Rule 3: a confirmed retry never adds a second user turn.
NoSecondUserTurn == userTurns <= 1

====
