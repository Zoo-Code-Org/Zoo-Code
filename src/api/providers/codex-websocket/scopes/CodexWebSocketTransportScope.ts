import type * as vscode from "vscode"

import { CodexWebSocketTransport } from "../../CodexWebSocketTransport"
import { CodexWebSocketResponseLocalDataSource } from "../data/local/CodexWebSocketResponseLocalDataSource"
import { CodexWebSocketConnectionManager } from "../managers/CodexWebSocketConnectionManager"
import { CodexWebSocketContinuationRepository } from "../repositories/CodexWebSocketContinuationRepository"
import { CodexWebSocketConnectionStateHolder } from "../state-holders/CodexWebSocketConnectionStateHolder"
import { CodexWebSocketRequestScope } from "./CodexWebSocketRequestScope"

const CODEX_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses"

/** Assembles and owns the task-local WebSocket transport graph. */
export class CodexWebSocketTransportScope implements vscode.Disposable {
	private _transport?: CodexWebSocketTransport

	constructor(private readonly url = CODEX_WEBSOCKET_URL) {}

	get transport(): CodexWebSocketTransport {
		if (!this._transport) throw new Error("Codex WebSocket transport scope is not initialized")
		return this._transport
	}

	/** Assembles services without opening a socket; authentication is supplied per request. */
	init(): void {
		if (this._transport) throw new Error("Codex WebSocket transport scope is already initialized")
		const responseLocalDataSource = new CodexWebSocketResponseLocalDataSource()
		const continuationRepository = new CodexWebSocketContinuationRepository(responseLocalDataSource)
		const connectionStateHolder = new CodexWebSocketConnectionStateHolder()
		const connectionManager = new CodexWebSocketConnectionManager(
			this.url,
			() => continuationRepository.reset(),
			connectionStateHolder,
		)
		this._transport = new CodexWebSocketTransport(
			connectionManager,
			continuationRepository,
			(options, onAbort) => new CodexWebSocketRequestScope(options, onAbort),
		)
	}

	async dispose(): Promise<void> {
		const transport = this._transport
		this._transport = undefined
		await transport?.dispose()
	}
}
