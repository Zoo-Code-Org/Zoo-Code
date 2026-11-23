---- MODULE ThoughtSignaturePersistence ----
\* Source: an interrupted proxy stream can deliver an explicit signature during its drain.
\* Sink: Task prepares and saves the assistant history block before replay.
\* Failure: save snapshots an ID fallback before the explicit field arrives. Invariant: SavedSignatureFinal.
\* PR 2643: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4660933915
\* Expect SaveBeforeDrain to fail. Replay a delayed explicit delta through the real Task request loop.
\* Oracle: the drained stream either supplies an explicit signature or ends without one.
\* Error and cancellation end the consumed stream. Transport liveness is outside this safety model.
\* Replay: two Task cases delay the drain and verify history stays pending until it settles.
\* Both fail on the old code. After release, replay gets the explicit field or the ID fallback if no field arrives.
\* Result: fixed holds (6 states). SaveBeforeDrain fails with 8 states. No additional failure was found.
\* Task waits for opted-in handlers only. Cancellation races the drain read through nextChunkWithAbort.
\* This changes stream/history ordering, not persisted task status or shared lifecycle reducers.
\* Scope: the model checks safety for consumed chunks, not provider completion or transport liveness.
\* Validation: 1,323 focused tests pass. Types, lint, formatting and both Knip checks pass. Suppression counts stay equal.
\* All three signature model gates and lifecycle:model-check pass. Each active sabotage variant fails as expected.
\* Full pnpm test hit an unrelated custom-tool timeout. That suite passes alone; pnpm test --concurrency=2 passes all 14 tasks.
\* The extension suite passes 15,527 tests. No further modeled failure was found. Cost: about 11 agent minutes.
\* Review ratchet: add usage expiry, stalled reads, late ID-only values, and replacement of the producing handler.
\* Follow-up: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4661053797
\* https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4661110432
\* https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4661110439
\* Expect usage expiry to allow an incomplete save, an unbounded read to outlive its deadline, and replacement metadata to leak.
\* Deadline expiry is a terminal failure. No assistant turn may commit from an incomplete drain.
\* Result: four Task cases fail on the old code. All six drain scenarios pass after the fix.
\* Fixed holds (42 states). UsageBudget, Unbounded, Replacement and SaveBeforeDrain fail as expected.
\* Signature completion uses the configured request timeout, independently of usage collection. Timeout rejects the turn.
\* History preparation uses the producing handler and its captured configuration, even after a profile change.
\* Model correction: pending and committed metadata now use the same record type. Mixed values caused a TLC type error.
\* This round: 0 covered, 5 added, 0 gap; two findings concern spec files. PR totals: 2 covered, 10 added, 0 gap.
\* Validation: 1,333 focused tests, types, lint, formatting, both Knip checks, lifecycle checks and all signature gates pass.
\* pnpm test --concurrency=2 passes all 14 tasks. The extension suite passes 15,537 tests.
\* Null result: no further failure in the fixed bounded models. Timers delivering their deadline event remain an assumption.
\* Cost: about 12 agent minutes. The new timeout tests use a controlled budget rather than waiting for the full provider timeout.
\* Review ratchet: usage reporting is an auxiliary sink, separate from stream consumption.
\* Thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4661256805
\* Failure: a reporting failure retries a completed turn. Invariant: CompletedTurnNotRetried.
\* Expect the coupled drain to fail after consumption succeeds and reporting rejects or stalls.
\* Preserve failures and deadlines during consumption. A completed turn must not depend on reporting settlement.
\* Result: all three reporting replays fail before the fix and pass after reporting is detached from consumption.
\* Completed reporting may reject once, reject repeatedly or stall. History still saves the completed signature.
\* A separate Task case keeps genuine consumption errors fatal. Existing drain deadlines still reject incomplete turns.
\* Fixed holds (88 states). Reporting and ReportingWait fail independently, alongside all existing sabotage variants.
\* This round: 0 covered, 1 added, 0 gap. PR totals: 2 covered, 11 added, 0 gap; two earlier findings concern spec files.
\* Types, lint, formatting, both Knip checks and lifecycle checks pass. Suppression counts stay equal.
\* pnpm test --concurrency=2 passes all 14 tasks. The extension suite passes 15,541 tests.
\* Null result: no further failure in the fixed bounded model. Reporting delivery remains best effort.
\* Cost: about 7 agent minutes. Consumption and reporting failures use separate paths and separate regression cases.
EXTENDS Naturals

VARIABLES phase, candidate, expected, saved, complete, current, expired, reporting, retries
vars == <<phase, candidate, expected, saved, complete, current, expired, reporting, retries>>
WaitForDrain == TRUE
UseUsageTimeout == FALSE
BoundSignatureWait == TRUE
UseProducingHandler == TRUE
RetryOnReportingFailure == FALSE
WaitForUsageReporting == FALSE
Pending == [signature |-> "pending", origin |-> "pending"]
Init == /\ phase = "reading" /\ candidate \in {"none", "encoded"}
        /\ expected \in (IF candidate = "encoded" THEN {"encoded", "explicit"} ELSE {"none", "encoded", "explicit"})
        /\ saved = Pending /\ complete = FALSE /\ current = "producer" /\ expired = FALSE
        /\ reporting = "pending" /\ retries = 0
Stop == /\ phase = "reading" /\ phase' = "stopped"
        /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting, retries>>
Replace == /\ current = "producer" /\ current' = "replacement"
           /\ UNCHANGED <<phase, candidate, expected, saved, complete, expired, reporting, retries>>
Drain == /\ phase = "stopped" /\ phase' = "settled" /\ candidate' = expected /\ complete' = TRUE
         /\ UNCHANGED <<expected, saved, current, expired, reporting, retries>>
UsageExpiry == /\ phase = "stopped" /\ UseUsageTimeout /\ phase' = "settled"
               /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting, retries>>
Deadline == /\ phase = "stopped" /\ ~expired /\ expired' = TRUE
            /\ phase' = IF BoundSignatureWait THEN "failed" ELSE "stopped"
            /\ retries' = IF BoundSignatureWait THEN 1 ELSE retries
            /\ UNCHANGED <<candidate, expected, saved, complete, current, reporting>>
StreamFailure == /\ phase = "stopped" /\ phase' = "failed" /\ retries' = 1
                 /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting>>
Report(result) == /\ complete /\ reporting = "pending" /\ reporting' = result
                  /\ phase' = IF result = "failed" /\ RetryOnReportingFailure THEN "failed" ELSE phase
                  /\ retries' = IF result = "failed" /\ RetryOnReportingFailure THEN 1 ELSE retries
                  /\ UNCHANGED <<candidate, expected, saved, complete, current, expired>>
ReportDeadline == /\ complete /\ reporting = "stalled" /\ WaitForUsageReporting
                  /\ phase' = "failed" /\ retries' = 1
                  /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting>>
Save == /\ (phase = "settled" \/ (~WaitForDrain /\ phase = "stopped")) /\ saved = Pending
        /\ (~WaitForUsageReporting \/ reporting \in {"ok", "failed"})
        /\ saved' = IF UseProducingHandler \/ current = "producer"
                    THEN [signature |-> candidate, origin |-> "producer"]
                    ELSE [signature |-> "replacement", origin |-> "replacement"]
        /\ UNCHANGED <<phase, candidate, expected, complete, current, expired, reporting, retries>>
Next == Stop \/ Replace \/ Drain \/ UsageExpiry \/ Deadline \/ StreamFailure
        \/ (\E result \in {"ok", "failed", "stalled"} : Report(result)) \/ ReportDeadline \/ Save
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"reading", "stopped", "settled", "failed"}
          /\ candidate \in {"none", "encoded", "explicit"} /\ expected \in {"none", "encoded", "explicit"}
          /\ saved \in {Pending} \cup [signature : {"none", "encoded", "explicit", "replacement"}, origin : {"producer", "replacement"}]
          /\ complete \in BOOLEAN /\ expired \in BOOLEAN /\ current \in {"producer", "replacement"}
          /\ reporting \in {"pending", "ok", "failed", "stalled"} /\ retries \in 0..1
SavedSignatureFinal == saved # Pending => complete /\ saved.signature = expected
SavedFromProducingHandler == saved # Pending => saved.origin = "producer"
NoExpiredSignatureWait == expired => phase # "stopped"
CompletedTurnNotRetried == complete => retries = 0 /\ phase # "failed"
====
