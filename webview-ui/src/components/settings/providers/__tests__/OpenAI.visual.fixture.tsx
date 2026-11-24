/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { createFixtureTranslation } from "@src/i18n/__tests__/createFixtureI18n.visual.i18n"
import { TooltipProvider } from "@src/components/ui/tooltip"
import { OpenAI } from "../OpenAI"

const translation = createFixtureTranslation({
	"settings:providers.useCustomBaseUrl": "Use custom base URL",
	"settings:providers.useCustomDeploymentName": "Use custom deployment name",
	"settings:providers.openAiNativeDeploymentName": "Deployment name",
	"settings:providers.openAiNativeDeploymentNamePlaceholder": "my-deployment",
	"settings:providers.openAiNativeDeploymentNameDescription":
		"Sent as the model in API requests instead of the selected model. Use it when your endpoint addresses models by deployment name, such as Azure AI Foundry. Capabilities and pricing still come from the selected model.",
	"settings:providers.openAiApiKey": "OpenAI API Key",
	"settings:providers.apiKeyStorageNotice": "API keys are stored securely in VS Code's Secret Storage",
	"settings:placeholders.apiKey": "Enter API Key...",
})

const apiConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.openaiNative,
	openAiNativeApiKey: "sk-test-key",
	openAiNativeDeploymentName: "my-azure-deployment",
}

export const OpenAIDeploymentNameFixture = () => (
	<TranslationContext.Provider value={translation}>
		<TooltipProvider>
			<div className="flex w-[480px] max-w-full flex-col gap-3 bg-vscode-editor-background p-4 text-vscode-foreground">
				<OpenAI apiConfiguration={apiConfiguration} setApiConfigurationField={() => {}} />
			</div>
		</TooltipProvider>
	</TranslationContext.Provider>
)
