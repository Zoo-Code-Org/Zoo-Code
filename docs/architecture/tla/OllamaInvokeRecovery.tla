---- MODULE OllamaInvokeRecovery ----
\* Models the incremental invoke recovery scanner InvokeRecoveryScanner
\* (src/api/providers/utils/invoke-recovery.ts) inside the content stream of
\* NativeOllamaHandler.createMessage. Source: the text chunks the TagMatcher
\* yields, one token per step, plus native tool_call arrivals. Sink: the
\* ApiStream text chunks and tool_call events, in sink order.
\* Failure 1 (issue 1429): a model writes <invoke> tool calls as plain text.
\* Nothing recovers them, so no tool runs and the turn fails.
\* Failure 2 (old PR review round 1): recovery that swallows a quoted or an
\* unterminated block, or that leaks the markup of a recovered block, shows
\* text the user must not lose or must not see.
\* Failure 3 (old PR review round 2): recovery that buffers the whole
\* response stops the live streaming of ordinary prose.
\* Failure 4 (review round 4): the sink order of recovered calls and
\* native calls must follow resolution order: a recovered call emits at
\* its </invoke> close, a native at its arrival, so a native that arrives
\* inside an open block runs before that block's call.
\* Failure 5 (old PR review round 5): a finish pass that swallows held text
\* loses data; an unterminated block stays text.
\* The machine holds text only from a marker start to the verdict, so a hold
\* can never cover a token before the marker. This is the LiveStream rule.
\* Invariant NoLostCall: a run with a complete known-name block outside a
\* quote context yields exactly one call event.
\* Invariant NoPhantomCall: a run without such a block yields no call event.
\* Invariant NoBlockTextLeak: tokens of a recovered block never reach the
\* text sink.
\* Invariant NoLostText: every live token reaches the text sink once.
\* Invariant NativeOrder: the ordered non-text events equal the truth
\* table Events for the run.
\* Invariant LiveStream: every live token is in the sink or in the hold, and
\* the hold never covers a token before the marker start.
\* Modes: Fixed is the scanner. HoldAll delays every token to the finish.
\* Unfixed recovers nothing. NoGuard ignores the quote verdict. NoSuppress
\* leaks recovered tokens to the text sink. NoFinishFlush drops the hold at
\* the finish. EarlyEmit emits the call at the hold start, not at the close.
\* The draft of the interrupted run had a NoLedger mode (natives wait in a
\* ledger). The new machine never waits with natives, so that mode had no
\* observable fault here; EarlyEmit replaces it as the NativeOrder saboteur.
\* Oracles: Tokens, HasCall, Quoted and Events are truth-table data per run.
\* The machine never re-derives a verdict; it reads the truth tables.
\* Not modeled: marker bytes split across chunk pushes (the chunk-split
\* property test covers it), the parameter schema typing, TagMatcher
\* reasoning tags, abort paths, and token costs.
\* Cost: each cfg checks in a few seconds on one TLC worker.
\* Result: OllamaInvokeRecovery.cfg (Fixed) pass in 81 states. HoldAll fails
\* LiveStream. Unfixed fails NoLostCall and NoBlockTextLeak. NoGuard fails
\* NoPhantomCall and LiveStream (TLC reports LiveStream first). NoSuppress
\* fails NoBlockTextLeak. NoFinishFlush fails NoLostText. EarlyEmit fails
\* NativeOrder.
\* Review: 1 covered, 3 added, 3 gap (PR 2695 round on c23dcd8c2). Covered:
\* a fence inside a block quote is the same quoted-run oracle (unit test
\* added). Added: the call resolves at the invoke close and natTail models
\* a native between the two closes; NoLostText counts exactly one sink
\* occurrence per live token; NativeOrder compares the ordered non-text
\* sink subsequence with Events. Gap (below the token abstraction, pinned
\* by scanner unit tests): marker whitespace rules, case-insensitive close
\* search on the original bytes, and the container prefix of fence lines.
\* Review round 3 (on 12b6def76): added TailDrop to Next, so the wrap and
\* natTail runs complete and NativeOrder checks their sinks instead of
\* stalling at the wrapper close. Covered: the wrapped unknown-name and
\* inline-code-wrapped negatives are NoPhantomCall's oracle (unit tests
\* added). Gap: the fence container rules (same-depth quote levels,
\* list-item indent, container exit closes the fence) sit below the token
\* abstraction, pinned by scanner unit tests.
\* Review round 4 (on 19d088c80): the round-3 claim that the wrapped
\* unknown-name negative was spec-covered was wrong - the unknown run
\* holds an incomplete unwrapped block. Added the complete wrapped
\* unknownWrap run (wrapper, unknown opener, parameter, invoke close,
\* wrapper close): NoPhantomCall now covers the wrapped unknown-name
\* negative on the spec level, with no oracle change (HasCall stays
\* false: the unknown-name verdict, not the quote guard, keeps it text).
\* Covered: the tab-stop list-indent rule sits below the token
\* abstraction, pinned by a scanner unit test. Gap: none new.
\* Review round 5 (on fc8dfff2d): the closing-fence indent rule (a
\* strip tab keeps residual columns; at most three columns inside the
\* container close) sits below the token abstraction like the other
\* container rules - Tokens sees a fence line as one T_FENCE token
\* with no byte or column structure. Covered: the fence run's Quoted
\* oracle already keeps a quoted example text. Gap: the line-level
\* rule, pinned by scanner unit tests (tab-space closer lines at 4
\* and 5 columns stay fenced, 3 columns closes, quoted tab closers
\* close).
\* Review round 6 (on f4e5eed4f): the quote-marker padding rule (the
\* optional space behind > may be one column of a tab; the tab's
\* residual columns stay in the content region, and closer depth is
\* measured in columns, not prefix bytes) sits below the token
\* abstraction like the other container rules - Quoted stays the run
\* oracle. Covered: the fence run's Quoted oracle already keeps a
\* quoted example text. Gap: the line-level rule, pinned by scanner
\* unit tests (a >\t ~~~ closer closes three columns deep, the
\* re-opened fence requotes the example, and the span-width and
\* nested-depth negatives stay text).
\* Review round 7 (on 50fcc34e9): the quote-level indent rule (a
\* strip tab's residual columns count toward the next level's
\* three-column marker limit; past that limit the level and the
\* fence it held end) sits below the token abstraction like the
\* other container rules - Tokens sees a fence line as one T_FENCE
\* token with no byte or column structure. Quoted stays the run
\* oracle. Covered: the fence run's Quoted oracle already keeps a
\* quoted example text. Added: no new invariant (below the token
\* abstraction). Gap: the line-level rule, pinned by scanner unit
\* tests (a second marker four columns in through a tab residual
\* plus two spaces ends the quoted fence and the call below
\* recovers; three columns in stays quoted).
\* Review round 8 (on the head after 50fcc34e9): the tail rule behind a
\* recovered call drops only the closer next to the block - a second
\* wrapper close is prose. Added: the wrapTwice run; IsTailDrop already
\* excluded the second close (a wrapper close between natives breaks
\* the all-natives condition), NoLostText now pins the second close at
\* exactly one sink occurrence. The tab-padded quoted fence opener and
\* the fence an exit line re-opens sit below the token abstraction
\* like the other container rules - Quoted stays the run oracle.
\* Covered: the fence run's Quoted oracle already keeps a quoted
\* example text. Gap: the two line-level rules, pinned by scanner
\* unit tests (>\t~~~ opens the quoted fence; the ~~~ line that ends
\* a quoted fence re-opens a top-level fence over the call below).
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Mode

\* ---- Input alphabet (one token = one stream step) ----
T_PROSE == "p"          \* plain text outside markup
T_OPNK == "o"           \* <invoke name="known-tool">
T_OPNU == "x"           \* <invoke name="unknown-tool">
T_PARAM == "r"          \* well-formed <parameter>...</parameter>
T_INVC == "c"           \* </invoke>
T_WRPO == "W"           \* <function_calls>
T_WRPC == "w"           \* </function_calls>
T_FENCE == "F"          \* a fenced code block marker line
T_TICK == "t"           \* a backtick run that opens or closes a code span
T_NATIVE == "n"         \* a native tool_call arrival

Runs == {"wrap", "wrapTwice", "split", "fence", "carry", "natAfter",
         "natMid", "natFirst", "natTail", "quotedNat", "unfin",
         "unknown", "unknownWrap", "prose"}

\* ---- Per-run inputs (truth-table data, not rules) ----
Tokens(r) ==
    CASE r = "wrap"     -> <<T_WRPO, T_OPNK, T_PARAM, T_INVC, T_WRPC>>
    []  r = "wrapTwice" -> <<T_WRPO, T_OPNK, T_PARAM, T_INVC, T_WRPC, T_WRPC>>
    []  r = "split"     -> <<T_OPNK, T_PARAM, T_INVC>>
    []  r = "fence"     -> <<T_FENCE, T_OPNK, T_PARAM, T_INVC, T_FENCE>>
    []  r = "carry"     -> <<T_TICK, T_OPNK, T_PARAM, T_INVC, T_TICK>>
    []  r = "natAfter"  -> <<T_OPNK, T_PARAM, T_INVC, T_NATIVE>>
    []  r = "natMid"    -> <<T_OPNK, T_NATIVE, T_PARAM, T_INVC>>
    []  r = "natFirst"  -> <<T_NATIVE, T_OPNK, T_PARAM, T_INVC>>
    []  r = "natTail"   -> <<T_WRPO, T_OPNK, T_PARAM, T_INVC, T_NATIVE, T_WRPC>>
    []  r = "quotedNat" -> <<T_FENCE, T_OPNK, T_NATIVE, T_PARAM, T_INVC, T_FENCE>>
    []  r = "unfin"     -> <<T_PROSE, T_OPNK, T_PARAM>>
    []  r = "unknown"   -> <<T_OPNU, T_PARAM, T_PARAM>>
    []  r = "unknownWrap" -> <<T_WRPO, T_OPNU, T_PARAM, T_INVC, T_WRPC>>
    []  r = "prose"     -> <<T_PROSE, T_PROSE>>
    []  OTHER -> <<>>

RunLen(r) == Len(Tokens(r))

\* Oracle: a complete, known-name invoke block exists in this run. TRUE for
\* the quoted runs too; the quote verdict is what keeps them as text.
HasCall(r) ==
    r \in {"wrap", "wrapTwice", "split", "fence", "carry",
           "natAfter", "natMid", "natFirst", "natTail", "quotedNat"}

\* Oracle: the block sits inside a fence or an inline code span, so the
\* guard keeps it as text.
Quoted(r) == r \in {"fence", "carry", "quotedNat"}

TruthRecovered(r) == HasCall(r) /\ ~Quoted(r)

\* The verdict the machine applies. NoGuard drops the quote guard.
EffRecov(r) == IF Mode = "NoGuard" THEN HasCall(r) ELSE TruthRecovered(r)

\* First position the machine may hold: the marker start. The wrapper
\* opener, or the invoke opener without a wrapper.
HoldStart(r) ==
    CASE r = "wrap"     -> 1
    []  r = "wrapTwice" -> 1
    []  r = "split"     -> 1
    []  r = "fence"     -> 2
    []  r = "carry"     -> 2
    []  r = "natAfter"  -> 1
    []  r = "natMid"    -> 1
    []  r = "natFirst"  -> 2
    []  r = "natTail"   -> 1
    []  r = "quotedNat" -> 2
    []  r = "unfin"     -> 2
    []  r = "unknown"   -> 1
    []  r = "unknownWrap" -> 1
    []  OTHER -> RunLen(r) + 1

\* Position where the hold resolves: the invoke close. The wrapper close
\* behind it emits nothing. Runs without a close resolve at the finish.
ResolvePos(r) ==
    CASE r = "wrap"     -> 4
    []  r = "wrapTwice" -> 4
    []  r = "split"     -> 3
    []  r = "fence"     -> 4
    []  r = "carry"     -> 4
    []  r = "natAfter"  -> 3
    []  r = "natMid"    -> 4
    []  r = "natFirst"  -> 4
    []  r = "natTail"   -> 4
    []  r = "quotedNat" -> 5
    []  OTHER -> RunLen(r) + 1

\* Positions the machine swallows when a run recovers. Native tokens never
\* join the hold; they emit on arrival.
\* The tail drops only the closer next to the block: in wrapTwice the
\* second T_WRPC stays text, so the swallow set ends at the first one.
Swallowed(r) ==
    IF r = "wrapTwice"
    THEN 1..5
    ELSE IF TruthRecovered(r)
    THEN {i \in 1..RunLen(r) : Tokens(r)[i] # T_NATIVE}
    ELSE {}

SwallowToken(r, i) == i \in Swallowed(r)
IsTextToken(r, i) == Tokens(r)[i] # T_NATIVE /\ ~SwallowToken(r, i)

\* Expected sink events, in sink order. The call sits at the resolve
\* position, the native at its arrival position. Pure data: this spec has
\* no sort operator.
Events(r) ==
    CASE r = "wrap"     -> << <<"call", 4>> >>
    []  r = "wrapTwice" -> << <<"call", 4>> >>
    []  r = "split"     -> << <<"call", 3>> >>
    []  r = "natAfter"  -> << <<"call", 3>>, <<"nat", 4>> >>
    []  r = "natMid"    -> << <<"nat", 2>>, <<"call", 4>> >>
    []  r = "natFirst"  -> << <<"nat", 1>>, <<"call", 4>> >>
    []  r = "natTail"   -> << <<"call", 4>>, <<"nat", 5>> >>
    []  r = "quotedNat" -> << <<"nat", 3>> >>
    []  OTHER -> <<>>



\* ---- Machine state ----
VARIABLES run, pos, held, sink, phase

TypeOK ==
    /\ run \in Runs
    /\ pos \in 1..RunLen(run) + 1
    /\ phase \in {"prose", "hold", "done"}
    /\ \A i \in 1..Len(held) : held[i] \in 1..RunLen(run)
    /\ \A i \in 1..Len(sink) :
        sink[i][1] \in {"txt", "call", "nat"} /\ sink[i][2] \in 1..RunLen(run)

\* The hold start the mode applies. HoldAll holds from the first token.
\* Unfixed never holds.
MHoldStart(r) ==
    CASE Mode = "HoldAll"  -> 1
    []  Mode = "Unfixed"   -> RunLen(r) + 1
    []  OTHER -> HoldStart(r)

InSeq(sq, x) == \E i \in 1..Len(sq) : sq[i] = x
CountSeq(sq, x) == Cardinality({i \in 1..Len(sq) : sq[i] = x})
TxtEvent(i) == <<"txt", i>>
HasCallEv == \E i \in 1..Len(sink) : sink[i][1] = "call"

Init ==
    /\ run \in Runs
    /\ pos = 1
    /\ held = <<>>
    /\ sink = <<>>
    /\ phase = "prose"

Finish ==
    /\ pos > RunLen(run)
    /\ phase # "done"
    /\ held' = <<>>
    /\ UNCHANGED <<pos, run>>
    /\ IF Mode = "NoFinishFlush"
       THEN /\ phase' = "done"
            /\ UNCHANGED sink
       ELSE /\ phase' = "done"
            /\ sink' = IF held = <<>>
                        THEN sink
                        ELSE sink \o [i \in 1..Len(held) |-> TxtEvent(held[i])]

Native ==
    /\ pos <= RunLen(run)
    /\ Tokens(run)[pos] = T_NATIVE
    /\ sink' = Append(sink, <<"nat", pos>>)
    /\ pos' = pos + 1
    /\ UNCHANGED <<held, phase, run>>

Hold ==
    /\ pos <= RunLen(run)
    /\ phase = "prose"
    /\ pos = MHoldStart(run)
    /\ Tokens(run)[pos] # T_NATIVE
    /\ IF Mode = "EarlyEmit" /\ EffRecov(run)
       THEN sink' = Append(sink, <<"call", pos>>)
       ELSE UNCHANGED sink
    /\ held' = Append(held, pos)
    /\ pos' = pos + 1
    /\ phase' = "hold"
    /\ UNCHANGED run

\* The wrapper close behind a recovered call emits nothing: the scanner
\* drops it in its tail step. Native arrivals never enter the text hold,
\* so they may sit between the closes. TRUE only where every token
\* between the invoke close and a T_WRPC is native.
IsTailDrop(r, p) ==
    TruthRecovered(r) /\ p > ResolvePos(r)
        /\ Tokens(r)[p] = T_WRPC
        /\ \A i \in ResolvePos(r) + 1..p - 1 : Tokens(r)[i] = T_NATIVE

TailDrop ==
    /\ pos <= RunLen(run)
    /\ IsTailDrop(run, pos)
    /\ phase = "prose"
    /\ sink' = sink
    /\ held' = held
    /\ pos' = pos + 1
    /\ UNCHANGED <<phase, run>>

Stream ==
    /\ pos <= RunLen(run)
    /\ phase = "prose"
    /\ pos # MHoldStart(run)
    /\ ~IsTailDrop(run, pos)
    /\ Tokens(run)[pos] # T_NATIVE
    /\ sink' = Append(sink, TxtEvent(pos))
    /\ pos' = pos + 1
    /\ UNCHANGED <<held, phase, run>>

HoldAdv ==
    /\ pos <= RunLen(run)
    /\ phase = "hold"
    /\ pos # ResolvePos(run)
    /\ Tokens(run)[pos] # T_NATIVE
    /\ sink' = sink
    /\ held' = Append(held, pos)
    /\ pos' = pos + 1
    /\ UNCHANGED <<phase, run>>

Resolve ==
    LET callSink == Append(sink, <<"call", pos>>)
        leakSink == callSink \o [i \in 1..Len(held) |-> TxtEvent(held[i])]
        flushSink == sink \o
            [i \in 1..Len(held) + 1 |->
                IF i <= Len(held) THEN TxtEvent(held[i]) ELSE TxtEvent(pos)]
    IN /\ pos <= RunLen(run)
       /\ phase = "hold"
       /\ pos = ResolvePos(run)
       /\ held' = <<>>
       /\ pos' = pos + 1
       /\ phase' = "prose"
       /\ UNCHANGED run
       /\ sink' = IF EffRecov(run)
                  THEN (IF Mode = "NoSuppress" THEN leakSink ELSE callSink)
                  ELSE flushSink

Next ==
    \/ Finish
    \/ Native
    \/ Hold
    \/ Stream
    \/ TailDrop
    \/ HoldAdv
    \/ Resolve

Spec == Init /\ [][Next]_<<run, pos, held, sink, phase>>

\* ---- Invariants ----

NoLostCall ==
    phase = "done" => (TruthRecovered(run) => HasCallEv)

NoPhantomCall ==
    phase = "done" => (~TruthRecovered(run) => ~HasCallEv)

NoBlockTextLeak ==
    \A i \in 1..Len(sink) :
        sink[i][1] = "txt" => ~SwallowToken(run, sink[i][2])

NoLostText ==
    phase = "done" =>
        \A i \in 1..RunLen(run) :
            IsTextToken(run, i) => CountSeq(sink, TxtEvent(i)) = 1

NonTxt(e) == e[1] # "txt"

NativeOrder ==
    phase = "done" =>
        SelectSeq(sink, NonTxt) = Events(run)

LiveStream ==
    /\ \A i \in 1..pos - 1 :
        IsTextToken(run, i) =>
            (InSeq(sink, TxtEvent(i)) \/ InSeq(held, i))
    /\ \A j \in 1..Len(held) : held[j] >= HoldStart(run)
    /\ phase = "done" => held = <<>>

====
