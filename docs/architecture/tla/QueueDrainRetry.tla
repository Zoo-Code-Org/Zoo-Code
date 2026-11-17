---- MODULE QueueDrainRetry ----
\* Models processQueuedMessages and the stateChanged handler in src/core/task/Task.ts.
\* Source: a drain call finds every queued message held by an edit. Sink: commitEdit or a removal ends a hold.
\* Rule: a drain call can send only a message that was in the queue when the call ran. One call sends one message.
\* Failure 1: a blocked drain is lost, and a queued message waits with no drain owed to it.
\* Failure 2: a retry sends a message that arrived after every drain call.
\* Invariant NoStranded: a blocked call has a held message to wait for, or no queued message of its own.
\* Invariant NoEarlySend: each sent message was in the queue at some call, and sends do not exceed calls.
\* Modes: None (no retry), Flag (one retry), Count (one retry per blocked call), Snap (each call keeps its messages).
\* Expected before the run: None and Flag fail NoStranded. Count fails NoEarlySend. Snap holds.
\* Result: QueueDrainRetry.cfg (Snap) holds. The None, Flag and Count configs fail (see check.sh).
\* Review: PR 2421, CodeRabbit thread 1. Round 3 (lost drain) and round 4 (merged drains) were gaps in QueueEditRace.
\* Round 5 (a surplus retry takes a later message) is the Count failure. All three are one class: a retry count with no owner.
\* Not modeled: the message text, the image scan, the claim by the ask loop and an edit of a late message.
\* Cost: each run takes under 5 seconds. Agent time is not measured.
\* Why a second module: the variables differ from QueueEditRace, and joining them multiplies the states.

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Mode, MaxMsgs, MaxCalls, MaxLate

\* st: the state of each message. bl: the snapshots that the Snap mode keeps. blocked: the count of the other modes.
\* bg: the same snapshots as ghost data. A snapshot is the set of held messages when a call was blocked.
\* U: the messages that were in the queue at some call.
Ids == 1..(MaxMsgs + MaxLate)
VARIABLES st, bl, blocked, bg, U, calls
vars == <<st, bl, blocked, bg, U, calls>>

Held(s) == {i \in Ids : s[i] = "h"}
Queued(s) == {i \in Ids : s[i] = "q"}
First(s) == CHOOSE i \in Queued(s) : \A j \in Queued(s) : i <= j
SendFirst(s) == [s EXCEPT ![First(s)] = "sent"]

\* Apply SendFirst n times, or until the queue is empty.
RECURSIVE SendN(_, _)
SendN(s, n) == IF n = 0 \/ Queued(s) = {} THEN s ELSE SendN(SendFirst(s), n - 1)

\* The Snap handler visits each snapshot in order. It drops a snapshot with no live message.
\* It sends once if a live message of the snapshot is queued. Otherwise it keeps the snapshot.
RECURSIVE Proc(_, _, _)
Proc(s, rest, kept) ==
    IF rest = <<>> THEN <<s, kept>>
    ELSE LET S == Head(rest)
             live == {i \in S : s[i] \in {"q", "h"}}
         IN IF live = {} THEN Proc(s, Tail(rest), kept)
            ELSE IF \E i \in live : s[i] = "q" THEN Proc(SendFirst(s), Tail(rest), kept)
            ELSE Proc(s, Tail(rest), Append(kept, S))

\* The ghost snapshot ends when one of its messages is sent, or when all of them are gone.
Live(S, s) == ~(\E i \in S : s[i] = "sent") /\ (\E i \in S : s[i] \in {"q", "h"})
Prune(g, s) == SelectSeq(g, LAMBDA S : Live(S, s))

\* The handler runs after each change of the queue state. s is the state before the retry.
Settle(s) ==
    CASE Mode = "None" -> [st |-> s, bl |-> bl, blocked |-> blocked]
      [] Mode = "Snap" -> LET r == Proc(s, bl, <<>>) IN [st |-> r[1], bl |-> r[2], blocked |-> blocked]
      [] OTHER -> IF blocked > 0 /\ Held(s) = {}
                  THEN [st |-> SendN(s, IF Mode = "Flag" THEN 1 ELSE blocked), bl |-> bl, blocked |-> 0]
                  ELSE [st |-> s, bl |-> bl, blocked |-> blocked]

Init == st = [i \in Ids |-> IF i <= MaxMsgs THEN "q" ELSE "new"]
        /\ bl = <<>> /\ blocked = 0 /\ bg = <<>> /\ U = {} /\ calls = 0

Late(i) == /\ st[i] = "new" /\ (i = 1 \/ st[i-1] # "new")
           /\ st' = [st EXCEPT ![i] = "q"]
           /\ UNCHANGED <<bl, blocked, bg, U, calls>>

Begin(i) == /\ st[i] = "q"
            /\ st' = [st EXCEPT ![i] = "h"]
            /\ UNCHANGED <<bl, blocked, bg, U, calls>>

\* An edit ends. The message returns to the queue (Commit) or leaves it (Remove). Then the handler runs.
End(i, to) ==
    LET r == Settle([st EXCEPT ![i] = to])
    IN /\ st[i] = "h"
       /\ st' = r.st /\ bl' = r.bl /\ blocked' = r.blocked
       /\ bg' = Prune(bg, r.st)
       /\ UNCHANGED <<U, calls>>

\* A drain call sends the first queued message. If every message is held, the call is blocked.
Call == /\ calls < MaxCalls
        /\ calls' = calls + 1
        /\ U' = U \cup {i \in Ids : st[i] \in {"q", "h"}}
        /\ IF Queued(st) # {}
           THEN /\ st' = SendFirst(st) /\ bg' = Prune(bg, SendFirst(st)) /\ UNCHANGED <<bl, blocked>>
           ELSE /\ st' = st
                /\ IF Held(st) = {} THEN UNCHANGED <<bl, blocked, bg>>
                   ELSE /\ bg' = Append(bg, Held(st))
                        /\ bl' = IF Mode = "Snap" THEN Append(bl, Held(st)) ELSE bl
                        /\ blocked' = CASE Mode = "Flag" -> 1
                                        [] Mode = "Count" -> blocked + 1
                                        [] OTHER -> blocked

Next == \/ \E i \in Ids : Late(i) \/ Begin(i) \/ End(i, "q") \/ End(i, "gone")
        \/ Call

Spec == Init /\ [][Next]_vars

TypeOK == /\ st \in [Ids -> {"new", "q", "h", "sent", "gone"}] /\ Len(bl) <= MaxCalls /\ Len(bg) <= MaxCalls
          /\ blocked \in 0..MaxCalls /\ calls \in 0..MaxCalls /\ U \subseteq Ids

NoStranded == \A k \in 1..Len(bg) : (\E i \in bg[k] : st[i] = "h") \/ ~(\E i \in bg[k] : st[i] = "q")
NoEarlySend == LET sent == {i \in Ids : st[i] = "sent"} IN sent \subseteq U /\ Cardinality(sent) <= calls

====
