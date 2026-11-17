---- MODULE CommandApprovalDisplayMC ----
\* Model-checking settings for CommandApprovalDisplay. Each Esc* operator is one variant.
EXTENDS CommandApprovalDisplay

MaxLen == 2
MCInputs == UNION {[1..n -> Alphabet] : n \in 0..MaxLen}

JsonEsc == {"nl", "bs"}                         \* JSON.stringify
RegexEsc == {"del", "c1", "fmt", "ls", "astral"}  \* The Cc, Cf, U+2028 and U+2029 regex
Ignorable == {"ign"}                            \* Default_Ignorable_Code_Point
Lookalike == {"sp"}                             \* Zs except U+0020, and U+2800

EscRaw == {}
EscJson == JsonEsc
EscNoIgnorable == JsonEsc \cup RegexEsc \cup Lookalike
EscNoLookalike == JsonEsc \cup RegexEsc \cup Ignorable
EscFixed == JsonEsc \cup RegexEsc \cup Ignorable \cup Lookalike

====
