---- MODULE McpToolNameLedger ----
\* Models buildMcpToolName and parseMcpToolName in src/utils/mcp-name.ts.
\* Source: buildMcpToolName(server, tool) builds the function name the model sees.
\* Sink: parseMcpToolName(functionName) splits that name back into server and tool.
\* Failure 1 (issue 2338): sanitizeMcpName deletes dots. A server "Sv.m" or a tool
\* "Tl.x" becomes "Svm" or "Tlx" on the wire. The split then returns "Svm", a
\* server that does not exist. The call fails or reaches the wrong server.
\* Failure 2: the model calls a name and gets a pair that no advertisement put
\* under that name. The dispatch then invents a server or tool.
\* Failure 3 (CR thread 4712051715): two live scopes advertise one function name
\* for two different pairs, for example "one.server"/"tool" and
\* "oneserver"/"tool". One name for two live pairs is ambiguous. Resolution
\* must never pick one scope's pair, because that routes the other scope's
\* calls to the wrong server.
\* Failure 4 (CR thread 4727751392): the conflict outliving its scopes. The
\* pre-fix ledger marked a name conflicted for the whole process. McpHub is a
\* long-lived service: a server rename only changes the server list, it never
\* restarts the host. After the old scope ends, the surviving pair alone is
\* advertised, yet every call of the name stayed refused. The fix scopes each
\* record to the build that made it: a record carries the scope token of its
\* advertisement, McpHub ends the previous generation's scope when the server
\* list changes, and resolution follows the live scopes only. A name with one
\* live pair resolves to it again; a name whose scopes all ended still
\* resolves to the one pair it ever had; a name with two live pairs, or two
\* lifetime pairs and no live pair, resolves to nothing.
\* Invariant: ExactRoundTrip. A resolved pair was advertised under that exact
\* function name, and a call resolves to nothing only when the name must not
\* resolve at call time. Split remains the fallback for unknown names.
\* Invariant: FirstPairStable. A name's resolution switches pair only after a
\* scope that held a pair of that name ended.
\* Invariant: AmbiguousNamesRefuse. A call of a name that is ambiguous when it
\* is called resolves to nothing.
\* Invariant: ActiveScopeResolves. A name with exactly one live pair resolves
\* to that pair (CR thread 4727751392): ending the conflicting scope restores
\* resolution.
\* Expected before the fix: StaleConflict fails with a call after the old
\* scope ended. The refusal was recorded for all time, so the surviving pair
\* never resolved.
\* Sanitize is an oracle: TLC tries every mapping of the four names to the
\* four wire forms. The invariant must hold for all of them, so the design
\* does not depend on one sanitizer behavior.
\* Actions: Advertise (build plus record under the current generation's
\* scope), EndScope (the server list changed; the generation's holds drop and
\* the next generation starts), Call (the model calls one advertised name).
\* Model-checking controls live in McpToolNameLedgerMC.tla (AGENTS.md rule 6).
\* | Config                       | Variant                              | Verdict |
\* | McpToolNameLedger.cfg        | implemented behavior                 | holds (23,774 states) |
\* | ...NoLedger.cfg              | parse skips the ledger               | fails ExactRoundTrip (257) |
\* | ...NoRecord.cfg              | build forgets to record              | fails ExactRoundTrip (1,284) |
\* | ...LastWins.cfg              | each build overwrites the holds      | fails FirstPairStable (1,281) |
\* | ...NoRefuse.cfg              | first-wins without conflict refusal  | fails AmbiguousNamesRefuse (5,156) |
\* | ...RefuseAll.cfg             | sink refuses every advertised name   | fails ExactRoundTrip (257) |
\* | ...StaleConflict.cfg         | pre-fix permanent conflict           | fails ActiveScopeResolves (5,163) |
\* Found: StaleConflict fails on the call after EndScope drops the old
\* generation's hold: the call is unambiguous at call time, yet the refused
\* name resolves to nothing. The fix's EndScope action restores it.
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
\* Review (PR 2669 round 3, 2026-11-28): 2 added (CR thread 4727751392: the
\* ActiveScopeResolves invariant and the scope records with EndScope; the
\* StaleConflict sabotage pins the pre-fix behavior it refuses to restore),
\* 1 restructured (the ledger pair variable became read-time resolution over
\* scope holds; FirstPairStable now allows a pair switch after EndScope and
\* forbids it otherwise).
\* Not modeled: normalizeMcpToolName separator repair and the echo forms, the
\* 64-char truncation, concurrent McpHub instances each holding a scope, and
\* tool execution.
\* Tests: mcp-name-ledger.spec.ts (the scoped-records describe pins the
\* restoration across scope end on the real code).
\* Cost: the base cfg runs in a few minutes; each sabotage is faster.

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Servers, Tools, WireNames, Scopes

VARIABLES san, pairs, holds, firstPair, current, built, callF, callRes, callAmb, reScoped
\* san: the sanitize oracle, one wire form per original name.
\* pairs: function name -> the set of original pairs ever advertised under it.
\* holds: the set of <<name, pair, scope>> triples still advertised. Only the
\* current generation's triples are live; earlier generations' triples dropped
\* out when their scope ended.
\* current: the generation every build advertises under. One hub holds one
\* server-list generation at a time; a list change ends it.
\* firstPair: the pair each name recorded first. built: every advertisement.
\* callF, callRes: the probe. callAmb: whether the called name must not
\* resolve at call time. reScoped: whether a scope that held a pair of the
\* name has ended. The probe keeps one call, so the snapshot is part of the
\* state.

vars == <<san, pairs, holds, firstPair, current, built, callF, callRes, callAmb, reScoped>>

Names == Servers \cup Tools
AnyPair == (Names \cup WireNames) \X (Names \cup WireNames)
NullPair == <<"<", ">">>  \* sentinel: these chars never occur in any name
Fnames == {"mcp--" \o sw \o "--" \o wt : sw \in WireNames, wt \in WireNames}
None == "NONE"
Triples == {<<f, p, sc>> : f \in Fnames, p \in AnyPair, sc \in Scopes}

Sep3(sw, wt) == "mcp--" \o sw \o "--" \o wt

\* The legacy sink: split the wire name on the separator. This loses what the
\* sanitizer lost.
WireS(f) == CHOOSE ws \in {w \in WireNames : \E wt \in WireNames : Sep3(w, wt) = f} :
                TRUE
WireT(f) == CHOOSE wt \in {w \in WireNames : \E ws \in WireNames : Sep3(ws, w) = f} :
                TRUE
SplitOnly(f) == <<WireS(f), WireT(f)>>

\* The pairs of a name that live scopes still advertise.
Active(f) == {p \in pairs[f] : \E sc \in Scopes : <<f, p, sc>> \in holds}

\* The resolution the sink hands back. One live pair wins. With no live pair,
\* one lifetime pair still resolves: the name keeps working across scope ends.
\* Two live pairs, or two lifetime pairs with no live pair, resolve to
\* nothing. An unknown name falls to the split.
Resolved(f) ==
    IF Cardinality(Active(f)) > 1 THEN NullPair
    ELSE IF Active(f) # {} THEN CHOOSE p \in Active(f) : TRUE
    ELSE IF Cardinality(pairs[f]) = 1 THEN CHOOSE p \in pairs[f] : TRUE
    ELSE IF pairs[f] = {} THEN SplitOnly(f)
    ELSE NullPair

ReadL(f) == Resolved(f)

\* Whether the name must not resolve at call time: two live pairs fight over
\* it, or every scope ended with two lifetime pairs left behind.
AmbiguousNow(f) == Cardinality(Active(f)) > 1 \/ (Active(f) = {} /\ Cardinality(pairs[f]) > 1)

\* The implemented record. The pair joins the name's lifetime set and the
\* scope takes a hold on it.
Record(pr, hd, fp, f, nm, tl, sc) ==
    LET np == pr[f] \cup {<<nm, tl>>}
    IN << [pr EXCEPT ![f] = np],
          hd \cup {<<f, <<nm, tl>>, sc>>},
          IF fp[f] = NullPair THEN [fp EXCEPT ![f] = <<nm, tl>>] ELSE fp >>

Init == \E oracle \in [Names -> WireNames] :
    /\ san = oracle
    /\ pairs = [fnm \in Fnames |-> {}]
    /\ holds = {}
    /\ firstPair = [fnm \in Fnames |-> NullPair]
    /\ current = CHOOSE sc \in Scopes : TRUE
    /\ built = {}
    /\ callF = None
    /\ callRes = NullPair
    /\ callAmb = FALSE
    /\ reScoped = [fnm \in Fnames |-> FALSE]

\* A tool definition is built and the original pair is offered to the ledger
\* under the current generation's scope.
Advertise(nm, tl) ==
    LET rec == Record(pairs, holds, firstPair, Sep3(san[nm], san[tl]), nm, tl, current)
    IN /\ pairs' = rec[1]
       /\ holds' = rec[2]
       /\ firstPair' = rec[3]
       /\ built' = built \cup {[f |-> Sep3(san[nm], san[tl]), srv |-> nm, tl |-> tl]}
       /\ UNCHANGED <<callF, callRes, callAmb, san, reScoped, current>>

\* The server list changed: the current generation's holds end and the next
\* generation takes over. Names whose records it held may resolve to their
\* surviving pair again. The generation must have held something, so an end
\* always drops a hold.
EndScope(sc) ==
    /\ sc = current
    /\ \E h \in holds : h[3] = sc
    /\ LET dropped == {h \in holds : h[3] = sc}
       IN /\ holds' = holds \ dropped
          /\ reScoped' = [fnm \in Fnames |->
                          IF \E h \in dropped : h[1] = fnm THEN TRUE ELSE reScoped[fnm]]
          /\ current' = CHOOSE nxt \in Scopes : nxt # sc
          /\ UNCHANGED <<san, pairs, firstPair, built, callF, callRes, callAmb>>

\* The model calls one name it was shown. built # {} guards the empty domain.
Call == \E rec \in built :
    /\ callF' = rec.f
    /\ callRes' = ReadL(rec.f)
    /\ callAmb' = AmbiguousNow(rec.f)
    /\ UNCHANGED <<san, pairs, holds, firstPair, current, built, reScoped>>

Next == (\E nm \in Servers : \E tl \in Tools : Advertise(nm, tl))
        \/ EndScope(current)
        \/ Call

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ san \in [Names -> WireNames]
    /\ \A fnm \in Fnames : pairs[fnm] \subseteq AnyPair
    /\ holds \subseteq Triples
    /\ \A fnm \in Fnames : firstPair[fnm] \in AnyPair \cup {NullPair}
    /\ current \in Scopes
    /\ built \subseteq [f : Fnames, srv : Servers, tl : Tools]
    /\ (callF = None \/ callF \in Fnames)
    /\ callRes \in AnyPair \cup {NullPair}
    /\ callAmb \in BOOLEAN
    /\ reScoped \in [Fnames -> BOOLEAN]

\* Safety 1: a resolved pair was advertised under that exact function name,
\* and a call resolves to nothing only when the name must not resolve at call
\* time. A sink that refused every advertised name would otherwise satisfy
\* the rule while never round-tripping anything (CR thread 4713678630).
ExactRoundTrip ==
    \/ callF = None
    \/ (callAmb /\ callRes = NullPair)
    \/ \E rec \in built :
        /\ rec.f = callF
        /\ rec.srv = callRes[1]
        /\ rec.tl = callRes[2]

\* Safety 2: a resolution that switched to a pair other than the first one
\* recorded demands a scope end for that name. A build that overwrites the
\* holds of a live name switches pairs with no scope end (CR thread
\* 4713678633).
FirstPairStable == \A fnm \in Fnames : pairs[fnm] # {} =>
    ((Resolved(fnm) # NullPair /\ Resolved(fnm) # firstPair[fnm]) => reScoped[fnm])

\* Safety 3: a call of a name that must not resolve when it is called
\* resolves to nothing. callAmb snapshots the ambiguity at call time, so a
\* call made before a conflict arrived keeps its recorded outcome.
AmbiguousNamesRefuse == callAmb => callRes = NullPair

\* Safety 4 (CR thread 4727751392): a name with exactly one live pair
\* resolves, and the sink hands back that pair. Ending the conflicting scope
\* restores resolution; a conflict that outlives its scopes violates this
\* invariant. The invariant reads the sink, so a sabotage of the sink cannot
\* satisfy it vacuously.
ActiveScopeResolves == \A fnm \in Fnames :
    Cardinality(Active(fnm)) = 1 => ReadL(fnm) \in Active(fnm)

====
