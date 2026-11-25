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
\* saved result, so the fix cannot repair the duplicate by losing the result.
\* Modes: Fresh mints a new identity on every retry and decline (the code before
\* the fix). Stable restores the popped record with its identity (the fix).
\* Expected before the run: Fresh fails OneResultPerCall at the retry save. The
\* trace is NewTurn, Result, EmptyResponse, RetryReAdd. Stable holds every
\* invariant.
\* Configs: ToolResultRetry.cfg (Stable) must pass. ToolResultRetry.Current.cfg
\* (Fresh) must fail.
\* Not modeled: message content, timestamps beyond identity order, condense and
\* truncation tags, the first-chunk and mid-stream retry paths (they never
\* recreate the turn), and the two flush defects of issue 2691. Those need a
\* different fix and stay in the issue.
\* Cost: each run takes under 5 seconds. Agent time is not measured.
\* Result: ToolResultRetry.cfg (Stable) holds with 10 distinct states.
\* ToolResultRetry.Current.cfg (Fresh) fails OneResultPerCall at the retry save,
\* in 5 states. The counterexample is AddAssistant, AddUserResult, EmptyResponse,
\* RetryReAdd with a fresh identity. It matches the issue replay steps 1 and
\* 3 to 5 on the real code. ResultNeverLost holds in both modes, so the fix
\* must merge by identity, not discard results.
\* Findings: 0 covered, 1 added (the retry identity choice), 0 gap. The failing
\* replay and the stable-identity control were recreated from the issue, so no
\* prior finding exists to cover.

EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Mode, MaxCalls, MaxEmpty, MaxMints

URec(c, m) == [kind |-> "u", call |-> c, mid |-> m]
ARec(m) == [kind |-> "a", call |-> 0, mid |-> m]
NoRec == [kind |-> "none", call |-> 0, mid |-> 0]

RecordSet ==
    {ARec(m) : m \in 0..(MaxMints - 1)}
    \cup {URec(c, m) : c \in 1..MaxCalls, m \in 0..(MaxMints - 1)}

VARIABLES mem, disk, popped, nextMid, empties, done
vars == <<mem, disk, popped, nextMid, empties, done>>

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
    /\ UNCHANGED <<popped, empties, done>>

\* The tool ran. The user turn with its tool result is saved. A fresh turn is
\* minted only when no removed turn awaits restoration; mid-retry the only
\* user-turn add is the restore.
AddUserResult(c) ==
    /\ ~done
    /\ Len(mem) = 1
    /\ popped = NoRec
    /\ nextMid < MaxMints
    /\ mem' = Append(mem, URec(c, nextMid))
    /\ nextMid' = nextMid + 1
    /\ disk' = MergeSave(mem')
    /\ UNCHANGED <<popped, empties, done>>

\* The model sent no assistant content. The saved user turn is popped from
\* memory. The disk copy stays.
EmptyResponse ==
    /\ ~done
    /\ empties < MaxEmpty
    /\ Len(mem) >= 2
    /\ mem[Len(mem)].kind = "u"
    /\ popped' = mem[Len(mem)]
    /\ empties' = empties + 1
    /\ mem' = SubSeq(mem, 1, Len(mem) - 1)
    /\ UNCHANGED <<disk, nextMid, done>>

\* The retry re-adds the turn and saves. Stable keeps the saved identity, so the
\* merge save replaces the disk record. Fresh mints a new identity, so the merge
\* save keeps both records.
RetryReAdd(c) ==
    /\ ~done
    /\ popped # NoRec
    /\ LET restored == IF Mode = "Stable" THEN popped ELSE URec(c, nextMid)
           replaced == IF Mode = "Stable" THEN popped.mid ELSE nextMid
       IN /\ Mode = "Stable" \/ nextMid < MaxMints
          /\ mem' = Append(mem, restored)
          /\ nextMid' = IF Mode = "Stable" THEN nextMid ELSE nextMid + 1
          /\ disk' = {r \in disk : r.mid # replaced} \cup MemSet(mem')
          /\ popped' = NoRec
          /\ UNCHANGED <<empties, done>>

\* The user declines the retry. The popped turn is restored with its identity,
\* then a synthetic failure turn is saved and the turn ends.
RetryDeclined(c) ==
    /\ ~done
    /\ popped # NoRec
    /\ nextMid + 1 < MaxMints
    /\ LET restored == IF Mode = "Stable" THEN popped ELSE URec(c, nextMid)
           nextAfter == IF Mode = "Stable" THEN nextMid ELSE nextMid + 1
           afterRestore == Append(Append(mem, restored), ARec(nextAfter))
       IN /\ mem' = afterRestore
          /\ nextMid' = nextAfter + 1
          /\ disk' = {r \in disk : ~r.mid \in MemMids(mem')} \cup MemSet(mem')
          /\ popped' = NoRec
          /\ done' = TRUE
          /\ UNCHANGED <<empties>>

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
    /\ UNCHANGED <<popped, empties>>

Init ==
    /\ mem = <<>>
    /\ disk = {}
    /\ popped = NoRec
    /\ nextMid = 0
    /\ empties = 0
    /\ done = FALSE

Next ==
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
    done =>
        \A c \in 1..MaxCalls :
            Cardinality({r \in disk : r.kind = "u" /\ r.call = c}) = 1

====
