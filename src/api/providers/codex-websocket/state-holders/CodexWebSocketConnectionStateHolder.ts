import type { CodexWebSocketConnectionStateModel } from "../models/CodexWebSocketConnectionStateModel"
import type { CodexWebSocketConnectionScope } from "../scopes/CodexWebSocketConnectionScope"
import { StateHolder } from "./StateHolder"

type ConnectionState = CodexWebSocketConnectionStateModel<CodexWebSocketConnectionScope, NodeJS.Timeout>
type ConnectingState = Extract<ConnectionState, { status: "connecting" }>
type LiveState = Extract<ConnectionState, { status: "active" | "idle" }>

export class CodexWebSocketConnectionStateHolder extends StateHolder<ConnectionState> {
	constructor() {
		super({ status: "disconnected" })
	}

	beginConnection(key: string, scope: CodexWebSocketConnectionScope): ConnectingState {
		if (this.state.status !== "disconnected" && this.state.status !== "unavailable") {
			throw new Error("Codex WebSocket connection is already active")
		}
		const state = { status: "connecting", key, scope } as const
		this.replaceState(state)
		return state
	}

	connect(attempt: ConnectingState, connectedAt: number): void {
		this.ensureCurrent(attempt)
		this.replaceState({ status: "active", key: attempt.key, scope: attempt.scope, connectedAt })
	}

	activate(state: LiveState): void {
		this.ensureCurrent(state)
		this.replaceState({ status: "active", key: state.key, scope: state.scope, connectedAt: state.connectedAt })
	}

	idle(state: LiveState, idleTimer: NodeJS.Timeout): Extract<ConnectionState, { status: "idle" }> {
		this.ensureCurrent(state)
		const next = {
			status: "idle",
			key: state.key,
			scope: state.scope,
			connectedAt: state.connectedAt,
			idleTimer,
		} as const
		this.replaceState(next)
		return next
	}

	markUnavailable(key: string, retryAt: number): void {
		if (this.state.status !== "disconnected") throw new Error("Codex WebSocket connection must be disconnected")
		this.replaceState({ status: "unavailable", key, retryAt })
	}

	disconnect(): ConnectionState {
		const previous = this.state
		if (previous.status !== "unavailable") this.replaceState({ status: "disconnected" })
		return previous
	}

	ownsScope(scope: CodexWebSocketConnectionScope): boolean {
		return "scope" in this.state && this.state.scope === scope
	}

	private ensureCurrent(state: ConnectionState): void {
		if (!this.isCurrent(state)) throw new Error("Codex WebSocket connection attempt was disposed")
	}
}
