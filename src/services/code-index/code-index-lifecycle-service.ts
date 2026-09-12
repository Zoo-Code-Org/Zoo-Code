import * as vscode from "vscode"

import type { ContextProxy } from "../../core/config/ContextProxy"
import { codeIndexScopeRegistry } from "./code-index-scope-registry"
import { CodeIndexDisposalError } from "./errors/code-index-disposal-error"

/** Owns extension-level initialization and disposal of workspace code index managers. */
export class CodeIndexLifecycleService implements vscode.Disposable {
	private disposed = false

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly contextProxy: ContextProxy,
		private readonly outputChannel: vscode.OutputChannel,
	) {}

	/** Initializes managers for every workspace folder. */
	public async init(): Promise<void> {
		await Promise.all((vscode.workspace.workspaceFolders ?? []).map((folder) => this.initWorkspace(folder)))
	}

	private async initWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
		const scope = codeIndexScopeRegistry.getScope(this.context, folder.uri.fsPath)

		try {
			await scope?.init(this.contextProxy)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.outputChannel.appendLine(
				`[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for ${folder.uri.fsPath}: ${message}`,
			)
		}
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return
		}

		this.disposed = true

		try {
			await codeIndexScopeRegistry.disposeAll()
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
