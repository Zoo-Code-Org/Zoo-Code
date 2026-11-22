---- MODULE AskPresentation ----
\* Models the Run Command button derivation in ChatView (webview-ui/src/components/chat/ChatView.tsx).
\* Source: one full-state snapshot of clineMessages, as a webview reload or reconnect sends it.
\* Sink: the useDeepCompareEffect on lastMessage. It sets clineAsk and the approval button keys.
\* Function covered: ChatView useDeepCompareEffect ask and say branches, handleWebviewAskResponse marking.
\* Failure F1: a snapshot that ends in a say masks an unanswered command ask. No Run button shows.
\* Failure F2: an answered command ask shows the Run button again.
\* Failure F3: an api_req_started after the ask supersedes it. The Run button must not show.
\* Invariants: NoMaskedPendingAsk (F1), NoStaleRunButton (F2), ReqSupersedes (F3).
\* Expected: Old fails on ask then command_output. Each guard variant fails on its own shape.
\* Kinds: ca ask command, ou ask command_output, cu say command_output, tx say text, os other say, rq say api_req_started.
\* A message is [kind, answered]. Only ca carries answered true. The host stamps it when the ask is settled.
\* Not modeled: partial asks, the Proceed/Kill buttons of ou, the merge in consolidateCommands, terminal rows.
\* Cost and result lines were written after the TLC runs. See Result below.

EXTENDS Naturals, Sequences

CONSTANTS Inputs, Variant
\* Inputs: snapshot sequences. Variant: Fixed, Old, NoAnsweredGuard, NoReqGuard, TailOnly.

VARIABLE in

Kinds == {"ca", "ou", "cu", "tx", "os", "rq"}
IsAsk(m) == m.kind \in {"ca", "ou"}

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

SupersededByReq(s, i) == \E j \in (i+1)..Len(s) : s[j].kind = "rq"

\* The say-tail scan of the fixed code. Each variant flag leaves out one guard.
ScanPresents(s) ==
	LET ix == LatestAskInWindow(s)
	IN /\ ix > 0
	   /\ s[ix].kind = "ca"
	   /\ (\/ s[ix].answered = FALSE \/ Variant = "NoAnsweredGuard")
	   /\ (\/ ~SupersededByReq(s, ix) \/ Variant = "NoReqGuard")

\* The Run Command button state that the code derives from the snapshot.
Shown(s) ==
	\/ Len(s) > 0 /\ Last(s).kind = "ca" /\ Last(s).answered = FALSE
	\/ ScansSay /\ Len(s) > 0 /\ Last(s).kind \in {"cu", "tx", "os"} /\ ScanPresents(s)

\* A command ask that the say tail hides. It is the newest ask and no rq follows it.
PendingMasked(s) ==
	/\ Len(s) > 0
	/\ Last(s).kind \in {"cu", "tx", "os"}
	/\ \E i \in 1..Len(s) :
		/\ IsAsk(s[i]) /\ s[i].kind = "ca" /\ s[i].answered = FALSE
		/\ \A j \in (i+1)..Len(s) : ~IsAsk(s[j])
		/\ ~SupersededByReq(s, i)

TypeOK == in \in Inputs

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Init gives one state per snapshot. So each invariant names the state, not Inputs.
\* Safety F1: every masked pending command ask shows the Run button.
NoMaskedPendingAsk == PendingMasked(in) => Shown(in)

\* Safety F2: the Run button shows only for a live pending command ask.
NoStaleRunButton ==
	Shown(in) =>
		\/ (Len(in) > 0 /\ Last(in).kind = "ca" /\ Last(in).answered = FALSE)
		\/ PendingMasked(in)

\* Safety F3: an api_req_started tail never shows the Run button.
ReqSupersedes == (Len(in) > 0 /\ Last(in).kind = "rq") => ~Shown(in)

\* Result, MaxLen 3, 400 states: Fixed holds. Old fails NoMaskedPendingAsk on [ca, cu].
\* Result: NoAnsweredGuard fails NoStaleRunButton on [ca answered, cu].
\* Result: NoReqGuard fails NoStaleRunButton on [ca, rq, cu]. TailOnly fails on [ca, cu, cu].
\* Replay: issue 998 comment 5 rendered [ask command, say command_output] and saw no Run button.
\* Replay: the same shape fails the ChatView unit test before the fix and passes after it.
\* Findings: the spec found no failure beyond the one the issue names. Null result for new shapes.
\* Review: counts are 0 covered, 0 added, 0 gap for the first version. Update per review round.

====
