import type * as vscode from "vscode"

import { CodeIndexManager } from "./manager"
import { CodeIndexStateManager } from "./state-manager"

/** Owns code-index services for one workspace; initialization remains with existing callers. */
export class CodeIndexWorkspaceScope implements vscode.Disposable {
	private _codeIndexManager?: CodeIndexManager
	private _stateManager?: CodeIndexStateManager
	private _isInitialized = false

	public constructor(
		private readonly workspacePath: string,
		private readonly folderUri: vscode.Uri,
		private readonly context: vscode.ExtensionContext,
	) {}

	public get codeIndexManager(): CodeIndexManager {
		return this.ensureInitialized(this._codeIndexManager)
	}

	private ensureInitialized<T>(value: T | undefined): T {
		if (!this._isInitialized || value === undefined) {
			throw new Error("Code index workspace scope is not initialized")
		}
		return value
	}

	/** Creates the manager without loading configuration or starting indexing. */
	public init(): void {
		if (this._isInitialized) {
			throw new Error("Code index workspace scope is already initialized")
		}
		this._stateManager = new CodeIndexStateManager()
		this._codeIndexManager = new CodeIndexManager(
			this.workspacePath,
			this.folderUri,
			this.context,
			this._stateManager,
		)
		this._isInitialized = true
	}

	public dispose(): void {
		const manager = this._codeIndexManager
		this._codeIndexManager = undefined
		this._stateManager = undefined
		this._isInitialized = false
		manager?.dispose()
	}
}
