import { once } from "node:events"
import WebSocket from "ws"

import type { CodexWebSocketOptions } from "../../models/protocol"

const HANDSHAKE_TIMEOUT_MS = 10_000

/** Owns one socket and its subscriptions, from initialization through terminal close. */
export class CodexWebSocketSocketRemoteDataSource {
	private _socket?: WebSocket
	private disposeSocket?: () => void

	constructor(
		private readonly url: string,
		private readonly onError: () => void,
		private readonly onClose: () => void,
	) {}

	get socket(): WebSocket {
		if (!this._socket) throw new Error("Codex WebSocket connection scope is not initialized")
		return this._socket
	}

	async init(options: CodexWebSocketOptions): Promise<void> {
		if (this._socket) throw new Error("Codex WebSocket connection scope is already initialized")
		options.signal.throwIfAborted()
		const socket = this.createSocket(options)
		this._socket = socket
		this.disposeSocket = this.registerHandlers(socket)
		try {
			await this.waitForOpen(socket, options.signal)
		} catch (error) {
			if (this._socket === socket) this.dispose()
			throw error
		}
	}

	dispose(): void {
		const disposeSocket = this.disposeSocket
		this._socket = undefined
		this.disposeSocket = undefined
		disposeSocket?.()
	}

	private createSocket(options: CodexWebSocketOptions): WebSocket {
		return new WebSocket(this.url, {
			headers: { ...options.headers, "OpenAI-Beta": "responses_websockets=2026-02-06" },
			handshakeTimeout: Math.min(options.timeoutMs, HANDSHAKE_TIMEOUT_MS),
		})
	}

	private registerHandlers(socket: WebSocket): () => void {
		const onError = () => {
			if (this._socket === socket) this.onError()
		}
		const onClose = () => {
			if (this._socket === socket) this.onClose()
		}
		socket.on("error", onError)
		socket.on("close", onClose)
		return () => {
			socket.off("close", onClose)
			this.terminateSocket(socket, onError)
		}
	}

	private terminateSocket(socket: WebSocket, onError: () => void): void {
		if (socket.readyState === WebSocket.CLOSED) {
			socket.off("error", onError)
			return
		}
		// An upgrade terminated in flight can emit an asynchronous error. Keep its inert
		// error handler until terminal close, then remove it as well.
		socket.once("close", () => socket.off("error", onError))
		socket.terminate()
	}

	private async waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
		await once(socket, "open", { signal })
		signal.throwIfAborted()
		if (this._socket !== socket) throw new Error("Codex WebSocket connection scope was disposed")
	}
}
