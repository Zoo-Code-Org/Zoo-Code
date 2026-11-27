---- MODULE AskPresentation ----
\* Models the Run Command button derivation in ChatView (webview-ui/src/components/chat/ChatView.tsx).
\* Source: one full-state snapshot of clineMessages, then the answer events on it (review 6012391736).
\* Sink: the useDeepCompareEffect on lastMessage, the messages-keyed reconcile, and the click handlers.
\* Function covered: ChatView ask and say branches, isPendingCommandAsk, handleSecondaryButtonClick, Task.handleWebviewAskResponse.
\* Failure F1: a snapshot that ends in a say masks an unanswered command ask. No Run button shows.
\* Failure F2: an answered command ask shows the Run button again.
\* Failure F3: an api_req_started after the ask supersedes it. The Run button must not show.
\* Failure F4: a settled ask keeps the Run button after the host stamps it answered (thread 4658203877).
\* Failure F5: a locally answered ask restores the Run button when a say streams (thread 4658203868).
\* Failure F6: the host stamps a partial ask on a text reply. The completed ask then waits with no Run/Deny (thread 4680322903).
\* Invariants: NoMaskedPendingAsk (F1), NoStaleRunButton (F2), ReqSupersedes (F3), NoSettledKeptOrRestored (F4, F5), NoStampOnPartial (F6).
\* Expected: Old fails on ask then command_output. Each guard variant fails on its own shape. NoReconcile fails F4. NoPartialGuard fails F6.
\* CountsLocal fails NoStaleRunButton on [ca, cu] after a local answer.
\* Kinds: ca ask command, cp partial ask command, ou ask command_output, cu say command_output, tx say text, os other say, rq say api_req_started.
\* A message is [kind, answered]. Only ca carries answered true. The host stamps it when the ask is settled.
\* Variables: in the snapshot, shown the Run button state, loc the ask index that the user answered locally.
\* Not modeled: the Proceed/Kill buttons of ou, response routing of a click, terminal rows.
\* Gap: thread 4658203883 (Deny must answer the command, not cancel the stream)
\* and review 6087624965 (text feedback for a recovered ask must route to
\* messageResponse past the streaming queue guard). The sink here is button
\* state, not the posted response. Vitest pins the routing.
\* Cost and result lines were written after the TLC runs. See Result below.

EXTENDS Naturals, Sequences

CONSTANTS Inputs, Variant
\* Inputs: snapshot sequences. Variant: Fixed, Old, NoAnsweredGuard, NoReqGuard, TailOnly, NoReconcile, CountsLocal.

VARIABLES in, shown, loc

Kinds == {"ca", "ou", "cu", "tx", "os", "rq", "cp"}
IsAsk(m) == m.kind \in {"ca", "cp", "ou"}
IsCa(m) == m.kind = "ca"

\* The appendable messages: only ca carries answered true.
MsgSet == {m \in [kind: Kinds, answered: BOOLEAN] : m.kind = "ca" \/ m.answered = FALSE}

\* The scan depth of the say branch. TailOnly reads only the last two messages.
Depth == IF Variant = "TailOnly" THEN 2 ELSE 99
\* The code before this fix reads only the last message.
ScansSay == Variant # "Old"

Last(s) == s[Len(s)]

Max(S) == CHOOSE x \in S : \A y \in S : x >= y

\* The newest ask inside the scan window. 0 when the window holds no ask.
LatestAskInWindow(s) ==
	LET W == {i \in Max({1, Len(s) - Depth + 1})..Len(s) : IsAsk(s[i])}
	IN IF W = {} THEN 0 ELSE Max(W)

\* The newest ask in the whole sequence. 0 when there is none.
LatestAskAt(s) ==
	LET W == {i \in 1..Len(s) : IsAsk(s[i])}
	IN IF W = {} THEN 0 ELSE Max(W)

\* The newest command ask. 0 when there is none.
NewestCa(s) ==
	LET C == {i \in 1..Len(s) : IsCa(s[i])}
	IN IF C = {} THEN 0 ELSE Max(C)

\* The newest command ask that still waits. The host stamps that one.
PendingCaIx(s, l) ==
	LET C == {i \in 1..Len(s) : IsCa(s[i]) /\ s[i].answered = FALSE /\ i # l}
	IN IF C = {} THEN 0 ELSE Max(C)

\* The newest command ask record, complete or partial. 0 when there is none.
NewestAnyCaIx(s, l) ==
	LET C == {i \in 1..Len(s) : s[i].kind \in {"ca", "cp"} /\ s[i].answered = FALSE /\ i # l}
	IN IF C = {} THEN 0 ELSE Max(C)

\* The newest partial command ask. 0 when there is none. The stream completes it.
NewestPartialCaIx(s) ==
	LET C == {i \in 1..Len(s) : s[i].kind = "cp"}
	IN IF C = {} THEN 0 ELSE Max(C)

SupersededByReq(s, i) == \E j \in (i+1)..Len(s) : s[j].kind = "rq"

\* The say-tail scan of the code. Each variant flag leaves out one guard.
\* The locally answered index never counts (thread 4658203868).
ScanPresents(s, l) ==
	LET ix == LatestAskInWindow(s)
	IN /\ ix > 0
	   /\ s[ix].kind = "ca"
	   /\ (\/ s[ix].answered = FALSE \/ Variant = "NoAnsweredGuard")
	   /\ (\/ ix # l \/ Variant = "CountsLocal")
	   /\ (\/ ~SupersededByReq(s, ix) \/ Variant = "NoReqGuard")

\* The Run state that the code derives from the snapshot.
Derives(s, l) ==
	\/ Len(s) > 0 /\ Last(s).kind = "ca" /\ Last(s).answered = FALSE /\ Len(s) # l
	\/ ScansSay /\ Len(s) > 0 /\ Last(s).kind \in {"cu", "tx", "os"} /\ ScanPresents(s, l)

\* The fixed derivation. No variant flag applies to it.
PresentDerives(s, l) ==
	\/ Len(s) > 0 /\ Last(s).kind = "ca" /\ Last(s).answered = FALSE /\ Len(s) # l
	\/ Len(s) > 0 /\ Last(s).kind \in {"cu", "tx", "os"} /\
		LET ix == LatestAskAt(s)
		IN /\ ix > 0
		   /\ s[ix].kind = "ca"
		   /\ s[ix].answered = FALSE
		   /\ ix # l
		   /\ ~SupersededByReq(s, ix)

\* A command ask that the say tail hides. It is the newest ask and no rq follows it.
PendingMasked(s, l) ==
	/\ Len(s) > 0
	/\ Last(s).kind \in {"cu", "tx", "os"}
	/\ \E i \in 1..Len(s) :
		/\ IsAsk(s[i]) /\ s[i].kind = "ca" /\ s[i].answered = FALSE /\ i # l
		/\ \A j \in (i+1)..Len(s) : ~IsAsk(s[j])
		/\ ~SupersededByReq(s, i)

\* The newest command ask is answered by the host or by the user.
Settled(s, l) ==
	LET ix == NewestCa(s)
	IN ix > 0 /\ (s[ix].answered = TRUE \/ ix = l)

TypeOK == /\ in \in Inputs
	/\ shown \in BOOLEAN
	/\ loc \in 0..Len(in)

Init == /\ in \in Inputs
	/\ loc = 0
	/\ shown = Derives(in, 0)

\* The webview re-derives the button state from the messages it holds.
Present == /\ shown' = Derives(in, loc)
	/\ UNCHANGED <<in, loc>>

\* The user answers the pending command ask. The host stamp has not arrived.
LocalRespond == /\ shown
	/\ PendingCaIx(in, loc) > 0
	/\ loc' = PendingCaIx(in, loc)
	/\ shown' = FALSE
	/\ UNCHANGED in

\* The host stamps the newest pending command ask.
\* NoReconcile models the code that keeps the button state (thread 4658203877).
\* NoPartialGuard models the predicate that also matches a partial record (thread 4680322903).
HostStamp ==
	LET ix == IF Variant = "NoPartialGuard" THEN NewestAnyCaIx(in, loc) ELSE PendingCaIx(in, loc)
	IN /\ ix > 0
	   /\ in' = [in EXCEPT ![ix] = [in[ix] EXCEPT !.answered = TRUE]]
	   /\ loc' = loc
	   /\ shown' = IF Variant = "NoReconcile" THEN shown ELSE FALSE

\* The stream completes the newest partial command ask. It keeps the answered
\* flag, so a stamp that landed while partial stays on the completed record.
Complete ==
	/\ NewestPartialCaIx(in) > 0
	/\ in' = [in EXCEPT ![NewestPartialCaIx(in)] =
		[in[NewestPartialCaIx(in)] EXCEPT !.kind = "ca"]]
	/\ loc' = loc
	/\ shown' = Derives(in', loc)

\* A new message arrives: the host appends it to the snapshot and the
\* webview reconciles. The locally answered index survives the append
\* (answeredCommandAskTs), so the reconcile must not re-show the Run button
\* for that ask (thread 4716481098: LocalRespond then a late say, or a
\* visible ask then api_req_started).
ArriveMsg(m) ==
	/\ in' = Append(in, m)
	/\ in' \in Inputs
	/\ loc' = loc
	/\ shown' = Derives(in', loc)

Next == \/ Present
	\/ LocalRespond
	\/ HostStamp
	\/ Complete
	\/ \E m \in MsgSet : ArriveMsg(m)

Spec == Init /\ [][Next]_<<in, shown, loc>>

\* Safety F1: every masked pending command ask shows the Run button.
NoMaskedPendingAsk == PendingMasked(in, loc) => shown

\* Safety F2: the Run button shows only for a live pending command ask.
NoStaleRunButton == shown => PresentDerives(in, loc)

\* Safety F3: an api_req_started tail never shows the Run button.
ReqSupersedes == (Len(in) > 0 /\ Last(in).kind = "rq") => ~shown

\* Safety F4 and F5: a settled ask can neither keep nor restore the Run button.
NoSettledKeptOrRestored == Settled(in, loc) => ~shown

\* Safety F6: the host never stamps a partial command ask (thread 4680322903).
\* A stamp on a partial record survives completion. The completed ask then
\* waits forever with no Run/Deny. Vitest replays the text-reply trace.
NoStampOnPartial == \A i \in 1..Len(in) : in[i].kind = "cp" => in[i].answered = FALSE

\* Result, MaxLen 3: base passes, 794 states. Old fails NoMaskedPendingAsk on [ca, cu].
\* Result: NoAnsweredGuard fails NoStaleRunButton on [ca answered, cu].
\* Result: NoReqGuard fails NoStaleRunButton on [ca, rq, cu]. TailOnly fails NoMaskedPendingAsk on [ca, cu, cu].
\* Result: NoReconcile fails NoSettledKeptOrRestored on [ca, cu] Present then HostStamp (thread 4658203877).
\* Result: NoPartialGuard fails NoStampOnPartial on [cp] HostStamp (thread 4680322903). TypeOK also fails there: no legal input holds a stamped cp.
\* Replay: issue 998 comment 5 rendered [ask command, say command_output] and saw no Run button.
\* Replay: the same shape fails the ChatView unit test before the fix and passes after it.
\* Replay: thread 4658203877 -- a recovered ask stays up after the dwell timeout stamps it. The warm-state Vitest case pins it.
\* Replay: thread 4680322903 -- a text reply between partial creation and completion must not stamp. The Task Vitest case pins it.
\* Findings: the first version found only the issue failure. The event model found the keep-and-restore gap of thread 4658203877.
\* Findings round 8: the Complete event found no new leak in the fixed model. The NoPartialGuard sabotage is not vacuous.
\* Review round 1 (review 6012391736): covered 1, added 3, gap 1.
\* Covered: thread 4658203864 -- the answered guard and the newest-ask scan were in the first version. The fix lands in the test file.
\* Added: threads 4658203868 and 4658203877 and the review body on event order -- Present, LocalRespond, HostStamp, NoSettledKeptOrRestored.
\* Gap: thread 4658203883 -- response routing is not button state. Vitest pins it.
\* Review round 8 (review 6039613196): covered 1, added 1, gap 0.
\* Added: thread 4680322903 -- the host must not stamp a partial ask. New kind cp, the Complete event, the NoStampOnPartial invariant, and the NoPartialGuard variant.
\* Covered: thread 4680322926 -- LocalRespond already records the local answer before Present and HostStamp. NoSettledKeptOrRestored pins the say-after-local-answer shape. The handler that answers is routing, the gap of thread 4658203883. Vitest pins it.
\* Review round (review 6084536709): covered 1, added 2, gap 0.
\* Covered: the say-after-local-answer shape -- NoSettledKeptOrRestored already pins the derivation state on [ca, cu] with a recorded local answer.
\* Added: thread 4716481098 -- the snapshot-arrival transition. ArriveMsg appends a bounded message so LocalRespond then a late say and a visible ask then api_req_started are checked as transitions, not only as Init snapshots.
\* Added: the CountsLocal sabotage -- a scan that counts the locally answered index fails NoStaleRunButton; it pins the local-answer exclusion.

====
