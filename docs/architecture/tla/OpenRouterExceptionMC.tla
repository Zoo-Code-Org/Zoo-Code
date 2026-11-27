---- MODULE OpenRouterExceptionMC ----
EXTENDS OpenRouterException
MCInputs == {[code |-> code, raw |-> raw] :
    code \in {"none", "400", "429", "500"}, raw \in {"failure", "429 quota exceeded", "maximum context length exceeded"}}
Prefix(value) == <<value.code, value.raw>>
Wrapped(value) == [id |-> "original", status |-> value.code,
                   message |-> IF value.code = "none" THEN <<value.raw>> ELSE Prefix(value)]
AlwaysPrefixed(value) == [Wrapped(value) EXCEPT !.message = Prefix(value)]
NoStatus(value) == [Wrapped(value) EXCEPT !.status = "none"]
\* The context classifier is an oracle at the provider boundary. Runtime tests call the real classifier.
MCContextRoute(status, raw) == status = "400" /\ raw = "maximum context length exceeded"
Original(error) == error
Copied(error) == [error EXCEPT !.id = "copy"]
====
