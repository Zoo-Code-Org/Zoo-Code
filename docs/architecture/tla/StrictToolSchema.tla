---- MODULE StrictToolSchema ----
\* Models the strict tool schema path of issue #547 (DeepSeek tool calling).
\* Source: a tool schema declared by the repo or an MCP server. Properties are
\* required or optional, a property can hold a forbidden keyword, a type can
\* already hold "null", and a property can hold an enum. The model uses one
\* property q; the forced rule "required = every key" is true by construction.
\* Sink: the emitted strict schema. A strict endpoint (DeepSeek, OpenRouter,
\* Cerebras) accepts it only when optional keys are nullable and no forbidden
\* keyword survives. The invariants state that contract.
\* Functions: BaseProvider.convertToolSchemaForOpenAI and
\* stripUnsupportedStrictKeywords (src/api/transform/strict-tool-schema.ts),
\* called by convertToolsForOpenAI (src/api/providers/base-provider.ts) with
\* strict true. The DeepSeek handler uses that path by default.
\* Failure 1: the conversion strips "null" and never adds it, so an optional
\* property becomes a required value property. The model omits it, the API
\* rejects the call, and the agent retries the same request. Invariant:
\* OptionalNullable.
\* Failure 2: the strip pass keeps "pattern", so a gateway that enforces
\* strict mode rejects the schema (HTTP 422). Invariant: NoForbiddenKeyword.
\* Failure 3 (opposite half): a declared required property keeps "null". The
\* endpoint sees a required property that accepts null. Invariant: RequiredNotNull.
\* Failure 4 (review round 1, PR #2653, thread 4658277638): an optional enum
\* property gains "null" in its type list, but its enum list keeps only the
\* declared values. The emitted schema still rejects null. A type-only
\* oracle cannot see this failure. Invariant: OptionalNullable through the
\* schema-acceptance oracle AcceptsNull.
\* First version: written before the fix, from the issue text alone.
\* Expected: Fixed holds. LegacyNull fails OptionalNullable. LegacyPattern fails
\* NoForbiddenKeyword. LegacyEnum fails OptionalNullable only when the enum
\* case is in the input. Each sabotage config fails on one invariant only.
\* Replay: the unit tests in base-provider.spec.ts and
\* strict-tool-schema.spec.ts run the real conversion on mocked schemas.
\* Not modeled: message serialization, XML output (removed by design), tool
\* result order (serial execution).
\* Cost: each config checks in seconds.
\* Findings ratchet, by round (review id; added invariants or inputs):
\* R1: 1 added (4658277638; the other 3 round-1 findings were code fixes
\* replayed by unit tests).
\* RN+1: 2 added (4674816413, 4674816421); 4674816417 is an
\* execution-layer contract (BaseTool.null-sentinels.spec.ts).
\* RN+2: 1 added (4675120035). R6: 1 added (4675584064, closing round-5).
\* R7: 0 added, 2 gap (4680624688; mutation report 7079812310).
\* R8: 1 added (4716476955); 6084531532 covered by WrappedInnerStrict.
\* R9: 1 added (4719419437); 4719419445, 4719419450 outside this spec.
\* R10: 1 added (via-map conjunct). R13: 1 added, 1 rewritten
\* (4725679664 NotOneOfValueKept, 4725679729 CondValuesKept).
\* R14: 1 added (4726104174 - notRefPat, condRefPat, oneOfRefPat).
\* Gap, pointer-map contracts pinned by unit tests: 4726104157,
\* 4726104178, 4726104168, 4726104169; 4726104159 is the test oracle.
\* R15: 2 added (4726390981 shape flags admit a reference-only change;
\* 4726390986 a nested wrapper can be an allOf conjunct).
\* R15 gap, pinned by unit tests: 4726391005 unevaluated* interplay,
\* 4726391009 percent-encoded pointers, 4726391002 own-key walks,
\* 4726390984 sort-once, 4726390978 header length, and the test-oracle
\* tightenings 4726390991, 4726390993, 4726390997, 4726390983.
\* R15 totals: 0 covered, 2 added, 10 gap.
\* R16: 0 added, 4 gap (4728045833 wrap-walker own key - the 4726391002
\* own-key contract, unit regression; 4728045843 nested relocation
\* pointer composition - the pointer-map contract family, unit
\* regression beside the single-move case; 4728045848 and 4728045852
\* unevaluated* interplay - the 4726391005 family, unit regressions).
\* R16 totals: 0 covered, 0 added, 4 gap.

EXTENDS Naturals, TLC

\* The name of the one modelled property.
q == "q"

VARIABLES declaredReq, qNullable, declaredPat, qEnum, nestedWrapper, nestedMatches, oneOfMultiNull, NestedIsOneOf, wrappedInner, patOneOf, notOneOf, notOneOfViaMap, notBranchPat, notBranchPatViaMap, condPat, notRefPat, condRefPat, oneOfRefPat, condShape, oneOfShape

Props == {q}
Types == {"str", "null"}
\* The declared enum values of q when the property is enum-constrained.
EnumVals == {"a", "b"}

\* The code under test. Each hook is replaced by a sabotage config.
\* Fixed code: an optional property gains "null". A declared null is kept.
OptionalAsNullable(optional) == optional
\* Fixed code: an optional enum property gains "null" in its enum too.
\* A declared required enum keeps its declared values.
EnumAsNullable(optional) == optional
\* Fixed code: the strip pass removes the pattern keyword.
EmittedKeepsPattern(declared) == FALSE
\* Fixed code: a nested combinator wrapper is looked through - the wrapper
\* accepts null exactly when one of its own alternatives does; the naive
\* evaluator reports TRUE for any wrapper without type/enum (the sabotage).
\* A nested anyOf accepts null when AT LEAST one nested alternative accepts
\* it; a nested oneOf requires EXACTLY ONE - two accepting alternatives
\* reject null under exactly-one semantics (review 4675120035). An allOf
\* wrapper (NestedIsOneOf = 2) accepts null only when EVERY conjunct does
\* (review 4726390986). The hook reports the nested combinator truth.
RecursesIntoNested(nm) ==
    IF NestedIsOneOf = 2 THEN nm = 2
    ELSE IF nm = 1 THEN TRUE
    ELSE IF nm >= 2 THEN NestedIsOneOf = 0
    ELSE FALSE
\* Fixed code: an optional oneOf with MULTIPLE null-accepting alternatives is
\* wrapped in an outer anyOf with a null alternative, so null matches exactly
\* one outer alternative. Leaving it untouched rejects null (the sabotage).
WrapsMultiMatch(multi) == multi => TRUE
NaiveWrapperAccepts(inner) == TRUE
NeverWrapped(multi) == FALSE
\* Fixed code: when a multi-match wrap hides the original's effective type,
\* the original's own inner schema is normalized BEFORE the wrap: required/
\* all-keys and additionalProperties: false on the object original
\* (4675158952), on the array original's items object (4675584064), with or
\* without declared properties (6084531532).
NormalizesWrappedInner(shape) == shape # "none"
\* Sabotage: the wrap keeps the original's inner schema untouched.
SkipsWrappedInner(shape) == FALSE
\* Fixed code: a oneOf whose pattern-distinguished alternatives were stripped
\* (every value now matches both) relaxes under anyOf, so a value matching
\* exactly one original alternative stays accepted (review 4716476955).
RelaxesChangedOneOf(oneOf) == oneOf
\* Sabotage: the stripped oneOf keeps exactly-one semantics and accepts
\* nothing.
NeverRelaxesOneOf(oneOf) == FALSE
\* Fixed code (round 13): a `not` whose subtree lost a keyword is dropped
\* outside a negation context - a retained negation over stripped branches
\* would reject a value the original accepted (review 4725679664); an
\* unchanged negation stays, which is why the round-9/10 keep-position
\* decision still governs it (4726104174 widens the changed fact to a
\* $ref-reached target change).
DropsChangedNot(changed) == changed
\* Sabotage: the changed negation is kept in place; the stripped branch
\* then matches a value the original branch did not, and the negation
\* rejects it.
KeepsChangedNot(changed) == FALSE
\* Fixed code (round 13): the negation decision is the same when the oneOf
\* is reached through a schema-map keyword (round 10 context).
DropsChangedNotViaMap(changed) == changed
\* Sabotage: the map callback loses the strip fact, so the changed negation
\* is kept there too and rejects the zero-branch value.
KeepsChangedNotViaMap(changed) == FALSE
\* Fixed code (round 13): a conditional whose if predicate lost a keyword
\* keeps the bare stripped predicate (it asserts nothing) and drops its
\* then/else branches, so the values both original branches accepted stay
\* accepted (review 4725679729).
DropsChangedConditional(changed) == changed
\* Sabotage: the branches stay; the stripped predicate selects then for
\* values the original routed to else, and the retained then rejects them.
KeepsChangedConditional(changed) == FALSE

DeclaredType == {"str"} \cup (IF qNullable THEN {"null"} ELSE {})

\* TRUE when the property is constrained to an enum. The unconstrained
\* optional string is the passing control for the acceptance oracle.
DeclaredEnum == IF qEnum THEN EnumVals ELSE {}

\* The type the conversion emits for q.
\* Optional: the union with "null". Required: the declared null is removed.
EmittedType ==
    LET base == DeclaredType
    IN IF OptionalAsNullable(q \notin declaredReq)
       THEN base \cup {"null"}
       ELSE base \ {"null"}

\* The enum the conversion emits for q.
EmittedEnum ==
    IF ~qEnum THEN {}
    ELSE IF (q \notin declaredReq) /\ EnumAsNullable(q \notin declaredReq)
         THEN DeclaredEnum \cup {"null"}
         ELSE DeclaredEnum

\* The pattern keyword state of the emitted property.
EmittedPattern == EmittedKeepsPattern(declaredPat)

\* Simplified validator for the emitted property q and the value null.
\* It checks type membership AND enum membership, as a Draft 2020-12
\* validator does. A type-only oracle misses the enum half. The
\* LegacyEnum sabotage fails only under this oracle.
\* The TRUE acceptance of the emitted schema, not the evaluator's report:
\* a nested wrapper accepts null when its nested combinator truly does
\* (anyOf: at least one accepting alternative; oneOf: exactly one) OR when
\* the evaluator's report made it append an outer null alternative; a
\* multi-match oneOf accepts null exactly when it was wrapped.
NestedCombinatorTruth ==
    IF NestedIsOneOf = 1 THEN nestedMatches = 1
    ELSE IF NestedIsOneOf = 2 THEN nestedMatches = 2
    ELSE nestedMatches >= 1
CombinatorGroundTruth ==
    IF nestedWrapper THEN NestedCombinatorTruth \/ ~RecursesIntoNested(nestedMatches)
    ELSE IF oneOfMultiNull THEN WrapsMultiMatch(oneOfMultiNull)
    ELSE TRUE

AcceptsNull ==
    /\ "null" \in EmittedType
    /\ (qEnum => "null" \in EmittedEnum)
    /\ ((nestedWrapper \/ oneOfMultiNull) => CombinatorGroundTruth)

\* The strict constraints the emitted wrapped original's inner schema
\* carries. Object shape: the original itself. Array shape: its items
\* object. None: no inner schema to normalize.
EmittedInnerStrict == NormalizesWrappedInner(wrappedInner)

\* A nested wrapper and a multi-match oneOf are two shapes of the same
\* property; the code normalizes at most one combinator route per property.
TypeOK ==
    /\ declaredReq \in {Props, {}}
    /\ qNullable \in BOOLEAN
    /\ declaredPat \in BOOLEAN
    /\ qEnum \in BOOLEAN
    /\ nestedWrapper \in BOOLEAN
    /\ nestedMatches \in 0..2
    /\ oneOfMultiNull \in BOOLEAN
    /\ NestedIsOneOf \in {0, 1, 2}
    /\ wrappedInner \in {"none", "object", "array"}
    /\ patOneOf \in BOOLEAN
    /\ notOneOf \in BOOLEAN
    /\ notOneOfViaMap \in BOOLEAN
    /\ notBranchPat \in BOOLEAN
    /\ notBranchPatViaMap \in BOOLEAN
    /\ condPat \in BOOLEAN
    /\ notRefPat \in BOOLEAN
    /\ condRefPat \in BOOLEAN
    /\ oneOfRefPat \in BOOLEAN
    /\ condShape \in BOOLEAN
    /\ oneOfShape \in BOOLEAN
    /\ (notBranchPat => notOneOf)
    /\ (notBranchPatViaMap => notOneOfViaMap)
    /\ (notRefPat => notOneOf)
    /\ (condPat => condShape)
    /\ (condRefPat => condShape)
    /\ (patOneOf => oneOfShape)
    /\ (oneOfRefPat => oneOfShape)
    /\ ~(nestedWrapper /\ oneOfMultiNull)
    /\ (wrappedInner # "none" => oneOfMultiNull)

Init ==
    /\ declaredReq \in {Props, {}}
    /\ qNullable \in BOOLEAN
    /\ declaredPat \in BOOLEAN
    /\ qEnum \in BOOLEAN
    /\ nestedWrapper \in BOOLEAN
    /\ nestedMatches \in 0..2
    /\ oneOfMultiNull \in BOOLEAN
    /\ NestedIsOneOf \in {0, 1, 2}
    /\ wrappedInner \in {"none", "object", "array"}
    /\ patOneOf \in BOOLEAN
    /\ notOneOf \in BOOLEAN
    /\ notOneOfViaMap \in BOOLEAN
    /\ notBranchPat \in BOOLEAN
    /\ notBranchPatViaMap \in BOOLEAN
    /\ condPat \in BOOLEAN
    /\ notRefPat \in BOOLEAN
    /\ condRefPat \in BOOLEAN
    /\ oneOfRefPat \in BOOLEAN
    /\ condShape \in BOOLEAN
    /\ oneOfShape \in BOOLEAN
    /\ (notBranchPat => notOneOf)
    /\ (notBranchPatViaMap => notOneOfViaMap)
    /\ (notRefPat => notOneOf)
    /\ (condPat => condShape)
    /\ (condRefPat => condShape)
    /\ (patOneOf => oneOfShape)
    /\ (oneOfRefPat => oneOfShape)
    /\ ~(nestedWrapper /\ oneOfMultiNull)
    /\ (wrappedInner # "none" => oneOfMultiNull)

Next == UNCHANGED <<declaredReq, qNullable, declaredPat, qEnum, nestedWrapper, nestedMatches, oneOfMultiNull, NestedIsOneOf, wrappedInner, patOneOf, notOneOf, notOneOfViaMap, notBranchPat, notBranchPatViaMap, condPat, notRefPat, condRefPat, oneOfRefPat, condShape, oneOfShape>>

Spec == Init /\ [][Next]_<<declaredReq, qNullable, declaredPat, qEnum, nestedWrapper, nestedMatches, oneOfMultiNull, NestedIsOneOf, wrappedInner, patOneOf, notOneOf, notOneOfViaMap, notBranchPat, notBranchPatViaMap, condPat, notRefPat, condRefPat, oneOfRefPat, condShape, oneOfShape>>

\* An optional property stays optional: the emitted schema accepts null.
\* The oracle checks the whole schema, not only the type list.
OptionalNullable == (q \notin declaredReq) => AcceptsNull

\* A required property stays a value property.
RequiredNotNull == (q \in declaredReq) => "null" \notin EmittedType

\* No forbidden keyword reaches the endpoint.
NoForbiddenKeyword == EmittedPattern = FALSE

\* Review round N+1: a nested wrapper is looked through (4674816413) and a
\* multi-null-match oneOf is wrapped (4674816421); null stays accepted.
NestedOrMultiStillNullable == ((q \notin declaredReq) /\ (nestedWrapper \/ oneOfMultiNull)) => AcceptsNull

\* Review round 6: a wrapped original's inner schema keeps the strict
\* constraints (4675158952 object shape, 4675584064 array items shape);
\* the stripping pass must not lose them.
WrappedInnerStrict == (oneOfMultiNull /\ wrappedInner # "none") => EmittedInnerStrict

\* Review round 8 (4716476955): a oneOf whose distinguishing alternatives
\* were stripped must relax under anyOf - a value the declared oneOf
\* accepted ("a", matching exactly one ^a$/^b$ alternative) stays accepted
\* whether the change sits in the branch or in a $ref target
\* (4726104174). The change flags presuppose the oneOf shape, not each
\* other: a reference change with no direct change is an admitted state
\* (4726390981). Under the sabotage the stripped rule accepts nothing.
OneOfAcceptsMatchingValue(changed) ==
    IF RelaxesChangedOneOf(changed) THEN TRUE
    ELSE ~changed
OneOfValuesKept == oneOfShape => OneOfAcceptsMatchingValue(patOneOf \/ oneOfRefPat)

\* Review round 13 (4725679664): the negation acceptance check REPLACES the
\* round-9/10 position hooks, which returned TRUE regardless of the strip
\* facts. The value b matches ZERO declared branches. After stripping, the
\* branch whose pattern is gone matches b by type alone, the retained
\* exactly-one rule sees one match, and the negation rejects b - and the
\* pattern change counts whether it sits in the branch or in a target the
\* negation's $ref reaches (notRefPat, review 4726104174). b stays accepted
\* exactly when the negation dropped or no branch lost a pattern; an
\* unchanged negation is the passing control. The via-map conjunct models
\* the same shape under a schema-map keyword (round 10). Null stays a
\* passing control through OptionalNullable in every config.
NotOneOfAcceptsB(changed) ==
    IF DropsChangedNot(changed) THEN TRUE
    ELSE ~changed
NotOneOfAcceptsBViaMap(changed) ==
    IF DropsChangedNotViaMap(changed) THEN TRUE
    ELSE ~changed
NotOneOfValueKept ==
    /\ (notOneOf => NotOneOfAcceptsB(notBranchPat \/ notRefPat))
    /\ (notOneOfViaMap => NotOneOfAcceptsBViaMap(notBranchPatViaMap))

\* Review round 13 (4725679729): the ELSE-branch value. The stripped
\* predicate selects then for values the original routed to else, and the
\* retained then rejects the enum - the else value stays accepted only when
\* the branches dropped or the predicate never lost a keyword, directly or
\* through a changed $ref target (condRefPat, 4726104174). The change
\* flags presuppose the conditional shape, not each other: a reference
\* change with no direct change is an admitted state (4726390981). The
\* then value stays accepted through the same derivation.
CondAcceptsElseValue(changed) ==
    IF DropsChangedConditional(changed) THEN TRUE
    ELSE ~changed
CondValuesKept == condShape => CondAcceptsElseValue(condPat \/ condRefPat)

====
