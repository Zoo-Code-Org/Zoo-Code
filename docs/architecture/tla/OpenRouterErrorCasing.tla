---- MODULE OpenRouterErrorCasing ----
\* Subsystem: the provider value that OpenRouterHandler emits for one error event.
\* Source: the five error sites in src/api/providers/openrouter.ts.
\* handleStreamingError and the catch blocks of createMessage and completePrompt.
\* Sinks: TelemetryService.captureException reads ApiProviderError.provider.
\* The user reads the thrown Error message label. handleOpenAIError builds it.
\* Values: the canonical identifier "openrouter" and the display name "OpenRouter".
\*
\* Failure 1: an error event sends a provider value other than the canonical
\* identifier to telemetry. The OpenRouter error series then splits into two.
\* Failure 2: one error event sends two spellings of the provider to its two
\* sinks. The telemetry event and the user message then do not agree.
\*
\* Invariant TelemetryCanonical: the opposite of Failure 1.
\* Every sunk event sends the canonical identifier to telemetry.
\* Invariant SinksAgree: the opposite of Failure 2.
\* Every sunk event sends the same spelling to both sinks.
\*
\* Variants:
\* Fixed is the corrected code. Both sinks use the identifier.
\* Raw is the code on main before this change. Telemetry uses the identifier.
\* The message label uses the display name. SinksAgree must fail here.
\* Reverted is the other fix from the issue. Both sinks use the display name.
\* TelemetryCanonical must fail here. The invariant is not vacuous.
\* MessageOnly is a partial fix. Only the streaming label keeps the display name.
\* SinksAgree must fail here. The streaming label is part of the fix.
\*
\* Result: Raw fails SinksAgree at all five sites. This is the known bug.
\* Review: PR 2645 round 1. One finding: the telemetry assertions shared
\* captures between cases. Covered: TelemetryCanonical models the emission
\* for every error site. The defect was in the test double. Fixed in the
\* test file. Added 0. Gap 0.
\* Mutation round: PR 2645 report. The null error-value input the in-guard
\* admits was unpinned. The invariants cover it. A focused test pins it.
\* Replay: the test on main asserts "OpenRouter API Error 500" as the thrown
\* message and providerIdentifiers.openrouter as the telemetry value for one
\* event. Both spellings are real. See openrouter.spec.ts.
\* MessageOnly fails SinksAgree at the streaming site only. The issue lists
\* four handleOpenAIError sites. The streaming label is a fifth site. The fix
\* must include it. No other new failure was found.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 1 hour.
\* Gate: run check.sh on the fix commit. Fixed passes. Raw, Reverted and
\* MessageOnly fail. The property test must pass.
\* Property test: src/api/providers/__tests__/openrouter.spec.ts. The tests
\* "pins error casing at both sinks" pin both sinks with literal values.
\* Not modeled: the error text, the model id, the error code and the PostHog
\* client. They do not change the provider value.
\* Scope: other providers that emit this.providerName are outside this model.
\* The issue is about OpenRouter only.

EXTENDS TLC
CONSTANT Variant
VARIABLES site, phase, tele, label

Identifier == "openrouter"
Display == "OpenRouter"
Sites == {
	"streaming",
	"createParsed",
	"createFallback",
	"completeParsed",
	"completeFallback"
}

\* Each sink picks a spelling. The variant decides the pick.
TeleValue ==
	IF Variant = "Reverted" THEN Display ELSE Identifier

LabelValue(s) ==
	IF Variant = "Raw" \/ Variant = "Reverted"
	THEN Display
	ELSE IF Variant = "MessageOnly" /\ s = "streaming"
	THEN Display
	ELSE Identifier

Init ==
	/\ site \in Sites
	/\ phase = "raise"
	/\ tele = "absent"
	/\ label = "absent"

\* One error event reaches both sinks at the same time.
Emit ==
	/\ phase = "raise"
	/\ tele' = TeleValue
	/\ label' = LabelValue(site)
	/\ phase' = "sunk"
	/\ UNCHANGED site

Next == Emit
Spec == Init /\ [][Next]_<<site, phase, tele, label>>

TelemetryCanonical == phase = "sunk" => tele = Identifier
SinksAgree == phase = "sunk" => label = tele

====
