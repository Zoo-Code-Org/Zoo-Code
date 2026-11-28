---- MODULE OpenRouterExceptionMC ----
EXTENDS OpenRouterException
MCInputs == {[code |-> code, raw |-> raw, outer |-> "outer failure"] :
    code \in {"none", "400", "429", "500"}, raw \in {"failure", "429 quota exceeded", "maximum context length exceeded"}}
Prefix(value) == <<value.code, value.raw>>
Wrapped(value) == [id |-> "original", status |-> value.code,
                   body |-> value, message |-> IF value.code = "none" THEN <<value.raw>> ELSE Prefix(value)]
AlwaysPrefixed(value) == [Wrapped(value) EXCEPT !.message = Prefix(value)]
NoStatus(value) == [Wrapped(value) EXCEPT !.status = "none"]
\* The context classifier is an oracle at the provider boundary. Runtime tests call the real classifier.
MCContextRoute(status, raw) == status = "400" /\ raw = "maximum context length exceeded"
\* This finite oracle represents metadata.raw selection. Runtime tests call the real getErrorMessage.
MCReadMessage(error) == IF error.status # "none" /\ error.body.raw # "none"
                        THEN <<error.body.raw>> ELSE error.message
\* Omitting metadata.raw selects the outer message for coded errors.
WithoutRaw(error) == IF error.status # "none" THEN <<error.body.outer>> ELSE error.message
NoBody(value) == [Wrapped(value) EXCEPT !.body = [code |-> "none", raw |-> "none", outer |-> "none"]]
Original(error) == error
Copied(error) == [error EXCEPT !.id = "copy"]
====
