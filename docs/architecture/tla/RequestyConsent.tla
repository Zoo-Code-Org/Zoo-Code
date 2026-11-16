---- MODULE RequestyConsent ----
\* Models the consent gate in src/activate/handleUri.ts, case "/requesty".
\* Install = the call to upsertProviderProfile in handleRequestyCallback.
\* Failure: a provider profile is written without the user approving the dialog.
\* Invariant: NoInstallWithoutConsent.
\* Result, 2 links: holds in 25 states. Without the approval guard, TLC fails in 2 states.
\* Not modeled: the visible provider instance. Dialog text is in RequestyDialogHost.tla.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 0 added, 2 gap (the log leak is in UrlRedaction.tla, the host spoof in RequestyDialogHost.tla).

CONSTANT Links                      \* the deep links that can arrive

VARIABLES open, answer, installed

vars == <<open, answer, installed>>

TypeOK ==
    /\ open      \subseteq Links
    /\ answer    \in [Links -> {"none", "approve", "dismiss"}]
    /\ installed \subseteq Links

Init ==
    /\ open      = {}
    /\ answer    = [l \in Links |-> "none"]
    /\ installed = {}

\* handleUri reaches the call to showWarningMessage.
Arrive(l) ==
    /\ l \notin open
    /\ answer[l] = "none"
    /\ open' = open \cup {l}
    /\ UNCHANGED <<answer, installed>>

\* The user clicks a button. The await on showWarningMessage returns.
UserAnswers(l, c) ==
    /\ l \in open
    /\ c \in {"approve", "dismiss"}
    /\ answer' = [answer EXCEPT ![l] = c]
    /\ open' = open \ {l}
    /\ UNCHANGED installed

\* handleRequestyCallback writes the provider profile.
Install(l) ==
    /\ answer[l] = "approve"
    /\ l \notin installed
    /\ installed' = installed \cup {l}
    /\ UNCHANGED <<open, answer>>

Next ==
    \E l \in Links :
        \/ Arrive(l)
        \/ \E c \in {"approve", "dismiss"} : UserAnswers(l, c)
        \/ Install(l)

Spec == Init /\ [][Next]_vars

\* Safety Rule 1: a profile is written only for an approved link.
NoInstallWithoutConsent == \A l \in installed : answer[l] = "approve"

====
