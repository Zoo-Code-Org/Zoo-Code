---- MODULE McpToolNameLedger ----
\* Models buildMcpToolName and parseMcpToolName in src/utils/mcp-name.ts.
\* Source: buildMcpToolName(server, tool) builds the function name the model sees.
\* Sink: parseMcpToolName(functionName) splits that name back into server and tool.
\* Failure 1 (issue 2338): sanitizeMcpName deletes dots. A server "Sv.m" or a tool
\* "Tl.x" becomes "Svm" or "Tlx" on the wire. The split then returns "Svm", a
\* server that does not exist. The call fails or reaches the wrong server.
\* Failure 2: the model calls a name and gets a pair that no advertisement put
\* under that name. The dispatch then invents a server or tool.
\* Failure 3 (CR thread 4712051715): two scopes advertise one function name for
\* two different pairs, for example "one.server"/"tool" and "oneserver"/"tool".
\* One name for two pairs is ambiguous. The ledger marks the conflict and the
\* name stops resolving. Resolution must never pick one scope's pair, because
\* that routes the other scope's calls to the wrong server.
\* Invariant: ExactRoundTrip. A resolved pair was advertised under that exact
\* function name, and a call resolves to nothing only when the name was
\* ambiguous at call time. The fix records the original pair in a ledger at
\* build time and reads it back at parse time. Split remains the fallback for
\* unknown names.
\* Invariant: FirstPairStable. A recorded pair never changes while the ledger lives.
\* Invariant: AmbiguousNamesRefuse. A name advertised for two different pairs
\* resolves to nothing.
\* Expected before the run: NoLedger fails with a dotted name whose sanitize drops
\* the dot. The split then returns a wire form no advertisement ever used.
\* Sanitize is an oracle: TLC tries every mapping of the four names to the four
\* wire forms. The invariant must hold for all of them, so the design does not
\* depend on one sanitizer behavior.
\* Actions: Advertise (build plus record), Call (model calls one advertised name).
\* Model-checking controls live in McpToolNameLedgerMC.tla (AGENTS.md rule 6).
\* | Config                  | Variant                            | Verdict |
\* | McpToolNameLedger.cfg   | implemented behavior               | holds (16,560 states) |
\* | ...NoLedger.cfg         | parse skips the ledger             | fails ExactRoundTrip (1,284) |
\* | ...NoRecord.cfg         | build forgets to record            | fails ExactRoundTrip (1,284) |
\* | ...LastWins.cfg         | each build overwrites              | fails FirstPairStable (1,281) |
\* | ...NoRefuse.cfg         | first-wins without conflict marking | fails AmbiguousNamesRefuse (4,131) |
\* | ...RefuseAll.cfg        | sink refuses every advertised name | fails ExactRoundTrip (1,284) |
\* Found: NoLedger fails on the first call after a dotted advertise, as expected.
\* NoRefuse fails on the call after the second scope records a different pair.
\* Review (PR 2669, 2026-11-26): 1 added (AmbiguousNamesRefuse, CR thread
\* 4712051715), 1 restructured (LedgerMode moved to the MC module, CR thread
\* 4712051706), 1 gap (CR thread 4712051724: the "__" echo rewrite of the
\* separators is not modeled; parser tests pin it in NativeToolCallParser.spec).
\* Review (PR 2669 round 2, 2026-11-27): 2 added (CR thread 4713678630:
\* ExactRoundTrip requires a result for an unambiguous call, pinned by the
\* new RefuseAll sabotage; CR thread 4713678633: LastWins now accumulates
\* pairs and initializes firstPair, so it fails FirstPairStable on the
\* overwrite, not on the first record), 2 gaps (CR thread 4713678648: the
\* echo forms and the shared-echo refusal stay unmodeled, pinned by
\* mcp-name-ledger.spec.ts; CR thread 4713678638: per-test ledger isolation
\* is test-order state, pinned by the beforeEach/afterEach in
\* NativeToolCallParser.spec.ts).
\* Not modeled: normalizeMcpToolName separator repair and the echo forms, the
\* 64-char truncation, McpHub connection state, and tool execution.
\* Tests: mcp-name-ledger.spec.ts.
\* Cost: the base cfg runs in under 2 minutes; each sabotage is faster.

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Servers, Tools, WireNames

VARIABLES san, pairs, ledger, firstPair, built, callF, callRes, callAmb
\* san: the sanitize oracle, one wire form per original name.
\* pairs: function name -> the set of original pairs advertised under it.
\* ledger: function name -> the resolvable pair, NullPair when none or ambiguous.
\* firstPair: the pair each name recorded first. built: every advertisement.
\* callF, callRes: the probe. callAmb: whether the called name was ambiguous
\* at call time. The probe keeps one call, so the snapshot is part of the state.

vars == <<san, pairs, ledger, firstPair, built, callF, callRes, callAmb>>

Names == Servers \cup Tools
AnyPair == (Names \cup WireNames) \X (Names \cup WireNames)
NullPair == <<"<", ">">>  \* sentinel: these chars never occur in any name
Fnames == {"mcp--" \o sw \o "--" \o wt : sw \in WireNames, wt \in WireNames}
None == "NONE"

Sep3(sw, wt) == "mcp--" \o sw \o "--" \o wt

\* The legacy sink: split the wire name on the separator. This loses what the
\* sanitizer lost.
WireS(f) == CHOOSE ws \in {w \in WireNames : \E wt \in WireNames : Sep3(w, wt) = f} :
                TRUE
WireT(f) == CHOOSE wt \in {w \in WireNames : \E ws \in WireNames : Sep3(ws, w) = f} :
                TRUE
SplitOnly(f) == <<WireS(f), WireT(f)>>

\* The implemented record. One name accumulates the pairs advertised under it.
\* One pair resolves. Two different pairs leave nothing resolvable: the parse
\* cannot know which scope the model meant.
Record(pr, lg, fp, f, nm, tl) ==
    LET np == pr[f] \cup {<<nm, tl>>}
    IN << [pr EXCEPT ![f] = np],
          IF Cardinality(np) > 1 THEN [lg EXCEPT ![f] = NullPair]
          ELSE IF lg[f] = NullPair THEN [lg EXCEPT ![f] = <<nm, tl>>]
          ELSE lg,
          IF fp[f] = NullPair THEN [fp EXCEPT ![f] = <<nm, tl>>] ELSE fp >>

\* The sink of the fixed code: an ambiguous name resolves to nothing; the
\* ledger answers for recorded names; the split answers for unknown ones.
ReadL(f) == IF Cardinality(pairs[f]) > 1 THEN NullPair
            ELSE IF ledger[f] # NullPair THEN ledger[f]
            ELSE SplitOnly(f)

Init == \E oracle \in [Names -> WireNames] :
    /\ san = oracle
    /\ pairs = [fnm \in Fnames |-> {}]
    /\ ledger = [fnm \in Fnames |-> NullPair]
    /\ firstPair = [fnm \in Fnames |-> NullPair]
    /\ built = {}
    /\ callF = None
    /\ callRes = NullPair
    /\ callAmb = FALSE

\* A tool definition is built and the original pair is offered to the ledger.
Advertise(nm, tl) ==
    LET rec == Record(pairs, ledger, firstPair, Sep3(san[nm], san[tl]), nm, tl)
    IN /\ pairs' = rec[1]
       /\ ledger' = rec[2]
       /\ firstPair' = rec[3]
       /\ built' = built \cup {[f |-> Sep3(san[nm], san[tl]), srv |-> nm, tl |-> tl]}
       /\ UNCHANGED <<callF, callRes, callAmb, san>>

\* The model calls one name it was shown. built # {} guards the empty domain.
Call == \E rec \in built :
    /\ callF' = rec.f
    /\ callRes' = ReadL(rec.f)
    /\ callAmb' = (Cardinality(pairs[rec.f]) > 1)
    /\ UNCHANGED <<san, pairs, ledger, firstPair, built>>

Next == (\E nm \in Servers : \E tl \in Tools : Advertise(nm, tl)) \/ Call

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ san \in [Names -> WireNames]
    /\ \A fnm \in Fnames : pairs[fnm] \subseteq AnyPair
    /\ \A fnm \in Fnames : ledger[fnm] \in AnyPair \cup {NullPair}
    /\ \A fnm \in Fnames : firstPair[fnm] \in AnyPair \cup {NullPair}
    /\ built \subseteq [f : Fnames, srv : Servers, tl : Tools]
    /\ (callF = None \/ callF \in Fnames)
    /\ callRes \in AnyPair \cup {NullPair}
    /\ callAmb \in BOOLEAN

\* Safety 1: a resolved pair was advertised under that exact function name,
\* and a call resolves to nothing only when the name was ambiguous at call
\* time. A sink that refused every advertised name would otherwise satisfy
\* the rule while never round-tripping anything (CR thread 4713678630).
ExactRoundTrip ==
    \/ callF = None
    \/ (callAmb /\ callRes = NullPair)
    \/ \E rec \in built :
        /\ rec.f = callF
        /\ rec.srv = callRes[1]
        /\ rec.tl = callRes[2]

\* Safety 2: a recorded pair never changes while the ledger lives.
FirstPairStable == \A fnm \in Fnames :
    ledger[fnm] # NullPair => firstPair[fnm] = ledger[fnm]

\* Safety 3: a call of a name that is ambiguous when it is called resolves to
\* nothing. callAmb snapshots the ambiguity at call time, so a call made before
\* a conflict arrived keeps its recorded outcome.
AmbiguousNamesRefuse == callAmb => callRes = NullPair

====
