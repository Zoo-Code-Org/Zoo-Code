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
\* Invariants: NoMaskedPendingAsk (F1), NoStaleRunButton (F2), ReqSupersedes (F3), NoSettledKeptOrRestored (F4, F5).
\* Expected: Old fails on ask then command_output. Each guard variant fails on its own shape. NoReconcile fails F4.
\* Kinds: ca ask command, ou ask command_output, cu say command_output, tx say text, os other say, rq say api_req_started.
\* A message is [kind, answered]. Only ca carries answered true. The host stamps it when the ask is settled.
\* Variables: in the snapshot, shown the Run button state, loc the ask index that the user answered locally.
\* Not modeled: partial asks, the Proceed/Kill buttons of ou, response routing of a click, terminal rows.
\* Gap: thread 4658203883 (Deny must answer the command, not cancel the stream). The sink here is button state, not the posted response. Vitest pins the routing.
\* Cost and result lines were written after the TLC runs. See Result below.

EXTENDS Naturals, Sequences

CONSTANTS Inputs, Variant
\* Inputs: snapshot sequences. Variant: Fixed, Old, NoAnsweredGuard, NoReqGuard, TailOnly, NoReconcile.

VARIABLES in, shown, loc

Kinds == {"ca", "ou", "cu", "tx", "os", "rq"}
IsAsk(m) == m.kind \in {"ca", "ou"}
IsCa(m) == m.kind = "ca"

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

SupersededByReq(s, i) == \E j \in (i+1)..Len(s) : s[j].kind = "rq"

\* The say-tail scan of the code. Each variant flag leaves out one guard.
\* The locally answered index never counts (thread 4658203868).
ScanPresents(s, l) ==
	LET ix == LatestAskInWindow(s)
	IN /\ ix > 0
	   /\ s[ix].kind = "ca"
	   /\ (\/ s[ix].answered = FALSE \/ Variant = "NoAnsweredGuard")
	   /\ ix # l
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

\* The host stamps the newest pending command ask answered.
\* NoReconcile models the code that keeps the button state (thread 4658203877).
HostStamp == /\ PendingCaIx(in, loc) > 0
	/\ in' = [in EXCEPT ![PendingCaIx(in, loc)] =
		[in[PendingCaIx(in, loc)] EXCEPT !.answered = TRUE]]
	/\ loc' = loc
	/\ shown' = IF Variant = "NoReconcile" THEN shown ELSE FALSE

Next == \/ Present
	\/ LocalRespond
	\/ HostStamp

Spec == Init /\ [][Next]_<<in, shown, loc>>

\* Safety F1: every masked pending command ask shows the Run button.
NoMaskedPendingAsk == PendingMasked(in, loc) => shown

\* Safety F2: the Run button shows only for a live pending command ask.
NoStaleRunButton == shown => PresentDerives(in, loc)

\* Safety F3: an api_req_started tail never shows the Run button.
ReqSupersedes == (Len(in) > 0 /\ Last(in).kind = "rq") => ~shown

\* Safety F4 and F5: a settled ask can neither keep nor restore the Run button.
NoSettledKeptOrRestored == Settled(in, loc) => ~shown

\* Result, MaxLen 3: base passes, 490 states. Old fails NoMaskedPendingAsk on [ca, cu].
\* Result: NoAnsweredGuard fails NoStaleRunButton on [ca answered, cu].
\* Result: NoReqGuard fails NoStaleRunButton on [ca, rq, cu]. TailOnly fails NoMaskedPendingAsk on [ca, cu, cu].
\* Result: NoReconcile fails NoSettledKeptOrRestored on [ca, cu] Present then HostStamp (thread 4658203877).
\* Replay: issue 998 comment 5 rendered [ask command, say command_output] and saw no Run button.
\* Replay: the same shape fails the ChatView unit test before the fix and passes after it.
\* Replay: thread 4658203877 -- a recovered ask stays up after the dwell timeout stamps it. The warm-state Vitest case pins it.
\* Findings: the first version found only the issue failure. The event model found the keep-and-restore gap of thread 4658203877.
\* Review round 1 (review 6012391736): covered 1, added 3, gap 1.
\* Covered: thread 4658203864 -- the answered guard and the newest-ask scan were in the first version. The fix lands in the test file.
\* Added: threads 4658203868 and 4658203877 and the review body on event order -- Present, LocalRespond, HostStamp, NoSettledKeptOrRestored.
\* Gap: thread 4658203883 -- response routing is not button state. Vitest pins it.

====
