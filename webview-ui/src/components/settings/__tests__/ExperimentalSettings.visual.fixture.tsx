import { useState } from "react"

import type { Experiments } from "@roo-code/types"

import { EXPERIMENT_IDS, experimentDefault } from "@roo/experiments"

import { ExperimentalSettings } from "../ExperimentalSettings"
import { AppProviders } from "../../../../playwright/AppProviders"

export function ExperimentalSettingsStory() {
	// PREVENT_FOCUS_DISRUPTION stands in for the enabled-toggle state: the
	// dynamicThinkingEffort toggle is hidden (showInSettings: false) until the
	// set_thinking_effort tool is registered.
	const [experiments, setExperiments] = useState<Experiments>({
		...experimentDefault,
		[EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION]: true,
	})

	return (
		<AppProviders>
			<div
				data-testid="experimental-settings-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<ExperimentalSettings
					experiments={experiments}
					setExperimentEnabled={(id, enabled) => setExperiments((current) => ({ ...current, [id]: enabled }))}
				/>
			</div>
		</AppProviders>
	)
}
