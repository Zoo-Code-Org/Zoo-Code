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
\* Result: fixed passes (9 states). All nine sabotage configs fail. No additional failure was found.
\* Variant states: SingleEmbedding 3, Local 3, Delete 4, Silent 8, StaleCount 8, Unreported 8, Leaked 10, Queued 10, Unguarded 10.
\* Replay: watcher-boundary.property.spec.ts failed on 20 of 64 histories before the summary fix; all 64 now pass.
\* Sabotage replay: silent summary, removed admission guards, and removed progress latch each fail test assertions.
\* Prior recovery tests checked call counts. Review found that recovery could swallow their ordering assertion.
\* Recovery replay now records the owner during stop and checks it after await. Moving clear before stop fails.
\* Replay: stat, read, and parse errors each tripped after three single-file batches before the fix. They no longer trip.
\* Replay: the old code omitted the trip event. The new test failed before emission was added.
\* Scope: disposal is an oracle. Tests check the call before the manager clears the owner.
\* Cost: two model files, ten configs, 689 batch histories, and focused boundary tests. Each TLC run took under 1 second.
\* Review cost: five new configs, 256 new histories, and seven runtime sabotages. Agent time is not measured.
\* Gate: TLA_JAR=<jar> ./check.sh CodeIndexWatcherMC. Review counts: covered 1, added 7, gap 2.
\* Review round: PR 2329, user-supplied Code Review Summary, findings 1-8. No thread URL was supplied.
\* Expected: local failures must not count; delete-only failures must count; each trip sends one event.
\* Expected: an open watcher drops queued events; restart clears the failure count.
\* Sources: FilePreparation.prepareFile, FileWatcher.processBatch, scheduleBatchProcessing, and initialize.
\* Sinks: the breaker flag, pending events, and CODE_INDEX_ERROR with errorType circuit_breaker_open.
\* Ratchet: 1, 4, 5, 6 added; 8 covered by TripIsVisible and the real watcher-to-orchestrator test.
\* Gap 2: PR structure is outside the runtime model. The user chose to keep one PR.
\* Gap 3: the model cannot check swallowed test assertions or disposal exceptions. Tests cover both paths.
\* Gap 7 is recorded in TelemetryBoundary. This review preceded the new invariants.
\* Runtime sabotages fail: local classification, delete clause, queue clear, counter reset, recovery order,
\* progress latch, and embedding-source tag. A stop exception is logged; recovery clears references and releases its guard.
\* Test scope: disposal exceptions can leave native resources. The model does not claim cleanup after a thrown disposal.
\* Follow-up review: a single rejected embedding must not count as a workspace failure.
\* Expect: three single-file embedding failures trip the old code. Two-file embedding failures still count.
\* The embedding oracle now distinguishes one attempted file from two. Delete-only batches still count at size one.
\* Replay: the real single-file embedding test failed on the old guard and passes with the two-file minimum.
\* Result: fixed still has 9 states; SingleEmbedding fails at 3 states. No additional failure was found.
\* Cost: one new config and 369 additional histories. Privacy line wrapping is outside this model.
\* The counter update now uses one conditional expression. Runtime flags remain because the model excludes overlap.
EXTENDS Naturals
CONSTANTS Threshold, Guard, Visible, DisposeOnRecovery,
          CountLocal, CountDelete, ReportTrip, ClearQueue, ResetFailures, CountSingleEmbedding
VARIABLES failures, open, ui, badStart, leaked, badClassification, queued, fresh, tripEvents
vars == <<failures, open, ui, badStart, leaked, badClassification, queued, fresh, tripEvents>>
Kinds == {"success", "local", "singleEmbedding", "embedding", "delete"}
ServiceFailure(kind) == kind \in {"embedding", "delete"}
CountsAsFailure(kind) == kind = "embedding" \/ (kind = "delete" /\ CountDelete)
                        \/ (kind = "local" /\ CountLocal) \/ (kind = "singleEmbedding" /\ CountSingleEmbedding)
Init == /\ failures = 0 /\ open = FALSE /\ ui = "Indexed" /\ badStart = FALSE /\ leaked = FALSE
        /\ badClassification = FALSE /\ queued = FALSE /\ fresh = TRUE /\ tripEvents = 0
Batch(kind) ==
    /\ (~open \/ ~Guard)
    /\ failures' = IF CountsAsFailure(kind) THEN IF failures < Threshold THEN failures + 1 ELSE Threshold ELSE 0
    /\ open' = (open \/ failures' >= Threshold)
    /\ ui' = IF Visible /\ open' THEN "Error" ELSE "Indexed"
    /\ badStart' = (badStart \/ open)
    /\ badClassification' = (badClassification \/ (CountsAsFailure(kind) # ServiceFailure(kind)))
    /\ tripEvents' = IF ~open /\ open' /\ ReportTrip THEN tripEvents + 1 ELSE tripEvents
    /\ queued' = FALSE /\ fresh' = FALSE
    /\ UNCHANGED leaked
Queue == /\ queued' = IF open /\ ClearQueue THEN FALSE ELSE TRUE
         /\ UNCHANGED <<failures, open, ui, badStart, leaked, badClassification, fresh, tripEvents>>
Progress ==
    /\ ui' = IF Visible /\ open THEN ui ELSE "Indexed"
    /\ UNCHANGED <<failures, open, badStart, leaked, badClassification, queued, fresh, tripEvents>>
Restart == /\ failures' = IF ResetFailures THEN 0 ELSE failures
           /\ open' = FALSE /\ ui' = "Indexed" /\ badStart' = FALSE
           /\ leaked' = (leaked \/ (open /\ ~DisposeOnRecovery))
           /\ queued' = FALSE /\ fresh' = TRUE /\ tripEvents' = 0
           /\ UNCHANGED badClassification
Next == (\E kind \in Kinds: Batch(kind)) \/ Queue \/ Progress \/ Restart
Spec == Init /\ [][Next]_vars
NoStartAfterTrip == ~badStart
TripIsVisible == open => ui = "Error"
RecoveryDisposes == ~leaked
CorrectFailureSource == ~badClassification
OpenQueueEmpty == open => ~queued
RestartIsFresh == fresh => failures = 0
TripIsReported == tripEvents = (IF open THEN 1 ELSE 0)
====
