import React, { useState } from "react"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import type { SetCachedStateField } from "../types"
import { UISettings } from "../UISettings"
import { AppProviders } from "../../../../playwright/AppProviders"

interface UIState {
	reasoningBlockCollapsed: boolean
	enterBehavior: "send" | "newline"
	chatFontSize?: number
	autoCloseZooOpenedFiles?: boolean
	autoCloseZooOpenedFilesAfterUserEdited?: boolean
	autoCloseZooOpenedNewFiles?: boolean
}

export function UISettingsStory() {
	const [state, setState] = useState<UIState>({
		reasoningBlockCollapsed: true,
		enterBehavior: "send",
		chatFontSize: 14,
		autoCloseZooOpenedFiles: true,
		autoCloseZooOpenedFilesAfterUserEdited: true,
		autoCloseZooOpenedNewFiles: false,
	})
	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = (field, value) => {
		setState((current) => {
			switch (field) {
				case "reasoningBlockCollapsed":
				case "autoCloseZooOpenedFiles":
				case "autoCloseZooOpenedFilesAfterUserEdited":
				case "autoCloseZooOpenedNewFiles":
					return { ...current, [field]: Boolean(value) }
				case "enterBehavior":
					return { ...current, enterBehavior: value === "newline" ? "newline" : "send" }
				case "chatFontSize":
					return { ...current, chatFontSize: typeof value === "number" ? value : undefined }
				default:
					return current
			}
		})
	}

	return (
		<AppProviders>
			<div
				data-testid="ui-settings-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<UISettings {...state} setCachedStateField={setCachedStateField} />
			</div>
		</AppProviders>
	)
}
