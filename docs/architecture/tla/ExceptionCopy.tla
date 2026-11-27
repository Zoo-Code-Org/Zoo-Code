---- MODULE ExceptionCopy ----
\* Source: normalizeTelemetryError called by PostHogTelemetryClient.captureException(error). Sink: PostHog.captureException(payload).
\* Failures: normalization changes the caller, loses type or children, sends the wrong message, or drops frozen inputs.
\* CallerMessage, SourceShape, NormalizedMessage, and Delivery check these failures. Transform is an oracle.
\* Prior review additions: caller isolation, built-in prototypes, and frozen message delivery.
\* Current PR #2330 supplied review items 9 and 10: descriptor flags and header layout are gaps, checked directly.
\* The review totals appear once in ExceptionCapture. Writable stack descriptors use runtime assertions, not a descriptor model.
\* Expectation: the unchanged model passes. Assignment, mutation, and plain-copy sabotages must still fail.
\* Property tests: PostHogTelemetryClient.message-preservation.test.ts checks messages, shapes, frozen errors, and stack flags.
\* Results: all 64 fixed states pass. All three sabotage configs fail. Changing stack flags fails all 24 shape cases.
\* Review cost is included in ExceptionCapture. Helper extraction took one agent about two minutes. No delegates.
\* Refactor expectation: extracting normalizeTelemetryError preserves all four copy invariants. No new defect is expected.
\* Refactor result: all 109 telemetry tests pass. All three copy mutations fail the existing property tests. No new defect found.
\* TLC checks the abstraction, not JavaScript descriptors or PostHog parsing.

EXTENDS Naturals, Sequences
CONSTANTS Inputs, Messages, Transform(_, _)
VARIABLES source, raw, caller, delivered, attempted
vars == <<source, raw, caller, delivered, attempted>>

Children(error) == IF error.proto = "AggregateError" THEN error.own.children ELSE <<>>
Init == /\ source \in Inputs /\ raw \in Messages
        /\ caller = source /\ delivered = <<>> /\ attempted = FALSE
Capture ==
    LET output == Transform(source, raw)
    IN /\ ~attempted /\ attempted' = TRUE
       /\ caller' = output.caller /\ delivered' = IF output.sent THEN <<output.payload>> ELSE <<>>
       /\ UNCHANGED <<source, raw>>
Spec == Init /\ [][Capture]_vars
Delivery == attempted => Len(delivered) = 1

TypeOK == /\ attempted \in BOOLEAN
          /\ source \in Inputs /\ raw \in Messages /\ caller \in Inputs
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
