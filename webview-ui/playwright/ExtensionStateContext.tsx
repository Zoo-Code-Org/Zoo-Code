/* v8 ignore file -- Playwright CT-only replacement for the extension-host state provider. */
import React, { createContext, useContext, useMemo, useState } from "react"

type VisualExtensionState = {
	autoApprovalEnabled?: boolean
	alwaysAllowReadOnly?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowFollowupQuestions?: boolean
	setAutoApprovalEnabled: (value: boolean) => void
}

type ExtensionStateContextProviderProps = {
	children: React.ReactNode
	initialState?: Omit<VisualExtensionState, "setAutoApprovalEnabled">
}

export const ExtensionStateContext = createContext<VisualExtensionState | undefined>(undefined)

export const ExtensionStateContextProvider = ({ children, initialState = {} }: ExtensionStateContextProviderProps) => {
	const [autoApprovalEnabled, setAutoApprovalEnabled] = useState(initialState.autoApprovalEnabled)

	const value = useMemo(
		() => ({ ...initialState, autoApprovalEnabled, setAutoApprovalEnabled }),
		[autoApprovalEnabled, initialState],
	)

	return <ExtensionStateContext.Provider value={value}>{children}</ExtensionStateContext.Provider>
}

export const useExtensionState = () => {
	const context = useContext(ExtensionStateContext)

	if (!context) {
		throw new Error("useExtensionState must be used within an ExtensionStateContextProvider")
	}

	return context
}
