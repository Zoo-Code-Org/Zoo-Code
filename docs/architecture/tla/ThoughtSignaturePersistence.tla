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
\* User review of d4d3324636 on PR 2643: an executed tool must not repeat after a consumption failure or deadline.
\* Expect the old retry rule to violate ToolTurnNotRetried. Source: streamed tool calls. Sink: the retry stack.
\* Code: recursivelyMakeClineRequests consumes calls and starts presentAssistantMessageSafe before the signature drain.
\* Runtime guard uses any complete tool call because execution can overlap stream consumption.
\* toolObserved abstracts complete calls. Execution can start after this source event, before stream completion.
\* CodeRabbit reporting checks: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4661514386
\* Add ReportingBounded and attempt-count and telemetry assertions. Reporting delivery remains best effort.
\* Result: the old retry rule fails after Stop and Deadline with toolObserved true and retries 1.
\* Both real-presenter regressions fail without the guard. Each observes one write-handler call and an unsafe retry.
\* With the guard, both cases retain the result and stop without another request. Partial calls remain retryable.
\* Fixed holds (248 states). ToolRetry and ReportAttempts fail, as do all six existing negative configurations.
\* One-attempt and three-attempt runtime changes fail the reporting tests. The successful case checks an exact telemetry payload.
\* This round: 0 covered, 2 added, 0 gap. PR totals: 2 covered, 13 added, 0 gap.
\* Null result: no additional failure in the fixed bounded model. This change does not add durable tool recovery.
\* Validation: full pnpm test --concurrency=2 passes all 14 tasks, including 15,543 extension tests.
\* The first full run hit an extension-activation timeout. That suite passes alone and on the full rerun.
\* Types, lint, formatting, both Knip checks and lifecycle checks pass. Suppression counts stay equal.
\* Cost: about 12 agent minutes. The runtime change adds one conservative stop before the retry branch.
\* Review: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4673468489
\* Added ThoughtSignatureRecovery for the ask-to-request boundary. Signature values do not change recovery decisions.
\* The separate bounded model avoids multiplying independent signature and recovery states.
EXTENDS Naturals

VARIABLES phase, candidate, expected, saved, complete, current, expired, reporting, retries, toolObserved, reportAttempts
vars == <<phase, candidate, expected, saved, complete, current, expired, reporting, retries, toolObserved, reportAttempts>>
RetryAfterTool == FALSE
ReportLimit == 2
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
        /\ reporting = "pending" /\ retries = 0 /\ toolObserved \in BOOLEAN /\ reportAttempts = 0
Stop == /\ phase = "reading" /\ phase' = "stopped"
        /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting, retries, toolObserved, reportAttempts>>
Replace == /\ current = "producer" /\ current' = "replacement"
           /\ UNCHANGED <<phase, candidate, expected, saved, complete, expired, reporting, retries, toolObserved, reportAttempts>>
Drain == /\ phase = "stopped" /\ phase' = "settled" /\ candidate' = expected /\ complete' = TRUE
         /\ UNCHANGED <<expected, saved, current, expired, reporting, retries, toolObserved, reportAttempts>>
UsageExpiry == /\ phase = "stopped" /\ UseUsageTimeout /\ phase' = "settled"
               /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting, retries, toolObserved, reportAttempts>>
Deadline == /\ phase = "stopped" /\ ~expired /\ expired' = TRUE
            /\ phase' = IF BoundSignatureWait THEN "failed" ELSE "stopped"
            /\ retries' = IF BoundSignatureWait /\ (~toolObserved \/ RetryAfterTool) THEN 1 ELSE retries
            /\ UNCHANGED <<candidate, expected, saved, complete, current, reporting, toolObserved, reportAttempts>>
StreamFailure == /\ phase = "stopped" /\ phase' = "failed" /\ retries' = IF ~toolObserved \/ RetryAfterTool THEN 1 ELSE 0
                 /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting, toolObserved, reportAttempts>>
Report(result) == /\ complete /\ reporting \in {"pending", "failed"} /\ reportAttempts < ReportLimit
                  /\ reporting' = result /\ reportAttempts' = reportAttempts + 1
                  /\ phase' = IF result = "failed" /\ RetryOnReportingFailure THEN "failed" ELSE phase
                  /\ retries' = IF result = "failed" /\ RetryOnReportingFailure THEN 1 ELSE retries
                  /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, toolObserved>>
ReportDeadline == /\ complete /\ reporting = "stalled" /\ WaitForUsageReporting
                  /\ phase' = "failed" /\ retries' = 1
                  /\ UNCHANGED <<candidate, expected, saved, complete, current, expired, reporting, toolObserved, reportAttempts>>
Save == /\ (phase = "settled" \/ (~WaitForDrain /\ phase = "stopped")) /\ saved = Pending
        /\ (~WaitForUsageReporting \/ reporting \in {"ok", "failed"})
        /\ saved' = IF UseProducingHandler \/ current = "producer"
                    THEN [signature |-> candidate, origin |-> "producer"]
                    ELSE [signature |-> "replacement", origin |-> "replacement"]
        /\ UNCHANGED <<phase, candidate, expected, complete, current, expired, reporting, retries, toolObserved, reportAttempts>>
Next == Stop \/ Replace \/ Drain \/ UsageExpiry \/ Deadline \/ StreamFailure
        \/ (\E result \in {"ok", "failed", "stalled"} : Report(result)) \/ ReportDeadline \/ Save
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"reading", "stopped", "settled", "failed"}
          /\ candidate \in {"none", "encoded", "explicit"} /\ expected \in {"none", "encoded", "explicit"}
          /\ saved \in {Pending} \cup [signature : {"none", "encoded", "explicit", "replacement"}, origin : {"producer", "replacement"}]
          /\ complete \in BOOLEAN /\ expired \in BOOLEAN /\ current \in {"producer", "replacement"}
          /\ toolObserved \in BOOLEAN /\ reportAttempts \in 0..3
          /\ reporting \in {"pending", "ok", "failed", "stalled"} /\ retries \in 0..1
SavedSignatureFinal == saved # Pending => complete /\ saved.signature = expected
SavedFromProducingHandler == saved # Pending => saved.origin = "producer"
NoExpiredSignatureWait == expired => phase # "stopped"
ReportingBounded == reportAttempts <= 2
ToolTurnNotRetried == toolObserved => retries = 0
CompletedTurnNotRetried == complete => retries = 0 /\ phase # "failed"
====
