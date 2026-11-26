---- MODULE RestoreProfileDecision ----
\* Models src/core/webview/restore-provider-profile.ts resolveRestoreProfileActivation.
\* Source: HistoryItem.apiConfigName (the pin) and the currentApiConfigName global,
\* resolved against the profile list by ClineProvider.createTaskWithHistoryItemUnlocked.
\* Sink: the decision record (reactivateProfileName, refreshedApiConfigName) consumed by
\* the same method: reactivate calls activateProviderProfile, refresh rewrites the pin
\* through updateTaskHistory and the Task constructor.
\* Failure: restore re-activates a stale pinned profile, so the resumed task and the
\* task header keep the old provider's context window (issue #970).
\* Invariants (first version written before the fix):
\*   FollowActive. With an existing pin and a resolvable active profile different from
\*   it, the decision must not reactivate the pinned profile.
\*   PinNamesEffect. A refresh names exactly the active profile, and a reactivation
\*   never also refreshes.
\*   LegacyFallback. With no resolvable active profile, an existing pin is reactivated.
\* Run each config on RestoreProfileDecisionMC.tla. The MC module holds the sabotage.
\* Expected before the run: all invariants hold in the model; the sabotage run fails
\* FollowActive only.
\* Result: TypeOK, FollowActive, PinNamesEffect and LegacyFallback hold in the model in
\* 15 distinct states. The sabotage run violates FollowActive at 9 states; no other
\* invariant breaks.
\* Not modeled: the profile list (pinnedProfileExists is an oracle the caller computes),
\* the activateProviderProfile and updateTaskHistory side effects, and the CLI runtime
\* skip flag (checked before the decision runs).
\* Cost: TLC finishes in under 1 second per config.

CONSTANT NoActive   \* sentinel: no resolvable active profile at restore time

VARIABLES input, decision

vars == <<input, decision>>

NoProfile == "absent"   \* decision marker: reactivate nothing
Keep == "keep"          \* decision marker: preserve the stored pin

Input == [pin: {"p1", "p2", "absent"}, active: {"p1", "p2", NoActive}, pinExists: BOOLEAN]

\* The caller never passes an existing flag for an absent pin.
Valid(inp) == (inp.pin = "absent") => (~inp.pinExists)

\* Mirrors resolveRestoreProfileActivation rule for rule.
Decide(inp) ==
    IF inp.pin = "absent" THEN [r |-> NoProfile, f |-> Keep]
    ELSE IF ~inp.pinExists THEN
        IF inp.active # NoActive THEN [r |-> NoProfile, f |-> inp.active]
        ELSE [r |-> NoProfile, f |-> Keep]
    ELSE IF inp.active = NoActive THEN [r |-> inp.pin, f |-> Keep]
    ELSE IF inp.active = inp.pin THEN [r |-> inp.pin, f |-> Keep]
    ELSE [r |-> NoProfile, f |-> inp.active]

Init ==
    /\ input = [pin |-> "absent", active |-> NoActive, pinExists |-> FALSE]
    /\ decision = Decide(input)

Next ==
    \E inp \in Input :
        /\ Valid(inp)
        /\ input' = inp
        /\ decision' = Decide(inp)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ decision.r \in {"p1", "p2", "absent"}
    /\ decision.f \in {"p1", "p2", "keep"}

FollowActive ==
    (input.pin # "absent" /\ input.pinExists /\ input.active # NoActive /\ input.active # input.pin)
        => decision.r = NoProfile

PinNamesEffect ==
    /\ (decision.f # Keep) => decision.f = input.active
    /\ (decision.r # NoProfile) => decision.f = Keep

LegacyFallback ==
    (input.pin # "absent" /\ input.pinExists /\ input.active = NoActive) => decision.r = input.pin

====
