---- MODULE ExceptionCopyMC ----
\* Finite source records and copy transforms for ExceptionCopy. The two broken transforms are sabotage checks.
EXTENDS ExceptionCopy

MCNames == {"Error", "TypeError", "RangeError", "AggregateError"}
MCMessages == {"wrapped", "raw"}
MCInputs == { [proto |-> kind,
               own |-> [message |-> message, stack |-> "source stack", cause |-> "cause reference",
                        writable |-> writable, children |-> IF kind = "AggregateError" THEN <<"child reference">> ELSE <<>>]] :
               kind \in MCNames, message \in MCMessages, writable \in BOOLEAN }
Normalized(error, message) == [error EXCEPT !.own.message = message]
Detached(error, message) == [sent |-> TRUE, caller |-> error, payload |-> Normalized(error, message)]
Mutating(error, message) == [sent |-> TRUE, caller |-> Normalized(error, message), payload |-> Normalized(error, message)]
PlainCopy(error, message) == [sent |-> TRUE, caller |-> error, payload |-> [Normalized(error, message) EXCEPT !.proto = "Error"]]

\* PR #2330 frozen-message review: assignment to a frozen message drops the payload.
Assignment(error, message) == [Detached(error, message) EXCEPT !.sent = error.own.writable]
====
