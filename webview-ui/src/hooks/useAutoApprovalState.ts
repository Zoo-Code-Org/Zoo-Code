import { useMemo } from "react"

interface AutoApprovalToggles {
	alwaysAllowReadOnly?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowFollowupQuestions?: boolean
}

export function useAutoApprovalState(toggles: AutoApprovalToggles, autoApprovalEnabled?: boolean, yoloMode?: boolean) {
	const hasEnabledOptions = useMemo(() => {
		return Object.values(toggles).some((value) => !!value)
	}, [toggles])

	const effectiveAutoApprovalEnabled = useMemo(() => {
		return yoloMode === true || autoApprovalEnabled === true
	}, [autoApprovalEnabled, yoloMode])

	return {
		hasEnabledOptions,
		effectiveAutoApprovalEnabled,
	}
}
