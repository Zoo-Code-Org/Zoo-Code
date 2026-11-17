import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { getWorkspacePath } from "../../utils/path"
import type { CodeIndexManager } from "./manager"

export type CodeIndexStatus = ReturnType<CodeIndexManager["getCurrentStatus"]>

/** Tracks the active workspace; owns subscriptions, never workspace managers. */
export class CodeIndexStatusManager implements vscode.Disposable {
	private currentManager?: CodeIndexManager
	private progressSubscription?: vscode.Disposable
	private editorSubscription?: vscode.Disposable
	private workspaceFoldersSubscription?: vscode.Disposable

	public constructor(
		private readonly getManagerForWorkspace: (workspacePath: string) => CodeIndexManager | undefined,
	) {}

	public init(): void {
		this.editorSubscription = vscode.window.onDidChangeActiveTextEditor(() => this.updateSubscription())
		this.workspaceFoldersSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() =>
			this.updateSubscription(),
		)
		this.updateSubscription()
	}

	private getCurrentManager(): CodeIndexManager | undefined {
		const workspacePath = getWorkspacePath()
		return workspacePath ? this.getManagerForWorkspace(workspacePath) : undefined
	}

	private updateSubscription(): void {
		const manager = this.getCurrentManager()
		if (manager === this.currentManager) return

		this.disposeSubscription(this.progressSubscription, "progress")
		this.progressSubscription = undefined
		this.currentManager = manager
		if (!manager) return

		this.progressSubscription = manager.onProgressUpdate(() => {
			if (manager === this.currentManager && manager === this.getCurrentManager()) {
				this.publishStatus(manager.getCurrentStatus())
			}
		})
		this.publishStatus(manager.getCurrentStatus())
	}

	private publishStatus(status: CodeIndexStatus): void {
		for (const provider of ClineProvider.getAllInstances()) {
			void this.publishStatusToProvider(provider, status)
		}
	}

	private async publishStatusToProvider(provider: ClineProvider, status: CodeIndexStatus): Promise<void> {
		try {
			const workspacePath = provider.workspacePath
			if (workspacePath && workspacePath !== status.workspacePath) return

			await provider.postMessageToWebview({ type: "indexingStatusUpdate", values: status })
		} catch (error) {
			console.error("[CodeIndexStatusManager] Failed to publish indexing status:", error)
		}
	}

	private disposeSubscription(subscription: vscode.Disposable | undefined, name: string): void {
		try {
			subscription?.dispose()
		} catch (error) {
			console.error(`[CodeIndexStatusManager] Failed to dispose ${name} subscription:`, error)
		}
	}

	public dispose(): void {
		const editorSubscription = this.editorSubscription
		const workspaceFoldersSubscription = this.workspaceFoldersSubscription
		const progressSubscription = this.progressSubscription
		this.currentManager = undefined
		this.editorSubscription = undefined
		this.workspaceFoldersSubscription = undefined
		this.progressSubscription = undefined
		this.disposeSubscription(editorSubscription, "active editor")
		this.disposeSubscription(workspaceFoldersSubscription, "workspace folders")
		this.disposeSubscription(progressSubscription, "progress")
	}
}
