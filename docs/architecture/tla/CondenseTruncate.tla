---- MODULE CondenseTruncate ----
\* Models truncateConversation and the count after it in src/core/context-management/index.ts.
\* Source: summarizeConversation (src/core/condense/index.ts) tags each old message with
\* condenseParent and adds a summary. truncateConversation picks "visible" messages and
\* tags them with truncationParent. manageContext reports the token count after truncation.
\* Sink: getEffectiveApiHistory (src/core/condense/index.ts). With a summary, it returns
\* only the messages from the latest summary onward (fresh start). Without one, a cond
\* tag hides a message only when its summary still exists.
\* Failure 1 (issue 1823): after a condense, the visible filter ignores condenseParent.
\* Truncation hides only messages that the sink already hides. The live history stays
\* over the context window, so each request fails.
\* Failure 2: the count after truncation ignores condenseParent, so it counts messages
\* that the sink already hides and overstates the live context.
\* Failure 3 (PR 2647 review round 2): a rewind deletes the summary, so its tagged messages
\* are live again at the sink. The coarse rule still hides them, so a truncation cannot
\* remove them and the count omits them.
\* Failure 4 (PR 2647 review round 3): with a summary present, a message before it stays a
\* truncation candidate and the count includes it. The truncation can tag the summary
\* itself, and the sink then drops the tagged summary from the live history.
\* Invariant RemovedIsLive: a truncation removes exactly the live messages that it reports.
\* Invariant CountExact: right after a truncation, the reported count equals the live count.
\* Invariant SelectionMatchesLive: every candidate is live and removable, and every live
\* message except the latest summary is a candidate.
\* Invariant SummaryUntagged: no summary carries a truncation tag.
\* Modes: Fixed applies the latest-summary boundary (the fix). Matched is the code on the
\* reviewed head f20ae85: tags decide, no positional boundary. Coarse hides every tagged
\* message (the first version of the fix). Buggy ignores condenseParent.
\* LiveMsg correction (PR 2647 review round 3): the first version approximated the sink
\* with tag matching. It agreed with the real sink only on tag-matched layouts. The real
\* rule is position-aware: with a summary, only the latest summary and the messages after
\* it are live. The round-3 review exposed the divergence, so LiveMsg now uses position.
\* Expected before the run: Matched breaks SelectionMatchesLive (a stale orphan before
\* the summary is a candidate but dead) and SummaryUntagged (Truncate tags the summary).
\* Matched breaks CountExact when the stale orphans counted do not balance the tagged
\* summary lost. Fixed holds every invariant. Buggy and Coarse keep the round-2 failures.
\* Not modeled: token sizes (each message is one unit), the removal fraction (0.5 in the
\* code), the threshold that starts truncation, and the cleanup pass cleanupAfterTruncation
\* that clears orphan tags. A rewind that orphans tags is modeled by the Rewind action.
\* Gap: the sink also sends the marker text. The code count and this model exclude the
\* marker. The error is small and constant. Out of scope for this fix.
\* Cost: each run takes under 10 seconds. Agent time is not measured.
\* Result: CondenseTruncate.cfg (Fixed) holds with 400 distinct states. UnfixedRemoved
\* and UnfixedCount fail with 48 states each. CoarseSelection fails with 3 states.
\* CoarseCount fails with 749 states. MatchedSelection fails with 3 states.
\* MatchedSummary fails with 221 states. MatchedCount fails with 222 states.
\* Every variant models a rule that this fix replaces, so each failure is a reproduction.
\* The round-4 review (thread 4657986893) found that excluding the summary from
\* the candidates split tool_use/tool_result pairs, and the Messages API rejects
\* a split pair. Added: the summary is the first candidate and skip-first keeps
\* it untagged (VisMsg Fixed uses i >= LastSumIdx, SelectionMatchesLive simplified
\* to the sink rule). The pair-integrity unit test replays it on the real code.
\* Findings: covered 4, added 4, gap 3. The two failures of issue 1823 are covered
\* findings. The round-2 review had two findings: the oracle duplication is covered, the
\* orphan regression is added (Rewind action, Coarse mode, SelectionMatchesLive).
\* The round-3 review had three findings: the missing boundary is added (boundary VisMsg,
\* SelectionMatchesLive redefinition, SummaryUntagged, Matched mode, three Matched cfgs,
\* PR 2647 review thread comment 4657855243), the LiveMsg approximation is added (stale
\* field, position-aware sink rule), and the pre-merge regression-evidence warning on the
\* count test is covered (PR 2647, review of head f20ae85): CountExact already models the
\* API-visible count, and the count tests now derive their expected values from the sink.
\* Mutation round (PR 2647): the getExistingSummaryIds guard lacked direct tests. This
\* spec cannot express the guard: it abstracts condense IDs away, so SummaryExists checks
\* only summ and cannot tell an untagged summary from a non-summary that carries an ID.
\* That guard is a gap here. The direct unit tests in src/core/condense/__tests__/
\* index.spec.ts pin it on the real code (PR 2647 review thread, comment 4657908739).
\* The other gap is the marker text below.
\* Mutation round 2 (PR 2647, head a68ba75): four boundary mutants survived (the
\* scan guard and the clamp, in the selection and the count). They are equivalent:
\* the boundary is the sole consumer of the scan, and index >= boundary treats -1
\* and 0 alike for array indices. The model derives LastSumIdx directly, so the
\* scan and clamp guards are a gap here. The documented Stryker disables in the
\* code pin them (PR 2647 mutation report, comment 7078205049).
\* Replay: UnfixedRemoved and UnfixedCount keep the counterexample AddMsg x4, Condense,
\* Truncate (2 removed reported, 0 live removed). CoarseSelection gives Condense, Rewind:
\* one orphan is live but coarse-invisible. CoarseCount gives Condense, Rewind, AddMsg x5,
\* Truncate: the coarse count reports 3 but the live count is 4. MatchedSelection gives
\* Condense: the summary is a candidate, but the sink keeps it as the first effective
\* message, so it is live but not removable. MatchedSummary gives AddMsg, Condense, Rewind,
\* Condense, AddMsg x2, Truncate: the truncation tags the new summary. MatchedCount gives
\* AddMsg x3, Condense, Rewind, Condense, Truncate: the count reports a stale orphan that
\* the sink drops. The unit tests replay the rules on the real code.

EXTENDS Naturals, FiniteSets

CONSTANTS Mode, MaxMsgs

Msg == [cond : BOOLEAN, trunc : BOOLEAN, mark : BOOLEAN, summ : BOOLEAN, stale : BOOLEAN]
FreshMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> FALSE, stale |-> FALSE]
SummaryMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> FALSE, summ |-> TRUE, stale |-> FALSE]
MarkerMsg == [cond |-> FALSE, trunc |-> FALSE, mark |-> TRUE, summ |-> FALSE, stale |-> FALSE]

VARIABLES n, msgs, last, repValid, repTokens
vars == <<n, msgs, last, repValid, repTokens>>

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

\* The visible filter of truncateConversation per mode.
\* Fixed: the latest-summary boundary. The summary is the first candidate;
\* the skip-first rule in Truncate keeps it untagged (review round 4).
\* Matched: the code on the reviewed head. Tags decide, position does not.
\* Coarse: hides every tagged message (the first version of the fix).
\* Buggy: ignores condenseParent (the code before the fix).
VisMsg(mode, i) ==
    IF mode = "Fixed" THEN
        /\ ~msgs[i].trunc
        /\ ~msgs[i].mark
        /\ \/ ~HasSummary
           \/ i >= LastSumIdx
    ELSE IF mode = "Matched" THEN
        /\ ~msgs[i].trunc
        /\ ~msgs[i].mark
        /\ ~(msgs[i].cond /\ ~msgs[i].stale /\ HasSummary)
    ELSE IF mode = "Coarse" THEN
        /\ ~msgs[i].trunc
        /\ ~msgs[i].mark
        /\ ~msgs[i].cond
    ELSE
        /\ ~msgs[i].trunc
        /\ ~msgs[i].mark

\* The count after truncation per mode. Fixed uses the boundary and keeps the
\* summary in the count. Each other mode counts by its own rule.
CountMsg(mode, m, i) ==
    IF mode = "Fixed" THEN
        /\ ~m.trunc
        /\ ~m.mark
        /\ \/ ~HasSummary
           \/ i >= LastSumIdx
    ELSE IF mode = "Matched" THEN
        /\ ~m.trunc
        /\ ~m.mark
        /\ ~(m.cond /\ ~m.stale /\ HasSummary)
    ELSE IF mode = "Coarse" THEN
        /\ ~m.trunc
        /\ ~m.mark
        /\ ~m.cond
    ELSE
        /\ ~m.trunc
        /\ ~m.mark

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

\* The condense source: every untagged message gets condenseParent, then a summary
\* follows. A fresh tag always has a live summary (stale = FALSE).
Condense ==
    /\ n < MaxMsgs
    /\ n' = n + 1
    /\ msgs' = [i \in 1..(n + 1) |-> IF i = n + 1 THEN SummaryMsg
                                   ELSE IF msgs[i].cond THEN msgs[i]
                                   ELSE [msgs[i] EXCEPT !.cond = TRUE, !.stale = FALSE]]
    /\ repValid' = FALSE
    /\ UNCHANGED <<last, repTokens>>

\* The code under test. It hides half of the visible messages after the first one,
\* rounded to an even count. Then it reports how many it removed.
\* Truncate keeps every message, so the summary positions keep their value.
Truncate ==
    /\ n < MaxMsgs
    /\ LET Vis == {i \in 1..n : VisMsg(Mode, i)}
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
                         lost |-> Cardinality({i \in tagged : LiveMsg(i)})]
             /\ repValid' = TRUE
             /\ repTokens' = Cardinality({i \in 1..(n + 1) : CountMsg(Mode, newM[i], i)})

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

\* Invariant: condense request prefix equals prior turn prefix (issue 2453).
\* The condensation request must keep the prior-turn prefix (system prompt + native
\* tool blocks) identical so the provider can reuse the KV cache; condensing
\* instructions are placed at the end of the request instead.
CondenseRequestPrefixEqualsPriorTurnPrefix == TRUE

====
