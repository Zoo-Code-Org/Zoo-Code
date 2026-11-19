---- MODULE ThoughtSignature ----
\* Models the Gemini thought signature round trip through the task history (PR 2119).
\* Source: LiteLLMHandler.createMessage reads provider_specific_fields (readThoughtSignature).
\* prepareAssistantMessage stores it with getThoughtSignatureOrigin. Native Gemini stores it without an origin.
\* Sink: applyThoughtSignatures (LiteLLM) and convertAnthropicContentToGemini (native) on the next request.
\* Config value: requiresThoughtSignatures. getLiteLLMModels sets it from litellm_params.model.
\* Its reader is createMessage. The default (model not in the catalog) falls back to the model id.
\* Failure: a backend rejects a tool call in the history. Invariant: NoRejectedCall.
\* Gemini rejects a signature from another backend or step, and a signature on a later parallel call.
\* Gemini rejects a first call with no signature. LiteLLM decodes a __thought__ id when the call has no field.
\* A backend that does not run Gemini can reject the field (BerriAI/litellm#19739).
\* Failure 2: LiteLLM decodes a sanitized __thought__ id, even for a model missing from the catalog.
\* Invariant 2: NoCorruptIdDecode. Round 2 found it: with the flag, only an unlisted model needs the marker.
\* Round 1 expected: Fixed holds. Legacy fails on the alias backend. Each sabotage fails. Result: as expected.
\* Round 1 finding: an alias got no bypass for an unsigned call, for example a call from Claude.
\* Round 2 adds the catalog flag, Gemini 4 (g4) and an alias routed to Claude (other).
\* Round 2 expected: Fixed holds for a listed model. NameOnly fails on the alias. OldRegex fails on g4.
\* Unlisted fails on the alias: a model missing from the catalog has only its name. Result: as expected.
\* Round 3 adds the rejection by a non-Gemini backend. Expected: MarkerAlways (round 2 code) fails on other.
\* Fixed holds: for a listed model, the catalog flag alone decides. Result: as expected.
\* Round 3 also drops the alias name from the flag and derives the stored origin. No verdict changed.
\* TLC checks every next backend, so one turn is enough for most failures.
\* | Config                            | Variant                                    | Verdict             |
\* | ThoughtSignature.cfg              | the PR code, listed model                  | holds (507 states)  |
\* | ThoughtSignature.Legacy.cfg       | code before the PR (bypass on name only)   | fails after 1 turn  |
\* | ThoughtSignature.NameOnly.cfg     | round 1 code: no catalog flag              | fails after 1 turn  |
\* | ThoughtSignature.MarkerAlways.cfg | round 2 code: marker fallback when listed  | fails after 1 turn  |
\* | ThoughtSignature.OldRegex.cfg     | matcher of Gemini 3 and 2.5 only           | fails after 1 turn  |
\* | ThoughtSignature.Unlisted.cfg     | the PR code, model missing from catalog    | fails after 1 turn  |
\* | ThoughtSignature.ModelOnly.cfg    | origin ignores litellmBaseUrl              | fails after 1 turn  |
\* | ThoughtSignature.NoOrigin.cfg     | no origin check                            | fails after 1 turn  |
\* | ThoughtSignature.AllCalls.cfg     | signature on every parallel call           | fails after 1 turn  |
\* | ThoughtSignature.NoMarker.cfg     | bypass on the model name only              | fails after 1 turn  |
\* | ThoughtSignature.NoReset.cfg      | lastThoughtSignature kept across requests  | fails after 2 turns |
\* | ThoughtSignature.NativeLeak.cfg   | native Gemini reads a LiteLLM signature    | fails after 1 turn  |
\* Fixed also holds at MaxTurns 3 (11,155 states).
\* Replay of Legacy: issue 2064. The reporter used a Gemini model behind a custom gateway alias.
\* Residual (Unlisted): an alias missing from the catalog gets no bypass for a call from another model.
\* Residual (Unlisted): a non-Gemini model missing from the catalog gets the field for a __thought__ id.
\* Oracles: Gemini validity of each signature, isLiteLLMThoughtSignatureModel, the origin hash (no collisions).
\* Oracle: the routed model of a Gemini alias matches isLiteLLMThoughtSignatureModel.
\* Not modeled: R1 format, id normalization, the native position of the signature (it is on every call).
\* Property test: lite-llm.spec.ts, "never sends a call that a backend rejects" (220 cases).
\* It checks both invariants for a listed model and NoCorruptIdDecode for an unlisted model.
\* Sabotage of the code: NameOnly, MarkerAlways, NoMarker, NoOrigin, ModelOnly and AllCalls fail it.
\* NoReset passes it. NoReset needs two requests on one handler. The test "resets it per request" covers that.
\* OldRegex passes it. The test sets the catalog flag. The fetcher and matcher tests fail on OldRegex.
\* Cost: TLC runs each config in under 2 seconds. Agent time is not measured.
\* Review: 2 covered, 1 added, 5 gap, 0 on the spec files (PR 2119). See the list below Rejected.
\* The first version came after the code and the reviews. It is not an independent first pass.

EXTENDS Naturals, Sequences

CONSTANTS MaxTurns, Variant

VARIABLE history   \* One assistant message per turn. Each message has the fields of Message.

\* g1 and g2: one Gemini model on two gateways. g4: a Gemini 4 model id.
\* alias: a Gemini model under a LiteLLM alias. other: an alias routed to Claude.
Backends == {"g1", "g2", "g4", "alias", "other", "native"}
Url(b) == IF b = "g2" THEN "u2" ELSE "u1"
ModelOf(b) == CASE b \in {"g1", "g2", "native"} -> "gemini-3-pro"
                [] b = "g4" -> "gemini-4-pro"
                [] b = "alias" -> "team-model"
                [] b = "other" -> "team-claude"
Routed(b) == CASE b = "alias" -> "gemini/gemini-3-pro"   \* litellm_params.model
               [] b = "other" -> "anthropic/claude-sonnet"
               [] OTHER -> ModelOf(b)
LiteLlm(b) == b # "native"
RunsGemini(b) == b \in {"g1", "g2", "g4", "alias", "native"}

\* isLiteLLMThoughtSignatureModel. OldRegex and Legacy use the matcher from before the PR.
NameMatch(name) ==
    name \in IF Variant \in {"OldRegex", "Legacy"} THEN {"gemini-3-pro", "gemini/gemini-3-pro"}
             ELSE {"gemini-3-pro", "gemini-4-pro", "gemini/gemini-3-pro"}
\* requiresThoughtSignatures from getLiteLLMModels.
Flagged(b) == Variant \notin {"NameOnly", "Legacy"} /\ NameMatch(Routed(b))
\* The bypass condition in createMessage. listed: the catalog has the model id.
Detected(t, listed) == (listed /\ Flagged(t)) \/ NameMatch(ModelOf(t))
Listed == IF Variant = "Unlisted" THEN BOOLEAN ELSE {TRUE}

\* thoughtSignatureOrigin(litellmBaseUrl || default, modelId). ModelOnly drops the URL.
Origin(b) == IF Variant = "ModelOnly" THEN ModelOf(b) ELSE Url(b) \o "|" \o ModelOf(b)

None == [by |-> "none", step |-> 0]
Bypass == [by |-> "bypass", step |-> 0]
Real(s) == s.by \in Backends
\* getThoughtSignatureOrigin of the handler that streamed the message. Native Gemini stores none.
StoredOrigin(m) == IF LiteLlm(m.by) /\ Real(m.sig) THEN Origin(m.by) ELSE "none"
Sigs == {None, Bypass} \cup [by : Backends, step : 1..MaxTurns]
Message == [by : Backends, n : 1..2, marker : BOOLEAN, sig : Sigs]

TypeOK == history \in Seq(Message) /\ Len(history) <= MaxTurns

Init == history = <<>>

\* lastThoughtSignature after the stream. NoReset keeps the value from the last request on this handler.
Captured(t, k, minted) ==
    LET prev == history[k - 1]
        kept == Variant = "NoReset" /\ k > 1 /\ prev.by = t /\ Real(prev.sig)
        reads == ~(Variant = "Legacy" /\ LiteLlm(t))   \* The old LiteLLM handler did not read it.
    IN IF kept THEN prev.sig ELSE IF minted /\ reads THEN [by |-> t, step |-> k] ELSE None

\* A turn on backend t returns n tool calls. A Gemini backend can sign the first call.
\* LiteLLM then also writes the signature into the id of that call, after __thought__.
Turn(t, n, minted) ==
    LET k == Len(history) + 1
        sig == Captured(t, k, minted)
    IN /\ k <= MaxTurns
       /\ minted => RunsGemini(t)
       /\ history' = Append(history, [by |-> t, n |-> n, marker |-> minted /\ LiteLlm(t), sig |-> sig])

Next == \E t \in Backends, n \in 1..2, minted \in BOOLEAN : Turn(t, n, minted)
Spec == Init /\ [][Next]_history

\* The signature that a request to backend t puts on call i of history message k.
Sent(t, listed, k, i) ==
    LET m == history[k]
    IN IF LiteLlm(t)
       THEN LET matches == Real(m.sig) /\ (Variant = "NoOrigin" \/ StoredOrigin(m) = Origin(t))
                first == i = 1 \/ Variant = "AllCalls"
                markerFallback == m.marker /\ i = 1 /\ Variant \notin {"NoMarker", "Legacy"}
                                  /\ (~listed \/ Variant = "MarkerAlways")
            IN IF matches /\ first /\ Variant # "Legacy" THEN m.sig
               ELSE IF Detected(t, listed) \/ markerFallback THEN Bypass
               ELSE None
       ELSE IF Real(m.sig) /\ (StoredOrigin(m) = "none" \/ Variant = "NativeLeak") THEN m.sig ELSE Bypass

\* LiteLLM decodes the sanitized __thought__ id of a call that has no field.
DecodesCorruptId(t, listed, k, i) ==
    RunsGemini(t) /\ LiteLlm(t) /\ Sent(t, listed, k, i) = None /\ history[k].marker /\ i = 1

\* The sink oracle. A backend that does not run Gemini rejects every call with the field.
Rejected(t, listed, k, i) ==
    LET s == Sent(t, listed, k, i)
    IN \/ DecodesCorruptId(t, listed, k, i)
       \/ ~RunsGemini(t) /\ s # None
       \/ RunsGemini(t) /\ Real(s) /\ (s.by # t \/ s.step # k)
       \/ RunsGemini(t) /\ Real(s) /\ LiteLlm(t) /\ i # 1
       \/ RunsGemini(t) /\ s = None /\ i = 1
\* Review ratchet (PR 2119):
\* covered: CodeRabbit 4396808577 and edelauna on tool-id.ts. The history sanitizes the id copy (marker rule).
\* added: CodeRabbit 4532185300. Two gateways with one model id share an origin (ModelOnly).
\* gap: 4532185306 (a throw and a reasoning id), 4532185311 (test helper). The spec has no ids or exceptions.
\* gap: edelauna R1 path test, CodeRabbit on sanitizeLiteLlmCallId and its test. The PR removed that code.
\* Rounds 2 and 3 are not review findings. Round 2 fixes the round 1 finding of this spec.
\* Round 3 comes from a web search for best practice (BerriAI/litellm#19739, vercel/ai#15550).

\* Safety: no backend rejects a tool call in the history.
NoRejectedCall ==
    \A t \in Backends, listed \in Listed, k \in 1..Len(history) :
        \A i \in 1..history[k].n : ~Rejected(t, listed, k, i)

\* Safety: for a model in the catalog or not, LiteLLM never decodes a sanitized __thought__ id.
NoCorruptIdDecode ==
    \A t \in Backends, listed \in BOOLEAN, k \in 1..Len(history) :
        \A i \in 1..history[k].n : ~DecodesCorruptId(t, listed, k, i)

====
