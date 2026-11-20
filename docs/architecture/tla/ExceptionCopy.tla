---- MODULE ExceptionCopy ----
\* Source: PostHogTelemetryClient.captureException(error). Sink: PostHog.captureException(payload).
\* Failures: normalization changes the caller error, loses error type or children, or sends the wrong message.
\* Rules: CallerMessage, SourceShape, and NormalizedMessage compare source and delivered records directly.
\* The transform is an oracle. ExceptionCopyMC supplies fixed and broken transforms for the finite check.
\* Expected before simplification: fixed records pass; mutation and prototype loss each fail.
\* Review: PR 2330 discussion_r4486068932 added CallerMessage to the original combined model.
\* Review: PR 2330 discussion_r4638627894 added SourceShape after the copy lost built-in prototypes.
\* Review counts for this module: 0 covered, 2 added, 0 gap. Dedupe feedback is in ExceptionCapture.
\* Replay: the real client changed three caller messages before the detached-copy fix.
\* Replay: TypeError, RangeError, and AggregateError each lost their prototype for three test messages.
\* Property tests: PostHogTelemetryClient.message-preservation.test.ts checks messages, types, stacks, causes, and children.
\* proto represents the inherited error type. Only an AggregateError exposes children to the sink.
\* Fields stand for data or references. This model does not copy JavaScript descriptors or PostHog parsing.
\* Historical cost: about 2 minutes for the prototype-loss spec, replay, fix, and checks.
\* Result: ExceptionCopyMC holds in 32 states. Mutating fails CallerMessage; PlainCopy fails SourceShape.
\* Cost: included in ExceptionCapture. Each TLC run takes less than 2 seconds. No new production bug was found.
\* Removed caller and shape success flags. The invariants now inspect the actual transform output.
\* Guidance: https://lamport.azurewebsites.net/tla/book-02-02-27.pdf (Chapter 7).
\* TLC checks the model, not code correctness. Real-code tests provide the source-to-sink replay.

EXTENDS Naturals, Sequences
CONSTANTS Inputs, Messages, Transform(_, _)
VARIABLES source, raw, caller, delivered
vars == <<source, raw, caller, delivered>>

Children(error) == IF error.proto = "AggregateError" THEN error.own.children ELSE <<>>
Init == /\ source \in Inputs /\ raw \in Messages
        /\ caller = source /\ delivered = <<>>
Capture ==
    LET output == Transform(source, raw)
    IN /\ Len(delivered) = 0
       /\ caller' = output.caller /\ delivered' = <<output.payload>>
       /\ UNCHANGED <<source, raw>>
Spec == Init /\ [][Capture]_vars

TypeOK == /\ source \in Inputs /\ raw \in Messages /\ caller \in Inputs
          /\ delivered \in Seq([proto : {error.proto : error \in Inputs}, own : {error.own : error \in Inputs}])
          /\ Len(delivered) <= 1
CallerMessage == caller = source
SourceShape == Len(delivered) = 1 =>
    /\ delivered[1].proto = source.proto
    /\ delivered[1].own.stack = source.own.stack
    /\ delivered[1].own.cause = source.own.cause
    /\ Children(delivered[1]) = Children(source)
NormalizedMessage == Len(delivered) = 1 => delivered[1].own.message = raw
====
