import type { ProviderSettings } from "@roo-code/types"

export type TaskExecutionContext = {
	mode: string
	apiConfigName: string | undefined
	apiConfiguration: ProviderSettings
}

export type SavedModeProfile = {
	name?: string
	apiConfiguration: ProviderSettings
}

export function selectHandoffExecutionContext(
	parent: TaskExecutionContext,
	requestedMode: string,
	parentMode: string,
	lockApiConfigAcrossModes: boolean,
	savedModeProfile?: SavedModeProfile,
): TaskExecutionContext {
	if (requestedMode !== parentMode && !lockApiConfigAcrossModes && savedModeProfile?.apiConfiguration.apiProvider) {
		return {
			mode: requestedMode,
			apiConfigName: savedModeProfile.name,
			apiConfiguration: structuredClone(savedModeProfile.apiConfiguration),
		}
	}

	return {
		mode: requestedMode,
		apiConfigName: parent.apiConfigName,
		apiConfiguration: structuredClone(parent.apiConfiguration),
	}
}

export function getEffectiveTaskApiConfiguration(
	apiConfiguration: ProviderSettings,
	handoffExecutionContext?: TaskExecutionContext,
): ProviderSettings {
	return handoffExecutionContext?.apiConfiguration ?? apiConfiguration
}
