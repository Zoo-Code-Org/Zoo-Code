---- MODULE CommandApprovalDisplayMC ----
\* Model-checking settings for CommandApprovalDisplay. Each Esc* operator is one variant.
EXTENDS CommandApprovalDisplay

MaxLen == 2
MCInputs == UNION {[1..n -> Alphabet] : n \in 0..MaxLen}

EscRaw == {}
EscJson == JsonEsc
EscNoIgnorable == JsonEsc \cup RegexEsc
EscFixed == JsonEsc \cup RegexEsc \cup Ignorable

====
