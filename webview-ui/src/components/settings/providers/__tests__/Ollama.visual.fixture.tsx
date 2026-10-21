/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React, { useState } from "react"
import i18next from "i18next"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import { TooltipProvider } from "@src/components/ui/tooltip"
import { Ollama } from "../Ollama"
import enSettings from "@/i18n/locales/en/settings.json"

function flattenTranslations(obj: Record<string, unknown>, prefix = "settings:"): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = `${prefix}${key}`
		if (typeof value === "string") {
			result[fullKey] = value
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			Object.assign(result, flattenTranslations(value as Record<string, unknown>, `${fullKey}.`))
		}
	}
	return result
}

// An uninitialized instance is a valid `i18n` for the context. The stories read `t`.
const i18n = i18next.createInstance()

const translations = flattenTranslations(enSettings as Record<string, unknown>)

const apiConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.ollama,
	ollamaBaseUrl: "http://localhost:11434",
	ollamaApiKey: "",
	ollamaModelId: "",
}

const Providers = ({ children }: React.PropsWithChildren) => {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
	)

	return (
		<PlaywrightTranslationContext.Provider
			value={{
				t: (key) => translations[key] ?? key,
				i18n,
			}}>
			<AppTranslationContext.Provider
				value={{
					t: (key) => translations[key] ?? key,
					i18n,
				}}>
				<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
			</AppTranslationContext.Provider>
		</PlaywrightTranslationContext.Provider>
	)
}

export const OllamaApiKeyHelpFixture = () => (
	<Providers>
		<TooltipProvider>
			<div className="w-[480px] max-w-full bg-vscode-editor-background p-4 text-vscode-foreground">
				<Ollama apiConfiguration={apiConfiguration} setApiConfigurationField={() => {}} />
			</div>
		</TooltipProvider>
	</Providers>
)
