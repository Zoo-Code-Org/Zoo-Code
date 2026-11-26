---- MODULE RestoreProfileDecisionMC ----
\* Model-checking settings for RestoreProfileDecision.
EXTENDS RestoreProfileDecision

\* Sabotage: the stale-pin guard is removed. The pin is always re-activated when it
\* exists (the pre-fix behavior) and the pin is never refreshed.
DecideAlwaysPin(inp) ==
    IF inp.pin = "absent" THEN [r |-> NoProfile, f |-> Keep]
    ELSE IF inp.pinExists THEN [r |-> inp.pin, f |-> Keep]
    ELSE [r |-> NoProfile, f |-> Keep]

====
