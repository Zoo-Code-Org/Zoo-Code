---- MODULE StrictToolSchema ----
\* Models the strict tool schema path of issue #547 (DeepSeek tool calling).
\* Source: a tool schema declared by the repo or an MCP server. Properties are
\* required or optional, a property can hold a forbidden keyword, and a type can
\* already hold "null". The model uses one property q. The forced rule
\* "required = every key" is true by construction, so it is not an invariant.
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
\* First version: written before the fix, from the issue text alone.
\* Expected: Fixed holds. LegacyNull fails OptionalNullable. LegacyPattern fails
\* NoForbiddenKeyword. Each sabotage config fails on one invariant only.
\* Replay: the unit tests in base-provider.spec.ts and strict-tool-schema.spec.ts
\* run the real conversion. They use mocked schemas only, no live API.
\* Not modeled: message serialization (reasoning_content is already kept by
\* convertToR1Format), XML output (the fork removed XML tool calls by design),
\* and tool result order (execution is serial, so results keep call order).
\* Cost: TLC checks each config in under 1 second. Agent time is not measured.
\* Review: 0 covered, 0 added, 0 gap. Counts to update after each review round.

EXTENDS Naturals, TLC

\* The name of the one modelled property.
q == "q"

VARIABLES declaredReq, qNullable, declaredPat

Props == {q}
Types == {"str", "null"}

\* The code under test. Each hook is replaced by a sabotage config.
\* Fixed code: an optional property gains "null". A declared null is kept.
OptionalAsNullable(optional) == optional
\* Fixed code: the strip pass removes the pattern keyword.
EmittedKeepsPattern(declared) == FALSE

DeclaredType == {"str"} \cup (IF qNullable THEN {"null"} ELSE {})

\* The type the conversion emits for q.
\* Optional: the union with "null". Required: the declared null is removed.
EmittedType ==
    LET base == DeclaredType
    IN IF OptionalAsNullable(q \notin declaredReq)
       THEN base \cup {"null"}
       ELSE base \ {"null"}

\* The pattern keyword state of the emitted property.
EmittedPattern == EmittedKeepsPattern(declaredPat)

TypeOK ==
    /\ declaredReq \in {Props, {}}
    /\ qNullable \in BOOLEAN
    /\ declaredPat \in BOOLEAN

Init ==
    /\ declaredReq \in {Props, {}}
    /\ qNullable \in BOOLEAN
    /\ declaredPat \in BOOLEAN

Next == UNCHANGED <<declaredReq, qNullable, declaredPat>>

Spec == Init /\ [][Next]_<<declaredReq, qNullable, declaredPat>>

\* An optional property stays optional: the model can send null.
OptionalNullable == (q \notin declaredReq) => "null" \in EmittedType

\* A required property stays a value property.
RequiredNotNull == (q \in declaredReq) => "null" \notin EmittedType

\* No forbidden keyword reaches the endpoint.
NoForbiddenKeyword == EmittedPattern = FALSE

====
