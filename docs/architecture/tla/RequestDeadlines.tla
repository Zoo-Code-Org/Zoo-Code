---- MODULE RequestDeadlines ----
(***************************************************************************)
(* Sources: createRequestDeadlineFetchOptions and createIdleDeadline       *)
(* Dispatcher in api/providers/utils/request-deadlines.ts.                 *)
(* Sinks: the fetch init the OpenAI client hands to undici                 *)
(* (ClientOptions.fetchOptions.dispatcher with headersTimeout and          *)
(* bodyTimeout).                                                           *)
(* Oracles: getApiRequestTimeout (the budget) and isProxyEnabled (the      *)
(* proxy guard). The spec models both as constants.                        *)
(*                                                                         *)
(* Failure: a request that waits longer than 300 s for headers or body     *)
(* data dies with "TypeError: terminated" because undici keeps hidden      *)
(* idle deadlines while the SDK timeout is larger (issue 1407).            *)
(* Rule: SaneBudgetWiresDispatcher.                                        *)
(*                                                                         *)
(* Failure: a wired dispatcher still kills a long wait because its         *)
(* deadlines are a hard-coded 300000 instead of the configured budget.     *)
(* Rule: DispatcherMatchesBudget.                                          *)
(*                                                                         *)
(* Failure: the debug proxy loses traffic because an explicit dispatcher   *)
(* bypasses the global proxy dispatcher.                                   *)
(* Rule: ProxyActiveMeansPlainInit.                                        *)
(*                                                                         *)
(* Failure: a non-positive budget wires a dispatcher, and undici reads a   *)
(* zero deadline as "no deadline", so a broken setting hangs forever.      *)
(* Rule: InvalidBudgetMeansPlainInit.                                      *)
(*                                                                         *)
(* Budget is an integer here. A non-finite budget (NaN, Infinity) is not   *)
(* in the integer domain; the code rejects it with the same guard as a     *)
(* non-positive one, so the integer domain models the reachable behavior.  *)
(*                                                                         *)
(* Expectation before the run: the model finds nothing in the fixed        *)
(* wiring; the sabotage configs must each fail exactly their named rule.   *)
(*                                                                         *)
(* Result: base config passes with 1 distinct state. Unfixed fails         *)
(* SaneBudgetWiresDispatcher. Hardcoded fails DispatcherMatchesBudget.     *)
(* NoProxyGuard fails ProxyActiveMeansPlainInit. NoValidation fails        *)
(* InvalidBudgetMeansPlainInit. Null result on the fixed wiring: no        *)
(* additional defect found by the model.                                   *)
(*                                                                         *)
(* Cost: about 25 agent minutes for the spec and the five TLC runs.        *)
(*                                                                         *)
(* Gate: PATH=~/Projects/.tla/jre/bin:$PATH TLA_JAR=~/Projects/.tla/       *)
(* tla2tools.jar ./check.sh RequestDeadlines                               *)
(* Unit gate: request-deadlines.spec.ts, client-deadline-wiring.spec.ts,   *)
(* openai-transport-deadline.spec.ts.                                      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    \* the request budget in ms (getApiRequestTimeout)
    Budget,
    \* the debug proxy guard (isProxyEnabled)
    ProxyActive

NoDispatcher == [dispatcher |-> FALSE, headersTimeout |-> 0, bodyTimeout |-> 0]

DispatcherAt(ms) == [dispatcher |-> TRUE, headersTimeout |-> ms, bodyTimeout |-> ms]

ValidBudget(b) == b > 0

\* The fixed wiring, as request-deadlines.ts implements it.
ConcreteGate(b) ==
    IF ProxyActive
    THEN NoDispatcher
    ELSE IF ValidBudget(b)
         THEN DispatcherAt(b)
         ELSE NoDispatcher

\* Sabotage: the transport keeps its hidden 300 s defaults (pre-fix code).
NoGate(b) == NoDispatcher

\* Sabotage: a dispatcher is wired, but its deadlines are hard-coded.
HardcodedGate(b) ==
    IF ProxyActive
    THEN NoDispatcher
    ELSE IF ValidBudget(b)
         THEN DispatcherAt(300000)
         ELSE NoDispatcher

\* Sabotage: the proxy guard is dropped, so the dispatcher bypasses it.
NoProxyGuardGate(b) ==
    IF ValidBudget(b)
    THEN DispatcherAt(b)
    ELSE NoDispatcher

\* Sabotage: the budget validation is dropped, so zero disables undici's
\* idle deadlines entirely and a negative one is garbage in the init.
NoValidationGate(b) ==
    IF ProxyActive
    THEN NoDispatcher
    ELSE DispatcherAt(b)

\* DeadlineGate is substituted per config: ConcreteGate here, a sabotage
\* operator in each variant config.
DeadlineGate(b) == ConcreteGate(b)

VARIABLES wired

Init == wired = DeadlineGate(Budget)

Next == UNCHANGED wired

Spec == Init /\ [][Next]_wired

\* A wired dispatcher follows the configured budget, never a constant.
DispatcherMatchesBudget ==
    wired.dispatcher => (wired.headersTimeout = Budget /\ wired.bodyTimeout = Budget)

\* While the debug proxy is active, no dispatcher rides the request.
ProxyActiveMeansPlainInit ==
    ProxyActive => ~wired.dispatcher

\* A sane budget under no proxy wires the dispatcher (the fix engages).
SaneBudgetWiresDispatcher ==
    (~ProxyActive /\ ValidBudget(Budget)) => wired.dispatcher

\* A broken budget wires nothing, so undici keeps its platform defaults
\* instead of reading a zero deadline as "no deadline".
InvalidBudgetMeansPlainInit ==
    (~ValidBudget(Budget)) => ~wired.dispatcher

====
