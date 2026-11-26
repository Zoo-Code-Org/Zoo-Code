---- MODULE XmlToolSalvage ----
EXTENDS Naturals
\* Models salvageXmlToolCalls (src/core/assistant-message/xml-tool-salvage.ts)
\* and its Task wiring at the end of a stream (src/core/task/Task.ts).
\* Source: the completed response text with no native tool call. Sink: the
\* tool_use blocks promoted into assistantMessageContent.
\* Failure 1: prose-wrapped XML is promoted and the model's prose is hijacked.
\* Failure 2: only part of the text is promoted and later blocks are lost.
\* Failure 3: salvage fires although a native tool call exists and tools run twice.
\* Failure 4: a block with a same-name child that is itself a tool block is
\*            promoted as one call and the nested request is silently dropped
\*            (review round 2026-11-26, minor at xml-tool-salvage.ts:148).
\* Invariants: WholeTextOnly, AllOrNothing, NativeFirst, NestedNotPromoted.
\* Expect: Fixed holds. PromoteProse fails WholeTextOnly. PartialPromote fails
\* Expect: AllOrNothing. IgnoreNative fails NativeFirst. NestedPromote fails
\* Expect: NestedNotPromoted.
\* Before this change no salvage existed: a text-only XML response promoted
\* nothing and the turn ended in MODEL_NO_TOOLS_USED.
\* Replay: a text-only response of one read_file block deadlocked the request
\* loop in the pre-fix tree (the wiring test timed out with no tool_use block).
\* Not modeled: entity decoding, tag-name syntax, the production parser's
\* tool-name and argument validation, the salvage cap as a number (modeled as
\* the fixed set of blocks the domain admits), the same-name VALUE argument
\* (skill = name is an ordinary parameter and stays salvageable; nested = FALSE
\* covers it), the argument-shape conversion at promotion (review 4712438429)
\* and the response-text retention assertions (review 4712438423), both pinned
\* by src/core/task/__tests__/Task.xml-tool-salvage.spec.ts, and the provider
\* disposal in the fixture teardown (review 4712438417), which is test hygiene.
\* Property tests: src/core/assistant-message/__tests__/xml-tool-salvage.spec.ts,
\* src/core/task/__tests__/Task.xml-tool-salvage.spec.ts.
\* Result: Fixed holds in 24 states. PromoteProse fails WholeTextOnly.
\* PartialPromote fails AllOrNothing on a two-block response. IgnoreNative fails
\* NativeFirst. NestedPromote fails NestedNotPromoted. TLC found no other
\* violating state.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 1 added (round 2026-11-26 minor + review 4712438440 same-name nested
\* regression), 3 gaps recorded above. (Round 2.)

CONSTANT Variant                  \* "Fixed", "PromoteProse", "PartialPromote",
                                  \* "IgnoreNative" or "NestedPromote"

VARIABLE in

\* A response is the number of well-formed tool blocks it contains, whether
\* prose (non-XML text) surrounds them, whether a native tool call exists,
\* and whether a block carries a same-name child that is itself a tool block.
Inputs == [blocks : {0, 1, 2}, prose : BOOLEAN, native : BOOLEAN, nested : BOOLEAN]

\* How many blocks the wiring promotes for this response.
PromotedCount(i) ==
    CASE Variant = "PromoteProse" ->
        IF ~i.native /\ i.blocks > 0 THEN i.blocks ELSE 0
    [] Variant = "PartialPromote" ->
        IF ~i.prose /\ ~i.native /\ i.blocks > 1 THEN i.blocks - 1
        ELSE IF ~i.prose /\ ~i.native /\ i.blocks = 1 THEN 1
        ELSE 0
    [] Variant = "IgnoreNative" ->
        IF ~i.prose /\ i.blocks > 0 THEN i.blocks ELSE 0
    [] Variant = "NestedPromote" ->
        IF ~i.prose /\ ~i.native /\ i.blocks > 0 THEN i.blocks ELSE 0
    [] OTHER ->
        IF ~i.prose /\ ~i.native /\ ~i.nested /\ i.blocks > 0 THEN i.blocks ELSE 0

TypeOK == PromotedCount(in) \in {0, 1, 2} /\ PromotedCount(in) <= in.blocks

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Safety: promotion happens only when the whole text is tool blocks.
WholeTextOnly == PromotedCount(in) > 0 => ~in.prose

\* Safety: promotion is all or nothing; no block is silently dropped.
AllOrNothing == PromotedCount(in) \in {0, in.blocks}

\* Safety: a native tool call wins; salvage never adds a second channel.
NativeFirst == in.native => PromotedCount(in) = 0

\* Safety: a same-name nested tool block is not a two-level parameter; the
\* text stays unsalvaged instead of promoting one call that drops the request.
NestedNotPromoted == in.nested => PromotedCount(in) = 0

====
