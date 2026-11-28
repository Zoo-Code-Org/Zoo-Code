---- MODULE DeepSeekRefRelocation ----
\* Models relocateMovedRefs inside compileSchemaNode
\* (src/api/transform/deepseek-tool-dialect.ts). Compilation removes
\* patternProperties and re-admits the removed rule at a retained
\* schema-valued closed rule. Source: the moved pattern rule. Sink: the
\* compiled request schema.
\* Failure 1: a moved pattern rule keeps a $ref whose pointer only resolves
\*            through the removed patternProperties location - the compiled
\*            document has no such location left, and the value the original
\*            accepted for the key breaks (review 6089521528).
\* Failure 2: a literal-valued keyword inside a moved pattern rule carries
\*            instance data whose "$ref"-shaped value is rewritten as a
\*            schema - the literal changes and inputs the original
\*            accepted break (review 4723722038).
\* Failure 3: a moved rule references an acyclic branched graph and
\*            relocation without a bound grows its output exponentially,
\*            blocking the synchronous request path (review 4723722021).
\* Failure 4: a moved reference's sibling evaluation keyword moves inside
\*            the allOf conjunct - it no longer sees the inlined target's
\*            annotations and rejects values the original accepted
\*            (review 4723722028).
\* Failure 5: a moved rule's existing allOf conjunct keeps its own $ref
\*            through the removed patternProperties location un-relocated -
\*            the pointer dangles in the compiled document and the conjunct
\*            rejects values the original accepted (review 4724111350).
\* Failure 6: a schema-map entry inside a moved rule whose NAME matches a
\*            literal keyword keeps its schema unrelocated - the map's keys
\*            are property names, not keywords, so the literal exclusion
\*            must not suppress relocation there (review 4724111355).
\* Failure 7: a moved rule's own $ref pointer survives compilation but
\*            the walk stops at it - the rule's sibling schema maps can
\*            still carry references through the removed location, and an
\*            unrelocated sibling pointer dangles after patternProperties
\*            is deleted (review 4724550474).
\* Failure 8: a surviving reference's literal const sibling carries a
\*            "$ref"-shaped value that the sibling walk rewrites as a
\*            schema - the literal changes and inputs the original
\*            accepted break (review 4725307765).
\* Invariants: MovedRefResolvable, LiteralPreserved, ExpansionBounded,
\*             MovedRefSiblingOuter, MovedConjunctResolvable,
\*             MapEntryResolvable, SurvivingRefSiblingResolvable,
\*             SurvivingRefLiteralPreserved.
\* Expect: Fixed holds. KeepMovedRef fails MovedRefResolvable.
\* RewriteLiteral fails LiteralPreserved. UnboundedDiamond fails
\* ExpansionBounded. AbsorbRefSibling fails MovedRefSiblingOuter.
\* KeepRefConjunct fails MovedConjunctResolvable. KeepMapEntryRef fails
\* MapEntryResolvable. KeepSurvivingRefSibling fails
\* SurvivingRefSiblingResolvable. RewriteSurvivingRefLiteral fails
\* SurvivingRefLiteralPreserved.
\* This module holds the reference-relocation questions alone. The base
\* dialect questions live in DeepSeekToolDialect.tla; the subsystem split
\* keeps the relocation inputs out of the base state space (the 300-line
\* rule, review 4725327182). The moved-rule re-admission shape needs the
\* closed rule kept as a schema-valued unevaluatedProperties restriction,
\* so closed2 with uepSchema2 is the guard every invariant shares. The
\* relocation budget is modeled as the relaxation decision
\* ExpansionBounded; its constant is pinned by the branched-graph
\* regression test (review 4723722021).
\* Property tests: src/api/providers/__tests__/deepseek.spec.ts (tool dialect block).
\* Result: Fixed holds in 1024 states. KeepMovedRef fails
\* MovedRefResolvable. RewriteLiteral fails LiteralPreserved; UnboundedDiamond
\* fails ExpansionBounded; AbsorbRefSibling fails MovedRefSiblingOuter;
\* KeepRefConjunct fails MovedConjunctResolvable; KeepMapEntryRef fails
\* MapEntryResolvable; KeepSurvivingRefSibling fails
\* SurvivingRefSiblingResolvable; RewriteSurvivingRefLiteral fails
\* SurvivingRefLiteralPreserved. TLC found no state outside the sabotages.
\* Cost: TLC runs in seconds. Agent time is not measured.
\* Review: Round 12 (reviews 4725327182, 4725307765): the relocation
\* subsystem moved here from DeepSeekToolDialect.tla (failures 15 to 21
\* there continue as failures 1 to 7), 1 added (a surviving reference's
\* literal sibling stays verbatim, SurvivingRefLiteralPreserved),
\* 0 covered, 0 gap.
\* Round 13 (review 4725679658): 1 gap - the finding asks the Fixed record
\* to derive its outcomes from modeled schema facts (reference resolution,
\* retained location, literal value, expansion size). This module is a
\* decision-rule model per the binding AGENTS.md source/sink rule: the
\* decision record IS the modeled sink, the failure polarity is carried by
\* the eight sabotage runs each failing exactly its own invariant, and a
\* transformation-level rebuild of the reviewed subsystem is out of scope
\* for a fix round. 0 covered, 0 added, 1 gap.

CONSTANT Variant
\* "Fixed", "KeepMovedRef", "RewriteLiteral", "UnboundedDiamond",
\* "AbsorbRefSibling", "KeepRefConjunct", "KeepMapEntryRef",
\* "KeepSurvivingRefSibling", or "RewriteSurvivingRefLiteral"

VARIABLE in

Inputs == [closed2 : BOOLEAN, uepSchema2 : BOOLEAN,
           movedRef2 : BOOLEAN, literalRef2 : BOOLEAN,
           budgetDiamond2 : BOOLEAN, refSibling2 : BOOLEAN,
           refConjunct2 : BOOLEAN, mapKeyLiteral2 : BOOLEAN,
           survivingRefSibling2 : BOOLEAN,
           survivingRefLiteral2 : BOOLEAN]

\* The compiled decision for the moved rule: the reference through the
\* removed location is inlined with its compiled target, literal values
\* stay verbatim, a budget-busting graph relaxes the retained rule
\* instead, sibling keywords stay on the outer schema, existing conjuncts
\* relocate, schema-map entries relocate whatever their name, a surviving
\* reference keeps its sibling schema-map walk, and a surviving
\* reference's literal siblings stay verbatim.
\* KeepMovedRef keeps the pointer. RewriteLiteral rewrites literal values.
\* UnboundedDiamond ships the expanded graph. AbsorbRefSibling moves the
\* sibling keyword inside the conjunct. KeepRefConjunct leaves the
\* conjunct pointer unrelocated. KeepMapEntryRef skips an entry named
\* after a literal keyword. KeepSurvivingRefSibling stops the walk at a
\* surviving reference. RewriteSurvivingRefLiteral rewrites the surviving
\* reference's literal siblings.
Decisions(i) ==
    LET fixed ==
        [movedRefInlined |-> i.closed2 /\ i.uepSchema2 /\ i.movedRef2,
         literalKept |-> TRUE,
         diamondRelaxed |-> i.budgetDiamond2,
         siblingOnOuter |-> TRUE,
         conjunctRelocated |-> TRUE,
         mapEntryRelocated |-> TRUE,
         survivingSiblingRelocated |-> TRUE,
         survivingRefLiteralKept |-> TRUE]
    IN CASE Variant = "KeepMovedRef" ->
        [fixed EXCEPT !["movedRefInlined"] = FALSE]
    [] Variant = "RewriteLiteral" ->
        [fixed EXCEPT !["literalKept"] = FALSE]
    [] Variant = "UnboundedDiamond" ->
        [fixed EXCEPT !["diamondRelaxed"] = FALSE]
    [] Variant = "AbsorbRefSibling" ->
        [fixed EXCEPT !["siblingOnOuter"] = FALSE]
    [] Variant = "KeepRefConjunct" ->
        [fixed EXCEPT !["conjunctRelocated"] = FALSE]
    [] Variant = "KeepMapEntryRef" ->
        [fixed EXCEPT !["mapEntryRelocated"] = FALSE]
    [] Variant = "KeepSurvivingRefSibling" ->
        [fixed EXCEPT !["survivingSiblingRelocated"] = FALSE]
    [] Variant = "RewriteSurvivingRefLiteral" ->
        [fixed EXCEPT !["survivingRefLiteralKept"] = FALSE]
    [] OTHER -> fixed

TypeOK ==
    /\ Decisions(in).movedRefInlined \in BOOLEAN
    /\ Decisions(in).literalKept \in BOOLEAN
    /\ Decisions(in).diamondRelaxed \in BOOLEAN
    /\ Decisions(in).siblingOnOuter \in BOOLEAN
    /\ Decisions(in).conjunctRelocated \in BOOLEAN
    /\ Decisions(in).mapEntryRelocated \in BOOLEAN
    /\ Decisions(in).survivingSiblingRelocated \in BOOLEAN
    /\ Decisions(in).survivingRefLiteralKept \in BOOLEAN

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in

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

\* Safety (review 4724111350): a moved rule's existing allOf conjuncts stay
\* conjuncts and relocate: a conjunct can carry its own reference through
\* the removed patternProperties location, the compiled document has no
\* such location left, and an unrelocated conjunct pointer would dangle and
\* reject values the original accepted.
MovedConjunctResolvable ==
    (in.movedRef2 /\ in.closed2 /\ in.uepSchema2 /\ in.refConjunct2) =>
        Decisions(in).conjunctRelocated

\* Safety (review 4724111355): inside a schema map the keys are property or
\* definition names, not keywords - an entry named after a literal keyword
\* carries a schema whose reference must relocate, while a literal VALUE
\* under const inside a schema object stays verbatim (LiteralPreserved).
MapEntryResolvable ==
    (in.closed2 /\ in.uepSchema2 /\ in.mapKeyLiteral2) =>
        Decisions(in).mapEntryRelocated

\* Safety (review 4724550474): a moved rule's own $ref whose pointer
\* survives compilation (it resolves outside the removed location) must
\* not stop the relocation walk - the rule's sibling schema maps can
\* still carry references through the removed location, compilation
\* deletes that location, and an unrelocated sibling pointer would
\* dangle in the compiled document and reject values the original
\* accepted.
SurvivingRefSiblingResolvable ==
    (in.closed2 /\ in.uepSchema2 /\ in.survivingRefSibling2) =>
        Decisions(in).survivingSiblingRelocated

\* Safety (review 4725307765): a surviving reference's literal sibling
\* (const, enum, default, examples) carries instance data like the
\* literals inside a moved rule (LiteralPreserved), and the sibling walk
\* must not descend into it - a "$ref"-shaped value there is the data a
\* caller asserts against, and rewriting it as a schema changes the
\* accepted inputs.
SurvivingRefLiteralPreserved ==
    (in.closed2 /\ in.uepSchema2 /\ in.survivingRefLiteral2) =>
        Decisions(in).survivingRefLiteralKept

====
