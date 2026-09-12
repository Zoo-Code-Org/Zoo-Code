import * as vscode from "vscode"

import type { ContextProxy } from "../../core/config/ContextProxy"
import { CodeIndexStatusManager } from "./code-index-status-manager"
import { CodeIndexWorkspaceScopeRegistry } from "./code-index-workspace-scope-registry"
import { CodeIndexDisposalError } from "./errors/code-index-disposal-error"

/** Owns feature resources. The caller must await init() before disposing, and dispose only once. */
export class CodeIndexScope implements vscode.Disposable {
	public readonly workspaceRegistry = new CodeIndexWorkspaceScopeRegistry()
	public readonly statusManager: CodeIndexStatusManager

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly contextProxy: ContextProxy,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.statusManager = new CodeIndexStatusManager(this.workspaceRegistry, outputChannel)
	}

	/** Initializes managers for every workspace folder. */
	public async init(): Promise<void> {
		await Promise.all((vscode.workspace.workspaceFolders ?? []).map((folder) => this.initWorkspace(folder)))
		this.statusManager.init()
	}

	private async initWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
		try {
			const scope = this.workspaceRegistry.getScope(this.context, folder.uri.fsPath)
			await scope?.init(this.contextProxy)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.outputChannel.appendLine(
				`[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for ${folder.uri.fsPath}: ${message}`,
			)
		}
	}

	public async dispose(): Promise<void> {
		this.statusManager.dispose()

		try {
			await this.workspaceRegistry.disposeAll()
		} catch (error) {
			if (error instanceof CodeIndexDisposalError) {
				this.outputChannel.appendLine(`CodeIndexDisposalError: ${error.message}`)
				return
			}

			this.outputChannel.appendLine(
				`Unexpected error while disposing code index managers: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}
