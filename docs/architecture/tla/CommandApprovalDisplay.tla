---- MODULE CommandApprovalDisplay ----
\* Models toDisplayText (apps/cli/src/agent/ask-dispatcher.ts). It escapes untrusted text in every AskDispatcher output line.
\* Source: text from the model. Prompt injection can shape it. Sink: outputManager.output in each handler.
\* Failure: a raw control, format, invisible or line-break character changes what the user sees.
\* Invariant: NoRawUnsafeChar. A char is a class. Only the class and the escape set are modeled.
\* Variants are in CommandApprovalDisplayMC.tla. Raw is the old code. Json is JSON.stringify only.
\* NoIgnorable and NoLookalike each leave out one class. Fixed escapes all classes.
\* Run: java -cp <jar> tlc2.TLC -metadir <dir> -config <Spec[.Variant].cfg> CommandApprovalDisplayMC.tla
\* Expect: Raw, Json, NoIgnorable and NoLookalike fail. Fixed holds.
\* Result, MaxLen 2: Raw fails on a newline. Json fails on DEL. NoIgnorable fails on U+034F. NoLookalike fails on U+00A0. Fixed holds in 111 states.
\* Replay: Json alone prints DEL, U+2028 and U+E0001 raw in real code.
\* Tests: ask-dispatcher.test.ts has a sweep of all code points and per-ask output tests. Both fail if the helper is weakened.
\* Finding: the invariant reduces to "Unsafe is inside Esc". The spec found U+034F only after review named it. Null result.
\* Sweep: it showed 16 raw space lookalikes. They were added as class sp. The sweep allowlist missed U+2800 (category So).
\* Not modeled: terminal drawing, prompt flow, the [${ask}] label (not model text), backslash ambiguity (a unit test covers it).
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review (PR 2473): 1 covered (U+2800 is class sp), 2 added (U+034F, space lookalikes), 3 gap (deny paths, followup paths, assertion strength).
\* Review: 1 finding on the spec files (MC module).

EXTENDS Naturals, Sequences

CONSTANTS Esc, Inputs   \* Esc: classes the code escapes. Inputs: texts to check. The MC module sets both.

VARIABLE in

\* nl: C0 control. del, c1: other Cc. fmt: Cf. ls: U+2028. astral: Cf above U+FFFF.
\* ign: default-ignorable outside Cc and Cf, such as U+034F. sp: space lookalike, such as U+00A0 or U+2800.
\* bs: backslash or quote.
Alphabet == {"a", "nl", "del", "c1", "fmt", "ls", "astral", "ign", "sp", "bs"}
Unsafe == Alphabet \ {"a", "bs"}

Shown(s) == [p \in 1..Len(s) |-> IF s[p] \in Esc THEN <<"esc", s[p]>> ELSE <<"raw", s[p]>>]

TypeOK == in \in Inputs

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Safety: no unsafe char reaches the terminal unescaped.
NoRawUnsafeChar == \A p \in 1..Len(in) : Shown(in)[p][1] = "raw" => Shown(in)[p][2] \notin Unsafe

====
