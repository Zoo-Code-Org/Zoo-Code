import React from "react"

import { OpenAiServiceTier, type ModelInfo } from "@roo-code/types/model"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { I18nextProvider } from "react-i18next"

import { createFixtureI18n } from "@src/i18n/__tests__/createFixtureI18n.visual.i18n"
import { ModelInfoView } from "../ModelInfoView"

const modelInfo: ModelInfo = {
	contextWindow: 400_000,
	maxTokens: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 2,
	outputPrice: 8,
	cacheReadsPrice: 0.5,
	tiers: [
		{
			name: OpenAiServiceTier.Flex,
			contextWindow: 400_000,
			inputPrice: 1,
			outputPrice: 4,
			cacheReadsPrice: 0.25,
		},
		{
			name: OpenAiServiceTier.Priority,
			contextWindow: 400_000,
			inputPrice: 3.5,
			outputPrice: 14,
			cacheReadsPrice: 0.875,
		},
	],
}

const translations: Record<string, string> = {
	"settings:modelInfo.contextWindow": "Context window:",
	"settings:modelInfo.maxOutput": "Max output",
	"settings:modelInfo.supportsImages": "Supports images",
	"settings:modelInfo.noImages": "Does not support images",
	"settings:modelInfo.supportsPromptCache": "Supports prompt caching",
	"settings:modelInfo.noPromptCache": "Does not support prompt caching",
	"settings:serviceTier.pricingTableTitle": "Service tier pricing (per 1M tokens)",
	"settings:serviceTier.columns.tier": "Tier",
	"settings:serviceTier.columns.input": "Input",
	"settings:serviceTier.columns.output": "Output",
	"settings:serviceTier.columns.cacheReads": "Cache reads",
	"settings:serviceTier.standard": "Standard",
	"settings:serviceTier.flex": "Flex",
	"settings:serviceTier.priority": "Priority",
}

const i18n = createFixtureI18n(translations)

export const ModelInfoViewFixture = () => (
	<I18nextProvider i18n={i18n}>
		<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
			<ModelInfoView
				apiProvider={providerIdentifiers.openaiNative}
				selectedModelId="gpt-5.2"
				modelInfo={modelInfo}
				isDescriptionExpanded={false}
				setIsDescriptionExpanded={() => {}}
			/>
		</div>
	</I18nextProvider>
)
