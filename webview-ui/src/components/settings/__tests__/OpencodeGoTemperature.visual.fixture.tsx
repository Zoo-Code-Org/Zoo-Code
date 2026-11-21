import React from "react"

import { type ProviderSettings, opencodeGoModels, providerIdentifiers } from "@roo-code/types"

import { TemperatureControl } from "../TemperatureControl"
import { isTemperatureControlSupported } from "../utils/temperatureSupport"
import { AppProviders } from "../../../../playwright/AppProviders"

const SAVED_TEMPERATURE = 0.42

const cases: { modelId: string; reasoningEffort: ProviderSettings["reasoningEffort"] }[] = [
	{ modelId: "gpt-6-luna", reasoningEffort: "none" },
	{ modelId: "gpt-6-luna", reasoningEffort: "high" },
	{ modelId: "grok-4.6", reasoningEffort: "high" },
]

/**
 * Renders the temperature control through the same gate ApiOptions uses, for
 * supported and unsupported OpenCode Go Responses states (#2055). Each case has
 * a saved custom temperature, so a hidden control shows the value is kept but
 * not offered.
 */
export function OpencodeGoTemperatureFixture() {
	return (
		<AppProviders>
			<div
				className="w-[480px] p-4 flex flex-col gap-4 bg-vscode-editor-background text-vscode-foreground"
				data-testid="opencode-go-temperature-story">
				{cases.map(({ modelId, reasoningEffort }) => {
					const apiConfiguration: ProviderSettings = {
						apiProvider: providerIdentifiers.opencodeGo,
						opencodeGoModelId: modelId,
						reasoningEffort,
						modelTemperature: SAVED_TEMPERATURE,
					}
					const supported = isTemperatureControlSupported({
						provider: providerIdentifiers.opencodeGo,
						modelId,
						modelInfo: opencodeGoModels[modelId],
						apiConfiguration,
					})
					return (
						<section key={`${modelId}-${reasoningEffort}`} className="flex flex-col gap-2">
							<h3 className="m-0 text-sm font-medium">
								{modelId} · reasoning effort {reasoningEffort}
							</h3>
							{supported ? (
								<TemperatureControl
									value={apiConfiguration.modelTemperature}
									onChange={() => undefined}
									maxValue={2}
								/>
							) : (
								<p className="m-0 text-vscode-descriptionForeground">Temperature control hidden</p>
							)}
						</section>
					)
				})}
			</div>
		</AppProviders>
	)
}
