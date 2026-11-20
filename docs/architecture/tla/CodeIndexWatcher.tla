---- MODULE CodeIndexWatcher ----
\* Sources: FileWatcher.scheduleBatchProcessing and triggerBatchProcessing; batch results are an oracle.
\* Sinks: processBatch finish/progress events and CodeIndexOrchestrator._startWatcher listeners.
\* Failure: work starts after the breaker trips. Invariant: NoStartAfterTrip.
\* Review ratchet: a tripped watcher must show Error. Invariant: TripIsVisible.
\* PR 2329, https://github.com/Zoo-Code-Org/Zoo-Code/pull/2329#discussion_r4485895183: added.
\* Expect: the old summary leaves Indexed on trip. Late progress must not clear Error.
\* Initial rules were recorded before review. The prior rebase exposed the fix summary: this spec is retrospective.
\* Scope: sequential batch results and arbitrary progress events. Providers and file results are oracles.
\* Gap: disposal and overlapping work are not modeled. No claim about cancellation or persistence.
\* Result: fixed passes (4 states). Silent fails (4 states); Unguarded fails (5 states). No new finding.
\* Replay: watcher-boundary.property.spec.ts failed on 20 of 64 histories before the summary fix; all 64 now pass.
\* Sabotage replay: silent summary, removed admission guards, and removed progress latch each fail test assertions.
\* Initial disposal rule is a gap in this model; event-emitter disposal needs a separate cancellation model.
\* Cost: two small model files, three configs, 64 test histories. Agent time is not measured; each TLC run took under 1 second.
\* Gate: TLA_JAR=<jar> ./check.sh CodeIndexWatcherMC. Review counts: covered 0, added 1, gap 0.
EXTENDS Naturals
CONSTANTS Threshold, Guard, Visible
VARIABLES failures, open, ui, badStart
vars == <<failures, open, ui, badStart>>
Init == /\ failures = 0 /\ open = FALSE /\ ui = "Indexed" /\ badStart = FALSE
Batch(failed) ==
    /\ (~open \/ ~Guard)
    /\ failures' = IF failed THEN IF failures < Threshold THEN failures + 1 ELSE Threshold ELSE 0
    /\ open' = (open \/ failures' >= Threshold)
    /\ ui' = IF Visible /\ open' THEN "Error" ELSE "Indexed"
    /\ badStart' = (badStart \/ open)
Progress ==
    /\ ui' = IF Visible /\ open THEN ui ELSE "Indexed"
    /\ UNCHANGED <<failures, open, badStart>>
Restart == /\ failures' = 0 /\ open' = FALSE /\ ui' = "Indexed" /\ badStart' = FALSE
Next == Batch(TRUE) \/ Batch(FALSE) \/ Progress \/ Restart
Spec == Init /\ [][Next]_vars
NoStartAfterTrip == ~badStart
TripIsVisible == open => ui = "Error"
====
