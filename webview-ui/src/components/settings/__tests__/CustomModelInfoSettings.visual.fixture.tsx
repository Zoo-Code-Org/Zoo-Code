/* v8 ignore file -- Playwright component fixture; covered by the visual test. */
import React from "react"

import type { ModelInfo } from "@roo-code/types/model"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { CustomModelInfoSettings } from "../CustomModelInfoSettings"

const selectedModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 64_000,
	supportsImages: true,
	supportsPromptCache: true,
}

const translations: Record<string, string> = {
	"settings:providers.customModelInfo.title": "Custom model metadata",
	"settings:providers.customModelInfo.description":
		"Override context and capability metadata when the provider cannot detect your model accurately.",
	"settings:providers.customModelInfo.unresolved":
		"Model metadata is unavailable. Enter the context window to enable accurate token tracking.",
	"settings:providers.customModelInfo.contextWindow.label": "Context window",
	"settings:providers.customModelInfo.contextWindow.description":
		"Total tokens the model can process, including input and output.",
	"settings:providers.customModelInfo.maxTokens.label": "Max output tokens",
	"settings:providers.customModelInfo.maxTokens.description":
		"Maximum number of tokens the model can generate in one response.",
	"settings:providers.customModelInfo.supportsImages.label": "Supports images",
	"settings:providers.customModelInfo.supportsImages.description":
		"Override whether the model accepts image content.",
	"settings:providers.customModelInfo.supportsPromptCache.label": "Supports prompt caching",
	"settings:providers.customModelInfo.supportsPromptCache.description":
		"Override whether prompt caching is supported.",
	"settings:providers.customModelInfo.maxTokensWarning": "Max output tokens exceed the context window.",
	"settings:providers.customModelInfo.reset": "Reset to detected values",
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
				apiConfiguration={{ apiProvider: "zoo-gateway" }}
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
					apiProvider: "zoo-gateway",
					customModelInfo: { contextWindow: 100_000, maxTokens: 10_000, supportsImages: false },
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
					apiProvider: "zoo-gateway",
					customModelInfo: { contextWindow: 1000, maxTokens: 2000 },
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
				apiConfiguration={{ apiProvider: "zoo-gateway" }}
				setApiConfigurationField={() => {}}
				selectedModelInfo={undefined}
			/>
		</div>
	</TranslationContext.Provider>
)
