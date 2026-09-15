import * as vscode from "vscode"

import { CodeIndexController } from "./code-index-controller"
import { CodeIndexManager } from "./manager"
import { CodeIndexStateManager } from "./state-manager"

/** Owns code-index dependencies whose lifetime is bound to one workspace. */
export class CodeIndexScope {
	public readonly codeIndexStateManager: CodeIndexStateManager
	public readonly codeIndexManager: CodeIndexManager
	public readonly codeIndexController: CodeIndexController

	public constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.codeIndexStateManager = new CodeIndexStateManager()
		this.codeIndexManager = new CodeIndexManager(workspacePath, folderUri, context, this.codeIndexStateManager)
		this.codeIndexController = new CodeIndexController(this.codeIndexManager, this.codeIndexStateManager)
	}

	public dispose(): void {
		this.codeIndexController.dispose()
		this.codeIndexManager.dispose()
	}
}
