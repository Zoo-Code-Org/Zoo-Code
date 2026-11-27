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
\* Failure 9: a constraint inside a dependentSchemas entry survives uncompiled
\*            and the gateway answers HTTP 422 (review 4716476931).
\* Failure 10: a predicate whose object is only a $ref is retained although a
\*             referenced target lost its constraint; the applied target then
\*             rejects every value the original accepted (review 4716476940).
\* Failure 11: removing patternProperties strands a retained
\*             unevaluatedProperties: false - the removed rules were what
\*             evaluated those keys, so a required property becomes forbidden
\*             (review 4716476950).
\* Failure 12: removing contains strands a retained unevaluatedItems: false -
\*             contains evaluated the array items it matched, so every item
\*             the original accepted becomes forbidden (review 4719419428).
\* Failure 13: a retained prefixItems is no complete evaluator - it evaluates
\*             only the positions it lists, so the contains-evaluated trailing
\*             indices stay stranded behind unevaluatedItems: false
\*             (review 4719935091).
\* Failure 14: removing patternProperties strands a retained schema-valued
\*             additionalProperties or unevaluatedProperties rule - the keys
\*             the pattern rules evaluated were exempt from it, and the
\*             retained rule then rejects values the original accepted
\*             (review 4719336022).
\* Failure 15: a moved pattern rule keeps a $ref whose pointer only resolves
\*             through the removed patternProperties location - the compiled
\*             document has no such location left, and the value the original accepted for the key
\*             breaks (review 6089521528).
\* Failure 16: a literal-valued keyword inside a moved pattern rule carries
\*             instance data whose "$ref"-shaped value is rewritten as a
\*             schema - the literal changes and inputs the original
\*             accepted break (review 4723722038).
\* Failure 17: a moved rule references an acyclic branched graph and
\*             relocation without a bound grows its output exponentially,
\*             blocking the synchronous request path (review 4723722021).
\* Failure 18: a moved reference's sibling evaluation keyword moves inside
\*             the allOf conjunct - it no longer sees the inlined target's
\*             annotations and rejects values the original accepted
\*             (review 4723722028).
\* Invariants: RequiredPreserved, ForbiddenAbsent, ConstraintsRecorded,
\*             SatPreserved, SiblingConjunctKept, ArraySatKept,
\*             MovedRefResolvable, LiteralPreserved, ExpansionBounded,
\*             MovedRefSiblingOuter.
\* Expect: Fixed holds. ForceRequired fails RequiredPreserved. KeepPattern fails
\* Expect: ForbiddenAbsent. DropSilently fails ConstraintsRecorded. NotTighten,
\* KeepOneOf, KeepClosed, KeepConditional, KeepRefPredicate, KeepUnevaluated and
\* Expect: KeepUepSchema fail SatPreserved. AbsorbAnyOf fails SiblingConjunctKept.
\* Expect: KeepDependent fails ForbiddenAbsent. KeepContainsUneval and
\* Expect: KeepPrefixEvaluator fail ArraySatKept. KeepMovedRef fails
\* Expect: MovedRefResolvable. RewriteLiteral fails LiteralPreserved.
\* Expect: UnboundedDiamond fails ExpansionBounded. AbsorbRefSibling fails
\* Expect: MovedRefSiblingOuter.
\* Before this change the DeepSeek handler ran the strict-mode sanitizer plus the
\* all-required rewrite, so RequiredPreserved failed on every optional parameter.
\* Replay: DeepSeek answered 400 missing required parameter on read_file without
\* limit or offset, and 422 on a pattern keyword. The in-tree sanitizer does not
\* strip pattern. Not modeled: recursion into nested nodes (the rule is the same
\* per node; the depth-32 stop and its uncompiled pass-through are pinned by the
\* deep-schema test in the same block), the compile work count (a chain of
\* unchanged conditionals must compile each predicate once per level, review
\* 4714821172 - work is not expressible in this model's source-to-sink
\* abstraction, pinned by the linear-work timing test; the same holds for the
\* reference-target memoization (review 4719419419, pinned by the
\* repeated-reference timing test)), the relocation budget is modeled as
\* the relaxation decision ExpansionBounded, its constant is pinned by the
\* branched-graph regression test (review 4723722021), surrogate sanitization,
\* the strict flag plumbing, MCP name checks,
\* prototype-key fidelity (a JS runtime artifact, pinned by the JSON.parse
\* regression test for review 4712438384).
\* Property tests: src/api/providers/__tests__/deepseek.spec.ts (tool dialect block).
\* Result: Fixed holds in 1048576 states. ForceRequired fails RequiredPreserved.
\* KeepPattern fails ForbiddenAbsent. DropSilently fails ConstraintsRecorded.
\* NotTighten, KeepOneOf, KeepClosed and KeepConditional each fail
\* SatPreserved. AbsorbAnyOf fails SiblingConjunctKept. TLC found no state
\* outside the sabotages. RewriteLiteral fails LiteralPreserved;
\* UnboundedDiamond fails ExpansionBounded; AbsorbRefSibling fails
\* MovedRefSiblingOuter.
\* Cost: TLC runs in seconds. Agent time is not measured.
\* Review: 3 added (4712438380, 4712438393, 4712438405), 1 gap (4712438384
\* __proto__ own-property semantics are a JS artifact, pinned by the
\* JSON.parse regression test). (Round 2.) Round 3: 2 added (4713747391
\* changed conditional, 4713747398 sibling anyOf). Round 5 (reviews
\* 4716476931, 4716476940, 4716476950): 3 added (dependentSchemas traversal,
\* reference-target tracking, unevaluatedProperties relaxation), 0 covered,
\* 0 gap. Round 6 (reviews 4719419419, 4719419428): 1 added (contains
\* removal relaxes the stranded unevaluatedItems: false, ArraySatKept),
\* 1 added, 0 gap (4719419419 memoization is a work-count property, pinned by the
\* repeated-reference timing test). Round 7 (reviews 4719935091, 4719336022):
\* 2 added (a partial prefixItems no longer counts as a complete array
\* evaluator, ArraySatKept; a schema-valued closed rule re-admits the removed
\* pattern rules as alternatives, SatPreserved), 0 covered, 0 gap.
\* Round 8 (review 6089521528): 1 added (a moved pattern rule carries no
\* reference that only resolves through a removed location, the pointer is
\* inlined with its compiled target and a self-referencing rule relaxes the
\* retained rule instead, MovedRefResolvable), 0 covered, 0 gap.
\* Round 9 (reviews 4723722021, 4723722028, 4723722038): 3 added (literal
\* values under const, enum, default and examples are never rewritten,
\* LiteralPreserved; a relocation that exceeds the expansion budget relaxes
\* the retained closed rule instead of shipping the expanded tree,
\* ExpansionBounded; a moved reference's sibling evaluation keywords stay on
\* the outer schema beside the inlined allOf target,
\* MovedRefSiblingOuter), 0 covered, 0 gap.

CONSTANT Variant                  \* "Fixed", "ForceRequired", "KeepPattern",
                                  \* "DropSilently", "NotTighten", "KeepOneOf",
                                  \* "KeepClosed", "KeepConditional", "AbsorbAnyOf",
                                  \* "KeepDependent", "KeepRefPredicate",
                                  \* "KeepUnevaluated", "KeepContainsUneval",
                                  \* "KeepPrefixEvaluator", "KeepUepSchema"
                                  \* or "KeepMovedRef", "RewriteLiteral",
                                  \* "UnboundedDiamond", "AbsorbRefSibling"

VARIABLE in

REJECTED == {"pattern", "minLength", "minItems"}

\* One optional property (2) next to a required one (1). The optional property
\* may carry rejected keywords (kw2) and may be composed: a not whose child
\* carries a rejected keyword (not2, childKw), a oneOf of two
\* pattern-distinguished branches whose branch carries a rejected keyword
\* (oneOf2, branchKw), a closed object whose extra key is legal only
\* through patternProperties (closed2), a conditional whose if predicate
\* carries a rejected keyword (cond2, ifKw), an unchanged anyOf sibling
\* next to the oneOf (anyOf2), the keyword carried inside a
\* dependentSchemas entry instead of directly on the property (dep2), a
\* predicate whose child is only a $ref to a kw2-carrying target (ref2),
\* and the closed-object rule shaped as unevaluatedProperties: false
\* instead of additionalProperties: false (uneval2), the closed-array rule
\* carrying contains beside unevaluatedItems: false (containsClosed2) with
\* and without a second items evaluator that keeps the array evaluated
\* (arrEvaluator2), with a partial prefixItems as the second evaluator
\* instead (partialPrefix2 - it evaluates only its listed positions), and
\* the closed-object rule shaped as a schema-valued unevaluatedProperties
\* restriction that must re-admit the removed pattern rules (uepSchema2),
\* and the pattern rule itself being only a $ref whose pointer resolves
\* through the removed patternProperties location (movedRef2), the moved
\* rule carrying a literal-valued keyword with a "$ref"-shaped value
\* (literalRef2), the moved rule referencing an acyclic branched graph that
\* exceeds the relocation budget (budgetDiamond2), and the moved $ref
\* carrying a sibling evaluation keyword (refSibling2).
Inputs == [req2 : BOOLEAN, kw2 : SUBSET REJECTED, not2 : BOOLEAN,
           childKw : BOOLEAN, oneOf2 : BOOLEAN, branchKw : BOOLEAN,
           closed2 : BOOLEAN, cond2 : BOOLEAN, ifKw : BOOLEAN,
           anyOf2 : BOOLEAN, dep2 : BOOLEAN, ref2 : BOOLEAN,
           uneval2 : BOOLEAN, containsClosed2 : BOOLEAN,
           arrEvaluator2 : BOOLEAN, partialPrefix2 : BOOLEAN,
           uepSchema2 : BOOLEAN, movedRef2 : BOOLEAN,
           literalRef2 : BOOLEAN, budgetDiamond2 : BOOLEAN,
           refSibling2 : BOOLEAN]

Required(i) == {1} \union (IF i.req2 THEN {2} ELSE {})

\* The compiled output for this input: the required set, the rejected keywords
\* still present, the removed keywords re-encoded in the description, and the
\* satisfiability decisions. Fixed drops a negation only when its child lost
\* a constraint or a referenced target changed, moves a oneOf only when a
\* branch (or a referenced branch target) changed, relaxes
\* additionalProperties and unevaluatedProperties only under removed
\* patternProperties (a false rule becomes true; a schema-valued rule
\* re-admits the removed pattern rules as alternatives), relaxes a retained
\* unevaluatedItems restriction only under a removed contains with no
\* remaining complete items evaluator (a partial prefixItems is no complete
\* evaluator), drops a conditional
\* only when its if predicate (or a referenced predicate target) changed,
\* and always keeps an anyOf sibling as its own constraint.
\* ForceRequired is the all-required rewrite the strict path used before.
\* KeepPattern leaves every keyword in place. DropSilently removes without a
\* note. NotTighten, KeepOneOf, KeepClosed, KeepConditional and AbsorbAnyOf
\* each retain exactly one tightened construct. KeepDependent skips the
\* dependentSchemas traversal. KeepRefPredicate keeps the reference-blind
\* retention decisions. KeepUnevaluated keeps the stranded
\* unevaluatedProperties: false rule. KeepContainsUneval keeps the stranded
\* array restriction. KeepPrefixEvaluator keeps treating a partial prefixItems
\* as a complete evaluator. KeepUepSchema keeps a schema-valued closed rule
\* unmerged, so it rejects the keys the pattern rules evaluated.
\* KeepMovedRef keeps the moved rule's reference as a pointer, although the
\* compiled document has no patternProperties location for it to resolve.
Decisions(i) ==
    LET refChanged == i.ref2 /\ i.kw2 # {}
    IN LET fixed ==
        [required |-> Required(i), kept |-> {}, noted |-> i.kw2,
         notDropped |-> i.not2 /\ (i.childKw \/ refChanged),
         overlapSafe |-> i.oneOf2 /\ (i.branchKw \/ refChanged),
         apRelaxed |-> i.closed2 /\ ~i.uneval2 /\ ~i.uepSchema2,
         uepRelaxed |-> i.closed2 /\ i.uneval2 /\ ~i.uepSchema2,
         uepSchemaKept |-> i.closed2 /\ i.uepSchema2,
         condRelaxed |-> i.cond2 /\ (i.ifKw \/ refChanged),
         movedRefInlined |-> i.closed2 /\ i.uepSchema2 /\ i.movedRef2,
         literalKept |-> TRUE,
         diamondRelaxed |-> i.budgetDiamond2,
         siblingOnOuter |-> TRUE,
         siblingKept |-> TRUE,
         uiRelaxed |-> i.containsClosed2 /\ (~i.arrEvaluator2 \/ i.partialPrefix2)]
    IN CASE Variant = "ForceRequired" ->
        [fixed EXCEPT !["required"] = {1, 2}]
    [] Variant = "KeepPattern" ->
        [fixed EXCEPT !["kept"] = i.kw2, !["notDropped"] = FALSE,
         !["overlapSafe"] = FALSE, !["apRelaxed"] = FALSE,
         !["uepRelaxed"] = FALSE]
    [] Variant = "DropSilently" ->
        [fixed EXCEPT !["noted"] = {}]
    [] Variant = "NotTighten" ->
        [fixed EXCEPT !["notDropped"] = FALSE]
    [] Variant = "KeepOneOf" ->
        [fixed EXCEPT !["overlapSafe"] = FALSE]
    [] Variant = "KeepClosed" ->
        [fixed EXCEPT !["apRelaxed"] = FALSE, !["uepRelaxed"] = FALSE,
                      !["uepSchemaKept"] = FALSE]
    [] Variant = "KeepConditional" ->
        [fixed EXCEPT !["condRelaxed"] = FALSE]
    [] Variant = "AbsorbAnyOf" ->
        [fixed EXCEPT !["siblingKept"] = FALSE]
    [] Variant = "KeepDependent" ->
        [fixed EXCEPT !["kept"] = IF i.dep2 THEN i.kw2 ELSE {}]
    [] Variant = "KeepRefPredicate" ->
        [fixed EXCEPT !["notDropped"] = i.not2 /\ i.childKw,
                      !["overlapSafe"] = i.oneOf2 /\ i.branchKw,
                      !["condRelaxed"] = i.cond2 /\ i.ifKw]
    [] Variant = "KeepUnevaluated" ->
        [fixed EXCEPT !["uepRelaxed"] = FALSE]
    [] Variant = "KeepContainsUneval" ->
        [fixed EXCEPT !["uiRelaxed"] = FALSE]
    [] Variant = "KeepPrefixEvaluator" ->
        [fixed EXCEPT !["uiRelaxed"] = i.containsClosed2 /\ ~i.arrEvaluator2]
    [] Variant = "KeepUepSchema" ->
        [fixed EXCEPT !["uepSchemaKept"] = FALSE]
    [] Variant = "KeepMovedRef" ->
        [fixed EXCEPT !["movedRefInlined"] = FALSE]
    [] Variant = "RewriteLiteral" ->
        [fixed EXCEPT !["literalKept"] = FALSE]
    [] Variant = "UnboundedDiamond" ->
        [fixed EXCEPT !["diamondRelaxed"] = FALSE]
    [] Variant = "AbsorbRefSibling" ->
        [fixed EXCEPT !["siblingOnOuter"] = FALSE]
    [] OTHER -> fixed

TypeOK ==
    /\ Decisions(in).required \subseteq {1, 2}
    /\ Decisions(in).kept \subseteq REJECTED
    /\ Decisions(in).noted \subseteq REJECTED
    /\ Decisions(in).notDropped \in BOOLEAN
    /\ Decisions(in).overlapSafe \in BOOLEAN
    /\ Decisions(in).apRelaxed \in BOOLEAN
    /\ Decisions(in).uepRelaxed \in BOOLEAN
    /\ Decisions(in).uepSchemaKept \in BOOLEAN
    /\ Decisions(in).condRelaxed \in BOOLEAN
    /\ Decisions(in).siblingKept \in BOOLEAN
    /\ Decisions(in).uiRelaxed \in BOOLEAN
    /\ Decisions(in).movedRefInlined \in BOOLEAN
    /\ Decisions(in).literalKept \in BOOLEAN
    /\ Decisions(in).diamondRelaxed \in BOOLEAN
    /\ Decisions(in).siblingOnOuter \in BOOLEAN

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
    ELSE IF i.ref2 /\ i.kw2 # {} THEN FALSE
    ELSE i.childKw = FALSE

OneOfPart(i) ==
    IF ~i.oneOf2 THEN TRUE
    ELSE IF Decisions(i).overlapSafe THEN TRUE
    ELSE IF Variant = "KeepPattern" THEN TRUE
    ELSE IF i.ref2 /\ i.kw2 # {} THEN FALSE
    ELSE i.branchKw = FALSE

ClosedPart(i) ==
    IF ~i.closed2 THEN TRUE
    ELSE IF Variant = "KeepPattern" THEN TRUE
    ELSE IF i.uepSchema2 THEN Decisions(i).uepSchemaKept
    ELSE IF i.uneval2 THEN Decisions(i).uepRelaxed
    ELSE Decisions(i).apRelaxed

\* v2 does not match the original if predicate when ifKw holds: the
\* conditional keeps accepting it only when compilation relaxed the
\* conditional or the predicate never lost a keyword.
CondPart(i) ==
    IF ~i.cond2 THEN TRUE
    ELSE IF Decisions(i).condRelaxed THEN TRUE
    ELSE IF Variant = "KeepPattern" THEN TRUE
    ELSE IF i.ref2 /\ i.kw2 # {} THEN FALSE
    ELSE i.ifKw = FALSE

SatPreserved == NotPart(in) /\ OneOfPart(in) /\ ClosedPart(in) /\ CondPart(in)

\* Safety: relaxed oneOf alternatives stay one separate conjunct, so an
\* unchanged anyOf sibling keeps applying on its own (a value it rejects
\* stays rejected).
SiblingConjunctKept ==
    IF Decisions(in).overlapSafe /\ in.anyOf2 THEN Decisions(in).siblingKept
    ELSE TRUE

\* Safety (review 4719419428): a removed contains with no remaining items
\* evaluator relaxes the stranded unevaluatedItems: false, so the array
\* keeps accepting the items the original accepted. With a remaining
\* evaluator the restriction is ordinary and stays - but a partial
\* prefixItems evaluates only its listed positions, so the contains-evaluated
\* trailing indices stay unevaluated and the restriction relaxes anyway
\* (review 4719935091).
ArraySatKept ==
    (in.containsClosed2 /\ ((~in.arrEvaluator2) \/ in.partialPrefix2)) => Decisions(in).uiRelaxed

\* Safety (review 6089521528): a pattern rule that is only a $ref through the
\* removed patternProperties location is re-admitted as an inlined compiled
\* target, never as the pointer itself - the compiled document has no such
\* location left, so a retained pointer could not resolve and the key it
\* admitted would break. The re-admission happens under a schema-valued
\* closed rule (closed2 with the uepSchema2 shape); without one the rule has
\* no moved position at all.
MovedRefResolvable ==
    (in.movedRef2 /\ in.closed2 /\ in.uepSchema2) => Decisions(in).movedRefInlined

\* Safety (review 4723722038): a literal-valued keyword inside a moved rule
\* (const, enum, default, examples) carries instance data - a "$ref"-shaped
\* value there is data the caller asserts against, never a schema reference,
\* and relocation must leave it verbatim. The observable scenario is the
\* moved-rule re-admission shape (closed2 with the uepSchema2 rule), where
\* the rule re-enters the compiled document.
LiteralPreserved ==
    (in.literalRef2 /\ in.closed2 /\ in.uepSchema2) => Decisions(in).literalKept

\* Safety (review 4723722021): a moved rule may reference an acyclic branched
\* graph whose relocation output grows exponentially; past the expansion
\* budget the relocation abandons and the retained closed rule relaxes
\* instead of shipping the expanded tree.
ExpansionBounded ==
    (in.budgetDiamond2 /\ in.closed2 /\ in.uepSchema2) => Decisions(in).diamondRelaxed

\* Safety (review 4723722028): a moved reference's sibling evaluation keyword
\* stays on the outer schema beside the inlined target's allOf - Draft
\* 2020-12 collects evaluation annotations from adjacent keywords and the
\* schemas one object applies in place, and a sibling allOf branch is not
\* one of those, so a sibling moved inside the conjunct would lose the
\* target's annotations and reject values the original accepted.
MovedRefSiblingOuter ==
    (in.movedRef2 /\ in.closed2 /\ in.uepSchema2 /\ in.refSibling2) => Decisions(in).siblingOnOuter

====
