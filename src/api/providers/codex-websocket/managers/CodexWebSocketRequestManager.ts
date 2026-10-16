import { on } from "node:events"
import type WebSocket from "ws"

import type { CodexWebSocketConnectionManager } from "./CodexWebSocketConnectionManager"
import type { CodexWebSocketRequestStateModel } from "../models/CodexWebSocketRequestStateModel"
import type { CodexWebSocketRequestStateHolder } from "../state-holders/CodexWebSocketRequestStateHolder"
import type { CodexWebSocketOptions } from "../models/protocol"

type RequestState = CodexWebSocketRequestStateModel<WebSocket, AsyncIterableIterator<unknown[]>, NodeJS.Timeout>

/** Owns cancellation, the inactivity timer, and response subscriptions for a single request. */
export class CodexWebSocketRequestManager {
	constructor(
		private readonly options: CodexWebSocketOptions,
		private readonly onAbort: () => void,
		private readonly stateHolder: CodexWebSocketRequestStateHolder,
	) {}

	private get state(): RequestState {
		return this.stateHolder.state
	}

	get signal(): AbortSignal {
		return "signal" in this.state ? this.state.signal : this.options.signal
	}

	get socket(): WebSocket {
		if (this.state.status !== "active") throw new Error("Codex WebSocket request scope is not initialized")
		return this.state.socket
	}

	get events(): AsyncIterableIterator<unknown[]> {
		if (this.state.status !== "active") throw new Error("Codex WebSocket request scope is not initialized")
		return this.state.events
	}

	async init(connection: CodexWebSocketConnectionManager): Promise<void> {
		if (this.state.status === "active" || this.state.status === "initializing") {
			throw new Error("Codex WebSocket request scope is already initialized")
		}
		this.options.signal.throwIfAborted()
		const controller = new AbortController()
		const signal = AbortSignal.any([this.options.signal, controller.signal])
		const initializing = this.stateHolder.beginInitialization(controller, signal)
		initializing.signal.addEventListener("abort", this.onAbort, { once: true })
		try {
			const socket = await connection.acquire({ ...this.options, signal: initializing.signal })
			initializing.signal.throwIfAborted()
			if (!this.stateHolder.isCurrent(initializing)) throw new Error("Codex WebSocket request scope was disposed")
			// Register before sending so a fast reply cannot be lost.
			const events = on(socket, "message", { signal: initializing.signal, close: ["close"] })
			this.stateHolder.activate(initializing, socket, events)
		} catch (error) {
			if (this.stateHolder.isCurrent(initializing)) {
				this.stateHolder.dispose()
				await this.disposeResources(initializing)
			}
			initializing.signal.throwIfAborted()
			throw error
		}
	}

	refreshTimeout(): void {
		const state = this.state
		if (state.status !== "active") throw new Error("Codex WebSocket request scope is not initialized")
		clearTimeout(state.timeout)
		const timeout = setTimeout(() => {
			if (this.stateHolder.isCurrent(timedState))
				state.controller.abort(new Error("Codex WebSocket stream timed out"))
		}, this.options.timeoutMs)
		const timedState = this.stateHolder.setDeadline(state, timeout)
	}

	clearTimeout(): void {
		const state = this.state
		if (state.status !== "active") return
		clearTimeout(state.timeout)
		this.stateHolder.clearDeadline(state)
	}

	async dispose(): Promise<void> {
		const state = this.stateHolder.dispose()
		if (state.status !== "initializing" && state.status !== "active") return
		if (state.status === "initializing")
			state.controller.abort(new Error("Codex WebSocket request scope was disposed"))
		await this.disposeResources(state)
	}

	private async disposeResources(state: Extract<RequestState, { status: "initializing" | "active" }>): Promise<void> {
		state.signal.removeEventListener("abort", this.onAbort)
		if (state.status === "active") {
			clearTimeout(state.timeout)
			await state.events.return?.()
		}
	}
}
