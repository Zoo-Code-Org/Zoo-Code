---- MODULE AskPresentationMC ----
\* Model-checking settings for AskPresentation. MaxLen 3 holds every masking shape.

EXTENDS AskPresentation

MaxLen == 3

\* Only ca carries answered true. The host stamps it when the ask is settled.
Msgs == {m \in [kind: Kinds, answered: BOOLEAN] : m.kind = "ca" \/ m.answered = FALSE}

MCInputs == UNION {[1..n -> Msgs] : n \in 0..MaxLen}

====
