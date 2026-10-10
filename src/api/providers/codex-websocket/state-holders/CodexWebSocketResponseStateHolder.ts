import type { CodexWebSocketResponseStateModel } from "../models/CodexWebSocketResponseStateModel"
import type { PreparedCodexRequest } from "../models/PreparedCodexRequest"
import { StateHolder } from "./StateHolder"

export class CodexWebSocketResponseStateHolder extends StateHolder<CodexWebSocketResponseStateModel> {
	constructor() {
		super({ status: "uninitialized" })
	}

	initialize(prepared: PreparedCodexRequest): void {
		if (this.state.status !== "uninitialized")
			throw new Error("Codex WebSocket response manager is already initialized")
		this.replaceState({ status: "awaiting", prepared })
	}

	get preparedRequest(): PreparedCodexRequest {
		if (this.state.status === "uninitialized")
			throw new Error("Codex WebSocket response manager is not initialized")
		return this.state.prepared
	}

	get streamedOutput(): readonly unknown[] {
		return this.state.status === "streaming" ? this.state.output : []
	}

	assertAcceptingEvents(): void {
		if (this.state.status === "uninitialized")
			throw new Error("Codex WebSocket response manager is not initialized")
		if (this.state.status === "completed") throw new Error("Codex WebSocket response is already completed")
	}

	appendOutputItem(item: unknown): void {
		this.assertAcceptingEvents()
		this.replaceState({
			status: "streaming",
			prepared: this.preparedRequest,
			output: [...this.streamedOutput, item],
		})
	}

	startStreaming(): void {
		this.assertAcceptingEvents()
		if (this.state.status === "streaming") return
		this.replaceState({ status: "streaming", prepared: this.preparedRequest, output: [] })
	}

	complete(): void {
		this.assertAcceptingEvents()
		this.replaceState({ status: "completed", prepared: this.preparedRequest })
	}

	get canRecoverCacheMiss(): boolean {
		return this.state.status === "awaiting" && this.state.prepared.fullContextReason === undefined
	}

	beginRecovery(): void {
		if (!this.canRecoverCacheMiss) throw new Error("Codex WebSocket response cannot recover a cache miss")
		this.replaceState({ status: "recovering", prepared: this.preparedRequest })
	}
}
