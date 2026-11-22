---- MODULE CommandAskButtonsMC ----
\* Model-checking settings for CommandAskButtons. Each Buttons* operator is one version of the handler.
EXTENDS CommandAskButtons

\* Fixed: no keys for a partial ask, both keys for the live ask.
ButtonsFixed == [state \in {"Partial", "Live"} |-> state = "Live"]

\* Old: the code before issue 2232. It set both keys for a partial ask too.
ButtonsOld == [state \in {"Partial", "Live"} |-> TRUE]

\* NoLive: sabotage. A fix that shows no buttons for the live ask either.
ButtonsNoLive == [state \in {"Partial", "Live"} |-> FALSE]

====
