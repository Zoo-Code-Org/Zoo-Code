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
\* Failure 4: removing patternProperties while keeping additionalProperties: false
\*            leaves the object without any valid instance (review 4712438380).
\* Failure 5: a oneOf whose branches lost their distinguishing constraints
\*            accepts nothing under exactly-one semantics (review 4712438393).
\* Failure 6: a not whose predicate lost its constraint rejects every value
\*            (review 4712438405).
\* Failure 7: a conditional whose if predicate compilation changes keeps
\*            then: false and rejects values the original schema accepted
\*            (review 4713747391).
\* Failure 8: a relaxed oneOf absorbs a sibling anyOf, so the sibling stops
\*            applying as its own constraint (review 4713747398).
\* Invariants: RequiredPreserved, ForbiddenAbsent, ConstraintsRecorded,
\*             SatPreserved, SiblingConjunctKept.
\* Expect: Fixed holds. ForceRequired fails RequiredPreserved. KeepPattern fails
\* Expect: ForbiddenAbsent. DropSilently fails ConstraintsRecorded. NotTighten,
\* KeepOneOf, KeepClosed and KeepConditional fail SatPreserved. AbsorbAnyOf
\* Expect: fails SiblingConjunctKept.
\* Before this change the DeepSeek handler ran the strict-mode sanitizer plus the
\* all-required rewrite, so RequiredPreserved failed on every optional parameter.
\* Replay: DeepSeek answered 400 missing required parameter on read_file without
\* limit or offset, and 422 on a pattern keyword. The in-tree sanitizer does not
\* strip pattern. Not modeled: recursion into nested nodes (the rule is the same
\* per node), surrogate sanitization, the strict flag plumbing, MCP name checks,
\* prototype-key fidelity (a JS runtime artifact, pinned by the JSON.parse
\* regression test for review 4712438384).
\* Property tests: src/api/providers/__tests__/deepseek.spec.ts (tool dialect block).
\* Result: Fixed holds in 4096 states. ForceRequired fails RequiredPreserved.
\* KeepPattern fails ForbiddenAbsent. DropSilently fails ConstraintsRecorded.
\* NotTighten, KeepOneOf, KeepClosed and KeepConditional each fail
\* SatPreserved. AbsorbAnyOf fails SiblingConjunctKept. TLC found no state
\* outside the sabotages.
\* Cost: TLC runs in seconds. Agent time is not measured.
\* Review: 3 added (4712438380, 4712438393, 4712438405), 1 gap (4712438384
\* __proto__ own-property semantics are a JS artifact, pinned by the
\* JSON.parse regression test). (Round 2.) Round 3: 2 added (4713747391
\* changed conditional, 4713747398 sibling anyOf).

CONSTANT Variant                  \* "Fixed", "ForceRequired", "KeepPattern",
                                  \* "DropSilently", "NotTighten", "KeepOneOf",
                                  \* "KeepClosed", "KeepConditional"
                                  \* or "AbsorbAnyOf"

VARIABLE in

REJECTED == {"pattern", "minLength", "minItems"}

\* One optional property (2) next to a required one (1). The optional property
\* may carry rejected keywords (kw2) and may be composed: a not whose child
\* carries a rejected keyword (not2, childKw), a oneOf of two
\* pattern-distinguished branches whose branch carries a rejected keyword
\* (oneOf2, branchKw), a closed object whose extra key is legal only
\* through patternProperties (closed2), a conditional whose if predicate
\* carries a rejected keyword (cond2, ifKw), or an unchanged anyOf sibling
\* next to the oneOf (anyOf2).
Inputs == [req2 : BOOLEAN, kw2 : SUBSET REJECTED, not2 : BOOLEAN,
           childKw : BOOLEAN, oneOf2 : BOOLEAN, branchKw : BOOLEAN,
           closed2 : BOOLEAN, cond2 : BOOLEAN, ifKw : BOOLEAN,
           anyOf2 : BOOLEAN]

Required(i) == {1} \union (IF i.req2 THEN {2} ELSE {})

\* The compiled output for this input: the required set, the rejected keywords
\* still present, the removed keywords re-encoded in the description, and the
\* satisfiability decisions. Fixed drops a negation only when its child lost
\* a constraint, moves a oneOf only when a branch changed, relaxes
\* additionalProperties only under removed patternProperties, drops a
\* conditional only when its if predicate changed, and always keeps an anyOf
\* sibling as its own constraint.
\* ForceRequired is the all-required rewrite the strict path used before.
\* KeepPattern leaves every keyword in place. DropSilently removes without a
\* note. NotTighten, KeepOneOf, KeepClosed, KeepConditional and AbsorbAnyOf
\* each retain exactly one tightened construct.
Decisions(i) ==
    LET fixed ==
        [required |-> Required(i), kept |-> {}, noted |-> i.kw2,
         notDropped |-> i.not2 /\ i.childKw,
         overlapSafe |-> i.oneOf2 /\ i.branchKw,
         apRelaxed |-> i.closed2,
         condRelaxed |-> i.cond2 /\ i.ifKw,
         siblingKept |-> TRUE]
    IN CASE Variant = "ForceRequired" ->
        [fixed EXCEPT !["required"] = {1, 2}]
    [] Variant = "KeepPattern" ->
        [fixed EXCEPT !["kept"] = i.kw2, !["notDropped"] = FALSE,
         !["overlapSafe"] = FALSE, !["apRelaxed"] = FALSE]
    [] Variant = "DropSilently" ->
        [fixed EXCEPT !["noted"] = {}]
    [] Variant = "NotTighten" ->
        [fixed EXCEPT !["notDropped"] = FALSE]
    [] Variant = "KeepOneOf" ->
        [fixed EXCEPT !["overlapSafe"] = FALSE]
    [] Variant = "KeepClosed" ->
        [fixed EXCEPT !["apRelaxed"] = FALSE]
    [] Variant = "KeepConditional" ->
        [fixed EXCEPT !["condRelaxed"] = FALSE]
    [] Variant = "AbsorbAnyOf" ->
        [fixed EXCEPT !["siblingKept"] = FALSE]
    [] OTHER -> fixed

TypeOK ==
    /\ Decisions(in).required \subseteq {1, 2}
    /\ Decisions(in).kept \subseteq REJECTED
    /\ Decisions(in).noted \subseteq REJECTED
    /\ Decisions(in).notDropped \in BOOLEAN
    /\ Decisions(in).overlapSafe \in BOOLEAN
    /\ Decisions(in).apRelaxed \in BOOLEAN
    /\ Decisions(in).condRelaxed \in BOOLEAN
    /\ Decisions(in).siblingKept \in BOOLEAN

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

\* Safety: optionality survives compilation.
RequiredPreserved == Decisions(in).required = Required(in)

\* Safety: no gateway-rejected keyword reaches the request.
ForbiddenAbsent == Decisions(in).kept = {}

\* Safety: every removed constraint stays visible to the model.
ConstraintsRecorded == Decisions(in).noted = in.kw2

\* v2 is a valid instance of the input schema: it satisfies the string
\* constraints (including any kept keyword), it is not excluded by the
\* not-child's original predicate, it matches exactly one input oneOf branch,
\* and its object key is legal through patternProperties. SatPreserved says
\* compilation keeps v2 valid: the compiler may relax, never tighten.
NotPart(i) ==
    IF ~i.not2 THEN TRUE
    ELSE IF Decisions(i).notDropped THEN TRUE
    ELSE IF Variant = "KeepPattern" THEN TRUE
    ELSE i.childKw = FALSE

OneOfPart(i) ==
    IF ~i.oneOf2 THEN TRUE
    ELSE IF Decisions(i).overlapSafe THEN TRUE
    ELSE IF Variant = "KeepPattern" THEN TRUE
    ELSE i.branchKw = FALSE

ClosedPart(i) ==
    IF ~i.closed2 THEN TRUE
    ELSE IF Variant = "KeepPattern" THEN TRUE
    ELSE Decisions(i).apRelaxed

\* v2 does not match the original if predicate when ifKw holds: the
\* conditional keeps accepting it only when compilation relaxed the
\* conditional or the predicate never lost a keyword.
CondPart(i) ==
    IF ~i.cond2 THEN TRUE
    ELSE IF Decisions(i).condRelaxed THEN TRUE
    ELSE IF Variant = "KeepPattern" THEN TRUE
    ELSE i.ifKw = FALSE

SatPreserved == NotPart(in) /\ OneOfPart(in) /\ ClosedPart(in) /\ CondPart(in)

\* Safety: relaxed oneOf alternatives stay one separate conjunct, so an
\* unchanged anyOf sibling keeps applying on its own (a value it rejects
\* stays rejected).
SiblingConjunctKept ==
    IF Decisions(in).overlapSafe /\ in.anyOf2 THEN Decisions(in).siblingKept
    ELSE TRUE

====
