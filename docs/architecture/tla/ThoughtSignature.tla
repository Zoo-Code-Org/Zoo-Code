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
\* Failure 3: a LiteLLM backend does not get back the signature it minted. Invariant 3: SignatureDelivered.
\* Round 1 expected: Fixed holds. Legacy fails on the alias backend. Each sabotage fails. Result: as expected.
\* Round 1 finding: an alias got no bypass for an unsigned call, for example a call from Claude.
\* Round 2 adds the catalog flag, Gemini 4 (g4) and an alias routed to Claude (other).
\* Round 2 expected: Fixed holds for a listed model. NameOnly fails on the alias. OldRegex fails on g4.
\* Unlisted fails on the alias: a model missing from the catalog has only its name. Result: as expected.
\* Round 3 adds the rejection by a non-Gemini backend. Expected: MarkerAlways (round 2 code) fails on other.
\* Fixed holds: for a listed model, the catalog flag alone decides. Result: as expected.
\* Round 3 also drops the alias name from the flag and derives the stored origin. No verdict changed.
\* Round 4 adds SignatureDelivered. The bypass is always accepted, so NoRejectedCall passes a lost signature.
\* Round 4 expected: DropStored passes NoRejectedCall and NoCorruptIdDecode and fails SignatureDelivered. Result: as expected.
\* Variants are in ThoughtSignatureMC.tla. Each one replaces one or more operators of this module.
\* Run: java -cp <jar> tlc2.TLC -metadir <dir> -config <ThoughtSignature[.Variant].cfg> ThoughtSignatureMC.tla
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
\* | ThoughtSignature.DropStored.cfg   | stored signature never sent (bypass only)  | fails after 1 turn  |
\* Fixed also holds at MaxTurns 3 (11,155 states).
\* Replay of Legacy: issue 2064. The reporter used a Gemini model behind a custom gateway alias.
\* Residual (Unlisted): an alias missing from the catalog gets no bypass for a call from another model.
\* Residual (Unlisted): a non-Gemini model missing from the catalog gets the field for a __thought__ id.
\* Oracles: Gemini validity of each signature, isLiteLLMThoughtSignatureModel, the origin hash (no collisions).
\* Oracle: the routed model of a Gemini alias matches isLiteLLMThoughtSignatureModel.
\* Not modeled: R1 format, id normalization, the native position of the signature (it is on every call).
\* Property test: lite-llm.spec.ts, "never sends a call that a backend rejects" (220 cases).
\* It checks NoRejectedCall for a listed model, and NoCorruptIdDecode and SignatureDelivered for both.
\* Sabotage of the code: NameOnly, MarkerAlways, NoMarker, NoOrigin, ModelOnly, AllCalls and DropStored fail it.
\* NoReset passes it. NoReset needs two requests on one handler. The test "resets it per request" covers that.
\* OldRegex passes it. The test sets the catalog flag. The fetcher and matcher tests fail on OldRegex.
\* Cost: TLC runs each config in under 2 seconds. Agent time is not measured.
\* Review: 2 covered, 1 added, 5 gap, 2 on the spec files (PR 2119). See the list below Rejected.
\* The first version came after the code and the reviews. It is not an independent first pass.

\* Issue 2304 first pass: expect an ID-only response to lose its signature.
\* SignatureDelivered must cover minted signatures absent from provider fields.
\* Replay: readThoughtSignature and OpenAiHandler.createMessage. Sink: applyThoughtSignatures.
\* Expected: IdOnly fails SignatureDelivered. Replay: three ID-only reader cases fail on the old code.
\* Result: fixed passes (507 states). All 14 variants fail. IdOnly fails with 24 states.
\* Live replay: Gemini 3.8 Flash accepts the preserved signature (200) and rejects corrupt bytes (400).
\* Live replay also accepts the bypass (200). The issue claim that Vertex always rejects it did not hold.
\* Live scope: the native Vertex endpoint received a 420-character signature from gemini-3.8-flash.
\* Replay mapped the converted provider field back to a Vertex function-call part. No LiteLLM gateway was tested.
\* Handler tests check the OpenAI and LiteLLM request contracts. gemini-2.5-flash returned 404 on this endpoint.
\* Saved signatures already corrupted by ID sanitization cannot be recovered. Preserve original bytes before storage.
\* Keep OpenAI Responses ID limits and unsigned provider reasoning. Do not replace valid signatures with a bypass.
\* Google contract: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures
\* Cache tuning is separate. Normal turns append environment details. Resume can refresh the latest user message.
\* Keep global time and cost defaults. This change does not assess cache performance.
\* Validation before refactor: 590 tests in five suites passed, including history storage and ID validation.
\* Validation after refactor: 552 tests in three provider suites passed. Types and lint passed. Suppression counts stayed equal.
\* Property: thought-signature.spec.ts, proxy signature round trip property (40 source/sink cases).
\* Cost: about 8 agent minutes through live replay. Each TLC config takes under 2 seconds.
\* Code sabotage: retaining reasoning_content fails all 40 property cases. The guard was then restored.
\* Null result: the fixed model found no further failure within this domain.
\* Scope: the proxy backends share the signature contract. Existing bypass rules model LiteLLM only.
\* Scope: ID bytes and fragmented ID streams remain outside the model. The property checks complete IDs.
\* Review: 0 covered, 0 added, 0 gap. No external review was read for this change.

\* Reader simplification: expect no new failure. A later explicit field must beat an earlier encoded ID.
\* Invariant: SignatureSourcePriority. Sabotage: prefer the encoded candidate over an explicit field.
\* Source: readThoughtSignature receives tool_calls. Sink: its returned signature enters history.
\* Refactor result: fixed holds (507 states). All 15 variants fail, including EncodedFirst.
\* Replay: encoded-first code sabotage fails the later-explicit-field test. The fixed reader passes.
\* Null result: the reader refactor found no new behavior failure. No speed gain was measured.
\* Refactor cost: about 3 agent minutes. Each TLC config takes under 2 seconds.

\* Main rebase expectation: retain request signature reset before Responses API dispatch.
\* Failure: a new request exposes a signature from the prior request. NoReset covers this failure.
\* Keep getReasoningDetails and both thought-signature accessors after the merge.
\* Model limit: Responses API dispatch is outside this model. Handler tests check that path.
\* Rebase result: fixed holds (507 states). All 15 sabotage variants fail as expected.
\* Property and handler checks: 863 tests pass in three suites. Types and lint pass. Suppression counts stay equal.
\* Null result: the existing model found no new failure. No external review was read.
\* Rebase cost: about 3 agent minutes. TLC needs a local socket outside the sandbox.

\* PR 2643 review ratchet: 1 covered, 0 added, 0 gap. Origin isolation was already modeled.
\* Thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4655457066
\* Finding: the handler replay test accepted a constant origin. Expect mismatch tests to reject it.
\* Replay: four handler cases vary only endpoint or model, with streaming on and off.
\* Code sabotage: a constant origin fails all four cases. Restoring origin derivation passes.
\* Result: fixed holds (507 states), all 15 variants fail as expected, and 254 focused tests pass.
\* Types and lint pass; suppression counts are unchanged. No new model failure. Cost: about 3 agent minutes.

\* Final rebase result: both header records remain. Model logic is unchanged.
\* Fixed holds (507 states); all 15 variants fail. All 867 tests, types and lint pass.
\* Suppression counts stay equal. No new model failure. Cost: about 1 agent minute.

\* PR 2643 review ratchet: add streamed source priority. The prior invariant covered one batch only.
\* Thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4660532072
\* Failure: the first ID fallback prevents a later explicit field from entering history.
\* Expect StreamFirstWins to fail. Replay both handlers with encoded then explicit chunks.
\* Extend this subsystem through ThoughtSignatureStream to keep the source rules separate.
\* Result: the old rule fails the invariant. Both handler replays keep encoded-0 instead of explicit-1.
\* Fixed holds (507 states). All 16 variants fail, including StreamFirstWins after one turn.
\* Property: ThoughtSignatureReader stream priority property checks 125 streams and each prefix.
\* Code sabotage: keep the first value. The property fails 18 cases. Restore the reader and all 1,000 tests pass.
\* Types, lint and both Knip checks pass. Suppression counts stay equal.
\* Review totals for PR 2643: 1 covered, 1 added, 0 gap. Null result: no further failure in this input domain.
\* Cost: about 5 agent minutes. The model does not check fragmented signature bytes or gateway behavior.

EXTENDS Naturals, Sequences, ThoughtSignatureStream

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

\* The names that isLiteLLMThoughtSignatureModel matches.
SignatureModelNames == {"gemini-3-pro", "gemini-4-pro", "gemini/gemini-3-pro"}
NameMatch(name) == name \in SignatureModelNames
\* requiresThoughtSignatures from getLiteLLMModels.
Flagged(b) == NameMatch(Routed(b))
\* The bypass condition in createMessage. listed: the catalog has the model id.
Detected(t, listed) == (listed /\ Flagged(t)) \/ NameMatch(ModelOf(t))
\* The catalog outcomes that NoRejectedCall covers.
Listed == {TRUE}

\* thoughtSignatureOrigin(litellmBaseUrl || default, modelId).
Origin(b) == Url(b) \o "|" \o ModelOf(b)

None == [by |-> "none", step |-> 0]
Bypass == [by |-> "bypass", step |-> 0]
Real(s) == s.by \in Backends
\* getThoughtSignatureOrigin of the handler that streamed the message. Native Gemini stores none.
StoredOrigin(m) == IF LiteLlm(m.by) /\ Real(m.sig) THEN Origin(m.by) ELSE "none"
Sigs == {None, Bypass} \cup [by : Backends, step : Nat \ {0}]
Message == [by : Backends, n : 1..2, marker : BOOLEAN, minted : BOOLEAN, sig : Sigs]

TypeOK == history \in Seq(Message)

Init == history = <<>>

\* lastThoughtSignature after the stream. createMessage resets it per request.
Captured(t, k, minted) == IF minted THEN [by |-> t, step |-> k] ELSE None

\* A turn on backend t returns n tool calls. A Gemini backend can sign the first call.
\* LiteLLM then also writes the signature into the id of that call, after __thought__.
CaptureFromId == TRUE

Turn(t, n, minted, idOnly) ==
    LET k == Len(history) + 1
    IN /\ minted => RunsGemini(t)
       /\ history' = Append(history, [by |-> t, n |-> n, marker |-> minted /\ LiteLlm(t),
                                      minted |-> minted,
                                      sig |-> IF idOnly /\ LiteLlm(t) /\ ~CaptureFromId THEN None
                                              ELSE Captured(t, k, minted)])

Next == \E t \in Backends, n \in 1..2, minted \in BOOLEAN, idOnly \in BOOLEAN : Turn(t, n, minted, idOnly)
Spec == Init /\ [][Next]_history

\* applyThoughtSignatures sends a stored signature only to the backend that minted it.
OriginMatches(m, t) == StoredOrigin(m) = Origin(t)
\* Gemini signs only the first call of a step.
SignedCall(i) == i = 1
\* A sanitized __thought__ id gets the bypass only for a model missing from the catalog.
MarkerFallback(m, listed, i) == m.marker /\ i = 1 /\ ~listed
\* convertAnthropicContentToGemini uses only a signature without an origin.
NativeUses(m) == StoredOrigin(m) = "none"

\* The signature that a request to backend t puts on call i of history message k.
Sent(t, listed, k, i) ==
    LET m == history[k]
    IN IF LiteLlm(t)
       THEN IF Real(m.sig) /\ OriginMatches(m, t) /\ SignedCall(i) THEN m.sig
            ELSE IF Detected(t, listed) \/ MarkerFallback(m, listed, i) THEN Bypass
            ELSE None
       ELSE IF Real(m.sig) /\ NativeUses(m) THEN m.sig ELSE Bypass

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
\* spec file: CodeRabbit 4634073736. The variants moved to ThoughtSignatureMC.tla. No verdict or state count changed.
\* spec file: CodeRabbit 4650658263. CapturedNative called Captured, its own replacement. The Legacy violation hid it.
\* Rounds 2 and 3 are not review findings. Round 2 fixes the round 1 finding of this spec.
\* Round 3 comes from a web search for best practice (BerriAI/litellm#19739, vercel/ai#15550).
\* Round 4 comes from the simplify pass. A property must constrain the result, not only reject a crash.

\* applyThoughtSignatures omits unsigned reasoning text when it attaches a signature.
EchoSignedReasoning == FALSE
ReasoningSent(t, listed, k) == EchoSignedReasoning /\ Sent(t, listed, k, 1) # None
NoUnsignedThought ==
    \A t \in Backends, listed \in Listed, k \in 1..Len(history) : ~ReasoningSent(t, listed, k)

\* Candidate values are oracles for fields and ID suffixes, including no signature.
PreferExplicit == TRUE
SelectedSignature(field, encoded) ==
    IF field # None /\ PreferExplicit THEN field ELSE IF encoded # None THEN encoded ELSE field
SignatureSourcePriority == Len(history) > 0 =>
    \A field, encoded \in {None, [by |-> "g1", step |-> 1], [by |-> "g2", step |-> 1]} :
        SelectedSignature(field, encoded) = (IF field # None THEN field ELSE encoded)

StreamPriorityAfterTurn == Len(history) > 0 => StreamSignaturePriority

\* Safety: no backend rejects a tool call in the history.
NoRejectedCall ==
    \A t \in Backends, listed \in Listed, k \in 1..Len(history) :
        \A i \in 1..history[k].n : ~Rejected(t, listed, k, i)

\* Safety: for a model in the catalog or not, LiteLLM never decodes a sanitized __thought__ id.
NoCorruptIdDecode ==
    \A t \in Backends, listed \in BOOLEAN, k \in 1..Len(history) :
        \A i \in 1..history[k].n : ~DecodesCorruptId(t, listed, k, i)

\* Safety: a LiteLLM backend gets back the signature it minted, on the first call of that message.
SignatureDelivered ==
    \A t \in Backends, listed \in BOOLEAN, k \in 1..Len(history) :
        LiteLlm(t) /\ history[k].by = t /\ history[k].minted =>
            Sent(t, listed, k, 1) = [by |-> t, step |-> k]

====
