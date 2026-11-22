---- MODULE FollowupXml ----
\* Models the ask_followup_question case of NativeToolCallParser.parseCoreToolCall
\* (src/core/assistant-message/NativeToolCallParser.ts) and the params check in
\* AskFollowupQuestionTool.execute (src/core/tools/AskFollowupQuestionTool.ts).
\* Source: the tool-call arguments the model sends. Sink: the follow_up value and
\* the question text that the tool receives.
\* Failure: the model puts the follow_up data in legacy XML markup inside the
\* question text and sends no follow_up field. The tool then reports a missing
\* follow_up parameter and the task retries in a loop. Issue 1034.
\* Failure: after recovery, the question text shown to the user keeps XML markup.
\* Invariants: NoMissingFollowUpWhenRecoverable and NoXmlInShownQuestion.
\* The JSON parser is an oracle (`parses`). Only the follow_up field and the
\* question text are modeled. The question field is always present.
\* Expect: Fixed holds. NoRecover fails NoMissingFollowUpWhenRecoverable with
\* XML in the question, no follow_up field, and a parseable JSON payload.
\* Expect: NoStrip fails NoXmlInShownQuestion in the same recovered state.
\* Result: Fixed holds in 12 states. NoRecover fails with
\* [fu |-> "absent", q |-> "xml"] and parses = TRUE. NoStrip fails the same way.
\* Replay: the NoRecover state is the payload from issue 1034. The unit test
\* on the unfixed parser shows it: the tool call is rejected as invalid.
\* Not modeled: the question field missing, the streaming partial path, and
\* the apply_diff path named in the issue comments. The XML tag search itself.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 0 added, 0 gap at first version. Findings so far: none
\* beyond the reported failure.

CONSTANT Variant                  \* "Fixed", "NoRecover" or "NoStrip"

VARIABLE in, parses

\* "absent" = no follow_up field. "null" = an explicit null.
\* "array" = a valid array. "plain" = question text without XML markup.
\* "xml" = question text with a <follow_up> block (issue 1034 form).
Inputs == [fu : {"absent", "null", "array"}, q : {"plain", "xml"}]

\* Oracle: the text inside the XML tags parses to a JSON array.
XmlGood == in.q = "xml" /\ parses

Recover == Variant \in {"Fixed", "NoStrip"}

\* The parser recovers only when the field is missing and the payload parses.
Recovered == Recover /\ XmlGood /\ in.fu \in {"absent", "null"}

\* The follow_up value that the tool receives.
ToolFuPresent == in.fu = "array" \/ Recovered

\* The question text that the tool shows. Only Fixed strips the XML.
ShownPlain == Variant = "Fixed" /\ Recovered

TypeOK == in \in Inputs /\ parses \in BOOLEAN

Init == in \in Inputs /\ parses \in BOOLEAN
Next == UNCHANGED <<in, parses>>
Spec == Init /\ [][Next]_<<in, parses>>

\* Safety: a recoverable payload never reaches the tool without follow_up.
NoMissingFollowUpWhenRecoverable ==
    (XmlGood /\ in.fu \in {"absent", "null"}) => ToolFuPresent

\* Safety: a recovered question never shows XML markup to the user.
NoXmlInShownQuestion == Recovered => ShownPlain

====
