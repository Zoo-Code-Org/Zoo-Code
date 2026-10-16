import type * as vscode from "vscode"

import type { CodexWebSocketConnectionManager } from "../managers/CodexWebSocketConnectionManager"
import { CodexWebSocketRequestManager } from "../managers/CodexWebSocketRequestManager"
import { CodexWebSocketResponseManager } from "../managers/CodexWebSocketResponseManager"
import type { CodexWebSocketOptions } from "../models/protocol"
import type { CodexWebSocketContinuationRepository } from "../repositories/CodexWebSocketContinuationRepository"
import { CodexWebSocketRequestStateHolder } from "../state-holders/CodexWebSocketRequestStateHolder"
import { CodexWebSocketResponseStateHolder } from "../state-holders/CodexWebSocketResponseStateHolder"

/** Assembles and owns request-local services without owning the reusable connection. */
export class CodexWebSocketRequestScope implements vscode.Disposable {
	private _requestManager?: CodexWebSocketRequestManager
	private _responseManager?: CodexWebSocketResponseManager
	private initializing = false
	private initialized = false

	constructor(
		private readonly options: CodexWebSocketOptions,
		private readonly onAbort: () => void,
	) {}

	get requestManager(): CodexWebSocketRequestManager {
		if (!this.initialized || !this._requestManager)
			throw new Error("Codex WebSocket request scope is not initialized")
		return this._requestManager
	}

	get responseManager(): CodexWebSocketResponseManager {
		if (!this.initialized || !this._responseManager) {
			throw new Error("Codex WebSocket request scope is not initialized")
		}
		return this._responseManager
	}

	async init(
		connection: CodexWebSocketConnectionManager,
		continuation: CodexWebSocketContinuationRepository,
		body: unknown,
	): Promise<void> {
		if (this._requestManager || this.initializing) {
			throw new Error("Codex WebSocket request scope is already initialized")
		}
		const requestStateHolder = new CodexWebSocketRequestStateHolder()
		const request = new CodexWebSocketRequestManager(this.options, this.onAbort, requestStateHolder)
		this._requestManager = request
		this.initializing = true
		try {
			await request.init(connection)
			if (this._requestManager !== request) throw new Error("Codex WebSocket request scope was disposed")
			const responseStateHolder = new CodexWebSocketResponseStateHolder()
			const responseManager = new CodexWebSocketResponseManager(continuation, responseStateHolder)
			responseManager.init(body)
			this._responseManager = responseManager
			this.initialized = true
		} catch (error) {
			if (this._requestManager === request) await this.dispose()
			throw error
		} finally {
			this.initializing = false
		}
	}

	async dispose(): Promise<void> {
		const request = this._requestManager
		this._requestManager = undefined
		this._responseManager = undefined
		this.initialized = false
		await request?.dispose()
	}
}
