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
EXTENDS Naturals, Sequences

ReplayByOccurrence == TRUE
ReplayedFirst(firstId, secondId, firstSignature, secondSignature) ==
    IF ~ReplayByOccurrence /\ firstId = secondId THEN secondSignature ELSE firstSignature
OccurrenceSignaturesPreserved ==
    \A firstId, secondId \in {"call_1", "call_2"}, firstSignature, secondSignature \in {"none", "a", "b"} :
        ReplayedFirst(firstId, secondId, firstSignature, secondSignature) = firstSignature
\* The runtime cursor is the consumed count. Before the first call there is no active result mapping.
ResultAtNext == FALSE
ResultSignature(values, consumed) ==
    LET position == IF ResultAtNext THEN consumed + 1 ELSE consumed
    IN IF consumed = 0 \/ position > Len(values) THEN "none" ELSE values[position]
ResultUsesLatestOccurrence ==
    \A values \in UNION {[1..n -> {"a", "b"}] : n \in 0..2} :
        \A consumed \in 0..Len(values) :
            ResultSignature(values, consumed) = (IF consumed = 0 THEN "none" ELSE values[consumed])
====
