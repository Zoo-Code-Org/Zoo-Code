import * as vscode from "vscode"

import { ContextProxy } from "../../core/config/ContextProxy"
import { CodeIndexManager } from "./manager"

/**
 * Owns code-index services whose lifetime is bound to one workspace.
 * The consumer owns initialization ordering and single disposal. Registry-owned
 * scopes must be disposed through the registry, not independently by borrowers.
 */
export class CodeIndexWorkspaceScope implements vscode.Disposable {
	public readonly codeIndexManager: CodeIndexManager
	private initialization?: Promise<{ requiresRestart: boolean }>
	private disposal?: Promise<void>

	public constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.codeIndexManager = new CodeIndexManager(workspacePath, folderUri, context)
	}

	public initialize(contextProxy: ContextProxy): Promise<{ requiresRestart: boolean }> {
		if (this.disposal) {
			return Promise.reject(new Error("Cannot initialize a disposed code index workspace scope"))
		}
		if (this.initialization) {
			return this.initialization
		}

		const initialization = this.codeIndexManager.initialize(contextProxy).finally(() => {
			if (this.initialization === initialization) {
				this.initialization = undefined
			}
		})
		this.initialization = initialization
		return initialization
	}

	public dispose(): Promise<void> {
		if (this.disposal) {
			return this.disposal
		}

		const initialization = this.initialization
		this.disposal = (async () => {
			try {
				await initialization
			} catch {
				// Initialization failures do not release ownership; the manager still needs disposal.
			}
			this.codeIndexManager.dispose()
		})()
		return this.disposal
	}
}
