import {
	isRetiredProvider,
	providerIdentifiers,
	type ProviderSettings,
	type ReasoningEffortExtended,
} from "@roo-code/types"

import { getProviderModelConfig, handleModelChangeSideEffects } from "@/components/settings/utils/providerModelConfig"

/** Wire patch for updateProfileModel.values.patch. Null deletes; nested metadata is effort-only. */
export type ProfileModelPatch = {
	[K in Exclude<keyof ProviderSettings, "openAiCustomModelInfo">]?: ProviderSettings[K] | null
} & { openAiCustomModelInfo?: { reasoningEffort: ReasoningEffortExtended | null } }

export function createModelPatch(config: ProviderSettings, id: string): ProfileModelPatch {
	const provider = config.apiProvider ?? providerIdentifiers.openrouter
	if (isRetiredProvider(provider)) throw new Error("A supported provider is required")
	const field = getProviderModelConfig(provider, config)?.field
	if (!field || !id.trim()) throw new Error("A supported provider and non-empty model ID are required")
	if (
		provider === providerIdentifiers.bedrock &&
		(id.trim().startsWith("arn:") || (id === "custom-arn" && !config.awsCustomArn))
	) {
		throw new Error("Configure a custom Bedrock ARN in Settings")
	}

	const patch: ProfileModelPatch = { [field]: id, enableReasoningEffort: null }
	handleModelChangeSideEffects(provider, id, (key, value) => {
		Object.assign(patch, { [key]: value === undefined || value === "" ? null : value })
	})
	if (provider === providerIdentifiers.openai) patch.openAiCustomModelInfo = { reasoningEffort: null }
	return patch
}
