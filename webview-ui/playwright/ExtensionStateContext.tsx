import React, { createContext, useContext } from "react"
import { providerIdentifiers } from "@roo-code/types"

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
	apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
	enterBehavior: "send",
	lockApiConfigAcrossModes: false,
	telemetrySetting: "enabled",
	togglePinnedApiConfig: noop,
	setHasOpenedModeSelector: noop,
	setApiConfiguration: noop,
}

export const ExtensionStateContext = createContext<Record<string, unknown>>(defaultState)

export function ExtensionStateContextProvider({
	children,
	initialState,
}: {
	children: React.ReactNode
	initialState?: Record<string, unknown>
}) {
	return (
		<ExtensionStateContext.Provider value={{ ...defaultState, ...initialState }}>
			{children}
		</ExtensionStateContext.Provider>
	)
}

export const useExtensionState = () => useContext(ExtensionStateContext)
