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
\* Results: all 24 fixed states pass. All four sabotage configs fail. ContextStatus checks ContextRouting alone.
\* Replay: removing status fails the 400 context-length case. Both reject cases still pass. Restored code passes all three.
\* Cost is included once in ExceptionCapture. No unexpected runtime defect or false counterexample was found.
\* TLC checks the boundary model, not implementation correctness.
EXTENDS Naturals, Sequences
CONSTANTS Inputs, Wrap(_), Throw(_), ContextRoute(_, _)
VARIABLES input, captured, thrown
vars == <<input, captured, thrown>>
Init == /\ input \in Inputs /\ captured = [id |-> "none", status |-> "none", message |-> "none"]
        /\ thrown = captured
Capture == /\ captured.id = "none"
           /\ captured' = Wrap(input) /\ thrown' = Throw(Wrap(input)) /\ UNCHANGED input
Spec == Init /\ [][Capture]_vars
SameInstance == captured.id # "none" => thrown = captured
CallerStatus == captured.id # "none" => thrown.status = input.code
UncodedMessage == captured.id # "none" /\ input.code = "none" => captured.message = <<input.raw>>
\* PR #2330, supplied review item 1: status must preserve the downstream context-routing decision.
ContextRouting == captured.id # "none" =>
    ContextRoute(thrown.status, input.raw) = ContextRoute(input.code, input.raw)
====
