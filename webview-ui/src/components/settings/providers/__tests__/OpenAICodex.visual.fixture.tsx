/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { OpenAiCodexServiceTier } from "@roo-code/types/model"

import { I18nextProvider } from "react-i18next"

import { createFixtureI18n } from "@src/i18n/__tests__/createFixtureI18n.visual.i18n"
import { TooltipProvider } from "@src/components/ui/tooltip"
import { OpenAICodexSpeedSelector } from "../OpenAICodexSpeedSelector"

const translations: Record<string, string> = {
	"settings:common.select": "Select",
	"settings:openAiCodexSpeed.label": "Speed",
	"settings:openAiCodexSpeed.tooltip":
		"Fast uses Codex priority processing for about 1.5x speed and consumes more subscription quota.",
	"settings:openAiCodexSpeed.standard": "Standard",
	"settings:openAiCodexSpeed.fast": "Fast (1.5x speed, increased usage)",
}

const i18n = createFixtureI18n(translations)

export const OpenAICodexFixture = () => (
	<I18nextProvider i18n={i18n}>
		<TooltipProvider>
			<div className="flex w-[480px] flex-col gap-4 bg-vscode-editor-background p-4 text-vscode-foreground">
				<OpenAICodexSpeedSelector value={OpenAiCodexServiceTier.Default} onValueChange={() => {}} />
				<OpenAICodexSpeedSelector value={OpenAiCodexServiceTier.Priority} onValueChange={() => {}} />
			</div>
		</TooltipProvider>
	</I18nextProvider>
)
