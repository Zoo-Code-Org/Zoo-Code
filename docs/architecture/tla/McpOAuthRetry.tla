---- MODULE McpOAuthRetry ----
EXTENDS Naturals
\* Source: McpHub._initiateOAuthFlow receives a rejected saved token.
\* Sink: reconnectOAuthConnection sends another initialize request.
\* Failure: initialize success resets the bound before an authorized request succeeds.
\* Invariant: one unchanged token permits at most two automatic retries in this model.
\* Expect: fixed holds; ResetOnInitialize fails when stream authorization fails later.
\* Review ratchet: PR #2762 supplied findings #4, #14, #23, #24 and #25, added 5.
\* Cost: one agent, one bounded model and two sabotage configurations.
\* Result: fixed holds in 12 states. DiscoveryLoop fails at 9 states.
\* ResetOnInitialize fails at 13 states. The code retry regressions pass.
\* Finding #5: discovery retries require a prior skipped discovery, added 1.
CONSTANT ResetOnInitialize, GuardDiscovery
VARIABLES count, requests, initialized, skippedDiscovery, discoveryRetries
vars == <<count, requests, initialized, skippedDiscovery, discoveryRetries>>
Init == /\ count = 0 /\ requests = 0 /\ initialized = FALSE
        /\ skippedDiscovery = TRUE /\ discoveryRetries = 0
Reject ==
    /\ UNCHANGED <<skippedDiscovery, discoveryRetries>>
    /\ count < 2
    /\ requests < 3
    /\ count' = count + 1
    /\ requests' = requests + 1
    /\ initialized' = FALSE
Initialize ==
    /\ UNCHANGED <<skippedDiscovery, discoveryRetries>>
    /\ ~initialized
    /\ count' = IF ResetOnInitialize THEN 0 ELSE count
    /\ initialized' = TRUE
    /\ UNCHANGED requests
\* A changed access token starts a new retry budget.
NewToken == /\ count' = 0 /\ requests' = 0 /\ initialized' = FALSE
            /\ UNCHANGED <<skippedDiscovery, discoveryRetries>>
NoMetadata ==
    /\ (skippedDiscovery \/ ~GuardDiscovery)
    /\ discoveryRetries < 2
    /\ skippedDiscovery' = FALSE
    /\ discoveryRetries' = discoveryRetries + 1
    /\ UNCHANGED <<count, requests, initialized>>
DiscoveryBounded == discoveryRetries <= 1
Next == Reject \/ Initialize \/ NewToken \/ NoMetadata
Spec == Init /\ [][Next]_vars
Bounded == requests <= 2
====
