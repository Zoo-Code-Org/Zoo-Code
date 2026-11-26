---- MODULE McpToolNameLedger ----
\* Models buildMcpToolName and parseMcpToolName in src/utils/mcp-name.ts.
\* Source: buildMcpToolName(server, tool) builds the function name the model sees.
\* Sink: parseMcpToolName(functionName) splits that name back into server and tool.
\* Failure 1 (issue 2338): sanitizeMcpName deletes dots. A server "Sv.m" or a tool
\* "Tl.x" becomes "Svm" or "Tlx" on the wire. The split then returns "Svm", a
\* server that does not exist. The call fails or reaches the wrong server.
\* Failure 2: the model calls a name and gets a pair that no advertisement put
\* under that name. The dispatch then invents a server or tool.
\* Failure 3: two servers sanitize to one wire name. Resolution must stay stable:
\* the pair recorded first keeps resolving. A rewrite on each build flips the
\* target between calls of one name.
\* Invariant: ExactRoundTrip. A resolved pair was advertised under that exact
\* function name. The fix records the original pair in a ledger at build time
\* and reads it back at parse time. Split remains the fallback for unknown names.
\* Invariant: FirstPairStable. A recorded pair never changes while the ledger lives.
\* Expected before the run: NoLedger fails with a dotted name whose sanitize drops
\* the dot. The split then returns a wire form no advertisement ever used.
\* Sanitize is an oracle: TLC tries every mapping of the four names to the four
\* wire forms. The invariant must hold for all of them, so the design does not
\* depend on one sanitizer behavior.
\* Actions: Advertise (build plus record), Call (model calls one advertised name).
\* | Config                        | Variant                     | Verdict |
\* | McpToolNameLedger.cfg         | On (ledger, first-wins)     | holds (14,192 states) |
\* | ...NoLedger.cfg               | parse skips the ledger      | fails ExactRoundTrip |
\* | ...NoRecord.cfg               | build forgets to record     | fails ExactRoundTrip |
\* | ...LastWins.cfg               | each build overwrites       | fails FirstPairStable |
\* Found: NoLedger fails on the first call after a dotted advertise, as expected.
\* No other invariant failed in any variant, so each sabotage pins one rule.
\* Not modeled: normalizeMcpToolName separator repair, the 64-char truncation,
\* McpHub connection state, and tool execution. Tests: mcp-name-ledger.spec.ts.
\* Cost: each cfg run takes under 30 seconds. Agent time is not measured.
\* Review: none yet (first version, written before the fix).

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Servers, Tools, WireNames, LedgerMode
\* LedgerMode: "On" (record at build, read at parse, first wins),
\* "Off" (parse splits only - the unfixed code), "NoRecord" (build forgets
\* to record), "LastWins" (each build overwrites the recorded pair).

VARIABLES san, ledger, firstPair, built, callF, callRes
\* san: the sanitize oracle, one wire form per original name.
\* ledger: function name -> recorded original pair, NullPair when not recorded.
\* firstPair: the pair each name recorded first. built: every advertisement.
\* callF, callRes: the probe.

vars == <<san, ledger, firstPair, built, callF, callRes>>

Names == Servers \cup Tools
Pairs == Servers \X Tools
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

\* The sink of the fixed code: read the ledger first, split only unknown names.
\* "Off" and "NoRecord" keep the old sink; "Off" also disables the record.
ReadL(f) == IF (LedgerMode = "On" \/ LedgerMode = "LastWins") /\ ledger[f] # NullPair
            THEN ledger[f]
            ELSE SplitOnly(f)

WriteL(f, nm, tl) ==
    CASE LedgerMode = "Off"      -> ledger
    []  LedgerMode = "NoRecord"  -> ledger
    []  LedgerMode = "LastWins"  -> [ledger EXCEPT ![f] = <<nm, tl>>]
    []  OTHER -> [ledger EXCEPT ![f] = IF ledger[f] = NullPair THEN <<nm, tl>>
                                       ELSE ledger[f]]

Init == \E oracle \in [Names -> WireNames] :
    /\ san = oracle
    /\ ledger = [fnm \in Fnames |-> NullPair]
    /\ firstPair = [fnm \in Fnames |-> NullPair]
    /\ built = {}
    /\ callF = None
    /\ callRes = NullPair

\* A tool definition is built and the original pair is offered to the ledger.
Advertise(nm, tl) ==
    /\ ledger' = WriteL(Sep3(san[nm], san[tl]), nm, tl)
    /\ firstPair' = [firstPair EXCEPT ![Sep3(san[nm], san[tl])] =
                        IF firstPair[Sep3(san[nm], san[tl])] = NullPair
                        THEN <<nm, tl>>
                        ELSE firstPair[Sep3(san[nm], san[tl])]]
    /\ built' = built \cup {[f |-> Sep3(san[nm], san[tl]), srv |-> nm, tl |-> tl]}
    /\ UNCHANGED <<callF, callRes, san>>

\* The model calls one name it was shown. built # {} guards the empty domain.
Call == \E rec \in built :
    /\ callF' = rec.f
    /\ callRes' = ReadL(rec.f)
    /\ UNCHANGED <<san, ledger, firstPair, built>>

Next == (\E nm \in Servers : \E tl \in Tools : Advertise(nm, tl)) \/ Call

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ san \in [Names -> WireNames]
    /\ \A fnm \in Fnames : ledger[fnm] \in AnyPair \cup {NullPair}
    /\ \A fnm \in Fnames : firstPair[fnm] \in AnyPair \cup {NullPair}
    /\ built \subseteq [f : Fnames, srv : Servers, tl : Tools]
    /\ (callF = None \/ callF \in Fnames)
    /\ callRes \in AnyPair \cup {NullPair}

\* Safety 1: a resolved pair was advertised under that exact function name.
ExactRoundTrip == callF = None \/ \E rec \in built :
    /\ rec.f = callF
    /\ rec.srv = callRes[1]
    /\ rec.tl = callRes[2]

\* Safety 2: a recorded pair never changes while the ledger lives.
FirstPairStable == \A fnm \in Fnames :
    ledger[fnm] # NullPair => firstPair[fnm] = ledger[fnm]

====
