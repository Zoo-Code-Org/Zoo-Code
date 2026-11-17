---- MODULE RequestyDialogHost ----
\* Models the destination text in the consent dialog (handleUri, case "/requesty").
\* Failure: the dialog shows a trusted name before the host that the request uses.
\* Invariant: ShownHostIsRequestHost. Example: https://router.requesty.ai@evil.example/v1.
\* Result: Raw fails with user "requesty" and host "evil". Fixed holds in 6 states.
\* The Fixed variant removes the user name and password. It is true by construction.
\* The Raw variant is a sabotage check for the removed fix. The code no longer has it.
\* Not modeled: the path, the port, and how the user reads the text.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 1 added (PR 2408 review finding 6, no spec for the host fix), 0 gap.
\* The first version was written after the finding. It is not an independent first pass.

CONSTANTS Hosts, Variant   \* Variant is "Raw" or "Fixed"

VARIABLE url

Users == {"none"} \cup Hosts   \* A user name can look like a host name.

TypeOK == url \in [user : Users, host : Hosts]

Init == url \in [user : Users, host : Hosts]
Next == UNCHANGED url
Spec == Init /\ [][Next]_url

\* The first name in the dialog text. A raw URL shows the user name first.
FirstShown ==
    IF Variant = "Raw" /\ url.user # "none" THEN url.user ELSE url.host

\* Safety: the first name in the dialog is the host that the request uses.
ShownHostIsRequestHost == FirstShown = url.host

====
