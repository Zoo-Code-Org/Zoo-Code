---- MODULE StreamReadCancellation ----
\* Source: Task.nextChunkWithAbort awaits iterator.next. Sink: read settlement and the request error handler.
\* Failure: completed or failed reads leave abort listeners attached. Invariant: NoSettledReadListener.
\* Failure: cancellation replaces the request's abort reason. Invariant: AbortReasonPreserved.
\* Expect the old listener race to fail after one settled read and to replace user and deadline reasons.
\* Replay success, failure, pre-aborted reads, and cancellation during a pending read through Task's real request lease.
\* The shared raceAbort helper removes its listener on either settlement path and propagates the signal reason.
\* Reference: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal#removing_the_abort_event_listener
\* Result: the old model fails after Read and Settle (5 states). All four Task regression cases fail before reuse.
\* Fixed holds (15 states). Leak and Reason fail separately. Four Task cases and 326 focused tests pass after reuse.
\* Task now reuses detachOnAbort. One drain catch owns consumption errors; detached reporting stays independent.
\* Existing ThoughtSignaturePersistence and ThoughtSignatureRecovery gates retain all positive and negative results.
\* Null result: no extra failure in the fixed bounded model. An abort race does not stop an uncooperative iterator.
\* Review counts remain 2 covered, 14 added, 0 gap. This refactor follows the user's simplification request.
\* listeners counts only the Task read's listeners. Transport listeners are outside this model.
\* Validation: all 14 full-test tasks pass, including 15,551 extension tests. Lifecycle, types, lint, formatting, and Knip pass.
\* Suppression counts stay equal. Cost: about 6 agent minutes. The two simplifications remove 24 runtime lines.
EXTENDS Naturals
VARIABLES reads, pending, listeners, reason, delivered
vars == <<reads, pending, listeners, reason, delivered>>
CleanOnSettle == TRUE
PreserveReason == TRUE
Init == /\ reads = 0 /\ pending = FALSE /\ listeners = 0 /\ reason = "none" /\ delivered = "none"
Read == /\ reads < 2 /\ ~pending /\ reads' = reads + 1
        /\ pending' = (reason = "none")
        /\ listeners' = IF reason = "none" THEN listeners + 1 ELSE listeners
        /\ delivered' = IF reason = "none" THEN "none" ELSE IF PreserveReason THEN reason ELSE "generic"
        /\ UNCHANGED reason
Settle == /\ pending /\ pending' = FALSE
          /\ listeners' = IF CleanOnSettle THEN listeners - 1 ELSE listeners
          /\ UNCHANGED <<reads, reason, delivered>>
Abort(value) == /\ reason = "none" /\ reason' = value /\ pending' = FALSE /\ listeners' = 0
                /\ delivered' = IF pending THEN IF PreserveReason THEN value ELSE "generic" ELSE delivered
                /\ UNCHANGED reads
Next == Read \/ Settle \/ (\E value \in {"user", "deadline"} : Abort(value))
Spec == Init /\ [][Next]_vars
TypeOK == /\ reads \in 0..2 /\ pending \in BOOLEAN /\ listeners \in 0..2
          /\ reason \in {"none", "user", "deadline"} /\ delivered \in {"none", "user", "deadline", "generic"}
NoSettledReadListener == ~pending => listeners = 0
AbortReasonPreserved == delivered # "none" => delivered = reason
====
