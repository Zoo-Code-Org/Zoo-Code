/* v8 ignore file -- Playwright component fixture; covered by the visual test. */
import React from "react"

import { providerIdentifiers } from "@roo-code/types"
import type { ModelInfo } from "@roo-code/types/model"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { CustomModelInfoSettings } from "../CustomModelInfoSettings"

const selectedModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 64_000,
	supportsImages: true,
	supportsPromptCache: true,
}

// Mirrors the English strings the panel actually renders: the terminology keys
// are shared with the OpenAI-compatible custom-model editor, so only the
// panel-specific copy lives under `customModelInfo`.
const translations: Record<string, string> = {
	"settings:providers.customModelInfo.title": "Custom model metadata",
	"settings:providers.customModelInfo.description":
		"Override context and capability metadata when the provider cannot detect your model accurately.",
	"settings:providers.customModelInfo.unresolved":
		"This model is not in the provider catalog. The values below start from safe defaults — adjust them to match the model.",
	"settings:providers.customModelInfo.maxTokens.description":
		"Maximum number of tokens the model can generate in one response.",
	"settings:providers.customModelInfo.maxTokensWarning": "Max output tokens exceed the context window.",
	"settings:providers.customModel.contextWindow.label": "Context Window Size",
	"settings:providers.customModel.contextWindow.description": "Total tokens (input + output) the model can process.",
	"settings:providers.customModel.maxTokens.label": "Max Output Tokens",
	"settings:providers.customModel.imageSupport.label": "Image Support",
	"settings:providers.customModel.imageSupport.description":
		"Is this model capable of processing and understanding images?",
	"settings:providers.customModel.promptCache.label": "Prompt Caching",
	"settings:providers.customModel.promptCache.description": "Is this model capable of caching prompts?",
	"settings:providers.customModel.resetDefaults": "Reset to Defaults",
}

const translationValue = {
	t: (key: string) => translations[key] ?? key,
	i18n: null as unknown as typeof import("../../../i18n/setup").default,
}

/** Collapsed panel — the default when selectedModelInfo is present. */
export const CollapsedFixture = () => (
	<TranslationContext.Provider value={translationValue}>
		<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: providerIdentifiers.zooGateway }}
				setApiConfigurationField={() => {}}
				selectedModelInfo={selectedModelInfo}
			/>
		</div>
	</TranslationContext.Provider>
)

/** Expanded panel with populated overrides. */
export const ExpandedWithOverridesFixture = () => (
	<TranslationContext.Provider value={translationValue}>
		<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: providerIdentifiers.zooGateway,
					customModelInfo: { contextWindow: 100_000, maxTokens: 10_000, supportsImages: false, supportsPromptCache: false },
				}}
				setApiConfigurationField={() => {}}
				selectedModelInfo={selectedModelInfo}
			/>
		</div>
	</TranslationContext.Provider>
)

/** Expanded panel with maxTokens > contextWindow warning. */
export const WarningFixture = () => (
	<TranslationContext.Provider value={translationValue}>
		<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: providerIdentifiers.zooGateway,
					customModelInfo: { contextWindow: 1000, maxTokens: 2000, supportsPromptCache: false },
				}}
				setApiConfigurationField={() => {}}
				selectedModelInfo={selectedModelInfo}
			/>
		</div>
	</TranslationContext.Provider>
)

/** Expanded panel with no selectedModelInfo (unresolved model — auto-opens). */
export const UnresolvedFixture = () => (
	<TranslationContext.Provider value={translationValue}>
		<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: providerIdentifiers.zooGateway }}
				setApiConfigurationField={() => {}}
				selectedModelInfo={undefined}
			/>
		</div>
	</TranslationContext.Provider>
)
