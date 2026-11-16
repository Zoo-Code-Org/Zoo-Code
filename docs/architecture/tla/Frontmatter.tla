---- MODULE Frontmatter ----
\* Models parseFrontmatter (src/utils/safeFrontmatter.ts).
\* Callers: scanCommandDirectory, tryLoadCommand and SkillsManager (load, read, update). One guard serves all.
\* Source: the header language in a workspace command or skill file. Sink: the gray-matter engine call.
\* Failure: a file header selects an executable engine and the extension runs its code.
\* Invariants: NoExecutableEngine and ValidDataAccepted. gray-matter is an oracle. Only the header language is modeled.
\* Expect: Fixed holds. None fails at once. NoBomStrip fails with a BOM and an executable header.
\* Expect: CaseSensitive fails ValidDataAccepted on an upper-case data header.
\* Result: Fixed holds in 8 states. CaseSensitive fails ValidDataAccepted in 1 state, with upper-case YAML.
\* Result: Before this change, Fixed held in 6 states. None fails in 1 state. NoBomStrip fails in 1 state, with a BOM.
\* Replay: gray-matter runs a js header in the real library. The guard in the code stops it.
\* Not modeled: the YAML and JSON parsers. The file body.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 1 covered (bot thread on double BOM, PR 2455), 1 added, 0 gap.
\* Added: PR 2456 bot thread on uppercase YAML. ValidDataAccepted and the CaseSensitive config model it.
\* Gap: an upper-case JSON header passes the guard. gray-matter then throws "engine not registered". It is a safe false reject. The code is unchanged.
\* Gap: a YAML tag such as !!js/function is not a header language. The spec cannot express it. A test covers it.
\* Replay: two BOMs do not run code in gray-matter. It is a false alarm. A test case stays.
\* Skills: the skill caller is the same input domain. The skill path was unguarded before this change.
\* Property test: src/utils/__tests__/safeFrontmatter.spec.ts. Caller tests: SkillsManager.spec.ts, frontmatter-commands.spec.ts.

CONSTANT Variant                  \* "Fixed", "None", "NoBomStrip" or "CaseSensitive"

VARIABLE in

\* "exec" = js or javascript in any case. "data" = yaml, yml, json or no language, lower case.
\* "upper" = yaml or yml with an upper-case letter. gray-matter does not lowercase json.
\* "other" = any other name. gray-matter finds no engine for it.
Inputs == [bom : BOOLEAN, lang : {"data", "upper", "exec", "other"}]

\* The guard reads the header language. Without the BOM strip it misses the header.
GuardSeesHeader(i) == Variant \in {"Fixed", "CaseSensitive"} \/ (Variant = "NoBomStrip" /\ ~i.bom)
Rejected(i) == GuardSeesHeader(i) /\ i.lang # "data" /\ (i.lang # "upper" \/ Variant = "CaseSensitive")
Executed(i) == i.lang = "exec" /\ ~Rejected(i)

TypeOK == in \in Inputs

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Safety: no input reaches an executable engine.
NoExecutableEngine == ~Executed(in)

\* Liveness of valid files: a data header is never rejected.
ValidDataAccepted == in.lang \in {"data", "upper"} => ~Rejected(in)

====
