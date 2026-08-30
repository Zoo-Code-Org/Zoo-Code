import React, { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"

import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { TranslationProvider } from "@/i18n/TranslationContext"
import i18next, { loadTranslations } from "@/i18n/setup"
import { TooltipProvider } from "@/components/ui/tooltip"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"

loadTranslations()

type InitialState = NonNullable<React.ComponentProps<typeof ExtensionStateContextProvider>["initialState"]>

interface AppProvidersProps {
	children: React.ReactNode
	initialState?: InitialState
}

const defaultInitialState: InitialState = {
	language: "en",
	clineMessages: [],
	taskHistory: [],
	shouldShowAnnouncement: false,
	telemetrySetting: "enabled",
	apiConfiguration: { apiProvider: "anthropic" },
	currentApiConfigName: "Default",
	listApiConfigMeta: [{ id: "default", name: "Default", modelId: "claude-sonnet" }],
	pinnedApiConfigs: {},
	hasOpenedModeSelector: true,
}

export function AppProviders({ children, initialState }: AppProvidersProps) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
	)

	return (
		<I18nextProvider i18n={i18next}>
			<ExtensionStateContextProvider initialState={{ ...defaultInitialState, ...initialState }}>
				<TranslationProvider>
					<PlaywrightTranslationContext.Provider
						value={{ t: (key, options) => i18next.t(key, options), i18n: i18next }}>
						<QueryClientProvider client={queryClient}>
							<TooltipProvider>
								<div data-testid="ct-app-shell">{children}</div>
							</TooltipProvider>
						</QueryClientProvider>
					</PlaywrightTranslationContext.Provider>
				</TranslationProvider>
			</ExtensionStateContextProvider>
		</I18nextProvider>
	)
}
