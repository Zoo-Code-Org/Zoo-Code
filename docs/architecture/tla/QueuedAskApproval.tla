---- MODULE QueuedAskApproval ----
\* Models the queued-message drain of Task.ask in src/core/task/Task.ts.
\* Source: a user message in the queue (MessageQueueService) and the ask type (ClineAsk).
\* Sink: handleWebviewAskResponse, reached via handleQueuedAskResponse (the drain) and approveAsk (a user click).
\* Failure (#1574): a queued message answers a command ask with yesButtonClicked, so a command the policy did not approve runs without a user click.
\* Invariant: NoQueueApprovalWithoutPolicy and NoQueueApprovalWithoutFreshPolicy.
\* A command ask that the queue resolved requires the ask-time policy approve and the consume-site re-check approve.
\* Tool and use_mcp_server asks keep their existing queued approve-with-feedback semantics; the model pins them as allowed, so the invariants are scoped to command asks. Widening the gate to those types is a maintainer decision (PR for #1574).
\* Phases: pending -> armed -> decided. Generic queued text has no transition into decided for a command ask the policy did not approve.
\* Variants are in QueuedAskApprovalMC.tla. Unfixed is the pre-fix logic. NoAskTimeGate and NoRecheck each leave out one gate conjunct.
\* Expect before the run: Unfixed violates NoQueueApprovalWithoutPolicy with the #1574 counterexample: a command ask, no policy approve, resolved by the queue.
\* Result: filled in after each run. See the end of this header.
\* Replay: the Unfixed counterexample matches the issue repro: a queued "don't do that" approves an unallowlisted command.
\* Tests: src/core/task/__tests__/ask-queued-message-drain.spec.ts and ask-auto-deny.spec.ts pin the pending contract and the preserved approve-with-feedback consume.
\* Not modeled: the queue service, the per-turn latch, timeouts, denial detail, supersession. The policy decisions are oracles; TLC tries both values.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Result (pre-fix code): base holds in 138 states. Unfixed and NoAskTimeGate violate NoQueueApprovalWithoutPolicy. NoRecheck violates NoQueueApprovalWithoutFreshPolicy.
\* Result (fixed code): filled in after the fix run on the fix commit.

EXTENDS Naturals

AskTypes == {"command", "tool", "mcp", "other"}   \* mcp is use_mcp_server

VARIABLES
    askType,          \* the ClineAsk type of the pending ask
    queued,           \* TRUE when a user message sits in the queue
    askTimeApproves,  \* ask-time checkAutoApproval decision (oracle)
    freshApproves,    \* consume-site re-check decision under fresh state (oracle)
    phase,            \* pending, armed, decided
    decidedBy         \* none, policy, user, queue

vars == <<askType, queued, askTimeApproves, freshApproves, phase, decidedBy>>

Init ==
    /\ askType \in AskTypes
    /\ queued = FALSE
    /\ askTimeApproves \in BOOLEAN
    /\ freshApproves \in BOOLEAN
    /\ phase = "pending"
    /\ decidedBy = "none"

TypeOK ==
    /\ askType \in AskTypes
    /\ queued \in BOOLEAN
    /\ askTimeApproves \in BOOLEAN
    /\ freshApproves \in BOOLEAN
    /\ phase \in {"pending", "armed", "decided"}
    /\ decidedBy \in {"none", "policy", "user", "queue"}

\* The fixed gate (#1574): a queued message may stand in for a command
\* approval only when the ask-time policy approves that command and the
\* consume-site re-check re-approves it under fresh state. Tool, mcp and
\* other asks keep their existing queued-feedback semantics.
QueueMayApprove(t, a, f) == t # "command" \/ (a /\ f)

\* Source: the user sends a message while an ask is pending.
QueueArrive ==
    /\ ~queued
    /\ queued' = TRUE
    /\ UNCHANGED <<askType, askTimeApproves, freshApproves, phase, decidedBy>>

\* The ask row posts and the prompt waits for the user.
Arm ==
    /\ phase = "pending"
    /\ phase' = "armed"
    /\ UNCHANGED <<askType, queued, askTimeApproves, freshApproves, decidedBy>>

\* Sink: the ask-time policy approve resolves the ask without the queue.
PolicyApprove ==
    /\ phase # "decided"
    /\ askTimeApproves
    /\ phase' = "decided"
    /\ decidedBy' = "policy"
    /\ UNCHANGED <<askType, queued, askTimeApproves, freshApproves>>

\* Sink: an explicit user click (approveAsk).
UserClick ==
    /\ phase # "decided"
    /\ phase' = "decided"
    /\ decidedBy' = "user"
    /\ UNCHANGED <<askType, queued, askTimeApproves, freshApproves>>

\* Sink: the drain consumes a claimed queued message as the ask response
\* (handleQueuedAskResponse -> handleWebviewAskResponse). The gate decides
\* whether the message may resolve this ask at all; blocked, the transition
\* does not exist and the message stays conversation input.
QueueResolve ==
    /\ queued
    /\ phase # "decided"
    /\ QueueMayApprove(askType, askTimeApproves, freshApproves)
    /\ phase' = "decided"
    /\ decidedBy' = "queue"
    /\ queued' = FALSE
    /\ UNCHANGED <<askType, askTimeApproves, freshApproves>>

Next ==
    QueueArrive \/ Arm \/ PolicyApprove \/ UserClick \/ QueueResolve

Spec == Init /\ [][Next]_vars

\* #1574: a queued message never approves a command ask the policy did not approve.
NoQueueApprovalWithoutPolicy ==
    (phase = "decided" /\ decidedBy = "queue") => (askType # "command" \/ askTimeApproves)

\* The consume-site re-check must re-approve under fresh state before the consume.
NoQueueApprovalWithoutFreshPolicy ==
    (phase = "decided" /\ decidedBy = "queue" /\ askType = "command") => freshApproves

====
