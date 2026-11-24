---- MODULE OpenAiDeploymentNameUi ----
\* Models the deployment name checkbox in webview-ui/.../providers/OpenAI.tsx.
\* Readers of the value: the checkbox state, the input row, and the request model in getOutboundModelId.
\* Failure 1: a profile has a saved name, the request sends it, and the settings page hides it.
\* Failure 2: a profile has no saved name, and the checkbox is still checked from the last profile.
\* Rules: SavedNameVisible (invariant) and SwitchSyncs (action property).
\* Expected before the run: Sync holds. NoSync fails in about 3 states.
\* Simplified after a web check: touched is gone, and SwitchSyncs replaces NoStaleChecked.
\* Result: Sync holds in 3 states. NoSync fails in 3 states, on both rules (SwitchSyncs fails alone too). The expectation was right.
\* Replay: OpenAI.spec.tsx "follows the saved value". The two profile-switch tests failed on the old code and pass now.
\* Not modeled: the Save button, the cachedState buffer, the base URL checkbox (same code, same fix).
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: PR 2507 thread on OpenAI.tsx. 0 covered, 1 added (checkbox sync), 1 gap (visual snapshot, not a state rule).
\* The invariants were written after the review comments were read. The ratchet count is not a clean test.

CONSTANT Sync                      \* TRUE: the component follows the saved value. FALSE: it reads it once.

VARIABLES hasName, selected        \* hasName: the saved name is not empty

vars == <<hasName, selected>>

TypeOK == hasName \in BOOLEAN /\ selected \in BOOLEAN

\* The component mounts with the checkbox set from the saved value.
Init == hasName \in BOOLEAN /\ selected = hasName

\* The user switches profile. The component stays mounted. The saved value is the new profile's value.
Switch(n) ==
    /\ hasName' = n
    /\ selected' = IF Sync THEN n ELSE selected

\* The user checks the box. The saved value does not change.
Check == ~selected /\ selected' = TRUE /\ UNCHANGED hasName

\* The user unchecks the box. The component clears the saved value.
Uncheck == selected /\ selected' = FALSE /\ hasName' = FALSE

\* The user types a name or clears the input. The checkbox stays checked.
Type(n) == selected /\ hasName' = n /\ UNCHANGED selected

Next == \/ \E n \in BOOLEAN : Switch(n) \/ Type(n)
        \/ Check
        \/ Uncheck

Spec == Init /\ [][Next]_vars

\* Failure 1 is the opposite: a saved name is always visible.
SavedNameVisible == hasName => selected

\* Failure 2 is the opposite: a profile switch sets the checkbox from the new saved value.
\* A user click is not a switch, so a checked box with no name stays valid.
SwitchSyncs == [][\A n \in BOOLEAN : Switch(n) => selected' = hasName']_vars

====
