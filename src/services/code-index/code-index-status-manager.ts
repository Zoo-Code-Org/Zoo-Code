import * as vscode from "vscode"

import type { CodeIndexWorkspaceScopeRegistry } from "./code-index-workspace-scope-registry"
import type { CodeIndexStatusConsumer } from "./interfaces/status-consumer"
import type { CodeIndexManager } from "./manager"

/** Owns one active-workspace progress subscription for all UI consumers. */
export class CodeIndexStatusManager implements vscode.Disposable {
	private readonly consumers = new Map<CodeIndexStatusConsumer, vscode.Disposable>()
	private editorSubscription: vscode.Disposable | undefined
	private progressSubscription: vscode.Disposable | undefined
	private activeManager: CodeIndexManager | undefined

	public constructor(
		private readonly registry: CodeIndexWorkspaceScopeRegistry,
		private readonly outputChannel: Pick<vscode.OutputChannel, "appendLine">,
	) {}

	/** Called after workspace initialization; listen before reading the active editor. */
	public init(): void {
		this.editorSubscription = vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
		this.refresh()
	}

	public addConsumer(consumer: CodeIndexStatusConsumer): vscode.Disposable {
		const subscription = consumer.onDidCodeIndexWebviewReady(() => this.publish(consumer))
		this.consumers.set(consumer, subscription)
		this.publish(consumer)
		return {
			dispose: () => {
				subscription.dispose()
				this.consumers.delete(consumer)
			},
		}
	}

	private refresh(): void {
		const editor = vscode.window.activeTextEditor
		const folder = editor
			? vscode.workspace.getWorkspaceFolder(editor.document.uri)
			: vscode.workspace.workspaceFolders?.[0]
		const scope = folder ? this.registry.getExistingScope(folder.uri.fsPath) : undefined
		const manager = scope?.isInitialized ? scope.codeIndexManager : undefined
		if (manager === this.activeManager) {
			return
		}
		this.progressSubscription?.dispose()
		this.progressSubscription = undefined
		this.activeManager = manager
		if (manager) {
			this.progressSubscription = manager.onProgressUpdate(() => {
				if (this.activeManager === manager) {
					this.publishAll()
				}
			})
			this.publishAll()
		}
	}

	private publishAll(): void {
		for (const consumer of this.consumers.keys()) {
			this.publish(consumer)
		}
	}

	private publish(consumer: CodeIndexStatusConsumer): void {
		if (this.activeManager) {
			void consumer.postCodeIndexStatus(this.activeManager.getCurrentStatus()).catch((error: unknown) => {
				this.outputChannel.appendLine(`Failed to publish code index status: ${String(error)}`)
			})
		}
	}

	public dispose(): void {
		this.editorSubscription?.dispose()
		this.progressSubscription?.dispose()
		this.activeManager = undefined
		for (const subscription of this.consumers.values()) {
			subscription.dispose()
		}
		this.consumers.clear()
	}
}
