import type WebSocket from "ws"

import type { CodexWebSocketRequestStateModel } from "../models/CodexWebSocketRequestStateModel"
import { StateHolder } from "./StateHolder"

type RequestState = CodexWebSocketRequestStateModel<WebSocket, AsyncIterableIterator<unknown[]>, NodeJS.Timeout>
type InitializingState = Extract<RequestState, { status: "initializing" }>
type ActiveState = Extract<RequestState, { status: "active" }>

export class CodexWebSocketRequestStateHolder extends StateHolder<RequestState> {
	constructor() {
		super({ status: "uninitialized" })
	}

	beginInitialization(controller: AbortController, signal: AbortSignal): InitializingState {
		if (this.state.status === "active" || this.state.status === "initializing") {
			throw new Error("Codex WebSocket request scope is already initialized")
		}
		const state = { status: "initializing", controller, signal } as const
		this.replaceState(state)
		return state
	}

	activate(initializing: InitializingState, socket: WebSocket, events: AsyncIterableIterator<unknown[]>): void {
		this.ensureCurrent(initializing)
		this.replaceState({
			status: "active",
			controller: initializing.controller,
			signal: initializing.signal,
			socket,
			events,
		})
	}

	setDeadline(state: ActiveState, timeout: NodeJS.Timeout): ActiveState {
		this.ensureCurrent(state)
		const timed = { ...state, timeout }
		this.replaceState(timed)
		return timed
	}

	clearDeadline(state: ActiveState): void {
		this.ensureCurrent(state)
		const { timeout: _timeout, ...active } = state
		this.replaceState(active)
	}

	dispose(): RequestState {
		const previous = this.state
		if (previous.status === "initializing" || previous.status === "active") {
			this.replaceState({ status: "disposed", signal: previous.signal })
		}
		return previous
	}

	private ensureCurrent(state: RequestState): void {
		if (!this.isCurrent(state)) throw new Error("Codex WebSocket request scope was disposed")
	}
}
