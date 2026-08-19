import React, { createContext, useContext, useMemo, useState } from "react"

const noop = () => undefined

const defaultState = {
	language: "en",
	clineMessages: [],
	taskHistory: [],
	filePaths: [],
	openedTabs: [],
	commands: [],
	customModes: [],
	customModePrompts: {},
	currentApiConfigName: "Default",
	listApiConfigMeta: [{ id: "default", name: "Default", modelId: "claude-sonnet" }],
	pinnedApiConfigs: {},
	apiConfiguration: { apiProvider: "anthropic" },
	enterBehavior: "send",
	lockApiConfigAcrossModes: false,
	telemetrySetting: "enabled",
	autoApprovalEnabled: false,
	togglePinnedApiConfig: noop,
	setHasOpenedModeSelector: noop,
	setApiConfiguration: noop,
	setAutoApprovalEnabled: noop,
}

export const ExtensionStateContext = createContext<Record<string, unknown>>(defaultState)

export function ExtensionStateContextProvider({
	children,
	initialState,
}: {
	children: React.ReactNode
	initialState?: Record<string, unknown>
}) {
	const initialAutoApprovalEnabled = initialState?.autoApprovalEnabled
	const [autoApprovalEnabled, setAutoApprovalEnabled] = useState(
		typeof initialAutoApprovalEnabled === "boolean" ? initialAutoApprovalEnabled : defaultState.autoApprovalEnabled,
	)
	const value = useMemo(
		() => ({ ...defaultState, ...initialState, autoApprovalEnabled, setAutoApprovalEnabled }),
		[autoApprovalEnabled, initialState],
	)

	return (
		<ExtensionStateContext.Provider value={value}>{children}</ExtensionStateContext.Provider>
	)
}

export const useExtensionState = () => useContext(ExtensionStateContext)
