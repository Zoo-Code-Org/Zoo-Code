---- MODULE ExceptionCopyMC ----
\* Finite source records and copy transforms for ExceptionCopy. The two broken transforms are sabotage checks.
EXTENDS ExceptionCopy

MCNames == {"Error", "TypeError", "RangeError", "AggregateError"}
MCMessages == {"wrapped", "raw"}
MCInputs == { [proto |-> kind,
               own |-> [message |-> message, stack |-> "source stack", cause |-> "cause reference",
                        children |-> IF kind = "AggregateError" THEN <<"child reference">> ELSE <<>>]] :
               kind \in MCNames, message \in MCMessages }
Normalized(error, message) == [error EXCEPT !.own.message = message]
Detached(error, message) == [caller |-> error, payload |-> Normalized(error, message)]
Mutating(error, message) == [caller |-> Normalized(error, message), payload |-> Normalized(error, message)]
PlainCopy(error, message) == [caller |-> error, payload |-> [Normalized(error, message) EXCEPT !.proto = "Error"]]
====
