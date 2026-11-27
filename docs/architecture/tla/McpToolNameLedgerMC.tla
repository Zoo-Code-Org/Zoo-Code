---- MODULE McpToolNameLedgerMC ----
\* Model-checking settings for McpToolNameLedger.
EXTENDS McpToolNameLedger

\* Sabotage: parse skips the ledger and splits every name.
ReadLNoLedger(f) == SplitOnly(f)

\* Sabotage: build records nothing.
RecordNoRecord(pr, lg, fp, f, nm, tl) == <<pr, lg, fp>>

\* Sabotage: each build overwrites the recorded pair. Pair accumulation and
\* first-pair tracking stay normal, so the first advertisement passes: only
\* the ledger write differs, and a conflicting second advertisement fails
\* FirstPairStable (CR thread 4713678633).
RecordLastWins(pr, lg, fp, f, nm, tl) ==
    << [pr EXCEPT ![f] = pr[f] \cup {<<nm, tl>>}],
       [lg EXCEPT ![f] = <<nm, tl>>],
       IF fp[f] = NullPair THEN [fp EXCEPT ![f] = <<nm, tl>>] ELSE fp >>

\* Sabotage: the sink refuses every advertised name (CR thread 4713678630).
\* NullPair is allowed only for an ambiguous call, so this must fail the
\* strengthened ExactRoundTrip on the first unambiguous call.
ReadLRefuseAll(f) == NullPair

\* Sabotage: the first pair wins and a later different pair never marks the
\* name conflicted. The name keeps resolving to the first scope's pair. The
\* sink reads the ledger without the ambiguity guard, as the unfixed code did.
RecordNoRefuse(pr, lg, fp, f, nm, tl) ==
    << [pr EXCEPT ![f] = pr[f] \cup {<<nm, tl>>}],
       IF lg[f] = NullPair THEN [lg EXCEPT ![f] = <<nm, tl>>] ELSE lg,
       IF fp[f] = NullPair THEN [fp EXCEPT ![f] = <<nm, tl>>] ELSE fp >>
ReadLNoRefuse(f) == IF ledger[f] # NullPair THEN ledger[f] ELSE SplitOnly(f)

====
