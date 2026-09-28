import type * as vscode from "vscode"

import { CodeIndexManager } from "./manager"
import { CodeIndexStateManager } from "./state-manager"
import { WorkspaceIndexingEnablementManager } from "./workspace-indexing-enablement-manager"
import { WorkspaceIndexingSettingsManager } from "./workspace-indexing-settings-manager"
import { WorkspaceIndexingAutoEnableManager } from "./workspace-indexing-auto-enable-manager"
import { WorkspaceIndexingClearManager } from "./workspace-indexing-clear-manager"
import { WorkspaceIndexingStartManager } from "./workspace-indexing-start-manager"
import { WorkspaceIndexingStatusManager } from "./workspace-indexing-status-manager"

/** Owns code-index services for one workspace; initialization remains with existing callers. */
export class CodeIndexWorkspaceScope implements vscode.Disposable {
	private _codeIndexManager?: CodeIndexManager
	private _stateManager?: CodeIndexStateManager
	private _workspaceIndexingEnablementManager?: WorkspaceIndexingEnablementManager
	private _workspaceIndexingSettingsManager?: WorkspaceIndexingSettingsManager
	private _workspaceIndexingAutoEnableManager?: WorkspaceIndexingAutoEnableManager
	private _workspaceIndexingClearManager?: WorkspaceIndexingClearManager
	private _workspaceIndexingStartManager?: WorkspaceIndexingStartManager
	private _workspaceIndexingStatusManager?: WorkspaceIndexingStatusManager
	private _isInitialized = false

	public constructor(
		private readonly workspacePath: string,
		private readonly folderUri: vscode.Uri,
		private readonly context: vscode.ExtensionContext,
	) {}

	public get codeIndexManager(): CodeIndexManager {
		return this.ensureInitialized(this._codeIndexManager)
	}

	public get workspaceIndexingEnablementManager(): WorkspaceIndexingEnablementManager {
		return this.ensureInitialized(this._workspaceIndexingEnablementManager)
	}

	public get workspaceIndexingSettingsManager(): WorkspaceIndexingSettingsManager {
		return this.ensureInitialized(this._workspaceIndexingSettingsManager)
	}

	public get workspaceIndexingAutoEnableManager(): WorkspaceIndexingAutoEnableManager {
		return this.ensureInitialized(this._workspaceIndexingAutoEnableManager)
	}

	public get workspaceIndexingClearManager(): WorkspaceIndexingClearManager {
		return this.ensureInitialized(this._workspaceIndexingClearManager)
	}

	public get workspaceIndexingStartManager(): WorkspaceIndexingStartManager {
		return this.ensureInitialized(this._workspaceIndexingStartManager)
	}

	public get workspaceIndexingStatusManager(): WorkspaceIndexingStatusManager {
		return this.ensureInitialized(this._workspaceIndexingStatusManager)
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
		this._isInitialized = true
		try {
			this._stateManager = new CodeIndexStateManager()
			this._codeIndexManager = new CodeIndexManager(
				this.workspacePath,
				this.folderUri,
				this.context,
				this._stateManager,
			)
			this._workspaceIndexingEnablementManager = new WorkspaceIndexingEnablementManager(this.codeIndexManager)
			this._workspaceIndexingSettingsManager = new WorkspaceIndexingSettingsManager(this.codeIndexManager)
			this._workspaceIndexingAutoEnableManager = new WorkspaceIndexingAutoEnableManager(this.codeIndexManager)
			this._workspaceIndexingClearManager = new WorkspaceIndexingClearManager(this.codeIndexManager)
			this._workspaceIndexingStartManager = new WorkspaceIndexingStartManager(this.codeIndexManager)
			this._workspaceIndexingStatusManager = new WorkspaceIndexingStatusManager(this.codeIndexManager)
		} catch (error) {
			this.dispose()
			throw error
		}
	}

	public dispose(): void {
		const manager = this._codeIndexManager
		this._codeIndexManager = undefined
		this._workspaceIndexingEnablementManager = undefined
		this._workspaceIndexingSettingsManager = undefined
		this._workspaceIndexingAutoEnableManager = undefined
		this._workspaceIndexingClearManager = undefined
		this._workspaceIndexingStartManager = undefined
		this._workspaceIndexingStatusManager = undefined
		this._stateManager = undefined
		this._isInitialized = false
		manager?.dispose()
	}
}
