---- MODULE CondenseTruncate ----
\* Models truncateConversation and the count after it in src/core/context-management/index.ts.
\* Source: summarizeConversation (src/core/condense/index.ts) tags each old message with
\* condenseParent and adds a summary. truncateConversation picks "visible" messages and
\* tags them with truncationParent. manageContext reports the token count after truncation.
\* Sink: getEffectiveApiHistory (src/core/condense/index.ts). It returns the live messages
\* that the API receives. A message is live when no tag hides it and it is not a marker.
\* Failure 1 (issue 1823): after a condense, the visible filter ignores condenseParent.
\* Truncation hides only messages that the sink already hides. The live history stays
\* over the context window, so each request fails.
\* Failure 2: the count after truncation ignores condenseParent, so it counts messages
\* that the sink already hides and overstates the live context.
\* Invariant RemovedIsLive: a truncation removes exactly the live messages that it reports.
\* Invariant CountExact: right after a truncation, the reported count equals the live count.
\* Modes: Fixed sees condenseParent (the fix). Buggy does not (the code before the fix).
\* Expected before the run: Buggy breaks both invariants after a condense. Fixed holds.
\* Not modeled: token sizes (each message is one unit), the removal fraction (0.5 in the
\* code), the threshold that starts truncation, and orphaned tags after a rewind
\* (a cleanup pass clears them).
\* Gap: the sink also sends the marker text. The code count and this model exclude the
\* marker. The error is small and constant. Out of scope for this fix.
\* Cost: each run takes under 5 seconds. Agent time is not measured.
\* Result: CondenseTruncate.cfg (Fixed) holds. The UnfixedRemoved and UnfixedCount
\* configs fail. They model the code before the fix, so the failures are the
\* reproduction of issue 1823. The property tests replay both on the real code.
\* Findings: covered 2, added 0, gap 1. The two failures of issue 1823 are the
\* covered findings; no review round yet. The gap is the marker text below.
\* Replay: the counterexample is AddMsg x4, Condense, Truncate. The truncation
\* reported 2 removed messages and removed 0 live ones. The unit test
\* "should not count messages hidden by condensation as visible" runs the same
\* steps on the real code and fails the same way before the fix.

EXTENDS Naturals, FiniteSets

CONSTANTS Mode, MaxMsgs

Msg == [cond : BOOLEAN, trunc : BOOLEAN, mark : BOOLEAN, summ : BOOLEAN]
FreshMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> FALSE]
SummaryMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> TRUE]
MarkerMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> TRUE, summ |-> FALSE]

VARIABLES n, msgs, last, repValid, repTokens
vars == <<n, msgs, last, repValid, repTokens>>

\* The sink rule: a tagged message is dead at the sink. In this model each tag points to
\* a summary or marker that exists, so the tag alone decides.
LiveMsg(m) == /\ ~m.trunc /\ ~m.cond /\ ~m.mark

\* The visible filter of truncateConversation. Buggy is the code before the fix.
VisMsg(mode, m) ==
    IF mode = "Fixed" THEN /\ ~m.trunc /\ ~m.mark /\ ~m.cond
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
                    IF Mode = "Fixed" THEN /\ ~newM[i].trunc /\ ~newM[i].mark /\ ~newM[i].cond
                    ELSE /\ ~newM[i].trunc /\ ~newM[i].mark})

Init == /\ n = 1
        /\ msgs = [i \in 1..1 |-> FreshMsg]
        /\ last = [rep |-> 0, lost |-> 0]
        /\ repValid = FALSE
        /\ repTokens = 0

Next == \/ AddMsg \/ Condense \/ Truncate
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

====
