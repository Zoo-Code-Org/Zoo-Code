---- MODULE ThoughtSignatureMC ----
\* Model-checking settings and variants for ThoughtSignature. Each config replaces operators with these.
EXTENDS ThoughtSignature

\* Issue 2304: the old reader ignores a signature present only in the ID.
IgnoreId == FALSE
\* Reader sabotage: an encoded ID wins over a later explicit field.
EncodedFirst == FALSE
\* Issue 2304: remove the guard that omits unsigned reasoning.
EchoUnsigned == TRUE

\* Streaming sabotage: keep the first signature, including an ID fallback.
KeepFirstCaptured(previous, chunk) == IF previous # StreamNone THEN previous ELSE chunk

\* Sabotage: origin checks omit the explicit field but keep the encoded signature in the ID.
KeepEncodedIds == TRUE

\* Sabotage: rewrite assistant call IDs but keep encoded tool-result IDs.
KeepResultIds == FALSE

\* Sabotage: look up reused call IDs without their history occurrence.
IdOnlyReplay == FALSE

\* Sabotage: a result reads the next occurrence instead of the last consumed occurrence.
NextResult == TRUE

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
\* Legacy: no __thought__ fallback. The separate NoMarker variant is retired after ID stripping.
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
