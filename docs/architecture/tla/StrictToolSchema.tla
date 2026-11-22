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

EXTENDS Naturals, TLC

\* The name of the one modelled property.
q == "q"

VARIABLES declaredReq, qNullable, declaredPat, qEnum

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
AcceptsNull ==
    /\ "null" \in EmittedType
    /\ (qEnum => "null" \in EmittedEnum)

TypeOK ==
    /\ declaredReq \in {Props, {}}
    /\ qNullable \in BOOLEAN
    /\ declaredPat \in BOOLEAN
    /\ qEnum \in BOOLEAN

Init ==
    /\ declaredReq \in {Props, {}}
    /\ qNullable \in BOOLEAN
    /\ declaredPat \in BOOLEAN
    /\ qEnum \in BOOLEAN

Next == UNCHANGED <<declaredReq, qNullable, declaredPat, qEnum>>

Spec == Init /\ [][Next]_<<declaredReq, qNullable, declaredPat, qEnum>>

\* An optional property stays optional: the emitted schema accepts null.
\* The oracle checks the whole schema, not only the type list.
OptionalNullable == (q \notin declaredReq) => AcceptsNull

\* A required property stays a value property.
RequiredNotNull == (q \in declaredReq) => "null" \notin EmittedType

\* No forbidden keyword reaches the endpoint.
NoForbiddenKeyword == EmittedPattern = FALSE

====
