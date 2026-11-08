import React, { useState } from "react"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import type { SetCachedStateField } from "../types"
import { ContextManagementSettings } from "../ContextManagementSettings"
import { AppProviders } from "../../../../playwright/AppProviders"

interface ContextManagementState {
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	idleCondenseContext: boolean
	idleCondenseContextPercent: number
	idleCondenseTimeInSeconds: number
}

export function ContextManagementSettingsStory() {
	// The idle condensing panel is pinned in its enabled state, nested inside the
	// auto-condense panel, so the snapshot captures the idle branch: profile
	// select, threshold slider, and idle time input with deterministic values.
	const [state, setState] = useState<ContextManagementState>({
		autoCondenseContext: true,
		autoCondenseContextPercent: 80,
		idleCondenseContext: true,
		idleCondenseContextPercent: 50,
		idleCondenseTimeInSeconds: 300,
	})
	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = (field, value) => {
		setState((current) => {
			switch (field) {
				case "autoCondenseContext":
				case "idleCondenseContext":
					return { ...current, [field]: Boolean(value) }
				case "autoCondenseContextPercent":
				case "idleCondenseContextPercent":
				case "idleCondenseTimeInSeconds":
					return { ...current, [field]: typeof value === "number" ? value : current[field] }
				default:
					return current
			}
		})
	}

	return (
		<AppProviders>
			<div
				data-testid="context-management-settings-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<ContextManagementSettings
					{...state}
					listApiConfigMeta={[
						{ id: "profile-a", name: "Profile A" },
						{ id: "profile-b", name: "Profile B" },
					]}
					maxOpenTabsContext={0}
					maxWorkspaceFiles={10}
					writeDelayMs={5000}
					customSupportPrompts={{}}
					setCustomSupportPrompts={() => undefined}
					setCachedStateField={setCachedStateField}
				/>
			</div>
		</AppProviders>
	)
}
