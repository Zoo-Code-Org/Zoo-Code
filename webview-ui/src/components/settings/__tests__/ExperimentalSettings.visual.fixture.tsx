import { useState } from "react"

import type { Experiments } from "@roo-code/types"

import { EXPERIMENT_IDS, experimentDefault } from "@roo/experiments"

import { ExperimentalSettings } from "../ExperimentalSettings"
import { AppProviders } from "../../../../playwright/AppProviders"

export function ExperimentalSettingsStory() {
	const [experiments, setExperiments] = useState<Experiments>({
		...experimentDefault,
		[EXPERIMENT_IDS.DYNAMIC_THINKING_EFFORT]: true,
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
