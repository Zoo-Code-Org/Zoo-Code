/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React, { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import { TooltipProvider } from "@src/components/ui/tooltip"
import { OpenAICompatible } from "../OpenAICompatible"
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

const translations = flattenTranslations(enSettings as Record<string, unknown>)

const apiConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.openai,
	openAiBaseUrl: "",
	openAiModelId: "my-gpt4o-deployment",
	openAiUseAzure: true,
}

const extraBodyApiConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.openai,
	openAiBaseUrl: "https://api.sailresearch.com/v1",
	openAiModelId: "zai-org/GLM-5.2-FP8",
	openAiExtraBody: JSON.stringify({ metadata: { completion_window: "balanced" } }, null, 2),
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
				i18n: null as unknown as typeof import("../../../../i18n/setup").default,
			}}>
			<AppTranslationContext.Provider
				value={{
					t: (key) => translations[key] ?? key,
					i18n: null as unknown as typeof import("../../../../i18n/setup").default,
				}}>
				<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
			</AppTranslationContext.Provider>
		</PlaywrightTranslationContext.Provider>
	)
}

export const OpenAICompatibleAzureFixture = () => (
	<Providers>
		<TooltipProvider>
			<div className="w-[480px] max-w-full bg-vscode-editor-background p-4 text-vscode-foreground">
				<OpenAICompatible
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={() => {}}
					organizationAllowList={{ allowAll: true, providers: {} }}
					simplifySettings
				/>
			</div>
		</TooltipProvider>
	</Providers>
)

export const OpenAICompatibleExtraBodyFixture = () => (
	<Providers>
		<TooltipProvider>
			<div className="h-[660px] w-[480px] overflow-hidden bg-vscode-editor-background p-4 text-vscode-foreground">
				<OpenAICompatible
					apiConfiguration={extraBodyApiConfiguration}
					setApiConfigurationField={() => {}}
					organizationAllowList={{ allowAll: true, providers: {} }}
					simplifySettings
				/>
			</div>
		</TooltipProvider>
	</Providers>
)
