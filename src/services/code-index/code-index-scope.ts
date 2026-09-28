import type * as vscode from "vscode"
import { CodeIndexManagerRegistry } from "./code-index-manager-registry"
import { CodeIndexStatusManager } from "./code-index-status-manager"
import { CodeIndexSecretStatusManager } from "./code-index-secret-status-manager"

export class CodeIndexScope implements vscode.Disposable {
	private static readonly instances = new WeakMap<vscode.ExtensionContext, CodeIndexScope>()
	private statusManager?: CodeIndexStatusManager
	private _secretStatusManager?: CodeIndexSecretStatusManager
	private _isInitialized = false

	public constructor(private readonly context: vscode.ExtensionContext) {}

	public static getOrCreate(context: vscode.ExtensionContext): CodeIndexScope {
		let scope = this.instances.get(context)
		if (!scope) {
			scope = new CodeIndexScope(context)
			this.instances.set(context, scope)
		}
		return scope
	}

	public get secretStatusManager(): CodeIndexSecretStatusManager {
		return this.ensureInitialized(this._secretStatusManager)
	}

	private ensureInitialized<T>(value: T | undefined): T {
		if (!this._isInitialized || value === undefined) {
			throw new Error("Code index scope is not initialized")
		}
		return value
	}

	public init(): void {
		if (this._isInitialized) {
			throw new Error("Code index scope is already initialized")
		}
		const manager = new CodeIndexStatusManager((workspacePath) =>
			CodeIndexManagerRegistry.getOrCreate(this.context, workspacePath),
		)
		manager.init()
		this.statusManager = manager
		this._secretStatusManager = new CodeIndexSecretStatusManager(this.context.secrets)
		this._isInitialized = true
	}

	public dispose(): void {
		const manager = this.statusManager
		this.statusManager = undefined
		this._secretStatusManager = undefined
		this._isInitialized = false
		manager?.dispose()
	}
}
