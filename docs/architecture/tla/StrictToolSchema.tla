---- MODULE StrictToolSchema ----
\* Models the strict tool schema path of issue #547 (DeepSeek tool calling).
\* Source: a tool schema declared by the repo or an MCP server. Properties are
\* required or optional, a property can hold a forbidden keyword, a type can
\* already hold "null", and a property can hold an enum. The model uses one
\* property q. The forced rule "required = every key" is true by construction,
\* so it is not an invariant.
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
\* Replay: the unit tests in base-provider.spec.ts and strict-tool-schema.spec.ts
\* run the real conversion. They use mocked schemas only, no live API.
\* Not modeled: message serialization (reasoning_content is already kept by
\* convertToR1Format), XML output (the fork removed XML tool calls by design),
\* and tool result order (execution is serial, so results keep call order).
\* Cost: TLC checks each config in under 1 second. Agent time is not measured.
\* Review round 1 (PR #2653): 4 findings. This spec added the enum input and
\* the acceptance oracle for 1 finding (thread 4658277638). 0 covered, 1
\* added, 0 gap. The other 3 findings were code fixes replayed by the unit
\* tests.
\* Review round N+1 (PR #2653, findings 4674816413/4674816421 relayed from the
\* stacked 2664 review): a bare nested combinator wrapper must be looked
\* through before acceptance is reported (4674816413), and an optional oneOf
\* whose alternatives ALL accept null must be wrapped in an outer anyOf,
\* because strict exactly-one would otherwise reject null (4674816421). This
\* round added the nestedWrapper/nestedMatches/oneOfMultiNull inputs, the
\* CombinatorAcceptsNull decision, and the still-nullable invariant. 0
\* covered, 2 added, 0 gap; both replay as red-verified unit tests in
\* base-provider.spec.ts. Third finding 4674816417 (null sentinels reaching
\* execution) is an execution-layer contract, replayed by
\* BaseTool.null-sentinels.spec.ts and outside this schema spec.
\* Review round N+2 (4675120035, from the 2664 review): a NESTED oneOf is
\* evaluated under its own exactly-one rule — two null-accepting nested
\* alternatives make the nested oneOf reject null, and reporting acceptance
\* there leaves the emitted schema rejecting null. The spec's evaluator hook
\* RecursesIntoNested now reports the nested COMBINATOR truth, not just
\* inner-alternative acceptance. 0 covered, 1 added, 0 gap; replays as a
\* red-verified unit test in base-provider.spec.ts.
\* Review round 6 (PR #2653, thread 4675584064): a wrapped ARRAY-typed
\* original must normalize its items object before the wrap, exactly as the
\* object shape does. This round also closes the pending round-5 object
\* ratchet (thread 4675158952): both shapes are one invariant,
\* WrappedInnerStrict, on the new wrappedInner input (none/object/array).
\* 0 covered, 1 added, 0 gap; replays as a red-verified unit test in
\* base-provider.spec.ts. Fixed gate: 480 states.
\* Review round 7 (PR #2653, thread 4680624688 and the mutation-report
\* comment 7079812310): the test oracle must classify a non-null array as
\* "array" (4680624688), and 43 blocking mutants were reported on the
\* converter and the null-sentinel guard. 0 covered, 0 added, 2 gap: both
\* findings live in the unit-test harness, which this spec does not model.
\* The converter contract behind the array finding is already
\* WrappedInnerStrict (round 6); the mutation round killed 35 mutants with
\* focused tests, documented 5 equivalent ones as narrow Stryker disables,
\* and removed 3 dead-code lines (a duplicated type check, a dead break
\* guard) with no behavior change, so no invariant changed.
\* Review round 8 (PR #2653, threads 4716476955 and 6084531532): a stripped
\* oneOf keeps exactly-one semantics and accepts nothing - the spec adds the
\* patOneOf input, the RelaxesChangedOneOf hook, and OneOfValuesKept
\* (1 added, 0 covered, 0 gap; replays as a red-verified acceptance-oracle
\* test in strict-tool-schema.spec.ts). The property-less object wrap guard
\* (6084531532) is already demanded by WrappedInnerStrict ("object" shape
\* without declared properties): covered, closed by the code fix.
\* Review round 9 (PR #2653, thread 4719419437): a oneOf reached through a
\* `not` keeps its position - moved under anyOf, the negated predicate would
\* match every value and the negation would reject values the original
\* accepted. This round adds the notOneOf input, the KeepsOneOfPosition
\* hook, and NotOneOfValueKept. 1 added, 0 covered, 0 gap; replays as a
\* red-verified unit test in strict-tool-schema.spec.ts. The findings
\* 4719419445 and 4719419450 are unit-test harness coverage and live
\* outside this spec.
\* Review round 13 (PR #2653, threads 4725679664 and 4725679729): the
\* negation invariant compared a POSITION hook, not acceptance - both hooks
\* returned TRUE, so a stripped oneOf under a `not` could reject a value the
\* original accepted and the invariant still passed. The invariant now
\* derives the acceptance of a zero-branch value from the drop decision and
\* the strip facts (review 4725679664), and a second invariant covers the
\* conditional branch flip (review 4725679729). Code fix: a `not` whose
\* subtree lost a keyword drops outside a negation context, and a changed
\* conditional keeps the bare predicate without its branches. 1 added
\* (CondValuesKept) and 1 rewritten (NotOneOfValueKept), 0 covered, 0 gap.
\* Review round 10 (PR #2653, round-7 outside-diff comment on the schema-map
\* callback): the negation context must survive the schema-map keywords -
\* a callback that resets it to false lets a oneOf under properties inside
\* a `not` still move under anyOf, and the negation then rejects values the
\* original accepted. This round adds the notOneOfViaMap input, the
\* KeepsOneOfPositionViaMap hook, and the via-map conjunct of
\* NotOneOfValueKept. 1 added, 0 covered, 0 gap; replays as a red-verified
\* unit test in strict-tool-schema.spec.ts.

EXTENDS Naturals, TLC

\* The name of the one modelled property.
q == "q"

VARIABLES declaredReq, qNullable, declaredPat, qEnum, nestedWrapper, nestedMatches, oneOfMultiNull, NestedIsOneOf, wrappedInner, patOneOf, notOneOf, notOneOfViaMap, notBranchPat, notBranchPatViaMap, condPat

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
\* Fixed code: a nested combinator wrapper is looked through — the wrapper
\* accepts null exactly when one of its own alternatives does. The naive
\* evaluator reports TRUE for any wrapper without type/enum (the sabotage).
\* Fixed code: a nested anyOf accepts null when AT LEAST one nested
\* alternative accepts it; a nested oneOf requires EXACTLY ONE — two
\* accepting alternatives reject null under exactly-one semantics
\* (review 4675120035). The hook reports the nested combinator truth.
RecursesIntoNested(nm) ==
    IF nm = 1 THEN TRUE
    ELSE IF nm >= 2 THEN NestedIsOneOf = 0
    ELSE FALSE
\* Fixed code: an optional oneOf with MULTIPLE null-accepting alternatives is
\* wrapped in an outer anyOf with a null alternative, so null matches exactly
\* one outer alternative. Leaving it untouched rejects null (the sabotage).
WrapsMultiMatch(multi) == multi => TRUE
NaiveWrapperAccepts(inner) == TRUE
NeverWrapped(multi) == FALSE
\* Fixed code: when a multi-match wrap hides the original's effective type,
\* the original's own inner schema is normalized BEFORE the wrap — an
\* object-typed original carries required/all-keys and additionalProperties:
\* false (round 4675158952), and an array-typed original's items object
\* carries them (round 4675584064). The wrap fires with or without declared
\* properties (review 6084531532).
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
\* outside a negation context - the stripped branches match values the
\* original branches did not, and a retained negation would reject a value
\* the original accepted (review 4725679664). An unchanged negation stays.
\* The oneOf-reached-through-a-not shape therefore never keeps a stripped
\* negation: the keep-position decision of rounds 9 and 10 governs only an
\* unchanged subtree, whose acceptance is trivially preserved.
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
\* a nested wrapper accepts null when an inner alternative does OR when the
\* evaluator's report made it append an outer null alternative; a multi-match
\* oneOf accepts null exactly when it was wrapped.
\* The TRUE acceptance of the emitted schema, not the evaluator's report:
\* a nested wrapper accepts null when its nested combinator truly does
\* (anyOf: at least one accepting alternative; oneOf: exactly one) OR when
\* the evaluator's report made it append an outer null alternative; a
\* multi-match oneOf accepts null exactly when it was wrapped.
NestedCombinatorTruth == IF NestedIsOneOf = 1 THEN nestedMatches = 1 ELSE nestedMatches >= 1
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
    /\ NestedIsOneOf \in {0, 1}
    /\ wrappedInner \in {"none", "object", "array"}
    /\ patOneOf \in BOOLEAN
    /\ notOneOf \in BOOLEAN
    /\ notOneOfViaMap \in BOOLEAN
    /\ notBranchPat \in BOOLEAN
    /\ notBranchPatViaMap \in BOOLEAN
    /\ condPat \in BOOLEAN
    /\ (notBranchPat => notOneOf)
    /\ (notBranchPatViaMap => notOneOfViaMap)
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
    /\ NestedIsOneOf \in {0, 1}
    /\ wrappedInner \in {"none", "object", "array"}
    /\ patOneOf \in BOOLEAN
    /\ notOneOf \in BOOLEAN
    /\ notOneOfViaMap \in BOOLEAN
    /\ notBranchPat \in BOOLEAN
    /\ notBranchPatViaMap \in BOOLEAN
    /\ condPat \in BOOLEAN
    /\ (notBranchPat => notOneOf)
    /\ (notBranchPatViaMap => notOneOfViaMap)
    /\ ~(nestedWrapper /\ oneOfMultiNull)
    /\ (wrappedInner # "none" => oneOfMultiNull)

Next == UNCHANGED <<declaredReq, qNullable, declaredPat, qEnum, nestedWrapper, nestedMatches, oneOfMultiNull, NestedIsOneOf, wrappedInner, patOneOf, notOneOf, notOneOfViaMap, notBranchPat, notBranchPatViaMap, condPat>>

Spec == Init /\ [][Next]_<<declaredReq, qNullable, declaredPat, qEnum, nestedWrapper, nestedMatches, oneOfMultiNull, NestedIsOneOf, wrappedInner, patOneOf, notOneOf, notOneOfViaMap, notBranchPat, notBranchPatViaMap, condPat>>

\* An optional property stays optional: the emitted schema accepts null.
\* The oracle checks the whole schema, not only the type list.
OptionalNullable == (q \notin declaredReq) => AcceptsNull

\* A required property stays a value property.
RequiredNotNull == (q \in declaredReq) => "null" \notin EmittedType

\* No forbidden keyword reaches the endpoint.
NoForbiddenKeyword == EmittedPattern = FALSE

\* Review round N+1: a nested wrapper is looked through (4674816413) and a
\* multi-null-match oneOf is wrapped (4674816421) — the optional property
\* still accepts null in both shapes.
NestedOrMultiStillNullable == ((q \notin declaredReq) /\ (nestedWrapper \/ oneOfMultiNull)) => AcceptsNull

\* Review round 6: a wrapped original's inner object schema keeps the strict
\* constraints — required/all-keys and additionalProperties: false — either
\* on the original (object shape, 4675158952) or on its items object (array
\* shape, 4675584064). The merge-base converter normalized these; the
\* stripping pass must not lose them.
WrappedInnerStrict == (oneOfMultiNull /\ wrappedInner # "none") => EmittedInnerStrict

\* Review round 8 (4716476955): a oneOf whose distinguishing alternatives
\* were stripped must relax under anyOf - a value the declared oneOf
\* accepted ("a", matching exactly one ^a$/^b$ alternative) stays accepted
\* after stripping. Under the sabotage the stripped exactly-one rule accepts
\* nothing.
OneOfValuesKept == patOneOf => RelaxesChangedOneOf(patOneOf)

\* Review round 13 (4725679664): the negation acceptance check REPLACES the
\* round-9/10 position hooks, which returned TRUE regardless of the strip
\* facts. The value b matches ZERO declared branches - the pattern keeps it
\* out of the string branch and the other branch's type excludes it. After
\* stripping, the branch whose pattern is gone matches b by type alone, the
\* retained exactly-one rule sees one match, and the negation rejects b.
\* b stays accepted exactly when the negation dropped or no branch lost a
\* pattern; an unchanged negation is the passing control. The via-map
\* conjunct models the same shape under a schema-map keyword (round 10).
\* Null stays a passing control through OptionalNullable in every config.
NotOneOfAcceptsB(changed) ==
    IF DropsChangedNot(changed) THEN TRUE
    ELSE ~changed
NotOneOfAcceptsBViaMap(changed) ==
    IF DropsChangedNotViaMap(changed) THEN TRUE
    ELSE ~changed
NotOneOfValueKept ==
    /\ (notOneOf => NotOneOfAcceptsB(notBranchPat))
    /\ (notOneOfViaMap => NotOneOfAcceptsBViaMap(notBranchPatViaMap))

\* Review round 13 (4725679729): the ELSE-branch value. The stripped
\* predicate selects then for values the original routed to else, and the
\* retained then rejects the enum - the else value stays accepted only when
\* the branches dropped or the predicate never lost a keyword. The then
\* value stays accepted through the same derivation: it selected then
\* originally, and the dropped branches accept everything.
CondAcceptsElseValue(changed) ==
    IF DropsChangedConditional(changed) THEN TRUE
    ELSE ~changed
CondValuesKept == condPat => CondAcceptsElseValue(condPat)

====
