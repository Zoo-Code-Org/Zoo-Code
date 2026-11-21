---- MODULE CodeIndexWatcher ----
\* Sources: FileWatcher.scheduleBatchProcessing and triggerBatchProcessing; batch results are an oracle.
\* Sinks: processBatch finish/progress events and CodeIndexOrchestrator._startWatcher listeners.
\* Failure: work starts after the breaker trips. Invariant: NoStartAfterTrip.
\* Review ratchet: a tripped watcher must show Error. Invariant: TripIsVisible.
\* PR 2329, https://github.com/Zoo-Code-Org/Zoo-Code/pull/2329#discussion_r4485895183: added.
\* Expect: the old summary leaves Indexed on trip. Late progress must not clear Error.
\* Initial rules were recorded before review. The prior rebase exposed the fix summary: this spec is retrospective.
\* Scope: sequential batch results and arbitrary progress events. Providers and file results are oracles.
\* Recovery source: CodeIndexManager.recoverFromError; sink: CodeIndexOrchestrator.stopWatcher.
\* Failure: recovery loses a live watcher. Invariant: RecoveryDisposes.
\* Expect: recovery without disposal leaks after a trip. Overlapping work and cancellation remain outside scope.
\* PR 2329, https://github.com/Zoo-Code-Org/Zoo-Code/pull/2329#discussion_r4638535661: added.
\* Result: fixed passes (4 states). Silent fails (4 states); Unguarded fails (5 states). Leaked fails (5 states). No new finding.
\* Replay: watcher-boundary.property.spec.ts failed on 20 of 64 histories before the summary fix; all 64 now pass.
\* Sabotage replay: silent summary, removed admission guards, and removed progress latch each fail test assertions.
\* Recovery replay: manager.spec.ts failed for 1, 2, and 4 recoveries before the fix; all pass with disposal.
\* Null result: the recovery rule reproduces the review finding and finds no additional failure.
\* Scope: disposal is an oracle. Tests check the call before the manager clears the owner.
\* Cost: two small model files, four configs, 64 batch histories and three recovery counts. Agent time is not measured; each TLC run took under 1 second.
\* Gate: TLA_JAR=<jar> ./check.sh CodeIndexWatcherMC. Review counts: covered 0, added 2, gap 0.
EXTENDS Naturals
CONSTANTS Threshold, Guard, Visible, DisposeOnRecovery
VARIABLES failures, open, ui, badStart, leaked
vars == <<failures, open, ui, badStart, leaked>>
Init == /\ failures = 0 /\ open = FALSE /\ ui = "Indexed" /\ badStart = FALSE /\ leaked = FALSE
Batch(failed) ==
    /\ (~open \/ ~Guard)
    /\ failures' = IF failed THEN IF failures < Threshold THEN failures + 1 ELSE Threshold ELSE 0
    /\ open' = (open \/ failures' >= Threshold)
    /\ ui' = IF Visible /\ open' THEN "Error" ELSE "Indexed"
    /\ badStart' = (badStart \/ open)
    /\ UNCHANGED leaked
Progress ==
    /\ ui' = IF Visible /\ open THEN ui ELSE "Indexed"
    /\ UNCHANGED <<failures, open, badStart, leaked>>
Restart == /\ failures' = 0 /\ open' = FALSE /\ ui' = "Indexed" /\ badStart' = FALSE
           /\ leaked' = (leaked \/ (open /\ ~DisposeOnRecovery))
Next == Batch(TRUE) \/ Batch(FALSE) \/ Progress \/ Restart
Spec == Init /\ [][Next]_vars
NoStartAfterTrip == ~badStart
TripIsVisible == open => ui = "Error"
RecoveryDisposes == ~leaked
====
