---- MODULE ThoughtSignatureStream ----
\* Source: OpenAiHandler and LiteLLMHandler consume tool-call chunks in createMessage.
\* Sink: getThoughtSignature returns the value that enters assistant history.
\* Failure: an early ID fallback hides a later explicit field. Invariant: StreamSignaturePriority.
\* Expect the old first-value rule to fail for an encoded chunk followed by an explicit chunk.
\* Candidate values are oracles. ID parsing and transport chunk boundaries are outside this model.
\* Cost and results are recorded in ThoughtSignature.tla.
\* API simplification expectation: update changes reader state; signature reads it without mutation.
\* Keep source priority, request ownership and ID isolation unchanged. Expect no new model failure.
\* The property tests now observe signature after each update. Keep every sabotage configuration.
\* Result: both models pass (507 history states, 51 request states); all active sabotage variants fail as expected.
\* All 1,074 tests, types, lint, formatting and both Knip checks pass. Suppression counts stay equal.
\* Null result: no new failure or state change. Cost: about 1 agent minute.
EXTENDS Naturals, Sequences

StreamNone == [source |-> "none", value |-> ""]
StreamCandidates == {StreamNone} \cup [source : {"encoded", "explicit"}, value : {"a", "b"}]

\* Keep the first explicit field. A later explicit field can replace an ID fallback.
CaptureStream(previous, chunk) ==
    IF previous.source = "explicit" THEN previous
    ELSE IF chunk.source = "explicit" \/ previous = StreamNone THEN chunk ELSE previous

RECURSIVE StreamCaptured(_)
StreamCaptured(chunks) ==
    IF Len(chunks) = 0 THEN StreamNone
    ELSE CaptureStream(StreamCaptured(SubSeq(chunks, 1, Len(chunks) - 1)), chunks[Len(chunks)])

\* The contract chooses the first explicit field, or the first ID fallback if no field exists.
StreamExpected(chunks) ==
    LET explicit == SelectSeq(chunks, LAMBDA c : c.source = "explicit")
        encoded == SelectSeq(chunks, LAMBDA c : c.source = "encoded")
    IN IF Len(explicit) > 0 THEN Head(explicit)
       ELSE IF Len(encoded) > 0 THEN Head(encoded) ELSE StreamNone

StreamSignaturePriority ==
    \A chunks \in UNION {[1..n -> StreamCandidates] : n \in 0..3} :
        StreamCaptured(chunks) = StreamExpected(chunks)
====
