import {
	type ModelInfo,
	type ProviderName,
	type ProviderSettings,
	type ReasoningEffortExtended,
	isOpencodeGoResponsesFormatModel,
	opencodeGoResponsesSupportsTemperature,
	providerIdentifiers,
} from "@roo-code/types"

import { shouldUseReasoningEffort } from "@roo/api"

/**
 * Returns the reasoning effort the request sends, matching `getModelParams`:
 * the user's selection wins over the model default, and `"disable"` omits it.
 */
const getEffectiveReasoningEffort = (
	model: ModelInfo,
	settings: ProviderSettings,
): ReasoningEffortExtended | undefined => {
	if (!shouldUseReasoningEffort({ model, settings })) return undefined

	const effort = settings.reasoningEffort ?? model.reasoningEffort
	return effort && effort !== "disable" ? effort : undefined
}

/**
 * Returns `true` when the settings UI should show the temperature control for
 * the selected model and configuration.
 *
 * OpenCode Go Responses models use the same opt-in rule as the request
 * builder, so the control is visible only when the request will send the
 * value (Zoo-Code-Org/Zoo-Code#2055). The rule depends on the effective
 * reasoning effort, so the result changes when the effort changes. Hiding
 * the control does not clear a saved temperature.
 */
export const isTemperatureControlSupported = ({
	provider,
	modelId,
	modelInfo,
	apiConfiguration,
}: {
	provider: ProviderName | undefined
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	apiConfiguration: ProviderSettings
}): boolean => {
	if (provider === providerIdentifiers.opencodeGo && modelId && isOpencodeGoResponsesFormatModel(modelId)) {
		const reasoningEffort = modelInfo ? getEffectiveReasoningEffort(modelInfo, apiConfiguration) : undefined
		return opencodeGoResponsesSupportsTemperature(modelId, reasoningEffort)
	}

	return modelInfo?.supportsTemperature !== false
}
