/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ProviderSettings } from "@roo-code/types"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import { TooltipProvider } from "@src/components/ui/tooltip"
import { OpenAICompatible } from "../OpenAICompatible"

const translations: Record<string, string> = {
	"settings:providers.openAiBaseUrl": "Base URL",
	"settings:providers.azureOpenAiBaseUrlPlaceholder": "https://<resource>.openai.azure.com/openai",
	"settings:providers.apiKey": "API Key",
	"settings:placeholders.apiKey": "Enter API key",
	"settings:providers.azureOpenAiDeploymentName": "Azure deployment name",
	"settings:providers.azureOpenAiDeploymentNameDescription":
		"Enter the deployment name from Azure AI Studio, not the underlying model name.",
	"settings:modelPicker.simplifiedExplanation": "You can adjust detailed model settings later.",
	"settings:modelInfo.enableR1Format": "Enable R1 model parameters",
	"settings:modelInfo.enableR1FormatTips": "Enable this only for R1-compatible models.",
	"settings:modelInfo.enableStreaming": "Enable streaming",
	"settings:includeMaxOutputTokens": "Include max output tokens",
	"settings:includeMaxOutputTokensDescription": "Send the configured maximum output token limit.",
	"settings:modelInfo.useAzure": "Use Azure",
	"settings:modelInfo.azureApiVersion": "Set Azure API version",
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false },
	},
})

const apiConfiguration: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "",
	openAiModelId: "my-gpt4o-deployment",
	openAiUseAzure: true,
}

export const OpenAICompatibleAzureFixture = () => (
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
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<div className="h-[295px] w-[480px] overflow-hidden bg-vscode-editor-background p-4 text-vscode-foreground">
						<OpenAICompatible
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={() => {}}
							organizationAllowList={{ allowAll: true, providers: {} }}
							simplifySettings
						/>
					</div>
				</TooltipProvider>
			</QueryClientProvider>
		</AppTranslationContext.Provider>
	</PlaywrightTranslationContext.Provider>
)
