import type { OrganizationAllowList } from "./cloud.js"
import type { ProviderName } from "./provider-settings.js"

/**
 * Whether organization policy allows an arbitrary/custom model id for a provider.
 *
 * Only providers that are explicitly `allowAll` may use free-form ids; when a
 * provider is narrowed to an allow-list, callers must not expose a custom-model
 * escape hatch. This is the single source of truth shared by the settings
 * model picker and the chat model selector.
 */
export const isProviderAllowAll = (
	allowList: OrganizationAllowList | undefined,
	provider: ProviderName | undefined,
): boolean => {
	if (!allowList || allowList.allowAll) {
		return true
	}

	if (!provider) {
		return false
	}

	return allowList.providers[provider]?.allowAll === true
}

/**
 * Whether organization policy allows selecting the given model id for a provider.
 *
 * `allowAll` (org-wide or per provider) permits any id; otherwise the id must be
 * present in the provider's explicit `models` list. Intended as a defense-in-depth
 * check that rejects a selection regardless of how it was produced (option click,
 * keyboard navigation, or custom entry).
 */
export const isModelAllowedForOrganization = (
	allowList: OrganizationAllowList | undefined,
	provider: ProviderName | undefined,
	modelId: string,
): boolean => {
	if (!allowList || allowList.allowAll) {
		return true
	}

	if (!provider) {
		return false
	}

	const providerConfig = allowList.providers[provider]
	if (!providerConfig) {
		return false
	}

	return providerConfig.allowAll === true || (providerConfig.models?.includes(modelId) ?? false)
}
