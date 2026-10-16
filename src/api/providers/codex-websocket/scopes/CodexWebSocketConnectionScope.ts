import type * as vscode from "vscode"

import { CodexWebSocketSocketRemoteDataSource } from "../data/remote/CodexWebSocketSocketRemoteDataSource"
import type { CodexWebSocketOptions } from "../models/protocol"

/** Assembles and owns the services for one authenticated socket. */
export class CodexWebSocketConnectionScope implements vscode.Disposable {
	private _socketRemoteDataSource?: CodexWebSocketSocketRemoteDataSource
	private initialized = false

	constructor(
		private readonly url: string,
		private readonly onError: () => void,
		private readonly onClose: () => void,
	) {}

	get socketRemoteDataSource(): CodexWebSocketSocketRemoteDataSource {
		if (!this.initialized || !this._socketRemoteDataSource) {
			throw new Error("Codex WebSocket connection scope is not initialized")
		}
		return this._socketRemoteDataSource
	}

	async init(options: CodexWebSocketOptions): Promise<void> {
		if (this._socketRemoteDataSource) throw new Error("Codex WebSocket connection scope is already initialized")
		const socketRemoteDataSource = new CodexWebSocketSocketRemoteDataSource(this.url, this.onError, this.onClose)
		this._socketRemoteDataSource = socketRemoteDataSource
		try {
			await socketRemoteDataSource.init(options)
			if (this._socketRemoteDataSource !== socketRemoteDataSource)
				throw new Error("Codex WebSocket connection scope was disposed")
			this.initialized = true
		} catch (error) {
			if (this._socketRemoteDataSource === socketRemoteDataSource) this.dispose()
			throw error
		}
	}

	dispose(): void {
		const socketRemoteDataSource = this._socketRemoteDataSource
		this._socketRemoteDataSource = undefined
		this.initialized = false
		socketRemoteDataSource?.dispose()
	}
}
