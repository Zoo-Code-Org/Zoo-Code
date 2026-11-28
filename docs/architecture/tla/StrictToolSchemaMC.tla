---- MODULE StrictToolSchemaMC ----
\* Model-checking settings and variants for StrictToolSchema.
\* Each sabotage config replaces one hook with an operator below.

EXTENDS StrictToolSchema

\* LegacyNull: the code before the fix. An optional property never gains
\* "null", and a declared "null" is stripped.
NeverNullable(optional) == FALSE

\* LegacyPattern: the code before the fix. stripUnsupportedStrictKeywords does
\* not remove the pattern keyword.
KeepsPattern(declared) == declared

\* LegacyEnum: the code before the review fix. An optional enum property
\* gains "null" in its type list, but its enum list keeps only the declared
\* values, so the emitted schema still rejects null. A type-only oracle
\* cannot see this failure.
NeverEnumNullable(optional) == FALSE

====
