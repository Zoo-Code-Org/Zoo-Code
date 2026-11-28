---- MODULE AbortBridge ----
\* Subsystem: bridgeExternalAbortSignal in src/api/providers/utils/abort-signal.ts.
\* Source: the caller's external signal plus one optional onAbort hook. Sinks: the
\* dispose handle handed to the caller, and the per-request controller a provider
\* keeps as its stop-button handle.
\* Modeled: the two abort paths (already-aborted at call time, abort during the
\* request), the detach performed by dispose, and one hook that may throw.
\* Oracle: the hook body and the reason value. No provider code is copied here.
\*
\* EXPECTED (written before the run, per the trial policy): TLC will find an
\* interleaving on the already-aborted path where the hook runs before the
\* controller aborts, because only statement order prevents it, and it will find
\* that a throwing hook removes the dispose handle on that path while the live
\* path keeps it. I do NOT expect a hook that runs twice: the code invokes the hook
\* from one place per path, so a double run has to come from a new interleaving.
\*
\* Failure 1: a hook that throws on the already-aborted path escapes the call, so
\* the caller never receives dispose and cannot detach what it was never handed.
\* Failure 2: the hook runs before the controller aborts, so a hook that inspects
\* the request signal sees a request that has not been cancelled yet.
\* Failure 3: a hook that throws before the controller aborts swallows the abort:
\* the caller believes it cancelled the request and the signal never settles.
\* Failure 4: the hook runs twice for one cancellation, so a provider side effect
\* (abort a client, cancel a token source) fires twice for one stop.
\* Failure 5: dispose does not detach, so a later external abort still reaches this
\* request after the caller cleaned up.
\*
\* Invariant CallerHasDispose is the opposite of Failure 1: the call returns, so the
\* caller holds dispose, whatever the hook did.
\* Invariant HookSeesAbortFirst is the opposite of Failure 2: whenever the hook ran,
\* the request controller was already aborted at that moment.
\* Invariant AbortNotLost is the opposite of Failure 3: while the caller still
\* expects the relay, an external abort leaves the request controller aborted.
\* Invariant HookAtMostOnce is the opposite of Failure 4.
\* Invariant NoAbortAfterDispose is the opposite of Failure 5: once dispose ran, no
\* later external abort reaches the request.
\* Invariants NoHookWithoutExternal and ReturnedIsSupplied are the opposite of a
\* broken controller-only branch: with no external signal the hook never runs and
\* the caller's own controller comes back.
\*
\* Variants:
\* Fixed is the guarded code: a hook error is reported, not propagated.
\* Unfixed is the code before the guard on the already-aborted path: the throw
\* escapes, so CallerHasDispose must fail here.
\* NotifyFirst runs the hook before controller.abort(): HookSeesAbortFirst must fail.
\* SwallowAbort runs the hook first and drops its error: AbortNotLost must fail.
\* DoubleRun runs the hook twice for one cancellation: HookAtMostOnce must fail.
\* DetachSkipped returns a dispose that never removes the listener:
\* NoAbortAfterDispose must fail.
\*
\* FOUND (read off the gate output, written after the run):
\* Fixed violates none of the seven invariants over 48 distinct states.
\* Unfixed violates CallerHasDispose on the already-aborted path with a throwing
\* hook, over 22 states: the call does not return, so the caller never holds
\* dispose. On the live path that same variant keeps dispose, which is the
\* asymmetry the review comment described.
\* NotifyFirst violates HookSeesAbortFirst over 21 states: nothing in the structure
\* forces controller.abort() before the hook; only the statement order does.
\* SwallowAbort violates HookSeesAbortFirst and AbortNotLost over 21 states: an early
\* hook error drops the controller abort as well, so the caller believes it stopped
\* a request that never settled.
\* DoubleRun violates HookAtMostOnce over 29 states; DetachSkipped violates
\* NoAbortAfterDispose over 42 states. Both are injected, not found: the guarded
\* model produced no behavior that runs the hook twice and no behavior that leaves
\* the listener attached after dispose. That is a null result, recorded as data.
\* AbortNotLost holds in Fixed: with the guard, a hook error cannot swallow the abort.
\*
\* Invariant provenance, declared: the seven invariants were written from the four
\* inline findings and the two failure paths, after the guard was implemented, not
\* before. They state the failure, not the guard: only Variant selects the guard.
\*
\* Cost (caliber declared before the run and applied to the same run): wall clock is
\* the start/stop stamps around the six java invocations: 5.141030673 s total, one
\* invocation per config, six configs. States explored per config are printed above.
\* Host that ran the gate: WSL bash + WSL java (openjdk 21.0.13.1) + tlc2.TLC 2.19 of
\* 08 August 2024 (rev 5a47802) from /mnt/c/tools/tla2tools.jar (2274532 bytes).
\* Runner note: check.sh is absent at this base, so the gate ran the same java command
\* line and the same two decision strings that check.sh uses, and additionally pinned
\* which invariant each sabotage variant must fail (a variant that fails for an
\* unrelated reason is not a sabotage check). See evidence/abortbridge-tlc-run.sh.
\* Review: PR 2626 round 2 (edelauna), four inline findings: 4690260914 (should the
\* bridge catch an onAbort error), 4690260919 (tests for a throwing hook on both
\* paths), 4690260925 (record the request signal inside the hook), 4690260930
\* (controller-only branch). Covered 4, added 0, gap 0: each finding maps to one
\* invariant and one focused test in abort-signal.spec.ts.

EXTENDS Naturals, TLC
CONSTANT Variant
VARIABLES scenario, supplied, hookOutcome, externalAborted, ctrlAborted,
          attached, returned, hookRan, hookSawAborted, returnedController,
          disposeCalled, abortAfterDispose

vars == <<scenario, supplied, hookOutcome, externalAborted, ctrlAborted,
              attached, returned, hookRan, hookSawAborted, returnedController,
              disposeCalled, abortAfterDispose>>

Scenarios == {"None", "Live", "PreAborted"}
Supplied == {"Mine", "Provided"}
Outcomes == {"Ok", "Throws"}

\* HookEarly is the sabotaged order; HookEscapes is a hook error the code lets
\* destroy the call instead of reporting it.
HookEarly == Variant = "NotifyFirst" \/ Variant = "SwallowAbort"
HookEscapes == hookOutcome = "Throws" /\ (Variant = "Unfixed" \/ Variant = "SwallowAbort")

Init ==
    /\ scenario \in Scenarios
    /\ supplied \in Supplied
    /\ hookOutcome \in Outcomes
    /\ externalAborted = (scenario = "PreAborted")
    /\ ctrlAborted = FALSE
    /\ attached = FALSE
    /\ returned = FALSE
    /\ hookRan = 0
    /\ hookSawAborted = FALSE
    /\ returnedController = "None"
    /\ disposeCalled = FALSE
    /\ abortAfterDispose = FALSE

\* The call itself. On the already-aborted path the code aborts the controller first
\* and then runs the hook; the live path attaches a once-listener and returns at
\* once, so the caller already holds dispose before any hook on that path can run.
CallBridge ==
    /\ returned = FALSE
    /\ returnedController' = supplied
    /\ IF scenario = "None"
        THEN /\ returned' = TRUE
              /\ attached' = FALSE
              /\ ctrlAborted' = FALSE
              /\ hookRan' = 0
              /\ hookSawAborted' = FALSE
        ELSE IF scenario = "PreAborted"
             THEN /\ IF HookEarly
                   THEN /\ attached' = FALSE
                        /\ hookRan' = hookRan + 1
                        /\ hookSawAborted' = ctrlAborted
                        /\ ctrlAborted' = (IF HookEscapes THEN ctrlAborted ELSE TRUE)
                        /\ returned' = (IF HookEscapes THEN FALSE ELSE TRUE)
                   ELSE /\ ctrlAborted' = TRUE
                        /\ attached' = FALSE
                        /\ hookRan' = hookRan + 1
                        /\ hookSawAborted' = TRUE
                        /\ returned' = (IF HookEscapes THEN FALSE ELSE TRUE)
             ELSE /\ returned' = TRUE
                   /\ attached' = TRUE
                   /\ ctrlAborted' = FALSE
                   /\ hookRan' = 0
                   /\ hookSawAborted' = FALSE

\* The external signal aborts. A still-attached once-listener aborts the controller
\* and runs the hook; after a real detach the same abort reaches nothing at all.
ExternalAbort ==
    /\ scenario # "None"
    /\ ~externalAborted
    /\ externalAborted' = TRUE
    /\ IF attached
        THEN /\ ctrlAborted' = TRUE
              /\ hookRan' = hookRan + (IF Variant = "DoubleRun" THEN 2 ELSE 1)
              /\ hookSawAborted' = (IF Variant = "NotifyFirst" THEN FALSE ELSE TRUE)
              /\ attached' = FALSE
              /\ abortAfterDispose' = disposeCalled
        ELSE /\ UNCHANGED <<ctrlAborted, hookRan, hookSawAborted, attached>>
              /\ abortAfterDispose' = FALSE

\* The caller ends the request and uses the handle it was handed.
Dispose ==
    /\ returned = TRUE
    /\ ~disposeCalled
    /\ disposeCalled' = TRUE
    /\ attached' = (IF Variant = "DetachSkipped" THEN attached ELSE FALSE)

\* TLC requires every variable to be decided in each step, so each action states the
\* ones it deliberately leaves alone instead of leaving them open.
CallBridgeStable ==
    CallBridge /\ UNCHANGED <<scenario, supplied, hookOutcome, externalAborted,
                        disposeCalled, abortAfterDispose>>

ExternalAbortStable ==
    ExternalAbort /\ UNCHANGED <<scenario, supplied, hookOutcome, returned,
                         returnedController, disposeCalled>>

DisposeStable ==
    Dispose /\ UNCHANGED <<scenario, supplied, hookOutcome, externalAborted,
                     ctrlAborted, returned, hookRan, hookSawAborted,
                     returnedController, abortAfterDispose>>

\* Nothing. Once the caller disposed and no further abort arrives, nothing is left to do,\* so the model lets the behavior stop instead of reporting a dead end.
Nothing == UNCHANGED(vars)

Next ==
    /\ IF returned = FALSE
        THEN CallBridgeStable
        ELSE ExternalAbortStable \/ DisposeStable \/ Nothing

Spec == Init /\ [][Next]_vars

\* returnedController is still "None" exactly while the call has not happened yet,
\* so the invariant does not claim a caller holds a handle it was never given.
CallerHasDispose == IF returnedController = "None" THEN TRUE ELSE returned

HookSeesAbortFirst == hookRan = 0 \/ hookSawAborted

\* Precondition first (the same rule the other three invariants need): before the call
\* exists there is no relay for an abort to travel along, and after dispose the caller no
\* longer expects one.
AbortNotLost ==
    IF returnedController = "None" THEN TRUE
    ELSE IF disposeCalled THEN TRUE
         ELSE ~externalAborted \/ ctrlAborted

HookAtMostOnce == hookRan <= 1

NoAbortAfterDispose == ~(disposeCalled /\ abortAfterDispose)

NoHookWithoutExternal == scenario # "None" \/ hookRan = 0

\* Same precondition as CallerHasDispose: before the call there is no returned handle to compare.
ReturnedIsSupplied ==
    IF returnedController = "None"
    THEN TRUE
    ELSE returnedController = supplied

====
