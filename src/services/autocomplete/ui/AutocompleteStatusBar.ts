import * as vscode from "vscode"

import { Package } from "../../../shared/package"
import type { AutocompleteServiceLike } from "../types"

export type AutocompleteStatus = "off" | "ready" | "error"

/** Command that opens the settings panel on the autocomplete section. */
export const AUTOCOMPLETE_OPEN_SETTINGS_COMMAND = `${Package.name}.autocomplete.openSettings`

/**
 * Status bar entry for inline autocomplete.
 *
 * Clicking it opens the settings panel on the autocomplete section (where the
 * enable flag lives) — the status bar itself never mutates persisted state.
 */
export class AutocompleteStatusBar {
	private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)

	constructor(private readonly service: AutocompleteServiceLike) {}

	/** Call once after construction; hides the item before then. */
	show(): void {
		this.statusBarItem.command = AUTOCOMPLETE_OPEN_SETTINGS_COMMAND
		this.statusBarItem.tooltip = "Zoo Code inline autocomplete — click to configure"
		this.statusBarItem.text = "$(sparkles) Autocomplete"
		this.update(this.service.getState().enabled ? "ready" : "off")
		this.statusBarItem.show()
	}

	/** Re-renders the label from the live service state; safe to call on any change. */
	refresh(): void {
		this.update(this.service.getState().enabled ? "ready" : "off")
	}

	update(status: AutocompleteStatus): void {
		switch (status) {
			case "ready":
				this.statusBarItem.backgroundColor = undefined
				this.statusBarItem.text = "$(sparkles) Autocomplete"
				break
			case "error":
				this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
				this.statusBarItem.text = "$(error) Autocomplete"
				break
			case "off":
			default:
				this.statusBarItem.backgroundColor = undefined
				this.statusBarItem.text = "$(sparkles) Autocomplete: Off"
				break
		}
	}

	dispose(): void {
		this.statusBarItem.dispose()
	}
}
