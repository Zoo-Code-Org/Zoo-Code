---- MODULE McpToolNameLedgerMC ----
\* Model-checking settings for McpToolNameLedger.
EXTENDS McpToolNameLedger

\* Sabotage: parse skips the ledger and splits every name.
ReadLNoLedger(f) == SplitOnly(f)

\* Sabotage: build records nothing.
RecordNoRecord(pr, hd, fp, f, nm, tl, sc) == <<pr, hd, fp>>

\* Sabotage: each build overwrites the holds of the name it builds. Pair
\* accumulation and first-pair tracking stay normal, so the first
\* advertisement passes: only the holds write differs, and a conflicting
\* second advertisement switches the resolution with no scope end, which
\* fails FirstPairStable (CR thread 4713678633).
RecordLastWins(pr, hd, fp, f, nm, tl, sc) ==
    LET np == pr[f] \cup {<<nm, tl>>}
    IN << [pr EXCEPT ![f] = np],
          {h \in hd : h[1] # f} \cup {<<f, <<nm, tl>>, sc>>},
          IF fp[f] = NullPair THEN [fp EXCEPT ![f] = <<nm, tl>>] ELSE fp >>

\* Sabotage: the sink refuses every advertised name (CR thread 4713678630).
\* NullPair is allowed only for a name that must not resolve, so this must
\* fail the strengthened ExactRoundTrip on the first unambiguous call.
ReadLRefuseAll(f) == NullPair

\* Sabotage: the first pair wins and a later different pair never refuses.
\* The name keeps resolving to the first scope's pair while a second live
\* pair is advertised, as the unfixed code did before the conflict marking.
RecordNoRefuse(pr, hd, fp, f, nm, tl, sc) ==
    LET np == pr[f] \cup {<<nm, tl>>}
    IN << [pr EXCEPT ![f] = np],
          hd \cup {<<f, <<nm, tl>>, sc>>},
          IF fp[f] = NullPair THEN [fp EXCEPT ![f] = <<nm, tl>>] ELSE fp >>
ReadLNoRefuse(f) == IF firstPair[f] # NullPair THEN firstPair[f] ELSE SplitOnly(f)

\* Sabotage (CR thread 4727751392): the pre-fix process-wide ledger. The
\* resolution reads the lifetime pairs and refuses a conflicted name for
\* good; scopes and scope ends change nothing. After the conflicting scope
\* ends, the surviving pair alone is live, the call is unambiguous at call
\* time, yet the name still resolves to nothing, which fails both
\* ExactRoundTrip and ActiveScopeResolves.
ReadLStale(f) ==
    IF Cardinality(pairs[f]) > 1 THEN NullPair
    ELSE IF Cardinality(pairs[f]) = 1 THEN CHOOSE p \in pairs[f] : TRUE
    ELSE SplitOnly(f)

====
