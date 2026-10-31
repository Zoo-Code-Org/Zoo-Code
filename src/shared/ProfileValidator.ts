import { getModelId, type ProviderSettings, type OrganizationAllowList } from "@roo-code/types"

export class ProfileValidator {
	public static isProfileAllowed(profile: ProviderSettings, allowList: OrganizationAllowList): boolean {
		if (allowList.allowAll) {
			return true
		}

		if (!profile.apiProvider) {
			return false
		}

		if (!this.isProviderAllowed(profile.apiProvider, allowList)) {
			return false
		}

		const modelId = getModelId(profile)

		if (!modelId) {
			return allowList.providers[profile.apiProvider]?.allowAll === true
		}

		return this.isModelAllowed(profile.apiProvider, modelId, allowList)
	}

	private static isProviderAllowed(providerName: string, allowList: OrganizationAllowList): boolean {
		if (allowList.allowAll) {
			return true
		}

		return providerName in allowList.providers
	}

	private static isModelAllowed(providerName: string, modelId: string, allowList: OrganizationAllowList): boolean {
		if (allowList.allowAll) {
			return true
		}

		const providerAllowList = allowList.providers[providerName]

		if (!providerAllowList) {
			return false
		}

		if (providerAllowList.allowAll) {
			return true
		}

		return providerAllowList.models?.includes(modelId) ?? false
	}
}
