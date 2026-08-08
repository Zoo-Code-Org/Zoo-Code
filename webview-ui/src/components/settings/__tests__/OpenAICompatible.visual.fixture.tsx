import React from "react"
import { Checkbox } from "vscrui"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { TooltipProvider } from "@src/components/ui"

/**
 * Visual fixture for the `openAiToolStrictMode` toggle added to the OpenAI
 * Compatible provider in PR b05a-strict-reasoning-v2.
 *
 * The full `OpenAICompatible` component cannot be mounted in Playwright CT
 * (its `@roo-code/types` barrel re-export chain hits a `z is not defined`
 * bundling issue), so this fixture renders the exact strict-mode toggle
 * block added by the PR: checkbox + description, in the checked state.
 */
export const OpenAICompatibleStrictModeFixture = () => (
	<TranslationContext.Provider
		value={{
			t: (key: string) =>
				(
					({
						"settings:modelInfo.strictToolSchemas": "Strict tool schemas",
						"settings:modelInfo.strictToolSchemasDescription":
							"Enables strict mode for function tool schemas, ensuring tool outputs match the schema exactly. Some providers may not support strict mode. MCP tools are always kept non-strict regardless of this setting. This setting is saved per profile and also applies to other providers that use the OpenAI protocol within the same profile.",
					}) as Record<string, string>
				)[key] ?? key,
			i18n: null as unknown as typeof import("../../../i18n/setup").default,
		}}>
		<TooltipProvider>
			<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
				<div data-testid="strict-tool-schemas-block">
					<Checkbox checked={true} onChange={() => {}}>
						Strict tool schemas
					</Checkbox>
					<div className="text-sm text-vscode-descriptionForeground ml-6">
						Enables strict mode for function tool schemas, ensuring tool outputs match the schema exactly.
						Some providers may not support strict mode. MCP tools are always kept non-strict regardless of
						this setting. This setting is saved per profile and also applies to other providers that use
						the OpenAI protocol within the same profile.
					</div>
				</div>
			</div>
		</TooltipProvider>
	</TranslationContext.Provider>
)
