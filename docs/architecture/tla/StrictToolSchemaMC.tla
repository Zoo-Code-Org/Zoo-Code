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

====
