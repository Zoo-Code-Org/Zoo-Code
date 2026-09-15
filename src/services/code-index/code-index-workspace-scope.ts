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

	public constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.codeIndexManager = new CodeIndexManager(workspacePath, folderUri, context)
	}

	public initialize(contextProxy: ContextProxy): Promise<{ requiresRestart: boolean }> {
		return this.codeIndexManager.initialize(contextProxy)
	}

	public dispose(): void {
		this.codeIndexManager.dispose()
	}
}
