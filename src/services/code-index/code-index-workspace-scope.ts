import type * as vscode from "vscode"

import type { ContextProxy } from "../../core/config/ContextProxy"
import { CodeIndexManager } from "./manager"
import { CodeIndexStateManager } from "./state-manager"

type Disposable = {
	dispose(): void | Promise<void>
}

/** Owns the code-index resources associated with one workspace. */
export class CodeIndexWorkspaceScope {
	public readonly codeIndexManager: CodeIndexManager
	private readonly stateManager: CodeIndexStateManager
	private initialized = false

	public get isInitialized(): boolean {
		return this.initialized
	}

	public constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.stateManager = new CodeIndexStateManager()
		this.codeIndexManager = new CodeIndexManager(workspacePath, folderUri, context, this.stateManager)
	}

	public async init(contextProxy: ContextProxy): Promise<void> {
		this.stateManager.init()
		this.initialized = true
		await this.codeIndexManager.initialize(contextProxy)
	}

	public async dispose(): Promise<void> {
		this.initialized = false
		const disposables: Disposable[] = [this.codeIndexManager, this.stateManager]
		const errors: unknown[] = []

		for (const disposable of disposables) {
			try {
				await disposable.dispose()
			} catch (error) {
				errors.push(error)
			}
		}

		if (errors.length > 0) {
			throw new AggregateError(errors, "Failed to dispose code index scope resources")
		}
	}
}
