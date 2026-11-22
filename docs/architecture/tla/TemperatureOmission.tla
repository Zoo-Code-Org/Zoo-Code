---- MODULE TemperatureOmission ----
\* Source: TemperatureControl.onChange stores null when "use custom temperature" is
\* off (modelTemperature is nullish). A number, zero included, is a custom value.
\* Sinks: createStream in BaseOpenAiCompatibleProvider; createMessage and
\* completePrompt in LiteLlmHandler, NativeOllamaHandler, OpenAiNativeHandler,
\* MistralHandler, LmStudioHandler, BedrockHandler, VercelAiGatewayHandler,
\* ZooGatewayHandler, KenariHandler, NanoGptHandler, FriendliHandler, ZaiHandler,
\* GeminiHandler. Each writes (or omits) one temperature field in the request body.
\* Exception: a reasoning format that requires temperature (DeepSeek reasoner in
\* openai.ts PR 247, ollama useR1Format) sends its default when no custom value is set.
\* Failure: the user turns custom temperature off and a provider still writes a
\* temperature field (often 0), or overwrites an explicit 0, or writes null.
\* Invariant: no temperature field when the value is nullish and the model is not a
\* reasoner format. An explicit 0 and any custom number are sent unchanged.
\* Expect: LegacyDefault, LegacyTruthy and NullPasses fail on unset or zero input.
\* Fixed holds. The provider constants are oracles.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 3 hours.
\* Result: Fixed holds in 12 states. LegacyDefault, LegacyTruthy and
\* NullPasses each fail in 7 states. No false alarm was retained.
\* Gate: Fixed must pass. LegacyDefault, LegacyTruthy and NullPasses must fail.
\* Property test: src/api/providers/__tests__/temperature-omission.spec.ts.
\* Not modeled: supportsTemperature capability gates, maxTokens and message fields.

EXTENDS TLC
CONSTANT Variant
VARIABLES input, phase, sent

Inputs == [setting : {"nullish", "zero", "custom"}, reasoner : BOOLEAN]

\* Assembly maps the source value to the field written into one request body.
\* Fixed omits the field for a nullish value, except for a reasoner format.
\* Each Variant models one unfixed assembly shape seen in the provider files.
AssembleValue(s, r) ==
    IF Variant = "LegacyDefault" /\ s = "nullish" THEN "default"
    ELSE IF Variant = "LegacyTruthy" /\ s \in {"nullish", "zero"} THEN "default"
    ELSE IF Variant = "NullPasses" /\ s = "nullish" THEN "null"
    ELSE IF r /\ s = "nullish" THEN "default"
    ELSE IF s = "nullish" THEN "absent"
    ELSE s

Init == /\ input \in Inputs
        /\ phase = "source"
        /\ sent = "absent"

Assemble == /\ phase = "source"
            /\ sent' = AssembleValue(input.setting, input.reasoner)
            /\ phase' = "assembled"
            /\ UNCHANGED input

Next == Assemble
Spec == Init /\ [][Next]_<<input, phase, sent>>

\* I1: unset custom temperature sends no temperature field (F1, F3).
OmitWhenUnset == phase = "assembled" /\ input.setting = "nullish" /\ ~input.reasoner
                  => sent = "absent"
\* I2: an explicit 0 is sent as 0 (F2).
ExplicitZeroKept == phase = "assembled" /\ input.setting = "zero" => sent = "zero"
\* I3: a custom number is sent unchanged.
CustomKept == phase = "assembled" /\ input.setting = "custom" => sent = "custom"
====
