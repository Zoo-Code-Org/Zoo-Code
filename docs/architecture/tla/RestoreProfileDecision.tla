---- MODULE RestoreProfileDecision ----
\* Models src/core/webview/restore-provider-profile.ts resolveRestoreProfileActivation.
\* Source: HistoryItem.apiConfigName (the pin) and the currentApiConfigName global,
\* resolved against the profile list by ClineProvider.createTaskWithHistoryItemUnlocked.
\* Sink: the decision record (reactivateProfileName, refreshedApiConfigName) consumed by
\* the same method: reactivate calls activateProviderProfile, refresh rewrites the pin
\* through updateTaskHistory (persisted to the task file) and hands the record to the
\* Task constructor.
\* Failure: restore re-activates a stale pinned profile, so the resumed task and the
\* task header keep the old provider's context window (issue #970).
\* Invariants (first version written before the fix):
\*   FollowActive. With an existing pin and a resolvable active profile different from
\*   it, the decision must not reactivate the pinned profile.
\*   PinNamesEffect. A refresh names exactly the active profile, and a reactivation
\*   never also refreshes.
\*   LegacyFallback. With no resolvable active profile, an existing pin is reactivated.
\* Added in the PR 2649 review ratchet (CodeRabbit round on d58eaba2c):
\*   RefreshPersists. A refresh whose pin write succeeds leaves the persisted pin
\*   naming the active profile. The caller must hand the store a record distinct from
\*   the cached one (input rule in Valid); mutating the cached record in place makes
\*   the store's delta compare drop apiConfigName, so the stale pin survives on disk
\*   (CR thread on ClineProvider.ts:1651).
\*   WriteFailureRestores. The restore reaches Task construction even when the refresh
\*   pin write rejects (CR thread on ClineProvider.ts:1652).
\* Run each config on RestoreProfileDecisionMC.tla. The MC module holds the sabotage.
\* Expected: Spec.cfg passes every invariant; Sabotage.cfg fails FollowActive;
\* CacheAlias.cfg fails RefreshPersists; WriteAbort.cfg fails WriteFailureRestores.
\* Result: Spec.cfg checks and holds all six invariants in 132 distinct states.
\* CacheAlias.cfg violates RefreshPersists (21 states), Sabotage.cfg violates FollowActive (29
\* states), WriteAbort.cfg violates WriteFailureRestores (15 states); no other
\* invariant breaks in any run.
\* Not modeled: the profile list (pinnedProfileExists is an oracle the caller computes),
\* the activateProviderProfile side effects, mode restoration, and the CLI runtime
\* skip flag (checked before the decision runs).
\* Cost: TLC finishes in under 1 second per config.
\* Review (PR 2649, round on d58eaba2c): 1 covered (LegacyFallback - the missing-profile
\* proof case of the Regression Evidence check), 2 added (RefreshPersists + the
\* distinct-record input rule, CR thread ClineProvider.ts:1651; WriteFailureRestores,
\* CR thread ClineProvider.ts:1652), 1 gap (CR thread
\* ClineProvider.restore-follows-active-profile.spec.ts:123 - test-harness settings;
\* the model has no test doubles, the harness assertions pin it directly).
\* Review (PR 2649, round on bd9eb7d82): 1 covered (RefreshPersists +
\* WriteFailureRestores were already modeled; the defect was the passing cfg
\* checking only four of the six invariants - all six are checked now, CR thread
\* RestoreProfileDecision.cfg:6), 3 gap (mutation-diff survivors on bd9eb7d82:
\* the re-pin log text and the deleted-profile else-if guard are log/branch-level,
\* pinned by unit tests in ClineProvider.restore-follows-active-profile.spec.ts;
\* the defensive profile?.name chain is an equivalent mutant documented beside
\* the condition in ClineProvider.ts).
\* Review (PR 2649, round on 6ca11ea04): 1 gap (CR thread on
\* ClineProvider.restore-follows-active-profile.spec.ts:403 - the fall-through
\* restore must construct the task from the exact unresolved-settings snapshot;
\* expressing it would mean modeling the caller's profile.apiProvider activation
\* guard, which sits outside the decision record like the activation side
\* effects above; pinned by the strengthened exact-config unit assertion).

CONSTANT NoActive   \* sentinel: no resolvable active profile at restore time

VARIABLES input, decision, storedPin, restored

vars == <<input, decision, storedPin, restored>>

NoProfile == "absent"   \* decision marker: reactivate nothing
Keep == "keep"          \* decision marker: preserve the stored pin

Input ==
    [pin: {"p1", "p2", "absent"}, active: {"p1", "p2", NoActive},
     pinExists: BOOLEAN, pinWriteOk: BOOLEAN, distinctRecord: BOOLEAN]

\* Mirrors resolveRestoreProfileActivation rule for rule.
Decide(inp) ==
    IF inp.pin = "absent" THEN [r |-> NoProfile, f |-> Keep]
    ELSE IF ~inp.pinExists THEN
        IF inp.active # NoActive THEN [r |-> NoProfile, f |-> inp.active]
        ELSE [r |-> NoProfile, f |-> Keep]
    ELSE IF inp.active = NoActive THEN [r |-> inp.pin, f |-> Keep]
    ELSE IF inp.active = inp.pin THEN [r |-> inp.pin, f |-> Keep]
    ELSE [r |-> NoProfile, f |-> inp.active]

\* A refresh-shaped input is one whose decision carries a new pin.
Refreshes(inp) == Decide(inp).f # Keep

\* Caller rules: no existing flag for an absent pin, and a refresh write is built
\* from a record distinct from the store-cached one (a copy), never the cached
\* record itself.
Valid(inp) ==
    /\ ((inp.pin = "absent") => (~inp.pinExists))
    /\ (Refreshes(inp) => inp.distinctRecord)

\* The restore reaches Task construction even after a failed refresh write.
Proceed(dec, inp) == TRUE

Init ==
    /\ input = [pin |-> "absent", active |-> NoActive, pinExists |-> FALSE,
                pinWriteOk |-> TRUE, distinctRecord |-> TRUE]
    /\ decision = Decide(input)
    /\ storedPin = input.pin
    /\ restored = TRUE

Next ==
    \E inp \in Input :
        /\ Valid(inp)
        /\ input' = inp
        /\ decision' = Decide(inp)
           \* An aliased write (the cached record handed back to the store) makes the
           \* delta compare omit apiConfigName, so the stale pin survives on disk.
        /\ storedPin' = IF decision'.f # Keep /\ inp.pinWriteOk /\ inp.distinctRecord
                           THEN decision'.f
                           ELSE storedPin
        /\ restored' = Proceed(decision', inp)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ decision.r \in {"p1", "p2", "absent"}
    /\ decision.f \in {"p1", "p2", "keep"}
    /\ storedPin \in {"p1", "p2", "absent"}
    /\ restored \in BOOLEAN

FollowActive ==
    (input.pin # "absent" /\ input.pinExists /\ input.active # NoActive /\ input.active # input.pin)
        => decision.r = NoProfile

PinNamesEffect ==
    /\ (decision.f # Keep) => decision.f = input.active
    /\ (decision.r # NoProfile) => decision.f = Keep

LegacyFallback ==
    (input.pin # "absent" /\ input.pinExists /\ input.active = NoActive) => decision.r = input.pin

RefreshPersists ==
    (decision.f # Keep /\ input.pinWriteOk) => storedPin = decision.f

WriteFailureRestores == restored

====
