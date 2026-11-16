---- MODULE UrlRedaction ----
\* Models the warning log in toRequestyServiceUrl (src/shared/utils/requesty.ts, catch branch).
\* The code logs a fixed message now. The Regex variant models the removed redaction regex.
\* The Regex variant is a sabotage check only. The Fixed variant is true by construction.
\* Failure: an untrusted baseUrl puts credential text in the warning log.
\* Invariant: NoSecretInLog. The oracle `parses` is unconstrained. The log runs when it is FALSE.
\* Result, MaxLen 8: Regex fails with x:S@. Fixed holds in 20,624 states.
\* Replay: https:secret@h:bad leaks in real code. The bot comment on PR 2408 does not name this form.
\* Replay: https://secret/@h:bad parses in real code. It is a false alarm from the oracle.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 1 added (bot thread on the redaction regex, PR 2408), 0 gap.
\* The first version was written after the bot thread. It is not an independent first pass.

EXTENDS Naturals, Sequences

CONSTANTS Alphabet, MaxLen, Variant   \* Variant is "Regex" or "Fixed"

VARIABLES in, parses

Delim == {"/"}                        \* The regex class [^/?#]. "?" and "#" are not in Alphabet.

Strings == UNION {[1..n -> Alphabet] : n \in 0..MaxLen}

\* Each "S" is credential text. It must come before some "@".
\* The input starts with a scheme "x:".
HasAtAfter(s, p) == \E q \in (p+1)..Len(s) : s[q] = "@"
UrlShaped(s) == Len(s) >= 2 /\ s[1] = "x" /\ s[2] = ":"
Inputs == {s \in Strings : UrlShaped(s) /\ \A p \in 1..Len(s) : s[p] = "S" => HasAtAfter(s, p)}

\* The regex /\/\/[^/?#]*@/ without the g flag. JavaScript replaces the first match.
Slash2(s, i) == i + 1 <= Len(s) /\ s[i] = "/" /\ s[i+1] = "/"
RunEnd(s, i) ==
    CHOOSE e \in (i+1)..Len(s) :
        /\ \A p \in (i+2)..e : s[p] \notin Delim
        /\ (e = Len(s) \/ s[e+1] \in Delim)
AtPos(s, i) == {p \in (i+2)..RunEnd(s, i) : s[p] = "@"}
Starts(s) == {i \in 1..Len(s) : Slash2(s, i) /\ AtPos(s, i) # {}}
Min(S) == CHOOSE m \in S : \A q \in S : m <= q
Max(S) == CHOOSE m \in S : \A q \in S : q <= m

RedactRegex(s) ==
    IF Starts(s) = {} THEN s
    ELSE LET i == Min(Starts(s))
             j == Max(AtPos(s, i))
         IN SubSeq(s, 1, i-1) \o <<"/", "/">> \o SubSeq(s, j+1, Len(s))

LogMsg(s) == IF Variant = "Regex" THEN RedactRegex(s) ELSE <<"m">>

TypeOK == in \in Inputs /\ parses \in BOOLEAN

Init == in \in Inputs /\ parses \in BOOLEAN
Next == UNCHANGED <<in, parses>>
Spec == Init /\ [][Next]_<<in, parses>>

\* Safety: when the parse fails, the log line holds no credential text.
NoSecretInLog ==
    ~parses => \A p \in 1..Len(LogMsg(in)) : LogMsg(in)[p] # "S"

====
