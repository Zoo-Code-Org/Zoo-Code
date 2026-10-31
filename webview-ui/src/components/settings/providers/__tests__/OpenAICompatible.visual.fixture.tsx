/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React, { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { I18nextProvider } from "react-i18next"

import { createFixtureI18n } from "@src/i18n/__tests__/createFixtureI18n.visual.i18n"
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

const i18n = createFixtureI18n(flattenTranslations(enSettings as Record<string, unknown>))

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
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</I18nextProvider>
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
			<div className="w-[480px] max-w-full bg-vscode-editor-background p-4 text-vscode-foreground">
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
