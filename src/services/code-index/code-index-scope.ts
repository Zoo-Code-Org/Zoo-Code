import type * as vscode from "vscode"

import type { ContextProxy } from "../../core/config/ContextProxy"
import type { CodeIndexStatusConsumer } from "./interfaces/status-consumer"
import { CodeIndexManager } from "./manager"
import { CodeIndexScopeStatusManager } from "./code-index-scope-status-manager"
import { CodeIndexStateManager } from "./state-manager"

type Disposable = {
	dispose(): void | Promise<void>
}

/** Owns the code-index resources associated with one workspace. */
export class CodeIndexScope {
	public readonly codeIndexManager: CodeIndexManager
	private readonly stateManager: CodeIndexStateManager
	private readonly statusManager: CodeIndexScopeStatusManager

	public constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.stateManager = new CodeIndexStateManager()
		this.codeIndexManager = new CodeIndexManager(workspacePath, folderUri, context, this.stateManager)
		this.statusManager = new CodeIndexScopeStatusManager(workspacePath, this.codeIndexManager)
	}

	public async init(contextProxy: ContextProxy, statusConsumer: CodeIndexStatusConsumer): Promise<void> {
		this.stateManager.init()
		await this.codeIndexManager.initialize(contextProxy)
		this.statusManager.init(statusConsumer)
	}

	public async dispose(): Promise<void> {
		const disposables: Disposable[] = [this.statusManager, this.codeIndexManager, this.stateManager]
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
