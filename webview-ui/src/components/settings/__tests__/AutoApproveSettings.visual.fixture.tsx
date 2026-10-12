import React, { useState } from "react"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import type { SetCachedStateField } from "../types"
import { AutoApproveSettings } from "../AutoApproveSettings"
import { AppProviders } from "../../../../playwright/AppProviders"

interface AutoApproveState {
	alwaysAllowReadOnly: boolean
	alwaysAllowWrite: boolean
	alwaysAllowMcp: boolean
	alwaysAllowModeSwitch: boolean
	alwaysAllowSubtasks: boolean
	alwaysAllowExecute: boolean
	alwaysAllowFollowupQuestions: boolean
	destructiveCommandGuardEnabled: boolean
	alwaysDenyUnapprovedCommands: boolean
	allowedCommands: string[]
	deniedCommands: string[]
	allowedReadFiles: string[]
	allowedWriteFiles: string[]
	allowedMaxRequests?: number
	allowedMaxCost?: number
}

export function AutoApproveSettingsStory() {
	// The blanket auto-deny checkbox is pinned here in its operative mode: with
	// the destructive command guard on it is the fail-closed policy, and the
	// guard's hidden command-list editors would otherwise vary the snapshot.
	const [state, setState] = useState<AutoApproveState>({
		alwaysAllowReadOnly: false,
		alwaysAllowWrite: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowExecute: true,
		alwaysAllowFollowupQuestions: false,
		destructiveCommandGuardEnabled: true,
		alwaysDenyUnapprovedCommands: true,
		allowedCommands: [],
		deniedCommands: [],
		allowedReadFiles: [],
		allowedWriteFiles: [],
	})
	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = (field, value) => {
		setState((current) => {
			switch (field) {
				case "alwaysAllowReadOnly":
				case "alwaysAllowWrite":
				case "alwaysAllowMcp":
				case "alwaysAllowModeSwitch":
				case "alwaysAllowSubtasks":
				case "alwaysAllowExecute":
				case "alwaysAllowFollowupQuestions":
				case "destructiveCommandGuardEnabled":
				case "alwaysDenyUnapprovedCommands":
					return { ...current, [field]: Boolean(value) }
				case "allowedCommands":
				case "deniedCommands":
				case "allowedReadFiles":
				case "allowedWriteFiles":
					return { ...current, [field]: Array.isArray(value) ? [...value] : [] }
				case "allowedMaxRequests":
				case "allowedMaxCost":
					return { ...current, [field]: typeof value === "number" ? value : undefined }
				default:
					return current
			}
		})
	}

	return (
		<AppProviders initialState={{ autoApprovalEnabled: true }}>
			<div
				data-testid="auto-approve-settings-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<AutoApproveSettings {...state} setCachedStateField={setCachedStateField} />
			</div>
		</AppProviders>
	)
}
