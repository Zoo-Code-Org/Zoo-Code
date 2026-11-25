---- MODULE CondenseTruncate ----
\* Models truncateConversation and the recovery round after it in
\* src/core/context-management/index.ts (the manageContext fallback).
\* Source: summarizeConversation (src/core/condense/index.ts) tags each old message with
\* condenseParent and adds a summary. truncateConversation picks "visible" messages, tags
\* them with truncationParent, and on a zero-removal history degrades one tool result.
\* manageContext reports the token count after the round.
\* Sink: getEffectiveApiHistory (src/core/condense/index.ts). With a summary, it returns only
\* the messages from the latest summary onward (fresh start). Without one, a cond tag hides
\* a message only when its summary still exists.
\* Failure 1 (issue 1823): after a condense, the visible filter ignores condenseParent, so a
\* truncation hides messages the sink already hides. Failure 2: the count after truncation
\* ignores condenseParent and overstates the live context.
\* Failure 3 (PR 2647 round 2): a rewind deletes the summary, so its tagged messages are live
\* again at the sink. The coarse rule still hides them.
\* Failure 4 (PR 2647 round 3): with a summary present, a message before it stays a
\* truncation candidate, and the truncation can tag the summary itself.
\* Failure 5 (issue 1254): a short visible history yields messagesToRemove = 0 under the
\* 0.5 even-rounding rule, and the round still reports success with no change, so an
\* oversized history retries forever. The withdrawn PR 1617 findings guided this design;
\* no code of it is reused. Degradation must not orphan either half of a pair, and a
\* stalled round ends in Error.
\* Invariant RemovedIsLive: a truncation removes exactly the live messages that it reports.
\* Invariant CountExact: right after a truncation, the reported count equals the live count.
\* Invariant SelectionMatchesLive: every candidate is live and removable, and every live
\* message except the latest summary is a candidate.
\* Invariant SummaryUntagged: no summary carries a truncation tag.
\* Invariant SuccessIsMonotonic: every reported success strictly shrinks the live weight
\* (one unit per live message, one per live oversized tool result).
\* Invariant DegradationPreservesPair: right after a degrade step, the degraded tool
\* result and its paired tool use are both live.
\* Invariant NoZeroProgressSuccess: a round that removes nothing and degrades nothing
\* never reports success.
\* Invariant BoundedRecovery: two stalled rounds in a row end in Error.
\* Failure 6 (PR 2696 review round 1, thread 4692295250): the degradation scan
\* checks every message, so with a summary it can degrade a tool result before
\* the latest summary that the sink never counts, and the round still succeeds.
\* Failure 7 (thread 4692295271): an empty tool_result array passes the size
\* scan, the clear cannot shrink the recounted tokens, and the round succeeds.
\* Failure 8 (thread 4692295281): the degrade step clears every tool_result
\* block of the selected message, so a small parallel result is lost.
\* Invariant DegSelectionLive: a degraded tool result is live at the sink.
\* Invariant DegradationKeepsOtherBlocks: a degrade keeps a second oversized
\* block of the same message.
\* Failure 9 (PR 2696 review round 2, thread 4693277487): the recovery scan
\* accepts only the first oversized block, so a message whose first block is
\* cleared leaves the scan while the second block still weighs, and the round
\* reports Error though the runtime can still recover it. Recovery selects one
\* block per round; the scan must accept either block.
\* Invariant ErrExhaustsCandidates: an Error round means no live paired tool
\* result still carries an oversized block.
\* Failure 10 (PR 2696 review round 5, taltas threads 4695751055/65/75): the
\* no-progress outcome left both Task request paths free to resend the
\* unchanged history (now they throw ContextManagementNoProgressError); a
\* degrade lost the original content (now preserved on a hidden
\* degradedOriginals marker so rewind can restore it); and the success check
\* compared a fresh recount against the API-reported total, so a
\* prompt-dominated or undercounted total rejected real reductions (now both
\* sides use the same estimator over the effective slice).
\* Modes: Fixed applies the latest-summary boundary (the fix) and the fixed recovery
\* contract (degrade one eligible tool result, or stop with Error). Matched is the reviewed
\* head f20ae85 of PR 2647: tags decide, no positional boundary. Coarse hides every tagged
\* message. Buggy ignores condenseParent. ZeroOK reports success on a zero-removal round
\* with no change (issue 1254). NoPairDeg also tags the paired tool use. PreScan scans
\* without the summary boundary; EmptyOK treats an empty-content result as oversized;
\* AllBlocks also clears the second oversized block. OnlyBig scans only the first
\* oversized block. Other modes use the Fixed arms.
\* LiveMsg correction (PR 2647 round 3): the sink rule is position-aware, not tag
\* matching. Round 4 (thread 4657986893): the summary stays the first candidate and
\* skip-first keeps pairs whole. Mutation round: the getExistingSummaryIds guard and four
\* equivalent boundary mutants are pinned by code, not the model. Not modeled: the budget
\* that starts a round, real token sizes, marker text, cleanupAfterTruncation. A rewind
\* that orphans tags is the Rewind action. Eligibility also needs a live paired tool use;
\* a pre-existing sliding-window split of a pair is out of scope for issue 1254.
\* Cost: the full check takes under 3 minutes. Agent time is not measured.
\* Result: CondenseTruncate.cfg (Fixed) holds. Every variant models a rule the fix
\* replaces and fails its target invariant. CHOOSE over several eligible results makes
\* the exact state count vary between runs; polarity does not.
\* Findings: covered 4, added 8, gap 6. Issue 1823 failures are covered; PR 2647 rounds
\* 2-4 added the Rewind action, boundary VisMsg, SummaryUntagged, skip-first (threads
\* 4657855243, 4657986893). Issue 1254 added four invariants (ZeroOK, NoPairDeg).
\* PR 2696 round 1 (threads 4692295250/71/81) added DegSelectionLive, the fake-big
\* EmptyOK case, and DegradationKeepsOtherBlocks (PreScan, EmptyOK, AllBlocks sabotage).
\* Round 2 (thread 4693277487) added ErrExhaustsCandidates and one-block-per-round
\* selection (OnlyBig sabotage); its Persistence Integrity note is a gap.
\* Gaps: marker text, getExistingSummaryIds guard, scan and clamp guards, the recovery
\* budget, the caller persist path for a failed round, and residual code eligibility.
\* Replay: ZeroOK gives Init, Recover: a one-message history reports success with no
\* change, so the live code (issue 1254) retries forever. This is the unfixed-code
\* reproduction. NoPairDeg gives Init, AddToolPair, Recover: the degraded tool result
\* stays live while its paired tool use is tagged. PreScan gives Init, AddMsg,
\* AddToolPair, Condense, Recover: the degraded result sits before the summary,
\* hidden at the sink. EmptyOK gives Init, AddFakePair, Recover: a round succeeds
\* with no weight loss. AllBlocks gives Init, AddToolPair, Recover: a second
\* oversized block vanishes. OnlyBig gives Init, AddToolPair, Recover twice: the
\* second round reports Error while the second block still weighs. The unit tests
\* replay every rule.

EXTENDS Naturals, FiniteSets

CONSTANTS Mode, MaxMsgs

\* fake: passes the size scan of the unfixed code but weighs nothing (the
\* empty-array shape). big2: a second oversized tool_result block of the same
\* message (the parallel tool call shape).
Msg == [cond : BOOLEAN, trunc : BOOLEAN, mark : BOOLEAN, summ : BOOLEAN, stale : BOOLEAN, tres : BOOLEAN, big : BOOLEAN, fake : BOOLEAN, big2 : BOOLEAN]
FreshMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> FALSE, stale |-> FALSE, tres |-> FALSE, big |-> FALSE, fake |-> FALSE, big2 |-> FALSE]
SummaryMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> TRUE, stale |-> FALSE, tres |-> FALSE, big |-> FALSE, fake |-> FALSE, big2 |-> FALSE]
MarkerMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> TRUE, summ |-> FALSE, stale |-> FALSE, tres |-> FALSE, big |-> FALSE, fake |-> FALSE, big2 |-> FALSE]
ToolResMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> FALSE, stale |-> FALSE, tres |-> TRUE, big |-> TRUE, fake |-> FALSE, big2 |-> TRUE]
FakeToolResMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> FALSE, stale |-> FALSE, tres |-> TRUE, big |-> FALSE, fake |-> TRUE, big2 |-> FALSE]

VARIABLES n, msgs, last, repValid, repTokens, phase, stall, prevWt, degIdx, degClr2
vars == <<n, msgs, last, repValid, repTokens, phase, stall, prevWt, degIdx, degClr2>>
\* degClr2: the last degrade round selected the second block (big2) as the
\* block to clear, so the first block was not touched this round.

\* The latest summary, when one exists.
SumIdxSet == {i \in 1..n : msgs[i].summ}
HasSummary == SumIdxSet # {}
LastSumIdx == CHOOSE i \in SumIdxSet : \A j \in SumIdxSet : i >= j

\* The sink rule, position-aware: with a summary, the API receives the latest
\* summary and the messages after it. Without one, a cond tag hides a message
\* only when its summary still exists. Stale marks a deleted summary.
LiveMsg(i) ==
    IF HasSummary THEN
        \/ i = LastSumIdx
        \/ /\ i > LastSumIdx
           /\ ~msgs[i].trunc
           /\ ~msgs[i].mark
    ELSE
        /\ ~msgs[i].trunc
        /\ ~msgs[i].mark

LiveCount == Cardinality({i \in 1..n : LiveMsg(i)})

\* The live weight: one unit per live message plus one per live oversized
\* tool result. The code measures tokens; this is the countable progress.
LiveWeight == LiveCount
           + Cardinality({i \in 1..n : LiveMsg(i) /\ msgs[i].tres /\ msgs[i].big})
           + Cardinality({i \in 1..n : LiveMsg(i) /\ msgs[i].tres /\ msgs[i].big2})

\* The 0.5 even-rounding rule of truncateConversation: half of the visible
\* messages after the first one, rounded down to an even count. A short
\* visible history yields zero (issue 1254).
RemovedCount(vc) ==
    LET raw == (vc - 1) \div 2
    IN IF raw % 2 = 0 THEN raw ELSE raw - 1

\* The visible filter of truncateConversation per mode. The else arm is Fixed:
\* the latest-summary boundary. The summary is the first candidate and the
\* skip-first rule in Truncate keeps it untagged (PR 2647 round 4).
VisMsg(mode, i) ==
    IF mode = "Matched" THEN /\ ~msgs[i].trunc /\ ~msgs[i].mark
                          /\ ~(msgs[i].cond /\ ~msgs[i].stale /\ HasSummary)
    ELSE IF mode = "Coarse" THEN /\ ~msgs[i].trunc /\ ~msgs[i].mark /\ ~msgs[i].cond
    ELSE IF mode = "Buggy" THEN /\ ~msgs[i].trunc /\ ~msgs[i].mark
    ELSE /\ ~msgs[i].trunc /\ ~msgs[i].mark
         /\ \/ ~HasSummary
            \/ i >= LastSumIdx

\* The count after truncation per mode. The else arm is Fixed: the boundary,
\* and the summary stays in the count.
CountMsg(mode, m, i) ==
    IF mode = "Matched" THEN /\ ~m.trunc /\ ~m.mark
                          /\ ~(m.cond /\ ~m.stale /\ HasSummary)
    ELSE IF mode = "Coarse" THEN /\ ~m.trunc /\ ~m.mark /\ ~m.cond
    ELSE IF mode = "Buggy" THEN /\ ~m.trunc /\ ~m.mark
    ELSE /\ ~m.trunc /\ ~m.mark
         /\ \/ ~HasSummary
            \/ i >= LastSumIdx

\* The k smallest elements of S. S has at least k elements when this runs.
RECURSIVE MinN(_, _)
MinN(S, k) ==
    IF k = 0 THEN {}
    ELSE LET i == CHOOSE x \in S : \A y \in S : x <= y
         IN {i} \cup MinN(S \ {i}, k - 1)

\* A talk turn adds one message. The count claim ends when the history moves on.
AddMsg ==
    /\ n < MaxMsgs
    /\ n' = n + 1
    /\ msgs' = [i \in 1..(n + 1) |-> IF i = n + 1 THEN FreshMsg ELSE msgs[i]]
    /\ repValid' = FALSE
    /\ phase' = "run" /\ stall' = 0 /\ prevWt' = 0 /\ degIdx' = 0 /\ degClr2' = FALSE
    /\ UNCHANGED <<last, repTokens>>

\* A tool turn: an assistant tool use and a user tool result, adjacent. The
\* result starts oversized, the shape of the 4MB case in issue 1254.
AddToolPair ==
    /\ n + 2 <= MaxMsgs
    /\ n' = n + 2
    /\ msgs' = [i \in 1..(n + 2) |-> IF i = n + 1 THEN FreshMsg
                                   ELSE IF i = n + 2 THEN ToolResMsg
                                   ELSE msgs[i]]
    /\ repValid' = FALSE
    /\ phase' = "run" /\ stall' = 0 /\ prevWt' = 0 /\ degIdx' = 0 /\ degClr2' = FALSE
    /\ UNCHANGED <<last, repTokens>>

\* An empty-content tool turn: the serialized empty array passes the size
\* scan of the unfixed code, but clearing it cannot shrink the token count.
AddFakePair ==
    /\ n + 2 <= MaxMsgs
    /\ n' = n + 2
    /\ msgs' = [i \in 1..(n + 2) |-> IF i = n + 1 THEN FreshMsg
                                   ELSE IF i = n + 2 THEN FakeToolResMsg
                                   ELSE msgs[i]]
    /\ repValid' = FALSE
    /\ phase' = "run" /\ stall' = 0 /\ prevWt' = 0 /\ degIdx' = 0 /\ degClr2' = FALSE
    /\ UNCHANGED <<last, repTokens>>

\* The condense source: every untagged message gets condenseParent, then a
\* summary follows. A fresh tag always has a live summary (stale = FALSE).
Condense ==
    /\ n < MaxMsgs
    /\ n' = n + 1
    /\ msgs' = [i \in 1..(n + 1) |-> IF i = n + 1 THEN SummaryMsg
                                   ELSE IF msgs[i].cond THEN msgs[i]
                                   ELSE [msgs[i] EXCEPT !.cond = TRUE, !.stale = FALSE]]
    /\ repValid' = FALSE
    /\ phase' = "run" /\ stall' = 0 /\ prevWt' = 0 /\ degIdx' = 0 /\ degClr2' = FALSE
    /\ UNCHANGED <<last, repTokens>>

\* The code under test. It hides half of the visible messages after the first
\* one, rounded to an even count. Then it reports how many it removed.
Truncate ==
    /\ n < MaxMsgs
    /\ LET Vis == {i \in 1..n : VisMsg(Mode, i)}
           vc == Cardinality(Vis)
           removed == RemovedCount(vc)
       IN /\ vc >= 5
       /\ LET first == CHOOSE i \in Vis : \A j \in Vis : i <= j
              tagged == MinN(Vis \ {first}, removed)
              newM == [i \in 1..(n + 1) |-> IF i = n + 1 THEN MarkerMsg
                                          ELSE IF i \in tagged THEN [msgs[i] EXCEPT !.trunc = TRUE]
                                          ELSE msgs[i]]
          IN /\ msgs' = newM
             /\ n' = n + 1
             /\ last' = [rep |-> removed, lost |-> Cardinality({i \in tagged : LiveMsg(i)})]
             /\ repValid' = TRUE
             /\ repTokens' = Cardinality({i \in 1..(n + 1) : CountMsg(Mode, newM[i], i)})
             /\ phase' = "ok" /\ stall' = 0 /\ prevWt' = LiveWeight /\ degIdx' = 0 /\ degClr2' = FALSE

\* A rewind to a point before the summary deletes it and the messages after it.
\* The tagged messages before it stay, now stale and live again.
Rewind ==
    /\ LET K == {k \in 1..n : msgs[k].summ}
       IN /\ Cardinality(K) = 1
          /\ \A j \in 1..n : ~msgs[j].mark
          /\ LET k == CHOOSE x \in K : TRUE
             IN /\ n' = k - 1
                /\ msgs' = [i \in 1..(k - 1) |-> IF msgs[i].cond THEN [msgs[i] EXCEPT !.stale = TRUE]
                                                  ELSE msgs[i]]
                /\ repValid' = FALSE /\ repTokens' = 0
                /\ phase' = "run" /\ stall' = 0 /\ prevWt' = 0 /\ degIdx' = 0 /\ degClr2' = FALSE
                /\ UNCHANGED last

\* One recovery round of manageContext (issue 1254) on a zero-removal history.
\* Fixed: degrade one eligible live tool result (its paired tool use stays
\* live), or stop with Error. ZeroOK: the live code reports success with no
\* change and never degrades. NoPairDeg: the degrade step also tags the pair.
\* Sizes are binary, so any eligible choice models the largest one.
Recover ==
    /\ stall < 2
    /\ LET Vis == {i \in 1..n : VisMsg(Mode, i)}
           vc == Cardinality(Vis)
       IN /\ vc >= 1
          /\ RemovedCount(vc) = 0
    /\ LET Deg == IF Mode = "PreScan" /\ HasSummary
                  THEN {i \in 2..(LastSumIdx - 1) : ~msgs[i].trunc /\ ~msgs[i].mark /\ msgs[i].tres /\ msgs[i].big}
                  ELSE IF Mode = "EmptyOK"
                  THEN {i \in 1..n : LiveMsg(i) /\ msgs[i].tres /\ msgs[i].fake /\ LiveMsg(i - 1)}
                  ELSE IF Mode = "OnlyBig"
                  THEN {i \in 1..n : LiveMsg(i) /\ msgs[i].tres /\ msgs[i].big /\ LiveMsg(i - 1)}
                  ELSE {i \in 1..n : LiveMsg(i) /\ msgs[i].tres
                        /\ (msgs[i].big \/ msgs[i].big2) /\ LiveMsg(i - 1)}
       IN \/ /\ Deg # {}
             /\ Mode # "ZeroOK"
             /\ LET d == CHOOSE x \in Deg : TRUE
                   dm == IF Mode = "NoPairDeg"
                         THEN [msgs EXCEPT ![d] = IF msgs[d].big
                                                  THEN [msgs[d] EXCEPT !.big = FALSE]
                                                  ELSE [msgs[d] EXCEPT !.big2 = FALSE],
                                          ![d - 1] = [msgs[d - 1] EXCEPT !.trunc = TRUE]]
                         ELSE IF Mode = "AllBlocks"
                         THEN [msgs EXCEPT ![d] = [msgs[d] EXCEPT !.big = FALSE, !.big2 = FALSE]]
                         ELSE IF msgs[d].big
                         THEN [msgs EXCEPT ![d] = [msgs[d] EXCEPT !.big = FALSE, !.fake = FALSE]]
                         ELSE [msgs EXCEPT ![d] = [msgs[d] EXCEPT !.big2 = FALSE, !.fake = FALSE]]
                IN /\ msgs' = dm
                   /\ phase' = "ok" /\ stall' = 0 /\ prevWt' = LiveWeight /\ degIdx' = d
                   /\ degClr2' = ((Mode # "AllBlocks") /\ ~msgs[d].big)
                   /\ repValid' = FALSE
                   /\ UNCHANGED <<n, last, repTokens>>
          \/ /\ (Deg = {} \/ Mode = "ZeroOK")
             /\ phase' = IF Mode = "ZeroOK" THEN "ok" ELSE "err"
             /\ stall' = stall + 1
             /\ prevWt' = LiveWeight /\ degIdx' = 0 /\ degClr2' = FALSE /\ repValid' = FALSE
             /\ UNCHANGED <<n, msgs, last, repTokens>>

Init == /\ n = 1
        /\ msgs = [i \in 1..1 |-> FreshMsg]
        /\ last = [rep |-> 0, lost |-> 0]
        /\ repValid = FALSE /\ repTokens = 0
        /\ phase = "run" /\ stall = 0 /\ prevWt = 0 /\ degIdx = 0 /\ degClr2 = FALSE

Next == \/ AddMsg \/ AddToolPair \/ AddFakePair \/ Condense \/ Truncate \/ Rewind \/ Recover
Spec == Init /\ [][Next]_vars

TypeOK == /\ n \in 1..MaxMsgs
          /\ msgs \in [1..n -> Msg]
          /\ last \in [rep : Nat, lost : Nat]
          /\ repTokens \in Nat /\ repValid \in BOOLEAN
          /\ phase \in {"run", "ok", "err"} /\ stall \in 0..2
          /\ prevWt \in Nat /\ degIdx \in 0..MaxMsgs
          /\ degClr2 \in BOOLEAN

\* The opposite of Failure 1: a truncation that reports k removed messages hides
\* exactly k live messages, so the live history shrinks by what the code reports.
RemovedIsLive == last.rep = last.lost

\* The opposite of Failure 2: the reported count equals the live count.
\* The Fixed count and LiveCount use one rule in this model. The unit tests on
\* the real code check that the fixed filter matches the sink.
CountExact == ~repValid \/ repTokens = LiveCount

\* The opposite of Failures 3 and 4: the selection rule and the sink agree on
\* every message. The summary is live and a candidate. Skip-first keeps it.
SelectionMatchesLive ==
    \A i \in 1..n :
        (VisMsg(Mode, i) <=> LiveMsg(i))

\* The opposite of the summary half of Failure 4: the latest summary is the
\* first effective message, so no truncation may ever tag it.
SummaryUntagged == \A i \in 1..n : msgs[i].summ => ~msgs[i].trunc

\* The opposite of the fake-success half of Failure 5: a reported success
\* strictly shrinks the live weight, so the history cannot retry at the
\* same size forever.
SuccessIsMonotonic == phase = "ok" => prevWt > LiveWeight

\* The opposite of the orphan half of Failure 5: right after a degrade step,
\* the degraded tool result is live, its content is degraded, and its paired
\* tool use is live. The Messages API rejects an orphaned half.
DegradationPreservesPair ==
    degIdx = 0 \/
    /\ degIdx > 1
    /\ LiveMsg(degIdx)
    /\ msgs[degIdx].tres
    /\ ~msgs[degIdx].big
    /\ LiveMsg(degIdx - 1)

\* The opposite of Failure 6: a degraded tool result is live at the sink, so
\* the cleared content was still model-facing and the round could count it.
DegSelectionLive == degIdx = 0 \/ LiveMsg(degIdx)

\* The opposite of Failure 8: the degrade keeps a second oversized block of
\* the selected message, so only the selected result loses its content. Each
\* round selects one block; degClr2 marks big2 as the selected one.
DegradationKeepsOtherBlocks == degIdx = 0 \/ degClr2 \/ msgs[degIdx].big2

\* The opposite of Failure 9: the stop is honest. A round that reports Error
\* leaves no selectable oversized block on any live paired tool result.
ErrExhaustsCandidates ==
    phase = "err" =>
        \A i \in 1..n :
            ~(LiveMsg(i) /\ msgs[i].tres
              /\ (msgs[i].big \/ msgs[i].big2) /\ LiveMsg(i - 1))

\* The opposite of the zero-progress half of Failure 5: a round that removes
\* nothing and degrades nothing never reports success.
NoZeroProgressSuccess == phase = "ok" => stall = 0

\* The opposite of the unbounded half of Failure 5: two stalled rounds in a
\* row end in Error, never a repeated success.
BoundedRecovery == stall >= 2 => phase = "err"

====
