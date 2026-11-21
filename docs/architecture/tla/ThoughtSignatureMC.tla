---- MODULE ThoughtSignatureMC ----
\* Model-checking settings and variants for ThoughtSignature. Each config replaces operators with these.
EXTENDS ThoughtSignature

CONSTANT MaxTurns
Bounded == Len(history) <= MaxTurns

\* OldRegex and Legacy: the matcher before the PR (Gemini 3 and 2.5 only).
OldNames == {"gemini-3-pro", "gemini/gemini-3-pro"}
\* NameOnly and Legacy: no catalog flag.
NoFlag(b) == FALSE
\* Unlisted: the model can be missing from the catalog.
AnyListed == BOOLEAN
\* ModelOnly: the origin ignores litellmBaseUrl.
ModelOrigin(b) == ModelOf(b)
\* NoOrigin: no origin check.
AnyOrigin(m, t) == TRUE
\* AllCalls: a signature on every parallel call.
EveryCall(i) == TRUE
\* NoMarker and Legacy: no __thought__ fallback.
NoMarkerFallback(m, listed, i) == FALSE
\* MarkerAlways: the round 2 code. The __thought__ fallback also applies to a listed model.
MarkerAlways(m, listed, i) == m.marker /\ i = 1
\* DropStored: applyThoughtSignatures never sends a stored signature.
NeverMatch(m, t) == FALSE
\* NativeLeak: native Gemini uses a LiteLLM signature.
NativeAny(m) == TRUE
\* NoReset: lastThoughtSignature keeps the value from the last request on this handler.
CapturedKept(t, k, minted) ==
    IF k > 1 /\ history[k - 1].by = t /\ Real(history[k - 1].sig) THEN history[k - 1].sig
    ELSE IF minted THEN [by |-> t, step |-> k] ELSE None
\* Legacy: the old LiteLLM handler did not read the signature.
CapturedNative(t, k, minted) == IF ~LiteLlm(t) /\ minted THEN [by |-> t, step |-> k] ELSE None

====
