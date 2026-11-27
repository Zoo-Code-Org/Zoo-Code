---- MODULE ToolResultRetry ----
\* Source: Task.recursivelyMakeClineRequests retains the saved user turn on retry.
\* Sink: saveApiMessages and mergeApiMessageSnapshots merge records by identity.
\* Failure: retry duplicates or loses a result, or removes a saved summary.
\* Invariants: OneResultPerCall prevents duplicates. ResultNeverLost retains disk
\* results. ResultInMemory retains memory results. SummarySurvives keeps summaries.
\* Expected: Retain passes. Legacy pop and loss sabotage violate retention.
\* Config modes: base=Retain, Current=Fresh (pre-fix), Popped=Stable,
\* Summary=Stable with PopSummary; LosePending/LoseRetry/LoseDecline use named modes.
\* Results: base passes 44 states; Current fails 9; Popped fails 6; Summary fails 7.
\* LosePending, LoseRetry, and LoseDecline fail with 6, 13, and 14 states.
\* Code checks: retry counts 1 to 3, decline responses, and cancellation retain results.
\* Pop sabotage fails the real-file tests. Plain-record restore loses results;
\* empty-array restore is repaired by validation and was a false alarm.
\* Not modeled: payload parsing, timestamps, counters, ask delivery, environment
\* details, save failures, cancellation signals, rewind, deletion, output-limit
\* retries, request ordering, or concurrent writes. Cancellation leaves model state unchanged.
\* PR #2701 prior review: 1 covered, 2 added, 4 gap.
\* PR #2701 supplied review summary, findings 1-11: 2 covered, 0 added, 9 gap.
\* Covered: #3 decline, #4 pending retention.
\* Gaps: #1 PR prose, #2 header, #5 retry bounds/environment, #7 test names,
\* #6 save failures, #8 counters/overwrite, #9 rewind, #10 consumers, #11 style.
\* Expect no new model defect from these test and documentation changes.
\* Null result: no new production defect found. Tests check boundaries outside the model.
\* Cost: prior simplification about eight agent minutes; this review about ten.
\* TLC runs take under five seconds. These bounded results do not prove the code.

EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Mode, PopSummary, MaxCalls, MaxEmpty, MaxMints

URec(c, m) == [kind |-> "u", call |-> c, mid |-> m]
ARec(m) == [kind |-> "a", call |-> 0, mid |-> m]
PRec == [kind |-> "plain", call |-> 0, mid |-> MaxMints]
SRec == [kind |-> "summary", call |-> 0, mid |-> MaxMints]
NoRec == [kind |-> "none", call |-> 0, mid |-> 0]

RecordSet ==
    {SRec} \cup {[kind |-> "plain", call |-> 0, mid |-> m] : m \in 0..MaxMints} \cup {ARec(m) : m \in 0..MaxMints}
    \cup {URec(c, m) : c \in 1..MaxCalls, m \in 0..MaxMints}

VARIABLES mem, disk, popped, nextMid, empties, done, summarized, issued
vars == <<mem, disk, popped, nextMid, empties, done, summarized, issued>>

MemMids(mm) == {mm[i].mid : i \in 1..Len(mm)}
MemSet(mm) == {mm[i] : i \in 1..Len(mm)}

\* The ordinary merge save: a memory record replaces its disk match by identity,
\* and records that exist only on disk stay.
MergeSave(memN) == {r \in disk : ~r.mid \in MemMids(memN)} \cup MemSet(memN)

\* A new assistant turn with a tool call is saved.
AddAssistant ==
    /\ ~done
    /\ Len(mem) = 0
    /\ nextMid < MaxMints
    /\ mem' = Append(mem, ARec(nextMid))
    /\ nextMid' = nextMid + 1
    /\ disk' = MergeSave(mem')
    /\ UNCHANGED <<popped, empties, done, summarized, issued>>

\* The tool ran. The user turn with its tool result is saved. A fresh turn is
\* minted only when no removed turn awaits restoration. During a retry the only
\* user-turn add is the restore.
AddUserResult(c) ==
    /\ ~done
    /\ Len(mem) = 1
    /\ popped = NoRec
    /\ nextMid < MaxMints
    /\ mem' = Append(mem, URec(c, nextMid))
    /\ nextMid' = nextMid + 1
    /\ disk' = MergeSave(mem')
    /\ issued' = issued \cup {c}
    /\ UNCHANGED <<popped, empties, done, summarized>>

\* No assistant content arrived. Retain leaves memory unchanged. Legacy modes pop
\* the saved turn. The popped record also marks a pending retry decision in this model.
EmptyResponse ==
    /\ ~done
    /\ empties < MaxEmpty
    /\ Len(mem) >= 2
    /\ popped = NoRec
    /\ (mem[Len(mem)].kind = "u" \/ ((PopSummary \/ Mode = "Retain") /\ mem[Len(mem)] = SRec))
    /\ popped' = mem[Len(mem)]
    /\ empties' = empties + 1
    /\ mem' = IF Mode = "Retain" THEN mem ELSE SubSeq(mem, 1, Len(mem) - 1)
    /\ disk' = IF Mode = "LosePending" THEN {r \in disk : r.kind # "u"} ELSE disk
    /\ UNCHANGED <<nextMid, done, summarized, issued>>

\* The retry re-adds the turn and saves. Stable keeps the saved identity, so the
\* merge save replaces the disk record. Fresh mints a new identity, so the merge
\* save keeps both records.
RetryReAdd(c) ==
    /\ ~done
    /\ popped # NoRec
    /\ LET restored == IF Mode = "LoseRetry" THEN [kind |-> "plain", call |-> 0, mid |-> popped.mid]
                       ELSE IF Mode # "Fresh" THEN (IF popped = SRec THEN PRec ELSE popped) ELSE URec(c, nextMid)
           replaced == IF Mode # "Fresh" THEN popped.mid ELSE nextMid
       IN /\ Mode # "Fresh" \/ nextMid < MaxMints
          /\ mem' = IF Mode = "Retain" THEN mem ELSE Append(mem, restored)
          /\ nextMid' = IF Mode # "Fresh" THEN nextMid ELSE nextMid + 1
          /\ disk' = {r \in disk : r.mid # replaced} \cup MemSet(mem')
          /\ popped' = NoRec
          /\ UNCHANGED <<empties, done, summarized, issued>>

\* The user declines the retry. The popped turn is restored with its identity,
\* then a synthetic failure turn is saved and the turn ends.
RetryDeclined(c) ==
    /\ ~done
    /\ popped # NoRec
    /\ nextMid + 1 < MaxMints
    /\ LET restored == IF Mode = "LoseDecline" THEN [kind |-> "plain", call |-> 0, mid |-> popped.mid]
                       ELSE IF Mode # "Fresh" THEN (IF popped = SRec THEN PRec ELSE popped) ELSE URec(c, nextMid)
           nextAfter == IF Mode # "Fresh" THEN nextMid ELSE nextMid + 1
           afterRestore == Append(IF Mode = "Retain" THEN mem ELSE Append(mem, restored), ARec(nextAfter))
       IN /\ mem' = afterRestore
          /\ nextMid' = nextAfter + 1
          /\ disk' = {r \in disk : ~r.mid \in MemMids(mem')} \cup MemSet(mem')
          /\ popped' = NoRec
          /\ done' = TRUE
          /\ UNCHANGED <<empties, summarized, issued>>

\* The retry gets a real assistant response. The turn ends.
CompleteTurn ==
    /\ ~done
    /\ Len(mem) >= 2
    /\ popped = NoRec
    /\ mem[Len(mem)].kind \in {"u", "summary"}
    /\ nextMid < MaxMints
    /\ mem' = Append(mem, ARec(nextMid))
    /\ nextMid' = nextMid + 1
    /\ disk' = MergeSave(mem')
    /\ done' = TRUE
    /\ UNCHANGED <<popped, empties, summarized, issued>>

\* Context management covers the saved history before retry or during backoff.
Condense ==
    /\ ~done
    /\ SRec \notin disk
    /\ Len(mem) >= 1
    /\ nextMid >= 2
    /\ mem' = Append(mem, SRec)
    /\ disk' = {SRec}
    /\ summarized' = TRUE
    /\ UNCHANGED <<popped, nextMid, empties, done, issued>>

\* Once context management saves a summary, a retry must keep its metadata.
SummarySurvives == summarized => SRec \in disk /\ SRec \in MemSet(mem)

Init ==
    /\ mem = <<>>
    /\ disk = {}
    /\ popped = NoRec
    /\ nextMid = 0
    /\ empties = 0
    /\ done = FALSE
    /\ summarized = FALSE
    /\ issued = {}

Next ==
    \/ Condense
    \/ AddAssistant
    \/ \E c \in 1..MaxCalls :
            \/ AddUserResult(c)
            \/ RetryReAdd(c)
            \/ RetryDeclined(c)
    \/ EmptyResponse
    \/ CompleteTurn

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ \A i \in 1..Len(mem) : mem[i] \in RecordSet
    /\ disk \subseteq RecordSet
    /\ popped \in RecordSet \cup {NoRec}
    /\ nextMid \in Nat
    /\ nextMid =< MaxMints
    /\ empties \in Nat
    /\ empties =< MaxEmpty
    /\ done \in BOOLEAN
    /\ summarized \in BOOLEAN
    /\ issued \subseteq 1..MaxCalls

\* The opposite of the failure: the saved history holds at most one result
\* record per tool call, so a reload sends one tool_result per tool_use id.
OneResultPerCall ==
    \A c \in 1..MaxCalls :
        Cardinality({r \in disk : r.kind = "u" /\ r.call = c}) <= 1

\* Retain keeps every saved result in memory while a retry or ask is pending.
\* The earlier Stable protocol violates this property between pop and restore.
ResultInMemory ==
    ~summarized =>
        issued \subseteq {mem[i].call : i \in {j \in 1..Len(mem) : mem[j].kind = "u"}}

\* Once saved, each issued result stays on disk, including during the pop.
\* Condense deliberately replaces results with a summary and ends this obligation.
ResultNeverLost ==
    ~summarized =>
        issued \subseteq {r.call : r \in {d \in disk : d.kind = "u"}}

====
