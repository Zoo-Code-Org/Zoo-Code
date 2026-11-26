---- MODULE OpenRouterException ----
\* Current round: 0 covered, 3 added, 1 gap. Item 8 concerns PR text and has no runtime model.
\* Result: fixed model holds in 12 states. Copied fails SameInstance; Prefixed fails UncodedMessage; NoStatus fails CallerStatus.
\* Replay: a fresh thrown Error, lost status, and an unconditional prefix all fail the four-case real provider test.
\* Cost: shared with ExceptionCapture. No new bug beyond the review. The status change is now explicit.
\* A message tuple abstracts the optional prefix. No parser or filter implementation is copied.
\* Source: OpenRouterHandler.handleStreamingError. Sinks: captureException and the caller rejection.
\* Review PR 2330 summary items 1, 2, and 4 has no thread URL. These are review additions.
\* Failures: the thrown instance differs, status is lost, or a prefix hides an uncoded rate limit.
\* Rules: SameInstance, CallerStatus, and UncodedMessage prevent those failures.
\* Expected: a copied error fails identity; an unconditional prefix fails message preservation.
\* Message parsing and client filtering are outside this boundary. The raw message is an input oracle.
\* Tests: openrouter.spec.ts checks identity, status, class name, and messages over four inputs.
\* TLC checks this boundary model, not code correctness.
EXTENDS Naturals, Sequences
CONSTANTS Inputs, Wrap(_), Throw(_)
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
====
