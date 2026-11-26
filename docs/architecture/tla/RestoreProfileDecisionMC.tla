---- MODULE RestoreProfileDecisionMC ----
\* Model-checking settings for RestoreProfileDecision.
EXTENDS RestoreProfileDecision

\* Sabotage: the stale-pin guard is removed. The pin is always re-activated when it
\* exists (the pre-fix behavior) and the pin is never refreshed.
DecideAlwaysPin(inp) ==
    IF inp.pin = "absent" THEN [r |-> NoProfile, f |-> Keep]
    ELSE IF inp.pinExists THEN [r |-> inp.pin, f |-> Keep]
    ELSE [r |-> NoProfile, f |-> Keep]

\* Sabotage: the refresh write aliases the store-cached record (the restore mutates
\* the cached item in place before updateTaskHistory), so the store's delta compare
\* drops apiConfigName and the stale pin survives on disk. RefreshPersists must fail.
ValidAliased(inp) == (inp.pin = "absent") => (~inp.pinExists)

\* Sabotage: the restore aborts when the refresh write rejects (the un-caught await
\* before the Task constructor). WriteFailureRestores must fail.
ProceedAbort(dec, inp) == (dec.f = Keep) \/ inp.pinWriteOk

====
