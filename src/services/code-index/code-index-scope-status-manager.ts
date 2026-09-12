import * as vscode from "vscode"

import type { CodeIndexStatusConsumer } from "./interfaces/status-consumer"
import type { CodeIndexManager } from "./manager"

/** Publishes status only while its code-index scope is the active workspace. */
export class CodeIndexScopeStatusManager implements vscode.Disposable {
	private refreshSubscription: vscode.Disposable | undefined
	private progressSubscription: vscode.Disposable | undefined

	public constructor(
		private readonly workspacePath: string,
		private readonly codeIndexManager: CodeIndexManager,
	) {}

	public init(consumer: CodeIndexStatusConsumer): void {
		this.refreshSubscription ??= consumer.onDidRequestCodeIndexStatusSubscriptionUpdate(() => {
			this.refresh(consumer)
		})
		this.refresh(consumer)
	}

	private refresh(consumer: CodeIndexStatusConsumer): void {
		if (!this.isActiveWorkspace()) {
			this.progressSubscription?.dispose()
			this.progressSubscription = undefined
			return
		}

		if (this.progressSubscription) {
			return
		}

		this.progressSubscription = this.codeIndexManager.onProgressUpdate(() => {
			if (this.isActiveWorkspace()) {
				void consumer.postCodeIndexStatus(this.codeIndexManager.getCurrentStatus())
			}
		})
		void consumer.postCodeIndexStatus(this.codeIndexManager.getCurrentStatus())
	}

	private isActiveWorkspace(): boolean {
		const activeEditor = vscode.window.activeTextEditor
		const activeFolder = activeEditor ? vscode.workspace.getWorkspaceFolder(activeEditor.document.uri) : undefined
		const selectedFolder = activeEditor ? activeFolder : vscode.workspace.workspaceFolders?.[0]
		return selectedFolder?.uri.fsPath === this.workspacePath
	}

	public dispose(): void {
		this.refreshSubscription?.dispose()
		this.refreshSubscription = undefined
		this.progressSubscription?.dispose()
		this.progressSubscription = undefined
	}
}
