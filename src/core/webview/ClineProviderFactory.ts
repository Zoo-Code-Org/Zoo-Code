import type * as vscode from "vscode"

import { openClineInNewTab } from "../../activate/registerCommands"
import type { ClineProvider } from "./ClineProvider"
import type { WebviewFocusTracker } from "./WebviewFocusTracker"

export class ClineProviderFactory {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly webviewFocusTracker: WebviewFocusTracker,
	) {}

	public createInNewTab(): Promise<ClineProvider> {
		return openClineInNewTab({
			context: this.context,
			outputChannel: this.outputChannel,
			webviewFocusTracker: this.webviewFocusTracker,
			// The API's startNewTask closes the editors before asking for a tab, so it must not be
			// handed back a panel that still has a provider: that would silence the new task.
			forceNew: true,
		})
	}
}
