import {
	getModelId,
	isRetiredProvider,
	providerIdentifiers,
	type ModelInfo,
	type OrganizationAllowList,
	type ProviderSettings,
} from "@roo-code/types"

/** Apply the same organization and Bedrock restrictions to catalog and custom IDs. */
export function isPickerModelAllowed(config: ProviderSettings, id: string, allowList?: OrganizationAllowList): boolean {
	const provider = config.apiProvider ?? providerIdentifiers.openrouter
	if (isRetiredProvider(provider)) return false
	if (
		provider === providerIdentifiers.bedrock &&
		(id.trim().startsWith("arn:") || (id === "custom-arn" && !config.awsCustomArn))
	)
		return false
	if (!allowList || allowList.allowAll) return true
	const rule = allowList.providers[provider]
	return !!rule && (rule.allowAll || !!rule.models?.includes(id))
}

/** A configured string is authoritative, even when discovery validates it to a default. */
export function getPickerSelection(
	config: ProviderSettings,
	fallback: { id?: string; info?: ModelInfo },
	allowList?: OrganizationAllowList,
): { id: string | undefined; info: ModelInfo | undefined } {
	const id = getModelId(config) || fallback.id
	if (!id || !isPickerModelAllowed(config, id, allowList)) return { id: undefined, info: undefined }
	return { id, info: id === fallback.id ? fallback.info : undefined }
}

/** Check the raw catalog, not the filtered/visible rows: deprecated IDs are not custom. */
export function getCustomModelId(
	input: string,
	config: ProviderSettings,
	models: Record<string, ModelInfo> | null,
	allowList?: OrganizationAllowList,
): string | undefined {
	const id = input.trim()
	return id &&
		id !== getModelId(config) &&
		!Object.prototype.hasOwnProperty.call(models ?? {}, id) &&
		isPickerModelAllowed(config, id, allowList)
		? id
		: undefined
}
