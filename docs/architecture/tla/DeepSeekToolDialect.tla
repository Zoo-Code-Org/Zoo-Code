---- MODULE DeepSeekToolDialect ----
\* Models compileToolParametersForDeepSeek (src/api/transform/deepseek-tool-dialect.ts)
\* as applied by DeepSeekHandler.convertToolsForOpenAI (src/api/providers/deepseek.ts).
\* Source: a tool parameters schema entering the handler. Sink: the request tools array.
\* Failure 1: a declared optional parameter becomes required, the model is forced
\*            to emit values for it, and omitting it retries forever (issue 547 defect 1).
\* Failure 2: a gateway-rejected keyword such as pattern survives into the
\*            request and strict compilation answers HTTP 422 (issue 547 defect 2).
\* Failure 3: a removed constraint leaves no description hint and the model
\*            silently loses the requirement.
\* Invariants: RequiredPreserved, ForbiddenAbsent, ConstraintsRecorded.
\* Expect: Fixed holds. ForceRequired fails RequiredPreserved. KeepPattern fails
\* Expect: ForbiddenAbsent. DropSilently fails ConstraintsRecorded.
\* Before this change the DeepSeek handler ran the strict-mode sanitizer plus the
\* all-required rewrite, so RequiredPreserved failed on every optional parameter.
\* Replay: DeepSeek answered 400 missing required parameter on read_file without
\* limit or offset, and 422 on a pattern keyword. The in-tree sanitizer does not
\* strip pattern. Not modeled: recursion into nested nodes (the rule is the same
\* per node), surrogate sanitization, the strict flag plumbing, MCP name checks.
\* Property tests: src/api/providers/__tests__/deepseek.spec.ts (tool dialect block).
\* Result: Fixed holds in 16 states. ForceRequired fails RequiredPreserved on
\* the optional property. KeepPattern fails ForbiddenAbsent. DropSilently fails
\* ConstraintsRecorded. TLC found no state outside the sabotages.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 0 added, 0 gap. (First version.)

CONSTANT Variant                  \* "Fixed", "ForceRequired", "KeepPattern" or "DropSilently"

VARIABLE in

REJECTED == {"pattern", "minLength", "minItems"}

\* One optional property (2) next to a required one (1). The optional property
\* may carry rejected keywords. The domain admits the interesting states: an
\* optional property, and a property with rejected keywords.
Inputs == [req2 : BOOLEAN, kw2 : SUBSET REJECTED]

Required(i) == {1} \union (IF i.req2 THEN {2} ELSE {})

\* The compiled output: the required set, the rejected keywords still present,
\* and the keywords re-encoded in the description.
\* Fixed removes every rejected keyword, notes them, and keeps required as declared.
\* ForceRequired is the all-required rewrite the strict path used before.
\* KeepPattern leaves the keywords in place. DropSilently removes without a note.
Compiled(i) ==
    CASE Variant = "ForceRequired" ->
        [required |-> {1, 2}, kept |-> {}, noted |-> i.kw2]
    [] Variant = "KeepPattern" ->
        [required |-> Required(i), kept |-> i.kw2, noted |-> i.kw2]
    [] Variant = "DropSilently" ->
        [required |-> Required(i), kept |-> {}, noted |-> {}]
    [] OTHER ->
        [required |-> Required(i), kept |-> {}, noted |-> i.kw2]

TypeOK ==
    /\ Compiled(in).required \subseteq {1, 2}
    /\ Compiled(in).kept \subseteq REJECTED
    /\ Compiled(in).noted \subseteq REJECTED

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Safety: optionality survives compilation.
RequiredPreserved == Compiled(in).required = Required(in)

\* Safety: no gateway-rejected keyword reaches the request.
ForbiddenAbsent == Compiled(in).kept = {}

\* Safety: every removed constraint stays visible to the model.
ConstraintsRecorded == Compiled(in).noted = in.kw2

====
