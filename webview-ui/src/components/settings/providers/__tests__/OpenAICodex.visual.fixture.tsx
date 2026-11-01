/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { OpenAiCodexServiceTier } from "@roo-code/types/model"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { TooltipProvider } from "@src/components/ui/tooltip"
import { OpenAICodexSpeedSelector } from "../OpenAICodexSpeedSelector"
import { OpenAICodexWebSocketToggle } from "../OpenAICodexWebSocketToggle"

const translations: Record<string, string> = {
	"settings:common.select": "Select",
	"settings:openAiCodexWebSocket.label": "Use WebSocket",
	"settings:openAiCodexWebSocket.description":
		"Keeps the ChatGPT connection open between requests. Uses HTTP if a WebSocket connection cannot be established.",
	"settings:openAiCodexSpeed.label": "Speed",
	"settings:openAiCodexSpeed.tooltip":
		"Fast uses Codex priority processing for about 1.5x speed and consumes more subscription quota.",
	"settings:openAiCodexSpeed.standard": "Standard",
	"settings:openAiCodexSpeed.fast": "Fast (1.5x speed, increased usage)",
}

export const OpenAICodexFixture = () => (
	<TranslationContext.Provider
		value={{
			t: (key) => translations[key] ?? key,
			i18n: null as unknown as typeof import("../../../../i18n/setup").default,
		}}>
		<TooltipProvider>
			<div className="flex w-[480px] flex-col gap-4 bg-vscode-editor-background p-4 text-vscode-foreground">
				<OpenAICodexSpeedSelector value={OpenAiCodexServiceTier.Default} onValueChange={() => {}} />
				<OpenAICodexWebSocketToggle value={false} onChange={() => {}} />
				<OpenAICodexSpeedSelector value={OpenAiCodexServiceTier.Priority} onValueChange={() => {}} />
				<OpenAICodexWebSocketToggle value={true} onChange={() => {}} />
			</div>
		</TooltipProvider>
	</TranslationContext.Provider>
)
