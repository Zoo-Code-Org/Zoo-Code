---- MODULE OpenRouterException ----
\* Source: OpenRouterHandler.handleStreamingError. Sinks: captureException, caller rejection, and the context classifier.
\* Failures: the thrown instance differs, status is lost, an uncoded message gains a prefix, or context routing changes.
\* SameInstance, CallerStatus, UncodedMessage, and ContextRouting check these boundaries. Parsing remains an oracle.
\* PR #2330 supplied review item 1 adds a 400 context-length input and the downstream classifier boundary.
\* Item 5 concerns PR wording. All review totals appear once in ExceptionCapture. There are no supplied thread URLs.
\* Expectation: losing status must fail ContextRouting. The real classifier must accept 400 context-length errors only.
\* The check covers errors seen on the first stream read. It does not model Task retries or stream cancellation.
\* Prior review additions: same captured instance, caller status, and uncoded messages. Prior replay caught all three defects.
\* Tests: openrouter.spec.ts checks the real provider and classifier with both accept and reject inputs.
\* Earlier context-routing round: all 24 fixed states pass. All four sabotage configs fail.
\* ContextStatus checks ContextRouting alone.
\* Replay: removing status fails the 400 context-length case. Both reject cases still pass. Restored code passes all three.
\* Cost is included once in ExceptionCapture. No unexpected runtime defect or false counterexample was found.
\* TLC checks the boundary model, not implementation correctness.
\* PR #2330 body-preservation review: expect missing body to fail ErrorBody and RawTelemetryMessage.
\* Source: stream chunk.error. Sinks: caller error.error and getErrorMessage(error). ReadMessage is an oracle.
\* Failure: the thrown error loses the chunk body or the raw telemetry message. Both invariants are review additions.
\* Earlier round: 0 covered, 3 added, 1 gap. Cost was shared with ExceptionCapture (about 10 minutes).
\* Earlier body-preservation round: 24 fixed states pass. NoBody fails ErrorBody; RawMessage fails RawTelemetryMessage.
\* That round's six sabotage configs fail. Removing the body fails four runtime cases and both numeric-code message checks.
\* Simplification: the body reuses the input record. It adds no independent state or parser implementation.
\* Message extraction cleanup: expect all six boundary invariants to hold after removing two temporary variables.
\* Parsing remains an oracle. The existing provider table checks the real extraction path before and after the cleanup.
\* Earlier cleanup round: 51 provider tests pass; 24 fixed states pass; all six sabotage configs fail as expected.
\* Cleanup cost: one agent, about 2 minutes including source checks and validation. Null result: no new defect found.
\* Raw-priority review expectation: distinct outer and upstream text must expose a missing metadata.raw lookup.
\* The input body now has distinct outer text. Plain-text raw also becomes the uncoded caller message.
\* Raw-priority ratchet: 0 covered, 1 added input rule, 0 gaps. RawPriority fails RawTelemetryMessage in 16 states.
\* Replay: removing the metadata.raw lookup fails both coded priority cases. The uncoded priority case still passes.
\* Current result: 54 provider tests and 24 model states pass. All seven sabotage configs fail as expected.
\* Cost: one agent, about 3 minutes for distinct inputs, tests, replay, and checks. No new runtime defect found.
EXTENDS Naturals, Sequences
CONSTANTS Inputs, Wrap(_), Throw(_), ContextRoute(_, _), ReadMessage(_)
VARIABLES input, captured, thrown
vars == <<input, captured, thrown>>
Init == /\ input \in Inputs /\ captured = [id |-> "none", status |-> "none", message |-> "none", body |-> [code |-> "none", raw |-> "none", outer |-> "none"]]
        /\ thrown = captured
Capture == /\ captured.id = "none"
           /\ captured' = Wrap(input) /\ thrown' = Throw(Wrap(input)) /\ UNCHANGED input
Spec == Init /\ [][Capture]_vars
SameInstance == captured.id # "none" => thrown = captured
CallerStatus == captured.id # "none" => thrown.status = input.code
UncodedMessage == captured.id # "none" /\ input.code = "none" => captured.message = <<input.raw>>
\* PR #2330: status must preserve the downstream context-routing decision.
ContextRouting == captured.id # "none" =>
    ContextRoute(thrown.status, input.raw) = ContextRoute(input.code, input.raw)
ErrorBody == captured.id # "none" => thrown.body = input
RawTelemetryMessage == captured.id # "none" /\ input.code # "none" => ReadMessage(thrown) = <<input.raw>>
====
