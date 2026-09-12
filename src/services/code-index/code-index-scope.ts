import type * as vscode from "vscode"

import type { ContextProxy } from "../../core/config/ContextProxy"
import { CodeIndexManager } from "./manager"
import { CodeIndexStateManager } from "./state-manager"

/** Owns the code-index resources associated with one workspace. */
export class CodeIndexScope {
	public readonly codeIndexManager: CodeIndexManager
	private readonly stateManager: CodeIndexStateManager

	public constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.stateManager = new CodeIndexStateManager()
		this.codeIndexManager = new CodeIndexManager(workspacePath, folderUri, context, this.stateManager)
	}

	public async init(contextProxy: ContextProxy): Promise<void> {
		this.stateManager.init()
		await this.codeIndexManager.initialize(contextProxy)
	}

	public async dispose(): Promise<void> {
		try {
			await this.codeIndexManager.dispose()
		} finally {
			this.stateManager.dispose()
		}
	}
}
