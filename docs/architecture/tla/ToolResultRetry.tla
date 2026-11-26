---- MODULE ToolResultRetry ----
\* Models the empty-assistant-response retry in recursivelyMakeClineRequests
\* (src/core/task/Task.ts) and the merge save in saveApiMessages and
\* mergeApiMessageSnapshots (src/core/task-persistence/mergeMessageSnapshots.ts).
\* Source: the retry pops the saved user tool-result turn from memory and re-adds
\* it. Decline restores it too. Sink: a reload turns every saved user-result
\* record into one outgoing tool_result block (mergeConsecutiveApiMessages then
\* convertToOpenAiMessages). The conversion is one-to-one on records, so the
\* model counts records.
\* Failure: the retry mints a fresh message identity, so the merge save keeps the
\* disk-only record. The reloaded history then sends two tool_result blocks for
\* one tool_use id and the provider returns HTTP 400 (issue 2691).
\* Invariant OneResultPerCall: no tool call has two saved result records.
\* Invariant ResultNeverLost: when the turn ends, every issued call still has its
\* saved result outside a summary, so the fix cannot repair the duplicate by losing the result.
\* Modes: Fresh mints a new identity on every retry and decline (the code before
\* the fix). Stable restores the popped record with its identity (the fix).
\* Expected before the run: Fresh fails OneResultPerCall at the retry save. The
\* trace is AddAssistant, AddUserResult, EmptyResponse, RetryReAdd. Stable holds every
\* invariant.
\* Configs: ToolResultRetry.cfg (Stable) must pass. ToolResultRetry.Current.cfg
\* (Fresh) must fail. ToolResultRetry.Summary.cfg removes the summary guard and must fail.
\* Not modeled: message content, timestamp order, truncation tags, and stream retries
\* that do not recreate the turn, and the two flush defects of issue 2691. Those need a
\* different fix and stay in the issue.
\* Review ratchet for PR #2701, supplied review summary (no thread URL supplied).
\* Expected: removing the identity guard can replace a summary with a plain turn.
\* Condense maps overwriteApiConversationHistory to a summary save before pop or during backoff.
\* Added: SummarySurvives models findings 1 and 3. Findings 8 and 9 are covered.
\* Gap: 2 is a separate output-limit retry. 4 to 7 and 10 to 14 concern tests or text.
\* Finding 15 needs no change. Counts: 3 covered, 2 added, 10 gap.
\* The first invariants predate this review. The new invariant follows the review.
\* Cost: each run takes under 5 seconds. This review pass took about 8 agent minutes.
\* Result: the fixed config holds with 20 distinct states.
\* Fresh fails OneResultPerCall with 8 distinct states and a 5-state trace.
\* Summary sabotage fails SummarySurvives with 11 distinct states and a 6-state trace.
\* Its last actions are Condense, EmptyResponse, RetryReAdd.
\* Replay: the before-pop summary test fails on the old guard and passes on the fix.
\* The backoff summary test passes in both versions. This is a null result.
\* No new code defect was found beyond the supplied review findings.
\* The phase table test checks summary preservation on the real persistence path.
\* Initial findings before review: 0 covered, 1 added, 0 gap.

\* Runtime simplification: derive the removed flag from popped, as this model does.
\* Both retry decisions use RetryReAdd. Keep one queue step in recursivelyMakeClineRequests.
\* Failure to prevent: a retry adds a second saved result or replaces a summary.
\* Expected: the same invariants and sabotage checks hold with no model transition change.
\* Result: 20 fixed states pass. Fresh and summary sabotage fail with 8 and 11 distinct states.
\* No new defect was found. The existing phase-table tests pass on the runtime refactor.
\* Cost: this simplification pass took about 3 agent minutes.
\* The model does not check the prompt or backoff order. Runtime tests check those paths.


EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Mode, PopSummary, MaxCalls, MaxEmpty, MaxMints

URec(c, m) == [kind |-> "u", call |-> c, mid |-> m]
ARec(m) == [kind |-> "a", call |-> 0, mid |-> m]
PRec == [kind |-> "plain", call |-> 0, mid |-> MaxMints]
SRec == [kind |-> "summary", call |-> 0, mid |-> MaxMints]
NoRec == [kind |-> "none", call |-> 0, mid |-> 0]

RecordSet ==
    {SRec, PRec} \cup {ARec(m) : m \in 0..MaxMints}
    \cup {URec(c, m) : c \in 1..MaxCalls, m \in 0..MaxMints}

VARIABLES mem, disk, popped, nextMid, empties, done, summarized
vars == <<mem, disk, popped, nextMid, empties, done, summarized>>

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
    /\ UNCHANGED <<popped, empties, done, summarized>>

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
    /\ UNCHANGED <<popped, empties, done, summarized>>

\* The model sent no assistant content. The saved user turn is popped from
\* memory. The disk copy stays.
EmptyResponse ==
    /\ ~done
    /\ empties < MaxEmpty
    /\ Len(mem) >= 2
    /\ (mem[Len(mem)].kind = "u" \/ (PopSummary /\ mem[Len(mem)] = SRec))
    /\ popped' = mem[Len(mem)]
    /\ empties' = empties + 1
    /\ mem' = SubSeq(mem, 1, Len(mem) - 1)
    /\ UNCHANGED <<disk, nextMid, done, summarized>>

\* The retry re-adds the turn and saves. Stable keeps the saved identity, so the
\* merge save replaces the disk record. Fresh mints a new identity, so the merge
\* save keeps both records.
RetryReAdd(c) ==
    /\ ~done
    /\ popped # NoRec
    /\ LET restored == IF Mode = "Stable" THEN (IF popped = SRec THEN PRec ELSE popped) ELSE URec(c, nextMid)
           replaced == IF Mode = "Stable" THEN popped.mid ELSE nextMid
       IN /\ Mode = "Stable" \/ nextMid < MaxMints
          /\ mem' = Append(mem, restored)
          /\ nextMid' = IF Mode = "Stable" THEN nextMid ELSE nextMid + 1
          /\ disk' = {r \in disk : r.mid # replaced} \cup MemSet(mem')
          /\ popped' = NoRec
          /\ UNCHANGED <<empties, done, summarized>>

\* The user declines the retry. The popped turn is restored with its identity,
\* then a synthetic failure turn is saved and the turn ends.
RetryDeclined(c) ==
    /\ ~done
    /\ popped # NoRec
    /\ nextMid + 1 < MaxMints
    /\ LET restored == IF Mode = "Stable" THEN (IF popped = SRec THEN PRec ELSE popped) ELSE URec(c, nextMid)
           nextAfter == IF Mode = "Stable" THEN nextMid ELSE nextMid + 1
           afterRestore == Append(Append(mem, restored), ARec(nextAfter))
       IN /\ mem' = afterRestore
          /\ nextMid' = nextAfter + 1
          /\ disk' = {r \in disk : ~r.mid \in MemMids(mem')} \cup MemSet(mem')
          /\ popped' = NoRec
          /\ done' = TRUE
          /\ UNCHANGED <<empties, summarized>>

\* The retry gets a real assistant response. The turn ends.
CompleteTurn ==
    /\ ~done
    /\ Len(mem) >= 2
    /\ mem[Len(mem)].kind = "u"
    /\ nextMid < MaxMints
    /\ mem' = Append(mem, ARec(nextMid))
    /\ nextMid' = nextMid + 1
    /\ disk' = MergeSave(mem')
    /\ done' = TRUE
    /\ UNCHANGED <<popped, empties, summarized>>

\* Context management replaces the saved history before the pop or during backoff.
Condense ==
    /\ ~done
    /\ SRec \notin disk
    /\ Len(mem) >= 1
    /\ nextMid >= 2
    /\ mem' = Append(mem, SRec)
    /\ disk' = {SRec}
    /\ summarized' = TRUE
    /\ UNCHANGED <<popped, nextMid, empties, done>>

\* Once context management saves a summary, a retry must keep its metadata.
SummarySurvives == summarized => SRec \in disk

Init ==
    /\ mem = <<>>
    /\ disk = {}
    /\ popped = NoRec
    /\ nextMid = 0
    /\ empties = 0
    /\ done = FALSE
    /\ summarized = FALSE

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

\* The opposite of the failure: the saved history holds at most one result
\* record per tool call, so a reload sends one tool_result per tool_use id.
OneResultPerCall ==
    \A c \in 1..MaxCalls :
        Cardinality({r \in disk : r.kind = "u" /\ r.call = c}) <= 1

\* The fix must not lose the result: when the turn ends, every issued call
\* still has its saved result.
ResultNeverLost ==
    done /\ SRec \notin disk =>
        \A c \in 1..MaxCalls :
            Cardinality({r \in disk : r.kind = "u" /\ r.call = c}) = 1

====
