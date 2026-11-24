---- MODULE LmStudioRetry ----
\* Source: forceFullModelDetailsLoad reads preparationAttempts and serverVersions.
\* Sink: discovery starts, or preparation returns without a request.
\* Source: getLMStudioModels commits a catalog. Sink: it clears the preparation delay.
\* Failure: a completed attempt repeats too soon, a failure delays retry, or refresh keeps the delay.
\* Invariant RetryPolicy: the retry starts exactly when its delay has ended or its first attempt failed.
\* Invariant RefreshResets: a committed native catalog permits preparation after any earlier result.
\* PR 2170 review summary in chat: P2 added. P3 covered by the native refresh action.
\* Expected before run: Code holds. NoDelay, DelayFailure, IgnoreRefresh and StickyLegacy fail.
\* The first result and elapsed time are oracles. No HTTP parser or wall clock is copied here.
\* Replay: lmstudio.test.ts tests both sides of the deadline, failure retry and legacy upgrade.
\* Result: Code holds in 40 states. Each of the four sabotage configs fails its target invariant.
\* Replay: all four code mutations fail the focused runtime tests. No new bug or false alarm was found.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 5 minutes.
\* Simplification: one phase orders the calls. A two-value time oracle covers the delay boundary.
EXTENDS Naturals
CONSTANT Mode
VARIABLES phase, result, elapsed, delayed, native, requested
vars == <<phase, result, elapsed, delayed, native, requested>>

Init == /\ phase = "first"
        /\ result \in {"missing", "incomplete", "failure", "legacy"}
        /\ elapsed \in {29999, 30000}
        /\ delayed = FALSE /\ native = TRUE /\ requested = FALSE

Complete == /\ phase = "first"
            /\ delayed' = (result \in {"missing", "incomplete"}
                            \/ (Mode = "DelayFailure" /\ result = "failure"))
            /\ native' = (result # "legacy")
            /\ phase' = "retry"
            /\ UNCHANGED <<result, elapsed, requested>>

Retry == /\ phase = "retry"
         /\ requested' = (native /\ (Mode = "NoDelay" \/ ~delayed \/ elapsed >= 30000))
         /\ phase' = "refresh"
         /\ UNCHANGED <<result, elapsed, delayed, native>>

\* A native catalog commit clears attempts and replaces the remembered server version.
Refresh == /\ phase = "refresh"
           /\ delayed' = IF Mode = "IgnoreRefresh" THEN delayed ELSE FALSE
           /\ native' = IF Mode = "StickyLegacy" THEN native ELSE TRUE
           /\ phase' = "after"
           /\ UNCHANGED <<result, elapsed, requested>>

After == /\ phase = "after"
         /\ requested' = (native /\ (~delayed \/ elapsed >= 30000))
         /\ phase' = "done"
         /\ UNCHANGED <<result, elapsed, delayed, native>>
Next == Complete \/ Retry \/ Refresh \/ After
Spec == Init /\ [][Next]_vars
RetryPolicy == phase = "refresh" =>
    requested = (result # "legacy" /\ (result = "failure" \/ elapsed >= 30000))
RefreshResets == phase = "done" => requested
====
