export interface ProviderProfileRef {
	name: string
	id?: string
}

export interface ProviderHandoffPolicy {
	targetTask: null
	mutateExposedTask: boolean
	publishWhilePending: boolean
	applyProviderSettingsToContext: boolean
}

export const PRODUCTION_PROVIDER_HANDOFF_POLICY = {
	targetTask: null,
	mutateExposedTask: false,
	publishWhilePending: false,
	applyProviderSettingsToContext: true,
} as const satisfies ProviderHandoffPolicy

export function createProviderHandoffPlan(requestedMode: string) {
	return {
		requestedMode,
		policy: PRODUCTION_PROVIDER_HANDOFF_POLICY,
	} as const
}

export type ProviderHandoffProfileDecision =
	| { source: "locked-current"; profile?: ProviderProfileRef }
	| { source: "saved"; profile: ProviderProfileRef }
	| { source: "unsaved-current"; profile?: ProviderProfileRef; persistModeProfileId?: string }

export function decideProviderHandoffProfile(params: {
	locked: boolean
	currentProfile?: ProviderProfileRef
	savedProfile?: ProviderProfileRef
}): ProviderHandoffProfileDecision {
	const { locked, currentProfile, savedProfile } = params
	if (locked) return { source: "locked-current", profile: currentProfile }
	if (savedProfile) return { source: "saved", profile: savedProfile }
	return {
		source: "unsaved-current",
		profile: currentProfile,
		persistModeProfileId: currentProfile?.id,
	}
}

export function getProviderHandoffActivationOptions(policy: ProviderHandoffPolicy) {
	return {
		skipCurrentTaskRebuild: !policy.mutateExposedTask,
		applyProviderSettingsToContext: policy.applyProviderSettingsToContext,
		suppressStatePost: !policy.publishWhilePending,
	}
}
