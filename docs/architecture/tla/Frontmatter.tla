---- MODULE Frontmatter ----
\* Models parseFrontmatter (src/utils/safeFrontmatter.ts).
\* Callers: scanCommandDirectory, tryLoadCommand and SkillsManager (load, read, update). One guard serves all.
\* Source: the header language in a workspace command or skill file. Sink: the gray-matter engine call.
\* Failure: a file header selects an executable engine and the extension runs its code.
\* Invariant: NoExecutableEngine. gray-matter is an oracle. Only the header language is modeled.
\* Expect: Fixed holds. None fails at once. NoBomStrip fails with a BOM and an executable header.
\* Result: Fixed holds in 6 states. None fails in 1 state. NoBomStrip fails in 1 state, with a BOM.
\* Replay: gray-matter runs a js header in the real library. The guard in the code stops it.
\* Not modeled: the YAML and JSON parsers. The file body.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 1 covered (bot thread on double BOM, PR 2455), 0 added, 1 gap.
\* Gap: PR 2456 bot thread on uppercase YAML. The spec models safety only, not false rejects. A test covers it.
\* Gap: a YAML tag such as !!js/function is not a header language. The spec cannot express it. A test covers it.
\* Replay: two BOMs do not run code in gray-matter. It is a false alarm. A test case stays.
\* Skills: the skill caller is the same input domain. The skill path was unguarded before this change.
\* Property test: src/utils/__tests__/safeFrontmatter.spec.ts. Caller tests: SkillsManager.spec.ts, frontmatter-commands.spec.ts.

CONSTANT Variant                  \* "Fixed", "None" or "NoBomStrip"

VARIABLE in

\* "exec" = js or javascript in any case. "data" = yaml, yml, json or no language.
\* "other" = any other name. gray-matter finds no engine for it.
Inputs == [bom : BOOLEAN, lang : {"data", "exec", "other"}]

\* The guard reads the header language. Without the BOM strip it misses the header.
GuardSeesHeader(i) == Variant = "Fixed" \/ (Variant = "NoBomStrip" /\ ~i.bom)
Rejected(i) == GuardSeesHeader(i) /\ i.lang # "data"
Executed(i) == i.lang = "exec" /\ ~Rejected(i)

TypeOK == in \in Inputs

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Safety: no input reaches an executable engine.
NoExecutableEngine == ~Executed(in)

====
