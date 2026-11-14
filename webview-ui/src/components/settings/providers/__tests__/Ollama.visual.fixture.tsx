/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React, { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { createFixtureTranslation } from "@src/i18n/__tests__/createFixtureI18n.visual.i18n"
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

const translation = createFixtureTranslation(flattenTranslations(enSettings as Record<string, unknown>))

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
		<TranslationContext.Provider value={translation}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</TranslationContext.Provider>
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
