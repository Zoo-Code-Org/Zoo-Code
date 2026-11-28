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
\* Failure F7 (review 6088358220): the send/deny lookup scans past the newest ask-or-api_req_started row and answers an
\* older cancelled ask while a newer partial ask or api_req_started streams. The host discards the response; the message
\* is lost instead of queued.
\* Failure F8 (review 6094053233): a host stamp on the owned row while a newer command ask is still publishing. Stamping
\* A in [A, B] must keep B's controls; a recency selector or an unreconciled stamp hides them.
\* Invariants: NoMaskedPendingAsk (F1), NoStaleRunButton (F2), ReqSupersedes (F3), NoSettledKeptOrRestored (F4, F5), NoStampOnPartial (F6), NoRoutePastNewestRow (F7), NoHiddenPendingCaTail (F8).
\* Expected: Old fails on ask then command_output. Each guard variant fails on its own shape. NoReconcile fails F2 then F4 (the owned stamp can leave the shown bit on an answered row). NoPartialGuard fails F6. ScanAnywhere fails F7. StampClears fails F8.
\* CountsLocal fails NoStaleRunButton on [ca, cu] after a local answer.
\* Kinds: ca ask command, cp partial ask command, ou ask command_output, cu say command_output, tx say text, os other say, rq say api_req_started.
\* A message is [kind, answered]. Only ca carries answered true. The host stamps it when the ask is settled.
\* Variables: in the snapshot, shown the Run button state, loc the ask index that the user answered locally.
\* Not modeled: the Proceed/Kill buttons of ou, response routing of a click, terminal rows.
\* Gap: thread 4658203883 (Deny must answer the command, not cancel the stream)
\* and review 6087624965 (text feedback for a recovered ask must route to
\* messageResponse past the streaming queue guard) with its follow-up
\* 4719513680 (the same routing past the non-empty-queue drain clause).
\* The sink here is button state, not the posted response. Vitest pins the
\* routing.
\* Cost and result lines were written after the TLC runs. See Result below.

EXTENDS Naturals, Sequences

CONSTANTS Inputs, Variant
\* Inputs: snapshot sequences. Variant: Fixed, Old, NoAnsweredGuard, NoReqGuard, TailOnly, NoReconcile, CountsLocal, ScanAnywhere, StampClears.

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

\* The ask rows whose armed response token the host can stamp. Ownership,
\* not recency: the token names its row, so while a newer ask B is still
\* publishing, the host stamps the older armed ask A and leaves B unanswered
\* (review r9 4724196970). The selector ignores loc: the host reads no
\* webview state, so the local-answer bookkeeping stays out (thread 4682318851).
StampCandidates(s) ==
	{i \in 1..Len(s) : IsCa(s[i]) /\ s[i].answered = FALSE}

\* The sabotage selector also matches a partial record (thread 4680322903).
StampAnyCandidates(s) ==
	{i \in 1..Len(s) : s[i].kind \in {"ca", "cp"} /\ s[i].answered = FALSE}

\* The newest partial command ask. 0 when there is none. The stream completes it.
NewestPartialCaIx(s) ==
	LET C == {i \in 1..Len(s) : s[i].kind = "cp"}
	IN IF C = {} THEN 0 ELSE Max(C)

SupersededByReq(s, i) == \E j \in (i+1)..Len(s) : s[j].kind = "rq"

\* The newest ask or api_req_started row. The presentation scan and the
\* send/deny routing lookup read this row. 0 when there is none.
NewestAskOrReq(s) ==
    LET W == {i \in 1..Len(s) : IsAsk(s[i]) \/ s[i].kind = "rq"}
    IN IF W = {} THEN 0 ELSE Max(W)

\* The newest ask-or-api_req_started row is the pending command ask.
NewestRowCa(s, l) ==
    LET ix == NewestAskOrReq(s)
    IN ix > 0 /\ s[ix].kind = "ca" /\ s[ix].answered = FALSE /\ ix # l

\* The row that the send and deny lookups treat as the pending command ask.
\* The fixed code reads the newest ask-or-api_req_started row. ScanAnywhere
\* models the old lookup: it scans the whole history for the newest pending
\* command ask, so a newer partial ask or api_req_started no longer hides an
\* older cancelled ask (review 6088358220).
RouteMatchCa(s, l) ==
    IF Variant = "ScanAnywhere" THEN PendingCaIx(s, l) > 0 ELSE NewestRowCa(s, l)

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

\* The host stamps the row that owns the armed response token. It reads no
\* local-answer state, so a locally answered ask is stampable too and the
\* LocalRespond-then-HostStamp order is reachable (thread 4682318851).
\* The stamp is the owned-row choice: any unanswered command ask the token
\* can name, independent of recency (review r9 4724196970).
\* NoReconcile models the code that keeps the button state (thread 4658203877).
\* NoPartialGuard models the predicate that also matches a partial record
\* (thread 4680322903). StampClears models a stamp that wipes the derivation
\* instead of reconciling from the updated snapshot: it hides a newer pending
\* ask's controls when the owned row is not the tail (review r9 4724196970).
HostStamp ==
	\E ix \in (IF Variant = "NoPartialGuard" THEN StampAnyCandidates(in) ELSE StampCandidates(in)) :
		/\ in' = [in EXCEPT ![ix] = [in[ix] EXCEPT !.answered = TRUE]]
		/\ loc' = loc
		/\ shown' =
			IF Variant = "NoReconcile" THEN shown
			ELSE IF Variant = "StampClears" THEN FALSE
			ELSE Derives(in', loc)

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

\* Safety F7 (review 6088358220): the send and deny paths route a text reply
\* as a command answer only when the newest ask-or-api_req_started row is the
\* pending command ask. A lookup that scans past the newest row answers an
\* older cancelled ask while a newer partial ask or an api_req_started
\* streams; the host discards the response and the message is lost.
NoRoutePastNewestRow == RouteMatchCa(in, loc) => NewestRowCa(in, loc)

\* Safety F8 (review r9 4724196970): a host stamp on an owned row that is
\* not the tail must preserve the newest pending command ask's controls.
\* With A armed and B publishing, the stamp on A keeps B's Run button; the
\* owned-newest case still clears it because the stamped tail is answered.
NoHiddenPendingCaTail ==
	(Len(in) > 0 /\ Last(in).kind = "ca" /\ Last(in).answered = FALSE /\ Len(in) # loc) => shown

\* Result, MaxLen 3: base passes, 794 states. Old fails NoMaskedPendingAsk on [ca, cu].
\* Result: NoAnsweredGuard fails NoStaleRunButton on [ca answered, cu].
\* Result: NoReqGuard fails NoStaleRunButton on [ca, rq, cu]. TailOnly fails NoMaskedPendingAsk on [ca, cu, cu].
\* Result: NoReconcile fails NoSettledKeptOrRestored on [ca, cu] Present then HostStamp (thread 4658203877).
\* Result: NoPartialGuard fails NoStampOnPartial on [cp] HostStamp (thread 4680322903). TypeOK also fails there: no legal input holds a stamped cp.
\* Result: ScanAnywhere fails NoRoutePastNewestRow on <<ca unanswered, ca answered>> -- an older cancelled ask under a newer settled ask (review 6088358220).
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
\* Review round (review 6088358220): covered 0, added 1, gap 0.
\* Added: the newest-row rule for the send and deny routing lookups --
\* RouteMatchCa, NoRoutePastNewestRow (F7), and the ScanAnywhere sabotage.
\* The r6 recovery case survives: a text say is not api_req_started, so the
\* newest row stays the recovered ask and the route to messageResponse holds.
\* The posted-response payload of the routing stays the gap of thread
\* 4658203883; Vitest pins it.
\* Review round (review 6093228862, thread 4682318851 re-raised): covered 1,
\* added 1, gap 0.
\* Covered: the derivation the messages reconcile implements is
\* PresentDerives; the fixed code now re-derives the command presentation
\* from the whole messages array on every change, so the state rule was
\* already the spec's. The effect-trigger plumbing stays outside the model,
\* as with thread 4658203883.
\* Added: the host stamp selector ignores the webview's local-answer
\* bookkeeping (StampCaIx drops the loc exclusion, the complete-ask filter
\* stays), so the LocalRespond-then-HostStamp order is reachable and
\* checked. Base passes at 1003 states; every sabotage config still fails.
\* Review round 9 (review 6094053233, finding 4724196970): covered 0,
\* added 1, gap 0.
\* Added: the owned-row stamp selector and its reconcile. The old StampCaIx
\* took the newest unanswered ask, so for [A armed, B publishing] the model
\* stamped B and could not check that stamping A keeps B's controls.
\* HostStamp now stamps any row in StampCandidates -- the owned-row choice,
\* independent of recency and loc -- and derives shown from the updated
\* snapshot, matching Task.handleWebviewAskResponse's ownedRowTs match.
\* NoHiddenPendingCaTail (F8) pins the preserve case; the StampClears
\* sabotage (owned stamp that wipes the derivation) fails it on [ca, ca].
\* Review round 10 (review 6094781307, finding 4724761110): covered 1,
\* added 0, gap 0. The ScanAnywhere.cfg expected-failure comment named
\* NoHiddenPendingCaTail beside NoRoutePastNewestRow; the sabotage
\* changes only RouteMatchCa, so F7 is its one reachable failure and the
\* comment now names that alone. The batch-approval readiness finding
\* (4724737729) is test side: the publish-then-arm ordering it asks the
\* test to observe is the OnlyOwnPublishedResponse invariant of
\* AskResponseTargeting.tla, whose Entry and Published phases model that
\* publication and arming order. This module models button state only,
\* so no new invariant here.
\* Review round 11 (review 6095654977, finding 4725383492): covered 1,
\* added 0, gap 0. The round-10 note above said the publish-then-arm
\* phase model was "here"; OnlyOwnPublishedResponse and the Entry and
\* Published phases live in AskResponseTargeting.tla, and the note now
\* points there. The queue-drain clause finding (4719513680, webview
\* send routing past a non-empty queue) is test side like the streaming
\* guard sibling recorded in the Gap block below.

====
