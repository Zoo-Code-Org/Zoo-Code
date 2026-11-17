---- MODULE CommandApprovalDisplay ----
\* Models toDisplayText (apps/cli/src/agent/ask-dispatcher.ts). Callers: every untrusted text line in AskDispatcher.
\* Sink: outputManager.output in each handler.
\* Source: the command text from the model. Another actor can shape it (prompt injection).
\* Failure: a raw control, format, or line-break character in the prompt text changes what the user sees.
\* Invariant: NoRawUnsafeChar. Each char is a class. Only the class and the escape rule are modeled.
\* Settings: CommandApprovalDisplayMC.tla holds the bounds and the variants. Variants: Raw is the code before the fix. Json is JSON.stringify alone. NoIgnorable is JSON plus the Cc and Cf regex. Fixed adds Default_Ignorable_Code_Point.
\* Run: java -cp <jar> tlc2.TLC -metadir <dir> -config CommandApprovalDisplay.Json.cfg CommandApprovalDisplayMC.tla
\* Expect: Raw fails at once. Json fails on DEL, C1, format, U+2028 and astral format chars. Fixed holds.
\* Result, MaxLen 2: Raw fails with a newline. Json fails with DEL. Fixed holds in 91 states. All matched Expect.
\* Replay: Json alone prints DEL, U+2028 and U+E0001 raw in real code. The property test fails with the regex removed.
\* Property tests: ask-dispatcher.test.ts, the random command test and "escapes untrusted text of ask". Both pass.
\* Sabotage: with the helper as identity, 18 of 19 tests fail.
\* Not modeled: how the terminal draws a char. Backslash and quote ambiguity (a unit test covers it).
\* Sinks: the helper now guards the command, question, suggestion, tool, MCP, error, detail, resume and generic lines.
\* Not guarded: the ask label [${ask}]. It is a ClineAsk value, not model text.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 2 added (bot threads on U+034F and on the MC module, PR 2473), 0 gap. The bot also asked for deny-path tests. The spec has no accept or reject step, so that is a gap.
\* Result after the thread, MaxLen 2: NoIgnorable fails with U+034F. Fixed holds.

EXTENDS Naturals, Sequences

CONSTANTS Esc, Inputs   \* Esc: classes the code escapes. Inputs: texts to check. CommandApprovalDisplayMC sets both.

VARIABLE in

\* nl: C0 control. del, c1: other Cc. fmt: Cf. ls: U+2028. astral: Cf above U+FFFF. bs: backslash or quote.
Alphabet == {"a", "nl", "del", "c1", "fmt", "ls", "astral", "ign", "bs"}
Unsafe == {"nl", "del", "c1", "fmt", "ls", "astral", "ign"}
JsonEsc == {"nl", "bs"}
RegexEsc == {"del", "c1", "fmt", "ls", "astral"}
Ignorable == {"ign"}   \* Default_Ignorable_Code_Point outside Cc and Cf, for example U+034F.


Shown(s) == [p \in 1..Len(s) |-> IF s[p] \in Esc THEN <<"esc", s[p]>> ELSE <<"raw", s[p]>>]

TypeOK == in \in Inputs

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Safety: no unsafe char reaches the terminal unescaped.
NoRawUnsafeChar == \A p \in 1..Len(in) : Shown(in)[p][1] = "raw" => Shown(in)[p][2] \notin Unsafe

====
