import React from "react"

import { AppProviders } from "../../../../playwright/AppProviders"
import { ThinkingEffortToggle } from "../ThinkingEffortToggle"

// DTE series 4/5: CT story for the composer thinking-effort toggle. Uses a real
// model (gpt-5.6-sol) that advertises a per-request effort array; the toggle
// renders for capable models regardless of the experiment flag. The experiment
// state is kept in the initial state so the story renders exactly the component
// state the baselines were generated with.
export function ThinkingEffortToggleStory() {
	return (
		<AppProviders
			initialState={{
				experiments: { dynamicThinkingEffort: true },
				apiConfiguration: { apiProvider: "openai-native", apiModelId: "gpt-5.6-sol", reasoningEffort: "low" },
			}}>
			<div
				data-testid="thinking-effort-toggle-story"
				className="flex w-[320px] items-center justify-end rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-3">
				<span className="text-xs text-vscode-descriptionForeground">Composer bottom bar</span>
				<span className="ml-auto" />
				<ThinkingEffortToggle />
			</div>
		</AppProviders>
	)
}
