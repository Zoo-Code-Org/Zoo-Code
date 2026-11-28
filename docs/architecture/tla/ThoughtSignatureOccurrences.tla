---- MODULE ThoughtSignatureOccurrences ----
\* Source: assistant turns can reuse one tool-call ID. Sink: collectToolCallReplay and applyThoughtSignatures.
\* Failure: a later occurrence replaces an earlier signature. Invariant: OccurrenceSignaturesPreserved.
\* PR 2643: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4660933927
\* Expect ID-only lookup to fail when the first occurrence is signed and the second is unsigned.
\* ID normalization is an oracle. Each turn has one call; equal IDs denote reuse across turns.
\* Replay: the old code fails 12 of 16 reused-ID cases across both message converters.
\* Fixed lookup consumes each ID occurrence in order. Results use the latest preceding call occurrence.
\* Result: the history model holds (507 states). ReusedId fails after one turn.
\* Review ratchet: added one invariant for this finding. Normalizer behavior remains outside this model.
\* The canary test finding is covered by NoForeignEncodedSignature, not by this occurrence model.
\* Canary thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4660933918
\* An alphanumeric suffix now checks both outgoing IDs. Marker-only code sabotage fails 24 property cases.
\* Review totals for PR 2643: 2 covered, 5 added, 0 gap. Cost and final checks are in ThoughtSignaturePersistence.
\* Simplification expectation: keep occurrences and their cursor in one map entry.
\* The active result mapping is the last consumed occurrence. Do not store a second copy.
\* Invariant: ResultUsesLatestOccurrence. Expect no behavior change; an off-by-one sabotage must fail.
\* Grounding: https://refactoring.com/catalog/replaceDerivedVariableWithQuery.html
\* Grounding: https://react.dev/learn/choosing-the-state-structure (applied here as a design analogy).
\* Simplification result: one map holds each occurrence list and cursor. Result ownership is derived.
\* Fixed models hold (507 history, 51 request, 6 persistence states). All active sabotage variants fail as expected.
\* Next-occurrence code sabotage fails six reused-ID property cases. The restored utility passes all 262 tests.
\* All 1,323 focused tests, types, lint, formatting and both Knip checks pass. Suppression counts stay equal.
\* Null result: no new behavior failure. No speed gain was measured. Cost: about 2 agent minutes.
\* Review ratchet: two spec findings added. The prior checks omitted the second output and unsigned results.
\* Threads: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4661110427
\* https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4661110431
\* Expect a frozen cursor to repeat the first signature. Expect a retained result to hide an unsigned occurrence.
\* Source and sink: replay consumes calls in order and derives each result from the updated per-ID cursor.
\* Review result: the fold checks both outputs, advances each ID cursor, and derives results from the same cursor.
\* The domain includes none, empty sequences and zero consumption. FrozenCursor and UnsignedResult fail as expected.
\* Runtime sabotage: a frozen cursor fails 14 reused-ID property cases. Restore advancement before other checks.
\* This round adds two findings on spec files. Earlier model checks did not cover these failures.
EXTENDS Naturals, Sequences

ReplayByOccurrence == TRUE
AdvanceReplayCursor == TRUE
ResultAtNext == FALSE
RetainUnsignedResult == FALSE
ReplayIds == {"call_1", "call_2"}
ReplayValues == {"none", "a", "b"}
ReplayInputs == UNION {[1..n -> [id : ReplayIds, signature : ReplayValues]] : n \in 0..2}
InitialReplay == [next |-> [id \in ReplayIds |-> 0], calls |-> <<>>, results |-> <<>>]

\* History supplies ordered occurrences. Parsing and normalization stay outside this fold.
Occurrences(history, id) == SelectSeq(history, LAMBDA call : call.id = id)
ResultSignature(values, consumed) ==
    LET position == IF ResultAtNext THEN consumed + 1 ELSE consumed
    IN IF consumed = 0 \/ position > Len(values) THEN "none" ELSE values[position].signature

Consume(history, state, call) ==
    LET values == Occurrences(history, call.id)
        position == IF ReplayByOccurrence THEN state.next[call.id] + 1 ELSE Len(values)
        captured == values[position].signature
        next == IF AdvanceReplayCursor THEN state.next[call.id] + 1 ELSE state.next[call.id]
        current == ResultSignature(values, next)
        result == IF RetainUnsignedResult /\ current = "none" /\ Len(state.results) > 0
                  THEN state.results[Len(state.results)] ELSE current
    IN [next |-> [state.next EXCEPT ![call.id] = next],
        calls |-> Append(state.calls, captured), results |-> Append(state.results, result)]

RECURSIVE ReplayFold(_, _)
ReplayFold(history, count) ==
    IF count = 0 THEN InitialReplay
    ELSE Consume(history, ReplayFold(history, count - 1), history[count])
ExpectedSignatures(history) == [i \in 1..Len(history) |-> history[i].signature]
OccurrenceSignaturesPreserved ==
    \A history \in ReplayInputs : ReplayFold(history, Len(history)).calls = ExpectedSignatures(history)
ResultUsesLatestOccurrence ==
    \A history \in ReplayInputs : ReplayFold(history, Len(history)).results = ExpectedSignatures(history)
\* Before any call is consumed, no result owns a future occurrence, including an unsigned occurrence.
NoResultBeforeConsumption ==
    \A history \in ReplayInputs, id \in ReplayIds : ResultSignature(Occurrences(history, id), 0) = "none"
====
