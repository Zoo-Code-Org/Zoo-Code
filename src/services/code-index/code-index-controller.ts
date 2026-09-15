import * as vscode from "vscode"

import { ContextProxy } from "../../core/config/ContextProxy"

import { CodeIndexManager } from "./manager"
import { CodeIndexState } from "./models/code-index-state"
import { CodeIndexStateManager } from "./state-manager"

type CodeIndexManagerControllerPort = Pick<
	CodeIndexManager,
	| "workspacePath"
	| "isWorkspaceEnabled"
	| "autoEnableDefault"
	| "initialize"
	| "handleSettingsChange"
	| "startIndexing"
	| "stopIndexing"
	| "setWorkspaceEnabled"
	| "setAutoEnableDefault"
	| "clearIndexData"
>

/**
 * Exposes code-index commands to interface adapters without owning interface workflow.
 */
export class CodeIndexController {
	private readonly codeIndexStateEmitter = new vscode.EventEmitter<CodeIndexState>()
	private readonly progressSubscription: vscode.Disposable

	public readonly onDidChangeCodeIndexState = this.codeIndexStateEmitter.event

	public constructor(
		private readonly codeIndexManager: CodeIndexManagerControllerPort,
		private readonly codeIndexStateManager: CodeIndexStateManager,
	) {
		this.progressSubscription = this.codeIndexStateManager.onProgressUpdate(() => {
			this.codeIndexStateEmitter.fire(this.codeIndexState)
		})
	}

	public get codeIndexState(): CodeIndexState {
		const status = this.codeIndexStateManager.getCurrentStatus()
		return {
			systemStatus: status.systemStatus,
			message: status.message,
			processedItems: status.processedItems,
			totalItems: status.totalItems,
			currentItemUnit: status.currentItemUnit,
			workspacePath: this.codeIndexManager.workspacePath,
			workspaceEnabled: this.codeIndexManager.isWorkspaceEnabled,
			autoEnableDefault: this.codeIndexManager.autoEnableDefault,
		}
	}

	/** @deprecated Use codeIndexState. */
	public getCurrentStatus(): CodeIndexState {
		return this.codeIndexState
	}

	public initialize(contextProxy: ContextProxy): Promise<{ requiresRestart: boolean }> {
		return this.codeIndexManager.initialize(contextProxy)
	}

	public handleSettingsChange(): Promise<void> {
		return this.codeIndexManager.handleSettingsChange()
	}

	public startIndexing(): Promise<void> {
		return this.codeIndexManager.startIndexing()
	}

	public stopIndexing(): void {
		this.codeIndexManager.stopIndexing()
	}

	public async setWorkspaceEnabled(enabled: boolean): Promise<void> {
		await this.codeIndexManager.setWorkspaceEnabled(enabled)
		this.codeIndexStateEmitter.fire(this.codeIndexState)
	}

	public async setAutoEnableDefault(enabled: boolean): Promise<void> {
		await this.codeIndexManager.setAutoEnableDefault(enabled)
		this.codeIndexStateEmitter.fire(this.codeIndexState)
	}

	public clearIndexData(): Promise<void> {
		return this.codeIndexManager.clearIndexData()
	}

	public dispose(): void {
		this.progressSubscription.dispose()
		this.codeIndexStateEmitter.dispose()
	}
}
