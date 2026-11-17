import {
	modelIdKeys,
	modelInfoSchema,
	openAiModelInfoSaneDefaults,
	providerDefinitionList,
	providerIdentifiers,
	providerSettingsSchema,
	reasoningEffortSettingSchema,
	type ProviderSettings,
} from "@roo-code/types"

// These fields remain reset-only: in particular, an ARN cannot bypass the model allow-list.
const RESET_ONLY_KEYS = [
	"modelMaxTokens",
	"modelMaxThinkingTokens",
	"awsCustomArn",
	"awsCustomArnBaseModelId",
	"awsModelContextWindow",
] as const satisfies readonly (keyof ProviderSettings)[]

function requireRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("A model patch must be an object")
	}

	return value as Record<string, unknown>
}

function mergeCustomReasoningEffort(
	stored: ProviderSettings["openAiCustomModelInfo"],
	value: unknown,
): ProviderSettings["openAiCustomModelInfo"] {
	const patch = requireRecord(value)

	if (Object.keys(patch).some((key) => key !== "reasoningEffort")) {
		throw new Error("Only reasoningEffort may be patched in openAiCustomModelInfo")
	}

	if (!Object.hasOwn(patch, "reasoningEffort")) return stored

	if (patch.reasoningEffort === null || patch.reasoningEffort === undefined) {
		if (!stored) return stored
		const { reasoningEffort: _effort, ...rest } = stored
		return rest
	}

	// Model metadata uses the wire effort enum, not the top-level "disable" control value.
	const reasoningEffort = modelInfoSchema.shape.reasoningEffort.unwrap().parse(patch.reasoningEffort)
	return { ...(stored ?? openAiModelInfoSaneDefaults), reasoningEffort }
}

function enforceBedrockArnInvariant(merged: ProviderSettings): void {
	if (merged.apiProvider !== providerIdentifiers.bedrock) return

	if (merged.apiModelId === "custom-arn") {
		if (!merged.awsCustomArn) {
			throw new Error('Model "custom-arn" requires an existing custom ARN')
		}
	} else {
		// A retained ARN would override the allow-listed model, so drop its context fields too.
		delete merged.awsCustomArn
		delete merged.awsCustomArnBaseModelId
		delete merged.awsModelContextWindow
	}
}

/**
 * Merge only model/reasoning controls into the latest stored profile without mutating it.
 * Null/undefined clear controls; model IDs must be non-empty strings. Nested custom model
 * metadata is effort-only and uses its own schema. Organization validation remains the caller's job.
 */
export function mergeProfileModelPatch(
	stored: ProviderSettings,
	expectedProvider: string,
	patch: unknown,
): ProviderSettings {
	const apiProvider = stored.apiProvider ?? providerIdentifiers.anthropic
	const definition = providerDefinitionList.find((entry) => entry.apiProvider === expectedProvider)
	if (apiProvider !== expectedProvider || !definition) {
		throw new Error("Profile provider does not match a supported expected provider")
	}

	const modelIdKey = modelIdKeys.find((key) => key === definition.modelIdKey)
	const merged: ProviderSettings = { ...stored, apiProvider }

	for (const [key, value] of Object.entries(requireRecord(patch))) {
		if (modelIdKey !== undefined && key === modelIdKey) {
			if (typeof value !== "string" || value.trim().length === 0) {
				throw new Error(`Key "${key}" must be a non-empty string in a model patch`)
			}
			merged[modelIdKey] = value
		} else if (key === "reasoningEffort") {
			if (value === null || value === undefined) delete merged.reasoningEffort
			else merged.reasoningEffort = reasoningEffortSettingSchema.parse(value)
		} else if (key === "enableReasoningEffort") {
			if (value === null || value === undefined) delete merged.enableReasoningEffort
			else merged.enableReasoningEffort = providerSettingsSchema.shape.enableReasoningEffort.unwrap().parse(value)
		} else if (key === "openAiCustomModelInfo" && apiProvider === providerIdentifiers.openai) {
			merged.openAiCustomModelInfo = mergeCustomReasoningEffort(stored.openAiCustomModelInfo, value)
		} else {
			const resetKey = RESET_ONLY_KEYS.find((candidate) => candidate === key)
			if (!resetKey) throw new Error(`Key "${key}" is not allowed in a model patch`)
			if (value !== null && value !== undefined) {
				throw new Error(`Key "${key}" can only be cleared in a model patch`)
			}
			delete merged[resetKey]
		}
	}

	enforceBedrockArnInvariant(merged)
	return merged
}
