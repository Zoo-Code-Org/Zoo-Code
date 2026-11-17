import {
	providerIdentifiers,
	reasoningEfforts,
	reasoningEffortSettingValues,
	type ModelInfo,
	type ProviderSettings,
	type ReasoningEffortExtended,
} from "@roo-code/types"

import type { ProfileModelPatch } from "./profileModelPatches"

export type ReasoningOption = ReasoningEffortExtended | "disable"

export interface ReasoningSelection {
	supportedOptions: readonly ReasoningOption[]
	currentEffort: ReasoningOption | undefined
	reasoningEnabled: boolean
}

const MANUAL_OPTIONS: readonly ReasoningOption[] = ["disable", "low", "medium", "high", "xhigh", "max"]

/** Pure effective selection; unlike Settings, this never persists normalized defaults on mount. */
export function getReasoningSelection(config: ProviderSettings, modelInfo?: ModelInfo): ReasoningSelection {
	const manual = config.apiProvider === providerIdentifiers.openai
	const supports = modelInfo?.supportsReasoningEffort
	const required = !manual && modelInfo?.requiredReasoningEffort === true
	const supportedOptions: readonly ReasoningOption[] = manual
		? MANUAL_OPTIONS
		: supports === true
			? required
				? reasoningEfforts
				: ["disable", ...reasoningEfforts]
			: Array.isArray(supports)
				? supports.filter((effort) => !required || effort !== "disable")
				: []
	if (!supportedOptions.length) {
		return {
			supportedOptions,
			currentEffort: undefined,
			reasoningEnabled:
				!!modelInfo &&
				(modelInfo.requiredReasoningBudget === true ||
					((modelInfo.supportsReasoningBinary || modelInfo.supportsReasoningBudget) === true &&
						config.enableReasoningEffort === true)),
		}
	}

	const stored = manual ? config.openAiCustomModelInfo?.reasoningEffort : config.reasoningEffort
	const declaredDefault = manual ? undefined : modelInfo?.reasoningEffort
	// Match getGeminiReasoning: thinking levels ignore the legacy enable flag,
	// reject non-level efforts, and use the model default for unsupported levels.
	if (config.apiProvider === providerIdentifiers.gemini) {
		const levels: readonly ReasoningOption[] = ["minimal", "low", "medium", "high"]
		const selected = stored ?? declaredDefault
		const effective =
			selected && levels.includes(selected) && Array.isArray(supports) && !supports.includes(selected)
				? declaredDefault
				: selected
		const currentEffort = effective && levels.includes(effective) ? effective : undefined
		return { supportedOptions, currentEffort, reasoningEnabled: currentEffort !== undefined }
	}
	const defaultEffort = declaredDefault ?? (manual ? "low" : required ? "medium" : "disable")
	const fallback = supportedOptions.includes(defaultEffort) ? defaultEffort : supportedOptions[0]
	// A false flag must not display an enabled effort; unset still follows model defaults.
	const disabled =
		!required && (manual ? config.enableReasoningEffort !== true : config.enableReasoningEffort === false)
	const currentEffort = disabled
		? supportedOptions.includes("disable")
			? "disable"
			: undefined
		: stored && supportedOptions.includes(stored)
			? stored
			: fallback
	return {
		supportedOptions,
		currentEffort,
		reasoningEnabled: currentEffort !== undefined && currentEffort !== "disable",
	}
}

/** Pass modelInfo to reject choices outside the advertised capability. Without it, validates
 * the wire enum only (manual OpenAI choices are always validated). Null restores defaults.
 */
export function createReasoningPatch(
	config: ProviderSettings,
	effort: ReasoningOption | null,
	modelInfo?: ModelInfo,
): ProfileModelPatch {
	const manual = config.apiProvider === providerIdentifiers.openai
	if (
		effort !== null &&
		(!reasoningEffortSettingValues.includes(effort) ||
			((manual || modelInfo !== undefined) &&
				!getReasoningSelection(config, modelInfo).supportedOptions.includes(effort)))
	) {
		throw new Error("Unsupported reasoning effort")
	}
	if (manual) {
		return {
			enableReasoningEffort: effort === null ? null : effort !== "disable",
			reasoningEffort: null,
			openAiCustomModelInfo: { reasoningEffort: effort === "disable" ? null : effort },
		}
	}
	return { reasoningEffort: effort, enableReasoningEffort: effort === null ? null : effort !== "disable" }
}
