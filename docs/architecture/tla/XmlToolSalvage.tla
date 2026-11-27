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
\* Failure 5: a promoted call whose arguments cannot match the declared
\*            types runs and fails during execution, after the response text
\*            was already cleared (review 4713747404).
\* Invariants: WholeTextOnly, AllOrNothing, NativeFirst, NestedNotPromoted,
\*             InvalidNotPromoted.
\* Expect: Fixed holds. PromoteProse fails WholeTextOnly. PartialPromote fails
\* Expect: AllOrNothing. IgnoreNative fails NativeFirst. NestedPromote fails
\* Expect: NestedNotPromoted. PromoteInvalid fails InvalidNotPromoted.
\* Before this change no salvage existed: a text-only XML response promoted
\* nothing and the turn ended in MODEL_NO_TOOLS_USED.
\* Replay: a text-only response of one read_file block deadlocked the request
\* loop in the pre-fix tree (the wiring test timed out with no tool_use block).
\* Not modeled: entity decoding, tag-name syntax, the production parser's
\* tool-name and argument validation, the salvage cap as a number (modeled as
\* the fixed set of blocks the domain admits), the same-name VALUE argument
\* (skill = name is an ordinary parameter and stays salvageable; nested = FALSE
\* covers it), the string-to-structure conversion of VALID arguments (review
\* 4712438429; modeled here only as the badArgs rejection decision) and the
\* provider disposal in the fixture teardown (review 4712438417), which is
\* test hygiene. The response-text retention sink is the first assistant
\* API-history entry (review 4712438423 and its round-3 additional comment);
\* the model abstracts that sink away, and the retention assertions observe
\* it directly in src/core/task/__tests__/Task.xml-tool-salvage.spec.ts.
\* Property tests: src/core/assistant-message/__tests__/xml-tool-salvage.spec.ts,
\* src/core/task/__tests__/Task.xml-tool-salvage.spec.ts.
\* Result: Fixed holds in 48 states. PromoteProse fails WholeTextOnly.
\* PartialPromote fails AllOrNothing on a two-block response. IgnoreNative fails
\* NativeFirst. NestedPromote fails NestedNotPromoted. PromoteInvalid fails
\* InvalidNotPromoted. TLC found no other violating state.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 1 added (round 2026-11-26 minor + review 4712438440 same-name nested
\* regression), 3 gaps recorded above. (Round 2.) Round 3: 1 added (4713747404),
\* 1 gap (the API-history retention sink, recorded above).

CONSTANT Variant                  \* "Fixed", "PromoteProse", "PartialPromote",
                                  \* "IgnoreNative", "NestedPromote"
                                  \* or "PromoteInvalid"

VARIABLE in

\* A response is the number of well-formed tool blocks it contains, whether
\* prose (non-XML text) surrounds them, whether a native tool call exists,
\* whether a block carries a same-name child that is itself a tool block,
\* and whether a block's salvaged arguments cannot match the declared types
\* (a conversion failure or a shape conflict).
Inputs == [blocks : {0, 1, 2}, prose : BOOLEAN, native : BOOLEAN,
           nested : BOOLEAN, badArgs : BOOLEAN]

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
    [] Variant = "PromoteInvalid" ->
        IF ~i.prose /\ ~i.native /\ ~i.nested /\ i.blocks > 0 THEN i.blocks ELSE 0
    [] OTHER ->
        IF ~i.prose /\ ~i.native /\ ~i.nested /\ ~i.badArgs
        /\ i.blocks > 0 THEN i.blocks ELSE 0

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

\* Safety: arguments that cannot match their declared types fail only during
\* execution, after the response text is gone. Such a response stays text.
InvalidNotPromoted == in.badArgs => PromotedCount(in) = 0

====
