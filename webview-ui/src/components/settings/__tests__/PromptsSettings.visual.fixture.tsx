import { useState } from "react"

import { providerIdentifiers } from "@roo-code/types"

import PromptsSettings from "../PromptsSettings"
import { AppProviders } from "../../../../playwright/AppProviders"

export function PromptsSettingsStory() {
	const [customSupportPrompts, setCustomSupportPrompts] = useState<Record<string, string | undefined>>({})
	const [enabled, setEnabled] = useState(true)
	const [apiConfigId, setApiConfigId] = useState("")

	return (
		<AppProviders
			initialState={{
				listApiConfigMeta: [
					{ id: "default", name: "Default", apiProvider: providerIdentifiers.anthropic },
					{ id: "cheap", name: "Cheap and fast", apiProvider: providerIdentifiers.anthropic },
				],
			}}>
			<div
				data-testid="prompts-settings-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<PromptsSettings
					customSupportPrompts={customSupportPrompts}
					setCustomSupportPrompts={setCustomSupportPrompts}
					taskTitleGenerationEnabled={enabled}
					setTaskTitleGenerationEnabled={setEnabled}
					taskTitleApiConfigId={apiConfigId}
					setTaskTitleApiConfigId={setApiConfigId}
				/>
			</div>
		</AppProviders>
	)
}
