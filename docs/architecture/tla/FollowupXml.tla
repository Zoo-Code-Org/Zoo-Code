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
\* Failure: a closing tag inside a JSON string of the payload truncates the
\* payload, so a recoverable tool call is rejected. Review thread 4658157957.
\* Invariants: NoMissingFollowUpWhenRecoverable and NoXmlInShownQuestion.
\* The JSON parser is an oracle (`parses`). Only the follow_up field and the
\* question text are modeled. The question field is always present.
\* Input rule (review thread 4658157957): `tin` = TRUE means the payload holds
\* a closing tag inside a JSON string. `parses` is about the full payload.
\* Expect: Fixed holds in every state. NoRecover fails
\* NoMissingFollowUpWhenRecoverable with XML in the question, no follow_up
\* field, and a parseable JSON payload. NoStrip fails NoXmlInShownQuestion.
\* Expect: NaiveBoundary (the boundary stops at the first closing tag) fails
\* NoMissingFollowUpWhenRecoverable with tin = TRUE: the payload truncates
\* inside a JSON string and the tool call is rejected.
\* Result: Fixed holds in 24 states. NoRecover fails with
\* [fu |-> "absent", q |-> "xml", tin |-> FALSE] and parses = TRUE.
\* NoStrip fails the same way. NaiveBoundary fails with
\* [fu |-> "absent", q |-> "xml", tin |-> TRUE] and parses = TRUE.
\* Replay: the NoRecover state is the payload from issue 1034. The unit test
\* on the unfixed parser shows it: the tool call is rejected as invalid.
\* Replay: the NaiveBoundary state is the quoted-tag payload from review
\* thread 4658157957. The round-1 unit tests show it on the unfixed parser.
\* Not modeled: the question field missing, the streaming partial path, the
\* apply_diff path named in the issue comments, and the tag search order.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 0 added, 0 gap at first version. Round 1 (PR 2651,
\* thread 4658157957): 1 added, 0 covered, 0 gap. The added input rule `tin`
\* and the NaiveBoundary sabotage mode express the quoted-tag failure. The
\* invariant already covered the abstract state; the model could not
\* reproduce the quoted-tag divergence before the input rule was added.

CONSTANT Variant                  \* "Fixed", "NoRecover", "NoStrip", "NaiveBoundary"

VARIABLE in, parses

\* "absent" = no follow_up field. "null" = an explicit null.
\* "array" = a valid array. "plain" = question text without XML markup.
\* "xml" = question text with a <follow_up> block (issue 1034 form).
\* tin = TRUE: the payload holds a closing tag inside a JSON string.
Inputs == [fu : {"absent", "null", "array"}, q : {"plain", "xml"}, tin : BOOLEAN]

\* Oracle: the full text inside the XML tags parses to a JSON array.
XmlGood == in.q = "xml" /\ parses

\* Fixed and NoStrip read the boundary outside JSON strings. NaiveBoundary
\* stops at the first closing tag, so a quoted tag ends the recovery.
Recover == Variant \in {"Fixed", "NoStrip"} \/ (Variant = "NaiveBoundary" /\ in.tin = FALSE)

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
