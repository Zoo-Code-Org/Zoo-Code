---- MODULE CondenseTruncate ----
\* Models truncateConversation and the count after it in src/core/context-management/index.ts.
\* Source: summarizeConversation (src/core/condense/index.ts) tags each old message with
\* condenseParent and adds a summary. truncateConversation picks "visible" messages and
\* tags them with truncationParent. manageContext reports the token count after truncation.
\* Sink: getEffectiveApiHistory (src/core/condense/index.ts). It returns the live messages
\* that the API receives. A message is live when no live tag hides it and it is not a marker.
\* Failure 1 (issue 1823): after a condense, the visible filter ignores condenseParent.
\* Truncation hides only messages that the sink already hides. The live history stays
\* over the context window, so each request fails.
\* Failure 2: the count after truncation ignores condenseParent, so it counts messages
\* that the sink already hides and overstates the live context.
\* Failure 3 (PR 2647 review round): a rewind deletes the summary, so its tagged messages
\* are live again at the sink. The coarse rule still hides them, so a truncation cannot
\* remove them and the count omits them.
\* Invariant RemovedIsLive: a truncation removes exactly the live messages that it reports.
\* Invariant CountExact: right after a truncation, the reported count equals the live count.
\* Invariant SelectionMatchesLive: the selection rule and the sink agree on every message.
\* Modes: Fixed matches the sink (the fix). Coarse hides every tagged message (the first
\* version of the fix). Buggy ignores condenseParent (the code before the fix).
\* Expected before the run: Buggy breaks RemovedIsLive and CountExact after a condense.
\* Coarse breaks SelectionMatchesLive and CountExact after a rewind. Fixed holds all three.
\* Not modeled: token sizes (each message is one unit), the removal fraction (0.5 in the
\* code), the threshold that starts truncation, and the cleanup pass cleanupAfterTruncation
\* that clears orphan tags. A rewind that orphans tags is now modeled by the Rewind action.
\* Gap: the sink also sends the marker text. The code count and this model exclude the
\* marker. The error is small and constant. Out of scope for this fix.
\* Cost: each run takes under 5 seconds. Agent time is not measured.
\* Result: CondenseTruncate.cfg (Fixed) holds with 175 distinct states. The UnfixedRemoved
\* and UnfixedCount configs fail with 43 states each. CoarseSelection fails with 8 states.
\* CoarseCount fails with 592 states. Every variant models a rule that this fix replaces,
\* so each failure is a reproduction. The property tests replay the rules on the real code.
\* Findings: covered 3, added 1, gap 1. The two failures of issue 1823 are covered findings.
\* The PR 2647 review round had two findings. The oracle duplication is covered:
\* RemovedIsLive and CountExact already model the sink rule, so the defect was in the
\* test double, fixed there. The orphan regression is added: the Rewind action, the Coarse
\* mode, and the SelectionMatchesLive invariant express it (PR 2647 review thread).
\* The gap is the marker text below.
\* Replay: UnfixedRemoved and UnfixedCount keep the counterexample AddMsg x4, Condense,
\* Truncate (2 removed reported, 0 live removed). CoarseSelection gives Condense, Rewind:
\* one orphan is live but coarse-invisible. CoarseCount gives Condense, Rewind, AddMsg x5,
\* Truncate: the coarse count reports 3 but the live count is 4. The unit tests
\* "selects messages with orphaned condenseParent for truncation (rewind case)" and
\* "counts a revived orphaned-condenseParent message but not matched condensed ones"
\* replay the two Coarse traces on the real code.

EXTENDS Naturals, FiniteSets

CONSTANTS Mode, MaxMsgs

Msg == [cond : BOOLEAN, trunc : BOOLEAN, mark : BOOLEAN, summ : BOOLEAN]
FreshMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> FALSE]
SummaryMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> TRUE]
MarkerMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> TRUE, summ |-> FALSE]

VARIABLES n, msgs, last, repValid, repTokens
vars == <<n, msgs, last, repValid, repTokens>>

\* The sink rule: a tagged message is dead at the sink only when its summary still
\* exists. After a rewind deletes the summary, the tagged messages are live again.
SummaryExists == \E i \in 1..n : msgs[i].summ
LiveMsg(m) == /\ ~m.trunc /\ ~m.mark /\ ~(m.cond /\ SummaryExists)

\* The visible filter of truncateConversation. Fixed matches the sink. Coarse hides
\* every tagged message (the first version of the fix). Buggy ignores condenseParent.
VisMsg(mode, m) ==
    IF mode = "Fixed" THEN /\ ~m.trunc /\ ~m.mark /\ ~(m.cond /\ SummaryExists)
    ELSE IF mode = "Coarse" THEN /\ ~m.trunc /\ ~m.mark /\ ~m.cond
    ELSE /\ ~m.trunc /\ ~m.mark

LiveCount == Cardinality({i \in 1..n : LiveMsg(msgs[i])})

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
    /\ UNCHANGED <<last, repTokens>>

\* The condense source: every untagged message gets condenseParent, then a summary follows.
Condense ==
    /\ n < MaxMsgs
    /\ n' = n + 1
    /\ msgs' = [i \in 1..(n + 1) |-> IF i = n + 1 THEN SummaryMsg
                                   ELSE IF msgs[i].cond THEN msgs[i]
                                   ELSE [msgs[i] EXCEPT !.cond = TRUE]]
    /\ repValid' = FALSE
    /\ UNCHANGED <<last, repTokens>>

\* The code under test. It hides half of the visible messages after the first one,
\* rounded to an even count. Then it reports how many it removed.
\* Truncate keeps every message, so SummaryExists keeps its value in this step.
Truncate ==
    /\ n < MaxMsgs
    /\ LET Vis == {i \in 1..n : VisMsg(Mode, msgs[i])}
           vc == Cardinality(Vis)
           raw == (vc - 1) \div 2
           removed == IF raw % 2 = 0 THEN raw ELSE raw - 1
       IN /\ vc >= 5
       /\ LET first == CHOOSE i \in Vis : \A j \in Vis : i <= j
              tagged == MinN(Vis \ {first}, removed)
              newM == [i \in 1..(n + 1) |-> IF i = n + 1 THEN MarkerMsg
                                          ELSE IF i \in tagged THEN [msgs[i] EXCEPT !.trunc = TRUE]
                                          ELSE msgs[i]]
          IN /\ msgs' = newM
             /\ n' = n + 1
             /\ last' = [rep |-> removed,
                         lost |-> Cardinality({i \in tagged : LiveMsg(msgs[i])})]
             /\ repValid' = TRUE
             /\ repTokens' = Cardinality({i \in 1..(n + 1) :
                    IF Mode = "Fixed" THEN /\ ~newM[i].trunc /\ ~newM[i].mark /\ ~(newM[i].cond /\ SummaryExists)
                    ELSE IF Mode = "Coarse" THEN /\ ~newM[i].trunc /\ ~newM[i].mark /\ ~newM[i].cond
                    ELSE /\ ~newM[i].trunc /\ ~newM[i].mark})

\* A rewind to a point before the summary deletes it and the messages after it.
\* The tagged messages before it stay, now orphaned and live again.
Rewind ==
    /\ LET K == {k \in 1..n : msgs[k].summ}
       IN /\ Cardinality(K) = 1
          /\ \A j \in 1..n : ~msgs[j].mark
          /\ LET k == CHOOSE x \in K : TRUE
             IN /\ n' = k - 1
                /\ msgs' = [i \in 1..(k - 1) |-> msgs[i]]
                /\ repValid' = FALSE
                /\ repTokens' = 0
                /\ UNCHANGED last

Init == /\ n = 1
        /\ msgs = [i \in 1..1 |-> FreshMsg]
        /\ last = [rep |-> 0, lost |-> 0]
        /\ repValid = FALSE
        /\ repTokens = 0

Next == \/ AddMsg \/ Condense \/ Truncate \/ Rewind
Spec == Init /\ [][Next]_vars

TypeOK == /\ n \in 1..MaxMsgs
          /\ msgs \in [1..n -> Msg]
          /\ last \in [rep : Nat, lost : Nat]
          /\ repTokens \in Nat
          /\ repValid \in BOOLEAN

\* The opposite of Failure 1: a truncation that reports k removed messages hides
\* exactly k live messages, so the live history shrinks by what the code reports.
RemovedIsLive == last.rep = last.lost

\* The opposite of Failure 2: the reported count equals the live count.
\* The Fixed count and LiveCount use one rule in this model. The unit tests on the
\* real code check that the fixed filter matches the sink.
CountExact == ~repValid \/ repTokens = LiveCount

\* The opposite of Failure 3: the selection rule and the sink agree on every message.
\* CountExact covers the count half of Failure 3.
SelectionMatchesLive == \A i \in 1..n : (VisMsg(Mode, msgs[i]) <=> LiveMsg(msgs[i]))

====
